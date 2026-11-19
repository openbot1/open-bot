/**
 * Memory v28 — panel view cho UI (v1.44, Doi T1).
 *
 * Giong panel.ts cua v27: gom so lieu + trang thai de UI hien
 * ma khong can biet cau truc ben trong cua store. Khong goi
 * model, khong goi mang.
 *
 * Canh bao (warnings) duoc tong hop tu:
 *  - git khong co san -> chay fallback JSONL (mat rollback bang git).
 *  - sleep consolidation dang tat (neu user chua bat bao gio).
 *  - co fact bi vo hieu nhieu (can xem lai — co the do xung dot lien tuc).
 *  - block shared khong co bot nao attach ngoai owner.
 */
import { V28GitBlockStore } from './gitStore';
import { V28FactStore } from './invalidation';
import { V28SharedBlockRegistry } from './sharedBlocks';
import { V28SleepConsolidator } from './sleepConsolidation';
import { V28TimeTravel } from './timeTravel';
import {
  V28_LIMITS,
  type V28PanelView,
  type V28Stats,
} from './types';

/** Phu thuoc de build panel view. */
export interface V28PanelDeps {
  gitStore: V28GitBlockStore;
  factStore: V28FactStore;
  registry: V28SharedBlockRegistry;
  sleep: V28SleepConsolidator;
  timeTravel: V28TimeTravel;
}

/** Nguong canh bao: ti le fact bi vo hieu tren tong fact. */
const INVALIDATED_RATIO_WARNING = 0.3;

/** Build panel view tu cac store v28. */
export function buildV28PanelView(deps: V28PanelDeps): V28PanelView {
  const { gitStore, factStore, registry, sleep } = deps;
  const status = gitStore.status();
  const blocks = gitStore.listBlocks();
  const warnings: string[] = [];

  if (!status.gitAvailable) {
    warnings.push(
      'git khong co san tren may — lich su block chay bang history.jsonl (van du history/diff/rollback, nhung khong co commit git that).',
    );
  }
  if (!sleep.config.enabled) {
    warnings.push('sleep consolidation dang tat — bat len de memory tu gom/khu trung khi ranh.');
  }
  if (factStore.size > 0 && factStore.invalidatedCount / factStore.size >= INVALIDATED_RATIO_WARNING) {
    warnings.push(
      `${factStore.invalidatedCount}/${factStore.size} fact da bi vo hieu (>= ${Math.round(INVALIDATED_RATIO_WARNING * 100)}%) — co the memory dang xung dot lien tuc, nen xem lai fact timeline.`,
    );
  }

  const panelBlocks = blocks.map((meta) => {
    const shared = registry.isShared(meta.label);
    return {
      label: meta.label,
      kind: meta.kind,
      version: meta.version,
      commit: meta.commit,
      updatedAt: meta.updatedAt,
      shared,
      attachedBots: shared ? registry.attachedBots(meta.label) : [],
    };
  });
  for (const entry of panelBlocks) {
    if (entry.shared && entry.attachedBots.length <= 1) {
      warnings.push(`shared block "${entry.label}" chi co owner attach — chua co bot nao khac dung chung.`);
    }
  }

  return {
    title: 'Memory v28 — git-backed shared memory',
    gitAvailable: status.gitAvailable,
    fallbackMode: !status.gitAvailable,
    blocks: panelBlocks,
    factsActive: factStore.activeCount,
    factsInvalidated: factStore.invalidatedCount + factStore.supersededCount,
    lastSleepRun: sleep.lastRun ? { ...sleep.lastRun } : null,
    sleepEnabled: sleep.config.enabled,
    warnings,
  };
}

/** Build thong ke tong hop cua memory v28. */
export function buildV28Stats(deps: V28PanelDeps): V28Stats {
  const { gitStore, factStore, registry, sleep } = deps;
  const status = gitStore.status();
  let versionsTotal = 0;
  for (const meta of gitStore.listBlocks()) {
    versionsTotal += gitStore.history(meta.label, V28_LIMITS.maxHistoryLimit).length;
  }
  return {
    blocksTotal: gitStore.listBlocks().length,
    sharedBlocksTotal: gitStore.listBlocks().filter((m) => registry.isShared(m.label)).length,
    versionsTotal,
    commitsTotal: status.commits,
    factsTotal: factStore.size,
    factsActive: factStore.activeCount,
    factsInvalidated: factStore.invalidatedCount,
    factsSuperseded: factStore.supersededCount,
    gitAvailable: status.gitAvailable,
    fallbackMode: !status.gitAvailable,
    sleepRunsTotal: sleep.runsTotal,
    lastSleepRunAt: sleep.lastRun?.finishedAt ?? null,
    aclEntriesTotal: registry.aclTotal(),
    auditEntriesTotal: registry.auditTotal(),
  };
}

/** Tom tat 1 dong ve trang thai v28 (dung cho log/status bar). */
export function summarizeV28Status(deps: V28PanelDeps): string {
  const stats = buildV28Stats(deps);
  const gitPart = stats.gitAvailable
    ? `git OK (${stats.commitsTotal} commit)`
    : 'git khong co — chay fallback JSONL';
  return (
    `memory v28: ${stats.blocksTotal} block (${stats.sharedBlocksTotal} shared), ` +
    `${stats.factsActive} fact active / ${stats.factsInvalidated + stats.factsSuperseded} da vo hieu, ` +
    `${stats.sleepRunsTotal} sleep run — ${gitPart}`
  );
}
