/**
 * Memory v7 — git-backed memory projection (v1.06, Đội T1).
 *
 * Ý tưởng học từ Letta-code local backend (MemFS): memory của agent
 * là một repo git local — mỗi block là một file Markdown, mỗi lần sửa
 * là một commit. Lợi ích: `git log` cho lịch sử từng block, `git
 * blame` cho biết dòng nào do ai viết lúc nào, `git diff` cho thấy
 * đúng cái gì đã đổi, và toàn bộ memory có thể sao lưu / đối chiếu
 * bằng git thay vì một file JSON mờ mịt.
 *
 * Bố cục trong workspace:
 *   .open-bot/memory-v7/            <- repo git RIÊNG (không phải repo của workspace)
 *     blocks/<label>.md             <- một file cho một block, có frontmatter
 *     history.jsonl                 <- log dự phòng khi máy không có git
 *
 * File block:
 *   ---
 *   label: human
 *   tier: semantic
 *   scope: system
 *   description: Sự thật về người dùng
 *   readOnly: false
 *   version: 3
 *   createdAt: 2026-11-14T...
 *   updatedAt: 2026-11-14T...
 *   ---
 *   <nội dung block>
 *
 * Guardrail (quan trọng nhất của module này): block `scope: system`
 * (vd `human`, `persona` — phần "hệ thống" của prompt) chỉ user hoặc
 * hệ thống mới sửa được; agent (`actor` bắt đầu bằng `agent:`) gọi
 * sửa sẽ bị chặn ngay tại đây, trước cả khi ghi file. Block user thì
 * agent sửa được (tool layer vẫn cần approval của user trước).
 *
 * Khi máy không có git: mọi thao tác file vẫn chạy bình thường, lịch
 * sử rơi về `history.jsonl` (append-only, giống blockHistory của v3);
 * `gitAvailable` cho caller biết để báo đúng cho user/UI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizeBlockLabel, isValidBlockLabel, DEFAULT_BLOCK_CHAR_LIMIT, MAX_BLOCK_CHAR_LIMIT, MIN_BLOCK_CHAR_LIMIT } from './blocks';
import type { MemoryTier } from './tiers';
import { isValidTier } from './tiers';

export const MEMORY_V7_ROOT_REL_PATH = path.join('.open-bot', 'memory-v7');
export const MEMORY_V7_BLOCKS_DIR = 'blocks';
export const MEMORY_V7_HISTORY_REL_PATH = path.join('.open-bot', 'memory-v7', 'history.jsonl');

/** Block hệ thống — agent không được sửa (chỉ user/system). */
export const V7_SYSTEM_BLOCK_LABELS = ['human', 'persona'] as const;
/** Phạm vi của block: `system` = phần hệ thống của prompt, `user` = block user tạo. */
export type V7BlockScope = 'system' | 'user';

export interface V7MemoryBlock {
  label: string;
  tier: MemoryTier;
  scope: V7BlockScope;
  description: string;
  content: string;
  readOnly: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Commit git gần nhất chạm block này (rỗng khi git không khả dụng). */
  commit?: string;
}

export interface V7BlockInput {
  label: string;
  content?: string;
  description?: string;
  tier?: MemoryTier;
  /** Vắng = tự suy ra: `human`/`persona` là system, còn lại là user. */
  scope?: V7BlockScope;
  readOnly?: boolean;
  charLimit?: number;
}

export interface V7BlockHistoryEntry {
  commit: string;
  author: string;
  at: string;
  message: string;
  version: number;
  content: string;
  /** Số ký tự của content ở version này. */
  chars: number;
}

export interface V7BlameEntry {
  commit: string;
  author: string;
  at: string;
  lines: number;
  /** Dòng đầu tiên do commit này viết (1-based). */
  firstLine: number;
}

