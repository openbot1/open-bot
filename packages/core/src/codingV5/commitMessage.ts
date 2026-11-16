/**
 * Auto-commit message co nghia cho coding agent v5 (v1.13, Doi T4).
 *
 * Y tuong hoc tu Aider (sinh commit message tu diff) — chi hoc y
 * tuong, tu thiet ke va viet lai hoan toan tu dau, KHONG doc, KHONG
 * copy code/text/tai san cua Aider hay bat ky repo nao:
 *
 *   - Phan loai thay doi: feat / fix / refactor / test / docs /
 *     chore — dua tren duong dan file + symbol them/xoa + tu khoa
 *     trong dong thay doi (khong doan tu message cu).
 *   - Scope: module chung nhat cua cac file doi (vd `coding-v5`,
 *     `desktop`, `tools`), theo quy uoc repo (tien to thu muc).
 *   - Tom tat: dong dau tien mo ta thay doi lon nhat (them symbol
 *     moi, sua ham, xoa file...), body liet ke file + so dong, footer
 *     ghi issue ref neu caller dua.
 *   - Validate message theo quy uoc: `type(scope): subject`, subject
 *     <= 72 ky tu, khong ket thuc bang dau cham, body dong <= 100 ky tu.
 *
 * Day la sinh message de xuat (host hien cho user xac nhan truoc khi
 * commit) — khong tu commit. Message chi tot nhu diff dua vao: diff
 * cang nho, cang tap trung thi message cang chinh xac.
 */

import type { CodingV5FileDiff, CodingV5Patch } from './patchPreview';

export type CodingV5ChangeType = 'feat' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore';

export const CODING_V5_COMMIT_SUBJECT_MAX = 72;
export const CODING_V5_COMMIT_BODY_LINE_MAX = 100;

/** Symbol moi/xoa tim thay trong mot file diff. */
export interface CodingV5SymbolChange {
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';
  name: string;
  change: 'added' | 'removed';
}

/** Ket qua phan tich mot patch (de sinh message + de test). */
export interface CodingV5DiffAnalysis {
  type: CodingV5ChangeType;
  scope: string;
  filesChanged: number;
  hunksChanged: number;
  additions: number;
  deletions: number;
  addedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
  addedSymbols: CodingV5SymbolChange[];
  removedSymbols: CodingV5SymbolChange[];
  /** Tu khoa phat hien (fix/bug/...) trong dong thay doi. */
  keywords: string[];
  /** Ly do chon type (de giai thich cho user). */
  typeReason: string;
}

export interface CodingV5CommitMessage {
  /** Dong subject: `type(scope): summary`. */
  subject: string;
  /** Body: bullet file + symbol (co the rong). */
  body: string;
  /** Toan bo message (subject + body + footer). */
  full: string;
  type: CodingV5ChangeType;
  scope: string;
  analysis: CodingV5DiffAnalysis;
}

export interface CodingV5CommitMessageOptions {
  /** Ep type (bo qua phan loai tu dong). */
  type?: CodingV5ChangeType;
  /** Ep scope (bo qua suy luan tu duong dan). */
  scope?: string;
  /** Ghi de subject (chi dung khi caller da co tom tat). */
  subject?: string;
  /** Issue ref dua vao footer, vd `closes #123` hoac `refs v1.13`. */
  issueRef?: string;
  /** Them dong body tu do (mo ta them cua agent/user). */
  extraBodyLines?: string[];
  /** Gioi han so file liet ke trong body (mac dinh 15). */
  maxFilesInBody?: number;
}

const SYMBOL_PATTERNS: Array<{ kind: CodingV5SymbolChange['kind']; re: RegExp }> = [
  { kind: 'function', re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: 'function', re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/ },
  { kind: 'class', re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'enum', re: /(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=/ },
];

const FIX_KEYWORDS = ['fix', 'bug', 'crash', 'regress', 'broken', 'error', 'leak', 'panic', 'hotfix'];
const FEAT_KEYWORDS = ['add', 'new', 'implement', 'support', 'introduce', 'feature'];
const REFACTOR_KEYWORDS = ['refactor', 'rename', 'move', 'extract', 'simplify', 'cleanup'];

/** Tim symbol dinh nghia trong mot dong code (them/xoa). */
export function extractCodingV5SymbolsFromLine(text: string): CodingV5SymbolChange[] {
  const found: CodingV5SymbolChange[] = [];
  for (const { kind, re } of SYMBOL_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) {
      found.push({ kind, name: m[1], change: 'added' });
      break; // Moi dong chi lay 1 symbol dau tien.
    }
  }
  return found;
}

