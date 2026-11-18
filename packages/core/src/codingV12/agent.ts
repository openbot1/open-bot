/**
 * Coding agent v12 — pipeline nối 6 lớp v12 + coding agent v11.
 *
 * Nối agent v11 (plan → CodeAct → refactor → patch review → testgen
 * → verify → commit atomic): v12 thay "edit" bằng pipeline có thứ tự
 * theo dependency và thêm 3 cổng kiểm soát mới mà v11 chưa có:
 *
 *   1. depgraph: build dependency graph của workingDir (Large Codebase
 *      SDK) → chia task thành các edit nhỏ có thứ tự (lá trước, gốc
 *      sau) → `V12EditCoordinator` chỉ cho start edit khi dependency
 *      đã done.
 *   2. edit strategy: mỗi edit áp bằng `V12EditStrategy` (diff hoặc
 *      patch, verify sau mỗi edit, commit riêng từng edit) — edit
 *      fail thì các edit phụ thuộc vào nó bị skip, không chạy mù.
 *   3. visualizer v2: cây task live — root là task, mỗi edit một
 *      node con (file đang sửa, token, cost, trạng thái
 *      blocked/waiting khi bị chặn).
 *   4. budget meters: meter token/cost/time/steps của conversation —
 *      vượt budget thì dừng các edit còn lại (skip), không chạy quá.
 *   5. ACP switch (tùy chọn): đổi model giữa chừng (giữ transcript)
 *      sau bước depgraph, trước khi bắt đầu edit.
 *   6. eval v3 (tùy chọn): chạy suite eval sau khi edit xong, đính
 *      điểm 4 chiều vào báo cáo.
 *
 * Agent không gọi model thật: nội dung từng edit do `editProvider`
 * của host tiêm (host gọi model rồi chuyển thành V12Edit) — agent chỉ
 * điều phối thứ tự, áp, verify, commit, đo. Không gọi mạng, không
 * push remote. Giới hạn trung thực: thứ tự edit đúng theo dependency
 * tĩnh (regex import) — import động qua biến không thấy; edit
 * provider trả edit sai file thì edit đó fail rõ ràng, không đoán.
 */

import { V12AcpSession } from './acpModelSwitch';
import { V12ConversationBudgetMeter } from './budgetMeters';
import { V12EditCoordinator, v12BuildDepGraphFromDir, v12PlanOrderedEdits } from './dependencyGraph';
import { V12EditStrategy } from './editStrategyV12';
import { runV12EvalSuite, v12ScoreEval } from './evalV12';
import type { V12EvalAgentFn } from './evalV12';
import { CodingV12Error } from './types';
import { V12TaskVisualizer } from './visualizerV12';
import type { V12OrderedEdit } from './types';
import type { V12ConversationBudget } from './types';
import type {
  V12AgentReport,
  V12AgentStep,
  V12BudgetState,
  V12Edit,
  V12EvalScores,
  V12EvalTask,
} from './types';

/** Host tiêm nội dung edit cho mỗi ordered edit (host gọi model rồi chuyển thành V12Edit). */
export type V12AgentEditProvider = (orderedEdit: V12OrderedEdit, attempt: number) => V12Edit | Promise<V12Edit>;

