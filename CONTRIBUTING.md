# Contributing to Islands

Start by building and running an example. Changes should preserve the portable artifact and JSON protocol across JavaScript, browsers, Go, and Python, while keeping application policy outside guest-controlled memory.

Read [AGENTS.md](AGENTS.md) and [the protocol](docs/protocol.md) before changing the core or adapters. The [architecture guide](docs/architecture.md) explains where authoring, host policy, and runtime behavior belong.

## Local setup

Requirements:

- Bun 1.3.14+ for the workspace, authoring tools, and demo.
- Python 3.10+ for the core build script, which uses only the Python standard library.
- Internet access for initial dependency and pinned core/toolchain downloads.
- Node.js 22+ to exercise the built ESM Node example.
- Go 1.24+ for Go SDK work; Python 3.11+ for Python SDK work.

From a local checkout:

```sh
bun install
bun run build:core
bun run build
bun run examples
```

The packages are local workspaces. Do not substitute registry installation commands for this setup unless packages have actually been published.

## Find the right layer

| Path | Responsibility |
| --- | --- |
| `core/islands.c` | WASI reactor, QuickJS runtime, memory and interrupt budgets, ABI. |
| `core/guest.js` | Guest context, activation, handlers, events, Promises, cleanup. |
| `packages/protocol/` | Shared JSON types and portable artifact/contract definitions. |
| `packages/sdk/` | Extension-author API and TypeScript types. |
| `packages/tooling/` | Bundling, manifest validation, TypeScript host-method generation. |
| `packages/runtime/` | JavaScript/browser host adapter and host-owned policy. |
| `sdk/go/`, `sdk/python/` | Native adapters for the same core and artifacts. |
| `examples/` | Executable integrations, host-specific loaders, and demo service. |
| `docs/` | Onboarding, public reference, and shared ABI contract. |

Host-specific YAML/JSON semantics belong in a loader, not in the core protocol. The bundler may compile extension code but must not evaluate it in the host. Runtime capability authorization must use the host's instance state rather than guest-supplied identities or grants.

## Core build

`bun run build:core` invokes [`scripts/build_core.py`](scripts/build_core.py). It downloads checksum-pinned QuickJS and WASI SDK archives, applies the explicit portability adjustments, and builds a wasm32 WASI Preview 1 reactor.

The current pins live in that script: QuickJS `2026-06-04` and WASI SDK `34.0`. Automatic toolchain selection is implemented for macOS and Linux on arm64/x86_64. That selection table is not a claim that every platform has been verified; exercise the build and adapters on the platform you change or deploy.

Outputs include `dist/islands.wasm`, `dist/islands.build.json`, and `dist/THIRD_PARTY_NOTICES.md`. Build metadata records the source, toolchain, guest bridge, and output hashes. Downloads and intermediate work use `build/` by default.

Inspect or override build options with:

```sh
python3 scripts/build_core.py --help
python3 scripts/build_core.py --wasi-sdk /absolute/path/to/wasi-sdk
```

`WASI_SDK_PATH` also selects a custom toolchain. A custom SDK is not checksum-pinned by the build script and is recorded as custom in the metadata. The default build uses the pinned downloads.

When changing `core/guest.js`, rebuild the core: the bridge is embedded into the binary. Editing the JavaScript file alone does not change an existing WASM artifact. Preserve applicable upstream notices; see [`core/THIRD_PARTY_NOTICES.md`](core/THIRD_PARTY_NOTICES.md).

## Make and verify a coherent change

Keep changes focused, follow the surrounding code's conventions, and handle errors explicitly. Finish the coherent implementation before running the verification pass.

For JavaScript/core changes, build the affected outputs and run:

```sh
bun run typecheck
bun test
bun run examples
node examples/node/main.mjs
```

For core changes, run `bun run build:core` and `bun run build` first. For package, loader, or example changes, re-run `bun run build` so tests of built exports and artifacts exercise the new code.

For native changes or portable protocol changes, also run the [Go and Python examples](docs/examples.md#go) and the affected SDK's existing checks. For browser-facing changes, start `bun run demo` and exercise the browser-local greeter as well as the server action you changed. Server success alone does not verify browser execution.

Use meaningful tests for behavior that can regress: grant enforcement, JSON validation, async host calls, lifecycle cleanup, and resource failures. A small documentation or mechanical change does not need a new test that merely restates the implementation. Public API changes should update executable examples and documentation together.

Do not claim a sandbox profile or platform is supported solely because code compiles or an adapter exists. Report the actual runtime/platform and the behavior exercised, and name any unverified paths.

## Proposing a change

Include:

- The problem and an example of the intended behavior.
- The affected layer and any artifact, ABI, or public API implications.
- Commands or reproduction steps used to verify the result.
- Documentation and examples needed by authors or embedders.

Keep protocol changes explicit and coordinated across adapters. Avoid changing shared message semantics in only one SDK. If an API is application-specific, show it as an application-defined example rather than presenting it as a built-in capability.

For bug reports, include versions, the host adapter, a minimal artifact or source, host grants/limits, the failing operation, and the observed error. Remove application secrets and private data from reproductions.

## License

Islands is licensed under [MIT](LICENSE). Preserve copyright and license notices in contributed and redistributed code, including third-party components used by the core.
