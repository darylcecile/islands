import { join } from "node:path";
import { createDemo } from "../host.ts";
import { browserDirectory, extensionDirectory, wasmPath } from "../paths.ts";
import type { JsonValue } from "@islands/protocol";

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Request body must be a JSON object");
  return value as Record<string, JsonValue>;
}

function text(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} must be a non-empty string`);
  return value;
}

async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "Send Content-Type: application/json");
  }
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new HttpError(400, "Request body is not valid JSON"); }
  return object(value);
}

const rawPort = process.env.PORT ?? "3210";
if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const staticFiles = new Map([
  ["/", [join(browserDirectory, "index.html"), "text/html; charset=utf-8"]],
  ["/app.js", [join(browserDirectory, "app.js"), "text/javascript; charset=utf-8"]],
  ["/style.css", [join(browserDirectory, "style.css"), "text/css; charset=utf-8"]],
  ["/islands.wasm", [wasmPath, "application/wasm"]],
  ["/portable-greeter.json", [join(extensionDirectory, "portable-greeter.json"), "application/json"]],
]);
for (const [path] of staticFiles.values()) {
  if (!await Bun.file(path).exists()) throw new Error(`Missing build output: ${path}. Run bun run build first.`);
}

let demo = await createDemo();
let pending = Promise.resolve();
let stopping = false;

async function api(request: Request, path: string): Promise<Response> {
  if (request.method === "GET" && path === "/api/extensions") return Response.json({ extensions: demo.list(), state: demo.snapshot() });
  if (request.method === "GET" && path === "/api/state") return Response.json(demo.snapshot());
  if (path === "/api/extensions" || path === "/api/state") throw new HttpError(405, "This route requires GET");
  if (request.method !== "POST") throw new HttpError(405, "This route requires POST");
  const data = await body(request);
  if (path === "/api/reset") {
    const replacement = await createDemo();
    const previous = demo;
    demo = replacement;
    await previous.dispose();
    return Response.json({ state: demo.snapshot() });
  }
  if (path === "/api/document") {
    if (typeof data.text !== "string") throw new HttpError(400, "text must be a string");
    if (data.text.length > 20_000) throw new HttpError(400, "Document is limited to 20,000 characters");
    demo.setDocument(data.text);
    return Response.json({ state: demo.snapshot() });
  }
  const id = text(data.id, "id");
  const kind = path === "/api/event" ? "event" : "invoke";
  const method = text(data[kind === "event" ? "event" : "method"], kind === "event" ? "event" : "method");
  const example = demo.list().find((item) => item.manifest.id === id);
  if (!example) throw new HttpError(404, `Extension not installed: ${id}`);
  if (!example.actions.some((action) => action.kind === kind && action.method === method)) throw new HttpError(400, `Unknown ${kind} action: ${method}`);
  try {
    const result = await demo.execute(id, kind, method, data[kind === "event" ? "payload" : "input"] ?? null);
    return Response.json({ result, state: demo.snapshot() });
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : String(error));
  }
}

const apiRoutes = new Set(["/api/extensions", "/api/state", "/api/execute", "/api/event", "/api/document", "/api/reset"]);
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(rawPort), maxRequestBodySize: 64 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (stopping) throw new HttpError(503, "Server is stopping");
      let response: Response;
      const file = staticFiles.get(url.pathname);
      if (file && (request.method === "GET" || request.method === "HEAD")) {
        response = new Response(request.method === "HEAD" ? null : Bun.file(file[0]), { headers: { "Content-Type": file[1] } });
      } else if (apiRoutes.has(url.pathname)) {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) throw new HttpError(403, "Use the demo's own origin");
        // Serialize demo mutations so reset cannot dispose an active operation.
        const result = pending.then(() => api(request, url.pathname));
        pending = result.then(() => {}, () => {});
        response = await result;
      } else {
        throw new HttpError(404, "Route not found");
      }
      for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      return Response.json({ error: error instanceof Error ? error.message : "Unexpected server error" }, { status, headers: securityHeaders });
    }
  },
});

console.log(`Islands demo: http://127.0.0.1:${server.port}`);
console.log("Local in-memory host; reset or stop to clear state.");

async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
    await pending;
    await demo.dispose();
  } catch (error) {
    console.error("Failed to shut down cleanly:", error);
    process.exitCode = 1;
  }
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
