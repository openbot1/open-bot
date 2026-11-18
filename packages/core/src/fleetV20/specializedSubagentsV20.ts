/**
 * Subagent chuyên biệt v20 — Explore / Plan / Verify (v1.33, Đội T6).
 *
 * Ý tưởng học từ survey v133 (Claude Code: subagent chuyên biệt có sẵn
 * Explore / Plan / Verify + 4 primitive trực giao skill–subagent–plugin–
 * hook; CHỈ HỌC Ý TƯỞNG, không copy code/text/tài sản của bất kỳ repo nào,
 * của xAI/Cursor/Anthropic).
 *
 * Tầng trên của `subagents/roles.ts` (role built-in researcher/coder/
 * reviewer/planner/tester + `SubagentRoleRegistry` với luật giao tool
 * cha ∩ role và fail-closed) và `subagents/nested.ts` (cây spawn, depth/
 * spawn/context budget, chặn task trùng). Roles.ts trả lời "role nào có
 * tool gì"; module này trả lời 3 câu tiếp theo, riêng cho 3 loại subagent
 * chuyên biệt mà sóng v133 cần:
 *
 * - EXPLORE (chỉ đọc, model rẻ): đi tìm hiểu codebase/tài liệu rồi trả
 *   về finding có nguồn + độ tin cậy — không sửa, không chạy shell, không
 *   spawn con. Chạy song song được với nhau vì context cô lập (xem
 *   `subagentContextV20.ts`).
 * - PLAN (chỉ đọc + soạn plan): nghiên cứu rồi ra plan có bước + file +
 *   lệnh kiểm chứng + tiêu chí xong từng bước + câu hỏi mở — không sửa
 *   code, không chạy shell. Plan phải validate được bằng schema
 *   (`validatePlanV20Output`) trước khi giao cho coder.
 * - VERIFY (đọc + chạy test, KHÔNG sửa file): chạy test/lệnh kiểm chứng
 *   rồi đối chiếu diff, kết luận pass/fail CÓ BẰNG CHỨNG (từng check kèm
 *   lệnh + output trích + thời gian). Không bao giờ sửa file để cho pass
 *   — sửa file là việc của coder, verify chỉ báo cáo.
 *
 * Mỗi loại có: role riêng (nối vào `SubagentRoleRegistry` qua
 * `specializedV20Roles()` — KHÔNG viết hệ delegation song song), tool
 * allowlist riêng, model tier riêng (explore = cheap để tiết kiệm token,
 * plan/verify = standard, verify có thể xin strong qua override), giới
 * hạn bước/timeout riêng, và schema output riêng để cha parse/validate
 * thay vì tin mù output model.
 *
 * Module này là tầng pure: không gọi provider, không đọc file, không
 * spawn thật — quyết định "spawn loại nào, với tool gì, theo sóng nào"
 * để `AgentRunner.runSubagent` / coordinator thực thi.
 */

import { READ_ONLY_TOOLS } from '../agent/toolFilter';
import {
  type ResolvedRoleOptions,
  type RoleCallOverrides,
  type SubagentRole,
  SubagentRoleRegistry,
} from '../subagents/roles';

// ---------------------------------------------------------------------------
// Loại subagent chuyên biệt + model tier
// ---------------------------------------------------------------------------

/** Ba loại subagent chuyên biệt v20. */
export type SpecializedV20Kind = 'explore' | 'plan' | 'verify';

export const SPECIALIZED_V20_KINDS: readonly SpecializedV20Kind[] = [
  'explore',
  'plan',
  'verify',
];

/**
 * Tier model của subagent — chính sách chi phí, không phải tên model cụ
 * thể (host tự map tier → model rẻ/mạnh mà nó có; explore chạy model rẻ
 * để tiết kiệm token là cả ý tưởng của loại này).
 */
export type SpecializedV20ModelTier = 'cheap' | 'standard' | 'strong';

export const SPECIALIZED_V20_MODEL_TIERS: readonly SpecializedV20ModelTier[] = [
  'cheap',
  'standard',
  'strong',
];

