/**
 * Coding agent v18 — critic chấm trajectory/patch trước khi push
 * (v1.40, Đội T4).
 *
 * Ý tưởng học từ survey v140 §6 (verification stack 2026): critic
 * model chấm trajectory, điểm + chặn khi thấp. Code của open-bot:
 * scorer xác định 5 trục (completeness / efficiency / errorRecovery /
 * safety / testCoverage), ngưỡng approve/block cấu hình được, verdict
 * history lưu append-only để theo dõi chất lượng theo thời gian.
 * Nối v17 (không viết lại): v17ScoreTrajectory/v17ScorePatch vẫn là
 * critic v17; critic v18 thêm trục testCoverage, ngưỡng cấu hình
 * được, chặn push tường minh và lịch sử chấm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV18Error, V18_CRITIC_DEFAULT_WEIGHTS, V18_DEFAULT_CRITIC_CONFIG } from './types';
import type {
  V18CriticConfig,
  V18CriticDimension,
  V18CriticHistoryEntry,
  V18CriticHistoryStats,
  V18CriticPresetName,
  V18CriticTrend,
  V18CriticVerdict,
  V18CriticVerdictKind,
  V18TrajectoryStep,
} from './types';

export const V18_CRITIC_DEFAULT_APPROVE_SCORE = 70;
export const V18_CRITIC_DEFAULT_BLOCK_SCORE = 40;
/** Lịch sử chấm giữ tối đa bao nhiêu entry. */
export const V18_CRITIC_HISTORY_MAX_ENTRIES = 200;

/** Preset cấu hình critic: strict (90/60), balanced (70/40), lenient (50/20). */
export const V18_CRITIC_PRESETS: Record<V18CriticPresetName, V18CriticConfig> = {
  strict: { approveScore: 90, blockScore: 60 },
  balanced: { approveScore: 70, blockScore: 40 },
  lenient: { approveScore: 50, blockScore: 20 },
};

/** Lấy preset cấu hình critic theo tên (lỗi khi tên không có). */
export function v18CriticPreset(name: V18CriticPresetName): V18CriticConfig {
  const preset = V18_CRITIC_PRESETS[name];
  if (!preset) throw new CodingV18Error(`Không có critic preset "${name}" (strict | balanced | lenient).`);
  return v18ValidateCriticConfig(preset);
}

/** Validate + chuẩn hoá cấu hình critic (ngưỡng phải hợp lệ). */
export function v18ValidateCriticConfig(config: V18CriticConfig): V18CriticConfig {
  if (!config || typeof config !== 'object') {
    throw new CodingV18Error('Critic config phải là object.');
  }
  const approveScore = config.approveScore;
  const blockScore = config.blockScore;
  if (typeof approveScore !== 'number' || !Number.isFinite(approveScore) || approveScore < 0 || approveScore > 100) {
    throw new CodingV18Error('approveScore phải là số 0..100.');
  }
  if (typeof blockScore !== 'number' || !Number.isFinite(blockScore) || blockScore < 0 || blockScore > 100) {
    throw new CodingV18Error('blockScore phải là số 0..100.');
  }
  if (blockScore >= approveScore) {
    throw new CodingV18Error(`blockScore (${blockScore}) phải nhỏ hơn approveScore (${approveScore}).`);
  }
  const weights = { ...config.weights };
  for (const [name, weight] of Object.entries(weights)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new CodingV18Error(`Trọng số trục "${name}" phải là số >= 0.`);
    }
  }
  const disabledDimensions = [...(config.disabledDimensions ?? [])];
  return { approveScore, blockScore, weights, disabledDimensions };
}

/** Verdict từ điểm tổng theo ngưỡng cấu hình được. */
export function v18CriticVerdictFor(score: number, config: V18CriticConfig): V18CriticVerdictKind {
  const valid = v18ValidateCriticConfig(config);
  if (score >= valid.approveScore) return 'approve';
  if (score >= valid.blockScore) return 'request-changes';
  return 'block';
}

/** Đếm bash command lặp lại (cùng command chạy >= 2 lần). */
export function v18CountRepeatedBash(commands: readonly string[]): number {
  const seen = new Map<string, number>();
  let repeated = 0;
  for (const command of commands) {
    const count = (seen.get(command) ?? 0) + 1;
    seen.set(command, count);
    if (count === 2) repeated += 1;
  }
  return repeated;
}

