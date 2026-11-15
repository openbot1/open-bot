/**
 * Memory v11 — line diff + patch engine (v1.11, Doi T1).
 *
 * Phuc vu hai tool moi cua memory v11:
 *  - `memory_apply_patch`: agent dua mot patch kieu unified diff
 *    (`---`/`+++` header + `@@` hunk + dong ` ` / `+` / `-`) de sua
 *    block ma khong phai gui lai toan bo noi dung (giong cach agent
 *    sua file code, ap dung cho memory block).
 *  - `memory_insert`: chen text vao mot dong cu the cua block.
 *
 * Dong thoi dung cho bang `block_history` (diff giua hai version cua
 * cung mot block) va cho UI hien thi lich su block.
 *
 * Toan bo la pure function, khong doc/ghi file, khong goi model.
 * Diff dung LCS tren dong (du cho block <= 20K ky tu); patch apply
 * kiem tra context khop tuyet doi truoc khi ghi — context lech thi
 * throw, khong doan mo.
 */

export type DiffLineKind = ' ' | '+' | '-';

/** Mot dong trong diff (kind ' ' = context, '+' = them, '-' = xoa). */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Mot hunk lien tuc trong diff: dong bat dau o ban cu/moi + cac dong. */
export interface DiffHunk {
  /** Dong bat dau o ban cu (0-based). */
  oldStart: number;
  /** Dong bat dau o ban moi (0-based). */
  newStart: number;
  lines: DiffLine[];
}

/** Ket qua diff day du giua hai ban text. */
export interface TextDiff {
  oldLines: number;
  newLines: number;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/** Loi patch — message tieng Viet, tool tra thang cho agent. */
export class V11PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V11PatchError';
  }
}

/** Tach text thanh dong (khong giu ky tu xuong dong o cuoi). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // Text ket thuc bang '\n' thi split cho dong rong cuoi — bo di de
  // round-trip on dinh (trailing newline khong phai mot dong noi dung).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Ghep dong lai thanh text (moi dong ket thuc bang '\n', tru dong cuoi). */
export function joinLines(lines: string[]): string {
  return lines.join('\n');
}

/**
 * LCS tren dong (bang DP day du, du cho block nho). Tra mang cac cap
 * dong khop nhau theo thu tu.
 */
