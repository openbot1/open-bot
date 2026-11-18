/**
 * Architect–Editor routing (v1.17, Doi T3).
 *
 * Y tuong (hoc tu Aider Architect–Editor, viet lai hoan toan cho
 * open-bot, khong copy code/text/tai san repo nao):
 * - Hai model, hai vai: planner (model manh) chi lap ke hoach —
 *   chia task thanh step, xac dinh file scope; editor (model local
 *   re) chi thuc thi tung step, khong duoc doi ke hoach.
 * - Router chon cap planner/editor theo do kho task + budget:
 *   task cang kho thi planner cang manh, editor cang can chat luong
 *   toi thieu cao; task de thi editor local re la du, planner co
 *   the cung la editor (single-model mode).
 * - Fallback co cap do: editor fail mot step -> retry editor (toi
 *   da N) -> escalate step do len planner (planner tu sua truc tiep)
 *   -> doi sang editor manh hon -> fail co bao cao day du.
 *
 * Module nay thuan tuy ve logic chon + dieu phoi: viec goi model
 * that di qua interface `ModelExecutor` do caller inject (test dung
 * fake, production noi vao provider/CLI/local router). Khong goi
 * model that, khong doc credential, khong gui du lieu ra ngoai.
 */

import type { PickerTask } from './types';

/** Do kho cua task (quyet dinh cap planner/editor can dung). */
export type ArchitectDifficulty = 'trivial' | 'easy' | 'medium' | 'hard';

/** Loai step trong ke hoach cua planner. */
export type PlanStepKind = 'analyze' | 'edit' | 'test' | 'verify' | 'shell';

/** Mot step trong ke hoach. */
export interface PlanStep {
  /** Id on dinh trong plan, vd "step-1". */
  id: string;
  kind: PlanStepKind;
  /** Tieu de ngan (planner viet, hien UI). */
  title: string;
  /** Mo ta cong viec cho editor. */
  description: string;
  /** File step nay cham toi (co the rong voi analyze/verify). */
  files: string[];
  /** Id cac step phai xong truoc (step chay tuan tu theo thu tu nay). */
  dependsOn: string[];
  /** Step bat buoc hay tuy chon (tuy chon duoc bo qua khi het budget). */
  optional: boolean;
}

/** Ke hoach do planner lap (hoac do `buildArchitectPlan` lap san). */
export interface ArchitectPlan {
  /** Tom tat task (1 dong). */
  summary: string;
  difficulty: ArchitectDifficulty;
  /** File nam trong scope (planner gioi han, editor khong vuot ra). */
  fileScope: string[];
  steps: PlanStep[];
  /** Uoc tinh token cho ca plan (planner + editor). */
  estimatedTokens: number;
  /** Ly do chon cap planner/editor (hien UI). */
  rationale: string;
}

/** Mo ta mot model co the lam planner hoac editor. */
export interface ArchitectModelCandidate {
  /** Id model (ten model cloud, id local, hoac "cli:<kind>:<model>"). */
  modelId: string;
  /** Nguon chay: local / CLI agent / cloud. */
  source: 'local' | 'cli' | 'cloud';
  /** Chat luong uoc tinh (0..1). */
  quality: number;
  /** Chi phi uoc tinh (USD / 1k token). */
  costPer1kTokensUsd: number;
  /** Latency uoc tinh den token dau tien (ms). */
  estLatencyMs: number;
  /** Model co kha dung ngay bay gio khong. */
  available: boolean;
  /** Co phai model local chay tren may (re, khong gui du lieu ra). */
  local: boolean;
}

/** Cap planner/editor router chon cho mot task. */
export interface PlannerEditorPair {
  planner: ArchitectModelCandidate;
  editor: ArchitectModelCandidate;
  /** true = planner va editor la cung model (task de, tiet kiem). */
  singleModel: boolean;
  difficulty: ArchitectDifficulty;
  /** Chi phi uoc tinh cho ca task (USD). */
  estimatedCostUsd: number;
  /** Ly do chon cap nay (hien UI). */
  rationale: string;
}

/** Ket qua editor tra ve sau mot step. */
export interface EditorStepResult {
  /** Step thanh cong khong. */
  ok: boolean;
  /** Tom tat thay doi (vd "da sua 2 ham trong foo.ts"). */
  summary: string;
  /** File da doi (de verify + commit). */
  changedFiles: string[];
  /** Token da dung cho step nay. */
  tokensUsed: number;
  /** Loi khi fail (de escalate). */
  error?: string;
}

/** Ket qua planner tra ve khi tu sua mot step (escalation). */
export interface PlannerStepResult {
  ok: boolean;
  summary: string;
  changedFiles: string[];
  tokensUsed: number;
  error?: string;
}

