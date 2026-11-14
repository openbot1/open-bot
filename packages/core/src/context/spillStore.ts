/**
 * Disk spill store — overflow for the 1M-token window manager
 * (context engineering v2, v1.05 Team T4).
 *
 * The window manager keeps segments in RAM up to a byte budget.
 * Past that budget the least important segments spill to disk:
 * each spilled segment becomes one JSON file (`<id>.json`, mode
 * 0600) under a spill directory, and the manager keeps only the
 * segment metadata (id, kind, tokens) in memory. A spilled segment
 * can be restored on demand (`restore`), listed, or dropped
 * outright. Writes are atomic (temp + rename); a corrupt file
 * restores as a miss, never a crash.
 *
 * The store knows nothing about context semantics — it stores
 * opaque JSON payloads keyed by segment id, so the window manager
 * stays the only place that decides *what* spills.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One spilled segment on disk (payload is caller-defined JSON). */
export interface SpilledSegment {
  id: string;
  spilledAt: string;
  /** Byte size of the payload file. */
  bytes: number;
  payload: unknown;
}

export class SpillStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** File path for one segment id (ids are sanitised to a safe name). */
  filePathFor(id: string): string {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /** Spill a payload to disk; returns the byte size written. */
  spill(id: string, payload: unknown): number {
    fs.mkdirSync(this.dir, { recursive: true });
    const record: SpilledSegment = {
      id,
      spilledAt: new Date().toISOString(),
      bytes: 0,
      payload,
    };
    const text = JSON.stringify(record);
    record.bytes = Buffer.byteLength(text, 'utf8');
    const tmp = `${this.filePathFor(id)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, this.filePathFor(id));
    return record.bytes;
  }

  /** Restore a spilled segment (null when absent or corrupt). */
  restore(id: string): SpilledSegment | null {
    try {
      const raw = fs.readFileSync(this.filePathFor(id), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as SpilledSegment;
      if (record.id !== id || typeof record.payload === 'undefined') return null;
      return record;
    } catch {
      return null;
    }
  }

  /** True when a segment is on disk. */
  has(id: string): boolean {
    return fs.existsSync(this.filePathFor(id));
  }

  /** Delete a spilled segment (no-op when absent). */
  drop(id: string): void {
    try {
      fs.unlinkSync(this.filePathFor(id));
    } catch {
      // Absent is fine.
    }
  }

  /** Ids of all spilled segments (file order). */
  list(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    } catch {
      return [];
    }
  }

  /** Total bytes on disk across spilled segments. */
  totalBytes(): number {
    let total = 0;
    for (const id of this.list()) {
      try {
        total += fs.statSync(this.filePathFor(id)).size;
      } catch {
        // File vanished between list and stat; ignore.
      }
    }
    return total;
  }

  /** Delete every spilled segment. */
  clear(): void {
    for (const id of this.list()) this.drop(id);
  }
}
