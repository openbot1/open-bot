/**
 * Sandbox v6 — service facade (v1.38, Team T3).
 *
 * One object wires the v5 subsystems together for the tools
 * layer: the per-bot runtime manager, each bot's audit logger
 * and secret store, the disk gate and the host-capacity
 * admission check.
 *
 * The facade is where cross-cutting rules live:
 *
 *  - Exec with secrets: the caller names secrets (by name +
 *    purpose), the facade resolves them through the owning
 *    bot's store — with the access check — and passes only
 *    the *values* into the runtime, which scrubs them from
 *    the audit log. A secret that fails the check aborts the
 *    exec before anything spawns, and the denial is audited.
 *  - Destroying a runtime purges its secrets and removes its
 *    box + cgroup, but keeps its audit log (deleting the
 *    record of what a bot did would defeat the audit).
 *  - Quota changes go through admission control: the sum of
 *    all live bots' memory quotas may not exceed the host's
 *    RAM (and CPU likewise) unless the caller explicitly
 *    allows overcommit. A bot must not be promised resources
 *    the host cannot hold.
 *  - Every text the facade hands to a log goes through the
 *    bot's audit scrubber first (via `redactForLog`).
 */

import * as path from 'node:path';
import { SandboxV6RuntimeManager } from './runtime';
import type { CreateSandboxV6RuntimeOptions, SandboxV6ExecOptions } from './runtime';
import { reclaimSandboxV6Disk, type SandboxV6ReclaimOptions } from './diskReclaim';
import {
  sandboxV6AuditFilesForBot,
  verifySandboxV6AuditFiles,
  type SandboxV6AuditExport,
} from './auditExport';
import type { SandboxV6EnforcementStatus } from './enforcementStatus';
import type { SandboxV6AuditEntry, SandboxV6AuditQuery, SandboxV6AuditSummary } from './types';
import { checkSandboxV6Admission, type SandboxV6AdmissionResult } from './quotaPolicy';
import {
  SANDBOX_V6_QUOTA_PRESETS,
  resolveSandboxV6Quota,
  sandboxV6BotIdError,
  type SandboxV6DiskCheck,
  type SandboxV6ExecResult,
  type SandboxV6Quota,
  type SandboxV6QuotaPresetName,
  type SandboxV6ResolvedQuota,
  type SandboxV6RuntimeReport,
  type SandboxV6RuntimeStopReason,
  type SandboxV6RuntimeSummary,
  type SandboxV6SecretMeta,
  type SandboxV6Usage,
} from './types';

export interface SandboxV6ServiceOptions {
  /** Base dir for runtimes (default: OS temp / open-bot-sandbox-v6). */
  baseDir?: string;
  /** cgroup root (default /sys/fs/cgroup; tests pass a temp dir). */
  cgroupRoot?: string;
  /** Idle timeout for runtimes in ms. */
  idleTimeoutMs?: number;
  /** Default lifetime cap for runtimes in ms. */
  defaultLifetimeMs?: number;
  /** Allow total quotas above host capacity (default false — admission refuses). */
  allowOvercommit?: boolean;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
  logger?: { warn(message: string): void };
}

/** A secret reference for an exec: name + optional purpose. */
export interface SandboxV6ExecSecretRef {
  name: string;
  purpose?: string;
}

/**
 * The v5 service. Owns one runtime manager; audit loggers and
 * secret stores live inside it, one per bot.
 */
export class SandboxV6Service {
  private readonly manager: SandboxV6RuntimeManager;
  private readonly allowOvercommit: boolean;

