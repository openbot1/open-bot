/**
 * Local agent registry kiểu AGNTCY, v1.07 Đội T3.
 *
 * AGNTCY (Cisco Outshift, donate Linux Foundation 07/2025) là tầng
 * discovery/identity/messaging/observability cho hệ multi-agent:
 * agent đăng ký "tôi là ai, tôi làm được gì" vào một registry, agent
 * khác tìm theo capability rồi mới gọi. open-bot trước đây KHÔNG có
 * tầng này cho A2A: client chỉ biết agent khi user gõ URL tay
 * (`a2a_discover`) hoặc khi user trust trước (`a2a_list_agents`).
 * Module này thêm registry CHẠY LOCAL (không server ngoài, không
 * gửi gì đi đâu):
 *
 *  - `register(card, opts)` — ghi một agent (card đã validate) vào
 *    registry, kèm nguồn (`local` = agent trên máy này, `discovered`
 *    = tìm thấy qua well-known, `manual` = user nhập tay).
 *  - `registerFromUrl(baseUrl, opts)` — fetch card qua well-known
 *    rồi đăng ký (verify chữ ký nếu card có ký).
 *  - `search(query, filters)` — tìm theo tên/mô tả/skill/tag, chấm
 *    điểm relevance (khớp tên/skill id nặng hơn mô tả), lọc theo
 *    capability (streaming, push) và trạng thái trust.
 *  - `healthCheckAll()` — fetch lại card từng agent, cập nhật
 *    `health` (`ok` / `unreachable` / `invalid-card`) + `lastSeenAt`.
 *  - TTL: entry có `expiresAt` thì `pruneExpired()` dọn (agent
 *    local tự đăng ký với TTL ngắn; agent manual không hết hạn).
 *  - Persistence: file JSON (`a2a-registry.json`, ghi atomic tmp +
 *    rename, mode 0600) — restart app không mất danh sách.
 *
 * Trust: registry KHÔNG tin tưởng agent — `trusted` chỉ là cờ do
 * user đặt qua UI (giống trusted-agent store của `a2aTools.ts`).
 * Tool `a2a_send` vẫn chỉ gọi agent đã trust; registry chỉ giúp
 * TÌM agent để user xem rồi quyết định trust.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fetchAgentCard } from './client';
import { verifyAgentCardSignature } from './signing';
import { validateAgentCard } from './card';
import type { A2aAgentCard } from './types';

/** Tên file registry mặc định dưới userData. */
export const A2A_REGISTRY_FILE_NAME = 'a2a-registry.json';

/** Phiên bản format file registry (để migrate sau này). */
export const A2A_REGISTRY_FILE_VERSION = 1;

/** Agent tới registry bằng đường nào. */
export type A2aRegistrySource = 'local' | 'discovered' | 'manual';

/** Trạng thái sức khoẻ của một agent trong registry. */
export type A2aRegistryHealth = 'unknown' | 'ok' | 'unreachable' | 'invalid-card';

/** Một agent đã đăng ký trong registry local. */
export interface A2aRegistryEntry {
  /** URL gốc đã chuẩn hoá (không trailing slash) — key duy nhất. */
  baseUrl: string;
  /** Agent Card đã validate (bản mới nhất từng fetch được). */
  card: A2aAgentCard;
  /** Agent tới registry bằng đường nào. */
  source: A2aRegistrySource;
  /** ISO-8601 lúc đăng ký lần đầu. */
  registeredAt: string;
  /** ISO-8601 lần cuối thấy agent trả lời (fetch card thành công). */
  lastSeenAt: string | null;
  /** ISO-8601 lần cuối chạy health check (null = chưa check). */
  lastHealthAt: string | null;
  /** Kết quả health check gần nhất. */
  health: A2aRegistryHealth;
  /**
   * Chữ ký card lần cuối verify: true = ký đúng, false = ký sai /
   * keyId lệch, null = card không có chữ ký (agent cũ / chưa ký).
   */
  signatureOk: boolean | null;
  /** Fingerprint key đã ký (null khi card không ký). */
  keyId: string | null;
  /** User đã tin tưởng agent này (quyết định ở UI, không phải model). */
  trusted: boolean;
  /** ISO-8601 khi entry hết hạn (null = không hết hạn). */
  expiresAt: string | null;
}

