/**
 * Composio toolkit prefs v2 — bat/tat theo ACTION + default
 * params + hien thi quota (v1.20, Doi T4).
 *
 * Tang tren toolkitPrefsV119.ts — KHONG viet lai:
 * - Prefs v119 (bat/tat THEO TOOLKIT, theo user, mac dinh bat,
 *   tang may van thang) van la lop bat/tat toolkit. V2 KHONG
 *   doi nghia cua no: `isComposioV119ToolkitEnabledForUser` /
 *   `effectiveComposioV119ToolkitEnabledForUser` van quyet dinh
 *   toolkit co bat cho user khong.
 * - Store v119 (memory + JSON file) van giu cau hinh v119.
 *
 * Moi trong v2 (lop chi tiet ben DUOI muc toolkit):
 * 1. Bat/tat theo ACTION (slug): trong mot toolkit dang bat,
 *    user tat rieng tung action (vd tat GMAIL_SEND_EMAIL nhung
 *    van doc mail). Mac dinh (chua cau hinh) = bat — giong
 *    triet ly v119: user moi thay day du, chi tat cai khong
 *    muon. Slug phai thuoc toolkit do (live verified hoac mock
 *    v110–v120) — slug la thi bao loi ngay, khong doi toi luc
 *    chay.
 * 2. Default params theo action: user dat san param mac dinh
 *    cho mot action (vd TRELLO_CREATE_CARD luon `listId` co
 *    dinh). Khi chay, param goi that de len default (call
 *    thang default). Voi slug mock v120 co bang `paramNames`
 *    thi ten param la phai nam trong bang — bao loi ngay khi
 *    luu. Gia tri param phai la JSON (string/number/boolean/
 *    null/array/object phang) — khong nhan function/undefined.
 * 3. Hieu luc gop 3 tang: may (toolkitConnections) AND toolkit
 *    (v119) AND action (v2) — `effectiveComposioV120ActionEnabledForUser`
 *    tra false chi can 1 tang tat. Host chi can hoi 1 ham.
 * 4. Hien thi quota trong UI prefs: `buildComposioV120ToolkitQuotaViews`
 *    gop usage v2 (soft-limit + headroom) thanh view-model
 *    theo toolkit de Settings hien: dung bao nhieu/cap bao
 *    nhieu/con lai bao nhieu + top action — user biet tai sao
 *    action bi chan (quota) hay bi tat (prefs).
 * 5. Audit + store rieng: moi lan doi pref v2 ghi 1 dong audit
 *    (user + toolkit + action + cu → moi + ly do); file rieng
 *    `composio-toolkit-prefs-v120.json` (mode 0600) de khong
 *    pha file v119.
 *
 * Module nay chi giu CAU HINH. Viec co goi action hay khong do
 * host quyet dinh dua tren `effective...` + quota.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPOSIO_TOOLKITS } from './toolkits';
import { COMPOSIO_V110_MOCK_TOOLKITS } from './toolkitsV110';
import { COMPOSIO_V111_MOCK_TOOLKITS } from './toolkitsV111';
import { COMPOSIO_V112_MOCK_TOOLKITS } from './toolkitsV112';
import { COMPOSIO_V114_MOCK_TOOLKITS } from './toolkitsV114';
import { COMPOSIO_V118_MOCK_TOOLKITS } from './toolkitsV118';
import { COMPOSIO_V119_MOCK_TOOLKITS } from './toolkitsV119';
import { COMPOSIO_V120_MOCK_TOOLKITS, mockComposioV120ParamNames } from './toolkitsV120';
import {
  COMPOSIO_V119_MAX_REASON_CHARS,
  effectiveComposioV119ToolkitEnabledForUser,
  isComposioV119ToolkitEnabledForUser,
  type ComposioV119UserToolkitPrefs,
} from './toolkitPrefsV119';
import {
  buildComposioV120UsageReport,
  checkComposioV120SoftLimits,
  type ComposioV120UsageState,
} from './usageMeteringV120';
import { composioV119UsageDayKey } from './usageMeteringV119';

/** File cau hinh prefs v2 trong thu muc composio cua userData. */
export const COMPOSIO_V120_TOOLKIT_PREFS_FILE = 'composio-toolkit-prefs-v120.json';
/** File audit log prefs v2 (JSONL, append). */
export const COMPOSIO_V120_TOOLKIT_PREFS_AUDIT_FILE = 'composio-toolkit-prefs-audit-v120.jsonl';
/** Phien ban dinh dang file prefs v2. */
export const COMPOSIO_V120_TOOLKIT_PREFS_VERSION = 1;
/** Giu toi da tung nay dong audit. */
export const COMPOSIO_V120_MAX_PREFS_AUDIT_LINES = 500;
/** Giu toi da tung nay user co cau hinh. */
export const COMPOSIO_V120_MAX_PREFS_USERS = 1000;
/** Giu toi da tung nay toolkit moi user. */
export const COMPOSIO_V120_MAX_TOOLKITS_PER_USER = 500;
/** Giu toi da tung nay action cau hinh moi toolkit. */
export const COMPOSIO_V120_MAX_ACTIONS_PER_TOOLKIT = 100;
/** Giu toi da tung nay param mac dinh moi action. */
export const COMPOSIO_V120_MAX_DEFAULT_PARAMS_PER_ACTION = 20;
/** Do dai toi da cua 1 gia tri param mac dinh dang string (ky tu). */
export const COMPOSIO_V120_MAX_DEFAULT_PARAM_VALUE_CHARS = 500;

