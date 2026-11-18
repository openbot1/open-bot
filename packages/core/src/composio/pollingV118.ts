/**
 * Composio polling v5 — adaptive per-connection polling (v1.18, Doi T4).
 *
 * Tang tren 3 tang da co — KHONG viet lai:
 * - `pollPolicyV111.ts`: adaptive interval (hit rut / miss gian /
 *   error backoff manh + jitter + dedupe theo cua so). V5 DUNG LAI
 *   `nextComposioV111Poll` lam may tinh interval, them 2 che do moi
 *   ben tren: BURST (2 hit lien tiep tro len → interval ve thang
 *   min, khong cho qua 1 buoc hitFactor, de bat kip kenh dang soi
 *   dong) va IDLE CAP (miss lien tiep >= `idleCapAfterMisses` thi
 *   interval bi khoa o max, khong tinh lai nua — tiet kiem quota).
 * - `pollSchedulerV2.ts`: lich poll theo connection + checkpoint
 *   resume. V5 DUNG LAI dinh dang checkpoint y tuong do nhung state
 *   o day rong hon: moi connection giu ca policy state (V111),
 *   seen ids, cursor, lastFiredAtMs, totalNewItems — serialize ra
 *   JSON de luu xuong dia, resume sau restart.
 * - `pollCheckpointStoreV114.ts`: mau store (memory + JSON file
 *   atomic). V5 co store rieng cho state per-connection, cung mau.
 *
 * Moi trong v5:
 * 1. Adaptive interval that su theo tung CONNECTION (khong phai theo
 *    ten poller): moi connection co policy rieng (base interval theo
 *    toolkit — Gmail nhanh, Xero cham — giong bang v114).
 * 2. Dedupe event theo id trong cua so 24h (dung lai V111 seenIds)
 *    + cap seen ids moi connection (mac dinh 1000).
 * 3. Backoff khi loi: dung lai errorFactor cua V111 (nhan 2 moi loi
 *    lien tiep, cap o maxIntervalMs cua policy).
 * 4. Per-connection polling state persist: `ComposioV118PollStateStore`
 *    (memory + JSON file atomic, mode 0600) — luu id + interval +
 *    streak + seen + cursor + lastFired; KHONG chua secret/key.
 * 5. Engine `ComposioV118PollEngine`: giu nhieu connection, `tick`
 *    chi chay connection den han + dang bat, loi mot connection khong
 *    anh huong connection khac, tu dong persist state sau moi tick.
 *
 * Tat ca ham quyet dinh deu thuan (khong doc/ghi file, khong goi
 * mang, khong dong ho thuc — `nowMs` do caller truyen vao). Chi
 * engine + store giu state; fetch do caller cung cap (trong app that
 * la ComposioPoller, trong test la mock).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMPOSIO_V111_DEFAULT_DEDUPE_WINDOW_MS,
  COMPOSIO_V111_DEFAULT_MAX_SEEN_IDS,
  DEFAULT_COMPOSIO_V111_POLL_POLICY,
  emptyComposioV111PollPolicyState,
  nextComposioV111Poll,
  validateComposioV111PollPolicy,
  type ComposioV111PollOutcome,
  type ComposioV111PollPolicy,
  type ComposioV111PollPolicyState,
} from './pollPolicyV111';
import { COMPOSIO_V114_DEFAULT_INTERVAL_BY_TOOLKIT, COMPOSIO_V114_DEFAULT_INTERVAL_MS } from './pollSchedulerV2';

/** Phien ban dinh dang state persist v118 (de migrate sau nay). */
export const COMPOSIO_V118_POLL_STATE_VERSION = 1;
/** Ten file state poll v118 trong thu muc composio cua userData. */
export const COMPOSIO_V118_POLL_STATE_FILE = 'composio-poll-state-v118.json';
/** So miss lien tiep thi khoa interval o max (idle cap). */
export const COMPOSIO_V118_DEFAULT_IDLE_CAP_AFTER_MISSES = 5;
/** So hit lien tiep thi bat burst mode (interval ve min ngay). */
export const COMPOSIO_V118_DEFAULT_BURST_AFTER_HITS = 2;
/** Cua so dedupe mac dinh: 24 gio (bang V111). */
export const COMPOSIO_V118_DEFAULT_DEDUPE_WINDOW_MS = COMPOSIO_V111_DEFAULT_DEDUPE_WINDOW_MS;
/** Giu toi da 1000 id da thay moi connection. */
export const COMPOSIO_V118_DEFAULT_MAX_SEEN_IDS = COMPOSIO_V111_DEFAULT_MAX_SEEN_IDS;

