/**
 * Barge-in v5 (v1.18, Đội T5 — voice v17).
 *
 * v16 cut the TTS stream the moment user speech was confirmed and
 * kept the spoken prefix + turn context in the receipt — but it
 * stopped there: the session still had to decide *what to do with
 * the rest of the reply*, and every caller decided differently
 * (most just dropped the remainder and started over, which is why
 * an interrupted answer so often came back as a different answer).
 *
 * v17 owns the decision after the cut. It wraps the v16 engine and
 * adds a resume policy with four actions:
 *
 *   resume    — the user only acknowledged ("ừ", "ok", "rồi") or
 *               trailed off: keep speaking the remaining text from
 *               the cut point, no re-generation.
 *   restart   — the user corrected the reply or asked a question
 *               mid-sentence: discard the remainder and generate a
 *               fresh reply that answers the interruption first.
 *   summarise — the user changed topic after most of the reply
 *               was already spoken: recap the spoken prefix in one
 *               short line, then address the new topic (the spoken
 *               part is not lost, and not repeated in full).
 *   drop      — almost nothing remains (fewer than
 *               `minRemainingCharsToResume` chars): let the cut
 *               stand, do not re-speak the tail.
 *
 * The interruption kind is classified from the captured text
 * (question / correction / new-topic / acknowledgement / unclear)
 * with small, transparent heuristics — a question mark, a
 * correction word ("không", "sai", "nhầm", "dừng"), a short
 * acknowledgement ("ừ", "ok", "đúng rồi") — never a model call.
 *
 * Repeated cuts escalate: a second cut inside `escalationWindowMs`
 * (default 10 s) moves the policy one step toward shorter replies
 * (resume → summarise → drop), and a third cut in the same window
 * caps the next reply at `escalatedMaxReplyChars` so the agent
 * stops monologuing at a user who keeps cutting in. The escalation
 * level is in the stats and in every plan, so the panel can show
 * "user interrupted 3× — replies shortened".
 *
 * Virtual clock, no mic, no sound card. The v16 engine still owns
 * detection, the cut itself and the receipt.
 */

import { BargeInEngineV16, createBargeInEngineV16, defaultBargeInV16Options } from '../voiceV16/bargeInV16';
import type {
  BargeInV16CutReceipt,
  BargeInV16Event,
  BargeInV16EventSink,
  BargeInV16Hooks,
  BargeInV16Options,
  BargeInV16Stats,
} from '../voiceV16/bargeInV16';
import type { BargeInV15Frame } from '../voiceV15/bargeInV15';

export type BargeInV17ResumeAction = 'resume' | 'restart' | 'summarise' | 'drop';

export type BargeInV17InterruptionKind = 'question' | 'correction' | 'new-topic' | 'acknowledgement' | 'unclear';

const CORRECTION_WORDS = ['không', 'không phải', 'sai', 'nhầm', 'dừng', 'khoan', 'đợi đã', 'wrong', 'stop', 'wait'];
const ACKNOWLEDGEMENTS = new Set([
  'ừ', 'ừm', 'ừ ừ', 'ok', 'okay', 'đúng', 'đúng rồi', 'rồi', 'rồi rồi', 'vâng', 'dạ', 'yes', 'yeah', 'uh-huh', 'ừ đúng',
]);

/**
 * Classify the interrupting text. Pure and transparent: a trailing
 * `?` is a question; a leading correction word is a correction; a
 * short acknowledgement is an acknowledgement; anything else with
 * real content is a new topic; empty text is unclear.
 */
export function classifyInterruptionV17(text: string): BargeInV17InterruptionKind {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0) return 'unclear';
  if (trimmed.endsWith('?') || trimmed.endsWith('？')) return 'question';
  for (const word of CORRECTION_WORDS) {
    if (trimmed === word || trimmed.startsWith(`${word} `) || trimmed.startsWith(`${word},`)) return 'correction';
  }
  if (ACKNOWLEDGEMENTS.has(trimmed)) return 'acknowledgement';
  return 'new-topic';
}

export interface BargeInV17Options extends BargeInV16Options {
  /** Remaining chars at/below this → drop the tail (default 40). */
  minRemainingCharsToResume?: number;
  /** Spoken fraction at/above this + new topic → summarise (default 0.6). */
  summariseSpokenFraction?: number;
  /** Window for counting repeated cuts (ms, default 10000). */
  escalationWindowMs?: number;
  /** Max reply chars once escalated to level 2 (default 280). */
  escalatedMaxReplyChars?: number;
}