/** Cau hinh cua MOT action (slug) trong mot toolkit. */
export interface ComposioV120ActionPref {
  /** Slug action, vd 'GMAIL_SEND_EMAIL'. */
  slug: string;
  /** true = user duoc dung action nay (mac dinh true khi chua cau hinh). */
  enabled: boolean;
  /** ms epoch lan doi cau hinh cuoi. */
  updatedAtMs: number;
}

/** Cau hinh v2 cua MOT toolkit doi voi MOT user. */
export interface ComposioV120ToolkitPref {
  /** Slug toolkit, vd 'gmail'. */
  toolkit: string;
  /** true = user duoc dung toolkit nay (mac dinh true khi chua cau hinh). */
  enabled: boolean;
  /** Cau hinh rieng tung action (khong co = mac dinh bat). */
  actions: ComposioV120ActionPref[];
  /** Param mac dinh theo action: slug → { ten param: gia tri }. */
  defaultParams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Ly do user bat/tat toolkit (vd 'khong dung nua'). */
  reason: string | null;
  /** ms epoch lan doi cau hinh cuoi. */
  updatedAtMs: number;
}

/** Cau hinh v2 cua MOT user: map toolkit → pref v2. */
export interface ComposioV120UserToolkitPrefs {
  /** Id user (Composio user id hoac id local). */
  userId: string;
  /** Cac toolkit user da cau hinh rieng o muc v2. */
  toolkits: ComposioV120ToolkitPref[];
}

/** Kiem tra mot action pref (throw neu sai). */
export function validateComposioV120ActionPref(raw: unknown): ComposioV120ActionPref {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120ActionPref must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['slug'] !== 'string' || (rec['slug'] as string).trim() === '') {
    throw new Error('action pref slug must be a non-empty string.');
  }
  if (typeof rec['enabled'] !== 'boolean') throw new Error('action pref enabled must be a boolean.');
  if (typeof rec['updatedAtMs'] !== 'number' || !Number.isFinite(rec['updatedAtMs']) || (rec['updatedAtMs'] as number) < 0) {
    throw new Error('action pref updatedAtMs must be a non-negative number.');
  }
  return { slug: rec['slug'] as string, enabled: rec['enabled'] as boolean, updatedAtMs: rec['updatedAtMs'] as number };
}

/** Kiem tra gia tri param mac dinh co phai JSON hop le khong (throw neu sai). */
export function validateComposioV120DefaultParamValue(value: unknown, name: string): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`default param ${name} must be a JSON value`);
  }
  if (typeof value === 'string' && value.length > COMPOSIO_V120_MAX_DEFAULT_PARAM_VALUE_CHARS) {
    throw new Error(`default param ${name} must be at most ${COMPOSIO_V120_MAX_DEFAULT_PARAM_VALUE_CHARS} chars`);
  }
  if (Array.isArray(value)) {
    for (const item of value) validateComposioV120DefaultParamValue(item, name);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      validateComposioV120DefaultParamValue(v, `${name}.${k}`);
    }
  }
}

/** Kiem tra map default params cua mot action (throw neu sai). */
export function validateComposioV120DefaultParams(
  raw: unknown,
  slug?: string,
): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('default params must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  const names = Object.keys(rec);
  if (names.length > COMPOSIO_V120_MAX_DEFAULT_PARAMS_PER_ACTION) {
    throw new Error(`too many default params (max ${COMPOSIO_V120_MAX_DEFAULT_PARAMS_PER_ACTION})`);
  }
  const expected = slug !== undefined ? mockComposioV120ParamNames(slug) : undefined;
  for (const name of names) {
    if (name.trim() === '') throw new Error('default param name must be a non-empty string');
    if (expected !== undefined && !expected.includes(name)) {
      throw new Error(
        `unknown default param ${name} for ${slug} (expected one of: ${expected.join(', ') || '(none)'})`,
      );
    }
    validateComposioV120DefaultParamValue(rec[name], name);
  }
  return { ...rec };
}

