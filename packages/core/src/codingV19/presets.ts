/**
 * Coding agent v19 — agent profile presets (v1.41, Đội T4).
 *
 * Preset theo agent profile: một preset gồm system prompt + plugin set
 * + tool allowlist (+ maxSteps). Khi tạo conversation, preset được
 * resolve thành snapshot ghi vào meta của conversation — sửa/xoá preset
 * sau đó không ảnh hưởng conversation đã tạo. Có 5 preset builtin
 * (không xoá/sửa trực tiếp, chỉ clone thành custom rồi sửa bản clone);
 * preset custom do user tạo/sửa/xoá, lưu theo profile (id slug).
 *
 * Ý tưởng học từ survey v141 §3 (Agent Canvas 1.38: prompt/plugin
 * presets theo agent profile). Code của open-bot, dữ liệu thuần.
 */

import { CodingV19Error, V19_MAX_PRESETS } from './types';
import type { V19AgentPreset, V19PresetApplyResult, V19PresetInput } from './types';

/** Id preset hợp lệ: slug chữ thường, số, '-' và '_'. */
export const V19_PRESET_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
/** Số bước agent tối đa cho phép trong preset. */
export const V19_PRESET_MAX_STEPS_MIN = 1;
export const V19_PRESET_MAX_STEPS_MAX = 500;
/** maxSteps mặc định khi preset không đặt. */
export const V19_PRESET_DEFAULT_MAX_STEPS = 50;

/** Sinh id preset từ tên (slug hoá, tối đa 64 ký tự). */
export function v19PresetIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (slug === '') throw new CodingV19Error('Không sinh được preset id từ tên (tên cần ít nhất một ký tự chữ/số).');
  return slug;
}

/** 5 preset builtin của hệ thống. */
export function v19BuiltinPresets(now: number): V19AgentPreset[] {
  const at = typeof now === 'number' ? now : Date.now();
  const make = (
    id: string,
    name: string,
    description: string,
    systemPrompt: string,
    pluginIds: string[],
    toolAllowlist: string[],
    maxSteps: number,
  ): V19AgentPreset => ({
    id,
    name,
    description,
    systemPrompt,
    pluginIds,
    toolAllowlist,
    maxSteps,
    builtin: true,
    createdAt: at,
    updatedAt: at,
  });
  return [
    make(
      'general',
      'General coding',
      'Preset mặc định: viết code, sửa bug, giải thích — dùng mọi tool v19.',
      'You are a general-purpose coding agent. Work inside the conversation workspace only. Read files before editing, run tests after changes, and explain what you changed in short.',
      ['filesystem', 'code-search'],
      [],
      50,
    ),
    make(
      'reviewer',
      'Code reviewer',
      'Review patch/diff: tìm bug, vấn đề bảo mật, gợi ý sửa — chỉ đọc, không ghi file.',
      'You are a strict code reviewer. Read the diff and related files, list findings by severity with file and line, suggest concrete fixes. Never write files; only report.',
      ['filesystem', 'code-search', 'git-helper'],
      ['coding_v19_workspace', 'coding_v19_diff', 'coding_v19_events'],
      30,
    ),
    make(
      'refactorer',
      'Refactorer',
      'Tái cấu trúc code giữ nguyên hành vi: tách hàm, đổi tên, dọn dead code.',
      'You are a refactoring agent. Preserve behaviour exactly: small safe steps, keep tests green, checkpoint the workspace before each risky change, and summarise every move.',
      ['filesystem', 'code-search', 'test-runner'],
      [],
      60,
    ),
    make(
      'test-writer',
      'Test writer',
      'Viết test cho code hiện có: bao phủ case chính + case biên, chạy test và sửa tới khi xanh.',
      'You are a test-writing agent. Read the target code first, write tests for the main cases and edge cases, run them, and fix failures until green. Never change production code except to fix a bug a test exposed.',
      ['filesystem', 'test-runner'],
      ['coding_v19_workspace', 'coding_v19_agent', 'coding_v19_checkpoint', 'coding_v19_events'],
      40,
    ),
    make(
      'docs',
      'Docs writer',
      'Viết tài liệu: README, comment, hướng dẫn sử dụng — rõ ràng, ví dụ chạy được.',
      'You are a documentation agent. Write clear docs with runnable examples, keep code snippets in sync with the workspace files, and list every file you touched.',
      ['filesystem'],
      ['coding_v19_workspace', 'coding_v19_events', 'coding_v19_checkpoint'],
      30,
    ),
  ];
}

