# Authoring extensions

An Islands extension is a JavaScript module with a default export containing `activate(ctx)`. TypeScript authors use `@islands/sdk` for types; the authoring tools bundle the module into a portable artifact before a host loads it.

The application you are extending defines the available capabilities, events, configuration, and extension entry points. Islands supplies the execution model. A method such as `log.write` exists only if that application provides it.

## Your first extension

First complete the [local build](../README.md#try-it-locally). The following tutorial runs inside that checkout, where `@islands/sdk` and `@islands/tooling` resolve to local workspace packages.

Create `scratch/greeter.ts`:

```ts
import { defineExtension } from "@islands/sdk";

export default defineExtension({
  activate(ctx) {
    let calls = 0;

    ctx.handle("greet", async (input) => {
      if (
        !input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.name !== "string"
      ) {
        throw new Error("greet expects { name: string }");
      }

      calls += 1;
      const message = `Hello, ${input.name}!`;
      await ctx.call("log.write", { message });
      return { message, calls };
    });

    const unsubscribe = ctx.on("greeting.reset", () => {
      calls = 0;
    });

    return unsubscribe;
  },
});
```

`greet` is a method exposed **by the extension to the host**. `log.write` is a capability requested **by the extension from the host**. The two directions are deliberately separate.

### Bundle it

Create `scratch/build-greeter.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { bundleExtension } from "@islands/tooling";

const artifact = await bundleExtension({
  entrypoint: "./scratch/greeter.ts",
  manifest: {
    id: "my-greeter",
    name: "My greeter",
    version: "1.0.0",
    requires: ["log.write"],
  },
});

await mkdir("dist/extensions", { recursive: true });
await writeFile(
  "dist/extensions/my-greeter.json",
  JSON.stringify(artifact, null, 2),
);
```

Run it from the checkout root:

```sh
bun run scratch/build-greeter.ts
```

The output is an artifact with a versioned format, manifest, and bundled JavaScript. The bundler compiles your code; it does not execute your extension in the host. Continue with [loading this artifact](embedding.md#load-an-artifact) to run it.

For an existing end-to-end example, inspect [`examples/extensions/portable-greeter.ts`](../examples/extensions/portable-greeter.ts) and run `bun run examples`.

## The extension context

### `ctx.handle(method, handler)`

Register a method that the host can invoke with `extension.invoke(method, input)`. A handler receives a JSON value and may return a JSON value or a Promise of one. Missing results normalize to `null`.

```ts
const removeHandler = ctx.handle("status", () => ({ ready: true }));
```

The returned function unregisters that handler and is safe to call more than once. Use clear, application-specific names for your public methods. Validate inputs, particularly when your host does not supply a typed calling layer.

### `ctx.call(method, input?)`

Request a host capability and await its JSON result:

```ts
const document = await ctx.call("editor.read", null);
```

This is an asynchronous request/response bridge, not a direct function call into the application's memory. The host may perform I/O and return later. Authorization or host failures reject the Promise; use normal `try`/`catch` when you have a meaningful recovery path.

Declare capabilities essential to activation or normal operation in `manifest.requires`. The host must both provide and grant those methods before any extension code executes. Declaring a method never grants it. Optional capabilities can be requested at runtime, but the host can reject them.

### `ctx.on(event, listener)`

Subscribe to an event emitted by the embedding application:

```ts
const unsubscribe = ctx.on("document.saved", async (payload) => {
  await ctx.call("log.write", { event: "document.saved", payload });
});
```

The host calls `extension.emit("document.saved", payload)`. Its Promise waits for the event's subscribed work. `ctx.on` returns an idempotent unsubscribe function. Islands does not supply a global event broker: the application decides which instances receive each event.

### `ctx.config`

Read the JSON configuration passed by the host at load time. Its structure belongs to that host's extension contract. Validate it before use; a TypeScript annotation alone does not validate JSON. Configuration is visible to the extension, so do not put host secrets there unless intentionally sharing them.

## Activation and cleanup

`activate` can be synchronous or asynchronous. Loading does not finish until activation finishes. You can register handlers immediately, await host-provided setup, and return a cleanup function:

```ts
export default defineExtension({
  async activate(ctx) {
    const settings = await ctx.call("settings.read", null);
    const remove = ctx.handle("settings.current", () => settings);

    return () => {
      remove();
    };
  },
});
```

In this example, `settings.read` is an application-defined capability and should appear in the manifest's `requires` list. Cleanup may also return a Promise, but the host bounds how long it waits. Do not rely on cleanup as the only place to save important data: failures and termination can prevent it from completing.

## State across calls and across restarts

Variables captured by `activate` persist for the lifetime of that loaded instance. The greeter's `calls` counter survives successive invocations; it resets when the host disposes and reloads the artifact. Loading the same artifact in another host creates independent state.

For durable state, use capabilities provided by your application. For example, a host could implement `state.read` and `state.write` using a database, with keys scoped by host-bound tenant and extension identity. Islands does not include a default persistent store or serialize the guest heap.

Await operations when ordering matters. Two pieces of asynchronous work can interleave across awaited host calls; shared closure state is not a transaction or a concurrency-control mechanism. Put atomic updates in the host storage API when required.

## Plain JavaScript and source strings

The SDK is optional at runtime: this plain JavaScript definition has the same shape.

```js
export default {
  activate(ctx) {
    ctx.handle("double", (value) => {
      if (typeof value !== "number") throw new Error("Expected a number");
      return value * 2;
    });
  },
};
```

For editor submissions or generated modules, bundle a source string:

```ts
import { bundleSource } from "@islands/tooling";

const artifact = await bundleSource({
  loader: "js",
  manifest: { id: "double" },
  source: `
    export default {
      activate(ctx) {
        ctx.handle("double", value => {
          if (typeof value !== "number") throw new Error("Expected a number");
          return value * 2;
        });
      }
    };
  `,
});
```

Use `loader: "ts"` for TypeScript source. Keep bundling in the authoring/build layer; deployed Go, Python, and browser hosts can load the resulting artifact without a TypeScript compiler.

## YAML and JSON authoring

A YAML or JSON extension is interpreted according to the embedding application's schema. The demo's [`automation` loader](../examples/loaders/automation.ts), for example, accepts an event and a list of allowed capability calls:

```yaml
id: ticket-workflow
name: Ticket triage
description: Turn a ticket into a task and notify the team.
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

Here, `steps`, `$event`, and `$config` belong to the demo, not the Islands protocol. The loader validates the document, embeds it as data in a fixed JavaScript interpreter, and bundles that module. Reference resolution and capability requests then run inside the guest. The equivalent JSON format uses the same loader semantics; see [`deployment-workflow.json`](../examples/extensions/deployment-workflow.json).

## Working with host types

Your host can publish a JSON Schema capability contract and use `@islands/tooling` to generate a TypeScript method map. That map describes the inputs and outputs of `ctx.call`; see [contracts and type generation](reference.md#contracts-and-type-generation).

This generation targets TypeScript. Go and Python hosts consume the same artifact and protocol; do not assume they receive generated native client types from this tooling.

## Guest environment and data

Write JavaScript for the engine environment, not for Node.js or a browser. Do not assume `process`, `require`, the DOM, `fetch`, or timers are available. Request I/O, logging, time-dependent services, and application data through documented host capabilities. Dependencies must be bundleable and compatible with this environment.

Boundary values must be JSON: `null`, booleans, finite numbers, strings, arrays, and string-keyed objects containing JSON values. Integer values must be within ±9,007,199,254,740,991; encode larger identifiers as strings. Functions, symbols, `BigInt`, cyclic objects, and live native objects do not cross the boundary. Represent dates as strings and binary data using a host-agreed encoding. Missing optional inputs and return values normalize to `null`; avoid embedding `undefined` inside data structures.

See the [API reference](reference.md) for exact signatures and [security](security.md) for what the host may grant and limit.