  constructor(options: SandboxV6ServiceOptions = {}) {
    this.allowOvercommit = options.allowOvercommit ?? false;
    this.manager = new SandboxV6RuntimeManager({
      ...(options.baseDir !== undefined ? { baseDir: options.baseDir } : {}),
      ...(options.cgroupRoot !== undefined ? { cgroupRoot: options.cgroupRoot } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.defaultLifetimeMs !== undefined ? { defaultLifetimeMs: options.defaultLifetimeMs } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
  }

  /** Runtime manager (direct access for advanced callers). */
  runtimeManager(): SandboxV6RuntimeManager {
    return this.manager;
  }

  // -- runtimes -------------------------------------------------------

  /** Create (or return the existing live) runtime for a bot. Admission-checked. */
  createRuntime(botId: string, options: CreateSandboxV6RuntimeOptions = {}): SandboxV6RuntimeSummary {
    const botErr = sandboxV6BotIdError(botId);
    if (botErr !== '') throw new Error(botErr);
    const existing = this.manager.get(botId);
    if (existing !== undefined && (existing.state === 'created' || existing.state === 'running')) {
      return existing;
    }
    const quota = options.quota !== undefined
      ? resolveSandboxV6Quota(options.quota)
      : { ...(options.preset !== undefined ? SANDBOX_V6_QUOTA_PRESETS[options.preset] : SANDBOX_V6_QUOTA_PRESETS.default) };
    this.checkAdmission(botId, quota);
    return this.manager.create(botId, { ...options, quota });
  }

  /** Runtime summary by bot id. */
  getRuntime(botId: string): SandboxV6RuntimeSummary | undefined {
    return this.manager.get(botId);
  }

  /** All runtimes (live first). */
  listRuntimes(): SandboxV6RuntimeSummary[] {
    return this.manager.list();
  }

  /** Change a live bot's quota (admission-checked, audited). */
  setQuota(botId: string, quotaInput: SandboxV6Quota): SandboxV6RuntimeSummary {
    const quota = resolveSandboxV6Quota(quotaInput);
    this.checkAdmission(botId, quota);
    return this.manager.setQuota(botId, quota);
  }

  /** Live usage of a bot runtime. */
  getUsage(botId: string): SandboxV6Usage {
    return this.manager.getUsage(botId);
  }

  /** Disk quota check for a bot runtime. */
  checkDisk(botId: string): SandboxV6DiskCheck {
    return this.manager.checkDisk(botId);
  }

  /** Verify a bot's live cgroup files against its quota (drift detection). */
  verifyEnforcement(botId: string): SandboxV6EnforcementStatus {
    return this.manager.verifyEnforcement(botId);
  }

  /** Verify enforcement for every runtime. */
  verifyAllEnforcement(): SandboxV6EnforcementStatus[] {
    return this.manager.verifyAllEnforcement();
  }

  /** Pause / resume / stop / destroy (thin pass-throughs, audited by the manager). */
  pauseRuntime(botId: string): SandboxV6RuntimeSummary {
    return this.manager.pause(botId);
  }

  resumeRuntime(botId: string): SandboxV6RuntimeSummary {
    return this.manager.resume(botId);
  }

  stopRuntime(botId: string, reason?: SandboxV6RuntimeStopReason): SandboxV6RuntimeSummary {
    return this.manager.stop(botId, reason);
  }

  destroyRuntime(botId: string): SandboxV6RuntimeSummary {
    return this.manager.destroy(botId);
  }

  /** Heartbeat (keeps an active bot from being swept as idle). */
  heartbeat(botId: string): boolean {
    return this.manager.heartbeat(botId);
  }

  /** Sweep idle / expired runtimes. */
  sweepIdle(): { stopped: string[]; destroyed: string[] } {
    return this.manager.sweepIdle();
  }

  // -- exec -----------------------------------------------------------

  /**
   * Run a command in a bot's runtime, resolving named secrets
   * first. `secrets` are resolved through the bot's own store
   * (owner check + purpose + expiry); a failed resolution
   * aborts the exec before anything spawns. Resolved values
   * are injected as env vars named `OPENBOT_SECRET_<NAME>`
   * (upper-cased name, non-alphanumerics turned into `_`)
   * and scrubbed from the audit log.
   */
  async exec(
    botId: string,
    command: string,
    args: string[] = [],
    opts: Omit<SandboxV6ExecOptions, 'secrets'> & { secrets?: SandboxV6ExecSecretRef[] } = {},
  ): Promise<SandboxV6ExecResult> {
    const resolved: Record<string, string> = {};
    for (const ref of opts.secrets ?? []) {
      const store = this.manager.secretStore(botId);
      const got = store.get(botId, ref.name, ref.purpose);
      if (!got.access.allowed || got.value === undefined) {
        throw new Error(
          `Cannot run exec for bot "${botId}": secret "${ref.name}" unavailable — ${got.access.reason ?? 'denied'}.`,
        );
      }
      resolved[`OPENBOT_SECRET_${ref.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = got.value;
    }
    const { secrets: _refs, ...rest } = opts;
    void _refs;
    return this.manager.exec(botId, command, args, {
      ...rest,
      secrets: resolved,
    });
  }

  /** Run a command with already-resolved env values (no secret lookup). */
  async execRaw(
    botId: string,
    command: string,
    args: string[] = [],
    opts: SandboxV6ExecOptions = {},
  ): Promise<SandboxV6ExecResult> {
    return this.manager.exec(botId, command, args, opts);
  }

  // -- audit ----------------------------------------------------------

  /** Audit entries for a bot (newest first). */
  queryAudit(botId: string, query: SandboxV6AuditQuery = {}): SandboxV6AuditEntry[] {
    return this.manager.auditLogger(botId).query({ ...query, botId });
  }

  /** Audit summary for a bot (counts + chain verification). */
  auditSummary(botId: string): SandboxV6AuditSummary {
    return this.manager.auditSummary(botId);
  }

  /** Verify a bot's audit hash chain. */
  verifyAuditChain(botId: string): { ok: boolean; brokenAt: number[] } {
    return this.manager.auditLogger(botId).verifyChain();
  }

  /** Rotate a bot's audit log (fresh chain, old file kept aside). */
  rotateAudit(botId: string): string | null {
    return this.manager.auditLogger(botId).rotate();
  }

  /** Export a bot's whole audit history (live + rotated logs) with chain verification. */
  exportAudit(botId: string): SandboxV6AuditExport {
    const runtime = this.manager.get(botId);
    if (runtime === undefined) throw new Error(`Unknown bot runtime "${botId}".`);
    const botDir = path.join(this.manager.baseDir, 'bots', botId);
    const files = sandboxV6AuditFilesForBot(botDir);
    const scrubValues = this.manager.secretStore(botId).valuesForScrubbing();
    return verifySandboxV6AuditFiles(botId, files, { scrubSecrets: scrubValues });
  }

  /**
   * Reclaim disk in a bot's workspace (dry-run by default).
   * The result is audited with the freed bytes + file count.
   */
  reclaimDisk(
    botId: string,
    options: SandboxV6ReclaimOptions,
  ): ReturnType<typeof reclaimSandboxV6Disk> {
    const runtime = this.manager.get(botId);
    if (runtime === undefined) throw new Error(`Unknown bot runtime "${botId}".`);
    const result = reclaimSandboxV6Disk(runtime.workdir, options);
    this.manager.auditLogger(botId).record({
      runtimeId: runtime.id,
      kind: 'disk-quota-exceeded',
      detail:
        `Disk reclaim (${result.dryRun ? 'dry-run' : 'applied'}): ${result.deleted.length} file(s), ` +
        `${result.freedBytes} bytes freed, workspace ${result.beforeBytes} -> ${result.afterBytes} bytes, ` +
        `fits quota: ${result.fitsQuota}${result.errors.length > 0 ? ` — errors: ${result.errors.join('; ')}` : ''}.`,
    });
    return result;
  }

  /** Query audit logs of ALL bots (merged, newest first, limited). */
  queryAllAudit(query: Omit<SandboxV6AuditQuery, 'botId'> = {}): SandboxV6AuditEntry[] {
    const limit = query.limit ?? 100;
    const merged: SandboxV6AuditEntry[] = [];
    for (const runtime of this.manager.list()) {
      if (runtime.state === 'destroyed') continue;
      merged.push(...this.manager.auditLogger(runtime.botId).query({ ...query, limit }));
    }
    merged.sort((a, b) => b.startedAtMs - a.startedAtMs || b.seq - a.seq);
    return merged.slice(0, Math.max(0, limit));
  }

  // -- secrets ----------------------------------------------------------

  /** Store a secret for a bot (owner = botId). Registers the value with the audit scrubber. */
  putSecret(
    botId: string,
    name: string,
    value: string,
    opts: { purposes?: string[]; ttlMs?: number } = {},
  ): SandboxV6SecretMeta {
    const meta = this.manager.secretStore(botId).put({
      ownerBotId: botId,
      name,
      value,
      ...(opts.purposes !== undefined ? { purposes: opts.purposes } : {}),
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    });
    this.manager.auditLogger(botId).registerSecret(value);
    return meta;
  }

  /** Read a secret (owner-only, purpose-checked, audited on denial). */
  getSecret(
    callerBotId: string,
    ownerBotId: string,
    name: string,
    purpose?: string,
  ): { allowed: boolean; reason?: string; value?: string } {
    if (callerBotId !== ownerBotId) {
      // No store lookup for a foreign bot: the denial is
      // audited on the *owner's* log (the attempt targets it).
      const owner = this.manager.get(ownerBotId);
      if (owner !== undefined && owner.state !== 'destroyed') {
        this.manager.auditLogger(ownerBotId).record({
          runtimeId: owner.id,
          kind: 'secret-access-denied',
          detail: `Bot "${callerBotId}" tried to read secret "${name}" owned by "${ownerBotId}" (cross-bot access).`,
        });
      }
      return {
        allowed: false,
        reason: `Bot "${callerBotId}" is not the owner of secret "${name}" (owner is "${ownerBotId}").`,
      };
    }
    const got = this.manager.secretStore(ownerBotId).get(callerBotId, name, purpose);
    if (!got.access.allowed || got.value === undefined) {
      return { allowed: false, reason: got.access.reason };
    }
    return { allowed: true, value: got.value };
  }

  /** Secret metadata for a bot (never values). */
  listSecrets(botId: string): SandboxV6SecretMeta[] {
    return this.manager.secretStore(botId).list();
  }

  /** Revoke one secret. Also unregisters it from the audit scrubber. */
  revokeSecret(botId: string, name: string): boolean {
    const store = this.manager.secretStore(botId);
    const before = store.valuesForScrubbing();
    const revoked = store.revoke(name);
    if (revoked) {
      const after = new Set(store.valuesForScrubbing());
      for (const value of before) {
        if (!after.has(value)) this.manager.auditLogger(botId).unregisterSecret(value);
      }
      this.manager.auditLogger(botId).record({
        runtimeId: this.manager.get(botId)?.id ?? '',
        kind: 'secret-revoked',
        detail: `Secret "${name}" revoked for bot "${botId}".`,
      });
    }
    return revoked;
  }

  /** Grant an additional purpose to an existing secret (re-put with merged purposes). */
  grantSecretPurpose(botId: string, name: string, purpose: string): SandboxV6SecretMeta {
    const store = this.manager.secretStore(botId);
    const got = store.get(botId, name);
    if (!got.access.allowed || got.value === undefined) {
      throw new Error(`Cannot grant purpose: secret "${name}" unavailable — ${got.access.reason ?? 'denied'}.`);
    }
    const meta = store.list().find((m) => m.name === name);
    const purposes = [...(meta?.purposes ?? [])];
    if (!purposes.includes(purpose)) purposes.push(purpose);
    const ttlMs = meta !== undefined && meta.expiresAtMs > 0 ? meta.expiresAtMs - Date.now() : 0;
    const updated = store.put({
      ownerBotId: botId,
      name,
      value: got.value,
      purposes,
      ...(ttlMs > 0 ? { ttlMs } : {}),
    });
    this.manager.auditLogger(botId).record({
      runtimeId: this.manager.get(botId)?.id ?? '',
      kind: 'secret-granted',
      detail: `Purpose "${purpose}" granted for secret "${name}" of bot "${botId}".`,
    });
    return updated;
  }

  // -- reports ----------------------------------------------------------

  /** Full report for one bot runtime. */
  report(botId: string): SandboxV6RuntimeReport {
    const runtime = this.manager.get(botId);
    if (runtime === undefined) throw new Error(`Unknown bot runtime "${botId}".`);
    return {
      runtime,
      usage: this.manager.getUsage(botId),
      disk: this.manager.checkDisk(botId),
      audit: this.manager.auditSummary(botId),
      secrets: this.manager.secretStore(botId).list(),
    };
  }

  /** Admission check for a quota (throws when overcommitted and overcommit is off). */
  admissionFor(botId: string, quotaInput: SandboxV6Quota): SandboxV6AdmissionResult {
    const quota = resolveSandboxV6Quota(quotaInput);
    return checkSandboxV6Admission(this.liveQuotasExcluding(botId), quota);
  }

  private liveQuotasExcluding(excludeBotId: string): { botId: string; quota: SandboxV6ResolvedQuota }[] {
    return this.manager
      .list()
      .filter((r) => r.botId !== excludeBotId && (r.state === 'created' || r.state === 'running'))
      .map((r) => ({ botId: r.botId, quota: r.quota }));
  }

  private checkAdmission(botId: string, quota: SandboxV6ResolvedQuota): void {
    if (this.allowOvercommit) return;
    const result = checkSandboxV6Admission(this.liveQuotasExcluding(botId), quota);
    if (!result.admitted) {
      throw new Error(`Quota refused (host admission): ${result.reasons.join('; ')}`);
    }
  }
}

/** Named quota presets (re-exported for tools/UI). */
export type { SandboxV6QuotaPresetName };
