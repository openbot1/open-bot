/**
 * Agent Skills v15 — mirror drift detection + repair (v1.36, Team T2).
 *
 * Copy mirrors can drift: someone edits the canonical skill, or a
 * mirror, and the two stop matching. Symlink mirrors cannot drift
 * (they ARE the canonical dir) but their link can break when the
 * canonical dir moves. `checkMirrorSyncV15` reports the state of
 * every mirror of every canonical skill; `repairMirrorSyncV15`
 * re-copies drifted mirrors and re-links broken ones (copy mode
 * re-copies, symlink mode re-links — the caller chooses via
 * `mode`, default `copy`).
 *
 * Repair rules:
 * - Only mirrors are ever repaired. A drifted mirror is re-copied
 *   FROM the canonical dir — the canonical skill is the source of
 *   truth, a mirror edit is never copied back (that would silently
 *   overwrite the canonical skill with a host-specific edit).
 * - A missing mirror is recreated (same rule).
 * - A broken link is removed and recreated.
 * - `not-a-mirror` — a directory that is neither a copy of the
 *   canonical skill nor a link to it (e.g. a different skill of the
 *   same name installed by hand on one host, recognised because its
 *   SKILL.md states a different name/description) — is reported and
 *   NEVER repaired automatically: overwriting it would destroy a
 *   skill the user installed deliberately on that host.
 * - A skill with no canonical install is skipped (nothing to sync
 *   from) and reported as such in the summary line.
 *
 * Everything here is original open-bot code.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_V14_FILE_NAME } from '../v14/types.js';
import { parseFrontmatterRawV14, splitSkillTextV14 } from '../v14/validator.js';
import { SKILL_V15_PLATFORMS } from './types.js';
import type {
  SkillV15Drift,
  SkillV15MirrorMode,
  SkillV15SyncReport,
} from './types.js';
import {
  diffSkillDirsV15,
  inspectPlatformInstallV15,
  listPlatformInstallsV15,
  listSkillFilesV15,
} from './multiPlatform.js';
import { platformRootV15 } from './platforms.js';

export interface CheckMirrorSyncV15Options {
  /** Project root to scan. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Home directory for global roots. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Global (home-dir) roots instead of project-local ones. */
  global?: boolean;
  /** Mirror mode to restore with when repairing. Default: `copy`. */
  mode?: SkillV15MirrorMode;
}

/**
 * Read the name + description of a skill's SKILL.md (null when the
 * file cannot be parsed). Used to tell a drifted copy apart from a
 * hand-installed skill of the same name: a drifted copy keeps the
 * canonical name + description (its edits are in the body or
 * scripts), while a different skill states a different description.
 */
function skillIdentityV15(dir: string): { name: string; description: string } | null {
  try {
    const text = fs.readFileSync(path.join(dir, SKILL_V14_FILE_NAME), 'utf8');
    const split = splitSkillTextV14(text);
    if (split === null) return null;
    const raw = parseFrontmatterRawV14(split.frontmatterBlock, path.join(dir, SKILL_V14_FILE_NAME));
    if (typeof raw['name'] !== 'string' || typeof raw['description'] !== 'string') return null;
    return { name: raw['name'], description: raw['description'] };
  } catch {
    return null;
  }
}

