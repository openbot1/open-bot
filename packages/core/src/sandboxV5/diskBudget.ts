/**
 * Sandbox v5 — disk budget, cache reclaim, gitignored shed (v1.37, Team T3).
 *
 * The sandbox tree has a disk budget with a safety headroom:
 * usable budget = total budget − headroom. When usage passes
 * the usable budget, the reclaimer frees space in this order:
 *
 *   1. Cache entries under the configured cache roots, picked
 *      by policy — oldest-first (by mtime), least-used-first
 *      (by atime), or largest-first. Cache data is
 *      regenerable by definition; deleting it never loses
 *      user work.
 *   2. Gitignored directories under the workspace roots
 *      (node_modules, dist, build, .cache, coverage…): a
 *      directory is shed only when a `.gitignore` (or the
 *      built-in well-known list) actually matches it AND the
 *      tree is still over budget after the cache reclaim.
 *      User files are never shed: only directories whose
 *      whole subtree is gitignored, and never anything
 *      outside the configured roots.
 *
 * Every step is plannable first (dry-run): `planReclaim`
 * returns exactly what would be removed and how many bytes it
 * would free, without touching disk. `executeReclaim` runs a
 * plan (or builds one) and logs every removal to the reclaim
 * log (`reclaim.jsonl`, append-only) — what was removed, when,
 * why, and how many bytes it freed.
 *
 * Safety:
 *  - The reclaimer refuses to delete anything outside the
 *    configured roots (fail-closed: a cache root or workspace
 *    root that is not under the sandbox base is rejected at
 *    construction).
 *  - The headroom is never spent: a plan stops as soon as the
 *    tree is back under the usable budget, and a plan that
 *    cannot free enough says so (`enough: false`) instead of
 *    deleting everything in sight.
 *  - Deletions are best-effort per item: a failure removes
 *    that item from the result's `removed` list and records
 *    it in `failed` — one stubborn file never aborts the
 *    whole reclaim.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  defaultSandboxV5DiskBudget,
  type SandboxV5CacheEntry,
  type SandboxV5CacheRoot,
  type SandboxV5DiskBudget,
  type SandboxV5DiskStatus,
  type SandboxV5ReclaimItem,
  type SandboxV5ReclaimLogEntry,
  type SandboxV5ReclaimPlan,
  type SandboxV5ReclaimPolicy,
  type SandboxV5ReclaimResult,
} from './types';

export const SANDBOX_V5_RECLAIM_LOG_FILE = 'reclaim.jsonl';

/** Default base dir: OS temp dir / open-bot-sandbox-v5. */
export function defaultSandboxV5DiskBaseDir(): string {
  return path.join(os.tmpdir(), 'open-bot-sandbox-v5');
}

/**
 * Directory names that are gitignored in practice in almost
 * every JS/TS project. They are shed only when a `.gitignore`
 * actually matches them OR when the caller opts into the
 * built-in list (see `shedGitignoredDirs`).
 */
export const SANDBOX_V5_WELL_KNOWN_GITIGNORED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '__pycache__',
  '.venv',
  'target',
];

/** One parsed .gitignore line (pattern + negation + dir-only + anchored). */
export interface SandboxV5GitignoreRule {
  /** Original pattern text (without `!` / trailing `/`). */
  pattern: string;
  /** True when the rule is a negation (`!pattern`). */
  negated: boolean;
  /** True when the rule matches directories only (trailing `/`). */
  dirOnly: boolean;
  /** True when the pattern is anchored to the gitignore's directory. */
  anchored: boolean;
}

/** Parse .gitignore text into rules (comments + blanks skipped). */
export function parseSandboxV5Gitignore(text: string): SandboxV5GitignoreRule[] {
  const rules: SandboxV5GitignoreRule[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith('/')) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern === '') continue;
    let anchored = false;
    if (pattern.startsWith('/')) {
      anchored = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes('/')) {
      anchored = true;
    }
    rules.push({ pattern, negated, dirOnly, anchored });
  }
  return rules;
}

/** Match one path segment against a glob segment (`*`, `?`, `**` handled by caller). */
function matchSegment(pattern: string, name: string): boolean {
  // Convert a single-segment glob to a RegExp.
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  re += '$';
  return new RegExp(re).test(name);
}

