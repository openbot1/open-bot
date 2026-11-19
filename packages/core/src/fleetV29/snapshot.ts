/**
 * Fleet v29 snapshot — host persistence (v1.42, Team T6).
 *
 * The fleet's slow-changing configuration — the peer registry
 * (cards + samples), the allowlist — as one JSON document the host
 * can save to disk and restore on restart. The snapshot is
 * deliberately NARROW:
 *
 *   - Board tasks, the audit log, and pending confirmations are
 *     LIVE state and are NOT snapshotted. A task restored from disk
 *     would lie about its peer (the peer may have finished, failed,
 *     or been cancelled while the app was down); the audit log is
 *     append-only and must never be rewritten by a restore; a
 *     confirmation restored after its expiry would ask the user
 *     about a dead request. The host re-derives live state from the
 *     running board, audit log, and queue.
 *   - Peers restore as `unverified`, even if they were `verified`
 *     when snapshotted. Trust is re-earned by a fresh card check
 *     after restart — a card could have changed while the app was
 *     down, and a snapshot must never smuggle old trust past the
 *     gate. The snapshot keeps the last fingerprint so the restore
 *     can report peers whose card already differs from the saved one.
 *   - Samples restore as recorded (they are measurements, not trust).
 *
 * Restore is fail-closed: a snapshot with the wrong version, a
 * malformed peer/allowlist entry, or an unknown task state is
 * refused whole — never partially applied.
 */

import type { FleetV29Allowlist } from './allowlist';
import type { FleetV29PeerRegistry } from './peerRegistry';
import type { FleetV29AllowlistEntry, FleetV29LatencySample, FleetV29Peer } from './types';
import { fleetV29ValidateScope } from './allowlist';

export const FLEET_V29_SNAPSHOT_VERSION = 'v29';

/** The snapshot document (JSON-able). */
export interface FleetV29Snapshot {
  version: typeof FLEET_V29_SNAPSHOT_VERSION;
  exportedAt: string;
  peers: FleetV29Peer[];
  allowlist: FleetV29AllowlistEntry[];
  samples: Record<string, FleetV29LatencySample[]>;
}

export interface FleetV29SnapshotDeps {
  registry: FleetV29PeerRegistry;
  allowlist: FleetV29Allowlist;
}

