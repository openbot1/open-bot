/**
 * Coding agent v15 — agent profiles.
 *
 * Một profile gom 3 thứ quyết định hành vi của một run: persona
 * (ai là agent này), tool set (được dùng tool nào) và model (chạy
 * bằng model nào). Run nào cũng chạy dưới đúng một profile; không
 * có profile thì dùng profile built-in `general`.
 *
 * - CRUD đầy đủ trên store (memory + file JSON tuỳ chọn): tạo / sửa /
 *   xóa / liệt kê. Profile built-in chỉ đọc (muốn đổi thì clone).
 * - Apply cho run: dựng system prompt cuối (persona + ghi chú tool +
 *   ghi chú model), tính effective tools (deny thắng allow), chọn
 *   model (profile.model hoặc fallback của bot).
 * - ACP: profile có `exposeViaAcp = true` thì xuất hiện trong ACP
 *   listing với nhãn `ACP` (tên hiển thị `<name> [ACP]`) để host
 *   ACP và user phân biệt được profile nào gọi được qua ACP.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV15Error } from './types';
import type {
  V15AgentProfile,
  V15NewProfile,
  V15ProfileApplyResult,
  V15ProfileKind,
  V15ProfileUpdate,
} from './types';

/** Prefix id của profile built-in. */
export const V15_PROFILE_BUILTIN_PREFIX = 'v15-';

/** Số step tối đa mặc định của một profile. */
export const V15_PROFILE_DEFAULT_MAX_STEPS = 20;

/** Giới hạn độ dài các field text (tránh profile phình vô hạn). */
export const V15_PROFILE_MAX_PERSONA_CHARS = 4000;
export const V15_PROFILE_MAX_SYSTEM_PROMPT_CHARS = 12000;
export const V15_PROFILE_MAX_TOOLS = 200;

/** Regex id hợp lệ: slug lowercase. */
const V15_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Tên file persistence mặc định trong data dir. */
export const V15_PROFILE_FILE_NAME = 'profiles.json';

/** Tạo id từ tên (slug hoá) khi caller không đưa id. */
export function v15SlugifyProfileId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'profile';
}

/** Validate id profile, throw CodingV15Error('profile-invalid') khi sai. */
export function v15ValidateProfileId(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    throw new CodingV15Error('profile-invalid', 'Profile id phải là chuỗi 1..64 ký tự.');
  }
  if (!V15_PROFILE_ID_RE.test(id)) {
    throw new CodingV15Error(
      'profile-invalid',
      `Profile id "${id}" không hợp lệ: chỉ dùng chữ thường, số và dấu gạch ngang, bắt đầu bằng chữ/số.`,
    );
  }
}

function cleanToolList(list: readonly string[] | undefined, field: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new CodingV15Error('profile-invalid', `Profile ${field} phải là mảng tên tool.`);
  }
  if (list.length > V15_PROFILE_MAX_TOOLS) {
    throw new CodingV15Error(
      'profile-invalid',
      `Profile ${field} tối đa ${V15_PROFILE_MAX_TOOLS} tool, nhận ${list.length}.`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new CodingV15Error('profile-invalid', `Profile ${field} chứa tên tool rỗng/không phải chuỗi.`);
    }
    const name = item.trim();
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CodingV15Error('profile-invalid', `Profile ${field} không được rỗng.`);
  }
  if (value.length > max) {
    throw new CodingV15Error('profile-invalid', `Profile ${field} tối đa ${max} ký tự.`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new CodingV15Error('profile-invalid', `Profile ${field} phải là chuỗi.`);
  }
  if (value.length > max) {
    throw new CodingV15Error('profile-invalid', `Profile ${field} tối đa ${max} ký tự.`);
  }
  return value;
}

