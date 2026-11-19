/**
 * Sandbox v5 — per-bot runtime choice (v1.37, Team T3).
 *
 * Every bot picks its own runtime tier (see `runtimeTiers.ts`)
 * plus the agent profile it runs under. The choice is stored
 * per bot in one JSON file (`runtime-choices.json` under the
 * v5 base dir), written atomically (temp file + rename) so a
 * crash mid-write never leaves a torn file, and it survives
 * restarts: a bot that restarts comes back on the tier it had.
 *
 * The same module owns the per-bot runtime registry: one live
 * record per bot runtime (tier, state, workdir, last activity).
 * The registry is the source of truth for "is this bot
 * running, and on which tier" — the switch procedure and the
 * archiver both read it, never a stale copy elsewhere.
 *
 * Rules:
 *  - A choice must name a known tier, a valid profile id (or
 *    ''), and a tier at least as strong as the minimum for the
 *    bot's trust. A too-weak tier is refused at set time.
 *  - A choice for a tier the host cannot run (unavailable)
 *    is refused at set time — never silently downgraded.
 *  - Changing a choice never touches a running runtime by
 *    itself: the runtime keeps its tier until the switch
 *    procedure (`runtimeSwitch.ts`) moves it safely.
 *  - Bot ids are validated (safe path segments) so a bot id
 *    can never escape the sandbox tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  availableSandboxV5Tiers,
  getSandboxV5TierInfo,
  isSandboxV5Tier,
  probeSandboxV5HostCapabilities,
  validateSandboxV5TierForTrust,
  type SandboxV5HostCapabilities,
} from './runtimeTiers';
import {
  defaultSandboxV5ChoiceLimits,
  sandboxV5BotIdProblem,
  sandboxV5ProfileIdProblem,
  type SandboxV5BotRuntime,
  type SandboxV5BotRuntimeSummary,
  type SandboxV5ChoiceLimits,
  type SandboxV5RuntimeChoice,
  type SandboxV5RuntimeState,
  type SandboxV5Tier,
  type SandboxV5TrustLevel,
} from './types';

export const SANDBOX_V5_CHOICES_FILE = 'runtime-choices.json';
export const SANDBOX_V5_RUNTIMES_FILE = 'bot-runtimes.json';

/** Default base dir: OS temp dir / open-bot-sandbox-v5. */
export function defaultSandboxV5BaseDir(): string {
  return path.join(os.tmpdir(), 'open-bot-sandbox-v5');
}

/** Input for setting a bot's runtime choice. */
export interface SetSandboxV5ChoiceInput {
  tier: SandboxV5Tier;
  /** Profile id ('' = none). Default: keep the current one. */
  profileId?: string;
  /** Trust level the choice is made for. Default: keep the current one. */
  trust?: SandboxV5TrustLevel;
  /** Limits override (partial: omitted fields keep current / default). */
  limits?: Partial<SandboxV5ChoiceLimits>;
  /** Who sets it. Default `system`. */
  setBy?: string;
  /** Why it is set. Default ''. */
  reason?: string;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Validate choice limits (fail-closed on nonsense values). */
export function validateSandboxV5ChoiceLimits(limits: SandboxV5ChoiceLimits): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(limits.maxWriteBytes) || limits.maxWriteBytes < 0) {
    problems.push('maxWriteBytes must be a finite number >= 0');
  }
  if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs < 0) {
    problems.push('timeoutMs must be a finite number >= 0');
  }
  if (!Number.isFinite(limits.maxMemoryBytes) || limits.maxMemoryBytes < 0) {
    problems.push('maxMemoryBytes must be a finite number >= 0');
  }
  if (!Number.isFinite(limits.cpuSeconds) || limits.cpuSeconds < 0) {
    problems.push('cpuSeconds must be a finite number >= 0');
  }
  return problems;
}

/**
 * Per-bot runtime choice store. One instance per v5 base dir;
 * the file is the durable record, the Map is the live cache.
 */
