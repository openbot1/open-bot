/**
 * Stuck detection v6 cho coding agent (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands stuck detection (survey v1.14 §2: 5
 * pattern kẹt) và nối với `event-log/stuck.ts` của open-bot (v1.03:
 * repeat tool call / repeat error / repeat compile / empty response /
 * no progress trên run log chung). v6 giữ cùng ngưỡng mặc định (3
 * lần lặp, 8 step không tiến triển) nhưng phân tích TRÊN LOG V6 và
 * thêm 3 pattern RIÊNG cho coding agent mà stuck chung không thấy:
 *
 * - `same_file_edit`: sửa cùng một file >= 3 lần mà không có lần
 *   chạy test/build thành công xen giữa (edit mù, không verify).
 * - `test_fail_loop`: cùng một test (tên trích từ output `FAIL ...`)
 *   fail >= 3 lần liên tiếp.
 * - `edit_test_cycle`: vòng edit → chạy test → edit lặp >= 3 chu kỳ
 *   mà không có tiến triển (file đổi nhưng test vẫn fail).
 *
 * Khác với stuck chung (chỉ báo "kẹt"), v6 trả GỢI Ý THOÁT có thứ
 * tự (`V6EscapeSuggestion`): đổi chiến lược (đọc lại lỗi, chạy test
 * đơn lẻ), hỏi user, delegate cho sub-agent, condense rồi thử lại,
 * hoặc dừng hẳn. Gợi ý được chọn theo tín hiệu mạnh nhất — vd
 * test_fail_loop → đổi chiến lược trước, same_file_edit kéo dài →
 * hỏi user.
 *
 * Module thuần (không gọi model, không dừng run): `analyzeV6Stuck`
 * chỉ báo cáo; loop/UI quyết định can thiệp.
 */

import type { V6Event } from './types';
import { v6ActionSignature } from './codeactV2';
import type { V6Action } from './types';

/** Các loại tín hiệu kẹt v6 (gồm 3 pattern coding riêng). */
export type V6StuckSignalKind =
  | 'repeat_action'
  | 'repeat_error'
  | 'same_file_edit'
  | 'test_fail_loop'
  | 'edit_test_cycle'
  | 'no_progress';

/** Một tín hiệu kẹt cụ thể, kèm bằng chứng (seq + số lần). */
export interface V6StuckSignal {
  kind: V6StuckSignalKind;
  /** Số lần mẫu lặp lại (hoặc số step không tiến triển). */
  count: number;
  /** Mô tả ngắn (chỉ tên action/file/test, đã cắt ngắn). */
  detail: string;
  /** Seq đầu tiên của mẫu lặp. */
  firstSeq: number;
  /** Seq cuối cùng của mẫu lặp. */
  lastSeq: number;
}

/** Cách thoát khỏi trạng thái kẹt. */
export type V6EscapeKind = 'change_strategy' | 'ask_user' | 'delegate' | 'condense' | 'stop';

/** Một gợi ý thoát, xếp theo mức ưu tiên (đầu tiên = nên làm nhất). */
export interface V6EscapeSuggestion {
  kind: V6EscapeKind;
  /** Vì sao gợi ý này (gắn với tín hiệu đã phát hiện). */
  rationale: string;
  /** Bước cụ thể tiếp theo (vd "chạy riêng test X với -v"). */
  nextStep: string;
}

/** Kết quả phân tích stuck cho một log v6. */
export interface V6StuckReport {
  sessionId: string;
  /** true khi có ít nhất một tín hiệu vượt ngưỡng. */
  stuck: boolean;
  /** Số step (số model message) trong log. */
  step: number;
  /** Mọi tín hiệu vượt ngưỡng (rỗng khi không kẹt). */
  signals: V6StuckSignal[];
  /** Gợi ý thoát xếp theo ưu tiên (rỗng khi không kẹt). */
  suggestions: V6EscapeSuggestion[];
  /** Gợi ý nên làm nhất (undefined khi không kẹt). */
  topSuggestion?: V6EscapeSuggestion;
}

/** Tùy chọn ngưỡng cho detector v6. */
export interface V6StuckOptions {
  /** Cùng action lặp liên tiếp >= ngưỡng này thì kẹt. Mặc định 3. */
  repeatActionThreshold?: number;
  /** Cùng lỗi lặp liên tiếp >= ngưỡng này thì kẹt. Mặc định 3. */
  repeatErrorThreshold?: number;
  /** Cùng file sửa >= ngưỡng này (không verify giữa) thì kẹt. Mặc định 3. */
  sameFileEditThreshold?: number;
  /** Cùng test fail >= ngưỡng này thì kẹt. Mặc định 3. */
  testFailThreshold?: number;
  /** Chu kỳ edit→test >= ngưỡng này thì kẹt. Mặc định 3. */
  editTestCycleThreshold?: number;
  /** Step không tiến triển >= ngưỡng này thì kẹt. Mặc định 8. */
  noProgressStepThreshold?: number;
}

