/**
 * Coding agent v15 — pipeline nối profile + budget + hooks + verify.
 *
 * Agent chạy scripted (không gọi model thật — stepFn do host/test
 * tiêm vào, giống v14): mỗi step chạy, budget meter ghi nhận token,
 * stop-hook feedback (nếu có) đi vào hooks dialog (không vào chat),
 * tool error được ghi lại nhưng không chặn run, file change được
 * apply thật ra workspace khi host đưa fileApplier.
 *
 * Sau khi agent xong, có thể chạy bộ verify scenario (runVerifyAfter)
 * để kiểm chứng agent trên các tình huống vượt happy path.
 */

import { CodingV15BudgetMeter, renderV15BudgetSummary } from './budget';
import { CodingV15HooksDialog, routeStopHookFeedback } from './hooksDialog';
import { CodingV15ProfileStore } from './profiles';
import {
  v15BuiltinScenarios,
  v15CorrectOutcomes,
  v15RunVerifyScenarios,
  v15ScriptedVerifyStepFn,
} from './verifyScenarios';
import { CodingV15Error } from './types';
import type {
  V15AgentRunInput,
  V15AgentRunResult,
  V15AgentStep,
  V15BudgetCap,
  V15HooksDialogState,
} from './types';

/** Thư mục con trong dataDir chứa run log v15 (nếu host cần). */
export const V15_RUN_LOG_SUBDIR = 'run-logs';

/** Số step tối đa mặc định khi profile không nói khác. */
export const V15_AGENT_DEFAULT_MAX_STEPS = 20;

/** Hàm apply file change ra workspace (host tiêm; null = xóa file). */
export type V15FileApplier = (filePath: string, content: string | null) => void;

/** Một step mà stepFn trả về (kèm token của step). */
export type V15StepFn = (stepIndex: number, state: V15AgentState) => V15AgentStep | null;

/** Trạng thái nội bộ của một lần chạy agent. */
export interface V15AgentState {
  runId: string;
  prompt: string;
  profileId: string;
  botId: string;
  step: number;
  done: boolean;
  toolErrors: string[];
  filesWritten: string[];
}

/** Trạng thái để chạy tiếp một run v15 đã dừng giữa chừng. */
export interface V15ResumeState {
  runId: string;
  prompt: string;
  profileId: string;
  botId: string;
  /** Số step đã chạy xong (step tiếp theo bắt đầu từ đây). */
  stepsExecuted: number;
  toolErrors: string[];
  filesWritten: string[];
}

/** Chụp trạng thái resume từ kết quả một run (để chạy tiếp sau này). */
export function v15BuildResumeState(result: V15AgentRunResult): V15ResumeState {
  return {
    runId: result.runId,
    prompt: result.prompt,
    profileId: result.profileId,
    botId: result.botId,
    stepsExecuted: result.stepsExecuted,
    toolErrors: [...result.toolErrors],
    filesWritten: [...result.filesWritten],
  };
}

export interface V15AgentOptions {
  profileStore?: CodingV15ProfileStore;
  budgetMeter?: CodingV15BudgetMeter;
  hooksDialog?: CodingV15HooksDialog;
  /** Thư mục dữ liệu v15 (để store/dialog tự persistence khi không đưa sẵn). */
  dataDir?: string;
  /** Ghi file change thật ra workspace (bỏ qua = chỉ ghi nhận, không ghi file). */
  fileApplier?: V15FileApplier;
  /** Model fallback khi profile không đặt model. */
  fallbackModel?: string;
  /** Chạy tiếp từ trạng thái resume (step đếm tiếp, lỗi/file cũ được giữ). */
  resumeFrom?: V15ResumeState;
  now?: () => string;
}

/** Tạo stepFn scripted từ danh sách step cho trước (test / tool). */
export function scriptedV15Agent(steps: V15AgentStep[]): V15StepFn {
  if (!Array.isArray(steps)) {
    throw new CodingV15Error('agent-step-invalid', 'Scripted v15 steps phải là mảng.');
  }
  return (stepIndex: number): V15AgentStep | null => {
    if (stepIndex < 0 || stepIndex >= steps.length) return null;
    return steps[stepIndex] as V15AgentStep;
  };
}

/** Validate input chạy agent. */
export function v15ValidateRunInput(input: V15AgentRunInput): void {
  if (!input || typeof input !== 'object') {
    throw new CodingV15Error('agent-run-invalid', 'Agent run input phải là object.');
  }
  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    throw new CodingV15Error('agent-run-invalid', 'Agent run cần runId không rỗng.');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new CodingV15Error('agent-run-invalid', 'Agent run cần prompt không rỗng.');
  }
  if (input.maxSteps !== undefined && (!Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 500)) {
    throw new CodingV15Error('agent-run-invalid', 'Agent maxSteps phải là số nguyên 1..500.');
  }
}

/**
 * Chạy agent v15 end-to-end (scripted, không gọi model thật).
 *
 * Thứ tự mỗi step:
 *   1. stepFn cho step (null = hết step) → dừng.
 *   2. Ghi token step vào budget meter (report-only — không chặn).
 *   3. Tool error trong step → ghi vào toolErrors, tiếp tục step sau.
 *   4. File change → apply thật qua fileApplier (nếu có).
 *   5. Stop-hook feedback → route vào hooks dialog (không vào chat).
 *   6. done=true → kết thúc.
 */
