/**
 * Router policy theo bot (v1.41, Doi T3).
 *
 * Moi bot co policy rieng gioi han tool nao duoc goi, provider nao
 * duoc dung, script programmatic co duoc chay khong, va chi phi toi
 * da — gop (merge) voi policy mac dinh toan cuc theo quy tac chat
 * nhat thang (deny thang allow, gioi han nho nhat thang).
 *
 * Thuan logic (khong goi model that, khong doc credential). Host luu
 * policy (file/vault) va truyen vao; module nay chi validate, merge
 * va tra loi "co duoc phep khong + vi sao".
 */

import type { RouterV118ProviderId } from './toolChoiceV118';

/** Policy cua mot bot (tat ca truong deu optional khi nhap vao). */
export interface BotRouterPolicyInput {
  botId: string;
  /** Tool duoc phep (undefined = khong gioi han o muc bot). */
  allowTools?: readonly string[];
  /** Tool bi cam (luon thang allowTools). */
  denyTools?: readonly string[];
  /** Provider duoc phep (undefined = tat ca provider mac dinh cho phep). */
  allowProviders?: readonly string[];
  /** Provider bi cam (luon thang allowProviders). */
  denyProviders?: readonly string[];
  /** Co cho chay script programmatic tool calling khong. */
  allowScript?: boolean;
  /** So tool call toi da trong mot turn (0 = khong gioi han o muc bot). */
  maxToolsPerTurn?: number;
  /** So tool call toi da trong mot script (0 = dung mac dinh 32). */
  maxScriptCalls?: number;
  /** Chi phi toi da (USD) cho mot turn (0 = khong gioi han). */
  maxCostUsdPerTurn?: number;
  /** Tool bat buoc phai xac nhan truoc khi chay (them vao confirm policy). */
  requireConfirmTools?: readonly string[];
  /** Ghi chu cua nguoi dat policy (hien thi trong UI). */
  note?: string;
}

/** Policy cua mot bot sau khi chuan hoa (day du truong). */
export interface BotRouterPolicy {
  botId: string;
  allowTools: readonly string[] | null;
  denyTools: readonly string[];
  allowProviders: readonly string[] | null;
  denyProviders: readonly string[];
  allowScript: boolean;
  maxToolsPerTurn: number;
  maxScriptCalls: number;
  maxCostUsdPerTurn: number;
  requireConfirmTools: readonly string[];
  note: string;
}

/** Policy mac dinh toan cuc (khi bot chua dat policy rieng). */
export function defaultBotRouterPolicy(botId: string): BotRouterPolicy {
  return {
    botId,
    allowTools: null,
    denyTools: [],
    allowProviders: null,
    denyProviders: [],
    allowScript: true,
    maxToolsPerTurn: 0,
    maxScriptCalls: 32,
    maxCostUsdPerTurn: 0,
    requireConfirmTools: [],
    note: '',
  };
}

export interface PolicyValidation {
  ok: boolean;
  errors: string[];
}

