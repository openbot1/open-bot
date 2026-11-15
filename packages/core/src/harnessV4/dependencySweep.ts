/**
 * Dependency sweep cho repo lớn (v1.08, Đội T3).
 *
 * Ý tưởng học từ survey v1.08 phần OpenHands Large Codebase SDK
 * (chỉ học ý tưởng, không copy code/text/tài sản của bất kỳ repo
 * nào): lập map dependency cho repo lớn để nhiều agent song song
 * làm việc không xung đột nhờ biết rõ thứ tự thay đổi.
 *
 * Thiết kế riêng của open-bot (khác repoMap v0.96 — repoMap xếp hạng
 * file quan trọng cho prompt bằng PageRank; sweep này trả *thứ tự
 * sửa an toàn* + *xung đột giữa các agent* + *đề xuất chia việc*):
 * - Parse import tương đối từ TS/TSX/JS/JSX/Python bằng regex
 *   (không dùng tree-sitter để sweep chạy được cả khi chỉ có danh
 *   sách file + nội dung, không cần quét đĩa).
 * - Đồ thị: cạnh A → B khi A import B. Thứ tự an toàn = topo sort
 *   (dependency trước, file phụ thuộc sau); file cùng tầng không
 *   phụ thuộc nhau nên sửa song song được.
 * - Xung đột: hai agent cùng sửa một file (direct), cùng chạm
 *   dependency chung (shared_dependency — sửa B trong khi agent kia
 *   sửa A import B), hoặc thứ tự sửa ngược nhau (order — agent X
 *   sửa file phụ thuộc trước khi agent Y sửa xong dependency).
 * - Chia việc: xếp file theo tầng topo, chia đều các tầng cho N
 *   agent sao cho mỗi agent nhận các file liên tiếp nhau trong thứ
 *   tự (giữ dependency chung trong cùng một agent càng nhiều càng
 *   tốt); file trong chu trình giao cho agent đầu, sửa cuối.
 *
 * Giới hạn nói rõ:
 * - Chỉ import tương đối (`./`, `../`) được resolve; bare import
 *   (`react`, `lodash`, `@open-bot/core`) trỏ ra ngoài repo nên bỏ qua.
 * - Regex nên có thể đếm thừa import nằm trong string/comment;
 *   import động `import('...')` vẫn bắt được, `require` cũng bắt.
 * - Python: chỉ `from .x import` / `import .x` tương đối và
 *   `from pkg.mod import` được map theo tên module → file cùng tên.
 * - Tối đa 5000 file / file tối đa 1 MB — vượt thì lược và báo rõ.
 */

import * as path from 'node:path';

import type {
  HarnessV4Assignment,
  HarnessV4Conflict,
  HarnessV4ConflictReport,
  HarnessV4DependencyEdge,
  HarnessV4DependencyGraph,
  HarnessV4Impact,
  HarnessV4Partition,
  HarnessV4SafeOrder,
  HarnessV4SweepFile,
} from './types';

/** Số file tối đa một lần sweep (vượt thì lược, báo rõ). */
export const HARNESS_V4_SWEEP_MAX_FILES = 5000;
/** Số byte tối đa một file được parse (vượt thì coi như không có import). */
export const HARNESS_V4_SWEEP_MAX_FILE_BYTES = 1024 * 1024;

/** Chuẩn hoá đường dẫn file trong sweep: `/` + không `./` đầu + không `//`. */
export function normalizeHarnessV4SweepPath(filePath: string): string {
  const withSlashes = filePath.replace(/\\/g, '/');
  const cleaned = withSlashes.replace(/^\.\//, '').replace(/\/+/g, '/');
  return cleaned.replace(/^\//, '');
}

/** Regex bắt import tương đối/bare trong TS/JS (import, export-from, dynamic import, require). */
const TS_IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
/** Regex bắt import tương đối trong Python. */
const PY_FROM_RE = /^\s*from\s+(\.+[A-Za-z0-9_.]*)\s+import\s+/gm;
const PY_IMPORT_RE = /^\s*import\s+(\.+[A-Za-z0-9_.]*)/gm;

function isTsLike(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(filePath);
}

function isPyLike(filePath: string): boolean {
  return /\.py$/.test(filePath);
}

/** Trích specifier import thô từ nội dung file. */
export function extractHarnessV4ImportSpecifiers(filePath: string, content: string): string[] {
  const out: string[] = [];
  if (isTsLike(filePath)) {
    TS_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TS_IMPORT_RE.exec(content)) !== null) {
      if (m[1] !== undefined) out.push(m[1]);
    }
    return out;
  }
  if (isPyLike(filePath)) {
    let m: RegExpExecArray | null;
    PY_FROM_RE.lastIndex = 0;
    while ((m = PY_FROM_RE.exec(content)) !== null) {
      if (m[1] !== undefined) out.push(m[1]);
    }
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(content)) !== null) {
      if (m[1] !== undefined) out.push(m[1]);
    }
    return out;
  }
  return out;
}

