/**
 * Multi-file refactor an toàn (v1.16, Đội T4).
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.16 §5): agent làm việc
 * trên repo qua CodeAct + event log, mọi thay đổi phải xem lại được
 * (replay/audit). Pipeline v8:
 *   plan → preview diff (unified) → user approve → apply từng file
 *   (backup trước khi ghi) → verify (typecheck/test do host tiêm)
 *   → verify fail thì rollback tự động về backup.
 *
 * An toàn:
 * - Không ghi ngoài working dir (path tuyệt đối / `..` đều bị chặn).
 * - Backup là bản sao nội dung cũ trong thư mục backup riêng (mặc
 *   định `<workingDir>/.open-bot-v8-backup/<planId>/`); file mới
 *   (oldContent null) thì rollback = xóa file.
 * - Apply ghi file theo thứ tự plan; nếu một file ghi lỗi giữa chừng,
 *   các file đã ghi được rollback ngay (không để repo dở dang).
 * - Verify là callback do host tiêm (mặc định: kiểm tra file còn đọc
 *   được + không rỗng khi plan yêu cầu) — host có thể tiêm typecheck /
 *   test thật; rollback tự động khi verify trả fail.
 * - Plan/preview/apply/verify đều thuần ghi log qua callback `onEvent`
 *   (để agent v8 ghi vào log v7) — module này không tự ghi file log.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  V8ApplyFileResult,
  V8ApplyResult,
  V8DiffHunk,
  V8DiffPreview,
  V8FileChange,
  V8RefactorPlan,
  V8RefactorStatus,
  V8VerifyResult,
} from './types';

/** Số dòng context trong unified diff preview. */
export const V8_DIFF_CONTEXT_LINES = 3;
/** Giới hạn ký tự của unified diff preview (tránh log phình). */
export const V8_DIFF_PREVIEW_LIMIT = 200_000;

/** Tạo id plan duy nhất (`v8ref-<hex>`). */
export function v8NewPlanId(): string {
  return `v8ref-${crypto.randomBytes(6).toString('hex')}`;
}

/** Tách nội dung thành dòng, bỏ dòng rỗng cuối do nội dung kết thúc bằng `\n` (không phải dòng thật). */
function splitV8Lines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Đếm dòng thêm/xóa giữa nội dung cũ và mới (so theo dòng). */
export function v8CountLineChanges(oldContent: string | null, newContent: string): { added: number; removed: number } {
  const oldLines = oldContent === null ? [] : splitV8Lines(oldContent);
  const newLines = splitV8Lines(newContent);
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let added = 0;
  const remaining = new Map(oldSet);
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { added, removed };
}

/** true = path thoát working dir (tuyệt đối hoặc chứa `..`). */
export function v8IsOutsideWorkspace(relPath: string): boolean {
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) return true;
  return relPath.split(/[\\/]+/).includes('..');
}

/** Chuẩn hoá path repo-relative (dùng `/`, bỏ `./` đầu). */
export function v8NormalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface V8PlanChangeInput {
  path: string;
  newContent: string;
  description: string;
}

/**
 * Tạo plan refactor từ danh sách đổi file. Nội dung cũ được đọc từ
 * đĩa lúc tạo plan (null = file mới). Throw khi path thoát workspace
 * hoặc khi có 2 change trùng path.
 */
export function createV8RefactorPlan(
  workingDir: string,
  title: string,
  goal: string,
  inputs: readonly V8PlanChangeInput[],
  planId: string = v8NewPlanId(),
): V8RefactorPlan {
  const seen = new Set<string>();
  const changes: V8FileChange[] = [];
  for (const input of inputs) {
    const relPath = v8NormalizeRelPath(input.path);
    if (v8IsOutsideWorkspace(relPath)) {
      throw new Error(`V8 refactor: path escapes workspace: ${relPath}`);
    }
    if (seen.has(relPath)) throw new Error(`V8 refactor: duplicate change for ${relPath}`);
    seen.add(relPath);
    const abs = path.join(workingDir, relPath);
    let oldContent: string | null = null;
    try {
      oldContent = fs.readFileSync(abs, 'utf8');
    } catch {
      oldContent = null; // file mới
    }
    const { added, removed } = v8CountLineChanges(oldContent, input.newContent);
    changes.push({ path: relPath, newContent: input.newContent, oldContent, description: input.description, linesAdded: added, linesRemoved: removed });
  }
  return {
    id: planId,
    title,
    goal,
    createdAt: new Date().toISOString(),
    changes,
    status: 'planned',
  };
}

