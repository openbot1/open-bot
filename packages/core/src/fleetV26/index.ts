/**
 * Public surface of `packages/core/src/fleetV26/` (v1.39, Team T6):
 * fleet v26 — platform/fleet + UI v26.
 *
 * Built on fleet v25 (multi-user roles + audit log + scheduled
 * automations v2) without redoing it:
 * - `resources.ts`: host capacity probe + host reserve + per-bot
 *   CPU/RAM/disk quotas that never promise what the host cannot
 *   spare (disk unknown = disk allocations refused, not guessed).
 * - `bots.ts`: bot registry + lifecycle (one guarded transition
 *   table, bounded restarts, heartbeat staleness).
 * - `health.ts`: scored health checks (heartbeat/state/quota/
 *   restarts/errors) + fleet roll-up.
 * - `sharedBlocks.ts`: shared memory blocks across bots (Letta-style:
 *   one block, many bots; versioned writes, leases, history). Owns
 *   ONLY sharing mechanics — retrieval/ranking delegates to a
 *   `FleetV26MemoryBlockProvider` (memory v24 adapter); the local
 *   fallback is a plain substring scan, labelled as such.
 * - `skills.ts`: the fleet skill pack (skill = folder + SKILL.md;
 *   progressive disclosure: metadata ~100 tokens at startup, body
 *   <5k tokens on trigger, scripts/assets lazy).
 * - `hooks.ts`: deterministic PreToolUse/PostToolUse/Stop hooks —
 *   policy enforcement that never asks the model (first deny wins).
 * - `plugins.ts`: plugin bundles (skills + hooks + MCP server in one
 *   versioned, checksummed package; install never runs anything).
 * - `mcpApps.ts`: MCP Apps host side — `ui://` resource registry,
 *   strict CSP from declared + allowlisted domains, render decisions
 *   (apps on/off, trusted/blocked servers, ask-first default).
 * - `admission.ts`: admission policy + settings (memory facts, apps,
 *   skills, plugins) with reasons per decision + an ask spam guard.
 * - `panelsV26.ts`: view-models for every v26 area + the memory
 *   panel (MemFS tree projection — memory v24 owns the tree) +
 *   the settings panel + the combined dashboard.
 * - `toolsV26.ts`: pure tool definitions (34 tools, 10 groups).
 *
 * Other modules import from here (or directly per file) — never from
 * `fleetV25/` for v26 concepts (v26 keeps its own stores; the host
 * migrates/bridges where the two versions share a resource).
 */
export const FLEET_V26_VERSION = 'v26';
export * from './resources';
export * from './bots';
export * from './health';
export * from './sharedBlocks';
export * from './skills';
export * from './hooks';
export * from './plugins';
export * from './mcpApps';
export * from './admission';
export * from './panelsV26';
export * from './toolsV26';
