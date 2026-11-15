/**
 * Doctor tools cho @open-bot/tools (v1.06, Đội T3).
 *
 * Agent tự chẩn đoán môi trường rồi đề xuất cách sửa:
 *  - `doctor_run` — chạy toàn bộ 11 check (hoặc một tập check qua
 *    `only`), trả báo cáo JSON (summary + từng check + gợi ý sửa).
 *  - `doctor_check` — chạy 1 check theo id (vd chỉ kiểm tra lại
 *    `cli-engines` sau khi user đăng nhập xong).
 *
 * Chỉ đọc, không sửa môi trường, không chạm secret. `needsApproval:
 * false` cả hai (giống harness v2 tools). `getDataDir` resolve thư
 * mục dữ liệu (mặc định `~/.open-bot` khi host không wire).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import { formatDoctorReport, runDoctor } from '@open-bot/core';
import type { DoctorCheckId } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export const DOCTOR_TOOL_NAMES = ['doctor_run', 'doctor_check'] as const;

export interface DoctorToolOptions {
  /** Resolve thư mục dữ liệu (mặc định: ~/.open-bot). */
  getDataDir?: () => string | null | undefined;
}

const DOCTOR_CHECK_IDS: readonly DoctorCheckId[] = [
  'node-version',
  'npm-version',
  'os',
  'cpu',
  'memory',
  'disk',
  'cli-engines',
  'harness-loopback',
  'harness-port',
  'vault',
  'data-dir',
];

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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function getOptionalIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Argument "${name}" must be a positive integer.`);
  }
  return value;
}

export function createDoctorTools(opts: DoctorToolOptions = {}): Tool[] {
  const resolveDataDir = (): string => {
    try {
      const dir = opts.getDataDir?.();
      if (typeof dir === 'string' && dir.trim() !== '') return dir;
    } catch {
      /* rơi về mặc định */
    }
    return path.join(os.homedir(), '.open-bot');
  };

  const doctorRunTool: Tool = {
    definition: toolDef(
      'doctor_run',
      'Run the open-bot environment doctor: checks Node/npm, OS, CPU/RAM/disk, installed + signed-in CLI agents, harness loopback/port, vault keys, and the data dir. Read-only; returns a JSON report {summary, ok, checks[]} with a fix suggestion per failing check.',
      {
        only: { type: 'array', items: { type: 'string', enum: [...DOCTOR_CHECK_IDS] }, description: 'Only run these checks (default: all 11).' },
        harnessPort: { type: 'integer', description: 'Harness port to check for occupancy (default 18789).' },
        format: { type: 'string', enum: ['json', 'text'], description: 'Output format (default json).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const only = getStringArrayArg(args, 'only');
        if (only) {
          for (const id of only) {
            if (!(DOCTOR_CHECK_IDS as readonly string[]).includes(id)) {
              return errorResult(`Unknown doctor check "${id}" — valid: ${DOCTOR_CHECK_IDS.join(', ')}.`);
            }
          }
        }
        const harnessPort = getOptionalIntArg(args, 'harnessPort');
        const format = getStringArg(args, 'format', false) || 'json';
        if (format !== 'json' && format !== 'text') return errorResult('Argument "format" must be "json" or "text".');
        const report = await runDoctor(
          { dataDir: resolveDataDir(), ...(harnessPort ? { harnessPort } : {}) },
          { ...(only ? { only: only as DoctorCheckId[] } : {}) },
        );
        if (format === 'text') {
          return truncate(formatDoctorReport(report));
        }
        return truncate(JSON.stringify(report, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const doctorCheckTool: Tool = {
    definition: toolDef(
      'doctor_check',
      'Run a single doctor check by id (e.g. "cli-engines" after the user signs into a CLI, or "disk" after freeing space). Returns one check {id, status, detail, fix}. Read-only.',
      {
        check: { type: 'string', enum: [...DOCTOR_CHECK_IDS], description: 'Check id to run.' },
      },
      ['check'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const check = getStringArg(args, 'check');
        if (!(DOCTOR_CHECK_IDS as readonly string[]).includes(check)) {
          return errorResult(`Unknown doctor check "${check}" — valid: ${DOCTOR_CHECK_IDS.join(', ')}.`);
        }
        const report = await runDoctor({ dataDir: resolveDataDir() }, { only: [check as DoctorCheckId] });
        const single = report.checks[0];
        if (!single) return errorResult(`Check "${check}" produced no result.`);
        return truncate(JSON.stringify(single, null, 2));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [doctorRunTool, doctorCheckTool];
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const DOCTOR_TOOLS: Tool[] = createDoctorTools();
