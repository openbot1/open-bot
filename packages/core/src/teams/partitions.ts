/**
 * Agent Teams v1 — file partitions + worktrees (v1.09, Đội T1).
 *
 * Mỗi teammate làm việc trong vùng file riêng để không giẫm chân
 * nhau: hoặc một thư mục (partition, tiền tố đường dẫn), hoặc một
 * worktree git riêng (branch riêng, thư mục riêng ngoài repo).
 * Module này phát hiện xung đột: partition chồng nhau, hai teammate
 * chạm cùng file, task chạm file ngoài partition của owner.
 *
 * Thuần tính toán, KHÔNG chạy git, KHÔNG chạm filesystem: lập kế
 * hoạch worktree (validate branch, tính đường dẫn) để host quyết
 * định khi nào tạo worktree thật — cùng mẫu `planWorktree` của
 * fleet v1.07. Việc ghi file thật do runner/host làm sau.
 */

import {
  fileInPartition,
  normalizePartitionPrefix,
  partitionsOverlap,
  type AgentTeamV109,
  type FileConflict,
  type Teammate,
  type TeamTask,
} from './types';

/** Kết quả kiểm tra (hợp lệ hoặc danh sách lỗi). */
export interface PartitionCheck {
  ok: boolean;
  errors: string[];
  conflicts: FileConflict[];
}

/** Validate tên branch git: cấm ký tự git không cho phép + quy tắc cơ bản. */
export function validateTeamBranchName(branch: string): string[] {
  const errors: string[] = [];
  if (!branch.trim()) {
    errors.push('Tên branch không được rỗng.');
    return errors;
  }
  const b = branch.trim();
  if (b.length > 200) errors.push('Tên branch tối đa 200 ký tự.');
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.')) {
    errors.push('Tên branch không được bắt đầu bằng -, /, kết thúc bằng / hoặc .');
  }
  if (b.includes('..') || b.includes(' ') || b.includes('~') || b.includes('^') || b.includes(':')) {
    errors.push('Tên branch không được chứa "..", khoảng trắng, "~", "^", ":".');
  }
  if (b.includes('//') || b.endsWith('.lock')) {
    errors.push('Tên branch không được chứa "//" hoặc kết thúc bằng ".lock".');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)) {
    errors.push('Tên branch chỉ gồm chữ, số, ".", "_", "-" và "/".');
  }
  return errors;
}

/** Kế hoạch worktree cho một teammate: branch + đường dẫn thư mục. */
export interface TeammateWorktreePlan {
  teammateId: string;
  teammateName: string;
  branch: string;
  /** Đường dẫn worktree (ngoài repo root, cùng cấp với repo). */
  worktreePath: string;
  /** Repo gốc mà worktree tách ra. */
  repoRoot: string;
}

/**
 * Lập kế hoạch worktree cho teammate: branch `teams/<team-slug>/<mate-slug>`,
 * đường dẫn `<parent-of-repo>/<repo-name>-<team-slug>-<mate-slug>`.
 * Chỉ tính toán — không tạo thư mục, không chạy git.
 */
export function planTeammateWorktree(
  team: AgentTeamV109,
  teammate: Teammate,
  repoRoot: string,
): { ok: boolean; plan?: TeammateWorktreePlan; errors?: string[] } {
  const teamSlug = team.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'team';
  const mateSlug = teammate.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'mate';
  const branch = `teams/${teamSlug}/${mateSlug}`;
  const branchErrors = validateTeamBranchName(branch);
  if (branchErrors.length > 0) return { ok: false, errors: branchErrors };
  const root = repoRoot.replace(/\/+$/, '');
  const repoName = root.split('/').pop() || 'repo';
  const parent = root.split('/').slice(0, -1).join('/') || '.';
  const worktreePath = `${parent}/${repoName}-${teamSlug}-${mateSlug}`;
  return { ok: true, plan: { teammateId: teammate.id, teammateName: teammate.name, branch, worktreePath, repoRoot: root } };
}

/** Hai partition có chồng nhau không (trả về cặp teammate chồng nhau). */
export function findOverlappingPartitions(teammates: Teammate[]): { a: Teammate; b: Teammate }[] {
  const out: { a: Teammate; b: Teammate }[] = [];
  const withPartition = teammates.filter((m) => m.partition && normalizePartitionPrefix(m.partition));
  for (let i = 0; i < withPartition.length; i++) {
    for (let j = i + 1; j < withPartition.length; j++) {
      const a = withPartition[i];
      const b = withPartition[j];
      if (partitionsOverlap(a.partition as string, b.partition as string)) {
        out.push({ a, b });
      }
    }
  }
  return out;
}

