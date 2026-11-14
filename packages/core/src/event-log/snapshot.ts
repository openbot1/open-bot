/**
 * Snapshot trạng thái đã fold của run log (v1.04, Đội T4).
 *
 * Ý tưởng học từ OpenHands V1 SDK (xem `docs/repo-survey-v104.md`):
 * conversation là stream event bất biến, trạng thái là hàm thuần của
 * dãy event — nên trạng thái đã fold tại một seq có thể chụp lại thành
 * snapshot, rồi lần sau chỉ cần fold PHẦN ĐUÔI (tail) lên snapshot thay
 * vì fold lại toàn bộ log.
 *
 * - Snapshot KHÔNG thay thế log: log trên đĩa vẫn là source of truth
 *   duy nhất, append-only, hash chain nguyên vẹn. Snapshot chỉ là
 *   cache trạng thái có kiểm chứng (digest SHA-256 của trạng thái đã
 *   fold) — snapshot sai digest thì bị từ chối, không bao giờ dùng.
 * - `createRunSnapshot`: fold prefix 1..upToSeq, ghi file JSON
 *   `<logDir>/snapshots/<runId>@<seq>.snapshot.json` (ghi atomic:
 *   tmp + rename).
 * - `restoreRunState`: nạp snapshot (kiểm chứng digest của chính nó),
 *   fold phần đuôi sau upToSeq, gộp bằng `mergeReplayedStates`, trả
 *   trạng thái đã khôi phục. Nhanh hơn fold toàn bộ khi log dài và
 *   snapshot gần cuối log.
 * - `verifyRestoredState`: kiểm chứng độc lập — fold toàn bộ log rồi
 *   so digest với trạng thái đã restore. Dùng trong test và khi cần
 *   chắc chắn tuyệt đối (vd sau khi sửa code fold).
 *
 * Giới hạn nói rõ (không giấu):
 * - Redaction xuyên biên snapshot: marker `event.redacted` nằm ở tail
 *   mà trỏ tới event trong prefix đã snapshot thì KHÔNG được áp ngược
 *   vào trạng thái đã fold (fold của tail chỉ che trong tail). Khi đó
 *   restore lệch so với fold toàn bộ — `verifyRestoredState` bắt được
 *   (digest khác) và caller phải fallback sang fold toàn bộ. Thực tế
 *   redaction hiếm, và snapshot thường chụp sau khi log đã ổn định.
 * - `tokensUsed` của event `run.completed`/`run.failed` là TỔNG của
 *   cả run (xem `replay.ts`): merge dùng đúng giá trị đó khi tail có
 *   terminal event mang `tokensUsed`, thay vì cộng dồn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { digestReplayState } from './canonical';
import { foldEvents } from './replay';
import { safeRunFileName, type RunLogStore } from './store';
import type { AnyRunEvent, ReplayedRunState, RunStatus } from './types';

/** Phiên bản format file snapshot (tăng khi đổi schema). */
export const RUN_SNAPSHOT_VERSION = 1;

/** Thư mục con chứa snapshot trong logDir. */
export const RUN_SNAPSHOTS_DIR = 'snapshots';

/** Hậu tố file snapshot. */
export const RUN_SNAPSHOT_SUFFIX = '.snapshot.json';

/**
 * Một snapshot trạng thái đã fold của run, tại `upToSeq` (bao gồm).
 * `state.digest` phải bằng `digest` — load kiểm chứng lại.
 */
export interface RunSnapshot {
  version: number;
  runId: string;
  /** Seq cuối cùng mà snapshot bao phủ (bao gồm). 0 = snapshot rỗng. */
  upToSeq: number;
  createdAt: string;
  /** Digest SHA-256 của `state` (tính bằng `digestReplayState`). */
  digest: string;
  /** Số event đã fold để tạo snapshot (= upToSeq khi log không xoay lỗi). */
  eventCount: number;
  state: ReplayedRunState;
}

/** Metadata tóm tắt của một snapshot (đọc từ file, không fold lại). */
export interface RunSnapshotMeta {
  runId: string;
  upToSeq: number;
  createdAt: string;
  digest: string;
  eventCount: number;
  filePath: string;
}

/** Tùy chọn tạo/đọc snapshot. */
export interface RunSnapshotOptions {
  /** Ghi đè thư mục snapshot (mặc định `<logDir>/snapshots`). */
  snapshotsDir?: string;
  /** Ghi đè thời gian tạo (chủ yếu cho test). */
  at?: string;
}

/** Kết quả tạo snapshot. */
export interface CreateRunSnapshotResult {
  snapshot: RunSnapshot;
  filePath: string;
}

