/**
 * Plugin MCP servers — merge a bundle's MCP servers into the workspace
 * `mcp.json` and remove exactly them again on uninstall (v1.07, Team T4).
 *
 * A plugin bundle declares MCP servers in its manifest (`plugins/
 * bundle.ts`). Activating the bundle must wire those servers in like
 * a user editing `.open-bot/mcp.json` by hand — and deactivating it
 * must take them back out without touching the user's own servers.
 *
 * Rules (same spirit as `ensureMcpServer` in `mcp/config.ts`):
 * - A server whose name already exists in mcp.json is NEVER
 *   overwritten: the user's own config wins. The merge reports it as
 *   `already-present` (identical config) or `exists-different`
 *   (same name, different config) so the host can tell the user.
 * - Removal only deletes a server when its current config is still
 *   byte-identical to what the plugin installed. If the user edited
 *   the server after install, removal keeps it and reports it as
 *   `kept` — open-bot never deletes a config the user touched.
 * - A sidecar file, `<pluginsDir>/plugin-mcp-servers.json`, records
 *   which servers each plugin installed (name → exact config), so
 *   uninstall knows precisely what to remove even after restarts.
 *   The sidecar holds server configs only — never tokens beyond what
 *   the bundle manifest itself declared (a static Authorization
 *   header a bundle declares is already in its manifest; this file
 *   lives next to the plugin install, not in the workspace).
 * - All writes are atomic (temp file + rename) and never log configs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureMcpServer, loadMcpConfig, validateMcpServerConfig, MCP_CONFIG_REL_PATH } from './config';
import type { McpConfig, McpServerConfig } from './types';

/** Sidecar recording which MCP servers each plugin installed. */
export const PLUGIN_MCP_SERVERS_FILE = 'plugin-mcp-servers.json';

/** pluginId → serverName → the exact config installed. */
export type PluginMcpServerMap = Record<string, Record<string, McpServerConfig>>;

interface PluginMcpServersFile {
  version: 1;
  plugins: PluginMcpServerMap;
}

export interface MergePluginMcpServersResult {
  /** Server names actually added to mcp.json. */
  added: string[];
  /** Server names already in mcp.json with an identical config. */
  alreadyPresent: string[];
  /** Server names already in mcp.json with a DIFFERENT config (user wins, not added). */
  existsDifferent: string[];
}

export interface RemovePluginMcpServersResult {
  /** Server names removed from mcp.json. */
  removed: string[];
  /** Server names kept because the user edited them after install. */
  kept: string[];
  /** Server names the sidecar recorded but mcp.json no longer has. */
  missing: string[];
}

/** Read the sidecar (missing/corrupt = empty — removal then has nothing to do). */
export function readPluginMcpServerMap(pluginsDir: string): PluginMcpServerMap {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(pluginsDir, PLUGIN_MCP_SERVERS_FILE), 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const plugins = (parsed as { plugins?: unknown }).plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return {};
    const out: PluginMcpServerMap = {};
    for (const [pluginId, servers] of Object.entries(plugins as Record<string, unknown>)) {
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
      const cleaned: Record<string, McpServerConfig> = {};
      for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
        if (config && typeof config === 'object' && !Array.isArray(config)) {
          cleaned[name] = config as McpServerConfig;
        }
      }
      if (Object.keys(cleaned).length > 0) out[pluginId] = cleaned;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the sidecar atomically (temp file + rename). */
export function writePluginMcpServerMap(pluginsDir: string, map: PluginMcpServerMap): void {
  fs.mkdirSync(pluginsDir, { recursive: true });
  const filePath = path.join(pluginsDir, PLUGIN_MCP_SERVERS_FILE);
  const tmp = `${filePath}.tmp`;
  const payload: PluginMcpServersFile = { version: 1, plugins: map };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Write a whole mcp.json atomically (temp file + rename). */
export function saveMcpConfig(workspaceDir: string, config: McpConfig): void {
  const filePath = path.join(workspaceDir, MCP_CONFIG_REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Server names one plugin installed (from the sidecar). */
export function listPluginMcpServers(pluginsDir: string, pluginId: string): string[] {
  const map = readPluginMcpServerMap(pluginsDir);
  return Object.keys(map[pluginId] ?? {}).sort();
}

/**
 * Merge a bundle's MCP servers into the workspace mcp.json.
 * Servers the user already has (same name) are never overwritten.
 * Only servers actually added are recorded in the sidecar, so a
 * later uninstall removes exactly what this plugin installed.
 */
export function mergePluginMcpServers(
  workspaceDir: string,
  pluginsDir: string,
  pluginId: string,
  servers: Record<string, McpServerConfig>,
): MergePluginMcpServersResult {
  const result: MergePluginMcpServersResult = { added: [], alreadyPresent: [], existsDifferent: [] };
  const addedConfigs: Record<string, McpServerConfig> = {};
  for (const name of Object.keys(servers).sort()) {
    const raw = servers[name]!;
    // v1.10 (audit bảo mật): validate config bundle khai TRƯỚC khi
    // chạm mcp.json — bundle hỏng (args không phải mảng, url không
    // phải http(s), thiếu cả command lẫn url, ...) fail fast với lỗi
    // rõ tên plugin + server, không ghi một nửa rồi mới vỡ; sidecar
    // cũng ghi config đã chuẩn hoá (đồng nhất với file trên đĩa).
    const config = validateMcpServerConfig(name, raw);
    const outcome = ensureMcpServer(workspaceDir, name, config);
    if (outcome.added) {
      result.added.push(name);
      addedConfigs[name] = config;
    } else if (outcome.reason === 'already-present') {
      result.alreadyPresent.push(name);
    } else {
      result.existsDifferent.push(name);
    }
  }
  if (Object.keys(addedConfigs).length > 0) {
    const map = readPluginMcpServerMap(pluginsDir);
    map[pluginId] = { ...(map[pluginId] ?? {}), ...addedConfigs };
    writePluginMcpServerMap(pluginsDir, map);
  }
  return result;
}

/**
 * Remove a plugin's MCP servers from the workspace mcp.json.
 * A server is removed only when its current config is still
 * identical to what the plugin installed — a user-edited server is
 * kept and reported. The sidecar entry for the plugin is dropped
 * either way (a kept server is now the user's own).
 */
export function removePluginMcpServers(
  workspaceDir: string,
  pluginsDir: string,
  pluginId: string,
): RemovePluginMcpServersResult {
  const result: RemovePluginMcpServersResult = { removed: [], kept: [], missing: [] };
  const map = readPluginMcpServerMap(pluginsDir);
  const recorded = map[pluginId];
  if (!recorded || Object.keys(recorded).length === 0) return result;
  let current: McpConfig;
  try {
    current = loadMcpConfig(workspaceDir);
  } catch {
    // mcp.json is unreadable: nothing can be removed safely; leave
    // the sidecar alone so a later retry still knows what to do.
    return result;
  }
  let changed = false;
  for (const name of Object.keys(recorded).sort()) {
    const installed = recorded[name]!;
    const existing = current.servers[name];
    if (!existing) {
      result.missing.push(name);
      continue;
    }
    if (JSON.stringify(existing) === JSON.stringify(installed)) {
      delete current.servers[name];
      result.removed.push(name);
      changed = true;
    } else {
      // The user edited this server after install — it is theirs now.
      result.kept.push(name);
    }
  }
  if (changed) saveMcpConfig(workspaceDir, current);
  const nextMap = readPluginMcpServerMap(pluginsDir);
  delete nextMap[pluginId];
  writePluginMcpServerMap(pluginsDir, nextMap);
  return result;
}
