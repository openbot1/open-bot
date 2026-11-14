/**
 * Shared memory blocks — Memory v6 (v1.05, Đội T1).
 *
 * Ý tưởng học từ Letta (memory block chia sẻ giữa các agent, có
 * version + quyền đọc/ghi) — tự thiết kế lại hoàn toàn cho open-bot,
 * 100% local, không copy code/text/tài sản của bất kỳ repo nào.
 *
 * MÔ HÌNH:
 *  - Một block có: tên duy nhất, nội dung, owner (bot tạo ra), ACL
 *    (botId -> 'read' | 'write'), version tăng dần, lịch sử version
 *    append-only (mỗi update thêm một snapshot, không sửa snapshot cũ).
 *  - `updateBlock` cần quyền write (owner luôn có write). Update
 *    KHÔNG sửa nội dung cũ tại chỗ: snapshot cũ ở lại trong history,
 *    nội dung hiện tại là snapshot mới nhất.
 *  - `shareBlock` / `unshareBlock`: owner cấp/thu quyền cho một bot.
 *    Thu quyền write của bot đang subscribe không xoá dữ liệu của bot
 *    đó — chỉ chặn đọc/ghi tiếp theo.
 *  - Sync event: mọi thay đổi (created/updated/shared/unshared/
 *    deleted) append vào nhật ký event trên đĩa (`*.jsonl`) và phát
 *    cho subscriber trong tiến trình qua `subscribe()` (trả về hàm
 *    unsubscribe). Bot trong fleet poll event log hoặc subscribe để
 *    đồng bộ block về máy mình.
 *
 * LƯU TRỮ: file JSON `<workspace>/.open-bot/shared-blocks-v6.json`
 * (atomic temp + rename, mode 0600) + file event JSONL
 * `<workspace>/.open-bot/shared-blocks-v6-events.jsonl` (append).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  V6BlockPermission,
  V6BlockSyncEvent,
  V6SharedBlock,
} from './types';

/** Đường dẫn tương đối của file block v6 trong workspace. */
export const SHARED_BLOCKS_V6_REL_PATH = path.join('.open-bot', 'shared-blocks-v6.json');
export const SHARED_BLOCKS_V6_EVENTS_REL_PATH = path.join(
  '.open-bot',
  'shared-blocks-v6-events.jsonl',
);
/** Nội dung block tối đa (ký tự). */
export const V6_BLOCK_MAX_CONTENT_CHARS = 100_000;
/** Tên block tối đa (ký tự). */
export const V6_BLOCK_MAX_NAME_CHARS = 120;

/** Lỗi shared block — mọi message đều tiếng Việt. */
export class V6BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6BlockError';
  }
}

/** Hình dạng file block v6 trên đĩa. */
export interface V6SharedBlocksFile {
  version: number;
  blocks: V6SharedBlock[];
}

/** Tuỳ chọn khởi tạo store block. */
export interface SharedBlockStoreOptions {
  /** Thư mục workspace. */
  dir?: string;
  /** Đường dẫn file block trực tiếp (ưu tiên hơn `dir`). */
  filePath?: string;
  /** Đường dẫn file event trực tiếp (mặc định suy từ filePath/dir). */
  eventsPath?: string;
  /** true = chỉ bộ nhớ, không chạm đĩa (dùng cho test). */
  inMemory?: boolean;
}

function validateBlockName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new V6BlockError('Tên block không được rỗng.');
  if (trimmed.length > V6_BLOCK_MAX_NAME_CHARS) {
    throw new V6BlockError(`Tên block quá dài (${trimmed.length} > ${V6_BLOCK_MAX_NAME_CHARS}).`);
  }
  if (/[/\\]/.test(trimmed)) {
    throw new V6BlockError('Tên block không được chứa / hoặc \\ (để tránh nhầm với đường dẫn).');
  }
  return trimmed;
}

function validateContent(content: string): string {
  if (content.length > V6_BLOCK_MAX_CONTENT_CHARS) {
    throw new V6BlockError(
      `Nội dung block quá dài (${content.length} > ${V6_BLOCK_MAX_CONTENT_CHARS} ký tự).`,
    );
  }
  return content;
}

/** Callback nhận sync event của block. */
export type V6BlockSubscriber = (event: V6BlockSyncEvent) => void;

/**
 * Kho shared block v6 — file-backed (hoặc in-memory).
 * Mọi thay đổi đều append event + persist ngay (không cache bẩn).
 */
export class SharedBlockStore {
  private readonly filePath: string | null;
  private readonly eventsPath: string | null;
  private blocks: V6SharedBlock[] = [];
  private loaded = false;
  private nextSeq = 1;
  private readonly subscribers = new Set<V6BlockSubscriber>();

