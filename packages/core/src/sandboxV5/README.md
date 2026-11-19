# Sandbox v5 — per-bot runtime fleet (v1.37, Team T3)

One layer above sandbox v4. V4 gives a per-conversation runtime
(v3 session + agent profile + budget meter + secret requests +
dependency map). V5 manages the runtime **fleet** for every bot.

## What it does

- **Per-bot runtime choice** (`runtimeTiers.ts`, `runtimeChoice.ts`) —
  every bot picks its own isolation tier (`local` / `bwrap` /
  `syscall-policy` / `microvm` / `vm`) plus an agent profile.
  The choice is stored per bot in `runtime-choices.json`
  (atomic write) and survives restarts. A tier weaker than the
  minimum for the bot's trust, or a tier the host cannot run,
  is refused at set time — never silently downgraded.
- **Safe tier switch** (`runtimeSwitch.ts`) — changing tiers
  while a bot runs goes through one ordered pipeline:
  validate → quiesce (drain in-flight runs) → snapshot state →
  stop old → start new → restore state → verify → done.
  Any failure after `stop-old` rolls back to the old tier;
  the choice store is only updated after the new tier is
  verified live. Every step is journaled
  (`switch-journal.jsonl`). Downgrades need an explicit reason.
- **Idle archiving** (`archive.ts`) — a runtime idle past its
  threshold is archived, not deleted: its workspace is packed
  (`tar.gz` when `tar` exists, plain copy otherwise) next to a
  `meta.json` that carries NO secret. Secret-like files
  (`.env*`, `*.pem`, `*.key`, `credentials*`, `auth/`) are
  excluded from the pack and listed by name only. Restore
  verifies the payload hash BEFORE unpacking.
- **Disk budget** (`diskBudget.ts`) — the sandbox tree has a
  total budget with a safety headroom that is never spent.
  Over budget, caches are reclaimed first (oldest / least-used
  / largest first, per cache root), then gitignored directories
  (`node_modules`, `dist`, …) are shed — never user files,
  never anything outside the configured roots. `planReclaim`
  is a dry-run; `executeReclaim` logs every removal to
  `reclaim.jsonl`.
- **Profile-scoped secrets** (`profileSecrets.ts`) — a secret is
  granted to exactly one (bot, run, profile) triple, with a TTL
  and a use budget. The value lives in MEMORY ONLY and is never
  written to disk, to a log, or into a report. Ending a run
  (`revokeRun`) revokes every grant of that run. Every grant /
  consume / revoke / expiry is written to a hash-chained audit
  log (metadata only); `verifyAuditChain` detects tampering.

## State files (under the v5 base dir, default OS temp / open-bot-sandbox-v5)

| File | Contents |
| --- | --- |
| `runtime-choices.json` | per-bot tier + profile choices |
| `bot-runtimes.json` | live per-bot runtime records |
| `switch-journal.jsonl` | tier-switch journal (append-only) |
| `archives/<id>/meta.json` + payload | one archive per directory |
| `reclaim.jsonl` | disk reclaim log (append-only) |
| `secret-grants.json` | grant metadata only (no values) |
| `secret-audit.jsonl` | hash-chained secret audit log |

## Entry point

`SandboxV5Service` (`service.ts`) wires the five subsystems
together. Tools live in `packages/tools/src/sandboxV5Tools.ts`
(`sandbox_v5_*`, 19 tools).

## Ideas only

Per-bot computer tiers and CIDR sandbox rules in recent CLI
releases, as summarised in `docs/repo-survey-v137.md` — no code,
text or asset copied from any repo, xAI or Cursor.
