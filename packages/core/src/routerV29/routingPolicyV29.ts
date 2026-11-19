/**
 * Routing policy v29 (v1.42, Doi T5) — chinh sach routing theo bot.
 *
 * Moi bot co mot policy: provider/model nao duoc phep, profile mac
 * dinh, tran chi phi/do tre moi luot, co duoc dung voice realtime
 * khong, fallback chain nao. Policy duoc ap vao RoutingRequestV29
 * truoc khi route (merge: policy siet them, khong mo rong yeu cau
 * nguoi dung) — de host gioi han bot con ma khong sua code router.
 *
 * Khac BotPolicyStore v118 (allow/deny TOOL + script + gioi han
 * tool/turn): day la policy chon MODEL (provider, gia, do tre,
 * voice), khong quan ly tool.
 */
import type { RoutingRequestV29 } from './latencyCostRouterV29';

/** Chinh sach routing cua mot bot. */
export interface BotRoutingPolicyV29 {
  botId: string;
  /** Provider duoc phep (rong/undefined = tat ca, tru denied). */
  allowedProviders?: string[];
  /** Provider cam (thang allowed). */
  deniedProviders?: string[];
  /** Model duoc phep (rong/undefined = tat ca, tru denied). */
  allowedModels?: string[];
  /** Model cam (thang allowed). */
  deniedModels?: string[];
  /** Profile mac dinh khi request khong chi ro. */
  defaultProfile?: 'fastest' | 'cheapest' | 'balanced' | 'quality';
  /** Tran chi phi moi luot (USD); undefined = khong gioi han. */
  maxCostPerTurnUsd?: number;
  /** Tran do tre (ms); undefined = khong gioi han. */
  maxLatencyMs?: number;
  /** Chat luong toi thieu. */
  minQuality?: number;
  /** Co duoc dung voice realtime khong (false = chi text). */
  voiceAllowed?: boolean;
  /** Uu tien model local mien phi khi ngang diem. */
  preferLocal?: boolean;
  /** Chain fallback mac dinh cua bot. */
  fallbackChainId?: string;
}

/** Ket qua validate policy. */
export interface BotRoutingPolicyValidationV29 {
  ok: boolean;
  errors: string[];
}

/** Policy mac dinh: mo (tat ca provider/model, chi text+voice). */
export function defaultBotRoutingPolicyV29(botId: string): BotRoutingPolicyV29 {
  return {
    botId,
    defaultProfile: 'balanced',
    voiceAllowed: true,
    preferLocal: false,
  };
}

/** Validate mot policy (thuan). */
export function validateBotRoutingPolicyV29(policy: BotRoutingPolicyV29): BotRoutingPolicyValidationV29 {
  const errors: string[] = [];
  if (!policy || typeof policy !== 'object') return { ok: false, errors: ['policy phai la object.'] };
  if (!policy.botId || policy.botId.trim() === '') errors.push('botId khong duoc rong.');
  const checkList = (list: string[] | undefined, name: string): void => {
    if (list === undefined) return;
    if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || v.trim() === '')) {
      errors.push(`${name} phai la array string khong rong.`);
    }
  };
  checkList(policy.allowedProviders, 'allowedProviders');
  checkList(policy.deniedProviders, 'deniedProviders');
  checkList(policy.allowedModels, 'allowedModels');
  checkList(policy.deniedModels, 'deniedModels');
  const overlap = (a?: string[], b?: string[]): string[] => {
    if (!a || !b) return [];
    return a.filter((v) => b.includes(v));
  };
  const providerOverlap = overlap(policy.allowedProviders, policy.deniedProviders);
  if (providerOverlap.length > 0) errors.push(`provider vua allow vua deny: ${providerOverlap.join(', ')}.`);
  const modelOverlap = overlap(policy.allowedModels, policy.deniedModels);
  if (modelOverlap.length > 0) errors.push(`model vua allow vua deny: ${modelOverlap.join(', ')}.`);
  const profiles: readonly string[] = ['fastest', 'cheapest', 'balanced', 'quality'];
  if (policy.defaultProfile !== undefined && !profiles.includes(policy.defaultProfile)) {
    errors.push(`defaultProfile phai la mot trong: ${profiles.join(', ')}.`);
  }
  if (policy.maxCostPerTurnUsd !== undefined && (!Number.isFinite(policy.maxCostPerTurnUsd) || policy.maxCostPerTurnUsd < 0)) {
    errors.push('maxCostPerTurnUsd phai >= 0.');
  }
  if (policy.maxLatencyMs !== undefined && (!Number.isFinite(policy.maxLatencyMs) || policy.maxLatencyMs <= 0)) {
    errors.push('maxLatencyMs phai la so duong.');
  }
  if (policy.minQuality !== undefined && (!Number.isFinite(policy.minQuality) || policy.minQuality < 0 || policy.minQuality > 1)) {
    errors.push('minQuality phai trong khoang 0..1.');
  }
  return { ok: errors.length === 0, errors };
}