/** Kết quả khôi phục trạng thái từ snapshot + tail. */
export interface RestoreRunStateResult {
  runId: string;
  /** Trạng thái đã khôi phục (snapshot + tail đã fold). */
  state: ReplayedRunState;
  /** Snapshot đã dùng. */
  snapshot: RunSnapshot;
  /** Số event ở tail (sau upToSeq) đã fold thêm. */
  tailEvents: number;
  /** Digest của trạng thái đã khôi phục (tính lại sau merge). */
  digest: string;
}

/** Tên file snapshot cho một run tại một seq. */
export function snapshotFileName(runId: string, upToSeq: number): string {
  const base = safeRunFileName(runId).replace(/\.jsonl$/, '');
  return `${base}@${upToSeq}${RUN_SNAPSHOT_SUFFIX}`;
}

/** Thư mục snapshot của một store (mặc định `<logDir>/snapshots`). */
export function snapshotsDirFor(store: RunLogStore, runId: string, opts: RunSnapshotOptions = {}): string {
  if (opts.snapshotsDir !== undefined) return opts.snapshotsDir;
  return path.join(path.dirname(store.runFilePath(runId)), RUN_SNAPSHOTS_DIR);
}

/** Đường dẫn file snapshot. */
export function snapshotFilePath(
  store: RunLogStore,
  runId: string,
  upToSeq: number,
  opts: RunSnapshotOptions = {},
): string {
  return path.join(snapshotsDirFor(store, runId, opts), snapshotFileName(runId, upToSeq));
}

/**
 * Chụp snapshot trạng thái đã fold của run tại `upToSeq` (mặc định =
 * seq cuối cùng hiện có). Ném lỗi khi run không có event nào (trừ
 * upToSeq = 0 — snapshot rỗng hợp lệ, dùng làm điểm bắt đầu).
 */
export function createRunSnapshot(
  store: RunLogStore,
  runId: string,
  opts: RunSnapshotOptions & { upToSeq?: number } = {},
): CreateRunSnapshotResult {
  const { events } = store.readRun(runId);
  const totalSeq = events.length === 0 ? 0 : events[events.length - 1]!.seq;
  const upToSeq = opts.upToSeq ?? totalSeq;
  if (!Number.isInteger(upToSeq) || upToSeq < 0 || upToSeq > totalSeq) {
    throw new Error(`upToSeq ${upToSeq} ngoài khoảng 0..${totalSeq} của run ${runId}.`);
  }
  if (events.length === 0 && upToSeq !== 0) {
    throw new Error(`Không snapshot được: run ${runId} chưa có event nào.`);
  }
  const prefix = events.filter((e) => e.seq <= upToSeq);
  const state = foldEvents(runId, prefix);
  const snapshot: RunSnapshot = {
    version: RUN_SNAPSHOT_VERSION,
    runId,
    upToSeq,
    createdAt: opts.at ?? new Date().toISOString(),
    digest: state.digest,
    eventCount: prefix.length,
    state,
  };
  const dir = snapshotsDirFor(store, runId, opts);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = snapshotFilePath(store, runId, upToSeq, opts);
  // Ghi atomic: tmp + rename (không để file snapshot dở dang).
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return { snapshot, filePath };
}

/** Kiểm chứng một snapshot đã parse: version/runId/digest khớp. */
export function verifySnapshotObject(snapshot: unknown, runId: string): snapshot is RunSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const s = snapshot as Partial<RunSnapshot>;
  if (s.version !== RUN_SNAPSHOT_VERSION) return false;
  if (s.runId !== runId) return false;
  if (typeof s.upToSeq !== 'number' || typeof s.digest !== 'string') return false;
  if (!s.state || typeof s.state !== 'object') return false;
  // Digest tính lại từ state phải khớp digest đã lưu — snapshot bị sửa
  // tay (hoặc ghi dở) thì rớt ngay tại đây.
  return digestReplayState(stripStateDigest(s.state)) === s.digest;
}

/** Bỏ field `digest` khỏi state để tính lại digest (như `foldEvents`). */
function stripStateDigest(state: ReplayedRunState): Omit<ReplayedRunState, 'digest'> {
  const { digest: _digest, ...rest } = state;
  return rest;
}

/**
 * Nạp snapshot của run tại `upToSeq` (mặc định = snapshot mới nhất —
 * upToSeq cao nhất). Ném lỗi khi không có snapshot, file hỏng, sai
 * version/runId, hoặc digest không khớp (snapshot không đáng tin).
 */
