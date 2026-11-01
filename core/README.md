# Portable QuickJS core

`dist/islands.wasm` is a **wasm32 WASI Preview 1 reactor**. Each WebAssembly
instance owns a private QuickJS runtime, context, heap and message queue.
The executable contract is [ABI v1](../docs/protocol.md).

## Build

From the repository root, with Python 3.10 or newer:

```sh
python3 scripts/build_core.py
```

The first build downloads the official QuickJS source archive and the WASI SDK
for the build machine. Downloads are checked against SHA-256 constants before
extraction; cached archives are checked again on subsequent builds. The SDK and
archives stay in `build/`. No package-manager dependencies, global installation,
Rust toolchain, or elevated privileges are needed.

Outputs:

- `dist/islands.wasm` — standalone reactor; no JavaScript glue.
- `dist/islands.build.json` — source, guest, toolchain and artifact hashes.
- `dist/THIRD_PARTY_NOTICES.md` — redistribution notices.

Automatic SDK downloads are configured for macOS and Linux on arm64 and x86_64.
The macOS arm64 build is the exercised build platform. The generated module is
independent of the build machine's CPU.

```sh
# Separate cache/output (also useful when checking reproducibility):
python3 scripts/build_core.py --cache build --output build/repeat/islands.wasm

# Explicit toolchain override; its provenance is recorded as custom:
python3 scripts/build_core.py --wasi-sdk /path/to/wasi-sdk
# WASI_SDK_PATH supplies the same override.
```

Rebuild whenever `core/guest.js` changes. The build embeds its exact UTF-8 source
as a C byte array, evaluates it only inside QuickJS during `islands_init`, and
records its hash. It does not run a host JavaScript interpreter or serialize
untrusted QuickJS bytecode.

### Reproducibility and provenance

| Dependency | Pin | SHA-256 |
| --- | --- | --- |
| [Official QuickJS](https://bellard.org/quickjs/quickjs-2026-06-04.tar.xz) | 2026-06-04 | `b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a` |
| [WASI SDK, macOS arm64](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34) | 34.0 | `9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9` |

Other host SDK archive digests are pinned in `scripts/build_core.py`, taken from
the official release asset metadata. QuickJS's archive checksum was recorded
from the official HTTPS download; upstream does not publish a separate signed
checksum manifest. A checksum pin detects changed downloads; it is not an
independent signature or a security audit of the engine.

The script uses SDK 34's `--target=wasm32-wasip1` (the old `wasm32-wasi` alias was
removed), `-mexec-model=reactor`, optimized LTO, explicit exports, and fixed memory
limits. Source paths are normalized and build timestamps are not embedded.
Identical inputs with the same pinned SDK produce identical WASM bytes.
Custom SDK overrides intentionally forgo the official toolchain checksum pin.

Three checked, narrowly scoped portability edits are applied to a fresh copy of
QuickJS during each build: switch dispatch for WASI, no thread-dependent Atomics,
and the WASI allocator header. **Stack checks remain enabled.** Defining
`__EMSCRIPTEN__` as a shortcut would disable those checks, so this build does not
do that. A fourth edit removes dtoa's unused `<setjmp.h>` include, which would
otherwise require enabling WebAssembly exception handling with SDK 34.
Sources linked: `quickjs.c`, `dtoa.c`, `libregexp.c`, `libunicode.c`, and
`cutils.c`; no `quickjs-libc.c`, module loader, file reader, or worker runtime.

## Calling the ABI

Use the public host SDK in applications. An adapter implementing the raw ABI must:

1. Instantiate the module with a restricted WASI Preview 1 environment and call
   `_initialize()` exactly once.
2. Check `islands_abi_version() === 1` and call
   `islands_init(16 * 1024 * 1024, 512 * 1024)`.
3. Allocate input with `islands_alloc(utf8.length)`, copy into the exported
   `memory`, call `islands_eval(ptr, len, 10000)` or
   `islands_dispatch(ptr, len, 10000)`, and free the input in `finally`/`defer`.
4. Run `islands_step(256, 10000)` to pump Promise jobs. Copy the outbox between
   turns, process host calls asynchronously, and dispatch their result envelopes.
5. Copy error/output bytes immediately using their pointer and length. Reacquire
   the memory buffer after every ABI call because allocation can grow memory.
6. On a core status error, copy the error then call `islands_destroy()` and abandon
   the instance. On a WASM trap, discard the instance without further guest calls:
   traps can bypass C cleanup and leave engine state unusable. Invoke the guest
   `dispose` message on normal shutdown, then call `islands_destroy()`.

`islands_eval`, `islands_dispatch`, and `islands_init` return 0 or -1.
`islands_step` returns the number of jobs executed, or -1. `max_jobs=0` performs
no jobs. Fuel must be a positive signed i32. A zero-length input allocation is
valid; pointers passed to eval/dispatch must belong to `islands_alloc` and the
length must fit the allocation.