/** Kiem tra mot pref v2 (throw neu sai). */
export function validateComposioV120ToolkitPref(raw: unknown): ComposioV120ToolkitPref {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120ToolkitPref must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('toolkit pref v2 toolkit must be a non-empty string.');
  }
  if (typeof rec['enabled'] !== 'boolean') throw new Error('toolkit pref v2 enabled must be a boolean.');
  if (!Array.isArray(rec['actions'])) throw new Error('toolkit pref v2 actions must be an array.');
  const actions = (rec['actions'] as unknown[]).map((a) => validateComposioV120ActionPref(a));
  if (new Set(actions.map((a) => a.slug)).size !== actions.length) {
    throw new Error('toolkit pref v2 must not contain duplicate action.');
  }
  if (actions.length > COMPOSIO_V120_MAX_ACTIONS_PER_TOOLKIT) {
    throw new Error(`too many actions per toolkit (max ${COMPOSIO_V120_MAX_ACTIONS_PER_TOOLKIT})`);
  }
  if (typeof rec['defaultParams'] !== 'object' || rec['defaultParams'] === null || Array.isArray(rec['defaultParams'])) {
    throw new Error('toolkit pref v2 defaultParams must be an object.');
  }
  const defaultParams: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [slug, params] of Object.entries(rec['defaultParams'] as Record<string, unknown>)) {
    defaultParams[slug] = validateComposioV120DefaultParams(params, slug);
  }
  if (rec['reason'] !== null && typeof rec['reason'] !== 'string') {
    throw new Error('toolkit pref v2 reason must be a string or null.');
  }
  if (typeof rec['reason'] === 'string' && rec['reason'].length > COMPOSIO_V119_MAX_REASON_CHARS) {
    throw new Error(`toolkit pref v2 reason must be at most ${COMPOSIO_V119_MAX_REASON_CHARS} chars.`);
  }
  if (typeof rec['updatedAtMs'] !== 'number' || !Number.isFinite(rec['updatedAtMs']) || (rec['updatedAtMs'] as number) < 0) {
    throw new Error('toolkit pref v2 updatedAtMs must be a non-negative number.');
  }
  return {
    toolkit: rec['toolkit'] as string,
    enabled: rec['enabled'] as boolean,
    actions,
    defaultParams,
    reason: rec['reason'] as string | null,
    updatedAtMs: rec['updatedAtMs'] as number,
  };
}

/** Kiem tra cau hinh v2 cua mot user (throw neu sai). */
export function validateComposioV120UserToolkitPrefs(raw: unknown): ComposioV120UserToolkitPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120UserToolkitPrefs must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') {
    throw new Error('user toolkit prefs v2 userId must be a non-empty string.');
  }
  if (!Array.isArray(rec['toolkits'])) throw new Error('user toolkit prefs v2 toolkits must be an array.');
  const toolkits = (rec['toolkits'] as unknown[]).map((t) => validateComposioV120ToolkitPref(t));
  if (new Set(toolkits.map((t) => t.toolkit)).size !== toolkits.length) {
    throw new Error('user toolkit prefs v2 must not contain duplicate toolkit.');
  }
  if (toolkits.length > COMPOSIO_V120_MAX_TOOLKITS_PER_USER) {
    throw new Error(`too many toolkits per user (max ${COMPOSIO_V120_MAX_TOOLKITS_PER_USER})`);
  }
  return { userId: rec['userId'] as string, toolkits };
}

function assertUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('userId must be a non-empty string');
  }
}

function assertToolkit(toolkit: string): void {
  if (typeof toolkit !== 'string' || toolkit.trim() === '') {
    throw new Error('toolkit must be a non-empty string');
  }
}

function assertSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.trim() === '') {
    throw new Error('slug must be a non-empty string');
  }
}

// ---------------------------------------------------------------------------
// Registry slug: live verified + mock v110–v120
// ---------------------------------------------------------------------------

/** Tat ca toolkit mock (v110–v120) de tra slug theo toolkit. */
const MOCK_TOOLKIT_LISTS: readonly (readonly { slug: string; candidateToolSlugs: readonly string[] }[])[] = [
  COMPOSIO_V110_MOCK_TOOLKITS,
  COMPOSIO_V111_MOCK_TOOLKITS,
  COMPOSIO_V112_MOCK_TOOLKITS,
  COMPOSIO_V114_MOCK_TOOLKITS,
  COMPOSIO_V118_MOCK_TOOLKITS,
  COMPOSIO_V119_MOCK_TOOLKITS,
  COMPOSIO_V120_MOCK_TOOLKITS,
];

