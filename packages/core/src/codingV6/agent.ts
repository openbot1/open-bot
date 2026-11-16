/**
 * Coding agent v6 — orchestrator (v1.14, Đội T3).
 *
 * Nối mọi lớp v6 thành một vòng lặp agent hoàn chỉnh (học OpenHands
 * V1 SDK: event-sourced loop Action ↔ Observation):
 *
 *   user message → RouterLLM chọn model → model sinh text →
 *   parse action thống nhất → security analyzer chấm từng action
 *   (HIGH/UNKNOWN → pause xin duyệt) → chạy qua CodeActExecutor
 *   (BotBox sandbox) hoặc delegate cho sub-agent → observation ghi
 *   vào log → stuck detection → condense khi log dài → `finish`
 *   thì gợi ý commit message bằng coding agent v5.
 *
 * Luồng pause/resume: khi một action cần duyệt, `runTurn` dừng và
 * trả `{status:'paused', pendingApproval}` (KHÔNG chạy lén action
 * đó). Host gọi `approve(id, true)` để chạy action đang chờ (ghi
 * `v6.approval.decided` + observation), rồi gọi `continueTurn()`
 * để model đi tiếp; `approve(id, false)` từ chối (ghi decided +
 * observation blocked, turn tiếp tục mà không chạy action đó).
 *
 * Model được tiêm qua callback `generate` (host nối provider thật);
 * v6 không gọi model trực tiếp nên test được bằng stub. Executor
 * cũng do host tiêm (BotBoxManager của bot); chưa nối thì action
 * code trả observation blocked rõ ràng, không chạy giả.
 *
 * Nối coding agent v5: khi `finish` với `suggestCommit`, agent
 * dựng `CodingV5DiffAnalysis` từ file đã đổi trong log và gọi
 * `buildCodingV5Subject` để gợi ý commit message (cùng quy ước
 * type/scope/summary của v5).
 */

import { buildCodingV5Subject, scopeFromCodingV5Paths } from '../codingV5/commitMessage';
import type { CodingV5DiffAnalysis } from '../codingV5/commitMessage';
import type { CodeActExecutor } from '../codeact/index';
import type { CodingV6Log } from './conversationLog';
import { CodingV6Log as CodingV6LogClass, clipV6Text } from './conversationLog';
import type { V6ChatMessage } from './condenserV2';
import { applyV6Condensation, condenseV6Log, shouldCondenseV6Log } from './condenserV2';
import type { V6CondenseOptions, V6Condensation } from './condenserV2';
import type { V6Action, V6ModelTier, V6Observation, V6SessionStatus, V6State, V6SubagentRunner } from './types';
import type { V6SecurityVerdict } from './security';
import { V6ApprovalGate, V6SecurityAnalyzer } from './security';
import type { V6PendingApproval } from './security';
import type { V6StuckReport } from './stuckV6';
import { analyzeV6Stuck } from './stuckV6';
import type { V6StuckOptions } from './stuckV6';
import type { V6DelegateChildInput } from './delegate';
import { normalizeDelegateAction, runV6DelegateChild, V6DelegateTracker } from './delegate';
import type { RouterLlmDecision } from './routerLlm';
import { RouterLlm } from './routerLlm';
import type { RouterLlmModels, RouterLlmRules } from './routerLlm';
import { executeV6CodeAction, observationForNonCodeAction, parseV6ActionsFromText, renderV6ObservationText, validateV6Action } from './codeactV2';

/** Callback sinh text model (host nối provider thật). */
export type V6ModelGenerator = (input: {
  messages: V6ChatMessage[];
  model: string;
  tier: V6ModelTier;
}) => Promise<string>;

/** Kết quả một turn (hoặc một lần tiếp tục turn). */
export interface V6TurnResult {
  status: 'finished' | 'paused' | 'stuck' | 'max_steps' | 'resumed' | 'aborted';
  /** Số step model đã chạy trong lần gọi này. */
  steps: number;
  /** Approval đang chờ (chỉ khi status = paused). */
  pendingApproval?: V6PendingApproval;
  /** Báo cáo stuck (chỉ khi status = stuck). */
  stuckReport?: V6StuckReport;
  /** Commit message v5 gợi ý (chỉ khi finish + suggestCommit). */
  commitSubject?: string;
  /** Bản nén vừa tạo trong turn (nếu có). */
  condensation?: V6Condensation;
  /** Ghi chú ngắn cho host/UI. */
  note: string;
}

