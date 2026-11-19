/**
 * Coding agent v17 — verification stack tầng critic + review skill.
 *
 * Ý tưởng học từ OpenHands 1.x verification stack (survey v139 §4):
 * Critic Model chấm trajectory trước khi push; Code Review Skill chạy
 * trên mọi PR; "tạo code đã rẻ, nút thắt giờ là kiểm chứng". Thiết kế
 * và code là của open-bot (không copy repo khác, không gọi model thật
 * — critic ở đây là scorer xác định dựa trên trajectory/patch đo được,
 * để host có thể thay bằng model critic thật sau này qua cùng interface):
 *
 * - Critic trajectory: 4 trục (completeness / efficiency /
 *   errorRecovery / safety), mỗi trục 0..100, điểm tổng là trung bình
 *   có trọng số; verdict approve / request-changes / block theo ngưỡng.
 * - Critic patch: 4 trục (correctness / focus / testCoverage / safety);
 *   correctness dùng kết quả eval gate khi có (gate pass = 100).
 * - Review skill tự động: rule xác định quét mọi thay đổi — secret lộ
 *   (key/token/password), lệnh phá hoại (rm -rf /, mkfs, dd /dev,
 *   fork bomb), file quá lớn, patch quá rộng, file nhạy cảm (.env,
 *   credentials), thiếu test khi sửa code. Error → block, warning →
 *   request-changes.
 */

import { CodingV17Error } from './types';
import type {
  V17EvalReport,
  V17PatchCriticScore,
  V17ReplayState,
  V17ReviewFinding,
  V17ReviewResult,
  V17TrajectoryCriticScore,
  V17TrajectoryEvent,
} from './types';

/** Ngưỡng verdict critic (điểm tổng). */
export const V17_CRITIC_APPROVE_SCORE = 70;
export const V17_CRITIC_BLOCK_SCORE = 40;
/** Số dòng patch tối đa trước khi review gắn cờ "patch quá rộng". */
export const V17_REVIEW_MAX_PATCH_LINES = 1000;
/** Kích thước file tối đa (ký tự) trước khi review gắn cờ. */
export const V17_REVIEW_MAX_FILE_CHARS = 200_000;

/** Verdict từ điểm tổng: >=70 approve, 40..69 request-changes, <40 block. */
export function v17CriticVerdictFor(score: number): 'approve' | 'request-changes' | 'block' {
  if (score >= V17_CRITIC_APPROVE_SCORE) return 'approve';
  if (score >= V17_CRITIC_BLOCK_SCORE) return 'request-changes';
  return 'block';
}

