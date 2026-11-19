/**
 * Coding agent v19 (v1.41, Đội T4) — public exports.
 *
 * Học ý tưởng survey v141 §3 (OpenHands SDK v1.60 / Agent Canvas
 * v1.39), code gốc của open-bot: conversation event-backed (event log
 * append-only + hash-chain + replay), workspace tách bạch theo
 * conversation (path containment chặn traversal + symlink, snapshot/
 * checkpoint + rollback, diff viewer data), Agent Plugins `mcp.json`
 * (validate schema, load/unload, executable config validate-trước-khi-
 * áp, marketplace nội bộ), prompt/plugin preset theo agent profile
 * (5 preset builtin + custom, snapshot vào conversation khi tạo),
 * agent scripted end-to-end trên event log + workspace.
 *
 * Nối (không viết lại): coding agent v18 (critic/review skill/
 * dependency map/eval harness), v17 (trajectory log hash-chain,
 * repo map, Plan Mode, sandbox).
 */

export * from './types';
export {
  renderV19AgentReport,
  runV19Agent,
  v19ValidateAgentStep,
} from './agent';
export type { V19RunAgentOptions } from './agent';
export {
  renderV19ConversationState,
  renderV19Event,
  renderV19EventLog,
  v19AppendEvent,
  v19CompactEvents,
  v19CountEventsByKind,
  v19EventBySeq,
  v19EventFromJsonl,
  v19EventHash,
  v19EventId,
  v19EventToJsonl,
  v19EventsFromJsonl,
  v19EventsInRange,
  v19EventsToJsonl,
  v19HashText,
  v19IsValidEventLog,
  v19ReplayEvents,
  v19ValidateEvent,
  v19ValidateEventKind,
  v19ValidateEventPayload,
  v19VerifyEventChain,
} from './events';
export {
  renderV19ConversationSummary,
  v19ArchiveConversation,
  v19ChildConversations,
  v19ConversationMetaFromJson,
  v19ConversationMetaToJson,
  v19ConversationSummary,
  v19CreateConversationMeta,
  v19DefaultConversationTitle,
  v19EndConversationEvents,
  v19ForkConversation,
  v19ForkSeqFromEventId,
  v19NewConversationId,
  v19OpenConversationEvents,
  v19RenameConversation,
  v19SeqOfEventId,
  v19SetConversationStatus,
  v19SummarizeConversation,
  v19ValidateConversationId,
  v19ValidateConversationMeta,
} from './conversation';
export type { V19ConversationSummary } from './conversation';
export {
  renderV19PluginHealth,
  renderV19PresetUsage,
  renderV19WorkspaceSearch,
  v19ConversationBundleToJson,
  v19DiffSnapshots,
  v19ExportConversation,
  v19ImportConversationBundle,
  v19PluginHealth,
  v19PresetUsage,
  v19SearchEvents,
  v19SearchWorkspace,
} from './search';
export type {
  V19ConversationBundle,
  V19EventSearchQuery,
  V19PluginHealth,
  V19PresetUsage,
  V19WorkspaceSearchMatch,
  V19WorkspaceSearchResult,
} from './search';
export {
  V19_TOKEN_CHARS_PER_TOKEN,
  formatV19Bytes,
  formatV19Duration,
  renderV19ConversationStats,
  renderV19EventTimeline,
  renderV19WorkspaceStats,
  v19ConversationDigest,
  v19ConversationStats,
  v19EstimateTokens,
  v19EventTimeline,
  v19SnapshotStats,
  v19WorkspaceStats,
} from './stats';
export type {
  V19ConversationStats,
  V19EventTimelineBucket,
  V19ToolCallStats,
  V19WorkspaceStats,
} from './stats';
export type { V19WorkspaceTreeNode } from './workspace';
export {
  renderV19WorkspaceDiff,
  renderV19WorkspaceList,
  renderV19WorkspaceTree,
  v19CheckWorkspacePath,
  v19CreateSnapshot,
  v19DiffManifests,
  v19DiffSnapshotToWorkspace,
  v19EnsureWorkspace,
  v19LineDiff,
  v19ListSnapshots,
  v19LoadSnapshot,
  v19NormalizeRelPath,
  v19PruneSnapshots,
  v19ResolveWorkspacePath,
  v19RollbackSnapshot,
  v19SnapshotId,
  v19WorkspaceDelete,
  v19WorkspaceEdit,
  v19WorkspaceList,
  v19WorkspaceManifest,
  v19WorkspaceTree,
  v19WorkspaceRead,
  v19WorkspaceWrite,
} from './workspace';
export {
  V19_MCP_TRANSPORTS,
  V19_PLUGIN_CATALOG,
  V19_PLUGIN_CATEGORIES,
  V19_PLUGIN_NAME_RE,
  V19_PLUGIN_PERMISSIONS,
  V19_PLUGIN_VERSION_RE,
  renderV19Marketplace,
  renderV19PluginManifest,
  renderV19PluginState,
  v19ApplyPluginConfig,
  v19CloneJson,
  v19IsSecretKey,
  v19LoadPlugin,
  v19ManifestToJson,
  v19MarketplaceList,
  v19MarketplaceSearch,
  v19NormalizeManifest,
  v19ParseManifestJson,
  v19RedactSecret,
  v19RedactedConfig,
  v19SetServerEnabled,
  v19UnloadPlugin,
  v19ValidateConfigAgainstSchema,
  v19ValidateConfigField,
  v19PluginManifestTemplate,
  v19ValidateManifest,
  v19ValidateMcpServer,
} from './plugins';
export {
  V19_PRESET_DEFAULT_MAX_STEPS,
  V19_PRESET_ID_RE,
  V19_PRESET_MAX_STEPS_MAX,
  V19_PRESET_MAX_STEPS_MIN,
  renderV19Preset,
  renderV19PresetApplyResult,
  renderV19PresetList,
  v19AllPresets,
  v19ApplyPreset,
  v19BuiltinPresetById,
  v19BuiltinPresets,
  v19ClonePreset,
  v19CreatePreset,
  v19DeletePreset,
  v19FindPreset,
  v19IsToolAllowed,
  v19PresetFromJson,
  v19PresetToJson,
  v19PresetIdFromName,
  v19UpdatePreset,
  v19ValidatePresetInput,
} from './presets';
