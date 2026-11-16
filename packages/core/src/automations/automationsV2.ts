/**
 * Automations v2 (v1.12, Doi T6) — trigger -> action chain co dieu kien.
 *
 * Tang tren automations v0.4 (`engine.ts`/`scheduler.ts`): v0.4 la
 * `trigger + condition don + 1 action`. V2 them:
 *
 * 1. TRIGGER MOI:
 *    - `time`: cron (chuoi 5 truong, tai dung parser cua engine) /
 *      interval / once.
 *    - `file`: file thay doi trong workspace — khop glob `pathPattern`
 *      (tai dung `globMatch` cua engine) + loc theo loai su kien
 *      (created/modified/deleted), ke ca thay doi trong thu muc con.
 *    - `webhook-local`: webhook chi chay local (127.0.0.1) — khop theo
 *      `path` (vd `/hooks/deploy`) va so sanh HMAC-SHA256 bang
 *      `computeWebhookSignature` cua webhook.ts khi co secret; secret
 *      KHONG bao gio luu trong automation, chi luu `keyId` nhu v0.4.
 * 2. DIEU KIEN CAY: so sanh truong (`eq/ne/gt/gte/lt/lte/contains/
 *    startsWith/matches`) ghep bang `and`/`or`/`not` — danh gia tren
 *    payload cua event (duong dan file, ten bot, text, ...). V1 chi co
 *    `textContains`/`pathPattern` phang.
 * 3. ACTION CHAIN: nhieu step noi tiep — `run-agent`, `run-tool`,
 *    `notify`, `create-task`, `set-variable` (dat bien cho step sau
 *    qua template `{{tenBien}}`), `wait` (cho N ms, toi da 60s). Moi
 *    step co dieu kien `when` rieng va chinh sach loi `onError`:
 *    `stop` (dung ca chain) hoac `continue` (bo qua step loi, chay
 *    tiep). Ket qua moi step ghi vao run log.
 * 4. RUN LOG BEN: moi lan chay ghi 1 muc JSONL (`automations-v112-
 *    runs.jsonl`, toi da 500 muc) voi trang thai tung step, thoi gian
 *    chay, ly do skip — de UI/debug thay duoc automation da lam gi thay
 *    vi chi biet "no chay".
 *
 * An toan giong v0.4: automation khong tu chay khi user dang chat
 * (host truyen `isChatActive` — xem `AutomationV2Runner`); run bi lo
 * qua grace thi skip, khong bu burst; cooldown moi automation chan
 * spam khi file thay doi lien tuc. Khong goi mang, khong spawn
 * process: thuc thi di qua `AutomationV2Handlers` do host cung cap.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { globMatch, isValidCronExpression, nextCronOccurrence, parseCronExpression } from './engine';
import { computeWebhookSignature, verifyWebhookSignature } from './webhook';

/** File luu automation v2 trong state dir. */
export const AUTOMATIONS_V2_FILE = 'automations-v112.json';
/** File log chay v2 (JSONL). */
export const AUTOMATIONS_V2_RUNS_FILE = 'automations-v112-runs.jsonl';
/** So muc run log toi da giu lai. */
export const AUTOMATIONS_V2_MAX_RUNS = 500;
/** So automation toi da trong mot file. */
export const AUTOMATIONS_V2_MAX_AUTOMATIONS = 200;
/** Thoi gian cho toi da cua mot step `wait` (ms). */
export const AUTOMATION_V2_MAX_WAIT_MS = 60_000;
/** Cooldown mac dinh giua 2 lan chay event-trigger (ms). */
export const AUTOMATION_V2_DEFAULT_COOLDOWN_MS = 60_000;
/** So step toi da trong mot chain. */
export const AUTOMATION_V2_MAX_STEPS = 20;

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Loai su kien file. */
export type AutomationV2FileEventKind = 'created' | 'modified' | 'deleted';

export const AUTOMATION_V2_FILE_EVENT_KINDS: readonly AutomationV2FileEventKind[] = [
  'created',
  'modified',
  'deleted',
];

/** Trigger cua automation v2. */
export type AutomationV2Trigger =
  | { kind: 'time-cron'; expression: string }
  | { kind: 'time-interval'; intervalMs: number }
  | { kind: 'time-once'; runAtMs: number }
  | {
      kind: 'file';
      /** Glob vd `notes/**.md` (khop duong dan tuong doi workspace). */
      pathPattern: string;
      /** Loc loai su kien; rong = tat ca. */
      events: AutomationV2FileEventKind[];
    }
  | {
      kind: 'webhook-local';
      /** Duong dan webhook, vd `/hooks/deploy` (luon bat dau `/`). */
      path: string;
      /** Id key HMAC trong Vault (namespace automation-webhook-keys). */
      keyId: string;
    }
  | { kind: 'manual' };