/** Chuan hoa policy: sap xep + loai trung cac danh sach. */
export function normalizeBotRoutingPolicyV29(policy: BotRoutingPolicyV29): BotRoutingPolicyV29 {
  const dedupe = (list?: string[]): string[] | undefined => {
    if (list === undefined) return undefined;
    return [...new Set(list)].sort();
  };
  return {
    ...policy,
    allowedProviders: dedupe(policy.allowedProviders),
    deniedProviders: dedupe(policy.deniedProviders),
    allowedModels: dedupe(policy.allowedModels),
    deniedModels: dedupe(policy.deniedModels),
  };
}

/**
 * Merge 2 policy (moi thang cu — dung khi bot co policy rieng tren
 * policy nhom): deny hop nhat, allow giao nhau (neu ca 2 deu co),
 * tran lay min, voiceAllowed chi true khi ca 2 true.
 */
export function mergeBotRoutingPoliciesV29(
  base: BotRoutingPolicyV29,
  override: BotRoutingPolicyV29,
): BotRoutingPolicyV29 {
  if (base.botId !== override.botId) {
    throw new Error('Chi merge policy cung botId.');
  }
  const intersectAllow = (a?: string[], b?: string[]): string[] | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return a.filter((v) => b.includes(v));
  };
  const unionDeny = (a?: string[], b?: string[]): string[] | undefined => {
    if (a === undefined && b === undefined) return undefined;
    return [...new Set([...(a ?? []), ...(b ?? [])])].sort();
  };
  const minDefined = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
  };
  const merged: BotRoutingPolicyV29 = {
    botId: base.botId,
    allowedProviders: intersectAllow(base.allowedProviders, override.allowedProviders),
    deniedProviders: unionDeny(base.deniedProviders, override.deniedProviders),
    allowedModels: intersectAllow(base.allowedModels, override.allowedModels),
    deniedModels: unionDeny(base.deniedModels, override.deniedModels),
    defaultProfile: override.defaultProfile ?? base.defaultProfile,
    maxCostPerTurnUsd: minDefined(base.maxCostPerTurnUsd, override.maxCostPerTurnUsd),
    maxLatencyMs: minDefined(base.maxLatencyMs, override.maxLatencyMs),
    minQuality: override.minQuality !== undefined && base.minQuality !== undefined
      ? Math.max(base.minQuality, override.minQuality)
      : (override.minQuality ?? base.minQuality),
    voiceAllowed: (base.voiceAllowed !== false) && (override.voiceAllowed !== false),
    preferLocal: base.preferLocal === true || override.preferLocal === true,
    fallbackChainId: override.fallbackChainId ?? base.fallbackChainId,
  };
  return normalizeBotRoutingPolicyV29(merged);
}

/** Kiem tra mot model/provider co duoc policy cho phep khong. */
export function isModelAllowedByPolicyV29(
  policy: BotRoutingPolicyV29,
  modelId: string,
  provider: string,
): boolean {
  if (policy.deniedProviders?.includes(provider)) return false;
  if (policy.deniedModels?.includes(modelId)) return false;
  if (policy.allowedProviders !== undefined && policy.allowedProviders.length > 0 && !policy.allowedProviders.includes(provider)) {
    return false;
  }
  if (policy.allowedModels !== undefined && policy.allowedModels.length > 0 && !policy.allowedModels.includes(modelId)) {
    return false;
  }
  return true;
}

