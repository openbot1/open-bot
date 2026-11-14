/**
 * Event-stream viewer (observability v3) — cross-run queries over the
 * event-sourced run log.
 *
 * The run log (event-log/, Team T1) stores one append-only JSONL file
 * per run. The replay view reads one run at a time. This module is the
 * cross-run lens: given the events of several runs (already read via
 * the existing `runlog:read` path — this module reads no files and
 * touches no T1 code), it answers what the event-stream viewer asks:
 *
 * - filter by run, type, bot, time window, or free text in the
 *   payload (payloads are already sanitised in core — no secrets,
 *   tool args keep key names only);
 * - summarise: counts per type, per run, error rate, total tokens;
 * - timeline buckets: events per minute, so the viewer can draw the
 *   burst shape of a run without shipping every event to the chart.
 *
 * Everything here is pure functions over `AnyRunEvent[]`, so the
 * renderer can reuse the same code in tests without a store.
 */

import type { AnyRunEvent, RunEventType } from '../event-log/types';

export interface EventStreamFilter {
  /** Only events from these runs (empty/undefined = all). */
  runIds?: string[];
  /** Only these event types (empty/undefined = all). */
  types?: RunEventType[];
  /** Only events whose run started for these bots — needs run meta; see `filterRunEvents`. */
  botIds?: string[];
  /** Only events at or after this ISO time. */
  fromAt?: string;
  /** Only events at or before this ISO time. */
  toAt?: string;
  /** Free text matched against type + a JSON rendering of the payload (case-insensitive). */
  text?: string;
  /** Max events returned (newest last is preserved; the cap trims the oldest). */
  limit?: number;
}

/** Minimal run meta the stream filter needs (from `runlog:list`). */
export interface EventStreamRunMeta {
  runId: string;
  botId: string;
}

/** Per-type counts. */
export interface EventStreamSummary {
  total: number;
  byType: Record<string, number>;
  byRun: Record<string, number>;
  /** Tool results with status 'error' + run.failed/aborted events. */
  errors: number;
  /** Error share of all events (0 when there are none). */
  errorRate: number;
  /** Total input+output tokens summed from model.response events. */
  tokensUsed: number;
  /** Tool calls (tool.call events). */
  toolCalls: number;
  /** Distinct runs present. */
  runs: number;
  firstAt: string | null;
  lastAt: string | null;
}

/** One timeline bucket: events in a minute. */
export interface EventStreamBucket {
  /** Bucket start (epoch ms, minute-aligned). */
  at: number;
  count: number;
  errors: number;
}

function isToolErrorEvent(event: AnyRunEvent): boolean {
  if (event.type === 'run.failed' || event.type === 'run.aborted') return true;
  if (event.type === 'tool.result') {
    const payload = event.payload as { status?: string };
    return payload.status === 'error';
  }
  if (event.type === 'compile.error') return true;
  return false;
}

function eventText(event: AnyRunEvent): string {
  try {
    return `${event.type} ${JSON.stringify(event.payload)}`.toLowerCase();
  } catch {
    return event.type.toLowerCase();
  }
}

/**
 * Filter events. `runMeta` (from `runlog:list`) enables the botIds
 * filter; without it, botIds is ignored (never guessed from events —
 * only `run.started` carries a botId, and not every stream includes it).
 */
export function filterRunEvents(
  events: readonly AnyRunEvent[],
  filter: EventStreamFilter = {},
  runMeta: readonly EventStreamRunMeta[] = [],
): AnyRunEvent[] {
  const runIds = filter.runIds?.length ? new Set(filter.runIds) : null;
  const types = filter.types?.length ? new Set(filter.types) : null;
  const botIds = filter.botIds?.length ? new Set(filter.botIds) : null;
  const botByRun = new Map(runMeta.map((m) => [m.runId, m.botId]));
  const fromAt = filter.fromAt ? Date.parse(filter.fromAt) : NaN;
  const toAt = filter.toAt ? Date.parse(filter.toAt) : NaN;
  const text = filter.text?.trim().toLowerCase() ?? '';
  const words = text.length > 0 ? text.split(/\s+/) : [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.at.localeCompare(b.at));
  let out = sorted.filter((event) => {
    if (runIds && !runIds.has(event.runId)) return false;
    if (types && !types.has(event.type)) return false;
    if (botIds) {
      const botId = botByRun.get(event.runId);
      if (botId === undefined || !botIds.has(botId)) return false;
    }
    if (Number.isFinite(fromAt) && Date.parse(event.at) < fromAt) return false;
    if (Number.isFinite(toAt) && Date.parse(event.at) > toAt) return false;
    if (words.length > 0) {
      const haystack = eventText(event);
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
  if (typeof filter.limit === 'number' && filter.limit >= 0) {
    out = out.slice(Math.max(0, out.length - filter.limit));
  }
  return out;
}

/** Summarise a (filtered) event list. */
export function summarizeEventStream(events: readonly AnyRunEvent[]): EventStreamSummary {
  const byType: Record<string, number> = {};
  const byRun: Record<string, number> = {};
  let errors = 0;
  let tokensUsed = 0;
  let toolCalls = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    byRun[event.runId] = (byRun[event.runId] ?? 0) + 1;
    if (isToolErrorEvent(event)) errors += 1;
    if (event.type === 'tool.call') toolCalls += 1;
    if (event.type === 'model.response') {
      const payload = event.payload as { inputTokens?: number; outputTokens?: number };
      if (typeof payload.inputTokens === 'number') tokensUsed += payload.inputTokens;
      if (typeof payload.outputTokens === 'number') tokensUsed += payload.outputTokens;
    }
    if (firstAt === null || event.at < firstAt) firstAt = event.at;
    if (lastAt === null || event.at > lastAt) lastAt = event.at;
  }
  return {
    total: events.length,
    byType,
    byRun,
    errors,
    errorRate: events.length === 0 ? 0 : errors / events.length,
    tokensUsed,
    toolCalls,
    runs: Object.keys(byRun).length,
    firstAt,
    lastAt,
  };
}

/**
 * Bucket events per minute (minute-aligned epoch ms). Buckets with
 * zero events are omitted — the viewer draws gaps as gaps, not zeros.
 */
export function bucketEventStream(events: readonly AnyRunEvent[]): EventStreamBucket[] {
  const buckets = new Map<number, EventStreamBucket>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const start = Math.floor(at / 60000) * 60000;
    const bucket = buckets.get(start) ?? { at: start, count: 0, errors: 0 };
    bucket.count += 1;
    if (isToolErrorEvent(event)) bucket.errors += 1;
    buckets.set(start, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

/** The newest N events (for the live-tail pane). Input order is kept. */
export function tailEvents(events: readonly AnyRunEvent[], n: number): AnyRunEvent[] {
  if (n <= 0) return [];
  return [...events].slice(Math.max(0, events.length - n));
}

/** All event types present in a list, in first-seen order. */
export function listEventTypesPresent(events: readonly AnyRunEvent[]): RunEventType[] {
  const seen = new Set<RunEventType>();
  const out: RunEventType[] = [];
  for (const event of events) {
    if (!seen.has(event.type)) {
      seen.add(event.type);
      out.push(event.type);
    }
  }
  return out;
}
