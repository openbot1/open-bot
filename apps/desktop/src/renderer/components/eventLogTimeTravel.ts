/**
 * Event-log time travel (v1.08, Team T5 — voice v7 + UI).
 *
 * Renderer-local, pure functions: given the harness thread-log
 * entries (the same sanitised entries `EventLogView` already
 * loads through `harness:thread-log`), build a step-by-step
 * replay of the run — jump to step N, see the state at that step,
 * replay from there. No new IPC, no copy of the T3 harness
 * EventLog: the viewer reads the entries the existing view
 * already has and computes the replay state locally.
 *
 * A "step" is one log entry. The state at step N is the running
 * tally over entries [0..N): counts by kind, the last tool
 * called, the last text the model wrote, how many errors had
 * happened, and the time span covered. The viewer shows entries
 * up to N and dims the rest, so "what had happened by step N"
 * is visible at a glance. Replay is a schedule of steps with a
 * per-step delay — the component ticks through it with a timer.
 * Unit-tested with plain node --test (see tests/voice-v108.test.mjs).
 */
import type { HarnessThreadLogEntryView } from '../types';

/** One replay step (one log entry + the state right after it). */
export interface TimeTravelStep {
  /** 0-based step number (== the entry index). */
  index: number;
  /** Entry timestamp (ISO). */
  at: string;
  kind: string;
  /** One-line label for the step (tool name / text / error). */
  label: string;
  /** Running counts by kind over entries [0..index]. */
  countsByKind: Record<string, number>;
  /** Total entries up to and including this step. */
  totalSoFar: number;
  /** Last tool called up to this step (null when none yet). */
  lastTool: string | null;
  /** Last model text up to this step (null when none yet). */
  lastText: string | null;
  /** Errors up to and including this step. */
  errors: number;
  /** Tool calls up to and including this step. */
  toolCalls: number;
}

/** The reconstructed state at a step (what the viewer shows). */
export interface TimeTravelState {
  /** Step shown (clamped to [0, total]). 0 = before the first entry. */
  step: number;
  /** Total steps in the log. */
  total: number;
  /** Entries visible at this step (entries [0..step)). */
  visibleEntries: HarnessThreadLogEntryView[];
  /** Running counts by kind over the visible entries. */
  countsByKind: Record<string, number>;
  lastTool: string | null;
  lastText: string | null;
  errors: number;
  toolCalls: number;
  /** Timestamp of the first visible entry (null when step is 0). */
  firstAt: string | null;
  /** Timestamp of the last visible entry (null when step is 0). */
  lastAt: string | null;
  /** ms covered by the visible entries (0 when fewer than 2). */
  spanMs: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** One-line label for an entry (tool name / text / error — sanitised payload only). */
export function timeTravelStepLabel(entry: HarnessThreadLogEntryView): string {
  const p = entry.payload ?? {};
  switch (entry.kind) {
    case 'text':
      return truncate(asString(p['text']), 80);
    case 'tool_call': {
      const keys = asStringList(p['argKeys']);
      return keys.length > 0 ? `${asString(p['tool'])}(${keys.join(', ')})` : asString(p['tool']);
    }
    case 'result': {
      const ok = p['ok'] === true ? 'ok' : 'error';
      const out = truncate(asString(p['output']), 60);
      return out ? `${asString(p['tool'])} · ${ok} · ${out}` : `${asString(p['tool'])} · ${ok}`;
    }
    case 'error':
      return truncate(asString(p['message']), 80);
    case 'abort':
      return 'aborted';
    case 'approval_request':
    case 'permission_request':
      return asString(p['method']);
    case 'approval_denied':
      return asString(p['tool']) || asString(p['method']);
    case 'approval_decision': {
      const allowed = p['allowed'] === true ? 'allow' : 'deny';
      return `${asString(p['method'])} · ${allowed}`;
    }
    case 'lifecycle': {
      const phase = asString(p['phase']);
      const status = asString(p['status']);
      return status ? `${phase} · ${status}` : phase;
    }
    default:
      return entry.kind;
  }
}

/**
 * Build the replay steps for a list of entries (chronological
 * order is assumed — the caller passes the log order). Pure:
 * the same entries always build the same steps.
 */
export function buildTimeTravelSteps(entries: readonly HarnessThreadLogEntryView[]): TimeTravelStep[] {
  const steps: TimeTravelStep[] = [];
  const countsByKind: Record<string, number> = {};
  let lastTool: string | null = null;
  let lastText: string | null = null;
  let errors = 0;
  let toolCalls = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
    if (entry.kind === 'tool_call') {
      toolCalls += 1;
      const tool = asString(entry.payload?.['tool']);
      if (tool !== '') lastTool = tool;
    }
    if (entry.kind === 'text') {
      const text = asString(entry.payload?.['text']);
      if (text !== '') lastText = text;
    }
    if (entry.kind === 'error') errors += 1;
    steps.push({
      index: i,
      at: entry.at,
      kind: entry.kind,
      label: timeTravelStepLabel(entry),
      countsByKind: { ...countsByKind },
      totalSoFar: i + 1,
      lastTool,
      lastText,
      errors,
      toolCalls,
    });
  }
  return steps;
}

