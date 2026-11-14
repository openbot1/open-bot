/**
 * Harness audit (v1.03, Team T3) — open-bot vs the 29-pattern
 * catalog of the Harness Engineering survey
 * (`docs/repo-survey-v103.md` §2: 11 production harnesses, 7
 * subsystems, 29 recurring design patterns).
 *
 * This module is the *checklist*, not the engine: each pattern has
 * one status for open-bot as it stands after this wave
 * (`present` / `partial` / `missing`), evidence pointing at the
 * module that implements it (or the team that owns the gap), and an
 * owner note. Statuses are a self-assessment against the survey's
 * definitions — "present" means the pattern is implemented and
 * tested in this repo, "partial" means the shape exists but a named
 * piece is still owned by another team, "missing" means no
 * implementation exists yet.
 *
 * The four patterns this wave supplements without touching the
 * owning teams' code live in `patterns.ts` (interfaces + reference
 * implementations): stuck detection (P05), security review (P16),
 * sub-agent delegation (P19) and context compaction (P12).
 */

export type HarnessSubsystem =
  | 'loop'
  | 'tools'
  | 'context'
  | 'safety'
  | 'orchestration'
  | 'extensions'
  | 'observability';

export const HARNESS_SUBSYSTEMS: Array<{ id: HarnessSubsystem; name: string; description: string }> = [
  { id: 'loop', name: 'Agent loop', description: 'The turn loop: events in, next action out, stop conditions, cancellation.' },
  { id: 'tools', name: 'Tools', description: 'Typed tool registry, the action → execution → observation contract, code execution.' },
  { id: 'context', name: 'Context management', description: 'Token budgets, compaction, memory blocks, code retrieval without embeddings.' },
  { id: 'safety', name: 'Safety & permissions', description: 'Fail-closed approvals, pre-tool review, secret redaction, sandboxing.' },
  { id: 'orchestration', name: 'Orchestration & multi-agent', description: 'Sub-agent delegation, fan-out, hosting external harnesses, inter-agent protocols.' },
  { id: 'extensions', name: 'Extension surfaces', description: 'Plugins, skills, MCP servers, marketplaces.' },
  { id: 'observability', name: 'Observability & persistence', description: 'Event logs, replay, snapshots, health probes, eval harnesses.' },
];

export type PatternStatus = 'present' | 'partial' | 'missing';

export interface HarnessPattern {
  id: string;
  name: string;
  subsystem: HarnessSubsystem;
  status: PatternStatus;
  /** Repo path(s) that implement it, or the owning team when it does not exist yet. */
  evidence: string;
  /** What is there, what is not, and who owns the remainder. */
  note: string;
}