export function defaultBargeInV17Options(): Required<BargeInV17Options> {
  return {
    ...defaultBargeInV16Options(),
    minRemainingCharsToResume: 40,
    summariseSpokenFraction: 0.6,
    escalationWindowMs: 10000,
    escalatedMaxReplyChars: 280,
  };
}

export function validateBargeInV17Options(options: BargeInV17Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof BargeInV17Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('minRemainingCharsToResume', options.minRemainingCharsToResume, 0, 5000);
  check('summariseSpokenFraction', options.summariseSpokenFraction, 0, 1);
  check('escalationWindowMs', options.escalationWindowMs, 0, 120000);
  check('escalatedMaxReplyChars', options.escalatedMaxReplyChars, 20, 5000);
  if (options.coughMaxMs !== undefined && options.minSpeechMs !== undefined && options.coughMaxMs >= options.minSpeechMs) {
    errors.push('coughMaxMs must be smaller than minSpeechMs');
  }
  return errors;
}

/** What to do with the interrupted reply, decided at cut time. */
export interface BargeInV17ResumePlan {
  action: BargeInV17ResumeAction;
  /** Why this action (human-readable, for the log / panel). */
  reason: string;
  kind: BargeInV17InterruptionKind;
  /** Text to speak next (remaining text, recap, or '' for drop/restart). */
  resumeText: string;
  /** Chars of the reply already spoken when the cut landed. */
  spokenChars: number;
  /** Chars of the reply never spoken. */
  remainingChars: number;
  /** Fraction of the reply already spoken (0..1). */
  spokenFraction: number;
  /** Escalation level at cut time (0 = normal, 2 = replies shortened). */
  escalationLevel: number;
  /** When escalated, the next reply should be capped at this many chars (0 = no cap). */
  nextReplyMaxChars: number;
  /** For restart: the prompt the new reply should answer first. */
  restartPrompt: string;
}

/**
 * Decide the resume action for one cut. Pure: same cut +
 * interruption text always yields the same plan. The escalation
 * level is an input (the engine tracks it); the decision table is:
 * correction/question → restart; almost nothing left → drop;
 * acknowledgement → resume; new topic with most of the reply
 * spoken → summarise; otherwise resume. Escalation steps the
 * action toward shorter replies (resume → summarise → drop).
 */
export function decideBargeInResumeV17(
  cut: BargeInV16CutReceipt,
  interruptionText: string,
  options: BargeInV17Options = {},
  escalationLevel = 0,
): BargeInV17ResumePlan {
  const merged = { ...defaultBargeInV17Options(), ...options };
  const kind = classifyInterruptionV17(interruptionText);
  const spokenChars = cut.context.spokenChars;
  const remainingChars = cut.context.remainingChars;
  const total = spokenChars + remainingChars;
  const spokenFraction = total > 0 ? spokenChars / total : 0;
  const nextReplyMaxChars = escalationLevel >= 2 ? merged.escalatedMaxReplyChars : 0;

  let action: BargeInV17ResumeAction;
  let reason: string;
  if (kind === 'correction') {
    action = 'restart';
    reason = 'User corrected the reply — regenerate instead of continuing it.';
  } else if (kind === 'question') {
    action = 'restart';
    reason = 'User asked a question mid-reply — answer it first.';
  } else if (remainingChars <= merged.minRemainingCharsToResume) {
    action = 'drop';
    reason = `Only ${remainingChars} chars remained — the tail is not worth re-speaking.`;
  } else if (kind === 'acknowledgement') {
    action = 'resume';
    reason = 'User only acknowledged — continue from the cut point.';
  } else if (kind === 'new-topic' && spokenFraction >= merged.summariseSpokenFraction) {
    action = 'summarise';
    reason = `New topic after ${Math.round(spokenFraction * 100)}% was spoken — recap briefly, then switch.`;
  } else if (kind === 'unclear' && spokenFraction < 0.2) {
    action = 'resume';
    reason = 'Unclear interruption early in the reply — continue from the cut point.';
  } else {
    action = 'resume';
    reason = 'Continue the reply from the cut point.';
  }

  // Escalation steps toward shorter replies — except restart, which
  // the user explicitly asked for (a correction / question).
  if (escalationLevel >= 1 && action === 'resume') {
    action = 'summarise';
    reason += ' (escalated: repeated cuts — recap instead of resuming in full)';
  } else if (escalationLevel >= 2 && action === 'summarise') {
    action = 'drop';
    reason += ' (escalated: repeated cuts — drop the remainder)';
  }

  const spokenText = cut.context.spokenText.trim();
  const remainingText = cut.context.remainingText.trim();
  let resumeText = '';
  if (action === 'resume') resumeText = remainingText;
  else if (action === 'summarise') {
    resumeText = spokenText
      ? `Tóm lại phần vừa nói: “${spokenText}”. ${remainingText}`
      : remainingText;
  }
  return {
    action,
    reason,
    kind,
    resumeText,
    spokenChars,
    remainingChars,
    spokenFraction: Math.round(spokenFraction * 1000) / 1000,
    escalationLevel,
    nextReplyMaxChars,
    restartPrompt: action === 'restart' ? interruptionText.trim() : '',
  };
}

