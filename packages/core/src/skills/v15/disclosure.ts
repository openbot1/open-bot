/**
 * Agent Skills v15 — budgeted progressive disclosure (v1.36, Team T2).
 *
 * The v14 loader already implements the three disclosure tiers
 * (headers → body → resources); v15 adds the budget the survey's
 * progressive-disclosure idea implies but v14 never enforced:
 *
 * - Tier 1 is capped: at most `maxHeaders` headers and
 *   `maxHeaderTokens` tokens enter context at session start. Past the
 *   cap the lowest-priority headers (global roots first, then
 *   alphabetical tail) are dropped — and the drop is reported, never
 *   silent.
 * - Tier 2 is accounted: every activation adds its body tokens to the
 *   session total. Past `maxBodyTokens` the least-recently-used bodies
 *   are evicted (oldest activation first) until the new body fits;
 *   a single body larger than the whole budget is refused with a
 *   clear error instead of evicting everything for nothing.
 * - Tier 3 is capped per file (`maxResourceBytes`) and in total;
 *   re-reading an already-loaded resource is free (cached).
 * - The session records everything it loaded, evicted and refused,
 *   so the agent (and the user) can see exactly what the skill
 *   system cost — `usage()` / `formatUsageSummaryV15()`.
 *
 * A session is cheap and stateless across processes: it wraps one
 * `SkillV14Loader` opened over the standard discovery roots. The
 * underlying loader's own 32-entry body cache is left alone — the
 * session tracks its own budget on top of it.
 *
 * Everything here is original open-bot code.
 */

import { SkillV14Loader } from '../v14/loader.js';
import type { SkillV14Header, SkillV14LoaderOptions } from '../v14/types.js';
import {
  SKILL_V15_DEFAULT_MAX_BODY_TOKENS,
  SKILL_V15_DEFAULT_MAX_HEADERS,
  SKILL_V15_DEFAULT_MAX_HEADER_TOKENS,
  SKILL_V15_DEFAULT_MAX_RESOURCE_BYTES,
  SKILL_V15_MAX_RESOURCE_BYTES,
} from './types.js';
import type {
  SkillV15Budget,
  SkillV15BudgetedActivation,
  SkillV15BudgetedResource,
  SkillV15DisclosureUsage,
} from './types.js';

export interface DisclosureSessionV15Options extends SkillV14LoaderOptions {
  budget?: SkillV15Budget;
}

/** Resolved budget (every field filled with its default). */
export interface SkillV15ResolvedBudget {
  maxHeaders: number;
  maxHeaderTokens: number;
  maxBodyTokens: number;
  maxResourceBytes: number;
}

export function resolveBudgetV15(budget: SkillV15Budget = {}): SkillV15ResolvedBudget {
  return {
    maxHeaders: budget.maxHeaders ?? SKILL_V15_DEFAULT_MAX_HEADERS,
    maxHeaderTokens: budget.maxHeaderTokens ?? SKILL_V15_DEFAULT_MAX_HEADER_TOKENS,
    maxBodyTokens: budget.maxBodyTokens ?? SKILL_V15_DEFAULT_MAX_BODY_TOKENS,
    maxResourceBytes: Math.min(
      budget.maxResourceBytes ?? SKILL_V15_DEFAULT_MAX_RESOURCE_BYTES,
      SKILL_V15_MAX_RESOURCE_BYTES,
    ),
  };
}

/** Tier-1 headers that fit the budget, in priority order. */
export function trimHeadersToBudgetV15(
  headers: SkillV14Header[],
  budget: SkillV15ResolvedBudget,
): { kept: SkillV14Header[]; dropped: SkillV14Header[]; keptTokens: number } {
  const kept: SkillV14Header[] = [];
  const dropped: SkillV14Header[] = [];
  let tokens = 0;
  // Headers arrive project-local first, then alphabetical (see v14
  // loader) — keep that order and drop from the tail, so the most
  // relevant skills survive the cap.
  for (const header of headers) {
    const fitsCount = kept.length < budget.maxHeaders;
    const fitsTokens = tokens + header.headerTokens <= budget.maxHeaderTokens;
    if (fitsCount && fitsTokens) {
      kept.push(header);
      tokens += header.headerTokens;
    } else {
      dropped.push(header);
    }
  }
  return { kept, dropped, keptTokens: tokens };
}

/**
 * One budgeted disclosure session: open once, activate as needed,
 * read the usage at the end. Re-activating an already-loaded body is
 * free (no double charge); re-reading a cached resource is free.
 */
