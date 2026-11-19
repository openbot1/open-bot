/**
 * Protocols v7 — public surface (v1.38, Team T2).
 *
 * A2A v1.0.1 complete client/server (JWS-signed Agent Card +
 * key rotation + multi-tenant registry + trust store, long-
 * running async task lifecycle with push notifications) +
 * MCP stateless HTTP transport (spec 2026-07-28: no handshake,
 * no session id, every request self-describing) + UCP read-only
 * adapter (catalog / cart / order lookup — checkout and payment
 * refused by construction) + governance layer (delegation with
 * revocation + escalation to the user, constraints, hash-chained
 * audit log) — the layer all five surveyed protocols lack.
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md. No code, text or asset from any
 * other repo is copied here. This layer builds on the v6
 * protocols (`protocolsV6/`) and the `mcp/` / `a2a/` / `acp/`
 * layers without touching them.
 */

export * from './versions';
export * from './a2aCardV7';
export * from './a2aTaskV7';
export * from './a2aServerV7';
export * from './a2aClientV7';
export * from './mcpStatelessV7';
export * from './ucpReadOnlyV7';
export * from './governanceV7';
