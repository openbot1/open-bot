/**
 * Patch preview truoc khi apply cho coding agent v5 (v1.13, Doi T4).
 *
 * Y tuong hoc tu Aider (che do diff/preview + `git add -p` duyet tung
 * hunk) — chi hoc y tuong, tu thiet ke va viet lai hoan toan tu dau,
 * KHONG doc, KHONG copy code/text/tai san cua Aider hay bat ky repo
 * nao:
 *
 *   - Agent tao unified diff -> parse thanh cau truc (file/hunk/dong)
 *     -> hien preview (file nao, hunk nao, them/xoa bao nhieu dong)
 *     -> user/agent xac nhan tung hunk -> chi apply hunk da duyet.
 *   - Preview render dang text gon (gioi han ky tu/hunk) de dua vao
 *     context chat hoac hien trong UI; ban day du van giu trong
 *     session de duyet chi tiet.
 *   - Apply hunk da chon: dung lai unified diff chi chua hunk duoc
 *     duyet (tinh lai so dong hunk header) roi `git apply` qua
 *     CodingV5GitSession (luon `--check` truoc).
 *
 * Dinh dang ho tro: unified diff chuan cua git (`diff --git`,
 * `---`/`+++`, `@@ -a,b +c,d @@`, dong context/`+`/`-`, dong
 * `\ No newline at end of file`, header `new file mode`,
 * `deleted file mode`, `rename from/to`, `similarity index`,
 * `Binary files ... differ`).
 *
 * Gioi han trung thuc:
 *   - Parser khong hieu diff dang `git diff --word-diff` hay
 *     `--stat` — chi unified diff.
 *   - Hunk da duyet nhung phu thuoc vao hunk bi tu choi o truoc
 *     (cung vung) co the apply that bai — `git apply --check` se
 *     bao truoc, khong doi gi.
 *   - Dong context co the bat dau bang `+`/`-` trong noi dung that
 *     (vd chuoi "+1"): parser phan biet bang vi tri dau dong va so
 *     dong hunk header — dong context luon co 1 ky tu tien to.
 */

import { CodingV5GitError, CodingV5GitSession } from './gitV5';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CODING_V5_PREVIEW_MAX_CHARS = 20_000;
export const CODING_V5_PREVIEW_MAX_HUNK_LINES = 120;
/** So dong context toi thieu git can de apply mot hunk tach rieng. */
export const CODING_V5_MIN_CONTEXT_LINES = 3;

export type CodingV5DiffLineType = 'context' | 'add' | 'del';

export interface CodingV5DiffLine {
  type: CodingV5DiffLineType;
  /** Noi dung dong (khong co ky tu tien to ` `/`+`/`-`). */
  text: string;
  /** So dong file cu (1-based), chi co voi context/del. */
  oldLineNo: number | null;
  /** So dong file moi (1-based), chi co voi context/add. */
  newLineNo: number | null;
  /** true khi dong cuoi file khong co newline (`\ No newline...`). */
  noNewline: boolean;
}

export type CodingV5FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

export interface CodingV5Hunk {
  /** Id on dinh trong patch: `<fileIndex>:<hunkIndex>` (vd `2:0`). */
  id: string;
  /** Header goc, vd `@@ -12,5 +12,7 @@ function foo()`. */
  header: string;
  /** Ham/symbol sau @@ (co the rong). */
  sectionHeading: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: CodingV5DiffLine[];
  additions: number;
  deletions: number;
}

export interface CodingV5FileDiff {
  /** Chi so file trong patch (0-based). */
  index: number;
  oldPath: string;
  newPath: string;
  status: CodingV5FileStatus;
  /** true khi file moi (new file mode). */
  isNewFile: boolean;
  /** true khi file bi xoa (deleted file mode). */
  isDeletedFile: boolean;
  /** Header phu truoc hunk (new/deleted mode, rename, similarity...). */
  extraHeaders: string[];
  hunks: CodingV5Hunk[];
  additions: number;
  deletions: number;
}

