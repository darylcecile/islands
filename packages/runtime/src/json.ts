import type { GuestMessage, JsonValue } from "@islands/protocol";
import { IslandsError } from "./errors.ts";

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const encoder = new TextEncoder();

export function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1024) {
    throw new IslandsError("INVALID_INPUT", `${label} must be a nonempty string of at most 1024 characters`);
  }
}

/** Copy data properties without calling getters or toJSON, or silently dropping values. */
function copy(value: unknown, ancestors: Set<object>, depth: number): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value !== "object" || value === null || depth > 128 || ancestors.has(value)) {
    throw new IslandsError("INVALID_JSON", "Expected acyclic JSON data with finite numbers and safe integers (maximum depth 128)");
  }
  const array = Array.isArray(value);
  if (!array && !record(value)) throw new IslandsError("INVALID_JSON", "Expected a plain JSON object");
  const result: JsonValue[] | Record<string, JsonValue> = array ? [] : {};
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) {
    throw new IslandsError("INVALID_JSON", "Sparse arrays and extra array properties are not JSON data");
  }
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new IslandsError("INVALID_JSON", "JSON data must have enumerable string-keyed data properties");
    }
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw new IslandsError("INVALID_JSON", "Extra array properties are not JSON data");
    }
    Object.defineProperty(result, key, {
      value: copy(descriptor.value, ancestors, depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  ancestors.delete(value);
  return result;
}

export function encode(value: unknown, maximum = MAX_MESSAGE_BYTES): string {
  const text = JSON.stringify(value);
  if (encoder.encode(text).length > maximum) throw new IslandsError("MESSAGE_LIMIT", "JSON message is too large");
  return text;
}

export function json(value: unknown): JsonValue {
  const result = copy(value === undefined ? null : value, new Set(), 0);
  encode(result);
  return result;
}

export function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function guestMessage(text: string): GuestMessage {
  try {
    const message: unknown = JSON.parse(text);
    if (!record(message)) throw new Error();
    name(message.id, "Request id");
    if (message.type === "call" && /^g.+/.test(message.id)) {
      name(message.method, "Capability name");
      return { type: "call", id: message.id, method: message.method, input: json(message.input) };
    }
    if (message.type === "result" && /^h.+/.test(message.id)) {
      if (message.ok === true) return { type: "result", id: message.id, ok: true, value: json(message.value) };
      if (message.ok === false && record(message.error)) {
        name(message.error.code, "Error code");
        if (typeof message.error.message !== "string") throw new Error();
        return { type: "result", id: message.id, ok: false, error: { code: message.error.code, message: message.error.message } };
      }
    }
  } catch (cause) {
    throw new IslandsError("PROTOCOL_ERROR", "Invalid guest message", { cause });
  }
  throw new IslandsError("PROTOCOL_ERROR", "Invalid guest message");
}
