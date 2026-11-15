/**
 * Plugin bundle install / activate / deactivate (v1.07, Team T4).
 *
 * This is the lifecycle half of the bundle layer (`bundle.ts` only
 * validates + describes). A bundle is installed by copying its
 * directory into `<pluginsDir>/<id>`; activating it registers its
 * skills into the SkillRegistry, its hooks into the HookRegistry and
 * merges its MCP servers into the workspace mcp.json; deactivating
 * it undoes exactly those three steps.
 *
 * Safety:
 * - Install validates the source bundle BEFORE copying anything; a
 *   bundle that fails validation never lands in pluginsDir.
 * - Install refuses to overwrite an existing plugin unless
 *   `overwrite` is set — and even then the old directory is only
 *   removed after the new bundle validated.
 * - Uninstall only removes a directory whose own manifest names the
 *   same plugin id — it never deletes a foreign directory.
 * - Activation is best-effort per component: one bad skill dir or
 *   hook never blocks the others; every failure is reported in the
 *   result (activation must not throw halfway and leave a
 *   half-activated bundle). A manifest that fails validation throws
 *   BEFORE anything is registered, so activation is all-or-nothing
 *   at the manifest level and best-effort below it.
 * - Uninstall only removes files + the enabled entry. Hooks, skills
 *   and MCP servers are removed by `deactivatePluginBundle` — the
 *   host should deactivate first (or accept that a later restart
 *   simply stops seeing the bundle). Uninstall reports the MCP
 *   server names the bundle had installed, so the host can warn.
 * - Enable/disable is one writer: this module owns `enabled.json`
 *   (same file the catalog reads, `plugins/catalog.ts`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPluginEnabledMap, PLUGIN_ENABLED_FILE } from './catalog';
import {
  PluginBundleError,
  scanBundleDir,
  summarizePluginBundle,
} from './bundle';
import type {
  PluginBundleManifest,
  PluginBundleSummary,
} from './bundle';
import { mergePluginMcpServers, removePluginMcpServers } from '../mcp/pluginServers';
import type {
  MergePluginMcpServersResult,
  RemovePluginMcpServersResult,
} from '../mcp/pluginServers';
import type { SkillRegistry } from '../skills/registry';
import type { HookRegistry } from '../hooks/registry';

/** Where bundles are installed: `<pluginsDir>/<pluginId>/`. */
export function getPluginBundleDir(pluginsDir: string, pluginId: string): string {
  return path.join(pluginsDir, pluginId);
}

