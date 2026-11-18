/**
 * Agent tools cho Agent Skills v14 (v1.34, Team T1).
 *
 * Mười tool nối các module `packages/core/src/skills/v14/` ra agent loop —
 * đây cũng là cách loader v14 được nối vào runtime: agent gọi
 * `skills_v14_list` (tier 1 — chỉ header) lúc mở session, và
 * `skills_v14_activate` (tier 2 — thân SKILL.md) chỉ khi một skill khớp
 * nhiệm vụ; `skills_v14_resource` (tier 3) chỉ khi thân skill yêu cầu.
 *
 *  - `skills_v14_list` (chỉ đọc): header index — tên, mô tả, nguồn,
 *    trạng thái bật/tắt, token header. Không đọc body.
 *  - `skills_v14_activate` (chỉ đọc): đọc thân SKILL.md của một skill.
 *  - `skills_v14_resource` (chỉ đọc): đọc một file scripts/ /
 *    references/ / assets/ của một skill, khi cần.
 *  - `skills_v14_validate` (chỉ đọc): kiểm tra một skill theo chuẩn
 *    AAIF strict (6 field, giới hạn ký tự, name trùng thư mục, quét
 *    script) — trả lỗi/cảnh báo + điểm chất lượng.
 *  - `skills_v14_discover` (chỉ đọc): quét 4 gốc discovery, dedupe theo
 *    tên, ưu tiên project-local; liệt kê skill bị che (shadowed).
 *  - `skills_v14_search` (chỉ đọc): tìm skill đã cài theo từ khóa trong
 *    tên/mô tả (không tìm trong body — progressive disclosure).
 *  - `skills_v14_toggle` (cần duyệt): bật/tắt một skill (chỉ ghi file
 *    trạng thái tier, không sửa skill).
 *  - `skills_v14_import` (cần duyệt): nhập một bundle skill (kèm kiểm
 *    tra checksum + validate); khi skill đã tồn tại thì trả về yêu cầu
 *    xác nhận ghi đè thay vì ghi đè lặng lẽ.
 *  - `skills_v14_export` (cần duyệt): xuất một skill thành bundle có
 *    checksum.
 *  - `skills_v14_create` (cần duyệt): tạo skill mới hợp lệ ngay từ đầu
 *    (scaffold SKILL.md + stub scripts/references tùy chọn, validate
 *    strict trước khi ghi).
 *
 * An toàn:
 * - Không tool nào tự chọn thư mục: `projectRoot` do người gọi truyền
 *   rõ (mặc định thư mục làm việc hiện tại); `targetDir` của import do
 *   host cấu hình qua `opts.getSkillsDir` hoặc do người gọi truyền rõ.
 * - Mọi đường dẫn import/export đều qua v14 validation + kiểm tra
 *   checksum — skill lỗi hoặc bundle bị sửa không bao giờ được ghi.
 * - Tool không bao giờ in nội dung secret: validation chỉ báo mã lỗi
 *   và thông báo, không in lại đoạn text bị nghi là secret.
 *
 * Factory:
 *   createSkillsV14Tools(opts?) -> Tool[]   (bound, usable)
 *   SKILLS_V14_TOOLS                        (unbound placeholder)
 *
 * Approval: 6 tool chỉ đọc -> false; 4 tool thay đổi hệ thống -> true.
 * KHÔNG tự đăng ký vào ALL_TOOLS — điều phối viên nối factory vào
 * defaultToolFactory (cần opts.getSkillsDir).
 */

import type { Tool } from '@open-bot/core';
import { createSkillV14 } from '@open-bot/core/dist/skills/v14/authoring.js';
import {
  discoverSkillsV14,
  formatDiscoverySummaryV14,
} from '@open-bot/core/dist/skills/v14/discovery.js';
import {
  isOverwriteNeededV14,
  exportSkillV14,
  importSkillV14,
} from '@open-bot/core/dist/skills/v14/importExport.js';
import { SkillV14Loader } from '@open-bot/core/dist/skills/v14/loader.js';
import {
  disableSkillV14,
  enableSkillV14,
  defaultTierStateFileV14,
  isEnabledFromStateFileV14,
  searchInstalledSkillsV14,
} from '@open-bot/core/dist/skills/v14/marketplace.js';
import {
  formatValidationSummaryV14,
  validateSkillDirV14,
  validateSkillTextV14,
} from '@open-bot/core/dist/skills/v14/validator.js';

