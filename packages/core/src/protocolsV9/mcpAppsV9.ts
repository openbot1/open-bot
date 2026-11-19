/**
 * Protocols v9 — MCP Apps v2: app lifecycle (v1.40, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v140.md (section 5) and the v8 host in
 * `protocolsV8/mcpAppsV8.ts`: v8 renders one `ui://`
 * resource into a sandbox descriptor (iframe sandbox + CSP
 * from declared domains) and validates UI-to-tool call-backs.
 * v9 keeps that render path untouched and adds the missing
 * half — managing the apps once they are open:
 *
 *   - `McpV9AppLifecycleManager`: open / close / reopen /
 *     suspend / resume / focus an app, list apps by state or
 *     tool, count them, and keep an event log. An app that is
 *     closed keeps its descriptor so reopening it is cheap
 *     and re-validates the HTML before it is shown again.
 *   - Panel slots (`left` / `right` / `bottom` / `float`):
 *     where the desktop panel shows the app; moving a slot
 *     never re-renders the app.
 *   - Durable snapshot / restore: the manager serialises to
 *     plain JSON (the host mirrors it to disk); restore
 *     re-validates every app's HTML and drops any app whose
 *     resource is gone or whose HTML no longer passes.
 *
 * No code, text or asset from any other repo is copied here.
 * No DOM, no network: the manager works on descriptors and
 * strings only, exactly like the v8 host.
 */

import {
  McpV8AppHost,
  McpV8AppResourceRegistry,
  validateMcpV8AppHtml,
  type McpV8AppRenderDescriptor,
  type McpV8ToolUiDeclarationInput,
} from '../protocolsV8/mcpAppsV8';
import type { McpV9AppState } from './versionsV9';

/** Error raised by the MCP Apps v2 lifecycle manager. */
export class McpV9AppsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV9AppsError';
    this.code = code;
  }
}

/** Where the desktop panel shows an app. */
export const MCP_V9_APP_SLOTS = ['left', 'right', 'bottom', 'float'] as const;
export type McpV9AppSlot = (typeof MCP_V9_APP_SLOTS)[number];

/** Max apps open at once (default 16; the host may raise it). */
export const MCP_V9_MAX_OPEN_APPS = 16;
/** Max events kept in the lifecycle log. */
export const MCP_V9_MAX_APP_EVENTS = 500;
/** Max closed apps kept for reopen (older ones are pruned). */
export const MCP_V9_MAX_CLOSED_APPS = 64;

/** One lifecycle event, for the panel + audit trail. */
export interface McpV9AppEvent {
  /** Monotonic sequence number. */
  seq: number;
  /** App instance id. */
  appId: string;
  /** What happened. */
  kind: 'opened' | 'closed' | 'reopened' | 'suspended' | 'resumed' | 'focused' | 'slot-moved' | 'callback' | 'failed' | 'pruned';
  /** Milliseconds since epoch. */
  at: number;
  /** Free-form detail (reason, tool name, error). */
  detail?: string;
}

/** One open (or remembered) app instance. */
export interface McpV9AppInstance {
  /** Stable instance id (`app-<n>`, unique per manager). */
  id: string;
  /** `ui://` resource URI. */
  uri: string;
  /** Tool the UI belongs to. */
  toolName: string;
  /** Lifecycle state. */
  state: McpV9AppState;
  /** Panel slot. */
  slot: McpV9AppSlot;
  /** Focus order: higher = more recently focused (0 = never focused). */
  focusOrder: number;
  /** Milliseconds since epoch when opened (first open). */
  openedAt: number;
  /** Milliseconds since epoch of the last state change. */
  lastActiveAt: number;
  /** How many times this instance was rendered. */
  renderCount: number;
  /** How many UI-to-tool call-backs this instance made. */
  callbackCount: number;
  /** How many times this instance was reopened. */
  reopenCount: number;
  /** Why a suspended/failed app stopped (undefined otherwise). */
  reason?: string;
  /** Last render descriptor (undefined while opening/failed before render). */
  descriptor?: McpV8AppRenderDescriptor;
}

/** Serialisable snapshot of one app instance (for restore). */
export interface McpV9AppInstanceSnapshot {
  id: string;
  uri: string;
  toolName: string;
  state: McpV9AppState;
  slot: McpV9AppSlot;
  openedAt: number;
  lastActiveAt: number;
  renderCount: number;
  callbackCount: number;
  reopenCount: number;
  reason?: string;
  preferredWidth?: number;
  preferredHeight?: number;
}

