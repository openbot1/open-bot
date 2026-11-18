/**
 * Agent Skills v15 — platform-aware validator (v1.36, Team T2).
 *
 * Runs the strict v14 validation unchanged, then adds the v15 layer
 * the survey calls for:
 *
 * - `compatibility` is parsed into structured verdicts (see
 *   platforms.ts). A requested target platform that the skill
 *   explicitly does NOT support is an error; a skill with no
 *   compatibility at all gets a warning (portability unconfirmed);
 *   a skill that only declares other platforms gets a warning per
 *   undeclared target.
 * - `allowed-tools` is experimental in the AAIF spec: entries are
 *   re-checked here for shape (lowercase/digits/`_`/`-`), duplicates
 *   and empties, and every skill that uses it carries a warning that
 *   some hosts ignore the field entirely — an allowlist is not a
 *   sandbox, and a host that ignores it runs every tool.
 * - Body references to `scripts/<file>` / `references/<file>` must
 *   resolve to files that exist in the skill directory (a dangling
 *   reference breaks tier-3 execution on every host).
 * - Compatibility entries naming a real host open-bot does not mirror
 *   to yet (Cursor, VS Code, Windsurf, Zed, Goose, Cline…) are
 *   warnings, not errors: the skill is valid, it just cannot be
 *   exported to that host by v15.
 *
 * Scoring: start from the v14 quality score, −10 per v15 error, −3
 * per v15 warning, floored at 0. The v14 findings are NOT duplicated
 * here — `base` carries them, `findings` carries only the v15 layer.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SKILL_V14_FILE_NAME,
  SKILL_V14_TOOL_NAME_RE,
} from '../v14/types.js';
import {
  estimateTokensV14,
  formatValidationSummaryV14,
  splitSkillTextV14,
  validateSkillDirV14,
  validateSkillTextV14,
} from '../v14/validator.js';
import type { SkillV14Validation } from '../v14/types.js';
import { SKILL_V15_PLATFORMS } from './types.js';
import type {
  SkillV15Compatibility,
  SkillV15Finding,
  SkillV15PlatformCheck,
  SkillV15PlatformId,
  SkillV15PlatformValidation,
  ValidateForPlatformsV15Options,
} from './types.js';
import {
  checkCompatibilityV15,
  isPortableV15,
  parseCompatibilityV15,
} from './platforms.js';

/** Host names the spec world knows but v15 does not mirror to yet. */
export const SKILL_V15_UNMIRRORED_HOSTS = [
  'cursor',
  'vscode',
  'vs code',
  'windsurf',
  'zed',
  'goose',
  'cline',
  'aider',
  'continue',
  'jetbrains',
] as const;

/** `scripts/<path>` / `references/<path>` mentions inside a skill body. */
const SCRIPT_REF_RE = /\b(?:scripts|references)\/[A-Za-z0-9._][A-Za-z0-9._/-]*/g;

function scoreAfterFindings(baseScore: number, findings: SkillV15Finding[]): number {
  let score = baseScore;
  for (const finding of findings) {
    score -= finding.severity === 'error' ? 10 : 3;
  }
  return Math.max(0, score);
}

