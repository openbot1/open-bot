/**
 * Agent Skills v15 — migration of older skills into the v15 layout
 * (v1.36, Team T2).
 *
 * Pre-standard and v13 skills carry frontmatter the strict v14
 * validator rejects: legacy `tools:` (now `allowed-tools`), `version`,
 * `whenToUse`, and the Claude Code-only fields (`context`, `scope`,
 * `disable-model-invocation`, `user-invocable`). Migration rewrites
 * the skill so it passes strict validation on the first try:
 *
 * - Directory name normalised to the spec shape (lowercase letters,
 *   digits, `-` only; `_` and spaces become `-`, anything else is
 *   dropped). The directory is renamed on disk when needed.
 * - `tools:` becomes `allowed-tools` (same list, validated shape).
 * - `whenToUse` text is preserved by appending a "When to use"
 *   section to the body — the information survives, the unknown
 *   field does not.
 * - `version` is dropped (the standard has no version field) and
 *   recorded as a change; Claude Code-only fields are dropped the
 *   same way, each recorded — nothing is silently lost, the report
 *   lists every removal.
 * - A `compatibility` line is added when the skill states none
 *   (default: `openbot`, or `opts.defaultCompatibility`).
 * - A `name` that does not match the (normalised) directory name is
 *   fixed to the directory name.
 *
 * Dry run (`dryRun: true`) reports the changes without writing
 * anything. A real run re-validates the migrated skill strictly and
 * reports the v14 quality score — a migration that does not end
 * clean throws and leaves the original directory untouched (the
 * rewrite happens in a temp sibling, then renames into place).
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SKILL_V14_FILE_NAME, SKILL_V14_NAME_RE } from '../v14/types.js';
import {
  parseFrontmatterRawV14,
  splitSkillTextV14,
  validateSkillDirV14,
  validateSkillTextV14,
} from '../v14/validator.js';
import type {
  MigrateSkillV15Options,
  SkillV15MigrationChange,
  SkillV15MigrationResult,
} from './types.js';

/** Normalise a directory name to the spec shape (lowercase/digits/`-`). */
export function normaliseSkillDirNameV15(name: string): string {
  const lowered = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const cleaned = lowered.replace(/[^a-z0-9-]/g, '');
  const collapsed = cleaned.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return collapsed === '' ? 'skill' : collapsed;
}

/** `true` when the directory name already matches the spec shape. */
export function isSpecDirNameV15(name: string): boolean {
  return SKILL_V14_NAME_RE.test(name);
}