/** The 29-pattern catalog, audited against open-bot v1.03. */
export const HARNESS_PATTERN_CATALOG: HarnessPattern[] = [
  // -- Agent loop (P01–P05) -------------------------------------------
  {
    id: 'P01', name: 'Event-sourced conversation', subsystem: 'loop', status: 'missing',
    evidence: 'T1 (harness engine v2, v1.03)',
    note: 'Event log + ACP session store exist as parts, but the conversation is not a replayable stream of immutable events with the agent as a pure function over history. T1 builds the event-sourced engine this wave.',
  },
  {
    id: 'P02', name: 'Turn loop with stop conditions', subsystem: 'loop', status: 'present',
    evidence: 'packages/core/src/coordinator/coordinator.ts, packages/core/src/acp/agentServer.ts',
    note: 'Turns end on end_turn / max_tokens / max_turn_requests / refusal / cancelled (ACP_TERMINAL_STOP_REASONS); the coordinator loop enforces its own turn caps.',
  },
  {
    id: 'P03', name: 'Streaming updates to the client', subsystem: 'loop', status: 'present',
    evidence: 'packages/core/src/acp/types.ts (AcpSessionUpdate), packages/core/src/harness/bus.ts',
    note: 'session/update chunks (message / thought / tool_call / plan / usage) stream to the client; the harness bus fan-ins driver events the same way.',
  },
  {
    id: 'P04', name: 'Cancellation / abort', subsystem: 'loop', status: 'present',
    evidence: 'packages/core/src/acp/transport.ts ($/cancel_request, -32800), packages/core/src/acp/client.ts',
    note: 'AbortSignal cancels a running turn and notifies the agent; the transport test covers cancelling a slow handler.',
  },
  {
    id: 'P05', name: 'Stuck detection', subsystem: 'loop', status: 'partial',
    evidence: 'packages/core/src/acp/patterns.ts (SignatureStuckDetector); T1 owns the loop-side detector',
    note: 'Supplemented this wave as a pure-function interface + threshold implementation (repeated call / no-progress / token burn). The loop does not yet consult it every turn — that wiring belongs to T1\'s engine v2.',
  },
  // -- Tools (P06–P10) --------------------------------------------------
  {
    id: 'P06', name: 'Typed tool registry', subsystem: 'tools', status: 'present',
    evidence: 'packages/tools/src/registry.ts, packages/core/src/coordinator/coordinator.ts (defaultToolFactory)',
    note: '263 tools registered (v1.03, +4 acp_host_*) with validated definitions; duplicate names are rejected at registration.',
  },
  {
    id: 'P07', name: 'Action → execution → observation contract', subsystem: 'tools', status: 'present',
    evidence: 'packages/core/src/types.ts (Tool, ToolContext), packages/core/src/acp/types.ts (AcpSessionUpdate tool_call)',
    note: 'Every tool call returns a truncated string observation; ACP reports tool calls as structured updates with status transitions.',
  },
  {
    id: 'P08', name: 'CodeAct-style unified code execution', subsystem: 'tools', status: 'missing',
    evidence: 'T1 (CodeAct tool, v1.03)',
    note: 'No single bash+python+editor code-execution tool yet; shell, file and edit tools are separate. T1 builds the CodeAct tool this wave.',
  },
  {
    id: 'P09', name: 'MCP tool mounting', subsystem: 'tools', status: 'present',
    evidence: 'packages/core/src/mcp/, packages/tools/src/mcpTools.ts, packages/tools/src/mcpV097Tools.ts',
    note: 'MCP servers mount as tools (stdio + HTTP/streaming); session/new carries mcpServers per ACP session.',
  },
  {
    id: 'P10', name: 'Tool-result truncation & redaction', subsystem: 'tools', status: 'present',
    evidence: 'packages/tools/src/truncate.ts (MAX_TOOL_RESULT_CHARS), packages/core/src/harness/ndjson.ts (sanitizeHarnessPayload)',
    note: 'Tool outputs are truncated to 20_000 chars; harness logs redact secrets and record tool-call argument names only, never values.',
  },
  // -- Context management (P11–P14) -------------------------------------
  {
    id: 'P11', name: 'Token-budget tracking', subsystem: 'context', status: 'present',
    evidence: 'packages/core/src/context/ (CompactionHistory, PromptCacheTracker, DEFAULT_RESERVE_TOKENS)',
    note: 'Per-model context limits, reserve tokens and per-turn usage tracking feed the compaction decision.',
  },
  {
    id: 'P12', name: 'Context compaction / condenser', subsystem: 'context', status: 'partial',
    evidence: 'packages/core/src/context/ (LongRunCompaction); packages/core/src/acp/patterns.ts (ThresholdCompactionAdvisor); T1 owns the condenser',
    note: 'Long-run compaction exists; this wave adds the advisory interface (when to compact: usage >= 80% or 25 turns since the last compaction) so the loop and the condenser agree on one trigger. The condenser itself is T1\'s.',
  },
  {
    id: 'P13', name: 'Memory blocks (persona / human)', subsystem: 'context', status: 'present',
    evidence: 'packages/core/src/memory/ (blocks v2, v0.96), packages/tools/src/memoryBlockTools.ts',
    note: 'Letta-style core memory blocks are always in context and editable by tool; shared blocks cross-agent are T2 (memory v4) this wave.',
  },
  {
    id: 'P14', name: 'Code retrieval without vector embeddings', subsystem: 'context', status: 'present',
    evidence: 'packages/core/src/ (repo map PageRank, v0.96)',
    note: 'Matches the survey finding that no harness retrieves code by vector embeddings: open-bot maps the repo by PageRank instead.',
  },
  // -- Safety & permissions (P15–P18) -----------------------------------
  {
    id: 'P15', name: 'Fail-closed permission broker', subsystem: 'safety', status: 'present',
    evidence: 'packages/core/src/harness/broker.ts',
    note: 'No UI handler → deny immediately; timeout → deny; every decision is logged with its source. ACP allow works (allow_once); Codex allow is honestly unsupported and always denies.',
  },
  {
    id: 'P16', name: 'Pre-tool-call security review', subsystem: 'safety', status: 'present',
    evidence: 'packages/core/src/acp/patterns.ts (DenyListSecurityReviewer); packages/core/src/policy/ (v1.04: versioned policy-as-config enforced by a PreToolUse hook); packages/core/src/harness/broker.ts stays the approval authority',
    note: 'v1.04: behavioral policy moved from prompt prose to a versioned config file (.open-bot/policy.yaml/.json, schema + validate + audit) enforced by a PreToolUse hook (tool/path/network rules, deny-by-default opt-in). The broker remains the approval authority; the policy hook is a backstop, not a sandbox.',
  },
  {
    id: 'P17', name: 'Secret redaction in logs & events', subsystem: 'safety', status: 'present',
    evidence: 'packages/core/src/harness/ndjson.ts, packages/core/src/acp/sessionStore.ts (0600)',
    note: 'Harness payloads redact token/secret/password/api-key shapes; session files are written mode 0600.',
  },
  {
    id: 'P18', name: 'Sandbox / workspace isolation', subsystem: 'safety', status: 'partial',
    evidence: 'packages/core/src/sandbox/ (hardening v2, v0.99); T4 owns the Workspace abstraction (local ↔ container) this wave',
    note: 'Sandbox hardening v2 exists, but there is no Workspace abstraction that swaps a local directory for a container with quotas and snapshots — that is T4 (workspace/sandbox v3).',
  },
  // -- Orchestration & multi-agent (P19–P22) ----------------------------
  {
    id: 'P19', name: 'Sub-agent delegation', subsystem: 'orchestration', status: 'partial',
    evidence: 'packages/core/src/subagents/ (fan-out, v1.01); packages/core/src/acp/patterns.ts (AcpSubAgentDelegator)',
    note: 'In-process sub-agents and graded fan-out exist; this wave adds delegation to a *hosted external* harness (one subtask = one ACP turn, result only returns). The parent loop does not yet route subtasks through it by default.',
  },
  {
    id: 'P20', name: 'Multi-agent fan-out with grading', subsystem: 'orchestration', status: 'present',
    evidence: 'packages/core/src/subagents/fanout.ts, packages/core/src/subagents/grader.ts',
    note: 'Parallel sub-agents, rubric grading, rework rounds up to maxRounds (v1.01).',
  },
  {
    id: 'P21', name: 'ACP hosting of external harnesses', subsystem: 'orchestration', status: 'present',
    evidence: 'packages/core/src/acp/hosting.ts (AcpHost), packages/core/src/acp/backends.ts',
    note: 'New this wave: detect → probe (real initialize) → spawn → session → prompt with fallback order and bounded lazy restart, for 9 backends. Previously only the client side existed, with no host layer.',
  },
  {
    id: 'P22', name: 'Inter-agent protocol (A2A)', subsystem: 'orchestration', status: 'present',
    evidence: 'packages/core/src/a2a/ (v0.97)',
    note: 'A2A client/server with signing, tasks, push and history; ACP sessions bridge into it via the A2A adapter runner.',
  },
  // -- Extension surfaces (P23–P26) -------------------------------------
  {
    id: 'P23', name: 'Plugin system (load + permissions)', subsystem: 'extensions', status: 'present',
    evidence: 'packages/tools/src/plugins/loader.ts, packages/tools/src/plugins/manager.ts',
    note: 'Manifest validation, require allowlist, capability-vs-permission source scan; plugins run in-process (documented honest limit).',
  },
  {
    id: 'P24', name: 'Claude Code plugin-format compat', subsystem: 'extensions', status: 'present',
    evidence: 'packages/core/src/acp/pluginFormat.ts (read-only scan); packages/core/src/acp/pluginRuntime.ts (v1.04: opt-in activation — hooks run as shell-command hooks, commands/agents as prompt templates)',
    note: 'v1.03 read the format; v1.04 runs it: hooks/hooks.json (both shapes) registers as shell-command hooks with the plugin matcher + timeout, commands/agents become prompt templates, skills read on demand. Activation is explicit and reversible; plugin JS is never executed directly.',
  },
  {
    id: 'P25', name: 'Agent Skills (SKILL.md)', subsystem: 'extensions', status: 'present',
    evidence: 'packages/core/src/skills/ (v0.99)',
    note: 'Skills load as markdown instructions with frontmatter; the ACP plugin-format scanner also reads skills/SKILL.md files.',
  },
  {
    id: 'P26', name: 'Marketplace with signing', subsystem: 'extensions', status: 'present',
    evidence: 'packages/core/src/plugins/catalog.ts (v0.92/0.93)',
    note: 'Plugin marketplace with signed entries; the Claude Code marketplace.json reader reuses the same record shape.',
  },
  // -- Observability & persistence (P27–P29) -----------------------------
  {
    id: 'P27', name: 'NDJSON event log + replay', subsystem: 'observability', status: 'present',
    evidence: 'packages/core/src/harness/ndjson.ts, packages/core/src/harness/v2/eventExport.ts; packages/core/src/session/importer.ts (v1.04: Codex/Claude Code sessions import to open-bot format + ACP replay messages)',
    note: 'Per-thread versioned NDJSON logs (rotate + prune, paged read); ACP sessions replay recorded messages on load. v1.04: sessions from Codex CLI / Claude Code import read-only (no credentials) into open-bot format and map onto ACP recorded messages for replay.',
  },
  {
    id: 'P28', name: 'Snapshot / restore (+ fork / time-travel)', subsystem: 'observability', status: 'partial',
    evidence: 'packages/core/src/harness/snapshot.ts; T1 owns fork/time-travel (event-sourced engine, v1.03)',
    note: 'Atomic snapshots restore display state and sessions restore; fork and time-travel need the event-sourced engine (P01) — T1.',
  },
  {
    id: 'P29', name: 'Health probes & eval harness', subsystem: 'observability', status: 'partial',
    evidence: 'packages/core/src/harness/v2/healthProbe.ts; T6 owns the eval-harness UI (v1.03)',
    note: 'Per-bot-computer health probes (CPU/RAM/disk/process/heartbeat) exist and are exposed as tools; the eval-harness UI that turns probes into scored runs is T6\'s.',
  },
];

