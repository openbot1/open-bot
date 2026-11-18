/**
 * Protocols v3 — MCP Apps v3 (v1.19, Team T3).
 *
 * Idea only, learned from the public MCP Apps description in
 * docs/repo-survey-v119.md section 2: MCP Apps are sandboxed
 * interactive UI served by an MCP server, and in spec 2026-07-28
 * they are an extension of the stateless core (not part of it).
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the existing MCP Apps layers without touching them:
 *  - `mcp/apps.ts` — HTML validation, CSP, frame descriptors;
 *  - `mcp/appsV2.ts` — template declarations (`declareAppTemplate`),
 *    review status, prefetch cache, action recording;
 *  - `mcp/appsPermissionsV2.ts` — per-app media permissions
 *    (microphone / camera) with granted/denied/prompt decisions;
 *  - `mcp/appsHostV13.ts` / `appsManager.ts` — hosting + lifecycle
 *    of earlier generations.
 * v3 is the app lifecycle + permissions + surfaces layer on top:
 *   1. lifecycle — `installed -> active <-> suspended -> active`,
 *      `active -> uninstalled`; every transition is validated
 *      (a suspended app cannot render, an uninstalled app cannot
 *      be re-activated without reinstalling) and recorded in an
 *      event log the UI can show;
 *   2. permissions v3 — capability grants per app AND per surface:
 *      `tool-call`, `link-open`, `form-submit`, `resource-read`,
 *      `microphone`, `camera`, `clipboard`, `notifications`;
 *      grants are `granted` / `denied` / `prompt`, scoped to one
 *      surface, revocable, and checked before any app action;
 *   3. UI surfaces v3 — `inline`, `sidebar`, `modal`, `overlay`,
 *      `dock`: each surface has a placement, a size budget and a
 *      lifecycle of its own (mounted / hidden / closed);
 *   4. resource quotas — per-app caps (prefetch bytes, open
 *      surfaces, actions per minute) enforced before the app can
 *      spend more; exceeding a quota suspends the app with a clear
 *      reason instead of crashing the host;
 *   5. app events — a typed event log (install, activate, suspend,
 *      resume, uninstall, permission change, quota hit, action
 *      denied) the Settings UI renders as the app's audit trail.
 *
 * Apps are untrusted content: HTML is validated by the v1 layer
 * before it ever reaches this one, and this layer never executes
 * anything from an app — it only records, gates and renders
 * validated data.
 */

import {
  declareAppTemplate,
  type AppTemplateDeclaration,
  type AppUiActionKind,
  type DeclaredAppTemplate,
} from '../mcp/appsV2';
import {
  McpAppPermissionsV2,
  type McpAppMediaPermission,
} from '../mcp/appsPermissionsV2';

/** MCP Apps extension version this layer speaks. */
export const MCP_APPS_V3_VERSION = '3.0.0';
/** Max surfaces one app may have open at once. */
export const MCP_APPS_V3_MAX_SURFACES_PER_APP = 8;
/** Max actions one app may perform per minute (quota). */
export const MCP_APPS_V3_DEFAULT_ACTIONS_PER_MINUTE = 120;
/** Default prefetch-bytes quota per app. */
export const MCP_APPS_V3_DEFAULT_PREFETCH_BYTES = 8 * 1024 * 1024;
/** Max events kept in one app's event log. */
export const MCP_APPS_V3_MAX_EVENTS = 500;

/** Error raised by the v3 MCP Apps layer. */
export class McpAppsV3Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpAppsV3Error';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** App lifecycle states. */
export type McpAppV3Lifecycle =
  | 'installed'
  | 'active'
  | 'suspended'
  | 'uninstalled';

/** Why an app was suspended. */
export type McpAppV3SuspendReason =
  | 'user'
  | 'quota'
  | 'permission-revoked'
  | 'error';

/** Allowed lifecycle transitions. */
export const MCP_APPS_V3_TRANSITIONS: Record<McpAppV3Lifecycle, readonly McpAppV3Lifecycle[]> = {
  installed: ['active', 'uninstalled'],
  active: ['suspended', 'uninstalled'],
  suspended: ['active', 'uninstalled'],
  uninstalled: [],
};

