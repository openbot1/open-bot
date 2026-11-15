/**
 * V3Conversation — vòng lặp Agent/Conversation/EventLog gọn (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands V1 SDK — chỉ học ý
 * tưởng, không copy code/text/tài sản của repo nào):
 *
 *   Agent stateless phát Action → Conversation chạy vòng lặp →
 *   Workspace thực thi Action trả Observation → mọi thứ ghi vào
 *   append-only EventLog.
 *
 * KHÔNG CÓ CONTROLLER TRUNG GIAN (xem types.ts): Conversation này
 * chính là vòng lặp. Nó không spawn process, không gọi LLM trực
 * tiếp, không giữ credential — agent (LLM) và workspace (tool) đều
 * do host tiêm vào qua interface `V3Agent` / `V3Workspace`.
 *
 * Luồng một turn (`runTurn`):
 *   1. Ghi `turn.started` + `user.message`.
 *   2. Lặp tối đa `maxSteps` step:
 *      - Kiểm tra budget trước mỗi step: đã exceeded → dừng, ghi
 *        `turn.completed` (budget_exceeded) + `budget.warning`.
 *      - Hỏi agent (`decide`) → ghi `agent.action`.
 *      - kind 'message' → ghi `agent.message`, tiếp tục.
 *      - kind 'tool_call' → workspace.execute → ghi
 *        `workspace.observation`, tiếp tục.
 *      - kind 'delegate' → TaskToolSet.delegate (khi host truyền
 *        `delegateRunner`; không có runner thì observation lỗi, vòng
 *        lặp tự quyết) → ghi `delegation.started/completed`.
 *      - kind 'finish' → chạy critic (khi host truyền `criticChecks`)
 *        → ghi `critic.report` → ghi `turn.completed`
 *        (agent_finished) + trả kết quả.
 *   3. Hết `maxSteps` mà agent chưa finish → `turn.completed`
 *      (max_steps). Agent throw / workspace throw → `turn.failed`.
 *
 * Critic render inline: sau khi critic xong, `runTurn` trả về
 * `criticInline` (markdown từ `renderCriticInline`) để host chèn
 * thẳng vào message chat — user thấy kết quả kiểm chứng ngay trong
 * luồng chat, không cần mở panel khác.
 *
 * EventLog: append-only trong bộ nhớ, seq tăng đều từ 1. `snapshot()`
 * / `restore()` để host persist JSON; `replay()` fold lại state từ
 * event (không cần chạy lại agent). Forward sang LocalHarness: host
 * có thể truyền `onEvent` — conversation gọi nó cho MỌI event (vd
 * `harness.publishLoopEvent`) để NDJSON log + bus hiện có vẫn thấy
 * turn V3.
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_CRITIC_CHECKS, renderCriticInline, runCritic } from './critic';
import type { CriticCheck, CriticReport } from './critic';
import type { V3BudgetMeter, V3BudgetSnapshot } from './budget';
import { formatBudgetMeterLine } from './budget';
import type { DelegationRecord, SubagentRunner } from './delegation';
import { TaskToolSet } from './delegation';
import type {
  V3Action,
  V3Agent,
  V3AgentState,
  V3ConversationEvent,
  V3ConversationSnapshot,
  V3ConversationState,
  V3EventPayload,
  V3EventType,
  V3Observation,
  V3TurnFinishReason,
  V3TurnResult,
  V3Workspace,
} from './types';

/** Số step tối đa mặc định cho một turn. */
export const DEFAULT_V3_MAX_STEPS = 25;
/** Ký tự tối đa ghi vào event log cho một text (chống log phình). */
export const V3_EVENT_TEXT_LIMIT = 2_000;
/** Ký tự tối đa của observation output ghi vào event log. */
export const V3_EVENT_OBSERVATION_LIMIT = 2_000;

