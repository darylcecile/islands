# Embedding Islands

Your application is the **host**. It provides the WASM core, loads extension artifacts, registers the APIs they can request, and owns their lifetime. The author SDK is used inside extensions; the host SDK stays in your application.

## Use the local packages

Build the checkout using the [quickstart](../README.md#try-it-locally). The packages are not published npm releases. Inside this workspace, `bun install` makes these imports available:

| Package | Used by | Purpose |
| --- | --- | --- |
| `@islands/runtime` | Application | Instantiate the core, provide capabilities, load and manage extensions. |
| `@islands/sdk` | Extension author | `defineExtension`, context types, and typed host calls. |
| `@islands/tooling` | Authoring/build pipeline | Bundle JavaScript/TypeScript; generate TypeScript host types. |
| `@islands/protocol` | Adapters and shared application code | Artifact, manifest, contract, and JSON types. |

`bun run build` writes ESM JavaScript and declarations to each package's `dist/`. It also copies the core to `packages/runtime/dist/islands.wasm`; the canonical build output is `dist/islands.wasm`.

For a separate local app, an explicit path import avoids assuming these packages are on a registry. For example, if `my-app/` and `islands/` are sibling directories, an app entry file at `my-app/main.ts` can use:

```ts
import { createRuntime } from "../islands/packages/runtime/dist/index.js";
```

Keep the Islands checkout's installed dependencies available so the built package can resolve them. Alternatively, include the Islands packages in your application's workspace and use package imports there. A `workspace:*` dependency is meaningful only inside a workspace containing those packages; it is not an external installation version.

Supply the built WASM bytes explicitly. This keeps asset loading under your application's control and avoids an implicit filesystem or network dependency in the runtime API. For a browser application, bundle the runtime JavaScript using your application bundler and serve the WASM as an asset. The authoring tools belong in the build pipeline rather than the browser runtime.

## Load an artifact

This complete host runs the `my-greeter.json` artifact from the [authoring tutorial](authoring.md#your-first-extension). Save it as `scratch/run-greeter.ts` and run from the checkout root:

```ts
import { readFile } from "node:fs/promises";
import { createRuntime } from "@islands/runtime";

const wasm = new Uint8Array(await readFile("dist/islands.wasm"));
const artifact = JSON.parse(
  await readFile("dist/extensions/my-greeter.json", "utf8"),
);

const runtime = await createRuntime({
  wasm,
  capabilities: {
    "log.write": (input, context) => {
      console.log(`[${context.extensionId}]`, input);
      return null;
    },
  },
});

try {
  const extension = await runtime.load(artifact, {
    grants: ["log.write"],
    config: {},
    metadata: { workspaceId: "local-demo" },
  });

  console.log(await extension.invoke("greet", { name: "Ada" }));
  console.log(await extension.invoke("greet", { name: "Grace" }));
  await extension.emit("greeting.reset");
  console.log(await extension.invoke("greet", { name: "Lin" }));
} finally {
  await runtime.dispose();
}
```

```sh
bun run scratch/run-greeter.ts
```

The three results contain `calls: 1`, `calls: 2`, and `calls: 1`: closure state survives invocations, and the event resets it. Each greeting also passes through the host's logging capability. `runtime.dispose()` releases the instance even if an invocation throws.

For the repository's prebuilt examples rather than the tutorial artifact, run `bun run examples`; see [example entry points](examples.md).

## Design the host API

A capability is a synchronous or asynchronous `(input, context) => result` function. Inputs and outputs are JSON values. `context` contains:

- `extensionId`: the identity bound to this loaded instance by the host.
- `metadata`: host-supplied installation/request context, such as tenant or workspace identity.
- `signal`: an `AbortSignal` for pending-work cancellation.

Prefer API operations your application can authorize and bound independently: `documents.read`, `tasks.create`, or `deployments.validate`, for example. The names have no runtime-defined semantics.

Keep tenant identity in host metadata and look up data within that scope. A guest-supplied document ID is an input to authorization, not proof of permission. Pass `context.signal` to cancellable host work and set limits appropriate to the underlying service. See [resource authorization](security.md#authorize-resources-not-only-method-names).

### Validate a capability contract

Provide a `HostContract` to validate capability inputs and outputs in the JavaScript host. For example:

```ts
import type { HostContract } from "@islands/protocol";

const contract: HostContract = {
  name: "greeter-host",
  version: "1.0.0",
  methods: {
    "log.write": {
      input: {
        type: "object",
        properties: { message: { type: "string", maxLength: 1000 } },
        required: ["message"],
        additionalProperties: false,
      },
      output: { type: "null" },
    },
  },
};
```

Pass `contract` alongside `wasm` and `capabilities` in `createRuntime`. Contracts use JSON Schema draft-07. Keep the contract and capability implementation in sync. Schema validation happens outside guest memory; the guest cannot change the host's validator or grant set. The contract describes host calls, not your entire extension document format or every `invoke` payload.

Use the same contract to [generate author-facing TypeScript types](reference.md#contracts-and-type-generation). Native adapters share the runtime protocol, but this JavaScript contract option does not imply Go/Python type generation or automatic schema validation in those adapters.

## Lifetime, callbacks, and events

Choose an instance lifetime that matches the feature:

- **Desktop/web app:** retain an instance while a document or workspace is open. Emit app events and dispose on closure or extension uninstall.
- **SaaS automation:** use a short-lived instance for a job or retain one for a scoped automation. Keep durable state in host storage rather than depending on process uptime.
- **PaaS hook:** load an instance for a deployment operation, provide scoped plan/action APIs, and dispose it when the operation completes.

`ctx.call` lets an extension await an asynchronous host callback. The adapter does not hold the WASM execution lock while your callback performs I/O. Once your callback returns, the adapter sends the JSON result and resumes guest jobs. You do not manually resolve guest Promises.

`extension.emit` is a delivery to that instance, not a broadcast. The host chooses recipients and awaits event completion. Use `extension.invoke` when you want a specific handler's return value.

Calls into an instance are serialized at the WASM boundary. For business logic that must not overlap, explicitly await operations in the required order. Do not await a reentrant invocation of the same instance from inside its host capability callback unless the adapter explicitly supports it.

Dispose each extension at its lifetime boundary, or call `runtime.dispose()` to dispose all its instances. Cleanup is bounded, and pending host work receives cancellation even if guest cleanup fails. Handle errors from operations and disposal; do not silently continue using an instance after an engine failure.

## Browser and desktop integration

The runtime accepts a `Uint8Array` or a compiled `WebAssembly.Module`, so your web app controls fetching, caching, and asset paths. The browser portion of the [demo](../examples/service/browser.ts) is a complete integration using the same core and portable greeter as the server and native examples.

The essential loading code looks like this in a browser bundle:

```ts
import { createRuntime } from "@islands/runtime";

async function get(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const [wasmResponse, artifactResponse] = await Promise.all([
  get("/islands.wasm"),
  get("/portable-greeter.json"),
]);

const runtime = await createRuntime({
  wasm: new Uint8Array(await wasmResponse.arrayBuffer()),
  capabilities: {
    "log.write": (input) => {
      console.log("Extension log:", input);
      return null;
    },
  },
});

try {
  const extension = await runtime.load(await artifactResponse.json(), {
    grants: ["log.write"],
  });
  console.log(await extension.invoke("greet", { name: "Browser" }));
} finally {
  await runtime.dispose();
}
```

Serve the WASM with `Content-Type: application/wasm`. The demo serves the asset URLs above. Your application's paths may differ; a static asset should return the actual WASM or JSON, not an HTML fallback page.

A web or desktop shell still decides how to expose UI. A useful pattern is to accept JSON view models or commands from extensions and render them through host-owned components. Passing a DOM node or privileged desktop API object would bypass the JSON model and is not part of this SDK.

Synchronous WASM work runs on the calling thread. Use a worker for workloads that should not occupy the UI thread, and forward JSON app operations through your own worker messaging layer. Islands does not automatically create a worker or a process. Review the [deadline and fuel distinction](security.md#cpu-fuel-is-not-a-wall-clock) when sizing limits.

## Go and Python hosts

Build the core and artifacts once with the checkout's Bun/Python build tools. Native hosts then read `dist/islands.wasm` and `dist/extensions/portable-greeter.json`; they do not need to compile TypeScript at runtime.

- The [Go SDK](../sdk/go/) uses wazero. See its local module setup and the [Go example](examples.md#go).
- The [Python SDK](../sdk/python/) uses Wasmtime. See its local package setup and the [Python example](examples.md#python).

Both adapters expose capabilities with host-bound identity/metadata and cancellation, plus load, invocation, events, and disposal using their language's conventions. Use native JSON-compatible values at the boundary. Keep large integers and binary data in an explicitly agreed representation instead of relying on language-specific serialization.

The native example programs are the source of truth for complete imports, options, error handling, and cleanup. Platform verification is separate from API availability; run the examples and relevant SDK checks on the system you intend to deploy.

## Delivering extensions in an application

Keep three artifacts distinct in your build and deployment:

1. **The trusted core:** the `islands.wasm` binary built from pinned sources.
2. **Extension artifacts:** JSON containing the manifest and bundled guest JavaScript.
3. **Host installation policy:** grants, configuration, authoritative metadata, and instance ownership.

An application-specific YAML/JSON loader belongs in the authoring or installation layer and produces item 2. Its document cannot confer the authority in item 3. The host loads the artifact and checks policy before activation.

Replacing an extension is an application lifecycle operation: retire or dispose its existing instance, then load the chosen artifact. If state must survive, persist it through a host API and decide how its schema evolves. Islands does not supply an extension registry, updater, or durable storage backend.
