/**
 * Memory v25 — store (v1.40, Doi T1).
 *
 * Gom 3 thanh phan: fact edge bi-temporal, shared block, sleep
 * agent + judge log. Luu/load JSON xuong thu muc workspace
 * (ghi atomic qua file tam + rename). Khong co ham xoa vat ly:
 * fact chi dong hieu luc, block chi revert version, judge log
 * chi them (append-only).
 *
 * Chay 100% local, chi dung node:fs/node:path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { V25FactEdgeStore } from './factEdges';
import { V25SharedBlockStore } from './sharedBlocks';
import { V25SleepAgent } from './sleep';
import {
  errV25,
  isoAtV25,
  makeV25Id,
  okV25,
  type V25Health,
  type V25JudgeDecision,
  type V25JudgeFn,
  type V25JudgeLogEntry,
  type V25Result,
  type V25Stats,
  type V25StoreSnapshot,
} from './types';

/** Ten file luu store trong workspace dir. */
export const V25_STORE_FILENAME = 'memory-v25-store.json';

/** Store memory v25 — diem vao duy nhat cho pipeline + tools. */
export class V25Store {
  readonly facts: V25FactEdgeStore;
  readonly blocks: V25SharedBlockStore;
  readonly sleep: V25SleepAgent;
  private readonly judgeLog: V25JudgeLogEntry[] = [];

  constructor(opts: { judgeFn?: V25JudgeFn } = {}) {
    this.facts = new V25FactEdgeStore();
    this.blocks = new V25SharedBlockStore();
    this.sleep = new V25SleepAgent(this.facts, this.blocks, {
      judgeFn: opts.judgeFn,
      onJudgeLog: (entry) => this.recordJudge(entry),
    });
  }

  // -- judge log (append-only) -------------------------------------------

  /** Ghi 1 muc judge log (goi tu sleep agent / pipeline). */
  recordJudge(entry: V25JudgeLogEntry): void {
    this.judgeLog.push(entry);
  }

  /** Liet ke judge log (moi nhat truoc). */
  listJudgeLog(filter: { decision?: V25JudgeDecision; limit?: number } = {}): V25JudgeLogEntry[] {
    const out = [...this.judgeLog].reverse();
    const filtered = filter.decision ? out.filter((e) => e.decision === filter.decision) : out;
    if (filter.limit !== undefined) return filtered.slice(0, Math.max(0, filter.limit));
    return filtered;
  }

  /** Dem judge log theo quyet dinh. */
  countJudgeByDecision(): Record<V25JudgeDecision, number> {
    const out: Record<V25JudgeDecision, number> = { ADD: 0, UPDATE: 0, DELETE: 0, NOISE: 0 };
    for (const e of this.judgeLog) out[e.decision]++;
    return out;
  }

  // -- stats / health ------------------------------------------------------

  /** Thong ke store. */
  stats(): V25Stats {
    const byStatus = this.facts.countByStatus();
    const blocks = this.blocks.list({});
    return {
      factsTotal: this.facts.size,
      factsActive: byStatus.active,
      factsSuperseded: byStatus.superseded,
      factsExpired: byStatus.expired,
      blocksTotal: blocks.length,
      blocksReadOnly: blocks.filter((b) => b.readOnly).length,
      blocksAttached: blocks.reduce((n, b) => n + b.attachedBotIds.length, 0),
      judgeTotal: this.judgeLog.length,
      judgeByDecision: this.countJudgeByDecision(),
      sleepPasses: this.sleep.getTotalPasses(),
      turnsBuffered: this.sleep.getPendingTurnCount(),
      turnsSinceLastPass: this.sleep.getTurnsSinceLastPass(),
    };
  }

