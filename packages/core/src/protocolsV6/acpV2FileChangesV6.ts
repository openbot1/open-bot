/**
 * ACP v2 draft — structured file changes (v1.37, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md: the ACP v2 draft replaces the v1
 * oldText/newText diff with structured file changes — a change
 * proposal names the file, the kind of change (create / update /
 * delete / rename) and a list of hunks, and the client applies
 * or rejects each hunk on its own. This runs in PARALLEL with
 * ACP v1: a v1 peer keeps sending oldText/newText diffs and this
 * module never touches them.
 *
 * This module is the open-bot implementation, built from scratch:
 *   - `AcpV6FileStore` — an in-memory file snapshot the host
 *     preloads (path -> content). The host owns the real disk;
 *     this store is the preview / apply surface, so a change can
 *     be previewed and rolled back before anything is written.
 *   - `AcpV6FileChangeSet` — propose a structured change, preview
 *     the result of each hunk without applying it, apply or reject
 *     hunks one by one, detect conflicts (a hunk's expected
 *     lines no longer match the file), and roll back applied
 *     hunks from the journal.
 *   - Every change links to the ACP session and, when it came
 *     from a prompt turn, to the user message id that produced it
 *     (`session/prompt` returns a message id in v6), so the UI
 *     can show "this edit came from message X".
 *
 * Safety: paths are confined to the store (absolute paths and
 * `..` segments are refused), a hunk never applies when its
 * expected-before lines do not match (conflict, not silent
 * overwrite), and every applied hunk is journaled with the
 * previous content so it can be rolled back.
 * No code, text or asset from any other repo is copied here.
 */

/** Kind of a structured file change. */
export type AcpV6FileChangeKind = 'create' | 'update' | 'delete' | 'rename';
export const ACP_V6_FILE_CHANGE_KINDS: readonly AcpV6FileChangeKind[] = [
  'create',
  'update',
  'delete',
  'rename',
];

/** One structured line operation inside a hunk. */
export type AcpV6LineOp =
  | { op: 'insert'; afterLine: number; lines: string[] }
  | { op: 'delete'; startLine: number; endLine: number; expectedBefore: string[] }
  | { op: 'replace'; startLine: number; endLine: number; lines: string[]; expectedBefore: string[] };

/** Lifecycle of one hunk. */
export type AcpV6HunkStatus = 'proposed' | 'applied' | 'rejected' | 'conflicted';
export const ACP_V6_HUNK_STATUSES: readonly AcpV6HunkStatus[] = [
  'proposed',
  'applied',
  'rejected',
  'conflicted',
];

/** One hunk: a list of line ops applied as a unit. */
export interface AcpV6Hunk {
  hunkId: string;
  /** Human-readable summary of what this hunk does. */
  summary: string;
  ops: AcpV6LineOp[];
  status: AcpV6HunkStatus;
  /** Why a hunk was rejected or conflicted. */
  reason?: string;
  appliedAt?: number;
}

/** One structured file change proposal. */
export interface AcpV6FileChange {
  changeId: string;
  sessionId: string;
  /** User message id that produced this change (v6 prompt return). Omit when out-of-turn. */
  messageId?: string;
  path: string;
  kind: AcpV6FileChangeKind;
  /** New path for a rename. */
  newPath?: string;
  /** Full content for a create. */
  content?: string;
  hunks: AcpV6Hunk[];
  status: 'proposed' | 'partially-applied' | 'applied' | 'rejected' | 'conflicted';
  createdAt: number;
  updatedAt: number;
}

/** Error raised by structured file change operations. */
export class AcpV6FileChangeError extends Error {
  readonly code:
    | 'invalid-path'
    | 'unknown-change'
    | 'unknown-hunk'
    | 'hunk-not-proposed'
    | 'conflict'
    | 'invalid-op'
    | 'file-exists'
    | 'file-missing'
    | 'nothing-to-rollback';
  constructor(message: string, code: AcpV6FileChangeError['code']) {
    super(message);
    this.name = 'AcpV6FileChangeError';
    this.code = code;
  }
}

export interface AcpV6FileChangeOptions {
  /** Clock override (tests). */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: (prefix: string) => string;
}

