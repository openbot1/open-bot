/**
 * Agent Profiles (v1.11, Đội T2).
 *
 * Ý TƯỞNG mượn từ OpenHands 1.40 "Agent Profiles": một profile là
 * preset (model + tools + system prompt + turn budget) theo loại
 * task — user chọn profile thay vì chỉnh từng thứ. Khi self-hosted
 * (không bật profiles), profile vẫn cho model mặc định để model
 * picker có cái mà dùng.
 *
 * Profile gồm:
 *  - `kind`: coding / research / writing / review / general / data
 *  - `model`: `{ provider, model }` — model rỗng nghĩa là "dùng
 *    model mặc định của provider đó trong ModelRegistry"
 *  - `tools`: allow-list tên tool (rỗng = mọi tool); `denyTools`
 *    chặn thêm tool nguy hiểm cho loại task đó
 *  - `systemPrompt`: system prompt của profile, ghép trước system
 *    prompt của bot khi chạy task
 *  - `turnBudget` / `maxTokensPerTurn`: giới hạn gợi ý cho runner
 *  - `enabled`: tắt profile thì model picker và runner bỏ qua nó
 *
 * 6 profile builtin: coding, research, writing, review, general,
 * data. User có thể thêm/sửa/xoá profile riêng — lưu file JSON
 * `<userData>/agent-profiles.json` (chỉ lưu phần user thay đổi:
 * profile custom + ghi đè builtin; builtin gốc không bao giờ bị
 * ghi đè trên đĩa). Store này chạy hoàn toàn local, không gọi mạng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ModelRegistry } from '../models/registry';
import type { HarborTaskKind } from './harborTask';

/** Loại task mà profile phục vụ (trùng HarborTaskKind + `data`). */
export type AgentProfileKind = HarborTaskKind | 'data';

export const AGENT_PROFILE_KINDS: readonly AgentProfileKind[] = [
  'coding',
  'research',
  'writing',
  'review',
  'general',
  'data',
];

export const AGENT_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Một Agent Profile. */
export interface AgentProfile {
  /** Id ổn định (vd `coding`). */
  id: string;
  /** Tên hiển thị. */
  label: string;
  /** Loại task profile này phục vụ. */
  kind: AgentProfileKind;
  /** Mô tả một dòng. */
  description: string;
  /** Provider mặc định của profile (vd `ollama`, `xai`, `gemini`). */
  provider: string;
  /**
   * Model mặc định của profile. Chuỗi rỗng = "dùng model mặc định
   * của provider trong ModelRegistry" (đường self-hosted).
   */
  model: string;
  /** Allow-list tên tool; rỗng = không giới hạn tool theo profile. */
  tools: string[];
  /** Tool bị chặn thêm dù có trong allow-list (vd tool ghi file với profile research). */
  denyTools: string[];
  /** System prompt của profile (ghép trước system prompt của bot). */
  systemPrompt: string;
  /** Số turn tối đa gợi ý khi chạy bằng profile này. */
  turnBudget: number;
  /** Token tối đa gợi ý cho một turn (0 = không giới hạn). */
  maxTokensPerTurn: number;
  /** Profile tắt thì picker/runner bỏ qua. */
  enabled: boolean;
  /** True khi là profile builtin (không xoá được, chỉ ghi đè được). */
  builtin: boolean;
}

/** Ghi đè của user lên một profile builtin, hoặc một profile custom. */
export type AgentProfileOverride = Partial<Omit<AgentProfile, 'id' | 'builtin'>> & { id: string };

export const AGENT_PROFILES_FILE = 'agent-profiles.json';

