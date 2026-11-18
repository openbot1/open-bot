/**
 * Sandbox v4 — service facade (v1.36, Team T4).
 *
 * One object wires the five v4 subsystems together for the
 * tools layer: the runtime manager, the profile store, the
 * secret manager, and the dependency map builder (rebuilt per
 * call — maps are cheap to build and never cached across
 * conversations, so a stale map can never leak one
 * conversation's tree into another's report).
 *
 * The facade is also where cross-cutting rules live:
 *
 *  - Setting a profile on a runtime validates the profile
 *    exists (the runtime manager alone only checks the id
 *    shape). Unknown profile → the runtime keeps its old one.
 *  - Recording usage refreshes the runtime heartbeat and
 *    returns the budget status, so tools get the soft-block
 *    signal in the same call.
 *  - Cleaning up a runtime also drops that conversation's
 *    secret requests (values and all) — a finished
 *    conversation leaves no credential behind.
 *  - Every text the facade hands to a log goes through the
 *    secret manager's `redactText` first (via `redactForLog`).
 */

import { SandboxV4BudgetMeter } from './budgetMeter';
import { SandboxV4RuntimeManager } from './conversationRuntime';
import type { CreateSandboxV4RuntimeOptions, SandboxV4RuntimeReport } from './conversationRuntime';
import { SandboxV4ProfileStore } from './agentProfiles';
import type { CreateSandboxV4ProfileInput, SandboxV4ProfileMutation, UpdateSandboxV4ProfileInput } from './agentProfiles';
import { SandboxV4SecretRequestManager } from './secretRequests';
import { SandboxV4DependencyMapBuilder } from './dependencyMap';
import {
  affectedSetSandboxV4DepMap,
  detectSandboxV4DepConflicts,
  planSandboxV4Changes,
  topoOrderSandboxV4DepMap,
} from './dependencyMap';
import type { SandboxV4DepScanResult } from './dependencyMap';
import type {
  SandboxV4BudgetLimits,
  SandboxV4BudgetRecordResult,
  SandboxV4BudgetState,
  SandboxV4DepConflict,
  SandboxV4ChangePlan,
  SandboxV4ChangeSet,
  SandboxV4DependencyMap,
  SandboxV4RuntimeSummary,
} from './types';

export interface SandboxV4ServiceOptions {
  /** Base dir for runtimes (default: OS temp dir / open-bot-sandbox-v4). */
  baseDir?: string;
  /** Idle timeout for runtimes in ms. */
  idleTimeoutMs?: number;
  /** Default lifetime cap for runtimes in ms. */
  defaultLifetimeMs?: number;
  /** Secret request TTL in ms. */
  secretTtlMs?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/**
 * The v4 service. Owns one runtime manager, one profile store
 * and one secret manager; dependency maps are built on demand.
 */
export class SandboxV4Service {
  private readonly runtimes: SandboxV4RuntimeManager;
  private readonly profiles: SandboxV4ProfileStore;
  private readonly secrets: SandboxV4SecretRequestManager;
  private readonly nowMs: () => number;

  constructor(options: SandboxV4ServiceOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.runtimes = new SandboxV4RuntimeManager({
      ...(options.baseDir !== undefined ? { baseDir: options.baseDir } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.defaultLifetimeMs !== undefined ? { defaultLifetimeMs: options.defaultLifetimeMs } : {}),
      nowMs: this.nowMs,
    });
    this.profiles = new SandboxV4ProfileStore(this.nowMs);
    this.secrets = new SandboxV4SecretRequestManager({
      ...(options.secretTtlMs !== undefined ? { ttlMs: options.secretTtlMs } : {}),
      nowMs: this.nowMs,
    });
  }

  /** Runtime manager (direct access for advanced callers). */
  runtimeManager(): SandboxV4RuntimeManager {
    return this.runtimes;
  }

  /** Profile store (direct access for advanced callers). */
  profileStore(): SandboxV4ProfileStore {
    return this.profiles;
  }

  /** Secret manager (direct access for advanced callers). */
  secretManager(): SandboxV4SecretRequestManager {
    return this.secrets;
  }

  // -- runtimes -------------------------------------------------------

  /** Create + start a runtime for a conversation. */
  createRuntime(conversationId: string, options: CreateSandboxV4RuntimeOptions = {}): SandboxV4RuntimeSummary {
    if (options.profileId !== undefined && options.profileId !== '' && !this.profiles.has(options.profileId)) {
      throw new Error(`Unknown agent profile "${options.profileId}".`);
    }
    return this.runtimes.create(conversationId, options);
  }

  /** Runtime summary by id. */
  getRuntime(runtimeId: string): SandboxV4RuntimeSummary | undefined {
    return this.runtimes.get(runtimeId);
  }

  /** Runtime summary by conversation. */
  getRuntimeByConversation(conversationId: string): SandboxV4RuntimeSummary | undefined {
    return this.runtimes.getByConversation(conversationId);
  }

  /** All runtimes, oldest first. */
  listRuntimes(): SandboxV4RuntimeSummary[] {
    return this.runtimes.list();
  }

  /** Stop a runtime (kills its processes, stops its v3 session). */
  stopRuntime(runtimeId: string, reason = ''): boolean {
    return this.runtimes.stop(runtimeId, reason);
  }

