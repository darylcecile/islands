/* Standalone QuickJS bridge, embedded by the C core. No imports or host APIs. */
(function () {
  "use strict";

  const send = globalThis.__islands_send;
  const handlers = new Map();
  const subscriptions = new Map();
  const pending = new Map();
  let state = "new";
  let nextId = 0;
  let cleanup;
  let activation;
  let disposal;

  function fault(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function wireError(error) {
    try {
      return {
        code: error && typeof error.code === "string" ? error.code : "EXTENSION_ERROR",
        message: error && typeof error.message === "string" ? error.message : String(error),
      };
    } catch (_) {
      return { code: "EXTENSION_ERROR", message: "Extension threw an unreadable error value" };
    }
  }

  function name(value, label) {
    if (typeof value !== "string" || !value.trim()) throw fault("INVALID_ARGUMENT", label + " must be a non-empty string");
  }

  // Clone before stringifying: never silently discard undefined, functions, sparse
  // slots, or symbols; never run toJSON hooks. Only omitted top-level values are null.
  function json(value, path, parents) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw fault("INVALID_JSON", path + " must be a finite JSON number");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw fault("INVALID_JSON", path + " must be a safe integer in [-9007199254740991, 9007199254740991]; use strings for larger IDs");
      }
      return value;
    }
    if (typeof value !== "object" || value === null) throw fault("INVALID_JSON", path + " must be JSON data");
    if (parents.has(value)) throw fault("INVALID_JSON", path + " contains a circular reference");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw fault("INVALID_JSON", path + " must be a plain JSON object");
    }
    parents.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some(function (key) { return typeof key === "symbol"; })) {
        throw fault("INVALID_JSON", path + " contains a symbol key");
      }
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) throw fault("INVALID_JSON", path + " must be a dense JSON array");
        return Array.from({ length: value.length }, function (_, index) {
          const descriptor = descriptors[index];
          if (!descriptor || !("value" in descriptor)) throw fault("INVALID_JSON", path + "[" + index + "] must be JSON data");
          return json(descriptor.value, path + "[" + index + "]", parents);
        });
      }
      const result = Object.create(null);
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor)) throw fault("INVALID_JSON", path + "." + key + " must be JSON data");
        result[key] = json(descriptor.value, path + "." + key, parents);
      }
      return result;
    } finally {
      parents.delete(value);
    }
  }

  function boundary(value) {
    return json(value === undefined ? null : value, "$", new Set());
  }

  function release() {
    handlers.clear();
    subscriptions.clear();
    rejectPending();
  }

  function rejectPending() {
    const error = fault("DISPOSED", "Extension has been disposed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function canRegister() {
    if (state !== "activating" && state !== "active") throw fault("INVALID_STATE", "Cannot register while extension is " + state);
  }

  function call(method, input) {
    return new Promise(function (resolve, reject) {
      if (state !== "activating" && state !== "active" && state !== "disposing") {
        throw fault("DISPOSED", "Cannot call host while extension is " + state);
      }
      name(method, "Method");
      const value = boundary(input);
      const id = "g" + ++nextId;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        // Authorization and the pending-call bound are enforced outside guest memory.
        send(JSON.stringify({ type: "call", id: id, method: method, input: value }));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function handle(method, handler) {
    canRegister();
    name(method, "Method");
    if (typeof handler !== "function") throw fault("INVALID_ARGUMENT", "Method handler must be a function");
    if (handlers.has(method)) throw fault("DUPLICATE_HANDLER", "Handler already registered for " + method);
    const registration = { handler: handler };
    handlers.set(method, registration);
    return function () {
      if (handlers.get(method) === registration) handlers.delete(method);
    };
  }

  function on(event, handler) {
    canRegister();
    name(event, "Event");
    if (typeof handler !== "function") throw fault("INVALID_ARGUMENT", "Event handler must be a function");
    let listeners = subscriptions.get(event);
    if (!listeners) {
      listeners = new Set();
      subscriptions.set(event, listeners);
    }
    const registration = { handler: handler };
    listeners.add(registration);
    return function () {
      listeners.delete(registration);
      if (listeners.size === 0 && subscriptions.get(event) === listeners) subscriptions.delete(event);
    };
  }

  async function activate(config) {
    if (state !== "new") throw fault("INVALID_STATE", "Cannot activate while extension is " + state);
    state = "activating";
    try {
      const definition = globalThis.__islands_extension && globalThis.__islands_extension.default;
      if (!definition || typeof definition.activate !== "function") {
        throw fault("INVALID_EXTENSION", "Extension must default-export an object with activate(context)");
      }
      const context = Object.freeze({ config: boundary(config), call: call, handle: handle, on: on });
      activation = Promise.resolve().then(function () { return definition.activate(context); }).then(function (result) {
        if (result !== undefined && typeof result !== "function") {
          throw fault("INVALID_EXTENSION", "activate must return nothing or a cleanup function");
        }
        cleanup = result;
      });
      await activation;
      if (state !== "activating") throw fault("DISPOSED", "Extension was disposed during activation");
      state = "active";
      return null;
    } catch (error) {
      if (state === "activating") {
        state = "failed";
        release();
      }
      throw error;
    }
  }

  async function invoke(method, input) {
    name(method, "Method");
    const registration = handlers.get(method);
    if (!registration) throw fault("METHOD_NOT_FOUND", "No handler registered for " + method);
    return boundary(await registration.handler(boundary(input)));
  }

  async function emit(event, payload) {
    name(event, "Event");
    const listeners = subscriptions.get(event);
    if (!listeners) return null;
    const value = boundary(payload);
    for (const registration of Array.from(listeners)) {
      if (listeners.has(registration)) await registration.handler(value);
    }
    return null;
  }

  function dispose() {
    if (disposal) return disposal;
    state = "disposing";
    rejectPending();
    disposal = (async function () {
      try {
        // An interrupted activate can still return a cleanup function.
        if (activation) await activation.catch(function () {});
        if (cleanup) await cleanup();
        return null;
      } finally {
        cleanup = undefined;
        state = "disposed";
        release();
      }
    })();
    return disposal;
  }

  function settle(message) {
    const request = pending.get(message.id);
    if (!request) return; // Late results after disposal are harmless.
    pending.delete(message.id);
    if (message.ok === true) request.resolve(boundary(message.value));
    else if (message.ok === false && message.error && typeof message.error.code === "string" && typeof message.error.message === "string") {
      request.reject(fault(message.error.code, message.error.message));
    } else request.reject(fault("INVALID_MESSAGE", "Malformed host result for " + message.id));
  }

  async function dispatch(message) {
    if (message.type === "activate") return activate(message.config);
    if (message.type === "dispose") return dispose();
    if (message.type !== "invoke" && message.type !== "event") throw fault("INVALID_MESSAGE", "Unknown message type: " + message.type);
    if (state !== "active") throw fault("INVALID_STATE", "Cannot " + message.type + " while extension is " + state);
    if (message.type === "invoke") return invoke(message.method, message.input);
    return emit(message.event, message.payload);
  }

  globalThis.__islands_receive = function (text) {
    const message = JSON.parse(text);
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string" || typeof message.id !== "string") {
      throw fault("INVALID_MESSAGE", "Expected a message object with type and id");
    }
    const prefix = message.type === "result" ? "g" : "h";
    if (!message.id.startsWith(prefix) || message.id.length < 2) throw fault("INVALID_MESSAGE", "Invalid request id: " + message.id);
    if (message.type === "result") {
      settle(message);
      return;
    }
    dispatch(message).then(function (value) {
      send(JSON.stringify({ type: "result", id: message.id, ok: true, value: value }));
    }, function (error) {
      send(JSON.stringify({ type: "result", id: message.id, ok: false, error: wireError(error) }));
    });
  };
})();
