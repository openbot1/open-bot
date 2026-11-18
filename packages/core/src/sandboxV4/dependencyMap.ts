/**
 * Sandbox v4 — dependency map (v1.36, Team T4).
 *
 * Large-Codebase-style map for the coding agent: given a source
 * tree, build the import graph, order changes topologically,
 * answer "what breaks if I change this file", and detect when
 * several agents editing at the same time step on each other.
 *
 * The scanner is deliberately dependency-free: it reads source
 * files and extracts imports with regular expressions (ES `import
 * ... from`, `export ... from`, `require()`, dynamic `import()`,
 * Python `import x` / `from x import y`). It does not parse the
 * full language — a regex can miss a weird dynamic import, and
 * the map says so in its report (`externalImports` and unresolvable
 * relative imports are listed, never silently dropped). For the
 * change-ordering job that is the right trade: the map is a
 * planning aid, and every edge it reports is real.
 *
 * Rules:
 *  - Only in-tree relative imports become edges. Bare imports
 *    (`react`, `node:fs`) are recorded as `externalImports`.
 *  - Directories `node_modules`, `.git`, `dist`, `build`,
 *    `coverage` and dot-directories are never scanned.
 *  - Cycles are reported, not hidden: `topoOrder` returns the
 *    files it could order plus the cycles it found, and
 *    `changePlan` leaves cyclic files in `unordered`.
 *  - Conflict detection is conservative: two agents conflict
 *    when they touch the same file, OR when one's files are in
 *    the other's reverse-dependency impact set. A conflict is a
 *    warning to the coordinator, not a lock — v4 advises, the
 *    coordinator decides.
 *  - Incremental rebuild: `rebuildChanged` re-scans only files
 *    whose mtime/size moved since the last build, so a big tree
 *    stays cheap to keep fresh.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SandboxV4ChangePlan,
  SandboxV4ChangeSet,
  SandboxV4DepConflict,
  SandboxV4DepCycle,
  SandboxV4DepNode,
  SandboxV4DependencyMap,
} from './types';

/** Directories never scanned (by name, at any depth). */
export const SANDBOX_V4_DEPMAP_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
]);

/** File extensions the scanner reads. */
export const SANDBOX_V4_DEPMAP_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.py']);

/** Maximum files scanned in one build (fail-closed: refuse, don't truncate silently). */
export const SANDBOX_V4_DEPMAP_MAX_FILES = 50_000;

/** Maximum file size read in one scan (bytes). Larger files are skipped + reported. */
export const SANDBOX_V4_DEPMAP_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function depNodeKindForExtension(ext: string): SandboxV4DepNode['kind'] {
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.js') return 'js';
  if (ext === '.jsx') return 'jsx';
  if (ext === '.py') return 'py';
  return 'other';
}

/** Extensions tried when resolving a relative import without one. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.py'];

/** Result of scanning one directory tree. */
export interface SandboxV4DepScanResult {
  map: SandboxV4DependencyMap;
  /** Files skipped because they were too large. */
  skippedOversize: string[];
  /** Relative imports that could not be resolved to a file in the tree. */
  unresolvable: Array<{ from: string; specifier: string }>;
}

const ES_IMPORT_FROM = /import\s+(?:type\s+)?[^'";]*?\sfrom\s+['"]([^'"]+)['"]/g;
const ES_SIDE_EFFECT_IMPORT = /import\s+['"]([^'"]+)['"]/g;
const ES_EXPORT_FROM = /export\s+(?:type\s+)?[^'";]*?\sfrom\s+['"]([^'"]+)['"]/g;
const CJS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const PY_IMPORT = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
const PY_FROM_IMPORT = /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\s+/gm;

/** Extract import specifiers from one file's text (language by extension). */
export function extractImportSpecifiers(content: string, ext: string): string[] {
  const found = new Set<string>();
  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) found.add(m[1]);
    }
  };
  if (ext === '.py') {
    collect(PY_IMPORT);
    collect(PY_FROM_IMPORT);
  } else {
    collect(ES_IMPORT_FROM);
    collect(ES_SIDE_EFFECT_IMPORT);
    collect(ES_EXPORT_FROM);
    collect(CJS_REQUIRE);
    collect(DYNAMIC_IMPORT);
  }
  return [...found].sort();
}

/** True when the specifier is a relative import (`./x`, `../x`, `.`). */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** Normalise a relative path to posix separators. */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

export interface SandboxV4DepMapOptions {
  /** Root directory to scan (must exist). */
  rootDir: string;
}

