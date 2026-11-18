/**
 * Composio (v0.57) — public surface of packages/core/src/composio/.
 *
 * Tích hợp tối thiểu đã duyệt (Huy 2026-11-09 20:09): adapter opt-in
 * sau AppRegistry, transport MCP Tool Router tái dùng connectMcp,
 * 40 toolkit (Gmail, GitHub, Slack, Notion + 10 toolkit v0.72a
 * + 8 toolkit v0.82: Zoom, Salesforce, Zendesk, Airtable, Monday,
 * ClickUp, Dropbox, Outlook + 18 toolkit v0.96: Stripe, Shopify,
 * Box, Confluence, GitLab, Calendly, Mailchimp, Twilio, Google Docs,
 * YouTube, LinkedIn, Reddit, WhatsApp, PagerDuty, Typeform, SendGrid,
 * Bitbucket, Freshdesk), key user trong Vault.
 * Xem docs/composio-integration.md.
 */
export {
  COMPOSIO_GITHUB_POLL_TRIGGER_SLUG,
  COMPOSIO_POLL_BACKOFF_MAX_MS,
  COMPOSIO_POLL_BACKOFF_MULTIPLIER,
  COMPOSIO_POLL_MAX_INTERVAL_MS,
  COMPOSIO_POLL_MIN_INTERVAL_MS,
  COMPOSIO_SLACK_POLL_TRIGGER_SLUG,
  ComposioPollScheduler,
  clampComposioPollIntervalMs,
  composioPollBackoffDelayMs,
  createGithubComposioPollEntry,
  createGmailComposioPollEntry,
  createSlackComposioPollEntry,
} from './pollScheduler';
export type {
  ComposioPollEnqueuedInfo,
  ComposioPollEntryConfig,
  ComposioPollSchedulerOptions,
  ComposioPollStatus,
} from './pollScheduler';
export {
  COMPOSIO_POLL_STATE_FILE,
  COMPOSIO_POLL_STATE_MAX_SEEN_IDS,
  COMPOSIO_POLL_STATE_VERSION,
  JsonFileComposioPollStateStore,
  MemoryComposioPollStateStore,
  defaultComposioPollState,
  pruneComposioPollSeenIds,
  resolveComposioPollState,
  resolveComposioPollStateDoc,
} from './pollState';
export type {
  ComposioPollSeenId,
  ComposioPollState,
  ComposioPollStateDoc,
  ComposioPollStateStore,
} from './pollState';
export {
  COMPOSIO_API_BASE_URL,
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_MCP_HOST_SUFFIX,
  COMPOSIO_META_TOOLS,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOL,
  ComposioError,
} from './types';
export type {
  ComposioCallToolFn,
  ComposioConnectionStatus,
  ComposioErrorCode,
  ComposioExecuteItem,
  ComposioSession,
  ComposioSessionToolRef,
  ComposioToolkitConnection,
  CreateComposioSessionOptions,
} from './types';
export {
  COMPOSIO_VAULT_KEY,
  COMPOSIO_VAULT_NAMESPACE,
  COMPOSIO_VAULT_USER_ID_KEY,
  asComposioKeyVault,
  clearComposioApiKey,
  clearComposioUserId,
  createComposioSeededKeyReader,
  createComposioVaultFileKeyReader,
  getComposioApiKey,
  getComposioUserId,
  hasComposioApiKey,
  hasComposioUserId,
  normalizeComposioUserId,
  redactComposioKey,
  setComposioApiKey,
  setComposioUserId,
  validateComposioUserId,
} from './keyStore';
export type { ComposioKeyVault, ComposioSeededKeyReader } from './keyStore';
export {
  COMPOSIO_ROUTER_APP,
  COMPOSIO_ROUTER_APP_ID,
  COMPOSIO_TOOLKITS,
  COMPOSIO_TOOLKIT_SLUGS,
  COMPOSIO_WRITE_VERBS,
  composioAppId,
  composioToolNeedsApproval,
  createComposioAppDefinitions,
  createComposioToolkitAppDefinitions,
  toolkitForComposioAppId,
} from './toolkits';
export type { ComposioToolkitDef } from './toolkits';
export {
  COMPOSIO_V110_MOCK_TOOLKITS,
  MockComposioV110Executor,
  createMockComposioV110AppDefinitions,
  executeMockComposioV110Tool,
  findMockComposioV110Toolkit,
  isMockComposioV110Slug,
  mockComposioV110AppId,
  mockComposioV110DeterministicId,
  mockComposioV110Slugs,
  mockComposioV110ToolNeedsApproval,
} from './toolkitsV110';
export type { ComposioV110MockToolkitDef, MockComposioV110Result } from './toolkitsV110';
export { ComposioToolRouter, isTrustedComposioMcpUrl } from './router';
export type { ComposioFetchFn, ComposioToolRouterOptions } from './router';
export { ComposioAppSource } from './source';
export type { ComposioAppSourceOptions } from './source';
export {
  applyComposioPersistedState,
  buildComposioStateView,
  composioStateToPersist,
  defaultComposioPersistedState,
  resolveComposioPersistedState,
} from './state';
export type {
  ComposioAppStateView,
  ComposioPersistedState,
  ComposioStateView,
} from './state';
export {
  COMPOSIO_LOCAL_USER_ID,
  COMPOSIO_RUNNABLE_META_TOOLS,
  ComposioSessionManager,
  createComposioMetaTools,
  resolveComposioUserId,
} from './executors';
export type {
  ComposioMcpClientLike,
  ComposioSessionManagerOptions,
  CreateComposioMetaToolsDeps,
} from './executors';
export {
  COMPOSIO_TRIGGER_COUNTS,
  COMPOSIO_TRIGGER_DEFS,
  COMPOSIO_TRIGGER_SLUGS,
  COMPOSIO_TRIGGER_TOTAL_COUNT,
  COMPOSIO_WEBHOOK_ID_HEADER,
  COMPOSIO_WEBHOOK_SIGNATURE_HEADER,
  COMPOSIO_WEBHOOK_SIGNATURE_PREFIX,
  COMPOSIO_WEBHOOK_TIMESTAMP_HEADER,
  COMPOSIO_WEBHOOK_TOLERANCE_SECONDS,
  COMPOSIO_TRIGGER_SLUG_RE,
  computeComposioWebhookSignature,
  composioTriggerToInput,
  findComposioTriggerDef,
  isKnownComposioTriggerSlug,
  isValidComposioTriggerSlug,
  parseComposioTriggerPayload,
  verifyComposioTriggerToken,
  verifyComposioWebhookSignature,
} from './triggers';
export type { ComposioTriggerDef, ComposioTriggerEvent } from './triggers';
export {
  COMPOSIO_TRIGGER_LONG_POLL_MAX_TIMEOUT_MS,
  COMPOSIO_TRIGGER_QUEUE_DEFAULT_MAX_SIZE,
  COMPOSIO_TRIGGER_QUEUE_DEFAULT_TTL_MS,
  ComposioTriggerQueue,
  getSharedComposioTriggerQueue,
} from './triggerQueue';
export type {
  ComposioTriggerQueueFilter,
  ComposioTriggerQueueOptions,
  ComposioTriggerQueueStats,
  QueuedComposioTriggerEvent,
} from './triggerQueue';
export {
  COMPOSIO_GMAIL_POLL_INTERVAL_MS,
  COMPOSIO_GMAIL_POLL_QUERY,
  COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS,
  COMPOSIO_POLL_DEDUPE_WINDOW_MS,
  ComposioPoller,
  composioPollItemId,
  createGmailPollerConfig,
  parseComposioPollItems,
} from './polling';
export {
  COMPOSIO_GMAIL_POLL_TRIGGER_SLUG,
  COMPOSIO_POLL_TRIGGER_EVENT_TYPE,
  createComposioPollToQueueBridge,
  enqueueComposioPollResult,
  hashComposioPollItem,
} from './pollBridge';
export type {
  ComposioPollToQueueBridge,
  ComposioPollToQueueBridgeOptions,
} from './pollBridge';
// --- v1.08 (Đội T4): toolkit-status polling — poll connection status
// per toolkit on a schedule, report changes (not app-event polling,
// which lives in polling.ts / pollScheduler.ts). ---
export {
  COMPOSIO_TOOLKIT_STATUS_POLL_DEFAULT_INTERVAL_MS,
  COMPOSIO_TOOLKIT_STATUS_POLL_MAX_CHANGES,
  COMPOSIO_TOOLKIT_STATUS_POLL_MAX_INTERVAL_MS,
  COMPOSIO_TOOLKIT_STATUS_POLL_MIN_INTERVAL_MS,
  ComposioToolkitStatusPoller,
} from './toolkitStatusPolling';
export type {
  ComposioToolkitStatusChange,
  ComposioToolkitStatusEntry,
  ComposioToolkitStatusFetchFn,
  ComposioToolkitStatusPollResult,
  ComposioToolkitStatusPollerOptions,
  ComposioToolkitStatusPollerStatus,
} from './toolkitStatusPolling';
// --- v1.08 (Đội T4): trigger → internal-action mapping (user-editable
// table: Composio trigger slug → automation / internal tool / notify). ---
export {
  COMPOSIO_TRIGGER_MAPPINGS_FILE,
  COMPOSIO_TRIGGER_MAPPINGS_VERSION,
  COMPOSIO_TRIGGER_MAPPING_MAX_DESCRIPTION_CHARS,
  COMPOSIO_TRIGGER_MAPPING_MAX_TARGET_CHARS,
  ComposioTriggerMappingStore,
  renderComposioTriggerTemplate,
  resolveComposioTriggerMapping,
  validateComposioTriggerMapping,
} from './triggerMapping';
export type {
  ComposioResolvedTriggerAction,
  ComposioTriggerActionKind,
  ComposioTriggerMapping,
  ComposioTriggerMappingEvent,
  ComposioTriggerMappingInput,
  ComposioTriggerMappingPatch,
  ComposioTriggerMappingStoreOptions,
  ComposioTriggerResolveResult,
} from './triggerMapping';
// --- v1.08 (Đội T4): per-toolkit connection management — enable/disable
// per toolkit + health check per toolkit + summary for the UI. ---
export {
  COMPOSIO_TOOLKIT_CONNECTIONS_FILE,
  COMPOSIO_TOOLKIT_CONNECTIONS_VERSION,
  ComposioToolkitConnectionManager,
} from './toolkitConnections';
export type {
  ComposioSingleToolkitStatusFetchFn,
  ComposioToolkitConnectionManagerOptions,
  ComposioToolkitConnectionState,
  ComposioToolkitConnectionSummary,
} from './toolkitConnections';
export type {
  ComposioPollFetchFn,
  ComposioPollItem,
  ComposioPollResult,
  ComposioPollerConfig,
} from './polling';
export {
  COMPOSIO_TRIGGER_KEYS_NAMESPACE,
  COMPOSIO_TRIGGER_TOKEN_KEY_SUFFIX,
  composioTriggerTokenKeyId,
  createComposioTriggerToken,
  deleteComposioTriggerSecrets,
  deleteComposioTriggerSigningSecret,
  deleteComposioTriggerToken,
  getComposioTriggerSigningSecret,
  getComposioTriggerToken,
  getComposioTriggerTokenByKeyId,
  hasComposioTriggerSigningSecret,
  hasComposioTriggerToken,
  rotateComposioTriggerToken,
  setComposioTriggerSigningSecret,
} from './triggerKeys';
export type { ComposioTriggerKey, ComposioTriggerKeyVault } from './triggerKeys';
export {
  COMPOSIO_V111_MOCK_TOOLKITS,
  MockComposioV111Executor,
  createMockComposioV111AppDefinitions,
  executeMockComposioV111Tool,
  findMockComposioV111Toolkit,
  isMockComposioV111Slug,
  mockComposioV111AppId,
  mockComposioV111DeterministicId,
  mockComposioV111Slugs,
  mockComposioV111ToolNeedsApproval,
} from './toolkitsV111';
export type { ComposioV111MockToolkitDef, MockComposioV111Result } from './toolkitsV111';
export {
  COMPOSIO_V111_CONNECTIONS_FILE,
  COMPOSIO_V111_CONNECTION_AUDIT_FILE,
  COMPOSIO_V111_DEFAULT_MAX_RECONNECTS,
  COMPOSIO_V111_DEFAULT_RECONNECT_BASE_BACKOFF_MS,
  COMPOSIO_V111_DEFAULT_RECONNECT_MAX_BACKOFF_MS,
  COMPOSIO_V111_DEFAULT_RECONNECT_WINDOW_MS,
  COMPOSIO_V111_LIFECYCLE_STATUSES,
  COMPOSIO_V111_MAX_AUDIT_LINES,
  COMPOSIO_V111_MAX_TRACKED_TOOLKITS,
  DEFAULT_COMPOSIO_V111_RECONNECT_POLICY,
  appendComposioV111Audit,
  composioV111ReconnectBackoffMs,
  createComposioV111AuditEntry,
  decideComposioV111AutoReconnect,
  disconnectComposioV111Connection,
  emptyComposioV111ConnectionEntry,
  getComposioV111AuditPath,
  getComposioV111ConnectionsPath,
  isComposioV111ManagedToolkit,
  listComposioV111Audit,
  loadComposioV111Connections,
  reconnectComposioV111Connection,
  saveComposioV111Connections,
  summarizeComposioV111Connections,
  syncComposioV111SessionStatus,
  validateComposioV111AuditEntry,
  validateComposioV111ConnectionEntry,
} from './connectionLifecycle';
export type {
  ComposioV111AuditAction,
  ComposioV111ConnectionAuditEntry,
  ComposioV111ConnectionEntry,
  ComposioV111ConnectionSummary,
  ComposioV111LifecycleStatus,
  ComposioV111ReconnectDecision,
  ComposioV111ReconnectPolicy,
} from './connectionLifecycle';
export {
  COMPOSIO_V111_DEFAULT_DEDUPE_WINDOW_MS,
  COMPOSIO_V111_DEFAULT_ERROR_FACTOR,
  COMPOSIO_V111_DEFAULT_HIT_FACTOR,
  COMPOSIO_V111_DEFAULT_JITTER_FRACTION,
  COMPOSIO_V111_DEFAULT_MAX_INTERVAL_MS,
  COMPOSIO_V111_DEFAULT_MAX_SEEN_IDS,
  COMPOSIO_V111_DEFAULT_MIN_INTERVAL_MS,
  COMPOSIO_V111_DEFAULT_MISS_FACTOR,
  DEFAULT_COMPOSIO_V111_POLL_POLICY,
  applyComposioV111Jitter,
  clampComposioV111IntervalMs,
  emptyComposioV111PollPolicyState,
  isComposioV111Duplicate,
  missedPollsBetween,
  nextComposioV111Poll,
  pruneComposioV111SeenIds,
  recordComposioV111SeenIds,
  summarizeComposioV111CatchUp,
  summarizeComposioV111PollState,
  validateComposioV111PollPolicy,
} from './pollPolicyV111';
export type {
  ComposioV111CatchUpSummary,
  ComposioV111PollOutcome,
  ComposioV111PollPolicy,
  ComposioV111PollPolicyState,
} from './pollPolicyV111';
export {
  COMPOSIO_V112_MOCK_TOOLKITS,
  MockComposioV112Executor,
  createMockComposioV112AppDefinitions,
  executeMockComposioV112Tool,
  findMockComposioV112Toolkit,
  isMockComposioV112Slug,
  mockComposioV112AppId,
  mockComposioV112DeterministicId,
  mockComposioV112Slugs,
  mockComposioV112ToolNeedsApproval,
  summarizeMockComposioV112Catalogue,
} from './toolkitsV112';
export type { ComposioV112MockToolkitDef, MockComposioV112Result } from './toolkitsV112';
// --- v1.14 (Đội T4): mock toolkits v114 — Webflow, Pipedrive,
// Chargebee, Xero, Eventbrite, SurveyMonkey (mock-only, chua live). ---
export {
  COMPOSIO_V114_MOCK_TOOLKITS,
  MockComposioV114Executor,
  createMockComposioV114AppDefinitions,
  executeMockComposioV114Tool,
  findMockComposioV114Toolkit,
  isMockComposioV114Slug,
  mockComposioV114AppId,
  mockComposioV114DeterministicId,
  mockComposioV114Slugs,
  mockComposioV114ToolNeedsApproval,
  resolveMockComposioV114Slug,
  summarizeMockComposioV114Catalogue,
} from './toolkitsV114';
export type { ComposioV114AuthKind, ComposioV114MockToolkitDef, MockComposioV114Result } from './toolkitsV114';
// --- v1.14 (Đội T4): poll scheduler v2 — lich theo connection,
// backoff khi loi, dedupe event, checkpoint resume sau restart. ---
export {
  COMPOSIO_V114_CHECKPOINT_VERSION,
  COMPOSIO_V114_DEFAULT_BACKOFF_MULTIPLIER,
  COMPOSIO_V114_DEFAULT_DEDUPE_WINDOW_MS,
  COMPOSIO_V114_DEFAULT_INTERVAL_BY_TOOLKIT,
  COMPOSIO_V114_DEFAULT_INTERVAL_MS,
  COMPOSIO_V114_DEFAULT_JITTER_FRACTION,
  COMPOSIO_V114_DEFAULT_MAX_BACKOFF_MS,
  COMPOSIO_V114_DEFAULT_MAX_SEEN_IDS,
  ComposioV114PollEngine,
  applyComposioV114Jitter,
  checkpointComposioV114Schedule,
  composioV114BackoffDelayMs,
  composioV114MsUntilNextPoll,
  createComposioV114Schedule,
  defaultComposioV114IntervalMs,
  filterComposioV114NewItems,
  isComposioV114Duplicate,
  isComposioV114ScheduleDue,
  missedComposioV114Polls,
  nextComposioV114PollAfterError,
  nextComposioV114PollAfterSuccess,
  parseComposioV114Checkpoint,
  pruneComposioV114SeenIds,
  recordComposioV114SeenIds,
  resumeComposioV114Schedule,
  serializeComposioV114Checkpoint,
  validateComposioV114Checkpoint,
  validateComposioV114Schedule,
} from './pollSchedulerV2';
export type {
  ComposioV114Checkpoint,
  ComposioV114CreateScheduleInput,
  ComposioV114FetchFn,
  ComposioV114PollEngineOptions,
  ComposioV114PollItem,
  ComposioV114PollSchedule,
  ComposioV114SeenEntry,
  ComposioV114TickResult,
} from './pollSchedulerV2';
// --- v1.14 (Đội T4): trigger templates v2 — 35 template co schema +
// mo ta + vi du payload (29 curated + 6 candidate cho toolkit v114). ---
export {
  COMPOSIO_V114_TRIGGER_TEMPLATES,
  COMPOSIO_V114_TRIGGER_TEMPLATE_COUNT,
  composioV114TemplateToMappingInput,
  composioV114TemplatesForCategory,
  composioV114TemplatesForToolkit,
  findComposioV114TriggerTemplate,
  renderComposioV114ExamplePayload,
  searchComposioV114TriggerTemplates,
  validateComposioV114TriggerTemplates,
} from './triggerTemplatesV114';
export type {
  ComposioV114TemplateSource,
  ComposioV114TriggerCategory,
  ComposioV114TriggerField,
  ComposioV114TriggerFieldType,
  ComposioV114TriggerTemplate,
} from './triggerTemplatesV114';
// --- v1.14 (Đội T4): connection health dashboard — trang thai, lan
// sync cuoi, ti le loi, latency, canh bao khi connection yeu/het han. ---
export {
  COMPOSIO_V114_MAX_LATENCY_SAMPLES,
  COMPOSIO_V114_MIN_POLLS_FOR_RATE,
  ComposioV114HealthStore,
  DEFAULT_COMPOSIO_V114_HEALTH_THRESHOLDS,
  averageComposioV114Latency,
  emptyComposioV114ConnectionHealth,
  evaluateComposioV114Health,
  percentileComposioV114Latency,
  recordComposioV114SyncError,
  recordComposioV114SyncSuccess,
  setComposioV114ConnectionExpiry,
  summarizeComposioV114HealthDashboard,
  validateComposioV114ConnectionHealth,
  validateComposioV114HealthThresholds,
} from './connectionHealth';
export type {
  ComposioV114ConnectionHealth,
  ComposioV114HealthAlert,
  ComposioV114HealthAlertKind,
  ComposioV114HealthDashboard,
  ComposioV114HealthStatus,
  ComposioV114HealthThresholds,
} from './connectionHealth';
// --- v1.14 (Đội T4): MCP Apps/Tasks bridge — expose tool mock v114
// qua MCP App (ui://composio/...) + Task (chi client goi mock). ---
export {
  COMPOSIO_V114_MCP_APP_COUNT,
  COMPOSIO_V114_MCP_APP_CATEGORIES,
  COMPOSIO_V114_MCP_APP_SERVER_ID,
  COMPOSIO_V114_MCP_APP_URI_PREFIX,
  ComposioV114McpTaskStore,
  cancelComposioV114McpTask,
  composioV114McpAppId,
  composioV114McpAppUri,
  createComposioV114McpApp,
  createComposioV114McpTask,
  executeMockComposioV114ToolViaApp,
  findComposioV114McpApp,
  isComposioV114McpAppUri,
  listComposioV114McpApps,
  parseComposioV114McpAppUri,
  renderComposioV114McpAppHtml,
  runComposioV114McpTask,
  summarizeComposioV114McpTask,
  validateComposioV114McpAppHtml,
} from './mcpComposioBridge';
export type { ComposioV114McpAppDef, ComposioV114McpTask } from './mcpComposioBridge';
// --- v1.18 (Đội T4): mock toolkits v118 — Canva, PandaDoc, Loom
// (mock-only, chua live). ---
export {
  COMPOSIO_V118_MOCK_TOOLKITS,
  MockComposioV118Executor,
  createMockComposioV118AppDefinitions,
  executeMockComposioV118Tool,
  findMockComposioV118Toolkit,
  isMockComposioV118Slug,
  mockComposioV118AppId,
  mockComposioV118DeterministicId,
  mockComposioV118Slugs,
  mockComposioV118ToolNeedsApproval,
  resolveMockComposioV118Slug,
  summarizeMockComposioV118Catalogue,
} from './toolkitsV118';
export type { ComposioV118AuthKind, ComposioV118MockToolkitDef, MockComposioV118Result } from './toolkitsV118';
// --- v1.18 (Đội T4): polling v5 — adaptive per-connection (burst /
// idle cap / backoff), dedupe, state persist per-connection. ---
export {
  COMPOSIO_V118_DEFAULT_BURST_AFTER_HITS,
  COMPOSIO_V118_DEFAULT_DEDUPE_WINDOW_MS,
  COMPOSIO_V118_DEFAULT_IDLE_CAP_AFTER_MISSES,
  COMPOSIO_V118_DEFAULT_MAX_SEEN_IDS,
  COMPOSIO_V118_POLL_STATE_FILE,
  COMPOSIO_V118_POLL_STATE_VERSION,
  ComposioV118PollEngine,
  JsonFileComposioV118PollStateStore,
  MemoryComposioV118PollStateStore,
  composioV118MsUntilNextPoll,
  composioV118PollMode,
  createComposioV118ConnState,
  defaultComposioV118IntervalMs,
  filterComposioV118NewItems,
  getComposioV118PollStatePath,
  isComposioV118ConnDue,
  missedComposioV118Polls,
  nextComposioV118Poll,
  parseComposioV118PollState,
  serializeComposioV118PollState,
  validateComposioV118ConnState,
} from './pollingV118';
export type {
  ComposioV118CreateConnStateInput,
  ComposioV118FetchFn,
  ComposioV118PollConnState,
  ComposioV118PollItem,
  ComposioV118PollMode,
  ComposioV118PollStateDoc,
  ComposioV118PollStateStore,
  ComposioV118TickResult,
  JsonFileComposioV118PollStateStoreOptions,
  ComposioV118PollEngineOptions,
} from './pollingV118';
// --- v1.18 (Đội T4): trigger instances — dang ky/bat/tat/xoa +
// health + last-fired + audit. ---
export {
  COMPOSIO_V118_MAX_AUDIT_LINES,
  COMPOSIO_V118_MAX_INSTANCES,
  COMPOSIO_V118_SILENT_AFTER_MS,
  COMPOSIO_V118_STALE_AFTER_MS,
  COMPOSIO_V118_TRIGGER_AUDIT_ACTIONS,
  COMPOSIO_V118_TRIGGER_INSTANCES_FILE,
  COMPOSIO_V118_TRIGGER_INSTANCES_VERSION,
  COMPOSIO_V118_TRIGGER_INSTANCE_AUDIT_FILE,
  JsonFileComposioV118TriggerInstanceStore,
  MemoryComposioV118TriggerInstanceStore,
  createComposioV118TriggerAuditEntry,
  createComposioV118TriggerInstance,
  disableComposioV118TriggerInstance,
  enableComposioV118TriggerInstance,
  evaluateComposioV118TriggerHealth,
  filterComposioV118TriggerInstances,
  getComposioV118TriggerInstanceAuditPath,
  getComposioV118TriggerInstancesPath,
  recordComposioV118TriggerError,
  recordComposioV118TriggerFired,
  summarizeComposioV118TriggerInstance,
  summarizeComposioV118TriggerInstances,
  validateComposioV118TriggerAuditEntry,
  validateComposioV118TriggerInstance,
} from './triggerInstancesV118';
export type {
  ComposioV118RegisterTriggerInput,
  ComposioV118TriggerAuditAction,
  ComposioV118TriggerAuditEntry,
  ComposioV118TriggerHealth,
  ComposioV118TriggerInstance,
  ComposioV118TriggerInstanceFilter,
  ComposioV118TriggerInstanceStatus,
  ComposioV118TriggerInstanceStore,
} from './triggerInstancesV118';
// --- v1.18 (Đội T4): OAuth state machine — connected/connecting/
// expired/revoked/refreshing + auto-refresh (mock) + UI state. ---
export {
  COMPOSIO_V118_DEFAULT_MAX_AUTO_REFRESHES,
  COMPOSIO_V118_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
  COMPOSIO_V118_MAX_OAUTH_AUDIT_ENTRIES,
  COMPOSIO_V118_OAUTH_STATES,
  COMPOSIO_V118_OAUTH_TRANSITIONS,
  autoRefreshComposioV118OAuth,
  composioV118OAuthUiState,
  createComposioV118OAuthEntry,
  decideComposioV118AutoRefresh,
  isComposioV118OAuthTransitionAllowed,
  isComposioV118TokenExpired,
  isComposioV118TokenExpiringSoon,
  summarizeComposioV118OAuth,
  syncComposioV118OAuthExpiry,
  transitionComposioV118OAuth,
  validateComposioV118OAuthEntry,
} from './oauthStateV118';
export type {
  ComposioV118OAuthAuditEntry,
  ComposioV118OAuthEntry,
  ComposioV118OAuthState,
  ComposioV118OAuthUiAction,
  ComposioV118OAuthUiState,
  ComposioV118RefreshFn,
  ComposioV118RefreshResult,
} from './oauthStateV118';
// --- v1.18 (Đội T4): webhook ingestion — endpoint loopback-only,
// verify chu ky, parse + route toi trigger instance, dedupe, log. ---
export {
  COMPOSIO_V118_WEBHOOK_DEDUPE_WINDOW_MS,
  COMPOSIO_V118_MAX_WEBHOOK_LOG_LINES,
  COMPOSIO_V118_WEBHOOK_LOG_FILE,
  COMPOSIO_V118_WEBHOOK_PATH,
  ComposioV118WebhookIngester,
  appendComposioV118WebhookLog,
  getComposioV118WebhookLogPath,
  hashComposioV118WebhookBody,
  isComposioV118LoopbackAddress,
  listComposioV118WebhookLog,
  validateComposioV118WebhookLogEntry,
} from './webhookIngestV118';
export type {
  ComposioV118InstanceLookupFn,
  ComposioV118WebhookIngesterOptions,
  ComposioV118WebhookLogEntry,
  ComposioV118WebhookRequest,
  ComposioV118WebhookResult,
  ComposioV118WebhookRoute,
  ComposioV118WebhookSecretFn,
  ComposioV118WebhookTokenFn,
} from './webhookIngestV118';
export {
  COMPOSIO_V114_CHECKPOINTS_FILE,
  JsonFileComposioV114CheckpointStore,
  MemoryComposioV114CheckpointStore,
  getComposioV114CheckpointsPath,
  loadComposioV114CheckpointForSchedule,
} from './pollCheckpointStoreV114';
export type {
  ComposioV114CheckpointStore,
  JsonFileComposioV114CheckpointStoreOptions,
} from './pollCheckpointStoreV114';
// --- v1.19 (Đội T4): mock toolkits v119 — Wrike, BambooHR,
// RingCentral (mock-only, chua live). ---
export {
  COMPOSIO_V119_MOCK_TOOLKITS,
  MockComposioV119Executor,
  createMockComposioV119AppDefinitions,
  executeMockComposioV119Tool,
  findMockComposioV119Toolkit,
  isMockComposioV119Slug,
  mockComposioV119AppId,
  mockComposioV119DeterministicId,
  mockComposioV119Slugs,
  mockComposioV119ToolNeedsApproval,
  resolveMockComposioV119Slug,
  summarizeMockComposioV119Catalogue,
} from './toolkitsV119';
export type { ComposioV119AuthKind, ComposioV119MockToolkitDef, MockComposioV119Result } from './toolkitsV119';
// --- v1.19 (Đội T4): polling v6 — batch + cursor dedup + bounded
// retry, tren engine v5. ---
export {
  COMPOSIO_V119_DEFAULT_BATCH_SIZE,
  COMPOSIO_V119_DEFAULT_DAILY_RETRY_BUDGET,
  COMPOSIO_V119_DEFAULT_MAX_BATCH_ITEMS,
  COMPOSIO_V119_DEFAULT_MAX_RETRIES,
  COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS,
  COMPOSIO_V119_DEFAULT_MAX_SEEN_CURSORS,
  COMPOSIO_V119_DEFAULT_RETRY_BACKOFF_MULTIPLIER,
  COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS,
  COMPOSIO_V119_DEFAULT_RETRY_JITTER_FRACTION,
  COMPOSIO_V119_POLL_STATE_VERSION,
  ComposioV119PollEngine,
  composioV119CanRetry,
  composioV119DayKey,
  composioV119RetriesLeftToday,
  composioV119RetryDelayMs,
  createComposioV119ConnState,
  createComposioV119PollConnBatchState,
  fetchComposioV119Batch,
  fetchComposioV119BatchWithRetry,
  isComposioV119CursorDuplicate,
  pruneComposioV119SeenCursors,
  recordComposioV119SeenCursor,
  rolloverComposioV119RetryBudget,
  validateComposioV119PollBatchConfig,
  validateComposioV119PollConnBatchState,
} from './pollingV119';
export type {
  ComposioV119BatchResult,
  ComposioV119FetchPageFn,
  ComposioV119PollBatchConfig,
  ComposioV119PollConnBatchState,
  ComposioV119PollEngineOptions,
  ComposioV119PollPage,
  ComposioV119SeenCursor,
  ComposioV119TickResult,
} from './pollingV119';
export { DEFAULT_COMPOSIO_V119_POLL_BATCH_CONFIG } from './pollingV119';
// --- v1.19 (Đội T4): trigger instances v2 — vong doi + lich su
// chay (run history). ---
export {
  COMPOSIO_V119_DEFAULT_MAX_RUNS_PER_INSTANCE,
  COMPOSIO_V119_MAX_AUDIT_LINES,
  COMPOSIO_V119_MAX_INSTANCES,
  COMPOSIO_V119_STUCK_RUN_AFTER_MS,
  COMPOSIO_V119_TRIGGER_AUDIT_ACTIONS,
  COMPOSIO_V119_TRIGGER_INSTANCES_FILE,
  COMPOSIO_V119_TRIGGER_INSTANCES_VERSION,
  COMPOSIO_V119_TRIGGER_INSTANCE_AUDIT_FILE,
  COMPOSIO_V119_TRIGGER_LIFECYCLES,
  COMPOSIO_V119_TRIGGER_LIFECYCLE_TRANSITIONS,
  JsonFileComposioV119TriggerInstanceStore,
  MemoryComposioV119TriggerInstanceStore,
  composioV119RunDurationMs,
  countComposioV119RunningRuns,
  createComposioV119TriggerAuditEntry,
  createComposioV119TriggerInstance,
  filterComposioV119TriggerInstances,
  findComposioV119StuckRuns,
  finishComposioV119TriggerRun,
  getComposioV119TriggerInstanceAuditPath,
  getComposioV119TriggerInstancesPath,
  isComposioV119LifecycleTransitionAllowed,
  isComposioV119TriggerInstanceRunnable,
  pruneComposioV119Runs,
  startComposioV119TriggerRun,
  summarizeComposioV119TriggerInstance,
  summarizeComposioV119TriggerInstances,
  summarizeComposioV119TriggerRuns,
  transitionComposioV119TriggerLifecycle,
  validateComposioV119TriggerAuditEntry,
  validateComposioV119TriggerInstance,
  validateComposioV119TriggerRun,
} from './triggerInstancesV119';
export type {
  ComposioV119RegisterTriggerInput,
  ComposioV119RunStatus,
  ComposioV119TriggerAuditAction,
  ComposioV119TriggerAuditEntry,
  ComposioV119TriggerInstance,
  ComposioV119TriggerInstanceFilter,
  ComposioV119TriggerInstanceStore,
  ComposioV119TriggerLifecycle,
  ComposioV119TriggerRun,
} from './triggerInstancesV119';
// --- v1.19 (Đội T4): OAuth refresh v2 — refresh token trong
// Vault, retry co gioi han, rotation, fallback reconnect. ---
export {
  COMPOSIO_V119_DEFAULT_MAX_CONSECUTIVE_FAILURES,
  COMPOSIO_V119_DEFAULT_MAX_REFRESH_ATTEMPTS,
  COMPOSIO_V119_DEFAULT_MAX_REFRESH_RETRY_DELAY_MS,
  COMPOSIO_V119_DEFAULT_REFRESH_BACKOFF_MULTIPLIER,
  COMPOSIO_V119_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
  COMPOSIO_V119_DEFAULT_REFRESH_JITTER_FRACTION,
  COMPOSIO_V119_DEFAULT_REFRESH_RETRY_DELAY_MS,
  COMPOSIO_V119_MAX_REFRESH_AUDIT_ENTRIES,
  COMPOSIO_V119_OAUTH_REFRESH_NAMESPACE,
  attemptComposioV119Refresh,
  composioV119RefreshDelayMs,
  createComposioV119RefreshAuditEntry,
  createComposioV119RefreshState,
  deleteComposioV119RefreshToken,
  hasComposioV119RefreshToken,
  isComposioV119RefreshDue,
  resetComposioV119Refresh,
  setComposioV119RefreshToken,
  summarizeComposioV119Refresh,
  validateComposioV119RefreshAuditEntry,
  validateComposioV119RefreshPolicy,
  validateComposioV119RefreshState,
} from './oauthRefreshV119';
export type {
  ComposioV119RefreshAttempt,
  ComposioV119RefreshAuditEntry,
  ComposioV119RefreshFn,
  ComposioV119RefreshOutcome,
  ComposioV119RefreshPolicy,
  ComposioV119RefreshState,
  ComposioV119RefreshTokenVault,
} from './oauthRefreshV119';
export { DEFAULT_COMPOSIO_V119_REFRESH_POLICY } from './oauthRefreshV119';
// --- v1.19 (Đội T4): webhook v2 — hang doi xu ly + dedup manh +
// retry + dead-letter + replay protection. ---
// (Ghi chu v120: 3 hang retry COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS /
// RETRY_BACKOFF_MULTIPLIER / RETRY_DELAY_MS KHONG export o day nua —
// pollingV119 da export 3 ten nay tu module polling (gia tri khac
// webhook: 1000ms vs 2000ms); export ca hai gay TS2300 duplicate
// identifier o barrel. Gia tri webhook van co trong
// DEFAULT_COMPOSIO_V119_WEBHOOK_CONFIG va import truc tiep tu
// './webhookV119' van dung duoc.)
export {
  COMPOSIO_V119_DEFAULT_CONCURRENCY,
  COMPOSIO_V119_DEFAULT_DEDUPE_WINDOW_MS,
  COMPOSIO_V119_DEFAULT_MAX_ATTEMPTS,
  COMPOSIO_V119_DEFAULT_MAX_DEAD_LETTERS,
  COMPOSIO_V119_DEFAULT_MAX_EVENT_AGE_MS,
  COMPOSIO_V119_DEFAULT_MAX_QUEUE_SIZE,
  COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS as COMPOSIO_V119_WEBHOOK_DEFAULT_MAX_RETRY_DELAY_MS,
  COMPOSIO_V119_DEFAULT_RETRY_BACKOFF_MULTIPLIER as COMPOSIO_V119_WEBHOOK_DEFAULT_RETRY_BACKOFF_MULTIPLIER,
  COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS as COMPOSIO_V119_WEBHOOK_DEFAULT_RETRY_DELAY_MS,
  COMPOSIO_V119_MAX_CONCURRENCY,
  COMPOSIO_V119_WEBHOOK_STATE_VERSION,
  COMPOSIO_V119_WEBHOOK_TOLERANCE_SECONDS,
  ComposioV119WebhookQueue,
  composioV119WebhookRetryDelayMs,
  hashComposioV119WebhookBody,
  parseComposioV119EventTimestamp,
  validateComposioV119QueuedWebhookEvent,
  validateComposioV119WebhookConfig,
} from './webhookV119';
export type {
  ComposioV119DeadLetter,
  ComposioV119QueuedWebhookEvent,
  ComposioV119WebhookAcceptResult,
  ComposioV119WebhookConfig,
  ComposioV119WebhookEventStatus,
  ComposioV119WebhookHandler,
  ComposioV119WebhookQueueOptions,
  ComposioV119WebhookRejectReason,
} from './webhookV119';
export { DEFAULT_COMPOSIO_V119_WEBHOOK_CONFIG } from './webhookV119';
// --- v1.19 (Đội T4): toolkit prefs per-user — bat/tat toolkit
// theo user (mac dinh bat, tang may van thang). ---
export {
  COMPOSIO_V119_MAX_PREFS_AUDIT_LINES,
  COMPOSIO_V119_MAX_PREFS_USERS,
  COMPOSIO_V119_MAX_REASON_CHARS,
  COMPOSIO_V119_MAX_TOOLKITS_PER_USER,
  COMPOSIO_V119_TOOLKIT_PREFS_AUDIT_FILE,
  COMPOSIO_V119_TOOLKIT_PREFS_FILE,
  COMPOSIO_V119_TOOLKIT_PREFS_VERSION,
  JsonFileComposioV119ToolkitPrefsStore,
  MemoryComposioV119ToolkitPrefsStore,
  clearComposioV119ToolkitPref,
  createComposioV119ToolkitPrefsAuditEntry,
  createComposioV119UserToolkitPrefs,
  effectiveComposioV119ToolkitEnabledForUser,
  getComposioV119ToolkitPrefsAuditPath,
  getComposioV119ToolkitPrefsPath,
  isComposioV119ToolkitEnabledForUser,
  listComposioV119EnabledToolkitsForUser,
  setComposioV119ToolkitPref,
  setComposioV119ToolkitPrefsBulk,
  summarizeComposioV119UserToolkitPrefs,
  validateComposioV119ToolkitPref,
  validateComposioV119ToolkitPrefsAuditEntry,
  validateComposioV119UserToolkitPrefs,
} from './toolkitPrefsV119';
export type {
  ComposioV119ToolkitPref,
  ComposioV119ToolkitPrefsAuditEntry,
  ComposioV119ToolkitPrefsStore,
  ComposioV119UserToolkitPrefs,
} from './toolkitPrefsV119';
// --- v1.19 (Đội T4): usage metering — dem luot goi theo
// toolkit/user + quota local + bao cao su dung. ---
export {
  COMPOSIO_V119_DEFAULT_DAILY_CAP_GLOBAL,
  COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_TOOLKIT,
  COMPOSIO_V119_DEFAULT_DAILY_CAP_PER_USER,
  COMPOSIO_V119_DEFAULT_MAX_DAYS_KEPT,
  COMPOSIO_V119_DEFAULT_TOP_N,
  COMPOSIO_V119_USAGE_FILE,
  COMPOSIO_V119_USAGE_VERSION,
  JsonFileComposioV119UsageStore,
  MemoryComposioV119UsageStore,
  buildComposioV119UsageReport,
  checkComposioV119Quota,
  composioV119GlobalCallsToday,
  composioV119ToolkitCallsToday,
  composioV119UsageDayKey,
  composioV119UserCallsToday,
  createComposioV119UsageState,
  getComposioV119UsagePath,
  pruneComposioV119Usage,
  recordComposioV119Usage,
  summarizeComposioV119Usage,
  validateComposioV119Quota,
  validateComposioV119UsageCounter,
  validateComposioV119UsageState,
} from './usageMeteringV119';
export type {
  ComposioV119Quota,
  ComposioV119RecordResult,
  ComposioV119UsageCounter,
  ComposioV119UsageReport,
  ComposioV119UsageState,
  ComposioV119UsageStore,
  ComposioV119UsageTopEntry,
} from './usageMeteringV119';
export { DEFAULT_COMPOSIO_V119_QUOTA } from './usageMeteringV119';
// --- v1.20 (Đội T4): mock toolkits v120 — Trello, FreshBooks,
// Basecamp, QuickBooks (mock-only, chua live). ---
export {
  COMPOSIO_V120_MOCK_TOOLKITS,
  COMPOSIO_V120_MOCK_TOOL_PARAM_NAMES,
  MockComposioV120Executor,
  createMockComposioV120AppDefinitions,
  executeMockComposioV120Tool,
  findMockComposioV120Toolkit,
  isMockComposioV120Slug,
  mockComposioV120AppId,
  mockComposioV120DeterministicId,
  mockComposioV120ParamNames,
  mockComposioV120Slugs,
  mockComposioV120ToolNeedsApproval,
  resolveMockComposioV120Slug,
  summarizeMockComposioV120Catalogue,
} from './toolkitsV120';
export type { ComposioV120AuthKind, ComposioV120MockToolkitDef, MockComposioV120Result } from './toolkitsV120';
// --- v1.20 (Đội T4): OAuth refresh v3 — lich chu dong theo
// toolkit, rotation co grace, phan loai loi, chu ky refresh. ---
export {
  COMPOSIO_V120_DEFAULT_MAX_CONNECTIONS_PER_CYCLE,
  COMPOSIO_V120_DEFAULT_REFRESH_BEFORE_EXPIRY_MS,
  COMPOSIO_V120_DEFAULT_ROTATION_GRACE_MS,
  COMPOSIO_V120_DEFAULT_SCHEDULE_JITTER_MS,
  COMPOSIO_V120_MAX_PREVIOUS_TOKEN_RETRIES,
  COMPOSIO_V120_PREVIOUS_TOKEN_KEY_SUFFIX,
  attemptComposioV120Refresh,
  classifyComposioV120RefreshError,
  composioV120PolicyForToolkit,
  composioV120PreviousTokenKey,
  composioV120RefreshBeforeExpiryMs,
  composioV120RefreshUrgencyMs,
  createComposioV120RefreshState,
  createComposioV120RefreshStatePair,
  deleteComposioV120PreviousRefreshToken,
  hasComposioV120PreviousRefreshToken,
  hashComposioV120ConnectionId,
  purgeComposioV120RefreshTokens,
  resetComposioV120Refresh,
  runComposioV120RefreshCycle,
  setComposioV120PreviousRefreshToken,
  summarizeComposioV120RefreshCycle,
  validateComposioV120RefreshSchedule,
  validateComposioV120RefreshState,
} from './oauthRefreshV120';
export type {
  ComposioV120CycleConnection,
  ComposioV120RefreshConnectionResult,
  ComposioV120RefreshCycleResult,
  ComposioV120RefreshErrorKind,
  ComposioV120RefreshSchedule,
  ComposioV120RefreshState,
} from './oauthRefreshV120';
export { DEFAULT_COMPOSIO_V120_REFRESH_SCHEDULE } from './oauthRefreshV120';
// --- v1.20 (Đội T4): webhook v3 — receiver hardening (signature
// rotation, replay nonce, idempotency key, retry jitter + leo thang). ---
export {
  COMPOSIO_V120_DEFAULT_ESCALATION_AFTER_FAILURES,
  COMPOSIO_V120_DEFAULT_ESCALATION_COOLDOWN_MS,
  COMPOSIO_V120_DEFAULT_IDEMPOTENCY_TTL_MS,
  COMPOSIO_V120_DEFAULT_MAX_FUTURE_SKEW_MS,
  COMPOSIO_V120_DEFAULT_MAX_IDEMPOTENCY_KEYS,
  COMPOSIO_V120_DEFAULT_MAX_NONCES,
  COMPOSIO_V120_DEFAULT_NONCE_WINDOW_MS,
  COMPOSIO_V120_DEFAULT_RETRY_JITTER_FRACTION,
  COMPOSIO_V120_MAX_IDEMPOTENCY_KEY_CHARS,
  COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_FILE,
  COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_VERSION,
  COMPOSIO_V120_WEBHOOK_TOLERANCE_SECONDS,
  ComposioV120WebhookReceiver,
  JsonFileComposioV120IdempotencyStore,
  MemoryComposioV120IdempotencyStore,
  checkComposioV120TimestampSkew,
  getComposioV120IdempotencyPath,
  normalizeComposioV120IdempotencyKey,
  summarizeComposioV120WebhookReceiver,
  validateComposioV120IdempotencyEntry,
  validateComposioV120WebhookConfig,
  verifyComposioV120WebhookSignatureWithRotation,
} from './webhookV120';
export type {
  ComposioV120IdempotencyEntry,
  ComposioV120IdempotencyStore,
  ComposioV120WebhookAcceptResult,
  ComposioV120WebhookConfig,
  ComposioV120WebhookEscalation,
  ComposioV120WebhookReceiverOptions,
  ComposioV120WebhookRejectReason,
  ComposioV120WebhookSecret,
} from './webhookV120';
export { DEFAULT_COMPOSIO_V120_WEBHOOK_CONFIG } from './webhookV120';
// --- v1.20 (Đội T4): toolkit prefs v2 — bat/tat theo action +
// default params + quota view cho UI. ---
export {
  COMPOSIO_V120_MAX_ACTIONS_PER_TOOLKIT,
  COMPOSIO_V120_MAX_DEFAULT_PARAMS_PER_ACTION,
  COMPOSIO_V120_MAX_DEFAULT_PARAM_VALUE_CHARS,
  COMPOSIO_V120_MAX_PREFS_AUDIT_LINES,
  COMPOSIO_V120_MAX_PREFS_USERS,
  COMPOSIO_V120_MAX_TOOLKITS_PER_USER,
  COMPOSIO_V120_TOOLKIT_PREFS_AUDIT_FILE,
  COMPOSIO_V120_TOOLKIT_PREFS_FILE,
  COMPOSIO_V120_TOOLKIT_PREFS_VERSION,
  JsonFileComposioV120ToolkitPrefsStore,
  MemoryComposioV120ToolkitPrefsStore,
  assertKnownComposioV120ActionSlug,
  buildComposioV120ToolkitQuotaViews,
  clearComposioV120DefaultParams,
  clearComposioV120ToolkitPref,
  createComposioV120ToolkitPrefsAuditEntry,
  createComposioV120UserToolkitPrefs,
  effectiveComposioV120ActionEnabledForUser,
  getComposioV120DefaultParams,
  getComposioV120ToolkitPref,
  getComposioV120ToolkitPrefsAuditPath,
  getComposioV120ToolkitPrefsPath,
  isComposioV120ActionEnabledForUser,
  isComposioV120ToolkitEnabledForUser,
  isKnownComposioV120ActionSlug,
  knownComposioV120ActionSlugs,
  listComposioV120EnabledActionsForUser,
  resolveComposioV120CallParams,
  setComposioV120ActionPref,
  setComposioV120ActionPrefsBulk,
  setComposioV120DefaultParams,
  setComposioV120ToolkitPref,
  summarizeComposioV120UserToolkitPrefs,
  validateComposioV120ActionPref,
  validateComposioV120DefaultParamValue,
  validateComposioV120DefaultParams,
  validateComposioV120ToolkitPref,
  validateComposioV120ToolkitPrefsAuditEntry,
  validateComposioV120UserToolkitPrefs,
} from './toolkitPrefsV120';
export type {
  ComposioV120ActionPref,
  ComposioV120ToolkitPref,
  ComposioV120ToolkitPrefsAuditAction,
  ComposioV120ToolkitPrefsAuditEntry,
  ComposioV120ToolkitPrefsStore,
  ComposioV120ToolkitQuotaView,
  ComposioV120UserToolkitPrefs,
} from './toolkitPrefsV120';
// --- v1.20 (Đội T4): usage metering v2 — dem theo action +
// soft-limit + canh bao + quota theo user. ---
export {
  COMPOSIO_V120_DEFAULT_ALERT_AT,
  COMPOSIO_V120_DEFAULT_MAX_DAYS_KEPT,
  COMPOSIO_V120_DEFAULT_MAX_WARNINGS,
  COMPOSIO_V120_DEFAULT_TOP_N,
  COMPOSIO_V120_DEFAULT_WARN_AT,
  COMPOSIO_V120_USAGE_FILE,
  COMPOSIO_V120_USAGE_VERSION,
  JsonFileComposioV120UsageStore,
  MemoryComposioV120UsageStore,
  buildComposioV120UsageReport,
  checkComposioV120SoftLimits,
  composioV120ActionCallsToday,
  composioV120SoftLimitStatus,
  createComposioV120UsageState,
  effectiveComposioV120QuotaForUser,
  getComposioV120UsagePath,
  pruneComposioV120Usage,
  recordComposioV120Usage,
  setComposioV120PerUserQuota,
  summarizeComposioV120Usage,
  toComposioV119UsageState,
  validateComposioV120ActionCounter,
  validateComposioV120SoftLimitThresholds,
  validateComposioV120UsageState,
  validateComposioV120UsageWarning,
} from './usageMeteringV120';
export type {
  ComposioV120ActionCounter,
  ComposioV120RecordResult,
  ComposioV120SoftLimitSeverity,
  ComposioV120SoftLimitStatus,
  ComposioV120SoftLimitThresholds,
  ComposioV120UsageReport,
  ComposioV120UsageState,
  ComposioV120UsageStore,
  ComposioV120UsageWarning,
} from './usageMeteringV120';
export { DEFAULT_COMPOSIO_V120_SOFT_LIMIT_THRESHOLDS } from './usageMeteringV120';

