/**
 * Memory v7 — 4-tier memory (v1.06, Đội T1).
 *
 * Ý tưởng học từ Letta/MemGPT (core memory luôn nằm trong prompt,
 * archival memory ở ngoài, agent tự quản lý) và Mem0 v3 (scope
 * user/agent/run, ADD-only): bộ nhớ chia 4 tầng rõ ràng, mỗi tầng có
 * TTL + dung lượng riêng, và một item chỉ đổi tầng qua API thăng/giáng
 * tường minh — không có đường tắt âm thầm nào khác.
 *
 *   working  — ghi chú của turn đang chạy (TTL mặc định 1 giờ, tối đa
 *              20 item). Hết turn thì consolidate đẩy lên session.
 *   session  — ngữ cảnh của phiên/chat hiện tại (TTL 24 giờ, tối đa
 *              200 item). Hết phiên thì item đủ điểm lên episodic.
 *   episodic — sự kiện đã xảy ra, có thời gian (TTL 90 ngày, tối đa
 *              1000 item). Item được truy cập nhiều / điểm cao thì lên
 *              semantic; hết TTL thì sweep.
 *   semantic — tri thức lâu dài đã cô đọng (không TTL, tối đa 5000
 *              item). Chỉ consolidation hoặc promote tường minh mới
 *              đưa item vào đây; không bao giờ tự xoá.
 *
 * Điểm số (score 0..1) của một item = độ tin cậy ban đầu, cộng điểm
 * truy cập (mỗi lần recall +0.02, trần +0.2) — giống cơ chế ranking
 * của memory v5 nhưng tính trên item, không phải trên fact đồ thị.
 *
 * Lưu trữ: một file JSON local `.open-bot/memory-v7-tiers.json`,
 * ghi atomic (temp + rename, mode 0600) như MemoryBlockStore — đủ bền
 * cho local-first, không cần SQLite. Không có embedding: search là
 * keyword + score, để tránh rò vector ra ngoài tool output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MEMORY_V7_TIERS_REL_PATH = path.join('.open-bot', 'memory-v7-tiers.json');

/** Bốn tầng, xếp theo độ bền tăng dần. */
export const MEMORY_TIERS = ['working', 'session', 'episodic', 'semantic'] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

/** Thứ hạng của tầng: working (0) < session (1) < episodic (2) < semantic (3). */
export function tierRank(tier: MemoryTier): number {
  return MEMORY_TIERS.indexOf(tier);
}

/** true khi `tier` là tầng bền hơn `other` (đi lên). */
export function isHigherTier(tier: MemoryTier, other: MemoryTier): boolean {
  return tierRank(tier) > tierRank(other);
}

/** TTL mặc định của mỗi tầng (ms). Semantic không hết hạn (null). */
export function tierDefaultTtlMs(tier: MemoryTier): number | null {
  switch (tier) {
    case 'working':
      return 60 * 60 * 1000;
    case 'session':
      return 24 * 60 * 60 * 1000;
    case 'episodic':
      return 90 * 24 * 60 * 60 * 1000;
    case 'semantic':
      return null;
  }
}

/** Dung lượng tối đa của mỗi tầng (item). Vượt thì item cũ nhất rớt. */
export function tierCapacity(tier: MemoryTier): number {
  switch (tier) {
    case 'working':
      return 20;
    case 'session':
      return 200;
    case 'episodic':
      return 1000;
    case 'semantic':
      return 5000;
  }
}

/** Ngưỡng điểm để consolidation tự thăng tầng (xem consolidate()). */
export const TIER_PROMOTE_SCORE = 0.7;
/** Số lần truy cập tối thiểu để một episodic item được xét lên semantic. */
export const TIER_SEMANTIC_MIN_ACCESSES = 3;

export function isValidTier(value: unknown): value is MemoryTier {
  return typeof value === 'string' && (MEMORY_TIERS as readonly string[]).includes(value);
}

