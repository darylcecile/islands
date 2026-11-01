import { createRuntime } from "@islands/runtime";
import type { ExtensionArtifact, JsonValue } from "@islands/protocol";
import type { Example, ExampleAction } from "../catalog.ts";
import type { DemoSnapshot } from "../host.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function status(id: string, text: string, state: "ready" | "error" | "loading") {
  const target = element(id);
  target.textContent = text;
  target.dataset.state = state;
}

async function request<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as T;
}

let installed: Example[] = [];
let selected: Example;
let action: ExampleAction;
let serverBusy = false;

function showResult(value: unknown, error = false) {
  element("result").textContent = typeof value === "string" && error ? value : pretty(value);
  element("result").dataset.state = error ? "error" : "ready";
  element("result-status").textContent = error ? "Failed" : "Completed";
}

function renderState(state: DemoSnapshot) {
  const entries = ["records", "notifications", "deployments"] as const;
  for (const key of entries) {
    element(`${key}-count`).textContent = String(state[key].length);
    element(`${key}-state`).textContent = state[key].length ? pretty(state[key]) : `No ${key} yet.`;
  }
  const list = element("activity-list");
  list.replaceChildren();
  element("activity-count").textContent = String(state.activity.length);
  for (const entry of [...state.activity].reverse()) {
    const item = document.createElement("li");
    if (entry.kind === "error") item.dataset.state = "error";
    const line = document.createElement("div");
    line.className = "activity-line";
    const time = document.createElement("time");
    time.dateTime = entry.time;
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour12: false });
    const method = document.createElement("code");
    method.textContent = entry.method;
    const kind = document.createElement("span");
    kind.className = "activity-kind";
    kind.textContent = entry.kind;
    line.append(time, method, kind);
    const detail = document.createElement("div");
    detail.className = "activity-detail";
    detail.textContent = `${entry.extensionId} · ${JSON.stringify(entry.value)}`;
    item.append(line, detail);
    list.append(item);
  }
  if (!state.activity.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Run an extension to start the activity log.";
    list.append(empty);
  }
}

function chooseAction(index: number) {
  action = selected.actions[index];
  element("payload-field").hidden = action.input === null;
  element<HTMLTextAreaElement>("payload").value = pretty(action.input);
  element("action-method").textContent = `${action.kind === "invoke" ? "invoke" : "emit"}("${action.method}")`;
  element("run-action").textContent = action.label;
}

function chooseExtension(example: Example) {
  selected = example;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".extension-button")) {
    button.setAttribute("aria-pressed", String(button.dataset.id === example.manifest.id));
  }
  element("extension-name").textContent = example.manifest.name ?? example.manifest.id;
  element("extension-description").textContent = example.manifest.description ?? "";
  element("extension-context").textContent = example.useCase;
  element("extension-language").textContent = example.language;
  element("extension-language").hidden = false;
  element("document-form").hidden = example.manifest.id !== "editor-assistant";
  element("grant-list").replaceChildren(...example.grants.map((grant) => {
    const code = document.createElement("code");
    code.textContent = grant;
    return code;
  }));
  const select = element<HTMLSelectElement>("action-select");
  select.replaceChildren(...example.actions.map((item, index) => new Option(item.label, String(index))));
  chooseAction(0);
  element("result").textContent = "Run an action to see its return value.";
  element("result").dataset.state = "";
  element("result-status").textContent = "Ready when you are";
}

function serverControls(disabled: boolean) {
  for (const target of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".workbench button, .workbench select, #reset-host, #refresh")) target.disabled = disabled;
}

async function serverOperation(work: () => Promise<void>) {
  if (serverBusy) return;
  serverBusy = true;
  serverControls(true);
  try { await work(); }
  catch (error) {
    showResult(message(error), true);
    status("server-status", message(error), "error");
    try { renderState(await request<DemoSnapshot>("/api/state")); }
    catch { /* The primary error stays visible when the server is unavailable. */ }
  } finally {
    serverBusy = false;
    serverControls(false);
  }
}

async function loadServer() {
  try {
    const data = await request<{ extensions: Example[]; state: DemoSnapshot }>("/api/extensions");
    installed = data.extensions;
    const list = element("extension-list");
    list.replaceChildren(...installed.map((example) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "extension-button";
      button.dataset.id = example.manifest.id;
      const name = document.createElement("strong");
      name.textContent = example.manifest.name ?? example.manifest.id;
      const meta = document.createElement("span");
      meta.className = "extension-meta";
      const useCase = document.createElement("span");
      useCase.textContent = example.useCase;
      const language = document.createElement("span");
      language.className = "language";
      language.textContent = example.language;
      meta.append(useCase, language);
      button.append(name, meta);
      button.addEventListener("click", () => chooseExtension(example));
      return button;
    }));
    if (!installed.length) throw new Error("No extensions installed. Build the examples and restart the service.");
    element("extension-count").textContent = String(installed.length);
    element<HTMLTextAreaElement>("document-text").value = data.state.document;
    chooseExtension(installed[0]);
    renderState(data.state);
    serverControls(false);
    status("server-status", `${installed.length} extensions active on the Bun host · sandboxed policy`, "ready");
  } catch (error) {
    status("server-status", `${message(error)} — reload the page after starting the service.`, "error");
    element("extension-list").textContent = "Extensions unavailable.";
  }
}

