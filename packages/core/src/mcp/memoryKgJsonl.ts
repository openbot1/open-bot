/**
 * Memory knowledge-graph adapter — JSONL, append-only, event-sourced
 * (v1.44, Team T3).
 *
 * Idea taken (survey v1.44, Mem0 v3 / mnemograph): a knowledge graph
 * as an append-only event log, versioned, with time-travel reads
 * (`get_state_at`, `diff_timerange`) and MCP tools `remember` /
 * `recall`. An old fact is invalidated, never deleted — the graph
 * keeps both the fact and its validity window (bi-temporal, after
 * Zep / Graphiti). Not taken: any hosted Mem0/Zep/Graphiti service,
 * any of their code, and no git backend here (T1 owns git-backed
 * memory; this adapter is the plain-file JSONL counterpart — one
 * file, human-readable, `tail`-able, trivially backup-able).
 *
 * Event log (one JSON object per line, `seq` strictly increasing):
 *
 *   { seq, ts, type: 'entity.add', id, label, kind, attributes?, hash }
 *   { seq, ts, type: 'entity.invalidate', id, reason?, hash }
 *   { seq, ts, type: 'relation.add', id, from, to, label, attributes?, hash }
 *   { seq, ts, type: 'relation.invalidate', id, reason?, hash }
 *   { seq, ts, type: 'note.add', id, text, entities?, hash }
 *
 * `hash` is SHA-256 over the canonical event (without `hash`
 * itself): a tampered line fails `verifyIntegrity` instead of
 * silently changing history. Replay rebuilds state from scratch;
 * `getStateAt(ts)` replays only events at or before `ts`;
 * `diffTimerange(from, to)` lists the events in the window plus
 * the net effect (what was added / invalidated).
 *
 * `remember` / `recall` are the MCP-facing surface: `remember`
 * stores free text plus extracted entities/relations (the caller
 * extracts them — this module never calls an LLM); `recall`
 * ranks live facts by token overlap with the query, recency,
 * and relation degree. Invalidated facts never surface in
 * `recall` unless the caller explicitly asks for history.
 *
 * File I/O is sequential (a promise chain serialises appends, so
 * concurrent `remember` calls cannot interleave lines) and
 * atomic-enough for a local-first app: append-only, never
 * rewrite in place; `compact()` writes a snapshot file and
 * truncates the log to events after the snapshot.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Error raised by the memory-KG adapter. */
export class MemoryKgError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MemoryKgError';
    this.code = code;
  }
}

/** Kinds of event in the JSONL log (closed list). */
export type MemoryKgEventType =
  | 'entity.add'
  | 'entity.invalidate'
  | 'relation.add'
  | 'relation.invalidate'
  | 'note.add';

export const MEMORY_KG_EVENT_TYPES: readonly MemoryKgEventType[] = [
  'entity.add',
  'entity.invalidate',
  'relation.add',
  'relation.invalidate',
  'note.add',
];

/** One event in the log. `hash` is filled in by `signEvent`. */
export interface MemoryKgEvent {
  seq: number;
  ts: number;
  type: MemoryKgEventType;
  /** Entity / relation / note id this event is about. */
  id: string;
  /** Entity label (entity.add). */
  label?: string;
  /** Entity kind: person / project / place / concept / … (free-form). */
  kind?: string;
  /** Relation source entity id (relation.add). */
  from?: string;
  /** Relation target entity id (relation.add). */
  to?: string;
  /** Free-form attributes (JSON-safe). */
  attributes?: Record<string, unknown>;
  /** Note text (note.add). */
  text?: string;
  /** Entity ids a note mentions (note.add). */
  entities?: string[];
  /** Why this fact was invalidated (invalidate events). */
  reason?: string;
  /** SHA-256 over the canonical event without `hash`. */
  hash?: string;
}

/** A live entity in the replayed graph. */
export interface MemoryKgEntity {
  id: string;
  label: string;
  kind: string;
  attributes: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** When the entity was invalidated (undefined = still live). */
  invalidatedAt?: number;
  invalidateReason?: string;
}

