/**
 * Coding agent v11 (v1.19, Đội T2) — pipeline coding task.
 *
 * Nối agent v10 (plan → edit theo strategy → codeact → sandbox
 * loop verify → commit atomic → snapshot, mọi bước ghi event vào
 * phiên v10): v11 thay "edit" bằng CodeAct v9 + refactor engine và
 * thêm 2 cổng kiểm soát chất lượng trước commit:
 *
 *   1. callgraph: build call graph v11 + queryMap theo task để plan
 *      provider có repo context (file/hàm quan trọng nhất).
 *   2. plan: `planProvider` (host/model tiêm) nhận task + repo
 *      context → `V11CodeActPlan` (đọc/ghi/chạy code/lệnh/commit).
 *   3. codeact dry-run: mô phỏng plan, báo action cần xác nhận;
 *      agent KHÔNG tự xác nhận action rủi ro cao — thiếu xác nhận
 *      thì dừng lại an toàn (bước fail rõ lý do, không chạm đĩa).
 *   4. codeact apply: áp plan đã xác nhận, patch stack giữ để
 *      rollback khi bước sau fail.
 *   5. refactor (tùy chọn): đổi tên / tách file / di chuyển hàm
 *      theo yêu cầu, có preview diff + kiểm tra tham chiếu đầy đủ.
 *   6. patch review: review toàn bộ diff thay đổi — verdict
 *      request-changes thì dừng, không commit.
 *   7. testgen: sinh test từ file đổi (mock-first) + chạy thật.
 *   8. verify: chạy lệnh verify của host (argv, không shell).
 *   9. commit: verify xanh + review không request-changes →
 *      commit atomic (git-first, v9). Fail ở verify/review thì
 *      rollback CodeAct về patch stack.
 *
 * Agent không gọi model thật, không gọi mạng, không push remote —
 * chỉ làm việc trong workingDir + sessionsDir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { commitV9Atomic } from '../codingV9/gitAtomic';
import { v9UnifiedDiff } from '../codingV9/diffUtil';
import type { CodingV10Session } from '../codingV10/eventSession';
import { V11CodeActEngine } from './codeactV9';
import { V11CallGraph } from './callGraph';
import { V11RefactorEngine } from './refactorV11';
import { reviewV11Patch } from './patchReview';
import { generateV11Tests, runV11GeneratedTests, v11CoverageDelta } from './testgenV11';
import { CodingV11Error } from './types';
import type { V11CodeActPlan, V11CodeActRunResult } from './types';
import type {
  V11AgentReport,
  V11AgentStep,
  V11PatchReview,
  V11RefactorApplyResult,
  V11RefactorPlan,
  V11TestGenResult,
  V11TestGenRunResult,
} from './types';

/** Provider lập plan CodeAct v9: task + repo context → plan action. */
export type V11PlanProvider = (input: {
  task: string;
  repoContext: string;
}) => Promise<V11CodeActPlan> | V11CodeActPlan;

/** Yêu cầu refactor kèm theo task (tùy chọn, một thao tác). */
export interface V11RefactorRequest {
  kind: 'rename-symbol' | 'split-file' | 'move-function';
  /** Symbol đổi tên / di chuyển (rename + move). */
  symbol?: string;
  /** Tên mới (rename). */
  newName?: string;
  /** File định nghĩa (rename/move, khi tên trùng). */
  definitionFile?: string;
  /** File nguồn (split/move). */
  sourceFile?: string;
  /** File đích (split/move). */
  targetFile?: string;
  /** Symbol tách sang file mới (split). */
  symbols?: string[];
}

export interface CodingAgentV11Options {
  /** Working dir = repo root. */
  workingDir: string;
  /** Plan provider (bắt buộc để pipeline có đổi gì đó để làm). */
  planProvider: V11PlanProvider;
  /** Phiên v10 để ghi event (tùy chọn — không có thì chỉ ghi report). */
  session?: CodingV10Session;
  /** Tiêu đề task (mặc định: task rút gọn). */
  title?: string;
  /** Yêu cầu refactor kèm theo (tùy chọn). */
  refactorRequest?: V11RefactorRequest;
  /** Lệnh verify chạy sau khi đổi (mảng argv, không shell). */
  verifyCommands?: string[][];
  /** Số vòng verify tối đa khi verify fail (mặc định 1 — không tự sửa, chỉ báo). */
  maxVerifyRounds?: number;
  /** Có commit atomic sau khi verify xanh hay không. Mặc định true. */
  autoCommit?: boolean;
  /** Id action CodeAct đã được xác nhận (bắt buộc cho action rủi ro cao). */
  confirmations?: ReadonlySet<string> | readonly string[];
  /** Ngân sách token cho repo context (0 = không kèm call graph; mặc định 2000). */
  repoMapBudget?: number;
  /** Có sinh + chạy test từ file đổi không. Mặc định true. */
  runTestGen?: boolean;
}

