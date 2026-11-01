# Islands examples

These examples use the real QuickJS/WASM runtime. Each extension gets a separate instance and can access the host only through granted capabilities. All example state is local and in memory.

## Run

From the repository root, after installing the workspace dependencies:

```sh
bun run build:core
bun run build
bun examples/run.ts
node examples/node/main.mjs
bun examples/service/server.ts
```

Open **http://127.0.0.1:3210**. Use `PORT=3211 bun examples/service/server.ts` to select another port. `PORT` must be an integer from 1 to 65535. The service binds only to the loopback interface. Ctrl-C or SIGTERM stops the HTTP server and disposes its extension instances.

`bun run build` calls `buildExamples()` from [`build.ts`](build.ts), producing:

- `dist/extensions/*.json`: five portable extension artifacts.
- `dist/browser/app.js`, `index.html`, and `style.css`: the plain TypeScript/HTML/CSS browser workbench, bundled with esbuild.
- The shared core is `dist/islands.wasm`.

After changing example sources, `bun examples/build.ts` rebuilds just the artifacts and browser assets. Restart the service to load them. `bun examples/run.ts` asserts editor state, workflow side effects, the JavaScript command, and the portable greeter's state and host calls; it exits nonzero on failure.

## Choose an example

| Source | Host use case | Guest entry points | Host capabilities |
| --- | --- | --- | --- |
| [`extensions/editor.ts`](extensions/editor.ts) | An app embeds a stateful document service | `editor.analyze`, `editor.stats`, `document.saved` event | `editor.read`, `log.write` |
| [`extensions/ticket-workflow.yaml`](extensions/ticket-workflow.yaml) | SaaS support-ticket automation | `ticket.created` event, `automation.status` | `records.create`, `notifications.send` |
| [`extensions/deployment-workflow.json`](extensions/deployment-workflow.json) | PaaS preview-deployment automation | `deployment.requested` event, `automation.status` | `deployments.create`, `notifications.send` |
| [`extensions/slug.js`](extensions/slug.js) | Plain JavaScript page-title command | `slug.create` | `log.write` |
| [`extensions/portable-greeter.ts`](extensions/portable-greeter.ts) | The same artifact across hosts | `greet` | `log.write` |

The demo host implementation is [`host.ts`](host.ts). Its catalog and explicit grant/configuration choices are in [`catalog.ts`](catalog.ts). The root [protocol contract](../docs/protocol.md) describes the boundary shared with other adapters.

### App / editor

Select **Document insights**. Edit the host document and choose **Update document**, then **Analyze document**. The guest calls `editor.read`, calculates word count and reading time, and returns them along with its invocation count. **Emit save event** increments the guest's separate save counter. **Read service state** reads both counters without analyzing again.

The document belongs to the host; counters belong to the extension. **Reset server state** disposes all instances, reloads the artifacts, and restores the original host document.

### SaaS / workflow

Select **Ticket triage**, edit the JSON event payload, and choose **Create ticket**. A YAML-authored guest creates a task in `demo-workspace` and a notification in the `support` inbox. Expand **Workspace tasks** and **Team inbox** to inspect the actual host-owned records.

`records.create` derives workspace identity from load-time host metadata. `notifications.send` checks its requested channel against a host-owned scope. The extension cannot change those scopes by changing its config or payload. Priorities are `low`, `normal`, or `high`; the host contract rejects other values.

### PaaS / deployment

Select **Preview deployment** and choose **Register deployment**. The JSON-authored guest requests a preview deployment for a service and revision. The host checks the environment against load-time metadata, creates a **local deployment registry entry** with status `registered`, and adds a release notification. No cloud resources are provisioned and no external message is sent. These in-memory host capabilities are the concrete integration points an embedding platform replaces with its own APIs.

### Plain JavaScript

Select **Page slug** and choose **Create slug**. For example, `{"title":"Building with Islands"}` returns `{"slug":"building-with-islands"}`. This uses exactly the same bundling and runtime path as TypeScript.

## Browser and Node embedding

The lower panel, **Same artifact. A different host.**, instantiates `dist/islands.wasm` in the browser and loads `portable-greeter.json`. **Greet locally** calls that local instance directly; it does not call `/api/execute`. Its counter starts at 1, advances on repeated greetings, and resets with **Reset instance**. Each call also appears in the browser-owned capability log. Resetting the server does not reset this browser instance.

Implementation: [`service/browser.ts`](service/browser.ts). To inspect the separation in developer tools, watch the Network panel after initial loading: local greetings produce no network requests. The downloaded artifact is also used by [`node/main.mjs`](node/main.mjs) and the [Go](go/) and [Python](python/) examples.

Node uses the package's built ESM export without a TypeScript loader:

```js
import { createRuntime } from "@islands/runtime";
import { readFile } from "node:fs/promises";

const runtime = await createRuntime({
  wasm: new Uint8Array(await readFile("dist/islands.wasm")),
  capabilities: {
    "log.write": (input, { extensionId, signal }) => {
      signal.throwIfAborted();
      console.log(extensionId, input);
      return null;
    },
  },
});
try {
  const artifact = JSON.parse(await readFile("dist/extensions/portable-greeter.json", "utf8"));
  const extension = await runtime.load(artifact, { grants: ["log.write"] });
  console.log(await extension.invoke("greet", { name: "Node" }));
  // { message: "Hello, Node!", calls: 1 }
} finally {
  await runtime.dispose();
}
```

