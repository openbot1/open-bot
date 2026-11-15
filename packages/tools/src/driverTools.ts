/**
 * Driver tools cho @open-bot/tools (v1.06, Đội T3).
 *
 * Quản lý CLI binary tuỳ chỉnh qua agent:
 *  - `driver_register` — đăng ký driver mới (validate kỹ: id, binary
 *    tồn tại, argv không chứa cờ key/token, stream format hợp lệ).
 *  - `driver_list` — liệt kê driver đã đăng ký (kèm trạng thái bật/tắt).
 *  - `driver_test` — test kết nối driver (chạy version + probe login).
 *  - `driver_enable` / `driver_disable` — bật/tắt driver.
 *  - `driver_remove` — xoá driver.
 *
 * register/update/remove/enable/disable cần approval (ghi registry);
 * list/test chỉ đọc. `getDataDir` resolve thư mục dữ liệu (mặc định
 * `~/.open-bot` khi host không wire).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import { DriverRegistry, probeDriver } from '@open-bot/core';
import type { DriverStreamFormat, RegisterDriverInput } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const DRIVER_TOOL_NAMES = [
  'driver_register',
  'driver_list',
  'driver_test',
  'driver_enable',
  'driver_disable',
  'driver_remove',
] as const;

export interface DriverToolOptions {
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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

const STREAM_FORMATS: readonly string[] = ['json', 'json-rpc', 'acp', 'ndjson'];

export function createDriverTools(opts: DriverToolOptions = {}): Tool[] {
  const resolveDataDir = (): string => {
    try {
      const dir = opts.getDataDir?.();
      if (typeof dir === 'string' && dir.trim() !== '') return dir;
    } catch {
      /* rơi về mặc định */
    }
    return path.join(os.homedir(), '.open-bot');
  };
  const registry = (): DriverRegistry => new DriverRegistry({ dataDir: resolveDataDir() });

  const registerTool: Tool = {
    definition: toolDef(
      'driver_register',
      'Register a custom CLI binary as a driver: {id, name, providerId, binaryPath, argv?, streamFormat: json|json-rpc|acp|ndjson, versionArgs?, probeArgs?}. The binary must exist; argv must not contain API-key/token flags (sign in with the CLI itself instead).',
      {
        id: { type: 'string', description: 'Driver id slug, e.g. "my-cli".' },
        name: { type: 'string', description: 'Display name, e.g. "My CLI".' },
        providerId: { type: 'string', description: 'Provider id this driver serves, e.g. "my-provider".' },
        binaryPath: { type: 'string', description: 'Absolute path to the binary, or a binary name on PATH.' },
        argv: { type: 'array', items: { type: 'string' }, description: 'Fixed argv putting the CLI into agent/stream mode, e.g. ["acp"].' },
        streamFormat: { type: 'string', enum: [...STREAM_FORMATS], description: 'Stream format the CLI speaks.' },
        versionArgs: { type: 'array', items: { type: 'string' }, description: 'Args to print the version (default ["--version"]).' },
        probeArgs: { type: 'array', items: { type: 'string' }, description: 'Optional args to check sign-in, e.g. ["auth", "status"].' },
      },
      ['id', 'name', 'providerId', 'binaryPath', 'streamFormat'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const streamFormat = getStringArg(args, 'streamFormat');
        if (!STREAM_FORMATS.includes(streamFormat)) return errorResult(`streamFormat must be one of: ${STREAM_FORMATS.join(', ')}.`);
        const input: RegisterDriverInput = {
          id: getStringArg(args, 'id'),
          name: getStringArg(args, 'name'),
          providerId: getStringArg(args, 'providerId'),
          binaryPath: getStringArg(args, 'binaryPath'),
          streamFormat: streamFormat as DriverStreamFormat,
          ...(getStringArrayArg(args, 'argv') ? { argv: getStringArrayArg(args, 'argv') as string[] } : {}),
          ...(getStringArrayArg(args, 'versionArgs') ? { versionArgs: getStringArrayArg(args, 'versionArgs') as string[] } : {}),
          ...(getStringArrayArg(args, 'probeArgs') ? { probeArgs: getStringArrayArg(args, 'probeArgs') as string[] } : {}),
        };
        const cfg = registry().register(input);
        return truncate(JSON.stringify({ ok: true, driver: cfg }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listTool: Tool = {
    definition: toolDef(
      'driver_list',
      'List registered custom CLI drivers with their provider, binary, stream format, and enabled flag. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return truncate(JSON.stringify({ drivers: registry().list() }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const testTool: Tool = {
    definition: toolDef(
      'driver_test',
      'Test a registered driver connection: runs its version command (and sign-in probe when configured) and reports {ok, version, signedIn, latencyMs, error}. Read-only; never sends prompts or secrets.',
      {
        id: { type: 'string', description: 'Driver id to test.' },
      },
      ['id'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const id = getStringArg(args, 'id');
        const driver = registry().get(id);
        if (!driver) return errorResult(`Driver "${id}" không tồn tại.`);
        const result = await probeDriver(driver);
        return truncate(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const enableTool: Tool = {
    definition: toolDef(
      'driver_enable',
      'Enable a registered driver so the engine picker shows it and bots can use it.',
      { id: { type: 'string', description: 'Driver id to enable.' } },
      ['id'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const cfg = registry().enable(getStringArg(args, 'id'));
        return truncate(JSON.stringify({ ok: true, driver: cfg }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const disableTool: Tool = {
    definition: toolDef(
      'driver_disable',
      'Disable a registered driver so the engine picker hides it and bots cannot use it (fail-closed).',
      { id: { type: 'string', description: 'Driver id to disable.' } },
      ['id'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const cfg = registry().disable(getStringArg(args, 'id'));
        return truncate(JSON.stringify({ ok: true, driver: cfg }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const removeTool: Tool = {
    definition: toolDef(
      'driver_remove',
      'Remove a registered driver. Bots whose engine pick pointed at this driver fall back to their own provider/model default.',
      { id: { type: 'string', description: 'Driver id to remove.' } },
      ['id'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const removed = registry().remove(getStringArg(args, 'id'));
        return truncate(JSON.stringify({ ok: true, removed }, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [registerTool, listTool, testTool, enableTool, disableTool, removeTool];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const DRIVER_TOOLS: Tool[] = createDriverTools();
