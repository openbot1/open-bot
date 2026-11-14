/**
 * Claude Code plugin-format compat (v1.03, Team T3) — READ-ONLY.
 *
 * The Harness Engineering survey notes OpenHands reads Claude Code's
 * plugin format so its plugins can be reused. This module does the
 * same for open-bot: it *parses and validates* the public manifest
 * shapes (`.claude-plugin/plugin.json`, `marketplace.json`, plus the
 * `commands/` / `agents/` / `skills/` markdown files and
 * `hooks/hooks.json` that a plugin directory carries) and maps them
 * onto open-bot's own plugin record shape — so a Claude Code plugin
 * can be *listed, inspected and imported as metadata*.
 *
 * What this deliberately does NOT do:
 * - never executes plugin code, hooks or commands;
 * - never writes into the plugin directory;
 * - never claims a plugin "works" in open-bot — `warnings` on the
 *   mapped record say exactly which parts have no open-bot
 *   equivalent yet (hooks, LSP servers, …).
 *
 * Execution lives next door in `pluginRuntime.ts` (v1.04): it takes
 * the scan from this module and, only on explicit activation,
 * registers a plugin's hooks as shell-command hooks and exposes its
 * commands as prompt templates. This module stays read-only.
 *
 * Only field names and shapes are taken from the public format
 * documentation; every line of code here is written fresh for
 * open-bot. Unknown manifest fields are ignored (reported in
 * `extraFields`), never rejected — the format evolves, the reader
 * should not break on a new key.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isRecord } from './types';

// ---------------------------------------------------------------------------
// Manifest shapes (public format, re-declared here)
// ---------------------------------------------------------------------------

export interface ClaudePluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface ClaudePluginManifest {
  /** Plugin id, e.g. `my-plugin`. */
  name: string;
  version: string;
  description: string;
  author?: string | ClaudePluginAuthor;
  keywords?: string[];
  license?: string;
  /** Command names (files under `commands/`, without `.md`). */
  commands?: string[];
  /** Agent names (files under `agents/`, without `.md`). */
  agents?: string[];
  /** Skill directory names (under `skills/`). */
  skills?: string[];
  /** Hook config: path to `hooks.json`, or the inline object. */
  hooks?: string | Record<string, unknown>;
  /** MCP servers the plugin contributes. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** LSP servers the plugin contributes (no open-bot equivalent yet). */
  lspServers?: Record<string, Record<string, unknown>>;
  /** Manifest keys this reader does not understand (forward-compat). */
  extraFields?: string[];
}

export interface ClaudeMarketplacePluginEntry {
  name: string;
  /** Where the plugin comes from, e.g. `{ source: 'github', repo: 'owner/repo' }`. */
  source?: Record<string, unknown>;
  description?: string;
  version?: string;
  author?: string | ClaudePluginAuthor;
}

export interface ClaudeMarketplaceManifest {
  name: string;
  owner?: string | { name?: string; email?: string };
  description?: string;
  plugins: ClaudeMarketplacePluginEntry[];
  extraFields?: string[];
}

/** Validation outcome — errors block use, warnings do not. */
export interface PluginFormatResult<T> {
  value: T | null;
  errors: string[];
  warnings: string[];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseAuthor(value: unknown): string | ClaudePluginAuthor | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.name === 'string') {
    const author: ClaudePluginAuthor = { name: value.name };
    if (typeof value.email === 'string') author.email = value.email;
    if (typeof value.url === 'string') author.url = value.url;
    return author;
  }
  return undefined;
}

/**
 * Parse + validate one `.claude-plugin/plugin.json` value (already
 * JSON-parsed). Missing `name` / `version` / `description` are
 * errors; a non-semver version or odd name shape is a warning.
 */