/** Interval mac dinh cho mot toolkit (bang v114, fallback 10 phut). */
export function defaultComposioV118IntervalMs(toolkit: string): number {
  return COMPOSIO_V114_DEFAULT_INTERVAL_BY_TOOLKIT[toolkit] ?? COMPOSIO_V114_DEFAULT_INTERVAL_MS;
}

/** Che do poll hien tai cua mot connection (de UI hien). */
export type ComposioV118PollMode = 'burst' | 'normal' | 'idle' | 'error' | 'disabled';

/** State poll day du cua MOT connection (persist duoc). */
export interface ComposioV118PollConnState {
  /** Id connection Composio (khong chua secret, chi la id). */
  connectionId: string;
  /** Slug toolkit, vd 'gmail'. */
  toolkit: string;
  /** Slug trigger dang poll, vd 'GMAIL_NEW_GMAIL_MESSAGE'. */
  triggerSlug: string;
  /** Policy adaptive (V111) cua connection nay. */
  policy: ComposioV111PollPolicy;
  /** State adaptive (V111): interval hien tai, streak hit/miss/error, seen ids. */
  policyState: ComposioV111PollPolicyState;
  /** Cursor phan trang/lan cuoi tra ve (neu co) — de resume. */
  lastCursor: string | null;
  /** Lan poll ke tiep (epoch ms). */
  nextPollAtMs: number;
  /** Lan poll gan nhat (epoch ms) — null neu chua poll lan nao. */
  lastPollAtMs: number | null;
  /** Lan nhan duoc item MOI gan nhat (epoch ms) — null neu chua co. */
  lastFiredAtMs: number | null;
  /** Tong so item moi da nhan (tich luy). */
  totalNewItems: number;
  /** false = tam dung connection (khong poll nua nhung giu state). */
  enabled: boolean;
  /** So miss lien tiep de khoa idle cap (>= thi interval = max). */
  idleCapAfterMisses: number;
  /** So hit lien tiep de bat burst (>= thi interval = min). */
  burstAfterHits: number;
}

/** Input tao state connection — chi can connection/toolkit/trigger. */
export interface ComposioV118CreateConnStateInput {
  connectionId: string;
  toolkit: string;
  triggerSlug: string;
  /** Epoch ms bat dau poll (mac dinh: poll ngay). */
  startAtMs?: number;
  /** Ghi de policy adaptive (mac dinh: policy V111 + base theo toolkit). */
  policy?: Partial<ComposioV111PollPolicy>;
  idleCapAfterMisses?: number;
  burstAfterHits?: number;
  enabled?: boolean;
}

function assertConnId(connectionId: string): void {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    throw new Error('connectionId must be a non-empty string');
  }
}

function assertTriggerSlug(triggerSlug: string): void {
  if (typeof triggerSlug !== 'string' || !/^[A-Z][A-Z0-9_]{2,}$/.test(triggerSlug)) {
    throw new Error(`triggerSlug must match ^[A-Z][A-Z0-9_]{2,}$ (got ${triggerSlug})`);
  }
}

