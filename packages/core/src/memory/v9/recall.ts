/**
 * Memory v9 kiểu Letta — tầng recall (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta/MemGPT: ngoài core memory luôn nằm trong
 * context còn có recall memory — tóm tắt các phiên gần đây, truy hồi
 * theo thời gian (mới nhất trước) và theo từ khoá khi agent cần nhớ
 * lại chuyện vừa xảy ra. Viết lại hoàn toàn cho open-bot, chạy local:
 *
 *  - Mỗi phiên kết thúc được ghi thành một "session summary": id
 *    phiên, bot, thời gian bắt đầu/kết thúc, số turn, tóm tắt trích
 *    xuất (condense.ts) + danh sách episode (turn user/bot, tối đa
 *    giữ 50 episode/phiên, mỗi episode tối đa 2000 ký tự).
 *  - Recall: lọc theo khoảng thời gian (since/until), tìm theo từ
 *    khoá (token overlap + điểm recency decay theo giờ), trả tối đa
 *    `limit` kết quả mới nhất trước.
 *  - Lưu trữ: JSONL append-only `.open-bot/memory-v9-recall.jsonl`
 *    (một dòng một session summary), đọc toàn bộ vào RAM khi mở
 *    (recall vốn chỉ giữ phiên gần đây — prune mặc định 90 ngày /
 *    tối đa 500 phiên, cũ hơn bị cắt khi ghi).
 *  - Không embedding: search là keyword + recency, để tránh rò
 *    vector ra ngoài tool output (giống quy ước tiers v7).
 *
 * Không phá API cũ: đây là tầng mới, chạy song song với v7 tiers và
 * long-term memory v0.95 — sleep pass v9-Letta ghi summary vào đây,
 * archival tier đọc từ đây khi thăng cấp phiên cũ thành fact dài hạn.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { condenseText } from './condense';
import { condenseWords } from './condense';

/** File recall (JSONL, một dòng một session summary). */
export const V9_RECALL_REL_PATH = path.join('.open-bot', 'memory-v9-recall.jsonl');
/** Số phiên tối đa giữ trong file recall. */
export const V9_RECALL_KEEP_SESSIONS = 500;
/** Tuổi tối đa của một phiên trong recall (ms, mặc định 90 ngày). */
export const V9_RECALL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Số episode tối đa giữ trong một session summary. */
export const V9_RECALL_MAX_EPISODES = 50;
/** Độ dài tối đa của một episode (ký tự, dài hơn thì cắt). */
export const V9_RECALL_MAX_EPISODE_CHARS = 2000;
/** Độ dài tối đa của tóm tắt phiên (ký tự). */
export const V9_RECALL_SUMMARY_CHARS = 1500;
/** Hằng số decay recency: điểm recency = 1 / (1 + ageHours / 24). */
export const V9_RECALL_DECAY_HALF_LIFE_HOURS = 24;

/** Một turn (episode) trong phiên. */
export interface RecallEpisode {
  id: string;
  role: 'user' | 'bot';
  text: string;
  at: string;
}

/** Tóm tắt một phiên đã kết thúc (một dòng trong file recall). */
export interface RecallSession {
  id: string;
  sessionId: string;
  botId: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  /** Tóm tắt trích xuất từ toàn bộ episode (condense, không bịa). */
  summary: string;
  episodes: RecallEpisode[];
}

/** Đầu vào khi ghi một phiên (episode thô, chưa tóm tắt). */
export interface RecordRecallSessionInput {
  sessionId: string;
  botId: string;
  startedAt?: string;
  endedAt?: string;
  episodes: Array<{ role: 'user' | 'bot'; text: string; at?: string }>;
}

/** Kết quả recall một phiên (kèm điểm số để agent/UI xếp hạng). */
export interface RecallHit {
  session: RecallSession;
  /** Điểm keyword 0..1 (overlap từ khoá truy vấn / từ khoá phiên). */
  keywordScore: number;
  /** Điểm recency 0..1 (1 = vừa xong, giảm dần theo giờ). */
  recencyScore: number;
  /** Điểm tổng = 0.6 * keyword + 0.4 * recency (query rỗng -> chỉ recency). */
  score: number;
}

