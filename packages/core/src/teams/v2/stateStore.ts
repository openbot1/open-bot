/**
 * Agent Teams v2 — trạng thái v2 bền vững trên disk (v1.10, Đội T3).
 *
 * File `teams-v2/<teamId>/v2.json` (ghi nguyên tử temp + rename,
 * mode 0600, cùng mẫu TeamsV109Store): cấu hình v2, assignment
 * lead giao, feedback reviewer, snapshot fork. Team v1 không có
 * file v2 → load trả về state mặc định (migration trong suốt).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  defaultTeamV2State,
  validateTeamV2Config,
  type TeamV2State,
} from './types';

/** Thư mục v2 của một team: `<baseDir>/teams-v2/<teamId>/`. */
export function teamV2Dir(baseDir: string, teamId: string): string {
  return path.join(baseDir, 'teams-v2', teamId);
}

/** Đường dẫn file trạng thái v2 của team. */
export function teamV2StatePath(baseDir: string, teamId: string): string {
  return path.join(teamV2Dir(baseDir, teamId), 'v2.json');
}

/** File-backed store cho trạng thái v2 của team. */
export class TeamV2Store {
  private readonly filePath: string;

  constructor(baseDir: string, teamId: string) {
    this.filePath = teamV2StatePath(baseDir, teamId);
  }

  /** Đường dẫn file trạng thái (để tool/UI hiển thị). */
  get path(): string {
    return this.filePath;
  }

  /** Đọc trạng thái v2; chưa có file → state mặc định (team v1 cũ). */
  load(): { state: TeamV2State; loadError?: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: defaultTeamV2State(this.teamIdFromPath()) };
      }
      return {
        state: defaultTeamV2State(this.teamIdFromPath()),
        loadError: `Không đọc được file trạng thái v2: ${(err as Error).message}`,
      };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return { state: defaultTeamV2State(this.teamIdFromPath()), loadError: 'File v2 không phải JSON object.' };
      }
      const data = parsed as Partial<TeamV2State>;
      const configErrors = validateTeamV2Config(data.config ?? {});
      if (configErrors.length > 0) {
        return { state: defaultTeamV2State(this.teamIdFromPath()), loadError: `File v2 cấu hình lỗi: ${configErrors.join(' ')}` };
      }
      return {
        state: {
          version: 2,
          teamId: typeof data.teamId === 'string' ? data.teamId : this.teamIdFromPath(),
          config: { ...defaultTeamV2State('').config, ...(data.config ?? {}) },
          assignments: Array.isArray(data.assignments) ? data.assignments : [],
          reviewFeedback: Array.isArray(data.reviewFeedback) ? data.reviewFeedback : [],
          forks: Array.isArray(data.forks) ? data.forks : [],
          updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
        },
      };
    } catch (err) {
      return {
        state: defaultTeamV2State(this.teamIdFromPath()),
        loadError: `File v2 JSON hỏng: ${(err as Error).message}`,
      };
    }
  }

  /** Ghi trạng thái v2 (ghi nguyên tử, mode 0600). */
  save(state: TeamV2State): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: TeamV2State = { ...state, version: 2, updatedAt: Date.now() };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  private teamIdFromPath(): string {
    return path.basename(path.dirname(this.filePath));
  }
}
