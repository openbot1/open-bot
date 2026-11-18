/**
 * Memory v16 — Sleep-time consolidation agent v2 (v1.17, Doi T1).
 *
 * Y tuong hoc tu Letta/MemGPT (sleep-time agents: agent nen ra soat
 * hoi thoai gan day, consolidate va cap nhat memory NGOAI vong lap
 * chinh — trigger sau N buoc hoac khi context bi compact) — tu thiet
 * ke lai hoan toan cho open-bot, chay 100% local, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `SleepConsolidationAgent` cua memory/graph/sleepAgent.ts (v0.98):
 *    agent nen goc (vong lap tool gioi han, run log, fail-open,
 *    trigger turns/compact/manual); v16 KHONG thay the no ma la lop
 *    dieu phoi moi tren pipeline v15/v16 — chay SAU agent goc hoac
 *    doc lap, tuy host chon.
 *  - `extractFactsV15Sync` cua memoryV15: trich fact rule-based 1
 *    pass moi episode (khong goi model mac dinh); v16 goi lai.
 *  - `runSleepReorganizeV15` cua memoryV15/blocks.ts: sap xep lai
 *    block luc idle; v16 goi sau promotion de block khong phi.
 *
 * Luong chay cua v16 (moi lan run):
 *  1. Lay episode chua xu ly (`listUnprocessedEpisodes`, toi da
 *     `maxEpisodesPerRun`, chia batch).
 *  2. Moi episode: trich fact bang v15; gan episode context
 *     (episodeId/turnId/runId/botId/userId/at) vao ung vien.
 *  3. Gate tung ung vien bang `corePromotionGateV16` theo nguon cua
 *     episode (user-chat / agent-self / ...): nguon deny -> bo;
 *     judge quarantine -> dua vao quarantine cua store; judge
 *     reject -> bo.
 *  4. Ung vien vuot gate: consolidation 4 thao tac
 *     (`applyConsolidationV16`) vao TemporalGraphStore.
 *  5. Fact moi/thay the du dieu kien: promote vao core block
 *     (`promoteFactsToCoreV16`); fact het han: sweep mem
 *     (`sweepExpiredFactsV16`); quarantine cu: het han TTL thi
 *     tu dong reject (`expireStaleQuarantineV16`); entity trung lap
 *     diem rat cao (>= 0.95) duoc gop tu dong (neu bat).
 *  6. Danh dau episode da xu ly (kem factIds); ghi run log JSONL +
 *     state file (de resume idempotent: chay lai khong xu ly lai
 *     episode da xong).
 *
 * Trigger: `noteTurn()` dem turn (chay khi du `afterTurns` va qua
 * `cooldownMs`); `runOnCompact()` chay ngay khi context compact;
 * `runManual()` chay tay. Het budget (so episode / thoi gian) thi
 * dung, de phan con lai cho lan sau — khong bao gio chan turn user.
 * Loi o episode nao chi ghi log, khong throw ra caller (fail-open).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GraphFact, MemoryScope } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { extractFactsV15Sync } from '../../memoryV15/consolidation';
import { V16EntityLinker, scanDuplicateEntitiesV16, mergeEntitiesV16 } from './entityLinking';
import { applyConsolidationV16 } from './consolidationOps';
import type { V16CandidateFact, V16ConsolidationReport } from './consolidationOps';
import { sweepExpiredFactsV16 } from './validityWindow';
import {
  V16SourceAllowlist,
  corePromotionGateV16,
  quarantineCandidateV16,
  expireStaleQuarantineV16,
} from './poisoningGuard';
import { promoteFactsToCoreV16 } from './corePromotion';
import type { V16BlockAdapter, V16PromotionReport } from './corePromotion';

/** Loi sleep consolidation v16 — message tieng Viet. */
export class V16SleepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V16SleepError';
  }
}

/** Trigger chay sleep consolidation v16. */
export type V16SleepTrigger = 'turns' | 'compact' | 'manual' | 'idle' | 'scheduled';