/** System prompt mặc định cho từng kind (ngắn, gợi ý hành vi, không ép model). */
const KIND_SYSTEM_PROMPTS: Record<AgentProfileKind, string> = {
  coding: [
    'You are a careful coding agent. Read the task and the existing code before changing anything.',
    'Make the smallest change that satisfies the task, keep public APIs stable, and verify with the available tests before finishing.',
    'Never invent dependencies or network calls; prefer tools already available in the workspace.',
  ].join(' '),
  research: [
    'You are a thorough research agent. Prefer primary sources, quote numbers with their source, and say clearly when evidence is missing.',
    'Never browse outside the allowed tools, never fabricate citations, and separate facts from your own inference in the final answer.',
  ].join(' '),
  writing: [
    'You are a clear writing agent. Write in the language the task asks for, keep structure scannable (headings, short paragraphs, lists), and stay faithful to the facts given.',
    'Do not invent quotes, names, or numbers; mark anything uncertain as uncertain.',
  ].join(' '),
  review: [
    'You are a strict but fair reviewer. Check correctness first, then clarity, security, and maintainability.',
    'Report every real issue with file and line when known, suggest a concrete fix, and do not approve work that still fails its tests.',
  ].join(' '),
  general: [
    'You are a helpful general-purpose agent. Clarify only when the task is genuinely ambiguous, otherwise do the task completely and report what changed.',
  ].join(' '),
  data: [
    'You are a careful data agent. Never modify source data in place without an explicit instruction; write derived results to a new file.',
    'Validate numbers by recomputing them a second way when the task depends on arithmetic, and report the method used.',
  ].join(' '),
};

/** Tool mặc định cho từng kind (allow-list; rỗng = mọi tool). */
const KIND_TOOLS: Record<AgentProfileKind, string[]> = {
  coding: ['read_file', 'write_file', 'list_files', 'shell_exec', 'git_status', 'git_diff'],
  research: ['web_search', 'web_fetch', 'read_file', 'write_file', 'list_files'],
  writing: ['read_file', 'write_file', 'list_files'],
  review: ['read_file', 'list_files', 'git_status', 'git_diff', 'shell_exec'],
  general: [],
  data: ['read_file', 'write_file', 'list_files', 'shell_exec'],
};

/** Tool bị chặn thêm theo kind (dù allow-list có chứa). */
const KIND_DENY_TOOLS: Record<AgentProfileKind, string[]> = {
  coding: [],
  research: ['shell_exec', 'git_commit'],
  writing: ['shell_exec', 'git_commit'],
  review: ['write_file', 'git_commit'],
  general: [],
  data: ['git_commit'],
};

function builtinProfile(
  id: string,
  kind: AgentProfileKind,
  label: string,
  description: string,
  provider: string,
  model: string,
  turnBudget: number,
): AgentProfile {
  return {
    id,
    label,
    kind,
    description,
    provider,
    model,
    tools: [...KIND_TOOLS[kind]],
    denyTools: [...KIND_DENY_TOOLS[kind]],
    systemPrompt: KIND_SYSTEM_PROMPTS[kind],
    turnBudget,
    maxTokensPerTurn: 0,
    enabled: true,
    builtin: true,
  };
}

/** 6 profile builtin, thứ tự ổn định. */
export function builtinAgentProfiles(): AgentProfile[] {
  return [
    builtinProfile('coding', 'coding', 'Coding', 'Viết và sửa code, chạy test để kiểm chứng.', 'ollama', '', 30),
    builtinProfile('research', 'research', 'Research', 'Tìm hiểu, tổng hợp nguồn, trích dẫn rõ ràng.', 'ollama', '', 25),
    builtinProfile('writing', 'writing', 'Writing', 'Viết tài liệu, báo cáo, nội dung rõ ràng.', 'ollama', '', 20),
    builtinProfile('review', 'review', 'Review', 'Rà soát code/tài liệu, chỉ ra lỗi và cách sửa.', 'ollama', '', 20),
    builtinProfile('general', 'general', 'General', 'Task chung, không thuộc loại chuyên biệt.', 'ollama', '', 20),
    builtinProfile('data', 'data', 'Data', 'Tính toán, xử lý dữ liệu, xuất kết quả ra file mới.', 'ollama', '', 25),
  ];
}

export function getBuiltinAgentProfile(id: string): AgentProfile | undefined {
  return builtinAgentProfiles().find((p) => p.id === id);
}

