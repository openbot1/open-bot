/**
 * Fleet v10 — event-triggered agents (v1.13, Doi T6).
 *
 * Tang tren automations v2 (`automations/engine.ts`) va fleet v6/v9
 * scheduler: automations biet trigger `event` (file-changed /
 * agent-done) nhung chi chay trong mot bot, khong co debounce /
 * throttle / gioi han theo gio, khong co lich su danh gia rieng cho
 * tung trigger, va khong biet chu so huu (user) cua trigger.
 *
 * Module nay them lop trigger danh cho FLEET (nhieu agent, nhieu user,
 * chay local):
 * - Su kien: `file-changed` (file doi trong workspace), `webhook-local`
 *   (webhook noi bo da ky HMAC — secret KHONG nam o day, chi luu
 *   keyId), `calendar-due` (su kien lich toi gio), `message-inbound`
 *   (tin nhan den tu kenh da noi), `agent-done` (mot agent khac xong
 *   viec), `queue-depth` (hang doi vuot nguong).
 * - Dieu kien loc: glob duong dan, loai su kien, khop truong payload
 *   (bang chinh xac hoac glob), gioi han theo user so huu su kien.
 * - Chong lap: debounce (gom nhieu su kien lien tiep thanh 1 lan
 *   chay), throttle (toi da 1 lan chay moi N ms), cooldown sau moi lan
 *   chay, gioi han so lan chay moi gio — tat ca xac dinh (khong
 *   random) de test duoc.
 * - Ham thuan + luu file tach rieng nhu cac module fleet truoc:
 *   `evaluateFleetV10Triggers(events, triggers, runs, now)` la ham
 *   thuan: voi danh sach su kien cho truoc tra ve quyet dinh cho tung
 *   trigger (fire / debounce / throttle / filtered) ma khong spawn
 *   process, khong cham mang.
 * - File ben: `fleet-triggers-v113.json` + `fleet-trigger-runs-v113.json`
 *   duoi fleet root (atomic tmp + rename, mode 0600). Khong chua secret.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File luu trigger v10 trong fleet root. */
export const FLEET_V10_TRIGGERS_FILE = 'fleet-triggers-v113.json';
/** File luu lich su chay trigger v10 trong fleet root. */
export const FLEET_V10_TRIGGER_RUNS_FILE = 'fleet-trigger-runs-v113.json';
/** Gioi han so trigger trong mot fleet root. */
export const FLEET_V10_MAX_TRIGGERS = 200;
/** Gioi han so ban ghi lich su chay duoc giu. */
export const FLEET_V10_MAX_TRIGGER_RUNS = 1000;
/** Debounce mac dinh: gom su kien trong 5 giay. */
export const FLEET_V10_DEFAULT_DEBOUNCE_MS = 5_000;
/** Throttle mac dinh: toi da 1 lan chay moi 60 giay. */
export const FLEET_V10_DEFAULT_THROTTLE_MS = 60_000;
/** Cooldown mac dinh sau moi lan chay: 0 (khong cho). */
export const FLEET_V10_DEFAULT_COOLDOWN_MS = 0;
/** Gioi han chay mac dinh moi gio. */
export const FLEET_V10_DEFAULT_MAX_RUNS_PER_HOUR = 20;

/** Loai su kien co the kich hoat mot agent. */
export type FleetV10EventKind =
  | 'file-changed'
  | 'webhook-local'
  | 'calendar-due'
  | 'message-inbound'
  | 'agent-done'
  | 'queue-depth';

export const FLEET_V10_EVENT_KINDS: readonly FleetV10EventKind[] = [
  'file-changed',
  'webhook-local',
  'calendar-due',
  'message-inbound',
  'agent-done',
  'queue-depth',
];

