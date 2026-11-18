/**
 * Agent tools cho Agent Skills v15 (v1.36, Team T2).
 *
 * Mười hai tool nối các module `packages/core/src/skills/v15/` ra agent
 * loop — đa nền tảng trên nền strict v14:
 *
 *  - `skills_v15_platforms` (chỉ đọc): 5 nền tảng + root project/global
 *    + host nào đọc root nào.
 *  - `skills_v15_status` (chỉ đọc): trạng thái một skill trên cả 5
 *    nền tảng (copy / symlink / stale-copy / broken-link / missing).
 *  - `skills_v15_export_multi` (cần duyệt): xuất một skill ra canonical
 *    `.agents/skills/` + mirror copy/symlink sang các host khác.
 *  - `skills_v15_import_multi` (cần duyệt): nhập một skill từ bất kỳ
 *    root nền tảng nào về canonical; trùng tên thì xin xác nhận ghi đè.
 *  - `skills_v15_remove_platform` (cần duyệt): gỡ một mirror (hoặc
 *    canonical) của một skill — chỉ gỡ đúng chỗ đã nêu.
 *  - `skills_v15_validate_platform` (chỉ đọc): validate một skill cho
 *    các nền tảng đích (v14 strict + verdict compatibility +
 *    allowed-tools thử nghiệm + tham chiếu script treo).
 *  - `skills_v15_compat` (chỉ đọc): phân tích trường `compatibility`
 *    của một skill và kiểm tra từng nền tảng.
 *  - `skills_v15_disclose` (chỉ đọc): progressive disclosure có ngân
 *    sách — list (tier 1, cắt theo budget), activate (tier 2, LRU),
 *    resource (tier 3, giới hạn bytes), usage (báo cáo đã nạp).
 *  - `skills_v15_registry` (chỉ đọc): registry skill với trường
 *    `compatibility` — list / lọc theo nền tảng / portable / ma trận.
 *  - `skills_v15_sync` (chỉ đọc): kiểm tra drift giữa canonical và
 *    các mirror (không sửa gì).
 *  - `skills_v15_sync_repair` (cần duyệt): sửa drift (copy lại từ
 *    canonical, nối lại link gãy); thư mục cùng tên do người dùng tự
 *    cài thì KHÔNG sửa.
 *  - `skills_v15_migrate` (cần duyệt): chuyển skill cũ (v13 /
 *    pre-standard) sang layout v15; dryRun để xem trước.
 *  - `skills_v15_audit` (chỉ đọc): kiểm toán toàn bộ skill của
 *    project — validation + trạng thái cài + readiness xuất khẩu
 *    từng nền tảng, rollup lỗi thường gặp.
 *  - `skills_v15_pack_create` (cần duyệt): đóng gói nhiều skill
 *    thành một pack phân phối (manifest có checksum).
 *  - `skills_v15_pack_verify` (chỉ đọc): kiểm tra pack (checksum +
 *    validation từng skill), không cài gì.
 *  - `skills_v15_pack_install` (cần duyệt): cài mọi skill của một
 *    pack đã verify vào canonical (+ mirror tùy chọn).
 *  - `skills_v15_export_plan` (chỉ đọc): dry-run — cho biết xuất một
 *    skill sẽ tạo/thay/bỏ qua/chặn bước nào, trước khi ghi gì.
 *
 * An toàn:
 * - Không tool nào tự chọn thư mục: `projectRoot` do người gọi truyền
 *   rõ (mặc định thư mục làm việc hiện tại).
 * - Mọi đường dẫn export/import đều qua validation strict v14 — skill
 *   lỗi không bao giờ được ghi; mirror lỗi không bao giờ được tạo.
 * - Tool không bao giờ in nội dung secret: validation chỉ báo mã lỗi
 *   và thông báo, không in lại đoạn text bị nghi là secret.
 *
 * Factory:
 *   createSkillsV15Tools(opts?) -> Tool[]   (bound, usable)
 *   SKILLS_V15_TOOLS                        (unbound placeholder)
 *
 * Approval: 10 tool chỉ đọc -> false; 7 tool thay đổi hệ thống -> true.
 * KHÔNG tự đăng ký vào ALL_TOOLS — điều phối viên nối factory vào
 * defaultToolFactory (cần opts.getSkillsDir).
 */

