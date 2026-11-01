import type { JsonValue } from "@islands/protocol";

export type {
  ExtensionArtifact,
  ExtensionManifest,
  HostContract,
  JsonSchema,
  JsonValue,
  MethodSchema,
} from "@islands/protocol";

/** Host capability names and JSON request/response types. Numeric range checks run in the guest bridge. */
export type MethodMap = Record<string, { input: JsonValue; output: JsonValue }>;

export type Unsubscribe = () => void;
export type Cleanup = () => void | Promise<void>;
export type Handler = (input: JsonValue) => JsonValue | void | Promise<JsonValue | void>;
export type EventHandler = (payload: JsonValue) => void | Promise<void>;

export interface ExtensionContext<Methods extends MethodMap = MethodMap> {
  readonly config: JsonValue;
  /** Omitted input becomes null, so only nullable inputs may be omitted. */
  call<Name extends keyof Methods & string>(
    method: Name,
    ...args: null extends Methods[Name]["input"]
      ? [input?: Methods[Name]["input"]]
      : [input: Methods[Name]["input"]]
  ): Promise<Methods[Name]["output"]>;
  /** Register one handler for a method; duplicate registrations throw. */
  handle(method: string, handler: Handler): Unsubscribe;
  /** Subscribe to a host event. Each subscription has its own unsubscribe. */
  on(event: string, handler: EventHandler): Unsubscribe;
}

export interface ExtensionDefinition<Methods extends MethodMap = MethodMap> {
  activate(context: ExtensionContext<Methods>): void | Cleanup | Promise<void | Cleanup>;
}

/** A typed identity. The WASM guest bridge supplies the context at activation. */
export function defineExtension<Methods extends MethodMap = MethodMap>(
  definition: ExtensionDefinition<Methods>,
): ExtensionDefinition<Methods> {
  return definition;
}