/** A live relation in the replayed graph. */
export interface MemoryKgRelation {
  id: string;
  from: string;
  to: string;
  label: string;
  attributes: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  invalidatedAt?: number;
  invalidateReason?: string;
}

/** A note in the replayed graph (notes are never invalidated, only superseded by newer notes). */
export interface MemoryKgNote {
  id: string;
  text: string;
  entities: string[];
  createdAt: number;
}

/** Full replayed state of the graph. */
export interface MemoryKgState {
  entities: Map<string, MemoryKgEntity>;
  relations: Map<string, MemoryKgRelation>;
  notes: Map<string, MemoryKgNote>;
  /** Highest seq replayed (0 when empty). */
  lastSeq: number;
  /** Highest ts replayed (0 when empty). */
  lastTs: number;
}

/** A recalled fact: entity / relation / note + why it matched. */
export interface MemoryKgRecallHit {
  kind: 'entity' | 'relation' | 'note';
  id: string;
  /** Display text for the hit. */
  text: string;
  /** 0..1 relevance score. */
  score: number;
  /** Matched query tokens. */
  matchedTokens: string[];
  /** When the fact was created. */
  createdAt: number;
  /** Validity window end (undefined = still valid). */
  validUntil?: number;
}

export const MEMORY_KG_MAX_LABEL = 200;
export const MEMORY_KG_MAX_TEXT = 4000;
export const MEMORY_KG_MAX_EVENTS_PER_FILE = 100_000;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, depth + 1));
  if (isRecord(value)) return Object.values(value).every((v) => isJsonSafe(v, depth + 1));
  return false;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of the canonical event (without its `hash` field). */
export function hashEvent(event: Omit<MemoryKgEvent, 'hash'>): string {
  return crypto.createHash('sha256').update(canonicalJson(event)).digest('hex');
}

/** Attach the integrity hash to an event (returns a new object). */
export function signEvent(event: Omit<MemoryKgEvent, 'hash'>): MemoryKgEvent {
  return { ...event, hash: hashEvent(event) };
}

/** Validate one event's shape (before signing / appending). Throws `MemoryKgError`. */
export function validateEvent(event: Omit<MemoryKgEvent, 'hash'> & { hash?: string }): void {
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new MemoryKgError(`Event seq phải là số nguyên >= 1 (nhận ${JSON.stringify(event.seq)}).`, 'bad-event');
  }
  if (!Number.isInteger(event.ts) || event.ts < 0) {
    throw new MemoryKgError('Event ts phải là số nguyên >= 0 (ms epoch).', 'bad-event');
  }
  if (!(MEMORY_KG_EVENT_TYPES as readonly string[]).includes(event.type)) {
    throw new MemoryKgError(`Event type không biết: ${JSON.stringify(event.type)}.`, 'bad-event');
  }
  if (typeof event.id !== 'string' || !ID_RE.test(event.id)) {
    throw new MemoryKgError(`Event id không hợp lệ: ${JSON.stringify(event.id)}.`, 'bad-event');
  }
  if (event.type === 'entity.add') {
    if (typeof event.label !== 'string' || event.label.length === 0 || event.label.length > MEMORY_KG_MAX_LABEL) {
      throw new MemoryKgError(`entity.add cần label 1..${MEMORY_KG_MAX_LABEL} ký tự.`, 'bad-event');
    }
  }
  if (event.type === 'relation.add') {
    if (typeof event.from !== 'string' || typeof event.to !== 'string' || !event.from || !event.to) {
      throw new MemoryKgError('relation.add cần from + to.', 'bad-event');
    }
    if (typeof event.label !== 'string' || event.label.length === 0) {
      throw new MemoryKgError('relation.add cần label.', 'bad-event');
    }
  }
  if (event.type === 'note.add') {
    if (typeof event.text !== 'string' || event.text.length === 0 || event.text.length > MEMORY_KG_MAX_TEXT) {
      throw new MemoryKgError(`note.add cần text 1..${MEMORY_KG_MAX_TEXT} ký tự.`, 'bad-event');
    }
  }
  if (event.attributes !== undefined && !isJsonSafe(event.attributes)) {
    throw new MemoryKgError('Event attributes phải JSON-safe.', 'bad-event');
  }
}

