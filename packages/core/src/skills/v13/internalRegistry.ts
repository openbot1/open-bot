/**
 * Agent Skills loader v13 — internal skill registry (v1.13, Team T1).
 *
 * open-bot's own skill catalog: the skills that ship with the product
 * (the 11 built-ins in `../builtin/`) plus the capability skills the
 * platform itself provides (coding, memory, voice, ...). This module
 * does NOT load SKILL.md files — that is the loader/registry's job.
 * It answers the product questions:
 *
 * - What skills does open-bot itself offer, grouped by category?
 * - Which skill fits this task text? (`searchInternalSkills` — keyword
 *   scoring on name + description + when-to-use + trigger words.)
 * - Which skills activate for this work context? (`skillsForContext`
 *   — e.g. a `code-review` context activates `code-review` +
 *   `git-workflow`; a `voice` context activates the voice skills.)
 * - Is a skill registered, and what does it need? (`getInternalSkill`,
 *   `isInternalSkill` — the allowlist the audit module trusts.)
 *
 * Each entry carries `triggers` (lowercase keywords/phrases matched
 * against task text) and `contexts` (the work contexts that activate
 * it). A skill may belong to several contexts — e.g. `test-writing`
 * activates for both `coding` and `review`.
 *
 * The catalog is data, not behaviour: hosts may add their own entries
 * at runtime with `registerInternalSkill` (an in-memory overlay — it
 * never writes files), and `unregisterInternalSkill` removes an
 * overlay entry again. Built-in entries cannot be removed (they are
 * the product's own skills; disable them via the registry instead).
 *
 * All descriptions below are original open-bot text describing the
 * product's own capabilities; the built-in skill names match the
 * `../builtin/` directories exactly.
 */

export type InternalSkillCategory =
  | 'coding'
  | 'review'
  | 'writing'
  | 'research'
  | 'data'
  | 'memory'
  | 'voice'
  | 'platform'
  | 'workflow';

/** Work contexts a skill can activate in. */
export type InternalSkillContext =
  | 'coding'
  | 'review'
  | 'writing'
  | 'research'
  | 'data'
  | 'meeting'
  | 'release'
  | 'translation'
  | 'memory'
  | 'voice'
  | 'platform'
  | 'git';

/** One skill in open-bot's own catalog. */
export interface InternalSkillEntry {
  /** Skill name — matches the built-in directory / registry name. */
  name: string;
  /** One-line description (what the skill does). */
  description: string;
  /** When to use it (shown to the model / in the skill browser). */
  whenToUse: string;
  category: InternalSkillCategory;
  /** Work contexts that activate this skill. */
  contexts: InternalSkillContext[];
  /** Lowercase keywords/phrases matched against task text. */
  triggers: string[];
  /** Tools the skill is allowed to use (subset of the host's tools). */
  allowedTools: string[];
  /** True for the 11 skills compiled into the product. */
  builtin: boolean;
  /** Version of the skill as shipped. */
  version: string;
  /** True when only the user may invoke it (never auto-matched). */
  userOnly: boolean;
}