/** Serialisable snapshot of the whole lifecycle manager. */
export interface McpV9AppManagerSnapshot {
  version: 9;
  nextId: number;
  nextFocus: number;
  instances: McpV9AppInstanceSnapshot[];
}

/** Options for the lifecycle manager. */
export interface McpV9AppLifecycleOptions {
  /** Max apps open at once (default 16). */
  maxOpenApps?: number;
  /** Max closed apps kept for reopen (default 64). */
  maxClosedApps?: number;
  /** Max events kept (default 500). */
  maxEvents?: number;
}

/** Input for opening an app (extends the v8 render declaration). */
export interface McpV9OpenAppInput extends McpV8ToolUiDeclarationInput {
  /** Panel slot (default `right`). */
  slot?: McpV9AppSlot;
}

/**
 * MCP Apps v2 lifecycle manager. It owns the v8 host +
 * registry (or borrows the host's) and tracks every app
 * instance from first open until it is pruned. Rendering
 * always goes through the v8 host, so the sandbox + CSP
 * guarantees of v8 apply to every open and reopen.
 */
export class McpV9AppLifecycleManager {
  private host: McpV8AppHost;
  private registry: McpV8AppResourceRegistry;
  private instances = new Map<string, McpV9AppInstance>();
  private events: McpV9AppEvent[] = [];
  private nextId = 1;
  private nextFocus = 1;
  private seq = 1;
  private maxOpenApps: number;
  private maxClosedApps: number;
  private maxEvents: number;

  constructor(
    registry: McpV8AppResourceRegistry,
    host?: McpV8AppHost,
    options: McpV9AppLifecycleOptions = {},
  ) {
    this.registry = registry;
    this.host = host ?? new McpV8AppHost(registry);
    this.maxOpenApps = options.maxOpenApps ?? MCP_V9_MAX_OPEN_APPS;
    this.maxClosedApps = options.maxClosedApps ?? MCP_V9_MAX_CLOSED_APPS;
    this.maxEvents = options.maxEvents ?? MCP_V9_MAX_APP_EVENTS;
  }

  /** The v8 registry this manager renders from. */
  getRegistry(): McpV8AppResourceRegistry {
    return this.registry;
  }

  /** The v8 host this manager renders through. */
  getHost(): McpV8AppHost {
    return this.host;
  }

  /** All instances (any state), newest-opened first. */
  list(state?: McpV9AppState): McpV9AppInstance[] {
    const all = [...this.instances.values()].sort((a, b) => b.openedAt - a.openedAt);
    return (state === undefined ? all : all.filter((i) => i.state === state))
      .map((i) => ({ ...i, descriptor: i.descriptor === undefined ? undefined : { ...i.descriptor } }));
  }

  /** Instances belonging to one tool (any state). */
  listForTool(toolName: string): McpV9AppInstance[] {
    return this.list().filter((i) => i.toolName === toolName);
  }

  /** Open apps, most-recently-focused first. */
  openApps(): McpV9AppInstance[] {
    return this.list('active')
      .sort((a, b) => b.focusOrder - a.focusOrder);
  }

  /** Get one instance (undefined when missing). */
  get(appId: string): McpV9AppInstance | undefined {
    const found = this.instances.get(appId);
    if (found === undefined) return undefined;
    return { ...found, descriptor: found.descriptor === undefined ? undefined : { ...found.descriptor } };
  }

  /** Counts per state + totals. */
  counts(): Record<McpV9AppState, number> & { total: number; open: number } {
    const counts: Record<McpV9AppState, number> = {
      opening: 0,
      active: 0,
      suspended: 0,
      closed: 0,
      failed: 0,
    };
    for (const instance of this.instances.values()) counts[instance.state] += 1;
    return { ...counts, total: this.instances.size, open: counts.active + counts.opening };
  }

  /** The lifecycle event log (oldest first, capped). */
  getEvents(): McpV9AppEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Events for one app (oldest first). */
  eventsFor(appId: string): McpV9AppEvent[] {
    return this.events.filter((e) => e.appId === appId).map((e) => ({ ...e }));
  }