/**
 * Cac slug action da biet cua mot toolkit: live verified (40
 * toolkit) + candidate cua mock v110–v120. Tra [] khi toolkit
 * khong co trong catalog (vd toolkit moi chua vao catalog —
 * host tu quyet dinh co cho cau hinh hay khong).
 */
export function knownComposioV120ActionSlugs(toolkit: string): string[] {
  const live = COMPOSIO_TOOLKITS.find((t) => t.slug === toolkit);
  const slugs: string[] = live ? [...live.verifiedToolSlugs] : [];
  for (const list of MOCK_TOOLKIT_LISTS) {
    const def = list.find((t) => t.slug === toolkit);
    if (def) slugs.push(...def.candidateToolSlugs);
  }
  return [...new Set(slugs)];
}

/** true khi slug thuoc toolkit do (live hoac mock). */
export function isKnownComposioV120ActionSlug(toolkit: string, slug: string): boolean {
  return knownComposioV120ActionSlugs(toolkit).includes(slug);
}

/** Kiem tra slug thuoc toolkit — throw neu khong biet (slug la / nham toolkit). */
export function assertKnownComposioV120ActionSlug(toolkit: string, slug: string): void {
  if (!isKnownComposioV120ActionSlug(toolkit, slug)) {
    throw new Error(`unknown action slug ${slug} for toolkit ${toolkit}`);
  }
}

// ---------------------------------------------------------------------------
// Doc/ghi prefs v2 (ham thuan)
// ---------------------------------------------------------------------------

/** Tao cau hinh v2 rong cho mot user. */
export function createComposioV120UserToolkitPrefs(userId: string): ComposioV120UserToolkitPrefs {
  assertUserId(userId);
  return { userId: userId.trim(), toolkits: [] };
}

/** Lay pref v2 cua mot toolkit (undefined = chua cau hinh). */
export function getComposioV120ToolkitPref(
  prefs: ComposioV120UserToolkitPrefs | undefined,
  toolkit: string,
): ComposioV120ToolkitPref | undefined {
  return prefs?.toolkits.find((t) => t.toolkit === toolkit);
}

/**
 * User co duoc dung toolkit nay khong (chi xet lop v2): chua cau
 * hinh → true (mac dinh bat).
 */
export function isComposioV120ToolkitEnabledForUser(
  prefs: ComposioV120UserToolkitPrefs | undefined,
  toolkit: string,
): boolean {
  const pref = getComposioV120ToolkitPref(prefs, toolkit);
  return pref === undefined ? true : pref.enabled;
}

/**
 * User co duoc dung ACTION nay khong (chi xet lop v2): toolkit
 * tat → action tat; action chua cau hinh → true (mac dinh bat).
 */
export function isComposioV120ActionEnabledForUser(
  prefs: ComposioV120UserToolkitPrefs | undefined,
  toolkit: string,
  slug: string,
): boolean {
  const pref = getComposioV120ToolkitPref(prefs, toolkit);
  if (pref === undefined) return true;
  if (!pref.enabled) return false;
  const action = pref.actions.find((a) => a.slug === slug);
  return action === undefined ? true : action.enabled;
}

/**
 * Action co that su bat cho user khong (gop 3 tang): may AND
 * toolkit v119 AND v2 (toolkit + action). `machineEnabled` =
 * ket qua tu toolkitConnections — undefined = may khong co y
 * kien (coi nhu bat). `v119Prefs` = cau hinh v119 cua user —
 * undefined = chua cau hinh v119 (mac dinh bat).
 */
export function effectiveComposioV120ActionEnabledForUser(
  v120Prefs: ComposioV120UserToolkitPrefs | undefined,
  v119Prefs: ComposioV119UserToolkitPrefs | undefined,
  toolkit: string,
  slug: string,
  machineEnabled?: boolean,
): boolean {
  if (machineEnabled === false) return false;
  if (!effectiveComposioV119ToolkitEnabledForUser(v119Prefs, toolkit, machineEnabled)) return false;
  return isComposioV120ActionEnabledForUser(v120Prefs, toolkit, slug);
}