/** true khi duong dan la file test (theo quy uoc repo: *.test.*). */
export function isCodingV5TestPath(relPath: string): boolean {
  return /(^|\/)[^/]+\.test\.[cm]?[jt]sx?$/.test(relPath) || relPath.startsWith('tests/');
}

/** true khi duong dan la tai lieu. */
export function isCodingV5DocsPath(relPath: string): boolean {
  return relPath.startsWith('docs/') || /\.md$/.test(relPath) || relPath === 'README.md';
}

/** true khi duong dan la file i18n locale. */
export function isCodingV5LocalePath(relPath: string): boolean {
  return relPath.includes('/i18n/locales/') && /\.json$/.test(relPath);
}

/**
 * Scope tu duong dan: lay 2-3 phan dau co nghia, bo tien to chung
 * (`packages/`, `apps/`). Vd:
 * `packages/core/src/codingV5/patchPreview.ts` -> `coding-v5`;
 * `apps/desktop/src/renderer/i18n/locales/vi.json` -> `desktop-i18n`;
 * `tests/coding-v5-patch-preview.test.mjs` -> `test`;
 * `docs/v113-coding.md` -> `docs`.
 */
export function scopeFromCodingV5Path(relPath: string): string {
  const parts = relPath.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return 'repo';
  if (parts[0] === 'tests') return 'test';
  if (parts[0] === 'docs') return 'docs';
  if (parts[0] === 'scripts') return 'scripts';
  if (parts[0] === 'packages' && parts.length >= 3) {
    const pkg = parts[1] ?? '';
    const src = parts[2] ?? '';
    if (src === 'src' && parts.length >= 4) {
      const mod = (parts[3] ?? '').replace(/\.[^.]+$/, '');
      // `packages/core/src/codingV5/...` -> `coding-v5`
      const kebab = mod.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      return pkg === 'core' ? kebab : `${pkg}-${kebab}`;
    }
    return pkg;
  }
  if (parts[0] === 'apps' && parts.length >= 2) {
    const app = parts[1] ?? '';
    if (isCodingV5LocalePath(relPath)) return `${app}-i18n`;
    return app;
  }
  return parts[0] ?? 'repo';
}

