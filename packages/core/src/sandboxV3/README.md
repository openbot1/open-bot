# Sandbox v3 — deep sandbox (v1.35, Team T2)

Work in progress. Mirrors the `sandboxV2/` layout:

- `types.ts` — shared types
- `syscallAllowlist.ts` — per-tier syscall allowlist
- `egressPolicy.ts` — egress (outbound network) policy gate
- `lifetime.ts` — lifetime cap + auto-stop
- `snapshot.ts` — copy-on-write snapshots
- `lifecycle.ts` — pause / resume state machine
- `hooks.ts` — PreToolUse / PostToolUse hooks
- `policy.ts` — combined v3 policy (parse / validate / builtins)
- `runner.ts` — session runner tying it together
- `index.ts` — barrel

Ideas only from the Claude Agent SDK permission modes / hooks and the
OpenAI Agents SDK sandbox execution model — no code, text or asset
copied from any repo, xAI or Cursor.
