/**
 * Condenser v14 — nén context tăng dần từ event stream (v1.29, Đội T3).
 *
 * Ý tưởng học từ OpenHands condenser (nén event stream khi vượt ngưỡng
 * token, tóm tắt event cũ thành summary event, giữ event log replayable):
 * v14 không nén lại toàn bộ log mỗi lần — nó chỉ nén PHẦN CHƯA NÉN
 * (các event sau lần `run.compacted` gần nhất), nên lần nén thứ N rẻ
 * hơn hẳn lần đầu và summary không phình theo độ dài run.
 *
 * Chính sách giữ lại (retention policy) quyết định event nào giữ
 * nguyên văn trong bản nén: tool result LỖI (lỗi phải chính xác từng
 * chữ để debug), lần file.change MỚI NHẤT của mỗi file (trạng thái
 * hiện tại của code), approval, vài model.response / reasoning digest
 * cuối, marker (run.compacted / stuck.*), và vài event đầu log (prompt
 * + setup). Phần còn lại chỉ còn trong tóm tắt trích xuất.
 *
 * Nén KHÔNG xoá lịch sử: event gốc còn nguyên trong RunLogStore;
 * `v14ApplyCondensation` chỉ append marker `run.compacted` (payload
 * chuẩn của event-log) + lưu bản nén đầy đủ vào sidecar JSON cạnh log
 * để `v14BuildContext` dựng lại context bất cứ lúc nào: summary +
 * kept transcript + tail sau upToSeq.
 *
 * Mọi con số token đều ĐO THẬT trên cùng một log bằng
 * `estimateEventTokens`/`estimateTokens` của event-log — không ước
 * lượng bằng hệ số, không nhân số cho đẹp.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokens } from '../agent/tokens';
import { condenseEvents, estimateEventTokens, shouldCondense } from '../event-log/condenser';
import type { RunLogStore } from '../event-log/store';
import type { AnyRunEvent } from '../event-log/types';
import { CodingV14Error, V14_DEFAULT_RETENTION } from './types';
import type {
  V14CondenseCheck,
  V14CondenseOptions,
  V14CondenseStrategy,
  V14Condensation,
  V14RetentionClass,
  V14RetentionPolicy,
} from './types';

/** Mặc định v14 (kế thừa ngưỡng của condenser v1). */
export const V14_CONDENSE_DEFAULTS: Required<Omit<V14CondenseOptions, 'retention' | 'upToSeq'>> = {
  strategy: 'incremental-summarize',
  minEvents: 40,
  minTokens: 4000,
  maxSummaryChars: 1500,
};

/** Suffix file sidecar lưu các bản nén v14 của một run. */
export const V14_CONDENSE_SUFFIX = '.v14condense.json';

/** Tên file sidecar condense của một run (chống path traversal). */
export function v14CondenseFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'run';
  return `${safe}${V14_CONDENSE_SUFFIX}`;
}

/** Seq cuối mà lần compact gần nhất đã bao phủ (0 = chưa từng compact). */
export function v14LastCompactedSeq(events: readonly AnyRunEvent[]): number {
  let last = 0;
  for (const e of events) {
    if (e.type !== 'run.compacted') continue;
    const p = e.payload as unknown as Record<string, unknown>;
    if (typeof p['upToSeq'] === 'number') last = Math.max(last, p['upToSeq'] as number);
  }
  return last;
}

/**
 * Các event chưa nén: seq > lần compact gần nhất (và <= upToSeq nếu
 * có). Marker `run.compacted` không tính là "chưa nén" — nó là metadata
 * ghi lại lần nén trước, không phải nội dung cần nén.
 */
export function v14UncondensedEvents(
  events: readonly AnyRunEvent[],
  upToSeq?: number,
): AnyRunEvent[] {
  const from = v14LastCompactedSeq(events);
  return events.filter(
    (e) => e.type !== 'run.compacted' && e.seq > from && (upToSeq === undefined || e.seq <= upToSeq),
  );
}

/**
 * Kiểm tra có nên nén phần chưa nén không. Ngưỡng áp cho PHẦN CHƯA
 * NÉN (không phải toàn log) — đúng tinh thần incremental.
 */
