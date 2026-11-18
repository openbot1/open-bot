/**
 * Agent Skills v15 — multi-platform import / export (v1.36, Team T2).
 *
 * One canonical directory — `<project>/.agents/skills/<name>/` — plus
 * one mirror per host root (`.claude/skills/`, `.github/skills/`,
 * `.codex/skills/`, `.opencode/skills/`). A mirror is either a real
 * copy or a symlink back to the canonical dir:
 *
 * - `copy`: every host sees its own files; a copy can drift when the
 *   canonical skill is edited later (detected by `sync.ts`, reported
 *   here as `stale-copy`).
 * - `symlink`: edits to the canonical skill are visible everywhere
 *   instantly; a host that does not follow directory symlinks sees
 *   nothing, and a moved canonical dir leaves a `broken-link`.
 *
 * Safety rules (same spirit as v14 import/export):
 * - Export refuses a skill that fails strict v14 validation.
 * - Export never overwrites an existing mirror unless `overwrite`
 *   was passed — the existing mirror is reported in `skipped`.
 * - Import validates the source skill strictly before writing
 *   anything, writes to a temp dir first, then renames into place,
 *   and returns `{ needsOverwriteConfirm: true, … }` instead of
 *   overwriting a canonical skill silently.
 * - Removal only ever touches the mirror (or canonical dir) that was
 *   named — it never follows a symlink into the canonical dir and
 *   deletes through it.
 *
 * Everything here is original open-bot code.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_V14_FILE_NAME } from '../v14/types.js';
import { validateSkillDirV14 } from '../v14/validator.js';
import { SKILL_V15_PLATFORMS, SKILL_V15_PROJECT_ROOTS } from './types.js';
import type {
  ExportMultiPlatformV15Options,
  ExportMultiPlatformV15Result,
  ImportFromPlatformV15Options,
  ImportFromPlatformV15Result,
  SkillV15MirrorResult,
  SkillV15MirrorMode,
  SkillV15MultiStatus,
  SkillV15OverwriteNeeded,
  SkillV15PlatformId,
  SkillV15PlatformInstall,
} from './types.js';
import { platformRootV15 } from './platforms.js';

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** Every file under a directory, relative POSIX paths, sorted. */
export function listSkillFilesV15(dir: string): string[] {
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

function copyDirRecursiveV15(src: string, dest: string): number {
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += copyDirRecursiveV15(from, to);
    else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

/**
 * Compare two skill directories file by file. Returns the list of
 * relative paths that differ (missing on either side, different size
 * or different SHA-256). Empty = identical.
 */
export function diffSkillDirsV15(aDir: string, bDir: string): string[] {
  const aFiles = listSkillFilesV15(aDir);
  const bFiles = listSkillFilesV15(bDir);
  const differing: string[] = [];
  const bSet = new Set(bFiles);
  for (const rel of aFiles) {
    if (!bSet.has(rel)) {
      differing.push(rel);
      continue;
    }
    const aFull = path.join(aDir, ...rel.split('/'));
    const bFull = path.join(bDir, ...rel.split('/'));
    if (fs.statSync(aFull).size !== fs.statSync(bFull).size || sha256File(aFull) !== sha256File(bFull)) {
      differing.push(rel);
    }
  }
  const aSet = new Set(aFiles);
  for (const rel of bFiles) {
    if (!aSet.has(rel)) differing.push(rel);
  }
  return differing.sort();
}

function skillMdShaV15(dir: string): string {
  try {
    return sha256File(path.join(dir, SKILL_V14_FILE_NAME));
  } catch {
    return '';
  }
}

/** Inspect one platform root for one skill name. */
export function inspectPlatformInstallV15(
  name: string,
  platform: SkillV15PlatformId,
  root: string,
  canonicalDir: string | null,
): SkillV15PlatformInstall {
  const dir = path.join(root, name);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { platform, root, dir: '', state: 'missing', detail: '', skillMdSha256: '' };
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.readlinkSync(dir);
    } catch {
      return { platform, root, dir, state: 'broken-link', detail: 'unreadable link', skillMdSha256: '' };
    }
    const resolved = path.resolve(path.dirname(dir), target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { platform, root, dir, state: 'broken-link', detail: target, skillMdSha256: '' };
    }
    const md = skillMdShaV15(resolved);
    if (md === '') return { platform, root, dir, state: 'invalid', detail: `link → ${target} holds no SKILL.md`, skillMdSha256: '' };
    return { platform, root, dir, state: 'symlink', detail: target, skillMdSha256: md };
  }
  if (!stat.isDirectory()) {
    return { platform, root, dir, state: 'invalid', detail: 'not a directory', skillMdSha256: '' };
  }
  const md = skillMdShaV15(dir);
  if (md === '') {
    return { platform, root, dir, state: 'invalid', detail: `holds no ${SKILL_V14_FILE_NAME}`, skillMdSha256: '' };
  }
  if (canonicalDir !== null && path.resolve(canonicalDir) !== path.resolve(dir)) {
    const differing = diffSkillDirsV15(canonicalDir, dir);
    if (differing.length > 0) {
      return { platform, root, dir, state: 'stale-copy', detail: differing[0]!, skillMdSha256: md };
    }
  }
  return { platform, root, dir, state: 'copy', detail: '', skillMdSha256: md };
}

