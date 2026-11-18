/**
 * Coding agent v12 — dependency graph kiểu Large Codebase SDK.
 *
 * Học ý tưởng OpenHands Large Codebase SDK (chỉ học ý tưởng, tự
 * thiết kế và viết lại hoàn toàn, không copy code/text/tài sản):
 * edit lớn trên codebase lớn không sửa file theo thứ tự ngẫu nhiên —
 * phải phân tích dependency graph trước, sửa file lá (không phụ
 * thuộc file nội bộ nào) trước, file gốc (nhiều file phụ thuộc vào)
 * sau, để mỗi bước đều build được trên nền của bước trước. Module
 * này làm 3 việc:
 *
 *   1. Parse import TS/JS (`import … from`, `export … from`,
 *      `require(…)`, `import(…)`) → graph `file → file nó import`,
 *      resolve path tương đối (`./`, `../`) + index file + bỏ qua
 *      package bên ngoài (`react`, `@scope/pkg`, `node:*`).
 *   2. Topological sort lá-trước-gốc-sau (Kahn trên cạnh đảo:
 *      file chỉ được xếp sau khi mọi file nó import đã xếp) +
 *      phát hiện chu trình bằng Tarjan SCC (chu trình được báo rõ,
 *      không xếp chìm — caller quyết định phá vòng bằng cách nào).
 *   3. Chia task edit lớn thành các edit nhỏ có thứ tự
 *      (`planOrderedEdits`): mỗi file một edit, `dependsOn` trỏ
 *      edit của file nó import, `parallelGroup` = depth (cùng depth
 *      thì chạy song song được). `V12EditCoordinator` theo dõi tiến
 *      độ từng edit: chỉ cho start edit khi dependency đã done,
 *      báo edit nào đang chặn edit nào.
 *
 * Module thuần (đọc file qua fs, không gọi model, không gọi mạng).
 * Giới hạn trung thực: parse bằng regex nên chỉ bắt import tĩnh
 * (không bắt dynamic import qua biến, không bắt `require` điều
 * kiện); file không có trong tập quét mà được import thì bỏ qua
 * (coi là ngoài phạm vi), không đoán.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV12Error } from './types';
import type {
  V12DepFile,
  V12DepGraph,
  V12EditPlanSummary,
  V12EditProgress,
  V12EditStatus,
  V12OrderedEdit,
} from './types';

/** Phần mở rộng file quét được. */
export const V12_DEP_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Số file tối đa quét trong một lần build graph. */
export const V12_DEP_MAX_FILES = 5000;

