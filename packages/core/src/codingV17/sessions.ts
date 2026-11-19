/**
 * Coding agent v17 — session registry (khám phá + dọn dẹp phiên).
 *
 * Phục vụ session recovery (trajectory.ts): muốn resume một phiên thì
 * host phải biết phiên nào tồn tại, phiên nào còn dang dở, phiên nào
 * đã kết thúc — module này quét thư mục trajectories/ và trả về bản
 * tóm tắt từng phiên mà không cần mở toàn bộ log vào bộ nhớ cùng lúc
 * (chỉ đọc file JSONL của phiên đó khi cần tóm tắt chi tiết).
 *
 * - v17ListSessions: liệt kê mọi session (mới nhất trước).
 * - v17SessionSummary: tóm tắt một session (số event, file đã đổi,
 *   bash đã chạy, đã kết thúc chưa) qua replay.
 * - v17PruneSessions: xoá log của các session cũ nhất khi vượt giới
 *   hạn giữ (mặc định giữ 50 phiên mới nhất), có dry-run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CodingV17Error } from './types';
import { TrajectoryLog, v17EventsFromJsonl, v17ReplayEvents } from './trajectory';

/** Một dòng trong danh sách session. */
export interface V17SessionListEntry {
  /** Id phiên (tên file JSONL không đuôi). */
  sessionId: string;
  /** Số event trong log. */
  events: number;
  /** Kind của event cuối cùng ('' khi log rỗng). */
  lastKind: string;
  /** Thời điểm event cuối (ms epoch, 0 khi log rỗng). */
  lastAt: number;
  /** true khi log có session_end. */
  ended: boolean;
  /** Kích thước file log (bytes). */
  bytes: number;
}

/** Tóm tắt chi tiết một session (qua replay). */
export interface V17SessionSummary {
  sessionId: string;
  events: number;
  /** Thời điểm event đầu (ms epoch, 0 khi log rỗng). */
  startedAt: number;
  lastAt: number;
  ended: boolean;
  endReason?: string;
  filesChanged: string[];
  bashCommands: number;
  compilerErrors: number;
  /** Chuỗi hash còn nguyên vẹn không. */
  chainOk: boolean;
}

/** Kết quả prune session. */
export interface V17SessionPruneResult {
  /** Số session đã xoá (0 khi dry-run). */
  deleted: number;
  /** Session đã xoá (hoặc sẽ xoá khi dry-run). */
  deletedSessions: string[];
  /** Số session còn lại. */
  kept: number;
  /** true khi đây chỉ là dry-run (không xoá thật). */
  dryRun: boolean;
}

/** Thư mục chứa trajectory log trong dataDir. */
export function v17TrajectoriesDir(dataDir: string): string {
  return path.join(dataDir, 'trajectories');
}

/** Đọc một entry từ file log (không throw khi file hỏng — ghi rõ). */
function readSessionEntry(file: string, sessionId: string): V17SessionListEntry {
  const stat = fs.statSync(file);
  let events = 0;
  let lastKind = '';
  let lastAt = 0;
  let ended = false;
  try {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = v17EventsFromJsonl(content);
    events = parsed.length;
    if (parsed.length > 0) {
      const last = parsed[parsed.length - 1];
      if (last) {
        lastKind = last.kind;
        lastAt = last.at;
      }
      ended = parsed.some((e) => e.kind === 'session_end');
    }
  } catch {
    // File log hỏng: vẫn liệt kê (events=0) để host thấy và recover.
    events = 0;
  }
  return { sessionId, events, lastKind, lastAt, ended, bytes: stat.size };
}

/** Liệt kê mọi session trong dataDir (mới nhất trước). */
export function v17ListSessions(dataDir: string): V17SessionListEntry[] {
  const dir = v17TrajectoriesDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const entries: V17SessionListEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    try {
      entries.push(readSessionEntry(path.join(dir, name), sessionId));
    } catch {
      // File không đọc được (vd bị xoá giữa chừng) — bỏ qua.
      continue;
    }
  }
  entries.sort((a, b) => b.lastAt - a.lastAt || a.sessionId.localeCompare(b.sessionId));
  return entries;
}

