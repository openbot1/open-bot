/**
 * Agent Skills v15 — multi-skill distribution packs (v1.36, Team T2).
 *
 * A pack distributes a SET of skills at once (a team starter kit, a
 * project's skill set): one directory holding one subdirectory per
 * skill plus a `skills-pack.json` manifest. The manifest lists every
 * skill with its description, compatibility and the SHA-256 of its
 * SKILL.md, plus the pack name, version and creation time — so the
 * installer can verify a pack without trusting the sender, exactly
 * like a v14 single-skill bundle.
 *
 * - `createSkillPackV15` copies validated skills into a pack dir and
 *   writes the manifest. A skill that fails strict v14 validation
 *   stops the whole pack (a pack never ships a broken skill).
 * - `verifySkillPackV15` re-checks every skill's checksum and
 *   validation and reports problems (empty = clean). It never throws
 *   for a bad skill — it reports it.
 * - `installSkillPackV15` installs every skill of a verified pack
 *   into the canonical root (and, when asked, mirrors each one to
 *   the other platforms). A skill that already exists in canonical
 *   is skipped unless `overwrite` was passed — and the skip is
 *   reported per skill, never silent.
 * - Pack names use the same shape as skill names (lowercase/digits/
 *   `-`); the manifest format is versioned (`.../1`) so a future
 *   pack format can be told apart.
 *
 * Safety rules (same spirit as v14 import/export):
 * - Nothing is installed from an unverified pack: install verifies
 *   first and throws when the pack is dirty.
 * - Install writes each skill via a temp dir + rename (see
 *   importSkillFromPlatformV15), so a failed install never leaves a
 *   half-written skill behind.
 * - A pack never carries the tier-state file or anything outside the
 *   skill directories it was built from.
 *
 * Everything here is original open-bot code.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_V14_FILE_NAME, SKILL_V14_NAME_RE } from '../v14/types.js';
import { validateSkillDirV14 } from '../v14/validator.js';
import type { SkillV15MirrorMode, SkillV15PlatformId } from './types.js';
import { exportSkillMultiPlatformV15, importSkillFromPlatformV15, isOverwriteNeededV15 } from './multiPlatform.js';
import { parseCompatibilityV15 } from './platforms.js';

/** Manifest file written into every v15 skill pack. */
export const SKILL_V15_PACK_MANIFEST = 'skills-pack.json';
/** Pack manifest format (v15 multi-skill distribution). */
export const SKILL_V15_PACK_FORMAT = 'openbot-skills-v15-pack/1';

/** One skill entry of a pack manifest. */
export interface SkillV15PackSkill {
  name: string;
  description: string;
  /** Structured compatibility, serialised as the raw frontmatter value. */
  compatibility?: string | string[];
  /** Lowercase hex SHA-256 of the skill's SKILL.md at pack time. */
  skillMdSha256: string;
  /** Number of files of this skill in the pack (SKILL.md + the rest). */
  fileCount: number;
}

/** Manifest written into every exported pack. */
export interface SkillV15PackManifest {
  format: typeof SKILL_V15_PACK_FORMAT;
  name: string;
  description: string;
  version: string;
  createdAt: string;
  createdBy: string;
  skills: SkillV15PackSkill[];
}

export interface CreateSkillPackV15Options {
  /** Pack description (required — a pack without one is refused). */
  description: string;
  /** Pack version string. Default: `1.0.0`. */
  version?: string;
  /** Directory to write the pack into. Defaults to `<cwd>/<name>.skills-pack`. */
  outDir?: string;
}

export interface CreateSkillPackV15Result {
  /** Absolute pack directory. */
  packDir: string;
  manifest: SkillV15PackManifest;
  /** Total files in the pack (skills + manifest). */
  fileCount: number;
}

