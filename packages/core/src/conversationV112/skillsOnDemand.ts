/**
 * Skills nạp theo yêu cầu từ workspace (v1.12, Đội T2).
 *
 * Nguồn skill MỚI so với loader hiện có (`skills/loader.ts` quét
 * `<userData>/skills/` + plugin dirs): thư mục `.openbot/skills/`
 * TRONG WORKSPACE của bot — skill đi kèm repo/dự án, commit cùng
 * code, không cần cài vào userData. Định dạng file giống hệt skill
 * chuẩn (frontmatter `name` + `description` + body, xem
 * `skills/types.ts`): tái dùng `parseSkillMarkdown` /
 * `loadSkillsFromDir` của loader, KHÔNG viết parser YAML mới.
 *
 * Progressive disclosure (giống registry 3 tầng):
 * 1. Index — quét thư mục, chỉ đọc frontmatter (tier 1), kèm
 *    validation riêng của workspace: tên skill phải khớp tên file
 *    (loose `<name>.md`) hoặc tên thư mục (`<name>/SKILL.md`).
 * 2. Load — đọc body chỉ khi agent/user yêu cầu skill đó
 *    (`loadWorkspaceSkill`), cắt ở `MAX_SKILL_BODY_CHARS`.
 * 3. Suggest — khớp trigger/từ khoá trên description + when-to-use
 *    để gợi ý skill cho một message (không tự nạp).
 *
 * Validation: file quá lớn (>200KB), tên sai định dạng, thiếu
 * description, body rỗng, chứa secret → lỗi rõ ràng từng file, file
 * lỗi không chặn các file khác (index vẫn trả về skill tốt + errors).
 * Skill `disable-model-invocation: true` không bao giờ được suggest
 * tự động (chỉ user gọi).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadSkillDir,
  loadSkillFile,
  loadSkillsFromDir,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_TEXT_CHARS,
  SKILL_NAME_RE,
} from '../skills/loader';
import type { Skill } from '../skills/types';

/** Thư mục skill trong workspace (tương đối). */
export const WORKSPACE_SKILLS_DIR = '.openbot/skills';

/** Số skill tối đa trong một workspace (chống quét thư mục khổng lồ). */
export const MAX_WORKSPACE_SKILLS = 200;

/** Lỗi khi skill workspace không hợp lệ / không tìm thấy. */
export class WorkspaceSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSkillError';
  }
}

/** Một mục trong index skill của workspace (tier 1 — chỉ metadata). */
export interface WorkspaceSkillIndexEntry {
  name: string;
  description: string;
  version: string;
  /** Đường dẫn file (tương đối trong workspace). */
  file: string;
  /** `file` = loose `<name>.md`; `dir` = `<name>/SKILL.md`. */
  layout: 'file' | 'dir';
  /** Skill chỉ user mới được gọi (model không tự suggest/nạp). */
  userOnly: boolean;
  /** Từ khoá trigger (frontmatter `metadata.triggers`, nếu có). */
  triggers: string[];
  whenToUse: string;
}

/** Kết quả index: các skill tốt + lỗi từng file. */
export interface WorkspaceSkillIndex {
  workspaceDir: string;
  skillsDir: string;
  entries: WorkspaceSkillIndexEntry[];
  errors: Array<{ file: string; error: string }>;
  scannedAt: string;
}

/** Đường dẫn tuyệt đối tới thư mục skill của workspace. */
export function workspaceSkillsDir(workspaceDir: string): string {
  return path.join(workspaceDir, WORKSPACE_SKILLS_DIR);
}

/** Trích triggers từ frontmatter metadata (hỗ trợ string hoặc list). */
function extractTriggers(skill: Skill): string[] {
  const meta = skill.metadata as Record<string, unknown> | undefined;
  const raw = meta?.['triggers'];
  if (typeof raw === 'string') return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function toIndexEntry(skill: Skill, workspaceDir: string): WorkspaceSkillIndexEntry {
  const rel = skill.filePath ? path.relative(workspaceDir, skill.filePath) : skill.name;
  const layout: 'file' | 'dir' = skill.filePath?.endsWith('SKILL.md') ? 'dir' : 'file';
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    file: rel.split(path.sep).join('/'),
    layout,
    userOnly: skill.disableModelInvocation === true,
    triggers: extractTriggers(skill),
    whenToUse: skill.whenToUse ?? '',
  };
}

