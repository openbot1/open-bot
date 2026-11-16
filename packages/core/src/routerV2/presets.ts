/**
 * Preset INI per-model (v1.16, Doi T3).
 *
 * Y tuong (llama.cpp `--models-preset`): moi model co mot section INI
 * rieng chua flags (context, kv cache, threads, gpu layers, sampler,
 * extra args). File vi du:
 *
 *   [model:qwen3-4b]
 *   context_size = 16384
 *   kv_cache_type = q8_0
 *   gpu_layers = 99
 *   temperature = 0.7
 *
 *   [preset:fast-chat]
 *   context_size = 4096
 *   temperature = 0.9
 *
 * Parser phong thu: key khong biet / gia tri ngoai gioi han -> bo qua
 * + ghi warning (khong crash, khong ap gia tri nguy hiem). Khong bao
 * gio ap gia tri chua validate vao lenh chay.
 */

import * as fs from 'node:fs';

import { DEFAULT_PER_MODEL_FLAGS, type KvCacheType, type ModelPreset, type PerModelFlags, type SamplerFlags } from './types';

/** Gioi han hop le cho tung flag so (de chan gia tri vo ly). */
export const FLAG_LIMITS = {
  contextSize: { min: 512, max: 1_048_576 },
  threads: { min: 0, max: 256 },
  gpuLayers: { min: -1, max: 999 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  topK: { min: 0, max: 500 },
  repeatPenalty: { min: 0.5, max: 2 },
  minP: { min: 0, max: 1 },
} as const;

/** Cac kieu KV cache hop le. */
export const VALID_KV_CACHE_TYPES: readonly KvCacheType[] = ['f16', 'q8_0', 'q4_0'];

/** Key INI -> truong PerModelFlags tuong ung. */
const NUMERIC_FLAG_KEYS: Record<string, keyof Omit<PerModelFlags, 'kvCacheType' | 'sampler' | 'extraArgs'>> = {
  context_size: 'contextSize',
  context: 'contextSize',
  threads: 'threads',
  gpu_layers: 'gpuLayers',
  n_gpu_layers: 'gpuLayers',
};

/** Key INI -> truong SamplerFlags tuong ung. */
const SAMPLER_KEYS: Record<string, keyof SamplerFlags> = {
  temperature: 'temperature',
  temp: 'temperature',
  top_p: 'topP',
  top_k: 'topK',
  repeat_penalty: 'repeatPenalty',
  min_p: 'minP',
};

/** Ket qua parse mot file preset. */
export interface PresetParseResult {
  presets: ModelPreset[];
  /** Loi nang (file khong doc duoc) — tra presets rong. */
  error?: string;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseIntValue(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatValue(raw: string): number | null {
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse text INI thanh cac ModelPreset. Section `[model:<id>]` gan voi
 * model id; `[preset:<ten>]` la preset chung (ap theo ten khi user
 * chon). Section khong co tien to duoc coi la preset chung lay ten
 * section lam ten.
 */
export function parsePresetIni(text: string, sourcePath: string): PresetParseResult {
  const presets: ModelPreset[] = [];
  let current: ModelPreset | null = null;
  const finishCurrent = (): void => {
    if (current) presets.push(current);
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      finishCurrent();
      const section = sectionMatch[1].trim();
      const modelMatch = /^model:(.+)$/.exec(section);
      const presetMatch = /^preset:(.+)$/.exec(section);
      current = {
        name: modelMatch?.[1].trim() ?? presetMatch?.[1].trim() ?? section,
        modelId: modelMatch?.[1].trim(),
        flags: {},
        sampler: {},
        extraArgs: [],
        warnings: [],
        sourcePath,
      };
      continue;
    }
    if (!current) {
      // Key ngoai section -> bo qua (ghi warning vao preset ao dau tien).
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) {
      current.warnings.push(`Dong khong hieu: "${line.slice(0, 80)}"`);
      continue;
    }
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const rawValue = line.slice(eqIdx + 1).trim();
    applyPresetKey(current, key, rawValue);
  }
  finishCurrent();
  return { presets };
}

/** Ap mot key=value vao preset dang parse (co validate + warning). */
function applyPresetKey(preset: ModelPreset, key: string, rawValue: string): void {
  if (key === 'kv_cache_type' || key === 'kv_cache') {
    const v = rawValue.toLowerCase() as KvCacheType;
    if ((VALID_KV_CACHE_TYPES as readonly string[]).includes(v)) {
      preset.flags.kvCacheType = v;
    } else {
      preset.warnings.push(`kv_cache_type khong hop le: "${rawValue}" (nhan f16, q8_0, q4_0)`);
    }
    return;
  }
  if (key === 'extra_args' || key === 'extra') {
    preset.extraArgs.push(...splitArgs(rawValue));
    return;
  }
  const numericField = NUMERIC_FLAG_KEYS[key];
  if (numericField) {
    const n = parseIntValue(rawValue);
    if (n === null) {
      preset.warnings.push(`${key} khong phai so: "${rawValue}"`);
      return;
    }
    const limits =
      numericField === 'contextSize'
        ? FLAG_LIMITS.contextSize
        : numericField === 'threads'
          ? FLAG_LIMITS.threads
          : FLAG_LIMITS.gpuLayers;
    const clamped = clampInt(n, limits.min, limits.max);
    if (clamped !== n) preset.warnings.push(`${key}=${n} vuot gioi han, da gioi han ve ${clamped}`);
    (preset.flags as Record<string, number>)[numericField] = clamped;
    return;
  }
  const samplerField = SAMPLER_KEYS[key];
  if (samplerField) {
    const n = parseFloatValue(rawValue);
    if (n === null) {
      preset.warnings.push(`${key} khong phai so: "${rawValue}"`);
      return;
    }
    const limits = FLAG_LIMITS[samplerField];
    const clamped = clampFloat(n, limits.min, limits.max);
    if (clamped !== n) preset.warnings.push(`${key}=${n} vuot gioi han, da gioi han ve ${clamped}`);
    preset.sampler[samplerField] = clamped;
    return;
  }
  preset.warnings.push(`Key khong biet: "${key}" (bo qua)`);
}

/**
 * Tach chuoi extra args thanh token (ho tro ngoac kep don gian).
 * An toan: neu ca chuoi chua ky tu shell (`;`, `|`, `&`, `` ` ``,
 * `$()`) thi bo TOAN BO gia tri (khong chi bo token chua no — vi
 * `rm -rf /` tach ra thanh token sach van nguy hiem neu ai do ghep
 * lai qua shell sau nay). Args chi chay qua spawn khong-shell, nhung
 * van chan tu goc.
 */
export function splitArgs(raw: string): string[] {
  if (/[;|&`]/.test(raw) || raw.includes('$(') || raw.includes('${')) return [];
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const token = m[1] ?? m[2] ?? m[3];
    if (token.length === 0) continue;
    tokens.push(token);
  }
  return tokens;
}

/** Doc + parse mot file preset INI. */
export function loadPresetFile(filePath: string): PresetParseResult {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parsePresetIni(text, filePath);
  } catch (error) {
    return { presets: [], error: `Khong doc duoc preset ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Doc nhieu file preset (file hoac thu muc chua *.ini). */
export function loadPresetPaths(paths: string[]): { presets: ModelPreset[]; errors: string[] } {
  const presets: ModelPreset[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith('.ini')).sort();
        for (const f of files) {
          const res = loadPresetFile(`${p}/${f}`);
          presets.push(...res.presets);
          if (res.error) errors.push(res.error);
        }
      } else {
        const res = loadPresetFile(p);
        presets.push(...res.presets);
        if (res.error) errors.push(res.error);
      }
    } catch {
      errors.push(`Preset path khong ton tai: ${p}`);
    }
  }
  return { presets, errors };
}

/** Tim preset khop model id (uu tien preset model rieng). */
export function presetForModel(presets: ModelPreset[], modelId: string): ModelPreset | undefined {
  return presets.find((p) => p.modelId === modelId);
}

/** Tim preset chung theo ten. */
export function presetByName(presets: ModelPreset[], name: string): ModelPreset | undefined {
  return presets.find((p) => !p.modelId && p.name === name);
}

/**
 * Merge flags: mac dinh <- preset <- override user. Sampler merge theo
 * tung truong; extraArgs noi chuoi (preset truoc, override sau).
 */
export function mergeFlags(
  preset: ModelPreset | undefined,
  override?: Partial<PerModelFlags>,
): PerModelFlags {
  const merged: PerModelFlags = {
    ...DEFAULT_PER_MODEL_FLAGS,
    ...(preset?.flags ?? {}),
    sampler: { ...DEFAULT_PER_MODEL_FLAGS.sampler, ...(preset?.sampler ?? {}) },
    extraArgs: [...(preset?.extraArgs ?? [])],
  };
  if (override) {
    if (override.contextSize !== undefined) merged.contextSize = override.contextSize;
    if (override.kvCacheType !== undefined) merged.kvCacheType = override.kvCacheType;
    if (override.threads !== undefined) merged.threads = override.threads;
    if (override.gpuLayers !== undefined) merged.gpuLayers = override.gpuLayers;
    if (override.sampler) merged.sampler = { ...merged.sampler, ...override.sampler };
    if (override.extraArgs) merged.extraArgs = [...merged.extraArgs, ...override.extraArgs];
  }
  return merged;
}

/** Validate bo flags day du: tra danh sach loi (rong = hop le). */
export function validateFlags(flags: PerModelFlags): string[] {
  const errors: string[] = [];
  const check = (name: string, value: number, min: number, max: number): void => {
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${name}=${value} ngoai gioi han ${min}..${max}`);
    }
  };
  check('contextSize', flags.contextSize, FLAG_LIMITS.contextSize.min, FLAG_LIMITS.contextSize.max);
  check('threads', flags.threads, FLAG_LIMITS.threads.min, FLAG_LIMITS.threads.max);
  check('gpuLayers', flags.gpuLayers, FLAG_LIMITS.gpuLayers.min, FLAG_LIMITS.gpuLayers.max);
  if (!(VALID_KV_CACHE_TYPES as readonly string[]).includes(flags.kvCacheType)) {
    errors.push(`kvCacheType khong hop le: ${flags.kvCacheType}`);
  }
  const s = flags.sampler;
  if (s.temperature !== undefined) check('temperature', s.temperature, 0, 2);
  if (s.topP !== undefined) check('topP', s.topP, 0, 1);
  if (s.topK !== undefined) check('topK', s.topK, 0, 500);
  if (s.repeatPenalty !== undefined) check('repeatPenalty', s.repeatPenalty, 0.5, 2);
  if (s.minP !== undefined) check('minP', s.minP, 0, 1);
  for (const arg of flags.extraArgs) {
    if (/[;|&`$]/.test(arg)) errors.push(`extraArgs chua ky tu nguy hiem: ${arg}`);
  }
  return errors;
}

/** Build argv cho llama-server tu model + flags (de processManager dung). */
export function buildLlamaServerArgs(
  modelPath: string,
  flags: PerModelFlags,
  port: number,
  host = '127.0.0.1',
): string[] {
  const args: string[] = ['-m', modelPath, '--port', String(port), '--host', host];
  args.push('--ctx-size', String(flags.contextSize));
  args.push('--cache-type-k', flags.kvCacheType);
  if (flags.threads > 0) args.push('--threads', String(flags.threads));
  if (flags.gpuLayers >= 0) args.push('--n-gpu-layers', String(flags.gpuLayers));
  if (flags.sampler.temperature !== undefined) args.push('--temp', String(flags.sampler.temperature));
  if (flags.sampler.topP !== undefined) args.push('--top-p', String(flags.sampler.topP));
  if (flags.sampler.topK !== undefined) args.push('--top-k', String(flags.sampler.topK));
  if (flags.sampler.repeatPenalty !== undefined) args.push('--repeat-penalty', String(flags.sampler.repeatPenalty));
  if (flags.sampler.minP !== undefined) args.push('--min-p', String(flags.sampler.minP));
  args.push(...flags.extraArgs);
  return args;
}