/** Dat cau hinh bat/tat mot toolkit o muc v2 (ham thuan). */
export function setComposioV120ToolkitPref(
  prev: ComposioV120UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
  enabled: boolean,
  reason: string | null,
  nowMs: number = Date.now(),
): ComposioV120UserToolkitPrefs {
  assertUserId(userId);
  assertToolkit(toolkit);
  const base = prev ?? createComposioV120UserToolkitPrefs(userId);
  if (base.userId !== userId.trim()) throw new Error('userId does not match existing prefs userId');
  const existing = getComposioV120ToolkitPref(base, toolkit.trim());
  const cleanReason =
    typeof reason === 'string' && reason.trim() !== ''
      ? reason.trim().slice(0, COMPOSIO_V119_MAX_REASON_CHARS)
      : null;
  const pref: ComposioV120ToolkitPref = {
    toolkit: toolkit.trim(),
    enabled,
    actions: existing?.actions ?? [],
    defaultParams: existing?.defaultParams ?? {},
    reason: cleanReason,
    updatedAtMs: nowMs,
  };
  const toolkits = base.toolkits.filter((t) => t.toolkit !== pref.toolkit);
  toolkits.push(pref);
  toolkits.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  return validateComposioV120UserToolkitPrefs({ userId: base.userId, toolkits });
}

/** Dat cau hinh bat/tat mot ACTION (ham thuan) — slug la thi throw. */
export function setComposioV120ActionPref(
  prev: ComposioV120UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
  slug: string,
  enabled: boolean,
  nowMs: number = Date.now(),
): ComposioV120UserToolkitPrefs {
  assertUserId(userId);
  assertToolkit(toolkit);
  assertSlug(slug);
  assertKnownComposioV120ActionSlug(toolkit.trim(), slug.trim());
  const base = prev ?? createComposioV120UserToolkitPrefs(userId);
  if (base.userId !== userId.trim()) throw new Error('userId does not match existing prefs userId');
  const existing = getComposioV120ToolkitPref(base, toolkit.trim());
  const actions = (existing?.actions ?? []).filter((a) => a.slug !== slug.trim());
  actions.push({ slug: slug.trim(), enabled, updatedAtMs: nowMs });
  actions.sort((a, b) => a.slug.localeCompare(b.slug));
  const pref: ComposioV120ToolkitPref = {
    toolkit: toolkit.trim(),
    enabled: existing?.enabled ?? true,
    actions,
    defaultParams: existing?.defaultParams ?? {},
    reason: existing?.reason ?? null,
    updatedAtMs: existing?.updatedAtMs ?? nowMs,
  };
  const toolkits = base.toolkits.filter((t) => t.toolkit !== pref.toolkit);
  toolkits.push(pref);
  toolkits.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  return validateComposioV120UserToolkitPrefs({ userId: base.userId, toolkits });
}

/** Bat/tat hang loat action cua mot toolkit (ham thuan). Tra so action da doi. */
export function setComposioV120ActionPrefsBulk(
  prev: ComposioV120UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
  slugs: readonly string[],
  enabled: boolean,
  nowMs: number = Date.now(),
): { prefs: ComposioV120UserToolkitPrefs; changed: number } {
  let working = prev ?? createComposioV120UserToolkitPrefs(userId);
  let changed = 0;
  const seen = new Set<string>();
  for (const slug of slugs) {
    assertSlug(slug);
    if (seen.has(slug.trim())) continue;
    seen.add(slug.trim());
    const before = isComposioV120ActionEnabledForUser(working, toolkit, slug.trim());
    if (before !== enabled) changed += 1;
    working = setComposioV120ActionPref(working, userId, toolkit, slug.trim(), enabled, nowMs);
  }
  return { prefs: working, changed };
}

/**
 * Dat param mac dinh cho mot action (ham thuan): ghi de toan bo
 * map param cua action do. Ten param la (voi slug mock v120 co
 * bang paramNames) thi throw ngay — khong doi toi luc chay.
 */
export function setComposioV120DefaultParams(
  prev: ComposioV120UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
  slug: string,
  params: Readonly<Record<string, unknown>>,
  nowMs: number = Date.now(),
): ComposioV120UserToolkitPrefs {
  assertUserId(userId);
  assertToolkit(toolkit);
  assertSlug(slug);
  assertKnownComposioV120ActionSlug(toolkit.trim(), slug.trim());
  const clean = validateComposioV120DefaultParams(params, slug.trim());
  const base = prev ?? createComposioV120UserToolkitPrefs(userId);
  if (base.userId !== userId.trim()) throw new Error('userId does not match existing prefs userId');
  const existing = getComposioV120ToolkitPref(base, toolkit.trim());
  const pref: ComposioV120ToolkitPref = {
    toolkit: toolkit.trim(),
    enabled: existing?.enabled ?? true,
    actions: existing?.actions ?? [],
    defaultParams: { ...(existing?.defaultParams ?? {}), [slug.trim()]: clean },
    reason: existing?.reason ?? null,
    updatedAtMs: nowMs,
  };
  const toolkits = base.toolkits.filter((t) => t.toolkit !== pref.toolkit);
  toolkits.push(pref);
  toolkits.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  return validateComposioV120UserToolkitPrefs({ userId: base.userId, toolkits });
}

