import type { ExtensionArtifact, JsonValue } from "@islands/protocol";
import { IslandsError } from "./errors.ts";
import { encoder, freezeJson, json, name, record } from "./json.ts";
import type { Capabilities, Capability, LoadOptions, RuntimeLimits } from "./types.ts";

export const DEFAULT_LIMITS: Readonly<Required<RuntimeLimits>> = Object.freeze({
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  fuel: 10_000,
  timeoutMs: 5_000,
  maxPendingCalls: 64,
});

export function limits(input: RuntimeLimits = {}): Readonly<Required<RuntimeLimits>> {
  if (!record(input)) throw new IslandsError("INVALID_LIMITS", "Limits must be an object");
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(result, key)) throw new IslandsError("INVALID_LIMITS", `Unknown limit: ${key}`);
    if (value === undefined) continue;
    const maximum = key === "memoryBytes" ? 128 * 1024 * 1024 : key === "stackBytes" ? 1024 * 1024 : 0x7fffffff;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new IslandsError("INVALID_LIMITS", `${key} must be an integer from 1 to ${maximum}`);
    }
    result[key as keyof RuntimeLimits] = value;
  }
  return Object.freeze(result);
}

export function capabilities(input: Capabilities = {}): ReadonlyMap<string, Capability> {
  if (!record(input)) throw new IslandsError("INVALID_INPUT", "Capabilities must be an object");
  const result = new Map<string, Capability>();
  for (const [method, fn] of Object.entries(input)) {
    name(method, "Capability name");
    if (typeof fn !== "function") throw new IslandsError("INVALID_INPUT", `Capability ${method} must be a function`);
    result.set(method, fn);
  }
  return result;
}

function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new IslandsError("INVALID_INPUT", `${label} must be an array`);
  return value.map((entry) => { name(entry, label); return entry; });
}

export function artifact(input: ExtensionArtifact): ExtensionArtifact {
  if (!record(input) || input.formatVersion !== 1 || !record(input.manifest) || typeof input.code !== "string") {
    throw new IslandsError("INVALID_ARTIFACT", "Expected a version 1 extension artifact");
  }
  const manifest = input.manifest;
  name(manifest.id, "Extension id");
  for (const key of ["name", "version", "description"] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      throw new IslandsError("INVALID_ARTIFACT", `Manifest ${key} must be a string`);
    }
  }
  if (encoder.encode(input.code).length > 16 * 1024 * 1024) throw new IslandsError("ARTIFACT_LIMIT", "Extension code exceeds 16 MiB");
  return {
    formatVersion: 1,
    manifest: { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description,
      requires: manifest.requires === undefined ? [] : names(manifest.requires, "Required capabilities") },
    code: input.code,
  };
}

export interface LoadSettings {
  grants: ReadonlySet<string>;
  config: JsonValue;
  metadata: Readonly<Record<string, JsonValue>>;
}

export function loadSettings(input: LoadOptions = {}, available: ReadonlyMap<string, Capability>, required: string[]): LoadSettings {
  if (!record(input)) throw new IslandsError("INVALID_INPUT", "Load options must be an object");
  const policy = input.policy === undefined ? "sandboxed" : input.policy;
  if (policy !== "sandboxed" && policy !== "trusted") throw new IslandsError("INVALID_POLICY", "Policy must be sandboxed or trusted");
  const requested = input.grants === undefined ? [] : names(input.grants, "Grants");
  for (const method of requested) {
    if (!available.has(method)) throw new IslandsError("UNKNOWN_CAPABILITY", `Unknown capability: ${method}`);
  }
  const grants = new Set(policy === "trusted" ? available.keys() : requested);
  for (const method of required) {
    if (!available.has(method) || !grants.has(method)) throw new IslandsError("MISSING_CAPABILITY", `Required capability is not granted: ${method}`);
  }
  const metadata = json(input.metadata === undefined ? {} : input.metadata);
  if (!record(metadata)) throw new IslandsError("INVALID_INPUT", "Metadata must be a JSON object");
  return { grants, config: json(input.config), metadata: freezeJson(metadata as Record<string, JsonValue>) };
}
