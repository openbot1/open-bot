/**
 * A2UI-style generative surfaces — protocol triad v1.15 (Team T2).
 *
 * Idea only, learned from the public A2UI 1.0 description in
 * docs/repo-survey-v115.md section 1: generative UI — the agent
 * returns UI from the app's own component catalog instead of
 * free-form HTML; AG-UI is the event stream, A2UI is the
 * declarative UI state carried on it. No code, text or asset
 * from any other repo is copied here.
 *
 * The catalog is open-bot's own (10 kinds): `card`, `form`,
 * `table`, `chart`, `approval`, `options`, `message`,
 * `progress`, `list`, `detail`. An agent produces a spec from
 * the catalog; the spec is validated against a hand-written
 * JSON Schema (this module's own validator — no schema library
 * is vendored in); the renderer renders it and sends the user's
 * answer back as a `GENERATIVE_UI_RESPONSE` event, which the
 * surface registry records and the agent reads.
 *
 * Safety rules (same posture as the older `agui/genui`):
 * - Specs are DATA ONLY. No HTML, no scripts, no event
 *   handlers, no URLs except plain `https://` links in table
 *   cells and card actions.
 * - Numbers are bounded (rows, options, chart points, text
 *   length) so a runaway spec cannot freeze the renderer.
 * - A spec that fails validation never reaches the renderer:
 *   `validateA2uiSpec` returns the problems and the caller
 *   must fix them first.
 */

import type { ProtocolAgUiEmitter } from './aguiEvents';

/** Component kinds in the v1.15 catalog. */
export const A2UI_COMPONENT_KINDS = [
  'card',
  'form',
  'table',
  'chart',
  'approval',
  'options',
  'message',
  'progress',
  'list',
  'detail',
] as const;

export type A2uiComponentKind = (typeof A2UI_COMPONENT_KINDS)[number];

export function isA2uiComponentKind(value: unknown): value is A2uiComponentKind {
  return typeof value === 'string' && (A2UI_COMPONENT_KINDS as readonly string[]).includes(value);
}

/** Lifecycle of a rendered surface. */
export type A2uiSurfaceStatus = 'pending' | 'answered' | 'dismissed' | 'expired';

/** One key-value row of a `card` / `detail` surface. */
export interface A2uiKeyValue {
  key: string;
  value: string;
}

/** One action button of a `card` / `approval` surface. */
export interface A2uiAction {
  id: string;
  label: string;
  /** Style hint; the renderer decides the exact look. */
  tone?: 'primary' | 'danger' | 'plain';
  /** Optional plain https:// link opened by the action. */
  href?: string;
}

