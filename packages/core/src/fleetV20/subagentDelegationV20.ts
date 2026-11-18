/**
 * Delegation cho subagent chuyên biệt v20 — nối vào cây subagent hiện có
 * (v1.33, Đội T6).
 *
 * Tầng cầu nối giữa 3 module v20 (`specializedSubagentsV20.ts` — spec +
 * resolve, `subagentContextV20.ts` — context cô lập + handoff) và hệ
 * delegation/subagent hiện có trong repo — `subagents/nested.ts`
 * (`SubagentTree`: depth/spawn/context budget, chặn task trùng) và
 * `subagents/fanout.ts` (chạy song song theo vòng). Module này KHÔNG
 * viết cây spawn song song, KHÔNG gọi provider, KHÔNG chạy model thật —
 * nó trả lời 4 câu mà các tầng dưới chưa trả lời:
 *
 * 1. SPAWN QUA CÂY HIỆN CÓ NHƯ THẾ NÀO: `requestSpecializedV20Spawn`
 *    resolve spec (tool giao với cha) rồi xin node từ `SubagentTree`
 *    bằng `requestSpawn` — mọi luật chặn của cây (maxDepth,
 *    maxSpawnsPerRoot/Branch, context budget tổng, task trùng đang
 *    chạy) đều áp dụng nguyên vẹn cho subagent chuyên biệt. Chuyên
 *    biệt là lá (`leafOnly`): node con của nó bị chặn ngay ở
 *    `requestSpawn` vì depth đã chạm giới hạn nhánh — hàm này kiểm tra
 *    tường minh và trả denial `leaf-only` thay vì để cây tự chặn
 *    bằng maxDepth chung (thông báo rõ hơn cho cha).
 * 2. SÓNG CHẠY RA SAO, AI XONG AI CHƯA: `SpecializedV20WaveRun` —
 *    state machine thuần theo dõi từng request qua các sóng của
 *    `planSpecializedV20Spawns` (pending → running → done/failed/
 *    blocked/invalid-output), kèm số lần retry. Sóng sau chỉ bắt đầu
 *    khi mọi dep của nó đã done (không chạy mù khi dep fail).
 * 3. OUTPUT LỖI THÌ SAO: handoff về mà validator của loại báo lỗi →
 *    không nhận output, không đổ lỗi cho cha ngay: retry tối đa
 *    `maxRetries` (mặc định 2) rồi mới escalate (đưa vào danh sách
 *    `escalated` để cha quyết định — retry tay, giao người, hay bỏ).
 *    Verify verdict `fail` KHÔNG phải lỗi output — đó là kết quả hợp
 *    lệ (code fail thật), không retry.
 * 4. CHA NHẬN LẠI ĐƯỢC GÌ: gộp kết quả cả sóng thành một bản tóm tắt
 *    duy nhất cho context cha — explore findings dedupe theo claim
 *    (giữ confidence cao nhất + gộp nguồn), plan steps dedupe theo
 *    title, verify verdict rollup (pass chỉ khi mọi verify đều pass
 *    có bằng chứng). Mỗi node con được tóm tắt bằng
 *    `summarizeChildForParent` của nested.ts (cắt 2.000 ký tự) nên
 *    context cha không bao giờ phình vì transcript con.
 */

import {
  type ExploreV20Finding,
  type ExploreV20Output,
  type PlanV20Output,
  type SpecializedV20Kind,
  type VerifyV20Verdict,
  getSpecializedV20Spec,
  resolveSpecializedV20Spawn,
  validateExploreV20Output,
  validatePlanV20Output,
  validateVerifyV20Verdict,
} from './specializedSubagentsV20';
import type { SubagentV20Handoff } from './subagentContextV20';
import { validateSubagentV20Handoff } from './subagentContextV20';
import {
  type SpawnRequest,
  type SubagentNode,
  type SubagentTree,
  summarizeChildForParent,
} from '../subagents/nested';

// ---------------------------------------------------------------------------
// Spawn qua cây hiện có
// ---------------------------------------------------------------------------

export type SpecializedV20SpawnDenial =
  | 'leaf-only'
  | 'max-depth'
  | 'max-spawns-root'
  | 'max-spawns-branch'
  | 'context-budget-total'
  | 'duplicate-task-running'
  | 'unknown-parent'
  | 'resolve-failed';

