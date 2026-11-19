/**
 * Automation templates v27 — scheduled automation templates (v1.40, Team T6).
 *
 * A template is a ready-made scheduled automation ("review PRs every
 * morning", "summarise memory every night"). The operator picks a
 * template, binds it to a bot + repo, and the fleet runs it on a
 * local cron-like schedule — no cloud, no server: the host evaluates
 * `dueAutomations(nowMs)` on its own tick and runs what is due.
 *
 * Three pieces:
 * - The built-in catalog (8 templates, each with a default cron, a
 *   default task, the bot tags it fits, and the params it needs).
 * - A small 5-field cron parser/validator + next-run calculator
 *   (minute hour day-of-month month day-of-week; supports `*`,
 *   lists, ranges, steps, and named presets like `daily-08-00`).
 * - The automation store: automations created FROM a template, with
 *   enable/disable, due checks, and run bookkeeping.
 * - Suggestions: rank the catalog for the operator's current repo/bot
 *   context, with a reason per suggestion (pure scoring, no model).
 *
 * Follows the `fleetV25/schedules.ts` idea (cron + conditions) but is
 * a fresh, smaller implementation for v27 templates only — v25 owns
 * its own schedules and this module never imports it.
 */

/** A 5-field cron expression (minute hour dom month dow). */
export interface FleetV27CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

/** Result of validating a cron string. */
export interface FleetV27CronValidation {
  /** true when the string parses as a cron (or a known preset). */
  valid: boolean;
  /** Parsed expression (null when invalid). */
  cron: FleetV27CronExpression | null;
  /** Problems found (empty when valid). */
  errors: string[];
  /** Preset name when the input was a preset (null otherwise). */
  preset: string | null;
}

/** Named presets (short, memorable, local-time). */
export const FLEET_V27_CRON_PRESETS: Readonly<Record<string, string>> = {
  'hourly': '0 * * * *',
  'daily-06-00': '0 6 * * *',
  'daily-08-00': '0 8 * * *',
  'daily-09-00': '0 9 * * *',
  'daily-18-00': '0 18 * * *',
  'nightly-02-00': '0 2 * * *',
  'nightly-23-00': '0 23 * * *',
  'weekly-monday-08-00': '0 8 * * 1',
  'weekly-friday-17-00': '0 17 * * 5',
  'monthly-first-08-00': '0 8 1 * *',
};

const CRON_FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

function parseCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true;
  const parts = field.split(',');
  for (const part of parts) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step < 1) return false;
      if (base !== '*' && !parseCronField(base, min, max)) return false;
      continue;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) return false;
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < min || n > max) return false;
  }
  return true;
}

/** Parse a cron string or preset name into an expression. */
export function parseFleetV27Cron(text: string): FleetV27CronExpression | null {
  const trimmed = text.trim();
  const expanded = FLEET_V27_CRON_PRESETS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) return null;
  for (let i = 0; i < 5; i += 1) {
    const [min, max] = CRON_FIELD_RANGES[i];
    if (!parseCronField(fields[i], min, max)) return null;
  }
  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

