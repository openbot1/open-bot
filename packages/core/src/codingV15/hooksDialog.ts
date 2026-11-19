/**
 * Coding agent v15 — hooks dialog.
 *
 * Vấn đề: stop hook (và các hook khác) thường chèn feedback trực
 * tiếp vào luồng chat — user đang đọc hội thoại thì bị chen một
 * message lạ, khó phân biệt đâu là agent nói, đâu là hook nói, và
 * feedback dễ bị trôi mất khi chat dài.
 *
 * v15 giữ feedback NGOÀI chat: khi hook kích hoạt, feedback đi vào
 * dialog riêng (queue). Luồng chat không nhận thêm message nào từ
 * hook. Người dùng mở dialog, xem từng feedback, xác nhận
 * (confirm), bỏ qua (dismiss) hoặc tạm ẩn (snooze) — quyết định
 * được ghi lại kèm thời gian, không làm thay đổi chat.
 *
 * - `routeStopHookFeedback()`: điểm vào duy nhất của stop hook —
 *   nhận feedback, đẩy vào dialog, trả về id + trạng thái dialog.
 * - Dialog có persistence JSON tuỳ chọn (file `hooks-dialog.json`
 *   trong data dir) để feedback pending sống qua restart.
 * - Snooze đẩy feedback xuống cuối queue và tăng snoozeCount (tối
 *   đa 3 lần — quá 3 lần thì snooze bị từ chối, user phải confirm
 *   hoặc dismiss, tránh feedback bị ẩn mãi).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV15Error } from './types';
import type {
  V15HookDecision,
  V15HookFeedback,
  V15HookKind,
  V15HooksDialogState,
  V15NewHookFeedback,
} from './types';

/** Số lần snooze tối đa cho một feedback. */
export const V15_HOOK_MAX_SNOOZE = 3;

/** Tên file persistence mặc định trong data dir. */
export const V15_HOOKS_DIALOG_FILE_NAME = 'hooks-dialog.json';

/** Validate input feedback mới. */
export function v15ValidateNewHookFeedback(input: V15NewHookFeedback): void {
  if (!input || typeof input !== 'object') {
    throw new CodingV15Error('hooks-invalid', 'Hook feedback phải là object.');
  }
  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    throw new CodingV15Error('hooks-invalid', 'Hook feedback cần runId không rỗng.');
  }
  if (typeof input.source !== 'string' || input.source.trim().length === 0) {
    throw new CodingV15Error('hooks-invalid', 'Hook feedback cần source không rỗng.');
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new CodingV15Error('hooks-invalid', 'Hook feedback cần title không rỗng.');
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new CodingV15Error('hooks-invalid', 'Hook feedback cần body không rỗng.');
  }
  if (input.title.length > 300 || input.body.length > 8000) {
    throw new CodingV15Error('hooks-invalid', 'Hook feedback title tối đa 300 ký tự, body tối đa 8000 ký tự.');
  }
  if (input.hookKind !== undefined && !['stop', 'permission', 'notification'].includes(input.hookKind)) {
    throw new CodingV15Error('hooks-invalid', `Hook kind "${String(input.hookKind)}" không hợp lệ.`);
  }
  if (input.severity !== undefined && !['info', 'warning', 'error'].includes(input.severity)) {
    throw new CodingV15Error('hooks-invalid', `Hook severity "${String(input.severity)}" không hợp lệ.`);
  }
}

/** Tạo id feedback ổn định từ runId + seq. */
export function v15NewHookFeedbackId(runId: string, seq: number): string {
  return `vhf-${runId}-${seq}`;
}

/** Tóm tắt một dòng của một feedback (cho dialog list). */
export function renderV15HookFeedbackSummary(feedback: V15HookFeedback): string {
  const icon = feedback.severity === 'error' ? '✖' : feedback.severity === 'warning' ? '⚠' : 'ℹ';
  const snooze = feedback.snoozeCount > 0 ? ` (snoozed ${feedback.snoozeCount}x)` : '';
  return `${icon} [${feedback.status}] ${feedback.title} — ${feedback.source} (${feedback.hookKind}, run ${feedback.runId})${snooze}`;
}

