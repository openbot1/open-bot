/**
 * Sandbox v4 — agent profiles (v1.36, Team T4).
 *
 * A profile is everything an agent needs to know how to behave
 * in one conversation: a persona (who it is), instructions (the
 * rules it works by), a skill selection from the v4 catalog, and
 * its own LLM profile (model + sampling parameters). A runtime
 * runs under exactly one profile at a time; switching profiles
 * mid-conversation is allowed but explicit, so the history
 * always shows which profile produced which turn.
 *
 * Five builtin profiles ship with open-bot. Custom profiles are
 * created through `createProfile` and validated hard: bad id,
 * empty persona, empty instructions, unknown skill, or an LLM
 * profile outside its ranges all reject the profile — a bad
 * profile must never be stored and later applied by accident.
 * Builtin profiles cannot be edited or deleted; a custom profile
 * can, and every edit bumps `version` so the runtime can tell
 * whether the profile it runs under changed since it started.
 *
 * The effective system prompt is deterministic: persona first,
 * then instructions, then the skill list (so the model knows
 * exactly which capabilities it has), then the LLM profile line
 * (model + temperature, for the record). Nothing about secrets
 * ever goes into a prompt — profiles carry no secrets.
 */

import { SANDBOX_V4_PROFILE_ID_PATTERN } from './types';
import type { SandboxV4AgentProfile, SandboxV4LlmProfile } from './types';
import {
  SANDBOX_V4_BUILTIN_SKILLS,
  getBuiltinSandboxV4Skill,
  skillsNeedHostFs,
  skillsNeedNetwork,
  toolNamesForSandboxV4Skills,
  validateSandboxV4SkillIds,
} from './skillCatalog';

/** Default LLM parameters when a profile omits a field. */
export const SANDBOX_V4_DEFAULT_LLM: SandboxV4LlmProfile = {
  model: 'gpt-4o',
  temperature: 0.2,
  maxTokens: 4096,
  topP: 1,
  timeoutMs: 120_000,
};

/** Hard limits for LLM profile fields (validation clamps, never silently). */
export const SANDBOX_V4_LLM_LIMITS = {
  temperatureMin: 0,
  temperatureMax: 2,
  maxTokensMin: 0,
  maxTokensMax: 128_000,
  topPMin: 0,
  topPMax: 1,
  timeoutMsMin: 0,
  timeoutMsMax: 600_000,
} as const;

/** Maximum length of a persona or instructions string (chars). */
export const SANDBOX_V4_PROFILE_TEXT_MAX = 20_000;

/** Maximum skills one profile may select. */
export const SANDBOX_V4_PROFILE_MAX_SKILLS = 12;

/** Validate one LLM profile. Returns problems (empty = valid). */
export function validateSandboxV4LlmProfile(llm: unknown): string[] {
  const problems: string[] = [];
  if (typeof llm !== 'object' || llm === null || Array.isArray(llm)) {
    return ['llm must be an object { model, temperature, maxTokens, topP, timeoutMs }.'];
  }
  const value = llm as Record<string, unknown>;
  if (typeof value.model !== 'string' || value.model.trim() === '') {
    problems.push('llm.model must be a non-empty string.');
  } else if (value.model.length > 128) {
    problems.push('llm.model must be at most 128 characters.');
  }
  const temperature = value.temperature;
  if (typeof temperature !== 'number' || Number.isNaN(temperature)) {
    problems.push('llm.temperature must be a number.');
  } else if (temperature < SANDBOX_V4_LLM_LIMITS.temperatureMin || temperature > SANDBOX_V4_LLM_LIMITS.temperatureMax) {
    problems.push(`llm.temperature must be between ${SANDBOX_V4_LLM_LIMITS.temperatureMin} and ${SANDBOX_V4_LLM_LIMITS.temperatureMax}.`);
  }
  const maxTokens = value.maxTokens;
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens)) {
    problems.push('llm.maxTokens must be an integer.');
  } else if (maxTokens < SANDBOX_V4_LLM_LIMITS.maxTokensMin || maxTokens > SANDBOX_V4_LLM_LIMITS.maxTokensMax) {
    problems.push(`llm.maxTokens must be between ${SANDBOX_V4_LLM_LIMITS.maxTokensMin} and ${SANDBOX_V4_LLM_LIMITS.maxTokensMax}.`);
  }
  const topP = value.topP;
  if (typeof topP !== 'number' || Number.isNaN(topP)) {
    problems.push('llm.topP must be a number.');
  } else if (topP < SANDBOX_V4_LLM_LIMITS.topPMin || topP > SANDBOX_V4_LLM_LIMITS.topPMax) {
    problems.push(`llm.topP must be between ${SANDBOX_V4_LLM_LIMITS.topPMin} and ${SANDBOX_V4_LLM_LIMITS.topPMax}.`);
  }
  const timeoutMs = value.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) {
    problems.push('llm.timeoutMs must be an integer.');
  } else if (timeoutMs < SANDBOX_V4_LLM_LIMITS.timeoutMsMin || timeoutMs > SANDBOX_V4_LLM_LIMITS.timeoutMsMax) {
    problems.push(`llm.timeoutMs must be between ${SANDBOX_V4_LLM_LIMITS.timeoutMsMin} and ${SANDBOX_V4_LLM_LIMITS.timeoutMsMax}.`);
  }
  return problems;
}

