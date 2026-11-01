import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntime } from "@islands/runtime";
import type { HostContract, JsonValue } from "@islands/protocol";
import { examples } from "./catalog.ts";
import { extensionDirectory, wasmPath } from "./paths.ts";

export interface Activity {
  id: number;
  time: string;
  kind: "capability" | "invoke" | "event" | "error";
  extensionId: string;
  method: string;
  value: JsonValue;
}

const stringSchema = { type: "string", minLength: 1, maxLength: 1000 };
const inputSchema = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

// Host contracts validate at the capability boundary, outside guest memory.
const contract: HostContract = {
  name: "islands-demo", version: "1.0.0",
  methods: {
    "log.write": { input: inputSchema({ message: stringSchema }), output: { type: "null" } },
    "editor.read": { input: { type: "null" }, output: inputSchema({ text: { type: "string" } }) },
    "records.create": { input: inputSchema({ title: stringSchema, priority: { enum: ["low", "normal", "high"] } }), output: { type: "object" } },
    "notifications.send": { input: inputSchema({ channel: stringSchema, message: stringSchema }), output: { type: "object" } },
    "deployments.create": { input: inputSchema({ service: stringSchema, revision: stringSchema, environment: stringSchema }), output: { type: "object" } },
  },
};

function fields(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

function retain<T>(items: T[], item: T): T {
  items.push(item);
  if (items.length > 100) items.shift();
  return item;
}

export async function createDemo() {
  let document = "Islands lets an application expose a small set of capabilities. Extensions run inside WebAssembly and keep their own state.";
  let sequence = 0;
  let resourceId = 0;
  const activity: Activity[] = [];
  const records: JsonValue[] = [];
  const notifications: JsonValue[] = [];
  const deployments: JsonValue[] = [];
  const record = (kind: Activity["kind"], extensionId: string, method: string, value: JsonValue) => {
    retain(activity, { id: ++sequence, time: new Date().toISOString(), kind, extensionId, method, value });
  };
  const wasm = new Uint8Array(await readFile(wasmPath));
  const runtime = await createRuntime({
    wasm, contract, limits: { timeoutMs: 5000 },
    capabilities: {
      "log.write": (input, ctx) => {
        ctx.signal.throwIfAborted();
        record("capability", ctx.extensionId, "log.write", input);
        return null;
      },
      "editor.read": (_input, ctx) => {
        ctx.signal.throwIfAborted();
        record("capability", ctx.extensionId, "editor.read", { characters: document.length });
        return { text: document };
      },
      "records.create": (input, ctx) => {
        ctx.signal.throwIfAborted();
        if (ctx.metadata.workspaceId !== "demo-workspace") throw new Error("Workspace access denied");
        const data = fields(input);
        const item = retain(records, { id: `task-${++resourceId}`, title: data.title, priority: data.priority, workspaceId: ctx.metadata.workspaceId });
        record("capability", ctx.extensionId, "records.create", item);
        return item;
      },
      "notifications.send": (input, ctx) => {
        ctx.signal.throwIfAborted();
        const data = fields(input);
        if (data.channel !== ctx.metadata.channel) throw new Error("Channel access denied");
        const item = retain(notifications, { id: `notice-${++resourceId}`, channel: data.channel, message: data.message });
        record("capability", ctx.extensionId, "notifications.send", item);
        return item;
      },
      "deployments.create": (input, ctx) => {
        ctx.signal.throwIfAborted();
        const data = fields(input);
        if (data.environment !== ctx.metadata.environment) throw new Error("Environment access denied");
        const item = retain(deployments, { id: `deployment-${++resourceId}`, service: data.service, revision: data.revision, environment: data.environment, status: "registered", projectId: ctx.metadata.projectId });
        record("capability", ctx.extensionId, "deployments.create", item);
        return item;
      },
    },
  });
  const installed = new Map<string, Awaited<ReturnType<typeof runtime.load>>>();
  try {
    for (const example of examples) {
      const artifact = JSON.parse(await readFile(join(extensionDirectory, `${example.manifest.id}.json`), "utf8"));
      const extension = await runtime.load(artifact, {
        policy: "sandboxed", grants: example.grants, config: example.config,
        // Identity and resource scopes belong to the host, never the artifact.
        metadata: { workspaceId: "demo-workspace", projectId: "demo-project", environment: "preview", channel: example.manifest.id === "ticket-workflow" ? "support" : "releases" },
      });
      installed.set(example.manifest.id, extension);
    }
  } catch (error) {
    await runtime.dispose();
    throw error;
  }

  return {
    list: () => examples,
    snapshot: () => structuredClone({ document, records, notifications, deployments, activity }),
    setDocument(text: string) {
      if (text.length > 20_000) throw new Error("Document is limited to 20,000 characters");
      document = text;
    },
    async execute(id: string, kind: "invoke" | "event", method: string, input: JsonValue = null): Promise<JsonValue> {
      const extension = installed.get(id);
      if (!extension) throw new Error(`Extension not installed: ${id}`);
      const example = examples.find((item) => item.manifest.id === id)!;
      if (!example.actions.some((action) => action.kind === kind && action.method === method)) {
        throw new Error(`Unknown ${kind} action: ${method}`);
      }
      try {
        if (kind === "invoke") {
          const result = await extension.invoke(method, input);
          record("invoke", id, method, result);
          return result;
        }
        await extension.emit(method, input);
        const result = await extension.invoke(id === "editor-assistant" ? "editor.stats" : "automation.status");
        record("event", id, method, result);
        return result;
      } catch (error) {
        record("error", id, method, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    dispose: () => runtime.dispose(),
  };
}

export type Demo = Awaited<ReturnType<typeof createDemo>>;
export type DemoSnapshot = ReturnType<Demo["snapshot"]>;
