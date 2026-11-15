/**
 * CoALA 4 loại memory — working / episodic / semantic / procedural
 * (v1.10, Đội T1).
 *
 * Mỗi loại có store + lifecycle riêng, hợp nhất trong MemoryManagerV10
 * (xem manager.ts):
 *  - WorkingMemory: vòng đệm các turn gần nhất, dung lượng giới hạn
 *    (mặc định 20 turn) + TTL ngắn (mặc định 30 phút) — "RAM" của
 *    agent, quên nhanh, chỉ phục vụ turn hiện tại.
 *  - EpisodicStore: nhật ký từng turn (episode + summary + factIds),
 *    giữ tối đa N episode (mặc định 500), prune cũ nhất trước.
 *  - SemanticStore: fact đã consolidate trong BiTemporalGraphV10 —
 *    tri thức bền vững, truy vấn được theo thời gian.
 *  - ProceduralStore: thủ tục trigger → steps, có đếm uses/successes
 *    để đo độ tin cậy qua thực tế dùng (không phải qua lời nói).
 *
 * Lifecycle (luồng thăng cấp):
 *  working turn → episodic episode (ghi ngay khi ingest) → semantic
 *  fact (qua extraction + consolidation) → procedural (khi turn chứa
 *  hướng dẫn nhiều bước). Working hết TTL / đầy thì rơi khỏi RAM
 *  nhưng episode + fact đã bền vững vẫn còn.
 */

import type { MemoryScope } from '../graph/types';
import { BiTemporalGraphV10 } from './biTemporalGraph';
import type {
  V10Episode,
  V10Procedure,
  V10ProceduralCandidate,
  V10WorkingItem,
} from './types';

/** Dung lượng mặc định của working memory (số turn). */
export const V10_WORKING_CAPACITY = 20;
/** TTL mặc định của một working item (ms) — 30 phút. */
export const V10_WORKING_TTL_MS = 30 * 60 * 1000;
/** Số episode tối đa episodic store giữ. */
export const V10_EPISODIC_MAX = 500;

/** Working memory: vòng đệm turn gần nhất, quên nhanh. */
export class WorkingMemory {
  private readonly items: V10WorkingItem[] = [];
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(opts: { capacity?: number; ttlMs?: number } = {}) {
    this.capacity = opts.capacity ?? V10_WORKING_CAPACITY;
    this.ttlMs = opts.ttlMs ?? V10_WORKING_TTL_MS;
  }

  /** Thêm một turn vào working memory (đẩy item cũ nhất khi đầy). */
  push(role: string, text: string, turnId: string, now: Date = new Date()): V10WorkingItem {
    this.pruneExpired(now);
    const item: V10WorkingItem = {
      turnId,
      role,
      text: text.slice(0, 4000),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      createdAt: now.toISOString(),
    };
    this.items.push(item);
    while (this.items.length > this.capacity) this.items.shift();
    return { ...item };
  }

