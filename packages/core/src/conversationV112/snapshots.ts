/**
 * Snapshot + compaction cho conversation log v112 (Đội T2).
 *
 * - Snapshot: fold log tới seq N, ghi state đó ra file JSON
 *   `<conversationId>.snapshot.json` (kèm SHA-256 của nội dung để
 *   verify khi restore). Snapshot KHÔNG xoá log — log vẫn là source
 *   of truth; snapshot chỉ là cache khởi động nhanh.
 * - Restore: đọc snapshot, verify hash, rồi fold tiếp các event sau
 *   `throughSeq` (nếu log còn) để tái tạo state hiện tại.
 * - Compact: snapshot tại seq N, rồi viết lại file log chỉ giữ:
 *   (1) một event `conversation.snapshot` neo (ghi file snapshot +
 *   throughSeq + hash — event này được ghi MỚI nên chain sau compact
 *   bắt đầu lại từ seq 1 với anchor này), (2) các event sau N.
 *   Trả về số event đã cắt. Log sau compact vẫn verify chain được,
 *   và replay cho state đầy đủ KHI KẾT HỢP với snapshot (xem
 *   `replayFromSnapshot`).
 *
 * Lưu ý: sau compact, `foldConversationEvents` trên log MỚI (không
 * có snapshot) sẽ cho state THIẾU phần trước N — đó là hành vi có
 * chủ ý của compaction, không phải bug. Tool/session luôn gọi
 * `replayFromSnapshot` để lấy state đầy đủ.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashConversationEvent, sha256HexV112 } from './canonical';
import { foldConversationEvent } from './replay';
import type { ConversationLogStore } from './store';
import type { AnyConversationEvent, ConversationState } from './types';
import { emptyConversationState } from './types';

/** Nội dung file snapshot. */
export interface ConversationSnapshotFile {
  /** Version định dạng snapshot (để migrate sau này). */
  version: 1;
  conversationId: string;
  branchId: string;
  /** Seq cuối cùng đã đưa vào snapshot. */
  throughSeq: number;
  /** Thời điểm tạo snapshot. */
  createdAt: string;
  /** State đã fold tới throughSeq. */
  state: ConversationState;
}

/** Kết quả tạo snapshot. */
export interface CreateSnapshotResult {
  file: string;
  throughSeq: number;
  messageCount: number;
  sha256: string;
  /** Seq của event `conversation.snapshot` vừa ghi vào log. */
  snapshotEventSeq: number;
}

/** Kết quả compact. */
export interface CompactConversationResult {
  snapshotFile: string;
  throughSeq: number;
  removedEvents: number;
  remainingEvents: number;
}

/** Kết quả restore từ snapshot (+ fold tiếp event sau throughSeq). */
export interface RestoreFromSnapshotResult {
  state: ConversationState;
  /** Số event sau snapshot đã fold thêm (0 = snapshot đã là mới nhất). */
  foldedAfterSnapshot: number;
}

function snapshotFileName(conversationId: string, throughSeq: number): string {
  const safe = conversationId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'conversation';
  // Mỗi snapshot một file riêng theo throughSeq — snapshot cũ không
  // bao giờ bị ghi đè, event snapshot cũ trong log luôn trỏ đúng file
  // + hash của chính nó (kể cả sau compact).
  return `${safe}.snapshot-${throughSeq}.json`;
}

/** Thư mục dataDir của store (store không expose getter — suy ra từ filePath). */
function storeFileDir(store: ConversationLogStore): string {
  return path.dirname(store.filePath('__v112_dir_probe__'));
}

/**
 * Fold state tới một seq trong log HIỆN TẠI (đánh số theo file log
 * hiện tại). Khi log đã compact (có snapshot trước đó), bắt đầu từ
 * snapshot gần nhất rồi fold các event sau anchor có seq <=
 * targetSeq; khi chưa compact thì fold từ đầu. Dùng cho snapshot ở
 * bất kỳ seq nào, kể cả snapshot lần 2 sau compact.
 */
