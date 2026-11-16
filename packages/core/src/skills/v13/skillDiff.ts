/**
 * Agent Skills loader v13 — skill diff (v1.13, Team T1).
 *
 * Compare two versions of the same skill (old vs new) and answer the
 * questions a marketplace upgrade check actually asks:
 *
 * - What changed? (description, version, license, compatibility,
 *   allowed-tools, metadata, scope, body, resources.)
 * - Is it a BREAKING change? A rename, a removed allowed-tool, a
 *   removed scope entry, or a body that lost more than half its
 *   content is breaking: automations that relied on the old skill
 *   may stop working.
 * - What semver bump does the change deserve? `major` for breaking,
 *   `minor` for a new allowed-tool / new resource / new capability
 *   in the body, `patch` for wording-only changes, `none` when
 *   nothing changed. (The suggestion is advisory — the author still
 *   owns the version number; the marketplace only uses it to warn
 *   when an upgrade's declared version disagrees with the diff.)
 * - Does the new version actually declare a newer version?
 *   `versionRegressed` flags an upgrade whose version went backwards
 *   (a common mistake when a marketplace entry is republished from
 *   an old checkout).
 *
 * Inputs are parsed `Skill` objects (or SKILL.md texts — `diffSkillTexts`
 * parses first). The diff is pure computation: no disk, no network.
 * Body comparison is line-based and deliberately simple (added /
 * removed line counts + a similarity ratio) — enough to tell "typo
 * fix" from "rewritten", without pulling in a diff library.
 */

import type { Skill } from '../types';
import { parseSkillMarkdown } from '../loader';
import { compareSemver } from './localMarketplace';

/** One changed aspect of a skill. */
export interface SkillChange {
  /** Field that changed: 'description' | 'version' | 'license' | ... */
  field: string;
  /** Short human description of the change. */
  detail: string;
  /** True when this change alone is breaking. */
  breaking: boolean;
}

/** Suggested semver bump for a diff. */
export type SuggestedBump = 'major' | 'minor' | 'patch' | 'none';

/** Full result of `diffSkills`. */
export interface SkillDiff {
  name: string;
  oldVersion: string;
  newVersion: string;
  /** True when the new version is NOT strictly newer than the old. */
  versionRegressed: boolean;
  /** Every detected change, in a stable order. */
  changes: SkillChange[];
  /** True when any change is breaking. */
  breaking: boolean;
  /** Suggested semver bump for the new version. */
  suggestedBump: SuggestedBump;
  /** Body similarity 0–1 (1 = identical body). */
  bodySimilarity: number;
  /** Body lines added / removed. */
  bodyLinesAdded: number;
  bodyLinesRemoved: number;
}

function addedRemoved<T>(oldList: readonly T[], newList: readonly T[]): { added: T[]; removed: T[] } {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  return {
    added: newList.filter((x) => !oldSet.has(x)),
    removed: oldList.filter((x) => !newSet.has(x)),
  };
}

