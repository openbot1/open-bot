/**
 * Memory v11 — unified block_history table (v1.11, Doi T1).
 *
 * Y tuong hoc tu Letta git-backed memory (`block_history` table theo
 * doi moi thay doi bat ke backend), viet lai hoan toan cho open-bot.
 *
 * Van de truoc v11: lich su block nam rac o nhieu noi, moi noi mot
 * dang — MemoryBlockStore ghi snapshot vao
 * `memory-blocks-history.jsonl` (v1.02), GitMemoryProjection ghi
 * commit vao repo git rieng + `history.jsonl` (v1.06), v10 giu
 * version rieng trong file memory-v10. Muon tra loi "block nay da
 * thay doi the nao, boi ai, qua backend nao" phai doc ca ba noi.
 *
 * Module nay la BANG LICH SU THONG NHAT: mot file JSONL append-only
 * `.open-bot/memory-block-history.jsonl`, moi dong la mot thay doi
 * (bat ke backend nao goi ghi), co du thong tin de diff va rollback:
 *
 *   BlockHistoryEntry = { id, blockId, label, kind, backend, action,
 *     actor, version, content, description, charLimit, at, note }
 *
 *  - `recordBlockHistoryChange(...)`: ghi mot entry (best-effort nhu
 *    blockHistory goc — ghi lich su hong khong bao gio lam hong
 *    thao tac block chinh).
 *  - `listBlockHistory(...)`: doc lich su mot block (moi nhat truoc),
 *    loc theo backend/action, phan trang limit/offset.
 *  - `diffBlockVersions(...)`: diff giua hai version (dung patch.ts —
 *    LCS theo dong, tra unified diff + so dong them/xoa).
 *  - `rollbackBlockToVersion(...)`: khoi phuc ve version cu — viet
 *    noi dung cu lai thanh version MOI (counter +1) qua
 *    MemoryBlockStore, khong bao gio viet lai lich su; ban than
 *    rollback cung duoc ghi mot entry (action `rollback`).
 *  - `blockHistoryStats(...)`: thong ke nhanh (so entry, so block,
 *    so backend, entry moi nhat) de UI hien thi.
 *
 * Lich su giu toi da 200 entry / block (cu nhat bi cat khi ghi) de
 * file khong phi vo han; cat file ghi atomic (temp + rename).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryBlockStore } from '../blocks';
import type { MemoryBlock } from '../blocks';
import { computeLineDiff, formatUnifiedDiff } from './patch';
import type { TextDiff } from './patch';
import { detectBlockKind } from './blockKinds';
import type { V11BlockKind } from './blockKinds';

export const V11_BLOCK_HISTORY_REL_PATH = path.join(
  '.open-bot',
  'memory-block-history.jsonl',
);
/** So entry toi da giu cho mot block (cu nhat bi cat khi ghi). */
export const V11_BLOCK_HISTORY_PER_BLOCK_KEEP = 200;
/** So entry toi da tra ve trong mot lan doc (chong UI keo ca file). */
export const V11_BLOCK_HISTORY_READ_MAX = 500;

/**
 * Backend da tao ra thay doi — de biet entry nay toi tu dau:
 * `blocks` = MemoryBlockStore goc (v0.96), `git-v7` = GitMemoryProjection,
 * `core-v9` = CoreMemoryManager kieu Letta, `v10` = MemoryManagerV10,
 * `shared-v11` = SharedSupervisor (block chia se), `sleep-v11` =
 * SleepConsolidationAgent (sleep pass), `manual` = ghi tay qua tool/UI.
 */
export type V11HistoryBackend =
  | 'blocks'
  | 'git-v7'
  | 'core-v9'
  | 'v10'
  | 'shared-v11'
  | 'sleep-v11'
  | 'manual';

/** Hanh dong tao ra entry nay. */
export type V11HistoryAction =
  | 'create'
  | 'update'
  | 'replace'
  | 'append'
  | 'insert'
  | 'patch'
  | 'delete'
  | 'restore'
  | 'rollback'
  | 'set-read-only'
  | 'attach'
  | 'detach'
  | 'share'
  | 'consolidate';

/** Mot dong trong bang block_history. */
export interface BlockHistoryEntry {
  id: string;
  blockId: string;
  label: string;
  kind: V11BlockKind;
  backend: V11HistoryBackend;
  action: V11HistoryAction;
  actor: string;
  version: number;
  content: string;
  description: string;
  charLimit: number;
  readOnly: boolean;
  at: string;
  /** Ghi chu ngan (vd ly do rollback, so dong patch). */
  note?: string;
}

