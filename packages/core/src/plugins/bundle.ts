/**
 * Plugin bundle — one installable package carrying skills + hooks +
 * MCP servers (v1.07, Team T4).
 *
 * Idea learned from Claude Code's 7 extension layers (public docs,
 * 2026): a *plugin* is a bundle of a skill + hooks + MCP config that
 * installs as one unit. open-bot already had plugins (tools-only
 * entry file, `packages/tools/src/plugins/types.ts` — "later: skills /
 * MCP servers / hooks"), a skill registry, a hook registry and MCP
 * config; this module is the missing bundle layer that ties the three
 * together with one manifest and one validation pass.
 *
 * Bundle layout (a directory with `manifest.json` at its root):
 *
 *   my-bundle/
 *     manifest.json            (required — see PluginBundleManifest)
 *     index.js                 (optional — tool entry, `main`)
 *     skills/
 *       my-skill/SKILL.md      (optional — one dir per skill decl)
 *     hooks/
 *       guard.mjs              (optional — one script per script hook)
 *
 * Manifest (extends the tools-side plugin manifest — same `id`,
 * `name`, `version`, `description`, `permissions`, `main`; a bundle
 * may omit `main` when it contributes no tools):
 *
 *   {
 *     "id": "my-bundle", "name": "My Bundle", "version": "1.0.0",
 *     "description": "...", "permissions": ["fs"],
 *     "skills": [{ "dir": "skills/my-skill" }],
 *     "hooks": [
 *       { "name": "guard-rm", "script": "hooks/guard.mjs",
 *         "events": ["PreToolUse"], "matcher": ["shell_exec"] }
 *     ],
 *     "mcpServers": {
 *       "my-server": { "command": "npx", "args": ["-y", "x"] }
 *     }
 *   }
 *
 * Safety (fail-closed, install-time):
 * - Unknown permission strings are REJECTED (the catalog only flags
 *   them high-risk; a bundle is not installed until its manifest is
 *   fully understood).
 * - Skill dirs and hook scripts must live INSIDE the bundle (`..`
 *   escaping is rejected) and must exist on disk when a bundle
 *   directory is given — a half-copied bundle fails validation
 *   instead of half-activating.
 * - A hook declares exactly one of `script` / `command`; a script
 *   must be a `.js`/`.mjs`/`.cjs` file (the hook runner spawns
 *   `node <script>`); a command goes through the existing
 *   `validateHookCommandEntry` (secret-looking env keys rejected).
 * - MCP servers go through the same validator as mcp.json
 *   (`validateMcpServerConfig`).
 * - Validation never executes anything and never logs secret-looking
 *   values: issues name fields, not values.
 *
 * This module only validates + describes. Installing, activating
 * (registering skills/hooks, merging MCP servers) and uninstalling
 * live in `bundleInstall.ts` so validation stays usable without I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_HOOK_EVENTS, HOOK_NAME_RE } from '../hooks/types';
import type { HookEventKind } from '../hooks/types';
import { validateHookPriority, validateHookTimeoutMs } from '../hooks/matcher';
import { validateHookCommandEntry } from '../hooks/shellCommandRunner';
import type { HookCommandSettingsEntry } from '../hooks/types';
import { validateMcpServerConfig } from '../mcp/config';
import type { McpServerConfig } from '../mcp/types';

/** File name of the bundle manifest, at the bundle root. */
export const PLUGIN_BUNDLE_MANIFEST_FILE = 'manifest.json';

/** Plugin/bundle ids: `[A-Za-z0-9_-]+` (same rule as the tools-side loader). */
export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Permissions a bundle may declare (mirrors PLUGIN_PERMISSIONS). */
export type PluginBundlePermission = 'fs' | 'shell' | 'network' | 'mcp';

export const PLUGIN_BUNDLE_PERMISSIONS: readonly PluginBundlePermission[] = [
  'fs',
  'shell',
  'network',
  'mcp',
];

export const MAX_BUNDLE_SKILLS = 32;
export const MAX_BUNDLE_HOOKS = 32;
export const MAX_BUNDLE_MCP_SERVERS = 16;
export const MAX_BUNDLE_DEPENDENCIES = 32;

/** One skill contributed by the bundle: a directory inside the bundle holding SKILL.md files. */
export interface PluginBundleSkillDecl {
  /** Relative directory inside the bundle (e.g. `skills/my-skill`). */
  dir: string;
}