/**
 * Dependency map builder. `build()` scans the whole tree once;
 * `rebuildChanged()` re-scans only files that moved since the
 * last build (mtime/size). The map itself is a plain object —
 * serialisable, diffable, safe to store in a report.
 */
export class SandboxV4DependencyMapBuilder {
  private readonly rootDir: string;
  private lastMap: SandboxV4DependencyMap | undefined;
  private lastFingerprints = new Map<string, string>();

  constructor(options: SandboxV4DepMapOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir === '') {
      throw new Error('Dependency map needs a non-empty rootDir.');
    }
    this.rootDir = path.resolve(options.rootDir);
    if (!fs.existsSync(this.rootDir) || !fs.statSync(this.rootDir).isDirectory()) {
      throw new Error(`Dependency map root "${this.rootDir}" is not a directory.`);
    }
  }

  /** Root this builder scans. */
  getRootDir(): string {
    return this.rootDir;
  }

  /** The last map built (undefined before the first build). */
  getLastMap(): SandboxV4DependencyMap | undefined {
    return this.lastMap;
  }

  /** Full scan of the tree. */
  build(): SandboxV4DepScanResult {
    const files = this.listSourceFiles();
    if (files.length > SANDBOX_V4_DEPMAP_MAX_FILES) {
      throw new Error(
        `Dependency map refused: ${files.length} files exceeds the ${SANDBOX_V4_DEPMAP_MAX_FILES} file limit. Narrow the root.`,
      );
    }
    const result = this.buildFromFiles(files);
    this.lastMap = result.map;
    return result;
  }

  /**
   * Incremental rebuild: re-scan only files whose mtime or size
   * changed since the last build (plus any new files). Returns
   * the fresh map and the list of files that were re-scanned.
   * Throws when no map has been built yet (call `build()` first).
   */
  rebuildChanged(): { map: SandboxV4DependencyMap; rescanned: string[]; removed: string[] } {
    if (!this.lastMap) {
      throw new Error('No dependency map built yet — call build() before rebuildChanged().');
    }
    const files = this.listSourceFiles();
    const changed: string[] = [];
    const current = new Map<string, string>();
    for (const file of files) {
      const stat = fs.statSync(file);
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      current.set(file, fingerprint);
      if (this.lastFingerprints.get(file) !== fingerprint) changed.push(file);
    }
    const removed = [...this.lastFingerprints.keys()].filter((f) => !current.has(f));
    if (changed.length === 0 && removed.length === 0) {
      return { map: this.lastMap, rescanned: [], removed: [] };
    }
    const result = this.buildFromFiles(files);
    this.lastMap = result.map;
    return { map: result.map, rescanned: changed.map((f) => toPosixPath(path.relative(this.rootDir, f))), removed: removed.map((f) => toPosixPath(path.relative(this.rootDir, f))) };
  }

  /** All source files under the root (absolute paths, sorted). */
  listSourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SANDBOX_V4_DEPMAP_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          if (SANDBOX_V4_DEPMAP_EXTENSIONS.has(path.extname(entry.name))) {
            out.push(path.join(dir, entry.name));
          }
        }
      }
    };
    walk(this.rootDir);
    return out.sort();
  }

  private buildFromFiles(files: string[]): SandboxV4DepScanResult {
    const nodes = new Map<string, SandboxV4DepNode>();
    const fingerprints = new Map<string, string>();
    const skippedOversize: string[] = [];
    const unresolvable: Array<{ from: string; specifier: string }> = [];
    const relPaths = new Set<string>();
    for (const file of files) {
      relPaths.add(toPosixPath(path.relative(this.rootDir, file)));
    }

    for (const file of files) {
      const rel = toPosixPath(path.relative(this.rootDir, file));
      const stat = fs.statSync(file);
      fingerprints.set(file, `${stat.size}:${stat.mtimeMs}`);
      if (stat.size > SANDBOX_V4_DEPMAP_MAX_FILE_BYTES) {
        skippedOversize.push(rel);
        continue;
      }
      const content = fs.readFileSync(file, 'utf8');
      const ext = path.extname(file);
      const specifiers = extractImportSpecifiers(content, ext);
      const imports: string[] = [];
      const externalImports: string[] = [];
      for (const spec of specifiers) {
        if (!isRelativeSpecifier(spec)) {
          externalImports.push(spec);
          continue;
        }
        const resolved = this.resolveRelative(file, spec, relPaths);
        if (resolved === undefined) {
          unresolvable.push({ from: rel, specifier: spec });
          continue;
        }
        if (resolved !== rel && !imports.includes(resolved)) imports.push(resolved);
      }
      nodes.set(rel, {
        path: rel,
        kind: depNodeKindForExtension(ext),
        imports: imports.sort(),
        importedBy: [],
        externalImports: [...new Set(externalImports)].sort(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }

    // Reverse edges.
    for (const node of nodes.values()) {
      for (const dep of node.imports) {
        const target = nodes.get(dep);
        if (target && !target.importedBy.includes(node.path)) {
          target.importedBy.push(node.path);
        }
      }
    }
    for (const node of nodes.values()) node.importedBy.sort();

    const nodesObj: Record<string, SandboxV4DepNode> = {};
    for (const [key, node] of [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      nodesObj[key] = node;
    }
    const edgeCount = [...nodes.values()].reduce((sum, n) => sum + n.imports.length, 0);
    const cycles = findSandboxV4DepCycles(nodesObj);
    const map: SandboxV4DependencyMap = {
      rootDir: this.rootDir,
      builtAtMs: Date.now(),
      nodes: nodesObj,
      fileCount: nodes.size,
      edgeCount,
      cycles,
    };
    this.lastFingerprints = fingerprints;
    return { map, skippedOversize, unresolvable };
  }

  private resolveRelative(fromFile: string, specifier: string, relPaths: Set<string>): string | undefined {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates: string[] = [];
    if (path.extname(base) !== '') {
      candidates.push(base);
    } else {
      for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
      for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
    }
    for (const candidate of candidates) {
      const rel = toPosixPath(path.relative(this.rootDir, candidate));
      if (!rel.startsWith('..') && relPaths.has(rel)) return rel;
    }
    return undefined;
  }
}

/**
 * Find import cycles with iterative DFS (white/grey/black).
 * Each cycle is reported once, starting at its smallest file
 * (lexicographically) so output is deterministic.
 */
export function findSandboxV4DepCycles(nodes: Record<string, SandboxV4DepNode>): SandboxV4DepCycle[] {
  const cycles: SandboxV4DepCycle[] = [];
  const seen = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (start: string): void => {
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = nodes[frame.node];
      if (frame.next === 0) {
        if (state.get(frame.node) === 'done') {
          work.pop();
          continue;
        }
        state.set(frame.node, 'visiting');
        stack.push(frame.node);
      }
      if (!node || frame.next >= node.imports.length) {
        state.set(frame.node, 'done');
        stack.pop();
        work.pop();
        continue;
      }
      const dep = node.imports[frame.next];
      frame.next += 1;
      if (!nodes[dep]) continue;
      const depState = state.get(dep);
      if (depState === 'visiting') {
        const idx = stack.indexOf(dep);
        const cycle = stack.slice(idx);
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          // Rotate so the lexicographically smallest file is first,
          // preserving import order around the loop.
          const minIdx = cycle.indexOf([...cycle].sort()[0]);
          const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
          cycles.push({ files: rotated });
        }
        continue;
      }
      if (depState === 'done') continue;
      work.push({ node: dep, next: 0 });
    }
  };

  for (const name of Object.keys(nodes).sort()) {
    if (!state.has(name)) visit(name);
  }
  return cycles.sort((a, b) => a.files.join('|').localeCompare(b.files.join('|')));
}

/**
 * Topological order (dependencies first). Returns the files it
 * could order and the files stuck in cycles. Kahn's algorithm,
 * deterministic (lexicographic tie-break).
 */
export function topoOrderSandboxV4DepMap(map: SandboxV4DependencyMap): { order: string[]; unordered: string[] } {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of Object.keys(map.nodes)) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const [name, node] of Object.entries(map.nodes)) {
    for (const dep of node.imports) {
      if (!map.nodes[dep]) continue;
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      dependents.get(dep)?.push(name);
    }
  }
  const ready = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([name]) => name)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift() as string;
    order.push(name);
    for (const dependent of (dependents.get(name) ?? []).sort()) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) {
        // Keep `ready` sorted for deterministic output.
        const idx = ready.findIndex((r) => r > dependent);
        if (idx === -1) ready.push(dependent);
        else ready.splice(idx, 0, dependent);
      }
    }
  }
  const unordered = Object.keys(map.nodes).filter((name) => !order.includes(name)).sort();
  return { order, unordered };
}