/** Input ghi mot entry (id/at tu sinh khi vang). */
export interface RecordHistoryInput {
  blockId: string;
  label: string;
  backend: V11HistoryBackend;
  action: V11HistoryAction;
  actor: string;
  version: number;
  content: string;
  description?: string;
  charLimit?: number;
  readOnly?: boolean;
  note?: string;
  at?: string;
}

/** Loi bang lich su — message tieng Viet. */
export class V11HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V11HistoryError';
  }
}

function historyFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, V11_BLOCK_HISTORY_REL_PATH);
}

/** Chuyen mot block hien tai thanh input ghi lich su (mot backend/action). */
export function historyInputFromBlock(
  block: MemoryBlock,
  backend: V11HistoryBackend,
  action: V11HistoryAction,
  actor: string,
  note?: string,
): RecordHistoryInput {
  return {
    blockId: block.id,
    label: block.label,
    backend,
    action,
    actor,
    version: block.version,
    content: block.content,
    description: block.description,
    charLimit: block.charLimit,
    readOnly: block.readOnly,
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * Ghi mot entry vao bang lich su. Best-effort: ghi hong (vd o dia
 * day) tra false chu khong throw — lich su la de xem lai, khong phai
 * cua chan thao tac block. Ghi xong cat bot entry cu cua cung block
 * ve muc giu toi da.
 */
export function recordBlockHistoryChange(
  workspaceDir: string,
  input: RecordHistoryInput,
): boolean {
  try {
    const filePath = historyFilePath(workspaceDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const entry: BlockHistoryEntry = {
      id: randomUUID(),
      blockId: input.blockId,
      label: input.label,
      kind: detectBlockKind(input.label),
      backend: input.backend,
      action: input.action,
      actor: input.actor,
      version: input.version,
      content: input.content,
      description: input.description ?? '',
      charLimit: input.charLimit ?? 0,
      readOnly: input.readOnly ?? false,
      at: input.at ?? new Date().toISOString(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    pruneBlockHistoryTable(workspaceDir, input.blockId);
    return true;
  } catch {
    return false;
  }
}

/** Doc toan bo entry hop le trong file (dong hong bi bo qua). */
export function readAllBlockHistoryEntries(workspaceDir: string): BlockHistoryEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(historyFilePath(workspaceDir), 'utf8');
  } catch {
    return [];
  }
  const out: BlockHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as BlockHistoryEntry;
      if (
        parsed &&
        typeof parsed.blockId === 'string' &&
        typeof parsed.version === 'number' &&
        typeof parsed.content === 'string' &&
        typeof parsed.action === 'string'
      ) {
        out.push(parsed);
      }
    } catch {
      // Dong hong — bo qua.
    }
  }
  return out;
}

/** Cat lich su cua mot block ve muc giu toi da (ghi atomic, best-effort). */
export function pruneBlockHistoryTable(workspaceDir: string, blockId: string): void {
  try {
    const filePath = historyFilePath(workspaceDir);
    const all = readAllBlockHistoryEntries(workspaceDir);
    const blockEntries = all.filter((e) => e.blockId === blockId);
    if (blockEntries.length <= V11_BLOCK_HISTORY_PER_BLOCK_KEEP) return;
    const keptIds = new Set(
      blockEntries.slice(-V11_BLOCK_HISTORY_PER_BLOCK_KEEP).map((e) => e.id),
    );
    const kept = all.filter((e) => e.blockId !== blockId || keptIds.has(e.id));
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      kept.map((e) => JSON.stringify(e)).join('\n') + '\n',
      { mode: 0o600 },
    );
    fs.renameSync(tmp, filePath);
  } catch {
    // Cat lich su la best-effort.
  }
}

/** Bo loc khi doc lich su. */
export interface ListBlockHistoryOptions {
  backend?: V11HistoryBackend;
  action?: V11HistoryAction;
  /** So entry toi da (mac dinh 50, toi da V11_BLOCK_HISTORY_READ_MAX). */
  limit?: number;
  /** Bo qua N entry moi nhat (phan trang). */
  offset?: number;
}

/**
 * Lich su cua mot block, moi nhat truoc. Loc theo backend/action neu
 * co; phan trang bang limit/offset. Tra [] khi chua co lich su.
 */
export function listBlockHistory(
  workspaceDir: string,
  blockId: string,
  opts: ListBlockHistoryOptions = {},
): BlockHistoryEntry[] {
  const limit = Math.max(
    1,
    Math.min(V11_BLOCK_HISTORY_READ_MAX, Math.floor(opts.limit ?? 50)),
  );
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const all = readAllBlockHistoryEntries(workspaceDir).filter(
    (e) =>
      e.blockId === blockId &&
      (opts.backend === undefined || e.backend === opts.backend) &&
      (opts.action === undefined || e.action === opts.action),
  );
  // Moi nhat truoc: version giam dan, cung version thi thoi gian giam dan.
  all.sort((a, b) => b.version - a.version || b.at.localeCompare(a.at));
  return all.slice(offset, offset + limit);
}