/** Tùy chọn khởi tạo CodingAgentV6. */
export interface CodingAgentV6Options {
  /** Session id (mặc định random). */
  sessionId?: string;
  /** Log có sẵn (để resume session cũ). */
  log?: CodingV6Log;
  /** Model theo tier (mặc định dùng tên gợi ý). */
  models?: RouterLlmModels;
  /** Rule leo thang model. */
  routerRules?: RouterLlmRules;
  /** Thư mục workspace (để security phát hiện ghi ngoài workspace). */
  workspaceDir?: string;
  /** CodeActExecutor của host (BotBox); chưa nối → action code bị chặn. */
  executor?: CodeActExecutor;
  /** Runner sub-agent (host tiêm); chưa nối → delegate trả lỗi rõ. */
  delegateRunner?: V6SubagentRunner;
  /** Số step model tối đa mỗi turn. Mặc định 20. */
  maxSteps?: number;
  /** Ngưỡng condense. */
  condenseOptions?: V6CondenseOptions;
  /** Ngưỡng stuck. */
  stuckOptions?: V6StuckOptions;
}

/** Số step tối đa mặc định mỗi turn. */
export const V6_DEFAULT_MAX_STEPS = 20;

interface PendingAction {
  approvalId: string;
  action: V6Action;
  verdict: V6SecurityVerdict;
}

/** Gợi ý commit message v5 từ file đã đổi trong log. */
export function suggestV6CommitSubject(state: V6State): string {
  const paths = state.filesChanged.map((f) => f.path);
  const analysis: CodingV5DiffAnalysis = {
    type: state.errors.length > 0 ? 'fix' : 'feat',
    scope: paths.length > 0 ? scopeFromCodingV5Paths(paths) : 'coding',
    filesChanged: Math.max(paths.length, 1),
    hunksChanged: 0,
    additions: 0,
    deletions: 0,
    addedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    addedSymbols: [],
    removedSymbols: [],
    keywords: [],
    typeReason: state.errors.length > 0 ? 'session có lỗi đã gặp' : 'session thêm tính năng',
  };
  return buildCodingV5Subject(analysis);
}

export class CodingAgentV6 {
  readonly log: CodingV6Log;
  readonly router: RouterLlm;
  readonly security: V6SecurityAnalyzer;
  readonly gate: V6ApprovalGate;
  private readonly executor?: CodeActExecutor;
  private readonly delegateRunner?: V6SubagentRunner;
  private readonly delegateTracker = new V6DelegateTracker();
  private readonly maxSteps: number;
  private readonly condenseOptions: V6CondenseOptions;
  private readonly stuckOptions: V6StuckOptions;
  private readonly workspaceDir?: string;
  private pendingAction: PendingAction | undefined;
  private messages: V6ChatMessage[] = [];
  private generate: V6ModelGenerator | undefined;

  constructor(options: CodingAgentV6Options = {}) {
    this.log = options.log ?? new CodingV6LogClass(options.sessionId);
    this.router = new RouterLlm({ models: options.models, rules: options.routerRules });
    this.security = new V6SecurityAnalyzer({ workspaceDir: options.workspaceDir });
    this.gate = new V6ApprovalGate();
    this.executor = options.executor;
    this.delegateRunner = options.delegateRunner;
    this.maxSteps = options.maxSteps ?? V6_DEFAULT_MAX_STEPS;
    this.condenseOptions = options.condenseOptions ?? {};
    this.stuckOptions = options.stuckOptions ?? {};
    this.workspaceDir = options.workspaceDir;
  }

  /** Gắn callback sinh text model (host nối provider thật). */
  setGenerator(generate: V6ModelGenerator): void {
    this.generate = generate;
  }

  /** State hiện tại (fold từ log). */
  state(): V6State {
    return this.log.state();
  }

  /** Trạng thái session (running/paused/stuck/finished/aborted). */
  status(): V6SessionStatus {
    return this.log.state().status;
  }

  /** Lịch sử message đang nạp cho model (đã condense nếu có). */
  chatMessages(): V6ChatMessage[] {
    return [...this.messages];
  }

  /** Bắt đầu session mới (ghi `v6.session.started`). */
  startSession(title: string): void {
    this.log.append('v6.session.started', { title: clipV6Text(title, 300) });
    this.messages = [];
  }