export interface V12AgentOptions {
  /** Thư mục làm việc (git repo) — depgraph quét + edit áp tại đây. */
  workingDir: string;
  /** Id task (mặc định sinh theo thời gian). */
  taskId?: string;
  /** Tiêu đề task (hiện ở visualizer root + báo cáo). */
  title: string;
  /** Map file → mô tả việc cần làm với file đó. */
  tasks: Map<string, string> | Record<string, string>;
  /** Thư mục con để quét depgraph (mặc định '' = cả workingDir). */
  subdir?: string;
  /** Bắt buộc: host cung cấp nội dung edit cho từng ordered edit. */
  editProvider: V12AgentEditProvider;
  /** Lệnh verify chạy sau mỗi edit (argv, không shell). */
  verifyCommand?: string[];
  /** true = commit riêng từng edit (mặc định true). */
  commitEdits?: boolean;
  /** Budget conversation (mặc định của meter). */
  budget?: V12ConversationBudget;
  /** Model chạy task (ghi vào budget meter + visualizer). */
  modelId?: string;
  /** ACP session đang chạy (tùy chọn — để switch model giữa chừng). */
  acpSession?: V12AcpSession;
  /** Model đích để switch sau bước depgraph (cần acpSession). */
  switchModelTo?: string;
  /** Task eval v3 chạy sau khi edit xong (tùy chọn). */
  evalTasks?: readonly V12EvalTask[];
  /** Agent eval v3 (bắt buộc khi có evalTasks). */
  evalAgent?: V12EvalAgentFn;
  /** Version agent ghi vào báo cáo eval. */
  evalAgentVersion?: string;
}

