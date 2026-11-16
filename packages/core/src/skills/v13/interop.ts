/**
 * Agent Skills loader v13 — cross-CLI import/export (v1.13, Team T1).
 *
 * The Agent Skills format (SKILL.md + `scripts/` + `references/` +
 * `assets/`) is shared, but each host keeps skills in its own place:
 *
 *   claude-code  — `<project>/.claude/skills/<name>/SKILL.md`
 *                   (project skills) or `~/.claude/skills/<name>/`
 *                   (personal skills). Frontmatter may also carry
 *                   `user-invocable` and `context: fork`.
 *   codex-cli    — `~/.agents/skills/<name>/SKILL.md` (per the
 *                   layout this project targets; Codex also reads
 *                   project `.codex/skills/`). Same SKILL.md shape.
 *   gemini-cli   — `~/.gemini/skills/<name>/SKILL.md` (personal) or
 *                   `<project>/.gemini/skills/<name>/` (project).
 *
 * This module does NOT talk to those CLIs and does NOT copy their
 * skills: it reads/writes the directory layout so a skill can move
 * between hosts. The SKILL.md itself is validated with the v13
 * validator on the way in and on the way out — a skill that fails
 * validation is never written to another host's folder.
 *
 * Layout rules (all formats):
 * - The skill directory name MUST equal the frontmatter `name`
 *   (the loader enforces this; export writes it that way).
 * - `SKILL.md` is required; `scripts/`, `references/`, `assets/`
 *   are copied verbatim when present (files only — symlinks are
 *   refused, and `..` / absolute paths are refused).
 * - Export never overwrites an existing skill unless `overwrite` is
 *   set; import never overwrites unless `overwrite` is set.
 * - A host root that does not exist is created on export (including
 *   parents); on import a missing root just yields no skills.
 *
 * Format detection: `detectSkillFormat(dir)` looks at the path
 * (`/.claude/skills/`, `/.agents/skills/`, `/.gemini/skills/`,
 * `/.codex/skills/`) and falls back to `unknown` — detection is a
 * hint for the UI, never a security decision; import/export work on
 * any directory regardless of the detected format.
 *
 * Safety: imported skill text is secret-scanned by the loader
 * (`parseSkillMarkdown` rejects secrets) and re-validated; a skill
 * that fails either check is reported in `errors` and not installed.
 * Imported files are copied, never moved, so the source stays intact.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadSkillDir,
  loadSkillsFromDir,
  parseSkillMarkdown,
  SKILL_FILE_NAME,
} from '../loader';
import type { Skill } from '../types';
import { validateSkillV13 } from './validation';
import type { SkillV13Validation } from './validation';

/** The three CLI hosts open-bot can exchange skills with. */
export type SkillHostFormat = 'claude-code' | 'codex-cli' | 'gemini-cli';

/** The same three, plus "could not tell from the path". */
export type DetectedSkillFormat = SkillHostFormat | 'unknown';

/** Where one host keeps its skills. */
export interface SkillHostRoot {
  format: SkillHostFormat;
  /** Absolute directory holding `<name>/SKILL.md` subdirectories. */
  rootDir: string;
  /** Human label for logs/UI (e.g. "Claude Code (project)"). */
  label: string;
}

/** Default roots for each host (project + personal where they differ). */
export function defaultHostRoots(projectDir?: string, homeDir?: string): SkillHostRoot[] {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
  const project = projectDir ?? process.cwd();
  const roots: SkillHostRoot[] = [];
  roots.push({
    format: 'claude-code',
    rootDir: path.join(project, '.claude', 'skills'),
    label: 'Claude Code (project)',
  });
  if (home) {
    roots.push({ format: 'claude-code', rootDir: path.join(home, '.claude', 'skills'), label: 'Claude Code (personal)' });
    roots.push({ format: 'codex-cli', rootDir: path.join(home, '.agents', 'skills'), label: 'Codex CLI' });
    roots.push({ format: 'gemini-cli', rootDir: path.join(home, '.gemini', 'skills'), label: 'Gemini CLI' });
  }
  roots.push({ format: 'codex-cli', rootDir: path.join(project, '.codex', 'skills'), label: 'Codex CLI (project)' });
  roots.push({ format: 'gemini-cli', rootDir: path.join(project, '.gemini', 'skills'), label: 'Gemini CLI (project)' });
  return roots;
}

/**
 * Guess the host format from a skills-root path. Matches (case-
 * sensitive, forward-slash normalised):
 * - `/.claude/skills/` (or a trailing `/.claude/skills`) -> claude-code
 * - `/.agents/skills/` -> codex-cli
 * - `/.gemini/skills/` -> gemini-cli
 * - `/.codex/skills/` -> codex-cli (project layout)
 * Anything else -> 'unknown'. Detection is advisory only.
 */
