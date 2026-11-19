/**
 * Model picker v116 (v1.39, Doi T3) — gop tat ca nguon model thanh
 * mot danh sach duy nhat cho UI picker.
 *
 * Router V115 chi biet 2 nguon (local catalogue + cloud gia co dinh).
 * V116 them nguon thu 3: CLI agent (model chay qua login san cua
 * user). UI picker can thay ca 3 nguon trong mot list, moi muc ghi
 * ro: model chay o dau (local / cloud / qua CLI nao), chay qua tai
 * khoan nao (nhan tai khoan CLI), gia/latency/chat luong uoc tinh,
 * va co dung duoc cho task hien tai khong (du RAM? ho tro tool-use?
 * du context? du chat luong toi thieu?).
 *
 * Module nay chi gop + loc + sap xep (dung lai scoringV116 de
 * tinh diem) — khong goi model that, khong doc credential.
 */

import { buildCloudCandidates, buildLocalCandidates, DEFAULT_CLOUD_PRICES } from './policy';
import { rankCandidatesV116, type RoutingProfile } from './scoringV116';
import type { CliRoutableModel } from './cliSourcesV116';
import type { PolicyRouterConfig, RouteCandidate, RouterTask } from './types';
import { DEFAULT_POLICY_CONFIG } from './types';

/** Mot muc trong picker (de UI ve 1 dong). */
export interface PickerEntry {
  /** Id model de route (vd qwen3-4b, gemini-2.5-flash, cli:codex:default). */
  modelId: string;
  /** Nhan hien thi (vd "Qwen3 4B (local)" / "Codex — qua tai khoan a@b.c"). */
  label: string;
  /** Nguon: local (catalogue) / cloud / cli. */
  source: 'local' | 'cloud' | 'cli';
  /** Kind CLI khi source = 'cli' (vd 'codex'); undefined neu khong phai CLI. */
  viaCli?: string;
  /** Nhan tai khoan chay model nay (chi CLI source moi co). */
  accountLabel?: string;
  costPer1kTokensUsd: number;
  estLatencyMs: number;
  quality: number;
  /** Diem theo profile hien tai (de sap xep; 0 khi bi loai). */
  score: number;
  /** true = dung duoc cho task (neu co task); false = bi loai. */
  available: boolean;
  /** Ly do khong dung duoc (khi available = false). */
  unavailableReason?: string;
  /** Ly do ngan vi sao muc nay duoc xep o day (de UI hien thi). */
  reasons: string[];
}

/** Tuy chon build picker. */
export interface PickerOptions {
  /** Task can loc theo (khong co thi liet ke tat ca, khong loc). */
  task?: RouterTask;
  /** Profile de tinh diem + loc (mac dinh balanced). */
  profile?: RoutingProfile;
  /** Chi lay nguon CLI dang bat (mac dinh lay het, ke ca chua bat — de UI hien thi "tat"). */
  cliModels?: CliRoutableModel[];
  /** An cac muc khong dung duoc (mac dinh hien het, danh dau ly do). */
  hideUnavailable?: boolean;
  /** Gioi han so muc tra ve (0 = khong gioi han). */
  limit?: number;
}

/** Nhan hien thi cho mot ung vien (khong phai CLI). */
function labelFor(candidate: RouteCandidate): string {
  return candidate.kind === 'local' ? `${candidate.modelId} (local)` : `${candidate.modelId} (cloud)`;
}

/**
 * Build danh sach picker: local catalogue + cloud + CLI models,
 * xep hang theo profile, loc theo task (neu co).
 */
export function buildPickerEntries(
  env: { loadedModelIds: ReadonlySet<string>; availableRamBytes: number },
  options: PickerOptions = {},
  config: PolicyRouterConfig = DEFAULT_POLICY_CONFIG,
): PickerEntry[] {
  const task = options.task;
  const profile = options.profile ?? { id: 'balanced', label: 'Cân bằng', description: '', weights: { cost: 0.4, latency: 0.3, quality: 0.3 } };
  const baseTask: RouterTask = task ?? {
    kind: 'simple-chat',
    promptTokens: 0,
    needsToolUse: false,
    needsLongContext: false,
    qualityNeed: 0,
  };
  const candidates: RouteCandidate[] = [
    ...buildLocalCandidates(baseTask, env.loadedModelIds, env.availableRamBytes, config),
    ...buildCloudCandidates(DEFAULT_CLOUD_PRICES),
    ...(options.cliModels ?? []),
  ];
  const ranked = rankCandidatesV116(candidates, baseTask, profile, config);
  const entries: PickerEntry[] = ranked.map((c) => {
    const isCli = c.modelId.startsWith('cli:');
    const cliModel = isCli
      ? (options.cliModels ?? []).find((m) => m.modelId === c.modelId)
      : undefined;
    const source: PickerEntry['source'] = isCli ? 'cli' : c.kind;
    let label = labelFor(c);
    if (isCli && cliModel) {
      const account = cliModel.accountLabel ? ` — qua tai khoan ${cliModel.accountLabel}` : ' — chua ro tai khoan';
      label = `${cliModel.viaCli}${account}`;
    }
    return {
      modelId: c.modelId,
      label,
      source,
      viaCli: cliModel?.viaCli,
      accountLabel: cliModel?.accountLabel,
      costPer1kTokensUsd: c.costPer1kTokensUsd,
      estLatencyMs: c.estLatencyMs,
      quality: c.quality,
      score: +c.score.toFixed(4),
      available: !c.excluded,
      unavailableReason: c.excluded ? c.reasons[0]?.replace(/^Loai: /, '') : undefined,
      reasons: c.reasons,
    };
  });
  const visible = options.hideUnavailable ? entries.filter((e) => e.available) : entries;
  const limit = options.limit ?? 0;
  return limit > 0 ? visible.slice(0, limit) : visible;
}

/** Chi cac muc dung duoc (de picker mac dinh chi hien muc chon duoc). */
export function availablePickerEntries(
  env: { loadedModelIds: ReadonlySet<string>; availableRamBytes: number },
  options: PickerOptions = {},
  config: PolicyRouterConfig = DEFAULT_POLICY_CONFIG,
): PickerEntry[] {
  return buildPickerEntries(env, { ...options, hideUnavailable: true }, config);
}

/** Tom tat picker: bao nhieu muc moi nguon, bao nhieu dung duoc. */
export function summarizePicker(entries: PickerEntry[]): {
  total: number;
  available: number;
  bySource: Record<string, number>;
  cheapest: string | null;
  fastest: string | null;
  bestQuality: string | null;
} {
  const available = entries.filter((e) => e.available);
  const bySource: Record<string, number> = {};
  for (const e of entries) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  const cheapest = available.length > 0
    ? [...available].sort((a, b) => a.costPer1kTokensUsd - b.costPer1kTokensUsd)[0].modelId
    : null;
  const fastest = available.length > 0
    ? [...available].sort((a, b) => a.estLatencyMs - b.estLatencyMs)[0].modelId
    : null;
  const bestQuality = available.length > 0
    ? [...available].sort((a, b) => b.quality - a.quality)[0].modelId
    : null;
  return { total: entries.length, available: available.length, bySource, cheapest, fastest, bestQuality };
}
