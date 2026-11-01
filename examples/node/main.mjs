import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRuntime } from "@islands/runtime";

// Node resolves the package's built ESM export; no TypeScript loader is needed.
const wasm = new Uint8Array(await readFile(new URL("../../dist/islands.wasm", import.meta.url)));
const artifact = JSON.parse(await readFile(new URL("../../dist/extensions/portable-greeter.json", import.meta.url), "utf8"));
const messages = [];
const runtime = await createRuntime({
  wasm,
  capabilities: {
    "log.write": (input, { extensionId, signal }) => {
      signal.throwIfAborted();
      assert.equal(extensionId, "portable-greeter");
      assert.equal(typeof input?.message, "string");
      messages.push(input.message);
      return null;
    },
  },
});

try {
  const extension = await runtime.load(artifact, { grants: ["log.write"] });
  assert.deepEqual(await extension.invoke("greet", { name: "Node" }), { message: "Hello, Node!", calls: 1 });
  assert.deepEqual(await extension.invoke("greet", { name: "again" }), { message: "Hello, again!", calls: 2 });
  assert.deepEqual(messages, ["Hello, Node!", "Hello, again!"]);
  await extension.dispose();
  console.log("✓ Node: built ESM runtime, shared WASM/artifact, stateful calls and host logs");
} finally {
  await runtime.dispose();
}