export interface V3ConversationOptions {
  /** Số step tối đa một turn. Mặc định 25. */
  maxSteps?: number;
  /** Meter ngân sách (token/cost/thời gian) — không truyền = không giới hạn. */
  budget?: V3BudgetMeter;
  /** Runner sub-agent cho action 'delegate' — không truyền = delegate báo lỗi. */
  delegateRunner?: SubagentRunner;
  /** Bộ check critic chạy khi agent finish — không truyền = dùng DEFAULT_CRITIC_CHECKS. */
  criticChecks?: CriticCheck[] | null;
  /** false = tắt critic hẳn (turn finish không chấm). Mặc định bật. */
  criticEnabled?: boolean;
  /** TaskToolSet dùng chung (mặc định tạo mới cho conversation này). */
  taskToolSet?: TaskToolSet;
  /** Callback cho MỌI event (vd forward sang LocalHarness.publishLoopEvent). */
  onEvent?: (event: V3ConversationEvent) => void;
  /** Đồng hồ (mặc định Date.now) — test truyền đồng hồ giả. */
  now?: () => number;
  /** Hàm sinh id conversation (mặc định `v3-<uuid>`). */
  idFactory?: () => string;
}

/** Kết quả turn mở rộng: thêm markdown critic + dòng meter để chat hiển thị. */
export interface V3TurnResultWithInline extends V3TurnResult {
  /** Markdown critic để chèn vào chat (undefined khi không chạy critic). */
  criticInline?: string;
  /** Dòng meter ngân sách để chèn vào chat (undefined khi không có meter). */
  budgetLine?: string;
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function sanitizeAction(action: V3Action): V3Action {
  return {
    kind: action.kind,
    ...(action.text !== undefined ? { text: truncateText(action.text, V3_EVENT_TEXT_LIMIT) } : {}),
    ...(action.tool !== undefined ? { tool: action.tool } : {}),
    ...(action.args !== undefined
      ? { args: Object.fromEntries(Object.keys(action.args).map((k) => [k, '[arg]'])) }
      : {}),
    ...(action.task !== undefined ? { task: truncateText(action.task, V3_EVENT_TEXT_LIMIT) } : {}),
    ...(action.role !== undefined ? { role: action.role } : {}),
    ...(action.reason !== undefined ? { reason: truncateText(action.reason, 500) } : {}),
  };
}

function sanitizeObservation(observation: V3Observation): V3Observation {
  return {
    status: observation.status,
    output: truncateText(observation.output, V3_EVENT_OBSERVATION_LIMIT),
    durationMs: observation.durationMs,
    ...(observation.changedFiles !== undefined
      ? { changedFiles: observation.changedFiles }
      : {}),
    ...(observation.tool !== undefined ? { tool: observation.tool } : {}),
  };
}

/**
 * V3Conversation — một conversation = một EventLog append-only +
 * vòng lặp turn. Một instance dùng cho một conversation (một bot /
 * một thread chat); tạo mới cho conversation mới.
 */
export class V3Conversation {
  readonly id: string;
  private readonly maxSteps: number;
  private readonly budget?: V3BudgetMeter;
  private readonly delegateRunner?: SubagentRunner;
  private readonly criticChecks: CriticCheck[] | null;
  private readonly taskToolSet: TaskToolSet;
  private readonly onEvent?: (event: V3ConversationEvent) => void;
  private readonly now: () => number;
  private readonly events: V3ConversationEvent[] = [];
  private status: V3ConversationState['status'] = 'idle';
  private steps = 0;
  private finalText?: string;
  private finishReason?: V3TurnFinishReason;
  private lastObservation?: V3Observation;
  private stopped = false;

  constructor(id?: string, options: V3ConversationOptions = {}) {
    const factory = options.idFactory ?? (() => `v3-${randomUUID()}`);
    this.id = id ?? factory();
    const maxSteps = options.maxSteps ?? DEFAULT_V3_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      throw new Error(`V3Conversation cần maxSteps nguyên > 0 (nhận ${String(maxSteps)}).`);
    }
    this.maxSteps = maxSteps;
    this.budget = options.budget;
    this.delegateRunner = options.delegateRunner;
    this.criticChecks =
      options.criticEnabled === false ? null : (options.criticChecks ?? [...DEFAULT_CRITIC_CHECKS]);
    this.taskToolSet = options.taskToolSet ?? new TaskToolSet();
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
  }

