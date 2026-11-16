/**
 * Security analyzer v6 + approval gate (v1.14, Đội T3).
 *
 * Ý tưởng học từ OpenHands LLMSecurityAnalyzer (survey v1.14 §2):
 * chấm mọi tool call LOW/MEDIUM/HIGH, pause xin xác nhận khi nguy
 * hiểm. Nối với `risk/analyzer.ts` của open-bot (v1.01: RiskAnalyzer
 * chấm low/medium/high theo tên tool + rule theo args + allow/deny
 * list) — v6 KHÔNG chấm lại từ đầu mà bọc nó:
 *
 * - Map mức của RiskAnalyzer sang mức v6 (low→LOW, medium→MEDIUM,
 *   high→HIGH) kèm điểm + lý do.
 * - Thêm mức UNKNOWN: action không parse được thành tool call quen
 *   thuộc (vd kind lạ, tool name trống) hoặc executor chưa được nối
 *   nên không biết action sẽ chạy ở đâu — fail-closed: UNKNOWN cũng
 *   phải xin xác nhận như HIGH.
 * - `V6ApprovalGate`: HIGH/UNKNOWN thì `requiresConfirmation=true`
 *   và caller PHẢI tạo approval (pause turn) trước khi chạy;
 *   `denied=true` (denylist) thì chặn cứng, không hỏi duyệt (hỏi một
 *   lệnh cấm là vô nghĩa). MEDIUM/LOW chạy thẳng.
 * - Gate giữ các approval đang chờ theo id; `approve`/`deny` trả
 *   quyết định để agent resume hoặc dừng action đó. Gate là pure
 *   in-memory (không fs) — persist nằm ở log (`v6.approval.*`).
 *
 * GIỚI HẠN (nói thẳng, như RiskAnalyzer): heuristic trên tên tool +
 * args dạng text. Lệnh shell tinh vi (base64, biến môi trường) có thể
 * lọt MEDIUM. Đây là lớp HỖ TRỢ DUYỆT, không thay sandbox/guardrail.
 */

import { randomUUID } from 'node:crypto';
import { RiskAnalyzer, analyzeRisk } from '../risk/analyzer';
import type { RiskAnalyzerOptions } from '../risk/types';
import type { V6Action, V6RiskLevel } from './types';

/** Tool name mà v6 map từ từng kind action (để RiskAnalyzer chấm). */
export const V6_TOOL_NAME_BY_KIND: Record<V6Action['kind'], string> = {
  bash: 'shell_exec',
  python: 'shell_exec',
  edit: 'write_file',
  think: 'read_only',
  finish: 'read_only',
  delegate: 'delegate_task',
};

/** Args đưa cho RiskAnalyzer theo từng kind (chỉ field liên quan). */
export function v6ActionToToolCall(action: V6Action): { toolName: string; args: Record<string, unknown> } {
  switch (action.kind) {
    case 'bash':
      return { toolName: 'shell_exec', args: { command: action.command } };
    case 'python':
      return { toolName: 'shell_exec', args: { command: `python3 -c ${action.code.slice(0, 200)}`, code: action.code } };
    case 'edit':
      return { toolName: 'write_file', args: { path: action.path, content: action.content.slice(0, 500) } };
    case 'delegate':
      return { toolName: 'delegate_task', args: { task: action.task, scope: action.scope ?? '' } };
    case 'think':
    case 'finish':
      return { toolName: 'read_only', args: {} };
    default:
      return { toolName: '', args: {} };
  }
}

