/**
 * Protocols v6 — public surface (v1.37, Team T2).
 *
 * Version matrix + ACP v2 draft running in parallel with v1
 * (structured file changes, session/update outside a prompt
 * turn, session/prompt returning a message id) + stable
 * elicitation (structured form + URL mode, client advertises
 * its modes) + A2A 1.1 two-way streaming for running tasks
 * (cancel / resume mid-task) + the protocol registry (Poppy:
 * watch-only, not implemented; IETF ACP-WG tracked; dated
 * "tested with" table).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md. No code, text or asset from any
 * other repo is copied here. This layer builds on the v5
 * protocols (`protocolsV5/`) and the `mcp/` / `a2a/` / `acp/`
 * layers without touching them.
 */

export * from './versions';
export * from './acpV2FileChangesV6';
export * from './acpV2SessionV6';
export * from './elicitationV6';
export * from './a2aStreamingV6';
export * from './registryV6';