/** Validate a full profile document (before create / update). */
export function validateSandboxV4AgentProfile(profile: unknown): string[] {
  const problems: string[] = [];
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    return ['Profile must be an object.'];
  }
  const value = profile as Record<string, unknown>;
  const id = value.id;
  if (typeof id !== 'string' || !SANDBOX_V4_PROFILE_ID_PATTERN.test(id)) {
    problems.push('Profile id must be a slug: lowercase letters, digits, "_", "-" (max 64 chars).');
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    problems.push('Profile name must be a non-empty string.');
  } else if (value.name.length > 128) {
    problems.push('Profile name must be at most 128 characters.');
  }
  if (typeof value.persona !== 'string' || value.persona.trim() === '') {
    problems.push('Profile persona must be a non-empty string.');
  } else if (value.persona.length > SANDBOX_V4_PROFILE_TEXT_MAX) {
    problems.push(`Profile persona must be at most ${SANDBOX_V4_PROFILE_TEXT_MAX} characters.`);
  }
  if (typeof value.instructions !== 'string' || value.instructions.trim() === '') {
    problems.push('Profile instructions must be a non-empty string.');
  } else if (value.instructions.length > SANDBOX_V4_PROFILE_TEXT_MAX) {
    problems.push(`Profile instructions must be at most ${SANDBOX_V4_PROFILE_TEXT_MAX} characters.`);
  }
  if (!Array.isArray(value.skillIds)) {
    problems.push('Profile skillIds must be an array of skill ids.');
  } else {
    if (value.skillIds.length === 0) {
      problems.push('Profile must select at least one skill.');
    }
    if (value.skillIds.length > SANDBOX_V4_PROFILE_MAX_SKILLS) {
      problems.push(`Profile may select at most ${SANDBOX_V4_PROFILE_MAX_SKILLS} skills.`);
    }
    problems.push(...validateSandboxV4SkillIds(value.skillIds as string[]));
  }
  problems.push(...validateSandboxV4LlmProfile(value.llm));
  return problems;
}

/** True when `id` is a well-formed profile id. */
export function isValidSandboxV4ProfileId(id: string): boolean {
  return SANDBOX_V4_PROFILE_ID_PATTERN.test(id);
}

