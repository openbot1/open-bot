/**
 * Agent Teams v3 — trạng thái v3 bền vững trên disk (v1.11, Đội T3).
 *
 * File `teams-v3/<teamId>/v3.json` (ghi nguyên tử temp + rename,
 * mode 0600, cùng mẫu TeamV2Store): cấu hình v3, lead mode + lịch
 * sử chuyển mode, challenge, log hội thoại team, panes tmux.
 * Team v1/v2 cũ không có file v3 → load trả về state mặc định
 * (migration trong suốt).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  defaultTeamV3State,
  TEAM_V3_STATE_FILE,
  validateTeamV3Config,
  type TeamV3State,
} from './types';
import { teamV3Dir } from './sessionRegistry';

/** Đường dẫn file trạng thái v3 của team. */
export function teamV3StatePath(baseDir: string, teamId: string): string {
  return path.join(teamV3Dir(baseDir), teamId, TEAM_V3_STATE_FILE);
}

/** File-backed store cho trạng thái v3 của team. */
export class TeamV3Store {
  private readonly filePath: string;

  constructor(
    baseDir: string,
    private readonly teamId: string,
  ) {
    this.filePath = teamV3StatePath(baseDir, teamId);
  }

  /** Đường dẫn file trạng thái (để tool/UI hiển thị). */
  get path(): string {
    return this.filePath;
  }

  /** Đọc trạng thái v3; chưa có file → state mặc định (team cũ chưa có v3). */
  load(): { state: TeamV3State; loadError?: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: defaultTeamV3State(this.teamId) };
      }
      return {
        state: defaultTeamV3State(this.teamId),
        loadError: `Không đọc được file trạng thái v3: ${(err as Error).message}`,
      };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return { state: defaultTeamV3State(this.teamId), loadError: 'File v3 không phải JSON object.' };
      }
      const obj = parsed as Partial<TeamV3State>;
      if (obj.version !== 3 || obj.teamId !== this.teamId) {
        return {
          state: defaultTeamV3State(this.teamId),
          loadError: `File v3 không đúng version/team (version=${String(obj.version)}, teamId=${String(obj.teamId)}).`,
        };
      }
      const errors = validateTeamV3Config(obj.config ?? {});
      if (errors.length > 0) {
        return { state: defaultTeamV3State(this.teamId), loadError: `File v3 cấu hình lỗi: ${errors.join(' ')}` };
      }
      const state = defaultTeamV3State(this.teamId, obj.config ?? {});
      return {
        state: {
          ...state,
          ...obj,
          config: { ...state.config, ...(obj.config ?? {}) },
          leadModeHistory: Array.isArray(obj.leadModeHistory) ? obj.leadModeHistory : [],
          challenges: Array.isArray(obj.challenges) ? obj.challenges : [],
          conversation: Array.isArray(obj.conversation) ? obj.conversation : [],
          panes: Array.isArray(obj.panes) ? obj.panes : [],
        },
      };
    } catch (err) {
      return {
        state: defaultTeamV3State(this.teamId),
        loadError: `File v3 lỗi JSON: ${(err as Error).message}`,
      };
    }
  }

  /** Ghi trạng thái v3 (nguyên tử temp + rename, mode 0600). */
  save(state: TeamV3State): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }
}
