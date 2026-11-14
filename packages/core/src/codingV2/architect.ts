/**
 * Architect mode — planner và editor tách riêng (v1.08, Đội T2).
 *
 * Ý tưởng học từ Aider architect mode (chỉ học ý tưởng, tự thiết kế
 * và viết lại hoàn toàn từ đầu — KHÔNG đọc, KHÔNG copy code/text/tài
 * sản của Aider hay bất kỳ repo nào khác):
 *
 *   - Planner CHỈ ra kế hoạch: danh sách bước + file mỗi bước được
 *     chạm tới, KHÔNG viết code. Kế hoạch được tạo trước, bất biến
 *     trong lúc thực thi (muốn đổi kế hoạch thì tạo kế hoạch mới).
 *   - Editor thực thi TỪNG BƯỚC theo kế hoạch, qua `Workspace` bị
 *     giới hạn trong workspace root. Editor không tự ý thêm bước,
 *     không sửa file ngoài danh sách đã khai.
 *   - Planner DUYỆT LẠI diff sau mỗi bước: diff của bước chỉ được
 *     chạm file đã khai trong bước đó, không xoá file ngoài kế hoạch,
 *     tổng số dòng đổi không vượt trần. LỆCH KẾ HOẠCH thì bước đó
 *     fail, plan chuyển sang `blocked` — dừng lại và hỏi người dùng
 *     thay vì tự sửa tiếp.
 *
 * Module này giữ trạng thái plan trong bộ nhớ (Map theo plan id) và
 * dùng `Workspace` của coding v1 để áp edit — KHÔNG sửa code v1, chỉ
 * dùng lại. Không gọi model: model là planner/editor bên ngoài, còn
 * đây là harness cưỡng chế sự tách bạch đó.
 *
 * Giới hạn trung thực:
 *   - diff review đếm dòng thêm/bớt bằng multiset diff theo dòng
 *     (không phải Myers diff từng ký tự): đủ để phát hiện lệch kế
 *     hoạch và báo cáo số dòng, còn diff từng dòng xem bằng tool
 *     `coding_v2_git_diff`.
 *   - plan + review log được persist xuống đĩa
 *     (`.open-bot/coding-v2/plans/<plan-id>.json` trong workspace)
 *     nên sống qua restart process; file cache hỏng thì bỏ qua khi
 *     load, plan trong bộ nhớ vẫn là nguồn đúng nhất.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Workspace } from '../coding/workspace';

export type CodingV2ArchitectStepKind = 'explore' | 'implement' | 'verify' | 'finish';
export type CodingV2ArchitectStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type CodingV2ArchitectPlanStatus = 'draft' | 'active' | 'blocked' | 'done' | 'failed';

/** Một bước trong kế hoạch của planner. */
export interface CodingV2ArchitectStep {
  id: string;
  kind: CodingV2ArchitectStepKind;
  description: string;
  /** File bước này được chạm tới (workspace-relative, `/` separator). */
  files: string[];
  status: CodingV2ArchitectStepStatus;
  note?: string;
}

/** Một kế hoạch architect: bất biến sau khi tạo (trừ status bước/plan). */
export interface CodingV2ArchitectPlan {
  id: string;
  task: string;
  steps: CodingV2ArchitectStep[];
  status: CodingV2ArchitectPlanStatus;
  createdAt: string;
  updatedAt: string;
}

/** Một edit editor xin thực thi trong một bước. */
export interface CodingV2ArchitectEdit {
  /** Đường dẫn workspace-relative. */
  path: string;
  kind: 'create' | 'write' | 'edit' | 'delete';
  /** Nội dung đầy đủ cho create/write. */
  content?: string;
  /** Cho edit: đoạn cũ phải khớp đúng một lần. */
  oldText?: string;
  /** Cho edit: đoạn mới thay vào. */
  newText?: string;
}

/** Một file đổi trong bước, kèm số dòng thêm/bớt (multiset diff). */
export interface CodingV2ArchitectFileChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  linesAdded: number;
  linesRemoved: number;
}

/** Kết quả planner duyệt diff của một bước. */
export interface CodingV2ArchitectReview {
  planId: string;
  stepId: string;
  verdict: 'approved' | 'deviation';
  filesChanged: CodingV2ArchitectFileChange[];
  /** Mô tả từng điểm lệch (rỗng khi approved). */
  deviations: string[];
  reviewedAt: string;
}

