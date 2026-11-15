/**
 * Versioned memory blocks — block là artifact version được, kiểu
 * Letta Code (v1.10, Đội T1).
 *
 * Mỗi block (persona / human / project / ...) có lịch sử phiên bản
 * riêng: commit ghi snapshot nội dung + message + cha + nhánh;
 * branch tách dòng phát triển; checkout đổi nhánh hiện tại; rollback
 * về phiên bản cũ bằng cách ghi một phiên bản MỚI mang nội dung cũ
 * (KHÔNG viết lại lịch sử — lịch sử chỉ thêm, không bao giờ mất);
 * diff từng dòng giữa hai phiên bản.
 *
 * Version store TỰ IMPLEMENT trên file JSON (không dùng git thật):
 * đơn giản, test được, không phụ thuộc repo git của user. Mỗi block
 * lưu một file `<blockId>.json` trong thư mục blocks; toàn bộ file
 * cũng có thể nhúng vào V10MemoryFile của manager.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoalaKind, V10BlockDiff, V10BlockVersion, V10MemoryBlock, V10RollbackReport } from './types';

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface V10BlockStoreOptions {
  /** Thư mục lưu file block (optional — không có thì chỉ giữ RAM). */
  dir?: string;
}

export class V10BlockVersionStore {
  private readonly blocks = new Map<string, V10MemoryBlock>();
  private readonly dir: string | undefined;
  private counter = 0;