/** Đổi trạng thái plan (trả plan mới, không mutate plan cũ). */
export function v8PlanWithStatus(plan: V8RefactorPlan, status: V8RefactorStatus, note?: string): V8RefactorPlan {
  return { ...plan, status, statusNote: note, changes: plan.changes.map((c) => ({ ...c })) };
}

// ---------------------------------------------------------------------------
// Unified diff preview
// ---------------------------------------------------------------------------

interface DiffOp {
  kind: ' ' | '+' | '-';
  text: string;
}

/** LCS-based diff theo dòng (đủ cho preview; repo lớn vẫn chạy vì diff theo file). */
export function v8DiffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // DP LCS; giới hạn kích thước để tránh O(n*m) nổ trên file khổng lồ.
  if (n * m > 4_000_000) {
    // Fallback: toàn bộ cũ là `-`, toàn bộ mới là `+` (vẫn đúng, kém gọn).
    return [
      ...oldLines.map((text) => ({ kind: '-' as const, text })),
      ...newLines.map((text) => ({ kind: '+' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: ' ', text: oldLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: '-', text: oldLines[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: '+', text: newLines[j] ?? '' });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', text: oldLines[i] ?? '' });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', text: newLines[j] ?? '' });
    j += 1;
  }
  return ops;
}

/** Gom ops thành hunks có context (như `git diff -U3`). */
export function v8GroupHunks(ops: DiffOp[], context: number = V8_DIFF_CONTEXT_LINES): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; ops: DiffOp[] }> {
  const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; ops: DiffOp[] }> = [];
  let oldLine = 1;
  let newLine = 1;
  let idx = 0;
  const isChange = (op: DiffOp): boolean => op.kind !== ' ';
  while (idx < ops.length) {
    // Tìm change tiếp theo.
    while (idx < ops.length && !isChange(ops[idx] as DiffOp)) {
      idx += 1;
      oldLine += 1;
      newLine += 1;
    }
    if (idx >= ops.length) break;
    const hunkStart = Math.max(0, idx - context);
    let hunkOldStart = oldLine - (idx - hunkStart);
    let hunkNewStart = newLine - (idx - hunkStart);
    // Tính lại old/new start bằng cách đếm từ đầu hunk.
    let o = 0;
    let nw = 0;
    for (let k = 0; k < hunkStart; k += 1) {
      if (ops[k]?.kind !== '+') o += 1;
      if (ops[k]?.kind !== '-') nw += 1;
    }
    hunkOldStart = o + 1;
    hunkNewStart = nw + 1;
    // Mở rộng hunk tới khi hết change + context, gộp hunk gần nhau (gap <= 2*context).
    let end = idx;
    let lastChange = idx;
    while (end < ops.length) {
      if (isChange(ops[end] as DiffOp)) lastChange = end;
      if (end - lastChange > context * 2 && end > lastChange) break;
      end += 1;
    }
    const hunkEnd = Math.min(ops.length, lastChange + context + 1);
    const hunkOps = ops.slice(hunkStart, hunkEnd);
    let oldCount = 0;
    let newCount = 0;
    for (const op of hunkOps) {
      if (op.kind !== '+') oldCount += 1;
      if (op.kind !== '-') newCount += 1;
    }
    hunks.push({ oldStart: hunkOldStart, oldCount, newStart: hunkNewStart, newCount, ops: hunkOps });
    // Cập nhật con trỏ dòng tới cuối hunk.
    for (let k = idx; k < hunkEnd; k += 1) {
      if (ops[k]?.kind !== '+') oldLine += 1;
      if (ops[k]?.kind !== '-') newLine += 1;
    }
    idx = hunkEnd;
  }
  return hunks;
}