/** Match a full gitignore pattern (with `**`) against a relative posix path. */
function matchGitignorePattern(pattern: string, relPath: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = relPath.split('/');
  const matchFrom = (pi: number, si: number): boolean => {
    if (pi === patternParts.length) return si === pathParts.length;
    const part = patternParts[pi] as string;
    if (part === '**') {
      // `**` matches zero or more segments.
      for (let skip = 0; skip <= pathParts.length - si; skip += 1) {
        if (matchFrom(pi + 1, si + skip)) return true;
      }
      return false;
    }
    if (si >= pathParts.length) return false;
    if (!matchSegment(part, pathParts[si] as string)) return false;
    return matchFrom(pi + 1, si + 1);
  };
  return matchFrom(0, 0);
}

/**
 * Does a relative path match a gitignore rule? `isDir` matters
 * for dir-only rules. Unanchored patterns match at any depth
 * (a trailing segment match also counts: `node_modules` matches
 * `a/b/node_modules`).
 */
export function sandboxV5GitignoreRuleMatches(
  rule: SandboxV5GitignoreRule,
  relPath: string,
  isDir: boolean,
): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.anchored) return matchGitignorePattern(rule.pattern, relPath);
  // Unanchored: try the pattern at every depth, and also as a
  // trailing-segment match (so `node_modules` matches any depth).
  const parts = relPath.split('/');
  for (let start = 0; start < parts.length; start += 1) {
    const sub = parts.slice(start).join('/');
    if (matchGitignorePattern(rule.pattern, sub)) return true;
  }
  return false;
}

/** Is a relative path ignored by a rule set (last matching rule wins)? */
export function sandboxV5PathIgnored(
  rules: SandboxV5GitignoreRule[],
  relPath: string,
  isDir: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (sandboxV5GitignoreRuleMatches(rule, relPath, isDir)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

/** Load the .gitignore rules of a directory (empty when there is none). */
export function loadSandboxV5GitignoreRules(dir: string): SandboxV5GitignoreRule[] {
  try {
    return parseSandboxV5Gitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Inspect one cache child: size + newest mtime/atime. For a
 * directory the times come from the FILES inside it (newest
 * content = last write / last use) — not from the directory
 * entry itself, whose mtime/atime only track entry creation
 * and are bumped by the reclaimer's own directory reads under
 * relatime. Reading a directory never updates a file's atime,
 * so these times are stable across scans. An empty directory
 * falls back to its own stat.
 */
export function inspectSandboxV5CacheChild(
  full: string,
  isDirectory: boolean,
): { sizeBytes: number; mtimeMs: number; atimeMs: number } {
  const stat = fs.statSync(full);
  if (!isDirectory) {
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, atimeMs: stat.atimeMs };
  }
  let sizeBytes = 0;
  let mtimeMs = 0;
  let atimeMs = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        try {
          const childStat = fs.statSync(child);
          sizeBytes += childStat.size;
          mtimeMs = Math.max(mtimeMs, childStat.mtimeMs);
          atimeMs = Math.max(atimeMs, childStat.atimeMs);
        } catch {
          // Vanished mid-walk — skip.
        }
      }
    }
  };
  walk(full);
  if (mtimeMs === 0) {
    // Empty directory: fall back to its own times.
    return { sizeBytes, mtimeMs: stat.mtimeMs, atimeMs: stat.atimeMs };
  }
  return { sizeBytes, mtimeMs, atimeMs };
}

/** Total bytes of files under a directory (recursive, no symlink follow). */
export function sandboxV5DiskDirSizeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Vanished mid-walk — skip.
        }
      }
    }
  };
  walk(root);
  return total;
}

