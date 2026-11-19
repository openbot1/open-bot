/**
 * Public surface of `packages/core/src/fleetV29/` (v1.42, Team T6):
 * fleet v29 — A2A task board: multi-agent coordination over A2A
 * v1.0 (survey `docs/repo-survey-v142.md` §1, ideas only).
 *
 * Built on fleet v28 (per-conversation sandbox runtime,
 * profile-scoped secrets, budget meter) without redoing it — v29
 * adds the coordination layer above the A2A wire protocol:
 * - `types.ts`: peers, board tasks, allowlist entries, audit
 *   entries, confirmations, health rollups, transport port.
 * - `peerRegistry.ts`: peer registry from Agent Cards, card-change
 *   detection (stale), latency/cost samples, health scoring.
 * - `cardVerify.ts`: fleet-side card gate — shape validation,
 *   version negotiation (1.0 / 1.0.1), Ed25519 signature check
 *   (reusing `a2a/signing.ts`), fingerprinting.
 * - `allowlist.ts`: allowlist with least-privilege scope, expiry,
 *   suspend/resume — delegation needs allowlist AND verified card.
 * - `taskBoard.ts`: A2A task board — fail-closed delegation gate,
 *   guarded state transitions (A2A legal table), streaming
 *   progress, cancel, input-required, cursor pagination, cost caps.
 *   Transport is Team T1's A2A v11 (`FleetV29TransportPort`); with
 *   no transport wired the board runs in labelled local-simulation
 *   mode and never claims a task reached a real peer.
 * - `auditLog.ts`: append-only, hash-chained audit log (ids +
 *   states only — never prompt text or secrets).
 * - `sensitiveConfirm.ts`: sensitive-action confirmations — a peer
 *   requests, only the user approves/denies; requests expire.
 * - `health.ts`: fleet health summary + alerts + cost leaderboard.
 * - `panelsV29.ts`: view-models for the desktop panels.
 * - `snapshot.ts`: host persistence for the slow-changing config
 *   (peer registry + allowlist + samples) — peers restore as
 *   `unverified`, trust is re-earned; live state (board tasks,
 *   audit log, confirmations) is never snapshotted.
 * - `toolsV29.ts`: pure tool definitions (37 tools, 7 groups).
 *
 * Other modules import from here (or directly per file) — never
 * from `fleetV28/` for v29 concepts (v29 keeps its own stores; the
 * host migrates/bridges where the two versions share a resource).
 */
export const FLEET_V29_VERSION = 'v29';
export * from './types';
export * from './peerRegistry';
export * from './cardVerify';
export * from './allowlist';
export * from './taskBoard';
export * from './auditLog';
export * from './sensitiveConfirm';
export * from './health';
export * from './panelsV29';
export * from './planner';
export * from './snapshot';
export * from './toolsV29';