/** Id task v12 mới. */
export function v12NewAgentTaskId(): string {
  return `v12task-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function step(name: string, status: V12AgentStep['status'], detail: string, started: number): V12AgentStep {
  return { name, status, detail, durationMs: Date.now() - started };
}

/**
 * Chạy một task coding v12 end-to-end trong workingDir:
 * depgraph → plan → (ACP switch) → edits có thứ tự → (eval v3).
 */
export async function runV12Agent(options: V12AgentOptions): Promise<V12AgentReport> {
  const started = Date.now();
  const taskId = options.taskId ?? v12NewAgentTaskId();
  const steps: V12AgentStep[] = [];
  const editCommits: { editId: string; file: string; sha: string }[] = [];
  const modelId = options.modelId ?? 'coding-v12-default';
  const meter = new V12ConversationBudgetMeter(taskId, modelId, options.budget ?? {});
  const visualizer = new V12TaskVisualizer(options.title);
  let editOrder: string[] = [];
  let evalScores: V12EvalScores | undefined;
  let budget: V12BudgetState | undefined;
  let error: string | undefined;
  // Khai báo sớm: finishReport() dùng failedEdits nên phải có trước mọi
  // đường return sớm (TDZ của `let` sẽ lỗi nếu khai báo sau).
  let failedEdits = 0;
  let skippedEdits = 0;

  // --- Bước 1: depgraph + plan edit có thứ tự ---
  let plan: { planId: string; title: string; edits: V12OrderedEdit[] };
  try {
    const t0 = Date.now();
    const graph = v12BuildDepGraphFromDir(options.workingDir, options.subdir ?? '');
    plan = v12PlanOrderedEdits(graph, options.tasks, options.title);
    editOrder = plan.edits.map((e) => e.file);
    steps.push(
      step(
        'depgraph',
        'ok',
        `Graph ${graph.stats.files} files, ${graph.stats.edges} cạnh, ${graph.stats.cycles} chu trình → plan ${plan.planId}: ${plan.edits.length} edit, ${new Set(plan.edits.map((e) => e.parallelGroup)).size} nhóm song song (lá trước).`,
        t0,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push(step('depgraph', 'failed', msg, started));
    return finishReport();
  }

  // --- Bước 2 (tùy chọn): ACP switch model giữa chừng ---
  if (options.switchModelTo) {
    const t0 = Date.now();
    if (!options.acpSession) {
      steps.push(step('acp-switch', 'skipped', 'switchModelTo được cho nhưng không có acpSession — bỏ qua.', t0));
    } else {
      try {
        const from = options.acpSession.currentModelId();
        const res = options.acpSession.switchModel(options.switchModelTo, `v12 agent ${taskId}: đổi model trước khi edit`);
        steps.push(
          step(
            'acp-switch',
            'ok',
            `Đổi model ${from} → ${res.record.toModelId} (giữ ${res.record.preservedMessages} message transcript; thêm ${res.record.capabilitiesAdded.join(', ') || 'không có capability mới'}; mất ${res.record.capabilitiesRemoved.join(', ') || 'không có'}).`,
            t0,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push(step('acp-switch', 'failed', msg, t0));
        error = msg;
        return finishReport();
      }
    }
  } else {
    steps.push(step('acp-switch', 'skipped', 'Không yêu cầu đổi model giữa chừng.', Date.now()));
  }

  // --- Bước 3: edits có thứ tự qua coordinator + strategy ---
  const coordinator = new V12EditCoordinator(plan!);
  const strategy = new V12EditStrategy(options.workingDir, {
    verifyCommand: options.verifyCommand,
    commit: options.commitEdits ?? true,
  });
  const tEdits = Date.now();
  let stoppedByBudget = false;
  for (const ordered of plan!.edits) {
    if (meter.state().anyExceeded) {
      stoppedByBudget = true;
      break;
    }
    const check = coordinator.canStart(ordered.id);
    const node = visualizer.addTask('root', `Edit ${ordered.id}: ${ordered.file}`, {
      detail: ordered.summary,
      model: modelId,
      editingFile: ordered.file,
    });
    if (!check.ok) {
      coordinator.finish(ordered.id, 'skipped', `Bị chặn bởi ${check.blockedBy.join(', ')}`);
      skippedEdits += 1;
      visualizer.updateTask(node.id, { status: 'blocked', error: `Bị chặn bởi edit ${check.blockedBy.join(', ')}` });
      continue;
    }
    coordinator.start(ordered.id);
    visualizer.updateTask(node.id, { status: 'running', progress: 10 });
    meter.recordStep();
    let produced: V12Edit;
    try {
      produced = await options.editProvider(ordered, 1);
    } catch (err) {
      const msg = `editProvider lỗi: ${err instanceof Error ? err.message : String(err)}`;
      coordinator.finish(ordered.id, 'failed', msg);
      failedEdits += 1;
      visualizer.updateTask(node.id, { status: 'failed', error: msg });
      continue;
    }
    if (produced.file !== ordered.file) {
      const msg = `editProvider trả edit cho file "${produced.file}" nhưng ordered edit "${ordered.id}" yêu cầu "${ordered.file}" — không đoán, edit fail.`;
      coordinator.finish(ordered.id, 'failed', msg);
      failedEdits += 1;
      visualizer.updateTask(node.id, { status: 'failed', error: msg });
      continue;
    }
    const applied = await strategy.applyEdit(produced);
    if (applied.ok) {
      coordinator.finish(ordered.id, 'done', undefined, 0);
      if (applied.commitSha) editCommits.push({ editId: ordered.id, file: ordered.file, sha: applied.commitSha });
      visualizer.updateTask(node.id, {
        status: 'done',
        progress: 100,
        finishedFile: ordered.file,
        logLine: `Commit ${applied.commitSha?.slice(0, 7) ?? '(không commit)'}: +${applied.linesAdded}/-${applied.linesRemoved}`,
      });
    } else {
      coordinator.finish(ordered.id, 'failed', applied.error);
      failedEdits += 1;
      visualizer.updateTask(node.id, { status: 'failed', error: applied.error });
    }
  }
  // Các edit còn pending sau khi dừng vì budget → skip rõ ràng.
  if (stoppedByBudget) {
    for (const p of coordinator.all()) {
      if (p.status === 'pending') {
        coordinator.finish(p.edit.id, 'skipped', 'Dừng vì vượt budget conversation.');
        skippedEdits += 1;
      }
    }
  }
  const summary = coordinator.summary();
  steps.push(
    step(
      'edits',
      failedEdits === 0 ? 'ok' : 'failed',
      `${summary.done}/${summary.totalEdits} edit done, ${summary.failed} failed, ${summary.skipped} skipped` +
        (stoppedByBudget ? ' (dừng vì vượt budget)' : '') +
        ` — ${editCommits.length} commit riêng.`,
      tEdits,
    ),
  );
  if (failedEdits > 0 && !error) {
    error = `${failedEdits} edit thất bại — xem coordinator summary.`;
  }

  // --- Bước 4 (tùy chọn): eval v3 sau khi edit xong ---
  if (options.evalTasks && options.evalTasks.length > 0) {
    const t0 = Date.now();
    if (!options.evalAgent) {
      steps.push(step('eval', 'skipped', 'Có evalTasks nhưng không có evalAgent — bỏ qua eval.', t0));
    } else {
      try {
        const report = await runV12EvalSuite(options.evalTasks, options.evalAgent, {
          agentVersion: options.evalAgentVersion ?? 'coding-v12',
          attemptsPerTask: 1,
        });
        evalScores = v12ScoreEval(report.meanDimensions);
        steps.push(
          step(
            'eval',
            'ok',
            `Eval v3: ${report.tasks.filter((t) => t.passed).length}/${report.tasks.length} task pass, điểm trung bình ${report.meanScore.toFixed(1)}/100.`,
            t0,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push(step('eval', 'failed', msg, t0));
        if (!error) error = msg;
      }
    }
  } else {
    steps.push(step('eval', 'skipped', 'Không có evalTasks — bỏ qua eval v3.', Date.now()));
  }

  visualizer.updateTask('root', {
    status: failedEdits === 0 ? 'done' : 'failed',
    progress: failedEdits === 0 ? 100 : summary.overallProgress,
  });
  return finishReport();

  function finishReport(): V12AgentReport {
    budget = meter.state();
    return {
      taskId,
      title: options.title,
      ok: error === undefined && failedEdits === 0,
      error,
      steps,
      editOrder,
      editCommits,
      evalScores,
      budget,
      visualizer: visualizer.snapshot(),
      totalDurationMs: Date.now() - started,
    };
  }
}

/** Agent v12 dạng class (giữ options, chạy bằng run()). */
export class CodingAgentV12 {
  readonly options: V12AgentOptions;
  constructor(options: V12AgentOptions) {
    if (!options || typeof options !== 'object') {
      throw new CodingV12Error('agent-plan-invalid', 'Agent v12: options không hợp lệ.');
    }
    if (typeof options.workingDir !== 'string' || options.workingDir.trim() === '') {
      throw new CodingV12Error('agent-plan-invalid', 'Agent v12: workingDir không được rỗng.');
    }
    if (typeof options.title !== 'string' || options.title.trim() === '') {
      throw new CodingV12Error('agent-plan-invalid', 'Agent v12: title không được rỗng.');
    }
    if (typeof options.editProvider !== 'function') {
      throw new CodingV12Error('agent-plan-invalid', 'Agent v12: editProvider bắt buộc (host tiêm nội dung edit).');
    }
    this.options = options;
  }

  /** Chạy task (xem runV12Agent). */
  async run(): Promise<V12AgentReport> {
    return runV12Agent(this.options);
  }
}

/** Render báo cáo agent v12 thành text nhiều dòng (để log/UI). */
export function renderV12AgentReport(report: V12AgentReport): string {
  const lines = [
    `Agent v12 ${report.taskId} "${report.title}": ${report.ok ? 'OK' : `FAIL${report.error ? ` — ${report.error}` : ''}`} (${report.totalDurationMs}ms).`,
    `Thứ tự edit (lá trước): ${report.editOrder.join(', ') || '(không có)'}.`,
    `Commit riêng từng edit: ${report.editCommits.map((c) => `${c.editId}:${c.file}@${c.sha.slice(0, 7)}`).join(', ') || '(không có)'}.`,
  ];
  for (const s of report.steps) {
    lines.push(`  [${s.status}] ${s.name} (${s.durationMs}ms): ${s.detail}`);
  }
  if (report.evalScores) {
    lines.push(`  Eval v3: ${report.evalScores.total}/100 (${report.evalScores.grade}).`);
  }
  if (report.budget) {
    lines.push(
      `  Budget: ${report.budget.meters.map((m) => `${m.kind} ${m.percentUsed === null ? '—' : `${m.percentUsed.toFixed(0)}%`}`).join(', ')} — cảnh báo ${report.budget.worstWarning}.`,
    );
  }
  return lines.join('\n');
}
