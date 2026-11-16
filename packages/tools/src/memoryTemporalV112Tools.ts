/**
 * Temporal KG v2 tools cho @open-bot/tools (v1.12, Đội T3).
 *
 * Agent tự làm việc với temporal knowledge graph v2 bằng tool call:
 *  - temporal_kg_asof           — fact đúng tại thời điểm T, theo tri thức đã biết tại R (đọc)
 *  - temporal_kg_snapshot       — snapshot toàn đồ thị tại R / diff 2 snapshot / changelog / coverage (đọc)
 *  - temporal_kg_invalidate     — invalidate một fact vì mâu thuẫn: ghi invalid_at + audit (needsApproval)
 *  - temporal_kg_contradictions — liệt kê mâu thuẫn đang tồn tại, kèm bằng chứng (đọc)
 *  - temporal_kg_resolve        — giải quyết mâu thuẫn theo policy, hoặc auto-quét toàn đồ thị (needsApproval)
 *  - temporal_kg_timeline       — timeline entity / edge / session, kèm khoảng trống hiệu lực (đọc)
 *  - temporal_kg_export         — export / import snapshot bi-temporal (import needsApproval)
 *
 * QUY TẮC BẢO VỆ: invalidate/resolve/auto/export-import đều ghi
 * lịch sử chứ không xoá (fact bị invalidate giữ nguyên, chỉ đóng
 * cửa sổ + ghi invalidAt); auto-invalidate không bao giờ chạm fact
 * confidence ≥ 0.9 (đưa vào quarantine thay vì tự xoá — xem
 * contradictions.ts); tool không bao giờ trả vector embedding ra
 * ngoài (chỉ trả điểm số / text đã làm tròn).
 *
 * Factory:
 *   createMemoryTemporalV112Tools(opts) -> Tool[]   (bound, usable)
 *   TEMPORAL_KG_V112_TOOLS                         (unbound placeholder)
 */
