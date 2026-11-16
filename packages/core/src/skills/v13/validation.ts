/**
 * Agent Skills loader v13 — strict validation (v1.13, Team T1).
 *
 * The v0.11a loader (`../loader.ts`) already parses SKILL.md frontmatter
 * and enforces the hard rules (name shape, non-empty description,
 * description <= 1024 chars, semver version, `context: fork` only).
 * This module adds the *v13 strict layer* on top of it — the checks the
 * open Agent Skills spec implies but the lenient loader does not enforce,
 * plus quality guidance that keeps the session-start index cheap:
 *
 * Hard errors (v13):
 * - `compatibility` longer than 500 chars (string form, or joined list
 *   form) — the spec caps it at 500 characters; a longer value is a
 *   spec violation, not a style nit.
 * - `license` present but empty, or longer than 200 chars.
 * - `metadata` present but not a mapping, or serialised longer than
 *   4096 chars (it is copied into the index; unbounded metadata bloats
 *   every session start).
 * - `allowed-tools` entry with an illegal shape (must be a lowercase
 *   tool name: `[a-z0-9][a-z0-9_-]*`), or a duplicate entry.
 * - `name` using `_` (legacy tolerated by the loader) — v13 requires
 *   `-` only for NEW skills; existing `_` names are a warning, not an
 *   error, so old skills keep loading.
 * - `description` that does not read like a trigger: it must be at
 *   least 10 chars and contain a verb-ish trigger word (a small
 *   multilingual list: "when", "use", "review", "write", ... / "khi",
 *   "dùng", "viết", ...). A description that says WHAT the skill is
 *   without saying WHEN to use it scores badly at match time — the
 *   validator flags it so authors fix the text instead of wondering
 *   why the skill never fires.
 * - Body empty (already an error in the loader) or over 500 lines /
 *   20.000 chars — over the spec guidance; v13 makes it an error only
 *   past the hard cap (20.000 chars), a warning past the guidance
 *   (500 lines / 5.000 tokens).
 * - `scope` patterns containing `..` (already rejected by scope.ts)
 *   are re-reported here so one `validateSkillV13` call covers them.
 * - Frontmatter key `tools:` used together with `allowed-tools:` —
 *   ambiguous: which one wins? v13 errors (pick one).
 *
 * Warnings (do not block install/import):
 * - Unknown SPDX license id (free-form text is allowed by the spec,
 *   but a recognised SPDX id makes the marketplace filter reliable).
 * - `allowed-tools` naming a tool open-bot does not know (checked
 *   against the known-tool list passed in by the caller; unknown names
 *   are NOT an error — a skill may target tools from another host).
 * - `version` missing (defaults to 1.0.0 — fine, but worth knowing).
 * - `user-invocable: false` combined with `disable-model-invocation:
 *   true` (a skill nobody can ever invoke).
 * - Description over 500 chars (still valid, but it costs ~125 tokens
 *   in every session-start index).
 * - Body with a fenced code block longer than 50 lines (likely a
 *   pasted script — belongs in `scripts/`, not the body).
 * - No `when-to-use` (legacy field, but it boosts matching a lot).
 *
 * The result is a `SkillV13Validation` with `errors`, `warnings` and a
 * 0–100 `qualityScore` (100 = clean; -15 per error, -3 per warning,
 * floored at 0) plus a per-skill `contextTax` estimate (header + body
 * tokens) so the audit module can rank waste without re-parsing.
 *
 * Everything here is original open-bot code. The spec rules it encodes
 * (frontmatter fields, the 500-char compatibility cap, the 1024-char
 * description cap, progressive disclosure) come from the public
 * Agent Skills spec (agentskills.io); no skill text or code from any
 * other project is copied.
 */

