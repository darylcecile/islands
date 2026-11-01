# @islands/tooling

Build portable Islands artifacts and TypeScript host method maps. Version 0.1.0,
MIT. These are Node/Bun **authoring tools**, separate from the WASM runtime.

## Bundle an extension

```ts
import { writeFile } from "node:fs/promises";
import { bundleExtension, bundleSource } from "@islands/tooling";

const manifest = {
  id: "greeter",
  version: "1.0.0",
  requires: ["log.write"],
};

const artifact = await bundleExtension({
  entrypoint: "./greeter.ts",
  manifest,
});
await writeFile("greeter.island.json", JSON.stringify(artifact));

const generated = await bundleSource({
  loader: "js", // "ts" is also supported
  manifest: { id: "generated-greeter" },
  source: `
    import { defineExtension } from "@islands/sdk";
    export default defineExtension({
      activate(ctx) {
        ctx.handle("greet", () => ({ greeting: "Hello" }));
      }
    });
  `,
});
```

Both functions return `Promise<ExtensionArtifact>`:

```ts
{
  formatVersion: 1,
  manifest: { id: "greeter", version: "1.0.0", requires: ["log.write"] },
  code: "var __islands_extension = (() => { /* bundled modules */ })();"
}
```

The bundle is a single browser-targeted ES2022 IIFE with global name
`__islands_extension`. Its default export must be an object with `activate(ctx)`;
the guest checks that definition at activation. Imports, including
`@islands/sdk`, are bundled. Extension code is never imported or evaluated by the
tooling process. Node built-ins are unavailable in a browser-targeted bundle.
Browser targeting does not install browser APIs inside QuickJS: use `ctx.call`
for host services instead of `fetch`, DOM APIs, timers, or filesystem access.

`bundleSource({ source, loader, manifest, resolveDir? })` resolves relative and
package imports against `resolveDir`, defaulting to the current working directory.
`bundleExtension({ entrypoint, manifest })` resolves file imports normally.
Both snapshot and validate the manifest before compilation. Build diagnostics
reject the Promise. Tooling does not decide grants or evaluate host policies.

### Manifests

`validateManifest(value: unknown): ExtensionManifest` validates an object and
returns an independent JSON snapshot. Parse a JSON file with `JSON.parse` first.
An ID must be a non-empty string. Optional `name`, `version`, and `description`
must be strings. Optional `requires` is an array of unique, non-empty capability
names. Unknown fields, non-JSON data, sparse arrays, and cycles are rejected.
JSON numbers must be finite, and integers must be within
`[-9007199254740991, 9007199254740991]`. Use strings for larger IDs. The same
numeric rules apply to JSON data in host contracts, including schema bounds and
examples; TypeScript's `number` type does not enforce these runtime limits.

## Generate typed host calls

```ts
import { writeFile } from "node:fs/promises";
import { generateHostTypes } from "@islands/tooling";
import type { HostContract } from "@islands/protocol";

const contract: HostContract = {
  name: "Example host",
  version: "1",
  methods: {
    "log.write": {
      input: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
      output: { type: "null" },
    },
  },
};

await writeFile("host-methods.ts", await generateHostTypes(contract));
```

An extension imports `HostMethods` as a type and uses
`defineExtension<HostMethods>({ activate(ctx) { /* typed ctx.call */ } })`.
`generateHostTypes(contract, { typeName?: string }): Promise<string>` defaults to
the exported name `HostMethods`; custom names start with an uppercase letter and
contain only letters, numbers, or underscores. Internal `IslandsInputN`,
`IslandsOutputN`, `IslandsJson`, and `JsonValue` names are reserved.

Each method's input/output is a self-contained JSON Schema draft-07 schema. Omit
`$schema` to use that default, or declare `http://json-schema.org/draft-07/schema#`
(the trailing `#` is optional). Explicit other dialects are rejected during type
generation, matching the runtime's draft-07 contract. Boolean schemas and local
JSON Pointer `$ref`s work; external filesystem/HTTP references are disabled.
The generator uses `json-schema-to-typescript` and isolates each schema's named
types to avoid collisions. Unconstrained schema values become `JsonValue`, not
arbitrary JavaScript values. Its generated map is suitable for the SDK even when
schemas use named interfaces and optional properties.

These generated types are an authoring aid, **not runtime validation**. JSON Schema
constraints such as numeric ranges, string patterns, and formats cannot all be
represented in TypeScript. Esbuild transpiles TypeScript without checking types.
Use `tsc --noEmit` during authoring; give the original contract to the host runtime
to validate actual capability inputs and results. Keep executable schema extensions
such as `tsType` out of portable contracts.

## CLI

After building the workspace, the `islands` executable uses the same APIs:

```sh
islands build ./greeter.ts --manifest ./manifest.json --out ./greeter.island.json
islands types ./host-contract.json --out ./host-methods.ts --name HostMethods
```

From the checkout, run `bun packages/tooling/src/cli.ts …`, or after the root build
run `node packages/tooling/dist/cli.js …`. Output parent directories must already
exist. Invalid arguments, JSON, schemas, and build errors print a diagnostic and
exit nonzero. The CLI writes artifacts and generated types; it never loads an
extension runtime.
