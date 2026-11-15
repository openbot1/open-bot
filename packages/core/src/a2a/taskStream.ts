/**
 * A2A task streaming v1.1 (v1.09, Đội T4) — stream + resume task updates.
 *
 * A2A 1.0 đã có streaming qua SSE (task status/artifact updates) nhưng
 * stream ngắt là mất: client phải poll lại từ đầu. v1.1 thêm:
 *  - Event stream có sequence: mỗi update của một task mang số thứ tự
 *    tăng dần (per-task), client biết mình đã nhận tới đâu.
 *  - Checkpoint: snapshot trạng thái task tại một sequence (state +
 *    artifacts đã có) — client resume từ checkpoint thay vì replay
 *    toàn bộ lịch sử.
 *  - Replay có chọn lọc: `replayFrom(sequence)` chỉ trả event từ
 *    sequence đó trở đi; event cũ hơn bị cắt theo giới hạn buffer.
 *  - Gap detection: client nhận sequence không liên tục (vd nhận 5
 *    rồi 8) biết ngay mình mất event 6–7 và xin replay thay vì hiển
 *    thị trạng thái sai.
 *  - Artifact updates theo chunk: artifact lớn được gửi thành nhiều
 *    `artifact-update` (append) rồi một `artifact-complete`, renderer
 *    ghép lại thay vì chờ artifact đầy đủ mới hiện.
 *
 * Module này là log thuần trong bộ nhớ (một log cho mỗi task), không
 * gọi mạng. Server A2A gắn log này vào task stream SSE của mình;
 * client dùng `TaskStreamLog` ở phía nhận để ghép event thành trạng
 * thái task hiện tại.
 */

import type { A2aArtifact, A2aTask, A2aTaskState } from './types';
import { isA2aTerminalState } from './types';

/** Loại update trong stream task v1.1. */
export type A2aTaskStreamEventKind =
  | 'status-update'
  | 'artifact-update'
  | 'artifact-complete'
  | 'message-append'
  | 'checkpoint';

/** Một update trong stream của một task. */
export interface A2aTaskStreamEvent {
  /** Task mà update này thuộc về. */
  taskId: string;
  /** Số thứ tự tăng dần trong stream của task (0-based). */
  sequence: number;
  /** Loại update. */
  kind: A2aTaskStreamEventKind;
  /** ISO-8601 lúc server tạo update. */
  timestamp: string;
  /** Trạng thái mới (status-update). */
  state?: A2aTaskState;
  /** Text kèm trạng thái (lý do failed, câu hỏi input-required...). */
  text?: string;
  /** Artifact (artifact-update: chunk mới; artifact-complete: artifact đầy đủ). */
  artifact?: A2aArtifact;
  /** true khi artifact-update này là chunk cuối trước artifact-complete. */
  isLastChunk?: boolean;
  /** Text message append (message-append: thêm vào history). */
  messageText?: string;
  /** Tenant sở hữu task (để stream không lộ task tenant khác). */
  tenantId?: string;
}

/** Checkpoint: trạng thái task tại một sequence (để resume nhanh). */
export interface A2aTaskStreamCheckpoint {
  taskId: string;
  /** Sequence của event cuối cùng đã gộp vào checkpoint. */
  sequence: number;
  /** Trạng thái task tại checkpoint. */
  state: A2aTaskState;
  /** Artifact đã hoàn chỉnh tới checkpoint. */
  artifacts: A2aArtifact[];
  /** Text đã gộp tới checkpoint (từ message-append). */
  textSoFar: string;
  /** ISO-8601 lúc tạo checkpoint. */
  createdAt: string;
  /** true khi task đã tới trạng thái cuối tại checkpoint. */
  terminal: boolean;
}

/** Trạng thái task đã ghép từ stream (phía client). */
export interface A2aTaskStreamView {
  taskId: string;
  state: A2aTaskState;
  /** Sequence của event cuối đã áp dụng. */
  lastSequence: number;
  /** Số event đã áp dụng. */
  appliedEvents: number;
  /** Số event bị bỏ vì trùng/lỗi thời (sequence <= lastSequence). */
  skippedDuplicates: number;
  /** Số khoảng trống đã phát hiện (sequence nhảy cóc). */
  gapsDetected: number;
  /** Sequence còn thiếu (để client xin replay), vd [6, 7]. */
  missingSequences: number[];
  artifacts: A2aArtifact[];
  textSoFar: string;
  terminal: boolean;
}

