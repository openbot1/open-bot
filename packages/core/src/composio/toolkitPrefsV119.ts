/**
 * Composio toolkit prefs v1.19 — bat/tat toolkit theo user
 * (v1.19, Doi T4).
 *
 * Tang tren toolkitConnections.ts (v1.08: bat/tat + health check
 * theo toolkit, MUC MAY — mot cau hinh chung cho ca may) va
 * connectionLifecycle.ts (v111: vong doi connection theo toolkit).
 * Tang do khong biet USER: tat toolkit la tat cho moi nguoi.
 * V2 them chieu USER:
 *
 * - Moi user co bang cau hinh rieng: toolkit slug → enabled +
 *   ly do + lan doi cuoi. Mac dinh (chua cau hinh) = enabled —
 *   user moi thay day du toolkit, chi tat cai nao minh khong
 *   muon dung.
 * - Ton trong ca 2 tang: toolkit bi tat o muc MAY
 *   (toolkitConnections) thi tat cho moi user du user co bat;
 *   `effectiveEnabledForUser` gop ca 2 (may AND user).
 * - Bulk: bat/tat hang loat theo danh sach slug (vd tat het
 *   toolkit mock khi user chi muon dung live), reset ve mac
 *   dinh (xoa het cau hinh rieng cua user).
 * - Audit: moi lan doi cau hinh ghi 1 dong audit (user +
 *   toolkit + cu → moi + ly do + thoi gian) — khong chua secret.
 * - Store: memory + JSON file atomic (mode 0600) trong
 *   `<userData>/composio/` — cung mau voi v118/v119.
 *
 * Module nay chi giu CAU HINH (boolean + ly do). Viec co goi
 * tool cua toolkit do hay khong do host quyet dinh dua tren
 * `effectiveEnabledForUser`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File cau hinh toolkit theo user trong thu muc composio cua userData. */
export const COMPOSIO_V119_TOOLKIT_PREFS_FILE = 'composio-toolkit-prefs-v119.json';
/** File audit log toolkit prefs (JSONL, append). */
export const COMPOSIO_V119_TOOLKIT_PREFS_AUDIT_FILE = 'composio-toolkit-prefs-audit-v119.jsonl';
/** Phien ban dinh dang file prefs. */
export const COMPOSIO_V119_TOOLKIT_PREFS_VERSION = 1;
/** Giu toi da tung nay dong audit. */
export const COMPOSIO_V119_MAX_PREFS_AUDIT_LINES = 500;
/** Giu toi da tung nay user co cau hinh. */
export const COMPOSIO_V119_MAX_PREFS_USERS = 1000;
/** Giu toi da tung nay toolkit moi user. */
export const COMPOSIO_V119_MAX_TOOLKITS_PER_USER = 500;
/** Do dai toi da cua ly do (ky tu). */
export const COMPOSIO_V119_MAX_REASON_CHARS = 200;

/** Cau hinh cua MOT toolkit doi voi MOT user. */
export interface ComposioV119ToolkitPref {
  /** Slug toolkit, vd 'gmail'. */
  toolkit: string;
  /** true = user duoc dung toolkit nay (mac dinh true khi chua cau hinh). */
  enabled: boolean;
  /** Ly do user bat/tat (vd 'khong dung nua'). */
  reason: string | null;
  /** ms epoch lan doi cau hinh cuoi. */
  updatedAtMs: number;
}

/** Cau hinh cua MOT user: map toolkit → pref. */
export interface ComposioV119UserToolkitPrefs {
  /** Id user (Composio user id hoac id local). */
  userId: string;
  /** Cac toolkit user da cau hinh rieng (khong co = mac dinh enabled). */
  toolkits: ComposioV119ToolkitPref[];
}