/** Tier mặc định từng loại (verify có thể xin `strong` qua override). */
export const SPECIALIZED_V20_DEFAULT_TIER: Record<SpecializedV20Kind, SpecializedV20ModelTier> = {
  explore: 'cheap',
  plan: 'standard',
  verify: 'standard',
};

// ---------------------------------------------------------------------------
// Spec từng loại
// ---------------------------------------------------------------------------

/** Spec đầy đủ của một loại subagent chuyên biệt v20. */
export interface SpecializedV20Spec {
  kind: SpecializedV20Kind;
  /** Id role trong registry (dùng để spawn qua hệ role hiện có). */
  roleId: string;
  description: string;
  systemPrompt: string;
  /** Tool allowlist riêng (giao thêm với tool cha khi resolve). */
  tools: string[];
  allowShell: boolean;
  readOnly: boolean;
  maxSteps: number;
  timeoutMs: number;
  modelTier: SpecializedV20ModelTier;
  /** Mô tả output có cấu trúc mà loại này phải trả về. */
  outputSchema: string;
  /** true = con không được spawn subagent con nữa (lá của cây spawn). */
  leafOnly: boolean;
  /** Số con cùng loại tối đa chạy song song trong một sóng (mặc định 4). */
  maxParallel: number;
}

/** Tool đọc file/code — dùng chung cho explore/plan. */
const READ_CODE_TOOLS: string[] = [
  'read_file',
  'list_files',
  'glob_files',
  'grep_search',
  'semantic_search',
  'code_diagnostics',
  'git_status',
  'git_diff',
  'git_blame',
  'memory_recall',
  'search_conversations',
];

/** Tool tra cứu web — chỉ explore cần (plan tập trung vào codebase). */
const WEB_TOOLS: string[] = ['web_search', 'web_fetch', 'http_get', 'x_search'];

/**
 * Spec 3 loại. Explore KHÔNG có web? Có — nghiên cứu cần cả web lẫn
 * code. Plan KHÔNG có web (plan từ codebase/tài liệu nội bộ, tránh plan
 * dựa trên thông tin mạng không kiểm chứng). Verify KHÔNG có web (chỉ
 * tin test chạy local + diff).
 */