/** Executor goi model that — caller inject, test dung fake. */
export interface ArchitectExecutors {
  /** Planner lap plan tu mo ta task (tra plan JSON da parse). */
  plan: (task: PickerTask, context: string) => Promise<ArchitectPlan>;
  /** Editor thuc thi mot step. */
  edit: (step: PlanStep, plan: ArchitectPlan) => Promise<EditorStepResult>;
  /** Planner tu sua mot step khi editor bo tay (escalation). */
  plannerFix: (step: PlanStep, plan: ArchitectPlan, lastError: string) => Promise<PlannerStepResult>;
  /** Kiem tra ket qua cuoi (optional; mac dinh luon pass). */
  verify?: (plan: ArchitectPlan, changedFiles: string[]) => Promise<{ ok: boolean; notes: string }>;
}

/** Chinh sach retry / escalation cho mot run. */
export interface ArchitectRunOptions {
  /** So lan retry editor truoc khi escalate (mac dinh 1). */
  editorRetries?: number;
  /** Co cho phep escalate step len planner khong (mac dinh true). */
  allowPlannerEscalation?: boolean;
  /** Co cho phep doi sang editor manh hon khong (mac dinh true). */
  allowStrongerEditor?: boolean;
  /** Editor manh hon de doi sang khi editor hien tai fail (optional). */
  strongerEditor?: ArchitectModelCandidate;
  /** Ngan sach token toi da cho ca run (0 = khong gioi han). */
  maxTokens?: number;
  /** Dung lai sau step nay (de test / resume). */
  stopAfterStepId?: string;
}

/** Trang thai mot step sau run. */
export type ArchitectStepStatus = 'done' | 'done-by-planner' | 'done-by-stronger-editor' | 'skipped' | 'failed';

/** Bao cao day du mot run Architect–Editor. */
export interface ArchitectRunReport {
  plan: ArchitectPlan;
  pair: PlannerEditorPair;
  steps: Array<{
    step: PlanStep;
    status: ArchitectStepStatus;
    attempts: number;
    escalated: boolean;
    summary: string;
    error?: string;
  }>;
  /** Run thanh cong toan bo (khong step nao failed). */
  ok: boolean;
  changedFiles: string[];
  tokensUsed: number;
  /** So step phai escalate len planner. */
  escalations: number;
  /** So step phai doi sang editor manh hon. */
  strongerEditorSteps: number;
  /** Ly do dung (khi fail / het budget). */
  stoppedReason?: string;
}

// ---------------------------------------------------------------------------
// Do kho task
// ---------------------------------------------------------------------------

/** Prompt dai (token) thi coi la kho them. */
export const ARCHITECT_HEAVY_PROMPT_TOKENS = 8000;
/** Prompt vua (token). */
export const ARCHITECT_MEDIUM_PROMPT_TOKENS = 2000;
/** Chat luong toi thieu cua editor theo do kho. */
export const ARCHITECT_MIN_EDITOR_QUALITY: Record<ArchitectDifficulty, number> = {
  trivial: 0.4,
  easy: 0.55,
  medium: 0.7,
  hard: 0.85,
};
/** Chat luong toi thieu cua planner theo do kho. */
export const ARCHITECT_MIN_PLANNER_QUALITY: Record<ArchitectDifficulty, number> = {
  trivial: 0.5,
  easy: 0.65,
  medium: 0.8,
  hard: 0.9,
};

/**
 * Xep do kho task: kind + prompt + tool-use + long-context +
 * qualityNeed + so file trong scope (neu biet). Tra 0..1 kem nhan.
 */
export function classifyArchitectDifficulty(
  task: PickerTask,
  fileScopeSize = 0,
): { difficulty: ArchitectDifficulty; score: number } {
  let score = 0;
  if (task.kind === 'code' || task.kind === 'reasoning') score += 0.35;
  else if (task.kind === 'research' || task.kind === 'vision') score += 0.25;
  else if (task.kind === 'creative' || task.kind === 'howto') score += 0.1;
  if (task.needsToolUse) score += 0.15;
  if (task.needsLongContext) score += 0.15;
  if (task.promptTokens >= ARCHITECT_HEAVY_PROMPT_TOKENS) score += 0.2;
  else if (task.promptTokens >= ARCHITECT_MEDIUM_PROMPT_TOKENS) score += 0.1;
  if (fileScopeSize >= 10) score += 0.15;
  else if (fileScopeSize >= 4) score += 0.08;
  score += task.qualityNeed * 0.2;
  score = Math.min(1, score);
  const difficulty: ArchitectDifficulty =
    score < 0.25 ? 'trivial' : score < 0.45 ? 'easy' : score < 0.7 ? 'medium' : 'hard';
  return { difficulty, score };
}

