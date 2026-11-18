/**
 * Memory v17 — Scope isolation chat (v1.36, Doi T1).
 *
 * Bai hoc tu vu ro ri cross-tenant cua mem0 (cong bo 20/10/2026):
 * session scoping long dan den du lieu cua tenant nay lot sang tenant
 * khac. Lop nay thiet ke de vu do KHONG the xay ra trong open-bot:
 *
 *  1. Scope bat buoc moi noi: moi fact/entity/edge/grant deu mang
 *     M17Scope day du (tenant/user/bot/conversation). Khong co scope
 *     mac dinh \"thay tat ca\" trong duong doc — doc phai truyen scope.
 *  2. Matcher nghiem ngat: 1 field khac nhau la khac scope; khong co
 *     che do \"empty matches everything\" (khac voi memory v16 cu).
 *     Field rong chi khop field rong — khong phai wildcard.
 *  3. Share chi qua grant tuong minh: M17ScopeGrant (from -> to, chi
 *     quyen read, co the het han). Khong co grant = khong share.
 *  4. Moi co gang doc cheo scope deu bi chan + ghi vao violation log
 *     (de audit / eval kiem tra). Ham guard() la diem chan duy nhat
 *     ma store/search phai goi truoc moi truy cap.
 *  5. Leak detector: quet toan bo store, tim fact/entity/edge nao co
 *     scope khong hop le hoac bi truy cap sai scope; tra bao cao de
 *     host xu ly (quarantine / xoa).
 *  6. Redaction: log/audit khong bao gio in nguyen scope key day du
 *     cua tenant khac — chi in hash rut gon.
 */

import {
  M17Error,
  M17Fact,
  M17Entity,
  M17EntityEdge,
  M17Scope,
  M17ScopeGrant,
  M17ScopeViolation,
  makeM17Id,
  scopeKeyM17,
  scopesEqualM17,
  validateScopeM17,
} from './types';

/** Loi scope isolation v17. */
export class M17ScopeError extends M17Error {
  constructor(message: string) {
    super(message);
    this.name = 'M17ScopeError';
  }
}

/** Ket qua kiem tra quyen doc. */
export interface M17AccessCheck {
  allowed: boolean;
  /** Ly do (khi bi tu choi hoac duoc share). */
  reason: string;
  /** Co phai qua grant share khong. */
  viaGrant: boolean;
  /** Grant da dung (neu co). */
  grantId: string | null;
}

/** Ket qua quet leak. */
export interface M17LeakReport {
  /** Tong ban ghi da quet. */
  scanned: number;
  /** Ban ghi co scope khong hop le (thieu field / chua ky tu cam). */
  invalidScope: { kind: string; id: string; detail: string }[];
  /** Ban ghi bi truy cap sai scope trong violation log (dem). */
  violationCount: number;
  /** Co leak khong. */
  hasLeak: boolean;
}