/** Lấy preset builtin theo id (undefined khi không có). */
export function v19BuiltinPresetById(id: string, now?: number): V19AgentPreset | undefined {
  return v19BuiltinPresets(typeof now === 'number' ? now : Date.now()).find((p) => p.id === id);
}

/** Validate input tạo/cập nhật preset, trả lỗi (rỗng = hợp lệ). */
export function v19ValidatePresetInput(input: V19PresetInput): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return ['Preset input phải là object.'];
  if (input.id !== undefined && (typeof input.id !== 'string' || !V19_PRESET_ID_RE.test(input.id))) {
    errors.push(`Preset id "${String(input.id)}" không hợp lệ (slug chữ thường, số, '-'/'_', tối đa 64 ký tự).`);
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    errors.push('Preset cần name không rỗng.');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    errors.push('Preset description phải là string.');
  }
  if (typeof input.systemPrompt !== 'string' || input.systemPrompt.trim() === '') {
    errors.push('Preset cần systemPrompt không rỗng.');
  }
  if (input.pluginIds !== undefined) {
    if (!Array.isArray(input.pluginIds) || input.pluginIds.some((p) => typeof p !== 'string' || p.trim() === '')) {
      errors.push('Preset pluginIds phải là mảng string không rỗng.');
    } else if (new Set(input.pluginIds).size !== input.pluginIds.length) {
      errors.push('Preset pluginIds không được trùng nhau.');
    }
  }
  if (input.toolAllowlist !== undefined) {
    if (!Array.isArray(input.toolAllowlist) || input.toolAllowlist.some((t) => typeof t !== 'string' || t.trim() === '')) {
      errors.push('Preset toolAllowlist phải là mảng string không rỗng.');
    } else if (new Set(input.toolAllowlist).size !== input.toolAllowlist.length) {
      errors.push('Preset toolAllowlist không được trùng nhau.');
    }
  }
  if (input.maxSteps !== undefined) {
    if (!Number.isInteger(input.maxSteps) || input.maxSteps < V19_PRESET_MAX_STEPS_MIN || input.maxSteps > V19_PRESET_MAX_STEPS_MAX) {
      errors.push(`Preset maxSteps phải là số nguyên ${V19_PRESET_MAX_STEPS_MIN}..${V19_PRESET_MAX_STEPS_MAX}.`);
    }
  }
  return errors;
}

/** Tạo preset custom mới (throw khi input lỗi / trùng id / vượt giới hạn). */
export function v19CreatePreset(
  presets: readonly V19AgentPreset[],
  input: V19PresetInput,
  now?: number,
): V19AgentPreset {
  const errors = v19ValidatePresetInput(input);
  if (errors.length > 0) throw new CodingV19Error(`Không tạo được preset:\n- ${errors.join('\n- ')}`);
  if (presets.length >= V19_MAX_PRESETS) {
    throw new CodingV19Error(`Đã đạt giới hạn ${V19_MAX_PRESETS} preset — xoá preset cũ trước.`);
  }
  const id = input.id ?? v19PresetIdFromName(input.name);
  if (presets.some((p) => p.id === id)) {
    throw new CodingV19Error(`Đã có preset "${id}" — chọn id khác hoặc cập nhật preset đó.`);
  }
  const at = typeof now === 'number' ? now : Date.now();
  return {
    id,
    name: input.name.trim(),
    description: input.description,
    systemPrompt: input.systemPrompt,
    pluginIds: input.pluginIds ? [...input.pluginIds] : [],
    toolAllowlist: input.toolAllowlist ? [...input.toolAllowlist] : [],
    maxSteps: input.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS,
    builtin: false,
    createdAt: at,
    updatedAt: at,
  };
}

