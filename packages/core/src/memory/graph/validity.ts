/**
 * Temporal validity windows — quản lý cửa sổ hiệu lực của fact
 * (v1.03, Đội T2 — Memory v4).
 *
 * Ý tưởng học từ Zep/Graphiti (fact có validity window + supersession
 * link) nhưng tự thiết kế lại hoàn toàn cho open-bot, chạy 100% local.
 * Đồ thị v0.98 đã có cửa sổ bi-temporal (`validFrom`/`validUntil` +
 * `createdAt`/`updatedAt`) và `isFactValidAt`, nhưng chưa có lớp quản
 * lý cửa sổ: chưa đặt được hạn cho fact ("làm ở X tới cuối 2026"),
 * chưa phát hiện fact sắp hết hạn, chưa quét fact đã hết hạn.
 * Module này là lớp đó — chỉ đọc/ghi qua `TemporalGraphStore`, không
 * đổi schema file:
 *
 *  - `parseValidityHint(text)` — rút gợi ý cửa sổ từ câu nói
 *    ("từ 2020 đến 2024", "until 2026-12-31", "từ tháng 3/2025"):
 *    ngày ISO đầy đủ hoặc tháng/năm; không đoán ngày mơ hồ.
 *  - `setValidityWindow` / `extendValidity` / `closeValidity` —
 *    đặt, nới, đóng cửa sổ của một fact (qua `setFactValidity`).
 *  - `validityReport` — fact đã hết hạn, sắp hết hạn (trong N ngày),
 *    cửa sổ mở (không có validUntil), cửa sổ lỗi (validUntil <
 *    validFrom — chỉ xảy ra khi file bị sửa tay, vì store đã chặn).
 *  - `sweepExpiredFacts` — fact active nhưng validUntil đã qua:
 *    đóng mềm bằng `deleteFact` (status `deleted`, vẫn xem lại được
 *    qua `factHistory`, KHÔNG xoá khỏi file) + ghi dòng sweep vào
 *    `.open-bot/memory-validity-sweeps.jsonl` để audit. Sweep là
 *    thao tác có ghi log, chạy tay hoặc từ sleep agent — không chạy
 *    ngầm lặng lẽ.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GraphFact, MemoryScope } from './types';
import { isFactValidAt } from './types';
import type { TemporalGraphStore } from './store';

export const MEMORY_VALIDITY_SWEEPS_REL_PATH = path.join(
  '.open-bot',
  'memory-validity-sweeps.jsonl',
);
/** Số ngày mặc định coi là "sắp hết hạn". */
export const DEFAULT_EXPIRING_SOON_DAYS = 30;
/** Số dòng sweep log tối đa giữ lại khi đọc (file append-only). */
export const MAX_SWEEP_LOG_LINES = 1000;

/** Gợi ý cửa sổ hiệu lực rút từ text (có thể chỉ có một đầu). */
export interface ValidityHint {
  validFrom?: string;
  validUntil?: string | null;
  /** Chuỗi gốc đã khớp (để UI hiển thị nguồn gợi ý). */
  matchedText: string;
}

