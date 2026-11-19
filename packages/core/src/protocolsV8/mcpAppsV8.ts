/**
 * Protocols v8 — MCP Apps host (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 1): MCP Apps
 * (`io.modelcontextprotocol/ui`, the first official MCP
 * extension, GA in spec 2026-07-28) lets a tool declare UI
 * through `_meta.ui.resourceUri` pointing at a `ui://`
 * resource. The host fetches the HTML
 * (`text/html;profile=mcp-app`) and renders it in a
 * sandboxed iframe; the UI calls back into the server's tools.
 * The host builds the CSP from the domains the resource
 * declares; domains outside that list are blocked.
 *
 * This module is open-bot's own host implementation, written
 * from that description:
 *
 *   - `McpV8AppResourceRegistry`: holds `ui://` resources
 *     (HTML + declared domains + declared tool-call-back
 *     targets). A resource whose HTML references a domain it
 *     did NOT declare is refused at registration time.
 *   - `McpV8AppHost`: validates a tool's UI declaration,
 *     renders a resource into a sandbox descriptor (iframe
 *     `sandbox` attribute + CSP header value + blocked-domain
 *     report), and validates UI-to-tool call-backs (origin
 *     resource, target tool allow-list, argument size).
 *   - Validation is structural, not a browser: the host
 *     never executes the HTML. It rejects external scripts,
 *     inline event-handler attributes, `javascript:` URLs,
 *     forms posting off-domain, and any `<script src>` that
 *     is not on the declared-domain list. A resource that
 *     passes validation is safe to hand to a real iframe.
 *
 * No code, text or asset from any other repo is copied here.
 * No DOM, no network: the host works on strings only.
 */

/** Error raised by the MCP Apps host. */
export class McpV8AppsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV8AppsError';
    this.code = code;
  }
}

/** The MIME profile an MCP Apps resource must carry. */
export const MCP_V8_APP_MIME_TYPE = 'text/html;profile=mcp-app' as const;
/** Resource URI scheme for MCP Apps UI. */
export const MCP_V8_APP_URI_SCHEME = 'ui://' as const;
/** Max HTML bytes per app resource (default 512 KiB). */
export const MCP_V8_APP_MAX_HTML_BYTES = 512 * 1024;
/** Max declared domains per app resource. */
export const MCP_V8_APP_MAX_DOMAINS = 16;
/** Max call-back arguments size in bytes. */
export const MCP_V8_APP_MAX_CALLBACK_BYTES = 64 * 1024;

/** A `ui://` app resource, as registered by a server. */
export interface McpV8AppResource {
  /** Resource URI, e.g. `ui://weather-card/main`. */
  uri: string;
  /** Human-readable name. */
  name: string;
  /** HTML document (must be a full document or a fragment with one root). */
  html: string;
  /** MIME type (must be `text/html;profile=mcp-app`). */
  mimeType: string;
  /**
   * Domains the resource declares it needs (hostnames, no
   * scheme, no path, e.g. `cdn.example.com`). The CSP is
   * built from exactly this list; anything else is blocked.
   */
  domains: string[];
  /**
   * Tool names the UI may call back into (allow-list). An
   * empty list means the UI may call no tool.
   */
  allowedTools: string[];
  /** Optional description for the UI / discovery. */
  description?: string;
  /** Optional tool the resource belongs to. */
  toolName?: string;
}

/** Result of registering a resource. */
export interface McpV8AppRegistration {
  uri: string;
  name: string;
  domains: string[];
  allowedTools: string[];
  htmlBytes: number;
  /** Domains referenced by the HTML that were NOT declared (empty when clean). */
  undeclaredDomains: string[];
}

/** HTML validation problems found by the host. */
export interface McpV8AppValidation {
  /** True when the HTML may be rendered. */
  ok: boolean;
  /** Blocking problems (render refused while any exist). */
  problems: string[];
  /** Non-blocking warnings (render allowed, host should log). */
  warnings: string[];
  /** External domains referenced by the HTML. */
  referencedDomains: string[];
  /** External script sources referenced. */
  externalScripts: string[];
}