/** Kiem tra mot pref co hop le khong (throw neu sai). */
export function validateComposioV119ToolkitPref(raw: unknown): ComposioV119ToolkitPref {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119ToolkitPref must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') {
    throw new Error('toolkit pref toolkit must be a non-empty string.');
  }
  if (typeof rec['enabled'] !== 'boolean') throw new Error('toolkit pref enabled must be a boolean.');
  if (rec['reason'] !== null && typeof rec['reason'] !== 'string') {
    throw new Error('toolkit pref reason must be a string or null.');
  }
  if (typeof rec['reason'] === 'string' && rec['reason'].length > COMPOSIO_V119_MAX_REASON_CHARS) {
    throw new Error(`toolkit pref reason must be at most ${COMPOSIO_V119_MAX_REASON_CHARS} chars.`);
  }
  if (typeof rec['updatedAtMs'] !== 'number' || !Number.isFinite(rec['updatedAtMs']) || (rec['updatedAtMs'] as number) < 0) {
    throw new Error('toolkit pref updatedAtMs must be a non-negative number.');
  }
  return {
    toolkit: rec['toolkit'] as string,
    enabled: rec['enabled'] as boolean,
    reason: rec['reason'] as string | null,
    updatedAtMs: rec['updatedAtMs'] as number,
  };
}