  /** Mọi event đã ghi (bản copy, cũ nhất trước). */
  listEvents(): V3ConversationEvent[] {
    return [...this.events];
  }

  /** State hiện tại (fold từ EventLog). */
  state(): V3ConversationState {
    return {
      conversationId: this.id,
      status: this.status,
      eventCount: this.events.length,
      lastSeq: this.events.length === 0 ? 0 : this.events[this.events.length - 1]!.seq,
      steps: this.steps,
      ...(this.finalText !== undefined ? { finalText: this.finalText } : {}),
      ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
    };
  }

  /** TaskToolSet của conversation (xem record delegate đã chạy). */
  get delegations(): TaskToolSet {
    return this.taskToolSet;
  }

  /** Budget snapshot hiện tại (undefined khi không có meter). */
  budgetSnapshot(): V3BudgetSnapshot | undefined {
    return this.budget?.snapshot();
  }

  /** Dừng turn đang chạy sau step hiện tại (cooperative stop). */
  stop(): void {
    this.stopped = true;
  }

  /** Snapshot JSON toàn bộ conversation (để persist). */
  snapshot(): V3ConversationSnapshot {
    return {
      version: 1,
      conversationId: this.id,
      createdAt: new Date(this.now()).toISOString(),
      events: this.listEvents(),
    };
  }

  /**
   * Khôi phục conversation từ snapshot (chỉ nhận snapshot version 1,
   * đúng conversationId). Event cũ được giữ nguyên thứ tự/seq.
   */
  static restore(snapshot: V3ConversationSnapshot, options: V3ConversationOptions = {}): V3Conversation {
    if (snapshot.version !== 1) {
      throw new Error(`V3ConversationSnapshot version không hỗ trợ: ${String(snapshot.version)}.`);
    }
    const conv = new V3Conversation(snapshot.conversationId, options);
    for (const event of snapshot.events) {
      conv.events.push({ ...event, payload: { ...event.payload } as V3EventPayload });
    }
    conv.steps = snapshot.events.filter((e) => e.type === 'agent.action').length;
    const last = snapshot.events[snapshot.events.length - 1];
    if (last?.type === 'turn.completed') {
      conv.status = 'completed';
      conv.finishReason = last.payload.kind === 'turn.completed' ? last.payload.finishReason : undefined;
      conv.finalText =
        last.payload.kind === 'turn.completed' ? last.payload.finalText : undefined;
    } else if (last?.type === 'turn.failed') {
      conv.status = 'failed';
    } else if (last?.type === 'turn.stopped') {
      conv.status = 'stopped';
    }
    return conv;
  }

