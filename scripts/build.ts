import { cp, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const packages = ["protocol", "sdk", "runtime", "tooling"];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function buildPackage(name: string): Promise<void> {
  const directory = resolve(root, "packages", name);
  const entryPoints = [resolve(directory, "src/index.ts")];
  const cli = resolve(directory, "src/cli.ts");
  if (await exists(cli)) entryPoints.push(cli);
  await build({
    entryPoints,
    outdir: resolve(directory, "dist"),
    bundle: true,
    packages: "external",
    platform: "neutral",
    format: "esm",
    target: "es2022",
    sourcemap: true,
  });
}

async function main(): Promise<void> {
  const wasm = resolve(root, "dist/islands.wasm");
  if (!(await exists(wasm))) {
    throw new Error("Missing dist/islands.wasm. Run `bun run build:core` first.");
  }
  for (const name of packages) await buildPackage(name);
  const declarations = Bun.spawn(["bun", "x", "--no-install", "tsc", "-p", "tsconfig.build.json"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await declarations.exited) !== 0) throw new Error("Declaration generation failed.");
  for (const name of packages) {
    await cp(resolve(root, "build/types", name, "src"), resolve(root, "packages", name, "dist"), { recursive: true });
    await cp(resolve(root, "LICENSE"), resolve(root, "packages", name, "dist/LICENSE"));
  }
  await mkdir(resolve(root, "packages/runtime/dist"), { recursive: true });
  await cp(wasm, resolve(root, "packages/runtime/dist/islands.wasm"));
  await cp(resolve(root, "core/THIRD_PARTY_NOTICES.md"), resolve(root, "packages/runtime/dist/THIRD_PARTY_NOTICES.md"));
  const { buildExamples } = await import("../examples/build.ts");
  await buildExamples();
  console.log("Built four packages, portable WASM core assets, extension examples, and demo browser assets.");
}

await main();
