/**
 * Coding agent v19 tools (v1.41, Đội T4) — 10 tools.
 *
 * Nối coding agent v18 tools (v1.40): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV19Tools(getBaseDir)` với userData
 * dir). Không gọi model thật, không gọi mạng — mọi tool làm việc trên
 * file local trong thư mục dữ liệu v19:
 *
 *   <base>/coding-v19/
 *     conversations/<id>/meta.json   (metadata conversation)
 *     conversations/<id>/events.jsonl (event log append-only)
 *     workspaces/<id>/               (workspace tách bạch theo conversation)
 *     snapshots/<checkpoint-id>/     (snapshot workspace + manifest)
 *     plugins/<name>.mcp.json       (manifest plugin đã cài)
 *     plugins.json                   (trạng thái load/config plugin)
 *     presets.json                   (preset custom)
 *
 *  - coding_v19_conversation — tạo/liệt kê/xem/kết thúc/archive conversation.
 *  - coding_v19_events       — append/list/replay/verify/compact event log.
 *  - coding_v19_workspace    — đọc/ghi/sửa/xoá/liệt kê file trong workspace
 *    tách bạch (path containment chặn traversal, có test chứng minh).
 *  - coding_v19_checkpoint   — tạo/liệt kê snapshot, rollback, diff viewer.
 *  - coding_v19_branch       — fork conversation từ event giữa chừng.
 *  - coding_v19_plugins      — load/unload plugin mcp.json, bật/tắt server.
 *  - coding_v19_plugin_config — xem/sửa/validate executable plugin config.
 *  - coding_v19_presets      — preset theo agent profile (CRUD/clone/apply).
 *  - coding_v19_marketplace  — list/search plugin đã cài + catalog.
 *  - coding_v19_agent        — chạy phiên agent v19 scripted end-to-end.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  renderV19AgentReport,
  renderV19ConversationStats,
  renderV19ConversationState,
  renderV19EventTimeline,
  renderV19WorkspaceStats,
  renderV19ConversationSummary,
  renderV19EventLog,
  renderV19Marketplace,
  renderV19PluginHealth,
  renderV19WorkspaceTree,
  renderV19PluginManifest,
  renderV19PluginState,
  renderV19PresetUsage,
  renderV19WorkspaceSearch,
  renderV19Preset,
  renderV19PresetApplyResult,
  renderV19PresetList,
  renderV19WorkspaceDiff,
  renderV19WorkspaceList,
  runV19Agent,
  v19AllPresets,
  v19ConversationBundleToJson,
  v19AppendEvent,
  v19ApplyPluginConfig,
  v19ApplyPreset,
  v19ArchiveConversation,
  v19BuiltinPresetById,
  v19ClonePreset,
  v19CompactEvents,
  v19ConversationDigest,
  v19ConversationMetaFromJson,
  v19ConversationStats,
  v19ConversationMetaToJson,
  v19CreateConversationMeta,
  v19CreatePreset,
  v19CreateSnapshot,
  v19DeletePreset,
  v19DiffSnapshots,
  v19DiffSnapshotToWorkspace,
  v19EndConversationEvents,
  v19EventsFromJsonl,
  v19ExportConversation,
  v19EventTimeline,
  v19EventsToJsonl,
  v19FindPreset,
  v19PluginManifestTemplate,
  v19ImportConversationBundle,
  v19ForkConversation,
  v19ForkSeqFromEventId,
  v19ListSnapshots,
  v19LoadPlugin,
  v19LoadSnapshot,
  v19ManifestToJson,
  v19MarketplaceList,
  v19MarketplaceSearch,
  v19PluginHealth,
  v19OpenConversationEvents,
  v19ParseManifestJson,
  v19RedactedConfig,
  v19PresetFromJson,
  v19PresetToJson,
  v19PresetUsage,
  v19PruneSnapshots,
  v19RenameConversation,
  v19ReplayEvents,
  v19RollbackSnapshot,
  v19SetServerEnabled,
  v19SummarizeConversation,
  v19UnloadPlugin,
  v19UpdatePreset,
  v19ValidateConfigAgainstSchema,
  v19ValidateConversationId,
  v19ValidateManifest,
  v19ValidatePresetInput,
  v19VerifyEventChain,
  v19SearchEvents,
  v19SearchWorkspace,
  v19WorkspaceDelete,
  v19WorkspaceEdit,
  v19WorkspaceList,
  v19WorkspaceRead,
  v19WorkspaceStats,
  v19WorkspaceTree,
  v19WorkspaceWrite,
  v19CheckWorkspacePath,
} from '@open-bot/core';
import type {
  V19AgentPreset,
  V19ConversationMeta,
  V19Event,
  V19PluginManifest,
  V19PluginState,
} from '@open-bot/core';

export const CODING_V19_TOOL_NAMES = [
  'coding_v19_conversation',
  'coding_v19_events',
  'coding_v19_workspace',
  'coding_v19_checkpoint',
  'coding_v19_branch',
  'coding_v19_plugins',
  'coding_v19_plugin_config',
  'coding_v19_presets',
  'coding_v19_marketplace',
  'coding_v19_agent',
] as const;

export type CodingV19ToolName = (typeof CODING_V19_TOOL_NAMES)[number];

export function isCodingV19ToolName(name: string): boolean {
  return (CODING_V19_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV19ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

/** Thư mục dữ liệu v19 trong base dir của host. */
export function codingV19DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v19');
}

