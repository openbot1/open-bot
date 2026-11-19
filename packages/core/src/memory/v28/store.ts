/**
 * Memory v28 — store facade (v1.44, Doi T1).
 *
 * Diem vao duy nhat cho pipeline + tools: gom git-backed block
 * store + shared block registry (ACL) + fact store bi-temporal
 * + sleep consolidation (client-side subagent) + time-travel.
 *
 * Luu tru:
 *  - Block: file Markdown trong repo git rieng
 *    `<rootDir>/memory-v28/blocks/` (moi lan ghi = 1 commit).
 *  - Fact: `facts.jsonl` append-only (khong bao gio sua/xoa dong cu).
 *  - ACL: `acl.json`; audit: `audit.jsonl`; sleep state:
 *    `memory-v28-sleep.json` (luu trong thu muc workspace, ngoai repo).
 *  - Snapshot JSON: `memory-v28-store.json` — chi luu fact +
 *    ACL + audit + sleep config (block nam trong git).
 *
 * Khong co ham xoa vat ly nao: block chi archive, fact chi
 * invalidate/supersede. Chay 100% local.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { V28GitBlockStore } from './gitStore';
import { V28FactStore } from './invalidation';
import { V28SharedBlockRegistry } from './sharedBlocks';
import { V28SleepConsolidator } from './sleepConsolidation';
import { V28TimeTravel } from './timeTravel';
import {
  errV28,
  okV28,
  V28_SLEEP_STATE_FILENAME,
  V28_STORE_FILENAME,
  V28_VERSION,
  type V28SleepConfig,
  type V28SleepRunReport,
  type V28StoreConfig,
  type V28StoreSnapshot,
} from './types';
import { buildV28PanelView, buildV28Stats } from './panel';

/** Ten file luu store trong workspace dir (ke thua pattern v27). */
export const V28_STORE_FILE = V28_STORE_FILENAME;

/** Phien ban dinh dang snapshot v28. */
export const V28_SNAPSHOT_VERSION = '28.0.0';

/** Store memory v28 — diem vao duy nhat cho pipeline + tools. */
export class V28Store {
  readonly gitStore: V28GitBlockStore;
  readonly facts: V28FactStore;
  readonly shared: V28SharedBlockRegistry;
  readonly sleep: V28SleepConsolidator;
  readonly timeTravel: V28TimeTravel;
  readonly rootDir: string;
  readonly botId: string;
  private storePath: string;
  private sleepStatePath: string;

  constructor(opts: V28StoreConfig = {}) {
    this.rootDir = opts.rootDir ?? process.cwd();
    this.botId = opts.botId ?? '';
    this.gitStore = new V28GitBlockStore({
      rootDir: this.rootDir,
      gitAuthorName: opts.gitAuthorName,
      gitAuthorEmail: opts.gitAuthorEmail,
    });
    this.gitStore.init();
    this.facts = new V28FactStore({ gitStore: this.gitStore });
    this.shared = new V28SharedBlockRegistry({ gitStore: this.gitStore });
    this.sleep = new V28SleepConsolidator(
      { factStore: this.facts, gitStore: this.gitStore, registry: this.shared },
      opts.sleep,
    );
    this.timeTravel = new V28TimeTravel({ gitStore: this.gitStore, factStore: this.facts });
    this.storePath = join(this.rootDir, V28_STORE_FILENAME);
    this.sleepStatePath = join(this.rootDir, V28_SLEEP_STATE_FILENAME);
    this.loadSleepState();
  }

  /** Doc lai trang thai sleep tu disk (neu co). */
  loadSleepState(): void {
    if (!existsSync(this.sleepStatePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.sleepStatePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const state = parsed as { config?: Partial<V28SleepConfig>; lastRun?: V28SleepRunReport; runsTotal?: number };
        if (state.config) this.sleep.updateConfig(state.config);
        if (state.lastRun) this.sleep.lastRun = state.lastRun;
        if (typeof state.runsTotal === 'number') this.sleep.runsTotal = state.runsTotal;
      }
    } catch {
      // File loi thi bo qua — chay voi config mac dinh.
    }
  }