/**
 * Quét `.openbot/skills/` trong workspace, trả về index tier-1.
 * Thư mục không tồn tại → index rỗng (không lỗi). File lỗi được ghi
 * vào `errors` và bỏ qua, không chặn skill khác.
 */
export function indexWorkspaceSkills(workspaceDir: string): WorkspaceSkillIndex {
  const skillsDir = workspaceSkillsDir(workspaceDir);
  const scannedAt = new Date().toISOString();
  let entries: WorkspaceSkillIndexEntry[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(skillsDir).sort();
  } catch {
    return { workspaceDir, skillsDir, entries: [], errors, scannedAt };
  }
  if (dirEntries.length > MAX_WORKSPACE_SKILLS) {
    errors.push({
      file: skillsDir,
      error: `Thư mục skill có ${dirEntries.length} mục, vượt giới hạn ${MAX_WORKSPACE_SKILLS} — chỉ index ${MAX_WORKSPACE_SKILLS} mục đầu.`,
    });
    dirEntries = dirEntries.slice(0, MAX_WORKSPACE_SKILLS);
  }
  // Tái dùng loader chuẩn (đã xử lý cả loose *.md và <name>/SKILL.md).
  const loaded = loadSkillsFromDir(skillsDir, 'user', undefined, { metadataOnly: true });
  for (const err of loaded.errors) errors.push(err);
  const seen = new Set<string>();
  for (const skill of loaded.skills) {
    // Validation riêng workspace: tên skill phải khớp tên file/thư mục.
    const fileName = skill.filePath ? path.basename(skill.filePath) : '';
    const dirName = skill.filePath ? path.basename(path.dirname(skill.filePath)) : '';
    const expected = skill.filePath?.endsWith('SKILL.md') ? dirName : fileName.replace(/\.md$/, '');
    if (skill.name !== expected) {
      errors.push({
        file: skill.filePath ?? skill.name,
        error: `Skill name "${skill.name}" không khớp tên file/thư mục "${expected}" (workspace skill: name phải bằng tên file).`,
      });
      continue;
    }
    if (!SKILL_NAME_RE.test(skill.name)) {
      errors.push({
        file: skill.filePath ?? skill.name,
        error: `Skill name "${skill.name}" sai định dạng (chỉ a-z 0-9 _ - , 1-64 ký tự).`,
      });
      continue;
    }
    if (seen.has(skill.name)) {
      errors.push({
        file: skill.filePath ?? skill.name,
        error: `Trùng tên skill "${skill.name}" — chỉ giữ bản đầu tiên.`,
      });
      continue;
    }
    seen.add(skill.name);
    entries.push(toIndexEntry(skill, workspaceDir));
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { workspaceDir, skillsDir, entries, errors, scannedAt };
}

/** Tìm entry theo tên trong index (undefined khi không có). */
export function findWorkspaceSkill(index: WorkspaceSkillIndex, name: string): WorkspaceSkillIndexEntry | undefined {
  return index.entries.find((entry) => entry.name === name);
}

/**
 * Nạp đầy đủ một skill workspace theo tên (tier 2 — đọc body).
 * Trả về Skill đầy đủ + text đã render để inject vào prompt.
 * Ném WorkspaceSkillError khi tên sai, không tìm thấy, hoặc file lỗi.
 */
export function loadWorkspaceSkill(
  workspaceDir: string,
  name: string,
): { skill: Skill; rendered: string } {
  if (!SKILL_NAME_RE.test(name)) {
    throw new WorkspaceSkillError(`Tên skill không hợp lệ: "${name}".`);
  }
  const skillsDir = workspaceSkillsDir(workspaceDir);
  const loose = path.join(skillsDir, `${name}.md`);
  const dirFile = path.join(skillsDir, name, 'SKILL.md');
  let skill: Skill;
  if (fs.existsSync(dirFile)) {
    try {
      skill = loadSkillDir(path.join(skillsDir, name), 'user');
    } catch (err) {
      throw new WorkspaceSkillError(`Không nạp được skill "${name}": ${(err as Error).message}`);
    }
    // loadSkillDir chỉ đọc tier-1 (body rỗng) — đọc lại full body.
    try {
      skill = loadSkillFile(dirFile, 'user');
    } catch (err) {
      throw new WorkspaceSkillError(`Không nạp được skill "${name}": ${(err as Error).message}`);
    }
  } else if (fs.existsSync(loose)) {
    try {
      skill = loadSkillFile(loose, 'user');
    } catch (err) {
      throw new WorkspaceSkillError(`Không nạp được skill "${name}": ${(err as Error).message}`);
    }
  } else {
    throw new WorkspaceSkillError(
      `Không tìm thấy skill "${name}" trong ${WORKSPACE_SKILLS_DIR}/ (cần ${name}.md hoặc ${name}/SKILL.md).`,
    );
  }
  if (skill.name !== name) {
    throw new WorkspaceSkillError(
      `Skill name "${skill.name}" không khớp tên file "${name}" — sửa frontmatter hoặc đổi tên file.`,
    );
  }
  const rendered = renderSkillForPrompt(skill);
  return { skill, rendered };
}

/**
 * Render skill thành text inject vào system prompt: tên + mô tả +
 * body (cắt ở MAX_SKILL_BODY_CHARS). Trả về text + số ký tự.
 */
export function renderSkillForPrompt(
  skill: Skill,
  maxChars: number = MAX_SKILL_BODY_CHARS,
): string {
  const body = skill.body.length > maxChars ? skill.body.slice(0, maxChars) : skill.body;
  const truncatedNote = skill.body.length > maxChars
    ? `\n…(đã cắt, còn ${skill.body.length - maxChars} ký tự chưa inject)`
    : '';
  return [
    `# Skill: ${skill.name} (v${skill.version})`,
    skill.description,
    '',
    body,
    truncatedNote,
  ]
    .join('\n')
    .trim();
}

/** Gợi ý skill cho một message: khớp từ khoá trên description/when-to-use/triggers. */
export interface SkillSuggestion {
  name: string;
  score: number;
  reason: string;
}

/**
 * Chấm điểm khớp: mỗi từ khoá (độ dài >= 3) trong text xuất hiện
 * trong triggers = 3 điểm, trong description/when-to-use = 1 điểm.
 * Chỉ trả về skill có score >= 2, sắp xếp giảm dần. Skill userOnly
 * không bao giờ được suggest (chỉ user gọi trực tiếp).
 */
export function suggestSkillsForText(
  index: WorkspaceSkillIndex,
  text: string,
  limit = 3,
): SkillSuggestion[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_à-ỹ-]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  const uniqueWords = [...new Set(words)];
  const scored: SkillSuggestion[] = [];
  for (const entry of index.entries) {
    if (entry.userOnly) continue;
    const hayDescription = `${entry.description} ${entry.whenToUse}`.toLowerCase();
    let score = 0;
    const matched: string[] = [];
    for (const word of uniqueWords) {
      if (entry.triggers.includes(word)) {
        score += 3;
        matched.push(word);
      } else if (hayDescription.includes(word)) {
        score += 1;
        matched.push(word);
      }
    }
    if (score >= 2) {
      scored.push({ name: entry.name, score, reason: `khớp từ khoá: ${[...new Set(matched)].join(', ')}` });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return scored.slice(0, limit);
}

/**
 * Validate một file skill workspace (đọc full, không ghi index):
 * trả về danh sách lỗi (rỗng = hợp lệ). Dùng cho tool validate và
 * cho test.
 */
export function validateWorkspaceSkillFile(filePath: string): string[] {
  const errors: string[] = [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return [`Không đọc được file: ${(err as Error).message}`];
  }
  if (text.length > MAX_SKILL_TEXT_CHARS) {
    errors.push(`File dài ${text.length} ký tự, vượt giới hạn ${MAX_SKILL_TEXT_CHARS}.`);
  }
  try {
    const skill = loadSkillFile(filePath, 'user');
    if (skill.body.length === 0) errors.push('Body rỗng.');
  } catch (err) {
    errors.push((err as Error).message);
  }
  return errors;
}
