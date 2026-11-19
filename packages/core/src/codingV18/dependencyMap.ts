/**
 * Coding agent v18 — dependency map toàn repo (v1.40, Đội T4).
 *
 * Ý tưởng học từ survey v140 §6 (Large Codebase SDK): map dependency
 * toàn hệ thống, sắp xếp thứ tự sửa để nhiều agent làm song song
 * không xung đột — chia repo thành vùng sở hữu theo đồ thị; agent chỉ
 * sửa trong vùng của mình hoặc theo thứ tự topo đã định. Code của
 * open-bot: trích import tĩnh/động/require, resolve tương đối +
 * alias @open-bot/*, phát hiện cycle bằng Tarjan SCC, thứ tự topo
 * theo tầng (Kahn), vùng sở hữu theo tiền tố, phát hiện xung đột
 * vùng/trước khi sửa. Không gọi mạng, chỉ đọc nội dung file đưa vào.
 */

import { CodingV18Error } from './types';
import type {
  V18DepEdge,
  V18DepEdgeKind,
  V18DepGraph,
  V18DepGraphStats,
  V18DepNode,
  V18OwnershipZone,
  V18TopoLevel,
  V18TopoPlan,
  V18ZoneConflict,
  V18ZonePlan,
} from './types';

/** Loại file theo đường dẫn. */
export function v18DepNodeKind(filePath: string): V18DepNode['kind'] {
  if (filePath.includes('.test.') || filePath.includes('__tests__') || /\.spec\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) return 'test';
  if (/(^|\/)(package\.json|tsconfig.*\.json|\.eslintrc.*|vite\.config\.|vitest\.config\.)/.test(filePath) || filePath.endsWith('.json')) return 'config';
  if (/\.(ts|tsx|js|jsx|mjs|css|json|md)$/.test(filePath)) return 'source';
  return 'other';
}

interface V18RawImport {
  spec: string;
  kind: V18DepEdgeKind;
}

/** Trích mọi import từ nội dung file (static + export-from + require + dynamic import). */
export function v18ExtractImports(content: string): V18RawImport[] {
  const found: V18RawImport[] = [];
  const patterns: Array<{ pattern: RegExp; kind: V18DepEdgeKind }> = [
    { pattern: /import\s+type\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, kind: 'type' },
    { pattern: /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, kind: 'import' },
    { pattern: /export\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, kind: 'import' },
    { pattern: /require\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'import' },
    { pattern: /import\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'dynamic' },
  ];
  for (const { pattern, kind } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) found.push({ spec: match[1], kind });
    }
  }
  return found;
}

