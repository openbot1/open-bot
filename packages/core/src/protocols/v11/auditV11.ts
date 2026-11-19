/**
 * Protocols v11 — request audit log (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): the stateless core
 * keeps no sessions, so the only way to debug a request
 * after the fact is a per-request audit record keyed by the
 * routing request id. No code, text or asset from any other
 * repo is copied here.
 *
 * What this module owns:
 *  - `McpV11AuditLog`: a bounded ring buffer of request
 *    records (method, routing request id, routing key,
 *    server, outcome, duration, error code). Old records
 *    drop off the end — the log never grows without bound.
 *  - Queries: by request id, by method, by server, errors
 *    only, plus counts and per-method timing stats.
 *  - The log stores no credentials and no tool arguments
 *    (arguments can carry user data); it stores only the
 *    method, ids, outcome and timing — enough to audit,
 *    never enough to replay a secret.
 */

/** One audited request. */
export interface McpV11AuditEntry {
  /** Routing request id (`mcp-request-id`). */
  requestId: string;
  /** JSON-RPC method, e.g. `tools/call`. */
  method: string;
  /** Routing key the request carried (when any). */
  routingKey?: string;
  /** Server that handled the request (when known). */
  server?: string;
  /** Outcome: ok / refused / failed. */
  outcome: 'ok' | 'refused' | 'failed';
  /** JSON-RPC / layer error code (when refused or failed). */
  errorCode?: string;
  /** How long the request took (ms). */
  durationMs: number;
  /** When the request finished (ms since epoch). */
  atMs: number;
}

/** Per-method timing stats. */
export interface McpV11AuditMethodStats {
  method: string;
  count: number;
  errors: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

/** Bounded ring-buffer audit log. */
export class McpV11AuditLog {
  private entries: McpV11AuditEntry[] = [];

  constructor(private readonly maxEntries: number = 500) {}

  /** Record one request. Returns the stored entry. */
  record(entry: Omit<McpV11AuditEntry, 'atMs'> & { atMs?: number }): McpV11AuditEntry {
    const stored: McpV11AuditEntry = { ...entry, atMs: entry.atMs ?? Date.now() };
    this.entries.push(stored);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    return stored;
  }

  /** All entries, oldest first. */
  list(): McpV11AuditEntry[] {
    return [...this.entries];
  }

  /** Find one entry by its routing request id. */
  byRequestId(requestId: string): McpV11AuditEntry | undefined {
    return this.entries.find((e) => e.requestId === requestId);
  }

  /** Entries for one method. */
  byMethod(method: string): McpV11AuditEntry[] {
    return this.entries.filter((e) => e.method === method);
  }

  /** Entries for one server. */
  byServer(server: string): McpV11AuditEntry[] {
    return this.entries.filter((e) => e.server === server);
  }

  /** Only the refused / failed entries. */
  errors(): McpV11AuditEntry[] {
    return this.entries.filter((e) => e.outcome !== 'ok');
  }

  /** Counts by outcome. */
  counts(): { total: number; ok: number; refused: number; failed: number } {
    return {
      total: this.entries.length,
      ok: this.entries.filter((e) => e.outcome === 'ok').length,
      refused: this.entries.filter((e) => e.outcome === 'refused').length,
      failed: this.entries.filter((e) => e.outcome === 'failed').length,
    };
  }

  /** Per-method timing stats, sorted by method. */
  methodStats(): McpV11AuditMethodStats[] {
    const byMethod = new Map<string, McpV11AuditEntry[]>();
    for (const entry of this.entries) {
      const list = byMethod.get(entry.method) ?? [];
      list.push(entry);
      byMethod.set(entry.method, list);
    }
    return [...byMethod.entries()]
      .map(([method, list]) => ({
        method,
        count: list.length,
        errors: list.filter((e) => e.outcome !== 'ok').length,
        avgDurationMs: Math.round(list.reduce((sum, e) => sum + e.durationMs, 0) / list.length),
        maxDurationMs: Math.max(...list.map((e) => e.durationMs)),
      }))
      .sort((a, b) => (a.method < b.method ? -1 : 1));
  }

  /** Drop everything (the host calls this on rotation, never on read). */
  clear(): void {
    this.entries = [];
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Time one request and record it: `start` returns a finisher
 * the server calls with the outcome. The server uses this so
 * every dispatch — including refusals — lands in the audit log.
 */
export function mcpV11AuditTimer(
  log: McpV11AuditLog,
  base: Omit<McpV11AuditEntry, 'outcome' | 'durationMs' | 'atMs' | 'errorCode'>,
  startedAtMs: number = Date.now(),
): (outcome: McpV11AuditEntry['outcome'], errorCode?: string) => McpV11AuditEntry {
  return (outcome, errorCode) =>
    log.record({
      ...base,
      outcome,
      ...(errorCode ? { errorCode } : {}),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });
}
