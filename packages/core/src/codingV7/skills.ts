/**
 * Skills kiểu microagents cho coding agent v7 (v1.15, Đội T4).
 *
 * Học ý tưởng Skills thay microagents của OpenHands V1 SDK (survey
 * v1.15 §3): Skill = một file mô tả (tên, trigger, hướng dẫn, ví dụ)
 * mà agent nạp khi cần, thay cho tool bespoke cứng. Nối skill
 * workspace (v1.11) nhưng v7 viết lại loader + format riêng cho coding:
 * - Format file: markdown có frontmatter `---` ở đầu:
 *     ---
 *     name: fix-test-failure
 *     description: ...
 *     triggers: test fail, failing test
 *     ---
 *     # Hướng dẫn
 *     ...
 *     ## Ví dụ
 *     - ...
 *   Parser tự viết, không phụ thuộc YAML lib.
 * - Discovery: `discoverV7Skills(dir)` quét thư mục `*.md`, parse
 *   từng file, bỏ file lỗi (trả warnings, không throw).
 * - Kích hoạt: `matchV7Skills(text, skills)` chấm điểm theo số từ
 *   khóa trigger trùng (không phân biệt hoa thường, khớp cụm từ);
 *   trả danh sách xếp theo điểm, cao nhất trước.
 * - 3 skill mẫu thật đi kèm dưới dạng `V7_BUILTIN_SKILLS` (đồng thời
 *   là nội dung file mẫu mà tool/CLI có thể ghi ra đĩa qua
 *   `writeV7BuiltinSkills(dir)`).
 *
 * Module thuần trừ discovery/write (fs, chỉ khi caller gọi).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { V7Skill, V7SkillActivation } from './types';

/** 3 skill mẫu thật của v7. */
export const V7_BUILTIN_SKILLS: readonly V7Skill[] = [
  {
    name: 'fix-test-failure',
    description: 'Fix a failing test: reproduce, locate the root cause, make the smallest fix, re-run.',
    triggers: ['test fail', 'failing test', 'test failed', 'tests fail', 'test error', 'lỗi test', 'test đỏ'],
    instructions: [
      '1. Run the failing test alone first to reproduce the exact failure message.',
      '2. Read the failing assertion and the code it covers; do not guess.',
      '3. Fix the root cause in source code, not in the test (unless the test itself is wrong — say so explicitly).',
      '4. Re-run the full test file, then the related suite, to confirm no regression.',
      '5. If the same test fails 3 times in a row, stop and ask the user instead of looping.',
    ].join('\n'),
    examples: [
      'Fix the failing test in tests/auth.test.ts — it says "wrong password".',
      'npm test reports 2 failures in the login suite; make them pass.',
    ],
    source: 'builtin',
  },
  {
    name: 'refactor-extract',
    description: 'Extract a duplicated block into a named function without changing behavior.',
    triggers: ['refactor', 'extract function', 'duplicate code', 'tách hàm', 'trùng lặp', 'clean up'],
    instructions: [
      '1. Find the duplicated block and count its occurrences (at least 2).',
      '2. Extract it into a single named function with a clear name; keep the signature minimal.',
      '3. Replace every occurrence with a call; do not change behavior or output.',
      '4. Run the tests covering the touched files to prove behavior is unchanged.',
      '5. Keep the diff small: one extraction per change, no unrelated renames.',
    ].join('\n'),
    examples: [
      'Refactor: the retry loop is duplicated in three files — extract it into one helper.',
      'Extract the date-formatting block into a function.',
    ],
    source: 'builtin',
  },
  {
    name: 'add-i18n-key',
    description: 'Add a new UI string with translations for all 6 locales (vi, en, es, fr, ja, zh).',
    triggers: ['i18n', 'translation', 'add locale', 'thêm ngôn ngữ', 'dịch', 'locale key', 'new string'],
    instructions: [
      '1. Add the key to apps/desktop/src/renderer/i18n/locales/vi.json first (source of truth for wording).',
      '2. Add the same key with a correct translation to en, es, fr, ja, zh — never leave a locale missing.',
      '3. Keep the key namespaced (e.g. codingV7.myLabel) and use sentence case, no trailing punctuation unless the UI needs it.',
      '4. Verify all 6 files still parse as JSON and have identical key counts for the new namespace.',
      '5. Never translate a key by copying the Vietnamese text into another locale.',
    ].join('\n'),
    examples: [
      'Add i18n key codingV7.paused for the new pause button in all 6 locales.',
      'This new string needs translations — add it to every locale file.',
    ],
    source: 'builtin',
  },
];

/** Render một skill thành nội dung file markdown (để ghi ra đĩa). */
export function renderV7SkillFile(skill: V7Skill): string {
  const lines: string[] = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `triggers: ${skill.triggers.join(', ')}`,
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.instructions,
    '',
    '## Examples',
    '',
    ...skill.examples.map((e) => `- ${e}`),
    '',
  ];
  return lines.join('\n');
}

