/**
 * Agent server v2 — SSE stream event (v1.04, Đội T4).
 *
 * Stream event của một conversation qua Server-Sent Events bằng cách
 * tail `RunLogStore`: mỗi `pollMs` đọc lại log, gửi event mới (seq >
 * lastSent) theo đúng thứ tự seq. Không cần WebSocket ở v2 này — SSE
 * một chiều là đủ cho "theo dõi run đang chạy", và client nào cũng
 * đọc được bằng `fetch` + `ReadableStream` (hoặc `EventSource`).
 *
 * - Client có thể xin replay từ đầu (`fromSeq = 1`) hoặc chỉ live
 *   (`fromSeq` = seq cuối + 1 — mặc định).
 * - Heartbeat comment (`: ping`) giữ connection không bị proxy cắt.
 * - Khi run kết thúc (terminal: completed/failed/aborted) thì gửi nốt
 *   event còn lại rồi gửi event `run.ended` và ĐÓNG stream (client
 *   biết run đã xong, không cần poll nữa).
 * - Client ngắt kết nối → dừng poll, không rò timer.
 */

import type http from 'node:http';

import type { RunLogStore } from '../event-log/store';
import type { AnyRunEvent } from '../event-log/types';

/** Event kết thúc stream (gửi sau event terminal cuối cùng). */
export const SSE_RUN_ENDED_EVENT = 'run.ended';

/** Tùy chọn subscribe SSE. */
export interface SseSubscribeOptions {
  /** Seq bắt đầu gửi (bao gồm). Mặc định = seq cuối + 1 (chỉ live). */
  fromSeq?: number;
  /** Khoảng poll store, ms. Mặc định 250. */
  pollMs?: number;
  /** Khoảng heartbeat, ms. Mặc định 15_000. */
  heartbeatMs?: number;
}

/** Format một event thành khung SSE (`id` + `event` + `data`). */
export function formatSseEvent(event: AnyRunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Format event kết thúc run (`run.ended`, data = { runId, status }). */
export function formatSseRunEnded(runId: string, status: string): string {
  return `event: ${SSE_RUN_ENDED_EVENT}\ndata: ${JSON.stringify({ runId, status })}\n\n`;
}

/** Heartbeat comment SSE (giữ connection). */
export const SSE_HEARTBEAT = ': ping\n\n';

/** Trạng thái terminal của run — tới đây thì stream đóng sau khi gửi nốt. */
export function isTerminalRunEvent(event: AnyRunEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.aborted';
}

/**
 * Subscribe SSE cho một conversation: ghi header SSE rồi poll store,
 * gửi event mới theo thứ tự. Trả hàm `stop()` để dừng (client ngắt
 * thì tự stop). Ném lỗi khi conversation không tồn tại (caller map
 * thành 404 trước khi ghi header).
 */
export function subscribeConversationEvents(
  store: RunLogStore,
  runId: string,
  res: http.ServerResponse,
  options: SseSubscribeOptions = {},
): { stop: () => void } {
  if (!store.exists(runId)) throw new Error(`Không tìm thấy conversation ${runId}.`);
  const pollMs = options.pollMs ?? 250;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const { events } = store.readRun(runId);
  let lastSent = (options.fromSeq ?? (events.length === 0 ? 1 : events[events.length - 1]!.seq + 1)) - 1;
  let stopped = false;
  let ended = false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(SSE_HEARTBEAT);

  const poll = (): void => {
    if (stopped) return;
    try {
      const { events: all } = store.readRun(runId);
      let terminalStatus: string | undefined;
      for (const event of all) {
        if (event.seq <= lastSent) continue;
        res.write(formatSseEvent(event));
        lastSent = event.seq;
        if (isTerminalRunEvent(event)) {
          terminalStatus = event.type === 'run.completed' ? 'completed' : event.type === 'run.failed' ? 'failed' : 'aborted';
        }
      }
      if (terminalStatus !== undefined) {
        ended = true;
        res.write(formatSseRunEnded(runId, terminalStatus));
        stop();
        res.end();
        return;
      }
    } catch {
      // Đọc log lỗi giữa chừng (vd file xoay) — bỏ qua lần poll này,
      // lần sau đọc lại; không đóng stream vì lỗi thoáng qua.
    }
  };

  const timer = setInterval(poll, pollMs);
  const heartbeat = setInterval(() => {
    if (!stopped && !ended) {
      try {
        res.write(SSE_HEARTBEAT);
      } catch {
        stop();
      }
    }
  }, heartbeatMs);
  // Không giữ process sống chỉ vì timer stream.
  timer.unref?.();
  heartbeat.unref?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeat);
  };
  res.on('close', stop);
  // Gửi ngay event đã có (khi fromSeq <= seq cuối) thay vì đợi poll đầu.
  poll();
  return { stop };
}