/** Scope chung nhat: scope xuat hien nhieu nhat (hoa neu bang nhau). */
export function scopeFromCodingV5Paths(paths: string[]): string {
  if (paths.length === 0) return 'repo';
  const counts = new Map<string, number>();
  for (const p of paths) {
    const scope = scopeFromCodingV5Path(p);
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  let best = 'repo';
  let bestCount = -1;
  for (const [scope, count] of counts) {
    if (count > bestCount) {
      best = scope;
      bestCount = count;
    }
  }
  return best;
}

/** Phan tich patch thanh cau truc dung de sinh commit message. */
export function analyzeCodingV5Diff(patch: CodingV5Patch): CodingV5DiffAnalysis {
  const addedSymbols: CodingV5SymbolChange[] = [];
  const removedSymbols: CodingV5SymbolChange[] = [];
  const keywords = new Set<string>();
  const addedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ from: string; to: string }> = [];
  const paths: string[] = [];

  for (const file of patch.files) {
    const displayPath = file.newPath || file.oldPath;
    paths.push(displayPath);
    if (file.status === 'added') addedFiles.push(displayPath);
    if (file.status === 'deleted') deletedFiles.push(displayPath);
    if (file.status === 'renamed') renamedFiles.push({ from: file.oldPath, to: file.newPath });
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'context') continue;
        const lower = line.text.toLowerCase();
        for (const kw of [...FIX_KEYWORDS, ...FEAT_KEYWORDS, ...REFACTOR_KEYWORDS]) {
          if (lower.includes(kw)) keywords.add(kw);
        }
        const symbols = extractCodingV5SymbolsFromLine(line.text);
        for (const symbol of symbols) {
          if (line.type === 'add') {
            addedSymbols.push({ ...symbol, change: 'added' });
          } else {
            removedSymbols.push({ ...symbol, change: 'removed' });
          }
        }
      }
    }
  }

  const allTest = paths.length > 0 && paths.every((p) => isCodingV5TestPath(p));
  const allDocs = paths.length > 0 && paths.every((p) => isCodingV5DocsPath(p));
  const onlyLocales = paths.length > 0 && paths.every((p) => isCodingV5LocalePath(p));
  const testOnly = allTest;
  const hasTest = paths.some((p) => isCodingV5TestPath(p));
  const hasSourceChange = patch.files.some(
    (f) => !isCodingV5TestPath(f.newPath || f.oldPath) && !isCodingV5DocsPath(f.newPath || f.oldPath),
  );

  let type: CodingV5ChangeType;
  let typeReason: string;
  if (patch.isEmpty) {
    type = 'chore';
    typeReason = 'Patch rong — khong co thay doi de phan loai.';
  } else if (testOnly) {
    type = 'test';
    typeReason = 'Chi doi file test.';
  } else if (allDocs || onlyLocales) {
    type = 'docs';
    typeReason = allDocs ? 'Chi doi tai lieu.' : 'Chi doi file locale i18n.';
  } else if (addedSymbols.length > 0 && (keywords.has('add') || keywords.has('new') || addedFiles.length > 0)) {
    type = 'feat';
    typeReason = `Them ${addedSymbols.length} symbol moi${addedFiles.length > 0 ? ` va ${addedFiles.length} file moi` : ''}.`;
  } else if (keywords.has('fix') || keywords.has('bug') || keywords.has('crash') || keywords.has('regress')) {
    type = 'fix';
    typeReason = `Dong thay doi chua tu khoa sua loi (${[...keywords].filter((k) => FIX_KEYWORDS.includes(k)).join(', ')}).`;
  } else if (
    renamedFiles.length > 0 ||
    (addedSymbols.length === removedSymbols.length &&
      addedSymbols.length > 0 &&
      patch.additions > 0 &&
      patch.deletions > 0 &&
      Math.abs(patch.additions - patch.deletions) <= Math.max(2, Math.floor(patch.additions * 0.2)))
  ) {
    type = 'refactor';
    typeReason =
      renamedFiles.length > 0
        ? `Doi ten/di chuyen ${renamedFiles.length} file.`
        : 'Them/xoa symbol can bang — giong doi ten hoac sap xep lai code.';
  } else if (addedSymbols.length > 0) {
    type = 'feat';
    typeReason = `Them ${addedSymbols.length} symbol moi.`;
  } else if (hasSourceChange && patch.deletions > patch.additions * 2) {
    type = 'refactor';
    typeReason = 'Xoa nhieu hon them gap doi — giong don dep code.';
  } else if (hasTest && !hasSourceChange) {
    type = 'test';
    typeReason = 'Chi doi test va tai lieu kem theo.';
  } else {
    type = 'chore';
    typeReason = 'Khong xep vao feat/fix/refactor/test/docs — mac dinh chore.';
  }

  return {
    type,
    scope: scopeFromCodingV5Paths(paths),
    filesChanged: patch.files.length,
    hunksChanged: patch.files.reduce((s, f) => s + f.hunks.length, 0),
    additions: patch.additions,
    deletions: patch.deletions,
    addedFiles,
    deletedFiles,
    renamedFiles,
    addedSymbols,
    removedSymbols,
    keywords: [...keywords].sort(),
    typeReason,
  };
}