export function foldStateAtSeq(
  store: ConversationLogStore,
  conversationId: string,
  targetSeq: number,
): ConversationState {
  const { events } = store.readAll(conversationId, { verify: true });
  if (events.length === 0) {
    throw new Error(`Không fold được: conversation ${conversationId} chưa có event nào.`);
  }
  const lastSeq = events[events.length - 1]!.seq;
  if (targetSeq < 1 || targetSeq > lastSeq) {
    throw new Error(`Không fold được: targetSeq ${targetSeq} ngoài khoảng 1..${lastSeq}.`);
  }
  let snapshot: ConversationSnapshotFile | null = null;
  try {
    snapshot = readConversationSnapshot(store, conversationId);
  } catch {
    snapshot = null;
  }
  // Tìm anchor của snapshot mới nhất trong log hiện tại: event
  // snapshot đầu tiên có throughSeq khớp. Mọi event trước anchor đã
  // nằm trong snapshot; chỉ fold anchor + event sau anchor.
  const anchorIdx = snapshot
    ? events.findIndex(
        (event) =>
          event.type === 'conversation.snapshot' &&
          (event.payload as { throughSeq?: number }).throughSeq === snapshot.throughSeq,
      )
    : -1;
  // Snapshot ở TƯƠNG LAI so với targetSeq khi anchor của nó nằm sau
  // targetSeq (log chưa compact: event snapshot append sau throughSeq,
  // seq = throughSeq + 1; hỏi state trước đó thì snapshot chưa "xảy
  // ra"). Khi đó — hoặc khi không có snapshot/anchor — fold từ đầu.
  // Lưu ý: sau compact seq đánh lại từ 1 nên KHÔNG được so
  // snapshot.throughSeq (đánh số cũ) với targetSeq (đánh số mới);
  // chỉ so seq của anchor trong log hiện tại mới đúng.
  if (!snapshot || anchorIdx < 0 || events[anchorIdx]!.seq > targetSeq) {
    const state = emptyConversationState(conversationId);
    for (const event of events) {
      if (event.seq > targetSeq) break;
      foldConversationEvent(state, event);
    }
    return state;
  }
  const state: ConversationState = JSON.parse(JSON.stringify(snapshot.state)) as ConversationState;
  for (let i = anchorIdx; i < events.length; i++) {
    const event = events[i]!;
    if (event.seq > targetSeq) break;
    foldConversationEvent(state, event);
  }
  return state;
}

/**
 * Tạo snapshot tại `throughSeq` (mặc định = seq cuối của log).
 * State được fold NGAY TỪ LOG (+ snapshot trước đó nếu log đã
 * compact) tới throughSeq nên snapshot luôn khớp đúng đoạn log nó
 * bao phủ. Ghi file snapshot + ghi event `conversation.snapshot`
 * vào log.
 */
