# Working on Islands

Islands is an embeddable extension runtime. Keep the core protocol portable across JavaScript, browsers, Go, and Python. See `docs/protocol.md` for the shared ABI and wire contract.

- Keep host policy outside guest-controlled memory. Never trust an extension-supplied identity or grant.
- Host loaders own YAML/JSON semantics; authoring tools compile TypeScript without evaluating extension code in the host.
- Keep the WASM runtime free of ambient filesystem and network access.
- Finish coherent changes before running checks. Use `bun run typecheck`, `bun test`, and the documented example commands.
- Keep package APIs and executable documentation examples in sync.
- Do not claim a sandbox profile or platform is supported without exercising it.

Coordination notes are in `.groundwork/tasks/`; they are local and ignored.