export class SandboxV5ChoiceStore {
  readonly baseDir: string;
  private readonly choices: Map<string, SandboxV5RuntimeChoice> = new Map();
  private readonly caps: SandboxV5HostCapabilities;

  constructor(options: { baseDir?: string; capabilities?: SandboxV5HostCapabilities } = {}) {
    this.baseDir = options.baseDir ?? defaultSandboxV5BaseDir();
    this.caps = options.capabilities ?? probeSandboxV5HostCapabilities();
    const loaded = readJsonFile<SandboxV5RuntimeChoice[]>(
      path.join(this.baseDir, SANDBOX_V5_CHOICES_FILE),
      [],
    );
    for (const choice of loaded) {
      if (sandboxV5BotIdProblem(choice.botId) === '' && isSandboxV5Tier(choice.tier)) {
        this.choices.set(choice.botId, choice);
      }
    }
  }

  private persist(): void {
    const sorted = [...this.choices.values()].sort((a, b) => a.botId.localeCompare(b.botId));
    writeJsonFileAtomic(path.join(this.baseDir, SANDBOX_V5_CHOICES_FILE), sorted);
  }

  /** Tiers available on this host (for UI pickers). */
  availableTiers(): SandboxV5Tier[] {
    return availableSandboxV5Tiers(this.caps);
  }

  /** Host capabilities this store was built with. */
  hostCapabilities(): SandboxV5HostCapabilities {
    return { ...this.caps };
  }

  /** The choice for a bot (undefined when the bot never chose). */
  get(botId: string): SandboxV5RuntimeChoice | undefined {
    return this.choices.get(botId);
  }

  /** True when the bot has a recorded choice. */
  has(botId: string): boolean {
    return this.choices.has(botId);
  }

  /** All choices, sorted by bot id. */
  list(): SandboxV5RuntimeChoice[] {
    return [...this.choices.values()].sort((a, b) => a.botId.localeCompare(b.botId));
  }

  /**
   * Set (or replace) a bot's runtime choice. Validates the bot id,
   * the tier, the profile id, the trust minimum and host
   * availability — any problem throws and nothing is stored.
   * The running runtime (if any) keeps its tier until the switch
   * procedure moves it; this only records the choice.
   */
  set(botId: string, input: SetSandboxV5ChoiceInput): SandboxV5RuntimeChoice {
    const botProblem = sandboxV5BotIdProblem(botId);
    if (botProblem !== '') throw new Error(botProblem);
    if (!isSandboxV5Tier(input.tier)) throw new Error(`Unknown tier "${input.tier as string}".`);
    const profileId = input.profileId ?? this.choices.get(botId)?.profileId ?? '';
    if (profileId !== '') {
      const profileProblem = sandboxV5ProfileIdProblem(profileId);
      if (profileProblem !== '') throw new Error(profileProblem);
    }
    const trust = input.trust ?? this.choices.get(botId)?.trust ?? 'standard';
    const trustProblems = validateSandboxV5TierForTrust(input.tier, trust);
    if (trustProblems.length > 0) throw new Error(trustProblems.join(' '));
    if (!this.availableTiers().includes(input.tier)) {
      const info = getSandboxV5TierInfo(input.tier);
      throw new Error(
        `Tier "${input.tier}" is not available on this host` +
          (info?.requires !== '' ? ` (needs ${info?.requires ?? 'a backend'})` : '') +
          `. Available tiers: ${this.availableTiers().join(', ') || '(none)'} — ` +
          `the choice was refused, not silently downgraded.`,
      );
    }
    const prev = this.choices.get(botId);
    const limits: SandboxV5ChoiceLimits = {
      ...(prev?.limits ?? defaultSandboxV5ChoiceLimits()),
      ...(input.limits ?? {}),
    };
    const limitProblems = validateSandboxV5ChoiceLimits(limits);
    if (limitProblems.length > 0) throw new Error(`Invalid limits: ${limitProblems.join(' ')}`);
    const now = Date.now();
    const choice: SandboxV5RuntimeChoice = {
      botId,
      tier: input.tier,
      profileId,
      trust,
      limits,
      setAtMs: now,
      setBy: input.setBy ?? 'system',
      reason: input.reason ?? '',
      version: (prev?.version ?? 0) + 1,
    };
    this.choices.set(botId, choice);
    this.persist();
    return choice;
  }