/** Id plan edit mặc định. */
export function v12NewEditPlanId(): string {
  return `v12plan-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Kiểm tra path có phải import package ngoài (không resolve nội bộ). */
export function v12IsExternalImport(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  return true;
}

/** Tách phần comment (// và block) khỏi source trước khi parse import. */
export function v12StripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

const IMPORT_FROM_RE = /import\s+(?:type\s+)?(?:[\w${}\s,*]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /export\s+(?:type\s+)?(?:[\w${}\s,*]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Lấy danh sách specifier import tĩnh trong một file (đã bỏ comment). */
export function v12ExtractImportSpecifiers(source: string): string[] {
  const clean = v12StripComments(source);
  const specs: string[] = [];
  const push = (re: RegExp): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      if (m[1] && !specs.includes(m[1])) specs.push(m[1]);
    }
  };
  push(IMPORT_FROM_RE);
  push(EXPORT_FROM_RE);
  push(REQUIRE_RE);
  push(DYNAMIC_IMPORT_RE);
  return specs;
}

/** Resolve một specifier tương đối thành path repo-relative (hoặc null khi ngoài phạm vi). */
export function v12ResolveImport(
  fromFile: string,
  spec: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (v12IsExternalImport(spec)) return null;
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [base];
  if (!V12_DEP_SOURCE_EXTENSIONS.has(path.posix.extname(base))) {
    for (const ext of V12_DEP_SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
    candidates.push(path.posix.join(base, 'index.ts'));
    candidates.push(path.posix.join(base, 'index.js'));
    candidates.push(path.posix.join(base, 'index.tsx'));
    candidates.push(path.posix.join(base, 'index.mjs'));
  }
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

/** Quét đệ quy một thư mục, trả path repo-relative của file source. */
export function v12CollectSourceFiles(rootDir: string, subdir = ''): string[] {
  const out: string[] = [];
  const abs = path.join(rootDir, subdir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const rel = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...v12CollectSourceFiles(rootDir, rel));
    } else if (entry.isFile() && V12_DEP_SOURCE_EXTENSIONS.has(path.posix.extname(entry.name))) {
      out.push(rel);
    }
    if (out.length > V12_DEP_MAX_FILES) return out.slice(0, V12_DEP_MAX_FILES);
  }
  return out.sort();
}

/** Tarjan SCC: trả các thành phần liên thông mạnh (chu trình = SCC > 1 node hoặc tự import). */
function tarjanScc(nodes: string[], edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;
  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (edges.get(v) ?? []).includes(v)) sccs.push(comp.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) strongconnect(v);
  return sccs;
}

/**
 * Build dependency graph từ nội dung file đã cho.
 * `sources`: map path repo-relative → nội dung file.
 */
export function v12BuildDepGraph(sources: Map<string, string> | Record<string, string>): V12DepGraph {
  const entries = sources instanceof Map ? [...sources.entries()] : Object.entries(sources);
  if (entries.length === 0) {
    throw new CodingV12Error('depgraph-not-built', 'Dependency graph v12: không có file nguồn nào.');
  }
  const known = new Set(entries.map(([p]) => p));
  const files = new Map<string, V12DepFile>();
  for (const [filePath, content] of entries) {
    const imports = v12ExtractImportSpecifiers(content)
      .map((spec) => v12ResolveImport(filePath, spec, known))
      .filter((r): r is string => r !== null && r !== filePath)
      .filter((r, i, arr) => arr.indexOf(r) === i)
      .sort();
    files.set(filePath, { path: filePath, imports, importedBy: [], depth: 0, dependentsCount: 0 });
  }
  for (const file of files.values()) {
    for (const dep of file.imports) {
      files.get(dep)?.importedBy.push(file.path);
    }
  }
  for (const file of files.values()) file.importedBy.sort();
  // Depth: lá = 0; depth(file) = 1 + max(depth(imports)) — tính theo topological order.
  const order = v12TopologicalOrder(files);
  for (const p of order) {
    const file = files.get(p)!;
    file.depth = file.imports.length === 0 ? 0 : 1 + Math.max(...file.imports.map((d) => files.get(d)!.depth));
  }
  // dependentsCount: số file phụ thuộc (trực tiếp + gián tiếp) vào file này.
  for (const file of files.values()) {
    const seen = new Set<string>();
    const queue = [...file.importedBy];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      queue.push(...(files.get(cur)?.importedBy ?? []));
    }
    file.dependentsCount = seen.size;
  }
  const edges = new Map<string, string[]>();
  for (const [p, f] of files) edges.set(p, f.imports);
  const cycles = tarjanScc([...files.keys()], edges);
  let components = 0;
  const visited = new Set<string>();
  const undirected = new Map<string, string[]>();
  for (const [p, f] of files) {
    undirected.set(p, [...f.imports, ...f.importedBy]);
  }
  for (const p of files.keys()) {
    if (visited.has(p)) continue;
    components += 1;
    const queue = [p];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      queue.push(...(undirected.get(cur) ?? []));
    }
  }
  const leaves = [...files.values()].filter((f) => f.depth === 0).length;
  const maxDepth = Math.max(...[...files.values()].map((f) => f.depth), 0);
  const edgeCount = [...files.values()].reduce((n, f) => n + f.imports.length, 0);
  return {
    files,
    stats: { files: files.size, edges: edgeCount, components, cycles: cycles.length, maxDepth, leaves },
    order,
    cycles,
  };
}

/**
 * Topological sort lá-trước-gốc-sau. File chỉ được xếp sau khi mọi
 * file nó import đã xếp. Có chu trình thì vẫn xếp được phần còn lại
 * (node trong chu trình xếp theo tên, chu trình báo riêng trong graph).
 */
export function v12TopologicalOrder(files: Map<string, V12DepFile>): string[] {
  const remaining = new Map<string, Set<string>>();
  for (const [p, f] of files) remaining.set(p, new Set(f.imports.filter((d) => files.has(d))));
  const order: string[] = [];
  const done = new Set<string>();
  while (done.size < files.size) {
    const ready = [...remaining.entries()]
      .filter(([p, deps]) => !done.has(p) && [...deps].every((d) => done.has(d)))
      .map(([p]) => p)
      .sort();
    if (ready.length === 0) {
      // Chu trình: phá vòng bằng cách lấy node còn lại có ít dependency nhất (tên ổn định).
      const rest = [...remaining.keys()].filter((p) => !done.has(p)).sort();
      const pick = rest.sort((a, b) => remaining.get(a)!.size - remaining.get(b)!.size || a.localeCompare(b))[0];
      order.push(pick);
      done.add(pick);
      continue;
    }
    for (const p of ready) {
      order.push(p);
      done.add(p);
    }
  }
  return order;
}

/** Build graph từ thư mục thật trên đĩa (rootDir + subdir tương đối, vd `src`). */
export function v12BuildDepGraphFromDir(rootDir: string, subdir = ''): V12DepGraph {
  const relFiles = v12CollectSourceFiles(rootDir, subdir);
  const sources = new Map<string, string>();
  for (const rel of relFiles) {
    try {
      sources.set(rel, fs.readFileSync(path.join(rootDir, rel), 'utf8'));
    } catch {
      // File đọc lỗi thì bỏ qua (không chặn cả graph).
    }
  }
  return v12BuildDepGraph(sources);
}

/** Impact set: tất cả file phụ thuộc (trực tiếp + gián tiếp) vào `file`. */
export function v12ImpactSet(graph: V12DepGraph, file: string): string[] {
  const node = graph.files.get(file);
  if (!node) throw new CodingV12Error('depgraph-file-not-found', `Dependency graph v12: không có file \"${file}\".`);
  const seen = new Set<string>();
  const queue = [...node.importedBy];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    queue.push(...(graph.files.get(cur)?.importedBy ?? []));
  }
  return [...seen].sort();
}

