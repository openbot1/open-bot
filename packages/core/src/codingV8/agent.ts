/**
 * Coding agent v8 (v1.16, Đội T4) — pipeline coding task.
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.16 §5): agent = hàm thuần
 * history → next Action; ConversationState duy nhất mutable; EventLog
 * append-only là single source of truth (replay/fork/pause/audit
 * miễn phí). Agent v8 DÙNG LẠI log event v7 (`CodingV7Log`) làm
 * single source of truth — không viết log mới — và chạy pipeline:
 *
 *   1. scan repo (repo map v3) → query top symbol/file liên quan task
 *   2. security scan v2 trên repo (taint + secret + dependency)
 *   3. plan refactor (do `changeProvider` tiêm — host/model quyết
 *      định đổi gì; agent không tự đoán nội dung đổi) → preview diff
 *   4. APPROVAL GATE: dừng ở `awaiting-approval`, chờ user approve
 *      qua `approveAndApply()` — KHÔNG tự ghi file khi chưa approve
 *   5. apply (backup + verify) → verify fail thì rollback tự động
 *   6. sinh test cho file đã đổi → chạy test sinh ra → báo coverage delta
 *
 * Mọi bước ghi event vào log v7 (dùng các type event v7 có sẵn,
 * payload mang chi tiết v8) nên replay/fork/pause/resume/audit của
 * v7 dùng được ngay cho v8. Agent không gọi model thật: `generate`
 * chỉ dùng để gợi ý mô tả change khi host muốn (mặc định pipeline
 * chạy bằng `changeProvider` do host tiêm).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV7Log } from '../codingV7/conversationLog';
import { V8CodeActExecutor, defaultV8SandboxPolicy } from './codeactV4';
import { applyV8RefactorPlan, createV8RefactorPlan, previewV8Diff, summarizeV8Plan, v8PlanWithStatus } from './refactor';
import { V8RepoMap, queryV8Repo } from './repoMap';
import { scanV8Security } from './securityV2';
import { generateV8TestsForFile, runV8GeneratedTests, v8CoverageDeltaForFile } from './testgen';
import type { V8DiffPreview, V8RefactorPlan, V8StepReport, V8TaskReport } from './types';

/** Timeout mặc định cho verify, ms. */
export const V8_AGENT_DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

/** Input change cho một file trong refactor plan (do host/model cung cấp). */
export interface V8ChangeInput {
  path: string;
  newContent: string;
  description: string;
}

/** Provider đổi code: task + repo context → danh sách change. Host tiêm (model hoặc script). */
export type V8ChangeProvider = (input: {
  task: string;
  repoContext: string;
  securitySummary: string;
}) => Promise<V8ChangeInput[]> | V8ChangeInput[];

/** Verify sau apply: host tiêm (vd chạy `npm run typecheck` / test liên quan). */
export type V8VerifyProvider = (plan: V8RefactorPlan) => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string };

export interface CodingAgentV8Options {
  /** Working dir = repo root (cũng là root của repo map + refactor). */
  workingDir: string;
  /** Change provider (bắt buộc để pipeline có đổi gì đó để plan). */
  changeProvider: V8ChangeProvider;
  /** Verify provider (mặc định: kiểm tra file đọc được). */
  verifyProvider?: V8VerifyProvider;
  /** Tên bước verify (hiển thị trong report). */
  verifyStep?: string;
  /** Executor CodeAct v4 (mặc định: tạo mới với policy strict, không mạng). */
  executor?: V8CodeActExecutor;
  /** Có sinh test cho file đã đổi sau khi apply hay không. Mặc định true. */
  generateTests?: boolean;
  /** Có quét security v2 trước khi plan hay không. Mặc định true. */
  scanSecurity?: boolean;
}

/** Kết quả bước approve + apply (trả về cho host/UI sau khi user bấm approve). */
export interface V8ApprovalResult {
  report: V8TaskReport;
  /** Preview diff đã cho user xem (để UI hiển thị lại). */
  preview?: V8DiffPreview;
}

/**
 * Agent v8: giữ log v7 + pipeline. Một instance = một task; muốn
 * task mới thì tạo agent mới (log mới) hoặc dùng lại log đã fork.
 */
export class CodingAgentV8 {
  readonly log: CodingV7Log;
  readonly workingDir: string;
  private readonly changeProvider: V8ChangeProvider;
  private readonly verifyProvider?: V8VerifyProvider;
  private readonly verifyStep: string;
  private readonly executor: V8CodeActExecutor;
  private readonly generateTests: boolean;
  private readonly scanSecurity: boolean;
  private pendingPlan: V8RefactorPlan | null = null;
  private pendingPreview: V8DiffPreview | null = null;
  private reportSteps: V8StepReport[] = [];
  private title = '';
  private task = '';

