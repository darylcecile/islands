# Security and resource limits

Islands runs extension JavaScript in a separate WebAssembly instance and exposes application operations through explicit JSON capabilities. **The host owns permissions, identity, and resource policy.**

Both policy presets use the same QuickJS-in-WASM engine. Neither creates an OS process, a container, or an independent security principal in your operating system.

## What crosses the boundary

Only JSON values cross the host/extension boundary. The guest does not receive host objects, function references, database connections, filesystem handles, or a DOM reference. The core has no ambient filesystem or network access; its WASI setup does not preopen directories or expose sockets.

An extension can request only capabilities registered by the host and allowed by that instance's host-owned policy. A manifest's `requires` list is a request, not a grant. The host checks required capabilities before evaluating any extension code, including top-level code in the bundle.

The manifest ID is not authentication. A malicious author can choose an ID; your installation or registry layer must decide who may install or update that ID. IDs are unique among loaded instances in a runtime.

## Policy presets

| Policy | Capability access | Execution environment |
| --- | --- | --- |
| `sandboxed` (default) | Only methods listed in host-supplied `grants`; defaults to none. | QuickJS in its own WASM instance, with configured limits. |
| `trusted` | All capabilities registered with the runtime at load time. | The same engine and limits. |

```ts
const extension = await runtime.load(artifact, {
  policy: "sandboxed",
  grants: ["documents.read", "notifications.show"],
  metadata: { tenantId: authenticatedTenant.id },
});
```

`authenticatedTenant` above comes from your application's authentication flow. Do not fill authoritative metadata from an extension manifest or an unverified request body.

Use `trusted` only when intentionally granting the entire runtime's registered API surface. It is a permission shortcut, not a faster execution mode or an escape from the WASM boundary. An invalid policy name is rejected.

## Authorize resources, not only method names

Granting `documents.read` answers “may this extension request this operation?” The host still needs to answer “may this instance read this document?”

A capability implementation should use host-bound context to establish scope:

```ts
// Integration sketch: these storage helpers belong to your application.
"documents.read": async (input, context) => {
  const documentId = parseDocumentId(input);
  const tenantId = requireTenantId(context.metadata);

  return readAuthorizedDocument({
    tenantId,
    extensionId: context.extensionId,
    documentId,
    signal: context.signal,
  });
}
```

Validate input shapes before use, constrain requested resources to the authenticated scope, and return only data the extension should see. Optional JSON Schema contracts validate capability inputs and outputs; they do not implement row-level authorization.

Broad capabilities such as arbitrary SQL, arbitrary filesystem paths, unrestricted HTTP fetch, or shell execution transfer substantial authority to the extension. Prefer purpose-specific methods when your product needs narrower access. If your application exposes network access, its implementation owns destination policy, credentials, response-size limits, and cancellation.

## Limits measure different things

The JavaScript SDK accepts `limits` in `createRuntime`. ABI defaults are:

| Limit | Default | What it bounds |
| --- | --- | --- |
| `memoryBytes` | 16 MiB | QuickJS heap allocation, not all host or WASM memory. |
| `stackBytes` | 512 KiB | Guest engine stack budget. |
| `fuel` | 10,000 | QuickJS interrupt callbacks per eval, dispatch, or job-step call. |
| `timeoutMs` | 5,000 ms | Host adapter's operation deadline, including waits for host work. |
| `maxPendingCalls` | 64 | Outstanding host-capability callbacks in the active lifecycle. |

The protocol also specifies a 1 MiB core outbox limit, a built-core linear-memory maximum of 128 MiB, and a default batch size of 256 pending jobs per step. See [the protocol](protocol.md) and each adapter's options for the boundary between core limits and adapter-specific enforcement.

### CPU fuel is not a wall clock

Fuel counts calls to the QuickJS interrupt handler. It is **not** a count of WASM instructions, JavaScript statements, or milliseconds. Different workloads can do different amounts of work for the same fuel budget. Each core eval, dispatch, and step receives a fresh budget; it is not a lifetime quota for the extension.

Fuel lets the core interrupt guest execution. An operation deadline additionally bounds how long the adapter waits for completion, including asynchronous host calls. In a JavaScript host, synchronous WASM work occupies the calling thread until it yields or hits an engine limit; a timer cannot preempt that thread at an exact millisecond.

For a responsive browser or desktop UI, place the runtime in a worker when appropriate. That isolates scheduling from the UI thread, not authorization from the host. For stronger process-level containment, your application must supply a process or service boundary.

### Host work is outside the guest budget

A guest request can cause host allocations, network traffic, database queries, or expensive computation. None of those becomes part of the QuickJS heap or fuel accounting simply because the request originated in an extension.

Capability implementations must observe the provided cancellation signal and apply their own deadlines, response-size limits, concurrency controls, and tenant quotas. Disposal or timeout cannot undo a database write or forcibly stop synchronous host code. Model side effects with this in mind—for example, use application-level idempotency keys when retries may repeat a write.

## Cleanup and failure

- Always dispose instances when their application lifetime ends. `runtime.dispose()` disposes the runtime's instances.
- Guest cleanup is bounded. Host-owned cancellation and pending-operation cleanup still run if guest cleanup throws or fails to finish.
- Disposal cancels ordinary host work before running guest cleanup. Cleanup has a fresh bounded callback quota; work that ignores cancellation may still be running outside that quota and needs host-owned concurrency controls.
- Results from host callbacks that finish after disposal are discarded; host callbacks may still be running if they ignore cancellation.
- Engine failure poisons the instance. Recover by making an application-level decision to load a fresh instance, rather than reusing the failed one.
- Validate bundle size and loader input size before expensive authoring or loading work. The guest's limits do not bound the application's parser, compiler, artifact storage, or delivery pipeline.

## Trusting the core and the supply chain

Use the built `dist/islands.wasm` from the pinned core build. A host-supplied WASM module is part of your trusted runtime, not an extension artifact. Extension artifacts contain bundled JavaScript source; they must never be evaluated with host `eval`, imported as host modules, or treated as trusted WASM replacements.

Application-specific YAML/JSON loaders are host code. Parse data with explicit schemas, decide which fields become config or generated code, and keep identity and grants in host-owned installation policy. Do not take a document's declaration of trust as authority to grant it privileges.

Authoring tools use the build process's filesystem permissions. Bundling resolves imports relative to the entry point or `resolveDir`; that stage belongs in a host-controlled build environment with access to the intended package files. The WASM boundary begins when the resulting artifact is loaded.

TypeScript's types are an authoring aid. They do not replace runtime validation, grant checks, or application authorization. The core and adapters are security-sensitive code and should be reviewed and exercised for the platform and profile you deploy; the presence of an adapter is not evidence of certification or a security audit.

For implementation details, see [architecture](architecture.md) and the [protocol's boundary policy](protocol.md#boundary-policy).