/** Số event tối đa giữ trong một task stream log (cũ nhất bị cắt). */
export const A2A_TASK_STREAM_BUFFER_PER_TASK = 500;

/** Cứ bao nhiêu event thì log tự tạo checkpoint một lần. */
export const A2A_TASK_STREAM_CHECKPOINT_EVERY = 25;

/**
 * Log stream của một task (phía server): append update, tạo
 * checkpoint, replay từ sequence. Cắt buffer cũ khi quá giới hạn —
 * client resume quá muộn (sequence đã bị cắt) nhận `replayFrom`
 * rỗng + cờ `truncated=true` để tự fetch task đầy đủ thay vì chờ.
 */
export class TaskStreamLog {
  private readonly events: A2aTaskStreamEvent[] = [];
  private nextSequence = 0;
  private checkpoint: A2aTaskStreamCheckpoint | null = null;
  private currentState: A2aTaskState = 'submitted';
  private readonly artifacts = new Map<string, A2aArtifact>();
  private textSoFar = '';
  private truncatedFrom = 0;

  constructor(
    readonly taskId: string,
    readonly tenantId?: string,
  ) {}

  /** Số event đang giữ trong buffer. */
  get size(): number {
    return this.events.length;
  }

  /** Sequence sẽ gán cho event tiếp theo. */
  get nextSeq(): number {
    return this.nextSequence;
  }

  /** Sequence nhỏ nhất còn trong buffer (0 khi chưa cắt gì). */
  get oldestSequence(): number {
    return this.truncatedFrom;
  }

  /** Trạng thái task hiện tại theo log. */
  get state(): A2aTaskState {
    return this.currentState;
  }

  /** Checkpoint mới nhất (null khi chưa tới mốc checkpoint). */
  get latestCheckpoint(): A2aTaskStreamCheckpoint | null {
    return this.checkpoint ? { ...this.checkpoint, artifacts: this.checkpoint.artifacts.map((a) => ({ ...a })) } : null;
  }

  /** Append một status update; trả event đã gán sequence. */
  appendStatus(state: A2aTaskState, text?: string): A2aTaskStreamEvent {
    const event = this.append({
      kind: 'status-update',
      state,
      ...(text !== undefined ? { text } : {}),
    });
    this.currentState = state;
    this.maybeCheckpoint();
    return event;
  }

  /** Append một chunk artifact (artifact lớn gửi nhiều chunk). */
  appendArtifactChunk(
    artifact: A2aArtifact,
    isLastChunk = false,
  ): A2aTaskStreamEvent {
    const event = this.append({
      kind: 'artifact-update',
      artifact: { ...artifact, parts: artifact.parts.map((p) => ({ ...p })) },
      isLastChunk,
    });
    return event;
  }

  /** Append artifact hoàn chỉnh (artifact nhỏ, gửi một lần). */
  appendArtifactComplete(artifact: A2aArtifact): A2aTaskStreamEvent {
    const stored: A2aArtifact = { ...artifact, parts: artifact.parts.map((p) => ({ ...p })) };
    this.artifacts.set(stored.artifactId, stored);
    const event = this.append({ kind: 'artifact-complete', artifact: stored });
    this.maybeCheckpoint();
    return event;
  }

  /** Append text message (thêm vào history/text gộp). */
  appendMessage(text: string): A2aTaskStreamEvent {
    const event = this.append({ kind: 'message-append', messageText: text });
    this.textSoFar += text;
    return event;
  }

  /**
   * Replay event từ `fromSequence` (inclusive). Trả `{ events,
   * truncated }`: `truncated=true` khi `fromSequence` đã bị cắt khỏi
   * buffer — client phải fetch task đầy đủ thay vì chỉ replay.
   */
  replayFrom(fromSequence: number): { events: A2aTaskStreamEvent[]; truncated: boolean } {
    if (fromSequence < this.truncatedFrom) {
      return { events: this.events.map((e) => ({ ...e })), truncated: true };
    }
    return {
      events: this.events.filter((e) => e.sequence >= fromSequence).map((e) => ({ ...e })),
      truncated: false,
    };
  }