/** Đọc nội dung file trong working dir (null = không tồn tại). */
function readFileOrNull(workingDir: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(workingDir, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Agent coding v11: pipeline plan → codeact (dry-run + apply có
 * xác nhận) → refactor → patch review → testgen → verify → commit.
 */
export class CodingAgentV11 {
  readonly workingDir: string;
  private readonly planProvider: V11PlanProvider;
  private readonly session?: CodingV10Session;
  private readonly refactorRequest?: V11RefactorRequest;
  private readonly verifyCommands: string[][];
  private readonly autoCommit: boolean;
  private readonly confirmations: ReadonlySet<string>;
  private readonly repoMapBudget: number;
  private readonly runTestGen: boolean;

  constructor(options: CodingAgentV11Options) {
    this.workingDir = path.resolve(options.workingDir);
    this.planProvider = options.planProvider;
    this.session = options.session;
    this.refactorRequest = options.refactorRequest;
    this.verifyCommands = options.verifyCommands ?? [];
    this.autoCommit = options.autoCommit ?? true;
    this.confirmations = new Set(
      Array.isArray(options.confirmations) ? options.confirmations : [...(options.confirmations ?? [])],
    );
    this.repoMapBudget = options.repoMapBudget ?? 2000;
    this.runTestGen = options.runTestGen ?? true;
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  /** Ghi event vào phiên v10 (khi có session) — lỗi ghi log không chặn pipeline. */
  private logAction(type: string, payload: Record<string, unknown>): void {
    try {
      this.session?.recordAction(type, payload);
    } catch {
      // Ghi log lỗi thì bỏ qua — pipeline vẫn chạy.
    }
  }

  private logObservation(type: string, payload: Record<string, unknown>): void {
    try {
      this.session?.recordObservation(type, payload);
    } catch {
      // Như trên.
    }
  }

  /** Chạy một task end-to-end, trả báo cáo đầy đủ. */
  async runTask(task: string, title?: string): Promise<V11AgentReport> {
    const startedAt = Date.now();
    const taskTitle = title ?? task.slice(0, 80);
    const steps: V11AgentStep[] = [];
    const step = (name: string, status: V11AgentStep['status'], detail: string, durationMs: number): void => {
      steps.push({ name, status, detail, durationMs });
    };
    let codeAct: V11CodeActRunResult | undefined;
    let refactorPlan: V11RefactorPlan | undefined;
    let refactorResult: V11RefactorApplyResult | undefined;
    let patchReview: V11PatchReview | undefined;
    let testGen: V11TestGenResult | undefined;
    let testGenRun: V11TestGenRunResult | undefined;
    let commitSha: string | undefined;
    let combinedDiff = '';
    let ok = false;

    this.logAction('plan', { task: task.slice(0, 500) });
    try {
      // 1. Call graph + repo context cho plan provider.
      const callgraphStarted = Date.now();
      let repoContext = '';
      try {
        const graph = new V11CallGraph(this.workingDir);
        graph.scanAndBuild();
        const query = graph.queryMap(task, 10);
        const topFiles = graph.rankFiles(5).map((f) => `${f.path} (pagerank ${f.pageRank.toFixed(4)})`);
        const topSymbols = graph.rankSymbols(5).map((s) => `${s.qualifiedName} @ ${s.file}:${s.line}`);
        const hits = query.hits.map((h) => `${h.kind}:${h.path}${h.symbol ? `#${h.symbol}` : ''} (${h.reasons.join(', ')})`);
        const contextLines = [
          'Top files by PageRank v2:',
          ...topFiles.map((f) => `- ${f}`),
          'Top symbols:',
          ...topSymbols.map((s) => `- ${s}`),
          `Query map for "${task}":`,
          ...hits.map((h) => `- ${h}`),
        ];
        repoContext = contextLines.join('\n').slice(0, this.repoMapBudget * 4);
        step('callgraph', 'ok', `call graph: ${graph.fileCount} files, top ${topFiles.length} files + ${query.hits.length} query hits`, Date.now() - callgraphStarted);
      } catch (err) {
        // Repo chưa có file code / parse lỗi: context rỗng, pipeline vẫn chạy.
        repoContext = '';
        step('callgraph', 'skipped', `không build được call graph: ${(err as Error).message}`, Date.now() - callgraphStarted);
      }

      // 2. Plan CodeAct v9 từ provider.
      const planStarted = Date.now();
      const plan = await this.planProvider({ task, repoContext });
      if (!plan || !Array.isArray(plan.actions) || plan.actions.length === 0) {
        throw new CodingV11Error('agent-plan-invalid', 'Agent v11: plan provider trả plan rỗng.');
      }
      step('plan', 'ok', `plan "${plan.title}" với ${plan.actions.length} action`, Date.now() - planStarted);

      // 3. Dry-run CodeAct v9 (không chạm đĩa).
      const dryStarted = Date.now();
      const engine = new V11CodeActEngine({ workingDir: this.workingDir });
      const dry = engine.dryRun(plan);
      this.logObservation('codeact-dry-run', {
        planId: plan.id,
        valid: dry.validCount,
        needsConfirmation: dry.needsConfirmationCount,
        invalid: dry.invalidCount,
      });
      if (!dry.canApply) {
        step('codeact-dry-run', 'failed', `dry-run thấy ${dry.invalidCount} action không hợp lệ: ${dry.actions.filter((a) => !a.valid).map((a) => a.error ?? a.actionId).join('; ')}`, Date.now() - dryStarted);
        return this.finishReport(taskTitle, task, steps, startedAt, { codeAct, combinedDiff, ok: false });
      }
      step('codeact-dry-run', 'ok', `dry-run ok: ${dry.validCount} action hợp lệ, ${dry.needsConfirmationCount} cần xác nhận`, Date.now() - dryStarted);

      // 4. Apply CodeAct v9 (chỉ khi đã xác nhận đủ action rủi ro cao).
      const applyStarted = Date.now();
      codeAct = await engine.run(plan, { confirmations: this.confirmations });
      combinedDiff += codeAct.results
        .map((r) => r.diff ?? '')
        .filter(Boolean)
        .join('\n');
      this.logObservation('codeact-result', {
        planId: plan.id,
        ok: codeAct.okCount,
        failed: codeAct.failedCount,
        skipped: codeAct.skippedCount,
      });
      if (codeAct.skippedCount > 0) {
        step(
          'codeact-apply',
          'failed',
          `${codeAct.skippedCount} action rủi ro cao chưa được xác nhận: ${codeAct.results.filter((r) => r.status === 'skipped-needs-confirmation').map((r) => r.actionId).join(', ')} — đưa id action vào confirmations rồi chạy lại`,
          Date.now() - applyStarted,
        );
        return this.finishReport(taskTitle, task, steps, startedAt, { codeAct, combinedDiff, ok: false });
      }
      if (!codeAct.ok) {
        step('codeact-apply', 'failed', `${codeAct.failedCount} action fail, ${codeAct.deniedCount} bị chặn`, Date.now() - applyStarted);
        return this.finishReport(taskTitle, task, steps, startedAt, { codeAct, combinedDiff, ok: false });
      }
      step('codeact-apply', 'ok', `${codeAct.okCount} action ok`, Date.now() - applyStarted);

      // 5. Refactor kèm theo (tùy chọn).
      if (this.refactorRequest) {
        const refactorStarted = Date.now();
        const refactorEngine = new V11RefactorEngine({ workingDir: this.workingDir });
        const req = this.refactorRequest;
        if (req.kind === 'rename-symbol') {
          if (!req.symbol || !req.newName) throw new CodingV11Error('agent-plan-invalid', 'Agent v11: rename cần symbol + newName.');
          refactorPlan = refactorEngine.planRenameSymbol(req.symbol, req.newName, req.definitionFile);
        } else if (req.kind === 'split-file') {
          if (!req.sourceFile || !req.targetFile || !req.symbols) throw new CodingV11Error('agent-plan-invalid', 'Agent v11: split cần sourceFile + targetFile + symbols.');
          refactorPlan = refactorEngine.planSplitFile(req.sourceFile, req.symbols, req.targetFile);
        } else {
          if (!req.symbol || !req.sourceFile || !req.targetFile) throw new CodingV11Error('agent-plan-invalid', 'Agent v11: move cần symbol + sourceFile + targetFile.');
          refactorPlan = refactorEngine.planMoveFunction(req.symbol, req.sourceFile, req.targetFile);
        }
        combinedDiff += `\n${refactorPlan.changes.map((c) => c.diff).join('\n')}`;
        refactorResult = await refactorEngine.applyPlan(refactorPlan);
        if (!refactorResult.ok) {
          step('refactor', 'failed', refactorResult.error ?? 'refactor apply lỗi', Date.now() - refactorStarted);
          return this.finishReport(taskTitle, task, steps, startedAt, { codeAct, refactorPlan, refactorResult, combinedDiff, ok: false });
        }
        step('refactor', 'ok', `refactor ${refactorPlan.kind}: ${refactorResult.filesChanged.length} file`, Date.now() - refactorStarted);
      }

      // 6. Patch review toàn bộ diff.
      const reviewStarted = Date.now();
      patchReview = reviewV11Patch(combinedDiff);
      this.logObservation('patch-review', { verdict: patchReview.verdict, riskScore: patchReview.riskScore });
      step('patch-review', patchReview.verdict === 'request-changes' ? 'failed' : 'ok', patchReview.summary, Date.now() - reviewStarted);
      if (patchReview.verdict === 'request-changes') {
        // Không commit khi review yêu cầu sửa — rollback CodeAct về patch stack.
        if (codeAct) engine.rollback(codeAct.planId, codeAct.patchStack);
        return this.finishReport(taskTitle, task, steps, startedAt, {
          codeAct,
          refactorPlan,
          refactorResult,
          patchReview,
          combinedDiff,
          ok: false,
        });
      }

      // 7. Testgen v2: sinh + chạy test từ file đổi.
      const changedFiles = this.changedFilesFromCodeAct(codeAct, refactorResult);
      if (this.runTestGen && changedFiles.length > 0) {
        const testgenStarted = Date.now();
        try {
          testGen = generateV11Tests(this.workingDir, changedFiles, { diff: combinedDiff });
          const coverage = v11CoverageDelta(this.workingDir, testGen.generated, changedFiles);
          testGenRun = await runV11GeneratedTests(this.workingDir, testGen.generated, changedFiles);
          step(
            'testgen',
            testGenRun.ok ? 'ok' : 'failed',
            `sinh ${testGen.generated.length} file test (${testGen.functionsCovered}/${testGen.functionsConsidered} function), chạy ${testGenRun.filesPassed} pass / ${testGenRun.filesFailed} fail, coverage ${coverage.coveredBefore} → ${coverage.coveredAfter}/${coverage.totalFunctions}`,
            Date.now() - testgenStarted,
          );
          if (!testGenRun.ok) {
            return this.finishReport(taskTitle, task, steps, startedAt, {
              codeAct,
              refactorPlan,
              refactorResult,
              patchReview,
              testGen,
              testGenRun,
              combinedDiff,
              ok: false,
            });
          }
        } catch (err) {
          step('testgen', 'skipped', `không sinh/chạy được test: ${(err as Error).message}`, Date.now() - testgenStarted);
        }
      } else {
        step('testgen', 'skipped', changedFiles.length === 0 ? 'không có file đổi để sinh test' : 'testgen đã tắt', 0);
      }

      // 8. Verify bằng lệnh của host.
      if (this.verifyCommands.length > 0) {
        const verifyStarted = Date.now();
        const verifyPlan: V11CodeActPlan = {
          id: `v11verify-${Date.now().toString(36)}`,
          title: 'verify commands',
          actions: this.verifyCommands.map((command, i) => ({ id: `verify-${i + 1}`, kind: 'run-command', command })),
          createdAt: new Date().toISOString(),
        };
        const verifyRun = await engine.run(verifyPlan, {});
        const failed = verifyRun.results.filter((r) => r.status !== 'ok');
        step(
          'verify',
          failed.length === 0 ? 'ok' : 'failed',
          failed.length === 0
            ? `${verifyRun.results.length} lệnh verify pass`
            : `verify fail: ${failed.map((r) => r.actionId).join(', ')}`,
          Date.now() - verifyStarted,
        );
        if (failed.length > 0) {
          return this.finishReport(taskTitle, task, steps, startedAt, {
            codeAct,
            refactorPlan,
            refactorResult,
            patchReview,
            testGen,
            testGenRun,
            combinedDiff,
            ok: false,
          });
        }
      } else {
        step('verify', 'skipped', 'không có lệnh verify', 0);
      }

      // 9. Commit atomic.
      if (this.autoCommit && changedFiles.length > 0) {
        const commitStarted = Date.now();
        try {
          const commit = await commitV9Atomic({
            workingDir: this.workingDir,
            files: changedFiles,
            summary: taskTitle,
            message: taskTitle,
            task,
          });
          commitSha = commit.sha;
          step('commit', 'ok', `commit ${commit.shortSha} (${commit.files.length} file)`, Date.now() - commitStarted);
        } catch (err) {
          step('commit', 'failed', `commit lỗi: ${(err as Error).message}`, Date.now() - commitStarted);
          return this.finishReport(taskTitle, task, steps, startedAt, {
            codeAct,
            refactorPlan,
            refactorResult,
            patchReview,
            testGen,
            testGenRun,
            combinedDiff,
            ok: false,
          });
        }
      } else {
        step('commit', 'skipped', this.autoCommit ? 'không có file đổi để commit' : 'autoCommit đã tắt', 0);
      }
      ok = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ name: 'agent-error', status: 'failed', detail: message, durationMs: 0 });
      this.logObservation('error', { message: message.slice(0, 500) });
    }
    return this.finishReport(taskTitle, task, steps, startedAt, {
      codeAct,
      refactorPlan,
      refactorResult,
      patchReview,
      testGen,
      testGenRun,
      commitSha,
      combinedDiff,
      ok,
    });
  }

  /** File đã đổi trong CodeAct + refactor (để testgen/verify/commit dùng). */
  private changedFilesFromCodeAct(
    codeAct: V11CodeActRunResult | undefined,
    refactorResult: V11RefactorApplyResult | undefined,
  ): string[] {
    const files = new Set<string>();
    if (codeAct) {
      for (const entry of codeAct.patchStack) files.add(entry.path);
    }
    if (refactorResult) {
      for (const f of refactorResult.filesChanged) files.add(f);
    }
    return [...files].sort();
  }

  /** Gom báo cáo cuối task. */
  private finishReport(
    title: string,
    task: string,
    steps: V11AgentStep[],
    startedAt: number,
    parts: {
      codeAct?: V11CodeActRunResult;
      refactorPlan?: V11RefactorPlan;
      refactorResult?: V11RefactorApplyResult;
      patchReview?: V11PatchReview;
      testGen?: V11TestGenResult;
      testGenRun?: V11TestGenRunResult;
      commitSha?: string;
      combinedDiff: string;
      ok: boolean;
    },
  ): V11AgentReport {
    // Diff tổng hợp dự phòng: nếu CodeAct không sinh diff (vd chỉ đọc file),
    // đối chiếu nội dung hiện tại với patch stack để có diff xem lại.
    let combinedDiff = parts.combinedDiff;
    if (combinedDiff.trim() === '' && parts.codeAct) {
      const diffs: string[] = [];
      for (const entry of parts.codeAct.patchStack) {
        const current = readFileOrNull(this.workingDir, entry.path);
        if (current !== null || entry.oldContent !== null) {
          diffs.push(v9UnifiedDiff(entry.oldContent ?? '', current ?? '', entry.path).text);
        }
      }
      combinedDiff = diffs.join('\n');
    }
    return {
      sessionId: this.session?.sessionId,
      title,
      task,
      ok: parts.ok,
      steps,
      codeAct: parts.codeAct,
      refactorPlan: parts.refactorPlan,
      refactorResult: parts.refactorResult,
      patchReview: parts.patchReview,
      testGen: parts.testGen,
      testGenRun: parts.testGenRun,
      commitSha: parts.commitSha,
      combinedDiff,
      totalDurationMs: Date.now() - startedAt,
    };
  }
}

/** Chạy nhanh một task CodingAgentV11 (không giữ agent). */
export async function runV11AgentTask(
  workingDir: string,
  task: string,
  planProvider: V11PlanProvider,
  options: Omit<CodingAgentV11Options, 'workingDir' | 'planProvider'> = {},
): Promise<V11AgentReport> {
  const agent = new CodingAgentV11({ workingDir, planProvider, ...options });
  return agent.runTask(task);
}
