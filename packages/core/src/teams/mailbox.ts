/**
 * Agent Teams v1 — mailbox (v1.09, Đội T1).
 *
 * Hộp thư của team: teammate nhắn trực tiếp cho nhau và cho lead.
 * Tin nhắn có loại: request (nhờ làm việc / xin thông tin), result
 * (trả kết quả cho người đã request), question (hỏi — teammate bí
 * thì hỏi lead), broadcast (thông báo toàn team, chỉ lead được gửi).
 *
 * Thuần logic, thao tác trên mảng tin nhắn truyền vào, trả về bản
 * sao mới. Mailbox giới hạn số tin nhắn mỗi bot (cũ nhất bị cắt)
 * để file lưu team không phình vô hạn.
 */

import {
  newTeamId,
  type AgentTeamV109,
  type MailboxMessage,
  type MailboxMessageKind,
  type SendTeamMessageInput,
  type Teammate,
  MAX_MAILBOX_MESSAGES_PER_BOT,
} from './types';

/** Kết quả một thao tác mailbox. */
export type MailboxResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): MailboxResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): MailboxResult<T> {
  return { ok: false, error };
}

/** Validate tin nhắn trước khi gửi. */
export function validateTeamMessage(
  team: AgentTeamV109,
  input: SendTeamMessageInput,
): string[] {
  const errors: string[] = [];
  const sender = team.teammates.find((m) => m.id === input.fromId);
  if (!sender) errors.push(`Người gửi không tồn tại trong team: ${input.fromId}.`);
  if (!input.body.trim()) errors.push('Nội dung tin nhắn không được rỗng.');
  if (input.body.length > 8000) errors.push('Tin nhắn tối đa 8000 ký tự.');
  if (input.toId !== '*') {
    const recipient = team.teammates.find((m) => m.id === input.toId);
    if (!recipient) errors.push(`Người nhận không tồn tại trong team: ${input.toId}.`);
    if (input.fromId === input.toId) errors.push('Không tự nhắn cho chính mình.');
  } else if (input.kind === 'broadcast' && sender?.role !== 'lead') {
    errors.push('Chỉ lead mới được gửi broadcast.');
  }
  if (input.kind === 'question' && input.toId !== '*' && input.toId !== team.leadId) {
    errors.push('Question chỉ gửi cho lead (hoặc broadcast cho cả team hỏi chung).');
  }
  if (input.kind === 'result' && !input.taskId) {
    errors.push('Tin result phải gắn với một task (taskId).');
  }
  if (input.taskId && !team.tasks.some((t) => t.id === input.taskId)) {
    errors.push(`Task không tồn tại: ${input.taskId}.`);
  }
  if (!team.config.allowQuestionsToLead && input.kind === 'question') {
    errors.push('Team này đã tắt question gửi lead.');
  }
  return errors;
}

/** Tạo tin nhắn mới (chưa chèn vào mailbox). */
export function createTeamMessage(
  team: AgentTeamV109,
  input: SendTeamMessageInput,
  now = Date.now(),
): MailboxMessage {
  const sender = team.teammates.find((m) => m.id === input.fromId);
  return {
    id: newTeamId('msg'),
    teamId: team.id,
    fromId: input.fromId,
    fromName: sender?.name ?? input.fromId,
    toId: input.toId,
    kind: input.kind,
    taskId: input.taskId,
    body: input.body.trim(),
    read: false,
    createdAt: now,
  };
}

/**
 * Gửi tin nhắn: validate rồi chèn vào mailbox, cắt tin cũ nhất của
 * người nhận khi vượt giới hạn. Broadcast ('*') được tính là gửi cho
 * mọi teammate trừ người gửi — lưu một bản duy nhất với toId='*'.
 */
export function sendTeamMessage(
  team: AgentTeamV109,
  input: SendTeamMessageInput,
  now = Date.now(),
): MailboxResult<{ team: AgentTeamV109; message: MailboxMessage }> {
  const errors = validateTeamMessage(team, input);
  if (errors.length > 0) return fail(errors.join(' '));
  const message = createTeamMessage(team, input, now);
  let messages = [...team.messages, message];
  messages = pruneMailbox(messages, team.teammates);
  return ok({ team: { ...team, messages, updatedAt: now }, message });
}

