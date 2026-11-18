/**
 * Agent Skills v14 — portable import / export (v1.34, Team T1).
 *
 * One skill = one portable bundle: the whole skill directory copied
 * verbatim into a bundle directory, plus a `skill-bundle.json` manifest
 * listing every file with its SHA-256 checksum, the skill name and
 * description, and the export time. A bundle is self-describing: the
 * importer can verify it without trusting the sender.
 *
 * Export:
 * - refuses invalid skills (strict v14 validation, including the
 *   script-security scan) — a broken skill never becomes a bundle;
 * - never copies the tier-state file or anything outside the skill dir.
 *
 * Import:
 * - refuses bundles whose manifest is missing, malformed, or whose
 *   checksums do not match (a tampered or truncated bundle);
 * - validates the skill strictly again before writing anything;
 * - never overwrites silently: when the target already holds a skill
 *   of the same name and `overwrite` was not passed, it returns
 *   `{ needsOverwriteConfirm: true, … }` instead of throwing, so the
 *   UI/agent can ask the user and re-run with `overwrite: true`;
 * - writes to a temporary directory first, then renames into place, so
 *   a failed import never leaves a half-written skill behind.
 *
 * Everything here is original open-bot code.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSkillDirV14, validateSkillTextV14 } from './validator.js';
import { SKILL_V14_BUNDLE_FORMAT, SKILL_V14_BUNDLE_MANIFEST, SKILL_V14_FILE_NAME } from './types.js';
import type {
  ExportSkillV14Options,
  ExportSkillV14Result,
  ImportSkillV14Options,
  ImportSkillV14Result,
  SkillV14BundleFile,
  SkillV14BundleManifest,
  SkillV14OverwriteNeeded,
} from './types.js';

/** The manifest is itself checksummed? No — it IS the checksum list. Kept separate for clarity. */
export const SKILL_V14_BUNDLE_VERSION = 1;

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** List every file under a directory, relative POSIX paths, sorted. */
export function listBundleFilesV14(skillDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(skillDir, '');
  return out.sort();
}

/**
 * Export one installed skill directory into a portable bundle.
 * Throws when the skill is missing or fails strict v14 validation.
 */
export function exportSkillV14(
  skillDir: string,
  opts: ExportSkillV14Options = {},
): ExportSkillV14Result {
  const resolved = path.resolve(skillDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot export ${JSON.stringify(skillDir)} — not a directory.`);
  }
  if (!fs.existsSync(path.join(resolved, SKILL_V14_FILE_NAME))) {
    throw new Error(`Cannot export ${JSON.stringify(skillDir)} — it holds no ${SKILL_V14_FILE_NAME}.`);
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
  const bundleDir = path.resolve(opts.outDir ?? path.join(process.cwd(), `${name}.skill-v14`));
  fs.mkdirSync(bundleDir, { recursive: true });

  const files: SkillV14BundleFile[] = [];
  for (const rel of listBundleFilesV14(resolved)) {
    const src = path.join(resolved, rel);
    const dest = path.join(bundleDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    const bytes = fs.statSync(src).size;
    files.push({ path: rel.split(path.sep).join('/'), bytes, sha256: sha256File(src) });
  }
  const manifest: SkillV14BundleManifest = {
    format: SKILL_V14_BUNDLE_FORMAT,
    name,
    description: validation.frontmatter.description,
    version: undefined,
    exportedAt: new Date().toISOString(),
    exportedBy: 'open-bot skills v14',
    files,
  };
  fs.writeFileSync(path.join(bundleDir, SKILL_V14_BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { bundleDir, manifest, fileCount: files.length + 1 };
}

/** Read + parse a bundle manifest (throws on missing/malformed manifest). */
export function readBundleManifestV14(bundleDir: string): SkillV14BundleManifest {
  const manifestPath = path.join(bundleDir, SKILL_V14_BUNDLE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Bundle ${JSON.stringify(bundleDir)} holds no ${SKILL_V14_BUNDLE_MANIFEST} — not a v14 skill bundle.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch {
    throw new Error(`Bundle manifest ${JSON.stringify(manifestPath)} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Bundle manifest must be a JSON object.');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw['format'] !== SKILL_V14_BUNDLE_FORMAT) {
    throw new Error(
      `Bundle format ${JSON.stringify(raw['format'])} is not ${JSON.stringify(SKILL_V14_BUNDLE_FORMAT)} — refusing to import.`,
    );
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    throw new Error('Bundle manifest has no skill name.');
  }
  if (typeof raw['description'] !== 'string') {
    throw new Error('Bundle manifest has no skill description.');
  }
  if (!Array.isArray(raw['files'])) {
    throw new Error('Bundle manifest has no file list.');
  }
  for (const entry of raw['files'] as unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Bundle manifest file entry must be an object.');
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['path'] !== 'string' || typeof e['sha256'] !== 'string' || typeof e['bytes'] !== 'number') {
      throw new Error('Bundle manifest file entry needs "path", "sha256" and "bytes".');
    }
    if ((e['path'] as string).includes('..') || path.isAbsolute(e['path'] as string)) {
      throw new Error(`Bundle manifest lists an unsafe path ${JSON.stringify(e['path'])} — refusing to import.`);
    }
  }
  return parsed as unknown as SkillV14BundleManifest;
}

