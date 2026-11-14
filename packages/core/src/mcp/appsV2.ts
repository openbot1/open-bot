/**
 * MCP Apps v2 — declare before render (v1.04, Team T2).
 *
 * MCP Apps v1 (`apps.ts`, `appsManager.ts`) validated and rendered
 * HTML a server returned — but the host only learned what an app
 * needs at render time: which resources it fetches, whether anyone
 * reviewed it, and what its UI is allowed to trigger. MCP Apps v2
 * moves that knowledge BEFORE the first render:
 *
 *   - `declareAppTemplate`: a server (or the host, for a built-in
 *     app) declares the UI template up front — its prefetch
 *     resources, cache policy, review status, and the exact list
 *     of actions its UI may initiate. Declaration is validated
 *     (safe prefetch URIs only, bounded cache, known action kinds)
 *     and fingerprinted (SHA-256 over the canonical declaration)
 *     so a tampered template cannot silently replace a reviewed
 *     one.
 *   - `reviewAppTemplate`: a human (or a policy) marks a template
 *     `reviewed` / `approved` / `rejected` with reviewer + time.
 *     Unreviewed templates still render, but the host must show
 *     the warning — `requiresReviewWarning()` says so.
 *   - `AppPrefetchCache`: in-memory cache for prefetched template
 *     resources (TTL + total-bytes cap, no disk — app content is
 *     untrusted and never persisted). The fetcher is injected, so
 *     this module never touches the network itself.
 *   - `recordAppAction` / `recordAppActionDenied`: the audit path
 *     for every UI-initiated action (a button, a form submit, a
 *     link that calls a tool). Who clicked what, which tool ran,
 *     with which (redacted) arguments — written to the same
 *     `McpAuditLog` the rest of MCP uses (`auditLog.ts` redacts
 *     secrets inside `record()`, so callers pass raw values).
 *
 * Ideas only — no code copied from any MCP implementation, SDK,
 * or the Grok Bot / Cursor installers.
 */

import * as crypto from 'node:crypto';

import type { McpAuditEntry, McpAuditLog } from './auditLog';

/** Review state of an app template. */
export type AppReviewStatus = 'unreviewed' | 'reviewed' | 'approved' | 'rejected';

/** Kinds of action an app UI may initiate (closed list). */
export type AppUiActionKind = 'tool-call' | 'link-open' | 'form-submit' | 'resource-read';

/** The closed list of UI action kinds, for validation + UI. */
export const APP_UI_ACTION_KINDS: readonly AppUiActionKind[] = [
  'tool-call',
  'link-open',
  'form-submit',
  'resource-read',
];

/** Cache policy declared for a template's prefetched resources. */
export interface AppCachePolicy {
  /** Seconds a prefetched resource stays fresh (0 = no cache). */
  maxAgeSec: number;
  /** Revalidate with the server after expiry instead of refetching blindly. */
  revalidate?: boolean;
}

/** One resource a template wants prefetched before first render. */
export interface AppPrefetchResource {
  /** URI to fetch — `https://…` on an allowlisted host, or `ui://…` app-local. */
  uri: string;
  /** What the resource is for (shown in the review UI). */
  purpose?: string;
}

/** Input to declare an app template. */
export interface AppTemplateDeclaration {
  /** Stable template id (slug, e.g. `acme-invoice-card`). */
  id: string;
  /** MCP server that serves this template. */
  serverName: string;
  /** Tool whose result carries the app (when any). */
  toolName?: string;
  /** Display title (max 120 chars). */
  title: string;
  /** Resources to prefetch before the first render. */
  prefetch?: AppPrefetchResource[];
  /** Cache policy for prefetched resources. */
  cache?: AppCachePolicy;
  /** Actions the UI may initiate (empty = render-only, no actions). */
  allowedActions?: AppUiActionKind[];
  /** Hosts the template may load media from (in addition to none). */
  allowedHosts?: string[];
}

/** A declared template — the record the host keeps. */
export interface DeclaredAppTemplate extends Required<Omit<AppTemplateDeclaration, 'toolName'>> {
  toolName?: string;
  /** SHA-256 fingerprint of the canonical declaration. */
  fingerprint: string;
  /** Review state (starts `unreviewed`). */
  review: AppReviewStatus;
  /** Who reviewed it (when reviewed / approved / rejected). */
  reviewedBy?: string;
  /** When it was reviewed (ms epoch). */
  reviewedAt?: number;
  /** Reviewer note (why approved / rejected). */
  reviewNote?: string;
  /** When the template was declared (ms epoch). */
  declaredAt: number;
}