/** File quan trọng nhất theo dependentsCount (file gốc nhiều người dùng). */
export function v12TopRootFiles(graph: V12DepGraph, limit = 10): V12DepFile[] {
  return [...graph.files.values()]
    .sort((a, b) => b.dependentsCount - a.dependentsCount || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, limit));
}

/**
 * Chia task edit lớn thành các edit nhỏ có thứ tự theo dependency.
 * `tasks`: map file → mô tả việc cần làm với file đó. File không có
 * trong graph vẫn được nhận (depth 0, không dependency).
 */
export function v12PlanOrderedEdits(
  graph: V12DepGraph,
  tasks: Map<string, string> | Record<string, string>,
  title = '',
): { planId: string; title: string; edits: V12OrderedEdit[] } {
  const entries = tasks instanceof Map ? [...tasks.entries()] : Object.entries(tasks);
  if (entries.length === 0) {
    throw new CodingV12Error('depgraph-edit-invalid', 'Dependency plan v12: task không có file nào cần sửa.');
  }
  const planId = v12NewEditPlanId();
  const editIdByFile = new Map<string, string>();
  entries.forEach(([file], i) => editIdByFile.set(file, `e${i + 1}`));
  // Sắp theo (depth, path): lá trước, gốc sau; cùng depth theo tên.
  const sorted = [...entries].sort(([fa], [fb]) => {
    const da = graph.files.get(fa)?.depth ?? 0;
    const db = graph.files.get(fb)?.depth ?? 0;
    return da - db || fa.localeCompare(fb);
  });
  const edits: V12OrderedEdit[] = sorted.map(([file, summary]) => {
    const depth = graph.files.get(file)?.depth ?? 0;
    const dependsOn = (graph.files.get(file)?.imports ?? [])
      .filter((dep) => editIdByFile.has(dep))
      .map((dep) => editIdByFile.get(dep)!);
    return { id: editIdByFile.get(file)!, file, summary, depth, dependsOn, parallelGroup: depth };
  });
  return { planId, title, edits };
}

/**
 * Coordinator nội bộ theo dõi tiến độ từng edit trong plan.
 * Quy tắc: chỉ cho start edit khi mọi edit trong `dependsOn` đã `done`
 * (hoặc `skipped`); edit fail thì các edit phụ thuộc vào nó bị chặn
 * (không tự start, coordinator báo rõ `blockedBy`).
 */
export class V12EditCoordinator {
  readonly planId: string;
  readonly title: string;
  private readonly progress = new Map<string, V12EditProgress>();
  private readonly edits: V12OrderedEdit[];

  constructor(plan: { planId: string; title: string; edits: V12OrderedEdit[] }) {
    this.planId = plan.planId;
    this.title = plan.title;
    this.edits = [...plan.edits];
    for (const edit of this.edits) {
      this.progress.set(edit.id, { edit, status: 'pending' });
    }
  }