  /** Tạo checkpoint ngay (bất kể mốc tự động). */
  makeCheckpoint(): A2aTaskStreamCheckpoint {
    const cp: A2aTaskStreamCheckpoint = {
      taskId: this.taskId,
      sequence: this.nextSequence - 1,
      state: this.currentState,
      artifacts: [...this.artifacts.values()].map((a) => ({ ...a, parts: a.parts.map((p) => ({ ...p })) })),
      textSoFar: this.textSoFar,
      createdAt: new Date().toISOString(),
      terminal: isA2aTerminalState(this.currentState),
    };
    this.checkpoint = cp;
    return { ...cp, artifacts: cp.artifacts.map((a) => ({ ...a })) };
  }

  /** Snapshot trạng thái hiện tại (để server trả task đầy đủ khi client resume muộn). */
  snapshot(): { state: A2aTaskState; artifacts: A2aArtifact[]; textSoFar: string; lastSequence: number } {
    return {
      state: this.currentState,
      artifacts: [...this.artifacts.values()].map((a) => ({ ...a, parts: a.parts.map((p) => ({ ...p })) })),
      textSoFar: this.textSoFar,
      lastSequence: this.nextSequence - 1,
    };
  }

  private append(
    partial: Omit<A2aTaskStreamEvent, 'taskId' | 'sequence' | 'timestamp' | 'tenantId'>,
  ): A2aTaskStreamEvent {
    const event: A2aTaskStreamEvent = {
      taskId: this.taskId,
      sequence: this.nextSequence,
      timestamp: new Date().toISOString(),
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      ...partial,
    };
    this.events.push(event);
    this.nextSequence += 1;
    while (this.events.length > A2A_TASK_STREAM_BUFFER_PER_TASK) {
      this.events.shift();
      this.truncatedFrom += 1;
    }
    return { ...event };
  }

  private maybeCheckpoint(): void {
    if (this.nextSequence > 0 && this.nextSequence % A2A_TASK_STREAM_CHECKPOINT_EVERY === 0) {
      this.makeCheckpoint();
    }
  }
}

/**
 * Ghép event stream thành trạng thái task (phía client/renderer).
 * Áp dụng event theo sequence: trùng/bỏ qua event cũ, ghi nhận gap
 * khi sequence nhảy cóc (không tự đoán event thiếu — client xin
 * replay bằng `missingSequences`).
 */
export class TaskStreamView {
  private lastSequence = -1;
  private appliedEvents = 0;
  private skippedDuplicates = 0;
  private gapsDetected = 0;
  private readonly missing = new Set<number>();
  private state: A2aTaskState = 'submitted';
  private readonly artifacts = new Map<string, A2aArtifact>();
  private readonly pendingChunks = new Map<string, A2aArtifact[]>();
  private textSoFar = '';

  constructor(readonly taskId: string) {}

  /** Nạp checkpoint trước khi áp event (resume nhanh). */
  loadCheckpoint(cp: A2aTaskStreamCheckpoint): void {
    if (cp.taskId !== this.taskId) return;
    if (cp.sequence < this.lastSequence) return;
    this.lastSequence = cp.sequence;
    this.state = cp.state;
    this.textSoFar = cp.textSoFar;
    this.artifacts.clear();
    for (const artifact of cp.artifacts) this.artifacts.set(artifact.artifactId, { ...artifact });
    this.pendingChunks.clear();
    this.missing.clear();
  }

