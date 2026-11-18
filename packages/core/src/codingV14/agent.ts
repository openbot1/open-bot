/**
 * Coding agent v14 — pipeline (v1.29, Đội T3).
 *
 * Nối 4 lớp v14 thành một vòng chạy hoàn chỉnh:
 *   step fn (model/scripted) → ghi reasoning block (sidecar + digest
 *   event) → ghi model.response / tool.call / tool.result / file.change
 *   vào event log (hash-chained, trong memory + RunLogStore khi có
 *   dataDir) → kiểm tra kẹt v2 → recovery (redirect / thu hẹp scope /
 *   hỏi user / rollback lần edit cuối / escalate) → kiểm tra condense
 *   tăng dần → lặp lại cho tới khi done / hết step / escalate.
 *
 * Agent KHÔNG gọi model thật: `stepFn` do caller inject (provider
 * thật, scripted, hoặc mock). Nhờ đó pipeline test được hoàn toàn
 * offline, và resume chỉ cần `V14ResumeState` (JSON) — reasoning
 * block + journal + condensation được khôi phục từ state/sidecar.
 */

import * as path from 'node:path';
import { GENESIS_PREV_HASH, hashRunEvent } from '../event-log/canonical';
import { RunLogStore } from '../event-log/store';
import type { AnyRunEvent, RunEventType } from '../event-log/types';
import {
  v14BuildContext,
  v14CondenseIncremental,
  v14RenderKeptEvent,
  v14SaveCondensation,
  v14ShouldCondense,
} from './condenserV14';
import { V14ReasoningStore } from './reasoningBlocks';
import {
  V14EditJournal,
  v14DetectStuck,
  v14ExecuteRecovery,
  v14PlanRecovery,
} from './stuckRecovery';
import { CodingV14Error, V14_DEFAULT_MAX_STEPS } from './types';
import type {
  V14AgentOptions,
  V14AgentReport,
  V14Condensation,
  V14RecoveryResult,
  V14ResumeState,
  V14StepFn,
  V14StepResult,
  V14StuckReport,
} from './types';

/** Thư mục con trong dataDir chứa run log chung. */
export const V14_RUN_LOG_SUBDIR = 'run-logs';

/** Thư mục con trong dataDir chứa reasoning sidecar. */
export const V14_REASONING_SUBDIR = 'reasoning';

/** Số event gần nhất render vào context khi chưa condense. */
export const V14_CONTEXT_TAIL_EVENTS = 20;

/** Một event trong memory (hash chain tính thật bằng hashRunEvent). */
function buildMemoryEvent(
  runId: string,
  seq: number,
  prevHash: string,
  type: RunEventType,
  payload: unknown,
  at: string,
): AnyRunEvent {
  const hash = hashRunEvent({ seq, runId, at, type, payload, prevHash });
  return { seq, runId, at, type, payload, prevHash, hash } as AnyRunEvent;
}

/** Arg keys của một tool call (log không giữ value — giống event-log). */
function toolArgKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args).sort();
}

/** Trạng thái nội bộ của một lần chạy agent. */
export interface V14AgentState {
  runId: string;
  prompt: string;
  events: AnyRunEvent[];
  step: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: Set<string>;
  condensations: V14Condensation[];
  stuckReports: V14StuckReport[];
  recoveries: V14RecoveryResult[];
  finalText: string;
}

/** Kết quả scripted step: một step cố định hoặc hàm theo step. */
export type V14ScriptedStep = V14StepResult | ((step: number) => V14StepResult);

/**
 * Step fn scripted cho test/eval: trả các step theo kịch bản có sẵn;
 * hết kịch bản thì trả done (text = note cuối). Deterministic.
 */
export function scriptedV14Agent(script: V14ScriptedStep[]): V14StepFn {
  return (step: number): V14StepResult => {
    if (step >= script.length) {
      return { text: 'Script finished.', toolCalls: [], done: true, note: 'script exhausted' };
    }
    const entry = script[step]!;
    return typeof entry === 'function' ? entry(step) : entry;
  };
}