export type BargeInV17EventKind = 'cut' | 'resume-plan' | 'escalated' | 'captured' | 'cut-delayed' | 'rejected' | 'speech-started' | 'speech-ended';

export interface BargeInV17Event {
  kind: BargeInV17EventKind;
  atMs: number;
  receipt?: BargeInV16CutReceipt;
  plan?: BargeInV17ResumePlan;
  escalationLevel?: number;
  text?: string;
  reason?: string;
}

export type BargeInV17EventSink = (event: BargeInV17Event) => void;

export interface BargeInV17Stats extends BargeInV16Stats {
  plans: Partial<Record<BargeInV17ResumeAction, number>>;
  escalations: number;
  escalationLevel: number;
  cutsInWindow: number;
  restarts: number;
  resumes: number;
  summarises: number;
  drops: number;
}

export interface BargeInV17CutRecord {
  receipt: BargeInV16CutReceipt;
  plan: BargeInV17ResumePlan;
}

/**
 * Detector (v15) + cut (v16) + resume policy (v17). The session
 * feeds mic frames and the current TTS level; when the detector
 * confirms user speech during agent speech, the engine cuts, then
 * classifies the interruption and hands back a resume plan with
 * the receipt — the session applies the plan instead of guessing.
 */
export class BargeInEngineV17 {
  readonly engine: BargeInEngineV16;
  private readonly options: Required<BargeInV17Options>;
  private readonly sink: BargeInV17EventSink | undefined;
  private readonly records: BargeInV17CutRecord[] = [];
  private readonly cutTimesMs: number[] = [];
  private escalationLevel = 0;
  private escalations = 0;
  private lastPlan: BargeInV17ResumePlan | undefined;

