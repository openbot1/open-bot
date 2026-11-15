/**
 * Generative UI v2 (v1.10, Đội T5 — AG-UI generative UI v2).
 *
 * The v1 registry (genui.ts) covers six component kinds the agent can
 * ask the renderer to show. V2 adds two kinds the survey's AG-UI
 * work needs — `card` (a summary card with key-values + actions) and
 * `chart` (bar / line / pie over named series) — plus the two pieces
 * that make generative UI usable in production:
 *
 * 1. A context-driven suggester: the server looks at what the agent
 *    actually has (numbers, rows, choices, key-values, ...) and picks
 *    the best component kind, instead of the agent guessing. The
 *    suggestion carries a reason so the UI can explain the choice.
 * 2. Capability negotiation with fallback: the client declares which
 *    kinds it can render; when it cannot render the suggested kind,
 *    the server downgrades to the closest kind that keeps the data
 *    (chart -> table, card -> message, table -> message) and says so
 *    explicitly. Interactive kinds (confirm / options / form) have no
 *    lossless fallback — an unsupported interactive kind is reported
 *    as not renderable rather than silently degraded into text.
 *
 * Safety: same rules as v1. Components are DATA ONLY — no HTML, no
 * scripts, no URLs except plain `https://` links in table cells, no
 * code execution. Labels are length-capped and script-rejected here,
 * before they reach any renderer. The v2 registry reuses the v1
 * registry for the six v1 kinds and tracks card/chart in its own map
 * with the same lifecycle (requested -> answered / dismissed /
 * expired), so a stale component still cannot be answered twice.
 */

import { AG_UI_MAX_GENUI_ITEMS } from './types';
import type { AgUiComponentKind, AgUiGenerativeUiData } from './types';
import {
  AgUiGenerativeUiRegistry,
  validateGenerativeUiRequest,
  validateGenerativeUiResponse,
  type AgUiComponentProps,
  type AgUiComponentRecord,
  type AgUiComponentRequest,
  type AgUiFormField,
  type AgUiOption,
  type AgUiTableColumn,
} from './genui';
import { cloneAgUiJson } from './validate';

/** The two component kinds v2 adds. */
export type AgUiV2Kind = 'card' | 'chart';

/** Every kind the v2 layer can produce (v1 kinds + v2 kinds). */
export type AgUiV2ComponentKind = AgUiComponentKind | AgUiV2Kind;

/** All v2 kinds, in a stable order for capability lists. */
export const AG_UI_V2_KINDS: AgUiV2ComponentKind[] = [
  'confirm', 'options', 'form', 'table', 'progress', 'message', 'card', 'chart',
];

export function isAgUiV2Kind(value: unknown): value is AgUiV2ComponentKind {
  return typeof value === 'string' && (AG_UI_V2_KINDS as readonly string[]).includes(value);
}

/** One action button on a `card` component. */
export interface AgUiV2CardAction {
  id: string;
  label: string;
  kind?: 'primary' | 'secondary' | 'danger';
}

/** One key-value row on a `card` component. */
export interface AgUiV2CardField {
  label: string;
  value: string;
}

/** Validated props of a `card` component. */
export interface AgUiV2CardProps {
  /** Headline shown above the body (optional). */
  headline?: string;
  /** Main body text. */
  body: string;
  /** Key-value rows shown under the body. */
  fields?: AgUiV2CardField[];
  /** Action buttons (answering returns the clicked action id). */
  actions?: AgUiV2CardAction[];
}

/** One point of a chart series. */
export interface AgUiV2ChartPoint {
  label: string;
  value: number;
}

/** One named series of a chart. */
export interface AgUiV2ChartSeries {
  name: string;
  points: AgUiV2ChartPoint[];
}

/** Validated props of a `chart` component. */
export interface AgUiV2ChartProps {
  chartType: 'bar' | 'line' | 'pie';
  series: AgUiV2ChartSeries[];
  xLabel?: string;
  yLabel?: string;
}

export type AgUiV2ComponentProps = AgUiComponentProps | AgUiV2CardProps | AgUiV2ChartProps;

