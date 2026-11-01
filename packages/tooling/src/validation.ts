import type { ExtensionManifest, HostContract, JsonValue } from "@islands/protocol";

/** Clone plain JSON data, rejecting values JSON.stringify would silently change. */
function json(value: unknown, path: string, parents = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite JSON number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} must be a safe integer in [-9007199254740991, 9007199254740991]; use strings for larger IDs`);
    }
    return value;
  }
  if (typeof value !== "object" || value === null) throw new TypeError(`${path} must be JSON data`);
  if (parents.has(value)) throw new TypeError(`${path} contains a circular reference`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain JSON object`);
  }
  parents.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new TypeError(`${path} contains a symbol key`);
    }
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError(`${path} must be a dense JSON array`);
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[index];
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path}[${index}] must be JSON data`);
        return json(descriptor.value, `${path}[${index}]`, parents);
      });
    }
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${path}.${key} must be JSON data`);
      result[key] = json(descriptor.value, `${path}.${key}`, parents);
    }
    return result;
  } finally {
    parents.delete(value);
  }
}

function object(value: JsonValue | undefined, path: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function nonempty(value: JsonValue | undefined, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path} must be a non-empty string`);
}

/** Validate and snapshot an artifact manifest without evaluating extension code. */
export function validateManifest(value: unknown): ExtensionManifest {
  const manifest = object(json(value, "manifest"), "manifest");
  const allowed = new Set(["id", "name", "version", "description", "requires"]);
  for (const key of Object.keys(manifest)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown manifest field: ${key}`);
  }
  nonempty(manifest.id, "manifest.id");
  const result: ExtensionManifest = { id: manifest.id };
  for (const key of ["name", "version", "description"] as const) {
    if (key in manifest) {
      if (typeof manifest[key] !== "string") throw new TypeError(`manifest.${key} must be a string`);
      result[key] = manifest[key];
    }
  }
  if ("requires" in manifest) {
    if (!Array.isArray(manifest.requires)) throw new TypeError("manifest.requires must be an array");
    const requires = manifest.requires.map((method, index) => {
      nonempty(method, `manifest.requires[${index}]`);
      return method;
    });
    if (new Set(requires).size !== requires.length) throw new TypeError("manifest.requires contains duplicate methods");
    result.requires = requires;
  }
  return result;
}

export function validateContract(value: unknown): HostContract {
  const contract = object(json(value, "contract"), "contract");
  nonempty(contract.name, "contract.name");
  nonempty(contract.version, "contract.version");
  const methods = object(contract.methods, "contract.methods");
  for (const [name, value] of Object.entries(methods)) {
    nonempty(name, "contract method name");
    const method = object(value, `contract.methods[${JSON.stringify(name)}]`);
    if ("description" in method && typeof method.description !== "string") {
      throw new TypeError(`Description for ${name} must be a string`);
    }
    for (const field of ["input", "output"] as const) {
      if (typeof method[field] === "boolean") continue;
      const schema = object(method[field], `${name}.${field} schema`);
      if ("$schema" in schema && schema.$schema !== "http://json-schema.org/draft-07/schema#" && schema.$schema !== "http://json-schema.org/draft-07/schema") {
        throw new TypeError(`${name}.${field} schema must use JSON Schema draft-07`);
      }
    }
  }
  return contract as unknown as HostContract;
}