/** Error raised when a template declaration is invalid. */
export class AppTemplateError extends Error {
  readonly templateId?: string;
  constructor(message: string, templateId?: string) {
    super(message);
    this.name = 'AppTemplateError';
    if (templateId) this.templateId = templateId;
  }
}

export const APP_TEMPLATE_MAX_PREFETCH = 20;
export const APP_CACHE_MAX_AGE_SEC = 24 * 60 * 60;
export const APP_TEMPLATE_MAX_TITLE = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePrefetchUri(uri: string): boolean {
  if (uri.startsWith('ui://')) return uri.length > 'ui://'.length;
  if (uri.startsWith('https://')) {
    try {
      const parsed = new URL(uri);
      return parsed.hostname.length > 0 && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }
  return false;
}

function canonicalDeclaration(input: AppTemplateDeclaration): Record<string, unknown> {
  return {
    id: input.id,
    serverName: input.serverName,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    title: input.title,
    prefetch: (input.prefetch ?? []).map((r) => ({
      uri: r.uri,
      ...(r.purpose ? { purpose: r.purpose } : {}),
    })),
    cache: {
      maxAgeSec: input.cache?.maxAgeSec ?? 0,
      ...(input.cache?.revalidate ? { revalidate: true } : {}),
    },
    allowedActions: [...(input.allowedActions ?? [])].sort(),
    allowedHosts: [...(input.allowedHosts ?? [])].sort(),
  };
}

/**
 * Validate + record an app template declaration. Throws
 * `AppTemplateError` on the first problem (bad id, empty title,
 * too many prefetches, unsafe prefetch URI, unknown action kind,
 * cache out of range). The returned record is frozen except for
 * its review fields, which only `reviewAppTemplate` changes.
 */
export function declareAppTemplate(
  input: AppTemplateDeclaration,
  options: { nowMs?: number } = {},
): DeclaredAppTemplate {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new AppTemplateError(
      `App template id không hợp lệ: ${JSON.stringify(input.id)} (slug a-z0-9_-, tối đa 64 ký tự).`,
      input.id,
    );
  }
  if (typeof input.serverName !== 'string' || input.serverName.trim().length === 0) {
    throw new AppTemplateError('App template cần serverName.', id);
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0 || title.length > APP_TEMPLATE_MAX_TITLE) {
    throw new AppTemplateError(
      `App template title phải 1..${APP_TEMPLATE_MAX_TITLE} ký tự.`,
      id,
    );
  }
  const prefetch = input.prefetch ?? [];
  if (prefetch.length > APP_TEMPLATE_MAX_PREFETCH) {
    throw new AppTemplateError(
      `App template "${id}" khai quá ${APP_TEMPLATE_MAX_PREFETCH} prefetch resource.`,
      id,
    );
  }
  for (const resource of prefetch) {
    if (!isRecord(resource) || typeof resource.uri !== 'string' || !isSafePrefetchUri(resource.uri)) {
      throw new AppTemplateError(
        `Prefetch URI không an toàn cho template "${id}": ${JSON.stringify((resource as { uri?: unknown } | null)?.uri)} ` +
          `(chỉ https:// không credential hoặc ui://).`,
        id,
      );
    }
  }
  const cache = input.cache ?? { maxAgeSec: 0 };
  if (!Number.isInteger(cache.maxAgeSec) || cache.maxAgeSec < 0 || cache.maxAgeSec > APP_CACHE_MAX_AGE_SEC) {
    throw new AppTemplateError(
      `Cache maxAgeSec của template "${id}" phải là số nguyên 0..${APP_CACHE_MAX_AGE_SEC}.`,
      id,
    );
  }
  const allowedActions = input.allowedActions ?? [];
  for (const action of allowedActions) {
    if (!(APP_UI_ACTION_KINDS as readonly string[]).includes(action)) {
      throw new AppTemplateError(
        `Action không biết cho template "${id}": ${JSON.stringify(action)} (chỉ ${APP_UI_ACTION_KINDS.join(', ')}).`,
        id,
      );
    }
  }
  const allowedHosts = input.allowedHosts ?? [];
  for (const host of allowedHosts) {
    if (typeof host !== 'string' || host.trim().length === 0 || host.includes('/')) {
      throw new AppTemplateError(`allowedHosts không hợp lệ cho template "${id}": ${JSON.stringify(host)}.`, id);
    }
  }
  const canonical = canonicalDeclaration({
    ...input,
    title,
    prefetch,
    cache,
    allowedActions,
    allowedHosts,
  });
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return {
    id,
    serverName: input.serverName,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    title,
    prefetch: prefetch.map((r) => ({ ...r })),
    cache: { ...cache },
    allowedActions: [...allowedActions],
    allowedHosts: [...allowedHosts],
    fingerprint,
    review: 'unreviewed',
    declaredAt: options.nowMs ?? Date.now(),
  };
}