/** Kết quả thực thi một bước. */
export interface CodingV2ArchitectExecuteResult {
  plan: CodingV2ArchitectPlan;
  review: CodingV2ArchitectReview;
  /** Tóm tắt một dòng để trả về cho agent. */
  summary: string;
}

/** Trần mặc định: một bước không đổi quá 5000 dòng (cộng thêm + bớt). */
export const CODING_V2_MAX_STEP_LINE_CHANGES = 5000;

const STEP_KINDS: ReadonlySet<string> = new Set(['explore', 'implement', 'verify', 'finish']);

/** Đường dẫn workspace-relative hợp lệ: tương đối, không `..`, không tuyệt đối. */
export function isValidCodingV2PlanPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.trim() === '') return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  if (relPath.includes('\0')) return false;
  const parts = relPath.split('/');
  return !parts.some((p) => p === '..' || p === '');
}

/** Validate đầu vào tạo plan, trả danh sách lỗi (rỗng = hợp lệ). */
export function validateCodingV2PlanInput(
  task: string,
  steps: Array<{ kind: string; description: string; files?: string[] }>,
): string[] {
  const errors: string[] = [];
  if (typeof task !== 'string' || task.trim() === '') errors.push('task không được rỗng.');
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('kế hoạch cần ít nhất 1 bước.');
    return errors;
  }
  steps.forEach((step, i) => {
    const label = `bước ${i + 1}`;
    if (!STEP_KINDS.has(step.kind)) errors.push(`${label}: kind "${step.kind}" không hợp lệ (explore/implement/verify/finish).`);
    if (typeof step.description !== 'string' || step.description.trim() === '') {
      errors.push(`${label}: description không được rỗng.`);
    }
    const files = step.files ?? [];
    if (!Array.isArray(files)) {
      errors.push(`${label}: files phải là mảng.`);
      return;
    }
    if (step.kind === 'implement' && files.length === 0) {
      errors.push(`${label}: bước implement phải khai ít nhất 1 file chạm tới.`);
    }
    const seen = new Set<string>();
    for (const file of files) {
      if (!isValidCodingV2PlanPath(file)) {
        errors.push(`${label}: file "${file}" không phải đường dẫn workspace-relative hợp lệ.`);
      }
      if (seen.has(file)) errors.push(`${label}: file "${file}" khai trùng trong cùng bước.`);
      seen.add(file);
    }
  });
  return errors;
}

/**
 * Planner tạo kế hoạch: chỉ nhận task + bước, KHÔNG viết code, KHÔNG
 * chạm file. Ném lỗi khi đầu vào không hợp lệ (fail-closed).
 */
export function createCodingV2ArchitectPlan(
  task: string,
  steps: Array<{ kind: CodingV2ArchitectStepKind; description: string; files?: string[] }>,
): CodingV2ArchitectPlan {
  const errors = validateCodingV2PlanInput(task, steps);
  if (errors.length > 0) {
    throw new Error(`Kế hoạch architect không hợp lệ: ${errors.join(' ')}`);
  }
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    task: task.trim(),
    steps: steps.map((s) => ({
      id: randomUUID(),
      kind: s.kind,
      description: s.description.trim(),
      files: [...(s.files ?? [])],
      status: 'pending' as CodingV2ArchitectStepStatus,
    })),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

/** Bước tiếp theo còn việc, hoặc null khi plan đã xong. */
export function nextCodingV2ArchitectStep(plan: CodingV2ArchitectPlan): CodingV2ArchitectStep | null {
  return plan.steps.find((s) => s.status === 'pending' || s.status === 'in_progress') ?? null;
}

/** Tỉ lệ bước xong (0..1), để báo tiến độ. */
export function codingV2ArchitectProgress(plan: CodingV2ArchitectPlan): number {
  if (plan.steps.length === 0) return 1;
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return done / plan.steps.length;
}

/** Đếm dòng thêm/bớt giữa hai nội dung bằng multiset diff theo dòng. */
export function diffCodingV2LineCounts(
  before: string | null,
  after: string | null,
): { linesAdded: number; linesRemoved: number } {
  const countLines = (text: string | null): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === null || text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const beforeCounts = countLines(before);
  const afterCounts = countLines(after);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const [line, count] of afterCounts) {
    const diff = count - (beforeCounts.get(line) ?? 0);
    if (diff > 0) linesAdded += diff;
  }
  for (const [line, count] of beforeCounts) {
    const diff = count - (afterCounts.get(line) ?? 0);
    if (diff > 0) linesRemoved += diff;
  }
  return { linesAdded, linesRemoved };
}

