import type { ExtensionArtifact, HostContract, JsonValue } from "@islands/protocol";

export interface CapabilityContext {
  readonly extensionId: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  /** Aborted when the instance stops active work; cleanup callbacks have a fresh bounded signal. */
  readonly signal: AbortSignal;
}

/** Undefined results normalize to null. Nested undefined values are rejected. */
export type Capability = (input: JsonValue, context: CapabilityContext) => JsonValue | void | Promise<JsonValue | void>;
export type Capabilities = Record<string, Capability>;

export interface RuntimeLimits {
  memoryBytes?: number;
  stackBytes?: number;
  fuel?: number;
  timeoutMs?: number;
  maxPendingCalls?: number;
}

export interface RuntimeOptions {
  wasm: Uint8Array | WebAssembly.Module;
  capabilities?: Capabilities;
  contract?: HostContract;
  limits?: RuntimeLimits;
}

export interface LoadOptions {
  grants?: string[];
  policy?: "sandboxed" | "trusted";
  config?: JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface LoadedExtension {
  readonly id: string;
  invoke(method: string, input?: JsonValue): Promise<JsonValue>;
  emit(event: string, payload?: JsonValue): Promise<void>;
  dispose(): Promise<void>;
}

export interface Runtime {
  load(artifact: ExtensionArtifact, options?: LoadOptions): Promise<LoadedExtension>;
  dispose(): Promise<void>;
}
