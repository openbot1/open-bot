/**
 * A2A v1.0 peer registry + allowlist (v11 generation).
 *
 * Security model (Unit 42 lesson): NO peer is trusted by default.
 * A peer becomes usable only after ALL of these pass:
 *
 *  1. REGISTRATION — the peer's card is known (name, url, skills).
 *  2. STRUCTURAL VALIDATION — the card parses and is not expired
 *     (card.ts).
 *  3. SIGNATURE VERIFICATION — the card's signature verifies against
 *     a key the USER pinned for that peer (signing.ts). Unsigned
 *     cards can be registered for display, but never delegated to.
 *  4. ALLOWLIST — the user explicitly allowlisted the peer id.
 *     There is no tool or API that allowlists a peer: it is a user
 *     decision made in the UI / settings (same rule as the older
 *     a2a tools: trust is never granted by the model).
 *  5. HEALTH — the peer is not suspended (too many guard blocks)
 *     and not blocklisted.
 *
 * Trust score: every peer starts at 50. Verified cards add points,
 * guard blocks subtract them, successful delegations add a little.
 * Score is advisory only — it never overrides the allowlist.
 */

import { validateV11AgentCard } from './card';
import type { V11VerificationKey } from './signing';
import { verifyV11AgentCardAgainstKeys } from './signing';
import type { V11AgentCard } from './types';
import { V11AuditLog } from './audit';

/** Lifecycle of a peer in the registry. */
export type V11PeerStatus =
  | 'registered' // known, not yet allowlisted
  | 'allowlisted' // user approved; delegation possible (if verified)
  | 'blocklisted' // user banned; never usable
  | 'suspended'; // auto-suspended after repeated guard blocks

/** One peer record. */
export interface V11PeerRecord {
  /** Stable id, usually the peer's card url host + name. */
  id: string;
  card: V11AgentCard;
  status: V11PeerStatus;
  /** True when the card signature verified against a pinned key. */
  signatureVerified: boolean;
  /** Key id that verified the card, when any. */
  verifiedKeyId?: string;
  /** 0..100 advisory trust score. */
  trustScore: number;
  /** Guard blocks recorded against this peer. */
  guardBlocks: number;
  /** Successful delegations completed. */
  successfulDelegations: number;
  /** Failed / denied delegations. */
  failedDelegations: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVerifiedAt?: string;
  /** User note (why this peer was allowlisted, etc.). */
  note?: string;
}

/** Outcome of the full pre-delegation check. */
export interface V11DelegateCheck {
  allowed: boolean;
  peerId: string;
  /** Every reason delegation is (not) allowed, in check order. */
  reasons: string[];
  negotiatedVersion?: string;
  peer?: V11PeerRecord;
}

/** Guard blocks after which a peer is auto-suspended. */
export const V11_PEER_SUSPEND_AFTER_BLOCKS = 3;
/** Trust score floor / ceiling. */
export const V11_TRUST_MIN = 0;
export const V11_TRUST_MAX = 100;
/** Starting trust score for a newly registered peer. */
export const V11_TRUST_START = 50;
/** Bonus for a verified signature. */
export const V11_TRUST_VERIFIED_BONUS = 25;
/** Penalty per guard block. */
export const V11_TRUST_BLOCK_PENALTY = 15;
/** Bonus per successful delegation (capped by the ceiling). */
export const V11_TRUST_SUCCESS_BONUS = 2;

function clampTrust(score: number): number {
  return Math.max(V11_TRUST_MIN, Math.min(V11_TRUST_MAX, score));
}