/** Điều kiện truy hồi. */
export interface RecallQuery {
  query?: string;
  botId?: string;
  /** Chỉ lấy phiên kết thúc sau mốc này (ISO). */
  since?: string;
  /** Chỉ lấy phiên kết thúc trước mốc này (ISO). */
  until?: string;
  limit?: number;
}

/** Lỗi recall — message tiếng Việt. */
export class RecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallError';
  }
}

/** Điểm recency theo tuổi (giờ): 1 khi vừa xong, giảm dần, không âm. */
export function lettaRecencyScore(endedAt: string, now = new Date()): number {
  const ageMs = now.getTime() - new Date(endedAt).getTime();
  if (ageMs <= 0) return 1;
  const ageHours = ageMs / (60 * 60 * 1000);
  return 1 / (1 + ageHours / V9_RECALL_DECAY_HALF_LIFE_HOURS);
}

/** Điểm keyword: overlap Jaccard giữa từ khoá truy vấn và từ của phiên. */
export function recallKeywordScore(query: string, session: RecallSession): number {
  const queryWords = condenseWords(query);
  if (queryWords.size === 0) return 0;
  const haystack = new Set<string>();
  for (const w of condenseWords(session.summary)) haystack.add(w);
  for (const ep of session.episodes) {
    for (const w of condenseWords(ep.text)) haystack.add(w);
  }
  let inter = 0;
  for (const w of queryWords) if (haystack.has(w)) inter += 1;
  return inter / queryWords.size;
}

