import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { promisify } from "node:util";
import { defineExtension } from "@islands/sdk";
import { bundleExtension, bundleSource, generateHostTypes, validateManifest } from "@islands/tooling";
import type { ExtensionArtifact, GuestMessage, HostMessage, WireResult } from "@islands/protocol";

const guestSource = await readFile(new URL("../core/guest.js", import.meta.url), "utf8");
const executeFile = promisify(execFile);

function bridge(artifact: ExtensionArtifact) {
  const messages: GuestMessage[] = [];
  const context = createContext({
    __islands_send(text: string) { messages.push(JSON.parse(text) as GuestMessage); },
  });
  runInContext(guestSource, context);
  runInContext(artifact.code, context);
  const send = (message: HostMessage) => {
    runInContext(`__islands_receive(${JSON.stringify(JSON.stringify(message))})`, context);
  };
  return {
    send,
    async result(id: string): Promise<WireResult> {
      await setImmediate();
      const index = messages.findIndex((message) => message.type === "result" && message.id === id);
      if (index < 0) throw new Error(`Missing result ${id}: ${JSON.stringify(messages)}`);
      return messages.splice(index, 1)[0] as WireResult;
    },
    async call() {
      await setImmediate();
      const index = messages.findIndex((message) => message.type === "call");
      if (index < 0) throw new Error(`Missing host call: ${JSON.stringify(messages)}`);
      return messages.splice(index, 1)[0] as Extract<GuestMessage, { type: "call" }>;
    },
  };
}

function source(code: string, loader: "ts" | "js" = "ts") {
  return bundleSource({ source: code, loader, manifest: { id: "sdk-test" } });
}

async function inTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "islands-sdk-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("author SDK and bundler", () => {
  test("defineExtension is a typed identity", () => {
    type Methods = {
      "sum": { input: { values: number[] }; output: number };
      "ping": { input: null; output: string };
    };
    const definition = defineExtension<Methods>({
      activate(ctx) {
        const total: Promise<number> = ctx.call("sum", { values: [1, 2] });
        const ping: Promise<string> = ctx.call("ping");
        void total;
        void ping;
        // @ts-expect-error Host method names are checked.
        ctx.call("missing", null);
        // @ts-expect-error A non-nullable input is required.
        ctx.call("sum");
        // @ts-expect-error Host input properties are checked.
        ctx.call("sum", { values: ["bad"] });
      },
    });
    expect(defineExtension<Methods>(definition)).toBe(definition);
  });

  test("bundles external entrypoints and dependencies without evaluating them", async () => {
    await inTemporaryDirectory(async (directory) => {
      await writeFile(join(directory, "answer.ts"), "export const answer: number = 42;");
      await writeFile(join(directory, "entry.ts"), `
        import { defineExtension } from "@islands/sdk";
        import { answer } from "./answer";
        export default defineExtension({ activate(ctx) { ctx.handle("answer", () => answer); } });
      `);
      const artifact = await bundleExtension({ entrypoint: join(directory, "entry.ts"), manifest: { id: "answer" } });
      expect(artifact.formatVersion).toBe(1);
      expect(artifact.manifest.id).toBe("answer");
      const guest = bridge(artifact);
      guest.send({ type: "activate", id: "h1", config: null });
      expect(await guest.result("h1")).toEqual({ type: "result", id: "h1", ok: true, value: null });
      guest.send({ type: "invoke", id: "h2", method: "answer", input: null });
      expect(await guest.result("h2")).toEqual({ type: "result", id: "h2", ok: true, value: 42 });
    });
    const artifact = await source('throw new Error("Runs only in the guest"); export default { activate() {} };', "js");
    expect(() => bridge(artifact)).toThrow("Runs only in the guest");
  });

  test("validates and snapshots portable JSON manifests", async () => {
    const manifest = { id: "valid", requires: ["log.write"] };
    const snapshot = validateManifest(manifest);
    manifest.requires.push("other");
    expect(snapshot).toEqual({ id: "valid", requires: ["log.write"] });
    expect(() => validateManifest({ id: "" })).toThrow("non-empty");
    expect(() => validateManifest({ id: "x", requires: ["same", "same"] })).toThrow("duplicate");
    expect(() => validateManifest({ id: "x", extra: true })).toThrow("Unknown manifest field");
    expect(() => validateManifest({ id: "x", version: undefined })).toThrow("JSON data");
    expect(() => validateManifest({ id: "x", version: Number.MAX_SAFE_INTEGER + 1 })).toThrow("safe integer");
    await expect(bundleSource({ source: "export default {}", loader: "ts", manifest: { id: "" } })).rejects.toThrow("manifest.id");
  });
});

