/**
 * Memory v22 — Dreamer: dieu phoi mot luot dream (v1.37, Doi T1).
 *
 * Pipeline (chay nen, ngoai critical path cua chat):
 *   snapshot -> collect -> dedupe -> supersede -> expire
 *            -> patterns -> wiki -> budget -> report
 *
 *  - Truoc khi sua gi, dream chup snapshot day du (fact +
 *    wiki) va ghi audit `dream:start`. Neu mot phase loi
 *    nghiem trong, dream TU ROLLBACK ve snapshot va bao
 *    `rolledBack: true` — memory khong bao gio o trang thai
 *    do dang.
 *  - `dryRun: true` mo phong tren BAN SAO cua store (khong ghi
 *    gi vao store that, khong tao snapshot) — dung de xem truoc
 *    dream se lam gi.
 *  - Bao cao co bang chung tung thay doi (fact truoc/sau + ly
 *    do) + do luong always-loaded truoc/sau + wiki diff.
 *  - Tich hop v21: nhap fact tu `V21PortableRecord` (bundle
 *    OKF/MemFS/OpenHands) va xuat fact da consolidate ra lai
 *    dang record v21 de dem di / commit cung code.
 *  - Tich hop v20 (tuy chon): dong bo lop always-loaded da
 *    render vao core block `dreaming` qua `applyEdit` (co ly do
 *    + actorKind 'sleep') de lop nay that su duoc nap vao prompt.
 */
import type { V21PortableRecord } from '../v21/types';
import type { V20CoreBlockStore } from '../v20/coreBlocks';
import type {
  V22AlwaysLoadedPlan,
  V22DreamChange,
  V22DreamConfig,
  V22DreamFact,
  V22DreamFactInput,
  V22DreamReport,
  V22DreamTrigger,
  V22WikiIndex,
} from './types';
import { V22_ALWAYS_LOADED_BLOCK_LABEL, V22_DREAM_DEFAULT_CONFIG, V22DreamError } from './types';
import { V22DreamStore } from './store';
import { applyDedupeV22 } from './dedupe';
import { applySupersedeV22 } from './supersede';
import { applyExpiryV22 } from './expiry';
import { applyPatternsV22 } from './patterns';
import { buildWikiV22 } from './wiki';
import { measureAlwaysLoadedV22, planAlwaysLoadedV22 } from './budget';
import { V22AuditLog, V22SnapshotStore, cloneWikiIndexV22 } from './snapshot';
import { V22DreamScheduler, resolveDreamConfigV22 } from './scheduler';
import { V22DreamHistory } from './report';
import { collectFromTranscriptV22, type V22CollectOptions, type V22TranscriptTurn } from './collect';

/** Tuy chon chay mot dream. */
export interface V22RunDreamOptions {
  /** true = chi mo phong tren ban sao, khong ghi thay doi nao. */
  dryRun?: boolean;
  /** Actor ghi audit (mac dinh lay tu config). */
  actor?: string;
  /** Ghi de mot phan config chi cho lan chay nay. */
  configOverride?: Partial<V22DreamConfig>;
  /** Transcript gan day de phase collect nap ung vien fact (tuy chon). */
  transcriptTurns?: V22TranscriptTurn[];
  /** Tuy chon collect khi co transcriptTurns. */
  collectOptions?: V22CollectOptions;
  /** Epoch ms moc chay (mac dinh Date.now()). */
  now?: number;
  /** Ham dem token chinh xac (mac dinh heuristic chars/4). */
  countTokens?: (text: string) => number;
}

/** Ket qua dong bo always-loaded vao block v20. */
export interface V22BlockSyncResult {
  ok: boolean;
  blockId?: string;
  blockVersion?: number;
  charsWritten?: number;
  error?: string;
}

/** Ket qua rollback ve snapshot. */
export interface V22RollbackResult {
  ok: boolean;
  snapshotId: string;
  restoredFacts?: number;
  wikiRestored?: boolean;
  error?: string;
}

