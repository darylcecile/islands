"""Synchronous ABI driver, always used on an instance's serial executor."""

from __future__ import annotations

import json
import math
import time
from typing import Any

import wasmtime

from .types import EngineError, IslandsError, Limits, LINEAR_MEMORY_BYTES, MAX_MESSAGE_BYTES, encode_json, valid_name

EPOCH_SECONDS = 0.01


class Core:
    def __init__(self, engine: wasmtime.Engine, module: wasmtime.Module, limits: Limits):
        self.limits = limits
        self.store = wasmtime.Store(engine)
        self.store.set_limits(memory_size=LINEAR_MEMORY_BYTES, instances=1, memories=1)
        self.store.set_wasi(wasmtime.WasiConfig())
        self.exports = None
        self.memory = None
        self.module = module
        self.engine = engine
        self._trap: EngineError | None = None

    def initialize(self, code: str, deadline: float) -> None:
        self._deadline(deadline)
        with wasmtime.Linker(self.engine) as linker:
            linker.define_wasi()
            instance = linker.instantiate(self.store, self.module)
        self.exports = instance.exports(self.store)
        self.memory = self.exports.get("memory")
        if not isinstance(self.memory, wasmtime.Memory):
            raise EngineError("ABI_MISMATCH", "missing linear memory export")
        self.call("_initialize", deadline)
        if self.call("islands_abi_version", deadline) != 1:
            raise EngineError("ABI_MISMATCH", "expected Islands ABI version 1")
        self._status(self.call("islands_init", deadline, self.limits.memory_bytes, self.limits.stack_bytes), deadline)
        self._input("islands_eval", code.encode("utf-8"), deadline)

    def _deadline(self, deadline: float) -> None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise EngineError("TIMEOUT", "extension operation deadline exceeded")
        self.store.set_epoch_deadline(max(1, math.ceil(remaining / EPOCH_SECONDS)))

    def call(self, name: str, deadline: float, *args: int) -> int | None:
        if self._trap is not None:
            raise self._trap
        self._deadline(deadline)
        function = self.exports.get(name)
        if not isinstance(function, wasmtime.Func):
            raise EngineError("ABI_MISMATCH", f"missing export: {name}")
        try:
            return function(self.store, *args)
        except (wasmtime.Trap, wasmtime.WasmtimeError) as error:
            code = "TIMEOUT" if time.monotonic() >= deadline or (isinstance(error, wasmtime.Trap) and error.trap_code == wasmtime.TrapCode.INTERRUPT) else "ENGINE_ERROR"
            self._trap = EngineError(code, str(error))
            raise self._trap from error

    def _buffer(self, prefix: str, deadline: float) -> bytes:
        pointer = self.call(prefix + "_ptr", deadline) & 0xFFFFFFFF
        length = self.call(prefix + "_len", deadline) & 0xFFFFFFFF
        if length > MAX_MESSAGE_BYTES or pointer + length > self.memory.data_len(self.store):
            raise EngineError("PROTOCOL_ERROR", "core output buffer exceeds memory or message bounds")
        return bytes(self.memory.read(self.store, pointer, pointer + length))

    def _status(self, status: int, deadline: float) -> None:
        if status >= 0:
            return
        message = self._buffer("islands_error", deadline).decode("utf-8", errors="replace") or "core operation failed"
        code = "FUEL_EXHAUSTED" if "fuel" in message.lower() or "interrupt" in message.lower() else "ENGINE_ERROR"
        if "heap" in message.lower() or "memory exhausted" in message.lower():
            code = "MEMORY_LIMIT"
        raise EngineError(code, message)

    def _input(self, export: str, data: bytes, deadline: float) -> None:
        pointer = self.call("islands_alloc", deadline, len(data)) & 0xFFFFFFFF
        if pointer == 0:
            raise EngineError("MEMORY_LIMIT", "core input allocation failed")
        failure = None
        try:
            self.memory.write(self.store, data, pointer)
            self._status(self.call(export, deadline, pointer, len(data), self.limits.fuel), deadline)
        except BaseException as error:
            failure = error
            raise
        finally:
            if self._trap is None:
                try:
                    self.call("islands_free", deadline, pointer)
                except Exception:
                    if failure is None:
                        raise

    def exchange(self, message: dict[str, Any], deadline: float) -> list[dict[str, Any]]:
        self._input("islands_dispatch", encode_json(message), deadline)
        messages = []
        total_bytes = 0
        while True:
            # This deadline covers the entire drain, including endless tiny jobs
            # and jobs scheduled after an operation has already produced a result.
            self._deadline(deadline)
            data = self._buffer("islands_output", deadline)
            total_bytes += len(data)
            if total_bytes > MAX_MESSAGE_BYTES:
                raise EngineError("PROTOCOL_ERROR", "one job drain produced more than 1 MiB of messages")
            self.call("islands_output_clear", deadline)
            for line in data.splitlines():
                if line:
                    messages.append(_decode_message(line))
            count = self.call("islands_step", deadline, 256, self.limits.fuel)
            self._status(count, deadline)
            if count == 0:
                return messages

    def close(self, clean: bool) -> None:
        try:
            if clean and self.exports is not None and self._trap is None:
                self.call("islands_destroy", time.monotonic() + self.limits.timeout_ms / 1000)
        finally:
            self.store.close()


def _decode_message(line: bytes) -> dict[str, Any]:
    try:
        message = json.loads(line)
        if not isinstance(message, dict) or not valid_name(message.get("id")) or len(message["id"]) < 2:
            raise ValueError("message must contain an id")
        kind = message.get("type")
        if kind == "call":
            if not message["id"].startswith("g") or not valid_name(message.get("method")) or "input" not in message:
                raise ValueError("malformed capability call")
        elif kind == "result":
            if not message["id"].startswith("h") or type(message.get("ok")) is not bool:
                raise ValueError("malformed result")
            if message["ok"]:
                if "value" not in message:
                    raise ValueError("result missing value")
            else:
                error = message.get("error")
                if not isinstance(error, dict) or not valid_name(error.get("code")) or not isinstance(error.get("message"), str):
                    raise ValueError("result missing error code or message")
        else:
            raise ValueError("unknown guest message type")
        # Reject Python json.loads extensions such as NaN/Infinity as well.
        encode_json(message)
        return message
    except (ValueError, UnicodeError, TypeError, IslandsError) as error:
        raise EngineError("PROTOCOL_ERROR", str(error)) from error
