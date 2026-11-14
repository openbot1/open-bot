/**
 * Voice-driven tool calls (v1.04, Team T5 — voice realtime v3).
 *
 * The loop already hears the user; this module lets the user *act*
 * by voice — "nhắc agent kiểm tra lại test", "có gì thay đổi rồi",
 * "kết thúc cuộc gọi" — by turning a finished transcript into a
 * tool call. It is deliberately narrow, because a misheard word
 * must never delete a file or send a message:
 *
 *   - Only the twelve voice-call tools (`VOICE_CALL_TOOL_DEFINITIONS`
 *     in `voice/callTools.ts` — nudge, peek_*, recall_*, stay_silent,
 *     switch_agent, transfer, end_call, save_checkpoint) can ever
 *     run from voice. Anything else — the general registry's file
 *     writes, shell, network sends, payments — is `blocked`, not
 *     guessed: the commander answers with a refusal, never a call.
 *   - Risk tiers: `safe` (read-only: peek, recall, search,
 *     stay-silent) runs immediately; `confirm` (anything that acts
 *     on the world — nudge, switch_agent, transfer, end_call,
 *     save_checkpoint) waits for a spoken yes/no; `blocked` never
 *     runs. The confirmation prompt is spoken back through the TTS
 *     queue by the caller, and the user's next turn answers it.
 *   - Confirmation answers are parsed in Vietnamese and English
 *     (`đồng ý` / `yes` / `ok` … vs `không` / `no` / `hủy` …).
 *     An unclear answer repeats the question instead of guessing;
 *     a confirmation expires after `confirmTimeoutMs` (default
 *     60 s) and the pending call is dropped, never auto-run.
 *   - Every decision is written to an in-memory audit log
 *     (`getAuditLog()`), capped at 200 entries, so the UI can show
 *     exactly what voice did and what it refused.
 *
 * The commander never executes anything itself: the caller injects
 * a `VoiceToolExecutor` (the real voice-call handlers in
 * production, a recording fake in tests). With no executor, a safe
 * tool resolves as `{ ok: false, summary: 'no executor' }` instead
 * of throwing — the loop can still report it honestly.
 */
import {
  VOICE_CALL_TOOL_NAMES,
  getVoiceCallToolDefinition,
  validateVoiceCallArgs,
} from './callTools';
import type { VoiceCallToolName } from './types';

/** How much a voice tool call may do without asking first. */
export type VoiceToolRisk = 'safe' | 'confirm' | 'blocked';

/**
 * Risk of each voice-call tool. Read-only tools are safe; anything
 * that changes state, moves work, or ends the call must be
 * confirmed; anything outside the twelve is blocked (see
 * `classifyVoiceToolRisk`).
 */
export const VOICE_TOOL_RISK: Readonly<Record<VoiceCallToolName, VoiceToolRisk>> = {
  nudge: 'confirm',
  peek_agents: 'safe',
  peek_runs: 'safe',
  peek_changes: 'safe',
  recall_texts: 'safe',
  search_conversations: 'safe',
  stay_silent: 'safe',
  switch_agent: 'confirm',
  transfer: 'confirm',
  end_call: 'confirm',
  save_checkpoint: 'confirm',
  recall_media: 'safe',
};

/** Words that sound like a destructive general-tool request (blocked). */
export const VOICE_BLOCKED_INTENT_RES: readonly RegExp[] = [
  /(xóa|xoá|delete|remove)\s+(file|tệp|thư mục|folder|dữ liệu)/i,
  /(chạy|run|execute)\s+(lệnh|command|shell|script|bash)/i,
  /(gửi|send)\s+(email|mail|tin nhắn|message)/i,
  /(thanh toán|pay|payment|chuyển tiền|mua)/i,
  /(đăng|xóa bài|post|publish)\s+(facebook|instagram|twitter|x\b)/i,
  /(mật khẩu|password|api[- ]?key|secret|token)/i,
];

/**
 * Risk for any tool name. The twelve voice-call tools use
 * `VOICE_TOOL_RISK`; every other name is `blocked` — a voice turn
 * can never reach the general registry, however it is phrased.
 */
export function classifyVoiceToolRisk(toolName: string): VoiceToolRisk {
  const risk = (VOICE_TOOL_RISK as Readonly<Record<string, VoiceToolRisk>>)[toolName];
  return risk ?? 'blocked';
}

