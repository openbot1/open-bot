/**
 * Task state machine có guard, v1.07 Đội T3.
 *
 * `history.ts` đã có bảng chuyển trạng thái hợp lệ + ghi lịch sử,
 * nhưng server tự gọi `setState` rời rạc ở nhiều chỗ — một lần
 * chuyển sai (vd `completed → working`) chỉ được ghi `legal: false`
 * vào lịch sử rồi đi tiếp, không ai chặn. Module này bọc một task
 * trong class có guard:
 *
 *  - `transition(to, note?)` — chuyển trạng thái, THROW
 *    `A2aIllegalTransitionError` khi chuyển bất hợp pháp (trừ khi
 *    caller bật `lenient: true` để giữ hành vi cũ: ghi lại + log
 *    cảnh báo). Mọi lần chuyển đều ghi vào `task.transitions`,
 *    cập nhật `status.timestamp` + `updatedAt`.
 *  - Helper theo ngữ nghĩa: `start()` (submitted → working),
 *    `requestInput(question)` (working → input-required),
 *    `complete(artifacts?)`, `fail(reason)`, `cancel(reason)`,
 *    `reject(reason)`, `resume()` (input-required → working),
 *    `addArtifact(artifact)` (chỉ khi task chưa tới trạng thái cuối).
 *  - `applyRunnerResult(result)` — dịch `A2aRunResult` của runner
 *    thành trạng thái cuối: `error` → failed, `needsInput` →
 *    input-required, còn lại → completed + artifact text.
 *  - `onProgress` / `emit` — phát event cho SSE layer: mỗi lần
 *    chuyển trạng thái hoặc có artifact mới đều gọi listener đã
 *    đăng ký (server HTTP đăng ký listener này để đẩy SSE, xem
 *    `server.ts` — `onEvent`).
 *
 * Class này KHÔNG chạy runner, KHÔNG gọi mạng — chỉ giữ trạng thái
 * đúng luật. Server hiện tại vẫn dùng `setState` nội bộ; sóng sau
 * có thể nối server sang class này mà không đổi wire format.
 */

import type { A2aArtifact, A2aRunResult, A2aTask, A2aTaskState, A2aTaskStatus } from './types';
import { isA2aTerminalState } from './types';
import { appendA2aTransition, isLegalA2aTransition, makeA2aTransition } from './history';

export type { A2aTaskState };

/** Lỗi khi chuyển trạng thái task bất hợp pháp (vd completed → working). */
export class A2aIllegalTransitionError extends Error {
  readonly from: A2aTaskState;
  readonly to: A2aTaskState;
  readonly taskId: string;
  constructor(taskId: string, from: A2aTaskState, to: A2aTaskState) {
    super(`Task ${taskId}: illegal A2A state transition ${from} → ${to}.`);
    this.name = 'A2aIllegalTransitionError';
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

/** Event state machine phát ra (SSE layer đăng ký nghe). */
export type A2aStateMachineEvent =
  | { kind: 'state-changed'; task: A2aTask; from: A2aTaskState | null; to: A2aTaskState; note?: string }
  | { kind: 'artifact'; task: A2aTask; artifact: A2aArtifact }
  | { kind: 'illegal-transition'; task: A2aTask; from: A2aTaskState; to: A2aTaskState };

export type A2aStateMachineListener = (event: A2aStateMachineEvent) => void;

/** Options của state machine. */
export interface A2aTaskStateMachineOptions {
  /**
   * Lenient: chuyển bất hợp pháp chỉ ghi lại + phát event
   * `illegal-transition`, không throw (hành vi cũ của server).
   * Mặc định false (strict: throw).
   */
  lenient?: boolean;
  /** Callback khi chuyển bất hợp pháp ở chế độ lenient (mặc định log stderr). */
  onIllegalTransition?: (error: A2aIllegalTransitionError) => void;
  /** Tối đa entry lịch sử chuyển trạng thái (mặc định 50, xem history.ts). */
  maxTransitions?: number;
}

/**
 * State machine có guard cho một task A2A. Giữ tham chiếu tới task
 * gốc (sửa tại chỗ, giống server) và phát event cho listener.
 */
export class A2aTaskStateMachine {
  private readonly task: A2aTask;
  private readonly listeners = new Set<A2aStateMachineListener>();
  private readonly lenient: boolean;
  private readonly onIllegalTransition: (error: A2aIllegalTransitionError) => void;
  private readonly maxTransitions: number;

  constructor(task: A2aTask, options: A2aTaskStateMachineOptions = {}) {
    this.task = task;
    this.lenient = options.lenient ?? false;
    this.onIllegalTransition =
      options.onIllegalTransition ??
      ((err) => {
        console.error(`[a2a] ${err.message}`);
      });
    this.maxTransitions = options.maxTransitions ?? 50;
    if (!task.transitions) task.transitions = [];
    if (!task.status) {
      task.status = { state: 'submitted', timestamp: new Date().toISOString() } as A2aTaskStatus;
    }
  }

  /** Task đang được giữ (tham chiếu gốc). */
  get current(): A2aTask {
    return this.task;
  }

  /** Trạng thái hiện tại. */
  get state(): A2aTaskState {
    return this.task.status.state;
  }

  /** True khi task đã tới trạng thái cuối. */
  get isTerminal(): boolean {
    return isA2aTerminalState(this.task.status.state);
  }

  /** Đăng ký listener nhận event (trả hàm hủy đăng ký). */
  onEvent(listener: A2aStateMachineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: A2aStateMachineEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener lỗi không được làm hỏng state machine.
      }
    }
  }

