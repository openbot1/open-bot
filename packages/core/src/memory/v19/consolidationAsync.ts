/**
 * Memory v19 — Consolidation pipeline bat dong bo (v1.20, Doi T1).
 *
 * Y tuong hoc tu Letta sleep-time compute + Mem0 consolidation
 * (gom fact luc ranh, khong chan luong chinh) — tu thiet ke lai
 * hoan toan cho open-bot, KHONG copy code/text/tai san cua bat ky
 * repo nao.
 *
 * Khac v18 (`sleepConsolidationV2`, chay dong bo mot pass):
 *  1. BAT DONG BO THEO CHUNK: moi phase xu ly theo chunk nho
 *     (`chunkSize`) va nhuong event loop bang `setImmediate` giua
 *     cac chunk — host co the chay consolidation nen trong luc
 *     bot dang tra loi ma khong bi block. Job co the pause /
 *     resume / cancel giua chung; tien do bao cao qua callback.
 *  2. GIAI QUYET MAU THUAN (moi so voi v18): fact cung
 *     subject + predicate don tri nhung object khac nhau duoc
 *     phan xu — thang (confidence cao nhat, hoa thi moi nhat)
 *     o lai, thua bi invalidate co ly do ghi ro fact thang
 *     (qua `markFactInvalidated`, lich su van truy van duoc).
 *     Neu chenh lech confidence < `minConflictGap` thi GIU CA
 *     HAI va bao cao `unresolved` — khong lang le ghi de khi
 *     chua ro ben nao dung (can user quyet dinh sau).
 *  3. DECAY LIEN TUC theo thoi gian: confidence giam theo ham mu
 *     `conf * 0.5^(tuoi / halfLifeDays)` thay vi tru buoc co dinh
 *     nhu v18; chi ap dung cho fact cu (`isStaleFactV18`) va chi
 *     khi muc giam >= `minDecayApply` de tranh churn. Fact roi
 *     duoi `minConfidence` CHI DUOC DEM (`factsBelowMin`), KHONG
 *     tu dong xoa/invalidate — giong quy tac an toan cua v18.
 *
 * Tai su dung, khong viet lai:
 *  - `findDuplicateFactGroupsV18` / `pickKeepFactV18` /
 *    `isStaleFactV18` (v18): dedup + chon ban giu + xac dinh
 *    fact cu; v19 chi goi qua chung.
 *  - `TemporalGraphStore.mergeFacts` / `markFactInvalidated` /
 *    `setFactConfidence`: thao tac duy nhat len graph; v19
 *    khong tu sua `file.facts`.
 *  - `isSingleValuedPredicateV15`: predicate nao la don tri
 *    (chi mot object dung tai mot thoi diem) moi duoc giai quyet
 *    mau thuan; predicate da tri (vd `likes`) khong bao gio bi
 *    invalidate vi \"mau thuan\".
 *
 * Pipeline KHONG goi model, KHONG goi mang. Loi o mot nhom/mot
 * fact chi ghi vao bao cao (fail-open theo muc), khong throw
 * ra caller — giong v18.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { isSingleValuedPredicateV15 } from '../../memoryV15/consolidation';
import {
  findDuplicateFactGroupsV18,
  pickKeepFactV18,
  isStaleFactV18,
} from '../v18/sleepConsolidationV2';

/** Loi consolidation async v19 — message tieng Viet. */
export class V19ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19ConsolidationError';
  }
}

