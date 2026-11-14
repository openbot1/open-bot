/**
 * Composio per-toolkit connection management (v1.08, Đội T4).
 *
 * The session layer (executors.ts) already knows each toolkit's
 * connection status (`active` / `initiated` / `none`), but there was
 * no place to say "this toolkit is OFF for this user" or to ask "is
 * THIS toolkit healthy right now, on its own". This module is that
 * place — one manager per app instance, owned by the host:
 *
 * - ENABLE / DISABLE per toolkit: a disabled toolkit is never
 *   offered to the agent, never polled by the status poller
 *   (toolkitStatusPolling.ts) and never counted as "unhealthy" —
 *   the user turned it off on purpose, it is not broken.
 * - HEALTH CHECK per toolkit: one toolkit at a time (or all at
 *   once) through a host-injected fetcher — in production the
 *   router's `COMPOSIO_MANAGE_CONNECTIONS` result; in tests a stub.
 *   Failures are recorded per toolkit (last error + consecutive
 *   failures) instead of failing the whole check.
 * - SUMMARY for the UI: totals + the list of enabled-but-unhealthy
 *   toolkits that need the user's attention.
 *
 * Rules:
 * - Toolkits are the known catalog slugs (COMPOSIO_TOOLKIT_SLUGS).
 *   Unknown slugs are rejected with ComposioError
 *   `composio_unknown_toolkit` — a typo'd slug must fail loudly at
 *   setup time, not silently create a phantom toolkit.
 * - Enabled flags persist to a JSON file when `file` is given (same
 *   shape as the other Composio JSON stores); without it the manager
 *   is memory-only. Statuses themselves are NOT persisted — they are
 *   re-checked after restart (a stale 'active' from last week would
 *   be a lie). A corrupt file loads as "everything enabled".
 * - This module never calls Composio and never sees a key: every
 *   status comes from a fetcher the host injects.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPOSIO_TOOLKIT_SLUGS } from './toolkits';
import { ComposioError } from './types';
import type { ComposioConnectionStatus, ComposioToolkitConnection } from './types';
import type { ComposioToolkitStatusFetchFn } from './toolkitStatusPolling';
export type { ComposioToolkitStatusFetchFn } from './toolkitStatusPolling';

/** Full per-toolkit state (what the UI renders per row). */
export interface ComposioToolkitConnectionState extends ComposioToolkitConnection {
  /** False when the user disabled this toolkit (never polled, never unhealthy). */
  enabled: boolean;
  /** ms epoch of the last health check (undefined = never checked). */
  lastCheckedAtMs?: number;
  /** Error text of the last failed check (cleared on success). */
  lastError?: string;
  /** Consecutive failed checks (0 after a success). */
  consecutiveFailures: number;
}

/** Rolled-up numbers for the connections panel. */
export interface ComposioToolkitConnectionSummary {
  total: number;
  enabled: number;
  disabled: number;
  active: number;
  initiated: number;
  none: number;
  neverChecked: number;
  /** Enabled toolkits that need attention (checked + not active, or check failing). */
  unhealthy: string[];
  lastCheckedAtMs?: number;
}

export const COMPOSIO_TOOLKIT_CONNECTIONS_FILE = 'composio-toolkit-connections.json';
export const COMPOSIO_TOOLKIT_CONNECTIONS_VERSION = 1;

export type ComposioSingleToolkitStatusFetchFn = (
  toolkit: string,
) => Promise<ComposioToolkitConnection>;

export interface ComposioToolkitConnectionManagerOptions {
  /** JSON file to persist enabled flags to (undefined = memory-only). */
  file?: string;
  /** Clock, injectable for tests (defaults to Date.now). */
  now?: () => number;
  /** Starting enabled flags (file wins over these when both are given). */
  initialEnabled?: Record<string, boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKnownToolkit(toolkit: string): boolean {
  return (COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit);
}

function assertKnownToolkit(toolkit: string): void {
  if (typeof toolkit !== 'string' || toolkit.trim() === '' || !isKnownToolkit(toolkit.trim())) {
    throw new ComposioError('composio_unknown_toolkit', `Unknown Composio toolkit: ${String(toolkit)}`);
  }
}

export class ComposioToolkitConnectionManager {
  private readonly file?: string;
  private readonly now: () => number;
  private readonly states = new Map<string, ComposioToolkitConnectionState>();

  constructor(options: ComposioToolkitConnectionManagerOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    for (const slug of COMPOSIO_TOOLKIT_SLUGS as readonly string[]) {
      const initial = options.initialEnabled?.[slug];
      this.states.set(slug, {
        toolkit: slug,
        status: 'none',
        enabled: initial !== false,
        consecutiveFailures: 0,
      });
    }
    if (this.file) this.loadFromFile();
  }

  /** State of one toolkit (copy). Throws on an unknown slug. */
  get(toolkit: string): ComposioToolkitConnectionState {
    assertKnownToolkit(toolkit);
    const state = this.states.get(toolkit.trim());
    if (!state) throw new ComposioError('composio_unknown_toolkit', `Unknown Composio toolkit: ${toolkit}`);
    return { ...state };
  }

  /** All toolkits, in catalog order (copies). */
  list(): ComposioToolkitConnectionState[] {
    return (COMPOSIO_TOOLKIT_SLUGS as readonly string[]).map((slug) => ({ ...this.states.get(slug) as ComposioToolkitConnectionState }));
  }

  /** Enabled toolkits only (what the agent + poller should use). */
  listEnabled(): ComposioToolkitConnectionState[] {
    return this.list().filter((s) => s.enabled);
  }

  /** True when the toolkit is enabled (unknown slugs throw). */
  isEnabled(toolkit: string): boolean {
    return this.get(toolkit).enabled;
  }

  /** Enable or disable one toolkit (persists when a file is configured). Throws on an unknown slug. */
  setEnabled(toolkit: string, enabled: boolean): ComposioToolkitConnectionState {
    assertKnownToolkit(toolkit);
    const state = this.states.get(toolkit.trim());
    if (!state) throw new ComposioError('composio_unknown_toolkit', `Unknown Composio toolkit: ${toolkit}`);
    state.enabled = enabled === true;
    this.saveToFile();
    return { ...state };
  }

  /**
   * Apply a batch of statuses (e.g. one `COMPOSIO_MANAGE_CONNECTIONS`
   * result, or one status-poller cycle). Unknown slugs in the batch
   * are reported, not thrown — the server may know toolkits this
   * build does not. Disabled toolkits keep their last status (their
   * rows are stale by design — the user turned them off).
   */
  applyStatuses(statuses: ComposioToolkitConnection[]): { updated: number; unknown: string[] } {
    const checkedAtMs = this.now();
    let updated = 0;
    const unknown: string[] = [];
    if (!Array.isArray(statuses)) return { updated, unknown };
    for (const entry of statuses) {
      if (!entry || typeof entry.toolkit !== 'string' || !isKnownToolkit(entry.toolkit)) {
        if (entry && typeof entry.toolkit === 'string') unknown.push(entry.toolkit);
        continue;
      }
      const state = this.states.get(entry.toolkit);
      if (!state) continue;
      if (!state.enabled) continue;
      state.status = entry.status;
      if (entry.accountLabel !== undefined) state.accountLabel = entry.accountLabel;
      else delete state.accountLabel;
      state.lastCheckedAtMs = checkedAtMs;
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      updated += 1;
    }
    return { updated, unknown };
  }

  /**
   * Health-check ONE toolkit through the host's fetcher. On success
   * the state is updated; on failure the error + failure count are
   * recorded and the old status is kept (a failed check proves
   * nothing about the connection itself). Never throws for a fetch
   * failure — that IS the health data. Throws only on an unknown slug.
   */
  async healthCheck(
    toolkit: string,
    fetchOne: ComposioSingleToolkitStatusFetchFn,
  ): Promise<ComposioToolkitConnectionState> {
    assertKnownToolkit(toolkit);
    const state = this.states.get(toolkit.trim());
    if (!state) throw new ComposioError('composio_unknown_toolkit', `Unknown Composio toolkit: ${toolkit}`);
    const checkedAtMs = this.now();
    try {
      const result = await fetchOne(toolkit.trim());
      if (!result || typeof result.toolkit !== 'string' || result.toolkit !== toolkit.trim()) {
        throw new Error(`health check for ${toolkit.trim()} returned a mismatched result`);
      }
      state.status = result.status;
      if (result.accountLabel !== undefined) state.accountLabel = result.accountLabel;
      else delete state.accountLabel;
      state.lastCheckedAtMs = checkedAtMs;
      state.lastError = undefined;
      state.consecutiveFailures = 0;
    } catch (err) {
      state.lastCheckedAtMs = checkedAtMs;
      state.lastError = err instanceof Error ? err.message : String(err);
      state.consecutiveFailures += 1;
    }
    return { ...state };
  }