/** Extract hostnames from `src` / `href` / `action` / `url(` references in HTML. */
export function mcpV8AppReferencedDomains(html: string): string[] {
  const out = new Set<string>();
  const patterns: RegExp[] = [
    /(?:src|href|action)\s*=\s*["']https?:\/\/([^/"'\s?#]+)/gi,
    /url\(\s*["']?https?:\/\/([^/"')\s?#]+)/gi,
    /@import\s+["']https?:\/\/([^/"'\s?#]+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const host = (m[1] ?? '').toLowerCase();
      if (host.length > 0) out.add(host);
    }
  }
  return [...out].sort();
}

/** Extract external `<script src>` URLs from HTML. */
export function mcpV8AppExternalScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1] ?? '';
    if (/^https?:\/\//i.test(src)) out.push(src);
  }
  return out;
}

/** True when the hostname is the declared domain or a subdomain of it. */
export function mcpV8DomainMatches(declared: string, host: string): boolean {
  const d = declared.toLowerCase().replace(/^\*\./, '');
  const h = host.toLowerCase();
  if (h === d) return true;
  return h.endsWith(`.${d}`);
}

/** True when the host is covered by any declared domain. */
export function mcpV8DomainAllowed(declared: readonly string[], host: string): boolean {
  return declared.some((d) => mcpV8DomainMatches(d, host));
}

/**
 * Validate app HTML structurally. Rejects: external `<script
 * src>` (scripts may only be inline and must not exfiltrate —
 * inline scripts are allowed but warned), inline event-handler
 * attributes (`onclick=` …), `javascript:` URLs, forms whose
 * action leaves the declared domains, and `<iframe>` / `<object>`
 * / `<embed>` elements (nested browsing contexts are not part
 * of the app surface). Returns problems + warnings; the caller
 * decides whether warnings block rendering (the host does not
 * block on warnings, only on problems).
 */
export function validateMcpV8AppHtml(
  html: string,
  declaredDomains: readonly string[],
): McpV8AppValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  const referencedDomains = mcpV8AppReferencedDomains(html);
  const externalScripts = mcpV8AppExternalScripts(html);
  if (externalScripts.length > 0) {
    problems.push(
      `External script(s) are not allowed in MCP Apps UI: ${externalScripts.join(', ')}. Inline scripts only, or declare the domain and inline the code.`,
    );
  }
  const handlerRe = /\son\w+\s*=/i;
  if (handlerRe.test(html)) {
    problems.push('Inline event-handler attributes (onclick=, onload=, …) are not allowed in MCP Apps UI; use addEventListener in an inline script.');
  }
  if (/javascript\s*:/i.test(html)) {
    problems.push('javascript: URLs are not allowed in MCP Apps UI.');
  }
  if (/<\s*(iframe|object|embed)\b/i.test(html)) {
    problems.push('Nested browsing contexts (<iframe>, <object>, <embed>) are not allowed in MCP Apps UI.');
  }
  const formRe = /<form\b[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html)) !== null) {
    const action = fm[1] ?? '';
    if (/^https?:\/\//i.test(action)) {
      const host = action.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0]?.toLowerCase() ?? '';
      if (!mcpV8DomainAllowed(declaredDomains, host)) {
        problems.push(`Form action "${action}" posts to a domain that is not declared (${host}).`);
      }
    }
  }
  for (const host of referencedDomains) {
    if (!mcpV8DomainAllowed(declaredDomains, host)) {
      problems.push(`HTML references domain "${host}" which is not in the resource-declared domains (${declaredDomains.join(', ') || 'none'}).`);
    }
  }
  if (/<script\b/i.test(html)) {
    warnings.push('Inline <script> is present: the host sandbox must forbid top-level navigation and the script may only call back through the approved bridge.');
  }
  if (/fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(/i.test(html)) {
    warnings.push('HTML uses fetch/XHR/WebSocket/EventSource: network access is limited to the CSP connect-src list (the declared domains).');
  }
  if (!/<!doctype html>/i.test(html) && !/<html[\s>]/i.test(html)) {
    warnings.push('HTML is a fragment, not a full document: the host wraps it in a document shell before rendering.');
  }
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    referencedDomains,
    externalScripts,
  };
}

/** Options for the app resource registry. */
export interface McpV8AppRegistryOptions {
  /** Max HTML bytes per resource (default 512 KiB). */
  maxHtmlBytes?: number;
  /** Max declared domains per resource (default 16). */
  maxDomains?: number;
}

/**
 * Registry of `ui://` app resources. Registration validates
 * the HTML and refuses resources that reference undeclared
 * domains or carry forbidden constructs — a bad resource never
 * reaches the host.
 */
export class McpV8AppResourceRegistry {
  private resources = new Map<string, McpV8AppResource>();
  private maxHtmlBytes: number;
  private maxDomains: number;

  constructor(options: McpV8AppRegistryOptions = {}) {
    this.maxHtmlBytes = options.maxHtmlBytes ?? MCP_V8_APP_MAX_HTML_BYTES;
    this.maxDomains = options.maxDomains ?? MCP_V8_APP_MAX_DOMAINS;
  }