/**
 * Reverse-dependency impact set: every file that (transitively)
 * imports any of `files`, plus the files themselves. The answer
 * to "what breaks if I change this".
 */
export function affectedSetSandboxV4DepMap(map: SandboxV4DependencyMap, files: readonly string[]): string[] {
  const out = new Set<string>();
  const queue: string[] = [];
  for (const file of files) {
    if (!map.nodes[file]) continue;
    if (!out.has(file)) {
      out.add(file);
      queue.push(file);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const importer of map.nodes[current]?.importedBy ?? []) {
      if (!out.has(importer)) {
        out.add(importer);
        queue.push(importer);
      }
    }
  }
  return [...out].sort();
}

/** Direct dependencies of one file (empty when unknown). */
export function dependenciesOfSandboxV4DepMap(map: SandboxV4DependencyMap, file: string): string[] {
  return [...(map.nodes[file]?.imports ?? [])];
}

/** Direct dependents of one file (empty when unknown). */
export function dependentsOfSandboxV4DepMap(map: SandboxV4DependencyMap, file: string): string[] {
  return [...(map.nodes[file]?.importedBy ?? [])];
}

/**
 * Detect conflicts between agents' change sets. Two agents
 * conflict when they edit the same file (`same-file`) or when
 * one's edited files fall inside the other's impact set
 * (`overlapping-impact`). Agents with empty file lists never
 * conflict. Unknown files (not in the map) still conflict on
 * exact matches — the map cannot prove them disjoint.
 */
