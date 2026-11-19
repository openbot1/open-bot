/**
 * Sandbox v5 — service facade (v1.37, Team T3).
 *
 * One object wires the five v5 subsystems together for the
 * tools layer: the per-bot choice store + runtime registry,
 * the safe tier switcher, the idle archiver, the disk budget
 * manager, and the profile-scoped secret manager.
 *
 * The facade is also where cross-cutting rules live:
 *
 *  - Registering a runtime for a bot applies the bot's stored
 *    choice (tier + profile) when the caller does not override
 *    it — a bot restarts on the tier it had.
 *  - Switching a tier refuses a downgrade without a reason,
 *    and updates the stored choice only after the new tier is
 *    verified live (the switcher owns that ordering).
 *  - Archiving a runtime requires it stopped first, marks the
 *    registry record archived, and revokes that bot's
 *    profile-scoped secrets for its finished runs — an
 *    archived bot leaves no credential behind.
 *  - Restoring an archive re-registers a runtime on the
 *    archive's tier and re-applies the bot's stored choice
 *    when the choice is at least as strong (never weaker).
 *  - Ending a run revokes its secrets (`revokeRun`) — the
 *    tools layer calls `endRun` when a run finishes.
 *  - Every text the facade hands to a log goes through the
 *    secret manager's `redactText` first (via `redactForLog`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SandboxV5Archiver, sandboxV5DirSizeBytes } from './archive';
import type { SandboxV5ArchiveInput } from './archive';
import { SandboxV5DiskBudgetManager } from './diskBudget';
import type { SandboxV5DiskBudgetOptions } from './diskBudget';
import { SandboxV5SecretManager } from './profileSecrets';
import type { GrantSandboxV5SecretInput } from './profileSecrets';
import { SandboxV5ChoiceStore, SandboxV5RuntimeRegistry } from './runtimeChoice';
import type { RegisterSandboxV5RuntimeInput, SetSandboxV5ChoiceInput } from './runtimeChoice';
import { SandboxV5RuntimeSwitcher } from './runtimeSwitch';
import type { SandboxV5SwitchHooks, SandboxV5SwitchOptions } from './runtimeSwitch';
import { listSandboxV5Tiers, recommendSandboxV5Tier } from './runtimeTiers';
import type { SandboxV5HostCapabilities } from './runtimeTiers';
import {
  defaultSandboxV5DiskBudget,
  type SandboxV5Archive,
  type SandboxV5ArchiveResult,
  type SandboxV5BotRuntime,
  type SandboxV5BotRuntimeSummary,
  type SandboxV5DiskBudget,
  type SandboxV5DiskStatus,
  type SandboxV5IdleCandidate,
  type SandboxV5ReclaimPlan,
  type SandboxV5ReclaimResult,
  type SandboxV5RestoreResult,
  type SandboxV5RunRevokeResult,
  type SandboxV5RuntimeChoice,
  type SandboxV5SecretAuditEntry,
  type SandboxV5SecretConsumeResult,
  type SandboxV5SecretGrantSummary,
  type SandboxV5SwitchPlan,
  type SandboxV5SwitchResult,
  type SandboxV5Tier,
  type SandboxV5TierInfo,
  type SandboxV5TrustLevel,
} from './types';

export interface SandboxV5ServiceOptions {
  /** Base dir for all v5 state (default: OS temp / open-bot-sandbox-v5). */
  baseDir?: string;
  /** Host capabilities (tiers available). Default: probed from the machine. */
  capabilities?: SandboxV5HostCapabilities;
  /** Disk budget policy (partial — defaults fill the rest). */
  diskBudget?: Partial<SandboxV5DiskBudget>;
  /** Hooks for the real isolation backends (start/stop/verify). */
  switchHooks?: SandboxV5SwitchHooks;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/**
 * The v5 service. Owns one choice store, one runtime registry,
 * one switcher, one archiver, one disk manager and one secret
 * manager, all rooted at the same base dir.
 */
export class SandboxV5Service {
  readonly baseDir: string;
  private readonly choices: SandboxV5ChoiceStore;
  private readonly registry: SandboxV5RuntimeRegistry;
  private readonly switcher: SandboxV5RuntimeSwitcher;
  private readonly archiver: SandboxV5Archiver;
  private readonly disk: SandboxV5DiskBudgetManager;
  private readonly secrets: SandboxV5SecretManager;
  private readonly switchHooks?: SandboxV5SwitchHooks;
  private readonly nowMs: () => number;