  constructor(opts: V10BlockStoreOptions = {}) {
    this.dir = opts.dir;
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.loadAllFromDir();
    }
  }

  private nextId(label: string): string {
    this.counter += 1;
    const slug = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'block';
    return `v10b-${slug}-${this.counter}`;
  }

  /** Tạo block mới với phiên bản 1 (nội dung ban đầu). */
  createBlock(label: string, kind: CoalaKind, initialContent: string, author = 'system'): V10MemoryBlock {
    const now = new Date().toISOString();
    const block: V10MemoryBlock = {
      id: this.nextId(label),
      label,
      kind,
      currentBranch: 'main',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          content: initialContent,
          message: 'Initial version',
          parent: null,
          branch: 'main',
          author,
          createdAt: now,
          contentHash: sha256Hex(initialContent),
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    this.blocks.set(block.id, block);
    this.persist(block);
    return this.clone(block);
  }

  getBlock(id: string): V10MemoryBlock | undefined {
    const block = this.blocks.get(id);
    return block ? this.clone(block) : undefined;
  }

  listBlocks(): V10MemoryBlock[] {
    return [...this.blocks.values()].map((b) => this.clone(b));
  }

  /** Nội dung hiện tại của block trên nhánh hiện tại. */
  readCurrent(id: string): { content: string; version: number; branch: string } | null {
    const block = this.blocks.get(id);
    if (!block) return null;
    const version = block.versions.find(
      (v) => v.version === block.currentVersion && v.branch === block.currentBranch,
    );
    if (!version) return null;
    return { content: version.content, version: version.version, branch: version.branch };
  }

  /** Commit nội dung mới lên nhánh hiện tại (phiên bản = max+1). */
  commit(id: string, content: string, message: string, author = 'system'): V10BlockVersion {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    const nextVersion = Math.max(...block.versions.map((v) => v.version)) + 1;
    const now = new Date().toISOString();
    const version: V10BlockVersion = {
      version: nextVersion,
      content,
      message,
      parent: block.currentVersion,
      branch: block.currentBranch,
      author,
      createdAt: now,
      contentHash: sha256Hex(content),
    };
    block.versions.push(version);
    block.currentVersion = nextVersion;
    block.updatedAt = now;
    this.persist(block);
    return { ...version };
  }

  /**
   * Tạo nhánh mới từ phiên bản hiện tại (hoặc từ `fromVersion`).
   * Nhánh mới trỏ tới đúng phiên bản đó; commit sau đó trên nhánh
   * mới sẽ tách lịch sử khỏi main.
   */
  branch(id: string, branchName: string, fromVersion?: number): V10BlockVersion {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    const name = branchName.trim();
    if (name === '' || name === block.currentBranch) {
      throw new Error(`Invalid branch name: "${branchName}"`);
    }
    if (block.versions.some((v) => v.branch === name)) {
      throw new Error(`Branch already exists: "${name}"`);
    }
    const base = fromVersion ?? block.currentVersion;
    const baseVersion = block.versions.find((v) => v.version === base);
    if (!baseVersion) throw new Error(`Base version not found: ${base}`);
    const nextVersion = Math.max(...block.versions.map((v) => v.version)) + 1;
    const now = new Date().toISOString();
    // Phiên bản "mở nhánh": cùng nội dung với base, parent = base,
    // branch = nhánh mới — lịch sử phân nhánh thấy rõ.
    const version: V10BlockVersion = {
      version: nextVersion,
      content: baseVersion.content,
      message: `Branch "${name}" from v${base}`,
      parent: base,
      branch: name,
      author: 'system',
      createdAt: now,
      contentHash: baseVersion.contentHash,
    };
    block.versions.push(version);
    block.currentBranch = name;
    block.currentVersion = nextVersion;
    block.updatedAt = now;
    this.persist(block);
    return { ...version };
  }

  /** Chuyển nhánh hiện tại (tới phiên bản mới nhất của nhánh đó). */
  checkout(id: string, branchName: string): { content: string; version: number; branch: string } {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    const onBranch = block.versions.filter((v) => v.branch === branchName);
    if (onBranch.length === 0) throw new Error(`Branch not found: "${branchName}"`);
    const latest = onBranch.reduce((a, b) => (b.version > a.version ? b : a));
    block.currentBranch = branchName;
    block.currentVersion = latest.version;
    block.updatedAt = new Date().toISOString();
    this.persist(block);
    return { content: latest.content, version: latest.version, branch: branchName };
  }

  /** Danh sách nhánh của block (kèm phiên bản mới nhất mỗi nhánh). */
  branches(id: string): { branch: string; latestVersion: number }[] {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    const map = new Map<string, number>();
    for (const v of block.versions) {
      const cur = map.get(v.branch) ?? 0;
      if (v.version > cur) map.set(v.branch, v.version);
    }
    return [...map.entries()]
      .map(([branch, latestVersion]) => ({ branch, latestVersion }))
      .sort((a, b) => a.branch.localeCompare(b.branch));
  }

  /** Lịch sử phiên bản của block, mới nhất trước. */
  log(id: string): V10BlockVersion[] {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    return [...block.versions].sort((a, b) => b.version - a.version).map((v) => ({ ...v }));
  }

  /**
   * Rollback về phiên bản cũ: ghi phiên bản MỚI trên nhánh hiện tại
   * mang nội dung của phiên bản đích. Lịch sử không bị viết lại —
   * ai xem log vẫn thấy cả lần rollback.
   */
  rollback(id: string, toVersion: number, message?: string, author = 'system'): V10RollbackReport {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    const target = block.versions.find((v) => v.version === toVersion);
    if (!target) throw new Error(`Version not found: ${toVersion}`);
    const fromVersion = block.currentVersion;
    const created = this.commit(
      id,
      target.content,
      message ?? `Rollback to v${toVersion} (from v${fromVersion})`,
      author,
    );
    return {
      blockId: id,
      fromVersion,
      toVersion,
      newVersion: created.version,
      branch: block.currentBranch,
      message: created.message,
    };
  }

  /** Diff từng dòng giữa hai phiên bản (LCS đơn giản, đủ cho block ngắn). */
  diff(id: string, fromVersion: number, toVersion: number): V10BlockDiff {
    const block = this.blocks.get(id);
    if (!block) throw new Error(`V10 block not found: ${id}`);
    const from = block.versions.find((v) => v.version === fromVersion);
    const to = block.versions.find((v) => v.version === toVersion);
    if (!from) throw new Error(`Version not found: ${fromVersion}`);
    if (!to) throw new Error(`Version not found: ${toVersion}`);
    const a = from.content.split('\n');
    const b = to.content.split('\n');
    const lines = diffLines(a, b);
    return {
      blockId: id,
      fromVersion,
      toVersion,
      lines,
      added: lines.filter((l) => l.type === 'add').length,
      removed: lines.filter((l) => l.type === 'del').length,
    };
  }

  /** Nạp block đã có (manager dùng khi load V10MemoryFile). */
  importBlock(block: V10MemoryBlock): void {
    this.blocks.set(block.id, this.clone(block));
  }

  private clone(block: V10MemoryBlock): V10MemoryBlock {
    return {
      ...block,
      versions: block.versions.map((v) => ({ ...v })),
    };
  }

  private persist(block: V10MemoryBlock): void {
    if (!this.dir) return;
    try {
      fs.writeFileSync(
        path.join(this.dir, `${block.id}.json`),
        JSON.stringify(block, null, 2),
        'utf8',
      );
    } catch {
      // Ghi file lỗi thì thôi — RAM vẫn đúng, lần save sau thử lại.
    }
  }

  private loadAllFromDir(): void {
    if (!this.dir) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as V10MemoryBlock;
        if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.versions)) {
          this.blocks.set(parsed.id, parsed);
          const num = Number(parsed.id.split('-').pop());
          if (Number.isInteger(num) && num > this.counter) this.counter = num;
        }
      } catch {
        // File hỏng thì bỏ qua file đó, không chặn cả store.
      }
    }
  }
}

/**
 * Diff từng dòng bằng LCS (bảng động) — block memory ngắn (vài KB)
 * nên O(n·m) là đủ; không cần thuật toán Myers phức tạp.
 */
export function diffLines(
  a: string[],
  b: string[],
): { type: 'same' | 'add' | 'del'; text: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return out;
}