/** Kiem tra cau hinh cua mot user co hop le khong (throw neu sai). */
export function validateComposioV119UserToolkitPrefs(raw: unknown): ComposioV119UserToolkitPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119UserToolkitPrefs must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') {
    throw new Error('user toolkit prefs userId must be a non-empty string.');
  }
  if (!Array.isArray(rec['toolkits'])) throw new Error('user toolkit prefs toolkits must be an array.');
  const toolkits = (rec['toolkits'] as unknown[]).map((t) => validateComposioV119ToolkitPref(t));
  if (new Set(toolkits.map((t) => t.toolkit)).size !== toolkits.length) {
    throw new Error('user toolkit prefs must not contain duplicate toolkit.');
  }
  if (toolkits.length > COMPOSIO_V119_MAX_TOOLKITS_PER_USER) {
    throw new Error(`too many toolkits per user (max ${COMPOSIO_V119_MAX_TOOLKITS_PER_USER})`);
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

/** Tao cau hinh rong cho mot user. */
export function createComposioV119UserToolkitPrefs(userId: string): ComposioV119UserToolkitPrefs {
  assertUserId(userId);
  return { userId: userId.trim(), toolkits: [] };
}

/**
 * User co duoc dung toolkit nay khong (chi xet chieu USER):
 * chua cau hinh → true (mac dinh bat); da cau hinh → theo pref.
 */
export function isComposioV119ToolkitEnabledForUser(
  prefs: ComposioV119UserToolkitPrefs | undefined,
  toolkit: string,
): boolean {
  const pref = prefs?.toolkits.find((t) => t.toolkit === toolkit);
  return pref === undefined ? true : pref.enabled;
}

/**
 * Toolkit co that su bat cho user khong (gop 2 tang): may AND
 * user. `machineEnabled` = ket qua tu toolkitConnections (v108)
 * — undefined = may khong co y kien (coi nhu bat).
 */
export function effectiveComposioV119ToolkitEnabledForUser(
  prefs: ComposioV119UserToolkitPrefs | undefined,
  toolkit: string,
  machineEnabled?: boolean,
): boolean {
  if (machineEnabled === false) return false;
  return isComposioV119ToolkitEnabledForUser(prefs, toolkit);
}

/**
 * Dat cau hinh cho mot toolkit cua mot user (ham thuan): tra ve
 * cau hinh moi (khong sua cu). Ly do dai qua thi cat ngan.
 */
export function setComposioV119ToolkitPref(
  prev: ComposioV119UserToolkitPrefs | undefined,
  userId: string,
  toolkit: string,
  enabled: boolean,
  reason: string | null,
  nowMs: number = Date.now(),
): ComposioV119UserToolkitPrefs {
  assertUserId(userId);
  assertToolkit(toolkit);
  const base = prev ?? createComposioV119UserToolkitPrefs(userId);
  if (base.userId !== userId.trim()) throw new Error('userId does not match existing prefs userId');
  const cleanReason =
    typeof reason === 'string' && reason.trim() !== ''
      ? reason.trim().slice(0, COMPOSIO_V119_MAX_REASON_CHARS)
      : null;
  const pref: ComposioV119ToolkitPref = { toolkit: toolkit.trim(), enabled, reason: cleanReason, updatedAtMs: nowMs };
  const toolkits = base.toolkits.filter((t) => t.toolkit !== pref.toolkit);
  toolkits.push(pref);
  toolkits.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  const next: ComposioV119UserToolkitPrefs = { userId: base.userId, toolkits };
  return validateComposioV119UserToolkitPrefs(next);
}

/**
 * Dat cau hinh hang loat cho nhieu toolkit cua mot user (ham
 * thuan): moi slug mot gia tri enabled chung + mot ly do chung.
 * Tra ve cau hinh moi + so toolkit da doi.
 */
export function setComposioV119ToolkitPrefsBulk(
  prev: ComposioV119UserToolkitPrefs | undefined,
  userId: string,
  toolkits: readonly string[],
  enabled: boolean,
  reason: string | null,
  nowMs: number = Date.now(),
): { prefs: ComposioV119UserToolkitPrefs; changed: number } {
  let working = prev ?? createComposioV119UserToolkitPrefs(userId);
  let changed = 0;
  const seen = new Set<string>();
  for (const toolkit of toolkits) {
    assertToolkit(toolkit);
    if (seen.has(toolkit.trim())) continue;
    seen.add(toolkit.trim());
    const before = isComposioV119ToolkitEnabledForUser(working, toolkit.trim());
    if (before !== enabled) changed += 1;
    working = setComposioV119ToolkitPref(working, userId, toolkit.trim(), enabled, reason, nowMs);
  }
  return { prefs: working, changed };
}

/** Xoa cau hinh rieng cua mot toolkit (tro ve mac dinh enabled). Tra false neu khong co gi de xoa. */
export function clearComposioV119ToolkitPref(
  prev: ComposioV119UserToolkitPrefs,
  toolkit: string,
): { prefs: ComposioV119UserToolkitPrefs; cleared: boolean } {
  assertToolkit(toolkit);
  const kept = prev.toolkits.filter((t) => t.toolkit !== toolkit.trim());
  return { prefs: { userId: prev.userId, toolkits: kept }, cleared: kept.length !== prev.toolkits.length };
}

/**
 * Danh sach toolkit user duoc dung (hieu dung): tu danh sach
 * catalog day du, loc theo pref cua user + tang may (neu co).
 * Toolkit khong co trong catalog thi khong co trong ket qua.
 */
export function listComposioV119EnabledToolkitsForUser(
  catalog: readonly string[],
  prefs: ComposioV119UserToolkitPrefs | undefined,
  machineEnabledByToolkit?: Readonly<Record<string, boolean>>,
): string[] {
  return catalog.filter(
    (toolkit) =>
      effectiveComposioV119ToolkitEnabledForUser(
        prefs,
        toolkit,
        machineEnabledByToolkit === undefined ? undefined : machineEnabledByToolkit[toolkit] !== false,
      ),
  );
}

/** Tom tat cau hinh cua mot user cho UI. */
export function summarizeComposioV119UserToolkitPrefs(
  prefs: ComposioV119UserToolkitPrefs | undefined,
  catalogSize: number,
): { userId: string; configured: number; enabled: number; disabled: number; disabledToolkits: string[] } {
  const disabledToolkits = (prefs?.toolkits ?? []).filter((t) => !t.enabled).map((t) => t.toolkit).sort();
  return {
    userId: prefs?.userId ?? '',
    configured: prefs?.toolkits.length ?? 0,
    enabled: catalogSize - disabledToolkits.length,
    disabled: disabledToolkits.length,
    disabledToolkits,
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Mot dong audit thay doi pref. */
export interface ComposioV119ToolkitPrefsAuditEntry {
  id: string;
  userId: string;
  toolkit: string;
  from: boolean | null;
  to: boolean;
  reason: string;
  atMs: number;
}

/** Tao mot dong audit pref (ham thuan). `from` = null khi truoc do chua cau hinh (mac dinh enabled). */
export function createComposioV119ToolkitPrefsAuditEntry(
  userId: string,
  toolkit: string,
  from: boolean | null,
  to: boolean,
  reason: string,
  atMs: number = Date.now(),
): ComposioV119ToolkitPrefsAuditEntry {
  assertUserId(userId);
  assertToolkit(toolkit);
  return {
    id: `tp119-${crypto.randomUUID()}`,
    userId: userId.trim(),
    toolkit: toolkit.trim(),
    from,
    to,
    reason: reason.trim() === '' ? (to ? 'enabled' : 'disabled') : reason.trim(),
    atMs,
  };
}

/** Kiem tra mot dong audit pref (throw neu sai). */
export function validateComposioV119ToolkitPrefsAuditEntry(raw: unknown): ComposioV119ToolkitPrefsAuditEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119ToolkitPrefsAuditEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('audit id must be a non-empty string.');
  if (typeof rec['userId'] !== 'string' || (rec['userId'] as string).trim() === '') throw new Error('audit userId must be a non-empty string.');
  if (typeof rec['toolkit'] !== 'string' || (rec['toolkit'] as string).trim() === '') throw new Error('audit toolkit must be a non-empty string.');
  if (rec['from'] !== null && typeof rec['from'] !== 'boolean') throw new Error('audit from must be a boolean or null.');
  if (typeof rec['to'] !== 'boolean') throw new Error('audit to must be a boolean.');
  if (typeof rec['reason'] !== 'string' || (rec['reason'] as string).trim() === '') throw new Error('audit reason must be a non-empty string.');
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs'])) throw new Error('audit atMs must be a number.');
  return {
    id: rec['id'] as string,
    userId: rec['userId'] as string,
    toolkit: rec['toolkit'] as string,
    from: rec['from'] as boolean | null,
    to: rec['to'] as boolean,
    reason: rec['reason'] as string,
    atMs: rec['atMs'] as number,
  };
}

// ---------------------------------------------------------------------------
// Store — memory + JSON file (atomic, mode 0600) + audit JSONL
// ---------------------------------------------------------------------------

/** Interface store prefs. */
export interface ComposioV119ToolkitPrefsStore {
  get(userId: string): ComposioV119UserToolkitPrefs | undefined;
  set(userId: string, toolkit: string, enabled: boolean, reason?: string | null, nowMs?: number): ComposioV119UserToolkitPrefs;
  setBulk(userId: string, toolkits: readonly string[], enabled: boolean, reason?: string | null, nowMs?: number): { prefs: ComposioV119UserToolkitPrefs; changed: number };
  clearToolkit(userId: string, toolkit: string): boolean;
  resetUser(userId: string): boolean;
  listUsers(): string[];
  clear(): void;
}

function clonePrefs(p: ComposioV119UserToolkitPrefs): ComposioV119UserToolkitPrefs {
  return JSON.parse(JSON.stringify(p)) as ComposioV119UserToolkitPrefs;
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV119ToolkitPrefsStore implements ComposioV119ToolkitPrefsStore {
  private readonly users = new Map<string, ComposioV119UserToolkitPrefs>();
  private readonly audit: ComposioV119ToolkitPrefsAuditEntry[] = [];

  get(userId: string): ComposioV119UserToolkitPrefs | undefined {
    const p = this.users.get(userId);
    return p ? clonePrefs(p) : undefined;
  }

  set(userId: string, toolkit: string, enabled: boolean, reason: string | null = null, nowMs: number = Date.now()): ComposioV119UserToolkitPrefs {
    const prev = this.users.get(userId);
    const before = prev?.toolkits.find((t) => t.toolkit === toolkit)?.enabled ?? null;
    const next = setComposioV119ToolkitPref(prev, userId, toolkit, enabled, reason, nowMs);
    this.users.set(userId, next);
    this.audit.push(createComposioV119ToolkitPrefsAuditEntry(userId, toolkit, before, enabled, reason ?? '', nowMs));
    return clonePrefs(next);
  }

  setBulk(userId: string, toolkits: readonly string[], enabled: boolean, reason: string | null = null, nowMs: number = Date.now()): { prefs: ComposioV119UserToolkitPrefs; changed: number } {
    const prev = this.users.get(userId);
    const { prefs, changed } = setComposioV119ToolkitPrefsBulk(prev, userId, toolkits, enabled, reason, nowMs);
    this.users.set(userId, prefs);
    for (const toolkit of new Set(toolkits.map((t) => t.trim()))) {
      const before = prev?.toolkits.find((t) => t.toolkit === toolkit)?.enabled ?? null;
      this.audit.push(createComposioV119ToolkitPrefsAuditEntry(userId, toolkit, before, enabled, reason ?? '', nowMs));
    }
    return { prefs: clonePrefs(prefs), changed };
  }

  clearToolkit(userId: string, toolkit: string): boolean {
    const prev = this.users.get(userId);
    if (!prev) return false;
    const { prefs, cleared } = clearComposioV119ToolkitPref(prev, toolkit);
    if (!cleared) return false;
    this.users.set(userId, prefs);
    return true;
  }

  resetUser(userId: string): boolean {
    return this.users.delete(userId);
  }

  listUsers(): string[] {
    return [...this.users.keys()].sort();
  }

  clear(): void {
    this.users.clear();
    this.audit.length = 0;
  }

  /** Audit trong bo nho (moi nhat truoc). */
  listAudit(limit?: number): ComposioV119ToolkitPrefsAuditEntry[] {
    const reversed = [...this.audit].reverse();
    return limit !== undefined ? reversed.slice(0, Math.max(0, limit)) : reversed;
  }
}

/** Duong dan file prefs. */
export function getComposioV119ToolkitPrefsPath(dir: string): string {
  return path.join(dir, COMPOSIO_V119_TOOLKIT_PREFS_FILE);
}

/** Duong dan file audit prefs. */
export function getComposioV119ToolkitPrefsAuditPath(dir: string): string {
  return path.join(dir, COMPOSIO_V119_TOOLKIT_PREFS_AUDIT_FILE);
}

/** Store tren dia (file JSON + audit JSONL). */
export class JsonFileComposioV119ToolkitPrefsStore implements ComposioV119ToolkitPrefsStore {
  private readonly filePath: string;
  private readonly auditPath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('toolkit prefs store dir must be a non-empty string');
    }
    this.filePath = getComposioV119ToolkitPrefsPath(dir);
    this.auditPath = getComposioV119ToolkitPrefsAuditPath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  private loadAllRaw(): ComposioV119UserToolkitPrefs[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`Invalid ${COMPOSIO_V119_TOOLKIT_PREFS_FILE}: expected an array.`);
    return raw.map((entry) => validateComposioV119UserToolkitPrefs(entry));
  }

  private saveAllRaw(users: readonly ComposioV119UserToolkitPrefs[]): void {
    for (const u of users) validateComposioV119UserToolkitPrefs(u);
    if (users.length > COMPOSIO_V119_MAX_PREFS_USERS) {
      throw new Error(`too many prefs users (max ${COMPOSIO_V119_MAX_PREFS_USERS})`);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows khong co chmod unix — bo qua.
    }
  }

  private appendAudit(entry: ComposioV119ToolkitPrefsAuditEntry): void {
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (lines.length > COMPOSIO_V119_MAX_PREFS_AUDIT_LINES) {
      const kept = lines.slice(-COMPOSIO_V119_MAX_PREFS_AUDIT_LINES);
      const tmp = `${this.auditPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.auditPath);
    }
  }

  get(userId: string): ComposioV119UserToolkitPrefs | undefined {
    const p = this.loadAllRaw().find((u) => u.userId === userId);
    return p ? clonePrefs(p) : undefined;
  }

  set(userId: string, toolkit: string, enabled: boolean, reason: string | null = null, nowMs: number = Date.now()): ComposioV119UserToolkitPrefs {
    const all = this.loadAllRaw();
    const prev = all.find((u) => u.userId === userId);
    const before = prev?.toolkits.find((t) => t.toolkit === toolkit)?.enabled ?? null;
    const next = setComposioV119ToolkitPref(prev, userId, toolkit, enabled, reason, nowMs);
    const idx = all.findIndex((u) => u.userId === userId);
    if (idx >= 0) all[idx] = next;
    else all.push(next);
    this.saveAllRaw(all);
    this.appendAudit(createComposioV119ToolkitPrefsAuditEntry(userId, toolkit, before, enabled, reason ?? '', nowMs));
    return clonePrefs(next);
  }

  setBulk(userId: string, toolkits: readonly string[], enabled: boolean, reason: string | null = null, nowMs: number = Date.now()): { prefs: ComposioV119UserToolkitPrefs; changed: number } {
    const all = this.loadAllRaw();
    const prev = all.find((u) => u.userId === userId);
    const { prefs, changed } = setComposioV119ToolkitPrefsBulk(prev, userId, toolkits, enabled, reason, nowMs);
    const idx = all.findIndex((u) => u.userId === userId);
    if (idx >= 0) all[idx] = prefs;
    else all.push(prefs);
    this.saveAllRaw(all);
    for (const toolkit of new Set(toolkits.map((t) => t.trim()))) {
      const before = prev?.toolkits.find((t) => t.toolkit === toolkit)?.enabled ?? null;
      this.appendAudit(createComposioV119ToolkitPrefsAuditEntry(userId, toolkit, before, enabled, reason ?? '', nowMs));
    }
    return { prefs: clonePrefs(prefs), changed };
  }

  clearToolkit(userId: string, toolkit: string): boolean {
    const all = this.loadAllRaw();
    const idx = all.findIndex((u) => u.userId === userId);
    if (idx < 0) return false;
    const { prefs, cleared } = clearComposioV119ToolkitPref(all[idx], toolkit);
    if (!cleared) return false;
    all[idx] = prefs;
    this.saveAllRaw(all);
    return true;
  }

  resetUser(userId: string): boolean {
    const all = this.loadAllRaw();
    const kept = all.filter((u) => u.userId !== userId);
    if (kept.length === all.length) return false;
    this.saveAllRaw(kept);
    return true;
  }

  listUsers(): string[] {
    return this.loadAllRaw().map((u) => u.userId).sort();
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    if (fs.existsSync(this.auditPath)) fs.unlinkSync(this.auditPath);
  }

  /** Audit tren dia (moi nhat truoc). */
  listAudit(opts: { userId?: string; toolkit?: string; limit?: number } = {}): ComposioV119ToolkitPrefsAuditEntry[] {
    if (!fs.existsSync(this.auditPath)) return [];
    const lines = fs.readFileSync(this.auditPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const all = lines.map((line) => validateComposioV119ToolkitPrefsAuditEntry(JSON.parse(line) as unknown));
    const filtered = all.filter(
      (e) => (opts.userId === undefined || e.userId === opts.userId) && (opts.toolkit === undefined || e.toolkit === opts.toolkit),
    );
    const reversed = filtered.reverse();
    return opts.limit !== undefined ? reversed.slice(0, Math.max(0, opts.limit)) : reversed;
  }
}