/** Cập nhật preset custom (builtin không sửa trực tiếp — clone rồi sửa bản clone). */
export function v19UpdatePreset(
  presets: readonly V19AgentPreset[],
  id: string,
  input: V19PresetInput,
  now?: number,
): V19AgentPreset[] {
  const target = presets.find((p) => p.id === id);
  if (!target) throw new CodingV19Error(`Không có preset "${id}".`);
  if (target.builtin) {
    throw new CodingV19Error(`Preset "${id}" là builtin — không sửa trực tiếp, hãy clone thành preset custom rồi sửa bản clone.`);
  }
  const merged: V19PresetInput = {
    id: target.id,
    name: input.name ?? target.name,
    description: input.description ?? target.description,
    systemPrompt: input.systemPrompt ?? target.systemPrompt,
    pluginIds: input.pluginIds ?? target.pluginIds,
    toolAllowlist: input.toolAllowlist ?? target.toolAllowlist,
    maxSteps: input.maxSteps ?? target.maxSteps,
  };
  const errors = v19ValidatePresetInput(merged);
  if (errors.length > 0) throw new CodingV19Error(`Không cập nhật được preset "${id}":\n- ${errors.join('\n- ')}`);
  const at = typeof now === 'number' ? now : Date.now();
  const updated: V19AgentPreset = {
    ...target,
    name: merged.name.trim(),
    description: merged.description,
    systemPrompt: merged.systemPrompt,
    pluginIds: [...(merged.pluginIds ?? [])],
    toolAllowlist: [...(merged.toolAllowlist ?? [])],
    maxSteps: merged.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS,
    updatedAt: at,
  };
  return presets.map((p) => (p.id === id ? updated : p));
}

/** Xoá preset custom (builtin không xoá được). */
export function v19DeletePreset(presets: readonly V19AgentPreset[], id: string): V19AgentPreset[] {
  const target = presets.find((p) => p.id === id);
  if (!target) throw new CodingV19Error(`Không có preset "${id}".`);
  if (target.builtin) throw new CodingV19Error(`Preset "${id}" là builtin — không xoá được.`);
  return presets.filter((p) => p.id !== id);
}

/**
 * Clone preset (builtin hoặc custom) thành preset custom mới với id +
 * tên mới. Dùng để tuỳ biến preset builtin mà không sửa gốc.
 */
export function v19ClonePreset(
  presets: readonly V19AgentPreset[],
  id: string,
  newId: string,
  newName: string,
  now?: number,
): V19AgentPreset {
  const target = presets.find((p) => p.id === id);
  if (!target) throw new CodingV19Error(`Không có preset "${id}" để clone.`);
  if (!V19_PRESET_ID_RE.test(newId)) {
    throw new CodingV19Error(`Preset id mới "${newId}" không hợp lệ (slug chữ thường, số, '-'/'_').`);
  }
  if (presets.some((p) => p.id === newId)) {
    throw new CodingV19Error(`Đã có preset "${newId}" — chọn id khác.`);
  }
  if (typeof newName !== 'string' || newName.trim() === '') {
    throw new CodingV19Error('Tên preset clone không được rỗng.');
  }
  const at = typeof now === 'number' ? now : Date.now();
  return {
    ...v19ClonePresetData(target),
    id: newId,
    name: newName.trim(),
    builtin: false,
    createdAt: at,
    updatedAt: at,
  };
}

/** Copy dữ liệu preset (trừ id/name/builtin/thời gian) — dùng nội bộ khi clone. */
function v19ClonePresetData(preset: V19AgentPreset): Omit<V19AgentPreset, 'id' | 'name' | 'builtin' | 'createdAt' | 'updatedAt'> {
  return {
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    pluginIds: [...preset.pluginIds],
    toolAllowlist: [...preset.toolAllowlist],
    maxSteps: preset.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS,
  };
}

/** Tìm preset theo id trong (builtin + custom), undefined khi không có. */
export function v19FindPreset(
  presets: readonly V19AgentPreset[],
  id: string,
  now?: number,
): V19AgentPreset | undefined {
  return presets.find((p) => p.id === id) ?? v19BuiltinPresetById(id, now);
}

/** Gộp builtin + custom thành danh sách đầy đủ (builtin trước, custom sau, sort theo tên). */
export function v19AllPresets(custom: readonly V19AgentPreset[], now?: number): V19AgentPreset[] {
  const builtin = v19BuiltinPresets(typeof now === 'number' ? now : Date.now());
  const customNonBuiltin = custom.filter((p) => !builtin.some((b) => b.id === p.id));
  return [...builtin, ...customNonBuiltin].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Áp preset lên conversation: resolve system prompt + plugin set +
 * allowlist + maxSteps; plugin nào chưa cài thì báo missing (cảnh báo,
 * không chặn — conversation vẫn tạo, plugin đó đơn giản là chưa chạy).
 */
export function v19ApplyPreset(
  preset: V19AgentPreset,
  installedPluginNames: readonly string[],
): V19PresetApplyResult {
  const installed = new Set(installedPluginNames);
  const missingPlugins = preset.pluginIds.filter((id) => !installed.has(id));
  return {
    presetId: preset.id,
    presetName: preset.name,
    systemPrompt: preset.systemPrompt,
    pluginIds: [...preset.pluginIds],
    toolAllowlist: [...preset.toolAllowlist],
    maxSteps: preset.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS,
    missingPlugins,
  };
}

/** Kiểm tra một tool có được phép theo allowlist của preset không (rỗng = cho tất cả). */
export function v19IsToolAllowed(allowlist: readonly string[], toolName: string): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.includes(toolName);
}