/**
 * The state at step N: entries [0..N) are visible, the rest are
 * the future. N is clamped to [0, entries.length] — jumping past
 * the end lands on the last step, jumping before the start lands
 * on step 0 (nothing happened yet).
 */
export function stateAtStep(
  entries: readonly HarnessThreadLogEntryView[],
  steps: readonly TimeTravelStep[],
  step: number,
): TimeTravelState {
  const total = entries.length;
  const clamped = Math.max(0, Math.min(total, Math.floor(step)));
  const visibleEntries = entries.slice(0, clamped);
  const last = clamped === 0 ? null : steps[clamped - 1] ?? null;
  const firstAt = visibleEntries.length > 0 ? visibleEntries[0]!.at : null;
  const lastAt = visibleEntries.length > 0 ? visibleEntries[visibleEntries.length - 1]!.at : null;
  let spanMs = 0;
  if (firstAt !== null && lastAt !== null) {
    const start = Date.parse(firstAt);
    const end = Date.parse(lastAt);
    if (Number.isFinite(start) && Number.isFinite(end)) spanMs = Math.max(0, end - start);
  }
  return {
    step: clamped,
    total,
    visibleEntries,
    countsByKind: last ? { ...last.countsByKind } : {},
    lastTool: last?.lastTool ?? null,
    lastText: last?.lastText ?? null,
    errors: last?.errors ?? 0,
    toolCalls: last?.toolCalls ?? 0,
    firstAt,
    lastAt,
    spanMs,
  };
}

/**
 * Replay schedule: the steps to tick through from `fromStep`
 * (exclusive) to `toStep` (inclusive), one per `stepDelayMs`.
 * Returns the step numbers in order — the component ticks one
 * per interval. Empty when there is nothing left to replay.
 */
export function replaySchedule(fromStep: number, toStep: number): number[] {
  const from = Math.max(0, Math.floor(fromStep));
  const to = Math.max(0, Math.floor(toStep));
  if (to <= from) return [];
  const out: number[] = [];
  for (let step = from + 1; step <= to; step++) out.push(step);
  return out;
}

/** Replay speeds the viewer offers (ms per step). */
export const TIME_TRAVEL_SPEEDS = [100, 250, 500, 1000] as const;

/** True when the value is one of the offered replay speeds. */
export function isTimeTravelSpeed(value: number): value is (typeof TIME_TRAVEL_SPEEDS)[number] {
  return (TIME_TRAVEL_SPEEDS as readonly number[]).includes(value);
}

/** Format a span (ms) for the state panel: "1m 23s" / "45s" / "120ms". */
export function formatTimeTravelSpan(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1_000) return `${safe}ms`;
  const totalSeconds = Math.floor(safe / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
