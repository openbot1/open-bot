/**
 * Elicitation, stable (v1.37, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md: the ACP elicitation RFD is now
 * Completed (stable) — an agent asks the user for structured,
 * non-sensitive input either as a form the client renders, or
 * by sending the user to an external URL for an out-of-band
 * flow. The client advertises which modes it supports, and the
 * agent must pick one of the advertised modes (capability
 * negotiation). Elicitation is for non-sensitive input only.
 *
 * This module is the open-bot implementation, built from scratch:
 *   - `ElicitationV6Form` — a structured form: fields with a
 *     schema (kind, required, min/max, pattern, options, default),
 *     validated on submit. Sensitive fields are refused at
 *     creation (`password` / `secret` kinds, or `sensitive: true`).
 *   - `ElicitationV6Manager` — the lifecycle: create (form or
 *     URL mode), submit, cancel, expire, list by session/status.
 *     URL-mode elicitations carry a one-time callback token; the
 *     external flow completes by presenting the token, and the
 *     manager validates the returned values against the same
 *     schema as the form mode.
 *   - Capability advertisement: `advertiseElicitationModes`
 *     builds what a client supports, and
 *     `negotiateElicitationMode` picks the mode for one request
 *     (the agent's preference, intersected with what the client
 *     advertised — form wins ties, since it never leaves the app).
 *
 * No credentials ever flow through elicitation: a field that
 * looks like a secret is refused, and URL-mode values are
 * validated the same way as form values. No code, text or asset
 * from any other repo is copied here.
 */

/** Elicitation modes (stable). */
export type ElicitationV6Mode = 'form' | 'url';
export const ELICITATION_V6_MODES: readonly ElicitationV6Mode[] = ['form', 'url'];

/** Field kinds a structured elicitation form may use. */
export type ElicitationV6FieldKind =
  | 'text'
  | 'long-text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multi-select'
  | 'date';
export const ELICITATION_V6_FIELD_KINDS: readonly ElicitationV6FieldKind[] = [
  'text',
  'long-text',
  'number',
  'boolean',
  'select',
  'multi-select',
  'date',
];

/** Field kinds that are always refused (sensitive input). */
export const ELICITATION_V6_REFUSED_KINDS: readonly string[] = ['password', 'secret', 'token', 'api-key'];

/** One field of a structured elicitation form. */
export interface ElicitationV6Field {
  /** Field id (stable within the form). */
  id: string;
  /** Human-readable label (the renderer translates the label key, never the raw text). */
  label: string;
  kind: ElicitationV6FieldKind;
  required?: boolean;
  /** Placeholder / hint text. */
  hint?: string;
  /** Default value (must itself validate). */
  defaultValue?: string | number | boolean | string[];
  /** Minimum for number fields (inclusive). */
  min?: number;
  /** Maximum for number fields (inclusive). */
  max?: number;
  /** Regex the value must match (text / long-text). */
  pattern?: string;
  /** Minimum length (text / long-text). */
  minLength?: number;
  /** Maximum length (text / long-text). */
  maxLength?: number;
  /** Options for select / multi-select. */
  options?: { value: string; label: string }[];
  /** Marking a field sensitive refuses the whole form. */
  sensitive?: boolean;
}

/** Lifecycle of one elicitation. */
export type ElicitationV6Status = 'pending' | 'submitted' | 'cancelled' | 'expired';
export const ELICITATION_V6_STATUSES: readonly ElicitationV6Status[] = [
  'pending',
  'submitted',
  'cancelled',
  'expired',
];
export function isElicitationV6Terminal(status: ElicitationV6Status): boolean {
  return status !== 'pending';
}

/** One elicitation request (form mode or URL mode). */
export interface ElicitationV6Request {
  elicitationId: string;
  sessionId: string;
  /** User message id this elicitation belongs to, when it has one. */
  messageId?: string;
  mode: ElicitationV6Mode;
  /** Title shown above the form / on the URL page. */
  title: string;
  /** Field schema (form mode) — also the validation schema for URL-mode values. */
  fields: ElicitationV6Field[];
  status: ElicitationV6Status;
  /** Submitted values (field id -> value), once submitted. */
  values?: Record<string, unknown>;
  /** External URL (URL mode only). */
  url?: string;
  /** One-time callback token (URL mode only; never logged with values). */
  callbackToken?: string;
  createdAt: number;
  /** Epoch ms after which the request expires (omit = no expiry). */
  expiresAt?: number;
  submittedAt?: number;
  cancelledAt?: number;
  cancelReason?: string;
}

