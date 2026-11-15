/**
 * Agent Teams v3 — session registry: 1 team/session (v1.11, Đội T3).
 *
 * Giới hạn đã biết của Claude Code Agent Teams (survey v1.11 §3):
 * 1 session chỉ có 1 team; teammate không tạo team con. Registry
 * này thi hành 2 luật đó trên disk:
 *
 * - `sessions.json` trong teams-v3/ map sessionId → teamId. Tạo
 *   team cho session đã có team → lỗi (phải dissolve team cũ trước).
 * - Teammate tạo team (team con) → lỗi ở service v3 — registry chỉ
 *   lưu session của lead; hàm `assertCanCreateTeam` kiểm tra cả 2.
 *
 * Ghi file nguyên tử (temp + rename, mode 0600) theo mẫu
 * TeamV2Store — session registry là file duy nhất, không có lock
 * file riêng; race tạo team cùng session trong 2 process cực hiếm
 * (CLI/desktop chạy tuần tự) và lần ghi sau sẽ thấy team đã có.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  TEAMS_V3_DIR,
  TEAM_V3_SESSIONS_FILE,
  type TeamSessionEntry,
  type TeamV3Result,
} from './types';

/** Thư mục v3: `<baseDir>/teams-v3/`. */
export function teamV3Dir(baseDir: string): string {
  return path.join(baseDir, TEAMS_V3_DIR);
}

/** Đường dẫn file registry session. */
export function teamV3SessionsPath(baseDir: string): string {
  return path.join(teamV3Dir(baseDir), TEAM_V3_SESSIONS_FILE);
}

/** Đọc registry session; chưa có file → registry rỗng. */
export function readSessionRegistry(
  baseDir: string,
): { entries: TeamSessionEntry[]; loadError?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(teamV3SessionsPath(baseDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    return { entries: [], loadError: `Không đọc được registry session v3: ${(err as Error).message}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return { entries: [], loadError: 'File registry session v3 không đúng định dạng.' };
    }
    const entries = (parsed as { entries: TeamSessionEntry[] }).entries.filter(
      (e) => e && typeof e.sessionId === 'string' && typeof e.teamId === 'string',
    );
    return { entries };
  } catch (err) {
    return { entries: [], loadError: `File registry session v3 lỗi JSON: ${(err as Error).message}` };
  }
}

/** Ghi registry session (nguyên tử temp + rename, mode 0600). */
export function writeSessionRegistry(baseDir: string, entries: TeamSessionEntry[]): TeamV3Result<void> {
  try {
    fs.mkdirSync(teamV3Dir(baseDir), { recursive: true });
    const filePath = teamV3SessionsPath(baseDir);
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 3, entries }, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: `Không ghi được registry session v3: ${(err as Error).message}` };
  }
}

/** Team của một session (undefined khi session chưa có team). */
export function teamOfSession(baseDir: string, sessionId: string): TeamSessionEntry | undefined {
  return readSessionRegistry(baseDir).entries.find((e) => e.sessionId === sessionId);
}

/** Session có team chưa (để chặn tạo team thứ 2). */
export function sessionHasTeam(baseDir: string, sessionId: string): boolean {
  return teamOfSession(baseDir, sessionId) !== undefined;
}

/**
 * Kiểm tra có được tạo team mới không:
 * - sessionId rỗng → lỗi (team phải gắn với một session).
 * - session đã có team → lỗi, nêu team đang có (1 team/session).
 * - actor là teammate của team khác (team con) → lỗi.
 */
export function assertCanCreateTeam(
  baseDir: string,
  sessionId: string,
  actor: { isTeammateOfTeamId?: string } = {},
): TeamV3Result<void> {
  if (!sessionId.trim()) {
    return { ok: false, error: 'Tạo team cần sessionId (mỗi team gắn với đúng 1 session).' };
  }
  if (actor.isTeammateOfTeamId) {
    return {
      ok: false,
      error: `Teammate không được tạo team con (bạn đang là teammate của team ${actor.isTeammateOfTeamId}). Chỉ lead/session chính mới tạo team.`,
    };
  }
  const existing = teamOfSession(baseDir, sessionId);
  if (existing) {
    return {
      ok: false,
      error: `Session "${sessionId}" đã có team "${existing.teamName}" (${existing.teamId}) — 1 session chỉ có 1 team. Dissolve team cũ trước khi tạo team mới.`,
    };
  }
  return { ok: true, value: undefined };
}

/** Đăng ký team mới cho session (ghi đè entry cùng sessionId nếu có — chỉ gọi sau assertCanCreateTeam). */
export function registerTeamSession(
  baseDir: string,
  entry: TeamSessionEntry,
): TeamV3Result<TeamSessionEntry> {
  const { entries } = readSessionRegistry(baseDir);
  const next = [...entries.filter((e) => e.sessionId !== entry.sessionId), entry];
  const written = writeSessionRegistry(baseDir, next);
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, value: entry };
}

/** Gỡ team khỏi session (khi dissolve team). */
export function unregisterTeamSession(baseDir: string, teamId: string): TeamV3Result<void> {
  const { entries } = readSessionRegistry(baseDir);
  const next = entries.filter((e) => e.teamId !== teamId);
  if (next.length === entries.length) return { ok: true, value: undefined };
  const written = writeSessionRegistry(baseDir, next);
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, value: undefined };
}

/** Liệt kê mọi session đang có team (để agent-view dashboard). */
export function listTeamSessions(baseDir: string): TeamSessionEntry[] {
  return readSessionRegistry(baseDir).entries;
}
