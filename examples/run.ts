import assert from "node:assert/strict";
import { createDemo } from "./host.ts";

const demo = await createDemo();
try {
  const document = "Small extensions. Real capabilities.";
  demo.setDocument(document);
  assert.deepEqual(await demo.execute("editor-assistant", "invoke", "editor.analyze"), { words: 4, characters: document.length, readingSeconds: 2, analyses: 1, saves: 0 });
  await demo.execute("editor-assistant", "event", "document.saved");
  assert.deepEqual(await demo.execute("editor-assistant", "invoke", "editor.stats"), { analyses: 1, saves: 1 });
  console.log("✓ App: stateful editor command and save event");

  await demo.execute("ticket-workflow", "event", "ticket.created", { title: "Improve keyboard navigation", priority: "high" });
  assert.deepEqual(demo.snapshot().records, [{ id: "task-1", title: "Improve keyboard navigation", priority: "high", workspaceId: "demo-workspace" }]);
  assert.equal(demo.snapshot().notifications.length, 1);
  console.log("✓ SaaS: YAML workflow created a workspace task and team notification");

  await demo.execute("deployment-workflow", "event", "deployment.requested", { service: "islands-api", revision: "feature/extensions" });
  assert.deepEqual(demo.snapshot().deployments, [{ id: "deployment-3", service: "islands-api", revision: "feature/extensions", environment: "preview", status: "registered", projectId: "demo-project" }]);
  assert.equal(demo.snapshot().notifications.length, 2);
  console.log("✓ PaaS: JSON workflow registered a scoped local preview deployment");

  assert.deepEqual(await demo.execute("slug-command", "invoke", "slug.create", { title: "Building with Islands" }), { slug: "building-with-islands" });
  console.log("✓ JavaScript: page title command");

  for (let calls = 1; calls <= 2; calls++) {
    assert.deepEqual(await demo.execute("portable-greeter", "invoke", "greet", { name: "Islands" }), { message: "Hello, Islands!", calls });
  }
  const logs = demo.snapshot().activity.filter((entry) => entry.extensionId === "portable-greeter" && entry.method === "log.write");
  assert.deepEqual(logs.map((entry) => entry.value), [{ message: "Hello, Islands!" }, { message: "Hello, Islands!" }]);
  console.log("✓ Portable artifact: two invocations and two host capability calls");
} finally {
  await demo.dispose();
}