export function v14ShouldCondense(
  events: readonly AnyRunEvent[],
  options: V14CondenseOptions = {},
): V14CondenseCheck {
  const o = { ...V14_CONDENSE_DEFAULTS, ...options };
  const fromSeq = v14LastCompactedSeq(events);
  const tail = v14UncondensedEvents(events, o.upToSeq);
  const upToSeq = tail.length === 0 ? fromSeq : tail[tail.length - 1]!.seq;
  const uncondensedTokens = tail.reduce((sum, e) => sum + estimateEventTokens(e), 0);
  if (tail.length === 0) {
    return {
      needed: false,
      reason: 'nothing uncondensed (log already compacted to latest seq)',
      fromSeq,
      upToSeq,
      uncondensedEvents: 0,
      uncondensedTokens: 0,
    };
  }
  // Tái dùng luật ngưỡng của condenser v1 trên đúng phần chưa nén.
  const base = shouldCondense(tail, { minEvents: o.minEvents, minTokens: o.minTokens });
  return {
    needed: base.needed,
    reason: base.needed ? `uncondensed tail: ${base.reason}` : base.reason,
    fromSeq,
    upToSeq,
    uncondensedEvents: tail.length,
    uncondensedTokens,
  };
}

/** Bối cảnh phân loại retention (tính một lần cho cả prefix). */
interface RetentionContext {
  latestEditSeqByPath: Map<string, number>;
  lastModelResponseSeqs: Set<number>;
  lastReasoningDigestSeqs: Set<number>;
}

function buildRetentionContext(
  covered: readonly AnyRunEvent[],
  retention: V14RetentionPolicy,
): RetentionContext {
  const latestEditSeqByPath = new Map<string, number>();
  const modelSeqs: number[] = [];
  const reasoningSeqs: number[] = [];
  for (const e of covered) {
    const p = e.payload as unknown as Record<string, unknown>;
    if (e.type === 'file.change' && typeof p['path'] === 'string') {
      latestEditSeqByPath.set(p['path'] as string, e.seq);
    }
    if (e.type === 'model.response') modelSeqs.push(e.seq);
    if (e.type === 'reasoning.block') reasoningSeqs.push(e.seq);
  }
  return {
    latestEditSeqByPath,
    lastModelResponseSeqs: new Set(modelSeqs.slice(-Math.max(0, retention.keepLastModelResponses))),
    lastReasoningDigestSeqs: new Set(reasoningSeqs.slice(-Math.max(0, retention.keepLastReasoningDigests))),
  };
}

/**
 * Phân loại retention của một event trong prefix đang nén.
 * Mọi chiến lược đều giữ nhóm "quan trọng nhất": head, marker,
 * tool result lỗi, và lần file change mới nhất của mỗi file (theo
 * đúng chính sách giữ lại). 'incremental-extract-keep' /
 * 'full-summarize' giữ thêm: approval, vài model.response /
 * reasoning digest cuối, event kết thúc run.
 */
export function v14ClassifyRetention(
  event: AnyRunEvent,
  index: number,
  ctx: RetentionContext,
  retention: V14RetentionPolicy,
  strategy: V14CondenseStrategy,
): V14RetentionClass {
  const p = event.payload as unknown as Record<string, unknown>;
  // Nhóm quan trọng nhất — giữ ở mọi chiến lược.
  if (index < retention.keepHeadEvents) return 'keep';
  if (retention.keepMarkers && (event.type === 'run.compacted' || event.type.startsWith('stuck.'))) return 'keep';
  if (event.type === 'tool.result' && p['status'] === 'error' && retention.keepErrorToolResults) return 'keep';
  if (
    event.type === 'file.change' &&
    retention.keepLatestEditPerFile &&
    typeof p['path'] === 'string' &&
    ctx.latestEditSeqByPath.get(p['path'] as string) === event.seq
  ) {
    return 'keep';
  }
  if (strategy === 'incremental-summarize') return 'summarize';
  // extract-keep + full-summarize: giữ thêm so với summarize.
  if (retention.keepApprovals && (event.type === 'approval.request' || event.type === 'approval.decision')) return 'keep';
  if (event.type === 'model.response' && ctx.lastModelResponseSeqs.has(event.seq)) return 'keep';
  if (event.type === 'reasoning.block' && ctx.lastReasoningDigestSeqs.has(event.seq)) return 'keep';
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.aborted') return 'keep';
  return 'summarize';
}