export const SPECIALIZED_V20_SPECS: Record<SpecializedV20Kind, SpecializedV20Spec> = {
  explore: {
    kind: 'explore',
    roleId: 'explore',
    description:
      'Khám phá, tìm hiểu: chỉ đọc code/tài liệu/web, chạy model rẻ để tiết kiệm token, không sửa gì, không chạy shell. Trả về finding có nguồn + độ tin cậy.',
    systemPrompt:
      'Bạn là explore — subagent khám phá chuyên biệt. ' +
      'CHỈ ĐỌC: đọc code, tài liệu, tra cứu web. KHÔNG sửa file, KHÔNG chạy shell, KHÔNG spawn subagent con, KHÔNG tạo task/bot mới. ' +
      'Nhiệm vụ của bạn là TÌM HIỂU, không phải làm: thu thập sự thật từ nhiều nguồn, đối chiếu khi nguồn mâu thuẫn, ' +
      'và trả về danh sách finding, mỗi finding ghi rõ: khẳng định gì, nguồn nào (file:dòng hoặc URL), độ tin cậy (high/medium/low). ' +
      'Không tìm thấy thì nói rõ là không tìm thấy, không bịa. Giữ câu trả lời ngắn gọn — cha chỉ cần sự thật có nguồn, không cần diễn giải dài.',
    tools: [...READ_CODE_TOOLS, ...WEB_TOOLS, 'task_list', 'project_list'],
    allowShell: false,
    readOnly: true,
    maxSteps: 12,
    timeoutMs: 120_000,
    modelTier: 'cheap',
    outputSchema:
      'JSON: { "findings": [{ "claim": string, "sources": string[], "confidence": "high"|"medium"|"low" }], ' +
      '"notFound": string[] } — mỗi claim phải có ít nhất 1 source, không có finding nào thì findings = [].',
    leafOnly: true,
    maxParallel: 4,
  },
  plan: {
    kind: 'plan',
    roleId: 'plan',
    description:
      'Lập kế hoạch: nghiên cứu codebase rồi ra plan có bước + file + lệnh kiểm chứng + tiêu chí xong, không sửa code, không chạy shell.',
    systemPrompt:
      'Bạn là plan — subagent lập kế hoạch chuyên biệt. ' +
      'CHỈ ĐỌC codebase/tài liệu và soạn plan: KHÔNG sửa code, KHÔNG chạy shell, KHÔNG spawn subagent con. ' +
      'Plan phải chia thành bước nhỏ, mỗi bước ghi rõ: làm gì, file nào (đường dẫn cụ thể), kiểm chứng bằng lệnh nào ' +
      '(test/typecheck cụ thể), và tiêu chí xong là gì (kết quả nào thì coi là xong bước đó). ' +
      'Liệt kê riêng: câu hỏi cần người quyết (không tự quyết thay), rủi ro đã thấy. ' +
      'Plan phải khả thi với codebase hiện tại — không vẽ thêm tính năng ngoài yêu cầu, không đề xuất tool/file không tồn tại. ' +
      'Trả về plan theo đúng schema JSON đã giao.',
    tools: [...READ_CODE_TOOLS, 'task_list', 'project_list', 'goal_list', 'plan_create', 'plan_update'],
    allowShell: false,
    readOnly: true,
    maxSteps: 15,
    timeoutMs: 180_000,
    modelTier: 'standard',
    outputSchema:
      'JSON: { "goal": string, "steps": [{ "title": string, "files": string[], "verifyCommand": string, ' +
      '"doneCriteria": string }], "openQuestions": string[], "risks": string[] } — mỗi step phải có verifyCommand và doneCriteria không rỗng.',
    leafOnly: true,
    maxParallel: 2,
  },
  verify: {
    kind: 'verify',
    roleId: 'verify',
    description:
      'Kiểm chứng: đọc code + chạy test/lệnh kiểm chứng, đối chiếu diff, kết luận pass/fail có bằng chứng. KHÔNG sửa file.',
    systemPrompt:
      'Bạn là verify — subagent kiểm chứng chuyên biệt. ' +
      'Được đọc code và chạy shell/test để kiểm chứng, nhưng KHÔNG ĐƯỢC SỬA FILE (kể cả sửa test để cho pass — sửa file là việc của coder, bạn chỉ báo cáo). ' +
      'Chạy đúng test/lệnh liên quan tới thay đổi cần kiểm chứng (đọc diff trước để biết thay đổi là gì), ghi lại từng check: lệnh nào, pass hay fail, output trích ngắn, chạy bao lâu. ' +
      'Kết luận cuối cùng rõ ràng: PASS (mọi check đều pass, có bằng chứng) hoặc FAIL (check nào fail + lỗi cụ thể) hoặc INCONCLUSIVE (không chạy được check nào — nêu rõ vì sao). ' +
      'Nếu test fail vì môi trường (thiếu tool, thiếu mạng, hết tài nguyên) thì nói rõ là lỗi môi trường, không đổ cho code. ' +
      'Trả về verdict theo đúng schema JSON đã giao.',
    tools: [
      ...READ_CODE_TOOLS,
      'shell_exec',
      'shell_session_start',
      'shell_session_write',
      'shell_session_read',
      'shell_session_close',
      'exec_task',
      'exec_task_status',
      'ci_investigate',
      'task_list',
    ],
    allowShell: true,
    readOnly: false,
    maxSteps: 20,
    timeoutMs: 240_000,
    modelTier: 'standard',
    outputSchema:
      'JSON: { "verdict": "pass"|"fail"|"inconclusive", "checks": [{ "check": string, "command": string, ' +
      '"passed": boolean, "outputExcerpt": string, "durationMs": number }], "summary": string } — ' +
      'verdict pass chỉ khi có ít nhất 1 check và mọi check đều passed.',
    leafOnly: true,
    maxParallel: 2,
  },
};

