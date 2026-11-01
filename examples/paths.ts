import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const extensionDirectory = join(root, "dist/extensions");
export const browserDirectory = join(root, "dist/browser");
export const wasmPath = join(root, "dist/islands.wasm");
