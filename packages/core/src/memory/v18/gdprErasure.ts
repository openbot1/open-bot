/**
 * Memory v18 — Duong xoa GDPR: right to erasure (v1.19, Doi T1).
 *
 * Y tuong hoc tu GDPR (quyen duoc lang quen: user duoc yeu cau xoa
 * du lieu ca nhan cua minh) — tu thiet ke lai hoan toan cho
 * open-bot, chay 100% local, KHONG copy code/text/tai san cua bat
 * ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `TemporalGraphStore.removeFactHard` / `removeEpisodeHard` /
 *    `removeQuarantineHard` / `removeEntity`: thao tac xoa that
 *    duy nhat cua store; v18 chi goi qua chung, khong sua truc
 *    tiep file cua store.
 *  - `TemporalGraphStore.deleteFact` (soft-delete, giu lich su):
 *    v18 dung cho che do `soft` (danh dau deleted, van audit
 *    duoc); che do `hard` moi goi remove*Hard.
 *  - `matchesScope` cua memory/graph/store: loc theo user/bot/run.
 *
 * Moi trong v18:
 *  1. `eraseByUserV18` — xoa toan bo du lieu cua mot user: fact +
 *     episode + quarantine cua user do (loc theo scope.userId).
 *  2. `eraseByEntityV18` — xoa moi fact tro toi mot entity
 *     (subject hoac object), kem tuy chon xoa luon entity neu
 *     khong con fact nao tro toi no.
 *  3. `eraseByTimeRangeV18` — xoa fact/episode tao trong mot
 *     khoang thoi gian [from, to) (vd xoa du lieu thang 10).
 *  4. `dryRun` — che do xem truoc: dem so muc se xoa ma khong xoa
 *     that (bat buoc chay truoc khi xoa that o tool).
 *  5. Audit trail: moi lan xoa (ca dry-run) ghi mot dong JSONL vao
 *     `.open-bot/memory-erasure-audit.jsonl` (ai xoa, xoa gi, bao
 *     nhieu muc, luc nao, ly do) — `readErasureAuditV18` doc lai
 *     de kiem tra sau nay. File audit KHONG bi xoa theo (la bang
 *     chung xoa, chi ghi so luong + id, khong ghi noi dung fact).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphFact, MemoryScope } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';

/** Loi GDPR erasure — message tieng Viet. */
export class V18ErasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18ErasureError';
  }
}

/** File audit JSONL cho cac lan xoa (mot dong / mot lan). */
export const V18_ERASURE_AUDIT_REL_PATH = path.join('.open-bot', 'memory-erasure-audit.jsonl');
/** So dong audit toi da khi doc. */
export const V18_MAX_ERASURE_AUDIT_LINES = 1000;

/** Che do xoa: soft (danh dau deleted) hay hard (xoa khoi file). */
export type V18ErasureMode = 'soft' | 'hard';

/** Pham vi xoa. */
export type V18ErasureScopeKind = 'user' | 'entity' | 'time-range';

/** Yeu cau xoa. */
export interface V18ErasureRequest {
  kind: V18ErasureScopeKind;
  /** userId — bat buoc khi kind = 'user'. */
  userId?: string;
  /** entityId — bat buoc khi kind = 'entity'. */
  entityId?: string;
  /** Khoang thoi gian — bat buoc khi kind = 'time-range'. */
  from?: string;
  to?: string;
  /** Che do xoa (mac dinh 'soft'). */
  mode?: V18ErasureMode;
  /** Ai yeu cau xoa (user id / 'system'). */
  requestedBy: string;
  /** Ly do (vd 'GDPR article 17'). */
  reason?: string;
  /** Xoa luon entity khi khong con fact (chi kind = 'entity'). */
  removeEntityIfOrphaned?: boolean;
}

/** Ket qua mot lan xoa. */
export interface V18ErasureResult {
  kind: V18ErasureScopeKind;
  mode: V18ErasureMode;
  dryRun: boolean;
  factsRemoved: number;
  episodesRemoved: number;
  quarantineRemoved: number;
  entitiesRemoved: number;
  /** Id fact da xoa (de audit, toi da 500 id). */
  factIds: string[];
  at: string;
  requestedBy: string;
}

/** Mot dong audit xoa. */
export interface V18ErasureAuditEntry {
  id: string;
  kind: V18ErasureScopeKind;
  mode: V18ErasureMode;
  dryRun: boolean;
  target: string;
  factsRemoved: number;
  episodesRemoved: number;
  quarantineRemoved: number;
  entitiesRemoved: number;
  requestedBy: string;
  reason: string;
  at: string;
}

