# Islands core and adapter contract

This is the shared implementation contract for version 1. Public SDKs hide pointers and wire messages. JSON is UTF-8; arguments/results must be JSON values. Missing optional inputs/results normalize to `null`. SDKs reject non-JSON boundary values. Numbers use finite binary64 semantics; integer values must be within ±9,007,199,254,740,991. Use strings for larger integer identifiers so Python/Go values cannot silently lose precision in JavaScript.

## Portable artifact

`{ formatVersion: 1, manifest: { id, name?, version?, description?, requires?: string[] }, code: string }`.

`code` is a bundled IIFE declaring a global variable `__islands_extension`, whose `.default` is the extension definition. The host evaluates code inside WASM, then dispatches `activate`. TypeScript/YAML/JSON authoring lives outside the core. No compiler evaluates extension code in the embedding application.

## WASM ABI version 1

The core is a wasm32 WASI Preview 1 reactor, built from pinned QuickJS sources. One WASM instance owns one JS runtime. Call `_initialize()` once after instantiation. Functions use wasm i32 values (pointers/lengths are unsigned on the host).

| Export | Meaning |
| --- | --- |
| `islands_abi_version() -> i32` | Returns 1. |
| `islands_alloc(len) -> ptr` | Allocates input bytes; 0 means allocation failure. |
| `islands_free(ptr)` | Releases an input allocation. |
| `islands_init(memory_bytes, stack_bytes) -> status` | Creates the JS runtime and installs the built-in guest bridge. |
| `islands_eval(ptr, len, fuel) -> status` | Evaluates the artifact's IIFE synchronously in the guest. |
| `islands_dispatch(ptr, len, fuel) -> status` | Calls guest `__islands_receive(jsonString)`. |
| `islands_step(max_jobs, fuel) -> i32` | Runs at most max_jobs pending jobs; returns executed count, or -1 on exception. |
| `islands_output_ptr() -> ptr` | Newline-delimited JSON outbox. |
| `islands_output_len() -> len` | Byte length of the outbox. |
| `islands_output_clear()` | Clears outbox after host copies it. |
| `islands_error_ptr() -> ptr` | Last core error string. |
| `islands_error_len() -> len` | Last error byte length. |
| `islands_destroy()` | Frees guest runtime and buffers. |

Status is 0 for success and -1 for failure. Errors must remain available after cleanup of a failed operation. Buffers are valid until the next mutating ABI call; adapters copy before re-entry. Inputs are freed in a finally/defer block after normal returns, including negative status returns. A thrown WASM trap is different: immediately invalidate the core, preserve the original error, and release the embedding instance through host-side teardown. Do not call any further guest exports after a trap, including `islands_free`, error accessors, or `islands_destroy`. Never retain a typed memory view across calls because memory may grow.

Fuel is a count of QuickJS interrupt callbacks, not WASM instructions or milliseconds. Each eval/dispatch/step gets a fresh positive budget. Default 10,000, heap 16 MiB, stack 512 KiB, max_jobs 256. The core caps outbox bytes at 1 MiB and built artifact linear memory at 128 MiB. Heap limits do not account for host-side API allocations. Host adapters additionally impose operation deadlines and bounded pending host calls. WASI imports provide only engine prerequisites (clock, entropy, empty environment/stdio); no preopened filesystem or sockets.

## Guest bridge

`core/guest.js` is plain standalone JavaScript embedded into the core at build time. C provides `__islands_send(jsonString)`. The guest exposes `__islands_receive(jsonString)` and consumes `globalThis.__islands_extension.default` at activation.

Definition: `{ activate(ctx): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)> }`.

Context: `{ config, call(method,input?), handle(method,fn), on(event,fn) }`. `handle` and `on` return idempotent unsubscribe functions. Handlers receive JSON input. `call` returns a Promise. The author SDK's `defineExtension` is a typed identity function; all live context behavior comes from the core bridge.

Host → guest:

- `{type:'activate', id, config}` — activate and acknowledge via result.
- `{type:'invoke', id, method, input}` — await registered handler, return result.
- `{type:'event', id, event, payload}` — await subscribers, return null result.
- `{type:'dispose', id}` — run cleanup, release handlers/pending requests, return null result.
- `{type:'result', id, ok:true, value}` or `{type:'result', id, ok:false, error:{code,message}}` — settle a guest host-call Promise.

Guest → host:

- `{type:'call', id, method, input}` — request a capability.
- The same result envelopes acknowledge host operations.

Host and guest request IDs use separate prefixes (`h…` and `g…`). Message fields and sizes are validated by adapters. Duplicate outstanding guest-call IDs are rejected before executing another callback. Pending-call quota slots are host-owned and released when the corresponding callback settles. Host API callbacks run asynchronously without holding a WASM execution lock; completion queues a result then pumps jobs. Calls into any one instance are serialized. A host callback must not await reentrant invocation of the same instance unless the adapter explicitly supports it.

Adapters bound the outer job drain as well as each core entry. An endless chain of small Promise jobs must not evade deadlines by repeatedly receiving fresh per-step fuel. Browser adapters yield between bounded batches so host tasks remain schedulable.

## Public JavaScript API contract

`createRuntime({ wasm: Uint8Array | WebAssembly.Module, capabilities?, contract?, limits? })` returns a runtime. Capability map values are async/sync `(input, context) => JsonValue`; context has host-bound `extensionId`, `metadata` and `signal`.

`runtime.load(artifact, { grants?: string[], policy?: 'sandboxed' | 'trusted', config?: JsonValue, metadata?: Record<string, JsonValue> })` returns a loaded extension after activation. Sandbox grants default to empty. Trusted policy explicitly grants all capabilities registered at load, while retaining WASM isolation and resource limits. Required manifest capabilities must be available and granted before any extension code executes. Optional JSON Schema host contracts validate capability arguments and results outside guest memory.

Host contracts use JSON Schema draft-07. Unsupported explicit dialects must be rejected, rather than interpreted as draft-07. Native SDK capability implementations supply their own input/output validation; the shared contract does not imply that all adapters embed a schema validator.

`extension.invoke(method, input?)`, `extension.emit(event, payload?)`, `extension.dispose()` are async. `runtime.dispose()` disposes its instances. `extension.id` exposes manifest identity. IDs are unique within a runtime. All cleanup is bounded; host-owned abort signals and pending-operation cleanup run even if guest cleanup fails. Late callback results are discarded after disposal. Invalid policy names fail rather than falling back.

Disposal stops new ordinary operations and cancels active host work before invoking guest cleanup. Cleanup uses a fresh, bounded callback lifecycle so held ordinary calls cannot exhaust its quota. Late callbacks from the prior lifecycle cannot release cleanup slots or deliver results into it. Work ignoring host cancellation can outlive these lifecycles and requires application-owned concurrency controls.

Limits: `{ memoryBytes?: number, stackBytes?: number, fuel?: number, timeoutMs?: number, maxPendingCalls?: number }`; defaults described above, deadline 5,000 ms and maxPendingCalls 64. Engine failure poisons/disposes the instance; application handler errors remain ordinary result errors.

## Boundary policy

Every capability call is authorized against host-owned grants tied to the instance, never IDs or permissions supplied by a guest message. Metadata such as tenant/workspace identity comes from load options. Host capability implementations remain responsible for resource-scoped authorization and observing cancellation. No policy preset promises OS-process isolation or hard preemption of host code.