export const AUTOMATION_V2_TRIGGER_KINDS: readonly string[] = [
  'time-cron',
  'time-interval',
  'time-once',
  'file',
  'webhook-local',
  'manual',
];

// ---------------------------------------------------------------------------
// Conditions (cay dieu kien)
// ---------------------------------------------------------------------------

export type AutomationV2CompareOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'matches';

export const AUTOMATION_V2_COMPARE_OPS: readonly AutomationV2CompareOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'matches',
];

/** Dieu kien v2: so sanh mot truong, hoac ghep and/or/not. */
export type AutomationV2Condition =
  | { op: 'always' }
  | { op: AutomationV2CompareOp; field: string; value: string | number | boolean }
  | { op: 'and'; conditions: AutomationV2Condition[] }
  | { op: 'or'; conditions: AutomationV2Condition[] }
  | { op: 'not'; condition: AutomationV2Condition };

// ---------------------------------------------------------------------------
// Action chain
// ---------------------------------------------------------------------------

/** Chinh sach khi mot step loi. */
export type AutomationV2StepOnError = 'stop' | 'continue';

export type AutomationV2ActionStep =
  | {
      id: string;
      kind: 'run-agent';
      botId: string;
      /** Prompt ho tro template {{bien}}. */
      prompt: string;
      when?: AutomationV2Condition;
      onError?: AutomationV2StepOnError;
    }
  | {
      id: string;
      kind: 'run-tool';
      tool: string;
      args?: Record<string, unknown>;
      when?: AutomationV2Condition;
      onError?: AutomationV2StepOnError;
    }
  | {
      id: string;
      kind: 'notify';
      message: string;
      when?: AutomationV2Condition;
      onError?: AutomationV2StepOnError;
    }
  | {
      id: string;
      kind: 'create-task';
      botId: string;
      title: string;
      when?: AutomationV2Condition;
      onError?: AutomationV2StepOnError;
    }
  | {
      id: string;
      kind: 'set-variable';
      /** Ten bien (chu cai/so/gach duoi, khong khoang trang). */
      name: string;
      /** Gia tri ho tro template {{bien}} tu cac bien truoc. */
      value: string;
      when?: AutomationV2Condition;
      onError?: AutomationV2StepOnError;
    }
  | {
      id: string;
      kind: 'wait';
      waitMs: number;
      when?: AutomationV2Condition;
      onError?: AutomationV2StepOnError;
    };

export const AUTOMATION_V2_STEP_KINDS: readonly string[] = [
  'run-agent',
  'run-tool',
  'notify',
  'create-task',
  'set-variable',
  'wait',
];

// ---------------------------------------------------------------------------
// Automation + run log
// ---------------------------------------------------------------------------

export interface AutomationV2 {
  id: string;
  botId: string;
  name: string;
  description: string;
  trigger: AutomationV2Trigger;
  /** Dieu kien chung cho ca automation (danh gia truoc khi chay chain). */
  condition?: AutomationV2Condition;
  steps: AutomationV2ActionStep[];
  enabled: boolean;
  /** Cooldown giua 2 lan chay (ms) — chan spam event. */
  cooldownMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  /** Lan chay ke tiep cho trigger time (null = khong co / manual / file / webhook). */
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  runCount: number;
  failureCount: number;
}

export interface CreateAutomationV2Input {
  botId: string;
  name: string;
  description?: string;
  trigger: AutomationV2Trigger;
  condition?: AutomationV2Condition;
  steps: AutomationV2ActionStep[];
  enabled?: boolean;
  cooldownMs?: number;
}

/** Trang thai mot step trong log chay. */
export type AutomationV2StepStatus = 'succeeded' | 'failed' | 'skipped';

export interface AutomationV2StepResult {
  stepId: string;
  kind: string;
  status: AutomationV2StepStatus;
  /** Output rut gon (toi da 500 ky tu) — khong luu du lieu lon/secret. */
  output: string | null;
  error: string | null;
  durationMs: number;
}

export type AutomationV2RunStatus = 'succeeded' | 'failed' | 'skipped' | 'partial';