let v18ErasureSeq = 0;
function nextV18ErasureId(): string {
  v18ErasureSeq += 1;
  return `erase-${Date.now().toString(36)}-${v18ErasureSeq}`;
}

function nowIsoV18(): string {
  return new Date().toISOString();
}

function parseMsV18(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return ms;
}

/** Dem so muc se xoa theo yeu cau (khong xoa that). */
export function countErasureV18(store: TemporalGraphStore, request: V18ErasureRequest): Omit<V18ErasureResult, 'at' | 'requestedBy'> {
  const mode: V18ErasureMode = request.mode ?? 'soft';
  const allFacts = store.listFacts({ limit: 20000 });
  let facts: GraphFact[] = [];
  let episodes = 0;
  let quarantine = 0;
  let entities = 0;
  if (request.kind === 'user') {
    const userId = (request.userId ?? '').trim();
    if (userId === '') throw new V18ErasureError('Xoa theo user can userId.');
    facts = allFacts.filter((f) => f.scope.userId === userId);
    episodes = store.listUnprocessedEpisodes({ userId }, 5000).length;
    // Episode da processed cung thuoc user — dem qua exportFile.
    const file = store.exportFile();
    episodes = file.episodes.filter((e) => e.userId === userId).length;
    quarantine = file.quarantine.filter((q) => q.scope.userId === userId).length;
  } else if (request.kind === 'entity') {
    const entityId = (request.entityId ?? '').trim();
    if (entityId === '') throw new V18ErasureError('Xoa theo entity can entityId.');
    if (!store.getEntity(entityId)) throw new V18ErasureError(`Khong tim thay entity "${entityId}".`);
    facts = allFacts.filter((f) => f.subjectId === entityId || f.objectId === entityId);
    if (request.removeEntityIfOrphaned) {
      const remaining = allFacts.filter(
        (f) => (f.subjectId === entityId || f.objectId === entityId) && !facts.includes(f),
      );
      entities = remaining.length === 0 ? 1 : 0;
    }
  } else if (request.kind === 'time-range') {
    const fromMs = parseMsV18(request.from);
    const toMs = parseMsV18(request.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
      throw new V18ErasureError('Khoang thoi gian xoa khong hop le (can from < to, dinh dang ISO).');
    }
    facts = allFacts.filter((f) => {
      const created = parseMsV18(f.createdAt);
      return created >= fromMs && created < toMs;
    });
    const file = store.exportFile();
    episodes = file.episodes.filter((e) => {
      const created = parseMsV18(e.createdAt);
      return created >= fromMs && created < toMs;
    }).length;
    quarantine = file.quarantine.filter((q) => {
      const created = parseMsV18(q.createdAt);
      return created >= fromMs && created < toMs;
    }).length;
  } else {
    throw new V18ErasureError(`Loai xoa khong ho tro: "${request.kind}".`);
  }
  return {
    kind: request.kind,
    mode,
    dryRun: true,
    factsRemoved: facts.length,
    episodesRemoved: episodes,
    quarantineRemoved: quarantine,
    entitiesRemoved: entities,
    factIds: facts.slice(0, 500).map((f) => f.id),
  };
}