/**
 * Ap policy vao request routing: siet them cac rang buoc (khong mo
 * rong). Tra request moi + danh sach dieu chinh da ap (de giai thich).
 */
export function applyPolicyToRoutingRequestV29(
  policy: BotRoutingPolicyV29,
  request: RoutingRequestV29,
): { request: RoutingRequestV29; applied: string[] } {
  const applied: string[] = [];
  const next: RoutingRequestV29 = { ...request };
  if (policy.voiceAllowed === false && (request.needsRealtimeVoice || request.needsFullDuplex)) {
    next.needsRealtimeVoice = false;
    next.needsFullDuplex = false;
    next.needsBargeIn = false;
    next.needsProactiveAudio = false;
    applied.push('Policy cam voice realtime — chuyen sang text.');
  }
  if (policy.defaultProfile !== undefined && request.profile === undefined) {
    next.profile = policy.defaultProfile;
    applied.push(`Profile mac dinh cua bot: ${policy.defaultProfile}.`);
  }
  if (policy.maxCostPerTurnUsd !== undefined) {
    next.maxCostUsd = request.maxCostUsd === undefined
      ? policy.maxCostPerTurnUsd
      : Math.min(request.maxCostUsd, policy.maxCostPerTurnUsd);
    applied.push(`Tran chi phi moi luot: $${next.maxCostUsd}.`);
  }
  if (policy.maxLatencyMs !== undefined) {
    next.maxLatencyMs = request.maxLatencyMs === undefined
      ? policy.maxLatencyMs
      : Math.min(request.maxLatencyMs, policy.maxLatencyMs);
    applied.push(`Tran do tre: ${next.maxLatencyMs}ms.`);
  }
  if (policy.minQuality !== undefined) {
    next.minQuality = request.minQuality === undefined
      ? policy.minQuality
      : Math.max(request.minQuality, policy.minQuality);
    applied.push(`Chat luong toi thieu: ${next.minQuality}.`);
  }
  if (policy.deniedProviders !== undefined && policy.deniedProviders.length > 0) {
    next.excludeProviders = [...new Set([...(request.excludeProviders ?? []), ...policy.deniedProviders])];
    applied.push(`Loai provider: ${policy.deniedProviders.join(', ')}.`);
  }
  if (policy.deniedModels !== undefined && policy.deniedModels.length > 0) {
    next.excludeModelIds = [...new Set([...(request.excludeModelIds ?? []), ...policy.deniedModels])];
    applied.push(`Loai model: ${policy.deniedModels.join(', ')}.`);
  }
  if (policy.preferLocal === true) next.preferLocal = true;
  return { request: next, applied };
}

/**
 * Store policy theo bot (in-memory; host luu neu can).
 * Bot chua co policy rieng thi dung policy mac dinh (mo).
 */
export class BotRoutingPolicyStoreV29 {
  private policies = new Map<string, BotRoutingPolicyV29>();

  set(policy: BotRoutingPolicyV29): BotRoutingPolicyValidationV29 {
    const normalized = normalizeBotRoutingPolicyV29(policy);
    const validation = validateBotRoutingPolicyV29(normalized);
    if (!validation.ok) return validation;
    this.policies.set(normalized.botId, normalized);
    return validation;
  }

  get(botId: string): BotRoutingPolicyV29 {
    return this.policies.get(botId) ?? defaultBotRoutingPolicyV29(botId);
  }

  has(botId: string): boolean {
    return this.policies.has(botId);
  }

  remove(botId: string): boolean {
    return this.policies.delete(botId);
  }

  list(): BotRoutingPolicyV29[] {
    return [...this.policies.values()].sort((a, b) => a.botId.localeCompare(b.botId));
  }

  get size(): number {
    return this.policies.size;
  }
}