/** Validate mot policy nhap vao (khong throw, tra loi). */
export function validateBotRouterPolicy(input: BotRouterPolicyInput): PolicyValidation {
  const errors: string[] = [];
  if (typeof input.botId !== 'string' || input.botId.trim() === '') {
    errors.push('botId khong duoc rong.');
  }
  const checkNames = (names: readonly string[] | undefined, field: string): void => {
    for (const name of names ?? []) {
      if (typeof name !== 'string' || name.trim() === '') {
        errors.push(`${field} chua ten rong.`);
      } else if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        errors.push(`${field} chua ten khong hop le: "${name}".`);
      }
    }
  };
  checkNames(input.allowTools, 'allowTools');
  checkNames(input.denyTools, 'denyTools');
  checkNames(input.requireConfirmTools, 'requireConfirmTools');
  for (const provider of input.allowProviders ?? []) {
    if (typeof provider !== 'string' || provider.trim() === '') {
      errors.push('allowProviders chua provider rong.');
    }
  }
  for (const provider of input.denyProviders ?? []) {
    if (typeof provider !== 'string' || provider.trim() === '') {
      errors.push('denyProviders chua provider rong.');
    }
  }
  const checkNonNegative = (value: number | undefined, field: string): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      errors.push(`${field} phai la so >= 0.`);
    }
  };
  checkNonNegative(input.maxToolsPerTurn, 'maxToolsPerTurn');
  checkNonNegative(input.maxScriptCalls, 'maxScriptCalls');
  checkNonNegative(input.maxCostUsdPerTurn, 'maxCostUsdPerTurn');
  if (
    input.maxToolsPerTurn !== undefined &&
    input.maxScriptCalls !== undefined &&
    input.maxToolsPerTurn > 0 &&
    input.maxScriptCalls > input.maxToolsPerTurn
  ) {
    errors.push('maxScriptCalls khong duoc lon hon maxToolsPerTurn (script nam trong turn).');
  }
  const overlapTools = (input.allowTools ?? []).filter((t) => (input.denyTools ?? []).includes(t));
  if (overlapTools.length > 0) {
    errors.push(`Tool vua allow vua deny: ${overlapTools.join(', ')} (deny se thang).`);
  }
  const overlapProviders = (input.allowProviders ?? []).filter((p) => (input.denyProviders ?? []).includes(p));
  if (overlapProviders.length > 0) {
    errors.push(`Provider vua allow vua deny: ${overlapProviders.join(', ')} (deny se thang).`);
  }
  return { ok: errors.length === 0, errors };
}

/** Chuan hoa policy nhap vao thanh policy day du (sort + dedupe). */
export function normalizeBotRouterPolicy(input: BotRouterPolicyInput): BotRouterPolicy {
  const unique = (names: readonly string[] | undefined): string[] => [
    ...new Set((names ?? []).map((n) => n.trim()).filter((n) => n !== '')),
  ].sort();
  return {
    botId: input.botId.trim(),
    allowTools: input.allowTools === undefined ? null : unique(input.allowTools),
    denyTools: unique(input.denyTools),
    allowProviders: input.allowProviders === undefined ? null : unique(input.allowProviders),
    denyProviders: unique(input.denyProviders),
    allowScript: input.allowScript ?? true,
    maxToolsPerTurn: input.maxToolsPerTurn ?? 0,
    maxScriptCalls: input.maxScriptCalls ?? 32,
    maxCostUsdPerTurn: input.maxCostUsdPerTurn ?? 0,
    requireConfirmTools: unique(input.requireConfirmTools),
    note: input.note ?? '',
  };
}

/**
 * Gop policy bot voi policy mac dinh toan cuc — quy tac chat nhat:
 * - allow: giao nhau (chi tool ca hai ben deu cho moi duoc phep);
 *   neu mot ben khong gioi han (null) thi lay ben kia.
 * - deny: hop nhat.
 * - Gioi han so: lay min cua cac gioi han > 0 (0 = khong gioi han).
 * - allowScript: ca hai deu true moi true.
 */
export function mergeBotRouterPolicies(
  base: BotRouterPolicy,
  override: BotRouterPolicy,
): BotRouterPolicy {
  const intersectAllow = (
    a: readonly string[] | null,
    b: readonly string[] | null,
  ): readonly string[] | null => {
    if (a === null) return b;
    if (b === null) return a;
    return a.filter((x) => b.includes(x));
  };
  const minPositive = (a: number, b: number): number => {
    if (a <= 0) return b;
    if (b <= 0) return a;
    return Math.min(a, b);
  };
  return {
    botId: override.botId,
    allowTools: intersectAllow(base.allowTools, override.allowTools),
    denyTools: [...new Set([...base.denyTools, ...override.denyTools])].sort(),
    allowProviders: intersectAllow(base.allowProviders, override.allowProviders),
    denyProviders: [...new Set([...base.denyProviders, ...override.denyProviders])].sort(),
    allowScript: base.allowScript && override.allowScript,
    maxToolsPerTurn: minPositive(base.maxToolsPerTurn, override.maxToolsPerTurn),
    maxScriptCalls: minPositive(base.maxScriptCalls, override.maxScriptCalls),
    maxCostUsdPerTurn: minPositive(base.maxCostUsdPerTurn, override.maxCostUsdPerTurn),
    requireConfirmTools: [...new Set([...base.requireConfirmTools, ...override.requireConfirmTools])].sort(),
    note: override.note || base.note,
  };
}