const V6_STUCK_DEFAULTS: Required<V6StuckOptions> = {
  repeatActionThreshold: 3,
  repeatErrorThreshold: 3,
  sameFileEditThreshold: 3,
  testFailThreshold: 3,
  editTestCycleThreshold: 3,
  noProgressStepThreshold: 8,
};

/** Trích tên test fail từ output (dạng `FAIL path/test` / `✕ name`). */
export function extractFailingTestName(output: string): string | undefined {
  const patterns = [
    /FAIL\s+([^\s]+)/,
    /✕\s+(.+?)(?:\n|$)/,
    /failing:\s*(.+?)(?:\n|$)/i,
    /FAILED\s+([^\s]+(?:\s+[^\s]+)?)/,
  ];
  for (const pattern of patterns) {
    const m = output.match(pattern);
    if (m?.[1]) return m[1].trim().slice(0, 120);
  }
  return undefined;
}

/** Chuẩn hoá text lỗi để so sánh lặp (bỏ số dòng/thời gian). */
export function normalizeV6ErrorText(text: string): string {
  return text
    .replace(/\d+:\d+/g, '')
    .replace(/0x[0-9a-fA-F]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

interface ActionRecord {
  signature: string;
  seq: number;
  kind: string;
  path?: string;
}

/** Phân tích dãy event v6 (theo seq tăng dần) và báo kẹt hay không. */
export function analyzeV6Stuck(
  sessionId: string,
  events: readonly V6Event[],
  options: V6StuckOptions = {},
): V6StuckReport {
  const o = { ...V6_STUCK_DEFAULTS, ...options };
  const signals: V6StuckSignal[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let step = 0;

  const actions: ActionRecord[] = [];
  const errorTexts: Array<{ normalized: string; seq: number }> = [];
  const failedTests: Array<{ name: string; seq: number }> = [];
  let stepsSinceProgress = 0;
  let lastProgressSeq = 0;

  for (const event of sorted) {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'v6.model.message':
        step += 1;
        stepsSinceProgress += 1;
        break;
      case 'v6.action.parsed': {
        const kind = typeof p['kind'] === 'string' ? (p['kind'] as string) : 'unknown';
        // Dựng action tối thiểu để lấy signature (chỉ dùng cho so sánh lặp).
        const action = p as unknown as V6Action;
        let signature = '';
        try {
          signature = v6ActionSignature(action);
        } catch {
          signature = `${kind}:unparseable`;
        }
        const path = typeof p['path'] === 'string' ? (p['path'] as string) : undefined;
        actions.push({ signature, seq: event.seq, kind, ...(path ? { path } : {}) });
        break;
      }
      case 'v6.observation': {
        if (p['ok'] === false) {
          const errText = typeof p['stderr'] === 'string' && (p['stderr'] as string).trim() !== ''
            ? (p['stderr'] as string)
            : typeof p['stdout'] === 'string'
              ? (p['stdout'] as string)
              : '';
          errorTexts.push({ normalized: normalizeV6ErrorText(errText), seq: event.seq });
          const combined = `${typeof p['stdout'] === 'string' ? (p['stdout'] as string) : ''}\n${typeof p['stderr'] === 'string' ? (p['stderr'] as string) : ''}`;
          const testName = extractFailingTestName(combined);
          if (testName) failedTests.push({ name: testName, seq: event.seq });
        } else {
          // Observation thành công CHỈ tính là tiến triển khi là kết
          // quả của action code/delegate (bash/python/edit) — think/
          // finish ok không tính (không thì vòng think-only không
          // bao giờ bị coi là không tiến triển).
          const kind = typeof p['kind'] === 'string' ? (p['kind'] as string) : '';
          if (kind === 'bash' || kind === 'python' || kind === 'edit' || kind === 'delegate') {
            stepsSinceProgress = 0;
            lastProgressSeq = event.seq;
          }
        }
        break;
      }
      case 'v6.file.changed':
        stepsSinceProgress = 0;
        lastProgressSeq = event.seq;
        break;
      default:
        break;
    }
  }

  // --- 1. Cùng action lặp liên tiếp. ---
  let runSig = '';
  let runCount = 0;
  let runFirst = 0;
  let runLast = 0;
  const flushRepeatAction = () => {
    if (runCount >= o.repeatActionThreshold && runSig !== '') {
      signals.push({
        kind: 'repeat_action',
        count: runCount,
        detail: `same action ${runCount}x: ${runSig.slice(0, 120)}`,
        firstSeq: runFirst,
        lastSeq: runLast,
      });
    }
    runCount = 0;
    runSig = '';
  };
  for (const a of actions) {
    if (a.signature === runSig) {
      runCount += 1;
      runLast = a.seq;
    } else {
      flushRepeatAction();
      runSig = a.signature;
      runCount = 1;
      runFirst = a.seq;
      runLast = a.seq;
    }
  }
  flushRepeatAction();

  // --- 2. Cùng lỗi lặp liên tiếp. ---
  let errText = '';
  let errCount = 0;
  let errFirst = 0;
  let errLast = 0;
  const flushRepeatError = () => {
    if (errCount >= o.repeatErrorThreshold && errText !== '') {
      signals.push({
        kind: 'repeat_error',
        count: errCount,
        detail: `same error ${errCount}x: ${errText.slice(0, 120)}`,
        firstSeq: errFirst,
        lastSeq: errLast,
      });
    }
    errCount = 0;
    errText = '';
  };
  for (const e of errorTexts) {
    if (e.normalized !== '' && e.normalized === errText) {
      errCount += 1;
      errLast = e.seq;
    } else {
      flushRepeatError();
      errText = e.normalized;
      errCount = 1;
      errFirst = e.seq;
      errLast = e.seq;
    }
  }
  flushRepeatError();

  // --- 3. Sửa cùng file nhiều lần (không tính think/finish). ---
  const editCounts = new Map<string, { count: number; firstSeq: number; lastSeq: number }>();
  for (const a of actions) {
    if (a.kind !== 'edit' || !a.path) continue;
    const entry = editCounts.get(a.path) ?? { count: 0, firstSeq: a.seq, lastSeq: a.seq };
    entry.count += 1;
    entry.lastSeq = a.seq;
    editCounts.set(a.path, entry);
  }
  for (const [path, entry] of [...editCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (entry.count >= o.sameFileEditThreshold) {
      signals.push({
        kind: 'same_file_edit',
        count: entry.count,
        detail: `edited ${path} ${entry.count}x without a passing verification`,
        firstSeq: entry.firstSeq,
        lastSeq: entry.lastSeq,
      });
      break; // Chỉ báo file kẹt nhất, tránh spam.
    }
  }

  // --- 4. Cùng test fail nhiều lần. ---
  const testCounts = new Map<string, { count: number; firstSeq: number; lastSeq: number }>();
  for (const t of failedTests) {
    const entry = testCounts.get(t.name) ?? { count: 0, firstSeq: t.seq, lastSeq: t.seq };
    entry.count += 1;
    entry.lastSeq = t.seq;
    testCounts.set(t.name, entry);
  }
  for (const [name, entry] of [...testCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (entry.count >= o.testFailThreshold) {
      signals.push({
        kind: 'test_fail_loop',
        count: entry.count,
        detail: `test failed ${entry.count}x: ${name}`,
        firstSeq: entry.firstSeq,
        lastSeq: entry.lastSeq,
      });
      break;
    }
  }

  // --- 5. Chu kỳ edit → test (bash) lặp mà không tiến triển. ---
  let cycles = 0;
  let cycleFirst = 0;
  let cycleLast = 0;
  let seenEdit = false;
  for (const a of actions) {
    if (a.kind === 'edit') {
      if (!seenEdit) cycleFirst = a.seq;
      seenEdit = true;
    } else if (a.kind === 'bash' && seenEdit) {
      cycles += 1;
      cycleLast = a.seq;
      seenEdit = false;
    }
  }
  if (cycles >= o.editTestCycleThreshold && step > 0) {
    // Chỉ tính là kẹt khi có lỗi đi kèm (edit→test→fail lặp), không
    // phạt vòng edit→test bình thường đang tiến triển.
    const hasErrors = errorTexts.length >= o.editTestCycleThreshold;
    if (hasErrors) {
      signals.push({
        kind: 'edit_test_cycle',
        count: cycles,
        detail: `${cycles} edit→test cycles with repeated failures`,
        firstSeq: cycleFirst,
        lastSeq: cycleLast,
      });
    }
  }

  // --- 6. Không tiến triển nhiều step. ---
  if (step >= o.noProgressStepThreshold && stepsSinceProgress >= o.noProgressStepThreshold) {
    signals.push({
      kind: 'no_progress',
      count: stepsSinceProgress,
      detail: `${stepsSinceProgress} steps without a successful observation or file change`,
      firstSeq: lastProgressSeq,
      lastSeq: sorted.length > 0 ? sorted[sorted.length - 1]!.seq : 0,
    });
  }

  const suggestions = buildV6EscapeSuggestions(signals);
  return {
    sessionId,
    stuck: signals.length > 0,
    step,
    signals,
    suggestions,
    ...(suggestions.length > 0 ? { topSuggestion: suggestions[0] } : {}),
  };
}

/** Gợi ý thoát xếp theo ưu tiên từ các tín hiệu đã phát hiện. */
export function buildV6EscapeSuggestions(signals: readonly V6StuckSignal[]): V6EscapeSuggestion[] {
  const suggestions: V6EscapeSuggestion[] = [];
  const has = (kind: V6StuckSignalKind) => signals.some((s) => s.kind === kind);
  const find = (kind: V6StuckSignalKind) => signals.find((s) => s.kind === kind);

  if (has('test_fail_loop')) {
    const s = find('test_fail_loop')!;
    suggestions.push({
      kind: 'change_strategy',
      rationale: `Cùng một test fail ${s.count} lần — sửa mò không hiệu quả.`,
      nextStep: `Đọc lại toàn bộ message lỗi của test "${s.detail.replace(/^test failed \d+x: /, '')}" rồi chạy riêng test đó với output đầy đủ trước khi sửa tiếp.`,
    });
  }
  if (has('repeat_error')) {
    const s = find('repeat_error')!;
    suggestions.push({
      kind: 'change_strategy',
      rationale: `Cùng một lỗi lặp ${s.count} lần — hướng sửa hiện tại sai.`,
      nextStep: 'Dừng sửa theo hướng cũ: đọc lại lỗi gốc, kiểm tra giả định (đường dẫn, tên hàm, phiên bản) rồi thử cách khác.',
    });
  }
  if (has('edit_test_cycle')) {
    const s = find('edit_test_cycle')!;
    suggestions.push({
      kind: 'condense',
      rationale: `${s.count} chu kỳ edit→test thất bại — context có thể đã đầy thông tin cũ gây nhiễu.`,
      nextStep: 'Nén lịch sử (condense) giữ lại quyết định + file đã đổi + lỗi đã gặp, rồi thử lại từ bản tóm tắt.',
    });
  }
  if (has('same_file_edit')) {
    const s = find('same_file_edit')!;
    suggestions.push({
      kind: 'ask_user',
      rationale: `Đã sửa cùng file ${s.count} lần mà chưa xong — có thể yêu cầu chưa rõ.`,
      nextStep: `Hỏi user làm rõ mong muốn cho file trong "${s.detail}" trước khi sửa tiếp.`,
    });
    suggestions.push({
      kind: 'delegate',
      rationale: 'Sửa lặp một file — giao cho sub-agent đọc lại file và đề xuất hướng khác.',
      nextStep: 'Delegate cho sub-agent: đọc file, tóm tắt trạng thái hiện tại, đề xuất 2 hướng sửa khác nhau.',
    });
  }
  if (has('repeat_action')) {
    suggestions.push({
      kind: 'change_strategy',
      rationale: 'Cùng một action lặp lại — model đang luẩn quẩn.',
      nextStep: 'Đổi action: nếu đang chạy cùng lệnh, hãy đọc output kỹ hoặc dùng lệnh khác để thu thêm thông tin.',
    });
  }
  if (has('no_progress')) {
    const s = find('no_progress')!;
    suggestions.push({
      kind: 'ask_user',
      rationale: `${s.count} step không có tiến triển — task có thể quá mơ hồ hoặc quá lớn.`,
      nextStep: 'Hỏi user: thu hẹp task (chia nhỏ) hoặc xác nhận có nên tiếp tục không.',
    });
    suggestions.push({
      kind: 'stop',
      rationale: 'Không tiến triển kéo dài — dừng để tránh đốt token vô ích.',
      nextStep: 'Dừng turn, tóm tắt những gì đã thử + lỗi đã gặp để user quyết định hướng tiếp theo.',
    });
  }
  if (suggestions.length === 0 && signals.length > 0) {
    suggestions.push({
      kind: 'change_strategy',
      rationale: 'Phát hiện dấu hiệu kẹt nhưng chưa rõ pattern — đổi hướng trước.',
      nextStep: 'Tóm tắt lại task và thử hướng tiếp cận khác.',
    });
  }
  return suggestions;
}