/** One field of a `form` surface. */
export interface A2uiFormField {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'choice' | 'multiline';
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

/** One column of a `table` surface. */
export interface A2uiTableColumn {
  key: string;
  label: string;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
}

/** One point of a `chart` surface (chart-lite: bars or line). */
export interface A2uiChartPoint {
  label: string;
  value: number;
}

/** One option of an `options` surface. */
export interface A2uiOption {
  id: string;
  label: string;
  description?: string;
}

/** One row of a `list` surface. */
export interface A2uiListItem {
  id: string;
  title: string;
  subtitle?: string;
}

/** The data payload of a surface, per kind. */
export type A2uiSurfaceData =
  | { rows: A2uiKeyValue[]; actions?: A2uiAction[]; body?: string }
  | { fields: A2uiFormField[]; submitLabel?: string }
  | { columns: A2uiTableColumn[]; rows: Array<Record<string, string | number>> }
  | { chartType: 'bar' | 'line'; points: A2uiChartPoint[] }
  | { question: string; actions: A2uiAction[]; detail?: string }
  | { options: A2uiOption[]; multi?: boolean }
  | { text: string; tone?: 'info' | 'success' | 'warning' | 'error' }
  | { value: number; max?: number; label?: string }
  | { items: A2uiListItem[] }
  | { title: string; rows: A2uiKeyValue[]; body?: string };

/** A declarative UI spec: what the agent asks the frontend to show. */
export interface A2uiSpec {
  componentId: string;
  kind: A2uiComponentKind;
  runId: string;
  title: string;
  data: A2uiSurfaceData;
  /** The run waits for the user's answer before continuing. */
  blocking?: boolean;
  /** Milliseconds after which a pending surface expires (default: no expiry). */
  expiresAfterMs?: number;
}

/** A registered surface: a spec plus its answer lifecycle. */
export interface A2uiSurface {
  spec: A2uiSpec;
  status: A2uiSurfaceStatus;
  createdAt: string;
  answeredAt?: string;
  answer?: Record<string, unknown>;
}

/** Client capabilities the renderer reports (for negotiation). */
export interface A2uiClientCapabilities {
  kinds: A2uiComponentKind[];
  /** Maximum table rows the client renders (default 50). */
  maxTableRows?: number;
  /** Whether the client renders chart-lite (else falls back to table). */
  charts?: boolean;
  /** Whether the client renders interactive surfaces at all. */
  interactive?: boolean;
}

/** Default capabilities: a full desktop renderer. */
export const A2UI_DEFAULT_CAPABILITIES: A2uiClientCapabilities = {
  kinds: [...A2UI_COMPONENT_KINDS],
  maxTableRows: 50,
  charts: true,
  interactive: true,
};

/** Fallback map for clients that cannot render a kind. */
export const A2UI_FALLBACK_KIND: Partial<Record<A2uiComponentKind, A2uiComponentKind>> = {
  chart: 'table',
  card: 'message',
  table: 'message',
  progress: 'message',
  list: 'message',
  detail: 'message',
  // form / approval / options / message have no fallback: the user
  // must answer them (or the agent must not send them there).
};

/** Hard limits for one spec. */
export const A2UI_MAX_TITLE_CHARS = 200;
export const A2UI_MAX_TEXT_CHARS = 4000;
export const A2UI_MAX_ROWS = 50;
export const A2UI_MAX_OPTIONS = 16;
export const A2UI_MAX_FIELDS = 32;
export const A2UI_MAX_POINTS = 64;
export const A2UI_MAX_ITEMS = 50;

const COMPONENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HTTPS_RE = /^https:\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkText(problems: string[], value: unknown, field: string, max: number, required = false): void {
  if (value === undefined || value === null) {
    if (required) problems.push(`${field} is required`);
    return;
  }
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string`);
    return;
  }
  if (required && value.trim() === '') problems.push(`${field} must be a non-empty string`);
  if (value.length > max) problems.push(`${field} must be at most ${max} characters`);
}

function checkHref(problems: string[], value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !HTTPS_RE.test(value)) {
    problems.push(`${field} must be a plain https:// URL when present`);
  }
}

/**
 * Hand-written JSON-Schema-style validator for an A2UI spec.
 * Returns the problems, empty = valid. The schema this enforces
 * is documented in `docs/v115-protocols.md` (catalog section)
 * so a client in another language can implement the same check.
 */