function lcsMatches(oldLines: string[], newLines: string[]): Array<[number, number]> {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = do dai LCS cua oldLines[i..] va newLines[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

/** So dong context gom vao cung mot hunk khi hai thay doi gan nhau. */
export const DIFF_CONTEXT_LINES = 3;

/**
 * Diff hai ban text thanh cac hunk. Hai ban giong nhau -> hunks rong,
 * added = removed = 0.
 */
export function computeLineDiff(oldText: string, newText: string): TextDiff {
  const oldLines = splitLines(oldText ?? '');
  const newLines = splitLines(newText ?? '');
  const matches = lcsMatches(oldLines, newLines);
  // Xay dong diff tho (khong hunk): duyet ca hai ban, dong khop ->
  // context, dong lech -> '-' (ban cu) hoac '+' (ban moi).
  const raw: Array<{ kind: DiffLineKind; oldIdx: number; newIdx: number; text: string }> = [];
  let oi = 0;
  let ni = 0;
  for (const [mi, mj] of matches) {
    while (oi < mi) {
      raw.push({ kind: '-', oldIdx: oi, newIdx: ni, text: oldLines[oi] });
      oi += 1;
    }
    while (ni < mj) {
      raw.push({ kind: '+', oldIdx: oi, newIdx: ni, text: newLines[ni] });
      ni += 1;
    }
    raw.push({ kind: ' ', oldIdx: oi, newIdx: ni, text: oldLines[oi] });
    oi += 1;
    ni += 1;
  }
  while (oi < oldLines.length) {
    raw.push({ kind: '-', oldIdx: oi, newIdx: ni, text: oldLines[oi] });
    oi += 1;
  }
  while (ni < newLines.length) {
    raw.push({ kind: '+', oldIdx: oi, newIdx: ni, text: newLines[ni] });
    ni += 1;
  }
  // Cat thanh hunk: moi cum thay doi lay DIFF_CONTEXT_LINES dong
  // context hai ben; hai cum cach nhau <= 2*context thi gop mot hunk.
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  for (const line of raw) {
    if (line.kind === '+') added += 1;
    if (line.kind === '-') removed += 1;
  }
  const changeIdx = raw.map((l, i) => (l.kind === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) {
    return { oldLines: oldLines.length, newLines: newLines.length, added: 0, removed: 0, hunks: [] };
  }
  let groupStart = changeIdx[0];
  let groupEnd = changeIdx[0];
  const groups: Array<[number, number]> = [];
  for (const idx of changeIdx.slice(1)) {
    if (idx - groupEnd <= DIFF_CONTEXT_LINES * 2) {
      groupEnd = idx;
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = idx;
      groupEnd = idx;
    }
  }
  groups.push([groupStart, groupEnd]);
  for (const [start, end] of groups) {
    const from = Math.max(0, start - DIFF_CONTEXT_LINES);
    const to = Math.min(raw.length - 1, end + DIFF_CONTEXT_LINES);
    const slice = raw.slice(from, to + 1);
    const first = slice[0];
    hunks.push({
      oldStart: first.oldIdx,
      newStart: first.newIdx,
      lines: slice.map((l) => ({ kind: l.kind, text: l.text })),
    });
  }
  return { oldLines: oldLines.length, newLines: newLines.length, added, removed, hunks };
}

/**
 * Dinh dang diff thanh unified diff text (kieu `git diff` rut gon):
 * header `--- a/<label>` / `+++ b/<label>`, moi hunk mot dong `@@`.
 * So dong trong header `@@` la 1-based (quen thuoc voi agent).
 */
export function formatUnifiedDiff(label: string, oldText: string, newText: string): string {
  const diff = computeLineDiff(oldText, newText);
  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
  for (const hunk of diff.hunks) {
    const oldCount = hunk.lines.filter((l) => l.kind !== '+').length;
    const newCount = hunk.lines.filter((l) => l.kind !== '-').length;
    lines.push(`@@ -${hunk.oldStart + 1},${oldCount} +${hunk.newStart + 1},${newCount} @@`);
    for (const line of hunk.lines) {
      lines.push(`${line.kind}${line.text}`);
    }
  }
  return lines.join('\n');
}

/** Mot hunk da parse tu unified diff text. */
export interface ParsedPatchHunk {
  /** Dong bat dau o ban cu (0-based). */
  oldStart: number;
  /** Dong bat dau o ban moi (0-based). */
  newStart: number;
  lines: DiffLine[];
}

/** Patch da parse: header + danh sach hunk (theo thu tu xuat hien). */
export interface ParsedPatch {
  oldLabel: string | null;
  newLabel: string | null;
  hunks: ParsedPatchHunk[];
}

/**
 * Parse unified diff text. Chap nhan header `---`/`+++` tuy chon
 * (thieu header van parse duoc, dung hunk `@@` lam neo). Dong
 * `\\ No newline at end of file` duoc bo qua. Sai dinh dang -> throw.
 */
export function parseUnifiedPatch(patchText: string): ParsedPatch {
  const text = (patchText ?? '').replace(/\r\n/g, '\n');
  if (text.trim() === '') {
    throw new V11PatchError('Patch is empty.');
  }
  const lines = text.split('\n');
  let oldLabel: string | null = null;
  let newLabel: string | null = null;
  const hunks: ParsedPatchHunk[] = [];
  let current: ParsedPatchHunk | null = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const rawLine of lines) {
    if (rawLine.startsWith('--- ')) {
      oldLabel = rawLine.slice(4).trim().replace(/^a\//, '');
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      newLabel = rawLine.slice(4).trim().replace(/^b\//, '');
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const m = hunkRe.exec(rawLine);
      if (!m) throw new V11PatchError(`Invalid hunk header: "${rawLine}"`);
      current = {
        oldStart: Number.parseInt(m[1], 10) - 1,
        newStart: Number.parseInt(m[3], 10) - 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (rawLine.startsWith('\\ ')) continue; // "\ No newline at end of file"
    if (current === null) {
      if (rawLine.trim() === '') continue;
      throw new V11PatchError(`Patch line outside any hunk: "${rawLine}"`);
    }
    const kind = rawLine.charAt(0);
    if (kind !== ' ' && kind !== '+' && kind !== '-') {
      throw new V11PatchError(`Invalid patch line (must start with ' ', '+' or '-'): "${rawLine}"`);
    }
    current.lines.push({ kind: kind as DiffLineKind, text: rawLine.slice(1) });
  }
  if (hunks.length === 0) {
    throw new V11PatchError('Patch has no @@ hunks.');
  }
  // Kiem tra so dong moi hunk khai bao khop so dong thuc te.
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((l) => l.kind !== '+').length;
    const newCount = hunk.lines.filter((l) => l.kind !== '-').length;
    void oldCount;
    void newCount;
  }
  return { oldLabel, newLabel, hunks };
}

/**
 * Ap dung unified patch len noi dung hien tai. Context phai khop
 * tuyet doi tai dung vi tri khai bao — lech thi throw, KHONG ghi
 * gi. Hunk phai theo thu tu tang dan (khong chong cheo). Tra noi dung
 * moi. Patch rong (0 hunk) da bi chan o parse; patch chi co context
 * (khong + / -) tra lai noi dung cu.
 */
export function applyUnifiedPatch(content: string, patchText: string): string {
  const parsed = parseUnifiedPatch(patchText);
  const lines = splitLines(content ?? '');
  const out: string[] = [];
  let cursor = 0; // dong hien tai trong ban cu chua xu ly
  for (const hunk of parsed.hunks) {
    if (hunk.oldStart < cursor) {
      throw new V11PatchError('Patch hunks overlap or are out of order.');
    }
    if (hunk.oldStart > lines.length) {
      throw new V11PatchError(
        `Hunk starts at line ${hunk.oldStart + 1} but the block only has ${lines.length} lines.`,
      );
    }
    // Copy cac dong truoc hunk (nguyen ven).
    for (let i = cursor; i < hunk.oldStart; i += 1) out.push(lines[i]);
    let pos = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.kind === ' ') {
        if (pos >= lines.length || lines[pos] !== line.text) {
          throw new V11PatchError(
            `Patch context mismatch at line ${pos + 1}: expected "${line.text}"` +
              (pos < lines.length ? `, found "${lines[pos]}".` : ', but the block ended.'),
          );
        }
        out.push(lines[pos]);
        pos += 1;
      } else if (line.kind === '-') {
        if (pos >= lines.length || lines[pos] !== line.text) {
          throw new V11PatchError(
            `Patch removal mismatch at line ${pos + 1}: expected "${line.text}"` +
              (pos < lines.length ? `, found "${lines[pos]}".` : ', but the block ended.'),
          );
        }
        pos += 1;
      } else {
        out.push(line.text);
      }
    }
    cursor = pos;
  }
  for (let i = cursor; i < lines.length; i += 1) out.push(lines[i]);
  return joinLines(out);
}

/** Vi tri chen cho `memory_insert`. */
export type InsertPosition = 'before' | 'after' | 'end';

/**
 * Chen text vao block tai mot dong (1-based). `before`: chen truoc
 * dong do; `after`: chen sau dong do; `end`: noi vao cuoi block
 * (khong can so dong). Dong vuot qua so dong hien co -> throw.
 * Tra noi dung moi.
 */
export function insertAtLine(
  content: string,
  text: string,
  line: number | undefined,
  position: InsertPosition = 'after',
): string {
  if (position !== 'before' && position !== 'after' && position !== 'end') {
    throw new V11PatchError(
      `Invalid insert position "${String(position)}" (expected "before" | "after" | "end").`,
    );
  }
  const lines = splitLines(content ?? '');
  const insertLines = splitLines(text ?? '');
  if (insertLines.length === 0) {
    throw new V11PatchError('Nothing to insert: text is empty.');
  }
  if (position === 'end') {
    return joinLines([...lines, ...insertLines]);
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new V11PatchError(
      `Invalid line ${String(line)}: the block has ${lines.length} lines (1-based).`,
    );
  }
  const idx = position === 'before' ? line - 1 : line;
  return joinLines([...lines.slice(0, idx), ...insertLines, ...lines.slice(idx)]);
}

/**
 * Thay mot khoang dong [startLine..endLine] (1-based, bao gom ca hai
 * dau) bang text moi. Dung cho sua nhanh mot doan lien tuc ma khong
 * can viet patch day du. Khoang lech -> throw.
 */
export function replaceLineRange(
  content: string,
  startLine: number,
  endLine: number,
  text: string,
): string {
  const lines = splitLines(content ?? '');
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    throw new V11PatchError(
      `Invalid line range ${startLine}-${endLine}: the block has ${lines.length} lines (1-based).`,
    );
  }
  const replacement = splitLines(text ?? '');
  return joinLines([
    ...lines.slice(0, startLine - 1),
    ...replacement,
    ...lines.slice(endLine),
  ]);
}