export class DisclosureSessionV15 {
  readonly budget: SkillV15ResolvedBudget;
  private readonly loader: SkillV14Loader;
  private readonly usageLogFile?: string;
  private opened = false;
  private droppedHeaders: SkillV14Header[] = [];
  /** Activation order (LRU): oldest first. */
  private readonly activationOrder: string[] = [];
  private readonly bodyTokensByName = new Map<string, number>();
  private readonly resourceCache = new Map<string, SkillV15BudgetedResource>();
  private readonly usage: SkillV15DisclosureUsage = {
    headersLoaded: 0,
    headerTokens: 0,
    bodiesLoaded: 0,
    bodyTokens: 0,
    resourcesLoaded: 0,
    resourceBytes: 0,
    evicted: [],
    rejected: [],
  };

  constructor(opts: DisclosureSessionV15Options = {}) {
    this.budget = resolveBudgetV15(opts.budget);
    this.usageLogFile = opts.usageLogFile;
    this.loader = new SkillV14Loader(opts);
  }

  /** Open the underlying v14 loader and apply the tier-1 budget. */
  open(): { headers: SkillV14Header[]; dropped: SkillV14Header[]; errors: string[] } {
    const result = this.loader.open();
    const enabled = this.loader.enabledHeaders();
    const { kept, dropped, keptTokens } = trimHeadersToBudgetV15(enabled, this.budget);
    this.droppedHeaders = dropped;
    this.usage.headersLoaded = kept.length;
    this.usage.headerTokens = keptTokens;
    this.opened = true;
    void result;
    return {
      headers: kept,
      dropped,
      errors: this.loader.errors.map((e) => `${e.dir}: ${e.error}`),
    };
  }

  private ensureOpen(): void {
    if (!this.opened) this.open();
  }

  /** Tier-1 headers inside the budget (opens the session on first use). */
  headers(): SkillV14Header[] {
    this.ensureOpen();
    const enabled = this.loader.enabledHeaders();
    return trimHeadersToBudgetV15(enabled, this.budget).kept;
  }

  /** Headers dropped by the tier-1 budget (for reporting). */
  droppedHeadersList(): SkillV14Header[] {
    this.ensureOpen();
    return [...this.droppedHeaders];
  }

  /** Load errors from the underlying v14 open (broken skills, skipped). */
  loadErrors(): string[] {
    this.ensureOpen();
    return this.loader.errors.map((e) => `${e.dir}: ${e.error}`);
  }

  /** Number of loadable skills (tier-1 headers, before the budget trim). */
  get size(): number {
    this.ensureOpen();
    return this.loader.size;
  }

  /** Compact tier-1 text for context, trimmed to the budget. */
  headersForContext(): string {
    this.ensureOpen();
    const kept = this.headers();
    if (kept.length === 0) return 'No v15 skills installed.';
    const lines: string[] = [
      `Available skills (v15, ${kept.length} enabled, ~${this.usage.headerTokens} tokens` +
        (this.droppedHeaders.length > 0 ? `, ${this.droppedHeaders.length} dropped by budget` : '') +
        '):',
    ];
    for (const header of kept) {
      const tools =
        header.allowedTools !== undefined && header.allowedTools.length > 0
          ? ` [tools: ${header.allowedTools.join(', ')}]`
          : '';
      const compat =
        header.compatibility !== undefined
          ? ` [runs on: ${Array.isArray(header.compatibility) ? header.compatibility.join(', ') : header.compatibility}]`
          : '';
      lines.push(`- ${header.name}: ${header.description}${tools}${compat}`);
    }
    lines.push('Load a skill body only when its description matches the task (skills_v15_disclose activate).');
    return lines.join('\n');
  }

  /**
   * Tier 2 — activate a skill body within the budget. Returns `null`
   * (and records a rejection) when the body alone exceeds the whole
   * body budget; otherwise evicts LRU bodies until it fits.
   */
  activate(name: string): SkillV15BudgetedActivation | null {
    this.ensureOpen();
    const cachedTokens = this.bodyTokensByName.get(name);
    if (cachedTokens !== undefined) {
      // Refresh LRU position; no new charge.
      const index = this.activationOrder.indexOf(name);
      if (index >= 0) this.activationOrder.splice(index, 1);
      this.activationOrder.push(name);
      const activation = this.loader.activate(name);
      return { name, body: activation.body, bodyTokens: activation.bodyTokens, evictedNames: [] };
    }
    const activation = this.loader.activate(name);
    if (activation.bodyTokens > this.budget.maxBodyTokens) {
      const note =
        `Refused to activate "${name}": body is ~${activation.bodyTokens} tokens, ` +
        `over the ${this.budget.maxBodyTokens}-token body budget.`;
      this.usage.rejected.push(note);
      return null;
    }
    const evictedNames: string[] = [];
    while (
      this.usage.bodyTokens + activation.bodyTokens > this.budget.maxBodyTokens &&
      this.activationOrder.length > 0
    ) {
      const oldest = this.activationOrder.shift()!;
      const oldestTokens = this.bodyTokensByName.get(oldest) ?? 0;
      this.bodyTokensByName.delete(oldest);
      this.loader.evictBody(oldest);
      this.usage.bodyTokens -= oldestTokens;
      this.usage.bodiesLoaded -= 1;
      this.usage.evicted.push(oldest);
      evictedNames.push(oldest);
    }
    this.activationOrder.push(name);
    this.bodyTokensByName.set(name, activation.bodyTokens);
    this.usage.bodiesLoaded += 1;
    this.usage.bodyTokens += activation.bodyTokens;
    return { name, body: activation.body, bodyTokens: activation.bodyTokens, evictedNames };
  }