/** Empty graph state. */
export function emptyState(): MemoryKgState {
  return { entities: new Map(), relations: new Map(), notes: new Map(), lastSeq: 0, lastTs: 0 };
}

/**
 * Apply one event to a state (mutates the state). Re-adding an
 * entity re-validates it (a new `entity.add` after an invalidate
 * is a correction, not a duplicate); invalidating an unknown id
 * is a no-op kept in the log for audit, not an error.
 */
export function applyEvent(state: MemoryKgState, event: MemoryKgEvent): void {
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  state.lastTs = Math.max(state.lastTs, event.ts);
  switch (event.type) {
    case 'entity.add': {
      const existing = state.entities.get(event.id);
      state.entities.set(event.id, {
        id: event.id,
        label: event.label ?? event.id,
        kind: event.kind ?? 'concept',
        attributes: { ...(event.attributes ?? {}) },
        createdAt: existing?.createdAt ?? event.ts,
        updatedAt: event.ts,
      });
      break;
    }
    case 'entity.invalidate': {
      const entity = state.entities.get(event.id);
      if (entity) {
        entity.invalidatedAt = event.ts;
        entity.invalidateReason = event.reason;
        entity.updatedAt = event.ts;
      }
      break;
    }
    case 'relation.add': {
      const existing = state.relations.get(event.id);
      state.relations.set(event.id, {
        id: event.id,
        from: event.from as string,
        to: event.to as string,
        label: event.label ?? 'related',
        attributes: { ...(event.attributes ?? {}) },
        createdAt: existing?.createdAt ?? event.ts,
        updatedAt: event.ts,
      });
      break;
    }
    case 'relation.invalidate': {
      const relation = state.relations.get(event.id);
      if (relation) {
        relation.invalidatedAt = event.ts;
        relation.invalidateReason = event.reason;
        relation.updatedAt = event.ts;
      }
      break;
    }
    case 'note.add': {
      state.notes.set(event.id, {
        id: event.id,
        text: event.text ?? '',
        entities: [...(event.entities ?? [])],
        createdAt: event.ts,
      });
      break;
    }
  }
}

/**
 * Replay events (in seq order) into a state. Throws on a hash
 * mismatch when `verifyHash` is set — a tampered log must not
 * replay silently.
 */
export function replayEvents(events: MemoryKgEvent[], options: { verifyHash?: boolean } = {}): MemoryKgState {
  const state = emptyState();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    if (options.verifyHash && event.hash !== undefined) {
      const { hash, ...rest } = event;
      void hash;
      if (hashEvent(rest) !== event.hash) {
        throw new MemoryKgError(`Event seq ${event.seq} sai hash — log có thể đã bị sửa.`, 'hash-mismatch');
      }
    }
    applyEvent(state, event);
  }
  return state;
}

/** Parse one JSONL line into an event (throws on bad JSON / shape). */
export function parseJsonlLine(line: string, lineNo: number): MemoryKgEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new MemoryKgError(`Dòng ${lineNo} trong JSONL không phải JSON hợp lệ.`, 'bad-jsonl');
  }
  if (!isRecord(parsed)) {
    throw new MemoryKgError(`Dòng ${lineNo} trong JSONL phải là object event.`, 'bad-jsonl');
  }
  const event = parsed as unknown as MemoryKgEvent;
  validateEvent(event);
  return event;
}

/** Serialise one event to a JSONL line (signed when `hash` is present). */
export function eventToJsonl(event: MemoryKgEvent): string {
  return JSON.stringify(event);
}

/** Tokenise text for recall scoring (lowercase, split on non-letters/digits, drop 1-char tokens). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9à-ỹ]+/u)
    .filter((t) => t.length > 1);
}

/**
 * Score one candidate text against query tokens: fraction of
 * query tokens present, boosted by repeated matches. 0 when
 * nothing matches.
 */
