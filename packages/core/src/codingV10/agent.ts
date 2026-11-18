/**
 * Coding agent v10 (v1.18, Đội T2) — pipeline coding task, event-sourced.
 *
 * Nối agent v9 (plan → AST edit → sandbox loop verify → atomic commit)
 * thêm 3 lớp mới của v10, mọi bước ghi event vào phiên:
 *
 *   1. plan: `planProvider` (host/model tiêm) nhận task + repo context
 *      (kèm repo map v10 đã nén theo ngân sách khi caller cho) →
 *      danh sách `V10EditRequest` (AST / search-replace / whole-file).
 *   2. edit: áp từng edit bằng strategy selector (`applyV10Edit`):
 *      chọn chiến lược tốt nhất, verify parse, ghi event edit-result.
 *   3. codeact: chạy code agent viết (node/python/bash) bằng
 *      `V10CodeActExecutor`, kết quả thành Observation event.
 *   4. verify: sandbox execution loop của v9 (`runV9SandboxLoop`)
 *      với `verifyCommands` do host cho; fail thì fix provider sửa.
 *   5. commit: verify xanh → commit atomic từng file đã đổi
 *      (git-first, dùng `commitV9Atomic` của v9).
 *   6. snapshot: chụp snapshot phiên cuối task để resume/fork sau này.
 *
 * Pause/resume: agent kiểm tra `session.isPaused()` giữa các bước —
 * phiên đang paused thì dừng lại an toàn (không chạy bước tiếp theo),
 * host resume rồi gọi `runTask` lại sẽ tiếp tục từ event log (các
 * bước đã xong không chạy lại vì plan/edit đã ghi event — xem ghi chú
 * ở `runTask`).
 *
 * Agent không gọi model thật, không gọi mạng, không push remote — chỉ
 * làm việc trong workingDir + sessionsDir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { commitV9Atomic } from '../codingV9/gitAtomic';
import { runV9SandboxLoop } from '../codingV9/sandboxLoop';
import type { V9AtomicCommit, V9LoopResult } from '../codingV9/types';
import { V10CodeActExecutor } from './codeactExec';
import type { V10CodeActRequest, V10CodeActResult } from './types';
import { applyV10Edit } from './editStrategies';
import type { V10EditRequest } from './editStrategies';
import { CodingV10Session } from './eventSession';
import { V10RepoMap } from './repoMapV10';
import { CodingV10Error } from './types';
import type { V10AgentReport, V10AgentStep, V10EditApplyResult, V10SessionSnapshot } from './types';

/** Provider lập plan: task + repo context → danh sách edit v10. */
export type V10PlanProvider = (input: {
  task: string;
  repoContext: string;
}) => Promise<V10EditRequest[]> | V10EditRequest[];

/** Provider sửa lỗi trong sandbox loop (nhận lỗi, trả về edit sửa). */
export type V10FixEditProvider = (
  round: number,
  failureExcerpt: string,
) => Promise<V10EditRequest[] | null> | V10EditRequest[] | null;

export interface CodingAgentV10Options {
  /** Working dir = repo root. */
  workingDir: string;
  /** Thư mục chứa event log + snapshot của phiên. */
  sessionsDir: string;
  /** Id phiên (mặc định sinh mới). */
  sessionId?: string;
  /** Plan provider (bắt buộc để pipeline có đổi gì đó để làm). */
  planProvider: V10PlanProvider;
  /** Lệnh verify chạy sau edit (mảng argv, không shell). */
  verifyCommands?: string[][];
  /** Số vòng sandbox loop tối đa. Mặc định 5. */
  maxRounds?: number;
  /** Timeout mỗi lệnh verify, ms. */
  commandTimeoutMs?: number;
  /** Fix provider cho sandbox loop. */
  fixProvider?: V10FixEditProvider;
  /** Có commit atomic sau khi verify xanh hay không. Mặc định true. */
  autoCommit?: boolean;
  /** CodeAct requests chạy sau edit, trước verify (mặc định: không). */
  codeActRequests?: V10CodeActRequest[];
  /** Ngân sách token cho repo map đưa vào repo context (0 = không kèm). */
  repoMapBudget?: number;
  /** Tóm tắt thay đổi (dùng cho commit message). */
  summary?: string;
}

