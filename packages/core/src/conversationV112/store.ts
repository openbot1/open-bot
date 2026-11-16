/**
 * Store append-only cho conversation log v112 (Đội T2).
 *
 * Layout trên đĩa (dưới `<dataDir>/conversations-v112/`):
 *   `<conversationId>.jsonl`   — một dòng JSON / event, theo thứ tự seq.
 *   `<conversationId>.snapshot.json` — snapshot mới nhất (xem snapshots.ts).
 *
 * Append:
 * - Tự điền `seq` (tiếp nối), `prevHash` (hash event trước), `hash`,
 *   `at` (nếu caller không truyền).
 * - Ghi bằng append + fsync (fdatasync) trước khi trả về — event đã
 *   trả về là đã bền trên đĩa (trừ khi OS crash giữa chừng, như mọi
 *   file log khác).
 * - Từ chối append khi file vượt `maxFileBytes` (host phải snapshot +
 *   compact trước) hoặc khi `conversationId`/`branchId` không hợp lệ.
 * - Cache tail (seq + hash cuối) trong bộ nhớ để append không phải
 *   đọc lại toàn bộ file; cache được nạp lười từ đĩa lần đầu.
 *
 * Đọc: `readAll` (kèm verify chain tùy chọn), `readRange` (phân
 * trang theo seq, không load hết file vào RAM — đọc dòng theo dòng),
 * `tail` (N event cuối). File bị cắt ngang dòng cuối (crash khi ghi)
 * được phát hiện: dòng cuối không parse được JSON → báo
 * `corruptTail: true` thay vì throw cả file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONVERSATION_V112_GENESIS_PREV_HASH, hashConversationEvent, verifyConversationChain } from './canonical';
import { CONVERSATION_V112_DEFAULTS, safeConversationFileName, type AnyConversationEvent, type ConversationEvent, type ConversationEventType, type ConversationPayloadByType } from './types';

/** Lỗi khi store không thể append/đọc (đĩa đầy, quyền, file hỏng…). */
export class ConversationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationStoreError';
  }
}

export interface ConversationLogStoreOptions {
  /** Thư mục gốc chứa file log (sẽ mkdir -p). */
  dataDir: string;
  /** Kích thước file tối đa, bytes. Mặc định 16 MB. */
  maxFileBytes?: number;
  /** Nguồn thời gian (để test chèn thời gian cố định). */
  now?: () => string;
}

/** Kết quả đọc log. */
export interface ReadConversationResult {
  events: AnyConversationEvent[];
  /** True khi dòng cuối file bị cắt ngang (ghi dở do crash). */
  corruptTail: boolean;
  /** Tổng số event trong file (kể cả dòng hỏng cuối nếu có). */
  totalInFile: number;
}

const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isConversationEventObject(value: unknown): value is AnyConversationEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['seq'] === 'number' &&
    typeof v['conversationId'] === 'string' &&
    typeof v['branchId'] === 'string' &&
    typeof v['at'] === 'string' &&
    typeof v['type'] === 'string' &&
    typeof v['payload'] === 'object' &&
    v['payload'] !== null &&
    typeof v['prevHash'] === 'string' &&
    typeof v['hash'] === 'string'
  );
}

export class ConversationLogStore {
  private readonly dataDir: string;
  private readonly maxFileBytes: number;
  private readonly now: () => string;
  /** Cache tail mỗi conversation: seq + hash cuối. */
  private readonly tails = new Map<string, { seq: number; hash: string }>();

  constructor(options: ConversationLogStoreOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new ConversationStoreError('ConversationLogStore cần dataDir (string, không rỗng).');
    }
    this.dataDir = options.dataDir;
    this.maxFileBytes = options.maxFileBytes ?? CONVERSATION_V112_DEFAULTS.maxFileBytes;
    this.now = options.now ?? (() => new Date().toISOString());
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /** Đường dẫn file log của một conversation. */
  filePath(conversationId: string): string {
    return path.join(this.dataDir, safeConversationFileName(conversationId));
  }