/** Đếm file ghi đè bằng đúng nội dung cũ (ghi thừa). */
export function v18CountRedundantWrites(steps: readonly V18TrajectoryStep[]): number {
  const lastContent = new Map<string, string>();
  let redundant = 0;
  for (const step of steps) {
    if (step.kind !== 'file_write' && step.kind !== 'file_edit') continue;
    const filePath = step.files?.[0];
    const content = step.text ?? '';
    if (!filePath) continue;
    if (lastContent.get(filePath) === content) redundant += 1;
    lastContent.set(filePath, content);
  }
  return redundant;
}

/** Lỗi nào chưa được xử lý: error/compiler_error mà sau đó không có bash/test thành công. */
export function v18CountUnresolvedErrors(steps: readonly V18TrajectoryStep[]): number {
  let unresolved = 0;
  let openError = false;
  for (const step of steps) {
    if (step.kind === 'compiler_error' || step.kind === 'error') {
      if (openError) unresolved += 1;
      openError = true;
    } else if (step.kind === 'test_result') {
      if (step.passed === true) openError = false;
    } else if (step.kind === 'bash') {
      if (step.exitCode === 0) openError = false;
    }
  }
  if (openError) unresolved += 1;
  return unresolved;
}

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/i,
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\s)rm\s+.*-rf?\s+(\/|\~|\$HOME)(\s|$)/i, reason: 'rm -rf thư mục gốc/home' },
  { pattern: /(^|;|\s)mkfs(\s|\.)/i, reason: 'mkfs (format ổ đĩa)' },
  { pattern: /(^|;|\s)dd\s+.*of=\/dev\//i, reason: 'dd ghi trực tiếp device' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
  { pattern: /(^|;|\s)(shutdown|reboot|poweroff|halt)(\s|;|$)/i, reason: 'shutdown/reboot/poweroff' },
  { pattern: /(^|;|\s)chmod\s+(-R\s+)?777\s+\//i, reason: 'chmod 777 thư mục gốc' },
];

/** Text có lộ secret không. */
export function v18ContainsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

/** Text có lệnh phá hoại không (trả lý do khi có). */
export function v18ContainsDestructiveCommand(text: string): string | undefined {
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}

/** Chuẩn hoá điểm về 0..100, làm tròn số nguyên. */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

interface V18DimensionInput {
  steps: readonly V18TrajectoryStep[];
  plannedFiles?: readonly string[];
}

/** Chấm 5 trục cho một trajectory. */
export function v18ScoreTrajectoryDimensions(
  input: V18DimensionInput,
): V18CriticDimension[] {
  const { steps, plannedFiles } = input;
  const dimensions: V18CriticDimension[] = [];
  const reasons: Record<V18CriticDimension['name'], string[]> = {
    completeness: [],
    efficiency: [],
    errorRecovery: [],
    safety: [],
    testCoverage: [],
  };

  // --- completeness: file trong plan đã chạm đủ chưa + có kết quả test cuối không.
  const touched = new Set<string>();
  for (const step of steps) {
    for (const file of step.files ?? []) touched.add(file);
  }
  let completeness = 100;
  if (plannedFiles && plannedFiles.length > 0) {
    const missing = plannedFiles.filter((f) => !touched.has(f));
    if (missing.length > 0) {
      completeness -= Math.round((missing.length / plannedFiles.length) * 70);
      reasons.completeness.push(`Chưa chạm ${missing.length}/${plannedFiles.length} file trong plan: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}.`);
    }
    const extra = [...touched].filter((f) => !plannedFiles.includes(f));
    if (extra.length > 0) {
      completeness -= Math.min(15, extra.length * 5);
      reasons.completeness.push(`Chạm ${extra.length} file ngoài plan.`);
    }
  }
  if (steps.length === 0) {
    completeness = 0;
    reasons.completeness.push('Trajectory rỗng — chưa làm gì.');
  }
  const hasTestResult = steps.some((s) => s.kind === 'test_result');
  if (!hasTestResult && steps.length > 0) {
    completeness -= 20;
    reasons.completeness.push('Không có kết quả test cuối phiên.');
  }
  if (reasons.completeness.length === 0) reasons.completeness.push('Đủ file trong plan, có kết quả test.');
  dimensions.push({ name: 'completeness', score: clampScore(completeness), weight: 0.3, reasons: reasons.completeness });

  // --- efficiency: bash lặp, ghi thừa, số bước / số file.
  let efficiency = 100;
  const bashCommands = steps.filter((s) => s.kind === 'bash').map((s) => s.text ?? '');
  const repeated = v18CountRepeatedBash(bashCommands);
  if (repeated > 0) {
    efficiency -= Math.min(40, repeated * 15);
    reasons.efficiency.push(`Lặp lại ${repeated} lệnh bash.`);
  }
  const redundant = v18CountRedundantWrites(steps);
  if (redundant > 0) {
    efficiency -= Math.min(30, redundant * 15);
    reasons.efficiency.push(`Ghi thừa ${redundant} lần (cùng nội dung cũ).`);
  }
  const fileWrites = steps.filter((s) => s.kind === 'file_write' || s.kind === 'file_edit').length;
  if (steps.length > 0 && fileWrites > 0 && steps.length / fileWrites > 12) {
    efficiency -= 15;
    reasons.efficiency.push(`Quá nhiều bước (${steps.length}) so với số lần ghi file (${fileWrites}).`);
  }
  if (reasons.efficiency.length === 0) reasons.efficiency.push('Không lặp lệnh, không ghi thừa.');
  dimensions.push({ name: 'efficiency', score: clampScore(efficiency), weight: 0.2, reasons: reasons.efficiency });

  // --- errorRecovery: lỗi chưa xử lý.
  let errorRecovery = 100;
  const unresolved = v18CountUnresolvedErrors(steps);
  const totalErrors = steps.filter((s) => s.kind === 'compiler_error' || s.kind === 'error').length;
  if (unresolved > 0) {
    errorRecovery -= Math.min(80, unresolved * 40);
    reasons.errorRecovery.push(`${unresolved} lỗi chưa được xử lý cuối phiên.`);
  } else if (totalErrors > 0) {
    reasons.errorRecovery.push(`Có ${totalErrors} lỗi nhưng đều đã xử lý.`);
  } else {
    reasons.errorRecovery.push('Không gặp lỗi.');
  }
  dimensions.push({ name: 'errorRecovery', score: clampScore(errorRecovery), weight: 0.2, reasons: reasons.errorRecovery });

  // --- safety: secret lộ / lệnh phá hoại trong bất kỳ bước nào.
  let safety = 100;
  let safetyHits = 0;
  for (const step of steps) {
    const text = step.text ?? '';
    if (text === '') continue;
    if (v18ContainsSecret(text)) {
      safety = 0;
      safetyHits += 1;
      reasons.safety.push(`Lộ secret trong bước ${step.kind}.`);
      break;
    }
    const destructive = v18ContainsDestructiveCommand(text);
    if (destructive) {
      safety = Math.min(safety, 10);
      safetyHits += 1;
      reasons.safety.push(`Lệnh phá hoại: ${destructive}.`);
    }
  }
  if (safetyHits === 0) reasons.safety.push('Không có secret lộ hay lệnh phá hoại.');
  dimensions.push({ name: 'safety', score: clampScore(safety), weight: 0.2, reasons: reasons.safety });

  // --- testCoverage: có bước test + file test trong số file chạm.
  let testCoverage = 0;
  const testSteps = steps.filter((s) => s.kind === 'test' || s.kind === 'test_result').length;
  const testFilesTouched = [...touched].filter((f) => f.includes('.test.') || f.includes('__tests__') || f.endsWith('.spec.ts')).length;
  const srcFilesTouched = [...touched].filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && !f.includes('.test.')).length;
  if (testSteps > 0) testCoverage += 50;
  if (testFilesTouched > 0) testCoverage += 30;
  if (srcFilesTouched === 0) {
    testCoverage = testSteps > 0 ? 60 : 50;
    reasons.testCoverage.push('Không sửa file nguồn — test không bắt buộc.');
  } else if (testFilesTouched === 0) {
    reasons.testCoverage.push(`Sửa ${srcFilesTouched} file nguồn nhưng không chạm file test nào.`);
  } else {
    testCoverage += 20;
    reasons.testCoverage.push(`Chạm ${testFilesTouched} file test cho ${srcFilesTouched} file nguồn.`);
  }
  if (testSteps === 0 && srcFilesTouched > 0) {
    reasons.testCoverage.push('Không chạy test nào trong phiên.');
  }
  dimensions.push({ name: 'testCoverage', score: clampScore(testCoverage), weight: 0.1, reasons: reasons.testCoverage });

  return dimensions;
}

