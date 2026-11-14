/**
 * ACP (Agent Client Protocol) v1 — public surface of
 * `packages/core/src/acp/`.
 *
 * Two sides, one protocol (see `types.ts` for the wire format):
 * - Agent side (`AcpAgentServer`): open-bot IS the agent — an editor
 *   or another client drives it over stdio.
 * - Client side (`AcpClient`, `ExternalAgentManager`): open-bot
 *   drives an EXTERNAL agent over stdio.
 *
 * This is distinct from the CLI ACP providers in
 * `providers/cli/acp.ts`, which wrap specific coding CLIs
 * (claude/codex/...) as providers. The modules here implement the
 * protocol itself, transport and session handling included.
 */
export {
  ACP_AGENT_NAME,
  ACP_AGENT_VERSION,
  ACP_JSON_RPC_INTERNAL_ERROR,
  ACP_JSON_RPC_INVALID_PARAMS,
  ACP_JSON_RPC_INVALID_REQUEST,
  ACP_JSON_RPC_METHOD_NOT_FOUND,
  ACP_JSON_RPC_PARSE_ERROR,
  ACP_JSON_RPC_REQUEST_CANCELLED,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_TERMINAL_STOP_REASONS,
  AcpError,
  isRecord,
} from './types';
export type {
  AcpAgentCapabilities,
  AcpAgentInfo,
  AcpAuthMethod,
  AcpClientCapabilities,
  AcpConfigOption,
  AcpContentBlock,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpMcpServerConfig,
  AcpPermissionOption,
  AcpPromptResult,
  AcpRecordedMessage,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionInfo,
  AcpSessionUpdate,
  AcpStopReason,
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcMessage,
} from './types';

export { AcpJsonRpcPeer, AcpJsonRpcError, createAcpPeerPair, isJsonRpcErrorObject, isJsonRpcMessage, jsonRpcError, ACP_DEFAULT_MAX_LINE_BYTES } from './transport';
export type { AcpJsonRpcPeer as AcpPeer, AcpNotificationHandler, AcpPeerOptions, AcpRequestHandler, AcpTransportStats } from './transport';

export { AcpSessionStore, defaultAcpConfigOptions } from './sessionStore';
export type { AcpSessionStoreOptions, AcpStoredSession } from './sessionStore';

export { EchoRunner, CallbackRunner, AcpRunnerRegistry } from './runner';
export type { AcpRunContext, AcpRunResult, AcpRunner } from './runner';

export { AcpAgentServer, defaultAcpConfigOptions as acpDefaultConfigOptions } from './agentServer';
export type { AcpAgentServerOptions, AcpAgentServerStats } from './agentServer';

export { AcpClient, spawnAcpAgent } from './client';
export type { AcpAgentProcess, AcpClientOptions, AcpPermissionRequest } from './client';

export { detectAcpAgents, findOnPath, listKnownAcpAgents, probeAcpAgent, registerKnownAcpAgent, KNOWN_ACP_AGENTS } from './detect';
export type { AcpAgentProbe, KnownAcpAgent } from './detect';

export { ExternalAgentManager } from './externalAgent';
export type { ExternalAgentManagerOptions, ManagedAcpAgent } from './externalAgent';

// v1.03 (Team T3): ACP hosting — run an external harness as a
// replaceable backend (backends, host), Claude Code plugin-format
// compat, the four supplemented harness patterns, and the 29-pattern
// audit of open-bot against the Harness Engineering survey.
export {
  ACP_HOST_BACKENDS,
  acpBackendArgVariants,
  getAcpBackend,
  listAcpBackends,
  registerAcpBackend,
} from './backends';
export type { AcpBackendDefinition } from './backends';

export { AcpHost } from './hosting';
export type {
  AcpBackendProbe,
  AcpFallbackAttempt,
  AcpHostedBackend,
  AcpHostOptions,
  AcpHostPromptResult,
  AcpHostStatus,
} from './hosting';

export {
  claudePluginToOpenBot,
  parseClaudeMarketplaceManifest,
  parseClaudePluginManifest,
  parseMarkdownFrontmatter,
  scanClaudePluginDir,
} from './pluginFormat';
export type {
  ClaudeMarketplaceManifest,
  ClaudeMarketplacePluginEntry,
  ClaudePluginAuthor,
  ClaudePluginManifest,
  OpenBotPluginRecord,
  PluginFormatResult,
  ScannedPlugin,
  ScannedPluginCommand,
  ScannedPluginSkill,
} from './pluginFormat';

// v1.04 (Team T3): Claude Code plugin RUNTIME — activate a plugin's
// hooks as shell-command hooks, render its commands/agents as prompt
// templates. Explicit opt-in activation only; see pluginRuntime.ts.
export {
  activateClaudePlugin,
  deactivateClaudePlugin,
  extractPluginMcpServers,
  MAX_PLUGIN_HOOK_COMMAND_CHARS,
  MAX_PLUGIN_PROMPT_CHARS,
  parsePluginHooks,
  parsePromptTemplateFrontmatter,
  pluginHookBaseName,
  readPluginHooksFile,
  readPluginSkill,
  readPromptTemplates,
  renderPluginCommand,
  splitPluginMatcher,
  stripPromptTemplateFrontmatter,
} from './pluginRuntime';
export type {
  ActivatePluginOptions,
  ActivatePluginResult,
  ActivatedPlugin,
  PluginHookEntry,
  PluginMcpServer,
  PluginPromptTemplate,
} from './pluginRuntime';

export {
  DEFAULT_DENY_PATTERNS,
  AcpSubAgentDelegator,
  DenyListSecurityReviewer,
  SignatureStuckDetector,
  ThresholdCompactionAdvisor,
} from './patterns';
export type {
  CompactionAdvice,
  CompactionAdvisor,
  ContextState,
  DelegationRequest,
  DelegationResult,
  SecurityReviewer,
  SecurityVerdict,
  StuckDetector,
  StuckVerdict,
  SubAgentDelegator,
  ThresholdCompactionAdvisorOptions,
  ToolCallToReview,
  TurnRecord,
} from './patterns';

export {
  HARNESS_PATTERN_CATALOG,
  HARNESS_SUBSYSTEMS,
  V103_IMPROVED_PATTERNS,
  auditHarnessPatterns,
  auditSummaryLine,
} from './harnessAudit';
export type {
  HarnessAuditReport,
  HarnessAuditSummary,
  HarnessPattern,
  HarnessSubsystem,
  PatternStatus,
} from './harnessAudit';