/** Đếm bash command lặp lại (cùng command chạy >= 2 lần). */
export function v17CountRepeatedBash(commands: readonly string[]): number {
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
export function v17CountRedundantWrites(events: readonly V17TrajectoryEvent[]): number {
  const lastContent = new Map<string, string>();
  let redundant = 0;
  for (const event of events) {
    if (event.kind !== 'file_write' && event.kind !== 'file_edit') continue;
    const filePath = event.payload['path'];
    const content = event.payload['content'];
    if (typeof filePath !== 'string' || typeof content !== 'string') continue;
    if (lastContent.get(filePath) === content) redundant += 1;
    lastContent.set(filePath, content);
  }
  return redundant;
}

/** Lỗi compiler nào chưa được xử lý: error xuất hiện mà sau đó không có bash/test thành công. */
export function v17CountUnresolvedErrors(events: readonly V17TrajectoryEvent[]): number {
  let unresolved = 0;
  let openError = false;
  for (const event of events) {
    if (event.kind === 'compiler_error' || event.kind === 'error') {
      if (openError) unresolved += 1;
      openError = true;
    } else if (event.kind === 'test_result') {
      const result = event.payload['result'];
      if (result && typeof result === 'object' && (result as { passed?: unknown }).passed === true) {
        openError = false;
      }
    } else if (event.kind === 'bash_output') {
      if (event.payload['exitCode'] === 0) openError = false;
    }
  }
  if (openError) unresolved += 1;
  return unresolved;
}

/** Quét text tìm secret lộ (key/token/password gán giá trị dài). */
export function v17ContainsSecret(text: string): boolean {
  const patterns = [
    /(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/i,
    /sk-[A-Za-z0-9]{16,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  return patterns.some((p) => p.test(text));
}

/** Quét text tìm lệnh phá hoại (cùng denylist với CodeAct v2, thu hẹp). */
export function v17ContainsDestructiveCommand(text: string): string | undefined {
  const patterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /(^|\s)rm\s+.*-rf?\s+(\/|\~|\$HOME)(\s|$)/i, reason: 'rm -rf thư mục gốc/home' },
    { pattern: /(^|;|\s)mkfs(\s|\.)/i, reason: 'mkfs (format ổ đĩa)' },
    { pattern: /(^|;|\s)dd\s+.*of=\/dev\//i, reason: 'dd ghi trực tiếp device' },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
    { pattern: /(^|;|\s)(shutdown|reboot|poweroff|halt)(\s|;|$)/i, reason: 'shutdown/reboot/poweroff' },
  ];
  for (const { pattern, reason } of patterns) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}

/**
 * Chấm trajectory: 4 trục, điểm tổng = trung bình có trọng số
 * (completeness 0.35, efficiency 0.25, errorRecovery 0.25, safety 0.15).
 */
export function v17ScoreTrajectory(
  sessionId: string,
  events: readonly V17TrajectoryEvent[],
  state: V17ReplayState,
): V17TrajectoryCriticScore {
  if (sessionId.trim() === '') {
    throw new CodingV17Error('critic-invalid', 'sessionId không được rỗng.');
  }
  if (events.length === 0) {
    throw new CodingV17Error('critic-no-trajectory', 'không có event để chấm.');
  }
  const reasons: string[] = [];
  // Completeness: kết thúc tốt + test cuối pass + có file thay đổi.
  let completeness = 30;
  if (state.ended) completeness += 25;
  else reasons.push('phiên chưa kết thúc (thiếu session_end).');
  if (state.lastTestResult?.passed === true) completeness += 30;
  else if (state.lastTestResult) {
    completeness += 5;
    reasons.push('test cuối cùng fail.');
  } else {
    reasons.push('chưa chạy test nào.');
  }
  if (Object.keys(state.files).length > 0) completeness += 15;
  else reasons.push('không có file nào được ghi/sửa.');
  completeness = Math.min(100, completeness);

  // Efficiency: bước thừa = bash lặp + ghi đè trùng nội dung.
  const repeatedBash = v17CountRepeatedBash(state.bashCommands);
  const redundantWrites = v17CountRedundantWrites(events);
  const wastedSteps = repeatedBash + redundantWrites;
  const totalSteps = Math.max(1, events.length);
  const wasteRatio = wastedSteps / totalSteps;
  const efficiency = Math.max(0, Math.round(100 - wasteRatio * 400));
  if (repeatedBash > 0) reasons.push(`${repeatedBash} lệnh bash lặp lại.`);
  if (redundantWrites > 0) reasons.push(`${redundantWrites} lần ghi đè đúng nội dung cũ.`);

  // Error recovery: lỗi compiler chưa xử lý càng nhiều điểm càng thấp.
  const unresolvedErrors = v17CountUnresolvedErrors(events);
  const totalErrors = state.compilerErrors.length;
  const errorRecovery =
    totalErrors === 0 ? 100 : Math.max(0, Math.round(100 - (unresolvedErrors / totalErrors) * 100));
  if (unresolvedErrors > 0) reasons.push(`${unresolvedErrors}/${totalErrors} lỗi compiler chưa được xử lý.`);
  else if (totalErrors > 0) reasons.push(`đã xử lý hết ${totalErrors} lỗi compiler.`);

  // Safety: secret lộ trong log, lệnh phá hoại trong bash.
  let safety = 100;
  const logText = events.map((e) => JSON.stringify(e.payload)).join('\n');
  if (v17ContainsSecret(logText)) {
    safety -= 60;
    reasons.push('trajectory chứa secret (key/token/password) — phải redact trước khi lưu/chia sẻ.');
  }
  let destructive: string | undefined;
  for (const command of state.bashCommands) {
    destructive = v17ContainsDestructiveCommand(command);
    if (destructive) break;
  }
  if (destructive) {
    safety -= 40;
    reasons.push(`lệnh phá hoại trong trajectory: ${destructive}.`);
  }
  safety = Math.max(0, safety);

  const score = Math.round(
    completeness * 0.35 + efficiency * 0.25 + errorRecovery * 0.25 + safety * 0.15,
  );
  return {
    sessionId,
    score,
    axes: { completeness, efficiency, errorRecovery, safety },
    verdict: v17CriticVerdictFor(score),
    reasons,
    wastedSteps,
    unresolvedErrors,
  };
}

/** Đếm dòng thêm/xoá trong một diff text (dòng bắt đầu + / -). */
export function v17CountDiffLines(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/**
 * Chấm patch: correctness dùng eval gate khi có (gate pass = 100,
 * không có eval = 50 trung lập + ghi rõ lý do); focus đo tỉ lệ file
 * trong patch nằm ngoài plan/context; testCoverage đo test đi kèm;
 * safety đo pattern rủi ro trong diff.
 */
export function v17ScorePatch(
  patchFiles: Readonly<Record<string, string>>,
  diffText: string,
  options: {
    evalReport?: V17EvalReport;
    plannedFiles?: readonly string[];
    testFiles?: readonly string[];
  } = {},
): V17PatchCriticScore {
  const filePaths = Object.keys(patchFiles);
  if (filePaths.length === 0) {
    throw new CodingV17Error('critic-no-patch', 'patch rỗng (không có file).');
  }
  const { added, removed } = v17CountDiffLines(diffText);
  const reasons: string[] = [];
  // Correctness.
  let correctness = 50;
  if (options.evalReport) {
    correctness = options.evalReport.gatePassed ? 100 : 10;
    if (!options.evalReport.gatePassed) {
      reasons.push(
        `eval gate FAIL (${options.evalReport.passed}/${options.evalReport.passed + options.evalReport.failed} test pass).`,
      );
    }
  } else {
    reasons.push('không có eval gate — correctness chỉ 50 (chưa kiểm chứng).');
  }
  // Focus: file ngoài plan bị trừ điểm.
  let focus = 100;
  if (options.plannedFiles && options.plannedFiles.length > 0) {
    const planned = new Set(options.plannedFiles);
    const offPlan = filePaths.filter((f) => !planned.has(f));
    if (offPlan.length > 0) {
      focus = Math.max(0, Math.round(100 - (offPlan.length / filePaths.length) * 80));
      reasons.push(`file ngoài plan: ${offPlan.join(', ')}.`);
    }
  }
  if (added + removed > V17_REVIEW_MAX_PATCH_LINES) {
    focus = Math.max(0, focus - 20);
    reasons.push(`patch quá rộng (${added + removed} dòng > ${V17_REVIEW_MAX_PATCH_LINES}).`);
  }
  // Test coverage: có file test đi kèm trong patch không.
  const testFiles = options.testFiles ?? [];
  const hasTestInPatch = filePaths.some(
    (f) => f.includes('/test') || f.includes('test.') || f.endsWith('.test.ts') || f.endsWith('.test.mjs'),
  );
  const testCoverage = hasTestInPatch || testFiles.length > 0 ? 90 : 30;
  if (testCoverage < 90) reasons.push('patch không kèm file test.');
  // Safety: secret + lệnh phá hoại trong diff.
  let safety = 100;
  if (v17ContainsSecret(diffText)) {
    safety -= 60;
    reasons.push('patch chứa secret — phải xoá trước khi trình.');
  }
  const destructive = v17ContainsDestructiveCommand(diffText);
  if (destructive) {
    safety -= 40;
    reasons.push(`patch chứa lệnh phá hoại: ${destructive}.`);
  }
  safety = Math.max(0, safety);
  const score = Math.round(
    correctness * 0.4 + focus * 0.2 + testCoverage * 0.2 + safety * 0.2,
  );
  return {
    score,
    axes: { correctness, focus, testCoverage, safety },
    verdict: v17CriticVerdictFor(score),
    reasons,
    filesChanged: filePaths.length,
    linesAdded: added,
    linesRemoved: removed,
  };
}

/** Một rule review: quét diff/files, trả findings (rỗng khi sạch). */
export type V17ReviewRule = (
  patchFiles: Readonly<Record<string, string>>,
  diffText: string,
) => V17ReviewFinding[];

function ruleSecretInDiff(
  patchFiles: Readonly<Record<string, string>>,
  _diffText: string,
): V17ReviewFinding[] {
  const findings: V17ReviewFinding[] = [];
  for (const [file, content] of Object.entries(patchFiles)) {
    if (v17ContainsSecret(content)) {
      findings.push({
        severity: 'error',
        rule: 'secret-in-diff',
        file,
        line: 0,
        message: 'File chứa secret (api key / token / password / private key) — xoá và dùng Vault thay vì hard-code.',
      });
    }
  }
  return findings;
}

function ruleSensitiveFile(
  patchFiles: Readonly<Record<string, string>>,
  _diffText: string,
): V17ReviewFinding[] {
  const findings: V17ReviewFinding[] = [];
  const sensitive = [/\.env(\.|$)/, /credentials/i, /secret/i, /\.pem$/, /\.key$/, /id_rsa/];
  for (const file of Object.keys(patchFiles)) {
    if (sensitive.some((p) => p.test(file))) {
      findings.push({
        severity: 'error',
        rule: 'sensitive-file',
        file,
        line: 0,
        message: 'Patch chạm file nhạy cảm (.env / credentials / key) — không được commit file này.',
      });
    }
  }
  return findings;
}

function ruleDestructiveCommand(
  _patchFiles: Readonly<Record<string, string>>,
  diffText: string,
): V17ReviewFinding[] {
  const destructive = v17ContainsDestructiveCommand(diffText);
  if (!destructive) return [];
  return [
    {
      severity: 'error',
      rule: 'destructive-command',
      file: '',
      line: 0,
      message: `Patch chứa lệnh phá hoại: ${destructive}.`,
    },
  ];
}

function ruleLargePatch(
  patchFiles: Readonly<Record<string, string>>,
  diffText: string,
): V17ReviewFinding[] {
  const { added, removed } = v17CountDiffLines(diffText);
  const findings: V17ReviewFinding[] = [];
  if (added + removed > V17_REVIEW_MAX_PATCH_LINES) {
    findings.push({
      severity: 'warning',
      rule: 'patch-too-large',
      file: '',
      line: 0,
      message: `Patch quá rộng (${added + removed} dòng > ${V17_REVIEW_MAX_PATCH_LINES}) — nên tách nhỏ để review được.`,
    });
  }
  for (const [file, content] of Object.entries(patchFiles)) {
    if (content.length > V17_REVIEW_MAX_FILE_CHARS) {
      findings.push({
        severity: 'warning',
        rule: 'file-too-large',
        file,
        line: 0,
        message: `File quá lớn (${content.length} ký tự) — kiểm tra có nhét file build / dữ liệu vào patch không.`,
      });
    }
  }
  return findings;
}

function ruleMissingTests(
  patchFiles: Readonly<Record<string, string>>,
  _diffText: string,
): V17ReviewFinding[] {
  const codeFiles = Object.keys(patchFiles).filter(
    (f) => /\.(ts|tsx|js|jsx|py)$/.test(f) && !/test\./.test(f) && !f.startsWith('tests/'),
  );
  if (codeFiles.length === 0) return [];
  const hasTest = Object.keys(patchFiles).some(
    (f) => /test\./.test(f) || f.startsWith('tests/'),
  );
  if (hasTest) return [];
  return [
    {
      severity: 'warning',
      rule: 'missing-tests',
      file: '',
      line: 0,
      message: `Sửa ${codeFiles.length} file code nhưng không kèm test — thêm test cho tính năng mới.`,
    },
  ];
}

/** Mọi rule của review skill (chạy trên mọi thay đổi). */
export const V17_REVIEW_RULES: readonly V17ReviewRule[] = [
  ruleSecretInDiff,
  ruleSensitiveFile,
  ruleDestructiveCommand,
  ruleLargePatch,
  ruleMissingTests,
];

/** Chạy review skill tự động trên một patch (diff text + file mới). */
export function v17ReviewPatch(
  patchFiles: Readonly<Record<string, string>>,
  diffText: string,
): V17ReviewResult {
  if (Object.keys(patchFiles).length === 0) {
    throw new CodingV17Error('review-invalid', 'patch rỗng (không có file để review).');
  }
  const findings: V17ReviewFinding[] = [];
  for (const rule of V17_REVIEW_RULES) {
    findings.push(...rule(patchFiles, diffText));
  }
  findings.sort((a, b) => {
    const order = { error: 0, warning: 1, note: 2 } as const;
    return order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule);
  });
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const notes = findings.filter((f) => f.severity === 'note').length;
  return {
    passed: errors === 0,
    findings,
    errors,
    warnings,
    notes,
    filesReviewed: Object.keys(patchFiles).length,
  };
}

/** Render điểm critic trajectory thành text. */
export function renderV17TrajectoryCriticScore(score: V17TrajectoryCriticScore): string {
  const lines = [
    `Critic trajectory ${score.sessionId}: ${score.score}/100 — ${score.verdict}.`,
    `  completeness ${score.axes.completeness}, efficiency ${score.axes.efficiency}, errorRecovery ${score.axes.errorRecovery}, safety ${score.axes.safety}.`,
    `  Bước thừa: ${score.wastedSteps}, lỗi chưa xử lý: ${score.unresolvedErrors}.`,
  ];
  for (const reason of score.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}

/** Render điểm critic patch thành text. */
export function renderV17PatchCriticScore(score: V17PatchCriticScore): string {
  const lines = [
    `Critic patch: ${score.score}/100 — ${score.verdict}.`,
    `  correctness ${score.axes.correctness}, focus ${score.axes.focus}, testCoverage ${score.axes.testCoverage}, safety ${score.axes.safety}.`,
    `  ${score.filesChanged} files, +${score.linesAdded}/-${score.linesRemoved} dòng.`,
  ];
  for (const reason of score.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}

/** Render kết quả review thành text. */
export function renderV17ReviewResult(review: V17ReviewResult): string {
  const lines = [
    `Review skill: ${review.passed ? 'PASS' : 'FAIL'} — ${review.errors} error, ${review.warnings} warning, ${review.notes} note (${review.filesReviewed} files).`,
  ];
  for (const finding of review.findings) {
    lines.push(
      `  [${finding.severity}] ${finding.rule}${finding.file ? ` ${finding.file}` : ''}: ${finding.message}`,
    );
  }
  return lines.join('\n');
}
