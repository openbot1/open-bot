/**
 * Subagent worktree isolation — context firewall (v1.07, Đội T6).
 *
 * Ý tưởng học từ Claude Code 2026 (survey v1.07 §2): giá trị lớn nhất
 * của subagent không phải song song mà là CÔ LẬP CONTEXT — subagent
 * chạy trong context riêng, cô lập bằng git worktree: child làm trên
 * worktree riêng, trả về tên branch. Parent chỉ nhận kết quả nén, không
 * nhận hàng trăm tool call làm bẩn context của mình.
 *
 * Module này làm đúng 3 việc đó, và không làm gì thêm:
 * 1. PLAN worktree: validate tên branch (luật git), tính đường dẫn
 *    worktree (nằm NGOÀI repo root — worktree lồng trong repo sẽ bị
 *    git theo dõi nhầm và làm bẩn cây làm việc), chặn path traversal.
 * 2. CHẠY git qua executor tiêm vào: `git worktree add/remove/list`
 *    — executor thật do caller cung cấp (child_process), test dùng
 *    executor giả ghi lại argv. Module không spawn process trực tiếp
 *    nên test được mà không cần repo git thật.
 * 3. CONTEXT FIREWALL: nén hàng trăm tool call của child thành bảng
 *    đếm theo tool + tóm tắt, đóng gói vào ReturnEnvelope (branch +
 *    tóm tắt + artifact + số liệu) — parent CHỈ nhận envelope này.
 *    `detectPathEscape` phát hiện child chạm file ngoài worktree.
 *
 * Worktree KHÔNG thay thế sandbox/permission: nó chỉ cô lập cây làm
 * việc git. Quyền đọc/ghi vẫn do host + egress policy quyết định.
 */

import * as path from 'node:path';

/** Tên branch tối đa 100 ký tự (git cho phép dài hơn, nhưng tên dài gây lỗi đường dẫn trên Windows). */
export const MAX_BRANCH_NAME_LENGTH = 100;

/** Số tool call tối đa giữ lại chi tiết trong envelope (còn lại chỉ đếm). */
export const MAX_TOOL_CALL_DETAILS = 20;

/** Kế hoạch tạo worktree cho một subagent child. */
export interface WorktreePlan {
  /** Đường dẫn tuyệt đối tới repo gốc (nơi chạy `git worktree add`). */
  repoRoot: string;
  /** Tên branch child sẽ làm việc (đã validate theo luật git). */
  branch: string;
  /** Branch gốc để rẽ ra (mặc định: HEAD của repo). */
  baseBranch: string;
  /** Đường dẫn tuyệt đối tới worktree mới (nằm NGOÀI repoRoot). */
  worktreePath: string;
  /** Argv đầy đủ cho `git worktree add` (để host/executor chạy hoặc log). */
  gitArgs: string[];
}

/** Input tạo worktree plan. */
export interface PlanWorktreeInput {
  repoRoot: string;
  branch: string;
  /** Branch gốc — vắng = HEAD. */
  baseBranch?: string;
  /**
   * Thư mục cha chứa worktree — vắng = thư mục cha của repoRoot
   * (worktree thành thư mục ANH EM của repo). Phải tuyệt đối.
   */
  worktreeParent?: string;
  /**
   * Tên thư mục worktree — vắng = `<tên-repo>-<branch-slug>`.
   * Chỉ dùng khi caller muốn tên rõ ràng (vd test).
   */
  worktreeDirName?: string;
}

/** Kết quả chạy một lệnh git qua executor. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  /** Exit code (0 = thành công). */
  exitCode: number;
}

/** Executor chạy git — caller tiêm (child_process thật hoặc giả lập test). */
export type GitExecutor = (args: string[], opts: { cwd: string }) => Promise<GitExecResult>;

/** Một worktree đang tồn tại (parse từ `git worktree list --porcelain`). */
export interface ExistingWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
}