export interface RequestSpecializedV20SpawnResult {
  /** Node con trong cây (khi ok). */
  node?: SubagentNode;
  /** true = cây đã cấp node con. */
  ok: boolean;
  /** Lý do chặn (khi !ok). */
  denial?: SpecializedV20SpawnDenial;
  /** Thông báo rõ cho cha (khi !ok). */
  message?: string;
  /** Tool cuối cùng con được dùng (khi ok). */
  tools?: string[];
  /** Tier model con chạy (khi ok). */
  modelTier?: string;
}

export interface RequestSpecializedV20SpawnOptions {
  /** Id node cha trong cây (mặc định = root của cây). */
  parentId?: string;
  /** Tier model muốn dùng (mặc định = tier mặc định của loại). */
  modelTier?: 'cheap' | 'standard' | 'strong';
  /** Budget token riêng của node con (mặc định = budget context của loại / 4 ký tự ≈ 1 token). */
  budgetTokens?: number;
}

/**
 * Xin spawn subagent chuyên biệt qua cây hiện có. Thứ tự kiểm tra:
 * (1) resolve spec — lỗi resolve (role/tool) thì denial `resolve-failed`,
 * không chạm vào cây; (2) leaf-only — cha là node lá của sóng v20
 * (depth đã >= maxDepth - 0?) — thực tế: node cha có tên là một loại
 * chuyên biệt (`explore`/`plan`/`verify`) thì không được spawn con nữa,
 * vì chuyên biệt là lá của cây; (3) `SubagentTree.requestSpawn` —
 * mọi luật chặn của cây áp dụng nguyên vẹn.
 */