/**
 * Verify every file listed in the manifest exists in the bundle with
 * the recorded checksum. Returns the list of problems (empty = clean).
 * Never throws for a bad file — it reports it, so the caller can show
 * the user exactly what is wrong.
 */
export function verifyBundleChecksumsV14(bundleDir: string, manifest: SkillV14BundleManifest): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    seen.add(file.path);
    const full = path.join(bundleDir, file.path);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      problems.push(`Missing file: ${file.path}`);
      continue;
    }
    const stat = fs.statSync(full);
    if (stat.size !== file.bytes) {
      problems.push(`Size mismatch: ${file.path} (expected ${file.bytes} bytes, found ${stat.size})`);
      // Do NOT skip the checksum: a tampered file usually changes BOTH
      // size and content, and a size-only report would hide the content
      // change. Report both problems.
    }
    const actual = sha256File(full);
    if (actual !== file.sha256) {
      problems.push(`Checksum mismatch: ${file.path} (bundle may be tampered or truncated)`);
    }
  }
  // Extra files not in the manifest are suspicious too.
  for (const rel of listBundleFilesV14(bundleDir)) {
    if (rel === SKILL_V14_BUNDLE_MANIFEST) continue;
    if (!seen.has(rel.split(path.sep).join('/'))) {
      problems.push(`Unlisted file in bundle: ${rel}`);
    }
  }
  return problems;
}

/** Is the bundle dir itself safe to import (manifest + checksums + strict validation)? */
export function validateBundleV14(bundleDir: string): { manifest: SkillV14BundleManifest; problems: string[] } {
  const manifest = readBundleManifestV14(bundleDir);
  const problems = verifyBundleChecksumsV14(bundleDir, manifest);
  const skillFile = path.join(bundleDir, SKILL_V14_FILE_NAME);
  if (!fs.existsSync(skillFile)) {
    problems.push(`Bundle holds no ${SKILL_V14_FILE_NAME}.`);
  } else {
    const text = fs.readFileSync(skillFile, 'utf8');
    const validation = validateSkillTextV14(text, manifest.name);
    if (!validation.valid) {
      for (const finding of validation.errors) problems.push(`Skill invalid: ${finding.code}: ${finding.message}`);
    }
    if (validation.frontmatter !== undefined && validation.frontmatter.name !== manifest.name) {
      problems.push(
        `Manifest name ${JSON.stringify(manifest.name)} does not match skill name ${JSON.stringify(validation.frontmatter.name)}.`,
      );
    }
  }
  return { manifest, problems };
}

/**
 * Import a bundle into `opts.targetDir`.
 *
 * - Manifest/checksum/validation failures throw (nothing is written).
 * - When the target already holds a skill of the same name and
 *   `overwrite` is false, returns `{ needsOverwriteConfirm: true, … }`
 *   instead of writing — the caller must confirm and re-run.
 * - Otherwise writes to a temp dir first, then renames into place.
 */
export function importSkillV14(
  bundleDir: string,
  opts: ImportSkillV14Options,
): ImportSkillV14Result | SkillV14OverwriteNeeded {
  const resolvedBundle = path.resolve(bundleDir);
  if (!fs.existsSync(resolvedBundle) || !fs.statSync(resolvedBundle).isDirectory()) {
    throw new Error(`Cannot import ${JSON.stringify(bundleDir)} — not a directory.`);
  }
  const { manifest, problems } = validateBundleV14(resolvedBundle);
  if (problems.length > 0) {
    throw new Error(`Cannot import bundle ${JSON.stringify(bundleDir)} — ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  }
  const targetDir = path.resolve(opts.targetDir);
  const destDir = path.join(targetDir, manifest.name);
  const existed = fs.existsSync(destDir);
  if (existed && !opts.overwrite) {
    return { needsOverwriteConfirm: true, name: manifest.name, existingDir: destDir, bundleDir: resolvedBundle };
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // Write to a temp sibling first, then rename — a failed import never
  // leaves a half-written skill behind.
  const tmpDir = path.join(targetDir, `.${manifest.name}.import-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const file of manifest.files) {
      const src = path.join(resolvedBundle, file.path);
      const dest = path.join(tmpDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    if (existed) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.renameSync(tmpDir, destDir);
  } catch (e) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw new Error(`Import failed while copying: ${(e as Error).message}`);
  }
  const validation = validateSkillDirV14(destDir);
  if (!validation.valid) {
    // Should be impossible (the bundle was validated) — but never leave
    // an invalid skill installed.
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw new Error(`Imported skill failed re-validation and was removed: ${validation.errors[0]?.message ?? 'unknown error'}`);
  }
  return { dir: destDir, name: manifest.name, overwritten: existed, validation };
}

/** Is this the overwrite-confirmation shape (rather than a success)? */
export function isOverwriteNeededV14(
  result: ImportSkillV14Result | SkillV14OverwriteNeeded,
): result is SkillV14OverwriteNeeded {
  return (result as SkillV14OverwriteNeeded).needsOverwriteConfirm === true;
}

/** Checksum helper (exported for tests): SHA-256 of a UTF-8 string. */
export function sha256TextV14(text: string): string {
  return sha256Text(text);
}