export function loadRunSnapshot(
  store: RunLogStore,
  runId: string,
  opts: RunSnapshotOptions & { upToSeq?: number } = {},
): RunSnapshot {
  let filePath: string;
  if (opts.upToSeq !== undefined) {
    filePath = snapshotFilePath(store, runId, opts.upToSeq, opts);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Không có snapshot của run ${runId} tại seq ${opts.upToSeq}.`);
    }
  } else {
    const metas = listRunSnapshots(store, runId, opts);
    if (metas.length === 0) {
      throw new Error(`Không có snapshot nào của run ${runId}.`);
    }
    filePath = metas[metas.length - 1]!.filePath;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Snapshot ${filePath} hỏng (không parse được JSON): ${(err as Error).message}`);
  }
  if (!verifySnapshotObject(parsed, runId)) {
    throw new Error(`Snapshot ${filePath} không hợp lệ (sai version/runId/digest) — từ chối dùng.`);
  }
  return parsed;
}

/** Liệt kê snapshot của run, theo upToSeq tăng dần (bỏ file hỏng). */
export function listRunSnapshots(
  store: RunLogStore,
  runId: string,
  opts: RunSnapshotOptions = {},
): RunSnapshotMeta[] {
  const dir = snapshotsDirFor(store, runId, opts);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const metas: RunSnapshotMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(RUN_SNAPSHOT_SUFFIX)) continue;
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RunSnapshot>;
      if (parsed.runId !== runId || typeof parsed.upToSeq !== 'number') continue;
      metas.push({
        runId,
        upToSeq: parsed.upToSeq,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
        digest: typeof parsed.digest === 'string' ? parsed.digest : '',
        eventCount: typeof parsed.eventCount === 'number' ? parsed.eventCount : 0,
        filePath,
      });
    } catch {
      continue;
    }
  }
  metas.sort((a, b) => a.upToSeq - b.upToSeq);
  return metas;
}

/** Xoá snapshot tại một seq. Trả true khi đã xoá file. */
export function deleteRunSnapshot(
  store: RunLogStore,
  runId: string,
  upToSeq: number,
  opts: RunSnapshotOptions = {},
): boolean {
  const filePath = snapshotFilePath(store, runId, upToSeq, opts);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Giữ lại `keepLatest` snapshot mới nhất của run, xoá phần còn lại.
 * Trả số file đã xoá.
 */
export function pruneRunSnapshots(
  store: RunLogStore,
  runId: string,
  keepLatest = 1,
  opts: RunSnapshotOptions = {},
): number {
  const metas = listRunSnapshots(store, runId, opts);
  if (metas.length <= keepLatest) return 0;
  const stale = metas.slice(0, metas.length - keepLatest);
  let deleted = 0;
  for (const meta of stale) {
    if (deleteRunSnapshot(store, runId, meta.upToSeq, opts)) deleted += 1;
  }
  return deleted;
}

/** Gợi ý từ tail event cho `mergeReplayedStates` (tính từ tail thật). */
export interface TailMergeHints {
  /** `tokensUsed` TỔNG của run, khi tail có event kết thúc mang nó. */
  terminalTokensUsed?: number;
  /**
   * Trạng thái cuối mà tail fold suy ra, KHI tail chứa event đổi trạng
   * thái (run.paused/resumed/completed/failed/aborted). Không set =
   * tail không đổi trạng thái → giữ trạng thái của base.
   */
  tailStatus?: RunStatus;
}

/** Tính `TailMergeHints` từ tail event thật (dùng trong restore). */
export function tailMergeHints(tail: readonly AnyRunEvent[]): TailMergeHints {
  const hints: TailMergeHints = {};
  for (const event of tail) {
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      const p = event.payload as { tokensUsed?: unknown };
      if (typeof p.tokensUsed === 'number') hints.terminalTokensUsed = p.tokensUsed;
      hints.tailStatus = event.type === 'run.completed' ? 'completed' : 'failed';
    } else if (event.type === 'run.aborted') {
      hints.tailStatus = 'aborted';
    } else if (event.type === 'run.paused') {
      hints.tailStatus = 'paused';
    } else if (event.type === 'run.resumed') {
      hints.tailStatus = 'running';
    }
  }
  return hints;
}