/** Write the enabled map atomically (temp file + rename). */
export function writePluginEnabledMap(
  pluginsDir: string,
  enabled: Record<string, boolean>,
): void {
  fs.mkdirSync(pluginsDir, { recursive: true });
  const filePath = path.join(pluginsDir, PLUGIN_ENABLED_FILE);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export interface InstallPluginBundleOptions {
  /** Replace an already-installed plugin with the same id. Default false. */
  overwrite?: boolean;
}

export interface InstallPluginBundleResult {
  ok: boolean;
  pluginId?: string;
  /** Absolute install directory (when ok). */
  dir?: string;
  manifest?: PluginBundleManifest;
  /** True when an existing install was replaced. */
  overwritten?: boolean;
  /** Why the install failed (when !ok). */
  issues?: string[];
}

/**
 * Install a bundle directory into pluginsDir. Validates first,
 * copies second, re-validates the copy third (a failed copy is
 * removed again — a half-copied plugin must not stay installed).
 */
export function installPluginBundle(
  sourceDir: string,
  pluginsDir: string,
  opts: InstallPluginBundleOptions = {},
): InstallPluginBundleResult {
  const scanned = scanBundleDir(sourceDir);
  if (!scanned.valid || !scanned.manifest) {
    return { ok: false, issues: scanned.issues };
  }
  const manifest = scanned.manifest;
  const target = getPluginBundleDir(pluginsDir, manifest.id);
  let exists = false;
  try {
    exists = fs.statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  if (exists && !opts.overwrite) {
    return {
      ok: false,
      pluginId: manifest.id,
      issues: [
        `Plugin "${manifest.id}" is already installed — pass overwrite: true to replace it.`,
      ],
    };
  }
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
    if (exists) fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(sourceDir, target, { recursive: true });
  } catch (err) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of a failed copy.
    }
    return {
      ok: false,
      pluginId: manifest.id,
      issues: [`Cannot copy bundle into ${target}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  // The copy must validate too — a failed copy is removed again.
  const copied = scanBundleDir(target);
  if (!copied.valid || !copied.manifest) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    return { ok: false, pluginId: manifest.id, issues: copied.issues };
  }
  const enabled = readPluginEnabledMap(pluginsDir);
  enabled[manifest.id] = true;
  writePluginEnabledMap(pluginsDir, enabled);
  return {
    ok: true,
    pluginId: manifest.id,
    dir: target,
    manifest: copied.manifest,
    overwritten: exists,
  };
}

export interface UninstallPluginBundleResult {
  ok: boolean;
  pluginId: string;
  /** True when a directory was actually removed. */
  removed?: boolean;
  /** MCP server names this plugin had installed (call deactivate first to remove them from mcp.json). */
  mcpServers?: string[];
  issues?: string[];
}

/**
 * Uninstall a bundle: removes its directory + enabled entry. The
 * directory's own manifest must name the same id (never delete a
 * foreign directory). Hooks/skills/MCP servers are NOT unregistered
 * here — deactivate first (see `deactivatePluginBundle`).
 */
export function uninstallPluginBundle(
  pluginsDir: string,
  pluginId: string,
): UninstallPluginBundleResult {
  const target = getPluginBundleDir(pluginsDir, pluginId);
  let exists = false;
  try {
    exists = fs.statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return { ok: false, pluginId, issues: [`Plugin "${pluginId}" is not installed.`] };
  }
  const scanned = scanBundleDir(target);
  if (!scanned.valid || !scanned.manifest || scanned.manifest.id !== pluginId) {
    return {
      ok: false,
      pluginId,
      issues: [
        `Refusing to uninstall "${pluginId}": the directory's manifest does not name this plugin id.`,
        ...scanned.issues,
      ],
    };
  }
  const mcpServers = Object.keys(scanned.manifest.mcpServers ?? {});
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      pluginId,
      issues: [`Cannot remove ${target}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const enabled = readPluginEnabledMap(pluginsDir);
  if (pluginId in enabled) {
    delete enabled[pluginId];
    writePluginEnabledMap(pluginsDir, enabled);
  }
  return { ok: true, pluginId, removed: true, mcpServers };
}

export interface SetPluginBundleEnabledResult {
  ok: boolean;
  pluginId: string;
  enabled?: boolean;
  issues?: string[];
}

/** Enable or disable an installed bundle (persisted in enabled.json). */
export function setPluginBundleEnabled(
  pluginsDir: string,
  pluginId: string,
  enabled: boolean,
): SetPluginBundleEnabledResult {
  const target = getPluginBundleDir(pluginsDir, pluginId);
  let exists = false;
  try {
    exists = fs.statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return { ok: false, pluginId, issues: [`Plugin "${pluginId}" is not installed.`] };
  }
  const map = readPluginEnabledMap(pluginsDir);
  map[pluginId] = enabled;
  writePluginEnabledMap(pluginsDir, map);
  return { ok: true, pluginId, enabled };
}

/** Is an installed bundle enabled? Missing entry = enabled (installed = on unless disabled). */
export function isPluginBundleEnabled(pluginsDir: string, pluginId: string): boolean {
  const map = readPluginEnabledMap(pluginsDir);
  return map[pluginId] !== false;
}

/** One installed bundle for list screens. */
export interface PluginBundleListEntry extends PluginBundleSummary {
  /** Absolute install directory. */
  dir: string;
  /** False when the manifest is invalid (see `issues`). */
  valid: boolean;
  /** Validation issues (when !valid). */
  issues: string[];
  /** Enabled flag from enabled.json (null when the file has no entry). */
  enabled: boolean | null;
}

/** Scan installed bundles: every subdir of pluginsDir, valid or not (invalid ones are listed, not hidden). */
export function listPluginBundles(pluginsDir: string): PluginBundleListEntry[] {
  let dirNames: string[];
  try {
    dirNames = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const enabledMap = readPluginEnabledMap(pluginsDir);
  const entries: PluginBundleListEntry[] = [];
  for (const dirName of dirNames.sort()) {
    const dir = path.join(pluginsDir, dirName);
    const scanned = scanBundleDir(dir);
    if (!scanned.valid || !scanned.manifest) {
      entries.push({
        pluginId: dirName,
        name: dirName,
        version: '',
        description: '',
        author: '',
        permissions: [],
        hasToolEntry: false,
        skillDirs: [],
        hookNames: [],
        mcpServerNames: [],
        dependencies: [],
        dir,
        valid: false,
        issues: scanned.issues,
        enabled: dirName in enabledMap ? enabledMap[dirName]! : null,
      });
      continue;
    }
    const summary = summarizePluginBundle(scanned.manifest);
    entries.push({
      ...summary,
      dir,
      valid: true,
      issues: [],
      enabled: summary.pluginId in enabledMap ? enabledMap[summary.pluginId]! : null,
    });
  }
  return entries;
}

export interface PluginBundleActivationDeps {
  skillRegistry?: SkillRegistry;
  hookRegistry?: HookRegistry;
  /** Workspace root (MCP servers merge into `<workspaceDir>/.open-bot/mcp.json`). */
  workspaceDir?: string;
  /** Plugins dir (sidecar for installed MCP servers). Required together with workspaceDir for MCP. */
  pluginsDir?: string;
}

export interface PluginBundleActivation {
  pluginId: string;
  /** Skill names registered into the SkillRegistry. */
  skillsAdded: string[];
  /** Skill load errors (one bad skill dir never blocks the others). */
  skillErrors: string[];
  /** Hook names registered into the HookRegistry. */
  hooksApplied: string[];
  /** Hook names shipped disabled (`enabled: false` in the manifest). */
  hooksSkipped: string[];
  /** Hook registration errors (one bad hook never blocks the others). */
  hookErrors: string[];
  /** MCP merge outcome (null when no workspace/plugins dir was given or the bundle has no servers). */
  mcp: MergePluginMcpServersResult | null;
}

export interface PluginBundleDeactivation {
  pluginId: string;
  /** Hook names unregistered from the HookRegistry. */
  hooksRemoved: string[];
  /** Skill names removed from the SkillRegistry. */
  skillsRemoved: string[];
  /** MCP removal outcome (null when no workspace/plugins dir was given or nothing was recorded). */
  mcp: RemovePluginMcpServersResult | null;
}

function readBundleIdFallback(bundleDir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'),
    );
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const id = (parsed as Record<string, unknown>)['id'];
      return typeof id === 'string' ? id : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Activate a bundle directory: register its skills + hooks and merge
 * its MCP servers. Throws PluginBundleError when the manifest itself
 * is invalid (nothing is registered then); per-component failures
 * are collected in the result instead of thrown.
 */
export function activatePluginBundle(
  bundleDir: string,
  deps: PluginBundleActivationDeps = {},
): PluginBundleActivation {
  const scanned = scanBundleDir(bundleDir);
  if (!scanned.valid || !scanned.manifest) {
    throw new PluginBundleError(
      `Invalid plugin bundle manifest in ${bundleDir}: ${scanned.issues.join('; ')}`,
      scanned.issues,
      readBundleIdFallback(bundleDir),
    );
  }
  const manifest = scanned.manifest;
  const result: PluginBundleActivation = {
    pluginId: manifest.id,
    skillsAdded: [],
    skillErrors: [],
    hooksApplied: [],
    hooksSkipped: [],
    hookErrors: [],
    mcp: null,
  };
  // Skills.
  if (deps.skillRegistry && manifest.skills) {
    for (const skillDecl of manifest.skills) {
      const absDir = path.join(bundleDir, skillDecl.dir);
      const errorsBefore = deps.skillRegistry.errors().length;
      const added = deps.skillRegistry.addSkillsFromDir(absDir, 'plugin', manifest.id);
      result.skillsAdded.push(...added.map((s) => s.name));
      const newErrors = deps.skillRegistry.errors().slice(errorsBefore);
      for (const e of newErrors) {
        result.skillErrors.push(`${e.file}: ${e.error}`);
      }
    }
  }
  // Hooks.
  if (deps.hookRegistry && manifest.hooks) {
    for (const hookDecl of manifest.hooks) {
      if (hookDecl.enabled === false) {
        result.hooksSkipped.push(hookDecl.name);
        continue;
      }
      try {
        if (hookDecl.script !== undefined) {
          const absScript = path.join(bundleDir, hookDecl.script);
          deps.hookRegistry.registerScriptHook(
            {
              name: hookDecl.name,
              description: hookDecl.description,
              events: [...hookDecl.events],
              source: 'plugin',
              workspaceDir: deps.workspaceDir ?? bundleDir,
              allowedDirs: [bundleDir],
              ...(hookDecl.timeoutMs !== undefined ? { timeoutMs: hookDecl.timeoutMs } : {}),
            },
            absScript,
          );
        } else if (hookDecl.command !== undefined) {
          deps.hookRegistry.registerCommandHook(
            {
              name: hookDecl.name,
              command: hookDecl.command,
              events: [...hookDecl.events],
              ...(hookDecl.description !== undefined ? { description: hookDecl.description } : {}),
              ...(hookDecl.matcher !== undefined ? { matcher: hookDecl.matcher } : {}),
              ...(hookDecl.priority !== undefined ? { priority: hookDecl.priority } : {}),
              ...(hookDecl.timeoutMs !== undefined ? { timeoutMs: hookDecl.timeoutMs } : {}),
              ...(hookDecl.env !== undefined ? { env: hookDecl.env } : {}),
            },
            { workspaceDir: deps.workspaceDir ?? bundleDir },
          );
        }
        result.hooksApplied.push(hookDecl.name);
      } catch (err) {
        result.hookErrors.push(
          `hook "${hookDecl.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  // MCP servers (only when the host gave both dirs).
  if (deps.workspaceDir && deps.pluginsDir && manifest.mcpServers) {
    result.mcp = mergePluginMcpServers(
      deps.workspaceDir,
      deps.pluginsDir,
      manifest.id,
      manifest.mcpServers,
    );
  }
  return result;
}

