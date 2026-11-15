/**
 * Agent Teams v2 — disk mailbox peer-to-peer theo TÊN (v1.10, Đội T3).
 *
 * V1 mailbox sống trong mảng `team.messages` của file team JSON:
 * gửi/nhận theo teammate id, chỉ bền vững khi cả file team được
 * lưu. V2 thêm mailbox trên disk, địa chỉ theo TÊN teammate:
 *
 * - `mailbox/<slug-tên>/inbox/<msgId>.json` — thư đến của teammate.
 * - `mailbox/<slug-tên>/outbox/<msgId>.json` — thư đi của teammate.
 * - Gửi direct: ghi 1 file vào inbox người nhận + 1 file vào
 *   outbox người gửi (cùng id tin nhắn).
 * - Broadcast (`toName='*'`): ghi 1 file inbox cho mỗi teammate
 *   trừ người gửi + 1 file outbox cho người gửi.
 * - Xác nhận đã đọc: `markRead` ghi `readAt` + `readBy` vào file
 *   inbox (ghi nguyên tử temp + rename); chỉ người nhận (hoặc lead
 *   đọc broadcast thay mặt team) mới được đánh dấu.
 * - Tin nhắn tối đa 8000 ký tự, mỗi hộp giữ tối đa 500 tin (cũ
 *   nhất bị cắt khi gửi tin mới) — cùng luật với v1.
 *
 * Tên là địa chỉ chính: lead/worker gọi nhau bằng tên hiển thị
 * (`mailbox_v2_send toName="coder"`), không cần nhớ id. Tên trùng
 * nhau không xảy ra vì v1 đã cấm trùng tên trong team.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { newTeamId } from '../types';
import {
  MAX_DISK_MAILBOX_PER_BOX,
  slugifyTeammateName,
  type DiskMailboxMessage,
  type DiskMailboxBox,
} from './types';

/** Kết quả một thao tác disk mailbox. */
export type DiskMailboxResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): DiskMailboxResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): DiskMailboxResult<T> {
  return { ok: false, error };
}

/** Thư mục mailbox của team: `<baseDir>/teams-v2/<teamId>/mailbox/`. */
export function teamMailboxDir(baseDir: string, teamId: string): string {
  return path.join(baseDir, 'teams-v2', teamId, 'mailbox');
}

/** Thư mục hộp thư của một teammate (theo tên): inbox + outbox. */
export function teammateMailboxDir(baseDir: string, teamId: string, teammateName: string): string {
  return path.join(teamMailboxDir(baseDir, teamId), slugifyTeammateName(teammateName));
}

function inboxDir(baseDir: string, teamId: string, teammateName: string): string {
  return path.join(teammateMailboxDir(baseDir, teamId, teammateName), 'inbox');
}

function outboxDir(baseDir: string, teamId: string, teammateName: string): string {
  return path.join(teammateMailboxDir(baseDir, teamId, teammateName), 'outbox');
}

