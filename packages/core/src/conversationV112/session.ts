/**
 * Conversation session v112 (Đội T2) — API cao cấp cho host/agent loop.
 *
 * `ConversationV112Session` gắn với MỘT conversation: giữ
 * `ConversationLogStore` + state đã fold (cache trong bộ nhớ, cập
 * nhật sau mỗi lần append bằng fold event vừa ghi — không đọc lại
 * toàn bộ log). Mọi phương thức ghi log đều:
 * - sanitize text (redact secret + cắt ngắn) TRƯỚC khi append,
 * - trả về event đã lưu (kèm seq/hash) để caller dùng tiếp,
 * - throw `ConversationStoreError` khi ghi thất bại (durability là
 *   hợp đồng — khác với RunLogRecorder best-effort, vì session này
 *   là owner của log; host muốn best-effort thì tự try/catch).
 *
 * Session KHÔNG gọi model, KHÔNG gọi mạng. CodeAct-lite cần host
 * bind `CodeActExecutor` (BotBoxManager) qua options; chưa bind mà
 * gọi `runCodeActText` thì ném lỗi rõ ràng.
 *
 * Vòng đời:
 *   const session = ConversationV112Session.open(store, { botId, conversationId? });
 *   session.recordUserMessage('…'); session.recordAgentMessage('…');
 *   await session.runCodeActText(agentText); // parse + chạy + ghi event
 *   session.loadSkill('code-review');        // nạp skill workspace
 *   const branch = session.branch(12, 'thử hướng khác');
 *   session.snapshot(); session.compact(10);
 *   session.end('user-closed');
 */

import { randomUUID } from 'node:crypto';
import { CodeActExecutor } from '../codeact/index';
import { branchConversation } from './branches';
import { runCodeActLiteText, codeActLiteActionCode, type CodeActLiteRun } from './codeactLite';
import { compactConversation, createConversationSnapshot, replayFromSnapshot, type CompactConversationResult, type CreateSnapshotResult } from './snapshots';
import { foldConversationEvent } from './replay';
import { sanitizeTextForLogV112 } from './redact';
import { loadWorkspaceSkill } from './skillsOnDemand';
import { ConversationLogStore, ConversationStoreError } from './store';
import { exportConversationToFile, type ExportConversationResult } from './exportImport';
import type {
  AnyConversationEvent,
  ConversationEventPayload,
  ConversationState,
} from './types';
import { CONVERSATION_V112_DEFAULTS, emptyConversationState } from './types';

export interface ConversationV112SessionOptions {
  /** Bot sở hữu conversation. */
  botId: string;
  /** Id conversation (mặc định sinh `conv-<uuid>`). */
  conversationId?: string;
  /** Thư mục workspace của bot (để tìm `.openbot/skills/`). */
  workspaceDir?: string;
  /** Executor CodeAct v2 (BotBoxManager) — cần cho runCodeActText. */
  codeActExecutor?: CodeActExecutor;
  /** Cho phép `curl|sh` trong CodeAct-lite (mặc định false). */
  allowPipeToShell?: boolean;
  /** Giới hạn text lưu mỗi message/observation. */
  maxMessageChars?: number;
  maxOutputChars?: number;
  maxCodePreviewChars?: number;
}

export class ConversationV112Session {
  readonly conversationId: string;
  readonly branchId = 'main';
  readonly botId: string;
  readonly store: ConversationLogStore;
  private readonly workspaceDir?: string;
  private readonly codeActExecutor?: CodeActExecutor;
  private readonly allowPipeToShell: boolean;
  private readonly maxMessageChars: number;
  private readonly maxOutputChars: number;
  private readonly maxCodePreviewChars: number;
  private state: ConversationState;

  private constructor(
    store: ConversationLogStore,
    options: ConversationV112SessionOptions,
    initialState: ConversationState,
  ) {
    this.store = store;
    this.botId = options.botId;
    this.conversationId = options.conversationId ?? `conv-${randomUUID()}`;
    this.workspaceDir = options.workspaceDir;
    this.codeActExecutor = options.codeActExecutor;
    this.allowPipeToShell = options.allowPipeToShell ?? false;
    this.maxMessageChars = options.maxMessageChars ?? CONVERSATION_V112_DEFAULTS.maxMessageChars;
    this.maxOutputChars = options.maxOutputChars ?? CONVERSATION_V112_DEFAULTS.maxOutputChars;
    this.maxCodePreviewChars = options.maxCodePreviewChars ?? CONVERSATION_V112_DEFAULTS.maxCodePreviewChars;
    this.state = initialState;
  }

