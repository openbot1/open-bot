/**
 * Delegation sub-agent qua tool call (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands multi-agent delegation (survey v1.14
 * §2): agent cha ủy quyền qua tool call. Nối với `delegation/`
 * của open-bot (v1.04: DelegationSession, lifecycle con, merge
 * concat/summarize/verdict — KHÔNG chạy con, runner do caller tiêm)
 * và `subagents/nested.ts` (v1.01: cây spawn có depth cap + budget
 * chống vòng lặp spawn): v6 thêm ACTION `delegate` làm đầu vào
 * (parse từ tool call / JSON / text), áp budget ngay tại action
 * (maxSteps/timeoutMs/maxTokens + số con tối đa + depth tối đa),
 * và chạy qua `V6SubagentRunner` do host tiêm.
 *
 * Chống vòng lặp delegate: cùng một task đã delegate trong session
 * mà chưa xong thì bị chặn (trả error, không spawn thêm); depth
 * vượt cap thì chặn; timeout thì con bị đánh `timeout` (không chờ
 * vô hạn — dùng Promise.race, kết quả muộn bị bỏ).
 *
 * Merge kết quả nhiều con: `concat` (nối theo tên), `summarize`
 * (lấy dòng đầu + kết luận của mỗi con), `verdict` (gom verdict
 * có cấu trúc, liệt kê xung đột khi các con kết luận khác nhau).
 * Module không gọi model, không đọc event log của con — kết quả
 * con là text runner trả về.
 */

import type { V6DelegateAction, V6DelegateResult, V6SubagentRunner } from './types';

/** Số con tối đa trong một lần delegate (một action). */
export const V6_DELEGATE_MAX_CHILDREN = 5;
/** Depth tối đa của cây delegate (cha = 0). */
export const V6_DELEGATE_MAX_DEPTH = 3;
/** Timeout mặc định của con, ms. */
export const V6_DELEGATE_DEFAULT_TIMEOUT_MS = 120_000;
/** Step tối đa mặc định của con. */
export const V6_DELEGATE_DEFAULT_MAX_STEPS = 20;
/** Token tối đa mặc định của con (ước lượng). */
export const V6_DELEGATE_DEFAULT_MAX_TOKENS = 32_000;

/** Chiến lược hợp nhất kết quả các con. */
export type V6DelegateMergeStrategy = 'concat' | 'summarize' | 'verdict';

/** Việc giao cho MỘT con (đã chuẩn hoá từ action). */
export interface V6DelegateChildInput {
  name: string;
  task: string;
  scope?: string;
  role?: string;
  model?: string;
  timeoutMs: number;
  maxSteps: number;
  maxTokens: number;
}

/** Lỗi ném ra khi delegate không hợp lệ (trước khi spawn). */
export class V6DelegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V6DelegateError';
  }
}

/**
 * Chuẩn hoá một action `delegate` thành input cho con: đặt tên mặc
 * định (`delegate-1`), điền budget mặc định, validate giới hạn.
 * `depth` là depth của cha (0 = agent gốc); vượt cap thì throw.
 */
export function normalizeDelegateAction(
  action: V6DelegateAction,
  options: { name?: string; depth?: number; index?: number } = {},
): V6DelegateChildInput {
  const depth = options.depth ?? 0;
  if (depth >= V6_DELEGATE_MAX_DEPTH) {
    throw new V6DelegateError(
      `Delegate bị chặn: depth ${depth} đã tới giới hạn ${V6_DELEGATE_MAX_DEPTH} (chống vòng lặp spawn).`,
    );
  }
  const task = action.task.trim();
  if (task === '') throw new V6DelegateError('Delegate: task rỗng.');
  const budget = action.budget ?? {};
  const timeoutMs = budget.timeoutMs ?? V6_DELEGATE_DEFAULT_TIMEOUT_MS;
  const maxSteps = budget.maxSteps ?? V6_DELEGATE_DEFAULT_MAX_STEPS;
  const maxTokens = budget.maxTokens ?? V6_DELEGATE_DEFAULT_MAX_TOKENS;
  if (timeoutMs <= 0) throw new V6DelegateError('Delegate: timeoutMs phải > 0.');
  if (maxSteps <= 0) throw new V6DelegateError('Delegate: maxSteps phải > 0.');
  if (maxTokens <= 0) throw new V6DelegateError('Delegate: maxTokens phải > 0.');
  const input: V6DelegateChildInput = {
    name: options.name ?? `delegate-${(options.index ?? 0) + 1}`,
    task,
    timeoutMs,
    maxSteps,
    maxTokens,
  };
  if (action.scope) input.scope = action.scope;
  if (action.role) input.role = action.role;
  return input;
}

/**
 * Chuẩn hoá task trùng để chống delegate lặp: lowercase, bỏ khoảng
 * trắng thừa, lấy 200 ký tự đầu (cùng quy ước với nested subagents).
 */
