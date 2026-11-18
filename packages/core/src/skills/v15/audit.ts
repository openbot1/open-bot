/**
 * Agent Skills v15 — project-wide skill audit (v1.36, Team T2).
 *
 * One command to answer "is this project ready to ship its skills to
 * every host?": the audit walks every installed skill (canonical +
 * mirrors), runs the strict v14 validation plus the v15 platform
 * validation on each, checks its install state on all five platforms,
 * and rolls everything up into one report:
 *
 * - Per skill: valid/invalid, quality score, error + warning counts,
 *   structured compatibility, installed/missing/stale platforms,
 *   header tokens.
 * - Totals: how many skills, how many valid, average quality, how
 *   many portable (all five platforms), how many state no
 *   compatibility at all, total tier-1 header tokens (the
 *   session-start cost of the whole skill set).
 * - Export readiness per platform: a skill is `ready` for a platform
 *   when it is valid AND declares support for it; `blocked` when it
 *   is invalid or explicitly refuses that platform; `unverified`
 *   when it is valid but says nothing about the platform (exporting
 *   it is allowed, but nobody promised it works there).
 * - Findings rollup: the most common error/warning codes across all
 *   skills, so one fix (e.g. adding `compatibility` everywhere)
 *   shows up as a single line instead of thirty.
 *
 * The audit never writes anything: it reads skills, validates them
 * and reports. A skill that fails validation is listed, not hidden
 * — the report names every broken skill and its first error.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_V15_PLATFORMS } from './types.js';
import type {
  SkillV15Compatibility,
  SkillV15PlatformId,
} from './types.js';
import { multiPlatformStatusV15 } from './multiPlatform.js';
import { SkillV15Registry } from './registry.js';
import { blockingErrorsV15, validateSkillForPlatformsV15 } from './validator.js';
import { checkCompatibilityV15 } from './platforms.js';

/** Export readiness of one skill for one platform. */
export type SkillV15Readiness = 'ready' | 'blocked' | 'unverified';

/** One audited skill (canonical entry + validation + install state). */
export interface SkillV15AuditSkill {
  name: string;
  dir: string;
  source: string;
  valid: boolean;
  qualityScore: number;
  errorCount: number;
  warningCount: number;
  /** First error message ('' when valid) — the report names it. */
  firstError: string;
  compatibility: SkillV15Compatibility;
  installedOn: SkillV15PlatformId[];
  missingOn: SkillV15PlatformId[];
  staleOn: SkillV15PlatformId[];
  headerTokens: number;
  /** Readiness per platform, in SKILL_V15_PLATFORMS order. */
  readiness: Record<SkillV15PlatformId, SkillV15Readiness>;
}

/** How often one finding code appears across the audited skills. */
export interface SkillV15AuditFindingCount {
  code: string;
  count: number;
  /** Names of the skills carrying this finding (at most 5, then `…`). */
  skills: string[];
}

/** Per-platform rollup of the audit. */
export interface SkillV15AuditPlatform {
  platform: SkillV15PlatformId;
  /** Skills valid + declaring support for this platform. */
  ready: number;
  /** Skills invalid or explicitly refusing this platform. */
  blocked: number;
  /** Skills valid but silent about this platform. */
  unverified: number;
  /** Skills installed (copy/symlink) on this platform. */
  installed: number;
  /** Skills missing on this platform. */
  missing: number;
}

/** Whole-project audit report. */
export interface SkillV15AuditReport {
  projectRoot: string;
  auditedAt: string;
  skills: SkillV15AuditSkill[];
  total: number;
  valid: number;
  invalid: number;
  /** Mean quality score across all skills (0 when there are none). */
  averageQuality: number;
  portable: number;
  unknownCompatibility: number;
  /** Total tier-1 header tokens of all enabled skills. */
  totalHeaderTokens: number;
  platforms: SkillV15AuditPlatform[];
  /** Most common finding codes, most frequent first. */
  topFindings: SkillV15AuditFindingCount[];
}

export interface AuditProjectSkillsV15Options {
  /** Project root to audit. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Home directory for the global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Audit the global roots instead of the project-local ones. */
  global?: boolean;
  /** Skip the global roots (project-only audit). */
  projectOnly?: boolean;
  /** Platforms to validate each skill for. Default: all five. */
  platforms?: SkillV15PlatformId[];
}

