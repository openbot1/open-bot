/**
 * Agent Teams v1 — persistence (v1.09, Đội T1).
 *
 * Lưu toàn bộ team vào một file JSON (`agent-teams-v109.json` trong
 * thư mục dữ liệu của app), ghi nguyên tử (temp + rename, mode 0600)
 * cùng mẫu registry của fleet / orchestra store. File hỏng → load
 * trả về danh sách rỗng (fail-closed, không crash app) và ghi rõ lỗi
 * qua `loadError`.
 *
 * Không chứa secret: team chỉ lưu tên/model/goal/task/message — model
 * là tên model, không phải API key.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AGENT_TEAMS_V109_FILE, type AgentTeamV109 } from './types';

export interface TeamsV109FileData {
  version: 1;
  teams: AgentTeamV109[];
}

export interface TeamsV109StoreResult {
  teams: AgentTeamV109[];
  loadError?: string;
}

/** File-backed store cho Agent Teams v1. */
export class TeamsV109Store {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, AGENT_TEAMS_V109_FILE);
  }

  /** Đường dẫn file lưu (để tool/UI hiển thị). */
  get path(): string {
    return this.filePath;
  }

  /** Đọc toàn bộ team; file chưa có → rỗng; file hỏng → rỗng + loadError. */
  load(): TeamsV109StoreResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { teams: [] };
      return { teams: [], loadError: `Không đọc được file team: ${(err as Error).message}` };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return { teams: [], loadError: 'File team không phải JSON object.' };
      }
      const data = parsed as Partial<TeamsV109FileData>;
      if (!Array.isArray(data.teams)) {
        return { teams: [], loadError: 'File team thiếu mảng teams.' };
      }
      const teams = data.teams.filter(
        (t): t is AgentTeamV109 =>
          typeof t === 'object' && t !== null && typeof (t as AgentTeamV109).id === 'string',
      );
      return { teams };
    } catch (err) {
      return { teams: [], loadError: `File team JSON hỏng: ${(err as Error).message}` };
    }
  }

  /** Ghi toàn bộ team (ghi nguyên tử, mode 0600). */
  save(teams: AgentTeamV109[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: TeamsV109FileData = { version: 1, teams };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Tìm một team theo id (undefined = không có). */
  find(teamId: string): AgentTeamV109 | undefined {
    return this.load().teams.find((t) => t.id === teamId);
  }
}

/** Validate hình dạng một team đã load (bảo vệ khi file bị sửa tay). */
export function validateStoredTeam(team: unknown): string[] {
  const errors: string[] = [];
  if (typeof team !== 'object' || team === null) return ['Team không phải object.'];
  const t = team as Partial<AgentTeamV109>;
  if (typeof t.id !== 'string' || !t.id) errors.push('Team thiếu id.');
  if (typeof t.name !== 'string' || !t.name.trim()) errors.push('Team thiếu tên.');
  if (typeof t.leadId !== 'string' || !t.leadId) errors.push('Team thiếu leadId.');
  if (!Array.isArray(t.teammates)) errors.push('Team thiếu mảng teammates.');
  else {
    const leadCount = t.teammates.filter((m) => m.role === 'lead').length;
    if (leadCount !== 1) errors.push(`Team phải có đúng 1 lead (hiện ${leadCount}).`);
    if (!t.teammates.some((m) => m.id === t.leadId)) errors.push('leadId không trỏ tới teammate nào.');
    const names = new Set<string>();
    for (const m of t.teammates) {
      if (names.has(m.name)) errors.push(`Trùng tên teammate: ${m.name}.`);
      names.add(m.name);
    }
  }
  if (!Array.isArray(t.tasks)) errors.push('Team thiếu mảng tasks.');
  if (!Array.isArray(t.messages)) errors.push('Team thiếu mảng messages.');
  return errors;
}