/** Tao state connection moi (validate truoc khi tra). */
export function createComposioV118ConnState(input: ComposioV118CreateConnStateInput): ComposioV118PollConnState {
  assertConnId(input.connectionId);
  if (typeof input.toolkit !== 'string' || input.toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
  assertTriggerSlug(input.triggerSlug);
  const base = input.policy?.baseIntervalMs ?? defaultComposioV118IntervalMs(input.toolkit);
  const policy = validateComposioV111PollPolicy({ ...DEFAULT_COMPOSIO_V111_POLL_POLICY, ...input.policy, baseIntervalMs: base });
  const nowMs = typeof input.startAtMs === 'number' ? input.startAtMs : Date.now();
  const state: ComposioV118PollConnState = {
    connectionId: input.connectionId,
    toolkit: input.toolkit,
    triggerSlug: input.triggerSlug,
    policy,
    policyState: emptyComposioV111PollPolicyState(
      `poll:${input.toolkit}:${input.connectionId}`,
      { ...policy, baseIntervalMs: base },
    ),
    lastCursor: null,
    nextPollAtMs: nowMs,
    lastPollAtMs: null,
    lastFiredAtMs: null,
    totalNewItems: 0,
    enabled: input.enabled ?? true,
    idleCapAfterMisses: input.idleCapAfterMisses ?? COMPOSIO_V118_DEFAULT_IDLE_CAP_AFTER_MISSES,
    burstAfterHits: input.burstAfterHits ?? COMPOSIO_V118_DEFAULT_BURST_AFTER_HITS,
  };
  validateComposioV118ConnState(state);
  return state;
}

/** Kiem tra mot state connection co hop le khong (throw neu sai). */
export function validateComposioV118ConnState(s: ComposioV118PollConnState): void {
  assertConnId(s.connectionId);
  if (typeof s.toolkit !== 'string' || s.toolkit.trim() === '') throw new Error('toolkit must be a non-empty string');
  assertTriggerSlug(s.triggerSlug);
  validateComposioV111PollPolicy(s.policy);
  if (typeof s.policyState !== 'object' || s.policyState === null) throw new Error('policyState must be an object');
  if (!Number.isFinite(s.nextPollAtMs) || s.nextPollAtMs < 0) throw new Error('nextPollAtMs must be a non-negative number');
  if (s.lastPollAtMs !== null && (!Number.isFinite(s.lastPollAtMs) || s.lastPollAtMs < 0)) {
    throw new Error('lastPollAtMs must be null or a non-negative number');
  }
  if (s.lastFiredAtMs !== null && (!Number.isFinite(s.lastFiredAtMs) || s.lastFiredAtMs < 0)) {
    throw new Error('lastFiredAtMs must be null or a non-negative number');
  }
  if (!Number.isInteger(s.totalNewItems) || s.totalNewItems < 0) throw new Error('totalNewItems must be a non-negative integer');
  if (!Number.isInteger(s.idleCapAfterMisses) || s.idleCapAfterMisses < 1) {
    throw new Error('idleCapAfterMisses must be a positive integer');
  }
  if (!Number.isInteger(s.burstAfterHits) || s.burstAfterHits < 1) {
    throw new Error('burstAfterHits must be a positive integer');
  }
  if (typeof s.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (!Array.isArray(s.policyState.seenIds)) throw new Error('policyState.seenIds must be an array');
}

/**
 * Che do poll hien tai cua mot connection:
 * - disabled: tat; error: loi lien tiep > 0; burst: hit lien tiep
 *   >= burstAfterHits; idle: miss lien tiep >= idleCapAfterMisses;
 *   normal: con lai.
 */
export function composioV118PollMode(state: ComposioV118PollConnState): ComposioV118PollMode {
  if (!state.enabled) return 'disabled';
  if (state.policyState.consecutiveErrors > 0) return 'error';
  if (state.policyState.consecutiveHits >= state.burstAfterHits) return 'burst';
  if (state.policyState.consecutiveMisses >= state.idleCapAfterMisses) return 'idle';
  return 'normal';
}

/**
 * Cap nhat state SAU MOT LAN POLL (ham thuan):
 * - outcome 'hit' (co item moi): V111 rut interval; neu streak hit
 *   >= burstAfterHits thi interval ve thang min (burst).
 * - outcome 'miss' (khong co item moi): V111 gian interval; neu
 *   streak miss >= idleCapAfterMisses thi khoa interval o max.
 * - outcome 'error': V111 backoff (nhan errorFactor, cap max).
 * - Cap nhat seen ids (chi id moi), cursor, lastFiredAtMs,
 *   totalNewItems, nextPollAtMs (now + interval moi, khong jitter o
 *   day — jitter do caller ap khi can, de test xac dinh).
 */
export function nextComposioV118Poll(
  prev: ComposioV118PollConnState,
  outcome: ComposioV111PollOutcome,
  opts: {
    nowMs?: number;
    error?: string;
    newItemIds?: readonly string[];
    cursor?: string | null;
  } = {},
): ComposioV118PollConnState {
  const nowMs = opts.nowMs ?? Date.now();
  const { state: policyState } = nextComposioV111Poll(prev.policyState, outcome, prev.policy, {
    nowMs,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    random: () => 0.5, // tat jitter trong may tinh state — interval goc, khong jitter.
  });
  // Ghi seen ids moi (chi id chua thay trong cua so).
  const windowStart = nowMs - prev.policy.dedupeWindowMs;
  const keptSeen = policyState.seenIds.filter((s) => s.atMs >= windowStart);
  const known = new Set(keptSeen.map((s) => s.id));
  const freshIds: string[] = [];
  for (const id of opts.newItemIds ?? []) {
    if (typeof id !== 'string' || id === '') continue;
    if (known.has(id)) continue;
    known.add(id);
    keptSeen.push({ id, atMs: nowMs });
    freshIds.push(id);
  }
  const seenIds = keptSeen.slice(-prev.policy.maxSeenIds);
  let currentIntervalMs = policyState.currentIntervalMs;
  // Burst: hit lien tiep du nguong → ve thang min.
  if (outcome === 'hit' && policyState.consecutiveHits >= prev.burstAfterHits) {
    currentIntervalMs = prev.policy.minIntervalMs;
  }
  // Idle cap: miss lien tiep du nguong → khoa o max.
  if (outcome === 'miss' && policyState.consecutiveMisses >= prev.idleCapAfterMisses) {
    currentIntervalMs = prev.policy.maxIntervalMs;
  }
  const next: ComposioV118PollConnState = {
    ...prev,
    policyState: { ...policyState, currentIntervalMs, seenIds },
    lastCursor: opts.cursor !== undefined ? opts.cursor : prev.lastCursor,
    nextPollAtMs: nowMs + currentIntervalMs,
    lastPollAtMs: nowMs,
    lastFiredAtMs: outcome === 'hit' ? nowMs : prev.lastFiredAtMs,
    totalNewItems: prev.totalNewItems + freshIds.length,
  };
  validateComposioV118ConnState(next);
  return next;
}

/** Connection co den han poll tai `nowMs` khong (bat + da toi gio). */
export function isComposioV118ConnDue(state: ComposioV118PollConnState, nowMs: number): boolean {
  return state.enabled && nowMs >= state.nextPollAtMs;
}

/** So ms con lai toi lan poll ke (0 neu da den han, -1 neu tat). */
export function composioV118MsUntilNextPoll(state: ComposioV118PollConnState, nowMs: number): number {
  if (!state.enabled) return -1;
  return Math.max(0, state.nextPollAtMs - nowMs);
}

/** Mot item poll (id bat buoc, cac field khac tuy toolkit). */
export interface ComposioV118PollItem {
  id: string;
  [key: string]: unknown;
}

/** Tach item moi khoi item trung theo seen cua connection. */
export function filterComposioV118NewItems(
  items: readonly ComposioV118PollItem[],
  state: ComposioV118PollConnState,
  nowMs: number,
): { fresh: ComposioV118PollItem[]; duplicates: ComposioV118PollItem[] } {
  const windowStart = nowMs - state.policy.dedupeWindowMs;
  const seen = new Set(state.policyState.seenIds.filter((s) => s.atMs >= windowStart).map((s) => s.id));
  const fresh: ComposioV118PollItem[] = [];
  const duplicates: ComposioV118PollItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) duplicates.push(item);
    else fresh.push(item);
  }
  return { fresh, duplicates };
}

