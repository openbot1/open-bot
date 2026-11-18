/**
 * @open-bot/tools — sandboxed tools for the open-bot agent.
 *
 * `createDefaultTools()` returns the built-in tools (see `ALL_TOOLS` in
 * ./tools). The agent core
 * (package `@open-bot/core`) imports the `Tool` / `ToolContext` /
 * `ToolDefinition` types and calls `tool.execute(args, ctx)`, handling
 * user approval from each tool's `needsApproval` flag.
 */
export {
  createDefaultTools,
  ALL_TOOLS,
  formatSearchResults,
  parseDuckDuckGoResults,
  searchBing,
  searchWeb,
  unwrapBingRedirect,
} from './tools';
export {
  resolveWithin,
  runShell,
  assertCommandAllowed,
  createDenylistHook,
  DENYLIST_COMMANDS,
  DENYLIST_HOOK_NAME,
  MAX_OUTPUT_CHARS,
  DEFAULT_SHELL_TIMEOUT_MS,
} from './sandbox';
export type { RunShellOptions, RunShellResult } from './sandbox';
export { ToolRegistry } from './registry';
// v0.15: shellQuote dùng chung (gộp 4 bản copy ở tools/codeTools/webMedia/gitTools)
// và kill process group đa nền tảng (daemon.ts sẽ nối qua killProcessGroupOfChild).
export { shellQuote, resolveShellPlatform } from './shellQuote';
export type { ShellPlatform } from './shellQuote';
// --- v0.15: chặn SSRF cho các tool fetch URL (H3 audit) ---
export { assertPublicUrl, fetchPublic, isPrivateIp, MAX_SSRF_REDIRECTS } from './ssrf';
export type { SsrfCheckOptions } from './ssrf';
export {
  killProcessGroup,
  killProcessGroupOfChild,
  isProcessAlive,
  resolveKillPlatform,
} from './killProcessGroup';
export type { KillPlatform, KillProcessGroupOptions } from './killProcessGroup';
export { DaemonClient } from './daemon';
export type {
  ExecCallbacks,
  ExecRequest,
  ExecEvent,
  ExecResult,
  ExecInfo,
  ShellDaemon,
} from './daemon';
export { CODE_TOOLS } from './codeTools';
// --- v0.96 (Đội T2): repo map — PageRank trên đồ thị tham chiếu file ---
export {
  REPO_MAP_TOOLS,
  buildRepoMap,
  queryRepoMap,
  buildRepoMapSection,
  formatRepoMapSection,
  buildRepoGraph,
  personalizedPageRank,
  rankRepoFiles,
  fitRepoMapToBudget,
  renderRepoFile,
  renderRankedFiles,
  renderSymbolLine,
  discoverRepoFiles,
  parseRepoFile,
  extractImportSpecifiers,
  resolveRelativeImport,
  extractMentionedIdents,
  extractSymbolsRegexFallback,
  countIdents,
  identMultiplier,
  estimateRepoMapTokens,
  repoMapCacheStats,
  clearRepoMapCache,
  DEFAULT_REPO_MAP_TOKEN_BUDGET,
  NO_CHAT_FILES_BUDGET_MULTIPLIER,
  REPO_MAP_DAMPING,
  REPO_MAP_ITERATIONS,
  CHAT_PERSONALIZATION_MASS,
  CHAT_FILE_MULTIPLIER,
  MENTIONED_IDENT_MULTIPLIER,
  LONG_IDENT_MIN_LENGTH,
  LONG_IDENT_MULTIPLIER,
  PRIVATE_IDENT_MULTIPLIER,
  MAX_REPO_MAP_FILES,
  MAX_REPO_MAP_FILE_BYTES,
} from './repoMap';
export type {
  RepoMapSymbol,
  RepoMapFile,
  RepoMapEdge,
  RepoMapResult,
  BuildRepoMapOptions,
  RepoMapSectionOptions,
} from './repoMap';
// --- v0.86 (P2-4): tree-sitter AST symbols for code tools ---
export {
  parseCodeSymbols,
  detectAstLanguage,
  supportedAstLanguagesText,
  SUPPORTED_AST_LANGUAGES,
} from './code/ast';
export type { AstLanguage, AstSymbolKind, CodeSymbol, ParseCodeSymbolsResult } from './code/ast';
export { createPlanTools, PLAN_TOOLS } from './planTools';
export { createSubagentTools, SUBAGENT_TOOLS } from './subagentTools';
export type { SubagentToolOptions } from './subagentTools';
// v1.04 (Đội T4): delegation v2 — ủy quyền qua tool call, tracker + merge.
export {
  createDelegationTools,
  classifySubagentOutput,
  extractVerdictFromOutput,
  DELEGATION_TOOLS,
  DEFAULT_DELEGATION_TIMEOUT_MS,
} from './delegationTools';
export type { DelegationToolOptions } from './delegationTools';
export {
  createNestedSubagentTools,
  formatSubagentTree,
  NESTED_SUBAGENT_TOOLS,
} from './nestedSubagentTools';
export { createMcpTools, MCP_TOOLS } from './mcpTools';
export { createMcpV097Tools, MCP_V097_TOOLS } from './mcpV097Tools';
export { createMcpV2Tools, MCP_V2_TOOLS } from './mcpV2Tools';
export { createMcpV106Tools, MCP_V106_TOOLS } from './mcpV106Tools';
export { createMcpV110Tools, MCP_V110_TOOLS } from './mcpV110Tools';
export {
  addMcpAppListener,
  addMcpTaskListener,
  cancelMcpTask,
  getMcpTaskManager,
  listMcpTaskSnapshots,
  MCP_TASK_DEFAULT_TIMEOUT_MS,
} from './mcpTools';
export type { McpAppListener, McpTaskListener } from './mcpTools';
export { loadPlugin, validateManifest, readManifest } from './plugins/loader';
export type { LoadedPlugin } from './plugins/loader';
export { PluginManager, toolsFromPlugins, registerPluginTools } from './plugins/manager';
export type { PluginLoadFailure } from './plugins/manager';
// v0.89a (worker F1 — Marketplace v2): plugin marketplace (install from
// URL/git/local, secret scan, versions, sandboxed-by-default).
export {
  checkPluginUpdates,
  discardPreparedPlugin,
  downgradePlugin,
  getPluginDowngradeInfo,
  installPluginFromSource,
  installPreparedPlugin,
  listMarketplaceInstalledRecords,
  listMarketplacePlugins,
  loadMarketplacePluginSandboxed,
  preparePluginFromSource,
  scanDirForSecrets,
  searchMarketplacePlugins,
  uninstallMarketplacePlugin,
  updatePluginFromSource,
  validatePluginMarketplaceEntry,
  verifyInstalledPluginSignature,
  PLUGIN_DOWNLOAD_MAX_BYTES,
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  PLUGIN_MARKETPLACE_INSTALLED_FILE,
  PLUGIN_PREVIOUS_VERSIONS_DIR,
} from './plugins/marketplace';
export type {
  DowngradePluginResult,
  InstallPluginOptions,
  InstallPluginResult,
  InstalledPluginSignatureCheck,
  MarketplaceInstalledRecord,
  PluginDowngradeInfo,
  PluginMarketplaceEntry,
  PluginMarketplaceInfo,
  PluginMarketplaceSource,
  PluginMarketplaceSourceKind,
  PluginUpdateInfo,
  PreparedPlugin,
  PreparePluginOptions,
  SecretFinding,
} from './plugins/marketplace';
// v0.93a (worker A sóng v0.93): bundle signing (Ed25519) + trusted keys.
export {
  addTrustedMarketplaceKey,
  enforcePluginSignature,
  generateMarketplaceSigningKeyPair,
  hashPluginBundleFiles,
  listTrustedMarketplaceKeys,
  loadTrustedMarketplaceKeys,
  marketplaceKeyId,
  removeTrustedMarketplaceKey,
  signPluginBundle,
  verifyPluginBundleSignature,
  PLUGIN_SIGNATURE_FILE,
  PLUGIN_TRUSTED_KEYS_FILE,
} from './plugins/signing';
export type {
  EnforcePluginSignatureOptions,
  PluginBundleSignature,
  PluginSignatureStatus,
  PluginSignatureVerification,
  TrustedMarketplaceKey,
  TrustedMarketplaceKeys,
} from './plugins/signing';
export type {
  PluginInfo,
  PluginManifest,
  PluginModule,
  PluginPermission,
} from './plugins/types';
export { PluginLoadError, PLUGIN_PERMISSIONS } from './plugins/types';
export {
  PLUGIN_SDK_V4_MIN_SUPPORTED,
  PLUGIN_SDK_V4_VERSION,
  checkPluginSdkV4Capabilities,
  parsePluginSdkV4ManifestJson,
  pluginSdkV4ManifestToV3,
  pluginSdkV4NeedsShellApproval,
  summarizePluginSdkV4Sandbox,
} from './plugins/sdkV4';
export type {
  PluginSdkV4CapabilityReq,
  PluginSdkV4Dependency,
  PluginSdkV4Manifest,
  PluginSdkV4SandboxLimits,
  PluginSdkV4SandboxSummary,
} from './plugins/sdkV4';
export type { Tool, ToolContext, ToolDefinition } from '@open-bot/core';