import { estimateTokens } from '../registry';
import type { Skill } from '../types';
import {
  loadSkillsFromDir,
  parseFrontmatter,
  parseSkillMarkdown,
  parseSkillMetadata,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from '../loader';
import { SkillLoadError } from '../types';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Spec cap: `compatibility` is at most 500 characters. */
export const SKILL_V13_COMPATIBILITY_MAX_LENGTH = 500;
/** A `license` value longer than this is almost certainly a pasted text, not an id. */
export const SKILL_V13_LICENSE_MAX_LENGTH = 200;
/** `metadata` serialised longer than this bloats the session-start index. */
export const SKILL_V13_METADATA_MAX_CHARS = 4096;
/** Body guidance: ~500 lines / ~5.000 tokens (spec); hard cap below. */
export const SKILL_V13_BODY_GUIDANCE_LINES = 500;
export const SKILL_V13_BODY_GUIDANCE_CHARS = 5000;
/** Body hard cap: past this the skill is rejected at v13 validation. */
export const SKILL_V13_BODY_MAX_CHARS = 20000;
/** Description over this costs too much in the startup index (warning). */
export const SKILL_V13_DESCRIPTION_WARN_LENGTH = 500;
/** A description shorter than this cannot say when to use the skill. */
export const SKILL_V13_DESCRIPTION_MIN_LENGTH = 10;
/** A fenced code block longer than this belongs in `scripts/`. */
export const SKILL_V13_MAX_CODE_FENCE_LINES = 50;

/**
 * SPDX identifiers open-bot recognises for marketplace filtering.
 * Free-form license text is still legal (warning only) — this list
 * only decides whether the value gets a clean bill or a nudge.
 * Kept short on purpose: the common open-source ids plus the
 * "proprietary / unlicensed" markers authors actually write.
 */
export const KNOWN_SPDX_LICENSES: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'MPL-2.0',
  'ISC',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'Unlicense',
  'Proprietary',
  'UNLICENSED',
];

/**
 * Words that signal a description says WHEN to use the skill.
 * English + Vietnamese + the other locales open-bot ships; a match
 * is case-insensitive and substring-based on purpose (descriptions
 * are free text, not a controlled vocabulary).
 */
export const DESCRIPTION_TRIGGER_WORDS: readonly string[] = [
  // English
  'when',
  'use',
  'review',
  'write',
  'check',
  'help',
  'create',
  'summarise',
  'summarize',
  'translate',
  'research',
  'fix',
  'test',
  'draft',
  'before',
  'after',
  'whenever',
  'need',
  'ask',
  // Vietnamese
  'khi',
  'dùng',
  'viết',
  'kiểm tra',
  'soạn',
  'dịch',
  'trước khi',
  'sau khi',
  'cần',
  'giúp',
  // Chinese / Japanese / Spanish / French (same idea, one word each)
  '当',
  '使用',
  'とき',
  '使う',
  'cuando',
  'usar',
  'quand',
  'utiliser',
];

/** Tool-name shape: lowercase, digits, `-`/`_` (matches the loader's names). */
export const SKILL_V13_TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** One validation finding: a code, a human message, and (for warnings) a fix hint. */
export interface SkillV13Finding {
  code: string;
  message: string;
  /** Short hint for the author; undefined when the message says it all. */
  hint?: string;
}

/** Full result of `validateSkillV13`. */
export interface SkillV13Validation {
  /** Skill name ('' when the frontmatter itself could not be parsed). */
  name: string;
  /** Hard failures: the skill must not be installed/imported as-is. */
  errors: SkillV13Finding[];
  /** Soft problems: installable, but the author should fix them. */
  warnings: SkillV13Finding[];
  /** 0–100. 100 = clean; -15 per error, -3 per warning, floored at 0. */
  qualityScore: number;
  /** Estimated tokens the skill costs: header (index) + body (when loaded). */
  contextTax: { headerTokens: number; bodyTokens: number; totalTokens: number };
  /** True when `errors` is empty. */
  valid: boolean;
}

export interface ValidateSkillV13Options {
  /**
   * Tool names this host knows (e.g. the tool registry's names).
   * `allowed-tools` entries not in this list produce a warning, never
   * an error — a skill may legitimately target another host's tools.
   * When omitted, no unknown-tool warnings are produced.
   */
  knownTools?: Iterable<string>;
  /**
   * Validate the body too (default true). Pass false when only the
   * frontmatter text is available (tier-1 / header-only validation).
   */
  checkBody?: boolean;
}

