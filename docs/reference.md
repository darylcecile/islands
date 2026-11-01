# API reference

This page covers the public JavaScript APIs. For a walkthrough, use [authoring](authoring.md) or [embedding](embedding.md). For native conventions, see [`sdk/go/`](../sdk/go/) and [`sdk/python/`](../sdk/python/). Adapter implementers should use the [portable protocol](protocol.md).

## `@islands/sdk`

### `defineExtension(definition)`

```ts
defineExtension<Methods extends MethodMap = MethodMap>(
  definition: ExtensionDefinition<Methods>,
): ExtensionDefinition<Methods>
```

A typed identity function. The definition must be the entry module's default export. Live context behavior is supplied by the WASM guest bridge.

```ts
interface ExtensionDefinition<Methods extends MethodMap = MethodMap> {
  activate(context: ExtensionContext<Methods>):
    void | Cleanup | Promise<void | Cleanup>;
}

type Cleanup = () => void | Promise<void>;
type MethodMap = Record<string, { input: JsonValue; output: JsonValue }>;
```

### Extension context

| Member | Behavior |
| --- | --- |
| `config` | Read-only context property containing host-provided JSON configuration. |
| `call(method, input?)` | Returns a Promise of the host capability's JSON result. Generated method types constrain names, input, and output. Input may be omitted only when the method's input type accepts `null`. |
| `handle(method, handler)` | Register one handler for a host-invoked method; returns an idempotent unregister function. Duplicate registrations throw. |
| `on(event, listener)` | Subscribe to a host event; returns an idempotent unsubscribe function. |

```ts
type Handler = (input: JsonValue) =>
  JsonValue | void | Promise<JsonValue | void>;
type EventHandler = (payload: JsonValue) => void | Promise<void>;
```

## `@islands/runtime`

### `createRuntime(options)`

`createRuntime(options: RuntimeOptions): Promise<Runtime>` compiles the supplied core once. Each later `load` creates a separate WASM instance from that compiled module.

```ts
interface RuntimeOptions {
  wasm: Uint8Array | WebAssembly.Module;
  capabilities?: Record<string, Capability>;
  contract?: HostContract;
  limits?: RuntimeLimits;
}

type Capability = (input: JsonValue, context: CapabilityContext) =>
  JsonValue | void | Promise<JsonValue | void>;

interface CapabilityContext {
  readonly extensionId: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
}
```

- `wasm`: the trusted core bytes or compiled module. The SDK does not fetch it for you.
- `capabilities`: callable application operations. No methods are available by default.
- `contract`: optional JSON Schema draft-07 validation for host capability inputs and outputs. When supplied, a called capability must appear in `contract.methods` as well as the registered/granted capability maps. Async schemas and unsupported explicit dialects are rejected.
- `limits`: per-instance resource configuration.

### `runtime.load(artifact, options?)`

```ts
interface LoadOptions {
  grants?: string[];
  policy?: "sandboxed" | "trusted";
  config?: JsonValue;
  metadata?: Record<string, JsonValue>;
}
```

Returns `Promise<LoadedExtension>` after successful activation. Validates required capabilities before evaluating the bundle. IDs must be unique within a runtime.

| Option | Default | Meaning |
| --- | --- | --- |
| `policy` | `"sandboxed"` | Explicit grants, or `"trusted"` for all registered capabilities. |
| `grants` | `[]` | Allowed capability names under sandboxed policy. |
| `config` | `null` | JSON made available as `ctx.config`. |
| `metadata` | `{}` | Host-bound context for capability callbacks; not exposed as a guest context property. |

Unknown policy values fail. `trusted` retains the WASM boundary and configured limits. Neither policy infers grants from the artifact or guest messages.

### Loaded extension

```ts
interface LoadedExtension {
  readonly id: string;
  invoke(method: string, input?: JsonValue): Promise<JsonValue>;
  emit(event: string, payload?: JsonValue): Promise<void>;
  dispose(): Promise<void>;
}
```

- `invoke`: await the registered guest handler and return its JSON result.
- `emit`: deliver to guest subscribers and await completion.
- `dispose`: run bounded cleanup and release this instance's resources.
- `runtime.dispose()`: dispose all instances owned by the runtime.

Missing optional input/payload and `void` handler results normalize to `null` on the wire. An event acknowledgement carries `null` internally; the JavaScript `emit` API returns `void`.

### Errors

The runtime exports `IslandsError`, an `Error` with a string `code`. Handle errors at the operation boundary and report context useful to your application:

```ts
import { IslandsError } from "@islands/runtime";

try {
  await extension.invoke("greet", { name: "Ada" });
} catch (error) {
  if (error instanceof IslandsError) {
    console.error(error.code, error.message);
  }
  throw error;
}
```

Common codes include `MISSING_CAPABILITY` at load, `CAPABILITY_DENIED` for an unauthorized guest call, `METHOD_NOT_FOUND` for a missing guest handler, `INVALID_ARGUMENT`/`INVALID_RESULT` for capability schema failures, and `DISPOSED` for operations on a closed instance. `FUEL_EXHAUSTED`, `MEMORY_LIMIT`, `STACK_LIMIT`, and `TIMEOUT` indicate resource failures.