/** Chuẩn hoá path: bỏ ./ thừa, xử lý ../ */
export function v18NormalizePath(raw: string): string {
  const parts = raw.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Resolve import tương đối thành file thật trong repo (thử đuôi + index). */
export function v18ResolveRelative(fromFile: string, spec: string, knownFiles: ReadonlySet<string>): string | undefined {
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const base = v18NormalizePath(dir ? `${dir}/${spec}` : spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  return candidates.find((c) => knownFiles.has(c));
}

/**
 * Resolve alias @open-bot/<pkg>/... thành packages/<pkg>/src/...
 * (map với layout monorepo của open-bot: @open-bot/core -> packages/core/src).
 */
export function v18ResolveAlias(spec: string, knownFiles: ReadonlySet<string>): string | undefined {
  const match = /^@open-bot\/([^/]+)\/(.+)$/.exec(spec);
  if (!match) return undefined;
  const pkg = match[1];
  const rest = match[2];
  const candidates = [
    `packages/${pkg}/src/${rest}`,
    `packages/${pkg}/src/${rest}.ts`,
    `packages/${pkg}/src/${rest}.tsx`,
    `packages/${pkg}/src/${rest}/index.ts`,
  ];
  return candidates.find((c) => knownFiles.has(c));
}

/** Build đồ thị phụ thuộc từ map path -> nội dung file. */
export function v18BuildDepGraph(
  root: string,
  files: ReadonlyMap<string, string>,
  options: { now?: number } = {},
): V18DepGraph {
  if (!root || root.trim() === '') throw new CodingV18Error('root không được rỗng.');
  const knownFiles = new Set(files.keys());
  const nodes: V18DepNode[] = [];
  const edges: V18DepEdge[] = [];
  const external = new Set<string>();
  const nodeByPath = new Map<string, V18DepNode>();

  for (const filePath of [...files.keys()].sort()) {
    const node: V18DepNode = {
      path: filePath,
      kind: v18DepNodeKind(filePath),
      imports: [],
      importedBy: [],
      depth: 0,
    };
    nodes.push(node);
    nodeByPath.set(filePath, node);
  }

  for (const [filePath, content] of files) {
    const node = nodeByPath.get(filePath);
    if (!node) continue;
    const seen = new Set<string>();
    for (const raw of v18ExtractImports(content)) {
      let target: string | undefined;
      if (raw.spec.startsWith('.')) {
        target = v18ResolveRelative(filePath, raw.spec, knownFiles);
      } else if (raw.spec.startsWith('@open-bot/')) {
        target = v18ResolveAlias(raw.spec, knownFiles);
      } else {
        external.add(raw.spec);
        continue;
      }
      if (!target || target === filePath || seen.has(target)) continue;
      seen.add(target);
      node.imports.push(target);
      edges.push({ from: filePath, to: target, kind: raw.kind });
    }
  }
  for (const edge of edges) {
    const target = nodeByPath.get(edge.to);
    if (target && !target.importedBy.includes(edge.from)) target.importedBy.push(edge.from);
  }

  // Depth: độ sâu dài nhất từ file gốc (không bị import) — BFS ngược theo importedBy.
  const depthOf = new Map<string, number>();
  const visiting = new Set<string>();
  const computeDepth = (filePath: string): number => {
    if (depthOf.has(filePath)) return depthOf.get(filePath) as number;
    if (visiting.has(filePath)) return 0;
    visiting.add(filePath);
    const node = nodeByPath.get(filePath);
    const importers = node?.importedBy ?? [];
    let depth = 0;
    for (const importer of importers) {
      depth = Math.max(depth, computeDepth(importer) + 1);
    }
    visiting.delete(filePath);
    depthOf.set(filePath, depth);
    return depth;
  };
  for (const node of nodes) node.depth = computeDepth(node.path);

  const cycles = v18FindCycles({ root, nodes, edges, cycles: [], builtAt: 0, fileCount: nodes.length, externalImports: [] });
  return {
    root,
    nodes,
    edges,
    cycles,
    builtAt: options.now ?? Date.now(),
    fileCount: nodes.length,
    externalImports: [...external].sort(),
  };
}

/** Tarjan SCC: tìm cycle (SCC > 1 node, hoặc self-loop). */
export function v18FindCycles(graph: V18DepGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node.path, []);
  for (const edge of graph.edges) adjacency.get(edge.from)?.push(edge.to);

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const strongConnect = (nodePath: string): void => {
    index.set(nodePath, counter);
    lowlink.set(nodePath, counter);
    counter += 1;
    stack.push(nodePath);
    onStack.add(nodePath);
    for (const next of adjacency.get(nodePath) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        lowlink.set(nodePath, Math.min(lowlink.get(nodePath) as number, lowlink.get(next) as number));
      } else if (onStack.has(next)) {
        lowlink.set(nodePath, Math.min(lowlink.get(nodePath) as number, index.get(next) as number));
      }
    }
    if (lowlink.get(nodePath) === index.get(nodePath)) {
      const component: string[] = [];
      let popped: string | undefined;
      do {
        popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== nodePath);
      const selfLoop = component.length === 1 && (adjacency.get(component[0] as string) ?? []).includes(component[0] as string);
      if (component.length > 1 || selfLoop) cycles.push(component.sort());
    }
  };

  for (const node of graph.nodes) {
    if (!index.has(node.path)) strongConnect(node.path);
  }
  return cycles.sort((a, b) => a[0]?.localeCompare(b[0] ?? '') ?? 0);
}

/** Thứ tự topo theo tầng (Kahn): dependency trước, dependent sau. */
export function v18TopoOrder(graph: V18DepGraph): V18TopoPlan {
  const cyclicFiles = new Set(graph.cycles.flat());
  const remaining = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (cyclicFiles.has(node.path)) continue;
    remaining.set(node.path, new Set(node.imports.filter((imp) => !cyclicFiles.has(imp))));
    dependents.set(node.path, []);
  }
  for (const edge of graph.edges) {
    if (cyclicFiles.has(edge.from) || cyclicFiles.has(edge.to)) continue;
    dependents.get(edge.to)?.push(edge.from);
  }
  const levels: V18TopoLevel[] = [];
  const order: string[] = [];
  let level = 0;
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([file]) => file)
      .sort();
    if (ready.length === 0) break;
    levels.push({ level, files: ready });
    for (const file of ready) {
      remaining.delete(file);
      order.push(file);
      for (const dependent of dependents.get(file) ?? []) {
        remaining.get(dependent)?.delete(file);
      }
    }
    level += 1;
  }
  // File còn lại (không vào được tầng nào mà không nằm trong cycle đã biết):
  // vẫn liệt kê cuối để plan không mất file.
  const leftover = [...remaining.keys()].sort();
  if (leftover.length > 0) {
    levels.push({ level, files: leftover });
    order.push(...leftover);
  }
  return { order, levels, cycles: graph.cycles, blockedFiles: [...cyclicFiles].sort() };
}

