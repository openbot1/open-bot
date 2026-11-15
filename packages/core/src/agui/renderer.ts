/**
 * AG-UI renderer (v1.09, Đội T4) — áp event vào view model theo thời gian thực.
 *
 * Phía desktop đã có feed reducer (`aguiFeed.ts` trong apps/desktop)
 * nhưng nó chỉ là feed hiển thị; module này là view model đầy đủ ở
 * tầng core, để mọi renderer (desktop, dashboard SSE, CLI watch)
 * dùng chung một cách ghép event thành trạng thái UI:
 *  - Run: trạng thái (running/finished/failed/cancelled), title,
 *    provider/model, thời gian chạy, usage khi RUN_FINISHED về.
 *  - Message: text gộp theo messageId (delta nối tiếp), message
 *    chưa END thì `streaming=true` (renderer hiện con trỏ nhấp nháy).
 *  - Tool call: một item duy nhất cho cả vòng đời call (START →
 *    ARGS → END → RESULT gộp lại), trạng thái running/ok/error/denied,
 *    args preview + result preview, duration.
 *  - State: áp snapshot/delta qua AgUiStateStore (chống prototype
 *    pollution, version cũ không rewind state).
 *  - Generative UI: component mở/chờ trả lời; response gộp vào đúng
 *    componentId, component chuyển answered.
 *  - Activity: activity hiện tại của run (planning/thinking/...).
 *  - Out-of-order + gap: event trùng sequence đã áp thì bị bỏ;
 *    event bù gap (sequence nhỏ hơn lastSequence nhưng chưa áp) vẫn
 *    được áp; gap (sequence nhảy cóc) đặt cờ `needsResync=true` để
 *    renderer xin snapshot/resume thay vì hiển thị sai; `applyAll`
 *    tự sắp xếp theo sequence trước khi áp.
 *  - Custom event: lưu vào mục `custom` của run (extension tự đọc).
 *
 * View model là plain JSON (không function) — serialize được thẳng
 * qua IPC/SSE cho renderer ngoài.
 */

import { AgUiStateStore } from './state';
import type { AgUiEvent, AgUiRunStatus, AgUiStateOperation, AgUiToolCallStatus } from './types';
import { isAgUiTerminalType } from './streaming';

/** Trạng thái run trong view model. */
export type AgUiRendererRunStatus = 'idle' | 'running' | AgUiRunStatus;

/** Một message text trong view model. */
export interface AgUiRendererMessage {
  messageId: string;
  role: string;
  /** Text đã gộp tới giờ. */
  text: string;
  /** true khi message đang stream (chưa có TEXT_MESSAGE_END). */
  streaming: boolean;
  /** Sequence của event cuối áp vào message này. */
  lastSequence: number;
}

/** Một tool call trong view model (cả vòng đời gộp một item). */
export interface AgUiRendererToolCall {
  toolCallId: string;
  toolName: string;
  status: 'running' | AgUiToolCallStatus;
  /** Tên key của args (không lộ value — giống runtime emitter). */
  argKeys: string[];
  /** JSON args đã truncate (khi TOOL_CALL_ARGS về). */
  argsJson?: string;
  /** Preview kết quả (khi TOOL_CALL_RESULT về). */
  outputPreview?: string;
  /** true khi tool báo ok (khi RESULT về). */
  ok?: boolean;
  /** Thời gian chạy (ms, khi END về). */
  durationMs?: number;
  step?: number;
  /** Sequence của event cuối áp vào call này. */
  lastSequence: number;
}

/** Một component generative UI trong view model. */
export interface AgUiRendererComponent {
  componentId: string;
  kind: string;
  title: string;
  description?: string;
  props: Record<string, unknown>;
  blocking: boolean;
  /** true khi user đã trả lời. */
  answered: boolean;
  response?: Record<string, unknown>;
  action?: string;
  lastSequence: number;
}