export interface AutomationV2RunLogEntry {
  id: string;
  automationId: string;
  automationName: string;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  status: AutomationV2RunStatus;
  triggerSummary: string;
  /** Ly do skip (chi khi status = skipped). */
  skipReason: string | null;
  steps: AutomationV2StepResult[];
}

/** Event dua vao automation v2 (payload danh gia dieu kien). */
export type AutomationV2Event =
  | { type: 'time'; atMs: number }
  | { type: 'file'; path: string; eventKind: AutomationV2FileEventKind; atMs: number }
  | { type: 'webhook-local'; path: string; body: Record<string, unknown>; atMs: number }
  | { type: 'manual'; atMs: number; note?: string };

/** Handler thuc thi do host cung cap (agent/tool/notify/task that). */
export interface AutomationV2Handlers {
  runAgent: (botId: string, prompt: string) => Promise<string> | string;
  runTool: (tool: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
  notify: (message: string) => Promise<void> | void;
  createTask: (botId: string, title: string) => Promise<string> | string;
  /** Lay secret HMAC theo keyId (de verify webhook-local); null = khong co key. */
  getWebhookSecret?: (keyId: string) => Promise<string | null> | string | null;
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateAutomationV2Trigger(trigger: unknown): AutomationV2Trigger {
  if (!trigger || typeof trigger !== 'object') throw new Error('trigger must be an object.');
  const t = trigger as AutomationV2Trigger;
  switch (t.kind) {
    case 'time-cron': {
      if (!isNonEmptyString(t.expression)) throw new Error('time-cron trigger needs expression.');
      if (!isValidCronExpression(t.expression)) {
        throw new Error(`invalid cron expression: ${t.expression}`);
      }
      parseCronExpression(t.expression);
      return { kind: 'time-cron', expression: t.expression.trim() };
    }
    case 'time-interval': {
      if (!Number.isFinite(t.intervalMs) || (t.intervalMs as number) <= 0) {
        throw new Error('time-interval trigger needs intervalMs > 0.');
      }
      return { kind: 'time-interval', intervalMs: t.intervalMs };
    }
    case 'time-once': {
      if (!Number.isFinite(t.runAtMs)) throw new Error('time-once trigger needs runAtMs.');
      return { kind: 'time-once', runAtMs: t.runAtMs };
    }
    case 'file': {
      if (!isNonEmptyString(t.pathPattern)) throw new Error('file trigger needs pathPattern.');
      if (!Array.isArray(t.events)) throw new Error('file trigger events must be an array.');
      for (const e of t.events) {
        if (!AUTOMATION_V2_FILE_EVENT_KINDS.includes(e as AutomationV2FileEventKind)) {
          throw new Error(`file trigger event must be one of: ${AUTOMATION_V2_FILE_EVENT_KINDS.join(', ')}.`);
        }
      }
      return { kind: 'file', pathPattern: t.pathPattern.trim(), events: [...t.events] };
    }
    case 'webhook-local': {
      if (!isNonEmptyString(t.path) || !t.path.startsWith('/')) {
        throw new Error('webhook-local trigger path must start with "/".');
      }
      if (!isNonEmptyString(t.keyId)) throw new Error('webhook-local trigger needs keyId.');
      return { kind: 'webhook-local', path: t.path.trim(), keyId: t.keyId.trim() };
    }
    case 'manual':
      return { kind: 'manual' };
    default:
      throw new Error(`unknown trigger kind: ${(t as { kind?: unknown }).kind}`);
  }
}

export function validateAutomationV2Condition(condition: unknown): AutomationV2Condition {
  if (!condition || typeof condition !== 'object') throw new Error('condition must be an object.');
  const c = condition as AutomationV2Condition;
  if (c.op === 'always') return { op: 'always' };
  if (c.op === 'and' || c.op === 'or') {
    if (!Array.isArray(c.conditions) || c.conditions.length === 0) {
      throw new Error(`'${c.op}' condition needs a non-empty conditions array.`);
    }
    return { op: c.op, conditions: c.conditions.map((sub) => validateAutomationV2Condition(sub)) };
  }
  if (c.op === 'not') {
    return { op: 'not', condition: validateAutomationV2Condition(c.condition) };
  }
  if (AUTOMATION_V2_COMPARE_OPS.includes(c.op as AutomationV2CompareOp)) {
    const cmp = c as { op: AutomationV2CompareOp; field: string; value: string | number | boolean };
    if (!isNonEmptyString(cmp.field)) throw new Error('compare condition needs a non-empty field.');
    if (typeof cmp.value !== 'string' && typeof cmp.value !== 'number' && typeof cmp.value !== 'boolean') {
      throw new Error('compare condition value must be string, number or boolean.');
    }
    if (cmp.op === 'matches') {
      try {
        new RegExp(String(cmp.value));
      } catch {
        throw new Error(`'matches' condition value is not a valid regex: ${cmp.value}`);
      }
    }
    return { op: cmp.op, field: cmp.field.trim(), value: cmp.value };
  }
  throw new Error(`unknown condition op: ${(c as { op?: unknown }).op}`);
}

function validateAutomationV2Step(step: unknown, index: number): AutomationV2ActionStep {
  if (!step || typeof step !== 'object') throw new Error(`step ${index} must be an object.`);
  const s = step as AutomationV2ActionStep;
  if (!isNonEmptyString(s.id)) throw new Error(`step ${index} needs a non-empty id.`);
  if (!AUTOMATION_V2_STEP_KINDS.includes(s.kind)) {
    throw new Error(`step ${index} kind must be one of: ${AUTOMATION_V2_STEP_KINDS.join(', ')}.`);
  }
  if (s.when !== undefined) validateAutomationV2Condition(s.when);
  if (s.onError !== undefined && s.onError !== 'stop' && s.onError !== 'continue') {
    throw new Error(`step ${index} onError must be 'stop' or 'continue'.`);
  }
  switch (s.kind) {
    case 'run-agent':
      if (!isNonEmptyString(s.botId)) throw new Error(`step ${index} run-agent needs botId.`);
      if (!isNonEmptyString(s.prompt)) throw new Error(`step ${index} run-agent needs prompt.`);
      break;
    case 'run-tool':
      if (!isNonEmptyString(s.tool)) throw new Error(`step ${index} run-tool needs tool.`);
      if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
        throw new Error(`step ${index} run-tool args must be an object.`);
      }
      break;
    case 'notify':
      if (!isNonEmptyString(s.message)) throw new Error(`step ${index} notify needs message.`);
      break;
    case 'create-task':
      if (!isNonEmptyString(s.botId)) throw new Error(`step ${index} create-task needs botId.`);
      if (!isNonEmptyString(s.title)) throw new Error(`step ${index} create-task needs title.`);
      break;
    case 'set-variable':
      if (!VARIABLE_NAME_RE.test(s.name)) {
        throw new Error(`step ${index} set-variable name must match ${VARIABLE_NAME_RE}.`);
      }
      if (typeof s.value !== 'string') throw new Error(`step ${index} set-variable value must be a string.`);
      break;
    case 'wait':
      if (!Number.isFinite(s.waitMs) || s.waitMs < 0 || s.waitMs > AUTOMATION_V2_MAX_WAIT_MS) {
        throw new Error(`step ${index} waitMs must be in 0..${AUTOMATION_V2_MAX_WAIT_MS}.`);
      }
      break;
  }
  return s;
}

export function validateAutomationV2(input: unknown): AutomationV2 {
  if (!input || typeof input !== 'object') throw new Error('automation must be an object.');
  const a = input as Partial<AutomationV2>;
  if (!isNonEmptyString(a.id)) throw new Error('automation.id must be a non-empty string.');
  if (!isNonEmptyString(a.botId)) throw new Error('automation.botId must be a non-empty string.');
  if (!isNonEmptyString(a.name)) throw new Error('automation.name must be a non-empty string.');
  if (a.description !== undefined && typeof a.description !== 'string') {
    throw new Error('automation.description must be a string.');
  }
  const trigger = validateAutomationV2Trigger(a.trigger);
  const condition = a.condition === undefined ? undefined : validateAutomationV2Condition(a.condition);
  if (!Array.isArray(a.steps) || a.steps.length === 0) {
    throw new Error('automation.steps must be a non-empty array.');
  }
  if (a.steps.length > AUTOMATION_V2_MAX_STEPS) {
    throw new Error(`automation has too many steps (${a.steps.length} > ${AUTOMATION_V2_MAX_STEPS}).`);
  }
  const steps = a.steps.map((s, i) => validateAutomationV2Step(s, i));
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) throw new Error('automation step ids must be unique.');
  if (typeof a.enabled !== 'boolean') throw new Error('automation.enabled must be a boolean.');
  if (!Number.isFinite(a.cooldownMs) || (a.cooldownMs as number) < 0) {
    throw new Error('automation.cooldownMs must be a non-negative number.');
  }
  if (!Number.isFinite(a.createdAtMs) || !Number.isFinite(a.updatedAtMs)) {
    throw new Error('automation.createdAtMs/updatedAtMs must be finite numbers.');
  }
  if (a.nextRunAtMs !== null && !Number.isFinite(a.nextRunAtMs)) {
    throw new Error('automation.nextRunAtMs must be null or a finite number.');
  }
  if (a.lastRunAtMs !== null && !Number.isFinite(a.lastRunAtMs)) {
    throw new Error('automation.lastRunAtMs must be null or a finite number.');
  }
  if (!Number.isInteger(a.runCount) || (a.runCount as number) < 0) {
    throw new Error('automation.runCount must be a non-negative integer.');
  }
  if (!Number.isInteger(a.failureCount) || (a.failureCount as number) < 0) {
    throw new Error('automation.failureCount must be a non-negative integer.');
  }
  return {
    ...(a as AutomationV2),
    description: a.description ?? '',
    trigger,
    condition,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Condition evaluation + templating (pure)
// ---------------------------------------------------------------------------

/** Lay gia tri mot truong tu event payload (ho tro `a.b` long nhau). */
export function getAutomationV2Field(
  payload: Record<string, unknown>,
  field: string,
): unknown {
  let current: unknown = payload;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareValues(op: AutomationV2CompareOp, actual: unknown, expected: string | number | boolean): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'startsWith':
      return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected);
    case 'matches':
      return typeof actual === 'string' && new RegExp(String(expected)).test(actual);
  }
}