/** Xoa param mac dinh cua mot action (ham thuan). Tra false neu khong co de xoa. */
export function clearComposioV120DefaultParams(
  prev: ComposioV120UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
  slug: string,
  nowMs: number = Date.now(),
): { prefs: ComposioV120UserToolkitPrefs; cleared: boolean } {
  assertUserId(userId);
  assertToolkit(toolkit);
  assertSlug(slug);
  const base = prev ?? createComposioV120UserToolkitPrefs(userId);
  if (base.userId !== userId.trim()) throw new Error('userId does not match existing prefs userId');
  const existing = getComposioV120ToolkitPref(base, toolkit.trim());
  if (existing === undefined || existing.defaultParams[slug.trim()] === undefined) {
    return { prefs: base, cleared: false };
  }
  const defaultParams = { ...existing.defaultParams };
  delete defaultParams[slug.trim()];
  const pref: ComposioV120ToolkitPref = { ...existing, defaultParams, updatedAtMs: nowMs };
  const toolkits = base.toolkits.filter((t) => t.toolkit !== pref.toolkit);
  toolkits.push(pref);
  toolkits.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  return { prefs: validateComposioV120UserToolkitPrefs({ userId: base.userId, toolkits }), cleared: true };
}

/** Lay param mac dinh cua mot action ({} khi chua dat). */
export function getComposioV120DefaultParams(
  prefs: ComposioV120UserToolkitPrefs | undefined,
  toolkit: string,
  slug: string,
): Readonly<Record<string, unknown>> {
  const pref = getComposioV120ToolkitPref(prefs, toolkit);
  return pref?.defaultParams[slug] ?? {};
}

/**
 * Gop param goi that voi param mac dinh: param goi thang param
 * mac dinh khi trung ten. Ham thuan.
 */
export function resolveComposioV120CallParams(
  prefs: ComposioV120UserToolkitPrefs | undefined,
  toolkit: string,
  slug: string,
  callParams: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const defaults = getComposioV120DefaultParams(prefs, toolkit, slug);
  return { ...defaults, ...callParams };
}

/** Xoa het cau hinh v2 cua mot toolkit (ve mac dinh — ham thuan). */
export function clearComposioV120ToolkitPref(
  prev: ComposioV120UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
): ComposioV120UserToolkitPrefs {
  assertUserId(userId);
  assertToolkit(toolkit);
  const base = prev ?? createComposioV120UserToolkitPrefs(userId);
  if (base.userId !== userId.trim()) throw new Error('userId does not match existing prefs userId');
  return validateComposioV120UserToolkitPrefs({
    userId: base.userId,
    toolkits: base.toolkits.filter((t) => t.toolkit !== toolkit.trim()),
  });
}