/** Duong dan tuong doi file log cac lan chay (giong kieu v18). */
export const V19_CONSOLIDATION_RUNS_REL_PATH = path.join(
  'memory',
  'v19-consolidation-runs.jsonl',
);
/** So fact toi da quet moi lan chay. */
export const V19_DEFAULT_MAX_FACTS_PER_RUN = 2000;
/** So lan gop toi da moi lan chay. */
export const V19_DEFAULT_MAX_MERGES_PER_RUN = 50;
/** So lan invalidate (giai quyet mau thuan) toi da moi lan chay. */
export const V19_DEFAULT_MAX_INVALIDATIONS_PER_RUN = 50;
/** Budget thoi gian moi lan chay (ms). */
export const V19_DEFAULT_MAX_MS_PER_RUN = 30_000;
/** So fact xu ly moi chunk truoc khi nhuong event loop. */
export const V19_DEFAULT_CHUNK_SIZE = 100;
/** Chu ky ban ra (ngay) cua decay ham mu mac dinh: 180 ngay. */
export const V19_DEFAULT_DECAY_HALF_LIFE_DAYS = 180;
/** Muc giam confidence toi thieu moi ghi decay (tranh churn). */
export const V19_DEFAULT_MIN_DECAY_APPLY = 0.01;
/** Fact khong doi qua bao nhieu ngay thi coi la cu. */
export const V19_DEFAULT_STALE_AFTER_DAYS = 90;
/** Confidence duoi nguong nay chi dem, khong tu xoa. */
export const V19_DEFAULT_MIN_CONFIDENCE = 0.2;
/** Chenh lech confidence toi thieu de thang mau thuan (duoi thi giu ca hai). */
export const V19_DEFAULT_MIN_CONFLICT_GAP = 0.05;
/** Actor ghi vao audit khi invalidate/gop. */
export const V19_DEFAULT_CONSOLIDATION_ACTOR = 'system:consolidation-v19';

/** Trang thai cua mot consolidation job. */
export type V19ConsolidationJobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'failed';

/** Cau hinh pipeline consolidation async v19. */
export interface V19AsyncConsolidationConfig {
  /** So fact toi da quet moi lan chay. */
  maxFactsPerRun: number;
  /** So lan gop toi da moi lan chay. */
  maxMergesPerRun: number;
  /** So lan invalidate toi da moi lan chay. */
  maxInvalidationsPerRun: number;
  /** Budget thoi gian moi lan chay (ms). */
  maxMsPerRun: number;
  /** So fact moi chunk. */
  chunkSize: number;
  /** Chu ky ban ra decay (ngay). */
  decayHalfLifeDays: number;
  /** Muc giam toi thieu moi ghi decay. */
  minDecayApply: number;
  /** Fact cu sau bao nhieu ngay khong doi. */
  staleAfterDays: number;
  /** Nguong confidence toi thieu (chi dem). */
  minConfidence: number;
  /** Chenh lech confidence toi thieu de phan thang mau thuan. */
  minConflictGap: number;
  /** Actor ghi audit. */
  actor: string;
}

/** Cau hinh mac dinh. */
export const V19_DEFAULT_ASYNC_CONSOLIDATION_CONFIG: V19AsyncConsolidationConfig = {
  maxFactsPerRun: V19_DEFAULT_MAX_FACTS_PER_RUN,
  maxMergesPerRun: V19_DEFAULT_MAX_MERGES_PER_RUN,
  maxInvalidationsPerRun: V19_DEFAULT_MAX_INVALIDATIONS_PER_RUN,
  maxMsPerRun: V19_DEFAULT_MAX_MS_PER_RUN,
  chunkSize: V19_DEFAULT_CHUNK_SIZE,
  decayHalfLifeDays: V19_DEFAULT_DECAY_HALF_LIFE_DAYS,
  minDecayApply: V19_DEFAULT_MIN_DECAY_APPLY,
  staleAfterDays: V19_DEFAULT_STALE_AFTER_DAYS,
  minConfidence: V19_DEFAULT_MIN_CONFIDENCE,
  minConflictGap: V19_DEFAULT_MIN_CONFLICT_GAP,
  actor: V19_DEFAULT_CONSOLIDATION_ACTOR,
};

