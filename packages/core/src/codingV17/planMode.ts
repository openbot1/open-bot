/**
 * Coding agent v17 — Plan Mode.
 *
 * Ý tưởng học từ OpenHands Plan Mode 1.5.0 (survey v139 §4: planning
 * agent lập kế hoạch, refine, rồi mới build; bật cho self-hosted/local
 * từ 1.17.0). Thiết kế và code là của open-bot:
 *
 * - Task đa file (chạm >= 2 file khác nhau) BẮT BUỘC có plan đã
 *   approved trước khi build — `v17RequirePlanForTask` ném lỗi khi
 *   thiếu, agent v17 gọi nó trước mọi bước build.
 * - Plan là state machine: draft → refining → awaiting-approval →
 *   approved → building → done (hoặc rejected). Chỉ chuyển theo cạnh
 *   hợp lệ; chuyển sai → lỗi rõ ràng.
 * - Refine: thêm bước, sửa bước, ghi lịch sử refine (mỗi lần refine
 *   là một dòng, để truy vết plan đã đổi thế nào trước khi duyệt).
 * - Deviation: bước build chạm file ngoài plan → flag (không tự chặn
 *   — agent quyết định dừng hay cập nhật plan — nhưng deviation được
 *   ghi vào report để critic/review thấy).
 * - Plan serialize được (JSON) để lưu cùng trajectory log event
 *   plan_created / plan_refined / plan_approved.
 */

import { CodingV17Error } from './types';
import type { V17Plan, V17PlanStatus, V17PlanStep } from './types';

/** Số file trở lên thì task được coi là đa file (Plan Mode bắt buộc). */
export const V17_MULTI_FILE_THRESHOLD = 2;
/** Số bước tối đa trong một plan (tránh plan phình vô hạn). */
export const V17_PLAN_MAX_STEPS = 50;

/** Cạnh chuyển trạng thái hợp lệ của plan. */
export const V17_PLAN_TRANSITIONS: Readonly<Record<V17PlanStatus, readonly V17PlanStatus[]>> = {
  draft: ['refining', 'awaiting-approval', 'rejected'],
  refining: ['draft', 'awaiting-approval', 'rejected'],
  'awaiting-approval': ['approved', 'rejected', 'refining'],
  approved: ['building', 'rejected'],
  building: ['done', 'refining'],
  done: [],
  rejected: ['draft'],
};

/** Id bước: "step-1", "step-2", ... theo thứ tự tạo. */
export function v17NextStepId(plan: V17Plan): string {
  return `step-${plan.steps.length + 1}`;
}

/** Validate một bước plan. */
export function v17ValidatePlanStep(step: V17PlanStep): V17PlanStep {
  if (!step || typeof step !== 'object') {
    throw new CodingV17Error('plan-step-invalid', 'bước plan phải là object.');
  }
  if (typeof step.id !== 'string' || step.id.trim() === '') {
    throw new CodingV17Error('plan-step-invalid', 'step.id không được rỗng.');
  }
  if (typeof step.title !== 'string' || step.title.trim() === '') {
    throw new CodingV17Error('plan-step-invalid', `step ${step.id}: title không được rỗng.`);
  }
  if (!Array.isArray(step.files)) {
    throw new CodingV17Error('plan-step-invalid', `step ${step.id}: files phải là mảng.`);
  }
  for (const file of step.files) {
    if (typeof file !== 'string' || file.trim() === '') {
      throw new CodingV17Error('plan-step-invalid', `step ${step.id}: file không được rỗng.`);
    }
    if (file.startsWith('/') || file.split('/').includes('..')) {
      throw new CodingV17Error('plan-step-invalid', `step ${step.id}: file không an toàn: ${file}.`);
    }
  }
  return {
    id: step.id,
    title: step.title,
    files: [...step.files],
    done: step.done === true,
    ...(step.note !== undefined ? { note: step.note } : {}),
  };
}

/** Validate toàn bộ plan (id/task/steps/status nhất quán). */
export function v17ValidatePlan(plan: V17Plan): V17Plan {
  if (!plan || typeof plan !== 'object') {
    throw new CodingV17Error('plan-invalid', 'plan phải là object.');
  }
  if (typeof plan.id !== 'string' || plan.id.trim() === '') {
    throw new CodingV17Error('plan-invalid', 'plan.id không được rỗng.');
  }
  if (typeof plan.taskId !== 'string' || plan.taskId.trim() === '') {
    throw new CodingV17Error('plan-invalid', 'plan.taskId không được rỗng.');
  }
  if (typeof plan.task !== 'string' || plan.task.trim() === '') {
    throw new CodingV17Error('plan-invalid', 'plan.task không được rỗng.');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new CodingV17Error('plan-invalid', 'plan.steps phải có ít nhất 1 bước.');
  }
  if (plan.steps.length > V17_PLAN_MAX_STEPS) {
    throw new CodingV17Error('plan-invalid', `plan quá ${V17_PLAN_MAX_STEPS} bước.`);
  }
  const ids = new Set<string>();
  const steps = plan.steps.map((s) => {
    const checked = v17ValidatePlanStep(s);
    if (ids.has(checked.id)) {
      throw new CodingV17Error('plan-invalid', `step id trùng: ${checked.id}.`);
    }
    ids.add(checked.id);
    return checked;
  });
  const fileCount = new Set(steps.flatMap((s) => s.files)).size;
  return {
    id: plan.id,
    taskId: plan.taskId,
    task: plan.task,
    status: plan.status,
    steps,
    fileCount,
    multiFile: fileCount >= V17_MULTI_FILE_THRESHOLD,
    refinements: [...(plan.refinements ?? [])],
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(plan.rejectReason !== undefined ? { rejectReason: plan.rejectReason } : {}),
  };
}

