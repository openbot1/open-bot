/**
 * Protocols v11 — public surface (v1.42, Team T2).
 *
 * MCP 2.0 stateless core (2026-07-28): `_meta` on every
 * request, `server/discover`, routing headers, cacheable
 * lists; multi round-trip requests (`input_required`);
 * Tasks extension (`io.modelcontextprotocol/tasks`); MCP
 * Apps UI extension (`io.modelcontextprotocol/ui`); mandatory
 * OAuth `iss` validation; handshake fallback for servers at
 * 2025-11-25 or older; roots / sampling / logging deprecated
 * (earliest removal 2027-07-28) with no new dependency on
 * any of them.
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v142.md (section 2). No code, text or
 * asset from any other repo is copied here. This layer builds
 * on the v10 protocols without touching them.
 */

export * from './versionsV11';
export * from './statelessV11';
export * from './multiRoundTripV11';
export * from './tasksV11';
export * from './oauthV11';
export * from './interopV11';
export * from './appsV11';
export * from './serverRegistryV11';
export * from './auditV11';