/** Agent v10: một instance = một task + một phiên event-sourced. */
export class CodingAgentV10 {
  readonly workingDir: string;
  readonly sessionsDir: string;
  readonly session: CodingV10Session;
  private readonly planProvider: V10PlanProvider;
  private readonly verifyCommands: string[][];
  private readonly maxRounds: number;
  private readonly commandTimeoutMs?: number;
  private readonly fixProvider?: V10FixEditProvider;
  private readonly autoCommit: boolean;
  private readonly codeActRequests: V10CodeActRequest[];
  private readonly repoMapBudget: number;
  private readonly summary?: string;
  private readonly steps: V10AgentStep[] = [];

  constructor(options: CodingAgentV10Options) {
    this.workingDir = path.resolve(options.workingDir);
    this.sessionsDir = path.resolve(options.sessionsDir);
    this.planProvider = options.planProvider;
    this.verifyCommands = options.verifyCommands ?? [];
    this.maxRounds = options.maxRounds ?? 5;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.fixProvider = options.fixProvider;
    this.autoCommit = options.autoCommit ?? true;
    this.codeActRequests = options.codeActRequests ?? [];
    this.repoMapBudget = options.repoMapBudget ?? 0;
    this.summary = options.summary;
    fs.mkdirSync(this.workingDir, { recursive: true });
    this.session = new CodingV10Session({
      sessionId: options.sessionId,
      sessionsDir: this.sessionsDir,
      workingDir: this.workingDir,
      title: 'coding-v10 task',
    });
    this.session.start();
  }

  private recordStep(name: string, status: V10AgentStep['status'], detail: string, durationMs: number): void {
    this.steps.push({ name, status, detail, durationMs });
  }