/** Tạo plan mới (draft) từ task + danh sách bước mô tả. */
export function v17CreatePlan(
  taskId: string,
  task: string,
  steps: ReadonlyArray<{ title: string; files?: string[] }>,
  nowMs = Date.now(),
): V17Plan {
  if (taskId.trim() === '') throw new CodingV17Error('plan-invalid', 'taskId không được rỗng.');
  if (task.trim() === '') throw new CodingV17Error('plan-invalid', 'task không được rỗng.');
  if (steps.length === 0) throw new CodingV17Error('plan-invalid', 'plan cần ít nhất 1 bước.');
  if (steps.length > V17_PLAN_MAX_STEPS) {
    throw new CodingV17Error('plan-invalid', `plan quá ${V17_PLAN_MAX_STEPS} bước.`);
  }
  const planSteps: V17PlanStep[] = steps.map((s, i) => ({
    id: `step-${i + 1}`,
    title: s.title,
    files: [...(s.files ?? [])],
    done: false,
  }));
  const plan: V17Plan = {
    id: `plan-${taskId}`,
    taskId,
    task,
    status: 'draft',
    steps: planSteps,
    fileCount: new Set(planSteps.flatMap((s) => s.files)).size,
    multiFile: new Set(planSteps.flatMap((s) => s.files)).size >= V17_MULTI_FILE_THRESHOLD,
    refinements: [],
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  return v17ValidatePlan(plan);
}

/** Chuyển trạng thái plan theo cạnh hợp lệ (sai cạnh → lỗi). */
export function v17TransitionPlan(plan: V17Plan, next: V17PlanStatus, nowMs = Date.now()): V17Plan {
  const allowed = V17_PLAN_TRANSITIONS[plan.status] ?? [];
  if (!allowed.includes(next)) {
    throw new CodingV17Error(
      'plan-invalid',
      `không thể chuyển plan từ ${plan.status} sang ${next} (chỉ được: ${allowed.join(', ') || 'không có'}).`,
    );
  }
  const updated: V17Plan = { ...plan, status: next, updatedAt: nowMs };
  if (next === 'rejected' && updated.rejectReason === undefined) {
    updated.rejectReason = '';
  }
  if (next !== 'rejected') delete updated.rejectReason;
  return v17ValidatePlan(updated);
}

/** Refine plan: thêm/sửa/xoá bước + ghi lịch sử refine. */
export function v17RefinePlan(
  plan: V17Plan,
  change: string,
  mutate: (steps: V17PlanStep[]) => V17PlanStep[],
  nowMs = Date.now(),
): V17Plan {
  if (change.trim() === '') {
    throw new CodingV17Error('plan-invalid', 'refine cần mô tả thay đổi (change không được rỗng).');
  }
  if (plan.status === 'done') {
    throw new CodingV17Error('plan-invalid', 'plan đã done — không refine được nữa.');
  }
  if (plan.status === 'approved' || plan.status === 'building') {
    throw new CodingV17Error(
      'plan-invalid',
      `plan đang ${plan.status} — phải chuyển về refining trước khi refine (dùng v17TransitionPlan).`,
    );
  }
  const nextSteps = mutate(plan.steps.map((s) => ({ ...s, files: [...s.files] })));
  if (nextSteps.length === 0) {
    throw new CodingV17Error('plan-invalid', 'refine không được để plan rỗng bước.');
  }
  if (nextSteps.length > V17_PLAN_MAX_STEPS) {
    throw new CodingV17Error('plan-invalid', `plan quá ${V17_PLAN_MAX_STEPS} bước.`);
  }
  const refined: V17Plan = {
    ...plan,
    status: 'refining',
    steps: nextSteps.map((s) => v17ValidatePlanStep(s)),
    refinements: [...plan.refinements, change],
    updatedAt: nowMs,
  };
  return v17ValidatePlan(refined);
}

/** Đánh dấu một bước đã xong (chỉ khi plan approved/building). */
export function v17CompletePlanStep(plan: V17Plan, stepId: string, nowMs = Date.now()): V17Plan {
  if (plan.status !== 'approved' && plan.status !== 'building') {
    throw new CodingV17Error(
      'plan-invalid',
      `chỉ đánh dấu bước xong khi plan approved/building (đang ${plan.status}).`,
    );
  }
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new CodingV17Error('plan-step-invalid', `không có bước ${stepId} trong plan.`);
  const steps = plan.steps.map((s) => (s.id === stepId ? { ...s, done: true } : s));
  const status: V17PlanStatus = plan.status === 'approved' ? 'building' : plan.status;
  return v17ValidatePlan({ ...plan, status, steps, updatedAt: nowMs });
}

/** Plan đã xong hết bước chưa. */
export function v17PlanAllStepsDone(plan: V17Plan): boolean {
  return plan.steps.length > 0 && plan.steps.every((s) => s.done);
}

/** Kết thúc plan (chỉ khi mọi bước đã xong). */
export function v17FinishPlan(plan: V17Plan, nowMs = Date.now()): V17Plan {
  if (plan.status !== 'building') {
    throw new CodingV17Error('plan-invalid', `chỉ kết thúc plan đang building (đang ${plan.status}).`);
  }
  if (!v17PlanAllStepsDone(plan)) {
    const remaining = plan.steps.filter((s) => !s.done).map((s) => s.id);
    throw new CodingV17Error('plan-invalid', `còn bước chưa xong: ${remaining.join(', ')}.`);
  }
  return v17ValidatePlan({ ...plan, status: 'done', updatedAt: nowMs });
}

/** Từ chối plan (ghi lý do, chuyển sang rejected). */
export function v17RejectPlan(plan: V17Plan, reason: string, nowMs = Date.now()): V17Plan {
  if (reason.trim() === '') {
    throw new CodingV17Error('plan-invalid', 'từ chối plan cần lý do.');
  }
  const transitioned = v17TransitionPlan(plan, 'rejected', nowMs);
  return { ...transitioned, rejectReason: reason };
}

/**
 * Gate Plan Mode: task đa file bắt buộc phải có plan approved/building/done.
 * Ném lỗi khi: task đa file mà không có plan, hoặc plan chưa approved.
 * Task đơn file → không bắt buộc (trả undefined).
 */
export function v17RequirePlanForTask(
  taskFiles: readonly string[],
  plan?: V17Plan,
): V17Plan | undefined {
  const unique = new Set(taskFiles.filter((f) => f.trim() !== ''));
  if (unique.size < V17_MULTI_FILE_THRESHOLD) return undefined;
  if (!plan) {
    throw new CodingV17Error(
      'plan-multi-file-required',
      `task đa file (${unique.size} files) bắt buộc phải có plan — lập plan, refine rồi duyệt trước khi build.`,
    );
  }
  if (plan.status !== 'approved' && plan.status !== 'building' && plan.status !== 'done') {
    throw new CodingV17Error(
      'plan-not-approved',
      `task đa file cần plan đã approved (plan đang ${plan.status}) — duyệt plan trước khi build.`,
    );
  }
  return plan;
}

/** Kiểm tra một file build có nằm ngoài plan không (deviation). */
export function v17CheckPlanDeviation(
  plan: V17Plan,
  touchedFiles: readonly string[],
): { deviations: string[]; inPlan: string[] } {
  const planned = new Set(plan.steps.flatMap((s) => s.files));
  const deviations: string[] = [];
  const inPlan: string[] = [];
  for (const file of new Set(touchedFiles)) {
    if (planned.has(file)) inPlan.push(file);
    else deviations.push(file);
  }
  deviations.sort();
  inPlan.sort();
  return { deviations, inPlan };
}

/** Tiến độ plan: số bước xong / tổng số. */
export function v17PlanProgress(plan: V17Plan): { done: number; total: number; percent: number } {
  const done = plan.steps.filter((s) => s.done).length;
  const total = plan.steps.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Render plan thành text. */
export function renderV17Plan(plan: V17Plan): string {
  const progress = v17PlanProgress(plan);
  const lines = [
    `Plan ${plan.id} (${plan.status}) — ${plan.task}`,
    `  ${progress.done}/${progress.total} bước xong (${progress.percent}%), ${plan.fileCount} files${plan.multiFile ? ' (đa file — Plan Mode bắt buộc)' : ''}.`,
  ];
  for (const step of plan.steps) {
    lines.push(
      `  [${step.done ? 'x' : ' '}] ${step.id}: ${step.title}${step.files.length > 0 ? ` (${step.files.join(', ')})` : ''}${step.note ? ` — ${step.note}` : ''}`,
    );
  }
  for (const refinement of plan.refinements) {
    lines.push(`  refine: ${refinement}`);
  }
  if (plan.rejectReason !== undefined) lines.push(`  Từ chối: ${plan.rejectReason}`);
  return lines.join('\n');
}