  constructor(opts: SharedBlockStoreOptions = {}) {
    if (opts.inMemory) {
      this.filePath = null;
      this.eventsPath = null;
    } else if (opts.filePath) {
      this.filePath = opts.filePath;
      this.eventsPath = opts.eventsPath ?? `${opts.filePath}.events.jsonl`;
    } else if (opts.dir) {
      this.filePath = path.join(opts.dir, SHARED_BLOCKS_V6_REL_PATH);
      this.eventsPath = path.join(opts.dir, SHARED_BLOCKS_V6_EVENTS_REL_PATH);
    } else {
      this.filePath = null;
      this.eventsPath = null;
    }
  }

  /** Store file-backed trong workspace của bot. */
  static fromWorkspace(workspaceDir: string): SharedBlockStore {
    return new SharedBlockStore({ dir: workspaceDir });
  }

  /** Store thuần bộ nhớ (test, hoặc phiên chạy tạm). */
  static inMemory(): SharedBlockStore {
    return new SharedBlockStore({ inMemory: true });
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V6BlockError(`File shared block v6 hỏng (không parse được JSON): ${this.filePath}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new V6BlockError(`File shared block v6 sai định dạng: ${this.filePath}`);
    }
    const file = parsed as Partial<V6SharedBlocksFile>;
    if (!Array.isArray(file.blocks)) {
      throw new V6BlockError(`File shared block v6 thiếu blocks: ${this.filePath}`);
    }
    this.blocks = file.blocks as V6SharedBlock[];
    // Đọc seq tiếp theo từ file event (nếu có) để seq không trùng sau restart.
    if (this.eventsPath) {
      try {
        const lines = fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as Partial<V6BlockSyncEvent>;
            if (typeof event.seq === 'number') this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
          } catch {
            // Dòng event hỏng thì bỏ qua (không fail cả store).
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, blocks: this.blocks }, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.filePath);
  }

  private appendEventLog(event: V6BlockSyncEvent): void {
    if (!this.eventsPath) return;
    const dir = path.dirname(this.eventsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  /** Phát event: ghi log + gọi subscriber (lỗi subscriber không lan ra ngoài). */
  private emit(event: Omit<V6BlockSyncEvent, 'seq' | 'at'>): V6BlockSyncEvent {
    const full: V6BlockSyncEvent = {
      seq: this.nextSeq,
      at: new Date().toISOString(),
      ...event,
    };
    this.nextSeq += 1;
    this.appendEventLog(full);
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber({ ...full });
      } catch {
        // Subscriber lỗi thì bỏ qua — không được làm hỏng store.
      }
    }
    return { ...full };
  }

  /** Đăng ký nhận sync event. Trả về hàm unsubscribe. */
  subscribe(callback: V6BlockSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Số subscriber hiện tại (để test/debug). */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Tìm block theo id (bản sao), không có -> undefined. */
  getBlock(id: string): V6SharedBlock | undefined {
    this.load();
    const block = this.blocks.find((b) => b.id === id);
    return block ? structuredClone(block) : undefined;
  }

  /** Tìm block theo tên (bản sao), không có -> undefined. */
  getBlockByName(name: string): V6SharedBlock | undefined {
    this.load();
    const block = this.blocks.find((b) => b.name === name.trim());
    return block ? structuredClone(block) : undefined;
  }

  /** Tất cả block (bản sao, theo thứ tự tạo). */
  listBlocks(): V6SharedBlock[] {
    this.load();
    return this.blocks.map((b) => structuredClone(b));
  }

  /** Quyền hiệu lực của một bot trên block (owner luôn 'write'). */
  permissionFor(block: V6SharedBlock, botId: string): V6BlockPermission | undefined {
    if (block.ownerBotId === botId) return 'write';
    return block.acl[botId];
  }

  /** Block mà bot được đọc (owner + ACL read/write). */
  listBlocksFor(botId: string): V6SharedBlock[] {
    return this.listBlocks().filter((b) => this.permissionFor(b, botId) !== undefined);
  }

  /** Block mà bot được ghi (owner + ACL write). */
  listWritableBlocksFor(botId: string): V6SharedBlock[] {
    return this.listBlocks().filter((b) => this.permissionFor(b, botId) === 'write');
  }

  /**
   * Tạo block mới (owner = bot tạo). Tên đã tồn tại -> lỗi (không
   * ghi đè — muốn đổi nội dung thì updateBlock).
   */
  createBlock(ownerBotId: string, name: string, content: string): V6SharedBlock {
    this.load();
    const cleanName = validateBlockName(name);
    const cleanContent = validateContent(content);
    if (ownerBotId.trim() === '') throw new V6BlockError('ownerBotId không được rỗng.');
    if (this.blocks.some((b) => b.name === cleanName)) {
      throw new V6BlockError(`Đã có block tên "${cleanName}" rồi (muốn đổi nội dung thì update).`);
    }
    const now = new Date().toISOString();
    const block: V6SharedBlock = {
      id: randomUUID(),
      name: cleanName,
      content: cleanContent,
      ownerBotId,
      version: 1,
      acl: {},
      history: [{ version: 1, content: cleanContent, actorBotId: ownerBotId, at: now }],
      createdAt: now,
      updatedAt: now,
    };
    this.blocks.push(block);
    this.save();
    this.emit({ type: 'created', blockId: block.id, blockName: block.name, version: 1, actorBotId: ownerBotId });
    return structuredClone(block);
  }

  /**
   * Cập nhật nội dung block (cần quyền write). Version + 1, snapshot
   * cũ ở lại trong history. Trả về block sau update.
   */
  updateBlock(botId: string, id: string, content: string, reason?: string): V6SharedBlock {
    this.load();
    const cleanContent = validateContent(content);
    const block = this.blocks.find((b) => b.id === id);
    if (!block) throw new V6BlockError(`Không tìm thấy block: ${id}`);
    if (this.permissionFor(block, botId) !== 'write') {
      throw new V6BlockError(`Bot "${botId}" không có quyền ghi block "${block.name}".`);
    }
    const now = new Date().toISOString();
    block.version += 1;
    block.content = cleanContent;
    block.updatedAt = now;
    block.history.push({
      version: block.version,
      content: cleanContent,
      actorBotId: botId,
      at: now,
      ...(reason ? { reason } : {}),
    });
    this.save();
    this.emit({
      type: 'updated',
      blockId: block.id,
      blockName: block.name,
      version: block.version,
      actorBotId: botId,
    });
    return structuredClone(block);
  }

  /**
   * Cấp quyền cho một bot (chỉ owner). `permission` = 'read' | 'write'.
   * Cấp lại quyền khác thì ghi đè ACL của bot đó (ACL là map, không
   * phải danh sách append — quyền hiện tại mới có ý nghĩa).
   */
  shareBlock(
    ownerBotId: string,
    id: string,
    targetBotId: string,
    permission: V6BlockPermission,
  ): V6SharedBlock {
    this.load();
    const block = this.blocks.find((b) => b.id === id);
    if (!block) throw new V6BlockError(`Không tìm thấy block: ${id}`);
    if (block.ownerBotId !== ownerBotId) {
      throw new V6BlockError(`Chỉ owner ("${block.ownerBotId}") mới được share block "${block.name}".`);
    }
    if (targetBotId.trim() === '') throw new V6BlockError('targetBotId không được rỗng.');
    if (targetBotId === ownerBotId) {
      throw new V6BlockError('Owner đã có quyền write rồi, không cần share cho chính mình.');
    }
    block.acl[targetBotId] = permission;
    block.updatedAt = new Date().toISOString();
    this.save();
    this.emit({
      type: 'shared',
      blockId: block.id,
      blockName: block.name,
      actorBotId: ownerBotId,
      targetBotId,
    });
    return structuredClone(block);
  }

  /** Thu quyền của một bot (chỉ owner). Bot chưa có quyền -> lỗi rõ ràng. */
  unshareBlock(ownerBotId: string, id: string, targetBotId: string): V6SharedBlock {
    this.load();
    const block = this.blocks.find((b) => b.id === id);
    if (!block) throw new V6BlockError(`Không tìm thấy block: ${id}`);
    if (block.ownerBotId !== ownerBotId) {
      throw new V6BlockError(`Chỉ owner ("${block.ownerBotId}") mới được unshare block "${block.name}".`);
    }
    if (!(targetBotId in block.acl)) {
      throw new V6BlockError(`Bot "${targetBotId}" không có quyền trên block "${block.name}".`);
    }
    delete block.acl[targetBotId];
    block.updatedAt = new Date().toISOString();
    this.save();
    this.emit({
      type: 'unshared',
      blockId: block.id,
      blockName: block.name,
      actorBotId: ownerBotId,
      targetBotId,
    });
    return structuredClone(block);
  }

  /**
   * Xoá block (chỉ owner). Xoá khỏi file + phát event 'deleted'.
   * LƯU Ý: khác với record v6 (add-only), block bị xoá là mất hẳn —
   * block là tài nguyên chia sẻ có chủ, owner có quyền xoá; lịch sử
   * version của nó vẫn còn trong file event log (JSONL) để audit.
   */
  deleteBlock(ownerBotId: string, id: string): boolean {
    this.load();
    const index = this.blocks.findIndex((b) => b.id === id);
    if (index === -1) throw new V6BlockError(`Không tìm thấy block: ${id}`);
    const block = this.blocks[index] as V6SharedBlock;
    if (block.ownerBotId !== ownerBotId) {
      throw new V6BlockError(`Chỉ owner ("${block.ownerBotId}") mới được xoá block "${block.name}".`);
    }
    this.blocks.splice(index, 1);
    this.save();
    this.emit({
      type: 'deleted',
      blockId: block.id,
      blockName: block.name,
      actorBotId: ownerBotId,
    });
    return true;
  }

  /** Đọc toàn bộ event log từ đĩa (để bot khác trong fleet đồng bộ). */
  readEventLog(): V6BlockSyncEvent[] {
    this.load();
    if (!this.eventsPath) return [];
    try {
      const raw = fs.readFileSync(this.eventsPath, 'utf8');
      const out: V6BlockSyncEvent[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          out.push(JSON.parse(line) as V6BlockSyncEvent);
        } catch {
          // Dòng hỏng thì bỏ qua.
        }
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