/** Script lặp vô hạn cùng một action — dùng để test stuck + recovery. */
export function loopingV14Script(tool: string, times: number): V14ScriptedStep[] {
  const out: V14ScriptedStep[] = [];
  for (let i = 0; i < times; i += 1) {
    out.push({
      text: '',
      toolCalls: [
        {
          tool,
          args: { path: 'src/app.ts' },
          status: 'error',
          outputPreview: "TypeError: Cannot read properties of undefined (reading 'x')",
        },
      ],
      done: false,
    });
  }
  return out;
}

/**
 * Agent v14: giữ toàn bộ trạng thái chạy trong memory, mirror sang
 * đĩa khi có dataDir (RunLogStore + reasoning sidecar + condense
 * sidecar). Dùng `run()` cho một lần chạy; dùng `resumeState()` để
 * lấy state resume cho lần chạy sau.
 */
export class CodingAgentV14 {
  private readonly options: V14AgentOptions;
  private readonly reasoningStore: V14ReasoningStore;
  private readonly journal = new V14EditJournal();
  private readonly store: RunLogStore | null;
  private readonly logDir: string | null;
  /** Nội dung file trong memory (default file applier). */
  private readonly files = new Map<string, string | null>();
  private readonly state: V14AgentState;
  private lastHash: string = GENESIS_PREV_HASH;
  private recoveryGuidance: string | null = null;

  constructor(options: V14AgentOptions) {
    if (!options.runId || options.runId.trim() === '') {
      throw new CodingV14Error('agent-plan-invalid', 'runId must be a non-empty string.');
    }
    if (typeof options.stepFn !== 'function') {
      throw new CodingV14Error('agent-plan-invalid', 'stepFn must be a function.');
    }
    if (!options.prompt || options.prompt.trim() === '') {
      throw new CodingV14Error('agent-plan-invalid', 'prompt must be a non-empty string.');
    }
    this.options = options;
    if (options.dataDir) {
      this.logDir = path.join(options.dataDir, V14_RUN_LOG_SUBDIR);
      this.store = new RunLogStore({ logDir: this.logDir });
      this.reasoningStore = new V14ReasoningStore({ dataDir: path.join(options.dataDir, V14_REASONING_SUBDIR) });
    } else {
      this.logDir = null;
      this.store = null;
      this.reasoningStore = new V14ReasoningStore({});
    }
    const resume = options.resumeFrom;
    this.state = {
      runId: options.runId,
      prompt: options.prompt,
      events: [],
      step: resume?.nextStep ?? 0,
      toolCalls: 0,
      toolErrors: 0,
      filesChanged: new Set(),
      condensations: resume?.condensations ? [...resume.condensations] : [],
      stuckReports: [],
      recoveries: resume?.recoveries ? [...resume.recoveries] : [],
      finalText: '',
    };
    if (resume) {
      this.reasoningStore.importBlocks(resume.reasoningBlocks);
      for (const entry of resume.editJournal) {
        this.journal.record(entry.runId, entry.path, entry.beforeContent, entry.afterContent, entry.step, entry.seq, entry.createdAt);
        if (entry.undone) {
          const found = this.journal.find(entry.id);
          if (found) found.undone = true;
        }
      }
    }
  }

  /** Reasoning store (để test/inspect). */
  get reasoning(): V14ReasoningStore {
    return this.reasoningStore;
  }

  /** Edit journal (để test/inspect). */
  get edits(): V14EditJournal {
    return this.journal;
  }

  /** Event log trong memory (theo seq tăng dần). */
  get events(): AnyRunEvent[] {
    return [...this.state.events];
  }

  /** Nội dung file trong memory (default applier). */
  get fileContents(): ReadonlyMap<string, string | null> {
    return this.files;
  }

  /** File applier mặc định: ghi vào map trong memory. */
  private defaultApplier = (filePath: string, content: string | null): void => {
    this.files.set(filePath, content);
  };