/** Input khi đăng ký một agent đã có card sẵn. */
export interface A2aRegistryRegisterInput {
  baseUrl: string;
  card: A2aAgentCard;
  source?: A2aRegistrySource;
  /** TTL ms từ lúc đăng ký (vd agent local tự đăng ký 1h); 0 = không hết hạn. */
  ttlMs?: number;
  /** Giữ cờ trusted cũ khi đăng ký lại (mặc định true — đăng ký lại không untrust). */
  keepTrusted?: boolean;
}

/** Bộ lọc cho `search`. */
export interface A2aRegistrySearchFilters {
  /** Chỉ agent có skill id này. */
  skillId?: string;
  /** Chỉ agent hỗ trợ streaming. */
  streaming?: boolean;
  /** Chỉ agent hỗ trợ push notifications. */
  pushNotifications?: boolean;
  /** Chỉ agent user đã trust (true) hoặc chưa trust (false). */
  trusted?: boolean;
  /** Chỉ agent khoẻ (`ok`) hoặc mọi trạng thái (mặc định mọi trạng thái). */
  healthyOnly?: boolean;
}

/** Một kết quả tìm kiếm kèm điểm relevance. */
export interface A2aRegistrySearchResult {
  entry: A2aRegistryEntry;
  /** Điểm relevance (cao = khớp tốt hơn). */
  score: number;
  /** Vì sao khớp (vd ['name', 'skill:chat']). */
  matchedOn: string[];
}

/** Options của registry. */
export interface A2aAgentRegistryOptions {
  /** Đường dẫn file JSON persistence (không truyền = chỉ bộ nhớ). */
  filePath?: string;
  /** Hàm lấy thời gian (cho test ép giờ). */
  now?: () => Date;
}

interface RegistryFileShape {
  version: number;
  entries: A2aRegistryEntry[];
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Registry baseUrl must not be empty.');
  return trimmed.replace(/\/+$/, '');
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_àáâãèéêìíòóôõùúăđĩũơưạảấầẩẫậắằẳẵặẹẻẽềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Chấm điểm một entry với query: khớp tên agent +5/token, khớp skill
 * id +4, khớp skill name +3, khớp tag +3, khớp mô tả +1. Query rỗng
 * → mọi entry đều khớp với điểm 0 (liệt kê).
 */
function scoreEntry(entry: A2aRegistryEntry, queryTokens: string[]): { score: number; matchedOn: string[] } {
  if (queryTokens.length === 0) return { score: 0, matchedOn: [] };
  const matchedOn: string[] = [];
  let score = 0;
  const nameTokens = new Set(tokenize(entry.card.name));
  const descTokens = new Set(tokenize(entry.card.description));
  const skillIdTokens = new Set<string>();
  const skillNameTokens = new Set<string>();
  const tagTokens = new Set<string>();
  for (const skill of entry.card.skills ?? []) {
    tokenize(skill.id).forEach((t) => skillIdTokens.add(t));
    tokenize(skill.name).forEach((t) => skillNameTokens.add(t));
    for (const tag of skill.tags ?? []) tokenize(tag).forEach((t) => tagTokens.add(t));
  }
  for (const token of queryTokens) {
    let hit = false;
    if (nameTokens.has(token)) {
      score += 5;
      matchedOn.push('name');
      hit = true;
    }
    if (skillIdTokens.has(token)) {
      score += 4;
      matchedOn.push(`skill:${token}`);
      hit = true;
    }
    if (skillNameTokens.has(token)) {
      score += 3;
      matchedOn.push(`skill-name:${token}`);
      hit = true;
    }
    if (tagTokens.has(token)) {
      score += 3;
      matchedOn.push(`tag:${token}`);
      hit = true;
    }
    if (descTokens.has(token)) {
      score += 1;
      matchedOn.push('description');
      hit = true;
    }
    // Khớp một phần (substring) trong tên/skill id: vẫn tính nhưng nhẹ.
    if (!hit) {
      const haystacks = [entry.card.name, ...(entry.card.skills ?? []).map((s) => s.id)];
      if (haystacks.some((h) => h.toLowerCase().includes(token))) {
        score += 1;
        matchedOn.push('partial');
      }
    }
  }
  return { score, matchedOn: [...new Set(matchedOn)] };
}

function entryMatchesFilters(entry: A2aRegistryEntry, filters: A2aRegistrySearchFilters): boolean {
  if (filters.skillId !== undefined) {
    const wanted = filters.skillId.trim().toLowerCase();
    if (!(entry.card.skills ?? []).some((s) => s.id.toLowerCase() === wanted)) return false;
  }
  if (filters.streaming === true && entry.card.capabilities?.streaming !== true) return false;
  if (filters.pushNotifications === true && entry.card.capabilities?.pushNotifications !== true) return false;
  if (filters.trusted !== undefined && entry.trusted !== filters.trusted) return false;
  if (filters.healthyOnly === true && entry.health !== 'ok') return false;
  return true;
}

/**
 * Registry agent local kiểu AGNTCY: đăng ký / tìm / kiểm tra sức
 * khoẻ agent A2A trên máy này (và agent ngoài mà user đã biết).
 * Mọi thay đổi đều persist xuống file khi có `filePath`.
 */
export class A2aAgentRegistry {
  private readonly entries = new Map<string, A2aRegistryEntry>();
  private readonly filePath: string | undefined;
  private readonly nowFn: () => Date;