/** Điểm tổng từ các trục (trung bình có trọng số, trục tắt thì bỏ). */
export function v18AggregateScore(
  dimensions: readonly V18CriticDimension[],
  config: V18CriticConfig,
): number {
  const valid = v18ValidateCriticConfig(config);
  const disabled = new Set(valid.disabledDimensions ?? []);
  const weights = { ...V18_CRITIC_DEFAULT_WEIGHTS, ...(valid.weights ?? {}) };
  let total = 0;
  let weightSum = 0;
  for (const dim of dimensions) {
    if (disabled.has(dim.name)) continue;
    const weight = weights[dim.name] ?? 0;
    total += dim.score * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return 0;
  return clampScore(total / weightSum);
}

/** Chấm trajectory: trả verdict đầy đủ (score + lý do + chặn push khi thấp). */
export function v18ScoreTrajectory(
  sessionId: string,
  steps: readonly V18TrajectoryStep[],
  options: { plannedFiles?: readonly string[]; config?: V18CriticConfig; now?: number } = {},
): V18CriticVerdict {
  const config = v18ValidateCriticConfig(options.config ?? V18_DEFAULT_CRITIC_CONFIG);
  const dimensions = v18ScoreTrajectoryDimensions({ steps, plannedFiles: options.plannedFiles });
  const score = v18AggregateScore(dimensions, config);
  const verdict = v18CriticVerdictFor(score, config);
  const reasons = dimensions.flatMap((d) => d.reasons.map((r) => `[${d.name} ${d.score}] ${r}`));
  return {
    target: 'trajectory',
    sessionId,
    score,
    verdict,
    blocked: verdict === 'block',
    threshold: { approveScore: config.approveScore, blockScore: config.blockScore },
    dimensions,
    reasons,
    scoredAt: options.now ?? Date.now(),
  };
}

/** Chấm patch: chuyển patch thành bước giả rồi chấm bằng cùng bộ trục. */
export function v18ScorePatch(
  patch: Readonly<Record<string, string>>,
  diffText: string,
  options: { plannedFiles?: readonly string[]; config?: V18CriticConfig; now?: number } = {},
): V18CriticVerdict {
  const files = Object.keys(patch);
  const steps: V18TrajectoryStep[] = files.map((file) => ({
    kind: file.includes('.test.') ? 'test' : 'file_write',
    text: patch[file] ?? '',
    files: [file],
  }));
  // Diff text mang lệnh/nguy cơ: quét safety qua một bước bash giả.
  if (diffText.trim() !== '') {
    steps.push({ kind: 'bash', text: diffText });
  }
  const verdict = v18ScoreTrajectory('', steps, {
    plannedFiles: options.plannedFiles,
    config: options.config,
    now: options.now,
  });
  return { ...verdict, target: 'patch', sessionId: undefined };
}

/** Render verdict critic thành text. */
export function renderV18CriticVerdict(verdict: V18CriticVerdict): string {
  const lines = [
    `Critic v18 (${verdict.target}): ${verdict.score}/100 — ${verdict.verdict.toUpperCase()}${verdict.blocked ? ' — CHẶN PUSH' : ''} (ngưỡng approve >= ${verdict.threshold.approveScore}, block < ${verdict.threshold.blockScore}).`,
    ...verdict.dimensions.map((d) => `  ${d.name}: ${d.score} (trọng số ${d.weight}) — ${d.reasons.join(' ')}`),
  ];
  return lines.join('\n');
}

/** Tạo id entry lịch sử (ổn định, không phụ thuộc clock). */
export function v18CriticHistoryId(sessionId: string, at: number): string {
  return `critic-${sessionId}-${at}`;
}

/** Thêm một verdict vào lịch sử (giữ tối đa N entry, mới nhất cuối). */
export function v18AppendCriticHistory(
  history: readonly V18CriticHistoryEntry[],
  verdict: V18CriticVerdict,
  reason: string,
  options: { maxEntries?: number; now?: number } = {},
): V18CriticHistoryEntry[] {
  const at = options.now ?? verdict.scoredAt;
  const entry: V18CriticHistoryEntry = {
    id: v18CriticHistoryId(verdict.sessionId ?? 'patch', at),
    sessionId: verdict.sessionId ?? 'patch',
    target: verdict.target,
    score: verdict.score,
    verdict: verdict.verdict,
    blocked: verdict.blocked,
    reason,
    at,
  };
  const max = options.maxEntries ?? V18_CRITIC_HISTORY_MAX_ENTRIES;
  return [...history, entry].slice(-Math.max(1, max));
}

/** Thống kê lịch sử chấm. */
export function v18CriticHistoryStats(history: readonly V18CriticHistoryEntry[]): V18CriticHistoryStats {
  if (history.length === 0) {
    return { total: 0, approved: 0, requestChanges: 0, blocked: 0, averageScore: 0, lowestScore: 0, highestScore: 0 };
  }
  const scores = history.map((e) => e.score);
  return {
    total: history.length,
    approved: history.filter((e) => e.verdict === 'approve').length,
    requestChanges: history.filter((e) => e.verdict === 'request-changes').length,
    blocked: history.filter((e) => e.blocked).length,
    averageScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    lowestScore: Math.min(...scores),
    highestScore: Math.max(...scores),
  };
}

/** Render lịch sử chấm thành text. */
export function renderV18CriticHistory(
  history: readonly V18CriticHistoryEntry[],
): string {
  if (history.length === 0) return 'Chưa có lịch sử chấm critic v18.';
  const stats = v18CriticHistoryStats(history);
  const lines = [
    `Lịch sử critic v18: ${stats.total} lần chấm, điểm trung bình ${stats.averageScore} (thấp nhất ${stats.lowestScore}, cao nhất ${stats.highestScore}), approve ${stats.approved}, request-changes ${stats.requestChanges}, block ${stats.blocked}.`,
    ...history.slice(-10).map((e) => `  ${e.sessionId} [${e.target}] ${e.score} ${e.verdict}${e.blocked ? ' BLOCK' : ''} — ${e.reason}`),
  ];
  return lines.join('\n');
}

/**
 * Xu hướng chất lượng theo lịch sử chấm: so sánh điểm trung bình nửa
 * đầu với nửa sau. Cần ít nhất 2 entry; 1 entry thì trend là stable.
 */
export function v18CriticTrend(history: readonly V18CriticHistoryEntry[]): V18CriticTrend {
  if (history.length < 2) {
    const only = history.length === 1 ? (history[0]?.score ?? 0) : 0;
    return { entries: history.length, firstHalfAverage: only, lastHalfAverage: only, delta: 0, direction: 'stable' };
  }
  const half = Math.floor(history.length / 2);
  const first = history.slice(0, half);
  const last = history.slice(half);
  const average = (entries: readonly V18CriticHistoryEntry[]): number =>
    Math.round(entries.reduce((sum, e) => sum + e.score, 0) / entries.length);
  const firstHalfAverage = average(first);
  const lastHalfAverage = average(last);
  const delta = lastHalfAverage - firstHalfAverage;
  return {
    entries: history.length,
    firstHalfAverage,
    lastHalfAverage,
    delta,
    direction: delta >= 5 ? 'improving' : delta <= -5 ? 'declining' : 'stable',
  };
}

/** Render trend critic thành text. */
export function renderV18CriticTrend(trend: V18CriticTrend): string {
  const label = trend.direction === 'improving' ? 'ĐANG TĂNG' : trend.direction === 'declining' ? 'ĐANG GIẢM' : 'ỔN ĐỊNH';
  return `Trend critic v18 (${trend.entries} lần chấm): nửa đầu trung bình ${trend.firstHalfAverage}, nửa sau ${trend.lastHalfAverage} (chênh ${trend.delta >= 0 ? '+' : ''}${trend.delta}) — ${label}.`;
}

/** Đọc lịch sử chấm từ file JSON (trả [] khi chưa có / lỗi parse). */
export function v18LoadCriticHistory(file: string): V18CriticHistoryEntry[] {
  try {
    if (!fs.existsSync(file)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is V18CriticHistoryEntry => Boolean(e) && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string');
  } catch {
    return [];
  }
}

/** Ghi lịch sử chấm ra file JSON (tạo thư mục cha khi cần). */
export function v18SaveCriticHistory(file: string, history: readonly V18CriticHistoryEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}