/**
 * Deactivate a bundle directory: unregister its hooks, remove its
 * skills and remove its MCP servers. Best-effort per component; a
 * manifest that cannot be read falls back to the raw id so hook/skill
 * removal by plugin id can still run.
 */
export function deactivatePluginBundle(
  bundleDir: string,
  deps: PluginBundleActivationDeps = {},
): PluginBundleDeactivation {
  const scanned = scanBundleDir(bundleDir);
  const pluginId = scanned.valid && scanned.manifest ? scanned.manifest.id : readBundleIdFallback(bundleDir);
  if (!pluginId) {
    throw new Error(`Cannot deactivate bundle in ${bundleDir}: no readable manifest id.`);
  }
  const result: PluginBundleDeactivation = {
    pluginId,
    hooksRemoved: [],
    skillsRemoved: [],
    mcp: null,
  };
  const hooks = scanned.valid && scanned.manifest ? (scanned.manifest.hooks ?? []) : [];
  if (deps.hookRegistry) {
    for (const hookDecl of hooks) {
      if (deps.hookRegistry.unregister(hookDecl.name)) {
        result.hooksRemoved.push(hookDecl.name);
      }
    }
  }
  if (deps.skillRegistry) {
    result.skillsRemoved = deps.skillRegistry.removeSkillsByPlugin(pluginId);
  }
  if (deps.workspaceDir && deps.pluginsDir) {
    result.mcp = removePluginMcpServers(deps.workspaceDir, deps.pluginsDir, pluginId);
  }
  return result;
}
