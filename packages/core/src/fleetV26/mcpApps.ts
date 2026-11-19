/**
 * MCP Apps v26 — host-side registry + CSP for `ui://` app resources (v1.39, Team T6).
 *
 * Idea (from the v139 survey §1, MCP spec 2026-07-28 + MCP Apps
 * `io.modelcontextprotocol/ui`): a tool declares UI through
 * `_meta.ui.resourceUri` pointing at a `ui://` resource; the host
 * fetches the HTML and renders it in a sandboxed iframe, and the app
 * calls back into the server's tools. The host builds the CSP from
 * the domains the resource declares; domains OUTSIDE the allowlist
 * are blocked.
 *
 * This module is the HOST side of that contract (the renderer is
 * `McpAppFrame.tsx`, which already sandboxes with `allow-scripts`
 * only and validates session/origin). It owns:
 *
 * - The `ui://` resource registry: uri -> { server, tool, html,
 *   declared domains, allowed tools }. Registration validates the
 *   uri shape, the HTML profile marker, and every declared domain.
 * - The CSP builder: a strict default (`default-src 'none'`) plus
 *   exactly the declared domains for script/style/img/connect — plus
 *   the user's domain allowlist from settings. Nothing else loads.
 * - App settings: Apps on/off, the domain allowlist, and the default
 *   policy (`ask` / `allow` / `deny`) for apps whose server is not
 *   explicitly trusted. Settings are the single place the UI edits.
 * - The message-bridge guard: an inbound app message is accepted
 *   only when its session id + nonce match the session the host
 *   issued AND its requested tool is in the app's allowed list.
 *
 * The HTML itself is validated, not trusted: it must declare the MCP
 * app profile (`text/html;profile=mcp-app`) and must not contain a
 * top-level navigation (`<meta http-equiv="refresh">`, `target="_top"`
 * links, `window.top` escapes are the renderer's job — here we refuse
 * the obvious ones at registration so a bad resource never reaches
 * the frame).
 */

export type FleetV26McpAppPolicy = 'ask' | 'allow' | 'deny';

/** Settings for MCP Apps (edited in the UI settings panel). */
export interface FleetV26McpAppSettings {
  /** Master switch: false = no app renders at all. */
  appsEnabled: boolean;
  /** Extra domains the user allows (beyond each app's declared domains). */
  domainAllowlist: string[];
  /** Default policy for apps from unlisted servers. */
  defaultPolicy: FleetV26McpAppPolicy;
  /** Servers the user explicitly trusts (their apps render without asking). */
  trustedServers: string[];
  /** Servers the user explicitly blocked. */
  blockedServers: string[];
}

/** One registered `ui://` app resource. */
export interface FleetV26McpAppResource {
  /** e.g. `ui://weather-server/current-weather`. */
  uri: string;
  serverId: string;
  toolName: string;
  title: string;
  /** The HTML (must carry the mcp-app profile marker). */
  html: string;
  /** Domains the app declares it loads from (no scheme, no path). */
  declaredDomains: string[];
  /** Tools the app may call back into (allowlist). */
  allowedTools: string[];
  registeredAtMs: number;
}

/** Result of a registry / settings operation. */
export interface FleetV26McpAppOp {
  ok: boolean;
  uri: string;
  message: string;
}

