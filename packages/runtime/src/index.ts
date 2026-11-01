import type { ExtensionArtifact } from "@islands/protocol";
import { compileContract } from "./contract.ts";
import { engineError, IslandsError } from "./errors.ts";
import { Extension } from "./extension.ts";
import { record } from "./json.ts";
import type { LoadOptions, Runtime, RuntimeOptions } from "./types.ts";
import { artifact as validateArtifact, capabilities as validateCapabilities, limits as validateLimits, loadSettings } from "./validation.ts";

export type { ExtensionArtifact, ExtensionManifest, HostContract, JsonSchema, JsonValue, MethodSchema } from "@islands/protocol";
export type { Capabilities, Capability, CapabilityContext, LoadedExtension, LoadOptions, Runtime, RuntimeLimits, RuntimeOptions } from "./types.ts";
export { IslandsError } from "./errors.ts";
export { DEFAULT_LIMITS } from "./validation.ts";

/** Compile once, instantiate an isolated WASI reactor for every loaded extension. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  if (!record(options)) throw new IslandsError("INVALID_INPUT", "Runtime options must be an object");
  const limits = validateLimits(options.limits);
  const capabilities = validateCapabilities(options.capabilities);
  const contracts = compileContract(options.contract);
  const wasm = options.wasm;
  if (!(wasm instanceof Uint8Array) && !(wasm instanceof WebAssembly.Module)) {
    throw new IslandsError("INVALID_WASM", "wasm must be a Uint8Array or WebAssembly.Module");
  }
  let module: WebAssembly.Module;
  try { module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(new Uint8Array(wasm)); }
  catch (cause) { throw new IslandsError("INVALID_WASM", "Could not compile the Islands core", { cause }); }
  const extensions = new Map<string, Extension>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  return Object.freeze({
    async load(input: ExtensionArtifact, options: LoadOptions = {}) {
      if (disposed) throw new IslandsError("DISPOSED", "Runtime is disposed");
      const artifact = validateArtifact(input);
      const settings = loadSettings(options, capabilities, artifact.manifest.requires ?? []);
      const id = artifact.manifest.id;
      if (extensions.has(id)) throw new IslandsError("DUPLICATE_ID", `Extension is already loaded: ${id}`);
      let extension: Extension;
      try {
        extension = new Extension(id, module, limits, capabilities, contracts, settings, () => {
          if (extensions.get(id) === extension) extensions.delete(id);
        });
      } catch (cause) { throw engineError(cause); }
      extensions.set(id, extension);
      await extension.activate(artifact.code);
      return extension;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        const results = await Promise.allSettled([...extensions.values()].map((extension) => extension.dispose()));
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Extension cleanup failed");
      })();
      return disposal;
    },
  });
}