  /** Time-travel: state tại một seq bất kỳ. */
  stateAt(seq: number): V6State {
    return this.log.stateAt(seq);
  }

  /** Replay từ event N (debug). */
  replayFrom(seq: number): { before: V6State; after: V6State; replayed: number } {
    return this.log.replayFrom(seq);
  }

  /** Fork session tại một seq → agent con làm việc trên nhánh riêng. */
  forkAt(seq: number, childSessionId?: string): CodingAgentV6 {
    const childLog = this.log.forkAt(seq, childSessionId);
    const child = new CodingAgentV6({
      log: childLog,
      executor: this.executor,
      delegateRunner: this.delegateRunner,
      maxSteps: this.maxSteps,
      condenseOptions: this.condenseOptions,
      stuckOptions: this.stuckOptions,
      workspaceDir: this.workspaceDir,
    });
    if (this.generate) child.setGenerator(this.generate);
    return child;
  }

  /** Nén log ngay (append marker `v6.condensed`, không xoá lịch sử). */
  condenseNow(): V6Condensation {
    const events = this.log.all();
    const condensation = condenseV6Log(events, this.condenseOptions);
    this.log.append('v6.condensed', {
      upToSeq: condensation.upToSeq,
      eventsCovered: condensation.covered,
      summary: condensation.summary,
      decisions: condensation.decisions,
      filesChanged: condensation.filesChanged,
      errorsEncountered: condensation.errorsEncountered,
      tokensBefore: condensation.tokensBefore,
      tokensAfter: condensation.tokensAfter,
      tokensSaved: condensation.tokensSaved,
    });
    this.messages = applyV6Condensation(this.messages, condensation);
    return condensation;
  }

  /**
   * Chạy một turn: user prompt → loop generate/parse/gate/execute.
   * Cần `setGenerator` trước (không có thì throw rõ ràng).
   */
  async runTurn(prompt: string, options: { hasImage?: boolean } = {}): Promise<V6TurnResult> {
    if (!this.generate) {
      throw new Error('CodingAgentV6.runTurn: chưa gắn model generator — gọi setGenerator trước.');
    }
    const state = this.log.state();
    this.log.append('v6.user.message', { text: clipV6Text(prompt) });
    this.messages.push({ role: 'user', text: prompt });
    const decision = this.router.route({
      prompt,
      fileCount: state.filesChanged.length,
      errorCount: state.errors.length,
      hasImage: options.hasImage,
    });
    this.log.append('v6.model.routed', {
      tier: decision.tier,
      model: decision.model,
      score: decision.score,
      reason: decision.reason,
      signals: decision.signals,
    });
    return this.continueTurn();
  }

