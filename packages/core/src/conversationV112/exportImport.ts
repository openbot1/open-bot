/**
 * Export / import conversation log v112 (Đội T2).
 *
 * - Export: ghi toàn bộ event của conversation ra file JSONL (kèm
 *   header verify: số event + hash cuối), hoặc trả về chuỗi JSONL.
 *   File export có thể mang sang máy khác.
 * - Import: đọc file JSONL export, validate từng dòng (đúng shape,
 *   đúng conversationId, seq tăng đều từ 1, hash chain đúng), rồi
 *   append vào store của conversation đích (id mới hoặc ghi đè log
 *   rỗng). Từ chối file có event hỏng/sai chain — không import nửa
 *   vời. Import KHÔNG giữ nguyên hash? Có — giữ nguyên: event được
 *   ghi lại qua store với cùng seq/payload/at, hash tính lại sẽ khớp
 *   vì đầu vào hash giống hệt (seq/conversationId/branch/at/type/
 *   payload/prevHash như cũ) — miễn conversationId đích trùng với
 *   conversationId trong file (hoặc caller chấp nhận đổi id thì hash
 *   tính lại theo id mới, vẫn verify được vì chain tự nhất quán).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyConversationChain } from './canonical';
import type { ConversationLogStore } from './store';
import type { AnyConversationEvent } from './types';

/** Header ghi ở dòng đầu file export (dòng JSON có `__export` marker). */
export interface ConversationExportHeader {
  __export: 'open-bot-conversation-v112';
  version: 1;
  conversationId: string;
  branchId: string;
  exportedAt: string;
  eventCount: number;
  lastSeq: number;
  lastHash: string;
}

/** Kết quả export. */
export interface ExportConversationResult {
  file: string;
  eventCount: number;
  lastHash: string;
  bytes: number;
}

/** Kết quả import. */
export interface ImportConversationResult {
  conversationId: string;
  importedEvents: number;
  lastSeq: number;
  lastHash: string;
}

/** Lỗi khi file export/import không hợp lệ. */
export class ConversationExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationExportError';
  }
}

/** Build chuỗi JSONL export từ dãy event (header + 1 dòng/event). */
export function buildConversationExportJsonl(
  events: AnyConversationEvent[],
  conversationId: string,
  branchId: string,
): string {
  const last = events[events.length - 1];
  const header: ConversationExportHeader = {
    __export: 'open-bot-conversation-v112',
    version: 1,
    conversationId,
    branchId,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
    lastSeq: last ? last.seq : 0,
    lastHash: last ? last.hash : '',
  };
  const lines = [JSON.stringify(header)];
  for (const event of events) lines.push(JSON.stringify(event));
  return `${lines.join('\n')}\n`;
}

/** Parse chuỗi JSONL export → header + events (validate shape + chain). */
export function parseConversationExportJsonl(
  text: string,
): { header: ConversationExportHeader; events: AnyConversationEvent[] } {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new ConversationExportError('File export rỗng.');
  }
  let header: unknown;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    throw new ConversationExportError('Dòng đầu file export không phải JSON (thiếu header).');
  }
  const h = header as Partial<ConversationExportHeader>;
  if (h['__export'] !== 'open-bot-conversation-v112' || h['version'] !== 1) {
    throw new ConversationExportError(
      'File không phải export conversation v112 (header __export/version sai).',
    );
  }
  if (typeof h['conversationId'] !== 'string' || h['conversationId'].length === 0) {
    throw new ConversationExportError('Header export thiếu conversationId.');
  }
  const events: AnyConversationEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      throw new ConversationExportError(`Dòng ${i + 1} trong file export không phải JSON.`);
    }
    const event = parsed as Partial<AnyConversationEvent>;
    if (
      typeof event.seq !== 'number' ||
      typeof event.conversationId !== 'string' ||
      typeof event.type !== 'string' ||
      typeof event.payload !== 'object' ||
      event.payload === null ||
      typeof event.hash !== 'string'
    ) {
      throw new ConversationExportError(`Dòng ${i + 1}: event thiếu field bắt buộc (seq/conversationId/type/payload/hash).`);
    }
    if (event.conversationId !== h['conversationId']) {
      throw new ConversationExportError(
        `Dòng ${i + 1}: event thuộc conversation ${event.conversationId}, khác header ${h['conversationId']}.`,
      );
    }
    events.push(event as AnyConversationEvent);
  }
  if (events.length !== h['eventCount']) {
    throw new ConversationExportError(
      `Header ghi ${h['eventCount']} event nhưng file có ${events.length} event.`,
    );
  }
  const check = verifyConversationChain(events);
  if (!check.ok) {
    throw new ConversationExportError(
      `Hash chain trong file export hỏng ở seq ${check.badSeq}: ${check.reason}`,
    );
  }
  const last = events[events.length - 1];
  if (last && last.hash !== h['lastHash']) {
    throw new ConversationExportError('lastHash trong header không khớp event cuối.');
  }
  return { header: h as ConversationExportHeader, events };
}

/** Export conversation ra file JSONL trong thư mục cho trước. */
export function exportConversationToFile(
  store: ConversationLogStore,
  conversationId: string,
  outDir: string,
): ExportConversationResult {
  const { events } = store.readAll(conversationId, { verify: true });
  const state = events[0];
  const branchId = state ? state.branchId : 'main';
  const jsonl = buildConversationExportJsonl(events, conversationId, branchId);
  fs.mkdirSync(outDir, { recursive: true });
  const safe = conversationId.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(outDir, `${safe}.conversation-v112.jsonl`);
  fs.writeFileSync(file, jsonl, 'utf8');
  const last = events[events.length - 1];
  return {
    file,
    eventCount: events.length,
    lastHash: last ? last.hash : '',
    bytes: Buffer.byteLength(jsonl, 'utf8'),
  };
}

/**
 * Import file JSONL export vào store. Conversation đích phải CHƯA
 * có log (tránh trộn hai chain) — hoặc truyền `conversationId` mới
 * để đổi id (hash tính lại theo id mới, chain vẫn tự nhất quán).
 * Trả về số event đã import.
 */
export function importConversationFromFile(
  store: ConversationLogStore,
  file: string,
  options?: { conversationId?: string },
): ImportConversationResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConversationExportError(`Không đọc được file export ${file}: ${(err as Error).message}`);
  }
  const { header, events } = parseConversationExportJsonl(text);
  const targetId = options?.conversationId ?? header.conversationId;
  if (store.exists(targetId)) {
    throw new ConversationExportError(
      `Không import được: conversation ${targetId} đã có log — import chỉ cho phép vào conversation mới (tránh trộn chain).`,
    );
  }
  const branchId = header.branchId;
  for (const event of events) {
    // Ghi lại qua store để seq/hash được tính lại (id mới → hash mới).
    store.append(targetId, branchId, event.type, event.payload as never, event.at);
  }
  const { events: stored } = store.readAll(targetId, { verify: true });
  const last = stored[stored.length - 1];
  return {
    conversationId: targetId,
    importedEvents: stored.length,
    lastSeq: last ? last.seq : 0,
    lastHash: last ? last.hash : '',
  };
}
