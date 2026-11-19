/**
 * Fleet v29 Agent Card verification (v1.42, Team T6).
 *
 * Fleet-side card gate: validates the card shape, negotiates the
 * A2A protocol version (1.0 / 1.0.1), checks the Ed25519 signature
 * when present, and fingerprints the card so a changed card is
 * detected. This module does NOT fetch cards and does NOT own the
 * transport — Team T1's A2A v11 client/server fetches and serves
 * cards; this module only answers "may the fleet trust this card
 * right now?".
 *
 * It reuses the existing repo verifiers (`a2a/card.ts` shape
 * validation, `a2a/signing.ts` signature verification) instead of
 * re-implementing them — a second signature implementation would be
 * a second place to get wrong. Version negotiation is fleet v29's
 * own (1.0.0 / 1.0.1 per the v1.42 survey): a card claiming a
 * version above 1.0.1 is not negotiable here, a card claiming below
 * 1.0 is too old, and a card with no version is treated as 1.0.
 *
 * Fingerprint: a small deterministic hash over the canonical card
 * JSON (field order sorted, recursively). It is a change detector,
 * not a cryptographic commitment — the Ed25519 signature is the
 * authenticity check; the fingerprint only answers "did this card
 * change since we last saw it".
 */

import { validateAgentCard } from '../a2a/card';
import { verifyAgentCardSignature } from '../a2a/signing';
import type { A2aAgentCard } from '../a2a/types';
import type { FleetV29CardStatus, FleetV29VerifyMethod } from './types';
import { FLEET_V29_A2A_VERSIONS } from './types';

/** Policy for the fleet-side card gate (host-configurable). */
export interface FleetV29CardPolicy {
  /** Reject cards with no valid signature (default true — fail-closed). */
  requireSigned: boolean;
  /** Lowest protocol version accepted (default '1.0'). */
  minVersion: string;
  /** Highest protocol version accepted (default '1.0.1'). */
  maxVersion: string;
  /** Card fingerprints (key ids) the fleet refuses outright. */
  blockedKeyIds: string[];
  /** Card fingerprints the fleet accepts even if unsigned (rare, explicit). */
  unsignedAllowedFingerprints: string[];
}

export const FLEET_V29_DEFAULT_CARD_POLICY: FleetV29CardPolicy = {
  requireSigned: true,
  minVersion: '1.0',
  maxVersion: '1.0.1',
  blockedKeyIds: [],
  unsignedAllowedFingerprints: [],
};

export interface FleetV29CardCheck {
  status: FleetV29CardStatus;
  method: FleetV29VerifyMethod;
  problems: string[];
  /** Negotiated protocol version (null when negotiation failed). */
  negotiatedVersion: string | null;
  /** Fingerprint of the card that was checked. */
  fingerprint: string;
  /** True when the fleet may delegate to this peer (status verified, or unsigned + allowed). */
  usable: boolean;
}

/** Canonical JSON: sorted keys, recursive — stable across key order. */
export function fleetV29CanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => fleetV29CanonicalJson(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${fleetV29CanonicalJson(record[k])}`).join(',')}}`;
}

/** Small FNV-1a hash (hex) — change detector, not a security hash. */
export function fleetV29HashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Fingerprint of a card (without its signature field — signing changes the card). */
export function fleetV29FingerprintCard(card: A2aAgentCard): string {
  const { signature: _sig, ...unsigned } = card as A2aAgentCard & { signature?: unknown };
  void _sig;
  const digest = fleetV29HashText(fleetV29CanonicalJson(unsigned));
  const keyId = card.signature?.keyId;
  return keyId ? `${keyId}:${digest}` : `unsigned:${digest}`;
}