  constructor(log: CodingV7Log, options: CodingAgentV8Options) {
    this.log = log;
    this.workingDir = path.resolve(options.workingDir);
    this.changeProvider = options.changeProvider;
    this.verifyProvider = options.verifyProvider;
    this.verifyStep = options.verifyStep ?? 'verify';
    this.executor = options.executor ?? new V8CodeActExecutor({ workingDir: this.workingDir, policy: defaultV8SandboxPolicy() });
    this.generateTests = options.generateTests ?? true;
    this.scanSecurity = options.scanSecurity ?? true;
    fs.mkdirSync(this.workingDir, { recursive: true });
  }

  /** Plan đang chờ approve (null khi chưa tới bước plan). */
  getPendingPlan(): V8RefactorPlan | null {
    return this.pendingPlan ? { ...this.pendingPlan, changes: this.pendingPlan.changes.map((c) => ({ ...c })) } : null;
  }

  /** Preview diff của plan đang chờ approve (null khi chưa có plan). */
  getPendingPreview(): V8DiffPreview | null {
    return this.pendingPreview;
  }

  private pushStep(step: string, ok: boolean, detail: string, metrics?: Record<string, number>): void {
    this.reportSteps.push({ step, ok, detail, metrics });
  }

  /** Bắt đầu task: ghi session.started + user.message vào log v7. */
  startTask(title: string, task: string): void {
    this.title = title;
    this.task = task;
    if (this.log.length === 0) {
      this.log.append('v7.session.started', { title, agent: 'coding-v8' });
    }
    this.log.append('v7.user.message', { text: task });
  }