  /** Number of registered app resources. */
  size(): number {
    return this.resources.size;
  }

  /** Registered `ui://` URIs (sorted). */
  uris(): string[] {
    return [...this.resources.keys()].sort();
  }

  /** Get one resource (undefined when missing). */
  get(uri: string): McpV8AppResource | undefined {
    const found = this.resources.get(uri);
    return found === undefined ? undefined : { ...found, domains: [...found.domains], allowedTools: [...found.allowedTools] };
  }

  /** True when the URI is registered. */
  has(uri: string): boolean {
    return this.resources.has(uri);
  }

  /** Unregister a resource (false when missing). */
  unregister(uri: string): boolean {
    return this.resources.delete(uri);
  }

  /** Resources belonging to one tool (sorted by URI). */
  resourcesForTool(toolName: string): McpV8AppResource[] {
    return [...this.resources.values()]
      .filter((r) => r.toolName === toolName)
      .sort((a, b) => (a.uri < b.uri ? -1 : 1))
      .map((r) => ({ ...r, domains: [...r.domains], allowedTools: [...r.allowedTools] }));
  }

  /** Register (or replace) an app resource. Throws McpV8AppsError when invalid. */
  register(resource: McpV8AppResource): McpV8AppRegistration {
    const problems = validateMcpV8AppResource(resource, this.maxHtmlBytes, this.maxDomains);
    if (problems.length > 0) {
      throw new McpV8AppsError('invalid-app-resource', `App resource "${resource.uri}" is invalid: ${problems.join('; ')}`);
    }
    const validation = validateMcpV8AppHtml(resource.html, resource.domains);
    if (!validation.ok) {
      throw new McpV8AppsError('invalid-app-html', `App resource "${resource.uri}" HTML is refused: ${validation.problems.join('; ')}`);
    }
    this.resources.set(resource.uri, {
      ...resource,
      domains: [...resource.domains],
      allowedTools: [...resource.allowedTools],
    });
    return {
      uri: resource.uri,
      name: resource.name,
      domains: [...resource.domains],
      allowedTools: [...resource.allowedTools],
      htmlBytes: Buffer.byteLength(resource.html, 'utf-8'),
      undeclaredDomains: [],
    };
  }
}

/** Structural validation of an app resource (before HTML validation). */
export function validateMcpV8AppResource(
  resource: McpV8AppResource,
  maxHtmlBytes: number = MCP_V8_APP_MAX_HTML_BYTES,
  maxDomains: number = MCP_V8_APP_MAX_DOMAINS,
): string[] {
  const problems: string[] = [];
  if (typeof resource.uri !== 'string' || !resource.uri.startsWith(MCP_V8_APP_URI_SCHEME)) {
    problems.push(`App resource uri must start with "ui://" (got "${resource.uri}").`);
  } else if (resource.uri.length <= 'ui://'.length) {
    problems.push('App resource uri must name a resource after "ui://".');
  }
  if (typeof resource.name !== 'string' || resource.name.trim().length === 0) {
    problems.push('App resource needs a non-empty name.');
  }
  if (typeof resource.html !== 'string' || resource.html.length === 0) {
    problems.push('App resource needs non-empty HTML.');
  } else if (Buffer.byteLength(resource.html, 'utf-8') > maxHtmlBytes) {
    problems.push(`App resource HTML is ${Buffer.byteLength(resource.html, 'utf-8')} bytes (max ${maxHtmlBytes}).`);
  }
  if (resource.mimeType !== MCP_V8_APP_MIME_TYPE) {
    problems.push(`App resource mimeType must be "${MCP_V8_APP_MIME_TYPE}" (got "${resource.mimeType}").`);
  }
  if (!Array.isArray(resource.domains)) {
    problems.push('App resource domains must be an array of hostnames.');
  } else {
    if (resource.domains.length > maxDomains) {
      problems.push(`App resource declares ${resource.domains.length} domains (max ${maxDomains}).`);
    }
    for (const d of resource.domains) {
      if (typeof d !== 'string' || d.length === 0 || d.includes('/') || d.includes(':') || d.includes(' ')) {
        problems.push(`Declared domain "${d}" is not a bare hostname (no scheme, path, port or spaces).`);
      }
    }
  }
  if (!Array.isArray(resource.allowedTools)) {
    problems.push('App resource allowedTools must be an array of tool names.');
  } else {
    for (const t of resource.allowedTools) {
      if (typeof t !== 'string' || t.length === 0) problems.push('allowedTools must contain non-empty tool names.');
    }
  }
  return problems;
}