export function evaluateAutomationV2Condition(
  condition: AutomationV2Condition | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (condition === undefined) return true;
  const c = validateAutomationV2Condition(condition);
  if (c.op === 'always') return true;
  if (c.op === 'and') return c.conditions.every((sub) => evaluateAutomationV2Condition(sub, payload));
  if (c.op === 'or') return c.conditions.some((sub) => evaluateAutomationV2Condition(sub, payload));
  if (c.op === 'not') return !evaluateAutomationV2Condition(c.condition, payload);
  return compareValues(c.op, getAutomationV2Field(payload, c.field), c.value);
}

/** Thay `{{tenBien}}` bang gia tri bien; bien chua co thi giu nguyen chuoi goc. */
export function renderAutomationV2Template(
  text: string,
  variables: Readonly<Record<string, string>>,
): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] as string : whole,
  );
}

/** Render template cho args cua run-tool (chi render gia tri string). */
export function renderAutomationV2Args(
  args: Record<string, unknown> | undefined,
  variables: Readonly<Record<string, string>>,
): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' ? renderAutomationV2Template(value, variables) : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trigger matching (pure)
// ---------------------------------------------------------------------------

/** Chuyen event thanh payload phang de danh gia dieu kien. */
export function automationV2EventPayload(event: AutomationV2Event): Record<string, unknown> {
  switch (event.type) {
    case 'time':
      return { type: 'time', atMs: event.atMs };
    case 'file':
      return { type: 'file', path: event.path, eventKind: event.eventKind, atMs: event.atMs };
    case 'webhook-local':
      return { type: 'webhook-local', path: event.path, atMs: event.atMs, ...event.body };
    case 'manual':
      return { type: 'manual', atMs: event.atMs, note: event.note ?? '' };
  }
}