/** Render toàn bộ dialog thành text (cho tool output / log). */
export function renderV15HooksDialog(state: V15HooksDialogState): string {
  const lines = [
    `Hooks dialog — ${state.open ? 'OPEN' : 'closed'}: ${state.pending} pending / ${state.total} total (${state.confirmed} confirmed, ${state.dismissed} dismissed, ${state.snoozed} snoozed)`,
  ];
  if (state.pendingItems.length === 0) {
    lines.push('  No pending hook feedback. Chat is untouched by hooks.');
  } else {
    for (const item of state.pendingItems) {
      lines.push(`  - ${renderV15HookFeedbackSummary(item)}`);
      lines.push(`    ${item.body.slice(0, 200)}${item.body.length > 200 ? '…' : ''}`);
    }
  }
  return lines.join('\n');
}

export interface V15HooksDialogOptions {
  /** Thư mục chứa hooks-dialog.json (bỏ qua = chỉ memory). */
  dataDir?: string;
  now?: () => string;
}

/**
 * Hooks dialog: queue feedback của hook ngoài chat.
 *
 * Quy ước: KHÔNG có API nào ở đây ghi vào chat. Mọi feedback chỉ
 * xuất hiện qua `state()` / `pending()` / `renderV15HooksDialog()`.
 */
export class CodingV15HooksDialog {
  private readonly items = new Map<string, V15HookFeedback>();
  private order: string[] = [];
  private seq = 0;
  private isOpen = false;
  private selectedId: string | null = null;
  private readonly dataDir?: string;
  private readonly nowFn: () => string;

  constructor(options: V15HooksDialogOptions = {}) {
    this.dataDir = options.dataDir;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    if (this.dataDir) this.loadFromDisk();
  }

