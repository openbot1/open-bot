/**
 * Memory v24 — MemFS graph + snapshot + disk persistence (v1.39, Doi T1).
 *
 * Tach tu memfs.ts: duyet do thi link, snapshot cho system prompt,
 * luu/load cay ra thu muc disk, verify hash.
 */
/** --- MemFS: graph traversal + snapshot + disk persistence (phan 2) --- */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  truncateV24,
  type V24MemNode,
  V24_MAX_MEMFS_BODY_CHARS,
} from './types';
import { V24MemFS, type V24MemfsResult } from './memfs';

/** Node ke cua 1 node: node no link toi + node link toi no. */
export function memNeighborsV24(fs_: V24MemFS, rawPath: string): { outgoing: string[]; incoming: string[] } {
  const node = fs_.get(rawPath);
  const outgoing = node ? [...node.links] : [];
  const incoming: string[] = [];
  for (const other of fs_.list()) {
    if (other.path !== node?.path && other.links.includes(node?.path ?? '')) {
      incoming.push(other.path);
    }
  }
  return { outgoing, incoming };
}

/** Duyet do thi link tu 1 node goc (BFS, toi da depth + so node). */
export function walkMemGraphV24(
  fs_: V24MemFS,
  startPath: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): string[] {
  const maxDepth = opts.maxDepth ?? 2;
  const maxNodes = opts.maxNodes ?? 20;
  const start = fs_.get(startPath);
  if (!start) return [];
  const visited = new Set<string>([start.path]);
  const order: string[] = [start.path];
  let frontier: { path: string; depth: number }[] = [{ path: start.path, depth: 0 }];
  while (frontier.length > 0 && order.length < maxNodes) {
    const next: { path: string; depth: number }[] = [];
    for (const item of frontier) {
      if (item.depth >= maxDepth) continue;
      const { outgoing, incoming } = memNeighborsV24(fs_, item.path);
      for (const p of [...outgoing, ...incoming]) {
        if (visited.has(p)) continue;
        const target = fs_.get(p);
        if (!target) continue;
        visited.add(p);
        order.push(p);
        next.push({ path: p, depth: item.depth + 1 });
        if (order.length >= maxNodes) break;
      }
      if (order.length >= maxNodes) break;
    }
    frontier = next;
  }
  return order;
}

/** Link do: link toi node khong ton tai. */
export function brokenMemLinksV24(fs_: V24MemFS): { from: string; to: string }[] {
  const broken: { from: string; to: string }[] = [];
  for (const node of fs_.list()) {
    for (const target of node.links) {
      if (!fs_.get(target)) broken.push({ from: node.path, to: target });
    }
  }
  return broken;
}

/** Tom tat cay MemFS cho system prompt: thu muc + node quan trong. */
export function snapshotMemfsV24(
  fs_: V24MemFS,
  opts: { budgetChars?: number; includePaths?: string[] } = {},
): { tree: string[]; nodes: Record<string, string>; chars: number; truncated: string[] } {
  const budget = opts.budgetChars ?? 4000;
  const tree = fs_.tree();
  const nodes: Record<string, string> = {};
  const truncated: string[] = [];
  let chars = 0;
  const header = `Memory tree (${tree.length} files):\n${tree.map((p) => `- ${p}`).join('\n')}\n`;
  chars += header.length;
  const ordered = opts.includePaths && opts.includePaths.length > 0
    ? [...opts.includePaths, ...tree.filter((p) => !opts.includePaths!.includes(p))]
    : tree;
  for (const p of ordered) {
    if (chars >= budget) {
      truncated.push(p);
      continue;
    }
    const node = fs_.get(p);
    if (!node) continue;
    const full = `# ${node.title}\n${node.body}`.trim();
    const remaining = budget - chars;
    if (full.length <= remaining) {
      nodes[p] = full;
      chars += full.length + 1;
    } else if (remaining > 120) {
      nodes[p] = truncateV24(full, remaining);
      chars = budget;
      truncated.push(p);
    } else {
      truncated.push(p);
    }
  }
  return { tree, nodes, chars, truncated };
}

/** Ten file manifest + lich su trong thu muc MemFS tren disk. */
export const V24_MEMFS_MANIFEST_FILE = 'index.json';
export const V24_MEMFS_VERSIONS_FILE = 'versions.jsonl';