export function validateA2uiSpec(spec: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(spec)) return ['spec is not an object'];
  if (typeof spec['componentId'] !== 'string' || !COMPONENT_ID_RE.test(spec['componentId'] as string)) {
    problems.push('componentId must be a safe identifier (letters, digits, _ and -, max 64)');
  }
  if (!isA2uiComponentKind(spec['kind'])) problems.push('kind is not a known catalog component');
  if (typeof spec['runId'] !== 'string' || (spec['runId'] as string).trim() === '') {
    problems.push('runId must be a non-empty string');
  }
  checkText(problems, spec['title'], 'title', A2UI_MAX_TITLE_CHARS, true);
  if (spec['blocking'] !== undefined && typeof spec['blocking'] !== 'boolean') {
    problems.push('blocking must be a boolean when present');
  }
  if (spec['expiresAfterMs'] !== undefined) {
    const t = spec['expiresAfterMs'];
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 1000 || t > 3_600_000) {
      problems.push('expiresAfterMs must be between 1000 and 3600000');
    }
  }
  const data = spec['data'];
  if (!isRecord(data)) {
    problems.push('data must be an object');
    return problems;
  }
  const kind = spec['kind'] as A2uiComponentKind | undefined;
  switch (kind) {
    case 'card':
    case 'detail': {
      const rows = data['rows'];
      if (!Array.isArray(rows) || rows.length === 0) {
        problems.push(`${kind} data needs a non-empty rows array`);
      } else {
        if (rows.length > A2UI_MAX_ROWS) problems.push(`${kind} rows allow at most ${A2UI_MAX_ROWS}`);
        for (const row of rows as unknown[]) {
          if (!isRecord(row)) { problems.push(`${kind} rows must be objects`); continue; }
          checkText(problems, row['key'], `${kind}.rows[].key`, 100, true);
          checkText(problems, row['value'], `${kind}.rows[].value`, A2UI_MAX_TEXT_CHARS, true);
        }
      }
      if (kind === 'card' && data['actions'] !== undefined) checkActions(problems, data['actions']);
      checkText(problems, data['body'], `${kind}.body`, A2UI_MAX_TEXT_CHARS);
      if (kind === 'detail') checkText(problems, data['title'], 'detail.data.title', A2UI_MAX_TITLE_CHARS, true);
      break;
    }
    case 'form': {
      const fields = data['fields'];
      if (!Array.isArray(fields) || fields.length === 0) {
        problems.push('form data needs a non-empty fields array');
      } else {
        if (fields.length > A2UI_MAX_FIELDS) problems.push(`form fields allow at most ${A2UI_MAX_FIELDS}`);
        const seen = new Set<string>();
        for (const field of fields as unknown[]) {
          if (!isRecord(field)) { problems.push('form fields must be objects'); continue; }
          if (typeof field['name'] !== 'string' || !FIELD_NAME_RE.test(field['name'] as string)) {
            problems.push(`form field name ${JSON.stringify(field['name'])} is not a safe identifier`);
          } else if (seen.has(field['name'] as string)) {
            problems.push(`duplicate form field name ${field['name'] as string}`);
          } else {
            seen.add(field['name'] as string);
          }
          checkText(problems, field['label'], 'form field label', 200, true);
          if (!['text', 'number', 'boolean', 'choice', 'multiline'].includes(String(field['kind']))) {
            problems.push(`form field ${String(field['name'])} has an unknown kind`);
          }
          if (field['kind'] === 'choice' && (!Array.isArray(field['options']) || (field['options'] as unknown[]).length === 0)) {
            problems.push(`choice field ${String(field['name'])} needs a non-empty options array`);
          }
          checkText(problems, field['placeholder'], 'form field placeholder', 200);
        }
      }
      checkText(problems, data['submitLabel'], 'form.submitLabel', 100);
      break;
    }
    case 'table': {
      const columns = data['columns'];
      const rows = data['rows'];
      if (!Array.isArray(columns) || columns.length === 0) problems.push('table data needs a non-empty columns array');
      else if (columns.length > 32) problems.push('table columns allow at most 32');
      if (Array.isArray(columns)) {
        const keys = new Set<string>();
        for (const col of columns as unknown[]) {
          if (!isRecord(col)) { problems.push('table columns must be objects'); continue; }
          checkText(problems, col['key'], 'table column key', 100, true);
          checkText(problems, col['label'], 'table column label', 100, true);
          if (typeof col['key'] === 'string') keys.add(col['key']);
          if (col['align'] !== undefined && col['align'] !== 'left' && col['align'] !== 'right') {
            problems.push('table column align must be left or right');
          }
        }
        if (!Array.isArray(rows)) {
          problems.push('table data needs a rows array');
        } else {
          if (rows.length > A2UI_MAX_ROWS) problems.push(`table rows allow at most ${A2UI_MAX_ROWS}`);
          for (const row of rows as unknown[]) {
            if (!isRecord(row)) { problems.push('table rows must be objects'); continue; }
            for (const key of Object.keys(row)) {
              if (!keys.has(key)) problems.push(`table row has unknown column ${key}`);
              const v = row[key];
              if (typeof v !== 'string' && typeof v !== 'number') problems.push(`table cell ${key} must be a string or number`);
              if (typeof v === 'string' && v.length > A2UI_MAX_TEXT_CHARS) problems.push(`table cell ${key} is too long`);
              if (typeof v === 'string' && /^(javascript|data|vbscript):/i.test(v)) {
                problems.push(`table cell ${key} must not carry a script URL`);
              }
            }
          }
        }
      }
      break;
    }
    case 'chart': {
      if (data['chartType'] !== 'bar' && data['chartType'] !== 'line') {
        problems.push('chart.chartType must be bar or line');
      }
      const points = data['points'];
      if (!Array.isArray(points) || points.length === 0) {
        problems.push('chart data needs a non-empty points array');
      } else {
        if (points.length > A2UI_MAX_POINTS) problems.push(`chart points allow at most ${A2UI_MAX_POINTS}`);
        for (const point of points as unknown[]) {
          if (!isRecord(point)) { problems.push('chart points must be objects'); continue; }
          checkText(problems, point['label'], 'chart point label', 100, true);
          if (typeof point['value'] !== 'number' || !Number.isFinite(point['value'])) {
            problems.push('chart point value must be a finite number');
          }
        }
      }
      break;
    }
    case 'approval': {
      checkText(problems, data['question'], 'approval.question', A2UI_MAX_TEXT_CHARS, true);
      checkActions(problems, data['actions'], true);
      checkText(problems, data['detail'], 'approval.detail', A2UI_MAX_TEXT_CHARS);
      break;
    }
    case 'options': {
      const options = data['options'];
      if (!Array.isArray(options) || options.length === 0) {
        problems.push('options data needs a non-empty options array');
      } else {
        if (options.length > A2UI_MAX_OPTIONS) problems.push(`options allow at most ${A2UI_MAX_OPTIONS}`);
        const seen = new Set<string>();
        for (const option of options as unknown[]) {
          if (!isRecord(option)) { problems.push('options must be objects'); continue; }
          if (typeof option['id'] !== 'string' || !COMPONENT_ID_RE.test(option['id'] as string)) {
            problems.push(`option id ${JSON.stringify(option['id'])} is not a safe identifier`);
          } else if (seen.has(option['id'] as string)) {
            problems.push(`duplicate option id ${option['id'] as string}`);
          } else {
            seen.add(option['id'] as string);
          }
          checkText(problems, option['label'], 'option label', 200, true);
          checkText(problems, option['description'], 'option description', 500);
        }
      }
      if (data['multi'] !== undefined && typeof data['multi'] !== 'boolean') {
        problems.push('options.multi must be a boolean when present');
      }
      break;
    }
    case 'message': {
      checkText(problems, data['text'], 'message.text', A2UI_MAX_TEXT_CHARS, true);
      if (data['tone'] !== undefined && !['info', 'success', 'warning', 'error'].includes(String(data['tone']))) {
        problems.push('message.tone must be info, success, warning or error');
      }
      break;
    }
    case 'progress': {
      if (typeof data['value'] !== 'number' || !Number.isFinite(data['value']) || (data['value'] as number) < 0) {
        problems.push('progress.value must be a non-negative finite number');
      }
      if (data['max'] !== undefined && (typeof data['max'] !== 'number' || !Number.isFinite(data['max'] as number) || (data['max'] as number) <= 0)) {
        problems.push('progress.max must be a positive finite number when present');
      }
      if (typeof data['value'] === 'number' && typeof data['max'] === 'number' && (data['value'] as number) > (data['max'] as number)) {
        problems.push('progress.value must not exceed progress.max');
      }
      checkText(problems, data['label'], 'progress.label', 200);
      break;
    }
    case 'list': {
      const items = data['items'];
      if (!Array.isArray(items) || items.length === 0) {
        problems.push('list data needs a non-empty items array');
      } else {
        if (items.length > A2UI_MAX_ITEMS) problems.push(`list items allow at most ${A2UI_MAX_ITEMS}`);
        for (const item of items as unknown[]) {
          if (!isRecord(item)) { problems.push('list items must be objects'); continue; }
          if (typeof item['id'] !== 'string' || !COMPONENT_ID_RE.test(item['id'] as string)) {
            problems.push(`list item id ${JSON.stringify(item['id'])} is not a safe identifier`);
          }
          checkText(problems, item['title'], 'list item title', 200, true);
          checkText(problems, item['subtitle'], 'list item subtitle', 500);
        }
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

function checkActions(problems: string[], value: unknown, required = false): void {
  if (value === undefined) {
    if (required) problems.push('actions is required');
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    problems.push('actions must be a non-empty array');
    return;
  }
  if (value.length > 8) problems.push('actions allow at most 8');
  const seen = new Set<string>();
  for (const action of value as unknown[]) {
    if (!isRecord(action)) { problems.push('actions must be objects'); continue; }
    if (typeof action['id'] !== 'string' || !COMPONENT_ID_RE.test(action['id'] as string)) {
      problems.push(`action id ${JSON.stringify(action['id'])} is not a safe identifier`);
    } else if (seen.has(action['id'] as string)) {
      problems.push(`duplicate action id ${action['id'] as string}`);
    } else {
      seen.add(action['id'] as string);
    }
    checkText(problems, action['label'], 'action label', 100, true);
    if (action['tone'] !== undefined && !['primary', 'danger', 'plain'].includes(String(action['tone']))) {
      problems.push('action tone must be primary, danger or plain');
    }
    checkHref(problems, action['href'], 'action href');
  }
}

export function isValidA2uiSpec(spec: unknown): spec is A2uiSpec {
  return validateA2uiSpec(spec).length === 0;
}

/**
 * Negotiate a spec against what a client can render.
 * Returns the spec to render (possibly the fallback kind) and
 * whether a fallback was applied. Interactive kinds (form,
 * approval, options) never fall back — the caller must not
 * send them to a client that cannot render them.
 */
export function negotiateA2uiSpec(
  spec: A2uiSpec,
  capabilities: A2uiClientCapabilities,
): { spec: A2uiSpec; fallbackApplied: boolean; fallbackFrom?: A2uiComponentKind } {
  if (capabilities.interactive === false && spec.kind !== 'message') {
    // A non-interactive client only renders plain messages.
    return {
      spec: {
        ...spec,
        kind: 'message',
        data: { text: `${spec.title}: this surface needs an interactive client.`, tone: 'info' },
      },
      fallbackApplied: true,
      fallbackFrom: spec.kind,
    };
  }
  if (capabilities.kinds.includes(spec.kind)) {
    if (spec.kind === 'chart' && capabilities.charts === false) {
      return { spec: chartToTableSpec(spec), fallbackApplied: true, fallbackFrom: 'chart' };
    }
    if (spec.kind === 'table') {
      const max = capabilities.maxTableRows ?? A2UI_MAX_ROWS;
      const data = spec.data as { columns: A2uiTableColumn[]; rows: Array<Record<string, string | number>> };
      if (data.rows.length > max) {
        return {
          spec: { ...spec, data: { ...data, rows: data.rows.slice(0, max) } },
          fallbackApplied: true,
          fallbackFrom: 'table',
        };
      }
    }
    return { spec, fallbackApplied: false };
  }
  const fallback = A2UI_FALLBACK_KIND[spec.kind];
  if (fallback === 'table' && spec.kind === 'chart') {
    return { spec: chartToTableSpec(spec), fallbackApplied: true, fallbackFrom: 'chart' };
  }
  if (fallback === 'message') {
    return {
      spec: {
        ...spec,
        kind: 'message',
        data: { text: `${spec.title}: this client cannot render ${spec.kind}.`, tone: 'info' },
      },
      fallbackApplied: true,
      fallbackFrom: spec.kind,
    };
  }
  // No fallback: return the spec unchanged and let the caller refuse it.
  return { spec, fallbackApplied: false };
}

function chartToTableSpec(spec: A2uiSpec): A2uiSpec {
  const data = spec.data as { chartType: 'bar' | 'line'; points: A2uiChartPoint[] };
  return {
    ...spec,
    kind: 'table',
    data: {
      columns: [
        { key: 'label', label: 'Label' },
        { key: 'value', label: 'Value', align: 'right' },
      ],
      rows: data.points.map((p) => ({ label: p.label, value: p.value })),
    },
  };
}

/** Outcome of answering a surface. */
export interface A2uiAnswerOutcome {
  applied: boolean;
  outcome: 'answered' | 'dismissed' | 'already-resolved' | 'not-found' | 'expired';
  surface?: A2uiSurface;
}

/**
 * Registry of live surfaces for one or more runs.
 *
 * - `register()` validates the spec, stores it as `pending`,
 *   emits `GENERATIVE_UI_START` on the run's emitter when one
 *   is attached, and arms the expiry timer when the spec asks
 *   for one.
 * - `answer()` records the user's answer, emits
 *   `GENERATIVE_UI_RESPONSE`, and marks the surface answered.
 *   A second answer is refused (`already-resolved`).
 * - `dismiss()` / `expireDue()` mark a surface dismissed /
 *   expired without an answer.
 */
export class A2uiSurfaceRegistry {
  private readonly surfaces = new Map<string, A2uiSurface>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private emitterForRun: ((runId: string) => ProtocolAgUiEmitter | undefined) | undefined;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Attach an emitter lookup so surfaces publish stream events. */
  attachEmitters(lookup: (runId: string) => ProtocolAgUiEmitter | undefined): void {
    this.emitterForRun = lookup;
  }

  register(spec: A2uiSpec): A2uiSurface {
    const problems = validateA2uiSpec(spec);
    if (problems.length > 0) {
      throw new Error(`Invalid A2UI spec: ${problems.join('; ')}`);
    }
    if (this.surfaces.has(spec.componentId)) {
      throw new Error(`A surface with componentId ${spec.componentId} already exists.`);
    }
    const surface: A2uiSurface = {
      spec,
      status: 'pending',
      createdAt: new Date(this.now()).toISOString(),
    };
    this.surfaces.set(spec.componentId, surface);
    this.emitterForRun?.(spec.runId)?.emit(
      'GENERATIVE_UI_START',
      { componentId: spec.componentId, kind: spec.kind, title: spec.title },
      undefined,
    );
    if (spec.expiresAfterMs !== undefined) {
      const timer = setTimeout(() => this.expire(spec.componentId), spec.expiresAfterMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.timers.set(spec.componentId, timer);
    }
    return surface;
  }

  get(componentId: string): A2uiSurface | undefined {
    return this.surfaces.get(componentId);
  }

  /** Pending surfaces, optionally filtered to one run. */
  pending(runId?: string): A2uiSurface[] {
    return [...this.surfaces.values()].filter(
      (s) => s.status === 'pending' && (runId === undefined || s.spec.runId === runId),
    );
  }

  all(): A2uiSurface[] {
    return [...this.surfaces.values()];
  }

  answer(componentId: string, answer: Record<string, unknown>): A2uiAnswerOutcome {
    const surface = this.surfaces.get(componentId);
    if (!surface) return { applied: false, outcome: 'not-found' };
    if (surface.status !== 'pending') {
      return { applied: false, outcome: 'already-resolved', surface };
    }
    const problems = validateA2uiAnswer(surface.spec, answer);
    if (problems.length > 0) {
      throw new Error(`Invalid surface answer: ${problems.join('; ')}`);
    }
    this.clearTimer(componentId);
    surface.status = 'answered';
    surface.answeredAt = new Date(this.now()).toISOString();
    surface.answer = answer;
    this.emitterForRun?.(surface.spec.runId)?.emit('GENERATIVE_UI_RESPONSE', {
      componentId,
      answer,
    });
    return { applied: true, outcome: 'answered', surface };
  }

  dismiss(componentId: string): A2uiAnswerOutcome {
    const surface = this.surfaces.get(componentId);
    if (!surface) return { applied: false, outcome: 'not-found' };
    if (surface.status !== 'pending') {
      return { applied: false, outcome: 'already-resolved', surface };
    }
    this.clearTimer(componentId);
    surface.status = 'dismissed';
    surface.answeredAt = new Date(this.now()).toISOString();
    return { applied: true, outcome: 'dismissed', surface };
  }

  /** Expire one pending surface (timer or manual sweep). */
  expire(componentId: string): A2uiAnswerOutcome {
    const surface = this.surfaces.get(componentId);
    if (!surface) return { applied: false, outcome: 'not-found' };
    if (surface.status !== 'pending') {
      return { applied: false, outcome: 'already-resolved', surface };
    }
    this.clearTimer(componentId);
    surface.status = 'expired';
    surface.answeredAt = new Date(this.now()).toISOString();
    return { applied: true, outcome: 'expired', surface };
  }

  /** Expire every pending surface whose deadline has passed. */
  expireDue(nowMs = this.now()): number {
    let count = 0;
    for (const surface of [...this.surfaces.values()]) {
      if (surface.status !== 'pending' || surface.spec.expiresAfterMs === undefined) continue;
      const created = Date.parse(surface.createdAt);
      if (Number.isNaN(created) || nowMs - created < surface.spec.expiresAfterMs) continue;
      this.expire(surface.spec.componentId);
      count += 1;
    }
    return count;
  }

  private clearTimer(componentId: string): void {
    const timer = this.timers.get(componentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(componentId);
    }
  }
}

/** Validate a user's answer against the surface that asked for it. */
export function validateA2uiAnswer(spec: A2uiSpec, answer: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(answer)) return ['answer must be an object'];
  switch (spec.kind) {
    case 'form': {
      const data = spec.data as { fields: A2uiFormField[] };
      const byName = new Map(data.fields.map((f) => [f.name, f]));
      for (const key of Object.keys(answer)) {
        if (!byName.has(key)) problems.push(`unexpected form answer field ${key}`);
      }
      for (const field of data.fields) {
        const value = answer[field.name];
        if (value === undefined || value === null || value === '') {
          if (field.required) problems.push(`required field ${field.name} is missing`);
          continue;
        }
        if ((field.kind === 'text' || field.kind === 'multiline') && typeof value !== 'string') {
          problems.push(`field ${field.name} must be a string`);
        }
        if (field.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
          problems.push(`field ${field.name} must be a finite number`);
        }
        if (field.kind === 'boolean' && typeof value !== 'boolean') {
          problems.push(`field ${field.name} must be a boolean`);
        }
        if (field.kind === 'choice' && (typeof value !== 'string' || !(field.options ?? []).includes(value))) {
          problems.push(`field ${field.name} must be one of its options`);
        }
      }
      break;
    }
    case 'approval': {
      if (typeof answer['actionId'] !== 'string') problems.push('approval answer needs a string "actionId"');
      else {
        const data = spec.data as { actions: A2uiAction[] };
        if (!data.actions.some((a) => a.id === answer['actionId'])) {
          problems.push(`actionId ${answer['actionId'] as string} is not one of the offered actions`);
        }
      }
      break;
    }
    case 'options': {
      const data = spec.data as { options: A2uiOption[]; multi?: boolean };
      if (data.multi === true) {
        if (!Array.isArray(answer['selectedIds']) || (answer['selectedIds'] as unknown[]).length === 0) {
          problems.push('options answer needs a non-empty "selectedIds" array');
        } else {
          for (const id of answer['selectedIds'] as unknown[]) {
            if (typeof id !== 'string' || !data.options.some((o) => o.id === id)) {
              problems.push(`selected option ${JSON.stringify(id)} is not offered`);
            }
          }
        }
      } else if (typeof answer['selectedId'] !== 'string' || !data.options.some((o) => o.id === answer['selectedId'])) {
        problems.push('options answer needs a "selectedId" of one of the offered options');
      }
      break;
    }
    case 'card': {
      if (answer['actionId'] !== undefined) {
        const data = spec.data as { actions?: A2uiAction[] };
        if (typeof answer['actionId'] !== 'string' || !(data.actions ?? []).some((a) => a.id === answer['actionId'])) {
          problems.push('card answer "actionId" must be one of the offered actions');
        }
      }
      break;
    }
    default:
      // Display-only kinds (table, chart, message, progress, list,
      // detail) take no answer; an empty object acknowledges them.
      if (Object.keys(answer).length > 0) {
        problems.push(`${spec.kind} surfaces take no answer fields`);
      }
      break;
  }
  return problems;
}