export interface CodingV5Patch {
  files: CodingV5FileDiff[];
  additions: number;
  deletions: number;
  /** true khi patch rong (khong co file nao). */
  isEmpty: boolean;
}

export class CodingV5PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingV5PatchError';
  }
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const DIFF_GIT_QUOTED_RE = /^diff --git "(a\/.+?)" "(b\/.+?)"\s*$/;

function unquoteGitPath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return p;
}

/** Tach mot dong unified diff thanh {type, text} (khong tinh so dong). */
function parseDiffLine(raw: string): { type: CodingV5DiffLineType; text: string } {
  const marker = raw[0];
  if (marker === '+') return { type: 'add', text: raw.slice(1) };
  if (marker === '-') return { type: 'del', text: raw.slice(1) };
  // Dong context bat dau bang ' '; dong rong trong diff cung la context
  // (git viet dong context rong thanh dong trong, khong co tien to).
  if (marker === ' ' || raw === '') return { type: 'context', text: marker === ' ' ? raw.slice(1) : '' };
  // Dong la (vd `\ No newline...`) khong phai dong noi dung — goi la
  // context de caller xu ly rieng; truong hop nay khong xay ra vi
  // caller loc dong `\` truoc.
  return { type: 'context', text: raw };
}

/**
 * Parse unified diff text thanh CodingV5Patch. Diff sai dinh dang
 * (hunk header khong doc duoc, dong thua) thi throw CodingV5PatchError
 * co vi tri dong de de debug.
 */
