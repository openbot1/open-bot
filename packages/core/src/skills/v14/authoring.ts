/**
 * Agent Skills v14 — authoring helper (v1.34, Team T1).
 *
 * Writing a skill that passes the strict v14 validator on the first try
 * is fiddly (six fields only, name == directory, description saying
 * what AND when, no dangerous script). This module does it for the
 * author:
 *
 * - `renderSkillMarkdownV14(frontmatter, body)` — serialise a
 *   six-field frontmatter + body back into `SKILL.md` text (YAML-safe
 *   quoting for values that need it; lists rendered as `[a, b]`).
 * - `createSkillV14(dir, input)` — scaffold a new skill directory:
 *   writes `SKILL.md`, optional `scripts/` stub and `references/`
 *   stub, then validates the result strictly and refuses to leave an
 *   invalid skill behind (the directory is removed again on failure).
 *   Refuses to overwrite an existing directory unless `overwrite` is
 *   passed — same confirmation discipline as import.
 *
 * Everything here is original open-bot code; the sample body text is
 * written for this module, not copied from any existing skill.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSkillDirV14, validateSkillTextV14 } from './validator.js';
import { SKILL_V14_FILE_NAME } from './types.js';
import type { SkillV14Frontmatter, SkillV14Validation } from './types.js';

/** Input for scaffolding a new skill. */
export interface CreateSkillV14Input {
  /** Skill name — must already satisfy the v14 name rule (lowercase/digits/`-`). */
  name: string;
  /** Description — must say what the skill does AND when to use it. */
  description: string;
  license?: string;
  compatibility?: string | string[];
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  /** Body of SKILL.md (instructions). Defaults to a short starter body. */
  body?: string;
  /** When true, also create `scripts/run.sh` and `references/notes.md` stubs. */
  withStubs?: boolean;
}

export interface CreateSkillV14Options {
  /** Overwrite an existing directory of the same name. Default: `false` (refuse). */
  overwrite?: boolean;
}

export interface CreateSkillV14Result {
  /** Absolute skill directory that was created. */
  dir: string;
  name: string;
  /** Strict validation of the skill just written (always clean). */
  validation: SkillV14Validation;
  /** Files written, relative to the skill directory. */
  files: string[];
}

/** Default starter body — tells the author where to put the real instructions. */
export const SKILL_V14_STARTER_BODY = `# {{name}}

<!-- Replace this starter body with the real instructions. Keep it short:
the body loads only when the skill is activated, but a lean body is still
cheaper — move detail into references/ and scripts into scripts/. -->

## What this skill does

Describe the job in a few lines.

## When to use it

Describe the trigger — the same trigger words as the description above.

## Steps

1. First step.
2. Second step.
3. What "done" looks like.
`;

function yamlNeedsQuotes(value: string): boolean {
  if (value.trim() === '') return true;
  // Leading/trailing space, or a character YAML would read as syntax.
  if (/^\s|\s$/.test(value)) return true;
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(value)) return true;
  if (/^(true|false|null|yes|no|on|off|\d+(\.\d+)?)$/i.test(value.trim())) return true;
  if (value.includes('\n')) return true;
  return false;
}

function yamlScalar(value: string): string {
  if (!yamlNeedsQuotes(value)) return value;
  // Single-quoted YAML: escape a quote by doubling it.
  return `'${value.replace(/'/g, "''")}'`;
}

function yamlStringList(values: string[]): string {
  return `[${values.map((v) => yamlScalar(v)).join(', ')}]`;
}

function yamlMetadata(metadata: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') lines.push(`${indent}${key}: ${yamlScalar(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${indent}${key}: ${String(value)}`);
    else if (value === null) lines.push(`${indent}${key}: null`);
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      lines.push(`${indent}${key}: ${yamlStringList(value)}`);
    } else if (typeof value === 'object') {
      lines.push(`${indent}${key}:`);
      lines.push(...yamlMetadata(value as Record<string, unknown>, `${indent}  `));
    } else {
      lines.push(`${indent}${key}: ${yamlScalar(String(value))}`);
    }
  }
  return lines;
}

/**
 * Serialise a six-field frontmatter + body into `SKILL.md` text.
 * The output always passes `validateSkillTextV14` for the same name —
 * unless the caller passes values that break the spec caps (then the
 * validator, not the renderer, reports it).
 */
