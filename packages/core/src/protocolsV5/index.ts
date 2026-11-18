/**
 * Protocols v5 — public surface (v1.29, Team T2).
 *
 * Version matrix (ACP v2 draft + A2A 1.1 final under the Linux
 * Foundation) + background MCP tasks (SDK 0.3.319 style: task id,
 * placeholder tool_result, task_notification) + per-tool
 * permission_policy (SDK 0.3.301 style) + MCP OAuth elicitation /
 * reconnect (needs-auth, no crashed sessions) + ACP v2 draft
 * client adapter / agent registry / BYOA adapter with A2A
 * alignment.
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v129.md. No code, text or asset from any
 * other repo is copied here. This layer builds on the v4
 * protocols (`protocolsV4/`) and the `mcp/` / `a2a/` / `acp/`
 * layers without touching them.
 */

export * from './versions';
export * from './mcpBackgroundTasksV5';
export * from './mcpPermissionPolicyV5';
export * from './mcpOAuthElicitationV5';
export * from './acpV2ClientV5';