export function runV15Agent(
  input: V15AgentRunInput,
  stepFn: V15StepFn,
  options: V15AgentOptions = {},
): V15AgentRunResult {
  v15ValidateRunInput(input);
  if (typeof stepFn !== 'function') {
    throw new CodingV15Error('agent-step-invalid', 'Agent v15 cần stepFn là function.');
  }
  const nowFn = options.now ?? (() => new Date().toISOString());
  const profileStore = options.profileStore ?? new CodingV15ProfileStore({ dataDir: options.dataDir });
  const profileId = input.profileId ?? 'v15-general';
  const applied = profileStore.apply(profileId, options.fallbackModel ?? '');
  const profile = applied.profile;
  const botId = input.botId ?? 'default-bot';
  const cap: V15BudgetCap = input.budgetCap ?? {};
  const meter = options.budgetMeter ?? new CodingV15BudgetMeter(botId, cap, { now: nowFn });
  const dialog = options.hooksDialog ?? new CodingV15HooksDialog({ dataDir: options.dataDir, now: nowFn });
  const maxSteps = input.maxSteps ?? profile.maxSteps ?? V15_AGENT_DEFAULT_MAX_STEPS;
  const model = applied.model || options.fallbackModel || 'unknown-model';

  const resume = options.resumeFrom;
  if (resume && (resume.runId !== input.runId || resume.profileId !== profile.id)) {
    throw new CodingV15Error('agent-run-invalid', 'Resume state không khớp runId/profileId của run hiện tại.');
  }

  const state: V15AgentState = {
    runId: input.runId,
    prompt: input.prompt,
    profileId: profile.id,
    botId,
    step: resume?.stepsExecuted ?? 0,
    done: false,
    toolErrors: [...(resume?.toolErrors ?? [])],
    filesWritten: [...(resume?.filesWritten ?? [])],
  };

  let stoppedByMaxSteps = false;
  while (state.step < maxSteps) {
    const step = stepFn(state.step, state);
    if (step === null || step === undefined) break;
    if (typeof step.text !== 'string') {
      throw new CodingV15Error('agent-step-invalid', `Step ${state.step} cần text là chuỗi.`);
    }
    // 2. Budget: ghi nhận token của step (meter chỉ báo cáo).
    const inputTokens = step.inputTokens ?? Math.max(1, Math.ceil(step.text.length / 4));
    const outputTokens = step.outputTokens ?? 0;
    meter.record({
      runId: input.runId,
      botId,
      profileId: profile.id,
      model: step.model ?? model,
      inputTokens,
      outputTokens,
      step: state.step,
      at: nowFn(),
    });
    // 3. Tool calls: lỗi ghi lại, không chặn run.
    for (const call of step.toolCalls ?? []) {
      if (call.status === 'error') {
        state.toolErrors.push(`${call.tool}: ${call.error ?? call.outputPreview ?? 'unknown error'}`);
      }
      if (call.fileChange && options.fileApplier) {
        const change = call.fileChange;
        if (change.kind === 'delete') {
          options.fileApplier(change.path, null);
        } else if (change.afterContent !== undefined) {
          options.fileApplier(change.path, change.afterContent);
        }
        if (!state.filesWritten.includes(change.path)) state.filesWritten.push(change.path);
      } else if (call.fileChange && !state.filesWritten.includes(call.fileChange.path)) {
        state.filesWritten.push(call.fileChange.path);
      }
      if (step.simulateToolError && call.status === 'ok') {
        state.toolErrors.push(`${call.tool}: simulated tool error (verify)`);
      }
    }
    // 5. Stop-hook feedback → dialog, không vào chat.
    if (step.stopHookFeedback) {
      routeStopHookFeedback(dialog, {
        ...step.stopHookFeedback,
        runId: input.runId,
        hookKind: step.stopHookFeedback.hookKind ?? 'stop',
      });
    }
    state.step += 1;
    if (step.done) {
      state.done = true;
      break;
    }
  }
  if (!state.done && state.step >= maxSteps) stoppedByMaxSteps = true;

  const budget = meter.report(input.runId);
  const hooksState: V15HooksDialogState = dialog.state();
  return {
    runId: input.runId,
    profileId: profile.id,
    botId,
    prompt: input.prompt,
    stepsExecuted: state.step,
    done: state.done,
    stoppedByMaxSteps,
    budget,
    hooksDialog: hooksState,
    filesWritten: [...state.filesWritten],
    toolErrors: [...state.toolErrors],
    createdAt: nowFn(),
  };
}

/** Chạy agent rồi chạy bộ verify scenario (async — dùng khi cần report verify). */
export async function runV15AgentWithVerify(
  input: V15AgentRunInput,
  stepFn: V15StepFn,
  options: V15AgentOptions = {},
): Promise<V15AgentRunResult> {
  const result = runV15Agent(input, stepFn, options);
  const verify = await v15RunVerifyScenarios(
    v15ScriptedVerifyStepFn(v15CorrectOutcomes()),
    { runId: `${input.runId}-verify`, profileId: result.profileId, scenarios: v15BuiltinScenarios() },
  );
  return { ...result, verify };
}

/** Tóm tắt một dòng của kết quả chạy agent. */
export function renderV15AgentReport(result: V15AgentRunResult): string {
  const lines = [
    `Coding agent v15 — run ${result.runId} (profile ${result.profileId}, bot ${result.botId}): ${result.stepsExecuted} steps, done=${result.done}, stoppedByMaxSteps=${result.stoppedByMaxSteps}`,
    `  ${renderV15BudgetSummary(result.budget.state)}`,
    `  Hooks dialog: ${result.hooksDialog.pending} pending / ${result.hooksDialog.total} total feedback (chat untouched)`,
    `  Files written: ${result.filesWritten.length > 0 ? result.filesWritten.join(', ') : 'none'}`,
    `  Tool errors: ${result.toolErrors.length > 0 ? result.toolErrors.join(' | ') : 'none'}`,
  ];
  if (result.verify) {
    lines.push(`  Verify: ${result.verify.passed}/${result.verify.total} scenarios passed`);
  }
  return lines.join('\n');
}