/** Validate toàn bộ input tạo profile mới, trả về bản đã chuẩn hoá. */
export function v15NormalizeNewProfile(input: V15NewProfile, now?: string): Omit<V15AgentProfile, 'createdAt' | 'updatedAt' | 'version' | 'builtin'> & { createdAt: string; updatedAt: string; version: number; builtin: boolean } {
  if (!input || typeof input !== 'object') {
    throw new CodingV15Error('profile-invalid', 'Profile input phải là object.');
  }
  const at = now ?? new Date().toISOString();
  const id = input.id !== undefined ? input.id : v15SlugifyProfileId(input.name ?? '');
  v15ValidateProfileId(id);
  const name = requireText(input.name, 'name', 120);
  const kind: V15ProfileKind = input.kind ?? 'custom';
  if (!(['general', 'reviewer', 'planner', 'fixer', 'explorer', 'custom'] as const).includes(kind)) {
    throw new CodingV15Error('profile-invalid', `Profile kind "${String(input.kind)}" không hợp lệ.`);
  }
  const persona = requireText(input.persona, 'persona', V15_PROFILE_MAX_PERSONA_CHARS);
  const systemPrompt = optionalText(input.systemPrompt, 'systemPrompt', V15_PROFILE_MAX_SYSTEM_PROMPT_CHARS);
  const model = optionalText(input.model, 'model', 160).trim();
  const maxSteps = input.maxSteps ?? V15_PROFILE_DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 500) {
    throw new CodingV15Error('profile-invalid', 'Profile maxSteps phải là số nguyên 1..500.');
  }
  let temperature: number | undefined;
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== 'number' || Number.isNaN(input.temperature) || input.temperature < 0 || input.temperature > 2) {
      throw new CodingV15Error('profile-invalid', 'Profile temperature phải là số 0..2.');
    }
    temperature = input.temperature;
  }
  return {
    id,
    name,
    kind,
    description: optionalText(input.description, 'description', 500),
    persona,
    systemPrompt,
    model,
    allowedTools: cleanToolList(input.allowedTools, 'allowedTools'),
    deniedTools: cleanToolList(input.deniedTools, 'deniedTools'),
    maxSteps,
    temperature,
    exposeViaAcp: input.exposeViaAcp ?? false,
    builtin: false,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

/** Nhãn hiển thị của profile trong ACP listing. */
export function v15AcpDisplayName(profile: Pick<V15AgentProfile, 'name' | 'exposeViaAcp'>): string {
  return profile.exposeViaAcp ? `${profile.name} [ACP]` : profile.name;
}

/** Tool thật sự được phép: allowedTools trừ deniedTools (deny thắng allow). */
export function v15EffectiveTools(profile: Pick<V15AgentProfile, 'allowedTools' | 'deniedTools'>): string[] {
  const denied = new Set(profile.deniedTools);
  return profile.allowedTools.filter((t) => !denied.has(t));
}

/** Profile này có được dùng tool không? Rỗng allowedTools = mọi tool (trừ denied). */
export function v15ProfileAllowsTool(
  profile: Pick<V15AgentProfile, 'allowedTools' | 'deniedTools'>,
  toolName: string,
  registryTools?: readonly string[],
): boolean {
  if (profile.deniedTools.includes(toolName)) return false;
  if (profile.allowedTools.length === 0) return true;
  if (profile.allowedTools.includes(toolName)) return true;
  // Tool không có trong registry thì cũng không cho dùng khi profile giới hạn tool.
  if (registryTools !== undefined && !registryTools.includes(toolName)) return false;
  return false;
}

/**
 * Dựng system prompt cuối cùng cho run từ profile: systemPrompt (hoặc
 * persona khi systemPrompt rỗng) + ghi chú tool + ghi chú model.
 */
export function v15BuildProfileSystemPrompt(profile: V15AgentProfile, fallbackModel: string): string {
  const base = profile.systemPrompt.trim().length > 0 ? profile.systemPrompt.trim() : profile.persona.trim();
  const lines: string[] = [base];
  const effective = v15EffectiveTools(profile);
  if (effective.length > 0) {
    lines.push(`\nYou may only use these tools: ${effective.join(', ')}. Do not call any other tool.`);
  } else if (profile.deniedTools.length > 0) {
    lines.push(`\nDo not use these tools: ${profile.deniedTools.join(', ')}.`);
  }
  const model = profile.model.trim().length > 0 ? profile.model : fallbackModel;
  lines.push(`\nYou are running as profile "${profile.name}" (${profile.kind}) with model ${model}.`);
  if (profile.maxSteps > 0) {
    lines.push(`Finish within ${profile.maxSteps} steps; if you cannot finish, report what remains instead of looping.`);
  }
  return lines.join('\n');
}

/** Áp profile cho một run: trả system prompt + effective tools + model + nhãn ACP. */
export function v15ApplyProfile(
  profile: V15AgentProfile,
  fallbackModel = '',
): V15ProfileApplyResult {
  const model = profile.model.trim().length > 0 ? profile.model : fallbackModel;
  return {
    profile,
    systemPrompt: v15BuildProfileSystemPrompt(profile, fallbackModel),
    effectiveTools: v15EffectiveTools(profile),
    model,
    acpDisplayName: v15AcpDisplayName(profile),
    exposedViaAcp: profile.exposeViaAcp,
  };
}

/** Mô tả một dòng của profile (cho UI list). */
export function renderV15ProfileSummary(profile: V15AgentProfile): string {
  const tools = profile.allowedTools.length === 0 ? 'all tools' : `${profile.allowedTools.length} tools`;
  const model = profile.model.trim().length > 0 ? profile.model : 'bot model';
  const acp = profile.exposeViaAcp ? ' [ACP]' : '';
  const builtin = profile.builtin ? ' (built-in)' : '';
  return `${profile.name}${acp}${builtin} — ${profile.kind}, ${tools}, model ${model}, max ${profile.maxSteps} steps (v${profile.version})`;
}

/* ================================================================== */
/* Built-in profiles                                                   */
/* ================================================================== */

function builtinProfile(
  id: string,
  name: string,
  kind: V15ProfileKind,
  description: string,
  persona: string,
  systemPrompt: string,
  model: string,
  allowedTools: string[],
  deniedTools: string[],
  maxSteps: number,
  exposeViaAcp: boolean,
  at: string,
): V15AgentProfile {
  return {
    id,
    name,
    kind,
    description,
    persona,
    systemPrompt,
    model,
    allowedTools: [...allowedTools],
    deniedTools: [...deniedTools],
    maxSteps,
    temperature: undefined,
    exposeViaAcp,
    builtin: true,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

/** 5 profile built-in của v15 (không sửa/xóa, chỉ clone). */
export function v15BuiltinProfiles(now?: string): V15AgentProfile[] {
  const at = now ?? new Date().toISOString();
  return [
    builtinProfile(
      'v15-general', 'General', 'general',
      'General-purpose coding agent: implement, explain and fix in one run.',
      'You are a general-purpose coding agent. Work step by step, verify each change, and report honestly what you changed and what remains.',
      '',
      '', [], [], 20, true, at,
    ),
    builtinProfile(
      'v15-reviewer', 'Reviewer', 'reviewer',
      'Code reviewer: reads diffs, finds bugs and risks, never edits code.',
      'You are a strict code reviewer. Read the diff carefully, point out real bugs, security risks and maintainability problems, and suggest concrete fixes. Do not edit files.',
      'Review the change: list each finding with file, line and severity (critical / major / minor). End with a verdict: approve, request changes, or block. Never edit files — reviewing only.',
      '', ['read_file', 'search_code', 'show_diff'], ['edit_file', 'write_file', 'delete_file', 'run_shell'], 12, true, at,
    ),
    builtinProfile(
      'v15-planner', 'Planner', 'planner',
      'Planner: breaks a task into small verifiable steps, writes no code.',
      'You are a planner. Break the task into small, verifiable steps with clear acceptance criteria. Ask when the goal is ambiguous instead of guessing.',
      'Produce a plan: goal, ordered steps (each with acceptance criteria and files involved), risks, and what to verify at the end. Do not write or edit code — planning only.',
      '', ['read_file', 'search_code', 'list_files'], ['edit_file', 'write_file', 'delete_file', 'run_shell', 'run_tests'], 10, false, at,
    ),
    builtinProfile(
      'v15-fixer', 'Fixer', 'fixer',
      'Bug fixer: reproduces the failure first, then makes the smallest fix that makes tests pass.',
      'You are a bug fixer. Reproduce the failure first, then make the smallest change that fixes it, and run the relevant tests to prove it.',
      'Reproduce the bug, locate the root cause, apply the smallest fix, then run the affected tests. If the fix grows beyond one focused change, stop and report the scope instead of rewriting.',
      '', ['read_file', 'edit_file', 'run_tests', 'search_code'], ['delete_file'], 25, true, at,
    ),
    builtinProfile(
      'v15-explorer', 'Explorer', 'explorer',
      'Codebase explorer: maps structure and answers "where / how" questions, read-only.',
      'You are a codebase explorer. Answer questions about structure, ownership and data flow by reading code. Never change anything.',
      'Explore read-only: answer with file paths, key symbols and short quotes. Never edit, create or delete files.',
      '', ['read_file', 'search_code', 'list_files'], ['edit_file', 'write_file', 'delete_file', 'run_shell', 'run_tests'], 12, false, at,
    ),
  ];
}

/* ================================================================== */
/* Store                                                               */
/* ================================================================== */

export interface V15ProfileStoreOptions {
  /** Thư mục chứa profiles.json (bỏ qua = chỉ memory). */
  dataDir?: string;
  /** false = không load built-in (chỉ dùng khi test store trống). */
  loadBuiltin?: boolean;
  now?: () => string;
}

/**
 * Store profile: memory + persistence JSON tuỳ chọn.
 * File format: `{ "version": 1, "profiles": V15AgentProfile[] }` — chỉ
 * profile không-built-in mới được ghi (built-in luôn tạo lại từ code).
 */
export class CodingV15ProfileStore {
  private readonly profiles = new Map<string, V15AgentProfile>();
  private readonly dataDir?: string;
  private readonly nowFn: () => string;

  constructor(options: V15ProfileStoreOptions = {}) {
    this.dataDir = options.dataDir;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    if (options.loadBuiltin !== false) {
      for (const p of v15BuiltinProfiles(this.nowFn())) this.profiles.set(p.id, p);
    }
    if (this.dataDir) this.loadFromDisk();
  }

  private filePath(): string {
    return path.join(this.dataDir as string, V15_PROFILE_FILE_NAME);
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as { profiles?: unknown };
      if (!Array.isArray(parsed.profiles)) return;
      for (const item of parsed.profiles) {
        if (!item || typeof item !== 'object') continue;
        const p = item as V15AgentProfile;
        if (typeof p.id !== 'string' || p.builtin) continue;
        try {
          v15ValidateProfileId(p.id);
          this.profiles.set(p.id, { ...p });
        } catch {
          // Bỏ qua profile hỏng trong file — không chặn store.
        }
      }
    } catch {
      // File chưa có = store mới, không phải lỗi.
    }
  }

  private saveToDisk(): void {
    if (!this.dataDir) return;
    const custom = [...this.profiles.values()].filter((p) => !p.builtin);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.filePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: custom }, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath());
  }

  /** Số profile trong store (kể cả built-in). */
  get size(): number {
    return this.profiles.size;
  }

  create(input: V15NewProfile): V15AgentProfile {
    const normalized = v15NormalizeNewProfile(input, this.nowFn());
    if (this.profiles.has(normalized.id)) {
      throw new CodingV15Error('profile-duplicate', `Profile "${normalized.id}" đã tồn tại.`);
    }
    this.profiles.set(normalized.id, normalized);
    this.saveToDisk();
    return { ...normalized, allowedTools: [...normalized.allowedTools], deniedTools: [...normalized.deniedTools] };
  }

  get(id: string): V15AgentProfile {
    const p = this.profiles.get(id);
    if (!p) throw new CodingV15Error('profile-not-found', `Không tìm thấy profile "${id}".`);
    return { ...p, allowedTools: [...p.allowedTools], deniedTools: [...p.deniedTools] };
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /** Liệt kê tất cả profile (built-in trước, rồi theo tên). */
  list(): V15AgentProfile[] {
    return [...this.profiles.values()]
      .sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1))
      .map((p) => ({ ...p, allowedTools: [...p.allowedTools], deniedTools: [...p.deniedTools] }));
  }

  /** Chỉ profile expose qua ACP (kèm nhãn hiển thị `[ACP]`). */
  listAcpProfiles(): { profile: V15AgentProfile; acpDisplayName: string }[] {
    return this.list()
      .filter((p) => p.exposeViaAcp)
      .map((p) => ({ profile: p, acpDisplayName: v15AcpDisplayName(p) }));
  }

  /** Liệt kê theo kind. */
  listByKind(kind: V15ProfileKind): V15AgentProfile[] {
    return this.list().filter((p) => p.kind === kind);
  }

  update(id: string, patch: V15ProfileUpdate): V15AgentProfile {
    const current = this.profiles.get(id);
    if (!current) throw new CodingV15Error('profile-not-found', `Không tìm thấy profile "${id}".`);
    if (current.builtin) {
      throw new CodingV15Error('profile-builtin-readonly', `Profile built-in "${id}" chỉ đọc — hãy clone rồi sửa bản clone.`);
    }
    if (patch.name !== undefined) current.name = requireText(patch.name, 'name', 120);
    if (patch.kind !== undefined) {
      if (!(['general', 'reviewer', 'planner', 'fixer', 'explorer', 'custom'] as const).includes(patch.kind)) {
        throw new CodingV15Error('profile-invalid', `Profile kind "${String(patch.kind)}" không hợp lệ.`);
      }
      current.kind = patch.kind;
    }
    if (patch.description !== undefined) current.description = optionalText(patch.description, 'description', 500);
    if (patch.persona !== undefined) current.persona = requireText(patch.persona, 'persona', V15_PROFILE_MAX_PERSONA_CHARS);
    if (patch.systemPrompt !== undefined) current.systemPrompt = optionalText(patch.systemPrompt, 'systemPrompt', V15_PROFILE_MAX_SYSTEM_PROMPT_CHARS);
    if (patch.model !== undefined) current.model = optionalText(patch.model, 'model', 160).trim();
    if (patch.allowedTools !== undefined) current.allowedTools = cleanToolList(patch.allowedTools, 'allowedTools');
    if (patch.deniedTools !== undefined) current.deniedTools = cleanToolList(patch.deniedTools, 'deniedTools');
    if (patch.maxSteps !== undefined) {
      if (!Number.isInteger(patch.maxSteps) || patch.maxSteps < 1 || patch.maxSteps > 500) {
        throw new CodingV15Error('profile-invalid', 'Profile maxSteps phải là số nguyên 1..500.');
      }
      current.maxSteps = patch.maxSteps;
    }
    if (patch.temperature !== undefined) {
      if (patch.temperature === null) {
        current.temperature = undefined;
      } else if (typeof patch.temperature !== 'number' || Number.isNaN(patch.temperature) || patch.temperature < 0 || patch.temperature > 2) {
        throw new CodingV15Error('profile-invalid', 'Profile temperature phải là số 0..2.');
      } else {
        current.temperature = patch.temperature;
      }
    }
    if (patch.exposeViaAcp !== undefined) current.exposeViaAcp = patch.exposeViaAcp;
    current.updatedAt = this.nowFn();
    current.version += 1;
    this.saveToDisk();
    return { ...current, allowedTools: [...current.allowedTools], deniedTools: [...current.deniedTools] };
  }

  delete(id: string): boolean {
    const current = this.profiles.get(id);
    if (!current) throw new CodingV15Error('profile-not-found', `Không tìm thấy profile "${id}".`);
    if (current.builtin) {
      throw new CodingV15Error('profile-builtin-readonly', `Profile built-in "${id}" không được xóa.`);
    }
    this.profiles.delete(id);
    this.saveToDisk();
    return true;
  }

  /** Clone một profile (kể cả built-in) thành profile custom mới. */
  clone(id: string, newId?: string, newName?: string): V15AgentProfile {
    const source = this.get(id);
    const cloneId = newId ?? `${source.id}-copy`;
    v15ValidateProfileId(cloneId);
    if (this.profiles.has(cloneId)) {
      throw new CodingV15Error('profile-duplicate', `Profile "${cloneId}" đã tồn tại.`);
    }
    const at = this.nowFn();
    const clone: V15AgentProfile = {
      ...source,
      id: cloneId,
      name: newName ?? `${source.name} (copy)`,
      builtin: false,
      createdAt: at,
      updatedAt: at,
      version: 1,
      allowedTools: [...source.allowedTools],
      deniedTools: [...source.deniedTools],
    };
    this.profiles.set(cloneId, clone);
    this.saveToDisk();
    return { ...clone, allowedTools: [...clone.allowedTools], deniedTools: [...clone.deniedTools] };
  }

  /** Áp profile cho run — throw profile-not-found khi id không tồn tại. */
  apply(id: string, fallbackModel = ''): V15ProfileApplyResult {
    return v15ApplyProfile(this.get(id), fallbackModel);
  }

  /** Export profile custom (không gồm built-in) để chia sẻ / backup. */
  exportCustom(): { version: 1; exportedAt: string; profiles: V15AgentProfile[] } {
    return {
      version: 1,
      exportedAt: this.nowFn(),
      profiles: this.list()
        .filter((p) => !p.builtin)
        .map((p) => ({ ...p, allowedTools: [...p.allowedTools], deniedTools: [...p.deniedTools] })),
    };
  }

  /**
   * Import profile từ file export: profile hợp lệ + chưa tồn tại thì
   * thêm; profile hỏng hoặc trùng id thì bỏ qua và đếm vào skipped
   * thay vì fail cả file. Built-in trong file import bị bỏ qua.
   */
  importProfiles(file: unknown): { imported: number; skipped: number; ids: string[] } {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new CodingV15Error('profile-invalid', 'Profile export file phải là object.');
    }
    const f = file as Record<string, unknown>;
    if (f['version'] !== 1) {
      throw new CodingV15Error('profile-invalid', 'Profile export file version phải là 1.');
    }
    if (!Array.isArray(f['profiles'])) {
      throw new CodingV15Error('profile-invalid', 'Profile export file cần mảng profiles.');
    }
    let imported = 0;
    let skipped = 0;
    const ids: string[] = [];
    for (const entry of f['profiles'] as unknown[]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || (entry as Record<string, unknown>)['builtin'] === true) {
        skipped += 1;
        continue;
      }
      try {
        const normalized = v15NormalizeNewProfile(entry as V15NewProfile, this.nowFn());
        if (this.profiles.has(normalized.id)) {
          skipped += 1;
          continue;
        }
        this.profiles.set(normalized.id, normalized);
        ids.push(normalized.id);
        imported += 1;
      } catch {
        skipped += 1;
      }
    }
    if (imported > 0) this.saveToDisk();
    return { imported, skipped, ids };
  }
}
