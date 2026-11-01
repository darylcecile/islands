"""Async native host adapter; capability callbacks never hold the WASM gate."""

from __future__ import annotations

import asyncio
import inspect
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

import wasmtime

from ._core import Core, EPOCH_SECONDS
from .types import Artifact, CallContext, EngineError, GuestError, Handler, IslandsError, JsonValue, Limits, encode_json, json_copy, valid_name


class Runtime:
    def __init__(self, wasm: bytes, *, capabilities: dict[str, Handler] | None = None, limits: Limits | None = None):
        self.limits = limits or Limits()
        self._capabilities = dict(capabilities or {})
        if any(not valid_name(name) or not callable(handler) for name, handler in self._capabilities.items()):
            raise IslandsError("INVALID_CAPABILITY", "capabilities require valid names and callable handlers")
        config = wasmtime.Config()
        config.epoch_interruption = True
        self._engine = wasmtime.Engine(config)
        try:
            self._module = wasmtime.Module(self._engine, wasm)
            for imported in self._module.imports:
                if imported.module != "wasi_snapshot_preview1" or imported.name.startswith("sock_") or not isinstance(imported.type, wasmtime.FuncType):
                    raise IslandsError("UNSUPPORTED_IMPORT", f"{imported.module}.{imported.name}")
        except BaseException as error:
            if hasattr(self, "_module"):
                self._module.close()
            self._engine.close()
            if isinstance(error, wasmtime.WasmtimeError):
                raise EngineError("ENGINE_ERROR", str(error)) from error
            raise
        self._closed = False
        self._disposal: asyncio.Task | None = None
        self._instances: dict[str, Extension] = {}
        self._stop_epoch = threading.Event()
        self._epoch_thread = threading.Thread(target=self._tick, name="islands-epochs", daemon=True)
        self._epoch_thread.start()

    def _tick(self) -> None:
        while not self._stop_epoch.wait(EPOCH_SECONDS):
            self._engine.increment_epoch()

    async def load(self, artifact: Artifact, *, grants: list[str] | None = None, policy: str = "sandboxed", config: JsonValue = None, metadata: dict[str, JsonValue] | None = None) -> Extension:
        artifact.validate()
        if self._closed:
            raise IslandsError("DISPOSED", "runtime is disposed")
        if policy not in ("sandboxed", "trusted"):
            raise IslandsError("INVALID_POLICY", "policy must be sandboxed or trusted")
        if grants is not None and (not isinstance(grants, list) or not all(valid_name(name) for name in grants)):
            raise IslandsError("INVALID_GRANT", "grants must be a list of capability names")
        allowed = frozenset(self._capabilities if policy == "trusted" else grants or [])
        for name in artifact.manifest.get("requires", []):
            if name not in allowed or name not in self._capabilities:
                raise IslandsError("CAPABILITY_REQUIRED", f"required capability unavailable or ungranted: {name}")
        if metadata is not None and type(metadata) is not dict:
            raise IslandsError("INVALID_JSON", "metadata must be a JSON object")
        config, metadata = json_copy(config), json_copy(metadata or {})
        identity = artifact.manifest["id"]
        if identity in self._instances:
            raise IslandsError("DUPLICATE_ID", f"extension id is already loaded: {identity}")
        extension = Extension(self, identity, allowed, metadata)
        self._instances[identity] = extension
        try:
            await extension._initialize(artifact.code, config)
            return extension
        except BaseException:
            # Disposal owns cleanup once it retires the activation operation.
            # Its load rejection must not close the core underneath that task.
            if not extension._disposing:
                await extension._close(False)
            raise

    async def dispose(self) -> None:
        if self._disposal is None:
            self._closed = True
            self._disposal = asyncio.create_task(self._dispose())
        await asyncio.shield(self._disposal)

    async def _dispose(self) -> None:
        results = await asyncio.gather(*(instance.dispose() for instance in list(self._instances.values())), return_exceptions=True)
        self._stop_epoch.set()
        self._epoch_thread.join()
        self._module.close()
        self._engine.close()
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def __aenter__(self) -> Runtime:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.dispose()


@dataclass(eq=False)
class _HostCall:
    worker: asyncio.Task
    context: CallContext
    cancellable: bool

    def cancel(self) -> None:
        self.context.cancelled.set()
        # Cancelling a to_thread wrapper would lose tracking before the actual
        # synchronous callback returns. Such callbacks observe the context event.
        if self.cancellable and self.worker is not asyncio.current_task():
            self.worker.cancel()