/** Cau hinh sleep consolidation v16. */
export interface V16SleepConfig {
  /** Bat/tat agent nen (mac dinh TAT — user bat trong Settings). */
  enabled: boolean;
  /** So turn ke tu lan chay truoc thi chay lai (mac dinh 10). */
  afterTurns: number;
  /** Thoi gian cho toi thieu giua hai lan chay (ms, mac dinh 5 phut). */
  cooldownMs: number;
  /** So episode toi da moi lan chay (mac dinh 50). */
  maxEpisodesPerRun: number;
  /** So episode moi batch (mac dinh 10). */
  batchSize: number;
  /** Ngan sach thoi gian moi lan chay (ms, mac dinh 30 giay). */
  timeBudgetMs: number;
  /** Confidence toi thieu de ghi fact (mac dinh 0.3). */
  minConfidence: number;
  /** Tu dong gop entity trung lap diem >= nguong nay (mac dinh 0.95; 0 = tat). */
  autoMergeEntityThreshold: number;
  /** Co sweep fact het han moi lan chay khong (mac dinh true). */
  sweepExpired: boolean;
  /** Co het han quarantine cu moi lan chay khong (mac dinh true). */
  expireStaleQuarantine: boolean;
}

export const V16_DEFAULT_SLEEP_CONFIG: V16SleepConfig = {
  enabled: false,
  afterTurns: 10,
  cooldownMs: 5 * 60 * 1000,
  maxEpisodesPerRun: 50,
  batchSize: 10,
  timeBudgetMs: 30 * 1000,
  minConfidence: 0.3,
  autoMergeEntityThreshold: 0.95,
  sweepExpired: true,
  expireStaleQuarantine: true,
};

/** Trang thai luu file cua sleep agent (de resume idempotent). */
export interface V16SleepState {
  version: 1;
  /** So turn ke tu lan chay truoc. */
  turnsSinceLastRun: number;
  /** ISO lan chay thanh cong cuoi. */
  lastRunAt: string | null;
  /** So lan chay thanh cong. */
  totalRuns: number;
  /** So episode da xu ly tich luy. */
  totalEpisodesProcessed: number;
  updatedAt: string;
}

/** Mot lan chay sleep consolidation (run log). */
export interface V16SleepRunReport {
  runId: string;
  trigger: V16SleepTrigger;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** So episode da xet trong lan chay. */
  episodesSeen: number;
  /** So episode xu ly xong (da danh dau processed). */
  episodesProcessed: number;
  /** So episode loi (bo qua, ghi log). */
  episodesFailed: number;
  /** So ung vien trich duoc. */
  candidatesExtracted: number;
  /** So ung vien bi gate chan (quarantine/reject/deny). */
  candidatesGated: number;
  /** So muc quarantine moi tao. */
  quarantined: number;
  consolidation: V16ConsolidationReport;
  /** So fact da promote vao core block. */
  promoted: number;
  /** So fact day xuong archival. */
  archived: number;
  /** So fact het han da dong mem. */
  expiredSwept: number;
  /** So muc quarantine cu het han da tu reject. */
  staleQuarantineExpired: number;
  /** So cum entity da gop tu dong. */
  entitiesMerged: number;
  /** true = het budget giua chung (con episode chua xu ly). */
  budgetExhausted: boolean;
  /** Loi tong (neu run loi o buoc ngoai episode). */
  error: string | null;
}

/** Tuy chon chay sleep consolidation. */
export interface V16SleepRunOptions {
  trigger: V16SleepTrigger;
  /** Nguon mac dinh cho episode (mac dinh: theo role). */
  sourceName?: string;
  /** Ghi de config lan chay nay. */
  config?: Partial<V16SleepConfig>;
  /** Block adapter de promote (khong co thi bo qua promotion). */
  blocks?: V16BlockAdapter | null;
  /** Allowlist nguon (mac dinh: registry rong). */
  allowlist?: V16SourceAllowlist;
  /** Thoi diem chay (mac dinh: bay gio). */
  now?: Date;
}

/** Duong dan file state + run log sleep v16 (tuong doi workspace). */
export const V16_SLEEP_STATE_REL_PATH = path.join('.open-bot', 'memory-v16-sleep-state.json');
export const V16_SLEEP_RUNS_REL_PATH = path.join('.open-bot', 'memory-v16-sleep-runs.jsonl');
/** So dong run log toi da giu khi doc. */
export const V16_MAX_RUN_LOG_LINES = 200;

function nowIsoV16(date = new Date()): string {
  return date.toISOString();
}