/** Build a snapshot from the live stores. */
export function buildFleetV29Snapshot(deps: FleetV29SnapshotDeps, nowIso?: string): FleetV29Snapshot {
  const { peers, samples } = deps.registry.toJSON();
  return {
    version: FLEET_V29_SNAPSHOT_VERSION,
    exportedAt: nowIso ?? new Date().toISOString(),
    peers,
    allowlist: deps.allowlist.list(),
    samples,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Problems with a snapshot document (empty = valid). */
export function fleetV29ValidateSnapshot(snapshot: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(snapshot)) return ['Snapshot is not an object.'];
  if (snapshot['version'] !== FLEET_V29_SNAPSHOT_VERSION) {
    problems.push(`Snapshot version "${String(snapshot['version'] ?? '(missing)')}" is not "${FLEET_V29_SNAPSHOT_VERSION}".`);
  }
  if (typeof snapshot['exportedAt'] !== 'string') problems.push('Snapshot exportedAt must be an ISO-8601 string.');
  if (!Array.isArray(snapshot['peers'])) problems.push('Snapshot peers must be an array.');
  else {
    for (const peer of snapshot['peers'] as unknown[]) {
      if (!isRecord(peer) || typeof peer['peerId'] !== 'string' || !peer['peerId']) {
        problems.push('Snapshot peer entries need a peerId.');
        break;
      }
      if (!isRecord(peer['card']) || typeof peer['card']['name'] !== 'string' || typeof peer['card']['url'] !== 'string') {
        problems.push(`Snapshot peer "${String(peer['peerId'])}" has no valid Agent Card.`);
        break;
      }
    }
  }
  if (!Array.isArray(snapshot['allowlist'])) problems.push('Snapshot allowlist must be an array.');
  else {
    for (const entry of snapshot['allowlist'] as unknown[]) {
      if (!isRecord(entry) || typeof entry['peerId'] !== 'string' || !entry['peerId']) {
        problems.push('Snapshot allowlist entries need a peerId.');
        break;
      }
      if (!isRecord(entry['scope'])) {
        problems.push(`Snapshot allowlist entry "${String(entry['peerId'])}" has no scope.`);
        break;
      }
      const scopeProblems = fleetV29ValidateScope(entry['scope'] as never);
      if (scopeProblems.length > 0) {
        problems.push(`Snapshot allowlist entry "${String(entry['peerId'])}": ${scopeProblems.join('; ')}`);
        break;
      }
    }
  }
  if (!isRecord(snapshot['samples'])) problems.push('Snapshot samples must be an object.');
  else {
    for (const [peerId, list] of Object.entries(snapshot['samples'] as Record<string, unknown>)) {
      if (!Array.isArray(list)) {
        problems.push(`Snapshot samples for peer "${peerId}" must be an array.`);
        break;
      }
      for (const sample of list as unknown[]) {
        if (!isRecord(sample) || typeof sample['latencyMs'] !== 'number' || typeof sample['costUsd'] !== 'number') {
          problems.push(`Snapshot sample for peer "${peerId}" is malformed.`);
          break;
        }
      }
    }
  }
  return problems;
}

/** Result of restoring a snapshot into live stores. */
export type FleetV29SnapshotRestoreResult =
  | {
      ok: true;
      peersRestored: number;
      allowlistRestored: number;
      samplesRestored: number;
      /** Peers whose saved fingerprint differs from the live card (re-verify). */
      fingerprintMismatches: string[];
    }
  | { ok: false; reasons: string[] };

/**
 * Restore a snapshot into live stores. Peers come back `unverified`
 * (trust is re-earned by a fresh card check); allowlist entries come
 * back as saved (including suspended state and expiry); samples come
 * back as recorded. Existing live state for a restored peer is
 * replaced; peers/entries not in the snapshot are left alone.
 */
export function restoreFleetV29Snapshot(
  snapshot: unknown,
  deps: FleetV29SnapshotDeps,
): FleetV29SnapshotRestoreResult {
  const problems = fleetV29ValidateSnapshot(snapshot);
  if (problems.length > 0) return { ok: false, reasons: problems };
  const doc = snapshot as FleetV29Snapshot;
  const mismatches: string[] = [];
  let samplesRestored = 0;
  for (const peer of doc.peers) {
    const live = deps.registry.getPeer(peer.peerId);
    if (live && live.cardFingerprint !== peer.cardFingerprint) mismatches.push(peer.peerId);
    const restored = deps.registry.registerPeer({
      peerId: peer.peerId,
      card: peer.card,
      tags: peer.tags,
      ...(peer.tenantId !== undefined ? { tenantId: peer.tenantId } : {}),
    });
    // Trust is re-earned, never restored: a peer that was verified
    // before shutdown is unverified until its card is checked again.
    restored.cardStatus = 'unverified';
    restored.verifyMethod = 'none';
    restored.verifyProblems = [];
    restored.verifiedAt = null;
    restored.reachable = false;
    restored.consecutiveFailures = 0;
  }
  let allowlistRestored = 0;
  for (const entry of doc.allowlist) {
    const existing = deps.allowlist.get(entry.peerId);
    if (existing) deps.allowlist.remove(entry.peerId);
    const added = deps.allowlist.add(entry.peerId, entry.addedBy, entry.scope, {
      reason: entry.reason,
      expiresAt: entry.expiresAt,
    });
    if (!added.ok) return { ok: false, reasons: [`Could not restore allowlist entry "${entry.peerId}": ${added.reasons.join('; ')}`] };
    if (entry.suspended) deps.allowlist.suspend(entry.peerId);
    allowlistRestored += 1;
  }
  for (const [peerId, list] of Object.entries(doc.samples)) {
    for (const sample of list) {
      deps.registry.recordSample({ ...sample, peerId });
      samplesRestored += 1;
    }
  }
  return {
    ok: true,
    peersRestored: doc.peers.length,
    allowlistRestored,
    samplesRestored,
    fingerprintMismatches: mismatches,
  };
}

/** Serialize a snapshot to a JSON string (for the host's file write). */
export function fleetV29SnapshotToJson(snapshot: FleetV29Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/** Parse a snapshot JSON string (returns problems instead of throwing). */
export function fleetV29SnapshotFromJson(
  json: string,
): { ok: true; snapshot: FleetV29Snapshot } | { ok: false; reasons: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    return { ok: false, reasons: [`Snapshot JSON does not parse: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const problems = fleetV29ValidateSnapshot(parsed);
  if (problems.length > 0) return { ok: false, reasons: problems };
  return { ok: true, snapshot: parsed as FleetV29Snapshot };
}
