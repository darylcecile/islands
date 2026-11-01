import type { GuestMessage, HostMessage, JsonValue, WireResult } from "@islands/protocol";
import { validate, type MethodValidators } from "./contract.ts";
import { Core, MAX_JOBS } from "./core.ts";
import { engineError, IslandsError } from "./errors.ts";
import { encode, guestMessage, json, MAX_MESSAGE_BYTES, name } from "./json.ts";
import type { Capability, LoadedExtension, RuntimeLimits } from "./types.ts";
import type { LoadSettings } from "./validation.ts";

interface PendingOperation {
  resolve(value: JsonValue): void;
  reject(error: IslandsError): void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
}

interface PendingCall {
  signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
}

type Operation = Exclude<HostMessage, WireResult>;
type Request = Operation extends infer T ? T extends Operation ? Omit<T, "id"> : never : never;
type State = "loading" | "active" | "disposing" | "disposed";

export class Extension implements LoadedExtension {
  #id: string;
  #state: State = "loading";
  #core: Core | undefined;
  #code: string | undefined;
  #counter = 0;
  #operations = new Map<string, PendingOperation>();
  #calls = new Map<string, PendingCall>();
  #controller = new AbortController();
  #inbox: string[] = [];
  #inboxSize = 0;
  #scheduled = false;
  #pumping = false;
  #microTurns = 0;
  #cancelTurn: (() => void) | undefined;
  #workDeadline: number | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(
    id: string,
    module: WebAssembly.Module,
    private readonly limits: Readonly<Required<RuntimeLimits>>,
    private readonly capabilities: ReadonlyMap<string, Capability>,
    private readonly contracts: ReadonlyMap<string, MethodValidators> | undefined,
    private readonly settings: LoadSettings,
    private readonly onClose: () => void,
  ) {
    this.#id = id;
    this.#core = new Core(module, limits);
  }

  get id(): string { return this.#id; }

  async activate(code: string): Promise<void> {
    this.#code = code;
    try {
      await this.request({ type: "activate", config: this.settings.config });
      if (this.#state !== "loading") throw new IslandsError("DISPOSED", "Extension is disposed");
      this.#state = "active";
    } catch (cause) {
      const error = engineError(cause);
      // Runtime disposal owns cleanup while activation is being canceled.
      throw this.#state === "loading" ? this.close(error) : error;
    }
  }

  async invoke(method: string, input?: JsonValue): Promise<JsonValue> {
    this.assertActive();
    name(method, "Method name");
    return this.request({ type: "invoke", method, input: json(input) });
  }

  async emit(event: string, payload?: JsonValue): Promise<void> {
    this.assertActive();
    name(event, "Event name");
    await this.request({ type: "event", event, payload: json(payload) });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.#disposePromise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
    this.#state = "disposing";
    this.cancelPending(new IslandsError("DISPOSED", "Extension is disposing"));
    // Cleanup capabilities get their own bounded lifecycle after active work is aborted.
    this.#controller = new AbortController();
    this.#code = undefined;
    this.#workDeadline = undefined;
    void this.cleanup().then(resolve, reject);
    return this.#disposePromise;
  }

  private async cleanup(): Promise<void> {
    let reason = new IslandsError("DISPOSED", "Extension is disposed");
    try {
      await this.request({ type: "dispose" });
    } catch (cause) {
      reason = engineError(cause);
    }
    reason = this.close(reason);
    if (reason.code !== "DISPOSED") throw reason;
  }

  private assertActive(): void {
    if (this.#state !== "active") throw new IslandsError("DISPOSED", "Extension is not active");
  }

  private request(request: Request): Promise<JsonValue> {
    const id = `h${++this.#counter}`;
    const message = encode({ ...request, id });
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + this.limits.timeoutMs;
      const timer = setTimeout(() => this.timeout(), this.limits.timeoutMs);
      this.#operations.set(id, { resolve, reject, timer, deadline });
      try {
        this.enqueue(message);
      } catch (cause) {
        clearTimeout(timer);
        this.#operations.delete(id);
        reject(cause);
      }
    });
  }

  private enqueue(message: string): void {
    if (this.#state === "disposed") return;
    // Bound host-side buffering as well as the core outbox and active callbacks.
    if (this.#inbox.length >= 1024 || this.#inboxSize + message.length * 2 > 4 * MAX_MESSAGE_BYTES) {
      throw new IslandsError("PENDING_LIMIT", "Too many queued extension messages");
    }
    this.#inbox.push(message);
    this.#inboxSize += message.length * 2;
    if (!this.#pumping) this.schedule();
  }

  private schedule(yieldTurn = false): void {
    if (this.#scheduled || this.#state === "disposed") return;
    this.#scheduled = true;
    if (!yieldTurn && ++this.#microTurns < 8) {
      queueMicrotask(() => this.pump());
      return;
    }
    // A one-shot continuation for known runnable work, never an idle polling loop.
    // MessageChannel does not reliably yield to timers across JS hosts (notably Bun).
    const timer = setTimeout(() => {
      this.#cancelTurn = undefined;
      this.#microTurns = 0;
      this.pump();
    }, 0);
    this.#cancelTurn = () => clearTimeout(timer);
  }

  private pump(): void {
    this.#scheduled = false;
    if (!this.#core || this.#state === "disposed") return;
    this.#pumping = true;
    const settlements: WireResult[] = [];
    this.#workDeadline ??= performance.now() + this.limits.timeoutMs;
    try {
      this.checkDeadlines();
      if (this.#code !== undefined) {
        const code = this.#code;
        this.#code = undefined;
        this.receive(this.#core.evaluate(code), settlements);
      }
      // Snapshot the batch; guest replies produced during it enter the next batch.
      const batch = this.#inbox.splice(0, MAX_JOBS);
      for (const message of batch) {
        this.#inboxSize -= message.length * 2;
        this.checkDeadlines();
        this.receive(this.#core.dispatch(message), settlements);
      }
      const step = this.#core.step();
      this.receive(step.output, settlements);
      this.checkDeadlines();
      // A core failure or elapsed deadline in this batch must win over its success envelopes.
      for (const result of settlements) this.settle(result);
      const runnable = step.jobs === MAX_JOBS || this.#inbox.length > 0;
      if (runnable) this.schedule(true);
      else this.#workDeadline = undefined;
    } catch (cause) {
      this.close(engineError(cause));
    } finally {
      this.#pumping = false;
    }
  }

  private receive(output: string, settlements: WireResult[]): void {
    if (!output) return;
    const lines = output.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      const message = guestMessage(line);
      if (message.type === "result") settlements.push(message);
      else this.call(message);
    }
  }

  private settle(result: WireResult): void {
    const pending = this.#operations.get(result.id);
    if (!pending) return; // A result may arrive after disposal canceled an operation.
    this.#operations.delete(result.id);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.value);
    else pending.reject(new IslandsError(result.error.code, result.error.message));
  }

  private call(message: Extract<GuestMessage, { type: "call" }>): void {
    if (this.#calls.has(message.id)) throw new IslandsError("PROTOCOL_ERROR", "Duplicate pending host-call id");
    const capability = this.capabilities.get(message.method);
    const contract = this.contracts?.get(message.method);
    try {
      if (!capability || !this.settings.grants.has(message.method)) throw new IslandsError("CAPABILITY_DENIED", `Capability is not granted: ${message.method}`);
      if (this.contracts && !contract) throw new IslandsError("CONTRACT_METHOD", `Capability is absent from the host contract: ${message.method}`);
      if (this.#calls.size >= this.limits.maxPendingCalls) throw new IslandsError("PENDING_LIMIT", "Too many pending host calls");
      validate(contract?.input, message.input, "INVALID_ARGUMENT");
    } catch (cause) {
      this.replyError(message.id, cause);
      return;
    }
    const pending: PendingCall = {
      signal: this.#controller.signal,
      deadline: performance.now() + this.limits.timeoutMs,
      timer: setTimeout(() => this.timeout(), this.limits.timeoutMs),
    };
    this.#calls.set(message.id, pending);
    // User callbacks never execute on a WASM stack and never hold the pump across an await.
    queueMicrotask(() => { void this.runCall(message, capability!, contract, pending); });
  }

  private async runCall(
    message: Extract<GuestMessage, { type: "call" }>, capability: Capability,
    contract: MethodValidators | undefined, pending: PendingCall,
  ): Promise<void> {
    if (this.#calls.get(message.id) !== pending) return;
    try {
      const value = await capability(message.input, Object.freeze({
        extensionId: this.#id, metadata: this.settings.metadata, signal: pending.signal,
      }));
      if (this.#calls.get(message.id) !== pending) return;
      this.checkDeadlines();
      const result = json(value);
      validate(contract?.output, result, "INVALID_RESULT");
      this.enqueue(encode({ type: "result", id: message.id, ok: true, value: result }));
    } catch (cause) {
      if (this.#calls.get(message.id) !== pending) return;
      if (cause instanceof IslandsError && cause.code === "TIMEOUT") this.close(cause);
      else {
        try { this.replyError(message.id, cause); }
        catch (error) { this.close(engineError(error)); }
      }
    } finally {
      clearTimeout(pending.timer);
      if (this.#calls.get(message.id) === pending) this.#calls.delete(message.id);
    }
  }

  private replyError(id: string, cause: unknown): void {
    const code = cause instanceof IslandsError ? cause.code : "HOST_ERROR";
    const message = cause instanceof Error ? cause.message.slice(0, 4096) : "Host capability failed";
    this.enqueue(encode({ type: "result", id, ok: false, error: { code, message } }));
  }

  private checkDeadlines(): void {
    const now = performance.now();
    if (this.#workDeadline !== undefined && now >= this.#workDeadline) throw new IslandsError("TIMEOUT", "Guest job deadline exceeded");
    for (const pending of this.#operations.values()) {
      if (now >= pending.deadline) throw new IslandsError("TIMEOUT", "Extension operation timed out");
    }
    for (const pending of this.#calls.values()) {
      if (now >= pending.deadline) throw new IslandsError("TIMEOUT", "Host capability timed out");
    }
  }

  private timeout(): void { this.close(new IslandsError("TIMEOUT", "Extension operation timed out")); }

  private cancelPending(reason: IslandsError): void {
    for (const pending of this.#operations.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#operations.clear();
    const calls = [...this.#calls.values()];
    this.#calls.clear();
    this.#inbox = [];
    this.#inboxSize = 0;
    for (const pending of calls) {
      clearTimeout(pending.timer);
    }
    this.#controller.abort(reason);
  }

  private close(reason: IslandsError): IslandsError {
    if (this.#state === "disposed") return reason;
    this.#state = "disposed";
    this.cancelPending(reason);
    this.#cancelTurn?.();
    this.#cancelTurn = undefined;
    this.#code = undefined;
    const core = this.#core;
    this.#core = undefined;
    try { core?.destroy(); }
    catch (cause) { if (reason.code === "DISPOSED") reason = engineError(cause); }
    finally { this.onClose(); }
    return reason;
  }
}
