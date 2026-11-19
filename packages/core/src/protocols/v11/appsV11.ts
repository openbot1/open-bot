/**
 * Protocols v11 — MCP Apps UI extension (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): MCP Apps is a formal
 * UI extension in MCP 2.0 under the namespace
 * `io.modelcontextprotocol/ui`. An app is an HTML resource
 * the host renders in a sandboxed iframe; the UI talks to
 * the MCP server only through the host, over JSON-RPC 2.0,
 * and the host arbitrates every call. No code, text or asset
 * from any other repo is copied here.
 *
 * What this module owns:
 *  - App resource validation: `ui://` URIs only, `text/html`
 *    mime type, a declared sandbox attribute set, no
 *    top-level navigation, no inline `javascript:` links.
 *  - CSP building from declared domains only (no wildcard
 *    fallbacks, no `unsafe-inline` scripts).
 *  - UI bridge message validation (`ui/initialize`,
 *    `ui/tool-call`, `ui/notify`, `ui/close`) — the host
 *    rejects anything else before it reaches a tool.
 *  - `McpV11AppSession`: open / initialize / call / notify
 *    / close with a host-side audit log. The session never
 *    executes HTML itself; rendering is the host's job.
 */

import { randomUUID } from 'node:crypto';
import { MCP_V11_UI_EXTENSION } from './versionsV11';

/** The UI extension namespace (re-exported for callers). */
export const MCP_V11_UI_NAMESPACE = MCP_V11_UI_EXTENSION;

/** An MCP App resource descriptor. */
export interface McpV11AppResource {
  uri: string;
  mimeType: string;
  /** HTML source (the host renders it; this module never executes it). */
  html?: string;
  /** Sandbox attribute tokens the app requests. */
  sandbox?: string[];
  /** Domains the app may load resources from. */
  allowedDomains?: string[];
  /** Human-readable title. */
  title?: string;
}

/** Sandbox tokens a v11 app may request. */
export const MCP_V11_APP_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
] as const;

/** Tokens that are never granted (they would break the sandbox). */
export const MCP_V11_APP_FORBIDDEN_SANDBOX_TOKENS = [
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-modals',
] as const;

/** Validate an app resource. Returns problems (empty = valid). */
export function validateMcpV11AppResource(resource: unknown): string[] {
  const problems: string[] = [];
  if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) {
    return ['app resource must be an object.'];
  }
  const r = resource as Record<string, unknown>;
  if (typeof r.uri !== 'string' || !r.uri.startsWith('ui://')) {
    problems.push('app resource uri must start with "ui://".');
  }
  if (r.mimeType !== 'text/html') {
    problems.push('app resource mimeType must be "text/html".');
  }
  if (r.sandbox !== undefined) {
    if (!Array.isArray(r.sandbox) || r.sandbox.some((t) => typeof t !== 'string')) {
      problems.push('app resource sandbox must be an array of strings.');
    } else {
      for (const token of r.sandbox as string[]) {
        if ((MCP_V11_APP_FORBIDDEN_SANDBOX_TOKENS as readonly string[]).includes(token)) {
          problems.push(`sandbox token "${token}" is forbidden: it would let the app escape its frame.`);
        } else if (!(MCP_V11_APP_SANDBOX_TOKENS as readonly string[]).includes(token)) {
          problems.push(`sandbox token "${token}" is not a known v11 sandbox token.`);
        }
      }
      if (!(r.sandbox as string[]).includes('allow-scripts')) {
        problems.push('sandbox must include "allow-scripts" (an app without scripts cannot call the bridge).');
      }
    }
  }
  if (r.allowedDomains !== undefined) {
    if (!Array.isArray(r.allowedDomains) || r.allowedDomains.some((d) => typeof d !== 'string')) {
      problems.push('app resource allowedDomains must be an array of strings.');
    } else {
      for (const domain of r.allowedDomains as string[]) {
        if (domain.includes('*') || domain.includes(' ') || domain.includes('/')) {
          problems.push(`allowed domain "${domain}" must be a bare host (no wildcard, path or space).`);
        }
      }
    }
  }
  if (typeof r.html === 'string') {
    if (/javascript\s*:/i.test(r.html)) problems.push('app html must not contain javascript: links.');
    if (/<\s*script[^>]*\s+src\s*=\s*["']https?:\/\//i.test(r.html)) {
      problems.push('app html must not load scripts from remote URLs (scripts must be inline or same-origin).');
    }
  }
  return problems;
}

/** Build a Content-Security-Policy for an app, from its declared domains only. */
export function buildMcpV11AppCsp(resource: Pick<McpV11AppResource, 'allowedDomains'>): string {
  const domains = (resource.allowedDomains ?? []).filter(Boolean);
  const sources = ['\'self\'', ...domains.map((d) => `https://${d}`)].join(' ');
  return [
    'default-src \'none\'',
    `script-src ${sources}`,
    `style-src ${sources}`,
    `img-src ${sources} data:`,
    `connect-src ${sources}`,
    'frame-ancestors \'none\'',
    'base-uri \'none\'',
    'form-action \'none\'',
  ].join('; ');
}