/**
 * Mark a template reviewed / approved / rejected. Returns a new
 * record (the input is not mutated). Approving a template whose
 * fingerprint changed since review is the caller's job — compare
 * `fingerprint` before calling this.
 */
export function reviewAppTemplate(
  template: DeclaredAppTemplate,
  decision: Exclude<AppReviewStatus, 'unreviewed'>,
  reviewer: string,
  options: { note?: string; nowMs?: number } = {},
): DeclaredAppTemplate {
  if (typeof reviewer !== 'string' || reviewer.trim().length === 0) {
    throw new AppTemplateError('Review cần tên reviewer.', template.id);
  }
  return {
    ...template,
    review: decision,
    reviewedBy: reviewer.trim(),
    reviewedAt: options.nowMs ?? Date.now(),
    ...(options.note ? { reviewNote: options.note } : {}),
  };
}

/** True when the host must show a review warning before rendering. */
export function requiresReviewWarning(template: DeclaredAppTemplate): boolean {
  return template.review === 'unreviewed' || template.review === 'rejected';
}

/** True when the template's UI may initiate this kind of action. */
export function appActionAllowed(template: DeclaredAppTemplate, kind: AppUiActionKind): boolean {
  return template.allowedActions.includes(kind);
}

/** One-line summary of a template, for the app list / review UI. */
export function describeAppTemplate(template: DeclaredAppTemplate): string {
  const actions = template.allowedActions.length > 0 ? template.allowedActions.join(', ') : 'chỉ xem';
  return `${template.title} (${template.id}, ${template.serverName}) — review: ${template.review}, ` +
    `prefetch: ${template.prefetch.length}, action: ${actions}, fingerprint ${template.fingerprint.slice(0, 12)}…`;
}

/** One cached prefetched resource. */
export interface CachedPrefetch {
  uri: string;
  body: string;
  bytes: number;
  fetchedAt: number;
  expiresAt: number;
}

/** Statistics of the prefetch cache (for the UI / diagnostics). */
export interface AppPrefetchCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  expired: number;
}

export const APP_PREFETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * In-memory cache for prefetched template resources. TTL comes
 * from the template's cache policy; the total-bytes cap drops the
 * oldest entries first. Nothing is written to disk — prefetched
 * app content is untrusted. The fetcher is injected by the caller
 * (this class never touches the network).
 */
export class AppPrefetchCache {
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CachedPrefetch>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private expired = 0;
  private readonly nowMs: () => number;

  constructor(options: { maxBytes?: number; nowMs?: () => number } = {}) {
    this.maxBytes = Math.max(1024, options.maxBytes ?? APP_PREFETCH_DEFAULT_MAX_BYTES);
    this.nowMs = options.nowMs ?? Date.now;
  }

  private key(templateId: string, uri: string): string {
    return `${templateId}\n${uri}`;
  }

