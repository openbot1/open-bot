/**
 * Bot marketplace v3 — collections, version history, compatibility
 * checks, and install-into-a-fleet-workspace.
 *
 * Builds on marketplaceV2.ts (catalog + ratings + one-click install)
 * without changing it:
 *
 * - Collections: curated bundles of catalog entries ("starter pack
 *   for research", "coding crew", …) stored in
 *   `<baseDir>/marketplace/collections.json`. A collection is a list
 *   of entry ids plus a name/description — installing a collection
 *   installs each entry that still exists, and reports the ones that
 *   do not (a stale id never aborts the whole bundle).
 * - Version history: `<baseDir>/marketplace/versions.json` records
 *   (version, changelog, at) per entry, newest first. Built-in
 *   templates start at 1.0.0; publishers record new versions when they
 *   re-publish an agent. History is local metadata, not a download.
 * - Compatibility: before installing, `checkEntryCompatibility`
 *   compares the entry's suggested tools against the tools this
 *   machine actually has (passed in by the caller — the catalog does
 *   not guess) and reports the missing ones. A bot whose tools are
 *   missing still installs — the check is a warning, not a gate —
 *   because the tools may be added later.
 * - Install into a fleet workspace: `installMarketplaceV3EntryToWorkspace`
 *   installs the entry (via v2) and records where it went in
 *   `<baseDir>/marketplace/installs.json`, so the fleet console can
 *   show which workspace runs which marketplace bot.
 *
 * LOCAL ONLY, like v2: no central server, no network, no account.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotConfig } from '../types';
import { MARKETPLACE_DIR } from './marketplace';
import {
  buildMarketplaceV2Catalog,
  installMarketplaceV2Entry,
  type MarketplaceV2Entry,
} from './marketplaceV2';

export const MARKETPLACE_V3_COLLECTIONS_FILE = 'collections.json';
export const MARKETPLACE_V3_VERSIONS_FILE = 'versions.json';
export const MARKETPLACE_V3_INSTALLS_FILE = 'installs.json';

/** One curated bundle of catalog entries. */
export interface MarketplaceCollection {
  id: string;
  name: string;
  description: string;
  /** Catalog entry ids (`tpl:<id>` / `pub:<id>`). */
  entryIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One recorded version of a catalog entry. */
export interface MarketplaceEntryVersion {
  version: string;
  /** What changed in this version (free text, may be empty). */
  changelog: string;
  at: string;
  author?: string;
}

/** One install of a catalog entry, and where it went. */
export interface MarketplaceInstallRecord {
  id: string;
  entryId: string;
  /** Id of the fresh BotConfig created by the install. */
  botId: string;
  /** Fleet workspace id the bot was installed into ('' = local, no fleet target). */
  workspaceId: string;
  installedBy: string;
  at: string;
}

/** Compatibility verdict for one catalog entry. */
export interface MarketplaceCompatibility {
  entryId: string;
  compatible: boolean;
  /** Suggested tools this machine does not have (empty = fully compatible). */
  missingTools: string[];
  /** Tools the entry suggests (from its tags, minus its category). */
  requiredTools: string[];
}

function marketplaceDir(baseDir: string): string {
  return path.join(baseDir, MARKETPLACE_DIR);
}

function collectionsPath(baseDir: string): string {
  return path.join(marketplaceDir(baseDir), MARKETPLACE_V3_COLLECTIONS_FILE);
}

function versionsPath(baseDir: string): string {
  return path.join(marketplaceDir(baseDir), MARKETPLACE_V3_VERSIONS_FILE);
}

function installsPath(baseDir: string): string {
  return path.join(marketplaceDir(baseDir), MARKETPLACE_V3_INSTALLS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonArray(filePath: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function cleanIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function collectionId(name: string): string {
  return `col-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}-${Date.now().toString(36)}`;
}

function validateCollection(raw: unknown): MarketplaceCollection | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, entryIds, createdBy, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof description !== 'string') return null;
  if (typeof createdBy !== 'string' || createdBy.trim().length === 0) return null;
  if (typeof createdAt !== 'string' || createdAt.trim().length === 0) return null;
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) return null;
  return {
    id: id.trim(),
    name: name.trim(),
    description,
    entryIds: cleanIdList(entryIds),
    createdBy: createdBy.trim(),
    createdAt,
    updatedAt,
  };
}

function validateVersion(raw: unknown): MarketplaceEntryVersion | null {
  if (!isRecord(raw)) return null;
  const { version, changelog, at, author } = raw;
  if (typeof version !== 'string' || version.trim().length === 0) return null;
  if (typeof changelog !== 'string') return null;
  if (typeof at !== 'string' || at.trim().length === 0) return null;
  if (author !== undefined && typeof author !== 'string') return null;
  return {
    version: version.trim(),
    changelog,
    at,
    ...(author !== undefined ? { author } : {}),
  };
}

function validateInstall(raw: unknown): MarketplaceInstallRecord | null {
  if (!isRecord(raw)) return null;
  const { id, entryId, botId, workspaceId, installedBy, at } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof entryId !== 'string' || entryId.trim().length === 0) return null;
  if (typeof botId !== 'string' || botId.trim().length === 0) return null;
  if (typeof workspaceId !== 'string') return null;
  if (typeof installedBy !== 'string' || installedBy.trim().length === 0) return null;
  if (typeof at !== 'string' || at.trim().length === 0) return null;
  return {
    id: id.trim(),
    entryId: entryId.trim(),
    botId: botId.trim(),
    workspaceId,
    installedBy: installedBy.trim(),
    at,
  };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** All collections (corrupt rows dropped, never fatal). */
export function listMarketplaceCollections(baseDir: string): MarketplaceCollection[] {
  return readJsonArray(collectionsPath(baseDir))
    .map((row) => validateCollection(row))
    .filter((c): c is MarketplaceCollection => c !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface CreateCollectionInput {
  name: string;
  description?: string;
  entryIds: string[];
  createdBy: string;
}

/**
 * Create a collection. Entry ids must exist in the v2 catalog —
 * a bundle pointing at nothing is refused up front.
 */
export function createMarketplaceCollection(
  baseDir: string,
  input: CreateCollectionInput,
): MarketplaceCollection {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('marketplace collection needs a non-empty name.');
  }
  if (typeof input.createdBy !== 'string' || input.createdBy.trim().length === 0) {
    throw new Error('marketplace collection needs a non-empty createdBy.');
  }
  const entryIds = cleanIdList(input.entryIds);
  if (entryIds.length === 0) {
    throw new Error('marketplace collection needs at least one entry id.');
  }
  const catalog = buildMarketplaceV2Catalog(baseDir);
  const unknown = entryIds.filter((id) => !catalog.some((e) => e.id === id));
  if (unknown.length > 0) {
    throw new Error(`marketplace collection has unknown entries: ${unknown.join(', ')}`);
  }
  const now = new Date().toISOString();
  const collection: MarketplaceCollection = {
    id: collectionId(input.name),
    name: input.name.trim(),
    description: input.description ?? '',
    entryIds,
    createdBy: input.createdBy.trim(),
    createdAt: now,
    updatedAt: now,
  };
  const collections = listMarketplaceCollections(baseDir);
  writeJsonFile(collectionsPath(baseDir), [...collections, collection]);
  return collection;
}

/** Remove a collection. Returns true when one was removed. */
export function removeMarketplaceCollection(baseDir: string, id: string): boolean {
  const collections = listMarketplaceCollections(baseDir);
  const next = collections.filter((c) => c.id !== id);
  if (next.length === collections.length) return false;
  writeJsonFile(collectionsPath(baseDir), next);
  return true;
}

/** Resolve a collection to its catalog entries (skips ids that no longer exist). */
export function resolveMarketplaceCollection(
  baseDir: string,
  collectionIdValue: string,
): { collection: MarketplaceCollection; entries: MarketplaceV2Entry[]; missingIds: string[] } {
  const collection = listMarketplaceCollections(baseDir).find((c) => c.id === collectionIdValue);
  if (!collection) throw new Error(`marketplace collection not found: ${collectionIdValue}`);
  const catalog = buildMarketplaceV2Catalog(baseDir);
  const entries: MarketplaceV2Entry[] = [];
  const missingIds: string[] = [];
  for (const entryId of collection.entryIds) {
    const found = catalog.find((e) => e.id === entryId);
    if (found) entries.push(found);
    else missingIds.push(entryId);
  }
  return { collection, entries, missingIds };
}

export interface InstallCollectionResult {
  collection: MarketplaceCollection;
  installed: Array<{ entry: MarketplaceV2Entry; config: BotConfig }>;
  /** Entry ids that no longer exist in the catalog (skipped, not fatal). */
  skippedIds: string[];
}

/**
 * Install every entry of a collection. Each install creates a fresh
 * BotConfig (via v2) and bumps that entry's install count. Missing
 * entries are reported in `skippedIds`, never fatal.
 */
export function installMarketplaceCollection(
  baseDir: string,
  collectionIdValue: string,
): InstallCollectionResult {
  const { collection, entries, missingIds } = resolveMarketplaceCollection(baseDir, collectionIdValue);
  const installed: InstallCollectionResult['installed'] = [];
  for (const entry of entries) {
    const result = installMarketplaceV2Entry(baseDir, entry.id);
    installed.push({ entry: result.entry, config: result.config });
  }
  return { collection, installed, skippedIds: missingIds };
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

/** Version history for one entry, newest first (empty = no recorded versions). */
export function listMarketplaceEntryVersions(baseDir: string, entryId: string): MarketplaceEntryVersion[] {
  const all = readJsonRecord(versionsPath(baseDir))[entryId.trim()];
  if (!Array.isArray(all)) return [];
  return all
    .map((row) => validateVersion(row))
    .filter((v): v is MarketplaceEntryVersion => v !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Latest recorded version for one entry, or null when none is recorded. */
export function getMarketplaceLatestVersion(
  baseDir: string,
  entryId: string,
): MarketplaceEntryVersion | null {
  return listMarketplaceEntryVersions(baseDir, entryId)[0] ?? null;
}

/**
 * Record a new version for an entry. The entry must exist in the v2
 * catalog; the same version string twice replaces the older record
 * (re-publish, not a duplicate row).
 */
export function recordMarketplaceEntryVersion(
  baseDir: string,
  entryId: string,
  version: string,
  changelog: string,
  author?: string,
): MarketplaceEntryVersion {
  const id = entryId.trim();
  if (id.length === 0) throw new Error('marketplace version needs a non-empty entryId.');
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('marketplace version needs a non-empty version.');
  }
  if (typeof changelog !== 'string') throw new Error('marketplace version changelog must be a string.');
  const catalog = buildMarketplaceV2Catalog(baseDir);
  if (!catalog.some((e) => e.id === id)) {
    throw new Error(`marketplace entry not found: ${id}`);
  }
  const record: MarketplaceEntryVersion = {
    version: version.trim(),
    changelog,
    at: new Date().toISOString(),
    ...(author !== undefined && author.trim().length > 0 ? { author: author.trim() } : {}),
  };
  const all = readJsonRecord(versionsPath(baseDir));
  const mine = listMarketplaceEntryVersions(baseDir, id).filter((v) => v.version !== record.version);
  all[id] = [record, ...mine];
  writeJsonFile(versionsPath(baseDir), all);
  return record;
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * Check an entry against the tools this machine has. The entry's
 * required tools are its tags minus its category (templates list
 * their suggested tools as tags). `availableTools` is the caller's
 * list — the catalog never guesses what exists.
 */
export function checkEntryCompatibility(
  entry: MarketplaceV2Entry,
  availableTools: string[],
): MarketplaceCompatibility {
  const available = new Set(availableTools.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const requiredTools = entry.tags.filter((tag) => tag !== entry.category);
  const missingTools = requiredTools.filter((tool) => !available.has(tool.toLowerCase()));
  return { entryId: entry.id, compatible: missingTools.length === 0, missingTools, requiredTools };
}

// ---------------------------------------------------------------------------
// Install into a fleet workspace (recorded)
// ---------------------------------------------------------------------------

export interface InstallToWorkspaceResult {
  config: BotConfig;
  entry: MarketplaceV2Entry;
  record: MarketplaceInstallRecord;
}

/**
 * Install a catalog entry and record which fleet workspace it went
 * into. The BotConfig itself is unchanged (fresh id, empty
 * workspaceDir — the caller assigns the per-bot workspace); only the
 * record ties bot → workspace, so the fleet console can show it.
 */
export function installMarketplaceV3EntryToWorkspace(
  baseDir: string,
  entryId: string,
  workspaceId: string,
  installedBy: string,
): InstallToWorkspaceResult {
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new Error('marketplace v3 install needs a non-empty workspaceId.');
  }
  if (typeof installedBy !== 'string' || installedBy.trim().length === 0) {
    throw new Error('marketplace v3 install needs a non-empty installedBy.');
  }
  const result = installMarketplaceV2Entry(baseDir, entryId);
  const record: MarketplaceInstallRecord = {
    id: `ins-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    entryId: result.entry.id,
    botId: result.config.id,
    workspaceId: workspaceId.trim(),
    installedBy: installedBy.trim(),
    at: new Date().toISOString(),
  };
  const installs = listMarketplaceInstalls(baseDir);
  writeJsonFile(installsPath(baseDir), [...installs, record]);
  return { config: result.config, entry: result.entry, record };
}

/** All recorded installs, newest first. */
export function listMarketplaceInstalls(baseDir: string): MarketplaceInstallRecord[] {
  return readJsonArray(installsPath(baseDir))
    .map((row) => validateInstall(row))
    .filter((r): r is MarketplaceInstallRecord => r !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Recorded installs for one fleet workspace, newest first. */
export function listMarketplaceInstallsForWorkspace(
  baseDir: string,
  workspaceId: string,
): MarketplaceInstallRecord[] {
  return listMarketplaceInstalls(baseDir).filter((r) => r.workspaceId === workspaceId);
}
