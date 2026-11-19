/**
 * Protocols v10 — public surface (v1.41, Team T2).
 *
 * MCP stateless v10 (OTel trace in `_meta`, deterministic
 * tool listing, one opt-in `subscriptions/listen` stream,
 * server-issued state handles), OAuth v10 (issuer validation
 * per RFC 9207, token binding, DCR deprecated), tool search
 * (`defer_loading` + search index + programmatic tool
 * calling), Tasks extension v10 (priorities, dependencies,
 * retries, progress events, snapshots), MCP Apps v10
 * (postMessage bridge: `ui/initialize` + `tools/call`, host
 * arbitrates, CSP from declared domains), multi round-trip
 * v10 (`input_required` with schema-checked answers), A2A
 * v10 (minimal 1.0 handshake, loopback-only), and the
 * deprecation policy registry (12-month floor, 90-day
 * security floor).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1). No code, text or
 * asset from any other repo is copied here. This layer builds
 * on the v8/v9 protocols without touching them.
 */

export * from './versionsV10';
export * from './mcpStatelessV10';
export * from './oauthV10';
export * from './toolSearchV10';
export * from './mcpTasksV10';
export * from './mcpAppsV10';
export * from './multiRoundTripV10';
export * from './a2aV10';
export * from './deprecationV10';
