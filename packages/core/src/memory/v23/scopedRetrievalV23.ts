/**
 * Memory v23 — multi-scope retrieval (v1.38, Doi T1).
 *
 * Retrieval da scope theo hierarchy run < agent < user < app
 * (y tuong Mem0 user_id/agent_id/run_id, dung scope helper co san
 * cua graph/scopes — khong viet lai hierarchy):
 *  - Query o scope nao chi thay record thuoc scope do HOAC scope
 *    cha cua no (run thay duoc record cua agent/user/app; user
 *    khong bao gio thay record cua run/agent khac).
 *  - Diem cuoi = diem fusion x trong so muc scope (run 1.0 >
 *    agent 0.8 > user 0.6 > app 0.4) — record hep (rieng cho run
 *    nay) duoc uu tien hon record rong (app-wide).
 *  - Dedupe theo text chuan hoa: cung mot fact nam o nhieu scope
 *    chi tra mot lan (lay diem cao nhat, ghi ro cac scope da gop).
 *  - Query rong = "recent": tra record moi nhat theo scope.
 *
 * Khong goi model; fusion ben duoi dung embedder local khi co.
 */

import { expandScopeChain, scopeIncludes, scopeLevelWeight } from '../graph/scopes';
import type { MemoryScope } from '../graph/types';
import type { V23LocalEmbedder } from './localEmbedder';
import { fuseV23 } from './fusion';
import type { V23FusionOptions } from './fusion';
import type { V23MemoryStore } from './store';
import { jaccardV23, normalizeV23Text, scopeLevelOfV23 } from './types';
import type { V23ScopedHit, V23ScopeLevel } from './types';
import { V23_SCOPE_LEVEL_WEIGHTS } from './types';

/** Tuy chon multi-scope retrieval. */
export interface V23ScopedRetrievalOptions extends V23FusionOptions {
  /** Co bao gom record app-wide (scope rong) khong (mac dinh true). */
  includeAppScope?: boolean;
  /** Jaccard >= nguong nay = trung lap de dedupe (mac dinh 0.85). */
  dedupeThreshold?: number;
}

/** Chuyen V23Scope (v23) sang MemoryScope (graph) de dung helper co san. */
export function toGraphScopeV23(scope: { userId: string; agentId: string; runId: string; appId: string }): MemoryScope {
  return {
    userId: scope.userId,
    botId: scope.agentId,
    runId: scope.runId,
    appId: scope.appId,
  };
}

/** Chuoi scope cha cua scope truy van (run -> agent -> user -> app). */
export function scopeChainV23(scope: { userId: string; agentId: string; runId: string; appId: string }): MemoryScope[] {
  return expandScopeChain(toGraphScopeV23(scope));
}

/**
 * Retrieve da scope: loc theo scopeIncludes, fusion tren pool da
 * loc, ap trong so muc scope, dedupe, sap xep.
 */
export async function retrieveV23Scoped(
  store: V23MemoryStore,
  query: string,
  queryScope: { userId: string; agentId: string; runId: string; appId: string },
  embedder: V23LocalEmbedder | undefined,
  opts: V23ScopedRetrievalOptions = {},
): Promise<V23ScopedHit[]> {
  const topK = opts.topK ?? 10;
  const dedupeThreshold = opts.dedupeThreshold ?? 0.85;
  const includeApp = opts.includeAppScope ?? true;
  const graphQuery = toGraphScopeV23(queryScope);

  // Loc pool: record phai nam trong scope truy van (hoac scope cha).
  const pool = store.listActive().filter((record) => {
    const factScope = toGraphScopeV23(record.scope);
    if (!includeApp && !record.scope.userId && !record.scope.agentId && !record.scope.runId) {
      return false;
    }
    return scopeIncludes(graphQuery, factScope);
  });
  if (pool.length === 0) return [];

  // Query rong = recent theo scope (khong cham fusion).
  const trimmed = query.trim();
  let ranked: V23ScopedHit[];
  if (!trimmed) {
    const recent = [...pool].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    ranked = recent.map((record) => toScopedHitV23(record, 1, {
      semantic: 0,
      bm25: 0,
      entity: 0,
    }, 'recent (query rong)'));
  } else {
    const fused = await fuseV23(pool, trimmed, embedder, {
      ...opts,
      entityIndex: opts.entityIndex ?? store.getEntityIndex(),
      topK: 1000,
      minScore: 0,
    });
    ranked = fused.map((hit) => {
      const level = scopeLevelOfV23(hit.record.scope);
      const weight = scopeLevelWeight(
        level === 'run' ? 'run' : level === 'agent' ? 'agent' : level === 'user' ? 'user' : 'app',
      );
      return toScopedHitV23(hit.record, hit.score * weight, hit.signals, `${hit.explanation} · scope ${level} x${weight.toFixed(2)}`, level, weight);
    });
    ranked.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  }

  // Dedupe theo text chuan hoa (giu hit diem cao nhat) — ap cho
  // ca fusion lan recent (cung fact o 2 scope chi tra 1 lan).
  const deduped: V23ScopedHit[] = [];
  for (const hit of ranked) {
    const normalized = normalizeV23Text(hit.record.text).toLowerCase();
    let dup: V23ScopedHit | undefined;
    for (const kept of deduped) {
      if (jaccardV23(normalized, normalizeV23Text(kept.record.text).toLowerCase()) >= dedupeThreshold) {
        dup = kept;
        break;
      }
    }
    if (dup) {
      if (!dup.mergedSources.includes(hit.record.id)) dup.mergedSources.push(hit.record.id);
      continue;
    }
    deduped.push(hit);
  }
  return deduped.slice(0, Math.max(0, topK));
}

/** Chuyen FusionHit (hoac record recent) thanh ScopedHit. */
function toScopedHitV23(
  record: V23ScopedHit['record'],
  score: number,
  signals: V23ScopedHit['signals'],
  explanation: string,
  level?: V23ScopeLevel,
  weight?: number,
): V23ScopedHit {
  const resolvedLevel = level ?? scopeLevelOfV23(record.scope);
  const resolvedWeight = weight ?? V23_SCOPE_LEVEL_WEIGHTS[resolvedLevel];
  return {
    record,
    score,
    signals,
    explanation,
    scopeLevel: resolvedLevel,
    scopeWeight: resolvedWeight,
    mergedSources: [],
  };
}

/**
 * Audit scope: record nao trong store ma scope truy van KHONG duoc
 * thay (de UI giai thich "sao khong thay fact X"). Tra so luong
 * theo tung muc scope bi chan.
 */
export function auditScopeVisibilityV23(
  store: V23MemoryStore,
  queryScope: { userId: string; agentId: string; runId: string; appId: string },
): { visible: number; hidden: number; hiddenByLevel: Record<string, number> } {
  const graphQuery = toGraphScopeV23(queryScope);
  let visible = 0;
  let hidden = 0;
  const hiddenByLevel: Record<string, number> = {};
  for (const record of store.list({})) {
    if (record.status !== 'active') continue;
    if (scopeIncludes(graphQuery, toGraphScopeV23(record.scope))) visible += 1;
    else {
      hidden += 1;
      const level = scopeLevelOfV23(record.scope);
      hiddenByLevel[level] = (hiddenByLevel[level] ?? 0) + 1;
    }
  }
  return { visible, hidden, hiddenByLevel };
}
