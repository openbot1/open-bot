/**
 * Coding agent v9 (v1.17, Đội T4) — pipeline coding task.
 *
 * Nối coding agent v8 (v1.16) và 4 lớp mới của v9 thành một pipeline:
 *
 *   1. plan: `planProvider` (host/model tiêm) nhận task + repo context
 *      → danh sách `V9EditOperation` (AST-aware: thay symbol cụ thể).
 *      Agent KHÔNG tự đoán nội dung đổi — model/host quyết định.
 *   2. edit: áp từng edit bằng `applyV9AstEdit` (verify parse lại +
 *      diff tối thiểu từng edit; edit nào lỗi thì dừng, không commit
 *      nửa vời).
 *   3. verify: chạy sandbox execution loop (`runV9SandboxLoop`) với
 *      `verifyCommands` do host cho (vd `node --test`, `tsc`):
 *      verify fail thì loop tự sửa lại bằng `fixProvider` (host tiêm;
 *      mặc định: không sửa, chỉ báo fail sau vòng 1).
 *   4. commit: verify xanh → commit atomic từng file đã đổi (mỗi
 *      file = 1 commit, message tự sinh từ diff) — đúng tinh thần
 *      git-first của Aider.
 *   5. draft PR: sinh description từ lịch sử commit của task (khi
 *      caller cho `baseRef` + muốn PR).
 *
 * Mọi bước ghi vào `report.steps` (kèm thời gian) để host/UI hiển
 * thị tiến trình và debug. Agent không gọi model thật, không gọi
 * mạng, không push lên remote — chỉ làm việc trong workingDir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyV9AstEdit } from './astEdit';
import { generateV9DraftPrDescription, commitV9Atomic, v9CommitLogSince, v9GitStatus } from './gitAtomic';
import { runV9SandboxLoop } from './sandboxLoop';
import type { V9LoopFixProvider } from './sandboxLoop';
import { CodingV9Error } from './types';
import type {
  V9AgentReport,
  V9AgentStep,
  V9AtomicCommit,
  V9DraftPr,
  V9EditOperation,
  V9EditResult,
  V9LoopResult,
} from './types';

/** Provider lập plan: task + repo context → danh sách edit AST-aware. */
export type V9PlanProvider = (input: {
  task: string;
  repoContext: string;
}) => Promise<V9EditOperation[]> | V9EditOperation[];

/** Provider sửa lỗi trong sandbox loop (nhận lỗi, trả về edit sửa). */
export type V9FixEditProvider = (
  round: number,
  failureExcerpt: string,
) => Promise<V9EditOperation[] | null> | V9EditOperation[] | null;

export interface CodingAgentV9Options {
  /** Working dir = repo root (cũng là root của AST edit + git + loop). */
  workingDir: string;
  /** Plan provider (bắt buộc để pipeline có đổi gì đó để làm). */
  planProvider: V9PlanProvider;
  /** Lệnh verify chạy sau edit (mảng argv, không shell). Mặc định: không verify. */
  verifyCommands?: string[][];
  /** Số vòng sandbox loop tối đa. Mặc định 5. */
  maxRounds?: number;
  /** Timeout mỗi lệnh verify, ms. */
  commandTimeoutMs?: number;
  /** Fix provider cho sandbox loop (sửa theo lỗi verify). */
  fixProvider?: V9FixEditProvider;
  /** Có commit atomic sau khi verify xanh hay không. Mặc định true. */
  autoCommit?: boolean;
  /** Có sinh draft-PR description hay không (cần baseRef). Mặc định false. */
  draftPr?: boolean;
  /** Ref cơ sở để tính draft-PR (vd `HEAD` trước khi chạy task). */
  baseRef?: string;
  /** Nhánh đích của draft-PR (mặc định `main`). */
  baseBranch?: string;
  /** Tóm tắt thay đổi (dùng cho commit message + PR title). */
  summary?: string;
}

/**
 * Agent v9: một instance = một task. Tạo mới cho mỗi task để report
 * + trạng thái không lẫn nhau.
 */
export class CodingAgentV9 {
  readonly workingDir: string;
  private readonly planProvider: V9PlanProvider;
  private readonly verifyCommands: string[][];
  private readonly maxRounds: number;
  private readonly commandTimeoutMs?: number;
  private readonly fixProvider?: V9FixEditProvider;
  private readonly autoCommit: boolean;
  private readonly draftPrEnabled: boolean;
  private readonly baseRef?: string;
  private readonly baseBranch: string;
  private readonly summary?: string;
  private readonly steps: V9AgentStep[] = [];