/** A validated v2 component request, ready for the renderer. */
export interface AgUiV2ComponentRequest {
  componentId: string;
  kind: AgUiV2ComponentKind;
  title: string;
  description?: string;
  props: AgUiV2ComponentProps;
  blocking?: boolean;
  runId: string;
  botId?: string;
}

/** One tracked v2 component instance. */
export interface AgUiV2ComponentRecord {
  request: AgUiV2ComponentRequest;
  status: AgUiComponentRecord['status'];
  requestedAt: string;
  response?: Record<string, unknown>;
  action?: string;
  answeredAt?: string;
  /** Fallback applied at negotiation time, if any. */
  fallback?: { from: AgUiV2ComponentKind; to: AgUiV2ComponentKind; reason: string };
}

/** What the client says it can render. */
export interface AgUiV2ClientCapabilities {
  kinds: AgUiV2ComponentKind[];
  /** False when the client can only show text (no buttons/inputs). */
  interactive?: boolean;
  /** Max items (options/rows/points) the client renders (default 50). */
  maxItems?: number;
}

/** Result of capability negotiation. */
export interface AgUiV2Negotiation {
  renderable: boolean;
  /** The request to render (downgraded when a fallback applied). */
  effective?: AgUiV2ComponentRequest;
  fallbackApplied?: { from: AgUiV2ComponentKind; to: AgUiV2ComponentKind; reason: string };
  /** Why the request cannot be rendered (when renderable is false). */
  reason?: string;
}

export class AgUiV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgUiV2Error';
  }
}

function fail(message: string): never {
  throw new AgUiV2Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireLabel(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`Generative UI v2 ${what} must be a non-empty string.`);
  }
  if (value.length > max) fail(`Generative UI v2 ${what} is too long (max ${max}).`);
  if (/javascript:/i.test(value) || /<script/i.test(value)) {
    fail(`Generative UI v2 ${what} must not contain scripts or javascript: URLs.`);
  }
  return value;
}

function optionalLabel(value: unknown, what: string, max = 200): string | undefined {
  if (value === undefined) return undefined;
  return requireLabel(value, what, max);
}

function validateCard(props: Record<string, unknown>): AgUiV2CardProps {
  const body = requireLabel(props['body'], '"body"', 2000);
  const headline = optionalLabel(props['headline'], '"headline"', 200);
  const rawFields = props['fields'];
  let fields: AgUiV2CardField[] | undefined;
  if (rawFields !== undefined) {
    if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > AG_UI_MAX_GENUI_ITEMS) {
      fail('Generative UI v2 "fields" must be a non-empty array (max 50).');
    }
    fields = rawFields.map((item, i) => {
      if (!isRecord(item)) fail(`Generative UI v2 field #${i} must be an object.`);
      return {
        label: requireLabel(item['label'], `field #${i} "label"`, 200),
        value: requireLabel(item['value'], `field #${i} "value"`, 500),
      };
    });
  }
  const rawActions = props['actions'];
  let actions: AgUiV2CardAction[] | undefined;
  if (rawActions !== undefined) {
    if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.length > 10) {
      fail('Generative UI v2 "actions" must be a non-empty array (max 10).');
    }
    const seen = new Set<string>();
    actions = rawActions.map((item, i) => {
      if (!isRecord(item)) fail(`Generative UI v2 action #${i} must be an object.`);
      const id = requireLabel(item['id'], `action #${i} "id"`, 128);
      if (seen.has(id)) fail(`Generative UI v2 actions must not repeat id "${id}".`);
      seen.add(id);
      const kind = item['kind'];
      if (kind !== undefined && kind !== 'primary' && kind !== 'secondary' && kind !== 'danger') {
        fail(`Generative UI v2 action #${i} "kind" must be "primary", "secondary" or "danger".`);
      }
      return {
        id,
        label: requireLabel(item['label'], `action #${i} "label"`, 200),
        ...(kind !== undefined ? { kind: kind as AgUiV2CardAction['kind'] } : {}),
      };
    });
  }
  return {
    ...(headline !== undefined ? { headline } : {}),
    body,
    ...(fields !== undefined ? { fields } : {}),
    ...(actions !== undefined ? { actions } : {}),
  };
}