function yamlScalarV15(value: string): string {
  if (
    value === '' ||
    /[:#\n\r\t]|^\s|\s$|^[-?:,[\]{}&*#?|>@`\"']|^(true|false|null|yes|no|on|off|[0-9]+)$/i.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function renderFrontmatterV15(fields: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${yamlScalarV15(String(item))}`);
      }
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${yamlScalarV15(String(value))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function asStringListV15(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...(value as string[])];
  return null;
}

/**
 * Migrate one skill directory into the v15 layout. Returns the change
 * list; with `dryRun` nothing is written. Throws when the directory
 * holds no readable SKILL.md or the migration cannot end clean.
 */
export function migrateSkillV15(
  skillDir: string,
  opts: MigrateSkillV15Options = {},
): SkillV15MigrationResult {
  const resolved = path.resolve(skillDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot migrate ${JSON.stringify(skillDir)} — not a directory.`);
  }
  const skillFile = path.join(resolved, SKILL_V14_FILE_NAME);
  if (!fs.existsSync(skillFile)) {
    throw new Error(`Cannot migrate ${JSON.stringify(skillDir)} — it holds no ${SKILL_V14_FILE_NAME}.`);
  }
  const text = fs.readFileSync(skillFile, 'utf8');
  const split = splitSkillTextV14(text);
  if (split === null) {
    throw new Error(`Cannot migrate ${JSON.stringify(skillDir)} — SKILL.md has no frontmatter fence.`);
  }
  const raw = parseFrontmatterRawV14(split.frontmatterBlock, skillFile);
  const changes: SkillV15MigrationChange[] = [];
  const fromName = path.basename(resolved);

  // --- Directory name ------------------------------------------------------
  const toName = normaliseSkillDirNameV15(fromName);
  if (toName !== fromName) {
    changes.push({
      kind: 'rename-dir',
      from: fromName,
      to: toName,
    });
  }

  // --- Frontmatter fields --------------------------------------------------
  const kept: Record<string, unknown> = {};
  const name = typeof raw['name'] === 'string' ? raw['name'] : toName;
  if (name !== toName) {
    changes.push({
      kind: 'frontmatter-value',
      field: 'name',
      from: String(name),
      to: toName,
    });
  }
  kept['name'] = toName;
  if (typeof raw['description'] === 'string' && raw['description'].trim() !== '') {
    kept['description'] = raw['description'];
  } else {
    throw new Error(
      `Cannot migrate ${JSON.stringify(skillDir)} — frontmatter has no usable description (migration never invents one).`,
    );
  }
  if (raw['license'] !== undefined) kept['license'] = raw['license'];
  if (raw['metadata'] !== undefined) kept['metadata'] = raw['metadata'];

  // Legacy `tools:` → `allowed-tools`.
  const legacyTools = asStringListV15(raw['tools']);
  const allowedTools = asStringListV15(raw['allowed-tools']);
  if (legacyTools !== null && allowedTools === null) {
    kept['allowed-tools'] = legacyTools;
    changes.push({
      kind: 'frontmatter-field',
      field: 'tools',
      from: 'tools',
      to: 'allowed-tools',
    });
  } else if (allowedTools !== null) {
    kept['allowed-tools'] = allowedTools;
  } else if (legacyTools !== null && allowedTools !== null) {
    kept['allowed-tools'] = allowedTools;
    changes.push({
      kind: 'note',
      field: 'tools',
      from: 'legacy tools: field present alongside allowed-tools',
      to: 'kept allowed-tools, dropped legacy tools: field',
    });
  }

  // Compatibility: keep when stated, add when missing.
  const compat = raw['compatibility'];
  if (compat !== undefined) {
    kept['compatibility'] = compat;
  } else {
    const fallback = opts.defaultCompatibility ?? 'openbot';
    kept['compatibility'] = fallback;
    changes.push({
      kind: 'add-compatibility',
      field: 'compatibility',
      from: '(not stated)',
      to: Array.isArray(fallback) ? fallback.join('; ') : String(fallback),
    });
  }

  // Dropped legacy / host-only fields — each one recorded, none silent.
  for (const dropped of ['version', 'context', 'scope', 'disable-model-invocation', 'user-invocable']) {
    if (raw[dropped] !== undefined) {
      changes.push({
        kind: 'frontmatter-field',
        field: dropped,
        from: `${dropped}: ${JSON.stringify(raw[dropped])}`,
        to: '(dropped — not part of the six-field AAIF frontmatter)',
      });
    }
  }
  // Unknown fields the strict validator would reject.
  for (const key of Object.keys(raw)) {
    if (
      !['name', 'description', 'license', 'metadata', 'allowed-tools', 'compatibility', 'tools', 'version', 'context', 'scope', 'disable-model-invocation', 'user-invocable', 'whenToUse'].includes(key)
    ) {
      changes.push({
        kind: 'frontmatter-field',
        field: key,
        from: `${key}: ${JSON.stringify(raw[key])}`,
        to: '(dropped — unknown frontmatter field)',
      });
    }
  }

  // --- Body ------------------------------------------------------------------
  let body = split.body;
  const whenToUse = typeof raw['whenToUse'] === 'string' ? raw['whenToUse'].trim() : '';
  if (whenToUse !== '') {
    if (!body.includes(whenToUse)) {
      body = `${body}\n\n## When to use\n\n${whenToUse}\n`;
    }
    changes.push({
      kind: 'frontmatter-field',
      field: 'whenToUse',
      from: 'whenToUse frontmatter field',
      to: 'moved into a "When to use" section of the body',
    });
  }

  const rendered = `${renderFrontmatterV15(kept)}\n\n${body.trim()}\n`;

  const dryRun = opts.dryRun ?? false;
  const targetDir = toName === fromName ? resolved : path.join(path.dirname(resolved), toName);
  if (!dryRun) {
    if (toName !== fromName && fs.existsSync(targetDir) && !opts.overwrite) {
      throw new Error(
        `Cannot migrate ${JSON.stringify(skillDir)} — rename target ${JSON.stringify(targetDir)} already exists (pass overwrite=true).`,
      );
    }
    // Write to a temp sibling, validate, then rename into place — a
    // failed migration never leaves a half-written skill behind.
    const tmpDir = path.join(path.dirname(resolved), `.${toName}.migrate-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
        const from = path.join(resolved, entry.name);
        const to = path.join(tmpDir, entry.name);
        if (entry.name === SKILL_V14_FILE_NAME) continue;
        if (entry.isDirectory()) copyDirV15(from, to);
        else if (entry.isFile()) fs.copyFileSync(from, to);
      }
      fs.writeFileSync(path.join(tmpDir, SKILL_V14_FILE_NAME), rendered, 'utf8');
      // Validate the RENDERED text against the target name — not the
      // temp dir: the temp dir is named `.name.migrate-…`, so a
      // directory validation would always fail V14-NAME-MISMATCH.
      const validation = validateSkillTextV14(rendered, toName);
      if (!validation.valid) {
        throw new Error(
          `Migration of ${JSON.stringify(fromName)} did not end clean: ` +
            (validation.errors[0] ? `${validation.errors[0].code}: ${validation.errors[0].message}` : 'validation failed.'),
        );
      }
      if (toName !== fromName) {
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, targetDir);
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.writeFileSync(skillFile, rendered, 'utf8');
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      const finalValidation = validateSkillDirV14(targetDir);
      return {
        fromName,
        toName,
        dir: targetDir,
        changes,
        validationQuality: finalValidation.qualityScore,
        dryRun: false,
      };
    } catch (e) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup only.
      }
      throw e;
    }
  }
  return { fromName, toName, dir: targetDir, changes, validationQuality: 0, dryRun: true };
}

function copyDirV15(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirV15(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** One-line-per-change migration report (tool output). */
export function formatMigrationReportV15(result: SkillV15MigrationResult): string {
  const lines = [
    `Migration of "${result.fromName}" → "${result.toName}"${result.dryRun ? ' (dry run — nothing written)' : ''}: ${result.changes.length} change(s), validation ${result.validationQuality}/100.`,
  ];
  for (const change of result.changes) {
    lines.push(`- [${change.kind}]${change.field ? ` ${change.field}` : ''}: ${change.from} → ${change.to}`);
  }
  if (result.changes.length === 0) lines.push('- No changes needed — the skill already matches the v15 layout.');
  return lines.join('\n');
}