  /**
   * Mở session cho conversation MỚI (ghi `conversation.started`) hoặc
   * mở lại conversation đã có (replay từ snapshot + log, không ghi
   * event mới). `conversationId` không truyền → tạo mới.
   */
  static open(
    store: ConversationLogStore,
    options: ConversationV112SessionOptions & { title?: string; model?: string; providerId?: string },
  ): ConversationV112Session {
    if (!options.botId) {
      throw new ConversationStoreError('ConversationV112Session cần botId.');
    }
    if (options.conversationId && store.exists(options.conversationId)) {
      const { state } = replayFromSnapshot(store, options.conversationId);
      const session = new ConversationV112Session(store, options, state);
      return session;
    }
    const conversationId = options.conversationId ?? `conv-${randomUUID()}`;
    const initial = emptyConversationState(conversationId, 'main');
    const session = new ConversationV112Session(store, { ...options, conversationId }, initial);
    const started = store.append(conversationId, 'main', 'conversation.started', {
      botId: options.botId,
      title: options.title,
      model: options.model,
      providerId: options.providerId,
    });
    foldConversationEvent(session.state, started as AnyConversationEvent);
    return session;
  }

  /** State hiện tại (bản sao nông — caller không được mutate trực tiếp). */
  getState(): ConversationState {
    return JSON.parse(JSON.stringify(this.state)) as ConversationState;
  }

  /** Ghi một event vào store + fold vào state cache. */
  private record<T extends AnyConversationEvent['type']>(
    type: T,
    payload: ConversationEventPayload,
  ): AnyConversationEvent {
    const event = this.store.append(this.conversationId, this.branchId, type, payload as never);
    foldConversationEvent(this.state, event);
    return event;
  }

  /** Ghi tin nhắn user (đã redact + cắt ngắn). */
  recordUserMessage(text: string, opts?: { hasAttachments?: boolean }): AnyConversationEvent {
    const clean = sanitizeTextForLogV112(text, this.maxMessageChars);
    return this.record('user.message', {
      text: clean.text,
      originalChars: clean.originalChars,
      hasAttachments: opts?.hasAttachments,
    });
  }

  /** Ghi tin nhắn agent (kèm tool call model yêu cầu, nếu có). */
  recordAgentMessage(
    text: string,
    toolCalls?: Array<{ callId: string; tool: string; argKeys: string[] }>,
  ): AnyConversationEvent {
    const clean = sanitizeTextForLogV112(text, this.maxMessageChars);
    return this.record('agent.message', {
      text: clean.text,
      originalChars: clean.originalChars,
      toolCalls,
    });
  }

  /** Ghi một tool call (action) — chỉ tên key args, không ghi value. */
  recordToolCall(
    callId: string,
    tool: string,
    argKeys: string[],
    opts?: { step?: number; skillName?: string },
  ): AnyConversationEvent {
    return this.record('action.tool', {
      callId,
      tool,
      argKeys: [...argKeys],
      step: opts?.step,
      skillName: opts?.skillName,
    });
  }

  /** Ghi kết quả một tool call (output đã redact + cắt ngắn). */
  recordToolResult(
    callId: string,
    tool: string,
    status: 'ok' | 'error' | 'denied',
    outputPreview: string,
    durationMs: number,
  ): AnyConversationEvent {
    const clean = sanitizeTextForLogV112(outputPreview, this.maxOutputChars);
    return this.record('observation.tool', {
      callId,
      tool,
      status,
      outputPreview: clean.text,
      durationMs,
      truncated: clean.truncated,
    });
  }