export function requestSpecializedV20Spawn(
  tree: SubagentTree,
  kind: SpecializedV20Kind,
  task: string,
  parentToolNames: readonly string[],
  options: RequestSpecializedV20SpawnOptions = {},
): RequestSpecializedV20SpawnResult {
  const parentId = options.parentId ?? tree.rootId;
  let resolved;
  try {
    resolved = resolveSpecializedV20Spawn(kind, parentToolNames, {
      ...(options.modelTier ? { modelTier: options.modelTier } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      denial: 'resolve-failed',
      message: `Không resolve được subagent ${kind}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parent = tree.getNode(parentId);
  if (!parent) {
    return { ok: false, denial: 'unknown-parent', message: 'không tìm thấy node cha trong cây subagent' };
  }
  // Lá của cây spawn không được spawn con: node cha mang tên một loại
  // chuyên biệt (đã được spawn bằng hàm này) thì chặn ngay.
  if (['explore', 'plan', 'verify'].includes(parent.name)) {
    return {
      ok: false,
      denial: 'leaf-only',
      message:
        `Node cha "${parent.name}" là subagent chuyên biệt (lá của cây spawn) — không được spawn con nữa. ` +
        `Giao task này cho cha của nó hoặc cho một subagent chuyên biệt khác cùng sóng.`,
    };
  }
  const spec = getSpecializedV20Spec(kind);
  const budgetTokens =
    options.budgetTokens ?? Math.max(1000, Math.floor(spec.timeoutMs / 100));
  const spawn: SpawnRequest = tree.requestSpawn(parentId, task, {
    name: kind,
    tools: resolved.tools,
    budgetTokens,
  });
  if (!spawn.ok) {
    return { ok: false, denial: spawn.reason, message: spawn.message };
  }
  return {
    ok: true,
    node: spawn.node,
    tools: resolved.tools,
    modelTier: resolved.modelTier,
  };
}

// ---------------------------------------------------------------------------
// Wave run: state machine theo dõi sóng
// ---------------------------------------------------------------------------

export type SpecializedV20RequestStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'invalid-output';

export interface SpecializedV20WaveRequestState {
  id: string;
  kind: SpecializedV20Kind;
  task: string;
  dependsOn: string[];
  /** Sóng mà request này thuộc về (từ planSpecializedV20Spawns). */
  wave: number;
  status: SpecializedV20RequestStatus;
  /** Id node trong cây (khi đã spawn). */
  nodeId?: string;
  /** Handoff đã nhận (khi done — output đã validate). */
  handoff?: SubagentV20Handoff;
  /** Số lần retry vì output không hợp lệ (tối đa maxRetries). */
  retries: number;
  /** Lý do fail/blocked/invalid (để cha/escalation đọc). */
  error?: string;
}

/** Một lần chạy sóng subagent chuyên biệt v20 (toàn bộ kế hoạch spawn). */
export interface SpecializedV20WaveRun {
  /** Id run ổn định. */
  id: string;
  /** Id task/bot cha giao sóng này. */
  parentTaskId: string;
  requests: SpecializedV20WaveRequestState[];
  /** Số sóng trong kế hoạch. */
  totalWaves: number;
  /** Sóng đang chạy (1-based; 0 = chưa bắt đầu). */
  currentWave: number;
  /** Số retry tối đa vì output không hợp lệ trước khi escalate. */
  maxRetries: number;
  startedAt: number;
  finishedAt?: number;
}

export const SPECIALIZED_V20_DEFAULT_MAX_RETRIES = 2;

export interface CreateSpecializedV20WaveRunInput {
  id: string;
  parentTaskId: string;
  /** Kế hoạch sóng (từ planSpecializedV20Spawns) + request gốc. */
  waves: readonly { wave: number; requestIds: string[] }[];
  requests: readonly { id: string; kind: SpecializedV20Kind; task: string; dependsOn?: string[] }[];
  maxRetries?: number;
  startedAt?: number;
}

/** Tạo wave run từ kế hoạch sóng đã xếp (validate trùng/chu trình ở tầng plan, không validate lại ở đây). */
export function createSpecializedV20WaveRun(input: CreateSpecializedV20WaveRunInput): SpecializedV20WaveRun {
  const waveOf = new Map<string, number>();
  for (const wave of input.waves) {
    for (const requestId of wave.requestIds) waveOf.set(requestId, wave.wave);
  }
  const requests: SpecializedV20WaveRequestState[] = input.requests.map((r) => ({
    id: r.id,
    kind: r.kind,
    task: r.task,
    dependsOn: [...(r.dependsOn ?? [])],
    wave: waveOf.get(r.id) ?? 1,
    status: 'pending',
    retries: 0,
  }));
  return {
    id: input.id,
    parentTaskId: input.parentTaskId,
    requests,
    totalWaves: input.waves.length,
    currentWave: 0,
    maxRetries: input.maxRetries ?? SPECIALIZED_V20_DEFAULT_MAX_RETRIES,
    startedAt: input.startedAt ?? Date.now(),
  };
}

/** Request theo id (bản sao — caller không sửa được run qua nó). */
export function getSpecializedV20WaveRequest(
  run: SpecializedV20WaveRun,
  requestId: string,
): SpecializedV20WaveRequestState | undefined {
  const req = run.requests.find((r) => r.id === requestId);
  return req ? { ...req, dependsOn: [...req.dependsOn] } : undefined;
}

/**
 * Sóng tiếp theo được chạy: sóng nhỏ nhất mà mọi request trong đó đang
 * pending VÀ mọi dep đã done. Trả null khi không còn sóng chạy được
 * (đã xong hết, hoặc đang kẹt vì dep fail/blocked — xem `blockedWaveRunRequests`).
 */
export function nextSpecializedV20Wave(run: SpecializedV20WaveRun): number | null {
  const doneIds = new Set(run.requests.filter((r) => r.status === 'done').map((r) => r.id));
  for (let wave = 1; wave <= run.totalWaves; wave++) {
    const inWave = run.requests.filter((r) => r.wave === wave);
    if (inWave.length === 0) continue;
    if (inWave.every((r) => r.status === 'done' || r.status === 'failed')) continue;
    if (inWave.some((r) => r.status === 'running')) return wave;
    if (inWave.some((r) => r.status === 'pending') && inWave.every((r) => r.dependsOn.every((d) => doneIds.has(d)))) {
      return wave;
    }
  }
  return null;
}

/** Request đang kẹt vì dep fail/blocked/invalid (sóng sau không chạy được). */
export function blockedSpecializedV20Requests(run: SpecializedV20WaveRun): SpecializedV20WaveRequestState[] {
  const byId = new Map(run.requests.map((r) => [r.id, r]));
  return run.requests.filter(
    (r) =>
      r.status === 'pending' &&
      r.dependsOn.some((d) => {
        const dep = byId.get(d);
        return dep !== undefined && dep.status !== 'done';
      }) &&
      // Chỉ tính là kẹt khi dep đã kết thúc ở trạng thái xấu (không phải đang chạy/chờ).
      r.dependsOn.some((d) => {
        const dep = byId.get(d);
        return dep !== undefined && (dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'invalid-output');
      }),
  );
}

/** Đánh dấu các request kẹt thành `blocked` (kèm lý do dep nào đã fail) — run không treo mãi ở pending. */
export function blockSpecializedV20Requests(run: SpecializedV20WaveRun): SpecializedV20WaveRun {
  const byId = new Map(run.requests.map((r) => [r.id, r]));
  const next: SpecializedV20WaveRun = {
    ...run,
    requests: run.requests.map((r) => {
      if (r.status !== 'pending') return r;
      const badDeps = r.dependsOn.filter((d) => {
        const dep = byId.get(d);
        return dep !== undefined && (dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'invalid-output');
      });
      if (badDeps.length === 0) return r;
      return {
        ...r,
        status: 'blocked',
        error: `Không chạy được vì dependency đã fail/blocked: ${badDeps.join(', ')}.`,
      };
    }),
  };
  return next;
}

function withRequestUpdated(
  run: SpecializedV20WaveRun,
  requestId: string,
  patch: Partial<SpecializedV20WaveRequestState>,
): SpecializedV20WaveRun {
  return {
    ...run,
    requests: run.requests.map((r) => (r.id === requestId ? { ...r, ...patch } : r)),
  };
}

/** Đánh dấu request bắt đầu chạy (pending → running, kèm nodeId trong cây). */
export function startSpecializedV20Request(
  run: SpecializedV20WaveRun,
  requestId: string,
  nodeId: string,
): SpecializedV20WaveRun {
  const req = run.requests.find((r) => r.id === requestId);
  if (!req || req.status !== 'pending') return run;
  const next = withRequestUpdated(run, requestId, { status: 'running', nodeId });
  return { ...next, currentWave: Math.max(next.currentWave, req.wave) };
}

/** Đánh dấu request fail (lỗi chạy, vd timeout/spawn denial) — không retry tự động ở đây. */
export function failSpecializedV20Request(
  run: SpecializedV20WaveRun,
  requestId: string,
  error: string,
): SpecializedV20WaveRun {
  const req = run.requests.find((r) => r.id === requestId);
  if (!req || (req.status !== 'running' && req.status !== 'pending')) return run;
  return withRequestUpdated(run, requestId, { status: 'failed', error });
}

/** Validate output thô theo loại của request (dùng validator của specializedSubagentsV20). */
export function validateSpecializedV20RequestOutput(
  kind: SpecializedV20Kind,
  output: unknown,
): string[] {
  switch (kind) {
    case 'explore':
      return validateExploreV20Output(output);
    case 'plan':
      return validatePlanV20Output(output);
    case 'verify':
      return validateVerifyV20Verdict(output);
    default:
      return [`Loại subagent "${String(kind)}" không tồn tại — không biết validate output bằng schema nào.`];
  }
}

export interface AttachSpecializedV20HandoffResult {
  run: SpecializedV20WaveRun;
  /** true = handoff đã nhận (output hợp lệ, request → done). */
  accepted: boolean;
  /** Lý do từ chối (khi !accepted): handoff sai envelope, output sai schema, hay đã hết retry. */
  errors: string[];
  /** true = request đã hết retry và bị escalate (cha phải quyết định tay). */
  escalated: boolean;
}

/**
 * Nhận handoff của một request đang chạy. Luồng fail-closed:
 * (1) handoff sai envelope → từ chối, không đổi trạng thái;
 * (2) output sai schema của loại → request → `invalid-output`, retry
 *     +1 (chưa hết retry thì caller spawn lại con khác cho cùng
 *     request; hết retry → `failed` + escalate);
 * (3) output hợp lệ → request → `done`, handoff đính kèm.
 * Verify verdict `fail` là output HỢP LỆ (code fail thật) → done,
 * không retry — retry verify fail là đốt token vô ích.
 */
export function attachSpecializedV20Handoff(
  run: SpecializedV20WaveRun,
  requestId: string,
  handoff: SubagentV20Handoff,
): AttachSpecializedV20HandoffResult {
  const req = run.requests.find((r) => r.id === requestId);
  if (!req) {
    return { run, accepted: false, errors: [`Không có request "${requestId}" trong wave run "${run.id}".`], escalated: false };
  }
  if (req.status !== 'running') {
    return { run, accepted: false, errors: [`Request "${requestId}" đang ở trạng thái ${req.status}, không nhận handoff (chỉ nhận khi running).`], escalated: false };
  }
  const envelopeErrors = validateSubagentV20Handoff(handoff);
  if (envelopeErrors.length > 0) {
    return { run, accepted: false, errors: envelopeErrors, escalated: false };
  }
  if (handoff.contextId === undefined || handoff.kind !== req.kind) {
    return {
      run,
      accepted: false,
      errors: [`Handoff cho request "${requestId}" sai loại (cần ${req.kind}, nhận ${String(handoff.kind)}) — có thể handoff của con khác lọt sang.`],
      escalated: false,
    };
  }
  const outputErrors = validateSpecializedV20RequestOutput(req.kind, handoff.output);
  if (outputErrors.length > 0) {
    const retries = req.retries + 1;
    if (retries > run.maxRetries) {
      const next = withRequestUpdated(run, requestId, {
        status: 'failed',
        retries,
        error: `Output không hợp lệ sau ${run.maxRetries} lần retry (escalate): ${outputErrors.join('; ')}`,
      });
      return { run: next, accepted: false, errors: outputErrors, escalated: true };
    }
    const next = withRequestUpdated(run, requestId, {
      status: 'invalid-output',
      retries,
      error: `Output không hợp lệ (lần ${retries}/${run.maxRetries}): ${outputErrors.join('; ')}`,
    });
    return { run: next, accepted: false, errors: outputErrors, escalated: false };
  }
  const next = withRequestUpdated(run, requestId, { status: 'done', handoff });
  return { run: next, accepted: true, errors: [], escalated: false };
}

/** Cho request `invalid-output` chạy lại (invalid-output → pending, giữ nguyên số retry). */
export function retrySpecializedV20Request(run: SpecializedV20WaveRun, requestId: string): SpecializedV20WaveRun {
  const req = run.requests.find((r) => r.id === requestId);
  if (!req || req.status !== 'invalid-output') return run;
  return withRequestUpdated(run, requestId, { status: 'pending', error: undefined, nodeId: undefined });
}

/** true khi mọi request đã kết thúc (done/failed/blocked — không còn pending/running/invalid-output). */
export function isSpecializedV20WaveRunComplete(run: SpecializedV20WaveRun): boolean {
  return run.requests.every((r) => r.status === 'done' || r.status === 'failed' || r.status === 'blocked');
}

/** Request đã escalate (fail vì output sai sau hết retry) — cha phải quyết định tay. */
export function escalatedSpecializedV20Requests(run: SpecializedV20WaveRun): SpecializedV20WaveRequestState[] {
  return run.requests.filter((r) => r.status === 'failed' && (r.error ?? '').includes('escalate'));
}

// ---------------------------------------------------------------------------
// Gộp kết quả sóng cho cha
// ---------------------------------------------------------------------------

/** Confidence xếp hạng để dedupe findings (high thắng medium thắng low). */
const EXPLORE_CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function normalizeExploreClaim(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Gộp findings explore của cả sóng: claim trùng (sau normalize) thì
 * gộp thành một finding — giữ confidence cao nhất, gộp nguồn (không
 * trùng), đếm số con cùng khẳng định (`supportCount`). Sắp theo
 * confidence giảm dần rồi claim tăng dần (deterministic).
 */
export function mergeExploreV20Findings(
  handoffs: readonly SubagentV20Handoff[],
): (ExploreV20Finding & { supportCount: number })[] {
  const merged = new Map<string, ExploreV20Finding & { supportCount: number }>();
  for (const handoff of handoffs) {
    if (handoff.kind !== 'explore' || !handoff.outputValid) continue;
    const output = handoff.output as ExploreV20Output | null;
    if (!output || !Array.isArray(output.findings)) continue;
    for (const finding of output.findings) {
      const key = normalizeExploreClaim(finding.claim);
      if (key.length === 0) continue;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          claim: finding.claim.trim(),
          sources: [...new Set(finding.sources)],
          confidence: finding.confidence,
          supportCount: 1,
        });
        continue;
      }
      existing.supportCount += 1;
      existing.sources = [...new Set([...existing.sources, ...finding.sources])];
      if ((EXPLORE_CONFIDENCE_RANK[finding.confidence] ?? 0) > (EXPLORE_CONFIDENCE_RANK[existing.confidence] ?? 0)) {
        existing.confidence = finding.confidence;
      }
    }
  }
  return [...merged.values()].sort((a, b) => {
    const rank = (EXPLORE_CONFIDENCE_RANK[b.confidence] ?? 0) - (EXPLORE_CONFIDENCE_RANK[a.confidence] ?? 0);
    if (rank !== 0) return rank;
    return a.claim.localeCompare(b.claim);
  });
}

/**
 * Gộp plan của cả sóng: step trùng title thì giữ step đầu (kèm file
 * gộp), openQuestions/risks dedupe giữ nguyên thứ tự xuất hiện. Trả
 * về plan gộp + số step trùng đã gộp (để cha biết sóng có overlap).
 */
export function mergePlanV20Outputs(
  handoffs: readonly SubagentV20Handoff[],
): { plan: PlanV20Output; mergedSteps: number } {
  const steps: PlanV20Output['steps'] = [];
  const seenTitles = new Set<string>();
  let mergedSteps = 0;
  const openQuestions: string[] = [];
  const risks: string[] = [];
  const goals: string[] = [];
  for (const handoff of handoffs) {
    if (handoff.kind !== 'plan' || !handoff.outputValid) continue;
    const output = handoff.output as PlanV20Output | null;
    if (!output || !Array.isArray(output.steps)) continue;
    goals.push(output.goal);
    for (const step of output.steps) {
      const key = step.title.trim().toLowerCase();
      const existing = steps.find((s) => s.title.trim().toLowerCase() === key);
      if (existing) {
        mergedSteps += 1;
        existing.files = [...new Set([...existing.files, ...step.files])];
        continue;
      }
      seenTitles.add(key);
      steps.push({ ...step, files: [...step.files] });
    }
    for (const q of output.openQuestions ?? []) if (!openQuestions.includes(q)) openQuestions.push(q);
    for (const risk of output.risks ?? []) if (!risks.includes(risk)) risks.push(risk);
  }
  return {
    plan: {
      goal: goals.length === 1 ? goals[0] : goals.length > 1 ? `Gộp ${goals.length} plan: ${goals.join(' | ')}` : '',
      steps,
      openQuestions,
      risks,
    },
    mergedSteps,
  };
}

/** Rollup verdict verify của cả sóng: pass chỉ khi mọi verify đều done + output hợp lệ + verdict pass. */
export function rollupVerifyV20Verdicts(
  run: SpecializedV20WaveRun,
): {
  /** pass/fail/inconclusive — inconclusive khi chưa có verify nào done. */
  verdict: 'pass' | 'fail' | 'inconclusive';
  passed: boolean;
  totalVerify: number;
  doneVerify: number;
  failedChecks: { requestId: string; check: string; command: string; outputExcerpt: string }[];
  summary: string;
} {
  const verifyReqs = run.requests.filter((r) => r.kind === 'verify');
  const done = verifyReqs.filter((r) => r.status === 'done' && r.handoff?.outputValid);
  const failedChecks: { requestId: string; check: string; command: string; outputExcerpt: string }[] = [];
  for (const req of done) {
    const verdict = req.handoff?.output as VerifyV20Verdict | null;
    if (!verdict || !Array.isArray(verdict.checks)) continue;
    for (const check of verdict.checks) {
      if (!check.passed) {
        failedChecks.push({ requestId: req.id, check: check.check, command: check.command, outputExcerpt: check.outputExcerpt });
      }
    }
  }
  const verdict = done.length === 0 ? 'inconclusive' : failedChecks.length === 0 ? 'pass' : 'fail';
  return {
    verdict,
    passed: verdict === 'pass',
    totalVerify: verifyReqs.length,
    doneVerify: done.length,
    failedChecks,
    summary:
      done.length === 0
        ? 'Chưa có verify nào done — chưa kết luận được.'
        : verdict === 'pass'
          ? `Verify PASS: ${done.length}/${verifyReqs.length} verify done, mọi check đều pass.`
          : `Verify FAIL: ${failedChecks.length} check fail trong ${done.length} verify done — xem failedChecks.`,
  };
}

// ---------------------------------------------------------------------------
// Tóm tắt sóng cho cha + cost
// ---------------------------------------------------------------------------

export interface SpecializedV20WaveRunSummary {
  runId: string;
  complete: boolean;
  currentWave: number;
  totalWaves: number;
  done: number;
  failed: number;
  blocked: number;
  pending: number;
  running: number;
  invalidOutput: number;
  escalated: string[];
  /** Bản tóm tắt từng con (dùng summarizeChildForParent — cắt 2.000 ký tự/con). */
  childSummaries: string[];
  /** Findings explore đã gộp (top 10 theo confidence). */
  topFindings: (ExploreV20Finding & { supportCount: number })[];
  /** Plan gộp (nếu có plan done). */
  mergedPlan: PlanV20Output | null;
  verifyRollup: ReturnType<typeof rollupVerifyV20Verdicts>;
  /** Token ước lượng cả sóng (từ usage handoff: 4 ký tự ≈ 1 token). */
  estimatedTokens: number;
  summary: string;
}

/**
 * Tóm tắt toàn bộ wave run cho cha — MỘT text duy nhất cha nhận về
 * context của mình (thay vì transcript của từng con). Cần `tree` để
 * lấy node con và tóm tắt bằng `summarizeChildForParent` (luật cắt
 * của nested.ts). Node không còn trong cây (đã dọn) thì bỏ qua, không
 * lỗi — sóng vẫn tóm tắt được từ handoff.
 */
export function summarizeSpecializedV20WaveRun(
  run: SpecializedV20WaveRun,
  tree: SubagentTree,
): SpecializedV20WaveRunSummary {
  const done = run.requests.filter((r) => r.status === 'done');
  const handoffs = done.map((r) => r.handoff).filter((h): h is SubagentV20Handoff => h !== undefined);
  const childSummaries: string[] = [];
  for (const req of run.requests) {
    if (!req.nodeId) continue;
    const node = tree.getNode(req.nodeId);
    if (!node) continue;
    const handoffText = req.handoff ? JSON.stringify(req.handoff.output) : '(chưa có output)';
    childSummaries.push(summarizeChildForParent(node, handoffText));
  }
  const mergedFindings = mergeExploreV20Findings(handoffs);
  const { plan: mergedPlan } = mergePlanV20Outputs(handoffs);
  const verifyRollup = rollupVerifyV20Verdicts(run);
  const estimatedTokens = handoffs.reduce(
    (sum, h) => sum + Math.ceil(h.usage.chars / 4) + Math.ceil(h.usage.droppedMessages * 50),
    0,
  );
  const counts = {
    done: done.length,
    failed: run.requests.filter((r) => r.status === 'failed').length,
    blocked: run.requests.filter((r) => r.status === 'blocked').length,
    pending: run.requests.filter((r) => r.status === 'pending').length,
    running: run.requests.filter((r) => r.status === 'running').length,
    invalidOutput: run.requests.filter((r) => r.status === 'invalid-output').length,
  };
  const hasPlan = mergedPlan.steps.length > 0;
  return {
    runId: run.id,
    complete: isSpecializedV20WaveRunComplete(run),
    currentWave: run.currentWave,
    totalWaves: run.totalWaves,
    ...counts,
    escalated: escalatedSpecializedV20Requests(run).map((r) => r.id),
    childSummaries,
    topFindings: mergedFindings.slice(0, 10),
    mergedPlan: hasPlan ? mergedPlan : null,
    verifyRollup,
    estimatedTokens,
    summary:
      `Sóng subagent v20 ${run.id}: ${counts.done}/${run.requests.length} done` +
      (counts.failed > 0 ? `, ${counts.failed} failed` : '') +
      (counts.blocked > 0 ? `, ${counts.blocked} blocked` : '') +
      (counts.invalidOutput > 0 ? `, ${counts.invalidOutput} output lỗi` : '') +
      (mergedFindings.length > 0 ? `, ${mergedFindings.length} finding explore (gộp)` : '') +
      (hasPlan ? `, plan gộp ${mergedPlan.steps.length} bước` : '') +
      `, verify ${verifyRollup.verdict} — ước lượng ${estimatedTokens} token.`,
  };
}