export { createShellTools, defaultElevateRunner, SHELL_TOOLS } from './shellTools';
export type { ShellToolsOptions } from './shellTools';
export { createLocalTools, LOCAL_TOOLS } from './localTools';
export type { LocalToolsOptions } from './localTools';
export { createComputerUseTools, COMPUTER_USE_TOOLS } from './computerUse';
export type { ComputerUseOptions } from './computerUse';
// --- v0.86a (P1-3): Playwright browser automation (browser_navigate /
// browser_click / browser_type / browser_screenshot / browser_extract) ---
export {
  createBrowserTools,
  createBrowserSession,
  launchPlaywrightBrowser,
  validateNavigateUrl,
  BROWSER_TOOLS,
} from './browserAutomation';
export type {
  BrowserAutomationOptions,
  BrowserSession,
  BrowserDriver,
  BrowserPageDriver,
  BrowserLauncher,
} from './browserAutomation';
// --- v1.33 (Đội T4): browser driver v2 (a11y-tree snapshot + diff,
// egress gate, vision fallback, Playwright MCP server mode,
// WebVoyager-local eval) — 8 agent tool mới ---
export {
  createBrowserV2Tools,
  createBrowserV2ToolsSession,
  BROWSER_V2_TOOLS,
} from './browserV2Tools';
export type {
  BrowserV2ToolsOptions,
  BrowserV2ToolsSession,
} from './browserV2Tools';
export {
  BrowserV2Session,
  createBrowserV2Session,
  launchPlaywrightBrowserV2,
  BrowserEgressGate,
  SnapshotCache,
  VisionFallback,
  PlaywrightMcpServer,
  createPlaywrightMcpServer,
  PLAYWRIGHT_MCP_TOOLS,
  runWebVoyagerEval,
  renderWebVoyagerReport,
  WEBVOYAGER_TASKS,
  parseAriaSnapshot,
  serializeAriaSnapshot,
  diffSnapshots,
} from './browserV2/index';
export {
  createWebMediaTools,
  WEB_MEDIA_TOOLS,
  createCanvasTools,
  CANVAS_TOOLS,
  IMAGE_CAPABLE_PROVIDERS,
  DEFAULT_VIDEO_MODEL,
  createVideoGenerateTool,
  createVideoStatusTool,
  createVideoCancelTool,
} from './webMedia';
export type { ProviderMediaConfig, WebMediaToolOptions, XPost } from './webMedia';
// --- v0.87d: Gemini image generation (generateContent shape) ---
export {
  HttpGeminiImageProvider,
  geminiImageConfigForSize,
  parseGeminiImageResponse,
  extFromGeminiMimeType,
  GEMINI_DEFAULT_IMAGE_MODEL,
  GEMINI_IMAGE_MODELS,
} from './geminiImage';
export type {
  GeminiImageConfig,
  GeminiImageResult,
  GeminiImageGenerateInput,
  GeminiImageProvider,
} from './geminiImage';
// --- v0.86b (P1-5): async video jobs (video_generate / video_status / video_cancel) ---
export {
  VideoJobStore,
  HttpVideoProvider,
  driveVideoJob,
  finishVideoJob,
  formatVideoJob,
  isVideoJobTerminal,
  VIDEO_JOB_POLL_INTERVAL_MS,
  VIDEO_JOB_DEFAULT_TIMEOUT_MS,
  VIDEO_JOB_TERMINAL_STATUSES,
} from './videoJobs';
export type {
  VideoJob,
  VideoJobStatus,
  VideoJobCreateInput,
  VideoProvider,
  VideoGenerateRequest,
  VideoStartResult,
  VideoPollResult,
  VideoPollStatus,
  HttpVideoProviderConfig,
  DriveVideoJobOptions,
} from './videoJobs';
export { createAgentTools, AGENT_TOOLS } from './agentTools';
// --- v0.95d4: long-term memory tools (memory_save/search/list/delete) ---
export { createMemoryTools, MEMORY_TOOLS, publicMemoryEntry } from './memoryTools';
export type { MemoryToolOptions } from './memoryTools';
// --- v0.96 (Đội T1): memory block tools (memory_block_* + memory_consolidate) ---
export { createMemoryBlockTools, MEMORY_BLOCK_TOOLS } from './memoryBlockTools';
export type { MemoryBlockToolOptions } from './memoryBlockTools';
// --- v0.97 (Team T4): memory v2 tools (sleep agent + temporal graph + hybrid search + provenance) ---
export { createMemoryV2Tools, MEMORY_V2_TOOLS, MEMORY_V2_TOOL_NAMES } from './memoryV2Tools';
export type { MemoryV2ToolOptions } from './memoryV2Tools';
// --- v0.98 (Đội T1): memory graph tools (memory_graph_*) ---
export { createMemoryGraphTools, MEMORY_GRAPH_TOOLS, MEMORY_GRAPH_TOOL_NAMES } from './memoryGraphTools';
export type { MemoryGraphToolOptions } from './memoryGraphTools';
// --- v1.12 (Đội T3): temporal KG v2 tools (temporal_kg_*) ---
export {
  createMemoryTemporalV112Tools,
  TEMPORAL_KG_V112_TOOLS,
  TEMPORAL_KG_V112_TOOL_NAMES,
} from './memoryTemporalV112Tools';
export type { MemoryTemporalV112ToolOptions } from './memoryTemporalV112Tools';
// --- v1.01 (Đội T4): verbatim memory tools (verbatim_memory_*) ---
export {
  createVerbatimMemoryTools,
  VERBATIM_MEMORY_TOOLS,
  VERBATIM_MEMORY_TOOL_NAMES,
  isVerbatimMemoryToolName,
} from './verbatimMemoryTools';
export type { VerbatimMemoryToolOptions, VerbatimMemoryToolName } from './verbatimMemoryTools';
// --- v1.01 (Đội T5): evolving notes tools (notes_*) ---
export { createMemoryNotesTools, MEMORY_NOTES_TOOLS, MEMORY_NOTES_TOOL_NAMES } from './memoryNotesTools';
export type { MemoryNotesToolOptions } from './memoryNotesTools';
// --- v1.02 (Đội T2): memory v3 tools (fused search, one-pass ingest, temporal queries, sleep maintenance, blocks v2) ---
export { createMemoryV3Tools, MEMORY_V3_TOOLS, MEMORY_V3_TOOL_NAMES } from './memoryV3Tools';
export type { MemoryV3ToolOptions } from './memoryV3Tools';
// --- v1.03 (Đội T2): memory v4 tools (shared-block groups, judge pipeline, scored dream, validity windows, scoped recall) ---
export { createMemoryV4Tools, MEMORY_V4_TOOLS, MEMORY_V4_TOOL_NAMES } from './memoryV4Tools';
export type { MemoryV4ToolOptions } from './memoryV4Tools';
// --- v1.04 (Đội T1): memory v5 tools (ADD-only store, bi-temporal v2, ingestion, health, consolidation v2) ---
export { createMemoryV5Tools, MEMORY_V5_TOOLS, MEMORY_V5_TOOL_NAMES } from './memoryV5Tools';
export type { MemoryV5ToolOptions } from './memoryV5Tools';
// --- v1.05 (Đội T1): memory v6 tools (add-only record store, multi-scope, fused retrieval, shared blocks, sleep-time compute, migration) ---
export { createMemoryV6Tools, MEMORY_V6_TOOLS, MEMORY_V6_TOOL_NAMES } from './memoryV6Tools';
export type { MemoryV6ToolOptions } from './memoryV6Tools';
// --- v1.05 (Đội T5): voice realtime v4 tools (multi-session
// manager, latency report, barge-in test, internal eval, log) ---
export { createVoiceV4Tools, VOICE_V4_TOOLS, VOICE_V4_TOOL_NAMES, isVoiceV4ToolName } from './voiceV4Tools';
export type { VoiceV4ToolOptions, VoiceV4ManagerLike, VoiceV4SessionLike } from './voiceV4Tools';
// --- v1.05 (Đội T4): context v2 tools (tiered compaction, verified summaries, 1M window, per-bot policy, inspector, snapshots) ---
export { createContextV2Tools, CONTEXT_V2_TOOLS, CONTEXT_V2_TOOL_NAMES } from './contextV2Tools';
export type { ContextV2ToolOptions } from './contextV2Tools';
// --- v1.06 (Đội T1): memory v7 tools (git-backed blocks, 4-tier promote/demote, prompt recompile, history, episodic search, tiers status) ---
export { createMemoryV7Tools, MEMORY_V7_TOOLS, MEMORY_V7_TOOL_NAMES, importV96BlocksIntoV7 } from './memoryV7Tools';
export type { MemoryV7ToolOptions } from './memoryV7Tools';
// --- v1.07 (Đội T1): memory v8 tools (sleep policy + nén block, fused retrieval local, provenance, review chống poisoning, fleet sync, xóa GDPR) ---
export { createMemoryV8Tools, MEMORY_V8_TOOLS, MEMORY_V8_TOOL_NAMES } from './memoryV8Tools';
export type { MemoryV8ToolOptions } from './memoryV8Tools';
// --- v1.08 (Đội T1): memory v9 tools (sleep daemon nền tự động, git-backed versioning snapshot/diff/rollback, shared-block registry ACL/change feed/xung đột) ---
export { createMemoryV9Tools, MEMORY_V9_TOOLS, MEMORY_V9_TOOL_NAMES, getMemoryV9Agent, resetMemoryV9AgentsForTests } from './memoryV9Tools';
export type { MemoryV9ToolOptions } from './memoryV9Tools';
// --- v1.09 (Đội T2): memory v9 kiểu Letta tools (core memory tự sửa qua tool, recall, archival, entity bền vững, sleep pass/proposals) ---
export { createMemoryV9LettaTools, MEMORY_V9_LETTA_TOOLS, MEMORY_V9_LETTA_TOOL_NAMES } from './memoryV9LettaTools';
// --- v1.10 (Đội T1): memory v10 tools (Mem0 pipeline, fused 3-signal retrieval, bi-temporal timeline, versioned blocks, quarantine review) ---
export { createMemoryV10Tools, MEMORY_V10_TOOLS, MEMORY_V10_TOOL_NAMES, getMemoryV10Manager, resetMemoryV10ManagersForTests, memoryV10Dir } from './memoryV10Tools';
export type { MemoryV10ToolOptions } from './memoryV10Tools';
// --- v1.12 (Doi T1): memory v12 tools (exact-string edit, token budget, compile <memory_blocks>, system blocks, audit, sleep janitor) ---
export { createMemoryV12Tools, MEMORY_V12_TOOLS, MEMORY_V12_TOOL_NAMES, readV12JanitorLogForTool } from './memoryV12Tools';
export type { MemoryV12ToolOptions } from './memoryV12Tools';
// --- v1.15 (Doi T1): memory v14 tools (extract rule+mock LLM, fused search, state-at, quarantine, GDPR erase, eval 24 case) ---
export { createMemoryV14Tools, MEMORY_V14_TOOLS, MEMORY_V14_TOOL_NAMES } from './memoryV14Tools';
export type { MemoryV14ToolOptions } from './memoryV14Tools';
// --- v1.16 (Doi T1): memory v15 tools (consolidate Mem0-v3 add-only, hybrid search 4 tin hieu, state-at, time-travel, block edit, block list, sleep reorganize, eval 40 case) ---
export { createMemoryV15Tools, MEMORY_V15_TOOLS, MEMORY_V15_TOOL_NAMES } from './memoryV15Tools';
export type { MemoryV15ToolOptions } from './memoryV15Tools';
// --- v1.35 (Doi T1): memory v16 tools (core_memory_replace exact-match, block edit/list/pin, sleep consolidate + reorganize, extract/fuse da scope, validity set/query, archival recall/promote, eval 40 case) ---
export { createMemoryV16Tools, MEMORY_V16_TOOLS, MEMORY_V16_TOOL_NAMES } from './memoryV16Tools';
export type { MemoryV16ToolOptions } from './memoryV16Tools';
// --- v1.18 (Doi T1): memory v17 tools (block lifecycle v2, sleep scheduler v2, archival scoring promote/demote, block versioning + audit git-backed, admission pipeline guard v2, eval 25 case) ---
export { createMemoryV17Tools, MEMORY_V17_TOOLS, MEMORY_V17_TOOL_NAMES } from './memoryV17Tools';
export type { MemoryV17ToolOptions } from './memoryV17Tools';
// --- v1.36 (Doi T1): memory v17 mem0-style tools (add-only extract, entity linking, conflict resolver, fusion search, bi-temporal, scope audit, eval 40 case) ---
export { createMemoryV17Mem0Tools, MEMORY_V17_MEM0_TOOLS, MEMORY_V17_MEM0_TOOL_NAMES } from './memoryV17Mem0Tools';
export type { MemoryV17Mem0ToolOptions } from './memoryV17Mem0Tools';
// --- v1.19 (Doi T1-TEST): memory v18 tools (extract v2, hybrid retrieval, block guardrail v3, bi-temporal, poisoning screen v3, GDPR erase, sleep consolidation v2, LOCOMO eval) ---
export { createMemoryV18Tools, MEMORY_V18_TOOLS, MEMORY_V18_TOOL_NAMES } from './memoryV18Tools';
export type { MemoryV18ToolOptions } from './memoryV18Tools';
// --- v1.29 (Doi T1): memory v21 tools (portable memory OKF/MemFS/OpenHands: export/import/convert/validate/sync/tombstone/version/sleep/record/bundle-info) ---
export { createMemoryV21Tools, MEMORY_V21_TOOLS, MEMORY_V21_TOOL_NAMES } from './memoryV21Tools';
export type { MemoryV21ToolOptions } from './memoryV21Tools';
export type { MemoryV9LettaToolOptions } from './memoryV9LettaTools';
// --- v1.08 (Đội T2): coding agent v2 tools (repo map PageRank symbol-level, architect mode planner/editor, git-first commit/diff/revert/squash) ---
export { createCodingV2Tools, CODING_V2_TOOLS, CODING_V2_TOOL_NAMES, isCodingV2ToolName } from './codingV2Tools';
export type { CodingV2ToolOptions, CodingV2ToolName } from './codingV2Tools';
export { CodingV2RepoMapStore, parseCodingV2File, scanCodingV2Idents, resolveCodingV2CachePath, CODING_V2_DEFAULT_CACHE_REL_PATH, CODING_V2_MAX_FILES } from './codingV2RepoMap';
export type { CodingV2MapBuildOptions, CodingV2MapBuildResult } from './codingV2RepoMap';
// --- v1.10 (Đội T4): coding agent v3 tools (repo map call edges + module graph + token-budget map, manager/explorer/worker, eval harness Terminal-Bench, router model local) ---
export { createCodingV3Tools, CODING_V3_TOOLS, CODING_V3_TOOL_NAMES, isCodingV3ToolName } from './codingV3Tools';
export type { CodingV3ToolOptions, CodingV3ToolName } from './codingV3Tools';
export { CodingV3RepoMapStore, resolveCodingV3CachePath, CODING_V3_DEFAULT_CACHE_REL_PATH } from './codingV3RepoMap';
export type { CodingV3MapBuildResult } from './codingV3RepoMap';
// --- v1.11 (Đội T4): coding agent v4 tools (repo map PageRank v2, sub-agent task visualizer, ACP-style model switching, coding profiles) ---
export { createCodingV4Tools, CODING_V4_TOOLS, CODING_V4_TOOL_NAMES, isCodingV4ToolName } from './codingV4Tools';
export type { CodingV4ToolOptions, CodingV4ToolName } from './codingV4Tools';
export { CodingV4RepoMapStore, resolveCodingV4CachePath, scanCodingV4Fingerprints, CODING_V4_DEFAULT_CACHE_REL_PATH, CODING_V4_MAX_SCAN_FILES } from './codingV4RepoMap';
export type { CodingV4MapBuildResult } from './codingV4RepoMap';
// --- v1.13 (Đội T3): repo map v5 tools (symbol topology, hierarchical
// summaries, incremental index v5, code graph search, jump-to-definition) ---
// NOTE: ten export REPOMAP_V5_* (doi ten tu CODING_V5_* luc gop) de tranh
// xung dot voi coding agent v5 (Doi T4) cung dung tien to CODING_V5_*.
export { createRepomapV5Tools, REPOMAP_V5_TOOLS, REPOMAP_V5_TOOL_NAMES, isRepomapV5ToolName } from './repoMapV5Tools';
export type { RepomapV5ToolOptions, RepomapV5ToolName } from './repoMapV5Tools';
export { CodingV5RepoMapStore, resolveCodingV5CachePath, readCodingV5Sources, CODING_V5_DEFAULT_CACHE_REL_PATH, CODING_V5_MAX_SOURCE_FILES } from './codingV5RepoMap';
export type { CodingV5MapBuildResult } from './codingV5RepoMap';
// --- v1.13 (Đội T4): coding agent v5 tools (patch preview + duyet tung hunk,
// auto-commit message, /add chon loc theo repo map v4, eval kieu SWE-bench,
// rollback theo commit + lich su patch). NOTE: KHONG gop vao ALL_TOOLS o day —
// coordinator noi registry trung tam sau (quy tac song v1.13) ---
export { createCodingV5Tools, CODING_V5_TOOLS, CODING_V5_TOOL_NAMES, isCodingV5ToolName } from './codingV5Tools';
export type { CodingV5ToolOptions, CodingV5ToolName } from './codingV5Tools';
// --- v1.14 (Đội T3): coding agent v6 tools (event-sourced log +
// CodeAct-lite v2 + security gate + condenser v2 + stuck + delegate +
// RouterLLM) ---
export { createCodingV6Tools, CODING_V6_TOOLS, CODING_V6_TOOL_NAMES, isCodingV6ToolName, codingV6DataDir } from './codingV6Tools';
export type { CodingV6ToolOptions, CodingV6ToolName } from './codingV6Tools';
// --- v1.15 (Đội T4): coding agent v7 tools (stateless agent + event
// log replay/fork/pause/resume + CodeAct-lite v3 + security 3 mức +
// condenser v3 + Skills + eval) ---
export { createCodingV7Tools, CODING_V7_TOOLS, CODING_V7_TOOL_NAMES, isCodingV7ToolName, codingV7DataDir } from './codingV7Tools';
export type { CodingV7ToolOptions, CodingV7ToolName } from './codingV7Tools';
// --- v1.17 (Đội T4): coding agent v9 tools (AST-aware edit +
// sandbox loop + atomic commit + draft-PR + eval + agent) ---
export { createCodingV9Tools, CODING_V9_TOOLS, CODING_V9_TOOL_NAMES, isCodingV9ToolName, codingV9DataDir, codingV9EnsureDataDir } from './codingV9Tools';
export type { CodingV9ToolOptions, CodingV9ToolName } from './codingV9Tools';
// --- v1.18 (Đội T2): coding agent v10 tools (event-sourced session +
// CodeAct execution + repo map hierarchical summaries + edit
// strategies + versioned eval + agent) ---
export { createCodingV10Tools, CODING_V10_TOOLS, CODING_V10_TOOL_NAMES, isCodingV10ToolName, codingV10DataDir, codingV10SessionsDir, codingV10EvalDir, codingV10EnsureDataDir } from './codingV10Tools';
export type { CodingV10ToolOptions, CodingV10ToolName } from './codingV10Tools';
// --- v1.29 (Đội T3): coding agent v14 tools (incremental condenser +
// stuck detection v2 + recovery + reasoning-block persistence + agent/resume) ---
export { createCodingV14Tools, CODING_V14_TOOLS, CODING_V14_TOOL_NAMES, isCodingV14ToolName, codingV14DataDir, codingV14RunLogsDir, codingV14ReasoningDir, codingV14EnsureDataDir, codingV14EnsureBaseDir } from './codingV14Tools';
export type { CodingV14ToolOptions, CodingV14ToolName } from './codingV14Tools';
// --- v1.06 (Đội T4): voice realtime v5 tools (multi-model router,
// adaptive VAD config, diarized speakers + transcript, sessions) ---
export { createVoiceV5Tools, VOICE_V5_TOOLS, VOICE_V5_TOOL_NAMES, isVoiceV5ToolName } from './voiceV5Tools';
export type { VoiceV5ToolOptions, VoiceV5ManagerLike, VoiceV5SessionLike } from './voiceV5Tools';
// --- v1.07 (Đội T5): voice realtime v6 tools (explicit call state,
// mid-call voice switching, network guard, reconnect, stats) ---
export { createVoiceV6Tools, VOICE_V6_TOOLS, VOICE_V6_TOOL_NAMES, isVoiceV6ToolName } from './voiceV6Tools';
export type { VoiceV6ToolOptions, VoiceV6ManagerLike, VoiceV6SessionLike } from './voiceV6Tools';
// --- v1.08 (Đội T5): voice realtime v7 tools (sessions, streaming
// transcript, VAD config/status, barge-in, scripted mock turns) ---
export { createVoiceV7Tools, VOICE_V7_TOOLS, VOICE_V7_TOOL_NAMES, isVoiceV7ToolName } from './voiceV7Tools';
export type { VoiceV7ToolOptions, VoiceV7ManagerLike, VoiceV7SessionLike } from './voiceV7Tools';
// --- v1.09 (Đội T5): voice realtime v8 tools (spectral VAD, AEC
// barge-in, durable resume, push-to-talk, scripted mock turns) ---
export { createVoiceV8Tools, VOICE_V8_TOOLS, VOICE_V8_TOOL_NAMES, isVoiceV8ToolName } from './voiceV8Tools';
export type { VoiceV8ToolOptions, VoiceV8ManagerLike, VoiceV8SessionLike } from './voiceV8Tools';
// --- v1.10 (Đội T5): voice realtime v9 tools (VAD mock, barge-in,
// streaming transcript, tool calls mid-speech, PTT, live-key probe) ---
export { createVoiceV9Tools, VOICE_V9_TOOLS, VOICE_V9_TOOL_NAMES, isVoiceV9ToolName } from './voiceV9Tools';
export type { VoiceV9ToolOptions, VoiceV9ManagerLike, VoiceV9SessionLike } from './voiceV9Tools';
// --- v1.11 (Đội T5): voice realtime v10 tools (realtime v2 + fallback,
// VAD v10, noise suppression, bot voice presets, AG-UI voice v3) ---
export { createVoiceV10Tools, VOICE_V10_TOOLS, VOICE_V10_TOOL_NAMES, isVoiceV10ToolName } from './voiceV10Tools';
export type { VoiceV10ToolOptions, VoiceV10ManagerLike, VoiceV10SessionLike, VoiceV10PresetStoreLike } from './voiceV10Tools';
export { createVoiceV11Tools, VOICE_V11_TOOLS, VOICE_V11_TOOL_NAMES, isVoiceV11ToolName } from './voiceV11Tools';
export type { VoiceV11ToolOptions, VoiceV11ManagerLike, VoiceV11SessionLike } from './voiceV11Tools';
export { createVoiceV12Tools, VOICE_V12_TOOLS, VOICE_V12_TOOL_NAMES, isVoiceV12ToolName } from './voiceV12Tools';
export type { VoiceV12ToolOptions, VoiceV12ManagerLike, VoiceV12SessionLike } from './voiceV12Tools';
export { createVoiceV13Tools, VOICE_V13_TOOLS, VOICE_V13_TOOL_NAMES, isVoiceV13ToolName } from './voiceV13Tools';
export type { VoiceV13ToolOptions, VoiceV13ManagerLike, VoiceV13SessionLike } from './voiceV13Tools';
// --- v1.15 (Đội T5): voice realtime v14 — latency budget v2 +
// providers v2 + Smart Turn v2 + wake word v2 + barge-in v2 (9 tools) ---
export { createVoiceV14Tools, VOICE_V14_TOOLS, VOICE_V14_TOOL_NAMES, isVoiceV14ToolName } from './voiceV14Tools';
export type { VoiceV14ToolOptions, VoiceV14ManagerLike, VoiceV14SessionLike } from './voiceV14Tools';
export { createVoiceV15Tools, VOICE_V15_TOOLS, VOICE_V15_TOOL_NAMES, isVoiceV15ToolName } from './voiceV15Tools';
export type { VoiceV15ToolOptions } from './voiceV15Tools';
export { createVoiceV16Tools, VOICE_V16_TOOLS, VOICE_V16_TOOL_NAMES, isVoiceV16ToolName } from './voiceV16Tools';
export type { VoiceV16ToolOptions } from './voiceV16Tools';
// --- v1.18 (Đội T5): voice v17 realtime — VAD v5 + barge-in v5 +
// TTS streaming v3 + turn-taking v5 + multi-voice profiles v2 ---
export { createVoiceV17Tools, VOICE_V17_TOOLS, VOICE_V17_TOOL_NAMES, isVoiceV17ToolName } from './voiceV17Tools';
export type { VoiceV17ToolOptions } from './voiceV17Tools';
// --- v1.19 (Đội T5): voice v18 realtime — VAD v6 adaptive +
// noise chain, barge-in v6, TTS streaming v4, profiles v3,
// realtime v3 + recovery, eval v18 (13 tools) ---
export { createVoiceV18Tools, VOICE_V18_TOOLS, VOICE_V18_TOOL_NAMES, isVoiceV18ToolName } from './voiceV18Tools';
export type { VoiceV18ToolOptions } from './voiceV18Tools';
// --- v1.27 (Đội T5): voice v19 realtime — session manager v19,
// prosody control, eval v19, open-turn resume (13 tools) ---
// Ported into v1.29 from merge/v128; wired into ALL_TOOLS here
// (v128 exported it but never spread it).
export { createVoiceV19Tools, VOICE_V19_TOOLS, VOICE_V19_TOOL_NAMES, isVoiceV19ToolName } from './voiceV19Tools';
export type { VoiceV19ToolOptions } from './voiceV19Tools';
// --- v1.29 (Đội T5): voice v20 extensions — session persistence,
// resume v2, open-turn v8, transcript accuracy, extended eval (8 tools) ---
export { createVoiceV20Tools, VOICE_V20_TOOLS, VOICE_V20_TOOL_NAMES, isVoiceV20ToolName } from './voiceV20Tools';
export type { VoiceV20ToolOptions } from './voiceV20Tools';
// --- v1.10 (Đội T5): AG-UI generative UI v2 tools (suggest, validate,
// request, answer, pending, capabilities) ---
export { createAguiV2Tools, AGUI_V2_TOOLS, AGUI_V2_TOOL_NAMES, isAguiV2ToolName, AGUI_V2_DEFAULT_CAPABILITIES } from './aguiV2Tools';
export type { AguiV2ToolOptions } from './aguiV2Tools';
// --- v1.10 (Đội T5): agent teams dashboard tools (summary, list,
// team, tasks, mailbox — read-only, mock provider until T3 wires in) ---
export { createTeamsDashboardTools, TEAMS_DASHBOARD_TOOLS, TEAMS_DASHBOARD_TOOL_NAMES, isTeamsDashboardToolName } from './teamsDashboardTools';
export type { TeamsDashboardToolOptions } from './teamsDashboardTools';
// --- v1.15 (T2): protocol triad tools (AG-UI emit/catalog,
// interrupt raise/resolve, A2UI render/answer, A2A card/negotiate,
// MCP discover) ---
export { createProtocolV115Tools, PROTOCOL_V115_TOOLS, PROTOCOL_V115_TOOL_NAMES, isProtocolV115ToolName } from './protocolV115Tools';
export type { ProtocolV115ToolOptions } from './protocolV115Tools';
// --- v1.19 (T3): protocols v3 tools (negotiate, stateless request,
// migration advisor, deprecation gate, MRTR answer validation, A2A
// frame validation, AG-UI event, A2UI v3 render, Skills catalog,
// MCP Apps v3 lifecycle + permissions) ---
export { createProtocolV3Tools, PROTOCOL_V3_TOOLS, PROTOCOL_V3_TOOL_NAMES, isProtocolV3ToolName } from './protocolV3Tools';
export type { ProtocolV3ToolName, ProtocolV3ToolOptions } from './protocolV3Tools';
// --- v1.29 (T2): protocols v5 tools (negotiate, background MCP tasks,
// per-tool permission_policy, OAuth elicitation/reconnect, ACP v2
// discover + sessions) ---
export { createProtocolV5Tools, PROTOCOL_V5_TOOLS, PROTOCOL_V5_TOOL_NAMES, isProtocolV5ToolName } from './protocolV5Tools';
export type { ProtocolV5ToolName, ProtocolV5ToolOptions } from './protocolV5Tools';
export { createSessionHandoffTools, SESSION_HANDOFF_TOOLS, SESSION_HANDOFF_TOOL_NAMES } from './handoffTools';
export type { SessionHandoffToolOptions } from './handoffTools';
export { createA2aTools, A2A_TOOLS } from './a2aTools';
export type { A2aToolOptions, TrustedA2aAgent, TrustedA2aAgentStore } from './a2aTools';
export type { AgentBotConfig, AgentToolOptions, CreatedAgentInfo } from './agentTools';
export { createGitTools, GIT_TOOLS } from './gitTools';
export type { GitToolOptions } from './gitTools';
// --- v0.97 (Team T6): local git workflow (log / branch / show / blame)
export {
  createGitWorkflowTools, GIT_WORKFLOW_TOOLS, GIT_WORKFLOW_TOOL_NAMES,
  validateBranchName, validateGitRef, isGitRepo,
  GIT_WORKFLOW_MAX_CHARS, GIT_LOG_MAX_LIMIT,
} from './gitWorkflowTools';
// --- v0.97 (Team T6): deep file search (globs, context, time budget) ---
export {
  createFileSearchTools, FILE_SEARCH_TOOLS, FILE_SEARCH_TOOL_NAMES,
  searchFilesDeep, globToRegExp, matchesGlob, parseGitignore, isGitignored,
  FILE_SEARCH_MAX_BYTES, FILE_SEARCH_SKIP_DIRS,
  FILE_SEARCH_DEFAULT_MAX_RESULTS, FILE_SEARCH_MAX_RESULTS_CAP,
  FILE_SEARCH_DEFAULT_MAX_FILES, FILE_SEARCH_MAX_FILES_CAP,
  FILE_SEARCH_DEFAULT_TIMEOUT_MS, FILE_SEARCH_MAX_TIMEOUT_MS,
  FILE_SEARCH_MAX_CONTEXT_LINES,
} from './fileSearchTools';
export type {
  SearchMatch, SearchFilesDeepResult, SearchFilesDeepOptions, GitignoreRule,
} from './fileSearchTools';
export { gitLogTool, GIT_LOG_TOOLS, parseGitLogOutput, formatGitLogCommits } from './gitLog';
export { createCiTools, CI_TOOLS } from './ciTools';
export type { CiToolOptions } from './ciTools';
export { createHarnessV2Tools, HARNESS_V2_TOOLS } from './harnessV2Tools';
export type { HarnessV2ToolOptions } from './harnessV2Tools';
export {
  HARNESS_V103_TOOL_NAMES,
  HARNESS_V103_TOOLS,
  createHarnessV103Tools,
  executeCodeAct,
  foldRunLog,
} from './harnessV103Tools';
export type { CodeActObservation, HarnessV103ToolOptions } from './harnessV103Tools';
export {
  HARNESS_V107_TOOL_NAMES,
  HARNESS_V107_TOOLS,
  createHarnessV107Tools,
} from './harnessV107Tools';
export type { HarnessV107ToolOptions } from './harnessV107Tools';
export {
  HARNESS_V4_TOOL_NAMES,
  HARNESS_V4_TOOLS,
  createHarnessV4Tools,
} from './harnessV4Tools';
export type { HarnessV4ToolOptions } from './harnessV4Tools';
export { createAcpHostingTools, ACP_HOSTING_TOOLS } from './acpHostingTools';
export type { AcpHostingToolOptions } from './acpHostingTools';
// v1.12 (Team T4): ACP Control Center tools (discover/list/register/start/stop/set_budget/usage).
export { createAcpControlTools, ACP_CONTROL_TOOLS } from './acpControlTools';
export type { AcpControlToolOptions } from './acpControlTools';
export { createAgentDataTools, AGENT_DATA_TOOLS } from './agentDataTools';
export type { AgentDataToolOptions } from './agentDataTools';
// --- v0.53 (P1-7): tool-call replay history + computer-local bridge ---
export {
  ToolCallHistoryStore,
  MAX_TOOL_CALL_RECORDS,
  TOOL_CALL_HISTORY_FILE,
} from './toolCallHistory';
export type { ToolCallRecord, ToolCallRecordStatus, ToolCallHistoryLike } from './toolCallHistory';
export { createLocalBridgeTools, LOCAL_BRIDGE_TOOLS, MAX_IMAGE_UPLOADS, MAX_LOCAL_BRIDGE_RESULT_CHARS } from './localBridge';
export type {
  LocalBridgeOptions,
  LocalBridgeHandler,
  LocalBridgeHandlerContext,
  LocalBridgeHandlerResult,
  ImageUploadInfo,
} from './localBridge';
// --- v0.59: phone bridge — real pairing state + routing over a replaceable transport ---
export {
  PhoneBridge,
  NoPhoneTransport,
  SocketPhoneTransport,
  createPhoneBridge,
  createPhoneToolHandlers,
} from './phoneBridge';
export type { PhonePairingStatus, PhoneTransport, SocketPhoneTransportOptions } from './phoneBridge';
export {
  PHONE_TOOL_ALLOWLIST,
  PHONE_TOOL_IDS,
  PHONE_ONLY_TOOL_IDS,
  isPhoneToolAllowed,
  isPhoneOnlyTool,
  phoneToolScope,
  assertPhoneToolAllowed,
} from './daemon/phoneTools';
export type { PhoneToolAllowlistEntry } from './daemon/phoneTools';
// --- v0.41 (P0-3): access management (manage_access) + tool-result blob store ---
export { createAccessTools, ACCESS_TOOLS } from './accessTools';
export type { AccessToolOptions } from './accessTools';
export {
  createToolBlobTools,
  fetchToolResultBlob,
  storeToolResultBlob,
  truncateWithBlob,
  TOOL_BLOB_TOOLS,
  BLOB_PREVIEW_CHARS,
  DEFAULT_BLOB_FETCH_CHARS,
  MAX_BLOB_BYTES,
  MAX_BLOB_FETCH_CHARS,
  MAX_BLOBS_PER_WORKSPACE,
} from './blobStore';
// --- v0.41 follow-up: shared truncation helper (dedup 14 ban truncate() local) ---
export {
  MAX_MCP_RESULT_CHARS,
  MAX_PLUGIN_TOOL_OUTPUT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  truncateText,
  truncateTextWithRemainder,
} from './truncate';
export { createMcpSystemTools, MCP_SYSTEM_TOOLS } from './mcpSystemTools';
export type { McpOAuthConfig, McpSystemToolOptions } from './mcpSystemTools';
export { createIntegrationTools, INTEGRATION_TOOLS } from './integrationTools';
export type { IntegrationToolOptions } from './integrationTools';
export { createSkillMarketplaceTools, SKILL_MARKETPLACE_TOOLS } from './skillMarketplaceTools';
export type { SkillMarketplaceToolOptions } from './skillMarketplaceTools';
// --- v1.13 (T1): Agent Skills loader v13 tools (8 tools: list/search/validate/audit/import/export/install/uninstall) ---
export { createSkillsV13Tools, SKILLS_V13_TOOLS, SKILLS_V13_TOOL_NAMES } from './skillsV13Tools';
export type { SkillsV13ToolOptions } from './skillsV13Tools';
// --- v1.07 (T4): skills & plugins — directory skills + plugin bundle + hooks config + inline secret (8 tools) ---
export {
  activateInstalledBundle,
  createSkillsPluginsV107Tools,
  SKILLS_PLUGINS_V107_TOOLS,
  SKILLS_PLUGINS_V107_TOOL_NAMES,
  SKILL_SHOW_MAX_CHARS,
} from './skillsPluginsV107Tools';
export type { SkillsPluginsV107ToolOptions } from './skillsPluginsV107Tools';
// --- v0.14: out-of-process plugin sandbox + plugin bundles ---
export {
  SandboxedPluginHost,
  createSandboxedPluginHost,
} from './plugins/sandbox';
export type { SandboxedToolInfo } from './plugins/sandbox';
export {
  loadBundle,
  validateBundleManifest,
  resolveBundleParts,
} from './plugins/bundle';
export type {
  PluginBundleManifest,
  ResolvedPluginBundleParts,
  ResolvedBundleSkill,
  ResolvedBundleHook,
  ResolvedBundleMcpServer,
  ResolvedBundleSlashCommand,
  BundleSkillRef,
  BundleSkillInline,
  BundleSubagentRef,
  BundleHookRef,
  BundleHookMatcher,
  BundleMcpServerRef,
  BundleSlashCommandRef,
} from './plugins/bundle';
export { loadPluginFromManifest, truncatePluginOutput } from './plugins/loader';
// --- v0.89 (worker F4): data / http / text / office-write tools ---
export {
  createDataTools, DATA_TOOLS, parseCsv, csvToJson, jsonToCsv,
  rowsToObjects, csvEscapeCell, parseCondition, parseConditions,
  filterRows, parseAggregates, aggregateRows, parseJsonPath,
  queryJsonPath, MAX_DATA_INPUT_BYTES, MAX_DATA_ROWS,
} from './dataTools';
export type { CsvRow, CsvTable, FilterCondition, AggregateSpec, AggregateResult, PathSegment } from './dataTools';
export {
  createHttpTools, HTTP_TOOLS, doHttpRequest,
  HTTP_REQUEST_TIMEOUT_MS, MAX_HTTP_BODY_BYTES, MAX_HTTP_REDIRECTS,
} from './httpTools';
export type { HttpToolOptions, HttpRequestMethod } from './httpTools';
export {
  createTextTools, TEXT_TOOLS, extractWithRegex, diffLines,
  extractiveSummarize, markdownToc, slugifyHeading,
  MAX_TEXT_INPUT_CHARS, MAX_TEXT_MATCHES, MAX_DIFF_LINES,
} from './textTools';
export type { RegexMatch } from './textTools';
export {
  createOfficeWriteTools, OFFICE_WRITE_TOOLS, buildDocx, buildXlsx,
  buildZip, crc32, escapeXml, parseInlineRuns,
  MAX_OFFICE_WRITE_INPUT_BYTES, MAX_XLSX_ROWS, MAX_XLSX_CELLS_PER_ROW,
} from './officeWriteTools';
export type { ZipEntry } from './officeWriteTools';
// --- v0.95 (Team D1): internet data — multi-source search, clean
// fetch, RSS/Atom feeds, page-change watches (local-first) ---
export {
  createInternetDataTools, INTERNET_DATA_TOOLS,
  InternetDataStore, emptyInternetDataState, internetIdForUrl,
  extractReadableText, stripTags, decodeHtmlEntities,
  parseFeedXml, parseDuckDuckGoLiteResults, parseDuckDuckGoHtmlResults,
  searchWikipedia, searchBrave, doInternetSearch, doWebFetchClean,
  fetchPublicDocument, fetchFeed, checkWatches, hashContent, summarizeTextDiff,
  INTERNET_DATA_FILE, INTERNET_FETCH_TIMEOUT_MS, INTERNET_MAX_BODY_BYTES,
  INTERNET_MAX_REDIRECTS, INTERNET_SEARCH_MAX_RESULTS, INTERNET_FEED_MAX_ITEMS,
  WATCH_MIN_INTERVAL_MINUTES, WATCH_MAX_INTERVAL_MINUTES, WATCH_DEFAULT_INTERVAL_MINUTES,
  INTERNET_MAX_FEEDS, INTERNET_MAX_WATCHES,
} from './internetData';
export type {
  InternetDataOptions, InternetDataState, InternetFeed, InternetWatch,
  FeedItem, ParsedFeed, SearchResult, SearchOutcome, InternetSearchSource,
  FetchedDocument, FeedReadResult, WatchChangeEvent, FetchFn, LookupFn,
} from './internetData';
// --- v1.02 (rescue port of v0.99/v1.00): context/durable/orchestra/gateway/dream/substrate/ACP tools ---
export { createRescueV102Tools, RESCUE_V102_TOOLS, RESCUE_V102_TOOL_NAMES } from './rescueV102Tools';
// --- v1.03 (Đội T4): workspace abstraction v3 tools ---
export { WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES } from './workspaceTools';
// --- v1.03 (Team T6): fleet overview/scheduling + marketplace v3 tools ---
export { createFleetV103Tools, FLEET_V103_TOOLS, FLEET_V103_TOOL_NAMES } from './fleetV103Tools';
// --- v1.05 (Đội T3): OpenMausBot parity — doctor, team YAML, model refresh, per-bot computer v2, headless status ---
export { createOpenmausbotV105Tools, OPENMAUSBOT_V105_TOOLS, OPENMAUSBOT_V105_TOOL_NAMES } from './openmausbotV105Tools';
export type { OpenmausbotV105ToolOptions } from './openmausbotV105Tools';
// --- v1.06 (Đội T3): doctor + team YAML + driver registry + engine picker tools ---
export { createDoctorTools, DOCTOR_TOOLS, DOCTOR_TOOL_NAMES } from './doctorTools';
export type { DoctorToolOptions } from './doctorTools';
export { createTeamYamlTools, TEAM_YAML_TOOLS, TEAM_YAML_TOOL_NAMES } from './teamYamlTools';
export type { TeamYamlToolOptions } from './teamYamlTools';
export { createDriverTools, DRIVER_TOOLS, DRIVER_TOOL_NAMES } from './driverTools';
export type { DriverToolOptions } from './driverTools';
export { createEnginePickerTools, ENGINE_PICKER_TOOLS, ENGINE_PICKER_TOOL_NAMES } from './enginePickerTools';
export type { EnginePickerToolOptions } from './enginePickerTools';
// --- v1.06 (Đội T6): platform v4 tools — fleet bot scheduling + fleet status + eval ---
export { createPlatformV4Tools, PLATFORM_V4_TOOLS, PLATFORM_V4_TOOL_NAMES } from './platformV4Tools';
// --- v1.07 (Đội T6): fleet v4 teams tools — Agent Teams + worktree isolation + router context window + prompt-cache ---
export { createFleetV4TeamsTools, FLEET_V4_TEAMS_TOOLS, FLEET_V4_TEAMS_TOOL_NAMES } from './fleetV4TeamsTools';
// --- v1.08 (Đội T4): providers v2 tools — Composio v2 (8) + provider health (5) + OpenRouter/Fireworks models + info (4) ---
export { createProvidersV108Tools, PROVIDERS_V108_TOOLS, PROVIDERS_V108_TOOL_NAMES } from './providersV108Tools';
export type { ProvidersV108ToolOptions } from './providersV108Tools';
// --- v1.09 (Đội T1): Agent Teams v1 tools — lead + teammate, shared task list, mailbox, worktree plan ---
export { createAgentTeamsV109Tools, TEAM_V109_TOOLS, TEAM_V109_TOOL_NAMES } from './agentTeamsV109Tools';
// --- v1.10 (Đội T3): Agent Teams v2 tools — file-locked claiming, disk mailbox theo tên, fork, hook TaskCompleted, chi phí token ---
export { createAgentTeamsV2Tools, TEAM_V2_TOOLS, TEAM_V2_TOOL_NAMES } from './agentTeamsV2Tools';
// --- v1.11 (Đội T2): Harbor eval + rollout JSONL + Agent Profiles tools ---
export { createEvalV111Tools, EVAL_V111_TOOLS, EVAL_V111_TOOL_NAMES, isEvalV111ToolName, evalV111TasksDir, evalV111RolloutsPath } from './evalV111Tools';
export type { EvalV111ToolOptions } from './evalV111Tools';
// --- v1.12 (Đội T2): event-sourced conversation + CodeAct-lite + skill workspace tools ---
export { createConversationV112Tools, CONVERSATION_V112_TOOLS, CONVERSATION_V112_TOOL_NAMES, isConversationV112ToolName, conversationV112DataDir } from './conversationV112Tools';
export type { ConversationV112ToolOptions } from './conversationV112Tools';
// --- v1.11 (Đội T3): Agent Teams v3 tools — 7 primitives, waves, challenge, lead mode, panes tmux, chi phí tuyến tính ---
export { createAgentTeamsV3Tools, TEAM_V3_TOOLS, TEAM_V3_TOOL_NAMES } from './agentTeamsV3Tools';