  private fileApplier(): (filePath: string, content: string | null) => void {
    return this.options.fileApplier ?? this.defaultApplier;
  }

  /** Append một event: hash chain trong memory + mirror sang RunLogStore. */
  private appendEvent(type: RunEventType, payload: unknown): AnyRunEvent {
    const seq = this.state.events.length + 1;
    const at = new Date().toISOString();
    const event = buildMemoryEvent(this.state.runId, seq, this.lastHash, type, payload, at);
    this.state.events.push(event);
    this.lastHash = event.hash;
    if (this.store) {
      // Mirror: RunLogStore tự tính seq/hash (cùng thứ tự nên trùng seq);
      // sanitize có thể cắt chuỗi dài — event memory giữ bản đầy đủ.
      try {
        this.store.append(this.state.runId, { type, payload: payload as never });
      } catch {
        // Log hỏng không được làm hỏng run — event memory vẫn còn.
      }
    }
    return event;
  }

  /** Context cho step tiếp theo: condensed (nếu có) + tail + guidance. */
  private buildStepContext(): string {
    const last = this.state.condensations[this.state.condensations.length - 1];
    const base =
      last !== undefined
        ? v14BuildContext(this.state.events, last)
        : this.state.events
            .slice(-V14_CONTEXT_TAIL_EVENTS)
            .map((e) => v14RenderKeptEvent(e))
            .join('\n');
    const head = `Task: ${this.state.prompt}\nStep: ${this.state.step}`;
    const guidance = this.recoveryGuidance === null ? '' : `\n[Recovery guidance]\n${this.recoveryGuidance}`;
    return `${head}${guidance}\n[History]\n${base}`;
  }

