/**
 * Memory v21 — Sync + conflict detection (three-way merge).
 *
 * Y tuong hoc tu sync cua git / CRDT don gian: moi record co
 * version + hash; sync so sanh base (diem chung cuoi) voi local
 * va remote. Chi khi CA HAI ben cung doi SO VOI BASE va khac
 * nhau moi la conflict — doi mot ben thi fast-forward, doi
 * giong nhau thi khong conflict. Tu thiet ke lai hoan toan cho
 * open-bot, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Cac loai conflict:
 *  - edit_edit:       ca hai sua cung record, hash khac nhau.
 *  - delete_edit:     local xoa, remote sua (hoac nguoc lai).
 *  - tombstone_edit:  mot ben co tombstone, ben kia sua sau khi
 *    tombstone duoc tao (xoa sau, sua sau — can nguoi quyet).
 *  - version_fork:    ca hai deu tao record moi cung id nhung
 *    noi dung khac nhau (khong co base).
 *
 * Giai quyet: keep_local / keep_remote / keep_both (doi ten ban
 * remote thanh `<id>-remote`) / manual (de lai pending).
 * Vector version don gian: {peerId -> version cao nhat thay} de
 * biet quan he truoc/sau/dong thoi.
 */
import type {
  V21PortableRecord,
  V21SyncConflict,
  V21SyncReport,
  V21SyncResolution,
  V21Tombstone,
} from './types';
import { hashRecordV21 } from './okfFormat';

/** Anh chup mot record tai mot peer (de sync, khong can full body). */
export interface V21SyncSnapshot {
  recordId: string;
  version: number;
  hash: string;
  updatedAt: number;
  deleted: boolean;
  /** Tombstone neu record da xoa (de phan biet delete/edit). */
  tombstone?: V21Tombstone;
  /** Full record neu co (can khi apply). */
  record?: V21PortableRecord;
}

export type V21SyncSnapshotMap = Map<string, V21SyncSnapshot>;

export function snapshotOfRecordV21(
  record: V21PortableRecord,
  deleted = false,
  tombstone?: V21Tombstone,
): V21SyncSnapshot {
  return {
    recordId: record.id,
    version: record.version,
    hash: hashRecordV21(record),
    updatedAt: record.updatedAt,
    deleted,
    tombstone,
    record: { ...record },
  };
}

/** Vector version: peerId -> version cao nhat da thay. */
export type V21VersionVector = Record<string, number>;

export function bumpVersionVectorV21(
  vector: V21VersionVector,
  peerId: string,
  version: number,
): V21VersionVector {
  return { ...vector, [peerId]: Math.max(vector[peerId] ?? 0, version) };
}

/** So sanh 2 vector: before / after / concurrent / equal. */
export function compareVersionVectorsV21(
  a: V21VersionVector,
  b: V21VersionVector,
): 'before' | 'after' | 'concurrent' | 'equal' {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aGreater = true;
    if (bv > av) bGreater = true;
  }
  if (!aGreater && !bGreater) return 'equal';
  if (aGreater && !bGreater) return 'after';
  if (bGreater && !aGreater) return 'before';
  return 'concurrent';
}

export interface V21ThreeWayInput {
  base: V21SyncSnapshotMap;
  local: V21SyncSnapshotMap;
  remote: V21SyncSnapshotMap;
}

export interface V21ThreeWayOutput {
  /** Record chi local doi (apply remote? khong — giu local). */
  localOnlyChanged: string[];
  /** Record chi remote doi (apply vao local). */
  remoteOnlyChanged: string[];
  /** Record ca hai cung doi giong nhau (khong lam gi). */
  bothChangedSame: string[];
  /** Record ca hai cung doi khac nhau. */
  conflicts: V21SyncConflict[];
  /** Record moi o remote (chua co o local). */
  remoteOnlyNew: string[];
  /** Record moi o local (chua co o remote). */
  localOnlyNew: string[];
  /** Record bi xoa o mot ben, khong doi o ben kia. */
  deletedOneSide: { recordId: string; deletedBy: 'local' | 'remote' }[];
}

/**
 * Three-way merge: phan loai moi record. Khong tu sua du lieu —
 * chi phan loai de `applySyncV21` ap dung.
 */
