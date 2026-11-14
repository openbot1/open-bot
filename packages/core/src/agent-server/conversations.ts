/**
 * Agent server v2 — conversation manager (v1.04, Đội T4).
 *
 * Conversation = một run trong event log. Manager là tầng mỏng trên
 * `RunLogStore` + `RunControlRegistry` + các hàm đã có:
 * - tạo: append `run.started` + `run.prompt` (runId = conversation id).
 * - đọc: `meta`/`foldEvents` suy trạng thái, không lưu state riêng.
 * - pause/resume: `pauseRun`/`resumeRun` (gate + event).
 * - cancel: abort gate (nếu có) + append `run.aborted`.
 * - fork: `forkRunAt` (sao chép prefix sang run con).
 * - snapshot/condense: `createRunSnapshot` / `compactRunV2`.
 *
 * Manager không gọi provider, không chạy agent loop — nó chỉ quản lý
 * log + cổng điều khiển. Loop thật (khi gắn vào) đọc/ghi cùng log này.
 */

import { randomUUID } from 'node:crypto';

import { compactRunV2, type CompactRunV2Result, type CondenseV2Options } from '../event-log/condenser-v2';
import {
  pauseRun,
  resumeRun,
  RunControlRegistry,
  type ForkRunResult,
  type PauseResumeResult,
} from '../event-log/control';
import { foldEvents } from '../event-log/replay';
import { createRunSnapshot, type CreateRunSnapshotResult } from '../event-log/snapshot';
import { RunLogStore } from '../event-log/store';
import { forkRunAt } from '../event-log/timeTravel';
import type { AnyRunEvent, RunEventQuery } from '../event-log/types';
import {
  conversationNotFound,
  type AgentServerConversation,
  type CondenseConversationInput,
  type ConversationControlInput,
  type CreateConversationInput,
  type ForkConversationInput,
  type SendMessageInput,
} from './types';

/** Tùy chọn của `ConversationManager`. */
export interface ConversationManagerOptions {
  /** Store đã có (caller sở hữu) — manager không tự tạo store mới. */
  store: RunLogStore;
  /** Registry gate đã có (chia sẻ với loop để pause thật sự chặn step). */
  registry?: RunControlRegistry;
  /** Bot mặc định khi tạo conversation không ghi botId. */
  defaultBotId?: string;
}

/** Conversation manager — mọi thao tác conversation qua event log. */
export class ConversationManager {
  readonly store: RunLogStore;
  readonly registry: RunControlRegistry;
  private readonly defaultBotId: string;

  constructor(options: ConversationManagerOptions) {
    this.store = options.store;
    this.registry = options.registry ?? new RunControlRegistry();
    this.defaultBotId = options.defaultBotId ?? 'default-bot';
  }

  /** Tạo conversation mới (runId ngẫu nhiên), ghi started + prompt. */
  create(input: CreateConversationInput): AgentServerConversation {
    const prompt = input.prompt.trim();
    if (prompt === '') throw new Error('Tạo conversation: prompt rỗng.');
    const runId = randomUUID();
    const botId = input.botId?.trim() !== '' ? (input.botId as string) : this.defaultBotId;
    const title = input.title?.trim() !== '' ? input.title : prompt.slice(0, 120);
    this.store.append(runId, {
      type: 'run.started',
      payload: {
        botId,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        title,
      },
    });
    this.store.append(runId, {
      type: 'run.prompt',
      payload: { text: prompt },
    });
    return this.get(runId);
  }

  /** Đọc một conversation (fold log). Ném 404 khi không tồn tại. */
  get(runId: string): AgentServerConversation {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const meta = this.store.meta(runId);
    const { events } = this.store.readRun(runId);
    const state = foldEvents(runId, events);
    const started = events.find((e) => e.type === 'run.started');
    const startedPayload = (started?.payload ?? {}) as {
      parentRunId?: string;
      forkFromSeq?: number;
      botId?: string;
    };
    return {
      id: runId,
      botId: startedPayload.botId ?? meta?.botId ?? this.defaultBotId,
      ...(state.prompt !== '' ? { title: state.prompt.slice(0, 120) } : {}),
      status: state.status,
      prompt: state.prompt,
      createdAt: meta?.startedAt ?? state.startedAt,
      ...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
      eventCount: events.length,
      lastSeq: events.length === 0 ? 0 : events[events.length - 1]!.seq,
      steps: state.steps,
      toolCalls: state.toolCalls.length,
      tokensUsed: state.tokensUsed,
      ...(startedPayload.parentRunId !== undefined
        ? { parentRunId: startedPayload.parentRunId }
        : {}),
      ...(startedPayload.forkFromSeq !== undefined
        ? { forkFromSeq: startedPayload.forkFromSeq }
        : {}),
    };
  }

