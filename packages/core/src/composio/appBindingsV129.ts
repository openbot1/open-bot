/**
 * Composio app bindings v1.29 (v1.29, Doi T4 — Composio v6).
 *
 * Gan app (toolkit Composio) vao tung conversation: conversation nao
 * duoc dung app nao, voi quyen gi (read/write), co bi tat khong, co
 * gan voi sandbox boundary nao khong. Sandbox v129 (sandboxV129.ts)
 * gioi han TAI NGUYEN; binding o day quyet dinh APP NAO DUOC DUNG —
 * hai lop kiem tra doc lap, ca hai deu phai cho phep thi call moi
 * chay (defense in depth).
 *
 * Thiet ke:
 * - Binding la du lieu thuan + store trong bo nho. Moi (conversation,
 *   toolkit) toi da mot binding — bind lai thi cap nhat (upsert),
 *   khong tao trung.
 * - Scope: 'read' cho tool doc, 'write' cho tool ghi. Tool ghi can
 *   scope write; tool doc chi can read (hoac write — write bao ham
 *   read). Binding tat (enabled=false) thi ca doc lan ghi deu bi chan.
 * - Effective resolution: binding cua conversation thang default
 *   cua may (machine defaults do host dua vao — vd mac dinh chi bat
 *   mock toolkits v129 o che do read). Khong co binding nao + khong
 *   co default -> app khong duoc dung (fail-closed).
 * - Moi thay doi ghi audit (append-only, cap 200 entry/store) de
 *   truy vet ai bat/tat app nao, khi nao.
 * - Param mac dinh theo app (defaultParams): gia tri mac dinh cho
 *   param cua tool, duoc kiem tra truoc voi bang paramNames v129
 *   (param la -> tu choi luu, bao loi ngay). Khi goi tool, param
 *   cua call thang defaultParams, defaultParams thang gia tri mac
 *   dinh cua tool (call > binding > tool default).
 */

import {
  mockComposioV129ParamNames,
  mockComposioV129ToolNeedsApproval,
  type ComposioV129MockToolkitDef,
} from './toolkitsV129';
import { COMPOSIO_V129_MOCK_TOOLKITS } from './toolkitsV129';

/** Version checkpoint JSON cua app bindings v129. */
export const COMPOSIO_V129_BINDINGS_VERSION = 1;

/** So audit entry toi da giu lai trong store. */
export const COMPOSIO_V129_BINDINGS_MAX_AUDIT_ENTRIES = 200;

/** Quyen cua mot binding. */
export type ComposioV129AppScope = 'read' | 'write';

/** Loai hanh dong audit cua binding. */
export type ComposioV129BindingAuditAction =
  | 'bound'
  | 'unbound'
  | 'enabled'
  | 'disabled'
  | 'scopes-changed'
  | 'defaults-changed';

export interface ComposioV129BindingAuditEntry {
  seq: number;
  atMs: number;
  conversationId: string;
  toolkit: string;
  action: ComposioV129BindingAuditAction;
  detail: string;
}

