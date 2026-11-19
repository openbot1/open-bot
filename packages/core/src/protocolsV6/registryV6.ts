/**
 * Protocols v6 — registry: watch entries, tested-with table,
 * capability advertisement (v1.37, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v137.md:
 *  - Poppy 1.0 (Personal Agent Protocol, Sierra + Meta,
 *    13/11/2026) is five days old at survey time — open-bot
 *    only WATCHES it. The registry records Poppy as
 *    "watch, not implemented" with the date it was last
 *    reviewed, and refuses to open a Poppy session.
 *  - The IETF Agent Communication Protocols working group
 *    (chartered 10/2026) aims at one base protocol MCP and A2A
 *    can both carry. v6 tracks it as a watch entry with dated
 *    notes, not as a protocol it speaks.
 *  - The survey asked for an IETF ACP-WG "tested with" table
 *    with dates: the registry keeps dated interop rows (peer,
 *    protocol, version, date, result, note) so the UI can say
 *    what was actually tested, when — not what is merely
 *    claimed.
 *
 * This module is the open-bot implementation, built from scratch:
 *   - `ProtocolV6Registry` — watch entries (Poppy, IETF ACP-WG,
 *     and any future protocol), tested-with rows, and the
 *     capability advertisement (elicitation modes, ACP v2 draft
 *     features, A2A two-way streaming) aggregated from the v6
 *     modules.
 *   - `protocolV6CompatibilityReport()` — one report: what v6
 *     speaks, what it only watches, and what a v5 / v4 peer
 *     still gets.
 *
 * No code, text or asset from any other repo is copied here.
 */

import {
  ACP_V6_CURRENT_VERSION,
  A2A_V6_CURRENT_VERSION,
  AGUI_V6_CURRENT_VERSION,
  A2UI_V6_CURRENT_VERSION,
  MCP_V6_CURRENT_VERSION,
  POPPY_V6_CURRENT_VERSION,
  POPPY_V6_IMPLEMENTATION_NOTE,
  PROTOCOL_V6_CURRENT_VERSIONS,
  defaultProtocolV6Capabilities,
  protocolV6VersionStatus,
  type ProtocolV6CapabilityAdvertisement,
  type ProtocolV6Family,
} from './versions';

/** What open-bot does with a tracked protocol. */
export type ProtocolV6WatchStatus = 'implemented' | 'watch-only' | 'not-planned';
export const PROTOCOL_V6_WATCH_STATUSES: readonly ProtocolV6WatchStatus[] = [
  'implemented',
  'watch-only',
  'not-planned',
];

/** One tracked protocol (implemented or merely watched). */
export interface ProtocolV6WatchEntry {
  /** Stable id, e.g. `poppy` or `ietf-acp-wg`. */
  id: string;
  /** Display name. */
  name: string;
  /** Protocol family, when it maps to one (Poppy maps to `poppy`). */
  family?: ProtocolV6Family;
  /** Version known / tracked. */
  version: string;
  status: ProtocolV6WatchStatus;
  /** What open-bot does (or pointedly does not do) with it. */
  note: string;
  /** ISO date (YYYY-MM-DD) this entry was last reviewed. */
  lastReviewed: string;
  /** Source of the tracking note (a doc, not a URL fetch). */
  source: string;
}

/** Result of one dated interop test. */
export type ProtocolV6TestResult = 'pass' | 'partial' | 'fail' | 'not-tested';
export const PROTOCOL_V6_TEST_RESULTS: readonly ProtocolV6TestResult[] = [
  'pass',
  'partial',
  'fail',
  'not-tested',
];

/** One row of the "tested with" table. */
export interface ProtocolV6TestedWithRow {
  rowId: string;
  /** Peer name (e.g. an agent, client or SDK name). */
  peer: string;
  family: ProtocolV6Family;
  version: string;
  /** ISO date (YYYY-MM-DD) of the test. */
  testedOn: string;
  result: ProtocolV6TestResult;
  /** What was exercised (e.g. `session/prompt returns message id`). */
  coverage: string;
  note?: string;
}

/** Error raised by registry operations. */
export class ProtocolV6RegistryError extends Error {
  readonly code: 'duplicate-entry' | 'unknown-entry' | 'unknown-row' | 'bad-date' | 'poppy-not-implemented';
  constructor(message: string, code: ProtocolV6RegistryError['code']) {
    super(message);
    this.name = 'ProtocolV6RegistryError';
    this.code = code;
  }
}

export interface ProtocolV6RegistryOptions {
  /** Clock override (tests) — used for `lastReviewed` defaults. */
  now?: () => number;
  /** Id generator override (tests). */
  generateId?: (prefix: string) => string;
}