describe("guest wire lifecycle", () => {
  test("awaits activation, host calls, events, and async cleanup", async () => {
    const guest = bridge(await source(`
      import { defineExtension } from "@islands/sdk";
      export default defineExtension({
        async activate(ctx) {
          const initial = await ctx.call("initialize", ctx.config);
          let seen = initial;
          ctx.handle("value", () => seen);
          ctx.handle("call", (input) => ctx.call("double", input));
          ctx.on("update", async (payload) => { seen = await ctx.call("double", payload); });
          return async () => { await ctx.call("cleanup"); };
        }
      });
    `));
    guest.send({ type: "activate", id: "h1", config: { seed: 3 } });
    const initial = await guest.call();
    expect(initial).toMatchObject({ type: "call", method: "initialize", input: { seed: 3 } });
    expect(initial.id).toMatch(/^g/);
    guest.send({ type: "result", id: initial.id, ok: true, value: 3 });
    expect(await guest.result("h1")).toMatchObject({ ok: true, value: null });
    guest.send({ type: "invoke", id: "h2", method: "call", input: 4 });
    const call = await guest.call();
    expect(call).toMatchObject({ method: "double", input: 4 });
    guest.send({ type: "result", id: call.id, ok: true, value: 8 });
    expect(await guest.result("h2")).toMatchObject({ ok: true, value: 8 });
    guest.send({ type: "event", id: "h3", event: "update", payload: 5 });
    const event = await guest.call();
    guest.send({ type: "result", id: event.id, ok: true, value: 10 });
    expect(await guest.result("h3")).toMatchObject({ ok: true, value: null });
    guest.send({ type: "invoke", id: "h4", method: "value", input: null });
    expect(await guest.result("h4")).toMatchObject({ ok: true, value: 10 });
    guest.send({ type: "dispose", id: "h5" });
    const cleanup = await guest.call();
    expect(cleanup).toMatchObject({ method: "cleanup", input: null });
    guest.send({ type: "result", id: cleanup.id, ok: true, value: null });
    expect(await guest.result("h5")).toMatchObject({ ok: true, value: null });
    guest.send({ type: "dispose", id: "h6" });
    expect(await guest.result("h6")).toMatchObject({ ok: true, value: null });
  });

  test("unsubscribes idempotently and keeps replacement handlers", async () => {
    const guest = bridge(await source(`
      export default { activate(ctx) {
        let count = 0;
        const stopOld = ctx.handle("value", () => "old");
        stopOld();
        ctx.handle("value", () => count);
        stopOld();
        const stop = ctx.on("tick", () => { count += 100; });
        stop(); stop();
        ctx.on("tick", () => { count += 1; });
        ctx.on("tick", () => { count += 2; });
      }};
    `, "js"));
    guest.send({ type: "activate", id: "h1", config: null });
    expect(await guest.result("h1")).toMatchObject({ ok: true });
    guest.send({ type: "event", id: "h2", event: "tick", payload: null });
    expect(await guest.result("h2")).toMatchObject({ ok: true, value: null });
    guest.send({ type: "invoke", id: "h3", method: "value", input: null });
    expect(await guest.result("h3")).toMatchObject({ ok: true, value: 3 });
  });

  test("preserves host errors, rejects pending calls on disposal, and reports lifecycle errors", async () => {
    const guest = bridge(await source(`
      export default { activate(ctx) {
        ctx.handle("request", () => ctx.call("host.request"));
      }};
    `));
    guest.send({ type: "invoke", id: "h0", method: "request", input: null });
    expect(await guest.result("h0")).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    guest.send({ type: "activate", id: "h1", config: null });
    expect(await guest.result("h1")).toMatchObject({ ok: true });
    guest.send({ type: "activate", id: "h2", config: null });
    expect(await guest.result("h2")).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    guest.send({ type: "invoke", id: "h3", method: "request", input: null });
    const denied = await guest.call();
    guest.send({ type: "result", id: denied.id, ok: false, error: { code: "PERMISSION_DENIED", message: "Host denied request" } });
    expect(await guest.result("h3")).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED", message: "Host denied request" } });
    guest.send({ type: "invoke", id: "h4", method: "request", input: null });
    const pending = await guest.call();
    guest.send({ type: "dispose", id: "h5" });
    expect(await guest.result("h4")).toMatchObject({ ok: false, error: { code: "DISPOSED" } });
    expect(await guest.result("h5")).toMatchObject({ ok: true });
    guest.send({ type: "result", id: pending.id, ok: true, value: "late" });
    guest.send({ type: "invoke", id: "h6", method: "request", input: null });
    expect(await guest.result("h6")).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  });

  test("normalizes omitted results and reports invalid JSON and application errors", async () => {
    const guest = bridge(await source(`
      export default { activate(ctx) {
        ctx.handle("empty", () => {});
        ctx.handle("numbers", () => [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.5, "9007199254740992"]);
        ctx.handle("bad", (kind) => {
          if (kind === "number") return NaN;
          if (kind === "integer-positive") return { value: Number.MAX_SAFE_INTEGER + 1 };
          if (kind === "integer-negative") return { value: Number.MIN_SAFE_INTEGER - 1 };
          if (kind === "date") return new Date();
          if (kind === "array") return [undefined];
          if (kind === "sparse") return new Array(1);
          if (kind === "cycle") { const x = {}; x.self = x; return x; }
          return { missing: undefined };
        });
        ctx.handle("throw", () => { throw new Error("Handler failed"); });
        ctx.handle("throw-value", () => { throw Object.create(null); });
        ctx.handle("bad-call", () => ctx.call("host.request", { value: Infinity }));
        ctx.on("fail", () => { throw new Error("Subscriber failed"); });
        return () => { throw new Error("Cleanup failed"); };
      }};
    `));
    guest.send({ type: "activate", id: "h1", config: null });
    expect(await guest.result("h1")).toMatchObject({ ok: true });
    guest.send({ type: "invoke", id: "h2", method: "empty", input: null });
    expect(await guest.result("h2")).toMatchObject({ ok: true, value: null });
    guest.send({ type: "invoke", id: "h-numbers", method: "numbers", input: null });
    expect(await guest.result("h-numbers")).toMatchObject({ ok: true, value: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.5, "9007199254740992"] });
    for (const kind of ["number", "integer-positive", "integer-negative", "date", "array", "sparse", "cycle", "object"]) {
      const id = `h-${kind}`;
      guest.send({ type: "invoke", id, method: "bad", input: kind });
      expect(await guest.result(id)).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
    }
    guest.send({ type: "invoke", id: "h3", method: "throw", input: null });
    expect(await guest.result("h3")).toMatchObject({ ok: false, error: { code: "EXTENSION_ERROR", message: "Handler failed" } });
    guest.send({ type: "invoke", id: "h-value", method: "throw-value", input: null });
    expect(await guest.result("h-value")).toMatchObject({ ok: false, error: { code: "EXTENSION_ERROR", message: "Extension threw an unreadable error value" } });
    guest.send({ type: "invoke", id: "h4", method: "bad-call", input: null });
    expect(await guest.result("h4")).toMatchObject({ ok: false, error: { code: "INVALID_JSON" } });
    guest.send({ type: "event", id: "h5", event: "fail", payload: null });
    expect(await guest.result("h5")).toMatchObject({ ok: false, error: { message: "Subscriber failed" } });
    guest.send({ type: "dispose", id: "h6" });
    expect(await guest.result("h6")).toMatchObject({ ok: false, error: { message: "Cleanup failed" } });
    guest.send({ type: "invoke", id: "h7", method: "empty", input: null });
    expect(await guest.result("h7")).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  });

  test("activation failures return useful errors", async () => {
    for (const [code, message] of [
      ["export default {};", "activate(context)"],
      ["export default { activate() { return 42; } };", "cleanup function"],
      ["export default { activate() { throw new Error('Activation failed'); } };", "Activation failed"],
    ]) {
      const guest = bridge(await source(code!));
      guest.send({ type: "activate", id: "h1", config: null });
      const result = await guest.result("h1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain(message!);
    }
  });
});