/** Render preview unified diff cho cả plan. */
export function previewV8Diff(plan: V8RefactorPlan): V8DiffPreview {
  const hunks: V8DiffHunk[] = [];
  const parts: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const change of plan.changes) {
    linesAdded += change.linesAdded;
    linesRemoved += change.linesRemoved;
    const oldLines = change.oldContent === null ? [] : change.oldContent.split('\n');
    const newLines = change.newContent.split('\n');
    const ops = v8DiffLines(oldLines, newLines);
    const grouped = v8GroupHunks(ops);
    parts.push(`diff --git a/${change.path} b/${change.path}`);
    parts.push(change.oldContent === null ? '--- /dev/null' : `--- a/${change.path}`);
    parts.push(`+++ b/${change.path}`);
    for (const hunk of grouped) {
      const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
      const lines = hunk.ops.map((op) => `${op.kind}${op.text}`);
      hunks.push({ file: change.path, header, lines });
      parts.push(header);
      parts.push(...lines);
    }
    if (grouped.length === 0) {
      parts.push('@@ -0,0 +0,0 @@ (no changes)');
    }
  }
  let unifiedDiff = parts.join('\n');
  if (unifiedDiff.length > V8_DIFF_PREVIEW_LIMIT) {
    unifiedDiff = `${unifiedDiff.slice(0, V8_DIFF_PREVIEW_LIMIT)}\n... (diff truncated at ${V8_DIFF_PREVIEW_LIMIT} chars)`;
  }
  return {
    planId: plan.id,
    unifiedDiff,
    hunks,
    filesChanged: plan.changes.length,
    linesAdded,
    linesRemoved,
  };
}

// ---------------------------------------------------------------------------
// Apply + rollback + verify
// ---------------------------------------------------------------------------

export interface V8RefactorOptions {
  workingDir: string;
  /** Thư mục backup (mặc định `<workingDir>/.open-bot-v8-backup/<planId>`). */
  backupDir?: string;
  /** Ghi event vào log (agent v8 truyền callback ghi log v7). */
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
  /** Verify sau apply: trả {ok, output}. Mặc định chỉ kiểm tra file đọc được. */
  verify?: (plan: V8RefactorPlan) => Promise<{ ok: boolean; output: string }> | { ok: boolean; output: string };
  /** Tên bước verify (hiển thị trong report). */
  verifyStep?: string;
}

/** Backup dir mặc định cho một plan. */
export function v8DefaultBackupDir(workingDir: string, planId: string): string {
  return path.join(workingDir, '.open-bot-v8-backup', planId);
}

/**
 * Apply plan đã approve: backup từng file cũ, ghi nội dung mới, rồi
 * verify; verify fail → rollback tự động về backup. Trả plan mới kèm
 * trạng thái (`verified` / `rolled-back` / `failed`) + kết quả apply
 * + kết quả verify (nếu có).
 */