  /** Remove a bot's choice (the runtime, if any, is untouched). Returns false when none. */
  remove(botId: string): boolean {
    const had = this.choices.delete(botId);
    if (had) this.persist();
    return had;
  }
}

// ---------------------------------------------------------------------------
// Per-bot runtime registry
// ---------------------------------------------------------------------------

export interface SandboxV5RuntimeRegistryOptions {
  /** Base dir (the runtimes file lives here). */
  baseDir?: string;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/** Input for registering a runtime. */
export interface RegisterSandboxV5RuntimeInput {
  botId: string;
  tier: SandboxV5Tier;
  profileId?: string;
  workdir: string;
}

/**
 * Registry of live per-bot runtimes. One record per bot (a bot
 * has at most one live runtime — a second register for the same
 * bot replaces the record only when the old one is terminal).
 */
export class SandboxV5RuntimeRegistry {
  readonly baseDir: string;
  private readonly runtimes: Map<string, SandboxV5BotRuntime> = new Map();
  private readonly nowMs: () => number;

  constructor(options: SandboxV5RuntimeRegistryOptions = {}) {
    this.baseDir = options.baseDir ?? defaultSandboxV5BaseDir();
    this.nowMs = options.nowMs ?? Date.now;
    const loaded = readJsonFile<SandboxV5BotRuntime[]>(
      path.join(this.baseDir, SANDBOX_V5_RUNTIMES_FILE),
      [],
    );
    for (const runtime of loaded) {
      if (sandboxV5BotIdProblem(runtime.botId) === '' && isSandboxV5Tier(runtime.tier)) {
        this.runtimes.set(runtime.botId, runtime);
      }
    }
  }

  private persist(): void {
    const sorted = [...this.runtimes.values()].sort((a, b) => a.botId.localeCompare(b.botId));
    writeJsonFileAtomic(path.join(this.baseDir, SANDBOX_V5_RUNTIMES_FILE), sorted);
  }

  /** Register (or re-register) a runtime for a bot. */
  register(input: RegisterSandboxV5RuntimeInput): SandboxV5BotRuntime {
    const botProblem = sandboxV5BotIdProblem(input.botId);
    if (botProblem !== '') throw new Error(botProblem);
    if (!isSandboxV5Tier(input.tier)) throw new Error(`Unknown tier "${input.tier as string}".`);
    const existing = this.runtimes.get(input.botId);
    if (existing && (existing.state === 'running' || existing.state === 'paused' || existing.state === 'created')) {
      throw new Error(
        `Bot "${input.botId}" already has a live runtime (${existing.id}, state ${existing.state}). ` +
          `Stop it before registering a new one.`,
      );
    }
    const now = this.nowMs();
    const runtime: SandboxV5BotRuntime = {
      id: `rt-${randomUUID()}`,
      botId: input.botId,
      tier: input.tier,
      profileId: input.profileId ?? '',
      state: 'created',
      workdir: input.workdir,
      createdAtMs: now,
      lastActivityAtMs: now,
      endedAtMs: 0,
      switchCount: existing?.switchCount ?? 0,
      runCount: 0,
    };
    this.runtimes.set(input.botId, runtime);
    this.persist();
    return runtime;
  }

  /** Runtime for a bot (undefined when none). */
  get(botId: string): SandboxV5BotRuntime | undefined {
    return this.runtimes.get(botId);
  }

  /** Runtime by id (undefined when unknown). */
  getById(runtimeId: string): SandboxV5BotRuntime | undefined {
    for (const runtime of this.runtimes.values()) {
      if (runtime.id === runtimeId) return runtime;
    }
    return undefined;
  }