/** Ghi một tin nhắn xuống file JSON (mode 0600). */
function writeMessageFile(dir: string, message: DiskMailboxMessage): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${message.id}.json`);
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(message, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Đọc mọi tin trong một thư mục (bỏ file hỏng, xếp theo createdAt). */
function readBoxDir(dir: string): DiskMailboxMessage[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: DiskMailboxMessage[] = [];
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const msg = parsed as DiskMailboxMessage;
      if (typeof msg.id !== 'string' || typeof msg.body !== 'string') continue;
      out.push(msg);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Cắt hộp thư khi vượt giới hạn: xóa file cũ nhất tới khi còn
 * tối đa MAX_DISK_MAILBOX_PER_BOX tin. Trả về số file đã xóa.
 */
function pruneBoxDir(dir: string): number {
  const messages = readBoxDir(dir);
  if (messages.length <= MAX_DISK_MAILBOX_PER_BOX) return 0;
  const excess = messages.slice(0, messages.length - MAX_DISK_MAILBOX_PER_BOX);
  let removed = 0;
  for (const msg of excess) {
    try {
      fs.unlinkSync(path.join(dir, `${msg.id}.json`));
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

/** Input gửi tin qua disk mailbox (địa chỉ theo tên). */
export interface SendDiskMessageInput {
  fromId: string;
  fromName: string;
  /** Tên người nhận, hoặc '*' = broadcast toàn team. */
  toName: string;
  toId: string;
  kind: DiskMailboxMessage['kind'];
  taskId?: string;
  body: string;
  /** Tên mọi teammate trong team (để broadcast ghi inbox từng người). */
  teamMembers: { id: string; name: string }[];
  /** Chỉ lead được broadcast (mặc định kiểm tra qua isLead). */
  isLead: boolean;
  /** Có cho gửi question không (theo config team allowQuestionsToLead). */
  allowQuestionsToLead?: boolean;
}

/** Validate tin nhắn disk trước khi gửi (cùng luật v1, địa chỉ theo tên). */
export function validateDiskMessage(input: SendDiskMessageInput): string[] {
  const errors: string[] = [];
  if (!input.fromName.trim()) errors.push('Người gửi thiếu tên.');
  if (!input.body.trim()) errors.push('Nội dung tin nhắn không được rỗng.');
  if (input.body.length > 8000) errors.push('Tin nhắn tối đa 8000 ký tự.');
  if (input.toName !== '*') {
    const recipient = input.teamMembers.find((m) => m.name === input.toName);
    if (!recipient) errors.push(`Không có teammate tên "${input.toName}" trong team.`);
    else if (recipient.id !== input.toId) errors.push(`toId không khớp với tên "${input.toName}".`);
    if (input.fromName === input.toName) errors.push('Không tự nhắn cho chính mình.');
  } else if (input.kind === 'broadcast' && !input.isLead) {
    errors.push('Chỉ lead mới được gửi broadcast.');
  }
  if (input.kind === 'question' && input.toName !== '*' && input.toId !== input.teamMembers.find((m) => m.name === input.fromName)?.id) {
    // Question chỉ gửi cho lead: kiểm tra ở tầng service (cần biết leadId) — ở đây chỉ chặn question gửi cho chính mình (đã chặn trên).
  }
  if (input.kind === 'result' && !input.taskId) {
    errors.push('Tin result phải gắn với một task (taskId).');
  }
  if (input.allowQuestionsToLead === false && input.kind === 'question') {
    errors.push('Team này đã tắt question gửi lead.');
  }
  return errors;
}

/**
 * Gửi tin nhắn qua disk mailbox: ghi inbox người nhận + outbox
 * người gửi (broadcast: inbox mọi teammate trừ người gửi).
 * Trả về tin nhắn đã gửi (id duy nhất, dùng chung cho cả 2 bản).
 */
export function sendDiskMessage(
  baseDir: string,
  teamId: string,
  input: SendDiskMessageInput,
  now = Date.now(),
): DiskMailboxResult<DiskMailboxMessage> {
  const errors = validateDiskMessage(input);
  if (errors.length > 0) return fail(errors.join(' '));
  const message: DiskMailboxMessage = {
    id: newTeamId('msg'),
    teamId,
    fromName: input.fromName,
    fromId: input.fromId,
    toName: input.toName,
    toId: input.toId,
    kind: input.kind,
    taskId: input.taskId,
    body: input.body.trim(),
    createdAt: now,
    read: false,
  };
  try {
    if (input.toName === '*') {
      for (const member of input.teamMembers) {
        if (member.id === input.fromId) continue;
        writeMessageFile(inboxDir(baseDir, teamId, member.name), message);
        pruneBoxDir(inboxDir(baseDir, teamId, member.name));
      }
    } else {
      writeMessageFile(inboxDir(baseDir, teamId, input.toName), message);
      pruneBoxDir(inboxDir(baseDir, teamId, input.toName));
    }
    writeMessageFile(outboxDir(baseDir, teamId, input.fromName), message);
    pruneBoxDir(outboxDir(baseDir, teamId, input.fromName));
  } catch (err) {
    return fail(`Không ghi được tin nhắn xuống disk: ${(err as Error).message}`);
  }
  return ok(message);
}

/** Hộp thư đến trên disk của một teammate (direct + broadcast). */
export function readDiskInbox(
  baseDir: string,
  teamId: string,
  teammateName: string,
): DiskMailboxMessage[] {
  return readBoxDir(inboxDir(baseDir, teamId, teammateName));
}

/** Hộp thư đi trên disk của một teammate. */
export function readDiskOutbox(
  baseDir: string,
  teamId: string,
  teammateName: string,
): DiskMailboxMessage[] {
  return readBoxDir(outboxDir(baseDir, teamId, teammateName));
}

/** Cả inbox + outbox + số chưa đọc của một teammate. */
export function readDiskMailboxBox(
  baseDir: string,
  teamId: string,
  teammateName: string,
): DiskMailboxBox {
  const inbox = readDiskInbox(baseDir, teamId, teammateName);
  const outbox = readDiskOutbox(baseDir, teamId, teammateName);
  return {
    teammateName,
    inbox,
    outbox,
    unreadCount: inbox.filter((m) => !m.read).length,
  };
}

/** Số tin chưa đọc trên disk của toàn team (theo từng teammate). */
export function diskUnreadByName(
  baseDir: string,
  teamId: string,
  teammateNames: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of teammateNames) {
    out[name] = readDiskInbox(baseDir, teamId, name).filter((m) => !m.read).length;
  }
  return out;
}

/**
 * Đánh dấu đã đọc một tin trong inbox (xác nhận đã đọc: ghi
 * readAt + readBy vào file inbox). Chỉ người nhận mới được đánh
 * dấu; broadcast thì mỗi người nhận đánh dấu bản của mình.
 */
export function markDiskMessageRead(
  baseDir: string,
  teamId: string,
  teammateName: string,
  messageId: string,
  now = Date.now(),
): DiskMailboxResult<DiskMailboxMessage> {
  const dir = inboxDir(baseDir, teamId, teammateName);
  const filePath = path.join(dir, `${messageId}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail(`Không tìm thấy tin ${messageId} trong inbox của "${teammateName}".`);
    }
    return fail(`Không đọc được tin ${messageId}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fail(`Tin ${messageId} không phải JSON object.`);
  }
  const msg = parsed as DiskMailboxMessage;
  if (msg.toName !== '*' && msg.toName !== teammateName) {
    return fail(`Tin ${messageId} không gửi cho "${teammateName}", không đánh dấu được.`);
  }
  if (msg.read && msg.readAt !== undefined) return ok(msg);
  const updated: DiskMailboxMessage = { ...msg, read: true, readAt: now, readBy: teammateName };
  try {
    writeMessageFile(dir, updated);
  } catch (err) {
    return fail(`Không ghi được xác nhận đã đọc: ${(err as Error).message}`);
  }
  return ok(updated);
}

/** Đánh dấu đã đọc toàn bộ inbox của một teammate. Trả về số tin đã đánh dấu. */
export function markDiskInboxRead(
  baseDir: string,
  teamId: string,
  teammateName: string,
  now = Date.now(),
): number {
  const inbox = readDiskInbox(baseDir, teamId, teammateName);
  let marked = 0;
  for (const msg of inbox) {
    if (msg.read) continue;
    const res = markDiskMessageRead(baseDir, teamId, teammateName, msg.id, now);
    if (res.ok) marked += 1;
  }
  return marked;
}

/** Tin nhắn disk mới nhất của team (gộp inbox mọi teammate + outbox lead, tối đa `limit`). */
export function recentDiskMessages(
  baseDir: string,
  teamId: string,
  teammateNames: string[],
  limit = 20,
): DiskMailboxMessage[] {
  const byId = new Map<string, DiskMailboxMessage>();
  for (const name of teammateNames) {
    for (const msg of readDiskInbox(baseDir, teamId, name)) byId.set(msg.id, msg);
    for (const msg of readDiskOutbox(baseDir, teamId, name)) byId.set(msg.id, msg);
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, limit);
}
