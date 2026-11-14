/**
 * Line diff for the memory-blocks editor (v1.08, Team T5).
 *
 * Renderer-local, pure functions: given two versions of a block's
 * content, produce a line-by-line diff (`same` / `add` / `del`)
 * the editor renders with +/- colours, plus a summary and a
 * Markdown rendering for copy/export. No dependency on the core
 * memory modules — the editor receives version snapshots through
 * its own `MemoryBlockHistoryProvider` interface (the T1 memory-v9
 * history API plugs in there when it lands; until then the editor
 * reads the on-disk history through `memory-blocks:history`).
 *
 * Algorithm: classic LCS dynamic programming over lines. Block
 * contents are capped at 2000 chars per line in the store and
 * rarely exceed a few hundred lines, so the O(n·m) table is
 * cheap; past 2000 lines on either side the diff degrades to a
 * whole-block replace (all `del` + all `add`) instead of
 * allocating a huge table — still correct, just coarse.
 * Unit-tested with plain node --test (see tests/voice-v108.test.mjs).
 */

/** One diff row. */
export type MemoryBlockDiffLineType = 'same' | 'add' | 'del';

export interface MemoryBlockDiffLine {
  type: MemoryBlockDiffLineType;
  text: string;
  /** 1-based line number in the old text (same/del only). */
  oldLineNo: number | null;
  /** 1-based line number in the new text (same/add only). */
  newLineNo: number | null;
}

/** Counts for a diff. */
export interface MemoryBlockDiffSummary {
  added: number;
  deleted: number;
  unchanged: number;
  /** True when the diff is a coarse whole-block replace (see header). */
  coarse: boolean;
}

/** Line cap for the exact LCS diff (past it, whole-block replace). */
export const MEMORY_BLOCK_DIFF_MAX_LINES = 2000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Line-by-line diff of two texts. Empty vs empty is an empty diff;
 * identical texts are all `same`. Line numbers are 1-based.
 */
export function diffLines(oldText: string, newText: string): MemoryBlockDiffLine[] {
  const oldLines = splitLines(oldText ?? '');
  const newLines = splitLines(newText ?? '');
  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldText === newText) {
    return oldLines.map((text, i) => ({ type: 'same', text, oldLineNo: i + 1, newLineNo: i + 1 }));
  }
  if (oldLines.length > MEMORY_BLOCK_DIFF_MAX_LINES || newLines.length > MEMORY_BLOCK_DIFF_MAX_LINES) {
    return [
      ...oldLines.map((text, i) => ({ type: 'del' as const, text, oldLineNo: i + 1, newLineNo: null })),
      ...newLines.map((text, i) => ({ type: 'add' as const, text, oldLineNo: null, newLineNo: i + 1 })),
    ];
  }
  // LCS table: dp[i][j] = LCS length of oldLines[i..] and newLines[j..].
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const out: MemoryBlockDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: 'same', text: oldLines[i]!, oldLineNo: i + 1, newLineNo: j + 1 });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ type: 'del', text: oldLines[i]!, oldLineNo: i + 1, newLineNo: null });
      i += 1;
    } else {
      out.push({ type: 'add', text: newLines[j]!, oldLineNo: null, newLineNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: oldLines[i]!, oldLineNo: i + 1, newLineNo: null });
    i += 1;
  }
  while (j < m) {
    out.push({ type: 'add', text: newLines[j]!, oldLineNo: null, newLineNo: j + 1 });
    j += 1;
  }
  return out;
}

/** Count added / deleted / unchanged rows in a diff. */
export function diffSummary(diff: readonly MemoryBlockDiffLine[]): MemoryBlockDiffSummary {
  let added = 0;
  let deleted = 0;
  let unchanged = 0;
  let seenSame = false;
  for (const row of diff) {
    if (row.type === 'add') added += 1;
    else if (row.type === 'del') deleted += 1;
    else {
      unchanged += 1;
      seenSame = true;
    }
  }
  // Coarse = a whole-block replace: no `same` row at all but both
  // sides non-empty (the LCS path always keeps at least the
  // shared lines, so a diff with zero `same` rows came from the
  // >2000-line fallback — or from two texts with nothing in
  // common, which the summary caller can tell apart by the counts).
  const coarse = !seenSame && added > 0 && deleted > 0;
  return { added, deleted, unchanged, coarse };
}

/** One-line summary of a diff: "+3 −2 · 10 unchanged". */
export function diffSummaryText(summary: MemoryBlockDiffSummary): string {
  return `+${summary.added} −${summary.deleted} · ${summary.unchanged} unchanged`;
}

/** Render a diff as Markdown (unified-ish: ` ` / `+` / `-` prefixes). */
export function diffToMarkdown(diff: readonly MemoryBlockDiffLine[]): string {
  const out: string[] = ['```diff'];
  for (const row of diff) {
    const prefix = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
    out.push(`${prefix} ${row.text}`);
  }
  out.push('```');
  return out.join('\n');
}

/**
 * Group a diff into hunks of changed lines with `context` lines
 * of surrounding `same` rows (like unified diff). A hunk is a
 * run of rows where at least one row is `add`/`del`. Returns the
 * hunks in order; an all-`same` diff returns no hunks.
 */
export function diffHunks(
  diff: readonly MemoryBlockDiffLine[],
  context = 3,
): MemoryBlockDiffLine[][] {
  const hunks: MemoryBlockDiffLine[][] = [];
  let current: MemoryBlockDiffLine[] = [];
  let pendingSame: MemoryBlockDiffLine[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      hunks.push(current);
      current = [];
    }
    pendingSame = [];
  };
  for (const row of diff) {
    if (row.type === 'same') {
      if (current.length === 0) {
        // Leading context before the first change in this hunk.
        pendingSame.push(row);
        if (pendingSame.length > context) pendingSame.shift();
        continue;
      }
      pendingSame.push(row);
      if (pendingSame.length > context) {
        // Context ran out — the hunk ends here.
        current.push(...pendingSame.slice(0, context));
        flush();
        pendingSame = pendingSame.slice(context);
      }
      continue;
    }
    if (pendingSame.length > 0) {
      // The gap was within context (the 'same' branch flushes
      // past `context`), so the hunk continues — or this is the
      // leading context of the first hunk.
      current.push(...pendingSame);
      pendingSame = [];
    }
    current.push(row);
  }
  if (current.length > 0) {
    current.push(...pendingSame.slice(0, context));
    hunks.push(current);
  }
  return hunks;
}