/** One hook contributed by the bundle: a script file OR a shell command, never both. */
export interface PluginBundleHookDecl {
  /** Unique hook name (same rule as HookDefinition names). */
  name: string;
  /** Human-readable description (shown in logs / Settings UI). */
  description?: string;
  /** Relative script path inside the bundle (`.js`/`.mjs`/`.cjs`), run via `node`. */
  script?: string;
  /** Shell command, run through the platform shell (settings-style command hook). */
  command?: string;
  /** Lifecycle events this hook runs for (non-empty). */
  events: HookEventKind[];
  /** Tool-name glob(s) for PreToolUse / PostToolUse. */
  matcher?: string | string[];
  /** Run order within one event (lower runs first). */
  priority?: number;
  /** Per-invocation timeout in ms. */
  timeoutMs?: number;
  /** Extra env for a command hook (secret-looking keys rejected). */
  env?: Record<string, string>;
  /** Default true. `false` ships the hook disabled. */
  enabled?: boolean;
}

/** One MCP server contributed by the bundle (same shape as mcp.json). */
export interface PluginBundleMcpServerDecl {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * The bundle manifest. `main` is OPTIONAL here (unlike the
 * tools-side PluginManifest): a bundle may contribute only skills /
 * hooks / MCP servers and no tools at all. When `main` is present it
 * is the tool entry file, loaded by the existing tools-side loader.
 */
export interface PluginBundleManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: PluginBundlePermission[];
  /** Tool entry file inside the bundle (optional for skill/hook-only bundles). */
  main?: string;
  skills?: PluginBundleSkillDecl[];
  hooks?: PluginBundleHookDecl[];
  mcpServers?: Record<string, McpServerConfig>;
  dependencies?: string[];
}

/** Thrown by `parsePluginBundleManifest` (validation failed). */
export class PluginBundleError extends Error {
  readonly issues: string[];
  readonly pluginId?: string;
  constructor(message: string, issues: string[], pluginId?: string) {
    super(message);
    this.name = 'PluginBundleError';
    this.issues = issues;
    this.pluginId = pluginId;
  }
}

export interface ValidateBundleManifestResult {
  valid: boolean;
  manifest?: PluginBundleManifest;
  /** One human-readable issue per problem (`field: message`). */
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const trimmed = item.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** A relative path inside the bundle: no absolute path, no `..` escape. */
export function isSafeBundleRelativePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.trim() === '') return false;
  if (path.isAbsolute(relPath)) return false;
  const segments = relPath.replace(/\\/g, '/').split('/');
  if (segments.some((s) => s === '..')) return false;
  if (segments.some((s) => s.length === 0)) return false;
  return true;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOOK_SCRIPT_EXT_RE = /\.(?:mjs|cjs|js)$/i;

/** Does a directory hold at least one skill (subdir with SKILL.md, or a loose *.md file)? */
function dirHasSkill(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      try {
        if (fs.statSync(path.join(dir, entry.name, 'SKILL.md')).isFile()) return true;
      } catch {
        // No SKILL.md here — keep looking.
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      return true;
    }
  }
  return false;
}