/** Kế hoạch sóng song song: mỗi tầng là một sóng agent chạy cùng lúc. */
export function v18ParallelWaves(plan: V18TopoPlan): V18TopoLevel[] {
  return plan.levels;
}

export interface V18ZoneDef {
  id: string;
  name: string;
  owner: string;
  prefixes: string[];
}

/** Vùng mặc định theo layout repo open-bot (top-level dir). */
export function v18DefaultZoneDefs(): V18ZoneDef[] {
  return [
    { id: 'core', name: 'Core', owner: 'core-team', prefixes: ['packages/core/'] },
    { id: 'tools', name: 'Tools', owner: 'tools-team', prefixes: ['packages/tools/'] },
    { id: 'desktop', name: 'Desktop app', owner: 'desktop-team', prefixes: ['apps/desktop/'] },
    { id: 'cli', name: 'CLI', owner: 'cli-team', prefixes: ['apps/cli/'] },
    { id: 'tests', name: 'Tests', owner: 'qa-team', prefixes: ['tests/'] },
    { id: 'docs', name: 'Docs', owner: 'docs-team', prefixes: ['docs/'] },
  ];
}

/** Chia repo thành vùng sở hữu theo tiền tố đường dẫn. */
export function v18BuildZones(
  graph: V18DepGraph,
  zoneDefs: readonly V18ZoneDef[] = v18DefaultZoneDefs(),
): V18ZonePlan {
  const zones: V18OwnershipZone[] = zoneDefs.map((def) => ({
    id: def.id,
    name: def.name,
    owner: def.owner,
    prefixes: [...def.prefixes],
    files: [],
    fileCount: 0,
  }));
  const unassigned: string[] = [];
  for (const node of graph.nodes) {
    const zone = zones.find((z) => z.prefixes.some((p) => node.path.startsWith(p)));
    if (zone) zone.files.push(node.path);
    else unassigned.push(node.path);
  }
  for (const zone of zones) {
    zone.files.sort();
    zone.fileCount = zone.files.length;
  }
  return { zones, unassigned: unassigned.sort() };
}

/** Vùng nào sở hữu một file (undefined khi chưa gán). */
export function v18ZoneOfFile(zones: readonly V18OwnershipZone[], filePath: string): V18OwnershipZone | undefined {
  return zones.find((z) => z.prefixes.some((p) => filePath.startsWith(p)));
}

/**
 * Phát hiện xung đột trước khi sửa: agent sửa file ngoài vùng của mình
 * (cross-zone), sửa file trước dependency của nó trong topo order
 * (out-of-order), hoặc sửa file nằm trong cycle.
 */
export function v18CheckZoneConflicts(
  graph: V18DepGraph,
  zones: readonly V18OwnershipZone[],
  plannedFiles: readonly string[],
  options: { agentZone?: string; topoPlan?: V18TopoPlan } = {},
): V18ZoneConflict[] {
  const conflicts: V18ZoneConflict[] = [];
  const topo = options.topoPlan ?? v18TopoOrder(graph);
  const position = new Map(topo.order.map((file, idx) => [file, idx]));
  const cyclicFiles = new Set(graph.cycles.flat());

  for (const file of plannedFiles) {
    const zone = v18ZoneOfFile(zones, file);
    if (options.agentZone && zone && zone.id !== options.agentZone) {
      conflicts.push({
        kind: 'cross-zone',
        files: [file],
        zoneA: options.agentZone,
        zoneB: zone.id,
        message: `File "${file}" thuộc vùng "${zone.id}" (${zone.owner}), agent vùng "${options.agentZone}" không được sửa — xin quyền hoặc chuyển cho owner.`,
      });
    }
    if (!zone) {
      conflicts.push({
        kind: 'cross-zone',
        files: [file],
        zoneA: options.agentZone,
        message: `File "${file}" chưa thuộc vùng sở hữu nào — gán vùng trước khi sửa.`,
      });
    }
    if (cyclicFiles.has(file)) {
      conflicts.push({
        kind: 'cycle',
        files: [file, ...graph.cycles.find((c) => c.includes(file))?.filter((f) => f !== file) ?? []],
        message: `File "${file}" nằm trong cycle phụ thuộc — phá cycle trước khi sửa.`,
      });
    }
  }

  // Out-of-order: trong danh sách plannedFiles, file dependent đứng trước dependency của nó.
  const plannedSet = new Set(plannedFiles);
  const nodeByPath = new Map(graph.nodes.map((n) => [n.path, n]));
  for (let i = 0; i < plannedFiles.length; i += 1) {
    const file = plannedFiles[i] as string;
    const node = nodeByPath.get(file);
    if (!node) continue;
    for (const dep of node.imports) {
      if (!plannedSet.has(dep)) continue;
      const depIdx = plannedFiles.indexOf(dep);
      if (depIdx > i) {
        conflicts.push({
          kind: 'out-of-order',
          files: [file, dep],
          message: `"${file}" sửa trước "${dep}" nhưng "${file}" import "${dep}" — sửa "${dep}" trước (vị trí topo ${position.get(dep) ?? '?'} < ${position.get(file) ?? '?'}) để tránh conflict.`,
        });
      }
    }
  }
  return conflicts;
}