/** Liet ke cac action dang bat cua mot toolkit cho user (theo lop v2). */
export function listComposioV120EnabledActionsForUser(
  prefs: ComposioV120UserToolkitPrefs | undefined,
  toolkit: string,
): string[] {
  return knownComposioV120ActionSlugs(toolkit).filter((slug) =>
    isComposioV120ActionEnabledForUser(prefs, toolkit, slug),
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Hanh dong audit prefs v2. */
export type ComposioV120ToolkitPrefsAuditAction =
  | 'toolkit-enabled'
  | 'toolkit-disabled'
  | 'action-enabled'
  | 'action-disabled'
  | 'default-params-set'
  | 'default-params-cleared'
  | 'toolkit-cleared';

/** Mot dong audit prefs v2. */
export interface ComposioV120ToolkitPrefsAuditEntry {
  id: string;
  userId: string;
  toolkit: string;
  /** Slug action (null khi hanh dong o muc toolkit). */
  slug: string | null;
  action: ComposioV120ToolkitPrefsAuditAction;
  /** Gia tri cu (boolean hoac JSON param, dang string de log). */
  previous: string | null;
  /** Gia tri moi. */
  next: string | null;
  reason: string | null;
  atMs: number;
}

/** Tao mot dong audit prefs v2 (ham thuan). */
export function createComposioV120ToolkitPrefsAuditEntry(
  userId: string,
  toolkit: string,
  slug: string | null,
  action: ComposioV120ToolkitPrefsAuditAction,
  previous: string | null,
  next: string | null,
  reason: string | null,
  atMs: number = Date.now(),
): ComposioV120ToolkitPrefsAuditEntry {
  assertUserId(userId);
  assertToolkit(toolkit);
  return {
    id: `pf120-${crypto.randomUUID()}`,
    userId: userId.trim(),
    toolkit: toolkit.trim(),
    slug: slug === null ? null : slug.trim(),
    action,
    previous,
    next,
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, COMPOSIO_V119_MAX_REASON_CHARS) : null,
    atMs,
  };
}

/** Kiem tra mot dong audit prefs v2 (throw neu sai). */
export function validateComposioV120ToolkitPrefsAuditEntry(raw: unknown): ComposioV120ToolkitPrefsAuditEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120ToolkitPrefsAuditEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('audit id must be a non-empty string.');
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') throw new Error('audit userId must be a non-empty string.');
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') throw new Error('audit toolkit must be a non-empty string.');
  if (rec['slug'] !== null && typeof rec['slug'] !== 'string') throw new Error('audit slug must be a string or null.');
  const actions: readonly string[] = ['toolkit-enabled', 'toolkit-disabled', 'action-enabled', 'action-disabled', 'default-params-set', 'default-params-cleared', 'toolkit-cleared'];
  if (typeof rec['action'] !== 'string' || !actions.includes(rec['action'])) throw new Error('audit action is invalid.');
  if (rec['previous'] !== null && typeof rec['previous'] !== 'string') throw new Error('audit previous must be a string or null.');
  if (rec['next'] !== null && typeof rec['next'] !== 'string') throw new Error('audit next must be a string or null.');
  if (rec['reason'] !== null && typeof rec['reason'] !== 'string') throw new Error('audit reason must be a string or null.');
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs']) || (rec['atMs'] as number) < 0) throw new Error('audit atMs must be a non-negative number.');
  return {
    id: rec['id'] as string,
    userId: rec['userId'] as string,
    toolkit: rec['toolkit'] as string,
    slug: rec['slug'] as string | null,
    action: rec['action'] as ComposioV120ToolkitPrefsAuditAction,
    previous: rec['previous'] as string | null,
    next: rec['next'] as string | null,
    reason: rec['reason'] as string | null,
    atMs: rec['atMs'] as number,
  };
}

// ---------------------------------------------------------------------------
// Quota view cho UI prefs (gop usage v2)
// ---------------------------------------------------------------------------

/** View-model quota cua MOT toolkit cho UI prefs. */
export interface ComposioV120ToolkitQuotaView {
  toolkit: string;
  /** Luot da dung hom nay (toolkit nay, user nay). */
  used: number;
  /** Cap ngay cua toolkit. */
  cap: number;
  /** Luot con lai truoc khi bi chan. */
  remaining: number;
  /** Muc do soft-limit. */
  severity: 'ok' | 'warn' | 'alert' | 'blocked';
  /** Top action theo luot goi hom nay (toi da 5). */
  topActions: { slug: string; calls: number; failed: number }[];
  /** true = toolkit bi tat o muc prefs (v119 hoac v2) — khong phai do quota. */
  disabledByPrefs: boolean;
}

/**
 * Lap view-model quota theo toolkit cho UI prefs: dung usage v2
 * (soft-limit + top action) + prefs (v119/v2) de phan biet "bi
 * chan do quota" voi "bi tat do prefs". Ham thuan.
 */
export function buildComposioV120ToolkitQuotaViews(
  usage: ComposioV120UsageState,
  opts: {
    userId: string;
    toolkits: readonly string[];
    v120Prefs?: ComposioV120UserToolkitPrefs;
    v119Prefs?: ComposioV119UserToolkitPrefs;
    machineEnabled?: (toolkit: string) => boolean;
    nowMs?: number;
  },
): ComposioV120ToolkitQuotaView[] {
  const nowMs = opts.nowMs ?? Date.now();
  const day = composioV119UsageDayKey(nowMs);
  const report = buildComposioV120UsageReport(usage, { day, nowMs });
  return opts.toolkits.map((toolkit) => {
    const limits = checkComposioV120SoftLimits(usage, opts.userId, toolkit, nowMs);
    const toolkitLimit = limits[0];
    const topActions = report.byAction
      .filter((a) => a.toolkit === toolkit)
      .slice(0, 5)
      .map((a) => ({ slug: a.slug, calls: a.calls, failed: a.failed }));
    const machine = opts.machineEnabled?.(toolkit);
    // Bi tat do prefs khi 1 trong 3 tang tat toolkit: may, v119, v2.
    const disabledByPrefs =
      machine === false ||
      !isComposioV119ToolkitEnabledForUser(opts.v119Prefs, toolkit) ||
      !isComposioV120ToolkitEnabledForUser(opts.v120Prefs, toolkit);
    return {
      toolkit,
      used: toolkitLimit?.used ?? 0,
      cap: toolkitLimit?.cap ?? 0,
      remaining: toolkitLimit?.remaining ?? 0,
      severity: toolkitLimit?.severity ?? 'ok',
      topActions,
      disabledByPrefs,
    };
  });
}