/** Chỉ liệt kê session chưa kết thúc (cần resume/recovery). */
export function v17ListOpenSessions(dataDir: string): V17SessionListEntry[] {
  return v17ListSessions(dataDir).filter((e) => !e.ended);
}

/** Tóm tắt chi tiết một session (load + verify + replay). */
export function v17SessionSummary(dataDir: string, sessionId: string): V17SessionSummary {
  if (sessionId.trim() === '') {
    throw new CodingV17Error('trajectory-invalid', 'sessionId không được rỗng.');
  }
  const file = path.join(v17TrajectoriesDir(dataDir), `${sessionId.replace(/[^A-Za-z0-9._-]+/g, '_')}.jsonl`);
  if (!fs.existsSync(file)) {
    throw new CodingV17Error('trajectory-not-found', `không có trajectory log cho session ${sessionId}.`);
  }
  const log = new TrajectoryLog(sessionId, file);
  const events = log.load();
  const verification = log.verify();
  const state = v17ReplayEvents(events, sessionId);
  return {
    sessionId,
    events: events.length,
    startedAt: events.length > 0 ? (events[0]?.at ?? 0) : 0,
    lastAt: events.length > 0 ? (events[events.length - 1]?.at ?? 0) : 0,
    ended: state.ended,
    ...(state.endReason !== undefined ? { endReason: state.endReason } : {}),
    filesChanged: Object.keys(state.files).sort(),
    bashCommands: state.bashCommands.length,
    compilerErrors: state.compilerErrors.length,
    chainOk: verification.ok,
  };
}

/**
 * Xoá log của các session cũ nhất khi số session vượt `keepNewest`
 * (mặc định giữ 50 phiên mới nhất). dryRun=true thì chỉ báo cáo,
 * không xoá thật.
 */
export function v17PruneSessions(
  dataDir: string,
  keepNewest = 50,
  dryRun = false,
): V17SessionPruneResult {
  if (!Number.isInteger(keepNewest) || keepNewest < 0) {
    throw new CodingV17Error('trajectory-invalid', 'keepNewest phải là số nguyên >= 0.');
  }
  const sessions = v17ListSessions(dataDir);
  if (sessions.length <= keepNewest) {
    return { deleted: 0, deletedSessions: [], kept: sessions.length, dryRun };
  }
  const toDelete = sessions.slice(keepNewest);
  const deletedSessions = toDelete.map((s) => s.sessionId);
  if (!dryRun) {
    for (const session of toDelete) {
      try {
        fs.rmSync(path.join(v17TrajectoriesDir(dataDir), `${session.sessionId}.jsonl`), { force: true });
      } catch {
        // Xoá lỗi (vd file đã bị xoá) — không chặn prune các file còn lại.
        continue;
      }
    }
  }
  return {
    deleted: dryRun ? 0 : deletedSessions.length,
    deletedSessions,
    kept: sessions.length - deletedSessions.length,
    dryRun,
  };
}

/** Render danh sách session thành text. */
export function renderV17SessionList(sessions: readonly V17SessionListEntry[]): string {
  if (sessions.length === 0) return 'Không có session coding v17 nào.';
  const lines = [`Sessions coding v17 (${sessions.length}):`];
  for (const s of sessions) {
    lines.push(
      `  ${s.sessionId}: ${s.events} events, ${s.ended ? 'đã kết thúc' : 'ĐANG MỞ'}, last=${s.lastKind || '-'} (${s.bytes} bytes)`,
    );
  }
  return lines.join('\n');
}

/** Render tóm tắt session thành text. */
export function renderV17SessionSummary(summary: V17SessionSummary): string {
  return [
    `Session ${summary.sessionId}: ${summary.events} events, ${summary.ended ? `đã kết thúc (${summary.endReason ?? ''})` : 'đang mở'}.`,
    `Files: ${summary.filesChanged.join(', ') || 'không có'}.`,
    `Bash: ${summary.bashCommands} lệnh, compiler errors: ${summary.compilerErrors}.`,
    `Hash chain: ${summary.chainOk ? 'OK' : 'HỎNG (cần recover)'}.`,
  ].join('\n');
}