  /**
   * Clean up a runtime: stop it, delete its v3 session, remove
   * its workspace, and drop its secret requests. Returns false
   * when the runtime is unknown.
   */
  cleanupRuntime(runtimeId: string): boolean {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return false;
    const ok = this.runtimes.cleanup(runtimeId);
    if (ok) this.secrets.removeForConversation(runtime.conversationId);
    return ok;
  }

  /** Full report for one runtime. */
  reportRuntime(runtimeId: string): SandboxV4RuntimeReport {
    return this.runtimes.report(runtimeId);
  }

  /** Expire runtimes past lifetime / idle limits. */
  sweepRuntimes(now?: number): string[] {
    return this.runtimes.sweepExpired(now);
  }

  // -- profiles --------------------------------------------------------

  /**
   * Assign a profile to a runtime. The profile must exist; on
   * failure the runtime keeps its previous profile.
   */
  setRuntimeProfile(runtimeId: string, profileId: string): SandboxV4RuntimeSummary {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Unknown agent profile "${profileId}".`);
    const summary = this.runtimes.setProfile(runtimeId, profileId);
    return summary;
  }

  /** System prompt for the profile a runtime runs under ('' when none). */
  systemPromptForRuntime(runtimeId: string): string {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`Unknown sandbox v4 runtime "${runtimeId}".`);
    if (runtime.profileId === '') return '';
    return this.profiles.systemPromptForId(runtime.profileId);
  }

  /** Create a custom profile. */
  createProfile(input: CreateSandboxV4ProfileInput): SandboxV4ProfileMutation {
    return this.profiles.create(input);
  }

  /** Update a custom profile. */
  updateProfile(id: string, patch: UpdateSandboxV4ProfileInput): SandboxV4ProfileMutation {
    return this.profiles.update(id, patch);
  }

  /** Delete a custom profile. */
  deleteProfile(id: string): SandboxV4ProfileMutation {
    return this.profiles.delete(id);
  }

  // -- budget ----------------------------------------------------------

  /** Budget state for a runtime. */
  budgetForRuntime(runtimeId: string): SandboxV4BudgetState {
    return this.runtimes.budgetFor(runtimeId).describe();
  }

  /** Budget state for a conversation. */
  budgetForConversation(conversationId: string): SandboxV4BudgetState {
    return this.runtimes.budgetForConversation(conversationId).describe();
  }

  /** Replace the budget limits of a runtime (validated). */
  setBudgetLimits(runtimeId: string, limits: SandboxV4BudgetLimits): string[] {
    return this.runtimes.budgetFor(runtimeId).setLimits(limits);
  }

  /** Raise one budget limit of a runtime to at least `minValue`. */
  raiseBudgetLimit(runtimeId: string, dim: 'inputTokens' | 'outputTokens' | 'costUsd' | 'wallMs', minValue: number): string[] {
    return this.runtimes.budgetFor(runtimeId).raiseLimit(dim, minValue);
  }

  /** Reset a runtime's budget usage (limits stay). */
  resetBudget(runtimeId: string): void {
    this.runtimes.budgetFor(runtimeId).reset();
  }

  /**
   * Record usage on a runtime: refreshes the heartbeat and
   * returns the budget status (soft-blocked included).
   */
  recordUsage(
    runtimeId: string,
    input: { model?: string; inputTokens: number; outputTokens: number; wallMs?: number; costUsd?: number },
  ): SandboxV4BudgetRecordResult {
    return this.runtimes.recordUsage(runtimeId, input);
  }

  /** A fresh meter (for callers that meter without a runtime). */
  newBudgetMeter(conversationId: string, limits?: SandboxV4BudgetLimits): SandboxV4BudgetMeter {
    return new SandboxV4BudgetMeter({ conversationId, ...(limits !== undefined ? { limits } : {}), nowMs: this.nowMs });
  }

  // -- secrets ---------------------------------------------------------

  /** Scrub text of every live secret value before logging it. */
  redactForLog(text: string): string {
    return this.secrets.redactText(text);
  }

  /** Expire pending secret requests past their TTL. */
  sweepSecrets(now?: number): string[] {
    return this.secrets.sweepExpired(now);
  }

  // -- dependency maps -------------------------------------------------

  /** Build a dependency map for a source tree. */
  buildDepMap(rootDir: string): SandboxV4DepScanResult {
    const builder = new SandboxV4DependencyMapBuilder({ rootDir });
    return builder.build();
  }

  /** Topological order for a map (dependencies first). */
  topoOrder(map: SandboxV4DependencyMap): { order: string[]; unordered: string[] } {
    return topoOrderSandboxV4DepMap(map);
  }

  /** Impact set for a change (changed files + reverse deps). */
  affectedFiles(map: SandboxV4DependencyMap, files: readonly string[]): string[] {
    return affectedSetSandboxV4DepMap(map, files);
  }

  /** Execution plan (waves) for a set of files. */
  planChanges(map: SandboxV4DependencyMap, files: readonly string[]): SandboxV4ChangePlan {
    return planSandboxV4Changes(map, files);
  }

  /** Conflicts between agents' change sets. */
  depConflicts(map: SandboxV4DependencyMap, changeSets: readonly SandboxV4ChangeSet[]): SandboxV4DepConflict[] {
    return detectSandboxV4DepConflicts(map, changeSets);
  }
}