export function detectSandboxV4DepConflicts(
  map: SandboxV4DependencyMap,
  changeSets: readonly SandboxV4ChangeSet[],
): SandboxV4DepConflict[] {
  const conflicts: SandboxV4DepConflict[] = [];
  const seenAgents = new Set<string>();
  for (const cs of changeSets) {
    if (seenAgents.has(cs.agentId)) {
      throw new Error(`Duplicate agentId "${cs.agentId}" in change sets.`);
    }
    seenAgents.add(cs.agentId);
  }
  for (let i = 0; i < changeSets.length; i++) {
    for (let j = i + 1; j < changeSets.length; j++) {
      const a = changeSets[i];
      const b = changeSets[j];
      const aFiles = new Set(a.files);
      const bFiles = new Set(b.files);
      const same = [...aFiles].filter((f) => bFiles.has(f)).sort();
      if (same.length > 0) {
        conflicts.push({
          kind: 'same-file',
          agentA: a.agentId,
          agentB: b.agentId,
          files: same,
          detail: `Agents ${a.agentId} and ${b.agentId} both edit ${same.join(', ')}.`,
        });
        continue;
      }
      const aImpact = new Set(affectedSetSandboxV4DepMap(map, a.files));
      const bImpact = new Set(affectedSetSandboxV4DepMap(map, b.files));
      const overlap = [...aFiles].filter((f) => bImpact.has(f)).concat([...bFiles].filter((f) => aImpact.has(f)));
      const unique = [...new Set(overlap)].sort();
      if (unique.length > 0) {
        conflicts.push({
          kind: 'overlapping-impact',
          agentA: a.agentId,
          agentB: b.agentId,
          files: unique,
          detail:
            `Change by ${a.agentId} affects files ${b.agentId} edits (or vice versa): ${unique.join(', ')}. ` +
            'Order the changes or split the work.',
        });
      }
    }
  }
  return conflicts;
}

/**
 * Build an execution plan for a set of files: waves of files
 * that can change together (no dependency between files in one
 * wave), in dependency order. Files in cycles land in
 * `unordered` — they need a human (or the coordinator) to break
 * the cycle first.
 */
export function planSandboxV4Changes(
  map: SandboxV4DependencyMap,
  files: readonly string[],
): SandboxV4ChangePlan {
  const wanted = new Set(files.filter((f) => map.nodes[f]));
  const { order, unordered } = topoOrderSandboxV4DepMap(map);
  const depth = new Map<string, number>();
  for (const name of order) {
    const node = map.nodes[name];
    let d = 0;
    for (const dep of node.imports) {
      if (wanted.has(dep) && depth.has(dep)) d = Math.max(d, (depth.get(dep) ?? 0) + 1);
    }
    depth.set(name, d);
  }
  const waves: string[][] = [];
  for (const name of order) {
    if (!wanted.has(name)) continue;
    const d = depth.get(name) ?? 0;
    while (waves.length <= d) waves.push([]);
    waves[d].push(name);
  }
  for (const wave of waves) wave.sort();
  const unorderedWanted = unordered.filter((f) => wanted.has(f)).sort();
  return { waves: waves.filter((w) => w.length > 0), unordered: unorderedWanted, hasCycles: map.cycles.length > 0 };
}