  /**
   * Chạy pipeline tới approval gate: scan repo → query → security →
   * plan → preview. DỪNG ở đây, chờ user approve (không ghi file).
   * Trả report với `awaitingApproval=true` + plan + preview.
   */
  async runToApproval(): Promise<V8TaskReport> {
    this.reportSteps = [];
    try {
      // 1. Repo map v3: scan + query top symbol/file liên quan task.
      const repoMap = new V8RepoMap(this.workingDir);
      const incremental = repoMap.scanAndUpdate();
      const graph = incremental.graph;
      const query = queryV8Repo(graph, this.task, { limit: 10 });
      const topFiles = query.files.slice(0, 5).map((f) => `${f.file} (${f.score.toFixed(3)}: ${f.reasons.join(',')})`).join('\n');
      const repoContext = [
        `Repo: ${graph.stats.files} file(s), ${graph.stats.symbols} symbol(s), ${graph.stats.edges} edge(s) (calls=${graph.stats.edgesByKind.calls}, imports=${graph.stats.edgesByKind.imports}).`,
        `Top files for task:\n${topFiles}`,
        `Top symbols: ${query.symbols.slice(0, 5).map((s) => `${s.symbol ?? s.nodeId} (${s.score.toFixed(3)})`).join(', ')}`,
      ].join('\n');
      this.pushStep('repo-map', true, `scanned ${graph.stats.files} file(s), ${graph.stats.symbols} symbol(s)`, {
        files: graph.stats.files,
        symbols: graph.stats.symbols,
        edges: graph.stats.edges,
        reparsed: incremental.reparsed.length,
        reused: incremental.reused.length,
      });
      this.log.append('v7.model.message', { text: `Repo map v3: ${graph.stats.files} files, ${graph.stats.symbols} symbols. Top file: ${query.files[0]?.file ?? '(none)'}`, step: 1 });

      // 2. Security scan v2 (trước khi plan — plan phải biết repo có taint/secret không).
      let securitySummary = 'security scan skipped';
      if (this.scanSecurity) {
        const security = scanV8Security(this.workingDir);
        securitySummary = security.summary;
        this.pushStep('security', security.level !== 'block', security.summary, {
          filesScanned: security.filesScanned,
          taintFlows: security.taintFlows.length,
          secrets: security.secrets.length,
          vulnerableDeps: security.dependencies.length,
        });
        this.log.append('v7.security.verdict', { level: security.level, summary: security.summary, agent: 'coding-v8' });
        if (security.level === 'block') {
          const report = this.finishReport(false, false, `security v2 block: ${security.summary}`);
          report.security = security;
          return report;
        }
      }

      // 3. Plan refactor (change do host/model quyết định).
      const changes = await this.changeProvider({ task: this.task, repoContext, securitySummary });
      if (changes.length === 0) {
        this.pushStep('plan', false, 'change provider returned no changes — nothing to refactor');
        this.log.append('v7.turn.finished', { reason: 'no-changes', agent: 'coding-v8' });
        return this.finishReport(false, false);
      }
      const plan = createV8RefactorPlan(this.workingDir, this.title, this.task, changes);
      const preview = previewV8Diff(plan);
      this.pendingPlan = plan;
      this.pendingPreview = preview;
      this.pushStep('plan', true, summarizeV8Plan(plan), {
        files: plan.changes.length,
        linesAdded: preview.linesAdded,
        linesRemoved: preview.linesRemoved,
      });
      this.log.append('v7.action.parsed', { kind: 'edit', planId: plan.id, files: plan.changes.map((c) => c.path), agent: 'coding-v8' });
      this.log.append('v7.session.paused', { reason: 'awaiting-approval', planId: plan.id });
      return this.finishReport(false, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.pushStep('pipeline', false, message);
      this.log.append('v7.error', { message, source: 'coding-v8' });
      return this.finishReport(false, false, message);
    }
  }

  /**
   * User approve plan đang chờ → apply (backup + verify, rollback tự
   * động nếu verify fail) → sinh test + chạy test → report cuối.
   * Gọi sau `runToApproval()`; throw khi chưa có plan chờ approve.
   */
  async approveAndApply(): Promise<V8ApprovalResult> {
    const plan = this.pendingPlan;
    const preview = this.pendingPreview;
    if (!plan) throw new Error('V8 agent: không có plan đang chờ approve — gọi runToApproval() trước');
    this.log.append('v7.session.resumed', { reason: 'user-approved', planId: plan.id });
    const approved = v8PlanWithStatus(plan, 'approved', 'user approved');
    try {
      const { plan: appliedPlan, apply, verify } = await applyV8RefactorPlan(approved, {
        workingDir: this.workingDir,
        verify: this.verifyProvider,
        verifyStep: this.verifyStep,
        onEvent: (event, detail) => {
          this.log.append('v7.file.changed', { ...detail, event, agent: 'coding-v8' });
        },
      });
      this.pushStep('apply', apply.ok, `${apply.files.filter((f) => f.applied).length}/${apply.files.length} file(s) applied`, {
        filesApplied: apply.files.filter((f) => f.applied).length,
      });
      if (verify) {
        this.pushStep('verify', verify.ok, `${verify.step}: ${verify.ok ? 'ok' : 'FAIL'} — ${verify.output.slice(0, 200)}`, {
          verifyMs: verify.durationMs,
        });
      }
      if (appliedPlan.status !== 'verified') {
        const rolledBack = appliedPlan.status === 'rolled-back';
        this.log.append('v7.error', {
          message: 'refactor ' + (rolledBack ? 'rolled back' : 'failed') + ': ' + (appliedPlan.statusNote ?? ''),
          source: 'coding-v8',
        });
        const report = this.finishReport(false, false, appliedPlan.statusNote);
        report.plan = appliedPlan;
        report.rolledBack = rolledBack;
        this.pendingPlan = null;
        this.pendingPreview = null;
        return { report, preview: preview ?? undefined };
      }
      this.log.append('v7.turn.finished', { reason: 'refactor-verified', planId: plan.id, agent: 'coding-v8' });

      // 6. Sinh test cho file đã đổi + chạy test sinh ra.
      let report = this.finishReport(true, false);
      report.plan = appliedPlan;
      if (this.generateTests) {
        report = await this.generateAndRunTests(appliedPlan, report);
      }
      this.pendingPlan = null;
      this.pendingPreview = null;
      return { report, preview: preview ?? undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.pushStep('apply', false, message);
      this.log.append('v7.error', { message, source: 'coding-v8' });
      const report = this.finishReport(false, false, message);
      report.plan = plan;
      this.pendingPlan = null;
      this.pendingPreview = null;
      return { report, preview: preview ?? undefined };
    }
  }

  /** Từ chối plan đang chờ (không ghi file nào). */
  rejectPlan(reason?: string): V8TaskReport {
    const plan = this.pendingPlan;
    if (plan) {
      this.log.append('v7.session.aborted', { reason: reason ?? 'user-rejected-plan', planId: plan.id });
      this.pushStep('plan', false, `plan rejected by user: ${reason ?? 'no reason given'}`);
    }
    this.pendingPlan = null;
    this.pendingPreview = null;
    return this.finishReport(false, false, reason ?? 'plan rejected by user');
  }

  /** Chạy một action CodeAct v4 (qua executor + policy), ghi observation vào log. */
  async runCodeAct(action: Parameters<V8CodeActExecutor['execute']>[0]): Promise<ReturnType<V8CodeActExecutor['execute']>> {
    const result = await this.executor.execute(action);
    this.log.append('v7.observation', {
      kind: action.kind,
      ok: result.observation.ok,
      blocked: result.observation.blocked,
      policy: result.observation.policy,
      securityLevel: result.observation.securityLevel,
      stdout: result.observation.stdout.slice(0, 500),
      agent: 'coding-v8',
    });
    return result;
  }

  private async generateAndRunTests(plan: V8RefactorPlan, report: V8TaskReport): Promise<V8TaskReport> {
    let totalDelta = 0;
    let lastRun: V8TaskReport['testRun'];
    let lastCoverage: V8TaskReport['coverage'];
    for (const change of plan.changes) {
      if (!/\.(ts|js|tsx|jsx)$/.test(change.path)) continue;
      try {
        const testContentBefore = this.readExistingTest(change.path);
        const generated = generateV8TestsForFile(change.path, { rootDir: this.workingDir });
        if (generated.functionsCovered.length === 0) {
          this.pushStep('testgen', true, `${change.path}: no testable exported functions (${generated.functionsUncovered.length} uncovered)`);
          continue;
        }
        // Ghi test sinh ra qua refactor-style backup: ghi trực tiếp vì
        // file test là file MỚI (không ghi đè test người viết — testgen
        // đã đổi tên khi trùng, xem testgen.ts).
        const testAbs = path.join(this.workingDir, generated.testPath);
        if (fs.existsSync(testAbs)) {
          const altPath = generated.testPath.replace(/\.test\.mjs$/, '.v8-generated.test.mjs');
          fs.writeFileSync(path.join(this.workingDir, altPath), generated.content, 'utf8');
          generated.testPath = altPath;
        } else {
          fs.mkdirSync(path.dirname(testAbs), { recursive: true });
          fs.writeFileSync(testAbs, generated.content, 'utf8');
        }
        this.log.append('v7.file.changed', { path: generated.testPath, bytes: generated.content.length, generated: true, agent: 'coding-v8' });
        const coverage = v8CoverageDeltaForFile(generated, this.workingDir, testContentBefore);
        totalDelta += coverage.delta;
        const run = await runV8GeneratedTests(path.join(this.workingDir, generated.testPath), { cwd: this.workingDir });
        lastRun = run;
        lastCoverage = coverage;
        this.pushStep(
          'testgen',
          run.passed,
          `${generated.testPath}: ${run.passedCount}/${run.total} passed, function coverage ${coverage.coveredBefore}→${coverage.coveredAfter} (+${coverage.delta})`,
          { testsPassed: run.passedCount, testsTotal: run.total, coverageDelta: coverage.delta },
        );
      } catch (err) {
        this.pushStep('testgen', false, `${change.path}: testgen failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (lastRun) report.testRun = lastRun;
    if (lastCoverage) {
      report.coverage = { ...lastCoverage, delta: totalDelta };
    }
    return report;
  }

  /** Đọc test cũ của một file nguồn (null khi chưa có test). */
  private readExistingTest(sourcePath: string): string | null {
    // Bỏ đuôi .ts/.tsx/.js/.jsx rồi thêm .test.mjs / .test.ts — KHÔNG
    // để sót lại chính path nguồn trong danh sách candidate (regex
    // cũ `\.tsx?$` không khớp `.js` nên đã đọc nhầm source làm test).
    const base = sourcePath.replace(/\.(ts|tsx|js|jsx)$/, '');
    const candidates = [`${base}.test.mjs`, `${base}.test.ts`];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(path.join(this.workingDir, candidate), 'utf8');
      } catch {
        continue;
      }
    }
    return null;
  }

  private finishReport(finished: boolean, awaitingApproval: boolean, error?: string): V8TaskReport {
    const report: V8TaskReport = {
      sessionId: this.log.sessionId,
      title: this.title,
      finished,
      awaitingApproval,
      rolledBack: false,
      steps: [...this.reportSteps],
    };
    if (error) report.error = error;
    if (this.pendingPlan) report.plan = this.pendingPlan;
    return report;
  }
}