export function isAgentProfileKind(value: unknown): value is AgentProfileKind {
  return typeof value === 'string' && (AGENT_PROFILE_KINDS as readonly string[]).includes(value);
}

export function isAgentProfileId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_PROFILE_ID_RE.test(value);
}

/** Lỗi validate profile — message cụ thể để UI/tool báo rõ. */
export class AgentProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProfileError';
  }
}

/** Validate một profile (builtin hay custom đều dùng chung). */
export function validateAgentProfile(profile: unknown): string[] {
  const errors: string[] = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return ['profile phải là một object.'];
  }
  const p = profile as Record<string, unknown>;
  if (!isAgentProfileId(p['id'])) errors.push('id phải là chuỗi chữ thường/số/`-`/`_` (vd "coding").');
  if (typeof p['label'] !== 'string' || p['label'].trim() === '') errors.push('label phải là chuỗi không rỗng.');
  if (!isAgentProfileKind(p['kind'])) errors.push(`kind phải là một trong: ${AGENT_PROFILE_KINDS.join(', ')}.`);
  if (typeof p['description'] !== 'string' || p['description'].trim() === '') errors.push('description phải là chuỗi không rỗng.');
  if (typeof p['provider'] !== 'string' || p['provider'].trim() === '') errors.push('provider phải là chuỗi không rỗng.');
  if (typeof p['model'] !== 'string') errors.push('model phải là chuỗi (rỗng = dùng model mặc định của provider).');
  if (!Array.isArray(p['tools']) || p['tools'].some((t) => typeof t !== 'string' || t.trim() === '')) {
    errors.push('tools phải là mảng tên tool (chuỗi không rỗng).');
  }
  if (!Array.isArray(p['denyTools']) || p['denyTools'].some((t) => typeof t !== 'string' || t.trim() === '')) {
    errors.push('denyTools phải là mảng tên tool (chuỗi không rỗng).');
  }
  if (Array.isArray(p['tools']) && Array.isArray(p['denyTools'])) {
    const overlap = (p['tools'] as string[]).filter((t) => (p['denyTools'] as string[]).includes(t));
    if (overlap.length > 0) errors.push(`tool vừa allow vừa deny: ${overlap.join(', ')}.`);
  }
  if (typeof p['systemPrompt'] !== 'string' || p['systemPrompt'].trim() === '') {
    errors.push('systemPrompt phải là chuỗi không rỗng.');
  }
  if (typeof p['turnBudget'] !== 'number' || !Number.isInteger(p['turnBudget']) || (p['turnBudget'] as number) < 1 || (p['turnBudget'] as number) > 200) {
    errors.push('turnBudget phải là số nguyên trong [1, 200].');
  }
  if (typeof p['maxTokensPerTurn'] !== 'number' || !Number.isInteger(p['maxTokensPerTurn']) || (p['maxTokensPerTurn'] as number) < 0) {
    errors.push('maxTokensPerTurn phải là số nguyên >= 0 (0 = không giới hạn).');
  }
  if (typeof p['enabled'] !== 'boolean') errors.push('enabled phải là boolean.');
  return errors;
}

/**
 * Lọc tool theo profile: tool trong denyTools luôn bị loại; khi
 * allow-list không rỗng thì chỉ giữ tool có trong allow-list.
 * Trả về danh sách tên tool còn lại (giữ nguyên thứ tự đầu vào).
 */
export function filterToolsForProfile(profile: AgentProfile, toolNames: readonly string[]): string[] {
  const denied = new Set(profile.denyTools);
  const allowed = profile.tools.length > 0 ? new Set(profile.tools) : null;
  return toolNames.filter((name) => {
    if (denied.has(name)) return false;
    if (allowed !== null && !allowed.has(name)) return false;
    return true;
  });
}

/**
 * Ghép system prompt: system prompt của profile đứng trước system
 * prompt của bot (profile định hướng hành vi, bot giữ ngữ cảnh).
 * Bot prompt rỗng thì chỉ còn profile prompt.
 */
