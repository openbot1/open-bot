/**
 * Agent Skills v15 — dry-run export planner (v1.36, Team T2).
 *
 * Exporting a skill to five platforms touches up to five directories.
 * The planner answers "what WOULD happen?" before anything is
 * written, so a UI (or an agent) can show the plan and ask the user
 * once instead of failing halfway through:
 *
 * - Validates the skill strictly first — an invalid skill produces a
 *   plan with a single `blocked` step and no writes at all.
 * - For the canonical root and every requested mirror it reports
 *   what would happen: `create` (nothing there yet), `replace`
 *   (a mirror already exists — needs `overwrite`), `skip` (already
 *   there and identical), or `blocked` (the skill refuses that
 *   platform, or the existing install is a different skill of the
 *   same name that must never be overwritten).
 * - A drifted copy mirror is reported as `replace` with a warning:
 *   replacing it throws away the mirror's edits. The plan names the
 *   differing files so the user can decide.
 * - `applyExportPlanV15` executes a plan that was just computed
 *   (same inputs, no surprises): it calls the multi-platform
 *   exporter with the plan's mode + overwrite flags.
 *
 * A plan is a pure function of (skill dir, project root, platforms,
 * mode, overwrite): computing it twice gives the same steps, and
 * computing it never writes anything.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_V15_PLATFORMS } from './types.js';
import type {
  SkillV15MirrorMode,
  SkillV15PlatformId,
} from './types.js';
import { exportSkillMultiPlatformV15, listSkillFilesV15, multiPlatformStatusV15 } from './multiPlatform.js';
import { blockingErrorsV15, validateSkillForPlatformsV15 } from './validator.js';
import { platformRootV15 } from './platforms.js';

/** What would happen to one install target. */
export type SkillV15PlanAction = 'create' | 'replace' | 'skip' | 'blocked';

/** One step of an export plan. */
export interface SkillV15PlanStep {
  platform: SkillV15PlatformId;
  /** Absolute target directory (`<root>/<name>/`). */
  dir: string;
  action: SkillV15PlanAction;
  /** Why this action (human-readable, one line). */
  reason: string;
  /** Files that would be written (copies) — 0 for a symlink step. */
  fileCount: number;
  /** Warnings attached to this step (drift loss, undeclared platform…). */
  warnings: string[];
}

/** A whole export plan (dry run — nothing written). */
export interface SkillV15ExportPlan {
  skill: string;
  skillDir: string;
  canonicalDir: string;
  /** Project root the plan was computed for (needed to apply it). */
  projectRoot: string;
  /** Whether the plan targets the global roots. */
  global: boolean;
  mode: SkillV15MirrorMode;
  overwrite: boolean;
  steps: SkillV15PlanStep[];
  /** `true` when every step is `create` or `skip` (safe to apply). */
  applicable: boolean;
  /** `true` when the skill failed strict validation (no step applies). */
  blockedByValidation: boolean;
  validationQuality: number;
  /** Total files that would be written across all `create`/`replace` steps. */
  totalFiles: number;
}

export interface PlanMultiPlatformExportV15Options {
  /** Project root holding the skill roots. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Home directory for global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Global (home-dir) roots instead of project-local ones. */
  global?: boolean;
  /** Platforms to mirror to (default: all except canonical). */
  platforms?: SkillV15PlatformId[];
  /** `copy` (default) or `symlink`. */
  mode?: SkillV15MirrorMode;
  /** Allow replacing existing mirrors. Default: `false`. */
  overwrite?: boolean;
}

/**
 * Compute the export plan for one skill directory. Never writes.
 * Throws only when the skill directory does not exist at all.
 */
