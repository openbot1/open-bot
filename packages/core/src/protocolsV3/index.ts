/**
 * Protocols v3 — public surface (v1.19, Team T3).
 *
 * MCP 2026-07-28 stateless core migration (header + _meta
 * negotiation, extension registry, deprecated-feature gate,
 * migration advisor) + Streamable HTTP transport v3 (session-less,
 * legacy HTTP+SSE compat flag) + MRTR v3 (`input_required`,
 * per-round timeout, cancellation, answer validation) + A2A v1.1
 * two-way streaming (flow control, resume) + AG-UI 1.0 canonical
 * run (interrupt-and-resume, subagents, replay) + A2UI v3
 * (8 new kinds, layouts, data binding, actions) + Agent Skills
 * over MCP v3 (multi-server catalog, invocation plans, metering)
 * + MCP Apps v3 (lifecycle, per-surface permissions, surfaces,
 * quotas, audit trail).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v119.md section 2. No code, text or asset from
 * any other repo is copied here. This layer builds on the v2
 * protocols (`protocolsV2/`) and the `mcp/` / `a2a/` / `agui/`
 * layers without touching them.
 */

export * from './versions';
export * from './mcpStatelessV3';
export * from './streamableHttpV3';
export * from './mrtrV3';
export * from './a2aTwoWayV3';
export * from './aguiV3';
export * from './a2uiV3';
export * from './skillsMcpV3';
export * from './mcpAppsV3';