export function buildProfileSystemPrompt(profile: AgentProfile, botSystemPrompt: string): string {
  const bot = (botSystemPrompt ?? '').trim();
  if (bot === '') return profile.systemPrompt;
  return `${profile.systemPrompt}\n\n${bot}`;
}

/**
 * Resolve model thật cho một profile:
 *  1. profile.model khác rỗng → dùng luôn;
 *  2. có ModelRegistry → registry.getDefault(provider);
 *  3. không có gì → chuỗi rỗng (caller tự quyết định fallback).
 * Không throw khi registry thiếu model — trả rỗng để caller báo rõ.
 */
export function resolveProfileModel(
  profile: AgentProfile,
  registry?: Pick<ModelRegistry, 'getDefault'>,
): { provider: string; model: string } {
  if (profile.model.trim() !== '') return { provider: profile.provider, model: profile.model };
  if (registry) {
    try {
      const model = registry.getDefault(profile.provider);
      if (typeof model === 'string' && model.trim() !== '') return { provider: profile.provider, model };
    } catch {
      // Registry chưa có provider này — rơi xuống rỗng, caller báo rõ.
    }
  }
  return { provider: profile.provider, model: '' };
}

/**
 * Chọn profile cho một task: ưu tiên profile cùng kind và đang
 * enabled; không có thì profile `general` (nếu enabled); cuối cùng
 * là profile enabled đầu tiên. Trả undefined khi không còn profile
 * enabled nào (store rỗng do user tắt hết).
 */
export function profileForTaskKind(
  profiles: readonly AgentProfile[],
  kind: AgentProfileKind,
): AgentProfile | undefined {
  const enabled = profiles.filter((p) => p.enabled);
  return (
    enabled.find((p) => p.kind === kind) ??
    enabled.find((p) => p.id === 'general') ??
    enabled[0]
  );
}

/** File user overrides của Agent Profiles (ghi đè builtin + custom). */
export interface AgentProfileStoreFile {
  version: 1;
  /** Ghi đè từng field của profile builtin (key = id). */
  overrides: Record<string, AgentProfileOverride>;
  /** Profile do user tự tạo (id không trùng builtin). */
  custom: AgentProfile[];
}

export function defaultAgentProfileStoreFile(): AgentProfileStoreFile {
  return { version: 1, overrides: {}, custom: [] };
}

/**
 * Store profile: builtin + file overrides/custom. Đọc file lười
 * (lazy): lần đầu gọi list/get mới đọc đĩa; file hỏng thì dùng
 * builtin và ghi lại lần save sau (không throw khi load).
 */