/** Error raised by elicitation operations. */
export class ElicitationV6Error extends Error {
  readonly code:
    | 'unknown-elicitation'
    | 'not-pending'
    | 'invalid-field'
    | 'sensitive-field'
    | 'validation-failed'
    | 'mode-not-advertised'
    | 'bad-callback-token'
    | 'expired';
  constructor(message: string, code: ElicitationV6Error['code']) {
    super(message);
    this.name = 'ElicitationV6Error';
    this.code = code;
  }
}

export interface ElicitationV6Options {
  /** Clock override (tests). */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: (prefix: string) => string;
  /** Default TTL for elicitations (ms, omit = no expiry). */
  defaultTtlMs?: number;
}

let elicitationV6Counter = 0;
function defaultElicitationV6Id(prefix: string): string {
  elicitationV6Counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${elicitationV6Counter.toString(36)}`;
}

/** One validation problem, per field. */
export interface ElicitationV6ValidationIssue {
  fieldId: string;
  reason: string;
}

/**
 * Validate values against a field schema. Returns the list of
 * issues (empty = valid). Unknown fields are reported, missing
 * required fields are reported, and every type / range / pattern
 * rule is checked.
 */
export function validateElicitationV6Values(
  fields: ElicitationV6Field[],
  values: Record<string, unknown>,
): ElicitationV6ValidationIssue[] {
  const issues: ElicitationV6ValidationIssue[] = [];
  const known = new Set(fields.map((f) => f.id));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) issues.push({ fieldId: key, reason: `Unknown field "${key}".` });
  }
  for (const field of fields) {
    const value = values[field.id];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required) issues.push({ fieldId: field.id, reason: `Field "${field.id}" is required.` });
      continue;
    }
    switch (field.kind) {
      case 'text':
      case 'long-text': {
        if (typeof value !== 'string') {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be a string.` });
          break;
        }
        if (field.minLength !== undefined && value.length < field.minLength) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" needs at least ${field.minLength} character(s).` });
        }
        if (field.maxLength !== undefined && value.length > field.maxLength) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" allows at most ${field.maxLength} character(s).` });
        }
        if (field.pattern !== undefined) {
          let re: RegExp;
          try {
            re = new RegExp(field.pattern);
          } catch {
            issues.push({ fieldId: field.id, reason: `Field "${field.id}" has an invalid pattern.` });
            break;
          }
          if (!re.test(value)) issues.push({ fieldId: field.id, reason: `Field "${field.id}" does not match its required pattern.` });
        }
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be a number.` });
          break;
        }
        if (field.min !== undefined && value < field.min) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be at least ${field.min}.` });
        }
        if (field.max !== undefined && value > field.max) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be at most ${field.max}.` });
        }
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be a boolean.` });
        break;
      }
      case 'select': {
        if (typeof value !== 'string') {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be one of its options.` });
          break;
        }
        if (field.options && !field.options.some((o) => o.value === value)) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" value "${value}" is not one of its options.` });
        }
        break;
      }
      case 'multi-select': {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be an array of option values.` });
          break;
        }
        if (field.options) {
          const bad = (value as string[]).find((v) => !field.options?.some((o) => o.value === v));
          if (bad !== undefined) issues.push({ fieldId: field.id, reason: `Field "${field.id}" value "${bad}" is not one of its options.` });
        }
        break;
      }
      case 'date': {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" must be a date (YYYY-MM-DD).` });
          break;
        }
        const d = new Date(`${value}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
          issues.push({ fieldId: field.id, reason: `Field "${field.id}" is not a real calendar date.` });
        }
        break;
      }
    }
  }
  return issues;
}

/** Validate a field schema itself (before a form is created). */
export function validateElicitationV6Schema(fields: ElicitationV6Field[]): ElicitationV6ValidationIssue[] {
  const issues: ElicitationV6ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.id) {
      issues.push({ fieldId: '', reason: 'Every field needs a non-empty id.' });
      continue;
    }
    if (seen.has(field.id)) issues.push({ fieldId: field.id, reason: `Duplicate field id "${field.id}".` });
    seen.add(field.id);
    if (!ELICITATION_V6_FIELD_KINDS.includes(field.kind)) {
      issues.push({ fieldId: field.id, reason: `Unknown field kind "${field.kind}".` });
    }
    if ((ELICITATION_V6_REFUSED_KINDS as readonly string[]).includes(field.kind)) {
      issues.push({ fieldId: field.id, reason: `Field kind "${field.kind}" is sensitive and refused for elicitation.` });
    }
    if (field.sensitive === true) {
      issues.push({ fieldId: field.id, reason: `Field "${field.id}" is marked sensitive and refused for elicitation.` });
    }
    if (!field.label || !field.label.trim()) {
      issues.push({ fieldId: field.id, reason: `Field "${field.id}" needs a label.` });
    }
    if (field.kind === 'select' || field.kind === 'multi-select') {
      if (!field.options || field.options.length === 0) {
        issues.push({ fieldId: field.id, reason: `Field "${field.id}" needs at least one option.` });
      } else {
        const values = new Set<string>();
        for (const option of field.options) {
          if (!option.value) issues.push({ fieldId: field.id, reason: `Field "${field.id}" has an option with no value.` });
          if (values.has(option.value)) issues.push({ fieldId: field.id, reason: `Field "${field.id}" repeats option value "${option.value}".` });
          values.add(option.value);
        }
      }
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      issues.push({ fieldId: field.id, reason: `Field "${field.id}" has min > max.` });
    }
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
      issues.push({ fieldId: field.id, reason: `Field "${field.id}" has minLength > maxLength.` });
    }
    if (field.pattern !== undefined) {
      try {
        new RegExp(field.pattern);
      } catch {
        issues.push({ fieldId: field.id, reason: `Field "${field.id}" has an invalid regex pattern.` });
      }
    }
    if (field.defaultValue !== undefined) {
      const valueIssues = validateElicitationV6Values([field], { [field.id]: field.defaultValue });
      for (const issue of valueIssues) {
        issues.push({ fieldId: field.id, reason: `Default value is invalid: ${issue.reason}` });
      }
    }
  }
  return issues;
}

/** What a client advertises about elicitation (capability negotiation). */
export interface ElicitationV6Advertisement {
  /** Modes the client can render / handle. */
  modes: ElicitationV6Mode[];
  /** Longest form the client renders (fields); agents should stay under it. */
  maxFields: number;
  /** Whether the client opens external URLs itself (URL mode needs this). */
  canOpenExternalUrl: boolean;
}

/** The default advertisement for open-bot v6 (both modes). */
export function defaultElicitationV6Advertisement(): ElicitationV6Advertisement {
  return { modes: ['form', 'url'], maxFields: 20, canOpenExternalUrl: true };
}

/**
 * Negotiate the elicitation mode for one request: the agent's
 * preference intersected with what the client advertised. Form
 * wins ties (it never leaves the app). Throws when the client
 * advertises no usable mode.
 */
export function negotiateElicitationV6Mode(
  advertised: ElicitationV6Advertisement,
  preferred?: ElicitationV6Mode,
): ElicitationV6Mode {
  const supported = advertised.modes.filter((m) => ELICITATION_V6_MODES.includes(m));
  if (supported.length === 0) {
    throw new ElicitationV6Error('This client advertises no elicitation mode; the agent must not elicit.', 'mode-not-advertised');
  }
  if (preferred !== undefined) {
    if (!supported.includes(preferred)) {
      throw new ElicitationV6Error(
        `Elicitation mode "${preferred}" is not advertised by this client (advertised: ${supported.join(', ') || 'none'}).`,
        'mode-not-advertised',
      );
    }
    if (preferred === 'url' && !advertised.canOpenExternalUrl) {
      throw new ElicitationV6Error('This client cannot open an external URL, so URL-mode elicitation is unavailable.', 'mode-not-advertised');
    }
    return preferred;
  }
  return supported.includes('form') ? 'form' : supported[0] as ElicitationV6Mode;
}

export interface ElicitationV6CreateInput {
  sessionId: string;
  messageId?: string;
  mode: ElicitationV6Mode;
  title: string;
  fields: ElicitationV6Field[];
  /** External URL (URL mode, required). Must be https. */
  url?: string;
  /** TTL override (ms). */
  ttlMs?: number;
  /** What the client advertised (mode must be in it). */
  advertised?: ElicitationV6Advertisement;
}

/**
 * Elicitation lifecycle manager: create (form / URL), submit,
 * cancel, expire. One manager per host; sessions are just ids
 * the host already owns.
 */
export class ElicitationV6Manager {
  private readonly requests = new Map<string, ElicitationV6Request>();
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;
  private readonly defaultTtlMs?: number;

  constructor(options: ElicitationV6Options = {}) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultElicitationV6Id;
    this.defaultTtlMs = options.defaultTtlMs;
  }

  /** Create a form-mode or URL-mode elicitation. Validates the schema and the mode. */
  create(input: ElicitationV6CreateInput): ElicitationV6Request {
    const advertised = input.advertised ?? defaultElicitationV6Advertisement();
    negotiateElicitationV6Mode(advertised, input.mode);
    if (input.fields.length === 0) {
      throw new ElicitationV6Error('An elicitation needs at least one field.', 'invalid-field');
    }
    if (input.fields.length > advertised.maxFields) {
      throw new ElicitationV6Error(
        `This elicitation has ${input.fields.length} fields but the client renders at most ${advertised.maxFields}.`,
        'invalid-field',
      );
    }
    const schemaIssues = validateElicitationV6Schema(input.fields);
    if (schemaIssues.length > 0) {
      const first = schemaIssues[0] as ElicitationV6ValidationIssue;
      const code: ElicitationV6Error['code'] =
        first.reason.includes('sensitive') || first.reason.includes('refused') ? 'sensitive-field' : 'invalid-field';
      throw new ElicitationV6Error(
        `Invalid elicitation schema (${schemaIssues.length} issue(s)): ${schemaIssues.map((i) => `${i.fieldId}: ${i.reason}`).join('; ')}`,
        code,
      );
    }
    if (input.mode === 'url') {
      if (!input.url) throw new ElicitationV6Error('URL-mode elicitation needs a url.', 'invalid-field');
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new ElicitationV6Error(`URL-mode elicitation url "${input.url}" is not a valid URL.`, 'invalid-field');
      }
      if (parsed.protocol !== 'https:') {
        throw new ElicitationV6Error('URL-mode elicitation only opens https URLs.', 'invalid-field');
      }
    }
    const at = this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const request: ElicitationV6Request = {
      elicitationId: this.generateId('elicit6'),
      sessionId: input.sessionId,
      messageId: input.messageId,
      mode: input.mode,
      title: input.title,
      fields: input.fields.map((f) => ({
        ...f,
        options: f.options ? f.options.map((o) => ({ ...o })) : undefined,
      })),
      status: 'pending',
      url: input.mode === 'url' ? input.url : undefined,
      callbackToken: input.mode === 'url' ? this.generateId('elicit6-cb') : undefined,
      createdAt: at,
      expiresAt: ttlMs !== undefined ? at + ttlMs : undefined,
    };
    this.requests.set(request.elicitationId, request);
    return this.copy(request);
  }

  private copy(request: ElicitationV6Request): ElicitationV6Request {
    return {
      ...request,
      fields: request.fields.map((f) => ({ ...f, options: f.options ? f.options.map((o) => ({ ...o })) : undefined })),
      values: request.values ? { ...request.values } : undefined,
    };
  }

  get(elicitationId: string): ElicitationV6Request | undefined {
    const request = this.requests.get(elicitationId);
    return request ? this.copy(request) : undefined;
  }

  require(elicitationId: string): ElicitationV6Request {
    const request = this.requests.get(elicitationId);
    if (!request) throw new ElicitationV6Error(`Unknown elicitation "${elicitationId}".`, 'unknown-elicitation');
    return request;
  }

  /** Expire pending requests whose deadline passed. Returns how many expired. */
  expireOverdue(): number {
    const at = this.now();
    let n = 0;
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.expiresAt !== undefined && at >= request.expiresAt) {
        request.status = 'expired';
        n += 1;
      }
    }
    return n;
  }

  private requirePending(request: ElicitationV6Request): void {
    if (request.status === 'pending' && request.expiresAt !== undefined && this.now() >= request.expiresAt) {
      request.status = 'expired';
    }
    if (request.status === 'expired') {
      throw new ElicitationV6Error(`Elicitation "${request.elicitationId}" has expired.`, 'expired');
    }
    if (request.status !== 'pending') {
      throw new ElicitationV6Error(`Elicitation "${request.elicitationId}" is ${request.status}, not pending.`, 'not-pending');
    }
  }

  /**
   * Submit values for a form-mode elicitation. Validates against
   * the schema; on failure nothing is stored and the issues are
   * returned so the form can show them.
   */
  submit(
    elicitationId: string,
    values: Record<string, unknown>,
  ): { ok: true; request: ElicitationV6Request } | { ok: false; issues: ElicitationV6ValidationIssue[] } {
    const request = this.require(elicitationId);
    this.requirePending(request);
    const issues = validateElicitationV6Values(request.fields, values);
    if (issues.length > 0) return { ok: false, issues };
    request.values = { ...values };
    request.status = 'submitted';
    request.submittedAt = this.now();
    return { ok: true, request: this.copy(request) };
  }

  /** Cancel a pending elicitation (the user declined / walked away). */
  cancel(elicitationId: string, reason?: string): ElicitationV6Request {
    const request = this.require(elicitationId);
    this.requirePending(request);
    request.status = 'cancelled';
    request.cancelledAt = this.now();
    if (reason) request.cancelReason = reason;
    return this.copy(request);
  }

  /**
   * Complete a URL-mode elicitation from the external flow: the
   * flow presents the one-time callback token plus the values.
   * The token is single-use — a second completion with the same
   * token fails. Values are validated against the same schema as
   * the form mode.
   */
  completeByCallback(
    callbackToken: string,
    values: Record<string, unknown>,
  ): { ok: true; request: ElicitationV6Request } | { ok: false; issues: ElicitationV6ValidationIssue[] } {
    const request = [...this.requests.values()].find((r) => r.callbackToken === callbackToken);
    if (!request) {
      throw new ElicitationV6Error('Unknown or already-used elicitation callback token.', 'bad-callback-token');
    }
    this.requirePending(request);
    const issues = validateElicitationV6Values(request.fields, values);
    if (issues.length > 0) return { ok: false, issues };
    request.values = { ...values };
    request.status = 'submitted';
    request.submittedAt = this.now();
    // Single-use token: clear it so it cannot complete twice.
    request.callbackToken = undefined;
    return { ok: true, request: this.copy(request) };
  }

  /** Pending elicitations for a session. */
  pendingForSession(sessionId: string): ElicitationV6Request[] {
    this.expireOverdue();
    return [...this.requests.values()]
      .filter((r) => r.sessionId === sessionId && r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => this.copy(r));
  }

  /** All elicitations, optionally filtered by status / session. */
  list(opts: { sessionId?: string; status?: ElicitationV6Status } = {}): ElicitationV6Request[] {
    this.expireOverdue();
    return [...this.requests.values()]
      .filter((r) => (opts.sessionId === undefined || r.sessionId === opts.sessionId)
        && (opts.status === undefined || r.status === opts.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => this.copy(r));
  }

  /** Summary counts for the UI. */
  summary(): { total: number; pending: number; submitted: number; cancelled: number; expired: number } {
    this.expireOverdue();
    const out = { total: this.requests.size, pending: 0, submitted: 0, cancelled: 0, expired: 0 };
    for (const request of this.requests.values()) {
      out[request.status] += 1;
    }
    return out;
  }
}