  /** Chạy agent tới khi done / hết step / escalate / lỗi step. */
  run(): V14AgentReport {
    const maxSteps = this.options.maxSteps ?? V14_DEFAULT_MAX_STEPS;
    const autoCondense = this.options.autoCondense ?? true;
    const autoRecover = this.options.autoRecover ?? true;
    let outcome: V14AgentReport['outcome'] = 'max_steps';

    this.appendEvent('run.started', {
      botId: 'coding-v14',
      maxSteps,
      title: this.state.prompt.slice(0, 200),
    });
    this.appendEvent('run.prompt', { text: this.state.prompt.slice(0, 2000) });

    for (; this.state.step < maxSteps; this.state.step += 1) {
      const step = this.state.step;
      let result: V14StepResult;
      try {
        result = this.options.stepFn(step, this.buildStepContext());
      } catch (err) {
        this.state.finalText = `Step ${step} failed: ${err instanceof Error ? err.message : String(err)}`;
        this.appendEvent('run.failed', {
          message: this.state.finalText.slice(0, 500),
          steps: step,
          toolCalls: this.state.toolCalls,
          durationMs: 0,
        });
        outcome = 'failed';
        break;
      }
      if (!result || typeof result !== 'object' || !Array.isArray(result.toolCalls)) {
        throw new CodingV14Error('agent-step-invalid', `step ${step} returned an invalid V14StepResult.`);
      }

      // Reasoning block của step (sidecar + digest event).
      if (result.reasoning && result.reasoning.text.trim() !== '') {
        const block = this.reasoningStore.record({
          runId: this.state.runId,
          step,
          kind: result.reasoning.kind,
          text: result.reasoning.text,
          ...(result.reasoning.model ? { model: result.reasoning.model } : {}),
        });
        // Digest event vào event log (appendEvent tự mirror sang
        // RunLogStore khi có dataDir) để stuck/condense thấy đủ log.
        this.appendEvent('reasoning.block', this.reasoningStore.digestFor(block));
      }

      // Model response + tool calls/results + file changes.
      this.appendEvent('model.response', {
        step,
        text: result.text.slice(0, 2000),
        toolCalls: result.toolCalls.map((c, i) => ({
          callId: `call-${step}-${i}`,
          tool: c.tool,
          argKeys: toolArgKeys(c.args),
        })),
      });
      result.toolCalls.forEach((call, i) => {
        const callId = `call-${step}-${i}`;
        this.state.toolCalls += 1;
        if (call.status === 'error') this.state.toolErrors += 1;
        this.appendEvent('tool.call', { callId, tool: call.tool, argKeys: toolArgKeys(call.args), step });
        this.appendEvent('tool.result', {
          callId,
          tool: call.tool,
          status: call.status,
          outputPreview: call.outputPreview.slice(0, 500),
          durationMs: 0,
          step,
        });
        if (call.fileChange) {
          const fc = call.fileChange;
          this.state.filesChanged.add(fc.path);
          this.journal.record(
            this.state.runId,
            fc.path,
            fc.beforeContent ?? null,
            fc.afterContent ?? null,
            step,
            this.state.events.length,
          );
          this.fileApplier()(fc.path, fc.afterContent ?? null);
          this.appendEvent('file.change', {
            kind: fc.kind,
            path: fc.path,
            tool: call.tool,
            callId,
            step,
          });
        }
      });

      this.state.finalText = result.text;
      if (result.done) {
        this.appendEvent('run.completed', {
          finalText: result.text.slice(0, 500),
          steps: step + 1,
          toolCalls: this.state.toolCalls,
          durationMs: 0,
        });
        outcome = 'completed';
        this.state.step = step + 1;
        break;
      }

      // Stuck check + recovery (sau mỗi step).
      const stuckReport = v14DetectStuck(this.state.events, this.state.runId, this.options.stuckOptions);
      if (stuckReport.stuck) {
        this.state.stuckReports.push(stuckReport);
        const top = stuckReport.signals[0]!;
        this.appendEvent('stuck.detected', {
          step,
          kind: top.kind,
          detail: top.detail.slice(0, 500),
          ...(stuckReport.suggestionKey ? { suggestionKey: stuckReport.suggestionKey } : {}),
        });
        if (autoRecover) {
          const plan = v14PlanRecovery(this.state.runId, top, {
            hasLastEdit: this.journal.lastEdit() !== undefined,
            allowAskUser: this.options.allowAskUser ?? false,
            taskSummary: this.state.prompt,
            priorRecoveries: this.state.recoveries.length,
          });
          const first = plan.steps[0]!;
          let recovery: V14RecoveryResult;
          if (first.strategy === 'rollback_last_edit') {
            recovery = v14ExecuteRecovery(plan, {
              rollbackLastEdit: () => this.journal.rollbackLast(this.fileApplier()),
            });
          } else if (first.strategy === 'escalate') {
            recovery = v14ExecuteRecovery(plan, { escalate: (i) => i });
            const markerEvent = this.appendEvent('stuck.recovered', {
              step,
              strategy: recovery.strategy,
              signalKind: top.kind,
              detail: recovery.detail.slice(0, 500),
              applied: recovery.applied,
            });
            recovery = { ...recovery, markerSeq: markerEvent.seq };
            this.state.recoveries.push(recovery);
            this.appendEvent('run.failed', {
              message: `escalated after stuck signal: ${top.detail.slice(0, 300)}`,
              steps: step + 1,
              toolCalls: this.state.toolCalls,
              durationMs: 0,
            });
            outcome = 'stuck_unresolved';
            this.state.step = step + 1;
            break;
          } else {
            recovery = v14ExecuteRecovery(plan, {
              redirect: (i) => i,
              narrowScope: (i) => i,
              askUser: (i) => i,
            });
            this.recoveryGuidance = first.instruction;
          }
          // Tới đây strategy chỉ còn rollback/redirect/narrow_scope/
          // ask_user (nhánh escalate đã break ở trên) — ghi marker
          // stuck.recovered cho mọi recovery không escalate.
          const markerEvent = this.appendEvent('stuck.recovered', {
            step,
            strategy: recovery.strategy,
            signalKind: top.kind,
            detail: recovery.detail.slice(0, 500),
            applied: recovery.applied,
          });
          recovery = { ...recovery, markerSeq: markerEvent.seq };
          this.state.recoveries.push(recovery);
        }
      }

      // Auto-condense tăng dần khi vượt ngưỡng.
      if (autoCondense) {
        const check = v14ShouldCondense(this.state.events, this.options.condenseOptions);
        if (check.needed) {
          try {
            const condensation = v14CondenseIncremental(this.state.events, this.state.runId, this.options.condenseOptions);
            const marker = this.appendEvent('run.compacted', {
              upToSeq: condensation.upToSeq,
              summary: condensation.summary,
              eventsReplaced: condensation.eventsCovered,
              tokensBefore: condensation.tokensBefore,
              tokensAfter: condensation.tokensAfter,
            });
            const withMarker: V14Condensation = { ...condensation, markerSeq: marker.seq };
            this.state.condensations.push(withMarker);
            if (this.logDir) {
              try {
                v14SaveCondensation(this.logDir, withMarker);
              } catch {
                // Sidecar hỏng không làm hỏng run.
              }
            }
          } catch {
            // Condense hỏng không làm hỏng run — lần sau thử lại.
          }
        }
      }
    }

    if (outcome === 'max_steps') {
      this.appendEvent('run.failed', {
        message: `max steps reached (${maxSteps})`,
        steps: this.state.step,
        toolCalls: this.state.toolCalls,
        durationMs: 0,
      });
    }
    return this.report(outcome);
  }

