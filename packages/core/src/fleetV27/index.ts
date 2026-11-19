/**
 * Public surface of `packages/core/src/fleetV27/` (v1.40, Team T6):
 * fleet v27 — platform/fleet v27.
 *
 * Built on fleet v26 (per-bot quotas + lifecycle + health) without
 * redoing it:
 * - `campaigns.ts`: async run campaigns — one task across many bots
 *   in the background, per-bot progress, aggregate results, cancel,
 *   retry-failed, finished-run history.
 * - `templates.ts`: scheduled automation templates — an 8-template
 *   built-in catalog, a 5-field cron parser + next-run calculator,
 *   automations created from templates, and a pure suggestion engine
 *   that ranks templates for the operator's repo/bot context.
 * - `quotaV2.ts`: fleet quota v2 — fleet-level CPU/RAM/disk +
 *   concurrent-bot + campaign + daily-run caps, warn/critical alerts,
 *   admit/queue/defer/reject admission with a per-resource exhaustion
 *   policy, a bounded waiting queue, and a decision ledger.
 * - `panelsV27.ts`: view-models for every v27 area + the combined
 *   dashboard.
 * - `toolsV27.ts`: pure tool definitions (30 tools, 4 groups).
 *
 * Other modules import from here (or directly per file) — never from
 * `fleetV26/` for v27 concepts (v27 keeps its own stores; the host
 * migrates/bridges where the two versions share a resource).
 */
export const FLEET_V27_VERSION = 'v27';
export * from './campaigns';
export * from './templates';
export * from './quotaV2';
export * from './panelsV27';
export * from './toolsV27';