  /** Tiếp tục turn hiện tại (sau approve, hoặc sau khi pause). */
  async continueTurn(): Promise<V6TurnResult> {
    if (!this.generate) {
      throw new Error('CodingAgentV6.continueTurn: chưa gắn model generator — gọi setGenerator trước.');
    }
    const generate = this.generate;
    let steps = 0;
    let condensation: V6Condensation | undefined;
    while (steps < this.maxSteps) {
      steps += 1;
      const model = this.router.model;
      const tier = this.router.tier;
      let text: string;
      try {
        text = await generate({ messages: [...this.messages], model, tier });
      } catch (e) {
        this.log.append('v6.error', { message: e instanceof Error ? e.message : String(e), source: 'generate' });
        return { status: 'aborted', steps, note: `Model lỗi: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.log.append('v6.model.message', { text: clipV6Text(text), step: steps, model });
      this.messages.push({ role: 'model', text });

      let parsed;
      try {
        parsed = parseV6ActionsFromText(text);
      } catch (e) {
        this.log.append('v6.error', { message: e instanceof Error ? e.message : String(e), source: 'parse' });
        return { status: 'aborted', steps, note: `Parse action lỗi: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (parsed.actions.length === 0) {
        this.log.append('v6.error', { message: 'Model không trả action nào.', source: 'parse' });
        return { status: 'aborted', steps, note: 'Model không trả action nào.' };
      }

      for (const action of parsed.actions) {
        const outcome = await this.runAction(action);
        if (outcome === 'finish') {
          const finish = action as { kind: 'finish'; summary: string; suggestCommit?: boolean };
          let commitSubject: string | undefined;
          if (finish.suggestCommit) {
            commitSubject = suggestV6CommitSubject(this.log.state());
          }
          this.log.append('v6.turn.finished', {
            summary: clipV6Text(finish.summary, 500),
            ...(commitSubject ? { commitSubject } : {}),
          });
          return {
            status: 'finished',
            steps,
            ...(commitSubject ? { commitSubject } : {}),
            ...(condensation ? { condensation } : {}),
            note: finish.summary,
          };
        }
        if (outcome === 'paused') {
          return {
            status: 'paused',
            steps,
            pendingApproval: this.pendingAction ? this.gate.get(this.pendingAction.approvalId) : undefined,
            ...(condensation ? { condensation } : {}),
            note: 'Action rủi ro cao — đang chờ người dùng duyệt.',
          };
        }
      }

      // Sau mỗi step: stuck check → condense khi log dài.
      const stuck = analyzeV6Stuck(this.log.sessionId, this.log.all(), this.stuckOptions);
      if (stuck.stuck) {
        this.log.append('v6.stuck.detected', {
          signals: stuck.signals,
          topSuggestion: stuck.topSuggestion,
        });
        return {
          status: 'stuck',
          steps,
          stuckReport: stuck,
          ...(condensation ? { condensation } : {}),
          note: `Phát hiện kẹt: ${stuck.signals.map((s) => s.detail).join('; ')}`,
        };
      }
      const check = shouldCondenseV6Log(this.log.all(), this.condenseOptions);
      if (check.needed && !condensation) {
        condensation = this.condenseNow();
      }
    }
    return { status: 'max_steps', steps, ...(condensation ? { condensation } : {}), note: `Hết ${this.maxSteps} step mà chưa finish.` };
  }

  /**
   * Chạy MỘT action (đã parse): think/finish/delegate/code + gate.
   * Trả 'finish' khi action là finish, 'paused' khi cần duyệt,
   * 'done' khi xong (kể cả bị chặn/lỗi — observation đã ghi log).
   */
  async runAction(action: V6Action): Promise<'done' | 'finish' | 'paused'> {
    // Ghi action đã parse (payload = chính action, để replay/stuck dùng).
    this.log.append('v6.action.parsed', { ...action } as Record<string, unknown>);
    if (action.kind === 'think') {
      const observation = observationForNonCodeAction(action);
      this.log.append('v6.observation', {
        kind: 'think',
        ok: true,
        stdout: clipV6Text(observation.stdout, 2000),
        stderr: '',
      });
      return 'done';
    }
    if (action.kind === 'finish') {
      const observation = observationForNonCodeAction(action);
      this.log.append('v6.observation', {
        kind: 'finish',
        ok: true,
        stdout: clipV6Text(observation.stdout, 2000),
        stderr: '',
      });
      return 'finish';
    }
    if (action.kind === 'delegate') {
      return this.runDelegateAction(action);
    }
    // Code action: security gate trước khi chạy.
    const verdict = this.security.assess(action);
    this.log.append('v6.security.verdict', {
      toolName: verdict.toolName,
      level: verdict.level,
      score: verdict.score,
      reasons: verdict.reasons,
      matchedRuleIds: verdict.matchedRuleIds,
      denied: verdict.denied,
      requiresConfirmation: verdict.requiresConfirmation,
    });
    if (verdict.denied) {
      this.log.append('v6.action.blocked', { kind: action.kind, reason: 'denylist' });
      this.log.append('v6.observation', {
        kind: action.kind,
        ok: false,
        stdout: '',
        stderr: `Action bị chặn cứng (denylist): ${verdict.reasons.join(' ')}`,
        blocked: true,
      });
      return 'done';
    }
    if (verdict.requiresConfirmation) {
      const approval = this.gate.request(action, verdict);
      this.pendingAction = { approvalId: approval.id, action, verdict };
      this.log.append('v6.approval.requested', {
        approvalId: approval.id,
        kind: action.kind,
        level: verdict.level,
        reason: approval.reason,
      });
      return 'paused';
    }
    return this.executeCodeAction(action);
  }

  /** Chạy action delegate qua runner (ghi event started/finished). */
  private async runDelegateAction(action: { kind: 'delegate'; task: string; scope?: string; role?: string; budget?: import('./types').V6DelegateBudget }): Promise<'done'> {
    let input: V6DelegateChildInput;
    try {
      input = normalizeDelegateAction(action, { depth: 0 });
    } catch (e) {
      this.log.append('v6.error', { message: e instanceof Error ? e.message : String(e), source: 'delegate' });
      this.log.append('v6.observation', {
        kind: 'delegate',
        ok: false,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
      });
      return 'done';
    }
    this.log.append('v6.delegation.started', { name: input.name, task: clipV6Text(input.task, 500), scope: input.scope ?? '' });
    const result = await runV6DelegateChild(input, this.delegateRunner, this.delegateTracker);
    this.log.append('v6.delegation.finished', {
      name: result.name,
      status: result.status,
      output: clipV6Text(result.output, 2000),
      durationMs: result.durationMs,
      ...(result.error ? { error: clipV6Text(result.error, 500) } : {}),
    });
    this.log.append('v6.observation', {
      kind: 'delegate',
      ok: result.status === 'done',
      stdout: clipV6Text(result.output || result.error || '', 2000),
      stderr: result.status === 'done' ? '' : clipV6Text(result.error ?? '', 500),
    });
    return 'done';
  }

  /** Chạy action code qua executor (đã qua gate). */
  private async executeCodeAction(action: V6Action): Promise<'done'> {
    if (action.kind !== 'bash' && action.kind !== 'python' && action.kind !== 'edit') return 'done';
    if (!this.executor) {
      const reason = 'Chưa nối CodeActExecutor: host cần truyền executor cho CodingAgentV6. Action chưa được chạy.';
      this.log.append('v6.action.blocked', { kind: action.kind, reason });
      this.log.append('v6.observation', { kind: action.kind, ok: false, stdout: '', stderr: reason, blocked: true });
      return 'done';
    }
    let observation: V6Observation;
    try {
      validateV6Action(action);
      observation = await executeV6CodeAction(action, this.executor);
    } catch (e) {
      observation = {
        action,
        ok: false,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: null,
        timedOut: false,
        blocked: true,
        blockReason: e instanceof Error ? e.message : String(e),
        durationMs: 0,
      };
    }
    this.log.append('v6.action.executed', {
      kind: action.kind,
      ...(action.kind === 'bash' ? { command: clipV6Text(action.command, 500) } : {}),
      ...(action.kind === 'edit' ? { path: action.path } : {}),
      exitCode: observation.exitCode,
      durationMs: observation.durationMs,
    });
    this.log.append('v6.observation', {
      kind: action.kind,
      ok: observation.ok,
      stdout: clipV6Text(observation.stdout, 2000),
      stderr: clipV6Text(observation.stderr, 2000),
      exitCode: observation.exitCode,
      timedOut: observation.timedOut,
      blocked: observation.blocked,
    });
    if (action.kind === 'edit' && observation.ok && observation.fileWritten) {
      this.log.append('v6.file.changed', { path: observation.fileWritten.path, bytes: observation.fileWritten.bytes });
    }
    // Đưa observation về cho model ở step sau.
    this.messages.push({ role: 'model', text: renderV6ObservationText(observation) });
    return 'done';
  }

  /**
   * Duyệt/từ chối approval đang chờ. Khi duyệt: chạy action đang
   * chờ (ghi decided + observation), trả TurnResult resumed; host
   * gọi tiếp `continueTurn()` để model đi tiếp. Khi từ chối: ghi
   * decided + observation blocked, action không chạy.
   */
  async approve(approvalId: string, approved: boolean, note?: string): Promise<V6TurnResult> {
    const pending = this.pendingAction;
    if (!pending || pending.approvalId !== approvalId) {
      throw new Error(`CodingAgentV6.approve: không có action đang chờ với approval ${approvalId}.`);
    }
    const decision = this.gate.decide(approvalId, approved, note);
    void decision;
    this.log.append('v6.approval.decided', { approvalId, approved, ...(note ? { note } : {}) });
    this.pendingAction = undefined;
    if (!approved) {
      this.log.append('v6.observation', {
        kind: pending.action.kind,
        ok: false,
        stdout: '',
        stderr: 'Người dùng từ chối chạy action này.',
        blocked: true,
      });
      return { status: 'resumed', steps: 0, note: 'Đã từ chối action — turn tiếp tục mà không chạy nó.' };
    }
    await this.executeCodeAction(pending.action);
    return { status: 'resumed', steps: 0, note: 'Đã duyệt và chạy action.' };
  }

  /** Router decision log (để UI đọc lý do chọn model). */
  routerHistory(): RouterLlmDecision[] {
    return this.router.history();
  }
}
