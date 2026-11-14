/**
 * Plugin marketplace v3 — updates, dependencies, install queue,
 * and rollback records.
 *
 * Builds on the v2 catalog (plugins/catalog.ts: installed plugins +
 * templates merged by id, permission review) without changing it and
 * without touching the loader — this module never installs, enables,
 * or loads plugin code. It only answers questions and keeps records:
 *
 * - Updates: an installed plugin whose template ships a newer version
 *   has an update available (`checkPluginUpdates`). Version compare
 *   is numeric-segment based (`comparePluginVersions`); a version
 *   string that is not numeric at all compares lexicographically, so
 *   an odd version never crashes the check.
 * - Dependencies: a manifest may declare `dependencies: string[]`
 *   (plugin ids it needs). `checkPluginDependencies` reports which
 *   are missing from the catalog. No `dependencies` field means no
 *   dependencies — never inferred.
 * - Install queue: `<pluginsDir>/plugin-install-queue.json` — the
 *   waiting list of installs the user asked for. The queue records
 *   intent (plugin id, source, who asked, status); the actual
 *   install still runs through the existing staging/install IPC, which
 *   marks the queue entry done/failed afterwards.
 * - Rollback records: `<pluginsDir>/plugin-rollback.json` — one row
 *   per update that kept the previous version around (fromVersion →
 *   toVersion, where the snapshot lives, who did it), so the UI can
 *   offer "go back to vX" with the facts instead of a guess.
 *
 * LOCAL ONLY: everything here reads directories on this machine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginCatalogEntry } from './catalog';

export const PLUGIN_INSTALL_QUEUE_FILE = 'plugin-install-queue.json';
export const PLUGIN_ROLLBACK_FILE = 'plugin-rollback.json';

/** One plugin with a newer template version available. */
export interface PluginUpdateInfo {
  entryId: string;
  name: string;
  installedVersion: string;
  latestVersion: string;
  /** True when latestVersion is newer than installedVersion. */
  updateAvailable: boolean;
}

/** Dependency verdict for one plugin. */
export interface PluginDependencyCheck {
  entryId: string;
  /** Plugin ids the manifest declares as dependencies. */
  dependencies: string[];
  /** Declared dependencies not present in the catalog. */
  missing: string[];
  /** True when every declared dependency is installed or templated. */
  satisfied: boolean;
}

/** One queued install (intent only — install runs elsewhere). */
export interface QueuedPluginInstall {
  id: string;
  pluginId: string;
  /** Where the plugin comes from ('template' = a local template). */
  source: 'template';
  status: 'queued' | 'installing' | 'done' | 'failed' | 'cancelled';
  requestedBy: string;
  requestedAt: string;
  /** Error message when status = 'failed'. */
  error?: string;
  finishedAt?: string;
}

