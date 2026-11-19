/**
 * Per-conversation runtime isolation manager (v1.44, Team T6) —
 * fleet v30.
 *
 * Owns the binding between a conversation and its isolated runtime:
 * one binding per conversation, one v28 runtime underneath it, one
 * workspace root, one driver. The manager decides and tracks; the
 * host enforces (it execs the driver argv from `drivers.ts`, applies
 * the v28 limits, and wipes the scratch paths this manager lists).
 *
 * Lifecycle:
 * - `bind` — create a v28 runtime for the conversation (or reuse
 *   the live one), pick a driver (preferred, else first available
 *   that supports the network mode), record the binding. Refused
 *   when the conversation already has an active binding, the ids
 *   are invalid, the workspace root is empty, or no driver is
 *   available at all.
 * - `suspend` / `resume` — pause a binding without destroying it
 *   (the v28 runtime is stopped on suspend and restarted on
 *   resume; the workspace is kept).
 * - `endConversation` — the cleanup path: stop the v28 runtime,
 *   mark the binding `cleaned`, list the scratch paths to wipe
 *   (workspace/scratch, /tmp, /downloads under the root — checked
 *   lexically against the root so a bad root can never wipe the
 *   host), and write the audit event. A binding is cleaned exactly
 *   once; cleaning an unknown conversation is a no-op that reports
 *   `cleaned: false`.
 * - `sweepOrphans` — bindings whose v28 runtime vanished without
 *   a cleanup (host restart, crash): they are marked `cleaned`
 *   with reason `orphaned` so the fleet never leaks a binding that
 *   points at a dead runtime.
 * - `touch` — activity resets the idle clock on both the binding
 *   and the v28 runtime.
 *
 * Resource totals (`aggregateUsage`) sum the v28 runtimes of the
 * active bindings, so the dashboard shows what isolated
 * conversations actually consume.
 */

import * as path from 'node:path';
import type { FleetV28RuntimeLimits, FleetV28RuntimeStore } from '../fleetV28/runtime';
import { resolveFleetV28RuntimeLimits } from '../fleetV28/runtime';
import { checkFleetV28WorkspacePath } from '../fleetV28/sandbox';
import type { FleetV30ProfileQuotas } from './quotas';
import {
  fleetV30DriverIsolates,
  selectFleetV30Driver,
  type FleetV30DriverAvailability,
} from './drivers';
import type {
  FleetV30BindingStatus,
  FleetV30IsolationBinding,
  FleetV30IsolationEvent,
  FleetV30NetworkMode,
  FleetV30RuntimeDriverKind,
} from './types';
import { FLEET_V30_DEFAULT_NETWORK_MODE, FLEET_V30_SCRATCH_DIRS } from './types';

export interface FleetV30IsolationDeps {
  /** The v28 runtime store (host owns one instance). */
  runtimeStore: FleetV28RuntimeStore;
  /** Base directory conversations get workspaces under. */
  workspaceBaseDir: string;
  /** Driver availability the host probed (bwrap/docker/local). */
  driverAvailability: FleetV30DriverAvailability[];
  /** Optional per-profile quotas — when wired, bind() refuses a
   * bind that would exceed the profile's quota (admission check). */
  quotas?: FleetV30ProfileQuotas;
  /** Id generator (tests inject a deterministic one). */
  newId?: () => string;
  /** Clock (tests inject a fixed one). */
  nowMs?: () => number;
  /** ISO clock (tests inject a fixed one). */
  nowIso?: () => string;
}

export interface FleetV30BindOptions {
  botId?: string;
  driverKind?: FleetV30RuntimeDriverKind | null;
  networkMode?: FleetV30NetworkMode;
  limits?: Partial<FleetV28RuntimeLimits>;
  workspaceRoot?: string;
  allowLocalFallback?: boolean;
}

export interface FleetV30CleanupResult {
  /** True when a binding was cleaned by this call. */
  cleaned: boolean;
  /** Conversation cleaned (or the one asked about). */
  conversationId: string;
  /** Scratch paths listed for wiping (empty when nothing to wipe). */
  wipedPaths: string[];
  /** Reasons when nothing was cleaned. */
  reasons: string[];
}

