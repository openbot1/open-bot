/**
 * Repo map v5 tools for @open-bot/tools (v1.13, Doi T3).
 *
 * The agent drives repo map v5 by tool call:
 *  - repomap_v5_build       — build/refresh symbol topology +
 *    hierarchical summaries + incremental index v5 (content hash +
 *    dependency invalidation) (read + cache write)
 *  - repomap_v5_search      — find a symbol by name/pattern on the
 *    code graph (exact/prefix/substring/regex/fuzzy), ranked by
 *    name match + PageRank + fan-in (read)
 *  - repomap_v5_definition  — jump-to-definition for the agent loop:
 *    where symbol X is defined, its context lines, and where it is
 *    used (read)
 *  - repomap_v5_callers     — callers / callees / importers of a
 *    symbol or module (read)
 *  - repomap_v5_summary     — hierarchical directory summary or
 *    token-budget skeleton of the whole repo (read)
 *  - repomap_v5_index       — incremental index status: which files
 *    changed/added/removed since the last build, which files were
 *    invalidated through their imports (read)
 *
 * SAFETY: everything here is local — no network, no X data, no Grok
 * Imagine, no cloud VM/accounts/payments. Repo map caches live under
 * `.open-bot/coding-v2/` (entries) and `.open-bot/coding-v5/` (index)
 * in the workspace. Read tools need no approval; build writes only
 * cache files inside the workspace.
 *
 * Factory:
 *   createRepomapV5Tools(opts) -> Tool[]   (bound, usable)
 *   REPOMAP_V5_TOOLS                       (unbound placeholder)
 *
 * NOTE: this module only DEFINES the tools. It does NOT touch the
 * central ALL_TOOLS registry — the coordinator wires it in later.
 */

import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { renderCodingV5Impact, renderCodingV5Skeleton, renderCodingV5SymbolHits } from '@open-bot/core';
import { CodingV5RepoMapStore } from './codingV5RepoMap';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export const REPOMAP_V5_TOOL_NAMES = [
  'repomap_v5_build',
  'repomap_v5_search',
  'repomap_v5_definition',
  'repomap_v5_callers',
  'repomap_v5_summary',
  'repomap_v5_index',
] as const;

export type RepomapV5ToolName = (typeof REPOMAP_V5_TOOL_NAMES)[number];

export function isRepomapV5ToolName(name: string): name is RepomapV5ToolName {
  return (REPOMAP_V5_TOOL_NAMES as readonly string[]).includes(name);
}

export interface RepomapV5ToolOptions {
  /** Fixed workspace directory (its repo map lives there). */
  workspaceDir?: string;
  /** Lazy workspace directory (host supplies it; overrides ctx when set). */
  getWorkspaceDir?: () => string | undefined;
  /** Pre-built repo map store (tests); defaults to one per workspaceDir. */
  repoMapStore?: CodingV5RepoMapStore;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}".`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function formatPlan(plan: {
  unchanged: string[];
  metadataOnly: string[];
  changed: string[];
  added: string[];
  removed: string[];
  invalidatedByDependency: string[];
  invalidatedCount: number;
  needsRebuild: boolean;
}): string {
  const lines = [
    `Incremental index v5: ${plan.unchanged.length} unchanged, ${plan.metadataOnly.length} metadata-only ` +
      `(mtime changed, same content hash — no re-parse), ${plan.changed.length} changed, ` +
      `${plan.added.length} added, ${plan.removed.length} removed, ` +
      `${plan.invalidatedByDependency.length} invalidated through imports. ` +
      `Invalidated total: ${plan.invalidatedCount}. Needs rebuild: ${plan.needsRebuild ? 'yes' : 'no'}.`,
  ];
  const show = (label: string, list: string[]): void => {
    if (list.length > 0) lines.push(`${label} (${list.length}): ${list.slice(0, 20).join(', ')}${list.length > 20 ? ` (+${list.length - 20} more)` : ''}`);
  };
  show('Changed', plan.changed);
  show('Added', plan.added);
  show('Removed', plan.removed);
  show('Invalidated by dependency', plan.invalidatedByDependency);
  show('Metadata-only', plan.metadataOnly);
  return lines.join('\n');
}