/** Mo ta ngan gon mot event (ghi vao run log). */
export function describeAutomationV2Event(event: AutomationV2Event): string {
  switch (event.type) {
    case 'time':
      return `time @ ${new Date(event.atMs).toISOString()}`;
    case 'file':
      return `file ${event.eventKind}: ${event.path}`;
    case 'webhook-local':
      return `webhook-local ${event.path}`;
    case 'manual':
      return event.note ? `manual: ${event.note}` : 'manual';
  }
}

/** Event co khop trigger cua automation khong (chua xet dieu kien/enabled). */
export function automationV2TriggerMatches(
  automation: AutomationV2,
  event: AutomationV2Event,
): boolean {
  switch (automation.trigger.kind) {
    case 'manual':
      return event.type === 'manual';
    case 'time-cron':
    case 'time-interval':
    case 'time-once':
      return event.type === 'time';
    case 'file': {
      if (event.type !== 'file') return false;
      if (automation.trigger.events.length > 0 && !automation.trigger.events.includes(event.eventKind)) {
        return false;
      }
      return globMatch(automation.trigger.pathPattern, event.path);
    }
    case 'webhook-local':
      return event.type === 'webhook-local' && event.path === automation.trigger.path;
  }
}

/** Lan chay ke tiep cho trigger time (null = khong phai trigger time). */
export function nextRunForAutomationV2(
  automation: AutomationV2,
  fromMs: number,
): number | null {
  validateAutomationV2(automation);
  if (!Number.isFinite(fromMs)) throw new Error('nextRunForAutomationV2 needs a finite fromMs.');
  const trigger = automation.trigger;
  switch (trigger.kind) {
    case 'time-cron':
      return nextCronOccurrence(trigger.expression, new Date(fromMs)).getTime();
    case 'time-interval': {
      const anchor = automation.lastRunAtMs ?? automation.createdAtMs;
      const elapsed = fromMs - anchor;
      if (elapsed < 0) return anchor + trigger.intervalMs;
      return anchor + (Math.floor(elapsed / trigger.intervalMs) + 1) * trigger.intervalMs;
    }
    case 'time-once':
      return trigger.runAtMs > fromMs ? trigger.runAtMs : null;
    default:
      return null;
  }
}