  /** Store a fetched resource (evicts oldest-first past the cap). */
  put(templateId: string, uri: string, body: string, maxAgeSec: number): CachedPrefetch {
    const bytes = new TextEncoder().encode(body).length;
    const now = this.nowMs();
    const entry: CachedPrefetch = {
      uri,
      body,
      bytes,
      fetchedAt: now,
      expiresAt: now + Math.max(0, maxAgeSec) * 1000,
    };
    const key = this.key(templateId, uri);
    const old = this.entries.get(key);
    if (old) this.bytes -= old.bytes;
    this.entries.set(key, entry);
    this.bytes += bytes;
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined || oldestKey === key) break;
      const removed = this.entries.get(oldestKey);
      if (!removed) break;
      this.entries.delete(oldestKey);
      this.bytes -= removed.bytes;
    }
    return { ...entry };
  }

  /** Read a fresh entry, or undefined (counts hit / miss / expiry). */
  get(templateId: string, uri: string): CachedPrefetch | undefined {
    const entry = this.entries.get(this.key(templateId, uri));
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.nowMs() > entry.expiresAt) {
      this.entries.delete(this.key(templateId, uri));
      this.bytes -= entry.bytes;
      this.expired += 1;
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return { ...entry };
  }

  /**
   * Prefetch every resource a template declared, through the
   * injected fetcher. Already-fresh entries are skipped. A
   * failed fetch is recorded in the returned report, not thrown
   * — one dead resource must not kill the whole template.
   */
  async prefetch(
    template: DeclaredAppTemplate,
    fetcher: (uri: string) => Promise<string>,
  ): Promise<{ fetched: string[]; skipped: string[]; failed: { uri: string; error: string }[] }> {
    const fetched: string[] = [];
    const skipped: string[] = [];
    const failed: { uri: string; error: string }[] = [];
    for (const resource of template.prefetch) {
      if (this.get(template.id, resource.uri)) {
        skipped.push(resource.uri);
        continue;
      }
      try {
        const body = await fetcher(resource.uri);
        this.put(template.id, resource.uri, body, template.cache.maxAgeSec);
        fetched.push(resource.uri);
      } catch (err) {
        failed.push({
          uri: resource.uri,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { fetched, skipped, failed };
  }

  /** Drop one entry (e.g. after a template is re-declared). */
  invalidate(templateId: string, uri?: string): void {
    if (uri === undefined) {
      for (const key of [...this.entries.keys()]) {
        if (key.startsWith(`${templateId}\n`)) {
          const removed = this.entries.get(key);
          if (removed) this.bytes -= removed.bytes;
          this.entries.delete(key);
        }
      }
      return;
    }
    const key = this.key(templateId, uri);
    const removed = this.entries.get(key);
    if (removed) {
      this.bytes -= removed.bytes;
      this.entries.delete(key);
    }
  }

  /** Drop everything (server disconnect / template registry reset). */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): AppPrefetchCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      expired: this.expired,
    };
  }
}

/** One UI-initiated action from an MCP App, for the audit trail. */
export interface AppUiAction {
  /** Template the action came from. */
  templateId: string;
  /** Server that serves the template. */
  serverName: string;
  /** Kind of action (must be in the template's allowedActions). */
  kind: AppUiActionKind;
  /** Who triggered it — user id / display name, never a secret. */
  actor: string;
  /** Tool the action runs (for `tool-call`), if any. */
  toolName?: string;
  /** Arguments the action carries (redacted by the audit log). */
  args?: unknown;
  /** Free-form label from the UI (button text, form name). */
  label?: string;
}

/**
 * Audit one UI-initiated app action. The audit entry says who
 * clicked what and which tool ran — the full audit path the Apps
 * v2 contract requires. Returns the entry, or null when no audit
 * log is configured (the action itself still proceeds; audit is
 * best-effort, never a gate).
 */
export function recordAppAction(
  log: McpAuditLog | undefined,
  action: AppUiAction,
  options: { durationMs?: number } = {},
): McpAuditEntry | null {
  if (!log) return null;
  return log.record({
    direction: 'client',
    server: action.serverName,
    method: action.kind === 'tool-call' ? 'tools/call' : `mcp-apps/${action.kind}`,
    ...(action.toolName ? { tool: action.toolName } : {}),
    caller: `mcp-app:${action.templateId}:${action.actor}`,
    args: {
      templateId: action.templateId,
      kind: action.kind,
      ...(action.label ? { label: action.label } : {}),
      ...(action.args !== undefined ? { actionArgs: action.args } : {}),
    },
    resultSummary: `App UI action ${action.kind} từ template ${action.templateId}`,
    outcome: 'ok',
    durationMs: options.durationMs ?? 0,
  });
}

/**
 * Audit a UI-initiated app action the host REFUSED (not in the
 * template's `allowedActions`, or the template is rejected).
 * Denials are audited too — a refused action that leaves no trace
 * is indistinguishable from one that never happened.
 */
export function recordAppActionDenied(
  log: McpAuditLog | undefined,
  action: AppUiAction,
  reason: string,
  options: { durationMs?: number } = {},
): McpAuditEntry | null {
  if (!log) return null;
  return log.record({
    direction: 'client',
    server: action.serverName,
    method: action.kind === 'tool-call' ? 'tools/call' : `mcp-apps/${action.kind}`,
    ...(action.toolName ? { tool: action.toolName } : {}),
    caller: `mcp-app:${action.templateId}:${action.actor}`,
    args: {
      templateId: action.templateId,
      kind: action.kind,
      ...(action.label ? { label: action.label } : {}),
    },
    outcome: 'error',
    errorMessage: `App action bị từ chối: ${reason}`,
    durationMs: options.durationMs ?? 0,
  });
}