function error(code: string, message: string, hint?: string): SkillV13Finding {
  return hint ? { code, message, hint } : { code, message };
}

function warning(code: string, message: string, hint?: string): SkillV13Finding {
  return hint ? { code, message, hint } : { code, message };
}

/** Length of a `compatibility` value in its joined (string) form. */
export function compatibilityLength(value: string | string[] | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  return value.join(', ').length;
}

/** True when the description contains at least one trigger word. */
export function descriptionHasTrigger(description: string): boolean {
  const lower = description.toLowerCase();
  return DESCRIPTION_TRIGGER_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

/** Longest fenced code block in a body, in lines (0 when none). */
export function longestCodeFenceLines(body: string): number {
  let longest = 0;
  let current = 0;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inFence) {
        if (current > longest) longest = current;
        current = 0;
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) current++;
  }
  return longest;
}

/**
 * Validate one already-parsed skill (frontmatter + optional body).
 * This is the shared core: `validateSkillTextV13` and
 * `validateSkillMarkdownV13` parse first, then call this.
 */
export function validateSkillV13(
  skill: Skill,
  opts: ValidateSkillV13Options = {},
): SkillV13Validation {
  const errors: SkillV13Finding[] = [];
  const warnings: SkillV13Finding[] = [];
  const checkBody = opts.checkBody ?? true;

  // --- name ------------------------------------------------------------
  if (skill.name.includes('_')) {
    warnings.push(
      warning(
        'name-underscore',
        `Skill "${skill.name}" uses "_" in its name — the Agent Skills spec wants "-" only (e.g. "code-review").`,
        'Rename the skill (and its directory) to use "-" so other hosts accept it.',
      ),
    );
  }

  // --- description -------------------------------------------------------
  const description = skill.description ?? '';
  if (description.length < SKILL_V13_DESCRIPTION_MIN_LENGTH) {
    errors.push(
      error(
        'description-too-short',
        `Skill "${skill.name}" description is ${description.length} chars — at least ${SKILL_V13_DESCRIPTION_MIN_LENGTH} are needed to say when to use it.`,
      ),
    );
  } else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    // The loader already rejects this; report it here too so a caller
    // that only runs v13 validation sees the same failure.
    errors.push(
      error(
        'description-too-long',
        `Skill "${skill.name}" description is ${description.length} chars — the spec limit is ${SKILL_DESCRIPTION_MAX_LENGTH}.`,
        'Shorten it to a trigger: when to use the skill, in one or two sentences.',
      ),
    );
  } else if (description.length > SKILL_V13_DESCRIPTION_WARN_LENGTH) {
    warnings.push(
      warning(
        'description-long',
        `Skill "${skill.name}" description is ${description.length} chars — over ${SKILL_V13_DESCRIPTION_WARN_LENGTH} it costs ~${Math.ceil(description.length / 4)} tokens in every session-start index.`,
        'Keep the description to one or two sentences about when to use the skill.',
      ),
    );
  }
  if (description.length >= SKILL_V13_DESCRIPTION_MIN_LENGTH && !descriptionHasTrigger(description)) {
    errors.push(
      error(
        'description-no-trigger',
        `Skill "${skill.name}" description does not say when to use it — it reads like a label, not a trigger.`,
        'Start with when the skill applies, e.g. "Use when the user asks to review a pull request".',
      ),
    );
  }

  // --- compatibility (spec cap: 500 chars) ------------------------------
  const compatLen = compatibilityLength(skill.compatibility);
  if (compatLen > SKILL_V13_COMPATIBILITY_MAX_LENGTH) {
    errors.push(
      error(
        'compatibility-too-long',
        `Skill "${skill.name}" compatibility is ${compatLen} chars — the spec cap is ${SKILL_V13_COMPATIBILITY_MAX_LENGTH}.`,
        'List only the hard requirements (tools, environment), one short phrase each.',
      ),
    );
  }

  // --- license -------------------------------------------------------------
  if (skill.license !== undefined) {
    const license = skill.license.trim();
    if (license === '') {
      errors.push(
        error(
          'license-empty',
          `Skill "${skill.name}" has an empty "license" — remove the field or give a license id.`,
        ),
      );
    } else if (license.length > SKILL_V13_LICENSE_MAX_LENGTH) {
      errors.push(
        error(
          'license-too-long',
          `Skill "${skill.name}" license is ${license.length} chars — use a short id (e.g. "MIT"), not the full license text.`,
        ),
      );
    } else if (!KNOWN_SPDX_LICENSES.includes(license)) {
      warnings.push(
        warning(
          'license-unknown-spdx',
          `Skill "${skill.name}" license ${JSON.stringify(license)} is not a recognised SPDX id — the marketplace cannot filter on it.`,
          'Use a standard id such as "MIT" or "Apache-2.0" when the skill is open source.',
        ),
      );
    }
  }

  // --- metadata -------------------------------------------------------------
  if (skill.metadata !== undefined) {
    let serialised: string;
    try {
      serialised = JSON.stringify(skill.metadata) ?? '';
    } catch {
      errors.push(
        error(
          'metadata-unserialisable',
          `Skill "${skill.name}" metadata cannot be serialised to JSON.`,
        ),
      );
      serialised = '';
    }
    if (serialised.length > SKILL_V13_METADATA_MAX_CHARS) {
      errors.push(
        error(
          'metadata-too-large',
          `Skill "${skill.name}" metadata serialises to ${serialised.length} chars — the v13 cap is ${SKILL_V13_METADATA_MAX_CHARS} (metadata is copied into the session index).`,
          'Move large data into the skill\'s references/ directory and keep metadata to small flags.',
        ),
      );
    }
  }

  // --- allowed-tools ---------------------------------------------------------
  const tools = skill.allowedTools ?? [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!SKILL_V13_TOOL_NAME_RE.test(tool)) {
      errors.push(
        error(
          'allowed-tool-bad-name',
          `Skill "${skill.name}" allowed-tools entry ${JSON.stringify(tool)} is not a valid tool name (lowercase letters, digits, "-" and "_", starting with a letter).`,
        ),
      );
    }
    if (seen.has(tool)) {
      errors.push(
        error(
          'allowed-tool-duplicate',
          `Skill "${skill.name}" lists tool ${JSON.stringify(tool)} twice in allowed-tools.`,
        ),
      );
    }
    seen.add(tool);
  }
  if (opts.knownTools) {
    const known = new Set(opts.knownTools);
    for (const tool of tools) {
      if (SKILL_V13_TOOL_NAME_RE.test(tool) && !known.has(tool)) {
        warnings.push(
          warning(
            'allowed-tool-unknown',
            `Skill "${skill.name}" allows tool ${JSON.stringify(tool)}, which this host does not know — the skill may target another host's tools.`,
            'If the tool is a typo, fix the name; if it belongs to another host, ignore this warning.',
          ),
        );
      }
    }
  }

  // --- invocation flags ------------------------------------------------------
  if (skill.disableModelInvocation && skill.userInvocable === false) {
    warnings.push(
      warning(
        'skill-uninvocable',
        `Skill "${skill.name}" has both disable-model-invocation and user-invocable: false — nobody can ever invoke it.`,
        'Drop one of the two flags so either the user or the model can trigger the skill.',
      ),
    );
  }
  if (!skill.whenToUse) {
    warnings.push(
      warning(
        'no-when-to-use',
        `Skill "${skill.name}" has no "when-to-use" — matching scores it lower than skills that state when they apply.`,
        'Add one sentence: the situations in which this skill should fire.',
      ),
    );
  }
  if (skill.version === '1.0.0') {
    // 1.0.0 is also the loader default for "no version given" — the
    // distinction is unknowable from a Skill alone, so this is a
    // gentle nudge, worded as such.
    warnings.push(
      warning(
        'version-default',
        `Skill "${skill.name}" reports version 1.0.0 — set an explicit "version" when the skill is published so upgrades can be detected.`,
      ),
    );
  }

  // --- scope -------------------------------------------------------------------
  if (skill.scope) {
    for (const pattern of skill.scope) {
      if (pattern.includes('..')) {
        errors.push(
          error(
            'scope-escapes-workspace',
            `Skill "${skill.name}" scope pattern ${JSON.stringify(pattern)} contains ".." and escapes the workspace.`,
          ),
        );
      }
    }
  }

  // --- body ---------------------------------------------------------------------
  let bodyTokens = 0;
  if (checkBody && skill.bodyLoaded) {
    const body = skill.body;
    bodyTokens = estimateTokens(body);
    if (body.length === 0) {
      errors.push(
        error(
          'body-empty',
          `Skill "${skill.name}" has an empty instruction body.`,
        ),
      );
    } else if (body.length > SKILL_V13_BODY_MAX_CHARS) {
      errors.push(
        error(
          'body-too-long',
          `Skill "${skill.name}" body is ${body.length} chars — the v13 hard cap is ${SKILL_V13_BODY_MAX_CHARS}.`,
          'Move long reference material into references/ and keep the body to the instructions themselves.',
        ),
      );
    } else {
      const lines = body.split('\n').length;
      if (lines > SKILL_V13_BODY_GUIDANCE_LINES || body.length > SKILL_V13_BODY_GUIDANCE_CHARS) {
        warnings.push(
          warning(
            'body-long',
            `Skill "${skill.name}" body is ${lines} lines / ${body.length} chars — the spec guidance is ~${SKILL_V13_BODY_GUIDANCE_LINES} lines / ~${SKILL_V13_BODY_GUIDANCE_CHARS} chars.`,
            'Split long material into references/ files and load them only when needed (tier 3).',
          ),
        );
      }
    }
    const fenceLines = longestCodeFenceLines(body);
    if (fenceLines > SKILL_V13_MAX_CODE_FENCE_LINES) {
      warnings.push(
        warning(
          'body-long-code-fence',
          `Skill "${skill.name}" body contains a fenced code block of ${fenceLines} lines — long scripts belong in scripts/, not in the instruction body.`,
          `Move the block to scripts/ and reference it from the body.`,
        ),
      );
    }
  }

  // --- context tax -------------------------------------------------------------
  const headerText = `${skill.name} — ${description}`;
  const headerTokens = estimateTokens(headerText);
  const totalTokens = headerTokens + bodyTokens;
  const qualityScore = Math.max(
    0,
    100 - errors.length * 15 - warnings.length * 3,
  );

  return {
    name: skill.name,
    errors,
    warnings,
    qualityScore,
    contextTax: { headerTokens, bodyTokens, totalTokens },
    valid: errors.length === 0,
  };
}

