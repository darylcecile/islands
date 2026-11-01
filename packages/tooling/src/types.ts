import { compile } from "json-schema-to-typescript";
import type { HostContract, JsonSchema } from "@islands/protocol";
import { validateContract } from "./validation.js";

export interface GenerateHostTypesOptions {
  /** Name of the exported method map. Defaults to HostMethods. */
  typeName?: string;
}

async function schemaTypes(schema: JsonSchema): Promise<string> {
  if (typeof schema === "boolean") return `export type Value = ${schema ? "unknown" : "never"};\n`;
  return compile({ ...schema, title: "Value" }, "Value", {
    bannerComment: "",
    unknownAny: true,
    enableConstEnums: false,
    // A portable contract is self-contained. Local JSON Pointer refs are supported.
    $refOptions: { resolve: { file: false, http: false } },
  });
}

/** Generate author-time types; hosts still validate the contract at runtime. */
export async function generateHostTypes(
  value: HostContract,
  options: GenerateHostTypesOptions = {},
): Promise<string> {
  const contract = validateContract(value);
  const name = options.typeName ?? "HostMethods";
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name) || name === "JsonValue" || name === "IslandsJson") {
    throw new TypeError("typeName must start with an uppercase letter and use letters, digits, or underscores (except JsonValue and IslandsJson)");
  }
  const declarations: string[] = [];
  const members: string[] = [];
  for (const [index, [method, schema]] of Object.entries(contract.methods).entries()) {
    const input = `IslandsInput${index}`;
    const output = `IslandsOutput${index}`;
    if (name === input || name === output) throw new TypeError(`typeName ${name} is reserved by the generator`);
    const [inputTypes, outputTypes] = await Promise.all([schemaTypes(schema.input), schemaTypes(schema.output)]);
    declarations.push(`declare namespace ${input} {\n${inputTypes}}\n`, `declare namespace ${output} {\n${outputTypes}}\n`);
    members.push(`  ${JSON.stringify(method)}: { input: IslandsJson<${input}.Value>; output: IslandsJson<${output}.Value> };`);
  }
  return [
    "// Generated from an Islands HostContract. Regenerate when the contract changes.",
    'import type { JsonValue } from "@islands/sdk";',
    "",
    // Schema 'unknown' means any JSON value, not any JavaScript object. Mapping also
    // makes named interfaces structurally compatible with the SDK's JSON method map.
    "type IslandsJson<T> = unknown extends T ? JsonValue : T extends object ? { [K in keyof T]: IslandsJson<T[K]> } : T;",
    "",
    ...declarations,
    `export type ${name} = {`,
    ...members,
    "};",
    "",
  ].join("\n");
}
