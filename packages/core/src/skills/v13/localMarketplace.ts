/**
 * Agent Skills loader v13 — local skill marketplace (v1.13, Team T1).
 *
 * The v0.14 marketplace (`../marketplace.ts`) installs skills from a
 * URL (.zip / git repo). This module is its local sibling: browse,
 * install and uninstall skills from a LOCAL directory — a shared
 * folder, a USB stick, a checked-out repo, a team's skill library.
 * No network, no download, no git: plain file copies plus validation.
 *
 * Marketplace layout (one entry per skill):
 *
 *   <marketDir>/
 *     code-review/
 *       SKILL.md            (required — the skill itself)
 *       skill.json          (optional manifest — see below)
 *       scripts/ references/ assets/   (optional)
 *     meeting-notes/
 *       SKILL.md
 *       ...
 *
 * Manifest (`skill.json`, optional but recommended): a small JSON
 * object that lets the marketplace filter and version skills without
 * parsing SKILL.md:
 *
 *   {
 *     "name": "code-review",          // required, must match SKILL.md + dir
 *     "version": "1.2.0",             // required, semver
 *     "description": "…",             // required, must match SKILL.md
 *     "author": "open-bot team",      // optional
 *     "license": "MIT",               // optional
 *     "tags": ["review", "git"],      // optional, lowercase words
 *     "requires": ["git"],            // optional, host capabilities
 *     "minOpenBotVersion": "0.2.0"    // optional, semver
 *   }
 *
 * Validation (all local, all offline):
 * - SKILL.md must parse (loader) and pass v13 validation; a failing
 *   skill is listed with its errors and can never be installed.
 * - When `skill.json` exists it must parse, its `name`/`version`/
 *   `description` must match SKILL.md, its `version` must be semver,
 *   its `tags` must be lowercase words, and unknown keys are reported
 *   (warning, not error — forward-compatible).
 * - A manifest whose `minOpenBotVersion` is newer than the running
 *   version is listed but flagged `incompatible` and cannot install.
 *
 * Install = copy the skill directory into the target skills dir
 * (validating again at install time), then re-list to confirm. A
 * skill already installed at an equal-or-newer version refuses to
 * install unless `overwrite` (or `upgrade`) is set; `upgrade` only
 * replaces when the marketplace version is strictly newer (semver).
 * Uninstall removes the installed directory (only when it really
 * looks like a skill: it must contain SKILL.md — never delete an
 * arbitrary folder).
 *
 * All operations are synchronous and offline. Nothing here fetches,
 * executes, or phones home.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSkillDir, parseSkillMarkdown, SKILL_FILE_NAME, SKILL_VERSION_RE } from '../loader';
import { SKILL_NAME_RE } from '../loader';
import type { Skill } from '../types';
import { validateSkillV13 } from './validation';
import type { SkillV13Validation } from './validation';

/** Version of the running open-bot (used for `minOpenBotVersion`). */
export const OPEN_BOT_VERSION = '0.2.0';

/** Name of the manifest file inside a marketplace skill directory. */
export const SKILL_MANIFEST_FILE = 'skill.json';

/** A parsed `skill.json` manifest. */
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  tags?: string[];
  requires?: string[];
  minOpenBotVersion?: string;
}

/** One marketplace entry (a skill offered by a local directory). */
export interface LocalMarketplaceEntry {
  name: string;
  description: string;
  version: string;
  author?: string;
  license?: string;
  tags: string[];
  requires: string[];
  /** Absolute directory of the skill inside the marketplace. */
  dir: string;
  /** True when a `skill.json` manifest was present and valid. */
  hasManifest: boolean;
  /** True when `minOpenBotVersion` is newer than the running version. */
  incompatible: boolean;
  /** v13 validation of the skill (errors block install). */
  validation: SkillV13Validation;
  /** Manifest problems (errors block install; warnings do not). */
  manifestErrors: string[];
  manifestWarnings: string[];
  /** Installable right now (valid + manifest OK + compatible). */
  installable: boolean;
}