/** A bridge message from the app iframe to the host. */
export interface McpV11UiMessage {
  jsonrpc: '2.0';
  method: 'ui/initialize' | 'ui/tool-call' | 'ui/notify' | 'ui/close';
  params?: Record<string, unknown>;
  id?: number | string;
}

/** Validate a UI bridge message. Returns problems (empty = valid). */
export function validateMcpV11UiMessage(message: unknown): string[] {
  const problems: string[] = [];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return ['UI message must be an object.'];
  }
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') problems.push('UI message jsonrpc must be "2.0".');
  const allowed = ['ui/initialize', 'ui/tool-call', 'ui/notify', 'ui/close'];
  if (typeof m.method !== 'string' || !allowed.includes(m.method)) {
    problems.push(`UI message method must be one of: ${allowed.join(', ')}.`);
    return problems;
  }
  if (m.method === 'ui/tool-call') {
    const params = m.params as Record<string, unknown> | undefined;
    if (!params || typeof params.tool !== 'string' || !params.tool) {
      problems.push('ui/tool-call params.tool is required.');
    }
    if (params && params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null)) {
      problems.push('ui/tool-call params.arguments must be an object when present.');
    }
  }
  if (m.method === 'ui/initialize') {
    const params = m.params as Record<string, unknown> | undefined;
    if (!params || typeof params.appUri !== 'string' || !params.appUri.startsWith('ui://')) {
      problems.push('ui/initialize params.appUri must be a ui:// URI.');
    }
  }
  return problems;
}

/** One audit entry for an app session. */
export interface McpV11AppAuditEntry {
  atMs: number;
  kind: 'open' | 'initialize' | 'tool-call' | 'notify' | 'close' | 'rejected';
  detail: string;
}

/** Session states. */
export type McpV11AppSessionStatus = 'opened' | 'initialized' | 'closed';

/** A host-side app session (the host renders the HTML; this only arbitrates). */
export class McpV11AppSession {
  readonly id: string;
  readonly resource: McpV11AppResource;
  readonly csp: string;
  status: McpV11AppSessionStatus = 'opened';
  readonly audit: McpV11AppAuditEntry[] = [];
  /** Tool calls the host allowed through (for audit + tests). */
  readonly allowedCalls: Array<{ tool: string; atMs: number }> = [];

  constructor(resource: McpV11AppResource) {
    const problems = validateMcpV11AppResource(resource);
    if (problems.length > 0) {
      throw new Error('Invalid app resource: ' + problems.join(' '));
    }
    this.id = `app-${randomUUID()}`;
    this.resource = resource;
    this.csp = buildMcpV11AppCsp(resource);
    this.audit.push({ atMs: Date.now(), kind: 'open', detail: `Opened ${resource.uri}.` });
  }

  /** Handle one bridge message; returns the host's answer. */
  handle(message: McpV11UiMessage): { ok: boolean; result?: Record<string, unknown>; error?: string } {
    const problems = validateMcpV11UiMessage(message);
    if (problems.length > 0) {
      this.audit.push({ atMs: Date.now(), kind: 'rejected', detail: problems.join(' ') });
      return { ok: false, error: problems.join(' ') };
    }
    if (this.status === 'closed') {
      this.audit.push({ atMs: Date.now(), kind: 'rejected', detail: 'Session is closed.' });
      return { ok: false, error: 'Session is closed.' };
    }
    switch (message.method) {
      case 'ui/initialize':
        this.status = 'initialized';
        this.audit.push({ atMs: Date.now(), kind: 'initialize', detail: `Initialized ${String((message.params ?? {}).appUri ?? '')}.` });
        return { ok: true, result: { sessionId: this.id, csp: this.csp } };
      case 'ui/tool-call': {
        const params = (message.params ?? {}) as Record<string, unknown>;
        const tool = String(params.tool);
        this.allowedCalls.push({ tool, atMs: Date.now() });
        this.audit.push({ atMs: Date.now(), kind: 'tool-call', detail: `Allowed tool call "${tool}" (host arbitrates execution).` });
        return { ok: true, result: { tool, queued: true, note: 'The host executes the tool call; the UI never calls the server directly.' } };
      }
      case 'ui/notify':
        this.audit.push({ atMs: Date.now(), kind: 'notify', detail: String((message.params ?? {}).message ?? '') });
        return { ok: true, result: { acknowledged: true } };
      case 'ui/close':
        this.status = 'closed';
        this.audit.push({ atMs: Date.now(), kind: 'close', detail: 'Closed by the app.' });
        return { ok: true, result: { closed: true } };
      default:
        return { ok: false, error: `Unknown UI method "${String((message as unknown as Record<string, unknown>).method)}".` };
    }
  }

  /** Host-side close (same as the app asking, but recorded as host-initiated). */
  close(): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.audit.push({ atMs: Date.now(), kind: 'close', detail: 'Closed by the host.' });
  }
}
