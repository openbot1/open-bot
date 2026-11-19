/**
 * Coding agent v16 — HistoryTrimmer: cắt gọn lịch sử hội thoại/task
 * khi vượt ngưỡng (giữ 5 tool-output gần nhất).
 *
 * Ý tưởng từ nghiên cứu (survey v138 §3, Princeton/SWE-agent): chỉ
 * giữ 5 tool-output gần nhất trong history cho +3 điểm — output cũ
 * là token chết. Trimmer là hàm thuần trên mảng entry (không giữ
 * state): entry pinned (system prompt, quyết định đã chốt) không bao
 * giờ bị cắt; tool-output cũ bị cắt trước; phần đã cắt được thay bằng
 * 1 summary entry ngắn (trích 1 dòng/ entry) để agent vẫn biết đã
 * làm gì. Token ước tính bằng heuristic chars/4 (cùng estimator với
 * tokenBudget) khi entry chưa có số token đo được.
 */

import { CodingV16Error, V16_DEFAULTS } from './types';
import type { V16HistoryEntry, V16TrimPolicy, V16TrimResult } from './types';
import { v16EstimateTokens } from './tokenBudget';

/** Token của một entry (dùng số đã đo nếu có, không thì ước tính). */
export function v16EntryTokens(entry: V16HistoryEntry): number {
  if (Number.isInteger(entry.tokens) && entry.tokens >= 0) return entry.tokens;
  return v16EstimateTokens(entry.text);
}

/** Tổng token của cả history. */
export function v16HistoryTokens(entries: readonly V16HistoryEntry[]): number {
  return entries.reduce((sum, e) => sum + v16EntryTokens(e), 0);
}

/** true = history đã vượt ngưỡng trim. */
export function v16ShouldTrim(
  entries: readonly V16HistoryEntry[],
  policy: V16TrimPolicy,
): boolean {
  if (!Number.isInteger(policy.maxTokens) || policy.maxTokens <= 0) {
    throw new CodingV16Error('trim-invalid', 'Trim policy maxTokens must be a positive integer.');
  }
  return v16HistoryTokens(entries) > policy.maxTokens;
}

/** Tóm tắt 1 entry thành 1 dòng (cắt ở 80 ký tự, bỏ newline). */
export function v16SummarizeEntry(entry: V16HistoryEntry): string {
  const oneLine = entry.text.replace(/\s+/g, ' ').trim();
  const short = oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
  const label = entry.role === 'tool' ? `tool:${entry.toolName ?? '?'}` : entry.role;
  return `[${label}] ${short}`;
}

/** Tóm tắt nhiều entry đã cắt thành 1 text ngắn (giới hạn token). */
export function v16SummarizeTrimmed(
  trimmed: readonly V16HistoryEntry[],
  maxTokens: number = 300,
): string {
  if (trimmed.length === 0) return '';
  const lines = trimmed.map((e) => v16SummarizeEntry(e));
  let text = `Trimmed ${trimmed.length} older entr${trimmed.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`;
  // Cắt ngắn dần cho tới khi vừa ngân sách summary.
  while (v16EstimateTokens(text) > maxTokens && lines.length > 1) {
    lines.pop();
    text =
      `Trimmed ${trimmed.length} older entries (showing ${lines.length}):\n${lines.join('\n')}`;
  }
  if (v16EstimateTokens(text) > maxTokens) {
    text = `Trimmed ${trimmed.length} older entries (details dropped to fit ${maxTokens} tokens).`;
  }
  return text;
}

/**
 * Cắt gọn history theo chính sách.
 *
 * Thứ tự giữ: (1) mọi entry pinned, (2) N tool-output gần nhất,
 * (3) N entry model/user gần nhất, (4) summary entry thay phần đã
 * cắt (khi summarizeTrimmed=true). Không bao giờ trả về mảng rỗng
 * khi đầu vào không rỗng (ít nhất giữ entry cuối cùng).
 */