function defaultId(): string {
  return `bind-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class FleetV30IsolationManager {
  private readonly runtimeStore: FleetV28RuntimeStore;
  private readonly workspaceBaseDir: string;
  private readonly driverAvailability: FleetV30DriverAvailability[];
  /** Set at construction or later via setQuotas (see below). */
  private quotas: FleetV30ProfileQuotas | undefined;
  private readonly newId: () => string;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly bindings = new Map<string, FleetV30IsolationBinding>();
  private readonly events: FleetV30IsolationEvent[] = [];
  private seq = 0;

  constructor(deps: FleetV30IsolationDeps) {
    if (!deps.workspaceBaseDir || !deps.workspaceBaseDir.trim()) {
      throw new Error('workspaceBaseDir must be a non-empty path.');
    }
    this.runtimeStore = deps.runtimeStore;
    this.workspaceBaseDir = deps.workspaceBaseDir;
    this.driverAvailability = [...deps.driverAvailability];
    this.quotas = deps.quotas;
    this.newId = deps.newId ?? defaultId;
    this.nowMs = deps.nowMs ?? Date.now;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  /** Wire per-profile quotas after construction (quotas need the
   * manager, the manager needs quotas — construct the manager
   * first, the quotas second, then call this). */
  setQuotas(quotas: FleetV30ProfileQuotas | undefined): void {
    this.quotas = quotas;
  }

  /** Workspace root for a conversation (base + conversation id). */
  workspaceRootFor(conversationId: string): string {
    return path.join(this.workspaceBaseDir, conversationId);
  }

  /** Scratch paths to wipe when a conversation ends (under the root). */
  scratchPathsFor(workspaceRoot: string): string[] {
    return FLEET_V30_SCRATCH_DIRS.map((dir) => path.join(workspaceRoot, dir));
  }

  private recordEvent(
    kind: FleetV30IsolationEvent['kind'],
    conversationId: string,
    profileId: string,
    detail: string,
  ): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, at: this.nowIso(), kind, conversationId, profileId, detail });
  }

  /** Get one binding (a copy; null when absent). */
  getBinding(conversationId: string): FleetV30IsolationBinding | null {
    const b = this.bindings.get(conversationId);
    return b ? { ...b, wipedPaths: [...b.wipedPaths] } : null;
  }

  /** All bindings (active first, then newest). */
  listBindings(status?: FleetV30BindingStatus): FleetV30IsolationBinding[] {
    const all = [...this.bindings.values()].map((b) => ({ ...b, wipedPaths: [...b.wipedPaths] }));
    const filtered = status ? all.filter((b) => b.status === status) : all;
    const rank = (s: FleetV30BindingStatus): number => (s === 'active' ? 0 : s === 'suspended' ? 1 : 2);
    return filtered.sort((a, b) => rank(a.status) - rank(b.status) || b.createdAtMs - a.createdAtMs);
  }

  /** Bindings owned by one profile. */
  listBindingsByProfile(profileId: string): FleetV30IsolationBinding[] {
    return this.listBindings().filter((b) => b.profileId === profileId);
  }

  /** How many bindings exist (any status). */
  bindingCount(): number {
    return this.bindings.size;
  }

  /** How many bindings are currently active. */
  activeCount(): number {
    let n = 0;
    for (const b of this.bindings.values()) if (b.status === 'active') n += 1;
    return n;
  }

  /**
   * Bind a conversation to an isolated runtime.
   *
   * Refused when the ids are invalid, the workspace root is empty
   * or escapes the base dir, an active binding already exists, or
   * no driver is available. A cleaned binding for the same
   * conversation may be re-bound (a fresh runtime, fresh workspace
   * root, same conversation id).
   */
  bind(
    conversationId: string,
    profileId: string,
    opts: FleetV30BindOptions = {},
  ): { ok: true; binding: FleetV30IsolationBinding } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (typeof conversationId !== 'string' || conversationId.trim() === '' || /\s/.test(conversationId)) {
      reasons.push('conversationId must be a non-empty id without whitespace.');
    }
    if (typeof profileId !== 'string' || profileId.trim() === '' || /\s/.test(profileId)) {
      reasons.push('profileId must be a non-empty id without whitespace.');
    }
    const networkMode: FleetV30NetworkMode = opts.networkMode ?? FLEET_V30_DEFAULT_NETWORK_MODE;
    if (!['none', 'loopback', 'host'].includes(networkMode)) reasons.push(`Unknown network mode "${networkMode}".`);
    const workspaceRoot = opts.workspaceRoot ?? this.workspaceRootFor(conversationId);
    if (!workspaceRoot.trim()) reasons.push('workspaceRoot must be a non-empty path.');
    else {
      // Fail-closed: the root must stay under the base dir (lexical
      // + realpath check). A root outside the base — including `/`
      // or a home directory — is refused, so a bad root can never
      // make cleanup list host paths for wiping. A host that wants
      // workspaces elsewhere constructs the manager with that base.
      const checked = checkFleetV28WorkspacePath(
        this.workspaceBaseDir,
        path.relative(this.workspaceBaseDir, workspaceRoot) || '.',
      );
      if (!checked.allowed) reasons.push(`workspaceRoot "${workspaceRoot}" must stay under the workspace base dir.`);
    }
    const existing = this.bindings.get(conversationId);
    if (existing && existing.status === 'active') {
      reasons.push(`Conversation "${conversationId}" already has an active isolation binding.`);
    }
    if (existing && existing.status === 'suspended') {
      reasons.push(`Conversation "${conversationId}" has a suspended binding — resume it instead of binding again.`);
    }
    // Per-profile quota admission (when quotas are wired): a bind
    // that would exceed the profile's quota is refused up front,
    // checked against the limits this bind asks for.
    if (this.quotas) {
      const limits = resolveFleetV28RuntimeLimits(
        opts.limits,
        this.runtimeStore.getConfig().defaultLimits,
      );
      const admission = this.quotas.checkAdmission(profileId, limits);
      if (!admission.admitted) reasons.push(...admission.reasons);
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const selected = selectFleetV30Driver(
      opts.driverKind ?? null,
      this.driverAvailability,
      networkMode,
      opts.allowLocalFallback ?? true,
    );
    if (!selected) {
      this.recordEvent('driver-unavailable', conversationId, profileId, `No isolation driver available for network mode "${networkMode}".`);
      return { ok: false, reasons: [`No isolation driver is available on this host for network mode "${networkMode}".`] };
    }
    const now = this.nowMs();
    const start = this.runtimeStore.startRuntime(conversationId, profileId, {
      ...(opts.botId !== undefined ? { botId: opts.botId } : {}),
      ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
      nowMs: now,
    });
    if (!start.ok) {
      return { ok: false, reasons: start.reasons };
    }
    if (start.status === 'queued') {
      return { ok: false, reasons: [`Runtime concurrency cap reached — start for conversation "${conversationId}" is queued at position ${start.position}.`] };
    }
    const binding: FleetV30IsolationBinding = {
      conversationId,
      profileId,
      botId: opts.botId ?? '',
      driverKind: selected.kind,
      isolated: fleetV30DriverIsolates(selected.kind),
      runtimeId: conversationId,
      workspaceRoot,
      networkMode,
      status: 'active',
      createdAtMs: now,
      lastActivityMs: now,
      cleanedAtMs: null,
      cleanupReason: null,
      wipedPaths: [],
      driverVerified: true,
    };
    this.bindings.set(conversationId, binding);
    this.recordEvent(
      'binding-created',
      conversationId,
      profileId,
      `Binding created with driver "${selected.kind}" (isolated: ${binding.isolated})${selected.reasons.length > 0 ? ` — ${selected.reasons.join(' ')}` : ''}.`,
    );
    // Keep the id generator available for future binding ids.
    void this.newId;
    return { ok: true, binding: { ...binding, wipedPaths: [] } };
  }

  /** Record activity — resets the idle clock on binding + runtime. */
  touch(conversationId: string, nowMs?: number): boolean {
    const b = this.bindings.get(conversationId);
    if (!b || b.status !== 'active') return false;
    const now = nowMs ?? this.nowMs();
    b.lastActivityMs = now;
    this.runtimeStore.touch(conversationId, now);
    return true;
  }

  /** Suspend a binding (stops the v28 runtime, keeps the workspace). */
  suspend(conversationId: string, reason?: string): { ok: true; binding: FleetV30IsolationBinding } | { ok: false; reasons: string[] } {
    const b = this.bindings.get(conversationId);
    if (!b) return { ok: false, reasons: [`No isolation binding for conversation "${conversationId}".`] };
    if (b.status !== 'active') return { ok: false, reasons: [`Binding for "${conversationId}" is ${b.status}, not active.`] };
    this.runtimeStore.stopRuntime(conversationId, this.nowMs());
    b.status = 'suspended';
    this.recordEvent('binding-suspended', conversationId, b.profileId, reason ?? 'Binding suspended by admin.');
    return { ok: true, binding: { ...b, wipedPaths: [...b.wipedPaths] } };
  }

  /** Resume a suspended binding (restarts the v28 runtime). */
  resume(conversationId: string): { ok: true; binding: FleetV30IsolationBinding } | { ok: false; reasons: string[] } {
    const b = this.bindings.get(conversationId);
    if (!b) return { ok: false, reasons: [`No isolation binding for conversation "${conversationId}".`] };
    if (b.status !== 'suspended') return { ok: false, reasons: [`Binding for "${conversationId}" is ${b.status}, not suspended.`] };
    const restarted = this.runtimeStore.restartRuntime(conversationId, this.nowMs());
    if (!restarted || restarted.state === 'failed') {
      return { ok: false, reasons: [`Runtime for conversation "${conversationId}" could not be restarted.`] };
    }
    b.status = 'active';
    b.lastActivityMs = this.nowMs();
    this.recordEvent('binding-resumed', conversationId, b.profileId, 'Binding resumed; runtime restarted.');
    return { ok: true, binding: { ...b, wipedPaths: [...b.wipedPaths] } };
  }

  /**
   * End a conversation: stop the v28 runtime, mark the binding
   * cleaned, and list the scratch paths for the host to wipe.
   * Every scratch path is checked to stay under the workspace root
   * before it is listed — a path that escapes is never listed and
   * the cleanup is recorded as failed instead.
   */
  endConversation(conversationId: string, reason = 'Conversation ended.'): FleetV30CleanupResult {
    const b = this.bindings.get(conversationId);
    if (!b) return { cleaned: false, conversationId, wipedPaths: [], reasons: [`No isolation binding for conversation "${conversationId}".`] };
    if (b.status === 'cleaned') {
      return { cleaned: false, conversationId, wipedPaths: [...b.wipedPaths], reasons: [`Binding for "${conversationId}" is already cleaned.`] };
    }
    const now = this.nowMs();
    this.runtimeStore.stopRuntime(conversationId, now);
    const candidates = this.scratchPathsFor(b.workspaceRoot);
    const wiped: string[] = [];
    const bad: string[] = [];
    for (const p of candidates) {
      const checked = checkFleetV28WorkspacePath(b.workspaceRoot, path.relative(b.workspaceRoot, p) || '.');
      if (checked.allowed) wiped.push(p);
      else bad.push(p);
    }
    b.status = 'cleaned';
    b.cleanedAtMs = now;
    b.cleanupReason = reason;
    b.wipedPaths = wiped;
    if (bad.length > 0) {
      this.recordEvent('cleanup-failed', conversationId, b.profileId, `Cleanup listed ${wiped.length} path(s); ${bad.length} path(s) refused (outside workspace root).`);
      return { cleaned: true, conversationId, wipedPaths: wiped, reasons: [`${bad.length} scratch path(s) refused (outside workspace root).`] };
    }
    this.recordEvent('binding-cleaned', conversationId, b.profileId, `${reason} Runtime stopped; ${wiped.length} scratch path(s) listed for wiping.`);
    return { cleaned: true, conversationId, wipedPaths: wiped, reasons: [] };
  }

  /**
   * Sync bindings with the v28 store after an idle sweep or a
   * failure: an `active` binding whose runtime was evicted (idle)
   * or failed is suspended — the workspace is kept, so an admin
   * can resume it. Suspended/cleaned bindings are untouched
   * (suspension already stops the runtime by design). Returns the
   * conversation ids that were suspended.
   */
  sweepEvictedBindings(nowMs?: number): string[] {
    const now = nowMs ?? this.nowMs();
    const suspended: string[] = [];
    for (const b of this.bindings.values()) {
      if (b.status !== 'active') continue;
      const runtime = this.runtimeStore.getRuntime(b.conversationId);
      if (!runtime) continue; // vanished runtimes are sweepOrphans' job.
      if (runtime.state !== 'evicted' && runtime.state !== 'failed') continue;
      b.status = 'suspended';
      b.lastActivityMs = now;
      suspended.push(b.conversationId);
      this.recordEvent(
        'binding-suspended',
        b.conversationId,
        b.profileId,
        runtime.state === 'evicted'
          ? 'Binding suspended: v28 runtime was evicted (idle).'
          : `Binding suspended: v28 runtime failed (${runtime.failureReason ?? 'unknown reason'}).`,
      );
    }
    return suspended;
  }

  /**
   * Mark bindings whose v28 runtime vanished without a cleanup as
   * cleaned (`orphaned`) so the fleet never leaks a binding that
   * points at a dead runtime. Returns the orphaned conversation ids.
   */
  sweepOrphans(nowMs?: number): string[] {
    const now = nowMs ?? this.nowMs();
    const orphaned: string[] = [];
    for (const b of this.bindings.values()) {
      if (b.status !== 'active' && b.status !== 'suspended') continue;
      const runtime = this.runtimeStore.getRuntime(b.conversationId);
      if (runtime) continue;
      b.status = 'cleaned';
      b.cleanedAtMs = now;
      b.cleanupReason = 'Orphaned: v28 runtime vanished without cleanup.';
      b.wipedPaths = this.scratchPathsFor(b.workspaceRoot);
      orphaned.push(b.conversationId);
      this.recordEvent('binding-orphaned', b.conversationId, b.profileId, 'Binding orphaned — v28 runtime is gone; marked cleaned.');
    }
    return orphaned;
  }

  /** Live resource usage of one conversation's v28 runtime (zeros when absent). */
  runtimeUsageFor(conversationId: string): { cpuCores: number; ramMB: number; diskMB: number } {
    const runtime = this.runtimeStore.getRuntime(conversationId);
    if (!runtime) return { cpuCores: 0, ramMB: 0, diskMB: 0 };
    return { ...runtime.usage };
  }

  /** Aggregate usage across the active bindings' v28 runtimes. */
  aggregateUsage(): { cpuCores: number; ramMB: number; diskMB: number; active: number; suspended: number; cleaned: number } {
    let cpuCores = 0;
    let ramMB = 0;
    let diskMB = 0;
    let active = 0;
    let suspended = 0;
    let cleaned = 0;
    for (const b of this.bindings.values()) {
      if (b.status === 'active') active += 1;
      else if (b.status === 'suspended') suspended += 1;
      else cleaned += 1;
      if (b.status !== 'active') continue;
      const runtime = this.runtimeStore.getRuntime(b.conversationId);
      if (!runtime) continue;
      cpuCores += runtime.usage.cpuCores;
      ramMB += runtime.usage.ramMB;
      diskMB += runtime.usage.diskMB;
    }
    return { cpuCores, ramMB, diskMB, active, suspended, cleaned };
  }

  /** Isolation audit events (newest last). */
  listEvents(limit = 200): FleetV30IsolationEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  /** Events for one conversation. */
  eventsFor(conversationId: string, limit = 100): FleetV30IsolationEvent[] {
    return this.events.filter((e) => e.conversationId === conversationId).slice(-Math.max(1, limit));
  }
}