/** Mot entry theo dung so version, hoac null. */
export function readBlockHistoryVersion(
  workspaceDir: string,
  blockId: string,
  version: number,
): BlockHistoryEntry | null {
  const entries = readAllBlockHistoryEntries(workspaceDir).filter(
    (e) => e.blockId === blockId && e.version === version,
  );
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.at.localeCompare(a.at));
  return entries[0];
}

/** Ket qua diff giua hai version cua cung mot block. */
export interface BlockVersionDiff {
  blockId: string;
  label: string;
  fromVersion: number;
  toVersion: number;
  fromAt: string;
  toAt: string;
  diff: TextDiff;
  unified: string;
}

/**
 * Diff giua hai version cua mot block (dung snapshot trong bang lich
 * su). Version nao khong co trong bang -> throw (khong doan noi dung
 * tu store hien tai — lich su phai noi that).
 */
export function diffBlockVersions(
  workspaceDir: string,
  blockId: string,
  fromVersion: number,
  toVersion: number,
): BlockVersionDiff {
  const from = readBlockHistoryVersion(workspaceDir, blockId, fromVersion);
  if (!from) {
    throw new V11HistoryError(
      `Block "${blockId}" has no history entry for version ${fromVersion}.`,
    );
  }
  const to = readBlockHistoryVersion(workspaceDir, blockId, toVersion);
  if (!to) {
    throw new V11HistoryError(
      `Block "${blockId}" has no history entry for version ${toVersion}.`,
    );
  }
  const diff = computeLineDiff(from.content, to.content);
  return {
    blockId,
    label: to.label,
    fromVersion,
    toVersion,
    fromAt: from.at,
    toAt: to.at,
    diff,
    unified: formatUnifiedDiff(to.label, from.content, to.content),
  };
}

/** Ket qua rollback ve mot version cu. */
export interface BlockRollbackResult {
  blockId: string;
  label: string;
  fromVersion: number;
  restoredVersion: number;
  newVersion: number;
  content: string;
}

/**
 * Rollback block ve version cu: lay snapshot cu tu bang lich su, ghi
 * lai thanh version MOI qua MemoryBlockStore (khong viet lai lich
 * su), roi ghi them mot entry `rollback` vao bang. Version dich
 * khong co trong bang -> throw. Block read-only -> throw (store chan).
 */
export function rollbackBlockToVersion(
  workspaceDir: string,
  blockId: string,
  version: number,
  actor = 'user',
  blocksStore?: MemoryBlockStore,
): BlockRollbackResult {
  const snapshot = readBlockHistoryVersion(workspaceDir, blockId, version);
  if (!snapshot) {
    throw new V11HistoryError(
      `Block "${blockId}" has no history entry for version ${version} — cannot roll back.`,
    );
  }
  const store = blocksStore ?? new MemoryBlockStore(workspaceDir);
  const current = store.get(blockId);
  if (!current) {
    throw new V11HistoryError(`Block "${blockId}" no longer exists in the block store.`);
  }
  const fromVersion = current.version;
  const restored = store.replace(blockId, snapshot.content, actor);
  recordBlockHistoryChange(
    workspaceDir,
    historyInputFromBlock(restored, 'manual', 'rollback', actor,
      `Rolled back from version ${fromVersion} to version ${version}.`),
  );
  return {
    blockId: restored.id,
    label: restored.label,
    fromVersion,
    restoredVersion: version,
    newVersion: restored.version,
    content: restored.content,
  };
}

/** Thong ke nhanh cua bang lich su (de UI hien thi). */
export interface BlockHistoryStats {
  totalEntries: number;
  blockCount: number;
  backends: Record<string, number>;
  actions: Record<string, number>;
  latestAt: string | null;
}

/** Thong ke toan bang (khong loc theo block). */
export function blockHistoryStats(workspaceDir: string): BlockHistoryStats {
  const all = readAllBlockHistoryEntries(workspaceDir);
  const backends: Record<string, number> = {};
  const actions: Record<string, number> = {};
  const blockIds = new Set<string>();
  let latestAt: string | null = null;
  for (const entry of all) {
    blockIds.add(entry.blockId);
    backends[entry.backend] = (backends[entry.backend] ?? 0) + 1;
    actions[entry.action] = (actions[entry.action] ?? 0) + 1;
    if (latestAt === null || entry.at > latestAt) latestAt = entry.at;
  }
  return { totalEntries: all.length, blockCount: blockIds.size, backends, actions, latestAt };
}
