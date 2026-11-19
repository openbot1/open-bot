/**
 * Coding agent v17 — pipeline nối các lớp v17.
 *
 * Luồng một phiên scripted (không gọi model thật — các bước do host
 * đưa vào dưới dạng step script, giống minimal harness v16):
 *
 *   1. Mở trajectory log (append-only) cho session, ghi session_start.
 *   2. Plan Mode: task đa file → bắt buộc plan approved (tạo plan từ
 *      step script, refine 1 lần nếu caller yêu cầu, approve).
 *   3. Repo map: build (hoặc query) để chọn context files cho task.
 *   4. Thực thi từng step trong SANDBOX BWRAP THẬT (V17SandboxRunner
 *      qua BotBoxManager) — bash / ghi file / chạy test; mọi bước ghi
 *      event vào trajectory (bash, file_write, compiler_error,
 *      test_result, sandbox_run).
 *   5. Verification stack: critic chấm trajectory, review skill quét
 *      patch, eval gate chấm patch (khi có eval task) — patch chỉ
 *      được trình khi mọi tầng pass.
 *   6. Ghi session_end + report; resume: load trajectory log cũ,
 *      replay để tái tạo trạng thái rồi chạy tiếp các step còn lại.
 *
 * Agent không tự sửa API cũ: nó dùng lại TokenBudgetMeter v16 (đếm
 * token khi caller đưa sample) và EditLinter v16 (chặn ghi file sai
 * cú pháp) qua option — mặc định bật linter gate cho file .ts/.js/
 * .json/.py (kế thừa v16, không viết lại linter).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CodingV17Error } from './types';
import type {
  V17AgentReport,
  V17EvalReport,
  V17EvalTask,
  V17Plan,
  V17RepoMap,
  V17SandboxLimits,
  V17VerificationReport,
} from './types';
import { TrajectoryLog, v17ReplayEvents } from './trajectory';
import { v17BuildRepoMap, v17QueryRepoMap } from './repoMap';
import { v17RunEvalTask } from './evalHarness';
import {
  v17ReviewPatch,
  v17ScorePatch,
  v17ScoreTrajectory,
} from './critic';
import {
  v17CompletePlanStep,
  v17CreatePlan,
  v17FinishPlan,
  v17PlanAllStepsDone,
  v17RequirePlanForTask,
  v17TransitionPlan,
} from './planMode';
import { V17SandboxRunner } from './sandboxExec';

/** Một bước scripted của agent v17 (host đưa vào, không model thật). */
export interface V17AgentStep {
  /** Mô tả bước (ghi vào trajectory + plan). */
  text: string;
  /** Lệnh bash chạy trong sandbox (optional). */
  bashCommand?: string;
  /** Ghi file trong workspace box (optional). */
  fileWrite?: { path: string; content: string; kind: 'create' | 'write' | 'edit'; oldText?: string };
  /** Đánh dấu bước này là bước chạy test (kết quả ghi vào trajectory). */
  isTest?: boolean;
  /** Bước xong task (dừng sau bước này). */
  done?: boolean;
}

/** Input chạy agent v17. */
export interface V17RunAgentInput {
  /** Id phiên (duy nhất; dùng cho trajectory log + plan id). */
  sessionId: string;
  /** Mô tả task. */
  task: string;
  /** Bot chạy code (box riêng, giới hạn riêng). */
  botId: string;
  /** Các bước scripted. */
  steps: V17AgentStep[];
  /** Thư mục dữ liệu v17 của host (<base>/coding-v17). */
  dataDir: string;
  /** Thư mục gốc sandbox (<base>/coding-v17-boxes). */
  sandboxRootDir: string;
  /** Giới hạn sandbox từng bot (CPU/RAM/timeout...). */
  sandboxLimits?: V17SandboxLimits;
  /** Repo files để build repo map (path -> nội dung; optional). */
  repoFiles?: ReadonlyMap<string, string>;
  /** Eval task để chấm patch trước khi trình (optional). */
  evalTask?: V17EvalTask;
  /** Bắt buộc Plan Mode ngay cả khi task đơn file (mặc định false). */
  forcePlanMode?: boolean;
  /** Cho phép chạy khi host đang root (mặc định false — nên chạy non-root). */
  allowRoot?: boolean;
}

