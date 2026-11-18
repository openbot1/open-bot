/**
 * Protocols v4 — IETF Agent Communication Protocols WG watch (v1.20, Team T2).
 *
 * Idea only, learned from the public IETF record researched for
 * this wave (see docs/protocols-v120.md): the IETF chartered the
 * Agent Communication Protocols working group (`agentproto`) on
 * 8 Oct 2026 (chairs Orie Steele, Leslie Daigle; Applications
 * and Real-Time area). Its scope is a common baseline agentic
 * dialog management protocol + a reference architecture that
 * integrates related protocol building blocks — it neither
 * replaces application-layer protocols (MCP / A2A) nor defines a
 * new transport. The dialog protocol defines dialog identifiers,
 * lifecycle semantics and the propagation of dialog context,
 * with bindings that say how that context is carried over
 * existing IETF protocols. Three functional blocks: agentic
 * dialog management, authorization and delegation, identity
 * management. Dialog context means identifiers + lifecycle
 * state — NOT LLM context (no memory, retrieved documents or
 * prompts). Milestones (charter, approved 8 Oct 2026): adopt a
 * use-cases draft Dec 2026, an architecture draft Feb 2027,
 * proposed-standard dialog-management draft(s) Mar 2027, submit
 * to the IESG Mar 2028. Individual drafts in flight (not WG
 * adoptions yet): an agentic use-cases draft (rev -04, 15 Oct
 * 2026) and `draft-manyfolks-agentproto-arch-00` (30 Oct 2026,
 * expires 3 May 2027). Sibling WG DAWN (discovery) was chartered
 * 22 Oct 2026. No code, text or asset from any other repo is
 * copied here.
 *
 * This module is a watch-track, not a wire protocol: there is
 * nothing to implement against yet (no adopted draft exists as
 * of this wave), so it records the WG's direction, its
 * milestones, and a readiness checklist mapping each agentproto
 * concept onto what open-bot already has — so that when the
 * first adopted draft lands, the gap is a checklist, not a
 * surprise. Statuses are open-bot's honest self-assessment:
 * `ready` (the piece exists and matches the concept),
 * `partial` (the piece exists but not in the WG's shape),
 * `watch` (nothing to do until the WG publishes).
 */

export const IETF_V4_AGENTPROTO_WG = 'agentproto';
/** Charter approval date (IESG, 8 Oct 2026). */
export const IETF_V4_AGENTPROTO_CHARTER_DATE = '2026-10-08';
/** WG chairs. */
export const IETF_V4_AGENTPROTO_CHAIRS = ['Orie Steele', 'Leslie Daigle'] as const;
/** Sibling WG for discovery. */
export const IETF_V4_DAWN_WG = 'dawn';
export const IETF_V4_DAWN_CHARTER_DATE = '2026-10-22';

/** One charter milestone. */
export interface IetfV4Milestone {
  due: string;
  title: string;
  /** What open-bot should do when this milestone lands. */
  openBotAction: string;
}

/** Charter milestones, in due order. */
export const IETF_V4_AGENTPROTO_MILESTONES: readonly IetfV4Milestone[] = [
  {
    due: '2026-12-31',
    title: 'Adopt an informational use-cases draft',
    openBotAction:
      'Read the adopted use cases; check which open-bot flows (delegation, handoff, multi-agent tasks) they cover and file the gaps.',
  },
  {
    due: '2027-02-28',
    title: 'Adopt an informational architecture draft',
    openBotAction:
      'Map the reference architecture onto open-bot layers (A2A tasks, AG-UI runs, MCP tools) and note where the layering differs.',
  },
  {
    due: '2027-03-31',
    title: 'Adopt proposed-standard agentic dialog management protocol draft(s)',
    openBotAction:
      'First implementable draft: prototype a dialog-context envelope (dialog id + lifecycle + context propagation) behind a flag.',
  },
  {
    due: '2028-03-31',
    title: 'Submit dialog-management draft(s) to the IESG as proposed standard',
    openBotAction:
      'Decide: ship the dialog-context envelope as a supported binding, or keep it experimental until the RFC lands.',
  },
];

/** Next milestone due on or after `now` (ISO date), or null when all passed. */
export function ietfV4NextMilestone(now: Date = new Date()): IetfV4Milestone | null {
  const today = now.toISOString().slice(0, 10);
  return IETF_V4_AGENTPROTO_MILESTONES.find((m) => m.due >= today) ?? null;
}

/** Readiness of one agentproto concept inside open-bot. */
export type IetfV4ReadinessStatus = 'ready' | 'partial' | 'watch';

