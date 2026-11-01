import { afterEach, beforeAll, expect, test } from "bun:test";
import {
  createRuntime, type CapabilityContext, type ExtensionArtifact, type HostContract,
  type JsonValue, type Runtime, type RuntimeOptions,
} from "@islands/runtime";

// These are unit-sized tests of the public host boundary using the real reactor.
let wasm: WebAssembly.Module;
const runtimes: Runtime[] = [];

beforeAll(async () => {
  const bytes = await Bun.file(new URL("../dist/islands.wasm", import.meta.url)).arrayBuffer();
  wasm = await WebAssembly.compile(bytes);
});

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function runtime(options: Omit<RuntimeOptions, "wasm"> = {}): Promise<Runtime> {
  const instance = await createRuntime({ wasm, ...options });
  runtimes.push(instance);
  return instance;
}

function artifact(id: string, body: string, requires?: string[]): ExtensionArtifact {
  return {
    formatVersion: 1,
    manifest: { id, requires },
    code: `var __islands_extension = { default: { async activate(ctx) { ${body} } } };`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((success) => { resolve = success; });
  return { promise, resolve };
}

test("async capabilities, persistent handlers, and awaited events use host-bound context", async () => {
  const contexts: CapabilityContext[] = [];
  const host = await runtime({ capabilities: {
    double: async (input, context) => {
      contexts.push(context);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return (input as number) * 2;
    },
  } });
  const metadata = { tenant: "tenant-a", nested: { user: "alice" } };
  const extension = await host.load(artifact("counter", `
    let count = await ctx.call("double", ctx.config.start);
    ctx.handle("increment", async (value) => count += await ctx.call("double", value));
    ctx.handle("read", () => count);
    ctx.on("added", async (value) => { count += await ctx.call("double", value); });
  `), { grants: ["double"], config: { start: 1 }, metadata });
  metadata.nested.user = "mallory";
  expect(await extension.invoke("increment", 2)).toBe(6);
  await extension.emit("added", 3);
  expect(await extension.invoke("read")).toBe(12);
  expect(contexts.map((context) => context.extensionId)).toEqual(["counter", "counter", "counter"]);
  expect(contexts[0]!.metadata).toEqual({ tenant: "tenant-a", nested: { user: "alice" } });
  expect(Object.isFrozen(contexts[0]!.metadata.nested)).toBe(true);
  await extension.dispose();
  expect(contexts.every((context) => context.signal.aborted)).toBe(true);
});

test("separate instances isolate guest globals and preserve each instance's state", async () => {
  const host = await runtime();
  const body = `
    globalThis.count = 0;
    ctx.handle("next", () => ++globalThis.count);
    ctx.handle("globals", () => [typeof process, typeof require, typeof Bun, typeof document, typeof fetch]);
  `;
  const left = await host.load(artifact("left", body));
  const right = await host.load(artifact("right", body));
  expect(await left.invoke("next")).toBe(1);
  expect(await left.invoke("next")).toBe(2);
  expect(await right.invoke("next")).toBe(1);
  expect(await left.invoke("globals")).toEqual(Array(5).fill("undefined"));
  await expect(host.load(artifact("left", body))).rejects.toMatchObject({ code: "DUPLICATE_ID" });
});

test("sandbox grants default empty; required capabilities are checked before evaluation; trusted grants are a snapshot", async () => {
  let calls = 0;
  const capabilities = { read: () => ++calls };
  const host = await runtime({ capabilities });
  const body = `ctx.handle("read", () => ctx.call("read"));`;
  const denied = await host.load(artifact("denied", body));
  await expect(denied.invoke("read")).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  await expect(host.load({ ...artifact("required", body, ["read"]), code: "throw new Error('code executed')" }))
    .rejects.toMatchObject({ code: "MISSING_CAPABILITY" });
  expect(calls).toBe(0);
  capabilities.read = () => 999;
  const trusted = await host.load(artifact("trusted", body, ["read"]), { policy: "trusted" });
  expect(await trusted.invoke("read")).toBe(1);
  const grants = ["read"];
  const granted = await host.load(artifact("granted", body), { grants });
  grants.length = 0;
  expect(await granted.invoke("read")).toBe(2);
  await expect(host.load(artifact("bad-policy", body), { policy: "trustd" as "trusted" }))
    .rejects.toMatchObject({ code: "INVALID_POLICY" });
});

test("host contract validates both directions, and application errors leave handlers usable", async () => {
  const contract: HostContract = {
    name: "math", version: "1", methods: {
      double: { input: { $schema: "http://json-schema.org/draft-07/schema#", type: "number" }, output: { type: "number" } },
      broken: { input: true, output: { type: "number" } },
    },
  };
  let calls = 0;
  const host = await runtime({ contract, capabilities: {
    double: (value) => { calls++; return (value as number) * 2; },
    broken: () => "wrong result",
  } });
  const extension = await host.load(artifact("contract", `
    ctx.handle("double", value => ctx.call("double", value));
    ctx.handle("broken", () => ctx.call("broken"));
    ctx.handle("fail", () => { throw new Error("ordinary failure"); });
    ctx.handle("badJson", () => ({value: undefined}));
  `), { policy: "trusted" });
  await expect(extension.invoke("double", "2")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(calls).toBe(0);
  await expect(extension.invoke("broken")).rejects.toMatchObject({ code: "INVALID_RESULT" });
  await expect(extension.invoke("fail")).rejects.toMatchObject({ code: "EXTENSION_ERROR", message: "ordinary failure" });
  await expect(extension.invoke("badJson")).rejects.toMatchObject({ code: "INVALID_JSON" });
  await expect(extension.invoke("double", { value: NaN })).rejects.toMatchObject({ code: "INVALID_JSON" });
  expect(await extension.invoke("double", 3)).toBe(6);
});

test("unsupported explicit schema dialects fail during contract registration", async () => {
  await expect(runtime({ contract: {
    name: "unsupported", version: "1", methods: {
      echo: { input: true, output: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "number" } },
    },
  } })).rejects.toMatchObject({ code: "INVALID_CONTRACT" });
});

test("JSON boundaries preserve safe identifiers and reject unsafe integers in both directions", async () => {
  let calls = 0;
  const host = await runtime({ capabilities: {
    echo: (value) => { calls++; return value; },
    unsafe: () => Number.MAX_SAFE_INTEGER + 1,
  } });
  const extension = await host.load(artifact("numbers", `
    ctx.handle("echo", value => ctx.call("echo", value));
    ctx.handle("unsafe", () => ctx.call("unsafe"));
    ctx.handle("badGuest", () => __islands_send(JSON.stringify({
      type: "call", id: "g-unsafe", method: "echo", input: 9007199254740992
    })));
  `), { policy: "trusted" });
  expect(await extension.invoke("echo", Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  expect(await extension.invoke("echo", 0.125)).toBe(0.125);
  expect(await extension.invoke("echo", "9007199254740993")).toBe("9007199254740993");
  await expect(extension.invoke("echo", Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: "INVALID_JSON" });
  await expect(extension.invoke("echo", -Number.MAX_SAFE_INTEGER - 1)).rejects.toMatchObject({ code: "INVALID_JSON" });
  await expect(extension.invoke("unsafe")).rejects.toMatchObject({ code: "INVALID_JSON" });
  await expect(extension.invoke("badGuest")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(calls).toBe(3);
});

test("concurrent host callbacks progress without holding the instance pump", async () => {
  const bothStarted = deferred<void>();
  let count = 0;
  const host = await runtime({ capabilities: { rendezvous: async (value) => {
    if (++count === 2) bothStarted.resolve();
    await bothStarted.promise;
    return value;
  } } });
  const extension = await host.load(artifact("concurrent", `
    ctx.handle("pair", () => Promise.all([ctx.call("rendezvous", 1), ctx.call("rendezvous", 2)]));
  `), { grants: ["rendezvous"] });
  expect(await extension.invoke("pair")).toEqual([1, 2]);
});

test("pending host calls are bounded without poisoning an otherwise valid extension", async () => {
  const started = deferred<void>();
  const release = deferred<JsonValue>();
  const host = await runtime({ limits: { maxPendingCalls: 1 }, capabilities: {
    hold: () => { started.resolve(); return release.promise; },
  } });
  const extension = await host.load(artifact("bounded", `
    ctx.handle("pair", async () => {
      const result = await Promise.allSettled([ctx.call("hold"), ctx.call("hold")]);
      return result.map(item => item.status === "fulfilled" ? item.value : item.reason.code);
    });
  `), { grants: ["hold"] });
  const result = extension.invoke("pair");
  await started.promise;
  release.resolve("released");
  expect(await result).toEqual(["released", "PENDING_LIMIT"]);
});

test("guest acknowledgements cannot release callback quota, and duplicate outstanding call IDs cannot repeat a capability", async () => {
  let calls = 0;
  const started = deferred<AbortSignal>();
  const host = await runtime({ limits: { maxPendingCalls: 1 }, capabilities: {
    hold: (_value, context) => { calls++; started.resolve(context.signal); return new Promise(() => {}); },
  } });
  const extension = await host.load(artifact("guest-ids", `
    const rawCall = () => __islands_send(JSON.stringify({type: "call", id: "g-held", method: "hold", input: null}));
    ctx.handle("start", rawCall);
    ctx.handle("forgeAck", async () => {
      __islands_send(JSON.stringify({type: "result", id: "h-unrelated", ok: true, value: null}));
      return ctx.call("hold").catch(error => error.code);
    });
    ctx.handle("duplicate", rawCall);
  `), { grants: ["hold"] });
  await extension.invoke("start");
  const signal = await started.promise;
  expect(await extension.invoke("forgeAck")).toBe("PENDING_LIMIT");
  await expect(extension.invoke("duplicate")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(calls).toBe(1);
  expect(signal.aborted).toBe(true);
});

test("disposal aborts host calls, rejects pending invocations, runs async cleanup, and discards late results", async () => {
  const started = deferred<AbortSignal>();
  const release = deferred<JsonValue>();
  let cleaned = 0;
  const host = await runtime({ capabilities: {
    hold: (_value, context) => { started.resolve(context.signal); return release.promise; },
    clean: async () => { await Promise.resolve(); cleaned++; },
  } });
  const extension = await host.load(artifact("lifecycle", `
    ctx.handle("hold", () => ctx.call("hold"));
    return () => ctx.call("clean");
  `), { policy: "trusted" });
  const pending = extension.invoke("hold").catch((error: unknown) => error);
  const signal = await started.promise;
  await Promise.all([extension.dispose(), extension.dispose()]);
  expect(signal.aborted).toBe(true);
  expect(await pending).toMatchObject({ code: "DISPOSED" });
  expect(cleaned).toBe(1);
  const replacement = await host.load(artifact("lifecycle", `ctx.handle("read", () => "fresh");`));
  release.resolve("late result");
  expect(await replacement.invoke("read")).toBe("fresh");
  await expect(extension.invoke("hold")).rejects.toMatchObject({ code: "DISPOSED" });
  await host.dispose();
  await expect(replacement.invoke("read")).rejects.toMatchObject({ code: "DISPOSED" });
  await expect(host.load(artifact("after-disposal", ""))).rejects.toMatchObject({ code: "DISPOSED" });
});

test("runtime disposal interrupts activation and still awaits its returned cleanup", async () => {
  const started = deferred<AbortSignal>();
  let cleaned = 0;
  const host = await runtime({ capabilities: {
    hold: (_value, context) => { started.resolve(context.signal); return new Promise(() => {}); },
    clean: () => { cleaned++; },
  } });
  const loading = host.load(artifact("activating", `
    await ctx.call("hold").catch(() => {});
    return () => ctx.call("clean");
  `), { policy: "trusted" }).catch((error: unknown) => error);
  const signal = await started.promise;
  await host.dispose();
  expect(await loading).toMatchObject({ code: "DISPOSED" });
  expect(signal.aborted).toBe(true);
  expect(cleaned).toBe(1);
});

test("timeouts abort stalled operations and bound guest cleanup", async () => {
  const started = deferred<AbortSignal>();
  const host = await runtime({ limits: { timeoutMs: 50 }, capabilities: {
    hold: (_input, context) => { started.resolve(context.signal); return new Promise(() => {}); },
  } });
  const extension = await host.load(artifact("timeout", `ctx.handle("hold", () => ctx.call("hold"));`), { grants: ["hold"] });
  const pending = extension.invoke("hold");
  const rejection = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  const signal = await started.promise;
  await rejection;
  expect(signal.aborted).toBe(true);
  await expect(extension.invoke("hold")).rejects.toMatchObject({ code: "DISPOSED" });
  const cleanup = await host.load(artifact("cleanup-timeout", `return () => new Promise(() => {});`));
  await expect(cleanup.dispose()).rejects.toMatchObject({ code: "TIMEOUT" });
});

test("fuel terminates synchronous loops and heap exhaustion poisons only that instance", async () => {
  const host = await runtime({ limits: { fuel: 200, memoryBytes: 2 * 1024 * 1024 } });
  const healthy = await host.load(artifact("healthy", `ctx.handle("ping", () => "pong");`));
  const loop = await host.load(artifact("loop", `ctx.handle("run", () => { while (true) {} });`));
  await expect(loop.invoke("run")).rejects.toMatchObject({ code: "FUEL_EXHAUSTED" });
  await expect(loop.invoke("run")).rejects.toMatchObject({ code: "DISPOSED" });
  const memory = await host.load(artifact("memory", `ctx.handle("run", () => new ArrayBuffer(8 * 1024 * 1024));`));
  await expect(memory.invoke("run")).rejects.toMatchObject({ code: "MEMORY_LIMIT" });
  expect(await healthy.invoke("ping")).toBe("pong");
});

test("an endless Promise-job chain yields to the host and expires after activation already succeeded", async () => {
  const host = await runtime({ limits: { timeoutMs: 80 } });
  const extension = await host.load(artifact("microtasks", `
    function spin() { Promise.resolve().then(spin); }
    spin();
    ctx.handle("ping", () => "pong");
  `));
  // The real timer must run while the guest has runnable jobs; no timing sleep drives the pump.
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(await extension.invoke("ping")).toBe("pong");
  await new Promise((resolve) => setTimeout(resolve, 120));
  await expect(extension.invoke("ping")).rejects.toMatchObject({ code: "DISPOSED" });
});

test("invalid resource limits are rejected at the public entry point", async () => {
  for (const limits of [{ fuel: 0 }, { timeoutMs: Infinity }, { maxPendingCalls: -1 }, { memoryBytes: 1.5 }, { stackBytes: 2 * 1024 * 1024 }]) {
    await expect(createRuntime({ wasm, limits })).rejects.toMatchObject({ code: "INVALID_LIMITS" });
  }
});