  /**
   * Chuyển trạng thái có guard. Chuyển hợp pháp: ghi transition,
   * cập nhật status + updatedAt, phát `state-changed`. Chuyển bất
   * hợp pháp: strict → throw (KHÔNG đổi trạng thái, nhưng vẫn ghi
   * transition `legal: false` vào lịch sử để không giấu lỗi);
   * lenient → vẫn chuyển + phát `illegal-transition`.
   */
  transition(to: A2aTaskState, note?: string): A2aTask {
    const from = this.task.status.state;
    const legal = isLegalA2aTransition(from, to);
    const now = new Date().toISOString();
    this.task.transitions = appendA2aTransition(
      this.task.transitions,
      makeA2aTransition(from, to, now, note),
      this.maxTransitions,
    );
    if (!legal) {
      const error = new A2aIllegalTransitionError(this.task.id, from, to);
      this.emit({ kind: 'illegal-transition', task: this.task, from, to });
      if (!this.lenient) throw error;
      this.onIllegalTransition(error);
    }
    this.task.status = {
      state: to,
      timestamp: now,
      ...(note !== undefined && note.length > 0
        ? { message: { kind: 'message', messageId: `msg-${Date.now()}`, role: 'agent', parts: [{ kind: 'text', text: note }] } }
        : this.task.status.message
          ? { message: this.task.status.message }
          : {}),
    };
    this.task.updatedAt = now;
    this.emit({ kind: 'state-changed', task: this.task, from, to, note });
    return this.task;
  }

  /** submitted → working (bắt đầu chạy runner). */
  start(note?: string): A2aTask {
    return this.transition('working', note);
  }

  /** working → input-required (runner cần thêm thông tin, kèm câu hỏi). */
  requestInput(question: string): A2aTask {
    return this.transition('input-required', question);
  }

  /** input-required → working (user đã bổ sung thông tin). */
  resume(note?: string): A2aTask {
    return this.transition('working', note);
  }

  /** working → completed (kèm artifact, nếu có). */
  complete(artifacts?: A2aArtifact[], note?: string): A2aTask {
    if (artifacts) {
      for (const artifact of artifacts) this.addArtifact(artifact);
    }
    return this.transition('completed', note);
  }

  /** → failed (kèm lý do, bắt buộc có để debug). */
  fail(reason: string): A2aTask {
    return this.transition('failed', reason);
  }

  /** → cancelled (user / client hủy). */
  cancel(reason?: string): A2aTask {
    return this.transition('cancelled', reason);
  }

  /** submitted/auth-required → rejected (từ chối nhận task). */
  reject(reason?: string): A2aTask {
    return this.transition('rejected', reason);
  }

  /**
   * Thêm artifact vào task. Chỉ cho khi task chưa tới trạng thái
   * cuối — thêm artifact vào task đã completed là lỗi lập trình
   * (throw). Phát event `artifact` để SSE đẩy về client.
   */
  addArtifact(artifact: A2aArtifact): A2aTask {
    if (this.isTerminal) {
      throw new Error(`Task ${this.task.id}: cannot add an artifact to a ${this.state} task.`);
    }
    if (!this.task.artifacts) this.task.artifacts = [];
    this.task.artifacts.push(artifact);
    this.task.updatedAt = new Date().toISOString();
    this.emit({ kind: 'artifact', task: this.task, artifact });
    return this.task;
  }

  /**
   * Dịch kết quả runner (`A2aRunResult`) thành trạng thái cuối:
   * `error` → failed; `needsInput` → input-required (kèm câu hỏi);
   * còn lại → completed + một artifact text từ `text`/`artifacts`.
   * Runner trả cả `error` và `needsInput` thì `error` thắng.
   */
  applyRunnerResult(result: A2aRunResult): A2aTask {
    if (result.error !== undefined && result.error.length > 0) {
      return this.fail(result.error);
    }
    if (result.needsInput !== undefined && result.needsInput.length > 0) {
      return this.requestInput(result.needsInput);
    }
    const artifacts: A2aArtifact[] = [...(result.artifacts ?? [])];
    if (result.text !== undefined && result.text.length > 0 && artifacts.length === 0) {
      artifacts.push({
        artifactId: `artifact-${Date.now()}`,
        name: 'result',
        parts: [{ kind: 'text', text: result.text }],
      });
    }
    return this.complete(artifacts);
  }

  /** Tóm tắt lịch sử chuyển trạng thái dạng "submitted → working → completed". */
  summarizeHistory(): string {
    const history = this.task.transitions ?? [];
    if (history.length === 0) return `(no transitions recorded)`;
    const states: string[] = [];
    if (history[0].from) states.push(history[0].from);
    for (const t of history) states.push(t.to);
    return states.join(' → ');
  }
}

/**
 * Tạo một task mới ở trạng thái `submitted` + state machine giữ nó.
 * `createdAt`/`updatedAt` điền sẵn; transition đầu tiên
 * (null → submitted) được ghi vào lịch sử.
 */
export function createA2aTaskWithStateMachine(
  input: { id: string; contextId: string; history?: A2aTask['history']; metadata?: Record<string, unknown>; tenantId?: string },
  options: A2aTaskStateMachineOptions = {},
): { task: A2aTask; machine: A2aTaskStateMachine } {
  const now = new Date().toISOString();
  const task: A2aTask = {
    id: input.id,
    contextId: input.contextId,
    status: { state: 'submitted', timestamp: now },
    history: input.history ?? [],
    metadata: input.metadata,
    tenantId: input.tenantId,
    createdAt: now,
    updatedAt: now,
    transitions: [makeA2aTransition(null, 'submitted', now)],
  };
  return { task, machine: new A2aTaskStateMachine(task, options) };
}