/** Tạo (nếu chưa có) thư mục dữ liệu v19, trả đường dẫn. */
export function codingV19EnsureDataDir(baseDir: string): string {
  const dir = codingV19DataDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

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

function getStringArg(args: Record<string, unknown>, name: string, required = false): string {
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

function getIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${name}" must be an integer, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Parse một JSON string thành object (lỗi rõ ràng khi sai định dạng). */
function parseJsonObjectArg(raw: string, name: string): Record<string, unknown> {
  if (raw.trim() === '') throw new Error(`Argument "${name}" must be valid JSON object.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Argument "${name}" must be valid JSON object.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Đọc JSON file (trả fallback khi chưa có / lỗi parse). */
function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Ghi JSON file (tạo thư mục cha khi cần). */
function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------------ */
/* Layout thư mục dữ liệu v19                                          */
/* ------------------------------------------------------------------ */

function conversationsDir(dataDir: string): string {
  return path.join(dataDir, 'conversations');
}
function conversationDir(dataDir: string, conversationId: string): string {
  return path.join(conversationsDir(dataDir), conversationId);
}
function conversationMetaFile(dataDir: string, conversationId: string): string {
  return path.join(conversationDir(dataDir, conversationId), 'meta.json');
}
function conversationEventsFile(dataDir: string, conversationId: string): string {
  return path.join(conversationDir(dataDir, conversationId), 'events.jsonl');
}
function workspaceRootDir(dataDir: string, conversationId: string): string {
  return path.join(dataDir, 'workspaces', conversationId);
}
function snapshotsDir(dataDir: string): string {
  return path.join(dataDir, 'snapshots');
}
function pluginsDir(dataDir: string): string {
  return path.join(dataDir, 'plugins');
}
function pluginManifestFile(dataDir: string, pluginName: string): string {
  return path.join(pluginsDir(dataDir), `${pluginName}.mcp.json`);
}
function pluginStatesFile(dataDir: string): string {
  return path.join(dataDir, 'plugins.json');
}
function presetsFile(dataDir: string): string {
  return path.join(dataDir, 'presets.json');
}

/** Load meta conversation (throw khi không có). */
function loadConversationMeta(dataDir: string, conversationId: string): V19ConversationMeta {
  v19ValidateConversationId(conversationId);
  const file = conversationMetaFile(dataDir, conversationId);
  if (!fs.existsSync(file)) throw new Error(`Không có conversation "${conversationId}".`);
  return v19ConversationMetaFromJson(fs.readFileSync(file, 'utf8'));
}

/** Lưu meta conversation. */
function saveConversationMeta(dataDir: string, meta: V19ConversationMeta): void {
  writeJsonFile(conversationMetaFile(dataDir, meta.id), JSON.parse(v19ConversationMetaToJson(meta)) as unknown);
}

/** Load event log conversation (mảng rỗng khi chưa có file). */
function loadConversationEvents(dataDir: string, conversationId: string): V19Event[] {
  const file = conversationEventsFile(dataDir, conversationId);
  if (!fs.existsSync(file)) return [];
  return v19EventsFromJsonl(fs.readFileSync(file, 'utf8'));
}

/** Lưu event log conversation (JSONL). */
function saveConversationEvents(dataDir: string, conversationId: string, events: V19Event[]): void {
  const file = conversationEventsFile(dataDir, conversationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, v19EventsToJsonl(events), 'utf8');
}

/** Liệt kê id conversation đã lưu (sort theo meta.createdAt). */
function listConversationIds(dataDir: string): string[] {
  const dir = conversationsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(conversationMetaFile(dataDir, name)));
}

/** Load preset custom đã lưu. */
function loadCustomPresets(dataDir: string): V19AgentPreset[] {
  return readJsonFile<V19AgentPreset[]>(presetsFile(dataDir), []);
}

/** Lưu preset custom. */
function saveCustomPresets(dataDir: string, presets: V19AgentPreset[]): void {
  writeJsonFile(presetsFile(dataDir), presets);
}

/** Load trạng thái plugin đã lưu (record name -> state). */
function loadPluginStates(dataDir: string): Record<string, V19PluginState> {
  return readJsonFile<Record<string, V19PluginState>>(pluginStatesFile(dataDir), {});
}

/** Lưu trạng thái plugin. */
function savePluginStates(dataDir: string, states: Record<string, V19PluginState>): void {
  writeJsonFile(pluginStatesFile(dataDir), states);
}

/** Lấy tên plugin đã cài (để preset báo missingPlugins). */
function installedPluginNames(dataDir: string): string[] {
  return Object.keys(loadPluginStates(dataDir));
}

export function createCodingV19Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV19ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveDataDir = (ctx: ToolContext): string => {
    const base = resolveBase();
    if (base) return codingV19EnsureDataDir(base);
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      return codingV19EnsureDataDir(path.join(ctx.workspaceDir, '.open-bot'));
    }
    const fallback = toolOptions.getWorkspaceDir?.();
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
      return codingV19EnsureDataDir(path.join(fallback, '.open-bot'));
    }
    return codingV19EnsureDataDir(path.join(os.tmpdir(), 'open-bot-coding-v19'));
  };

  const tools: Tool[] = [
    {
      definition: toolDef(
        'coding_v19_conversation',
        'Manage coding v19 event-backed conversations: create (optionally from an agent profile preset), list, get/summary, end, archive, rename, stats, digest. Each conversation owns a separate workspace and an append-only event log.',
        {
          action: { type: 'string', description: 'Action: create | list | get | summary | end | archive | rename | stats | digest.' },
          conversationId: { type: 'string', description: 'Conversation id (for get/summary/end/archive).' },
          title: { type: 'string', description: 'Title for a new conversation (create).' },
          profileId: { type: 'string', description: 'Agent profile preset id to apply at creation (builtin: general | reviewer | refactorer | test-writer | docs, or a custom preset id).' },
          endReason: { type: 'string', description: 'Reason for ending the conversation (end).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'list') {
            const ids = listConversationIds(dataDir);
            if (ids.length === 0) return 'Chưa có conversation v19 nào.';
            const lines = ids.map((id) => {
              const meta = loadConversationMeta(dataDir, id);
              const events = loadConversationEvents(dataDir, id);
              return renderV19ConversationSummary(v19SummarizeConversation(meta, events));
            });
            return lines.join('\n---\n');
          }
          if (action === 'create') {
            const profileId = getStringArg(args, 'profileId');
            let resolvedPreset;
            if (profileId !== '') {
              const custom = loadCustomPresets(dataDir);
              const preset = v19FindPreset(custom, profileId) ?? v19BuiltinPresetById(profileId);
              if (!preset) return errorResult(`Không có preset/profile "${profileId}".`);
              resolvedPreset = v19ApplyPreset(preset, installedPluginNames(dataDir));
            }
            const meta = v19CreateConversationMeta(
              { title: getStringArg(args, 'title'), profileId, now: Date.now() },
              resolvedPreset,
            );
            const events = v19OpenConversationEvents(meta, Date.now());
            saveConversationMeta(dataDir, meta);
            saveConversationEvents(dataDir, meta.id, events);
            const warnings = resolvedPreset && resolvedPreset.missingPlugins.length > 0
              ? `\nCảnh báo: plugin chưa cài: ${resolvedPreset.missingPlugins.join(', ')}.`
              : '';
            return `Đã tạo conversation "${meta.title}" [${meta.id}] (profile: ${meta.profileId || '(không có)'}, workspace: workspaces/${meta.id}).${warnings}`;
          }
          const conversationId = getStringArg(args, 'conversationId', true);
          const meta = loadConversationMeta(dataDir, conversationId);
          const events = loadConversationEvents(dataDir, conversationId);
          if (action === 'rename') {
            const renamed = v19RenameConversation(meta, getStringArg(args, 'title', true), Date.now());
            saveConversationMeta(dataDir, renamed);
            return `Đã đổi tên conversation [${renamed.id}] thành "${renamed.title}".`;
          }
          if (action === 'stats' || action === 'digest') {
            const state = v19ReplayEvents(meta.id, events);
            const stats = v19ConversationStats(state, events);
            const wsStats = v19WorkspaceStats(v19WorkspaceList(workspaceRootDir(dataDir, conversationId)));
            if (action === 'stats') {
              return `${renderV19ConversationStats(stats)}\n${renderV19WorkspaceStats(wsStats)}\nTimeline:\n${renderV19EventTimeline(v19EventTimeline(events))}`;
            }
            return v19ConversationDigest(meta.title, meta.profileId, stats, wsStats, state);
          }
          if (action === 'get' || action === 'summary') {
            const summary = v19SummarizeConversation(meta, events);
            return `${renderV19ConversationSummary(summary)}\n${renderV19ConversationState(v19ReplayEvents(meta.id, events))}`;
          }
          if (action === 'end') {
            if (meta.status === 'archived') return errorResult(`Conversation "${conversationId}" đã archived — không end được.`);
            const nextEvents = v19EndConversationEvents(events, meta.id, getStringArg(args, 'endReason') || 'done', Date.now());
            saveConversationEvents(dataDir, meta.id, nextEvents);
            saveConversationMeta(dataDir, { ...meta, status: 'ended', updatedAt: Date.now() });
            return `Đã kết thúc conversation "${meta.title}" [${meta.id}] (${nextEvents.length} event).`;
          }
          if (action === 'archive') {
            const archived = v19ArchiveConversation(meta, Date.now());
            saveConversationMeta(dataDir, archived);
            return `Đã archive conversation "${meta.title}" [${meta.id}].`;
          }
          return errorResult(`Unknown action "${action}" (create | list | get | summary | end | archive | rename | stats | digest).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_events',
        'Work with a coding v19 conversation event log: append an event, list events, replay the log to restore state, verify the hash-chain, compact old file contents, search events, export a conversation bundle, import a bundle.',
        {
          action: { type: 'string', description: 'Action: append | list | replay | verify | compact.' },
          conversationId: { type: 'string', description: 'Conversation id.' },
          kind: { type: 'string', description: 'Event kind to append (user_message | assistant_message | tool_call | tool_result | file_edit | checkpoint | rollback | branch | preset_applied | plugin_change | note | session_start | session_end).' },
          actor: { type: 'string', description: 'Actor for the appended event (default agent).' },
          payloadJson: { type: 'string', description: 'JSON object payload for the appended event.' },
          fromSeq: { type: 'integer', description: 'First seq to list (default 1).' },
          toSeq: { type: 'integer', description: 'Last seq to list (default: end of log).' },
          query: { type: 'string', description: 'Text to search for in events (search).' },
          toolName: { type: 'string', description: 'Tool name filter (search).' },
          bundleJson: { type: 'string', description: 'Conversation bundle JSON to import (import).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'import') {
            const bundle = v19ImportConversationBundle(getStringArg(args, 'bundleJson', true));
            if (fs.existsSync(conversationMetaFile(dataDir, bundle.meta.id))) {
              return errorResult(`Đã có conversation "${bundle.meta.id}" — không import đè (xoá conversation cũ hoặc sửa bundle trước).`);
            }
            saveConversationMeta(dataDir, bundle.meta);
            saveConversationEvents(dataDir, bundle.meta.id, bundle.events);
            const root = workspaceRootDir(dataDir, bundle.meta.id);
            for (const file of bundle.workspaceFiles) {
              v19WorkspaceWrite(root, file.relPath, file.content);
            }
            return `Đã import conversation "${bundle.meta.title}" [${bundle.meta.id}] (${bundle.events.length} event, ${bundle.workspaceFiles.length} file workspace, hash-chain đã verify).`;
          }
          const conversationId = getStringArg(args, 'conversationId', true);
          const meta = loadConversationMeta(dataDir, conversationId);
          let events = loadConversationEvents(dataDir, conversationId);
          if (action === 'search') {
            const found = v19SearchEvents(events, {
              kind: getStringArg(args, 'kind') || undefined,
              text: getStringArg(args, 'query') || undefined,
              toolName: getStringArg(args, 'toolName') || undefined,
              filePath: getStringArg(args, 'filePath') || undefined,
              fromSeq: getIntArg(args, 'fromSeq'),
              toSeq: getIntArg(args, 'toSeq'),
            });
            if (found.length === 0) return '(không có event nào khớp)';
            return renderV19EventLog(found);
          }
          if (action === 'export') {
            const bundle = v19ExportConversation(meta, events, workspaceRootDir(dataDir, conversationId), Date.now());
            return v19ConversationBundleToJson(bundle);
          }
          if (action === 'list') {
            const fromSeq = getIntArg(args, 'fromSeq') ?? 1;
            const toSeq = getIntArg(args, 'toSeq');
            const slice = events.filter((e) => e.seq >= fromSeq && (toSeq === undefined || e.seq <= toSeq));
            if (slice.length === 0) return `(không có event nào trong khoảng seq ${fromSeq}..${toSeq ?? 'cuối'})`;
            return renderV19EventLog(slice);
          }
          if (action === 'replay') {
            return renderV19ConversationState(v19ReplayEvents(meta.id, events));
          }
          if (action === 'verify') {
            const chainError = v19VerifyEventChain(events);
            if (chainError !== '') return `Event log KHÔNG hợp lệ: ${chainError}`;
            return `Event log hợp lệ: ${events.length} event, hash-chain nguyên vẹn, seq liên tục 1..${events.length}.`;
          }
          if (action === 'compact') {
            const before = events.length;
            events = v19CompactEvents(events, 50);
            saveConversationEvents(dataDir, conversationId, events);
            const compacted = events.filter((e) => (e.payload.extra as Record<string, unknown> | undefined)?.['compacted'] === true).length;
            return `Đã compact event log (${before} event, ${compacted} file_edit cũ đã cắt nội dung — messages/tool calls/filesChanged vẫn replay đúng).`;
          }
          if (action === 'append') {
            const kind = getStringArg(args, 'kind', true);
            const payloadRaw = getStringArg(args, 'payloadJson');
            const payload = payloadRaw.trim() === '' ? {} : parseJsonObjectArg(payloadRaw, 'payloadJson');
            const actor = getStringArg(args, 'actor') || 'agent';
            events = v19AppendEvent(events, conversationId, { kind: kind as V19Event['kind'], actor, at: Date.now(), payload: payload as V19Event['payload'] });
            saveConversationEvents(dataDir, conversationId, events);
            saveConversationMeta(dataDir, { ...meta, updatedAt: Date.now() });
            const appended = events[events.length - 1]!;
            return `Đã append event seq ${appended.seq} (${appended.kind}) vào conversation ${conversationId}.`;
          }
          return errorResult(`Unknown action "${action}" (append | list | replay | verify | compact | search | export | import).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_workspace',
        'Work with a coding v19 per-conversation workspace (isolated directory): read/write/edit/delete/list files. Path containment blocks traversal outside the conversation workspace (including via symlinks).',
        {
          action: { type: 'string', description: 'Action: read | write | edit | delete | list | check.' },
          conversationId: { type: 'string', description: 'Conversation id (owns the workspace).' },
          filePath: { type: 'string', description: 'Path inside the workspace (relative; absolute paths are resolved against the workspace root and still contained).' },
          content: { type: 'string', description: 'File content to write (write) or new content replacing oldText (edit).' },
          oldText: { type: 'string', description: 'Text to replace (edit — must exist in the file).' },
          query: { type: 'string', description: 'Text to grep for in workspace files (search).' },
          caseSensitive: { type: 'boolean', description: 'Case-sensitive grep (search, default false).' },
        },
        ['action', 'conversationId'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const conversationId = getStringArg(args, 'conversationId', true);
          const dataDir = resolveDataDir(ctx);
          loadConversationMeta(dataDir, conversationId);
          const root = workspaceRootDir(dataDir, conversationId);
          const filePath = getStringArg(args, 'filePath');
          if (action === 'list') {
            return renderV19WorkspaceList(v19WorkspaceList(root));
          }
          if (action === 'search') {
            const result = v19SearchWorkspace(root, getStringArg(args, 'query', true), {
              caseSensitive: getBoolArg(args, 'caseSensitive') ?? false,
            });
            return renderV19WorkspaceSearch(result);
          }
          if (action === 'tree') {
            const tree = v19WorkspaceTree(v19WorkspaceList(root));
            if (tree.length === 0) return '(workspace rỗng)';
            return renderV19WorkspaceTree(tree);
          }
          if (action === 'check') {
            const check = v19CheckWorkspacePath(root, filePath);
            return check.inside
              ? `Path "${filePath}" nằm trong workspace (rel: "${check.relPath}").`
              : `Path "${filePath}" BỊ CHẶN: ${check.reason}`;
          }
          if (filePath === '') return errorResult('filePath không được rỗng.');
          if (action === 'read') {
            const file = v19WorkspaceRead(root, filePath);
            return file.content;
          }
          if (action === 'write') {
            const file = v19WorkspaceWrite(root, filePath, getStringArg(args, 'content', true));
            return `Đã ghi ${file.relPath} (${file.size} bytes, hash ${file.hash.slice(0, 12)}…).`;
          }
          if (action === 'edit') {
            const file = v19WorkspaceEdit(root, filePath, getStringArg(args, 'oldText', true), getStringArg(args, 'content', true));
            return `Đã sửa ${file.relPath} (${file.size} bytes, hash ${file.hash.slice(0, 12)}…).`;
          }
          if (action === 'delete') {
            const deleted = v19WorkspaceDelete(root, filePath);
            return `Đã xoá ${deleted} khỏi workspace.`;
          }
          return errorResult(`Unknown action "${action}" (read | write | edit | delete | list | check | search | tree).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_checkpoint',
        'Snapshot/checkpoint a coding v19 workspace and roll back to it: create a snapshot, list snapshots, roll back (restores files, deletes files created after the snapshot), and view a diff between a snapshot and the current workspace.',
        {
          action: { type: 'string', description: 'Action: create | list | rollback | diff.' },
          conversationId: { type: 'string', description: 'Conversation id.' },
          label: { type: 'string', description: 'Label for the new checkpoint (create).' },
          keep: { type: 'integer', description: 'Snapshots to keep when pruning (prune, default 10).' },
          checkpointId: { type: 'string', description: 'Checkpoint id (rollback/diff).' },
          otherCheckpointId: { type: 'string', description: 'Second checkpoint id (diff-snapshots).' },
        },
        ['action', 'conversationId'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const conversationId = getStringArg(args, 'conversationId', true);
          const dataDir = resolveDataDir(ctx);
          const meta = loadConversationMeta(dataDir, conversationId);
          const events = loadConversationEvents(dataDir, conversationId);
          const root = workspaceRootDir(dataDir, conversationId);
          const dir = snapshotsDir(dataDir);
          if (action === 'list') {
            const snapshots = v19ListSnapshots(dir, conversationId);
            if (snapshots.length === 0) return 'Chưa có checkpoint nào cho conversation này.';
            return snapshots
              .map((s) => `${s.id} — "${s.label}" (seq ${s.atSeq}, ${Object.keys(s.files).length} file)`)
              .join('\n');
          }
          if (action === 'create') {
            const label = getStringArg(args, 'label') || 'manual';
            const lastSeq = events.length === 0 ? 0 : events[events.length - 1]!.seq;
            const snapshot = v19CreateSnapshot(root, dir, conversationId, label, lastSeq, Date.now());
            const nextEvents = v19AppendEvent(events, conversationId, {
              kind: 'checkpoint',
              actor: 'system',
              at: Date.now(),
              payload: { checkpointId: snapshot.id, checkpointLabel: label },
            });
            saveConversationEvents(dataDir, conversationId, nextEvents);
            saveConversationMeta(dataDir, { ...meta, updatedAt: Date.now() });
            return `Đã tạo checkpoint ${snapshot.id} ("${label}", ${Object.keys(snapshot.files).length} file, seq ${lastSeq}).`;
          }
          if (action === 'prune') {
            const keep = getIntArg(args, 'keep') ?? 10;
            const deleted = v19PruneSnapshots(dir, conversationId, keep);
            if (deleted.length === 0) return `Snapshot của ${conversationId} chưa vượt giới hạn giữ ${keep} bản — không xoá gì.`;
            return `Đã prune ${deleted.length} snapshot cũ của ${conversationId} (giữ ${keep} bản mới nhất): ${deleted.join(', ')}.`;
          }
          const checkpointId = getStringArg(args, 'checkpointId', true);
          if (action === 'rollback') {
            const snapshot = v19LoadSnapshot(dir, checkpointId);
            if (!snapshot) return errorResult(`Không có snapshot "${checkpointId}".`);
            const result = v19RollbackSnapshot(root, dir, checkpointId, Date.now());
            const nextEvents = v19AppendEvent(loadConversationEvents(dataDir, conversationId), conversationId, {
              kind: 'rollback',
              actor: 'system',
              at: Date.now(),
              payload: { checkpointId },
            });
            saveConversationEvents(dataDir, conversationId, nextEvents);
            saveConversationMeta(dataDir, { ...meta, updatedAt: Date.now() });
            return `Đã rollback về ${checkpointId}: khôi phục ${result.restored.length} file (${result.restored.join(', ') || '(không có)'}), xoá ${result.deleted.length} file tạo sau snapshot (${result.deleted.join(', ') || '(không có)'}).`;
          }
          if (action === 'diff') {
            const entries = v19DiffSnapshotToWorkspace(root, dir, checkpointId);
            return `Diff ${checkpointId} -> workspace hiện tại:\n${renderV19WorkspaceDiff(entries)}`;
          }
          if (action === 'diff-snapshots') {
            const otherId = getStringArg(args, 'otherCheckpointId', true);
            const entries = v19DiffSnapshots(dir, checkpointId, otherId);
            return `Diff ${checkpointId} -> ${otherId}:\n${renderV19WorkspaceDiff(entries)}`;
          }
          return errorResult(`Unknown action "${action}" (create | list | rollback | diff | diff-snapshots | prune).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_branch',
        'Fork a coding v19 conversation from an event mid-log: the branch copies events up to that seq into a new conversation (re-hashed), keeps the preset snapshot of the parent, and records the branch link in both logs.',
        {
          action: { type: 'string', description: 'Action: fork | children.' },
          conversationId: { type: 'string', description: 'Parent conversation id.' },
          fromSeq: { type: 'integer', description: 'Seq of the event to fork from (fork).' },
          eventId: { type: 'string', description: 'Event id to fork from (alternative to fromSeq).' },
          title: { type: 'string', description: 'Title of the new branch conversation (fork).' },
        },
        ['action', 'conversationId'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const conversationId = getStringArg(args, 'conversationId', true);
          const dataDir = resolveDataDir(ctx);
          const parentMeta = loadConversationMeta(dataDir, conversationId);
          const parentEvents = loadConversationEvents(dataDir, conversationId);
          if (action === 'children') {
            const ids = listConversationIds(dataDir);
            const children = ids
              .map((id) => loadConversationMeta(dataDir, id))
              .filter((m) => m.parentId === conversationId);
            if (children.length === 0) return `Conversation ${conversationId} chưa có branch nào.`;
            return children.map((m) => `${m.title} [${m.id}] (rẽ từ seq ${m.branchedFromSeq}, trạng thái: ${m.status})`).join('\n');
          }
          if (action === 'fork') {
            const eventId = getStringArg(args, 'eventId');
            const fromSeq = eventId !== ''
              ? v19ForkSeqFromEventId(parentEvents, eventId)
              : (getIntArg(args, 'fromSeq') ?? 0);
            if (fromSeq < 1) return errorResult('fork cần fromSeq >= 1 hoặc eventId hợp lệ.');
            const title = getStringArg(args, 'title', true);
            const { childMeta, childEvents, parentEvents: nextParentEvents } = v19ForkConversation(
              parentMeta,
              parentEvents,
              fromSeq,
              title,
              Date.now(),
            );
            saveConversationMeta(dataDir, childMeta);
            saveConversationEvents(dataDir, childMeta.id, childEvents);
            saveConversationEvents(dataDir, parentMeta.id, nextParentEvents);
            return `Đã fork branch "${childMeta.title}" [${childMeta.id}] từ ${parentMeta.id} @seq ${fromSeq} (${childEvents.length} event đã copy, preset "${childMeta.profileId || '(không có)'}" được giữ nguyên).`;
          }
          return errorResult(`Unknown action "${action}" (fork | children).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_plugins',
        'Manage coding v19 Agent Plugins (mcp.json): load a plugin manifest (validated before load), unload it, list installed plugins, get one plugin, enable/disable one of its MCP servers, health-check all plugins, scaffold a new plugin manifest from a template.',
        {
          action: { type: 'string', description: 'Action: load | unload | list | get | enable-server | disable-server.' },
          manifestJson: { type: 'string', description: 'mcp.json content as JSON (load).' },
          pluginName: { type: 'string', description: 'Plugin name (unload/get/enable-server/disable-server; template name for template).' },
          category: { type: 'string', description: 'Plugin category for the template scaffold (template).' },
          serverId: { type: 'string', description: 'MCP server id inside the plugin (enable-server/disable-server).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'health') {
            const states = loadPluginStates(dataDir);
            return `Plugin health v19:\n${renderV19PluginHealth(v19PluginHealth(Object.values(states)))}`;
          }
          if (action === 'template') {
            const category = getStringArg(args, 'category', true);
            const name = getStringArg(args, 'pluginName') || 'my-plugin';
            const manifest = v19PluginManifestTemplate(category, name);
            return v19ManifestToJson(manifest);
          }
          if (action === 'list') {
            const states = loadPluginStates(dataDir);
            const names = Object.keys(states).sort();
            if (names.length === 0) return 'Chưa cài plugin v19 nào (dùng action load với manifestJson mcp.json).';
            return names.map((name) => renderV19PluginState(states[name]!)).join('\n---\n');
          }
          if (action === 'load') {
            const raw = getStringArg(args, 'manifestJson', true);
            const manifest = v19ParseManifestJson(raw);
            const states = loadPluginStates(dataDir);
            if (states[manifest.name]) return errorResult(`Plugin "${manifest.name}" đã cài — unload trước khi load lại.`);
            const state = v19LoadPlugin(manifest, Date.now());
            states[manifest.name] = state;
            savePluginStates(dataDir, states);
            writeJsonFile(pluginManifestFile(dataDir, manifest.name), JSON.parse(v19ManifestToJson(manifest)) as unknown);
            const validation = v19ValidateManifest(manifest);
            const warnings = validation.warnings.length > 0 ? `\nCảnh báo:\n- ${validation.warnings.join('\n- ')}` : '';
            return `Đã load plugin "${manifest.name}" v${manifest.version} (${manifest.servers.length} server, ${state.enabledServers.length} đang bật).${warnings}`;
          }
          const pluginName = getStringArg(args, 'pluginName', true);
          const states = loadPluginStates(dataDir);
          const state = states[pluginName];
          if (!state) return errorResult(`Chưa cài plugin "${pluginName}".`);
          if (action === 'get') {
            return renderV19PluginState(state);
          }
          if (action === 'unload') {
            states[pluginName] = v19UnloadPlugin(state);
            savePluginStates(dataDir, states);
            return `Đã unload plugin "${pluginName}" (manifest + config vẫn giữ, load lại khi cần).`;
          }
          if (action === 'enable-server' || action === 'disable-server') {
            const serverId = getStringArg(args, 'serverId', true);
            states[pluginName] = v19SetServerEnabled(state, serverId, action === 'enable-server');
            savePluginStates(dataDir, states);
            return `Đã ${action === 'enable-server' ? 'bật' : 'tắt'} server "${serverId}" của plugin "${pluginName}" (đang bật: ${states[pluginName]!.enabledServers.join(', ') || '(không có)'}).`;
          }
          return errorResult(`Unknown action "${action}" (load | unload | list | get | enable-server | disable-server | health | template).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_plugin_config',
        'View, validate and edit a coding v19 plugin executable config: the new config is validated against the plugin configSchema BEFORE it is applied (a failed validation leaves the old config untouched). Secrets are never shown in full.',
        {
          action: { type: 'string', description: 'Action: get | set | validate.' },
          pluginName: { type: 'string', description: 'Plugin name.' },
          configJson: { type: 'string', description: 'JSON object with the new config values (set/validate).' },
          replace: { type: 'boolean', description: 'true = replace the whole config; false = merge keys (default false).' },
          enabledServersJson: { type: 'string', description: 'JSON array of server ids to enable (optional, set).' },
        },
        ['action', 'pluginName'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const pluginName = getStringArg(args, 'pluginName', true);
          const dataDir = resolveDataDir(ctx);
          const states = loadPluginStates(dataDir);
          const state = states[pluginName];
          if (!state) return errorResult(`Chưa cài plugin "${pluginName}".`);
          if (action === 'get') {
            return (
              `Plugin "${pluginName}" config v${state.configVersion} (secret đã che):\n` +
              `${JSON.stringify(v19RedactedConfig(state.appliedConfig), null, 2)}\n` +
              `Server đang bật: ${state.enabledServers.join(', ') || '(không có)'}.\n` +
              (state.manifest.configSchema
                ? `Schema: ${JSON.stringify(state.manifest.configSchema, null, 2)}`
                : '(plugin không khai configSchema)')
            );
          }
          const configRaw = getStringArg(args, 'configJson', true);
          const config = parseJsonObjectArg(configRaw, 'configJson');
          const replace = getBoolArg(args, 'replace') ?? false;
          const enabledRaw = getStringArg(args, 'enabledServersJson');
          let enabledServers: string[] | undefined;
          if (enabledRaw.trim() !== '') {
            const parsed: unknown = JSON.parse(enabledRaw);
            if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
              return errorResult('enabledServersJson phải là JSON array string.');
            }
            enabledServers = parsed as string[];
          }
          if (action === 'validate') {
            const next = replace ? config : { ...state.appliedConfig, ...config };
            const errors = state.manifest.configSchema
              ? v19ValidateConfigAgainstSchema(next, state.manifest.configSchema)
              : [];
            if (enabledServers !== undefined) {
              const unknown = enabledServers.filter((id) => !state.manifest.servers.some((s) => s.id === id));
              if (unknown.length > 0) errors.push(`Không có server: ${unknown.join(', ')}.`);
            }
            if (errors.length > 0) return `Config KHÔNG hợp lệ:\n- ${errors.join('\n- ')}`;
            return `Config hợp lệ (sẽ áp lên v${state.configVersion + 1} khi dùng action set).`;
          }
          if (action === 'set') {
            const { state: nextState, result } = v19ApplyPluginConfig(state, {
              pluginName,
              config,
              replace,
              ...(enabledServers !== undefined ? { enabledServers } : {}),
            });
            if (!result.applied) {
              return `Không áp được config:\n- ${result.errors.join('\n- ')}\nConfig cũ (v${state.configVersion}) vẫn giữ nguyên.`;
            }
            states[pluginName] = nextState;
            savePluginStates(dataDir, states);
            return `Đã áp config v${result.configVersion} cho plugin "${pluginName}" (secret đã che): ${JSON.stringify(v19RedactedConfig(result.appliedConfig))}. Server đang bật: ${result.enabledServers.join(', ') || '(không có)'}.`;
          }
          return errorResult(`Unknown action "${action}" (get | set | validate).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_presets',
        'Manage coding v19 agent profile presets (system prompt + plugin set + tool allowlist): list builtin + custom presets, get one, create/update/delete/clone a custom preset, apply a preset (resolved snapshot for a new conversation), usage stats, export/import preset JSON.',
        {
          action: { type: 'string', description: 'Action: list | get | create | update | delete | clone | apply.' },
          presetId: { type: 'string', description: 'Preset id (get/update/delete/clone/apply).' },
          presetJson: { type: 'string', description: 'JSON preset {name, description?, systemPrompt, pluginIds?, toolAllowlist?, maxSteps?} (create/update).' },
          newPresetId: { type: 'string', description: 'Id for the cloned preset (clone).' },
          newName: { type: 'string', description: 'Name for the cloned preset (clone).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          const custom = loadCustomPresets(dataDir);
          if (action === 'list') {
            return renderV19PresetList(v19AllPresets(custom));
          }
          if (action === 'usage') {
            const metas = listConversationIds(dataDir).map((id) => loadConversationMeta(dataDir, id));
            return `Preset usage v19:\n${renderV19PresetUsage(v19PresetUsage(metas))}`;
          }
          if (action === 'export') {
            const preset = v19FindPreset(custom, getStringArg(args, 'presetId', true));
            if (!preset) return errorResult(`Không có preset "${getStringArg(args, 'presetId')}".`);
            return v19PresetToJson(preset);
          }
          if (action === 'import') {
            const imported = v19PresetFromJson(getStringArg(args, 'presetJson', true));
            if (v19FindPreset(custom, imported.id)) {
              return errorResult(`Đã có preset "${imported.id}" — đổi id trong JSON trước khi import.`);
            }
            saveCustomPresets(dataDir, [...custom, imported]);
            return `Đã import preset "${imported.id}" — ${imported.name}.`;
          }
          if (action === 'create') {
            const input = parseJsonObjectArg(getStringArg(args, 'presetJson', true), 'presetJson');
            const created = v19CreatePreset(custom, input as unknown as Parameters<typeof v19CreatePreset>[1]);
            saveCustomPresets(dataDir, [...custom, created]);
            return `Đã tạo preset "${created.id}" — ${created.name}.\n${renderV19Preset(created)}`;
          }
          const presetId = getStringArg(args, 'presetId', true);
          if (action === 'get') {
            const preset = v19FindPreset(custom, presetId);
            if (!preset) return errorResult(`Không có preset "${presetId}".`);
            return renderV19Preset(preset);
          }
          if (action === 'apply') {
            const preset = v19FindPreset(custom, presetId);
            if (!preset) return errorResult(`Không có preset "${presetId}".`);
            const result = v19ApplyPreset(preset, installedPluginNames(dataDir));
            return renderV19PresetApplyResult(result);
          }
          if (action === 'update') {
            if (v19BuiltinPresetById(presetId)) {
              return errorResult(`Preset "${presetId}" là builtin — không sửa trực tiếp, hãy clone thành preset custom rồi sửa bản clone.`);
            }
            const input = parseJsonObjectArg(getStringArg(args, 'presetJson', true), 'presetJson');
            const errors = v19ValidatePresetInput({ id: presetId, ...(input as Record<string, unknown>) } as unknown as Parameters<typeof v19ValidatePresetInput>[0]);
            if (errors.length > 0) return errorResult(`Preset không hợp lệ:\n- ${errors.join('\n- ')}`);
            const updated = v19UpdatePreset(custom, presetId, input as unknown as Parameters<typeof v19UpdatePreset>[2]);
            saveCustomPresets(dataDir, updated);
            return `Đã cập nhật preset "${presetId}".\n${renderV19Preset(updated.find((p) => p.id === presetId)!)}`;
          }
          if (action === 'delete') {
            if (v19BuiltinPresetById(presetId)) {
              return errorResult(`Preset "${presetId}" là builtin — không xoá được.`);
            }
            const remaining = v19DeletePreset(custom, presetId);
            saveCustomPresets(dataDir, remaining);
            return `Đã xoá preset "${presetId}".`;
          }
          if (action === 'clone') {
            const newId = getStringArg(args, 'newPresetId', true);
            const newName = getStringArg(args, 'newName', true);
            const cloned = v19ClonePreset(v19AllPresets(custom), presetId, newId, newName);
            saveCustomPresets(dataDir, [...custom, cloned]);
            return `Đã clone preset "${presetId}" thành "${newId}" — ${newName}.`;
          }
          return errorResult(`Unknown action "${action}" (list | get | create | update | delete | clone | apply | usage | export | import).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_marketplace',
        'Browse the internal coding v19 plugin marketplace: list installed plugins plus the known catalog, or search by name/description/category/tool.',
        {
          action: { type: 'string', description: 'Action: list | search.' },
          query: { type: 'string', description: 'Search text (search; empty = list all).' },
          category: { type: 'string', description: 'Filter by category: filesystem | git | search | database | browser | testing | other.' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          const installed = Object.values(loadPluginStates(dataDir));
          const entries = v19MarketplaceList(installed, true);
          if (action === 'list') {
            return `Marketplace plugin v19 (${entries.length} mục):\n${renderV19Marketplace(entries)}`;
          }
          if (action === 'search') {
            const query = getStringArg(args, 'query');
            const category = getStringArg(args, 'category');
            const found = v19MarketplaceSearch(entries, query, category === '' ? undefined : category);
            return `Tìm thấy ${found.length} plugin cho "${query}"${category !== '' ? ` (nhóm ${category})` : ''}:\n${renderV19Marketplace(found)}`;
          }
          return errorResult(`Unknown action "${action}" (list | search).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v19_agent',
        'Run a scripted coding v19 agent session end-to-end on an event-backed conversation: applies the agent profile preset, appends events for each step, writes files only inside the conversation workspace, blocks tools outside the preset allowlist, and checkpoints the workspace at the end.',
        {
          task: { type: 'string', description: 'Task for the agent (becomes the first user message).' },
          stepsJson: { type: 'string', description: 'JSON array of steps {text, fileWrite?: {path, content, kind?, oldText?}, fileDelete?: string, toolCall?: {toolName, argsJson?, result?, ok?}, isTest?: boolean, done?: boolean}.' },
          conversationId: { type: 'string', description: 'Continue an existing conversation (optional; empty = create a new one).' },
          title: { type: 'string', description: 'Title for a new conversation.' },
          profileId: { type: 'string', description: 'Agent profile preset id for a new conversation (builtin: general | reviewer | refactorer | test-writer | docs, or a custom preset id).' },
        },
        ['task', 'stepsJson'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const task = getStringArg(args, 'task', true);
          const stepsRaw = getStringArg(args, 'stepsJson', true);
          let steps: unknown;
          try {
            steps = JSON.parse(stepsRaw);
          } catch {
            return errorResult('stepsJson phải là JSON array hợp lệ.');
          }
          if (!Array.isArray(steps)) return errorResult('stepsJson phải là JSON array.');
          const dataDir = resolveDataDir(ctx);
          const now = Date.now();
          const conversationId = getStringArg(args, 'conversationId');
          const profileId = getStringArg(args, 'profileId');
          if (conversationId !== '') {
            const meta = loadConversationMeta(dataDir, conversationId);
            const events = loadConversationEvents(dataDir, conversationId);
            const { report, events: nextEvents } = runV19Agent({
              task,
              steps: steps as Parameters<typeof runV19Agent>[0]['steps'],
              existingMeta: meta,
              existingEvents: events,
              dataDir,
              now,
            });
            saveConversationEvents(dataDir, meta.id, nextEvents);
            return `${renderV19AgentReport(report)}\nEvent log đã lưu (${nextEvents.length} event).`;
          }
          // Tạo mới: custom preset phải resolve trước (core agent chỉ biết builtin).
          const custom = loadCustomPresets(dataDir);
          const preset = profileId !== '' ? v19FindPreset(custom, profileId) : undefined;
          if (profileId !== '' && !preset) return errorResult(`Không có preset/profile "${profileId}".`);
          if (preset && !preset.builtin) {
            const resolvedPreset = v19ApplyPreset(preset, installedPluginNames(dataDir));
            const meta = v19CreateConversationMeta({ title: getStringArg(args, 'title'), profileId, now }, resolvedPreset);
            const openEvents = v19OpenConversationEvents(meta, now);
            const { report, events: nextEvents } = runV19Agent({
              task,
              steps: steps as Parameters<typeof runV19Agent>[0]['steps'],
              existingMeta: meta,
              existingEvents: openEvents,
              dataDir,
              now,
            });
            saveConversationMeta(dataDir, meta);
            saveConversationEvents(dataDir, meta.id, nextEvents);
            return `${renderV19AgentReport(report)}\nEvent log đã lưu (${nextEvents.length} event).`;
          }
          const { report, meta, events: nextEvents } = runV19Agent({
            task,
            steps: steps as Parameters<typeof runV19Agent>[0]['steps'],
            title: getStringArg(args, 'title'),
            profileId: profileId === '' ? undefined : profileId,
            installedPluginNames: installedPluginNames(dataDir),
            dataDir,
            now,
          });
          saveConversationMeta(dataDir, meta);
          saveConversationEvents(dataDir, meta.id, nextEvents);
          return `${renderV19AgentReport(report)}\nEvent log đã lưu (${nextEvents.length} event).`;
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
  ];
  return tools;
}

/** Placeholder tools (ALL_TOOLS) — host thay bằng bản bound khi có base dir. */
export const CODING_V19_TOOLS: Tool[] = createCodingV19Tools();

/** Đảm bảo base dir có thư mục dữ liệu v19 (dùng khi host bind). */
export function codingV19EnsureBaseDir(baseDir: string): string {
  return codingV19EnsureDataDir(baseDir);
}