/** Readiness of one skill for one platform (see the module header). */
export function exportReadinessV15(
  valid: boolean,
  compatibility: SkillV15Compatibility,
  platform: SkillV15PlatformId,
): SkillV15Readiness {
  if (!valid) return 'blocked';
  const check = checkCompatibilityV15('', compatibility, platform);
  if (check.verdict === 'supported') return 'ready';
  if (check.verdict === 'unsupported') return 'blocked';
  return 'unverified';
}

/** Audit every installed skill of a project (canonical + mirrors). */
export function auditProjectSkillsV15(opts: AuditProjectSkillsV15Options = {}): SkillV15AuditReport {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const auditedAt = new Date().toISOString();
  const platforms = opts.platforms ?? [...SKILL_V15_PLATFORMS];

  const registry = new SkillV15Registry({ projectRoot, homeDir, projectOnly: opts.projectOnly ?? false });
  const entries = registry.refresh();

  const skills: SkillV15AuditSkill[] = [];
  const findingCounts = new Map<string, { count: number; skills: string[] }>();
  const noteFinding = (code: string, skillName: string): void => {
    const slot = findingCounts.get(code) ?? { count: 0, skills: [] };
    slot.count += 1;
    if (slot.skills.length < 5 && !slot.skills.includes(skillName)) slot.skills.push(skillName);
    findingCounts.set(code, slot);
  };

  for (const entry of entries) {
    // Validate the canonical-or-found directory the registry points at.
    // A skill that cannot be validated at all (unreadable SKILL.md) is
    // reported as invalid with quality 0, not skipped silently.
    let valid = false;
    let qualityScore = 0;
    let errorCount = 0;
    let warningCount = 0;
    let firstError = '';
    let compatibility: SkillV15Compatibility = entry.compatibility;
    try {
      const validation = validateSkillForPlatformsV15(entry.dir, platforms);
      // A platform-specific refusal does NOT make the skill invalid —
      // it is captured in `readiness` instead. Only errors that break
      // the skill everywhere (strict errors, dangling script refs…)
      // count against `valid` here.
      const blocking = blockingErrorsV15(validation);
      valid = blocking.length === 0;
      qualityScore = validation.qualityScore;
      compatibility = validation.compatibility;
      errorCount = validation.errors.length + validation.base.errors.length;
      warningCount = validation.warnings.length + validation.base.warnings.length;
      const first = blocking[0] ?? validation.errors[0] ?? validation.base.errors[0];
      firstError = first ? `${first.code}: ${first.message}` : '';
      for (const finding of [...validation.errors, ...validation.base.errors]) noteFinding(finding.code, entry.name);
      for (const finding of [...validation.warnings, ...validation.base.warnings]) noteFinding(finding.code, entry.name);
    } catch (e) {
      firstError = (e as Error).message;
      errorCount = 1;
      noteFinding('V15-AUDIT-UNREADABLE', entry.name);
    }
    const status = multiPlatformStatusV15(entry.name, { projectRoot, homeDir, global: opts.global ?? false });
    const readiness = {} as Record<SkillV15PlatformId, SkillV15Readiness>;
    for (const platform of SKILL_V15_PLATFORMS) {
      readiness[platform] = exportReadinessV15(valid, compatibility, platform);
    }
    skills.push({
      name: entry.name,
      dir: entry.dir,
      source: entry.source,
      valid,
      qualityScore,
      errorCount,
      warningCount,
      firstError,
      compatibility,
      installedOn: status.installedOn,
      missingOn: status.missingOn,
      staleOn: status.staleOn,
      headerTokens: entry.headerTokens,
      readiness,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  const total = skills.length;
  const validCount = skills.filter((s) => s.valid).length;
  const averageQuality =
    total === 0 ? 0 : Math.round((skills.reduce((sum, s) => sum + s.qualityScore, 0) / total) * 10) / 10;
  const portable = skills.filter((s) => {
    if (s.compatibility.unknown) return false;
    return SKILL_V15_PLATFORMS.every((p) => s.compatibility.supported.includes(p));
  }).length;
  const unknownCompatibility = skills.filter((s) => s.compatibility.unknown).length;
  const totalHeaderTokens = skills.reduce((sum, s) => sum + s.headerTokens, 0);

  const platformReports: SkillV15AuditPlatform[] = SKILL_V15_PLATFORMS.map((platform) => {
    let ready = 0;
    let blocked = 0;
    let unverified = 0;
    let installed = 0;
    let missing = 0;
    for (const skill of skills) {
      if (skill.readiness[platform] === 'ready') ready += 1;
      else if (skill.readiness[platform] === 'blocked') blocked += 1;
      else unverified += 1;
      if (skill.installedOn.includes(platform)) installed += 1;
      if (skill.missingOn.includes(platform)) missing += 1;
    }
    return { platform, ready, blocked, unverified, installed, missing };
  });

  const topFindings: SkillV15AuditFindingCount[] = [...findingCounts.entries()]
    .map(([code, slot]) => ({ code, count: slot.count, skills: slot.skills }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 10);

  return {
    projectRoot,
    auditedAt,
    skills,
    total,
    valid: validCount,
    invalid: total - validCount,
    averageQuality,
    portable,
    unknownCompatibility,
    totalHeaderTokens,
    platforms: platformReports,
    topFindings,
  };
}

/** One-line summary of a skill's audit row (used by the formatter). */
export function formatAuditSkillLineV15(skill: SkillV15AuditSkill): string {
  const state = skill.valid ? `valid ${skill.qualityScore}/100` : `INVALID (${skill.firstError})`;
  const compat = skill.compatibility.unknown
    ? 'compatibility undeclared'
    : `runs on ${skill.compatibility.supported.join(', ') || '—'}`;
  const stale = skill.staleOn.length > 0 ? `; stale on ${skill.staleOn.join(', ')}` : '';
  return (
    `- ${skill.name} [${skill.source}]: ${state}, ${skill.errorCount} error(s), ${skill.warningCount} warning(s), ` +
    `${compat}, installed on ${skill.installedOn.join(', ') || 'none'}${stale} (~${skill.headerTokens} header tokens).`
  );
}

/** Full text report of an audit (tool output / logs). */
export function formatAuditReportV15(report: SkillV15AuditReport): string {
  const lines: string[] = [
    `Skills v15 audit of ${report.projectRoot} (${report.auditedAt}):`,
    `${report.total} skill(s): ${report.valid} valid, ${report.invalid} invalid, ` +
      `average quality ${report.averageQuality}/100, ${report.portable} portable (all 5 platforms), ` +
      `${report.unknownCompatibility} with undeclared compatibility, ` +
      `~${report.totalHeaderTokens} tier-1 header tokens in total.`,
    'Export readiness per platform (ready / blocked / unverified / installed / missing):',
  ];
  for (const platform of report.platforms) {
    lines.push(
      `- ${platform.platform}: ${platform.ready} ready, ${platform.blocked} blocked, ` +
        `${platform.unverified} unverified, ${platform.installed} installed, ${platform.missing} missing.`,
    );
  }
  for (const skill of report.skills) {
    lines.push(formatAuditSkillLineV15(skill));
  }
  if (report.topFindings.length > 0) {
    lines.push('Most common findings:');
    for (const finding of report.topFindings) {
      lines.push(`- ${finding.code}: ${finding.count} time(s) (e.g. ${finding.skills.join(', ')}).`);
    }
  }
  if (report.total === 0) {
    lines.push('No skills installed — nothing to audit.');
  }
  return lines.join('\n');
}

/** `true` when the audit found no invalid skill and no stale mirror. */
export function isAuditCleanV15(report: SkillV15AuditReport): boolean {
  if (report.invalid > 0) return false;
  return !report.skills.some((s) => s.staleOn.length > 0);
}

/** Where an audit report would be written (JSON, next to the registry). */
export function defaultAuditFileV15(projectRoot: string): string {
  return path.join(projectRoot, '.agents', 'skills-v15-audit.json');
}

/** Persist an audit report as JSON (creates `.agents/` when needed). */
export function saveAuditReportV15(report: SkillV15AuditReport): string {
  const target = defaultAuditFileV15(report.projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return target;
}