export function parseCodingV5Diff(diffText: string): CodingV5Patch {
  const lines = diffText.split('\n');
  const files: CodingV5FileDiff[] = [];
  let current: CodingV5FileDiff | null = null;
  let currentHunk: CodingV5Hunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;

  const finishHunk = (): void => {
    currentHunk = null;
  };
  const finishFile = (): void => {
    if (current) {
      current.additions = current.hunks.reduce((s, h) => s + h.additions, 0);
      current.deletions = current.hunks.reduce((s, h) => s + h.deletions, 0);
      files.push(current);
    }
    current = null;
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    // Dong cuoi cung cua split khi text ket thuc bang \n la '' — bo.
    if (i === lines.length - 1 && raw === '') break;

    const gitMatch = DIFF_GIT_RE.exec(raw) ?? DIFF_GIT_QUOTED_RE.exec(raw);
    if (gitMatch) {
      finishFile();
      const oldPath = unquoteGitPath(gitMatch[1] ?? '').replace(/^a\//, '');
      const newPath = unquoteGitPath(gitMatch[2] ?? '').replace(/^b\//, '');
      current = {
        index: files.length,
        oldPath,
        newPath,
        status: 'modified',
        isNewFile: false,
        isDeletedFile: false,
        extraHeaders: [raw],
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    // Ngoai block `diff --git`: chi chap nhan diff bat dau bang ---/+++
    // (mot so tool sinh diff khong co header diff --git).
    if (!current) {
      if (raw.startsWith('--- ')) {
        const oldPath = raw.slice(4).trim().replace(/^a\//, '').replace(/\t.*$/, '');
        current = {
          index: files.length,
          oldPath: oldPath === '/dev/null' ? '' : oldPath,
          newPath: '',
          status: 'modified',
          isNewFile: false,
          isDeletedFile: false,
          extraHeaders: [],
          hunks: [],
          additions: 0,
          deletions: 0,
        };
        continue;
      }
      if (raw.trim() === '') continue;
      throw new CodingV5PatchError(`Dong ${i + 1}: dong ngoai diff khong hieu duoc: "${raw.slice(0, 80)}".`);
    }

    if (raw.startsWith('Binary files ') && raw.includes(' differ')) {
      current.status = 'binary';
      current.extraHeaders.push(raw);
      continue;
    }
    if (raw.startsWith('new file mode')) {
      current.isNewFile = true;
      current.status = 'added';
      current.extraHeaders.push(raw);
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.isDeletedFile = true;
      current.status = 'deleted';
      current.extraHeaders.push(raw);
      continue;
    }
    if (raw.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = raw.slice('rename from '.length).trim();
      current.extraHeaders.push(raw);
      continue;
    }
    if (raw.startsWith('rename to ')) {
      current.newPath = raw.slice('rename to '.length).trim();
      current.extraHeaders.push(raw);
      continue;
    }
    if (
      raw.startsWith('similarity index') ||
      raw.startsWith('index ') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode')
    ) {
      current.extraHeaders.push(raw);
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4).trim().replace(/^a\//, '').replace(/\t.*$/, '');
      if (p === '/dev/null') {
        current.isNewFile = true;
        current.status = 'added';
      } else {
        current.oldPath = p;
      }
      current.extraHeaders.push(raw);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim().replace(/^b\//, '').replace(/\t.*$/, '');
      if (p === '/dev/null') {
        current.isDeletedFile = true;
        current.status = 'deleted';
      } else {
        current.newPath = p;
      }
      current.extraHeaders.push(raw);
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(raw);
    if (hunkMatch) {
      finishHunk();
      const oldStart = Number(hunkMatch[1]);
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3]);
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      oldLineNo = oldStart;
      newLineNo = newStart;
      currentHunk = {
        id: `${current.index}:${current.hunks.length}`,
        header: raw,
        sectionHeading: (hunkMatch[5] ?? '').trim(),
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
        additions: 0,
        deletions: 0,
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (raw.startsWith('\\ ')) {
      // `\ No newline at end of file`: danh dau dong truoc do.
      if (currentHunk && currentHunk.lines.length > 0) {
        const last = currentHunk.lines[currentHunk.lines.length - 1];
        if (last) last.noNewline = true;
      }
      continue;
    }

    if (!currentHunk) {
      // Dong nam giua header file va hunk dau tien — bo qua neu trong.
      if (raw.trim() === '') continue;
      throw new CodingV5PatchError(
        `Dong ${i + 1}: dong noi dung nam ngoai hunk: "${raw.slice(0, 80)}".`,
      );
    }

    const { type, text } = parseDiffLine(raw);
    const line: CodingV5DiffLine = {
      type,
      text,
      oldLineNo: type === 'add' ? null : oldLineNo,
      newLineNo: type === 'del' ? null : newLineNo,
      noNewline: false,
    };
    if (type !== 'add') oldLineNo += 1;
    if (type !== 'del') newLineNo += 1;
    if (type === 'add') currentHunk.additions += 1;
    if (type === 'del') currentHunk.deletions += 1;
    currentHunk.lines.push(line);
  }

  finishFile();
  // File khong co hunk (vd binary) van giu lai; file rong thi bo.
  const kept = files.filter((f) => f.hunks.length > 0 || f.status === 'binary');
  const additions = kept.reduce((s, f) => s + f.additions, 0);
  const deletions = kept.reduce((s, f) => s + f.deletions, 0);
  return { files: kept, additions, deletions, isEmpty: kept.length === 0 };
}

/** So dong context cua hunk (dung de kiem tra hunk tach rieng co apply duoc). */
export function codingV5HunkContextLines(hunk: CodingV5Hunk): number {
  return hunk.lines.filter((l) => l.type === 'context').length;
}

/** Tom tat mot hunk: file, vi tri, +n/-n, tieu de section. */
export function summarizeCodingV5Hunk(file: CodingV5FileDiff, hunk: CodingV5Hunk): string {
  const where = `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`;
  const section = hunk.sectionHeading ? ` ${hunk.sectionHeading}` : '';
  return `${file.newPath || file.oldPath} ${where} (+${hunk.additions}/-${hunk.deletions})${section}`;
}

/** Tom tat mot patch: file, hunk, +/-, trang thai tung file. */
export function summarizeCodingV5Patch(patch: CodingV5Patch): string {
  if (patch.isEmpty) return 'Patch rong — khong co thay doi nao.';
  const hunkCount = patch.files.reduce((s, f) => s + f.hunks.length, 0);
  const lines = [
    `Patch: ${patch.files.length} file(s), ${hunkCount} hunk(s), +${patch.additions}/-${patch.deletions}.`,
  ];
  for (const file of patch.files) {
    const name = file.status === 'renamed' ? `${file.oldPath} -> ${file.newPath}` : file.newPath || file.oldPath;
    lines.push(`  ${file.status} ${name} (+${file.additions}/-${file.deletions}, ${file.hunks.length} hunk(s))`);
  }
  return lines.join('\n');
}

export interface CodingV5PreviewOptions {
  /** Tran ky tu cua preview (mac dinh 20_000). */
  maxChars?: number;
  /** So dong toi da moi hunk hien day du (vuot thi cat giua, mac dinh 120). */
  maxHunkLines?: number;
  /** Chi hien file/hunk nay (loc preview). */
  onlyFileIndex?: number;
  /** true = hien ca dong context; false = chi dong +/- (mac dinh true). */
  showContext?: boolean;
}

/**
 * Render preview text cua patch: danh sach file + tung hunk co so
 * dong, dau +/-, cat ngan khi vuot tran. Preview bi cat se ghi ro
 * "(... da cat, xem day du trong session)".
 */
export function renderCodingV5Preview(patch: CodingV5Patch, options: CodingV5PreviewOptions = {}): string {
  const maxChars = options.maxChars ?? CODING_V5_PREVIEW_MAX_CHARS;
  const maxHunkLines = options.maxHunkLines ?? CODING_V5_PREVIEW_MAX_HUNK_LINES;
  const showContext = options.showContext ?? true;
  const out: string[] = [summarizeCodingV5Patch(patch), ''];
  const files =
    options.onlyFileIndex !== undefined
      ? patch.files.filter((f) => f.index === options.onlyFileIndex)
      : patch.files;
  for (const file of files) {
    const name = file.status === 'renamed' ? `${file.oldPath} -> ${file.newPath}` : file.newPath || file.oldPath;
    out.push(`=== [${file.index}] ${file.status} ${name} (+${file.additions}/-${file.deletions}) ===`);
    for (const hunk of file.hunks) {
      out.push(`--- hunk ${hunk.id} ${hunk.header}`);
      const shown = hunk.lines.filter((l) => showContext || l.type !== 'context');
      const truncated = shown.length > maxHunkLines;
      const slice = truncated ? shown.slice(0, maxHunkLines) : shown;
      for (const line of slice) {
        const oldNo = line.oldLineNo === null ? '    ' : String(line.oldLineNo).padStart(4, ' ');
        const newNo = line.newLineNo === null ? '    ' : String(line.newLineNo).padStart(4, ' ');
        const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
        out.push(`${oldNo} ${newNo} ${marker}${line.text}${line.noNewline ? ' (no newline)' : ''}`);
      }
      if (truncated) {
        out.push(`... (da cat ${shown.length - maxHunkLines}/${shown.length} dong cua hunk ${hunk.id})`);
      }
    }
    out.push('');
  }
  let text = out.join('\n');
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n... (preview da cat o ${maxChars} ky tu — dung onlyFileIndex de xem tung file)`;
  }
  return text;
}

/** Tinh lai header hunk sau khi loc dong: `@@ -a,b +c,d @@ heading`. */
function rebuildHunkHeader(
  hunk: CodingV5Hunk,
  lines: CodingV5DiffLine[],
  oldStart: number,
  newStart: number,
): string {
  const oldCount = lines.filter((l) => l.type !== 'add').length;
  const newCount = lines.filter((l) => l.type !== 'del').length;
  const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  const heading = hunk.sectionHeading ? ` ${hunk.sectionHeading}` : '';
  return `@@ -${oldPart} +${newPart} @@${heading}`;
}

/**
 * Dung lai unified diff chi gom hunk da chon (theo id `file:hunk`).
 * Moi file: giu header goc (`diff --git`, `---`/`+++`, new/deleted
 * mode...), chi giu hunk duoc chon; hunk duoc tinh lai so dong va so
 * dong bat dau theo dong context con lai. File khong con hunk nao
 * duoc chon thi bo khoi patch.
 *
 * Luu y: hunk duoc chon van giu nguyen dong context cua no, nen
 * `git apply` thuong thanh cong ngay ca khi hunk ke truoc bi bo —
 * tru khi hai hunk chong lan vung context.
 */
export function filterCodingV5Patch(patch: CodingV5Patch, approvedHunkIds: ReadonlySet<string>): CodingV5Patch {
  const files: CodingV5FileDiff[] = [];
  for (const file of patch.files) {
    if (file.status === 'binary') continue; // Binary khong loc theo hunk.
    const keptHunks: CodingV5Hunk[] = [];
    for (const hunk of file.hunks) {
      if (!approvedHunkIds.has(hunk.id)) continue;
      keptHunks.push(hunk);
    }
    if (keptHunks.length === 0) continue;
    const additions = keptHunks.reduce((s, h) => s + h.additions, 0);
    const deletions = keptHunks.reduce((s, h) => s + h.deletions, 0);
    files.push({ ...file, hunks: keptHunks, additions, deletions });
  }
  return {
    files,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    isEmpty: files.length === 0,
  };
}

/** Serialize mot CodingV5Patch thanh unified diff text (de `git apply`). */
export function serializeCodingV5Patch(patch: CodingV5Patch): string {
  const out: string[] = [];
  for (const file of patch.files) {
    if (file.status === 'binary') {
      out.push(...file.extraHeaders);
      continue;
    }
    // Header `diff --git` luon co trong extraHeaders[0] neu parse tu
    // git; neu patch tu tao tay (khong co header) thi tu dung.
    const hasDiffGit = file.extraHeaders.some((h) => h.startsWith('diff --git '));
    if (!hasDiffGit) {
      out.push(`diff --git a/${file.oldPath} b/${file.newPath}`);
    }
    for (const header of file.extraHeaders) {
      if (header.startsWith('diff --git ')) {
        out.push(header);
        continue;
      }
      // Bo dong `---`/`+++` cu — viet lai ben duoi cho khop file moi.
      if (header.startsWith('--- ') || header.startsWith('+++ ')) continue;
      out.push(header);
    }
    const oldLabel = file.isNewFile ? '/dev/null' : `a/${file.oldPath}`;
    const newLabel = file.isDeletedFile ? '/dev/null' : `b/${file.newPath}`;
    out.push(`--- ${oldLabel}`);
    out.push(`+++ ${newLabel}`);
    for (const hunk of file.hunks) {
      out.push(rebuildHunkHeader(hunk, hunk.lines, hunk.oldStart, hunk.newStart));
      for (const line of hunk.lines) {
        const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
        out.push(`${marker}${line.text}`);
        if (line.noNewline) out.push('\\ No newline at end of file');
      }
    }
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

export interface CodingV5PatchSessionOptions {
  /** Repo root de apply (bat buoc khi apply, khong can khi chi preview). */
  repoRoot?: string;
}

/**
 * Phien duyet patch: giu patch goc + tap hunk da duyet, cho duyet
 * tung hunk, duyet tat ca, bo duyet, roi xuat patch da loc de apply.
 * Session chi giu trang thai trong bo nho — host luu lai neu can
 * ben vung (xem patchHistory).
 */
export class CodingV5PatchSession {
  readonly patch: CodingV5Patch;
  readonly repoRoot: string | null;
  private readonly approved = new Set<string>();
  private readonly rejected = new Set<string>();
  readonly createdAt: string;

  constructor(diffText: string, options: CodingV5PatchSessionOptions = {}) {
    this.patch = parseCodingV5Diff(diffText);
    this.repoRoot = options.repoRoot ? options.repoRoot : null;
    this.createdAt = new Date().toISOString();
  }

  /** Tat ca id hunk trong patch. */
  allHunkIds(): string[] {
    return this.patch.files.flatMap((f) => f.hunks.map((h) => h.id));
  }

  approvedHunkIds(): string[] {
    return this.allHunkIds().filter((id) => this.approved.has(id));
  }

  rejectedHunkIds(): string[] {
    return this.allHunkIds().filter((id) => this.rejected.has(id));
  }

  pendingHunkIds(): string[] {
    return this.allHunkIds().filter((id) => !this.approved.has(id) && !this.rejected.has(id));
  }

  /** Duyet mot hunk (id `file:hunk`). Id khong ton tai thi throw. */
  approveHunk(hunkId: string): void {
    this.requireHunkExists(hunkId);
    this.approved.add(hunkId);
    this.rejected.delete(hunkId);
  }

  /** Tu choi mot hunk (id `file:hunk`). Id khong ton tai thi throw. */
  rejectHunk(hunkId: string): void {
    this.requireHunkExists(hunkId);
    this.rejected.add(hunkId);
    this.approved.delete(hunkId);
  }

  /** Duyet tat ca hunk. */
  approveAll(): void {
    for (const id of this.allHunkIds()) {
      this.approved.add(id);
      this.rejected.delete(id);
    }
  }

  /** Bo duyet tat ca (ve trang thai cho duyet). */
  resetDecisions(): void {
    this.approved.clear();
    this.rejected.clear();
  }

  /** true khi moi hunk da co quyet dinh (duyet hoac tu choi). */
  get allDecided(): boolean {
    return this.pendingHunkIds().length === 0;
  }

  /** Patch chi gom hunk da duyet (rong neu chua duyet hunk nao). */
  approvedPatch(): CodingV5Patch {
    return filterCodingV5Patch(this.patch, this.approved);
  }

  /** Unified diff text cua hunk da duyet (de `git apply`). */
  approvedDiffText(): string {
    return serializeCodingV5Patch(this.approvedPatch());
  }

  /** Tom tat trang thai duyet: da duyet/tu choi/cho. */
  decisionSummary(): string {
    const total = this.allHunkIds().length;
    return (
      `Duyet patch: ${this.approved.size}/${total} hunk(s) da duyet, ` +
      `${this.rejected.size} tu choi, ${this.pendingHunkIds().length} cho duyet ` +
      `(+${this.approvedPatch().additions}/-${this.approvedPatch().deletions} neu apply).`
    );
  }

  /** Preview text (loc theo file neu can). */
  preview(options: CodingV5PreviewOptions = {}): string {
    return renderCodingV5Preview(this.patch, options);
  }

  /**
   * Apply hunk da duyet vao repo. Can repoRoot (truyen luc tao
   * session hoac qua tham so). Luon `--check` truoc qua git session.
   */
  async applyApproved(options: { repoRoot?: string } = {}): Promise<{ filesAffected: number; hunksApplied: number }> {
    const repoRoot = options.repoRoot ?? this.repoRoot;
    if (!repoRoot) {
      throw new CodingV5GitError('Khong co repoRoot de apply patch.', 'apply');
    }
    const approved = this.approvedPatch();
    if (approved.isEmpty) {
      throw new CodingV5PatchError('Chua duyet hunk nao — khong co gi de apply.');
    }
    const session = new CodingV5GitSession(repoRoot);
    const diffText = serializeCodingV5Patch(approved);
    const result = await session.applyPatch(diffText);
    return { filesAffected: result.filesAffected, hunksApplied: approved.files.reduce((s, f) => s + f.hunks.length, 0) };
  }

  private requireHunkExists(hunkId: string): void {
    if (!this.allHunkIds().includes(hunkId)) {
      throw new CodingV5PatchError(`Khong co hunk "${hunkId}" trong patch.`);
    }
  }
}

/** Dinh dang file JSON luu phien duyet patch (de khoi phuc sau restart). */
export interface CodingV5PatchReviewFile {
  version: 1;
  /** Unified diff goc (de dung lai patch day du khi khoi phuc). */
  diffText: string;
  approvedHunkIds: string[];
  rejectedHunkIds: string[];
  repoRoot: string | null;
  createdAt: string;
  savedAt: string;
}

export const CODING_V5_PATCH_REVIEW_VERSION = 1;

/**
 * Luu phien duyet patch xuong dia (JSON): ca diff goc + quyet dinh
 * duyet/tu choi tung hunk. Host goi khi user tam dung giua chung
 * (vd dong app truoc khi duyet xong) de khoi phuc sau.
 */
export function saveCodingV5PatchReview(filePath: string, session: CodingV5PatchSession): string {
  const resolved = path.resolve(filePath);
  const file: CodingV5PatchReviewFile = {
    version: CODING_V5_PATCH_REVIEW_VERSION,
    diffText: serializeCodingV5Patch(session.patch),
    approvedHunkIds: session.approvedHunkIds(),
    rejectedHunkIds: session.rejectedHunkIds(),
    repoRoot: session.repoRoot,
    createdAt: session.createdAt,
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(file, null, 2), 'utf8');
  return resolved;
}

/**
 * Khoi phuc phien duyet patch tu file JSON (diff + quyet dinh duyet).
 * File khong co/hong/sai dinh dang thi throw CodingV5PatchError co ly
 * do ro rang — host bao user chon patch moi thay vi crash.
 */
export function loadCodingV5PatchReview(filePath: string): CodingV5PatchSession {
  const resolved = path.resolve(filePath);
  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch {
    throw new CodingV5PatchError(`Khong doc duoc file phien duyet patch: ${resolved}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodingV5PatchError(`File phien duyet patch hong (JSON loi): ${resolved}.`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodingV5PatchError(`File phien duyet patch sai dinh dang: ${resolved}.`);
  }
  const obj = parsed as Partial<CodingV5PatchReviewFile>;
  if (obj.version !== CODING_V5_PATCH_REVIEW_VERSION) {
    throw new CodingV5PatchError(
      `File phien duyet patch version khong ho tro: ${String(obj.version)} (can ${CODING_V5_PATCH_REVIEW_VERSION}).`,
    );
  }
  if (typeof obj.diffText !== 'string' || obj.diffText.trim() === '') {
    throw new CodingV5PatchError(`File phien duyet patch thieu diffText: ${resolved}.`);
  }
  const session = new CodingV5PatchSession(obj.diffText, {
    repoRoot: typeof obj.repoRoot === 'string' ? obj.repoRoot : undefined,
  });
  // Khoi phuc quyet dinh; hunk id khong con trong patch (diff da doi)
  // thi bo qua va ghi vao danh sach bo qua de host bao user.
  const skipped: string[] = [];
  for (const id of Array.isArray(obj.approvedHunkIds) ? obj.approvedHunkIds : []) {
    if (typeof id !== 'string') continue;
    try {
      session.approveHunk(id);
    } catch {
      skipped.push(id);
    }
  }
  for (const id of Array.isArray(obj.rejectedHunkIds) ? obj.rejectedHunkIds : []) {
    if (typeof id !== 'string') continue;
    try {
      session.rejectHunk(id);
    } catch {
      skipped.push(id);
    }
  }
  if (skipped.length > 0) {
    // Ghi chu vao session qua thuoc tinh mo rong (khong throw — patch
    // van dung duoc, chi mat mot phan quyet dinh cu).
    (session as unknown as { skippedHunkIdsOnLoad?: string[] }).skippedHunkIdsOnLoad = skipped;
  }
  return session;
}