/** Read the reclaim log back (for audits / tests). */
export function readSandboxV5ReclaimLog(baseDir: string): SandboxV5ReclaimLogEntry[] {
  const file = path.join(baseDir, SANDBOX_V5_RECLAIM_LOG_FILE);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const out: SandboxV5ReclaimLogEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as SandboxV5ReclaimLogEntry);
      } catch {
        // Torn last line — skip.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface SandboxV5DiskBudgetOptions {
  /** Base dir of the sandbox tree (default: OS temp / open-bot-sandbox-v5). */
  baseDir?: string;
  /** Budget policy (defaults applied for missing fields). */
  budget?: Partial<SandboxV5DiskBudget>;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/**
 * Disk budget manager for one sandbox tree. All roots must be
 * under the base dir — a root outside it is rejected at
 * construction, so the reclaimer can never delete host files.
 */
export class SandboxV5DiskBudgetManager {
  readonly baseDir: string;
  private readonly budget: SandboxV5DiskBudget;
  private readonly nowMs: () => number;

  constructor(options: SandboxV5DiskBudgetOptions = {}) {
    this.baseDir = options.baseDir ?? defaultSandboxV5DiskBaseDir();
    const defaults = defaultSandboxV5DiskBudget();
    this.budget = {
      totalBudgetBytes: options.budget?.totalBudgetBytes ?? defaults.totalBudgetBytes,
      headroomBytes: options.budget?.headroomBytes ?? defaults.headroomBytes,
      cacheRoots: [...(options.budget?.cacheRoots ?? [])],
      workspaceRoots: [...(options.budget?.workspaceRoots ?? [])],
      idleThresholdMs: options.budget?.idleThresholdMs ?? defaults.idleThresholdMs,
    };
    this.nowMs = options.nowMs ?? Date.now;
    for (const root of this.budget.cacheRoots) {
      this.requireUnderBase(root.path, `cache root "${root.path}"`);
    }
    for (const root of this.budget.workspaceRoots) {
      this.requireUnderBase(root, `workspace root "${root}"`);
    }
    if (this.budget.headroomBytes < 0) throw new Error('headroomBytes must not be negative.');
    if (this.budget.totalBudgetBytes <= 0) throw new Error('totalBudgetBytes must be positive.');
    if (this.budget.headroomBytes >= this.budget.totalBudgetBytes) {
      throw new Error('headroomBytes must be smaller than totalBudgetBytes — the headroom is never spent.');
    }
  }

  /** The budget policy in force. */
  policy(): SandboxV5DiskBudget {
    return {
      ...this.budget,
      cacheRoots: this.budget.cacheRoots.map((root) => ({ ...root })),
      workspaceRoots: [...this.budget.workspaceRoots],
    };
  }

  /** Bytes the tree may use before the usable budget is hit. */
  usableBudgetBytes(): number {
    return this.budget.totalBudgetBytes - this.budget.headroomBytes;
  }

  private requireUnderBase(target: string, label: string): void {
    const resolvedBase = path.resolve(this.baseDir);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
      throw new Error(`${label} is outside the sandbox base dir "${this.baseDir}" — refusing to manage it.`);
    }
  }

  private log(entry: Omit<SandboxV5ReclaimLogEntry, 'seq'>): void {
    const existing = readSandboxV5ReclaimLog(this.baseDir);
    const full: SandboxV5ReclaimLogEntry = { seq: existing.length + 1, ...entry };
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.appendFileSync(path.join(this.baseDir, SANDBOX_V5_RECLAIM_LOG_FILE), `${JSON.stringify(full)}\n`, 'utf8');
  }

  /** Measure the tree: total / cache / workspace / archive bytes + budget status. */
  status(): SandboxV5DiskStatus {
    const now = this.nowMs();
    let cacheBytes = 0;
    for (const root of this.budget.cacheRoots) {
      cacheBytes += sandboxV5DiskDirSizeBytes(root.path);
    }
    let workspaceBytes = 0;
    for (const root of this.budget.workspaceRoots) {
      workspaceBytes += sandboxV5DiskDirSizeBytes(root);
    }
    const archiveDir = path.join(this.baseDir, 'archives');
    const archiveBytes = fs.existsSync(archiveDir) ? sandboxV5DiskDirSizeBytes(archiveDir) : 0;
    const usedBytes = sandboxV5DiskDirSizeBytes(this.baseDir);
    const usable = this.usableBudgetBytes();
    const overBudgetBytes = usedBytes - usable;
    return {
      baseDir: this.baseDir,
      budget: this.policy(),
      usedBytes,
      cacheBytes,
      workspaceBytes,
      archiveBytes,
      overBudgetBytes,
      overBudget: overBudgetBytes > 0,
      remainingBytes: Math.max(0, usable - usedBytes),
      measuredAtMs: now,
    };
  }

  /** Scan one cache root into entries (top-level children only — one entry per child). */
  scanCacheRoot(root: SandboxV5CacheRoot, now?: number): SandboxV5CacheEntry[] {
    const nowMs = now ?? this.nowMs();
    const out: SandboxV5CacheEntry[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      const full = path.join(root.path, entry.name);
      try {
        const isDirectory = entry.isDirectory();
        const inspected = inspectSandboxV5CacheChild(full, isDirectory);
        out.push({
          path: full,
          kind: root.kind,
          isDirectory,
          sizeBytes: inspected.sizeBytes,
          mtimeMs: inspected.mtimeMs,
          atimeMs: inspected.atimeMs,
          ageMs: Math.max(0, nowMs - inspected.mtimeMs),
        });
      } catch {
        // Vanished mid-scan — skip.
      }
    }
    return out;
  }

  /** All cache entries across all roots. */
  scanCaches(now?: number): SandboxV5CacheEntry[] {
    const out: SandboxV5CacheEntry[] = [];
    for (const root of this.budget.cacheRoots) {
      out.push(...this.scanCacheRoot(root, now));
    }
    return out;
  }

  /** Sort cache entries by a reclaim policy (first = reclaim first). */
  sortForReclaim(entries: SandboxV5CacheEntry[], policy: SandboxV5ReclaimPolicy): SandboxV5CacheEntry[] {
    const sorted = [...entries];
    switch (policy) {
      case 'oldest-first':
        sorted.sort((a, b) => a.mtimeMs - b.mtimeMs);
        break;
      case 'least-used-first':
        sorted.sort((a, b) => (a.atimeMs || a.mtimeMs) - (b.atimeMs || b.mtimeMs));
        break;
      case 'largest-first':
        sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
        break;
    }
    return sorted;
  }

  /**
   * Find gitignored directories under the workspace roots.
   * A directory is shed-candidate when a `.gitignore` in its
   * workspace root ignores it, or when its name is on the
   * well-known list AND `includeWellKnown` is set. Nested
   * gitignores are honoured: a `.gitignore` in a subdirectory
   * applies to paths under that subdirectory.
   */
  findGitignoredDirs(options: { includeWellKnown?: boolean; now?: number } = {}): SandboxV5ReclaimItem[] {
    const nowMs = options.now ?? this.nowMs();
    const includeWellKnown = options.includeWellKnown ?? false;
    const out: SandboxV5ReclaimItem[] = [];
    for (const root of this.budget.workspaceRoots) {
      const rootRules = loadSandboxV5GitignoreRules(root);
      const walk = (dir: string, rel: string, rules: SandboxV5GitignoreRule[]): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        // A .gitignore in this directory extends the rules below it.
        let activeRules = rules;
        const gitignoreEntry = entries.find((e) => e.isFile() && e.name === '.gitignore');
        if (gitignoreEntry) {
          try {
            activeRules = [...rules, ...parseSandboxV5Gitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'))];
          } catch {
            // Unreadable .gitignore — keep the parent rules.
          }
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
          const ignoredByRules = sandboxV5PathIgnored(activeRules, relPath, true);
          const wellKnown =
            includeWellKnown && SANDBOX_V5_WELL_KNOWN_GITIGNORED_DIRS.includes(entry.name);
          if (ignoredByRules || wellKnown) {
            let sizeBytes = 0;
            let mtimeMs = 0;
            try {
              // Age/size come from the FILES inside the dir (newest
              // content = last use) — the directory entry's own
              // mtime only tracks entry creation, so two generated
              // dirs created seconds apart would sort arbitrarily.
              const inspected = inspectSandboxV5CacheChild(full, true);
              sizeBytes = inspected.sizeBytes;
              mtimeMs = inspected.mtimeMs;
            } catch {
              // Vanished — skip.
              continue;
            }
            out.push({
              path: full,
              kind: 'gitignored-dir',
              cacheKind: '',
              sizeBytes,
              ageMs: Math.max(0, nowMs - mtimeMs),
              reason: ignoredByRules
                ? `gitignored under "${root}" (${relPath})`
                : `well-known gitignored dir "${entry.name}"`,
            });
            // Do not descend into a shed-candidate: the whole
            // subtree goes with it.
            continue;
          }
          walk(full, relPath, activeRules);
        }
      };
      walk(root, '', rootRules);
    }
    // Oldest first: the least-recently-touched generated dirs go first.
    out.sort((a, b) => b.ageMs - a.ageMs);
    return out;
  }

  /**
   * Dry-run plan: what would be reclaimed to get back under the
   * usable budget, without touching disk. Cache first (by each
   * root's policy), then gitignored dirs (oldest first). When
   * the tree is already under budget the plan is empty.
   */
  planReclaim(options: { includeWellKnownGitignored?: boolean; now?: number } = {}): SandboxV5ReclaimPlan {
    const nowMs = options.now ?? this.nowMs();
    const current = this.status();
    const needBytes = Math.max(0, current.overBudgetBytes);
    const items: SandboxV5ReclaimItem[] = [];
    if (needBytes === 0) {
      return {
        budget: this.policy(),
        needBytes: 0,
        items,
        wouldFreeBytes: 0,
        enough: true,
        stillOverBytes: 0,
        plannedAtMs: nowMs,
      };
    }
    let freed = 0;
    // 1. Caches, per-root policy order.
    const cacheEntries = this.scanCaches(nowMs);
    const byRoot = new Map<string, SandboxV5CacheEntry[]>();
    for (const entry of cacheEntries) {
      const list = byRoot.get(entry.kind) ?? [];
      list.push(entry);
      byRoot.set(entry.kind, list);
    }
    const orderedCache: SandboxV5CacheEntry[] = [];
    for (const root of this.budget.cacheRoots) {
      orderedCache.push(...this.sortForReclaim(byRoot.get(root.kind) ?? [], root.policy));
    }
    for (const entry of orderedCache) {
      if (freed >= needBytes) break;
      items.push({
        path: entry.path,
        kind: 'cache',
        cacheKind: entry.kind,
        sizeBytes: entry.sizeBytes,
        ageMs: entry.ageMs,
        reason: `cache "${entry.kind}" reclaimed (${entry.isDirectory ? 'dir' : 'file'})`,
      });
      freed += entry.sizeBytes;
    }
    // 2. Gitignored dirs, oldest first — only while still over.
    if (freed < needBytes) {
      for (const dir of this.findGitignoredDirs({ includeWellKnown: options.includeWellKnownGitignored ?? false, now: nowMs })) {
        if (freed >= needBytes) break;
        items.push(dir);
        freed += dir.sizeBytes;
      }
    }
    return {
      budget: this.policy(),
      needBytes,
      items,
      wouldFreeBytes: freed,
      enough: freed >= needBytes,
      stillOverBytes: Math.max(0, needBytes - freed),
      plannedAtMs: nowMs,
    };
  }

  /**
   * Execute a reclaim plan (build one when not given). Returns
   * what was actually removed, what failed, and whether the
   * tree is back under budget. Every removal is logged.
   */
  executeReclaim(plan?: SandboxV5ReclaimPlan): SandboxV5ReclaimResult {
    const effective = plan ?? this.planReclaim();
    const now = this.nowMs();
    const removed: SandboxV5ReclaimItem[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    let freedBytes = 0;
    for (const item of effective.items) {
      try {
        // Fail-closed: refuse anything outside the base dir,
        // even if a stale plan says otherwise.
        this.requireUnderBase(item.path, `reclaim item "${item.path}"`);
        fs.rmSync(item.path, { recursive: true, force: true });
        removed.push(item);
        freedBytes += item.sizeBytes;
        this.log({
          atMs: now,
          event: 'removed',
          path: item.path,
          kind: item.kind,
          freedBytes: item.sizeBytes,
          reason: item.reason,
        });
      } catch (err) {
        failed.push({ path: item.path, reason: (err as Error).message });
        this.log({
          atMs: now,
          event: 'failed',
          path: item.path,
          kind: item.kind,
          freedBytes: 0,
          reason: (err as Error).message,
        });
      }
    }
    const after = this.status();
    return {
      removed,
      failed,
      freedBytes,
      stillOverBytes: Math.max(0, after.overBudgetBytes),
      backUnderBudget: !after.overBudget,
      executedAtMs: now,
    };
  }
}