function copyDirRecursiveSyncV15(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursiveSyncV15(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * Check every mirror of every canonical skill. Returns one drift
 * entry per (skill, platform) that is not in sync — `in-sync`
 * mirrors produce no entry.
 */
export function checkMirrorSyncV15(opts: CheckMirrorSyncV15Options = {}): SkillV15Drift[] {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const global = opts.global ?? false;
  const canonicalRoot = platformRootV15('openbot', { projectRoot, homeDir, global });
  const names = listPlatformInstallsV15('openbot', { projectRoot, homeDir, global });
  const drifts: SkillV15Drift[] = [];
  for (const name of names) {
    const canonicalDir = path.join(canonicalRoot, name);
    for (const platform of SKILL_V15_PLATFORMS) {
      if (platform === 'openbot') continue;
      const root = platformRootV15(platform, { projectRoot, homeDir, global });
      const install = inspectPlatformInstallV15(name, platform, root, canonicalDir);
      switch (install.state) {
        case 'missing':
          drifts.push({ skill: name, platform, state: 'missing', detail: '', differingFiles: [] });
          break;
        case 'broken-link':
          drifts.push({ skill: name, platform, state: 'broken-link', detail: install.detail, differingFiles: [] });
          break;
        case 'stale-copy': {
          // A copy whose SKILL.md states a different name/description
          // is not a drifted copy — it is a different skill the user
          // installed by hand under the same directory name. Never
          // repair it automatically (see the module header).
          const canonicalIdentity = skillIdentityV15(canonicalDir);
          const mirrorIdentity = skillIdentityV15(install.dir);
          const sameSkill =
            canonicalIdentity !== null &&
            mirrorIdentity !== null &&
            canonicalIdentity.name === mirrorIdentity.name &&
            canonicalIdentity.description === mirrorIdentity.description;
          if (!sameSkill) {
            drifts.push({
              skill: name,
              platform,
              state: 'not-a-mirror',
              detail: 'same directory name, different skill (name/description differ from canonical)',
              differingFiles: [],
            });
            break;
          }
          const differing = diffSkillDirsV15(canonicalDir, install.dir);
          drifts.push({
            skill: name,
            platform,
            state: 'drifted',
            detail: `differs in ${differing.length} file(s): ${differing.slice(0, 3).join(', ')}${differing.length > 3 ? ', …' : ''}`,
            differingFiles: differing,
          });
          break;
        }
        case 'invalid':
          // A directory of the same name that is not a copy of the
          // canonical skill and not a link to it: never auto-repair.
          drifts.push({
            skill: name,
            platform,
            state: 'not-a-mirror',
            detail: install.detail,
            differingFiles: [],
          });
          break;
        case 'copy':
        case 'symlink':
          break;
      }
    }
  }
  return drifts;
}

/**
 * Check mirrors and, when `repair` is true, fix every repairable
 * drift (drifted copies, missing mirrors, broken links). `not-a-mirror`
 * entries are never repaired. Returns the full report.
 */
export function repairMirrorSyncV15(
  opts: CheckMirrorSyncV15Options & { repair?: boolean } = {},
): SkillV15SyncReport {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const global = opts.global ?? false;
  const mode: SkillV15MirrorMode = opts.mode ?? 'copy';
  const drifts = checkMirrorSyncV15({ projectRoot, homeDir, global });
  const repaired: string[] = [];
  let checked = 0;
  // Total mirrors checked = canonical skills × 4 mirrors.
  const canonicalNames = listPlatformInstallsV15('openbot', { projectRoot, homeDir, global });
  checked = canonicalNames.length * (SKILL_V15_PLATFORMS.length - 1);

  if (opts.repair === true) {
    const canonicalRoot = platformRootV15('openbot', { projectRoot, homeDir, global });
    for (const drift of drifts) {
      if (drift.state === 'not-a-mirror') continue;
      const canonicalDir = path.join(canonicalRoot, drift.skill);
      const root = platformRootV15(drift.platform, { projectRoot, homeDir, global });
      const dest = path.join(root, drift.skill);
      try {
        fs.mkdirSync(root, { recursive: true });
        // Remove the old mirror itself (a symlink is unlinked, never followed).
        try {
          fs.lstatSync(dest);
          fs.rmSync(dest, { recursive: true, force: true });
        } catch {
          // Nothing there — a missing mirror.
        }
        if (mode === 'symlink') {
          fs.symlinkSync(canonicalDir, dest, 'dir');
        } else {
          copyDirRecursiveSyncV15(canonicalDir, dest);
        }
        repaired.push(`${drift.skill}@${drift.platform}`);
      } catch {
        // A failed repair stays reported as a drift; the report is
        // re-checked by the caller on the next run.
      }
    }
  }
  // Re-check after repair so the counts reflect the real end state.
  const endDrifts = opts.repair === true ? checkMirrorSyncV15({ projectRoot, homeDir, global }) : drifts;
  const inSync = checked - endDrifts.length;
  return {
    projectRoot,
    checked,
    inSync: Math.max(0, inSync),
    drifted: endDrifts.filter((d) => d.state === 'drifted').length,
    missing: endDrifts.filter((d) => d.state === 'missing').length,
    brokenLinks: endDrifts.filter((d) => d.state === 'broken-link').length,
    drifts: endDrifts,
    repaired,
  };
}

/** One-line summary of a sync report (tool output / logs). */
export function formatSyncReportV15(report: SkillV15SyncReport): string {
  const lines = [
    `Mirror sync: ${report.checked} mirror(s) checked, ${report.inSync} in sync, ` +
      `${report.drifted} drifted, ${report.missing} missing, ${report.brokenLinks} broken link(s).`,
  ];
  for (const drift of report.drifts) {
    lines.push(`- ${drift.skill}@${drift.platform}: ${drift.state}${drift.detail !== '' ? ` — ${drift.detail}` : ''}`);
  }
  if (report.repaired.length > 0) {
    lines.push(`Repaired: ${report.repaired.join(', ')}.`);
  }
  const notMirror = report.drifts.filter((d) => d.state === 'not-a-mirror');
  if (notMirror.length > 0) {
    lines.push(
      `Not repaired (not a mirror — a different skill of the same name installed by hand): ` +
        notMirror.map((d) => `${d.skill}@${d.platform}`).join(', ') +
        '. Remove it by hand if it should become a mirror.',
    );
  }
  return lines.join('\n');
}

/** List every file that would be copied to repair one drifted mirror. */
export function driftRepairPlanV15(drift: SkillV15Drift, canonicalDir: string): string[] {
  if (drift.state === 'drifted') return [...drift.differingFiles];
  if (drift.state === 'missing' || drift.state === 'broken-link') {
    return listSkillFilesV15(canonicalDir);
  }
  return [];
}

/** `true` when a skill directory holds a readable SKILL.md. */
export function isSkillDirV15(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, SKILL_V14_FILE_NAME));
  } catch {
    return false;
  }
}
