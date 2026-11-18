/**
 * Protocols v4 — public surface (v1.20, Team T2).
 *
 * Version matrix + Poppy 1.0 profile exchange (earlier commits
 * this wave) + A2A v1.1 RC `SendLiveMessage` live session +
 * MCP sampling cleanup + AG-UI 1.0 conformance + IETF
 * agentproto WG watch-track.
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/protocols-v120.md. No code, text or asset from any other
 * repo is copied here. This layer builds on the v3 protocols
 * (`protocolsV3/`) and the `mcp/` / `a2a/` / `agui/` layers
 * without touching them.
 */

export * from './versions';
export * from './poppyV4';
export * from './a2aLiveV4';
export * from './mcpSamplingV4';
export * from './aguiConformanceV4';
export * from './ietfWatchV4';
