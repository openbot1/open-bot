/**
 * Coding agent v7 — orchestrator stateless (v1.15, Đội T4).
 *
 * Học ý tưởng OpenHands V1 SDK (survey v1.15 §3): Agent = hàm thuần từ
 * event history → next event; mọi state mutable nằm trong
 * ConversationState event-sourced duy nhất (ở đây: `CodingV7Log`).
 * Nối agent v6 (v1.14) nhưng v7 khác ở:
 * - `decideV7NextAction` là HÀM THUẦN: cùng events + cùng model text
 *   thì cùng action — không đọc field mutable nào ngoài log; test
 *   determinism kiểm chứng được.
 * - Pause/resume hạng nhất: action `ask` hoặc pause thủ công dừng
 *   vòng lặp; `resume()` tiếp tục đúng step tiếp theo (log không chạy
 *   lại step cũ). Approval: action mức `warn` vẫn chạy nhưng ghi
 *   cảnh báo vào observation; `block` không chạy (security gate ở
 *   executor).
 * - Skill kích hoạt theo task/message ở đầu turn và mỗi khi user nhắn
 *   mới; instructions của skill được chèn vào prompt cho model.
 * - Condenser tự động: khi log vượt token budget thì condense tới
 *   seq hiện tại, append event `v7.condensed`, prompt các step sau
 *   dùng `restoreV7Context` thay cho history thô.
 *
 * Agent KHÔNG gọi model thật: model được tiêm qua `V7ModelGenerator`.
 * Agent KHÔNG tự chạy shell ngoài executor đã giao.
 */

import type {
  V7Action,
  V7CondensedSummary,
  V7Event,
  V7ModelGenerator,
  V7SkillActivation,
  V7State,
  V7StepResult,
  V7TurnResult,
} from './types';
import { CodingV7Log, clipV7Text } from './conversationLog';
import { parseV7ActionsFromText, V7CodeActExecutor, v7ActionSignature } from './codeactV3';
import { condenseV7Log, estimateV7LogTokens, renderV7Summary, restoreV7Context, shouldCondenseV7Log } from './condenserV3';
import { V7SkillRegistry, bestV7Skill } from './skills';

/** Số step tối đa mặc định mỗi turn. */
export const V7_DEFAULT_MAX_STEPS = 25;
/** Token budget mặc định: vượt thì auto-condense. */
export const V7_DEFAULT_TOKEN_BUDGET = 8000;

/** Tùy chọn agent v7. */
export interface CodingAgentV7Options {
  /** Model generator do host tiêm (bắt buộc để chạy turn). */
  generate?: V7ModelGenerator;
  /** Executor CodeAct v3 (bắt buộc để chạy action code). */
  executor?: V7CodeActExecutor;
  /** Registry skill (mặc định: builtin). */
  skills?: V7SkillRegistry;
  /** Số step tối đa mỗi turn. Mặc định 25. */
  maxSteps?: number;
  /** Token budget history. Mặc định 8000. */
  tokenBudget?: number;
  /** true = tự condense khi vượt budget (mặc định true). */
  autoCondense?: boolean;
}

/** Prompt hệ thống cho model (ngắn, gợi đúng format CodeAct v3). */
export const V7_SYSTEM_PROMPT = [
  'You are a coding agent. Reply with actions only, one fenced block per action:',
  '```bash',
  '<shell command>',
  '```',
  '```python',
  '<python code>',
  '```',
  '```edit',
  '<relative path> [append]',
  '<file content>',
  '```',
  '```read',
  '<relative path> [maxLines]',
  '```',
  '```think',
  '<decision or reasoning>',
  '```',
  '```finish',
  '<summary of what was done>',
  '```',
  '```ask',
  '<question for the user>',
  '- <option 1>',
  '```',
  'Rules: work inside the workspace only; never read secrets; run tests after each fix; finish with a ```finish block when done.',
].join('\n');

/**
 * Dựng prompt cho model từ log + state + (tùy chọn) summary đã condense.
 * Thuần: không sửa log, không gọi model.
 */