export function parseClaudePluginManifest(value: unknown): PluginFormatResult<ClaudePluginManifest> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { value: null, errors: ['plugin.json must be a JSON object'], warnings };
  }
  const name = stringField(value.name);
  if (!name) errors.push('plugin.json: missing required "name"');
  else if (!PLUGIN_NAME_RE.test(name)) warnings.push(`plugin name "${name}" is not kebab-case`);
  const version = stringField(value.version);
  if (!version) errors.push('plugin.json: missing required "version"');
  else if (!SEMVER_RE.test(version)) warnings.push(`plugin version "${version}" is not semver`);
  const description = stringField(value.description);
  if (!description) errors.push('plugin.json: missing required "description"');
  if (errors.length > 0) return { value: null, errors, warnings };

  const known = new Set([
    'name', 'version', 'description', 'author', 'keywords', 'license',
    'commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers',
  ]);
  const extraFields = Object.keys(value).filter((k) => !known.has(k));
  const manifest: ClaudePluginManifest = { name: name as string, version: version as string, description: description as string };
  const author = parseAuthor(value.author);
  if (author !== undefined) manifest.author = author;
  const keywords = stringArrayField(value.keywords);
  if (keywords) manifest.keywords = keywords;
  if (typeof value.license === 'string') manifest.license = value.license;
  const commands = stringArrayField(value.commands);
  if (commands) manifest.commands = commands;
  const agents = stringArrayField(value.agents);
  if (agents) manifest.agents = agents;
  const skills = stringArrayField(value.skills);
  if (skills) manifest.skills = skills;
  if (typeof value.hooks === 'string' || isRecord(value.hooks)) manifest.hooks = value.hooks;
  if (isRecord(value.mcpServers)) manifest.mcpServers = value.mcpServers as Record<string, Record<string, unknown>>;
  if (isRecord(value.lspServers)) {
    manifest.lspServers = value.lspServers as Record<string, Record<string, unknown>>;
    warnings.push('lspServers have no open-bot equivalent yet and will be ignored on import');
  }
  if (extraFields.length > 0) manifest.extraFields = extraFields;
  return { value: manifest, errors, warnings };
}

/**
 * Parse + validate one `marketplace.json` value. Each entry needs a
 * `name`; entries without one are skipped with a warning (the rest
 * of the marketplace still imports).
 */
export function parseClaudeMarketplaceManifest(value: unknown): PluginFormatResult<ClaudeMarketplaceManifest> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { value: null, errors: ['marketplace.json must be a JSON object'], warnings };
  }
  const name = stringField(value.name);
  if (!name) errors.push('marketplace.json: missing required "name"');
  const rawPlugins = value.plugins;
  if (!Array.isArray(rawPlugins)) errors.push('marketplace.json: missing required "plugins" array');
  if (errors.length > 0) return { value: null, errors, warnings };
  const plugins: ClaudeMarketplacePluginEntry[] = [];
  for (const entry of rawPlugins as unknown[]) {
    if (!isRecord(entry) || !stringField(entry.name)) {
      warnings.push('marketplace.json: skipped a plugin entry without a name');
      continue;
    }
    const plugin: ClaudeMarketplacePluginEntry = { name: entry.name as string };
    if (isRecord(entry.source)) plugin.source = entry.source;
    if (typeof entry.description === 'string') plugin.description = entry.description;
    if (typeof entry.version === 'string') plugin.version = entry.version;
    const author = parseAuthor(entry.author);
    if (author !== undefined) plugin.author = author;
    plugins.push(plugin);
  }
  const known = new Set(['name', 'owner', 'description', 'plugins', 'metadata']);
  const extraFields = Object.keys(value).filter((k) => !known.has(k));
  const manifest: ClaudeMarketplaceManifest = { name: name as string, plugins };
  if (typeof value.owner === 'string') manifest.owner = value.owner;
  else if (isRecord(value.owner) && typeof value.owner.name === 'string') manifest.owner = value.owner.name;
  if (typeof value.description === 'string') manifest.description = value.description;
  if (extraFields.length > 0) manifest.extraFields = extraFields;
  return { value: manifest, errors, warnings };
}

// ---------------------------------------------------------------------------
// Directory scan
// ---------------------------------------------------------------------------

export interface ScannedPluginCommand {
  name: string;
  file: string;
  description?: string;
}

export interface ScannedPluginSkill {
  name: string;
  dir: string;
  description?: string;
}

export interface ScannedPlugin {
  manifest: ClaudePluginManifest;
  manifestWarnings: string[];
  commands: ScannedPluginCommand[];
  agents: ScannedPluginCommand[];
  skills: ScannedPluginSkill[];
  /** Hook event names declared in `hooks/hooks.json` (if present). */
  hookEvents: string[];
  /** Files the manifest lists but the directory does not contain. */
  missingFiles: string[];
}