/** View model của một run (plain JSON). */
export interface AgUiRendererRunView {
  runId: string;
  botId?: string;
  threadId?: string;
  status: AgUiRendererRunStatus;
  title?: string;
  providerId?: string;
  model?: string;
  toolCount?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  steps?: number;
  toolCalls?: number;
  tokensUsed?: number;
  finalText?: string;
  error?: string;
  messages: AgUiRendererMessage[];
  toolCallList: AgUiRendererToolCall[];
  components: AgUiRendererComponent[];
  /** Activity hiện tại (kind + label), undefined khi không có. */
  activity?: { kind: string; label: string; detail?: string; progress?: number };
  /** State chia sẻ của run (snapshot/delta đã áp). */
  state: Record<string, unknown>;
  /** Custom event gần nhất theo tên (extension đọc). */
  custom: Record<string, { value?: Record<string, unknown>; sequence: number }>;
  /** Sequence của event cuối đã áp vào run này. */
  lastSequence: number;
  /** Số event đã áp / bỏ / gap. */
  appliedEvents: number;
  skippedEvents: number;
  gapsDetected: number;
  /** true khi view thiếu event (cần resync: xin snapshot + replay). */
  needsResync: boolean;
  /** Sequence còn thiếu (để xin replay). */
  missingSequences: number[];
}

/** Tóm tắt run cho danh sách run (không kèm message/tool detail). */
export interface AgUiRendererRunSummary {
  runId: string;
  status: AgUiRendererRunStatus;
  title?: string;
  lastSequence: number;
  messageCount: number;
  toolCallCount: number;
  needsResync: boolean;
}

interface MutableRun {
  view: AgUiRendererRunView;
  messagesById: Map<string, AgUiRendererMessage>;
  toolCallsById: Map<string, AgUiRendererToolCall>;
  componentsById: Map<string, AgUiRendererComponent>;
  /** Sequence đã áp (để phân biệt event trùng với event bù gap). */
  appliedSequences: Set<number>;
}

/**
 * Renderer view model cho nhiều run. `apply(event)` là điểm vào duy
 * nhất — mọi event đi qua đây, theo đúng thứ tự sequence.
 */
export class AgUiRenderer {
  private readonly runs = new Map<string, MutableRun>();
  private readonly stateStore: AgUiStateStore;
  private totalApplied = 0;
  private totalSkipped = 0;
  private totalGaps = 0;

  constructor(stateStore?: AgUiStateStore) {
    this.stateStore = stateStore ?? new AgUiStateStore();
  }

  /** Số run đang có view. */
  get runCount(): number {
    return this.runs.size;
  }

  /** Tổng event đã áp / bỏ / gap trên mọi run. */
  get totals(): { applied: number; skipped: number; gaps: number } {
    return { applied: this.totalApplied, skipped: this.totalSkipped, gaps: this.totalGaps };
  }

  /** Run id đang có view. */
  runIds(): string[] {
    return [...this.runs.keys()];
  }

  /** View của một run (bản copy sâu vừa đủ), undefined khi chưa có event nào. */
  getRun(runId: string): AgUiRendererRunView | undefined {
    const entry = this.runs.get(runId);
    if (!entry) return undefined;
    return cloneRunView(entry.view);
  }

  /** Tóm tắt mọi run (cho danh sách run). */
  summaries(): AgUiRendererRunSummary[] {
    return [...this.runs.values()].map((entry) => ({
      runId: entry.view.runId,
      status: entry.view.status,
      ...(entry.view.title !== undefined ? { title: entry.view.title } : {}),
      lastSequence: entry.view.lastSequence,
      messageCount: entry.view.messages.length,
      toolCallCount: entry.view.toolCallList.length,
      needsResync: entry.view.needsResync,
    }));
  }

  /** Xoá view của một run (vd run đã xong lâu, giải phóng bộ nhớ). */
  dropRun(runId: string): boolean {
    return this.runs.delete(runId);
  }

  /** Xoá mọi view. */
  clear(): void {
    this.runs.clear();
    this.totalApplied = 0;
    this.totalSkipped = 0;
    this.totalGaps = 0;
  }

  /**
   * Áp một event vào view. Trả false khi event bị bỏ (không hợp lệ,
   * trùng/cũ, sai run). Không throw với event xấu — renderer không
   * được chết vì một event lỗi.
   */
  apply(event: AgUiEvent): boolean {
    try {
      return this.applyInner(event);
    } catch {
      this.totalSkipped += 1;
      return false;
    }
  }