/**
 * Validate SKILL.md text (full body). Parses with the v0.11a loader
 * first — a loader failure (bad frontmatter, secret, empty body) is
 * reported as a single `parse` error, so callers get one shape.
 */
export function validateSkillTextV13(
  text: string,
  opts: ValidateSkillV13Options = {},
  filePath?: string,
): SkillV13Validation {
  let skill: Skill;
  try {
    skill = parseSkillMarkdown(text, 'user', filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: '',
      errors: [error('parse-failed', message)],
      warnings: [],
      qualityScore: 0,
      contextTax: { headerTokens: 0, bodyTokens: 0, totalTokens: 0 },
      valid: false,
    };
  }
  return validateSkillV13(skill, opts);
}

/**
 * Validate frontmatter only (tier 1 — header-only, no body read).
 * Useful at session start: a skill whose header already fails v13
 * never gets its body loaded at all.
 */
export function validateSkillHeaderV13(
  text: string,
  opts: ValidateSkillV13Options = {},
  filePath?: string,
): SkillV13Validation {
  let skill: Skill;
  try {
    skill = parseSkillMetadata(text, 'user', filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: '',
      errors: [error('parse-failed', message)],
      warnings: [],
      qualityScore: 0,
      contextTax: { headerTokens: 0, bodyTokens: 0, totalTokens: 0 },
      valid: false,
    };
  }
  return validateSkillV13(skill, { ...opts, checkBody: false });
}