export const FLEET_V26_MCP_APP_URI_RE = /^ui:\/\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
export const FLEET_V26_MCP_APP_PROFILE_MARKER = 'profile=mcp-app';
/** A domain: exact host, or `*.example.com` for subdomains. */
export const FLEET_V26_DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Patterns refused in app HTML at registration. */
const FLEET_V26_HTML_REFUSALS: Array<{ re: RegExp; why: string }> = [
  { re: /<meta[^>]*http-equiv\s*=\s*["']?refresh/i, why: 'meta refresh (top-level navigation)' },
  { re: /target\s*=\s*["']_top["']/i, why: 'target="_top" link' },
  { re: /target\s*=\s*["']_parent["']/i, why: 'target="_parent" link' },
  { re: /window\.top\s*=/i, why: 'window.top assignment' },
  { re: /<script[^>]*\ssrc\s*=\s*["']https?:\/\//i, why: 'remote <script src> (all scripts must be inline or declared-domain)' },
];

/** Default settings (Apps on, empty allowlist, ask-first). */
export function defaultFleetV26McpAppSettings(): FleetV26McpAppSettings {
  return {
    appsEnabled: true,
    domainAllowlist: [],
    defaultPolicy: 'ask',
    trustedServers: [],
    blockedServers: [],
  };
}

/** Validate one domain entry (exact host or `*.host`). */
export function isFleetV26ValidDomain(domain: string): boolean {
  return FLEET_V26_DOMAIN_RE.test(domain.toLowerCase());
}

/** Validate app HTML (profile marker + refusal patterns). */
export function validateFleetV26AppHtml(html: string): { ok: boolean; message: string } {
  if (!html.includes(FLEET_V26_MCP_APP_PROFILE_MARKER)) {
    return { ok: false, message: `App HTML must declare the MCP app profile ("${FLEET_V26_MCP_APP_PROFILE_MARKER}").` };
  }
  for (const r of FLEET_V26_HTML_REFUSALS) {
    if (r.re.test(html)) return { ok: false, message: `App HTML refused: ${r.why}.` };
  }
  return { ok: true, message: 'App HTML is acceptable.' };
}

/**
 * Build the CSP for one app: strict default, then exactly the
 * effective domains (declared + user allowlist) for script / style /
 * image / connect. `frame-ancestors 'none'` + `navigate-to 'none'`
 * keep the app inside its sandbox.
 */
export function buildFleetV26AppCsp(
  resource: FleetV26McpAppResource,
  settings: FleetV26McpAppSettings,
): string {
  const domains = new Set<string>();
  for (const d of resource.declaredDomains) domains.add(d.toLowerCase());
  for (const d of settings.domainAllowlist) domains.add(d.toLowerCase());
  const hosts = [...domains].sort().map((d) => `https://${d}`);
  const src = hosts.length > 0 ? `'self' ${hosts.join(' ')}` : `'self'`;
  return [
    "default-src 'none'",
    `script-src ${src}`,
    `style-src ${src} 'unsafe-inline'`,
    `img-src ${src} data:`,
    `connect-src ${src}`,
    `font-src ${src}`,
    "frame-ancestors 'none'",
    "navigate-to 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Decide whether an app may render (master switch, blocklist, trust, default policy). */
export function decideFleetV26AppRender(
  resource: FleetV26McpAppResource,
  settings: FleetV26McpAppSettings,
): { allowed: boolean; reason: string; needsAsk: boolean } {
  if (!settings.appsEnabled) {
    return { allowed: false, reason: 'MCP Apps are disabled in settings.', needsAsk: false };
  }
  if (settings.blockedServers.includes(resource.serverId)) {
    return { allowed: false, reason: `Server "${resource.serverId}" is blocked in settings.`, needsAsk: false };
  }
  if (settings.trustedServers.includes(resource.serverId)) {
    return { allowed: true, reason: `Server "${resource.serverId}" is trusted.`, needsAsk: false };
  }
  if (settings.defaultPolicy === 'allow') {
    return { allowed: true, reason: 'Default policy is allow.', needsAsk: false };
  }
  if (settings.defaultPolicy === 'deny') {
    return { allowed: false, reason: 'Default policy is deny (server is not trusted).', needsAsk: false };
  }
  return { allowed: false, reason: 'Default policy is ask — needs a user decision.', needsAsk: true };
}

/** Registry of `ui://` app resources + settings. */
export class FleetV26McpAppRegistry {
  private resources = new Map<string, FleetV26McpAppResource>();
  private settings: FleetV26McpAppSettings = defaultFleetV26McpAppSettings();

  /** Current settings (copy). */
  getSettings(): FleetV26McpAppSettings {
    return {
      ...this.settings,
      domainAllowlist: [...this.settings.domainAllowlist],
      trustedServers: [...this.settings.trustedServers],
      blockedServers: [...this.settings.blockedServers],
    };
  }

  /** Replace settings (validates domains + policy). */
  setSettings(next: Partial<FleetV26McpAppSettings>): { ok: boolean; message: string } {
    if (next.defaultPolicy !== undefined && !['ask', 'allow', 'deny'].includes(next.defaultPolicy)) {
      return { ok: false, message: `Unknown default policy "${String(next.defaultPolicy)}".` };
    }
    for (const d of next.domainAllowlist ?? []) {
      if (!isFleetV26ValidDomain(d)) return { ok: false, message: `Domain "${d}" is invalid (use a host like "example.com" or "*.example.com").` };
    }
    this.settings = {
      ...this.settings,
      ...next,
      domainAllowlist: next.domainAllowlist ? [...new Set(next.domainAllowlist.map((d) => d.toLowerCase()))].sort() : this.settings.domainAllowlist,
      trustedServers: next.trustedServers ? [...new Set(next.trustedServers)] : this.settings.trustedServers,
      blockedServers: next.blockedServers ? [...new Set(next.blockedServers)] : this.settings.blockedServers,
    };
    return { ok: true, message: 'MCP Apps settings saved.' };
  }

  /** Register a `ui://` resource (validates uri, HTML, domains). */
  register(
    input: {
      uri: string;
      serverId: string;
      toolName: string;
      title?: string;
      html: string;
      declaredDomains?: string[];
      allowedTools?: string[];
    },
    nowMs: number = Date.now(),
  ): FleetV26McpAppOp {
    if (!FLEET_V26_MCP_APP_URI_RE.test(input.uri)) {
      return { ok: false, uri: input.uri, message: `App uri "${input.uri}" must look like "ui://server/path".` };
    }
    if (this.resources.has(input.uri)) {
      return { ok: false, uri: input.uri, message: `App resource "${input.uri}" is already registered.` };
    }
    if (!input.serverId.trim() || !input.toolName.trim()) {
      return { ok: false, uri: input.uri, message: 'App resource needs a serverId and a toolName.' };
    }
    const htmlCheck = validateFleetV26AppHtml(input.html);
    if (!htmlCheck.ok) return { ok: false, uri: input.uri, message: htmlCheck.message };
    const domains = [...new Set((input.declaredDomains ?? []).map((d) => d.toLowerCase()))].sort();
    for (const d of domains) {
      if (!isFleetV26ValidDomain(d)) {
        return { ok: false, uri: input.uri, message: `Declared domain "${d}" is invalid.` };
      }
    }
    this.resources.set(input.uri, {
      uri: input.uri,
      serverId: input.serverId.trim(),
      toolName: input.toolName.trim(),
      title: (input.title ?? input.toolName).trim(),
      html: input.html,
      declaredDomains: domains,
      allowedTools: [...new Set(input.allowedTools ?? [])].sort(),
      registeredAtMs: nowMs,
    });
    return { ok: true, uri: input.uri, message: `App resource "${input.uri}" registered.` };
  }

  /** One resource (copy) or undefined. */
  get(uri: string): FleetV26McpAppResource | undefined {
    const r = this.resources.get(uri);
    return r ? { ...r, declaredDomains: [...r.declaredDomains], allowedTools: [...r.allowedTools] } : undefined;
  }

  /** All resources, sorted by uri. */
  list(): FleetV26McpAppResource[] {
    return [...this.resources.keys()].sort().map((u) => this.get(u) as FleetV26McpAppResource);
  }

  /** Resources of one server. */
  listByServer(serverId: string): FleetV26McpAppResource[] {
    return this.list().filter((r) => r.serverId === serverId);
  }

  /** Remove a resource. */
  remove(uri: string): boolean {
    return this.resources.delete(uri);
  }

  /** CSP for one resource (null when unknown). */
  cspFor(uri: string): string | null {
    const r = this.resources.get(uri);
    return r ? buildFleetV26AppCsp(r, this.settings) : null;
  }

  /** Render decision for one resource (null when unknown). */
  renderDecision(uri: string): { allowed: boolean; reason: string; needsAsk: boolean } | null {
    const r = this.resources.get(uri);
    return r ? decideFleetV26AppRender(r, this.settings) : null;
  }

  /**
   * Bridge guard: accept an inbound app message only when the
   * session id + nonce match the issued session AND the requested
   * tool is in the app's allowed list.
   */
  checkBridgeMessage(input: {
    uri: string;
    sessionId: string;
    nonce: string;
    expectedSessionId: string;
    expectedNonce: string;
    toolName: string | null;
  }): { ok: boolean; message: string } {
    const r = this.resources.get(input.uri);
    if (!r) return { ok: false, message: `App resource "${input.uri}" is not registered.` };
    if (input.sessionId !== input.expectedSessionId || input.nonce !== input.expectedNonce) {
      return { ok: false, message: 'App message session does not match the issued session — dropped.' };
    }
    if (input.toolName !== null && !r.allowedTools.includes(input.toolName)) {
      return { ok: false, message: `App may not call tool "${input.toolName}" (not in its allowed list).` };
    }
    return { ok: true, message: 'App message accepted.' };
  }

  /** Counts for the panel. */
  counts(): { resources: number; servers: number; domains: number; appsEnabled: boolean; trustedServers: number; blockedServers: number } {
    const servers = new Set(this.list().map((r) => r.serverId));
    const domains = new Set<string>();
    for (const r of this.list()) for (const d of r.declaredDomains) domains.add(d);
    return {
      resources: this.resources.size,
      servers: servers.size,
      domains: domains.size,
      appsEnabled: this.settings.appsEnabled,
      trustedServers: this.settings.trustedServers.length,
      blockedServers: this.settings.blockedServers.length,
    };
  }

  /** JSON round-trip (resources + settings). */
  toJSON(): { resources: FleetV26McpAppResource[]; settings: FleetV26McpAppSettings } {
    return { resources: this.list(), settings: this.getSettings() };
  }

  static fromJSON(data: { resources?: FleetV26McpAppResource[]; settings?: FleetV26McpAppSettings }): FleetV26McpAppRegistry {
    const reg = new FleetV26McpAppRegistry();
    for (const r of data.resources ?? []) {
      if (r && FLEET_V26_MCP_APP_URI_RE.test(r.uri)) {
        reg.resources.set(r.uri, {
          ...r,
          declaredDomains: [...(r.declaredDomains ?? [])],
          allowedTools: [...(r.allowedTools ?? [])],
        });
      }
    }
    if (data.settings) reg.setSettings(data.settings);
    return reg;
  }
}

/** One-line summary for the MCP Apps panel. */
export function summarizeFleetV26McpApps(reg: FleetV26McpAppRegistry): string {
  const c = reg.counts();
  const s = reg.getSettings();
  return (
    `MCP Apps ${c.appsEnabled ? 'enabled' : 'DISABLED'}: ${c.resources} resource(s) from ${c.servers} server(s), ` +
    `${c.domains} declared domain(s); default policy ${s.defaultPolicy}, ` +
    `${c.trustedServers} trusted / ${c.blockedServers} blocked server(s)`
  );
}
