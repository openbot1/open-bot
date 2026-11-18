/**
 * Cầu nối v14 ↔ run log chung (v1.29, Đội T3 — coding agent v14).
 *
 * Adapter này là điểm duy nhất v14 ghi vào `RunLogStore`:
 * - Digest event `reasoning.block` cho mỗi khối suy luận (metadata +
 *   sha256, không mang full text — full text ở sidecar).
 * - Event `stuck.recovered` cho mỗi lần recovery đã áp dụng.
 * - Đọc lại log để rebuild trạng thái v14 bằng replay: compactions,
 *   stuck detections/recoveries, reasoning digests — rồi đối chiếu
 *   digest với sidecar (`V14ReasoningStore.verify`) để phát hiện lệch.
 *
 * Replay ở đây là fold thuần trên event đã ghi (không gọi model):
 * cùng một log luôn cho cùng một trạng thái rebuild — test được.
 */

import type { RunLogStore } from '../event-log/store';
import type { AnyRunEvent } from '../event-log/types';
import { V14ReasoningStore } from './reasoningBlocks';
import type { V14ReasoningBlock, V14RecoveryResult, V14StuckSignal } from './types';

/** Một digest reasoning đã đọc từ run log (để đối chiếu với sidecar). */
export interface V14ReasoningDigestEntry {
  seq: number;
  blockId: string;
  step: number;
  kind: string;
  chars: number;
  sha256: string;
  excerpt: string;
  model?: string;
}

/** Một lần recovery đã đọc từ run log. */
export interface V14RecoveryLogEntry {
  seq: number;
  step: number;
  strategy: string;
  signalKind: string;
  detail: string;
  applied: boolean;
}

/** Trạng thái v14 rebuild được từ event log bằng replay. */
export interface V14ReplayedState {
  runId: string;
  /** Tổng số event trong log. */
  events: number;
  /** Seq cuối cùng. */
  lastSeq: number;
  /** Các lần compact (upToSeq + summary). */
  compactions: Array<{ seq: number; upToSeq: number; summary: string; eventsReplaced: number }>;
  /** Các lần phát hiện kẹt. */
  stuckDetections: Array<{ seq: number; step: number; kind: string; detail: string }>;
  /** Các lần recovery đã áp dụng. */
  recoveries: V14RecoveryLogEntry[];
  /** Các digest reasoning (theo seq). */
  reasoningDigests: V14ReasoningDigestEntry[];
  /** Số event không nhận ra (log phiên bản mới hơn) — fold vẫn chạy. */
  unknownEvents: number;
}

/** Kết quả đối chiếu digest (run log) với sidecar (full text). */
export interface V14DigestVerification {
  runId: string;
  /** Số digest trong log. */
  digests: number;
  /** Số block trong sidecar. */
  blocks: number;
  /** Số digest khớp hoàn toàn với block (id + step + chars + sha256). */
  matched: number;
  /** Các digest không có block tương ứng (sidecar thiếu/mất). */
  missingInSidecar: string[];
  /** Các block không có digest tương ứng (log thiếu — vd crash trước khi ghi). */
  missingInLog: string[];
  /** Các digest khớp id nhưng lệch chars/sha256 (nội dung đã đổi). */
  mismatched: string[];
  /** true khi mọi thứ khớp (digests == blocks == matched, không lệch). */
  ok: boolean;
}

/**
 * Ghi digest event `reasoning.block` vào run log chung cho một block
 * vừa record ở sidecar. Trả event đã ghi (đầy đủ seq/hash).
 */
export function v14AppendReasoningDigest(
  store: RunLogStore,
  runId: string,
  block: V14ReasoningBlock,
): AnyRunEvent {
  return store.append(runId, {
    type: 'reasoning.block',
    payload: {
      blockId: block.id,
      step: block.step,
      kind: block.kind,
      chars: block.chars,
      sha256: block.sha256,
      excerpt: block.text.slice(0, 200),
      ...(block.model ? { model: block.model } : {}),
    },
  });
}

/**
 * Ghi event `stuck.recovered` vào run log chung cho một lần recovery.
 * Trả event đã ghi (đầy đủ seq/hash).
 */