import type { Tool } from '@open-bot/core';
import { auditProjectSkillsV15, formatAuditReportV15, saveAuditReportV15 } from '@open-bot/core/dist/skills/v15/audit.js';
import { DisclosureSessionV15 } from '@open-bot/core/dist/skills/v15/disclosure.js';
import { formatExportPlanV15, planMultiPlatformExportV15 } from '@open-bot/core/dist/skills/v15/exportPlan.js';
import {
  exportSkillMultiPlatformV15,
  formatMultiStatusV15,
  importSkillFromPlatformV15,
  isOverwriteNeededV15,
  listPlatformInstallsV15,
  multiPlatformStatusV15,
  removeSkillFromPlatformV15,
} from '@open-bot/core/dist/skills/v15/multiPlatform.js';
import { formatMigrationReportV15, migrateSkillV15 } from '@open-bot/core/dist/skills/v15/migration.js';
import {
  createSkillPackV15,
  formatPackInstallResultV15,
  installSkillPackV15,
  listPackSkillsV15,
  verifySkillPackV15,
} from '@open-bot/core/dist/skills/v15/pack.js';
import {
  describePlatformV15,
  formatPlatformsV15,
  parsePlatformIdV15,
} from '@open-bot/core/dist/skills/v15/platforms.js';
import {
  buildCompatibilityMatrixV15,
  formatCompatibilityMatrixV15,
  formatRegistryEntriesV15,
  SkillV15Registry,
} from '@open-bot/core/dist/skills/v15/registry.js';
import { formatSyncReportV15, repairMirrorSyncV15 } from '@open-bot/core/dist/skills/v15/sync.js';
import type { SkillV15PlatformId } from '@open-bot/core/dist/skills/v15/types.js';
import {
  formatPlatformValidationSummaryV15,
  validateSkillForPlatformsV15,
  validateSkillTextForPlatformsV15,
} from '@open-bot/core/dist/skills/v15/validator.js';