export function renderSkillMarkdownV14(frontmatter: SkillV14Frontmatter, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${yamlScalar(frontmatter.name)}`);
  lines.push(`description: ${yamlScalar(frontmatter.description)}`);
  if (frontmatter.license !== undefined) lines.push(`license: ${yamlScalar(frontmatter.license)}`);
  if (frontmatter.compatibility !== undefined) {
    if (typeof frontmatter.compatibility === 'string') {
      lines.push(`compatibility: ${yamlScalar(frontmatter.compatibility)}`);
    } else {
      lines.push(`compatibility: ${yamlStringList(frontmatter.compatibility)}`);
    }
  }
  if (frontmatter.metadata !== undefined && Object.keys(frontmatter.metadata).length > 0) {
    lines.push('metadata:');
    lines.push(...yamlMetadata(frontmatter.metadata, '  '));
  }
  if (frontmatter.allowedTools !== undefined && frontmatter.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${yamlStringList(frontmatter.allowedTools)}`);
  }
  lines.push('---');
  lines.push(body.trim() === '' ? '' : body.trim());
  return `${lines.join('\n')}\n`;
}

/** Starter `scripts/run.sh` stub (safe: prints usage, does nothing destructive). */
export const SKILL_V14_SCRIPT_STUB = `#!/bin/sh
# Starter script for this skill. Replace with the real steps.
# Keep it inside the skill directory: no "..", no sudo, never pipe a
# downloaded script into a shell.
echo "Skill {{name}}: implement run.sh"
`;

/** Starter `references/notes.md` stub. */
export const SKILL_V14_REFERENCE_STUB = `# Notes for {{name}}

<!-- Detail that does not belong in the SKILL.md body lives here.
The body stays lean; this file loads only when the skill asks for it. -->

- Note 1.
- Note 2.
`;

/**
 * Scaffold a new skill directory and validate it strictly.
 * Throws (and leaves nothing behind) when the input is invalid or the
 * directory already exists without `overwrite: true`.
 */
export function createSkillV14(
  parentDir: string,
  input: CreateSkillV14Input,
  opts: CreateSkillV14Options = {},
): CreateSkillV14Result {
  const dir = path.join(path.resolve(parentDir), input.name);
  if (fs.existsSync(dir) && !opts.overwrite) {
    throw new Error(
      `Skill directory ${JSON.stringify(dir)} already exists — pass overwrite: true to replace it, or pick another name.`,
    );
  }
  const starterBody = SKILL_V14_STARTER_BODY.replaceAll('{{name}}', input.name);
  const body = input.body !== undefined && input.body.trim() !== '' ? input.body : starterBody;
  const frontmatter: SkillV14Frontmatter = {
    name: input.name,
    description: input.description,
    license: input.license,
    compatibility: input.compatibility,
    metadata: input.metadata,
    allowedTools: input.allowedTools,
  };
  const text = renderSkillMarkdownV14(frontmatter, body);

  // Validate BEFORE writing: never create a directory for an invalid skill.
  const preValidation = validateSkillTextV14(text, input.name);
  if (!preValidation.valid) {
    const first = preValidation.errors[0];
    throw new Error(
      `Cannot create invalid skill ${JSON.stringify(input.name)}: ` +
        (first ? `${first.code}: ${first.message}` : 'validation failed.'),
    );
  }

  const createdHere = !fs.existsSync(dir);
  const files: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SKILL_V14_FILE_NAME), text, 'utf8');
    files.push(SKILL_V14_FILE_NAME);
    if (input.withStubs === true) {
      const scriptPath = path.join(dir, 'scripts', 'run.sh');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, SKILL_V14_SCRIPT_STUB.replaceAll('{{name}}', input.name), 'utf8');
      files.push('scripts/run.sh');
      const refPath = path.join(dir, 'references', 'notes.md');
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.writeFileSync(refPath, SKILL_V14_REFERENCE_STUB.replaceAll('{{name}}', input.name), 'utf8');
      files.push('references/notes.md');
    }
  } catch (e) {
    if (createdHere) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup only.
      }
    }
    throw new Error(`Failed to create skill ${JSON.stringify(input.name)}: ${(e as Error).message}`);
  }

  // Validate the written result (including the script scan) — and remove
  // it again if it somehow fails.
  const validation = validateSkillDirV14(dir);
  if (!validation.valid) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw new Error(
      `Created skill failed re-validation and was removed: ${validation.errors[0]?.message ?? 'unknown error'}`,
    );
  }
  return { dir, name: input.name, validation, files };
}
