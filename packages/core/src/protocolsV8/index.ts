/**
 * Protocols v8 — public surface (v1.39, Team T2).
 *
 * MCP spec 2026-07-28 extension framework: server/discover +
 * per-request extension negotiation on the stateless core,
 * MCP Apps host (ui:// resources in a sandboxed iframe with
 * a CSP from declared domains), Tasks extension (task handle
 * + non-blocking poll + embedded final result + MRTR input
 * rounds), OAuth 2.1 / OIDC alignment (mandatory PKCE S256,
 * exact-match redirect URIs, Client Credentials, Enterprise
 * Managed Authorization), deprecation handling for
 * Sampling / Roots / Logging / HTTP+SSE / initialize
 * (SEP-2577, removal floor 2027-07-28, Streamable HTTP
 * preferred), NANDA-style discovery + self-signed identity
 * (local-first sketch, no central service), and Skills over
 * MCP (skill packs served over skill:// resources with
 * progressive disclosure).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md. No code, text or asset from any
 * other repo is copied here. This layer builds on the v7
 * protocols (`protocolsV7/`) without touching them.
 */

export * from './versionsV8';
export * from './mcpStatelessV8';
export * from './mcpAppsV8';
export * from './mcpTasksV8';
export * from './oauthV8';
export * from './deprecationV8';
export * from './nandaV8';
export * from './skillsOverMcpV8';
