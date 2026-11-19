/**
 * Agent Skills v14 — strict AAIF validator + script security scan (v1.34, Team T1).
 *
 * Enforces exactly what the open Agent Skills spec (agentskills.io, as
 * standardised by the Agentic AI Foundation) says, and nothing the spec
 * does not say:
 *
 * Hard errors:
 * - No `---` frontmatter fence, or frontmatter that is not a mapping.
 * - Any frontmatter field outside the six allowed ones (`name`,
 *   `description`, `license`, `compatibility`, `metadata`,
 *   `allowed-tools`) — unknown fields are rejected, not ignored.
 * - `name` missing, longer than 64 chars, not lowercase/digits/`-`
 *   only, or different from the skill directory name.
 * - `description` missing, empty, or longer than 1.024 chars.
 * - `license` present but empty or longer than 200 chars.
 * - `compatibility` (string, or joined list) longer than 500 chars.
 * - `metadata` present but not a mapping, or serialised longer than
 *   4.096 chars.
 * - `allowed-tools` entry with an illegal shape, or a duplicate entry.
 * - Body empty, or over 20.000 chars.
 * - A script under `scripts/` that runs a destructive command, escapes
 *   the skill directory (`..`), or pipes a download straight into a
 *   shell — see `scanSkillScriptsV14`.
 *
 * Warnings (do not block install/import):
 * - `description` that says WHAT the skill is without saying WHEN to
 *   use it (no when-cue word) — the description is the only text the
 *   agent sees before deciding to load, so a trigger-less description
 *   is why a skill never fires. Also warned when shorter than 10 chars
 *   or longer than 500 chars (still valid, but costs context).
 * - Body over 500 lines / 5.000 chars (spec guidance, not a hard cap).
 * - `allowed-tools` naming a tool the caller does not know (a skill
 *   may target tools from another host — never an error).
 * - Scripts that fetch from the network, install packages, use `ssh`,
 *   `chmod +x`, or touch absolute paths / secrets (review before run).
 *
 * The validator never echoes secret-looking text: findings name the
 * file/line/code only. Everything here is original open-bot code; the
 * spec rules it encodes come from the public Agent Skills spec.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../loader.js';
import {
  SKILL_V14_ALLOWED_FIELDS,
  SKILL_V14_BODY_GUIDANCE_CHARS,
  SKILL_V14_BODY_GUIDANCE_LINES,
  SKILL_V14_BODY_MAX_CHARS,
  SKILL_V14_COMPATIBILITY_MAX_LENGTH,
  SKILL_V14_DESCRIPTION_MAX_LENGTH,
  SKILL_V14_FILE_NAME,
  SKILL_V14_LICENSE_MAX_LENGTH,
  SKILL_V14_METADATA_MAX_CHARS,
  SKILL_V14_NAME_MAX_LENGTH,
  SKILL_V14_NAME_RE,
  SKILL_V14_TOOL_NAME_RE,
  SKILL_V14_WHEN_CUES,
  SKILL_V14_MAX_SCRIPT_BYTES,
} from './types.js';
import type {
  SkillV14Finding,
  SkillV14Frontmatter,
  SkillV14Validation,
  ValidateSkillV14Options,
} from './types.js';

/** Re-export các giới hạn độ dài hay dùng trong test/spec (validator là entry tự nhiên cho chúng). */
export { SKILL_V14_DESCRIPTION_MAX_LENGTH, SKILL_V14_NAME_MAX_LENGTH } from './types.js';