  /**
   * Chạy một turn: user gửi prompt, agent + workspace lặp tới khi
   * finish / hết step / hết budget / lỗi. Không throw vì agent hay
   * workspace lỗi — lỗi được ghi `turn.failed` và trả về trong
   * result. Chỉ throw khi `userPrompt` rỗng hoặc conversation đang
   * chạy một turn khác (một conversation chạy tối đa một turn tại
   * một thời điểm).
   */
  async runTurn(
    userPrompt: string,
    agent: V3Agent,
    workspace: V3Workspace,
  ): Promise<V3TurnResultWithInline> {
    if (typeof userPrompt !== 'string' || userPrompt.trim() === '') {
      throw new Error('V3Conversation.runTurn cần userPrompt không rỗng.');
    }
    if (this.status === 'running') {
      throw new Error('Conversation đang chạy một turn khác — chờ turn đó xong rồi chạy tiếp.');
    }
    const eventsBefore = this.events.length;
    this.status = 'running';
    this.stopped = false;
    this.steps = 0;
    this.finalText = undefined;
    this.finishReason = undefined;
    this.lastObservation = undefined;
    this.budget?.start();
    const history: Array<{ action: V3Action; observation: V3Observation }> = [];
    let lastMessage: string | undefined;
    let critic: CriticReport | undefined;
    let error: string | undefined;

    this.append('turn.started', {
      kind: 'turn.started',
      userPrompt: truncateText(userPrompt, V3_EVENT_TEXT_LIMIT),
      maxSteps: this.maxSteps,
    });
    this.append('user.message', { kind: 'user.message', text: truncateText(userPrompt, V3_EVENT_TEXT_LIMIT) });

    let finishReason: V3TurnFinishReason = 'max_steps';
    let failReason: V3TurnFinishReason = 'workspace_failed';
    try {
      for (let step = 0; step < this.maxSteps; step += 1) {
        if (this.stopped) {
          finishReason = 'stopped';
          break;
        }
        // Budget check trước mỗi step: hết ngân sách thì dừng ngay,
        // không hỏi agent thêm lần nào nữa.
        const budgetSnapshot = this.budget?.snapshot();
        if (budgetSnapshot !== undefined && budgetSnapshot.status === 'exceeded') {
          this.append('budget.warning', {
            kind: 'budget.warning',
            step,
            snapshot: budgetSnapshot,
            message: formatBudgetMeterLine(budgetSnapshot),
          });
          finishReason = 'budget_exceeded';
          break;
        }
        const state: V3AgentState = {
          conversationId: this.id,
          userPrompt,
          step,
          maxSteps: this.maxSteps,
          history: history.map((h) => ({ ...h })),
          ...(lastMessage !== undefined ? { lastMessage } : {}),
          ...(budgetSnapshot !== undefined ? { budget: budgetSnapshot } : {}),
        };
        let action: V3Action;
        try {
          action = await agent.decide(state);
        } catch (err) {
          error = `Agent lỗi ở step ${step}: ${(err as Error).message}`;
          failReason = 'agent_failed';
          break;
        }
        if (!action || typeof action.kind !== 'string') {
          error = `Agent trả Action không hợp lệ ở step ${step} (thiếu kind).`;
          failReason = 'agent_failed';
          break;
        }
        this.steps = step + 1;
        this.append('agent.action', { kind: 'agent.action', step, action: sanitizeAction(action) });

        if (action.kind === 'message') {
          lastMessage = action.text ?? '';
          this.append('agent.message', { kind: 'agent.message', step, text: lastMessage });
          continue;
        }
        if (action.kind === 'finish') {
          this.finalText = action.text ?? '';
          finishReason = 'agent_finished';
          break;
        }
        if (action.kind === 'delegate') {
          const record = await this.runDelegation(step, action);
          this.append('delegation.completed', {
            kind: 'delegation.completed',
            step,
            delegationId: record.delegationId,
            record,
          });
          const observation: V3Observation = {
            status: record.status === 'done' ? 'ok' : 'error',
            output: record.result,
            durationMs: record.durationMs,
            changedFiles: record.changedFiles,
          };
          this.lastObservation = observation;
          history.push({ action, observation });
          continue;
        }
        // kind 'tool_call' (mọi kind lạ khác cũng đi đường workspace
        // để workspace tự báo lỗi thay vì vòng lặp crash).
        let observation: V3Observation;
        try {
          observation = await workspace.execute(action);
        } catch (err) {
          error = `Workspace lỗi ở step ${step}: ${(err as Error).message}`;
          failReason = 'workspace_failed';
          break;
        }
        this.lastObservation = sanitizeObservation(observation);
        this.append('workspace.observation', {
          kind: 'workspace.observation',
          step,
          observation: this.lastObservation,
        });
        history.push({ action, observation: this.lastObservation });
        if (observation.status === 'denied') {
          // Tool bị chặn (policy/approval): không retry mù — dừng
          // turn, để user quyết rồi chạy turn mới.
          finishReason = 'stopped';
          this.append('turn.stopped', {
            kind: 'turn.stopped',
            steps: this.steps,
            reason: `Tool "${action.tool ?? action.kind}" bị từ chối (denied) ở step ${step}.`,
          });
          this.status = 'stopped';
          this.finishReason = 'stopped';
          return this.finishTurn(eventsBefore, 'stopped', undefined, undefined);
        }
      }
    } catch (err) {
      error = (err as Error).message;
    }

    if (error !== undefined) {
      this.append('turn.failed', { kind: 'turn.failed', steps: this.steps, error });
      this.status = 'failed';
      this.finishReason = undefined;
      return this.finishTurn(eventsBefore, failReason, undefined, undefined);
    }

    // Agent finish → chạy critic (khi bật) rồi mới đóng turn.
    if (finishReason === 'agent_finished' && this.criticChecks !== null) {
      critic = await runCritic(this.criticChecks, {
        ...(this.finalText !== undefined ? { finalText: this.finalText } : {}),
        ...(this.lastObservation !== undefined ? { lastObservation: this.lastObservation } : {}),
        changedFiles: history.flatMap((h) => h.observation.changedFiles ?? []),
        steps: this.steps,
        maxSteps: this.maxSteps,
      });
      this.append('critic.report', { kind: 'critic.report', step: this.steps, report: critic });
    }
    this.append('turn.completed', {
      kind: 'turn.completed',
      steps: this.steps,
      finishReason,
      ...(this.finalText !== undefined ? { finalText: truncateText(this.finalText, V3_EVENT_TEXT_LIMIT) } : {}),
    });
    this.status = 'completed';
    this.finishReason = finishReason;
    return this.finishTurn(eventsBefore, finishReason, this.finalText, critic);
  }