/**
 * Cắt tin nhắn cũ nhất khi một bot nhận quá nhiều tin: mỗi bot giữ
 * tối đa MAX_MAILBOX_MESSAGES_PER_BOT tin (trực tiếp + broadcast).
 * Broadcast tính cho mọi bot.
 */
export function pruneMailbox(
  messages: MailboxMessage[],
  teammates: Teammate[],
): MailboxMessage[] {
  const counts = new Map<string, number>();
  const keep = new Set<string>();
  // Duyệt từ mới nhất về cũ nhất, giữ tới giới hạn mỗi bot.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const recipients =
      msg.toId === '*' ? teammates.map((m) => m.id) : [msg.toId];
    let wouldExceed = false;
    for (const r of recipients) {
      if ((counts.get(r) ?? 0) >= MAX_MAILBOX_MESSAGES_PER_BOT) {
        wouldExceed = true;
        break;
      }
    }
    if (wouldExceed) continue;
    keep.add(msg.id);
    for (const r of recipients) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return messages.filter((m) => keep.has(m.id));
}

/** Hộp thư đến của một bot: tin gửi trực tiếp cho bot + broadcast (trừ tin tự gửi). */
export function inboxFor(messages: MailboxMessage[], teammateId: string): MailboxMessage[] {
  return messages
    .filter(
      (m) =>
        (m.toId === teammateId || m.toId === '*') && m.fromId !== teammateId,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Hộp thư đi của một bot. */
export function outboxFor(messages: MailboxMessage[], teammateId: string): MailboxMessage[] {
  return messages
    .filter((m) => m.fromId === teammateId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Số tin chưa đọc trong hộp thư đến của một bot. */
export function unreadCount(messages: MailboxMessage[], teammateId: string): number {
  return inboxFor(messages, teammateId).filter((m) => !m.read).length;
}

/** Số tin chưa đọc của toàn team (tổng theo từng bot, broadcast tính cho mỗi người nhận). */
export function teamUnreadCount(team: AgentTeamV109): number {
  return team.teammates.reduce((sum, m) => sum + unreadCount(team.messages, m.id), 0);
}

/** Đánh dấu đã đọc một tin (chỉ người nhận trực tiếp mới được đánh dấu). */
export function markMessageRead(
  messages: MailboxMessage[],
  messageId: string,
  teammateId: string,
): MailboxResult<MailboxMessage[]> {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return fail(`Không tìm thấy tin nhắn ${messageId}.`);
  const msg = messages[idx];
  if (msg.toId !== teammateId && msg.toId !== '*') {
    return fail('Chỉ người nhận mới được đánh dấu đã đọc tin này.');
  }
  if (msg.read) return ok(messages);
  const next = [...messages];
  next[idx] = { ...msg, read: true };
  return ok(next);
}

/** Đánh dấu đã đọc toàn bộ hộp thư đến của một bot. */
export function markInboxRead(
  messages: MailboxMessage[],
  teammateId: string,
): MailboxMessage[] {
  const inboxIds = new Set(inboxFor(messages, teammateId).map((m) => m.id));
  return messages.map((m) => (inboxIds.has(m.id) ? { ...m, read: true } : m));
}

/** Tin nhắn theo loại (để UI lọc request/result/question/broadcast). */
export function messagesByKind(
  messages: MailboxMessage[],
  kind: MailboxMessageKind,
): MailboxMessage[] {
  return messages.filter((m) => m.kind === kind);
}

/** Tin nhắn liên quan tới một task (request/result gắn taskId). */
export function messagesForTask(messages: MailboxMessage[], taskId: string): MailboxMessage[] {
  return messages
    .filter((m) => m.taskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Question chưa được trả lời: question gửi cho lead mà chưa có result/question trả lời sau đó. */
export function unansweredQuestions(team: AgentTeamV109): MailboxMessage[] {
  const questions = team.messages.filter((m) => m.kind === 'question');
  return questions.filter((q) => {
    // Đã có tin nhắn từ lead (hoặc bất kỳ ai) trả lời sau question này cho cùng task/người hỏi.
    // Dùng >= vì hai tin nhắn có thể cùng mili-giây (Date.now()).
    const answered = team.messages.some(
      (m) =>
        m.createdAt >= q.createdAt &&
        m.id !== q.id &&
        (m.toId === q.fromId || m.toId === '*') &&
        (m.kind === 'result' || m.kind === 'request') &&
        (m.taskId === q.taskId || !q.taskId),
    );
    return !answered;
  });
}