/** Lấy spec theo loại; loại không tồn tại → lỗi rõ ràng. */
export function getSpecializedV20Spec(kind: string): SpecializedV20Spec {
  const spec = (SPECIALIZED_V20_SPECS as Record<string, SpecializedV20Spec | undefined>)[kind];
  if (!spec) {
    throw new Error(
      `Loại subagent chuyên biệt v20 "${kind}" không tồn tại. Loại có sẵn: ${SPECIALIZED_V20_KINDS.join(', ')}.`,
    );
  }
  return spec;
}

/** true khi tên tool nằm trong allowlist của loại (trước khi giao với cha). */
export function isSpecializedV20ToolAllowed(kind: SpecializedV20Kind, toolName: string): boolean {
  return getSpecializedV20Spec(kind).tools.includes(toolName);
}

// ---------------------------------------------------------------------------
// Nối vào hệ role hiện có (không viết hệ song song)
// ---------------------------------------------------------------------------

/** Chuyển spec v20 thành SubagentRole để đăng ký vào SubagentRoleRegistry. */
export function specializedV20SpecToRole(spec: SpecializedV20Spec): SubagentRole {
  return {
    id: spec.roleId,
    description: spec.description,
    systemPrompt: spec.systemPrompt,
    tools: [...spec.tools],
    allowShell: spec.allowShell,
    readOnly: spec.readOnly,
    maxSteps: spec.maxSteps,
    timeoutMs: spec.timeoutMs,
    source: 'builtin',
  };
}

/** Cả 3 role chuyên biệt v20 (để host truyền làm customRoles cho registry). */
export function specializedV20Roles(): SubagentRole[] {
  return SPECIALIZED_V20_KINDS.map((kind) =>
    specializedV20SpecToRole(SPECIALIZED_V20_SPECS[kind]),
  );
}

/**
 * Registry đã có sẵn 3 role chuyên biệt v20 (cộng role built-in của
 * roles.ts). Dùng khi host chưa có registry riêng.
 */
export function createSpecializedV20Registry(): SubagentRoleRegistry {
  return new SubagentRoleRegistry(specializedV20Roles());
}

export interface SpecializedV20SpawnOptions extends RoleCallOverrides {
  /** Tier model muốn dùng (mặc định = tier mặc định của loại). */
  modelTier?: SpecializedV20ModelTier;
}

export interface ResolvedSpecializedV20Spawn extends ResolvedRoleOptions {
  kind: SpecializedV20Kind;
  modelTier: SpecializedV20ModelTier;
  /** Schema output mà con phải trả về (cha dùng để validate). */
  outputSchema: string;
  leafOnly: boolean;
}

/**
 * Resolve một lần spawn subagent chuyên biệt: giao tool với tool cha
 * (luật của roles.ts — role chỉ thu hẹp, không mở rộng), cộng tier model
 * và output schema. Ném lỗi rõ khi role/tool không resolve được (kế thừa
 * UnknownSubagentRoleError / EmptyRoleToolsError của roles.ts).
 */
export function resolveSpecializedV20Spawn(
  kind: SpecializedV20Kind,
  parentToolNames: readonly string[],
  overrides: SpecializedV20SpawnOptions = {},
  registry: SubagentRoleRegistry = createSpecializedV20Registry(),
): ResolvedSpecializedV20Spawn {
  const spec = getSpecializedV20Spec(kind);
  const resolved = registry.resolveRoleOptions(spec.roleId, parentToolNames, overrides);
  // Defence-in-depth: explore/plan là read-only — tool con cuối cùng
  // không được chứa tool ngoài READ_ONLY_TOOLS dù registry có lọt.
  if (spec.readOnly && resolved.tools !== undefined) {
    const leaked = resolved.tools.filter((t) => !READ_ONLY_TOOLS.has(t));
    if (leaked.length > 0) {
      throw new Error(
        `Subagent ${kind} là read-only nhưng tool resolve còn chứa tool ghi: ${leaked.join(', ')} — lỗi nội bộ, không spawn.`,
      );
    }
  }
  return {
    ...resolved,
    kind,
    modelTier: overrides.modelTier ?? spec.modelTier,
    outputSchema: spec.outputSchema,
    leafOnly: spec.leafOnly,
  };
}

