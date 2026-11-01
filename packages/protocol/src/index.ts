/** JSON boundary values: finite numbers, safe integers, never live host objects. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = boolean | { [key: string]: unknown };

export interface ExtensionManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  requires?: string[];
}

/** Portable bundle emitted by host-provided loaders and Islands authoring tools. */
export interface ExtensionArtifact {
  formatVersion: 1;
  manifest: ExtensionManifest;
  /** IIFE declaring globalThis.__islands_extension with a default definition export. */
  code: string;
}

export interface MethodSchema {
  description?: string;
  input: JsonSchema;
  output: JsonSchema;
}

export interface HostContract {
  name: string;
  version: string;
  methods: Record<string, MethodSchema>;
}

export interface WireError {
  code: string;
  message: string;
}

export type WireResult =
  | { type: "result"; id: string; ok: true; value: JsonValue }
  | { type: "result"; id: string; ok: false; error: WireError };

export type HostMessage =
  | { type: "activate"; id: string; config: JsonValue }
  | { type: "invoke"; id: string; method: string; input: JsonValue }
  | { type: "event"; id: string; event: string; payload: JsonValue }
  | { type: "dispose"; id: string }
  | WireResult;

export type GuestMessage =
  | { type: "call"; id: string; method: string; input: JsonValue }
  | WireResult;