  /** Áp nhiều event (tự sắp xếp theo sequence của từng run trước khi áp). */
  applyAll(events: readonly AgUiEvent[]): { applied: number; skipped: number } {
    const byRun = new Map<string, AgUiEvent[]>();
    for (const event of events) {
      const list = byRun.get(event.runId) ?? [];
      list.push(event);
      byRun.set(event.runId, list);
    }
    let applied = 0;
    let skipped = 0;
    for (const list of byRun.values()) {
      const sorted = [...list].sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
      );
      for (const event of sorted) {
        if (this.apply(event)) applied += 1;
        else skipped += 1;
      }
    }
    return { applied, skipped };
  }

  private ensureRun(event: AgUiEvent): MutableRun {
    let entry = this.runs.get(event.runId);
    if (!entry) {
      const view: AgUiRendererRunView = {
        runId: event.runId,
        ...(event.botId !== undefined ? { botId: event.botId } : {}),
        ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
        status: 'idle',
        messages: [],
        toolCallList: [],
        components: [],
        state: {},
        custom: {},
        lastSequence: -1,
        appliedEvents: 0,
        skippedEvents: 0,
        gapsDetected: 0,
        needsResync: false,
        missingSequences: [],
      };
      entry = {
        view,
        messagesById: new Map(),
        toolCallsById: new Map(),
        componentsById: new Map(),
        appliedSequences: new Set(),
      };
      this.runs.set(event.runId, entry);
    }
    return entry;
  }

  private applyInner(event: AgUiEvent): boolean {
    if (!event || typeof event !== 'object') return false;
    if (typeof event.runId !== 'string' || event.runId.length === 0) return false;
    if (typeof event.type !== 'string') return false;
    const entry = this.ensureRun(event);
    const view = entry.view;
    const sequence = typeof event.sequence === 'number' ? event.sequence : -1;
    if (sequence >= 0 && entry.appliedSequences.has(sequence)) {
      // Event trùng (đã áp rồi) — bỏ. Event bù gap có sequence nhỏ
      // hơn lastSequence nhưng CHƯA áp thì vẫn được áp (xem dưới).
      view.skippedEvents += 1;
      this.totalSkipped += 1;
      return false;
    }
    if (sequence > view.lastSequence + 1) {
      view.gapsDetected += 1;
      this.totalGaps += 1;
      view.needsResync = true;
      for (let s = view.lastSequence + 1; s < sequence; s++) {
        if (!view.missingSequences.includes(s)) view.missingSequences.push(s);
      }
      view.missingSequences.sort((a, b) => a - b);
    }
    if (sequence >= 0) {
      entry.appliedSequences.add(sequence);
      view.missingSequences = view.missingSequences.filter((s) => s !== sequence);
      if (view.missingSequences.length === 0) view.needsResync = false;
      if (sequence > view.lastSequence) view.lastSequence = sequence;
    }
    view.appliedEvents += 1;
    this.totalApplied += 1;
    const data = (event.data ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case 'RUN_STARTED': {
        view.status = 'running';
        view.startedAt = event.timestamp;
        if (typeof data['title'] === 'string') view.title = data['title'] as string;
        if (typeof data['providerId'] === 'string') view.providerId = data['providerId'] as string;
        if (typeof data['model'] === 'string') view.model = data['model'] as string;
        if (typeof data['toolCount'] === 'number') view.toolCount = data['toolCount'] as number;
        break;
      }
      case 'RUN_FINISHED': {
        view.status = (data['status'] as AgUiRunStatus) ?? 'completed';
        view.finishedAt = event.timestamp;
        if (typeof data['finalText'] === 'string') view.finalText = data['finalText'] as string;
        if (typeof data['steps'] === 'number') view.steps = data['steps'] as number;
        if (typeof data['toolCalls'] === 'number') view.toolCalls = data['toolCalls'] as number;
        if (typeof data['tokensUsed'] === 'number') view.tokensUsed = data['tokensUsed'] as number;
        if (typeof data['durationMs'] === 'number') view.durationMs = data['durationMs'] as number;
        for (const message of view.messages) message.streaming = false;
        for (const call of view.toolCallList) {
          if (call.status === 'running') call.status = 'error';
        }
        break;
      }
      case 'RUN_ERROR': {
        view.status = 'failed';
        view.finishedAt = event.timestamp;
        if (typeof data['message'] === 'string') view.error = data['message'] as string;
        for (const message of view.messages) message.streaming = false;
        break;
      }
      case 'TEXT_MESSAGE_START': {
        const messageId = messageIdOf(event, data);
        if (!messageId) break;
        if (!entry.messagesById.has(messageId)) {
          const message: AgUiRendererMessage = {
            messageId,
            role: typeof data['role'] === 'string' ? (data['role'] as string) : 'assistant',
            text: '',
            streaming: true,
            lastSequence: sequence,
          };
          entry.messagesById.set(messageId, message);
          view.messages.push(message);
        } else {
          const existing = entry.messagesById.get(messageId) as AgUiRendererMessage;
          existing.streaming = true;
          existing.lastSequence = sequence;
        }
        break;
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = messageIdOf(event, data);
        const delta = typeof data['delta'] === 'string' ? (data['delta'] as string) : '';
        if (!messageId) break;
        let message = entry.messagesById.get(messageId);
        if (!message) {
          // Content về trước START (reorder) — tự tạo message.
          message = { messageId, role: 'assistant', text: '', streaming: true, lastSequence: sequence };
          entry.messagesById.set(messageId, message);
          view.messages.push(message);
        }
        message.text += delta;
        message.streaming = true;
        message.lastSequence = sequence;
        break;
      }
      case 'TEXT_MESSAGE_END': {
        const messageId = messageIdOf(event, data);
        if (!messageId) break;
        const message = entry.messagesById.get(messageId);
        if (message) {
          if (typeof data['fullText'] === 'string') message.text = data['fullText'] as string;
          message.streaming = false;
          message.lastSequence = sequence;
        }
        break;
      }
      case 'TOOL_CALL_START': {
        const toolCallId = toolCallIdOf(event, data);
        if (!toolCallId) break;
        if (!entry.toolCallsById.has(toolCallId)) {
          const call: AgUiRendererToolCall = {
            toolCallId,
            toolName: typeof data['toolName'] === 'string' ? (data['toolName'] as string) : 'unknown',
            status: 'running',
            argKeys: [],
            ...(typeof data['step'] === 'number' ? { step: data['step'] as number } : {}),
            lastSequence: sequence,
          };
          entry.toolCallsById.set(toolCallId, call);
          view.toolCallList.push(call);
        }
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = toolCallIdOf(event, data);
        if (!toolCallId) break;
        const call = entry.toolCallsById.get(toolCallId) ?? createPlaceholderCall(entry, view, toolCallId, data, sequence);
        if (Array.isArray(data['argKeys'])) {
          call.argKeys = (data['argKeys'] as unknown[]).filter((k): k is string => typeof k === 'string');
        }
        if (typeof data['argsJson'] === 'string') call.argsJson = data['argsJson'] as string;
        if (typeof data['toolName'] === 'string' && call.toolName === 'unknown') {
          call.toolName = data['toolName'] as string;
        }
        call.lastSequence = sequence;
        break;
      }
      case 'TOOL_CALL_END': {
        const toolCallId = toolCallIdOf(event, data);
        if (!toolCallId) break;
        const call = entry.toolCallsById.get(toolCallId) ?? createPlaceholderCall(entry, view, toolCallId, data, sequence);
        call.status = (data['status'] as AgUiToolCallStatus) ?? 'ok';
        if (typeof data['durationMs'] === 'number') call.durationMs = data['durationMs'] as number;
        call.lastSequence = sequence;
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const toolCallId = toolCallIdOf(event, data);
        if (!toolCallId) break;
        const call = entry.toolCallsById.get(toolCallId) ?? createPlaceholderCall(entry, view, toolCallId, data, sequence);
        if (typeof data['ok'] === 'boolean') call.ok = data['ok'] as boolean;
        if (typeof data['outputPreview'] === 'string') call.outputPreview = data['outputPreview'] as string;
        call.lastSequence = sequence;
        break;
      }
      case 'STATE_SNAPSHOT': {
        const state = data['state'];
        if (state && typeof state === 'object') {
          const applied = this.stateStore.applySnapshot(event.runId, state as Record<string, unknown>, sequence);
          if (applied) view.state = { ...(applied.state as Record<string, unknown>) };
        }
        break;
      }
      case 'STATE_DELTA': {
        const operations = data['operations'];
        if (Array.isArray(operations)) {
          const applied = this.stateStore.applyDelta(
            event.runId,
            operations as AgUiStateOperation[],
            sequence,
          );
          if (applied) view.state = { ...(applied.state as Record<string, unknown>) };
        }
        break;
      }
      case 'GENERATIVE_UI': {
        const componentId = typeof data['componentId'] === 'string' ? (data['componentId'] as string) : '';
        if (!componentId) break;
        if (!entry.componentsById.has(componentId)) {
          const component: AgUiRendererComponent = {
            componentId,
            kind: typeof data['kind'] === 'string' ? (data['kind'] as string) : 'message',
            title: typeof data['title'] === 'string' ? (data['title'] as string) : '',
            ...(typeof data['description'] === 'string' ? { description: data['description'] as string } : {}),
            props: (data['props'] as Record<string, unknown>) ?? {},
            blocking: data['blocking'] === true,
            answered: false,
            lastSequence: sequence,
          };
          entry.componentsById.set(componentId, component);
          view.components.push(component);
        }
        break;
      }
      case 'GENERATIVE_UI_RESPONSE': {
        const componentId = typeof data['componentId'] === 'string' ? (data['componentId'] as string) : '';
        const component = componentId ? entry.componentsById.get(componentId) : undefined;
        if (component) {
          component.answered = true;
          if (data['response'] && typeof data['response'] === 'object') {
            component.response = { ...(data['response'] as Record<string, unknown>) };
          }
          if (typeof data['action'] === 'string') component.action = data['action'] as string;
          component.lastSequence = sequence;
        }
        break;
      }
      case 'ACTIVITY': {
        if (typeof data['kind'] === 'string' && typeof data['label'] === 'string') {
          view.activity = {
            kind: data['kind'] as string,
            label: data['label'] as string,
            ...(typeof data['detail'] === 'string' ? { detail: data['detail'] as string } : {}),
            ...(typeof data['progress'] === 'number' ? { progress: data['progress'] as number } : {}),
          };
        }
        break;
      }
      case 'CUSTOM': {
        const name = typeof data['name'] === 'string' ? (data['name'] as string) : 'custom';
        view.custom[name] = {
          ...(data['value'] && typeof data['value'] === 'object'
            ? { value: { ...(data['value'] as Record<string, unknown>) } }
            : {}),
          sequence,
        };
        break;
      }
      default:
        break;
    }
    if (isAgUiTerminalType(event.type)) {
      view.status = view.status === 'idle' ? 'completed' : view.status;
    }
    if (event.botId !== undefined && view.botId === undefined) view.botId = event.botId;
    if (event.threadId !== undefined && view.threadId === undefined) view.threadId = event.threadId;
    return true;
  }
}