/**
 * Status of one skill across all five platform roots (project-local
 * by default, or global when `opts.global` is set).
 */
export function multiPlatformStatusV15(
  name: string,
  opts: { projectRoot?: string; homeDir?: string; global?: boolean } = {},
): SkillV15MultiStatus {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const canonicalRoot = platformRootV15('openbot', { projectRoot, homeDir, global: opts.global });
  const canonicalDir = path.join(canonicalRoot, name);
  const canonicalExists = fs.existsSync(canonicalDir) && fs.statSync(canonicalDir).isDirectory();
  const canonicalForDiff = canonicalExists ? canonicalDir : null;
  const installs: SkillV15PlatformInstall[] = [];
  for (const platform of SKILL_V15_PLATFORMS) {
    const root = platformRootV15(platform, { projectRoot, homeDir, global: opts.global });
    installs.push(inspectPlatformInstallV15(name, platform, root, canonicalForDiff));
  }
  const canonical = installs.find((i) => i.platform === 'openbot') ?? null;
  const installedOn = installs
    .filter((i) => i.state === 'copy' || i.state === 'symlink')
    .map((i) => i.platform);
  const missingOn = installs.filter((i) => i.state === 'missing').map((i) => i.platform);
  const staleOn = installs.filter((i) => i.state === 'stale-copy').map((i) => i.platform);
  return { name, canonical, installs, installedOn, missingOn, staleOn };
}

/** One-line-per-platform status report (tool output). */
export function formatMultiStatusV15(status: SkillV15MultiStatus): string {
  const lines = [`Skill "${status.name}" across platforms:`];
  for (const install of status.installs) {
    const where = install.dir === '' ? install.root : install.dir;
    const extra = install.detail !== '' ? ` (${install.detail})` : '';
    lines.push(`- ${install.platform}: ${install.state}${extra} — ${where}`);
  }
  lines.push(
    `Installed on: ${status.installedOn.join(', ') || 'none'}; ` +
      `missing on: ${status.missingOn.join(', ') || 'none'}; ` +
      `stale copies: ${status.staleOn.join(', ') || 'none'}.`,
  );
  return lines.join('\n');
}

/**
 * Export one skill directory to the canonical root and mirror it to
 * the other platform roots. The source skill is validated strictly
 * first (a broken skill never becomes a mirror). When the source
 * already IS the canonical dir it is used in place — no copy.
 */