  /**
   * Health-check ALL enabled toolkits in one fetch. One toolkit's
   * failure is recorded on that toolkit only — the batch still
   * returns a summary. Toolkits missing from the fetch result keep
   * their last status. A failure of the FETCH ITSELF (network,
   * session) is a global failure, not a per-toolkit one: no toolkit
   * is blamed for it (its old status stays, honestly stale) — the
   * error is reported on the batch result instead.
   */
  async healthCheckAll(
    fetchAll: ComposioToolkitStatusFetchFn,
  ): Promise<ComposioToolkitConnectionSummary & { updated: number; error?: string }> {
    let fetched: ComposioToolkitConnection[];
    try {
      fetched = await fetchAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...this.summary(), updated: 0, error: message };
    }
    if (!Array.isArray(fetched)) {
      return { ...this.summary(), updated: 0, error: 'health check did not return a list' };
    }
    const { updated } = this.applyStatuses(fetched);
    return { ...this.summary(), updated };
  }

  /** Rolled-up numbers for the connections panel. */
  summary(): ComposioToolkitConnectionSummary {
    const out: ComposioToolkitConnectionSummary = {
      total: 0,
      enabled: 0,
      disabled: 0,
      active: 0,
      initiated: 0,
      none: 0,
      neverChecked: 0,
      unhealthy: [],
    };
    let lastCheckedAtMs: number | undefined;
    for (const state of this.states.values()) {
      out.total += 1;
      if (state.enabled) out.enabled += 1;
      else out.disabled += 1;
      if (state.lastCheckedAtMs === undefined) out.neverChecked += 1;
      else if (lastCheckedAtMs === undefined || state.lastCheckedAtMs > lastCheckedAtMs) {
        lastCheckedAtMs = state.lastCheckedAtMs;
      }
      if (state.enabled && state.lastCheckedAtMs !== undefined) {
        if (state.status === 'active') out.active += 1;
        else if (state.status === 'initiated') out.initiated += 1;
        else out.none += 1;
        if (state.status !== 'active' || state.consecutiveFailures > 0) {
          out.unhealthy.push(state.toolkit);
        }
      }
    }
    if (lastCheckedAtMs !== undefined) out.lastCheckedAtMs = lastCheckedAtMs;
    return out;
  }

  /** Forget check results (keeps enabled flags). With a slug: one toolkit only. */
  reset(toolkit?: string): void {
    if (toolkit !== undefined) {
      assertKnownToolkit(toolkit);
      const state = this.states.get(toolkit.trim());
      if (state) {
        state.status = 'none';
        delete state.accountLabel;
        delete state.lastCheckedAtMs;
        delete state.lastError;
        state.consecutiveFailures = 0;
      }
      return;
    }
    for (const state of this.states.values()) {
      state.status = 'none';
      delete state.accountLabel;
      delete state.lastCheckedAtMs;
      delete state.lastError;
      state.consecutiveFailures = 0;
    }
  }

  private loadFromFile(): void {
    if (!this.file) return;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || !isRecord(parsed.toolkits)) return;
    for (const [slug, raw] of Object.entries(parsed.toolkits as Record<string, unknown>)) {
      if (!isKnownToolkit(slug) || !isRecord(raw)) continue;
      const state = this.states.get(slug);
      if (!state) continue;
      if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled;
    }
  }

  private saveToFile(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const toolkits: Record<string, { enabled: boolean }> = {};
      for (const [slug, state] of this.states) {
        toolkits[slug] = { enabled: state.enabled };
      }
      fs.writeFileSync(
        this.file,
        JSON.stringify({ version: COMPOSIO_TOOLKIT_CONNECTIONS_VERSION, toolkits }, null, 2),
        'utf8',
      );
    } catch {
      // Persistence is best-effort: a failed write must not break the
      // enable/disable operation that just succeeded in memory.
    }
  }
}