/** Rough token estimate: ~4 characters per token. */
export function estimateTokensV14(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function err(code: string, message: string, field?: string, file?: string, line?: number): SkillV14Finding {
  return { code, severity: 'error', message, field, file, line };
}

function warn(code: string, message: string, field?: string, file?: string, line?: number): SkillV14Finding {
  return { code, severity: 'warning', message, field, file, line };
}

const FRONTMATTER_FENCE_V14 = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split `SKILL.md` text into its frontmatter block and body, or `null` when there is no fence. */
export function splitSkillTextV14(
  text: string,
): { frontmatterBlock: string; body: string } | null {
  const match = FRONTMATTER_FENCE_V14.exec(text);
  if (!match) return null;
  return { frontmatterBlock: match[1]!, body: text.slice(match[0].length).trim() };
}

/**
 * Parse a frontmatter block into its RAW key/value mapping (unknown keys
 * kept — the strict validator needs to see them to reject them). Throws a
 * plain `Error` with a short message when the YAML is invalid.
 */
export function parseFrontmatterRawV14(block: string, filePath?: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(block, filePath, block.split(/\r?\n/));
  } catch (e) {
    throw new Error(`Invalid YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Skill frontmatter must be a mapping of "key: value" pairs.');
  }
  return parsed as Record<string, unknown>;
}

function asStringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : undefined;
}

function asStringListValue(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return undefined;
      out.push(item);
    }
    return out;
  }
  return undefined;
}

/** Does the description say WHEN to use the skill, not just what it is? */
export function descriptionHasWhenCueV14(description: string): boolean {
  const lower = ` ${description.toLowerCase()} `;
  return SKILL_V14_WHEN_CUES.some((cue) => lower.includes(cue.toLowerCase()));
}

/**
 * Validate a parsed frontmatter mapping against the six-field AAIF spec.
 * `dirName` is the skill directory name the `name` must match (pass `''`
 * when validating text without a directory).
 */
export function validateFrontmatterObjectV14(
  raw: Record<string, unknown>,
  dirName: string,
  opts: ValidateSkillV14Options = {},
): SkillV14Validation {
  const errors: SkillV14Finding[] = [];
  const warnings: SkillV14Finding[] = [];

  // --- Unknown fields: the spec allows exactly six. ---
  for (const key of Object.keys(raw)) {
    if (!(SKILL_V14_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      errors.push(
        err(
          'V14-UNKNOWN-FIELD',
          `Unknown frontmatter field ${JSON.stringify(key)} — the AAIF spec allows only: ${SKILL_V14_ALLOWED_FIELDS.join(', ')}.`,
          key,
        ),
      );
    }
  }

  // --- name (required, <= 64, lowercase/digits/'-' only, == directory). ---
  const nameRaw = raw['name'];
  const name = asStringValue(nameRaw) ?? '';
  if (nameRaw === undefined || nameRaw === null || (typeof nameRaw === 'string' && nameRaw.trim() === '')) {
    errors.push(err('V14-NAME-MISSING', 'Missing required frontmatter field "name".', 'name'));
  } else if (typeof nameRaw !== 'string') {
    errors.push(err('V14-NAME-TYPE', '"name" must be a string.', 'name'));
  } else {
    if (name.length > SKILL_V14_NAME_MAX_LENGTH) {
      errors.push(
        err(
          'V14-NAME-TOO-LONG',
          `"name" is ${name.length} chars — the spec limit is ${SKILL_V14_NAME_MAX_LENGTH}.`,
          'name',
        ),
      );
    }
    if (!SKILL_V14_NAME_RE.test(name)) {
      errors.push(
        err(
          'V14-NAME-SHAPE',
          `Invalid skill name ${JSON.stringify(name)}: use 1–${SKILL_V14_NAME_MAX_LENGTH} lowercase letters, digits and "-", starting with a letter or digit (no "_", no uppercase).`,
          'name',
        ),
      );
    }
    if (dirName !== '' && name !== dirName) {
      errors.push(
        err(
          'V14-NAME-MISMATCH',
          `"name" ${JSON.stringify(name)} does not match the skill directory name ${JSON.stringify(dirName)} — the spec requires them to be identical.`,
          'name',
        ),
      );
    }
  }

  // --- description (required, non-empty, <= 1024, says what AND when). ---
  const descriptionRaw = raw['description'];
  const description = asStringValue(descriptionRaw) ?? '';
  if (
    descriptionRaw === undefined ||
    descriptionRaw === null ||
    (typeof descriptionRaw === 'string' && descriptionRaw.trim() === '')
  ) {
    errors.push(err('V14-DESCRIPTION-MISSING', 'Missing required frontmatter field "description".', 'description'));
  } else if (typeof descriptionRaw !== 'string') {
    errors.push(err('V14-DESCRIPTION-TYPE', '"description" must be a string.', 'description'));
  } else {
    if (description.length > SKILL_V14_DESCRIPTION_MAX_LENGTH) {
      errors.push(
        err(
          'V14-DESCRIPTION-TOO-LONG',
          `Description is ${description.length} chars — the spec limit is ${SKILL_V14_DESCRIPTION_MAX_LENGTH} (it is the trigger text loaded at startup, so keep it short).`,
          'description',
        ),
      );
    }
    if (description.trim().length < 10) {
      warnings.push(
        warn(
          'V14-DESCRIPTION-SHORT',
          `Description is only ${description.trim().length} chars — too short to tell the agent what the skill does and when to use it.`,
          'description',
        ),
      );
    } else if (!descriptionHasWhenCueV14(description)) {
      warnings.push(
        warn(
          'V14-DESCRIPTION-NO-WHEN',
          'Description says what the skill is but not when to use it — add a "when …" / "use when …" cue so the agent knows when to load it.',
          'description',
        ),
      );
    }
    if (description.length > 500) {
      warnings.push(
        warn(
          'V14-DESCRIPTION-LONG',
          `Description is ${description.length} chars (valid, but it costs ~${estimateTokensV14(description)} tokens in every session-start index).`,
          'description',
        ),
      );
    }
  }

  // --- license (optional string, <= 200 chars). ---
  const licenseRaw = raw['license'];
  if (licenseRaw !== undefined && licenseRaw !== null) {
    if (typeof licenseRaw !== 'string') {
      errors.push(err('V14-LICENSE-TYPE', '"license" must be a string.', 'license'));
    } else if (licenseRaw.trim() === '') {
      errors.push(err('V14-LICENSE-EMPTY', '"license" is present but empty — remove it or name a license.', 'license'));
    } else if (licenseRaw.length > SKILL_V14_LICENSE_MAX_LENGTH) {
      errors.push(
        err(
          'V14-LICENSE-TOO-LONG',
          `"license" is ${licenseRaw.length} chars — the v14 cap is ${SKILL_V14_LICENSE_MAX_LENGTH}.`,
          'license',
        ),
      );
    }
  }

  // --- compatibility (optional string or list, joined <= 500 chars). ---
  const compatibilityRaw = raw['compatibility'];
  if (compatibilityRaw !== undefined && compatibilityRaw !== null) {
    let joined: string | undefined;
    if (typeof compatibilityRaw === 'string') joined = compatibilityRaw;
    else {
      const list = asStringListValue(compatibilityRaw);
      if (list !== undefined) joined = list.join(', ');
    }
    if (joined === undefined) {
      errors.push(err('V14-COMPATIBILITY-TYPE', '"compatibility" must be a string or a list of strings.', 'compatibility'));
    } else if (joined.length > SKILL_V14_COMPATIBILITY_MAX_LENGTH) {
      errors.push(
        err(
          'V14-COMPATIBILITY-TOO-LONG',
          `"compatibility" is ${joined.length} chars — the spec cap is ${SKILL_V14_COMPATIBILITY_MAX_LENGTH}.`,
          'compatibility',
        ),
      );
    }
  }

  // --- metadata (optional mapping, serialised <= 4096 chars). ---
  const metadataRaw = raw['metadata'];
  if (metadataRaw !== undefined && metadataRaw !== null) {
    if (typeof metadataRaw !== 'object' || Array.isArray(metadataRaw)) {
      errors.push(err('V14-METADATA-TYPE', '"metadata" must be a mapping.', 'metadata'));
    } else {
      const serialised = JSON.stringify(metadataRaw) ?? '';
      if (serialised.length > SKILL_V14_METADATA_MAX_CHARS) {
        errors.push(
          err(
            'V14-METADATA-TOO-LONG',
            `"metadata" serialises to ${serialised.length} chars — the v14 cap is ${SKILL_V14_METADATA_MAX_CHARS} (it is copied into the index).`,
            'metadata',
          ),
        );
      }
    }
  }

  // --- allowed-tools (optional list of lowercase tool names, no dupes). ---
  const allowedRaw = raw['allowed-tools'];
  if (allowedRaw !== undefined && allowedRaw !== null) {
    const list = asStringListValue(allowedRaw);
    if (list === undefined) {
      errors.push(err('V14-ALLOWED-TOOLS-TYPE', '"allowed-tools" must be a list of tool-name strings.', 'allowed-tools'));
    } else {
      const seen = new Set<string>();
      for (const tool of list) {
        if (!SKILL_V14_TOOL_NAME_RE.test(tool)) {
          errors.push(
            err(
              'V14-ALLOWED-TOOLS-SHAPE',
              `Illegal "allowed-tools" entry ${JSON.stringify(tool)} — use a lowercase tool name ([a-z0-9][a-z0-9_-]*).`,
              'allowed-tools',
            ),
          );
        } else if (seen.has(tool)) {
          errors.push(
            err('V14-ALLOWED-TOOLS-DUPLICATE', `Duplicate "allowed-tools" entry ${JSON.stringify(tool)}.`, 'allowed-tools'),
          );
        } else {
          seen.add(tool);
          if (opts.knownTools !== undefined && !opts.knownTools.includes(tool)) {
            warnings.push(
              warn(
                'V14-ALLOWED-TOOLS-UNKNOWN',
                `"allowed-tools" names ${JSON.stringify(tool)}, which this host does not know — kept as a warning because the skill may target tools from another host.`,
                'allowed-tools',
              ),
            );
          }
        }
      }
    }
  }

  const frontmatter: SkillV14Frontmatter | undefined =
    errors.length === 0 || name !== ''
      ? {
          name,
          description,
          license: asStringValue(licenseRaw),
          compatibility:
            typeof compatibilityRaw === 'string'
              ? compatibilityRaw
              : (asStringListValue(compatibilityRaw) ?? undefined),
          metadata:
            metadataRaw !== undefined && metadataRaw !== null && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)
              ? (metadataRaw as Record<string, unknown>)
              : undefined,
          allowedTools: asStringListValue(allowedRaw),
        }
      : undefined;

  return finishValidation(dirName, frontmatter, errors, warnings, undefined);
}

function finishValidation(
  dirName: string,
  frontmatter: SkillV14Frontmatter | undefined,
  errors: SkillV14Finding[],
  warnings: SkillV14Finding[],
  bodyTokens: number | undefined,
): SkillV14Validation {
  const qualityScore = Math.max(0, 100 - errors.length * 15 - warnings.length * 3);
  const headerText = frontmatter ? `${frontmatter.name}\n${frontmatter.description}` : '';
  return {
    dirName,
    frontmatter,
    valid: errors.length === 0,
    errors,
    warnings,
    qualityScore,
    headerTokens: estimateTokensV14(headerText),
    bodyTokens,
  };
}

/**
 * Validate full `SKILL.md` text (frontmatter + body) for the skill in
 * directory `dirName` (pass `''` when there is no directory).
 */
export function validateSkillTextV14(
  text: string,
  dirName = '',
  opts: ValidateSkillV14Options = {},
): SkillV14Validation {
  const split = splitSkillTextV14(text);
  if (split === null) {
    const errors = [
      err('V14-NO-FRONTMATTER', 'Skill must start with a YAML frontmatter block delimited by "---" lines.', undefined, SKILL_V14_FILE_NAME),
    ];
    return finishValidation(dirName, undefined, errors, [], undefined);
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseFrontmatterRawV14(split.frontmatterBlock, SKILL_V14_FILE_NAME);
  } catch (e) {
    const errors = [err('V14-FRONTMATTER-YAML', (e as Error).message, undefined, SKILL_V14_FILE_NAME)];
    return finishValidation(dirName, undefined, errors, [], undefined);
  }
  const result = validateFrontmatterObjectV14(raw, dirName, opts);

  // --- Body checks. ---
  const body = split.body;
  if (body.trim() === '') {
    result.errors.push(err('V14-BODY-EMPTY', 'Skill body is empty — SKILL.md needs instructions after the frontmatter.', undefined, SKILL_V14_FILE_NAME));
  } else {
    if (body.length > SKILL_V14_BODY_MAX_CHARS) {
      result.errors.push(
        err(
          'V14-BODY-TOO-LONG',
          `Skill body is ${body.length} chars — the v14 hard cap is ${SKILL_V14_BODY_MAX_CHARS} (move detail into references/).`,
          undefined,
          SKILL_V14_FILE_NAME,
        ),
      );
    } else if (body.split(/\r?\n/).length > SKILL_V14_BODY_GUIDANCE_LINES || body.length > SKILL_V14_BODY_GUIDANCE_CHARS) {
      result.warnings.push(
        warn(
          'V14-BODY-LONG',
          `Skill body is long (${body.split(/\r?\n/).length} lines, ${body.length} chars) — past the spec guidance of ${SKILL_V14_BODY_GUIDANCE_LINES} lines / ${SKILL_V14_BODY_GUIDANCE_CHARS} chars; move detail into references/ and keep the body lean.`,
          undefined,
          SKILL_V14_FILE_NAME,
        ),
      );
    }
  }
  const fixed: SkillV14Validation = {
    ...result,
    valid: result.errors.length === 0,
    qualityScore: Math.max(0, 100 - result.errors.length * 15 - result.warnings.length * 3),
    bodyTokens: estimateTokensV14(body),
  };
  return fixed;
}

/** Validate a `SKILL.md` file on disk (does not scan `scripts/`). */
export function validateSkillFileV14(filePath: string, opts: ValidateSkillV14Options = {}): SkillV14Validation {
  const dirName = path.basename(path.dirname(filePath));
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    const errors = [err('V14-FILE-UNREADABLE', `Cannot read skill file ${JSON.stringify(filePath)}.`, undefined, SKILL_V14_FILE_NAME)];
    return finishValidation(dirName, undefined, errors, [], undefined);
  }
  return validateSkillTextV14(text, dirName, opts);
}

// --- Script security scan ---------------------------------------------------

interface ScriptPattern {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  re: RegExp;
}

/** Destructive / escaping patterns: errors. Everything else: warnings. */
const SCRIPT_ERROR_PATTERNS: ScriptPattern[] = [
  {
    code: 'V14-SCRIPT-RM-RF',
    severity: 'error',
    message: 'Destructive recursive delete (rm -rf) — a skill script must never delete recursively.',
    re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)(?:\s|$)/,
  },
  {
    code: 'V14-SCRIPT-SUDO',
    severity: 'error',
    message: 'Privilege escalation (sudo/su) — skill scripts run unprivileged.',
    re: /\b(sudo|su)\b/,
  },
  {
    code: 'V14-SCRIPT-PIPE-SHELL',
    severity: 'error',
    message: 'Download piped straight into a shell (curl/wget | sh/bash) — classic remote-code-execution vector.',
    re: /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash|zsh)\b/,
  },
  {
    code: 'V14-SCRIPT-EVAL',
    severity: 'error',
    message: 'Dynamic code execution (eval) — the executed text is not reviewable statically.',
    re: /\beval\b/,
  },
  {
    code: 'V14-SCRIPT-BASE64-EXEC',
    severity: 'error',
    message: 'Base64-decoded content executed (decode | shell) — hides what actually runs.',
    re: /base64\s+(?:-d|--decode)\b[^|\n]*\|\s*(sh|bash|zsh)\b/,
  },
  {
    code: 'V14-SCRIPT-REVERSE-SHELL',
    severity: 'error',
    message: 'Reverse-shell pattern (netcat with -e, or /dev/tcp) — network shell back to a remote host.',
    re: /(\bnc\b[^|\n]*-e\b|\/dev\/tcp\/)/,
  },
  {
    code: 'V14-SCRIPT-DD-DEV',
    severity: 'error',
    message: 'Raw device write (dd to /dev/…) — can destroy the host disk.',
    re: /\bdd\b[^|\n]*\bof=\/dev\//,
  },
  {
    code: 'V14-SCRIPT-CHMOD-777',
    severity: 'error',
    message: 'chmod 777 — makes files world-writable; use the narrowest mode that works.',
    re: /\bchmod\b[^|\n]*\b777\b/,
  },
  {
    code: 'V14-SCRIPT-PATH-ESCAPE',
    severity: 'error',
    message: 'Path escapes the skill directory ("..") — scripts may only touch files inside their own skill.',
    re: /\.\.(?:\/|\\)/,
  },
  {
    code: 'V14-SCRIPT-ETC-WRITE',
    severity: 'error',
    message: 'Write into /etc or another system directory — outside the skill scope.',
    re: /(?:>|>>)\s*\/etc\//,
  },
];

const SCRIPT_WARNING_PATTERNS: ScriptPattern[] = [
  {
    code: 'V14-SCRIPT-NETWORK',
    severity: 'warning',
    message: 'Network fetch (curl/wget) — review the URL before running; the skill should work offline when possible.',
    re: /\b(curl|wget)\b/,
  },
  {
    code: 'V14-SCRIPT-INSTALL',
    severity: 'warning',
    message: 'Package install (pip/npm/gem/apt) — installs outside the skill directory; pin versions and prefer a venv.',
    re: /\b(pip3? install|npm install|npm i\b|gem install|apt(-get)? install|brew install)\b/,
  },
  {
    code: 'V14-SCRIPT-SSH',
    severity: 'warning',
    message: 'Remote shell/file copy (ssh/scp) — touches another machine; confirm the target first.',
    re: /\b(ssh|scp|sftp)\b/,
  },
  {
    code: 'V14-SCRIPT-CHMOD-X',
    severity: 'warning',
    message: 'chmod +x — makes a file executable; check the file is meant to run.',
    re: /\bchmod\b[^|\n]*\+x\b/,
  },
  {
    code: 'V14-SCRIPT-ABSOLUTE-WRITE',
    severity: 'warning',
    message: 'Write to an absolute path outside the skill directory — keep outputs inside the skill or the working directory.',
    re: /(?:>|>>)\s*\/(?:home|Users|root|var|opt|usr|private)\//,
  },
  {
    code: 'V14-SCRIPT-SECRET-USE',
    severity: 'warning',
    message: 'Reads or exports a credential-looking variable — never print it, and never send it to the network.',
    re: /\b(export\s+)?[A-Z0-9_]*(API_KEY|API_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\b/,
  },
  {
    code: 'V14-SCRIPT-RM',
    severity: 'warning',
    message: 'Plain rm — deleting files is outside a skill script’s usual job; confirm the target first.',
    re: /\brm\b/,
  },
  {
    code: 'V14-SCRIPT-FORK-BOMB',
    severity: 'warning',
    message: 'Shell function self-replication pattern — possible fork bomb.',
    re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/,
  },
];

function listScriptFiles(scriptsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(scriptsDir);
  return out.sort();
}

/**
 * Scan every file under `<skillDir>/scripts/` for dangerous commands,
 * directory escapes and out-of-scope writes. Returns findings only
 * (no file contents are echoed back — messages name the pattern, not
 * the secret or URL involved).
 */
export function scanSkillScriptsV14(skillDir: string): SkillV14Finding[] {
  const findings: SkillV14Finding[] = [];
  const scriptsDir = path.join(skillDir, 'scripts');
  if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) return findings;
  for (const file of listScriptFiles(scriptsDir)) {
    const rel = path.relative(skillDir, file).split(path.sep).join('/');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > SKILL_V14_MAX_SCRIPT_BYTES) {
      findings.push(
        warn(
          'V14-SCRIPT-TOO-BIG',
          `Script is ${stat.size} bytes (scan cap ${SKILL_V14_MAX_SCRIPT_BYTES}) — review it by hand before running.`,
          undefined,
          rel,
        ),
      );
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      findings.push(warn('V14-SCRIPT-UNREADABLE', 'Script could not be read — review it by hand before running.', undefined, rel));
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      for (const pattern of [...SCRIPT_ERROR_PATTERNS, ...SCRIPT_WARNING_PATTERNS]) {
        if (pattern.re.test(line)) {
          findings.push({
            code: pattern.code,
            severity: pattern.severity,
            message: pattern.message,
            file: rel,
            line: i + 1,
          });
          break;
        }
      }
    }
  }
  return findings;
}

/**
 * Full directory validation: `SKILL.md` frontmatter + body, plus the
 * `scripts/` security scan (unless `opts.skipScriptScan`).
 */
export function validateSkillDirV14(
  skillDir: string,
  opts: ValidateSkillV14Options = {},
): SkillV14Validation {
  const dirName = path.basename(path.resolve(skillDir));
  const skillFile = path.join(skillDir, SKILL_V14_FILE_NAME);
  if (!fs.existsSync(skillFile)) {
    const errors = [
      err('V14-NO-SKILL-FILE', `Skill directory ${JSON.stringify(skillDir)} holds no ${SKILL_V14_FILE_NAME}.`, undefined, SKILL_V14_FILE_NAME),
    ];
    return finishValidation(dirName, undefined, errors, [], undefined);
  }
  const result = validateSkillFileV14(skillFile, opts);
  if (!opts.skipScriptScan) {
    const scriptFindings = scanSkillScriptsV14(skillDir);
    for (const finding of scriptFindings) {
      if (finding.severity === 'error') result.errors.push(finding);
      else result.warnings.push(finding);
    }
    result.valid = result.errors.length === 0;
    result.qualityScore = Math.max(0, 100 - result.errors.length * 15 - result.warnings.length * 3);
  }
  return result;
}

/** One-line-per-finding human summary of a validation result. */
export function formatValidationSummaryV14(result: SkillV14Validation): string {
  const lines: string[] = [];
  const displayName = result.frontmatter?.name ?? (result.dirName !== '' ? result.dirName : '(unknown skill)');
  lines.push(
    `Skill ${JSON.stringify(displayName)}: ${result.valid ? 'valid' : 'INVALID'} — ` +
      `${result.errors.length} error(s), ${result.warnings.length} warning(s), ` +
      `quality ${result.qualityScore}/100, header ~${result.headerTokens} tokens` +
      (result.bodyTokens !== undefined ? `, body ~${result.bodyTokens} tokens` : '') +
      '.',
  );
  for (const finding of [...result.errors, ...result.warnings]) {
    const where = [finding.file, finding.line !== undefined ? `line ${finding.line}` : '']
      .filter(Boolean)
      .join(': ');
    lines.push(`  [${finding.severity.toUpperCase()}] ${finding.code}${where ? ` (${where})` : ''}: ${finding.message}`);
  }
  return lines.join('\n');
}