  /**
   * Áp một event. Trả true khi event được áp, false khi bị bỏ
   * (trùng/cũ/sai task). Gap được ghi lại chứ không throw.
   */
  apply(event: A2aTaskStreamEvent): boolean {
    if (event.taskId !== this.taskId) return false;
    if (event.sequence <= this.lastSequence) {
      this.skippedDuplicates += 1;
      return false;
    }
    if (event.sequence > this.lastSequence + 1) {
      this.gapsDetected += 1;
      for (let s = this.lastSequence + 1; s < event.sequence; s++) this.missing.add(s);
    }
    this.missing.delete(event.sequence);
    this.lastSequence = event.sequence;
    this.appliedEvents += 1;
    switch (event.kind) {
      case 'status-update':
        if (event.state !== undefined) this.state = event.state;
        if (event.text !== undefined) this.textSoFar += event.text;
        break;
      case 'artifact-update':
        if (event.artifact !== undefined) {
          const chunks = this.pendingChunks.get(event.artifact.artifactId) ?? [];
          chunks.push({ ...event.artifact, parts: event.artifact.parts.map((p) => ({ ...p })) });
          this.pendingChunks.set(event.artifact.artifactId, chunks);
          if (event.isLastChunk) {
            const merged = mergeArtifactChunks(event.artifact.artifactId, chunks);
            this.artifacts.set(merged.artifactId, merged);
            this.pendingChunks.delete(event.artifact.artifactId);
          }
        }
        break;
      case 'artifact-complete':
        if (event.artifact !== undefined) {
          this.artifacts.set(event.artifact.artifactId, {
            ...event.artifact,
            parts: event.artifact.parts.map((p) => ({ ...p })),
          });
        }
        break;
      case 'message-append':
        if (event.messageText !== undefined) this.textSoFar += event.messageText;
        break;
      case 'checkpoint':
        // Checkpoint qua stream chỉ là gợi ý — client tự fetch
        // checkpoint đầy đủ bằng TaskStreamLog, không áp ở đây.
        break;
    }
    return true;
  }

  /** Áp nhiều event theo thứ tự sequence (tự sắp xếp). */
  applyAll(events: readonly A2aTaskStreamEvent[]): { applied: number; skipped: number } {
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    let applied = 0;
    let skipped = 0;
    for (const event of sorted) {
      if (this.apply(event)) applied += 1;
      else skipped += 1;
    }
    return { applied, skipped };
  }

  /** Trạng thái hiện tại đã ghép. */
  view(): A2aTaskStreamView {
    return {
      taskId: this.taskId,
      state: this.state,
      lastSequence: this.lastSequence,
      appliedEvents: this.appliedEvents,
      skippedDuplicates: this.skippedDuplicates,
      gapsDetected: this.gapsDetected,
      missingSequences: [...this.missing].sort((a, b) => a - b),
      artifacts: [...this.artifacts.values()].map((a) => ({ ...a })),
      textSoFar: this.textSoFar,
      terminal: isA2aTerminalState(this.state),
    };
  }
}

/** Ghép các chunk artifact thành một artifact (nối part text theo thứ tự). */
export function mergeArtifactChunks(artifactId: string, chunks: readonly A2aArtifact[]): A2aArtifact {
  if (chunks.length === 0) {
    return { artifactId, parts: [] };
  }
  const first = chunks[0];
  const parts: A2aArtifact['parts'] = [];
  for (const chunk of chunks) {
    for (const part of chunk.parts) {
      if (part.kind === 'text' && parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last.kind === 'text') {
          parts[parts.length - 1] = { kind: 'text', text: last.text + part.text };
          continue;
        }
      }
      parts.push({ ...part });
    }
  }
  return {
    artifactId,
    ...(first.name !== undefined ? { name: first.name } : {}),
    ...(first.description !== undefined ? { description: first.description } : {}),
    parts,
  };
}

/**
 * Build event stream mở đầu cho một task từ task đã có (server tạo
 * log khi task được tạo): một status-update với trạng thái hiện tại
 * + artifact-complete cho mỗi artifact đã có. Dùng khi client
 * subscribe muộn mà không có checkpoint.
 */
export function seedTaskStreamEvents(task: A2aTask, log: TaskStreamLog): A2aTaskStreamEvent[] {
  const events: A2aTaskStreamEvent[] = [];
  events.push(log.appendStatus(task.status.state, task.status.message ? undefined : undefined));
  for (const artifact of task.artifacts ?? []) {
    events.push(log.appendArtifactComplete(artifact));
  }
  return events;
}