export function v14AppendRecoveryEvent(
  store: RunLogStore,
  runId: string,
  step: number,
  signal: V14StuckSignal,
  result: V14RecoveryResult,
): AnyRunEvent {
  return store.append(runId, {
    type: 'stuck.recovered',
    payload: {
      step,
      strategy: result.strategy,
      signalKind: signal.kind,
      detail: result.detail.slice(0, 500),
      applied: result.applied,
    },
  });
}

/**
 * Ghi event `stuck.detected` vào run log chung (dùng chung payload
 * với detector v1 — kind/detail/suggestionKey). Trả event đã ghi.
 */
export function v14AppendStuckDetectedEvent(
  store: RunLogStore,
  runId: string,
  step: number,
  signal: V14StuckSignal,
  suggestionKey?: string,
): AnyRunEvent {
  return store.append(runId, {
    type: 'stuck.detected',
    payload: {
      step,
      kind: signal.kind,
      detail: signal.detail.slice(0, 500),
      ...(suggestionKey ? { suggestionKey } : {}),
    },
  });
}

/** Đọc mọi digest reasoning từ một dãy event (theo seq tăng dần). */
export function v14ReadReasoningDigests(events: readonly AnyRunEvent[]): V14ReasoningDigestEntry[] {
  const out: V14ReasoningDigestEntry[] = [];
  for (const e of events) {
    if (e.type !== 'reasoning.block') continue;
    const p = e.payload as unknown as Record<string, unknown>;
    if (typeof p['blockId'] !== 'string' || typeof p['sha256'] !== 'string') continue;
    out.push({
      seq: e.seq,
      blockId: p['blockId'] as string,
      step: typeof p['step'] === 'number' ? (p['step'] as number) : 0,
      kind: typeof p['kind'] === 'string' ? (p['kind'] as string) : '',
      chars: typeof p['chars'] === 'number' ? (p['chars'] as number) : 0,
      sha256: p['sha256'] as string,
      excerpt: typeof p['excerpt'] === 'string' ? (p['excerpt'] as string) : '',
      ...(typeof p['model'] === 'string' ? { model: p['model'] as string } : {}),
    });
  }
  return out;
}

/** Đọc mọi lần recovery từ một dãy event (theo seq tăng dần). */
export function v14ReadRecoveryEntries(events: readonly AnyRunEvent[]): V14RecoveryLogEntry[] {
  const out: V14RecoveryLogEntry[] = [];
  for (const e of events) {
    if (e.type !== 'stuck.recovered') continue;
    const p = e.payload as unknown as Record<string, unknown>;
    out.push({
      seq: e.seq,
      step: typeof p['step'] === 'number' ? (p['step'] as number) : 0,
      strategy: typeof p['strategy'] === 'string' ? (p['strategy'] as string) : '',
      signalKind: typeof p['signalKind'] === 'string' ? (p['signalKind'] as string) : '',
      detail: typeof p['detail'] === 'string' ? (p['detail'] as string) : '',
      applied: p['applied'] === true,
    });
  }
  return out;
}

/**
 * Rebuild trạng thái v14 từ event log bằng replay (fold thuần).
 * Event lạ (log phiên bản mới hơn) được đếm vào `unknownEvents` và
 * bỏ qua — fold vẫn chạy, không throw.
 */