  /** Báo cáo + trạng thái resume của lần chạy vừa xong. */
  report(outcome: V14AgentReport['outcome']): V14AgentReport {
    const resumeState: V14ResumeState = {
      runId: this.state.runId,
      prompt: this.state.prompt,
      nextStep: this.state.step,
      reasoningBlocks: this.reasoningStore.blocks(this.state.runId),
      editJournal: this.journal.all(),
      condensations: [...this.state.condensations],
      recoveries: [...this.state.recoveries],
      stepsRun: this.state.step,
    };
    return {
      runId: this.state.runId,
      outcome,
      stepsRun: this.state.step,
      toolCalls: this.state.toolCalls,
      toolErrors: this.state.toolErrors,
      filesChanged: [...this.state.filesChanged].sort(),
      reasoningBlocks: this.reasoningStore.blocks(this.state.runId).length,
      condensations: [...this.state.condensations],
      stuckReports: [...this.state.stuckReports],
      recoveries: [...this.state.recoveries],
      finalText: this.state.finalText,
      resumeState,
    };
  }

  /** Trạng thái resume hiện tại (không cần chạy xong). */
  resumeState(): V14ResumeState {
    return this.report('max_steps').resumeState;
  }
}

/** Chạy agent v14 một lần (shortcut qua class). */
export function runV14Agent(options: V14AgentOptions): V14AgentReport {
  return new CodingAgentV14(options).run();
}

/** Render ngắn báo cáo agent để hiển thị/log. */
export function renderV14AgentReport(report: V14AgentReport): string {
  const lines = [
    `[v14 agent run=${report.runId} outcome=${report.outcome} steps=${report.stepsRun} ` +
      `tools=${report.toolCalls} errors=${report.toolErrors} files=${report.filesChanged.length} ` +
      `reasoning=${report.reasoningBlocks} condensations=${report.condensations.length} ` +
      `stuck=${report.stuckReports.length} recoveries=${report.recoveries.length}]`,
  ];
  if (report.filesChanged.length > 0) lines.push(`Files: ${report.filesChanged.join(', ')}`);
  for (const c of report.condensations) {
    lines.push(`Condense: ${c.strategy} seq ${c.fromSeq + 1}..${c.upToSeq} saved ~${c.tokensSaved} tokens (${c.savedRatioPct}%)`);
  }
  for (const r of report.recoveries) {
    lines.push(`Recovery: ${r.strategy} applied=${r.applied} — ${r.detail.slice(0, 200)}`);
  }
  if (report.finalText !== '') lines.push(`Final: ${report.finalText.slice(0, 300)}`);
  return lines.join('\n');
}