export interface V7HistoryLogEntry {
  at: string;
  actor: string;
  action: string;
  label: string;
  version: number;
  content: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash nội dung của một block (dùng cho cache recompile ở promptRecompile). */
export function hashV7BlockContent(content: string): string {
  return sha256(content);
}

function frontmatterValue(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

function parseBlockFile(raw: string, label: string): V7MemoryBlock {
  const lines = raw.split('\n');
  let body = raw;
  let tier: MemoryTier = 'semantic';
  let scope: V7BlockScope = 'user';
  let description = '';
  let readOnly = false;
  let version = 1;
  let createdAt = '';
  let updatedAt = '';
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end !== -1) {
      const fm = lines.slice(1, end);
      const t = frontmatterValue(fm, 'tier');
      if (t && isValidTier(t)) tier = t;
      const s = frontmatterValue(fm, 'scope');
      if (s === 'system' || s === 'user') scope = s;
      description = frontmatterValue(fm, 'description') ?? '';
      readOnly = frontmatterValue(fm, 'readOnly') === 'true';
      const v = Number(frontmatterValue(fm, 'version'));
      if (Number.isFinite(v) && v >= 1) version = Math.floor(v);
      createdAt = frontmatterValue(fm, 'createdAt') ?? '';
      updatedAt = frontmatterValue(fm, 'updatedAt') ?? '';
      body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
    }
  }
  const now = new Date().toISOString();
  return {
    label,
    tier,
    scope,
    description,
    content: body,
    readOnly,
    version,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
}

function renderBlockFile(block: V7MemoryBlock): string {
  const fm = [
    '---',
    `label: ${block.label}`,
    `tier: ${block.tier}`,
    `scope: ${block.scope}`,
    `description: ${block.description.replace(/\n/g, ' ')}`,
    `readOnly: ${block.readOnly ? 'true' : 'false'}`,
    `version: ${block.version}`,
    `createdAt: ${block.createdAt}`,
    `updatedAt: ${block.updatedAt}`,
    '---',
    '',
  ].join('\n');
  return fm + block.content;
}

export class GitMemoryProjection {
  private readonly rootDir: string;
  private readonly blocksDir: string;
  private readonly historyPath: string;
  private gitChecked: boolean | null = null;

  constructor(workspaceDir: string) {
    this.rootDir = path.join(workspaceDir, MEMORY_V7_ROOT_REL_PATH);
    this.blocksDir = path.join(this.rootDir, MEMORY_V7_BLOCKS_DIR);
    this.historyPath = path.join(workspaceDir, MEMORY_V7_HISTORY_REL_PATH);
  }

  /** Thư mục gốc của repo memory-v7. */
  get dir(): string {
    return this.rootDir;
  }

  /** true khi máy có git CLI và repo đã (hoặc sẽ) khởi tạo được. */
  gitAvailable(): boolean {
    if (this.gitChecked !== null) return this.gitChecked;
    try {
      execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      this.gitChecked = true;
    } catch {
      this.gitChecked = false;
    }
    return this.gitChecked;
  }