  constructor(options: SandboxV5ServiceOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.tmpdir(), 'open-bot-sandbox-v5');
    this.nowMs = options.nowMs ?? Date.now;
    this.switchHooks = options.switchHooks;
    this.choices = new SandboxV5ChoiceStore({
      baseDir: this.baseDir,
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    });
    this.registry = new SandboxV5RuntimeRegistry({ baseDir: this.baseDir, nowMs: this.nowMs });
    this.switcher = new SandboxV5RuntimeSwitcher(this.choices, this.registry, {
      baseDir: this.baseDir,
      nowMs: this.nowMs,
    });
    this.archiver = new SandboxV5Archiver({ baseDir: path.join(this.baseDir, 'archives'), nowMs: this.nowMs });
    const diskBudget: SandboxV5DiskBudget = {
      ...defaultSandboxV5DiskBudget(),
      ...(options.diskBudget ?? {}),
      cacheRoots: [...(options.diskBudget?.cacheRoots ?? [])],
      workspaceRoots: [...(options.diskBudget?.workspaceRoots ?? [])],
    };
    this.disk = new SandboxV5DiskBudgetManager({
      baseDir: this.baseDir,
      budget: diskBudget,
      nowMs: this.nowMs,
    });
    this.secrets = new SandboxV5SecretManager({ baseDir: this.baseDir, nowMs: this.nowMs });
  }

  /** Choice store (direct access for advanced callers). */
  choiceStore(): SandboxV5ChoiceStore {
    return this.choices;
  }

  /** Runtime registry (direct access for advanced callers). */
  runtimeRegistry(): SandboxV5RuntimeRegistry {
    return this.registry;
  }

  /** Archiver (direct access for advanced callers). */
  archiveManager(): SandboxV5Archiver {
    return this.archiver;
  }

  /** Disk budget manager (direct access for advanced callers). */
  diskManager(): SandboxV5DiskBudgetManager {
    return this.disk;
  }

  /** Secret manager (direct access for advanced callers). */
  secretManager(): SandboxV5SecretManager {
    return this.secrets;
  }

  // -- tiers + choices ---------------------------------------------------

  /** The tier catalog (weakest first). */
  listTiers(): SandboxV5TierInfo[] {
    return listSandboxV5Tiers();
  }

  /** Tiers available on this host. */
  availableTiers(): SandboxV5Tier[] {
    return this.choices.availableTiers();
  }

  /** Recommended tier for a trust level (undefined when the host cannot run it). */
  recommendTier(trust: SandboxV5TrustLevel): SandboxV5Tier | undefined {
    return recommendSandboxV5Tier(trust, this.choices.hostCapabilities());
  }

  /** A bot's stored choice (undefined when it never chose). */
  getChoice(botId: string): SandboxV5RuntimeChoice | undefined {
    return this.choices.get(botId);
  }

  /** All stored choices, sorted by bot id. */
  listChoices(): SandboxV5RuntimeChoice[] {
    return this.choices.list();
  }

  /** Set a bot's runtime choice (validated; refuses too-weak / unavailable tiers). */
  setChoice(botId: string, input: SetSandboxV5ChoiceInput): SandboxV5RuntimeChoice {
    return this.choices.set(botId, input);
  }

  // -- runtimes ----------------------------------------------------------

  /**
   * Register a runtime for a bot. When tier / profile are not
   * given, the bot's stored choice applies (a bot restarts on
   * the tier it had); with no stored choice the default is
   * `local` with no profile.
   */
  registerRuntime(
    input: Omit<RegisterSandboxV5RuntimeInput, 'tier' | 'profileId'> & {
      tier?: SandboxV5Tier;
      profileId?: string;
    },
  ): SandboxV5BotRuntime {
    const choice = this.choices.get(input.botId);
    const tier = input.tier ?? choice?.tier ?? 'local';
    const profileId = input.profileId ?? choice?.profileId ?? '';
    return this.registry.register({ botId: input.botId, tier, profileId, workdir: input.workdir });
  }

  /** Runtime for a bot (undefined when none). */
  getRuntime(botId: string): SandboxV5BotRuntime | undefined {
    return this.registry.get(botId);
  }

  /** Runtime summaries (with computed idle time), oldest first. */
  listRuntimes(): SandboxV5BotRuntimeSummary[] {
    return this.registry.summarize();
  }

  /** Start a runtime (created / paused → running). */
  startRuntime(botId: string): SandboxV5BotRuntime {
    return this.registry.start(botId);
  }

  /** Pause a runtime (running → paused). */
  pauseRuntime(botId: string): SandboxV5BotRuntime {
    return this.registry.pause(botId);
  }

  /** Record activity on a runtime (heartbeat; runStarted bumps the run counter). */
  heartbeat(botId: string, runStarted = false): SandboxV5BotRuntime {
    return this.registry.heartbeat(botId, runStarted);
  }

  /** Stop a runtime (running / paused / created → stopped). */
  stopRuntime(botId: string, reason = ''): SandboxV5BotRuntime {
    return this.registry.stop(botId, reason);
  }

  // -- safe tier switch ----------------------------------------------------

  /** Dry-run plan for a tier switch. */
  planSwitch(botId: string, toTier: SandboxV5Tier): SandboxV5SwitchPlan {
    return this.switcher.plan(botId, toTier);
  }

  /** Run a safe tier switch (quiesce → snapshot → stop → start → restore → verify). */
  async switchTier(
    botId: string,
    toTier: SandboxV5Tier,
    options: SandboxV5SwitchOptions = {},
  ): Promise<SandboxV5SwitchResult> {
    return this.switcher.switch(botId, toTier, {
      ...options,
      hooks: options.hooks ?? this.switchHooks,
    });
  }

  // -- archiving -----------------------------------------------------------

  /** Scan runtimes for idle-archive candidates. */
  scanIdleRuntimes(idleThresholdMs?: number, now?: number): SandboxV5IdleCandidate[] {
    const threshold = idleThresholdMs ?? this.disk.policy().idleThresholdMs;
    const summaries = this.registry.summarize();
    return this.archiver.scanIdle(
      summaries.map((summary) => ({
        botId: summary.botId,
        runtimeId: summary.id,
        state: summary.state,
        lastActivityAtMs: summary.lastActivityAtMs,
        workspaceBytes: fs.existsSync(summary.workdir) ? sandboxV5DirSizeBytes(summary.workdir) : 0,
      })),
      threshold,
      now ?? this.nowMs(),
    );
  }

  /**
   * Archive a stopped runtime: pack its workspace, mark the
   * registry record archived, and revoke that bot's secrets
   * for its finished runs. Throws when the runtime is not
   * stopped yet.
   */
  archiveRuntime(
    botId: string,
    input: Omit<SandboxV5ArchiveInput, 'botId' | 'runtimeId' | 'tier' | 'profileId' | 'workdir' | 'runtimeCreatedAtMs' | 'lastActivityAtMs'> & {
      idleThresholdMs: number;
      archivedBy?: string;
      reason?: string;
    },
  ): SandboxV5ArchiveResult {
    const runtime = this.registry.get(botId);
    if (!runtime) throw new Error(`No runtime registered for bot "${botId}".`);
    if (runtime.state !== 'stopped') {
      throw new Error(
        `Cannot archive runtime for bot "${botId}" while it is ${runtime.state} — stop it first.`,
      );
    }
    const result = this.archiver.archive({
      botId,
      runtimeId: runtime.id,
      tier: runtime.tier,
      profileId: runtime.profileId,
      workdir: runtime.workdir,
      runtimeCreatedAtMs: runtime.createdAtMs,
      lastActivityAtMs: runtime.lastActivityAtMs,
      idleThresholdMs: input.idleThresholdMs,
      ...(input.archivedBy !== undefined ? { archivedBy: input.archivedBy } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    this.registry.markArchived(botId);
    return result;
  }

  /** All archives, newest first. */
  listArchives(): SandboxV5Archive[] {
    return this.archiver.list();
  }

  /** One archive's metadata (undefined when unknown). */
  getArchive(archiveId: string): SandboxV5Archive | undefined {
    return this.archiver.get(archiveId);
  }

  /**
   * Restore an archive into a fresh runtime. The workdir must
   * not exist yet; the new runtime runs on the archive's tier
   * (or the bot's stored choice when that choice is at least
   * as strong — never weaker than the archived tier).
   */
  restoreArchive(archiveId: string, destWorkdir: string): SandboxV5RestoreResult {
    const meta = this.archiver.get(archiveId);
    if (!meta) throw new Error(`Unknown sandbox v5 archive "${archiveId}".`);
    const restored = this.archiver.restore(archiveId, destWorkdir);
    const choice = this.choices.get(meta.botId);
    const tier: SandboxV5Tier =
      choice !== undefined && this.tierRank(choice.tier) >= this.tierRank(meta.tier)
        ? choice.tier
        : meta.tier;
    const runtime = this.registry.register({
      botId: meta.botId,
      tier,
      ...(meta.profileId !== '' ? { profileId: meta.profileId } : {}),
      workdir: destWorkdir,
    });
    return { ...restored, runtimeId: runtime.id };
  }

  /** Delete an archive permanently. Returns false when unknown. */
  deleteArchive(archiveId: string): boolean {
    return this.archiver.delete(archiveId);
  }

  private tierRank(tier: SandboxV5Tier): number {
    return (['local', 'bwrap', 'syscall-policy', 'microvm', 'vm'] as const).indexOf(tier);
  }

  // -- disk budget -----------------------------------------------------------

  /** Current disk status of the sandbox tree. */
  diskStatus(): SandboxV5DiskStatus {
    return this.disk.status();
  }

  /** Dry-run reclaim plan (what would be removed, without touching disk). */
  planReclaim(options: { includeWellKnownGitignored?: boolean } = {}): SandboxV5ReclaimPlan {
    return this.disk.planReclaim(options);
  }

  /** Execute a reclaim (build a plan when not given). */
  executeReclaim(plan?: SandboxV5ReclaimPlan): SandboxV5ReclaimResult {
    return this.disk.executeReclaim(plan);
  }

  /** Gitignored directories that could be shed (oldest first). */
  findGitignoredDirs(includeWellKnown = false): Array<{ path: string; sizeBytes: number; ageMs: number; reason: string }> {
    return this.disk.findGitignoredDirs({ includeWellKnown });
  }

  // -- profile-scoped secrets --------------------------------------------------

  /** Scrub text of every live secret value before logging it. */
  redactForLog(text: string): string {
    return this.secrets.redactText(text);
  }

  /** Grant a secret to one (bot, run, profile) triple (value is memory-only). */
  grantSecret(input: GrantSandboxV5SecretInput): SandboxV5SecretGrantSummary {
    return this.secrets.grant(input);
  }

  /** Consume a grant (scope-checked; the value is returned ONLY here). */
  consumeSecret(
    grantId: string,
    scope: { botId: string; runId: string; profileId: string },
  ): SandboxV5SecretConsumeResult {
    return this.secrets.consume(grantId, scope);
  }

  /** Revoke one grant early. */
  revokeSecret(grantId: string, actor = 'system', reason = ''): boolean {
    return this.secrets.revoke(grantId, actor, reason);
  }

  /**
   * End a run: revoke EVERY grant of that run. A finished run
   * leaves no credential behind.
   */
  endRun(botId: string, runId: string, actor = 'system'): SandboxV5RunRevokeResult {
    return this.secrets.revokeRun(botId, runId, actor);
  }

  /** List grants (metadata only), optionally filtered. */
  listSecrets(filter?: { botId?: string; runId?: string; profileId?: string }): SandboxV5SecretGrantSummary[] {
    return this.secrets.list(filter);
  }

  /** Active grants for one run. */
  listActiveSecretsForRun(botId: string, runId: string): SandboxV5SecretGrantSummary[] {
    return this.secrets.listActiveForRun(botId, runId);
  }

  /** Expire grants past their TTL. Returns the expired grant ids. */
  sweepSecrets(now?: number): string[] {
    return this.secrets.sweepExpired(now);
  }

  /** Full secret audit log (metadata only, hash-chained). */
  secretAuditLog(): SandboxV5SecretAuditEntry[] {
    return this.secrets.auditLog();
  }

  /** Verify the secret audit chain (empty = intact). */
  verifySecretAuditChain(): string[] {
    return this.secrets.verifyAuditChain();
  }
}