/**
 * Planner duyệt diff của một bước: chỉ approved khi mọi file đổi đều
 * nằm trong danh sách file bước đó khai, không xoá file ngoài kế
 * hoạch, và tổng dòng đổi không vượt trần.
 */
export function reviewCodingV2StepDiff(
  planId: string,
  step: CodingV2ArchitectStep,
  filesChanged: CodingV2ArchitectFileChange[],
  options: { maxLineChanges?: number } = {},
): CodingV2ArchitectReview {
  const deviations: string[] = [];
  const allowed = new Set(step.files);
  let totalChanged = 0;
  for (const change of filesChanged) {
    totalChanged += change.linesAdded + change.linesRemoved;
    if (!allowed.has(change.path)) {
      deviations.push(
        `file "${change.path}" đổi (${change.kind}) nhưng không nằm trong file bước này khai (${step.files.join(', ') || '(không khai file nào)'}).`,
      );
    }
    if (change.kind === 'deleted' && !allowed.has(change.path)) {
      deviations.push(`file "${change.path}" bị xoá nhưng không nằm trong kế hoạch bước này.`);
    }
  }
  const maxLineChanges = options.maxLineChanges ?? CODING_V2_MAX_STEP_LINE_CHANGES;
  if (totalChanged > maxLineChanges) {
    deviations.push(`bước đổi ${totalChanged} dòng, vượt trần ${maxLineChanges} dòng/bước.`);
  }
  return {
    planId,
    stepId: step.id,
    verdict: deviations.length === 0 ? 'approved' : 'deviation',
    filesChanged,
    deviations,
    reviewedAt: new Date().toISOString(),
  };
}

export interface CodingV2ArchitectSessionOptions {
  /** Trần dòng đổi mỗi bước (mặc định 5000). */
  maxStepLineChanges?: number;
  /**
   * Thư mục persist plan (mặc định `<workspace>/.open-bot/coding-v2/
   * plans`). Truyền null để tắt persist (chỉ giữ trong bộ nhớ).
   */
  persistDir?: string | null;
}

/** Một plan + review log của nó, dạng lưu trên đĩa. */
export interface CodingV2ArchitectPlanRecord {
  plan: CodingV2ArchitectPlan;
  reviews: CodingV2ArchitectReview[];
}

/** Thư mục persist mặc định trong một workspace. */
export function codingV2ArchitectDefaultPersistDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.open-bot', 'coding-v2', 'plans');
}

/** Serialize một plan + review log để ghi đĩa (JSON gọn). */
export function serializeCodingV2ArchitectPlan(record: CodingV2ArchitectPlanRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

const ARCHITECT_PLAN_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'active',
  'blocked',
  'done',
  'failed',
]);
const ARCHITECT_STEP_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'done',
  'failed',
  'skipped',
]);

/**
 * Parse plan đã persist. Trả `{ error }` khi file hỏng/sai dạng —
 * caller bỏ qua file đó thay vì crash (plan trong bộ nhớ vẫn đúng).
 */