/** Dreamer — chu so huu store + scheduler + snapshot + audit + wiki. */
export class V22Dreamer {
  readonly store: V22DreamStore;
  readonly snapshots: V22SnapshotStore;
  readonly audit: V22AuditLog;
  readonly scheduler: V22DreamScheduler;
  /** Lich su cac dream da chay (de tinh xu huong). */
  readonly history: V22DreamHistory;
  private config: V22DreamConfig;
  private wikiIndex: V22WikiIndex | undefined;
  private lastReport: V22DreamReport | undefined;
  private jobSeq = 0;

  constructor(opts: {
    config?: Partial<V22DreamConfig>;
    store?: V22DreamStore;
    snapshots?: V22SnapshotStore;
    audit?: V22AuditLog;
    scheduler?: V22DreamScheduler;
  } = {}) {
    this.config = resolveDreamConfigV22(opts.config);
    this.store = opts.store ?? new V22DreamStore();
    this.snapshots = opts.snapshots ?? new V22SnapshotStore();
    this.audit = opts.audit ?? new V22AuditLog();
    this.scheduler = opts.scheduler ?? new V22DreamScheduler(this.config);
    this.history = new V22DreamHistory();
  }

  /** Config hien tai (ban sao). */
  getConfig(): V22DreamConfig {
    return { ...this.config };
  }

  /** Doi config (validate; dong bo sang scheduler). */
  updateConfig(partial: Partial<V22DreamConfig>): V22DreamConfig {
    this.config = resolveDreamConfigV22({ ...this.config, ...partial });
    this.scheduler.updateConfig(this.config);
    return this.getConfig();
  }

  /** Chi muc wiki hien tai (undefined neu chua dream lan nao). */
  getWikiIndex(): V22WikiIndex | undefined {
    return this.wikiIndex ? cloneWikiIndexV22(this.wikiIndex) : undefined;
  }

  /** Bao cao dream gan nhat (neu co). */
  getLastReport(): V22DreamReport | undefined {
    return this.lastReport;
  }

  /** Lap ke hoach always-loaded tu fact hien tai (khong chay dream). */
  getBudgetPlan(): V22AlwaysLoadedPlan {
    return planAlwaysLoadedV22(this.store.list({ status: 'active' }), {
      budgetChars: this.config.maxCharsAlwaysLoaded,
      promoteThreshold: this.config.promoteThreshold,
      priorityHalfLifeDays: this.config.priorityHalfLifeDays,
    });
  }

