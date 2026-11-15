/**
 * Critic / verification render inline trong conversation (v1.07, Đội T2).
 *
 * Ý tưởng học từ survey v1.07 phần 1 (OpenHands: kết quả
 * critic/verification render inline trong conversation — chỉ học ý
 * tưởng, không copy code/text/tài sản của repo nào): sau khi agent
 * xong việc, một bộ check độc lập chấm lại kết quả rồi RENDER NGAY
 * TRONG LUỒNG CHAT — user thấy "đã kiểm chứng: pass/fail, vì sao"
 * mà không cần mở panel khác.
 *
 * Critic ở đây là các check THUẦN (function, không gọi LLM): kiểm tra
 * output có rỗng không, có chứa marker lỗi không, file đã đổi có tồn
 * tại không, budget có vượt không… Host muốn critic bằng LLM thì viết
 * thêm một check gọi provider rồi đăng ký vào `runCritic` như mọi
 * check khác — module này không ép.
 *
 * Render inline có 2 dạng:
 * - Markdown (`renderCriticInline`): chèn thẳng vào message chat
 *   (dạng block quote + bảng check) — đường mặc định cho chat text.
 * - Object (`CriticReport`): UI React (`CriticInlineCard`) render
 *   thành thẻ có màu pass/fail — xem apps/desktop.
 */

import type { V3Observation } from './types';

/** Một check của critic: tên + hàm chấm (true = đạt). */
export interface CriticCheck {
  /** Id ổn định (vd 'non-empty-output'). */
  id: string;
  /** Nhãn hiển thị (vd 'Output không rỗng'). */
  label: string;
  /** Chấm: trả true khi đạt, false khi không đạt; throw = không đạt + ghi lỗi. */
  run: (ctx: CriticContext) => boolean | Promise<boolean>;
  /** Ghi chú khi không đạt (hiện trong report). */
  failHint?: string;
}

/** Ngữ cảnh critic chấm: kết quả turn + observation cuối + file đã đổi. */
export interface CriticContext {
  /** Text kết quả cuối của agent (khi finish). */
  finalText?: string;
  /** Observation cuối cùng của turn. */
  lastObservation?: V3Observation;
  /** Mọi file đã đổi trong turn. */
  changedFiles: string[];
  /** Số step đã chạy / tối đa. */
  steps: number;
  maxSteps: number;
  /** Lỗi turn (khi turn failed). */
  error?: string;
}

/** Kết quả một check. */
export interface CriticCheckResult {
  id: string;
  label: string;
  passed: boolean;
  /** Ghi chú (failHint khi không đạt, lỗi throw khi check hỏng). */
  note?: string;
}

/** Kết luận tổng của critic. */
export type CriticVerdict = 'pass' | 'fail' | 'partial';

/** Report đầy đủ của một lần critic (ghi vào EventLog `critic.report`). */
export interface CriticReport {
  verdict: CriticVerdict;
  checks: CriticCheckResult[];
  /** Số check đạt / tổng. */
  passedCount: number;
  totalCount: number;
  /** Tóm tắt một dòng (vd "Đã kiểm chứng: 3/4 đạt — output rỗng"). */
  summary: string;
  /** Thời điểm chấm (ISO 8601). */
  at: string;
}

const MAX_NOTE_CHARS = 200;