/** Một item bộ nhớ ở một tầng. */
export interface TieredMemoryItem {
  id: string;
  tier: MemoryTier;
  /** Nhãn ngắn (slug) để tra cứu, vd `thich-pho`. */
  label: string;
  /** Nội dung (tối đa 4000 ký tự — tầng càng cao càng nên ngắn gọn). */
  content: string;
  /** Độ tin cậy / điểm 0..1 (mặc định 0.5). */
  score: number;
  /** Nguồn: `turn:<id>`, `episode:<id>`, `block:<label>`, `import`, ... */
  source: string;
  /** Scope kiểu Mem0 v3: user / agent(run) / bot. */
  userId?: string;
  botId?: string;
  runId?: string;
  /** Số lần item được recall (tăng điểm, xem effectiveScore()). */
  accessCount: number;
  lastAccessedAt?: string;
  /** Hết hạn lúc nào (null = không hết hạn). */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TieredMemoryFile {
  version: 1;
  items: TieredMemoryItem[];
}

export interface AddTieredItemInput {
  label: string;
  content: string;
  score?: number;
  source?: string;
  userId?: string;
  botId?: string;
  runId?: string;
  /** TTL riêng (ms); null = không hết hạn; vắng = TTL mặc định của tầng. */
  ttlMs?: number | null;
}

/** Điểm hiệu dụng = score + bonus truy cập (mỗi lần +0.02, trần +0.2). */
export function effectiveScore(item: Pick<TieredMemoryItem, 'score' | 'accessCount'>): number {
  return Math.min(1, item.score + Math.min(0.2, item.accessCount * 0.02));
}

/** true khi item đã hết hạn tại `at` (mặc định: bây giờ). */
export function isItemExpired(
  item: Pick<TieredMemoryItem, 'expiresAt'>,
  at: Date = new Date(),
): boolean {
  if (!item.expiresAt) return false;
  return new Date(item.expiresAt).getTime() <= at.getTime();
}

export const MAX_TIERED_ITEM_CHARS = 4000;
export const MAX_TIERED_LABEL_CHARS = 128;

/** Chuẩn hoá label thành slug (dùng chung quy tắc với memory blocks). */
export function normalizeTieredLabel(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_TIERED_LABEL_CHARS);
}