/** Sắp xếp danh sách file theo topo order (file chưa biết giữ cuối, giữ thứ tự gốc). */
export function v18SortByTopo(graph: V18DepGraph, files: readonly string[]): string[] {
  const topo = v18TopoOrder(graph);
  const position = new Map(topo.order.map((file, idx) => [file, idx]));
  return [...files].sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Impact set (blast radius): mọi file bị ảnh hưởng khi đổi một tập file —
 * bao đóng truyền (transitive closure) theo chiều dependents (file nào
 * import, trực tiếp hay gián tiếp, file đã đổi). Dùng để biết một PR
 * chạm tới bao nhiêu file và test nào cần chạy lại.
 */
export function v18ImpactSet(graph: V18DepGraph, changedFiles: readonly string[]): string[] {
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) dependents.set(node.path, []);
  for (const edge of graph.edges) dependents.get(edge.to)?.push(edge.from);
  const impacted = new Set<string>();
  const queue = [...changedFiles];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (impacted.has(current)) continue;
    impacted.add(current);
    for (const dependent of dependents.get(current) ?? []) {
      if (!impacted.has(dependent)) queue.push(dependent);
    }
  }
  return [...impacted].sort();
}

/** Entry point: file không bị file nào import (điểm bắt đầu chạy/chạy test). */
export function v18EntryPoints(graph: V18DepGraph): string[] {
  return graph.nodes.filter((n) => n.importedBy.length === 0).map((n) => n.path).sort();
}

/** Leaf module: file không import file nào trong repo (lá của đồ thị). */
export function v18LeafModules(graph: V18DepGraph): string[] {
  return graph.nodes.filter((n) => n.imports.length === 0).map((n) => n.path).sort();
}

/** Render impact set thành text. */
export function renderV18ImpactSet(graph: V18DepGraph, changedFiles: readonly string[]): string {
  const impacted = v18ImpactSet(graph, changedFiles);
  const direct = new Set(changedFiles);
  const indirect = impacted.filter((f) => !direct.has(f));
  return [
    `Impact set: đổi ${changedFiles.length} file (${changedFiles.join(', ') || 'không có'}) ảnh hưởng tới ${impacted.length} files.`,
    `  Trực tiếp đổi: ${changedFiles.join(', ') || '(không có)'}`,
    `  Gián tiếp ảnh hưởng: ${indirect.join(', ') || '(không có)'}`,
  ].join('\n');
}

/**
 * Orphan: file không bị file nào import và không nằm trong danh sách
 * entry quen thuộc (index/main/cli/test/config) — ứng viên chết (dead
 * code) hoặc file quên đăng ký. Entry pattern mặc định: index, main,
 * cli, *.test.*, *.config.*, *.d.ts.
 */
export function v18FindOrphans(
  graph: V18DepGraph,
  entryPatterns: readonly RegExp[] = [/index\.(ts|tsx|js|jsx|mjs)$/, /main\.(ts|tsx|js|jsx|mjs)$/, /cli\.(ts|tsx|js|jsx|mjs)$/, /\.test\./, /\.config\./, /\.d\.ts$/],
): string[] {
  return graph.nodes
    .filter((n) => n.importedBy.length === 0 && !entryPatterns.some((p) => p.test(n.path)))
    .map((n) => n.path)
    .sort();
}