function validateChart(props: Record<string, unknown>): AgUiV2ChartProps {
  const chartType = props['chartType'];
  if (chartType !== 'bar' && chartType !== 'line' && chartType !== 'pie') {
    fail('Generative UI v2 "chartType" must be "bar", "line" or "pie".');
  }
  const rawSeries = props['series'];
  if (!Array.isArray(rawSeries) || rawSeries.length === 0 || rawSeries.length > 10) {
    fail('Generative UI v2 "series" must be a non-empty array (max 10).');
  }
  const series: AgUiV2ChartSeries[] = rawSeries.map((item, i) => {
    if (!isRecord(item)) fail(`Generative UI v2 series #${i} must be an object.`);
    const name = requireLabel(item['name'], `series #${i} "name"`, 200);
    const rawPoints = item['points'];
    if (!Array.isArray(rawPoints) || rawPoints.length === 0 || rawPoints.length > AG_UI_MAX_GENUI_ITEMS) {
      fail(`Generative UI v2 series #${i} "points" must be a non-empty array (max 50).`);
    }
    const points = rawPoints.map((p, j) => {
      if (!isRecord(p)) fail(`Generative UI v2 point #${j} of series #${i} must be an object.`);
      const label = requireLabel(p['label'], `point #${j} "label"`, 200);
      const value = p['value'];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`Generative UI v2 point #${j} of series #${i} "value" must be a finite number.`);
      }
      return { label, value };
    });
    return { name, points };
  });
  if (chartType === 'pie' && series.length > 1) {
    fail('Generative UI v2 "pie" charts take exactly one series.');
  }
  return {
    chartType,
    series,
    ...(optionalLabel(props['xLabel'], '"xLabel"', 200) !== undefined ? { xLabel: props['xLabel'] as string } : {}),
    ...(optionalLabel(props['yLabel'], '"yLabel"', 200) !== undefined ? { yLabel: props['yLabel'] as string } : {}),
  };
}

/** Validate a raw v2 request (card/chart here, v1 kinds delegated). */
export function validateAgUiV2Request(
  data: Omit<AgUiGenerativeUiData, 'kind'> & { kind: AgUiV2ComponentKind } & Record<string, unknown>,
  runId: string,
  botId?: string,
): AgUiV2ComponentRequest {
  const componentId = data['componentId'];
  if (typeof componentId !== 'string' || componentId.length === 0 || componentId.length > 128) {
    fail('Generative UI v2 "componentId" must be a non-empty string (max 128).');
  }
  const kind = data['kind'] as AgUiV2ComponentKind;
  if (!isAgUiV2Kind(kind)) fail('Generative UI v2 "kind" must be a known component kind.');
  if (kind !== 'card' && kind !== 'chart') {
    const v1 = validateGenerativeUiRequest(data as AgUiGenerativeUiData & Record<string, unknown>, runId, botId);
    return { ...v1, props: v1.props as AgUiV2ComponentProps };
  }
  const title = requireLabel(data['title'], '"title"', 200);
  const description = optionalLabel(data['description'], '"description"', 1000);
  const rawProps = data['props'];
  if (!isRecord(rawProps)) fail('Generative UI v2 "props" must be an object.');
  // Depth 6: chart props nest five levels deep (props -> series ->
  // series item -> points -> point -> label/value), one more than
  // the v1 state-clone depth of 4 allows.
  const cloned = cloneAgUiJson(rawProps, 6);
  if (!isRecord(cloned)) fail('Generative UI v2 "props" must clone to an object.');
  const props = kind === 'card' ? validateCard(cloned) : validateChart(cloned);
  const blocking = data['blocking'];
  if (blocking !== undefined && typeof blocking !== 'boolean') {
    fail('Generative UI v2 "blocking" must be a boolean when present.');
  }
  return {
    componentId,
    kind,
    title,
    ...(description !== undefined ? { description } : {}),
    props,
    ...(blocking === true ? { blocking: true } : {}),
    runId,
    ...(botId !== undefined ? { botId } : {}),
  };
}