export function detectSkillFormat(dir: string): DetectedSkillFormat {
  const normalised = dir.replace(/\\/g, '/');
  if (/(^|\/)\.claude\/skills(\/|$)/.test(normalised)) return 'claude-code';
  if (/(^|\/)\.agents\/skills(\/|$)/.test(normalised)) return 'codex-cli';
  if (/(^|\/)\.gemini\/skills(\/|$)/.test(normalised)) return 'gemini-cli';
  if (/(^|\/)\.codex\/skills(\/|$)/.test(normalised)) return 'codex-cli';
  return 'unknown';
}

/** Root directory for one host format (personal scope by default). */
export function hostRootFor(
  format: SkillHostFormat,
  opts: { projectDir?: string; homeDir?: string; scope?: 'personal' | 'project' } = {},
): string {
  const home = opts.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
  const project = opts.projectDir ?? process.cwd();
  const scope = opts.scope ?? 'personal';
  if (format === 'claude-code') {
    return scope === 'project' ? path.join(project, '.claude', 'skills') : path.join(home, '.claude', 'skills');
  }
  if (format === 'codex-cli') {
    return scope === 'project' ? path.join(project, '.codex', 'skills') : path.join(home, '.agents', 'skills');
  }
  return scope === 'project' ? path.join(project, '.gemini', 'skills') : path.join(home, '.gemini', 'skills');
}