/** Tuỳ chọn của factory — host cho biết project root. */
export interface SkillsV15ToolOptions {
  /** Trả về project root để quét các skill root. Trả `null` khi chưa cấu hình — các tool dùng thư mục làm việc hiện tại. */
  getProjectRoot?: () => string | null;
  /**
   * Trả về home dir cho các root global. Trả `null` khi chưa cấu hình —
   * các tool dùng `os.homedir()`. Chủ yếu để host/test cô lập global roots.
   */
  getHomeDir?: () => string | null;
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

function getNumberArg(args: Record<string, unknown>, name: string, defaultValue: number): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Tham số "${name}" phải là số không âm, nhận được ${JSON.stringify(value)}`);
  }
  return value;
}

function projectRootFor(opts: SkillsV15ToolOptions, args: Record<string, unknown>): string {
  const fromArgs = getStringArg(args, 'projectRoot', false);
  if (fromArgs.trim() !== '') return fromArgs;
  return opts.getProjectRoot?.() ?? process.cwd();
}

/** Home dir cho các root global (`undefined` = để core dùng `os.homedir()`). */
function homeDirFor(opts: SkillsV15ToolOptions): string | undefined {
  return opts.getHomeDir?.() ?? undefined;
}

function parsePlatformArg(value: string, required = true): SkillV15PlatformId | null {
  if (value.trim() === '') {
    if (required) throw new Error('Thiếu tham số bắt buộc: "platform" (openbot, claude, github, codex, opencode).');
    return null;
  }
  const parsed = parsePlatformIdV15(value);
  if (parsed === null) {
    throw new Error(
      `Nền tảng ${JSON.stringify(value)} không hợp lệ — dùng một trong: openbot, claude, github, codex, opencode.`,
    );
  }
  return parsed;
}

function parsePlatformListArg(value: string): SkillV15PlatformId[] | undefined {
  if (value.trim() === '') return undefined;
  const out: SkillV15PlatformId[] = [];
  for (const part of value.split(',')) {
    const parsed = parsePlatformArg(part.trim());
    if (parsed !== null && !out.includes(parsed)) out.push(parsed);
  }
  return out;
}

const SKILL_V15_TOOL_NAMES = [
  'skills_v15_platforms',
  'skills_v15_status',
  'skills_v15_export_multi',
  'skills_v15_import_multi',
  'skills_v15_remove_platform',
  'skills_v15_validate_platform',
  'skills_v15_compat',
  'skills_v15_disclose',
  'skills_v15_registry',
  'skills_v15_sync',
  'skills_v15_sync_repair',
  'skills_v15_migrate',
  'skills_v15_audit',
  'skills_v15_pack_create',
  'skills_v15_pack_verify',
  'skills_v15_pack_install',
  'skills_v15_export_plan',
] as const;

export function createSkillsV15Tools(opts: SkillsV15ToolOptions = {}): Tool[] {
  const platformsTool: Tool = {
    definition: {
      name: 'skills_v15_platforms',
      description:
        'Liệt kê 5 nền tảng Agent Skills v15 (openbot canonical .agents/skills/, claude, github, codex, opencode), ' +
        'root project/global của từng nền tảng và host nào đọc root nào. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          projectRoot: { type: 'string', description: 'Project root. Bỏ trống = thư mục làm việc hiện tại.' },
          global: { type: 'boolean', description: 'true = liệt kê root global (home dir) thay vì project-local. Mặc định false.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        return formatPlatformsV15({ projectRoot: projectRootFor(opts, args), global: getBoolArg(args, 'global', false) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const statusTool: Tool = {
    definition: {
      name: 'skills_v15_status',
      description:
        'Trạng thái một skill trên cả 5 nền tảng v15: copy, symlink, stale-copy (bản copy đã lệch so với canonical), ' +
        'broken-link, missing hay invalid. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên skill cần kiểm tra.' },
          projectRoot: { type: 'string', description: 'Project root. Bỏ trống = thư mục làm việc hiện tại.' },
          global: { type: 'boolean', description: 'true = kiểm tra root global. Mặc định false.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        if (name.trim() === '') return errorResult('Tên skill không được rỗng.');
        const status = multiPlatformStatusV15(name, {
          projectRoot: projectRootFor(opts, args),
          global: getBoolArg(args, 'global', false),
        });
        return formatMultiStatusV15(status);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportTool: Tool = {
    definition: {
      name: 'skills_v15_export_multi',
      description:
        'Xuất một skill ra canonical .agents/skills/ và mirror sang các nền tảng khác (claude, github, codex, opencode) ' +
        'dạng copy hoặc symlink. Skill lỗi validation strict v14 thì không xuất. Mirror đã tồn tại thì bị bỏ qua trừ khi overwrite=true. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          skillDir: { type: 'string', description: 'Thư mục skill cần xuất (chứa SKILL.md).' },
          projectRoot: { type: 'string', description: 'Project root chứa các skill root. Bỏ trống = thư mục làm việc hiện tại.' },
          platforms: {
            type: 'string',
            description: 'Nền tảng mirror, cách nhau bằng dấu phẩy, vd "claude,opencode". Bỏ trống = cả 4 nền tảng ngoài canonical.',
          },
          mode: { type: 'string', description: '"copy" (mặc định) hoặc "symlink" (mirror trỏ về canonical).' },
          overwrite: { type: 'boolean', description: 'true = ghi đè mirror/canonical đã tồn tại. Mặc định false.' },
          global: { type: 'boolean', description: 'true = xuất vào root global. Mặc định false.' },
        },
        required: ['skillDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const skillDir = getStringArg(args, 'skillDir');
        const modeRaw = getStringArg(args, 'mode', false).trim().toLowerCase();
        if (modeRaw !== '' && modeRaw !== 'copy' && modeRaw !== 'symlink') {
          return errorResult('Tham số "mode" phải là "copy" hoặc "symlink".');
        }
        const result = exportSkillMultiPlatformV15(skillDir, {
          projectRoot: projectRootFor(opts, args),
          platforms: parsePlatformListArg(getStringArg(args, 'platforms', false)),
          mode: modeRaw === 'symlink' ? 'symlink' : 'copy',
          overwrite: getBoolArg(args, 'overwrite', false),
          global: getBoolArg(args, 'global', false),
        });
        const lines = [
          `Đã xuất skill "${result.name}" ra canonical ${JSON.stringify(result.canonicalDir)} (validation ${result.validationQuality}/100).`,
        ];
        for (const mirror of result.mirrors) {
          lines.push(
            `- ${mirror.platform} [${mirror.mode}]${mirror.replaced ? ' (đã thay mirror cũ)' : ''}: ${JSON.stringify(mirror.dir)}` +
              (mirror.mode === 'copy' ? ` (${mirror.fileCount} file)` : ' (symlink về canonical)'),
          );
        }
        if (result.skipped.length > 0) {
          lines.push(`Bỏ qua (mirror đã tồn tại, chưa ghi đè): ${result.skipped.join(', ')} — gọi lại với overwrite=true để thay.`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const importTool: Tool = {
    definition: {
      name: 'skills_v15_import_multi',
      description:
        'Nhập một skill từ bất kỳ root nền tảng nào (vd .claude/skills/<tên>/) về canonical .agents/skills/. ' +
        'Validate strict + checksum trước khi ghi; trùng tên thì trả về yêu cầu xác nhận ghi đè. Có thể mirror tiếp sang các nền tảng khác. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          sourceDir: { type: 'string', description: 'Thư mục skill nguồn, vd "<project>/.claude/skills/review-pr".' },
          projectRoot: { type: 'string', description: 'Project root chứa canonical .agents/skills/. Bỏ trống = thư mục làm việc hiện tại.' },
          overwrite: { type: 'boolean', description: 'true = ghi đè skill canonical cùng tên (chỉ đặt sau khi người dùng xác nhận). Mặc định false.' },
          mirrorAfterImport: { type: 'boolean', description: 'true = mirror tiếp skill vừa nhập sang các nền tảng khác. Mặc định false.' },
          mirrorMode: { type: 'string', description: '"copy" (mặc định) hoặc "symlink" cho bước mirror sau nhập.' },
          global: { type: 'boolean', description: 'true = nhập vào root global. Mặc định false.' },
        },
        required: ['sourceDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const sourceDir = getStringArg(args, 'sourceDir');
        const mirrorModeRaw = getStringArg(args, 'mirrorMode', false).trim().toLowerCase();
        if (mirrorModeRaw !== '' && mirrorModeRaw !== 'copy' && mirrorModeRaw !== 'symlink') {
          return errorResult('Tham số "mirrorMode" phải là "copy" hoặc "symlink".');
        }
        const result = importSkillFromPlatformV15(sourceDir, {
          projectRoot: projectRootFor(opts, args),
          overwrite: getBoolArg(args, 'overwrite', false),
          mirrorAfterImport: getBoolArg(args, 'mirrorAfterImport', false),
          mirrorMode: mirrorModeRaw === 'symlink' ? 'symlink' : 'copy',
          global: getBoolArg(args, 'global', false),
        });
        if (isOverwriteNeededV15(result)) {
          return (
            `Skill "${result.name}" đã tồn tại tại ${JSON.stringify(result.existingDir)} (nguồn từ ${result.sourcePlatform}). ` +
            `Chưa ghi gì cả — gọi lại skills_v15_import_multi với overwrite=true để xác nhận ghi đè.`
          );
        }
        const lines = [
          `Đã nhập skill "${result.name}" từ ${result.fromPlatform} (${JSON.stringify(result.fromDir)}) về ${JSON.stringify(result.canonicalDir)}` +
            `${result.overwritten ? ' (đã ghi đè bản cũ)' : ''} — validation ${result.validationQuality}/100.`,
        ];
        for (const mirror of result.mirrors) {
          lines.push(`- mirror ${mirror.platform} [${mirror.mode}]: ${JSON.stringify(mirror.dir)}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const removeTool: Tool = {
    definition: {
      name: 'skills_v15_remove_platform',
      description:
        'Gỡ một skill khỏi một nền tảng v15 (gỡ mirror, hoặc gỡ canonical khi platform=openbot). ' +
        'Symlink chỉ bị unlink, không bao giờ xóa xuyên qua link. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên skill cần gỡ.' },
          platform: { type: 'string', description: 'Nền tảng: openbot, claude, github, codex, opencode.' },
          projectRoot: { type: 'string', description: 'Project root. Bỏ trống = thư mục làm việc hiện tại.' },
          global: { type: 'boolean', description: 'true = gỡ khỏi root global. Mặc định false.' },
        },
        required: ['name', 'platform'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const platform = parsePlatformArg(getStringArg(args, 'platform'));
        if (name.trim() === '') return errorResult('Tên skill không được rỗng.');
        if (platform === null) return errorResult('Nền tảng không hợp lệ.');
        const removed = removeSkillFromPlatformV15(name, platform, {
          projectRoot: projectRootFor(opts, args),
          global: getBoolArg(args, 'global', false),
        });
        return removed
          ? `Đã gỡ skill "${name}" khỏi ${describePlatformV15(platform)}.`
          : `Skill "${name}" không có trên ${describePlatformV15(platform)} — không gỡ gì cả.`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validateTool: Tool = {
    definition: {
      name: 'skills_v15_validate_platform',
      description:
        'Kiểm tra một skill cho các nền tảng đích (v15): validation strict v14 + verdict compatibility từng nền tảng ' +
        '(không hỗ trợ = lỗi), cảnh báo allowed-tools là thử nghiệm, kiểm tra tham chiếu scripts/references có tồn tại. Chỉ đọc — truyền dir hoặc text.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Thư mục skill cần kiểm tra (chứa SKILL.md). Dùng dir hoặc text, không cần cả hai.' },
          text: { type: 'string', description: 'Nội dung SKILL.md cần kiểm tra (khi không có dir).' },
          name: { type: 'string', description: 'Tên thư mục skill khi kiểm tra bằng text.' },
          platforms: {
            type: 'string',
            description: 'Nền tảng đích, cách nhau bằng dấu phẩy, vd "claude,codex". Bỏ trống = cả 5 nền tảng.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const dir = getStringArg(args, 'dir', false);
        const text = getStringArg(args, 'text', false);
        const name = getStringArg(args, 'name', false);
        const platforms = parsePlatformListArg(getStringArg(args, 'platforms', false));
        if (dir.trim() !== '') {
          return formatPlatformValidationSummaryV15(
            validateSkillForPlatformsV15(dir, platforms),
          );
        }
        if (text.trim() !== '') {
          return formatPlatformValidationSummaryV15(
            validateSkillTextForPlatformsV15(text, name, platforms),
          );
        }
        return errorResult('Cần truyền "dir" (thư mục skill) hoặc "text" (nội dung SKILL.md).');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const compatTool: Tool = {
    definition: {
      name: 'skills_v15_compat',
      description:
        'Phân tích trường compatibility của một skill: nền tảng nào được hỗ trợ, nền tảng nào bị từ chối, ' +
        'yêu cầu tự do nào còn lại — và verdict cho từng nền tảng đích. Chỉ đọc — truyền dir hoặc text.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Thư mục skill cần kiểm tra. Dùng dir hoặc text, không cần cả hai.' },
          text: { type: 'string', description: 'Nội dung SKILL.md cần kiểm tra (khi không có dir).' },
          name: { type: 'string', description: 'Tên thư mục skill khi kiểm tra bằng text.' },
          platforms: {
            type: 'string',
            description: 'Nền tảng cần verdict, cách nhau bằng dấu phẩy. Bỏ trống = cả 5 nền tảng.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const dir = getStringArg(args, 'dir', false);
        const text = getStringArg(args, 'text', false);
        const name = getStringArg(args, 'name', false);
        const platforms = parsePlatformListArg(getStringArg(args, 'platforms', false));
        let result;
        if (dir.trim() !== '') {
          result = validateSkillForPlatformsV15(dir, platforms);
        } else if (text.trim() !== '') {
          result = validateSkillTextForPlatformsV15(text, name, platforms);
        } else {
          return errorResult('Cần truyền "dir" (thư mục skill) hoặc "text" (nội dung SKILL.md).');
        }
        const compat = result.compatibility;
        const lines: string[] = [
          `Skill "${result.dirName}" — compatibility ${compat.unknown ? 'không khai báo' : `hỗ trợ: ${compat.supported.join(', ') || '—'}; từ chối: ${compat.unsupported.join(', ') || '—'}`}.`,
        ];
        if (compat.requirements.length > 0) {
          lines.push(`Yêu cầu tự do: ${compat.requirements.join('; ')}.`);
        }
        for (const check of result.checks) {
          lines.push(`- ${check.platform}: ${check.verdict} — ${check.reason}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const discloseTool: Tool = {
    definition: {
      name: 'skills_v15_disclose',
      description:
        'Progressive disclosure có ngân sách (v15): action=list trả header tier 1 đã cắt theo budget; ' +
        'action=activate đọc body tier 2 của một skill (LRU khi vượt budget); action=resource đọc một file tier 3; ' +
        'action=usage trả báo cáo đã nạp/trục xuất/từ chối. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list", "activate", "resource" hoặc "usage".' },
          name: { type: 'string', description: 'Tên skill (cho activate/resource).' },
          relPath: { type: 'string', description: 'Đường dẫn tài nguyên tier 3, vd "references/cheat-sheet.md" (cho resource).' },
          projectRoot: { type: 'string', description: 'Project root để quét skill. Bỏ trống = thư mục làm việc hiện tại.' },
          maxHeaders: { type: 'number', description: 'Tối đa header tier 1 giữ trong context. Mặc định 64.' },
          maxHeaderTokens: { type: 'number', description: 'Tối đa token header tier 1. Mặc định 6400.' },
          maxBodyTokens: { type: 'number', description: 'Tối đa token body tier 2 giữ cùng lúc. Mặc định 24000.' },
          maxResourceBytes: { type: 'number', description: 'Tối đa bytes một tài nguyên tier 3. Mặc định 1000000.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!['list', 'activate', 'resource', 'usage'].includes(action)) {
          return errorResult('Tham số "action" phải là "list", "activate", "resource" hoặc "usage".');
        }
        const session = new DisclosureSessionV15({
          projectRoot: projectRootFor(opts, args),
          homeDir: homeDirFor(opts),
          budget: {
            maxHeaders: getNumberArg(args, 'maxHeaders', 64),
            maxHeaderTokens: getNumberArg(args, 'maxHeaderTokens', 6400),
            maxBodyTokens: getNumberArg(args, 'maxBodyTokens', 24000),
            maxResourceBytes: getNumberArg(args, 'maxResourceBytes', 1000000),
          },
        });
        session.open();
        if (action === 'list') {
          const dropped = session.droppedHeadersList();
          const lines = [session.headersForContext()];
          if (dropped.length > 0) {
            lines.push(`Đã cắt khỏi context do vượt budget: ${dropped.map((h) => h.name).join(', ')}.`);
          }
          const errors = session.loadErrors();
          if (errors.length > 0) lines.push(`Lỗi load (skill hỏng bị bỏ qua):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
          return lines.join('\n');
        }
        if (action === 'usage') {
          const usage = session.usageSnapshot();
          return (
            `Disclosure usage: ${usage.headersLoaded} header(s) ~${usage.headerTokens} tokens; ` +
            `${usage.bodiesLoaded} bod(ies) ~${usage.bodyTokens} tokens; ` +
            `${usage.resourcesLoaded} resource(s) ${usage.resourceBytes} bytes.` +
            (usage.evicted.length > 0 ? `\nEvicted: ${usage.evicted.join(', ')}.` : '') +
            (usage.rejected.length > 0 ? `\nRefused: ${usage.rejected.join(' ')}` : '')
          );
        }
        const name = getStringArg(args, 'name');
        if (name.trim() === '') return errorResult('Tham số "name" không được rỗng cho action này.');
        if (action === 'activate') {
          const activation = session.activate(name);
          if (activation === null) {
            return errorResult(
              `Không kích hoạt được "${name}": body vượt toàn bộ budget tier 2 — xem usage để biết giới hạn.`,
            );
          }
          const lines = [
            `Skill "${activation.name}" (tier 2, ~${activation.bodyTokens} token body):`,
            activation.body,
          ];
          if (activation.evictedNames.length > 0) {
            lines.push('', `Đã trục xuất (LRU) để vừa budget: ${activation.evictedNames.join(', ')}.`);
          }
          const resources = session.listResources(name);
          if (resources.length > 0) {
            lines.push('', `Tài nguyên tier 3 (chỉ load khi cần, qua skills_v15_disclose resource): ${resources.join(', ')}`);
          }
          return lines.join('\n');
        }
        const relPath = getStringArg(args, 'relPath');
        if (relPath.trim() === '') return errorResult('Tham số "relPath" không được rỗng cho action "resource".');
        const resource = session.loadResource(name, relPath);
        if (resource === null) {
          return errorResult(`Tài nguyên "${relPath}" của "${name}" vượt budget tier 3 — không đọc.`);
        }
        return `Tài nguyên ${resource.relPath} của skill "${resource.name}" (${resource.bytes} bytes):\n${resource.content}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const registryTool: Tool = {
    definition: {
      name: 'skills_v15_registry',
      description:
        'Registry skill v15 với trường compatibility có cấu trúc: action=list liệt kê skill đã index; ' +
        'action=supported lọc theo nền tảng; action=portable chỉ skill chạy cả 5 nền tảng; ' +
        'action=unknown chỉ skill chưa khai báo compatibility; action=matrix trả bảng skill × nền tảng. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list", "supported", "portable", "unknown" hoặc "matrix". Mặc định "list".' },
          platform: { type: 'string', description: 'Nền tảng để lọc (cho action=supported): openbot, claude, github, codex, opencode.' },
          query: { type: 'string', description: 'Từ khóa lọc theo tên/mô tả.' },
          projectRoot: { type: 'string', description: 'Project root để quét skill. Bỏ trống = thư mục làm việc hiện tại.' },
          save: { type: 'boolean', description: 'true = lưu index registry ra file JSON sau khi refresh. Mặc định false.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action', false).trim() || 'list';
        if (!['list', 'supported', 'portable', 'unknown', 'matrix'].includes(action)) {
          return errorResult('Tham số "action" phải là "list", "supported", "portable", "unknown" hoặc "matrix".');
        }
        const registry = new SkillV15Registry({ projectRoot: projectRootFor(opts, args), homeDir: homeDirFor(opts) });
        registry.refresh();
        if (getBoolArg(args, 'save', false)) {
          registry.save();
        }
        const query = getStringArg(args, 'query', false);
        if (action === 'matrix') {
          const rows = buildCompatibilityMatrixV15(registry.list());
          return formatCompatibilityMatrixV15(rows);
        }
        if (action === 'supported') {
          const platform = parsePlatformArg(getStringArg(args, 'platform'));
          if (platform === null) return errorResult('Nền tảng không hợp lệ.');
          return formatRegistryEntriesV15(registry.supportedOn(platform));
        }
        if (action === 'portable') return formatRegistryEntriesV15(registry.portable());
        if (action === 'unknown') return formatRegistryEntriesV15(registry.unknownCompatibility());
        return formatRegistryEntriesV15(registry.filter({ query: query === '' ? undefined : query }));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const syncTool: Tool = {
    definition: {
      name: 'skills_v15_sync',
      description:
        'Kiểm tra drift giữa canonical .agents/skills/ và các mirror (copy lệch, mirror thiếu, link gãy, thư mục cùng tên tự cài). ' +
        'Chỉ đọc — không sửa gì; muốn sửa dùng skills_v15_sync_repair.',
      parameters: {
        type: 'object',
        properties: {
          projectRoot: { type: 'string', description: 'Project root. Bỏ trống = thư mục làm việc hiện tại.' },
          global: { type: 'boolean', description: 'true = kiểm tra root global. Mặc định false.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const report = repairMirrorSyncV15({
          projectRoot: projectRootFor(opts, args),
          global: getBoolArg(args, 'global', false),
          repair: false,
        });
        return formatSyncReportV15(report);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const syncRepairTool: Tool = {
    definition: {
      name: 'skills_v15_sync_repair',
      description:
        'Sửa drift mirror v15: copy lại từ canonical các mirror lệch/thiếu, nối lại link gãy. ' +
        'Canonical là nguồn sự thật — không bao giờ copy ngược từ mirror. Thư mục cùng tên do người dùng tự cài thì KHÔNG sửa. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          projectRoot: { type: 'string', description: 'Project root. Bỏ trống = thư mục làm việc hiện tại.' },
          mode: { type: 'string', description: '"copy" (mặc định) hoặc "symlink" cho mirror được tạo lại.' },
          global: { type: 'boolean', description: 'true = sửa mirror ở root global. Mặc định false.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const modeRaw = getStringArg(args, 'mode', false).trim().toLowerCase();
        if (modeRaw !== '' && modeRaw !== 'copy' && modeRaw !== 'symlink') {
          return errorResult('Tham số "mode" phải là "copy" hoặc "symlink".');
        }
        const report = repairMirrorSyncV15({
          projectRoot: projectRootFor(opts, args),
          global: getBoolArg(args, 'global', false),
          mode: modeRaw === 'symlink' ? 'symlink' : 'copy',
          repair: true,
        });
        return formatSyncReportV15(report);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const migrateTool: Tool = {
    definition: {
      name: 'skills_v15_migrate',
      description:
        'Chuyển một skill cũ (v13 / pre-standard) sang layout v15: chuẩn hóa tên thư mục, tools: → allowed-tools, ' +
        'thêm compatibility khi thiếu, chuyển whenToUse vào body, ghi lại mọi field đã bỏ (không bỏ lặng lẽ). ' +
        'dryRun=true chỉ báo cáo, không ghi. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Thư mục skill cần chuyển (chứa SKILL.md).' },
          dryRun: { type: 'boolean', description: 'true = chỉ báo cáo thay đổi, không ghi gì. Mặc định false.' },
          defaultCompatibility: { type: 'string', description: 'Compatibility thêm khi skill chưa khai báo, vd "claude; opencode". Mặc định "openbot".' },
          overwrite: { type: 'boolean', description: 'true = ghi đè thư mục đích khi đổi tên đụng tên đã có. Mặc định false.' },
        },
        required: ['dir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const dir = getStringArg(args, 'dir');
        const defaultCompatibility = getStringArg(args, 'defaultCompatibility', false);
        const result = migrateSkillV15(dir, {
          dryRun: getBoolArg(args, 'dryRun', false),
          defaultCompatibility: defaultCompatibility.trim() !== '' ? defaultCompatibility : undefined,
          overwrite: getBoolArg(args, 'overwrite', false),
        });
        return formatMigrationReportV15(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const auditTool: Tool = {
    definition: {
      name: 'skills_v15_audit',
      description:
        'Kiểm toán toàn bộ skill của project (v15): validation từng skill, trạng thái cài trên 5 nền tảng, ' +
        'readiness xuất khẩu từng nền tảng (ready/blocked/unverified), rollup lỗi thường gặp. Chỉ đọc — có thể lưu báo cáo JSON.',
      parameters: {
        type: 'object',
        properties: {
          projectRoot: { type: 'string', description: 'Project root cần kiểm toán. Bỏ trống = thư mục làm việc hiện tại.' },
          save: { type: 'boolean', description: 'true = lưu báo cáo JSON vào <projectRoot>/.agents/skills-v15-audit.json. Mặc định false.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const report = auditProjectSkillsV15({ projectRoot: projectRootFor(opts, args), homeDir: homeDirFor(opts) });
        const lines = [formatAuditReportV15(report)];
        if (getBoolArg(args, 'save', false)) {
          lines.push(`Đã lưu báo cáo JSON: ${JSON.stringify(saveAuditReportV15(report))}.`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const packCreateTool: Tool = {
    definition: {
      name: 'skills_v15_pack_create',
      description:
        'Đóng gói nhiều skill thành một pack phân phối v15: mỗi skill được validate strict trước, ' +
        'manifest skills-pack.json ghi checksum SKILL.md từng skill. Skill lỗi thì dừng cả pack. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          skillDirs: { type: 'string', description: 'Thư mục skill cần đóng gói, cách nhau bằng dấu phẩy (mỗi thư mục chứa SKILL.md).' },
          name: { type: 'string', description: 'Tên pack (chữ thường/số/gạch ngang, vd "team-starter").' },
          description: { type: 'string', description: 'Mô tả pack (bắt buộc).' },
          version: { type: 'string', description: 'Phiên bản pack, vd "1.0.0". Mặc định "1.0.0".' },
          outDir: { type: 'string', description: 'Thư mục pack đích. Bỏ trống = <thư-mục-làm-việc>/<tên>.skills-pack.' },
        },
        required: ['skillDirs', 'name', 'description'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const skillDirsRaw = getStringArg(args, 'skillDirs');
        const name = getStringArg(args, 'name');
        const description = getStringArg(args, 'description');
        const version = getStringArg(args, 'version', false);
        const outDir = getStringArg(args, 'outDir', false);
        const skillDirs = skillDirsRaw.split(',').map((d) => d.trim()).filter((d) => d !== '');
        if (skillDirs.length === 0) return errorResult('Tham số "skillDirs" không được rỗng.');
        const result = createSkillPackV15(skillDirs, name, {
          description,
          version: version.trim() !== '' ? version : undefined,
          outDir: outDir.trim() !== '' ? outDir : undefined,
        });
        return (
          `Đã tạo pack "${result.manifest.name}" v${result.manifest.version} tại ${JSON.stringify(result.packDir)} ` +
          `(${result.manifest.skills.length} skill, ${result.fileCount} file): ` +
          result.manifest.skills.map((s) => s.name).join(', ') + '.'
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const packVerifyTool: Tool = {
    definition: {
      name: 'skills_v15_pack_verify',
      description:
        'Kiểm tra một pack skill v15: manifest đúng định dạng, đủ thư mục skill, checksum SKILL.md khớp, ' +
        'từng skill validate strict. Chỉ đọc — không cài gì.',
      parameters: {
        type: 'object',
        properties: {
          packDir: { type: 'string', description: 'Thư mục pack cần kiểm tra (chứa skills-pack.json).' },
        },
        required: ['packDir'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const packDir = getStringArg(args, 'packDir');
        const { manifest, problems } = verifySkillPackV15(packDir);
        if (problems.length === 0) {
          return (
            `Pack "${manifest.name}" v${manifest.version} sạch: ${manifest.skills.length} skill ` +
            `(${manifest.skills.map((s) => s.name).join(', ')}) — checksum + validation đều khớp.`
          );
        }
        return (
          `Pack "${manifest.name}" có ${problems.length} vấn đề:\n` +
          problems.map((p) => `- ${p}`).join('\n')
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const packInstallTool: Tool = {
    definition: {
      name: 'skills_v15_pack_install',
      description:
        'Cài mọi skill của một pack v15 đã verify vào canonical .agents/skills/ (mirror sang các nền tảng khác nếu cần). ' +
        'Pack bẩn thì không cài gì; skill đã tồn tại thì bỏ qua trừ khi overwrite=true. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          packDir: { type: 'string', description: 'Thư mục pack cần cài (chứa skills-pack.json).' },
          projectRoot: { type: 'string', description: 'Project root đích. Bỏ trống = thư mục làm việc hiện tại.' },
          overwrite: { type: 'boolean', description: 'true = ghi đè skill canonical cùng tên. Mặc định false.' },
          mirrorAfterInstall: { type: 'boolean', description: 'true = mirror tiếp từng skill sang các nền tảng khác. Mặc định false.' },
          mirrorMode: { type: 'string', description: '"copy" (mặc định) hoặc "symlink" cho bước mirror.' },
          global: { type: 'boolean', description: 'true = cài vào root global. Mặc định false.' },
        },
        required: ['packDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const packDir = getStringArg(args, 'packDir');
        const mirrorModeRaw = getStringArg(args, 'mirrorMode', false).trim().toLowerCase();
        if (mirrorModeRaw !== '' && mirrorModeRaw !== 'copy' && mirrorModeRaw !== 'symlink') {
          return errorResult('Tham số "mirrorMode" phải là "copy" hoặc "symlink".');
        }
        const result = installSkillPackV15(packDir, {
          projectRoot: projectRootFor(opts, args),
          overwrite: getBoolArg(args, 'overwrite', false),
          mirrorAfterInstall: getBoolArg(args, 'mirrorAfterInstall', false),
          mirrorMode: mirrorModeRaw === 'symlink' ? 'symlink' : 'copy',
          global: getBoolArg(args, 'global', false),
        });
        return formatPackInstallResultV15(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportPlanTool: Tool = {
    definition: {
      name: 'skills_v15_export_plan',
      description:
        'Dry-run xuất đa nền tảng (v15): cho biết xuất một skill sẽ tạo/thay/bỏ qua/chặn bước nào ' +
        'trên canonical + từng mirror (kèm cảnh báo drift, nền tảng bị từ chối), trước khi ghi gì. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          skillDir: { type: 'string', description: 'Thư mục skill cần lập kế hoạch xuất (chứa SKILL.md).' },
          projectRoot: { type: 'string', description: 'Project root chứa các skill root. Bỏ trống = thư mục làm việc hiện tại.' },
          platforms: {
            type: 'string',
            description: 'Nền tảng mirror, cách nhau bằng dấu phẩy, vd "claude,opencode". Bỏ trống = cả 4 nền tảng ngoài canonical.',
          },
          mode: { type: 'string', description: '"copy" (mặc định) hoặc "symlink".' },
          overwrite: { type: 'boolean', description: 'true = kế hoạch cho phép thay mirror đã tồn tại. Mặc định false.' },
          global: { type: 'boolean', description: 'true = lập kế hoạch cho root global. Mặc định false.' },
        },
        required: ['skillDir'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const skillDir = getStringArg(args, 'skillDir');
        const modeRaw = getStringArg(args, 'mode', false).trim().toLowerCase();
        if (modeRaw !== '' && modeRaw !== 'copy' && modeRaw !== 'symlink') {
          return errorResult('Tham số "mode" phải là "copy" hoặc "symlink".');
        }
        const plan = planMultiPlatformExportV15(skillDir, {
          projectRoot: projectRootFor(opts, args),
          platforms: parsePlatformListArg(getStringArg(args, 'platforms', false)),
          mode: modeRaw === 'symlink' ? 'symlink' : 'copy',
          overwrite: getBoolArg(args, 'overwrite', false),
          global: getBoolArg(args, 'global', false),
        });
        return formatExportPlanV15(plan);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    platformsTool,
    statusTool,
    exportTool,
    importTool,
    removeTool,
    validateTool,
    compatTool,
    discloseTool,
    registryTool,
    syncTool,
    syncRepairTool,
    migrateTool,
    auditTool,
    packCreateTool,
    packVerifyTool,
    packInstallTool,
    exportPlanTool,
  ];
}

/**
 * Placeholder chưa bound (không có getProjectRoot — các tool dùng thư
 * mục làm việc hiện tại). Điều phối viên nối factory vào
 * defaultToolFactory, không dùng const này.
 */
export const SKILLS_V15_TOOLS: Tool[] = createSkillsV15Tools();

/** Tên của 17 tool v15 (để test/host kiểm tra mà không cần gọi factory). */
export const SKILLS_V15_TOOL_NAMES: readonly string[] = SKILL_V15_TOOL_NAMES;

/** Danh sách skill cài trên một nền tảng (tiện ích cho host/UI). */
export function listSkillsOnPlatformV15(
  platform: SkillV15PlatformId,
  projectRoot: string,
): string[] {
  return listPlatformInstallsV15(platform, { projectRoot });
}