element("action-select").addEventListener("change", () => chooseAction(Number(element<HTMLSelectElement>("action-select").value)));
element("run-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void serverOperation(async () => {
    let input: JsonValue;
    try { input = action.input === null ? null : JSON.parse(element<HTMLTextAreaElement>("payload").value); }
    catch { throw new Error("Input is not valid JSON. Check the payload and try again."); }
    element("result-status").textContent = "Running…";
    const payload = action.kind === "event" ? { id: selected.manifest.id, event: action.method, payload: input } : { id: selected.manifest.id, method: action.method, input };
    const response = await request<{ result: JsonValue; state: DemoSnapshot }>(action.kind === "event" ? "/api/event" : "/api/execute", payload);
    showResult(response.result);
    renderState(response.state);
    status("server-status", "Action completed on the Bun host.", "ready");
  });
});
element("document-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void serverOperation(async () => {
    const data = await request<{ state: DemoSnapshot }>("/api/document", { text: element<HTMLTextAreaElement>("document-text").value });
    renderState(data.state);
    status("server-status", "Host document updated. Run an analysis to read it.", "ready");
  });
});
element("reset-host").addEventListener("click", () => void serverOperation(async () => {
  const data = await request<{ state: DemoSnapshot }>("/api/reset", {});
  renderState(data.state);
  element<HTMLTextAreaElement>("document-text").value = data.state.document;
  chooseExtension(selected);
  status("server-status", "Server state cleared. All extensions were reloaded.", "ready");
}));
element("refresh").addEventListener("click", () => void serverOperation(async () => {
  renderState(await request<DemoSnapshot>("/api/state"));
  status("server-status", "Server activity refreshed.", "ready");
}));

let browserRuntime: Awaited<ReturnType<typeof createRuntime>> | undefined;
let greeter: Awaited<ReturnType<NonNullable<typeof browserRuntime>["load"]>> | undefined;
let browserAssets: { wasm: Uint8Array; artifact: ExtensionArtifact } | undefined;
let browserBusy = false;

async function loadBrowser() {
  element<HTMLButtonElement>("browser-run").disabled = true;
  element<HTMLButtonElement>("browser-reset").disabled = true;
  status("browser-status", "Loading browser WebAssembly…", "loading");
  try {
    await browserRuntime?.dispose();
    greeter = undefined;
    if (!browserAssets) {
      const [wasmResponse, artifact] = await Promise.all([fetch("/islands.wasm"), request<ExtensionArtifact>("/portable-greeter.json")]);
      if (!wasmResponse.ok) throw new Error(`WASM download failed (${wasmResponse.status})`);
      browserAssets = { wasm: new Uint8Array(await wasmResponse.arrayBuffer()), artifact };
    }
    element("browser-log").replaceChildren();
    browserRuntime = await createRuntime({
      wasm: browserAssets.wasm,
      capabilities: {
        "log.write": (input, ctx) => {
          ctx.signal.throwIfAborted();
          const line = document.createElement("li");
          line.textContent = `${ctx.extensionId} / log.write ${JSON.stringify(input)}`;
          element("browser-log").prepend(line);
          if (element("browser-log").children.length > 20) element("browser-log").lastElementChild?.remove();
          return null;
        },
      },
    });
    greeter = await browserRuntime.load(browserAssets.artifact, { grants: ["log.write"], metadata: { location: "browser" } });
    element("browser-result").textContent = "Instance ready. Greet to start the counter at 1.";
    element("browser-result").dataset.state = "ready";
    status("browser-status", "WebAssembly ready · executing locally", "ready");
    element<HTMLButtonElement>("browser-run").disabled = false;
  } catch (error) {
    status("browser-status", message(error), "error");
    element("browser-result").textContent = "Browser runtime could not start. Reset the instance to retry.";
  } finally {
    element<HTMLButtonElement>("browser-reset").disabled = false;
  }
}

element("browser-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!greeter || browserBusy) return;
  browserBusy = true;
  element<HTMLButtonElement>("browser-run").disabled = true;
  element<HTMLButtonElement>("browser-reset").disabled = true;
  try {
    // No fetch here: this is a direct invocation of the browser-owned instance.
    const result = await greeter.invoke("greet", { name: element<HTMLInputElement>("browser-name").value });
    element("browser-result").textContent = pretty(result);
    element("browser-result").dataset.state = "ready";
  } catch (error) {
    element("browser-result").textContent = message(error);
    element("browser-result").dataset.state = "error";
  } finally {
    browserBusy = false;
    element<HTMLButtonElement>("browser-run").disabled = false;
    element<HTMLButtonElement>("browser-reset").disabled = false;
  }
});
element("browser-reset").addEventListener("click", () => { void loadBrowser(); });
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    void browserRuntime?.dispose().catch((error: unknown) => console.error("Browser runtime cleanup failed", error));
  }
});

await Promise.all([loadServer(), loadBrowser()]);