export function fingerprintV6DelegateTask(task: string): string {
  return task.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Theo dõi các task đang delegate trong một session (chống lặp). */
export class V6DelegateTracker {
  private readonly running = new Set<string>();

  /** true khi task này đang có một con chạy (nên chặn spawn thêm). */
  isRunning(task: string): boolean {
    return this.running.has(fingerprintV6DelegateTask(task));
  }

  /** Đánh dấu task bắt đầu chạy (trả false khi đã có con chạy). */
  start(task: string): boolean {
    const key = fingerprintV6DelegateTask(task);
    if (this.running.has(key)) return false;
    this.running.add(key);
    return true;
  }

  /** Đánh dấu task xong (dù done/error/timeout). */
  finish(task: string): void {
    this.running.delete(fingerprintV6DelegateTask(task));
  }

  /** Số task đang chạy. */
  get runningCount(): number {
    return this.running.size;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: boolean; value?: T }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Chạy MỘT con qua runner (có timeout + chặn task trùng đang chạy).
 * Runner không có (undefined) → trả error rõ ràng, không chạy giả.
 */
export async function runV6DelegateChild(
  input: V6DelegateChildInput,
  runner: V6SubagentRunner | undefined,
  tracker?: V6DelegateTracker,
): Promise<V6DelegateResult> {
  const startedMs = Date.now();
  if (!runner) {
    return {
      name: input.name,
      status: 'error',
      output: '',
      durationMs: Date.now() - startedMs,
      error: 'Chưa nối sub-agent runner: host cần tiêm V6SubagentRunner cho coding agent v6. Con chưa được chạy.',
    };
  }
  if (tracker && !tracker.start(input.task)) {
    return {
      name: input.name,
      status: 'error',
      output: '',
      durationMs: Date.now() - startedMs,
      error: `Task "${input.task.slice(0, 80)}" đang có một sub-agent chạy rồi — chặn delegate trùng (chống vòng lặp).`,
    };
  }
  try {
    const raced = await withTimeout(
      runner({
        name: input.name,
        task: input.task,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.role ? { role: input.role } : {}),
        timeoutMs: input.timeoutMs,
        maxSteps: input.maxSteps,
      }),
      input.timeoutMs,
    );
    if (raced.timedOut) {
      return {
        name: input.name,
        status: 'timeout',
        output: '',
        durationMs: Date.now() - startedMs,
        error: `Sub-agent "${input.name}" quá timeout ${input.timeoutMs}ms.`,
      };
    }
    const result = raced.value as V6DelegateResult;
    return { ...result, durationMs: Date.now() - startedMs };
  } catch (e) {
    return {
      name: input.name,
      status: 'error',
      output: '',
      durationMs: Date.now() - startedMs,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    tracker?.finish(input.task);
  }
}

/**
 * Chạy NHIỀU con song song (tối đa V6_DELEGATE_MAX_CHILDREN) rồi
 * hợp nhất theo chiến lược. Con lỗi/timeout vẫn có mặt trong kết
 * quả hợp nhất (ghi rõ trạng thái, không giấu).
 */
export async function runV6Delegation(
  children: readonly V6DelegateChildInput[],
  runner: V6SubagentRunner | undefined,
  options: { mergeStrategy?: V6DelegateMergeStrategy; tracker?: V6DelegateTracker } = {},
): Promise<{ results: V6DelegateResult[]; merged: string }> {
  if (children.length === 0) {
    throw new V6DelegateError('Delegate: không có con nào để chạy.');
  }
  if (children.length > V6_DELEGATE_MAX_CHILDREN) {
    throw new V6DelegateError(`Delegate: ${children.length} con vượt giới hạn ${V6_DELEGATE_MAX_CHILDREN}.`);
  }
  const results = await Promise.all(children.map((child) => runV6DelegateChild(child, runner, options.tracker)));
  const merged = mergeV6DelegateResults(results, options.mergeStrategy ?? 'concat');
  return { results, merged };
}

/** Trích verdict có cấu trúc từ output con (dòng `Verdict: ...`). */
export function extractV6DelegateVerdict(output: string): string | undefined {
  const m = output.match(/^\s*Verdict\s*:\s*(.+)\s*$/im);
  return m?.[1]?.trim();
}

/** Hợp nhất kết quả các con theo chiến lược. */
export function mergeV6DelegateResults(
  results: readonly V6DelegateResult[],
  strategy: V6DelegateMergeStrategy = 'concat',
): string {
  if (results.length === 0) return '';
  if (strategy === 'concat') {
    return results
      .map((r) => `[${r.name} — ${r.status}]\n${r.status === 'done' ? r.output : `Lỗi: ${r.error ?? 'không rõ'}`}`)
      .join('\n\n');
  }
  if (strategy === 'summarize') {
    return results
      .map((r) => {
        if (r.status !== 'done') return `- ${r.name}: ${r.status} (${r.error ?? 'không rõ'})`;
        const firstLine = r.output.split('\n').find((l) => l.trim() !== '') ?? '';
        const verdict = extractV6DelegateVerdict(r.output);
        return `- ${r.name}: ${firstLine.trim().slice(0, 200)}${verdict ? ` [Verdict: ${verdict}]` : ''}`;
      })
      .join('\n');
  }
  // verdict: đa số theo verdict có cấu trúc + liệt kê xung đột.
  const verdicts = results
    .filter((r) => r.status === 'done')
    .map((r) => ({ name: r.name, verdict: extractV6DelegateVerdict(r.output) }))
    .filter((v) => v.verdict !== undefined) as Array<{ name: string; verdict: string }>;
  const counts = new Map<string, string[]>();
  for (const v of verdicts) {
    const names = counts.get(v.verdict) ?? [];
    names.push(v.name);
    counts.set(v.verdict, names);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines: string[] = [];
  if (sorted.length === 0) {
    lines.push('Không có con nào trả verdict có cấu trúc.');
  } else {
    const top = sorted[0]!;
    lines.push(`Đa số: "${top[0]}" (${top[1].length}/${verdicts.length} con: ${top[1].join(', ')}).`);
    if (sorted.length > 1) {
      lines.push(`Xung đột: ${sorted.slice(1).map(([v, names]) => `"${v}" (${names.join(', ')})`).join('; ')}.`);
    }
  }
  for (const r of results) {
    if (r.status !== 'done') lines.push(`- ${r.name}: ${r.status} (${r.error ?? 'không rõ'})`);
  }
  return lines.join('\n');
}