// ---------------------------------------------------------------------------
// Persist — serialize/parse state per-connection
// ---------------------------------------------------------------------------

/** Ban ghi persist cua mot connection (JSON-safe). */
export interface ComposioV118PollStateDoc {
  version: number;
  state: ComposioV118PollConnState;
  savedAtMs: number;
}

/** Serialize mot state thanh JSON (de luu xuong dia). */
export function serializeComposioV118PollState(state: ComposioV118PollConnState, nowMs: number): string {
  validateComposioV118ConnState(state);
  const doc: ComposioV118PollStateDoc = { version: COMPOSIO_V118_POLL_STATE_VERSION, state, savedAtMs: nowMs };
  return JSON.stringify(doc);
}

/** Parse mot state tu JSON (throw neu sai dinh dang). */
export function parseComposioV118PollState(json: string): ComposioV118PollConnState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('poll state JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('poll state JSON must be an object');
  }
  const doc = parsed as ComposioV118PollStateDoc;
  if (doc.version !== COMPOSIO_V118_POLL_STATE_VERSION) {
    throw new Error(`unsupported poll state version: ${doc.version}`);
  }
  validateComposioV118ConnState(doc.state);
  return doc.state;
}

/** So lan poll da lo giua lan poll ke va bay gio (de UI bao catch-up). */
export function missedComposioV118Polls(state: ComposioV118PollConnState, nowMs: number): number {
  const interval = state.policyState.currentIntervalMs;
  if (interval <= 0 || nowMs <= state.nextPollAtMs) return 0;
  return Math.floor((nowMs - state.nextPollAtMs) / interval);
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600)
// ---------------------------------------------------------------------------