export function v16TrimHistory(
  entries: readonly V16HistoryEntry[],
  policy: V16TrimPolicy,
): { kept: V16HistoryEntry[]; result: V16TrimResult } {
  if (!Number.isInteger(policy.maxTokens) || policy.maxTokens <= 0) {
    throw new CodingV16Error('trim-invalid', 'Trim policy maxTokens must be a positive integer.');
  }
  const keepRecentToolOutputs = policy.keepRecentToolOutputs ?? V16_DEFAULTS.keepRecentToolOutputs;
  const keepRecentEntries = policy.keepRecentEntries ?? 4;
  const summarizeTrimmed = policy.summarizeTrimmed ?? true;
  const summaryMaxTokens = policy.summaryMaxTokens ?? 300;
  if (!Number.isInteger(keepRecentToolOutputs) || keepRecentToolOutputs < 0) {
    throw new CodingV16Error('trim-invalid', 'keepRecentToolOutputs must be a non-negative integer.');
  }
  if (!Number.isInteger(keepRecentEntries) || keepRecentEntries < 0) {
    throw new CodingV16Error('trim-invalid', 'keepRecentEntries must be a non-negative integer.');
  }

  const beforeEntries = entries.length;
  const beforeTokens = v16HistoryTokens(entries);
  if (beforeTokens <= policy.maxTokens || entries.length === 0) {
    return {
      kept: [...entries],
      result: {
        beforeEntries,
        afterEntries: beforeEntries,
        beforeTokens,
        afterTokens: beforeTokens,
        trimmedEntries: 0,
        tokensSaved: 0,
        summarized: false,
        summaryText: null,
      },
    };
  }

  // Index các entry phải giữ (pinned + recent tool + recent entries).
  const keep = new Set<number>();
  entries.forEach((e, i) => {
    if (e.pinned) keep.add(i);
  });
  const toolIndices = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.role === 'tool')
    .map(({ i }) => i);
  toolIndices.slice(-keepRecentToolOutputs).forEach((i) => keep.add(i));
  const recentIndices = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.role === 'model' || e.role === 'user')
    .map(({ i }) => i);
  recentIndices.slice(-keepRecentEntries).forEach((i) => keep.add(i));
  // Luôn giữ entry cuối cùng (agent đang làm việc trên đó).
  keep.add(entries.length - 1);
  const sortedKeep = [...keep].sort((a, b) => a - b);
  // Ngân sách cho toàn bộ phần giữ (đã trừ reserve cho summary entry).
  const summaryReserve = summarizeTrimmed ? Math.min(summaryMaxTokens, 300) : 0;
  const budget = policy.maxTokens - summaryReserve;

  // Cắt từ entry cũ nhất (không nằm trong keep) cho tới khi vừa ngưỡng:
  // duyệt non-keep từ MỚI về CŨ, giữ khi còn chỗ; phần cũ hơn bị cắt.
  const trimmed: V16HistoryEntry[] = [];
  const keepSet = new Set(sortedKeep);
  const extraKept = new Set<number>();
  const keptTokens = sortedKeep.reduce((s, i) => s + v16EntryTokens(entries[i]!), 0);
  // Ngân sách cho phần giữ thêm (đã trừ reserve cho summary).
  const extraBudget = Math.max(0, budget - keptTokens);
  let extraUsed = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (keepSet.has(i)) continue;
    const cost = v16EntryTokens(entries[i]!);
    if (extraUsed + cost <= extraBudget) {
      extraKept.add(i);
      extraUsed += cost;
    } else {
      trimmed.push(entries[i]!);
    }
  }
  trimmed.reverse();
  const keptList: V16HistoryEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (keepSet.has(i) || extraKept.has(i)) keptList.push(entries[i]!);
  }
  // Bảo đảm không trả về mảng rỗng khi đầu vào không rỗng.
  if (keptList.length === 0 && entries.length > 0) {
    keptList.push(entries[entries.length - 1]!);
    const idx = trimmed.indexOf(entries[entries.length - 1]!);
    if (idx !== -1) trimmed.splice(idx, 1);
  }
  // Sắp lại kept theo seq gốc (đã đúng thứ tự vì duyệt tăng dần).
  const kept: V16HistoryEntry[] = [...keptList];
  let summaryText: string | null = null;
  let summarized = false;
  if (trimmed.length > 0 && summarizeTrimmed) {
    summaryText = v16SummarizeTrimmed(trimmed, summaryMaxTokens);
    const summaryEntry: V16HistoryEntry = {
      id: `v16-summary-${Date.now()}`,
      role: 'summary',
      text: summaryText,
      tokens: v16EstimateTokens(summaryText),
      seq: trimmed[trimmed.length - 1]!.seq,
      at: Date.now(),
    };
    // Chèn summary vào vị trí của entry đã cắt đầu tiên.
    const firstTrimmedSeq = trimmed[0]!.seq;
    const insertAt = kept.findIndex((e) => e.seq > firstTrimmedSeq);
    if (insertAt === -1) kept.push(summaryEntry);
    else kept.splice(insertAt, 0, summaryEntry);
    summarized = true;
  }
  const afterTokens = v16HistoryTokens(kept);
  return {
    kept,
    result: {
      beforeEntries,
      afterEntries: kept.length,
      beforeTokens,
      afterTokens,
      trimmedEntries: trimmed.length,
      tokensSaved: Math.max(0, beforeTokens - afterTokens),
      summarized,
      summaryText,
    },
  };
}