export function exportSkillMultiPlatformV15(
  skillDir: string,
  opts: { projectRoot?: string; homeDir?: string } & ExportMultiPlatformV15Options = {},
): ExportMultiPlatformV15Result {
  const resolved = path.resolve(skillDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot export ${JSON.stringify(skillDir)} — not a directory.`);
  }
  const validation = validateSkillDirV14(resolved);
  if (!validation.valid || validation.frontmatter === undefined) {
    const first = validation.errors[0];
    throw new Error(
      `Cannot export invalid skill ${JSON.stringify(path.basename(resolved))}: ` +
        (first ? `${first.code}: ${first.message}` : 'validation failed.'),
    );
  }
  const name = validation.frontmatter.name;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const global = opts.global ?? false;
  const canonicalRoot = platformRootV15('openbot', { projectRoot, homeDir, global });
  const canonicalDir = path.join(canonicalRoot, name);

  if (path.resolve(resolved) !== path.resolve(canonicalDir)) {
    if (fs.existsSync(canonicalDir)) {
      if (!opts.overwrite) {
        throw new Error(
          `Canonical skill "${name}" already exists at ${JSON.stringify(canonicalDir)} — ` +
            `pass overwrite=true to replace it.`,
        );
      }
      fs.rmSync(canonicalDir, { recursive: true, force: true });
    }
    fs.mkdirSync(canonicalRoot, { recursive: true });
    copyDirRecursiveV15(resolved, canonicalDir);
  }

  const platforms = opts.platforms ?? SKILL_V15_PLATFORMS.filter((p) => p !== 'openbot');
  const mode: SkillV15MirrorMode = opts.mode ?? 'copy';
  const mirrors: SkillV15MirrorResult[] = [];
  const skipped: SkillV15PlatformId[] = [];
  for (const platform of platforms) {
    if (platform === 'openbot') continue;
    const root = platformRootV15(platform, { projectRoot, homeDir, global });
    const dest = path.join(root, name);
    const existed = (() => {
      try {
        fs.lstatSync(dest);
        return true;
      } catch {
        return false;
      }
    })();
    if (existed && !opts.overwrite) {
      skipped.push(platform);
      continue;
    }
    fs.mkdirSync(root, { recursive: true });
    if (existed) {
      // Remove the old mirror itself — never follow a symlink and
      // delete through it (rm on a symlink removes the link only).
      fs.rmSync(dest, { recursive: true, force: true });
    }
    if (mode === 'symlink') {
      fs.symlinkSync(canonicalDir, dest, 'dir');
      mirrors.push({ platform, root, dir: dest, mode, replaced: existed, fileCount: 0 });
    } else {
      const fileCount = copyDirRecursiveV15(canonicalDir, dest);
      mirrors.push({ platform, root, dir: dest, mode, replaced: existed, fileCount });
    }
  }
  return { name, canonicalDir, mirrors, skipped, validationQuality: validation.qualityScore };
}

/**
 * Import one skill from a platform root into the canonical root.
 * `sourceDir` is the skill directory itself (`<root>/<name>/`).
 * Validates strictly before writing; writes via a temp dir + rename;
 * returns the overwrite-confirmation shape instead of overwriting.
 * When `mirrorAfterImport` is set, the imported skill is also mirrored
 * to the other platforms (copy mode unless `mirrorMode` says symlink).
 */
export function importSkillFromPlatformV15(
  sourceDir: string,
  opts: { projectRoot?: string; homeDir?: string; global?: boolean } & ImportFromPlatformV15Options = {},
): ImportFromPlatformV15Result | SkillV15OverwriteNeeded {
  const resolved = path.resolve(sourceDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot import ${JSON.stringify(sourceDir)} — not a directory.`);
  }
  const validation = validateSkillDirV14(resolved);
  if (!validation.valid || validation.frontmatter === undefined) {
    const first = validation.errors[0];
    throw new Error(
      `Cannot import invalid skill ${JSON.stringify(path.basename(resolved))}: ` +
        (first ? `${first.code}: ${first.message}` : 'validation failed.'),
    );
  }
  const name = validation.frontmatter.name;
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const canonicalRoot = platformRootV15('openbot', { projectRoot, homeDir, global: opts.global ?? false });
  const canonicalDir = path.join(canonicalRoot, name);
  const sourcePlatform = detectSourcePlatformV15(resolved, { projectRoot, homeDir });

  const existed = fs.existsSync(canonicalDir);
  if (existed && !opts.overwrite) {
    return {
      needsOverwriteConfirm: true,
      name,
      existingDir: canonicalDir,
      sourceDir: resolved,
      sourcePlatform,
    };
  }
  fs.mkdirSync(canonicalRoot, { recursive: true });
  const tmpDir = path.join(canonicalRoot, `.${name}.import-${process.pid}-${Date.now()}`);
  try {
    copyDirRecursiveV15(resolved, tmpDir);
    if (existed) fs.rmSync(canonicalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, canonicalDir);
  } catch (e) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw new Error(`Import failed while copying: ${(e as Error).message}`);
  }
  const revalidation = validateSkillDirV14(canonicalDir);
  if (!revalidation.valid) {
    try {
      fs.rmSync(canonicalDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw new Error(
      `Imported skill failed re-validation and was removed: ${revalidation.errors[0]?.message ?? 'unknown error'}`,
    );
  }
  let mirrors: SkillV15MirrorResult[] = [];
  if (opts.mirrorAfterImport) {
    const exported = exportSkillMultiPlatformV15(canonicalDir, {
      projectRoot,
      homeDir,
      global: opts.global ?? false,
      mode: opts.mirrorMode ?? 'copy',
      overwrite: true,
    });
    mirrors = exported.mirrors;
  }
  return {
    name,
    fromPlatform: sourcePlatform,
    fromDir: resolved,
    canonicalDir,
    overwritten: existed,
    mirrors,
    validationQuality: revalidation.qualityScore,
  };
}

/** Which platform root does this skill directory live under (best effort)? */
export function detectSourcePlatformV15(
  skillDir: string,
  opts: { projectRoot?: string; homeDir?: string } = {},
): SkillV15PlatformId {
  const resolved = path.resolve(skillDir);
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  for (const global of [false, true]) {
    for (const platform of SKILL_V15_PLATFORMS) {
      const root = platformRootV15(platform, { projectRoot, homeDir, global });
      if (path.dirname(resolved) === path.resolve(root)) return platform;
    }
  }
  return 'openbot';
}

/** Is this the overwrite-confirmation shape (rather than a success)? */
export function isOverwriteNeededV15(
  result: ImportFromPlatformV15Result | SkillV15OverwriteNeeded,
): result is SkillV15OverwriteNeeded {
  return (result as SkillV15OverwriteNeeded).needsOverwriteConfirm === true;
}

/**
 * Remove one skill from one platform root. Removing from `openbot`
 * removes the canonical dir; removing a mirror removes only that
 * mirror (a symlink is unlinked, never followed). Returns `true`
 * when something was removed, `false` when nothing was there.
 */
export function removeSkillFromPlatformV15(
  name: string,
  platform: SkillV15PlatformId,
  opts: { projectRoot?: string; homeDir?: string; global?: boolean } = {},
): boolean {
  const root = platformRootV15(platform, opts);
  const dir = path.join(root, name);
  try {
    fs.lstatSync(dir);
  } catch {
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** List every installed skill name under one platform root (sorted). */
export function listPlatformInstallsV15(
  platform: SkillV15PlatformId,
  opts: { projectRoot?: string; homeDir?: string; global?: boolean } = {},
): string[] {
  const root = platformRootV15(platform, opts);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    if (fs.existsSync(path.join(root, entry.name, SKILL_V14_FILE_NAME))) names.push(entry.name);
  }
  return names.sort();
}

/** The relative project path of a platform root (for display). */
export function platformRelRootV15(platform: SkillV15PlatformId): string {
  return SKILL_V15_PROJECT_ROOTS[platform];
}
