/**
 * OpenMausBot-parity tools v1.05 (Đội T3) — đăng ký trong ALL_TOOLS
 * (xem tools.ts). Học Ý TƯỞNG từ OpenMausBot (doctor, team YAML,
 * model refresh, per-bot computer, headless server) — mọi code viết
 * mới hoàn toàn, gọi xuống core modules v1.05 của open-bot.
 *
 * - `openmausbot_v105_doctor` — chạy kiểm tra sức khoẻ hệ thống.
 * - `openmausbot_v105_team_validate` — parse + validate team YAML (không ghi gì).
 * - `openmausbot_v105_team_apply` — apply team YAML vào dataDir.
 * - `openmausbot_v105_team_export` — xuất team hiện có ra YAML.
 * - `openmausbot_v105_model_refresh` — làm mới danh sách model của provider.
 * - `openmausbot_v105_computer_status` — trạng thái máy-tính-bot (quota + usage đo được).
 * - `openmausbot_v105_computer_quota` — đặt quota mềm cho máy-tính-bot.
 * - `openmausbot_v105_headless_status` — kiểm tra headless server có trả /health không.
 *
 * Như fleet v1.03: `OPENMAUSBOT_V105_TOOLS` là bản chưa bind (dataDir
 * undefined → tool cần dataDir trả message rõ thay vì đoán đường
 * dẫn); host bind bằng `createOpenmausbotV105Tools({ getDataDir })`
 * để `createDefaultTools` thay thế tại chỗ, không đăng ký trùng.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  ModelRefreshService,
  applyTeamYaml,
  buildBotComputerStatusView,
  createOllamaModelFetcher,
  emptyBotComputerUsage,
  exportTeamYaml,
  loadBotComputerQuotas,
  measureDirSizeMb,
  parseTeamYaml,
  probeHeadlessHealth,
  renderDoctorReport,
  runDoctorChecks,
  saveBotComputerQuotas,
  upsertBotComputerQuota,
  validateBotComputerQuota,
} from '@open-bot/core';
import type { DoctorDeps, ModelListFetcher } from '@open-bot/core';

export const OPENMAUSBOT_V105_TOOL_NAMES = [
  'openmausbot_v105_doctor',
  'openmausbot_v105_team_validate',
  'openmausbot_v105_team_apply',
  'openmausbot_v105_team_export',
  'openmausbot_v105_model_refresh',
  'openmausbot_v105_computer_status',
  'openmausbot_v105_computer_quota',
  'openmausbot_v105_headless_status',
] as const;

/** Options khi bind tools (host truyền dataDir + fetcher mock cho test). */
export interface OpenmausbotV105ToolOptions {
  /** Thư mục dữ liệu của app (team.json, team-computers.json). */
  getDataDir?: () => string | null | undefined;
  /** Deps cho doctor (test mock; mặc định dùng deps thật). */
  doctorDeps?: DoctorDeps;
  /** Fetcher model riêng theo provider (test mock; mặc định Ollama thật). */
  modelFetchers?: Record<string, ModelListFetcher>;
  /** ModelRefreshService dùng chung (test có thể truyền service đã seed). */
  refreshService?: ModelRefreshService;
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

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true;
}

/** Tạo service refresh cho tools (Ollama thật + fetcher host truyền). */
function buildRefreshService(options: OpenmausbotV105ToolOptions): ModelRefreshService {
  if (options.refreshService) return options.refreshService;
  return new ModelRefreshService({
    fetchers: {
      ollama: createOllamaModelFetcher(),
      ...(options.modelFetchers ?? {}),
    },
    source: 'provider-api',
  });
}

/**
 * Tạo 8 tool v1.05. `getDataDir` undefined → các tool cần dataDir
 * trả lỗi rõ ràng thay vì đoán (giống fleet v1.03 placeholders).
 */