/** Kết quả chấm rủi ro v6 cho một action. */
export interface V6SecurityVerdict {
  /** Mức rủi ro (UNKNOWN = không chấm được, fail-closed). */
  level: V6RiskLevel;
  /** Điểm 0–100 (UNKNOWN = -1, không có điểm đáng tin). */
  score: number;
  /** Lý do đọc được (hiển thị trên thẻ duyệt). */
  reasons: string[];
  /** Id các rule đã khớp (built-in hoặc cấu hình). */
  matchedRuleIds: string[];
  /** True khi khớp denylist: chặn cứng, không hỏi duyệt. */
  denied: boolean;
  /** True khi phải xin xác nhận người dùng trước khi chạy. */
  requiresConfirmation: boolean;
  /** Tool name đã chấm ('' khi không xác định được). */
  toolName: string;
  /** Epoch ms lúc chấm. */
  assessedAtMs: number;
}

/** Chấm một action bằng RiskAnalyzer mặc định (tiện cho test/CLI). */
export function assessV6Action(
  action: V6Action,
  options: { workspaceDir?: string; analyzerOptions?: RiskAnalyzerOptions } = {},
): V6SecurityVerdict {
  const { toolName, args } = v6ActionToToolCall(action);
  // think/finish không chạy gì — luôn LOW, không cần duyệt.
  if (action.kind === 'think' || action.kind === 'finish') {
    return {
      level: 'LOW',
      score: 0,
      reasons: ['Không thực thi (chỉ suy luận/kết thúc), không thay đổi trạng thái.'],
      matchedRuleIds: [],
      denied: false,
      requiresConfirmation: false,
      toolName,
      assessedAtMs: Date.now(),
    };
  }
  if (toolName === '') {
    return {
      level: 'UNKNOWN',
      score: -1,
      reasons: ['Không xác định được tool cho action này nên không chấm được rủi ro.'],
      matchedRuleIds: [],
      denied: false,
      requiresConfirmation: true,
      toolName,
      assessedAtMs: Date.now(),
    };
  }
  const assessment = analyzeRisk(toolName, args, { workspaceDir: options.workspaceDir });
  const level: V6RiskLevel =
    assessment.level === 'low' ? 'LOW' : assessment.level === 'medium' ? 'MEDIUM' : 'HIGH';
  return {
    level,
    score: assessment.score,
    reasons: assessment.reasons,
    matchedRuleIds: assessment.matchedRuleIds,
    denied: assessment.denied,
    requiresConfirmation: level === 'HIGH' || assessment.denied,
    toolName,
    assessedAtMs: assessment.assessedAtMs,
  };
}

/**
 * Analyzer v6 có trạng thái (giữ một RiskAnalyzer đã biên dịch rule
 * để chấm nhiều action; rule extra/allow/deny do host cấu hình).
 */
export class V6SecurityAnalyzer {
  private readonly analyzer: RiskAnalyzer;
  private readonly workspaceDir?: string;

  constructor(options: { analyzerOptions?: RiskAnalyzerOptions; workspaceDir?: string } = {}) {
    this.analyzer = new RiskAnalyzer(options.analyzerOptions ?? {});
    this.workspaceDir = options.workspaceDir;
  }

  get ruleCount(): number {
    return this.analyzer.ruleCount;
  }

  listRuleIds(): string[] {
    return this.analyzer.listRuleIds();
  }

  assess(action: V6Action): V6SecurityVerdict {
    if (action.kind === 'think' || action.kind === 'finish') {
      return assessV6Action(action);
    }
    const { toolName, args } = v6ActionToToolCall(action);
    const assessment = this.analyzer.analyze(toolName, args, { workspaceDir: this.workspaceDir });
    const level: V6RiskLevel =
      assessment.level === 'low' ? 'LOW' : assessment.level === 'medium' ? 'MEDIUM' : 'HIGH';
    return {
      level,
      score: assessment.score,
      reasons: assessment.reasons,
      matchedRuleIds: assessment.matchedRuleIds,
      denied: assessment.denied,
      requiresConfirmation: level === 'HIGH' || assessment.denied,
      toolName,
      assessedAtMs: assessment.assessedAtMs,
    };
  }

