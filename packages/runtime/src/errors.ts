/** Stable machine-readable code, with a concise diagnostic message. */
export class IslandsError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IslandsError";
  }
}

export function engineError(error: unknown): IslandsError {
  if (error instanceof IslandsError) return error;
  return new IslandsError("ENGINE_ERROR", error instanceof Error ? error.message : "Core execution failed", { cause: error });
}

export function coreError(message: string): IslandsError {
  let code = "ENGINE_ERROR";
  if (/fuel|interrupt/i.test(message)) code = "FUEL_EXHAUSTED";
  else if (/out of memory|memory limit|heap limit|memory exhausted|alloc/i.test(message)) code = "MEMORY_LIMIT";
  else if (/stack/i.test(message)) code = "STACK_LIMIT";
  else if (/outbox limit/i.test(message)) code = "MESSAGE_LIMIT";
  return new IslandsError(code, message || "Core execution failed");
}