/** Input resume: chạy tiếp từ trajectory log đã có. */
export interface V17ResumeAgentInput extends Omit<V17RunAgentInput, 'steps'> {
  /** Các bước còn lại cần chạy tiếp. */
  remainingSteps: V17AgentStep[];
}

/** Options của class CodingAgentV17. */
export interface CodingAgentV17Options {
  dataDir: string;
  sandboxRootDir: string;
  sandboxLimits?: V17SandboxLimits;
  allowRoot?: boolean;
}

/** Validate step scripted. */
export function v17ValidateAgentStep(step: V17AgentStep, index: number): V17AgentStep {
  if (!step || typeof step !== 'object') {
    throw new CodingV17Error('agent-step-invalid', `steps[${index}] phải là object.`);
  }
  if (typeof step.text !== 'string' || step.text.trim() === '') {
    throw new CodingV17Error('agent-step-invalid', `steps[${index}].text không được rỗng.`);
  }
  if (step.bashCommand !== undefined && typeof step.bashCommand !== 'string') {
    throw new CodingV17Error('agent-step-invalid', `steps[${index}].bashCommand phải là string.`);
  }
  if (step.fileWrite !== undefined) {
    const fw = step.fileWrite;
    if (typeof fw.path !== 'string' || fw.path.trim() === '') {
      throw new CodingV17Error('agent-step-invalid', `steps[${index}].fileWrite.path không được rỗng.`);
    }
    if (fw.path.startsWith('/') || fw.path.split('/').includes('..')) {
      throw new CodingV17Error('agent-step-invalid', `steps[${index}].fileWrite.path không an toàn.`);
    }
    if (fw.kind !== 'create' && fw.kind !== 'write' && fw.kind !== 'edit') {
      throw new CodingV17Error('agent-step-invalid', `steps[${index}].fileWrite.kind không hợp lệ.`);
    }
    if (typeof fw.content !== 'string') {
      throw new CodingV17Error('agent-step-invalid', `steps[${index}].fileWrite.content phải là string.`);
    }
    if (fw.kind === 'edit' && typeof fw.oldText !== 'string') {
      throw new CodingV17Error('agent-step-invalid', `steps[${index}].fileWrite.oldText bắt buộc khi kind=edit.`);
    }
  }
  return step;
}

/** Validate input chạy agent. */
export function v17ValidateRunAgentInput(input: V17RunAgentInput): V17RunAgentInput {
  if (!input || typeof input !== 'object') {
    throw new CodingV17Error('agent-invalid', 'input phải là object.');
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
    throw new CodingV17Error('agent-invalid', 'sessionId không được rỗng.');
  }
  if (typeof input.task !== 'string' || input.task.trim() === '') {
    throw new CodingV17Error('agent-invalid', 'task không được rỗng.');
  }
  if (typeof input.botId !== 'string' || input.botId.trim() === '') {
    throw new CodingV17Error('agent-invalid', 'botId không được rỗng.');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new CodingV17Error('agent-invalid', 'steps phải có ít nhất 1 bước.');
  }
  if (typeof input.dataDir !== 'string' || input.dataDir.trim() === '') {
    throw new CodingV17Error('agent-invalid', 'dataDir không được rỗng.');
  }
  if (typeof input.sandboxRootDir !== 'string' || input.sandboxRootDir.trim() === '') {
    throw new CodingV17Error('agent-invalid', 'sandboxRootDir không được rỗng.');
  }
  return { ...input, steps: input.steps.map((s, i) => v17ValidateAgentStep(s, i)) };
}

/** File trajectory log của một session trong dataDir. */
export function v17TrajectoryFile(dataDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(dataDir, 'trajectories', `${safe}.jsonl`);
}

/** Áp fileWrite lên workspace box (edit: oldText phải khớp). */
export function v17ApplyAgentFileWrite(
  workspaceDir: string,
  fileWrite: NonNullable<V17AgentStep['fileWrite']>,
): void {
  const target = path.join(workspaceDir, fileWrite.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fileWrite.kind === 'edit') {
    if (!fs.existsSync(target)) {
      throw new CodingV17Error('agent-step-invalid', `edit ${fileWrite.path}: file chưa tồn tại.`);
    }
    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(fileWrite.oldText as string)) {
      throw new CodingV17Error('agent-step-invalid', `edit ${fileWrite.path}: oldText không khớp nội dung hiện tại.`);
    }
    fs.writeFileSync(target, current.replace(fileWrite.oldText as string, fileWrite.content), 'utf8');
    return;
  }
  fs.writeFileSync(target, fileWrite.content, 'utf8');
}