  /** Ghi trang thai sleep xuong disk (atomic qua file tam + rename). */
  saveSleepState(): void {
    mkdirSync(this.rootDir, { recursive: true });
    const payload = {
      version: V28_VERSION,
      savedAt: new Date().toISOString(),
      config: this.sleep.config,
      lastRun: this.sleep.lastRun,
      runsTotal: this.sleep.runsTotal,
    };
    const tmp = `${this.sleepStatePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.sleepStatePath);
  }

  /** So block hien co. */
  get blocksTotal(): number {
    return this.gitStore.listBlocks().length;
  }

  /** So fact dang giu (ke ca da vo hieu). */
  get factsTotal(): number {
    return this.facts.size;
  }

  /** Panel view cho UI. */
  panelView(): ReturnType<typeof buildV28PanelView> {
    return buildV28PanelView({
      gitStore: this.gitStore,
      factStore: this.facts,
      registry: this.shared,
      sleep: this.sleep,
      timeTravel: this.timeTravel,
    });
  }

  /** Thong ke tong hop. */
  stats(): ReturnType<typeof buildV28Stats> {
    return buildV28Stats({
      gitStore: this.gitStore,
      factStore: this.facts,
      registry: this.shared,
      sleep: this.sleep,
      timeTravel: this.timeTravel,
    });
  }

  /** Xuat snapshot JSON (fact + ACL + audit + sleep config). */
  exportSnapshot(): V28StoreSnapshot {
    return {
      version: V28_SNAPSHOT_VERSION,
      exportedAt: new Date().toISOString(),
      facts: this.facts.exportFacts(),
      acl: this.shared.loadAcl(),
      audit: this.shared.loadAudit(10_000),
      sleepConfig: { ...this.sleep.config },
      lastSleepRun: this.sleep.lastRun ? { ...this.sleep.lastRun } : null,
      sleepRunsTotal: this.sleep.runsTotal,
    };
  }

  /** Ghi snapshot xuong disk (atomic). */
  saveSnapshot(): { path: string; facts: number } {
    mkdirSync(this.rootDir, { recursive: true });
    const snapshot = this.exportSnapshot();
    const tmp = `${this.storePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.storePath);
    this.saveSleepState();
    return { path: this.storePath, facts: snapshot.facts.length };
  }

  /**
   * Nhap snapshot: fact chi them khi chua co id; ACL ghi de
   * bang snapshot (khi snapshot co ACL); audit append them
   * (khong xoa audit cu); sleep config ghi de. Tra so luong.
   */
  importSnapshot(snapshot: V28StoreSnapshot): {
    factsImported: number;
    factsSkipped: number;
    aclReplaced: boolean;
  } {
    const { imported, skipped } = this.facts.importFacts(snapshot.facts ?? []);
    let aclReplaced = false;
    if (Array.isArray(snapshot.acl)) {
      this.shared.saveAcl(snapshot.acl);
      aclReplaced = true;
    }
    if (snapshot.sleepConfig) this.sleep.updateConfig(snapshot.sleepConfig);
    if (snapshot.lastSleepRun) this.sleep.lastRun = snapshot.lastSleepRun;
    if (typeof snapshot.sleepRunsTotal === 'number') {
      this.sleep.runsTotal = Math.max(this.sleep.runsTotal, snapshot.sleepRunsTotal);
    }
    this.saveSleepState();
    return { factsImported: imported, factsSkipped: skipped, aclReplaced };
  }

  /** Doc snapshot tu disk (null khi chua co file). */
  loadSnapshotFromDisk(): V28StoreSnapshot | null {
    if (!existsSync(this.storePath)) return null;
    try {
      return JSON.parse(readFileSync(this.storePath, 'utf8')) as V28StoreSnapshot;
    } catch {
      return null;
    }
  }

  /** Khoi phuc tu snapshot tren disk (neu co) — tra ket qua. */
  restoreFromDisk(): { ok: true; value: string } | { ok: false; error: string } {
    const snapshot = this.loadSnapshotFromDisk();
    if (!snapshot) return errV28('chua co snapshot v28 tren disk');
    const result = this.importSnapshot(snapshot);
    return okV28(`da khoi phuc v28: ${result.factsImported} fact moi, ${result.factsSkipped} bo qua`);
  }
}
