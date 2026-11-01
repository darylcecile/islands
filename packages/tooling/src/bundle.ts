import { build } from "esbuild";
import type { BuildOptions } from "esbuild";
import { fileURLToPath } from "node:url";
import type { ExtensionArtifact, ExtensionManifest } from "@islands/protocol";
import { validateManifest } from "./validation.js";

export interface BundleExtensionOptions {
  entrypoint: string;
  manifest: ExtensionManifest;
}

export interface BundleSourceOptions {
  source: string;
  loader: "ts" | "js";
  manifest: ExtensionManifest;
  /** Directory for relative/package imports. Defaults to process.cwd(). */
  resolveDir?: string;
}

async function bundle(manifest: ExtensionManifest, input: BuildOptions): Promise<ExtensionArtifact> {
  const validatedManifest = validateManifest(manifest);
  const result = await build({
    ...input,
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "__islands_extension",
    target: "es2022",
    charset: "utf8",
    legalComments: "none",
    logLevel: "silent",
    // Resolve our dependency even when the extension lives outside this workspace.
    alias: { "@islands/sdk": fileURLToPath(import.meta.resolve("@islands/sdk")) },
  });
  if (result.outputFiles?.length !== 1) throw new Error("An extension must bundle to a single JavaScript file");
  return { formatVersion: 1, manifest: validatedManifest, code: result.outputFiles[0]!.text };
}

/** Bundle a file and its imports. Compiling never executes extension modules. */
export async function bundleExtension(options: BundleExtensionOptions): Promise<ExtensionArtifact> {
  if (typeof options.entrypoint !== "string" || !options.entrypoint.trim()) {
    throw new TypeError("entrypoint must be a non-empty file path");
  }
  return bundle(options.manifest, { entryPoints: [options.entrypoint] });
}

/** Compile JS/TS source supplied by a host-owned loader, without evaluating it. */
export async function bundleSource(options: BundleSourceOptions): Promise<ExtensionArtifact> {
  if (typeof options.source !== "string") throw new TypeError("source must be a string");
  if (options.loader !== "ts" && options.loader !== "js") throw new TypeError("loader must be 'ts' or 'js'");
  return bundle(options.manifest, {
    stdin: {
      contents: options.source,
      loader: options.loader,
      sourcefile: `extension.${options.loader}`,
      resolveDir: options.resolveDir ?? process.cwd(),
    },
  });
}
