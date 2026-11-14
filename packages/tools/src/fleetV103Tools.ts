/**
 * Fleet / marketplace v3 tools (v1.03, Team T6) — registered in
 * ALL_TOOLS (see tools.ts).
 *
 * Read-only tools so an agent can answer fleet questions without
 * opening the console:
 *
 * - `fleet_overview` — fleet totals, state counts, top consumers,
 *   quota alerts (from the fleet manager + quota files);
 * - `fleet_schedule_plan` — where a new bot should be placed
 *   (spread / binpack scoring over live fleet status);
 * - `marketplace_v3_search` — search the bot marketplace catalog
 *   (v2 catalog + v3 compatibility check against the tools this
 *   machine has);
 * - `plugin_marketplace_v3_check` — plugin updates available +
 *   dependency problems, from the local plugin catalog.
 *
 * Like the internet-data tools, these are placeholders in ALL_TOOLS
 * until the host binds them: `createFleetV103Tools(getBaseDir)` with
 * the app's userData dir wires them (fleet root is
 * `<userData>/fleet`, marketplace state is `<userData>/marketplace`,
 * plugins are `<userData>/plugins`). Unbound, they answer with a
 * clear "not configured" message instead of guessing paths. Nothing
 * here writes anything — placement and installs stay explicit human
 * (or UI) actions.
 */

import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  FleetManager,
  PLUGIN_TEMPLATES_DIR,
  buildFleetOverview,
  buildMarketplaceV2Catalog,
  checkBotQuotas,
  checkEntryCompatibility,
  checkPluginDependencies,
  checkPluginUpdates as checkPluginUpdatesV3,
  listMarketplaceV2Tags,
  loadBotQuotas,
  mergePluginCatalog,
  planPlacement,
  readInstalledPluginDependencies,
  readUsageSamplesFor,
  scanInstalledPlugins,
  scanPluginTemplatesAsCatalog,
  searchMarketplaceV2Catalog,
} from '@open-bot/core';