// ---------------------------------------------------------------------------
// Kế hoạch spawn song song (sóng)
// ---------------------------------------------------------------------------

/** Một yêu cầu spawn trong kế hoạch song song. */
export interface SpecializedV20SpawnRequest {
  /** Id ổn định của yêu cầu (duy nhất trong kế hoạch). */
  id: string;
  kind: SpecializedV20Kind;
  /** Mô tả task giao cho con (đã rõ ràng, độc lập). */
  task: string;
  /** Id các yêu cầu phải xong trước (sóng sau) — rỗng = chạy ngay sóng 1. */
  dependsOn?: string[];
}

/** Một sóng spawn: các yêu cầu chạy song song trong sóng đó. */
export interface SpecializedV20SpawnWave {
  wave: number;
  requestIds: string[];
  /** Số con chạy song song trong sóng (<= maxParallel của từng loại). */
  parallelCount: number;
}

/** Kế hoạch spawn song song đã xếp sóng (topological levels). */
export interface SpecializedV20SpawnPlan {
  waves: SpecializedV20SpawnWave[];
  totalRequests: number;
  /** Số con chạy song song tối đa trong cả kế hoạch. */
  maxParallel: number;
}

export const SPECIALIZED_V20_MAX_SPAWNS_PER_PLAN = 12;
export const SPECIALIZED_V20_MAX_PARALLEL_DEFAULT = 4;

const SPAWN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Validate kế hoạch spawn: trả về danh sách lỗi (rỗng = hợp lệ).
 * Kiểm tra: id hợp lệ/duy nhất, kind tồn tại, task không rỗng, dep tồn
 * tại, không có chu trình, tổng số <= 12, mỗi sóng <= maxParallel.
 * Không throw — để UI hiện lỗi trước khi spawn.
 */
export function validateSpecializedV20SpawnPlan(
  requests: readonly SpecializedV20SpawnRequest[],
  maxParallel: number = SPECIALIZED_V20_MAX_PARALLEL_DEFAULT,
): string[] {
  const errors: string[] = [];
  if (requests.length === 0) errors.push('Kế hoạch spawn trống — cần ít nhất 1 yêu cầu.');
  if (requests.length > SPECIALIZED_V20_MAX_SPAWNS_PER_PLAN) {
    errors.push(
      `Kế hoạch có ${requests.length} yêu cầu, vượt tối đa ${SPECIALIZED_V20_MAX_SPAWNS_PER_PLAN} — chia nhỏ kế hoạch.`,
    );
  }
  if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
    errors.push(`maxParallel phải là số nguyên > 0 (nhận ${String(maxParallel)}).`);
  }
  const seen = new Set<string>();
  for (const req of requests) {
    if (!SPAWN_ID_RE.test(req.id)) {
      errors.push(`Id yêu cầu không hợp lệ: ${JSON.stringify(req.id)} — dùng chữ thường, số, gạch ngang, bắt đầu bằng chữ cái.`);
    } else if (seen.has(req.id)) {
      errors.push(`Id yêu cầu trùng: "${req.id}" — mỗi yêu cầu cần id duy nhất.`);
    } else {
      seen.add(req.id);
    }
    if (!SPECIALIZED_V20_KINDS.includes(req.kind)) {
      errors.push(`Yêu cầu "${req.id}": loại "${String(req.kind)}" không tồn tại (${SPECIALIZED_V20_KINDS.join(', ')}).`);
    }
    if (typeof req.task !== 'string' || req.task.trim().length === 0) {
      errors.push(`Yêu cầu "${req.id}": task không được rỗng.`);
    }
    const deps = req.dependsOn ?? [];
    if (new Set(deps).size !== deps.length) {
      errors.push(`Yêu cầu "${req.id}": dependsOn có id trùng nhau.`);
    }
    for (const dep of deps) {
      if (dep === req.id) errors.push(`Yêu cầu "${req.id}": tự phụ thuộc vào chính nó.`);
      else if (!requests.some((r) => r.id === dep)) {
        errors.push(`Yêu cầu "${req.id}": phụ thuộc vào "${dep}" không có trong kế hoạch.`);
      }
    }
  }
  // Chu trình: Kahn — còn node chưa xếp được mà không còn node hết dep thì có chu trình.
  if (errors.length === 0) {
    const remaining = new Map(requests.map((r) => [r.id, new Set(r.dependsOn ?? [])]));
    let progress = true;
    while (remaining.size > 0 && progress) {
      progress = false;
      for (const [id, deps] of [...remaining.entries()]) {
        if ([...deps].every((d) => !remaining.has(d))) {
          remaining.delete(id);
          progress = true;
        }
      }
    }
    if (remaining.size > 0) {
      errors.push(`Kế hoạch có chu trình phụ thuộc giữa: ${[...remaining.keys()].join(', ')} — gỡ chu trình trước khi spawn.`);
    }
  }
  return errors;
}