let acpV6FileCounter = 0;
function defaultAcpV6FileId(prefix: string): string {
  acpV6FileCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${acpV6FileCounter.toString(36)}`;
}

/** Reject absolute paths and `..` escapes — the store is one rooted tree. */
export function isAcpV6SafePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '')) return false;
  return true;
}

function requireSafePath(path: string): void {
  if (!isAcpV6SafePath(path)) {
    throw new AcpV6FileChangeError(
      `Unsafe file path "${path}": absolute paths and ".." segments are refused.`,
      'invalid-path',
    );
  }
}

function splitLines(content: string): string[] {
  if (content === '') return [];
  return content.split('\n');
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

/**
 * Validate one line op against the current line count.
 * Returns an error string, or null when the op is well-formed.
 */
export function validateAcpV6LineOp(op: AcpV6LineOp, lineCount: number): string | null {
  if (op.op === 'insert') {
    if (!Number.isInteger(op.afterLine) || op.afterLine < 0 || op.afterLine > lineCount) {
      return `insert afterLine ${op.afterLine} is out of range (0..${lineCount}).`;
    }
    if (!Array.isArray(op.lines) || op.lines.length === 0) return 'insert needs at least one line.';
    if (op.lines.some((l) => typeof l !== 'string')) return 'insert lines must be strings.';
    return null;
  }
  if (!Number.isInteger(op.startLine) || !Number.isInteger(op.endLine)) {
    return `${op.op} needs integer startLine/endLine.`;
  }
  if (op.startLine < 1 || op.endLine < op.startLine || op.endLine > lineCount) {
    return `${op.op} range ${op.startLine}..${op.endLine} is out of range (1..${lineCount}).`;
  }
  if (!Array.isArray(op.expectedBefore) || op.expectedBefore.length !== op.endLine - op.startLine + 1) {
    return `${op.op} expectedBefore must list exactly ${op.endLine - op.startLine + 1} line(s).`;
  }
  if (op.op === 'replace') {
    if (!Array.isArray(op.lines) || op.lines.some((l) => typeof l !== 'string')) {
      return 'replace lines must be an array of strings.';
    }
  }
  return null;
}

/** Apply one validated op to a line array; returns the new lines. */
export function applyAcpV6LineOp(lines: string[], op: AcpV6LineOp): string[] {
  const out = [...lines];
  if (op.op === 'insert') {
    out.splice(op.afterLine, 0, ...op.lines);
    return out;
  }
  // delete / replace: check the expected-before lines first.
  const actual = out.slice(op.startLine - 1, op.endLine);
  for (let i = 0; i < op.expectedBefore.length; i += 1) {
    if (actual[i] !== op.expectedBefore[i]) {
      throw new AcpV6FileChangeError(
        `Hunk conflict at line ${op.startLine + i}: expected ${JSON.stringify(op.expectedBefore[i])} but the file has ${JSON.stringify(actual[i])}.`,
        'conflict',
      );
    }
  }
  if (op.op === 'delete') {
    out.splice(op.startLine - 1, op.endLine - op.startLine + 1);
    return out;
  }
  out.splice(op.startLine - 1, op.endLine - op.startLine + 1, ...op.lines);
  return out;
}

/** Lines added / removed by one op (for the preview summary). */
export function acpV6LineOpDelta(op: AcpV6LineOp): { added: number; removed: number } {
  if (op.op === 'insert') return { added: op.lines.length, removed: 0 };
  if (op.op === 'delete') return { added: 0, removed: op.endLine - op.startLine + 1 };
  return { added: op.lines.length, removed: op.endLine - op.startLine + 1 };
}

/** Lines added / removed by one hunk. */
export function acpV6HunkDelta(hunk: AcpV6Hunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of hunk.ops) {
    const d = acpV6LineOpDelta(op);
    added += d.added;
    removed += d.removed;
  }
  return { added, removed };
}

/** In-memory file snapshot: the preview / apply surface for structured changes. */
export class AcpV6FileStore {
  private readonly files = new Map<string, string>();

  /** Preload one file (host mirrors the real disk here). */
  put(path: string, content: string): void {
    requireSafePath(path);
    this.files.set(path, content);
  }

  get(path: string): string | undefined {
    return this.files.get(path);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  delete(path: string): boolean {
    return this.files.delete(path);
  }

  /** All stored paths, sorted. */
  list(): string[] {
    return [...this.files.keys()].sort();
  }

  /** A deep copy of the whole store (snapshot for rollback / tests). */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  restore(snapshot: Record<string, string>): void {
    this.files.clear();
    for (const [path, content] of Object.entries(snapshot)) {
      if (isAcpV6SafePath(path)) this.files.set(path, content);
    }
  }

  get size(): number {
    return this.files.size;
  }
}

/** One journal entry: what an applied hunk changed, for rollback. */
export interface AcpV6JournalEntry {
  changeId: string;
  hunkId: string;
  path: string;
  /** Content before the hunk (undefined = file did not exist). */
  previousContent: string | undefined;
  /** Content after the hunk (undefined = file was deleted). */
  nextContent: string | undefined;
  appliedAt: number;
}

export interface AcpV6ProposeChangeInput {
  sessionId: string;
  messageId?: string;
  path: string;
  kind: AcpV6FileChangeKind;
  newPath?: string;
  content?: string;
  hunks?: { summary: string; ops: AcpV6LineOp[] }[];
}

/** Preview of one hunk: the resulting content without applying it. */
export interface AcpV6HunkPreview {
  hunkId: string;
  status: AcpV6HunkStatus;
  /** Resulting file content if this hunk were applied now (undefined when it cannot apply). */
  resultingContent: string | undefined;
  added: number;
  removed: number;
  /** Why the hunk cannot apply (conflict / invalid op), when present. */
  reason?: string;
}

/**
 * Structured file changes for one ACP v2 session set. Proposals
 * are validated, previewed, applied hunk-by-hunk (or rejected),
 * and journaled so applied hunks can be rolled back in reverse
 * order. Nothing here writes to disk — the host mirrors the
 * store to disk after apply / rollback.
 */
export class AcpV6FileChangeSet {
  private readonly changes = new Map<string, AcpV6FileChange>();
  private readonly journal: AcpV6JournalEntry[] = [];
  private readonly store: AcpV6FileStore;
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;

  constructor(store: AcpV6FileStore, options: AcpV6FileChangeOptions = {}) {
    this.store = store;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultAcpV6FileId;
  }

  getStore(): AcpV6FileStore {
    return this.store;
  }

  /** Propose a structured change. Validates paths, kinds and ops up front. */
  propose(input: AcpV6ProposeChangeInput): AcpV6FileChange {
    requireSafePath(input.path);
    if (!ACP_V6_FILE_CHANGE_KINDS.includes(input.kind)) {
      throw new AcpV6FileChangeError(`Unknown file change kind "${input.kind}".`, 'invalid-op');
    }
    if (input.kind === 'rename') {
      if (!input.newPath) throw new AcpV6FileChangeError('A rename needs newPath.', 'invalid-op');
      requireSafePath(input.newPath);
      if (input.newPath === input.path) {
        throw new AcpV6FileChangeError('A rename needs a different newPath.', 'invalid-op');
      }
      if (!this.store.has(input.path)) {
        throw new AcpV6FileChangeError(`Cannot rename missing file "${input.path}".`, 'file-missing');
      }
    }
    if (input.kind === 'create') {
      if (this.store.has(input.path)) {
        throw new AcpV6FileChangeError(`Cannot create "${input.path}": the file already exists.`, 'file-exists');
      }
      if (typeof input.content !== 'string') {
        throw new AcpV6FileChangeError('A create needs content.', 'invalid-op');
      }
    }
    if (input.kind === 'update' && !this.store.has(input.path)) {
      throw new AcpV6FileChangeError(`Cannot update missing file "${input.path}".`, 'file-missing');
    }
    if (input.kind === 'delete' && !this.store.has(input.path)) {
      throw new AcpV6FileChangeError(`Cannot delete missing file "${input.path}".`, 'file-missing');
    }
    const at = this.now();
    const hunks: AcpV6Hunk[] = (input.hunks ?? []).map((h) => {
      if (!Array.isArray(h.ops) || h.ops.length === 0) {
        throw new AcpV6FileChangeError('Each hunk needs at least one line op.', 'invalid-op');
      }
      return {
        hunkId: this.generateId('acp-hunk'),
        summary: h.summary,
        ops: h.ops.map((op) => ({ ...op })),
        status: 'proposed' as const,
      };
    });
    // A create / delete / rename carries its effect in the kind,
    // not in hunks; an update with no hunks is a no-op proposal.
    const change: AcpV6FileChange = {
      changeId: this.generateId('acp-change'),
      sessionId: input.sessionId,
      messageId: input.messageId,
      path: input.path,
      kind: input.kind,
      newPath: input.newPath,
      content: input.content,
      hunks,
      status: 'proposed',
      createdAt: at,
      updatedAt: at,
    };
    this.changes.set(change.changeId, change);
    return this.copyChange(change);
  }

  private copyChange(change: AcpV6FileChange): AcpV6FileChange {
    return {
      ...change,
      hunks: change.hunks.map((h) => ({ ...h, ops: h.ops.map((op) => ({ ...op })) })),
    };
  }

  get(changeId: string): AcpV6FileChange | undefined {
    const change = this.changes.get(changeId);
    return change ? this.copyChange(change) : undefined;
  }

  require(changeId: string): AcpV6FileChange {
    const change = this.changes.get(changeId);
    if (!change) throw new AcpV6FileChangeError(`Unknown file change "${changeId}".`, 'unknown-change');
    return change;
  }

  list(sessionId?: string): AcpV6FileChange[] {
    const all = [...this.changes.values()].sort((a, b) => b.createdAt - a.createdAt);
    return (sessionId ? all.filter((c) => c.sessionId === sessionId) : all).map((c) => this.copyChange(c));
  }

  private refreshStatus(change: AcpV6FileChange): void {
    const statuses = change.hunks.map((h) => h.status);
    if (change.kind !== 'update' && change.hunks.length === 0) return; // kind-level change keeps its own status
    if (statuses.length === 0) return;
    if (statuses.every((s) => s === 'applied')) change.status = 'applied';
    else if (statuses.every((s) => s === 'rejected')) change.status = 'rejected';
    else if (statuses.some((s) => s === 'applied')) change.status = 'partially-applied';
    else if (statuses.some((s) => s === 'conflicted')) change.status = 'conflicted';
    else change.status = 'proposed';
    change.updatedAt = this.now();
  }

  /** Preview one hunk: resulting content + delta, without applying it. */
  previewHunk(changeId: string, hunkId: string): AcpV6HunkPreview {
    const change = this.require(changeId);
    const hunk = change.hunks.find((h) => h.hunkId === hunkId);
    if (!hunk) throw new AcpV6FileChangeError(`Unknown hunk "${hunkId}".`, 'unknown-hunk');
    const delta = acpV6HunkDelta(hunk);
    const current = this.store.get(change.path);
    if (current === undefined) {
      return { hunkId, status: 'conflicted', resultingContent: undefined, ...delta, reason: `File "${change.path}" is missing from the store.` };
    }
    let lines = splitLines(current);
    try {
      for (const op of hunk.ops) {
        const problem = validateAcpV6LineOp(op, lines.length);
        if (problem) return { hunkId, status: 'conflicted', resultingContent: undefined, ...delta, reason: problem };
        lines = applyAcpV6LineOp(lines, op);
      }
    } catch (err) {
      if (err instanceof AcpV6FileChangeError && err.code === 'conflict') {
        return { hunkId, status: 'conflicted', resultingContent: undefined, ...delta, reason: err.message };
      }
      throw err;
    }
    return { hunkId, status: hunk.status, resultingContent: joinLines(lines), ...delta };
  }

  /** Preview a whole change: one preview per hunk. */
  previewChange(changeId: string): AcpV6HunkPreview[] {
    const change = this.require(changeId);
    return change.hunks.map((h) => this.previewHunk(changeId, h.hunkId));
  }

  /**
   * Apply one hunk. The hunk must still be proposed; its
   * expected-before lines must match the file, or it is marked
   * conflicted and nothing is written.
   */
  applyHunk(changeId: string, hunkId: string): { applied: boolean; reason?: string } {
    const change = this.require(changeId);
    const hunk = change.hunks.find((h) => h.hunkId === hunkId);
    if (!hunk) throw new AcpV6FileChangeError(`Unknown hunk "${hunkId}".`, 'unknown-hunk');
    if (hunk.status !== 'proposed') {
      throw new AcpV6FileChangeError(`Hunk "${hunkId}" is ${hunk.status}, not proposed.`, 'hunk-not-proposed');
    }
    const preview = this.previewHunk(changeId, hunkId);
    if (preview.resultingContent === undefined) {
      hunk.status = 'conflicted';
      hunk.reason = preview.reason;
      this.refreshStatus(change);
      return { applied: false, reason: preview.reason };
    }
    const previous = this.store.get(change.path);
    this.store.put(change.path, preview.resultingContent);
    hunk.status = 'applied';
    hunk.appliedAt = this.now();
    this.journal.push({
      changeId,
      hunkId,
      path: change.path,
      previousContent: previous,
      nextContent: preview.resultingContent,
      appliedAt: this.now(),
    });
    this.refreshStatus(change);
    return { applied: true };
  }

  /** Reject one hunk (it will never apply). */
  rejectHunk(changeId: string, hunkId: string, reason?: string): void {
    const change = this.require(changeId);
    const hunk = change.hunks.find((h) => h.hunkId === hunkId);
    if (!hunk) throw new AcpV6FileChangeError(`Unknown hunk "${hunkId}".`, 'unknown-hunk');
    if (hunk.status !== 'proposed') {
      throw new AcpV6FileChangeError(`Hunk "${hunkId}" is ${hunk.status}, not proposed.`, 'hunk-not-proposed');
    }
    hunk.status = 'rejected';
    if (reason) hunk.reason = reason;
    this.refreshStatus(change);
  }

  /**
   * Apply every still-proposed hunk of a change, in order.
   * Conflicted hunks are skipped (marked conflicted) and the
   * rest still apply — the caller sees exactly what happened.
   */
  applyAll(changeId: string): { applied: string[]; conflicted: string[] } {
    const change = this.require(changeId);
    const applied: string[] = [];
    const conflicted: string[] = [];
    for (const hunk of [...change.hunks]) {
      if (hunk.status !== 'proposed') continue;
      const result = this.applyHunk(changeId, hunk.hunkId);
      if (result.applied) applied.push(hunk.hunkId);
      else conflicted.push(hunk.hunkId);
    }
    return { applied, conflicted };
  }

  /**
   * Apply the kind-level effect of a create / delete / rename
   * change (no hunks). Updates are hunk-only and return false.
   */
  applyKind(changeId: string): { applied: boolean; reason?: string } {
    const change = this.require(changeId);
    if (change.kind === 'update') return { applied: false, reason: 'Updates apply hunk by hunk, not as a whole.' };
    if (change.status === 'applied') return { applied: false, reason: 'Change already applied.' };
    const at = this.now();
    if (change.kind === 'create') {
      const previous = this.store.get(change.path);
      this.store.put(change.path, change.content ?? '');
      this.journal.push({ changeId, hunkId: '', path: change.path, previousContent: previous, nextContent: change.content ?? '', appliedAt: at });
    } else if (change.kind === 'delete') {
      const previous = this.store.get(change.path);
      if (previous === undefined) return { applied: false, reason: `File "${change.path}" is already gone.` };
      this.store.delete(change.path);
      this.journal.push({ changeId, hunkId: '', path: change.path, previousContent: previous, nextContent: undefined, appliedAt: at });
    } else {
      // rename
      const previous = this.store.get(change.path);
      if (previous === undefined) return { applied: false, reason: `File "${change.path}" is missing.` };
      if (this.store.has(change.newPath as string)) {
        return { applied: false, reason: `Rename target "${change.newPath}" already exists.` };
      }
      this.store.delete(change.path);
      this.store.put(change.newPath as string, previous);
      this.journal.push({ changeId, hunkId: '', path: change.path, previousContent: previous, nextContent: previous, appliedAt: at });
    }
    change.status = 'applied';
    change.updatedAt = at;
    return { applied: true };
  }

  /** Roll back the most recent applied journal entry (LIFO). */
  rollbackLast(): AcpV6JournalEntry | null {
    const entry = this.journal.pop();
    if (!entry) return null;
    if (entry.previousContent === undefined) this.store.delete(entry.path);
    else this.store.put(entry.path, entry.previousContent);
    // A rename journal entry also needs its target removed.
    const change = this.changes.get(entry.changeId);
    if (change?.kind === 'rename' && entry.hunkId === '' && change.newPath && change.newPath !== entry.path) {
      this.store.delete(change.newPath);
    }
    if (change) {
      if (entry.hunkId) {
        const hunk = change.hunks.find((h) => h.hunkId === entry.hunkId);
        if (hunk) {
          hunk.status = 'proposed';
          delete hunk.appliedAt;
        }
      }
      this.refreshStatus(change);
      if (change.kind !== 'update') change.status = 'proposed';
      change.updatedAt = this.now();
    }
    return { ...entry };
  }

  /** Roll back every applied entry of one change (newest first). */
  rollbackChange(changeId: string): number {
    const entries = this.journal.filter((e) => e.changeId === changeId);
    let n = 0;
    for (let i = this.journal.length - 1; i >= 0; i -= 1) {
      if (this.journal[i]?.changeId === changeId) {
        this.journal.splice(i, 1);
        n += 1;
      }
    }
    // Re-apply the rollback in reverse apply order.
    for (const entry of [...entries].reverse()) {
      if (entry.previousContent === undefined) this.store.delete(entry.path);
      else this.store.put(entry.path, entry.previousContent);
    }
    const change = this.changes.get(changeId);
    if (change) {
      if (change.kind === 'rename' && change.newPath) this.store.delete(change.newPath);
      for (const hunk of change.hunks) {
        if (hunk.status === 'applied') {
          hunk.status = 'proposed';
          delete hunk.appliedAt;
        }
      }
      this.refreshStatus(change);
      if (change.kind !== 'update') change.status = 'proposed';
      change.updatedAt = this.now();
    }
    return n;
  }

  /** Journal entries, oldest first (copies). */
  getJournal(): AcpV6JournalEntry[] {
    return this.journal.map((e) => ({ ...e }));
  }

  /** Summary counts for the UI. */
  summary(): { changes: number; proposed: number; applied: number; rejected: number; conflicted: number; journalEntries: number } {
    let proposed = 0;
    let applied = 0;
    let rejected = 0;
    let conflicted = 0;
    for (const change of this.changes.values()) {
      for (const hunk of change.hunks) {
        if (hunk.status === 'proposed') proposed += 1;
        else if (hunk.status === 'applied') applied += 1;
        else if (hunk.status === 'rejected') rejected += 1;
        else conflicted += 1;
      }
      if (change.hunks.length === 0 && change.status === 'applied') applied += 1;
    }
    return { changes: this.changes.size, proposed, applied, rejected, conflicted, journalEntries: this.journal.length };
  }
}

/**
 * Convert a v1 oldText/newText diff into a v6 structured change
 * (best effort, for peers migrating from ACP v1): the diff
 * becomes one `replace` hunk spanning the matched lines. The
 * caller must supply the file's current lines so the hunk's
 * expectedBefore can be filled in; when oldText is not found,
 * the conversion reports a conflict instead of guessing.
 */
export function v1DiffToV6Change(
  sessionId: string,
  path: string,
  oldText: string,
  newText: string,
  currentContent: string,
): { ok: true; hunks: { summary: string; ops: AcpV6LineOp[] }[] } | { ok: false; reason: string } {
  const lines = splitLines(currentContent);
  const oldLines = splitLines(oldText);
  if (oldLines.length === 0) return { ok: false, reason: 'oldText is empty; nothing to match.' };
  let start = -1;
  for (let i = 0; i + oldLines.length <= lines.length; i += 1) {
    let match = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (lines[i + j] !== oldLines[j]) { match = false; break; }
    }
    if (match) { start = i; break; }
  }
  if (start === -1) return { ok: false, reason: 'oldText was not found in the current file content.' };
  return {
    ok: true,
    hunks: [
      {
        summary: `Replace ${oldLines.length} line(s) (converted from an ACP v1 diff).`,
        ops: [
          {
            op: 'replace',
            startLine: start + 1,
            endLine: start + oldLines.length,
            lines: splitLines(newText),
            expectedBefore: [...oldLines],
          },
        ],
      },
    ],
  };
}