/** Derive a stable peer id from a card (url host + name). */
export function v11PeerIdForCard(card: V11AgentCard): string {
  try {
    const host = new URL(card.url).host.replace(/[^a-zA-Z0-9.-]/g, '-');
    const name = card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `${name}@${host}`;
  } catch {
    return card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
}

/** The peer registry: cards, allowlist, trust, suspension. */
export class V11PeerRegistry {
  private readonly peers = new Map<string, V11PeerRecord>();
  /** Pinned verification keys, by peer id. */
  private readonly pinnedKeys = new Map<string, V11VerificationKey[]>();
  private readonly audit: V11AuditLog;

  constructor(audit?: V11AuditLog) {
    this.audit = audit ?? new V11AuditLog();
  }

  get auditLog(): V11AuditLog {
    return this.audit;
  }

  /**
   * Register (or refresh) a peer from its card. Structural validation
   * runs now; signature verification runs when keys are pinned (or
   * immediately if keys are supplied). Registration alone grants
   * NOTHING — the peer starts as `registered`, not allowlisted.
   */
  registerPeer(
    card: V11AgentCard,
    options: { keys?: V11VerificationKey[]; note?: string; now?: Date } = {},
  ): { record: V11PeerRecord; validationIssues: string[] } {
    const now = (options.now ?? new Date()).toISOString();
    const id = v11PeerIdForCard(card);
    const validation = validateV11AgentCard(card, options.now ?? new Date());
    const existing = this.peers.get(id);
    const keys = options.keys ?? this.pinnedKeys.get(id) ?? [];
    let signatureVerified = false;
    let verifiedKeyId: string | undefined;
    if (card.signature && keys.length > 0) {
      const result = verifyV11AgentCardAgainstKeys(card, keys);
      signatureVerified = result.valid;
      verifiedKeyId = result.valid ? result.keyId : undefined;
    }
    const record: V11PeerRecord = {
      id,
      card: JSON.parse(JSON.stringify(card)) as V11AgentCard,
      status: existing?.status ?? 'registered',
      signatureVerified,
      ...(verifiedKeyId ? { verifiedKeyId } : {}),
      trustScore: clampTrust(
        (existing?.trustScore ?? V11_TRUST_START) +
          (signatureVerified ? V11_TRUST_VERIFIED_BONUS : 0),
      ),
      guardBlocks: existing?.guardBlocks ?? 0,
      successfulDelegations: existing?.successfulDelegations ?? 0,
      failedDelegations: existing?.failedDelegations ?? 0,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      ...(signatureVerified ? { lastVerifiedAt: now } : {}),
      ...(options.note ?? existing?.note ? { note: options.note ?? existing?.note } : {}),
    };
    this.peers.set(id, record);
    this.audit.append('peer.registered', `Peer ${id} registered (card ${validation.valid ? 'valid' : 'INVALID'}${signatureVerified ? ', signature verified' : ''})`, {
      peerId: id,
      data: { valid: validation.valid, signatureVerified, issues: validation.issues.map((i) => i.message) },
    });
    if (!validation.valid) {
      this.audit.append('card.rejected', `Card for ${id} failed structural validation`, {
        peerId: id,
        data: { issues: validation.issues.map((i) => `${i.field}: ${i.message}`) },
      });
    }
    return {
      record,
      validationIssues: validation.issues.map((i) => `${i.field}: ${i.message}`),
    };
  }

  /** Pin verification keys for a peer (user action, via UI/settings). */
  pinKeys(peerId: string, keys: V11VerificationKey[]): void {
    this.pinnedKeys.set(peerId, [...keys]);
    const peer = this.peers.get(peerId);
    if (peer && peer.card.signature) {
      const result = verifyV11AgentCardAgainstKeys(peer.card, keys);
      peer.signatureVerified = result.valid;
      peer.verifiedKeyId = result.valid ? result.keyId : undefined;
      if (result.valid) {
        peer.trustScore = clampTrust(peer.trustScore + V11_TRUST_VERIFIED_BONUS);
        peer.lastVerifiedAt = new Date().toISOString();
      }
      this.audit.append(
        result.valid ? 'card.verified' : 'card.rejected',
        `Card for ${peerId} ${result.valid ? 'verified' : 'FAILED verification'} against pinned key`,
        { peerId, data: { keyId: result.keyId, reason: result.reason } },
      );
    }
  }

  getPeer(peerId: string): V11PeerRecord | undefined {
    return this.peers.get(peerId);
  }

  listPeers(status?: V11PeerStatus): V11PeerRecord[] {
    const all = [...this.peers.values()];
    return status === undefined ? all : all.filter((p) => p.status === status);
  }

  /** USER-ONLY: allowlist a peer. No tool may call this. */
  allowlistPeer(peerId: string, note?: string): V11PeerRecord {
    const peer = this.mustGet(peerId);
    peer.status = 'allowlisted';
    if (note !== undefined) peer.note = note;
    this.audit.append('peer.allowlisted', `Peer ${peerId} allowlisted by user`, { peerId });
    return peer;
  }

  /** USER-ONLY: blocklist a peer (overrides everything). */
  blocklistPeer(peerId: string, note?: string): V11PeerRecord {
    const peer = this.mustGet(peerId);
    peer.status = 'blocklisted';
    if (note !== undefined) peer.note = note;
    this.audit.append('peer.blocklisted', `Peer ${peerId} blocklisted by user`, { peerId });
    return peer;
  }

  /** USER-ONLY: lift a suspension (after review). */
  unsuspendPeer(peerId: string): V11PeerRecord {
    const peer = this.mustGet(peerId);
    if (peer.status === 'suspended') peer.status = 'registered';
    peer.guardBlocks = 0;
    this.audit.append('peer.unsuspended', `Peer ${peerId} suspension lifted by user`, { peerId });
    return peer;
  }

  /**
   * Record a guard block against a peer. Trust drops; at the
   * threshold the peer is auto-suspended (allowlisted peers included
   * — a compromised allowlisted peer must not keep working).
   */
  recordGuardBlock(peerId: string, reason: string): V11PeerRecord | undefined {
    const peer = this.peers.get(peerId);
    if (!peer) return undefined;
    peer.guardBlocks += 1;
    peer.trustScore = clampTrust(peer.trustScore - V11_TRUST_BLOCK_PENALTY);
    this.audit.append('guard.block', `Guard blocked peer ${peerId}: ${reason}`, {
      peerId,
      data: { blocks: peer.guardBlocks, trustScore: peer.trustScore },
    });
    if (peer.guardBlocks >= V11_PEER_SUSPEND_AFTER_BLOCKS && peer.status !== 'blocklisted') {
      peer.status = 'suspended';
      this.audit.append('peer.suspended', `Peer ${peerId} auto-suspended after ${peer.guardBlocks} guard blocks`, {
        peerId,
      });
    }
    return peer;
  }

  recordDelegationSuccess(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.successfulDelegations += 1;
    peer.trustScore = clampTrust(peer.trustScore + V11_TRUST_SUCCESS_BONUS);
  }

  recordDelegationFailure(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.failedDelegations += 1;
  }

  /**
   * The full pre-delegation check. Every reason is collected so the
   * caller (and the user) sees the whole picture, not just the first
   * failure. Delegation is allowed ONLY when reasons is empty.
   */
  checkDelegation(peerId: string, now: Date = new Date()): V11DelegateCheck {
    const reasons: string[] = [];
    const peer = this.peers.get(peerId);
    if (!peer) {
      return { allowed: false, peerId, reasons: ['peer is not registered'] };
    }
    if (peer.status === 'blocklisted') reasons.push('peer is blocklisted by the user');
    if (peer.status === 'suspended') {
      reasons.push(`peer is suspended after ${peer.guardBlocks} guard blocks`);
    }
    if (peer.status === 'registered') {
      reasons.push('peer is not allowlisted (user approval required)');
    }
    const validation = validateV11AgentCard(peer.card, now);
    if (!validation.valid) {
      reasons.push(`card is invalid: ${validation.issues.map((i) => i.message).join('; ')}`);
    }
    if (validation.expired) reasons.push('card is expired');
    if (!peer.card.signature) {
      reasons.push('card is unsigned — signed cards only');
    } else if (!peer.signatureVerified) {
      reasons.push('card signature did not verify against a pinned key');
    }
    return { allowed: reasons.length === 0, peerId, reasons, peer };
  }

  /** Peers currently usable for delegation. */
  usablePeers(now: Date = new Date()): V11PeerRecord[] {
    return this.listPeers('allowlisted').filter(
      (p) => this.checkDelegation(p.id, now).allowed,
    );
  }

  count(): number {
    return this.peers.size;
  }

  clear(): void {
    this.peers.clear();
    this.pinnedKeys.clear();
  }

  private mustGet(peerId: string): V11PeerRecord {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`unknown peer: ${peerId}`);
    return peer;
  }
}