/** Mot binding app -> conversation. */
export interface ComposioV129AppBinding {
  id: string;
  conversationId: string;
  toolkit: string;
  scopes: ComposioV129AppScope[];
  enabled: boolean;
  /** Sandbox boundary id ma binding nay gan vao (neu co). */
  sandboxBoundaryId?: string;
  /** Param mac dinh cho tool cua app (da kiem tra ten param). */
  defaultParams: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Input bind (upsert) mot app vao conversation. */
export interface ComposioV129BindAppInput {
  conversationId: string;
  toolkit: string;
  scopes?: ComposioV129AppScope[];
  enabled?: boolean;
  sandboxBoundaryId?: string;
  defaultParams?: Record<string, unknown>;
  id?: string;
}

/** Id xac dinh tu seed (de test/dedupe). */
export function composioV129BindingId(conversationId: string, toolkit: string): string {
  return `bind-v129-${conversationId}:${toolkit}`;
}

/** Tool ghi can scope write; tool doc chi can read (write bao ham read). */
export function composioV129ScopeForSlug(slug: string): ComposioV129AppScope {
  return mockComposioV129ToolNeedsApproval(slug) ? 'write' : 'read';
}

/** true khi tap scope dap ung scope can thiet (write bao ham read). */
export function composioV129ScopesCover(
  scopes: readonly ComposioV129AppScope[],
  needed: ComposioV129AppScope,
): boolean {
  if (needed === 'read') return scopes.includes('read') || scopes.includes('write');
  return scopes.includes('write');
}

/**
 * Kiem tra defaultParams cua mot toolkit: param nao khong co trong
 * bang paramNames cua bat ky slug nao cua toolkit thi bi tu choi.
 * Tra danh sach ten param la (rong = hop le). Toolkit khong phai
 * mock v129 (toolkit live hoac mock cu) thi khong kiem tra (tra []),
 * vi bang paramNames chi co cho v129.
 */
export function validateComposioV129BindingDefaultParams(
  toolkit: string,
  defaultParams: Record<string, unknown>,
): string[] {
  const def: ComposioV129MockToolkitDef | undefined = COMPOSIO_V129_MOCK_TOOLKITS.find(
    (t) => t.slug === toolkit,
  );
  if (!def) return [];
  const known = new Set<string>();
  for (const slug of def.candidateToolSlugs) {
    for (const name of mockComposioV129ParamNames(slug) ?? []) known.add(name);
  }
  return Object.keys(defaultParams).filter((name) => !known.has(name));
}

/**
 * Gop param theo thu tu uu tien: call thang binding, binding thang
 * tool default. Param call co gia tri undefined thi khong ghi de.
 */
export function resolveComposioV129EffectiveParams(
  callArgs: Record<string, unknown>,
  bindingDefaults: Record<string, unknown>,
  toolDefaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...toolDefaults, ...bindingDefaults };
  for (const [key, value] of Object.entries(callArgs)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Validate mot binding — tra danh sach loi, rong = hop le. */
export function validateComposioV129AppBinding(binding: unknown): string[] {
  const errors: string[] = [];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    errors.push('binding must be an object');
    return errors;
  }
  const b = binding as Record<string, unknown>;
  if (typeof b['id'] !== 'string' || (b['id'] as string).trim() === '') errors.push('id must be a non-empty string');
  if (typeof b['conversationId'] !== 'string' || (b['conversationId'] as string).trim() === '') errors.push('conversationId must be a non-empty string');
  if (typeof b['toolkit'] !== 'string' || (b['toolkit'] as string).trim() === '') errors.push('toolkit must be a non-empty string');
  if (!Array.isArray(b['scopes']) || (b['scopes'] as unknown[]).length === 0) {
    errors.push('scopes must be a non-empty array');
  } else if ((b['scopes'] as unknown[]).some((s) => s !== 'read' && s !== 'write')) {
    errors.push("scopes must only contain 'read'/'write'");
  }
  if (typeof b['enabled'] !== 'boolean') errors.push('enabled must be a boolean');
  if (b['sandboxBoundaryId'] !== undefined && typeof b['sandboxBoundaryId'] !== 'string') errors.push('sandboxBoundaryId must be a string when given');
  if (typeof b['defaultParams'] !== 'object' || b['defaultParams'] === null || Array.isArray(b['defaultParams'])) {
    errors.push('defaultParams must be an object');
  }
  if (typeof b['createdAtMs'] !== 'number' || !Number.isFinite(b['createdAtMs'] as number)) errors.push('createdAtMs must be a finite number');
  if (typeof b['updatedAtMs'] !== 'number' || !Number.isFinite(b['updatedAtMs'] as number)) errors.push('updatedAtMs must be a finite number');
  return errors;
}

/**
 * Tao binding moi tu input (chua luu store). Throw khi input khong
 * hop le hoac defaultParams co param la.
 */
export function createComposioV129AppBinding(
  input: ComposioV129BindAppInput,
  nowMs: number,
): ComposioV129AppBinding {
  if (!input || typeof input !== 'object') throw new Error('Invalid Composio v129 binding: input must be an object');
  if (typeof input.conversationId !== 'string' || input.conversationId.trim() === '') {
    throw new Error('Invalid Composio v129 binding: conversationId must be a non-empty string');
  }
  if (typeof input.toolkit !== 'string' || input.toolkit.trim() === '') {
    throw new Error('Invalid Composio v129 binding: toolkit must be a non-empty string');
  }
  const scopes = input.scopes ?? ['read'];
  if (scopes.length === 0 || scopes.some((s) => s !== 'read' && s !== 'write')) {
    throw new Error("Invalid Composio v129 binding: scopes must only contain 'read'/'write' and not be empty");
  }
  const defaultParams = { ...(input.defaultParams ?? {}) };
  const unknownParams = validateComposioV129BindingDefaultParams(input.toolkit, defaultParams);
  if (unknownParams.length > 0) {
    throw new Error(
      `Invalid Composio v129 binding defaultParams for ${input.toolkit}: unknown params: ${unknownParams.join(', ')}`,
    );
  }
  return {
    id: input.id ?? composioV129BindingId(input.conversationId, input.toolkit),
    conversationId: input.conversationId,
    toolkit: input.toolkit,
    scopes: [...new Set(scopes)],
    enabled: input.enabled ?? true,
    ...(input.sandboxBoundaryId ? { sandboxBoundaryId: input.sandboxBoundaryId } : {}),
    defaultParams,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Ket qua kiem tra mot tool co duoc goi trong conversation khong. */
export interface ComposioV129BindingCheck {
  allowed: boolean;
  /** Ly do tu choi (khi allowed = false). */
  reason?: string;
  /** Binding da dung de quyet dinh (undefined khi dung default). */
  binding?: ComposioV129AppBinding;
  /** Scope can thiet cua slug. */
  neededScope: ComposioV129AppScope;
}

/**
 * Kiem tra mot tool (toolkit+slug) co duoc goi trong conversation
 * khong, dua tren binding cua conversation (neu co) hoac default
 * cua may (neu khong co binding). Fail-closed: khong binding nao
 * dap ung -> deny.
 */
export function checkComposioV129AppBinding(
  bindings: readonly ComposioV129AppBinding[],
  conversationId: string,
  toolkit: string,
  slug: string,
  machineDefaults: readonly ComposioV129AppBinding[] = [],
): ComposioV129BindingCheck {
  const neededScope = composioV129ScopeForSlug(slug);
  const binding = bindings.find((b) => b.conversationId === conversationId && b.toolkit === toolkit);
  if (binding) {
    if (!binding.enabled) {
      return { allowed: false, reason: `App '${toolkit}' is disabled in this conversation.`, binding, neededScope };
    }
    if (!composioV129ScopesCover(binding.scopes, neededScope)) {
      return {
        allowed: false,
        reason: `App '${toolkit}' lacks '${neededScope}' scope in this conversation (has: ${binding.scopes.join(', ')}).`,
        binding,
        neededScope,
      };
    }
    return { allowed: true, binding, neededScope };
  }
  const fallback = machineDefaults.find((b) => b.toolkit === toolkit);
  if (!fallback) {
    return { allowed: false, reason: `App '${toolkit}' is not bound to this conversation (no binding, no machine default).`, neededScope };
  }
  if (!fallback.enabled) {
    return { allowed: false, reason: `App '${toolkit}' is disabled by machine default.`, binding: fallback, neededScope };
  }
  if (!composioV129ScopesCover(fallback.scopes, neededScope)) {
    return {
      allowed: false,
      reason: `Machine default for '${toolkit}' lacks '${neededScope}' scope (has: ${fallback.scopes.join(', ')}).`,
      binding: fallback,
      neededScope,
    };
  }
  return { allowed: true, binding: fallback, neededScope };
}

/**
 * Default cua may cho mock toolkits v129: bat tat ca o che do read
 * (chi doc), khong write — user/bot phai bind rieng neu muon ghi.
 * Host co the dua default khac (vd tat het) khi resolve.
 */
export function defaultComposioV129MachineBindings(nowMs: number): ComposioV129AppBinding[] {
  return COMPOSIO_V129_MOCK_TOOLKITS.map((toolkit) => ({
    id: `machine-default-v129-${toolkit.slug}`,
    conversationId: '*',
    toolkit: toolkit.slug,
    scopes: ['read'] as ComposioV129AppScope[],
    enabled: true,
    defaultParams: {},
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  }));
}

/**
 * App nao dang hieu luc trong conversation (binding bat + scope),
 * ke ca default cua may khi conversation chua bind rieng.
 */
export function listComposioV129EffectiveApps(
  bindings: readonly ComposioV129AppBinding[],
  conversationId: string,
  machineDefaults: readonly ComposioV129AppBinding[] = [],
): { toolkit: string; scopes: ComposioV129AppScope[]; source: 'conversation' | 'machine-default' }[] {
  const seen = new Set<string>();
  const out: { toolkit: string; scopes: ComposioV129AppScope[]; source: 'conversation' | 'machine-default' }[] = [];
  for (const binding of bindings) {
    if (binding.conversationId !== conversationId || !binding.enabled) continue;
    seen.add(binding.toolkit);
    out.push({ toolkit: binding.toolkit, scopes: [...binding.scopes], source: 'conversation' });
  }
  for (const fallback of machineDefaults) {
    if (!fallback.enabled || seen.has(fallback.toolkit)) continue;
    seen.add(fallback.toolkit);
    out.push({ toolkit: fallback.toolkit, scopes: [...fallback.scopes], source: 'machine-default' });
  }
  return out.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
}

/** Tom tat binding cho UI. */
export function summarizeComposioV129Bindings(
  bindings: readonly ComposioV129AppBinding[],
  conversationId?: string,
): {
  total: number;
  enabled: number;
  disabled: number;
  byToolkit: { toolkit: string; conversations: number; enabled: number }[];
  conversations: string[];
} {
  const filtered = conversationId
    ? bindings.filter((b) => b.conversationId === conversationId)
    : [...bindings];
  const byToolkitMap = new Map<string, { toolkit: string; conversations: number; enabled: number }>();
  const conversations = new Set<string>();
  for (const binding of filtered) {
    conversations.add(binding.conversationId);
    const entry = byToolkitMap.get(binding.toolkit) ?? { toolkit: binding.toolkit, conversations: 0, enabled: 0 };
    entry.conversations += 1;
    if (binding.enabled) entry.enabled += 1;
    byToolkitMap.set(binding.toolkit, entry);
  }
  return {
    total: filtered.length,
    enabled: filtered.filter((b) => b.enabled).length,
    disabled: filtered.filter((b) => !b.enabled).length,
    byToolkit: [...byToolkitMap.values()].sort((a, b) => a.toolkit.localeCompare(b.toolkit)),
    conversations: [...conversations].sort(),
  };
}

// ---------------------------------------------------------------------------
// Store trong bo nho — host giu mot instance dung chung trong session
// ---------------------------------------------------------------------------

/**
 * Store binding trong bo nho (key: conversationId + toolkit).
 * Bind lai cung (conversation, toolkit) thi upsert (ghi de, giu
 * createdAtMs cu). Moi thay doi ghi audit.
 */
export class MemoryComposioV129BindingStore {
  private readonly bindings = new Map<string, ComposioV129AppBinding>();
  private readonly audit: ComposioV129BindingAuditEntry[] = [];

  private key(conversationId: string, toolkit: string): string {
    return `${conversationId}\x00${toolkit}`;
  }

  private log(
    atMs: number,
    conversationId: string,
    toolkit: string,
    action: ComposioV129BindingAuditAction,
    detail: string,
  ): void {
    const seq = this.audit.length > 0 ? this.audit[this.audit.length - 1]!.seq + 1 : 1;
    this.audit.push({ seq, atMs, conversationId, toolkit, action, detail });
    if (this.audit.length > COMPOSIO_V129_BINDINGS_MAX_AUDIT_ENTRIES) {
      this.audit.splice(0, this.audit.length - COMPOSIO_V129_BINDINGS_MAX_AUDIT_ENTRIES);
    }
  }

  bind(input: ComposioV129BindAppInput, nowMs: number): ComposioV129AppBinding {
    const key = this.key(input.conversationId, input.toolkit);
    const existing = this.bindings.get(key);
    const created = createComposioV129AppBinding(input, nowMs);
    const next: ComposioV129AppBinding = existing
      ? { ...created, createdAtMs: existing.createdAtMs, id: existing.id }
      : created;
    this.bindings.set(key, next);
    this.log(
      nowMs,
      next.conversationId,
      next.toolkit,
      existing ? 'scopes-changed' : 'bound',
      existing
        ? `Binding updated: scopes=${next.scopes.join(',')}, enabled=${next.enabled}.`
        : `App '${next.toolkit}' bound to conversation ${next.conversationId} (scopes=${next.scopes.join(',')}).`,
    );
    return next;
  }

  unbind(conversationId: string, toolkit: string, nowMs: number): boolean {
    const key = this.key(conversationId, toolkit);
    if (!this.bindings.has(key)) return false;
    this.bindings.delete(key);
    this.log(nowMs, conversationId, toolkit, 'unbound', `App '${toolkit}' unbound from conversation ${conversationId}.`);
    return true;
  }

  setEnabled(conversationId: string, toolkit: string, enabled: boolean, nowMs: number): ComposioV129AppBinding | undefined {
    const key = this.key(conversationId, toolkit);
    const binding = this.bindings.get(key);
    if (!binding) return undefined;
    const next: ComposioV129AppBinding = { ...binding, enabled, updatedAtMs: nowMs };
    this.bindings.set(key, next);
    this.log(nowMs, conversationId, toolkit, enabled ? 'enabled' : 'disabled', `App '${toolkit}' ${enabled ? 'enabled' : 'disabled'} in conversation ${conversationId}.`);
    return next;
  }

  get(conversationId: string, toolkit: string): ComposioV129AppBinding | undefined {
    return this.bindings.get(this.key(conversationId, toolkit));
  }

  listForConversation(conversationId: string): ComposioV129AppBinding[] {
    return [...this.bindings.values()]
      .filter((b) => b.conversationId === conversationId)
      .sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  }

  listAll(): ComposioV129AppBinding[] {
    return [...this.bindings.values()].sort((a, b) =>
      a.conversationId === b.conversationId
        ? a.toolkit.localeCompare(b.toolkit)
        : a.conversationId.localeCompare(b.conversationId),
    );
  }

  size(): number {
    return this.bindings.size;
  }

  auditLog(): ComposioV129BindingAuditEntry[] {
    return [...this.audit];
  }

  check(
    conversationId: string,
    toolkit: string,
    slug: string,
    machineDefaults: readonly ComposioV129AppBinding[] = [],
  ): ComposioV129BindingCheck {
    return checkComposioV129AppBinding(this.listAll(), conversationId, toolkit, slug, machineDefaults);
  }

  summary(conversationId?: string): ReturnType<typeof summarizeComposioV129Bindings> {
    return summarizeComposioV129Bindings(this.listAll(), conversationId);
  }

  snapshot(): string {
    return JSON.stringify({
      version: COMPOSIO_V129_BINDINGS_VERSION,
      bindings: this.listAll(),
      audit: this.audit,
    });
  }

  restore(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Invalid Composio v129 bindings snapshot: not JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid Composio v129 bindings snapshot: expected an object');
    }
    const { version, bindings, audit } = parsed as { version?: unknown; bindings?: unknown; audit?: unknown };
    if (version !== COMPOSIO_V129_BINDINGS_VERSION) {
      throw new Error(`Unsupported Composio v129 bindings snapshot version: ${String(version)}`);
    }
    if (!Array.isArray(bindings)) throw new Error('Invalid Composio v129 bindings snapshot: bindings must be an array');
    if (audit !== undefined && !Array.isArray(audit)) throw new Error('Invalid Composio v129 bindings snapshot: audit must be an array');
    const next = new Map<string, ComposioV129AppBinding>();
    for (const binding of bindings) {
      const errors = validateComposioV129AppBinding(binding);
      if (errors.length > 0) throw new Error(`Invalid Composio v129 binding in snapshot: ${errors.join('; ')}`);
      const typed = binding as ComposioV129AppBinding;
      const key = this.key(typed.conversationId, typed.toolkit);
      if (next.has(key)) throw new Error(`Duplicate Composio v129 binding in snapshot: ${typed.conversationId}/${typed.toolkit}`);
      next.set(key, typed);
    }
    this.bindings.clear();
    for (const [key, value] of next) this.bindings.set(key, value);
    this.audit.length = 0;
    if (Array.isArray(audit)) {
      for (const entry of audit as ComposioV129BindingAuditEntry[]) this.audit.push(entry);
    }
  }
}