export function planMultiPlatformExportV15(
  skillDir: string,
  opts: PlanMultiPlatformExportV15Options = {},
): SkillV15ExportPlan {
  const resolved = path.resolve(skillDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot plan export for ${JSON.stringify(skillDir)} — not a directory.`);
  }
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const global = opts.global ?? false;
  const mode: SkillV15MirrorMode = opts.mode ?? 'copy';
  const overwrite = opts.overwrite ?? false;
  const name = path.basename(resolved);

  const validation = validateSkillForPlatformsV15(resolved);
  const canonicalRoot = platformRootV15('openbot', { projectRoot, homeDir, global });
  const canonicalDir = path.join(canonicalRoot, name);
  const files = listSkillFilesV15(resolved);
  const fileCount = mode === 'symlink' ? 0 : files.length;

  // A platform-specific refusal (V15-PLATFORM-UNSUPPORTED) does NOT
  // block the whole plan — it becomes a per-platform `blocked` step
  // below. Only errors that break the skill everywhere (strict v14
  // errors, dangling script refs, malformed allowed-tools) block.
  const blocking = blockingErrorsV15(validation);
  if (blocking.length > 0 || validation.base.frontmatter === undefined) {
    const first = blocking[0];
    const reason =
      `Blocked: skill is invalid — ` +
      (first ? `${first.code}: ${first.message}` : 'validation failed.');
    const steps: SkillV15PlanStep[] = [
      { platform: 'openbot', dir: canonicalDir, action: 'blocked', reason, fileCount: 0, warnings: [] },
    ];
    return {
      skill: name,
      skillDir: resolved,
      canonicalDir,
      projectRoot,
      global,
      mode,
      overwrite,
      steps,
      applicable: false,
      blockedByValidation: true,
      validationQuality: validation.qualityScore,
      totalFiles: 0,
    };
  }

  const skillName = validation.base.frontmatter.name;
  const status = multiPlatformStatusV15(skillName, { projectRoot, homeDir, global });
  const statusByPlatform = new Map(status.installs.map((i) => [i.platform, i]));
  const targets = ['openbot' as SkillV15PlatformId, ...(opts.platforms ?? SKILL_V15_PLATFORMS.filter((p) => p !== 'openbot'))];
  const steps: SkillV15PlanStep[] = [];

  for (const platform of targets) {
    const root = platformRootV15(platform, { projectRoot, homeDir, global });
    const dir = path.join(root, skillName);
    const install = statusByPlatform.get(platform);
    const warnings: string[] = [];
    const check = validation.checks.find((c) => c.platform === platform);
    if (check !== undefined && check.verdict === 'unsupported') {
      steps.push({
        platform,
        dir,
        action: 'blocked',
        reason: `Blocked: ${check.reason}`,
        fileCount: 0,
        warnings,
      });
      continue;
    }
    if (check !== undefined && check.verdict === 'unknown' && !validation.compatibility.unknown) {
      warnings.push(
        `Platform ${platform} is not declared in compatibility — exporting is allowed, but nothing promises the skill works there.`,
      );
    }
    // The canonical root is special: the exporter REFUSES to overwrite
    // an existing canonical skill without `overwrite` (it throws), so
    // the plan must block instead of skipping.
    if (platform === 'openbot') {
      if (path.resolve(resolved) === path.resolve(dir)) {
        steps.push({
          platform,
          dir,
          action: 'skip',
          reason: 'This directory already IS the canonical install.',
          fileCount: 0,
          warnings,
        });
        continue;
      }
      if (install === undefined || install.state === 'missing') {
        steps.push({ platform, dir, action: 'create', reason: 'Nothing installed here yet.', fileCount, warnings });
        continue;
      }
      steps.push({
        platform,
        dir,
        action: overwrite ? 'replace' : 'blocked',
        reason: overwrite
          ? 'Canonical skill already exists — would be replaced with this directory.'
          : 'Canonical skill already exists — pass overwrite=true to replace it (exporting without it throws).',
        fileCount,
        warnings,
      });
      continue;
    }
    if (install === undefined || install.state === 'missing') {
      steps.push({ platform, dir, action: 'create', reason: 'Nothing installed here yet.', fileCount, warnings });
      continue;
    }
    if (install.state === 'invalid') {
      steps.push({
        platform,
        dir,
        action: 'blocked',
        reason: `Blocked: ${install.detail} — a different skill (or file) of the same name is installed here by hand.`,
        fileCount: 0,
        warnings,
      });
      continue;
    }
    if (install.state === 'broken-link') {
      steps.push({
        platform,
        dir,
        action: overwrite ? 'replace' : 'blocked',
        reason: overwrite
          ? `Broken symlink (points at ${install.detail}) — would be re-linked.`
          : `Broken symlink (points at ${install.detail}) — pass overwrite=true to re-link it.`,
        fileCount,
        warnings,
      });
      continue;
    }
    if (install.state === 'stale-copy') {
      warnings.push(`Replacing this copy throws away its edits (differs in ${install.detail}).`);
      steps.push({
        platform,
        dir,
        action: overwrite ? 'replace' : 'blocked',
        reason: overwrite
          ? 'Copy drifted from canonical — would be replaced with the canonical files.'
          : 'Copy drifted from canonical — pass overwrite=true to replace it.',
        fileCount,
        warnings,
      });
      continue;
    }
    // copy / symlink, in sync with canonical. (The openbot case was
    // handled above — here platform is always one of the four mirrors.)
    if (install.state === 'symlink' && mode === 'symlink') {
      steps.push({
        platform,
        dir,
        action: 'skip',
        reason: 'Symlink mirror already points at the canonical skill.',
        fileCount: 0,
        warnings,
      });
      continue;
    }
    if (install.state === 'copy' && mode === 'copy') {
      steps.push({
        platform,
        dir,
        action: 'skip',
        reason: 'Copy mirror already matches the canonical skill.',
        fileCount: 0,
        warnings,
      });
      continue;
    }
    // Same content, different materialisation (copy vs symlink): a
    // replace only when overwrite was asked for.
    steps.push({
      platform,
      dir,
      action: overwrite ? 'replace' : 'blocked',
      reason: overwrite
        ? `Installed as ${install.state} but the plan asks for ${mode} — would be re-created as ${mode}.`
        : `Installed as ${install.state} but the plan asks for ${mode} — pass overwrite=true to re-create it.`,
      fileCount,
      warnings,
    });
  }

  const applicable = steps.every((s) => s.action === 'create' || s.action === 'skip' || s.action === 'replace');
  const totalFiles = steps
    .filter((s) => s.action === 'create' || s.action === 'replace')
    .reduce((sum, s) => sum + s.fileCount, 0);
  return {
    skill: skillName,
    skillDir: resolved,
    canonicalDir,
    projectRoot,
    global,
    mode,
    overwrite,
    steps,
    applicable,
    blockedByValidation: false,
    validationQuality: validation.qualityScore,
    totalFiles,
  };
}

/** `true` when a plan can be applied (no `blocked` step). */
export function isPlanApplicableV15(plan: SkillV15ExportPlan): boolean {
  return plan.applicable;
}

/** Apply a plan computed by `planMultiPlatformExportV15` (same inputs). */
export function applyExportPlanV15(plan: SkillV15ExportPlan): ReturnType<typeof exportSkillMultiPlatformV15> {
  if (!plan.applicable) {
    const blocked = plan.steps.filter((s) => s.action === 'blocked');
    throw new Error(
      `Cannot apply export plan for "${plan.skill}" — ${blocked.length} step(s) blocked:\n` +
        blocked.map((s) => `- ${s.platform}: ${s.reason}`).join('\n'),
    );
  }
  const platforms = plan.steps.filter((s) => s.platform !== 'openbot').map((s) => s.platform);
  return exportSkillMultiPlatformV15(plan.skillDir, {
    projectRoot: plan.projectRoot,
    global: plan.global,
    platforms,
    mode: plan.mode,
    overwrite: plan.overwrite,
  });
}

/** Format a plan as text (tool output / confirmation UI). */
export function formatExportPlanV15(plan: SkillV15ExportPlan): string {
  const lines = [
    `Export plan for "${plan.skill}" (${plan.mode}${plan.overwrite ? ', overwrite' : ''}, validation ${plan.validationQuality}/100):`,
  ];
  for (const step of plan.steps) {
    const files = step.fileCount > 0 ? ` (${step.fileCount} file(s))` : '';
    lines.push(`- ${step.platform}: ${step.action}${files} — ${step.reason}`);
    for (const warning of step.warnings) lines.push(`    ! ${warning}`);
  }
  lines.push(
    plan.applicable
      ? `Plan is applicable: ${plan.totalFiles} file(s) would be written.`
      : 'Plan is NOT applicable — resolve the blocked steps first (or re-plan with overwrite=true).',
  );
  return lines.join('\n');
}
