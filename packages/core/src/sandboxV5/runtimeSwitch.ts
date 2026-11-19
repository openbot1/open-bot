/**
 * Sandbox v5 — safe runtime tier switch (v1.37, Team T3).
 *
 * Changing a bot's tier while it runs is the dangerous part of
 * per-bot runtime choice: kill the old runtime and the bot
 * loses in-flight work; start the new one first and two
 * runtimes fight over one workspace. The switch procedure
 * runs one ordered pipeline, and every step is journaled:
 *
 *   1. validate  — the target tier exists, is available on this
 *      host, and is strong enough for the bot's trust. A
 *      downgrade needs an explicit reason (recorded).
 *   2. quiesce   — when the runtime is running, pause it and
 *      wait for in-flight runs to drain (bounded wait; the
 *      caller decides the deadline). No new run may start
 *      during a switch.
 *   3. snapshot-state — write the runtime's state (choice,
 *      run counter, workdir manifest) to `switch-state.json`
 *      inside the workdir, so a crash mid-switch can resume.
 *   4. stop-old  — stop the old runtime.
 *   5. start-new — register + start the runtime under the new
 *      tier (same workdir, same profile).
 *   6. restore-state — read the snapshot back and re-apply it
 *      (run counter, profile, choice version).
 *   7. verify    — the new runtime answers a heartbeat and its
 *      recorded tier matches the target. A mismatch fails the
 *      switch.
 *   8. done      — the choice store is updated to the new tier.
 *
 * Any step failing after `stop-old` triggers rollback: the
 * runtime is re-registered under the OLD tier, the snapshot is
 * restored, and the journal records `rolled-back`. The bot is
 * never left half-migrated, and the choice store is only
 * updated when the new tier is verified live.
 *
 * The actual start/stop of a real isolation backend (bwrap,
 * microVM, VM) is the host's job — this module drives the
 * registry + choice store + journal, and calls the host hooks
 * the service wires in. With no hooks (tests, dry runs) the
 * switch still exercises the full state machine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SandboxV5ChoiceStore, SandboxV5RuntimeRegistry } from './runtimeChoice';
import { describeSandboxV5TierChange, getSandboxV5TierInfo, isSandboxV5Tier } from './runtimeTiers';
import {
  sandboxV5BotIdProblem,
  type SandboxV5BotRuntime,
  type SandboxV5SwitchJournalEntry,
  type SandboxV5SwitchPlan,
  type SandboxV5SwitchResult,
  type SandboxV5SwitchStep,
  type SandboxV5SwitchStepResult,
  type SandboxV5Tier,
} from './types';

export const SANDBOX_V5_SWITCH_STATE_FILE = 'switch-state.json';
export const SANDBOX_V5_SWITCH_JOURNAL_FILE = 'switch-journal.jsonl';

/** Host hooks for the real start/stop of a backend (optional). */
export interface SandboxV5SwitchHooks {
  /** Stop the backend for a runtime (throw on failure). */
  stopBackend?: (runtime: SandboxV5BotRuntime) => Promise<void> | void;
  /** Start the backend for a runtime (throw on failure). */
  startBackend?: (runtime: SandboxV5BotRuntime) => Promise<void> | void;
  /** Wait for in-flight runs to drain (throw / return false on timeout). */
  waitForDrain?: (botId: string, deadlineMs: number) => Promise<boolean> | boolean;
  /** Verify the new backend answers (throw on failure). */
  verifyBackend?: (runtime: SandboxV5BotRuntime) => Promise<void> | void;
}

