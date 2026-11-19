/**
 * Public surface of `packages/core/src/fleetV28/` (v1.41, Team T6):
 * fleet v28 — platform/fleet v28.
 *
 * Built on fleet v27 (async run campaigns, automation templates,
 * fleet quota v2) without redoing it — v28 adds the per-conversation
 * execution layer, following OpenHands SDK v1.60 (survey
 * `docs/repo-survey-v141.md` §3):
 * - `runtime.ts`: per-conversation sandbox runtime — one runtime
 *   per conversation with CPU/RAM/disk/timeout/idle limits,
 *   start/stop/restart lifecycle, idle eviction with a saved state
 *   snapshot, a bounded concurrency cap + waiting queue, and health
 *   probes with auto-restart. Decides + tracks; the host enforces.
 * - `secrets.ts`: profile-scoped secrets — a secret belongs to one
 *   bot/profile and is invisible to every other profile (proven by
 *   test), log redaction, rotation with a grace window, and an
 *   audit ledger that never carries values.
 * - `budget.ts`: conversation budget meter — token/$ per
 *   conversation, per-model pricing, warn threshold + hard cap
 *   (records past the cap are refused), alerts, and daily/weekly
 *   spend reports per profile and per conversation.
 * - `presets.ts`: runtime + budget presets per profile
 *   (small/medium/large/custom) — one named choice per profile.
 * - `panelsV28.ts`: view-models for every v28 area + the combined
 *   dashboard (secrets panel carries names only, never values).
 * - `toolsV28.ts`: pure tool definitions (40 tools, 8 groups).
 *
 * Other modules import from here (or directly per file) — never
 * from `fleetV27/` for v28 concepts (v28 keeps its own stores; the
 * host migrates/bridges where the two versions share a resource).
 */
export const FLEET_V28_VERSION = 'v28';
export * from './runtime';
export * from './secrets';
export * from './budget';
export * from './presets';
export * from './sandbox';
export * from './forecast';
export * from './conversationAdapter';
export * from './panelsV28';
export * from './toolsV28';