test("generated schema types support typed calls, local references, and JSON-only unconstrained values", async () => {
  const generated = await generateHostTypes({
    name: "Test host",
    version: "1",
    methods: {
      "echo": {
        input: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { name: { type: "string" }, metadata: true },
          required: ["name"],
          additionalProperties: false,
        },
        output: { $ref: "#/definitions/Result", definitions: { Result: { type: "string", enum: ["ok", "failed"] } } },
      },
      "anything": { input: true, output: true },
      "nothing": { input: { type: "null" }, output: false },
    },
  });
  for (const [schema, error] of [
    [{ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" }, "draft-07"],
    [{ type: "integer", maximum: Number.MAX_SAFE_INTEGER + 1 }, "safe integer"],
  ] as const) {
    await expect(generateHostTypes({
      name: "Invalid contract",
      version: "1",
      methods: { invalid: { input: schema, output: true } },
    })).rejects.toThrow(error);
  }
  await inTemporaryDirectory(async (directory) => {
    const generatedPath = join(directory, "host-methods.ts");
    const consumer = join(directory, "consumer.ts");
    await writeFile(generatedPath, generated);
    await writeFile(consumer, `
      import { defineExtension } from "@islands/sdk";
      import type { HostMethods } from "./host-methods";
      defineExtension<HostMethods>({ activate(ctx) {
        const result: Promise<"ok" | "failed"> = ctx.call("echo", { name: "valid" });
        ctx.call("anything", { nested: [null, 1, "x"] });
        ctx.call("nothing");
        // @ts-expect-error Generated method input is checked.
        ctx.call("echo", { name: 1 });
        // @ts-expect-error Unconstrained schemas still take JSON values.
        ctx.call("anything", () => 1);
      }});
    `);
    const config = join(directory, "tsconfig.json");
    await writeFile(config, JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
        paths: {
          "@islands/sdk": [resolve("packages/sdk/src/index.ts")],
          "@islands/protocol": [resolve("packages/protocol/src/index.ts")],
        },
      },
      files: [generatedPath, consumer],
    }));
    const { stdout, stderr } = await executeFile(resolve("node_modules/.bin/tsc"), ["--project", config]);
    expect(stdout + stderr).toBe("");
  });
});
