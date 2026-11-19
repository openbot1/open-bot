/**
 * Coding agent v18 — review skill tự động trên PR/diff (v1.40, Đội T4).
 *
 * Ý tưởng học từ survey v140 §6: code-review skill tự động chạy trên
 * mỗi PR/diff (kiểm tra style, lỗi thường gặp, test thiếu). Code của
 * open-bot: 16 rule xác định quét patch + diff, finding có mức độ
 * (error/warning/info) + gợi ý sửa + auto-fix mô tả, tích hợp quy
 * trình PR qua v18ReviewPr (gate merge + summary đăng PR). Nối v17
 * (không viết lại): rule secret/destructive/sensitive-file của
 * v17ReviewPatch được giữ nguyên ý tưởng nhưng viết lại bộ rule v18
 * mở rộng thêm style, lỗi thường gặp và test thiếu.
 */

import { CodingV18Error } from './types';
import type {
  V18AutoFixResult,
  V18PrReview,
  V18ReviewFinding,
  V18ReviewReport,
  V18ReviewRule,
  V18ReviewSeverity,
} from './types';

/** Số dòng patch tối đa trước khi gắn cờ "patch quá rộng". */
export const V18_REVIEW_MAX_PATCH_LINES = 1000;
/** Kích thước file tối đa (ký tự) trước khi gắn cờ "file quá lớn". */
export const V18_REVIEW_MAX_FILE_CHARS = 200_000;
/** Số dòng tối đa của một hàm trước khi gắn cờ "hàm quá dài". */
export const V18_REVIEW_MAX_FUNCTION_LINES = 80;
/** Số warning tối đa cho phép trước khi PR review fail (mặc định: chỉ error mới fail). */
export const V18_REVIEW_DEFAULT_MAX_WARNINGS = Number.POSITIVE_INFINITY;

/** Toàn bộ rule của review skill v18. */
export const V18_REVIEW_RULES: readonly V18ReviewRule[] = [
  { id: 'secret-leak', severity: 'error', title: 'Lộ secret', description: 'Key/token/password gán giá trị dài hoặc private key trong patch.' },
  { id: 'destructive-command', severity: 'error', title: 'Lệnh phá hoại', description: 'rm -rf gốc, mkfs, dd /dev, fork bomb, shutdown/reboot, chmod 777 gốc.' },
  { id: 'sensitive-file', severity: 'error', title: 'File nhạy cảm', description: 'Sửa .env, credentials, *.pem/*.key, thư mục .ssh/.aws/.gnupg.' },
  { id: 'oversized-patch', severity: 'warning', title: 'Patch quá rộng', description: 'Patch vượt quá số dòng cho phép — nên chia nhỏ PR.' },
  { id: 'huge-file', severity: 'warning', title: 'File quá lớn', description: 'Một file trong patch vượt quá kích thước cho phép.' },
  { id: 'missing-test', severity: 'warning', title: 'Thiếu test', description: 'Sửa/thêm file nguồn mà không có file test tương ứng trong patch.' },
  { id: 'long-function', severity: 'warning', title: 'Hàm quá dài', description: 'Hàm vượt quá số dòng cho phép — nên tách nhỏ.' },
  { id: 'console-log-left', severity: 'warning', title: 'Còn console.log/debugger', description: 'console.log / console.debug / debugger còn sót trong code.' },
  { id: 'empty-catch', severity: 'warning', title: 'Catch rỗng', description: 'Khối catch không làm gì — lỗi bị nuốt lặng.' },
  { id: 'any-cast', severity: 'warning', title: 'Ép kiểu any', description: '`as any` / `: any` làm mất kiểm tra kiểu.' },
  { id: 'todo-without-owner', severity: 'info', title: 'TODO không có chủ', description: 'TODO/FIXME không ghi người chịu trách nhiệm.' },
  { id: 'duplicate-import', severity: 'info', title: 'Import trùng', description: 'Cùng một module được import 2 lần trong một file.' },
  { id: 'deep-relative-import', severity: 'info', title: 'Import tương đối quá sâu', description: 'Đường dẫn ../../../ vượt quá 2 cấp — nên dùng alias.' },
  { id: 'missing-eof-newline', severity: 'info', title: 'Thiếu newline cuối file', description: 'File không kết thúc bằng newline.' },
  { id: 'circular-import-in-patch', severity: 'warning', title: 'Import vòng trong patch', description: 'Hai file trong patch import lẫn nhau — nguy cơ cycle.' },
  { id: 'unhandled-promise', severity: 'warning', title: 'Promise không xử lý', description: 'Lời gọi async không await và không có .catch — lỗi bị trôi.' },
];