export function parseCodingV2ArchitectPlan(
  text: string,
): { record: CodingV2ArchitectPlanRecord } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    return { error: `plan JSON hỏng: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'plan không phải object JSON' };
  }
  const obj = parsed as Record<string, unknown>;
  const rawPlan = obj.plan;
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return { error: 'plan thiếu trường plan' };
  }
  const plan = rawPlan as Record<string, unknown>;
  if (typeof plan.id !== 'string' || plan.id.trim() === '') return { error: 'plan thiếu id' };
  if (typeof plan.task !== 'string' || plan.task.trim() === '') return { error: 'plan thiếu task' };
  if (!ARCHITECT_PLAN_STATUSES.has(String(plan.status))) return { error: `plan status lạ: ${String(plan.status)}` };
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { error: 'plan thiếu steps' };
  const steps: CodingV2ArchitectStep[] = [];
  for (const raw of plan.steps as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'step không phải object' };
    const step = raw as Record<string, unknown>;
    if (typeof step.id !== 'string' || step.id.trim() === '') return { error: 'step thiếu id' };
    if (!STEP_KINDS.has(String(step.kind))) return { error: `step kind lạ: ${String(step.kind)}` };
    if (typeof step.description !== 'string' || step.description.trim() === '') {
      return { error: 'step thiếu description' };
    }
    if (!Array.isArray(step.files) || step.files.some((f) => !isValidCodingV2PlanPath(String(f)))) {
      return { error: 'step files không hợp lệ' };
    }
    if (!ARCHITECT_STEP_STATUSES.has(String(step.status))) {
      return { error: `step status lạ: ${String(step.status)}` };
    }
    steps.push({
      id: step.id,
      kind: step.kind as CodingV2ArchitectStepKind,
      description: step.description,
      files: [...(step.files as string[])],
      status: step.status as CodingV2ArchitectStepStatus,
      note: typeof step.note === 'string' ? step.note : undefined,
    });
  }
  const reviews: CodingV2ArchitectReview[] = [];
  if (obj.reviews !== undefined) {
    if (!Array.isArray(obj.reviews)) return { error: 'reviews phải là mảng' };
    for (const raw of obj.reviews as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'review không phải object' };
      const review = raw as Record<string, unknown>;
      if (typeof review.stepId !== 'string' || (review.verdict !== 'approved' && review.verdict !== 'deviation')) {
        return { error: 'review sai dạng' };
      }
      if (!Array.isArray(review.filesChanged) || !Array.isArray(review.deviations)) {
        return { error: 'review thiếu filesChanged/deviations' };
      }
      reviews.push({
        planId: typeof review.planId === 'string' ? review.planId : String(plan.id),
        stepId: review.stepId,
        verdict: review.verdict as 'approved' | 'deviation',
        filesChanged: review.filesChanged as CodingV2ArchitectFileChange[],
        deviations: (review.deviations as unknown[]).filter((d): d is string => typeof d === 'string'),
        reviewedAt: typeof review.reviewedAt === 'string' ? review.reviewedAt : new Date().toISOString(),
      });
    }
  }
  return {
    record: {
      plan: {
        id: plan.id,
        task: plan.task,
        steps,
        status: plan.status as CodingV2ArchitectPlanStatus,
        createdAt: typeof plan.createdAt === 'string' ? plan.createdAt : new Date().toISOString(),
        updatedAt: typeof plan.updatedAt === 'string' ? plan.updatedAt : new Date().toISOString(),
      },
      reviews,
    },
  };
}

/**
 * Phiên architect: giữ các plan trong bộ nhớ + thực thi bước bằng
 * editor qua Workspace bị giới hạn. Một instance mỗi workspace.
 * Plan + review log được persist xuống đĩa (trừ khi tắt) nên sống
 * qua restart process.
 */
export class CodingV2ArchitectSession {
  private readonly workspace: Workspace;
  private readonly plans = new Map<string, CodingV2ArchitectPlan>();
  private readonly reviews = new Map<string, CodingV2ArchitectReview[]>();
  private readonly maxStepLineChanges: number;
  /** Thư mục persist plan (null = tắt persist). */
  readonly persistDir: string | null;
  /** Lỗi persist gần nhất (null = chưa lỗi) — persist lỗi không chặn chạy. */
  lastPersistError: string | null = null;

  constructor(workspaceRoot: string, options: CodingV2ArchitectSessionOptions = {}) {
    this.workspace = new Workspace(workspaceRoot);
    this.maxStepLineChanges = options.maxStepLineChanges ?? CODING_V2_MAX_STEP_LINE_CHANGES;
    this.persistDir =
      options.persistDir === undefined
        ? codingV2ArchitectDefaultPersistDir(this.workspace.root)
        : options.persistDir;
    this.loadPersistedPlans();
  }

  /** Workspace root mà session này bị giới hạn trong đó. */
  get root(): string {
    return this.workspace.root;
  }

  /** Planner tạo plan mới (không viết code). */
  createPlan(
    task: string,
    steps: Array<{ kind: CodingV2ArchitectStepKind; description: string; files?: string[] }>,
  ): CodingV2ArchitectPlan {
    const plan = createCodingV2ArchitectPlan(task, steps);
    this.plans.set(plan.id, plan);
    this.reviews.set(plan.id, []);
    this.persistPlan(plan.id);
    return plan;
  }

  /**
   * Load plan đã persist từ đĩa vào bộ nhớ (chạy ở constructor).
   * File hỏng thì bỏ qua và đếm vào `skipped`.
   */
  loadPersistedPlans(): { loaded: number; skipped: number } {
    let loaded = 0;
    let skipped = 0;
    if (this.persistDir === null) return { loaded, skipped };
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.persistDir).filter((f) => f.endsWith('.json'));
    } catch {
      return { loaded, skipped };
    }
    for (const file of entries) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.persistDir, file), 'utf8');
      } catch {
        skipped += 1;
        continue;
      }
      const parsed = parseCodingV2ArchitectPlan(text);
      if ('error' in parsed) {
        skipped += 1;
        continue;
      }
      const { plan, reviews } = parsed.record;
      this.plans.set(plan.id, plan);
      this.reviews.set(plan.id, reviews);
      loaded += 1;
    }
    return { loaded, skipped };
  }

  /** Ghi một plan + review log xuống đĩa (lỗi persist không chặn chạy). */
  persistPlan(planId: string): boolean {
    if (this.persistDir === null) return false;
    const plan = this.plans.get(planId);
    if (!plan) return false;
    try {
      fs.mkdirSync(this.persistDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.persistDir, `${planId}.json`),
        serializeCodingV2ArchitectPlan({ plan, reviews: this.reviews.get(planId) ?? [] }),
        'utf8',
      );
      this.lastPersistError = null;
      return true;
    } catch (e) {
      this.lastPersistError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  getPlan(planId: string): CodingV2ArchitectPlan | undefined {
    return this.plans.get(planId);
  }

  listPlans(): CodingV2ArchitectPlan[] {
    return [...this.plans.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  reviewsFor(planId: string): CodingV2ArchitectReview[] {
    return [...(this.reviews.get(planId) ?? [])];
  }

  /**
   * Editor thực thi MỘT bước: áp các edit qua Workspace, rồi planner
   * duyệt diff ngay. Lệch kế hoạch -> bước fail, plan blocked, dừng.
   * Edit áp lỗi (vd oldText không khớp) -> bước fail, plan vẫn active
   * để planner sửa lại bước (không coi là lệch kế hoạch).
   */
  executeStep(
    planId: string,
    stepId: string,
    edits: CodingV2ArchitectEdit[],
  ): CodingV2ArchitectExecuteResult {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Không tìm thấy plan architect "${planId}".`);
    if (plan.status === 'done' || plan.status === 'failed') {
      throw new Error(`Plan "${planId}" đã kết thúc (status ${plan.status}), không thực thi thêm.`);
    }
    if (plan.status === 'blocked') {
      throw new Error(
        `Plan "${planId}" đang blocked do lệch kế hoạch ở bước trước — planner cần tạo plan mới hoặc sửa bước rồi thử lại.`,
      );
    }
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Không tìm thấy bước "${stepId}" trong plan "${planId}".`);
    if (step.status === 'done' || step.status === 'skipped') {
      throw new Error(`Bước "${stepId}" đã xong (status ${step.status}), không thực thi lại.`);
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error('Thực thi bước cần ít nhất 1 edit (editor phải làm gì đó cụ thể).');
    }
    for (const edit of edits) {
      if (!isValidCodingV2PlanPath(edit.path)) {
        throw new Error(`Edit chạm path không hợp lệ: "${edit.path}".`);
      }
    }

    step.status = 'in_progress';
    plan.status = 'active';
    plan.updatedAt = new Date().toISOString();

    // Snapshot trước khi sửa, để tính diff cho planner duyệt.
    const before = new Map<string, string | null>();
    for (const edit of edits) {
      if (!before.has(edit.path)) {
        before.set(edit.path, this.workspace.exists(edit.path) ? this.workspace.read(edit.path) : null);
      }
    }

    // Editor áp edit. Lỗi áp -> bước fail, plan vẫn active.
    let applyError: string | null = null;
    for (const edit of edits) {
      try {
        this.applyEdit(edit);
      } catch (e) {
        applyError = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (applyError !== null) {
      step.status = 'failed';
      step.note = `Áp edit lỗi: ${applyError}`;
      plan.updatedAt = new Date().toISOString();
      const review: CodingV2ArchitectReview = {
        planId,
        stepId,
        verdict: 'deviation',
        filesChanged: [],
        deviations: [`áp edit lỗi, chưa đổi file nào chắc chắn: ${applyError}`],
        reviewedAt: new Date().toISOString(),
      };
      this.reviews.get(planId)?.push(review);
      this.persistPlan(planId);
      return {
        plan,
        review,
        summary: `Bước "${step.description}" FAIL khi áp edit: ${applyError}. Plan vẫn active, planner sửa lại bước rồi thử lại.`,
      };
    }

    // Tính diff từng file đổi.
    const filesChanged: CodingV2ArchitectFileChange[] = [];
    for (const [relPath, beforeContent] of before) {
      const afterExists = this.workspace.exists(relPath);
      const afterContent = afterExists ? this.workspace.read(relPath) : null;
      if (beforeContent === null && afterContent !== null) {
        const { linesAdded } = diffCodingV2LineCounts(null, afterContent);
        filesChanged.push({ path: relPath, kind: 'created', linesAdded, linesRemoved: 0 });
      } else if (beforeContent !== null && afterContent === null) {
        const { linesRemoved } = diffCodingV2LineCounts(beforeContent, null);
        filesChanged.push({ path: relPath, kind: 'deleted', linesAdded: 0, linesRemoved });
      } else if (beforeContent !== null && afterContent !== null && beforeContent !== afterContent) {
        const { linesAdded, linesRemoved } = diffCodingV2LineCounts(beforeContent, afterContent);
        filesChanged.push({ path: relPath, kind: 'modified', linesAdded, linesRemoved });
      }
    }

    // Planner duyệt diff.
    const review = reviewCodingV2StepDiff(planId, step, filesChanged, {
      maxLineChanges: this.maxStepLineChanges,
    });
    this.reviews.get(planId)?.push(review);
    if (review.verdict === 'deviation') {
      step.status = 'failed';
      step.note = `Lệch kế hoạch: ${review.deviations.join(' ')}`;
      plan.status = 'blocked';
      plan.updatedAt = new Date().toISOString();
      this.persistPlan(planId);
      return {
        plan,
        review,
        summary:
          `Bước "${step.description}" LỆCH KẾ HOẠCH — plan BLOCKED, dừng lại để hỏi người dùng. ` +
          review.deviations.join(' '),
      };
    }
    step.status = 'done';
    step.note = undefined;
    const remaining = nextCodingV2ArchitectStep(plan);
    if (!remaining) plan.status = 'done';
    plan.updatedAt = new Date().toISOString();
    const changedText =
      filesChanged.length === 0
        ? 'không đổi file nào'
        : filesChanged
            .map((c) => `${c.path} (${c.kind}, +${c.linesAdded}/-${c.linesRemoved})`)
            .join(', ');
    this.persistPlan(planId);
    return {
      plan,
      review,
      summary:
        `Bước "${step.description}" xong, planner duyệt diff OK (${changedText}). ` +
        `Tiến độ plan: ${Math.round(codingV2ArchitectProgress(plan) * 100)}%.`,
    };
  }

  /** Đánh dấu một bước là skipped (planner quyết, không qua editor). */
  skipStep(planId: string, stepId: string, note?: string): CodingV2ArchitectPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Không tìm thấy plan architect "${planId}".`);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Không tìm thấy bước "${stepId}" trong plan "${planId}".`);
    if (step.status === 'done') throw new Error(`Bước "${stepId}" đã xong, không skip được.`);
    step.status = 'skipped';
    if (note !== undefined) step.note = note;
    if (!nextCodingV2ArchitectStep(plan)) plan.status = 'done';
    plan.updatedAt = new Date().toISOString();
    this.persistPlan(planId);
    return plan;
  }

  private applyEdit(edit: CodingV2ArchitectEdit): void {
    switch (edit.kind) {
      case 'create': {
        if (typeof edit.content !== 'string') throw new Error(`create "${edit.path}" cần content.`);
        if (this.workspace.exists(edit.path)) {
          throw new Error(`create "${edit.path}" thất bại: file đã tồn tại (dùng write để ghi đè).`);
        }
        this.workspace.create(edit.path, edit.content);
        return;
      }
      case 'write': {
        if (typeof edit.content !== 'string') throw new Error(`write "${edit.path}" cần content.`);
        this.workspace.write(edit.path, edit.content);
        return;
      }
      case 'edit': {
        if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
          throw new Error(`edit "${edit.path}" cần cả oldText và newText.`);
        }
        this.workspace.edit(edit.path, edit.oldText, edit.newText);
        return;
      }
      case 'delete': {
        this.workspace.delete(edit.path);
        return;
      }
      default:
        throw new Error(`Loại edit không hợp lệ: ${String((edit as { kind: unknown }).kind)}.`);
    }
  }
}