export function buildV7Prompt(log: CodingV7Log, summary?: V7CondensedSummary): string {
  const state = log.state();
  const parts: string[] = [V7_SYSTEM_PROMPT, '', `Task: ${state.title || '(no title)'}`];
  if (summary) {
    parts.push('', restoreV7Context(summary, log.all()));
  } else {
    const recent = log.all().slice(-30);
    parts.push('', 'Recent events:');
    for (const event of recent) {
      parts.push(`#${event.seq} ${event.type}: ${clipV7Text(JSON.stringify(event.payload), 600)}`);
    }
  }
  const activeSkill = bestV7Skill(state.title, new V7SkillRegistry().list());
  if (activeSkill) {
    parts.push('', `Active skill: ${activeSkill.skill.name} — ${activeSkill.skill.description}`, activeSkill.skill.instructions);
  }
  return parts.join('\n');
}

/**
 * HÀM THUẦN — stateless step: từ event history + model text → action
 * tiếp theo. Cùng history + cùng model text thì cùng kết quả, không
 * phụ thuộc trạng thái ngoài. Không chạy action, không ghi log.
 */
export function decideV7NextAction(
  events: readonly V7Event[],
  modelText: string,
  skills?: V7SkillRegistry,
): V7StepResult {
  const parsed = parseV7ActionsFromText(modelText);
  const action: V7Action | null = parsed.actions[0] ?? null;

  // Skill kích hoạt theo message user gần nhất (nếu có).
  let skillActivated: V7SkillActivation | undefined;
  if (skills) {
    const lastUser = [...events].reverse().find((e) => e.type === 'v7.user.message');
    const text = lastUser && typeof lastUser.payload['text'] === 'string' ? (lastUser.payload['text'] as string) : '';
    if (text) skillActivated = bestV7Skill(text, skills.list()) ?? undefined;
  }

  return { action, modelText, ...(skillActivated ? { skillActivated } : {}) };
}

/** Agent coding v7: vòng lặp turn trên một CodingV7Log. */
export class CodingAgentV7 {
  readonly log: CodingV7Log;
  private readonly generate?: V7ModelGenerator;
  private readonly executor?: V7CodeActExecutor;
  private readonly skills: V7SkillRegistry;
  private readonly maxSteps: number;
  private readonly tokenBudget: number;
  private readonly autoCondense: boolean;
  private summary: V7CondensedSummary | null = null;

  constructor(log: CodingV7Log, options: CodingAgentV7Options = {}) {
    this.log = log;
    this.generate = options.generate;
    this.executor = options.executor;
    this.skills = options.skills ?? new V7SkillRegistry();
    this.maxSteps = options.maxSteps ?? V7_DEFAULT_MAX_STEPS;
    this.tokenBudget = options.tokenBudget ?? V7_DEFAULT_TOKEN_BUDGET;
    this.autoCondense = options.autoCondense ?? true;
  }

  /** Summary đã condense hiện tại (null = chưa condense). */
  currentSummary(): V7CondensedSummary | null {
    return this.summary;
  }

  /** Bắt đầu task mới: ghi session.started + user.message. */
  startTask(title: string, prompt: string): void {
    if (this.log.length === 0) {
      this.log.append('v7.session.started', { title });
    }
    this.log.append('v7.user.message', { text: prompt });
    const activation = bestV7Skill(prompt, this.skills.list());
    if (activation) {
      this.log.append('v7.skill.activated', {
        skill: activation.skill.name,
        trigger: activation.matchedTrigger,
        score: activation.score,
      });
    }
  }

  /** Pause thủ công (ghi event; vòng lặp đang chạy sẽ dừng sau step hiện tại). */
  pause(reason?: string): void {
    this.log.pause(reason);
  }

  /** Resume session đã pause. */
  resume(reason?: string): void {
    this.log.resume(reason);
  }

  /** Condense log tới seq hiện tại (ghi event v7.condensed). */
  condenseNow(): V7CondensedSummary {
    const summary = condenseV7Log(this.log.all(), { tokenBudget: this.tokenBudget });
    this.summary = summary;
    this.log.append('v7.condensed', {
      upToSeq: summary.upToSeq,
      eventsCondensed: summary.eventsCondensed,
      tokensBefore: summary.tokensBefore,
      tokensAfter: summary.tokensAfter,
      goal: summary.goal,
    });
    return summary;
  }