/** Compare two dotted versions ('1.0' < '1.0.1' < '1.1'). */
export function fleetV29CompareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Negotiate a protocol version: highest version both sides support. */
export function fleetV29NegotiateVersion(
  cardVersion: string | undefined,
  policy: FleetV29CardPolicy = FLEET_V29_DEFAULT_CARD_POLICY,
): { version: string | null; problems: string[] } {
  const claimed = (cardVersion ?? '1.0').trim() || '1.0';
  if (fleetV29CompareVersions(claimed, policy.minVersion) < 0) {
    return { version: null, problems: [`Card protocol version ${claimed} is below minimum ${policy.minVersion}.`] };
  }
  if (fleetV29CompareVersions(claimed, policy.maxVersion) > 0) {
    return { version: null, problems: [`Card protocol version ${claimed} is above maximum ${policy.maxVersion}.`] };
  }
  const negotiated = FLEET_V29_A2A_VERSIONS.filter(
    (v) => fleetV29CompareVersions(v, claimed) <= 0 && fleetV29CompareVersions(v, policy.minVersion) >= 0,
  ).sort(fleetV29CompareVersions).pop();
  if (!negotiated) return { version: null, problems: [`No common A2A version with card version ${claimed}.`] };
  return { version: negotiated, problems: [] };
}

/**
 * Full fleet-side card check. `previousFingerprint` is the
 * fingerprint the registry last verified — a different fingerprint
 * with the same peer id means the card changed and must be checked
 * fresh (the caller marks the peer `stale` in that case).
 */
export function fleetV29CheckCard(
  card: unknown,
  policy: FleetV29CardPolicy = FLEET_V29_DEFAULT_CARD_POLICY,
  previousFingerprint?: string,
): FleetV29CardCheck {
  const problems: string[] = [];
  if (typeof card !== 'object' || card === null) {
    return {
      status: 'invalid',
      method: 'none',
      problems: ['Agent Card is not an object.'],
      negotiatedVersion: null,
      fingerprint: 'invalid:00000000',
      usable: false,
    };
  }
  const record = card as Record<string, unknown>;
  const fingerprint = fleetV29FingerprintCard(card as A2aAgentCard);
  if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
    problems.push('Agent Card changed since last verification; re-verify before delegating.');
    return { status: 'stale', method: 'none', problems, negotiatedVersion: null, fingerprint, usable: false };
  }
  const shapeProblems = validateAgentCard(card);
  problems.push(...shapeProblems);
  const version = typeof record['protocolVersion'] === 'string' ? (record['protocolVersion'] as string) : undefined;
  const negotiated = fleetV29NegotiateVersion(version, policy);
  problems.push(...negotiated.problems);
  const signature = (card as A2aAgentCard).signature;
  if (signature) {
    if (policy.blockedKeyIds.includes(signature.keyId)) {
      problems.push(`Signing key ${signature.keyId} is blocked.`);
    } else {
      const verification = verifyAgentCardSignature(card as unknown as Record<string, unknown>);
      if (!verification.ok) {
        problems.push(`Agent Card signature does not verify: ${verification.reason ?? 'invalid signature'}.`);
      }
    }
  } else if (policy.requireSigned) {
    problems.push('Agent Card is unsigned and the fleet policy requires a signed card.');
  }
  if (problems.length > 0) {
    // Explicit exception: an unsigned card whose fingerprint the
    // fleet listed is usable even when the policy requires signing.
    const unsignedOk =
      !signature &&
      policy.unsignedAllowedFingerprints.includes(fingerprint) &&
      shapeProblems.length === 0 &&
      negotiated.problems.length === 0;
    if (unsignedOk) {
      return { status: 'unsigned', method: 'unsigned-allowed', problems: [], negotiatedVersion: negotiated.version, fingerprint, usable: true };
    }
    return { status: 'invalid', method: 'none', problems, negotiatedVersion: null, fingerprint, usable: false };
  }
  if (!signature) {
    return { status: 'unsigned', method: 'unsigned-allowed', problems: [], negotiatedVersion: negotiated.version, fingerprint, usable: true };
  }
  return { status: 'verified', method: 'signature', problems: [], negotiatedVersion: negotiated.version, fingerprint, usable: true };
}

/** True when a card status counts as "verified enough to delegate" (with allowlist). */
export function fleetV29CardStatusUsable(status: FleetV29CardStatus): boolean {
  return status === 'verified' || status === 'unsigned';
}