  constructor(options: A2aAgentRegistryOptions = {}) {
    this.filePath = options.filePath;
    this.nowFn = options.now ?? (() => new Date());
    if (this.filePath) this.loadFromFile();
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  /** Số agent trong registry. */
  get size(): number {
    return this.entries.size;
  }

  /** Đăng ký (hoặc cập nhật) một agent từ card đã có. */
  register(input: A2aRegistryRegisterInput): A2aRegistryEntry {
    const problems = validateAgentCard(input.card);
    if (problems.length > 0) {
      throw new Error(`Cannot register an invalid Agent Card: ${problems.join('; ')}`);
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const now = this.nowIso();
    const previous = this.entries.get(baseUrl);
    const verification = verifyAgentCardSignature(input.card as unknown as Record<string, unknown>);
    const ttlMs = input.ttlMs ?? 0;
    const entry: A2aRegistryEntry = {
      baseUrl,
      card: input.card,
      source: input.source ?? 'manual',
      registeredAt: previous?.registeredAt ?? now,
      lastSeenAt: now,
      lastHealthAt: previous?.lastHealthAt ?? null,
      health: previous?.health ?? 'unknown',
      signatureOk: verification.unsigned ? null : verification.ok,
      keyId: verification.keyId,
      trusted: input.keepTrusted === false ? false : (previous?.trusted ?? false),
      expiresAt:
        ttlMs > 0 ? new Date(this.nowFn().getTime() + ttlMs).toISOString() : (previous?.expiresAt ?? null),
    };
    this.entries.set(baseUrl, entry);
    this.saveToFile();
    return entry;
  }

  /**
   * Đăng ký một agent bằng URL: fetch card qua well-known
   * (`/.well-known/agent-card.json`, fallback `/.well-known/agent.json`
   * — xem `client.ts`), validate rồi đăng ký. Lỗi fetch/validate
   * thành throw rõ ràng (caller báo cho user).
   */
  async registerFromUrl(
    baseUrl: string,
    options: { source?: A2aRegistrySource; timeoutMs?: number; ttlMs?: number } = {},
  ): Promise<A2aRegistryEntry> {
    const normalized = normalizeBaseUrl(baseUrl);
    const card = await fetchAgentCard(normalized, { timeoutMs: options.timeoutMs });
    return this.register({ baseUrl: normalized, card, source: options.source ?? 'discovered', ttlMs: options.ttlMs });
  }

  /** Xoá một agent khỏi registry. Trả true khi đã có để xoá. */
  deregister(baseUrl: string): boolean {
    const removed = this.entries.delete(normalizeBaseUrl(baseUrl));
    if (removed) this.saveToFile();
    return removed;
  }

  /** Lấy một entry theo baseUrl (undefined khi chưa đăng ký). */
  get(baseUrl: string): A2aRegistryEntry | undefined {
    return this.entries.get(normalizeBaseUrl(baseUrl));
  }

  /** Mọi entry, mới đăng ký trước. */
  list(): A2aRegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  }

  /** Đánh dấu user trust / untrust một agent (quyết định của user). */
  setTrusted(baseUrl: string, trusted: boolean): A2aRegistryEntry {
    const entry = this.entries.get(normalizeBaseUrl(baseUrl));
    if (!entry) throw new Error(`Agent ${baseUrl} is not in the registry.`);
    entry.trusted = trusted;
    this.saveToFile();
    return entry;
  }

  /**
   * Tìm agent: query text (tên/mô tả/skill/tag) + bộ lọc capability.
   * Kết quả xếp theo điểm relevance giảm dần, hoà thì agent mới
   * đăng ký trước. Query rỗng + không filter = liệt kê toàn bộ.
   */
  search(query = '', filters: A2aRegistrySearchFilters = {}): A2aRegistrySearchResult[] {
    const tokens = tokenize(query);
    const results: A2aRegistrySearchResult[] = [];
    for (const entry of this.entries.values()) {
      if (!entryMatchesFilters(entry, filters)) continue;
      const { score, matchedOn } = scoreEntry(entry, tokens);
      if (tokens.length > 0 && score <= 0) continue;
      results.push({ entry, score, matchedOn });
    }
    results.sort((a, b) => b.score - a.score || b.entry.registeredAt.localeCompare(a.entry.registeredAt));
    return results;
  }

  /** Liệt kê skill id của mọi agent (để UI gợi ý filter). */
  listSkillIds(): string[] {
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      for (const skill of entry.card.skills ?? []) ids.add(skill.id);
    }
    return [...ids].sort();
  }

