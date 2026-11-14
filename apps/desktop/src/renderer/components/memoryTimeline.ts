/**
 * Memory timeline (v1.06, Team T5 — UI v3).
 *
 * Pure helpers, no React, no IPC: build one chronological timeline
 * from the memory sources the app already exposes over IPC —
 * `memory:list` entries, `memory-blocks:list` blocks, the v3 block
 * version history (`memory-v3:block-history`, action 'list') and the
 * v5 consolidation runs (`memory-v5:health`).
 *
 * Tier model (there is no tier field on any stored record, so the
 * tier is derived and documented here — the timeline UI states it):
 *
 * - `working` — any event from the last 24h, whatever its source.
 *   Fresh changes are the working set; they settle into their
 *   long-term tier afterwards.
 * - `episodic` — memory entries (`memories.json`): dated records of
 *   what the user / bot did or said.
 * - `session` — block version snapshots (v3 history): one version is
 *   the state of a block after one editing session.
 * - `semantic` — curated blocks and consolidation runs (dedupe /
 *   promote / sweep): the long-term knowledge itself.
 */
import type {
  MemoryBlockView,
  MemoryEntryView,
  MemoryV3BlockVersionView,
  MemoryV5ConsolidationRunView,
} from '../types';
import { normalizeBotQuery } from './botList';

export type MemoryTier = 'working' | 'session' | 'episodic' | 'semantic';

export const MEMORY_TIERS: MemoryTier[] = ['working', 'session', 'episodic', 'semantic'];

/** Fresh events stay in the working set for this long. */
export const WORKING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TimelineEventKind =
  | 'entry-created'
  | 'entry-updated'
  | 'block-created'
  | 'block-updated'
  | 'block-version'
  | 'consolidation';

export interface TimelineEvent {
  /** Stable id: `<kind>:<source id>:<timestamp ms>`. */
  id: string;
  /** Event time, epoch ms. */
  at: number;
  tier: MemoryTier;
  kind: TimelineEventKind;
  /** Short label shown on the timeline row (block label / entry key). */
  title: string;
  /** One-line detail (value / description / action + actor). */
  detail: string;
  /** Full content shown in the detail panel (may be ''). */
  content: string;
  blockLabel?: string;
  entryId?: string;
  /** Block version number (block-version events only). */
  version?: number;
  /** Consolidation run this event summarises (consolidation only). */
  run?: MemoryV5ConsolidationRunView;
}

export interface TimelineInput {
  entries: MemoryEntryView[];
  blocks: MemoryBlockView[];
  /** Version history per block label (already fetched by the view). */
  versionsByBlock: Record<string, MemoryV3BlockVersionView[]>;
  runs: MemoryV5ConsolidationRunView[];
  /** "Now" for the working-window rule (defaults to Date.now()). */
  now?: number;
}

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function tierFor(sourceTier: Exclude<MemoryTier, 'working'>, at: number, now: number): MemoryTier {
  return now - at < WORKING_WINDOW_MS ? 'working' : sourceTier;
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Merge every source into one timeline, newest first. Events with an
 * unparseable timestamp are dropped (they cannot be placed on a
 * timeline); a block whose created and updated timestamps are equal
 * yields only the created event.
 */
export function buildTimelineEvents(input: TimelineInput): TimelineEvent[] {
  const now = input.now ?? Date.now();
  const events: TimelineEvent[] = [];

  for (const entry of input.entries) {
    const created = toMs(entry.createdAt);
    const updated = toMs(entry.updatedAt);
    if (created > 0) {
      events.push({
        id: `entry-created:${entry.id}:${created}`,
        at: created,
        tier: tierFor('episodic', created, now),
        kind: 'entry-created',
        title: entry.key,
        detail: truncate(entry.value),
        content: entry.value,
        entryId: entry.id,
      });
    }
    if (updated > 0 && updated !== created) {
      events.push({
        id: `entry-updated:${entry.id}:${updated}`,
        at: updated,
        tier: tierFor('episodic', updated, now),
        kind: 'entry-updated',
        title: entry.key,
        detail: truncate(entry.value),
        content: entry.value,
        entryId: entry.id,
      });
    }
  }

  for (const block of input.blocks) {
    const created = toMs(block.createdAt);
    const updated = toMs(block.updatedAt);
    if (created > 0) {
      events.push({
        id: `block-created:${block.id}:${created}`,
        at: created,
        tier: tierFor('semantic', created, now),
        kind: 'block-created',
        title: block.label,
        detail: truncate(block.description),
        content: block.content,
        blockLabel: block.label,
      });
    }
    if (updated > 0 && updated !== created) {
      events.push({
        id: `block-updated:${block.id}:${updated}`,
        at: updated,
        tier: tierFor('semantic', updated, now),
        kind: 'block-updated',
        title: block.label,
        detail: truncate(block.description),
        content: block.content,
        blockLabel: block.label,
      });
    }
  }

  for (const versions of Object.values(input.versionsByBlock)) {
    for (const v of versions) {
      const at = toMs(v.at);
      if (at <= 0) continue;
      events.push({
        id: `block-version:${v.blockId}:v${v.version}:${at}`,
        at,
        tier: tierFor('session', at, now),
        kind: 'block-version',
        title: v.label,
        detail: `${v.action} · ${v.actor}`,
        content: v.content,
        blockLabel: v.label,
        version: v.version,
      });
    }
  }

  for (const run of input.runs) {
    const at = toMs(run.at);
    if (at <= 0) continue;
    events.push({
      id: `consolidation:${at}`,
      at,
      tier: tierFor('semantic', at, now),
      kind: 'consolidation',
      title: run.actor,
      detail: '',
      content: '',
      run,
    });
  }

  events.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return events;
}

export interface TimelineFilter {
  /** Tiers to keep; an empty set keeps nothing. */
  tiers: ReadonlySet<MemoryTier>;
  /** Free-text query (diacritic-insensitive, every token must match). */
  query: string;
}

/** Tier filter + search over title / detail / content / block label. */
export function filterTimelineEvents(events: TimelineEvent[], filter: TimelineFilter): TimelineEvent[] {
  const tokens = normalizeBotQuery(filter.query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return events.filter((e) => {
    if (!filter.tiers.has(e.tier)) return false;
    if (tokens.length === 0) return true;
    const haystack = normalizeBotQuery([e.title, e.detail, e.content, e.blockLabel ?? ''].join(' '));
    return tokens.every((token) => haystack.includes(token));
  });
}

export interface TimelineDayGroup {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  events: TimelineEvent[];
}

/** Group an already-sorted event list by day, newest day first. */
export function groupEventsByDay(events: TimelineEvent[]): TimelineDayGroup[] {
  const groups: TimelineDayGroup[] = [];
  for (const event of events) {
    const day = new Date(event.at).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.events.push(event);
    } else {
      groups.push({ day, events: [event] });
    }
  }
  return groups;
}