export function createConversationSnapshot(
  store: ConversationLogStore,
  conversationId: string,
  throughSeq?: number,
): CreateSnapshotResult {
  const { events } = store.readAll(conversationId, { verify: true });
  if (events.length === 0) {
    throw new Error(`Không snapshot được: conversation ${conversationId} chưa có event nào.`);
  }
  const targetSeq = throughSeq ?? events[events.length - 1]!.seq;
  const state = foldStateAtSeq(store, conversationId, targetSeq);
  const snapshot: ConversationSnapshotFile = {
    version: 1,
    conversationId,
    branchId: state.branchId,
    throughSeq: targetSeq,
    createdAt: new Date().toISOString(),
    state,
  };
  const content = JSON.stringify(snapshot, null, 2);
  const sha256 = sha256HexV112(content);
  // Tên file theo throughSeq; sau compact seq đánh lại từ 1 nên số
  // throughSeq có thể tái sử dụng — nếu file đã tồn tại với nội dung
  // khác (snapshot cũ), thêm hậu tố -2/-3… để không ghi đè snapshot
  // cũ. Event snapshot ghi đúng tên file đã dùng nên read vẫn verify.
  let file = snapshotFileName(conversationId, targetSeq);
  let filePath = path.join(storeFileDir(store), file);
  if (fs.existsSync(filePath) && sha256HexV112(fs.readFileSync(filePath, 'utf8')) !== sha256) {
    const safe = conversationId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'conversation';
    let n = 2;
    while (fs.existsSync(path.join(storeFileDir(store), `${safe}.snapshot-${targetSeq}-${n}.json`))) n += 1;
    file = `${safe}.snapshot-${targetSeq}-${n}.json`;
    filePath = path.join(storeFileDir(store), file);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  const event = store.append(conversationId, state.branchId, 'conversation.snapshot', {
    file,
    throughSeq: targetSeq,
    messageCount: state.messages.length,
    sha256,
  });
  return {
    file,
    throughSeq: targetSeq,
    messageCount: state.messages.length,
    sha256,
    snapshotEventSeq: event.seq,
  };
}

/**
 * Đọc + verify snapshot MỚI NHẤT (theo event `conversation.snapshot`
 * cuối cùng trong log — file + hash lấy từ event đó). Ném lỗi khi
 * file thiếu/hỏng hoặc hash sai.
 */
export function readConversationSnapshot(
  store: ConversationLogStore,
  conversationId: string,
): ConversationSnapshotFile {
  const { events } = store.readAll(conversationId);
  const latest = [...events]
    .reverse()
    .find((event) => event.type === 'conversation.snapshot');
  if (!latest) {
    throw new Error(`Conversation ${conversationId} chưa có snapshot nào.`);
  }
  const payload = latest.payload as { file?: string; throughSeq?: number; sha256?: string };
  if (typeof payload.file !== 'string' || typeof payload.sha256 !== 'string') {
    throw new Error(`Event snapshot của ${conversationId} thiếu file/sha256.`);
  }
  const file = path.join(storeFileDir(store), path.basename(payload.file));
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Không đọc được snapshot của ${conversationId} (${payload.file}): ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Snapshot của ${conversationId} (${payload.file}) không phải JSON hợp lệ.`);
  }
  const snapshot = parsed as ConversationSnapshotFile;
  if (snapshot.version !== 1 || snapshot.conversationId !== conversationId || !snapshot.state) {
    throw new Error(`Snapshot của ${conversationId} sai định dạng (version/conversationId/state).`);
  }
  if (snapshot.throughSeq !== payload.throughSeq) {
    throw new Error(
      `Snapshot của ${conversationId} (${payload.file}) có throughSeq ${snapshot.throughSeq}, khác event log ${payload.throughSeq}.`,
    );
  }
  const actualHash = sha256HexV112(content);
  if (actualHash !== payload.sha256) {
    throw new Error(
      `Snapshot của ${conversationId} đã bị sửa: hash file (${actualHash.slice(0, 12)}…) khác hash ghi trong log (${payload.sha256.slice(0, 12)}…).`,
    );
  }
  return snapshot;
}

/**
 * Replay đầy đủ: bắt đầu từ snapshot (nếu có) rồi fold các event
 * sau `throughSeq`. Log đã compact có anchor event
 * `conversation.snapshot` ở đầu (seq 1, throughSeq = snapshot): các
 * event sau anchor được fold hết, bất kể seq mới của chúng nhỏ hơn
 * throughSeq. Khi không có snapshot thì fold từ đầu như thường.
 */
export function replayFromSnapshot(
  store: ConversationLogStore,
  conversationId: string,
): RestoreFromSnapshotResult {
  const { events } = store.readAll(conversationId, { verify: true });
  let snapshot: ConversationSnapshotFile | null = null;
  try {
    snapshot = readConversationSnapshot(store, conversationId);
  } catch {
    snapshot = null;
  }
  if (!snapshot) {
    const state = emptyConversationState(conversationId);
    for (const event of events) foldConversationEvent(state, event);
    return { state, foldedAfterSnapshot: events.length };
  }
  const state: ConversationState = JSON.parse(JSON.stringify(snapshot.state)) as ConversationState;
  // Tìm anchor: event snapshot đầu log có throughSeq khớp snapshot.
  const anchorIdx = events.findIndex(
    (event) =>
      event.type === 'conversation.snapshot' &&
      (event.payload as { throughSeq?: number }).throughSeq === snapshot.throughSeq,
  );
  let folded = 0;
  if (anchorIdx >= 0) {
    // Log đã compact (hoặc snapshot event nằm trong log): fold anchor
    // trước (đặt latestSnapshot), rồi mọi event SAU anchor — kể cả
    // event snapshot sau anchor — và bỏ qua mọi event trước anchor.
    foldConversationEvent(state, events[anchorIdx]!);
    for (let i = anchorIdx + 1; i < events.length; i++) {
      foldConversationEvent(state, events[i]!);
      folded += 1;
    }
  } else {
    for (const event of events) {
      if (event.seq <= snapshot.throughSeq) continue;
      foldConversationEvent(state, event);
      folded += 1;
    }
  }
  return { state, foldedAfterSnapshot: folded };
}

/**
 * Compact log: snapshot tại `throughSeq` (mặc định = seq cuối trừ 1,
 * để lại ít nhất 1 event sau snapshot), rồi viết lại log giữ lại
 * event snapshot-anchor + các event sau throughSeq. Event anchor là
 * một event `conversation.snapshot` MỚI (seq 1 trong log mới) — chain
 * mới bắt đầu từ anchor này.
 */
export function compactConversation(
  store: ConversationLogStore,
  conversationId: string,
  throughSeq?: number,
): CompactConversationResult {
  const { events } = store.readAll(conversationId, { verify: true });
  if (events.length === 0) {
    throw new Error(`Không compact được: conversation ${conversationId} chưa có event nào.`);
  }
  const lastSeq = events[events.length - 1]!.seq;
  const targetSeq = throughSeq ?? lastSeq - 1;
  if (targetSeq < 1 || targetSeq >= lastSeq) {
    throw new Error(
      `Không compact được: throughSeq ${targetSeq} phải trong khoảng 1..${lastSeq - 1} (để lại ít nhất 1 event sau snapshot).`,
    );
  }
  const snapshot = createConversationSnapshot(store, conversationId, targetSeq);
  const after = events.filter((event) => event.seq > targetSeq);
  const branchId = events[0]!.branchId;
  const anchorBase = {
    seq: 1,
    conversationId,
    branchId,
    at: new Date().toISOString(),
    type: 'conversation.snapshot' as const,
    payload: {
      file: snapshot.file,
      throughSeq: snapshot.throughSeq,
      messageCount: snapshot.messageCount,
      sha256: snapshot.sha256,
    },
    prevHash: '',
  };
  const anchor: AnyConversationEvent = { ...anchorBase, hash: hashConversationEvent(anchorBase) };
  // Viết lại các event sau throughSeq với seq mới (nối từ anchor).
  const rewritten: AnyConversationEvent[] = [];
  let prevHash = anchor.hash;
  let seq = 2;
  for (const event of after) {
    const base = {
      seq,
      conversationId,
      branchId,
      at: event.at,
      type: event.type,
      payload: event.payload,
      prevHash,
    };
    const hashed = { ...base, hash: hashConversationEvent(base) };
    rewritten.push(hashed as AnyConversationEvent);
    prevHash = hashed.hash;
    seq += 1;
  }
  const removedEvents = events.length - rewritten.length;
  store.rewrite(conversationId, branchId, [anchor, ...rewritten]);
  store.append(conversationId, branchId, 'conversation.compacted', {
    throughSeq: targetSeq,
    removedEvents,
    snapshotFile: snapshot.file,
  });
  const { events: remaining } = store.readAll(conversationId);
  return {
    snapshotFile: snapshot.file,
    throughSeq: targetSeq,
    removedEvents,
    remainingEvents: remaining.length,
  };
}
