# @islands/sdk

The author API for JavaScript and TypeScript extensions. Version 0.1.0, MIT.
`defineExtension` returns its argument unchanged. The Islands WASM guest bridge
creates the live context; importing this package never starts a runtime.

```ts
import { defineExtension } from "@islands/sdk";

type HostMethods = {
  "log.write": {
    input: { message: string };
    output: null;
  };
};

export default defineExtension<HostMethods>({
  async activate(ctx) {
    await ctx.call("log.write", { message: "Activated" });

    const stopMethod = ctx.handle("greet", (input) => {
      const who = typeof input === "string" ? input : "world";
      return { greeting: `Hello, ${who}` };
    });
    const stopEvent = ctx.on("refresh", async () => {
      await ctx.call("log.write", { message: "Refreshed" });
    });

    return () => {
      stopMethod();
      stopEvent();
    };
  },
});
```

## API

- `defineExtension<Methods extends MethodMap>(definition)` is a typed identity.
  `MethodMap` maps capability names to `{ input: JsonValue; output: JsonValue }`.
  Its default permits arbitrary capability names with JSON inputs and outputs.
- `activate(ctx)` returns nothing, a cleanup function, or a Promise of either.
  Cleanup may return a Promise and is awaited on disposal.
- `ctx.config: JsonValue` is the host's configuration, or `null` when omitted.
- `ctx.call(name, input?)` returns a Promise of the declared host method's output.
  With a typed method map, names and arguments are checked and the output type is
  inferred. Input may be omitted only when its type includes `null`.
- `ctx.handle(name, handler)` registers a method callable by the host. The handler
  receives JSON and may return JSON, nothing, or a Promise of either. Duplicate
  method registration throws. Unsubscribe before replacing a handler.
- `ctx.on(name, handler)` subscribes to an event. Subscribers run in registration
  order and are awaited; a failure stops that emission and is returned to the
  host. Emitting with no subscribers succeeds. Each registration is independent.
- `handle` and `on` return idempotent unsubscribe functions. Removing an old
  registration never removes a later replacement.

The context object is frozen. Its configuration data belongs to the guest and may
be modified locally. Registration is allowed during activation and while active.
Invocation and events require successful activation. Disposal rejects outstanding
host-call Promises with code `DISPOSED`, then awaits cleanup and releases all
registrations. Cleanup may make new awaited host calls; host deadlines still
bound cleanup. Failed activation releases registrations and pending requests.

## Types and runtime validation

TypeScript catches authoring mistakes; it does **not** validate live data. Esbuild
strips types without typechecking them. Run `tsc --noEmit` in your extension project
and generate your method map from the host's `HostContract` using
`@islands/tooling` to keep it aligned with the actual API. Plain JavaScript may use
the same identity function and context without type annotations.

The guest bridge validates boundary values. JSON means `null`, booleans, strings,
finite numbers, dense arrays, and plain objects containing JSON values. Integers
must be within `[-9007199254740991, 9007199254740991]`; represent larger IDs as
strings. TypeScript's `number` type cannot enforce finiteness or this safe-integer
range, so these checks happen at runtime. Functions,
`bigint`, symbols, accessors, `Date`, circular objects, and nested `undefined` are
rejected rather than silently altered by `JSON.stringify`. An omitted top-level
input or handler result becomes `null`. Handler failures and host-call failures
are ordinary errors, with useful `code` and `message` fields on the wire.

Host contracts are portable JSON Schema draft-07 data, not executable validators. Host
adapters validate inputs/results and enforce capability grants, extension identity,
pending-call bounds, and deadlines outside guest memory. SDK types and guest
checks are not authorization. The guest has no ambient filesystem or network API;
extensions request effects through `ctx.call`.

Exports include `ExtensionContext`, `ExtensionDefinition`, `MethodMap`, `Handler`,
`EventHandler`, `Cleanup`, and `Unsubscribe`, plus the protocol types `JsonValue`,
`JsonSchema`, `MethodSchema`, `HostContract`, `ExtensionManifest`, and
`ExtensionArtifact`.
