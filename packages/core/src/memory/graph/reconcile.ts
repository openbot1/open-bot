/**
 * Temporal KG v2 — audit & repair tính toàn vẹn (v1.12, Đội T3).
 *
 * Ý tưởng: đồ thị bi-temporal chỉ có giá trị khi lịch sử của nó
 * toàn vẹn — fact trỏ entity/episode đã mất, liên kết supersession
 * đứt gãy, cửa sổ hiệu lực ngược, invalidAt nằm ngoài cửa sổ đều
 * làm sai truy vấn "đúng tại T" và snapshot time-travel. Module này
 * quét toàn bộ đồ thị, liệt kê từng vấn đề kèm mức độ, và sửa được
 * những lỗi an toàn — KHÔNG BAO GIỜ tự xoá fact hay sửa lịch sử.
 *
 * Tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào.
 *
 * QUY TẮC SỬA (repair):
 *  - Chỉ sửa khi caller truyền `dryRun: false` và liệt kê rõ từng
 *    loại lỗi được phép sửa (`fix`); mặc định là dry-run (chỉ báo).
 *  - Loại sửa được phép:
 *    - `dangling-supersedes` / `dangling-superseded-by`: gỡ liên
 *      kết trỏ tới fact không tồn tại (fact giữ nguyên, chỉ mất
 *      mũi tên đứt — lịch sử fact không đổi).
 *    - `dangling-episode-fact`: gỡ factId khỏi episode.factIds khi
 *      fact đó không còn (episode giữ nguyên text).
 *    - `invalid-window`: validUntil < validFrom → đặt validUntil =
 *      null (fact thành "đúng tới nay" — sửa duy nhất giữ được tính
 *      đúng của query as-of; ghi rõ vào báo cáo).
 *  - KHÔNG BAO GIỜ tự sửa: fact thiếu entity chủ ngữ, fact thiếu
 *    provenance, invalidAt ngoài cửa sổ, fact active trùng nhau —
 *    những lỗi này cần người quyết (invalidate / quarantine /
 *    merge), audit chỉ liệt kê để xử lý bằng tool khác.
 */

import type { GraphFact, MemoryScope } from './types';
import { factDisplayText } from './types';
import type { TemporalGraphStore } from './store';

/** Mức độ của một vấn đề toàn vẹn. */
export type IntegritySeverity = 'error' | 'warning';

/** Loại vấn đề toàn vẹn. */
export type IntegrityIssueKind =
  | 'missing-subject-entity'
  | 'missing-object-entity'
  | 'missing-provenance-episode'
  | 'dangling-supersedes'
  | 'dangling-superseded-by'
  | 'invalid-window'
  | 'invalidated-outside-window'
  | 'duplicate-active-fact'
  | 'dangling-episode-fact';

/** Một vấn đề toàn vẹn trong đồ thị. */
export interface IntegrityIssue {
  kind: IntegrityIssueKind;
  severity: IntegritySeverity;
  factId?: string;
  episodeId?: string;
  /** Mô tả đọc được (để báo cáo / tool trả về). */
  message: string;
  /** true = loại này sửa được bằng repair (xem quy tắc ở đầu file). */
  fixable: boolean;
}

/** Kết quả audit toàn bộ đồ thị. */
export interface IntegrityAudit {
  scope: MemoryScope;
  checkedFacts: number;
  checkedEpisodes: number;
  issues: IntegrityIssue[];
  errors: number;
  warnings: number;
  /** Số nhóm fact active trùng nhau (subject, predicate, object). */
  duplicateGroups: number;
}

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Quét toàn bộ đồ thị trong một scope, liệt kê mọi vấn đề toàn vẹn.
 * Pure read — không sửa gì.
 */