// ---------------------------------------------------------------------------
// Chon cap planner/editor
// ---------------------------------------------------------------------------

/** Uoc tinh token cho mot task theo do kho (de tinh chi phi). */
export function estimateArchitectTokens(difficulty: ArchitectDifficulty, promptTokens: number): number {
  const planTokens: Record<ArchitectDifficulty, number> = {
    trivial: 400,
    easy: 800,
    medium: 1500,
    hard: 3000,
  };
  const editMultiplier: Record<ArchitectDifficulty, number> = {
    trivial: 1.5,
    easy: 2,
    medium: 3,
    hard: 4,
  };
  return Math.round(promptTokens + planTokens[difficulty] * editMultiplier[difficulty]);
}

/**
 * Chon cap planner/editor:
 * - Planner: model kha dung co quality cao nhat dat nguong cua do kho;
 *   uu tien cloud/CLI manh, khong uu tien local cho planner (tru khi
 *   khong con lua chon — local manh van hon khong co planner).
 * - Editor: model re nhat dat chat luong toi thieu cua do kho; uu tien
 *   local (mien phi, khong gui code ra ngoai), roi CLI, roi cloud re.
 * - Task trivial/easy: neu editor dat ca nguong planner thi dung chung
 *   mot model (single-model) de tiet kiem 1 luot goi planner.
 * - Budget (USD): neu cap re nhat van vuot budget thi tra cap re nhat
 *   kem `overBudget=true` trong rationale — caller quyet dinh co chay
 *   khong (khong tu y cat plan o day).
 */
export function choosePlannerEditorPair(
  candidates: readonly ArchitectModelCandidate[],
  task: PickerTask,
  opts?: { budgetUsd?: number; fileScopeSize?: number },
): { pair: PlannerEditorPair; overBudget: boolean } {
  const { difficulty } = classifyArchitectDifficulty(task, opts?.fileScopeSize ?? 0);
  const available = candidates.filter((c) => c.available);
  if (available.length === 0) {
    throw new Error('No available model candidate for Architect-Editor routing.');
  }
  const minPlanner = ARCHITECT_MIN_PLANNER_QUALITY[difficulty];
  const minEditor = ARCHITECT_MIN_EDITOR_QUALITY[difficulty];
  // Planner: quality cao nhat trong so dat nguong; neu khong ai dat
  // nguong thi lay quality cao nhat hien co (ha cap, ghi ro rationale).
  const plannerPool = available.filter((c) => c.quality >= minPlanner);
  const plannerCandidates = plannerPool.length > 0 ? plannerPool : available;
  const planner = [...plannerCandidates].sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    return a.costPer1kTokensUsd - b.costPer1kTokensUsd;
  })[0] as ArchitectModelCandidate;
  const plannerDowngraded = planner.quality < minPlanner;
  // Editor: re nhat trong so dat nguong chat luong; uu tien local
  // truoc (cost ~0) roi moi xet cost.
  const editorPool = available.filter((c) => c.quality >= minEditor);
  const editorCandidates = editorPool.length > 0 ? editorPool : available;
  const editor = [...editorCandidates].sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    if (a.costPer1kTokensUsd !== b.costPer1kTokensUsd) return a.costPer1kTokensUsd - b.costPer1kTokensUsd;
    return b.quality - a.quality;
  })[0] as ArchitectModelCandidate;
  const editorDowngraded = editor.quality < minEditor;
  // Single-model khi task de va editor du manh lam luon planner.
  const singleModel =
    (difficulty === 'trivial' || difficulty === 'easy') &&
    editor.quality >= minPlanner &&
    editor.modelId === planner.modelId;
  const tokens = estimateArchitectTokens(difficulty, task.promptTokens);
  const plannerCost = (tokens * 0.3 * planner.costPer1kTokensUsd) / 1000;
  const editorCost = (tokens * 0.7 * editor.costPer1kTokensUsd) / 1000;
  const estimatedCostUsd = singleModel ? (tokens * editor.costPer1kTokensUsd) / 1000 : plannerCost + editorCost;
  const budgetUsd = opts?.budgetUsd;
  const overBudget = budgetUsd !== undefined && estimatedCostUsd > budgetUsd;
  const rationaleParts = [
    `Task ${difficulty} — planner ${planner.modelId} (quality ${planner.quality}), editor ${editor.modelId} (${editor.source}${editor.local ? ', local' : ''}).`,
  ];
  if (singleModel) rationaleParts.push('One model does both roles to save a planner call.');
  if (plannerDowngraded) rationaleParts.push(`No planner meets the quality bar ${minPlanner}; using the best available.`);
  if (editorDowngraded) rationaleParts.push(`No editor meets the quality bar ${minEditor}; using the best available.`);
  if (overBudget) rationaleParts.push(`Estimated cost $${estimatedCostUsd.toFixed(4)} exceeds budget $${budgetUsd?.toFixed(4)}.`);
  return {
    pair: {
      planner,
      editor,
      singleModel,
      difficulty,
      estimatedCostUsd,
      rationale: rationaleParts.join(' '),
    },
    overBudget,
  };
}