  /** Khởi tạo repo git local (idempotent). Trả false khi không có git. */
  ensureRepo(): boolean {
    fs.mkdirSync(this.blocksDir, { recursive: true });
    if (!this.gitAvailable()) return false;
    try {
      const gitDir = path.join(this.rootDir, '.git');
      if (!fs.existsSync(gitDir)) {
        execFileSync('git', ['init', '--quiet'], { cwd: this.rootDir, stdio: 'ignore', timeout: 10000 });
        execFileSync('git', ['config', 'user.name', 'open-bot'], { cwd: this.rootDir, stdio: 'ignore', timeout: 5000 });
        execFileSync('git', ['config', 'user.email', 'open-bot@localhost'], { cwd: this.rootDir, stdio: 'ignore', timeout: 5000 });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: this.rootDir, stdio: 'ignore', timeout: 5000 });
        fs.writeFileSync(path.join(this.rootDir, '.gitignore'), 'history.jsonl\n', { mode: 0o600 });
        execFileSync('git', ['add', '.gitignore'], { cwd: this.rootDir, stdio: 'ignore', timeout: 5000 });
        execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'memory-v7: init'], { cwd: this.rootDir, stdio: 'ignore', timeout: 10000 });
      }
      return true;
    } catch {
      return false;
    }
  }

  private blockPath(label: string): string {
    return path.join(this.blocksDir, `${label}.md`);
  }

  private blockRelPath(label: string): string {
    return `${MEMORY_V7_BLOCKS_DIR}/${label}.md`;
  }

  private commitFile(label: string, message: string): string {
    if (!this.gitAvailable()) return '';
    try {
      this.ensureRepo();
      execFileSync('git', ['add', this.blockRelPath(label)], { cwd: this.rootDir, stdio: 'ignore', timeout: 10000 });
      execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: this.rootDir, stdio: 'ignore', timeout: 10000 });
      const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      return hash;
    } catch {
      return '';
    }
  }

  private appendHistoryLog(entry: V7HistoryLogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
      fs.appendFileSync(this.historyPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Log dự phòng là best-effort, không làm hỏng thao tác chính.
    }
  }

  private readHistoryLog(label: string, limit: number): V7BlockHistoryEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.historyPath, 'utf8');
    } catch {
      return [];
    }
    const out: V7BlockHistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as V7HistoryLogEntry;
        if (e.label === label) {
          out.push({
            commit: '',
            author: e.actor,
            at: e.at,
            message: `memory-v7: ${e.action} ${e.label} v${e.version}`,
            version: e.version,
            content: e.content,
            chars: e.content.length,
          });
        }
      } catch {
        // Dòng hỏng — bỏ qua.
      }
    }
    return out.slice(-limit);
  }

  /**
   * Guardrail: ai được sửa block này?
   *  - Block readOnly: không ai sửa nội dung (kể cả user) — phải tắt readOnly trước.
   *  - Block scope system: chỉ actor `user` hoặc `system:*` được sửa; agent bị chặn.
   *  - Block scope user: user và agent đều sửa được (tool layer vẫn cần approval).
   */
  assertEditable(block: V7MemoryBlock, actor: string): void {
    if (block.readOnly) {
      throw new Error(
        `Memory block "${block.label}" đang read-only — tắt read-only trước khi sửa.`,
      );
    }
    if (block.scope === 'system' && !actor.startsWith('user') && !actor.startsWith('system:')) {
      throw new Error(
        `Memory block "${block.label}" là block hệ thống (scope system) — agent không được tự sửa, chỉ user mới sửa được.`,
      );
    }
  }

  /** Tạo block mới (file + commit). Label trùng -> throw. */
  create(input: V7BlockInput, actor = 'user'): V7MemoryBlock {
    const label = normalizeBlockLabel(input.label);
    if (!isValidBlockLabel(label)) {
      throw new Error(`Memory block label không hợp lệ: "${input.label}".`);
    }
    const content = input.content ?? '';
    const charLimit = Math.min(
      MAX_BLOCK_CHAR_LIMIT,
      Math.max(MIN_BLOCK_CHAR_LIMIT, Math.floor(input.charLimit ?? DEFAULT_BLOCK_CHAR_LIMIT)),
    );
    if (content.length > charLimit) {
      throw new Error(
        `Nội dung block "${label}" dài ${content.length} ký tự, vượt giới hạn ${charLimit} ký tự của block.`,
      );
    }
    fs.mkdirSync(this.blocksDir, { recursive: true });
    if (fs.existsSync(this.blockPath(label))) {
      throw new Error(`Đã có memory block "${label}" trong projection — dùng label khác hoặc sửa block đó.`);
    }
    const scope =
      input.scope ?? ((V7_SYSTEM_BLOCK_LABELS as readonly string[]).includes(label) ? 'system' : 'user');
    const tier = input.tier !== undefined && isValidTier(input.tier) ? input.tier : 'semantic';
    const now = new Date().toISOString();
    const block: V7MemoryBlock = {
      label,
      tier,
      scope,
      description: (input.description ?? '').trim().replace(/\n/g, ' '),
      content,
      readOnly: input.readOnly === true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(this.blockPath(label), renderBlockFile(block), { mode: 0o600 });
    block.commit = this.commitFile(label, `memory-v7: create ${label} v1`);
    this.appendHistoryLog({ at: now, actor, action: 'create', label, version: 1, content });
    return { ...block };
  }

  /** Đọc block theo label. Null khi không có. */
  get(labelOrId: string): V7MemoryBlock | null {
    const label = normalizeBlockLabel(labelOrId);
    if (!label) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(this.blockPath(label), 'utf8');
    } catch {
      return null;
    }
    const block = parseBlockFile(raw, label);
    if (this.gitAvailable()) {
      try {
        block.commit = execFileSync(
          'git',
          ['log', '--format=%h', '-1', '--', this.blockRelPath(label)],
          { cwd: this.rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
        ).trim();
      } catch {
        // Không có commit nào — để trống.
      }
    }
    return block;
  }

  /** Liệt kê mọi block (xếp: system trước, rồi theo tier, rồi label). */
  list(opts: { tier?: MemoryTier; scope?: V7BlockScope } = {}): V7MemoryBlock[] {
    fs.mkdirSync(this.blocksDir, { recursive: true });
    const files = fs.readdirSync(this.blocksDir).filter((f) => f.endsWith('.md'));
    let blocks: V7MemoryBlock[] = [];
    for (const file of files) {
      const label = file.slice(0, -3);
      const block = this.get(label);
      if (block) blocks.push(block);
    }
    if (opts.tier !== undefined) blocks = blocks.filter((b) => b.tier === opts.tier);
    if (opts.scope !== undefined) blocks = blocks.filter((b) => b.scope === opts.scope);
    const tierOrder: Record<MemoryTier, number> = { semantic: 0, episodic: 1, session: 2, working: 3 };
    blocks.sort(
      (a, b) =>
        (a.scope === 'system' ? 0 : 1) - (b.scope === 'system' ? 0 : 1) ||
        tierOrder[a.tier] - tierOrder[b.tier] ||
        a.label.localeCompare(b.label),
    );
    return blocks;
  }

  /** Sửa nội dung / mô tả / tier của block (ghi file + commit mới). */
  update(
    label: string,
    patch: { content?: string; description?: string; tier?: MemoryTier },
    actor = 'user',
  ): V7MemoryBlock {
    const block = this.get(label);
    if (!block) throw new Error(`Không tìm thấy memory block "${label}" trong projection.`);
    this.assertEditable(block, actor);
    let changed = false;
    if (patch.content !== undefined && patch.content !== block.content) {
      if (patch.content.length > MAX_BLOCK_CHAR_LIMIT) {
        throw new Error(
          `Nội dung block "${block.label}" dài ${patch.content.length} ký tự, vượt giới hạn ${MAX_BLOCK_CHAR_LIMIT} ký tự.`,
        );
      }
      block.content = patch.content;
      changed = true;
    }
    if (patch.description !== undefined && patch.description.trim() !== block.description) {
      block.description = patch.description.trim().replace(/\n/g, ' ');
      changed = true;
    }
    if (patch.tier !== undefined && isValidTier(patch.tier) && patch.tier !== block.tier) {
      block.tier = patch.tier;
      changed = true;
    }
    if (changed) {
      block.version += 1;
      block.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.blockPath(block.label), renderBlockFile(block), { mode: 0o600 });
      block.commit = this.commitFile(block.label, `memory-v7: update ${block.label} v${block.version}`);
      this.appendHistoryLog({ at: block.updatedAt, actor, action: 'update', label: block.label, version: block.version, content: block.content });
    }
    return { ...block };
  }

  /** Nối thêm text vào cuối block (một dòng mới khi block đã có nội dung). */
  append(label: string, text: string, actor = 'user'): V7MemoryBlock {
    const block = this.get(label);
    if (!block) throw new Error(`Không tìm thấy memory block "${label}" trong projection.`);
    this.assertEditable(block, actor);
    const addition = (text ?? '').trim();
    if (!addition) throw new Error('Không có nội dung để nối vào block.');
    const next = block.content === '' ? addition : `${block.content}\n${addition}`;
    if (next.length > MAX_BLOCK_CHAR_LIMIT) {
      throw new Error(
        `Nối thêm sẽ làm block "${block.label}" dài ${next.length} ký tự, vượt giới hạn ${MAX_BLOCK_CHAR_LIMIT} ký tự.`,
      );
    }
    block.content = next;
    block.version += 1;
    block.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.blockPath(block.label), renderBlockFile(block), { mode: 0o600 });
    block.commit = this.commitFile(block.label, `memory-v7: append ${block.label} v${block.version}`);
    this.appendHistoryLog({ at: block.updatedAt, actor, action: 'append', label: block.label, version: block.version, content: block.content });
    return { ...block };
  }

  /** Đổi tầng của block (ghi file + commit). Không đổi tầng qua update(). */
  setTier(label: string, tier: MemoryTier, actor = 'user'): V7MemoryBlock {
    if (!isValidTier(tier)) throw new Error(`Memory tier không hợp lệ: "${String(tier)}".`);
    const block = this.get(label);
    if (!block) throw new Error(`Không tìm thấy memory block "${label}" trong projection.`);
    this.assertEditable(block, actor);
    if (block.tier === tier) return { ...block };
    block.tier = tier;
    block.version += 1;
    block.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.blockPath(block.label), renderBlockFile(block), { mode: 0o600 });
    block.commit = this.commitFile(block.label, `memory-v7: tier ${block.label} -> ${tier} v${block.version}`);
    this.appendHistoryLog({ at: block.updatedAt, actor, action: 'tier', label: block.label, version: block.version, content: block.content });
    return { ...block };
  }

  /** Bật/tắt read-only (chính thao tác này không bị chặn bởi read-only, nhưng vẫn tôn trọng scope system). */
  setReadOnly(label: string, readOnly: boolean, actor = 'user'): V7MemoryBlock {
    const block = this.get(label);
    if (!block) throw new Error(`Không tìm thấy memory block "${label}" trong projection.`);
    if (block.scope === 'system' && !actor.startsWith('user') && !actor.startsWith('system:')) {
      throw new Error(
        `Memory block "${block.label}" là block hệ thống (scope system) — agent không được đổi read-only, chỉ user mới đổi được.`,
      );
    }
    if (block.readOnly === readOnly) return { ...block };
    block.readOnly = readOnly;
    block.version += 1;
    block.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.blockPath(block.label), renderBlockFile(block), { mode: 0o600 });
    block.commit = this.commitFile(block.label, `memory-v7: read-only ${block.label}=${readOnly} v${block.version}`);
    this.appendHistoryLog({ at: block.updatedAt, actor, action: 'set-read-only', label: block.label, version: block.version, content: block.content });
    return { ...block };
  }

  /** Xoá block (file + commit xoá). Trả false khi không có. */
  delete(label: string, actor = 'user'): boolean {
    const block = this.get(label);
    if (!block) return false;
    this.assertEditable(block, actor);
    fs.rmSync(this.blockPath(block.label), { force: true });
    if (this.gitAvailable()) {
      try {
        this.ensureRepo();
        execFileSync('git', ['add', '-A', this.blockRelPath(block.label)], { cwd: this.rootDir, stdio: 'ignore', timeout: 10000 });
        execFileSync('git', ['commit', '--quiet', '-m', `memory-v7: delete ${block.label}`], { cwd: this.rootDir, stdio: 'ignore', timeout: 10000 });
      } catch {
        // Xoá file đã xong; commit xoá thất bại thì thôi (best-effort).
      }
    }
    this.appendHistoryLog({ at: new Date().toISOString(), actor, action: 'delete', label: block.label, version: block.version, content: '' });
    return true;
  }

  /**
   * Lịch sử của block: mỗi commit chạm file = một version (nội dung
   * lấy bằng `git show`). Khi không có git thì đọc log dự phòng
   * history.jsonl. Trả mới nhất trước.
   */
  blockHistory(label: string, limit = 20): V7BlockHistoryEntry[] {
    const slug = normalizeBlockLabel(label);
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    if (!this.gitAvailable()) return this.readHistoryLog(slug, n).reverse();
    try {
      this.ensureRepo();
      const log = execFileSync(
        'git',
        ['log', '--follow', `--format=%H%x1f%an%x1f%ad%x1f%s`, '--date=iso-strict', '--', this.blockRelPath(slug)],
        { cwd: this.rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
      ).trim();
      if (!log) return this.readHistoryLog(slug, n).reverse();
      const out: V7BlockHistoryEntry[] = [];
      for (const line of log.split('\n').slice(0, n)) {
        const [hash, author, at, message] = line.split('\x1f');
        if (!hash) continue;
        let content = '';
        try {
          const raw = execFileSync('git', ['show', `${hash}:${this.blockRelPath(slug)}`], {
            cwd: this.rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
          });
          content = parseBlockFile(raw, slug).content;
        } catch {
          content = '';
        }
        const versionMatch = /v(\d+)\s*$/.exec(message ?? '');
        out.push({
          commit: hash.slice(0, 12),
          author: author ?? '',
          at: at ?? '',
          message: message ?? '',
          version: versionMatch ? Number(versionMatch[1]) : 0,
          content,
          chars: content.length,
        });
      }
      return out;
    } catch {
      return this.readHistoryLog(slug, n).reverse();
    }
  }

  /**
   * Blame: dòng nào của block do commit nào viết (tác giả + thời
   * gian). Gom theo commit để UI hiển thị gọn. Rỗng khi không có git.
   */
  blockBlame(label: string): V7BlameEntry[] {
    const slug = normalizeBlockLabel(label);
    if (!this.gitAvailable()) return [];
    try {
      this.ensureRepo();
      const out = execFileSync(
        'git',
        ['blame', '--porcelain', '--', this.blockRelPath(slug)],
        { cwd: this.rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
      );
      const byCommit = new Map<string, { author: string; at: string; lines: number; firstLine: number }>();
      let lineNo = 0;
      let currentHash = '';
      let currentAuthor = '';
      let currentAt = '';
      for (const line of out.split('\n')) {
        if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
          const parts = line.split(' ');
          currentHash = parts[0].slice(0, 12);
          lineNo += 1;
        } else if (line.startsWith('author ')) {
          currentAuthor = line.slice('author '.length);
        } else if (line.startsWith('author-time ')) {
          currentAt = new Date(Number(line.slice('author-time '.length)) * 1000).toISOString();
        } else if (line.startsWith('\t')) {
          const entry = byCommit.get(currentHash) ?? { author: currentAuthor, at: currentAt, lines: 0, firstLine: lineNo };
          entry.lines += 1;
          byCommit.set(currentHash, entry);
        }
      }
      return [...byCommit.entries()]
        .map(([commit, e]) => ({ commit, author: e.author, at: e.at, lines: e.lines, firstLine: e.firstLine }))
        .sort((a, b) => b.lines - a.lines);
    } catch {
      return [];
    }
  }

  /**
   * Diff giữa hai revision của block (mặc định: HEAD so với commit
   * trước đó chạm file). Trả text diff thô, cắt ở 8000 ký tự.
   */
  blockDiff(label: string, revA?: string, revB?: string): string {
    const slug = normalizeBlockLabel(label);
    if (!this.gitAvailable()) return '';
    try {
      this.ensureRepo();
      const a = revA ?? 'HEAD';
      const b = revB ?? 'HEAD~1';
      const out = execFileSync('git', ['diff', a, b, '--', this.blockRelPath(slug)], {
        cwd: this.rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000,
      });
      return out.slice(0, 8000);
    } catch {
      return '';
    }
  }

  /**
   * Nhập các block JSON cũ (MemoryBlockStore) vào projection: mỗi
   * block thành một file .md + một commit. Block đã có trong
   * projection thì bỏ qua (không ghi đè). Trả số block đã nhập.
   */
  importFromBlocks(
    blocks: Array<{ label: string; description?: string; content?: string; readOnly?: boolean }>,
    actor = 'user',
  ): number {
    let imported = 0;
    for (const b of blocks) {
      const label = normalizeBlockLabel(b.label);
      if (!label || this.get(label)) continue;
      this.create(
        {
          label,
          content: b.content ?? '',
          description: b.description ?? '',
          readOnly: b.readOnly === true,
        },
        actor,
      );
      imported += 1;
    }
    return imported;
  }
}
