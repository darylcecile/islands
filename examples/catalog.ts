import type { ExtensionManifest, JsonValue } from "@islands/protocol";

export interface ExampleAction {
  label: string;
  kind: "invoke" | "event";
  method: string;
  input: JsonValue;
}

export interface Example {
  manifest: ExtensionManifest;
  source: string;
  language: "TypeScript" | "JavaScript" | "YAML" | "JSON";
  useCase: string;
  grants: string[];
  config: JsonValue;
  actions: ExampleAction[];
}

export const examples: Example[] = [
  {
    manifest: { id: "editor-assistant", name: "Document insights", version: "1.0.0", description: "A stateful editor service. Reads the host document, counts words, and remembers analyses and save events.", requires: ["editor.read", "log.write"] },
    source: "editor.ts", language: "TypeScript", useCase: "App / editor",
    grants: ["editor.read", "log.write"], config: {},
    actions: [
      { label: "Analyze document", kind: "invoke", method: "editor.analyze", input: null },
      { label: "Emit save event", kind: "event", method: "document.saved", input: null },
      { label: "Read service state", kind: "invoke", method: "editor.stats", input: null },
    ],
  },
  {
    manifest: { id: "ticket-workflow", name: "Ticket triage", version: "1.0.0", description: "A YAML automation that creates a task in the local workspace and adds a team notification.", requires: ["records.create", "notifications.send"] },
    source: "ticket-workflow.yaml", language: "YAML", useCase: "SaaS / workflow",
    grants: ["records.create", "notifications.send"], config: { channel: "support" },
    actions: [
      { label: "Create ticket", kind: "event", method: "ticket.created", input: { title: "Improve keyboard navigation", priority: "high" } },
      { label: "Read workflow state", kind: "invoke", method: "automation.status", input: null },
    ],
  },
  {
    manifest: { id: "deployment-workflow", name: "Preview deployment", version: "1.0.0", description: "A JSON automation that writes to a local deployment registry. The host scopes it to preview environments.", requires: ["deployments.create", "notifications.send"] },
    source: "deployment-workflow.json", language: "JSON", useCase: "PaaS / deployment",
    grants: ["deployments.create", "notifications.send"], config: { environment: "preview", channel: "releases" },
    actions: [
      { label: "Register deployment", kind: "event", method: "deployment.requested", input: { service: "islands-api", revision: "feature/extensions" } },
      { label: "Read workflow state", kind: "invoke", method: "automation.status", input: null },
    ],
  },
  {
    manifest: { id: "slug-command", name: "Page slug", version: "1.0.0", description: "A plain JavaScript command that turns a page title into a URL-friendly slug.", requires: ["log.write"] },
    source: "slug.js", language: "JavaScript", useCase: "App / command",
    grants: ["log.write"], config: {},
    actions: [{ label: "Create slug", kind: "invoke", method: "slug.create", input: { title: "Building with Islands" } }],
  },
  {
    manifest: { id: "portable-greeter", name: "Portable greeter", version: "1.0.0", description: "The same stateful artifact runs in JavaScript, your browser, Go and Python. Each host owns its log capability.", requires: ["log.write"] },
    source: "portable-greeter.ts", language: "TypeScript", useCase: "Portable / all hosts",
    grants: ["log.write"], config: {},
    actions: [{ label: "Greet on server", kind: "invoke", method: "greet", input: { name: "Islands" } }],
  },
];