import type {
  GraphFact,
  TemporalGraphStore,
  Tool,
} from '@open-bot/core';
import {
  autoInvalidateConflicts,
  auditSummary,
  auditTemporalGraph,
  changesSince,
  contradictionSummary,
  detectLiveContradictions,
  diffSnapshots,
  entityTimeline,
  factProvenanceChain,
  factValueAt,
  factVersionTimeline,
  invalidateFact,
  provenanceReport,
  queryFactsAtBiTemporal,
  readInvalidationLog,
  repairTemporalGraph,
  resolveContradiction,
  sessionSummary,
  sessionTimeline,
  snapshotGraphAt,
  temporalCoverage,
  validityGaps,
  exportTemporalSnapshot,
  importTemporalSnapshot,
  readTemporalSnapshotFile,
  writeTemporalSnapshotFile,
  validateTemporalSnapshot,
} from '@open-bot/core';
import type {
  ContradictionPolicy,
  TemporalSnapshot,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export interface MemoryTemporalV112ToolOptions {
  /** Temporal graph store của workspace (bắt buộc để tool chạy). */
  graphStore?: TemporalGraphStore;
  /** Thư mục workspace của bot (để đọc/ghi audit log invalidate). */
  workspaceDir?: string;
  /** userId hiện tại (từ profile.json); vắng = không lọc theo user. */
  getUserId?: () => string | undefined;
}

/** Fact trả cho model/UI: KHÔNG kèm vector embedding. */
function publicFact(store: TemporalGraphStore, fact: GraphFact) {
  const subject = store.getEntity(fact.subjectId);
  const object = fact.objectId ? store.getEntity(fact.objectId) : undefined;
  return {
    id: fact.id,
    subject: subject?.name ?? fact.subjectId,
    predicate: fact.predicate,
    object: object?.name ?? fact.objectText ?? '',
    objectIsEntity: object !== undefined,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    ...(fact.invalidAt !== undefined ? { invalidAt: fact.invalidAt } : {}),
    ...(fact.invalidatedBy !== undefined ? { invalidatedBy: fact.invalidatedBy } : {}),
    ...(fact.invalidationReason !== undefined ? { invalidationReason: fact.invalidationReason } : {}),
    ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
    ...(fact.supersededBy ? { supersededBy: fact.supersededBy } : {}),
    confidence: fact.confidence,
    status: fact.status,
    scope: fact.scope,
    provenance: fact.provenance,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

export function createMemoryTemporalV112Tools(opts: MemoryTemporalV112ToolOptions = {}): Tool[] {
  const { graphStore, workspaceDir } = opts;
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): TemporalGraphStore => {
    if (!graphStore) {
      throw new Error(
        'temporal knowledge graph chưa được hỗ trợ trong phiên này (host phải truyền graphStore vào createMemoryTemporalV112Tools).',
      );
    }
    return graphStore;
  };
  const scopeOf = (ctx: { botId: string; runId?: string }, sessionId?: string) => ({
    userId: userIdOf() ?? '',
    botId: ctx.botId,
    runId: ctx.runId ?? '',
    ...(sessionId ? { sessionId } : {}),
  });

  const temporalKgAsof: Tool = {
    definition: toolDef(
      'temporal_kg_asof',
      'What was true at time T, according to what the graph knew at record time R (bi-temporal as-of query). Pass subject+predicate to get the single value of one relation at T ("where did Huy live in June, as known yesterday"); otherwise list all facts valid at T. Read-only.',
      {
        at: { type: 'string', description: 'Thời điểm sự kiện (ISO, vd "2026-06-01T00:00:00.000Z").' },
        recordedAt: { type: 'string', description: 'Thời điểm ghi nhận R (ISO; vắng = bây giờ).' },
        subject: { type: 'string', description: 'Tên entity chủ ngữ (để hỏi giá trị đơn của một quan hệ).' },
        predicate: { type: 'string', description: 'Predicate (vd "lives_in"; dùng kèm subject).' },
        sessionId: { type: 'string', description: 'Lọc theo session (vắng = mọi session + fact không gắn session).' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 100, tối đa 1000).' },
      },
      ['at'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const at = getStringArg(args, 'at');
        const recordedAt = getOptionalStringArg(args, 'recordedAt');
        const subject = getOptionalStringArg(args, 'subject');
        const predicate = getOptionalStringArg(args, 'predicate');
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const limit = getNumberArg(args, 'limit');
        const scope = scopeOf(ctx, sessionId);
        if (subject && predicate) {
          const value = factValueAt(s, subject, predicate, at, {
            scope,
            ...(recordedAt ? { recordedAt } : {}),
          });
          return JSON.stringify({
            at: value.at,
            recordedAt: value.recordedAt,
            subject: value.subjectName,
            predicate: value.predicate,
            found: value.found,
            ...(value.found && value.fact
              ? {
                  object: value.objectText,
                  ...(value.objectName ? { objectName: value.objectName } : {}),
                  validFrom: value.validFrom,
                  validUntil: value.validUntil,
                  currentAtRecordTime: value.currentAtRecordTime,
                  overlaps: value.overlaps,
                  fact: publicFact(s, value.fact),
                }
              : {}),
          }, null, 2);
        }
        const rows = queryFactsAtBiTemporal(s, at, {
          scope,
          ...(recordedAt ? { recordedAt } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return JSON.stringify({
          at: rows[0]?.at ?? new Date(at).toISOString(),
          recordedAt: rows[0]?.recordedAt ?? new Date().toISOString(),
          count: rows.length,
          facts: rows.map((r) => ({
            ...publicFact(s, r.fact),
            currentAtRecordTime: r.currentAtRecordTime,
          })),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalKgSnapshot: Tool = {
    definition: toolDef(
      'temporal_kg_snapshot',
      'Time-travel over the whole graph. action=snapshot: rebuild the graph as known at record time R. action=diff: what changed between two record times. action=changes: transaction-time changelog since R (created/superseded/deleted/invalidated). action=coverage: temporal coverage statistics. action=audit: integrity audit (dangling links, invalid windows, duplicate active facts, missing provenance). Read-only.',
      {
        action: { type: 'string', description: '"snapshot" | "diff" | "changes" | "coverage" | "audit" (mặc định "snapshot").' },
        recordedAt: { type: 'string', description: 'Thời điểm ghi nhận R (ISO; bắt buộc cho snapshot/diff/changes).' },
        from: { type: 'string', description: 'Thời điểm ghi nhận đầu (ISO; bắt buộc cho diff).' },
        to: { type: 'string', description: 'Thời điểm ghi nhận cuối (ISO; bắt buộc cho diff).' },
        sessionId: { type: 'string', description: 'Lọc theo session.' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 100, tối đa 1000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'snapshot';
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const limit = getNumberArg(args, 'limit');
        const scope = scopeOf(ctx, sessionId);
        if (action === 'snapshot') {
          const recordedAt = getStringArg(args, 'recordedAt');
          const snap = snapshotGraphAt(s, recordedAt, { scope });
          return JSON.stringify({
            action,
            recordedAt: snap.recordedAt,
            entities: snap.entities.length,
            facts: snap.facts.length,
            validAtRecordTime: snap.validAtRecordTime,
            invalidatedCount: snap.invalidatedCount,
            supersededCount: snap.supersededCount,
            deletedCount: snap.deletedCount,
            sample: snap.facts.slice(0, 20).map((f) => ({
              ...publicFact(s, f.fact),
              stateAtRecordTime: f.stateAtRecordTime,
            })),
          }, null, 2);
        }
        if (action === 'diff') {
          const from = getStringArg(args, 'from');
          const to = getStringArg(args, 'to');
          const before = snapshotGraphAt(s, from, { scope });
          const after = snapshotGraphAt(s, to, { scope });
          const diff = diffSnapshots(before, after);
          return JSON.stringify({
            action,
            fromRecordedAt: diff.fromRecordedAt,
            toRecordedAt: diff.toRecordedAt,
            total: diff.total,
            added: diff.added.map((d) => ({ factId: d.factId, text: d.text })),
            removed: diff.removed.map((d) => ({ factId: d.factId, text: d.text })),
            stateChanged: diff.stateChanged.map((d) => ({
              factId: d.factId,
              text: d.text,
              before: d.before?.state ?? null,
              after: d.after?.state ?? null,
            })),
            objectChanged: diff.objectChanged.map((d) => ({
              factId: d.factId,
              text: d.text,
              before: d.before?.objectText ?? null,
              after: d.after?.objectText ?? null,
            })),
          }, null, 2);
        }
        if (action === 'changes') {
          const since = getStringArg(args, 'recordedAt');
          const changes = changesSince(s, since, {
            scope,
            ...(workspaceDir ? { workspaceDir } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          return JSON.stringify({
            action,
            since,
            count: changes.length,
            changes: changes.map((c) => ({
              kind: c.kind,
              at: c.at,
              text: c.text,
              factId: c.fact.id,
              ...(c.relatedFactId ? { relatedFactId: c.relatedFactId } : {}),
              ...(c.reason ? { reason: c.reason } : {}),
            })),
          }, null, 2);
        }
        if (action === 'coverage') {
          const coverage = temporalCoverage(s, scope);
          return JSON.stringify({ action, coverage }, null, 2);
        }
        if (action === 'audit') {
          const audit = auditTemporalGraph(s, scope);
          return JSON.stringify({
            action,
            summary: auditSummary(audit),
            checkedFacts: audit.checkedFacts,
            checkedEpisodes: audit.checkedEpisodes,
            errors: audit.errors,
            warnings: audit.warnings,
            duplicateGroups: audit.duplicateGroups,
            issues: audit.issues,
          }, null, 2);
        }
        throw new Error('temporal_kg_snapshot: action phải là "snapshot", "diff", "changes", "coverage" hoặc "audit".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalKgInvalidate: Tool = {
    definition: toolDef(
      'temporal_kg_invalidate',
      'Invalidate one fact because it contradicts newer knowledge: closes its validity window at invalidAt, records invalidAt/invalidatedBy/reason on the fact, and appends an audit record to the invalidation log. The fact is NOT deleted — history before invalidAt stays queryable. Needs user approval first.',
      {
        factId: { type: 'string', description: 'Id của fact cần invalidate.' },
        invalidAt: { type: 'string', description: 'Thời điểm fact bắt đầu sai (ISO; vắng = bây giờ).' },
        reason: { type: 'string', description: 'Lý do invalidate (mâu thuẫn với fact nào / bằng chứng nào).' },
        conflictingFactId: { type: 'string', description: 'Id fact mâu thuẫn (nếu có).' },
      },
      ['factId', 'reason'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const factId = getStringArg(args, 'factId');
        const reason = getStringArg(args, 'reason');
        const invalidAt = getOptionalStringArg(args, 'invalidAt');
        const conflictingFactId = getOptionalStringArg(args, 'conflictingFactId');
        const result = invalidateFact(s, factId, invalidAt ?? new Date(), reason, `agent:${ctx.botId}`, {
          ...(workspaceDir ? { workspaceDir } : {}),
          ...(conflictingFactId ? { conflictingFactId } : {}),
        });
        return JSON.stringify({
          invalidated: true,
          fact: publicFact(s, result.fact),
          record: result.record,
          logWritten: result.logWritten,
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalKgContradictions: Tool = {
    definition: toolDef(
      'temporal_kg_contradictions',
      'List live contradictions: pairs/groups of ACTIVE facts with the same (subject, predicate) but different objects whose validity windows overlap — i.e. the graph currently believes two different things at once. Each group comes with timestamped evidence (source sentence + episode + time). Read-only.',
      {
        sessionId: { type: 'string', description: 'Lọc theo session.' },
        limit: { type: 'number', description: 'Số nhóm tối đa (mặc định 100, tối đa 1000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const sessionId = getOptionalStringArg(args, 'sessionId');
        const limit = getNumberArg(args, 'limit');
        const groups = detectLiveContradictions(s, scopeOf(ctx, sessionId), {
          ...(limit !== undefined ? { limit } : {}),
        });
        return JSON.stringify({
          groups: groups.length,
          contradictions: groups.map((g) => ({
            subject: g.subjectName,
            predicate: g.predicate,
            overlapFrom: g.overlapFrom,
            overlapTo: g.overlapTo,
            summary: contradictionSummary(g),
            facts: g.facts.map((f) => ({
              ...publicFact(s, f.fact),
              sourceText: f.sourceText,
              episodeId: f.episodeId,
            })),
          })),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalKgResolve: Tool = {
    definition: toolDef(
      'temporal_kg_resolve',
      'Resolve a contradiction. action=resolve: apply a policy to one contradiction (invalidate-older / invalidate-newer / quarantine-older / keep-both). action=auto: scan the whole graph and auto-invalidate the older fact in every live contradiction (high-confidence facts >= 0.9 go to quarantine instead of being auto-invalidated). action=repair: fix repairable integrity issues found by temporal_kg_snapshot action=audit (dangling links, invalid windows); dryRun=true by default — pass dryRun=false to actually apply fixes. Needs user approval first.',
      {
        action: { type: 'string', description: '"resolve" | "auto" | "repair" (mặc định "resolve").' },
        dryRun: { type: 'boolean', description: 'true = chỉ báo cáo, không sửa (mặc định true; cho repair).' },
        wrongFactId: { type: 'string', description: 'Id fact sai (bắt buộc cho resolve).' },
        keptFactId: { type: 'string', description: 'Id fact đúng được giữ (bắt buộc cho resolve).' },
        policy: { type: 'string', description: '"invalidate-older" | "invalidate-newer" | "quarantine-older" | "keep-both" (mặc định "invalidate-older").' },
        reason: { type: 'string', description: 'Lý do giải quyết (bắt buộc cho resolve).' },
        invalidAt: { type: 'string', description: 'Thời điểm fact sai bắt đầu sai (ISO; vắng = bây giờ).' },
        sessionId: { type: 'string', description: 'Lọc theo session (cho auto).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'resolve';
        if (action === 'auto') {
          const sessionId = getOptionalStringArg(args, 'sessionId');
          const report = autoInvalidateConflicts(s, scopeOf(ctx, sessionId), {
            actor: `agent:${ctx.botId}`,
            ...(workspaceDir ? { workspaceDir } : {}),
          });
          return JSON.stringify({ action, ...report }, null, 2);
        }
        if (action === 'repair') {
          const sessionId = getOptionalStringArg(args, 'sessionId');
          const dryRun = getBoolArg(args, 'dryRun', true);
          const result = repairTemporalGraph(s, scopeOf(ctx, sessionId), { dryRun });
          return JSON.stringify({
            action,
            dryRun: result.dryRun,
            fixed: result.fixed,
            skippedFixable: result.skippedFixable,
            unfixable: result.unfixable,
            actions: result.actions,
            auditSummary: auditSummary(result.audit),
            remainingIssues: result.audit.issues.length,
          }, null, 2);
        }
        if (action === 'resolve') {
          const wrongFactId = getStringArg(args, 'wrongFactId');
          const keptFactId = getStringArg(args, 'keptFactId');
          const policy = (getOptionalStringArg(args, 'policy') ?? 'invalidate-older') as ContradictionPolicy;
          const reason = getStringArg(args, 'reason');
          const invalidAt = getOptionalStringArg(args, 'invalidAt');
          if (!['invalidate-older', 'invalidate-newer', 'quarantine-older', 'keep-both'].includes(policy)) {
            throw new Error('temporal_kg_resolve: policy không hợp lệ.');
          }
          const result = resolveContradiction(s, {
            wrongFactId,
            keptFactId,
            policy,
            actor: `agent:${ctx.botId}`,
            reason,
            ...(invalidAt ? { invalidAt } : {}),
            ...(workspaceDir ? { workspaceDir } : {}),
          });
          return JSON.stringify({ action, ...result }, null, 2);
        }
        throw new Error('temporal_kg_resolve: action phải là "resolve", "auto" hoặc "repair".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalKgTimeline: Tool = {
    definition: toolDef(
      'temporal_kg_timeline',
      'Timeline of one entity, one relation (edge), or one session: every version of the facts, when each was created/superseded/deleted/invalidated, plus validity gaps (times the graph knew nothing about the relation) and the full provenance chain of one fact (episode + sibling facts + supersession chain). Read-only.',
      {
        kind: { type: 'string', description: '"entity" | "edge" | "session" | "provenance" (mặc định "entity").' },
        subject: { type: 'string', description: 'Tên entity (cho entity/edge/provenance: fact thuộc entity nào).' },
        predicate: { type: 'string', description: 'Predicate (cho edge).' },
        factId: { type: 'string', description: 'Id fact (cho provenance).' },
        sessionId: { type: 'string', description: 'Id session (cho session).' },
        limit: { type: 'number', description: 'Số bước tối đa (mặc định 200, tối đa 2000).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const kind = getOptionalStringArg(args, 'kind') ?? 'entity';
        const limit = getNumberArg(args, 'limit');
        const scope = scopeOf(ctx, getOptionalStringArg(args, 'sessionId'));
        if (kind === 'session') {
          const sessionId = getStringArg(args, 'sessionId');
          const summary = sessionSummary(s, sessionId, scope);
          const steps = sessionTimeline(s, sessionId, scope, {
            ...(workspaceDir ? { workspaceDir } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          return JSON.stringify({ kind, summary, steps }, null, 2);
        }
        if (kind === 'provenance') {
          const factId = getStringArg(args, 'factId');
          const chain = factProvenanceChain(s, factId, {
            ...(workspaceDir ? { workspaceDir } : {}),
          });
          if (!chain) throw new Error('Không tìm thấy fact.');
          return JSON.stringify({
            kind,
            report: provenanceReport(chain),
            fact: publicFact(s, chain.fact),
            episode: chain.episode,
            siblings: chain.siblings.map((sib) => publicFact(s, sib.fact)),
            supersessionChain: chain.supersessionChain.map((f) => publicFact(s, f)),
            invalidations: chain.invalidations,
            provenanceComplete: chain.provenanceComplete,
          }, null, 2);
        }
        if (kind === 'edge') {
          const subject = getStringArg(args, 'subject');
          const predicate = getStringArg(args, 'predicate');
          const steps = factVersionTimeline(s, subject, predicate, scope, {
            ...(workspaceDir ? { workspaceDir } : {}),
          });
          const gaps = validityGaps(s, subject, predicate, scope);
          const invalidations = workspaceDir ? readInvalidationLog(workspaceDir, 50) : [];
          return JSON.stringify({
            kind,
            subject,
            predicate,
            steps: steps.slice(0, limit ?? 200),
            gaps,
            recentInvalidations: invalidations,
          }, null, 2);
        }
        if (kind === 'entity') {
          const subject = getStringArg(args, 'subject');
          const steps = entityTimeline(s, subject, {
            scope,
            ...(limit !== undefined ? { limit } : {}),
          });
          if (steps.length === 0) throw new Error(`Không tìm thấy entity "${subject}".`);
          return JSON.stringify({
            kind,
            subject,
            steps: steps.map((step) => ({
              at: step.at,
              kind: step.kind,
              text: step.text,
              fact: publicFact(s, step.fact),
            })),
          }, null, 2);
        }
        throw new Error('temporal_kg_timeline: kind phải là "entity", "edge", "session" hoặc "provenance".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalKgExport: Tool = {
    definition: toolDef(
      'temporal_kg_export',
      'Export / import a bi-temporal snapshot of the graph (JSON, version 2, carries both validity and transaction time + provenance). action=export writes the snapshot to a file; action=import reads a snapshot file (or inline JSON) and merges it add-only — existing facts are never overwritten. Import needs user approval first.',
      {
        action: { type: 'string', description: '"export" hoặc "import" (mặc định "export").' },
        filePath: { type: 'string', description: 'Đường dẫn file snapshot (bắt buộc cho export/import từ file).' },
        snapshotJson: { type: 'string', description: 'Snapshot JSON inline (thay cho filePath khi import).' },
        recordedAt: { type: 'string', description: 'Chỉ export fact đã biết tại R (ISO; vắng = toàn bộ lịch sử).' },
        sessionId: { type: 'string', description: 'Lọc theo session (cho export).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'export';
        const sessionId = getOptionalStringArg(args, 'sessionId');
        if (action === 'export') {
          const filePath = getStringArg(args, 'filePath');
          const recordedAt = getOptionalStringArg(args, 'recordedAt');
          const snapshot = exportTemporalSnapshot(s, scopeOf(ctx, sessionId), {
            ...(workspaceDir ? { workspaceDir } : {}),
            ...(recordedAt ? { recordedAt } : {}),
          });
          writeTemporalSnapshotFile(filePath, snapshot);
          return JSON.stringify({
            action,
            filePath,
            exportedAt: snapshot.exportedAt,
            recordedAt: snapshot.recordedAt,
            entities: snapshot.entities.length,
            facts: snapshot.facts.length,
            episodes: snapshot.episodes.length,
            invalidations: snapshot.invalidations.length,
          }, null, 2);
        }
        if (action === 'import') {
          const snapshotJson = getOptionalStringArg(args, 'snapshotJson');
          const filePath = getOptionalStringArg(args, 'filePath');
          let snapshot: TemporalSnapshot;
          if (snapshotJson) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(snapshotJson) as unknown;
            } catch {
              throw new Error('snapshotJson không phải JSON hợp lệ.');
            }
            const errors = validateTemporalSnapshot(parsed);
            if (errors.length > 0) throw new Error(`Snapshot không hợp lệ: ${errors.slice(0, 5).join(' | ')}`);
            snapshot = parsed as TemporalSnapshot;
          } else if (filePath) {
            snapshot = readTemporalSnapshotFile(filePath);
          } else {
            throw new Error('temporal_kg_export import: cần filePath hoặc snapshotJson.');
          }
          const result = importTemporalSnapshot(s, snapshot, {
            ...(workspaceDir ? { workspaceDir } : {}),
          });
          return JSON.stringify({ action, ...result }, null, 2);
        }
        throw new Error('temporal_kg_export: action phải là "export" hoặc "import".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    temporalKgAsof,
    temporalKgSnapshot,
    temporalKgInvalidate,
    temporalKgContradictions,
    temporalKgResolve,
    temporalKgTimeline,
    temporalKgExport,
  ];
}

/** Unbound placeholder (same shape as MEMORY_GRAPH_TOOLS). */
export const TEMPORAL_KG_V112_TOOLS: Tool[] = createMemoryTemporalV112Tools();

/** Tên các tool temporal KG v2 (để coordinator/registry kiểm tra). */
export const TEMPORAL_KG_V112_TOOL_NAMES = [
  'temporal_kg_asof',
  'temporal_kg_snapshot',
  'temporal_kg_invalidate',
  'temporal_kg_contradictions',
  'temporal_kg_resolve',
  'temporal_kg_timeline',
  'temporal_kg_export',
] as const;
