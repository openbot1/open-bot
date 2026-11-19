/**
 * Memory v24 — MemFS store (v1.39, Doi T1).
 *
 * Y tuong MemFS (chi y tuong): memory la cay file Markdown co
 * version, agent tu doc/sua memory cua chinh minh qua tool, thu
 * muc memory luon nam trong system prompt. SoMem (chi y tuong):
 * memory doc co link cheo [[path]], duyet theo do thi thay vi
 * list phang.
 *
 * Tu thiet ke lai hoan toan cho open-bot, chay local:
 *  - Cay node key theo path ("profile/preferences.md"); moi node
 *    co version + contentHash + lich su version day du.
 *  - Serialize ra thu muc: 1 file .md / node + manifest JSON
 *    (index.json) + lich su version (versions.jsonl). Load lai
 *    duoc day du tu disk, khong mat version.
 *  - Parse Markdown: dong "# title" dau tien lam title, link
 *    [[path]] lam canh do thi, front-matter `---` duoc bo qua
 *    khi doc body (van giu nguyen trong file goc khi serialize
 *    lai? khong — serialize chi ghi title + body + link; don
 *    gian, xac dinh).
 *  - Snapshot cho system prompt: luon co cay thu muc + node
 *    quan trong nhat trong ngan sach ky tu; node nao vuot
 *    ngan sach thi chi dua title + dong dau.
 *  - Edit di qua validation: path an toan (khong "..", khong
 *    tuyet doi), body gioi han ky tu, link toi node khong ton
 *    tai van duoc ghi nhan (link do) nhung bao cao o health.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  contentHashV24,
  isoAtV24,
  makeV24Id,
  truncateV24,
  type V24MemNode,
  type V24MemVersion,
  type V24Scope,
  V24_MAX_LINKS_PER_NODE,
  V24_MAX_MEMFS_BODY_CHARS,
  V24_MAX_MEMFS_NODES,
} from './types';

/** Ket qua thao tac MemFS (khong throw tru lap trinh sai dau vao). */
export interface V24MemfsResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): V24MemfsResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): V24MemfsResult<T> {
  return { ok: false, error };
}

/** Kiem tra path MemFS hop le: tuong doi, .md, khong ".." / tuyet doi. */
export function isValidMemPathV24(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.length > 200) return false;
  if (raw.startsWith('/') || raw.startsWith('\\')) return false;
  if (raw.includes('..') || raw.includes('\0')) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.\- ]*\.md$/.test(raw)) return false;
  const parts = raw.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  return true;
}

/** Chuan hoa path: gom slash thua, bo "./" dau. */
export function normalizeMemPathV24(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
}

/** Trich link [[path]] tu body Markdown. */
export function extractMemLinksV24(body: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]\n]{1,200})\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = normalizeMemPathV24(m[1].trim());
    if (target && isValidMemPathV24(target) && !seen.has(target)) {
      seen.add(target);
      links.push(target);
      if (links.length >= V24_MAX_LINKS_PER_NODE) break;
    }
  }
  return links;
}

/** Trich title tu Markdown: dong "# ..." dau tien, neu khong co thi ten file. */
export function extractMemTitleV24(body: string, fallbackPath: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      const title = trimmed.slice(2).trim();
      if (title) return title.slice(0, 200);
    }
  }
  const base = fallbackPath.split('/').pop() ?? fallbackPath;
  return base.replace(/\.md$/, '').replace(/[-_]/g, ' ');
}

/** Render 1 node thanh Markdown day du (title + body). */
export function renderMemNodeV24(node: V24MemNode): string {
  return `# ${node.title}\n\n${node.body.trim()}\n`;
}

/** Parse Markdown thanh {title, body, links} (bo dong title khoi body). */
export function parseMemMarkdownV24(
  markdown: string,
  fallbackPath: string,
): { title: string; body: string; links: string[] } {
  const lines = markdown.split('\n');
  let titleLine = -1;
  let title = '';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('# ')) {
      titleLine = i;
      title = trimmed.slice(2).trim().slice(0, 200);
      break;
    }
    if (trimmed !== '' && !trimmed.startsWith('---')) break;
  }
  if (titleLine === -1) title = extractMemTitleV24('', fallbackPath);
  const bodyLines = titleLine >= 0
    ? [...lines.slice(0, titleLine), ...lines.slice(titleLine + 1)]
    : lines;
  const body = bodyLines.join('\n').trim();
  return { title, body, links: extractMemLinksV24(body) };
}