/** Interface chung cho ca hai store. */
export interface ComposioV118PollStateStore {
  save(state: ComposioV118PollConnState): void;
  saveAll(states: readonly ComposioV118PollConnState[]): void;
  load(connectionId: string): ComposioV118PollConnState | undefined;
  loadAll(): ComposioV118PollConnState[];
  remove(connectionId: string): boolean;
  clear(): void;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV118PollStateStore implements ComposioV118PollStateStore {
  private readonly states = new Map<string, ComposioV118PollConnState>();

  save(state: ComposioV118PollConnState): void {
    validateComposioV118ConnState(state);
    this.states.set(state.connectionId, JSON.parse(JSON.stringify(state)) as ComposioV118PollConnState);
  }

  saveAll(states: readonly ComposioV118PollConnState[]): void {
    for (const s of states) this.save(s);
  }

  load(connectionId: string): ComposioV118PollConnState | undefined {
    assertConnId(connectionId);
    const s = this.states.get(connectionId);
    return s ? (JSON.parse(JSON.stringify(s)) as ComposioV118PollConnState) : undefined;
  }

  loadAll(): ComposioV118PollConnState[] {
    return [...this.states.values()].map((s) => JSON.parse(JSON.stringify(s)) as ComposioV118PollConnState);
  }

  remove(connectionId: string): boolean {
    return this.states.delete(connectionId);
  }

  clear(): void {
    this.states.clear();
  }
}

/** Tuy chon cho file store. */
export interface JsonFileComposioV118PollStateStoreOptions {
  /** Thu muc chua file state (vd `<userData>/composio`). */
  dir: string;
  /** Ten file (mac dinh COMPOSIO_V118_POLL_STATE_FILE). */
  fileName?: string;
}

/** Duong dan file state cua store. */
export function getComposioV118PollStatePath(dir: string, fileName: string = COMPOSIO_V118_POLL_STATE_FILE): string {
  return path.join(dir, fileName);
}

/**
 * Store state tren dia (file JSON). Ghi atomic: ghi file tam trong
 * cung thu muc roi rename — app co tat giua chung thi file cu van
 * nguyen. Doc file khong ton tai tra ve [] (chua co state nao); file
 * hong (JSON sai / entry sai dinh dang) thi throw ro.
 */
export class JsonFileComposioV118PollStateStore implements ComposioV118PollStateStore {
  private readonly filePath: string;

