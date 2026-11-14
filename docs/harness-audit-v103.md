# Harness audit — v1.03 (Team T3, 14/11/2026)

Audit of open-bot against the 29-pattern catalog of the Harness
Engineering survey (`docs/repo-survey-v103.md` §2: 11 production
harnesses, 7 subsystems, 29 recurring design patterns). Only ideas
were taken from the survey; no code, text or assets were copied from
any repo. The machine-readable catalog lives in
`packages/core/src/acp/harnessAudit.ts` (`auditHarnessPatterns()`);
this document is the human-readable report generated from the same
scores. Status meanings: **present** = implemented and tested in
this repo; **partial** = the shape exists but a named piece is still
owned by another team; **missing** = no implementation exists yet.

## Score

**20 present / 7 partial / 2 missing (29 total)**

| Subsystem | Present | Partial | Missing | Total |
| --- | --- | --- | --- | --- |
| Agent loop | 3 | 1 | 1 | 5 |
| Tools | 4 | 0 | 1 | 5 |
| Context management | 3 | 1 | 0 | 4 |
| Safety & permissions | 3 | 1 | 0 | 4 |
| Orchestration & multi-agent | 3 | 1 | 0 | 4 |
| Extension surfaces | 4 | 0 | 0 | 4 |
| Observability & persistence | 1 | 2 | 0 | 3 |

## 1. Agent loop

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P01 | Event-sourced conversation | **missing** | Event log + ACP session store exist as parts, but the conversation is not a replayable stream of immutable events with the agent as a pure function over history. Owner: **T1** (harness engine v2, this wave). |
| P02 | Turn loop with stop conditions | present | `coordinator.ts`, `acp/agentServer.ts` — turns end on end_turn / max_tokens / max_turn_requests / refusal / cancelled. |
| P03 | Streaming updates to the client | present | `acp/types.ts` (`AcpSessionUpdate`), `harness/bus.ts` — message / thought / tool_call / plan / usage chunks stream to the client. |
| P04 | Cancellation / abort | present | `acp/transport.ts` (`$/cancel_request`, −32800) — AbortSignal cancels a running turn; covered by the transport test. |
| P05 | Stuck detection | partial | **Supplemented this wave** (`acp/patterns.ts`, `SignatureStuckDetector`): repeated identical tool call / no-progress turns / token burn since last progress. Pure function over turn records. The loop does not yet consult it every turn — that wiring belongs to **T1**'s engine v2. |

## 2. Tools

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P06 | Typed tool registry | present | `tools/src/registry.ts`, `defaultToolFactory` — 259 tools at v1.02 (263 after this wave, see below); duplicate names rejected. |
| P07 | Action → execution → observation contract | present | `core/src/types.ts` (`Tool`, `ToolContext`), `acp/types.ts` — every tool call returns a truncated string observation; ACP reports tool calls as structured updates with status transitions. |
| P08 | CodeAct-style unified code execution | **missing** | No single bash+python+editor code-execution tool yet; shell, file and edit tools are separate. Owner: **T1** (CodeAct tool, this wave). |
| P09 | MCP tool mounting | present | `core/src/mcp/`, `tools/src/mcpTools.ts`, `mcpV097Tools.ts` — MCP servers mount as tools; `session/new` carries `mcpServers` per ACP session. |
| P10 | Tool-result truncation & redaction | present | `tools/src/truncate.ts` (20_000 chars), `harness/ndjson.ts` (`sanitizeHarnessPayload`) — logs record tool-call argument names only, never values. |

## 3. Context management

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P11 | Token-budget tracking | present | `core/src/context/` (`CompactionHistory`, `PromptCacheTracker`, `DEFAULT_RESERVE_TOKENS`) — per-model limits, reserve tokens, per-turn usage. |
| P12 | Context compaction / condenser | partial | **Supplemented this wave** (`acp/patterns.ts`, `ThresholdCompactionAdvisor`): when to compact (usage ≥ 80% or 25 turns since last compaction). The condenser itself — how to compact — is **T1**'s. |
| P13 | Memory blocks (persona / human) | present | `core/src/memory/` (blocks v2, v0.96), `memoryBlockTools.ts` — Letta-style blocks always in context, editable by tool. Shared blocks cross-agent are **T2** (memory v4, this wave). |
| P14 | Code retrieval without vector embeddings | present | Repo map by PageRank (v0.96). Matches the survey finding that no harness retrieves code by vector embeddings. |

## 4. Safety & permissions

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P15 | Fail-closed permission broker | present | `harness/broker.ts` — no UI handler → deny immediately; timeout → deny; every decision logged with its source. ACP allow works (`allow_once`); Codex allow is honestly unsupported and always denies. |
| P16 | Pre-tool-call security review | partial | **Supplemented this wave** (`acp/patterns.ts`, `DenyListSecurityReviewer`): denies `rm -rf`, `curl|sh`, credential-file paths, fork bombs, env dumping; shell tools always go to human review. A backstop, not a sandbox — the permission broker stays the approval authority. |
| P17 | Secret redaction in logs & events | present | `harness/ndjson.ts`; session files written mode 0600 (`acp/sessionStore.ts`). |
| P18 | Sandbox / workspace isolation | partial | Sandbox hardening v2 exists (v0.99), but there is no Workspace abstraction swapping a local directory for a container with quotas and snapshots. Owner: **T4** (workspace/sandbox v3, this wave). |