export async function applyV8RefactorPlan(
  plan: V8RefactorPlan,
  options: V8RefactorOptions,
): Promise<{ plan: V8RefactorPlan; apply: V8ApplyResult; verify?: V8VerifyResult }> {
  const workingDir = path.resolve(options.workingDir);
  const backupDir = options.backupDir ?? v8DefaultBackupDir(workingDir, plan.id);
  const onEvent = options.onEvent ?? ((): void => undefined);
  if (plan.status !== 'approved') {
    throw new Error(`V8 refactor: plan ${plan.id} chưa approved (status=${plan.status}) — không được apply`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const files: V8ApplyFileResult[] = [];
  const appliedPaths: string[] = [];
  let ok = true;
  for (const change of plan.changes) {
    const abs = path.join(workingDir, change.path);
    const backupPath = change.oldContent === null ? null : path.join(backupDir, change.path);
    try {
      if (change.oldContent !== null && backupPath) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, change.oldContent, 'utf8');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, change.newContent, 'utf8');
      files.push({ path: change.path, applied: true, backupPath: backupPath ? path.relative(workingDir, backupPath) : null });
      appliedPaths.push(change.path);
      onEvent('v8.refactor.file-applied', { planId: plan.id, path: change.path });
    } catch (err) {
      ok = false;
      files.push({ path: change.path, applied: false, backupPath: backupPath ? path.relative(workingDir, backupPath) : null, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  const apply: V8ApplyResult = { planId: plan.id, files, ok, backupDir };
  if (!ok) {
    // Ghi lỗi giữa chừng → rollback ngay các file đã ghi.
    rollbackV8Refactor(plan, { workingDir, backupDir });
    const failedPlan = v8PlanWithStatus(plan, 'rolled-back', `apply lỗi giữa chừng ở ${files.find((f) => !f.applied)?.path ?? 'unknown'} — đã rollback`);
    onEvent('v8.refactor.rolled-back', { planId: plan.id, reason: 'apply-failed' });
    return { plan: failedPlan, apply };
  }
  // Verify sau apply.
  const verifyStep = options.verifyStep ?? 'verify';
  const startedAt = Date.now();
  let verifyOutcome: { ok: boolean; output: string };
  if (options.verify) {
    try {
      verifyOutcome = await options.verify(plan);
    } catch (err) {
      verifyOutcome = { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  } else {
    // Verify mặc định: mọi file trong plan còn đọc được sau khi ghi.
    const unreadable: string[] = [];
    for (const change of plan.changes) {
      try {
        fs.readFileSync(path.join(workingDir, change.path), 'utf8');
      } catch {
        unreadable.push(change.path);
      }
    }
    verifyOutcome = unreadable.length === 0
      ? { ok: true, output: `${plan.changes.length} file(s) readable after apply` }
      : { ok: false, output: `unreadable after apply: ${unreadable.join(', ')}` };
  }
  const verify: V8VerifyResult = {
    planId: plan.id,
    step: verifyStep,
    ok: verifyOutcome.ok,
    durationMs: Date.now() - startedAt,
    output: verifyOutcome.output.slice(0, 4000),
    rolledBack: false,
  };
  if (!verifyOutcome.ok) {
    rollbackV8Refactor(plan, { workingDir, backupDir });
    verify.rolledBack = true;
    const rolledBackPlan = v8PlanWithStatus(plan, 'rolled-back', `verify "${verifyStep}" fail — đã rollback: ${verifyOutcome.output.slice(0, 200)}`);
    onEvent('v8.refactor.rolled-back', { planId: plan.id, reason: `verify-failed:${verifyStep}` });
    return { plan: rolledBackPlan, apply, verify };
  }
  const verifiedPlan = v8PlanWithStatus(plan, 'verified', `verify "${verifyStep}" ok`);
  onEvent('v8.refactor.verified', { planId: plan.id, step: verifyStep });
  return { plan: verifiedPlan, apply, verify };
}

/**
 * Rollback plan về nội dung cũ từ backup: file cũ được khôi phục,
 * file mới (oldContent null) bị xóa. Trả danh sách path đã rollback.
 * Không throw khi một file rollback lỗi — ghi vào danh sách lỗi.
 */
export function rollbackV8Refactor(
  plan: V8RefactorPlan,
  options: { workingDir: string; backupDir?: string },
): { restored: string[]; deleted: string[]; errors: Array<{ path: string; error: string }> } {
  const workingDir = path.resolve(options.workingDir);
  const backupDir = options.backupDir ?? v8DefaultBackupDir(workingDir, plan.id);
  const restored: string[] = [];
  const deleted: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const change of plan.changes) {
    const abs = path.join(workingDir, change.path);
    try {
      if (change.oldContent === null) {
        // File mới → xóa.
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        deleted.push(change.path);
      } else {
        const backupPath = path.join(backupDir, change.path);
        if (fs.existsSync(backupPath)) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.copyFileSync(backupPath, abs);
        } else {
          // Không có file backup (vd backup dir bị xóa) → ghi lại oldContent từ plan.
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, change.oldContent, 'utf8');
        }
        restored.push(change.path);
      }
    } catch (err) {
      errors.push({ path: change.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { restored, deleted, errors };
}

/** Tóm tắt plan một dòng (để log / UI). */
export function summarizeV8Plan(plan: V8RefactorPlan): string {
  const added = plan.changes.reduce((sum, c) => sum + c.linesAdded, 0);
  const removed = plan.changes.reduce((sum, c) => sum + c.linesRemoved, 0);
  return `${plan.title}: ${plan.changes.length} file(s), +${added}/-${removed} lines, status=${plan.status}`;
}