/**
 * Detect a `tools:` + `allowed-tools:` clash in raw frontmatter text
 * (the parsed Skill loses the distinction — both map to the same
 * field). Returns an error finding, or null when there is no clash.
 * Callers that parse from text should append this to the validation.
 */
export function detectToolsFieldClash(frontmatterBlock: string): SkillV13Finding | null {
  const hasTools = /^tools\s*:/m.test(frontmatterBlock);
  const hasAllowed =
    /^allowed-tools\s*:/m.test(frontmatterBlock) ||
    /^allowed_tools\s*:/m.test(frontmatterBlock);
  if (hasTools && hasAllowed) {
    return error(
      'tools-field-clash',
      'Frontmatter has both "tools:" and "allowed-tools:" — pick one (allowed-tools wins in the loader, tools is silently ignored).',
      'Delete the "tools:" entry and keep "allowed-tools:".',
    );
  }
  return null;
}

/**
 * Full text validation including the `tools:` clash check: parses the
 * frontmatter block out of the text, runs the normal validation, and
 * appends the clash error when present. Prefer this over
 * `validateSkillTextV13` when the input is raw file text.
 */
export function validateSkillFileTextV13(
  text: string,
  opts: ValidateSkillV13Options = {},
  filePath?: string,
): SkillV13Validation {
  const result = validateSkillTextV13(text, opts, filePath);
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fence && fence[1] !== undefined) {
    const clash = detectToolsFieldClash(fence[1]);
    if (clash) {
      result.errors.push(clash);
      result.valid = false;
      result.qualityScore = Math.max(0, result.qualityScore - 15);
    }
  }
  return result;
}