/** A tool's UI declaration, as the host sees it. */
export interface McpV8ToolUiDeclarationInput {
  /** Tool name. */
  toolName: string;
  /** UI resource URI from `_meta.ui.resourceUri`. */
  resourceUri: string;
  /** Optional size hints. */
  preferredWidth?: number;
  preferredHeight?: number;
}

/** What the host hands to the renderer for one app. */
export interface McpV8AppRenderDescriptor {
  /** Resource URI rendered. */
  uri: string;
  /** Tool the UI belongs to. */
  toolName: string;
  /** iframe `sandbox` attribute value. */
  sandbox: string;
  /** CSP header value the host must apply to the iframe document. */
  csp: string;
  /** Domains the CSP allows (exactly the declared domains). */
  allowedDomains: string[];
  /** Domains referenced by the HTML but blocked (always empty — registration refuses them). */
  blockedDomains: string[];
  /** Size hints from the tool declaration. */
  preferredWidth?: number;
  preferredHeight?: number;
  /** Validation warnings the host should log. */
  warnings: string[];
}

/** The iframe sandbox flags applied to every MCP Apps render. */
export const MCP_V8_APP_SANDBOX = 'allow-scripts allow-same-origin' as const;

/**
 * Build the CSP for one app resource from its declared
 * domains. Everything defaults to `'none'`; scripts are
 * inline-only (`'unsafe-inline'` — external scripts are
 * refused at registration); images / styles / connections
 * are limited to the declared domains; no plugins, no
 * top-level navigation, no form posts off-domain.
 */
export function buildMcpV8AppCsp(resource: McpV8AppResource): string {
  const domains = resource.domains.length > 0
    ? resource.domains.map((d) => `https://${d}`).join(' ')
    : "'none'";
  const self = "'self'";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${self}`,
    `style-src 'unsafe-inline' ${self} ${domains}`,
    `img-src ${self} ${domains} data:`,
    `font-src ${self} ${domains}`,
    `connect-src ${self} ${domains}`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action ${self} ${domains}`,
    'sandbox allow-scripts allow-same-origin',
  ].join('; ');
}

/** A UI-to-tool call-back message from the rendered app. */
export interface McpV8AppCallback {
  /** Resource URI the call-back comes from (the iframe origin). */
  resourceUri: string;
  /** Tool the UI wants to call. */
  tool: string;
  /** Arguments for the tool. */
  arguments?: Record<string, unknown>;
}

/** Result of validating one call-back. */
export interface McpV8AppCallbackCheck {
  ok: boolean;
  /** Blocking problems (call refused while any exist). */
  problems: string[];
}

/**
 * Validate a UI-to-tool call-back: the resource must be
 * registered, the tool must be on the resource's allow-list,
 * and the arguments must fit the size budget. The host calls
 * this before dispatching the tool — the UI never calls a
 * tool directly.
 */