/**
 * Phát hiện xung đột file trong team: hai task đang active (claimed /
 * in-progress) chạm cùng file, hoặc hai partition chồng nhau.
 * Trả về danh sách xung đột (rỗng = không có xung đột).
 */
export function detectFileConflicts(team: AgentTeamV109): FileConflict[] {
  const conflicts: FileConflict[] = [];
  const now = Date.now();
  // 1. Partition chồng nhau.
  for (const { a, b } of findOverlappingPartitions(team.teammates)) {
    conflicts.push({
      file: a.partition as string,
      taskIds: [],
      teammateIds: [a.id, b.id],
      kind: 'overlap',
      detectedAt: now,
    });
  }
  // 2. Hai task active chạm cùng file.
  const byFile = new Map<string, { taskIds: string[]; teammateIds: string[] }>();
  for (const task of team.tasks) {
    if (task.status !== 'claimed' && task.status !== 'in-progress') continue;
    if (!task.claimedBy) continue;
    for (const file of task.touchesFiles) {
      const entry = byFile.get(file) ?? { taskIds: [], teammateIds: [] };
      if (!entry.taskIds.includes(task.id)) entry.taskIds.push(task.id);
      if (!entry.teammateIds.includes(task.claimedBy)) entry.teammateIds.push(task.claimedBy);
      byFile.set(file, entry);
    }
  }
  for (const [file, entry] of byFile) {
    if (entry.teammateIds.length > 1) {
      conflicts.push({ file, taskIds: entry.taskIds, teammateIds: entry.teammateIds, kind: 'touch', detectedAt: now });
    }
  }
  return conflicts;
}

/** Task có chạm file ngoài partition của owner không (owner làm lấn vùng người khác). */
export function tasksOutsideOwnerPartition(team: AgentTeamV109): { task: TeamTask; file: string; ownerPartition: string }[] {
  const out: { task: TeamTask; file: string; ownerPartition: string }[] = [];
  const byId = new Map(team.teammates.map((m) => [m.id, m]));
  for (const task of team.tasks) {
    if (!task.claimedBy) continue;
    const owner = byId.get(task.claimedBy);
    if (!owner?.partition) continue;
    for (const file of task.touchesFiles) {
      if (!fileInPartition(file, owner.partition)) {
        out.push({ task, file, ownerPartition: owner.partition });
      }
    }
  }
  return out;
}

/** Kiểm tra toàn diện phân vùng của team: partition chồng + task lấn vùng. */
export function checkPartitions(team: AgentTeamV109): PartitionCheck {
  const errors: string[] = [];
  const conflicts = detectFileConflicts(team);
  for (const c of conflicts) {
    if (c.kind === 'overlap') {
      errors.push(`Partition chồng nhau giữa các teammate tại "${c.file}".`);
    } else {
      errors.push(
        `Xung đột file "${c.file}": ${c.teammateIds.length} teammate cùng chạm (${c.taskIds.join(', ')}).`,
      );
    }
  }
  for (const { task, file, ownerPartition } of tasksOutsideOwnerPartition(team)) {
    errors.push(`Task "${task.title}" chạm file "${file}" ngoài partition "${ownerPartition}" của owner.`);
  }
  return { ok: errors.length === 0, errors, conflicts };
}

/** Gợi ý partition cho teammate mới: tiền tố chưa ai dùng, từ danh sách vùng trống. */
export function suggestPartition(
  teammates: Teammate[],
  candidatePrefixes: string[],
): string | undefined {
  const used = teammates
    .map((m) => (m.partition ? normalizePartitionPrefix(m.partition) : ''))
    .filter(Boolean);
  for (const candidate of candidatePrefixes) {
    const norm = normalizePartitionPrefix(candidate);
    if (!norm) continue;
    const clash = used.some((u) => partitionsOverlap(u, norm));
    if (!clash) return norm;
  }
  return undefined;
}

/** Liệt kê file đang bị khóa bởi task active (file → task giữ + teammate giữ). */
export function activeFileLocks(team: AgentTeamV109): { file: string; taskId: string; teammateId: string }[] {
  const out: { file: string; taskId: string; teammateId: string }[] = [];
  for (const task of team.tasks) {
    if (task.status !== 'claimed' && task.status !== 'in-progress') continue;
    if (!task.claimedBy) continue;
    for (const file of task.touchesFiles) {
      out.push({ file, taskId: task.id, teammateId: task.claimedBy });
    }
  }
  return out;
}