/** Viet subject tu analysis: `type(scope): summary` (<= 72 ky tu). */
export function buildCodingV5Subject(analysis: CodingV5DiffAnalysis): string {
  const { type, scope } = analysis;
  let summary: string;
  if (analysis.addedFiles.length === 1 && analysis.addedSymbols.length === 0) {
    summary = `add ${analysis.addedFiles[0]}`;
  } else if (analysis.addedFiles.length > 1 && analysis.addedSymbols.length === 0) {
    summary = `add ${analysis.addedFiles.length} files`;
  } else if (analysis.deletedFiles.length > 0 && analysis.addedSymbols.length === 0) {
    summary =
      analysis.deletedFiles.length === 1
        ? `remove ${analysis.deletedFiles[0]}`
        : `remove ${analysis.deletedFiles.length} files`;
  } else if (analysis.renamedFiles.length > 0 && analysis.addedSymbols.length === 0) {
    const r = analysis.renamedFiles[0];
    summary = r ? `rename ${r.from} to ${r.to}` : 'rename files';
  } else if (analysis.addedSymbols.length > 0) {
    const names = analysis.addedSymbols.slice(0, 3).map((s) => s.name);
    const verb = type === 'fix' ? 'fix' : type === 'refactor' ? 'refactor' : 'add';
    summary = `${verb} ${names.join(', ')}${analysis.addedSymbols.length > 3 ? ` (+${analysis.addedSymbols.length - 3} more)` : ''}`;
  } else if (analysis.removedSymbols.length > 0) {
    const names = analysis.removedSymbols.slice(0, 3).map((s) => s.name);
    summary = `remove ${names.join(', ')}`;
  } else {
    const files = analysis.filesChanged;
    summary = `update ${files} file${files === 1 ? '' : 's'} (+${analysis.additions}/-${analysis.deletions})`;
  }
  let subject = `${type}(${scope}): ${summary}`;
  if (subject.length > CODING_V5_COMMIT_SUBJECT_MAX) {
    // Cat ngan: bo dau cham cuoi truoc khi them '...' (validator coi
    // '...' la dau cat ngan, khong phai dau cham ket cau).
    const cut = subject.slice(0, CODING_V5_COMMIT_SUBJECT_MAX - 3).replace(/\.+$/, '').replace(/\s+$/, '');
    subject = `${cut}...`;
  }
  return subject;
}

/** Cat mot dong body ve <= 100 ky tu (giu quy uoc repo). */
function truncateCommitBodyLine(line: string): string {
  if (line.length <= CODING_V5_COMMIT_BODY_LINE_MAX) return line;
  return `${line.slice(0, CODING_V5_COMMIT_BODY_LINE_MAX - 3).replace(/\s+$/, '')}...`;
}

/** Sinh commit message day du tu patch. */
export function generateCodingV5CommitMessage(
  patch: CodingV5Patch,
  options: CodingV5CommitMessageOptions = {},
): CodingV5CommitMessage {
  const analysis = analyzeCodingV5Diff(patch);
  const type = options.type ?? analysis.type;
  const scope = options.scope ?? analysis.scope;
  const effective: CodingV5DiffAnalysis = { ...analysis, type, scope };
  const subject = options.subject ?? buildCodingV5Subject(effective);

  const bodyLines: string[] = [];
  const maxFiles = options.maxFilesInBody ?? 15;
  for (const file of patch.files.slice(0, maxFiles)) {
    const name = file.status === 'renamed' ? `${file.oldPath} -> ${file.newPath}` : file.newPath || file.oldPath;
    bodyLines.push(`- ${name} (+${file.additions}/-${file.deletions})`);
  }
  if (patch.files.length > maxFiles) {
    bodyLines.push(`- ... and ${patch.files.length - maxFiles} more file(s)`);
  }
  if (analysis.addedSymbols.length > 0) {
    const names = analysis.addedSymbols.map((s) => `${s.kind} ${s.name}`).slice(0, 10);
    bodyLines.push(
      truncateCommitBodyLine(
        `- Added: ${names.join(', ')}${analysis.addedSymbols.length > 10 ? ` (+${analysis.addedSymbols.length - 10} more)` : ''}`,
      ),
    );
  }
  if (analysis.removedSymbols.length > 0) {
    const names = analysis.removedSymbols.map((s) => `${s.kind} ${s.name}`).slice(0, 10);
    bodyLines.push(
      truncateCommitBodyLine(
        `- Removed: ${names.join(', ')}${analysis.removedSymbols.length > 10 ? ` (+${analysis.removedSymbols.length - 10} more)` : ''}`,
      ),
    );
  }
  for (const extra of options.extraBodyLines ?? []) {
    if (extra.trim() !== '') bodyLines.push(truncateCommitBodyLine(extra.trim()));
  }
  const body = bodyLines.join('\n');
  const footerParts: string[] = [];
  if (options.issueRef) footerParts.push(options.issueRef);
  const footer = footerParts.join('\n');
  const full = [subject, body, footer].filter((p) => p.trim() !== '').join('\n\n');
  return { subject, body, full, type, scope, analysis: effective };
}

