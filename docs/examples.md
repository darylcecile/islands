# Running the examples

The examples use real extension artifacts and the shared WASM core. The demo application's records, notifications, and deployment registry are local, in-memory host state. Its deployment example records a preview deployment; it does not provision cloud infrastructure.

## Build once

From the checkout root, with Bun 1.3.14+ and Python 3.10+:

```sh
bun install
bun run build:core
bun run build
```

This produces:

| Output | Contents |
| --- | --- |
| `dist/islands.wasm` | Shared QuickJS/WASI core. |
| `dist/islands.build.json` | Core build versions, inputs, and checksums. |
| `dist/extensions/*.json` | Bundled extension artifacts. |
| `dist/browser/` | Demo page, styles, and bundled browser JavaScript. |
| `packages/*/dist/` | Built ESM packages and declarations. |

Re-run `bun run build` after changing an extension or the demo. Re-run `bun run build:core` first if you change `core/islands.c` or `core/guest.js`.

## JavaScript host

```sh
bun run examples
```

[`examples/run.ts`](../examples/run.ts) loads all five artifacts, asserts their results and host effects, and disposes the runtime. The host implementation is [`examples/host.ts`](../examples/host.ts), including its JSON Schema capability contract, grants, and resource-scoped callbacks.

| Example source | Artifact in `dist/extensions/` | What to learn |
| --- | --- | --- |
| [`editor.ts`](../examples/extensions/editor.ts) | `editor-assistant.json` | Read a host document, preserve counters, handle save events, clean up subscriptions. |
| [`ticket-workflow.yaml`](../examples/extensions/ticket-workflow.yaml) | `ticket-workflow.json` | Translate a host-defined YAML workflow into an event-driven extension. |
| [`deployment-workflow.json`](../examples/extensions/deployment-workflow.json) | `deployment-workflow.json` | Use the same loader with JSON and enforce host-owned environment scope. |
| [`slug.js`](../examples/extensions/slug.js) | `slug-command.json` | Bundle plain JavaScript into a command extension. |
| [`portable-greeter.ts`](../examples/extensions/portable-greeter.ts) | `portable-greeter.json` | Run one artifact across different hosts, preserving instance state and calling `log.write`. |

The source JSON for the deployment workflow is an application document; its output JSON is an Islands artifact containing bundled code. They intentionally have different schemas despite sharing a file extension.

### Node.js

With Node.js 22+ and the packages already built:

```sh
node examples/node/main.mjs
```

This uses the built ESM package export, not Bun's TypeScript loader. [`examples/node/main.mjs`](../examples/node/main.mjs) asserts two greets, increasing `calls`, and matching host log entries, then disposes the instance and runtime.

## Demo service and browser

```sh
bun run demo
```

Open [http://localhost:3210](http://localhost:3210). The server binds to `127.0.0.1`. To select a different port:

```sh
PORT=3211 bun run demo
```

### Walk through the workbench

1. Select **Document insights**, update the host document, and run **Analyze document**. Repeat to see `analyses` increase. Choose **Emit save event**, then read the service state.
2. Select **Ticket triage** and run **Create ticket**. Inspect the workspace task and team inbox under **Host state**.
3. Select **Preview deployment** and run **Register deployment**. Inspect the local deployment registry and notification.
4. Select **Page slug** to turn a title into a slug using a plain JavaScript extension.
5. In **Same artifact. A different host.**, click **Greet locally** twice. Its counter and capability log belong to a separate WASM instance in your browser. Those invocations do not call the server API.

**Reset server state** clears the in-memory server host and reloads its extensions. The browser's **Reset instance** button independently reloads the local greeter. Stopping the server loses server state; there is no durable database in this demo.

Source entry points:

- [`examples/service/server.ts`](../examples/service/server.ts): loopback HTTP service, static assets, JSON endpoints, shutdown.
- [`examples/service/browser.ts`](../examples/service/browser.ts): workbench UI and the browser-owned runtime.
- [`examples/catalog.ts`](../examples/catalog.ts): example manifests, config, grants, and permitted demo actions.
- [`examples/loaders/automation.ts`](../examples/loaders/automation.ts): the demo's YAML/JSON schema, validation, and translation into guest code.

### Call the service directly

With the demo running, invoke the server's greeter:

```sh
curl --fail-with-body http://localhost:3210/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"id":"portable-greeter","method":"greet","input":{"name":"Ada"}}'
```

The response contains `result` and a snapshot of `state`. For a fresh server instance, `result` is `{ "message": "Hello, Ada!", "calls": 1 }`.

Trigger the YAML workflow:

```sh
curl --fail-with-body http://localhost:3210/api/event \
  -H 'Content-Type: application/json' \
  -d '{"id":"ticket-workflow","event":"ticket.created","payload":{"title":"Improve keyboard navigation","priority":"high"}}'
```

| Endpoint | Request |
| --- | --- |
| `GET /api/extensions` | Installed demo catalog and host state. |
| `GET /api/state` | Current host state. |
| `POST /api/execute` | `{ "id": "…", "method": "…", "input": … }` |
| `POST /api/event` | `{ "id": "…", "event": "…", "payload": … }` |
| `POST /api/document` | `{ "text": "New document text" }` |
| `POST /api/reset` | `{}` |

These endpoints are the example application's API, not a built-in Islands server protocol. The service accepts only the actions listed in its catalog and requires JSON bodies for POST requests.

## Go

Requires Go 1.24+ and the built shared artifacts. From the checkout root:

```sh
go -C sdk/go mod download
go -C examples/go mod tidy
go -C examples/go run . ../..
```

The example module's [`go.mod`](../examples/go/go.mod) uses a local `replace` directive pointing to `../../sdk/go`; the module path is not a claim of a published repository or version.

[`examples/go/main.go`](../examples/go/main.go) loads `dist/extensions/portable-greeter.json`, checks two greetings with `calls` equal to 1 and 2, verifies asynchronous host logging and bound metadata, emits an event, and disposes the instance. It uses the wazero-based [Go SDK](../sdk/go/README.md).

## Python

Requires Python 3.11+ for the SDK. From the checkout root:

```sh
python3 -m venv build/venv
build/venv/bin/python -m pip install -e ./sdk/python
build/venv/bin/python examples/python/main.py
```

If your `python3` is older than 3.11, use a newer Python executable for the `venv` command. The editable install uses the local SDK; it does not assume an Islands package is published to PyPI.

[`examples/python/main.py`](../examples/python/main.py) runs the same portable greeter checks using `asyncio` and the Wasmtime-based [Python SDK](../sdk/python/README.md). The runtime's async context manager owns cleanup.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing `dist/islands.wasm` | Run `bun run build:core` before `bun run build`. |
| Missing package export, extension JSON, or browser asset | Run `bun install` and `bun run build` from the checkout root. |
| Core toolchain download fails | Check network access and the error from `scripts/build_core.py`; see [core build options](../CONTRIBUTING.md#core-build). |
| Required capability is not granted | Compare `manifest.requires`, the runtime's registered capabilities, and host-supplied grants. |
| WASM fetch returns HTML | Correct your application's static-asset path or development-server fallback. |
| Port 3210 is already in use | Choose another port with `PORT=3211 bun run demo`. |
| Python cannot import `islands` | Use the virtual environment interpreter used for the editable install. |
| A counter resets | Confirm you are invoking the same live instance; browser, server, and native hosts have independent state. |

For new integrations, follow [embedding](embedding.md). For the runtime contract and resource model, read [architecture](architecture.md) and [security](security.md).