/** Thống kê đồ thị phụ thuộc (fan-in/out, hub, entry/leaf). */
export function v18GraphStats(graph: V18DepGraph): V18DepGraphStats {
  const nodes = graph.nodes;
  const fanOuts = nodes.map((n) => ({ file: n.path, count: n.imports.length }));
  const fanIns = nodes.map((n) => ({ file: n.path, count: n.importedBy.length }));
  const maxFanOut = [...fanOuts].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))[0] ?? { file: '', count: 0 };
  const maxFanIn = [...fanIns].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))[0] ?? { file: '', count: 0 };
  const totalOut = fanOuts.reduce((sum, f) => sum + f.count, 0);
  const totalIn = fanIns.reduce((sum, f) => sum + f.count, 0);
  return {
    fileCount: nodes.length,
    edgeCount: graph.edges.length,
    cycleCount: graph.cycles.length,
    averageFanOut: nodes.length === 0 ? 0 : Math.round((totalOut / nodes.length) * 100) / 100,
    averageFanIn: nodes.length === 0 ? 0 : Math.round((totalIn / nodes.length) * 100) / 100,
    maxFanOut,
    maxFanIn,
    entryPoints: v18EntryPoints(graph).length,
    leafModules: v18LeafModules(graph).length,
  };
}

/** Render thống kê đồ thị thành text. */
export function renderV18GraphStats(graph: V18DepGraph): string {
  const stats = v18GraphStats(graph);
  return [
    `Dependency stats "${graph.root}": ${stats.fileCount} files, ${stats.edgeCount} edges, ${stats.cycleCount} cycle${stats.cycleCount === 1 ? '' : 's'}.`,
    `  Fan-out trung bình ${stats.averageFanOut} (cao nhất: ${stats.maxFanOut.file || '(không có)'} ${stats.maxFanOut.count}); fan-in trung bình ${stats.averageFanIn} (cao nhất: ${stats.maxFanIn.file || '(không có)'} ${stats.maxFanIn.count}).`,
    `  Entry points: ${stats.entryPoints}, leaf modules: ${stats.leafModules}.`,
  ].join('\n');
}

/** Render đồ thị phụ thuộc thành text (tóm tắt + top hub). */
export function renderV18DepGraph(graph: V18DepGraph, topK = 10): string {
  const hubs = [...graph.nodes].sort((a, b) => b.importedBy.length - a.importedBy.length).slice(0, topK);
  const lines = [
    `Dependency map "${graph.root}": ${graph.fileCount} files, ${graph.edges.length} edges, ${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'}${graph.externalImports.length > 0 ? `, ${graph.externalImports.length} external imports` : ''}.`,
    'Top hub (được import nhiều nhất):',
    ...hubs.map((n) => `  ${n.importedBy.length} importers <- ${n.path} (import ${n.imports.length} files, depth ${n.depth})`),
  ];
  if (graph.cycles.length > 0) {
    lines.push('Cycles:');
    for (const cycle of graph.cycles) lines.push(`  ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  return lines.join('\n');
}

/** Render kế hoạch topo thành text. */
export function renderV18TopoPlan(plan: V18TopoPlan): string {
  const lines = [
    `Topo order: ${plan.order.length} files, ${plan.levels.length} tầng (mỗi tầng sửa song song được)${plan.blockedFiles.length > 0 ? `, ${plan.blockedFiles.length} files bị chặn bởi cycle` : ''}.`,
    ...plan.levels.map((l) => `  Tầng ${l.level} (${l.files.length} files): ${l.files.slice(0, 8).join(', ')}${l.files.length > 8 ? ` … +${l.files.length - 8}` : ''}`),
  ];
  if (plan.blockedFiles.length > 0) lines.push(`  Bị chặn (trong cycle): ${plan.blockedFiles.join(', ')}`);
  return lines.join('\n');
}

/** Render vùng sở hữu thành text. */
export function renderV18Zones(plan: V18ZonePlan): string {
  const lines = [
    `Ownership zones: ${plan.zones.length} vùng, ${plan.unassigned.length} files chưa gán.`,
    ...plan.zones.map((z) => `  ${z.id} (${z.name}, owner ${z.owner}): ${z.fileCount} files — ${z.prefixes.join(', ')}`),
  ];
  if (plan.unassigned.length > 0) lines.push(`  Chưa gán: ${plan.unassigned.slice(0, 8).join(', ')}${plan.unassigned.length > 8 ? ` … +${plan.unassigned.length - 8}` : ''}`);
  return lines.join('\n');
}

/** Render xung đột vùng thành text. */
export function renderV18ZoneConflicts(conflicts: readonly V18ZoneConflict[]): string {
  if (conflicts.length === 0) return 'Không có xung đột vùng / thứ tự — an toàn để sửa.';
  return [
    `Phát hiện ${conflicts.length} xung đột vùng / thứ tự:`,
    ...conflicts.map((c) => `  - [${c.kind}] ${c.message}`),
  ].join('\n');
}
