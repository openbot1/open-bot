/**
 * Public surface of `packages/core/src/fleetV25/` (v1.38, Team T6):
 * fleet v25 — multi-user roles + audit log + scheduled automations v2.
 *
 * Built on the fleet v24 dashboard (automation registry, run ledger,
 * stop-hook feedback, CIDR sandbox rules), without redoing it:
 * - `roles.ts`: admin/operator/viewer roles, permission matrix,
 *   resource scoping, and the single permission gate every
 *   sensitive action goes through.
 * - `users.ts`: the user directory (invite/activate/disable/enable,
 *   role + scope changes) with the last-active-admin invariant.
 * - `auditLog.ts`: append-only, hash-chained audit log (who did
 *   what, when, on which resource, allowed or denied), query,
 *   verify, prune-with-checkpoint, JSONL export.
 * - `schedules.ts`: scheduled automations v2 — cron (5-field, UTC),
 *   fixed interval, one-shot; run conditions (previous outcome,
 *   time window, max runs/day, tag status, cooldown); retry policy
 *   with exponential backoff; registry with next-run computation.
 * - `scheduledRuns.ts`: run history v2 — attempts grouped into
 *   retry chains, condition results per run, stats, stuck detection.
 * - `automationEngine.ts`: the tick engine — due schedules,
 *   condition evaluation, dispatch via a host callback, retry
 *   arming, dry-run preview, concurrency cap.
 * - `panelsV25.ts`: view-models for roles/users/audit/schedules/
 *   runs + the combined dashboard.
 * - `toolsV25.ts`: pure tool definitions (28 tools, 6 groups).
 *
 * Other modules import from here (or directly per file) — never from
 * `fleetV24/` for v25 concepts (v25 keeps its own stores; the host
 * migrates/bridges where the two versions share a resource).
 */
export const FLEET_V25_VERSION = 'v25';
export * from './roles';
export * from './users';
export * from './auditLog';
export * from './schedules';
export * from './scheduledRuns';
export * from './automationEngine';
export * from './panelsV25';
export * from './toolsV25';