/** Automation co dang trong cooldown tai `now` khong. */
export function automationV2InCooldown(automation: AutomationV2, nowMs: number): boolean {
  if (automation.lastRunAtMs === null) return false;
  return nowMs - automation.lastRunAtMs < automation.cooldownMs;
}

// ---------------------------------------------------------------------------
// CRUD (pure)
// ---------------------------------------------------------------------------

export function createAutomationV2(
  input: CreateAutomationV2Input,
  nowMs: number = Date.now(),
): AutomationV2 {
  if (!isNonEmptyString(input.botId)) throw new Error('botId must be a non-empty string.');
  if (!isNonEmptyString(input.name)) throw new Error('name must be a non-empty string.');
  if (input.cooldownMs !== undefined && (!Number.isFinite(input.cooldownMs) || input.cooldownMs < 0)) {
    throw new Error('cooldownMs must be a non-negative number.');
  }
  const automation: AutomationV2 = {
    id: `auto_v2_${crypto.randomUUID()}`,
    botId: input.botId.trim(),
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    trigger: validateAutomationV2Trigger(input.trigger),
    condition: input.condition === undefined ? undefined : validateAutomationV2Condition(input.condition),
    steps: input.steps.map((s, i) => validateAutomationV2Step(s, i)),
    enabled: input.enabled ?? true,
    cooldownMs: input.cooldownMs ?? AUTOMATION_V2_DEFAULT_COOLDOWN_MS,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    nextRunAtMs: null,
    lastRunAtMs: null,
    runCount: 0,
    failureCount: 0,
  };
  validateAutomationV2(automation);
  automation.nextRunAtMs = nextRunForAutomationV2(automation, nowMs);
  return automation;
}

export function findAutomationV2(
  automations: readonly AutomationV2[],
  id: string,
): AutomationV2 | undefined {
  return automations.find((a) => a.id === id);
}

export function setAutomationV2Enabled(
  automations: readonly AutomationV2[],
  id: string,
  enabled: boolean,
  nowMs: number = Date.now(),
): AutomationV2[] {
  const idx = automations.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`automation not found: ${id}`);
  return automations.map((a, i) => {
    if (i !== idx) return a;
    const next: AutomationV2 = { ...a, enabled, updatedAtMs: nowMs };
    next.nextRunAtMs = enabled ? nextRunForAutomationV2(next, nowMs) : next.nextRunAtMs;
    return next;
  });
}

export function removeAutomationV2(
  automations: readonly AutomationV2[],
  id: string,
): AutomationV2[] {
  if (!automations.some((a) => a.id === id)) throw new Error(`automation not found: ${id}`);
  return automations.filter((a) => a.id !== id);
}

// ---------------------------------------------------------------------------
// Execution — chay chain qua handlers (async, khong goi mang truc tiep)
// ---------------------------------------------------------------------------

function truncateOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const safe = text ?? '';
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
}

export interface ExecuteAutomationV2Options {
  /** Host bao user dang chat thi khong chay (mac dinh: chay). */
  isChatActive?: () => boolean;
  /** Thoi diem chay (mac dinh Date.now()). */
  nowMs?: number;
}