/**
 * Validate tên branch theo luật git-check-ref-format (bản rút gọn đủ
 * chặn lỗi thường gặp). Sai → throw với lý do cụ thể, không echo
 * nguyên tên branch dài độc hại.
 */
export function validateBranchName(branch: string): string {
  if (typeof branch !== 'string' || branch.trim().length === 0) {
    throw new Error('tên branch không được rỗng.');
  }
  const name = branch.trim();
  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    throw new Error(`tên branch dài quá ${MAX_BRANCH_NAME_LENGTH} ký tự.`);
  }
  if (name.startsWith('-') || name.startsWith('/')) {
    throw new Error('tên branch không được bắt đầu bằng "-" hoặc "/".');
  }
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    throw new Error('tên branch không được kết thúc bằng "/", "." hoặc ".lock".');
  }
  if (name.includes('..')) throw new Error('tên branch không được chứa "..".');
  if (name.includes('@{')) throw new Error('tên branch không được chứa "@{".');
  if (/[ ~^:?*[\\]/.test(name)) {
    throw new Error('tên branch không được chứa ký tự " ~ ^ : ? * [ \\".');
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('tên branch không được chứa ký tự điều khiển.');
  }
  // Không được chứa `//` (component rỗng) — git từ chối.
  if (name.includes('//')) throw new Error('tên branch không được chứa "//".');
  return name;
}

/** Slug hoá branch để làm tên thư mục: `feature/foo` → `feature-foo`. */
export function branchToDirSlug(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'worktree';
}

/**
 * Lập kế hoạch worktree: validate branch, tính đường dẫn worktree là
 * thư mục anh em của repo (ngoài repoRoot), chặn traversal. Worktree
 * nằm TRONG repoRoot → throw (worktree lồng sẽ bị git theo dõi nhầm).
 */
export function planWorktree(input: PlanWorktreeInput): WorktreePlan {
  if (typeof input.repoRoot !== 'string' || !path.isAbsolute(input.repoRoot)) {
    throw new Error('planWorktree cần repoRoot là đường dẫn tuyệt đối.');
  }
  const branch = validateBranchName(input.branch);
  const baseBranch =
    typeof input.baseBranch === 'string' && input.baseBranch.trim().length > 0
      ? input.baseBranch.trim()
      : 'HEAD';
  if (baseBranch !== 'HEAD') validateBranchName(baseBranch);
  const parent =
    typeof input.worktreeParent === 'string' && input.worktreeParent.trim().length > 0
      ? path.resolve(input.worktreeParent)
      : path.dirname(path.resolve(input.repoRoot));
  if (!path.isAbsolute(parent)) throw new Error('worktreeParent phải là đường dẫn tuyệt đối.');
  const dirName =
    typeof input.worktreeDirName === 'string' && input.worktreeDirName.trim().length > 0
      ? input.worktreeDirName.trim()
      : `${path.basename(path.resolve(input.repoRoot))}-${branchToDirSlug(branch)}`;
  if (dirName.includes('/') || dirName.includes('\\') || dirName === '.' || dirName === '..') {
    throw new Error('worktreeDirName không được chứa dấu phân cách đường dẫn.');
  }
  const repoRoot = path.resolve(input.repoRoot);
  const worktreePath = path.join(parent, dirName);
  const rel = path.relative(repoRoot, worktreePath);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('worktree phải nằm NGOÀI repo root — worktree lồng trong repo sẽ làm bẩn cây làm việc.');
  }
  if (path.resolve(worktreePath) === repoRoot) {
    throw new Error('worktree không được trùng repo root.');
  }
  return {
    repoRoot,
    branch,
    baseBranch,
    worktreePath,
    gitArgs: ['worktree', 'add', worktreePath, '-b', branch, baseBranch],
  };
}

/**
 * Tạo worktree thật qua executor: chạy `git worktree add <path> -b
 * <branch> <base>` trong repoRoot. Exit != 0 → throw kèm stderr (cắt
 * ngắn 500 ký tự, không echo toàn bộ output).
 */