let protocolV6RegistryCounter = 0;
function defaultProtocolV6RegistryId(prefix: string): string {
  protocolV6RegistryCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${protocolV6RegistryCounter.toString(36)}`;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The Poppy watch entry: tracked, never implemented. */
export function poppyV6WatchEntry(lastReviewed = '2026-11-18'): ProtocolV6WatchEntry {
  return {
    id: 'poppy',
    name: 'Poppy — Personal Agent Protocol',
    family: 'poppy',
    version: POPPY_V6_CURRENT_VERSION,
    status: 'watch-only',
    note: POPPY_V6_IMPLEMENTATION_NOTE,
    lastReviewed,
    source: 'docs/repo-survey-v137.md',
  };
}

/** The IETF Agent Communication Protocols working-group watch entry. */
export function ietfAcpWgV6WatchEntry(lastReviewed = '2026-11-18'): ProtocolV6WatchEntry {
  return {
    id: 'ietf-acp-wg',
    name: 'IETF Agent Communication Protocols working group',
    version: 'charter-2026-10',
    status: 'watch-only',
    note: 'IETF working group (chartered 10/2026) aiming at one base protocol that MCP and A2A can both carry. Tracked only — open-bot speaks no IETF ACP-WG draft yet; the tested-with table records any interop test against its drafts when one happens.',
    lastReviewed,
    source: 'docs/repo-survey-v137.md',
  };
}

/** Default watch entries for a fresh registry. */
export function defaultProtocolV6WatchEntries(): ProtocolV6WatchEntry[] {
  return [poppyV6WatchEntry(), ietfAcpWgV6WatchEntry()];
}

/**
 * The protocol registry: watch entries + the dated
 * "tested with" interop table + the aggregated capability
 * advertisement. Seeded with the Poppy and IETF ACP-WG watch
 * entries; hosts add their own interop rows as tests happen.
 */
export class ProtocolV6Registry {
  private readonly watchEntries = new Map<string, ProtocolV6WatchEntry>();
  private readonly testedWith: ProtocolV6TestedWithRow[] = [];
  private capabilities: ProtocolV6CapabilityAdvertisement;
  private readonly now: () => number;
  private readonly generateId: (prefix: string) => string;

  constructor(options: ProtocolV6RegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultProtocolV6RegistryId;
    this.capabilities = defaultProtocolV6Capabilities();
    for (const entry of defaultProtocolV6WatchEntries()) {
      this.watchEntries.set(entry.id, { ...entry });
    }
  }

  // ---- Watch entries ----

  /** Add or replace a watch entry (Poppy's status may never become `implemented` here). */
  upsertWatchEntry(entry: ProtocolV6WatchEntry): ProtocolV6WatchEntry {
    if (entry.id === 'poppy' && entry.status === 'implemented') {
      throw new ProtocolV6RegistryError(
        'Poppy is watch-only in open-bot: its registry entry can never be marked implemented.',
        'poppy-not-implemented',
      );
    }
    if (!isIsoDate(entry.lastReviewed)) {
      throw new ProtocolV6RegistryError(`lastReviewed "${entry.lastReviewed}" is not a YYYY-MM-DD date.`, 'bad-date');
    }
    const stored = { ...entry };
    this.watchEntries.set(entry.id, stored);
    return { ...stored };
  }

  getWatchEntry(id: string): ProtocolV6WatchEntry | undefined {
    const entry = this.watchEntries.get(id);
    return entry ? { ...entry } : undefined;
  }

  /** All watch entries, sorted by id. */
  listWatchEntries(status?: ProtocolV6WatchStatus): ProtocolV6WatchEntry[] {
    return [...this.watchEntries.values()]
      .filter((e) => status === undefined || e.status === status)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({ ...e }));
  }

  /** The Poppy entry — always present, always watch-only. */
  poppyStatus(): ProtocolV6WatchEntry {
    return this.getWatchEntry('poppy') as ProtocolV6WatchEntry;
  }

  /** True when open-bot implements a tracked protocol (never true for Poppy). */
  isImplemented(id: string): boolean {
    return this.watchEntries.get(id)?.status === 'implemented';
  }

  /**
   * Guard: refuse to open a session for a watch-only protocol.
   * Call this before any session constructor for Poppy / IETF
   * drafts — the refusal is the implementation of "watch, not
   * implemented".
   */
  requireImplemented(id: string): void {
    const entry = this.watchEntries.get(id);
    if (!entry) return; // untracked ids are the caller's business
    if (entry.status !== 'implemented') {
      throw new ProtocolV6RegistryError(
        `${entry.name} is ${entry.status} in open-bot (${entry.note})`,
        entry.id === 'poppy' ? 'poppy-not-implemented' : 'unknown-entry',
      );
    }
  }

  // ---- Tested-with table ----

  /** Record one dated interop test. */
  addTestedWith(row: Omit<ProtocolV6TestedWithRow, 'rowId'>): ProtocolV6TestedWithRow {
    if (!isIsoDate(row.testedOn)) {
      throw new ProtocolV6RegistryError(`testedOn "${row.testedOn}" is not a YYYY-MM-DD date.`, 'bad-date');
    }
    if (protocolV6VersionStatus(row.family, row.version) === 'unknown') {
      throw new ProtocolV6RegistryError(`Unknown ${row.family} version "${row.version}".`, 'unknown-row');
    }
    const stored: ProtocolV6TestedWithRow = { ...row, rowId: this.generateId('tested6') };
    this.testedWith.push(stored);
    return { ...stored };
  }

  getTestedWith(rowId: string): ProtocolV6TestedWithRow | undefined {
    const row = this.testedWith.find((r) => r.rowId === rowId);
    return row ? { ...row } : undefined;
  }

  removeTestedWith(rowId: string): boolean {
    const idx = this.testedWith.findIndex((r) => r.rowId === rowId);
    if (idx === -1) return false;
    this.testedWith.splice(idx, 1);
    return true;
  }

  /** Tested-with rows, newest test first, optionally filtered. */
  listTestedWith(opts: { family?: ProtocolV6Family; result?: ProtocolV6TestResult; peer?: string } = {}): ProtocolV6TestedWithRow[] {
    return this.testedWith
      .filter((r) => (opts.family === undefined || r.family === opts.family)
        && (opts.result === undefined || r.result === opts.result)
        && (opts.peer === undefined || r.peer === opts.peer))
      .sort((a, b) => b.testedOn.localeCompare(a.testedOn) || b.rowId.localeCompare(a.rowId))
      .map((r) => ({ ...r }));
  }

  /** Latest test per family (or undefined when untested). */
  latestTestPerFamily(): Partial<Record<ProtocolV6Family, ProtocolV6TestedWithRow>> {
    const out: Partial<Record<ProtocolV6Family, ProtocolV6TestedWithRow>> = {};
    for (const family of Object.keys(PROTOCOL_V6_CURRENT_VERSIONS) as ProtocolV6Family[]) {
      const rows = this.listTestedWith({ family });
      if (rows.length > 0) out[family] = rows[0] as ProtocolV6TestedWithRow;
    }
    return out;
  }

  // ---- Capabilities ----

  getCapabilities(): ProtocolV6CapabilityAdvertisement {
    return { ...this.capabilities, elicitationModes: [...this.capabilities.elicitationModes] };
  }

  setCapabilities(capabilities: ProtocolV6CapabilityAdvertisement): void {
    this.capabilities = { ...capabilities, elicitationModes: [...capabilities.elicitationModes] };
  }

  /** Serialise the whole registry (watch entries + tested-with + capabilities). */
  toJSON(): {
    watchEntries: ProtocolV6WatchEntry[];
    testedWith: ProtocolV6TestedWithRow[];
    capabilities: ProtocolV6CapabilityAdvertisement;
  } {
    return {
      watchEntries: this.listWatchEntries(),
      testedWith: this.listTestedWith(),
      capabilities: this.getCapabilities(),
    };
  }

  /** Rebuild a registry from serialised JSON (unknown rows are skipped). */
  static fromJSON(data: unknown): ProtocolV6Registry {
    const registry = new ProtocolV6Registry();
    if (!data || typeof data !== 'object') return registry;
    const d = data as {
      watchEntries?: unknown;
      testedWith?: unknown;
      capabilities?: unknown;
    };
    if (Array.isArray(d.watchEntries)) {
      for (const raw of d.watchEntries) {
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as Partial<ProtocolV6WatchEntry>;
        if (typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.version !== 'string') continue;
        try {
          registry.upsertWatchEntry({
            id: e.id,
            name: e.name,
            family: e.family,
            version: e.version,
            status: e.status ?? 'watch-only',
            note: typeof e.note === 'string' ? e.note : '',
            lastReviewed: typeof e.lastReviewed === 'string' && isIsoDate(e.lastReviewed) ? e.lastReviewed : '2026-11-18',
            source: typeof e.source === 'string' ? e.source : 'registry import',
          });
        } catch {
          // A bad imported entry never breaks the registry.
        }
      }
    }
    if (Array.isArray(d.testedWith)) {
      for (const raw of d.testedWith) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Partial<ProtocolV6TestedWithRow>;
        if (typeof r.peer !== 'string' || typeof r.family !== 'string' || typeof r.version !== 'string'
          || typeof r.testedOn !== 'string' || typeof r.result !== 'string' || typeof r.coverage !== 'string') continue;
        try {
          registry.addTestedWith({
            peer: r.peer,
            family: r.family as ProtocolV6Family,
            version: r.version,
            testedOn: r.testedOn,
            result: r.result as ProtocolV6TestResult,
            coverage: r.coverage,
            note: typeof r.note === 'string' ? r.note : undefined,
          });
        } catch {
          // Skip bad rows on import.
        }
      }
    }
    if (d.capabilities && typeof d.capabilities === 'object') {
      const c = d.capabilities as Partial<ProtocolV6CapabilityAdvertisement>;
      if (Array.isArray(c.elicitationModes)) {
        registry.setCapabilities({
          elicitationModes: (c.elicitationModes as string[]).filter((m) => m === 'form' || m === 'url') as ('form' | 'url')[],
          a2aTwoWayStreaming: c.a2aTwoWayStreaming === true,
          acpStructuredFileChanges: c.acpStructuredFileChanges === true,
          acpOutOfTurnUpdates: c.acpOutOfTurnUpdates === true,
          acpPromptMessageIds: c.acpPromptMessageIds === true,
          acpV1Parallel: c.acpV1Parallel === true,
        });
      }
    }
    return registry;
  }

  /** Summary counts for the UI. */
  summary(): { watchEntries: number; watchOnly: number; implemented: number; testedWithRows: number; testedFamilies: number } {
    const latest = this.latestTestPerFamily();
    return {
      watchEntries: this.watchEntries.size,
      watchOnly: this.listWatchEntries('watch-only').length,
      implemented: this.listWatchEntries('implemented').length,
      testedWithRows: this.testedWith.length,
      testedFamilies: Object.keys(latest).length,
    };
  }
}

/** One family's line in the compatibility report. */
export interface ProtocolV6CompatibilityLine {
  family: ProtocolV6Family;
  v6Current: string;
  implemented: boolean;
  v5Compatible: boolean;
  v4Compatible: boolean;
  note: string;
}

/** What v6 speaks, what it only watches, and what older peers still get. */
export function protocolV6CompatibilityReport(): ProtocolV6CompatibilityLine[] {
  const v5Versions: Record<ProtocolV6Family, readonly string[]> = {
    acp: ['2.0-draft', '1.0'],
    poppy: ['1.0', '0.2', '0.1'],
    mcp: ['2026-07-28', '2025-11-25'],
    a2a: ['1.1', '1.1-rc', '1.0'],
    agui: ['1.0', '0.0.1'],
    a2ui: ['1.0', '0.1'],
  };
  const v4Versions: Record<ProtocolV6Family, readonly string[]> = {
    acp: [],
    poppy: ['1.0', '0.2', '0.1'],
    mcp: ['2026-07-28', '2025-11-25'],
    a2a: ['1.1-rc', '1.0'],
    agui: ['1.0', '0.0.1'],
    a2ui: ['1.0', '0.1'],
  };
  return (Object.keys(PROTOCOL_V6_CURRENT_VERSIONS) as ProtocolV6Family[]).map((family) => {
    const current = PROTOCOL_V6_CURRENT_VERSIONS[family];
    const implemented = family !== 'poppy';
    const v5Compatible = v5Versions[family].includes(current);
    const v4Compatible = v4Versions[family].includes(current);
    let note: string;
    if (family === 'poppy') {
      note = POPPY_V6_IMPLEMENTATION_NOTE;
    } else if (family === 'acp') {
      note = 'v6 speaks ACP 2.0-draft (structured file changes, out-of-turn updates, prompt message ids) alongside ACP 1.0. A v5 peer gets the same versions but none of the v6-only capabilities; a v4 peer has no ACP at all.';
    } else if (family === 'a2a') {
      note = `A2A ${A2A_V6_CURRENT_VERSION} is final; v6 adds two-way streaming for running tasks. A v5 peer negotiates ${A2A_V6_CURRENT_VERSION} without streaming; a v4 peer falls back to 1.1-rc.`;
    } else if (family === 'mcp') {
      note = `MCP ${MCP_V6_CURRENT_VERSION} current; elicitation is stable (form + URL). Legacy versions leave on 2027-07-28.`;
    } else {
      note = `${family} ${current} current; unchanged from v5.`;
    }
    return { family, v6Current: current, implemented, v5Compatible, v4Compatible, note };
  });
}

/** One-line summary of the v6 registry for logs. */
export function protocolV6RegistrySummary(registry: ProtocolV6Registry): string {
  const s = registry.summary();
  return `protocols v6: acp ${ACP_V6_CURRENT_VERSION} + a2a ${A2A_V6_CURRENT_VERSION} + mcp ${MCP_V6_CURRENT_VERSION} + agui ${AGUI_V6_CURRENT_VERSION} + a2ui ${A2UI_V6_CURRENT_VERSION} · Poppy watch-only · ${s.testedWithRows} tested-with row(s) across ${s.testedFamilies} familie(s)`;
}