  constructor(options: JsonFileComposioV118PollStateStoreOptions) {
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
      throw new Error('poll state store dir must be a non-empty string');
    }
    this.filePath = getComposioV118PollStatePath(options.dir, options.fileName);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  save(state: ComposioV118PollConnState): void {
    const all = this.loadAll();
    const idx = all.findIndex((s) => s.connectionId === state.connectionId);
    if (idx >= 0) all[idx] = state;
    else all.push(state);
    this.saveAll(all);
  }

  saveAll(states: readonly ComposioV118PollConnState[]): void {
    for (const s of states) validateComposioV118ConnState(s);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows khong co chmod unix — bo qua.
    }
  }

  load(connectionId: string): ComposioV118PollConnState | undefined {
    assertConnId(connectionId);
    return this.loadAll().find((s) => s.connectionId === connectionId);
  }

  loadAll(): ComposioV118PollConnState[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`Invalid ${COMPOSIO_V118_POLL_STATE_FILE}: expected an array.`);
    return raw.map((entry) => {
      validateComposioV118ConnState(entry);
      return entry as ComposioV118PollConnState;
    });
  }

  remove(connectionId: string): boolean {
    const all = this.loadAll();
    const kept = all.filter((s) => s.connectionId !== connectionId);
    if (kept.length === all.length) return false;
    this.saveAll(kept);
    return true;
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }
}

// ---------------------------------------------------------------------------
// Engine — chay nhieu connection, dedupe, persist
// ---------------------------------------------------------------------------

/** Ham fetch do caller cung cap: tra item moi cua mot connection (mock trong test). */
export type ComposioV118FetchFn = (
  state: ComposioV118PollConnState,
  cursor: string | null,
) => Promise<{ items: ComposioV118PollItem[]; cursor?: string | null }>;

/** Ket qua mot lan poll cua engine (de UI/log doc). */
export interface ComposioV118TickResult {
  connectionId: string;
  toolkit: string;
  ok: boolean;
  fresh: number;
  duplicates: number;
  mode: ComposioV118PollMode;
  error?: string;
  nextPollAtMs: number;
}

/** Tuy chon engine. */
export interface ComposioV118PollEngineOptions {
  /** Store persist (mac dinh: memory — host truyen file store khi co userData). */
  store?: ComposioV118PollStateStore;
  /** true = persist state sau moi tick (mac dinh true). */
  persistAfterTick?: boolean;
}

/**
 * Engine poll v5: giu nhieu connection (moi connection mot lich
 * adaptive), moi connection co state + seen + checkpoint rieng.
 * `tick` chi chay connection den han; loi cua mot connection khong
 * anh huong connection khac. Engine khong goi mang — fetch do caller
 * cung cap.
 */
export class ComposioV118PollEngine {
  private readonly states = new Map<string, ComposioV118PollConnState>();
  private readonly store: ComposioV118PollStateStore;
  private readonly persistAfterTick: boolean;

  constructor(options: ComposioV118PollEngineOptions = {}) {
    this.store = options.store ?? new MemoryComposioV118PollStateStore();
    this.persistAfterTick = options.persistAfterTick ?? true;
  }

  /** Them connection (throw neu trung connectionId). */
  addConnection(state: ComposioV118PollConnState): void {
    validateComposioV118ConnState(state);
    if (this.states.has(state.connectionId)) throw new Error(`duplicate poll connection id: ${state.connectionId}`);
    this.states.set(state.connectionId, JSON.parse(JSON.stringify(state)) as ComposioV118PollConnState);
    if (this.persistAfterTick) this.store.save(state);
  }

  /** Xoa connection (true neu co de xoa). */
  removeConnection(connectionId: string): boolean {
    this.store.remove(connectionId);
    return this.states.delete(connectionId);
  }

  /** Lay ban sao state (undefined neu khong co). */
  getConnection(connectionId: string): ComposioV118PollConnState | undefined {
    const s = this.states.get(connectionId);
    return s ? (JSON.parse(JSON.stringify(s)) as ComposioV118PollConnState) : undefined;
  }

  /** Tat ca state (ban sao). */
  listConnections(): ComposioV118PollConnState[] {
    return [...this.states.values()].map((s) => JSON.parse(JSON.stringify(s)) as ComposioV118PollConnState);
  }