export function v18ReviewRuleById(ruleId: string): V18ReviewRule | undefined {
  return V18_REVIEW_RULES.find((r) => r.id === ruleId);
}

export interface V18ReviewOptions {
  /** Chỉ chạy các rule này (mặc định chạy tất cả). */
  enabledRules?: string[];
  /** Số dòng patch tối đa (mặc định V18_REVIEW_MAX_PATCH_LINES). */
  maxPatchLines?: number;
  /** Kích thước file tối đa (mặc định V18_REVIEW_MAX_FILE_CHARS). */
  maxFileChars?: number;
  /** Số dòng hàm tối đa (mặc định V18_REVIEW_MAX_FUNCTION_LINES). */
  maxFunctionLines?: number;
  /** Timestamp gốc (test dùng clock cố định). */
  now?: number;
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

const SENSITIVE_PATH = /(^|\/)\.env(\.|$)|(^|\/)credentials(\.|$)|(^|\/)\.ssh\/|(^|\/)\.aws\/|(^|\/)\.gnupg\/|\.pem$|\.key$|id_rsa/i;

/** File có phải file test không. */
export function v18IsTestFile(filePath: string): boolean {
  return filePath.includes('.test.') || filePath.includes('__tests__') || /\.spec\.(ts|tsx|js|jsx|mjs)$/.test(filePath);
}

/** File có phải file nguồn cần test đi kèm không. */
export function v18IsSourceFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs)$/.test(filePath) && !v18IsTestFile(filePath);
}

/** Đếm số dòng diff (dòng + / -). */
export function v18CountDiffLines(diffText: string): number {
  let count = 0;
  for (const line of diffText.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
      count += 1;
    }
  }
  return count;
}