  /** Chấm trực tiếp một tool call lạ (không qua V6Action). */
  assessToolCall(toolName: string, args: Record<string, unknown>): V6SecurityVerdict {
    if (toolName.trim() === '') {
      return {
        level: 'UNKNOWN',
        score: -1,
        reasons: ['Tên tool rỗng nên không chấm được rủi ro.'],
        matchedRuleIds: [],
        denied: false,
        requiresConfirmation: true,
        toolName,
        assessedAtMs: Date.now(),
      };
    }
    const assessment = this.analyzer.analyze(toolName, args, { workspaceDir: this.workspaceDir });
    const level: V6RiskLevel =
      assessment.level === 'low' ? 'LOW' : assessment.level === 'medium' ? 'MEDIUM' : 'HIGH';
    return {
      level,
      score: assessment.score,
      reasons: assessment.reasons,
      matchedRuleIds: assessment.matchedRuleIds,
      denied: assessment.denied,
      requiresConfirmation: level === 'HIGH' || assessment.denied,
      toolName,
      assessedAtMs: assessment.assessedAtMs,
    };
  }
}

/** Một yêu cầu duyệt đang chờ người dùng. */
export interface V6PendingApproval {
  id: string;
  action: V6Action;
  verdict: V6SecurityVerdict;
  /** Lý do pause hiển thị trên thẻ duyệt. */
  reason: string;
  requestedAt: string;
}

/** Quyết định duyệt cho một approval. */
export interface V6ApprovalDecision {
  id: string;
  approved: boolean;
  decidedAt: string;
  /** Ghi chú của người duyệt (tùy chọn). */
  note?: string;
}

/**
 * Approval gate: HIGH/UNKNOWN phải qua đây trước khi chạy.
 * `request` tạo approval đang chờ; `decide` duyệt/từ chối (chỉ
 * được quyết MỘT lần — quyết rồi thì id hết hiệu lực, tránh duyệt
 * trùng). Hết hạn không tự áp dụng ở đây: caller tự timeout theo
 * `requestedAt` nếu cần.
 */
export class V6ApprovalGate {
  private readonly pending = new Map<string, V6PendingApproval>();
  private readonly decided = new Map<string, V6ApprovalDecision>();

  /** Tạo approval cho một action đã chấm HIGH/UNKNOWN. */
  request(action: V6Action, verdict: V6SecurityVerdict, reason?: string): V6PendingApproval {
    const approval: V6PendingApproval = {
      id: randomUUID(),
      action,
      verdict,
      reason: reason ?? `Action ${action.kind} có rủi ro ${verdict.level} (${verdict.reasons[0] ?? 'không rõ lý do'}) — cần xác nhận trước khi chạy.`,
      requestedAt: new Date().toISOString(),
    };
    this.pending.set(approval.id, approval);
    return approval;
  }

  /** Approval đang chờ (undefined khi không có / đã quyết). */
  get(id: string): V6PendingApproval | undefined {
    return this.pending.get(id);
  }

  /** Mọi approval đang chờ. */
  listPending(): V6PendingApproval[] {
    return [...this.pending.values()];
  }

  /** Số approval đang chờ. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Duyệt/từ chối một approval đang chờ. Trả quyết định; throw khi
   * id không tồn tại hoặc đã quyết (không cho quyết hai lần).
   */
  decide(id: string, approved: boolean, note?: string): V6ApprovalDecision {
    const approval = this.pending.get(id);
    if (!approval) {
      throw new Error(`V6ApprovalGate.decide: không có approval đang chờ với id ${id}.`);
    }
    this.pending.delete(id);
    const decision: V6ApprovalDecision = {
      id,
      approved,
      decidedAt: new Date().toISOString(),
      ...(note !== undefined ? { note } : {}),
    };
    this.decided.set(id, decision);
    return decision;
  }

  /** Quyết định đã ghi cho một id (undefined khi chưa quyết). */
  getDecision(id: string): V6ApprovalDecision | undefined {
    return this.decided.get(id);
  }
}