/** Render danh sách preset (một dòng một preset). */
export function renderV19PresetList(presets: readonly V19AgentPreset[]): string {
  if (presets.length === 0) return '(chưa có preset nào)';
  return presets
    .map(
      (p) =>
        `${p.id}${p.builtin ? ' [builtin]' : ''} — ${p.name}: ${p.description ?? ''} (plugin: ${p.pluginIds.join(', ') || '(không có)'}, tool cho phép: ${p.toolAllowlist.length === 0 ? 'tất cả' : p.toolAllowlist.join(', ')}, tối đa ${p.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS} bước)`,
    )
    .join('\n');
}

/** Render chi tiết một preset. */
export function renderV19Preset(preset: V19AgentPreset): string {
  return (
    `Preset ${preset.id}${preset.builtin ? ' [builtin]' : ''} — ${preset.name}\n` +
    `Mô tả: ${preset.description ?? '(không có)'}\n` +
    `System prompt: ${preset.systemPrompt}\n` +
    `Plugin: ${preset.pluginIds.join(', ') || '(không có)'}\n` +
    `Tool cho phép: ${preset.toolAllowlist.length === 0 ? 'tất cả' : preset.toolAllowlist.join(', ')}\n` +
    `Tối đa ${preset.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS} bước.`
  );
}

/** Render kết quả áp preset (kèm cảnh báo plugin chưa cài). */
export function renderV19PresetApplyResult(result: V19PresetApplyResult): string {
  const lines = [
    `Đã áp preset "${result.presetName}" (${result.presetId}): system prompt + ${result.pluginIds.length} plugin + ${result.toolAllowlist.length === 0 ? 'mọi tool' : `${result.toolAllowlist.length} tool cho phép`}, tối đa ${result.maxSteps} bước.`,
  ];
  if (result.missingPlugins.length > 0) {
    lines.push(`Cảnh báo: plugin chưa cài nên chưa chạy được: ${result.missingPlugins.join(', ')}.`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Export / import preset (JSON)                                       */
/* ------------------------------------------------------------------ */

/** Serialize preset thành JSON (chia sẻ preset giữa máy/user). */
export function v19PresetToJson(preset: V19AgentPreset): string {
  const errors = v19ValidatePresetInput({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    pluginIds: preset.pluginIds,
    toolAllowlist: preset.toolAllowlist,
    maxSteps: preset.maxSteps,
  });
  if (errors.length > 0) {
    throw new CodingV19Error(`Không export được preset lỗi:\n- ${errors.join('\n- ')}`);
  }
  const exported: V19AgentPreset = {
    ...preset,
    builtin: false,
  };
  return `${JSON.stringify(exported, null, 2)}\n`;
}

/**
 * Import preset từ JSON: validate đầy đủ, ép builtin=false (preset
 * import luôn là custom — không ai import đè được preset hệ thống),
 * giữ nguyên id (caller kiểm tra trùng trước khi lưu).
 */
export function v19PresetFromJson(json: string): V19AgentPreset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodingV19Error('Preset JSON không phải JSON hợp lệ.');
  }
  const preset = parsed as V19AgentPreset;
  if (!preset || typeof preset !== 'object') {
    throw new CodingV19Error('Preset JSON phải là object.');
  }
  const errors = v19ValidatePresetInput({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    pluginIds: preset.pluginIds,
    toolAllowlist: preset.toolAllowlist,
    maxSteps: preset.maxSteps,
  });
  if (errors.length > 0) {
    throw new CodingV19Error(`Preset JSON không hợp lệ:\n- ${errors.join('\n- ')}`);
  }
  const now = Date.now();
  return {
    id: preset.id,
    name: preset.name.trim(),
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    pluginIds: [...(preset.pluginIds ?? [])],
    toolAllowlist: [...(preset.toolAllowlist ?? [])],
    maxSteps: preset.maxSteps ?? V19_PRESET_DEFAULT_MAX_STEPS,
    builtin: false,
    createdAt: typeof preset.createdAt === 'number' ? preset.createdAt : now,
    updatedAt: now,
  };
}
