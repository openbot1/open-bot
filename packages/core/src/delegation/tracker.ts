/**
 * Delegation v2 — tracker (v1.04, Đội T4).
 *
 * Theo dõi tiến độ ủy quyền: session + từng con, lifecycle rõ ràng,
 * trạng thái session suy ra từ các con (không set tay lung tung).
 *
 * - `createSession`: đăng ký một lần ủy quyền (1..n con) + chiến lược
 *   hợp nhất. Session mới ở `pending`.
 * - `startChild` / `updateChildProgress` / `completeChild` /
 *   `failChild` / `timeoutChild`: chuyển trạng thái con; mỗi lần đổi
 *   đều tính lại trạng thái session.
 * - `refreshChildFromLog`: khi biết `childRunId` của con, fold event
 *   log của con để cập nhật tiến độ THẬT (steps, tool calls, trạng
 *   thái fold) — không cần con báo cáo, log là đủ.
 * - Tracker là in-memory (giống `RunControlRegistry`): restart process
 *   thì session mất, nhưng log của cha/con vẫn còn trên đĩa để audit.
 *   Session đã xong giữ lại để `delegation_status` đọc; caller tự
 *   `prune` khi đầy.
 */

import { randomUUID } from 'node:crypto';

import { foldEvents } from '../event-log/replay';
import type {
  DelegationChildInput,
  DelegationChildProgress,
  DelegationChildRecord,
  DelegationChildResult,
  DelegationChildStatus,
  DelegationLogStore,
  DelegationMergeReport,
  DelegationMergeStrategy,
  DelegationSession,
  DelegationSessionStatus,
} from './types';

/** Số session tối đa tracker giữ (mặc định 200, tránh rò bộ nhớ). */
export const DELEGATION_TRACKER_MAX_SESSIONS = 200;

/** Tóm tắt tiến độ một session (để UI/tool `delegation_status` đọc). */
export interface DelegationSessionSummary {
  id: string;
  status: DelegationSessionStatus;
  strategy: DelegationMergeStrategy;
  childrenTotal: number;
  childrenDone: number;
  childrenError: number;
  childrenTimeout: number;
  childrenRunning: number;
  /** % con đã xong (terminal) — 0..100. */
  progressPct: number;
  elapsedMs: number;
  /** Tên + trạng thái từng con (ngắn gọn cho UI). */
  children: Array<{ name: string; status: DelegationChildStatus; steps?: number; toolCalls?: number }>;
}

/** Tính trạng thái session từ trạng thái các con. */
export function deriveSessionStatus(children: readonly DelegationChildRecord[]): DelegationSessionStatus {
  if (children.length === 0) return 'pending';
  const statuses = children.map((c) => c.status);
  if (statuses.every((s) => s === 'pending')) return 'pending';
  const allTerminal = statuses.every((s) => s === 'done' || s === 'error' || s === 'timeout');
  if (!allTerminal) return 'running';
  // Mọi con đã terminal.
  if (statuses.some((s) => s === 'timeout')) return 'timeout';
  if (statuses.some((s) => s === 'error')) return 'error';
  return 'done';
}

/** Tracker session ủy quyền (in-memory). */
export class DelegationTracker {
  private readonly sessions = new Map<string, DelegationSession>();
  private readonly maxSessions: number;

  constructor(maxSessions = DELEGATION_TRACKER_MAX_SESSIONS) {
    this.maxSessions = maxSessions;
  }

  /** Số session đang giữ. */
  get size(): number {
    return this.sessions.size;
  }

