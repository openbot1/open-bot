/**
 * Discovery for the ACP Control Center (v1.12, Team T4).
 *
 * One function, three sources, all already in the repo:
 * 1. `listAcpBackends()` (`acp/backends.ts`) — which binary + which
 *    ACP argv for each external CLI. Single source of truth, so the
 *    center, the host and the UI can never disagree.
 * 2. `findOnPath()` — is the binary installed? (PATH lookup only.)
 * 3. `probeAcpAgent()` — does the binary answer a real ACP
 *    `initialize` handshake? A `--version` string match is never
 *    enough (same rule as `acp/detect.ts`).
 * 4. `DetectedEngineRegistry` (`detected/`) — login state, reported
 *    by the CLI's own status command / auth file. The center only
 *    ever surfaces the label (email / username / provider list);
 *    it never reads a token file itself.
 *
 * Everything that spawns a process is injectable (`DiscoveryDeps`),
 * so tests run with zero real binaries and the UI path can skip the
 * (slow) ACP probe and show installed/not-installed instantly.
 */

import * as path from 'node:path';

import { acpBackendArgVariants, getAcpBackend, listAcpBackends, type AcpBackendDefinition } from '../backends';
import { findOnPath, probeAcpAgent, type AcpAgentProbe } from '../detect';
import type { DiscoveredControlAgent, ControlCenterBackendId } from './types';

/** Backend id -> detected-registry kind (login check). */
export const BACKEND_TO_DETECTED_KIND: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
  grok: 'grok',
  cursor: 'cursor',
  copilot: 'copilot',
  devin: 'windsurf',
};

export interface LoginInfo {
  loggedIn: boolean;
  label?: string;
  method?: 'oauth' | 'subscription' | 'api-key' | 'env-present' | 'unknown';
}

/** Minimal shape of a detected-engine snapshot the center needs. */
export interface DetectedLoginSnapshot {
  kind: string;
  status: string;
  account?: { label?: string; method?: string };
}

export interface DiscoveryDeps {
  /** Probe one binary for a real ACP handshake (default: probeAcpAgent). */
  probe?: (command: string, args: string[], timeoutMs: number) => Promise<AcpAgentProbe>;
  /** Login snapshots, keyed by detected kind (default: DetectedEngineRegistry). */
  loginSnapshots?: () => Promise<Map<string, DetectedLoginSnapshot>>;
  /** Extra backends beyond the built-in list (custom CLIs). */
  extraBackends?: AcpBackendDefinition[];
  /** State dir for the detected-registry cache (only used with the default login source). */
  stateDir?: string;
}

export interface DiscoverOptions {
  /** Run the ACP handshake probe (slow, spawns each binary). Default false — fast PATH-only scan. */
  probeAcp?: boolean;
  /** Timeout per probe handshake (default 10s). */
  probeTimeoutMs?: number;
  /** Backend ids already registered — flagged `alreadyRegistered`. */
  registeredBackendIds?: string[];
}

/** Default login source: the detected-CLI registry (its own status commands, no credential reads). */
async function defaultLoginSnapshots(stateDir?: string): Promise<Map<string, DetectedLoginSnapshot>> {
  const out = new Map<string, DetectedLoginSnapshot>();
  try {
    const { DetectedEngineRegistry } = await import('../../detected/registry');
    const registry = new DetectedEngineRegistry(
      stateDir ? { stateFilePath: path.join(stateDir, 'detected-engines.json') } : {},
    );
    const snapshot = await registry.detect({ force: true });
    for (const engine of Object.values(snapshot.engines)) {
      out.set(engine.kind, {
        kind: engine.kind,
        status: engine.status,
        account: engine.account
          ? { label: engine.account.label, method: engine.account.method }
          : undefined,
      });
    }
  } catch {
    // Login info is advisory: a registry failure must not break discovery.
  }
  return out;
}

function loginMethodOf(method: string | undefined): LoginInfo['method'] {
  if (method === 'oauth' || method === 'subscription' || method === 'api-key' || method === 'env-present') {
    return method;
  }
  return 'unknown';
}

/**
 * Discover external CLI agents on this machine.
 *
 * Fast path (`probeAcp: false`, the default): PATH lookup + login
 * snapshots only, no binary is executed beyond the detected
 * registry's own status commands. With `probeAcp: true` each
 * installed binary is additionally asked for a real ACP handshake.
 */
export async function discoverControlCenterAgents(
  options: DiscoverOptions = {},
  deps: DiscoveryDeps = {},
): Promise<DiscoveredControlAgent[]> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
  const registered = new Set(options.registeredBackendIds ?? []);
  const backends = [...listAcpBackends(), ...(deps.extraBackends ?? [])];

  let logins = new Map<string, DetectedLoginSnapshot>();
  try {
    logins = deps.loginSnapshots ? await deps.loginSnapshots() : await defaultLoginSnapshots(deps.stateDir);
  } catch {
    logins = new Map();
  }

  const results: DiscoveredControlAgent[] = [];
  for (const backend of backends) {
    const resolved = backend.commands.map((c) => findOnPath(c)).find((p) => p !== undefined);
    const command = resolved ? backend.commands.find((c) => findOnPath(c) === resolved) ?? backend.commands[0] : backend.commands[0];
    const kind = BACKEND_TO_DETECTED_KIND[backend.id];
    const login = kind ? logins.get(kind) : undefined;
    const loggedIn = login?.status === 'available' && login.account !== undefined;
    const base: DiscoveredControlAgent = {
      backendId: backend.id as ControlCenterBackendId,
      name: backend.name,
      command,
      args: backend.args,
      resolvedPath: resolved,
      installed: resolved !== undefined,
      speaksAcp: false,
      loginLabel: login?.account?.label,
      loginMethod: loginMethodOf(login?.account?.method),
      loggedIn,
      verifiedInRepo: backend.verifiedInRepo,
      alreadyRegistered: registered.has(backend.id),
    };
    if (!resolved) {
      results.push({ ...base, error: 'not installed (binary not found on PATH)' });
      continue;
    }
    if (!options.probeAcp) {
      results.push(base);
      continue;
    }
    // Try every argv variant in order (e.g. Gemini `--acp` then
    // `--experimental-acp`); the first that answers wins, same as
    // AcpHost.probeOne. A binary that answers on no variant is
    // reported unavailable, never claimed.
    let probed: DiscoveredControlAgent | undefined;
    for (const args of acpBackendArgVariants(backend)) {
      try {
        const probe = deps.probe
          ? await deps.probe(command, args, probeTimeoutMs)
          : await probeAcpAgent(command, args, probeTimeoutMs);
        if (probe.speaksAcp) {
          probed = {
            ...base,
            args,
            speaksAcp: true,
            agentName: probe.agentName,
            agentVersion: probe.agentVersion,
          };
          break;
        }
        probed = {
          ...base,
          args,
          error: probe.error ?? 'binary did not answer the ACP handshake',
        };
      } catch (error) {
        probed = { ...base, args, error: error instanceof Error ? error.message : String(error) };
      }
    }
    results.push(probed ?? { ...base, error: 'binary did not answer the ACP handshake' });
  }
  return results;
}

/** Find one backend definition by id (built-in or extra). */
export function getControlBackend(
  backendId: string,
  extraBackends: AcpBackendDefinition[] = [],
): AcpBackendDefinition | undefined {
  return getAcpBackend(backendId) ?? extraBackends.find((b) => b.id === backendId);
}