// ---------------------------------------------------------------------------
// Lap plan san (khong can goi planner) — dung khi planner chua san / test
// ---------------------------------------------------------------------------

/**
 * Lap plan xac dinh tu task + file scope (khong goi LLM): analyze ->
 * edit theo tung nhom file -> test -> verify. Planner that (qua
 * `ArchitectExecutors.plan`) co the thay the plan nay bang plan tot
 * hon; plan san nay dam bao luon co plan chay duoc offline.
 */
export function buildArchitectPlan(task: PickerTask, fileScope: string[]): ArchitectPlan {
  const { difficulty } = classifyArchitectDifficulty(task, fileScope.length);
  const steps: PlanStep[] = [];
  steps.push({
    id: 'step-1',
    kind: 'analyze',
    title: 'Analyze task and file scope',
    description: `Read the task and the ${fileScope.length} file(s) in scope; confirm what needs to change before editing.`,
    files: [...fileScope],
    dependsOn: [],
    optional: false,
  });
  // Gom file theo thu muc de moi step edit khong qua lon.
  const groups = new Map<string, string[]>();
  for (const f of fileScope) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    const list = groups.get(dir) ?? [];
    list.push(f);
    groups.set(dir, list);
  }
  let n = 2;
  for (const [dir, files] of groups) {
    steps.push({
      id: `step-${n}`,
      kind: 'edit',
      title: `Edit files in ${dir}`,
      description: `Apply the planned change to ${files.join(', ')}. Keep edits minimal and inside file scope.`,
      files,
      dependsOn: ['step-1'],
      optional: false,
    });
    n += 1;
  }
  if (task.kind === 'code' || task.needsToolUse) {
    steps.push({
      id: `step-${n}`,
      kind: 'test',
      title: 'Run relevant tests',
      description: 'Run the tests covering the changed files; fix failures before finishing.',
      files: [...fileScope],
      dependsOn: steps.filter((s) => s.kind === 'edit').map((s) => s.id),
      optional: false,
    });
    n += 1;
  }
  steps.push({
    id: `step-${n}`,
    kind: 'verify',
    title: 'Verify the result',
    description: 'Check the final state against the task: files changed, tests pass, nothing outside scope touched.',
    files: [...fileScope],
    dependsOn: steps.filter((s) => s.kind !== 'verify').map((s) => s.id),
    optional: false,
  });
  return {
    summary: `${task.kind} task (${difficulty}) over ${fileScope.length} file(s)`,
    difficulty,
    fileScope: [...fileScope],
    steps,
    estimatedTokens: estimateArchitectTokens(difficulty, task.promptTokens),
    rationale: 'Deterministic plan: analyze, edit per directory, test, verify.',
  };
}

// ---------------------------------------------------------------------------
// Chay plan: editor thuc thi, escalate khi fail
// ---------------------------------------------------------------------------

/**
 * Chay mot ArchitectPlan voi executor da inject.
 *
 * Thu tu: step chay tuan tu theo `dependsOn` (plan cua
 * `buildArchitectPlan` da sap dung thu tu; step co dependsOn chua
 * xong thi bo qua — khong chay step lech thu tu). Moi step edit:
 * editor thu, fail thi retry `editorRetries` lan, roi escalate len
 * planner (neu cho phep), roi doi sang editor manh hon (neu co),
 * roi moi danh failed. Het budget token thi dung ca run.
 */