  /** Liệt kê mọi conversation, mới nhất trước. */
  list(): AgentServerConversation[] {
    const metas = this.store.listRuns();
    metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return metas.map((m) => this.get(m.runId));
  }

  /** Gửi message vào conversation (append `run.prompt`). */
  sendMessage(runId: string, input: SendMessageInput): { seq: number } {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const text = input.text.trim();
    if (text === '') throw new Error('Gửi message: text rỗng.');
    const event = this.store.append(runId, {
      type: 'run.prompt',
      payload: { text },
    });
    return { seq: event.seq };
  }

  /** Tạm dừng conversation (đóng gate + ghi `run.paused`). */
  pause(runId: string, input: ConversationControlInput = {}): PauseResumeResult {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const state = foldEvents(runId, this.store.readRun(runId).events);
    return pauseRun(this.store, this.registry, runId, {
      step: state.steps,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /** Tiếp tục conversation đã pause (mở gate + ghi `run.resumed`). */
  resume(runId: string, input: ConversationControlInput = {}): PauseResumeResult {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const state = foldEvents(runId, this.store.readRun(runId).events);
    return resumeRun(this.store, this.registry, runId, {
      step: state.steps,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  /**
   * Huỷ conversation: abort gate (loop đang pause sẽ ném lỗi huỷ) +
   * append `run.aborted`. Run đã kết thúc vẫn ghi được event (audit).
   */
  cancel(runId: string, input: ConversationControlInput = {}): { seq: number; changed: boolean } {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const gate = this.registry.get(runId);
    const wasRunning = gate !== undefined && !gate.isAborted;
    gate?.abort();
    const state = foldEvents(runId, this.store.readRun(runId).events);
    const event = this.store.append(runId, {
      type: 'run.aborted',
      payload: {
        ...(input.message !== undefined ? { message: input.message } : {}),
        steps: state.steps,
        toolCalls: state.toolCalls.length,
        durationMs: 0,
      },
    });
    return { seq: event.seq, changed: wasRunning };
  }

  /** Fork conversation tại một seq → conversation con (kèm trạng thái tại điểm fork). */
  fork(
    runId: string,
    input: ForkConversationInput = {},
  ): ForkRunResult & { child: AgentServerConversation } {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const result = forkRunAt(this.store, runId, input.atSeq ?? this.lastSeq(runId));
    return { ...result, child: this.get(result.childRunId) };
  }

  /** Đọc event của conversation (query + phân trang của store). */
  events(
    runId: string,
    query: RunEventQuery = {},
  ): { events: AnyRunEvent[]; total: number; corruptLines: number } {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    return this.store.queryRun(runId, query);
  }

  /** Chụp snapshot trạng thái đã fold của conversation. */
  snapshot(runId: string, upToSeq?: number): CreateRunSnapshotResult {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    return createRunSnapshot(this.store, runId, upToSeq !== undefined ? { upToSeq } : {});
  }

  /** Nén conversation bằng condenser v2 (ghi marker `run.compacted`). */
  condense(runId: string, input: CondenseConversationInput = {}): CompactRunV2Result {
    if (!this.store.exists(runId)) throw conversationNotFound(runId);
    const options: CondenseV2Options = {};
    if (input.strategy !== undefined) options.strategy = input.strategy;
    if (input.upToSeq !== undefined) options.upToSeq = input.upToSeq;
    return compactRunV2(this.store, runId, options);
  }

  private lastSeq(runId: string): number {
    const { events } = this.store.readRun(runId);
    return events.length === 0 ? 0 : events[events.length - 1]!.seq;
  }
}