class Extension:
    def __init__(self, runtime: Runtime, identity: str, grants: frozenset[str], metadata: dict[str, JsonValue]):
        self._runtime = runtime
        self._id = identity
        self._grants = grants
        self._metadata = metadata
        self._core: Core | None = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="islands-wasm")
        self._execution = asyncio.Lock()
        self._closed = False
        self._disposing = False
        self._disposal: asyncio.Task | None = None
        self._generation = 0
        self._sequence = 0
        self._pending: dict[str, asyncio.Future] = {}
        self._calls: dict[str, _HostCall] = {}
        self._retired_calls: dict[str, _HostCall] = {}
        self._retired_operations: set[str] = set()
        self._incoming: set[str] = set()
        self._closing: asyncio.Task | None = None

    @property
    def id(self) -> str:
        return self._id

    async def _thread(self, function: Callable, *args: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(self._executor, function, *args)

    async def _initialize(self, code: str, config: JsonValue) -> None:
        deadline = time.monotonic() + self._runtime.limits.timeout_ms / 1000
        def initialize() -> None:
            self._core = Core(self._runtime._engine, self._runtime._module, self._runtime.limits)
            self._core.initialize(code, deadline)
        try:
            async with self._execution:
                await self._thread(initialize)
            await self._operation({"type": "activate", "config": config}, deadline)
        except (wasmtime.Trap, wasmtime.WasmtimeError) as error:
            raise EngineError("ENGINE_ERROR", str(error)) from error

    async def invoke(self, method: str, input: JsonValue = None) -> JsonValue:
        if not valid_name(method):
            raise IslandsError("INVALID_METHOD", "method must be a nonempty string of at most 1024 bytes")
        return await self._operation({"type": "invoke", "method": method, "input": json_copy(input)})

    async def emit(self, event: str, payload: JsonValue = None) -> None:
        if not valid_name(event):
            raise IslandsError("INVALID_EVENT", "event must be a nonempty string of at most 1024 bytes")
        await self._operation({"type": "event", "event": event, "payload": json_copy(payload)})

    async def dispose(self) -> None:
        if self._disposal is not None:
            await asyncio.shield(self._disposal)
            return
        if self._closed:
            if self._closing is not None:
                await asyncio.shield(self._closing)
            return
        self._disposing = True
        self._generation += 1
        self._retired_calls.update(self._calls)
        self._calls.clear()
        for call in self._retired_calls.values():
            call.cancel()
        self._incoming.clear()
        for identity, future in self._pending.items():
            self._retired_operations.add(identity)
            if not future.done():
                future.set_exception(IslandsError("DISPOSED", "extension is disposing"))
            if not future.cancelled():
                future.exception()
        self._pending.clear()
        self._disposal = asyncio.create_task(self._dispose())
        await asyncio.shield(self._disposal)

    async def _dispose(self) -> None:
        try:
            await self._operation({"type": "dispose"})
        finally:
            await self._close(True)

    async def _operation(self, message: dict[str, Any], deadline: float | None = None) -> JsonValue:
        deadline = deadline or time.monotonic() + self._runtime.limits.timeout_ms / 1000
        identity = None
        started = False
        generation = self._generation
        try:
            async with asyncio.timeout(max(0, deadline - time.monotonic())):
                if self._closed or (self._disposing and message["type"] != "dispose"):
                    raise IslandsError("DISPOSED", "extension is disposed")
                started = True
                self._sequence += 1
                identity = f"h{self._sequence}"
                message = {**message, "id": identity}
                encode_json(message)
                future = asyncio.get_running_loop().create_future()
                self._pending[identity] = future
                await self._deliver(message, deadline, generation)
                return await future
        except (EngineError, TimeoutError, asyncio.CancelledError) as error:
            if started and generation == self._generation:
                await self._close(False)
            if isinstance(error, TimeoutError):
                raise IslandsError("TIMEOUT", "extension operation deadline exceeded") from error
            raise
        finally:
            if identity is not None:
                future = self._pending.pop(identity, None)
                if future is not None:
                    future.cancel()

    async def _deliver(self, message: dict[str, Any], deadline: float, generation: int) -> None:
        queue = [message]
        while queue:
            async with self._execution:
                if self._closed or generation != self._generation:
                    return
                incoming = queue.pop(0)
                messages = await self._thread(self._core.exchange, incoming, deadline)
                if self._closed or generation != self._generation:
                    return
                if incoming["type"] == "result":
                    self._incoming.discard(incoming["id"])
                # Reserve IDs before scheduling any callbacks, independently of
                # quota slots, which last only until actual host work finishes.
                for outgoing in messages:
                    if outgoing["type"] != "call":
                        continue
                    if outgoing["id"] in self._incoming or outgoing["id"] in self._calls or outgoing["id"] in self._retired_calls:
                        raise EngineError("PROTOCOL_ERROR", "duplicate outstanding host call id")
                    self._incoming.add(outgoing["id"])
            for outgoing in messages:
                if outgoing["type"] == "result":
                    self._receive_result(outgoing)
                else:
                    response = self._start_call(outgoing)
                    if response is not None:
                        queue.append(response)

    def _receive_result(self, message: dict[str, Any]) -> None:
        if self._closed:
            return
        if message["id"] in self._retired_operations:
            self._retired_operations.remove(message["id"])
            return
        future = self._pending.get(message["id"])
        if future is None or future.done():
            raise EngineError("PROTOCOL_ERROR", f"unknown or duplicate operation result: {message['id']}")
        if message["ok"]:
            future.set_result(message["value"])
        else:
            error = message["error"]
            future.set_exception(GuestError(error["code"], error["message"]))

    def _start_call(self, message: dict[str, Any]) -> dict[str, Any] | None:
        identity, method = message["id"], message["method"]
        if identity in self._calls or identity in self._retired_calls:
            raise EngineError("PROTOCOL_ERROR", "duplicate unsettled host call id")
        if method not in self._grants:
            return _error_result(identity, IslandsError("CAPABILITY_DENIED", f"capability not granted: {method}"))
        if method not in self._runtime._capabilities:
            return _error_result(identity, IslandsError("CAPABILITY_NOT_FOUND", f"capability unavailable: {method}"))
        if len(self._calls) >= self._runtime.limits.max_pending_calls:
            return _error_result(identity, IslandsError("TOO_MANY_CALLS", "pending host call limit reached"))
        context = CallContext(self.id, json_copy(self._metadata), deadline=time.monotonic() + self._runtime.limits.timeout_ms / 1000)
        worker = asyncio.create_task(self._invoke_handler(message, context))
        call = _HostCall(worker, context, inspect.iscoroutinefunction(self._runtime._capabilities[method]))
        self._calls[identity] = call
        worker.add_done_callback(lambda done: self._finish_call(identity, call))
        task = asyncio.create_task(self._run_call(message, call, self._generation))
        # Consume errors even when a caller disposed before an asynchronous delivery failed.
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        return None

    def _finish_call(self, identity: str, call: _HostCall) -> None:
        for calls in (self._calls, self._retired_calls):
            if calls.get(identity) is call:
                del calls[identity]
        if not call.worker.cancelled():
            call.worker.exception()

    async def _invoke_handler(self, message: dict[str, Any], context: CallContext) -> JsonValue:
        handler = self._runtime._capabilities[message["method"]]
        if inspect.iscoroutinefunction(handler):
            return await handler(message["input"], context)
        value = await asyncio.to_thread(handler, message["input"], context)
        return await value if inspect.isawaitable(value) else value

    async def _run_call(self, message: dict[str, Any], call: _HostCall, generation: int) -> None:
        identity = message["id"]
        context, worker = call.context, call.worker
        try:
            try:
                async with asyncio.timeout(max(0, context.deadline - time.monotonic())):
                    # Keep timed-out, uncooperative work counted against the bound
                    # until it actually finishes. Disposal never awaits the worker.
                    value = await asyncio.shield(worker)
                response = {"type": "result", "id": identity, "ok": True, "value": json_copy(value)}
                encode_json(response)
            except asyncio.CancelledError:
                return
            except Exception as error:
                if isinstance(error, TimeoutError):
                    error = IslandsError("TIMEOUT", "host capability deadline exceeded")
                response = _error_result(identity, error)
            finally:
                context.cancelled.set()
            if not self._closed and generation == self._generation:
                await self._deliver(response, time.monotonic() + self._runtime.limits.timeout_ms / 1000, generation)
        except IslandsError as error:
            if generation == self._generation:
                await self._close(False, error)

    async def _close(self, clean: bool, reason: IslandsError | None = None) -> None:
        if self._closing is None:
            self._closed = True
            self._generation += 1
            for call in list(self._calls.values()) + list(self._retired_calls.values()):
                call.cancel()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(reason or IslandsError("DISPOSED", "extension is disposed"))
                # A drain may fail after already producing a guest error.
                if not future.cancelled():
                    future.exception()
            self._closing = asyncio.create_task(self._close_core(clean))
        await asyncio.shield(self._closing)

    async def _close_core(self, clean: bool) -> None:
        try:
            async with self._execution:
                if self._core is not None:
                    await self._thread(self._core.close, clean)
        finally:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._runtime._instances.pop(self.id, None)


def _error_result(identity: str, error: Exception) -> dict[str, Any]:
    code = error.code if isinstance(error, IslandsError) else "HOST_ERROR"
    message = error.message if isinstance(error, IslandsError) else str(error)
    return {"type": "result", "id": identity, "ok": False, "error": {"code": code, "message": message[:4096] or type(error).__name__}}