export class AgentProfileStore {
  private readonly filePath: string;
  private loaded = false;
  private file: AgentProfileStoreFile = defaultAgentProfileStoreFile();

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, AGENT_PROFILES_FILE);
  }

  /** Đường dẫn file store (để test/UI kiểm tra). */
  get path(): string {
    return this.filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const raw = parsed as Partial<AgentProfileStoreFile>;
      if (raw.version !== 1) return;
      if (raw.overrides && typeof raw.overrides === 'object') {
        for (const [id, override] of Object.entries(raw.overrides)) {
          if (override && typeof override === 'object') this.file.overrides[id] = override as AgentProfileOverride;
        }
      }
      if (Array.isArray(raw.custom)) {
        this.file.custom = raw.custom.filter((p) => validateAgentProfile(p).length === 0) as AgentProfile[];
      }
    } catch {
      // File hỏng: giữ builtin, lần save sau ghi đè file sạch.
      this.file = defaultAgentProfileStoreFile();
    }
  }

  /** Toàn bộ profile hiệu lực (builtin đã merge override + custom). */
  list(): AgentProfile[] {
    this.ensureLoaded();
    const out: AgentProfile[] = builtinAgentProfiles().map((base) => {
      const override = this.file.overrides[base.id];
      if (!override) return base;
      const merged: AgentProfile = { ...base, ...override, id: base.id, builtin: true };
      return validateAgentProfile(merged).length === 0 ? merged : base;
    });
    for (const custom of this.file.custom) {
      if (!out.some((p) => p.id === custom.id)) out.push({ ...custom, builtin: false });
    }
    return out;
  }

  get(id: string): AgentProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Chỉ profile đang enabled. */
  listEnabled(): AgentProfile[] {
    return this.list().filter((p) => p.enabled);
  }

  /** Bật/tắt một profile (builtin hay custom). Lưu ngay xuống đĩa. */
  setEnabled(id: string, enabled: boolean): AgentProfile {
    this.ensureLoaded();
    const current = this.get(id);
    if (!current) throw new AgentProfileError(`Không có Agent Profile "${id}".`);
    this.applyOverride(id, { enabled });
    const updated = this.get(id);
    if (!updated) throw new AgentProfileError(`Không có Agent Profile "${id}".`);
    return updated;
  }

  /** Đặt model mặc định cho một profile (chuỗi rỗng = dùng registry default). Lưu ngay. */
  setModel(id: string, provider: string, model: string): AgentProfile {
    this.ensureLoaded();
    const current = this.get(id);
    if (!current) throw new AgentProfileError(`Không có Agent Profile "${id}".`);
    if (typeof provider !== 'string' || provider.trim() === '') {
      throw new AgentProfileError('provider phải là chuỗi không rỗng.');
    }
    if (typeof model !== 'string') throw new AgentProfileError('model phải là chuỗi.');
    this.applyOverride(id, { provider, model });
    const updated = this.get(id);
    if (!updated) throw new AgentProfileError(`Không có Agent Profile "${id}".`);
    return updated;
  }

  /** Thêm profile custom mới (id không trùng builtin/custom). Lưu ngay. */
  addCustom(profile: AgentProfile): AgentProfile {
    this.ensureLoaded();
    const errors = validateAgentProfile(profile);
    if (errors.length > 0) throw new AgentProfileError(`Profile không hợp lệ: ${errors.join(' ')}`);
    if (profile.builtin) throw new AgentProfileError('Profile custom không được đặt builtin=true.');
    if (this.get(profile.id)) throw new AgentProfileError(`Đã có Agent Profile "${profile.id}".`);
    this.file.custom.push({ ...profile, builtin: false });
    this.save();
    return profile;
  }

  /** Xoá profile custom (builtin không xoá được — chỉ tắt được). */
  removeCustom(id: string): boolean {
    this.ensureLoaded();
    const target = this.get(id);
    if (!target) return false;
    if (target.builtin) throw new AgentProfileError(`Profile builtin "${id}" không xoá được (chỉ tắt được).`);
    const before = this.file.custom.length;
    this.file.custom = this.file.custom.filter((p) => p.id !== id);
    if (this.file.custom.length === before) return false;
    this.save();
    return true;
  }

  /** Chọn profile cho một task kind (chỉ xét profile enabled). */
  profileForKind(kind: AgentProfileKind): AgentProfile | undefined {
    return profileForTaskKind(this.list(), kind);
  }

  private applyOverride(id: string, patch: Omit<AgentProfileOverride, 'id'>): void {
    const current = this.get(id);
    if (!current) throw new AgentProfileError(`Không có Agent Profile "${id}".`);
    if (current.builtin) {
      this.file.overrides[id] = { ...this.file.overrides[id], ...patch, id };
    } else {
      const idx = this.file.custom.findIndex((p) => p.id === id);
      if (idx < 0) throw new AgentProfileError(`Không có Agent Profile "${id}".`);
      const merged = { ...this.file.custom[idx], ...patch, id, builtin: false };
      const errors = validateAgentProfile(merged);
      if (errors.length > 0) throw new AgentProfileError(`Profile không hợp lệ: ${errors.join(' ')}`);
      this.file.custom[idx] = merged as AgentProfile;
    }
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }
}