/** Tom tat thay doi bang mot doan text ngan (de hien trong UI/chat). */
export function summarizeCodingV5ChangesForCommit(patch: CodingV5Patch): string {
  const analysis = analyzeCodingV5Diff(patch);
  const subject = buildCodingV5Subject(analysis);
  return `${subject} — ${analysis.typeReason} ${analysis.filesChanged} file(s), +${analysis.additions}/-${analysis.deletions}.`;
}

export interface CodingV5CommitMessageIssue {
  code: string;
  message: string;
}

/**
 * Validate message theo quy uoc repo. Tra ve danh sach loi (rong =
 * hop le). Kiem tra: subject co dang `type(scope): summary`, type
 * trong allowlist, subject <= 72 ky tu, khong ket thuc bang `.`,
 * dong body <= 100 ky tu, khong co dong trong lien tiep qua 1.
 */
export function validateCodingV5CommitMessage(message: string): CodingV5CommitMessageIssue[] {
  const issues: CodingV5CommitMessageIssue[] = [];
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const subject = lines[0] ?? '';
  if (subject.trim() === '') {
    issues.push({ code: 'empty-subject', message: 'Commit message rong (khong co subject).' });
    return issues;
  }
  const match = /^([a-z]+)(?:\(([^)]+)\))?: (.+)$/.exec(subject);
  if (!match) {
    issues.push({
      code: 'bad-format',
      message: 'Subject phai co dang "type(scope): summary" hoac "type: summary".',
    });
  } else {
    const type = match[1] ?? '';
    const allowed: CodingV5ChangeType[] = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore'];
    if (!allowed.includes(type as CodingV5ChangeType)) {
      issues.push({ code: 'bad-type', message: `Type "${type}" khong nam trong ${allowed.join(', ')}.` });
    }
    const summary = match[3] ?? '';
    if (summary.trim() === '') {
      issues.push({ code: 'empty-summary', message: 'Summary sau ":" rong.' });
    }
    // '...' cuoi subject la dau cat ngan (subject bi cat o 72 ky tu),
    // khong phai dau cham ket cau — khong bao loi.
    if (summary.endsWith('.') && !summary.endsWith('...')) {
      issues.push({ code: 'trailing-dot', message: 'Summary khong nen ket thuc bang dau cham.' });
    }
    if (/^[A-Z]/.test(summary)) {
      issues.push({ code: 'capital-summary', message: 'Summary nen bat dau bang chu thuong (quy uoc repo).' });
    }
  }
  if (subject.length > CODING_V5_COMMIT_SUBJECT_MAX) {
    issues.push({
      code: 'subject-too-long',
      message: `Subject dai ${subject.length} ky tu (toi da ${CODING_V5_COMMIT_SUBJECT_MAX}).`,
    });
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length > CODING_V5_COMMIT_BODY_LINE_MAX) {
      issues.push({
        code: 'body-line-too-long',
        message: `Dong ${i + 1} dai ${line.length} ky tu (toi da ${CODING_V5_COMMIT_BODY_LINE_MAX}).`,
      });
    }
    if (line.trim() === '' && (lines[i + 1] ?? '').trim() === '' && i + 1 < lines.length) {
      issues.push({ code: 'double-blank-line', message: `Hai dong trong lien tiep o dong ${i + 1}.` });
      break;
    }
  }
  return issues;
}

/** Goi tat cho mot file diff (de test/dung truc tiep). */
export function analyzeCodingV5FileDiff(file: CodingV5FileDiff): CodingV5DiffAnalysis {
  return analyzeCodingV5Diff({
    files: [file],
    additions: file.additions,
    deletions: file.deletions,
    isEmpty: file.hunks.length === 0,
  });
}
