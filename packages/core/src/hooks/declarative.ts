/**
 * Declarative hooks — hooks declared in a JSON config file instead of
 * code (v1.07, Team T4).
 *
 * Idea learned from Claude Code's hooks layer (public docs, 2026):
 * a hook is a script/config declaration that runs at a lifecycle
 * point (PreToolUse / PostToolUse / Stop / SessionStart, …). open-bot
 * already had function hooks, script hooks (`registerScriptHook`) and
 * shell-command hooks from settings (`registerCommandHook`); what was
 * missing was a FILE a project can ship — `.open-bot/hooks.json` —
 * that declares hooks without touching settings or code, so a project
 * (or a plugin bundle author) can say "run this script before every
 * shell call" in version control.
 *
 * File format (`hooks.json`, version 1):
 *
 *   {
 *     "version": 1,
 *     "hooks": [
 *       { "name": "guard-rm", "script": "hooks/guard.mjs",
 *         "events": ["PreToolUse"], "matcher": ["shell_exec"],
 *         "description": "Block dangerous shell commands." },
 *       { "name": "fmt", "command": "npm run format",
 *         "events": ["PostToolUse"], "matcher": ["write_file"] },
 *       { "name": "cleanup", "script": "hooks/cleanup.mjs",
 *         "events": ["Stop"], "enabled": false }
 *     ]
 *   }
 *
 * - `script` is a path relative to the config file's directory
 *   (`.js`/`.mjs`/`.cjs`, run via `node`, stdin = event JSON, last
 *   stdout line = decision — same protocol as `scriptRunner.ts`).
 *   It must stay inside the config dir (+ extra `allowedDirs`) and
 *   must exist — a dangling script fails validation, never the run.
 * - `command` is a shell command (same protocol + validation as the
 *   settings command hooks: exit 0 = allow, 2 = block; secret-looking
 *   env keys are rejected).
 * - Exactly one of `script` / `command` per hook; `events` is a
 *   non-empty subset of the lifecycle events; `matcher` / `priority` /
 *   `timeoutMs` follow the same rules as the registry.
 * - Validation never executes anything. Applying a config registers
 *   each hook into the given HookRegistry; one bad entry never blocks
 *   the others (reported in `invalid`), and a disabled entry is
 *   recorded in `skipped`, not registered.
 *
 * Also in this module: two small factories for the two lifecycle
 * points the v1.07 brief calls out explicitly — a SessionStart hook
 * that injects context (`createSessionStartContextHook`) and a Stop
 * hook that runs cleanup callbacks (`createStopCleanupHook`). A Stop
 * hook cannot block anything (there is nothing left to stop), so the
 * cleanup hook always allows and never lets a cleanup error crash
 * the run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ALL_HOOK_EVENTS,
  HOOK_NAME_RE,
} from './types';
import type {
  HookContext,
  HookDefinition,
  HookEvent,
  HookEventKind,
  HookMatcher,
} from './types';
import { normalizeHookMatcher, validateHookPriority, validateHookTimeoutMs } from './matcher';
import { resolveHookScriptPath } from './scriptRunner';
import { validateHookCommandEntry } from './shellCommandRunner';
import type { HookCommandSettingsEntry } from './types';

/** Config file name, looked up in the workspace (`.open-bot/hooks.json` first). */
export const HOOKS_CONFIG_FILE = 'hooks.json';
/** Default location of the declarative hooks file, relative to the workspace root. */
export const DEFAULT_HOOKS_CONFIG_REL_PATH = path.join('.open-bot', HOOKS_CONFIG_FILE);
/** Legacy/alternate location: workspace-root `hooks.json`. */
export const LEGACY_HOOKS_CONFIG_REL_PATH = HOOKS_CONFIG_FILE;
/** Only config version understood by this module. */
export const HOOKS_CONFIG_VERSION = 1;

const HOOK_SCRIPT_EXT_RE = /\.(?:mjs|cjs|js)$/i;

/** One hook as declared in a hooks.json file. */
export interface HookConfigEntry {
  name: string;
  description?: string;
  /** Script path, as written in the config (relative to the config file's directory). */
  script?: string;
  /** Shell command (alternative to `script`). */
  command?: string;
  events: HookEventKind[];
  matcher?: HookMatcher;
  priority?: number;
  timeoutMs?: number;
  /** Extra env for a command hook (secret-looking keys rejected at parse time). */
  env?: Record<string, string>;
  /** Default true. `false` ships the hook disabled (recorded as skipped, not registered). */
  enabled?: boolean;
}

/** A parsed entry: like HookConfigEntry, but `script` is resolved to an absolute path. */
export interface ParsedHookConfigEntry extends HookConfigEntry {
  /** Absolute script path (when the hook is script-backed). */
  resolvedScript?: string;
}