function appendErasureAuditV18(workspaceDir: string, entry: V18ErasureAuditEntry): boolean {
  try {
    const filePath = path.join(workspaceDir, V18_ERASURE_AUDIT_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Doc audit xoa (moi nhat cuoi, toi da limit dong). */
export function readErasureAuditV18(workspaceDir: string, limit = 100): V18ErasureAuditEntry[] {
  try {
    const filePath = path.join(workspaceDir, V18_ERASURE_AUDIT_REL_PATH);
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '').slice(-V18_MAX_ERASURE_AUDIT_LINES);
    const out: V18ErasureAuditEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as V18ErasureAuditEntry;
        if (entry && typeof entry.id === 'string') out.push(entry);
      } catch {
        continue;
      }
    }
    return out.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/**
 * Thuc hien xoa theo yeu cau. `dryRun = true` thi chi dem, khong
 * xoa that (nhung van ghi audit dry-run). Xoa that luon ghi audit
 * (ke ca khi workspaceDir khong co — audit bo qua, khong throw).
 */
export function eraseV18(
  store: TemporalGraphStore,
  request: V18ErasureRequest,
  opts: { dryRun?: boolean; workspaceDir?: string; now?: Date } = {},
): V18ErasureResult {
  const dryRun = opts.dryRun ?? false;
  const at = (opts.now ?? new Date()).toISOString();
  const counted = countErasureV18(store, request);
  const mode = counted.mode;
  const scope: MemoryScope = { userId: request.userId ?? '', botId: '', runId: '' };
  void scope;
  const result: V18ErasureResult = {
    ...counted,
    dryRun,
    at,
    requestedBy: request.requestedBy,
  };
  if (dryRun) {
    if (opts.workspaceDir) {
      appendErasureAuditV18(opts.workspaceDir, {
        id: nextV18ErasureId(),
        kind: request.kind,
        mode,
        dryRun: true,
        target: targetLabelV18(request),
        factsRemoved: counted.factsRemoved,
        episodesRemoved: counted.episodesRemoved,
        quarantineRemoved: counted.quarantineRemoved,
        entitiesRemoved: counted.entitiesRemoved,
        requestedBy: request.requestedBy,
        reason: (request.reason ?? '').trim() || 'dry-run',
        at,
      });
    }
    return result;
  }

  // Xoa that: lay lai danh sach muc (khong dung factIds cat 500).
  const allFacts = store.listFacts({ limit: 20000 });
  let factIds: string[] = [];
  let episodeIds: string[] = [];
  let quarantineIds: string[] = [];
  if (request.kind === 'user') {
    const userId = (request.userId ?? '').trim();
    factIds = allFacts.filter((f) => f.scope.userId === userId).map((f) => f.id);
    const file = store.exportFile();
    episodeIds = file.episodes.filter((e) => e.userId === userId).map((e) => e.id);
    quarantineIds = file.quarantine.filter((q) => q.scope.userId === userId).map((q) => q.id);
  } else if (request.kind === 'entity') {
    const entityId = (request.entityId ?? '').trim();
    factIds = allFacts.filter((f) => f.subjectId === entityId || f.objectId === entityId).map((f) => f.id);
  } else {
    const fromMs = parseMsV18(request.from);
    const toMs = parseMsV18(request.to);
    factIds = allFacts
      .filter((f) => {
        const created = parseMsV18(f.createdAt);
        return created >= fromMs && created < toMs;
      })
      .map((f) => f.id);
    const file = store.exportFile();
    episodeIds = file.episodes
      .filter((e) => {
        const created = parseMsV18(e.createdAt);
        return created >= fromMs && created < toMs;
      })
      .map((e) => e.id);
    quarantineIds = file.quarantine
      .filter((q) => {
        const created = parseMsV18(q.createdAt);
        return created >= fromMs && created < toMs;
      })
      .map((q) => q.id);
  }

  let entitiesRemoved = 0;
  for (const factId of factIds) {
    if (mode === 'hard') store.removeFactHard(factId);
    else store.deleteFact(factId, request.requestedBy);
  }
  for (const episodeId of episodeIds) store.removeEpisodeHard(episodeId);
  for (const quarantineId of quarantineIds) store.removeQuarantineHard(quarantineId);
  if (request.kind === 'entity' && request.removeEntityIfOrphaned && request.entityId) {
    const stillReferenced = store.listFacts({ limit: 20000 }).some(
      (f) => f.subjectId === request.entityId || f.objectId === request.entityId,
    );
    if (!stillReferenced && store.removeEntity(request.entityId)) entitiesRemoved = 1;
  }
  result.factsRemoved = factIds.length;
  result.episodesRemoved = episodeIds.length;
  result.quarantineRemoved = quarantineIds.length;
  result.entitiesRemoved = entitiesRemoved;
  result.factIds = factIds.slice(0, 500);
  if (opts.workspaceDir) {
    appendErasureAuditV18(opts.workspaceDir, {
      id: nextV18ErasureId(),
      kind: request.kind,
      mode,
      dryRun: false,
      target: targetLabelV18(request),
      factsRemoved: result.factsRemoved,
      episodesRemoved: result.episodesRemoved,
      quarantineRemoved: result.quarantineRemoved,
      entitiesRemoved: result.entitiesRemoved,
      requestedBy: request.requestedBy,
      reason: (request.reason ?? '').trim() || 'GDPR erasure',
      at,
    });
  }
  return result;
}

/** Nhan muc tieu xoa (de audit, khong chua noi dung fact). */
export function targetLabelV18(request: V18ErasureRequest): string {
  if (request.kind === 'user') return `user:${request.userId ?? ''}`;
  if (request.kind === 'entity') return `entity:${request.entityId ?? ''}`;
  return `time-range:${request.from ?? ''}..${request.to ?? ''}`;
}