function truncateNote(note: string): string {
  return note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS)}…` : note;
}

/**
 * Chạy mọi check (tuần tự, mỗi check một lần; check throw thì tính
 * là không đạt, không làm hỏng các check còn lại). Không có check nào
 * → verdict 'pass' với summary nói rõ "không có check nào" (critic
 * trống không được giả vờ đã kiểm chứng).
 */
export async function runCritic(
  checks: CriticCheck[],
  ctx: CriticContext,
): Promise<CriticReport> {
  const results: CriticCheckResult[] = [];
  for (const check of checks) {
    try {
      const passed = (await check.run(ctx)) === true;
      results.push({
        id: check.id,
        label: check.label,
        passed,
        ...(passed
          ? {}
          : {
              note:
                check.failHint !== undefined ? truncateNote(check.failHint) : undefined,
            }),
      });
    } catch (err) {
      results.push({
        id: check.id,
        label: check.label,
        passed: false,
        note: truncateNote(`Check lỗi: ${(err as Error).message}`),
      });
    }
  }
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const verdict: CriticVerdict =
    totalCount === 0 ? 'pass' : passedCount === totalCount ? 'pass' : passedCount === 0 ? 'fail' : 'partial';
  const failed = results.filter((r) => !r.passed);
  const summary =
    totalCount === 0
      ? 'Đã kiểm chứng: không có check nào được đăng ký.'
      : verdict === 'pass'
        ? `Đã kiểm chứng: ${passedCount}/${totalCount} đạt.`
        : `Đã kiểm chứng: ${passedCount}/${totalCount} đạt — chưa đạt: ${failed.map((f) => f.label).join('; ')}.`;
  return { verdict, checks: results, passedCount, totalCount, summary, at: new Date().toISOString() };
}

/** Check có sẵn: output cuối không rỗng (sau khi trim). */
export const CRITIC_CHECK_NON_EMPTY: CriticCheck = {
  id: 'non-empty-output',
  label: 'Output không rỗng',
  run: (ctx) => (ctx.finalText ?? '').trim() !== '' || (ctx.lastObservation?.output ?? '').trim() !== '',
  failHint: 'Agent kết thúc nhưng không trả text lẫn observation — có thể vòng lặp dừng sớm.',
};

/** Check có sẵn: output cuối không chứa marker lỗi thường gặp. */
export const CRITIC_CHECK_NO_ERROR_MARKER: CriticCheck = {
  id: 'no-error-marker',
  label: 'Không có marker lỗi trong output',
  run: (ctx) => {
    const text = `${ctx.finalText ?? ''}\n${ctx.lastObservation?.output ?? ''}`.toLowerCase();
    return !text.includes('traceback') && !text.includes('error:') && !text.includes('failed:');
  },
  failHint: 'Output chứa "traceback"/"error:"/"failed:" — kết quả có thể là lỗi chứ không phải thành công.',
};

/** Check có sẵn: turn không kết thúc vì lỗi (ctx.error rỗng). */
export const CRITIC_CHECK_NO_TURN_ERROR: CriticCheck = {
  id: 'no-turn-error',
  label: 'Turn không lỗi',
  run: (ctx) => ctx.error === undefined || ctx.error === '',
  failHint: 'Turn kết thúc vì lỗi — xem error trong event log.',
};

/** Check có sẵn: observation cuối (khi có) có status 'ok'. */
export const CRITIC_CHECK_LAST_OBSERVATION_OK: CriticCheck = {
  id: 'last-observation-ok',
  label: 'Observation cuối thành công',
  run: (ctx) =>
    ctx.lastObservation === undefined || ctx.lastObservation.status === 'ok',
  failHint: 'Observation cuối báo lỗi/denied/timeout — action cuối chưa thành công.',
};

/** Bộ check mặc định của critic (4 check có sẵn trên). */
export const DEFAULT_CRITIC_CHECKS: readonly CriticCheck[] = [
  CRITIC_CHECK_NON_EMPTY,
  CRITIC_CHECK_NO_ERROR_MARKER,
  CRITIC_CHECK_NO_TURN_ERROR,
  CRITIC_CHECK_LAST_OBSERVATION_OK,
];

/**
 * Render report thành block Markdown chèn thẳng vào luồng chat.
 * Dạng: tiêu đề theo verdict (✅/⚠️/❌) + summary + bảng từng check
 * (✓/✗ + nhãn + ghi chú). Text thuần, không HTML — chat markdown
 * hiện có render được ngay.
 */
export function renderCriticInline(report: CriticReport): string {
  const icon = report.verdict === 'pass' ? '✅' : report.verdict === 'partial' ? '⚠️' : '❌';
  const title =
    report.verdict === 'pass'
      ? 'Kiểm chứng: đạt'
      : report.verdict === 'partial'
        ? 'Kiểm chứng: đạt một phần'
        : 'Kiểm chứng: chưa đạt';
  const lines = [`> ${icon} **${title}** — ${report.summary}`];
  if (report.checks.length > 0) {
    lines.push('>');
    for (const check of report.checks) {
      const mark = check.passed ? '✓' : '✗';
      const note = check.note !== undefined ? ` — ${check.note}` : '';
      lines.push(`> ${mark} ${check.label}${note}`);
    }
  }
  return lines.join('\n');
}