// v1.29 (Đội T4): Composio v6 — mock toolkits smartsheet/servicenow/
// klaviyo/onedrive, background long jobs, job polling (backoff +
// timeout + cancel), per-conversation sandbox boundary, app bindings.
export {
  COMPOSIO_V129_MOCK_TOOLKITS,
  COMPOSIO_V129_MOCK_TOOL_PARAM_NAMES,
  MockComposioV129Executor,
  createMockComposioV129AppDefinitions,
  executeMockComposioV129Tool,
  findMockComposioV129Toolkit,
  isMockComposioV129Slug,
  mockComposioV129AppId,
  mockComposioV129DeterministicId,
  mockComposioV129ParamNames,
  mockComposioV129Slugs,
  mockComposioV129ToolNeedsApproval,
  resolveMockComposioV129Slug,
  summarizeMockComposioV129Catalogue,
  validateMockComposioV129Params,
} from './toolkitsV129';
export type { ComposioV129AuthKind, ComposioV129MockToolkitDef, MockComposioV129Result } from './toolkitsV129';
export {
  COMPOSIO_V129_JOB_CHECKPOINT_VERSION,
  COMPOSIO_V129_TERMINAL_JOB_STATUSES,
  DEFAULT_COMPOSIO_V129_JOB_CONFIG,
  MemoryComposioV129JobStore,
  advanceComposioV129Job,
  checkComposioV129JobTimeout,
  composioV129JobElapsedMs,
  composioV129JobId,
  composioV129JobNeedsApproval,
  composioV129JobProgress,
  composioV129JobTimeLeftMs,
  createComposioV129Job,
  failComposioV129Job,
  isComposioV129TerminalJobStatus,
  listComposioV129Jobs,
  parseComposioV129Job,
  requestComposioV129JobCancel,
  resolveComposioV129JobConfig,
  serializeComposioV129Job,
  summarizeComposioV129Job,
  summarizeComposioV129Jobs,
  validateComposioV129Job,
  validateComposioV129JobConfig,
} from './longJobsV129';
export type {
  ComposioV129AdvanceResult,
  ComposioV129CreateJobInput,
  ComposioV129JobConfig,
  ComposioV129JobFilter,
  ComposioV129JobStatus,
  ComposioV129LongJob,
  ComposioV129StepFn,
} from './longJobsV129';
export {
  COMPOSIO_V129_POLL_SCHEDULE_VERSION,
  DEFAULT_COMPOSIO_V129_POLL_POLICY,
  composioV129Hash32,
  composioV129MsUntilNextPoll,
  composioV129NextPollDelayMs,
  composioV129PollDelayMs,
  composioV129PollDelayTable,
  composioV129PollJitterMs,
  createComposioV129PollSchedule,
  isComposioV129PollDue,
  parseComposioV129PollSchedule,
  pollComposioV129JobOnce,
  pollComposioV129JobsBatch,
  resolveComposioV129PollPolicy,
  serializeComposioV129PollSchedule,
  updateComposioV129PollSchedule,
  validateComposioV129PollPolicy,
  validateComposioV129PollSchedule,
} from './jobPollingV129';
export type {
  ComposioV129PollOnceResult,
  ComposioV129PollOutcome,
  ComposioV129PollPolicy,
  ComposioV129PollSchedule,
} from './jobPollingV129';
export {
  COMPOSIO_V129_SANDBOX_MAX_AUDIT_ENTRIES,
  COMPOSIO_V129_SANDBOX_VERSION,
  DEFAULT_COMPOSIO_V129_SANDBOX_LIMITS,
  MemoryComposioV129SandboxStore,
  admitComposioV129SandboxCall,
  composioV129SandboxId,
  composioV129SandboxNeedsApproval,
  createComposioV129SandboxBoundary,
  filterComposioV129SandboxAudit,
  isComposioV129SandboxExpired,
  isComposioV129ToolkitAllowed,
  parseComposioV129SandboxBoundary,
  recordComposioV129SandboxCall,
  recordComposioV129SandboxDenial,
  recordComposioV129SandboxJobFinished,
  resolveComposioV129SandboxLimits,
  serializeComposioV129SandboxBoundary,
  summarizeComposioV129Sandbox,
  validateComposioV129SandboxBoundary,
  validateComposioV129SandboxLimits,
} from './sandboxV129';
export type {
  ComposioV129AdmitResult,
  ComposioV129SandboxAuditAction,
  ComposioV129SandboxAuditEntry,
  ComposioV129SandboxBoundary,
  ComposioV129SandboxCall,
  ComposioV129SandboxCallKind,
  ComposioV129SandboxLimits,
  ComposioV129SandboxUsage,
  ComposioV129CreateSandboxInput,
} from './sandboxV129';
export {
  COMPOSIO_V129_BINDINGS_MAX_AUDIT_ENTRIES,
  COMPOSIO_V129_BINDINGS_VERSION,
  MemoryComposioV129BindingStore,
  checkComposioV129AppBinding,
  composioV129BindingId,
  composioV129ScopeForSlug,
  composioV129ScopesCover,
  createComposioV129AppBinding,
  defaultComposioV129MachineBindings,
  listComposioV129EffectiveApps,
  resolveComposioV129EffectiveParams,
  summarizeComposioV129Bindings,
  validateComposioV129AppBinding,
  validateComposioV129BindingDefaultParams,
} from './appBindingsV129';
export type {
  ComposioV129AppBinding,
  ComposioV129AppScope,
  ComposioV129BindAppInput,
  ComposioV129BindingAuditAction,
  ComposioV129BindingAuditEntry,
  ComposioV129BindingCheck,
} from './appBindingsV129';