  /**
   * Chay mot luot dream day du. Khong throw (tru khi lap trinh
   * sai): loi phase nao cung ghi vao report.errors; loi
   * nghiem trong thi rollback ve snapshot va bao rolledBack.
   */
  runDream(trigger: V22DreamTrigger, opts: V22RunDreamOptions = {}): V22DreamReport {
    const now = opts.now ?? Date.now();
    const actor = opts.actor ?? this.config.actor;
    const dryRun = opts.dryRun === true;
    const config: V22DreamConfig = opts.configOverride
      ? resolveDreamConfigV22({ ...this.config, ...opts.configOverride })
      : this.config;
    this.jobSeq += 1;
    const jobId = `dream-v22-${now}-${this.jobSeq}`;
    const startedAt = now;
    const errors: string[] = [];
    const skipped: string[] = [];
    const changes: V22DreamChange[] = [];
    let snapshotId: string | undefined;
    let rolledBack = false;

    // Do always-loaded TRUOC dream (tren store that).
    const factsBeforeList = this.store.list({ status: 'active' });
    const factsBefore = factsBeforeList.length;
    const budgetBefore = measureAlwaysLoadedV22(factsBeforeList, {
      budgetChars: config.maxCharsAlwaysLoaded,
      promoteThreshold: config.promoteThreshold,
      priorityHalfLifeDays: config.priorityHalfLifeDays,
      ...(opts.countTokens ? { countTokens: opts.countTokens } : {}),
      now,
    });

    // Store lam viec: dryRun thi dung ban sao (khong dong toi store that).
    const workStore = dryRun ? cloneStoreV22(this.store) : this.store;
    const workWikiBefore = this.wikiIndex ? cloneWikiIndexV22(this.wikiIndex) : undefined;

    const finish = (overrides: Partial<V22DreamReport>): V22DreamReport => {
      const finishedAt = Date.now();
      const factsAfterList = workStore.list({ status: 'active' });
      const budgetAfter = measureAlwaysLoadedV22(factsAfterList, {
        budgetChars: config.maxCharsAlwaysLoaded,
        promoteThreshold: config.promoteThreshold,
        priorityHalfLifeDays: config.priorityHalfLifeDays,
        ...(opts.countTokens ? { countTokens: opts.countTokens } : {}),
        now: finishedAt,
      });
      const report: V22DreamReport = {
        jobId,
        trigger,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        dryRun,
        ...(snapshotId ? { snapshotId } : {}),
        rolledBack,
        factsBefore,
        factsAfter: factsAfterList.length,
        factsCollected: 0,
        duplicatesMerged: 0,
        factsSuperseded: 0,
        factsExpired: 0,
        patternsCreated: 0,
        patternsUpdated: 0,
        wikiPages: 0,
        budgetBefore,
        budgetAfter,
        changes,
        errors,
        skipped,
        ...overrides,
      };
      this.lastReport = report;
      this.history.record(report);
      return report;
    };

    // Phase 0 — snapshot (bo qua khi dryRun).
    if (!dryRun) {
      try {
        const snapshot = this.snapshots.create(workStore, {
          actor,
          reason: `truoc dream ${jobId} (trigger ${trigger})`,
          wiki: workWikiBefore,
          label: 'truoc-dream',
          now,
        });
        snapshotId = snapshot.id;
        this.audit.append({
          actor,
          action: 'dream:start',
          factIds: [],
          snapshotId,
          detail: `Dream ${jobId} bat dau (trigger ${trigger}); snapshot ${snapshotId} da chup (${snapshot.facts.length} fact).`,
          at: now,
        });
      } catch (e) {
        errors.push(`snapshot that bai: ${e instanceof Error ? e.message : String(e)}`);
        return finish({});
      }
    }

    // Phase 0.5 — collect (chi khi host day transcript vao): tach
    // transcript thanh ung vien fact roi nap vao store lam viec.
    // Ung vien khong hop le thi bo qua co ghi ly do.
    let factsCollected = 0;
    if (opts.transcriptTurns && opts.transcriptTurns.length > 0) {
      try {
        const collected = collectFromTranscriptV22(opts.transcriptTurns, {
          ...(opts.collectOptions ?? {}),
          now,
        });
        for (const candidate of collected.candidates) {
          const added = workStore.addFact(candidate, now);
          if (added.ok) factsCollected += 1;
          else skipped.push(`bo qua ung vien collect: ${added.error ?? 'loi khong ro'} ("${candidate.text.slice(0, 60)}")`);
        }
        for (const skip of collected.skipped.slice(0, 20)) skipped.push(`collect: ${skip}`);
        if (collected.skipped.length > 20) {
          skipped.push(`collect: ... va ${collected.skipped.length - 20} cau bi bo qua khac.`);
        }
      } catch (e) {
        errors.push(`collect that bai: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Cac phase sua store — loi phase nao thi dung lai, rollback (neu khong dryRun).
    let counts = { duplicatesMerged: 0, factsSuperseded: 0, factsExpired: 0, patternsCreated: 0, patternsUpdated: 0 };
    try {
      // Phase 1 — dedupe.
      const deduped = applyDedupeV22(workStore, {
        dedupeThreshold: config.dedupeThreshold,
        maxFacts: config.maxFactsPerDream,
        now,
      });
      counts.duplicatesMerged = deduped.mergedCount;
      changes.push(...deduped.changes);
      skipped.push(...deduped.skipped);

      // Phase 2 — supersede.
      const superseded = applySupersedeV22(workStore, {
        minConfidenceGap: config.minConfidenceGap,
        maxFacts: config.maxFactsPerDream,
        now,
      });
      counts.factsSuperseded = superseded.supersededCount;
      changes.push(...superseded.changes);
      skipped.push(...superseded.skipped);

      // Phase 3 — expiry.
      const expired = applyExpiryV22(workStore, { now, maxFacts: config.maxFactsPerDream });
      counts.factsExpired = expired.expired.length;
      changes.push(...expired.changes);
      skipped.push(...expired.skipped);

      // Phase 4 — patterns.
      const patterned = applyPatternsV22(workStore, {
        patternMinSessions: config.patternMinSessions,
        patternMinObservations: config.patternMinObservations,
        maxFacts: config.maxFactsPerDream,
        now,
      });
      counts.patternsCreated = patterned.created.length;
      counts.patternsUpdated = patterned.updated.length;
      changes.push(...patterned.changes);
      skipped.push(...patterned.skipped);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`dream that bai giua chung: ${message}`);
      if (!dryRun && snapshotId) {
        const restored = this.snapshots.restore(this.store, snapshotId);
        if (restored.ok) {
          rolledBack = true;
          this.wikiIndex = workWikiBefore;
          this.audit.append({
            actor,
            action: 'dream:rollback',
            factIds: [],
            snapshotId,
            detail: `Dream ${jobId} loi (${message}) — da rollback ve snapshot ${snapshotId} (${restored.restoredFacts ?? 0} fact).`,
            at: Date.now(),
          });
        } else {
          errors.push(`rollback that bai: ${restored.error ?? 'loi khong ro'} — CAN KIEM TRA THU CONG.`);
        }
      }
      return finish({ ...counts, factsCollected, rolledBack });
    }

    // Phase 5 — wiki (xay lai tu fact sau consolidate).
    let wikiPages = 0;
    try {
      const wiki = buildWikiV22(workStore.list(), { jobId, previous: workWikiBefore, now });
      wikiPages = wiki.pages.length;
      if (!dryRun) {
        const prevPages = workWikiBefore?.pages.length ?? 0;
        this.wikiIndex = wiki;
        if (wiki.pagesAdded > 0 || wiki.pagesRemoved > 0 || wiki.pagesChanged > 0 || prevPages === 0) {
          changes.push({
            id: 'chg-wiki-1',
            kind: 'wiki',
            factIdsBefore: [],
            factIdsAfter: wiki.pages.flatMap((p) => p.factIds),
            reason: `Wiki xay lai: ${wiki.pages.length} trang (${wiki.pagesAdded} moi, ${wiki.pagesRemoved} mat, ${wiki.pagesChanged} doi noi dung).`,
            detail: `trang: ${wiki.pages.map((p) => p.slug).join(', ') || '(rong)'}`,
            at: now,
          });
        }
      }
    } catch (e) {
      errors.push(`wiki that bai: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Phase 6 — budget: do lai + ghi change neu lop bi cat bot.
    const factsAfterList = workStore.list({ status: 'active' });
    const budgetAfter = measureAlwaysLoadedV22(factsAfterList, {
      budgetChars: config.maxCharsAlwaysLoaded,
      promoteThreshold: config.promoteThreshold,
      priorityHalfLifeDays: config.priorityHalfLifeDays,
      ...(opts.countTokens ? { countTokens: opts.countTokens } : {}),
      now,
    });
    if (budgetAfter.excludedIds.length > 0 && budgetBefore.excludedIds.length !== budgetAfter.excludedIds.length) {
      changes.push({
        id: 'chg-budget-1',
        kind: 'budget_trim',
        factIdsBefore: budgetBefore.includedIds,
        factIdsAfter: budgetAfter.includedIds,
        reason: `Always-loaded sau dream: ${budgetAfter.chars}/${budgetAfter.budgetChars} ky tu, ${budgetAfter.includedIds.length} fact duoc chon, ${budgetAfter.excludedIds.length} fact bi cat khoi lop (het ngan sach).`,
        at: now,
      });
    }

    // Ghi audit ket thuc (khong ghi khi dryRun).
    if (!dryRun) {
      const allFactIds = [...new Set(changes.flatMap((c) => [...c.factIdsBefore, ...c.factIdsAfter]))];
      this.audit.append({
        actor,
        action: 'dream:done',
        factIds: allFactIds,
        snapshotId,
        detail: `Dream ${jobId} xong: thu thap ${factsCollected}, gop ${counts.duplicatesMerged}, supersede ${counts.factsSuperseded}, het han ${counts.factsExpired}, pattern moi ${counts.patternsCreated} / cap nhat ${counts.patternsUpdated}, wiki ${wikiPages} trang; always-loaded ${budgetBefore.chars} -> ${budgetAfter.chars} ky tu.`,
        at: Date.now(),
      });
      this.scheduler.markRunFinished(finish({ ...counts, factsCollected, wikiPages }));
      // finish() o tren da tao report; lay lai de tra ve (tranh tao 2 report).
      return this.lastReport as V22DreamReport;
    }
    return finish({ ...counts, factsCollected, wikiPages });
  }

  /**
   * Rollback ve mot snapshot: khoi phuc fact + wiki dung trang
   * thai luc chup, ghi audit `rollback`. Tra loi co cau truc.
   */
  rollbackToSnapshot(snapshotId: string, actor?: string): V22RollbackResult {
    const who = actor ?? this.config.actor;
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return { ok: false, snapshotId, error: `khong co snapshot "${snapshotId}".` };
    }
    const restored = this.snapshots.restore(this.store, snapshotId);
    if (!restored.ok) {
      return { ok: false, snapshotId, error: restored.error ?? 'loi khong ro' };
    }
    this.wikiIndex = snapshot.wiki ? cloneWikiIndexV22(snapshot.wiki) : undefined;
    this.audit.append({
      actor: who,
      action: 'rollback',
      factIds: snapshot.facts.map((f) => f.id),
      snapshotId,
      detail: `Rollback ve snapshot ${snapshotId} (chup ${new Date(snapshot.createdAt).toISOString()}, ly do: ${snapshot.reason}): khoi phuc ${restored.restoredFacts ?? 0} fact${restored.wikiRestored ? ' + wiki' : ''}.`,
      at: Date.now(),
    });
    return {
      ok: true,
      snapshotId,
      restoredFacts: restored.restoredFacts,
      wikiRestored: restored.wikiRestored,
    };
  }

  /**
   * Nhap fact tu record v21 (bundle OKF/MemFS/OpenHands): moi
   * record thanh mot dream fact. Topic/value lay tu tag dang
   * `topic:<x>` / `value:<y>` (neu co); han lay tu `staleAfter`.
   */
  importFromV21Records(
    records: V21PortableRecord[],
    opts: { actor?: string; now?: number } = {},
  ): { imported: number; skipped: number; errors: string[] } {
    const now = opts.now ?? Date.now();
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const record of records) {
      const input = v21RecordToDreamInputV22(record, now);
      if (!input) {
        skipped += 1;
        errors.push(`bo qua record "${record.id}": body rong hoac thieu truong.`);
        continue;
      }
      const res = this.store.addFact(input, now);
      if (res.ok) imported += 1;
      else {
        skipped += 1;
        errors.push(`bo qua record "${record.id}": ${res.error ?? 'loi khong ro'}`);
      }
    }
    if (imported > 0) {
      this.audit.append({
        actor: opts.actor ?? this.config.actor,
        action: 'import:v21',
        factIds: [],
        detail: `Nhap ${imported} fact tu record v21 (${skipped} bi bo qua).`,
        at: now,
      });
    }
    return { imported, skipped, errors };
  }

  /**
   * Xuat fact active da consolidate ra dang record v21 de dem
   * di / commit cung code (giong export OKF cua v21).
   */
  exportToV21Records(jobId = 'dream:v22'): V21PortableRecord[] {
    return this.store.list({ status: 'active' }).map((fact) => dreamFactToV21RecordV22(fact, jobId));
  }

  /**
   * Dong bo lop always-loaded da render vao core block v20
   * (label `dreaming`): tao block neu chua co, replace noi dung
   * bang text always-loaded hien tai. Loi thi tra ve co cau truc
   * (khong throw) — block day thi bao loi ro thay vi cat ngam.
   */
  syncAlwaysLoadedToBlock(blockStore: V20CoreBlockStore, now = Date.now()): V22BlockSyncResult {
    const plan = this.getBudgetPlan();
    const label = V22_ALWAYS_LOADED_BLOCK_LABEL;
    let target = blockStore.getBlock(label);
    if (!target) {
      const created = blockStore.createBlock({
        label,
        kind: 'facts',
        value: '',
        actor: 'dream:v22',
      });
      if (!created.ok || !created.block) {
        return { ok: false, error: `khong tao duoc block "${label}": ${created.error ?? 'loi khong ro'}` };
      }
      target = created.block;
    }
    const res = blockStore.applyEdit({
      blockId: target.id,
      op: 'replace',
      actor: 'dream:v22',
      actorKind: 'sleep',
      newValue: plan.renderedText,
      reason: `dream v22: dong bo lop always-loaded (${plan.measurement.factCount} fact, ${plan.measurement.chars}/${plan.measurement.budgetChars} ky tu)`,
    });
    if (!res.ok || !res.block) {
      return { ok: false, error: `khong ghi duoc block "${label}": ${res.error ?? 'loi khong ro'}` };
    }
    return {
      ok: true,
      blockId: res.block.id,
      blockVersion: res.block.version,
      charsWritten: plan.measurement.chars,
    };
  }
}

/** Ban sao sau cua mot store (de dryRun khong dong toi store that). */
export function cloneStoreV22(source: V22DreamStore): V22DreamStore {
  const copy = new V22DreamStore();
  copy.importState(source.exportState());
  return copy;
}

/** Chuyen record v21 thanh input dream fact (null = khong nhap duoc). */
export function v21RecordToDreamInputV22(
  record: V21PortableRecord,
  now = Date.now(),
): V22DreamFactInput | null {
  const text = typeof record.body === 'string' ? record.body.trim() : '';
  if (!text) return null;
  const topicTag = record.tags.find((t) => t.startsWith('topic:'));
  const valueTag = record.tags.find((t) => t.startsWith('value:'));
  const kindMap: Record<string, V22DreamFactInput['kind']> = {
    fact: 'fact',
    preference: 'preference',
    decision: 'decision',
    note: 'note',
    person: 'note',
    project: 'note',
    procedure: 'note',
    custom: 'note',
  };
  let validUntil: number | undefined;
  if (record.staleAfter) {
    const parsed = Date.parse(`${record.staleAfter}T23:59:59.999Z`);
    if (Number.isFinite(parsed)) validUntil = parsed;
  }
  return {
    kind: kindMap[record.type] ?? 'fact',
    text,
    ...(topicTag ? { topic: topicTag.slice('topic:'.length) } : {}),
    ...(valueTag ? { value: valueTag.slice('value:'.length) } : {}),
    confidence: record.verified ? 0.8 : 0.7,
    sources: [...record.sources, `v21:${record.id}`],
    tags: [...record.tags, 'imported-v21'],
    observedAt: record.updatedAt ?? now,
    ...(validUntil !== undefined ? { validUntil } : {}),
    origin: 'import',
  };
}

/** Chuyen dream fact thanh record v21 (de xuat bundle / commit cung code). */
export function dreamFactToV21RecordV22(fact: V22DreamFact, jobId = 'dream:v22'): V21PortableRecord {
  const typeMap: Record<V22DreamFact['kind'], V21PortableRecord['type']> = {
    fact: 'fact',
    preference: 'preference',
    decision: 'decision',
    observation: 'note',
    pattern: 'fact',
    note: 'note',
  };
  return {
    id: fact.id,
    type: typeMap[fact.kind],
    title: fact.text.slice(0, 80),
    body: fact.text,
    tags: [...new Set([...fact.tags, 'dream-consolidated'])],
    sources: [...new Set([...fact.sources, jobId])],
    codeRefs: [],
    version: fact.version,
    createdAt: fact.observedAt,
    updatedAt: fact.updatedAt,
    ...(fact.validUntil !== undefined
      ? { staleAfter: new Date(fact.validUntil).toISOString().slice(0, 10) }
      : {}),
    originFormat: 'okf',
  };
}
