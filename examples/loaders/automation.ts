import type { ExtensionArtifact, JsonValue } from "@islands/protocol";
import { bundleSource } from "@islands/tooling";
import { parseDocument } from "yaml";

const methods = new Set(["records.create", "notifications.send", "deployments.create", "log.write"]);
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const reference = /^(?:[a-zA-Z_][a-zA-Z0-9_]*)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

type Automation = {
  id: string;
  name: string;
  description: string;
  event: string;
  steps: { call: string; input: JsonValue }[];
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new Error(`${path} must be a non-empty string (up to 500 characters)`);
  }
  return value;
}

function template(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 16) throw new Error(`${path} exceeds the template depth limit`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`${path} must be finite and use safe integers; encode larger identifiers as strings`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => template(item, `${path}[${index}]`, depth + 1));
  const record = object(value, path);
  const entries = Object.entries(record);
  const marker = entries.find(([key]) => key.startsWith("$"));
  if (marker) {
    const [key, field] = marker;
    if (entries.length !== 1 || !["$event", "$config"].includes(key) || typeof field !== "string" || !reference.test(field) || field.split(".").some((part) => forbiddenKeys.has(part))) {
      throw new Error(`${path} references must be exactly { $event: "field.path" } or { $config: "field.path" }`);
    }
    return { [key]: field };
  }
  return Object.fromEntries(entries.map(([key, item]) => {
    if (forbiddenKeys.has(key)) throw new Error(`${path}.${key} is not supported`);
    return [key, template(item, `${path}.${key}`, depth + 1)];
  }));
}

function validate(value: unknown): Automation {
  const spec = object(value, "automation");
  keys(spec, ["id", "name", "description", "event", "steps"], "automation");
  const id = text(spec.id, "id");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("id must be a lowercase identifier");
  if (!Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 16) {
    throw new Error("steps must contain between 1 and 16 capability calls");
  }
  return {
    id,
    name: text(spec.name, "name"),
    description: text(spec.description, "description"),
    event: text(spec.event, "event"),
    steps: spec.steps.map((value, index) => {
      const step = object(value, `steps[${index}]`);
      keys(step, ["call", "input"], `steps[${index}]`);
      const call = text(step.call, `steps[${index}].call`);
      if (!methods.has(call)) throw new Error(`Unsupported automation capability: ${call}`);
      return { call, input: template(step.input, `steps[${index}].input`) };
    }),
  };
}

// Only data is interpolated, via a JSON string literal. References are resolved
// by this fixed interpreter INSIDE the guest, never evaluated by the host.
function compile(spec: Automation): Promise<ExtensionArtifact> {
  const encoded = JSON.stringify(JSON.stringify(spec));
  return bundleSource({
    loader: "js",
    manifest: { id: spec.id, name: spec.name, description: spec.description, version: "1.0.0", requires: [...new Set(spec.steps.map((step) => step.call))] },
    source: `
      const spec = JSON.parse(${encoded});
      function resolve(value, event, config) {
        if (value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(item => resolve(item, event, config));
        const marker = Object.keys(value).find(key => key === "$event" || key === "$config");
        if (marker) {
          let current = marker === "$event" ? event : config;
          for (const part of value[marker].split(".")) {
            if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
              throw new Error("Missing template reference: " + marker + "." + value[marker]);
            }
            current = current[part];
          }
          return current;
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, event, config)]));
      }
      export default {
        activate(ctx) {
          let runs = 0;
          let last = null;
          ctx.on(spec.event, async event => {
            // Resolve all inputs before producing any side effects.
            const inputs = spec.steps.map(step => resolve(step.input, event, ctx.config));
            const results = [];
            for (let i = 0; i < spec.steps.length; i++) results.push(await ctx.call(spec.steps[i].call, inputs[i]));
            runs += 1;
            last = { event: spec.event, results };
          });
          ctx.handle("automation.status", () => ({ runs, last }));
        }
      };
    `,
  });
}

export async function compileAutomation(source: string, format: "yaml" | "json"): Promise<ExtensionArtifact> {
  if (new TextEncoder().encode(source).length > 64 * 1024) throw new Error("Automation source exceeds 64 KiB");
  if (format === "json") return compile(validate(JSON.parse(source)));
  const document = parseDocument(source, { version: "1.2", schema: "core", strict: true, uniqueKeys: true, stringKeys: true });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) throw new Error(`Invalid automation YAML: ${issue.message}`);
  return compile(validate(document.toJS({ maxAliasCount: 0 })));
}
