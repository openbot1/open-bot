/**
 * Voice realtime v22 (v1.33, Doi T5) — voice loop chay qua inference
 * broker v2.
 *
 * Voice realtime VAN MOCK neu chua co key that (theo lenh dung:
 * mock-first khi thieu key that; khong thu live anh Gemini — key
 * mien phi quota anh = 0). Module nay khong goi bat ky provider
 * voice that nao, khong doc mic / sound card, khong doc credential.
 *
 * Nhung gi moi o v22 so voi voiceV20:
 * - Moi turn voice di qua InferenceBrokerV2: tool call do STT /
 *   agent sinh ra deu validate qua gate truoc khi thuc thi (giong
 *   moi engine khac — khong tin parser).
 * - Prefix cache cua broker duoc dung cho lich su hoi thoai voice:
 *   cac turn lap lai system prompt + lich su, hit rate do that va
 *   bao cao moi turn (giai latency/turn khi chay local).
 * - Engine local duoc chon theo task voice (latency-sensitive,
 *   multi-turn) qua router cua broker; neu engine chinh probe that
 *   bai thi fallback theo chuoi cua broker.
 * - Trang thai session + transcript mock (tong hop tu voiceV20):
 *   session co the mo / noi / dong, transcript duoc ghi lai, turn
 *   nao co tool call bi chan thi ghi ro trong lich su.
 *
 * Tat ca audio la mock / tong hop (khong co am thanh that).
 */

import {
  InferenceBrokerV2,
  createInferenceBrokerV2,
  type InferenceBrokerV2ChatExecutor,
  type InferenceBrokerV2Options,
} from './broker';
import {
  inferenceBrokerV2EngineLabel,
  type InferenceBrokerV2EngineKind,
} from './capabilityMatrix';
import type { InferenceBrokerV2PrefixLookup } from './prefixCache';
import type { InferenceBrokerV2ToolDefinition } from './validate';

/** Che do voice realtime v22. */
export type VoiceV22Mode = 'mock' | 'live';

/** Trang thai 1 voice session v22. */
export type VoiceV22SessionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'closed';

/** 1 turn trong session voice v22. */
export interface VoiceV22Turn {
  /** Id turn. */
  id: string;
  /** So thu tu turn (1-based). */
  index: number;
  /** Transcript mock cua user (do caller truyen vao — test / UI). */
  userText: string;
  /** Text tra loi cua agent (mock hoac tu broker). */
  agentText: string;
  /** Engine da phuc vu turn nay. */
  engine?: InferenceBrokerV2EngineKind;
  /** Prefix lookup cua turn nay. */
  prefixLookup?: InferenceBrokerV2PrefixLookup;
  /** Ten tool da goi trong turn (da validate). */
  toolCalls: string[];
  /** Ten tool bi chan trong turn (neu co). */
  blockedTools: string[];
  /** Thoi diem bat dau turn (ms epoch). */
  startedAt: number;
  /** Thoi diem ket thuc turn (ms epoch). */
  endedAt: number;
}

/** Thong ke 1 voice session v22. */
export interface VoiceV22SessionStats {
  /** Id session. */
  sessionId: string;
  /** Che do. */
  mode: VoiceV22Mode;
  /** Trang thai hien tai. */
  state: VoiceV22SessionState;
  /** Tong so turn. */
  turns: number;
  /** Tong so tool call da validate. */
  toolCallsValidated: number;
  /** Tong so tool call bi chan. */
  toolCallsBlocked: number;
  /** Hit rate prefix cache cua session. */
  prefixHitRate: number;
  /** Engine dang dung. */
  engine?: InferenceBrokerV2EngineKind;
  /** Ly do live chua bat (khi mode = mock). */
  mockReason?: string;
}

/** Ly do mock khi chua co key that. */
export const VOICE_V22_MOCK_REASON =
  'Voice realtime v22 dang chay MOCK: chua co key that cua provider voice. Khong thu live khi thieu key (mock-first).';

/**
 * Quyet dinh che do voice: chi 'live' khi host truyen key that ro
 * rang (hasLiveKey = true). Moi truong hop khac -> mock. Ham nay la
 * diem duy nhat quyet dinh live/mock — khong co duong tat nao khac.
 */