/** Render một event giữ nguyên văn thành một dòng transcript. */
export function v14RenderKeptEvent(event: AnyRunEvent): string {
  const p = event.payload as unknown as Record<string, unknown>;
  const clip = (v: unknown, limit: number): string => {
    if (typeof v !== 'string') return '';
    return v.length <= limit ? v : `${v.slice(0, limit)}…`;
  };
  switch (event.type) {
    case 'run.prompt':
      return `#${event.seq} prompt: ${clip(p['text'], 300)}`;
    case 'model.response':
      return `#${event.seq} model[step ${String(p['step'] ?? '?')}]: ${clip(p['text'], 300)}`;
    case 'tool.result':
      return `#${event.seq} ${String(p['tool'] ?? 'tool')}[${String(p['status'] ?? '?')}]: ${clip(p['outputPreview'], 300)}`;
    case 'file.change':
      return `#${event.seq} file.${String(p['kind'] ?? 'change')}: ${String(p['path'] ?? '?')}`;
    case 'compile.error':
      return `#${event.seq} compile.error: ${clip(p['firstError'], 300)}`;
    case 'reasoning.block':
      return `#${event.seq} reasoning[${String(p['kind'] ?? '?')} step ${String(p['step'] ?? '?')}]: ${clip(p['excerpt'], 200)} sha256=${String(p['sha256'] ?? '').slice(0, 12)}`;
    case 'run.compacted':
      return `#${event.seq} compacted up to seq ${String(p['upToSeq'] ?? '?')}`;
    case 'stuck.detected':
      return `#${event.seq} stuck[${String(p['kind'] ?? '?')}]: ${clip(p['detail'], 200)}`;
    case 'stuck.recovered':
      return `#${event.seq} recovered[${String(p['strategy'] ?? '?')}]: ${clip(p['detail'], 200)}`;
    default:
      return `#${event.seq} ${event.type}`;
  }
}

/** Render một event tail (sau upToSeq) thành một dòng context. */
export function v14RenderTailEvent(event: AnyRunEvent): string {
  return v14RenderKeptEvent(event);
}

function resolveOptions(options: V14CondenseOptions): {
  strategy: V14CondenseStrategy;
  minEvents: number;
  minTokens: number;
  maxSummaryChars: number;
  retention: V14RetentionPolicy;
  upToSeq?: number;
} {
  const o = { ...V14_CONDENSE_DEFAULTS, ...options };
  return {
    strategy: o.strategy,
    minEvents: o.minEvents,
    minTokens: o.minTokens,
    maxSummaryChars: o.maxSummaryChars,
    retention: { ...V14_DEFAULT_RETENTION, ...(options.retention ?? {}) },
    ...(options.upToSeq !== undefined ? { upToSeq: options.upToSeq } : {}),
  };
}

/**
 * Nén tăng dần một run (pure — không ghi log). Trả bản nén đầy đủ:
 * summary + kept transcript + số đo token thật. Ném lỗi khi không có
 * event nào để nén.
 */
export function v14CondenseIncremental(
  events: readonly AnyRunEvent[],
  runId: string,
  options: V14CondenseOptions = {},
): V14Condensation {
  if (!runId || runId.trim() === '') {
    throw new CodingV14Error('condense-invalid', 'runId must be a non-empty string.');
  }
  const o = resolveOptions(options);
  const fromSeq = o.strategy === 'full-summarize' ? 0 : v14LastCompactedSeq(events);
  // Marker run.compacted là metadata, không phải nội dung cần nén.
  const covered = events.filter(
    (e) => e.type !== 'run.compacted' && e.seq > fromSeq && (o.upToSeq === undefined || e.seq <= o.upToSeq),
  );
  if (covered.length === 0) {
    throw new CodingV14Error(
      'condense-nothing-to-condense',
      `run ${runId} has no uncondensed events after seq ${fromSeq}.`,
    );
  }
  const upToSeq = covered[covered.length - 1]!.seq;
  const tokensBefore = covered.reduce((sum, e) => sum + estimateEventTokens(e), 0);
  const ctx = buildRetentionContext(covered, o.retention);

  const kept: AnyRunEvent[] = [];
  const summarized: AnyRunEvent[] = [];
  covered.forEach((e, i) => {
    const cls = v14ClassifyRetention(e, i, ctx, o.retention, o.strategy);
    if (cls === 'keep') kept.push(e);
    else summarized.push(e);
  });

  let summary = '';
  if (summarized.length > 0) {
    const base = condenseEvents(summarized, {
      minEvents: 0,
      minTokens: 0,
      maxSummaryChars: o.maxSummaryChars,
    });
    summary = base.summary;
  }
  const keptTranscript = kept.map((e) => v14RenderKeptEvent(e)).join('\n');
  const strategyLine =
    `[v14 ${o.strategy} seq ${fromSeq + 1}..${upToSeq} — ${covered.length} events, ` +
    `${kept.length} kept verbatim, ${summarized.length} summarized]`;
  const fullSummary = summary === '' ? strategyLine : `${strategyLine}\n${summary}`;
  const tokensAfter = estimateTokens(fullSummary) + kept.reduce((sum, e) => sum + estimateEventTokens(e), 0);
  const tokensSaved = tokensBefore - tokensAfter;
  return {
    runId,
    strategy: o.strategy,
    fromSeq,
    upToSeq,
    eventsCovered: covered.length,
    eventsKept: kept.length,
    eventsSummarized: summarized.length,
    summary: fullSummary,
    keptTranscript,
    tokensBefore,
    tokensAfter,
    tokensSaved,
    savedRatioPct: tokensBefore === 0 ? 0 : Math.round((tokensSaved / tokensBefore) * 1000) / 10,
    markerSeq: 0,
  };
}