function clampScore(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export interface TierStats {
  tier: MemoryTier;
  count: number;
  capacity: number;
  expiredCount: number;
  avgScore: number;
}

export interface TierConsolidationReport {
  ranAt: string;
  /** Item working hết turn -> session. */
  workingToSession: number;
  /** Item session đủ điểm -> episodic. */
  sessionToEpisodic: number;
  /** Item episodic đủ điểm + đủ lượt truy cập -> semantic. */
  episodicToSemantic: number;
  /** Item hết TTL đã xoá. */
  expiredSwept: number;
  /** Item rớt do vượt dung lượng tầng đích. */
  capacityDropped: number;
  /** Tầng nào còn bao nhiêu item sau khi chạy. */
  countsAfter: Record<MemoryTier, number>;
}

export class TieredMemoryStore {
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, MEMORY_V7_TIERS_REL_PATH);
  }

  private readFile(): TieredMemoryFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, items: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Tiered memory file is not valid JSON: ${MEMORY_V7_TIERS_REL_PATH}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as TieredMemoryFile).version !== 1 ||
      !Array.isArray((parsed as TieredMemoryFile).items)
    ) {
      throw new Error(`Tiered memory file has an unsupported shape: ${MEMORY_V7_TIERS_REL_PATH}`);
    }
    return parsed as TieredMemoryFile;
  }

  private writeFile(file: TieredMemoryFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Thêm item vào một tầng. Label trùng trong cùng tầng -> throw. */
  add(tier: MemoryTier, input: AddTieredItemInput): TieredMemoryItem {
    if (!isValidTier(tier)) throw new Error(`Memory tier không hợp lệ: "${String(tier)}".`);
    const label = normalizeTieredLabel(input.label);
    if (!label) throw new Error('Memory tier item cần một label (không được rỗng).');
    const content = (input.content ?? '').trim();
    if (!content) throw new Error(`Item "${label}" không có nội dung.`);
    if (content.length > MAX_TIERED_ITEM_CHARS) {
      throw new Error(
        `Nội dung item "${label}" dài ${content.length} ký tự, vượt giới hạn ${MAX_TIERED_ITEM_CHARS} ký tự.`,
      );
    }
    const file = this.readFile();
    if (file.items.some((i) => i.tier === tier && i.label === label)) {
      throw new Error(`Đã có item "${label}" ở tầng ${tier} — dùng label khác hoặc sửa item đó.`);
    }
    const now = new Date();
    const ttlMs = input.ttlMs !== undefined ? input.ttlMs : tierDefaultTtlMs(tier);
    const item: TieredMemoryItem = {
      id: randomUUID(),
      tier,
      label,
      content,
      score: clampScore(input.score, 0.5),
      source: (input.source ?? 'manual').trim() || 'manual',
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      accessCount: 0,
      expiresAt: ttlMs === null ? null : new Date(now.getTime() + ttlMs).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    file.items.push(item);
    this.enforceCapacity(file, tier);
    this.writeFile(file);
    return { ...item };
  }

  /** Tìm item theo id hoặc (tier + label). Null khi không có. */
  get(idOrLabel: string, tier?: MemoryTier): TieredMemoryItem | null {
    const file = this.readFile();
    const label = normalizeTieredLabel(idOrLabel);
    const found =
      file.items.find((i) => i.id === idOrLabel) ??
      file.items.find(
        (i) => i.label === label && (tier === undefined || i.tier === tier),
      );
    return found ? { ...found } : null;
  }

  /** Liệt kê item, lọc theo tầng / user / bot / run; hết hạn vẫn liệt kê (kèm cờ). */
  list(opts: {
    tier?: MemoryTier;
    userId?: string;
    botId?: string;
    runId?: string;
    includeExpired?: boolean;
    limit?: number;
  } = {}): TieredMemoryItem[] {
    const file = this.readFile();
    let items = file.items;
    if (opts.tier !== undefined) items = items.filter((i) => i.tier === opts.tier);
    if (opts.userId !== undefined) {
      items = items.filter((i) => (i.userId ?? '') === '' || i.userId === opts.userId);
    }
    if (opts.botId !== undefined) items = items.filter((i) => (i.botId ?? '') === '' || i.botId === opts.botId);
    if (opts.runId !== undefined) items = items.filter((i) => (i.runId ?? '') === '' || i.runId === opts.runId);
    if (!opts.includeExpired) items = items.filter((i) => !isItemExpired(i));
    // Tầng cao trước, rồi điểm hiệu dụng giảm dần, rồi mới nhất trước.
    items = [...items].sort(
      (a, b) =>
        tierRank(b.tier) - tierRank(a.tier) ||
        effectiveScore(b) - effectiveScore(a) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(1000, Math.floor(opts.limit))) : 200;
    return items.slice(0, limit).map((i) => ({ ...i }));
  }

  /** Ghi nhận một lần recall: accessCount +1, lastAccessedAt mới, điểm hiệu dụng tăng. */
  touch(idOrLabel: string, tier?: MemoryTier): TieredMemoryItem {
    const file = this.readFile();
    const item = this.resolveItem(file, idOrLabel, tier);
    item.accessCount += 1;
    item.lastAccessedAt = new Date().toISOString();
    item.updatedAt = item.lastAccessedAt;
    this.writeFile(file);
    return { ...item };
  }

  /** Cập nhật nội dung / điểm của item (không đổi tầng — đổi tầng dùng promote/demote). */
  update(
    idOrLabel: string,
    patch: { content?: string; score?: number },
    tier?: MemoryTier,
  ): TieredMemoryItem {
    const file = this.readFile();
    const item = this.resolveItem(file, idOrLabel, tier);
    if (patch.content !== undefined) {
      const content = patch.content.trim();
      if (!content) throw new Error(`Item "${item.label}" không được để nội dung rỗng.`);
      if (content.length > MAX_TIERED_ITEM_CHARS) {
        throw new Error(
          `Nội dung item "${item.label}" dài ${content.length} ký tự, vượt giới hạn ${MAX_TIERED_ITEM_CHARS} ký tự.`,
        );
      }
      item.content = content;
    }
    if (patch.score !== undefined) item.score = clampScore(patch.score, item.score);
    item.updatedAt = new Date().toISOString();
    this.writeFile(file);
    return { ...item };
  }

  /**
   * Thăng tầng: chỉ được đi LÊN (working -> session -> episodic ->
   * semantic), mỗi lần một bậc, và item hết hạn không thăng được.
   * Lên semantic thì bỏ TTL (tri thức lâu dài không hết hạn).
   */
  promote(idOrLabel: string, targetTier: MemoryTier, tier?: MemoryTier): TieredMemoryItem {
    if (!isValidTier(targetTier)) throw new Error(`Memory tier không hợp lệ: "${String(targetTier)}".`);
    const file = this.readFile();
    const item = this.resolveItem(file, idOrLabel, tier);
    if (isItemExpired(item)) {
      throw new Error(`Item "${item.label}" đã hết hạn ở tầng ${item.tier} — không thăng tầng được, hãy tạo lại.`);
    }
    if (tierRank(targetTier) <= tierRank(item.tier)) {
      throw new Error(
        `Promote chỉ đi lên: item "${item.label}" đang ở tầng ${item.tier}, không thăng lên ${targetTier} được. Dùng demote để đi xuống.`,
      );
    }
    if (tierRank(targetTier) !== tierRank(item.tier) + 1) {
      throw new Error(
        `Promote chỉ đi một bậc: item "${item.label}" đang ở tầng ${item.tier}, chỉ thăng lên ${MEMORY_TIERS[tierRank(item.tier) + 1]} được.`,
      );
    }
    if (file.items.some((i) => i.tier === targetTier && i.label === item.label && i.id !== item.id)) {
      throw new Error(`Đã có item "${item.label}" ở tầng ${targetTier} — xoá hoặc đổi label trước.`);
    }
    item.tier = targetTier;
    if (targetTier === 'semantic') item.expiresAt = null;
    else {
      const ttl = tierDefaultTtlMs(targetTier);
      item.expiresAt = ttl === null ? null : new Date(Date.now() + ttl).toISOString();
    }
    item.updatedAt = new Date().toISOString();
    this.enforceCapacity(file, targetTier);
    this.writeFile(file);
    return { ...item };
  }

  /**
   * Giáng tầng: chỉ được đi XUỐNG, mỗi lần một bậc. Giáng khỏi
   * semantic thì item lấy lại TTL mặc định của tầng đích.
   */
  demote(idOrLabel: string, targetTier: MemoryTier, tier?: MemoryTier): TieredMemoryItem {
    if (!isValidTier(targetTier)) throw new Error(`Memory tier không hợp lệ: "${String(targetTier)}".`);
    const file = this.readFile();
    const item = this.resolveItem(file, idOrLabel, tier);
    if (tierRank(targetTier) >= tierRank(item.tier)) {
      throw new Error(
        `Demote chỉ đi xuống: item "${item.label}" đang ở tầng ${item.tier}, không giáng xuống ${targetTier} được. Dùng promote để đi lên.`,
      );
    }
    if (tierRank(targetTier) !== tierRank(item.tier) - 1) {
      throw new Error(
        `Demote chỉ đi một bậc: item "${item.label}" đang ở tầng ${item.tier}, chỉ giáng xuống ${MEMORY_TIERS[tierRank(item.tier) - 1]} được.`,
      );
    }
    if (file.items.some((i) => i.tier === targetTier && i.label === item.label && i.id !== item.id)) {
      throw new Error(`Đã có item "${item.label}" ở tầng ${targetTier} — xoá hoặc đổi label trước.`);
    }
    item.tier = targetTier;
    const ttl = tierDefaultTtlMs(targetTier);
    item.expiresAt = ttl === null ? null : new Date(Date.now() + ttl).toISOString();
    item.updatedAt = new Date().toISOString();
    this.enforceCapacity(file, targetTier);
    this.writeFile(file);
    return { ...item };
  }

  /** Xoá item. Trả false khi không có. */
  delete(idOrLabel: string, tier?: MemoryTier): boolean {
    const file = this.readFile();
    const idx = file.items.findIndex(
      (i) =>
        i.id === idOrLabel ||
        (i.label === normalizeTieredLabel(idOrLabel) && (tier === undefined || i.tier === tier)),
    );
    if (idx === -1) return false;
    file.items.splice(idx, 1);
    this.writeFile(file);
    return true;
  }

  /** Xoá mọi item đã hết hạn tại `at`. Trả số item đã xoá. */
  sweepExpired(at: Date = new Date()): number {
    const file = this.readFile();
    const before = file.items.length;
    file.items = file.items.filter((i) => !isItemExpired(i, at));
    const swept = before - file.items.length;
    if (swept > 0) this.writeFile(file);
    return swept;
  }

  /** Thống kê từng tầng: số lượng, dung lượng, số hết hạn, điểm trung bình. */
  stats(): TierStats[] {
    const file = this.readFile();
    const now = new Date();
    return MEMORY_TIERS.map((tier) => {
      const items = file.items.filter((i) => i.tier === tier);
      const expired = items.filter((i) => isItemExpired(i, now)).length;
      const avg =
        items.length === 0
          ? 0
          : items.reduce((sum, i) => sum + effectiveScore(i), 0) / items.length;
      return {
        tier,
        count: items.length,
        capacity: tierCapacity(tier),
        expiredCount: expired,
        avgScore: Math.round(avg * 10000) / 10000,
      };
    });
  }

  /**
   * Consolidation: chạy các luật thăng tầng tự động + sweep hết hạn.
   *  - working -> session: mọi item working còn hạn (hết turn).
   *  - session -> episodic: item session có điểm hiệu dụng >= 0.7.
   *  - episodic -> semantic: item episodic có điểm >= 0.7 VÀ đã được
   *    truy cập ít nhất 3 lần (tri thức đã được kiểm chứng qua dùng).
   * Không bao giờ xoá item còn hạn, không bao giờ tự hạ tầng.
   * `dryRun` chỉ tính toán, không ghi file.
   */
  consolidate(opts: { dryRun?: boolean; at?: Date } = {}): TierConsolidationReport {
    const at = opts.at ?? new Date();
    const file = this.readFile();
    const report: TierConsolidationReport = {
      ranAt: at.toISOString(),
      workingToSession: 0,
      sessionToEpisodic: 0,
      episodicToSemantic: 0,
      expiredSwept: 0,
      capacityDropped: 0,
      countsAfter: { working: 0, session: 0, episodic: 0, semantic: 0 },
    };
    const live = file.items.filter((i) => !isItemExpired(i, at));
    report.expiredSwept = file.items.length - live.length;

    const move = (item: TieredMemoryItem, to: MemoryTier): boolean => {
      if (live.some((i) => i.tier === to && i.label === item.label && i.id !== item.id)) return false;
      item.tier = to;
      item.expiresAt =
        to === 'semantic' ? null : new Date(at.getTime() + (tierDefaultTtlMs(to) ?? 0)).toISOString();
      item.updatedAt = at.toISOString();
      return true;
    };

    for (const item of live.filter((i) => i.tier === 'working')) {
      if (move(item, 'session')) report.workingToSession += 1;
    }
    for (const item of live.filter((i) => i.tier === 'session')) {
      if (effectiveScore(item) >= TIER_PROMOTE_SCORE && move(item, 'episodic')) {
        report.sessionToEpisodic += 1;
      }
    }
    for (const item of live.filter((i) => i.tier === 'episodic')) {
      if (
        effectiveScore(item) >= TIER_PROMOTE_SCORE &&
        item.accessCount >= TIER_SEMANTIC_MIN_ACCESSES &&
        move(item, 'semantic')
      ) {
        report.episodicToSemantic += 1;
      }
    }

    // Dung lượng: tầng nào vượt thì rớt item điểm thấp nhất / cũ nhất.
    for (const tier of MEMORY_TIERS) {
      const inTier = live
        .filter((i) => i.tier === tier)
        .sort((a, b) => effectiveScore(a) - effectiveScore(b) || a.updatedAt.localeCompare(b.updatedAt));
      const over = inTier.length - tierCapacity(tier);
      if (over > 0) {
        const dropIds = new Set(inTier.slice(0, over).map((i) => i.id));
        report.capacityDropped += over;
        for (let idx = live.length - 1; idx >= 0; idx -= 1) {
          if (dropIds.has(live[idx].id)) live.splice(idx, 1);
        }
      }
    }

    for (const tier of MEMORY_TIERS) {
      report.countsAfter[tier] = live.filter((i) => i.tier === tier).length;
    }
    if (!opts.dryRun && (report.expiredSwept > 0 || report.workingToSession > 0 || report.sessionToEpisodic > 0 || report.episodicToSemantic > 0 || report.capacityDropped > 0)) {
      this.writeFile({ version: 1, items: live });
    } else if (!opts.dryRun && report.expiredSwept > 0) {
      this.writeFile({ version: 1, items: live });
    }
    return report;
  }

  /**
   * Tìm kiếm keyword trên episodic (+ các tầng khác khi `tiers`
   * chỉ định): điểm = số từ khóa khớp x điểm hiệu dụng; hết hạn
   * không bao giờ trúng. `touch` ghi nhận lượt truy cập cho hit.
   */
  search(
    query: string,
    opts: { tiers?: MemoryTier[]; limit?: number; recordAccess?: boolean } = {},
  ): Array<{ item: TieredMemoryItem; score: number; matchedTerms: string[] }> {
    const terms = (query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9à-ỹđ]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const tiers = opts.tiers ?? ['episodic'];
    const file = this.readFile();
    const now = new Date();
    const hits: Array<{ item: TieredMemoryItem; score: number; matchedTerms: string[] }> = [];
    for (const item of file.items) {
      if (!tiers.includes(item.tier)) continue;
      if (isItemExpired(item, now)) continue;
      const haystack = `${item.label} ${item.content}`.toLowerCase();
      const matched = terms.filter((t) => haystack.includes(t));
      if (terms.length > 0 && matched.length === 0) continue;
      const score =
        (terms.length === 0 ? 0.5 : matched.length / terms.length) * effectiveScore(item);
      hits.push({ item: { ...item }, score: Math.round(score * 10000) / 10000, matchedTerms: matched });
    }
    hits.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
    const limit = opts.limit !== undefined ? Math.max(1, Math.min(200, Math.floor(opts.limit))) : 20;
    const top = hits.slice(0, limit);
    if (opts.recordAccess) {
      for (const hit of top) {
        try {
          this.touch(hit.item.id);
        } catch {
          // Ghi nhận lượt truy cập là best-effort, không làm hỏng search.
        }
      }
    }
    return top;
  }

  private enforceCapacity(file: TieredMemoryFile, tier: MemoryTier): void {
    const inTier = file.items
      .filter((i) => i.tier === tier)
      .sort((a, b) => effectiveScore(a) - effectiveScore(b) || a.updatedAt.localeCompare(b.updatedAt));
    const over = inTier.length - tierCapacity(tier);
    if (over <= 0) return;
    const dropIds = new Set(inTier.slice(0, over).map((i) => i.id));
    file.items = file.items.filter((i) => !dropIds.has(i.id));
  }

  private resolveItem(
    file: TieredMemoryFile,
    idOrLabel: string,
    tier?: MemoryTier,
  ): TieredMemoryItem {
    const label = normalizeTieredLabel(idOrLabel);
    const found =
      file.items.find((i) => i.id === idOrLabel) ??
      file.items.find((i) => i.label === label && (tier === undefined || i.tier === tier));
    if (!found) throw new Error(`Không tìm thấy tiered memory item "${idOrLabel}".`);
    return found;
  }
}