  /**
   * Xoá entry đã hết hạn (`expiresAt` đã qua). Trả số entry đã xoá.
   * Agent manual không có expiresAt nên không bao giờ bị dọn.
   */
  pruneExpired(now: Date = this.nowFn()): number {
    let removed = 0;
    for (const [baseUrl, entry] of this.entries) {
      if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= now.getTime()) {
        this.entries.delete(baseUrl);
        removed++;
      }
    }
    if (removed > 0) this.saveToFile();
    return removed;
  }

  /**
   * Health check toàn bộ registry: fetch lại card từng agent.
   * - Fetch được + card hợp lệ → health `ok`, `lastSeenAt` mới,
   *   card trong entry cập nhật theo bản mới nhất.
   * - Fetch lỗi (agent tắt) → `unreachable` (giữ card cũ).
   * - Fetch được nhưng card hỏng → `invalid-card`.
   * Trả số agent ok / tổng số. Không throw vì một agent chết.
   */
  async healthCheckAll(options: { timeoutMs?: number } = {}): Promise<{ ok: number; total: number }> {
    let ok = 0;
    for (const entry of this.entries.values()) {
      const now = this.nowIso();
      entry.lastHealthAt = now;
      try {
        const card = await fetchAgentCard(entry.baseUrl, { timeoutMs: options.timeoutMs });
        const problems = validateAgentCard(card);
        if (problems.length > 0) {
          entry.health = 'invalid-card';
        } else {
          entry.health = 'ok';
          entry.card = card;
          entry.lastSeenAt = now;
          const verification = verifyAgentCardSignature(card as unknown as Record<string, unknown>);
          entry.signatureOk = verification.unsigned ? null : verification.ok;
          entry.keyId = verification.keyId;
          ok++;
        }
      } catch {
        entry.health = 'unreachable';
      }
    }
    this.saveToFile();
    return { ok, total: this.entries.size };
  }

  /** Xoá toàn bộ registry (test / reset). */
  clear(): void {
    this.entries.clear();
    this.saveToFile();
  }

  // -- Persistence (file JSON, ghi atomic) -------------------------------

  private loadFromFile(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }
    if (raw.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`A2A registry file is not valid JSON: ${this.filePath}`);
    }
    const shape = parsed as RegistryFileShape;
    if (typeof shape !== 'object' || shape === null || !Array.isArray(shape.entries)) {
      throw new Error(`A2A registry file has a bad shape: ${this.filePath}`);
    }
    for (const entry of shape.entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as A2aRegistryEntry;
      if (typeof e.baseUrl !== 'string' || validateAgentCard(e.card).length > 0) continue;
      this.entries.set(normalizeBaseUrl(e.baseUrl), { ...e, baseUrl: normalizeBaseUrl(e.baseUrl) });
    }
  }

  private saveToFile(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const shape: RegistryFileShape = { version: A2A_REGISTRY_FILE_VERSION, entries: this.list() };
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(shape, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Best-effort.
      }
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // File tạm có thể chưa được tạo.
      }
      throw err;
    }
  }
}

/** Tạo registry mới (helper ngắn cho caller không muốn `new`). */
export function createA2aAgentRegistry(options: A2aAgentRegistryOptions = {}): A2aAgentRegistry {
  return new A2aAgentRegistry(options);
}