  /**
   * Chạy CodeAct-lite trên text agent: trích code block → chạy trong
   * box → ghi cặp event `action.codeact` / `observation.codeact` cho
   * mỗi block (kể cả block bị chặn). Trả về danh sách run.
   */
  async runCodeActText(text: string): Promise<CodeActLiteRun[]> {
    if (!this.codeActExecutor) {
      throw new ConversationStoreError(
        'CodeAct-lite chưa bind executor: khởi tạo session với codeActExecutor (BotBoxManager) trước.',
      );
    }
    const runs = await runCodeActLiteText(text, {
      executor: this.codeActExecutor,
      allowPipeToShell: this.allowPipeToShell,
    });
    for (const run of runs) {
      const code = codeActLiteActionCode(run.action);
      // Lite chỉ tạo bash/python — 'edit' không bao giờ xuất hiện ở đây;
      // guard này chỉ để typechecker hẹp union CodeActActionKind.
      const kind = run.action.kind === 'bash' || run.action.kind === 'python' ? run.action.kind : 'bash';
      const codeClean = sanitizeTextForLogV112(code, this.maxCodePreviewChars);
      this.record('action.codeact', {
        executionId: run.executionId,
        kind,
        codePreview: codeClean.text,
        codeChars: code.length,
        actionIndex: run.actionIndex,
        blockedReason: run.blockedReason,
      });
      const stdoutClean = sanitizeTextForLogV112(run.observation.stdout, this.maxOutputChars);
      const stderrClean = sanitizeTextForLogV112(run.observation.stderr, this.maxOutputChars);
      this.record('observation.codeact', {
        executionId: run.executionId,
        kind,
        exitCode: run.observation.exitCode,
        stdoutPreview: stdoutClean.text,
        stderrPreview: stderrClean.text,
        timedOut: run.observation.timedOut,
        truncated: run.observation.truncated || stdoutClean.truncated || stderrClean.truncated,
        durationMs: run.observation.durationMs,
        blocked: run.blocked || undefined,
        blockedReason: run.blockedReason,
      });
    }
    return runs;
  }

  /**
   * Nạp skill workspace theo tên (đọc body + ghi `skill.loaded`).
   * Trả về text đã render để host inject vào system prompt.
   */
  loadSkill(name: string, source: 'user' | 'model' | 'trigger' = 'user'): string {
    if (!this.workspaceDir) {
      throw new ConversationStoreError(
        'Session chưa cấu hình workspaceDir nên không tìm được .openbot/skills/.',
      );
    }
    const { skill, rendered } = loadWorkspaceSkill(this.workspaceDir, name);
    this.record('skill.loaded', {
      name: skill.name,
      version: skill.version,
      source,
      injectedChars: rendered.length,
    });
    return rendered;
  }

  /** Ghi gợi ý skill (không nạp body) — dùng khi suggest khớp trigger. */
  recordSkillSuggestion(name: string, version: string | undefined, score: number): AnyConversationEvent {
    return this.record('skill.suggested', {
      name,
      version,
      source: 'trigger',
      score,
    });
  }

  /**
   * Fork conversation tại `fromSeq` — trả về session MỚI cho branch
   * con (session hiện tại vẫn trỏ conversation cha).
   */
  branch(fromSeq: number, reason?: string): ConversationV112Session {
    const result = branchConversation(this.store, this.conversationId, fromSeq, { reason });
    return ConversationV112Session.open(this.store, {
      botId: this.botId,
      conversationId: result.childConversationId,
      workspaceDir: this.workspaceDir,
      codeActExecutor: this.codeActExecutor,
      allowPipeToShell: this.allowPipeToShell,
    });
  }

  /** Tạo snapshot tại seq cuối (hoặc throughSeq cho trước). */
  snapshot(throughSeq?: number): CreateSnapshotResult {
    return createConversationSnapshot(this.store, this.conversationId, throughSeq);
  }

  /** Compact log tới throughSeq (mặc định = seq cuối - 1). */
  compact(throughSeq?: number): CompactConversationResult {
    const result = compactConversation(this.store, this.conversationId, throughSeq);
    // State cache phải replay lại từ snapshot + log mới (seq đã đổi).
    const { state } = replayFromSnapshot(this.store, this.conversationId);
    this.state = state;
    return result;
  }

  /** Export conversation ra file JSONL. */
  exportToFile(outDir: string): ExportConversationResult {
    return exportConversationToFile(this.store, this.conversationId, outDir);
  }

  /** Kết thúc conversation (ghi `conversation.ended`). */
  end(reason: 'user-closed' | 'expired' | 'error' = 'user-closed'): AnyConversationEvent {
    const state = this.getState();
    return this.record('conversation.ended', {
      reason,
      totalEvents: state.lastSeq + 1,
      totalMessages: state.messages.length,
    });
  }

  /** Verify chain của conversation này. */
  verify(): { ok: boolean; badSeq?: number; reason?: string; events: number } {
    return this.store.verify(this.conversationId);
  }
}
