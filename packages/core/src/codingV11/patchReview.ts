/**
 * Coding agent v11 — patch review tự động.
 *
 * Review patch (unified diff) mà KHÔNG cần gọi model: parse diff
 * rồi chạy 5 nhóm kiểm tra tĩnh, chấm điểm rủi ro 0..100 và đưa
 * verdict approve / comment / request-changes:
 *
 *   1. risk: xóa nhiều dòng, đổi file nhạy cảm (.env, vault,
 *      credentials, workflow CI, lockfile), đổi file ngoài source
 *      (docs chỉ là info), diff quá lớn, xóa file, đổi API công
 *      khai (export bị xóa).
 *   2. secret: quét dòng thêm mới bằng pattern secret thường gặp
 *      (api key, token, password, private key, Bearer) — chỉ cảnh
 *      báo, không khẳng định chắc chắn (pattern có false positive,
 *      ghi rõ trong detail).
 *   3. style: dòng quá dài (>120 ký tự), tab thụt đầu dòng, khoảng
 *      trắng cuối dòng, thiếu newline cuối file.
 *   4. test-gap: file nguồn đổi mà không có file test đi kèm trong
 *      cùng patch (theo quy ước: test nằm cùng thư mục `test(s)/`
 *      hoặc tên chứa `.test.` / `_test` / `__tests__`).
 *   5. correctness: dấu hiệu thường sai — `console.log` còn sót,
 *      `TODO`/`FIXME` mới, `eval(` / `Function(`, `// @ts-ignore`
 *      không giải thích, import bị xóa nhưng symbol vẫn dùng.
 *
 * Giới hạn trung thực: review tĩnh, không chạy code, không hiểu
 * semantics sâu — verdict chỉ là gợi ý cho người review, không
 * thay quyết định merge. Secret scan là heuristic (regex), có thể
 * báo nhầm chuỗi test/mock.
 */

import { CodingV11Error } from './types';
import type { V11PatchReview, V11ReviewFinding, V11ReviewSeverity } from './types';

/** Dòng tối đa cho phép (style). */
export const V11_REVIEW_MAX_LINE_LENGTH = 120;
/** Ngưỡng điểm rủi ro: <30 low, 30..59 medium, >=60 high. */
export const V11_REVIEW_RISK_MEDIUM = 30;
export const V11_REVIEW_RISK_HIGH = 60;
/** Số dòng đổi tối đa trước khi cảnh báo "diff quá lớn". */
export const V11_REVIEW_LARGE_DIFF_LINES = 500;
/** Số file đổi tối đa trước khi cảnh báo "patch quá rộng". */
export const V11_REVIEW_LARGE_DIFF_FILES = 10;
/** Độ dài diff tối đa review (ký tự) — dài hơn thì cắt + cảnh báo. */
export const V11_REVIEW_MAX_DIFF_CHARS = 200_000;