/** Copy a directory tree (files only). Refuses symlinks and `..` escapes. */
function copySkillTree(srcDir: string, destDir: string): { filesCopied: number; bytesCopied: number } {
  let filesCopied = 0;
  let bytesCopied = 0;
  const walk = (src: string, dest: string): void => {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to copy symlink ${JSON.stringify(srcPath)} — skills must be plain files.`);
      }
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        const data = fs.readFileSync(srcPath);
        fs.writeFileSync(destPath, data);
        filesCopied++;
        bytesCopied += data.length;
      }
      // Anything else (sockets, devices) is skipped silently.
    }
  };
  walk(srcDir, destDir);
  return { filesCopied, bytesCopied };
}

/** Render a Skill back to SKILL.md text (frontmatter + body). */
export function renderSkillMarkdown(skill: Skill): string {
  const lines: string[] = ['---', `name: ${skill.name}`];
  lines.push(`description: ${JSON.stringify(skill.description)}`);
  if (skill.version && skill.version !== '1.0.0') lines.push(`version: ${skill.version}`);
  if (skill.whenToUse) lines.push(`when-to-use: ${JSON.stringify(skill.whenToUse)}`);
  if (skill.allowedTools.length > 0) {
    lines.push(`allowed-tools: [${skill.allowedTools.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  if (skill.license) lines.push(`license: ${JSON.stringify(skill.license)}`);
  if (skill.compatibility !== undefined) {
    const compat = typeof skill.compatibility === 'string' ? skill.compatibility : skill.compatibility.join(', ');
    lines.push(`compatibility: ${JSON.stringify(compat)}`);
  }
  if (skill.metadata !== undefined) {
    lines.push('metadata:');
    for (const [k, v] of Object.entries(skill.metadata)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (skill.context) lines.push(`context: ${skill.context}`);
  if (skill.disableModelInvocation) lines.push('disable-model-invocation: true');
  if (!skill.userInvocable) lines.push('user-invocable: false');
  if (skill.scope && skill.scope.length > 0) {
    lines.push(`scope: [${skill.scope.map((s) => JSON.stringify(s)).join(', ')}]`);
  }
  lines.push('---', '');
  lines.push(skill.body);
  return lines.join('\n');
}

export interface ExportSkillOptions {
  /** Overwrite an existing skill of the same name at the target (default false). */
  overwrite?: boolean;
  /** Run v13 validation before writing; invalid skills are not exported (default true). */
  validate?: boolean;
}

export interface ExportSkillResult {
  format: SkillHostFormat;
  name: string;
  /** Absolute directory the skill was written to. */
  destDir: string;
  filesCopied: number;
  bytesCopied: number;
  validation: SkillV13Validation;
}

/**
 * Export one skill (by parsed Skill, or by directory holding
 * SKILL.md) into a host's skills root: `<root>/<name>/SKILL.md` plus
 * `scripts/` / `references/` / `assets/` when the source has them.
 * The destination directory name always equals the skill name.
 */
export function exportSkillToHost(
  skillOrDir: Skill | string,
  format: SkillHostFormat,
  rootDir: string,
  opts: ExportSkillOptions = {},
): ExportSkillResult {
  const overwrite = opts.overwrite ?? false;
  const validate = opts.validate ?? true;
  let skill: Skill;
  let sourceDir: string | undefined;
  if (typeof skillOrDir === 'string') {
    skill = loadSkillDir(skillOrDir, 'user');
    sourceDir = skillOrDir;
    // Tier-2 body: the export needs the full body text.
    const text = fs.readFileSync(path.join(skillOrDir, SKILL_FILE_NAME), 'utf8');
    skill = parseSkillMarkdown(text, 'user', path.join(skillOrDir, SKILL_FILE_NAME), undefined, skillOrDir);
  } else {
    skill = skillOrDir;
    sourceDir = skill.skillDir;
  }
  const validation = validateSkillV13(skill);
  if (validate && !validation.valid) {
    throw new Error(
      `Skill "${skill.name}" fails v13 validation and was not exported:\n` +
        validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n'),
    );
  }
  const destDir = path.join(rootDir, skill.name);
  if (fs.existsSync(destDir) && !overwrite) {
    throw new Error(
      `Skill "${skill.name}" already exists at ${JSON.stringify(destDir)} — pass overwrite: true to replace it.`,
    );
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, SKILL_FILE_NAME), renderSkillMarkdown(skill), 'utf8');
  let filesCopied = 1;
  let bytesCopied = Buffer.byteLength(renderSkillMarkdown(skill), 'utf8');
  if (sourceDir) {
    for (const sub of ['scripts', 'references', 'assets'] as const) {
      const srcSub = path.join(sourceDir, sub);
      try {
        if (!fs.statSync(srcSub).isDirectory()) continue;
      } catch {
        continue;
      }
      const copied = copySkillTree(srcSub, path.join(destDir, sub));
      filesCopied += copied.filesCopied;
      bytesCopied += copied.bytesCopied;
    }
  }
  return { format, name: skill.name, destDir, filesCopied, bytesCopied, validation };
}

export interface ImportSkillOptions {
  /** Overwrite an existing skill of the same name in the target dir (default false). */
  overwrite?: boolean;
  /** Run v13 validation on import; invalid skills are not installed (default true). */
  validate?: boolean;
}

export interface ImportSkillResult {
  name: string;
  /** Absolute directory the skill was installed to. */
  installedDir: string;
  /** Format detected from the source path ('unknown' when unclear). */
  sourceFormat: DetectedSkillFormat;
  filesCopied: number;
  bytesCopied: number;
  validation: SkillV13Validation;
}

/**
 * Import one skill from a host's skills folder into open-bot's skills
 * directory: `<sourceRoot>/<name>/` -> `<destDir>/<name>/`. The
 * source is validated (loader + v13) before anything is copied.
 */
export function importSkillFromHost(
  sourceSkillDir: string,
  destDir: string,
  opts: ImportSkillOptions = {},
): ImportSkillResult {
  const overwrite = opts.overwrite ?? false;
  const validate = opts.validate ?? true;
  const sourceFormat = detectSkillFormat(sourceSkillDir);
  const skill = loadSkillDir(sourceSkillDir, 'user');
  const text = fs.readFileSync(path.join(sourceSkillDir, SKILL_FILE_NAME), 'utf8');
  const full = parseSkillMarkdown(text, 'user', path.join(sourceSkillDir, SKILL_FILE_NAME), undefined, sourceSkillDir);
  const validation = validateSkillV13(full);
  if (validate && !validation.valid) {
    throw new Error(
      `Skill "${skill.name}" fails v13 validation and was not imported:\n` +
        validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n'),
    );
  }
  const installedDir = path.join(destDir, skill.name);
  if (fs.existsSync(installedDir) && !overwrite) {
    throw new Error(
      `Skill "${skill.name}" already exists at ${JSON.stringify(installedDir)} — pass overwrite: true to replace it.`,
    );
  }
  fs.mkdirSync(installedDir, { recursive: true });
  const copied = copySkillTree(sourceSkillDir, installedDir);
  return {
    name: skill.name,
    installedDir,
    sourceFormat,
    filesCopied: copied.filesCopied,
    bytesCopied: copied.bytesCopied,
    validation,
  };
}

/** One skill found in a host root (tier-1 metadata only). */
export interface HostSkillListing {
  format: DetectedSkillFormat;
  name: string;
  description: string;
  version: string;
  dir: string;
}

/**
 * List the skills in a host's skills root (tier 1 — headers only).
 * A broken skill is reported in `errors` and skipped.
 */
export function listHostSkills(rootDir: string): {
  skills: HostSkillListing[];
  errors: Array<{ file: string; error: string }>;
} {
  const { skills, errors } = loadSkillsFromDir(rootDir, 'user', undefined, { metadataOnly: true });
  return {
    skills: skills.map((s) => ({
      format: detectSkillFormat(rootDir),
      name: s.name,
      description: s.description,
      version: s.version,
      dir: s.skillDir ?? s.filePath ?? path.join(rootDir, s.name),
    })),
    errors,
  };
}

/**
 * Import EVERY skill from a host root into open-bot's skills dir.
 * Each skill is validated independently; failures are collected in
 * `errors` and do not stop the others. Returns the installed names.
 */
export function importAllFromHost(
  sourceRoot: string,
  destDir: string,
  opts: ImportSkillOptions = {},
): {
  imported: ImportSkillResult[];
  errors: Array<{ file: string; error: string }>;
} {
  const imported: ImportSkillResult[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(sourceRoot).sort();
  } catch {
    return { imported, errors };
  }
  for (const entry of entries) {
    const full = path.join(sourceRoot, entry);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    try {
      if (!fs.statSync(path.join(full, SKILL_FILE_NAME)).isFile()) continue;
    } catch {
      continue;
    }
    try {
      imported.push(importSkillFromHost(full, destDir, opts));
    } catch (err) {
      errors.push({ file: full, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { imported, errors };
}