/** Context the suggester reads to pick a component kind. */
export type AgUiV2Context =
  | { kind: 'numbers'; series: AgUiV2ChartSeries[]; chartType?: 'bar' | 'line' | 'pie'; xLabel?: string; yLabel?: string }
  | { kind: 'rows'; columns: AgUiTableColumn[]; rows: Array<Record<string, string | number | boolean>> }
  | { kind: 'choices'; options: AgUiOption[]; multi?: boolean }
  | { kind: 'confirm'; summary?: string; confirmLabel?: string; dismissLabel?: string }
  | { kind: 'inputs'; fields: AgUiFormField[]; submitLabel?: string }
  | { kind: 'keyValues'; body: string; headline?: string; fields: AgUiV2CardField[]; actions?: AgUiV2CardAction[] }
  | { kind: 'message'; body: string; tone?: 'info' | 'success' | 'warning' | 'error' }
  | { kind: 'progress'; value: number; label?: string };

/** A suggestion: the picked component plus why it was picked. */
export interface AgUiV2Suggestion {
  request: AgUiV2ComponentRequest;
  /** Why this kind fits the context (shown in the UI as a hint). */
  reason: string;
  /** 0..1 confidence in the pick (1 = the context maps to exactly one kind). */
  confidence: number;
}

/**
 * Pick the best component for a context. The mapping is total: every
 * context kind has exactly one best component, so the suggester never
 * has to guess — numbers are a chart, rows are a table, choices are
 * options, key-values are a card, inputs are a form, a yes/no
 * question is a confirm, plain text is a message, a fraction is
 * progress.
 */
export function suggestAgUiV2Component(input: {
  componentId: string;
  title: string;
  description?: string;
  runId: string;
  botId?: string;
  blocking?: boolean;
  context: AgUiV2Context;
}): AgUiV2Suggestion {
  const { context } = input;
  const base = {
    componentId: input.componentId,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.blocking === true ? { blocking: true } : {}),
    runId: input.runId,
    ...(input.botId !== undefined ? { botId: input.botId } : {}),
  };
  switch (context.kind) {
    case 'numbers': {
      const chartType = context.chartType ?? (context.series.length === 1 && context.series[0]!.points.length <= 8 ? 'pie' : 'bar');
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'chart', props: { chartType, series: context.series, ...(context.xLabel ? { xLabel: context.xLabel } : {}), ...(context.yLabel ? { yLabel: context.yLabel } : {}) } },
          input.runId, input.botId,
        ),
        reason: `Numeric series (${context.series.length} series) read best as a ${chartType} chart.`,
        confidence: 1,
      };
    }
    case 'rows':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'table', props: { columns: context.columns, rows: context.rows } },
          input.runId, input.botId,
        ),
        reason: `Tabular data (${context.rows.length} rows, ${context.columns.length} columns) reads best as a table.`,
        confidence: 1,
      };
    case 'choices':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'options', props: { options: context.options, ...(context.multi === true ? { multi: true } : {}) } },
          input.runId, input.botId,
        ),
        reason: `A choice between ${context.options.length} options reads best as an options list.`,
        confidence: 1,
      };
    case 'confirm':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'confirm', props: { ...(context.summary ? { summary: context.summary } : {}), ...(context.confirmLabel ? { confirmLabel: context.confirmLabel } : {}), ...(context.dismissLabel ? { dismissLabel: context.dismissLabel } : {}) } },
          input.runId, input.botId,
        ),
        reason: 'A yes/no decision reads best as a confirm card.',
        confidence: 1,
      };
    case 'inputs':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'form', props: { fields: context.fields, ...(context.submitLabel ? { submitLabel: context.submitLabel } : {}) } },
          input.runId, input.botId,
        ),
        reason: `Collecting ${context.fields.length} fields reads best as a form.`,
        confidence: 1,
      };
    case 'keyValues':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'card', props: { body: context.body, ...(context.headline ? { headline: context.headline } : {}), fields: context.fields, ...(context.actions ? { actions: context.actions } : {}) } },
          input.runId, input.botId,
        ),
        reason: `A summary with ${context.fields.length} key values reads best as a card.`,
        confidence: 1,
      };
    case 'message':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'message', props: { body: context.body, ...(context.tone ? { tone: context.tone } : {}) } },
          input.runId, input.botId,
        ),
        reason: 'Plain text reads best as a message.',
        confidence: 1,
      };
    case 'progress':
      return {
        request: validateAgUiV2Request(
          { ...base, kind: 'progress', props: { value: context.value, ...(context.label ? { label: context.label } : {}) } },
          input.runId, input.botId,
        ),
        reason: 'A fraction done reads best as a progress bar.',
        confidence: 1,
      };
  }
}