/** Build the five builtin profiles. `nowMs` stamps created/updated. */
export function builtinSandboxV4AgentProfiles(nowMs: number): SandboxV4AgentProfile[] {
  const base = (id: string, name: string, persona: string, instructions: string, skillIds: string[], llm: SandboxV4LlmProfile): SandboxV4AgentProfile => ({
    id,
    name,
    persona,
    instructions,
    skillIds: [...skillIds],
    llm: { ...llm },
    builtin: true,
    version: 1,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  return [
    base(
      'generalist',
      'Generalist',
      'You are a helpful general-purpose agent. You answer questions, run small tasks and explain your work clearly.',
      'Be concise and honest. Say when you do not know. Never claim to have done something you did not do. Ask for clarification instead of guessing when the request is ambiguous. Never ask the user for a secret directly in chat — use the secret-request flow when a credential is needed.',
      ['code-read', 'web-search', 'web-fetch', 'memory-recall', 'memory-store', 'plan-tasks', 'secret-request'],
      { model: 'gpt-4o', temperature: 0.4, maxTokens: 4096, topP: 1, timeoutMs: 120_000 },
    ),
    base(
      'coder',
      'Coder',
      'You are an expert software engineer working inside a sandbox. You write correct, tested code and change as little as possible to solve the task.',
      'Read the code before editing it. Keep changes minimal and consistent with the existing style. Run the relevant tests after every change and report the result. Never edit files outside the conversation workspace. Never commit secrets: if a change needs a credential, stop and request it through the secret-request flow.',
      ['code-read', 'code-edit', 'code-run', 'code-test', 'git-ops', 'memory-recall', 'plan-tasks', 'secret-request'],
      { model: 'gpt-4o', temperature: 0.2, maxTokens: 8192, topP: 1, timeoutMs: 300_000 },
    ),
    base(
      'researcher',
      'Researcher',
      'You are a careful researcher. You gather evidence from the web and the workspace, compare sources, and cite where each fact came from.',
      'Prefer primary sources. Distinguish what a source says from what you infer. Quote numbers with their source. When sources disagree, say so instead of picking one silently. Summarise findings in the user language when the user writes in another language.',
      ['code-read', 'web-search', 'web-fetch', 'memory-recall', 'memory-store', 'plan-tasks'],
      { model: 'claude-sonnet-4', temperature: 0.3, maxTokens: 8192, topP: 1, timeoutMs: 180_000 },
    ),
    base(
      'planner',
      'Planner',
      'You are a planning agent. You turn vague goals into ordered, checkable plans and keep track of what is done.',
      'Break the goal into small steps with a clear done-condition each. Order steps by dependency, not by enthusiasm. Flag risks and unknowns explicitly. Never start implementation yourself — produce the plan and hand it over.',
      ['code-read', 'plan-tasks', 'memory-recall', 'memory-store'],
      { model: 'gpt-4o', temperature: 0.3, maxTokens: 4096, topP: 1, timeoutMs: 120_000 },
    ),
    base(
      'reviewer',
      'Reviewer',
      'You are a strict code reviewer. You find real bugs, security issues and needless complexity, and you praise nothing you did not check.',
      'Review the diff, not the description. Report each finding with file, line and severity. Separate must-fix from nice-to-have. Do not rewrite the code yourself — describe the fix. If you cannot verify a claim, say so.',
      ['code-read', 'code-review', 'code-test', 'git-ops', 'memory-recall'],
      { model: 'claude-sonnet-4', temperature: 0.2, maxTokens: 8192, topP: 1, timeoutMs: 180_000 },
    ),
  ];
}

/** Input for creating a custom profile (id + content; store fills the rest). */
export interface CreateSandboxV4ProfileInput {
  id: string;
  name: string;
  persona: string;
  instructions: string;
  skillIds: string[];
  llm: SandboxV4LlmProfile;
}

/** Input for updating a custom profile (partial; id + builtin are immutable). */
export type UpdateSandboxV4ProfileInput = Partial<Omit<CreateSandboxV4ProfileInput, 'id'>>;

/** Result of a create / update / delete operation. */
export interface SandboxV4ProfileMutation {
  ok: boolean;
  /** Present on failure. */
  error?: string;
  /** The profile after the mutation (present on success). */
  profile?: SandboxV4AgentProfile;
}

/**
 * Profile store: builtins + custom profiles. Custom profiles live
 * in memory (the host persists them if it wants to — the store
 * offers `exportJson` / `importJson` for that).
 */
export class SandboxV4ProfileStore {
  private readonly profiles = new Map<string, SandboxV4AgentProfile>();
  private readonly nowMs: () => number;

  constructor(nowMs?: () => number) {
    this.nowMs = nowMs ?? Date.now;
    for (const profile of builtinSandboxV4AgentProfiles(this.nowMs())) {
      this.profiles.set(profile.id, profile);
    }
  }

  /** All profiles, builtins first, then customs, sorted by id inside each group. */
  list(): SandboxV4AgentProfile[] {
    const all = [...this.profiles.values()];
    const builtins = all.filter((p) => p.builtin).sort((a, b) => a.id.localeCompare(b.id));
    const customs = all.filter((p) => !p.builtin).sort((a, b) => a.id.localeCompare(b.id));
    return [...builtins, ...customs].map((p) => ({ ...p, skillIds: [...p.skillIds], llm: { ...p.llm } }));
  }

  /** Resolve one profile by id, or undefined when unknown. */
  get(id: string): SandboxV4AgentProfile | undefined {
    const found = this.profiles.get(id);
    if (!found) return undefined;
    return { ...found, skillIds: [...found.skillIds], llm: { ...found.llm } };
  }

  /** True when a profile with this id exists. */
  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /** Number of profiles (builtins + customs). */
  size(): number {
    return this.profiles.size;
  }

  /** Create a custom profile. Fails when the id exists or validation fails. */
  create(input: CreateSandboxV4ProfileInput): SandboxV4ProfileMutation {
    const problems = validateSandboxV4AgentProfile(input);
    if (problems.length > 0) {
      return { ok: false, error: `Invalid profile: ${problems.join(' ')}` };
    }
    if (this.profiles.has(input.id)) {
      return { ok: false, error: `Profile "${input.id}" already exists.` };
    }
    const now = this.nowMs();
    const profile: SandboxV4AgentProfile = {
      id: input.id,
      name: input.name.trim(),
      persona: input.persona.trim(),
      instructions: input.instructions.trim(),
      skillIds: [...input.skillIds],
      llm: { ...input.llm },
      builtin: false,
      version: 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.profiles.set(profile.id, profile);
    return { ok: true, profile: this.get(profile.id) };
  }

  /**
   * Update a custom profile. Builtins are immutable (fail). Every
   * successful update bumps `version` and `updatedAtMs`.
   */
  update(id: string, patch: UpdateSandboxV4ProfileInput): SandboxV4ProfileMutation {
    const existing = this.profiles.get(id);
    if (!existing) return { ok: false, error: `Unknown profile "${id}".` };
    if (existing.builtin) {
      return { ok: false, error: `Builtin profile "${id}" cannot be edited.` };
    }
    const merged: SandboxV4AgentProfile = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.skillIds !== undefined ? { skillIds: [...patch.skillIds] } : {}),
      ...(patch.llm !== undefined ? { llm: { ...patch.llm } } : {}),
    };
    const problems = validateSandboxV4AgentProfile(merged);
    if (problems.length > 0) {
      return { ok: false, error: `Invalid profile update: ${problems.join(' ')}` };
    }
    const updated: SandboxV4AgentProfile = {
      ...merged,
      name: merged.name.trim(),
      persona: merged.persona.trim(),
      instructions: merged.instructions.trim(),
      version: existing.version + 1,
      updatedAtMs: this.nowMs(),
    };
    this.profiles.set(id, updated);
    return { ok: true, profile: this.get(id) };
  }

  /** Delete a custom profile. Builtins cannot be deleted. */
  delete(id: string): SandboxV4ProfileMutation {
    const existing = this.profiles.get(id);
    if (!existing) return { ok: false, error: `Unknown profile "${id}".` };
    if (existing.builtin) {
      return { ok: false, error: `Builtin profile "${id}" cannot be deleted.` };
    }
    this.profiles.delete(id);
    return { ok: true, profile: { ...existing, skillIds: [...existing.skillIds], llm: { ...existing.llm } } };
  }

  /**
   * Build the effective system prompt for a profile: persona,
   * instructions, the skill list with tool names, and the LLM
   * line. Deterministic — same profile, same prompt.
   */
  systemPromptFor(profile: SandboxV4AgentProfile): string {
    const lines: string[] = [];
    lines.push(profile.persona.trim());
    lines.push('');
    lines.push('Instructions:');
    lines.push(profile.instructions.trim());
    lines.push('');
    lines.push('Skills available to you in this conversation:');
    for (const skillId of profile.skillIds) {
      const skill = getBuiltinSandboxV4Skill(skillId);
      if (!skill) continue;
      lines.push(`- ${skill.id} (${skill.name}): ${skill.description} Tools: ${skill.toolNames.join(', ')}.`);
    }
    lines.push('');
    lines.push(`You run on model ${profile.llm.model} (temperature ${profile.llm.temperature}, max ${profile.llm.maxTokens} output tokens per turn).`);
    if (skillsNeedNetwork(profile.skillIds)) {
      lines.push('You may use the network only through the web-search / web-fetch skills; direct network access is not available.');
    }
    if (skillsNeedHostFs(profile.skillIds)) {
      lines.push('You may touch the host filesystem only through the skills listed above.');
    }
    return lines.join('\n');
  }

  /** Resolve the system prompt for a profile id (throws when unknown). */
  systemPromptForId(id: string): string {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Unknown agent profile "${id}".`);
    return this.systemPromptFor(profile);
  }

  /** Tool names unlocked by a profile (deduped, sorted). */
  toolNamesForProfile(profile: SandboxV4AgentProfile): string[] {
    return toolNamesForSandboxV4Skills(profile.skillIds);
  }

  /** Export custom profiles as JSON (builtins are not exported). */
  exportJson(): string {
    const customs = this.list().filter((p) => !p.builtin);
    return JSON.stringify({ version: 1, profiles: customs }, null, 2);
  }

  /**
   * Import custom profiles from `exportJson` output. Each profile
   * is validated; invalid entries are skipped and reported.
   * Existing custom ids are overwritten only when the import is
   * newer (higher version or later updatedAtMs).
   */
  importJson(json: string): { imported: number; skipped: number; problems: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (err) {
      return { imported: 0, skipped: 0, problems: [`Not valid JSON: ${(err as Error).message}`] };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { imported: 0, skipped: 0, problems: ['Import document must be an object { version, profiles }.'] };
    }
    const profiles = (parsed as Record<string, unknown>).profiles;
    if (!Array.isArray(profiles)) {
      return { imported: 0, skipped: 0, problems: ['Import document must carry a profiles array.'] };
    }
    let imported = 0;
    let skipped = 0;
    const problems: string[] = [];
    for (const raw of profiles as unknown[]) {
      const candidate = raw as Record<string, unknown>;
      const check = validateSandboxV4AgentProfile(candidate);
      if (check.length > 0) {
        skipped += 1;
        problems.push(`Profile "${String(candidate.id ?? '?')}" skipped: ${check.join(' ')}`);
        continue;
      }
      const id = candidate.id as string;
      if (this.profiles.get(id)?.builtin) {
        skipped += 1;
        problems.push(`Profile "${id}" skipped: id belongs to a builtin profile.`);
        continue;
      }
      const existing = this.profiles.get(id);
      const incomingVersion = typeof candidate.version === 'number' ? candidate.version : 1;
      const incomingUpdated = typeof candidate.updatedAtMs === 'number' ? candidate.updatedAtMs : 0;
      if (existing && existing.version >= incomingVersion && existing.updatedAtMs >= incomingUpdated) {
        skipped += 1;
        problems.push(`Profile "${id}" skipped: existing copy is newer or equal.`);
        continue;
      }
      const profile: SandboxV4AgentProfile = {
        id,
        name: String(candidate.name),
        persona: String(candidate.persona),
        instructions: String(candidate.instructions),
        skillIds: [...(candidate.skillIds as string[])],
        llm: { ...(candidate.llm as SandboxV4LlmProfile) },
        builtin: false,
        version: incomingVersion,
        createdAtMs: typeof candidate.createdAtMs === 'number' ? candidate.createdAtMs : this.nowMs(),
        updatedAtMs: incomingUpdated || this.nowMs(),
      };
      this.profiles.set(id, profile);
      imported += 1;
    }
    return { imported, skipped, problems };
  }

  /** Summarise profiles for list endpoints. */
  summarize(): Array<{
    id: string;
    name: string;
    builtin: boolean;
    version: number;
    skillCount: number;
    toolCount: number;
    needsNetwork: boolean;
    model: string;
    temperature: number;
  }> {
    return this.list().map((profile) => ({
      id: profile.id,
      name: profile.name,
      builtin: profile.builtin,
      version: profile.version,
      skillCount: profile.skillIds.length,
      toolCount: this.toolNamesForProfile(profile).length,
      needsNetwork: skillsNeedNetwork(profile.skillIds),
      model: profile.llm.model,
      temperature: profile.llm.temperature,
    }));
  }
}

/** Re-exported for callers that only need the catalog size. */
export { SANDBOX_V4_BUILTIN_SKILLS };