function randomRunIdV16(): string {
  return `v16sleep-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
}

/** State mac dinh (chua chay lan nao). */
export function defaultV16SleepState(now = new Date()): V16SleepState {
  return {
    version: 1,
    turnsSinceLastRun: 0,
    lastRunAt: null,
    totalRuns: 0,
    totalEpisodesProcessed: 0,
    updatedAt: nowIsoV16(now),
  };
}

/** Doc state sleep v16 tu workspace (khong co file -> state mac dinh). */
export function loadV16SleepState(workspaceDir: string): V16SleepState {
  try {
    const filePath = path.join(workspaceDir, V16_SLEEP_STATE_REL_PATH);
    if (!fs.existsSync(filePath)) return defaultV16SleepState();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<V16SleepState>;
    if (parsed.version !== 1) return defaultV16SleepState();
    return {
      version: 1,
      turnsSinceLastRun: Math.max(0, parsed.turnsSinceLastRun ?? 0),
      lastRunAt: parsed.lastRunAt ?? null,
      totalRuns: Math.max(0, parsed.totalRuns ?? 0),
      totalEpisodesProcessed: Math.max(0, parsed.totalEpisodesProcessed ?? 0),
      updatedAt: parsed.updatedAt ?? nowIsoV16(),
    };
  } catch {
    return defaultV16SleepState();
  }
}

/** Ghi state sleep v16 xuong workspace (best-effort). */
export function saveV16SleepState(workspaceDir: string, state: V16SleepState): void {
  try {
    const filePath = path.join(workspaceDir, V16_SLEEP_STATE_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ ...state, updatedAt: nowIsoV16() }, null, 2)}\n`, 'utf8');
  } catch {
    // State best-effort: mat state chi mat dem turn, khong mat fact.
  }
}