/**
 * Downgrade a request to the closest kind the client can render.
 * Data-preserving fallbacks only: chart -> table (same numbers as
 * rows), card -> message (same text), table -> message (rows as
 * lines), progress -> message (value as text). Interactive kinds
 * have no fallback — losing the question would lose the answer.
 */
export function negotiateAgUiV2(
  request: AgUiV2ComponentRequest,
  capabilities: AgUiV2ClientCapabilities,
): AgUiV2Negotiation {
  const kinds = new Set(capabilities.kinds);
  const interactive = capabilities.interactive !== false;
  if (kinds.has(request.kind)) {
    if ((request.kind === 'confirm' || request.kind === 'options' || request.kind === 'form' || request.kind === 'card') && !interactive) {
      return { renderable: false, reason: `Client cannot interact with "${request.kind}" (interactive=false).` };
    }
    return { renderable: true, effective: request };
  }
  const fallback = (to: AgUiV2ComponentKind, reason: string, props: AgUiComponentProps): AgUiV2Negotiation => ({
    renderable: true,
    effective: { ...request, kind: to, props: props as AgUiV2ComponentProps },
    fallbackApplied: { from: request.kind, to, reason },
  });
  if (request.kind === 'chart') {
    const chart = request.props as AgUiV2ChartProps;
    const columns: AgUiTableColumn[] = [
      { key: 'label', label: 'Label' },
      ...chart.series.map((s) => ({ key: s.name, label: s.name })),
    ];
    const labels = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p.label)))];
    const rows = labels.map((label) => {
      const row: Record<string, string | number | boolean> = { label };
      for (const s of chart.series) {
        const point = s.points.find((p) => p.label === label);
        row[s.name] = point ? point.value : '';
      }
      return row;
    });
    return fallback('table', `Client cannot render "chart"; downgraded to a table with the same numbers.`, { columns, rows });
  }
  if (request.kind === 'card') {
    const card = request.props as AgUiV2CardProps;
    const lines = [card.body, ...(card.fields ?? []).map((f) => `${f.label}: ${f.value}`)].join('\n');
    return fallback('message', `Client cannot render "card"; downgraded to a message with the same text.`, { body: lines, tone: 'info' });
  }
  if (request.kind === 'table') {
    const table = request.props as import('./genui').AgUiTableProps;
    const lines = table.rows
      .map((row) => table.columns.map((c) => `${c.label}: ${String(row[c.key] ?? '')}`).join(' · '))
      .join('\n');
    return fallback('message', `Client cannot render "table"; downgraded to a message with the same rows.`, { body: lines, tone: 'info' });
  }
  if (request.kind === 'progress') {
    const progress = request.props as import('./genui').AgUiProgressProps;
    const pct = Math.round(progress.value * 100);
    return fallback('message', `Client cannot render "progress"; downgraded to a message with the same value.`, {
      body: `${progress.label ?? 'Progress'}: ${pct}%`,
      tone: 'info',
    });
  }
  return { renderable: false, reason: `Client cannot render "${request.kind}" and there is no safe fallback.` };
}