/**
 * Dựng context cho model từ log + bản nén: summary của phần đã nén +
 * transcript giữ nguyên văn + toàn bộ event sau upToSeq (tail chưa
 * nén). Replayable: cùng log + cùng condensation luôn cho cùng context.
 */
export function v14BuildContext(
  events: readonly AnyRunEvent[],
  condensation: V14Condensation,
): string {
  const parts: string[] = [];
  parts.push(`[Condensed context — events 1..${condensation.upToSeq} summarized, ${condensation.eventsCovered} events covered, ~${condensation.tokensBefore} tokens → ~${condensation.tokensAfter} tokens]`);
  parts.push(condensation.summary);
  if (condensation.keptTranscript !== '') {
    parts.push('[Kept verbatim]');
    parts.push(condensation.keptTranscript);
  }
  const tail = events.filter((e) => e.seq > condensation.upToSeq);
  if (tail.length > 0) {
    parts.push(`[Recent events after seq ${condensation.upToSeq} — ${tail.length} events, verbatim]`);
    parts.push(tail.map((e) => v14RenderTailEvent(e)).join('\n'));
  }
  return parts.join('\n');
}

/** Lưu một bản nén vào sidecar JSON cạnh log (append vào mảng). */
export function v14SaveCondensation(logDir: string, condensation: V14Condensation): string {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, v14CondenseFileName(condensation.runId));
  const existing = v14LoadCondensations(logDir, condensation.runId);
  existing.push(condensation);
  fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return file;
}

/** Đọc mọi bản nén v14 đã lưu của một run (mảng rỗng khi chưa có). */
export function v14LoadCondensations(logDir: string, runId: string): V14Condensation[] {
  const file = path.join(logDir, v14CondenseFileName(runId));
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is V14Condensation => {
      if (!c || typeof c !== 'object') return false;
      const v = c as Record<string, unknown>;
      return typeof v['runId'] === 'string' && typeof v['upToSeq'] === 'number' && typeof v['summary'] === 'string';
    });
  } catch {
    return [];
  }
}

/**
 * Nén tăng dần + ghi marker `run.compacted` vào RunLogStore + lưu bản
 * nén đầy đủ vào sidecar. Marker mang payload chuẩn của event-log
 * (upToSeq/summary/eventsReplaced/tokensBefore/tokensAfter) nên replay
 * cũ vẫn đọc được; chi tiết v14 (strategy/fromSeq/kept) nằm ở sidecar.
 */
export function v14ApplyCondensation(
  store: RunLogStore,
  logDir: string,
  runId: string,
  options: V14CondenseOptions = {},
): V14Condensation {
  const { events } = store.readRun(runId);
  if (events.length === 0) {
    throw new CodingV14Error('condense-nothing-to-condense', `run ${runId} has no events to condense.`);
  }
  const condensation = v14CondenseIncremental(events, runId, options);
  const marker = store.append(runId, {
    type: 'run.compacted',
    payload: {
      upToSeq: condensation.upToSeq,
      summary: condensation.summary,
      eventsReplaced: condensation.eventsCovered,
      tokensBefore: condensation.tokensBefore,
      tokensAfter: condensation.tokensAfter,
    },
  });
  const withMarker: V14Condensation = { ...condensation, markerSeq: marker.seq };
  v14SaveCondensation(logDir, withMarker);
  return withMarker;
}

/** Render ngắn một bản nén để hiển thị/log. */
export function renderV14CondensationSummary(c: V14Condensation): string {
  return (
    `[v14 condense ${c.strategy} run=${c.runId} seq ${c.fromSeq + 1}..${c.upToSeq}: ` +
    `${c.eventsCovered} events (${c.eventsKept} kept, ${c.eventsSummarized} summarized), ` +
    `~${c.tokensBefore} → ~${c.tokensAfter} tokens (saved ${c.tokensSaved}, ${c.savedRatioPct}%), ` +
    `marker seq ${c.markerSeq}]`
  );
}