export interface InstallSkillPackV15Options {
  /** Overwrite canonical skills of the same name. Default: `false`. */
  overwrite?: boolean;
  /** Mirror each installed skill to the other platforms. Default: `false`. */
  mirrorAfterInstall?: boolean;
  mirrorMode?: SkillV15MirrorMode;
  /** Platforms to mirror to (default: all except canonical). */
  platforms?: SkillV15PlatformId[];
  /** Install into the global roots instead of the project-local ones. */
  global?: boolean;
  /** Home directory for global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
}

/** One skill's install result inside a pack install. */
export interface SkillV15PackInstallSkill {
  name: string;
  installed: boolean;
  /** `true` when an existing canonical skill was replaced. */
  overwritten: boolean;
  /** `true` when the skill was skipped (already installed, no overwrite). */
  skipped: boolean;
  mirrors: SkillV15PlatformId[];
  validationQuality: number;
}

export interface InstallSkillPackV15Result {
  packName: string;
  skills: SkillV15PackInstallSkill[];
  installed: number;
  skipped: number;
}

/** Pack names use the same shape as skill names. */
export function isPackNameV15(name: string): boolean {
  return SKILL_V14_NAME_RE.test(name);
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function listFilesV15(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

function copyDirV15(src: string, dest: string): number {
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += copyDirV15(from, to);
    else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

/**
 * Create a pack from a list of skill directories. Every skill is
 * validated strictly first; the pack name must use the skill-name
 * shape; the description must not be empty. Throws on the first
 * problem — a pack is never created half-valid.
 */
export function createSkillPackV15(
  skillDirs: string[],
  name: string,
  opts: CreateSkillPackV15Options,
): CreateSkillPackV15Result {
  if (!isPackNameV15(name)) {
    throw new Error(
      `Pack name ${JSON.stringify(name)} is not valid — use lowercase letters, digits and "-" only (same shape as a skill name).`,
    );
  }
  if (opts.description.trim() === '') {
    throw new Error('Pack description must not be empty.');
  }
  if (skillDirs.length === 0) {
    throw new Error('Cannot create an empty pack — pass at least one skill directory.');
  }
  const seen = new Set<string>();
  const manifestSkills: SkillV15PackSkill[] = [];
  const validated: Array<{ dir: string; name: string }> = [];
  for (const skillDir of skillDirs) {
    const resolved = path.resolve(skillDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Cannot pack ${JSON.stringify(skillDir)} — not a directory.`);
    }
    const validation = validateSkillDirV14(resolved);
    if (!validation.valid || validation.frontmatter === undefined) {
      const first = validation.errors[0];
      throw new Error(
        `Cannot pack invalid skill ${JSON.stringify(path.basename(resolved))}: ` +
          (first ? `${first.code}: ${first.message}` : 'validation failed.'),
      );
    }
    const skillName = validation.frontmatter.name;
    if (seen.has(skillName)) {
      throw new Error(`Pack holds two skills named ${JSON.stringify(skillName)} — skill names in a pack must be unique.`);
    }
    seen.add(skillName);
    validated.push({ dir: resolved, name: skillName });
    const compat = parseCompatibilityV15(validation.frontmatter.compatibility);
    manifestSkills.push({
      name: skillName,
      description: validation.frontmatter.description,
      compatibility: compat.unknown ? undefined : compat.raw,
      skillMdSha256: sha256File(path.join(resolved, SKILL_V14_FILE_NAME)),
      fileCount: listFilesV15(resolved).length,
    });
  }
  manifestSkills.sort((a, b) => a.name.localeCompare(b.name));

  const packDir = path.resolve(opts.outDir ?? path.join(process.cwd(), `${name}.skills-pack`));
  fs.mkdirSync(packDir, { recursive: true });
  let fileCount = 0;
  for (const skill of validated) {
    fileCount += copyDirV15(skill.dir, path.join(packDir, skill.name));
  }
  const manifest: SkillV15PackManifest = {
    format: SKILL_V15_PACK_FORMAT,
    name,
    description: opts.description,
    version: opts.version ?? '1.0.0',
    createdAt: new Date().toISOString(),
    createdBy: 'open-bot skills v15',
    skills: manifestSkills,
  };
  fs.writeFileSync(path.join(packDir, SKILL_V15_PACK_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { packDir, manifest, fileCount: fileCount + 1 };
}

/** Read + parse a pack manifest (throws on missing/malformed manifest). */
export function readPackManifestV15(packDir: string): SkillV15PackManifest {
  const manifestPath = path.join(packDir, SKILL_V15_PACK_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Pack ${JSON.stringify(packDir)} holds no ${SKILL_V15_PACK_MANIFEST} — not a v15 skill pack.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    throw new Error(`Pack manifest ${JSON.stringify(manifestPath)} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pack manifest must be a JSON object.');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw['format'] !== SKILL_V15_PACK_FORMAT) {
    throw new Error(
      `Pack format ${JSON.stringify(raw['format'])} is not ${JSON.stringify(SKILL_V15_PACK_FORMAT)} — refusing to read.`,
    );
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    throw new Error('Pack manifest has no pack name.');
  }
  if (typeof raw['description'] !== 'string' || (raw['description'] as string).trim() === '') {
    throw new Error('Pack manifest has no pack description.');
  }
  if (!Array.isArray(raw['skills'])) {
    throw new Error('Pack manifest has no skill list.');
  }
  for (const entry of raw['skills'] as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Pack manifest skill entry must be an object.');
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['name'] !== 'string' || typeof e['description'] !== 'string' || typeof e['skillMdSha256'] !== 'string') {
      throw new Error('Pack manifest skill entry needs "name", "description" and "skillMdSha256".');
    }
    if (!SKILL_V14_NAME_RE.test(e['name'] as string)) {
      throw new Error(`Pack manifest lists an invalid skill name ${JSON.stringify(e['name'])}.`);
    }
  }
  return parsed as unknown as SkillV15PackManifest;
}

/**
 * Verify a pack: manifest shape, every skill directory present with
 * a matching SKILL.md checksum, and every skill strictly valid.
 * Returns the list of problems (empty = clean). Never throws for a
 * bad skill — it reports it.
 */
export function verifySkillPackV15(packDir: string): { manifest: SkillV15PackManifest; problems: string[] } {
  const manifest = readPackManifestV15(packDir);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const skill of manifest.skills) {
    if (seen.has(skill.name)) {
      problems.push(`Duplicate skill in pack: ${skill.name}.`);
      continue;
    }
    seen.add(skill.name);
    const skillDir = path.join(packDir, skill.name);
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      problems.push(`Missing skill directory: ${skill.name}/.`);
      continue;
    }
    const mdFile = path.join(skillDir, SKILL_V14_FILE_NAME);
    if (!fs.existsSync(mdFile)) {
      problems.push(`Skill ${skill.name} holds no ${SKILL_V14_FILE_NAME}.`);
      continue;
    }
    const actual = sha256File(mdFile);
    if (actual !== skill.skillMdSha256) {
      problems.push(`Checksum mismatch: ${skill.name}/SKILL.md (pack may be tampered or edited after packing).`);
    }
    const validation = validateSkillDirV14(skillDir);
    if (!validation.valid) {
      for (const finding of validation.errors) {
        problems.push(`Skill ${skill.name} invalid: ${finding.code}: ${finding.message}`);
      }
    }
    if (validation.frontmatter !== undefined && validation.frontmatter.description !== skill.description) {
      problems.push(`Skill ${skill.name} description does not match the manifest.`);
    }
  }
  // Extra skill directories not in the manifest are suspicious too.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!seen.has(entry.name)) problems.push(`Unlisted skill directory in pack: ${entry.name}/.`);
  }
  return { manifest, problems };
}

/** List the skill names of a pack (from its manifest). */
export function listPackSkillsV15(packDir: string): string[] {
  return readPackManifestV15(packDir).skills.map((s) => s.name);
}

/**
 * Install every skill of a verified pack into the canonical root.
 * Verifies first (a dirty pack installs nothing); already-installed
 * skills are skipped unless `overwrite` was passed; each installed
 * skill can also be mirrored to the other platforms.
 */
export function installSkillPackV15(
  packDir: string,
  opts: { projectRoot?: string } & InstallSkillPackV15Options = {},
): InstallSkillPackV15Result {
  const resolvedPack = path.resolve(packDir);
  if (!fs.existsSync(resolvedPack) || !fs.statSync(resolvedPack).isDirectory()) {
    throw new Error(`Cannot install pack ${JSON.stringify(packDir)} — not a directory.`);
  }
  const { manifest, problems } = verifySkillPackV15(resolvedPack);
  if (problems.length > 0) {
    throw new Error(`Cannot install pack ${JSON.stringify(packDir)} — ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  }
  const projectRoot = opts.projectRoot ?? process.cwd();
  const results: SkillV15PackInstallSkill[] = [];
  for (const skill of manifest.skills) {
    const skillDir = path.join(resolvedPack, skill.name);
    // Import via the multi-platform importer (temp dir + rename, plus
    // the overwrite-confirmation shape for already-installed skills).
    const imported = importSkillFromPlatformV15(skillDir, {
      projectRoot,
      homeDir: opts.homeDir ?? os.homedir(),
      global: opts.global ?? false,
      overwrite: opts.overwrite ?? false,
    });
    if (isOverwriteNeededV15(imported)) {
      results.push({ name: skill.name, installed: false, overwritten: false, skipped: true, mirrors: [], validationQuality: 0 });
      continue;
    }
    let mirrors: SkillV15PlatformId[] = [];
    if (opts.mirrorAfterInstall === true) {
      const exported = exportSkillMultiPlatformV15(imported.canonicalDir, {
        projectRoot,
        homeDir: opts.homeDir ?? os.homedir(),
        global: opts.global ?? false,
        platforms: opts.platforms,
        mode: opts.mirrorMode ?? 'copy',
        overwrite: true,
      });
      mirrors = exported.mirrors.map((m) => m.platform);
    }
    results.push({
      name: skill.name,
      installed: true,
      overwritten: imported.overwritten,
      skipped: false,
      mirrors,
      validationQuality: imported.validationQuality,
    });
  }
  return {
    packName: manifest.name,
    skills: results,
    installed: results.filter((r) => r.installed).length,
    skipped: results.filter((r) => r.skipped).length,
  };
}

/** One-line-per-skill install report (tool output). */
export function formatPackInstallResultV15(result: InstallSkillPackV15Result): string {
  const lines = [
    `Pack "${result.packName}": ${result.installed} skill(s) installed, ${result.skipped} skipped (already installed).`,
  ];
  for (const skill of result.skills) {
    if (skill.skipped) {
      lines.push(`- ${skill.name}: skipped — already installed (re-run with overwrite=true to replace).`);
    } else {
      lines.push(
        `- ${skill.name}: installed${skill.overwritten ? ' (overwrote the old copy)' : ''} — validation ${skill.validationQuality}/100` +
          (skill.mirrors.length > 0 ? `; mirrored to ${skill.mirrors.join(', ')}` : ''),
      );
    }
  }
  return lines.join('\n');
}