/** Bao cao mot lan chay consolidation v19. */
export interface V19AsyncConsolidationReport {
  /** Id job. */
  jobId: string;
  /** Thoi diem bat dau (ISO). */
  at: string;
  /** Thoi gian chay (ms). */
  durationMs: number;
  /** So fact da quet. */
  factsScanned: number;
  /** So nhom trung lap tim thay. */
  duplicateGroups: number;
  /** So fact da gop (superseded ve ban giu). */
  factsMerged: number;
  /** So nhom mau thuan da phan xu (thang/thua ro). */
  conflictsResolved: number;
  /** So nhom mau thuan giu ca hai (chenh lech qua nho). */
  conflictsUnresolved: number;
  /** So fact bi invalidate vi thua mau thuan. */
  factsInvalidated: number;
  /** So fact bi ha confidence (decay). */
  factsDecayed: number;
  /** So fact roi duoi minConfidence (chi dem, khong xoa). */
  factsBelowMin: number;
  /** true = het budget giua chung (chua xong het). */
  budgetExhausted: boolean;
  /** Ly do dung: 'done' | mo ta budget / cancel / loi. */
  stoppedBecause: string;
}

/** Tien do giua chung (cho UI / log). */
export interface V19ConsolidationProgress {
  jobId: string;
  phase: 'dedup' | 'conflicts' | 'decay' | 'done';
  processed: number;
  total: number;
  status: V19ConsolidationJobStatus;
}

function clamp01V19(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Nhuong event loop mot nhip (de host xen viec khac vao giua cac chunk). */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Confidence sau decay ham mu: `conf * 0.5^(tuoiNgay / halfLifeDays)`.
 * Ham thua — dung duoc trong test ma khong can store.
 */
export function decayConfidenceV19(
  confidence: number,
  ageDays: number,
  halfLifeDays: number,
): number {
  const conf = clamp01V19(confidence);
  const half = halfLifeDays > 0 ? halfLifeDays : V19_DEFAULT_DECAY_HALF_LIFE_DAYS;
  const age = Math.max(0, ageDays);
  if (age <= 0) return conf;
  return clamp01V19(conf * Math.pow(0.5, age / half));
}

/**
 * Tim nhom mau thuan: cung subject + predicate DON TRI, object
 * chuan hoa khac nhau, deu dang active. Predicate da tri khong
 * bao gio vao day (nhieu object cung dung duoc).
 */
export function findConflictGroupsV19(facts: GraphFact[]): GraphFact[][] {
  const byKey = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    if (fact.status !== 'active') continue;
    if (!isSingleValuedPredicateV15(fact.predicate)) continue;
    const key = [
      fact.subjectId,
      normalizeGraphText(fact.predicate).replace(/\s+/g, '_'),
    ].join('|');
    const group = byKey.get(key) ?? [];
    group.push(fact);
    byKey.set(key, group);
  }
  const out: GraphFact[][] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const distinctObjects = new Set(
      group.map((f) => normalizeGraphText(f.objectText ?? '')),
    );
    if (distinctObjects.size > 1) out.push(group);
  }
  return out;
}

/** Chon fact thang trong mot nhom mau thuan: confidence cao nhat, hoa thi moi nhat. */
export function pickConflictWinnerV19(group: GraphFact[]): GraphFact {
  const sorted = [...group].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return sorted[0] as GraphFact;
}

