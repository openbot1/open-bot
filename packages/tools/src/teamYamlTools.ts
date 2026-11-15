/**
 * Team YAML tools cho @open-bot/tools (v1.06, Đội T3).
 *
 *  - `team_yaml_apply` — áp dụng file team YAML (tạo/cập nhật bots
 *    trong bots.json; bot không nhắc tới được giữ nguyên). Cần
 *    approval vì ghi bots.json.
 *  - `team_yaml_export` — xuất team hiện tại ra YAML (chỉ đọc).
 *
 * Lỗi validate báo kèm số dòng trong file YAML để agent/user sửa
 * đúng chỗ. `getDataDir` resolve thư mục dữ liệu (mặc định
 * `~/.open-bot` khi host không wire).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import { applyTeamYamlV106 as applyTeamYaml, exportTeamYamlV106 as exportTeamYaml, TeamYamlError } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const TEAM_YAML_TOOL_NAMES = ['team_yaml_apply', 'team_yaml_export'] as const;

export interface TeamYamlToolOptions {
  /** Resolve thư mục dữ liệu (mặc định: ~/.open-bot). */
  getDataDir?: () => string | null | undefined;
  /** Tên tool đã biết (để validate `tools:` trong YAML; không truyền = chỉ kiểm tra mẫu tên). */
  getKnownTools?: () => string[];
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

export function createTeamYamlTools(opts: TeamYamlToolOptions = {}): Tool[] {
  const resolveDataDir = (): string => {
    try {
      const dir = opts.getDataDir?.();
      if (typeof dir === 'string' && dir.trim() !== '') return dir;
    } catch {
      /* rơi về mặc định */
    }
    return path.join(os.homedir(), '.open-bot');
  };
  const resolveKnownTools = (): string[] | undefined => {
    try {
      const tools = opts.getKnownTools?.();
      return Array.isArray(tools) && tools.length > 0 ? tools : undefined;
    } catch {
      return undefined;
    }
  };

  const applyTool: Tool = {
    definition: toolDef(
      'team_yaml_apply',
      'Apply a team YAML definition: creates/updates bots in bots.json from the YAML (bots not mentioned are kept). Validates first and reports errors with line numbers. YAML shape: team: {name, description?, bots: [{id, name, model, provider, computer: local|vm|own, tools?: [name...], prompt?}]}.',
      {
        yaml: { type: 'string', description: 'Full team YAML text.' },
      },
      ['yaml'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const yaml = getStringArg(args, 'yaml');
        const knownTools = resolveKnownTools();
        const result = applyTeamYaml(resolveDataDir(), yaml, { ...(knownTools ? { knownTools } : {}) });
        return truncate(
          JSON.stringify(
            {
              ok: true,
              team: result.teamName,
              created: result.created,
              updated: result.updated,
              botIds: result.botIds,
              botsPath: result.botsPath,
              yamlPath: result.yamlPath,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        if (err instanceof TeamYamlError) return errorResult(err.message);
        return errorResult((err as Error).message);
      }
    },
  };

  const exportTool: Tool = {
    definition: toolDef(
      'team_yaml_export',
      'Export the current team (bots.json) as team YAML text. Read-only; returns the YAML document.',
      {
        teamName: { type: 'string', description: 'Team name to use when no previous team YAML snapshot exists (default "Team của tôi").' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const teamName = getStringArg(args, 'teamName', false) || 'Team của tôi';
        return truncate(exportTeamYaml(resolveDataDir(), teamName));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [applyTool, exportTool];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const TEAM_YAML_TOOLS: Tool[] = createTeamYamlTools();