export function threeWayMergeV21(input: V21ThreeWayInput): V21ThreeWayOutput {
  const out: V21ThreeWayOutput = {
    localOnlyChanged: [],
    remoteOnlyChanged: [],
    bothChangedSame: [],
    conflicts: [],
    remoteOnlyNew: [],
    localOnlyNew: [],
    deletedOneSide: [],
  };
  const ids = new Set<string>();
  for (const m of [input.base, input.local, input.remote]) {
    for (const id of m.keys()) ids.add(id);
  }
  for (const id of [...ids].sort()) {
    const base = input.base.get(id);
    const local = input.local.get(id);
    const remote = input.remote.get(id);
    if (!base && local && !remote) {
      out.localOnlyNew.push(id);
      continue;
    }
    if (!base && !local && remote) {
      out.remoteOnlyNew.push(id);
      continue;
    }
    if (!base && local && remote) {
      // Ca hai cung tao moi: giong nhau thi ok, khac nhau thi fork.
      if (local.hash === remote.hash) {
        out.bothChangedSame.push(id);
      } else {
        out.conflicts.push({
          recordId: id,
          kind: 'version_fork',
          baseVersion: 0,
          localVersion: local.version,
          remoteVersion: remote.version,
          detail: `ca hai ben cung tao record "${id}" voi noi dung khac nhau`,
        });
      }
      continue;
    }
    if (!base) continue;
    const localChanged = local ? local.hash !== base.hash || local.deleted !== base.deleted : true;
    const remoteChanged = remote ? remote.hash !== base.hash || remote.deleted !== base.deleted : true;
    const localGone = !local;
    const remoteGone = !remote;
    if (localGone && remoteGone) continue;
    if (localGone && !remoteChanged) {
      out.deletedOneSide.push({ recordId: id, deletedBy: 'local' });
      continue;
    }
    if (remoteGone && !localChanged) {
      out.deletedOneSide.push({ recordId: id, deletedBy: 'remote' });
      continue;
    }
    if (localGone && remoteChanged) {
      out.conflicts.push({
        recordId: id,
        kind: 'delete_edit',
        baseVersion: base.version,
        localVersion: 0,
        remoteVersion: remote?.version ?? 0,
        detail: `local xoa record "${id}" nhung remote van sua (v${remote?.version ?? 0})`,
      });
      continue;
    }
    if (remoteGone && localChanged) {
      out.conflicts.push({
        recordId: id,
        kind: 'delete_edit',
        baseVersion: base.version,
        localVersion: local?.version ?? 0,
        remoteVersion: 0,
        detail: `remote xoa record "${id}" nhung local van sua (v${local?.version ?? 0})`,
      });
      continue;
    }
    if (!local || !remote) continue;
    // Ca hai con ton tai.
    if (local.deleted && remote.deleted) {
      out.bothChangedSame.push(id);
      continue;
    }
    if (local.deleted !== remote.deleted) {
      const deletedSide = local.deleted ? 'local' : 'remote';
      const editedSide = local.deleted ? remote : local;
      const tombstone = local.deleted ? local.tombstone : remote.tombstone;
      const tombAt = tombstone?.deletedAt ?? 0;
      if (tombAt > 0 && editedSide.updatedAt > tombAt) {
        out.conflicts.push({
          recordId: id,
          kind: 'tombstone_edit',
          baseVersion: base.version,
          localVersion: local.version,
          remoteVersion: remote.version,
          detail: `${deletedSide} xoa record "${id}" (tombstone) nhung ben kia sua SAU khi xoa — can nguoi quyet`,
        });
      } else {
        out.deletedOneSide.push({ recordId: id, deletedBy: deletedSide });
      }
      continue;
    }
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      out.localOnlyChanged.push(id);
      continue;
    }
    if (remoteChanged && !localChanged) {
      out.remoteOnlyChanged.push(id);
      continue;
    }
    // Ca hai deu doi.
    if (local.hash === remote.hash) {
      out.bothChangedSame.push(id);
    } else {
      out.conflicts.push({
        recordId: id,
        kind: 'edit_edit',
        baseVersion: base.version,
        localVersion: local.version,
        remoteVersion: remote.version,
        detail: `ca hai ben cung sua record "${id}" (local v${local.version}, remote v${remote.version}) voi noi dung khac nhau`,
      });
    }
  }
  return out;
}

/** Chi phat hien conflict (khong phan loai day du). */
export function detectSyncConflictsV21(input: V21ThreeWayInput): V21SyncConflict[] {
  return threeWayMergeV21(input).conflicts;
}

export interface V21ResolveInput {
  conflict: V21SyncConflict;
  strategy: V21SyncResolution;
  local?: V21SyncSnapshot;
  remote?: V21SyncSnapshot;
}

export interface V21ResolveOutput {
  /** 'local' | 'remote' | 'both' | 'pending' */
  outcome: 'local' | 'remote' | 'both' | 'pending';
  /** Record giu lai (khi outcome local/remote). */
  kept?: V21PortableRecord;
  /** Ban copy doi ten (khi keep_both). */
  renamedCopy?: V21PortableRecord;
  note: string;
}

/**
 * Giai quyet mot conflict theo strategy. keep_both: giu local,
 * copy remote thanh `<id>-remote` (version reset ve 1, ghi ro
 * nguon trong sources de khong mat du lieu ben nao).
 */