/** Mot su kien den tu ben ngoai (file, webhook, lich, kenh nhan, agent). */
export interface FleetV10Event {
  /** Id on dinh cua su kien (de idempotency: trung id = bo qua). */
  id: string;
  kind: FleetV10EventKind;
  /** Epoch ms luc su kien xay ra. */
  at: number;
  /** Nguon phat su kien (vd ten kenh, duong dan file, ten lich). */
  source: string;
  /** Duong dan file (chi `file-changed`). */
  filePath?: string;
  /** User so huu su kien (neu biet); trigger co the loc theo user. */
  userId?: string;
  /** Payload tu do cua su kien (chi gia tri JSON don gian). */
  payload?: Record<string, string | number | boolean>;
  /** Id HMAC key trong Vault (chi `webhook-local`); secret KHONG luu o day. */
  keyId?: string;
}

/** Dieu kien loc mot su kien truoc khi trigger duoc xet chay. */
export interface FleetV10TriggerCondition {
  /** Glob duong dan (chi `file-changed`), vd `notes/**.md`. */
  pathGlob?: string;
  /** Chi nhan su kien tu cac nguon nay (rong = moi nguon). */
  sources?: string[];
  /** Payload phai khop tat ca cap nay (gia tri chuoi ho tro glob `*`). */
  payloadMatch?: Record<string, string | number | boolean>;
  /** Chi nhan su kien cua user nay (rong = moi user). */
  userId?: string;
  /** Hang doi phai co it nhat N muc cho (chi `queue-depth`). */
  minQueueDepth?: number;
}

/** Dinh nghia mot trigger: su kien nao -> chay agent nao. */
export interface FleetV10Trigger {
  /** Id on dinh: `ftrig-<uuid>`. */
  id: string;
  /** Ten hien thi (duy nhat trong fleet root). */
  name: string;
  /** Agent (bot) se chay khi trigger kich hoat. */
  agentId: string;
  /** User so huu trigger (dung de phan quyen + quota). */
  ownerUserId: string;
  /** Loai su kien lang nghe. */
  eventKind: FleetV10EventKind;
  /** Dieu kien loc (tuy chon). */
  condition: FleetV10TriggerCondition;
  /** Gom su kien lien tiep trong N ms thanh 1 lan chay (0 = tat). */
  debounceMs: number;
  /** Toi da 1 lan chay moi N ms (0 = tat). */
  throttleMs: number;
  /** Nghi toi thieu sau moi lan chay truoc khi duoc chay lai (0 = tat). */
  cooldownMs: number;
  /** Gioi han so lan chay moi gio (0 = khong gioi han). */
  maxRunsPerHour: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms lan chay gan nhat (null = chua chay). */
  lastRunAt: number | null;
  /** Epoch ms su kien phu hop gan nhat (ke ca khi bi debounce). */
  lastMatchedAt: number | null;
  /** Tong so lan trigger da chay. */
  runCount: number;
}

/** Dau vao tao trigger (id + thoi gian do ham tao). */
export interface CreateFleetV10TriggerInput {
  name: string;
  agentId: string;
  ownerUserId: string;
  eventKind: FleetV10EventKind;
  condition?: FleetV10TriggerCondition;
  debounceMs?: number;
  throttleMs?: number;
  cooldownMs?: number;
  maxRunsPerHour?: number;
  enabled?: boolean;
}

/** Ket qua mot lan trigger duoc danh gia / chay. */
export type FleetV10TriggerRunStatus =
  | 'fired'
  | 'debounced'
  | 'throttled'
  | 'cooldown'
  | 'rate-limited'
  | 'filtered'
  | 'duplicate'
  | 'failed';

export const FLEET_V10_TRIGGER_RUN_STATUSES: readonly FleetV10TriggerRunStatus[] = [
  'fired',
  'debounced',
  'throttled',
  'cooldown',
  'rate-limited',
  'filtered',
  'duplicate',
  'failed',
];

/** Mot ban ghi lich su: trigger nao, su kien nao, ket qua gi. */
export interface FleetV10TriggerRun {
  id: string;
  triggerId: string;
  eventId: string;
  status: FleetV10TriggerRunStatus;
  /** Ly do de doc (vd `debounce 5000ms, con 3200ms`). */
  reason: string;
  at: number;
  /** Thoi gian chay that (chi khi fired). */
  durationMs?: number;
  /** Loi (chi khi failed). */
  error?: string;
}