/** Ghi toan bo cay MemFS ra thu muc disk (1 file .md / node). */
export function saveMemfsToDirV24(
  fs_: V24MemFS,
  dir: string,
): V24MemfsResult<{ files: number; dir: string }> {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const nodes = fs_.list({ includeDeleted: true });
    let files = 0;
    for (const node of nodes) {
      const filePath = path.join(dir, ...node.path.split('/'));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const header = [
        `<!-- v24:path=${node.path} version=${node.version} updatedAt=${node.updatedAt} updatedBy=${node.updatedBy} deleted=${node.deleted ? '1' : '0'} hash=${node.contentHash} -->`,
      ].join('\n');
      fs.writeFileSync(filePath, `${header}\n# ${node.title}\n\n${node.body.trim()}\n`, 'utf8');
      files++;
    }
    const manifest = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({
        path: n.path,
        title: n.title,
        version: n.version,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        updatedBy: n.updatedBy,
        contentHash: n.contentHash,
        deleted: n.deleted,
        scope: n.scope,
        links: n.links,
      })),
    };
    fs.writeFileSync(path.join(dir, V24_MEMFS_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');
    const lines: string[] = [];
    for (const node of nodes) {
      for (const v of fs_.history(node.path)) {
        lines.push(JSON.stringify(v));
      }
    }
    fs.writeFileSync(path.join(dir, V24_MEMFS_VERSIONS_FILE), lines.join('\n'), 'utf8');
    return { ok: true, value: { files, dir } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Doc cay MemFS tu thu muc disk (uu tien manifest, fallback quet .md). */
export function loadMemfsFromDirV24(dir: string): V24MemfsResult<V24MemFS> {
  try {
    const out = new V24MemFS();
    const manifestPath = path.join(dir, V24_MEMFS_MANIFEST_FILE);
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        nodes: {
          path: string;
          title: string;
          version: number;
          createdAt: string;
          updatedAt: string;
          updatedBy: string;
          contentHash: string;
          deleted: boolean;
          scope: V24MemNode['scope'];
          links: string[];
        }[];
      };
      for (const meta of manifest.nodes ?? []) {
        const filePath = path.join(dir, ...meta.path.split('/'));
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf8');
        const body = raw
          .split('\n')
          .filter((line) => !line.startsWith('<!-- v24:path='))
          .join('\n')
          .replace(/^# .*\n/, '')
          .trim();
        const node: V24MemNode = {
          path: meta.path,
          title: meta.title,
          body,
          links: meta.links ?? [],
          version: meta.version,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          updatedBy: meta.updatedBy,
          contentHash: meta.contentHash,
          deleted: meta.deleted,
          scope: meta.scope,
        };
        // Ghi thang vao map noi bo qua add/edit cong khai neu co the;
        // o day dung cach don gian: add roi sua version bang lich su.
        (out as unknown as { nodes: Map<string, V24MemNode> }).nodes.set(meta.path, node);
      }
      const versionsPath = path.join(dir, V24_MEMFS_VERSIONS_FILE);
      if (fs.existsSync(versionsPath)) {
        const versionsMap = (out as unknown as { versions: Map<string, import('./types').V24MemVersion[]> }).versions;
        for (const line of fs.readFileSync(versionsPath, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const v = JSON.parse(trimmed) as import('./types').V24MemVersion;
            const list = versionsMap.get(v.path) ?? [];
            list.push(v);
            versionsMap.set(v.path, list);
          } catch {
            // Bo qua dong lich su hong — khong lam hong ca cay.
          }
        }
      }
      return { ok: true, value: out };
    }
    // Fallback: quet .md khi khong co manifest.
    if (!fs.existsSync(dir)) return { ok: true, value: out };
    const walk = (d: string, prefix: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full, rel);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const raw = fs.readFileSync(full, 'utf8');
          const body = raw.replace(/^# .*\n/, '').trim();
          const res = out.addNode(rel, body, { updatedBy: 'load' });
          if (!res.ok) {
            // Path khong hop le: bo qua file do.
          }
        }
      }
    };
    walk(dir, '');
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Kiem tra tinh nhat quan cua cay: hash body co khop hash da luu khong. */
export function verifyMemfsHashesV24(fs_: V24MemFS): { path: string; expected: string; actual: string }[] {
  const mismatches: { path: string; expected: string; actual: string }[] = [];
  for (const node of fs_.list({ includeDeleted: true })) {
    const actual = ((): string => {
      let hash = 0x811c9dc5;
      const text = node.body;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    })();
    if (actual !== node.contentHash) {
      mismatches.push({ path: node.path, expected: node.contentHash, actual });
    }
  }
  return mismatches;
}

/** Gioi han body khi import tu ben ngoai (cat ngan, khong throw). */
export function clampMemBodyV24(body: string): string {
  return body.length > V24_MAX_MEMFS_BODY_CHARS
    ? body.slice(0, V24_MAX_MEMFS_BODY_CHARS)
    : body;
}