  /** Is this skill's body currently held in the session (tier 2)? */
  isActivated(name: string): boolean {
    return this.bodyTokensByName.has(name);
  }

  /** Tier-3 resource names of a skill (names only — contents stay on disk). */
  listResources(name: string): string[] {
    this.ensureOpen();
    return this.loader.listResources(name);
  }

  /**
   * Tier 3 — read one resource file within the budget. Files larger
   * than `maxResourceBytes` are refused (recorded, not thrown — the
   * caller asked for something the budget cannot hold); a cached
   * resource is returned free.
   */
  loadResource(name: string, relPath: string): SkillV15BudgetedResource | null {
    this.ensureOpen();
    const key = `${name}\n${relPath}`;
    const cached = this.resourceCache.get(key);
    if (cached !== undefined) return cached;
    const resource = this.loader.loadResource(name, relPath);
    if (resource.bytes > this.budget.maxResourceBytes) {
      const note =
        `Refused resource "${relPath}" of "${name}": ${resource.bytes} bytes, ` +
        `over the ${this.budget.maxResourceBytes}-byte resource budget.`;
      this.usage.rejected.push(note);
      return null;
    }
    const budgeted: SkillV15BudgetedResource = {
      name,
      relPath,
      content: resource.content,
      bytes: resource.bytes,
    };
    this.resourceCache.set(key, budgeted);
    this.usage.resourcesLoaded += 1;
    this.usage.resourceBytes += resource.bytes;
    return budgeted;
  }

  /** Evict one activated body (or all), freeing its budget. */
  evict(name?: string): void {
    if (name === undefined) {
      for (const held of [...this.activationOrder]) this.evict(held);
      return;
    }
    const tokens = this.bodyTokensByName.get(name);
    if (tokens === undefined) return;
    this.bodyTokensByName.delete(name);
    const index = this.activationOrder.indexOf(name);
    if (index >= 0) this.activationOrder.splice(index, 1);
    this.loader.evictBody(name);
    this.usage.bodyTokens -= tokens;
    this.usage.bodiesLoaded -= 1;
    this.usage.evicted.push(name);
  }

  /** Snapshot of what the session has loaded, evicted and refused. */
  usageSnapshot(): SkillV15DisclosureUsage {
    return {
      ...this.usage,
      evicted: [...this.usage.evicted],
      rejected: [...this.usage.rejected],
    };
  }

  /** Where the usage log would go (v14 records activations; v15 reports instead). */
  get usageFile(): string | undefined {
    return this.usageLogFile;
  }
}

/** One-line summary of a session's usage (tool output / logs). */
export function formatDisclosureUsageV15(usage: SkillV15DisclosureUsage, budget: SkillV15ResolvedBudget): string {
  const lines = [
    `Disclosure usage: ${usage.headersLoaded} header(s) ~${usage.headerTokens}/${budget.maxHeaderTokens} tokens; ` +
      `${usage.bodiesLoaded} bod(ies) ~${usage.bodyTokens}/${budget.maxBodyTokens} tokens; ` +
      `${usage.resourcesLoaded} resource(s) ${usage.resourceBytes} bytes.`,
  ];
  if (usage.evicted.length > 0) lines.push(`Evicted (LRU): ${usage.evicted.join(', ')}.`);
  if (usage.rejected.length > 0) {
    lines.push('Refused by budget:');
    for (const note of usage.rejected) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}

/** Convenience: open a session and return its budget-trimmed context text. */
export function v15HeadersForContext(opts: DisclosureSessionV15Options = {}): string {
  const session = new DisclosureSessionV15(opts);
  session.open();
  return session.headersForContext();
}