/** One parsed voice command (before the risk decision). */
export interface VoiceToolCommand {
  tool: VoiceCallToolName;
  args: Record<string, unknown>;
  /** The transcript it came from. */
  rawText: string;
  /** 1.0 = anchored trigger phrase, 0.7 = loose match. */
  confidence: number;
  risk: VoiceToolRisk;
}

/** What the commander did with one transcript. */
export type VoiceCommandOutcome =
  | { status: 'no-command' }
  | { status: 'blocked'; command: VoiceToolCommand; reason: string }
  | { status: 'executed'; command: VoiceToolCommand; result: VoiceToolExecutionResult }
  | { status: 'invalid-args'; command: VoiceToolCommand; error: string }
  | {
      status: 'awaiting-confirmation';
      command: VoiceToolCommand;
      confirmationId: string;
      prompt: string;
    };

/** What answering a pending confirmation did. */
export type VoiceConfirmationOutcome =
  | { status: 'executed'; command: VoiceToolCommand; result: VoiceToolExecutionResult }
  | { status: 'cancelled'; command: VoiceToolCommand }
  | { status: 'unclear'; confirmationId: string; prompt: string }
  | { status: 'expired'; confirmationId: string }
  | { status: 'unknown'; confirmationId: string };

/** Result of running a voice tool through the injected executor. */
export interface VoiceToolExecutionResult {
  ok: boolean;
  summary: string;
}

/** Runs one voice tool (the real handlers in production). */
export type VoiceToolExecutor = (
  tool: VoiceCallToolName,
  args: Record<string, unknown>,
) => Promise<VoiceToolExecutionResult>;

/** One audit entry: what voice tried, and what happened. */
export interface VoiceToolAuditEntry {
  id: string;
  at: number;
  transcript: string;
  tool: string;
  risk: VoiceToolRisk;
  status: 'executed' | 'awaiting-confirmation' | 'confirmed' | 'cancelled' | 'blocked' | 'invalid-args' | 'expired' | 'no-executor';
  detail: string;
}

export interface VoiceToolCommanderOptions {
  /** Runs the tool. Absent = every execution reports 'no executor'. */
  executor?: VoiceToolExecutor;
  /** Language of confirmation prompts. Default 'vi'. */
  lang?: 'vi' | 'en';
  /** Ms a confirmation stays valid. Default 60_000. */
  confirmTimeoutMs?: number;
  /** Clock (ms). Default Date.now. */
  clock?: () => number;
}

export interface VoiceToolCommanderStats {
  parsed: number;
  executed: number;
  confirmed: number;
  cancelled: number;
  blocked: number;
  expired: number;
  pending: number;
  auditEntries: number;
}

/** Words that count as "yes" / "no" when answering a confirmation. */
export const CONFIRM_YES_WORDS: readonly string[] = [
  'đồng ý', 'dong y', 'có', 'ừ', 'ừm', 'ok', 'okay', 'được', 'làm đi', 'chạy đi',
  'vâng', 'dạ', 'đúng', 'yes', 'yeah', 'yep', 'sure', 'go ahead', 'do it',
];
export const CONFIRM_NO_WORDS: readonly string[] = [
  'không', 'khong', 'hủy', 'huỷ', 'huy', 'thôi', 'đừng', 'dừng lại',
  'no', 'nope', 'cancel', "don't", 'stop',
];

/**
 * Parse a spoken yes/no answer. Exact-word / phrase match on the
 * normalized text; `unclear` when neither side matches, so the
 * caller repeats the question instead of guessing. Hesitation
 * ("để xem đã", "chưa biết") beats a stray yes-word: "ừm... để xem
 * đã" is thinking, not agreeing.
 */