/** Hash rut gon scope key de log (khong lo thong tin nhay cam). */
export function redactedScopeKeyM17(scope: M17Scope): string {
  const key = scopeKeyM17(scope);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `scope#${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Matcher nghiem ngat: 2 scope chi khop khi TAT CA field bang nhau.
 * Field rong chi khop field rong — KHONG phai wildcard. Day la diem
 * khac biet cot loi voi memory cu (\"empty matches everything\" la
 * nguyen nhan ro ri cross-tenant).
 */
export function scopeMatchesStrictM17(a: M17Scope, b: M17Scope): boolean {
  return scopesEqualM17(a, b);
}

/** Kiem tra scope co phai \"scope rong toan cuc\" (tat ca field rong) khong — bi cam trong duong doc. */
export function isEmptyScopeM17(scope: M17Scope): boolean {
  return !scope.tenantId && !scope.userId && !scope.botId && !scope.conversationId;
}

/** Scope co hop le de doc khong (userId bat buoc, khong phai scope rong). */
export function validateReadScopeM17(scope: M17Scope): string | null {
  const error = validateScopeM17(scope);
  if (error) return error;
  if (isEmptyScopeM17(scope)) return 'Scope rong toan cuc bi cam — phai chi ro userId.';
  return null;
}

/**
 * Guard trung tam: kiem tra quyen doc 1 ban ghi co scope cho truoc.
 *  - Cung scope -> allowed.
 *  - Khac scope nhung co grant read con han -> allowed (viaGrant).
 *  - Con lai -> denied + ghi violation (caller truyen logger).
 * Tra AccessCheck; caller tu choi khi allowed = false.
 */
export function checkReadAccessM17(
  recordScope: M17Scope,
  requestedScope: M17Scope,
  grants: M17ScopeGrant[],
  nowIso: string,
): M17AccessCheck {
  if (scopesEqualM17(recordScope, requestedScope)) {
    return { allowed: true, reason: 'Cung scope.', viaGrant: false, grantId: null };
  }
  const now = new Date(nowIso).getTime();
  for (const grant of grants) {
    if (grant.permission !== 'read') continue;
    if (!scopesEqualM17(grant.fromScope, recordScope)) continue;
    if (!scopesEqualM17(grant.toScope, requestedScope)) continue;
    if (grant.expiresAt) {
      const expiry = new Date(grant.expiresAt).getTime();
      if (Number.isFinite(expiry) && expiry <= now) continue;
    }
    return {
      allowed: true,
      reason: `Duoc share qua grant ${grant.id} (cap boi ${grant.grantedBy}).`,
      viaGrant: true,
      grantId: grant.id,
    };
  }
  return {
    allowed: false,
    reason: 'Khac scope va khong co grant share — tu choi truy cap.',
    viaGrant: false,
    grantId: null,
  };
}

/** Loc danh sach ban ghi theo quyen doc (chi giu ban ghi duoc phep). */
export function filterReadableM17<T extends { scope: M17Scope }>(
  records: T[],
  requestedScope: M17Scope,
  grants: M17ScopeGrant[],
  nowIso: string,
): { readable: T[]; denied: number } {
  const readable: T[] = [];
  let denied = 0;
  for (const record of records) {
    const check = checkReadAccessM17(record.scope, requestedScope, grants, nowIso);
    if (check.allowed) readable.push(record);
    else denied += 1;
  }
  return { readable, denied };
}

/** Quan ly grant share + violation log. */
export class M17ScopeGuard {
  private grants: M17ScopeGrant[] = [];
  private violations: M17ScopeViolation[] = [];

  get grantCount(): number {
    return this.grants.length;
  }

  get violationCount(): number {
    return this.violations.length;
  }

  /** Cap grant share read (chi nguoi so huu du lieu moi cap duoc). */
  grantRead(
    fromScope: M17Scope,
    toScope: M17Scope,
    grantedBy: string,
    nowIso: string,
    expiresAt: string | null = null,
  ): M17ScopeGrant {
    const fromError = validateScopeM17(fromScope);
    if (fromError) throw new M17ScopeError(`Scope nguon khong hop le: ${fromError}`);
    const toError = validateScopeM17(toScope);
    if (toError) throw new M17ScopeError(`Scope dich khong hop le: ${toError}`);
    if (scopesEqualM17(fromScope, toScope)) {
      throw new M17ScopeError('Khong can grant cho cung scope.');
    }
    if (!grantedBy || !grantedBy.trim()) {
      throw new M17ScopeError('Grant can nguoi cap (grantedBy).');
    }
    if (expiresAt) {
      const expiry = new Date(expiresAt).getTime();
      const now = new Date(nowIso).getTime();
      if (!Number.isFinite(expiry)) throw new M17ScopeError('expiresAt khong hop le.');
      if (expiry <= now) throw new M17ScopeError('Grant da het han ngay khi cap.');
    }
    const existing = this.grants.find(
      (g) =>
        scopesEqualM17(g.fromScope, fromScope) &&
        scopesEqualM17(g.toScope, toScope) &&
        g.permission === 'read' &&
        (!g.expiresAt || new Date(g.expiresAt).getTime() > new Date(nowIso).getTime()),
    );
    if (existing) return existing;
    const grant: M17ScopeGrant = {
      id: makeM17Id('grant'),
      fromScope: { ...fromScope },
      toScope: { ...toScope },
      permission: 'read',
      grantedBy: grantedBy.trim(),
      grantedAt: nowIso,
      expiresAt,
    };
    this.grants.push(grant);
    return grant;
  }

  /** Thu hoi grant. */
  revokeGrant(grantId: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter((g) => g.id !== grantId);
    return this.grants.length < before;
  }

  /** Liet ke grant con han (loc theo scope nguon neu co). */
  listGrants(fromScope?: M17Scope, nowIso?: string): M17ScopeGrant[] {
    const now = nowIso ? new Date(nowIso).getTime() : Date.now();
    return this.grants.filter((g) => {
      if (fromScope && !scopesEqualM17(g.fromScope, fromScope)) return false;
      if (g.expiresAt && new Date(g.expiresAt).getTime() <= now) return false;
      return true;
    });
  }

  /**
   * Guard 1 lan truy cap: tra AccessCheck; neu denied thi GHI violation
   * vao log truoc khi tra ve (de audit thay duoc moi co gang doc cheo).
   */
  guardRead(
    recordScope: M17Scope,
    requestedScope: M17Scope,
    action: string,
    nowIso: string,
  ): M17AccessCheck {
    const check = checkReadAccessM17(recordScope, requestedScope, this.grants, nowIso);
    if (!check.allowed) {
      this.violations.push({
        id: makeM17Id('viol'),
        requestedScope: { ...requestedScope },
        targetScope: { ...recordScope },
        action,
        at: nowIso,
        detail: check.reason,
      });
    }
    return check;
  }

  /** Liet ke violation (moi nhat truoc). */
  listViolations(): M17ScopeViolation[] {
    return [...this.violations].reverse();
  }

  /** Xoa violation log (chi de test / xoay log — ghi ro ly do vao audit ngoai). */
  clearViolations(): number {
    const count = this.violations.length;
    this.violations = [];
    return count;
  }

  /** Serialize guard (grant + violation). */
  serialize(): { grants: M17ScopeGrant[]; violations: M17ScopeViolation[] } {
    return {
      grants: this.grants.map((g) => ({
        ...g,
        fromScope: { ...g.fromScope },
        toScope: { ...g.toScope },
      })),
      violations: this.violations.map((v) => ({
        ...v,
        requestedScope: { ...v.requestedScope },
        targetScope: { ...v.targetScope },
      })),
    };
  }

  /** Khoi phuc tu JSON. */
  deserialize(data: { grants?: M17ScopeGrant[]; violations?: M17ScopeViolation[] }): void {
    this.grants = (data.grants ?? []).map((g) => ({
      ...g,
      fromScope: { ...g.fromScope },
      toScope: { ...g.toScope },
    }));
    this.violations = (data.violations ?? []).map((v) => ({
      ...v,
      requestedScope: { ...v.requestedScope },
      targetScope: { ...v.targetScope },
    }));
  }
}

/**
 * Leak detector: quet fact/entity/edge, tim ban ghi co scope khong hop
 * le (thieu userId, chua ky tu cam) hoac bi \"leak\" qua violation log.
 * Tra bao cao — host quyet dinh quarantine/xoa sau do.
 */
export function scanForScopeLeaksM17(
  facts: M17Fact[],
  entities: M17Entity[],
  edges: M17EntityEdge[],
  guard: M17ScopeGuard,
): M17LeakReport {
  const invalidScope: M17LeakReport['invalidScope'] = [];
  let scanned = 0;
  const checkOne = (kind: string, id: string, scope: M17Scope): void => {
    scanned += 1;
    const error = validateScopeM17(scope);
    if (error) invalidScope.push({ kind, id, detail: error });
  };
  for (const fact of facts) checkOne('fact', fact.id, fact.scope);
  for (const entity of entities) checkOne('entity', entity.id, entity.scope);
  for (const edge of edges) checkOne('edge', edge.id, edge.scope);
  const violationCount = guard.violationCount;
  return {
    scanned,
    invalidScope,
    violationCount,
    hasLeak: invalidScope.length > 0 || violationCount > 0,
  };
}

/** Format bao cao leak thanh text (UI / log). */
export function formatLeakReportM17(report: M17LeakReport): string {
  const lines = [
    `Quet scope isolation: ${report.scanned} ban ghi, ${report.invalidScope.length} scope khong hop le, ${report.violationCount} lan doc cheo bi chan.`,
    report.hasLeak
      ? 'KET LUAN: CO VAN DE — kiem tra danh sach duoi day.'
      : 'KET LUAN: KHONG CO LEAK.',
  ];
  for (const item of report.invalidScope.slice(0, 20)) {
    lines.push(`  - [${item.kind}] ${item.id}: ${item.detail}`);
  }
  if (report.invalidScope.length > 20) {
    lines.push(`  ... va ${report.invalidScope.length - 20} ban ghi nua.`);
  }
  return lines.join('\n');
}