export async function createWorktree(
  executor: GitExecutor,
  plan: WorktreePlan,
): Promise<WorktreePlan> {
  const result = await executor(plan.gitArgs, { cwd: plan.repoRoot });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`git worktree add thất bại (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
  return plan;
}

/**
 * Xoá worktree qua executor: `git worktree remove --force <path>`.
 * Exit != 0 → throw (worktree có thay đổi chưa commit vẫn xoá được
 * nhờ --force — caller chịu trách nhiệm đã gom kết quả trước).
 */
export async function removeWorktree(
  executor: GitExecutor,
  plan: WorktreePlan,
): Promise<void> {
  const result = await executor(['worktree', 'remove', '--force', plan.worktreePath], {
    cwd: plan.repoRoot,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`git worktree remove thất bại (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Parse output `git worktree list --porcelain` thành danh sách
 * worktree. Dòng `bare`/`detached` là cờ; `branch` vắng = detached.
 */
export function parseWorktreeListPorcelain(output: string): ExistingWorktree[] {
  const worktrees: ExistingWorktree[] = [];
  let current: ExistingWorktree | null = null;
  const flush = (): void => {
    if (current) worktrees.push(current);
    current = null;
  };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length), branch: null, head: null, bare: false, detached: false };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length) || null;
    } else if (line.startsWith('branch ') && current) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'bare' && current) {
      current.bare = true;
    } else if (line === 'detached' && current) {
      current.detached = true;
    }
  }
  flush();
  return worktrees;
}