  private log(appId: string, kind: McpV9AppEvent['kind'], detail?: string): void {
    this.events.push({ seq: this.seq, appId, kind, at: Date.now(), detail });
    this.seq += 1;
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  private requireInstance(appId: string): McpV9AppInstance {
    const found = this.instances.get(appId);
    if (found === undefined) {
      throw new McpV9AppsError('app-not-found', `No MCP Apps v2 instance "${appId}".`);
    }
    return found;
  }

  private touch(instance: McpV9AppInstance): void {
    instance.lastActiveAt = Date.now();
  }

  /**
   * Open an app: renders the resource through the v8 host
   * (sandbox + CSP + HTML validation) and tracks the
   * instance as `active`. Refuses when the open-app budget
   * is exhausted — close or suspend an app first.
   */
  open(input: McpV9OpenAppInput): McpV9AppInstance {
    const openCount = this.counts().open;
    if (openCount >= this.maxOpenApps) {
      throw new McpV9AppsError(
        'too-many-open-apps',
        `Cannot open "${input.resourceUri}": ${openCount} apps are already open (max ${this.maxOpenApps}). Close or suspend one first.`,
      );
    }
    const slot: McpV9AppSlot = input.slot ?? 'right';
    if (!((MCP_V9_APP_SLOTS as readonly string[]).includes(slot))) {
      throw new McpV9AppsError('invalid-slot', `Panel slot must be one of ${MCP_V9_APP_SLOTS.join(', ')} (got "${slot}").`);
    }
    const id = `app-${this.nextId}`;
    this.nextId += 1;
    const now = Date.now();
    const instance: McpV9AppInstance = {
      id,
      uri: input.resourceUri,
      toolName: input.toolName,
      state: 'opening',
      slot,
      focusOrder: 0,
      openedAt: now,
      lastActiveAt: now,
      renderCount: 0,
      callbackCount: 0,
      reopenCount: 0,
    };
    this.instances.set(id, instance);
    try {
      const descriptor = this.host.render({
        toolName: input.toolName,
        resourceUri: input.resourceUri,
        preferredWidth: input.preferredWidth,
        preferredHeight: input.preferredHeight,
      });
      instance.descriptor = descriptor;
      instance.renderCount += 1;
      instance.state = 'active';
      instance.focusOrder = this.nextFocus;
      this.nextFocus += 1;
      this.touch(instance);
    } catch (err) {
      instance.state = 'failed';
      instance.reason = (err as Error).message;
      this.touch(instance);
      this.log(id, 'failed', instance.reason);
      throw err;
    }
    this.log(id, 'opened', `${input.toolName} ${input.resourceUri} (slot ${slot})`);
    return { ...instance, descriptor: instance.descriptor === undefined ? undefined : { ...instance.descriptor } };
  }

  /**
   * Close an app. The instance is kept (state `closed`) so
   * it can be reopened; its descriptor is dropped so a
   * reopen always re-renders through the v8 host.
   */
  close(appId: string, reason?: string): McpV9AppInstance {
    const instance = this.requireInstance(appId);
    if (instance.state === 'closed') {
      throw new McpV9AppsError('app-already-closed', `App "${appId}" is already closed.`);
    }
    instance.state = 'closed';
    instance.reason = reason;
    instance.descriptor = undefined;
    instance.focusOrder = 0;
    this.touch(instance);
    this.log(appId, 'closed', reason);
    this.pruneClosed();
    return { ...instance };
  }

  /**
   * Reopen a closed (or suspended) app: re-renders through
   * the v8 host and returns it to `active`. An active app
   * cannot be reopened — close it first.
   */
  reopen(appId: string): McpV9AppInstance {
    const instance = this.requireInstance(appId);
    if (instance.state === 'active' || instance.state === 'opening') {
      throw new McpV9AppsError('app-already-open', `App "${appId}" is already open (state ${instance.state}).`);
    }
    if (instance.state === 'failed') {
      throw new McpV9AppsError('app-failed', `App "${appId}" failed to render (${instance.reason ?? 'unknown reason'}). Fix the resource and open it again.`);
    }
    const openCount = this.counts().open;
    if (openCount >= this.maxOpenApps) {
      throw new McpV9AppsError(
        'too-many-open-apps',
        `Cannot reopen "${appId}": ${openCount} apps are already open (max ${this.maxOpenApps}).`,
      );
    }
    const previous = instance.descriptor;
    try {
      const descriptor = this.host.render({
        toolName: instance.toolName,
        resourceUri: instance.uri,
        preferredWidth: previous?.preferredWidth,
        preferredHeight: previous?.preferredHeight,
      });
      instance.descriptor = descriptor;
      instance.renderCount += 1;
      instance.reopenCount += 1;
      instance.state = 'active';
      instance.reason = undefined;
      instance.focusOrder = this.nextFocus;
      this.nextFocus += 1;
      this.touch(instance);
    } catch (err) {
      instance.state = 'failed';
      instance.reason = (err as Error).message;
      this.touch(instance);
      this.log(appId, 'failed', instance.reason);
      throw err;
    }
    this.log(appId, 'reopened', `${instance.toolName} ${instance.uri}`);
    return { ...instance, descriptor: instance.descriptor === undefined ? undefined : { ...instance.descriptor } };
  }

  /** Suspend an active app (keeps the descriptor; cheap to resume). */
  suspend(appId: string, reason?: string): McpV9AppInstance {
    const instance = this.requireInstance(appId);
    if (instance.state !== 'active') {
      throw new McpV9AppsError('app-not-active', `Only an active app can be suspended (app "${appId}" is ${instance.state}).`);
    }
    instance.state = 'suspended';
    instance.reason = reason;
    instance.focusOrder = 0;
    this.touch(instance);
    this.log(appId, 'suspended', reason);
    return { ...instance, descriptor: instance.descriptor === undefined ? undefined : { ...instance.descriptor } };
  }

  /** Resume a suspended app (re-validates the HTML first). */
  resume(appId: string): McpV9AppInstance {
    const instance = this.requireInstance(appId);
    if (instance.state !== 'suspended') {
      throw new McpV9AppsError('app-not-suspended', `Only a suspended app can be resumed (app "${appId}" is ${instance.state}).`);
    }
    const resource = this.registry.get(instance.uri);
    if (resource === undefined) {
      instance.state = 'failed';
      instance.reason = `Resource "${instance.uri}" is no longer registered.`;
      this.touch(instance);
      this.log(appId, 'failed', instance.reason);
      throw new McpV9AppsError('app-resource-gone', instance.reason);
    }
    const validation = validateMcpV8AppHtml(resource.html, resource.domains);
    if (!validation.ok) {
      instance.state = 'failed';
      instance.reason = `HTML no longer passes validation: ${validation.problems.join('; ')}`;
      this.touch(instance);
      this.log(appId, 'failed', instance.reason);
      throw new McpV9AppsError('invalid-app-html', instance.reason);
    }
    instance.state = 'active';
    instance.reason = undefined;
    instance.focusOrder = this.nextFocus;
    this.nextFocus += 1;
    this.touch(instance);
    this.log(appId, 'resumed', instance.uri);
    return { ...instance, descriptor: instance.descriptor === undefined ? undefined : { ...instance.descriptor } };
  }

  /** Bring an active app to the front (highest focus order). */
  focus(appId: string): McpV9AppInstance {
    const instance = this.requireInstance(appId);
    if (instance.state !== 'active') {
      throw new McpV9AppsError('app-not-active', `Only an active app can be focused (app "${appId}" is ${instance.state}).`);
    }
    instance.focusOrder = this.nextFocus;
    this.nextFocus += 1;
    this.touch(instance);
    this.log(appId, 'focused', instance.uri);
    return { ...instance, descriptor: instance.descriptor === undefined ? undefined : { ...instance.descriptor } };
  }

  /** Move an app to another panel slot (no re-render). */
  moveSlot(appId: string, slot: McpV9AppSlot): McpV9AppInstance {
    const instance = this.requireInstance(appId);
    if (!((MCP_V9_APP_SLOTS as readonly string[]).includes(slot))) {
      throw new McpV9AppsError('invalid-slot', `Panel slot must be one of ${MCP_V9_APP_SLOTS.join(', ')} (got "${slot}").`);
    }
    instance.slot = slot;
    this.touch(instance);
    this.log(appId, 'slot-moved', `slot ${slot}`);
    return { ...instance, descriptor: instance.descriptor === undefined ? undefined : { ...instance.descriptor } };
  }

  /**
   * Record a UI-to-tool call-back from an app instance:
   * validates through the v8 host first; only a passing
   * call-back counts (a blocked one is logged, not counted).
   */
  callback(appId: string, tool: string, args?: Record<string, unknown>): { ok: boolean; problems: string[] } {
    const instance = this.requireInstance(appId);
    if (instance.state !== 'active') {
      return { ok: false, problems: [`App "${appId}" is ${instance.state}; only an active app may call back into tools.`] };
    }
    const check = this.host.checkCallback({ resourceUri: instance.uri, tool, arguments: args });
    if (check.ok) {
      instance.callbackCount += 1;
      this.touch(instance);
      this.log(appId, 'callback', tool);
    }
    return check;
  }

  /** Drop closed apps beyond the retention budget (oldest first). */
  pruneClosed(): number {
    // Tie-break by openedAt then id: two apps closed within the same
    // millisecond share lastActiveAt, and list() is newest-first, so a
    // plain lastActiveAt sort is stable-wrong (it would prune the
    // newest). Deterministic victim: oldest closed, then oldest opened.
    const closed = this.list('closed').sort((a, b) => a.lastActiveAt - b.lastActiveAt || a.openedAt - b.openedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let pruned = 0;
    while (closed.length - pruned > this.maxClosedApps) {
      const victim = closed[pruned];
      if (victim === undefined) break;
      this.instances.delete(victim.id);
      this.log(victim.id, 'pruned', 'closed-app retention budget');
      pruned += 1;
    }
    return pruned;
  }

  /** Serialise the manager (the host mirrors this to disk). */
  snapshot(): McpV9AppManagerSnapshot {
    return {
      version: 9,
      nextId: this.nextId,
      nextFocus: this.nextFocus,
      instances: this.list().map((i) => {
        const snap: McpV9AppInstanceSnapshot = {
          id: i.id,
          uri: i.uri,
          toolName: i.toolName,
          state: i.state === 'opening' ? 'closed' : i.state,
          slot: i.slot,
          openedAt: i.openedAt,
          lastActiveAt: i.lastActiveAt,
          renderCount: i.renderCount,
          callbackCount: i.callbackCount,
          reopenCount: i.reopenCount,
        };
        if (i.reason !== undefined) snap.reason = i.reason;
        if (i.descriptor?.preferredWidth !== undefined) snap.preferredWidth = i.descriptor.preferredWidth;
        if (i.descriptor?.preferredHeight !== undefined) snap.preferredHeight = i.descriptor.preferredHeight;
        return snap;
      }),
    };
  }

  /**
   * Restore a snapshot. Restored apps come back `closed`
   * (or `suspended` when that is what was saved) — never
   * `active`: the host must reopen them, which re-renders
   * through the v8 host. Apps whose resource is gone or
   * whose HTML no longer passes are dropped and reported.
   */
  restore(snapshot: McpV9AppManagerSnapshot): { restored: number; dropped: string[] } {
    if (snapshot.version !== 9 || !Array.isArray(snapshot.instances)) {
      throw new McpV9AppsError('invalid-snapshot', 'MCP Apps v2 snapshot must have version 9 and an instances array.');
    }
    const dropped: string[] = [];
    let restored = 0;
    for (const snap of snapshot.instances) {
      const resource = this.registry.get(snap.uri);
      if (resource === undefined) {
        dropped.push(`${snap.id} (${snap.uri}): resource not registered`);
        continue;
      }
      const validation = validateMcpV8AppHtml(resource.html, resource.domains);
      if (!validation.ok) {
        dropped.push(`${snap.id} (${snap.uri}): HTML refused: ${validation.problems.join('; ')}`);
        continue;
      }
      const instance: McpV9AppInstance = {
        id: snap.id,
        uri: snap.uri,
        toolName: snap.toolName,
        state: snap.state === 'active' ? 'closed' : snap.state,
        slot: snap.slot,
        focusOrder: 0,
        openedAt: snap.openedAt,
        lastActiveAt: snap.lastActiveAt,
        renderCount: snap.renderCount,
        callbackCount: snap.callbackCount,
        reopenCount: snap.reopenCount,
        reason: snap.reason,
      };
      this.instances.set(instance.id, instance);
      restored += 1;
    }
    if (typeof snapshot.nextId === 'number' && snapshot.nextId > this.nextId) this.nextId = snapshot.nextId;
    if (typeof snapshot.nextFocus === 'number' && snapshot.nextFocus > this.nextFocus) this.nextFocus = snapshot.nextFocus;
    return { restored, dropped };
  }
}