/** Tuỳ chọn của factory — host cho biết project root và thư mục cài skill. */
export interface SkillsV14ToolOptions {
  /**
   * Trả về project root để quét `.agents/skills/` + `.claude/skills/`.
   * Trả `null` khi chưa cấu hình — các tool dùng thư mục làm việc hiện tại.
   */
  getProjectRoot?: () => string | null;
  /**
   * Trả về thư mục chứa các skill đã cài (`<skillsDir>/<tên-skill>/`).
   * Trả `null` khi chưa cấu hình — import báo lỗi rõ ràng thay vì ghi
   * vào chỗ khiến skill vô hình.
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

function projectRootFor(opts: SkillsV14ToolOptions, args: Record<string, unknown>): string {
  const fromArgs = getStringArg(args, 'projectRoot', false);
  if (fromArgs.trim() !== '') return fromArgs;
  return opts.getProjectRoot?.() ?? process.cwd();
}

function skillsDirOrError(opts: SkillsV14ToolOptions, args: Record<string, unknown>): string {
  const fromArgs = getStringArg(args, 'targetDir', false);
  if (fromArgs.trim() !== '') return fromArgs;
  const dir = opts.getSkillsDir?.() ?? null;
  if (!dir || typeof dir !== 'string' || dir.trim() === '') {
    throw new Error(
      'Chưa cấu hình thư mục skills (skillsDir) nên không biết cài skill vào đâu — ' +
        'host cần truyền getSkillsDir cho createSkillsV14Tools, hoặc truyền targetDir rõ ràng. Không tự cài vào thư mục khác.',
    );
  }
  return dir;
}

function openLoader(opts: SkillsV14ToolOptions, args: Record<string, unknown>): SkillV14Loader {
  // The loader defaults to "everything enabled" unless given a predicate,
  // so read the tier state file the toggle tool writes — otherwise a
  // toggled-off skill still lists as enabled and [TẮT] never appears.
  const projectRoot = projectRootFor(opts, args);
  const loader = new SkillV14Loader({
    projectRoot,
    projectOnly: getBoolArg(args, 'projectOnly', false),
    isEnabled: isEnabledFromStateFileV14(defaultTierStateFileV14(projectRoot)),
  });
  loader.open();
  return loader;
}

const SKILL_V14_TOOL_NAMES = [
  'skills_v14_list',
  'skills_v14_activate',
  'skills_v14_resource',
  'skills_v14_validate',
  'skills_v14_discover',
  'skills_v14_search',
  'skills_v14_toggle',
  'skills_v14_import',
  'skills_v14_export',
  'skills_v14_create',
] as const;

export function createSkillsV14Tools(opts: SkillsV14ToolOptions = {}): Tool[] {
  const listTool: Tool = {
    definition: {
      name: 'skills_v14_list',
      description:
        'Liệt kê các skill v14 đã cài (tier 1 — chỉ đọc frontmatter, không đọc body): ' +
        'tên, mô tả, nguồn (project .agents/.claude hay global), trạng thái bật/tắt và token header. ' +
        'Chỉ đọc — đây là index nạp vào context lúc mở session.',
      parameters: {
        type: 'object',
        properties: {
          projectRoot: {
            type: 'string',
            description: 'Project root để quét .agents/skills/ + .claude/skills/. Bỏ trống = thư mục làm việc hiện tại.',
          },
          projectOnly: {
            type: 'boolean',
            description: 'true = chỉ quét project-local, bỏ qua global ~/.claude/skills/ và ~/.agents/skills/. Mặc định false.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const loader = openLoader(opts, args);
        const lines: string[] = [
          `Skills v14: ${loader.size} skill, ${loader.errors.length} lỗi, tổng token header ~${loader.totalHeaderTokens()}.`,
        ];
        for (const entry of loader.headers) {
          const flags = entry.enabled ? '' : ' [TẮT]';
          const tools = entry.allowedTools !== undefined && entry.allowedTools.length > 0 ? ` [tools: ${entry.allowedTools.join(', ')}]` : '';
          lines.push(`- ${entry.name} (${entry.source})${flags}: ${entry.description} [~${entry.headerTokens} token${tools}]`);
        }
        if (loader.errors.length > 0) {
          lines.push('Lỗi (skill hỏng bị bỏ qua, các skill khác vẫn liệt kê):');
          for (const e of loader.errors) lines.push(`  - ${e.dir}: ${e.error}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const activateTool: Tool = {
    definition: {
      name: 'skills_v14_activate',
      description:
        'Kích hoạt một skill v14: đọc toàn bộ thân SKILL.md (tier 2 — progressive disclosure). ' +
        'Chỉ gọi khi mô tả của skill khớp nhiệm vụ đang làm. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên skill cần kích hoạt (phải trùng tên thư mục).' },
          projectRoot: {
            type: 'string',
            description: 'Project root để quét skill. Bỏ trống = thư mục làm việc hiện tại.',
          },
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
        const loader = openLoader(opts, args);
        const activation = loader.activate(name);
        const resources = loader.listResources(name);
        const lines: string[] = [
          `Skill "${activation.name}" (tier 2, ~${activation.bodyTokens} token body):`,
          activation.body,
        ];
        if (resources.length > 0) {
          lines.push('', `Tài nguyên tier 3 (chỉ load khi cần, qua skills_v14_resource): ${resources.join(', ')}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const resourceTool: Tool = {
    definition: {
      name: 'skills_v14_resource',
      description:
        'Đọc một file tài nguyên tier 3 của một skill v14 (scripts/, references/ hoặc assets/), ' +
        'chỉ khi thân skill yêu cầu. Đường dẫn phải nằm trong thư mục skill — ".." và đường dẫn tuyệt đối bị từ chối. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên skill sở hữu tài nguyên.' },
          relPath: {
            type: 'string',
            description: 'Đường dẫn tương đối trong skill, vd "references/cheat-sheet.md" hoặc "scripts/run.sh".',
          },
          projectRoot: {
            type: 'string',
            description: 'Project root để quét skill. Bỏ trống = thư mục làm việc hiện tại.',
          },
        },
        required: ['name', 'relPath'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const relPath = getStringArg(args, 'relPath');
        if (name.trim() === '' || relPath.trim() === '') return errorResult('Tên skill và đường dẫn không được rỗng.');
        const loader = openLoader(opts, args);
        const resource = loader.loadResource(name, relPath);
        return `Tài nguyên ${resource.relPath} của skill "${resource.name}" (${resource.bytes} bytes):\n${resource.content}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validateTool: Tool = {
    definition: {
      name: 'skills_v14_validate',
      description:
        'Kiểm tra một skill theo chuẩn AAIF strict (v14): đúng 6 field frontmatter, name <= 64 ký tự ' +
        'chữ thường/số/gạch ngang và trùng tên thư mục, description <= 1.024 ký tự nói rõ làm gì VÀ khi nào dùng, ' +
        'quét bảo mật script. Trả lỗi/cảnh báo + điểm chất lượng. Chỉ đọc — truyền dir hoặc text.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Thư mục skill cần kiểm tra (chứa SKILL.md). Dùng dir hoặc text, không cần cả hai.' },
          text: { type: 'string', description: 'Nội dung SKILL.md cần kiểm tra (khi không có dir).' },
          name: { type: 'string', description: 'Tên thư mục skill khi kiểm tra bằng text (để kiểm tra name trùng thư mục).' },
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
        if (dir.trim() !== '') {
          return formatValidationSummaryV14(validateSkillDirV14(dir));
        }
        if (text.trim() !== '') {
          return formatValidationSummaryV14(validateSkillTextV14(text, name));
        }
        return errorResult('Cần truyền "dir" (thư mục skill) hoặc "text" (nội dung SKILL.md).');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const discoverTool: Tool = {
    definition: {
      name: 'skills_v14_discover',
      description:
        'Quét 4 gốc discovery của skill v14 (.agents/skills/ + .claude/skills/ trong project, ' +
        'global ~/.claude/skills/ và ~/.agents/skills/), dedupe theo tên, ưu tiên project-local. ' +
        'Chỉ đọc — chỉ liệt kê tên thư mục, không mở SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          projectRoot: {
            type: 'string',
            description: 'Project root để quét. Bỏ trống = thư mục làm việc hiện tại.',
          },
          projectOnly: {
            type: 'boolean',
            description: 'true = chỉ quét project-local, bỏ qua global. Mặc định false.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const result = discoverSkillsV14({
          projectRoot: projectRootFor(opts, args),
          projectOnly: getBoolArg(args, 'projectOnly', false),
        });
        return formatDiscoverySummaryV14(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const searchTool: Tool = {
    definition: {
      name: 'skills_v14_search',
      description:
        'Tìm skill v14 đã cài theo từ khóa trong tên và mô tả (không tìm trong body — progressive disclosure). ' +
        'Kết quả xếp hạng: khớp tên trước, khớp mô tả sau. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Từ khóa cần tìm, vd "review pull request" hoặc "ghi chép".' },
          projectRoot: {
            type: 'string',
            description: 'Project root để quét skill. Bỏ trống = thư mục làm việc hiện tại.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        if (query.trim() === '') return errorResult('Từ khóa tìm kiếm không được rỗng.');
        const hits = searchInstalledSkillsV14(query, { projectRoot: projectRootFor(opts, args) });
        if (hits.length === 0) return `Không tìm thấy skill nào cho ${JSON.stringify(query)}.`;
        const lines: string[] = [`Tìm thấy ${hits.length} skill cho ${JSON.stringify(query)}:`];
        for (const hit of hits) {
          lines.push(
            `- ${hit.entry.name} (điểm ${hit.score}, khớp ${hit.matchedIn}) [${hit.entry.enabled ? 'bật' : 'tắt'}]: ${hit.entry.description}`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toggleTool: Tool = {
    definition: {
      name: 'skills_v14_toggle',
      description:
        'Bật hoặc tắt một skill v14 đã cài. Chỉ ghi file trạng thái tier (.openbot-skills-v14.json) — ' +
        'không sửa hay xóa thư mục skill. Skill bị tắt vẫn còn đó, chỉ không vào context lúc mở session. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên skill cần bật/tắt.' },
          enabled: { type: 'boolean', description: 'true = bật, false = tắt.' },
          projectRoot: {
            type: 'string',
            description: 'Project root (quyết định vị trí file trạng thái). Bỏ trống = thư mục làm việc hiện tại.',
          },
        },
        required: ['name', 'enabled'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const enabled = getBoolArg(args, 'enabled', true);
        if (name.trim() === '') return errorResult('Tên skill không được rỗng.');
        const projectRoot = projectRootFor(opts, args);
        if (enabled) {
          enableSkillV14(name, { projectRoot });
          return `Đã bật skill "${name}".`;
        }
        disableSkillV14(name, { projectRoot });
        return `Đã tắt skill "${name}" (skill vẫn còn đó, chỉ không vào context nữa).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const importTool: Tool = {
    definition: {
      name: 'skills_v14_import',
      description:
        'Nhập một skill v14 từ bundle (thư mục chứa skill-bundle.json): kiểm tra checksum từng file, ' +
        'validate strict rồi mới ghi. Khi skill cùng tên đã tồn tại, tool trả về yêu cầu xác nhận ghi đè — ' +
        'gọi lại với overwrite=true để xác nhận. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          bundleDir: { type: 'string', description: 'Thư mục bundle cần nhập.' },
          targetDir: {
            type: 'string',
            description: 'Thư mục chứa skill (mỗi skill là <tên>/SKILL.md). Bỏ trống = thư mục skills đã cấu hình cho host.',
          },
          overwrite: {
            type: 'boolean',
            description: 'true = ghi đè skill cùng tên đã tồn tại (chỉ đặt sau khi người dùng xác nhận). Mặc định false.',
          },
        },
        required: ['bundleDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const bundleDir = getStringArg(args, 'bundleDir');
        const targetDir = skillsDirOrError(opts, args);
        const overwrite = getBoolArg(args, 'overwrite', false);
        const result = importSkillV14(bundleDir, { targetDir, overwrite });
        if (isOverwriteNeededV14(result)) {
          return (
            `Skill "${result.name}" đã tồn tại tại ${JSON.stringify(result.existingDir)}. ` +
            `Chưa ghi gì cả — gọi lại skills_v14_import với overwrite=true để xác nhận ghi đè.`
          );
        }
        return `Đã nhập skill "${result.name}" vào ${JSON.stringify(result.dir)}${result.overwritten ? ' (đã ghi đè bản cũ)' : ''} — validation sạch (${result.validation.qualityScore}/100).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportTool: Tool = {
    definition: {
      name: 'skills_v14_export',
      description:
        'Xuất một skill v14 đã cài thành bundle portable: toàn bộ thư mục skill + manifest skill-bundle.json ' +
        'kèm SHA-256 từng file. Skill lỗi validation không được xuất. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          skillDir: { type: 'string', description: 'Thư mục skill cần xuất (chứa SKILL.md).' },
          outDir: {
            type: 'string',
            description: 'Thư mục bundle đích. Bỏ trống = <thư-mục-làm-việc>/<tên-skill>.skill-v14.',
          },
        },
        required: ['skillDir'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const skillDir = getStringArg(args, 'skillDir');
        const outDir = getStringArg(args, 'outDir', false);
        const result = exportSkillV14(skillDir, outDir.trim() !== '' ? { outDir } : {});
        return (
          `Đã xuất skill "${result.manifest.name}" thành bundle ${JSON.stringify(result.bundleDir)} ` +
          `(${result.fileCount} file, manifest ${result.manifest.files.length} checksum SHA-256).`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const createTool: Tool = {
    definition: {
      name: 'skills_v14_create',
      description:
        'Tạo một skill v14 mới: scaffold thư mục skill với SKILL.md hợp chuẩn AAIF strict ngay từ đầu ' +
        '(đúng 6 field, name trùng thư mục, description nói rõ làm gì VÀ khi nào dùng). ' +
        'Validate strict trước khi ghi — input lỗi thì không tạo gì cả. Cần duyệt.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tên skill (chữ thường/số/gạch ngang, tối đa 64 ký tự) — cũng là tên thư mục.' },
          description: {
            type: 'string',
            description: 'Mô tả skill (tối đa 1.024 ký tự): nói rõ skill làm gì VÀ khi nào dùng.',
          },
          body: { type: 'string', description: 'Thân SKILL.md (hướng dẫn). Bỏ trống = dùng body mẫu.' },
          license: { type: 'string', description: 'Giấy phép, vd "MIT". Bỏ trống = không ghi.' },
          allowedTools: {
            type: 'string',
            description: 'Danh sách tool cho phép, cách nhau bằng dấu phẩy, vd "read_file, write_file". Bỏ trống = không giới hạn.',
          },
          withStubs: {
            type: 'boolean',
            description: 'true = tạo thêm stub scripts/run.sh và references/notes.md. Mặc định false.',
          },
          targetDir: {
            type: 'string',
            description: 'Thư mục cha chứa skill (mỗi skill là <tên>/SKILL.md). Bỏ trống = thư mục skills đã cấu hình cho host.',
          },
          overwrite: {
            type: 'boolean',
            description: 'true = ghi đè thư mục skill cùng tên đã tồn tại. Mặc định false.',
          },
        },
        required: ['name', 'description'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const description = getStringArg(args, 'description');
        const body = getStringArg(args, 'body', false);
        const license = getStringArg(args, 'license', false);
        const allowedToolsRaw = getStringArg(args, 'allowedTools', false);
        const withStubs = getBoolArg(args, 'withStubs', false);
        const overwrite = getBoolArg(args, 'overwrite', false);
        if (name.trim() === '') return errorResult('Tên skill không được rỗng.');
        if (description.trim() === '') return errorResult('Mô tả skill không được rỗng.');
        const parentDir = skillsDirOrError(opts, args);
        const allowedTools =
          allowedToolsRaw.trim() === ''
            ? undefined
            : allowedToolsRaw.split(',').map((t) => t.trim()).filter((t) => t !== '');
        const result = createSkillV14(
          parentDir,
          {
            name,
            description,
            license: license.trim() !== '' ? license : undefined,
            allowedTools,
            body: body.trim() !== '' ? body : undefined,
            withStubs,
          },
          { overwrite },
        );
        return (
          `Đã tạo skill "${result.name}" tại ${JSON.stringify(result.dir)} ` +
          `(${result.files.join(', ')}) — validation sạch (${result.validation.qualityScore}/100).`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [listTool, activateTool, resourceTool, validateTool, discoverTool, searchTool, toggleTool, importTool, exportTool, createTool];
}

/**
 * Placeholder chưa bound (không có getSkillsDir — các tool ghi sẽ báo
 * lỗi rõ ràng cho tới khi host tạo lại bằng factory kèm getSkillsDir).
 * Điều phối viên nối factory vào defaultToolFactory, không dùng const này.
 */
export const SKILLS_V14_TOOLS: Tool[] = createSkillsV14Tools();

/** Tên của 10 tool v14 (để test/host kiểm tra mà không cần gọi factory). */
export const SKILLS_V14_TOOL_NAMES: readonly string[] = SKILL_V14_TOOL_NAMES;