/** One readiness checklist row. */
export interface IetfV4ReadinessRow {
  concept: string;
  status: IetfV4ReadinessStatus;
  /** What open-bot already has for this concept. */
  openBotHas: string;
  /** What is still missing / to watch. */
  gap: string;
}

/** Readiness checklist: agentproto concepts vs open-bot today. */
export const IETF_V4_READINESS: readonly IetfV4ReadinessRow[] = [
  {
    concept: 'Dialog identifiers',
    status: 'partial',
    openBotHas:
      'A2A contextId / task id and AG-UI runId identify a dialog inside one protocol.',
    gap: 'No cross-protocol dialog id: the same conversation has a different id in A2A, AG-UI and MCP. Watch the WG identifier shape before inventing one.',
  },
  {
    concept: 'Dialog lifecycle semantics',
    status: 'ready',
    openBotHas:
      'A2A task state machine (submitted/working/input-required/completed/failed/cancelled/rejected) and AG-UI run lifecycle (started/finished/error + interrupt outcome).',
    gap: 'Confirm the WG lifecycle vocabulary maps 1:1 (e.g. what "suspended" means) when the draft lands; do not rename open-bot states before then.',
  },
  {
    concept: 'Dialog context propagation (multi-intermediary, multi-trust-boundary)',
    status: 'partial',
    openBotHas:
      'Handoff / delegation carries task + history across agents; signed Agent Cards carry identity across trust boundaries.',
    gap: 'No signed dialog-context envelope: context today is carried ad hoc per protocol. Prototype only after the Mar 2027 draft defines the envelope.',
  },
  {
    concept: 'Bindings over existing IETF protocols',
    status: 'watch',
    openBotHas: 'Streamable HTTP + SSE transports (MCP, A2A) already run over HTTP.',
    gap: 'No binding exists yet — the WG has not said which existing protocols carry dialog context. Nothing to implement.',
  },
  {
    concept: 'Authorization and delegation',
    status: 'partial',
    openBotHas: 'Vault-signed Agent Cards, Poppy signed-assertion sessions, per-bot approval gates.',
    gap: 'Delegation tokens are open-bot-local; watch whether the WG profiles OAuth / GNAP or something else for cross-vendor delegation.',
  },
  {
    concept: 'Identity management',
    status: 'ready',
    openBotHas:
      'Poppy opaque per-company user ids (never derived from personal data) and client_id URL metadata documents.',
    gap: 'Keep the Poppy identity shape; re-check it against the WG identity block when the architecture draft is adopted (Feb 2027).',
  },
  {
    concept: 'Discovery (sibling WG DAWN)',
    status: 'watch',
    openBotHas: 'A2A Agent Card discovery (/.well-known/agent-card.json) and Poppy discovery (/.well-known/poppy.json).',
    gap: 'DAWN may define a shared discovery layer; do not replace well-known discovery until DAWN publishes.',
  },
  {
    concept: 'Model implementation / reasoning / planning / UI / audit structures',
    status: 'watch',
    openBotHas: 'Out of the WG scope by charter — open-bot keeps its own.',
    gap: 'None: the charter explicitly leaves these outside its remit.',
  },
];

/** Readiness report for the watch-track. */
export interface IetfV4ReadinessReport {
  wg: string;
  charterDate: string;
  chairs: readonly string[];
  nextMilestone: IetfV4Milestone | null;
  rows: readonly IetfV4ReadinessRow[];
  counts: Record<IetfV4ReadinessStatus, number>;
  summary: string;
}

/** Build the readiness report (pure data, no I/O). */
export function ietfV4ReadinessReport(now: Date = new Date()): IetfV4ReadinessReport {
  const counts: Record<IetfV4ReadinessStatus, number> = { ready: 0, partial: 0, watch: 0 };
  for (const row of IETF_V4_READINESS) counts[row.status] += 1;
  const next = ietfV4NextMilestone(now);
  return {
    wg: IETF_V4_AGENTPROTO_WG,
    charterDate: IETF_V4_AGENTPROTO_CHARTER_DATE,
    chairs: IETF_V4_AGENTPROTO_CHAIRS,
    nextMilestone: next,
    rows: IETF_V4_READINESS,
    counts,
    summary:
      `IETF agentproto (chartered ${IETF_V4_AGENTPROTO_CHARTER_DATE}): ` +
      `${counts['ready']} ready, ${counts['partial']} partial, ${counts['watch']} watch. ` +
      (next
        ? `Next milestone: ${next.title} (due ${next.due}).`
        : 'All charter milestones have passed.') +
      ' No wire protocol exists yet — watch, do not implement.',
  };
}

/** One-line watch summary for logs / UI. */
export function ietfV4WatchSummary(now: Date = new Date()): string {
  return ietfV4ReadinessReport(now).summary;
}