/** Liệt kê worktree hiện có của repo qua executor. */
export async function listWorktrees(
  executor: GitExecutor,
  repoRoot: string,
): Promise<ExistingWorktree[]> {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    throw new Error('listWorktrees cần repoRoot là đường dẫn tuyệt đối.');
  }
  const result = await executor(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`git worktree list thất bại (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
  return parseWorktreeListPorcelain(result.stdout);
}

// ---------------------------------------------------------------------------
// Context firewall: parent chỉ nhận envelope nén, không nhận tool call thô.
// ---------------------------------------------------------------------------

/** Một tool call thô của child (chỉ dùng để nén — không bao giờ gửi thẳng cho parent). */
export interface ChildToolCall {
  tool: string;
  /** Đường dẫn file tool chạm tới (nếu có) — để phát hiện path escape. */
  path?: string;
  /** Thời gian chạy (ms). */
  durationMs?: number;
  /** true khi tool call lỗi. */
  failed?: boolean;
}

/** Bảng đếm tool call đã nén theo tool. */
export interface ToolCallSummary {
  tool: string;
  calls: number;
  failed: number;
  totalMs: number;
}

/**
 * Nén danh sách tool call thô thành bảng đếm theo tool (nhiều nhất
 * trước) + tổng số. Đây là phần duy nhất về tool call được phép lọt
 * qua firewall — chi tiết từng call bị vứt.
 */
export function summarizeToolCalls(calls: ChildToolCall[]): {
  total: number;
  failed: number;
  totalMs: number;
  byTool: ToolCallSummary[];
} {
  const byTool = new Map<string, ToolCallSummary>();
  let total = 0;
  let failed = 0;
  let totalMs = 0;
  for (const call of calls) {
    if (!call || typeof call.tool !== 'string' || call.tool.trim().length === 0) continue;
    total += 1;
    const ms = Number.isFinite(call.durationMs) ? Math.max(0, call.durationMs as number) : 0;
    totalMs += ms;
    if (call.failed) failed += 1;
    const key = call.tool.trim();
    const entry = byTool.get(key) ?? { tool: key, calls: 0, failed: 0, totalMs: 0 };
    entry.calls += 1;
    if (call.failed) entry.failed += 1;
    entry.totalMs += ms;
    byTool.set(key, entry);
  }
  const sorted = [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  return { total, failed, totalMs, byTool: sorted };
}

/**
 * Phát hiện child chạm file NGOÀI worktree của nó: mỗi path trong
 * tool call phải nằm trong worktreePath (hoặc là đường dẫn tương đối
 * — quy về worktree). Trả danh sách path vi phạm (đã chuẩn hoá).
 * Path ngoài worktree KHÔNG tự động là ác ý (vd đọc file hệ thống),
 * nhưng phải được parent thấy rõ trước khi tin kết quả.
 */
export function detectPathEscape(
  calls: ChildToolCall[],
  worktreePath: string,
): string[] {
  const root = path.resolve(worktreePath);
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (!call || typeof call.path !== 'string' || call.path.trim().length === 0) continue;
    const resolved = path.isAbsolute(call.path)
      ? path.resolve(call.path)
      : path.resolve(root, call.path);
    const rel = path.relative(root, resolved);
    const outside = rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
    if (outside && !seen.has(resolved)) {
      seen.add(resolved);
      violations.push(resolved);
    }
  }
  return violations;
}

/** Envelope trả về của child — thứ DUY NHẤT parent nhận qua firewall. */
export interface SubagentReturnEnvelope {
  /** Tên branch child đã làm việc (parent checkout/merge từ đây). */
  branch: string;
  /** Đường dẫn worktree child đã làm việc. */
  worktreePath: string;
  /** Trạng thái cuối: done / failed / partial. */
  status: 'done' | 'failed' | 'partial';
  /** Tóm tắt nén (vài trăm ký tự) — KHÔNG chứa log tool call thô. */
  summary: string;
  /** Artifact tạo ra (đường dẫn tương đối trong worktree / tên file). */
  artifacts: string[];
  /** Số liệu tool call đã nén (chỉ đếm, không chi tiết từng call). */
  toolCalls: { total: number; failed: number; totalMs: number; byTool: ToolCallSummary[] };
  /** Path ngoài worktree child đã chạm (nếu có) — parent quyết định có tin không. */
  pathEscapes: string[];
  /** Số tool call thô đã nén qua firewall (để parent biết mình KHÔNG thấy gì). */
  rawToolCallsHidden: number;
  durationMs: number;
  error?: string;
}

/** Input xây envelope từ kết quả thô của child. */
export interface BuildReturnEnvelopeInput {
  plan: WorktreePlan;
  status: 'done' | 'failed' | 'partial';
  summary: string;
  artifacts?: string[];
  toolCalls?: ChildToolCall[];
  durationMs: number;
  error?: string;
}

/**
 * Xây envelope trả về: nén tool call, phát hiện path escape, cắt
 * summary còn tối đa 2000 ký tự. Envelope validate được: branch hợp
 * lệ, summary không rỗng khi done, artifact là chuỗi.
 */
export function buildReturnEnvelope(input: BuildReturnEnvelopeInput): SubagentReturnEnvelope {
  const branch = validateBranchName(input.plan.branch);
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    throw new Error('return envelope cần summary không rỗng.');
  }
  if (input.status === 'done' && input.summary.trim().length < 10) {
    throw new Error('envelope done cần summary ít nhất 10 ký tự — tóm tắt quá ngắn không đủ để parent tin.');
  }
  const calls = Array.isArray(input.toolCalls) ? input.toolCalls : [];
  const summarized = summarizeToolCalls(calls);
  return {
    branch,
    worktreePath: input.plan.worktreePath,
    status: input.status,
    summary: input.summary.trim().slice(0, 2000),
    artifacts: (input.artifacts ?? []).filter((a) => typeof a === 'string' && a.trim().length > 0),
    toolCalls: summarized,
    pathEscapes: detectPathEscape(calls, input.plan.worktreePath),
    rawToolCallsHidden: calls.length,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    ...(input.error ? { error: input.error } : {}),
  };
}

/** Validate envelope đã parse (vd envelope đọc từ file/queue); sai → throw. */
export function validateReturnEnvelope(raw: unknown): SubagentReturnEnvelope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('return envelope phải là object.');
  }
  const e = raw as Record<string, unknown>;
  const branch = validateBranchName(String(e.branch ?? ''));
  if (typeof e.worktreePath !== 'string' || !path.isAbsolute(e.worktreePath)) {
    throw new Error('return envelope cần worktreePath tuyệt đối.');
  }
  const statuses = ['done', 'failed', 'partial'];
  if (typeof e.status !== 'string' || !statuses.includes(e.status)) {
    throw new Error('return envelope cần status hợp lệ (done/failed/partial).');
  }
  if (typeof e.summary !== 'string' || e.summary.trim().length === 0) {
    throw new Error('return envelope cần summary không rỗng.');
  }
  if (!Array.isArray(e.artifacts) || e.artifacts.some((a) => typeof a !== 'string')) {
    throw new Error('return envelope artifacts phải là mảng chuỗi.');
  }
  if (typeof e.toolCalls !== 'object' || e.toolCalls === null) {
    throw new Error('return envelope cần toolCalls đã nén.');
  }
  if (!Array.isArray(e.pathEscapes) || e.pathEscapes.some((p) => typeof p !== 'string')) {
    throw new Error('return envelope pathEscapes phải là mảng chuỗi.');
  }
  if (typeof e.rawToolCallsHidden !== 'number' || e.rawToolCallsHidden < 0) {
    throw new Error('return envelope cần rawToolCallsHidden >= 0.');
  }
  if (typeof e.durationMs !== 'number' || e.durationMs < 0) {
    throw new Error('return envelope cần durationMs >= 0.');
  }
  return {
    branch,
    worktreePath: e.worktreePath as string,
    status: e.status as SubagentReturnEnvelope['status'],
    summary: e.summary as string,
    artifacts: e.artifacts as string[],
    toolCalls: e.toolCalls as SubagentReturnEnvelope['toolCalls'],
    pathEscapes: e.pathEscapes as string[],
    rawToolCallsHidden: e.rawToolCallsHidden as number,
    durationMs: e.durationMs as number,
    ...(typeof e.error === 'string' && e.error ? { error: e.error } : {}),
  };
}

/**
 * Render envelope thành markdown ngắn để parent đọc / đưa vào context
 * của mình. Chỉ chứa thông tin đã nén — không bao giờ chứa log tool
 * call thô.
 */
export function formatReturnEnvelope(envelope: SubagentReturnEnvelope): string {
  const lines: string[] = [
    `## Subagent trả về — branch \`${envelope.branch}\``,
    ``,
    `Trạng thái: ${envelope.status} · ${envelope.durationMs}ms · ${envelope.toolCalls.total} tool call (${envelope.toolCalls.failed} lỗi) qua firewall — ${envelope.rawToolCallsHidden} call thô đã nén, parent không thấy chi tiết.`,
    ``,
    envelope.summary,
    ``,
  ];
  if (envelope.artifacts.length > 0) {
    lines.push(`Artifact: ${envelope.artifacts.join(', ')}`);
    lines.push(``);
  }
  if (envelope.toolCalls.byTool.length > 0) {
    lines.push(`Tool call (đã nén): ${envelope.toolCalls.byTool.map((t) => `${t.tool}×${t.calls}${t.failed > 0 ? ` (${t.failed} lỗi)` : ''}`).join(', ')}`);
    lines.push(``);
  }
  if (envelope.pathEscapes.length > 0) {
    lines.push(`⚠️ Child đã chạm file NGOÀI worktree (${envelope.pathEscapes.length}): ${envelope.pathEscapes.slice(0, 5).join(', ')}${envelope.pathEscapes.length > 5 ? '…' : ''} — kiểm tra trước khi tin kết quả.`);
    lines.push(``);
  }
  if (envelope.error) {
    lines.push(`Lỗi: ${envelope.error}`);
    lines.push(``);
  }
  lines.push(`Worktree: \`${envelope.worktreePath}\` — merge từ branch \`${envelope.branch}\` khi đã duyệt.`);
  return lines.join('\n').trim();
}