  /** Đường dẫn file snapshot của một conversation tại một throughSeq (mỗi snapshot một file riêng). */
  snapshotPath(conversationId: string, throughSeq: number): string {
    const safe = safeConversationFileName(conversationId).replace(/\.jsonl$/, '');
    return path.join(this.dataDir, `${safe}.snapshot-${throughSeq}.json`);
  }

  private assertIds(conversationId: string, branchId: string): void {
    if (!CONVERSATION_ID_RE.test(conversationId)) {
      throw new ConversationStoreError(
        `conversationId không hợp lệ: "${conversationId}" (chỉ chữ/số/./_/- , tối đa 128 ký tự).`,
      );
    }
    if (!BRANCH_ID_RE.test(branchId)) {
      throw new ConversationStoreError(
        `branchId không hợp lệ: "${branchId}" (chỉ chữ/số/./_/- , tối đa 64 ký tự).`,
      );
    }
  }

  /** Đọc tail (seq + hash cuối) từ đĩa — dùng khi cache chưa có. */
  private loadTailFromDisk(conversationId: string): { seq: number; hash: string } {
    const file = this.filePath(conversationId);
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { seq: 0, hash: CONVERSATION_V112_GENESIS_PREV_HASH };
      }
      throw new ConversationStoreError(`Không đọc được log ${conversationId}: ${(err as Error).message}`);
    }
    const lines = content.split('\n').filter((line) => line.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed: unknown = JSON.parse(lines[i]!);
        if (isConversationEventObject(parsed)) {
          return { seq: parsed.seq, hash: parsed.hash };
        }
      } catch {
        // Dòng hỏng (thường là dòng cuối bị cắt) — thử dòng trước đó.
        continue;
      }
    }
    return { seq: 0, hash: CONVERSATION_V112_GENESIS_PREV_HASH };
  }

  private tailOf(conversationId: string): { seq: number; hash: string } {
    const cached = this.tails.get(conversationId);
    if (cached) return cached;
    const tail = this.loadTailFromDisk(conversationId);
    this.tails.set(conversationId, tail);
    return tail;
  }

  /**
   * Append một event. Tự điền `seq`/`prevHash`/`hash`/`at`.
   * Trả về event đã lưu (đầy đủ hash). Ném ConversationStoreError
   * khi file đã đầy hoặc ghi thất bại.
   */
  append<T extends ConversationEventType>(
    conversationId: string,
    branchId: string,
    type: T,
    payload: ConversationPayloadByType[T],
    at?: string,
  ): ConversationEvent<T> {
    this.assertIds(conversationId, branchId);
    const file = this.filePath(conversationId);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ConversationStoreError(`Không stat được log ${conversationId}: ${(err as Error).message}`);
      }
    }
    if (size >= this.maxFileBytes) {
      throw new ConversationStoreError(
        `Log ${conversationId} đã đầy (${size} bytes >= ${this.maxFileBytes}): snapshot + compact trước khi append tiếp.`,
      );
    }
    const tail = this.tailOf(conversationId);
    const eventBase = {
      seq: tail.seq + 1,
      conversationId,
      branchId,
      at: at ?? this.now(),
      type,
      payload,
      prevHash: tail.hash,
    };
    const event = { ...eventBase, hash: hashConversationEvent(eventBase) } as ConversationEvent<T>;
    const line = `${JSON.stringify(event)}\n`;
    try {
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      throw new ConversationStoreError(`Không ghi được log ${conversationId}: ${(err as Error).message}`);
    }
    this.tails.set(conversationId, { seq: event.seq, hash: event.hash });
    return event;
  }

  /** Đọc toàn bộ event của conversation (theo thứ tự seq). */
  readAll(conversationId: string, opts?: { verify?: boolean }): ReadConversationResult {
    const { events, corruptTail, totalInFile } = this.readLines(conversationId);
    if (opts?.verify) {
      const check = verifyConversationChain(events);
      if (!check.ok) {
        throw new ConversationStoreError(
          `Chain log ${conversationId} hỏng ở seq ${check.badSeq}: ${check.reason}`,
        );
      }
    }
    return { events, corruptTail, totalInFile };
  }

  /** Đọc một lát cắt theo seq: seq từ `fromSeq` (bao gồm) tới `toSeq` (bao gồm). */
  readRange(
    conversationId: string,
    fromSeq: number,
    toSeq?: number,
  ): ReadConversationResult {
    if (!Number.isInteger(fromSeq) || fromSeq < 1) {
      throw new ConversationStoreError('readRange cần fromSeq là số nguyên >= 1.');
    }
    const { events, corruptTail, totalInFile } = this.readLines(conversationId);
    const sliced = events.filter(
      (event) => event.seq >= fromSeq && (toSeq === undefined || event.seq <= toSeq),
    );
    return { events: sliced, corruptTail, totalInFile };
  }

  /** N event cuối cùng (mặc định 50). */
  tail(conversationId: string, limit = 50): ReadConversationResult {
    const { events, corruptTail, totalInFile } = this.readLines(conversationId);
    return { events: events.slice(Math.max(0, events.length - limit)), corruptTail, totalInFile };
  }

  /** Số event hiện có (đếm dòng hợp lệ, không verify chain). */
  count(conversationId: string): number {
    return this.readLines(conversationId).totalInFile;
  }

  /** True khi đã có file log cho conversation này. */
  exists(conversationId: string): boolean {
    try {
      fs.statSync(this.filePath(conversationId));
      return true;
    } catch {
      return false;
    }
  }

  /** Verify chain của conversation — trả về kết quả chi tiết, không throw. */
  verify(conversationId: string): { ok: boolean; badSeq?: number; reason?: string; events: number } {
    const { events } = this.readLines(conversationId);
    const check = verifyConversationChain(events);
    return { ...check, events: events.length };
  }

  /**
   * Ghi đè toàn bộ file log bằng dãy event cho trước (dùng khi
   * compact: snapshot + viết lại log từ anchor). Dãy event phải là
   * chain hợp lệ (seq từ 1, hash nối nhau) — không tự sửa hash.
   */
  rewrite(conversationId: string, branchId: string, events: AnyConversationEvent[]): void {
    this.assertIds(conversationId, branchId);
    const check = verifyConversationChain(events);
    if (!check.ok) {
      throw new ConversationStoreError(
        `Không rewrite log ${conversationId}: chain hỏng ở seq ${check.badSeq}: ${check.reason}`,
      );
    }
    const file = this.filePath(conversationId);
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, content.length > 0 ? `${content}\n` : '', 'utf8');
      const fd = fs.openSync(tmp, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // File tạm có thể đã được rename — bỏ qua.
      }
      throw new ConversationStoreError(`Không rewrite được log ${conversationId}: ${(err as Error).message}`);
    }
    const last = events[events.length - 1];
    this.tails.set(conversationId, {
      seq: last ? last.seq : 0,
      hash: last ? last.hash : CONVERSATION_V112_GENESIS_PREV_HASH,
    });
  }

  /** Xoá cache tail (dùng trong test hoặc khi file bị sửa từ bên ngoài). */
  invalidateCache(conversationId?: string): void {
    if (conversationId) this.tails.delete(conversationId);
    else this.tails.clear();
  }

  private readLines(conversationId: string): ReadConversationResult {
    const file = this.filePath(conversationId);
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], corruptTail: false, totalInFile: 0 };
      }
      throw new ConversationStoreError(`Không đọc được log ${conversationId}: ${(err as Error).message}`);
    }
    const rawLines = content.split('\n');
    // Dòng cuối sau '\n' cuối file là chuỗi rỗng — bỏ qua.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    const events: AnyConversationEvent[] = [];
    let corruptTail = false;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isConversationEventObject(parsed)) {
          if (i === rawLines.length - 1) corruptTail = true;
          continue;
        }
        events.push(parsed);
      } catch {
        // Dòng cuối không parse được = ghi dở do crash.
        if (i === rawLines.length - 1) corruptTail = true;
      }
    }
    return { events, corruptTail, totalInFile: events.length };
  }
}