/**
 * Xếp kế hoạch spawn thành các sóng (topological levels): sóng 1 = các
 * yêu cầu không phụ thuộc ai; sóng sau = yêu cầu mà mọi dep đã ở sóng
 * trước. Mỗi sóng bị cắt nhỏ nếu vượt maxParallel (giữ nguyên thứ tự
 * khai báo). Kế hoạch không hợp lệ → throw với lỗi của validate.
 */
export function planSpecializedV20Spawns(
  requests: readonly SpecializedV20SpawnRequest[],
  maxParallel: number = SPECIALIZED_V20_MAX_PARALLEL_DEFAULT,
): SpecializedV20SpawnPlan {
  const errors = validateSpecializedV20SpawnPlan(requests, maxParallel);
  if (errors.length > 0) {
    throw new Error(`Kế hoạch spawn subagent v20 không hợp lệ:\n- ${errors.join('\n- ')}`);
  }
  // Xếp sóng bằng Kahn theo level: level của node = 1 + max level của dep.
  const levelOf = new Map<string, number>();
  const byId = new Map(requests.map((r) => [r.id, r]));
  const computeLevel = (id: string, visiting: Set<string>): number => {
    const cached = levelOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`Chu trình phụ thuộc tại "${id}".`);
    visiting.add(id);
    const req = byId.get(id);
    const deps = req?.dependsOn ?? [];
    const level = deps.length === 0 ? 1 : 1 + Math.max(...deps.map((d) => computeLevel(d, visiting)));
    visiting.delete(id);
    levelOf.set(id, level);
    return level;
  };
  for (const req of requests) computeLevel(req.id, new Set());
  const maxLevel = Math.max(...[...levelOf.values()]);
  const waves: SpecializedV20SpawnWave[] = [];
  for (let level = 1; level <= maxLevel; level++) {
    const ids = requests.filter((r) => levelOf.get(r.id) === level).map((r) => r.id);
    for (let i = 0; i < ids.length; i += maxParallel) {
      const chunk = ids.slice(i, i + maxParallel);
      waves.push({ wave: waves.length + 1, requestIds: chunk, parallelCount: chunk.length });
    }
  }
  return {
    waves,
    totalRequests: requests.length,
    maxParallel: Math.max(0, ...waves.map((w) => w.parallelCount)),
  };
}

// ---------------------------------------------------------------------------
// Output có cấu trúc: Explore findings
// ---------------------------------------------------------------------------

export type ExploreV20Confidence = 'high' | 'medium' | 'low';

export interface ExploreV20Finding {
  claim: string;
  sources: string[];
  confidence: ExploreV20Confidence;
}

export interface ExploreV20Output {
  findings: ExploreV20Finding[];
  notFound: string[];
}