/** Ghi bao cao chay vao file JSONL (fail-open: loi ghi file khong throw). */
function appendConsolidationRunLogV19(
  workspaceDir: string,
  report: V19AsyncConsolidationReport,
): boolean {
  try {
    const filePath = path.join(workspaceDir, V19_CONSOLIDATION_RUNS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(report)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Doc lich su cac lan chay v19 (moi dong mot JSON); file loi/dong hong thi bo qua dong do. */
export function readConsolidationRunLogV19(workspaceDir: string): V19AsyncConsolidationReport[] {
  try {
    const filePath = path.join(workspaceDir, V19_CONSOLIDATION_RUNS_REL_PATH);
    if (!fs.existsSync(filePath)) return [];
    const out: V19AsyncConsolidationReport[] = [];
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        out.push(JSON.parse(trimmed) as V19AsyncConsolidationReport);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

let v19JobCounter = 0;

/**
 * Mot job consolidation async: chay 3 phase (dedup -> mau thuan ->
 * decay) theo chunk, co the pause/resume/cancel. Tao bang
 * `runConsolidationAsyncV19` (khong `new` truc tiep).
 */
export class V19ConsolidationJob {
  readonly id: string;
  status: V19ConsolidationJobStatus = 'queued';
  readonly report: V19AsyncConsolidationReport;
  private readonly store: TemporalGraphStore;
  private readonly scope: MemoryScope;
  private readonly cfg: V19AsyncConsolidationConfig;
  private readonly onProgress?: (p: V19ConsolidationProgress) => void;
  private readonly workspaceDir?: string;
  private readonly now: Date;
  private pausePromise: Promise<void> | null = null;
  private resumeFn: (() => void) | null = null;
  private cancelled = false;
  private started = false;

  constructor(
    store: TemporalGraphStore,
    scope: MemoryScope,
    cfg: V19AsyncConsolidationConfig,
    opts: {
      onProgress?: (p: V19ConsolidationProgress) => void;
      workspaceDir?: string;
      now?: Date;
    },
  ) {
    this.store = store;
    this.scope = scope;
    this.cfg = cfg;
    this.onProgress = opts.onProgress;
    this.workspaceDir = opts.workspaceDir;
    this.now = opts.now ?? new Date();
    v19JobCounter += 1;
    this.id = `v19-consol-${this.now.getTime().toString(36)}-${v19JobCounter}`;
    this.report = {
      jobId: this.id,
      at: this.now.toISOString(),
      durationMs: 0,
      factsScanned: 0,
      duplicateGroups: 0,
      factsMerged: 0,
      conflictsResolved: 0,
      conflictsUnresolved: 0,
      factsInvalidated: 0,
      factsDecayed: 0,
      factsBelowMin: 0,
      budgetExhausted: false,
      stoppedBecause: 'done',
    };
  }

  /** Tam dung job (chi co tac dung khi job dang chay). */
  pause(): void {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.pausePromise = new Promise<void>((resolve) => {
      this.resumeFn = resolve;
    });
  }

  /** Tiep tuc job da pause. */
  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'running';
    const fn = this.resumeFn;
    this.resumeFn = null;
    this.pausePromise = null;
    if (fn) fn();
  }

  /** Huy job (dung o ranh gioi chunk ke tiep). */
  cancel(): void {
    this.cancelled = true;
    if (this.status === 'paused') this.resume();
  }

  private async waitIfPaused(): Promise<void> {
    if (this.pausePromise) await this.pausePromise;
  }

  private emit(phase: V19ConsolidationProgress['phase'], processed: number, total: number): void {
    if (!this.onProgress) return;
    try {
      this.onProgress({ jobId: this.id, phase, processed, total, status: this.status });
    } catch {
      // Callback loi: khong lam hong job.
    }
  }

  /** Chay job toi khi xong / het budget / bi cancel. Goi dung 1 lan. */
  async run(): Promise<V19AsyncConsolidationReport> {
    if (this.started) throw new V19ConsolidationError('Job consolidation v19 chi chay duoc mot lan.');
    this.started = true;
    const startMs = Date.now();
    const nowMs = this.now.getTime();
    this.status = 'running';
    const report = this.report;
    const outOfTime = (): boolean => Date.now() - startMs > this.cfg.maxMsPerRun;
    try {
      const facts = this.store.listFacts({
        ...this.scope,
        status: 'active',
        limit: this.cfg.maxFactsPerRun,
      });
      report.factsScanned = facts.length;

      // Phase 1 — dedup (tai dung v18).
      const groups = findDuplicateFactGroupsV18(facts);
      report.duplicateGroups = groups.length;
      for (let i = 0; i < groups.length; i += 1) {
        await this.waitIfPaused();
        if (this.cancelled) {
          report.stoppedBecause = 'bi huy boi host (cancel)';
          break;
        }
        if (outOfTime() || report.factsMerged >= this.cfg.maxMergesPerRun) {
          report.budgetExhausted = true;
          report.stoppedBecause = 'het budget gop (maxMergesPerRun / maxMsPerRun)';
          break;
        }
        const group = groups[i] as GraphFact[];
        const keep = pickKeepFactV18(group);
        const duplicates = group.filter((f) => f.id !== keep.id).map((f) => f.id);
        try {
          const merged = this.store.mergeFacts(keep.id, duplicates, this.cfg.actor);
          report.factsMerged += merged.length;
        } catch {
          continue;
        }
        if (i % this.cfg.chunkSize === this.cfg.chunkSize - 1) {
          this.emit('dedup', i + 1, groups.length);
          await yieldToLoop();
        }
      }

      // Phase 2 — giai quyet mau thuan (chi khi chua het budget / chua cancel).
      if (!report.budgetExhausted && !this.cancelled) {
        const remaining = this.store.listFacts({
          ...this.scope,
          status: 'active',
          limit: this.cfg.maxFactsPerRun,
        });
        const conflicts = findConflictGroupsV19(remaining);
        for (let i = 0; i < conflicts.length; i += 1) {
          await this.waitIfPaused();
          if (this.cancelled) {
            report.stoppedBecause = 'bi huy boi host (cancel)';
            break;
          }
          if (outOfTime() || report.factsInvalidated >= this.cfg.maxInvalidationsPerRun) {
            report.budgetExhausted = true;
            report.stoppedBecause = 'het budget invalidate (maxInvalidationsPerRun / maxMsPerRun)';
            break;
          }
          const group = conflicts[i] as GraphFact[];
          const winner = pickConflictWinnerV19(group);
          const runnerUp = [...group]
            .filter((f) => f.id !== winner.id)
            .sort((a, b) => b.confidence - a.confidence)[0];
          const gap = winner.confidence - (runnerUp?.confidence ?? 0);
          if (gap < this.cfg.minConflictGap) {
            report.conflictsUnresolved += 1;
            continue;
          }
          let resolved = false;
          for (const loser of group) {
            if (loser.id === winner.id) continue;
            if (loser.validUntil !== null) continue; // da het hieu luc: khong can invalidate nua
            try {
              this.store.markFactInvalidated(loser.id, {
                invalidAt: this.now,
                actor: this.cfg.actor,
                reason: `Mau thuan voi fact ${winner.id} (cung ${loser.subjectId}/${loser.predicate}, confidence ${winner.confidence} > ${loser.confidence}); giu ban thang.`,
              });
              report.factsInvalidated += 1;
              resolved = true;
            } catch {
              continue;
            }
          }
          if (resolved) report.conflictsResolved += 1;
          if (i % this.cfg.chunkSize === this.cfg.chunkSize - 1) {
            this.emit('conflicts', i + 1, conflicts.length);
            await yieldToLoop();
          }
        }
      }

      // Phase 3 — decay lien tuc theo thoi gian (chi khi chua het budget / chua cancel).
      if (!report.budgetExhausted && !this.cancelled) {
        const remaining = this.store.listFacts({
          ...this.scope,
          status: 'active',
          limit: this.cfg.maxFactsPerRun,
        });
        for (let i = 0; i < remaining.length; i += 1) {
          await this.waitIfPaused();
          if (this.cancelled) {
            report.stoppedBecause = 'bi huy boi host (cancel)';
            break;
          }
          if (outOfTime()) {
            report.budgetExhausted = true;
            report.stoppedBecause = 'het budget thoi gian (maxMsPerRun) khi decay';
            break;
          }
          const fact = remaining[i] as GraphFact;
          if (!isStaleFactV18(fact, nowMs, this.cfg.staleAfterDays)) continue;
          const updatedMs = Date.parse(fact.updatedAt);
          if (Number.isNaN(updatedMs)) continue;
          const ageDays = (nowMs - updatedMs) / (24 * 60 * 60 * 1000);
          const next = decayConfidenceV19(fact.confidence, ageDays, this.cfg.decayHalfLifeDays);
          const drop = fact.confidence - next;
          if (drop < this.cfg.minDecayApply) continue;
          try {
            this.store.setFactConfidence(fact.id, next);
            report.factsDecayed += 1;
            if (next < this.cfg.minConfidence) report.factsBelowMin += 1;
          } catch {
            continue;
          }
          if (i % this.cfg.chunkSize === this.cfg.chunkSize - 1) {
            this.emit('decay', i + 1, remaining.length);
            await yieldToLoop();
          }
        }
      }
    } catch (err) {
      this.status = 'failed';
      report.stoppedBecause = `loi: ${err instanceof Error ? err.message : String(err)}`;
      report.durationMs = Date.now() - startMs;
      if (this.workspaceDir) appendConsolidationRunLogV19(this.workspaceDir, report);
      this.emit('done', report.factsScanned, report.factsScanned);
      return report;
    }
    report.durationMs = Date.now() - startMs;
    if (this.cancelled && report.stoppedBecause === 'done') {
      report.stoppedBecause = 'bi huy boi host (cancel)';
    }
    this.status = this.cancelled ? 'cancelled' : 'done';
    if (this.workspaceDir) appendConsolidationRunLogV19(this.workspaceDir, report);
    this.emit('done', report.factsScanned, report.factsScanned);
    return report;
  }
}

/**
 * Tao + chay mot consolidation job async. Tra ve job (de host
 * pause/resume/cancel) — dung `await job.run()` de chay, hoac
 * `job.run()` roi theo doi qua `onProgress`.
 */
export function runConsolidationAsyncV19(
  store: TemporalGraphStore,
  scope: MemoryScope = { userId: '', botId: '', runId: '' },
  config: Partial<V19AsyncConsolidationConfig> = {},
  opts: {
    onProgress?: (p: V19ConsolidationProgress) => void;
    workspaceDir?: string;
    now?: Date;
  } = {},
): V19ConsolidationJob {
  const cfg: V19AsyncConsolidationConfig = {
    ...V19_DEFAULT_ASYNC_CONSOLIDATION_CONFIG,
    ...config,
  };
  if (cfg.maxFactsPerRun < 1) throw new V19ConsolidationError('maxFactsPerRun phai >= 1.');
  if (cfg.chunkSize < 1) throw new V19ConsolidationError('chunkSize phai >= 1.');
  if (cfg.decayHalfLifeDays <= 0) throw new V19ConsolidationError('decayHalfLifeDays phai > 0.');
  return new V19ConsolidationJob(store, scope, cfg, opts);
}

/**
 * Pass consolidation DONG BO (mot lan, khong chunk, khong pause) —
 * dung cho test + host muon chay ngay trong sleep job co san.
 * Cung 3 phase nhu job async, nhung chay het trong mot luot goi.
 */
export function runConsolidationPassV19(
  store: TemporalGraphStore,
  scope: MemoryScope = { userId: '', botId: '', runId: '' },
  config: Partial<V19AsyncConsolidationConfig> = {},
  opts: { workspaceDir?: string; now?: Date } = {},
): V19AsyncConsolidationReport {
  const cfg: V19AsyncConsolidationConfig = {
    ...V19_DEFAULT_ASYNC_CONSOLIDATION_CONFIG,
    ...config,
  };
  if (cfg.maxFactsPerRun < 1) throw new V19ConsolidationError('maxFactsPerRun phai >= 1.');
  if (cfg.decayHalfLifeDays <= 0) throw new V19ConsolidationError('decayHalfLifeDays phai > 0.');
  const startMs = Date.now();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const report: V19AsyncConsolidationReport = {
    jobId: `v19-consol-sync-${now.getTime().toString(36)}-${v19JobCounter + 1}`,
    at: now.toISOString(),
    durationMs: 0,
    factsScanned: 0,
    duplicateGroups: 0,
    factsMerged: 0,
    conflictsResolved: 0,
    conflictsUnresolved: 0,
    factsInvalidated: 0,
    factsDecayed: 0,
    factsBelowMin: 0,
    budgetExhausted: false,
    stoppedBecause: 'done',
  };
  const outOfTime = (): boolean => Date.now() - startMs > cfg.maxMsPerRun;

  const facts = store.listFacts({ ...scope, status: 'active', limit: cfg.maxFactsPerRun });
  report.factsScanned = facts.length;

  // Phase 1 — dedup.
  const groups = findDuplicateFactGroupsV18(facts);
  report.duplicateGroups = groups.length;
  for (const group of groups) {
    if (outOfTime() || report.factsMerged >= cfg.maxMergesPerRun) {
      report.budgetExhausted = true;
      report.stoppedBecause = 'het budget gop (maxMergesPerRun / maxMsPerRun)';
      break;
    }
    const keep = pickKeepFactV18(group);
    const duplicates = group.filter((f) => f.id !== keep.id).map((f) => f.id);
    try {
      report.factsMerged += store.mergeFacts(keep.id, duplicates, cfg.actor).length;
    } catch {
      continue;
    }
  }

  // Phase 2 — mau thuan.
  if (!report.budgetExhausted) {
    const remaining = store.listFacts({ ...scope, status: 'active', limit: cfg.maxFactsPerRun });
    for (const group of findConflictGroupsV19(remaining)) {
      if (outOfTime() || report.factsInvalidated >= cfg.maxInvalidationsPerRun) {
        report.budgetExhausted = true;
        report.stoppedBecause = 'het budget invalidate (maxInvalidationsPerRun / maxMsPerRun)';
        break;
      }
      const winner = pickConflictWinnerV19(group);
      const runnerUp = [...group]
        .filter((f) => f.id !== winner.id)
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (winner.confidence - (runnerUp?.confidence ?? 0) < cfg.minConflictGap) {
        report.conflictsUnresolved += 1;
        continue;
      }
      let resolved = false;
      for (const loser of group) {
        if (loser.id === winner.id) continue;
        if (loser.validUntil !== null) continue;
        try {
          store.markFactInvalidated(loser.id, {
            invalidAt: now,
            actor: cfg.actor,
            reason: `Mau thuan voi fact ${winner.id} (cung ${loser.subjectId}/${loser.predicate}, confidence ${winner.confidence} > ${loser.confidence}); giu ban thang.`,
          });
          report.factsInvalidated += 1;
          resolved = true;
        } catch {
          continue;
        }
      }
      if (resolved) report.conflictsResolved += 1;
    }
  }

  // Phase 3 — decay.
  if (!report.budgetExhausted) {
    const remaining = store.listFacts({ ...scope, status: 'active', limit: cfg.maxFactsPerRun });
    for (const fact of remaining) {
      if (outOfTime()) {
        report.budgetExhausted = true;
        report.stoppedBecause = 'het budget thoi gian (maxMsPerRun) khi decay';
        break;
      }
      if (!isStaleFactV18(fact, nowMs, cfg.staleAfterDays)) continue;
      const updatedMs = Date.parse(fact.updatedAt);
      if (Number.isNaN(updatedMs)) continue;
      const ageDays = (nowMs - updatedMs) / (24 * 60 * 60 * 1000);
      const next = decayConfidenceV19(fact.confidence, ageDays, cfg.decayHalfLifeDays);
      if (fact.confidence - next < cfg.minDecayApply) continue;
      try {
        store.setFactConfidence(fact.id, next);
        report.factsDecayed += 1;
        if (next < cfg.minConfidence) report.factsBelowMin += 1;
      } catch {
        continue;
      }
    }
  }

  report.durationMs = Date.now() - startMs;
  if (opts.workspaceDir) appendConsolidationRunLogV19(opts.workspaceDir, report);
  return report;
}

/** Tom tat bao cao consolidation v19 thanh text (tieng Viet) cho log/UI. */
export function formatV19ConsolidationReport(report: V19AsyncConsolidationReport): string {
  const lines = [
    `Consolidation v19 (${report.jobId}): quet ${report.factsScanned} fact trong ${report.durationMs}ms.`,
    `  Trung lap: ${report.duplicateGroups} nhom, gop ${report.factsMerged} fact.`,
    `  Mau thuan: giai quyet ${report.conflictsResolved} nhom (${report.factsInvalidated} fact bi invalidate), giu ca hai ${report.conflictsUnresolved} nhom.`,
    `  Decay: ha ${report.factsDecayed} fact, ${report.factsBelowMin} fact duoi nguong tin cay (chi dem, khong xoa).`,
    `  Ket thuc: ${report.stoppedBecause}${report.budgetExhausted ? ' (het budget)' : ''}.`,
  ];
  return lines.join('\n');
}