export function createOpenmausbotV105Tools(options: OpenmausbotV105ToolOptions = {}): Tool[] {
  const dataDir = (): string => {
    const dir = options.getDataDir?.();
    if (!dir) throw new Error('Chưa cấu hình thư mục dữ liệu (dataDir) cho open-bot.');
    return dir;
  };
  const refreshService = buildRefreshService(options);

  const doctorTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_doctor',
      'Kiểm tra sức khoẻ hệ thống open-bot: Node, provider đã cấu hình, Ollama local, MCP servers, RAM, ổ đĩa, port headless. Trả về báo cáo text hoặc JSON.',
      {
        format: { type: 'string', enum: ['text', 'json'], description: 'Định dạng báo cáo (mặc định text).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const report = await runDoctorChecks(options.doctorDeps ?? {});
        const format = getStringArg(args, 'format', false) || 'text';
        if (format === 'json') return JSON.stringify(report, null, 2);
        if (format !== 'text') throw new Error('format phải là "text" hoặc "json".');
        return renderDoctorReport(report, false);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamValidateTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_team_validate',
      'Parse và validate một file team YAML (version 1) mà không ghi gì. Trả về tóm tắt team (id, tên, số thành viên, số bot, số quota computer) hoặc lỗi rõ ràng.',
      { yaml: { type: 'string', description: 'Nội dung file team YAML.' } },
      ['yaml'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const doc = parseTeamYaml(getStringArg(args, 'yaml'));
        const quotas = doc.bots.filter((b) => b.computer).length;
        return JSON.stringify(
          {
            ok: true,
            teamId: doc.team.id,
            teamName: doc.team.name,
            members: doc.members.length,
            bots: doc.bots.length,
            computerQuotas: quotas,
            botIds: doc.bots.map((b) => b.botId),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamApplyTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_team_apply',
      'Áp dụng team YAML: validate rồi ghi team.json + quota máy-tính-bot vào thư mục dữ liệu. dryRun=true thì chỉ validate, không ghi.',
      {
        yaml: { type: 'string', description: 'Nội dung file team YAML.' },
        dryRun: { type: 'boolean', description: 'Chỉ validate, không ghi file (mặc định false).' },
      },
      ['yaml'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const result = applyTeamYaml(getStringArg(args, 'yaml'), dataDir(), {
          dryRun: getBoolArg(args, 'dryRun'),
        });
        return JSON.stringify(
          {
            ok: true,
            dryRun: result.dryRun,
            teamId: result.team.id,
            teamName: result.team.name,
            members: result.team.members.length,
            sharedBots: result.team.sharedBots.length,
            computerQuotas: result.computerQuotas,
            path: result.teamPath,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const teamExportTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_team_export',
      'Xuất team hiện có trong thư mục dữ liệu ra YAML (kèm quota máy-tính-bot nếu có).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        return exportTeamYaml(dataDir());
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const modelRefreshTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_model_refresh',
      'Làm mới danh sách model của một provider từ nguồn của provider đó (Ollama local hoặc API /v1/models). Trả về danh sách model + thời điểm cập nhật.',
      { provider: { type: 'string', description: 'Provider id, vd "ollama".' } },
      ['provider'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const provider = getStringArg(args, 'provider');
        const entry = await refreshService.refresh(provider);
        return JSON.stringify(
          {
            ok: true,
            providerId: entry.providerId,
            models: entry.models,
            modelCount: entry.models.length,
            updatedAt: new Date(entry.updatedAt).toISOString(),
            source: entry.source,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const computerStatusTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_computer_status',
      'Trạng thái máy-tính-bot: quota đã đặt, dung lượng đĩa workspace đo được thật, cảnh báo khi gần/vượt quota. Số nào không đo được ghi null, không bịa.',
      {
        botId: { type: 'string', description: 'Id của bot.' },
        workspaceDir: { type: 'string', description: 'Thư mục workspace của bot để đo đĩa (mặc định workspace của tool call).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args, ctx: ToolContext) => {
      try {
        const botId = getStringArg(args, 'botId');
        let quota = null;
        try {
          quota = loadBotComputerQuotas(dataDir()).find((q) => q.botId === botId) ?? null;
        } catch {
          quota = null;
        }
        const workspaceDir = getStringArg(args, 'workspaceDir', false) || ctx.workspaceDir;
        const diskMb = workspaceDir ? measureDirSizeMb(workspaceDir) : null;
        const usage = { ...emptyBotComputerUsage(botId), diskMb };
        const view = buildBotComputerStatusView(botId, quota, usage, null);
        return JSON.stringify(view, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const computerQuotaTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_computer_quota',
      'Đặt quota mềm cho máy-tính-bot (level, CPU cores, RAM MB, đĩa MB, số process tối đa). Field nào không truyền thì giữ nguyên quota cũ (hoặc không giới hạn khi chưa có).',
      {
        botId: { type: 'string', description: 'Id của bot.' },
        level: { type: 'string', enum: ['box', 'container', 'vm'], description: 'Mức cách ly mong muốn.' },
        cpuCores: { type: 'number', description: 'Số core logic tối đa.' },
        memoryMb: { type: 'number', description: 'RAM tối đa (MB).' },
        diskMb: { type: 'number', description: 'Đĩa tối đa cho workspace (MB).' },
        maxProcesses: { type: 'number', description: 'Số process tối đa.' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      try {
        const botId = getStringArg(args, 'botId');
        const dir = dataDir();
        let existing: ReturnType<typeof loadBotComputerQuotas> = [];
        try {
          existing = loadBotComputerQuotas(dir);
        } catch {
          existing = [];
        }
        const prev = existing.find((q) => q.botId === botId);
        const merged = {
          ...(prev ?? { botId }),
          botId,
          ...(getStringArg(args, 'level', false) ? { level: getStringArg(args, 'level') as 'box' | 'container' | 'vm' } : {}),
          ...(getNumberArg(args, 'cpuCores') !== undefined ? { cpuCores: getNumberArg(args, 'cpuCores') } : {}),
          ...(getNumberArg(args, 'memoryMb') !== undefined ? { memoryMb: getNumberArg(args, 'memoryMb') } : {}),
          ...(getNumberArg(args, 'diskMb') !== undefined ? { diskMb: getNumberArg(args, 'diskMb') } : {}),
          ...(getNumberArg(args, 'maxProcesses') !== undefined ? { maxProcesses: getNumberArg(args, 'maxProcesses') } : {}),
        };
        const quota = validateBotComputerQuota(merged);
        saveBotComputerQuotas(dir, upsertBotComputerQuota(existing, quota));
        return JSON.stringify({ ok: true, quota }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const headlessStatusTool: Tool = {
    definition: toolDef(
      'openmausbot_v105_headless_status',
      'Kiểm tra headless server có đang trả /health trên loopback không. Trả về trạng thái, version, uptime, pid — hoặc "không chạy".',
      {
        host: { type: 'string', description: 'Host loopback (mặc định 127.0.0.1).' },
        port: { type: 'number', description: 'Port headless (mặc định 8799).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const host = getStringArg(args, 'host', false) || '127.0.0.1';
        const port = getNumberArg(args, 'port') ?? 8799;
        const health = await probeHeadlessHealth(host, port);
        if (!health) {
          return JSON.stringify({ running: false, host, port }, null, 2);
        }
        return JSON.stringify({ running: true, host, port, ...health }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    doctorTool,
    teamValidateTool,
    teamApplyTool,
    teamExportTool,
    modelRefreshTool,
    computerStatusTool,
    computerQuotaTool,
    headlessStatusTool,
  ];
}

/** Bản chưa bind (dùng trong ALL_TOOLS) — xem ghi chú ở đầu file. */
export const OPENMAUSBOT_V105_TOOLS: Tool[] = createOpenmausbotV105Tools();