  private filePath(): string {
    return path.join(this.dataDir as string, V15_HOOKS_DIALOG_FILE_NAME);
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as { items?: unknown; seq?: unknown };
      if (!Array.isArray(parsed.items)) return;
      for (const item of parsed.items) {
        if (!item || typeof item !== 'object') continue;
        const f = item as V15HookFeedback;
        if (typeof f.id !== 'string' || typeof f.runId !== 'string') continue;
        this.items.set(f.id, { ...f });
        this.order.push(f.id);
      }
      if (typeof parsed.seq === 'number' && parsed.seq > this.seq) this.seq = parsed.seq;
    } catch {
      // File chưa có = dialog mới.
    }
  }

  private saveToDisk(): void {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const payload = { version: 1, seq: this.seq, items: this.order.map((id) => this.items.get(id)).filter(Boolean) };
    const tmp = `${this.filePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath());
  }

  /** Dialog đang mở? */
  get open(): boolean {
    return this.isOpen;
  }

  openDialog(): V15HooksDialogState {
    this.isOpen = true;
    return this.state();
  }

  closeDialog(): V15HooksDialogState {
    this.isOpen = false;
    this.selectedId = null;
    return this.state();
  }

  /**
   * Thêm feedback mới vào dialog. Feedback KHÔNG đi vào chat — hàm
   * này chỉ trả về item đã lưu trong dialog.
   */
  addFeedback(input: V15NewHookFeedback): V15HookFeedback {
    v15ValidateNewHookFeedback(input);
    this.seq += 1;
    const at = input.createdAt ?? this.nowFn();
    const item: V15HookFeedback = {
      id: v15NewHookFeedbackId(input.runId, this.seq),
      runId: input.runId,
      hookKind: input.hookKind ?? 'stop',
      source: input.source,
      title: input.title,
      body: input.body,
      severity: input.severity ?? 'info',
      status: 'pending',
      createdAt: at,
      snoozeCount: 0,
    };
    this.items.set(item.id, item);
    this.order.push(item.id);
    this.isOpen = true;
    this.saveToDisk();
    return { ...item };
  }

  get(id: string): V15HookFeedback {
    const item = this.items.get(id);
    if (!item) throw new CodingV15Error('hooks-feedback-not-found', `Không tìm thấy hook feedback "${id}".`);
    return { ...item };
  }

  /** Tất cả feedback pending theo thứ tự hiển thị (cũ nhất trước). */
  pending(): V15HookFeedback[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((f): f is V15HookFeedback => f !== undefined && f.status === 'pending')
      .map((f) => ({ ...f }));
  }

  /** Feedback pending của một run. */
  pendingForRun(runId: string): V15HookFeedback[] {
    return this.pending().filter((f) => f.runId === runId);
  }

  /** Tất cả feedback (mọi trạng thái) theo thứ tự thêm vào. */
  all(): V15HookFeedback[] {
    return this.order
      .map((id) => this.items.get(id))
      .filter((f): f is V15HookFeedback => f !== undefined)
      .map((f) => ({ ...f }));
  }

  /** Chọn một feedback trong dialog (để UI highlight). */
  select(id: string): V15HooksDialogState {
    const item = this.items.get(id);
    if (!item) throw new CodingV15Error('hooks-feedback-not-found', `Không tìm thấy hook feedback "${id}".`);
    this.selectedId = id;
    this.isOpen = true;
    return this.state();
  }

  /**
   * Quyết định trên một feedback: confirm (đã xem/đồng ý), dismiss
   * (bỏ qua) hoặc snooze (tạm ẩn — đẩy xuống cuối queue, tối đa 3 lần).
   */
  decide(id: string, decision: V15HookDecision, note?: string): V15HookFeedback {
    const item = this.items.get(id);
    if (!item) throw new CodingV15Error('hooks-feedback-not-found', `Không tìm thấy hook feedback "${id}".`);
    if (item.status !== 'pending') {
      throw new CodingV15Error('hooks-dialog-invalid', `Feedback "${id}" đã ở trạng thái ${item.status}, không quyết định lại được.`);
    }
    if (decision === 'snooze') {
      if (item.snoozeCount >= V15_HOOK_MAX_SNOOZE) {
        throw new CodingV15Error(
          'hooks-dialog-invalid',
          `Feedback "${id}" đã snooze ${V15_HOOK_MAX_SNOOZE} lần — hãy confirm hoặc dismiss thay vì snooze tiếp.`,
        );
      }
      item.snoozeCount += 1;
      item.status = 'snoozed';
      item.decidedAt = this.nowFn();
      if (note !== undefined) item.note = note;
      // Đẩy xuống cuối queue để feedback khác lên trước; khi user mở
      // lại dialog thì snoozed item quay lại pending (xem `unsnoozeAll`).
      this.order = [...this.order.filter((x) => x !== id), id];
    } else {
      item.status = decision === 'confirm' ? 'confirmed' : 'dismissed';
      item.decidedAt = this.nowFn();
      if (note !== undefined) item.note = note;
    }
    this.saveToDisk();
    return { ...item };
  }

  /** Đưa tất cả feedback snoozed trở lại pending (khi user mở lại dialog sau một lúc). */
  unsnoozeAll(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === 'snoozed') {
        item.status = 'pending';
        item.decidedAt = undefined;
        count += 1;
      }
    }
    if (count > 0) this.saveToDisk();
    return count;
  }

  /** Đếm theo trạng thái. */
  counts(): { total: number; pending: number; confirmed: number; dismissed: number; snoozed: number } {
    const out = { total: this.items.size, pending: 0, confirmed: 0, dismissed: 0, snoozed: 0 };
    for (const item of this.items.values()) out[item.status] += 1;
    return out;
  }

  /** Trạng thái dialog hiện tại (để UI render). */
  state(): V15HooksDialogState {
    const c = this.counts();
    return {
      open: this.isOpen,
      total: c.total,
      pending: c.pending,
      confirmed: c.confirmed,
      dismissed: c.dismissed,
      snoozed: c.snoozed,
      pendingItems: this.pending(),
      selectedId: this.selectedId,
    };
  }
}

/**
 * Điểm vào của stop hook: nhận feedback khi stop hook kích hoạt,
 * đẩy vào dialog (KHÔNG chèn vào chat), trả về item + state dialog.
 * Agent gọi hàm này thay vì append message vào luồng chat.
 */
export function routeStopHookFeedback(
  dialog: CodingV15HooksDialog,
  input: Omit<V15NewHookFeedback, 'hookKind'> & { hookKind?: V15HookKind },
): { feedback: V15HookFeedback; dialogState: V15HooksDialogState; chatUntouched: true } {
  const feedback = dialog.addFeedback({ ...input, hookKind: input.hookKind ?? 'stop' });
  return { feedback, dialogState: dialog.state(), chatUntouched: true };
}
