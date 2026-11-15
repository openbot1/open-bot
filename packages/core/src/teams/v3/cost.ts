/**
 * Agent Teams v3 — chi phí token tuyến tính (v1.11, Đội T3).
 *
 * Token cost tăng tuyến tính theo số teammate: mỗi teammate là một
 * session đầy đủ với context riêng (survey v1.11 §3 — team lớn tốn
 * ~7x session thường). Công thức minh bạch, ước tính TRƯỚC khi tạo
 * team để UI cảnh báo:
 *
 *   token ≈ baseSessionTokens
 *         + teammates × tokensPerTeammate
 *         + tasks × tokensPerTask
 *         + messages × tokensPerMessage
 *   multiplier = 1 + teammates (so với 1 session đơn)
 *
 * Kế thừa v2: `estimateTeamTokens`/`TeamCostEstimate` trong
 * packages/core/src/teams/v2/cost.ts; v3 thêm base session token,
 * hệ số nhân tuyến tính và bảng chi phí từng teammate (để UI vẽ
 * cảnh báo trước khi tạo team).
 */

import {
  V3_BASE_SESSION_TOKENS,
  V3_TOKENS_PER_MESSAGE,
  V3_TOKENS_PER_TASK,
  V3_TOKENS_PER_TEAMMATE,
  type TeamV3CostEstimate,
} from './types';
import { normalizeCostInputs, type CostInputs } from '../v2/cost';
import { defaultTeamV2Config } from '../v2/types';

/** Đầu vào ước tính chi phí v3 (mở rộng CostInputs v2 bằng base token). */
export interface TeamV3CostInputs extends CostInputs {
  /** Token cơ sở của session team (mặc định 4000). */
  baseTokens?: number;
}

/** Đầu vào v3 đã chuẩn hóa (baseTokens luôn có số). */
export interface NormalizedV3CostInputs extends CostInputs {
  baseTokens: number;
}

/** Chuẩn hóa đầu vào v3 (số âm → 0, làm tròn xuống). */
export function normalizeV3CostInputs(input: Partial<TeamV3CostInputs>): NormalizedV3CostInputs {
  const base = normalizeCostInputs(input);
  return {
    ...base,
    baseTokens: Math.max(0, Math.floor(input.baseTokens ?? V3_BASE_SESSION_TOKENS)),
  };
}

/**
 * Ước tính chi phí token tuyến tính của team v3.
 * Trả về tổng token + hệ số nhân + bảng chi phí từng teammate +
 * mức cảnh báo (ok/warn/over theo ngân sách v2).
 */
export function estimateTeamV3Cost(
  input: Partial<TeamV3CostInputs>,
  config: { tokenBudget?: number; tokenWarnRatio?: number; tokensPerTeammate?: number; tokensPerTask?: number; tokensPerMessage?: number } = {},
): TeamV3CostEstimate {
  const counts = normalizeV3CostInputs(input);
  const cfg = {
    ...defaultTeamV2Config(),
    tokensPerTeammate: config.tokensPerTeammate ?? V3_TOKENS_PER_TEAMMATE,
    tokensPerTask: config.tokensPerTask ?? V3_TOKENS_PER_TASK,
    tokensPerMessage: config.tokensPerMessage ?? V3_TOKENS_PER_MESSAGE,
    tokenBudget: config.tokenBudget ?? defaultTeamV2Config().tokenBudget,
    tokenWarnRatio: config.tokenWarnRatio ?? defaultTeamV2Config().tokenWarnRatio,
  };
  const baseTokens = counts.baseTokens;
  const byTeammate = counts.teammates * cfg.tokensPerTeammate;
  const byTask = counts.tasks * cfg.tokensPerTask;
  const byMessage = counts.messages * cfg.tokensPerMessage;
  const byFork = counts.forks * cfg.tokensPerFork;
  const estimatedTokens = baseTokens + byTeammate + byTask + byMessage + byFork;
  const budget = cfg.tokenBudget;
  const usageRatio = budget > 0 ? estimatedTokens / budget : 0;
  const level: TeamV3CostEstimate['level'] =
    usageRatio > 1 ? 'over' : usageRatio >= cfg.tokenWarnRatio ? 'warn' : 'ok';
  const warnings: string[] = [];
  // Cảnh báo tuyến tính: nêu rõ mỗi teammate thêm tốn bao nhiêu.
  if (counts.teammates > 0) {
    warnings.push(
      `Chi phí tăng tuyến tính theo số teammate: mỗi teammate thêm ≈ ${cfg.tokensPerTeammate.toLocaleString('en-US')} token ` +
        `(hệ số x${1 + counts.teammates} so với 1 session đơn).`,
    );
  }
  if (counts.teammates > 5) {
    warnings.push(
      `Team ${counts.teammates} teammate vượt khuyến nghị 3–5 — chi phí tuyến tính tiếp tục tăng, cân nhắc tách team.`,
    );
  }
  if (level === 'over') {
    warnings.push(
      `Ước tính ${estimatedTokens.toLocaleString('en-US')} token, VƯỢT ngân sách ${budget.toLocaleString('en-US')} token (${Math.round(usageRatio * 100)}%) — giảm teammate/task hoặc tăng ngân sách.`,
    );
  } else if (level === 'warn') {
    warnings.push(
      `Ước tính ${estimatedTokens.toLocaleString('en-US')} token, đạt ${Math.round(usageRatio * 100)}% ngân sách ${budget.toLocaleString('en-US')} token — gần vượt ngân sách.`,
    );
  }
  const perTeammateBreakdown = Array.from({ length: counts.teammates }, (_, i) => ({
    teammates: i + 1,
    estimatedTokens: baseTokens + (i + 1) * cfg.tokensPerTeammate + byTask + byMessage + byFork,
  }));
  return {
    teammates: counts.teammates,
    tasks: counts.tasks,
    messages: counts.messages,
    forks: counts.forks,
    byTeammate,
    byTask,
    byMessage,
    byFork,
    estimatedTokens,
    budget,
    usageRatio,
    level,
    warnings,
    baseTokens,
    multiplier: 1 + counts.teammates,
    perTeammateBreakdown,
  };
}

/** Ước tính nhanh trước khi tạo team (chỉ cần số teammate + task dự kiến). */
export function estimateCostBeforeCreate(
  teammateCount: number,
  taskCount: number,
  tokenBudget?: number,
): TeamV3CostEstimate {
  return estimateTeamV3Cost(
    { teammates: teammateCount, tasks: taskCount, messages: 0, forks: 0 },
    tokenBudget !== undefined ? { tokenBudget } : {},
  );
}

/** Câu cảnh báo một dòng để UI hiển thị trước nút tạo team. */
export function linearCostWarning(teammateCount: number, tokensPerTeammate = V3_TOKENS_PER_TEAMMATE): string {
  if (teammateCount <= 0) return 'Chưa chọn teammate — chi phí ≈ token của 1 session đơn.';
  return (
    `Team ${teammateCount} teammate tốn ≈ x${1 + teammateCount} token so với 1 session đơn ` +
    `(mỗi teammate thêm ≈ ${tokensPerTeammate.toLocaleString('en-US')} token — chi phí tăng tuyến tính).`
  );
}