export interface ParseHooksConfigResult {
  entries: ParsedHookConfigEntry[];
  /** One human-readable issue per problem (`hooks[i].field: message`). */
  issues: string[];
}

export interface ApplyHooksConfigOptions {
  /** Working directory hook scripts/commands run in (bot workspace). Defaults to the config dir. */
  workspaceDir?: string;
  /** Extra directories script files may live in (in addition to the config dir). */
  allowedDirs?: string[];
  /** Where non-decision script output is logged. */
  logger?: (message: string) => void;
}

export interface ApplyHooksConfigResult {
  /** Names registered into the registry. */
  applied: string[];
  /** Names shipped disabled (`enabled: false`) — recorded, not registered. */
  skipped: string[];
  /** Entries that failed to register (never thrown — one bad hook must not break the rest). */
  invalid: Array<{ name: string; issues: string[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function validateMatcher(raw: unknown, where: string, issues: string[]): HookMatcher | undefined {
  if (raw === undefined) return undefined;
  try {
    const normalized = normalizeHookMatcher(raw as string | string[]);
    if (normalized === undefined || normalized.length === 0) {
      issues.push(`${where}.matcher: must be a non-empty string or list of strings`);
      return undefined;
    }
    return normalized.length === 1 ? normalized[0]! : normalized;
  } catch (err) {
    issues.push(`${where}.matcher: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Parse + validate a raw hooks config (parsed JSON). `baseDir` is the
 * directory `script` paths resolve against (the config file's
 * directory); scripts must exist inside it (+ `allowedDirs`) or the
 * entry is invalid. Never throws for bad input — issues are data.
 */
export function parseHooksConfig(
  raw: unknown,
  opts: { baseDir?: string; allowedDirs?: string[] } = {},
): ParseHooksConfigResult {
  const issues: string[] = [];
  const entries: ParsedHookConfigEntry[] = [];
  if (!isRecord(raw)) {
    return { entries, issues: ['hooks config: must be a JSON object'] };
  }
  if (raw['version'] !== undefined && raw['version'] !== HOOKS_CONFIG_VERSION) {
    return {
      entries,
      issues: [`version: unsupported hooks config version ${JSON.stringify(raw['version'])} (expected ${HOOKS_CONFIG_VERSION})`],
    };
  }
  const hooksRaw = raw['hooks'];
  if (!Array.isArray(hooksRaw)) {
    return { entries, issues: ['hooks: must be a list of hook declarations'] };
  }
  const baseDir = opts.baseDir !== undefined ? path.resolve(opts.baseDir) : undefined;
  const allowedDirs = [
    ...(baseDir !== undefined ? [baseDir] : []),
    ...((opts.allowedDirs ?? []).filter((d) => typeof d === 'string' && d !== '')),
  ];
  const seenNames = new Set<string>();
  hooksRaw.forEach((item, index) => {
    const where = `hooks[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${where}: must be an object`);
      return;
    }
    const name = cleanString(item['name']);
    if (!name || !HOOK_NAME_RE.test(name)) {
      issues.push(`${where}.name: must match ${HOOK_NAME_RE}`);
      return;
    }
    if (seenNames.has(name)) {
      issues.push(`${where}.name: duplicate hook name ${JSON.stringify(name)}`);
      return;
    }
    seenNames.add(name);
    const eventsRaw = item['events'];
    let events: HookEventKind[] | undefined;
    if (Array.isArray(eventsRaw)) {
      const valid = eventsRaw.filter(
        (e): e is HookEventKind =>
          typeof e === 'string' && (ALL_HOOK_EVENTS as string[]).includes(e),
      );
      if (valid.length === eventsRaw.length && valid.length > 0) {
        events = [...new Set(valid)];
      }
    }
    if (!events) {
      issues.push(`${where}.events: must be a non-empty list drawn from ${ALL_HOOK_EVENTS.join(', ')}`);
      return;
    }
    const hasScript = typeof item['script'] === 'string' && item['script'].trim() !== '';
    const hasCommand = typeof item['command'] === 'string' && item['command'].trim() !== '';
    if (hasScript === hasCommand) {
      issues.push(`${where}: declare exactly one of "script" or "command"`);
      return;
    }
    const entry: ParsedHookConfigEntry = { name, events };
    if (typeof item['description'] === 'string' && item['description'].trim() !== '') {
      entry.description = item['description'].trim();
    }
    if (typeof item['enabled'] === 'boolean') entry.enabled = item['enabled'];
    else if (item['enabled'] !== undefined) {
      issues.push(`${where}.enabled: must be a boolean`);
      return;
    }
    if (hasScript) {
      const script = (item['script'] as string).trim();
      if (!HOOK_SCRIPT_EXT_RE.test(script)) {
        issues.push(`${where}.script: must be a .js/.mjs/.cjs file (run via node)`);
        return;
      }
      if (baseDir === undefined || allowedDirs.length === 0) {
        issues.push(`${where}.script: no base directory to resolve the script against`);
        return;
      }
      try {
        // Reuse the script-hook resolver: existence + containment
        // inside the allowed dirs, one validator for both call sites.
        entry.resolvedScript = resolveHookScriptPath(path.join(baseDir, script), allowedDirs);
        entry.script = script;
      } catch (err) {
        issues.push(`${where}.script: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const matcher = validateMatcher(item['matcher'], where, issues);
      if (item['matcher'] !== undefined && matcher === undefined) return;
      if (matcher !== undefined) entry.matcher = matcher;
      if (item['priority'] !== undefined) {
        try {
          entry.priority = validateHookPriority(item['priority'], name);
        } catch (err) {
          issues.push(`${where}.priority: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      if (item['timeoutMs'] !== undefined) {
        try {
          entry.timeoutMs = validateHookTimeoutMs(item['timeoutMs'], name);
        } catch (err) {
          issues.push(`${where}.timeoutMs: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
    }
    if (hasCommand) {
      const candidate: HookCommandSettingsEntry = {
        name,
        command: (item['command'] as string).trim(),
        events,
        ...(item['matcher'] !== undefined ? { matcher: item['matcher'] as string | string[] } : {}),
        ...(item['priority'] !== undefined ? { priority: item['priority'] as number } : {}),
        ...(item['timeoutMs'] !== undefined ? { timeoutMs: item['timeoutMs'] as number } : {}),
        ...(isRecord(item['env']) ? { env: item['env'] as Record<string, string> } : {}),
        ...(typeof item['description'] === 'string' ? { description: item['description'] } : {}),
        ...(typeof item['enabled'] === 'boolean' ? { enabled: item['enabled'] } : {}),
      };
      const result = validateHookCommandEntry(candidate);
      if (!result.valid || !result.entry) {
        for (const issue of result.issues) {
          issues.push(`${where}.${issue.field}: ${issue.message}`);
        }
        return;
      }
      entry.command = result.entry.command;
      if (result.entry.env !== undefined) entry.env = result.entry.env;
      if (result.entry.matcher !== undefined) entry.matcher = result.entry.matcher;
      if (result.entry.priority !== undefined) entry.priority = result.entry.priority;
      if (result.entry.timeoutMs !== undefined) entry.timeoutMs = result.entry.timeoutMs;
      if (result.entry.enabled !== undefined) entry.enabled = result.entry.enabled;
    }
    entries.push(entry);
  });
  return { entries, issues };
}

/** Read a hooks config file from disk and parse it. */
export function loadHooksConfigFile(
  filePath: string,
  opts: { allowedDirs?: string[] } = {},
): ParseHooksConfigResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { entries: [], issues: [`hooks config: cannot read ${filePath}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      entries: [],
      issues: [`hooks config: ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return parseHooksConfig(parsed, {
    baseDir: path.dirname(path.resolve(filePath)),
    allowedDirs: opts.allowedDirs,
  });
}

/**
 * Find declarative hooks config files in a workspace, in priority
 * order: `.open-bot/hooks.json` first, then workspace-root
 * `hooks.json`. Returns the paths that exist (may be empty).
 */
export function findHooksConfigFiles(workspaceDir: string): string[] {
  const found: string[] = [];
  for (const rel of [DEFAULT_HOOKS_CONFIG_REL_PATH, LEGACY_HOOKS_CONFIG_REL_PATH]) {
    const abs = path.join(workspaceDir, rel);
    try {
      if (fs.statSync(abs).isFile()) found.push(abs);
    } catch {
      // Not there — keep looking.
    }
  }
  return found;
}

/**
 * Register parsed config entries into a HookRegistry. Disabled
 * entries are recorded in `skipped` (not registered); a registration
 * failure is recorded in `invalid` and never thrown — one bad hook
 * must not break the rest of the config (or the agent).
 */
export function applyHooksConfig(
  registry: {
    registerScriptHook(def: {
      name: string;
      description?: string;
      events: HookEventKind[];
      source: 'settings';
      workspaceDir?: string;
      allowedDirs?: string[];
      timeoutMs?: number;
    }, scriptPath: string): unknown;
    registerCommandHook(entry: HookCommandSettingsEntry, opts?: { workspaceDir?: string }): unknown;
  },
  entries: readonly ParsedHookConfigEntry[],
  opts: ApplyHooksConfigOptions = {},
): ApplyHooksConfigResult {
  const result: ApplyHooksConfigResult = { applied: [], skipped: [], invalid: [] };
  for (const entry of entries) {
    if (entry.enabled === false) {
      result.skipped.push(entry.name);
      continue;
    }
    try {
      if (entry.resolvedScript !== undefined) {
        registry.registerScriptHook(
          {
            name: entry.name,
            description: entry.description,
            events: [...entry.events],
            source: 'settings',
            workspaceDir: opts.workspaceDir,
            allowedDirs: opts.allowedDirs,
            ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
          },
          entry.resolvedScript,
        );
      } else if (entry.command !== undefined) {
        registry.registerCommandHook(
          {
            name: entry.name,
            command: entry.command,
            events: [...entry.events],
            ...(entry.description !== undefined ? { description: entry.description } : {}),
            ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
            ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
            ...(entry.env !== undefined ? { env: entry.env } : {}),
            enabled: true,
          },
          { workspaceDir: opts.workspaceDir },
        );
      } else {
        result.invalid.push({ name: entry.name, issues: ['hook has neither script nor command'] });
        continue;
      }
      result.applied.push(entry.name);
    } catch (err) {
      result.invalid.push({
        name: entry.name,
        issues: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return result;
}

/**
 * Load a hooks config file and apply it to a registry, in one call.
 * Returns the parse issues (if any, nothing was applied) or the
 * apply result.
 */
export function loadAndApplyHooksConfig(
  registry: Parameters<typeof applyHooksConfig>[0],
  filePath: string,
  opts: ApplyHooksConfigOptions & { allowedDirs?: string[] } = {},
): { parseIssues: string[] } | { parseIssues: []; applied: ApplyHooksConfigResult } {
  const parsed = loadHooksConfigFile(filePath, { allowedDirs: opts.allowedDirs });
  if (parsed.issues.length > 0) return { parseIssues: parsed.issues };
  return { parseIssues: [], applied: applyHooksConfig(registry, parsed.entries, opts) };
}

// ---------------------------------------------------------------------------
// Lifecycle helpers: SessionStart context injection + Stop cleanup
// ---------------------------------------------------------------------------

export interface SessionStartContextHookOptions {
  description?: string;
  /** Run order within SessionStart (lower runs first). */
  priority?: number;
}

/**
 * Build a SessionStart hook that injects context into the session.
 * `contextProvider` returns the lines to inject (or null/undefined
 * for "nothing to add this time") — e.g. workspace rules, the active
 * skill index for the working directory, or a reminder. A provider
 * that throws is treated as "no context" (a context hook must never
 * break session start).
 */
export function createSessionStartContextHook(
  name: string,
  contextProvider: (event: HookEvent, ctx: HookContext) => string | string[] | null | undefined | Promise<string | string[] | null | undefined>,
  opts: SessionStartContextHookOptions = {},
): HookDefinition {
  return {
    name,
    description: opts.description ?? 'Inject extra context when a session starts.',
    events: ['SessionStart'],
    source: 'settings',
    enabled: true,
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    handler: async (event, ctx) => {
      let provided: string | string[] | null | undefined;
      try {
        provided = await contextProvider(event, ctx);
      } catch {
        return { action: 'allow' as const };
      }
      if (provided === null || provided === undefined) return { action: 'allow' as const };
      const lines = Array.isArray(provided) ? provided : [provided];
      const context = lines
        .map((line) => (typeof line === 'string' ? line.trim() : ''))
        .filter((line) => line.length > 0)
        .join('\n');
      if (context === '') return { action: 'allow' as const };
      return { action: 'modify' as const, context };
    },
  };
}

export interface StopCleanupHookOptions {
  description?: string;
  /** Where cleanup errors are reported (default: swallowed silently — a failed cleanup must never crash the run). */
  logger?: (message: string) => void;
}

/**
 * Build a Stop hook that runs cleanup callbacks when the agent
 * stops (user stop, abort, max-steps, …). Each callback runs in
 * order and is guarded: a throwing cleanup is reported to `logger`
 * (when given) and the next one still runs. The hook always returns
 * `allow` — a Stop hook cannot block anything, and a cleanup failure
 * must never surface as a run error.
 */
export function createStopCleanupHook(
  name: string,
  cleanup: ((event: HookEvent, ctx: HookContext) => void | Promise<void>) | Array<(event: HookEvent, ctx: HookContext) => void | Promise<void>>,
  opts: StopCleanupHookOptions = {},
): HookDefinition {
  const callbacks = Array.isArray(cleanup) ? cleanup : [cleanup];
  return {
    name,
    description: opts.description ?? 'Run cleanup callbacks when the agent stops.',
    events: ['Stop'],
    source: 'settings',
    enabled: true,
    handler: async (event, ctx) => {
      for (const fn of callbacks) {
        try {
          await fn(event, ctx);
        } catch (err) {
          if (opts.logger) {
            opts.logger(
              `Stop cleanup "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      return { action: 'allow' as const };
    },
  };
}
