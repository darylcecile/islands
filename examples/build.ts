import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { bundleExtension } from "@islands/tooling";
import { examples } from "./catalog.ts";
import { compileAutomation } from "./loaders/automation.ts";
import { root, extensionDirectory, browserDirectory } from "./paths.ts";

export async function buildExamples(): Promise<void> {
  await Promise.all([mkdir(extensionDirectory, { recursive: true }), mkdir(browserDirectory, { recursive: true })]);
  for (const example of examples) {
    const entrypoint = join(root, "examples/extensions", example.source);
    const artifact = example.language === "YAML" || example.language === "JSON"
      ? await compileAutomation(await readFile(entrypoint, "utf8"), example.language === "YAML" ? "yaml" : "json")
      : await bundleExtension({ entrypoint, manifest: example.manifest });
    await writeFile(join(extensionDirectory, `${example.manifest.id}.json`), JSON.stringify(artifact, null, 2) + "\n");
  }
  await build({
    absWorkingDir: root,
    entryPoints: ["examples/service/browser.ts"],
    outfile: join(browserDirectory, "app.js"),
    bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true,
  });
  await Promise.all(["index.html", "style.css"].map((name) => copyFile(join(root, "examples/service", name), join(browserDirectory, name))));
  console.log(`Built ${examples.length} extension artifacts and browser demo`);
}

if (import.meta.main) await buildExamples();