Ordinary handler errors reject the operation. Engine failures and timeouts close the instance; load a fresh one only when your application's recovery policy allows it. Error codes alone are not proof of where an error originated: guest errors also travel over the bridge. Runtime-wide disposal attempts all instances and can reject with an `AggregateError` when cleanup fails.

### Runtime limits

```ts
interface RuntimeLimits {
  memoryBytes?: number;      // default: 16 * 1024 * 1024
  stackBytes?: number;       // default: 512 * 1024
  fuel?: number;             // default: 10_000
  timeoutMs?: number;        // default: 5_000
  maxPendingCalls?: number;  // default: 64
}
```

JavaScript limits must be positive integers. `memoryBytes` is at most 128 MiB and `stackBytes` is at most 1 MiB; the other configurable values are at most 2,147,483,647. Omitting a property uses its default. Setting zero does not disable a limit.

Fuel is a fresh budget of QuickJS interrupt callbacks for each core eval/dispatch/step. It is not elapsed time or WASM instruction fuel. See [security](security.md#limits-measure-different-things) for accounting and host-resource responsibilities.

## `@islands/tooling`

### `bundleExtension({ entrypoint, manifest })`

```ts
bundleExtension(options: {
  entrypoint: string;
  manifest: ExtensionManifest;
}): Promise<ExtensionArtifact>
```

Bundles a JavaScript/TypeScript file and its imports into one IIFE defining `__islands_extension`. It returns the artifact; the caller decides where to write it. Compilation does not evaluate the extension in the host.

### `bundleSource({ source, loader, manifest, resolveDir? })`

```ts
bundleSource(options: {
  source: string;
  loader: "ts" | "js";
  manifest: ExtensionManifest;
  resolveDir?: string;
}): Promise<ExtensionArtifact>
```

Bundles supplied source text. `resolveDir` controls relative/package import resolution and defaults to the host process's current working directory. The loader selects TypeScript or JavaScript parsing; YAML/JSON semantics belong in an application-specific loader before this step.

### Contracts and type generation

```ts
interface HostContract {
  name: string;
  version: string;
  methods: Record<string, {
    description?: string;
    input: JsonSchema;
    output: JsonSchema;
  }>;
}

generateHostTypes(
  contract: HostContract,
  options?: { typeName?: string },
): Promise<string>
```

The generator returns TypeScript source exporting a method map named `HostMethods` by default. Use a self-contained JSON Schema for each method input/output. Local JSON Pointer references are supported; generation does not resolve remote HTTP or filesystem references.

For example, save this as `scratch/host-contract.json`:

```json
{
  "name": "greeter-host",
  "version": "1.0.0",
  "methods": {
    "log.write": {
      "input": {
        "type": "object",
        "properties": { "message": { "type": "string", "maxLength": 1000 } },
        "required": ["message"],
        "additionalProperties": false
      },
      "output": { "type": "null" }
    }
  }
}
```

Generate types with the local CLI:

```sh
bun run packages/tooling/src/cli.ts types scratch/host-contract.json --out scratch/host-methods.ts
```

Then use the generated map in an extension:

```ts
import { defineExtension } from "@islands/sdk";
import type { HostMethods } from "./host-methods";

export default defineExtension<HostMethods>({
  activate(ctx) {
    ctx.handle("log.hello", async () => {
      await ctx.call("log.write", { message: "Hello from the extension" });
      return null;
    });
  },
});
```

Its manifest must require `log.write`. The contract also works with the host in the [embedding guide](embedding.md#validate-a-capability-contract). Generation currently targets TypeScript, not Go or Python. Regenerate when the host API changes, and retain runtime validation for untrusted JSON.

### Manifest validation and CLI

`validateManifest(value: unknown): ExtensionManifest` validates and copies a manifest without executing code. Supported fields are `id`, `name`, `version`, `description`, and `requires`. The manifest's ID and required method names must be nonempty; required method names must not repeat.

The checkout includes the CLI at `packages/tooling/src/cli.ts`. After building, the equivalent ESM entry point is `packages/tooling/dist/cli.js`:

```sh
bun run packages/tooling/src/cli.ts --help
bun run packages/tooling/src/cli.ts build scratch/greeter.ts --manifest scratch/manifest.json --out dist/extensions/my-greeter.json
bun run packages/tooling/src/cli.ts types scratch/host-contract.json --out scratch/host-methods.ts --name HostMethods
```

Create input files and output directories first. `manifest.json` holds the manifest object, not a complete artifact. These commands use the local CLI; they do not require a published package or a global `islands` command.

## Artifact and JSON types

```ts
type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ExtensionManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  requires?: string[];
}

interface ExtensionArtifact {
  formatVersion: 1;
  manifest: ExtensionManifest;
  code: string;
}
```

The TypeScript `number` type is broader than runtime JSON: numbers must be finite, and integers must be within ±9,007,199,254,740,991. Encode larger integer identifiers as strings to preserve them across JavaScript, Go, and Python. Nested `undefined`, functions, symbols, cyclic structures, and live objects are invalid boundary data. Use explicit encodings for dates and binary values.

The manifest version is application metadata; `formatVersion` versions the artifact shape, and the core's ABI version identifies its exported wire interface. The [protocol](protocol.md) defines the ABI and artifact requirements together.
