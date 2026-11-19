/**
 * Memory v22 — Collect: nap candidate fact tu transcript gan day
 * (v1.37, Doi T1).
 *
 * Y tuong (Anthropic Dreams "doc lai transcript" + Letta
 * sleep-time "doc thu agent da luu"): truoc khi consolidate,
 * dream can "thu thap" — host day transcript cac turn gan day
 * vao, collector tach thanh ung vien fact. Day la phase
 * `collect` cua pipeline dreamer (truoc dedupe).
 *
 * Quy tac (xac dinh, khong can model):
 *  1. Tach turn thanh cau (theo dau `.` `!` `?` xuong dong).
 *     Cau hoi (ket bang `?`) bi bo — cau hoi khong phai fact.
 *  2. Bo cau chao hoi / cam on / cau qua ngan / qua dai /
 *     cau toan so — chi giu cau co the la fact.
 *  3. Confidence theo nguon: user noi ve ban than (0.75) tin
 *     hon agent tu suy ra (0.55); turn he thong thap nhat (0.4).
 *  4. Topic/value: trich theo mau cau co dinh (tieng Viet +
 *     tieng Anh) — vd "User thich ca phe" -> topic
 *     `user|thich`, value `ca-phe`; khong khop mau thi de
 *     trong (fact van duoc nhan, chi khong tham gia supersede).
 *  5. Khong tu dong ghi vao store: collector chi tra danh sach
 *     ung vien + ly do bo qua; dreamer (hoac host) moi quyet
 *     dinh nap vao store — de host kiem soat duoc dau vao.
 */
import type { V22DreamFactInput } from './types';
import { V22_DREAM_DEFAULT_CONFIG, V22_MAX_FACT_TEXT_CHARS } from './types';
import { normalizeTopicV22, normalizeValueV22, stripDiacriticsV22 } from './store';

/** Mot turn trong transcript (host day vao). */
export interface V22TranscriptTurn {
  role: 'user' | 'agent' | 'system';
  text: string;
  /** Epoch ms cua turn (mac dinh = now luc collect). */
  at?: number;
  /** Session cua turn (mac dinh = sessionId o options). */
  sessionId?: string;
}

/** Tuy chon collect. */
export interface V22CollectOptions {
  /** Do dai cau toi thieu (ky tu). Mac dinh 8. */
  minLength?: number;
  /** Do dai cau toi da (ky tu). Mac dinh 500. */
  maxLength?: number;
  /** Confidence mac dinh cho cau user. Mac dinh 0.75. */
  userConfidence?: number;
  /** Confidence mac dinh cho cau agent. Mac dinh 0.55. */
  agentConfidence?: number;
  /** Confidence mac dinh cho cau system. Mac dinh 0.4. */
  systemConfidence?: number;
  /** true = trich topic/value theo mau (mac dinh true). */
  extractTopicValue?: boolean;
  /** So turn toi da xu ly trong mot lan (chong qua tai). */
  maxTurns?: number;
  /** Session mac dinh gan cho ung vien (neu turn khong co). */
  sessionId?: string;
  /** Nguon mac dinh gan cho ung vien (vd `chat:session-1`). */
  source?: string;
  /** Epoch ms moc (mac dinh Date.now()). */
  now?: number;
}

export const V22_COLLECT_DEFAULTS: Required<
  Pick<V22CollectOptions, 'minLength' | 'maxLength' | 'userConfidence' | 'agentConfidence' | 'systemConfidence' | 'extractTopicValue' | 'maxTurns'>
> = {
  minLength: 8,
  maxLength: V22_MAX_FACT_TEXT_CHARS,
  userConfidence: 0.75,
  agentConfidence: 0.55,
  systemConfidence: 0.4,
  extractTopicValue: true,
  maxTurns: 200,
};