export function voiceV22ModeFor(opts?: { hasLiveKey?: boolean }): VoiceV22Mode {
  return opts?.hasLiveKey === true ? 'live' : 'mock';
}

/** Session voice v22: turn loop mock chay qua broker. */
export class VoiceV22Session {
  readonly sessionId: string;
  readonly mode: VoiceV22Mode;
  readonly broker: InferenceBrokerV2;
  private state: VoiceV22SessionState = 'idle';
  private readonly turns: VoiceV22Turn[] = [];
  private readonly nowFn: () => number;
  private engine?: InferenceBrokerV2EngineKind;
  private readonly hasExecutor: boolean;
  private readonly mockReply: (userText: string) => string;

  constructor(opts?: {
    sessionId?: string;
    hasLiveKey?: boolean;
    broker?: InferenceBrokerV2;
    brokerOptions?: InferenceBrokerV2Options;
    executor?: InferenceBrokerV2ChatExecutor;
    toolDefinitions?: readonly InferenceBrokerV2ToolDefinition[];
    mockReply?: (userText: string) => string;
    now?: () => number;
  }) {
    this.sessionId = opts?.sessionId ?? `voice-v22-${Math.floor(Math.random() * 1_000_000)}`;
    this.mode = voiceV22ModeFor({ hasLiveKey: opts?.hasLiveKey });
    this.nowFn = opts?.now ?? Date.now;
    // Ghi lai executor co duoc inject khong — broker giu executor o
    // private, session phai nho rieng de quyet dinh mock thuan hay
    // chay qua broker.chat (khong doan mo). Broker truyen san (opts.broker)
    // khong dem — vi session khong biet no co executor hay khong.
    this.hasExecutor = !!(opts?.executor ?? opts?.brokerOptions?.executor);
    this.broker =
      opts?.broker ??
      createInferenceBrokerV2({
        ...(opts?.brokerOptions ?? {}),
        executor: opts?.executor,
        toolDefinitions: opts?.toolDefinitions ?? [],
        now: this.nowFn,
      });
    // Neu caller truyen toolDefinitions ma broker da co san thi dang ky
    // them (gate cua broker rieng — khong dang ky trung 2 lan).
    if (opts?.broker && opts?.toolDefinitions) {
      for (const d of opts.toolDefinitions) this.broker.gate.registerTool(d);
    }
    this.mockReply =
      opts?.mockReply ??
      ((userText: string) =>
        `Mock tra loi cho: "${userText.slice(0, 120)}" (voice v22, khong co key that).`);
    // Chon engine mac dinh cho voice: latency-sensitive + multi-turn.
    const routed = this.broker.routeForTaskKind('voice');
    this.engine = routed.primary?.engine;
  }

  /** Trang thai hien tai. */
  get currentState(): VoiceV22SessionState {
    return this.state;
  }

  /** Engine dang dung cho session. */
  get currentEngine(): InferenceBrokerV2EngineKind | undefined {
    return this.engine;
  }

  /** Mo session (tu idle -> listening). */
  open(): boolean {
    if (this.state !== 'idle') return false;
    this.state = 'listening';
    return true;
  }

  /** Dong session (ghi lai, khong xoa lich su turn). */
  close(): void {
    this.state = 'closed';
  }

  /** Tat ca turn da dien ra (ban sao). */
  listTurns(): VoiceV22Turn[] {
    return this.turns.map((t) => ({ ...t, toolCalls: [...t.toolCalls], blockedTools: [...t.blockedTools] }));
  }

