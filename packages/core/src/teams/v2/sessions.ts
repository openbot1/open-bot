/**
 * Agent Teams v2 — session/context riêng mỗi teammate (v1.10, Đội T3).
 *
 * Mỗi teammate là một session đầy đủ với context riêng (ý tưởng
 * Claude Code Agent Teams: teammate load skill/project riêng khi
 * spawn, context không lẫn nhau). V2 lưu session mỗi teammate
 * thành file JSON riêng:
 *
 * - `sessions/<mateId>.json` — goal team (snapshot lúc spawn),
 *   model, specialty, partition, ghi chú ngữ cảnh riêng, task
 *   được giao, thời điểm đóng session.
 * - Lead spawn teammate → tạo session file. Worker làm việc chỉ
 *   trong context của mình: ghi chú, task được giao đều ở đây.
 * - Teammate rời team / team tan → đóng session (closedAt), file
 *   giữ lại để audit, không xóa.
 *
 * Không chứa secret: session chỉ lưu tên/model/goal/ghi chú.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TeammateSession } from './types';

/** Kết quả một thao tác session. */
export type SessionResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; error: string; value?: undefined };

function ok<T>(value: T): SessionResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): SessionResult<T> {
  return { ok: false, error };
}

/** Thư mục session của team: `<baseDir>/teams-v2/<teamId>/sessions/`. */
export function teamSessionsDir(baseDir: string, teamId: string): string {
  return path.join(baseDir, 'teams-v2', teamId, 'sessions');
}

/** Đường dẫn file session của một teammate. */
export function sessionFilePath(baseDir: string, teamId: string, mateId: string): string {
  return path.join(teamSessionsDir(baseDir, teamId), `${mateId}.json`);
}

/** Ghi session file nguyên tử (temp + rename, mode 0600). */
function writeSessionFile(filePath: string, session: TeammateSession): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Tạo session mới cho teammate vừa spawn (lead gọi). */
export function createTeammateSession(
  baseDir: string,
  teamId: string,
  input: {
    mateId: string;
    name: string;
    role: 'lead' | 'teammate';
    model?: string;
    specialty?: string;
    partition?: string;
    teamGoal: string;
  },
  now = Date.now(),
): SessionResult<TeammateSession> {
  if (!input.mateId.trim()) return fail('mateId không được rỗng.');
  if (!input.name.trim()) return fail('Tên teammate không được rỗng.');
  const filePath = sessionFilePath(baseDir, teamId, input.mateId);
  if (fs.existsSync(filePath)) {
    return fail(`Teammate "${input.name}" đã có session trong team này.`);
  }
  const session: TeammateSession = {
    mateId: input.mateId,
    name: input.name,
    teamId,
    role: input.role,
    model: input.model,
    specialty: input.specialty,
    partition: input.partition,
    teamGoal: input.teamGoal,
    contextNotes: [],
    assignedTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    writeSessionFile(filePath, session);
  } catch (err) {
    return fail(`Không tạo được session file: ${(err as Error).message}`);
  }
  return ok(session);
}

/** Đọc session của một teammate (null = chưa có session). */
export function readTeammateSession(
  baseDir: string,
  teamId: string,
  mateId: string,
): TeammateSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFilePath(baseDir, teamId, mateId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const session = parsed as TeammateSession;
    if (typeof session.mateId !== 'string' || !Array.isArray(session.contextNotes)) return null;
    return session;
  } catch {
    return null;
  }
}

/** Liệt kê mọi session của team (kèm trạng thái mở/đóng). */
export function listTeammateSessions(baseDir: string, teamId: string): TeammateSession[] {
  const dir = teamSessionsDir(baseDir, teamId);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: TeammateSession[] = [];
  for (const file of files) {
    const mateId = file.replace(/\.json$/, '');
    const session = readTeammateSession(baseDir, teamId, mateId);
    if (session) out.push(session);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Session còn mở không (chưa đóng). */
export function isSessionOpen(session: TeammateSession): boolean {
  return session.closedAt === undefined;
}

/** Thêm ghi chú ngữ cảnh riêng vào session của teammate. */
export function appendSessionNote(
  baseDir: string,
  teamId: string,
  mateId: string,
  note: string,
  now = Date.now(),
): SessionResult<TeammateSession> {
  const session = readTeammateSession(baseDir, teamId, mateId);
  if (!session) return fail(`Không tìm thấy session của teammate ${mateId}.`);
  if (session.closedAt !== undefined) return fail(`Session của "${session.name}" đã đóng, không ghi chú thêm được.`);
  if (!note.trim()) return fail('Ghi chú không được rỗng.');
  if (note.length > 4000) return fail('Ghi chú tối đa 4000 ký tự.');
  const updated: TeammateSession = {
    ...session,
    contextNotes: [...session.contextNotes, { at: now, note: note.trim() }].slice(-200),
    updatedAt: now,
  };
  try {
    writeSessionFile(sessionFilePath(baseDir, teamId, mateId), updated);
  } catch (err) {
    return fail(`Không ghi được session: ${(err as Error).message}`);
  }
  return ok(updated);
}

/** Ghi task được giao vào session của teammate (lead assign). */
export function addAssignedTaskToSession(
  baseDir: string,
  teamId: string,
  mateId: string,
  taskId: string,
  now = Date.now(),
): SessionResult<TeammateSession> {
  const session = readTeammateSession(baseDir, teamId, mateId);
  if (!session) return fail(`Không tìm thấy session của teammate ${mateId}.`);
  if (session.assignedTaskIds.includes(taskId)) return ok(session);
  const updated: TeammateSession = {
    ...session,
    assignedTaskIds: [...session.assignedTaskIds, taskId],
    updatedAt: now,
  };
  try {
    writeSessionFile(sessionFilePath(baseDir, teamId, mateId), updated);
  } catch (err) {
    return fail(`Không ghi được session: ${(err as Error).message}`);
  }
  return ok(updated);
}

/** Gỡ task khỏi session (task xong / giao lại cho người khác). */
export function removeAssignedTaskFromSession(
  baseDir: string,
  teamId: string,
  mateId: string,
  taskId: string,
  now = Date.now(),
): SessionResult<TeammateSession> {
  const session = readTeammateSession(baseDir, teamId, mateId);
  if (!session) return fail(`Không tìm thấy session của teammate ${mateId}.`);
  const updated: TeammateSession = {
    ...session,
    assignedTaskIds: session.assignedTaskIds.filter((id) => id !== taskId),
    updatedAt: now,
  };
  try {
    writeSessionFile(sessionFilePath(baseDir, teamId, mateId), updated);
  } catch (err) {
    return fail(`Không ghi được session: ${(err as Error).message}`);
  }
  return ok(updated);
}

/** Đóng session (teammate rời team / team tan). File giữ lại để audit. */
export function closeTeammateSession(
  baseDir: string,
  teamId: string,
  mateId: string,
  now = Date.now(),
): SessionResult<TeammateSession> {
  const session = readTeammateSession(baseDir, teamId, mateId);
  if (!session) return fail(`Không tìm thấy session của teammate ${mateId}.`);
  if (session.closedAt !== undefined) return ok(session);
  const updated: TeammateSession = { ...session, closedAt: now, updatedAt: now };
  try {
    writeSessionFile(sessionFilePath(baseDir, teamId, mateId), updated);
  } catch (err) {
    return fail(`Không ghi được session: ${(err as Error).message}`);
  }
  return ok(updated);
}