export function scoreMatch(queryTokens: string[], text: string): { score: number; matched: string[] } {
  if (queryTokens.length === 0) return { score: 0, matched: [] };
  const haystack = new Set(tokenize(text));
  const matched = queryTokens.filter((t) => haystack.has(t));
  if (matched.length === 0) return { score: 0, matched: [] };
  const coverage = matched.length / queryTokens.length;
  const unique = new Set(matched).size;
  return { score: Math.min(1, coverage * 0.7 + (unique / queryTokens.length) * 0.3), matched: [...new Set(matched)] };
}

/** Options for `recall`. */
export interface RecallOptions {
  /** Max hits (default 10). */
  limit?: number;
  /** Include invalidated facts (default false — recall shows live facts). */
  includeInvalidated?: boolean;
  /** Only entities of these kinds (when set). */
  kinds?: string[];
}

/**
 * Recall live facts matching a query: entities (label + kind +
 * attributes), relations (label + endpoints) and notes (text).
 * Score = token coverage, with a recency tie-break (newer first)
 * and a small boost for entities with more live relations.
 * Invalidated facts are excluded unless requested.
 */
export function recallFromState(
  state: MemoryKgState,
  query: string,
  options: RecallOptions = {},
): MemoryKgRecallHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const limit = Math.max(1, options.limit ?? 10);
  const includeInvalidated = options.includeInvalidated ?? false;
  const degree = new Map<string, number>();
  for (const rel of state.relations.values()) {
    if (rel.invalidatedAt !== undefined && !includeInvalidated) continue;
    degree.set(rel.from, (degree.get(rel.from) ?? 0) + 1);
    degree.set(rel.to, (degree.get(rel.to) ?? 0) + 1);
  }
  const hits: MemoryKgRecallHit[] = [];
  for (const entity of state.entities.values()) {
    if (entity.invalidatedAt !== undefined && !includeInvalidated) continue;
    if (options.kinds && !options.kinds.includes(entity.kind)) continue;
    const haystack = `${entity.label} ${entity.kind} ${Object.values(entity.attributes).join(' ')}`;
    const { score, matched } = scoreMatch(queryTokens, haystack);
    if (score <= 0) continue;
    const boost = Math.min(0.15, (degree.get(entity.id) ?? 0) * 0.03);
    hits.push({
      kind: 'entity',
      id: entity.id,
      text: `${entity.label} (${entity.kind})`,
      score: Math.min(1, score + boost),
      matchedTokens: matched,
      createdAt: entity.createdAt,
      ...(entity.invalidatedAt !== undefined ? { validUntil: entity.invalidatedAt } : {}),
    });
  }
  for (const relation of state.relations.values()) {
    if (relation.invalidatedAt !== undefined && !includeInvalidated) continue;
    const from = state.entities.get(relation.from);
    const to = state.entities.get(relation.to);
    const haystack = `${relation.label} ${from?.label ?? relation.from} ${to?.label ?? relation.to}`;
    const { score, matched } = scoreMatch(queryTokens, haystack);
    if (score <= 0) continue;
    hits.push({
      kind: 'relation',
      id: relation.id,
      text: `${from?.label ?? relation.from} — ${relation.label} → ${to?.label ?? relation.to}`,
      score,
      matchedTokens: matched,
      createdAt: relation.createdAt,
      ...(relation.invalidatedAt !== undefined ? { validUntil: relation.invalidatedAt } : {}),
    });
  }
  for (const note of state.notes.values()) {
    const { score, matched } = scoreMatch(queryTokens, note.text);
    if (score <= 0) continue;
    hits.push({
      kind: 'note',
      id: note.id,
      text: note.text.length > 200 ? `${note.text.slice(0, 200)}…` : note.text,
      score,
      matchedTokens: matched,
      createdAt: note.createdAt,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
  return hits.slice(0, limit);
}

/** Result of `diffTimerange`. */
export interface MemoryKgDiff {
  from: number;
  to: number;
  events: MemoryKgEvent[];
  addedEntities: string[];
  invalidatedEntities: string[];
  addedRelations: string[];
  invalidatedRelations: string[];
  addedNotes: string[];
}

/**
 * Events in `[from, to]` plus the net effect. Replays the log
 * twice is avoided: the caller passes already-loaded events.
 */
export function diffTimerange(events: MemoryKgEvent[], from: number, to: number): MemoryKgDiff {
  const inRange = events
    .filter((e) => e.ts >= from && e.ts <= to)
    .sort((a, b) => a.seq - b.seq);
  const addedEntities: string[] = [];
  const invalidatedEntities: string[] = [];
  const addedRelations: string[] = [];
  const invalidatedRelations: string[] = [];
  const addedNotes: string[] = [];
  for (const event of inRange) {
    if (event.type === 'entity.add') addedEntities.push(event.id);
    else if (event.type === 'entity.invalidate') invalidatedEntities.push(event.id);
    else if (event.type === 'relation.add') addedRelations.push(event.id);
    else if (event.type === 'relation.invalidate') invalidatedRelations.push(event.id);
    else if (event.type === 'note.add') addedNotes.push(event.id);
  }
  return {
    from,
    to,
    events: inRange,
    addedEntities,
    invalidatedEntities,
    addedRelations,
    invalidatedRelations,
    addedNotes,
  };
}

/** Statistics of a loaded graph (for the UI / diagnostics). */
export interface MemoryKgStats {
  events: number;
  liveEntities: number;
  invalidatedEntities: number;
  liveRelations: number;
  invalidatedRelations: number;
  notes: number;
  lastSeq: number;
  lastTs: number;
  fileBytes: number;
}

export function statsFromState(state: MemoryKgState, eventCount: number, fileBytes: number): MemoryKgStats {
  let liveEntities = 0;
  let invalidatedEntities = 0;
  for (const e of state.entities.values()) {
    if (e.invalidatedAt !== undefined) invalidatedEntities += 1;
    else liveEntities += 1;
  }
  let liveRelations = 0;
  let invalidatedRelations = 0;
  for (const r of state.relations.values()) {
    if (r.invalidatedAt !== undefined) invalidatedRelations += 1;
    else liveRelations += 1;
  }
  return {
    events: eventCount,
    liveEntities,
    invalidatedEntities,
    liveRelations,
    invalidatedRelations,
    notes: state.notes.size,
    lastSeq: state.lastSeq,
    lastTs: state.lastTs,
    fileBytes,
  };
}

/** Input for `remember` (the MCP `remember` tool shape). */
export interface RememberInput {
  /** Free text to store as a note. */
  text: string;
  /** Entities mentioned (id + label + kind). */
  entities?: { id: string; label: string; kind?: string; attributes?: Record<string, unknown> }[];
  /** Relations between entities. */
  relations?: { id: string; from: string; to: string; label: string; attributes?: Record<string, unknown> }[];
  /** Clock override (tests). */
  nowMs?: number;
}

/** Result of `remember`. */
export interface RememberResult {
  noteId: string;
  entityIds: string[];
  relationIds: string[];
  seqs: number[];
}

/**
 * File-backed JSONL knowledge graph. One instance owns one file;
 * appends are serialised through a promise chain, loads replay
 * the whole file. The in-memory state is the replayed state —
 * every public read goes through it, never through a stale cache.
 */
export class MemoryKgJsonl {
  readonly filePath: string;
  private readonly nowMs: () => number;
  private appendChain: Promise<void> = Promise.resolve();
  private state: MemoryKgState = emptyState();
  private events: MemoryKgEvent[] = [];
  private loaded = false;
  private idCounter = 0;

  constructor(filePath: string, options: { nowMs?: () => number } = {}) {
    this.filePath = filePath;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Load (or reload) the file: parse every line, verify hashes, replay. */
  async load(): Promise<MemoryKgState> {
    let content = '';
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState();
        this.events = [];
        this.loaded = true;
        return this.state;
      }
      throw err;
    }
    const events: MemoryKgEvent[] = [];
    const lines = content.split('\n');
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      if (line.trim().length === 0) continue;
      events.push(parseJsonlLine(line, lineNo));
    }
    events.sort((a, b) => a.seq - b.seq);
    // Seq must be continuous from the first seq — after a
    // `compact()` the log starts above 1 (pre-compaction state
    // lives in the `.snapshot.json` file, not in the log).
    const firstSeq = events.length > 0 ? (events[0] as MemoryKgEvent).seq : 1;
    for (let i = 0; i < events.length; i += 1) {
      if (events[i]?.seq !== firstSeq + i) {
        throw new MemoryKgError(
          `JSONL seq không liên tục: dòng ${i + 1} có seq ${events[i]?.seq}, cần ${firstSeq + i}.`,
          'bad-seq',
        );
      }
    }
    this.state = replayEvents(events, { verifyHash: true });
    this.events = events;
    this.loaded = true;
    return this.state;
  }

  /** Current state (loads the file first when never loaded). */
  async getState(): Promise<MemoryKgState> {
    if (!this.loaded) await this.load();
    return this.state;
  }

  /** Raw events (a copy, seq order). */
  async getEvents(): Promise<MemoryKgEvent[]> {
    if (!this.loaded) await this.load();
    return this.events.map((e) => ({ ...e }));
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.nowMs()}-${this.idCounter}`;
  }

  private async appendSigned(event: Omit<MemoryKgEvent, 'hash'>): Promise<MemoryKgEvent> {
    validateEvent(event);
    const signed = signEvent(event);
    const line = `${eventToJsonl(signed)}\n`;
    const run = this.appendChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, 'utf8');
    });
    this.appendChain = run.catch(() => undefined);
    await run;
    this.events.push(signed);
    applyEvent(this.state, signed);
    return signed;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new MemoryKgError('MemoryKgJsonl chưa load — gọi load() trước.', 'not-loaded');
    }
  }

  private nextSeq(): number {
    return this.state.lastSeq + 1;
  }

  /** Append an `entity.add` event. */
  async addEntity(input: {
    id?: string;
    label: string;
    kind?: string;
    attributes?: Record<string, unknown>;
  }): Promise<MemoryKgEvent> {
    this.ensureLoaded();
    const id = input.id ?? this.nextId('entity');
    if (!ID_RE.test(id)) throw new MemoryKgError(`Entity id không hợp lệ: ${JSON.stringify(id)}.`, 'bad-event');
    return this.appendSigned({
      seq: this.nextSeq(),
      ts: this.nowMs(),
      type: 'entity.add',
      id,
      label: input.label,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
    });
  }

  /** Append an `entity.invalidate` event (never deletes). */
  async invalidateEntity(id: string, reason?: string): Promise<MemoryKgEvent> {
    this.ensureLoaded();
    return this.appendSigned({
      seq: this.nextSeq(),
      ts: this.nowMs(),
      type: 'entity.invalidate',
      id,
      ...(reason ? { reason } : {}),
    });
  }

  /** Append a `relation.add` event. */
  async addRelation(input: {
    id?: string;
    from: string;
    to: string;
    label: string;
    attributes?: Record<string, unknown>;
  }): Promise<MemoryKgEvent> {
    this.ensureLoaded();
    const id = input.id ?? this.nextId('relation');
    if (!ID_RE.test(id)) throw new MemoryKgError(`Relation id không hợp lệ: ${JSON.stringify(id)}.`, 'bad-event');
    return this.appendSigned({
      seq: this.nextSeq(),
      ts: this.nowMs(),
      type: 'relation.add',
      id,
      from: input.from,
      to: input.to,
      label: input.label,
      ...(input.attributes ? { attributes: input.attributes } : {}),
    });
  }

  /** Append a `relation.invalidate` event. */
  async invalidateRelation(id: string, reason?: string): Promise<MemoryKgEvent> {
    this.ensureLoaded();
    return this.appendSigned({
      seq: this.nextSeq(),
      ts: this.nowMs(),
      type: 'relation.invalidate',
      id,
      ...(reason ? { reason } : {}),
    });
  }

  /** Append a `note.add` event. */
  async addNote(text: string, entities?: string[]): Promise<MemoryKgEvent> {
    this.ensureLoaded();
    return this.appendSigned({
      seq: this.nextSeq(),
      ts: this.nowMs(),
      type: 'note.add',
      id: this.nextId('note'),
      text,
      ...(entities ? { entities } : {}),
    });
  }

  /**
   * `remember`: store a note + its entities + relations in one
   * call. Returns the ids created. Entities/relations the caller
   * passes are upserted (re-adding an entity updates its label).
   */
  async remember(input: RememberInput): Promise<RememberResult> {
    this.ensureLoaded();
    const now = input.nowMs ?? this.nowMs();
    void now;
    const seqs: number[] = [];
    const entityIds: string[] = [];
    for (const entity of input.entities ?? []) {
      const event = await this.addEntity(entity);
      seqs.push(event.seq);
      entityIds.push(event.id);
    }
    const relationIds: string[] = [];
    for (const relation of input.relations ?? []) {
      const event = await this.addRelation(relation);
      seqs.push(event.seq);
      relationIds.push(event.id);
    }
    const note = await this.addNote(input.text, entityIds.length > 0 ? entityIds : undefined);
    seqs.push(note.seq);
    return { noteId: note.id, entityIds, relationIds, seqs };
  }

  /** `recall`: ranked live facts matching the query. */
  async recall(query: string, options: RecallOptions = {}): Promise<MemoryKgRecallHit[]> {
    const state = await this.getState();
    return recallFromState(state, query, options);
  }

  /** Time-travel read: state as of `ts` (replays events with ts <= given). */
  async getStateAt(ts: number): Promise<MemoryKgState> {
    const events = await this.getEvents();
    return replayEvents(events.filter((e) => e.ts <= ts));
  }

  /** Events + net effect in `[from, to]`. */
  async diffRange(from: number, to: number): Promise<MemoryKgDiff> {
    const events = await this.getEvents();
    return diffTimerange(events, from, to);
  }

  /** Verify the whole file: seq continuity + per-line hash. */
  async verifyIntegrity(): Promise<{ ok: boolean; events: number; badLines: number[] }> {
    const events = await this.getEvents();
    const badLines: number[] = [];
    const firstSeq = events.length > 0 ? (events[0] as MemoryKgEvent).seq : 1;
    events.forEach((event, index) => {
      if (event.seq !== firstSeq + index) badLines.push(index + 1);
      if (event.hash !== undefined) {
        const { hash, ...rest } = event;
        void hash;
        if (hashEvent(rest) !== event.hash) badLines.push(index + 1);
      }
    });
    return { ok: badLines.length === 0, events: events.length, badLines: [...new Set(badLines)] };
  }

  /** Statistics of the loaded graph + file size. */
  async stats(): Promise<MemoryKgStats> {
    const state = await this.getState();
    let fileBytes = 0;
    try {
      fileBytes = (await fs.stat(this.filePath)).size;
    } catch {
      fileBytes = 0;
    }
    return statsFromState(state, this.events.length, fileBytes);
  }

  /**
   * Compact: keep only events after `keepFromSeq` in the log
   * (older events are folded into a snapshot line at the head of
   * the file — a `note.add` carrying the snapshot would lose
   * history, so compaction instead writes a separate
   * `<file>.snapshot.json` and truncates the log; the snapshot
   * is advisory — `load()` reads the log only, so a truncated
   * log replays to the post-snapshot state by design).
   * Returns how many events were dropped.
   */
  async compact(keepFromSeq: number): Promise<{ dropped: number; kept: number }> {
    this.ensureLoaded();
    const kept = this.events.filter((e) => e.seq >= keepFromSeq);
    const dropped = this.events.length - kept.length;
    if (dropped <= 0) return { dropped: 0, kept: kept.length };
    const snapshot = {
      compactedAt: this.nowMs(),
      droppedThroughSeq: keepFromSeq - 1,
      state: {
        entities: [...this.state.entities.values()],
        relations: [...this.state.relations.values()],
        notes: [...this.state.notes.values()],
      },
    };
    await fs.writeFile(`${this.filePath}.snapshot.json`, JSON.stringify(snapshot, null, 2), 'utf8');
    const content = kept.map(eventToJsonl).join('\n');
    await fs.writeFile(this.filePath, content.length > 0 ? `${content}\n` : '', 'utf8');
    // Rebuild state from kept events only (pre-snapshot state is
    // preserved in the snapshot file, not in the live replay).
    this.events = kept.map((e) => ({ ...e }));
    this.state = replayEvents(this.events, { verifyHash: true });
    return { dropped, kept: kept.length };
  }

  /** Export the whole log as portable JSON (backup / migration). */
  async exportJson(): Promise<string> {
    const events = await this.getEvents();
    return exportEventsToJson(events, this.nowMs());
  }

  /**
   * Import events from a JSON export: validates the export, then
   * appends each event with a FRESH seq continuing this log
   * (original seqs are history, not identity — re-using them
   * would collide with this log's own seqs). Hashes are
   * re-signed on append. Returns how many events were imported.
   */
  async importJson(text: string): Promise<{ imported: number }> {
    this.ensureLoaded();
    const events = parseExportedEvents(text);
    for (const event of events) {
      const { seq, hash, ...rest } = event;
      void seq;
      void hash;
      await this.appendSigned({ ...rest, seq: this.nextSeq(), ts: event.ts });
    }
    return { imported: events.length };
  }
}

/** One-line summary of graph stats, for the memory panel. */
export function describeMemoryKgStats(stats: MemoryKgStats): string {
  return `KG: ${stats.events} event, ${stats.liveEntities} entity sống` +
    (stats.invalidatedEntities > 0 ? ` (${stats.invalidatedEntities} đã vô hiệu)` : '') +
    `, ${stats.liveRelations} relation sống, ${stats.notes} note`;
}

/** Export format for a graph: versioned envelope around the event list. */
export interface MemoryKgExport {
  version: 1;
  exportedAt: number;
  events: MemoryKgEvent[];
}

/** Serialise events to a portable JSON export (backup / move to another machine). */
export function exportEventsToJson(events: MemoryKgEvent[], nowMs: number = Date.now()): string {
  const envelope: MemoryKgExport = {
    version: 1,
    exportedAt: nowMs,
    events: [...events].sort((a, b) => a.seq - b.seq),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Parse a JSON export back into events: validates the envelope,
 * every event's shape, seq continuity (from the first seq) and
 * every hash. Throws `MemoryKgError` on the first problem — a
 * corrupt backup must never import half-way.
 */
export function parseExportedEvents(text: string): MemoryKgEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MemoryKgError('Export memory KG không phải JSON hợp lệ.', 'bad-export');
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['events'])) {
    throw new MemoryKgError('Export memory KG sai hình dạng (cần version 1 + events).', 'bad-export');
  }
  const events = (parsed['events'] as unknown[]).map((raw, index) => {
    if (!isRecord(raw)) {
      throw new MemoryKgError(`Export event thứ ${index + 1} phải là object.`, 'bad-export');
    }
    return parseJsonlLine(JSON.stringify(raw), index + 1);
  });
  events.sort((a, b) => a.seq - b.seq);
  const firstSeq = events.length > 0 ? (events[0] as MemoryKgEvent).seq : 1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.seq !== firstSeq + i) {
      throw new MemoryKgError(`Export seq không liên tục ở event thứ ${i + 1}.`, 'bad-export');
    }
  }
  for (const event of events) {
    if (event.hash !== undefined) {
      const { hash, ...rest } = event;
      void hash;
      if (hashEvent(rest) !== event.hash) {
        throw new MemoryKgError(`Export event seq ${event.seq} sai hash.`, 'hash-mismatch');
      }
    }
  }
  return events;
}