/** Ngày ISO (YYYY-MM-DD) -> ISO datetime đầu ngày (UTC). */
function isoDateToStartOfDay(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** Tháng/năm (MM/YYYY) -> ngày đầu tháng. */
function monthYearToStart(month: string, year: string): string {
  return `${year}-${month.padStart(2, '0')}-01T00:00:00.000Z`;
}

/** Tháng/năm (MM/YYYY) -> ngày cuối tháng (đầu tháng sau trừ 1ms). */
function monthYearToEnd(month: string, year: string): string {
  const m = Number(month);
  const y = Number(year);
  const next = m === 12 ? new Date(Date.UTC(y + 1, 0, 1)) : new Date(Date.UTC(y, m, 1));
  return new Date(next.getTime() - 1).toISOString();
}

const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const MONTH_YEAR_RE = /\b(0?[1-9]|1[0-2])\/(\d{4})\b/;

/**
 * Rút gợi ý cửa sổ hiệu lực từ một câu nói. Chỉ nhận dạng chắc chắn:
 * ngày ISO đầy đủ, hoặc tháng/năm; cụm "từ X đến Y" / "from X until Y"
 * cho cả hai đầu, "đến Y" / "until Y" chỉ cho validUntil, "từ X" /
 * "since X" chỉ cho validFrom. Không khớp -> null (không đoán).
 */
export function parseValidityHint(text: string): ValidityHint | null {
  const source = (text ?? '').trim();
  if (source === '') return null;

  const rangeRe =
    /(?:từ|from|since)\s+(\d{4}-\d{2}-\d{2}|(?:0?[1-9]|1[0-2])\/\d{4})\s+(?:đến|tới|until|to)\s+(\d{4}-\d{2}-\d{2}|(?:0?[1-9]|1[0-2])\/\d{4})/iu;
  const range = rangeRe.exec(source);
  if (range) {
    const from = toIsoStart(range[1]);
    const until = toIsoEnd(range[2]);
    if (from && until) {
      return { validFrom: from, validUntil: until, matchedText: range[0] };
    }
  }
  const untilRe =
    /(?:đến|tới|until|up\s+to)\s+(\d{4}-\d{2}-\d{2}|(?:0?[1-9]|1[0-2])\/\d{4})/iu;
  const untilMatch = untilRe.exec(source);
  if (untilMatch) {
    const until = toIsoEnd(untilMatch[1]);
    if (until) return { validUntil: until, matchedText: untilMatch[0] };
  }
  const fromRe = /(?:từ|from|since)\s+(\d{4}-\d{2}-\d{2}|(?:0?[1-9]|1[0-2])\/\d{4})/iu;
  const fromMatch = fromRe.exec(source);
  if (fromMatch) {
    const from = toIsoStart(fromMatch[1]);
    if (from) return { validFrom: from, matchedText: fromMatch[0] };
  }
  return null;
}

function toIsoStart(token: string): string | null {
  const iso = ISO_DATE_RE.exec(token);
  if (iso) return isoDateToStartOfDay(iso[1]);
  const my = MONTH_YEAR_RE.exec(token);
  if (my) return monthYearToStart(my[1], my[2]);
  return null;
}

function toIsoEnd(token: string): string | null {
  const iso = ISO_DATE_RE.exec(token);
  if (iso) {
    // Cuối ngày đó (fact vẫn đúng trong cả ngày cuối).
    const end = new Date(`${iso[1]}T23:59:59.999Z`);
    return Number.isNaN(end.getTime()) ? null : end.toISOString();
  }
  const my = MONTH_YEAR_RE.exec(token);
  if (my) return monthYearToEnd(my[1], my[2]);
  return null;
}

/** Đặt cửa sổ hiệu lực cho một fact (validFrom/validUntil đều optional). */
export function setValidityWindow(
  store: TemporalGraphStore,
  factId: string,
  window: { validFrom?: string; validUntil?: string | null },
): GraphFact {
  return store.setFactValidity(factId, window);
}

/**
 * Nới cửa sổ hiệu lực: chỉ nới RA (validUntil mới phải muộn hơn cũ,
 * validFrom mới phải sớm hơn cũ) — thu hẹp phải dùng
 * `setValidityWindow` tường minh để không nới nhầm thành thu hẹp.
 */
export function extendValidity(
  store: TemporalGraphStore,
  factId: string,
  window: { validFrom?: string; validUntil?: string | null },
): GraphFact {
  const fact = store.getFact(factId);
  if (!fact) throw new Error(`Không tìm thấy fact "${factId}".`);
  const next: { validFrom?: string; validUntil?: string | null } = {};
  if (window.validFrom !== undefined) {
    if (Date.parse(window.validFrom) > Date.parse(fact.validFrom)) {
      throw new Error('extendValidity chỉ nới validFrom SỚM hơn, không thu hẹp.');
    }
    next.validFrom = window.validFrom;
  }
  if (window.validUntil !== undefined && window.validUntil !== null) {
    if (fact.validUntil !== null && Date.parse(window.validUntil) < Date.parse(fact.validUntil)) {
      throw new Error('extendValidity chỉ nới validUntil MUỘN hơn, không thu hẹp.');
    }
    next.validUntil = window.validUntil;
  }
  if (window.validUntil === null) {
    // Mở lại cửa sổ vô hạn — cho phép (nới ra vô hạn).
    next.validUntil = null;
  }
  return store.setFactValidity(factId, next);
}

/** Đóng cửa sổ hiệu lực tại một thời điểm (mặc định: bây giờ). */
export function closeValidity(
  store: TemporalGraphStore,
  factId: string,
  at: Date = new Date(),
): GraphFact {
  const fact = store.getFact(factId);
  if (!fact) throw new Error(`Không tìm thấy fact "${factId}".`);
  if (at.getTime() < Date.parse(fact.validFrom)) {
    throw new Error('Không thể đóng cửa sổ trước cả validFrom.');
  }
  return store.setFactValidity(factId, { validUntil: at.toISOString() });
}

/** Một mục trong báo cáo validity. */
export interface ValidityReportEntry {
  fact: GraphFact;
  subjectName: string;
  /** 'expired' | 'expiring-soon' | 'open-ended' | 'invalid-window'. */
  kind: 'expired' | 'expiring-soon' | 'open-ended' | 'invalid-window';
  /** Số ngày tới khi hết hạn (âm = đã hết hạn). */
  daysUntilExpiry: number | null;
}

/** Báo cáo toàn bộ cửa sổ hiệu lực trong một scope. */
export interface ValidityReport {
  checkedAt: string;
  totalActive: number;
  expired: ValidityReportEntry[];
  expiringSoon: ValidityReportEntry[];
  openEnded: ValidityReportEntry[];
  invalidWindows: ValidityReportEntry[];
}

export function validityReport(
  store: TemporalGraphStore,
  scope: MemoryScope,
  now: Date = new Date(),
  expiringSoonDays: number = DEFAULT_EXPIRING_SOON_DAYS,
): ValidityReport {
  const facts = store.listFacts({ ...scope, status: 'active' });
  const expired: ValidityReportEntry[] = [];
  const expiringSoon: ValidityReportEntry[] = [];
  const openEnded: ValidityReportEntry[] = [];
  const invalidWindows: ValidityReportEntry[] = [];
  for (const fact of facts) {
    const subject = store.getEntity(fact.subjectId);
    const entry: ValidityReportEntry = {
      fact,
      subjectName: subject?.name ?? fact.subjectId,
      kind: 'open-ended',
      daysUntilExpiry: null,
    };
    if (fact.validUntil !== null && Date.parse(fact.validUntil) < Date.parse(fact.validFrom)) {
      entry.kind = 'invalid-window';
      invalidWindows.push(entry);
      continue;
    }
    if (fact.validUntil === null) {
      openEnded.push(entry);
      continue;
    }
    const days = (Date.parse(fact.validUntil) - now.getTime()) / 86_400_000;
    entry.daysUntilExpiry = days;
    if (!isFactValidAt(fact, now)) {
      entry.kind = 'expired';
      expired.push(entry);
    } else if (days <= expiringSoonDays) {
      entry.kind = 'expiring-soon';
      expiringSoon.push(entry);
    }
  }
  return {
    checkedAt: now.toISOString(),
    totalActive: facts.length,
    expired,
    expiringSoon,
    openEnded,
    invalidWindows,
  };
}

/** Một dòng log sweep (append-only). */
export interface ValiditySweepLogEntry {
  at: string;
  sweptFactIds: string[];
  count: number;
  actor: string;
}

/** Kết quả một lần sweep fact hết hạn. */
export interface ValiditySweepResult {
  ranAt: string;
  swept: GraphFact[];
  logWritten: boolean;
}

/**
 * Sweep fact đã hết hạn: fact active nhưng validUntil đã qua được
 * đóng mềm (status `deleted`, vẫn xem lại được qua factHistory —
 * KHÔNG xoá khỏi file) và ghi một dòng vào sweep log để audit.
 * Fact superseded/deleted/quarantined không bị sweep lại.
 */
export function sweepExpiredFacts(
  store: TemporalGraphStore,
  scope: MemoryScope,
  workspaceDir: string,
  now: Date = new Date(),
  actor = 'system:validity-sweep',
): ValiditySweepResult {
  const report = validityReport(store, scope, now);
  const swept: GraphFact[] = [];
  for (const entry of report.expired) {
    try {
      swept.push(store.deleteFact(entry.fact.id, actor));
    } catch {
      // Fact bị thay đổi giữa chừng (race) — bỏ qua, lần sau sweep lại.
    }
  }
  let logWritten = false;
  if (swept.length > 0) {
    try {
      const dir = path.join(workspaceDir, '.open-bot');
      fs.mkdirSync(dir, { recursive: true });
      const line: ValiditySweepLogEntry = {
        at: now.toISOString(),
        sweptFactIds: swept.map((f) => f.id),
        count: swept.length,
        actor,
      };
      fs.appendFileSync(
        path.join(workspaceDir, MEMORY_VALIDITY_SWEEPS_REL_PATH),
        JSON.stringify(line) + '\n',
        { mode: 0o600 },
      );
      logWritten = true;
    } catch {
      logWritten = false;
    }
  }
  return { ranAt: now.toISOString(), swept, logWritten };
}

/** Đọc N dòng sweep log mới nhất (bỏ dòng hỏng, không throw). */
export function readValiditySweepLog(workspaceDir: string, limit = 50): ValiditySweepLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceDir, MEMORY_VALIDITY_SWEEPS_REL_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: ValiditySweepLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ValiditySweepLogEntry;
      if (typeof parsed.at === 'string' && Array.isArray(parsed.sweptFactIds)) out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  const n = Math.min(Math.max(Math.floor(limit), 1), MAX_SWEEP_LOG_LINES);
  return out.slice(-n).reverse();
}