The outbox contains UTF-8 JSON strings followed by `\n`; lengths exclude any
implicit terminator. `islands_output_clear()` resets its length for the next turn.
C enforces single-line framing; the bridge and host validate JSON values and
wire envelopes. `__islands_send` accepts exactly one string, and the receiver
function is captured at initialization. No host API executes inside the C call.

Exceptions, exhausted fuel, exhausted guest allocation budgets and outbox
overflow poison the runtime. Error reporting reads only string values and own
data properties of native Error objects: it never calls guest `toString` or
error getters. Error text is capped at 4 KiB (including its terminator), and
survives both `islands_free` and `islands_destroy`, including failed init cleanup.
Unhandled Promise rejections are reported when the job queue has drained, so a
handler attached during that same turn can still handle the rejection normally.
Application handler failures converted by the guest into result envelopes do not
poison the runtime.

`islands_destroy` is idempotent, releases queued jobs, rejection roots, guest
objects, outbox storage and outstanding input allocations. Freeing an already
released input is harmless. WASM linear memory cannot shrink; destroy the
WebAssembly instance itself to release its high-water memory allocation.

## Resource limits and isolation

The pinned build imports exactly these functions, all from
`wasi_snapshot_preview1`:

```text
clock_time_get(i32, i64, i32) -> i32
fd_close(i32) -> i32
fd_seek(i32, i64, i32, i32) -> i32
fd_write(i32, i32, i32, i32) -> i32
random_get(i32, i32) -> i32
```

Clock and entropy support engine prerequisites. The file-descriptor imports are
libc stdio support; give them empty/discarded stdio only. There are no path,
filesystem-read, socket, environment or custom JavaScript imports. Exports are
`memory`, `_initialize`, and exactly the thirteen `islands_*` functions listed
in the canonical ABI; there is no `_start` entrypoint.

| Resource | Behavior |
| --- | --- |
| Guest heap | Host supplies a positive byte budget, default 16 MiB. Charged allocations include rounded engine storage, allocator headers and bookkeeping. Applies during runtime/context creation too. |
| Guest stack | Host supplies 1..1,048,576 bytes, default 512 KiB. Zero is rejected because QuickJS treats it as unlimited. |
| C linear-memory stack | Fixed 2 MiB, with stack-first layout. QuickJS's checked stack ceiling leaves room for engine and ABI frames. |
| Linear memory | Initially 4 MiB; declared maximum 128 MiB, including engine, C stack, input and output storage. |
| Fuel | Fresh interrupt-callback budget per eval/dispatch/step; init uses 10,000. The budget covers all jobs in one step call. |
| Outbox | At most 1 MiB including newline separators, until cleared by the host. Overflow is fatal even if guest code tries to catch it. |
| Error text | Fixed 4 KiB buffer, retained through cleanup. |

Heap settings up to 128 MiB are accepted, but the usable heap is necessarily
smaller than the module's total memory maximum. Input/output buffers are outside
the guest heap budget and inside the WASM memory maximum. Fragmentation and
temporary realloc storage can cause earlier allocation failure. Host API
allocations, pending calls and asynchronous deadlines are bounded by adapters.

Fuel is **QuickJS interrupt callbacks**, not WASM instructions, elapsed time, or
a guarantee that every native engine helper can be preempted immediately. Some
parsing, garbage collection, string and BigInt work can run between interrupt
polls. The embedding engine also has its own native execution-stack limits; a
native stack exhaustion or engine bug can trap rather than produce a JS error.
In the exercised Bun 1.3.14/JavaScriptCore and Node 24.18.0/V8 builds, recursive
calls with a 64 KiB guest stack returned status -1 with `stack overflow`. At the
512 KiB default, Bun returned a QuickJS error while Node hit its native stack
limit and threw a host `RangeError`; both engines trapped at 1 MiB. The byte
budget is a ceiling, not a promise that all of it is
usable before the embedding engine's own limit. Such a trap requires discarding
the instance, rather than attempting to resume it or run guest cleanup.
For a hard wall-clock termination boundary, the embedding application needs a
terminable worker/process or engine-specific interruption outside this ABI.

The engine installs ECMAScript intrinsics, not QuickJS's OS standard library.
There are no `std`, `os`, filesystem loader, sockets, Node APIs, or ambient host
callbacks. Host policy and identity belong to the adapters and are never trusted
from guest messages. Supply no preopened directories or sockets and an empty
environment. This is WASM isolation, not OS-process isolation.

## Maintenance

Consult current [WASI SDK instructions](https://github.com/WebAssembly/wasi-sdk)
and [QuickJS embedding documentation](https://bellard.org/quickjs/quickjs.html)
before updating pins. Check download hashes, platform edits, import/export and
memory declarations, engine limits, rejection handling, bridge lifecycle, and
byte-for-byte reproducibility. Keep [third-party notices](THIRD_PARTY_NOTICES.md)
with redistributed binaries.
