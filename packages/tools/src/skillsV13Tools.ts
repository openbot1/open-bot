/**
 * Agent tools cho Agent Skills loader v13 (v1.13, Team T1).
 *
 * Tám tool nối các module `packages/core/src/skills/v13/` ra agent loop:
 *  - `skills_v13_list` (chỉ đọc): liệt kê skill trong một thư mục —
 *    tier 1 (chỉ frontmatter), kèm token header và lỗi từng skill.
 *  - `skills_v13_search` (chỉ đọc): tìm skill của chính open-bot
 *    theo mô tả nhiệm vụ (catalog nội bộ), hoặc theo ngữ cảnh làm việc.
 *  - `skills_v13_validate` (chỉ đọc): kiểm tra một SKILL.md theo
 *    chuẩn v13 — trả lỗi/cảnh báo + điểm chất lượng + context tax.
 *  - `skills_v13_audit` (chỉ đọc): báo cáo lãng phí (tool-budget +
 *    context-tax) từ log tool-call và thư mục skills.
 *  - `skills_v13_import` (cần duyệt): nhập một skill từ thư mục của
 *    Claude Code / Codex CLI / Gemini CLI vào thư mục skills.
 *  - `skills_v13_export` (cần duyệt): xuất một skill sang thư mục của
 *    một host khác (Claude Code / Codex / Gemini).
 *  - `skills_v13_install_local` (cần duyệt): cài một skill từ
 *    marketplace cục bộ (thư mục local) vào thư mục skills.
 *  - `skills_v13_uninstall` (cần duyệt): gỡ một skill đã cài.
 *
 * An toàn:
 * - Không tool nào tự chọn thư mục: `skillsDir` phải do host cấu
 *   hình qua `opts.getSkillsDir` (install/uninstall/import) hoặc do
 *   người gọi truyền rõ (list/validate/audit). Không có thư mục thì
 *   báo lỗi rõ ràng thay vì ghi vào chỗ khiến skill vô hình.
 * - Mọi đường dẫn import/export/install đều qua loader + v13
 *   validation (kèm quét secret) — skill lỗi không bao giờ được ghi.
 * - Tool không bao giờ in nội dung secret: validation chỉ báo mã lỗi
 *   và thông báo, không in lại đoạn text bị nghi là secret.
 * - Uninstall chỉ xóa thư mục chứa SKILL.md (module marketplace
 *   cục bộ đã chặn mọi thư mục khác).
 *
 * Factory:
 *   createSkillsV13Tools(opts?) -> Tool[]   (bound, usable)
 *   SKILLS_V13_TOOLS                        (unbound placeholder)
 *
 * Approval: 4 tool chỉ đọc -> false; 4 tool thay đổi hệ thống -> true.
 * KHÔNG tự đăng ký vào ALL_TOOLS — điều phối viên nối factory vào
 * defaultToolFactory (cần opts.getSkillsDir).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  auditToolBudget,
  buildWasteReport,
  formatWasteReport,
} from '@open-bot/core/dist/skills/v13/audit.js';
import type { ToolCallRecord } from '@open-bot/core/dist/skills/v13/audit.js';
import {
  getInternalSkill,
  searchInternalSkills,
  skillsForContext,
} from '@open-bot/core/dist/skills/v13/internalRegistry.js';
import type { InternalSkillContext } from '@open-bot/core/dist/skills/v13/internalRegistry.js';
import {
  exportSkillToHost,
  importSkillFromHost,
} from '@open-bot/core/dist/skills/v13/interop.js';
import type { SkillHostFormat } from '@open-bot/core/dist/skills/v13/interop.js';
import {
  installLocalSkill,
  uninstallLocalSkill,
} from '@open-bot/core/dist/skills/v13/localMarketplace.js';
import { SkillSessionIndex } from '@open-bot/core/dist/skills/v13/sessionIndex.js';
import {
  formatValidationSummary,
  validateSkillFileTextV13,
} from '@open-bot/core/dist/skills/v13/validation.js';

/** Tuỳ chọn của factory — host cho biết skill được cài vào đâu. */
export interface SkillsV13ToolOptions {
  /**
   * Trả về thư mục chứa các skill đã cài (`<skillsDir>/<tên-skill>/`).
   * Trả `null` khi chưa cấu hình — các tool ghi sẽ báo lỗi rõ ràng
   * thay vì tự cài vào một chỗ khác.
   */
  getSkillsDir?: () => string | null;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Thiếu tham số bắt buộc: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Tham số "${name}" phải là chuỗi, nhận được ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Tham số "${name}" phải là boolean, nhận được ${typeof value}`);
  }
  return value;
}

function getSkillsDirOrError(opts: SkillsV13ToolOptions): string {
  const dir = opts.getSkillsDir?.() ?? null;
  if (!dir || typeof dir !== 'string' || dir.trim() === '') {
    throw new Error(
      'Chưa cấu hình thư mục skills (skillsDir) nên không biết cài skill vào đâu — ' +
        'host cần truyền getSkillsDir cho createSkillsV13Tools. Không tự cài vào thư mục khác.',
    );
  }
  return dir;
}

function parseHostFormat(raw: string): SkillHostFormat {
  if (raw === 'claude-code' || raw === 'codex-cli' || raw === 'gemini-cli') return raw;
  throw new Error(
    `Host không hợp lệ: ${JSON.stringify(raw)} — phải là "claude-code", "codex-cli" hoặc "gemini-cli".`,
  );
}

function parseToolCallRecords(raw: string): ToolCallRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Tham số "usageJson" không phải JSON hợp lệ — cần một mảng các {skillName, toolName} (error tùy chọn).');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Tham số "usageJson" phải là một mảng JSON các bản ghi tool-call.');
  }
  const records: ToolCallRecord[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Mỗi bản ghi trong "usageJson" phải là một object {skillName, toolName}.');
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec['skillName'] !== 'string' || typeof rec['toolName'] !== 'string') {
      throw new Error('Mỗi bản ghi trong "usageJson" cần "skillName" và "toolName" dạng chuỗi.');
    }
    records.push({
      skillName: rec['skillName'],
      toolName: rec['toolName'],
      error: typeof rec['error'] === 'boolean' ? rec['error'] : false,
    });
  }
  return records;
}

function parseActivations(raw: string): Record<string, number> {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Tham số "activationsJson" không phải JSON hợp lệ — cần một object {tên-skill: số-lần-kích-hoạt}.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tham số "activationsJson" phải là một object JSON {tên-skill: số-lần-kích-hoạt}.');
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Số lần kích hoạt của skill ${JSON.stringify(key)} phải là số >= 0.`);
    }
    out[key] = Math.floor(value);
  }
  return out;
}