  /** All runtimes, oldest first. */
  list(): SandboxV5BotRuntime[] {
    return [...this.runtimes.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Summaries for lists / reports (includes computed idle time). */
  summarize(): SandboxV5BotRuntimeSummary[] {
    const now = this.nowMs();
    return this.list().map((runtime) => ({
      id: runtime.id,
      botId: runtime.botId,
      tier: runtime.tier,
      profileId: runtime.profileId,
      state: runtime.state,
      workdir: runtime.workdir,
      createdAtMs: runtime.createdAtMs,
      lastActivityAtMs: runtime.lastActivityAtMs,
      idleMs: Math.max(0, now - runtime.lastActivityAtMs),
      endedAtMs: runtime.endedAtMs,
      ...(runtime.endReason !== undefined ? { endReason: runtime.endReason } : {}),
      switchCount: runtime.switchCount,
      runCount: runtime.runCount,
    }));
  }

  /** Mark a runtime running (from created / paused). */
  start(botId: string): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    if (runtime.state !== 'created' && runtime.state !== 'paused') {
      throw new Error(`Cannot start runtime for bot "${botId}" from state "${runtime.state}".`);
    }
    runtime.state = 'running';
    runtime.lastActivityAtMs = this.nowMs();
    this.persist();
    return runtime;
  }

  /** Mark a runtime paused (only from running). */
  pause(botId: string): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    if (runtime.state !== 'running') {
      throw new Error(`Cannot pause runtime for bot "${botId}" from state "${runtime.state}".`);
    }
    runtime.state = 'paused';
    this.persist();
    return runtime;
  }

  /** Record a heartbeat / activity (also bumps the run counter when a run starts). */
  heartbeat(botId: string, runStarted = false): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    runtime.lastActivityAtMs = this.nowMs();
    if (runStarted) runtime.runCount += 1;
    this.persist();
    return runtime;
  }

  /** Mark a runtime stopped (from running / paused / created). */
  stop(botId: string, reason = ''): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    if (runtime.state === 'stopped' || runtime.state === 'archived' || runtime.state === 'destroyed') {
      throw new Error(`Cannot stop runtime for bot "${botId}" from state "${runtime.state}".`);
    }
    runtime.state = 'stopped';
    runtime.endedAtMs = this.nowMs();
    if (reason !== '') runtime.endReason = reason;
    this.persist();
    return runtime;
  }

  /** Mark a runtime archived (only from stopped — the archiver stops it first). */
  markArchived(botId: string): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    if (runtime.state !== 'stopped') {
      throw new Error(`Cannot archive runtime for bot "${botId}" from state "${runtime.state}" — stop it first.`);
    }
    runtime.state = 'archived';
    this.persist();
    return runtime;
  }

  /** Mark a runtime destroyed (terminal). */
  destroy(botId: string): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    runtime.state = 'destroyed';
    runtime.endedAtMs = this.nowMs();
    this.persist();
    return runtime;
  }

  /** Change a runtime's tier (used ONLY by the switch procedure). */
  setTier(botId: string, tier: SandboxV5Tier): SandboxV5BotRuntime {
    const runtime = this.require(botId);
    if (!isSandboxV5Tier(tier)) throw new Error(`Unknown tier "${tier as string}".`);
    runtime.tier = tier;
    runtime.switchCount += 1;
    runtime.lastActivityAtMs = this.nowMs();
    this.persist();
    return runtime;
  }

  /** Remove a runtime record entirely (after destroy / archive). Returns false when none. */
  remove(botId: string): boolean {
    const had = this.runtimes.delete(botId);
    if (had) this.persist();
    return had;
  }

  private require(botId: string): SandboxV5BotRuntime {
    const runtime = this.runtimes.get(botId);
    if (!runtime) throw new Error(`Unknown sandbox v5 runtime for bot "${botId}".`);
    return runtime;
  }
}

/** Is this runtime state live (created / running / paused)? */
export function isSandboxV5RuntimeLive(state: SandboxV5RuntimeState): boolean {
  return state === 'created' || state === 'running' || state === 'paused';
}

/** Is this runtime state terminal (archived / destroyed)? */
export function isSandboxV5RuntimeTerminal(state: SandboxV5RuntimeState): boolean {
  return state === 'archived' || state === 'destroyed';
}