/** Parse một file skill markdown → V7Skill (null + lý do khi lỗi). */
export function parseV7SkillFile(content: string, source: string): { skill: V7Skill | null; error?: string } {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) {
    return { skill: null, error: 'missing frontmatter (file must start with ---)' };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return { skill: null, error: 'unterminated frontmatter (missing closing ---)' };
  }
  const frontmatter = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) fields[m[1] as string] = (m[2] ?? '').trim();
  }
  const name = fields['name'] ?? '';
  if (!name) return { skill: null, error: 'frontmatter is missing "name"' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { skill: null, error: `invalid skill name: ${name} (lowercase letters, digits, hyphens only)` };
  }
  const description = fields['description'] ?? '';
  const triggers = (fields['triggers'] ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (triggers.length === 0) return { skill: null, error: `skill ${name} has no triggers` };

  // Instructions = body trừ mục ## Examples; examples = các dòng `- ...` sau đó.
  const examplesIdx = body.search(/^##\s+Examples/m);
  const instructions = (examplesIdx === -1 ? body : body.slice(0, examplesIdx)).trim();
  const examples: string[] = [];
  if (examplesIdx !== -1) {
    const examplesBody = body.slice(examplesIdx);
    for (const line of examplesBody.split('\n')) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m?.[1]) examples.push(m[1].trim());
    }
  }
  if (!instructions) return { skill: null, error: `skill ${name} has empty instructions` };
  return {
    skill: { name, description, triggers, instructions, examples, source },
  };
}

/** Kết quả discovery: skill nạp được + cảnh báo file lỗi. */
export interface V7SkillDiscovery {
  skills: V7Skill[];
  /** Cảnh báo (file lỗi parse, file trùng tên...), không throw. */
  warnings: string[];
}

/** Quét thư mục, nạp mọi file `*.md` thành skill. */
export function discoverV7Skills(dir: string): V7SkillDiscovery {
  const skills: V7Skill[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { skills, warnings: [`skills directory not found: ${dir}`] };
  }
  const seen = new Set<string>();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  for (const file of files) {
    const full = path.join(dir, file);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (err) {
      warnings.push(`${file}: cannot read (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const { skill, error } = parseV7SkillFile(content, full);
    if (!skill || error) {
      warnings.push(`${file}: ${error ?? 'parse failed'}`);
      continue;
    }
    if (seen.has(skill.name)) {
      warnings.push(`${file}: duplicate skill name ${skill.name} (skipped)`);
      continue;
    }
    seen.add(skill.name);
    skills.push(skill);
  }
  return { skills, warnings };
}

/** Ghi 3 skill mẫu ra thư mục (tạo thư mục nếu chưa có). Trả số file đã ghi. */
export function writeV7BuiltinSkills(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const skill of V7_BUILTIN_SKILLS) {
    const target = path.join(dir, `${skill.name}.md`);
    fs.writeFileSync(target, renderV7SkillFile(skill), 'utf8');
    written.push(target);
  }
  return written;
}

/**
 * Khớp skill theo text: chấm điểm = số trigger (cụm từ) xuất hiện trong
 * text (không phân biệt hoa thường). Trả danh sách xếp theo điểm giảm
 * dần; trigger dài hơn được ưu tiên khi đồng điểm.
 */
export function matchV7Skills(text: string, skills: readonly V7Skill[]): V7SkillActivation[] {
  const lowered = text.toLowerCase();
  const activations: V7SkillActivation[] = [];
  for (const skill of skills) {
    let score = 0;
    let matchedTrigger = '';
    let matchedLen = 0;
    for (const trigger of skill.triggers) {
      if (trigger && lowered.includes(trigger.toLowerCase())) {
        score += 1;
        if (trigger.length > matchedLen) {
          matchedLen = trigger.length;
          matchedTrigger = trigger;
        }
      }
    }
    if (score > 0) activations.push({ skill, matchedTrigger, score });
  }
  activations.sort((a, b) => b.score - a.score || b.matchedTrigger.length - a.matchedTrigger.length);
  return activations;
}

/** Skill kích hoạt tốt nhất cho text (null khi không khớp skill nào). */
export function bestV7Skill(text: string, skills: readonly V7Skill[]): V7SkillActivation | null {
  const matches = matchV7Skills(text, skills);
  return matches[0] ?? null;
}

/** Registry skill trong bộ nhớ: builtin + nạp thêm từ thư mục. */
export class V7SkillRegistry {
  private readonly byName = new Map<string, V7Skill>();

  constructor(extraDirs: string[] = []) {
    for (const skill of V7_BUILTIN_SKILLS) this.byName.set(skill.name, skill);
    for (const dir of extraDirs) {
      const { skills } = discoverV7Skills(dir);
      for (const skill of skills) this.byName.set(skill.name, skill);
    }
  }

  /** Thêm/ghi đè một skill (vd skill user tự viết). */
  add(skill: V7Skill): void {
    this.byName.set(skill.name, skill);
  }

  get(name: string): V7Skill | undefined {
    return this.byName.get(name);
  }

  list(): V7Skill[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Khớp skill cho text (xếp theo điểm). */
  match(text: string): V7SkillActivation[] {
    return matchV7Skills(text, this.list());
  }
}
