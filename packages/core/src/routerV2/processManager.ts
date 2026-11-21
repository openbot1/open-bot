/**
 * Quan ly child process per-model (v1.16, Doi T3).
 *
 * Y tuong (llama.cpp router-mode: moi model mot child process rieng):
 * crash mot model khong keo sap router — process chet thi chi model
 * do ve 'crashed', cac model khac van chay; router tu restart co
 * backoff (nhan doi, tran tren) toi da N lan roi danh 'failed'.
 *
 * Spawner + health checker deu injectable de test ma khong can chay
 * process that. Khong bao gio spawn shell (tranh injection qua args).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { safeEnvForHookScript } from '../hooks/scriptRunner';

import type { PerModelFlags, RouterV2ModelState } from './types';
import { buildLlamaServerArgs } from './presets';

/** Giao dien toi thieu cua mot child process (de mock trong test). */
export interface ManagedChildProcess {
  pid?: number;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** Ham spawn mot child process (injectable). */
export type ModelProcessSpawner = (binary: string, args: string[], opts: { port: number; env: NodeJS.ProcessEnv }) => ManagedChildProcess;

/** Ham kiem tra health mot model qua HTTP loopback (injectable). */
export type HealthChecker = (port: number) => Promise<boolean>;

/** Su kien process manager phat ra (host/UI co the lang nghe). */
export type ProcessManagerEvent =
  | { type: 'started'; modelId: string; pid?: number; port: number }
  | { type: 'crashed'; modelId: string; code: number | null; restartsAttempted: number }
  | { type: 'restarted'; modelId: string; pid?: number; port: number }
  | { type: 'failed'; modelId: string; reason: string }
  | { type: 'stopped'; modelId: string };

/** Thong tin mot process dang quan ly. */
export interface ManagedModelProcess {
  modelId: string;
  binary: string;
  args: string[];
  port: number;
  child: ManagedChildProcess;
  state: RouterV2ModelState;
  startedAt: number;
  /** So lan crash lien tiep (reset khi chay on dinh). */
  consecutiveCrashes: number;
  /** So lan restart da thu trong chu ky crash hien tai. */
  restartsAttempted: number;
  /** Thoi diem restart ke tiep duoc phep (backoff). */
  nextRestartAt: number;
  /** Timer restart dang cho (neu co). */
  restartTimer?: NodeJS.Timeout;
  lastError?: string;
  /** true = user chu dong stop, khong restart lai. */
  intentionallyStopped: boolean;
}

/** Delay (ms) sau khi start thi coi la "chay on dinh" (reset crash count). */
export const STABLE_RUN_MS = 10_000;

function defaultSpawner(binary: string, args: string[], opts: { port: number; env: NodeJS.ProcessEnv }): ManagedChildProcess {
  const child: ChildProcess = spawn(binary, args, { stdio: 'ignore', windowsHide: true, env: opts.env });
  return child as unknown as ManagedChildProcess;
}

async function defaultHealthChecker(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * ModelProcessManager — moi model mot process, crash isolation +
 * restart backoff. Khong giu model nao "dac biet": tat ca deu qua
 * cung mot duong start/stop/restart.
 */
export class ModelProcessManager {
  private readonly spawner: ModelProcessSpawner;
  private readonly healthChecker: HealthChecker;
  private readonly maxRestarts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly autoRestart: boolean;
  private readonly processes = new Map<string, ManagedModelProcess>();
  private readonly listeners = new Set<(event: ProcessManagerEvent) => void>();
  /** Dung de test: clock injectable (mac dinh Date.now). */
  private readonly now: () => number;

  constructor(opts?: {
    spawner?: ModelProcessSpawner;
    healthChecker?: HealthChecker;
    maxRestarts?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    autoRestart?: boolean;
    now?: () => number;
  }) {
    this.spawner = opts?.spawner ?? defaultSpawner;
    this.healthChecker = opts?.healthChecker ?? defaultHealthChecker;
    this.maxRestarts = opts?.maxRestarts ?? 3;
    this.backoffBaseMs = opts?.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts?.backoffMaxMs ?? 30_000;
    this.autoRestart = opts?.autoRestart ?? true;
    this.now = opts?.now ?? Date.now;
  }

  onEvent(listener: (event: ProcessManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ProcessManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener loi khong duoc keo sap manager.
      }
    }
  }

  /** Backoff cho lan restart thu `attempt` (1-based): base * 2^(n-1), tran max. */
  backoffForAttempt(attempt: number): number {
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  }

  /** Start process cho mot model. Tra false neu model dang chay. */
  start(modelId: string, binary: string, args: string[], port: number): boolean {
    const existing = this.processes.get(modelId);
    if (existing && !existing.child.killed && existing.state !== 'failed' && existing.state !== 'crashed') {
      return false;
    }
    if (existing?.restartTimer) clearTimeout(existing.restartTimer);
    let child: ManagedChildProcess;
    try {
      child = this.spawner(binary, args, { port, env: safeEnvForHookScript() });
    } catch (error) {
      this.emit({
        type: 'failed',
        modelId,
        reason: `Khong spawn duoc process: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
    const entry: ManagedModelProcess = {
      modelId,
      binary,
      args,
      port,
      child,
      state: 'loading',
      startedAt: this.now(),
      consecutiveCrashes: existing?.consecutiveCrashes ?? 0,
      restartsAttempted: existing?.restartsAttempted ?? 0,
      nextRestartAt: 0,
      intentionallyStopped: false,
    };
    this.processes.set(modelId, entry);
    child.on('exit', (code, signal) => this.handleExit(modelId, code, signal));
    child.on('error', (error) => this.handleError(modelId, error));
    this.emit({ type: 'started', modelId, pid: child.pid, port });
    return true;
  }

  /** Danh dau model da load xong (health check ok) — goi tu router. */
  markLoaded(modelId: string): boolean {
    const entry = this.processes.get(modelId);
    if (!entry) return false;
    entry.state = 'loaded';
    return true;
  }

  /** Health check mot model qua port loopback. */
  async healthCheck(modelId: string): Promise<boolean> {
    const entry = this.processes.get(modelId);
    if (!entry || entry.state === 'failed') return false;
    return this.healthChecker(entry.port);
  }

  /** Stop process (chu dong) — khong restart lai. */
  stop(modelId: string): boolean {
    const entry = this.processes.get(modelId);
    if (!entry) return false;
    entry.intentionallyStopped = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    try {
      entry.child.kill('SIGTERM');
    } catch {
      // Process co the da chet — bo qua.
    }
    entry.state = 'unloaded';
    this.processes.delete(modelId);
    this.emit({ type: 'stopped', modelId });
    return true;
  }

  /** Stop tat ca process (khi tat router). */
  stopAll(): void {
    for (const modelId of [...this.processes.keys()]) this.stop(modelId);
  }

  getProcess(modelId: string): ManagedModelProcess | undefined {
    return this.processes.get(modelId);
  }

  listProcesses(): ManagedModelProcess[] {
    return [...this.processes.values()];
  }

  /** Snapshot trang thai (de router gop vao status). */
  snapshot(): { modelId: string; state: RouterV2ModelState; pid?: number; port: number; crashes: number; restarts: number }[] {
    return [...this.processes.values()].map((p) => ({
      modelId: p.modelId,
      state: p.state,
      pid: p.child.pid,
      port: p.port,
      crashes: p.consecutiveCrashes,
      restarts: p.restartsAttempted,
    }));
  }

  private handleError(modelId: string, error: Error): void {
    const entry = this.processes.get(modelId);
    if (!entry) return;
    entry.lastError = error.message.slice(0, 500);
    // 'error' thuong di kem 'exit' ngay sau; de handleExit quyet dinh restart.
  }

  /**
   * Xu ly process exit: crash isolation — chi model nay bi anh huong.
   * Neu chua chu dong stop va con luot restart -> dat lich restart
   * theo backoff; het luot -> 'failed'.
   */
  private handleExit(modelId: string, code: number | null, _signal: NodeJS.Signals | null): void {
    const entry = this.processes.get(modelId);
    if (!entry || entry.intentionallyStopped) return;
    const uptime = this.now() - entry.startedAt;
    entry.state = 'crashed';
    // Chay on dinh du lau thi reset dem crash (crash cu khong anh
    // huong lan sau).
    if (uptime >= STABLE_RUN_MS) {
      entry.consecutiveCrashes = 0;
      entry.restartsAttempted = 0;
    }
    entry.consecutiveCrashes += 1;
    entry.lastError = `Process thoat voi code ${code ?? 'unknown'} sau ${uptime}ms`;
    this.emit({ type: 'crashed', modelId, code, restartsAttempted: entry.restartsAttempted });
    if (!this.autoRestart) return;
    if (entry.restartsAttempted >= this.maxRestarts) {
      entry.state = 'failed';
      this.emit({ type: 'failed', modelId, reason: `Crash ${entry.consecutiveCrashes} lan lien tiep, het ${this.maxRestarts} luot restart` });
      return;
    }
    entry.restartsAttempted += 1;
    const delay = this.backoffForAttempt(entry.restartsAttempted);
    entry.nextRestartAt = this.now() + delay;
    entry.restartTimer = setTimeout(() => {
      const current = this.processes.get(modelId);
      if (!current || current.intentionallyStopped) return;
      const ok = this.start(modelId, current.binary, current.args, current.port);
      if (ok) {
        const restarted = this.processes.get(modelId);
        if (restarted) {
          restarted.consecutiveCrashes = current.consecutiveCrashes;
          restarted.restartsAttempted = current.restartsAttempted;
          this.emit({ type: 'restarted', modelId, pid: restarted.child.pid, port: restarted.port });
        }
      }
    }, delay);
    // De test / shutdown sach: khong giu event loop chi vi timer restart.
    entry.restartTimer.unref?.();
  }
}

/** Build argv chay llama-server tu model + flags (de router dung). */
export function buildModelCommand(
  modelPath: string,
  flags: PerModelFlags,
  port: number,
): { binary: string; args: string[] } {
  return { binary: 'llama-server', args: buildLlamaServerArgs(modelPath, flags, port) };
}