/** Cau chao hoi / xa giao — khong phai fact, bo qua. */
export const V22_GREETING_PATTERNS: readonly RegExp[] = [
  /^(xin chao|chao|hi|hello|hey|good morning|good afternoon|good evening)\b/i,
  /^(cam on|thank you|thanks|cam on ban|ok|oke|okay|duoc|vay nhe|tam biet|bye)\b/i,
  /^(ban co the|can you|could you|please|lam on)\b/i,
];

/** Mot mau trich topic/value: regex + cach sinh topic/value. */
export interface V22TopicPattern {
  pattern: RegExp;
  topic: string;
  /** Nhom regex lay lam value (1-based). */
  valueGroup: number;
}

/**
 * Mau trich topic/value (tieng Viet + tieng Anh). Pattern khop
 * phan SAU khi da bo chu ngu dau cau (`user` / `toi` / `tôi`
 * / `i`) — vd "Toi thich ca phe" hay "User likes coffee" deu
 * trich duoc. Value lay toi da 6 tu dau cua nhom khop.
 */
export const V22_TOPIC_PATTERNS: readonly V22TopicPattern[] = [
  { pattern: /^thich\s+(.+)$/i, topic: 'user|thich', valueGroup: 1 },
  { pattern: /^likes?\s+(.+)$/i, topic: 'user|likes', valueGroup: 1 },
  { pattern: /^song\s+o\s+(.+)$/i, topic: 'user|dia_diem', valueGroup: 1 },
  { pattern: /^lives?\s+in\s+(.+)$/i, topic: 'user|location', valueGroup: 1 },
  { pattern: /^ten\s+(?:la\s+)?(.+)$/i, topic: 'user|ten', valueGroup: 1 },
  { pattern: /^name\s+is\s+(.+)$/i, topic: 'user|name', valueGroup: 1 },
  { pattern: /^lam\s+(.+?)\s+(?:o|tai)\s+(.+)$/i, topic: 'user|nghe_nghiep', valueGroup: 1 },
  { pattern: /^works?\s+as\s+(.+)$/i, topic: 'user|job', valueGroup: 1 },
];

/** Tach mot turn thanh cac cau (bo khoang trang thua, giu cau dai). */
export function splitTurnIntoSentencesV22(text: string): string[] {
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s.length > 0);
}

/** true = cau la chao hoi / xa giao (khong phai fact). */
export function isGreetingV22(sentence: string): boolean {
  const ascii = stripDiacriticsV22(sentence.trim());
  return V22_GREETING_PATTERNS.some((re) => re.test(ascii));
}

/** Trich topic/value tu mot cau theo mau co dinh (null = khong khop mau). */
export function extractTopicValueV22(
  sentence: string,
): { topic: string; value: string } | null {
  // Khop mau tren ban bo dau (vd "Tôi thích cà phê" -> "Toi thich ca phe").
  const cleaned = stripDiacriticsV22(sentence.trim()).replace(/\s+/g, ' ');
  // Bo chu ngu dau cau (user / toi / tôi / i) roi moi khop mau dong tu.
  const noSubject = cleaned.replace(/^(user|toi|i)\s+/i, '');
  for (const entry of V22_TOPIC_PATTERNS) {
    const match = noSubject.match(entry.pattern);
    if (!match) continue;
    const rawValue = (match[entry.valueGroup] ?? '').trim();
    if (!rawValue) continue;
    // Value chi lay toi da 6 tu (bo menh de thua phia sau).
    const words = rawValue.split(/\s+/).slice(0, 6).join(' ');
    const topic = normalizeTopicV22(entry.topic);
    const value = normalizeValueV22(words);
    if (!topic || !value) continue;
    return { topic, value };
  }
  return null;
}

/** Ket qua collect: ung vien + ly do bo qua tung cau. */
export interface V22CollectResult {
  candidates: V22DreamFactInput[];
  /** So cau da doc (truoc khi loc). */
  sentencesSeen: number;
  /** So cau bi bo qua (kem ly do — de host biet vi sao). */
  skipped: string[];
}

/**
 * Tach transcript thanh ung vien fact (khong ghi vao store).
 * Cau hoi / chao hoi / qua ngan / qua dai bi bo co ly do.
 */