  /**
   * Chạy một turn: lặp step (generate → parse → security/execute →
   * observation) cho tới khi finish / ask / pause / hết maxSteps.
   * Mỗi step đều ghi event vào log — log là single source of truth.
   */
  async runTurn(): Promise<V7TurnResult> {
    if (!this.generate) throw new Error('CodingAgentV7 needs a model generator (options.generate)');
    if (!this.executor) throw new Error('CodingAgentV7 needs a CodeAct executor (options.executor)');
    const state0 = this.log.state();
    if (state0.status === 'paused') {
      return { status: 'paused', steps: 0, actionsExecuted: 0, blocked: 0, finished: false, paused: true };
    }

    let steps = 0;
    let actionsExecuted = 0;
    let blocked = 0;
    let finished = false;
    let paused = false;
    let finishSummary: string | undefined;
    let condensed: V7CondensedSummary | undefined;

    while (steps < this.maxSteps) {
      // Auto-condense khi history vượt budget (trước khi gọi model).
      if (this.autoCondense) {
        const check = shouldCondenseV7Log(this.log.all(), { tokenBudget: this.tokenBudget });
        if (check.shouldCondense) {
          condensed = this.condenseNow();
        }
      }

      const prompt = buildV7Prompt(this.log, this.summary ?? undefined);
      const modelText = await this.generate({ prompt, history: this.log.all(), state: this.log.state() });
      this.log.append('v7.model.message', { text: modelText, step: steps + 1 });
      steps += 1;

      const step = decideV7NextAction(this.log.all(), modelText, this.skills);
      if (step.skillActivated && !this.log.state().skillsActivated.includes(step.skillActivated.skill.name)) {
        this.log.append('v7.skill.activated', {
          skill: step.skillActivated.skill.name,
          trigger: step.skillActivated.matchedTrigger,
          score: step.skillActivated.score,
        });
      }

      const action = step.action;
      if (!action) {
        // Model không trả action hợp lệ: ghi lỗi, dừng turn (tránh loop vô hạn).
        this.log.append('v7.error', { message: 'model returned no recognizable action', source: 'agent' });
        break;
      }
      this.log.append('v7.action.parsed', { kind: action.kind, signature: v7ActionSignature(action) });

      if (action.kind === 'finish') {
        finishSummary = action.summary;
        finished = true;
        this.log.append('v7.turn.finished', { summary: action.summary, done: action.done ?? true, steps });
        break;
      }
      if (action.kind === 'ask') {
        this.log.append('v7.session.paused', { reason: `waiting for user: ${action.question}` });
        paused = true;
        break;
      }

      const { observation, verdict } = await this.executor.execute(action);
      if (verdict) {
        this.log.append('v7.security.verdict', {
          kind: action.kind,
          level: verdict.level,
          summary: verdict.summary,
          findings: verdict.findings.map((f) => f.ruleId),
        });
      }
      if (observation.blocked) {
        blocked += 1;
        this.log.append('v7.action.blocked', {
          kind: action.kind,
          reason: observation.blockReason ?? verdict?.summary ?? 'blocked',
        });
        // Bị chặn thì dừng turn để model/user đổi hướng, tránh loop.
        break;
      }
      this.log.append('v7.action.executed', {
        kind: action.kind,
        ...(action.kind === 'edit' ? { path: action.path } : {}),
        exitCode: observation.exitCode,
        durationMs: observation.durationMs,
        timedOut: observation.timedOut,
      });
      if (observation.fileWritten) {
        this.log.append('v7.file.changed', { path: observation.fileWritten.path, bytes: observation.fileWritten.bytes });
      }
      this.log.append('v7.observation', {
        kind: action.kind,
        ok: observation.ok,
        stdout: observation.stdout,
        stderr: observation.stderr,
        exitCode: observation.exitCode,
        timedOut: observation.timedOut,
        blocked: false,
      });
      actionsExecuted += 1;

      if (this.log.state().status === 'paused') {
        paused = true;
        break;
      }
    }

    const status = this.log.state().status;
    return {
      status,
      steps,
      actionsExecuted,
      blocked,
      finished,
      paused,
      ...(finishSummary ? { finishSummary } : {}),
      ...(condensed ? { condensed } : {}),
    };
  }
}

/** Ước lượng token history hiện tại (tiện cho tool/CLI). */
export function v7HistoryTokens(log: CodingV7Log): number {
  return estimateV7LogTokens(log.all());
}

/** Render summary v7 thành text (re-export tiện cho tool). */
export { renderV7Summary };
