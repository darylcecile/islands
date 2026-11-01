import Ajv, { type ValidateFunction } from "ajv";
import type { HostContract, JsonValue } from "@islands/protocol";
import { IslandsError } from "./errors.ts";
import { json, name, record } from "./json.ts";

export interface MethodValidators {
  input: ValidateFunction;
  output: ValidateFunction;
}

function compileSchema(ajv: Ajv, schema: unknown): ValidateFunction {
  if (typeof schema !== "boolean" && !record(schema)) throw new Error("Expected a draft-07 JSON Schema");
  if (record(schema) && schema.$schema !== undefined &&
      schema.$schema !== "http://json-schema.org/draft-07/schema#" && schema.$schema !== "http://json-schema.org/draft-07/schema") {
    throw new Error("Only JSON Schema draft-07 is supported");
  }
  const validate = ajv.compile(schema);
  if ("$async" in validate && validate.$async) throw new Error("Async schemas are not supported");
  return validate;
}

export function compileContract(contract?: HostContract): ReadonlyMap<string, MethodValidators> | undefined {
  if (contract === undefined) return undefined;
  try {
    const snapshot = json(contract);
    if (!record(snapshot) || !record(snapshot.methods)) throw new Error("Contract methods must be an object");
    name(snapshot.name, "Contract name");
    name(snapshot.version, "Contract version");
    const ajv = new Ajv({ strict: true, ownProperties: true, addUsedSchema: false });
    const methods = new Map<string, MethodValidators>();
    for (const [method, schema] of Object.entries(snapshot.methods)) {
      name(method, "Contract method");
      if (!record(schema)) throw new Error(`Invalid method schema: ${method}`);
      const input = compileSchema(ajv, schema.input);
      const output = compileSchema(ajv, schema.output);
      methods.set(method, { input, output });
    }
    return methods;
  } catch (cause) {
    throw new IslandsError("INVALID_CONTRACT", cause instanceof Error ? cause.message : "Invalid host contract", { cause });
  }
}

export function validate(validator: ValidateFunction | undefined, value: JsonValue, code: string): void {
  if (validator && !validator(value)) {
    const error = validator.errors?.[0];
    throw new IslandsError(code, `Contract validation failed${error ? ` at ${error.instancePath || "/"}: ${error.message}` : ""}`);
  }
}