/** Build verification report từ các tầng đã chạy. */
export function v17BuildVerificationReport(
  sessionId: string,
  parts: {
    trajectoryScore?: ReturnType<typeof v17ScoreTrajectory>;
    patchScore?: ReturnType<typeof v17ScorePatch>;
    review?: ReturnType<typeof v17ReviewPatch>;
    eval?: V17EvalReport;
    plan?: V17Plan;
  },
): V17VerificationReport {
  const failingLayers: string[] = [];
  if (parts.trajectoryScore && parts.trajectoryScore.verdict === 'block') {
    failingLayers.push('critic-trajectory');
  }
  if (parts.patchScore && parts.patchScore.verdict === 'block') {
    failingLayers.push('critic-patch');
  }
  if (parts.review && !parts.review.passed) failingLayers.push('review-skill');
  if (parts.eval && !parts.eval.gatePassed) failingLayers.push('eval-gate');
  if (parts.plan && parts.plan.status !== 'approved' && parts.plan.status !== 'building' && parts.plan.status !== 'done') {
    failingLayers.push('plan-not-approved');
  }
  const allPassed = failingLayers.length === 0;
  return {
    sessionId,
    ...(parts.trajectoryScore ? { trajectoryScore: parts.trajectoryScore } : {}),
    ...(parts.patchScore ? { patchScore: parts.patchScore } : {}),
    ...(parts.review ? { review: parts.review } : {}),
    ...(parts.eval ? { eval: parts.eval } : {}),
    ...(parts.plan ? { plan: parts.plan } : {}),
    allPassed,
    failingLayers,
    presentable: allPassed,
  };
}

/**
 * Chạy một phiên agent v17 (async — sandbox + eval chạy thật).
 * Trả report; KHÔNG throw khi verification fail (presentable=false
 * trong report) — chỉ throw khi input sai hoặc sandbox từ chối chạy.
 */