/** Quyet dinh danh gia cho mot (trigger, event). */
export interface FleetV10TriggerDecision {
  triggerId: string;
  eventId: string;
  /** true = chay agent ngay; false = ghi run voi status tuong ung. */
  fire: boolean;
  status: FleetV10TriggerRunStatus;
  reason: string;
}

/** Tom tat trang thai trigger cho UI. */
export interface FleetV10TriggerSummary {
  total: number;
  enabled: number;
  disabled: number;
  byKind: Record<FleetV10EventKind, number>;
  firedLastHour: number;
  debouncedLastHour: number;
  throttledLastHour: number;
  filteredLastHour: number;
}

// --- Helper -----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Glob don gian: `*` khop trong 1 doan duong dan, `**` khop nhieu doan,
 * `?` khop 1 ky tu. Dung cho ca duong dan file lan gia tri payload.
 */
export function fleetV10GlobMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  // Bien glob thanh regex, bao ve ky tu dac biet truoc.
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` khop 0 hoac nhieu thu muc; `**` cuoi khop tat ca.
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re).test(value);
}

/** Kiem tra mot gia tri payload co khop dieu kien (chuoi ho tro glob). */
export function fleetV10PayloadValueMatches(
  expected: string | number | boolean,
  actual: string | number | boolean | undefined,
): boolean {
  if (actual === undefined) return false;
  if (typeof expected === 'string' && typeof actual === 'string') {
    return expected.includes('*') || expected.includes('?')
      ? fleetV10GlobMatch(expected, actual)
      : expected === actual;
  }
  return expected === actual;
}

// --- Validate ----------------------------------------------------------------

/** Validate dieu kien loc (nem loi khi truong nao hong). */
export function validateFleetV10TriggerCondition(raw: unknown): FleetV10TriggerCondition {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error('trigger condition must be an object.');
  const out: FleetV10TriggerCondition = {};
  if (raw.pathGlob !== undefined) {
    if (!isNonEmptyString(raw.pathGlob)) throw new Error('condition.pathGlob must be a non-empty string.');
    out.pathGlob = (raw.pathGlob as string).trim();
  }
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources) || raw.sources.some((s) => !isNonEmptyString(s))) {
      throw new Error('condition.sources must be an array of non-empty strings.');
    }
    out.sources = (raw.sources as string[]).map((s) => s.trim());
  }
  if (raw.payloadMatch !== undefined) {
    if (!isRecord(raw.payloadMatch)) throw new Error('condition.payloadMatch must be an object.');
    const match: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.payloadMatch)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new Error(`condition.payloadMatch.${k} must be a string, number or boolean.`);
      }
      match[k] = v;
    }
    out.payloadMatch = match;
  }
  if (raw.userId !== undefined) {
    if (!isNonEmptyString(raw.userId)) throw new Error('condition.userId must be a non-empty string.');
    out.userId = (raw.userId as string).trim();
  }
  if (raw.minQueueDepth !== undefined) {
    if (!isNonNegativeInt(raw.minQueueDepth) || (raw.minQueueDepth as number) < 1) {
      throw new Error('condition.minQueueDepth must be an integer >= 1.');
    }
    out.minQueueDepth = raw.minQueueDepth as number;
  }
  return out;
}

/** Validate mot trigger day du (nem loi khi truong nao hong). */
export function validateFleetV10Trigger(raw: unknown): FleetV10Trigger {
  if (!isRecord(raw)) throw new Error('fleet v10 trigger must be an object.');
  const {
    id, name, agentId, ownerUserId, eventKind, condition,
    debounceMs, throttleMs, cooldownMs, maxRunsPerHour,
    enabled, createdAt, updatedAt, lastRunAt, lastMatchedAt, runCount,
  } = raw;
  if (!isNonEmptyString(id)) throw new Error('trigger needs a non-empty id.');
  if (!isNonEmptyString(name)) throw new Error('trigger needs a non-empty name.');
  if (!isNonEmptyString(agentId)) throw new Error('trigger needs a non-empty agentId.');
  if (!isNonEmptyString(ownerUserId)) throw new Error('trigger needs a non-empty ownerUserId.');
  if (!FLEET_V10_EVENT_KINDS.includes(eventKind as FleetV10EventKind)) {
    throw new Error(`trigger eventKind must be one of: ${FLEET_V10_EVENT_KINDS.join(', ')}.`);
  }
  const validCondition = validateFleetV10TriggerCondition(condition ?? {});
  for (const [field, value] of [
    ['debounceMs', debounceMs],
    ['throttleMs', throttleMs],
    ['cooldownMs', cooldownMs],
  ] as const) {
    if (!isNonNegativeNumber(value)) throw new Error(`trigger ${field} must be a number >= 0.`);
  }
  if (!isNonNegativeInt(maxRunsPerHour)) throw new Error('trigger maxRunsPerHour must be a non-negative integer.');
  if (typeof enabled !== 'boolean') throw new Error('trigger enabled must be a boolean.');
  if (!isNonNegativeInt(createdAt)) throw new Error('trigger createdAt must be a non-negative integer.');
  if (!isNonNegativeInt(updatedAt)) throw new Error('trigger updatedAt must be a non-negative integer.');
  if (lastRunAt !== null && !isNonNegativeInt(lastRunAt)) throw new Error('trigger lastRunAt must be null or a non-negative integer.');
  if (lastMatchedAt !== null && !isNonNegativeInt(lastMatchedAt)) throw new Error('trigger lastMatchedAt must be null or a non-negative integer.');
  if (!isNonNegativeInt(runCount)) throw new Error('trigger runCount must be a non-negative integer.');
  return {
    id: (id as string).trim(),
    name: (name as string).trim(),
    agentId: (agentId as string).trim(),
    ownerUserId: (ownerUserId as string).trim(),
    eventKind: eventKind as FleetV10EventKind,
    condition: validCondition,
    debounceMs: debounceMs as number,
    throttleMs: throttleMs as number,
    cooldownMs: cooldownMs as number,
    maxRunsPerHour: maxRunsPerHour as number,
    enabled,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
    lastRunAt: lastRunAt as number | null,
    lastMatchedAt: lastMatchedAt as number | null,
    runCount: runCount as number,
  };
}

/** Validate mot su kien den (nem loi khi truong nao hong). */
export function validateFleetV10Event(raw: unknown): FleetV10Event {
  if (!isRecord(raw)) throw new Error('fleet v10 event must be an object.');
  const { id, kind, at, source, filePath, userId, payload, keyId } = raw;
  if (!isNonEmptyString(id)) throw new Error('event needs a non-empty id.');
  if (!FLEET_V10_EVENT_KINDS.includes(kind as FleetV10EventKind)) {
    throw new Error(`event kind must be one of: ${FLEET_V10_EVENT_KINDS.join(', ')}.`);
  }
  if (!isNonNegativeInt(at)) throw new Error('event at must be a non-negative integer.');
  if (!isNonEmptyString(source)) throw new Error('event needs a non-empty source.');
  if (filePath !== undefined && !isNonEmptyString(filePath)) throw new Error('event filePath must be a non-empty string.');
  if (userId !== undefined && !isNonEmptyString(userId)) throw new Error('event userId must be a non-empty string.');
  if (keyId !== undefined && !isNonEmptyString(keyId)) throw new Error('event keyId must be a non-empty string.');
  let validPayload: Record<string, string | number | boolean> | undefined;
  if (payload !== undefined) {
    if (!isRecord(payload)) throw new Error('event payload must be an object.');
    validPayload = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new Error(`event payload.${k} must be a string, number or boolean.`);
      }
      validPayload[k] = v;
    }
  }
  return {
    id: (id as string).trim(),
    kind: kind as FleetV10EventKind,
    at: at as number,
    source: (source as string).trim(),
    ...(filePath !== undefined ? { filePath: (filePath as string).trim() } : {}),
    ...(userId !== undefined ? { userId: (userId as string).trim() } : {}),
    ...(validPayload ? { payload: validPayload } : {}),
    ...(keyId !== undefined ? { keyId: (keyId as string).trim() } : {}),
  };
}

// --- Tao + danh gia -----------------------------------------------------------

/** Tao mot trigger moi (tinh san thoi gian tu `now`). */
export function createFleetV10Trigger(
  input: CreateFleetV10TriggerInput,
  now: number = Date.now(),
): FleetV10Trigger {
  if (!isNonEmptyString(input.name)) throw new Error('createFleetV10Trigger needs a non-empty name.');
  if (!isNonEmptyString(input.agentId)) throw new Error('createFleetV10Trigger needs a non-empty agentId.');
  if (!isNonEmptyString(input.ownerUserId)) throw new Error('createFleetV10Trigger needs a non-empty ownerUserId.');
  if (!FLEET_V10_EVENT_KINDS.includes(input.eventKind)) {
    throw new Error(`eventKind must be one of: ${FLEET_V10_EVENT_KINDS.join(', ')}.`);
  }
  const condition = validateFleetV10TriggerCondition(input.condition ?? {});
  const debounceMs = input.debounceMs ?? FLEET_V10_DEFAULT_DEBOUNCE_MS;
  const throttleMs = input.throttleMs ?? FLEET_V10_DEFAULT_THROTTLE_MS;
  const cooldownMs = input.cooldownMs ?? FLEET_V10_DEFAULT_COOLDOWN_MS;
  const maxRunsPerHour = input.maxRunsPerHour ?? FLEET_V10_DEFAULT_MAX_RUNS_PER_HOUR;
  for (const [field, value] of [['debounceMs', debounceMs], ['throttleMs', throttleMs], ['cooldownMs', cooldownMs]] as const) {
    if (!isNonNegativeNumber(value)) throw new Error(`trigger ${field} must be a number >= 0.`);
  }
  if (!isNonNegativeInt(maxRunsPerHour)) throw new Error('trigger maxRunsPerHour must be a non-negative integer.');
  return {
    id: `ftrig-${crypto.randomUUID()}`,
    name: input.name.trim(),
    agentId: input.agentId.trim(),
    ownerUserId: input.ownerUserId.trim(),
    eventKind: input.eventKind,
    condition,
    debounceMs,
    throttleMs,
    cooldownMs,
    maxRunsPerHour,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastMatchedAt: null,
    runCount: 0,
  };
}

/**
 * Mot su kien co vuot qua dieu kien loc cua trigger khong.
 * Tra ve ly do khi khong vuot qua (de ghi log), null khi vuot qua.
 */
export function fleetV10EventFilterReason(
  trigger: FleetV10Trigger,
  event: FleetV10Event,
): string | null {
  if (trigger.eventKind !== event.kind) return `event kind ${event.kind} != ${trigger.eventKind}`;
  const c = trigger.condition;
  if (c.userId !== undefined && event.userId !== undefined && event.userId !== c.userId) {
    return `event user ${event.userId} != ${c.userId}`;
  }
  if (c.userId !== undefined && event.userId === undefined) {
    return `event has no userId, trigger requires ${c.userId}`;
  }
  if (c.sources !== undefined && c.sources.length > 0 && !c.sources.includes(event.source)) {
    return `source ${event.source} not in [${c.sources.join(', ')}]`;
  }
  if (trigger.eventKind === 'file-changed' && c.pathGlob !== undefined) {
    if (event.filePath === undefined) return 'file-changed event has no filePath';
    if (!fleetV10GlobMatch(c.pathGlob, event.filePath)) {
      return `file ${event.filePath} does not match ${c.pathGlob}`;
    }
  }
  if (c.payloadMatch !== undefined) {
    for (const [k, expected] of Object.entries(c.payloadMatch)) {
      if (!fleetV10PayloadValueMatches(expected, event.payload?.[k])) {
        return `payload.${k} does not match ${String(expected)}`;
      }
    }
  }
  if (trigger.eventKind === 'queue-depth' && c.minQueueDepth !== undefined) {
    const depth = event.payload?.depth;
    if (typeof depth !== 'number' || depth < c.minQueueDepth) {
      return `queue depth ${String(depth)} < ${c.minQueueDepth}`;
    }
  }
  return null;
}

/** So lan trigger da chay trong 1 gio truoc `now` (tu lich su chay). */
export function fleetV10RunsInLastHour(
  runs: readonly FleetV10TriggerRun[],
  triggerId: string,
  now: number,
): number {
  const since = now - 3_600_000;
  let n = 0;
  for (const r of runs) {
    if (r.triggerId === triggerId && r.status === 'fired' && r.at >= since && r.at <= now) n++;
  }
  return n;
}

/**
 * Quyet dinh co chay trigger cho mot su kien khong — ham thuan.
 * Thu tu kiem tra: trung su kien -> tat -> loc -> cooldown -> throttle
 * -> debounce -> gioi han/gio. Tra ve quyet dinh + ly do de ghi run.
 *
 * `seenEventIds` la tap id su kien da xu ly (idempotency): su kien
 * trung id duoc bo qua thay vi chay lai.
 */
export function decideFleetV10Trigger(
  trigger: FleetV10Trigger,
  event: FleetV10Event,
  runs: readonly FleetV10TriggerRun[],
  now: number,
  seenEventIds: ReadonlySet<string> = new Set(),
): FleetV10TriggerDecision {
  const base = { triggerId: trigger.id, eventId: event.id };
  if (seenEventIds.has(event.id)) {
    return { ...base, fire: false, status: 'duplicate', reason: `event ${event.id} already processed` };
  }
  if (!trigger.enabled) {
    return { ...base, fire: false, status: 'filtered', reason: 'trigger is disabled' };
  }
  const filterReason = fleetV10EventFilterReason(trigger, event);
  if (filterReason !== null) {
    return { ...base, fire: false, status: 'filtered', reason: filterReason };
  }
  if (trigger.cooldownMs > 0 && trigger.lastRunAt !== null) {
    const remaining = trigger.lastRunAt + trigger.cooldownMs - now;
    if (remaining > 0) {
      return { ...base, fire: false, status: 'cooldown', reason: `cooldown ${trigger.cooldownMs}ms, ${remaining}ms left` };
    }
  }
  if (trigger.throttleMs > 0 && trigger.lastRunAt !== null) {
    const remaining = trigger.lastRunAt + trigger.throttleMs - now;
    if (remaining > 0) {
      return { ...base, fire: false, status: 'throttled', reason: `throttle ${trigger.throttleMs}ms, ${remaining}ms left` };
    }
  }
  if (trigger.debounceMs > 0 && trigger.lastMatchedAt !== null) {
    const remaining = trigger.lastMatchedAt + trigger.debounceMs - now;
    if (remaining > 0) {
      return { ...base, fire: false, status: 'debounced', reason: `debounce ${trigger.debounceMs}ms, ${remaining}ms left` };
    }
  }
  if (trigger.maxRunsPerHour > 0) {
    const count = fleetV10RunsInLastHour(runs, trigger.id, now);
    if (count >= trigger.maxRunsPerHour) {
      return { ...base, fire: false, status: 'rate-limited', reason: `${count}/${trigger.maxRunsPerHour} runs in the last hour` };
    }
  }
  return { ...base, fire: true, status: 'fired', reason: 'event matched, no limit hit' };
}

/**
 * Danh gia mot lo su kien cho tat ca trigger — ham thuan.
 * Tra ve quyet dinh theo thu tu (trigger, event); trigger bi tat van
 * duoc danh gia (de ghi `filtered`) nhung khong bao gio fire.
 * Su kien trung id trong cung lo chi duoc xu ly 1 lan.
 */
export function evaluateFleetV10Triggers(
  events: readonly FleetV10Event[],
  triggers: readonly FleetV10Trigger[],
  runs: readonly FleetV10TriggerRun[],
  now: number,
): FleetV10TriggerDecision[] {
  const seen = new Set<string>();
  const decisions: FleetV10TriggerDecision[] = [];
  for (const rawEvent of events) {
    const event = validateFleetV10Event(rawEvent);
    if (seen.has(event.id)) {
      // Trung id trong lo: ghi duplicate cho moi trigger da nghe loai nay.
      for (const t of triggers) {
        if (t.eventKind === event.kind) {
          decisions.push({ triggerId: t.id, eventId: event.id, fire: false, status: 'duplicate', reason: `event ${event.id} already processed in this batch` });
        }
      }
      continue;
    }
    seen.add(event.id);
    for (const trigger of triggers) {
      if (trigger.eventKind !== event.kind) continue;
      decisions.push(decideFleetV10Trigger(trigger, event, runs, now, new Set()));
    }
  }
  return decisions;
}

/** Ghi mot ban ghi chay vao lich su (cat bot khi vuot gioi han). */
export function recordFleetV10TriggerRun(
  runs: readonly FleetV10TriggerRun[],
  decision: FleetV10TriggerDecision,
  now: number,
  extra?: { durationMs?: number; error?: string },
): FleetV10TriggerRun[] {
  const run: FleetV10TriggerRun = {
    id: `ftrun-${crypto.randomUUID()}`,
    triggerId: decision.triggerId,
    eventId: decision.eventId,
    status: decision.status,
    reason: decision.reason,
    at: now,
    ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra?.error !== undefined ? { error: extra.error } : {}),
  };
  const next = [...runs, run];
  return next.length > FLEET_V10_MAX_TRIGGER_RUNS
    ? next.slice(next.length - FLEET_V10_MAX_TRIGGER_RUNS)
    : next;
}

/** Cap nhat trigger sau khi danh gia (lastMatchedAt / lastRunAt / runCount). */
export function applyFleetV10DecisionToTrigger(
  trigger: FleetV10Trigger,
  decision: FleetV10TriggerDecision,
  now: number,
): FleetV10Trigger {
  if (decision.status === 'filtered' && decision.reason === 'trigger is disabled') return trigger;
  if (decision.status === 'duplicate') return trigger;
  if (decision.fire) {
    return { ...trigger, lastRunAt: now, lastMatchedAt: now, runCount: trigger.runCount + 1, updatedAt: now };
  }
  // Su kien phu hop nhung bi chan (debounce/throttle/...) van cap nhat
  // lastMatchedAt de debounce tinh tu su kien moi nhat.
  if (decision.status === 'debounced' || decision.status === 'throttled' || decision.status === 'cooldown' || decision.status === 'rate-limited') {
    return { ...trigger, lastMatchedAt: now, updatedAt: now };
  }
  return trigger;
}

/** Tom tat trang thai trigger + lich su chay trong 1 gio qua. */
export function summarizeFleetV10Triggers(
  triggers: readonly FleetV10Trigger[],
  runs: readonly FleetV10TriggerRun[],
  now: number,
): FleetV10TriggerSummary {
  const byKind: Record<FleetV10EventKind, number> = {
    'file-changed': 0,
    'webhook-local': 0,
    'calendar-due': 0,
    'message-inbound': 0,
    'agent-done': 0,
    'queue-depth': 0,
  };
  for (const t of triggers) byKind[t.eventKind]++;
  const since = now - 3_600_000;
  let fired = 0;
  let debounced = 0;
  let throttled = 0;
  let filtered = 0;
  for (const r of runs) {
    if (r.at < since) continue;
    if (r.status === 'fired') fired++;
    else if (r.status === 'debounced') debounced++;
    else if (r.status === 'throttled') throttled++;
    else if (r.status === 'filtered') filtered++;
  }
  return {
    total: triggers.length,
    enabled: triggers.filter((t) => t.enabled).length,
    disabled: triggers.filter((t) => !t.enabled).length,
    byKind,
    firedLastHour: fired,
    debouncedLastHour: debounced,
    throttledLastHour: throttled,
    filteredLastHour: filtered,
  };
}

/** Tim trigger theo id (undefined khi khong co). */
export function findFleetV10Trigger(
  triggers: readonly FleetV10Trigger[],
  id: string,
): FleetV10Trigger | undefined {
  return triggers.find((t) => t.id === id);
}

/** Bat/tat trigger (tra ve danh sach moi, khong sua danh sach cu). */
export function setFleetV10TriggerEnabled(
  triggers: readonly FleetV10Trigger[],
  id: string,
  enabled: boolean,
  now: number = Date.now(),
): FleetV10Trigger[] {
  const found = triggers.some((t) => t.id === id);
  if (!found) throw new Error(`trigger not found: ${id}`);
  return triggers.map((t) => (t.id === id ? { ...t, enabled, updatedAt: now } : t));
}

/** Xoa trigger (tra ve danh sach moi). */
export function removeFleetV10Trigger(
  triggers: readonly FleetV10Trigger[],
  id: string,
): FleetV10Trigger[] {
  const found = triggers.some((t) => t.id === id);
  if (!found) throw new Error(`trigger not found: ${id}`);
  return triggers.filter((t) => t.id !== id);
}

// --- Persistence ---------------------------------------------------------------

export function getFleetV10TriggersPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_TRIGGERS_FILE);
}

export function getFleetV10TriggerRunsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V10_TRIGGER_RUNS_FILE);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows khong co chmod POSIX — bo qua.
  }
}

function loadJsonArray<T>(filePath: string, validate: (raw: unknown) => T): T[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const item of parsed) {
    try {
      out.push(validate(item));
    } catch {
      // Ban ghi hong thi bo qua thay vi lam hong ca file.
    }
  }
  return out;
}

/** Doc trigger tu fleet root (file hong/missing = danh sach rong). */
export function loadFleetV10Triggers(fleetRoot: string): FleetV10Trigger[] {
  return loadJsonArray(getFleetV10TriggersPath(fleetRoot), validateFleetV10Trigger);
}

/** Ghi trigger xuong fleet root (atomic, mode 0600). */
export function saveFleetV10Triggers(fleetRoot: string, triggers: readonly FleetV10Trigger[]): void {
  if (triggers.length > FLEET_V10_MAX_TRIGGERS) {
    throw new Error(`too many triggers: ${triggers.length} > ${FLEET_V10_MAX_TRIGGERS}`);
  }
  atomicWriteJson(getFleetV10TriggersPath(fleetRoot), triggers.map((t) => validateFleetV10Trigger(t)));
}

/** Doc lich su chay trigger (file hong/missing = rong). */
export function loadFleetV10TriggerRuns(fleetRoot: string): FleetV10TriggerRun[] {
  return loadJsonArray(getFleetV10TriggerRunsPath(fleetRoot), (raw) => {
    if (!isRecord(raw)) throw new Error('trigger run must be an object.');
    const { id, triggerId, eventId, status, reason, at, durationMs, error } = raw;
    if (!isNonEmptyString(id) || !isNonEmptyString(triggerId) || !isNonEmptyString(eventId)) {
      throw new Error('trigger run needs non-empty id, triggerId and eventId.');
    }
    if (!FLEET_V10_TRIGGER_RUN_STATUSES.includes(status as FleetV10TriggerRunStatus)) {
      throw new Error(`trigger run status must be one of: ${FLEET_V10_TRIGGER_RUN_STATUSES.join(', ')}.`);
    }
    if (!isNonEmptyString(reason)) throw new Error('trigger run needs a non-empty reason.');
    if (!isNonNegativeInt(at)) throw new Error('trigger run at must be a non-negative integer.');
    if (durationMs !== undefined && !isNonNegativeNumber(durationMs)) throw new Error('trigger run durationMs must be a number >= 0.');
    if (error !== undefined && !isNonEmptyString(error)) throw new Error('trigger run error must be a non-empty string.');
    return {
      id: id as string,
      triggerId: triggerId as string,
      eventId: eventId as string,
      status: status as FleetV10TriggerRunStatus,
      reason: reason as string,
      at: at as number,
      ...(durationMs !== undefined ? { durationMs: durationMs as number } : {}),
      ...(error !== undefined ? { error: error as string } : {}),
    };
  });
}

/** Ghi lich su chay trigger (atomic, mode 0600, cat bot khi vuot gioi han). */
export function saveFleetV10TriggerRuns(fleetRoot: string, runs: readonly FleetV10TriggerRun[]): void {
  const trimmed = runs.length > FLEET_V10_MAX_TRIGGER_RUNS
    ? runs.slice(runs.length - FLEET_V10_MAX_TRIGGER_RUNS)
    : runs;
  atomicWriteJson(getFleetV10TriggerRunsPath(fleetRoot), trimmed);
}
