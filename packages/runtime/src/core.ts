import { coreError, engineError, IslandsError } from "./errors.ts";
import { encoder, MAX_MESSAGE_BYTES } from "./json.ts";
import type { RuntimeLimits } from "./types.ts";
import { wasiImports } from "./wasi.ts";

interface CoreExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  islands_abi_version(): number;
  islands_alloc(length: number): number;
  islands_free(pointer: number): void;
  islands_init(memory: number, stack: number): number;
  islands_eval(pointer: number, length: number, fuel: number): number;
  islands_dispatch(pointer: number, length: number, fuel: number): number;
  islands_step(jobs: number, fuel: number): number;
  islands_output_ptr(): number;
  islands_output_len(): number;
  islands_output_clear(): void;
  islands_error_ptr(): number;
  islands_error_len(): number;
  islands_destroy(): void;
}

const functions: (keyof CoreExports)[] = [
  "_initialize", "islands_abi_version", "islands_alloc", "islands_free", "islands_init", "islands_eval", "islands_dispatch",
  "islands_step", "islands_output_ptr", "islands_output_len", "islands_output_clear", "islands_error_ptr", "islands_error_len", "islands_destroy",
];
const decoder = new TextDecoder("utf-8", { fatal: true });
export const MAX_JOBS = 256;

export class Core {
  #exports: CoreExports | undefined;
  constructor(module: WebAssembly.Module, private readonly limits: Readonly<Required<RuntimeLimits>>) {
    const wasi = wasiImports(() => {
      if (!this.#exports) throw new IslandsError("INVALID_WASM", "Core memory is unavailable");
      return this.#exports.memory;
    });
    for (const imported of WebAssembly.Module.imports(module)) {
      if (imported.module !== "wasi_snapshot_preview1" || imported.kind !== "function" || !Object.hasOwn(wasi, imported.name)) {
        throw new IslandsError("WASM_IMPORT", `Unsupported core import: ${imported.module}.${imported.name}`);
      }
    }
    try {
      const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi });
      if (!(instance.exports.memory instanceof WebAssembly.Memory) || functions.some((key) => typeof instance.exports[key] !== "function")) {
        throw new IslandsError("INVALID_WASM", "Core is missing required ABI exports");
      }
      this.#exports = instance.exports as unknown as CoreExports;
      this.call((core) => core._initialize());
      if (this.call((core) => core.islands_abi_version()) !== 1) throw new IslandsError("ABI_VERSION", "Expected Islands ABI version 1");
      this.status(this.call((core) => core.islands_init(limits.memoryBytes, limits.stackBytes)));
    } catch (cause) {
      // Status errors permit cleanup; a raw call that threw has already discarded the reactor.
      try { this.destroy(); } catch { /* The initialization failure remains authoritative. */ }
      throw engineError(cause);
    }
  }

  private get exports(): CoreExports {
    if (!this.#exports) throw new IslandsError("DISPOSED", "Extension is disposed");
    return this.#exports;
  }

  private call<T>(invoke: (core: CoreExports) => T): T {
    const core = this.exports;
    try {
      return invoke(core);
    } catch (cause) {
      // A trap can bypass C cleanup. Drop the only retained exports/memory reference
      // before unwinding; even free, error reads and destroy are unsafe afterward.
      this.#exports = undefined;
      throw cause;
    }
  }

  private text(pointer: number, length: number): string {
    const size = length >>> 0;
    if (size > MAX_MESSAGE_BYTES) throw new IslandsError("MESSAGE_LIMIT", "Core output exceeds 1 MiB");
    return decoder.decode(new Uint8Array(this.exports.memory.buffer, pointer >>> 0, size));
  }

  private status(status: number): void {
    if (status !== 0) throw coreError(this.text(this.call((core) => core.islands_error_ptr()), this.call((core) => core.islands_error_len())));
  }

  private output(): string {
    const text = this.text(this.call((core) => core.islands_output_ptr()), this.call((core) => core.islands_output_len()));
    this.call((core) => core.islands_output_clear());
    return text;
  }

  private input(text: string, evaluate: boolean): string {
    const data = encoder.encode(text);
    const pointer = this.call((core) => core.islands_alloc(data.length)) >>> 0;
    if (!pointer) throw new IslandsError("MEMORY_LIMIT", "Core input allocation failed");
    try {
      new Uint8Array(this.exports.memory.buffer, pointer, data.length).set(data);
      const status = this.call((core) => evaluate
        ? core.islands_eval(pointer, data.length, this.limits.fuel)
        : core.islands_dispatch(pointer, data.length, this.limits.fuel));
      this.status(status);
      // Copy the outbox before free/clear or any other mutating ABI call.
      return this.output();
    } finally {
      if (this.#exports) this.call((core) => core.islands_free(pointer));
    }
  }

  evaluate(code: string): string { return this.input(code, true); }
  dispatch(message: string): string { return this.input(message, false); }

  step(): { jobs: number; output: string } {
    const jobs = this.call((core) => core.islands_step(MAX_JOBS, this.limits.fuel));
    if (jobs < 0) this.status(-1);
    if (jobs > MAX_JOBS) throw new IslandsError("PROTOCOL_ERROR", "Core returned an invalid job count");
    return { jobs, output: this.output() };
  }

  destroy(): void {
    if (!this.#exports) return;
    try { this.call((core) => core.islands_destroy()); }
    finally { this.#exports = undefined; }
  }
}