export interface BrowseMarketplaceOptions {
  /** Running open-bot version for the compatibility check (default OPEN_BOT_VERSION). */
  openBotVersion?: string;
}

export interface BrowseMarketplaceResult {
  entries: LocalMarketplaceEntry[];
  /** Directories that could not even be listed as skills (file + message). */
  errors: Array<{ file: string; error: string }>;
}

/** Compare two semver strings: -1 / 0 / 1 (missing/invalid sorts first). */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  }
  // Equal core: a pre-release sorts before the release.
  const preA = /-([0-9A-Za-z.-]+)(?:\+|$)/.exec(a)?.[1];
  const preB = /-([0-9A-Za-z.-]+)(?:\+|$)/.exec(b)?.[1];
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return 0;
}

/** Parse + validate a `skill.json` manifest against its SKILL.md. */
export function parseSkillManifest(
  manifestPath: string,
  skill: Skill,
): { manifest: SkillManifest | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (err) {
    return {
      manifest: null,
      errors: [`Manifest ${JSON.stringify(manifestPath)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, errors: [`Manifest ${JSON.stringify(manifestPath)} must be a JSON object.`], warnings };
  }
  const obj = raw as Record<string, unknown>;
  const knownKeys = new Set([
    'name',
    'version',
    'description',
    'author',
    'license',
    'tags',
    'requires',
    'minOpenBotVersion',
  ]);
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) warnings.push(`Manifest has unknown key ${JSON.stringify(key)} (ignored).`);
  }
  const asStr = (key: string): string | undefined => {
    const v = obj[key];
    return typeof v === 'string' ? v : undefined;
  };
  const name = asStr('name');
  if (!name) errors.push('Manifest is missing a string "name".');
  else if (!SKILL_NAME_RE.test(name)) errors.push(`Manifest name ${JSON.stringify(name)} is not a valid skill name.`);
  else if (name !== skill.name) {
    errors.push(`Manifest name ${JSON.stringify(name)} does not match SKILL.md name ${JSON.stringify(skill.name)}.`);
  }
  const version = asStr('version');
  if (!version) errors.push('Manifest is missing a string "version".');
  else if (!SKILL_VERSION_RE.test(version)) errors.push(`Manifest version ${JSON.stringify(version)} is not semver (e.g. "1.2.0").`);
  else if (version !== skill.version) {
    warnings.push(
      `Manifest version ${JSON.stringify(version)} differs from SKILL.md version ${JSON.stringify(skill.version)} — the manifest wins for upgrade checks.`,
    );
  }
  const description = asStr('description');
  if (!description) errors.push('Manifest is missing a string "description".');
  else if (description !== skill.description) {
    warnings.push('Manifest description differs from SKILL.md description — SKILL.md is shown to the model.');
  }
  const tagsRaw = obj['tags'];
  let tags: string[] | undefined;
  if (tagsRaw !== undefined) {
    if (!Array.isArray(tagsRaw) || tagsRaw.some((t) => typeof t !== 'string')) {
      errors.push('Manifest "tags" must be a list of strings.');
    } else {
      tags = tagsRaw as string[];
      for (const tag of tags) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) {
          errors.push(`Manifest tag ${JSON.stringify(tag)} must be a lowercase word (letters, digits, "-").`);
        }
      }
    }
  }
  const requiresRaw = obj['requires'];
  let requires: string[] | undefined;
  if (requiresRaw !== undefined) {
    if (!Array.isArray(requiresRaw) || requiresRaw.some((t) => typeof t !== 'string')) {
      errors.push('Manifest "requires" must be a list of strings.');
    } else {
      requires = requiresRaw as string[];
    }
  }
  const minVersion = asStr('minOpenBotVersion');
  if (minVersion !== undefined && !SKILL_VERSION_RE.test(minVersion)) {
    errors.push(`Manifest "minOpenBotVersion" ${JSON.stringify(minVersion)} is not semver.`);
  }
  if (errors.length > 0) return { manifest: null, errors, warnings };
  const manifest: SkillManifest = {
    name: name!,
    version: version!,
    description: description!,
    author: asStr('author'),
    license: asStr('license'),
    tags,
    requires,
    minOpenBotVersion: minVersion,
  };
  return { manifest, errors, warnings };
}

/**
 * Browse a local marketplace directory: every `<name>/` subdirectory
 * with a SKILL.md becomes an entry (tier-1 + v13 validation). Broken
 * skills are still listed (with their errors, `installable: false`)
 * so the browser can show WHY — only unreadable directories land in
 * `errors`.
 */
export function browseLocalMarketplace(
  marketDir: string,
  opts: BrowseMarketplaceOptions = {},
): BrowseMarketplaceResult {
  const openBotVersion = opts.openBotVersion ?? OPEN_BOT_VERSION;
  const entries: LocalMarketplaceEntry[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(marketDir).sort();
  } catch {
    return { entries, errors };
  }
  for (const name of dirEntries) {
    const full = path.join(marketDir, name);
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
      const skill = loadSkillDir(full, 'user');
      const validation = validateSkillV13(skill);
      const manifestPath = path.join(full, SKILL_MANIFEST_FILE);
      let manifest: SkillManifest | null = null;
      let manifestErrors: string[] = [];
      let manifestWarnings: string[] = [];
      let hasManifest = false;
      if (fs.existsSync(manifestPath)) {
        hasManifest = true;
        const parsed = parseSkillManifest(manifestPath, skill);
        manifest = parsed.manifest;
        manifestErrors = parsed.errors;
        manifestWarnings = parsed.warnings;
      }
      const version = manifest?.version ?? skill.version;
      const incompatible =
        manifest?.minOpenBotVersion !== undefined &&
        compareSemver(openBotVersion, manifest.minOpenBotVersion) < 0;
      const installable = validation.valid && manifestErrors.length === 0 && !incompatible;
      entries.push({
        name: skill.name,
        description: skill.description,
        version,
        author: manifest?.author,
        license: manifest?.license ?? skill.license,
        tags: manifest?.tags ?? [],
        requires: manifest?.requires ?? [],
        dir: full,
        hasManifest,
        incompatible,
        validation,
        manifestErrors,
        manifestWarnings,
        installable,
      });
    } catch (err) {
      errors.push({ file: full, error: err instanceof Error ? err.message : String(err) });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, errors };
}

/** Filter marketplace entries by a free-text query (name/description/tags). */
export function searchLocalMarketplace(
  entries: LocalMarketplaceEntry[],
  query: string,
): LocalMarketplaceEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  return entries.filter((e) => {
    const haystack = `${e.name} ${e.description} ${e.tags.join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  });
}

/** Read the installed version of a skill (SKILL.md version), or null when not installed. */
export function installedSkillVersion(skillsDir: string, name: string): string | null {
  const dir = path.join(skillsDir, name);
  try {
    const skill = loadSkillDir(dir, 'user');
    return skill.version;
  } catch {
    return null;
  }
}

export interface InstallLocalSkillOptions {
  /** Replace an installed skill of the same name (default false). */
  overwrite?: boolean;
  /** Only install when the marketplace version is strictly newer (implies overwrite). */
  upgrade?: boolean;
}

export interface InstallLocalSkillResult {
  name: string;
  version: string;
  installedDir: string;
  filesCopied: number;
  /** Previous installed version, when this replaced one. */
  replacedVersion?: string;
}

/** Copy a skill directory tree (files only; symlinks refused). */
function copySkillDir(srcDir: string, destDir: string): number {
  let files = 0;
  const walk = (src: string, dest: string): void => {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to copy symlink ${JSON.stringify(srcPath)} — skills must be plain files.`);
      }
      if (entry.isDirectory()) walk(srcPath, destPath);
      else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        files++;
      }
    }
  };
  walk(srcDir, destDir);
  return files;
}

/**
 * Install one marketplace skill (by directory) into a skills dir.
 * Re-validates the full skill text at install time (secret scan
 * included) — browsing validation is tier-1 only, install is the
 * enforcement point. Throws on any failure; nothing is half-copied
 * (the copy goes to a temp dir first, then renames into place).
 */
export function installLocalSkill(
  sourceSkillDir: string,
  skillsDir: string,
  opts: InstallLocalSkillOptions = {},
): InstallLocalSkillResult {
  const skill = loadSkillDir(sourceSkillDir, 'user');
  const text = fs.readFileSync(path.join(sourceSkillDir, SKILL_FILE_NAME), 'utf8');
  const full = parseSkillMarkdown(text, 'user', path.join(sourceSkillDir, SKILL_FILE_NAME), undefined, sourceSkillDir);
  const validation = validateSkillV13(full);
  if (!validation.valid) {
    throw new Error(
      `Skill "${skill.name}" fails v13 validation and was not installed:\n` +
        validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n'),
    );
  }
  const manifestPath = path.join(sourceSkillDir, SKILL_MANIFEST_FILE);
  let version = skill.version;
  if (fs.existsSync(manifestPath)) {
    const parsed = parseSkillManifest(manifestPath, skill);
    if (parsed.errors.length > 0) {
      throw new Error(
        `Skill "${skill.name}" manifest is invalid and it was not installed:\n` +
          parsed.errors.map((e) => `  - ${e}`).join('\n'),
      );
    }
    if (parsed.manifest) version = parsed.manifest.version;
  }
  const destDir = path.join(skillsDir, skill.name);
  const existingVersion = installedSkillVersion(skillsDir, skill.name);
  if (existingVersion !== null) {
    if (opts.upgrade) {
      if (compareSemver(version, existingVersion) <= 0) {
        throw new Error(
          `Skill "${skill.name}" is already installed at ${existingVersion} — marketplace has ${version}, nothing to upgrade.`,
        );
      }
    } else if (!opts.overwrite) {
      throw new Error(
        `Skill "${skill.name}" is already installed at ${existingVersion} — pass overwrite: true to replace it, or upgrade: true to upgrade.`,
      );
    }
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  const tmpDir = `${destDir}.tmp-${process.pid}`;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const filesCopied = copySkillDir(sourceSkillDir, tmpDir);
    if (existingVersion !== null) fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, destDir);
    return {
      name: skill.name,
      version,
      installedDir: destDir,
      filesCopied,
      replacedVersion: existingVersion ?? undefined,
    };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Uninstall a skill from a skills dir. Refuses when the directory
 * does not contain SKILL.md (never delete an arbitrary folder) and
 * when the skill is not installed. Returns the removed directory.
 */
export function uninstallLocalSkill(skillsDir: string, name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name ${JSON.stringify(name)}.`);
  }
  const dir = path.join(skillsDir, name);
  let isSkill = false;
  try {
    isSkill = fs.statSync(path.join(dir, SKILL_FILE_NAME)).isFile();
  } catch {
    isSkill = false;
  }
  if (!isSkill) {
    throw new Error(`Skill "${name}" is not installed in ${JSON.stringify(skillsDir)} (no SKILL.md there).`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

/**
 * Check upgrades: for each installed skill, the newest marketplace
 * version available. Returns only skills where the marketplace is
 * strictly newer.
 */
export function checkLocalUpgrades(
  marketDir: string,
  skillsDir: string,
  opts: BrowseMarketplaceOptions = {},
): Array<{ name: string; installedVersion: string; availableVersion: string; dir: string }> {
  const { entries } = browseLocalMarketplace(marketDir, opts);
  const out: Array<{ name: string; installedVersion: string; availableVersion: string; dir: string }> = [];
  for (const entry of entries) {
    if (!entry.installable) continue;
    const installed = installedSkillVersion(skillsDir, entry.name);
    if (installed !== null && compareSemver(entry.version, installed) > 0) {
      out.push({
        name: entry.name,
        installedVersion: installed,
        availableVersion: entry.version,
        dir: entry.dir,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