/** Validate a response to a v2 component (card/chart here, v1 delegated). */
export function validateAgUiV2Response(
  data: Record<string, unknown>,
  request: AgUiV2ComponentRequest,
): { action: string; response: Record<string, unknown> } {
  if (request.kind !== 'card' && request.kind !== 'chart') {
    const v1: AgUiComponentRequest = { ...request, kind: request.kind as AgUiComponentKind, props: request.props as AgUiComponentProps };
    const result = validateGenerativeUiResponse(data, v1);
    return { action: result.action ?? 'submit', response: result.response };
  }
  const action = data['action'];
  if (typeof action !== 'string' || action.length === 0) {
    fail('Generative UI v2 response needs an "action" string.');
  }
  if (request.kind === 'chart') {
    if (action !== 'dismiss' && action !== 'acknowledge') {
      fail('Generative UI v2 chart responses only accept "dismiss" or "acknowledge".');
    }
    return { action, response: {} };
  }
  const card = request.props as AgUiV2CardProps;
  const allowed = new Set([...(card.actions ?? []).map((a) => a.id), 'dismiss']);
  if (!allowed.has(action)) {
    fail(`Generative UI v2 card action "${action}" is not one of ${[...allowed].join(', ')}.`);
  }
  return { action, response: { action } };
}

/**
 * V2 registry: v1 kinds live in the v1 registry, card/chart live
 * here, one lifecycle for both. `request()` applies capability
 * negotiation first when capabilities are given.
 */