/** Cắt text về tối đa `max` ký tự (cắt ở ranh giới từ khi có thể). */
function truncateText(text: string, max: number): string {
  const t = (text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(0, max - 1)).trimEnd();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Tầng recall: ghi tóm tắt phiên + truy hồi theo thời gian/từ khoá.
 * Một instance gắn với một workspace (đọc/ghi file JSONL của nó).
 */
export class RecallStore {
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, V9_RECALL_REL_PATH);
  }

  /** Đọc toàn bộ session (bỏ dòng hỏng, không throw). */
  readAll(): RecallSession[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const out: RecallSession[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const parsed = JSON.parse(trimmed) as RecallSession;
          if (parsed && typeof parsed.sessionId === 'string' && Array.isArray(parsed.episodes)) {
            out.push(parsed);
          }
        } catch {
          // Dòng hỏng: bỏ qua, không làm hỏng cả file.
        }
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Ghi đè toàn bộ file (atomic: temp + rename, mode 0600). */
  private writeAll(sessions: RecallSession[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    const body = sessions.map((s) => JSON.stringify(s)).join('\n') + (sessions.length > 0 ? '\n' : '');
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Ghi thêm một session vào cuối file (append, không đọc lại toàn bộ). */
  private appendOne(session: RecallSession): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, JSON.stringify(session) + '\n', { mode: 0o600 });
  }

  /**
   * Ghi tóm tắt một phiên đã kết thúc. Episode được cắt ngắn + giới
   * hạn số lượng; summary được cô đọng trích xuất từ toàn bộ episode
   * (mỗi episode thành một dòng "user: ..." / "bot: ...").
   */
  recordSession(input: RecordRecallSessionInput): RecallSession {
    const sessionId = (input.sessionId ?? '').trim();
    if (sessionId === '') throw new RecallError('sessionId không được rỗng.');
    const botId = (input.botId ?? '').trim();
    if (botId === '') throw new RecallError('botId không được rỗng.');
    const episodesRaw = Array.isArray(input.episodes) ? input.episodes : [];
    const episodes: RecallEpisode[] = episodesRaw.slice(0, V9_RECALL_MAX_EPISODES).map((ep, i) => ({
      id: `ep-${i}`,
      role: ep.role === 'bot' ? 'bot' : 'user',
      text: truncateText(ep.text ?? '', V9_RECALL_MAX_EPISODE_CHARS),
      at: ep.at ?? new Date().toISOString(),
    }));
    const transcript = episodes.map((ep) => `${ep.role}: ${ep.text}`).join('\n');
    const summary = condenseText(transcript, V9_RECALL_SUMMARY_CHARS).text;
    const now = new Date().toISOString();
    const session: RecallSession = {
      id: randomUUID(),
      sessionId,
      botId,
      startedAt: input.startedAt ?? now,
      endedAt: input.endedAt ?? now,
      turns: episodes.length,
      summary,
      episodes,
    };
    this.appendOne(session);
    this.prune();
    return session;
  }

  /**
   * Truy hồi phiên: lọc bot/thời gian, chấm điểm (keyword + recency),
   * trả mới nhất trước. Query rỗng -> chỉ xếp theo recency (phiên
   * gần đây nhất).
   */
  recall(query: RecallQuery = {}): RecallHit[] {
    const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 10)));
    const q = (query.query ?? '').trim();
    const sinceMs = query.since ? new Date(query.since).getTime() : Number.NEGATIVE_INFINITY;
    const untilMs = query.until ? new Date(query.until).getTime() : Number.POSITIVE_INFINITY;
    const now = new Date();
    const hits: RecallHit[] = [];
    for (const session of this.readAll()) {
      if (query.botId && session.botId !== query.botId) continue;
      const endedMs = new Date(session.endedAt).getTime();
      if (Number.isFinite(sinceMs) && endedMs < sinceMs) continue;
      if (Number.isFinite(untilMs) && endedMs > untilMs) continue;
      const keyword = q === '' ? 0 : recallKeywordScore(q, session);
      // Query có từ khoá nhưng phiên không khớp từ nào -> loại.
      if (q !== '' && keyword === 0) continue;
      const recency = lettaRecencyScore(session.endedAt, now);
      const score = q === '' ? recency : 0.6 * keyword + 0.4 * recency;
      hits.push({ session, keywordScore: keyword, recencyScore: recency, score });
    }
    hits.sort((a, b) => b.score - a.score || b.session.endedAt.localeCompare(a.session.endedAt));
    return hits.slice(0, limit);
  }

  /** Xoá một phiên khỏi recall theo sessionId (true = đã xoá). */
  deleteSession(sessionId: string): boolean {
    const all = this.readAll();
    const kept = all.filter((s) => s.sessionId !== sessionId);
    if (kept.length === all.length) return false;
    this.writeAll(kept);
    return true;
  }

  /**
   * Cắt file recall về giới hạn: tối đa N phiên mới nhất, tuổi tối đa
   * 90 ngày. Trả về số phiên đã cắt (để sleep log).
   */
  prune(now = new Date()): number {
    const all = this.readAll();
    if (all.length === 0) return 0;
    const cutoff = now.getTime() - V9_RECALL_MAX_AGE_MS;
    const fresh = all
      .filter((s) => new Date(s.endedAt).getTime() >= cutoff)
      .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const kept = fresh.slice(Math.max(0, fresh.length - V9_RECALL_KEEP_SESSIONS));
    const removed = all.length - kept.length;
    if (removed > 0) this.writeAll(kept);
    return removed;
  }

  /** Thống kê nhanh cho UI/entity stats. */
  stats(): { sessions: number; episodes: number; oldestEndedAt: string | null; newestEndedAt: string | null } {
    const all = this.readAll();
    let episodes = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const s of all) {
      episodes += s.episodes.length;
      if (oldest === null || s.endedAt < oldest) oldest = s.endedAt;
      if (newest === null || s.endedAt > newest) newest = s.endedAt;
    }
    return { sessions: all.length, episodes, oldestEndedAt: oldest, newestEndedAt: newest };
  }
}