/** Tom tat prefs v2 cua mot user (1 dong). */
export function summarizeComposioV120UserToolkitPrefs(prefs: ComposioV120UserToolkitPrefs): string {
  const disabledToolkits = prefs.toolkits.filter((t) => !t.enabled).length;
  const disabledActions = prefs.toolkits.reduce((n, t) => n + t.actions.filter((a) => !a.enabled).length, 0);
  const defaultParamActions = prefs.toolkits.reduce((n, t) => n + Object.keys(t.defaultParams).length, 0);
  return `${prefs.userId}: ${prefs.toolkits.length} toolkits configured (${disabledToolkits} disabled), ${disabledActions} actions disabled, ${defaultParamActions} actions with default params.`;
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600) + audit JSONL
// ---------------------------------------------------------------------------

/** Interface store prefs v2 (toan bo user). */
export interface ComposioV120ToolkitPrefsStore {
  load(): ComposioV120UserToolkitPrefs[];
  save(all: ComposioV120UserToolkitPrefs[]): void;
  clear(): void;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV120ToolkitPrefsStore implements ComposioV120ToolkitPrefsStore {
  private all: ComposioV120UserToolkitPrefs[] = [];

  load(): ComposioV120UserToolkitPrefs[] {
    return JSON.parse(JSON.stringify(this.all)) as ComposioV120UserToolkitPrefs[];
  }

  save(all: ComposioV120UserToolkitPrefs[]): void {
    const valid = all.map((u) => validateComposioV120UserToolkitPrefs(u));
    if (valid.length > COMPOSIO_V120_MAX_PREFS_USERS) {
      throw new Error(`too many prefs users (max ${COMPOSIO_V120_MAX_PREFS_USERS})`);
    }
    this.all = JSON.parse(JSON.stringify(valid)) as ComposioV120UserToolkitPrefs[];
  }

  clear(): void {
    this.all = [];
  }
}

/** Duong dan file prefs v2. */
export function getComposioV120ToolkitPrefsPath(dir: string): string {
  return path.join(dir, COMPOSIO_V120_TOOLKIT_PREFS_FILE);
}

/** Duong dan file audit prefs v2. */
export function getComposioV120ToolkitPrefsAuditPath(dir: string): string {
  return path.join(dir, COMPOSIO_V120_TOOLKIT_PREFS_AUDIT_FILE);
}

/** Store tren dia (file JSON atomic, mode 0600) + audit JSONL. */
export class JsonFileComposioV120ToolkitPrefsStore implements ComposioV120ToolkitPrefsStore {
  private readonly filePath: string;
  private readonly auditPath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('toolkit prefs v2 store dir must be a non-empty string');
    }
    this.filePath = getComposioV120ToolkitPrefsPath(dir);
    this.auditPath = getComposioV120ToolkitPrefsAuditPath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  load(): ComposioV120UserToolkitPrefs[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('toolkit prefs v2 file must be an object.');
    }
    const rec = raw as Record<string, unknown>;
    if (rec['version'] !== COMPOSIO_V120_TOOLKIT_PREFS_VERSION) {
      throw new Error(`unsupported toolkit prefs v2 version: ${JSON.stringify(rec['version'])}`);
    }
    if (!Array.isArray(rec['users'])) throw new Error('toolkit prefs v2 file users must be an array.');
    return (rec['users'] as unknown[]).map((u) => validateComposioV120UserToolkitPrefs(u));
  }

  save(all: ComposioV120UserToolkitPrefs[]): void {
    const valid = all.map((u) => validateComposioV120UserToolkitPrefs(u));
    if (valid.length > COMPOSIO_V120_MAX_PREFS_USERS) {
      throw new Error(`too many prefs users (max ${COMPOSIO_V120_MAX_PREFS_USERS})`);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: COMPOSIO_V120_TOOLKIT_PREFS_VERSION, users: valid }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows khong co chmod unix — bo qua.
    }
  }

  /** Ghi them 1 dong audit (append JSONL, cap so dong). */
  appendAudit(entry: ComposioV120ToolkitPrefsAuditEntry): void {
    const valid = validateComposioV120ToolkitPrefsAuditEntry(entry);
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length > COMPOSIO_V120_MAX_PREFS_AUDIT_LINES) {
      const kept = lines.slice(-COMPOSIO_V120_MAX_PREFS_AUDIT_LINES);
      fs.writeFileSync(this.auditPath, `${kept.join('\n')}\n`, { mode: 0o600 });
    }
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    if (fs.existsSync(this.auditPath)) fs.unlinkSync(this.auditPath);
  }
}