## 5. Orchestration & multi-agent

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P19 | Sub-agent delegation | partial | **Supplemented this wave** (`acp/patterns.ts`, `AcpSubAgentDelegator`): one subtask = one prompt turn on a hosted ACP backend; only the result text returns, so the parent context never grows with the subtask's working. In-process sub-agents and graded fan-out already exist (`subagents/`). The parent loop does not yet route subtasks through the delegator by default. |
| P20 | Multi-agent fan-out with grading | present | `subagents/fanout.ts`, `subagents/grader.ts` (v1.01) — parallel sub-agents, rubric grading, rework rounds. |
| P21 | ACP hosting of external harnesses | present | **New this wave** (`acp/hosting.ts` `AcpHost`, `acp/backends.ts`): detect → probe (real `initialize` handshake, never a `--version` match) → spawn → session → prompt, with fallback order and bounded lazy restart, for 9 backends (Gemini CLI, OpenCode, Grok CLI, Cursor, Copilot, Devin, Claude Code, Codex, Zed). Previously only the client side existed, with no host layer. |
| P22 | Inter-agent protocol (A2A) | present | `core/src/a2a/` (v0.97) — client/server with signing, tasks, push, history; ACP sessions bridge in via the A2A adapter runner. |

## 6. Extension surfaces

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P23 | Plugin system (load + permissions) | present | `tools/src/plugins/loader.ts`, `manager.ts` — manifest validation, require allowlist, capability-vs-permission source scan. Plugins run in-process (documented honest limit). |
| P24 | Claude Code plugin-format compat | present | **New this wave** (`acp/pluginFormat.ts`): read-only parse/validate/scan of `.claude-plugin/plugin.json` + `marketplace.json` + `commands/` / `agents/` / `skills/` markdown + `hooks/hooks.json`, mapped onto open-bot plugin records (`claude-plugin:<name>`). Hooks are metadata-only; plugin code is never executed. |
| P25 | Agent Skills (SKILL.md) | present | `core/src/skills/` (v0.99); the plugin-format scanner also reads `skills/SKILL.md`. |
| P26 | Marketplace with signing | present | `core/src/plugins/catalog.ts` (v0.92/0.93) — signed marketplace entries; the Claude Code `marketplace.json` reader reuses the same record shape. |

## 7. Observability & persistence

| ID | Pattern | Status | Evidence / note |
| --- | --- | --- | --- |
| P27 | NDJSON event log + replay | present | `harness/ndjson.ts`, `harness/v2/eventExport.ts` — per-thread versioned NDJSON (rotate + prune, paged read); ACP sessions replay recorded messages on `load`. |
| P28 | Snapshot / restore (+ fork / time-travel) | partial | Atomic snapshots restore display state; sessions restore. Fork and time-travel need the event-sourced engine (P01). Owner: **T1**. |
| P29 | Health probes & eval harness | partial | Per-bot-computer health probes exist (`harness/v2/healthProbe.ts`) and are exposed as tools. The eval-harness UI that turns probes into scored runs is **T6**'s (this wave). |

## What changed in v1.03 (T3)

- **P21** partial → present: `AcpHost` + backend registry (9 backends).
- **P24** missing → present: Claude Code plugin-format compat.
- **P05, P12, P16, P19** missing/partial → partial, with an interface + reference implementation each in `acp/patterns.ts` so the owning teams can wire them without T3 touching their code.
- **P01, P08** remain missing — owned by T1 this wave (event-sourced engine, CodeAct tool). P18 remains partial — owned by T4 (Workspace abstraction).

## Honest limits

- **Claude Code / Codex argv are probe-gated, not verified.** Their ACP spawn args (`claude --acp`, `codex acp`) follow the survey's hosting claim, but no driver in this repo spawns them over ACP yet, so `AcpHost` only reports them available after a real `initialize` handshake answers. On this machine neither binary is installed, so both report "not found on PATH".
- **No live run against a real external harness.** All hosting tests use the fake ACP binary (`tests/fixtures/fake-acp-generic.mjs`). Real-backend behaviour (permission-request shapes, turn behaviour after allow, session resume) is still unverified — same caveat the harness README already records for the permission broker.
- **Restart is lazy, not watched.** `AcpHost` notices a dead backend on the next prompt and restarts it (bounded, default 2 restarts); there is no background watcher, by design — no timer runs on the turn path.
- **The four supplemented patterns are thresholds and deny-lists, not intelligence.** The stuck detector counts repeats, the reviewer matches regexes, the compaction advisor watches ratios. They are safe defaults, not replacements for the owning engines' real implementations.
- **The audit is a self-assessment.** Statuses were scored against the survey's definitions by reading this repo's modules, not by an independent measurement of the 11 surveyed harnesses (their source was not re-read here).

## Tests

`tests/acp-hosting-v103.test.mjs` — backends registry, `AcpClient.setMode`, hosting against the fake ACP binary (probe / start / prompt / health / stop / fallback / lazy restart / relative-cwd rejection), plugin-format parse/scan/map, all four supplemented patterns, the audit counts, and the four new tools (including the workspace-escape refusal of `acp_plugin_import`).

## New tools (registry)

`acp_host_list` (read-only), `acp_host_prompt` (needs approval — spawns a real backend process, one-shot), `acp_host_audit` (read-only), `acp_plugin_import` (read-only). Registered in `defaultToolFactory` via `createAcpHostingTools`, next to the harness v2 tools. Registry grows 259 → **263 tools**.

## i18n

8 new keys (`acpHost.*`) in all 6 locales (en/vi/es/fr/ja/zh): 2799 → **2807 keys/locale**.