function readJsonFile(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Read the `name:` / `description:` lines of a markdown frontmatter block. */
export function parseMarkdownFrontmatter(text: string): { name?: string; description?: string } {
  const result: { name?: string; description?: string } = {};
  if (!text.startsWith('---')) return result;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return result;
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === 'name') result.name = match[2].replace(/^['"]|['"]$/g, '');
    if (match[1] === 'description') result.description = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function scanMarkdownDir(dir: string): ScannedPluginCommand[] {
  const out: ScannedPluginCommand[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    let text = '';
    try {
      text = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseMarkdownFrontmatter(text);
    out.push({
      name: fm.name ?? file.replace(/\.md$/, ''),
      file,
      description: fm.description,
    });
  }
  return out;
}

/**
 * Scan a plugin directory (the folder that contains
 * `.claude-plugin/plugin.json`). Returns the manifest plus the
 * on-disk commands / agents / skills / hook events, and lists any
 * manifest-declared file that is missing on disk.
 */
export function scanClaudePluginDir(dir: string): PluginFormatResult<ScannedPlugin> {
  const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
  const raw = readJsonFile(manifestPath);
  if (raw === undefined) {
    return { value: null, errors: [`no readable .claude-plugin/plugin.json in ${dir}`], warnings: [] };
  }
  const parsed = parseClaudePluginManifest(raw);
  if (!parsed.value) return { value: null, errors: parsed.errors, warnings: parsed.warnings };
  const manifest = parsed.value;
  const missingFiles: string[] = [];
  const commands = scanMarkdownDir(path.join(dir, 'commands'));
  const agents = scanMarkdownDir(path.join(dir, 'agents'));
  const skills: ScannedPluginSkill[] = [];
  const skillsDir = path.join(dir, 'skills');
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      let description: string | undefined;
      try {
        description = parseMarkdownFrontmatter(fs.readFileSync(skillFile, 'utf-8')).description;
      } catch {
        // A skill without SKILL.md is still listed, without description.
      }
      skills.push({ name: entry.name, dir: entry.name, description });
    }
  } catch {
    // No skills/ directory — fine.
  }
  for (const name of manifest.commands ?? []) {
    if (!commands.some((c) => c.name === name)) missingFiles.push(`commands/${name}.md`);
  }
  for (const name of manifest.agents ?? []) {
    if (!agents.some((a) => a.name === name)) missingFiles.push(`agents/${name}.md`);
  }
  for (const name of manifest.skills ?? []) {
    if (!skills.some((s) => s.name === name)) missingFiles.push(`skills/${name}/SKILL.md`);
  }
  const hookEvents: string[] = [];
  const hooksPath = path.join(dir, 'hooks', 'hooks.json');
  const hooksRaw = readJsonFile(hooksPath);
  if (isRecord(hooksRaw) && Array.isArray(hooksRaw.hooks)) {
    for (const hook of hooksRaw.hooks as unknown[]) {
      if (isRecord(hook) && typeof hook.event === 'string') hookEvents.push(hook.event);
    }
  }
  return {
    value: { manifest, manifestWarnings: parsed.warnings, commands, agents, skills, hookEvents, missingFiles },
    errors: [],
    warnings: parsed.warnings,
  };
}

// ---------------------------------------------------------------------------
// Mapping onto open-bot's own plugin record
// ---------------------------------------------------------------------------

export interface OpenBotPluginRecord {
  /** `claude-plugin:<name>` — namespaced so it can never collide with a native plugin id. */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  source: 'claude-plugin';
  commands: Array<{ name: string; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string }>;
  hookEvents: string[];
  mcpServers: Record<string, Record<string, unknown>>;
  /** Parts of the manifest open-bot cannot run yet (import is metadata-only for them). */
  warnings: string[];
  missingFiles: string[];
}

function authorName(author: string | ClaudePluginAuthor | undefined): string | undefined {
  if (typeof author === 'string') return author;
  return author?.name;
}

/** Map a scanned Claude Code plugin onto open-bot's plugin record shape. */
export function claudePluginToOpenBot(scanned: ScannedPlugin): OpenBotPluginRecord {
  const { manifest } = scanned;
  const warnings = [...scanned.manifestWarnings];
  if (scanned.hookEvents.length > 0) {
    warnings.push(
      `hooks (${scanned.hookEvents.join(', ')}) are imported as metadata only — activate them with activateClaudePlugin (pluginRuntime.ts, opt-in) to run them as shell-command hooks`,
    );
  }
  if (manifest.mcpServers && Object.keys(manifest.mcpServers).length > 0) {
    warnings.push(
      `${Object.keys(manifest.mcpServers).length} MCP server(s) declared — import them via the MCP server list, they are not auto-started`,
    );
  }
  return {
    id: `claude-plugin:${manifest.name}`,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: authorName(manifest.author),
    source: 'claude-plugin',
    commands: scanned.commands.map((c) => ({ name: c.name, description: c.description })),
    agents: scanned.agents.map((a) => ({ name: a.name, description: a.description })),
    skills: scanned.skills.map((s) => ({ name: s.name, description: s.description })),
    hookEvents: scanned.hookEvents,
    mcpServers: manifest.mcpServers ?? {},
    warnings,
    missingFiles: scanned.missingFiles,
  };
}