/** Tìm hàm dài nhất trong nội dung file (heuristic: đếm dòng từ `function`/`=> {` tới khi brace cân bằng). */
export function v18LongestFunctionLines(content: string): { name: string; lines: number; line: number } | undefined {
  const lines = content.split('\n');
  let best: { name: string; lines: number; line: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const match = /(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{|([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{)/.exec(line);
    if (!match) continue;
    const name = match[1] ?? match[2] ?? match[3] ?? 'anonymous';
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length; j += 1) {
      const current = lines[j] ?? '';
      for (const ch of current) {
        if (ch === '{') { depth += 1; started = true; }
        if (ch === '}') depth -= 1;
      }
      if (started && depth <= 0) { end = j; break; }
      end = j;
    }
    const length = end - i + 1;
    if (!best || length > best.lines) best = { name, lines: length, line: i + 1 };
  }
  return best;
}

/** Import ra từ nội dung file (static + dynamic + require). */
export function v18ExtractImportsForReview(content: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

function makeFinding(
  ruleId: string,
  file: string,
  message: string,
  suggestion: string,
  extra: Partial<V18ReviewFinding> = {},
): V18ReviewFinding {
  const rule = v18ReviewRuleById(ruleId);
  const severity: V18ReviewSeverity = rule?.severity ?? 'info';
  return {
    id: `${ruleId}:${file}${extra.line ? `:${extra.line}` : ''}`,
    rule: ruleId,
    severity,
    file,
    message,
    suggestion,
    ...extra,
  };
}

function lineNumberOf(content: string, needle: string): number | undefined {
  const idx = content.split('\n').findIndex((l) => l.includes(needle));
  return idx >= 0 ? idx + 1 : undefined;
}

/** Chạy review skill v18 trên một patch (map path -> nội dung mới) + diff text. */
export function v18ReviewPatch(
  patch: Readonly<Record<string, string>>,
  diffText: string,
  options: V18ReviewOptions = {},
): V18ReviewReport {
  const enabled = new Set(options.enabledRules ?? V18_REVIEW_RULES.map((r) => r.id));
  for (const ruleId of enabled) {
    if (!v18ReviewRuleById(ruleId)) {
      throw new CodingV18Error(`Không có review rule "${ruleId}".`);
    }
  }
  const maxPatchLines = options.maxPatchLines ?? V18_REVIEW_MAX_PATCH_LINES;
  const maxFileChars = options.maxFileChars ?? V18_REVIEW_MAX_FILE_CHARS;
  const maxFunctionLines = options.maxFunctionLines ?? V18_REVIEW_MAX_FUNCTION_LINES;
  const findings: V18ReviewFinding[] = [];
  const files = Object.keys(patch);
  const run = (ruleId: string): boolean => enabled.has(ruleId);

  const diffLines = v18CountDiffLines(diffText);
  if (run('oversized-patch') && diffLines > maxPatchLines) {
    findings.push(makeFinding('oversized-patch', '(patch)', `Patch có ${diffLines} dòng thay đổi, vượt giới hạn ${maxPatchLines}.`, 'Chia nhỏ PR thành nhiều PR nhỏ hơn, mỗi PR một mục đích.', { line: undefined }));
  }

  const patchTestFiles = files.filter((f) => v18IsTestFile(f));
  for (const file of files) {
    const content = patch[file] ?? '';
    const lines = content.split('\n');

    if (run('sensitive-file') && SENSITIVE_PATH.test(file)) {
      findings.push(makeFinding('sensitive-file', file, `File nhạy cảm "${file}" không được đưa vào patch.`, 'Đưa secret vào vault / biến môi trường, không commit file này.', { autoFix: `Loại "${file}" khỏi patch.` }));
    }
    if (run('huge-file') && content.length > maxFileChars) {
      findings.push(makeFinding('huge-file', file, `File "${file}" dài ${content.length} ký tự, vượt giới hạn ${maxFileChars}.`, 'Tách file thành nhiều module nhỏ hơn.', { line: undefined }));
    }
    if (run('secret-leak')) {
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.exec(content);
        if (match) {
          findings.push(makeFinding('secret-leak', file, `Nghi lộ secret trong "${file}" (${match[0].slice(0, 24)}…).`, 'Xoá secret khỏi code, đưa vào vault; xoay (rotate) secret đã lộ.', { line: lineNumberOf(content, match[0]), autoFix: 'Thay giá trị thật bằng placeholder lấy từ vault.' }));
          break;
        }
      }
    }
    if (run('destructive-command')) {
      for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(content) || pattern.test(diffText)) {
          findings.push(makeFinding('destructive-command', file, `Lệnh phá hoại trong "${file}": ${reason}.`, 'Dùng API an toàn (trash / scoped delete) thay cho lệnh shell phá hoại.'));
          break;
        }
      }
    }
    if (run('missing-test') && v18IsSourceFile(file)) {
      const base = file.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
      const hasTest = patchTestFiles.some((t) => t.startsWith(base) || t.includes(base.split('/').pop() ?? ''));
      if (!hasTest) {
        findings.push(makeFinding('missing-test', file, `File nguồn "${file}" không có file test đi kèm trong patch.`, 'Thêm test cho hành vi mới (happy path + một trường hợp lỗi).', { autoFix: `Thêm tests/${base.split('/').pop()}.test.mjs.` }));
      }
    }
    if (run('long-function')) {
      const longest = v18LongestFunctionLines(content);
      if (longest && longest.lines > maxFunctionLines) {
        findings.push(makeFinding('long-function', file, `Hàm "${longest.name}" dài ${longest.lines} dòng (giới hạn ${maxFunctionLines}).`, 'Tách hàm thành nhiều hàm nhỏ, mỗi hàm một nhiệm vụ.', { line: longest.line }));
      }
    }
    if (run('console-log-left')) {
      const hit = lines.find((l) => /console\.(log|debug|info)\s*\(/.test(l) || /^\s*debugger;?/.test(l));
      if (hit) {
        findings.push(makeFinding('console-log-left', file, `Còn sót "${hit.trim().slice(0, 60)}" trong "${file}".`, 'Xoá log debug hoặc chuyển sang logger có level.', { line: lineNumberOf(content, hit), autoFix: 'Xoá dòng console.log/debugger.' }));
      }
    }
    if (run('empty-catch')) {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
        findings.push(makeFinding('empty-catch', file, `Khối catch rỗng trong "${file}" — lỗi bị nuốt lặng.`, 'Ghi log lỗi hoặc throw lại với context rõ ràng.', { line: lineNumberOf(content, 'catch') }));
      }
    }
    if (run('any-cast')) {
      const hit = lines.find((l) => /as\s+any\b/.test(l) || /:\s*any\b/.test(l));
      if (hit) {
        findings.push(makeFinding('any-cast', file, `Ép kiểu any trong "${file}": "${hit.trim().slice(0, 60)}".`, 'Dùng kiểu cụ thể hoặc `unknown` + narrow.', { line: lineNumberOf(content, hit) }));
      }
    }
    if (run('todo-without-owner')) {
      const hit = lines.find((l) => /(TODO|FIXME)\s*:/.test(l) && !/@[A-Za-z0-9_-]+/.test(l));
      if (hit) {
        findings.push(makeFinding('todo-without-owner', file, `TODO không ghi người chịu trách nhiệm: "${hit.trim().slice(0, 60)}".`, 'Thêm @owner vào TODO để có người theo dõi.', { line: lineNumberOf(content, hit) }));
      }
    }
    if (run('duplicate-import')) {
      const imports = v18ExtractImportsForReview(content);
      const seen = new Set<string>();
      const dup = imports.find((spec) => {
        if (seen.has(spec)) return true;
        seen.add(spec);
        return false;
      });
      if (dup) {
        findings.push(makeFinding('duplicate-import', file, `Module "${dup}" được import 2 lần trong "${file}".`, 'Gộp thành một import duy nhất.', { autoFix: `Gộp các import từ "${dup}".` }));
      }
    }
    if (run('deep-relative-import')) {
      const hit = v18ExtractImportsForReview(content).find((spec) => spec.startsWith('../../../'));
      if (hit) {
        findings.push(makeFinding('deep-relative-import', file, `Import tương đối quá sâu: "${hit}".`, 'Dùng alias package (@open-bot/...) thay cho đường dẫn tương đối sâu.'));
      }
    }
    if (run('missing-eof-newline') && content.length > 0 && !content.endsWith('\n')) {
      findings.push(makeFinding('missing-eof-newline', file, `File "${file}" không kết thúc bằng newline.`, 'Thêm newline cuối file.', { autoFix: 'Thêm \\n cuối file.' }));
    }
    if (run('unhandled-promise')) {
      const hit = lines.find((l) => /^\s*(?!.*\bawait\b)(?!.*\.catch\b)[A-Za-z0-9_$.]+\s*\([^)]*\)\s*;?\s*$/.test(l) && /\b(fetch|request|writeFile|exec|spawn)\w*\s*\(/.test(l));
      if (hit) {
        findings.push(makeFinding('unhandled-promise', file, `Lời gọi async không await/catch: "${hit.trim().slice(0, 60)}".`, 'Thêm await hoặc .catch để lỗi không bị trôi.', { line: lineNumberOf(content, hit) }));
      }
    }
  }

  // Import vòng trong patch: hai file import lẫn nhau.
  if (run('circular-import-in-patch')) {
    const importMap = new Map<string, Set<string>>();
    for (const file of files) {
      const specs = v18ExtractImportsForReview(patch[file] ?? '');
      const targets = new Set<string>();
      for (const spec of specs) {
        if (!spec.startsWith('.')) continue;
        const resolved = v18ResolveRelativeImport(file, spec);
        if (resolved && files.includes(resolved)) targets.add(resolved);
      }
      importMap.set(file, targets);
    }
    const reported = new Set<string>();
    for (const [file, targets] of importMap) {
      for (const target of targets) {
        if ((importMap.get(target) ?? new Set()).has(file)) {
          const key = [file, target].sort().join('<->');
          if (!reported.has(key)) {
            reported.add(key);
            findings.push(makeFinding('circular-import-in-patch', file, `"${file}" và "${target}" import lẫn nhau.`, 'Tách phần chung ra module thứ ba, hoặc đảo chiều dependency.', {}));
          }
        }
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;
  return {
    verdict: errorCount > 0 ? 'fail' : 'pass',
    findings,
    errorCount,
    warningCount,
    infoCount,
    filesReviewed: files.length,
    linesReviewed: diffLines,
    rulesRun: [...enabled].sort(),
    checkedAt: options.now ?? Date.now(),
  };
}

/** Resolve import tương đối thành path chuẩn hoá (thử .ts/.tsx/.js/index). */
export function v18ResolveRelativeImport(fromFile: string, spec: string): string | undefined {
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const parts = (dir ? `${dir}/${spec}` : spec).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const base = out.join('/');
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((c) => c.endsWith('.ts') || c.endsWith('.tsx') || c.endsWith('.js')) ?? base;
}

/** Review trên PR: report + summary đăng PR + gate merge. */
export function v18ReviewPr(
  patch: Readonly<Record<string, string>>,
  diffText: string,
  options: V18ReviewOptions & { maxWarnings?: number } = {},
): V18PrReview {
  const report = v18ReviewPatch(patch, diffText, options);
  const maxWarnings = options.maxWarnings ?? V18_REVIEW_DEFAULT_MAX_WARNINGS;
  const mergeable = report.errorCount === 0 && report.warningCount <= maxWarnings;
  const lines = [
    `Review skill v18: ${report.verdict.toUpperCase()} — ${report.filesReviewed} files, ${report.linesReviewed} dòng diff, ${report.errorCount} error / ${report.warningCount} warning / ${report.infoCount} info.`,
    mergeable ? 'Gate PR: PASS — được phép merge.' : `Gate PR: FAIL — chặn merge (${report.errorCount} error${report.warningCount > maxWarnings ? `, ${report.warningCount} warning vượt giới hạn ${maxWarnings}` : ''}).`,
  ];
  for (const finding of report.findings) {
    lines.push(`- [${finding.severity}] ${finding.rule} (${finding.file}${finding.line ? `:${finding.line}` : ''}): ${finding.message} Gợi ý: ${finding.suggestion}`);
  }
  const disabledRules = V18_REVIEW_RULES.map((r) => r.id).filter((id) => !report.rulesRun.includes(id));
  return { report, mergeable, summary: lines.join('\n'), disabledRules };
}

/** Render report review thành text. */
export function renderV18ReviewReport(report: V18ReviewReport): string {
  const lines = [
    `Review skill v18: ${report.verdict.toUpperCase()} — ${report.filesReviewed} files, ${report.linesReviewed} dòng diff, ${report.errorCount} error / ${report.warningCount} warning / ${report.infoCount} info (${report.rulesRun.length} rules).`,
  ];
  for (const finding of report.findings) {
    lines.push(`- [${finding.severity}] ${finding.rule} (${finding.file}${finding.line ? `:${finding.line}` : ''}): ${finding.message} Gợi ý: ${finding.suggestion}${finding.autoFix ? ` Auto-fix: ${finding.autoFix}` : ''}`);
  }
  if (report.findings.length === 0) lines.push('Không có finding — patch sạch.');
  return lines.join('\n');
}

/**
 * Áp các auto-fix AN TOÀN lên patch: chỉ những finding có autoFix và
 * sửa được bằng phép biến đổi cục bộ, xác định (không đoán):
 * - missing-eof-newline: thêm newline cuối file.
 * - console-log-left: xoá dòng console.log / console.debug / debugger.
 * - duplicate-import: gộp các import trùng (giữ dòng đầu, xoá dòng sau).
 * Mọi finding khác (secret, destructive, missing-test, …) được liệt
 * kê vào skipped — con người phải sửa tay. Trả patch mới, không sửa
 * patch gốc.
 */
export function v18ApplyAutoFixes(
  patch: Readonly<Record<string, string>>,
  report: V18ReviewReport,
): V18AutoFixResult {
  const next: Record<string, string> = { ...patch };
  const applied: string[] = [];
  const skipped: { findingId: string; reason: string }[] = [];
  const fixable = new Set(['missing-eof-newline', 'console-log-left', 'duplicate-import']);
  for (const finding of report.findings) {
    if (!fixable.has(finding.rule)) {
      skipped.push({ findingId: finding.id, reason: `Rule "${finding.rule}" cần người sửa tay.` });
      continue;
    }
    const content = next[finding.file];
    if (typeof content !== 'string') {
      skipped.push({ findingId: finding.id, reason: `File "${finding.file}" không có trong patch.` });
      continue;
    }
    if (finding.rule === 'missing-eof-newline') {
      if (content.length > 0 && !content.endsWith('\n')) {
        next[finding.file] = `${content}\n`;
        applied.push(finding.id);
      } else {
        skipped.push({ findingId: finding.id, reason: 'File đã có newline cuối (fix không còn cần).' });
      }
      continue;
    }
    if (finding.rule === 'console-log-left') {
      const lines = content.split('\n');
      const kept = lines.filter((line) => !/console\.(log|debug|info)\s*\(/.test(line) && !/^\s*debugger;?/.test(line));
      if (kept.length === lines.length) {
        skipped.push({ findingId: finding.id, reason: 'Không còn dòng console.log/debugger (fix không còn cần).' });
      } else {
        next[finding.file] = kept.join('\n');
        applied.push(finding.id);
      }
      continue;
    }
    if (finding.rule === 'duplicate-import') {
      const seen = new Set<string>();
      const kept: string[] = [];
      let removed = 0;
      for (const line of content.split('\n')) {
        const match = /from\s+['"]([^'"]+)['"]/.exec(line);
        if (match && line.trim().startsWith('import')) {
          if (seen.has(match[1] as string)) {
            removed += 1;
            continue;
          }
          seen.add(match[1] as string);
        }
        kept.push(line);
      }
      if (removed === 0) {
        skipped.push({ findingId: finding.id, reason: 'Không còn import trùng (fix không còn cần).' });
      } else {
        next[finding.file] = kept.join('\n');
        applied.push(finding.id);
      }
    }
  }
  return { patch: next, applied, skipped };
}

/** Render kết quả auto-fix thành text. */
export function renderV18AutoFixResult(result: V18AutoFixResult): string {
  const lines = [
    `Auto-fix v18: áp được ${result.applied.length} fix, bỏ qua ${result.skipped.length} finding.`,
  ];
  for (const id of result.applied) lines.push(`  ✓ ${id}`);
  for (const skip of result.skipped) lines.push(`  - bỏ qua ${skip.findingId}: ${skip.reason}`);
  return lines.join('\n');
}