/** The 11 built-in skills, exactly as shipped in `../builtin/`. */
export const INTERNAL_BUILTIN_SKILLS: readonly InternalSkillEntry[] = [
  {
    name: 'code-review',
    description: 'Review code changes for bugs, security issues and style.',
    whenToUse: 'when the user asks to review code, a diff, a pull request, or check code quality',
    category: 'review',
    contexts: ['review', 'coding'],
    triggers: ['review', 'code review', 'pull request', 'pr review', 'diff', 'check code', 'code quality', 'bug', 'security issue', 'review code'],
    allowedTools: ['read_file', 'grep_search', 'git_diff'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'commit-message',
    description: 'Write clear git commit messages from a diff — what changed, why, and what to watch out for.',
    whenToUse: 'when the user asks for a commit message, or before committing changes',
    category: 'workflow',
    contexts: ['git', 'coding'],
    triggers: ['commit message', 'commit msg', 'write a commit', 'git commit', 'commit changes'],
    allowedTools: ['git_diff', 'git_log', 'read_file'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'data-cleaning',
    description: 'Clean CSV or JSON data files before analysis — fix formats, remove duplicates, report problems.',
    whenToUse: 'when the user needs a CSV or JSON data file cleaned before analysis',
    category: 'data',
    contexts: ['data'],
    triggers: ['clean data', 'csv', 'json', 'data file', 'duplicates', 'fix format', 'clean up data'],
    allowedTools: ['read_file', 'write_file', 'list_files', 'glob_files', 'shell_exec'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'git-workflow',
    description: 'Work with git safely — commit, branch, review history and prepare pull requests.',
    whenToUse: 'when the user works with git — committing, branching, reviewing history, or preparing a pull request',
    category: 'workflow',
    contexts: ['git', 'coding', 'review'],
    triggers: ['git', 'branch', 'merge', 'checkout', 'pull request', 'git history', 'git log', 'stash'],
    allowedTools: ['read_file', 'git_status', 'git_diff', 'git_commit', 'grep_search'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'meeting-notes',
    description: 'Take meeting notes and summarise discussions — decisions, action items and open questions.',
    whenToUse: 'when the user needs notes taken for a meeting or a summary of a discussion',
    category: 'writing',
    contexts: ['meeting', 'writing'],
    triggers: ['meeting', 'meeting notes', 'take notes', 'action items', 'discussion summary', 'standup'],
    allowedTools: ['read_file', 'write_file', 'list_files'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'release-notes',
    description: 'Draft release notes from commits and changes — what is new, what changed, what was fixed.',
    whenToUse: 'when the user asks for release notes, a changelog entry, or a summary of a new version',
    category: 'writing',
    contexts: ['release', 'writing'],
    triggers: ['release notes', 'changelog', 'what is new', "what's new", 'new version', 'release summary'],
    allowedTools: ['git_log', 'git_diff', 'read_file'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'research-brief',
    description: 'Research a topic and write a short sourced brief.',
    whenToUse: 'when the user asks to research, compare, investigate or summarise a topic',
    category: 'research',
    contexts: ['research'],
    triggers: ['research', 'investigate', 'compare', 'brief', 'look into', 'find out about', 'summarise a topic', 'summarize a topic'],
    allowedTools: ['web_search', 'web_fetch'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'summarize-file',
    description: 'Summarise a file or document faithfully — what it says, what matters, and what is missing.',
    whenToUse: 'when the user asks for a summary of a file, document, or long text',
    category: 'writing',
    contexts: ['writing', 'research'],
    triggers: ['summarise', 'summarize', 'summary', 'tl;dr', 'what does this file say', 'summarise this', 'summarize this'],
    allowedTools: ['read_file', 'list_files'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'test-writing',
    description: 'Write tests for new or changed code — happy path, edge cases and errors.',
    whenToUse: 'when the user needs tests written for new or changed code',
    category: 'coding',
    contexts: ['coding', 'review'],
    triggers: ['write tests', 'test', 'tests', 'unit test', 'test coverage', 'edge case', 'add tests'],
    allowedTools: ['read_file', 'write_file', 'grep_search', 'shell_exec'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'translation',
    description: 'Translate text into another language, keeping meaning, tone, terms and formatting.',
    whenToUse: 'when the user needs text translated into another language',
    category: 'writing',
    contexts: ['translation', 'writing'],
    triggers: ['translate', 'translation', 'dịch', '翻译', '翻訳', 'traducir', 'traduire'],
    allowedTools: ['read_file', 'write_file'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'writing-vi',
    description: 'Write and edit Vietnamese text that reads naturally.',
    whenToUse: 'when the user asks to write, draft, rewrite or polish Vietnamese text',
    category: 'writing',
    contexts: ['writing', 'translation'],
    triggers: ['viết', 'tiếng việt', 'vietnamese', 'soạn thảo', 'văn bản', 'viết lại', 'polish vietnamese'],
    allowedTools: ['read_file', 'write_file'],
    builtin: true,
    version: '1.0.0',
    userOnly: false,
  },
];

/**
 * Capability skills the platform provides beyond the 11 built-ins.
 * These are NOT separate SKILL.md files — they describe capabilities
 * open-bot already has (memory, voice, coding agent, platform/fleet)
 * so the catalog, the audit and the UI can refer to them by the same
 * name the rest of the product uses. `builtin: false` marks them as
 * capability entries, not file-backed skills.
 */
export const INTERNAL_CAPABILITY_SKILLS: readonly InternalSkillEntry[] = [
  {
    name: 'memory-recall',
    description: 'Recall long-term memory and user profile facts before answering — what the user likes, decided, and asked before.',
    whenToUse: 'when the answer depends on who the user is, what they decided earlier, or what they asked in past sessions',
    category: 'memory',
    contexts: ['memory'],
    triggers: ['remember', 'memory', 'recall', 'what did i', 'earlier', 'last time', 'my preference', 'nhớ', 'trước đây'],
    allowedTools: ['memory_search', 'memory_read'],
    builtin: false,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'voice-realtime',
    description: 'Handle realtime voice — transcribe speech, speak replies, and keep a voice conversation going.',
    whenToUse: 'when the user talks instead of typing, or asks for a spoken reply',
    category: 'voice',
    contexts: ['voice'],
    triggers: ['voice', 'speak', 'talk', 'listen', 'speech', 'nói', 'giọng nói', 'đọc to'],
    allowedTools: ['voice_transcribe', 'voice_speak'],
    builtin: false,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'coding-agent',
    description: 'Plan and write code changes across a repository — implement a feature, fix a bug, refactor safely.',
    whenToUse: 'when the user asks to implement, fix, or change code in a repository',
    category: 'coding',
    contexts: ['coding'],
    triggers: ['implement', 'fix the bug', 'refactor', 'add a feature', 'write code', 'change the code', 'sửa code', 'viết code'],
    allowedTools: ['read_file', 'write_file', 'grep_search', 'shell_exec', 'git_diff'],
    builtin: false,
    version: '1.0.0',
    userOnly: false,
  },
  {
    name: 'platform-fleet',
    description: 'Operate the multi-user fleet — check bot health, fleet status, and per-bot computers.',
    whenToUse: 'when the user asks about fleet status, bot health, or running bots across computers',
    category: 'platform',
    contexts: ['platform'],
    triggers: ['fleet', 'bot status', 'bot health', 'running bots', 'fleet status', 'computers'],
    allowedTools: ['fleet_status', 'bot_list'],
    builtin: false,
    version: '1.0.0',
    userOnly: false,
  },
];

/** All catalog entries: built-ins first, then capability skills. */
export const INTERNAL_SKILLS: readonly InternalSkillEntry[] = [
  ...INTERNAL_BUILTIN_SKILLS,
  ...INTERNAL_CAPABILITY_SKILLS,
];

/** Score for one catalog hit. */
export interface InternalSkillMatch {
  entry: InternalSkillEntry;
  /** Keyword score: trigger hits count 3, description/when-to-use hits 1. */
  score: number;
  /** Trigger phrases that matched (for explaining the hit). */
  matchedTriggers: string[];
}

const overlay = new Map<string, InternalSkillEntry>();

/** All catalog entries (built-ins + capabilities + runtime overlays). */
export function listInternalSkills(): InternalSkillEntry[] {
  const out = [...INTERNAL_SKILLS];
  for (const entry of overlay.values()) {
    const at = out.findIndex((e) => e.name === entry.name);
    if (at >= 0) out[at] = entry;
    else out.push(entry);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One catalog entry by name, or undefined. */
export function getInternalSkill(name: string): InternalSkillEntry | undefined {
  return listInternalSkills().find((e) => e.name === name);
}

/** True when the name is one of open-bot's own skills. */
export function isInternalSkill(name: string): boolean {
  return getInternalSkill(name) !== undefined;
}

/** Names of open-bot's own skills, sorted. */
export function internalSkillNames(): string[] {
  return listInternalSkills().map((e) => e.name);
}

/**
 * Register (or replace) a catalog entry at runtime. The entry must
 * have a valid skill name and at least one trigger; anything else
 * throws. Overlays never touch disk or the built-in list — they only
 * affect this process. Built-in names CAN be overlaid (to correct a
 * description), but `unregisterInternalSkill` restores the built-in.
 */
export function registerInternalSkill(entry: InternalSkillEntry): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)) {
    throw new Error(`Invalid internal skill name ${JSON.stringify(entry.name)}.`);
  }
  if (entry.triggers.length === 0) {
    throw new Error(`Internal skill "${entry.name}" needs at least one trigger.`);
  }
  if (!entry.description || entry.description.trim() === '') {
    throw new Error(`Internal skill "${entry.name}" needs a non-empty description.`);
  }
  overlay.set(entry.name, { ...entry, triggers: [...entry.triggers] });
}

/** Remove a runtime overlay entry (built-ins are unaffected). Returns true when one was removed. */
export function unregisterInternalSkill(name: string): boolean {
  return overlay.delete(name);
}

/** Remove every runtime overlay entry (test helper / host reset). */
export function clearInternalSkillOverlays(): void {
  overlay.clear();
}

/** Entries in one category, sorted by name. */
export function internalSkillsByCategory(category: InternalSkillCategory): InternalSkillEntry[] {
  return listInternalSkills().filter((e) => e.category === category);
}

/**
 * Skills that activate for a work context (e.g. 'review' ->
 * code-review, git-workflow, test-writing). User-only skills are
 * never returned — they cannot activate on their own.
 */
export function skillsForContext(context: InternalSkillContext): InternalSkillEntry[] {
  return listInternalSkills()
    .filter((e) => !e.userOnly && e.contexts.includes(context))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Search the catalog by task text. Scoring mirrors the registry's
 * `scoreSkill` (trigger 3, description/when-to-use 1) so the two
 * agree; `userOnly` entries are skipped, like the registry skips
 * `disable-model-invocation` skills. Returns at most `limit` hits
 * with score >= 1, best first.
 */
export function searchInternalSkills(query: string, limit = 5): InternalSkillMatch[] {
  const text = query.toLowerCase();
  if (text.trim() === '') return [];
  const hits: InternalSkillMatch[] = [];
  for (const entry of listInternalSkills()) {
    if (entry.userOnly) continue;
    let score = 0;
    const matchedTriggers: string[] = [];
    for (const trigger of entry.triggers) {
      if (trigger && text.includes(trigger.toLowerCase())) {
        score += 3;
        matchedTriggers.push(trigger);
      }
    }
    const haystack = `${entry.name} ${entry.description} ${entry.whenToUse}`.toLowerCase();
    for (const word of text.split(/[^a-z0-9à-ỹ_-]+/i).filter((w) => w.length >= 3)) {
      if (haystack.includes(word)) score += 1;
    }
    if (score > 0) hits.push({ entry, score, matchedTriggers });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return hits.slice(0, limit);
}

/**
 * One-line catalog summary for the skill browser / settings UI:
 * `name — description` per entry, grouped by category.
 */
export function formatInternalCatalog(): string {
  const categories: InternalSkillCategory[] = [
    'coding',
    'review',
    'writing',
    'research',
    'data',
    'memory',
    'voice',
    'platform',
    'workflow',
  ];
  const lines: string[] = ['open-bot skills:'];
  for (const category of categories) {
    const entries = internalSkillsByCategory(category);
    if (entries.length === 0) continue;
    lines.push(`\n[${category}]`);
    for (const e of entries) {
      lines.push(`- ${e.name}: ${e.description}`);
    }
  }
  return lines.join('\n');
}