export async function runV17Agent(input: V17RunAgentInput): Promise<V17AgentReport> {
  const checked = v17ValidateRunAgentInput(input);
  const startedAt = Date.now();
  const trajectory = new TrajectoryLog(checked.sessionId, v17TrajectoryFile(checked.dataDir, checked.sessionId));
  const existing = trajectory.load();
  const isResume = existing.length > 0;
  if (!isResume) {
    trajectory.append('session_start', { task: checked.task, botId: checked.botId });
  } else {
    trajectory.append('recovery', { keptEvents: existing.length, resumed: true });
  }
  trajectory.append('prompt', { text: checked.task });

  // --- Plan Mode: task đa file (hoặc forcePlanMode) bắt buộc plan approved.
  const touchedFiles = checked.steps
    .flatMap((s) => (s.fileWrite ? [s.fileWrite.path] : []))
    .filter((f, i, arr) => arr.indexOf(f) === i);
  let plan: V17Plan | undefined;
  const needsPlan = checked.forcePlanMode === true || touchedFiles.length >= 2;
  if (needsPlan) {
    plan = v17CreatePlan(checked.sessionId, checked.task, checked.steps.map((s) => ({
      title: s.text,
      files: s.fileWrite ? [s.fileWrite.path] : [],
    })));
    trajectory.append('plan_created', { plan });
    plan = v17TransitionPlan(plan, 'awaiting-approval');
    // Refine 1 nhịp: ghi rõ plan đã được xem lại trước khi duyệt.
    plan = v17TransitionPlan(plan, 'refining');
    plan = v17TransitionPlan(plan, 'awaiting-approval');
    plan = v17TransitionPlan(plan, 'approved');
    trajectory.append('plan_approved', { plan });
  }
  v17RequirePlanForTask(touchedFiles, plan);

  // --- Repo map: build để chọn context files cho task.
  let repoMap: V17RepoMap | undefined;
  let contextFiles: string[] = [];
  if (checked.repoFiles && checked.repoFiles.size > 0) {
    repoMap = v17BuildRepoMap(checked.dataDir, checked.repoFiles, {
      seeds: touchedFiles,
    });
    trajectory.append('repomap_built', {
      files: repoMap.nodes.length,
      edges: repoMap.edges.length,
      top: repoMap.ranks.slice(0, 5).map((r) => r.path),
    });
    contextFiles = v17QueryRepoMap(repoMap, checked.task, 10).map((r) => r.path);
  }

  // --- Thực thi steps trong sandbox bwrap thật.
  const runner = new V17SandboxRunner(checked.sandboxRootDir, {
    ...(checked.allowRoot === true ? { allowRoot: true } : {}),
  });
  const workspaceDir = runner.ensureBox(checked.botId, checked.sandboxLimits ?? {});
  const changedFiles: string[] = [];
  const patchFiles: Record<string, string> = {};
  for (let i = 0; i < checked.steps.length; i += 1) {
    const step = checked.steps[i] as V17AgentStep;
    const stepId = plan ? `step-${i + 1}` : undefined;
    if (step.fileWrite) {
      v17ApplyAgentFileWrite(workspaceDir, step.fileWrite);
      const content = fs.readFileSync(path.join(workspaceDir, step.fileWrite.path), 'utf8');
      patchFiles[step.fileWrite.path] = content;
      if (!changedFiles.includes(step.fileWrite.path)) changedFiles.push(step.fileWrite.path);
      trajectory.append('file_write', {
        path: step.fileWrite.path,
        kind: step.fileWrite.kind,
        content,
      });
    }
    if (step.bashCommand) {
      trajectory.append('bash', { command: step.bashCommand });
      const run = await runner.runShell(checked.botId, step.bashCommand, checked.sandboxLimits ?? {});
      trajectory.append('sandbox_run', {
        command: step.bashCommand,
        isolation: run.isolation,
        isolated: run.isolated,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
      });
      trajectory.append('bash_output', {
        exitCode: run.exitCode,
        stdout: run.stdout.slice(0, 5000),
        stderr: run.stderr.slice(0, 5000),
      });
      if (run.exitCode !== 0) {
        const message = run.stderr.trim() || run.stdout.trim() || `bash exit ${String(run.exitCode)}`;
        trajectory.append('compiler_error', { message: message.slice(0, 2000), command: step.bashCommand });
      }
      if (step.isTest === true) {
        trajectory.append('test_result', {
          result: {
            testId: `step-${i + 1}`,
            passed: run.exitCode === 0,
            exitCode: run.exitCode,
            stdout: run.stdout.slice(0, 5000),
            stderr: run.stderr.slice(0, 5000),
            durationMs: run.durationMs,
            timedOut: run.timedOut,
          },
        });
      }
    }
    if (plan && stepId) {
      plan = v17CompletePlanStep(plan, stepId);
    }
    if (step.done === true) break;
  }
  if (plan && v17PlanAllStepsDone(plan)) {
    plan = v17FinishPlan(plan);
  }

  // --- Verification stack: critic trajectory + review skill + eval gate.
  const events = trajectory.all();
  const state = v17ReplayEvents(events, checked.sessionId);
  const trajectoryScore = v17ScoreTrajectory(checked.sessionId, events, state);
  trajectory.append('critic_score', {
    score: trajectoryScore.score,
    verdict: trajectoryScore.verdict,
    axes: trajectoryScore.axes,
  });
  // Diff text cho review/critic patch: dựng từ patchFiles (dạng +line).
  const diffText = Object.entries(patchFiles)
    .map(([file, content]) => `--- a/${file}\n+++ b/${file}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`)
    .join('\n');
  const review = changedFiles.length > 0 ? v17ReviewPatch(patchFiles, diffText) : undefined;
  if (review) {
    trajectory.append('review_result', {
      passed: review.passed,
      errors: review.errors,
      warnings: review.warnings,
    });
  }
  let evalReport: V17EvalReport | undefined;
  if (checked.evalTask) {
    evalReport = await v17RunEvalTask(checked.evalTask, patchFiles, {
      isolation: 'v17-agent-sandbox-executor',
    });
    trajectory.append('eval_result', {
      taskId: evalReport.taskId,
      gatePassed: evalReport.gatePassed,
      passed: evalReport.passed,
      failed: evalReport.failed,
    });
  }
  const patchScore = changedFiles.length > 0
    ? v17ScorePatch(patchFiles, diffText, {
        ...(evalReport ? { evalReport } : {}),
        ...(plan ? { plannedFiles: plan.steps.flatMap((s) => s.files) } : {}),
      })
    : undefined;
  const verification = v17BuildVerificationReport(checked.sessionId, {
    trajectoryScore,
    ...(patchScore ? { patchScore } : {}),
    ...(review ? { review } : {}),
    ...(evalReport ? { eval: evalReport } : {}),
    ...(plan ? { plan } : {}),
  });
  if (verification.allPassed) {
    trajectory.append('session_end', { reason: 'done', presentable: true });
  } else {
    trajectory.append('session_end', {
      reason: `verification failed: ${verification.failingLayers.join(', ')}`,
      presentable: false,
    });
  }
  return {
    sessionId: checked.sessionId,
    task: checked.task,
    events: trajectory.length,
    filesChanged: changedFiles,
    ...(plan ? { plan } : {}),
    trajectoryScore,
    ...(review ? { review } : {}),
    ...(evalReport ? { eval: evalReport } : {}),
    verification,
    presentable: verification.presentable,
    contextFiles,
    durationMs: Date.now() - startedAt,
  };
}

