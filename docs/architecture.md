# Architecture

Islands separates three decisions: **how extensions are authored**, **what the application lets them do**, and **where their JavaScript executes**.

## The layers

```text
TypeScript / JavaScript       Application-specific YAML / JSON
         │                           │
  authoring tools             host-owned loader
         └──────────────┬────────────┘
                        ▼
               Portable JSON artifact
                manifest + bundled JS
                        │
                        ▼
Application ──────── Host SDK ──────── WASM core
 APIs, storage,      validation,       QuickJS + guest bridge
 UI, identity       grants, lifecycle  one runtime per instance
```

### Author SDK and tooling

`@islands/sdk` provides `defineExtension` and the types an extension author uses. `defineExtension` is a typed identity function: it does not create an execution environment or grant access to anything.

`@islands/tooling` bundles author code into an artifact. TypeScript is compiled before loading; the core executes JavaScript. The bundler does not evaluate extension code in the host application.

### Host SDKs

Host SDKs embed the engine, validate messages, enforce grants, and route capability calls into application code. JavaScript hosts use `@islands/runtime`; native adapters live in [`sdk/go/`](../sdk/go/) and [`sdk/python/`](../sdk/python/).

The host owns identity and metadata. An extension's manifest ID is a label for the instance, not proof of an author's identity or a tenant entitlement. Host callbacks receive the ID and metadata bound to that loaded instance; guest messages cannot replace them.

### Core

The core compiles pinned **QuickJS C sources into a wasm32 WASI Preview 1 reactor**. It uses a direct C ABI; it is not based on `quickjs-emscripten`.

One WASM instance owns one QuickJS runtime. A small JavaScript bridge inside the guest implements activation, method handlers, event subscriptions, and Promise-based host calls. Adapters interact with it through UTF-8 JSON messages and explicit memory-management exports.

WASI imports provide engine prerequisites such as clock and entropy. The embedding does not supply preopened directories, sockets, or a process environment containing application secrets. The host's APIs are available only through the capability bridge.

See the [protocol](protocol.md) for ABI exports, message envelopes, buffer lifetimes, and validation requirements.

## Two kinds of contract

An **extension document schema** is your application's authoring format. A workflow product might accept `triggers` and `steps`; an editor might accept `commands`; an agent service might accept instructions and tools. Your loader parses and validates that schema and produces an artifact. Islands does not assign built-in meaning to those fields.

A **host capability contract** describes callable methods and their JSON inputs and outputs:

```json
{
  "name": "example-host",
  "version": "1.0.0",
  "methods": {
    "greetings.create": {
      "input": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"],
        "additionalProperties": false
      },
      "output": { "type": "string" }
    }
  }
}
```

JavaScript hosts can use this contract for runtime validation, and tooling can generate a TypeScript method map from it. Types help authors; runtime validation protects the boundary. Neither grants permission to call the method. Grants are a separate host policy decision.

## Portable artifacts

An artifact is JSON, not a native executable or an engine-specific bytecode snapshot:

```ts
{
  formatVersion: 1,
  manifest: {
    id: "example.greeter",
    version: "1.0.0",
    requires: ["greetings.create"],
  },
  code: "/* bundled IIFE defining __islands_extension.default */",
}
```

The code comment above illustrates the shape; use the bundler to produce executable `code`. The actual IIFE declares `__islands_extension`, whose default export is the extension definition.

Portability means the artifact and JSON protocol are shared. It does not mean every embedding application exposes the same APIs. A host must provide and grant an artifact's required methods. File paths, database objects, DOM nodes, callbacks, and native handles do not cross the JSON boundary.

## Lifecycle and asynchronous work

1. **Load:** validate the artifact, policy, and required grants; instantiate WASM; evaluate the bundle; call `activate(ctx)`.
2. **Activate:** the extension registers handlers with `ctx.handle` and event subscribers with `ctx.on`. Activation may await host calls and may return a cleanup function.
3. **Operate:** the host calls `extension.invoke` or `extension.emit`. The extension can `await ctx.call(...)` to request a host capability. Its heap and closure state persist between operations.
4. **Dispose:** run bounded guest cleanup, release registrations, abort pending host work, and destroy the instance. Late host callback results are discarded.

An `invoke` waits for its handler's result. An `emit` waits for the subscribed event work to finish. A guest host-call Promise settles when the host sends a success or error result and pumps guest jobs.

Adapters serialize entry into an instance. Host callbacks run asynchronously outside the WASM execution lock, so they can perform I/O while the guest awaits a result. This does not turn a logical operation into a database transaction, nor make overlapping operations safe for every stateful extension. Applications that need strict business-level ordering should await operations in that order.

A host callback must not await a new invocation of the same extension unless its adapter explicitly supports that reentrancy. Return the callback's result first; then schedule subsequent extension work from the host.

## State and failure

Guest memory belongs to the loaded instance. Disposing, restarting, or replacing it loses that memory. Persistence is an application API—such as `state.read` and `state.write`—backed by host storage and host-enforced tenant/extension scoping. Islands does not provide an automatic heap snapshot or storage service.

Application handler errors are ordinary operation errors. Engine failures, including an exhausted execution budget, poison the instance and trigger disposal rather than letting the host reuse a potentially invalid runtime. Hosts should report the failure and decide whether loading a fresh instance is appropriate. Retry policies must account for host-side effects that may already have happened.

## Further reading

- [Embedding](embedding.md) for capabilities and lifecycle in application code.
- [Security](security.md) for the exact meaning of grants and limits.
- [QuickJS C API](https://bellard.org/quickjs/quickjs.html#QuickJS-C-API) for upstream engine concepts. Islands exposes a deliberately narrower environment than the QuickJS command-line tools.