/** One recorded rollback snapshot of a plugin update. */
export interface PluginRollbackRecord {
  id: string;
  pluginId: string;
  fromVersion: string;
  toVersion: string;
  /** Where the previous version's files were kept ('' = no snapshot kept). */
  snapshotPath: string;
  recordedBy: string;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queuePath(pluginsDir: string): string {
  return path.join(pluginsDir, PLUGIN_INSTALL_QUEUE_FILE);
}

function rollbackPath(pluginsDir: string): string {
  return path.join(pluginsDir, PLUGIN_ROLLBACK_FILE);
}

function readJsonArray(filePath: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Compare two version strings. Numeric segments compare numerically
 * (`1.10.0` > `1.9.0`); non-numeric segments compare lexicographically;
 * a shorter version with an equal prefix is older (`1.2` < `1.2.0` is
 * false — equal prefixes compare by length, so `1.2` < `1.2.0`).
 * Returns <0 when a < b, 0 when equal, >0 when a > b.
 */
export function comparePluginVersions(a: string, b: string): number {
  const parse = (v: string): Array<number | string> =>
    v
      .trim()
      .split(/[.+_-]/)
      .filter((s) => s.length > 0)
      .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (typeof x === 'number') {
      return -1;
    } else if (typeof y === 'number') {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * For every installed plugin, compare against the template of the
 * same id (if any) and report whether a newer version is available.
 * Installed plugins with no template are reported with
 * updateAvailable: false (nothing newer is known locally).
 */
export function checkPluginUpdates(catalog: PluginCatalogEntry[]): PluginUpdateInfo[] {
  const templates = new Map<string, PluginCatalogEntry>();
  for (const entry of catalog) {
    if (entry.source === 'template') templates.set(entry.id, entry);
  }
  return catalog
    .filter((entry) => entry.source === 'installed')
    .map((entry) => {
      const template = templates.get(entry.id);
      const latestVersion = template?.version ?? entry.version;
      return {
        entryId: entry.id,
        name: entry.name,
        installedVersion: entry.version,
        latestVersion,
        updateAvailable: template !== undefined && comparePluginVersions(latestVersion, entry.version) > 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Plugins in the catalog that have an update available. */
export function listPluginsWithUpdates(catalog: PluginCatalogEntry[]): PluginUpdateInfo[] {
  return checkPluginUpdates(catalog).filter((u) => u.updateAvailable);
}

/**
 * Check one plugin's declared dependencies against the catalog.
 * `dependenciesById` maps plugin id -> declared dependency ids
 * (read from the raw manifest by the caller; absent = no deps).
 */
export function checkPluginDependencies(
  entryId: string,
  dependenciesById: Record<string, string[]>,
  catalog: PluginCatalogEntry[],
): PluginDependencyCheck {
  const id = entryId.trim();
  const dependencies = [...new Set((dependenciesById[id] ?? []).map((d) => d.trim()).filter(Boolean))];
  const present = new Set(catalog.map((e) => e.id));
  const missing = dependencies.filter((d) => !present.has(d));
  return { entryId: id, dependencies, missing, satisfied: missing.length === 0 };
}

/**
 * Read declared `dependencies` arrays from installed plugin manifests
 * on disk (raw JSON; a manifest without the field contributes nothing).
 * Invalid/missing manifests are skipped, never fatal.
 */
export function readInstalledPluginDependencies(pluginsDir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let dirNames: string[];
  try {
    dirNames = fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return out;
  }
  for (const dirName of dirNames) {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(pluginsDir, dirName, 'manifest.json'), 'utf8'),
      );
      if (!isRecord(parsed)) continue;
      if (typeof parsed.id !== 'string' || parsed.id.trim().length === 0) continue;
      if (!Array.isArray(parsed.dependencies)) continue;
      const deps = parsed.dependencies.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
      if (deps.length > 0) out[parsed.id.trim()] = deps.map((d) => d.trim());
    } catch {
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Install queue
// ---------------------------------------------------------------------------

function validateQueuedInstall(raw: unknown): QueuedPluginInstall | null {
  if (!isRecord(raw)) return null;
  const { id, pluginId, source, status, requestedBy, requestedAt, error, finishedAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) return null;
  if (source !== 'template') return null;
  if (!['queued', 'installing', 'done', 'failed', 'cancelled'].includes(status as string)) return null;
  if (typeof requestedBy !== 'string' || requestedBy.trim().length === 0) return null;
  if (typeof requestedAt !== 'string' || requestedAt.trim().length === 0) return null;
  if (error !== undefined && typeof error !== 'string') return null;
  if (finishedAt !== undefined && typeof finishedAt !== 'string') return null;
  return {
    id: id.trim(),
    pluginId: pluginId.trim(),
    source,
    status: status as QueuedPluginInstall['status'],
    requestedBy: requestedBy.trim(),
    requestedAt,
    ...(error !== undefined ? { error } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
}

/** All queued installs (corrupt rows dropped, never fatal), oldest first. */
export function listPluginInstallQueue(pluginsDir: string): QueuedPluginInstall[] {
  return readJsonArray(queuePath(pluginsDir))
    .map((row) => validateQueuedInstall(row))
    .filter((q): q is QueuedPluginInstall => q !== null)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

function savePluginInstallQueue(pluginsDir: string, queue: QueuedPluginInstall[]): void {
  writeJsonFile(queuePath(pluginsDir), queue);
}

function installQueueId(): string {
  return `piq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Enqueue an install (refused when the same plugin already has a queued/installing entry). */
export function enqueuePluginInstall(
  pluginsDir: string,
  pluginId: string,
  requestedBy: string,
): QueuedPluginInstall {
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    throw new Error('plugin install queue needs a non-empty pluginId.');
  }
  if (typeof requestedBy !== 'string' || requestedBy.trim().length === 0) {
    throw new Error('plugin install queue needs a non-empty requestedBy.');
  }
  const queue = listPluginInstallQueue(pluginsDir);
  const pending = queue.find(
    (q) => q.pluginId === pluginId.trim() && (q.status === 'queued' || q.status === 'installing'),
  );
  if (pending) {
    throw new Error(`plugin "${pluginId.trim()}" already has a pending install (${pending.id}).`);
  }
  const entry: QueuedPluginInstall = {
    id: installQueueId(),
    pluginId: pluginId.trim(),
    source: 'template',
    status: 'queued',
    requestedBy: requestedBy.trim(),
    requestedAt: new Date().toISOString(),
  };
  savePluginInstallQueue(pluginsDir, [...queue, entry]);
  return entry;
}

function updateQueueEntry(
  pluginsDir: string,
  id: string,
  patch: Partial<QueuedPluginInstall>,
): QueuedPluginInstall {
  const queue = listPluginInstallQueue(pluginsDir);
  const found = queue.find((q) => q.id === id);
  if (!found) throw new Error(`no queued plugin install with id "${id}".`);
  const updated: QueuedPluginInstall = { ...found, ...patch };
  savePluginInstallQueue(
    pluginsDir,
    queue.map((q) => (q.id === id ? updated : q)),
  );
  return updated;
}

/** Mark a queued install as installing (only from 'queued'). */
export function startPluginInstall(pluginsDir: string, id: string): QueuedPluginInstall {
  const found = listPluginInstallQueue(pluginsDir).find((q) => q.id === id);
  if (!found) throw new Error(`no queued plugin install with id "${id}".`);
  if (found.status !== 'queued') {
    throw new Error(`queued plugin install "${id}" is ${found.status}, not queued.`);
  }
  return updateQueueEntry(pluginsDir, id, { status: 'installing' });
}

/** Mark an installing install as done. */
export function finishPluginInstall(pluginsDir: string, id: string): QueuedPluginInstall {
  const found = listPluginInstallQueue(pluginsDir).find((q) => q.id === id);
  if (!found) throw new Error(`no queued plugin install with id "${id}".`);
  if (found.status !== 'installing') {
    throw new Error(`queued plugin install "${id}" is ${found.status}, not installing.`);
  }
  return updateQueueEntry(pluginsDir, id, { status: 'done', finishedAt: new Date().toISOString() });
}

/** Mark an installing/queued install as failed, with the error message. */
export function failPluginInstall(pluginsDir: string, id: string, error: string): QueuedPluginInstall {
  const found = listPluginInstallQueue(pluginsDir).find((q) => q.id === id);
  if (!found) throw new Error(`no queued plugin install with id "${id}".`);
  if (found.status !== 'queued' && found.status !== 'installing') {
    throw new Error(`queued plugin install "${id}" is ${found.status}, cannot fail it.`);
  }
  return updateQueueEntry(pluginsDir, id, {
    status: 'failed',
    error: error || 'install failed.',
    finishedAt: new Date().toISOString(),
  });
}

/** Cancel a queued (or installing) install. Returns the updated entry. */
export function cancelPluginInstall(pluginsDir: string, id: string): QueuedPluginInstall {
  const found = listPluginInstallQueue(pluginsDir).find((q) => q.id === id);
  if (!found) throw new Error(`no queued plugin install with id "${id}".`);
  if (found.status === 'done' || found.status === 'failed' || found.status === 'cancelled') {
    return found;
  }
  return updateQueueEntry(pluginsDir, id, { status: 'cancelled', finishedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Rollback records
// ---------------------------------------------------------------------------

function validateRollback(raw: unknown): PluginRollbackRecord | null {
  if (!isRecord(raw)) return null;
  const { id, pluginId, fromVersion, toVersion, snapshotPath, recordedBy, at } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) return null;
  if (typeof fromVersion !== 'string' || fromVersion.trim().length === 0) return null;
  if (typeof toVersion !== 'string' || toVersion.trim().length === 0) return null;
  if (typeof snapshotPath !== 'string') return null;
  if (typeof recordedBy !== 'string' || recordedBy.trim().length === 0) return null;
  if (typeof at !== 'string' || at.trim().length === 0) return null;
  return {
    id: id.trim(),
    pluginId: pluginId.trim(),
    fromVersion: fromVersion.trim(),
    toVersion: toVersion.trim(),
    snapshotPath,
    recordedBy: recordedBy.trim(),
    at,
  };
}

/** All rollback records, newest first. */
export function listPluginRollbacks(pluginsDir: string): PluginRollbackRecord[] {
  return readJsonArray(rollbackPath(pluginsDir))
    .map((row) => validateRollback(row))
    .filter((r): r is PluginRollbackRecord => r !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Rollback records for one plugin, newest first. */
export function listPluginRollbacksFor(pluginsDir: string, pluginId: string): PluginRollbackRecord[] {
  return listPluginRollbacks(pluginsDir).filter((r) => r.pluginId === pluginId);
}

/**
 * Record that an update kept the previous version around. The caller
 * copies the old files to `snapshotPath` first ('' = no snapshot was
 * kept — the record then only says which version was replaced).
 */
export function recordPluginRollback(
  pluginsDir: string,
  input: {
    pluginId: string;
    fromVersion: string;
    toVersion: string;
    snapshotPath?: string;
    recordedBy: string;
  },
): PluginRollbackRecord {
  if (typeof input.pluginId !== 'string' || input.pluginId.trim().length === 0) {
    throw new Error('plugin rollback needs a non-empty pluginId.');
  }
  if (typeof input.fromVersion !== 'string' || input.fromVersion.trim().length === 0) {
    throw new Error('plugin rollback needs a non-empty fromVersion.');
  }
  if (typeof input.toVersion !== 'string' || input.toVersion.trim().length === 0) {
    throw new Error('plugin rollback needs a non-empty toVersion.');
  }
  if (typeof input.recordedBy !== 'string' || input.recordedBy.trim().length === 0) {
    throw new Error('plugin rollback needs a non-empty recordedBy.');
  }
  const record: PluginRollbackRecord = {
    id: `prb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    pluginId: input.pluginId.trim(),
    fromVersion: input.fromVersion.trim(),
    toVersion: input.toVersion.trim(),
    snapshotPath: input.snapshotPath ?? '',
    recordedBy: input.recordedBy.trim(),
    at: new Date().toISOString(),
  };
  const records = listPluginRollbacks(pluginsDir);
  writeJsonFile(rollbackPath(pluginsDir), [record, ...records]);
  return record;
}