  /** Connection den han tai `nowMs`. */
  dueConnections(nowMs: number): ComposioV118PollConnState[] {
    return this.listConnections().filter((s) => isComposioV118ConnDue(s, nowMs));
  }

  /** Bat/tat mot connection (giu state). */
  setEnabled(connectionId: string, enabled: boolean): ComposioV118PollConnState {
    const s = this.states.get(connectionId);
    if (!s) throw new Error(`unknown poll connection id: ${connectionId}`);
    const next = { ...s, enabled };
    this.states.set(connectionId, next);
    if (this.persistAfterTick) this.store.save(next);
    return JSON.parse(JSON.stringify(next)) as ComposioV118PollConnState;
  }

  /** Khoi phuc tat ca state tu store (vd app khoi dong lai). */
  restoreFromStore(): number {
    const loaded = this.store.loadAll();
    for (const s of loaded) this.states.set(s.connectionId, s);
    return loaded.length;
  }

  /**
   * Chay tat ca connection den han tai `nowMs`: fetch → dedupe →
   * cap nhat adaptive/burst/idle/backoff → persist. Tra ket qua
   * tung connection; loi fetch chi anh huong connection do.
   */
  async tick(nowMs: number, fetch: ComposioV118FetchFn): Promise<ComposioV118TickResult[]> {
    const results: ComposioV118TickResult[] = [];
    for (const state of this.dueConnections(nowMs)) {
      try {
        const { items, cursor } = await fetch(state, state.lastCursor);
        const { fresh, duplicates } = filterComposioV118NewItems(items, state, nowMs);
        const outcome: ComposioV111PollOutcome = fresh.length > 0 ? 'hit' : 'miss';
        const next = nextComposioV118Poll(state, outcome, {
          nowMs,
          newItemIds: fresh.map((i) => i.id),
          cursor,
        });
        this.states.set(state.connectionId, next);
        if (this.persistAfterTick) this.store.save(next);
        results.push({
          connectionId: state.connectionId,
          toolkit: state.toolkit,
          ok: true,
          fresh: fresh.length,
          duplicates: duplicates.length,
          mode: composioV118PollMode(next),
          nextPollAtMs: next.nextPollAtMs,
        });
      } catch (err) {
        const next = nextComposioV118Poll(state, 'error', {
          nowMs,
          error: err instanceof Error ? err.message : String(err),
        });
        this.states.set(state.connectionId, next);
        if (this.persistAfterTick) this.store.save(next);
        results.push({
          connectionId: state.connectionId,
          toolkit: state.toolkit,
          ok: false,
          fresh: 0,
          duplicates: 0,
          mode: composioV118PollMode(next),
          error: err instanceof Error ? err.message : String(err),
          nextPollAtMs: next.nextPollAtMs,
        });
      }
    }
    return results;
  }

  /** Tom tat nhanh cho UI: bao nhieu connection, bao nhieu den han, bao nhieu loi/burst/idle. */
  summarize(nowMs: number): {
    total: number;
    enabled: number;
    due: number;
    erroring: number;
    bursting: number;
    idle: number;
    totalNewItems: number;
    nextPollAtMs: number | null;
  } {
    const all = this.listConnections();
    const due = all.filter((s) => isComposioV118ConnDue(s, nowMs)).length;
    const enabled = all.filter((s) => s.enabled).length;
    const erroring = all.filter((s) => s.policyState.consecutiveErrors > 0).length;
    const bursting = all.filter((s) => composioV118PollMode(s) === 'burst').length;
    const idle = all.filter((s) => composioV118PollMode(s) === 'idle').length;
    const totalNewItems = all.reduce((n, s) => n + s.totalNewItems, 0);
    const upcoming = all
      .filter((s) => s.enabled)
      .map((s) => s.nextPollAtMs)
      .sort((a, b) => a - b);
    return { total: all.length, enabled, due, erroring, bursting, idle, totalNewItems, nextPollAtMs: upcoming[0] ?? null };
  }
}