  constructor(options: CodingAgentV9Options) {
    this.workingDir = path.resolve(options.workingDir);
    this.planProvider = options.planProvider;
    this.verifyCommands = options.verifyCommands ?? [];
    this.maxRounds = options.maxRounds ?? 5;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.fixProvider = options.fixProvider;
    this.autoCommit = options.autoCommit ?? true;
    this.draftPrEnabled = options.draftPr ?? false;
    this.baseRef = options.baseRef;
    this.baseBranch = options.baseBranch ?? 'main';
    this.summary = options.summary;
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  private recordStep(name: string, status: V9AgentStep['status'], detail: string, durationMs: number): void {
    this.steps.push({ name, status, detail, durationMs });
  }

  /** Repo context ngắn cho plan provider: danh sách file + git status. */
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
    return lines.join('\n');
  }

  /**
   * Chạy một task đầy đủ: plan → AST edit → sandbox loop verify →
   * atomic commit → draft-PR (tùy chọn). Trả về report đầy đủ; khi
   * một bước lỗi thì report.ok=false kèm bước lỗi (không throw, trừ
   * khi plan provider throw — lúc đó report vẫn trả về với bước lỗi).
   */
  async runTask(title: string, task: string): Promise<V9AgentReport> {
    const startedAt = Date.now();
    const edits: V9EditResult[] = [];
    let loop: V9LoopResult | undefined;
    let commit: V9AtomicCommit | undefined;
    let draftPr: V9DraftPr | undefined;
    let ok = false;

    // Bước 1: plan.
    let operations: V9EditOperation[] = [];
    try {
      const t0 = Date.now();
      operations = await this.planProvider({ task, repoContext: this.buildRepoContext() });
      this.recordStep('plan', 'ok', `${operations.length} edit operation(s) planned.`, Date.now() - t0);
    } catch (err) {
      this.recordStep('plan', 'failed', err instanceof Error ? err.message : String(err), 0);
      return this.finishReport(title, task, false, edits, loop, commit, draftPr, startedAt);
    }
    if (operations.length === 0) {
      this.recordStep('plan', 'skipped', 'Plan provider returned no operations — nothing to do.', 0);
      return this.finishReport(title, task, true, edits, loop, commit, draftPr, startedAt);
    }

    // Bước 2: AST-aware edit từng operation.
    let editFailed = false;
    for (const op of operations) {
      const t0 = Date.now();
      try {
        const result = applyV9AstEdit(op, { workingDir: this.workingDir });
        edits.push(result);
        this.recordStep(
          'ast-edit',
          'ok',
          `${op.kind} ${op.path}${op.symbolName ? `:${op.symbolName}` : ''} ` +
            `(+${result.linesAdded}/-${result.linesRemoved})${result.usedFallback ? ' [fallback]' : ''}`,
          Date.now() - t0,
        );
      } catch (err) {
        this.recordStep(
          'ast-edit',
          'failed',
          `${op.kind} ${op.path}${op.symbolName ? `:${op.symbolName}` : ''}: ${err instanceof Error ? err.message : String(err)}`,
          Date.now() - t0,
        );
        editFailed = true;
        break;
      }
    }
    if (editFailed) {
      return this.finishReport(title, task, false, edits, loop, commit, draftPr, startedAt);
    }

    // Bước 3: sandbox loop verify (khi có lệnh verify).
    if (this.verifyCommands.length > 0) {
      const t0 = Date.now();
      const fixEdits = this.fixProvider;
      const loopFix: V9LoopFixProvider | undefined = fixEdits
        ? async (round, failure) => {
            const fixOps = await fixEdits(round, failure);
            if (!fixOps || fixOps.length === 0) return 'No fix operations provided.';
            for (const op of fixOps) {
              const r = applyV9AstEdit(op, { workingDir: this.workingDir });
              edits.push(r);
            }
            return `Applied ${fixOps.length} fix edit(s) in round ${round}.`;
          }
        : undefined;
      try {
        // Vòng 1 của loop không cần edit lại (edit đã áp ở bước 2);
        // fixProvider bên dưới áp edit sửa lỗi sau mỗi vòng fail.
        // editProvider của loop chỉ dùng khi host muốn tự áp edit ở
        // đầu mỗi vòng (mặc định: không áp, trả null).
        loop = await runV9SandboxLoop({
          workingDir: this.workingDir,
          maxRounds: this.maxRounds,
          verifyCommands: this.verifyCommands,
          commandTimeoutMs: this.commandTimeoutMs,
          firstRoundNote: 'verify initial edits',
          fixProvider: loopFix,
        });
        this.recordStep(
          'sandbox-loop',
          loop.passed ? 'ok' : 'failed',
          `Verify ${loop.passed ? 'passed' : 'failed'} after ${loop.roundsUsed} round(s) (${loop.stopReason}).`,
          Date.now() - t0,
        );
      } catch (err) {
        this.recordStep('sandbox-loop', 'failed', err instanceof Error ? err.message : String(err), Date.now() - t0);
        return this.finishReport(title, task, false, edits, loop, commit, draftPr, startedAt);
      }
      if (!loop.passed) {
        return this.finishReport(title, task, false, edits, loop, commit, draftPr, startedAt);
      }
    } else {
      this.recordStep('sandbox-loop', 'skipped', 'No verify commands configured.', 0);
    }

    // Bước 4: atomic commit từng file đã đổi.
    if (this.autoCommit) {
      const t0 = Date.now();
      const files = [...new Set(edits.map((e) => e.path))];
      try {
        const status = await v9GitStatus({ workingDir: this.workingDir });
        if (status.clean && files.length === 0) {
          this.recordStep('commit', 'skipped', 'Working tree clean — nothing to commit.', Date.now() - t0);
        } else {
          commit = await commitV9Atomic({
            workingDir: this.workingDir,
            files,
            summary: this.summary ?? title,
            task,
            roundsUsed: loop?.roundsUsed,
          });
          this.recordStep(
            'commit',
            'ok',
            `Atomic commit ${commit.shortSha}: ${commit.files.length} file(s), +${commit.totalAdded}/-${commit.totalRemoved}.`,
            Date.now() - t0,
          );
        }
      } catch (err) {
        this.recordStep('commit', 'failed', err instanceof Error ? err.message : String(err), Date.now() - t0);
        return this.finishReport(title, task, false, edits, loop, commit, draftPr, startedAt);
      }
    } else {
      this.recordStep('commit', 'skipped', 'autoCommit is off.', 0);
    }

    // Bước 5: draft-PR description (tùy chọn).
    if (this.draftPrEnabled && this.baseRef) {
      const t0 = Date.now();
      try {
        const commits = await v9CommitLogSince(this.workingDir, this.baseRef);
        const status = await v9GitStatus({ workingDir: this.workingDir });
        draftPr = generateV9DraftPrDescription({
          commits,
          headBranch: status.branch || 'v117-coding',
          baseBranch: this.baseBranch,
          summary: this.summary ?? title,
          testSummary: loop
            ? `Sandbox loop: ${loop.passed ? 'passed' : 'failed'} after ${loop.roundsUsed} round(s).`
            : 'No verify commands configured.',
        });
        this.recordStep('draft-pr', 'ok', `Draft PR "${draftPr.title}" (${draftPr.commitCount} commit(s)).`, Date.now() - t0);
      } catch (err) {
        this.recordStep('draft-pr', 'failed', err instanceof Error ? err.message : String(err), Date.now() - t0);
      }
    } else if (this.draftPrEnabled) {
      this.recordStep('draft-pr', 'skipped', 'No baseRef — cannot build commit range for draft PR.', 0);
    }

    ok = true;
    return this.finishReport(title, task, ok, edits, loop, commit, draftPr, startedAt);
  }

  private finishReport(
    title: string,
    task: string,
    ok: boolean,
    edits: V9EditResult[],
    loop: V9LoopResult | undefined,
    commit: V9AtomicCommit | undefined,
    draftPr: V9DraftPr | undefined,
    startedAt: number,
  ): V9AgentReport {
    const combinedDiff = edits.map((e) => e.diff).filter((d) => d !== '').join('\n');
    return {
      title,
      task,
      ok,
      steps: [...this.steps],
      edits,
      loop,
      commit,
      draftPr,
      combinedDiff,
      totalDurationMs: Date.now() - startedAt,
    };
  }
}

/** Lỗi khi agent v9 không thể chạy task (dùng cho host phân biệt). */
export function v9AgentError(message: string): CodingV9Error {
  return new CodingV9Error('verify-failed', message);
}