/**
 * Gộp trạng thái đã fold của tail lên trạng thái base (snapshot).
 *
 * - transcript/fileChanges/compileErrors/errors/compactions/
 *   stuckDetections/redactedSeqs: nối (tail sau base).
 * - toolCalls: gộp theo callId — tail bổ sung status/output/duration
 *   cho call đã bắt đầu ở base (vd resume: tool.call ở tail, model
 *   response ở base), call mới thì thêm vào.
 * - prompt/botId/startedAt: tail có thì lấy tail, không thì giữ base.
 * - status: tail đổi trạng thái (xem `TailMergeHints.tailStatus`) thì
 *   lấy tail, không thì giữ base. endedAt theo tail khi tail kết thúc.
 * - steps: max (step là số tuyệt đối trong log). tokensUsed: cộng dồn,
 *   trừ khi tail có terminal tokensUsed (tổng cả run) thì dùng nó.
 * - digest: tính lại từ trạng thái đã gộp.
 *
 * Xem giới hạn redaction xuyên biên trong doc đầu file.
 */
export function mergeReplayedStates(
  base: ReplayedRunState,
  tail: ReplayedRunState,
  hints: TailMergeHints = {},
): ReplayedRunState {
  const toolById = new Map<string, (typeof base.toolCalls)[number]>();
  const toolCalls = base.toolCalls.map((c) => ({ ...c, argKeys: [...c.argKeys] }));
  for (const c of toolCalls) toolById.set(c.callId, c);
  for (const tc of tail.toolCalls) {
    const existing = toolById.get(tc.callId);
    if (existing) {
      if (tc.status !== undefined) existing.status = tc.status;
      if (tc.outputPreview !== undefined) existing.outputPreview = tc.outputPreview;
      if (tc.durationMs !== undefined) existing.durationMs = tc.durationMs;
    } else {
      const copy = { ...tc, argKeys: [...tc.argKeys] };
      toolCalls.push(copy);
      toolById.set(tc.callId, copy);
    }
  }
  const merged: Omit<ReplayedRunState, 'digest'> = {
    runId: base.runId,
    botId: tail.botId !== '' ? tail.botId : base.botId,
    status: hints.tailStatus !== undefined ? hints.tailStatus : base.status,
    prompt: tail.prompt !== '' ? tail.prompt : base.prompt,
    transcript: [...base.transcript, ...tail.transcript],
    toolCalls,
    fileChanges: [...base.fileChanges, ...tail.fileChanges],
    compileErrors: [...base.compileErrors, ...tail.compileErrors],
    errors: [...base.errors, ...tail.errors],
    steps: Math.max(base.steps, tail.steps),
    tokensUsed:
      hints.terminalTokensUsed !== undefined
        ? hints.terminalTokensUsed
        : base.tokensUsed + tail.tokensUsed,
    startedAt: base.startedAt !== '' ? base.startedAt : tail.startedAt,
    ...(tail.endedAt !== undefined
      ? { endedAt: tail.endedAt }
      : base.endedAt !== undefined
        ? { endedAt: base.endedAt }
        : {}),
    redactedSeqs: [...new Set([...(base.redactedSeqs ?? []), ...(tail.redactedSeqs ?? [])])].sort((a, b) => a - b),
    compactions: [...(base.compactions ?? []), ...(tail.compactions ?? [])],
    stuckDetections: [...(base.stuckDetections ?? []), ...(tail.stuckDetections ?? [])],
  };
  return { ...merged, digest: digestReplayState(merged) };
}

/**
 * Khôi phục trạng thái run từ snapshot + tail.
 *
 * 1. Nạp snapshot (mặc định mới nhất) — digest của snapshot được kiểm
 *    chứng trong `loadRunSnapshot`, snapshot hỏng thì ném lỗi.
 * 2. Fold phần đuôi (event sau upToSeq) rồi gộp lên snapshot.
 * 3. Trả trạng thái đã gộp kèm digest tính lại.
 *
 * Không fold toàn bộ log (đó là việc của `verifyRestoredState`).
 */
export function restoreRunState(
  store: RunLogStore,
  runId: string,
  opts: RunSnapshotOptions & { upToSeq?: number } = {},
): RestoreRunStateResult {
  const snapshot = loadRunSnapshot(store, runId, opts);
  const { events } = store.readRun(runId);
  const tail = events.filter((e) => e.seq > snapshot.upToSeq);
  const tailState = foldEvents(runId, tail);
  const state = mergeReplayedStates(snapshot.state, tailState, tailMergeHints(tail));
  return { runId, state, snapshot, tailEvents: tail.length, digest: state.digest };
}

/**
 * Kiểm chứng độc lập trạng thái đã restore: fold toàn bộ log rồi so
 * digest với trạng thái restore. True = restore khớp fold toàn bộ.
 * Dùng trong test và khi nghi ngờ redaction xuyên biên snapshot.
 */
export function verifyRestoredState(
  store: RunLogStore,
  runId: string,
  restored: ReplayedRunState,
): boolean {
  const { events } = store.readRun(runId);
  return foldEvents(runId, events).digest === restored.digest;
}