function describeListChange(label: string, added: readonly unknown[], removed: readonly unknown[]): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.map((x) => JSON.stringify(String(x))).join(', ')}`);
  if (removed.length > 0) parts.push(`removed ${removed.map((x) => JSON.stringify(String(x))).join(', ')}`);
  return `${label} ${parts.join('; ')}`;
}

/**
 * Line-based body similarity: Jaccard over the sets of non-empty
 * trimmed lines (0 = nothing in common, 1 = identical). Cheap and
 * good enough to separate "typo fix" (≈1) from "rewrite" (< 0.5).
 */
export function bodySimilarity(oldBody: string, newBody: string): number {
  const toSet = (body: string): Set<string> =>
    new Set(body.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const oldSet = toSet(oldBody);
  const newSet = toSet(newBody);
  if (oldSet.size === 0 && newSet.size === 0) return 1;
  if (oldSet.size === 0 || newSet.size === 0) return 0;
  let shared = 0;
  for (const line of oldSet) if (newSet.has(line)) shared++;
  return shared / (oldSet.size + newSet.size - shared);
}

/** Count added/removed body lines (multiset-aware via line counts). */
export function bodyLineChanges(
  oldBody: string,
  newBody: string,
): { added: number; removed: number } {
  const countLines = (body: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    return counts;
  };
  const oldCounts = countLines(oldBody);
  const newCounts = countLines(newBody);
  let added = 0;
  let removed = 0;
  for (const [line, n] of newCounts) {
    const oldN = oldCounts.get(line) ?? 0;
    if (n > oldN) added += n - oldN;
  }
  for (const [line, n] of oldCounts) {
    const newN = newCounts.get(line) ?? 0;
    if (n > newN) removed += n - newN;
  }
  return { added, removed };
}

/** Compare two parsed skills with the same name. Throws when names differ. */
export function diffSkills(oldSkill: Skill, newSkill: Skill): SkillDiff {
  if (oldSkill.name !== newSkill.name) {
    throw new Error(
      `Cannot diff skills with different names: ${JSON.stringify(oldSkill.name)} vs ${JSON.stringify(newSkill.name)}.`,
    );
  }
  const changes: SkillChange[] = [];
  const name = oldSkill.name;

  if (oldSkill.version !== newSkill.version) {
    changes.push({
      field: 'version',
      detail: `version ${oldSkill.version} → ${newSkill.version}`,
      breaking: false,
    });
  }
  if (oldSkill.description !== newSkill.description) {
    changes.push({
      field: 'description',
      detail: 'description changed',
      breaking: false,
    });
  }
  if ((oldSkill.whenToUse ?? '') !== (newSkill.whenToUse ?? '')) {
    changes.push({ field: 'when-to-use', detail: 'when-to-use changed', breaking: false });
  }
  if ((oldSkill.license ?? '') !== (newSkill.license ?? '')) {
    changes.push({
      field: 'license',
      detail: `license ${JSON.stringify(oldSkill.license ?? '(none)')} → ${JSON.stringify(newSkill.license ?? '(none)')}`,
      breaking: false,
    });
  }
  const compatText = (v: string | string[] | undefined): string =>
    v === undefined ? '' : typeof v === 'string' ? v : v.join(', ');
  if (compatText(oldSkill.compatibility) !== compatText(newSkill.compatibility)) {
    changes.push({ field: 'compatibility', detail: 'compatibility changed', breaking: false });
  }

  // allowed-tools: removing a tool is breaking (callers may rely on
  // it); adding one is a minor capability gain.
  const tools = addedRemoved(oldSkill.allowedTools, newSkill.allowedTools);
  if (tools.added.length > 0 || tools.removed.length > 0) {
    changes.push({
      field: 'allowed-tools',
      detail: describeListChange('allowed-tools', tools.added, tools.removed),
      breaking: tools.removed.length > 0,
    });
  }

  // scope: narrowing the scope is breaking (the skill stops firing
  // where it used to); widening is not.
  const oldScope = oldSkill.scope ?? [];
  const newScope = newSkill.scope ?? [];
  const scope = addedRemoved(oldScope, newScope);
  if (scope.added.length > 0 || scope.removed.length > 0) {
    changes.push({
      field: 'scope',
      detail: describeListChange('scope', scope.added, scope.removed),
      breaking: scope.removed.length > 0,
    });
  }

  if ((oldSkill.context ?? '') !== (newSkill.context ?? '')) {
    changes.push({
      field: 'context',
      detail: `context ${JSON.stringify(oldSkill.context ?? '(none)')} → ${JSON.stringify(newSkill.context ?? '(none)')}`,
      breaking: oldSkill.context === 'fork' && newSkill.context !== 'fork',
    });
  }
  if (oldSkill.disableModelInvocation !== newSkill.disableModelInvocation) {
    changes.push({
      field: 'disable-model-invocation',
      detail: `disable-model-invocation ${oldSkill.disableModelInvocation} → ${newSkill.disableModelInvocation}`,
      breaking: newSkill.disableModelInvocation === true,
    });
  }
  if (oldSkill.userInvocable !== newSkill.userInvocable) {
    changes.push({
      field: 'user-invocable',
      detail: `user-invocable ${oldSkill.userInvocable} → ${newSkill.userInvocable}`,
      breaking: newSkill.userInvocable === false,
    });
  }

  const oldMeta = JSON.stringify(oldSkill.metadata ?? null);
  const newMeta = JSON.stringify(newSkill.metadata ?? null);
  if (oldMeta !== newMeta) {
    changes.push({ field: 'metadata', detail: 'metadata changed', breaking: false });
  }

  // resources: a removed script/reference is breaking (the body may
  // call it); an added one is a minor gain.
  const allResources = (s: Skill): string[] => [
    ...s.resources.scripts,
    ...s.resources.references,
    ...s.resources.assets,
  ];
  const resources = addedRemoved(allResources(oldSkill), allResources(newSkill));
  if (resources.added.length > 0 || resources.removed.length > 0) {
    changes.push({
      field: 'resources',
      detail: describeListChange('resources', resources.added, resources.removed),
      breaking: resources.removed.length > 0,
    });
  }

  // body: similarity + line counts; losing > half the body is breaking.
  const similarity = bodySimilarity(oldSkill.body, newSkill.body);
  const { added, removed } = bodyLineChanges(oldSkill.body, newSkill.body);
  if (added > 0 || removed > 0) {
    const oldLines = oldSkill.body.split('\n').filter((l) => l.trim() !== '').length;
    const lostMost = oldLines > 0 && removed > oldLines / 2;
    changes.push({
      field: 'body',
      detail: `body changed (+${added} lines, -${removed} lines, similarity ${similarity.toFixed(2)})`,
      breaking: lostMost,
    });
  }

  const breaking = changes.some((c) => c.breaking);
  let suggestedBump: SuggestedBump;
  if (changes.length === 0) {
    suggestedBump = 'none';
  } else if (breaking) {
    suggestedBump = 'major';
  } else if (
    tools.added.length > 0 ||
    resources.added.length > 0 ||
    scope.added.length > 0 ||
    // Body grew net-new lines (new capability), not just reworded
    // lines (added == removed is a rewrite → patch, not minor).
    (changes.some((c) => c.field === 'body') && added > removed)
  ) {
    suggestedBump = 'minor';
  } else {
    suggestedBump = 'patch';
  }

  return {
    name,
    oldVersion: oldSkill.version,
    newVersion: newSkill.version,
    versionRegressed: compareSemver(newSkill.version, oldSkill.version) <= 0 && changes.length > 0,
    changes,
    breaking,
    suggestedBump,
    bodySimilarity: similarity,
    bodyLinesAdded: added,
    bodyLinesRemoved: removed,
  };
}

/** Diff two SKILL.md texts (parses both first). */
export function diffSkillTexts(oldText: string, newText: string): SkillDiff {
  const oldSkill = parseSkillMarkdown(oldText, 'user');
  const newSkill = parseSkillMarkdown(newText, 'user');
  return diffSkills(oldSkill, newSkill);
}

/** One-line human summary of a diff (for upgrade prompts and logs). */
export function formatSkillDiff(diff: SkillDiff): string {
  if (diff.changes.length === 0) {
    return `Skill "${diff.name}": no changes (v${diff.oldVersion}).`;
  }
  const lines = [
    `Skill "${diff.name}": v${diff.oldVersion} → v${diff.newVersion} — ${diff.changes.length} change(s), ` +
      `${diff.breaking ? 'BREAKING' : 'non-breaking'}, suggested bump: ${diff.suggestedBump}.`,
  ];
  if (diff.versionRegressed) {
    lines.push('  WARNING: the new version is not newer than the old one — check the version number.');
  }
  for (const change of diff.changes) {
    lines.push(`  - [${change.field}]${change.breaking ? ' BREAKING' : ''}: ${change.detail}`);
  }
  return lines.join('\n');
}