export function parseConfirmationAnswer(text: string): 'yes' | 'no' | 'unclear' {
  const clean = ` ${text.toLowerCase().replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (!clean.trim()) return 'unclear';
  for (const phrase of CONFIRM_HESITATION_PHRASES) {
    if (clean.includes(` ${phrase} `) || clean.includes(` ${phrase}`)) return 'unclear';
  }
  for (const word of CONFIRM_NO_WORDS) {
    if (clean.includes(` ${word} `)) return 'no';
  }
  for (const word of CONFIRM_YES_WORDS) {
    if (clean.includes(` ${word} `)) return 'yes';
  }
  return 'unclear';
}

/** Hesitation phrases: thinking, not answering — always `unclear`. */
export const CONFIRM_HESITATION_PHRASES: readonly string[] = [
  'để xem', 'để tôi', 'để mình', 'chưa biết', 'khoan', 'khoan đã', 'đợi đã',
  'wait', 'let me think', 'not sure', 'chưa chắc',
];

interface VoicePattern {
  tool: VoiceCallToolName;
  /** Anchored trigger = confidence 1.0; loose = 0.7. */
  anchored: boolean;
  re: RegExp;
  args: (match: RegExpMatchArray, text: string) => Record<string, unknown> | null;
}

const TASK_CAPTURE = '(.{1,200})';

/** Trigger phrases (vi + en) per tool, most specific first. */
export const VOICE_COMMAND_PATTERNS: readonly VoicePattern[] = [
  {
    tool: 'end_call', anchored: true,
    re: /^(kết thúc|dừng|ngắt)\s+(cuộc gọi|call)|^(hang up|end (the )?call|stop the call)\b/i,
    args: () => ({}),
  },
  {
    tool: 'stay_silent', anchored: true,
    re: /^(im lặng|yên lặng|đừng nói|đừng trả lời|im đi)\b|^(stay silent|be quiet|say nothing|shut up)\b/i,
    args: () => ({}),
  },
  {
    tool: 'switch_agent', anchored: true,
    re: /^(chuyển sang|đổi sang|chuyển qua)\s+(agent\s+)?|^(switch (to )?(agent )?)/i,
    args: (m, text) => {
      const to = text.replace(/^(chuyển sang|đổi sang|chuyển qua)\s+(agent\s+)?/i, '').replace(/^switch (to )?(agent )?/i, '').trim();
      return to ? { to } : {};
    },
  },
  {
    tool: 'transfer', anchored: true,
    re: /^(chuyển|chuyển cuộc gọi|chuyển cho)\s+|^(transfer)( the call)?( to)?\s+/i,
    args: (m, text) => {
      const to = text.replace(/^(chuyển|chuyển cuộc gọi|chuyển cho)\s+/i, '').replace(/^transfer( the call)?( to)?\s+/i, '').trim();
      return to ? { to } : {};
    },
  },
  {
    tool: 'save_checkpoint', anchored: true,
    re: /^(lưu lại|lưu checkpoint|lưu tiến độ|ghi nhớ tiến độ)\b|^(save (a )?checkpoint|save progress)\b/i,
    args: () => ({}),
  },
  {
    tool: 'peek_changes', anchored: false,
    re: /(có gì thay đổi|file nào (đã )?thay đổi|thay đổi gì (rồi|chưa)|what (has )?changed|show (me )?(the )?changes|any changes)/i,
    args: () => ({}),
  },
  {
    tool: 'peek_agents', anchored: false,
    re: /(agent nào đang|agent đang làm gì|các agent đang|which agents|what are the agents doing|agent status)/i,
    args: () => ({}),
  },
  {
    tool: 'peek_runs', anchored: false,
    re: /(run nào đang|run đang chạy|các run|which runs|running runs|run status)/i,
    args: () => ({}),
  },
  {
    tool: 'recall_media', anchored: false,
    re: /(ảnh (này|đó|thứ|kia)|xem ảnh|mô tả ảnh|show (me )?(the|this|that) (photo|image|picture)|describe (the|this|that) (photo|image|picture)|what.*(photo|image|picture))/i,
    args: () => ({}),
  },
  {
    tool: 'search_conversations', anchored: false,
    re: /(tìm trong (đoạn chat|cuộc trò chuyện|chat|hội thoại)|search (in )?(the )?(chat|conversation|history)|find in (the )?conversation)/i,
    args: (m, text) => {
      const q = text.replace(/.*?(tìm trong (đoạn chat|cuộc trò chuyện|chat|hội thoại)|search (in )?(the )?(chat|conversation|history)|find in (the )?conversation)\s*/i, '').trim();
      return q ? { query: q } : { query: text };
    },
  },
  {
    tool: 'recall_texts', anchored: false,
    re: /(nhớ lại|tìm trong (ghi chú|note|memory)|recall|nhớ (lại )?không|do you remember)/i,
    args: (m, text) => {
      const q = text.replace(/.*?(nhớ lại|tìm trong (ghi chú|note|memory)|recall|nhớ (lại )?không|do you remember)\s*/i, '').trim();
      return q ? { query: q } : { query: text };
    },
  },
  {
    tool: 'nudge', anchored: true,
    re: /^(nhắc|nhờ|bảo|giao (cho|việc)|nudge|ask (the )?agent to)\s+/i,
    args: (m, text) => {
      // "nhắc agent chạy lại test" → task "chạy lại test" (the
      // word "agent" after the trigger is address, not task).
      const task = text
        .replace(/^(nhắc|nhờ|bảo|giao (cho|việc)|nudge|ask (the )?agent to)\s+/i, '')
        .replace(/^agent\s+/i, '')
        .trim();
      return task ? { task: task.slice(0, 2000) } : null;
    },
  },
  {
    tool: 'nudge', anchored: false,
    re: new RegExp(`(nhắc agent|bảo agent|giao việc cho agent)\\s+${TASK_CAPTURE}$`, 'i'),
    args: (m) => (m[1] ? { task: m[1].trim().slice(0, 2000) } : null),
  },
];

/**
 * Parse a finished transcript into a voice tool command, or null
 * when it is ordinary conversation. A transcript that sounds like a
 * blocked general-tool request (delete a file, run a shell command,
 * send mail, pay) is parsed as a `nudge`… no — it is returned as a
 * blocked command for the `nudge` tool's slot is wrong; instead the
 * caller checks `isBlockedVoiceIntent` first. This function only
 * matches the twelve voice-call tools.
 */
export function parseVoiceCommand(rawText: string): VoiceToolCommand | null {
  const text = rawText.trim();
  if (!text) return null;
  for (const pattern of VOICE_COMMAND_PATTERNS) {
    const m = pattern.re.exec(text);
    if (!m) continue;
    const args = pattern.args(m, text);
    if (args === null) continue;
    return {
      tool: pattern.tool,
      args,
      rawText: text,
      confidence: pattern.anchored ? 1.0 : 0.7,
      risk: VOICE_TOOL_RISK[pattern.tool],
    };
  }
  return null;
}

/** True when the transcript sounds like a blocked general-tool request. */
export function isBlockedVoiceIntent(rawText: string): boolean {
  return VOICE_BLOCKED_INTENT_RES.some((re) => re.test(rawText));
}

/** Human-readable description of a command, for the confirm prompt. */
export function describeVoiceCommand(command: VoiceToolCommand, lang: 'vi' | 'en'): string {
  const task = (command.args.task as string | undefined) ?? '';
  const to = (command.args.to as string | undefined) ?? '';
  const query = (command.args.query as string | undefined) ?? '';
  const vi: Record<string, string> = {
    nudge: `giao việc "${task}" cho agent`,
    peek_agents: 'xem các agent đang làm gì',
    peek_runs: 'xem các run đang chạy',
    peek_changes: 'xem file nào đã thay đổi',
    recall_texts: `tìm trong ghi chú "${query}"`,
    search_conversations: `tìm trong đoạn chat "${query}"`,
    stay_silent: 'giữ im lặng',
    switch_agent: `chuyển sang agent "${to || 'khác'}"`,
    transfer: `chuyển cuộc gọi${to ? ` cho ${to}` : ''}`,
    end_call: 'kết thúc cuộc gọi',
    save_checkpoint: 'lưu lại tiến độ cuộc gọi',
    recall_media: 'xem lại ảnh đã gửi',
  };
  const en: Record<string, string> = {
    nudge: `hand the task "${task}" to the agent`,
    peek_agents: 'check what the agents are doing',
    peek_runs: 'check the running runs',
    peek_changes: 'check which files changed',
    recall_texts: `search the notes for "${query}"`,
    search_conversations: `search the chat for "${query}"`,
    stay_silent: 'stay silent',
    switch_agent: `switch to agent "${to || 'another'}"`,
    transfer: `transfer the call${to ? ` to ${to}` : ''}`,
    end_call: 'end the call',
    save_checkpoint: 'save the call progress',
    recall_media: 'look at the photo again',
  };
  return (lang === 'vi' ? vi : en)[command.tool] ?? command.tool;
}

/** Confirmation prompt spoken back before a `confirm`-risk tool runs. */
export function buildConfirmationPrompt(command: VoiceToolCommand, lang: 'vi' | 'en'): string {
  const what = describeVoiceCommand(command, lang);
  return lang === 'vi'
    ? `Bạn có chắc muốn ${what} không? Trả lời "đồng ý" hoặc "không".`
    : `Are you sure you want to ${what}? Answer "yes" or "no".`;
}

interface PendingConfirmation {
  id: string;
  command: VoiceToolCommand;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}

export const VOICE_COMMANDER_DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
export const VOICE_COMMANDER_MAX_AUDIT_ENTRIES = 200;

export class VoiceToolCommander {
  private readonly executor?: VoiceToolExecutor;
  private readonly lang: 'vi' | 'en';
  private readonly confirmTimeoutMs: number;
  private readonly clock: () => number;
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly audit: VoiceToolAuditEntry[] = [];
  private counter = 0;
  private readonly stats: VoiceToolCommanderStats = {
    parsed: 0,
    executed: 0,
    confirmed: 0,
    cancelled: 0,
    blocked: 0,
    expired: 0,
    pending: 0,
    auditEntries: 0,
  };

  constructor(options: VoiceToolCommanderOptions = {}) {
    this.executor = options.executor;
    this.lang = options.lang ?? 'vi';
    this.confirmTimeoutMs = Math.max(
      1000,
      options.confirmTimeoutMs ?? VOICE_COMMANDER_DEFAULT_CONFIRM_TIMEOUT_MS,
    );
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Handle one finished transcript: parse → risk → execute, ask, or
   * refuse. Never throws: an executor failure is an `executed`
   * outcome with `ok: false`, not an exception.
   */
  async handleTranscript(rawText: string): Promise<VoiceCommandOutcome> {
    const text = rawText.trim();
    if (!text) return { status: 'no-command' };
    if (isBlockedVoiceIntent(text)) {
      this.stats.blocked += 1;
      const command: VoiceToolCommand = {
        tool: 'nudge',
        args: {},
        rawText: text,
        confidence: 0,
        risk: 'blocked',
      };
      this.addAudit({
        transcript: text,
        tool: '(blocked intent)',
        risk: 'blocked',
        status: 'blocked',
        detail: 'Voice cannot run file/shell/send/payment tools.',
      });
      return {
        status: 'blocked',
        command,
        reason:
          this.lang === 'vi'
            ? 'Giọng nói không được phép chạy tool xóa file, shell, gửi tin hay thanh toán.'
            : 'Voice cannot run file-delete, shell, send-message or payment tools.',
      };
    }
    const command = parseVoiceCommand(text);
    if (!command) return { status: 'no-command' };
    this.stats.parsed += 1;
    // Validate args against the tool definition before anything runs.
    const validation = validateVoiceCallArgs(command.tool, command.args);
    if (!validation.ok) {
      this.addAudit({
        transcript: text,
        tool: command.tool,
        risk: command.risk,
        status: 'invalid-args',
        detail: validation.error,
      });
      return { status: 'invalid-args', command, error: validation.error };
    }
    command.args = validation.args;
    if (command.risk === 'blocked') {
      this.stats.blocked += 1;
      this.addAudit({
        transcript: text,
        tool: command.tool,
        risk: 'blocked',
        status: 'blocked',
        detail: 'Tool is not in the voice-call toolset.',
      });
      return { status: 'blocked', command, reason: `Tool ${command.tool} cannot run from voice.` };
    }
    if (command.risk === 'confirm') {
      const now = this.clock();
      const confirmationId = `confirm-${++this.counter}`;
      const prompt = buildConfirmationPrompt(command, this.lang);
      this.pending.set(confirmationId, {
        id: confirmationId,
        command,
        prompt,
        createdAt: now,
        expiresAt: now + this.confirmTimeoutMs,
      });
      this.stats.pending = this.pending.size;
      this.addAudit({
        transcript: text,
        tool: command.tool,
        risk: 'confirm',
        status: 'awaiting-confirmation',
        detail: prompt,
      });
      return { status: 'awaiting-confirmation', command, confirmationId, prompt };
    }
    const result = await this.execute(command);
    return { status: 'executed', command, result };
  }

  /**
   * Answer a pending confirmation with the user's next spoken turn.
   * `yes` runs the tool, `no` cancels it, anything else repeats the
   * question (`unclear`) so the loop can speak the prompt again.
   */
  async answerConfirmation(
    confirmationId: string,
    answerText: string,
  ): Promise<VoiceConfirmationOutcome> {
    const pending = this.pending.get(confirmationId);
    if (!pending) return { status: 'unknown', confirmationId };
    const now = this.clock();
    if (now > pending.expiresAt) {
      this.pending.delete(confirmationId);
      this.stats.expired += 1;
      this.stats.pending = this.pending.size;
      this.addAudit({
        transcript: answerText,
        tool: pending.command.tool,
        risk: 'confirm',
        status: 'expired',
        detail: `Confirmation ${confirmationId} expired.`,
      });
      return { status: 'expired', confirmationId };
    }
    const answer = parseConfirmationAnswer(answerText);
    if (answer === 'unclear') {
      return { status: 'unclear', confirmationId, prompt: pending.prompt };
    }
    this.pending.delete(confirmationId);
    this.stats.pending = this.pending.size;
    if (answer === 'no') {
      this.stats.cancelled += 1;
      this.addAudit({
        transcript: answerText,
        tool: pending.command.tool,
        risk: 'confirm',
        status: 'cancelled',
        detail: 'User declined the confirmation.',
      });
      return { status: 'cancelled', command: pending.command };
    }
    this.stats.confirmed += 1;
    const result = await this.execute(pending.command, 'confirmed');
    return { status: 'executed', command: pending.command, result };
  }

  /** Drop confirmations past their deadline. Returns expired ids. */
  expireConfirmations(now?: number): string[] {
    const at = now ?? this.clock();
    const expired: string[] = [];
    for (const [id, pending] of this.pending) {
      if (at > pending.expiresAt) {
        expired.push(id);
        this.pending.delete(id);
        this.stats.expired += 1;
        this.addAudit({
          transcript: '',
          tool: pending.command.tool,
          risk: 'confirm',
          status: 'expired',
          detail: `Confirmation ${id} expired.`,
        });
      }
    }
    this.stats.pending = this.pending.size;
    return expired;
  }

  /** Pending confirmation ids (oldest first). */
  getPendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** The pending confirmation, or undefined. */
  getPending(confirmationId: string): { command: VoiceToolCommand; prompt: string } | undefined {
    const pending = this.pending.get(confirmationId);
    return pending ? { command: { ...pending.command }, prompt: pending.prompt } : undefined;
  }

  /** Audit log, oldest first (copies, capped at 200). */
  getAuditLog(): VoiceToolAuditEntry[] {
    return this.audit.map((e) => ({ ...e }));
  }

  getStats(): VoiceToolCommanderStats {
    return { ...this.stats, pending: this.pending.size, auditEntries: this.audit.length };
  }

  private async execute(
    command: VoiceToolCommand,
    status: 'executed' | 'confirmed' = 'executed',
  ): Promise<VoiceToolExecutionResult> {
    if (!this.executor) {
      this.addAudit({
        transcript: command.rawText,
        tool: command.tool,
        risk: command.risk,
        status: 'no-executor',
        detail: 'No executor bound — tool not run.',
      });
      return { ok: false, summary: 'no executor bound for voice tools' };
    }
    let result: VoiceToolExecutionResult;
    try {
      result = await this.executor(command.tool, command.args);
    } catch (e) {
      result = {
        ok: false,
        summary: e instanceof Error ? e.message : 'executor failed',
      };
    }
    this.stats.executed += 1;
    this.addAudit({
      transcript: command.rawText,
      tool: command.tool,
      risk: command.risk,
      status,
      detail: result.summary,
    });
    return result;
  }

  private addAudit(entry: Omit<VoiceToolAuditEntry, 'id' | 'at'>): void {
    this.audit.push({
      id: `audit-${++this.counter}`,
      at: this.clock(),
      ...entry,
    });
    while (this.audit.length > VOICE_COMMANDER_MAX_AUDIT_ENTRIES) {
      this.audit.shift();
    }
    this.stats.auditEntries = this.audit.length;
  }
}

/** True when the name is one of the twelve voice-call tools. */
export function isVoiceCallableTool(name: string): boolean {
  return (VOICE_CALL_TOOL_NAMES as readonly string[]).includes(name);
}

/** The definition of a voice-call tool, or undefined when unknown. */
export function getVoiceCallableTool(name: string) {
  return getVoiceCallToolDefinition(name);
}