export async function runArchitectEditor(
  plan: ArchitectPlan,
  pair: PlannerEditorPair,
  executors: ArchitectExecutors,
  opts: ArchitectRunOptions = {},
): Promise<ArchitectRunReport> {
  const editorRetries = opts.editorRetries ?? 1;
  const allowEscalation = opts.allowPlannerEscalation ?? true;
  const allowStronger = opts.allowStrongerEditor ?? true;
  const maxTokens = opts.maxTokens ?? 0;
  const report: ArchitectRunReport = {
    plan,
    pair,
    steps: [],
    ok: true,
    changedFiles: [],
    tokensUsed: 0,
    escalations: 0,
    strongerEditorSteps: 0,
  };
  const done = new Set<string>();
  const changed = new Set<string>();
  for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx += 1) {
    const step = plan.steps[stepIdx] as PlanStep;
    // Step phu thuoc step chua xong thi bo qua (khong chay lech).
    const depsMet = step.dependsOn.every((d) => done.has(d));
    if (!depsMet) {
      report.steps.push({ step, status: 'skipped', attempts: 0, escalated: false, summary: 'Skipped: a dependency did not finish.' });
      report.ok = false;
      report.stoppedReason ??= `Step ${step.id} skipped because a dependency did not finish.`;
      continue;
    }
    if (maxTokens > 0 && report.tokensUsed >= maxTokens) {
      report.steps.push({ step, status: 'skipped', attempts: 0, escalated: false, summary: 'Skipped: token budget exhausted.' });
      report.ok = false;
      report.stoppedReason ??= 'Token budget exhausted.';
      continue;
    }
    // Analyze/verify khong can editor: chay qua executor.edit voi
    // cung co che (fake don gian), nhung khong escalate.
    let attempts = 0;
    let lastError = '';
    let status: ArchitectStepStatus | null = null;
    let summary = '';
    let escalated = false;
    while (attempts <= editorRetries) {
      attempts += 1;
      let res: EditorStepResult;
      try {
        res = await executors.edit(step, plan);
      } catch (err) {
        res = { ok: false, summary: '', changedFiles: [], tokensUsed: 0, error: err instanceof Error ? err.message : String(err) };
      }
      report.tokensUsed += res.tokensUsed;
      if (res.ok) {
        status = 'done';
        summary = res.summary;
        for (const f of res.changedFiles) changed.add(f);
        break;
      }
      lastError = res.error ?? 'Editor failed without an error message.';
      if (attempts > editorRetries) break;
    }
    if (status === null) {
      // Escalation 1: planner tu sua.
      if (allowEscalation && step.kind === 'edit') {
        escalated = true;
        report.escalations += 1;
        let fixed: PlannerStepResult;
        try {
          fixed = await executors.plannerFix(step, plan, lastError);
        } catch (err) {
          fixed = { ok: false, summary: '', changedFiles: [], tokensUsed: 0, error: err instanceof Error ? err.message : String(err) };
        }
        report.tokensUsed += fixed.tokensUsed;
        if (fixed.ok) {
          status = 'done-by-planner';
          summary = fixed.summary;
          for (const f of fixed.changedFiles) changed.add(f);
        } else {
          lastError = fixed.error ?? lastError;
        }
      }
      // Escalation 2: editor manh hon thu lai mot lan.
      if (status === null && allowStronger && opts.strongerEditor && step.kind === 'edit') {
        report.strongerEditorSteps += 1;
        let res: EditorStepResult;
        try {
          res = await executors.edit(step, plan);
        } catch (err) {
          res = { ok: false, summary: '', changedFiles: [], tokensUsed: 0, error: err instanceof Error ? err.message : String(err) };
        }
        attempts += 1;
        report.tokensUsed += res.tokensUsed;
        if (res.ok) {
          status = 'done-by-stronger-editor';
          summary = res.summary;
          for (const f of res.changedFiles) changed.add(f);
        } else {
          lastError = res.error ?? lastError;
        }
      }
    }
    if (status === null) {
      status = 'failed';
      report.ok = false;
      report.stoppedReason = `Step ${step.id} failed: ${lastError}`;
      report.steps.push({ step, status, attempts, escalated, summary: '', error: lastError });
      if (!step.optional) {
        // Ghi ro cac step con lai la skipped de bao cao day du.
        for (const rest of plan.steps.slice(stepIdx + 1)) {
          report.steps.push({ step: rest, status: 'skipped', attempts: 0, escalated: false, summary: 'Skipped: an earlier step failed.' });
        }
        break;
      }
      continue;
    }
    done.add(step.id);
    report.steps.push({ step, status, attempts, escalated, summary });
    if (opts.stopAfterStepId === step.id) break;
  }
  report.changedFiles = [...changed].sort();
  // Verify cuoi (best-effort, khong lam hong run khi verify loi).
  if (report.ok && executors.verify) {
    try {
      const v = await executors.verify(plan, report.changedFiles);
      if (!v.ok) {
        report.ok = false;
        report.stoppedReason = `Verification failed: ${v.notes}`;
      }
    } catch {
      // Verify loi thi bo qua — run chinh da xong.
    }
  }
  return report;
}