  /** Health check: cua so thoi gian lech, block vuot gioi han, log phi. */
  health(): V25Health[] {
    const out: V25Health[] = [];
    const problems = this.facts.validate();
    if (problems.length > 0) {
      out.push({ severity: 'error', code: 'fact-window', detail: `${problems.length} edge co cua so thoi gian khong hop le: ${problems[0] ?? ''}` });
    } else {
      out.push({ severity: 'info', code: 'fact-window', detail: 'Tat ca edge co cua so valid/transaction hop le.' });
    }
    const overLimit = this.blocks
      .list({})
      .filter((b) => b.maxChars > 0 && b.value.length > b.maxChars);
    if (overLimit.length > 0) {
      out.push({ severity: 'warn', code: 'block-over-limit', detail: `${overLimit.length} block vuot maxChars: ${overLimit.map((b) => b.label).join(', ')}` });
    }
    if (this.sleep.getPendingTurnCount() >= this.sleep.getConfig().triggerSteps * 3) {
      out.push({
        severity: 'warn',
        code: 'sleep-backlog',
        detail: `${this.sleep.getPendingTurnCount()} turn dang cho sleep pass (gap 3 lan trigger) — chay sleep pass.`,
      });
    }
    if (this.judgeLog.length > 10000) {
      out.push({ severity: 'warn', code: 'judge-log-large', detail: `Judge log co ${this.judgeLog.length} muc — can archive.` });
    }
    if (out.length === 1) {
      out.push({ severity: 'info', code: 'ok', detail: 'Store v25 khoe: khong co van de.' });
    }
    return out;
  }

  // -- snapshot / persistence ----------------------------------------------

  /** Snapshot day du de luu / export. */
  toJSON(): V25StoreSnapshot {
    return {
      version: 25,
      exportedAt: isoAtV25(Date.now()),
      facts: this.facts.toJSON(),
      blocks: this.blocks.toJSON(),
      judgeLog: [...this.judgeLog],
      sleep: this.sleep.getState(),
    };
  }

  /** Khoi phuc store tu snapshot (thay the toan bo du lieu hien tai). */
  static fromJSON(data: unknown): V25Result<V25Store> {
    if (!data || typeof data !== 'object') return errV25('Snapshot v25 khong phai object.');
    const snap = data as Partial<V25StoreSnapshot>;
    if (snap.version !== 25) return errV25(`Snapshot version ${String(snap.version)} khong phai v25.`);
    const store = new V25Store();
    if (Array.isArray(snap.facts)) {
      // Nap nguyen edge goc (ke ca da dong) — lich su khong mat.
      store.restoreFacts(V25FactEdgeStore.fromJSON(snap.facts));
    }
    if (Array.isArray(snap.blocks)) {
      store.restoreBlocks(V25SharedBlockStore.fromJSON(snap.blocks));
    }
    if (Array.isArray(snap.judgeLog)) {
      for (const entry of snap.judgeLog as V25JudgeLogEntry[]) {
        if (entry && typeof entry.id === 'string') store.judgeLog.push(entry);
      }
    }
    if (snap.sleep) store.sleep.restore(snap.sleep);
    return okV25(store);
  }

  /** Nap lai fact store tu 1 store con da load (dung noi bo). */
  private restoreFacts(facts: V25FactEdgeStore): void {
    const target = this.facts as unknown as { edges: Map<string, unknown> };
    const source = facts as unknown as { edges: Map<string, unknown> };
    if (target.edges && source.edges) {
      target.edges.clear();
      for (const [k, v] of source.edges) target.edges.set(k, v);
    }
  }

  /** Nap lai block store tu 1 store con da load (dung noi bo). */
  private restoreBlocks(blocks: V25SharedBlockStore): void {
    const target = this.blocks as unknown as { blocks: Map<string, unknown> };
    const source = blocks as unknown as { blocks: Map<string, unknown> };
    if (target.blocks && source.blocks) {
      target.blocks.clear();
      for (const [k, v] of source.blocks) target.blocks.set(k, v);
    }
  }

  /** Luu store xuong thu muc (ghi atomic qua file tam + rename). */
  save(dir: string): V25Result<string> {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, V25_STORE_FILENAME);
      const tmp = `${file}.tmp-${makeV25Id('save').replace(/[^a-z0-9_-]/gi, '')}`;
      writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2), 'utf8');
      renameSync(tmp, file);
      return okV25(file);
    } catch (e) {
      return errV25(`Luu store v25 that bai: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Load store tu thu muc — tra store rong neu chua co file. */
export function loadV25StoreFromDir(dir: string): V25Result<V25Store> {
  const file = join(dir, V25_STORE_FILENAME);
  if (!existsSync(file)) return okV25(new V25Store());
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return V25Store.fromJSON(parsed);
  } catch (e) {
    return errV25(`Doc store v25 that bai (${file}): ${e instanceof Error ? e.message : String(e)}`);
  }
}