/** Validate a cron string or preset name. */
export function validateFleetV27Cron(text: string): FleetV27CronValidation {
  const trimmed = text.trim();
  if (!trimmed) return { valid: false, cron: null, errors: ['empty-cron'], preset: null };
  const preset = trimmed in FLEET_V27_CRON_PRESETS ? trimmed : null;
  const cron = parseFleetV27Cron(trimmed);
  if (!cron) {
    return {
      valid: false,
      cron: null,
      errors: ['bad-cron: expected 5 fields (minute hour day-of-month month day-of-week) or a preset'],
      preset,
    };
  }
  return { valid: true, cron, errors: [], preset };
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  const parts = field.split(',');
  for (const part of parts) {
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = Number(stepStr);
      if (base === '*') {
        if ((value - min) % step === 0) return true;
      } else if (base.includes('-')) {
        const [a, b] = base.split('-').map(Number);
        if (value >= a && value <= b && (value - a) % step === 0) return true;
      } else {
        const start = Number(base);
        if (value >= start && (value - start) % step === 0) return true;
      }
      continue;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (value >= a && value <= b) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}

/**
 * Next run after `fromMs` (local time). Scans minute by minute, up
 * to 366 days ahead; returns null when nothing matches in that window
 * (e.g. Feb 30 — which the validator already refuses).
 */
export function nextFleetV27CronRunMs(cron: FleetV27CronExpression, fromMs: number): number | null {
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= limit) {
    const minute = cursor.getMinutes();
    const hour = cursor.getHours();
    const dom = cursor.getDate();
    const month = cursor.getMonth() + 1;
    const dow = cursor.getDay();
    const dowValue = dow === 0 ? 0 : dow;
    const domMatch = fieldMatches(cron.dayOfMonth, dom, 1, 31);
    const dowMatch = fieldMatches(cron.dayOfWeek, dowValue, 0, 7)
      || (dowValue === 0 && fieldMatches(cron.dayOfWeek, 7, 0, 7));
    // Cron semantics: dom AND dow when both are restricted is AND here
    // (documented simplification — v25 uses the same rule for its UI).
    const dayMatch = cron.dayOfMonth === '*' && cron.dayOfWeek === '*'
      ? true
      : cron.dayOfMonth === '*'
        ? dowMatch
        : cron.dayOfWeek === '*'
          ? domMatch
          : domMatch && dowMatch;
    if (
      fieldMatches(cron.minute, minute, 0, 59)
      && fieldMatches(cron.hour, hour, 0, 23)
      && fieldMatches(cron.month, month, 1, 12)
      && dayMatch
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** Human description of a cron expression (English; UI uses i18n). */
export function describeFleetV27Cron(cron: FleetV27CronExpression): string {
  const preset = Object.entries(FLEET_V27_CRON_PRESETS)
    .find(([, v]) => {
      const p = parseFleetV27Cron(v);
      return p && p.minute === cron.minute && p.hour === cron.hour
        && p.dayOfMonth === cron.dayOfMonth && p.month === cron.month && p.dayOfWeek === cron.dayOfWeek;
    });
  if (preset) return `preset ${preset[0]} (${preset[1]})`;
  return `${cron.minute} ${cron.hour} ${cron.dayOfMonth} ${cron.month} ${cron.dayOfWeek}`;
}

/** Template categories. */
export type FleetV27TemplateCategory = 'review' | 'memory' | 'health' | 'maintenance' | 'triage' | 'report';

/** One parameter a template accepts. */
export interface FleetV27TemplateParam {
  /** Param key (used in the automation's params map). */
  key: string;
  /** Human label. */
  label: string;
  /** Default value. */
  defaultValue: string;
  /** True = the automation cannot be created without it. */
  required: boolean;
}

/** One built-in automation template. */
export interface FleetV27Template {
  /** Stable id, e.g. `pr-review-morning`. */
  id: string;
  /** Human name. */
  name: string;
  /** What it does. */
  description: string;
  /** Category. */
  category: FleetV27TemplateCategory;
  /** Default schedule (cron or preset name). */
  defaultCron: string;
  /** Default task text (params are substituted as `{key}`). */
  defaultTask: string;
  /** Bot tags this template fits best (empty = any bot). */
  suggestedBotTags: string[];
  /** Capabilities a bot needs (e.g. `git`, `memory-write`). */
  requiredCapabilities: string[];
  /** Parameters the operator fills in. */
  params: FleetV27TemplateParam[];
}

/** The built-in catalog (8 templates). */
export const FLEET_V27_TEMPLATES: readonly FleetV27Template[] = [
  {
    id: 'pr-review-morning',
    name: 'Review PRs every morning',
    description: 'Each morning, review open pull requests in the repo and leave a short summary per PR.',
    category: 'review',
    defaultCron: 'daily-08-00',
    defaultTask: 'Review open pull requests in {repo} and summarise each: what changed, risks, and whether it is ready to merge.',
    suggestedBotTags: ['review', 'coding'],
    requiredCapabilities: ['git', 'repo-read'],
    params: [
      { key: 'repo', label: 'Repository path or URL', defaultValue: '.', required: true },
      { key: 'maxPrs', label: 'Max PRs per run', defaultValue: '10', required: false },
    ],
  },
  {
    id: 'memory-digest-nightly',
    name: 'Summarise memory every night',
    description: 'Each night, condense the day\'s new memories into a short digest and prune stale facts.',
    category: 'memory',
    defaultCron: 'nightly-23-00',
    defaultTask: 'Summarise today\'s new memories for bot {bot} into a nightly digest; flag facts that look stale.',
    suggestedBotTags: ['memory'],
    requiredCapabilities: ['memory-read', 'memory-write'],
    params: [
      { key: 'bot', label: 'Bot id', defaultValue: '', required: true },
      { key: 'days', label: 'Days to cover', defaultValue: '1', required: false },
    ],
  },
  {
    id: 'fleet-health-hourly',
    name: 'Fleet health check hourly',
    description: 'Every hour, check every bot\'s health and report any bot that dropped below the healthy band.',
    category: 'health',
    defaultCron: 'hourly',
    defaultTask: 'Check fleet health: list bots below the healthy band with their scores and last errors.',
    suggestedBotTags: ['ops', 'health'],
    requiredCapabilities: ['health-read'],
    params: [],
  },
  {
    id: 'dependency-audit-weekly',
    name: 'Dependency audit weekly',
    description: 'Every Monday, audit the repo\'s dependencies for outdated packages and known advisories.',
    category: 'maintenance',
    defaultCron: 'weekly-monday-08-00',
    defaultTask: 'Audit dependencies in {repo}: list outdated packages and any with known security advisories.',
    suggestedBotTags: ['coding', 'maintenance'],
    requiredCapabilities: ['repo-read'],
    params: [
      { key: 'repo', label: 'Repository path or URL', defaultValue: '.', required: true },
    ],
  },
  {
    id: 'inbox-triage-morning',
    name: 'Triage inbox every morning',
    description: 'Each morning, triage the team inbox: label, prioritise, and draft replies for the obvious ones.',
    category: 'triage',
    defaultCron: 'daily-09-00',
    defaultTask: 'Triage the inbox for {team}: label and prioritise new items, draft replies for routine ones.',
    suggestedBotTags: ['triage', 'ops'],
    requiredCapabilities: ['inbox-read'],
    params: [
      { key: 'team', label: 'Team or inbox name', defaultValue: 'default', required: false },
    ],
  },
  {
    id: 'backup-weekly',
    name: 'Weekly backup check',
    description: 'Every Friday, verify the fleet backup exists, is recent, and restores cleanly (dry run).',
    category: 'maintenance',
    defaultCron: 'weekly-friday-17-00',
    defaultTask: 'Verify the fleet backup: exists, recent (under 7 days), and restores in a dry run.',
    suggestedBotTags: ['ops', 'maintenance'],
    requiredCapabilities: ['backup-read'],
    params: [],
  },
  {
    id: 'changelog-weekly',
    name: 'Weekly changelog draft',
    description: 'Every Friday, draft a changelog from the week\'s merged work for the operator to review.',
    category: 'report',
    defaultCron: 'weekly-friday-17-00',
    defaultTask: 'Draft this week\'s changelog for {repo} from merged PRs and commits.',
    suggestedBotTags: ['coding', 'docs'],
    requiredCapabilities: ['git', 'repo-read'],
    params: [
      { key: 'repo', label: 'Repository path or URL', defaultValue: '.', required: true },
    ],
  },
  {
    id: 'cost-report-daily',
    name: 'Daily cost report',
    description: 'Every evening, report the fleet\'s model usage and estimated cost for the day.',
    category: 'report',
    defaultCron: 'daily-18-00',
    defaultTask: 'Report today\'s fleet model usage and estimated cost per bot.',
    suggestedBotTags: ['ops', 'report'],
    requiredCapabilities: ['usage-read'],
    params: [],
  },
];

/** Find a template by id (undefined when absent). */
export function findFleetV27Template(id: string): FleetV27Template | undefined {
  return FLEET_V27_TEMPLATES.find((t) => t.id === id);
}

/** List templates, optionally filtered by category. */
export function listFleetV27Templates(category?: FleetV27TemplateCategory | null): FleetV27Template[] {
  if (!category) return [...FLEET_V27_TEMPLATES];
  return FLEET_V27_TEMPLATES.filter((t) => t.category === category);
}

/** Substitute `{key}` params into a task template. */
export function renderFleetV27TaskText(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_m, key: string) => params[key] ?? `{${key}}`);
}

/** Context the suggestion engine scores templates against. */
export interface FleetV27SuggestContext {
  /** Repo path/URL the operator works in (null = none). */
  repoPath?: string | null;
  /** True when the repo is a git checkout. */
  hasGit?: boolean;
  /** Tags of the bot(s) the operator uses. */
  botTags?: string[];
  /** How many bots are in the fleet. */
  botCount?: number;
  /** Capabilities the bots have (e.g. `git`, `memory-write`). */
  capabilities?: string[];
  /** Local hour of day (0-23) for time-of-day weighting. */
  hourOfDay?: number;
}

/** One scored suggestion. */
export interface FleetV27TemplateSuggestion {
  /** Template id. */
  templateId: string;
  /** Score 0..100 (higher = better fit). */
  score: number;
  /** Why this template fits (English). */
  reasons: string[];
}

/** Rank the catalog for a context (pure scoring, no model). */
export function suggestFleetV27Templates(
  ctx: FleetV27SuggestContext,
  limit = 5,
): FleetV27TemplateSuggestion[] {
  const botTags = new Set(ctx.botTags ?? []);
  const caps = new Set(ctx.capabilities ?? []);
  const hour = ctx.hourOfDay ?? new Date().getHours();
  const scored: FleetV27TemplateSuggestion[] = FLEET_V27_TEMPLATES.map((t) => {
    let score = 30; // base: every template is usable
    const reasons: string[] = [];
    const tagHits = t.suggestedBotTags.filter((tag) => botTags.has(tag));
    if (tagHits.length > 0) {
      score += 20 * tagHits.length;
      reasons.push(`matches bot tag(s): ${tagHits.join(', ')}`);
    }
    const missingCaps = t.requiredCapabilities.filter((c) => caps.size > 0 && !caps.has(c));
    if (caps.size > 0 && missingCaps.length === 0) {
      score += 15;
      reasons.push('bot has all required capabilities');
    } else if (missingCaps.length > 0) {
      score -= 12 * missingCaps.length;
      reasons.push(`missing capabilities: ${missingCaps.join(', ')}`);
    }
    if (ctx.repoPath && t.defaultTask.includes('{repo}')) {
      score += 10;
      reasons.push('uses the current repo');
    }
    if (ctx.hasGit && t.requiredCapabilities.includes('git')) {
      score += 10;
      reasons.push('repo is a git checkout');
    }
    if (t.category === 'memory' && (ctx.botCount ?? 0) >= 2) {
      score += 5;
      reasons.push('fleet has several bots sharing memory');
    }
    // Morning templates score higher in the morning, nightly at night.
    if (t.defaultCron.includes('08-00') && hour >= 6 && hour < 12) score += 5;
    if (t.defaultCron.includes('nightly') && hour >= 20) score += 5;
    if (t.defaultCron.includes('23-00') && hour >= 20) score += 5;
    return { templateId: t.id, score: Math.max(0, Math.min(100, score)), reasons };
  });
  scored.sort((a, b) => b.score - a.score || a.templateId.localeCompare(b.templateId));
  return scored.slice(0, Math.max(1, limit));
}

/** One scheduled automation created from a template. */
export interface FleetV27Automation {
  /** Stable id, e.g. `auto-0001`. */
  id: string;
  /** Template it was created from. */
  templateId: string;
  /** Human name (defaults to the template name). */
  name: string;
  /** Bot that runs it. */
  botId: string;
  /** Repo path/URL it works in (null = none). */
  repoPath: string | null;
  /** Schedule (cron or preset name, as entered). */
  cron: string;
  /** Rendered task text (params already substituted). */
  taskText: string;
  /** Params as entered. */
  params: Record<string, string>;
  /** Enabled = the host will run it when due. */
  enabled: boolean;
  /** Creation time. */
  createdAtMs: number;
  /** Last run time (null = never ran). */
  lastRunAtMs: number | null;
  /** Next scheduled run (null = no future run / invalid cron). */
  nextRunAtMs: number | null;
  /** How many times it ran. */
  runCount: number;
}

/** Validation problems for an automation. */
export type FleetV27AutomationValidationReason =
  | 'ok'
  | 'template-not-found'
  | 'missing-bot'
  | 'bad-cron'
  | 'missing-param'
  | 'automation-not-found';

/**
 * Store for automations created from templates (in-memory, JSON round-trip).
 * The host ticks `dueAutomations(nowMs)` and runs what is due.
 */
export class FleetV27AutomationStore {
  private automations = new Map<string, FleetV27Automation>();
  private seq = 0;

  /** Create an automation from a template (validates params + cron). */
  createFromTemplate(input: {
    templateId: string;
    botId: string;
    repoPath?: string | null;
    cron?: string | null;
    name?: string | null;
    params?: Record<string, string>;
    createdAtMs?: number;
  }): { ok: boolean; automation?: FleetV27Automation; reasons: FleetV27AutomationValidationReason[] } {
    const template = findFleetV27Template(input.templateId);
    if (!template) return { ok: false, reasons: ['template-not-found'] };
    const reasons: FleetV27AutomationValidationReason[] = [];
    if (!input.botId || !input.botId.trim()) reasons.push('missing-bot');
    const cronText = (input.cron ?? template.defaultCron).trim();
    const validation = validateFleetV27Cron(cronText);
    if (!validation.valid) reasons.push('bad-cron');
    const params: Record<string, string> = {};
    for (const p of template.params) {
      const given = input.params?.[p.key];
      if (given !== undefined && given !== '') params[p.key] = given;
      else if (p.defaultValue !== '') params[p.key] = p.defaultValue;
      else if (p.required) reasons.push('missing-param');
    }
    // Keep extra params the operator passed (harmless, rendered too).
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (!(k in params)) params[k] = v;
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const nowMs = input.createdAtMs ?? Date.now();
    const cron = validation.cron as FleetV27CronExpression;
    this.seq += 1;
    const automation: FleetV27Automation = {
      id: `auto-${String(this.seq).padStart(4, '0')}`,
      templateId: template.id,
      name: input.name?.trim() || template.name,
      botId: input.botId.trim(),
      repoPath: input.repoPath?.trim() || null,
      cron: cronText,
      taskText: renderFleetV27TaskText(template.defaultTask, {
        ...params,
        bot: input.botId.trim(),
        repo: input.repoPath?.trim() || params.repo || '.',
      }),
      params,
      enabled: true,
      createdAtMs: nowMs,
      lastRunAtMs: null,
      nextRunAtMs: nextFleetV27CronRunMs(cron, nowMs),
      runCount: 0,
    };
    this.automations.set(automation.id, automation);
    return { ok: true, automation, reasons: [] };
  }

  /** Get an automation by id. */
  getAutomation(id: string): FleetV27Automation | undefined {
    return this.automations.get(id);
  }

  /** List automations (newest first), optionally filtered. */
  listAutomations(filter: { templateId?: string | null; botId?: string | null; enabled?: boolean | null } = {}): FleetV27Automation[] {
    const all = [...this.automations.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
    return all.filter((a) => {
      if (filter.templateId && a.templateId !== filter.templateId) return false;
      if (filter.botId && a.botId !== filter.botId) return false;
      if (filter.enabled !== undefined && filter.enabled !== null && a.enabled !== filter.enabled) return false;
      return true;
    });
  }

  /** Enable / disable an automation. */
  setEnabled(id: string, enabled: boolean): boolean {
    const a = this.automations.get(id);
    if (!a) return false;
    a.enabled = enabled;
    return true;
  }

  /** Remove an automation. */
  removeAutomation(id: string): boolean {
    return this.automations.delete(id);
  }

  /** Automations that are enabled and due at `nowMs` (sorted by due time). */
  dueAutomations(nowMs: number = Date.now()): FleetV27Automation[] {
    return [...this.automations.values()]
      .filter((a) => a.enabled && a.nextRunAtMs !== null && a.nextRunAtMs <= nowMs)
      .sort((a, b) => (a.nextRunAtMs ?? 0) - (b.nextRunAtMs ?? 0));
  }

  /** Record that an automation ran: bumps count, recomputes next run. */
  markRan(id: string, nowMs: number = Date.now()): FleetV27Automation | null {
    const a = this.automations.get(id);
    if (!a) return null;
    a.lastRunAtMs = nowMs;
    a.runCount += 1;
    const cron = parseFleetV27Cron(a.cron);
    a.nextRunAtMs = cron ? nextFleetV27CronRunMs(cron, nowMs) : null;
    return a;
  }

  /** JSON round-trip. */
  toJSON(): { automations: FleetV27Automation[]; seq: number } {
    return { automations: [...this.automations.values()], seq: this.seq };
  }

  /** Restore from `toJSON` output (replaces current state). */
  static fromJSON(data: { automations?: FleetV27Automation[]; seq?: number }): FleetV27AutomationStore {
    const store = new FleetV27AutomationStore();
    for (const a of data.automations ?? []) store.automations.set(a.id, a);
    store.seq = data.seq ?? store.automations.size;
    return store;
  }
}