export function v14ReplayState(events: readonly AnyRunEvent[], runId: string): V14ReplayedState {
  const state: V14ReplayedState = {
    runId,
    events: events.length,
    lastSeq: events.length === 0 ? 0 : events[events.length - 1]!.seq,
    compactions: [],
    stuckDetections: [],
    recoveries: [],
    reasoningDigests: [],
    unknownEvents: 0,
  };
  const known = new Set([
    'run.started',
    'run.prompt',
    'model.response',
    'tool.call',
    'tool.result',
    'file.change',
    'compile.error',
    'run.paused',
    'run.resumed',
    'run.forked',
    'run.completed',
    'run.failed',
    'run.aborted',
    'approval.request',
    'approval.decision',
    'checkpoint.saved',
    'event.redacted',
    'run.compacted',
    'stuck.detected',
    'reasoning.block',
    'stuck.recovered',
  ]);
  for (const e of events) {
    if (!known.has(e.type)) {
      state.unknownEvents += 1;
      continue;
    }
    const p = e.payload as unknown as Record<string, unknown>;
    switch (e.type) {
      case 'run.compacted': {
        state.compactions.push({
          seq: e.seq,
          upToSeq: typeof p['upToSeq'] === 'number' ? (p['upToSeq'] as number) : 0,
          summary: typeof p['summary'] === 'string' ? (p['summary'] as string) : '',
          eventsReplaced: typeof p['eventsReplaced'] === 'number' ? (p['eventsReplaced'] as number) : 0,
        });
        break;
      }
      case 'stuck.detected': {
        state.stuckDetections.push({
          seq: e.seq,
          step: typeof p['step'] === 'number' ? (p['step'] as number) : 0,
          kind: typeof p['kind'] === 'string' ? (p['kind'] as string) : '',
          detail: typeof p['detail'] === 'string' ? (p['detail'] as string) : '',
        });
        break;
      }
      case 'stuck.recovered': {
        state.recoveries.push({
          seq: e.seq,
          step: typeof p['step'] === 'number' ? (p['step'] as number) : 0,
          strategy: typeof p['strategy'] === 'string' ? (p['strategy'] as string) : '',
          signalKind: typeof p['signalKind'] === 'string' ? (p['signalKind'] as string) : '',
          detail: typeof p['detail'] === 'string' ? (p['detail'] as string) : '',
          applied: p['applied'] === true,
        });
        break;
      }
      case 'reasoning.block': {
        if (typeof p['blockId'] === 'string' && typeof p['sha256'] === 'string') {
          state.reasoningDigests.push({
            seq: e.seq,
            blockId: p['blockId'] as string,
            step: typeof p['step'] === 'number' ? (p['step'] as number) : 0,
            kind: typeof p['kind'] === 'string' ? (p['kind'] as string) : '',
            chars: typeof p['chars'] === 'number' ? (p['chars'] as number) : 0,
            sha256: p['sha256'] as string,
            excerpt: typeof p['excerpt'] === 'string' ? (p['excerpt'] as string) : '',
            ...(typeof p['model'] === 'string' ? { model: p['model'] as string } : {}),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return state;
}

/**
 * Đối chiếu digest trong run log với block trong sidecar: mỗi digest
 * phải khớp đúng một block (id + step + chars + sha256). Trả báo cáo
 * chi tiết (không throw) để caller quyết định có tin replay không.
 */
export function v14VerifyDigests(
  events: readonly AnyRunEvent[],
  reasoningStore: V14ReasoningStore,
  runId: string,
): V14DigestVerification {
  const digests = v14ReadReasoningDigests(events);
  const blocks = reasoningStore.blocks(runId);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const digestIds = new Set(digests.map((d) => d.blockId));
  const missingInSidecar: string[] = [];
  const mismatched: string[] = [];
  let matched = 0;
  for (const d of digests) {
    const block = byId.get(d.blockId);
    if (!block) {
      missingInSidecar.push(d.blockId);
      continue;
    }
    if (block.step !== d.step || block.chars !== d.chars || block.sha256 !== d.sha256) {
      mismatched.push(d.blockId);
      continue;
    }
    matched += 1;
  }
  const missingInLog = blocks.filter((b) => !digestIds.has(b.id)).map((b) => b.id);
  return {
    runId,
    digests: digests.length,
    blocks: blocks.length,
    matched,
    missingInSidecar,
    missingInLog,
    mismatched,
    ok: missingInSidecar.length === 0 && missingInLog.length === 0 && mismatched.length === 0,
  };
}

/** Render ngắn trạng thái replay để hiển thị/log. */
export function renderV14ReplayedState(state: V14ReplayedState): string {
  return (
    `[v14 replay run=${state.runId}: ${state.events} events (last seq ${state.lastSeq}), ` +
    `${state.compactions.length} compactions, ${state.stuckDetections.length} stuck, ` +
    `${state.recoveries.length} recoveries, ${state.reasoningDigests.length} reasoning digests` +
    `${state.unknownEvents > 0 ? `, ${state.unknownEvents} unknown` : ''}]`
  );
}
