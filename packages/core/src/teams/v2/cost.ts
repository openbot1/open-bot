/**
 * Agent Teams v2 — ước tính + cảnh báo chi phí token, kiểm tra cỡ team
 * 3–5 (v1.10, Đội T3).
 *
 * Team ở plan mode tốn ~7x token so với session thường (survey
 * v1.10 §2): mỗi teammate là một session đầy đủ với context riêng,
 * nên chi phí tăng theo số teammate + task + tin nhắn + fork.
 * Module này ước tính token (heuristic minh bạch, không phải đo
 * thật từ provider) để lead/UI cảnh báo TRƯỚC khi team phình:
 *
 *   token ≈ teammates × tokensPerTeammate
 *         + tasks × tokensPerTask
 *         + messages × tokensPerMessage
 *         + forks × tokensPerFork
 *
 * Mức cảnh báo: ok (< ngưỡng), warn (>= ngưỡng warnRatio, mặc
 * định 80% ngân sách), over (> 100% ngân sách). Cảnh báo là
 * WARNING, không chặn việc tạo team — trừ khi vượt cỡ team tối
 * đa mà không có override.
 *
 * Cỡ team: khuyến nghị 3–5 teammate. Team < 3: cảnh báo (chưa
 * đủ người để gọi là team, cân nhắc single-bot). Team > 5: chặn
 * trừ khi config allowOverRecommended (lead phải chủ động mở).
 */

import {
  DEFAULT_TEAM_TOKEN_BUDGET,
  DEFAULT_TOKEN_WARN_RATIO,
  RECOMMENDED_MAX_TEAMMATES,
  RECOMMENDED_MIN_TEAMMATES,
  defaultTeamV2Config,
  type TeamCostEstimate,
  type TeamSizeCheck,
  type TeamV2Config,
} from './types';

/** Đầu vào ước tính chi phí. */
export interface CostInputs {
  teammates: number;
  tasks: number;
  messages: number;
  forks: number;
}

/** Chuẩn hóa đầu vào (số âm → 0, làm tròn xuống). */
export function normalizeCostInputs(input: Partial<CostInputs>): CostInputs {
  const clamp = (v: number | undefined): number => Math.max(0, Math.floor(v ?? 0));
  return {
    teammates: clamp(input.teammates),
    tasks: clamp(input.tasks),
    messages: clamp(input.messages),
    forks: clamp(input.forks),
  };
}

/**
 * Ước tính chi phí token của team từ số lượng teammate/task/tin/fork.
 * Heuristic minh bạch (xem header): số ước tính, không phải số đo thật.
 */
export function estimateTeamTokens(
  input: Partial<CostInputs>,
  config: Partial<TeamV2Config> = {},
): TeamCostEstimate {
  const cfg = { ...defaultTeamV2Config(), ...config };
  const counts = normalizeCostInputs(input);
  const byTeammate = counts.teammates * cfg.tokensPerTeammate;
  const byTask = counts.tasks * cfg.tokensPerTask;
  const byMessage = counts.messages * cfg.tokensPerMessage;
  const byFork = counts.forks * cfg.tokensPerFork;
  const estimatedTokens = byTeammate + byTask + byMessage + byFork;
  const budget = cfg.tokenBudget;
  const usageRatio = budget > 0 ? estimatedTokens / budget : 0;
  const level: TeamCostEstimate['level'] =
    usageRatio > 1 ? 'over' : usageRatio >= cfg.tokenWarnRatio ? 'warn' : 'ok';
  const warnings: string[] = [];
  if (level === 'over') {
    warnings.push(
      `Ước tính ${estimatedTokens.toLocaleString('en-US')} token, VƯỢT ngân sách ${budget.toLocaleString('en-US')} token (${Math.round(usageRatio * 100)}%) — giảm teammate/task/fork hoặc tăng ngân sách.`,
    );
  } else if (level === 'warn') {
    warnings.push(
      `Ước tính ${estimatedTokens.toLocaleString('en-US')} token, đã dùng ${Math.round(usageRatio * 100)}% ngân sách ${budget.toLocaleString('en-US')} token — sắp vượt, cân nhắc giảm quy mô team.`,
    );
  }
  if (counts.teammates > RECOMMENDED_MAX_TEAMMATES) {
    warnings.push(
      `Team có ${counts.teammates} teammate (khuyến nghị tối đa ${RECOMMENDED_MAX_TEAMMATES}) — mỗi teammate thêm tốn ~${cfg.tokensPerTeammate.toLocaleString('en-US')} token/session.`,
    );
  }
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
  };
}

/**
 * Kiểm tra cỡ team khi thêm teammate (tổng số sau khi thêm).
 * - < min khuyến nghị: cảnh báo (không chặn).
 * - > max khuyến nghị: chặn, trừ khi allowOverRecommended (khi đó chỉ cảnh báo).
 */
export function checkTeamSize(
  totalAfterAdd: number,
  config: Partial<TeamV2Config> = {},
): TeamSizeCheck {
  const cfg = { ...defaultTeamV2Config(), ...config };
  const warnings: string[] = [];
  if (totalAfterAdd < cfg.recommendedMinTeammates) {
    warnings.push(
      `Team chỉ có ${totalAfterAdd} thành viên (khuyến nghị tối thiểu ${cfg.recommendedMinTeammates}) — ít người thì single-bot hoặc team nhỏ có thể đủ, đỡ tốn token.`,
    );
  }
  if (totalAfterAdd > cfg.recommendedMaxTeammates) {
    if (!cfg.allowOverRecommended) {
      return {
        allowed: false,
        warnings,
        error:
          `Team đã ${totalAfterAdd} thành viên, vượt khuyến nghị tối đa ${cfg.recommendedMaxTeammates} teammate ` +
          `(chi phí token tăng ~7x ở plan mode) — bật allowOverRecommended trong cấu hình v2 nếu thật sự cần.`,
      };
    }
    warnings.push(
      `Team có ${totalAfterAdd} thành viên, vượt khuyến nghị tối đa ${cfg.recommendedMaxTeammates} — chi phí token tăng mạnh theo từng teammate.`,
    );
  }
  return { allowed: true, warnings };
}

/** Ngân sách token mặc định (để tool/UI hiển thị). */
export function defaultTokenBudget(): number {
  return DEFAULT_TEAM_TOKEN_BUDGET;
}

/** Ngưỡng cảnh báo mặc định (để tool/UI hiển thị). */
export function defaultTokenWarnRatio(): number {
  return DEFAULT_TOKEN_WARN_RATIO;
}