export const FLEET_V103_TOOL_NAMES = [
  'fleet_overview',
  'fleet_schedule_plan',
  'marketplace_v3_search',
  'plugin_marketplace_v3_check',
] as const;

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Argument "${name}" must be a number > 0.`);
  }
  return value;
}

const NOT_WIRED =
  'fleet v3 tools are not wired in this host (no userData dir configured) — open the fleet console UI instead.';

/** Fleet root / marketplace / plugin dirs derived from the app userData dir. */
function dirs(baseDir: string): {
  fleetRoot: string;
  pluginsDir: string;
  templatesDir: string;
} {
  return {
    fleetRoot: path.join(baseDir, 'fleet'),
    pluginsDir: path.join(baseDir, 'plugins'),
    templatesDir: path.join(baseDir, PLUGIN_TEMPLATES_DIR),
  };
}

/**
 * Build the 4 fleet/marketplace v3 tools. `getBaseDir` resolves the
 * app userData dir (null/undefined = unbound placeholders that explain
 * themselves instead of guessing paths). `getToolNames` resolves the
 * tool names installed on this machine, for the marketplace
 * compatibility check (undefined = compatibility reports every
 * suggested tool as missing — never guessed).
 */
export function createFleetV103Tools(
  getBaseDir?: () => string | null | undefined,
  getToolNames?: () => string[],
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const fleetOverviewTool: Tool = {
    definition: toolDef(
      'fleet_overview',
      'Fleet-wide overview: workspace counts by state, allocated vs actually used CPU/RAM/disk, top consumers, quota alerts. Read-only, local only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const manager = new FleetManager({ rootDir: fleetRoot });
        const statuses = manager.listFleet();
        const quotas = loadBotQuotas(fleetRoot);
        const samplesByBot: Record<string, ReturnType<typeof readUsageSamplesFor>> = {};
        for (const quota of quotas) samplesByBot[quota.botId] = readUsageSamplesFor(fleetRoot, quota.botId);
        const alerts = checkBotQuotas(quotas, samplesByBot);
        const overview = buildFleetOverview(statuses, quotas, alerts, samplesByBot);
        return JSON.stringify(overview, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fleetSchedulePlanTool: Tool = {
    definition: toolDef(
      'fleet_schedule_plan',
      'Plan where a new bot should be placed in the fleet: ranks every workspace by fit (spread = emptiest wins, binpack = fullest that fits wins). Read-only — placement itself stays an explicit admin action.',
      {
        botId: { type: 'string', description: 'Id of the bot to place.' },
        cpuCores: { type: 'number', description: 'CPU cores the bot needs.' },
        ramBytes: { type: 'number', description: 'RAM in bytes the bot needs.' },
        diskBytes: { type: 'number', description: 'Disk in bytes the bot needs.' },
        strategy: { type: 'string', enum: ['spread', 'binpack'], description: 'Placement strategy (default spread).' },
      },
      ['botId', 'cpuCores', 'ramBytes', 'diskBytes'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { fleetRoot } = dirs(base);
        const manager = new FleetManager({ rootDir: fleetRoot });
        const strategy = getStringArg(args, 'strategy', false);
        if (strategy && strategy !== 'spread' && strategy !== 'binpack') {
          return errorResult(`strategy must be 'spread' or 'binpack', got "${strategy}".`);
        }
        const plan = planPlacement(
          manager.listFleet(),
          {
            botId: getStringArg(args, 'botId'),
            cpuCores: getNumberArg(args, 'cpuCores', 0),
            ramBytes: getNumberArg(args, 'ramBytes', 0),
            diskBytes: getNumberArg(args, 'diskBytes', 0),
          },
          {
            strategy: (strategy || 'spread') as 'spread' | 'binpack',
            maxBotsPerWorkspace: 0,
            minFreeRamFraction: 0.1,
          },
        );
        return JSON.stringify(plan, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const marketplaceSearchTool: Tool = {
    definition: toolDef(
      'marketplace_v3_search',
      'Search the local bot marketplace catalog (built-in templates + locally published bots) with a compatibility check: which suggested tools of each entry this machine is missing. Read-only, local only.',
      {
        query: { type: 'string', description: 'Free text matched against name, description and tags.' },
        category: { type: 'string', description: 'Exact category filter (e.g. code, research).' },
        sort: { type: 'string', enum: ['rating', 'installs', 'name', 'newest'], description: 'Sort order (default rating).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const catalog = buildMarketplaceV2Catalog(base);
        const sort = getStringArg(args, 'sort', false);
        if (sort && !['rating', 'installs', 'name', 'newest'].includes(sort)) {
          return errorResult(`sort must be rating, installs, name or newest, got "${sort}".`);
        }
        const results = searchMarketplaceV2Catalog(catalog, {
          query: getStringArg(args, 'query', false) || undefined,
          category: getStringArg(args, 'category', false) || undefined,
          sort: (sort || 'rating') as 'rating' | 'installs' | 'name' | 'newest',
        }).slice(0, 20);
        const availableTools = getToolNames?.() ?? [];
        const withCompat = results.map((entry) => ({
          ...entry,
          compatibility: checkEntryCompatibility(entry, availableTools),
        }));
        return JSON.stringify(withCompat, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pluginCheckTool: Tool = {
    definition: toolDef(
      'plugin_marketplace_v3_check',
      'Check the local plugin marketplace: which installed plugins have a newer template version available, and which plugins miss declared dependencies. Read-only, local only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { pluginsDir, templatesDir } = dirs(base);
        const installed = scanInstalledPlugins(pluginsDir);
        const templates = scanPluginTemplatesAsCatalog(templatesDir);
        // Update detection needs BOTH rows for the same id (installed +
        // template); mergePluginCatalog drops the template row when the
        // plugin is installed, so the check runs on the unmerged union.
        const updates = checkPluginUpdatesV3([...installed, ...templates]);
        const catalog = mergePluginCatalog(installed, templates);
        const dependencies = readInstalledPluginDependencies(pluginsDir);
        const depChecks = catalog
          .filter((entry) => entry.source === 'installed')
          .map((entry) => checkPluginDependencies(entry.id, dependencies, catalog))
          .filter((check) => check.dependencies.length > 0);
        return JSON.stringify(
          {
            updatesAvailable: updates.filter((u) => u.updateAvailable),
            upToDate: updates.filter((u) => !u.updateAvailable).length,
            dependencyChecks: depChecks,
            tags: listMarketplaceV2Tags(buildMarketplaceV2Catalog(base)),
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [fleetOverviewTool, fleetSchedulePlanTool, marketplaceSearchTool, pluginCheckTool];
}

/** Unbound placeholders, registered in ALL_TOOLS (see tools.ts). */
export const FLEET_V103_TOOLS: Tool[] = createFleetV103Tools();