function checkAllowedToolsV15(
  allowedTools: string[] | undefined,
  findings: SkillV15Finding[],
): void {
  if (allowedTools === undefined) return;
  // The field is experimental per the spec — say so once, plainly.
  findings.push({
    code: 'V15-ALLOWED-TOOLS-EXPERIMENTAL',
    severity: 'warning',
    message:
      'allowed-tools is experimental in the Agent Skills spec: some hosts ignore it entirely, ' +
      'so it is an allowlist hint, not a sandbox — never rely on it to block a dangerous tool.',
    field: 'allowed-tools',
  });
  if (allowedTools.length === 0) {
    findings.push({
      code: 'V15-ALLOWED-TOOLS-EMPTY',
      severity: 'error',
      message: 'allowed-tools is present but empty — remove the field or list at least one tool.',
      field: 'allowed-tools',
    });
    return;
  }
  const seen = new Set<string>();
  for (const tool of allowedTools) {
    if (typeof tool !== 'string' || tool.trim() === '') {
      findings.push({
        code: 'V15-ALLOWED-TOOLS-EMPTY-ENTRY',
        severity: 'error',
        message: 'allowed-tools holds an empty entry.',
        field: 'allowed-tools',
      });
      continue;
    }
    if (!SKILL_V14_TOOL_NAME_RE.test(tool)) {
      findings.push({
        code: 'V15-ALLOWED-TOOLS-BAD-NAME',
        severity: 'error',
        message: `allowed-tools entry ${JSON.stringify(tool)} is not a valid tool name (lowercase letters, digits, "-" and "_" only).`,
        field: 'allowed-tools',
      });
    }
    if (seen.has(tool)) {
      findings.push({
        code: 'V15-ALLOWED-TOOLS-DUPLICATE',
        severity: 'warning',
        message: `allowed-tools lists ${JSON.stringify(tool)} more than once.`,
        field: 'allowed-tools',
      });
    }
    seen.add(tool);
  }
}

function checkScriptRefsV15(skillDir: string, body: string, findings: SkillV15Finding[]): void {
  const refs = new Set<string>(body.match(SCRIPT_REF_RE) ?? []);
  for (const ref of refs) {
    const full = path.join(skillDir, ...ref.split('/'));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      findings.push({
        code: 'V15-SCRIPT-REF-MISSING',
        severity: 'error',
        message: `Skill body references ${JSON.stringify(ref)} but that file does not exist in the skill directory.`,
        file: ref,
      });
    }
  }
}

function checkUnmirroredHostsV15(compatibility: SkillV15Compatibility, findings: SkillV15Finding[]): void {
  for (const requirement of compatibility.requirements) {
    const lower = requirement.toLowerCase();
    for (const host of SKILL_V15_UNMIRRORED_HOSTS) {
      if (lower.includes(host)) {
        findings.push({
          code: 'V15-COMPAT-UNMIRRORED-HOST',
          severity: 'warning',
          message:
            `Compatibility mentions ${JSON.stringify(host)}, a host v15 does not mirror to yet — ` +
            `the skill stays valid, but open-bot cannot export it to ${host}.`,
          field: 'compatibility',
        });
        break;
      }
    }
  }
}

/**
 * Validate one skill directory for the given target platforms.
 * `platforms` defaults to all five — pass a subset to check only the
 * hosts you actually export to. Throws only when the directory holds
 * no readable SKILL.md at all (same as v14); every other problem is
 * reported as a finding.
 */
export function validateSkillForPlatformsV15(
  skillDir: string,
  platforms: readonly SkillV15PlatformId[] = SKILL_V15_PLATFORMS,
  opts: ValidateForPlatformsV15Options = {},
): SkillV15PlatformValidation {
  const base: SkillV14Validation = validateSkillDirV14(skillDir, {
    knownTools: opts.knownTools,
    skipScriptScan: opts.skipScriptScan,
  });
  return finishValidationV15(base, skillDir, platforms, opts);
}

/** Validate SKILL.md text (no directory) for the given target platforms. */
export function validateSkillTextForPlatformsV15(
  text: string,
  dirName: string,
  platforms: readonly SkillV15PlatformId[] = SKILL_V15_PLATFORMS,
  opts: ValidateForPlatformsV15Options = {},
): SkillV15PlatformValidation {
  const base: SkillV14Validation = validateSkillTextV14(text, dirName, {
    knownTools: opts.knownTools,
    skipScriptScan: opts.skipScriptScan,
  });
  return finishValidationV15(base, null, platforms, opts, text);
}

