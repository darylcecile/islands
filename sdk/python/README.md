# Islands Python embedding SDK

Native **asyncio** embedding of `dist/islands.wasm`, using **Wasmtime 50.0.1** and Python **3.11+**. Extension code stays inside the common WASM QuickJS core. It is never evaluated by Python.

From the repository root:

```sh
bun run build:core && bun run build
python3 -m venv .venv
.venv/bin/python -m pip install -e ./sdk/python
.venv/bin/python examples/python/main.py
```

The example asserts two `greet` invocations, incrementing guest state, asynchronous host log calls, host-bound identity/metadata, event acknowledgement and disposal.

Exercised on macOS arm64 with Python 3.13.2 and Wasmtime 50.0.1. Other Python versions and host platforms have not been exercised in this workspace.

```python
import asyncio
from pathlib import Path
from islands import Artifact, Runtime

async def log_write(input, caller):
    # Validate application shape and authorize caller.metadata resources here.
    caller.raise_if_cancelled()
    return None

async def main():
    async with Runtime(Path("dist/islands.wasm").read_bytes(),
                       capabilities={"log.write": log_write}) as runtime:
        extension = await runtime.load(
            Artifact.from_file("dist/extensions/portable-greeter.json"),
            grants=["log.write"], metadata={"workspaceId": "workspace-123"},
        )
        result = await extension.invoke("greet", {"name": "Islands"})
        await extension.emit("refresh", None)
        await extension.dispose()

asyncio.run(main())
```

## Async execution and cleanup

`load`, `invoke`, `emit` and `dispose` are async. Use a runtime on one asyncio event loop. WASM turns run on a per-instance serial executor; async capability handlers run on the event loop, synchronous handlers run in asyncio's thread pool. No execution lock is held while host work awaits. Operations can overlap while awaiting callbacks, allowing disposal to interrupt an outstanding invocation. Reentrant invocation from a handler is not a supported API guarantee. Use nonblocking async handlers or cooperative synchronous handlers; arbitrary host code is not forcibly preempted.

Cancel an active operation using ordinary `asyncio.Task.cancel()`. Each callback receives a `CallContext` with host-bound `extension_id`, a fresh `metadata` copy, a thread-safe `cancelled` event and a `time.monotonic()` deadline. Observe cancellation in long-running handlers. Disposal signals cancellation to all callbacks and cancels async handlers without awaiting them; synchronous handlers retain their worker tracking until they actually return. Late results do not reenter WASM. Background guest calls continue pumping as host results arrive.

Disposal rejects new operations before cancelling active work, then gives guest cleanup a fresh bounded callback lifecycle. Retired workers are tracked separately and cannot consume cleanup's quota or overwrite its accounting. Timed-out callbacks keep their IDs and quota slots until actual completion, even after a timeout reply. Raw WASM traps permanently disable all guest ABI calls, including free/destroy; cleanup releases only the host Store after a trap.

`IslandsError.code` and `.message` are machine-readable. `GuestError` is an ordinary handler failure and leaves the instance usable. `EngineError` represents core/ABI failures. An active-operation deadline, cancellation or engine failure closes the instance; later calls fail with `DISPOSED`. `asyncio.CancelledError` retains normal Python cancellation semantics. Runtime disposal attempts all instance cleanups before reporting a failure.

## Policy and limits

- `policy="sandboxed"` is the default, with no grants. Pass explicit `grants=[...]`, or explicitly choose `policy="trusted"` for all registered capabilities. Invalid policy names fail.
- Manifest required capabilities must exist and be granted before any artifact evaluation. Authorization uses host-owned grants, never guest identities. Host handlers still authorize application resources from trusted metadata.
- `Limits(memory_bytes=16<<20, stack_bytes=512<<10, fuel=10_000, timeout_ms=5_000, max_pending_calls=64)` configures each instance. Fuel counts QuickJS interrupts for each eval/dispatch/step. A monotonic deadline bounds the **whole** job drain, including endless tiny Promise jobs and jobs after a result appears. Wasmtime epoch interruption bounds individual stuck WASM turns, with approximately 10 ms scheduling granularity.
- Wasmtime caps per-instance linear memory at 128 MiB; each outbox and accumulated drain is bounded to 1 MiB, artifact code to 16 MiB. Heap limits exclude host allocations. Compile/setup overhead is outside the guest operation budget.
- WASI has empty environment/stdio and no filesystem preopens; socket imports are rejected. Trusted policy retains isolation and limits. This is not OS-process isolation.
- JSON values are `None`, bool, finite binary64 numbers, str, list, and string-keyed dict. Integer-valued numbers (including floats) must be within ±9007199254740991; use strings for larger identifiers. Tuples, live objects, custom serialization, bytes, cycles and nonfinite numbers are rejected. Inputs/metadata/results are copied through JSON. Handlers should not mutate a value concurrently with returning it.

The SDK checks artifact and wire/JSON shapes. It does **not** provide Python type generation or arbitrary JSON Schema host contract validation; implement application input/output validation in capability handlers.

References: [shared protocol](../../docs/protocol.md), [Wasmtime Python API](https://bytecodealliance.github.io/wasmtime-py/), [pinned package](https://pypi.org/project/wasmtime/50.0.1/).
