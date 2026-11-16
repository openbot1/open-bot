/**
 * Composio poll checkpoint store v2 (v1.14, Doi T4).
 *
 * `pollSchedulerV2.ts` da co serialize/parse checkpoint (de resume
 * lich poll sau restart) nhung chua co cho nao LUU checkpoint xuong
 * dia. Module nay la cho do: luu/tai checkpoint cua engine poll v2
 * vao mot file JSON trong `<userData>/composio/` (cung cho voi
 * `pollState.ts` + `connectionLifecycle.ts`).
 *
 * - `JsonFileComposioV114CheckpointStore`: ghi file kieu atomic
 *   (ghi file tam + rename) de app tat giua chung khong lam hong
 *   file checkpoint; moi entry duoc validate truoc khi luu/tai
 *   (checkpoint sai dinh dang thi throw voi thong diep ro, khong
 *   lang le bo qua).
 * - `MemoryComposioV114CheckpointStore`: cung interface nhung giu
 *   trong bo nho — de test + de host nao khong co userData dir.
 * - Ca hai store chi luu id + thoi gian + cursor + seen ids —
 *   KHONG chua secret, KHONG chua key, KHONG chua du lieu event.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseComposioV114Checkpoint,
  serializeComposioV114Checkpoint,
  validateComposioV114Checkpoint,
  type ComposioV114Checkpoint,
} from './pollSchedulerV2';

/** Ten file checkpoint mac dinh trong thu muc composio cua userData. */
export const COMPOSIO_V114_CHECKPOINTS_FILE = 'composio-poll-checkpoints-v114.json';

/** Interface chung cho ca hai store (de host doi store tuy y). */
export interface ComposioV114CheckpointStore {
  /** Luu (ghi de) mot checkpoint theo scheduleId. */
  save(checkpoint: ComposioV114Checkpoint): void;
  /** Luu nhieu checkpoint mot lan (ghi de theo scheduleId). */
  saveAll(checkpoints: readonly ComposioV114Checkpoint[]): void;
  /** Tai mot checkpoint theo scheduleId (undefined neu khong co). */
  load(scheduleId: string): ComposioV114Checkpoint | undefined;
  /** Tai tat ca checkpoint (ban sao). */
  loadAll(): ComposioV114Checkpoint[];
  /** Xoa checkpoint cua mot schedule (true neu co de xoa). */
  remove(scheduleId: string): boolean;
  /** Xoa het checkpoint. */
  clear(): void;
}