  private async runDelegation(step: number, action: V3Action): Promise<DelegationRecord> {
    const task = action.task ?? '';
    const delegationId = `dlg-${this.id.slice(0, 8)}-${step}-${Date.now().toString(36)}`;
    this.append('delegation.started', {
      kind: 'delegation.started',
      step,
      delegationId,
      task: truncateText(task, V3_EVENT_TEXT_LIMIT),
      ...(action.role !== undefined ? { role: action.role } : {}),
    });
    if (this.delegateRunner === undefined || task.trim() === '') {
      const record: DelegationRecord = {
        delegationId,
        task,
        ...(action.role !== undefined ? { role: action.role } : {}),
        status: 'error',
        result:
          this.delegateRunner === undefined
            ? 'Không có sub-agent runner — host chưa cấu hình delegate cho conversation này.'
            : 'Task delegate rỗng — agent cần ghi rõ task cho sub-agent.',
        truncated: false,
        rawChars: 0,
        rawLines: 0,
        resultTokens: 0,
        changedFiles: [],
        durationMs: 0,
        error: this.delegateRunner === undefined ? 'no-delegate-runner' : 'empty-task',
      };
      return record;
    }
    return this.taskToolSet.delegate(task, this.delegateRunner, {
      ...(action.role !== undefined ? { role: action.role } : {}),
    });
  }

  private finishTurn(
    eventsBefore: number,
    finishReason: V3TurnFinishReason,
    finalText: string | undefined,
    critic: CriticReport | undefined,
  ): V3TurnResultWithInline {
    const budget = this.budget?.snapshot();
    const result: V3TurnResultWithInline = {
      conversationId: this.id,
      finishReason,
      steps: this.steps,
      ...(finalText !== undefined ? { finalText } : {}),
      eventsAppended: this.events.length - eventsBefore,
      ...(critic !== undefined ? { critic } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(critic !== undefined ? { criticInline: renderCriticInline(critic) } : {}),
      ...(budget !== undefined ? { budgetLine: formatBudgetMeterLine(budget) } : {}),
    };
    return result;
  }

  private append(type: V3EventType, payload: V3EventPayload): V3ConversationEvent {
    const event: V3ConversationEvent = {
      seq: this.events.length + 1,
      at: new Date(this.now()).toISOString(),
      type,
      payload,
    };
    this.events.push(event);
    try {
      this.onEvent?.(event);
    } catch {
      // Callback forward lỗi thì bỏ qua — không làm hỏng vòng lặp.
    }
    return event;
  }
}