export interface SandboxV5SwitchOptions {
  /** Reason for the switch (required for downgrades). */
  reason?: string;
  /** Who requests the switch. Default `system`. */
  requestedBy?: string;
  /** Drain deadline in ms when the runtime is running. Default 30_000. */
  drainTimeoutMs?: number;
  /** Hooks for the real backend. */
  hooks?: SandboxV5SwitchHooks;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/** A state snapshot written before the old runtime stops. */
export interface SandboxV5SwitchStateSnapshot {
  botId: string;
  runtimeId: string;
  tier: SandboxV5Tier;
  profileId: string;
  runCount: number;
  switchCount: number;
  workdir: string;
  /** Relative paths of the workdir files at snapshot time (manifest, no contents). */
  files: string[];
  snapshotAtMs: number;
}

function listWorkdirFiles(workdir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(workdir, '');
  return out.sort();
}

function appendJournalLine(baseDir: string, entry: SandboxV5SwitchJournalEntry): void {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.appendFileSync(
    path.join(baseDir, SANDBOX_V5_SWITCH_JOURNAL_FILE),
    `${JSON.stringify(entry)}\n`,
    'utf8',
  );
}

/** Read the switch journal back (for audits / tests). */
export function readSandboxV5SwitchJournal(baseDir: string): SandboxV5SwitchJournalEntry[] {
  const file = path.join(baseDir, SANDBOX_V5_SWITCH_JOURNAL_FILE);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const out: SandboxV5SwitchJournalEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as SandboxV5SwitchJournalEntry);
      } catch {
        // Torn last line — skip it, the journal is append-only.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The switcher. Owns the choice store + runtime registry
 * (shared with the service) and runs the switch pipeline.
 */
export class SandboxV5RuntimeSwitcher {
  private readonly choices: SandboxV5ChoiceStore;
  private readonly registry: SandboxV5RuntimeRegistry;
  private readonly baseDir: string;
  private readonly nowMs: () => number;

  constructor(
    choices: SandboxV5ChoiceStore,
    registry: SandboxV5RuntimeRegistry,
    options: { baseDir: string; nowMs?: () => number } = { baseDir: '' },
  ) {
    this.choices = choices;
    this.registry = registry;
    this.baseDir = options.baseDir;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * Dry-run plan for a switch: allowed / blocked / needs-drain,
   * without touching any runtime. A plan is advisory — the real
   * switch re-validates everything before it runs.
   */
  plan(botId: string, toTier: SandboxV5Tier): SandboxV5SwitchPlan {
    const botProblem = sandboxV5BotIdProblem(botId);
    if (botProblem !== '') {
      throw new Error(botProblem);
    }
    if (!isSandboxV5Tier(toTier)) throw new Error(`Unknown tier "${toTier as string}".`);
    const runtime = this.registry.get(botId);
    const choice = this.choices.get(botId);
    const fromTier = runtime?.tier ?? choice?.tier ?? 'local';
    const runtimeState = runtime?.state ?? 'destroyed';
    const warnings: string[] = [];
    const blockers: string[] = [];
    const change = describeSandboxV5TierChange(fromTier, toTier);
    warnings.push(...change.warnings);
    if (!runtime) {
      blockers.push(`No runtime registered for bot "${botId}" — create one before switching tiers.`);
    } else if (runtime.state === 'archived' || runtime.state === 'destroyed') {
      blockers.push(`Runtime for bot "${botId}" is ${runtime.state} — it cannot be switched.`);
    }
    if (change.direction === 'same') {
      blockers.push(`Bot "${botId}" already runs on tier "${toTier}" — nothing to switch.`);
    }
    if (choice && toTier !== choice.tier) {
      // The choice store is updated only after a verified switch;
      // a plan that disagrees with the stored choice is fine.
    }
    const targetInfo = getSandboxV5TierInfo(toTier);
    if (targetInfo && !this.choices.availableTiers().includes(toTier)) {
      blockers.push(
        `Tier "${toTier}" is not available on this host` +
          (targetInfo.requires !== '' ? ` (needs ${targetInfo.requires})` : '') +
          ' — the switch is refused, not silently downgraded.',
      );
    }
    const needsDrain = runtime?.state === 'running';
    const steps: SandboxV5SwitchStep[] = [
      'validate',
      ...(needsDrain ? (['quiesce'] as const) : []),
      'snapshot-state',
      'stop-old',
      'start-new',
      'restore-state',
      'verify',
      'done',
    ];
    return {
      botId,
      fromTier,
      toTier,
      runtimeState,
      allowed: blockers.length === 0,
      needsDrain,
      steps,
      warnings,
      blockers,
    };
  }

  /**
   * Run a safe tier switch. Returns the result; on failure the
   * old tier is restored (rolledBack = true) and the choice
   * store is left untouched. Throws only when the switch cannot
   * even start (unknown bot / tier / no runtime) — a mid-switch
   * failure is reported in the result, not thrown.
   */
  async switch(botId: string, toTier: SandboxV5Tier, options: SandboxV5SwitchOptions = {}): Promise<SandboxV5SwitchResult> {
    const startedAt = this.nowMs();
    const journalId = `sw-${randomUUID()}`;
    const steps: SandboxV5SwitchStepResult[] = [];
    const journal = (step: SandboxV5SwitchStep, event: SandboxV5SwitchJournalEntry['event'], detail: string): void => {
      appendJournalLine(this.baseDir, {
        journalId,
        seq: steps.length + 1,
        atMs: this.nowMs(),
        botId,
        step,
        event,
        detail,
      });
    };
    const runStep = async <T>(
      step: SandboxV5SwitchStep,
      fn: () => Promise<T> | T,
    ): Promise<{ ok: boolean; value?: T; detail: string; durationMs: number }> => {
      const stepStarted = this.nowMs();
      journal(step, 'started', '');
      try {
        const value = await fn();
        const durationMs = this.nowMs() - stepStarted;
        steps.push({ step, ok: true, durationMs, detail: '' });
        journal(step, 'completed', '');
        return { ok: true, value, detail: '', durationMs };
      } catch (err) {
        const durationMs = this.nowMs() - stepStarted;
        const detail = (err as Error).message;
        steps.push({ step, ok: false, durationMs, detail });
        journal(step, 'failed', detail);
        return { ok: false, detail, durationMs };
      }
    };

    const botProblem = sandboxV5BotIdProblem(botId);
    if (botProblem !== '') throw new Error(botProblem);
    if (!isSandboxV5Tier(toTier)) throw new Error(`Unknown tier "${toTier as string}".`);
    const runtime = this.registry.get(botId);
    if (!runtime) throw new Error(`No runtime registered for bot "${botId}" — create one before switching tiers.`);
    const fromTier = runtime.tier;
    const change = describeSandboxV5TierChange(fromTier, toTier);
    if (change.direction === 'downgrade' && (options.reason ?? '').trim() === '') {
      throw new Error(
        `Downgrading "${botId}" from "${fromTier}" to "${toTier}" needs an explicit reason — ` +
          `isolation is being given up on purpose, say why.`,
      );
    }
    const hooks = options.hooks ?? {};
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

    // -- 1. validate -----------------------------------------------------
    const plan = this.plan(botId, toTier);
    const validate = await runStep('validate', () => {
      if (!plan.allowed) throw new Error(plan.blockers.join(' '));
    });
    if (!validate.ok) {
      return {
        botId,
        fromTier,
        toTier,
        switched: false,
        rolledBack: false,
        steps,
        journalId,
        durationMs: this.nowMs() - startedAt,
        detail: `Switch refused: ${validate.detail}`,
      };
    }

    // -- 2. quiesce (only when running) ----------------------------------
    let needsRollback = false;
    if (runtime.state === 'running') {
      const quiesce = await runStep('quiesce', async () => {
        this.registry.pause(botId);
        if (hooks.waitForDrain) {
          const drained = await hooks.waitForDrain(botId, this.nowMs() + drainTimeoutMs);
          if (!drained) throw new Error(`Runs did not drain within ${drainTimeoutMs}ms.`);
        }
      });
      if (!quiesce.ok) {
        // Quiesce failed before anything stopped: resume if we paused it.
        try {
          if (this.registry.get(botId)?.state === 'paused') this.registry.start(botId);
        } catch {
          // Best-effort resume — the journal already records the failure.
        }
        return {
          botId,
          fromTier,
          toTier,
          switched: false,
          rolledBack: false,
          steps,
          journalId,
          durationMs: this.nowMs() - startedAt,
          detail: `Switch aborted at quiesce: ${quiesce.detail}`,
        };
      }
    }

    // -- 3. snapshot-state ------------------------------------------------
    const snapshotStep = await runStep('snapshot-state', () => {
      const current = this.registry.get(botId);
      if (!current) throw new Error(`Runtime for bot "${botId}" vanished mid-switch.`);
      const snap: SandboxV5SwitchStateSnapshot = {
        botId,
        runtimeId: current.id,
        tier: current.tier,
        profileId: current.profileId,
        runCount: current.runCount,
        switchCount: current.switchCount,
        workdir: current.workdir,
        files: listWorkdirFiles(current.workdir),
        snapshotAtMs: this.nowMs(),
      };
      fs.mkdirSync(current.workdir, { recursive: true });
      fs.writeFileSync(
        path.join(current.workdir, SANDBOX_V5_SWITCH_STATE_FILE),
        JSON.stringify(snap, null, 2),
        'utf8',
      );
      return snap;
    });
    const savedSnapshot: SandboxV5SwitchStateSnapshot | null =
      snapshotStep.ok && snapshotStep.value !== undefined ? snapshotStep.value : null;
    if (!snapshotStep.ok || savedSnapshot === null) {
      return {
        botId,
        fromTier,
        toTier,
        switched: false,
        rolledBack: false,
        steps,
        journalId,
        durationMs: this.nowMs() - startedAt,
        detail: `Switch aborted at snapshot-state: ${snapshotStep.detail}`,
      };
    }

    // -- 4. stop-old -------------------------------------------------------
    const stopStep = await runStep('stop-old', async () => {
      if (hooks.stopBackend) await hooks.stopBackend(runtime);
      if (this.registry.get(botId)?.state !== 'stopped') {
        this.registry.stop(botId, `tier-switch ${fromTier} -> ${toTier}`);
      }
    });
    if (!stopStep.ok) {
      needsRollback = true;
    }

    // -- 5. start-new ------------------------------------------------------
    let newRuntime: SandboxV5BotRuntime | null = null;
    if (!needsRollback) {
      const startStep = await runStep('start-new', async () => {
        const started = this.registry.register({
          botId,
          tier: toTier,
          ...(runtime.profileId !== '' ? { profileId: runtime.profileId } : {}),
          workdir: runtime.workdir,
        });
        if (hooks.startBackend) await hooks.startBackend(started);
        this.registry.start(botId);
        return started;
      });
      if (!startStep.ok) {
        needsRollback = true;
      } else if (startStep.value !== undefined) {
        newRuntime = startStep.value;
      }
    }

    // -- 6. restore-state --------------------------------------------------
    if (!needsRollback && newRuntime !== null && savedSnapshot !== null) {
      const restoreSnapshot = savedSnapshot;
      const restoreStep = await runStep('restore-state', () => {
        const snapPath = path.join(runtime.workdir, SANDBOX_V5_SWITCH_STATE_FILE);
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as SandboxV5SwitchStateSnapshot;
        if (snap.botId !== botId || snap.runtimeId !== restoreSnapshot.runtimeId) {
          throw new Error('Switch snapshot does not match this bot/runtime — refusing to restore.');
        }
        // The run counter survives the switch: the bot keeps its history.
        const current = this.registry.get(botId);
        if (current && snap.runCount > current.runCount) {
          for (let i = current.runCount; i < snap.runCount; i += 1) {
            this.registry.heartbeat(botId, true);
          }
        }
        return snap;
      });
      if (!restoreStep.ok) needsRollback = true;
    }

    // -- 7. verify ---------------------------------------------------------
    if (!needsRollback && newRuntime !== null) {
      const verifyStep = await runStep('verify', async () => {
        const current = this.registry.get(botId);
        if (!current) throw new Error(`Runtime for bot "${botId}" vanished after start.`);
        if (current.tier !== toTier) {
          throw new Error(`Verify failed: runtime tier is "${current.tier}", expected "${toTier}".`);
        }
        if (current.state !== 'running') {
          throw new Error(`Verify failed: runtime state is "${current.state}", expected "running".`);
        }
        if (hooks.verifyBackend) await hooks.verifyBackend(current);
        this.registry.heartbeat(botId);
      });
      if (!verifyStep.ok) needsRollback = true;
    }

    // -- 8a. rollback when anything after stop-old failed -----------------
    if (needsRollback) {
      await runStep('rollback', async () => {
        // Remove the half-started new runtime record (if any) and
        // re-register under the OLD tier with the snapshot state.
        const current = this.registry.get(botId);
        if (current && current.tier === toTier) {
          try {
            this.registry.stop(botId, 'switch-rollback');
          } catch {
            // Already stopped — continue.
          }
          this.registry.remove(botId);
        }
        const restored = this.registry.register({
          botId,
          tier: fromTier,
          ...(runtime.profileId !== '' ? { profileId: runtime.profileId } : {}),
          workdir: runtime.workdir,
        });
        if (hooks.startBackend) await hooks.startBackend(restored);
        // Restore the pre-switch state: running when it was running,
        // paused when it was paused, stopped when it was stopped.
        if (runtime.state === 'running') {
          this.registry.start(botId);
        } else if (runtime.state === 'paused') {
          this.registry.start(botId);
          this.registry.pause(botId);
        } else if (runtime.state === 'stopped') {
          this.registry.stop(botId, 'switch-rollback');
        }
        journal('rollback', 'rolled-back', `Restored tier "${fromTier}" for bot "${botId}".`);
      });
      return {
        botId,
        fromTier,
        toTier,
        switched: false,
        rolledBack: true,
        steps,
        journalId,
        durationMs: this.nowMs() - startedAt,
        detail: `Switch failed after stop-old — rolled back to "${fromTier}". See journal ${journalId}.`,
      };
    }

    // -- 8b. done: record the new choice ----------------------------------
    const doneStep = await runStep('done', () => {
      this.choices.set(botId, {
        tier: toTier,
        ...(runtime.profileId !== '' ? { profileId: runtime.profileId } : {}),
        reason: options.reason ?? `tier switch ${fromTier} -> ${toTier}`,
        setBy: options.requestedBy ?? 'system',
      });
    });
    if (!doneStep.ok) {
      return {
        botId,
        fromTier,
        toTier,
        switched: false,
        rolledBack: false,
        steps,
        journalId,
        durationMs: this.nowMs() - startedAt,
        detail: `Switch verified on "${toTier}" but the choice could not be recorded: ${doneStep.detail}`,
      };
    }

    return {
      botId,
      fromTier,
      toTier,
      switched: true,
      rolledBack: false,
      steps,
      journalId,
      durationMs: this.nowMs() - startedAt,
      detail: `Bot "${botId}" now runs on tier "${toTier}" (was "${fromTier}").`,
    };
  }
}