export function collectFromTranscriptV22(
  turns: V22TranscriptTurn[],
  options: V22CollectOptions = {},
): V22CollectResult {
  const opts = { ...V22_COLLECT_DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const candidates: V22DreamFactInput[] = [];
  const skipped: string[] = [];
  let sentencesSeen = 0;
  const limited = turns.slice(0, opts.maxTurns);
  for (const turn of limited) {
    if (typeof turn.text !== 'string' || turn.text.trim() === '') {
      skipped.push('bo qua turn rong.');
      continue;
    }
    const confidence = turn.role === 'user'
      ? opts.userConfidence
      : turn.role === 'agent'
        ? opts.agentConfidence
        : opts.systemConfidence;
    const sessionId = turn.sessionId ?? options.sessionId;
    const source = options.source ?? (sessionId ? `chat:${sessionId}` : 'chat');
    const sentences = splitTurnIntoSentencesV22(turn.text);
    const isQuestionTurn = turn.text.trim().endsWith('?');
    for (let i = 0; i < sentences.length; i += 1) {
      const sentence = sentences[i];
      sentencesSeen += 1;
      // Cau cuoi cua turn hoi thi la cau hoi — khong phai fact.
      if (isQuestionTurn && i === sentences.length - 1) {
        skipped.push(`bo qua cau hoi: "${sentence.slice(0, 60)}"`);
        continue;
      }
      if (sentence.length < opts.minLength) {
        skipped.push(`bo qua cau qua ngan (${sentence.length} ky tu): "${sentence.slice(0, 60)}"`);
        continue;
      }
      if (sentence.length > opts.maxLength) {
        skipped.push(`bo qua cau qua dai (${sentence.length} ky tu): "${sentence.slice(0, 60)}..."`);
        continue;
      }
      if (isGreetingV22(sentence)) {
        skipped.push(`bo qua cau chao hoi/xa giao: "${sentence.slice(0, 60)}"`);
        continue;
      }
      const extracted = opts.extractTopicValue ? extractTopicValueV22(sentence) : null;
      candidates.push({
        kind: 'observation',
        text: sentence,
        ...(extracted ? { topic: extracted.topic, value: extracted.value } : {}),
        confidence,
        sources: [source],
        tags: ['transcript'],
        ...(sessionId ? { sessionIds: [sessionId] } : {}),
        observedAt: turn.at ?? now,
        origin: 'chat',
      });
    }
  }
  if (turns.length > opts.maxTurns) {
    skipped.push(`bo qua ${turns.length - opts.maxTurns} turn vuot maxTurns=${opts.maxTurns}.`);
  }
  return { candidates, sentencesSeen, skipped };
}

/** Collector giu trang thai (dem so turn/cau da xu ly — de bao cao). */
export class V22TranscriptCollector {
  private turnsSeen = 0;
  private sentencesSeen = 0;
  private candidatesTotal = 0;

  /** Tong so turn da xu ly. */
  getTurnsSeen(): number {
    return this.turnsSeen;
  }

  /** Tong so cau da xu ly. */
  getSentencesSeen(): number {
    return this.sentencesSeen;
  }

  /** Tong so ung vien da tao. */
  getCandidatesTotal(): number {
    return this.candidatesTotal;
  }

  /** Collect mot dot transcript (khong ghi vao store). */
  collect(turns: V22TranscriptTurn[], options: V22CollectOptions = {}): V22CollectResult {
    const result = collectFromTranscriptV22(turns, options);
    this.turnsSeen += Math.min(turns.length, options.maxTurns ?? V22_COLLECT_DEFAULTS.maxTurns);
    this.sentencesSeen += result.sentencesSeen;
    this.candidatesTotal += result.candidates.length;
    return result;
  }

  /** Reset bo dem (khong anh huong store). */
  reset(): void {
    this.turnsSeen = 0;
    this.sentencesSeen = 0;
    this.candidatesTotal = 0;
  }
}