/** Render kết quả trim thành 1 dòng. */
export function renderV16TrimResult(result: V16TrimResult): string {
  if (result.trimmedEntries === 0) {
    return `No trim needed: ${result.beforeEntries} entries, ${result.beforeTokens} tokens.`;
  }
  return (
    `Trimmed ${result.trimmedEntries} entries (${result.beforeEntries} -> ${result.afterEntries}), ` +
    `saved ${result.tokensSaved} tokens (${result.beforeTokens} -> ${result.afterTokens})` +
    (result.summarized ? ' — replaced with summary.' : '.')
  );
}

/** Kết quả trim nhiều vòng (khi 1 vòng chưa đủ vừa ngân sách). */
export interface V16TrimRoundsResult {
  kept: V16HistoryEntry[];
  rounds: V16TrimResult[];
  totalTrimmedEntries: number;
  totalTokensSaved: number;
  /** Số vòng đã chạy (tối đa maxRounds). */
  roundsRun: number;
  /** true = sau maxRounds vẫn chưa vừa ngân sách (phần giữ bắt buộc quá lớn). */
  stillOverBudget: boolean;
}

/**
 * Trim nhiều vòng cho tới khi vừa ngân sách (hoặc hết maxRounds):
 * mỗi vòng cắt 20% ngân sách mục tiêu (mục tiêu giảm dần) để tránh
 * cắt 1 lần quá tay. Dừng sớm khi đã vừa. Phần giữ bắt buộc
 * (pinned + recent) không bao giờ bị cắt nên có thể vẫn quá ngân
 * sách — khi đó stillOverBudget=true và caller cần tăng ngân sách
 * hoặc bỏ pin.
 */
export function v16TrimUntilFit(
  entries: readonly V16HistoryEntry[],
  policy: V16TrimPolicy,
  maxRounds = 3,
): V16TrimRoundsResult {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new CodingV16Error('trim-invalid', 'maxRounds must be a positive integer.');
  }
  const rounds: V16TrimResult[] = [];
  let kept: V16HistoryEntry[] = [...entries];
  let totalTrimmedEntries = 0;
  let totalTokensSaved = 0;
  let roundsRun = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    if (v16HistoryTokens(kept) <= policy.maxTokens) break;
    roundsRun += 1;
    // Mục tiêu vòng này: giảm 20% khoảng cách tới ngân sách (ít nhất
    // cắt tới đúng ngân sách khi khoảng cách nhỏ).
    const current = v16HistoryTokens(kept);
    const gap = current - policy.maxTokens;
    const target = Math.max(policy.maxTokens, current - Math.max(1, Math.ceil(gap * 0.2)));
    const { kept: next, result } = v16TrimHistory(kept, { ...policy, maxTokens: target });
    rounds.push(result);
    totalTrimmedEntries += result.trimmedEntries;
    totalTokensSaved += result.tokensSaved;
    kept = next;
    // Một vòng không cắt được gì nữa → dừng (phần giữ bắt buộc đã chiếm hết).
    if (result.trimmedEntries === 0) break;
  }
  return {
    kept,
    rounds,
    totalTrimmedEntries,
    totalTokensSaved,
    roundsRun,
    stillOverBudget: v16HistoryTokens(kept) > policy.maxTokens,
  };
}

/** Render kết quả trim nhiều vòng thành text. */
export function renderV16TrimRoundsResult(result: V16TrimRoundsResult): string {
  const lines: string[] = [
    `Trimmed in ${result.roundsRun} round(s): ${result.totalTrimmedEntries} entries, saved ${result.totalTokensSaved} tokens.`,
  ];
  for (const r of result.rounds) lines.push(`- ${renderV16TrimResult(r)}`);
  if (result.stillOverBudget) {
    lines.push('Still over budget — pinned/recent entries alone exceed the limit; raise maxTokens or unpin entries.');
  }
  return lines.join('\n');
}

/** Tạo entry mới (tự gán id + seq + at khi không truyền). */
export function v16NewHistoryEntry(
  input: Omit<V16HistoryEntry, 'id' | 'seq' | 'at' | 'tokens'> & {
    id?: string;
    seq?: number;
    at?: number;
    tokens?: number;
  },
): V16HistoryEntry {
  return {
    id: input.id ?? `v16-entry-${Math.random().toString(36).slice(2, 10)}`,
    role: input.role,
    text: input.text,
    tokens: input.tokens ?? v16EstimateTokens(input.text),
    seq: input.seq ?? 0,
    at: input.at ?? Date.now(),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
  };
}