export async function executeAutomationV2(
  automation: AutomationV2,
  event: AutomationV2Event,
  handlers: AutomationV2Handlers,
  options: ExecuteAutomationV2Options = {},
): Promise<{ automation: AutomationV2; run: AutomationV2RunLogEntry }> {
  validateAutomationV2(automation);
  const nowMs = options.nowMs ?? Date.now();
  const startedAtMs = nowMs;
  const baseRun: Omit<AutomationV2RunLogEntry, 'status' | 'finishedAtMs' | 'durationMs' | 'steps'> = {
    id: `run_v2_${crypto.randomUUID()}`,
    automationId: automation.id,
    automationName: automation.name,
    startedAtMs,
    triggerSummary: describeAutomationV2Event(event),
    skipReason: null,
  };
  const finish = (
    status: AutomationV2RunStatus,
    steps: AutomationV2StepResult[],
    skipReason: string | null,
    finishedAtMs: number,
  ): { automation: AutomationV2; run: AutomationV2RunLogEntry } => {
    const failed = status === 'failed' || status === 'partial';
    return {
      automation: {
        ...automation,
        lastRunAtMs: startedAtMs,
        runCount: automation.runCount + 1,
        failureCount: automation.failureCount + (failed ? 1 : 0),
        nextRunAtMs:
          automation.trigger.kind === 'time-once'
            ? null
            : nextRunForAutomationV2(automation, startedAtMs),
        updatedAtMs: finishedAtMs,
      },
      run: {
        ...baseRun,
        status,
        finishedAtMs,
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        skipReason,
        steps,
      },
    };
  };

  if (!automation.enabled) {
    return finish('skipped', [], 'automation is disabled', startedAtMs);
  }
  if (options.isChatActive?.()) {
    return finish('skipped', [], 'user is chatting', startedAtMs);
  }
  if (automationV2InCooldown(automation, startedAtMs)) {
    return finish('skipped', [], `in cooldown (${automation.cooldownMs}ms)`, startedAtMs);
  }
  if (!automationV2TriggerMatches(automation, event)) {
    return finish('skipped', [], 'event does not match trigger', startedAtMs);
  }
  const payload = automationV2EventPayload(event);
  if (!evaluateAutomationV2Condition(automation.condition, payload)) {
    return finish('skipped', [], 'condition did not match event', startedAtMs);
  }

  const variables: Record<string, string> = {};
  const stepResults: AutomationV2StepResult[] = [];
  let sawFailure = false;
  let stopped = false;
  for (const step of automation.steps) {
    if (stopped) break;
    const stepStart = Date.now();
    if (step.when !== undefined && !evaluateAutomationV2Condition(step.when, payload)) {
      stepResults.push({
        stepId: step.id,
        kind: step.kind,
        status: 'skipped',
        output: 'when condition did not match',
        error: null,
        durationMs: 0,
      });
      continue;
    }
    try {
      let output: string | null = null;
      switch (step.kind) {
        case 'run-agent': {
          const prompt = renderAutomationV2Template(step.prompt, variables);
          output = truncateOutput(await handlers.runAgent(step.botId, prompt));
          break;
        }
        case 'run-tool': {
          const args = renderAutomationV2Args(step.args, variables);
          output = truncateOutput(await handlers.runTool(step.tool, args));
          break;
        }
        case 'notify': {
          await handlers.notify(renderAutomationV2Template(step.message, variables));
          output = 'notified';
          break;
        }
        case 'create-task': {
          const title = renderAutomationV2Template(step.title, variables);
          output = truncateOutput(await handlers.createTask(step.botId, title));
          break;
        }
        case 'set-variable': {
          const value = renderAutomationV2Template(step.value, variables);
          variables[step.name] = value;
          output = `${step.name}=${value}`;
          break;
        }
        case 'wait': {
          const sleep = handlers.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
          await sleep(step.waitMs);
          output = `waited ${step.waitMs}ms`;
          break;
        }
      }
      stepResults.push({
        stepId: step.id,
        kind: step.kind,
        status: 'succeeded',
        output,
        error: null,
        durationMs: Math.max(0, Date.now() - stepStart),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sawFailure = true;
      stepResults.push({
        stepId: step.id,
        kind: step.kind,
        status: 'failed',
        output: null,
        error: message,
        durationMs: Math.max(0, Date.now() - stepStart),
      });
      if ((step.onError ?? 'stop') === 'stop') stopped = true;
    }
  }
  const anySucceeded = stepResults.some((r) => r.status === 'succeeded');
  const status: AutomationV2RunStatus = !sawFailure
    ? 'succeeded'
    : anySucceeded
      ? 'partial'
      : 'failed';
  return finish(status, stepResults, null, Date.now());
}

/**
 * Dry-run: tinh xem chain SE chay the nao ma khong thuc thi — step nao
 * bi skip do `when`, bien nao duoc dat. Dung de UI preview truoc khi bat.
 */
export function dryRunAutomationV2(
  automation: AutomationV2,
  event: AutomationV2Event,
): { wouldRun: boolean; skipReason: string | null; steps: { stepId: string; kind: string; wouldRun: boolean; reason: string }[] } {
  validateAutomationV2(automation);
  if (!automation.enabled) return { wouldRun: false, skipReason: 'automation is disabled', steps: [] };
  if (!automationV2TriggerMatches(automation, event)) {
    return { wouldRun: false, skipReason: 'event does not match trigger', steps: [] };
  }
  const payload = automationV2EventPayload(event);
  if (!evaluateAutomationV2Condition(automation.condition, payload)) {
    return { wouldRun: false, skipReason: 'condition did not match event', steps: [] };
  }
  const steps = automation.steps.map((step) => {
    if (step.when !== undefined && !evaluateAutomationV2Condition(step.when, payload)) {
      return { stepId: step.id, kind: step.kind, wouldRun: false, reason: 'when condition did not match' };
    }
    return { stepId: step.id, kind: step.kind, wouldRun: true, reason: 'would run' };
  });
  return { wouldRun: true, skipReason: null, steps };
}

// ---------------------------------------------------------------------------
// Webhook-local verification (HMAC — secret chi qua handlers, khong luu)
// ---------------------------------------------------------------------------

/** Tinh chu ky HMAC-SHA256 cho mot delivery webhook-local (de test/host doi chieu). */
export function signAutomationV2WebhookDelivery(secret: string, body: string): string {
  return computeWebhookSignature(secret, body);
}

/** Verify chu ky cua mot delivery webhook-local. */
export function verifyAutomationV2WebhookDelivery(
  secret: string,
  body: string,
  signature: string,
): boolean {
  return verifyWebhookSignature(secret, body, signature);
}

// ---------------------------------------------------------------------------
// Persistence (JSON + JSONL, atomic, mode 0600)
// ---------------------------------------------------------------------------

export function getAutomationsV2Path(stateDir: string): string {
  return path.join(stateDir, AUTOMATIONS_V2_FILE);
}

export function getAutomationsV2RunsPath(stateDir: string): string {
  return path.join(stateDir, AUTOMATIONS_V2_RUNS_FILE);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export function loadAutomationsV2(stateDir: string): AutomationV2[] {
  const file = getAutomationsV2Path(stateDir);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AutomationV2[] = [];
  for (const item of parsed) {
    try {
      out.push(validateAutomationV2(item));
    } catch {
      // Bo muc hong, giu muc tot.
    }
  }
  return out;
}

export function saveAutomationsV2(stateDir: string, automations: readonly AutomationV2[]): void {
  if (automations.length > AUTOMATIONS_V2_MAX_AUTOMATIONS) {
    throw new Error(`too many automations (${automations.length} > ${AUTOMATIONS_V2_MAX_AUTOMATIONS}).`);
  }
  atomicWriteJson(getAutomationsV2Path(stateDir), automations.map((a) => validateAutomationV2(a)));
}

export function appendAutomationV2Run(stateDir: string, run: AutomationV2RunLogEntry): void {
  const file = getAutomationsV2RunsPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(run)}\n`, 'utf8');
  pruneAutomationV2Runs(stateDir);
}

export function listAutomationV2Runs(stateDir: string): AutomationV2RunLogEntry[] {
  const file = getAutomationsV2RunsPath(stateDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const out: AutomationV2RunLogEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AutomationV2RunLogEntry;
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.steps)) out.push(parsed);
    } catch {
      // Bo dong hong.
    }
  }
  return out;
}

export function pruneAutomationV2Runs(stateDir: string): void {
  const file = getAutomationsV2RunsPath(stateDir);
  if (!fs.existsSync(file)) return;
  const runs = listAutomationV2Runs(stateDir);
  if (runs.length <= AUTOMATIONS_V2_MAX_RUNS) return;
  const kept = runs.slice(-AUTOMATIONS_V2_MAX_RUNS);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function summarizeAutomationV2Runs(
  runs: readonly AutomationV2RunLogEntry[],
): { total: number; succeeded: number; failed: number; partial: number; skipped: number } {
  return {
    total: runs.length,
    succeeded: runs.filter((r) => r.status === 'succeeded').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    partial: runs.filter((r) => r.status === 'partial').length,
    skipped: runs.filter((r) => r.status === 'skipped').length,
  };
}