function finishValidationV15(
  base: SkillV14Validation,
  skillDir: string | null,
  platforms: readonly SkillV15PlatformId[],
  opts: ValidateForPlatformsV15Options,
  text?: string,
): SkillV15PlatformValidation {
  const findings: SkillV15Finding[] = [];
  const compatibility = parseCompatibilityV15(base.frontmatter?.compatibility);
  const checks: SkillV15PlatformCheck[] = platforms.map((platform) =>
    checkCompatibilityV15(base.dirName, compatibility, platform),
  );

  // --- Compatibility findings ---------------------------------------------
  if (compatibility.unknown) {
    findings.push({
      code: 'V15-COMPAT-UNKNOWN',
      severity: 'warning',
      message:
        'Skill states no compatibility — portability is unconfirmed on every platform. ' +
        'Add a compatibility frontmatter line (e.g. "claude; opencode") to declare where it runs.',
      field: 'compatibility',
    });
  }
  for (const check of checks) {
    if (check.verdict === 'unsupported') {
      findings.push({
        code: 'V15-PLATFORM-UNSUPPORTED',
        severity: 'error',
        message: check.reason,
        field: 'compatibility',
        platform: check.platform,
      });
    }
    // NOTE: an `unknown` verdict (platform simply not declared) is NOT
    // a warning — the check itself reports it, and a skill that runs
    // on two hosts is not "worse" than one that runs on five. Only
    // an explicit refusal is an error.
  }
  checkUnmirroredHostsV15(compatibility, findings);

  // --- allowed-tools (experimental) ---------------------------------------
  checkAllowedToolsV15(base.frontmatter?.allowedTools, findings);

  // --- Dangling tier-3 references ------------------------------------------
  const checkRefs = opts.checkScriptRefs !== false;
  if (checkRefs) {
    const body = skillDir !== null ? readBodyV15(skillDir) : splitBodyV15(text ?? '');
    if (body !== null && skillDir !== null) checkScriptRefsV15(skillDir, body, findings);
  }

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const valid = base.valid && errors.length === 0;
  return {
    dirName: base.dirName,
    base,
    compatibility,
    checks,
    findings,
    valid,
    errors,
    warnings,
    qualityScore: scoreAfterFindings(base.qualityScore, findings),
  };
}

function readBodyV15(skillDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(skillDir, SKILL_V14_FILE_NAME), 'utf8');
    return splitBodyV15(text);
  } catch {
    return null;
  }
}

function splitBodyV15(text: string): string | null {
  const split = splitSkillTextV14(text);
  return split === null ? null : split.body;
}

/**
 * Errors that block a skill on EVERY platform: the strict v14 errors
 * plus the v15 errors that carry no `platform` (dangling script
 * reference, malformed `allowed-tools`, …). A `V15-PLATFORM-UNSUPPORTED`
 * error carries a platform — it blocks only that platform, never the
 * skill as a whole — so it is deliberately excluded here. Callers
 * that need a single "is this skill usable at all?" verdict (the
 * audit, the export planner) use this; per-platform verdicts live in
 * `checks`.
 */
export function blockingErrorsV15(result: SkillV15PlatformValidation): SkillV15Finding[] {
  return [...result.base.errors, ...result.errors.filter((f) => f.platform === undefined)];
}

/**
 * Is a skill portable — supported on every one of the five platforms?
 * Convenience wrapper over the compatibility parse (see platforms.ts).
 */
export function isSkillPortableV15(compatibility: SkillV15Compatibility): boolean {
  return isPortableV15(compatibility);
}

/** Rough token estimate for a skill body (same 1 token ≈ 4 chars rule as v14). */
export function estimateBodyTokensV15(body: string): number {
  return estimateTokensV14(body);
}

/** One-line-per-finding summary of a v15 platform validation. */
export function formatPlatformValidationSummaryV15(result: SkillV15PlatformValidation): string {
  const lines: string[] = [formatValidationSummaryV14(result.base)];
  lines.push(
    `v15: compatibility ${result.compatibility.unknown ? 'not stated' : `supports ${result.compatibility.supported.join(', ') || '—'}; refuses ${result.compatibility.unsupported.join(', ') || '—'}`}, quality ${result.qualityScore}/100.`,
  );
  for (const check of result.checks) {
    lines.push(`  - ${check.platform}: ${check.verdict} — ${check.reason}`);
  }
  for (const finding of result.findings) {
    lines.push(`  - [v15 ${finding.severity}] ${finding.code}: ${finding.message}`);
  }
  return lines.join('\n');
}