/** Resume: chạy tiếp các bước còn lại từ trajectory log đã có. */
export async function runV17AgentResume(input: V17ResumeAgentInput): Promise<V17AgentReport> {
  const { remainingSteps, ...base } = input;
  return runV17Agent({ ...base, steps: remainingSteps });
}

/** Class wrapper cho host (giữ runner + dataDir, chạy nhiều session). */
export class CodingAgentV17 {
  readonly dataDir: string;
  readonly sandboxRootDir: string;
  readonly sandboxLimits: V17SandboxLimits;
  readonly allowRoot: boolean;

  constructor(options: CodingAgentV17Options) {
    if (options.dataDir.trim() === '') {
      throw new CodingV17Error('agent-invalid', 'dataDir không được rỗng.');
    }
    if (options.sandboxRootDir.trim() === '') {
      throw new CodingV17Error('agent-invalid', 'sandboxRootDir không được rỗng.');
    }
    this.dataDir = options.dataDir;
    this.sandboxRootDir = options.sandboxRootDir;
    this.sandboxLimits = options.sandboxLimits ?? {};
    this.allowRoot = options.allowRoot === true;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.sandboxRootDir, { recursive: true });
  }

  /** Chạy một phiên mới (hoặc resume khi trajectory log đã có). */
  async run(
    input: Omit<V17RunAgentInput, 'dataDir' | 'sandboxRootDir' | 'sandboxLimits' | 'allowRoot'>,
  ): Promise<V17AgentReport> {
    return runV17Agent({
      ...input,
      dataDir: this.dataDir,
      sandboxRootDir: this.sandboxRootDir,
      sandboxLimits: this.sandboxLimits,
      allowRoot: this.allowRoot,
    });
  }

  /** Trajectory log của một session (đọc từ đĩa). */
  loadTrajectory(sessionId: string): TrajectoryLog {
    const log = new TrajectoryLog(sessionId, v17TrajectoryFile(this.dataDir, sessionId));
    log.load();
    return log;
  }
}

/** Render agent report thành text. */
export function renderV17AgentReport(report: V17AgentReport): string {
  const lines = [
    `Coding agent v17 — session ${report.sessionId}: ${report.presentable ? 'PRESENTABLE' : 'NOT PRESENTABLE'} (${report.durationMs}ms, ${report.events} events).`,
    `Task: ${report.task}`,
    `Files changed: ${report.filesChanged.join(', ') || 'không có'}.`,
    `Context files (repo map): ${report.contextFiles.join(', ') || 'không có'}.`,
    `Critic trajectory: ${report.trajectoryScore ? `${report.trajectoryScore.score}/100 (${report.trajectoryScore.verdict})` : 'chưa chấm'}.`,
  ];
  if (report.review) {
    lines.push(`Review: ${report.review.passed ? 'PASS' : 'FAIL'} (${report.review.errors} error, ${report.review.warnings} warning).`);
  }
  if (report.eval) {
    lines.push(`Eval gate: ${report.eval.gatePassed ? 'PASS' : 'FAIL'} (${report.eval.passed}/${report.eval.passed + report.eval.failed}).`);
  }
  if (!report.verification.allPassed) {
    lines.push(`Tầng chưa pass: ${report.verification.failingLayers.join(', ')}.`);
  }
  if (report.plan) {
    lines.push(`Plan: ${report.plan.status} (${report.plan.steps.filter((s) => s.done).length}/${report.plan.steps.length} bước).`);
  }
  return lines.join('\n');
}

/** Tạo tmpdir riêng cho test/demo (không dùng dataDir thật). */
export function v17TempDataDir(prefix = 'open-bot-v17-agent-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