/** Cay MemFS: node + lich su version, chay in-memory, persist ra disk. */
export class V24MemFS {
  private nodes = new Map<string, V24MemNode>();
  private versions = new Map<string, V24MemVersion[]>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** So node dang co (khong tinh tombstone). */
  get size(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (!node.deleted) n++;
    return n;
  }

  /** Lay node theo path (null neu khong co / da xoa mem). */
  get(rawPath: string): V24MemNode | null {
    const p = normalizeMemPathV24(rawPath);
    const node = this.nodes.get(p);
    if (!node || node.deleted) return null;
    return { ...node, links: [...node.links] };
  }

  /** Lay ca tombstone (dung cho audit / khoi phuc). */
  getIncludingDeleted(rawPath: string): V24MemNode | null {
    const node = this.nodes.get(normalizeMemPathV24(rawPath));
    if (!node) return null;
    return { ...node, links: [...node.links] };
  }

  /** Liet ke node (mac dinh moi nhat truoc), loc theo prefix thu muc. */
  list(opts: { prefix?: string; includeDeleted?: boolean; limit?: number } = {}): V24MemNode[] {
    const out: V24MemNode[] = [];
    for (const node of this.nodes.values()) {
      if (!opts.includeDeleted && node.deleted) continue;
      if (opts.prefix && !node.path.startsWith(opts.prefix)) continue;
      out.push({ ...node, links: [...node.links] });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }

  /** Cay thu muc: danh sach path da sap xep. */
  tree(): string[] {
    return this.list()
      .map((n) => n.path)
      .sort();
  }

  /** Tao node moi. Path da ton tai (chua xoa) -> loi, dung editNode. */
  addNode(
    rawPath: string,
    body: string,
    opts: { updatedBy?: string; scope?: V24Scope; reason?: string } = {},
  ): V24MemfsResult<V24MemNode> {
    const p = normalizeMemPathV24(rawPath);
    if (!isValidMemPathV24(p)) return fail(`Path MemFS khong hop le: "${rawPath}".`);
    if (this.nodes.has(p) && !this.nodes.get(p)!.deleted) {
      return fail(`Node "${p}" da ton tai — dung editNode de sua.`);
    }
    if (body.length > V24_MAX_MEMFS_BODY_CHARS) {
      return fail(`Body vuot ${V24_MAX_MEMFS_BODY_CHARS} ky tu.`);
    }
    if (this.size >= V24_MAX_MEMFS_NODES) {
      return fail(`Cay MemFS da dat gioi han ${V24_MAX_MEMFS_NODES} node.`);
    }
    const nowIso = isoAtV24(this.now());
    const parsed = parseMemMarkdownV24(body, p);
    const node: V24MemNode = {
      path: p,
      title: parsed.title,
      body: parsed.body,
      links: parsed.links,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      updatedBy: opts.updatedBy ?? '',
      contentHash: contentHashV24(parsed.body),
      deleted: false,
      scope: opts.scope ?? { userId: '', agentId: '', runId: '', appId: '' },
    };
    this.nodes.set(p, node);
    const version: V24MemVersion = {
      path: p,
      version: 1,
      body: parsed.body,
      updatedBy: node.updatedBy,
      updatedAt: nowIso,
      reason: opts.reason ?? 'create',
      contentHash: node.contentHash,
    };
    this.versions.set(p, [version]);
    return ok({ ...node, links: [...node.links] });
  }

  /** Sua node: version +1, lich su duoc ghi lai. Body giong het -> no-op. */
  editNode(
    rawPath: string,
    body: string,
    opts: { updatedBy?: string; reason?: string } = {},
  ): V24MemfsResult<V24MemNode> {
    const p = normalizeMemPathV24(rawPath);
    if (!isValidMemPathV24(p)) return fail(`Path MemFS khong hop le: "${rawPath}".`);
    const node = this.nodes.get(p);
    if (!node || node.deleted) return fail(`Khong co node "${p}" de sua.`);
    if (body.length > V24_MAX_MEMFS_BODY_CHARS) {
      return fail(`Body vuot ${V24_MAX_MEMFS_BODY_CHARS} ky tu.`);
    }
    const parsed = parseMemMarkdownV24(body, p);
    if (parsed.body === node.body && parsed.title === node.title) {
      return ok({ ...node, links: [...node.links] });
    }
    const nowIso = isoAtV24(this.now());
    node.title = parsed.title;
    node.body = parsed.body;
    node.links = parsed.links;
    node.version += 1;
    node.updatedAt = nowIso;
    node.updatedBy = opts.updatedBy ?? node.updatedBy;
    node.contentHash = contentHashV24(parsed.body);
    const history = this.versions.get(p) ?? [];
    history.push({
      path: p,
      version: node.version,
      body: parsed.body,
      updatedBy: node.updatedBy,
      updatedAt: nowIso,
      reason: opts.reason ?? 'edit',
      contentHash: node.contentHash,
    });
    this.versions.set(p, history);
    return ok({ ...node, links: [...node.links] });
  }

  /** Xoa mem node (tombstone): giu lich su, khong con thay o list/tree. */
  deleteNode(rawPath: string, opts: { updatedBy?: string; reason?: string } = {}): V24MemfsResult<V24MemNode> {
    const p = normalizeMemPathV24(rawPath);
    const node = this.nodes.get(p);
    if (!node || node.deleted) return fail(`Khong co node "${p}" de xoa.`);
    node.deleted = true;
    node.version += 1;
    node.updatedAt = isoAtV24(this.now());
    node.updatedBy = opts.updatedBy ?? node.updatedBy;
    const history = this.versions.get(p) ?? [];
    history.push({
      path: p,
      version: node.version,
      body: node.body,
      updatedBy: node.updatedBy,
      updatedAt: node.updatedAt,
      reason: opts.reason ?? 'delete',
      contentHash: node.contentHash,
    });
    this.versions.set(p, history);
    return ok({ ...node, links: [...node.links] });
  }

  /** Khoi phuc node da xoa mem. */
  restoreNode(rawPath: string, opts: { updatedBy?: string } = {}): V24MemfsResult<V24MemNode> {
    const p = normalizeMemPathV24(rawPath);
    const node = this.nodes.get(p);
    if (!node || !node.deleted) return fail(`Khong co node "${p}" dang bi xoa de khoi phuc.`);
    node.deleted = false;
    node.version += 1;
    node.updatedAt = isoAtV24(this.now());
    node.updatedBy = opts.updatedBy ?? node.updatedBy;
    return ok({ ...node, links: [...node.links] });
  }

  /** Lich su version cua 1 node (moi nhat cuoi). */
  history(rawPath: string): V24MemVersion[] {
    const list = this.versions.get(normalizeMemPathV24(rawPath)) ?? [];
    return list.map((v) => ({ ...v }));
  }

  /** Khoi phuc node ve 1 version cu (tao version moi, khong xoa lich su). */
  revertToVersion(
    rawPath: string,
    version: number,
    opts: { updatedBy?: string } = {},
  ): V24MemfsResult<V24MemNode> {
    const p = normalizeMemPathV24(rawPath);
    const node = this.nodes.get(p);
    if (!node) return fail(`Khong co node "${p}".`);
    const target = (this.versions.get(p) ?? []).find((v) => v.version === version);
    if (!target) return fail(`Node "${p}" khong co version ${version}.`);
    const nowIso = isoAtV24(this.now());
    node.body = target.body;
    node.title = extractMemTitleV24(target.body, p);
    node.links = extractMemLinksV24(target.body);
    node.version += 1;
    node.updatedAt = nowIso;
    node.updatedBy = opts.updatedBy ?? node.updatedBy;
    node.contentHash = contentHashV24(target.body);
    node.deleted = false;
    const history = this.versions.get(p) ?? [];
    history.push({
      path: p,
      version: node.version,
      body: target.body,
      updatedBy: node.updatedBy,
      updatedAt: nowIso,
      reason: `revert to v${version}`,
      contentHash: node.contentHash,
    });
    this.versions.set(p, history);
    return ok({ ...node, links: [...node.links] });
  }
}