  /** Lấy tiến độ một edit (throw khi không có). */
  get(editId: string): V12EditProgress {
    const p = this.progress.get(editId);
    if (!p) throw new CodingV12Error('depgraph-edit-invalid', `Coordinator v12: không có edit \"${editId}\".`);
    return p;
  }

  /** Edit đã sẵn sàng chạy chưa (dependency done/skipped hết)? */
  canStart(editId: string): { ok: boolean; blockedBy: string[] } {
    const p = this.get(editId);
    const blockedBy = p.edit.dependsOn.filter((dep) => {
      const s = this.progress.get(dep)?.status;
      return s !== 'done' && s !== 'skipped';
    });
    return { ok: blockedBy.length === 0 && p.status === 'pending', blockedBy };
  }

  /** Các edit đang sẵn sàng chạy (pending + dependency xong). */
  readyEdits(): V12OrderedEdit[] {
    return this.edits.filter((e) => this.canStart(e.id).ok);
  }

  /** Bắt đầu một edit (throw khi bị chặn). */
  start(editId: string): V12EditProgress {
    const check = this.canStart(editId);
    if (!check.ok) {
      throw new CodingV12Error(
        'depgraph-edit-invalid',
        `Coordinator v12: edit \"${editId}\" chưa chạy được, đang bị chặn bởi ${check.blockedBy.join(', ') || 'trạng thái'}.`,
      );
    }
    const p = this.get(editId);
    p.status = 'running';
    p.startedAt = new Date().toISOString();
    return p;
  }

  /** Đánh dấu edit xong/thất bại/bỏ qua. */
  finish(editId: string, status: 'done' | 'failed' | 'skipped', error?: string, tokensUsed?: number): V12EditProgress {
    const p = this.get(editId);
    if (p.status !== 'running' && status !== 'skipped') {
      throw new CodingV12Error(
        'depgraph-edit-invalid',
        `Coordinator v12: edit \"${editId}\" đang ở trạng thái \"${p.status}\", không finish được.`,
      );
    }
    p.status = status;
    p.finishedAt = new Date().toISOString();
    if (error !== undefined) p.error = error;
    if (tokensUsed !== undefined) p.tokensUsed = tokensUsed;
    return p;
  }

  /** Tóm tắt tiến độ toàn bộ plan. */
  summary(): V12EditPlanSummary {
    const all = [...this.progress.values()];
    const count = (s: V12EditStatus): number => all.filter((p) => p.status === s).length;
    const done = count('done');
    const total = all.length;
    return {
      planId: this.planId,
      title: this.title,
      totalEdits: total,
      done,
      failed: count('failed'),
      running: count('running'),
      pending: count('pending'),
      skipped: count('skipped'),
      parallelGroups: new Set(this.edits.map((e) => e.parallelGroup)).size,
      overallProgress: total === 0 ? 100 : Math.round((done / total) * 100),
    };
  }

  /** Toàn bộ tiến độ (theo thứ tự edit). */
  all(): V12EditProgress[] {
    return this.edits.map((e) => this.progress.get(e.id)!);
  }
}

/** Render graph thành text ngắn (để log/UI). */
export function renderV12DepGraphSummary(graph: V12DepGraph): string {
  const s = graph.stats;
  const lines = [
    `Dependency graph v12: ${s.files} files, ${s.edges} cạnh import, ${s.components} nhóm, ${s.cycles} chu trình, sâu nhất ${s.maxDepth}, ${s.leaves} file lá.`,
    `Thứ tự áp (lá trước): ${graph.order.slice(0, 8).join(', ')}${graph.order.length > 8 ? ` … (+${graph.order.length - 8})` : ''}.`,
  ];
  if (graph.cycles.length > 0) {
    lines.push(`Chu trình: ${graph.cycles.map((c) => c.join(' → ')).join(' | ')}.`);
  }
  return lines.join('\n');
}

/** Render plan edit có thứ tự thành text ngắn. */
export function renderV12EditPlanSummary(plan: { planId: string; edits: V12OrderedEdit[] }): string {
  const groups = new Map<number, V12OrderedEdit[]>();
  for (const e of plan.edits) {
    const g = groups.get(e.parallelGroup) ?? [];
    g.push(e);
    groups.set(e.parallelGroup, g);
  }
  const lines = [`Edit plan ${plan.planId}: ${plan.edits.length} edit, ${groups.size} nhóm song song.`];
  for (const [depth, edits] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  Nhóm ${depth} (depth ${depth}): ${edits.map((e) => `${e.id}:${e.file}`).join(', ')}`);
  }
  return lines.join('\n');
}