/** Ket qua kiem tra quyen goi tool. */
export interface ToolAllowedCheck {
  allowed: boolean;
  reason: string;
}

export function isToolAllowed(policy: BotRouterPolicy, toolName: string): ToolAllowedCheck {
  if (policy.denyTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" bi cam trong policy cua bot ${policy.botId}.` };
  }
  if (policy.allowTools !== null && !policy.allowTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" khong co trong allowlist cua bot ${policy.botId}.` };
  }
  return { allowed: true, reason: `Tool "${toolName}" duoc phep.` };
}

export function isProviderAllowed(
  policy: BotRouterPolicy,
  provider: string,
): ToolAllowedCheck {
  if (policy.denyProviders.includes(provider)) {
    return { allowed: false, reason: `Provider "${provider}" bi cam trong policy cua bot ${policy.botId}.` };
  }
  if (policy.allowProviders !== null && !policy.allowProviders.includes(provider)) {
    return { allowed: false, reason: `Provider "${provider}" khong co trong allowlist cua bot ${policy.botId}.` };
  }
  return { allowed: true, reason: `Provider "${provider}" duoc phep.` };
}

/** Loc danh sach tool theo policy bot (chi giu tool duoc phep). */
export function filterToolsByPolicy(
  policy: BotRouterPolicy,
  toolNames: readonly string[],
): { allowed: string[]; denied: { name: string; reason: string }[] } {
  const allowed: string[] = [];
  const denied: { name: string; reason: string }[] = [];
  for (const name of toolNames) {
    const check = isToolAllowed(policy, name);
    if (check.allowed) allowed.push(name);
    else denied.push({ name, reason: check.reason });
  }
  return { allowed, denied };
}

/** Store policy theo bot (in-memory; host luu xuong dia neu can). */
export class BotPolicyStore {
  private readonly policies = new Map<string, BotRouterPolicy>();
  private global: BotRouterPolicy = defaultBotRouterPolicy('__global__');

  setGlobal(policy: BotRouterPolicyInput): PolicyValidation {
    const validation = validateBotRouterPolicy({ ...policy, botId: '__global__' });
    if (!validation.ok) return validation;
    this.global = normalizeBotRouterPolicy({ ...policy, botId: '__global__' });
    return { ok: true, errors: [] };
  }

  getGlobal(): BotRouterPolicy {
    return this.global;
  }

  setBot(policy: BotRouterPolicyInput): PolicyValidation {
    const validation = validateBotRouterPolicy(policy);
    if (!validation.ok) return validation;
    this.policies.set(policy.botId.trim(), normalizeBotRouterPolicy(policy));
    return { ok: true, errors: [] };
  }

  getBot(botId: string): BotRouterPolicy | null {
    return this.policies.get(botId) ?? null;
  }

  /** Policy hieu dung cua bot = global merge voi policy rieng (chat nhat thang). */
  effectivePolicy(botId: string): BotRouterPolicy {
    const own = this.policies.get(botId);
    if (!own) return { ...this.global, botId };
    return mergeBotRouterPolicies(this.global, own);
  }

  removeBot(botId: string): boolean {
    return this.policies.delete(botId);
  }

  listBotIds(): string[] {
    return [...this.policies.keys()].sort();
  }

  count(): number {
    return this.policies.size;
  }
}

/** Provider id hop le theo ma tran v118 (de validate allowProviders). */
export function isKnownRouterV118Provider(provider: string): provider is RouterV118ProviderId {
  return (['anthropic', 'openai', 'gemini', 'xai', 'deepseek', 'ollama', 'llamacpp', 'vllm', 'sglang', 'openai-compatible'] as readonly string[]).includes(provider);
}