  constructor(options: BargeInV17Options = {}, hooks: BargeInV16Hooks = {}, sink?: BargeInV17EventSink) {
    const merged = { ...defaultBargeInV17Options(), ...options };
    const errors = validateBargeInV17Options(merged);
    if (errors.length > 0) throw new Error(`invalid barge-in v17 options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
    this.engine = createBargeInEngineV16(
      merged,
      hooks,
      (event: BargeInV16Event) => {
        if (event.kind === 'cut' && event.receipt) {
          this.onCut(event.receipt);
          return;
        }
        if (event.kind === 'captured') {
          this.sink?.({ kind: 'captured', atMs: event.atMs, text: event.text });
          return;
        }
        this.sink?.({ kind: event.kind as BargeInV17EventKind, atMs: event.atMs, receipt: event.receipt, reason: event.reason });
      },
    );
  }

  beginAgentTurn(turnId: string, userText: string, replyText: string, atMs: number): void {
    this.engine.beginAgentTurn(turnId, userText, replyText, atMs);
  }

  endAgentTurn(): void {
    this.engine.endAgentTurn();
  }

  setTtsLevel(rms: number): void {
    this.engine.setTtsLevel(rms);
  }

  setAgentSpeaking(speaking: boolean): void {
    this.engine.setAgentSpeaking(speaking);
  }

  isAgentSpeaking(): boolean {
    return this.engine.isAgentSpeaking();
  }

  isCapturing(): boolean {
    return this.engine.isCapturing();
  }

  feed(frame: BargeInV15Frame): BargeInV16Event | undefined {
    return this.engine.feed(frame);
  }

  feedInterruptingText(text: string, atMs: number): void {
    this.engine.feedInterruptingText(text, atMs);
  }

  tick(atMs: number): BargeInV16CutReceipt | undefined {
    return this.engine.tick(atMs);
  }

  /**
   * Cut now and decide the resume plan. `interruptingText` is the
   * user's words so far (from STT partials); when omitted, the
   * text captured by the engine after the cut is used instead.
   */
  interrupt(atMs: number, interruptingText?: string): BargeInV17CutRecord | undefined {
    const receipt = this.engine.interrupt(atMs);
    if (!receipt) return undefined;
    // onCut (via the sink) already recorded the plan; find it.
    const record = this.records[this.records.length - 1];
    if (record && record.receipt === receipt && interruptingText !== undefined && interruptingText.trim().length > 0) {
      // The caller knew the interruption text before the cut fired:
      // re-decide with the real text.
      const plan = decideBargeInResumeV17(receipt, interruptingText, this.options, record.plan.escalationLevel);
      record.plan = plan;
      this.lastPlan = plan;
      this.sink?.({ kind: 'resume-plan', atMs, receipt, plan });
    }
    return record && record.receipt === receipt ? record : undefined;
  }

  lastCut(): BargeInV16CutReceipt | undefined {
    return this.engine.lastCut();
  }

  lastPlanForCut(): BargeInV17ResumePlan | undefined {
    return this.lastPlan;
  }

  cutsList(): BargeInV17CutRecord[] {
    return this.records.map((r) => ({ receipt: r.receipt, plan: { ...r.plan } }));
  }

  getEscalationLevel(): number {
    return this.escalationLevel;
  }

  stats(): BargeInV17Stats {
    const base: BargeInV16Stats = this.engine.stats();
    const plans: Partial<Record<BargeInV17ResumeAction, number>> = {};
    for (const r of this.records) plans[r.plan.action] = (plans[r.plan.action] ?? 0) + 1;
    return {
      ...base,
      plans,
      escalations: this.escalations,
      escalationLevel: this.escalationLevel,
      cutsInWindow: this.cutTimesMs.length,
      restarts: plans.restart ?? 0,
      resumes: plans.resume ?? 0,
      summarises: plans.summarise ?? 0,
      drops: plans.drop ?? 0,
    };
  }

  summary(): string {
    const s = this.stats();
    return `barge-in v17: ${s.cuts} cuts (${s.partialCuts} partial, ${s.fullCuts} full), ` +
      `plans resume=${s.resumes} restart=${s.restarts} summarise=${s.summarises} drop=${s.drops}, ` +
      `escalation=${s.escalationLevel}, avg cut ${s.averageCutLatencyMs} ms`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Barge-in v17',
      '',
      `- Cuts: ${s.cuts} (${s.partialCuts} partial, ${s.fullCuts} full); average cut latency ${s.averageCutLatencyMs} ms`,
      `- Resume plans: resume ${s.resumes}, restart ${s.restarts}, summarise ${s.summarises}, drop ${s.drops}`,
      `- Escalation level: ${s.escalationLevel} (escalations ${s.escalations}, cuts in window ${s.cutsInWindow})`,
      `- Echo suppressions: ${s.echoSuppressions}; interruptions captured: ${s.capturedInterruptions}`,
      '',
      '| Cut | Kind | Interruption | Plan | Spoken | Remaining |',
      '| ---: | --- | --- | --- | ---: | ---: |',
    ];
    for (const r of this.records) {
      lines.push(`| @${r.receipt.atMs} ms | ${r.receipt.kind} | ${r.plan.kind} | ${r.plan.action} | ${r.plan.spokenChars} | ${r.plan.remainingChars} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private onCut(receipt: BargeInV16CutReceipt): void {
    // Repeated cuts inside the window escalate the policy.
    const windowStart = receipt.atMs - this.options.escalationWindowMs;
    while (this.cutTimesMs.length > 0 && (this.cutTimesMs[0] as number) < windowStart) {
      this.cutTimesMs.shift();
    }
    this.cutTimesMs.push(receipt.atMs);
    const cutsInWindow = this.cutTimesMs.length;
    const level = cutsInWindow >= 3 ? 2 : cutsInWindow >= 2 ? 1 : 0;
    if (level > this.escalationLevel) {
      this.escalationLevel = level;
      this.escalations += 1;
      this.sink?.({ kind: 'escalated', atMs: receipt.atMs, escalationLevel: level, receipt });
    }
    const plan = decideBargeInResumeV17(receipt, receipt.interruptingText, this.options, this.escalationLevel);
    this.records.push({ receipt, plan });
    this.lastPlan = plan;
    this.sink?.({ kind: 'cut', atMs: receipt.atMs, receipt, plan });
    this.sink?.({ kind: 'resume-plan', atMs: receipt.atMs, receipt, plan });
  }
}

export function createBargeInEngineV17(
  options: BargeInV17Options = {},
  hooks: BargeInV16Hooks = {},
  sink?: BargeInV17EventSink,
): BargeInEngineV17 {
  return new BargeInEngineV17(options, hooks, sink);
}

export function bargeInV17Summary(engine: BargeInEngineV17): string {
  return engine.summary();
}

export function bargeInV17Markdown(engine: BargeInEngineV17): string {
  return engine.markdown();
}
