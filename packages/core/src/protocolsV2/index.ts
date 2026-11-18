/**
 * Protocols v2 — public surface (v1.16, Team T2).
 *
 * MCP 2026-07-28 stateless core (server/discover, Tasks,
 * Skills SEP-2640, compat shim for 2025-era clients) + A2A v1.0
 * signed Agent Cards with multi-tenancy + AG-UI 1.0 ordered
 * event stream with interrupt-and-resume + A2UI 1.0 generative
 * UI from a component catalog.
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v116.md sections 3 and 7. No code, text or
 * asset from any other repo is copied here. This layer builds
 * on the v1.15 triad (`protocols/`) without touching it.
 */
export {
  A2A_V2_CURRENT_VERSION,
  A2A_V2_UNSIGNED_VERSIONS,
  A2A_V2_VERSIONS,
  AGUI_V2_CURRENT_VERSION,
  AGUI_V2_VERSIONS,
  A2UI_V2_CURRENT_VERSION,
  A2UI_V2_VERSIONS,
  MCP_V2_CURRENT_VERSION,
  MCP_V2_LEGACY_REMOVAL_DATE,
  MCP_V2_LEGACY_VERSIONS,
  MCP_V2_VERSIONS,
  PROTOCOL_V2_CURRENT_VERSIONS,
  PROTOCOL_V2_FAMILIES,
  PROTOCOL_V2_KNOWN_CAPABILITIES,
  PROTOCOL_V2_VERSION_MATRIX,
  UnsupportedProtocolVersionError,
  compareProtocolVersions,
  isLegacyProtocolV2Version,
  isSupportedProtocolVersion,
  legacyRemovalInDays,
  matchCapabilities,
  negotiateAllProtocols,
  negotiateProtocolV2Version,
  negotiateProtocolV2VersionOrThrow,
  parseMcpDateVersion,
  parseProtocolV2Semver,
} from './versions';
export type {
  ProtocolV2Capability,
  ProtocolV2Family,
  ProtocolV2Negotiation,
} from './versions';
export {
  CompatShim2025,
  MCP_V2_EXTENSION_IDS,
  MCP_V2_REMOVED_METHODS,
  McpV2DiscoverError,
  SubscriptionHub,
  buildServerDiscoverDocument,
  validateServerDiscoverDocument,
} from './discover';
export type {
  BuildDiscoverOptions,
  CompatShimWarning,
  McpV2DiscoverDocument,
  McpV2ExtensionId,
  McpV2ExtensionInfo,
  ShimmedRequest,
  SubscriptionHubOptions,
  SubscriptionUpdate,
} from './discover';
export {
  MCP_TASK_V2_DEFAULT_RETRY,
  MCP_TASK_V2_STATES,
  MCP_TASK_V2_TERMINAL_STATES,
  McpTaskV2Error,
  McpTaskV2Manager,
  isMcpTaskV2Terminal,
  isRetryableError,
  mcpTaskV2RetryDelayMs,
} from './mcpTasksV2';
export type {
  CreateMcpTaskV2Options,
  McpTaskV2ManagerOptions,
  McpTaskV2ProgressEvent,
  McpTaskV2Record,
  McpTaskV2RetryPolicy,
  McpTaskV2Runner,
  McpTaskV2RunnerContext,
  McpTaskV2State,
} from './mcpTasksV2';
export {
  SKILLS_MCP_EXTENSION_ID,
  SKILLS_MCP_VERSION,
  SKILL_INDEX_URI,
  McpSkillError,
  SkillActivationGate,
  SkillsMcpServer,
  hashSkillContent,
  parseSkillMd,
  validateSkillFrontmatter,
  verifySkillContent,
} from './skillsMcp';
export type {
  McpSkill,
  McpSkillMetadata,
  ParsedSkillMd,
  SkillApproval,
  SkillApprovalDecision,
  SkillIndex,
} from './skillsMcp';
export {
  A2A_V2_BINDINGS,
  A2A_V2_DEFAULT_TENANT,
  A2A_V2_SIGNATURE_ALGORITHMS,
  A2aV2CardError,
  assertSameTenant,
  canonicaliseCardJson,
  createA2aV2TenantTask,
  describeA2aV2Binding,
  generateA2aV2Ed25519KeyPair,
  negotiateA2aV2Version,
  scopeCardsToTenant,
  signA2aV2AgentCard,
  verifyA2aV2AgentCard,
} from './a2aCardV2';
export type {
  A2aV2AgentCardInput,
  A2aV2Binding,
  A2aV2Ed25519KeyPair,
  A2aV2SignatureAlgorithm,
  A2aV2SigningKey,
  A2aV2TenantTask,
  A2aV2Verification,
  A2aV2VerificationKey,
  SignedA2aV2AgentCard,
} from './a2aCardV2';
export {
  AGUI_V2_MAX_BUFFERED_EVENTS,
  AGUI_V2_VERSION,
  AgUiV2StreamError,
  AgUiV2Stream,
  findAgUiV2SequenceGaps,
} from './aguiStreamV2';
export type {
  AgUiV2BufferedEvent,
  AgUiV2RunStatus,
  AgUiV2StreamOptions,
} from './aguiStreamV2';
export {
  A2UI_V2_PROP_TYPES,
  A2UI_V2_VERSION,
  A2uiV2Catalog,
  A2uiV2Error,
  validateA2uiV2State,
} from './a2uiV2';
export type {
  A2uiV2Component,
  A2uiV2PropDeclaration,
  A2uiV2PropType,
  A2uiV2RenderFrame,
  A2uiV2Surface,
  A2uiV2SurfaceStatus,
} from './a2uiV2';
export {
  A2A_V117_TWO_WAY_VERSION,
  A2A_V117_VERSION,
  A2A_TERMINAL_STATES as A2A_V117_TERMINAL_STATES,
  A2aV117Client,
  A2aV117Server,
  A2aV117Error,
  AgentCardStore,
  ArtifactStore,
  TwoWayTaskSession,
  discoverAgentCard,
  fetchAgentCardDirect,
} from './a2aV117';
export type {
  A2aV117CardSource,
  A2aV117DiscoveredCard,
  A2aV117DownstreamEvent,
  A2aV117JsonFetcher,
  A2aV117ArtifactInput,
  A2aV117ServerRunner,
  A2aV117SessionStatus,
  A2aV117StreamHandle,
  A2aV117Transport,
  A2aV117UpstreamEvent,
  A2aV117WaitOptions,
} from './a2aV117';
export {
  MCP_V117_DEFAULT_MAX_RETRIES,
  MCP_V117_DEFAULT_TIMEOUT_MS,
  MCP_V117_PROTOCOL_VERSION,
  McpStatelessV117Error,
  StatelessMcpClientV117,
  isTransientMcpError,
  statelessTransportFromRequest,
} from './mcpStatelessV117';
export type {
  McpV117ConnectMode,
  McpV117ConnectionState,
  McpV117Notification,
  McpV117NotificationHandler,
  McpV117Prompt,
  McpV117Resource,
  McpV117Tool,
  McpV117ToolCallResult,
  McpV117ToolPage,
  StatelessMcpClientV117Options,
  StatelessMcpTransport,
} from './mcpStatelessV117';
export {
  UNIFIED_RENDERER_MAX_NODES,
  UNIFIED_RENDERER_VERSION,
  UnifiedRenderer,
  UnifiedRendererError,
  a2uiKindToUnifiedNodeKind,
  validateUnifiedTreeSnapshot,
} from './unifiedRenderer';
export type {
  McpAppResourceLoader,
  UnifiedNode,
  UnifiedNodeKind,
  UnifiedNodeSource,
  UnifiedRendererOptions,
  UnifiedTreeDiff,
  UnifiedTreeSnapshot,
} from './unifiedRenderer';
export {
  HARNESS_MANIFEST_MAX_FILE_BYTES,
  HARNESS_MANIFEST_MAX_TASKS,
  HARNESS_MANIFEST_VERSION,
  HarnessManifestController,
  HarnessManifestError,
  buildHarnessManifest,
  canonicaliseHarnessManifest,
  checkHarnessTool,
  diffHarnessManifests,
  hashHarnessManifest,
  loadHarnessManifestFromFile,
  parseHarnessManifest,
  saveHarnessManifestToFile,
  validateHarnessManifest,
} from './harnessManifest';
export type {
  HarnessManifest,
  HarnessManifestControllerOptions,
  HarnessManifestDiff,
  HarnessManifestLimits,
  HarnessManifestMcpServer,
  HarnessManifestModel,
  HarnessManifestToolRestrictions,
  HarnessRunnerContext,
  HarnessTask,
  HarnessTaskEvent,
  HarnessTaskRunner,
  HarnessTaskStatus,
  HarnessToolCheck,
} from './harnessManifest';