/** Ghi mot run log (append-only JSONL, best-effort). */
export function appendV16SleepRunLog(workspaceDir: string, report: V16SleepRunReport): void {
  try {
    const filePath = path.join(workspaceDir, V16_SLEEP_RUNS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(report)}\n`, 'utf8');
  } catch {
    // Run log best-effort.
  }
}

/** Doc run log sleep v16 (moi nhat cuoi, gioi han so dong). */
export function readV16SleepRunLogs(workspaceDir: string, limit = 20): V16SleepRunReport[] {
  try {
    const filePath = path.join(workspaceDir, V16_SLEEP_RUNS_REL_PATH);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const parsed: V16SleepRunReport[] = [];
    for (const line of lines.slice(-Math.max(0, limit))) {
      try {
        parsed.push(JSON.parse(line) as V16SleepRunReport);
      } catch {
        // Bo dong hong.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

/** Nguon cua mot episode theo role (user -> user-chat, khac -> agent-self). */
export function sourceNameForEpisodeV16(role: string, override?: string): string {
  if (override) return override;
  return role === 'user' ? 'user-chat' : 'agent-self';
}

/**
 * Sleep-time consolidation agent v2 — dieu phoi pipeline v15/v16.
 * Host giu mot instance moi bot (state luu file theo workspace).
 * Tat ca phuong thuc run deu fail-open: loi tong duoc ghi vao
 * `report.error`, khong throw ra caller (tru khi config tat).
 */
export class V16SleepConsolidationAgent {
  private readonly store: TemporalGraphStore;
  private readonly workspaceDir: string;
  private readonly scope: MemoryScope;
  private config: V16SleepConfig;
  private state: V16SleepState;
  private readonly linker: V16EntityLinker;

  constructor(
    store: TemporalGraphStore,
    workspaceDir: string,
    scope: MemoryScope,
    config: Partial<V16SleepConfig> = {},
  ) {
    this.store = store;
    this.workspaceDir = workspaceDir;
    this.scope = { ...scope };
    this.config = { ...V16_DEFAULT_SLEEP_CONFIG, ...config };
    this.state = loadV16SleepState(workspaceDir);
    this.linker = new V16EntityLinker(store);
  }

  /** Config hien tai (ban sao). */
  getConfig(): V16SleepConfig {
    return { ...this.config };
  }

  /** Cap nhat config (khong ghi file — config do host quan ly). */
  updateConfig(patch: Partial<V16SleepConfig>): V16SleepConfig {
    this.config = { ...this.config, ...patch };
    return this.getConfig();
  }

  /** State hien tai (ban sao). */
  getState(): V16SleepState {
    return { ...this.state };
  }

  /** Ghi de state (de test / khoi phuc). */
  setState(state: V16SleepState): void {
    this.state = { ...state };
    saveV16SleepState(this.workspaceDir, this.state);
  }

  /** Coordinator goi sau moi turn: dem turn, chay khi du dieu kien. */
  noteTurn(opts: { blocks?: V16BlockAdapter | null; allowlist?: V16SourceAllowlist } = {}): V16SleepRunReport | null {
    this.state.turnsSinceLastRun += 1;
    saveV16SleepState(this.workspaceDir, this.state);
    if (!this.config.enabled) return null;
    if (this.state.turnsSinceLastRun < this.config.afterTurns) return null;
    const lastRunMs = this.state.lastRunAt ? Date.parse(this.state.lastRunAt) : 0;
    if (!Number.isNaN(lastRunMs) && Date.now() - lastRunMs < this.config.cooldownMs) return null;
    return this.run({ trigger: 'turns', ...opts });
  }

  /** Chay ngay khi context bi compact (episode sap mat khoi context). */
  runOnCompact(opts: { blocks?: V16BlockAdapter | null; allowlist?: V16SourceAllowlist } = {}): V16SleepRunReport | null {
    if (!this.config.enabled) return null;
    return this.run({ trigger: 'compact', ...opts });
  }

  /** Chay tay (tu Settings / lenh user). */
  runManual(opts: { blocks?: V16BlockAdapter | null; allowlist?: V16SourceAllowlist } = {}): V16SleepRunReport {
    return this.run({ trigger: 'manual', ...opts });
  }

  /** Chay mot lan sleep consolidation (fail-open). */
  run(opts: V16SleepRunOptions): V16SleepRunReport {
    const started = opts.now ?? new Date();
    const startedAt = started.toISOString();
    const config: V16SleepConfig = { ...this.config, ...(opts.config ?? {}) };
    const allowlist = opts.allowlist ?? new V16SourceAllowlist();
    const report: V16SleepRunReport = {
      runId: randomRunIdV16(),
      trigger: opts.trigger,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      episodesSeen: 0,
      episodesProcessed: 0,
      episodesFailed: 0,
      candidatesExtracted: 0,
      candidatesGated: 0,
      quarantined: 0,
      consolidation: {
        total: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        dropped: 0,
        addedFactIds: [],
        supersededFactIds: [],
        deletedFactIds: [],
        dropReasons: {},
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
      },
      promoted: 0,
      archived: 0,
      expiredSwept: 0,
      staleQuarantineExpired: 0,
      entitiesMerged: 0,
      budgetExhausted: false,
      error: null,
    };
    const deadline = Date.now() + config.timeBudgetMs;

    try {
      const episodes = this.store.listUnprocessedEpisodes(this.scope, config.maxEpisodesPerRun);
      report.episodesSeen = episodes.length;
      const allCandidates: V16CandidateFact[] = [];
      const episodeFactIds = new Map<string, string[]>();

      for (let i = 0; i < episodes.length; i += config.batchSize) {
        if (Date.now() > deadline) {
          report.budgetExhausted = true;
          break;
        }
        const batch = episodes.slice(i, i + config.batchSize);
        for (const episode of batch) {
          if (Date.now() > deadline) {
            report.budgetExhausted = true;
            break;
          }
          try {
            const sourceName = sourceNameForEpisodeV16(episode.role, opts.sourceName);
            const trust = allowlist.trustOf(sourceName);
            const extracted = extractFactsV15Sync(episode.text ?? '', trust);
            report.candidatesExtracted += extracted.length;
            const gated: V16CandidateFact[] = [];
            for (const candidate of extracted) {
              const withContext: V16CandidateFact = {
                ...candidate,
                episodeId: episode.id,
                turnId: episode.turnId,
                runId: episode.runId,
                botId: episode.botId,
                userId: episode.userId,
                at: episode.createdAt,
                sourceName,
                sourceTrust: trust,
              };
              const gate = corePromotionGateV16(this.store, withContext, this.scope, sourceName, {
                allowlist,
              });
              if (gate.decision === 'reject') {
                report.candidatesGated += 1;
                continue;
              }
              // Chi quarantine khi JUDGE v14 noi quarantine (mau nghi
              // ngo / mau thuan fact tin cay). Gate tra 'quarantine'
              // vi ly do core-only (confidence chua du vao core,
              // fact tam thoi) thi ung vien VAN duoc consolidate vao
              // graph (chi khong len core block) — khong dua vao
              // quarantine.
              if (gate.judgeVerdict?.decision === 'quarantine') {
                quarantineCandidateV16(this.store, withContext, this.scope, gate.judgeVerdict);
                report.quarantined += 1;
                report.candidatesGated += 1;
                continue;
              }
              gated.push(withContext);
            }
            const applied = applyConsolidationV16(this.store, gated, this.scope, {
              minConfidence: config.minConfidence,
              actor: 'system:v16-sleep',
              linker: this.linker,
            });
            report.consolidation.total += applied.total;
            report.consolidation.added += applied.added;
            report.consolidation.updated += applied.updated;
            report.consolidation.deleted += applied.deleted;
            report.consolidation.dropped += applied.dropped;
            report.consolidation.addedFactIds.push(...applied.addedFactIds);
            report.consolidation.supersededFactIds.push(...applied.supersededFactIds);
            report.consolidation.deletedFactIds.push(...applied.deletedFactIds);
            for (const [reason, count] of Object.entries(applied.dropReasons)) {
              report.consolidation.dropReasons[reason] =
                (report.consolidation.dropReasons[reason] ?? 0) + count;
            }
            allCandidates.push(...gated);
            episodeFactIds.set(episode.id, applied.addedFactIds);
            this.store.markEpisodeProcessed(episode.id, applied.addedFactIds);
            report.episodesProcessed += 1;
          } catch {
            report.episodesFailed += 1;
          }
        }
      }

      // Promote fact moi vao core block (neu host cap adapter).
      if (opts.blocks && report.consolidation.addedFactIds.length > 0) {
        const facts: GraphFact[] = [];
        for (const id of report.consolidation.addedFactIds) {
          const fact = this.store.getFact(id);
          if (fact) facts.push(fact);
        }
        if (facts.length > 0) {
          const promotion: V16PromotionReport = promoteFactsToCoreV16(
            this.store,
            facts,
            this.scope,
            opts.blocks,
            'user-chat',
            { allowlist },
          );
          report.promoted = promotion.promoted.length;
          report.archived = promotion.archived;
        }
      }

      // Sweep fact het han + quarantine cu het han TTL.
      if (config.sweepExpired) {
        const sweep = sweepExpiredFactsV16(this.store, this.scope, {
          now: started,
          workspaceDir: this.workspaceDir,
        });
        report.expiredSwept = sweep.closedFactIds.length;
      }
      if (config.expireStaleQuarantine) {
        const expired = expireStaleQuarantineV16(this.store, this.scope, { now: started });
        report.staleQuarantineExpired = expired.expired;
      }

      // Gop entity trung lap diem rat cao (neu bat).
      if (config.autoMergeEntityThreshold > 0) {
        const clusters = scanDuplicateEntitiesV16(this.store, {
          threshold: config.autoMergeEntityThreshold,
          limit: 20,
        });
        for (const cluster of clusters) {
          try {
            mergeEntitiesV16(this.store, cluster.keep.id, cluster.duplicates.map((d) => d.id), {
              actor: 'system:v16-sleep',
              mergeDuplicateFacts: true,
            });
            report.entitiesMerged += 1;
          } catch {
            // Gop loi thi bo qua cum nay, tiep tuc cum khac.
          }
        }
      }
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
    }

    const finished = new Date();
    report.finishedAt = finished.toISOString();
    report.durationMs = Math.max(0, finished.getTime() - started.getTime());
    report.consolidation.finishedAt = report.finishedAt;
    report.consolidation.durationMs = report.durationMs;

    this.state.turnsSinceLastRun = 0;
    this.state.lastRunAt = report.finishedAt;
    this.state.totalRuns += 1;
    this.state.totalEpisodesProcessed += report.episodesProcessed;
    saveV16SleepState(this.workspaceDir, this.state);
    appendV16SleepRunLog(this.workspaceDir, report);
    return report;
  }
}

/** Tien ich: tao sleep agent v16 (de host khoi tao nhanh). */
export function createV16SleepAgent(
  store: TemporalGraphStore,
  workspaceDir: string,
  scope: MemoryScope,
  config: Partial<V16SleepConfig> = {},
): V16SleepConsolidationAgent {
  return new V16SleepConsolidationAgent(store, workspaceDir, scope, config);
}
