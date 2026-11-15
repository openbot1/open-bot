/**
 * Agent Teams v2 — fork subagent (v1.10, Đội T3).
 *
 * Fork subagent: teammate spawn subagent con với context riêng
 * (việc cụ thể, tách khỏi context cha), subagent làm xong thì
 * merge kết quả về parent — tóm tắt + artifact (ý tưởng Claude
 * Code fork subagents, survey v1.10 §2).
 *
 * - Mỗi fork là một node trong cây: parentTaskId (task cha), có
 *   thể parentForkId (fork lồng nhau), depth = 1 cho fork trực
 *   tiếp, +1 mỗi tầng.
 * - Giới hạn độ sâu (mặc định 3) + giới hạn song song (mặc định
 *   5, tối đa 20): vượt là lỗi rõ ràng, không tự ý cắt bớt.
 * - Merge: fork done → lead/teammate gọi merge, tóm tắt + artifact
 *   của fork được gom vào kết quả task cha; fork chuyển sang
 *   'merged', không merge 2 lần.
 * - Thuần logic trên mảng fork truyền vào (không I/O): service
 *   giữ mảng trong TeamV2State và lưu disk; test không cần fs.
 */

import { newTeamId } from '../types';
import {
  ABSOLUTE_MAX_CONCURRENT_FORKS,
  DEFAULT_MAX_CONCURRENT_FORKS,
  DEFAULT_MAX_FORK_DEPTH,
  type ForkMergeResult,
  type ForkNode,
  type ForkStatus,
} from './types';

/** Kết quả một thao tác fork. */
export type ForkResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): ForkResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): ForkResult<T> {
  return { ok: false, error };
}

/** Input spawn fork mới. */
export interface SpawnForkInput {
  teamId: string;
  /** Task cha mà fork phục vụ. */
  parentTaskId: string;
  /** Fork cha (khi fork lồng nhau). */
  parentForkId?: string;
  /** Tên/mục đích ngắn của fork. */
  name: string;
  /** Context riêng của fork: việc nó phải làm. */
  task: string;
  spawnedById: string;
  spawnedByName: string;
}

/** Giới hạn fork (độ sâu + song song). */
export interface ForkLimits {
  maxDepth?: number;
  maxConcurrent?: number;
}

/** Độ sâu của fork cha (0 = không có fork cha → fork mới depth 1). */
export function forkDepthOf(forks: ForkNode[], parentForkId?: string): number {
  if (!parentForkId) return 1;
  const parent = forks.find((f) => f.id === parentForkId);
  if (!parent) return 1;
  return parent.depth + 1;
}

/** Số fork đang chạy (status running). */
export function runningForkCount(forks: ForkNode[]): number {
  return forks.filter((f) => f.status === 'running').length;
}

/** Validate spawn fork: tên/task, fork cha tồn tại + đang chạy, độ sâu, song song. */
export function validateSpawnFork(
  forks: ForkNode[],
  input: SpawnForkInput,
  limits: ForkLimits = {},
): string[] {
  const errors: string[] = [];
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_FORK_DEPTH;
  const maxConcurrent = limits.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_FORKS;
  if (!input.name.trim()) errors.push('Tên fork không được rỗng.');
  if (!input.task.trim()) errors.push('Việc của fork không được rỗng.');
  if (input.task.length > 8000) errors.push('Việc của fork tối đa 8000 ký tự.');
  let parentDepth = 0;
  if (input.parentForkId) {
    const parent = forks.find((f) => f.id === input.parentForkId);
    if (!parent) errors.push(`Fork cha không tồn tại: ${input.parentForkId}.`);
    else {
      parentDepth = parent.depth;
      if (parent.status !== 'running') {
        errors.push(`Fork cha "${parent.name}" đang ở trạng thái ${parent.status}, không fork thêm được.`);
      }
    }
  }
  if (parentDepth + 1 > maxDepth) {
    errors.push(`Vượt độ sâu fork tối đa ${maxDepth} (fork này sẽ ở tầng ${parentDepth + 1}).`);
  }
  if (runningForkCount(forks) >= maxConcurrent) {
    errors.push(`Đã chạy ${runningForkCount(forks)}/${maxConcurrent} fork song song tối đa — chờ fork xong rồi spawn tiếp.`);
  }
  if (maxConcurrent > ABSOLUTE_MAX_CONCURRENT_FORKS) {
    errors.push(`maxConcurrent tối đa ${ABSOLUTE_MAX_CONCURRENT_FORKS}.`);
  }
  return errors;
}

/** Spawn fork mới (chưa chèn vào danh sách — caller chèn + lưu). */
export function createFork(
  forks: ForkNode[],
  input: SpawnForkInput,
  limits: ForkLimits = {},
  now = Date.now(),
): ForkResult<ForkNode> {
  const errors = validateSpawnFork(forks, input, limits);
  if (errors.length > 0) return fail(errors.join(' '));
  const fork: ForkNode = {
    id: newTeamId('fork'),
    teamId: input.teamId,
    parentTaskId: input.parentTaskId,
    parentForkId: input.parentForkId,
    depth: forkDepthOf(forks, input.parentForkId),
    name: input.name.trim(),
    task: input.task.trim(),
    spawnedById: input.spawnedById,
    spawnedByName: input.spawnedByName,
    status: 'running',
    artifacts: [],
    merged: false,
    createdAt: now,
    updatedAt: now,
  };
  return ok(fork);
}