  /**
   * Chay 1 turn voice: nhan transcript mock cua user, chay qua broker
   * (neu co executor) de lay agent text + tool call da validate;
   * neu khong co executor (mock thuan) thi tra mock reply. Tool call
   * bi chan duoc ghi vao turn, khong thuc thi.
   */
  async turn(userText: string): Promise<VoiceV22Turn> {
    const startedAt = this.nowFn();
    if (this.state === 'closed') {
      throw new Error('Voice v22 session da dong — khong chay them turn.');
    }
    if (this.state === 'idle') this.state = 'listening';
    this.state = 'thinking';
    const index = this.turns.length + 1;
    const history = this.turns.flatMap((t) => [
      { role: 'user', content: t.userText },
      { role: 'assistant', content: t.agentText },
    ]);
    const messages = [
      { role: 'system', content: 'Ban la tro ly giong noi cua open-bot. Tra loi ngan gon, noi ro khi can goi tool.' },
      ...history,
      { role: 'user', content: userText },
    ] as { role: 'user' | 'assistant' | 'system'; content: string }[];

    let agentText = '';
    let toolCalls: string[] = [];
    let blockedTools: string[] = [];
    let prefixLookup: InferenceBrokerV2PrefixLookup | undefined;
    let engine = this.engine;

    // Broker chat chi chay khi co executor (host inject). Khong co
    // executor -> mock thuan, nhung van do prefix cache (beginTurn
    // chay trong broker.chat; o day do truc tiep de bao cao hit rate).
    if (!this.hasExecutor) {
      prefixLookup = this.broker.prefixCache.beginTurn(
        messages.map((m) => ({ role: m.role, content: m.content })),
        { sessionId: this.sessionId },
      );
      agentText = this.mockReply(userText);
    } else {
      const result = await this.broker.chat(
        {
          model: 'voice-v22',
          messages: messages as never,
        },
        { taskKind: 'voice', sessionId: this.sessionId, engine },
      );
      prefixLookup = result.prefixLookup;
      engine = result.servedByEngine ?? engine;
      this.engine = engine;
      if (result.ok && result.response) {
        agentText = result.response.text || this.mockReply(userText);
        toolCalls = result.response.toolCalls.map((c) => c.name);
      } else {
        agentText = this.mockReply(userText);
        blockedTools = extractBlockedToolNamesV22(result.blockedReasons);
      }
    }
    const turn: VoiceV22Turn = {
      id: `turn-${index}`,
      index,
      userText,
      agentText,
      engine,
      prefixLookup,
      toolCalls,
      blockedTools,
      startedAt,
      endedAt: this.nowFn(),
    };
    this.turns.push(turn);
    this.state = 'listening';
    return { ...turn, toolCalls: [...toolCalls], blockedTools: [...blockedTools] };
  }

  /** Thong ke session. */
  stats(): VoiceV22SessionStats {
    const gateStats = this.broker.gate.stats();
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      state: this.state,
      turns: this.turns.length,
      toolCallsValidated: gateStats.allowed,
      toolCallsBlocked: gateStats.blocked,
      prefixHitRate: this.broker.prefixCache.stats().hitRate,
      engine: this.engine,
      mockReason: this.mode === 'mock' ? VOICE_V22_MOCK_REASON : undefined,
    };
  }

  /** Tom tat dang markdown. */
  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Voice realtime v22 (qua inference broker v2)',
      '',
      `- Session: ${s.sessionId}; mode: ${s.mode}${s.mode === 'mock' ? ' (mock — chua co key that)' : ''}; state: ${s.state}.`,
      `- Engine: ${s.engine ? inferenceBrokerV2EngineLabel(s.engine) : 'chua chon'}; turns: ${s.turns}.`,
      `- Tool call: validate ok ${s.toolCallsValidated}, chan ${s.toolCallsBlocked}.`,
      `- Prefix-cache hit rate: ${(s.prefixHitRate * 100).toFixed(1)}%.`,
    ];
    if (s.mockReason) lines.push(`- ${s.mockReason}`);
    return lines.join('\n');
  }
}

/** Boc ten tool tu blockedReasons (dang `tool "ten" ...`). */
export function extractBlockedToolNamesV22(reasons: readonly string[]): string[] {
  const names: string[] = [];
  for (const r of reasons) {
    const m = /tool "([^"]+)"/.exec(r);
    if (m && m[1] && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Tao 1 session voice v22 moi (mock neu khong co key that). */
export function createVoiceV22Session(opts?: ConstructorParameters<typeof VoiceV22Session>[0]): VoiceV22Session {
  return new VoiceV22Session(opts);
}