export class AgUiV2Registry {
  private readonly v1: AgUiGenerativeUiRegistry;
  private readonly v2 = new Map<string, AgUiV2ComponentRecord>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : 10 * 60_000;
    // The v1 registry owns its own TTL; keep them aligned.
    this.v1 = new AgUiGenerativeUiRegistry({ ttlMs: this.ttlMs });
  }

  get size(): number {
    return this.v1.size + this.v2.size;
  }

  request(request: AgUiV2ComponentRequest, capabilities?: AgUiV2ClientCapabilities): AgUiV2ComponentRecord {
    const negotiated = capabilities ? negotiateAgUiV2(request, capabilities) : { renderable: true, effective: request };
    if (!negotiated.renderable || !negotiated.effective) {
      throw new AgUiV2Error(negotiated.reason ?? `Component "${request.componentId}" is not renderable for this client.`);
    }
    const effective = negotiated.effective;
    if (effective.kind !== 'card' && effective.kind !== 'chart') {
      const v1request: AgUiComponentRequest = {
        ...effective,
        kind: effective.kind as AgUiComponentKind,
        props: effective.props as AgUiComponentProps,
      };
      const record = this.v1.request(v1request);
      return {
        request: effective,
        status: record.status,
        requestedAt: record.requestedAt,
        ...(negotiated.fallbackApplied ? { fallback: negotiated.fallbackApplied } : {}),
      };
    }
    const record: AgUiV2ComponentRecord = {
      request: effective,
      status: 'requested',
      requestedAt: new Date().toISOString(),
      ...(negotiated.fallbackApplied ? { fallback: negotiated.fallbackApplied } : {}),
    };
    this.v2.set(effective.componentId, record);
    return record;
  }

  get(componentId: string): AgUiV2ComponentRecord | undefined {
    const v2 = this.v2.get(componentId);
    if (v2) return v2;
    const v1 = this.v1.get(componentId);
    if (!v1) return undefined;
    return {
      request: { ...v1.request, props: v1.request.props as AgUiV2ComponentProps },
      status: v1.status,
      requestedAt: v1.requestedAt,
      ...(v1.response ? { response: v1.response } : {}),
      ...(v1.action ? { action: v1.action } : {}),
      ...(v1.answeredAt ? { answeredAt: v1.answeredAt } : {}),
    };
  }

  pendingForRun(runId: string): AgUiV2ComponentRecord[] {
    const v1 = this.v1.pendingForRun(runId).map((r) => ({
      request: { ...r.request, props: r.request.props as AgUiV2ComponentProps },
      status: r.status,
      requestedAt: r.requestedAt,
    }));
    const v2 = [...this.v2.values()]
      .filter((c) => c.request.runId === runId && c.status === 'requested')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return [...v1, ...v2].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  forRun(runId: string): AgUiV2ComponentRecord[] {
    const v1 = this.v1.forRun(runId).map((r) => ({
      request: { ...r.request, props: r.request.props as AgUiV2ComponentProps },
      status: r.status,
      requestedAt: r.requestedAt,
      ...(r.response ? { response: r.response } : {}),
      ...(r.action ? { action: r.action } : {}),
      ...(r.answeredAt ? { answeredAt: r.answeredAt } : {}),
    }));
    const v2 = [...this.v2.values()]
      .filter((c) => c.request.runId === runId)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return [...v1, ...v2].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  answer(componentId: string, data: Record<string, unknown>): AgUiV2ComponentRecord {
    const v2 = this.v2.get(componentId);
    if (v2) {
      if (v2.status !== 'requested') {
        fail(`Generative UI v2 component "${componentId}" is already ${v2.status}.`);
      }
      const validated = validateAgUiV2Response(data, v2.request);
      v2.status = validated.action === 'dismiss' ? 'dismissed' : 'answered';
      v2.response = validated.response;
      v2.action = validated.action;
      v2.answeredAt = new Date().toISOString();
      return v2;
    }
    const v1 = this.v1.answer(componentId, data);
    const record = this.get(componentId);
    if (!record) throw new AgUiV2Error(`No generative UI v2 component with id "${componentId}".`);
    void v1;
    return record;
  }

  dismiss(componentId: string): AgUiV2ComponentRecord {
    const v2 = this.v2.get(componentId);
    if (v2) {
      if (v2.status !== 'requested') {
        fail(`Generative UI v2 component "${componentId}" is already ${v2.status}.`);
      }
      v2.status = 'dismissed';
      v2.action = 'dismiss';
      v2.answeredAt = new Date().toISOString();
      return v2;
    }
    this.v1.dismiss(componentId);
    const record = this.get(componentId);
    if (!record) throw new AgUiV2Error(`No generative UI v2 component with id "${componentId}".`);
    return record;
  }

  /** Expire pending components older than the TTL (both stores). */
  expire(now = Date.now()): AgUiV2ComponentRecord[] {
    const expired: AgUiV2ComponentRecord[] = [];
    for (const record of this.v1.expire(now)) {
      const mapped = this.get(record.request.componentId);
      if (mapped) expired.push(mapped);
    }
    for (const record of this.v2.values()) {
      if (record.status !== 'requested') continue;
      if (now - Date.parse(record.requestedAt) > this.ttlMs) {
        record.status = 'expired';
        record.action = 'expired';
        record.answeredAt = new Date().toISOString();
        expired.push(record);
      }
    }
    return expired;
  }

  clearRun(runId: string): void {
    this.v1.clearRun(runId);
    for (const [id, record] of [...this.v2.entries()]) {
      if (record.request.runId === runId && record.status !== 'requested') this.v2.delete(id);
    }
  }

  clearAll(): void {
    this.v1.clearAll();
    this.v2.clear();
  }
}

/** A v2 request as Markdown (for logs / the run transcript). */
export function agUiV2RequestMarkdown(request: AgUiV2ComponentRequest): string {
  const lines = [`### ${request.title} (${request.kind})`];
  if (request.description) lines.push(request.description);
  if (request.kind === 'card') {
    const card = request.props as AgUiV2CardProps;
    if (card.headline) lines.push(`**${card.headline}**`);
    lines.push(card.body);
    for (const f of card.fields ?? []) lines.push(`- ${f.label}: ${f.value}`);
    if (card.actions) lines.push(`Actions: ${card.actions.map((a) => a.label).join(' | ')}`);
  } else if (request.kind === 'chart') {
    const chart = request.props as AgUiV2ChartProps;
    lines.push(`Chart (${chart.chartType}):`);
    for (const s of chart.series) {
      lines.push(`- ${s.name}: ${s.points.map((p) => `${p.label}=${p.value}`).join(', ')}`);
    }
  } else {
    lines.push(`Props: ${JSON.stringify(request.props)}`);
  }
  if (request.blocking) lines.push('(blocking — the run waits for an answer)');
  return lines.join('\n');
}

/** One-line summary of a v2 registry. */
export function agUiV2Summary(records: AgUiV2ComponentRecord[]): string {
  const byStatus = new Map<string, number>();
  for (const r of records) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const parts = [...byStatus.entries()].map(([k, v]) => `${v} ${k}`);
  return `AG-UI v2: ${records.length} components (${parts.join(', ') || 'none'})`;
}
