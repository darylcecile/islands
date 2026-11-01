# Islands Go embedding SDK

Embeds the same `dist/islands.wasm` and portable extension JSON used by JavaScript and Python, using **wazero v1.10.1** (pure Go, no cgo). Requires **Go 1.24+**. The example uses a local `replace` directive in `examples/go/go.mod` to build against this checkout of `github.com/darylcecile/islands/sdk/go`.

From the repository root:

```sh
bun run build:core && bun run build
go -C sdk/go mod download
go -C examples/go mod tidy
go -C examples/go run . ../..
```

The example asserts two `greet` calls, incrementing guest state, matching asynchronous host `log.write` calls, host-bound identity/metadata, event acknowledgement and disposal.

Exercised on macOS arm64 with Go 1.24.2. Other host platforms have not been exercised in this workspace.

## Embed

```go
runtime, err := islands.New(ctx, wasmBytes, islands.Options{
    Capabilities: map[string]islands.Handler{
        "log.write": func(ctx context.Context, input any, caller islands.CallContext) (any, error) {
            // Validate your application shape and authorize caller.Metadata resources.
            return nil, nil
        },
    },
})
if err != nil { return err }
defer runtime.Dispose(context.Background())

artifact, err := islands.ParseArtifact(artifactBytes)
if err != nil { return err }
extension, err := runtime.Load(ctx, artifact, islands.LoadOptions{
    Grants: []string{"log.write"},
    Metadata: map[string]any{"workspaceId": "workspace-123"},
})
if err != nil { return err }
result, err := extension.Invoke(ctx, "greet", map[string]any{"name": "Islands"})
```

`Invoke(ctx, method, input)`, `Emit(ctx, event, payload)` and `Dispose(ctx)` are context-aware; use `nil` for omitted JSON input. Callbacks run on goroutines and receive a deadline-bearing context. No execution lock is held while waiting on host work. WASM turns are serialized; operations can overlap while awaiting callbacks, allowing disposal to interrupt an outstanding invocation. Reentrant invocation from a handler is not a supported API guarantee. Separate instances can execute concurrently. Unawaited guest calls continue pumping when their host results arrive.

`Error` exposes `Code`, `Message`, and `Unwrap()` for `errors.As`/`errors.Is`. Guest handler errors leave the instance usable. ABI failures, resource exhaustion, and active-operation cancellation/timeouts close it; later operations return `DISPOSED`. Runtime disposal cleans up all instances even when guest cleanup fails. A host handler that ignores context can continue running after disposal; its result is discarded, and disposal does not wait for it.

Disposal first rejects new operations and cancels active callbacks. Guest cleanup gets a fresh bounded callback lifecycle, so retired work cannot consume cleanup's quota. Retired workers remain separately tracked until they finish; duplicate IDs cannot replace them. A raw WASM trap permanently disables guest ABI calls, including free/destroy; only the host module is released after a trap.

## Policy and limits

- Default `Policy: "sandboxed"` grants nothing. Explicit `Policy: "trusted"` grants all registered capabilities, retaining WASM limits. Unknown policy names fail.
- Manifest `requires` capabilities are checked for registration and grants **before evaluation**. Every call is checked against the host's instance grants. Identity and copied metadata come from load options, never a guest message.
- Default limits: QuickJS heap 16 MiB, stack 512 KiB, fuel 10,000, operation timeout 5 seconds, 64 pending host calls. Configure via `Options.Limits`; zero fields mean defaults. Fuel counts QuickJS interrupt callbacks **per eval/dispatch/step**, while a monotonic context deadline bounds the entire job drain, even after a result appears. Wazero context interruption also bounds a stuck WASM turn.
- Linear memory is capped at 128 MiB per instance; each outbox and accumulated drain is capped at 1 MiB. Artifact code is limited to 16 MiB. Limits exclude Go allocations and cannot forcibly stop arbitrary host handlers.
- WASI uses clocks, entropy, empty environment/stdio, no preopened filesystem, and rejects socket imports. Neither policy grants ambient filesystem/network access.
- JSON boundary checks accept nil, booleans, finite binary64 numbers, strings, arrays/slices and string-keyed maps. Integer-valued numbers (including floats and `json.Number`) must be within ±9007199254740991; use strings for larger identifiers. Structs, pointers, functions, byte buffers, custom marshalers and cycles are rejected. Results decode into ordinary `encoding/json` types (numbers are `float64`). Inputs/metadata are copied; callbacks should not mutate values concurrently with returning them.

This SDK validates JSON/wire shapes. It does **not** generate Go types or validate arbitrary JSON Schema host contracts; validate your capability input/output shapes in handlers. It does not promise OS-process isolation.

References: [shared protocol](../../docs/protocol.md), [wazero configuration](https://pkg.go.dev/github.com/tetratelabs/wazero@v1.10.1), [wazero Go version](https://github.com/tetratelabs/wazero/blob/v1.10.1/go.mod).