export function resolveSyncConflictV21(input: V21ResolveInput): V21ResolveOutput {
  const { conflict, strategy, local, remote } = input;
  if (strategy === 'manual') {
    return { outcome: 'pending', note: `conflict "${conflict.recordId}" (${conflict.kind}) de lai cho nguoi quyet` };
  }
  if (strategy === 'keep_local') {
    if (!local?.record) return { outcome: 'pending', note: `khong co ban local cua "${conflict.recordId}" de giu` };
    return { outcome: 'local', kept: { ...local.record }, note: `giu ban local v${local.version} cua "${conflict.recordId}"` };
  }
  if (strategy === 'keep_remote') {
    if (!remote?.record) return { outcome: 'pending', note: `khong co ban remote cua "${conflict.recordId}" de giu` };
    return { outcome: 'remote', kept: { ...remote.record }, note: `giu ban remote v${remote.version} cua "${conflict.recordId}"` };
  }
  // keep_both
  if (!local?.record || !remote?.record) {
    return { outcome: 'pending', note: `keep_both can ca hai ban cua "${conflict.recordId}"` };
  }
  const renamedCopy: V21PortableRecord = {
    ...remote.record,
    id: `${remote.record.id}-remote`,
    title: `${remote.record.title} (remote)`,
    version: 1,
    sources: [...remote.record.sources, `sync-conflict:${conflict.recordId}`],
    updatedAt: Date.now(),
  };
  return {
    outcome: 'both',
    kept: { ...local.record },
    renamedCopy,
    note: `giu ca hai: local "${conflict.recordId}" + remote doi ten "${renamedCopy.id}"`,
  };
}

export interface V21ApplySyncInput {
  base: V21SyncSnapshotMap;
  local: V21SyncSnapshotMap;
  remote: V21SyncSnapshotMap;
  /** Strategy mac dinh cho moi conflict (co the ghi de theo id). */
  defaultStrategy?: V21SyncResolution;
  perRecordStrategy?: Record<string, V21SyncResolution>;
}

/**
 * Ap dung sync: phan loai 3 chieu, apply cac thay doi khong
 * conflict, giai quyet conflict theo strategy. Tra ve cac id da
 * apply + conflict con pending + bao cao day du. Ham nay KHONG
 * tu sua store — caller ap dung `appliedRemote`/`created`/
 * `deletedByTombstone` vao store cua minh theo ket qua tra ve.
 */
export function applySyncV21(input: V21ApplySyncInput): {
  report: V21SyncReport;
  /** Record remote can ghi de/ghi moi vao local (id -> record). */
  toApply: Map<string, V21PortableRecord>;
  /** Record can doi ten khi keep_both (id moi -> record). */
  toCreateRenamed: Map<string, V21PortableRecord>;
  pendingConflicts: V21SyncConflict[];
} {
  const merged = threeWayMergeV21({ base: input.base, local: input.local, remote: input.remote });
  const report: V21SyncReport = {
    appliedLocal: [],
    appliedRemote: [],
    created: [],
    deletedByTombstone: [],
    conflicts: merged.conflicts,
    skipped: [],
  };
  const toApply = new Map<string, V21PortableRecord>();
  const toCreateRenamed = new Map<string, V21PortableRecord>();
  const pendingConflicts: V21SyncConflict[] = [];

  for (const id of merged.remoteOnlyChanged) {
    const remote = input.remote.get(id);
    if (remote?.record) {
      toApply.set(id, { ...remote.record });
      report.appliedRemote.push(id);
    }
  }
  for (const id of merged.remoteOnlyNew) {
    const remote = input.remote.get(id);
    if (remote?.record) {
      toApply.set(id, { ...remote.record });
      report.created.push(id);
    }
  }
  for (const id of merged.localOnlyChanged) {
    report.appliedLocal.push(id);
  }
  for (const id of merged.localOnlyNew) {
    report.appliedLocal.push(id);
  }
  for (const { recordId, deletedBy } of merged.deletedOneSide) {
    if (deletedBy === 'remote') {
      report.deletedByTombstone.push(recordId);
    } else {
      report.appliedLocal.push(recordId);
    }
  }
  for (const conflict of merged.conflicts) {
    const strategy = input.perRecordStrategy?.[conflict.recordId] ?? input.defaultStrategy ?? 'manual';
    const resolved = resolveSyncConflictV21({
      conflict,
      strategy,
      local: input.local.get(conflict.recordId),
      remote: input.remote.get(conflict.recordId),
    });
    if (resolved.outcome === 'pending') {
      pendingConflicts.push(conflict);
      report.skipped.push(conflict.recordId);
      continue;
    }
    if (resolved.outcome === 'local' && resolved.kept) {
      report.appliedLocal.push(conflict.recordId);
    } else if (resolved.outcome === 'remote' && resolved.kept) {
      toApply.set(conflict.recordId, { ...resolved.kept });
      report.appliedRemote.push(conflict.recordId);
    } else if (resolved.outcome === 'both' && resolved.kept && resolved.renamedCopy) {
      report.appliedLocal.push(conflict.recordId);
      toCreateRenamed.set(resolved.renamedCopy.id, { ...resolved.renamedCopy });
      report.created.push(resolved.renamedCopy.id);
    }
  }
  return { report, toApply, toCreateRenamed, pendingConflicts };
}