export function auditTemporalGraph(
  store: TemporalGraphStore,
  scope: MemoryScope,
): IntegrityAudit {
  const facts = store.listFacts({ ...scope, limit: 20000 });
  const file = store.exportFile();
  const issues: IntegrityIssue[] = [];
  const factIds = new Set(facts.map((f) => f.id));
  // Fact active trùng nhau: cùng (subject, predicate, objectText)
  // mà cả hai đều active — một trong hai phải là mâu thuẫn chưa xử lý.
  const activeKeyCounts = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
    if (!store.getEntity(fact.subjectId)) {
      issues.push({
        kind: 'missing-subject-entity',
        severity: 'error',
        factId: fact.id,
        message: `Fact ${fact.id} (${factDisplayText(fact, subjectName)}) trỏ entity chủ ngữ không tồn tại: ${fact.subjectId}.`,
        fixable: false,
      });
    }
    if (fact.objectId && !store.getEntity(fact.objectId)) {
      issues.push({
        kind: 'missing-object-entity',
        severity: 'error',
        factId: fact.id,
        message: `Fact ${fact.id} (${factDisplayText(fact, subjectName)}) trỏ entity tân ngữ không tồn tại: ${fact.objectId}.`,
        fixable: false,
      });
    }
    if (!store.getEpisode(fact.provenance.episodeId)) {
      issues.push({
        kind: 'missing-provenance-episode',
        severity: 'warning',
        factId: fact.id,
        message: `Fact ${fact.id} (${factDisplayText(fact, subjectName)}) trỏ episode đã bị dọn: ${fact.provenance.episodeId} (provenance không đầy đủ).`,
        fixable: false,
      });
    }
    if (fact.supersedes && !store.getFact(fact.supersedes)) {
      issues.push({
        kind: 'dangling-supersedes',
        severity: 'warning',
        factId: fact.id,
        message: `Fact ${fact.id} ghi supersedes fact không tồn tại: ${fact.supersedes}.`,
        fixable: true,
      });
    }
    if (fact.supersededBy && !store.getFact(fact.supersededBy)) {
      issues.push({
        kind: 'dangling-superseded-by',
        severity: 'warning',
        factId: fact.id,
        message: `Fact ${fact.id} ghi supersededBy fact không tồn tại: ${fact.supersededBy}.`,
        fixable: true,
      });
    }
    if (fact.validUntil !== null && parseMs(fact.validUntil) < parseMs(fact.validFrom)) {
      issues.push({
        kind: 'invalid-window',
        severity: 'error',
        factId: fact.id,
        message: `Fact ${fact.id} (${factDisplayText(fact, subjectName)}) có validUntil (${fact.validUntil}) < validFrom (${fact.validFrom}).`,
        fixable: true,
      });
    }
    if (fact.invalidAt !== undefined) {
      const invalidMs = parseMs(fact.invalidAt);
      if (invalidMs < parseMs(fact.validFrom)) {
        issues.push({
          kind: 'invalidated-outside-window',
          severity: 'error',
          factId: fact.id,
          message: `Fact ${fact.id} có invalidAt (${fact.invalidAt}) < validFrom (${fact.validFrom}) — mốc invalidate nằm trước khi fact bắt đầu đúng.`,
          fixable: false,
        });
      }
    }
    if (fact.status === 'active' && fact.invalidAt === undefined) {
      const key = `${fact.subjectId}|${fact.predicate}|${(fact.objectText ?? '').toLowerCase()}`;
      const list = activeKeyCounts.get(key) ?? [];
      list.push(fact);
      activeKeyCounts.set(key, list);
    }
  }
  let duplicateGroups = 0;
  for (const [, group] of activeKeyCounts) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    const [first] = group;
    if (!first) continue;
    const subjectName = store.getEntity(first.subjectId)?.name ?? 'user';
    issues.push({
      kind: 'duplicate-active-fact',
      severity: 'warning',
      factId: first.id,
      message:
        `${group.length} fact active trùng nhau (${factDisplayText(first, subjectName)}): ` +
        group.map((f) => f.id).join(', ') + ' — cần merge hoặc invalidate một bản.',
      fixable: false,
    });
  }
  const episodes = file.episodes.filter(
    (e) =>
      (scope.userId === '' || e.userId === '' || e.userId === scope.userId) &&
      (scope.botId === '' || e.botId === '' || e.botId === scope.botId),
  );
  for (const episode of episodes) {
    for (const factId of episode.factIds) {
      if (factIds.has(factId)) continue;
      issues.push({
        kind: 'dangling-episode-fact',
        severity: 'warning',
        episodeId: episode.id,
        factId,
        message: `Episode ${episode.id} ghi factId không tồn tại: ${factId}.`,
        fixable: true,
      });
    }
  }
  return {
    scope,
    checkedFacts: facts.length,
    checkedEpisodes: episodes.length,
    issues,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    duplicateGroups,
  };
}

/** Loại lỗi được phép sửa khi repair (mặc định: tất cả loại fixable). */
export type RepairableKind = 'dangling-supersedes' | 'dangling-superseded-by' | 'invalid-window' | 'dangling-episode-fact';