  /** Xoá item đã hết TTL (tính tới `now`). Trả số item đã xoá. */
  pruneExpired(now: Date = new Date()): number {
    const before = this.items.length;
    const nowMs = now.getTime();
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (Date.parse(this.items[i].expiresAt) <= nowMs) this.items.splice(i, 1);
    }
    return before - this.items.length;
  }

  /** Các turn còn hiệu lực, theo thứ tự thời gian. */
  list(now: Date = new Date()): V10WorkingItem[] {
    this.pruneExpired(now);
    return this.items.map((i) => ({ ...i }));
  }

  /** Text gộp của working memory — chèn thẳng vào system prompt. */
  renderContext(now: Date = new Date()): string {
    const items = this.list(now);
    if (items.length === 0) return '';
    return items.map((i) => `${i.role}: ${i.text}`).join('\n');
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Episodic store: nhật ký turn, prune cũ nhất khi vượt giới hạn. */
export class EpisodicStore {
  private readonly episodes: V10Episode[] = [];
  private readonly maxEpisodes: number;
  private counter = 0;

  constructor(opts: { maxEpisodes?: number } = {}) {
    this.maxEpisodes = opts.maxEpisodes ?? V10_EPISODIC_MAX;
  }

  /** Ghi một episode mới (summary = câu đầu tiên, tối đa 400 ký tự). */
  record(input: {
    turnId: string;
    role: string;
    text: string;
    scope: MemoryScope;
    factIds?: string[];
  }): V10Episode {
    const now = new Date().toISOString();
    this.counter += 1;
    const firstSentence = input.text.split(/(?<=[.!?\n])/u)[0]?.trim() ?? '';
    const episode: V10Episode = {
      id: `v10e-${this.counter}-${Math.random().toString(36).slice(2, 8)}`,
      turnId: input.turnId,
      runId: input.scope.runId,
      botId: input.scope.botId,
      userId: input.scope.userId,
      role: input.role,
      text: input.text.slice(0, 8000),
      summary: firstSentence.slice(0, 400),
      factIds: input.factIds ? [...input.factIds] : [],
      processed: false,
      createdAt: now,
    };
    this.episodes.push(episode);
    this.prune();
    return { ...episode };
  }

  /** Đánh dấu episode đã qua consolidation. */
  markProcessed(episodeId: string, factIds: string[]): V10Episode | null {
    const ep = this.episodes.find((e) => e.id === episodeId);
    if (!ep) return null;
    ep.processed = true;
    ep.factIds = [...factIds];
    return { ...ep };
  }

  /** Xoá episode cũ nhất khi vượt giới hạn. Trả số đã xoá. */
  prune(): number {
    let removed = 0;
    while (this.episodes.length > this.maxEpisodes) {
      this.episodes.shift();
      removed += 1;
    }
    return removed;
  }

  list(): V10Episode[] {
    return this.episodes.map((e) => ({ ...e, factIds: [...e.factIds] }));
  }

  /** Episode gần nhất trước (mới nhất xếp cuối). */
  recent(limit: number): V10Episode[] {
    const safe = Math.max(0, Math.min(limit, this.episodes.length));
    return this.episodes.slice(-safe).map((e) => ({ ...e, factIds: [...e.factIds] }));
  }

  get(id: string): V10Episode | undefined {
    const found = this.episodes.find((e) => e.id === id);
    return found ? { ...found, factIds: [...found.factIds] } : undefined;
  }

  /** Nạp episode đã lưu (manager dùng khi load từ đĩa). */
  load(episodes: V10Episode[]): void {
    this.episodes.length = 0;
    for (const ep of episodes) this.episodes.push({ ...ep, factIds: [...ep.factIds] });
    this.prune();
  }

  count(): number {
    return this.episodes.length;
  }
}

/** Semantic store: bọc BiTemporalGraphV10 (fact bền vững). */
export class SemanticStore {
  graph: BiTemporalGraphV10;

  constructor(graph?: BiTemporalGraphV10) {
    this.graph = graph ?? new BiTemporalGraphV10();
  }

  /** Thay graph bằng graph đã nạp từ đĩa (giữ nguyên id/status/validity). */
  loadGraph(graph: BiTemporalGraphV10): void {
    this.graph = graph;
  }

  /** Fact đang đúng bây giờ, thuộc scope (nếu truyền). */
  currentFacts(scope?: Partial<MemoryScope>): ReturnType<BiTemporalGraphV10['queryNow']> {
    return this.graph.queryNow(scope ? { scope } : {});
  }

  count(): number {
    return this.graph.count();
  }

  countActive(): number {
    return this.graph.countByStatus('active');
  }
}

/** Procedural store: thủ tục trigger → steps, học từ lần dùng. */
export class ProceduralStore {
  private readonly procedures: V10Procedure[] = [];
  private counter = 0;

  /** Thêm thủ tục mới từ ứng viên extraction (dedupe theo trigger
   *  chuẩn hoá: trigger trùng thì gộp steps mới vào, không tạo 2 bản). */
  add(candidate: V10ProceduralCandidate, scope: MemoryScope, sourceEpisodeId: string): V10Procedure {
    const normTrigger = candidate.trigger.trim().toLowerCase();
    const existing = this.procedures.find((p) => p.trigger.trim().toLowerCase() === normTrigger);
    const now = new Date().toISOString();
    if (existing) {
      // Gộp bước mới chưa có (giữ thứ tự cũ, thêm bước mới cuối).
      for (const step of candidate.steps) {
        if (!existing.steps.some((s) => s.trim().toLowerCase() === step.trim().toLowerCase())) {
          existing.steps.push(step);
        }
      }
      return { ...existing, steps: [...existing.steps] };
    }
    this.counter += 1;
    const proc: V10Procedure = {
      id: `v10p-${this.counter}-${Math.random().toString(36).slice(2, 8)}`,
      trigger: candidate.trigger,
      steps: [...candidate.steps],
      uses: 0,
      successes: 0,
      scope: { ...scope },
      sourceEpisodeId,
      createdAt: now,
      lastUsedAt: null,
    };
    this.procedures.push(proc);
    return { ...proc, steps: [...proc.steps] };
  }

  /** Ghi nhận một lần dùng thủ tục (thành công hay không). */
  recordUse(id: string, success: boolean): V10Procedure | null {
    const proc = this.procedures.find((p) => p.id === id);
    if (!proc) return null;
    proc.uses += 1;
    if (success) proc.successes += 1;
    proc.lastUsedAt = new Date().toISOString();
    return { ...proc, steps: [...proc.steps] };
  }

  /** Tỉ lệ thành công 0..1 (chưa dùng lần nào → 0.5, "chưa biết"). */
  successRate(proc: V10Procedure): number {
    if (proc.uses === 0) return 0.5;
    return proc.successes / proc.uses;
  }

  /** Tìm thủ tục theo trigger (khớp chứa, không phân biệt hoa thường). */
  findByTrigger(query: string): V10Procedure[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    return this.procedures
      .filter((p) => p.trigger.toLowerCase().includes(q) || q.includes(p.trigger.toLowerCase()))
      .map((p) => ({ ...p, steps: [...p.steps] }));
  }

  list(): V10Procedure[] {
    return this.procedures.map((p) => ({ ...p, steps: [...p.steps] }));
  }

  get(id: string): V10Procedure | undefined {
    const found = this.procedures.find((p) => p.id === id);
    return found ? { ...found, steps: [...found.steps] } : undefined;
  }

  /** Nạp thủ tục đã lưu (manager dùng khi load từ đĩa). */
  load(procedures: V10Procedure[]): void {
    this.procedures.length = 0;
    for (const proc of procedures) this.procedures.push({ ...proc, steps: [...proc.steps] });
  }

  count(): number {
    return this.procedures.length;
  }
}