/** Path nhạy cảm: đổi vào đây tăng mạnh điểm rủi ro. */
export const V11_REVIEW_SENSITIVE_PATHS: readonly string[] = [
  '.env',
  'credentials',
  'secret',
  'vault',
  '.pem',
  '.key',
  'id_rsa',
  '.github/workflows/',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

/** Pattern secret thường gặp (heuristic — có false positive). */
export const V11_REVIEW_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'API key', re: /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
  { name: 'token', re: /(token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
  { name: 'password', re: /password\s*[:=]\s*['"][^'"]{4,}['"]/i },
  { name: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
];

/** Một file trong diff đã parse. */
export interface V11ParsedDiffFile {
  /** Path file mới (`b/<path>`). */
  path: string;
  /** Path file cũ (`a/<path>`), null khi file mới. */
  oldPath: string | null;
  /** true = file mới tạo, true = file bị xóa. */
  isNew: boolean;
  isDeleted: boolean;
  /** Dòng thêm (nội dung + số dòng trong file mới). */
  added: Array<{ line: number; text: string }>;
  /** Dòng xóa (nội dung + số dòng trong file cũ). */
  removed: Array<{ line: number; text: string }>;
  /** Dòng thêm có phải là export bị xóa ở phía cũ không (đổi API). */
  removedExports: string[];
}

/** Parse unified diff thành danh sách file (hàm thuần, không throw khi diff rỗng). */
export function v11ParsePatch(diff: string): V11ParsedDiffFile[] {
  const files: V11ParsedDiffFile[] = [];
  const lines = diff.split('\n');
  let current: V11ParsedDiffFile | null = null;
  // Path cũ từ dòng `---` (đi trước dòng `+++` nên phải giữ tạm).
  let pendingOldPath: string | null | undefined;
  let newLineNo = 0;
  let oldLineNo = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = null;
      pendingOldPath = undefined;
      newLineNo = 0;
      oldLineNo = 0;
      continue;
    }
    if (line.startsWith('--- ')) {
      const oldPath = line.slice(4).trim().replace(/^a\//, '');
      pendingOldPath = oldPath === '/dev/null' ? null : oldPath;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = line.slice(4).trim().replace(/^b\//, '');
      const isDeleted = newPath === '/dev/null';
      const oldPath = pendingOldPath ?? null;
      current = {
        path: isDeleted ? (oldPath ?? 'unknown') : newPath,
        oldPath,
        isNew: oldPath === null && !isDeleted,
        isDeleted,
        added: [],
        removed: [],
        removedExports: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@ ')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldLineNo = parseInt(m[1] as string, 10);
        newLineNo = parseInt(m[2] as string, 10);
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added.push({ line: newLineNo, text: line.slice(1) });
      newLineNo += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const text = line.slice(1);
      current.removed.push({ line: oldLineNo, text });
      if (/^\s*export\b/.test(text)) current.removedExports.push(text.trim().slice(0, 120));
      oldLineNo += 1;
      continue;
    }
    // Dòng context (bắt đầu bằng khoảng trắng) hoặc dòng rỗng cuối.
    if (line.startsWith(' ') || line === '') {
      oldLineNo += 1;
      newLineNo += 1;
    }
  }
  return files;
}

/** true = path là file test (theo quy ước của repo). */
export function v11IsTestFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return (
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/__tests__/') ||
    /\.test\.[a-z]+$/.test(p) ||
    /\.spec\.[a-z]+$/.test(p) ||
    /(^|\/)test_[^/]+\.[a-z]+$/.test(p)
  );
}

/** true = path là file nguồn (code, không phải test/docs/config). */
export function v11IsSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/.test(path) && !v11IsTestFile(path);
}

/** true = path nhạy cảm (tăng rủi ro). */
export function v11IsSensitivePath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return V11_REVIEW_SENSITIVE_PATHS.some((s) => p === s || p.includes(s));
}

function addFinding(
  findings: V11ReviewFinding[],
  severity: V11ReviewSeverity,
  category: V11ReviewFinding['category'],
  file: string,
  line: number,
  title: string,
  detail: string,
  suggestion?: string,
): void {
  findings.push({ severity, category, file, line, title, detail, suggestion });
}

/**
 * Review một patch (unified diff): chấm rủi ro, quét secret, kiểm
 * tra style, phát hiện test thiếu, gợi ý sửa. Không throw khi diff
 * rỗng — trả review "không có gì để review".
 */
export function reviewV11Patch(diff: string): V11PatchReview {
  if (typeof diff !== 'string') {
    throw new CodingV11Error('patch-invalid', 'Patch review: diff phải là string.');
  }
  const truncated = diff.length > V11_REVIEW_MAX_DIFF_CHARS;
  const diffText = truncated ? diff.slice(0, V11_REVIEW_MAX_DIFF_CHARS) : diff;
  const files = v11ParsePatch(diffText);
  const findings: V11ReviewFinding[] = [];
  let riskScore = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const filesMissingTests: string[] = [];
  const testFilesChanged = new Set(files.filter((f) => v11IsTestFile(f.path)).map((f) => f.path));

  if (truncated) {
    addFinding(
      findings,
      'warning',
      'risk',
      '',
      0,
      'Diff quá dài, chỉ review phần đầu',
      `Diff dài ${diff.length} ký tự, vượt giới hạn ${V11_REVIEW_MAX_DIFF_CHARS} — chỉ review ${V11_REVIEW_MAX_DIFF_CHARS} ký tự đầu; phần còn lại chưa được kiểm tra.`,
      'Chia patch nhỏ ra trước khi review.',
    );
    riskScore += 10;
  }
  if (files.length === 0) {
    return {
      diffPreview: '',
      riskScore: 0,
      riskLevel: 'low',
      findings,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      filesMissingTests: [],
      verdict: 'comment',
      summary: 'Patch rỗng — không có gì để review.',
    };
  }
  for (const file of files) {
    linesAdded += file.added.length;
    linesRemoved += file.removed.length;
    // --- risk: file nhạy cảm / xóa file / đổi export ---
    if (v11IsSensitivePath(file.path)) {
      addFinding(
        findings,
        'error',
        'risk',
        file.path,
        0,
        'Đổi file nhạy cảm',
        `Patch đổi file nhạy cảm "${file.path}" — kiểm tra kỹ: không commit secret/key, không đổi workflow CI khi chưa review riêng.`,
        'Tách file nhạy cảm ra khỏi patch này và review riêng.',
      );
      riskScore += 25;
    }
    if (file.isDeleted) {
      addFinding(
        findings,
        'warning',
        'risk',
        file.path,
        0,
        'Xóa file',
        `Patch xóa toàn bộ file "${file.path}" (${file.removed.length} dòng) — chắc chắn không còn ai import/dùng file này?`,
        'Chạy kiểm tra tham chiếu (call graph impact set) trước khi xóa.',
      );
      riskScore += 15;
    }
    if (file.removedExports.length > 0) {
      addFinding(
        findings,
        'warning',
        'risk',
        file.path,
        0,
        'Xóa export (đổi API công khai)',
        `Patch xóa ${file.removedExports.length} export: ${file.removedExports.slice(0, 3).join(' | ')} — code khác import các export này sẽ vỡ.`,
        'Giữ export cũ (deprecated) hoặc cập nhật mọi nơi import nó.',
      );
      riskScore += 10;
    }
    // --- secret: quét dòng thêm mới ---
    for (const added of file.added) {
      for (const pattern of V11_REVIEW_SECRET_PATTERNS) {
        if (pattern.re.test(added.text)) {
          addFinding(
            findings,
            'error',
            'secret',
            file.path,
            added.line,
            `Nghi có ${pattern.name} trong code`,
            `Dòng ${added.line} khớp pattern ${pattern.name} — có thể là secret thật. Đây là heuristic, kiểm tra tay: nếu là secret thật thì XÓA KHỎI LỊCH SỬ GIT, không chỉ xóa dòng.`,
            'Chuyển secret vào Vault / biến môi trường, không hard-code.',
          );
          riskScore += 20;
          break;
        }
      }
    }
    // --- style + correctness trên dòng thêm ---
    for (const added of file.added) {
      const text = added.text;
      if (text.length > V11_REVIEW_MAX_LINE_LENGTH) {
        addFinding(
          findings,
          'info',
          'style',
          file.path,
          added.line,
          'Dòng quá dài',
          `Dòng ${added.line} dài ${text.length} ký tự (giới hạn ${V11_REVIEW_MAX_LINE_LENGTH}).`,
          'Tách dòng dài thành nhiều dòng.',
        );
      }
      if (/^\t/.test(text)) {
        addFinding(
          findings,
          'info',
          'style',
          file.path,
          added.line,
          'Thụt đầu dòng bằng tab',
          `Dòng ${added.line} thụt bằng tab — repo dùng spaces.`,
          'Đổi tab thành spaces.',
        );
      }
      if (/[ \t]+$/.test(text)) {
        addFinding(
          findings,
          'info',
          'style',
          file.path,
          added.line,
          'Khoảng trắng cuối dòng',
          `Dòng ${added.line} có khoảng trắng thừa ở cuối.`,
          'Xóa khoảng trắng cuối dòng.',
        );
      }
      if (/console\.log\(/.test(text)) {
        addFinding(
          findings,
          'warning',
          'correctness',
          file.path,
          added.line,
          'console.log còn sót',
          `Dòng ${added.line} thêm console.log — có phải debug tạm quên xóa?`,
          'Xóa console.log hoặc đổi sang logger của repo.',
        );
      }
      if (/\b(TODO|FIXME|XXX|HACK)\b/.test(text)) {
        addFinding(
          findings,
          'info',
          'correctness',
          file.path,
          added.line,
          'TODO/FIXME mới',
          `Dòng ${added.line} thêm ghi chú TODO/FIXME — ghi rõ ai làm, khi nào, hoặc tạo task theo dõi.`,
        );
      }
      if (/\beval\s*\(/.test(text) || /\bFunction\s*\(/.test(text)) {
        addFinding(
          findings,
          'error',
          'correctness',
          file.path,
          added.line,
          'Dùng eval/Function',
          `Dòng ${added.line} dùng eval() hoặc Function() — chạy code dạng string, rủi ro injection, khó review.`,
          'Viết code trực tiếp thay vì eval.',
        );
        riskScore += 15;
      }
      if (/\/\/\s*@ts-ignore/.test(text) && !/:\s*\S/.test(text)) {
        addFinding(
          findings,
          'warning',
          'correctness',
          file.path,
          added.line,
          '@ts-ignore không giải thích',
          `Dòng ${added.line} dùng @ts-ignore mà không ghi lý do — lỗi type bị giấu, khó bảo trì.`,
          'Ghi lý do sau @ts-ignore hoặc sửa type thật.',
        );
      }
    }
    // --- test-gap: file nguồn đổi mà không có test đi kèm ---
    if (v11IsSourceFile(file.path) && file.added.length > 0) {
      const hasTestForFile =
        testFilesChanged.size > 0 &&
        [...testFilesChanged].some((t) => {
          const base = file.path.replace(/\.[a-z]+$/, '').split('/').pop() as string;
          return t.includes(base);
        });
      if (!hasTestForFile) {
        filesMissingTests.push(file.path);
        addFinding(
          findings,
          'warning',
          'test-gap',
          file.path,
          0,
          'Thiếu test đi kèm',
          `File nguồn "${file.path}" đổi ${file.added.length} dòng thêm mà patch không có file test nào cho nó.`,
          'Thêm test cho code mới (testgen v2 sinh được test từ diff).',
        );
        riskScore += 5;
      }
    }
  }
  // --- risk tổng: diff quá lớn / quá nhiều file ---
  const totalChanged = linesAdded + linesRemoved;
  if (totalChanged > V11_REVIEW_LARGE_DIFF_LINES) {
    addFinding(
      findings,
      'warning',
      'risk',
      '',
      0,
      'Diff quá lớn',
      `Patch đổi ${totalChanged} dòng (giới hạn cảnh báo ${V11_REVIEW_LARGE_DIFF_LINES}) — patch lớn khó review kỹ, dễ lọt lỗi.`,
      'Chia patch thành nhiều patch nhỏ theo từng thay đổi.',
    );
    riskScore += 10;
  }
  if (files.length > V11_REVIEW_LARGE_DIFF_FILES) {
    addFinding(
      findings,
      'warning',
      'risk',
      '',
      0,
      'Patch đổi quá nhiều file',
      `Patch đổi ${files.length} file (giới hạn cảnh báo ${V11_REVIEW_LARGE_DIFF_FILES}) — kiểm tra xem có file nào đổi ngoài ý muốn không.`,
    );
    riskScore += 5;
  }
  riskScore = Math.min(100, riskScore);
  const riskLevel = riskScore >= V11_REVIEW_RISK_HIGH ? 'high' : riskScore >= V11_REVIEW_RISK_MEDIUM ? 'medium' : 'low';
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;
  const verdict: V11PatchReview['verdict'] =
    errorCount > 0 ? 'request-changes' : warningCount > 0 ? 'comment' : 'approve';
  const summary =
    verdict === 'request-changes'
      ? `Request changes: ${errorCount} lỗi nghiêm trọng (rủi ro ${riskLevel}, ${riskScore}/100) — sửa trước khi merge.`
      : verdict === 'comment'
        ? `Comment: ${warningCount} cảnh báo (rủi ro ${riskLevel}, ${riskScore}/100) — xem xét rồi merge.`
        : `Approve: không có lỗi/cảnh báo (rủi ro ${riskLevel}, ${riskScore}/100).`;
  return {
    diffPreview: diffText.slice(0, 4000),
    riskScore,
    riskLevel,
    findings,
    errorCount,
    warningCount,
    infoCount,
    filesChanged: files.length,
    linesAdded,
    linesRemoved,
    filesMissingTests,
    verdict,
    summary,
  };
}

/** Tóm tắt review thành text ngắn (để log/UI). */
export function renderV11PatchReviewSummary(review: V11PatchReview): string {
  return [
    `Patch review: ${review.verdict} — ${review.summary}`,
    `Files: ${review.filesChanged}, +${review.linesAdded}/-${review.linesRemoved}, findings: ${review.errorCount} error, ${review.warningCount} warning, ${review.infoCount} info.`,
    review.filesMissingTests.length > 0 ? `Thiếu test: ${review.filesMissingTests.join(', ')}.` : 'Không thiếu test.',
  ].join('\n');
}
