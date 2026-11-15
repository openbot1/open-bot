/**
 * Engine picker tools cho @open-bot/tools (v1.06, Đội T3).
 *
 *  - `engine_list` — liệt kê engine khả dụng (CLI đã detect + driver
 *    đã đăng ký + provider API), kèm trạng thái chọn được hay không.
 *  - `engine_pick` — chọn engine + model cho một bot (lưu bền).
 *  - `engine_current` — engine bot đang dùng (pick đã lưu, hoặc mặc
 *    định của bot).
 *  - `engine_unpick` — xoá lựa chọn (bot về mặc định của nó).
 *
 * pick/unpick cần approval (ghi engine-picks.json); list/current chỉ
 * đọc. `getDataDir` resolve thư mục dữ liệu (mặc định `~/.open-bot`
 * khi host không wire). Catalog CLI lấy từ DetectedEngineRegistry
 * (snapshot mới nhất, có cache TTL); driver lấy từ DriverRegistry.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import { DetectedEngineRegistry, DriverRegistry, EnginePicker, listEngines } from '@open-bot/core';
import type { EngineOption } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const ENGINE_PICKER_TOOL_NAMES = ['engine_list', 'engine_pick', 'engine_current', 'engine_unpick'] as const;

export interface EnginePickerToolOptions {
  /** Resolve thư mục dữ liệu (mặc định: ~/.open-bot). */
  getDataDir?: () => string | null | undefined;
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

export function createEnginePickerTools(opts: EnginePickerToolOptions = {}): Tool[] {
  const resolveDataDir = (): string => {
    try {
      const dir = opts.getDataDir?.();
      if (typeof dir === 'string' && dir.trim() !== '') return dir;
    } catch {
      /* rơi về mặc định */
    }
    return path.join(os.homedir(), '.open-bot');
  };

  /** Catalog engine hiện tại (CLI detect + driver + API). */
  async function catalog(dataDir: string): Promise<EngineOption[]> {
    let detected = null;
    try {
      const registry = new DetectedEngineRegistry({ stateFilePath: path.join(dataDir, 'detected-engines.json') });
      detected = await registry.detect();
    } catch {
      detected = null; // detect lỗi → catalog chỉ còn driver + API, không crash tool
    }
    const drivers = new DriverRegistry({ dataDir }).list();
    return listEngines({ detected, drivers });
  }

  /** Bot mặc định từ bots.json (để currentEngine rơi về khi chưa pick). */
  function botDefault(dataDir: string, botId: string): { botId: string; providerId: string; model: string } | null {
    try {
      const botsFile = path.join(dataDir, 'bots.json');
      if (!fs.existsSync(botsFile)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(botsFile, 'utf8'));
      if (!Array.isArray(parsed)) return null;
      for (const entry of parsed as Array<{ bot?: { id?: unknown; providerId?: unknown; model?: unknown } }>) {
        if (entry?.bot?.id === botId) {
          return {
            botId,
            providerId: typeof entry.bot.providerId === 'string' ? entry.bot.providerId : 'mock',
            model: typeof entry.bot.model === 'string' ? entry.bot.model : 'mock',
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  const listTool: Tool = {
    definition: toolDef(
      'engine_list',
      'List engines available for bots: detected CLIs (installed + signed-in + enabled), registered custom drivers, and API providers. Each entry has {id, source, label, providerId, models, installed, signedIn, enabled, unavailableReason}. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const engines = await catalog(resolveDataDir());
        return truncate(JSON.stringify({ engines }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pickTool: Tool = {
    definition: toolDef(
      'engine_pick',
      'Pick an engine + model for a bot (saved to engine-picks.json). The engine must exist in the catalog and be pickable (installed, signed in when verifiable, enabled). Use engine_list to see valid engine ids like "cli:claude-code" or "api:gemini".',
      {
        botId: { type: 'string', description: 'Bot id to pick an engine for.' },
        engineId: { type: 'string', description: 'Engine id from engine_list, e.g. "cli:claude-code", "api:gemini", "driver:my-cli".' },
        model: { type: 'string', description: 'Model to run on this engine, e.g. "claude-sonnet-4-5".' },
      },
      ['botId', 'engineId', 'model'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const dataDir = resolveDataDir();
        const engines = await catalog(dataDir);
        const pick = new EnginePicker({ dataDir }).pick(getStringArg(args, 'botId'), getStringArg(args, 'engineId'), getStringArg(args, 'model'), engines);
        return truncate(JSON.stringify({ ok: true, pick }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const currentTool: Tool = {
    definition: toolDef(
      'engine_current',
      'Show which engine a bot is currently using: its saved pick when still valid, otherwise the bot\'s own provider/model default. Read-only.',
      {
        botId: { type: 'string', description: 'Bot id to inspect.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const dataDir = resolveDataDir();
        const botId = getStringArg(args, 'botId');
        const def = botDefault(dataDir, botId);
        if (!def) return errorResult(`Không thấy bot "${botId}" trong bots.json.`);
        const engines = await catalog(dataDir);
        const current = new EnginePicker({ dataDir }).currentEngine(def, engines);
        return truncate(JSON.stringify(current, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const unpickTool: Tool = {
    definition: toolDef(
      'engine_unpick',
      'Remove a bot\'s saved engine pick so it goes back to its own provider/model default.',
      {
        botId: { type: 'string', description: 'Bot id to clear the engine pick for.' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const removed = new EnginePicker({ dataDir: resolveDataDir() }).unpick(getStringArg(args, 'botId'));
        if (!removed) return errorResult(`Bot "${getStringArg(args, 'botId')}" chưa có lựa chọn engine nào để xoá.`);
        return truncate(JSON.stringify({ ok: true, removed }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [listTool, pickTool, currentTool, unpickTool];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const ENGINE_PICKER_TOOLS: Tool[] = createEnginePickerTools();