/**
 * Validate a parsed frontmatter object directly (no Markdown needed).
 * Used by importers that build frontmatter from another format's
 * manifest before writing the SKILL.md file.
 */
export function validateFrontmatterObjectV13(
  raw: Record<string, unknown>,
  opts: ValidateSkillV13Options = {},
): SkillV13Validation {
  let fm;
  try {
    fm = parseFrontmatter(
      Object.entries(raw)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
        .join('\n'),
    );
  } catch (err) {
    if (err instanceof SkillLoadError) {
      return {
        name: '',
        errors: [error('parse-failed', err.message)],
        warnings: [],
        qualityScore: 0,
        contextTax: { headerTokens: 0, bodyTokens: 0, totalTokens: 0 },
        valid: false,
      };
    }
    throw err;
  }
  const skill: Skill = {
    name: fm.name,
    description: fm.description,
    version: fm.version ?? '1.0.0',
    whenToUse: fm.whenToUse ?? '',
    tools: fm.allowedTools ?? fm.tools ?? [],
    allowedTools: fm.allowedTools ?? fm.tools ?? [],
    license: fm.license,
    compatibility: fm.compatibility,
    metadata: fm.metadata,
    context: fm.context,
    disableModelInvocation: fm.disableModelInvocation ?? false,
    userInvocable: fm.userInvocable ?? true,
    scope: fm.scope,
    body: '',
    bodyLoaded: false,
    resources: { scripts: [], references: [], assets: [] },
    source: 'user',
    enabled: true,
  };
  return validateSkillV13(skill, { ...opts, checkBody: false });
}