/** Kiem tra scheduleId hop le (throw neu rong). */
function assertScheduleId(scheduleId: string): void {
  if (typeof scheduleId !== 'string' || scheduleId.trim() === '') {
    throw new Error('scheduleId must be a non-empty string');
  }
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV114CheckpointStore implements ComposioV114CheckpointStore {
  private readonly checkpoints = new Map<string, ComposioV114Checkpoint>();

  save(checkpoint: ComposioV114Checkpoint): void {
    validateComposioV114Checkpoint(checkpoint);
    this.checkpoints.set(checkpoint.scheduleId, JSON.parse(serializeComposioV114Checkpoint(checkpoint)) as ComposioV114Checkpoint);
  }

  saveAll(checkpoints: readonly ComposioV114Checkpoint[]): void {
    for (const cp of checkpoints) this.save(cp);
  }

  load(scheduleId: string): ComposioV114Checkpoint | undefined {
    assertScheduleId(scheduleId);
    const cp = this.checkpoints.get(scheduleId);
    return cp ? (JSON.parse(serializeComposioV114Checkpoint(cp)) as ComposioV114Checkpoint) : undefined;
  }

  loadAll(): ComposioV114Checkpoint[] {
    return [...this.checkpoints.values()].map(
      (cp) => JSON.parse(serializeComposioV114Checkpoint(cp)) as ComposioV114Checkpoint,
    );
  }

  remove(scheduleId: string): boolean {
    assertScheduleId(scheduleId);
    return this.checkpoints.delete(scheduleId);
  }

  clear(): void {
    this.checkpoints.clear();
  }
}

/** Tuy chon cho file store. */
export interface JsonFileComposioV114CheckpointStoreOptions {
  /** Thu muc chua file checkpoint (vd `<userData>/composio`). */
  dir: string;
  /** Ten file (mac dinh COMPOSIO_V114_CHECKPOINTS_FILE). */
  fileName?: string;
}

/** Duong dan file checkpoint cua store. */
export function getComposioV114CheckpointsPath(dir: string, fileName: string = COMPOSIO_V114_CHECKPOINTS_FILE): string {
  return path.join(dir, fileName);
}

/**
 * Store checkpoint tren dia (file JSON). Ghi atomic: ghi file tam
 * trong cung thu muc roi rename de — app co tat giua chung thi file
 * cu van nguyen. Doc file khong ton tai tra ve [] (chua co checkpoint
 * nao); file hong (JSON sai / entry sai dinh dang) thi throw ro.
 */
export class JsonFileComposioV114CheckpointStore implements ComposioV114CheckpointStore {
  private readonly filePath: string;

  constructor(options: JsonFileComposioV114CheckpointStoreOptions) {
    if (typeof options.dir !== 'string' || options.dir.trim() === '') {
      throw new Error('checkpoint store dir must be a non-empty string');
    }
    this.filePath = getComposioV114CheckpointsPath(options.dir, options.fileName);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  /** Doc tat ca checkpoint tu dia ([]) neu file chua ton tai. */
  loadAll(): ComposioV114Checkpoint[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`checkpoint file is not valid JSON: ${this.filePath}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`checkpoint file must contain an array: ${this.filePath}`);
    }
    const checkpoints: ComposioV114Checkpoint[] = [];
    const seen = new Set<string>();
    for (const entry of parsed as ComposioV114Checkpoint[]) {
      validateComposioV114Checkpoint(entry);
      if (seen.has(entry.scheduleId)) {
        throw new Error(`checkpoint file has duplicate scheduleId: ${entry.scheduleId}`);
      }
      seen.add(entry.scheduleId);
      checkpoints.push(entry);
    }
    return checkpoints;
  }

  load(scheduleId: string): ComposioV114Checkpoint | undefined {
    assertScheduleId(scheduleId);
    return this.loadAll().find((cp) => cp.scheduleId === scheduleId);
  }

  save(checkpoint: ComposioV114Checkpoint): void {
    validateComposioV114Checkpoint(checkpoint);
    const all = this.loadAll().filter((cp) => cp.scheduleId !== checkpoint.scheduleId);
    all.push(checkpoint);
    this.writeAll(all);
  }

  saveAll(checkpoints: readonly ComposioV114Checkpoint[]): void {
    for (const cp of checkpoints) validateComposioV114Checkpoint(cp);
    const byId = new Map<string, ComposioV114Checkpoint>();
    for (const cp of this.loadAll()) byId.set(cp.scheduleId, cp);
    for (const cp of checkpoints) byId.set(cp.scheduleId, cp);
    this.writeAll([...byId.values()]);
  }

  remove(scheduleId: string): boolean {
    assertScheduleId(scheduleId);
    const all = this.loadAll();
    const kept = all.filter((cp) => cp.scheduleId !== scheduleId);
    if (kept.length === all.length) return false;
    this.writeAll(kept);
    return true;
  }

  clear(): void {
    this.writeAll([]);
  }

  /** Ghi mang checkpoint xuong dia (atomic qua file tam + rename). */
  private writeAll(checkpoints: readonly ComposioV114Checkpoint[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(checkpoints, null, 2);
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}

/**
 * Tai checkpoint tu mot store bat ky roi resume schedule (tien ich
 * cho host: khoi phuc engine sau restart chi bang 1 ham).
 * Tra undefined khi store khong co checkpoint cho schedule nay.
 */
export function loadComposioV114CheckpointForSchedule(
  store: ComposioV114CheckpointStore,
  scheduleId: string,
): ComposioV114Checkpoint | undefined {
  assertScheduleId(scheduleId);
  const cp = store.load(scheduleId);
  if (!cp) return undefined;
  return parseComposioV114Checkpoint(serializeComposioV114Checkpoint(cp));
}