export interface HarnessAuditSummary {
  total: number;
  present: number;
  partial: number;
  missing: number;
  /** Patterns that changed status in this wave (T3). */
  improvedInV103: string[];
}

export interface HarnessAuditReport {
  version: string;
  generatedAt: string;
  patterns: HarnessPattern[];
  bySubsystem: Array<{ subsystem: HarnessSubsystem; present: number; partial: number; missing: number; total: number }>;
  summary: HarnessAuditSummary;
}

/** Patterns whose status this wave (T3) improved. */
export const V103_IMPROVED_PATTERNS = ['P05', 'P12', 'P16', 'P19', 'P21', 'P24'];

/**
 * Run the audit. Pass `overrides` to re-score patterns (e.g. a
 * later wave marking P01 present after the event-sourced engine
 * lands) without editing the catalog.
 */
export function auditHarnessPatterns(
  overrides: Partial<Record<string, PatternStatus>> = {},
): HarnessAuditReport {
  const patterns = HARNESS_PATTERN_CATALOG.map((p) => ({
    ...p,
    status: overrides[p.id] ?? p.status,
  }));
  const bySubsystem = HARNESS_SUBSYSTEMS.map((s) => {
    const inSubsystem = patterns.filter((p) => p.subsystem === s.id);
    return {
      subsystem: s.id,
      present: inSubsystem.filter((p) => p.status === 'present').length,
      partial: inSubsystem.filter((p) => p.status === 'partial').length,
      missing: inSubsystem.filter((p) => p.status === 'missing').length,
      total: inSubsystem.length,
    };
  });
  return {
    version: '1.03',
    generatedAt: new Date().toISOString(),
    patterns,
    bySubsystem,
    summary: {
      total: patterns.length,
      present: patterns.filter((p) => p.status === 'present').length,
      partial: patterns.filter((p) => p.status === 'partial').length,
      missing: patterns.filter((p) => p.status === 'missing').length,
      improvedInV103: [...V103_IMPROVED_PATTERNS],
    },
  };
}

/** One-line score, e.g. `21 present / 6 partial / 2 missing (29 total)`. */
export function auditSummaryLine(report: HarnessAuditReport): string {
  const s = report.summary;
  return `${s.present} present / ${s.partial} partial / ${s.missing} missing (${s.total} total)`;
}