  /** Repo context cho plan provider: file top-level + repo map nén (nếu bật). */
  buildRepoContext(): string {
    const lines: string[] = [`Working dir: ${this.workingDir}`];
    try {
      const entries = fs.readdirSync(this.workingDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .slice(0, 50);
      lines.push(`Top-level files: ${files.join(', ') || '(none)'}`);
    } catch {
      lines.push('Top-level files: (unreadable)');
    }
    if (this.repoMapBudget > 0) {
      try {
        const map = new V10RepoMap(this.workingDir);
        map.scanAndBuild();
        const rendered = map.render(this.repoMapBudget);
        lines.push(`Repo map (budget ${this.repoMapBudget} tokens, kept ${rendered.filesKept}/${rendered.filesTotal} files, ${rendered.symbolsKept}/${rendered.symbolsTotal} symbols):`);
        lines.push(rendered.text);
      } catch (err) {
        lines.push(`Repo map unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return lines.join('\n');
  }

  /** Pause phiên (persist) — bước tiếp theo sẽ dừng an toàn. */
  pause(reason = ''): void {
    this.session.pause(reason);
  }

  /** Resume phiên đã pause. */
  resume(reason = ''): void {
    this.session.resume(reason);
  }

  /** Fork phiên tại một event (trả sessionId phiên mới). */
  fork(atSeq: number): string {
    return this.session.fork(atSeq).sessionId;
  }

  /**
   * Chạy một task đầy đủ: plan → edit (strategy) → codeact → verify
   * loop → commit → snapshot. Mọi bước ghi event vào phiên; khi một
   * bước lỗi thì report.ok=false kèm bước lỗi (không throw, trừ khi
   * plan provider throw — lúc đó report vẫn trả về với bước lỗi).
   *
   * Ghi chú về resume: các edit đã áp thành công đều đã ghi event
   * edit-result + commit (khi autoCommit); gọi lại `runTask` sau
   * resume với cùng plan sẽ áp lại edit — plan provider của host
   * chịu trách nhiệm cho plan idempotent (vd plan mới dựa trên trạng
   * thái hiện tại). Event log luôn ghi lại cả lần chạy lại, nên lịch
   * sử không mất — đó là điểm của event-sourcing, không phải lỗi.
   */
  async runTask(title: string, task: string): Promise<V10AgentReport> {
    const startedAt = Date.now();
    const edits: V10EditApplyResult[] = [];
    const codeActResults: V10CodeActResult[] = [];
    let loop: V9LoopResult | undefined;
    let commit: V9AtomicCommit | undefined;
    let snapshot: V10SessionSnapshot | undefined;
    let ok = false;

    this.session.recordAction('message', { title, task: task.slice(0, 500) });
    const checkPaused = (): boolean => {
      if (this.session.isPaused()) {
        this.recordStep('paused', 'skipped', 'Session paused — stopping before next step.', 0);
        return true;
      }
      return false;
    };

    // Bước 1: plan.
    let requests: V10EditRequest[] = [];
    try {
      const t0 = Date.now();
      requests = await this.planProvider({ task, repoContext: this.buildRepoContext() });
      this.session.recordAction('plan', { task: task.slice(0, 500), editCount: requests.length });
      this.recordStep('plan', 'ok', `${requests.length} edit request(s) planned.`, Date.now() - t0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.session.recordObservation('error', { message });
      this.recordStep('plan', 'failed', message, 0);
      return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
    }
    if (checkPaused()) {
      return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
    }
    if (requests.length === 0) {
      this.recordStep('plan', 'skipped', 'Plan provider returned no requests — nothing to do.', 0);
      snapshot = this.session.snapshot();
      return this.finishReport(title, task, true, edits, codeActResults, loop, commit, snapshot, startedAt);
    }

    // Bước 2: áp từng edit bằng strategy selector.
    let editFailed = false;
    for (const req of requests) {
      const t0 = Date.now();
      try {
        const result = await applyV10Edit(req, {
          workingDir: this.workingDir,
          onEvent: (event) => {
            this.session.recordObservation(event.type, event.payload);
          },
        });
        edits.push(result);
        this.recordStep(
          'edit',
          'ok',
          `${result.strategy} ${result.path} (+${result.linesAdded}/-${result.linesRemoved})${result.usedFallback ? ' [fallback]' : ''}`,
          Date.now() - t0,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.session.recordObservation('error', { message, path: req.operation.path });
        this.recordStep('edit', 'failed', `${req.operation.path}: ${message}`, Date.now() - t0);
        editFailed = true;
        break;
      }
      if (checkPaused()) {
        return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
      }
    }
    if (editFailed) {
      return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
    }

    // Bước 3: CodeAct (chạy code agent viết, trước verify).
    if (this.codeActRequests.length > 0) {
      const executor = new V10CodeActExecutor({ workingDir: this.workingDir });
      for (const req of this.codeActRequests) {
        const t0 = Date.now();
        this.session.recordAction('codeact-run', { kind: req.kind, codePreview: req.code.slice(0, 200) });
        const result = await executor.run(req);
        codeActResults.push(result);
        this.session.recordObservation('codeact-result', {
          kind: result.kind,
          status: result.status,
          exitCode: result.exitCode,
          stdoutPreview: result.stdout.slice(0, 500),
          stderrPreview: result.stderr.slice(0, 500),
          durationMs: result.durationMs,
        });
        this.recordStep(
          'codeact',
          result.status === 'ok' ? 'ok' : 'failed',
          `${req.kind}: exit ${result.exitCode ?? 'n/a'} in ${result.durationMs}ms`,
          Date.now() - t0,
        );
        if (result.status !== 'ok') break;
      }
      if (codeActResults.some((r) => r.status !== 'ok')) {
        return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
      }
    }
    if (checkPaused()) {
      return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
    }

    // Bước 4: sandbox loop verify (khi có lệnh verify).
    if (this.verifyCommands.length > 0) {
      const t0 = Date.now();
      try {
        loop = await runV9SandboxLoop({
          workingDir: this.workingDir,
          verifyCommands: this.verifyCommands,
          maxRounds: this.maxRounds,
          ...(this.commandTimeoutMs !== undefined ? { commandTimeoutMs: this.commandTimeoutMs } : {}),
          ...(this.fixProvider
            ? {
                fixProvider: async (round, failure) => {
                  const fixReqs = await this.fixProvider?.(round, failure);
                  if (!fixReqs || fixReqs.length === 0) return 'No fix requests provided.';
                  const notes: string[] = [];
                  for (const req of fixReqs) {
                    const fixed = await applyV10Edit(req, { workingDir: this.workingDir });
                    edits.push(fixed);
                    notes.push(`${fixed.strategy} ${fixed.path}`);
                  }
                  return `Fixed: ${notes.join(', ')}`;
                },
              }
            : {}),
        });
        this.session.recordObservation('verify-result', {
          passed: loop.passed,
          roundsUsed: loop.roundsUsed,
          stopReason: loop.stopReason,
        });
        this.recordStep(
          'verify',
          loop.passed ? 'ok' : 'failed',
          `loop ${loop.passed ? 'passed' : 'failed'} after ${loop.roundsUsed} round(s) (${loop.stopReason})`,
          Date.now() - t0,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.session.recordObservation('error', { message });
        this.recordStep('verify', 'failed', message, Date.now() - t0);
        return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
      }
      if (!loop.passed) {
        return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
      }
    }

    // Bước 5: commit atomic từng file đã đổi (git-first).
    if (this.autoCommit && edits.length > 0) {
      const t0 = Date.now();
      try {
        const files = [...new Set(edits.map((e) => e.path))];
        commit = await commitV9Atomic({
          workingDir: this.workingDir,
          files,
          summary: this.summary ?? title,
          task,
        });
        this.session.recordObservation('commit-result', {
          shortSha: commit.shortSha,
          files: commit.files,
          totalAdded: commit.totalAdded,
          totalRemoved: commit.totalRemoved,
        });
        this.recordStep('commit', 'ok', `atomic commit ${commit.shortSha} (${files.length} file(s))`, Date.now() - t0);
        ok = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.session.recordObservation('error', { message });
        this.recordStep('commit', 'failed', message, Date.now() - t0);
        return this.finishReport(title, task, false, edits, codeActResults, loop, commit, snapshot, startedAt);
      }
    } else {
      ok = true;
    }

    // Bước 6: snapshot cuối phiên + complete.
    snapshot = this.session.snapshot();
    this.session.complete(`task ${ok ? 'ok' : 'failed'}: ${title}`);
    return this.finishReport(title, task, ok, edits, codeActResults, loop, commit, snapshot, startedAt);
  }

  private finishReport(
    title: string,
    task: string,
    ok: boolean,
    edits: V10EditApplyResult[],
    codeActResults: V10CodeActResult[],
    loop: V9LoopResult | undefined,
    commit: V9AtomicCommit | undefined,
    snapshot: V10SessionSnapshot | undefined,
    startedAt: number,
  ): V10AgentReport {
    const combinedDiff = edits.map((e) => e.diff).filter((d) => d !== '').join('\n');
    return {
      sessionId: this.session.sessionId,
      title,
      task,
      ok,
      steps: [...this.steps],
      edits,
      codeActResults,
      ...(loop ? { loop } : {}),
      ...(commit ? { commit } : {}),
      ...(snapshot ? { snapshot } : {}),
      combinedDiff,
      totalDurationMs: Date.now() - startedAt,
    };
  }
}

/** Lỗi khi tạo agent v10 mà thiếu plan provider (để host thấy sớm). */
export function v10AgentError(message: string): CodingV10Error {
  return new CodingV10Error('session-not-found', message);
}