/** Fork xong: ghi tóm tắt + artifact (chỉ fork running mới xong được). */
export function completeFork(
  forks: ForkNode[],
  forkId: string,
  resultSummary: string,
  artifacts: string[] = [],
  tokensUsed?: number,
  now = Date.now(),
): ForkResult<{ forks: ForkNode[]; fork: ForkNode }> {
  const idx = forks.findIndex((f) => f.id === forkId);
  if (idx === -1) return fail(`Không tìm thấy fork ${forkId}.`);
  const fork = forks[idx];
  if (fork.status !== 'running') {
    return fail(`Fork "${fork.name}" đang ở trạng thái ${fork.status}, không xong được.`);
  }
  if (!resultSummary.trim()) return fail('Tóm tắt kết quả của fork không được rỗng.');
  const cleanArtifacts = [...new Set(artifacts.map((a) => a.trim()).filter(Boolean))].slice(0, 50);
  const done: ForkNode = {
    ...fork,
    status: 'done',
    resultSummary: resultSummary.trim(),
    artifacts: cleanArtifacts,
    tokensUsed,
    finishedAt: now,
    updatedAt: now,
  };
  const next = [...forks];
  next[idx] = done;
  return ok({ forks: next, fork: done });
}

/** Fork lỗi: ghi lỗi, chuyển error (chỉ fork running mới lỗi được). */
export function failFork(
  forks: ForkNode[],
  forkId: string,
  error: string,
  now = Date.now(),
): ForkResult<{ forks: ForkNode[]; fork: ForkNode }> {
  const idx = forks.findIndex((f) => f.id === forkId);
  if (idx === -1) return fail(`Không tìm thấy fork ${forkId}.`);
  const fork = forks[idx];
  if (fork.status !== 'running') {
    return fail(`Fork "${fork.name}" đang ở trạng thái ${fork.status}, không fail được.`);
  }
  const failed: ForkNode = {
    ...fork,
    status: 'error',
    error: error.trim() || 'Không rõ lỗi.',
    finishedAt: now,
    updatedAt: now,
  };
  const next = [...forks];
  next[idx] = failed;
  return ok({ forks: next, fork: failed });
}

/**
 * Merge kết quả fork về task cha: chỉ fork done + chưa merge mới
 * merge được. Trả về fork đã merge (status 'merged') + đoạn tóm
 * tắt để caller ghi thêm vào resultSummary của task cha.
 */
export function mergeFork(
  forks: ForkNode[],
  forkId: string,
  now = Date.now(),
): ForkResult<{ forks: ForkNode[]; fork: ForkNode; merge: ForkMergeResult }> {
  const idx = forks.findIndex((f) => f.id === forkId);
  if (idx === -1) return fail(`Không tìm thấy fork ${forkId}.`);
  const fork = forks[idx];
  if (fork.status !== 'done') {
    return fail(`Fork "${fork.name}" đang ở trạng thái ${fork.status}, chỉ merge fork đã done.`);
  }
  if (fork.merged) return fail(`Fork "${fork.name}" đã merge rồi, không merge 2 lần.`);
  const merged: ForkNode = { ...fork, status: 'merged', merged: true, updatedAt: now };
  const next = [...forks];
  next[idx] = merged;
  const artifactPart =
    fork.artifacts.length > 0 ? ` Artifact: ${fork.artifacts.join(', ')}.` : '';
  const merge: ForkMergeResult = {
    forkId: fork.id,
    parentTaskId: fork.parentTaskId,
    mergedSummary: `[fork ${fork.name}] ${fork.resultSummary ?? ''}${artifactPart}`,
    artifacts: [...fork.artifacts],
  };
  return ok({ forks: next, fork: merged, merge });
}

/** Fork của một task cha (kèm fork con lồng nhau qua parentTaskId). */
export function forksForTask(forks: ForkNode[], parentTaskId: string): ForkNode[] {
  return forks
    .filter((f) => f.parentTaskId === parentTaskId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Fork con trực tiếp của một fork (để UI vẽ cây). */
export function childForks(forks: ForkNode[], parentForkId: string): ForkNode[] {
  return forks
    .filter((f) => f.parentForkId === parentForkId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Fork đang chạy của một teammate (để giới hạn + UI hiển thị). */
export function runningForksByTeammate(forks: ForkNode[], teammateId: string): ForkNode[] {
  return forks.filter((f) => f.spawnedById === teammateId && f.status === 'running');
}

/** Đếm fork theo trạng thái. */
export function countForksByStatus(forks: ForkNode[]): Record<ForkStatus, number> {
  const counts: Record<ForkStatus, number> = { running: 0, done: 0, error: 0, merged: 0 };
  for (const fork of forks) counts[fork.status] += 1;
  return counts;
}

/** Fork done nhưng chưa merge (lead cần merge về task cha). */
export function unmergedForks(forks: ForkNode[]): ForkNode[] {
  return forks.filter((f) => f.status === 'done' && !f.merged);
}

/** Tóm tắt cây fork của một task (để merge hàng loạt khi task cha xong). */
export function summarizeForksForParent(forks: ForkNode[], parentTaskId: string): string {
  const related = forksForTask(forks, parentTaskId).filter(
    (f) => f.status === 'done' || f.status === 'merged',
  );
  if (related.length === 0) return '';
  const lines = related.map((f) => `[fork ${f.name}] ${f.resultSummary ?? ''}`);
  return lines.join('\n');
}