function messageIdOf(event: AgUiEvent, data: Record<string, unknown>): string {
  if (typeof event.messageId === 'string' && event.messageId.length > 0) return event.messageId;
  if (typeof data['messageId'] === 'string') return data['messageId'] as string;
  return '';
}

function toolCallIdOf(event: AgUiEvent, data: Record<string, unknown>): string {
  if (typeof event.toolCallId === 'string' && event.toolCallId.length > 0) return event.toolCallId;
  if (typeof data['toolCallId'] === 'string') return data['toolCallId'] as string;
  return '';
}

function createPlaceholderCall(
  entry: MutableRun,
  view: AgUiRendererRunView,
  toolCallId: string,
  data: Record<string, unknown>,
  sequence: number,
): AgUiRendererToolCall {
  const call: AgUiRendererToolCall = {
    toolCallId,
    toolName: typeof data['toolName'] === 'string' ? (data['toolName'] as string) : 'unknown',
    status: 'running',
    argKeys: [],
    lastSequence: sequence,
  };
  entry.toolCallsById.set(toolCallId, call);
  view.toolCallList.push(call);
  return call;
}

function cloneRunView(view: AgUiRendererRunView): AgUiRendererRunView {
  return JSON.parse(JSON.stringify(view)) as AgUiRendererRunView;
}