const SKILL_V13_TOOL_NAMES = [
  'skills_v13_list',
  'skills_v13_search',
  'skills_v13_validate',
  'skills_v13_audit',
  'skills_v13_import',
  'skills_v13_export',
  'skills_v13_install_local',
  'skills_v13_uninstall',
] as const;

export function createSkillsV13Tools(opts: SkillsV13ToolOptions = {}): Tool[] {
  const listTool: Tool = {
    definition: {
      name: 'skills_v13_list',
      description:
        'Liệt kê các skill trong một thư mục (tier 1 — chỉ đọc frontmatter, không đọc body): ' +
        'tên, mô tả, phiên bản, tools cho phép, token header và skill nào lỗi. ' +
        'Chỉ đọc — không cài hay sửa gì cả.',
      parameters: {
        type: 'object',
        properties: {
          dir: {
            type: 'string',
            description: 'Thư mục chứa skill (mỗi skill là <tên>/SKILL.md hoặc <tên>.md).',
          },
        },
        required: ['dir'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const dir = getStringArg(args, 'dir');
        if (dir.trim() === '') return errorResult('Thư mục không được rỗng.');
        const index = SkillSessionIndex.open([dir]);
        const lines: string[] = [`Skills trong ${JSON.stringify(dir)}: ${index.size} skill, ${index.errors.length} lỗi.`];
        lines.push(`Tổng token header (giá của index lúc mở session): ~${index.totalHeaderTokens()}.`);
        for (const entry of index.entries) {
          const flags = [
            entry.context === 'fork' ? 'fork' : '',
            entry.disableModelInvocation ? 'chỉ-người-dùng' : '',
            entry.userInvocable ? '' : 'ẩn-khỏi-menu',
          ]
            .filter(Boolean)
            .join(', ');
          lines.push(
            `- ${entry.name} (v${entry.version}): ${entry.description} [~${entry.headerTokens} token${flags ? `; ${flags}` : ''}]`,
          );
        }
        if (index.errors.length > 0) {
          lines.push('Lỗi (skill hỏng bị bỏ qua, các skill khác vẫn liệt kê):');
          for (const e of index.errors) lines.push(`  - ${e.file}: ${e.error}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const searchTool: Tool = {
    definition: {
      name: 'skills_v13_search',
      description:
        'Tìm skill của chính open-bot theo mô tả nhiệm vụ (khớp tên, mô tả, when-to-use và từ kích hoạt), ' +
        'hoặc liệt kê skill kích hoạt cho một ngữ cảnh làm việc (coding, review, writing, research, data, meeting, ' +
        'release, translation, memory, voice, platform, git). Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Mô tả nhiệm vụ cần tìm skill cho (vd "review this pull request"). Bỏ trống khi dùng context.',
          },
          context: {
            type: 'string',
            description:
              'Ngữ cảnh làm việc: coding, review, writing, research, data, meeting, release, translation, memory, voice, platform, git. Ưu tiên hơn query khi cả hai đều có.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const contextRaw = getStringArg(args, 'context', false);
        if (contextRaw.trim() !== '') {
          const validContexts: InternalSkillContext[] = [
            'coding', 'review', 'writing', 'research', 'data', 'meeting',
            'release', 'translation', 'memory', 'voice', 'platform', 'git',
          ];
          if (!(validContexts as string[]).includes(contextRaw)) {
            return errorResult(
              `Ngữ cảnh không hợp lệ: ${JSON.stringify(contextRaw)} — phải là một trong: ${validContexts.join(', ')}.`,
            );
          }
          const entries = skillsForContext(contextRaw as InternalSkillContext);
          if (entries.length === 0) return `Không có skill nào kích hoạt cho ngữ cảnh ${JSON.stringify(contextRaw)}.`;
          const lines = [`Skills kích hoạt cho ngữ cảnh ${JSON.stringify(contextRaw)}:`];
          for (const e of entries) lines.push(`- ${e.name} (${e.category}): ${e.description}`);
          return lines.join('\n');
        }
        const query = getStringArg(args, 'query', false);
        if (query.trim() === '') {
          return errorResult('Cần "query" (mô tả nhiệm vụ) hoặc "context" (ngữ cảnh làm việc).');
        }
        const hits = searchInternalSkills(query, 5);
        if (hits.length === 0) return `Không tìm thấy skill nào của open-bot khớp với ${JSON.stringify(query)}.`;
        const lines = [`Skills khớp với ${JSON.stringify(query)}:`];
        for (const hit of hits) {
          const triggers = hit.matchedTriggers.length > 0 ? ` (khớp: ${hit.matchedTriggers.join(', ')})` : '';
          lines.push(`- ${hit.entry.name} (điểm ${hit.score}): ${hit.entry.description}${triggers}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validateTool: Tool = {
    definition: {
      name: 'skills_v13_validate',
      description:
        'Kiểm tra một file SKILL.md theo chuẩn v13: frontmatter bắt buộc, compatibility tối đa 500 ký tự, ' +
        'license, metadata, allowed-tools, mô tả phải nói rõ khi nào dùng, body không quá dài. ' +
        'Trả lỗi, cảnh báo, điểm chất lượng 0–100 và context tax ước lượng. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Đường dẫn tuyệt đối tới file SKILL.md (hoặc file .md của skill) cần kiểm tra.',
          },
        },
        required: ['file'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const file = getStringArg(args, 'file');
        if (file.trim() === '') return errorResult('Đường dẫn file không được rỗng.');
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          return errorResult(`Không đọc được file ${JSON.stringify(file)}.`);
        }
        const result = validateSkillFileTextV13(text, {}, file);
        return formatValidationSummary(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditTool: Tool = {
    definition: {
      name: 'skills_v13_audit',
      description:
        'Báo cáo lãng phí skill (kiểu mcode-stack): tool-budget audit (đếm tool-call theo skill, skill nào vượt ngân sách, ' +
        'tool nào chiếm đa số, skill nào lỗi nhiều) + context-tax audit (token header/body, skill nào không bao giờ kích hoạt). ' +
        'Trả báo cáo Markdown có xếp hạng lãng phí và khuyến nghị. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          skillsDir: {
            type: 'string',
            description: 'Thư mục skills cần audit context tax (mỗi skill là <tên>/SKILL.md hoặc <tên>.md).',
          },
          usageJson: {
            type: 'string',
            description:
              'JSON mảng các bản ghi tool-call: [{"skillName": "code-review", "toolName": "read_file", "error": false}]. ' +
              'Bỏ trống = không có log tool-call (chỉ audit context tax).',
          },
          activationsJson: {
            type: 'string',
            description:
              'JSON object số lần mỗi skill được kích hoạt trong session: {"code-review": 2}. Bỏ trống = chưa skill nào kích hoạt.',
          },
        },
        required: ['skillsDir'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const skillsDir = getStringArg(args, 'skillsDir');
        if (skillsDir.trim() === '') return errorResult('Thư mục skills không được rỗng.');
        const usageJson = getStringArg(args, 'usageJson', false);
        const activationsJson = getStringArg(args, 'activationsJson', false);
        const records = usageJson.trim() === '' ? [] : parseToolCallRecords(usageJson);
        const activations = parseActivations(activationsJson);
        const index = SkillSessionIndex.open([skillsDir]);
        const report = buildWasteReport(
          `audit ${skillsDir}`,
          records,
          index.entries,
          activations,
        );
        return formatWasteReport(report);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const importTool: Tool = {
    definition: {
      name: 'skills_v13_import',
      description:
        'Nhập một skill từ thư mục của Claude Code (.claude/skills/<tên>/), Codex CLI (~/.agents/skills/<tên>/) ' +
        'hoặc Gemini CLI (~/.gemini/skills/<tên>/) vào thư mục skills đã cấu hình. Skill được kiểm tra (loader + v13 + quét secret) ' +
        'trước khi copy — skill lỗi thì không cài. Cần duyệt vì thay đổi hệ thống.',
      parameters: {
        type: 'object',
        properties: {
          sourceDir: {
            type: 'string',
            description: 'Đường dẫn tuyệt đối tới thư mục skill nguồn (vd /home/user/.claude/skills/code-review).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Ghi đè skill cùng tên đã tồn tại (mặc định false).',
          },
        },
        required: ['sourceDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const sourceDir = getStringArg(args, 'sourceDir');
        if (sourceDir.trim() === '') return errorResult('Thư mục nguồn không được rỗng.');
        const overwrite = getBoolArg(args, 'overwrite', false);
        const skillsDir = getSkillsDirOrError(opts);
        const result = importSkillFromHost(sourceDir, skillsDir, { overwrite });
        const lines = [
          `Đã nhập skill "${result.name}" từ ${JSON.stringify(sourceDir)} (định dạng nguồn: ${result.sourceFormat}) vào ${JSON.stringify(result.installedDir)}.`,
          `Số file đã copy: ${result.filesCopied} (${result.bytesCopied} byte).`,
          `Điểm chất lượng v13: ${result.validation.qualityScore}/100${result.validation.warnings.length > 0 ? `, ${result.validation.warnings.length} cảnh báo` : ', không có cảnh báo'}.`,
        ];
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportTool: Tool = {
    definition: {
      name: 'skills_v13_export',
      description:
        'Xuất một skill đã cài sang thư mục của Claude Code, Codex CLI hoặc Gemini CLI ' +
        '(<root>/<tên>/SKILL.md + scripts/ + references/ + assets/). Skill được kiểm tra v13 trước khi ghi — ' +
        'skill lỗi thì không xuất. Cần duyệt vì ghi ra ngoài thư mục skills.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Tên skill cần xuất (phải có trong thư mục skills đã cấu hình).',
          },
          format: {
            type: 'string',
            description: 'Host đích: "claude-code", "codex-cli" hoặc "gemini-cli".',
          },
          rootDir: {
            type: 'string',
            description:
              'Thư mục skills của host đích (vd ~/.claude/skills). Bỏ trống = dùng thư mục mặc định của host đó.',
          },
          overwrite: {
            type: 'boolean',
            description: 'Ghi đè skill cùng tên đã tồn tại ở đích (mặc định false).',
          },
        },
        required: ['name', 'format'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const format = parseHostFormat(getStringArg(args, 'format'));
        const rootDirRaw = getStringArg(args, 'rootDir', false);
        const overwrite = getBoolArg(args, 'overwrite', false);
        const skillsDir = getSkillsDirOrError(opts);
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        const defaultRoots: Record<SkillHostFormat, string> = {
          'claude-code': path.join(home, '.claude', 'skills'),
          'codex-cli': path.join(home, '.agents', 'skills'),
          'gemini-cli': path.join(home, '.gemini', 'skills'),
        };
        const rootDir = rootDirRaw.trim() === '' ? defaultRoots[format] : rootDirRaw;
        if (rootDir.trim() === '') {
          return errorResult('Không xác định được thư mục đích — truyền "rootDir" rõ ràng.');
        }
        const result = exportSkillToHost(path.join(skillsDir, name), format, rootDir, { overwrite });
        return (
          `Đã xuất skill "${result.name}" sang ${format} tại ${JSON.stringify(result.destDir)}.\n` +
          `Số file: ${result.filesCopied} (${result.bytesCopied} byte). ` +
          `Điểm chất lượng v13: ${result.validation.qualityScore}/100.`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const installTool: Tool = {
    definition: {
      name: 'skills_v13_install_local',
      description:
        'Cài một skill từ marketplace cục bộ (thư mục local) vào thư mục skills đã cấu hình. ' +
        'Skill được kiểm tra lại toàn bộ (loader + v13 + manifest skill.json, nếu có) trước khi copy — ' +
        'skill lỗi thì không cài. Cần duyệt vì thay đổi hệ thống.',
      parameters: {
        type: 'object',
        properties: {
          sourceDir: {
            type: 'string',
            description: 'Đường dẫn tuyệt đối tới thư mục skill trong marketplace local (vd /shared/skills/code-review).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Ghi đè skill cùng tên đã tồn tại (mặc định false).',
          },
          upgrade: {
            type: 'boolean',
            description: 'Chỉ cài khi phiên bản marketplace mới hơn bản đã cài (mặc định false).',
          },
        },
        required: ['sourceDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const sourceDir = getStringArg(args, 'sourceDir');
        if (sourceDir.trim() === '') return errorResult('Thư mục nguồn không được rỗng.');
        const overwrite = getBoolArg(args, 'overwrite', false);
        const upgrade = getBoolArg(args, 'upgrade', false);
        const skillsDir = getSkillsDirOrError(opts);
        const result = installLocalSkill(sourceDir, skillsDir, { overwrite, upgrade });
        const lines = [
          `Đã cài skill "${result.name}" v${result.version} vào ${JSON.stringify(result.installedDir)} (${result.filesCopied} file).`,
        ];
        if (result.replacedVersion) lines.push(`Đã thay bản cũ v${result.replacedVersion}.`);
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const uninstallTool: Tool = {
    definition: {
      name: 'skills_v13_uninstall',
      description:
        'Gỡ một skill đã cài khỏi thư mục skills đã cấu hình. Chỉ xóa thư mục chứa SKILL.md của đúng skill đó — ' +
        'không bao giờ xóa thư mục khác. Cần duyệt vì xóa dữ liệu.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Tên skill cần gỡ.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        if (name.trim() === '') return errorResult('Tên skill không được rỗng.');
        const skillsDir = getSkillsDirOrError(opts);
        const removed = uninstallLocalSkill(skillsDir, name);
        return `Đã gỡ skill "${name}" (đã xóa ${JSON.stringify(removed)}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [listTool, searchTool, validateTool, auditTool, importTool, exportTool, installTool, uninstallTool];
}

/**
 * Placeholder chưa bound (không có getSkillsDir — các tool ghi sẽ báo
 * lỗi rõ ràng cho tới khi host tạo lại bằng factory kèm getSkillsDir).
 * Điều phối viên nối factory vào defaultToolFactory, không dùng const này.
 */
export const SKILLS_V13_TOOLS: Tool[] = createSkillsV13Tools();

/** Tên của 8 tool v13 (để test/host kiểm tra mà không cần gọi factory). */
export const SKILLS_V13_TOOL_NAMES: readonly string[] = SKILL_V13_TOOL_NAMES;