function validateHookDecl(
  raw: unknown,
  index: number,
  bundleDir: string | undefined,
  issues: string[],
): PluginBundleHookDecl | undefined {
  const where = `hooks[${index}]`;
  if (!isRecord(raw)) {
    issues.push(`${where}: must be an object`);
    return undefined;
  }
  const name = cleanString(raw['name']);
  if (!name || !HOOK_NAME_RE.test(name)) {
    issues.push(`${where}.name: must match ${HOOK_NAME_RE}`);
    return undefined;
  }
  const eventsRaw = raw['events'];
  let events: HookEventKind[] | undefined;
  if (Array.isArray(eventsRaw)) {
    const valid = eventsRaw.filter(
      (e): e is HookEventKind => typeof e === 'string' && (ALL_HOOK_EVENTS as string[]).includes(e),
    );
    if (valid.length === eventsRaw.length && valid.length > 0) events = [...new Set(valid)];
  }
  if (!events) {
    issues.push(
      `${where}.events: must be a non-empty list drawn from ${ALL_HOOK_EVENTS.join(', ')}`,
    );
    return undefined;
  }
  const hasScript = typeof raw['script'] === 'string' && raw['script'].trim() !== '';
  const hasCommand = typeof raw['command'] === 'string' && raw['command'].trim() !== '';
  if (hasScript === hasCommand) {
    issues.push(`${where}: declare exactly one of "script" or "command"`);
    return undefined;
  }
  const decl: PluginBundleHookDecl = { name, events };
  if (typeof raw['description'] === 'string' && raw['description'].trim() !== '') {
    decl.description = raw['description'].trim();
  }
  if (hasScript) {
    const script = (raw['script'] as string).trim();
    if (!isSafeBundleRelativePath(script)) {
      issues.push(`${where}.script: must be a relative path inside the bundle (no "..", no absolute path)`);
      return undefined;
    }
    if (!HOOK_SCRIPT_EXT_RE.test(script)) {
      issues.push(`${where}.script: must be a .js/.mjs/.cjs file (run via node)`);
      return undefined;
    }
    if (bundleDir !== undefined) {
      const abs = path.join(bundleDir, script);
      try {
        if (!fs.statSync(abs).isFile()) {
          issues.push(`${where}.script: file does not exist in the bundle`);
          return undefined;
        }
      } catch {
        issues.push(`${where}.script: file does not exist in the bundle`);
        return undefined;
      }
    }
    decl.script = script;
  }
  if (hasCommand) {
    // Reuse the settings command-hook validator: it checks the
    // command, events, env secret-looking keys, matcher, priority
    // and timeout — one validator for both declaration sites.
    const candidate: HookCommandSettingsEntry = {
      name,
      command: (raw['command'] as string).trim(),
      events,
      ...(raw['matcher'] !== undefined ? { matcher: raw['matcher'] as string | string[] } : {}),
      ...(raw['priority'] !== undefined ? { priority: raw['priority'] as number } : {}),
      ...(raw['timeoutMs'] !== undefined ? { timeoutMs: raw['timeoutMs'] as number } : {}),
      ...(isRecord(raw['env']) ? { env: raw['env'] as Record<string, string> } : {}),
      ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
      ...(typeof raw['enabled'] === 'boolean' ? { enabled: raw['enabled'] } : {}),
    };
    const result = validateHookCommandEntry(candidate);
    if (!result.valid || !result.entry) {
      for (const issue of result.issues) {
        issues.push(`${where}.${issue.field}: ${issue.message}`);
      }
      return undefined;
    }
    decl.command = result.entry.command;
    if (result.entry.env !== undefined) decl.env = result.entry.env;
    if (result.entry.matcher !== undefined) decl.matcher = result.entry.matcher;
    if (result.entry.priority !== undefined) decl.priority = result.entry.priority;
    if (result.entry.timeoutMs !== undefined) decl.timeoutMs = result.entry.timeoutMs;
    if (result.entry.enabled !== undefined) decl.enabled = result.entry.enabled;
  }
  if (hasScript) {
    // Script hooks share the same matcher/priority/timeout rules.
    if (raw['matcher'] !== undefined) {
      const matcher = cleanStringList(raw['matcher']);
      if (matcher === undefined || matcher.length === 0) {
        issues.push(`${where}.matcher: must be a non-empty string or list of strings`);
        return undefined;
      }
      decl.matcher = matcher.length === 1 ? matcher[0]! : matcher;
    }
    if (raw['priority'] !== undefined) {
      try {
        decl.priority = validateHookPriority(raw['priority'], name);
      } catch (err) {
        issues.push(`${where}.priority: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }
    if (raw['timeoutMs'] !== undefined) {
      try {
        decl.timeoutMs = validateHookTimeoutMs(raw['timeoutMs'], name);
      } catch (err) {
        issues.push(`${where}.timeoutMs: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }
    if (typeof raw['enabled'] === 'boolean') decl.enabled = raw['enabled'];
    else if (raw['enabled'] !== undefined) {
      issues.push(`${where}.enabled: must be a boolean`);
      return undefined;
    }
  }
  return decl;
}

/**
 * Validate a raw bundle manifest (parsed JSON). `bundleDir`, when
 * given, is checked on disk: skill dirs and hook scripts must exist
 * inside it. Returns `{ valid, manifest?, issues }` — never throws
 * for bad input (a bad bundle is data, not a crash). A manifest that
 * fails validation must not be installed or activated.
 */
export function validatePluginBundleManifest(
  raw: unknown,
  bundleDir?: string,
): ValidateBundleManifestResult {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    return { valid: false, issues: ['manifest: must be a JSON object'] };
  }
  const id = cleanString(raw['id']);
  if (!id || !PLUGIN_ID_RE.test(id)) {
    issues.push(`id: must match ${PLUGIN_ID_RE}`);
  }
  const name = cleanString(raw['name']);
  if (!name) issues.push('name: must be a non-empty string');
  const version = cleanString(raw['version']);
  if (!version || !SEMVER_RE.test(version)) {
    issues.push('version: must be semver like "1.0.0"');
  }
  const description = cleanString(raw['description']);
  if (description === undefined) issues.push('description: must be a string');
  const author = cleanString(raw['author']);
  const permissionsRaw = raw['permissions'];
  let permissions: PluginBundlePermission[] = [];
  if (permissionsRaw === undefined) {
    permissions = [];
  } else if (Array.isArray(permissionsRaw)) {
    const seen = new Set<string>();
    for (const item of permissionsRaw) {
      if (typeof item !== 'string') {
        issues.push('permissions: every entry must be a string');
        continue;
      }
      const p = item.trim();
      if (!(PLUGIN_BUNDLE_PERMISSIONS as readonly string[]).includes(p)) {
        // Fail-closed: an unknown permission is rejected, not flagged
        // and installed anyway (the catalog only reviews; the bundle
        // installer refuses).
        issues.push(`permissions: unknown permission ${JSON.stringify(p)} (known: ${PLUGIN_BUNDLE_PERMISSIONS.join(', ')})`);
        continue;
      }
      if (!seen.has(p)) {
        seen.add(p);
        permissions.push(p as PluginBundlePermission);
      }
    }
  } else {
    issues.push('permissions: must be a list of strings');
  }
  // `main` is optional for skill/hook/MCP-only bundles; when present
  // it must be a safe relative path and exist on disk.
  let main: string | undefined;
  if (raw['main'] !== undefined) {
    const mainRaw = cleanString(raw['main']);
    if (mainRaw === undefined) {
      issues.push('main: must be a non-empty string');
    } else if (!isSafeBundleRelativePath(mainRaw)) {
      issues.push('main: must be a relative path inside the bundle (no "..", no absolute path)');
    } else {
      if (bundleDir !== undefined) {
        try {
          if (!fs.statSync(path.join(bundleDir, mainRaw)).isFile()) {
            issues.push('main: entry file does not exist in the bundle');
          }
        } catch {
          issues.push('main: entry file does not exist in the bundle');
        }
      }
      main = mainRaw;
    }
  }
  // Skills.
  let skills: PluginBundleSkillDecl[] | undefined;
  if (raw['skills'] !== undefined) {
    if (!Array.isArray(raw['skills'])) {
      issues.push('skills: must be a list');
    } else {
      if (raw['skills'].length > MAX_BUNDLE_SKILLS) {
        issues.push(`skills: at most ${MAX_BUNDLE_SKILLS} skill dirs per bundle`);
      }
      const parsed: PluginBundleSkillDecl[] = [];
      raw['skills'].forEach((item, index) => {
        const where = `skills[${index}]`;
        if (!isRecord(item)) {
          issues.push(`${where}: must be an object with a "dir"`);
          return;
        }
        const dir = cleanString(item['dir']);
        if (!dir) {
          issues.push(`${where}.dir: must be a non-empty string`);
          return;
        }
        if (!isSafeBundleRelativePath(dir)) {
          issues.push(`${where}.dir: must be a relative path inside the bundle (no "..", no absolute path)`);
          return;
        }
        if (bundleDir !== undefined) {
          const abs = path.join(bundleDir, dir);
          let stat: fs.Stats | undefined;
          try {
            stat = fs.statSync(abs);
          } catch {
            stat = undefined;
          }
          if (!stat || !stat.isDirectory()) {
            issues.push(`${where}.dir: directory does not exist in the bundle`);
            return;
          }
          if (!dirHasSkill(abs)) {
            issues.push(`${where}.dir: no skill found (need a subdir with SKILL.md or a loose .md file)`);
            return;
          }
        }
        parsed.push({ dir });
      });
      skills = parsed;
    }
  }
  // Hooks.
  let hooks: PluginBundleHookDecl[] | undefined;
  if (raw['hooks'] !== undefined) {
    if (!Array.isArray(raw['hooks'])) {
      issues.push('hooks: must be a list');
    } else {
      if (raw['hooks'].length > MAX_BUNDLE_HOOKS) {
        issues.push(`hooks: at most ${MAX_BUNDLE_HOOKS} hooks per bundle`);
      }
      const parsed: PluginBundleHookDecl[] = [];
      const seenNames = new Set<string>();
      raw['hooks'].forEach((item, index) => {
        const decl = validateHookDecl(item, index, bundleDir, issues);
        if (!decl) return;
        if (seenNames.has(decl.name)) {
          issues.push(`hooks[${index}].name: duplicate hook name ${JSON.stringify(decl.name)}`);
          return;
        }
        seenNames.add(decl.name);
        parsed.push(decl);
      });
      hooks = parsed;
    }
  }
  // MCP servers (same validator as mcp.json).
  let mcpServers: Record<string, McpServerConfig> | undefined;
  if (raw['mcpServers'] !== undefined) {
    if (!isRecord(raw['mcpServers'])) {
      issues.push('mcpServers: must be an object of server configs');
    } else {
      const names = Object.keys(raw['mcpServers']);
      if (names.length > MAX_BUNDLE_MCP_SERVERS) {
        issues.push(`mcpServers: at most ${MAX_BUNDLE_MCP_SERVERS} servers per bundle`);
      }
      const parsed: Record<string, McpServerConfig> = {};
      for (const serverName of names) {
        if (serverName.trim() === '' || serverName.length > 128) {
          issues.push(`mcpServers: invalid server name ${JSON.stringify(serverName)}`);
          continue;
        }
        try {
          parsed[serverName] = validateMcpServerConfig(serverName, raw['mcpServers'][serverName]);
        } catch (err) {
          issues.push(`mcpServers.${serverName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      mcpServers = parsed;
    }
  }
  // Dependencies.
  let dependencies: string[] | undefined;
  if (raw['dependencies'] !== undefined) {
    const deps = cleanStringList(raw['dependencies']);
    if (deps === undefined) {
      issues.push('dependencies: must be a list of plugin ids');
    } else {
      if (deps.length > MAX_BUNDLE_DEPENDENCIES) {
        issues.push(`dependencies: at most ${MAX_BUNDLE_DEPENDENCIES} entries`);
      }
      const bad = deps.filter((d) => !PLUGIN_ID_RE.test(d));
      if (bad.length > 0) {
        issues.push(`dependencies: invalid plugin ids: ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
      }
      dependencies = [...new Set(deps)];
    }
  }
  if (issues.length > 0 || !id || !name || !version || description === undefined) {
    return { valid: false, issues };
  }
  const manifest: PluginBundleManifest = {
    id,
    name,
    version,
    description,
    ...(author !== undefined ? { author } : {}),
    permissions,
    ...(main !== undefined ? { main } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
  };
  return { valid: true, manifest, issues: [] };
}

/** Throwing version of `validatePluginBundleManifest` (for callers that prefer throw). */
export function parsePluginBundleManifest(raw: unknown, bundleDir?: string): PluginBundleManifest {
  const result = validatePluginBundleManifest(raw, bundleDir);
  if (!result.valid || !result.manifest) {
    throw new PluginBundleError(
      `Invalid plugin bundle manifest: ${result.issues.join('; ')}`,
      result.issues,
      isRecord(raw) && typeof raw['id'] === 'string' ? raw['id'] : undefined,
    );
  }
  return result.manifest;
}

/** Read + validate the manifest of a bundle directory on disk. */
export function scanBundleDir(bundleDir: string): ValidateBundleManifestResult {
  const manifestPath = path.join(bundleDir, PLUGIN_BUNDLE_MANIFEST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return { valid: false, issues: [`manifest: cannot read ${PLUGIN_BUNDLE_MANIFEST_FILE} in the bundle`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      valid: false,
      issues: [`manifest: ${PLUGIN_BUNDLE_MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return validatePluginBundleManifest(parsed, bundleDir);
}

/** What a bundle contributes, for list screens and logs. */
export interface PluginBundleSummary {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  /** True when the bundle ships a tool entry file (`main`). */
  hasToolEntry: boolean;
  skillDirs: string[];
  hookNames: string[];
  mcpServerNames: string[];
  dependencies: string[];
}

export function summarizePluginBundle(manifest: PluginBundleManifest): PluginBundleSummary {
  return {
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author ?? '',
    permissions: [...manifest.permissions],
    hasToolEntry: manifest.main !== undefined,
    skillDirs: (manifest.skills ?? []).map((s) => s.dir),
    hookNames: (manifest.hooks ?? []).map((h) => h.name),
    mcpServerNames: Object.keys(manifest.mcpServers ?? {}),
    dependencies: [...(manifest.dependencies ?? [])],
  };
}
