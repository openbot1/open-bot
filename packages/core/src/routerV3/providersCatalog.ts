/**
 * Provider catalog v3 (v1.18, Doi T3) — 100+ provider hop nhat.
 *
 * Catalog hop nhat moi nguon provider ma router biet, de UI hien
 * mot danh sach duy nhat + router cham diem:
 * - 90 preset OpenAI-compatible (`models/presets.ts`): gateway,
 *   inference cloud, model vendor, Trung Quoc, local self-hosted.
 * - Provider rieng khong phai preset: Anthropic, Gemini (API rieng,
 *   khong noi qua `/chat/completions`).
 * - 14 CLI provider (chay qua CLI da dang nhap tren may user, khong
 *   can key): Claude Code, Codex, Grok CLI, OpenCode, Gemini CLI,
 *   Cursor, Custom ACP, Aider, Continue, Amazon Q, Copilot,
 *   Windsurf, Kiro (+ ... xem providers/index.ts).
 *
 * Tong >= 100 muc. Chi la metadata (id/label/baseUrl/model) — khong
 * chua credential, khong goi mang. Loc theo category / local / key.
 */

import { COMPATIBLE_PRESETS } from '../models/presets';
import type { CompatiblePreset } from '../models/presets';
import { PROVIDERS } from '../providers/index';
import type { RouterV3ProviderCategory, RouterV3ProviderEntry } from './types';

/** Id preset la gateway/router (gom nhieu model cua nhieu hang). */
const GATEWAY_PRESET_IDS: ReadonlySet<string> = new Set([
  'openrouter', 'aimlapi', 'requesty', 'portkey', 'helicone',
  'vercel-ai-gateway', 'langdb', 'martian', 'notdiamond', 'unify',
  'eden-ai', 'huggingface', 'ovh-ai', 'targon', 'corcel',
  'inference-sh', 'litellm', 'open-webui', 'pollinations',
]);

/** Id preset la inference cloud (chay model open-weight). */
const INFERENCE_CLOUD_PRESET_IDS: ReadonlySet<string> = new Set([
  'together', 'groq', 'cerebras', 'sambanova', 'fireworks',
  'deepinfra', 'hyperbolic', 'novita', 'siliconflow', 'featherless',
  'chutes', 'infermatic', 'kluster', 'parasail', 'avian', 'lambda',
  'friendli', 'nebius', 'anyscale', 'replicate', 'baseten', 'lepton',
  'nvidia', 'prime-intellect', 'scaleway', 'pawan', 'shuttleai',
  'textsynth', 'naga-ai', 'modelscope',
]);

/** Id preset la hang Trung Quoc / khu vuc. */
const REGIONAL_PRESET_IDS: ReadonlySet<string> = new Set([
  'moonshot', 'moonshot-cn', 'qwen', 'qwen-cn', 'zhipu', 'z-ai',
  'doubao', 'minimax', 'baichuan', 'yi', 'spark', 'qianfan',
  'hunyuan', 'stepfun', 'sensenova', 'internlm', 'sarvam', 'maritaca',
]);

/** Id preset chay local (loopback, khong can key). */
const LOCAL_PRESET_IDS: ReadonlySet<string> = new Set([
  'ollama-local', 'lm-studio', 'vllm', 'llama-cpp',
  'text-generation-webui', 'jan', 'sglang', 'tgi', 'gpt4all',
  'localai', 'koboldcpp',
]);

/** Phan loai mot preset theo id (local uu tien truoc vi baseUrl localhost). */
export function categoryForPreset(preset: CompatiblePreset): RouterV3ProviderCategory {
  if (LOCAL_PRESET_IDS.has(preset.id)) return 'local';
  if (GATEWAY_PRESET_IDS.has(preset.id)) return 'gateway';
  if (INFERENCE_CLOUD_PRESET_IDS.has(preset.id)) return 'inference-cloud';
  if (REGIONAL_PRESET_IDS.has(preset.id)) return 'regional';
  return 'model-vendor';
}

/** true = preset chay local (baseUrl loopback). */
export function isLocalPreset(preset: CompatiblePreset): boolean {
  if (LOCAL_PRESET_IDS.has(preset.id)) return true;
  try {
    const url = new URL(preset.baseUrl);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** Chuyen mot preset thanh muc catalog v3. */
export function presetToCatalogEntry(preset: CompatiblePreset): RouterV3ProviderEntry {
  const local = isLocalPreset(preset);
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel,
    category: local ? 'local' : categoryForPreset(preset),
    local,
    needsKey: !local,
    source: 'preset',
  };
}

/**
 * Danh sach provider hop nhat cua router v3: preset + dedicated
 * (Anthropic/Gemini — API rieng, khong co trong preset) + CLI.
 * Sap xep: local truoc, roi gateway, inference-cloud, model-vendor,
 * regional, dedicated, CLI; trong moi nhom theo label.
 */
export function listV3Providers(): RouterV3ProviderEntry[] {
  const entries: RouterV3ProviderEntry[] = COMPATIBLE_PRESETS.map(presetToCatalogEntry);
  const presetIds = new Set(COMPATIBLE_PRESETS.map((p) => p.id));
  for (const meta of PROVIDERS) {
    if (presetIds.has(meta.id)) continue;
    if (meta.kind === 'cli') {
      entries.push({
        id: meta.id,
        label: meta.label,
        baseUrl: '',
        defaultModel: meta.defaultModel,
        category: 'cli',
        local: true,
        needsKey: false,
        source: 'cli',
      });
      continue;
    }
    if (meta.id === 'openai-compatible') continue;
    // Provider rieng (Anthropic, Gemini): API khong phai OpenAI-compatible.
    entries.push({
      id: meta.id,
      label: meta.label,
      baseUrl: meta.defaultBaseUrl,
      defaultModel: meta.defaultModel,
      category: 'dedicated',
      local: false,
      needsKey: meta.needsKey,
      source: 'dedicated',
    });
  }
  const rank: Record<RouterV3ProviderCategory, number> = {
    local: 0,
    gateway: 1,
    'inference-cloud': 2,
    'model-vendor': 3,
    regional: 4,
    dedicated: 5,
    cli: 6,
  };
  return entries.sort((a, b) => rank[a.category] - rank[b.category] || a.label.localeCompare(b.label));
}

/** Tong so provider trong catalog v3. */
export function v3ProviderCount(): number {
  return listV3Providers().length;
}

/** Tim mot provider theo id (undefined khi khong co). */
export function resolveV3Provider(id: string): RouterV3ProviderEntry | undefined {
  return listV3Providers().find((p) => p.id === id);
}

/** Loc catalog theo category. */
export function listV3ProvidersByCategory(category: RouterV3ProviderCategory): RouterV3ProviderEntry[] {
  return listV3Providers().filter((p) => p.category === category);
}

/** Chi provider local (chay tren may, mien phi). */
export function listV3LocalProviders(): RouterV3ProviderEntry[] {
  return listV3Providers().filter((p) => p.local);
}

/** Chi provider can key cua user. */
export function listV3KeyedProviders(): RouterV3ProviderEntry[] {
  return listV3Providers().filter((p) => p.needsKey);
}

/**
 * Tim provider theo tu khoa (id/label, khong phan biet hoa/thuong).
 * Tra toi da `limit` muc.
 */
export function searchV3Providers(query: string, limit = 20): RouterV3ProviderEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return listV3Providers().slice(0, limit);
  return listV3Providers()
    .filter((p) => p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
    .slice(0, Math.max(0, limit));
}