`node examples/node/main.mjs` executes this embedding path with assertions for two greetings, counter values 1 and 2, host-bound extension identity, and matching host log messages.

### Portable greeter contract

- Artifact path: `dist/extensions/portable-greeter.json`.
- Manifest ID: `portable-greeter`; requires `log.write`.
- `greet` accepts `{ name: string }`.
- Each successful call returns `{ message: "Hello, " + name + "!", calls: number }`.
- The first invocation has `calls: 1`; state is instance-local.
- Before returning, it calls host `log.write` with `{ message: sameMessage }`. The host returns `null`.

## Host-defined YAML / JSON semantics

[`loaders/automation.ts`](loaders/automation.ts) is an example **application-owned compiler**, not a feature built into Islands. Both source formats use the same schema:

```yaml
id: ticket-workflow
name: Ticket triage
description: Create a task and notify the team.
event: ticket.created
steps:
  - call: records.create
    input:
      title: { $event: title }
      priority: { $event: priority }
  - call: notifications.send
    input:
      channel: { $config: channel }
      message: { $event: title }
```

Compile it through the host loader:

```ts
import { compileAutomation } from "./examples/loaders/automation.ts";

const artifact = await compileAutomation(sourceText, "yaml"); // or "json"
const extension = await runtime.load(artifact, {
  grants: ["records.create", "notifications.send"],
  config: { channel: "support" },
  metadata: { workspaceId: "demo-workspace", channel: "support" },
});
await extension.emit("ticket.created", { title: "Improve navigation", priority: "high" });
console.log(await extension.invoke("automation.status"));
```

In that snippet, `runtime` is an embedding runtime configured with the host's record and notification implementations (see `host.ts`), and `sourceText` is the YAML above.

The language is deliberately small:

- `id`, `name`, `description`, `event`, and `steps` are required; unknown keys are rejected.
- `steps` contains 1–16 sequential `{ call, input }` objects. Supported calls are `records.create`, `notifications.send`, `deployments.create`, and `log.write`.
- Inputs are JSON literals, arrays, and objects. A complete object `{ "$event": "field.path" }` or `{ "$config": "field.path" }` selects an own property from the event or guest configuration. Missing references fail clearly. There are no JavaScript expressions, executable tags, or string-template evaluation.
- Source is capped at 64 KiB and template nesting at 16 levels. YAML uses strict YAML 1.2 parsing, rejects duplicate keys and warnings, disables aliases, and rejects values outside the supported JSON/template model.
- The compiler validates data, safely encodes it into fixed guest code, and calls `bundleSource({ source, loader: "js", manifest })`. It never evaluates source or templates on the host.
- The guest resolves all step inputs before making calls, then awaits each capability in order. `automation.status` reports completed `runs` and the last event's actual capability results. A later capability failure can leave earlier effects in place; this example does not implement transactions or retries.
- The generated manifest lists required methods. The embedding host still decides grants independently. A manifest requirement does not grant itself access.

## HTTP routes

All mutation routes require `Content-Type: application/json`; request bodies are limited to 64 KiB. Errors are JSON `{ "error": "..." }` with 400 for invalid requests, 404 for unknown extensions/routes, 415 for a missing JSON content type, or 422 when guest execution/capability validation fails.

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/api/extensions` | `{ extensions, state }`; installed manifests, languages, grant lists, action presets, current host state |
| GET | `/api/state` | `{ document, records, notifications, deployments, activity }` |
| POST | `/api/execute` | `{ id, method, input? }` → `{ result, state }` |
| POST | `/api/event` | `{ id, event, payload? }` → `{ result, state }`; result is guest service/workflow state after the event |
| POST | `/api/document` | `{ text }` → `{ state }`; at most 20,000 characters |
| POST | `/api/reset` | `{}` → `{ state }`; disposes and reloads server instances |
| GET / HEAD | `/`, `/app.js`, `/style.css` | Exact generated browser assets |
| GET / HEAD | `/islands.wasm`, `/portable-greeter.json` | Exact shared core and browser example artifact |

There is no arbitrary file-serving path or code-upload endpoint. Only actions declared in the example catalog can be invoked through the HTTP API. Activities and each host record collection retain their most recent 100 entries. The service is a single shared local demo workspace, so browser tabs using the API share its state.

```sh
curl -s http://127.0.0.1:3210/api/extensions

curl -s http://127.0.0.1:3210/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"id":"portable-greeter","method":"greet","input":{"name":"HTTP"}}'

curl -s http://127.0.0.1:3210/api/event \
  -H 'Content-Type: application/json' \
  -d '{"id":"ticket-workflow","event":"ticket.created","payload":{"title":"Improve keyboard navigation","priority":"high"}}'

curl -s http://127.0.0.1:3210/api/reset \
  -H 'Content-Type: application/json' -d '{}'
```
