/**
 * Sandbox v4 — server skill catalog (v1.36, Team T4).
 *
 * Agent profiles pick skills from this catalog. A skill is a
 * named capability with the tool names it unlocks; the profile
 * stores skill ids only, and the catalog is the single source
 * of truth for what each id means. Unknown skill ids are
 * rejected at profile validation time — a profile can never
 * silently claim a skill that does not exist.
 *
 * The catalog is deliberately small and explicit: it names the
 * capabilities a sandboxed agent needs (read code, edit code,
 * run commands, search the web, ...) and flags the two risky
 * axes (`needsNetwork`, `needsHostFs`) so a profile reviewer
 * can see at a glance which skills escape the sandbox. It is
 * a v4-local catalog, not the repo-wide skill registry: the
 * repo has many skill systems, and v4 profiles need a stable,
 * versioned list that does not move when another team renames
 * a skill elsewhere.
 */

import { SANDBOX_V4_SKILL_ID_PATTERN } from './types';
import type { SandboxV4Skill } from './types';

/** Built-in skill catalog (v4). 12 skills. */
export const SANDBOX_V4_BUILTIN_SKILLS: readonly SandboxV4Skill[] = [
  {
    id: 'code-read',
    name: 'Read code',
    description: 'Read files, list directories and search inside the workspace.',
    toolNames: ['file_read', 'file_list', 'file_search'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'code-edit',
    name: 'Edit code',
    description: 'Create and edit files inside the conversation workspace.',
    toolNames: ['file_write', 'file_edit'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'code-run',
    name: 'Run code',
    description: 'Run shell commands and test scripts inside the sandbox.',
    toolNames: ['shell_run'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'code-test',
    name: 'Run tests',
    description: 'Run the project test suite and read test results.',
    toolNames: ['test_run', 'test_report'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'code-review',
    name: 'Review code',
    description: 'Review diffs, run static checks and summarise findings.',
    toolNames: ['git_diff', 'git_status', 'file_read'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'git-ops',
    name: 'Git operations',
    description: 'Branch, commit and inspect git history inside the workspace.',
    toolNames: ['git_status', 'git_diff', 'git_commit', 'git_branch'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'web-search',
    name: 'Web search',
    description: 'Search the web and fetch pages for research.',
    toolNames: ['web_search', 'web_fetch'],
    needsNetwork: true,
    needsHostFs: false,
  },
  {
    id: 'web-fetch',
    name: 'Fetch URL',
    description: 'Fetch a single URL and extract its content (no search).',
    toolNames: ['web_fetch'],
    needsNetwork: true,
    needsHostFs: false,
  },
  {
    id: 'memory-recall',
    name: 'Memory recall',
    description: 'Recall long-term memory and user preferences.',
    toolNames: ['memory_recall', 'memory_search'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'memory-store',
    name: 'Memory store',
    description: 'Store facts and preferences into long-term memory.',
    toolNames: ['memory_store'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'plan-tasks',
    name: 'Plan tasks',
    description: 'Break work into tasks, track progress and report status.',
    toolNames: ['task_create', 'task_list', 'task_update'],
    needsNetwork: false,
    needsHostFs: false,
  },
  {
    id: 'secret-request',
    name: 'Request secrets',
    description: 'Ask the user for a secret mid-conversation through the safe secret-request flow.',
    toolNames: ['sandbox_v4_secret_request'],
    needsNetwork: false,
    needsHostFs: false,
  },
];

/** Map of builtin skill id → skill, for O(1) lookup. */
export const SANDBOX_V4_BUILTIN_SKILL_MAP: ReadonlyMap<string, SandboxV4Skill> = new Map(
  SANDBOX_V4_BUILTIN_SKILLS.map((skill) => [skill.id, skill]),
);

/** True when `id` is a well-formed skill id. */
export function isValidSandboxV4SkillId(id: string): boolean {
  return SANDBOX_V4_SKILL_ID_PATTERN.test(id);
}

/** Resolve a builtin skill by id, or undefined when unknown. */
export function getBuiltinSandboxV4Skill(id: string): SandboxV4Skill | undefined {
  return SANDBOX_V4_BUILTIN_SKILL_MAP.get(id);
}

/**
 * Validate a list of skill ids against the catalog.
 * Returns the problems found (empty = valid). Checks: well-formed
 * id, known in the catalog, no duplicates.
 */
export function validateSandboxV4SkillIds(skillIds: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of skillIds) {
    if (typeof id !== 'string' || id === '') {
      problems.push('Skill id must be a non-empty string.');
      continue;
    }
    if (!isValidSandboxV4SkillId(id)) {
      problems.push(`Skill id "${id}" is not a valid slug (lowercase letters, digits, "_", "-").`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`Duplicate skill id "${id}".`);
      continue;
    }
    seen.add(id);
    if (!SANDBOX_V4_BUILTIN_SKILL_MAP.has(id)) {
      problems.push(`Unknown skill "${id}" (not in the sandbox v4 skill catalog).`);
    }
  }
  return problems;
}

/** All tool names unlocked by a set of skills (deduped, sorted). */
export function toolNamesForSandboxV4Skills(skillIds: readonly string[]): string[] {
  const names = new Set<string>();
  for (const id of skillIds) {
    const skill = SANDBOX_V4_BUILTIN_SKILL_MAP.get(id);
    if (!skill) continue;
    for (const toolName of skill.toolNames) names.add(toolName);
  }
  return [...names].sort();
}

/** True when any of the skills needs the network. */
export function skillsNeedNetwork(skillIds: readonly string[]): boolean {
  for (const id of skillIds) {
    if (SANDBOX_V4_BUILTIN_SKILL_MAP.get(id)?.needsNetwork) return true;
  }
  return false;
}

/** True when any of the skills touches the host filesystem. */
export function skillsNeedHostFs(skillIds: readonly string[]): boolean {
  for (const id of skillIds) {
    if (SANDBOX_V4_BUILTIN_SKILL_MAP.get(id)?.needsHostFs) return true;
  }
  return false;
}

/** Summarise the catalog for list endpoints (id, name, flags). */
export function summarizeSandboxV4SkillCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  toolNames: string[];
  needsNetwork: boolean;
  needsHostFs: boolean;
}> {
  return SANDBOX_V4_BUILTIN_SKILLS.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    toolNames: [...skill.toolNames],
    needsNetwork: skill.needsNetwork,
    needsHostFs: skill.needsHostFs,
  }));
}