export function createRepomapV5Tools(opts: RepomapV5ToolOptions = {}): Tool[] {
  const repoMapStores = new Map<string, CodingV5RepoMapStore>();

  const resolveRoot = (ctx: ToolContext): string => {
    const dir = opts.workspaceDir ?? opts.getWorkspaceDir?.() ?? ctx.workspaceDir;
    if (!dir || typeof dir !== 'string' || dir.trim() === '') {
      throw new Error(
        'workspaceDir is required (host must pass it to createRepomapV5Tools, or the tool context must carry it).',
      );
    }
    return path.resolve(dir);
  };

  const repoMapOf = (root: string): CodingV5RepoMapStore => {
    if (opts.repoMapStore) return opts.repoMapStore;
    let store = repoMapStores.get(root);
    if (!store) {
      store = new CodingV5RepoMapStore(root);
      repoMapStores.set(root, store);
    }
    return store;
  };

  // --- repomap_v5_build ------------------------------------------------------

  const repoMapBuild: Tool = {
    definition: toolDef(
      'repomap_v5_build',
      'Build or refresh the repo map v5 for a workspace: symbol topology (exports/imports/call sites), ' +
        'hierarchical directory summaries, and the incremental index v5 (content hash + dependency ' +
        'invalidation). Incremental: only files whose content really changed are re-parsed; files whose ' +
        'mtime changed but content hash matches are kept. Writes cache files under .open-bot/coding-v5/ ' +
        'inside the workspace. Honest limits: call sites are extracted by regex (calls through an ' +
        'intermediate variable or dynamic calls are missed); ambiguous names (defined in several files) ' +
        'are flagged, never guessed.',
      {
        force: { type: 'boolean', description: 'Rebuild from scratch, ignoring the old cache.' },
        maxFiles: { type: 'number', description: 'Maximum files to scan (default 2000).' },
      },
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        const result = await store.build({
          force: args['force'] === true,
          maxFiles: getNumberArg(args, 'maxFiles'),
        });
        const t = result.topology;
        const lines = [
          `Repo map v5 built for "${root}": ${result.files} file(s), ${result.symbols} symbol(s), ` +
            `${result.edges} graph edge(s) in ${result.durationMs} ms ` +
            `(${result.reparsed} re-parsed, ${result.reused} reused, ${result.removed} removed; ` +
            `${result.metadataOnly} metadata-only, ${result.invalidatedByDependency} invalidated by dependency).`,
          t
            ? `Topology: ${t.exports} export(s) (${t.exportsLinked} linked), ${t.imports} import(s) ` +
              `(${t.importsResolved} resolved, ${t.importsExternal} external, ${t.importsTypeOnly} type-only, ` +
              `${t.importsDynamic} dynamic), ${t.callSites} call site(s) (${t.callsResolved} resolved, ` +
              `${t.callsAmbiguous} ambiguous, ${t.callsUnresolved} unresolved), ` +
              `${t.cycles} import cycle(s), ${t.orphans} orphan file(s).`
            : 'Topology: (empty — no code files found)',
          `Directories in the summary tree: ${result.directories}. ` +
            `Index cache v5: ${result.v5CachePath} (${result.v5CacheWritten ? 'written' : 'NOT written'}).`,
        ];
        if (result.plan) lines.push(formatPlan(result.plan));
        if (result.warnings.length > 0) lines.push(`Warnings: ${result.warnings.join(' | ')}`);
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- repomap_v5_search -----------------------------------------------------

  const repoMapSearch: Tool = {
    definition: toolDef(
      'repomap_v5_search',
      'Find a symbol by name or pattern on the repo map v5 code graph. Modes: exact, prefix, substring, ' +
        'regex, fuzzy (subsequence). Results are ranked by name match + file/symbol PageRank + fan-in ' +
        '(how many callers use the symbol). Returns file:line, kind, match mode and relevance for each hit. ' +
        'Read-only, needs no approval. Requires repomap_v5_build first (or it builds on demand).',
      {
        query: { type: 'string', description: 'Symbol name or pattern to find.' },
        mode: {
          type: 'string',
          description: 'Match mode: exact, prefix, substring (default), regex, fuzzy.',
        },
        kind: { type: 'string', description: 'Filter by symbol kind (function, class, method, interface, type, enum).' },
        file: { type: 'string', description: 'Only search in this file (path relative to the workspace).' },
        directory: { type: 'string', description: 'Only search in this directory (relative path).' },
        limit: { type: 'number', description: 'Maximum hits (default 20).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const modeRaw = getOptionalStringArg(args, 'mode') ?? 'substring';
        const validModes = ['exact', 'prefix', 'substring', 'regex', 'fuzzy'] as const;
        if (!(validModes as readonly string[]).includes(modeRaw)) {
          return errorResult(`mode must be one of: ${validModes.join(', ')}.`);
        }
        const limit = getNumberArg(args, 'limit');
        if (limit !== undefined && limit <= 0) return errorResult('limit must be a positive number.');
        const { hits, modeUsed, fellBack } = store.searchSymbols(getStringArg(args, 'query'), {
          mode: modeRaw as (typeof validModes)[number],
          kind: getOptionalStringArg(args, 'kind'),
          file: getOptionalStringArg(args, 'file'),
          directory: getOptionalStringArg(args, 'directory'),
          limit,
        });
        const header =
          `Symbol search "${getStringArg(args, 'query')}" (mode ${modeUsed}${fellBack ? ', fell back from the requested mode' : ''}): ` +
          `${hits.length} hit(s).`;
        return truncate(`${header}\n${renderCodingV5SymbolHits(hits)}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- repomap_v5_definition -------------------------------------------------

  const repoMapDefinition: Tool = {
    definition: toolDef(
      'repomap_v5_definition',
      'Jump-to-definition for the agent loop: where is symbol X defined, and where is it used? Returns the ' +
        'best definition (file:line:column, kind, signature, a few context lines), all definitions when the ' +
        'name is ambiguous, and usages (call sites, imports, references). When the symbol is not found, ' +
        'returns the closest name suggestions. Read-only, needs no approval. Honest limits: the "best" ' +
        'definition is a heuristic (definition in the file you are reading > public export > PageRank); ' +
        'call sites come from regex extraction, so calls through an intermediate variable are missed.',
      {
        symbol: { type: 'string', description: 'Symbol name (short name or qualified name, e.g. Foo.save).' },
        fromFile: {
          type: 'string',
          description: 'File the agent is currently reading — a definition in this file is preferred.',
        },
        contextLines: { type: 'number', description: 'Context lines on each side of the definition (default 3).' },
        usageLimit: { type: 'number', description: 'Maximum usages to show (default 10).' },
      },
      ['symbol'],
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const { rendered } = store.jumpToDefinition(getStringArg(args, 'symbol'), {
          fromFile: getOptionalStringArg(args, 'fromFile'),
          contextLines: getNumberArg(args, 'contextLines'),
          usageLimit: getNumberArg(args, 'usageLimit'),
        });
        return truncate(rendered);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- repomap_v5_callers ----------------------------------------------------

  const repoMapCallers: Tool = {
    definition: toolDef(
      'repomap_v5_callers',
      'Callers / callees / importers / impact on the repo map v5 code graph. kind=callers: which functions call this ' +
        'symbol (with the calling line). kind=callees: which functions this symbol calls. kind=importers: ' +
        'which files import a module (give a file path, file name, or bare specifier such as "react"). ' +
        'kind=impact: if I change this symbol, which symbols/files may be affected (callers + importers, ' +
        'transitive up to a depth, over-approximation by design)? ' +
        'Read-only, needs no approval. Callers/callees come from regex-extracted call sites; ambiguous ' +
        'callees (same name defined in several files) are reported as ambiguous, never guessed.',
      {
        kind: {
          type: 'string',
          description: 'What to find: callers, callees, importers, or impact.',
        },
        symbol: { type: 'string', description: 'Symbol name (for callers/callees/impact) or module query (for importers).' },
        file: { type: 'string', description: 'File of the symbol (for callees; path relative to the workspace).' },
        maxDepth: { type: 'number', description: 'Maximum depth for kind=impact (default 3).' },
        limit: { type: 'number', description: 'Maximum results (default 20).' },
      },
      ['kind', 'symbol'],
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const kind = getStringArg(args, 'kind');
        const symbol = getStringArg(args, 'symbol');
        const limit = getNumberArg(args, 'limit');
        if (limit !== undefined && limit <= 0) return errorResult('limit must be a positive number.');
        if (kind === 'callers') {
          const { callers, definitions, ambiguous } = store.callersOf(symbol, { limit });
          const lines = [
            `Callers of "${symbol}": ${callers.length} call site(s)` +
              (definitions.length > 0 ? ` (definition(s): ${definitions.join(', ')})` : ' (no definition found)') +
              (ambiguous ? ' — ambiguous name, callers of ALL definitions are listed.' : ''),
          ];
          for (const c of callers) {
            lines.push(`  - ${c.caller || '(top-level)'} in ${c.callerFile}:${c.callLine} calls ${c.calleeQualified}`);
          }
          if (callers.length === 0) lines.push('  (no callers found)');
          return truncate(lines.join('\n'));
        }
        if (kind === 'callees') {
          const file = getOptionalStringArg(args, 'file');
          if (!file) return errorResult('kind=callees requires the "file" argument (file of the symbol).');
          const { callees, found } = store.calleesOf(file, symbol, { limit });
          const lines = [`Callees of "${symbol}" in ${file}: ${callees.length} call(s)${found ? '' : ' (symbol not found in the index)'}.`];
          for (const c of callees) {
            lines.push(
              `  - ${c.callee} at line ${c.callLine}` +
                (c.calleeFile ? ` -> ${c.calleeFile}${c.calleeQualified ? `#${c.calleeQualified}` : ''}` : ' (unresolved: external or global)') +
                (c.ambiguous ? ' [ambiguous]' : ''),
            );
          }
          if (callees.length === 0) lines.push('  (no calls found)');
          return truncate(lines.join('\n'));
        }
        if (kind === 'importers') {
          const result = store.importersOf(symbol, { limit });
          const lines = [
            `Importers of "${symbol}": ${result.totalImporters} file(s)` +
              (result.resolvedTarget ? ` (resolved to ${result.resolvedTarget})` : ' (bare specifier, outside the repo)'),
          ];
          for (const imp of result.importers) {
            lines.push(`  - ${imp.file}:${imp.line} imports "${imp.specifier}" (${imp.kind}${imp.importedNames.length > 0 ? `, ${imp.importedNames.join(', ')}` : ''})`);
          }
          if (result.importers.length === 0) lines.push('  (no importers found)');
          return truncate(lines.join('\n'));
        }
        if (kind === 'impact') {
          const result = store.impactOf(symbol, {
            maxDepth: getNumberArg(args, 'maxDepth'),
            limit,
          });
          return truncate(renderCodingV5Impact(result));
        }
        return errorResult('kind must be one of: callers, callees, importers, impact.');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- repomap_v5_summary ----------------------------------------------------

  const repoMapSummary: Tool = {
    definition: toolDef(
      'repomap_v5_summary',
      'Hierarchical summary of the repo (repo map v5). section=skeleton: a token-budget skeleton of the whole ' +
        'repo (directories with file/symbol counts, top symbols, dependencies, cycles, orphans). ' +
        'section=directory: the summary of one directory (with its subtree). section=topology: the symbol ' +
        'topology summary (exports/imports/call sites, hubs, cycles, orphans). Read-only, needs no approval.',
      {
        section: { type: 'string', description: 'What to show: skeleton (default), directory, or topology.' },
        directory: { type: 'string', description: 'Directory for section=directory (relative path, empty = root).' },
        budgetTokens: { type: 'number', description: 'Token budget for the skeleton (default 2000).' },
        maxDepth: { type: 'number', description: 'Maximum directory depth in the skeleton (0 = unlimited).' },
      },
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        await store.ensureBuilt();
        const section = getOptionalStringArg(args, 'section') ?? 'skeleton';
        if (section === 'topology') {
          return truncate(store.topologySummary());
        }
        if (section === 'directory') {
          const dir = getOptionalStringArg(args, 'directory') ?? '';
          const summary = store.summaryOf(dir);
          if (!summary) return errorResult(`No summary for directory "${dir || '(root)'}".`);
          const lines = [
            `Directory "${dir || '(root)'}": ${summary.filesTotal} file(s) total (${summary.filesDirect} direct), ` +
              `${summary.symbolsTotal} symbol(s) [${Object.entries(summary.symbolsByKind).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')}], ` +
              `${summary.exportsTotal} public export(s), score ${summary.score.toFixed(3)}.`,
          ];
          if (summary.topSymbols.length > 0) {
            lines.push('Top symbols:');
            for (const s of summary.topSymbols) lines.push(`  - ${s.qualifiedName} (${s.kind}) — ${s.file}:${s.line} (score ${s.score.toFixed(4)})`);
          }
          if (summary.dependsOn.length > 0) {
            lines.push(`Depends on: ${summary.dependsOn.map((d) => `${d.directory || '(root)'} x${d.edges} (e.g. ${d.exampleFile})`).join(', ')}`);
          }
          if (summary.dependedBy.length > 0) {
            lines.push(`Depended by: ${summary.dependedBy.map((d) => `${d.directory || '(root)'} x${d.edges} (e.g. ${d.exampleFile})`).join(', ')}`);
          }
          if (summary.children.length > 0) lines.push(`Subdirectories: ${summary.children.join(', ')}`);
          if (summary.internalCycles > 0) lines.push(`Import cycles inside: ${summary.internalCycles}`);
          if (summary.orphans > 0) lines.push(`Orphan files: ${summary.orphans}`);
          return truncate(lines.join('\n'));
        }
        if (section === 'skeleton') {
          const skeleton = store.skeleton({
            budgetTokens: getNumberArg(args, 'budgetTokens'),
            maxDepth: getNumberArg(args, 'maxDepth'),
            seedDirectory: getOptionalStringArg(args, 'directory'),
          });
          const footer = skeleton.truncated
            ? `\n(truncated by budget: ${skeleton.excludedDirectories.length} directorie(s) left out)`
            : '';
          return truncate(`${skeleton.text}${footer}`);
        }
        return errorResult('section must be one of: skeleton, directory, topology.');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- repomap_v5_index ------------------------------------------------------

  const repoMapIndex: Tool = {
    definition: toolDef(
      'repomap_v5_index',
      'Incremental index v5 status: which files changed/added/removed since the last build, which files ' +
        'changed only in metadata (same content hash — no re-parse needed), and which files were invalidated ' +
        'through their imports (dependency invalidation). Does NOT rebuild. Read-only, needs no approval.',
      {},
    ),
    needsApproval: false,
    async execute(_args, ctx: ToolContext) {
      try {
        const root = resolveRoot(ctx);
        const store = repoMapOf(root);
        const checked = store.checkIndexFreshness();
        if ('error' in checked) return errorResult(checked.error);
        const stats = store.stats();
        const header =
          `Index v5 for "${root}": ${stats.files} file(s), ${stats.symbols} symbol(s), ` +
          `${stats.exports} export(s), ${stats.imports} import(s), ${stats.callSites} call site(s), ` +
          `${stats.directories} directorie(s) — built: ${stats.built ? 'yes' : 'no'}.`;
        return truncate(`${header}\n${formatPlan(checked)}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [repoMapBuild, repoMapSearch, repoMapDefinition, repoMapCallers, repoMapSummary, repoMapIndex];
}

/** Unbound placeholder (host must call createRepomapV5Tools to get usable tools). */
export const REPOMAP_V5_TOOLS: Tool[] = createRepomapV5Tools();