/** One-line human summary of a validation (for logs and tool output). */
export function formatValidationSummary(result: SkillV13Validation): string {
  const name = result.name || '(unparsable skill)';
  if (result.valid && result.warnings.length === 0) {
    return `Skill "${name}": valid, quality ${result.qualityScore}/100, context tax ~${result.contextTax.totalTokens} tokens.`;
  }
  const lines = [
    `Skill "${name}": ${result.valid ? 'valid with warnings' : 'INVALID'} — quality ${result.qualityScore}/100, context tax ~${result.contextTax.totalTokens} tokens.`,
  ];
  for (const e of result.errors) lines.push(`  ERROR [${e.code}]: ${e.message}`);
  for (const w of result.warnings) lines.push(`  warn  [${w.code}]: ${w.message}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Whole-directory validation
// ---------------------------------------------------------------------------

/** Validation of every skill in one directory. */
export interface SkillDirValidation {
  /** Per-skill results, sorted by name. */
  results: SkillV13Validation[];
  /** Files/directories that failed even tier-1 parsing (file + message). */
  errors: Array<{ file: string; error: string }>;
  /** Number of skills checked. */
  checked: number;
  /** Number of skills with zero errors. */
  valid: number;
  /** Number of skills with at least one error. */
  invalid: number;
  /** Total context tax of all valid skills (header + body). */
  totalContextTaxTokens: number;
  /** Mean quality score across checked skills (0 when none). */
  meanQualityScore: number;
}

/**
 * Validate every skill in a directory (loose `*.md` + `<name>/SKILL.md`,
 * same layout as `loadSkillsFromDir`). Each skill is validated with
 * its full body; a skill that fails to parse still gets a result
 * (from `validateSkillTextV13`'s parse-failure shape) and is counted
 * invalid, so one bad file never hides the rest. A missing directory
 * yields an empty result, not an error.
 */
export function validateSkillDirV13(
  dir: string,
  opts: ValidateSkillV13Options = {},
): SkillDirValidation {
  const results: SkillV13Validation[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return { results, errors, checked: 0, valid: 0, invalid: 0, totalContextTaxTokens: 0, meanQualityScore: 0 };
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    try {
      if (stat.isDirectory()) {
        const skillFile = path.join(full, 'SKILL.md');
        try {
          if (!fs.statSync(skillFile).isFile()) continue;
        } catch {
          continue;
        }
        const text = fs.readFileSync(skillFile, 'utf8');
        results.push(validateSkillFileTextV13(text, opts, skillFile));
      } else if (stat.isFile() && name.endsWith('.md')) {
        const text = fs.readFileSync(full, 'utf8');
        results.push(validateSkillFileTextV13(text, opts, full));
      }
    } catch (err) {
      errors.push({ file: full, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Keep the loader's own per-file errors visible too (a file that
  // fails tier-1 parsing produces a validation result above, but the
  // loader may know about files this walk skipped — merge both).
  const loaderResult = loadSkillsFromDir(dir, 'user', undefined, { metadataOnly: true });
  for (const e of loaderResult.errors) {
    if (!errors.some((x) => x.file === e.file)) errors.push(e);
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  const valid = results.filter((r) => r.valid).length;
  const totalContextTaxTokens = results
    .filter((r) => r.valid)
    .reduce((sum, r) => sum + r.contextTax.totalTokens, 0);
  const meanQualityScore =
    results.length === 0
      ? 0
      : Math.round(results.reduce((sum, r) => sum + r.qualityScore, 0) / results.length);
  return {
    results,
    errors,
    checked: results.length,
    valid,
    invalid: results.length - valid,
    totalContextTaxTokens,
    meanQualityScore,
  };
}

/** One-line summary of a directory validation (for logs and tool output). */
export function formatDirValidationSummary(validation: SkillDirValidation): string {
  const lines = [
    `Skills checked: ${validation.checked} — ${validation.valid} valid, ${validation.invalid} invalid, ` +
      `mean quality ${validation.meanQualityScore}/100, total context tax ~${validation.totalContextTaxTokens} tokens.`,
  ];
  for (const r of validation.results.filter((x) => !x.valid)) {
    lines.push(`  INVALID "${r.name}": ${r.errors.map((e) => `[${e.code}]`).join(' ')}`);
  }
  for (const e of validation.errors) lines.push(`  LOAD ERROR ${e.file}: ${e.error}`);
  return lines.join('\n');
}