/** Validate output explore (parse từ JSON model trả về): trả lỗi, rỗng = hợp lệ. */
export function validateExploreV20Output(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Output explore phải là một object JSON { findings, notFound }.'];
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['findings'])) {
    errors.push('Output explore cần "findings" là mảng (có thể rỗng).');
  } else {
    obj['findings'].forEach((f, i) => {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        errors.push(`Finding #${i + 1} phải là object { claim, sources, confidence }.`);
        return;
      }
      const finding = f as Record<string, unknown>;
      if (typeof finding['claim'] !== 'string' || finding['claim'].trim().length === 0) {
        errors.push(`Finding #${i + 1}: "claim" không được rỗng.`);
      }
      if (!Array.isArray(finding['sources']) || finding['sources'].length === 0) {
        errors.push(`Finding #${i + 1}: cần ít nhất 1 source (file:dòng hoặc URL) — finding không nguồn thì không tin được.`);
      } else if (finding['sources'].some((s) => typeof s !== 'string' || s.trim().length === 0)) {
        errors.push(`Finding #${i + 1}: "sources" phải là mảng string không rỗng.`);
      }
      if (!['high', 'medium', 'low'].includes(String(finding['confidence']))) {
        errors.push(`Finding #${i + 1}: "confidence" phải là high/medium/low.`);
      }
    });
  }
  if (obj['notFound'] !== undefined && !Array.isArray(obj['notFound'])) {
    errors.push('Output explore: "notFound" phải là mảng string (nếu có).');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Output có cấu trúc: Plan
// ---------------------------------------------------------------------------

export interface PlanV20Step {
  title: string;
  files: string[];
  verifyCommand: string;
  doneCriteria: string;
}

export interface PlanV20Output {
  goal: string;
  steps: PlanV20Step[];
  openQuestions: string[];
  risks: string[];
}

/** Validate output plan: trả lỗi, rỗng = hợp lệ (plan đủ dùng để giao coder). */
export function validatePlanV20Output(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Output plan phải là một object JSON { goal, steps, openQuestions, risks }.'];
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj['goal'] !== 'string' || obj['goal'].trim().length === 0) {
    errors.push('Output plan cần "goal" không rỗng.');
  }
  if (!Array.isArray(obj['steps']) || obj['steps'].length === 0) {
    errors.push('Output plan cần ít nhất 1 step — plan không có bước thì không thực thi được.');
  } else {
    obj['steps'].forEach((s, i) => {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        errors.push(`Step #${i + 1} phải là object { title, files, verifyCommand, doneCriteria }.`);
        return;
      }
      const step = s as Record<string, unknown>;
      if (typeof step['title'] !== 'string' || step['title'].trim().length === 0) {
        errors.push(`Step #${i + 1}: "title" không được rỗng.`);
      }
      if (!Array.isArray(step['files']) || step['files'].length === 0) {
        errors.push(`Step #${i + 1}: cần ít nhất 1 file — bước không gắn file thì coder không biết sửa đâu.`);
      }
      if (typeof step['verifyCommand'] !== 'string' || step['verifyCommand'].trim().length === 0) {
        errors.push(`Step #${i + 1}: cần "verifyCommand" — bước không có lệnh kiểm chứng thì không biết khi nào xong.`);
      }
      if (typeof step['doneCriteria'] !== 'string' || step['doneCriteria'].trim().length === 0) {
        errors.push(`Step #${i + 1}: cần "doneCriteria" — tiêu chí xong không được rỗng.`);
      }
    });
  }
  for (const field of ['openQuestions', 'risks'] as const) {
    if (obj[field] !== undefined && !Array.isArray(obj[field])) {
      errors.push(`Output plan: "${field}" phải là mảng string (nếu có).`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Output có cấu trúc: Verify verdict (pass/fail có bằng chứng)
// ---------------------------------------------------------------------------

export interface VerifyV20Check {
  /** Tên check, vd `unit tests: fleetV20`. */
  check: string;
  /** Lệnh đã chạy, vd `node --test tests/fleet-v133-t6-panels.test.mjs`. */
  command: string;
  passed: boolean;
  /** Trích output (đã cắt ngắn) — bằng chứng, không phải lời khẳng định. */
  outputExcerpt: string;
  durationMs: number;
}

export type VerifyV20VerdictKind = 'pass' | 'fail' | 'inconclusive';

export interface VerifyV20Verdict {
  verdict: VerifyV20VerdictKind;
  checks: VerifyV20Check[];
  failedChecks: string[];
  /** pass khi và chỉ khi: có >= 1 check và mọi check đều passed. */
  passed: boolean;
  summary: string;
}

/**
 * Build verdict từ các check đã chạy: KHÔNG tin lời model nói pass —
 * verdict được TÍNH từ check (pass iff mọi check passed và có ít nhất 1
 * check; 0 check = inconclusive, không phải pass).
 */
export function buildVerifyV20Verdict(checks: readonly VerifyV20Check[], summary: string): VerifyV20Verdict {
  const failedChecks = checks.filter((c) => !c.passed).map((c) => c.check);
  const passed = checks.length > 0 && failedChecks.length === 0;
  const verdict: VerifyV20VerdictKind =
    checks.length === 0 ? 'inconclusive' : passed ? 'pass' : 'fail';
  return { verdict, checks: [...checks], failedChecks, passed, summary };
}

/** Validate verdict thô (parse từ JSON model trả về): trả lỗi, rỗng = hợp lệ. */
export function validateVerifyV20Verdict(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Output verify phải là một object JSON { verdict, checks, summary }.'];
  }
  const obj = raw as Record<string, unknown>;
  if (!['pass', 'fail', 'inconclusive'].includes(String(obj['verdict']))) {
    errors.push('Output verify: "verdict" phải là pass/fail/inconclusive.');
  }
  if (!Array.isArray(obj['checks'])) {
    errors.push('Output verify cần "checks" là mảng (mỗi check kèm lệnh + bằng chứng).');
  } else {
    obj['checks'].forEach((c, i) => {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) {
        errors.push(`Check #${i + 1} phải là object { check, command, passed, outputExcerpt, durationMs }.`);
        return;
      }
      const check = c as Record<string, unknown>;
      if (typeof check['check'] !== 'string' || check['check'].trim().length === 0) {
        errors.push(`Check #${i + 1}: "check" không được rỗng.`);
      }
      if (typeof check['command'] !== 'string' || check['command'].trim().length === 0) {
        errors.push(`Check #${i + 1}: cần "command" — check không ghi lệnh đã chạy thì không có bằng chứng.`);
      }
      if (typeof check['passed'] !== 'boolean') {
        errors.push(`Check #${i + 1}: "passed" phải là boolean.`);
      }
      if (typeof check['outputExcerpt'] !== 'string' || check['outputExcerpt'].trim().length === 0) {
        errors.push(`Check #${i + 1}: cần "outputExcerpt" — verdict không có trích output thì không kiểm chứng lại được.`);
      }
      if (typeof check['durationMs'] !== 'number' || check['durationMs'] < 0) {
        errors.push(`Check #${i + 1}: "durationMs" phải là số >= 0.`);
      }
    });
    // Nhất quán verdict ↔ checks: model nói pass nhưng có check fail là mâu thuẫn.
    const checks = obj['checks'] as Record<string, unknown>[];
    const anyFailed = checks.some((c) => c !== null && typeof c === 'object' && c['passed'] === false);
    if (obj['verdict'] === 'pass' && (checks.length === 0 || anyFailed)) {
      errors.push('Output verify mâu thuẫn: verdict "pass" nhưng không có check nào pass hết (0 check hoặc có check failed).');
    }
    if (obj['verdict'] === 'fail' && checks.length > 0 && !anyFailed) {
      errors.push('Output verify mâu thuẫn: verdict "fail" nhưng mọi check đều passed — ghi rõ check nào fail.');
    }
  }
  if (typeof obj['summary'] !== 'string' || obj['summary'].trim().length === 0) {
    errors.push('Output verify cần "summary" không rỗng.');
  }
  return errors;
}