  /** Tạo session mới (con ở `pending`). */
  createSession(
    children: DelegationChildInput[],
    options: { parentRunId?: string; strategy?: DelegationMergeStrategy } = {},
  ): DelegationSession {
    if (children.length === 0) {
      throw new Error('Delegation: cần ít nhất một agent con.');
    }
    const names = new Set<string>();
    for (const child of children) {
      if (child.name.trim() === '') throw new Error('Delegation: tên con rỗng.');
      if (child.task.trim() === '') throw new Error(`Delegation: task của con "${child.name}" rỗng.`);
      if (names.has(child.name)) throw new Error(`Delegation: tên con "${child.name}" bị trùng.`);
      names.add(child.name);
    }
    const session: DelegationSession = {
      id: randomUUID(),
      ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
      children: children.map((input) => ({ input, status: 'pending' as const })),
      strategy: options.strategy ?? 'concat',
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    this.evictOldest();
    return this.copy(session);
  }

  /** Đọc session (bản sao — sửa ngoài không ảnh hưởng tracker). */
  getSession(id: string): DelegationSession | undefined {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : this.copy(session);
  }

  /** Liệt kê session (mới nhất trước, lọc theo status nếu cần). */
  listSessions(status?: DelegationSessionStatus): DelegationSession[] {
    const all = [...this.sessions.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return (status === undefined ? all : all.filter((s) => s.status === status)).map((s) => this.copy(s));
  }

  /** Đánh dấu con bắt đầu chạy (pending → running). */
  startChild(sessionId: string, childName: string, opts: { childRunId?: string } = {}): DelegationSession {
    return this.mutate(sessionId, (session) => {
      const child = this.childOf(session, childName);
      if (child.status !== 'pending') {
        throw new Error(`Delegation: con "${childName}" đang ở ${child.status}, không start lại được.`);
      }
      child.status = 'running';
      child.startedAt = new Date().toISOString();
      if (opts.childRunId !== undefined) child.childRunId = opts.childRunId;
    });
  }

  /** Cập nhật tiến độ con đang chạy (steps/toolCalls/note). */
  updateChildProgress(
    sessionId: string,
    childName: string,
    progress: Omit<DelegationChildProgress, 'lastUpdateAt'>,
  ): DelegationSession {
    return this.mutate(sessionId, (session) => {
      const child = this.childOf(session, childName);
      if (child.status !== 'running') {
        throw new Error(`Delegation: con "${childName}" đang ở ${child.status}, không cập nhật tiến độ được.`);
      }
      child.progress = { ...progress, lastUpdateAt: new Date().toISOString() };
    });
  }

  /** Đánh dấu con xong (running → done) + kết quả. */
  completeChild(sessionId: string, childName: string, result: DelegationChildResult): DelegationSession {
    return this.mutate(sessionId, (session) => {
      const child = this.childOf(session, childName);
      if (child.status !== 'running') {
        throw new Error(`Delegation: con "${childName}" đang ở ${child.status}, không complete được.`);
      }
      child.status = 'done';
      child.endedAt = new Date().toISOString();
      child.result = result;
      if (result.childRunId !== undefined) child.childRunId = result.childRunId;
      if (result.steps !== undefined || result.toolCalls !== undefined) {
        child.progress = {
          ...(result.steps !== undefined ? { steps: result.steps } : {}),
          ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
          lastUpdateAt: new Date().toISOString(),
        };
      }
      this.finishSessionIfDone(session);
    });
  }

  /** Đánh dấu con lỗi (running → error) + kết quả lỗi. */
  failChild(sessionId: string, childName: string, result: DelegationChildResult): DelegationSession {
    return this.mutate(sessionId, (session) => {
      const child = this.childOf(session, childName);
      if (child.status !== 'running') {
        throw new Error(`Delegation: con "${childName}" đang ở ${child.status}, không fail được.`);
      }
      child.status = 'error';
      child.endedAt = new Date().toISOString();
      child.result = { ...result, status: 'error' };
      this.finishSessionIfDone(session);
    });
  }

  /** Đánh dấu con timeout (running → timeout) + kết quả timeout. */
  timeoutChild(sessionId: string, childName: string, result: DelegationChildResult): DelegationSession {
    return this.mutate(sessionId, (session) => {
      const child = this.childOf(session, childName);
      if (child.status !== 'running') {
        throw new Error(`Delegation: con "${childName}" đang ở ${child.status}, không timeout được.`);
      }
      child.status = 'timeout';
      child.endedAt = new Date().toISOString();
      child.result = { ...result, status: 'timeout' };
      this.finishSessionIfDone(session);
    });
  }

  /** Ghi kết quả hợp nhất vào session đã xong (do caller merge xong gọi). */
  setMerged(sessionId: string, mergedOutput: string, report: DelegationMergeReport): DelegationSession {
    return this.mutate(sessionId, (session) => {
      if (session.status === 'pending' || session.status === 'running') {
        throw new Error('Delegation: chỉ set merged khi mọi con đã xong.');
      }
      session.mergedOutput = mergedOutput;
      session.mergeReport = report;
    });
  }

  /** Tóm tắt tiến độ session (để UI/tool đọc nhanh). */
  summarize(sessionId: string): DelegationSessionSummary {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Không tìm thấy delegation ${sessionId}.`);
    const terminal = session.children.filter(
      (c) => c.status === 'done' || c.status === 'error' || c.status === 'timeout',
    ).length;
    const endedAt = session.endedAt !== undefined ? Date.parse(session.endedAt) : Date.now();
    return {
      id: session.id,
      status: session.status,
      strategy: session.strategy,
      childrenTotal: session.children.length,
      childrenDone: session.children.filter((c) => c.status === 'done').length,
      childrenError: session.children.filter((c) => c.status === 'error').length,
      childrenTimeout: session.children.filter((c) => c.status === 'timeout').length,
      childrenRunning: session.children.filter((c) => c.status === 'running').length,
      progressPct:
        session.children.length === 0
          ? 0
          : Math.round((terminal / session.children.length) * 100),
      elapsedMs: endedAt - Date.parse(session.startedAt),
      children: session.children.map((c) => ({
        name: c.input.name,
        status: c.status,
        ...(c.progress?.steps !== undefined ? { steps: c.progress.steps } : {}),
        ...(c.progress?.toolCalls !== undefined ? { toolCalls: c.progress.toolCalls } : {}),
      })),
    };
  }

  /**
   * Refresh tiến độ một con từ event log của nó (khi biết childRunId):
   * fold log con → steps/toolCalls/trạng thái. Không đổi kết quả con
   * (chỉ tiến độ). Trả session sau refresh; ném lỗi khi con chưa có
   * childRunId hoặc log con không tồn tại.
   */
  refreshChildFromLog(sessionId: string, childName: string, store: DelegationLogStore): DelegationSession {
    return this.mutate(sessionId, (session) => {
      const child = this.childOf(session, childName);
      if (child.childRunId === undefined) {
        throw new Error(`Delegation: con "${childName}" chưa có childRunId để đọc log.`);
      }
      if (!store.exists(child.childRunId)) {
        throw new Error(`Delegation: log của con "${childName}" (${child.childRunId}) không tồn tại.`);
      }
      const { events } = store.readRun(child.childRunId);
      const state = foldEvents(child.childRunId, events);
      child.progress = {
        steps: state.steps,
        toolCalls: state.toolCalls.length,
        lastUpdateAt: new Date().toISOString(),
      };
    });
  }

  /** Xoá session đã xong (giữ session đang chạy). Trả số đã xoá. */
  pruneFinished(keepLatest = 50): number {
    const finished = [...this.sessions.values()]
      .filter((s) => s.status !== 'pending' && s.status !== 'running')
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    if (finished.length <= keepLatest) return 0;
    const stale = finished.slice(0, finished.length - keepLatest);
    for (const s of stale) this.sessions.delete(s.id);
    return stale.length;
  }

  private childOf(session: DelegationSession, childName: string): DelegationChildRecord {
    const child = session.children.find((c) => c.input.name === childName);
    if (child === undefined) {
      throw new Error(`Delegation: session ${session.id} không có con "${childName}".`);
    }
    return child;
  }

  /** Đổi trạng thái rồi tính lại status session (+ endedAt khi xong). */
  private mutate(sessionId: string, fn: (session: DelegationSession) => void): DelegationSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Không tìm thấy delegation ${sessionId}.`);
    fn(session);
    session.status = deriveSessionStatus(session.children);
    return this.copy(session);
  }

  private finishSessionIfDone(session: DelegationSession): void {
    const status = deriveSessionStatus(session.children);
    if (status !== 'running' && status !== 'pending') {
      session.endedAt = new Date().toISOString();
    }
  }

  /** Giữ tối đa maxSessions — xoá session xong cũ nhất trước. */
  private evictOldest(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const finished = [...this.sessions.values()]
      .filter((s) => s.status !== 'pending' && s.status !== 'running')
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const s of finished) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(s.id);
    }
  }

  /** Bản sao sâu vừa đủ (con + input không chia sẻ tham chiếu). */
  private copy(session: DelegationSession): DelegationSession {
    return {
      ...session,
      children: session.children.map((c) => ({
        ...c,
        input: { ...c.input },
        ...(c.progress !== undefined ? { progress: { ...c.progress } } : {}),
        ...(c.result !== undefined ? { result: { ...c.result } } : {}),
      })),
      ...(session.mergeReport !== undefined ? { mergeReport: { ...session.mergeReport } } : {}),
    };
  }
}
