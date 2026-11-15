/**
 * LLM profiles lưu sẵn (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands v1.38 LLM Profiles —
 * chỉ học ý tưởng, không copy code/text/tài sản của repo nào): user
 * lưu nhiều cấu hình LLM thành profile tái dùng, đổi ngay trong chat
 * bằng `/model` mà không cấu hình lại.
 *
 * Một profile là: provider + model + tham số gọi (temperature,
 * maxTokens) + baseUrl tùy chọn (cho provider OpenAI-compatible).
 * KHÔNG chứa API key — key vẫn nằm trong Vault như mọi provider key
 * khác; profile chỉ trỏ tới provider đã có key. Vì vậy file profile
 * an toàn để lưu plain JSON, không cần mã hóa.
 *
 * Lưu trữ: `<userData>/llm-profiles.json` (host truyền `filePath`,
 * hoặc dùng store chỉ-trong-bộ-nhớ khi không truyền). Ghi atomic
 * (file tạm + rename, mode 0600) theo quy ước của usage/usage.ts.
 * File hỏng → load() bỏ qua + warning, store chạy tiếp với profile
 * rỗng (không bao giờ crash app vì file user hỏng).
 *
 * Nối tiếp, không viết lại: `models/registry.ts` vẫn là nguồn duy
 * nhất cho TÊN model theo provider; profile chỉ lưu lựa chọn của
 * user (providerId + model id) và resolve qua registry khi host cần
 * validate model còn tồn tại. `seedFromPresets()` tạo profile mẫu từ
 * `models/presets.ts` (COMPATIBLE_PRESETS) để user mới có sẵn danh
 * sách đổi nhanh.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPATIBLE_PRESETS } from '../../models/presets';

/** Tên file profile, tương đối trong thư mục userData. */
export const LLM_PROFILES_FILE = 'llm-profiles.json';

/** Id profile: chữ thường, số, "-" — bắt đầu bằng chữ thường/số. */
export const LLM_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Độ dài tối đa của tên hiển thị. */
export const MAX_LLM_PROFILE_NAME_CHARS = 80;
/** Số profile tối đa trong một store (chống file phình vô hạn). */
export const MAX_LLM_PROFILES = 50;

/** Một cấu hình LLM đã lưu, tái dùng được. */
export interface LlmProfile {
  /** Id ổn định (dùng trong `/model <id>`). */
  id: string;
  /** Tên hiển thị (vd "Grok nhanh", "Code rẻ"). */
  name: string;
  /** Provider id (vd 'xai', 'openai', 'ollama', 'openai-compatible'). */
  providerId: string;
  /** Model id (vd 'grok-4.7', 'gpt-5-mini'). */
  model: string;
  /** Temperature (0–2) — không set = mặc định của provider. */
  temperature?: number;
  /** Max output tokens — không set = mặc định của provider. */
  maxTokens?: number;
  /** Base URL tùy chọn (chỉ dùng cho provider OpenAI-compatible). */
  baseUrl?: string;
  /** Ghi chú của user (vd "dùng cho code, rẻ"). */
  notes?: string;
  /** Thời điểm tạo / sửa lần cuối (ISO 8601). */
  createdAt: string;
  updatedAt: string;
}

/** Input khi tạo profile mới (id có thể để trống → sinh từ name). */
export interface CreateLlmProfileInput {
  id?: string;
  name: string;
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  notes?: string;
}

/** Input khi sửa profile (chỉ field nào truyền mới đổi). */
export interface UpdateLlmProfileInput {
  name?: string;
  providerId?: string;
  model?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  baseUrl?: string | null;
  notes?: string | null;
}

export class LlmProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProfileError';
  }
}

function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'profile' : slug;
}

function validateProfileFields(input: {
  name?: string;
  providerId?: string;
  model?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  baseUrl?: string | null;
}): void {
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new LlmProfileError('Tên profile không được rỗng.');
    }
    if (input.name.trim().length > MAX_LLM_PROFILE_NAME_CHARS) {
      throw new LlmProfileError(
        `Tên profile tối đa ${MAX_LLM_PROFILE_NAME_CHARS} ký tự.`,
      );
    }
  }
  if (input.providerId !== undefined) {
    if (typeof input.providerId !== 'string' || input.providerId.trim() === '') {
      throw new LlmProfileError('Profile cần providerId không rỗng.');
    }
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || input.model.trim() === '') {
      throw new LlmProfileError('Profile cần model không rỗng.');
    }
  }
  if (input.temperature !== undefined && input.temperature !== null) {
    if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
      throw new LlmProfileError('temperature phải trong khoảng 0–2.');
    }
  }
  if (input.maxTokens !== undefined && input.maxTokens !== null) {
    if (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0) {
      throw new LlmProfileError('maxTokens phải là số nguyên > 0.');
    }
  }
  if (input.baseUrl !== undefined && typeof input.baseUrl === 'string' && input.baseUrl.trim() !== '') {
    try {
      const url = new URL(input.baseUrl.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('chỉ http/https');
      }
    } catch {
      throw new LlmProfileError(`baseUrl không hợp lệ: "${input.baseUrl}".`);
    }
  }
}

function isProfileObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Store profile LLM: giữ trong bộ nhớ + persist JSON khi có filePath.
 * API: create / update / remove / get / list / setActive / active /
 * resolveActive. Mọi thay đổi chỉ đổi bộ nhớ; gọi save() để ghi đĩa
 * (giống ModelRegistry: setter không tự ghi đĩa).
 */
export class LlmProfileStore {
  private readonly profiles = new Map<string, LlmProfile>();
  private activeId: string | null = null;
  private readonly filePath?: string;
  private readonly logger?: { warn(message: string): void };
  private readonly now: () => string;

  constructor(options: {
    filePath?: string;
    logger?: { warn(message: string): void };
    now?: () => string;
  } = {}) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Nạp từ đĩa (khi có filePath). File thiếu = store rỗng; file hỏng = warning + store rỗng. */
  load(): { loaded: number; warning?: string } {
    if (!this.filePath) return { loaded: 0 };
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return { loaded: 0 };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const warning = `File profile LLM "${this.filePath}" hỏng, bỏ qua: ${(err as Error).message}`;
      this.logger?.warn(warning);
      return { loaded: 0, warning };
    }
    if (!isProfileObject(parsed)) {
      const warning = `File profile LLM "${this.filePath}" không phải object, bỏ qua.`;
      this.logger?.warn(warning);
      return { loaded: 0, warning };
    }
    const list = parsed['profiles'];
    if (!Array.isArray(list)) return { loaded: 0 };
    let loaded = 0;
    for (const entry of list) {
      if (!isProfileObject(entry)) continue;
      try {
        const profile = this.parseStoredProfile(entry);
        this.profiles.set(profile.id, profile);
        loaded += 1;
      } catch {
        // Entry hỏng thì bỏ qua, không làm hỏng cả file.
        continue;
      }
    }
    const active = parsed['activeId'];
    if (typeof active === 'string' && this.profiles.has(active)) {
      this.activeId = active;
    }
    return { loaded };
  }

  /** Ghi xuống đĩa (atomic: file tạm + rename, mode 0600). Không có filePath → trả null. */
  save(): string | null {
    if (!this.filePath) return null;
    const data = {
      version: 1,
      profiles: [...this.profiles.values()],
      ...(this.activeId !== null ? { activeId: this.activeId } : {}),
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    return this.filePath;
  }

  /** Tạo profile mới. Trùng id → LlmProfileError. */
  create(input: CreateLlmProfileInput): LlmProfile {
    validateProfileFields(input);
    const baseId =
      input.id !== undefined && input.id.trim() !== '' ? input.id.trim() : slugFromName(input.name);
    if (!LLM_PROFILE_ID_RE.test(baseId)) {
      throw new LlmProfileError(
        `Id profile "${baseId}" không hợp lệ: chỉ dùng chữ thường, số và "-" (vd "grok-nhanh").`,
      );
    }
    if (this.profiles.has(baseId)) {
      throw new LlmProfileError(`Đã có profile "${baseId}" — chọn id khác.`);
    }
    if (this.profiles.size >= MAX_LLM_PROFILES) {
      throw new LlmProfileError(`Tối đa ${MAX_LLM_PROFILES} profile — xoá bớt trước khi tạo mới.`);
    }
    const at = this.now();
    const profile: LlmProfile = {
      id: baseId,
      name: input.name.trim(),
      providerId: input.providerId.trim(),
      model: input.model.trim(),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.baseUrl !== undefined && input.baseUrl.trim() !== ''
        ? { baseUrl: input.baseUrl.trim() }
        : {}),
      ...(input.notes !== undefined && input.notes.trim() !== ''
        ? { notes: input.notes.trim() }
        : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.profiles.set(profile.id, profile);
    return { ...profile };
  }

  /** Sửa profile (field nào truyền mới đổi; null = xoá field tùy chọn). */
  update(id: string, input: UpdateLlmProfileInput): LlmProfile {
    const existing = this.profiles.get(id);
    if (!existing) throw new LlmProfileError(`Không có profile "${id}".`);
    validateProfileFields(input);
    const updated: LlmProfile = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId.trim() } : {}),
      ...(input.model !== undefined ? { model: input.model.trim() } : {}),
      ...(input.temperature !== undefined
        ? input.temperature === null
          ? { temperature: undefined }
          : { temperature: input.temperature }
        : {}),
      ...(input.maxTokens !== undefined
        ? input.maxTokens === null
          ? { maxTokens: undefined }
          : { maxTokens: input.maxTokens }
        : {}),
      ...(input.baseUrl !== undefined
        ? input.baseUrl === null || input.baseUrl.trim() === ''
          ? { baseUrl: undefined }
          : { baseUrl: input.baseUrl.trim() }
        : {}),
      ...(input.notes !== undefined
        ? input.notes === null || input.notes.trim() === ''
          ? { notes: undefined }
          : { notes: input.notes.trim() }
        : {}),
      updatedAt: this.now(),
    };
    // Xoá key undefined để JSON lưu sạch (tránh "temperature": undefined).
    if (updated.temperature === undefined) delete updated.temperature;
    if (updated.maxTokens === undefined) delete updated.maxTokens;
    if (updated.baseUrl === undefined) delete updated.baseUrl;
    if (updated.notes === undefined) delete updated.notes;
    this.profiles.set(id, updated);
    return { ...updated };
  }

  /** Xoá profile. Xoá profile đang active thì active trở về null. */
  remove(id: string): boolean {
    const removed = this.profiles.delete(id);
    if (removed && this.activeId === id) this.activeId = null;
    return removed;
  }

  /** Lấy một profile (bản copy) hoặc undefined. */
  get(id: string): LlmProfile | undefined {
    const found = this.profiles.get(id);
    return found === undefined ? undefined : { ...found };
  }

  /** Mọi profile, theo thứ tự tạo (id → tên). */
  list(): LlmProfile[] {
    return [...this.profiles.values()].map((p) => ({ ...p }));
  }

  /** Số profile đang có. */
  get count(): number {
    return this.profiles.size;
  }

  /** Đặt profile active (dùng cho turn tiếp theo). Id không tồn tại → lỗi. */
  setActive(id: string): LlmProfile {
    const profile = this.profiles.get(id);
    if (!profile) throw new LlmProfileError(`Không có profile "${id}" — gõ /model để xem danh sách.`);
    this.activeId = id;
    return { ...profile };
  }

  /** Bỏ active (quay về model mặc định của bot). */
  clearActive(): void {
    this.activeId = null;
  }

  /** Profile đang active (undefined khi chưa chọn). */
  active(): LlmProfile | undefined {
    return this.activeId === null ? undefined : this.get(this.activeId);
  }

  /** Id profile đang active (null khi chưa chọn). */
  get activeProfileId(): string | null {
    return this.activeId;
  }

  /**
   * Tạo profile mẫu từ COMPATIBLE_PRESETS (preset OpenAI-compatible)
   * + 2 profile provider chính (xAI, Ollama local). Chỉ tạo những id
   * chưa có (gọi 2 lần không nhân đôi). Trả số profile đã tạo mới.
   */
  seedFromPresets(): number {
    const seeds: CreateLlmProfileInput[] = [
      { id: 'grok-nhanh', name: 'Grok nhanh', providerId: 'xai', model: 'grok-4.1-fast' },
      { id: 'local', name: 'Local (Ollama)', providerId: 'ollama', model: 'llama3.1' },
      ...COMPATIBLE_PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.label,
        providerId: 'openai-compatible',
        model: preset.defaultModel,
        baseUrl: preset.baseUrl,
      })),
    ];
    let created = 0;
    for (const seed of seeds) {
      if (seed.id !== undefined && this.profiles.has(seed.id)) continue;
      try {
        this.create(seed);
        created += 1;
      } catch {
        continue;
      }
    }
    return created;
  }

  private parseStoredProfile(entry: Record<string, unknown>): LlmProfile {
    const id = entry['id'];
    const name = entry['name'];
    const providerId = entry['providerId'];
    const model = entry['model'];
    if (
      typeof id !== 'string' ||
      !LLM_PROFILE_ID_RE.test(id) ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof providerId !== 'string' ||
      providerId.trim() === '' ||
      typeof model !== 'string' ||
      model.trim() === ''
    ) {
      throw new LlmProfileError('Entry profile thiếu id/name/providerId/model hợp lệ.');
    }
    const createdAt = typeof entry['createdAt'] === 'string' ? entry['createdAt'] : this.now();
    const updatedAt = typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : createdAt;
    const profile: LlmProfile = {
      id,
      name: name.trim(),
      providerId: providerId.trim(),
      model: model.trim(),
      createdAt,
      updatedAt,
    };
    if (typeof entry['temperature'] === 'number') profile.temperature = entry['temperature'];
    if (typeof entry['maxTokens'] === 'number') profile.maxTokens = entry['maxTokens'];
    if (typeof entry['baseUrl'] === 'string' && entry['baseUrl'].trim() !== '') {
      profile.baseUrl = entry['baseUrl'].trim();
    }
    if (typeof entry['notes'] === 'string' && entry['notes'].trim() !== '') {
      profile.notes = entry['notes'].trim();
    }
    validateProfileFields(profile);
    return profile;
  }
}