export function validateMcpV8AppCallback(
  registry: McpV8AppResourceRegistry,
  callback: McpV8AppCallback,
  maxBytes: number = MCP_V8_APP_MAX_CALLBACK_BYTES,
): McpV8AppCallbackCheck {
  const problems: string[] = [];
  const resource = registry.get(callback.resourceUri);
  if (resource === undefined) {
    problems.push(`Call-back from unknown app resource "${callback.resourceUri}".`);
    return { ok: false, problems };
  }
  if (typeof callback.tool !== 'string' || callback.tool.length === 0) {
    problems.push('Call-back needs a non-empty tool name.');
    return { ok: false, problems };
  }
  if (!resource.allowedTools.includes(callback.tool)) {
    problems.push(`App "${callback.resourceUri}" may not call tool "${callback.tool}" (allowed: ${resource.allowedTools.join(', ') || 'none'}).`);
  }
  const args = callback.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    problems.push('Call-back arguments must be an object.');
  } else {
    const bytes = Buffer.byteLength(JSON.stringify(args), 'utf-8');
    if (bytes > maxBytes) {
      problems.push(`Call-back arguments are ${bytes} bytes (max ${maxBytes}).`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Host options. */
export interface McpV8AppHostOptions {
  /** Max call-back arguments size in bytes (default 64 KiB). */
  maxCallbackBytes?: number;
}

/**
 * MCP Apps host (mini): validates a tool's UI declaration,
 * renders a registered resource into a sandbox descriptor
 * (sandbox attribute + CSP), and validates UI call-backs.
 * The host never executes HTML and never opens a network
 * connection; it produces the descriptor a real renderer
 * (Electron iframe, desktop panel) consumes.
 */
export class McpV8AppHost {
  private registry: McpV8AppResourceRegistry;
  private maxCallbackBytes: number;
  private renders = 0;
  private blockedCallbacks = 0;

  constructor(registry: McpV8AppResourceRegistry, options: McpV8AppHostOptions = {}) {
    this.registry = registry;
    this.maxCallbackBytes = options.maxCallbackBytes ?? MCP_V8_APP_MAX_CALLBACK_BYTES;
  }

  /** How many apps were rendered. */
  renderCount(): number {
    return this.renders;
  }

  /** How many call-backs were blocked. */
  blockedCallbackCount(): number {
    return this.blockedCallbacks;
  }

  /**
   * Validate a tool's UI declaration against the registry:
   * the resource must exist and belong to (or be shared with)
   * the tool. Returns the resource.
   */
  resolveUi(declaration: McpV8ToolUiDeclarationInput): McpV8AppResource {
    const resource = this.registry.get(declaration.resourceUri);
    if (resource === undefined) {
      throw new McpV8AppsError(
        'ui-resource-missing',
        `Tool "${declaration.toolName}" declares UI resource "${declaration.resourceUri}" which is not registered.`,
      );
    }
    if (resource.toolName !== undefined && resource.toolName !== declaration.toolName) {
      throw new McpV8AppsError(
        'ui-resource-tool-mismatch',
        `UI resource "${declaration.resourceUri}" belongs to tool "${resource.toolName}", not "${declaration.toolName}".`,
      );
    }
    return resource;
  }

  /**
   * Render a tool's UI into a sandbox descriptor. Throws
   * McpV8AppsError when the declaration or the HTML is invalid.
   */
  render(declaration: McpV8ToolUiDeclarationInput): McpV8AppRenderDescriptor {
    const resource = this.resolveUi(declaration);
    const validation = validateMcpV8AppHtml(resource.html, resource.domains);
    if (!validation.ok) {
      throw new McpV8AppsError(
        'invalid-app-html',
        `App resource "${resource.uri}" HTML is refused at render time: ${validation.problems.join('; ')}`,
      );
    }
    this.renders += 1;
    const descriptor: McpV8AppRenderDescriptor = {
      uri: resource.uri,
      toolName: declaration.toolName,
      sandbox: MCP_V8_APP_SANDBOX,
      csp: buildMcpV8AppCsp(resource),
      allowedDomains: [...resource.domains],
      blockedDomains: [],
      warnings: [...validation.warnings],
    };
    if (declaration.preferredWidth !== undefined) descriptor.preferredWidth = declaration.preferredWidth;
    if (declaration.preferredHeight !== undefined) descriptor.preferredHeight = declaration.preferredHeight;
    return descriptor;
  }

  /**
   * Validate one UI call-back. Returns the check; when the
   * check fails the host must NOT dispatch the tool and must
   * count the block.
   */
  checkCallback(callback: McpV8AppCallback): McpV8AppCallbackCheck {
    const check = validateMcpV8AppCallback(this.registry, callback, this.maxCallbackBytes);
    if (!check.ok) this.blockedCallbacks += 1;
    return check;
  }
}

/**
 * Build the `_meta.ui` declaration a tool carries (server-side
 * helper): validates the shape before the tool is registered.
 */
export function buildMcpV8ToolUi(
  resourceUri: string,
  preferredWidth?: number,
  preferredHeight?: number,
): { resourceUri: string; preferredWidth?: number; preferredHeight?: number } {
  if (typeof resourceUri !== 'string' || !resourceUri.startsWith(MCP_V8_APP_URI_SCHEME)) {
    throw new McpV8AppsError(
      'invalid-ui-uri',
      `MCP Apps UI resourceUri must start with "ui://" (got "${resourceUri}").`,
    );
  }
  if (preferredWidth !== undefined && (!Number.isInteger(preferredWidth) || preferredWidth <= 0)) {
    throw new McpV8AppsError('invalid-ui-size', 'preferredWidth must be a positive integer.');
  }
  if (preferredHeight !== undefined && (!Number.isInteger(preferredHeight) || preferredHeight <= 0)) {
    throw new McpV8AppsError('invalid-ui-size', 'preferredHeight must be a positive integer.');
  }
  const out: { resourceUri: string; preferredWidth?: number; preferredHeight?: number } = { resourceUri };
  if (preferredWidth !== undefined) out.preferredWidth = preferredWidth;
  if (preferredHeight !== undefined) out.preferredHeight = preferredHeight;
  return out;
}
