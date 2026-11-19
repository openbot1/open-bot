/**
 * Protocols v9 — public surface (v1.40, Team T2).
 *
 * MCP Apps v2 lifecycle (open / close / reopen / suspend /
 * resume / focus, panel slots, durable snapshots), ACP
 * (Agent Client Protocol) agent sessions over the CLI agents
 * already on the machine (Claude Code / Codex / Gemini CLI
 * via the user's existing login — credentials are never
 * copied), and A2A v1.1 delegation (Agent Card discovery,
 * capability-matched delegation, message + artifact
 * exchange, task lifecycle, loopback-only).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v140.md (section 5). No code, text or
 * asset from any other repo is copied here. This layer builds
 * on the v8 protocols (`protocolsV8/`) without touching them.
 */

export * from './versionsV9';
export * from './mcpAppsV9';
export * from './acpSessionsV9';
export * from './a2aV9';