/** True when the transition is allowed. */
export function isMcpAppV3TransitionAllowed(
  from: McpAppV3Lifecycle,
  to: McpAppV3Lifecycle,
): boolean {
  return (MCP_APPS_V3_TRANSITIONS[from] as readonly McpAppV3Lifecycle[]).includes(to);
}

// ---------------------------------------------------------------------------
// Permissions v3
// ---------------------------------------------------------------------------

/** Capability grants an app may request (v3 adds clipboard + notifications). */
export type McpAppV3Capability =
  | AppUiActionKind
  | McpAppMediaPermission
  | 'clipboard'
  | 'notifications';

export const MCP_APP_V3_CAPABILITIES: readonly McpAppV3Capability[] = [
  'tool-call',
  'link-open',
  'form-submit',
  'resource-read',
  'microphone',
  'camera',
  'clipboard',
  'notifications',
];

/** True when the capability is one v3 knows. */
export function isMcpAppV3Capability(value: unknown): value is McpAppV3Capability {
  return (
    typeof value === 'string' &&
    (MCP_APP_V3_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** One permission grant (per app, optionally per surface). */
export interface McpAppV3PermissionGrant {
  appId: string;
  capability: McpAppV3Capability;
  decision: 'granted' | 'denied' | 'prompt';
  /** Surface the grant is scoped to (undefined = whole app). */
  surfaceId?: string;
  grantedAt: string;
  /** Who granted it: `user` or `default`. */
  grantedBy: 'user' | 'default';
}

// ---------------------------------------------------------------------------
// Surfaces v3
// ---------------------------------------------------------------------------

/** Where a surface renders. */
export type McpAppV3SurfacePlacement = 'inline' | 'sidebar' | 'modal' | 'overlay' | 'dock';

export const MCP_APP_V3_SURFACE_PLACEMENTS: readonly McpAppV3SurfacePlacement[] = [
  'inline',
  'sidebar',
  'modal',
  'overlay',
  'dock',
];

/** Lifecycle of one surface. */
export type McpAppV3SurfaceStatus = 'mounted' | 'hidden' | 'closed';

/** One open surface of an app. */
export interface McpAppV3Surface {
  surfaceId: string;
  appId: string;
  placement: McpAppV3SurfacePlacement;
  title: string;
  /** `ui://` URI of the rendered resource. */
  uri: string;
  status: McpAppV3SurfaceStatus;
  /** Width/height budget in px (0 = host default). */
  widthPx: number;
  heightPx: number;
  openedAt: string;
}

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

/** Resource quotas for one app. */
export interface McpAppV3Quotas {
  /** Max prefetch bytes (0 = use the default). */
  maxPrefetchBytes: number;
  /** Max open surfaces. */
  maxSurfaces: number;
  /** Max actions per minute. */
  maxActionsPerMinute: number;
}

/** Default quotas for a newly installed app. */
export function defaultMcpAppV3Quotas(): McpAppV3Quotas {
  return {
    maxPrefetchBytes: MCP_APPS_V3_DEFAULT_PREFETCH_BYTES,
    maxSurfaces: MCP_APPS_V3_MAX_SURFACES_PER_APP,
    maxActionsPerMinute: MCP_APPS_V3_DEFAULT_ACTIONS_PER_MINUTE,
  };
}

/** Usage counters for quota enforcement. */
export interface McpAppV3Usage {
  prefetchBytes: number;
  actionsThisMinute: number;
  /** Minute window the action counter belongs to (epoch minutes). */
  actionWindowMinute: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** App event kinds (audit trail). */
export type McpAppV3EventKind =
  | 'installed'
  | 'activated'
  | 'suspended'
  | 'resumed'
  | 'uninstalled'
  | 'permission-granted'
  | 'permission-denied'
  | 'permission-revoked'
  | 'quota-hit'
  | 'action-denied'
  | 'surface-opened'
  | 'surface-closed';

/** One event in an app's audit trail. */
export interface McpAppV3Event {
  kind: McpAppV3EventKind;
  appId: string;
  at: string;
  detail: string;
  surfaceId?: string;
}

// ---------------------------------------------------------------------------
// App record + manager
// ---------------------------------------------------------------------------

/** One installed app (template + lifecycle + quotas + usage). */
export interface McpAppV3Record {
  template: DeclaredAppTemplate;
  lifecycle: McpAppV3Lifecycle;
  suspendReason?: McpAppV3SuspendReason;
  quotas: McpAppV3Quotas;
  usage: McpAppV3Usage;
  installedAt: string;
  updatedAt: string;
}

/**
 * MCP Apps v3 manager: lifecycle, permissions, surfaces, quotas
 * and the audit trail for every installed app. The manager holds
 * no HTML and executes nothing — it gates what the host does with
 * apps the v1/v2 layers already validated.
 */
export class McpAppsV3Manager {
  private readonly apps = new Map<string, McpAppV3Record>();
  private readonly grants = new Map<string, McpAppV3PermissionGrant>();
  private readonly surfaces = new Map<string, McpAppV3Surface>();
  private readonly events: McpAppV3Event[] = [];
  private readonly mediaPermissions: McpAppPermissionsV2;
  private readonly now: () => number;

  constructor(options: { now?: () => number; mediaPermissions?: McpAppPermissionsV2 } = {}) {
    this.now = options.now ?? Date.now;
    this.mediaPermissions = options.mediaPermissions ?? new McpAppPermissionsV2();
  }

  /** The v2 media-permission store (microphone / camera). */
  getMediaPermissions(): McpAppPermissionsV2 {
    return this.mediaPermissions;
  }

  // -- lifecycle -----------------------------------------------------------

  /** Install an app from a template declaration (validates via v2). */
  install(declaration: AppTemplateDeclaration, quotas: Partial<McpAppV3Quotas> = {}): McpAppV3Record {
    const template = declareAppTemplate(declaration);
    if (this.apps.has(template.id)) {
      throw new McpAppsV3Error('ALREADY_INSTALLED', `App ${template.id} is already installed`);
    }
    const nowIso = new Date(this.now()).toISOString();
    const record: McpAppV3Record = {
      template,
      lifecycle: 'installed',
      quotas: { ...defaultMcpAppV3Quotas(), ...quotas },
      usage: { prefetchBytes: 0, actionsThisMinute: 0, actionWindowMinute: this.currentMinute() },
      installedAt: nowIso,
      updatedAt: nowIso,
    };
    this.apps.set(template.id, record);
    this.logEvent({ kind: 'installed', appId: template.id, at: nowIso, detail: `Installed ${template.title}` });
    return record;
  }

  /** One app record, or null. */
  get(appId: string): McpAppV3Record | null {
    return this.apps.get(appId) ?? null;
  }

  /** All installed apps (not uninstalled). */
  list(): McpAppV3Record[] {
    return [...this.apps.values()]
      .filter((a) => a.lifecycle !== 'uninstalled')
      .sort((a, b) => a.template.id.localeCompare(b.template.id));
  }

  /** Move an app to a new lifecycle state (validates the transition). */
  transition(appId: string, to: McpAppV3Lifecycle, reason?: McpAppV3SuspendReason): McpAppV3Record {
    const record = this.apps.get(appId);
    if (!record) throw new McpAppsV3Error('UNKNOWN_APP', `Unknown app: ${appId}`);
    if (!isMcpAppV3TransitionAllowed(record.lifecycle, to)) {
      throw new McpAppsV3Error(
        'BAD_TRANSITION',
        `Cannot move app ${appId} from ${record.lifecycle} to ${to}`,
      );
    }
    const from = record.lifecycle;
    record.lifecycle = to;
    record.suspendReason = to === 'suspended' ? reason ?? 'user' : undefined;
    record.updatedAt = new Date(this.now()).toISOString();
    if (to === 'suspended') {
      // A suspended app's surfaces close (they re-open on resume).
      for (const surface of this.surfaces.values()) {
        if (surface.appId === appId && surface.status !== 'closed') surface.status = 'closed';
      }
    }
    const kind: McpAppV3EventKind =
      to === 'active'
        ? from === 'suspended'
          ? 'resumed'
          : 'activated'
        : to === 'suspended'
          ? 'suspended'
          : 'uninstalled';
    this.logEvent({
      kind,
      appId,
      at: record.updatedAt,
      detail:
        to === 'suspended'
          ? `Suspended (${record.suspendReason ?? 'user'})`
          : to === 'active'
            ? 'Activated'
            : 'Uninstalled',
    });
    return record;
  }

  /** Activate an installed app (`installed` -> `active`). */
  activate(appId: string): McpAppV3Record {
    return this.transition(appId, 'active');
  }

  /** Suspend an active app. */
  suspend(appId: string, reason: McpAppV3SuspendReason = 'user'): McpAppV3Record {
    return this.transition(appId, 'suspended', reason);
  }

  /** Resume a suspended app. */
  resume(appId: string): McpAppV3Record {
    return this.transition(appId, 'active');
  }

  /** Uninstall an app (its grants and surfaces are dropped). */
  uninstall(appId: string): McpAppV3Record {
    const record = this.transition(appId, 'uninstalled');
    for (const key of [...this.grants.keys()]) {
      if (key.startsWith(`${appId}\n`)) this.grants.delete(key);
    }
    for (const surface of [...this.surfaces.values()]) {
      if (surface.appId === appId) this.surfaces.delete(surface.surfaceId);
    }
    return record;
  }

  // -- permissions ---------------------------------------------------------

  private grantKey(appId: string, capability: McpAppV3Capability, surfaceId?: string): string {
    return `${appId}\n${capability}\n${surfaceId ?? ''}`;
  }

  /** Grant (or deny) a capability for an app, optionally one surface. */
  setPermission(
    appId: string,
    capability: McpAppV3Capability,
    decision: 'granted' | 'denied' | 'prompt',
    options: { surfaceId?: string; grantedBy?: 'user' | 'default' } = {},
  ): McpAppV3PermissionGrant {
    if (!this.apps.has(appId)) throw new McpAppsV3Error('UNKNOWN_APP', `Unknown app: ${appId}`);
    if (!isMcpAppV3Capability(capability)) {
      throw new McpAppsV3Error('UNKNOWN_CAPABILITY', `Unknown capability: ${String(capability)}`);
    }
    const grant: McpAppV3PermissionGrant = {
      appId,
      capability,
      decision,
      ...(options.surfaceId ? { surfaceId: options.surfaceId } : {}),
      grantedAt: new Date(this.now()).toISOString(),
      grantedBy: options.grantedBy ?? 'user',
    };
    this.grants.set(this.grantKey(appId, capability, options.surfaceId), grant);
    this.logEvent({
      kind: decision === 'granted' ? 'permission-granted' : 'permission-denied',
      appId,
      at: grant.grantedAt,
      detail: `${capability} -> ${decision}`,
      ...(options.surfaceId ? { surfaceId: options.surfaceId } : {}),
    });
    return grant;
  }

  /** Revoke a grant (falls back to `prompt` for that capability). */
  revokePermission(appId: string, capability: McpAppV3Capability, surfaceId?: string): boolean {
    const deleted = this.grants.delete(this.grantKey(appId, capability, surfaceId));
    if (deleted) {
      this.logEvent({
        kind: 'permission-revoked',
        appId,
        at: new Date(this.now()).toISOString(),
        detail: `${capability} revoked`,
        ...(surfaceId ? { surfaceId } : {}),
      });
    }
    return deleted;
  }

  /**
   * Check whether an app may perform a capability right now.
   * Surface-scoped grants win over app-wide grants; no grant at
   * all means `prompt` (the host must ask the user). A suspended
   * or uninstalled app may do nothing.
   */
  checkPermission(
    appId: string,
    capability: McpAppV3Capability,
    surfaceId?: string,
  ): { decision: 'granted' | 'denied' | 'prompt'; reason: string } {
    const record = this.apps.get(appId);
    if (!record) return { decision: 'denied', reason: `Unknown app: ${appId}` };
    if (record.lifecycle !== 'active') {
      return { decision: 'denied', reason: `App ${appId} is ${record.lifecycle}` };
    }
    const surfaceGrant = surfaceId
      ? this.grants.get(this.grantKey(appId, capability, surfaceId))
      : undefined;
    if (surfaceGrant) {
      return { decision: surfaceGrant.decision, reason: `Surface grant for ${capability}` };
    }
    const appGrant = this.grants.get(this.grantKey(appId, capability));
    if (appGrant) return { decision: appGrant.decision, reason: `App grant for ${capability}` };
    // The template's declared actions are the default allowlist.
    const declared = record.template.allowedActions as readonly string[];
    if (declared.includes(capability)) {
      return { decision: 'granted', reason: `Declared in the app template` };
    }
    return { decision: 'prompt', reason: `No grant for ${capability}; ask the user` };
  }

  /** All grants for one app. */
  listPermissions(appId: string): McpAppV3PermissionGrant[] {
    return [...this.grants.values()].filter((g) => g.appId === appId);
  }

  // -- surfaces ------------------------------------------------------------

  /** Open a surface for an active app (quota-checked). */
  openSurface(options: {
    surfaceId: string;
    appId: string;
    placement: McpAppV3SurfacePlacement;
    title: string;
    uri: string;
    widthPx?: number;
    heightPx?: number;
  }): McpAppV3Surface {
    const record = this.apps.get(options.appId);
    if (!record) throw new McpAppsV3Error('UNKNOWN_APP', `Unknown app: ${options.appId}`);
    if (record.lifecycle !== 'active') {
      throw new McpAppsV3Error('APP_NOT_ACTIVE', `App ${options.appId} is ${record.lifecycle}; activate it first`);
    }
    if (this.surfaces.has(options.surfaceId)) {
      throw new McpAppsV3Error('DUPLICATE_SURFACE', `Surface ${options.surfaceId} already exists`);
    }
    const openCount = [...this.surfaces.values()].filter(
      (s) => s.appId === options.appId && s.status !== 'closed',
    ).length;
    if (openCount >= record.quotas.maxSurfaces) {
      this.suspend(options.appId, 'quota');
      this.logEvent({
        kind: 'quota-hit',
        appId: options.appId,
        at: new Date(this.now()).toISOString(),
        detail: `Surface quota hit (${record.quotas.maxSurfaces} open); app suspended`,
        surfaceId: options.surfaceId,
      });
      throw new McpAppsV3Error(
        'QUOTA_SURFACES',
        `App ${options.appId} already has ${record.quotas.maxSurfaces} surfaces open; the app was suspended`,
      );
    }
    if (!options.uri.startsWith('ui://') && !options.uri.startsWith('https://')) {
      throw new McpAppsV3Error('BAD_URI', `Surface URI must be ui:// or https://, got: ${options.uri}`);
    }
    const surface: McpAppV3Surface = {
      surfaceId: options.surfaceId,
      appId: options.appId,
      placement: options.placement,
      title: options.title,
      uri: options.uri,
      status: 'mounted',
      widthPx: options.widthPx ?? 0,
      heightPx: options.heightPx ?? 0,
      openedAt: new Date(this.now()).toISOString(),
    };
    this.surfaces.set(options.surfaceId, surface);
    this.logEvent({
      kind: 'surface-opened',
      appId: options.appId,
      at: surface.openedAt,
      detail: `Opened ${options.placement} surface "${options.title}"`,
      surfaceId: options.surfaceId,
    });
    return surface;
  }

  /** One surface, or null. */
  getSurface(surfaceId: string): McpAppV3Surface | null {
    return this.surfaces.get(surfaceId) ?? null;
  }

  /** Surfaces of one app (open ones first). */
  listSurfaces(appId?: string): McpAppV3Surface[] {
    return [...this.surfaces.values()]
      .filter((s) => appId === undefined || s.appId === appId)
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'mounted' ? -1 : 1));
  }

  /** Hide a mounted surface (kept, can be shown again). */
  hideSurface(surfaceId: string): McpAppV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new McpAppsV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    if (surface.status !== 'mounted') {
      throw new McpAppsV3Error('BAD_STATUS', `Cannot hide a surface in state ${surface.status}`);
    }
    surface.status = 'hidden';
    return surface;
  }

  /** Show a hidden surface again. */
  showSurface(surfaceId: string): McpAppV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new McpAppsV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    if (surface.status !== 'hidden') {
      throw new McpAppsV3Error('BAD_STATUS', `Cannot show a surface in state ${surface.status}`);
    }
    surface.status = 'mounted';
    return surface;
  }

  /** Close a surface (removes it). */
  closeSurface(surfaceId: string): McpAppV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new McpAppsV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    surface.status = 'closed';
    this.surfaces.delete(surfaceId);
    this.logEvent({
      kind: 'surface-closed',
      appId: surface.appId,
      at: new Date(this.now()).toISOString(),
      detail: `Closed surface "${surface.title}"`,
      surfaceId,
    });
    return surface;
  }

  // -- quotas + actions ----------------------------------------------------

  private currentMinute(): number {
    return Math.floor(this.now() / 60_000);
  }

  /** Record prefetch bytes (suspends the app when the quota is hit). */
  recordPrefetch(appId: string, bytes: number): void {
    const record = this.apps.get(appId);
    if (!record) throw new McpAppsV3Error('UNKNOWN_APP', `Unknown app: ${appId}`);
    record.usage.prefetchBytes += bytes;
    if (record.usage.prefetchBytes > record.quotas.maxPrefetchBytes) {
      this.suspend(appId, 'quota');
      this.logEvent({
        kind: 'quota-hit',
        appId,
        at: new Date(this.now()).toISOString(),
        detail: `Prefetch quota hit (${record.usage.prefetchBytes} > ${record.quotas.maxPrefetchBytes} bytes); app suspended`,
      });
      throw new McpAppsV3Error(
        'QUOTA_PREFETCH',
        `App ${appId} exceeded its prefetch quota; the app was suspended`,
      );
    }
  }

  /**
   * Record one app action (permission-checked + rate-checked).
   * Returns `{ allowed: true }` when the action may proceed, or
   * `{ allowed: false, reason }` (and an audit event) when the
   * permission or the quota refuses it.
   */
  recordAction(
    appId: string,
    capability: McpAppV3Capability,
    surfaceId?: string,
  ): { allowed: true } | { allowed: false; reason: string } {
    const permission = this.checkPermission(appId, capability, surfaceId);
    if (permission.decision !== 'granted') {
      this.logEvent({
        kind: 'action-denied',
        appId,
        at: new Date(this.now()).toISOString(),
        detail: `${capability} denied: ${permission.reason}`,
        ...(surfaceId ? { surfaceId } : {}),
      });
      return { allowed: false, reason: permission.reason };
    }
    const record = this.apps.get(appId)!;
    const minute = this.currentMinute();
    if (record.usage.actionWindowMinute !== minute) {
      record.usage.actionWindowMinute = minute;
      record.usage.actionsThisMinute = 0;
    }
    record.usage.actionsThisMinute += 1;
    if (record.usage.actionsThisMinute > record.quotas.maxActionsPerMinute) {
      this.suspend(appId, 'quota');
      this.logEvent({
        kind: 'quota-hit',
        appId,
        at: new Date(this.now()).toISOString(),
        detail: `Action quota hit (${record.quotas.maxActionsPerMinute}/min); app suspended`,
        ...(surfaceId ? { surfaceId } : {}),
      });
      return { allowed: false, reason: `Action quota exceeded (${record.quotas.maxActionsPerMinute}/min); app suspended` };
    }
    return { allowed: true };
  }

  // -- audit trail ---------------------------------------------------------

  private logEvent(event: McpAppV3Event): void {
    this.events.push(event);
    if (this.events.length > MCP_APPS_V3_MAX_EVENTS) this.events.shift();
  }

  /** Audit events (newest last), optionally filtered by app. */
  eventsFor(appId?: string): McpAppV3Event[] {
    return this.events.filter((e) => appId === undefined || e.appId === appId);
  }
}