/**
 * Resolve một import tương đối thành đường dẫn file trong tập.
 * Trả undefined khi specifier không tương đối, hoặc không resolve
 * được tới file nào trong tập (caller ghi vào `missing`).
 */
export function resolveHarnessV4Import(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dir = path.posix.dirname(fromFile);
  let base = path.posix.normalize(path.posix.join(dir, specifier));
  // Python: `.foo` = module cùng package → `foo.py` hoặc `foo/__init__.py`.
  if (fromFile.endsWith('.py')) {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 1;
    const rest = specifier.slice(dots).replace(/\./g, '/');
    const up = dots - 1;
    let pkgDir = dir;
    for (let i = 0; i < up; i += 1) pkgDir = path.posix.dirname(pkgDir);
    base = rest === '' ? pkgDir : path.posix.join(pkgDir, rest);
    const pyCandidates = [`${base}.py`, `${base}/__init__.py`];
    for (const c of pyCandidates) if (fileSet.has(c)) return c;
    return undefined;
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return undefined;
}

/**
 * Dựng đồ thị dependency từ một tập file (path + content).
 * File trùng path: nội dung sau thắng (ghi đè).
 */
export function analyzeHarnessV4Dependencies(files: HarnessV4SweepFile[]): HarnessV4DependencyGraph {
  const byPath = new Map<string, string>();
  let truncatedFiles = 0;
  for (const f of files) {
    const p = normalizeHarnessV4SweepPath(f.path);
    if (p === '') continue;
    if (!byPath.has(p) && byPath.size >= HARNESS_V4_SWEEP_MAX_FILES) {
      truncatedFiles += 1;
      continue;
    }
    byPath.set(p, f.content);
  }
  const fileList = [...byPath.keys()].sort();
  const fileSet = new Set(fileList);
  const edges: HarnessV4DependencyEdge[] = [];
  const edgeSeen = new Set<string>();
  const missingSet = new Set<string>();
  for (const file of fileList) {
    const content = byPath.get(file) ?? '';
    if (Buffer.byteLength(content, 'utf8') > HARNESS_V4_SWEEP_MAX_FILE_BYTES) continue;
    for (const spec of extractHarnessV4ImportSpecifiers(file, content)) {
      if (!spec.startsWith('.')) continue;
      const resolved = resolveHarnessV4Import(file, spec, fileSet);
      if (resolved === undefined) {
        missingSet.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
        continue;
      }
      if (resolved === file) continue;
      const key = `${file}→${resolved}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ from: file, to: resolved, kind: 'relative' });
    }
  }
  const imported = new Set(edges.map((e) => e.to));
  const importing = new Set(edges.map((e) => e.from));
  const leaves = fileList.filter((f) => !importing.has(f) && !imported.has(f));
  const cycles = findHarnessV4Cycles(fileList, edges);
  return {
    files: fileList,
    edges: edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1)),
    leaves,
    cycles,
    missing: [...missingSet].sort(),
    truncatedFiles,
  };
}

/** Tìm chu trình trong đồ thị bằng DFS (mỗi chu trình trả một lần, chuẩn hoá điểm bắt đầu). */
export function findHarnessV4Cycles(files: string[], edges: HarnessV4DependencyEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const f of files) adj.set(f, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  for (const list of adj.values()) list.sort();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 'white' | 'gray' | 'black'>();
  for (const f of files) state.set(f, 'white');
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 'gray');
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === 'gray') {
        const idx = stack.indexOf(next);
        const cycle = [...stack.slice(idx), next];
        // Chuẩn hoá: xoay về file nhỏ nhất để cùng chu trình không trả 2 lần.
        const minIdx = cycle.reduce((best, cur, i) => (cur < cycle[best]! ? i : best), 0);
        const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
        const key = rotated.join('→');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(rotated);
        }
      } else if (state.get(next) === 'white') {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'black');
  };
  for (const f of files) if (state.get(f) === 'white') visit(f);
  return cycles;
}

/**
 * Thứ tự an toàn: dependency trước, file phụ thuộc sau (topo sort
 * Kahn). File cùng tầng không phụ thuộc nhau → sửa song song được.
 * Khi có chu trình, các file trong chu trình xếp cuối theo thứ tự
 * tên (thứ tự tốt nhất có thể, `hasCycles=true` báo rõ).
 */
export function safeHarnessV4Order(graph: HarnessV4DependencyGraph): HarnessV4SafeOrder {
  const inCycle = new Set(graph.cycles.flat());
  // Kahn trên đồ thị đảo: cạnh dependency→dependent (B trước A khi A import B).
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const f of graph.files) {
    dependents.set(f, []);
    indegree.set(f, 0);
  }
  for (const e of graph.edges) {
    if (inCycle.has(e.from) || inCycle.has(e.to)) continue;
    dependents.get(e.to)?.push(e.from);
    indegree.set(e.from, (indegree.get(e.from) ?? 0) + 1);
  }
  for (const list of dependents.values()) list.sort();
  const levels: string[][] = [];
  let ready = graph.files.filter((f) => !inCycle.has(f) && (indegree.get(f) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    levels.push([...ready]);
    const next: string[] = [];
    for (const node of ready) {
      order.push(node);
      for (const dep of dependents.get(node) ?? []) {
        const remaining = (indegree.get(dep) ?? 0) - 1;
        indegree.set(dep, remaining);
        if (remaining === 0) next.push(dep);
      }
    }
    ready = [...new Set(next)].sort();
  }
  // File trong chu trình: xếp cuối theo tên (không có thứ tự an toàn tuyệt đối).
  const cyclic = graph.files.filter((f) => inCycle.has(f)).sort();
  if (cyclic.length > 0) {
    levels.push([...cyclic]);
    order.push(...cyclic);
  }
  // File còn sót (không tới được vì chu trình đã lược cạnh): xếp cuối.
  const placed = new Set(order);
  const leftover = graph.files.filter((f) => !placed.has(f)).sort();
  if (leftover.length > 0) {
    levels.push([...leftover]);
    order.push(...leftover);
  }
  return { order, levels, hasCycles: graph.cycles.length > 0, cycles: graph.cycles, missing: graph.missing };
}

/** Closure dependency của một file: mọi file nó (trực/gián tiếp) phụ thuộc. */
export function harnessV4DependencyClosure(graph: HarnessV4DependencyGraph, file: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const out = new Set<string>();
  const stack = [...(adj.get(file) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return out;
}

/**
 * Phát hiện xung đột khi nhiều agent cùng sửa một tập file.
 * - direct: cùng một file trong assignment của 2 agent.
 * - shared_dependency: agent A sửa file X, agent B sửa file Y mà
 *   closure dependency của Y chứa X (B phụ thuộc vào file A đang sửa).
 */
export function detectHarnessV4Conflicts(
  graph: HarnessV4DependencyGraph,
  assignments: HarnessV4Assignment[],
): HarnessV4ConflictReport {
  const conflicts: HarnessV4Conflict[] = [];
  const normalized = assignments.map((a) => ({
    agent: a.agent,
    files: [...new Set(a.files.map((f) => normalizeHarnessV4SweepPath(f)))].sort(),
  }));
  let pairsChecked = 0;
  const orderIndex = new Map<string, number>();
  safeHarnessV4Order(graph).order.forEach((f, i) => orderIndex.set(f, i));
  const closures = new Map<string, Set<string>>();
  for (const a of normalized) {
    for (const f of a.files) {
      if (!closures.has(f)) closures.set(f, harnessV4DependencyClosure(graph, f));
    }
  }
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      pairsChecked += 1;
      const aSet = new Set(a.files);
      const bSet = new Set(b.files);
      // direct: cùng file.
      const shared = a.files.filter((f) => bSet.has(f));
      for (const f of shared) {
        conflicts.push({
          kind: 'direct',
          agents: [a.agent, b.agent],
          files: [f],
          detail: `Cả ${a.agent} và ${b.agent} cùng sửa ${f} — chỉ một agent được sửa file này.`,
          severity: 'high',
        });
      }
      // shared_dependency: B sửa file phụ thuộc vào file A đang sửa (và ngược lại).
      for (const fA of a.files) {
        if (shared.includes(fA)) continue;
        for (const fB of b.files) {
          if (shared.includes(fB)) continue;
          const closureB = closures.get(fB) ?? new Set<string>();
          const closureA = closures.get(fA) ?? new Set<string>();
          if (closureB.has(fA)) {
            conflicts.push({
              kind: 'shared_dependency',
              agents: [a.agent, b.agent],
              files: [fA, fB],
              detail: `${b.agent} sửa ${fB} (phụ thuộc ${fA}) trong khi ${a.agent} sửa ${fA} — sửa dependency xong trước rồi mới sửa file phụ thuộc.`,
              severity: 'medium',
            });
          } else if (closureA.has(fB)) {
            conflicts.push({
              kind: 'shared_dependency',
              agents: [a.agent, b.agent],
              files: [fB, fA],
              detail: `${a.agent} sửa ${fA} (phụ thuộc ${fB}) trong khi ${b.agent} sửa ${fB} — sửa dependency xong trước rồi mới sửa file phụ thuộc.`,
              severity: 'medium',
            });
          }
        }
      }
      // (Không báo xung đột 'order': assignment không nói ai chạy
      // trước, nên thứ tự chạy là trách nhiệm của safe order.)
    }
  }
  // Dedupe xung đột shared_dependency trùng (cùng cặp agent + cùng file dependency).
  const seen = new Set<string>();
  const deduped = conflicts.filter((c) => {
    const key = `${c.kind}|${c.agents.join(',')}|${c.files.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { assignments: normalized, conflicts: deduped, clean: deduped.length === 0, pairsChecked };
}

/**
 * Phân tích ảnh hưởng: cho một tập file đã đổi, trả mọi file phụ
 * thuộc (trực/gián tiếp) vào chúng — tức là những file có thể cần
 * sửa lại / test lại sau khi đổi. Dùng cho fleet campaign ("sửa X
 * thì chạm tới đâu") và cho reviewer trước khi merge.
 */
export function harnessV4ImpactOf(
  graph: HarnessV4DependencyGraph,
  changedFiles: string[],
): HarnessV4Impact {
  const changed = [...new Set(changedFiles.map((f) => normalizeHarnessV4SweepPath(f)))].sort();
  const changedSet = new Set(changed);
  // Đồ thị đảo: B → [các file import B].
  const dependents = new Map<string, string[]>();
  for (const f of graph.files) dependents.set(f, []);
  for (const e of graph.edges) dependents.get(e.to)?.push(e.from);
  const affected = new Set<string>();
  const direct = new Set<string>();
  const queue: Array<{ file: string; d: number }> = changed.map((f) => ({ file: f, d: 0 }));
  const seenQueue = new Set(changed);
  let maxDepth = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const dep of dependents.get(cur.file) ?? []) {
      if (dep === cur.file || changedSet.has(dep)) continue;
      if (!direct.has(dep) && cur.d === 0) direct.add(dep);
      const d = cur.d + 1;
      if (!affected.has(dep)) {
        affected.add(dep);
        maxDepth = Math.max(maxDepth, d);
      }
      if (!seenQueue.has(dep)) {
        seenQueue.add(dep);
        queue.push({ file: dep, d });
      }
    }
  }
  const safe = safeHarnessV4Order(graph);
  const orderIndex = new Map(safe.order.map((f, i) => [f, i]));
  const affectedFiles = [...affected].sort(
    (a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0),
  );
  return {
    changedFiles: changed,
    affectedFiles,
    directDependents: [...direct].sort(),
    maxDepth,
    unaffectedCount: graph.files.filter((f) => !changedSet.has(f) && !affected.has(f)).length,
  };
}

/**
 * Đề xuất chia việc: xếp file theo thứ tự an toàn, chia đều các tầng
 * cho N agent (mỗi agent nhận một đoạn liên tiếp — dependency chung
 * nằm trong cùng agent càng nhiều càng tốt). File trong chu trình
 * giao cho agent đầu tiên, sửa cuối cùng.
 */
export function suggestHarnessV4Partition(
  graph: HarnessV4DependencyGraph,
  agentCount: number,
  agentNames?: string[],
): HarnessV4Partition {
  const count = Math.max(1, Math.min(32, Math.floor(agentCount) || 1));
  const names =
    agentNames !== undefined && agentNames.length >= count
      ? agentNames.slice(0, count)
      : Array.from({ length: count }, (_v, i) => `agent-${i + 1}`);
  const safe = safeHarnessV4Order(graph);
  const cyclicSet = new Set(graph.cycles.flat());
  const acyclic = safe.order.filter((f) => !cyclicSet.has(f));
  const cyclicFiles = safe.order.filter((f) => cyclicSet.has(f)).sort();
  const groups: HarnessV4Assignment[] = names.map((agent) => ({ agent, files: [] }));
  // Chia đều theo tầng: mỗi tầng cắt thành `count` phần, phân phối
  // round-robin theo tầng để tầng lớn không dồn hết vào một agent.
  const perAgent = Math.ceil(acyclic.length / count);
  for (let i = 0; i < acyclic.length; i += 1) {
    const idx = Math.min(count - 1, Math.floor(i / perAgent));
    groups[idx]!.files.push(acyclic[i]!);
  }
  if (cyclicFiles.length > 0) groups[0]!.files.push(...cyclicFiles);
  return {
    agentCount: count,
    groups,
    cyclicFiles,
    rationale:
      cyclicFiles.length > 0
        ? `Chia theo thứ tự an toàn (${safe.levels.length} tầng, dependency trước); ${cyclicFiles.length} file trong chu trình giao cho ${names[0]} sửa cuối.`
        : `Chia theo thứ tự an toàn (${safe.levels.length} tầng, dependency trước); mỗi agent nhận một đoạn liên tiếp để dependency chung nằm cùng agent.`,
  };
}