export interface RepairTemporalGraphOptions {
  /** true = chỉ báo cáo, không sửa (mặc định true). */
  dryRun?: boolean;
  /** Loại lỗi được phép sửa (mặc định: cả 4 loại fixable). */
  fix?: RepairableKind[];
}

export interface RepairTemporalGraphResult {
  dryRun: boolean;
  /** Số vấn đề đã sửa (0 khi dry-run). */
  fixed: number;
  /** Số vấn đề fixable nhưng bị bỏ qua (không nằm trong `fix`). */
  skippedFixable: number;
  /** Số vấn đề không sửa được (cần người quyết). */
  unfixable: number;
  /** Chi tiết từng hành động sửa (hoặc sẽ sửa khi dry-run). */
  actions: Array<{ kind: RepairableKind; factId?: string; episodeId?: string; message: string }>;
  /** Audit sau khi sửa (dry-run: audit trước khi sửa). */
  audit: IntegrityAudit;
}

/**
 * Sửa các lỗi toàn vẹn fixable (xem quy tắc ở đầu file). Sửa qua
 * API công khai của store: `setFactValidity` (invalid-window),
 * `clearFactLink` (liên kết đứt), `pruneEpisodeFacts` (factId đứt
 * trong episode). Không bao giờ sửa trực tiếp object trong file.
 */
export function repairTemporalGraph(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: RepairTemporalGraphOptions = {},
): RepairTemporalGraphResult {
  const dryRun = opts.dryRun !== false;
  const allowed = new Set<RepairableKind>(
    opts.fix ?? ['dangling-supersedes', 'dangling-superseded-by', 'invalid-window', 'dangling-episode-fact'],
  );
  const before = auditTemporalGraph(store, scope);
  const actions: RepairTemporalGraphResult['actions'] = [];
  let fixed = 0;
  let skippedFixable = 0;
  const unfixable = before.issues.filter((i) => !i.fixable).length;

  for (const issue of before.issues) {
    if (!issue.fixable) continue;
    const kind = issue.kind as RepairableKind;
    if (!allowed.has(kind)) {
      skippedFixable += 1;
      continue;
    }
    actions.push({
      kind,
      ...(issue.factId ? { factId: issue.factId } : {}),
      ...(issue.episodeId ? { episodeId: issue.episodeId } : {}),
      message: dryRun ? `[dry-run] Sẽ sửa: ${issue.message}` : `Đã sửa: ${issue.message}`,
    });
    if (dryRun) continue;
    try {
      if (kind === 'invalid-window' && issue.factId) {
        // Đặt validUntil = null (fact thành "đúng tới nay").
        store.setFactValidity(issue.factId, { validUntil: null });
        fixed += 1;
      } else if (kind === 'dangling-supersedes' && issue.factId) {
        store.clearFactLink(issue.factId, 'supersedes');
        fixed += 1;
      } else if (kind === 'dangling-superseded-by' && issue.factId) {
        store.clearFactLink(issue.factId, 'supersededBy');
        fixed += 1;
      } else if (kind === 'dangling-episode-fact' && issue.episodeId && issue.factId) {
        store.pruneEpisodeFacts(issue.episodeId, [issue.factId]);
        fixed += 1;
      }
    } catch {
      // Fact/episode biến mất giữa audit và repair (đồ thị đổi
      // đồng thời) — bỏ qua, audit sau sẽ cho thấy còn hay hết.
      actions.pop();
      skippedFixable += 1;
    }
  }
  const after = dryRun ? before : auditTemporalGraph(store, scope);
  return {
    dryRun,
    fixed,
    skippedFixable,
    unfixable,
    actions,
    audit: after,
  };
}

/** Tóm tắt audit thành một dòng (cho tool / log). */
export function auditSummary(audit: IntegrityAudit): string {
  if (audit.issues.length === 0) {
    return `Đồ thị toàn vẹn: ${audit.checkedFacts} fact, ${audit.checkedEpisodes} episode, 0 vấn đề.`;
  }
  const byKind = new Map<string, number>();
  for (const issue of audit.issues) {
    byKind.set(issue.kind, (byKind.get(issue.kind) ?? 0) + 1);
  }
  const parts = [...byKind.entries()].map(([kind, count]) => `${kind}×${count}`);
  return (
    `Đồ thị: ${audit.checkedFacts} fact, ${audit.checkedEpisodes} episode — ` +
    `${audit.errors} lỗi, ${audit.warnings} cảnh báo (${parts.join(', ')}).`
  );
}
