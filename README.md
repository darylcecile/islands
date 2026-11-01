# Islands

**JavaScript extensions. Your application's rules. A WebAssembly boundary.**

Islands is an embeddable runtime for applications that want user-written JavaScript or TypeScript extensions. Extension code runs in QuickJS, compiled from C to WebAssembly. Your application decides which operations extensions can request, which data they can access, and what an extension document means.

Use it to add commands to a desktop app, automations to a SaaS product, custom logic to a web app, or deployment hooks to a platform—without giving extension code ambient access to the host's filesystem, network, or live objects.

```text
Your app                         Islands                         Extension
host APIs + permissions    ← JSON calls/results →    JavaScript inside WASM
app events                 ─────────────────────→    event subscriptions
invoke an extension method ─────────────────────→    registered handlers
```

## Try it locally

The `@islands/*` packages are local workspace packages, **not published npm releases**. Start from a local checkout of this project. You need [Bun](https://bun.sh/) 1.3.14 or newer and Python 3.10+ for the core build.

Clone the repository, then build from its root:

```sh
git clone https://github.com/darylcecile/islands.git
cd islands
bun install
bun run build:core
bun run build
bun run examples
```

`build:core` uses `python3` to download the pinned QuickJS sources and WASI toolchain, then builds `dist/islands.wasm`. `build` prepares the JavaScript packages and example artifacts in `dist/extensions/`. The first core build needs internet access.

For the demo service and its browser page:

```sh
bun run demo
```

Open **[http://localhost:3210](http://localhost:3210)**. The service is an example embedding application: it supplies its own extension document schema and host APIs. See [running the examples](docs/examples.md) for the JavaScript, browser, Go, and Python entry points.

## Two SDKs, two jobs

**Extension authors** use `@islands/sdk` to define an extension. They register handlers, subscribe to host events, and call capabilities supplied by the application:

```ts
import { defineExtension } from "@islands/sdk";

export default defineExtension({
  activate(ctx) {
    ctx.handle("greet", async (input) => {
      const greeting = await ctx.call("greetings.create", input);
      return { greeting };
    });

    const unsubscribe = ctx.on("workspace.changed", async (workspace) => {
      await ctx.call("activity.record", workspace);
    });

    return unsubscribe;
  },
});
```

Here, `greetings.create`, `activity.record`, and `workspace.changed` are **application-defined names**, not built-in Islands APIs.

**Application developers** use a host SDK to load a bundled artifact, provide capabilities, and control its lifetime. This is the JavaScript API shape; `wasm` is the built core's bytes and `artifact` is the bundled extension:

```ts
import { createRuntime } from "@islands/runtime";

const runtime = await createRuntime({
  wasm,
  capabilities: {
    "greetings.create": () => "Hello from the host!",
    "activity.record": (input, { extensionId }) => {
      console.log(extensionId, input);
      return null;
    },
  },
});

try {
  const extension = await runtime.load(artifact, {
    grants: ["greetings.create", "activity.record"],
    config: { locale: "en" },
  });

  console.log(await extension.invoke("greet", { name: "Ada" }));
  await extension.emit("workspace.changed", { id: "workspace-1" });
} finally {
  await runtime.dispose();
}
```

For complete file-to-artifact and artifact-to-runtime examples, start with [authoring](docs/authoring.md) and [embedding](docs/embedding.md).

## Bring your own extension format

Islands standardizes the **runtime artifact and host/guest protocol**. It does not prescribe your product's plugin configuration language.

| Authoring format | Good fit | What your application supplies |
| --- | --- | --- |
| TypeScript | Larger extensions, editor hints, typed host APIs | A host contract; tooling bundles TS into JavaScript. |
| JavaScript | Small scripts and generated logic | A manifest and the host APIs the script may call. |
| YAML | Human-edited workflows, recipes, agent definitions | A schema and a loader that translates your document into an artifact. |
| JSON | API-created configurations, visual editors | The same kind of host-owned schema and loader. |

All four can produce the same portable `{ formatVersion, manifest, code }` artifact. YAML and JSON acquire behavior through your loader; Islands does not interpret arbitrary YAML as executable instructions. The [demo service](examples/service/) shows an application-specific loader alongside plain JavaScript extensions.

Optional JSON Schema **host contracts** describe capability arguments and results. The JavaScript host SDK validates these at the boundary, and the tooling can generate a TypeScript host-method map for extension authors. Document schemas and capability contracts are different layers; see [architecture](docs/architecture.md).

## Where to embed it

| Application | Example extension | Host-owned capabilities |
| --- | --- | --- |
| Desktop editor | Rewrite a selection; add a document command | Read the selected text, propose an edit, show a notification. |
| Web application | Compute a custom view or respond to app events | Return a JSON view model; let the host render and validate actions. |
| Coding agent | Add a tool or react to a session event | Register tool descriptions, read scoped workspace context, invoke extension handlers. |
| SaaS | Route incoming tickets or enrich a webhook | Read tenant-scoped records, write approved fields, send a notification. |
| PaaS | Validate a deployment plan or run a release hook | Inspect a plan, return diagnostics, request narrowly scoped platform actions. |

The same extension artifact can be used by JavaScript/browser, Go, and Python hosts that implement its required capabilities. The application chooses instance lifetime: a short-lived job, an open workspace, or a tenant automation. In-memory extension state survives calls within that instance; durable state belongs behind a host capability.

## Isolation and permissions

- Each loaded extension gets its own WASM instance and QuickJS runtime. The core has no ambient filesystem or network access.
- **`sandboxed`** is the default policy. Capabilities must be explicitly granted; an empty grant list permits none.
- **`trusted`** grants all capabilities registered with that runtime at load time. It uses the **same WASM engine and resource limits**.
- Required capabilities are checked before extension code executes. Permission decisions and tenant metadata stay in host-owned state.
- CPU fuel, guest memory limits, operation deadlines, and pending-call limits constrain different resources. Fuel counts QuickJS interrupt callbacks; it is not elapsed time or a WASM-instruction count.

Neither policy promises OS-process isolation or hard preemption of host callbacks. Your host remains responsible for authorization, cancellation, quotas, and the resources used by its own APIs. Read [security and resource limits](docs/security.md) before exposing capabilities.

## Documentation

- [Author an extension](docs/authoring.md): TypeScript/JavaScript, bundling, callbacks, events, and state.
- [Embed Islands](docs/embedding.md): local packages, host capabilities, browser integration, Go, and Python.
- [Run the examples](docs/examples.md): executable entry points and the demo service.
- [Architecture](docs/architecture.md): contracts, portable artifacts, engine, and lifecycle.
- [Security](docs/security.md): grants, trust boundaries, limits, and host responsibilities.
- [API reference](docs/reference.md): public JavaScript APIs and defaults.
- [Protocol](docs/protocol.md): the portable artifact, WASM ABI, and JSON wire contract.
- [Contributing](CONTRIBUTING.md): build, test, and make a coherent change.

## License

[MIT](LICENSE), copyright 2026 Islands contributors. The core also includes QuickJS; see the [third-party notices](core/THIRD_PARTY_NOTICES.md).
