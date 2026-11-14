/**
 * Tầng fleet đa người dùng — public surface của
 * `packages/core/src/fleet/` (đội D).
 *
 * - registry.ts: đăng ký workspace (`fleet.json`, atomic).
 * - audit.ts: audit chuỗi hash (`fleet.jsonl`) + decision log
 *   (`decisions.jsonl`).
 * - capacity.ts: kiểm tra sức chứa máy (tái dùng probe/planner
 *   của compute — luôn chừa headroom cho host).
 * - isolation.ts: cô lập đường dẫn/vault/OS user (fail-closed).
 * - service.ts + serviceWorker.ts: vòng đời service theo workspace
 *   (chỉ bind 127.0.0.1, health check cần token trong bộ nhớ).
 * - usage.ts: usage ledger (`usage.jsonl`) + đo CPU/RAM/đĩa thật.
 * - manager.ts: FleetManager điều phối toàn bộ.
 * Xem types.ts (nguyên tắc trung thực) và docs/fleet.md.
 */
export {
  FLEET_AUDIT_FILE,
  FLEET_DECISIONS_FILE,
  appendFleetAuditEvent,
  appendFleetDecision,
  getFleetAuditPath,
  getFleetDecisionsPath,
  listFleetAuditEvents,
  listFleetDecisions,
  readFleetAuditEvents,
  readFleetDecisions,
  verifyFleetAuditLog,
  verifyFleetDecisionLog,
} from './audit';
export { checkFleetCapacity, sumAllocatedFleetResources } from './capacity';
export {
  FLEET_AUTO_PORT_MAX,
  FLEET_AUTO_PORT_MIN,
  FLEET_MIN_CPU_CORES,
  FLEET_MIN_DISK_BYTES,
  FLEET_MIN_RAM_BYTES,
  FLEET_REGISTRY_FILE,
  createFleetWorkspace,
  findFleetWorkspace,
  getFleetRegistryPath,
  loadFleetWorkspaces,
  pickFreePort,
  removeFleetWorkspace,
  renameFleetWorkspace,
  saveFleetWorkspaces,
  setFleetWorkspaceStatus,
  updateFleetWorkspace,
  validateFleetWorkspace,
  validateFleetWorkspaces,
} from './registry';
export {
  assertWorkspaceRootInsideFleet,
  currentOsUser,
  fleetVaultKey,
  fleetVaultNamespace,
  getOsUserUid,
  isRunningPrivileged,
  probeOsUser,
  readWorkspaceFile,
  resolveIsolationLevel,
  resolveFleetWorkspacePath,
  writeWorkspaceFile,
} from './isolation';
export { FleetManager } from './manager';
export type { FleetManagerOptions } from './manager';
export {
  FLEET_SERVICE_HEALTH_TIMEOUT_MS,
  FLEET_SERVICE_MAX_RESTARTS,
  FLEET_SERVICE_READY_TIMEOUT_MS,
  FLEET_SERVICE_RESTART_BACKOFF_MS,
  FLEET_SERVICE_STOP_TIMEOUT_MS,
  FleetServiceManager,
} from './service';
export type { FleetServiceManagerOptions, FleetServiceStatus } from './service';
export type {
  CreateFleetWorkspaceInput,
  FleetCapacityCheck,
  FleetCapacityPolicy,
  FleetDecision,
  FleetIsolationLevel,
  FleetMember,
  FleetRole,
  FleetServiceState,
  FleetStatusView,
  FleetUsageSample,
  FleetUsageSummary,
  FleetWorkspace,
  FleetWorkspaceStatus,
  NewFleetDecisionInput,
} from './types';
export { FLEET_ROLES } from './types';
export {
  FLEET_CONSOLE_ACTIONS,
  FLEET_CONSOLE_PERMISSIONS,
  FLEET_CONSOLE_ROLES,
  FLEET_CONSOLE_USERS_FILE,
  FleetConsole,
  assertCanPerform,
  buildFleetBotOverview,
  canPerform,
  getFleetConsoleUsersPath,
  loadFleetConsoleUsers,
  saveFleetConsoleUsers,
  validateFleetConsoleUser,
} from './console';
export type {
  AddFleetConsoleUserInput,
  FleetBotOverview,
  FleetConsoleAction,
  FleetConsoleRole,
  FleetConsoleUser,
} from './console';
// v1.03 (Team T6): fleet overview + scheduler v3.
export {
  DEFAULT_FLEET_SCHEDULING_POLICY,
  FLEET_SCHEDULE_FILE,
  FLEET_SCHEDULING_STRATEGIES,
  cancelPlacement,
  claimPlacement,
  enqueuePlacement,
  getFleetSchedulePath,
  listWaitingPlacements,
  loadScheduleQueue,
  planPlacement,
  saveScheduleQueue,
  scoreWorkspaceForPlacement,
  validatePlacementRequest,
  validateQueuedPlacement,
  validateSchedulingPolicy,
} from './scheduling';
export type {
  FleetPlacementRequest,
  FleetSchedulingPolicy,
  FleetSchedulingStrategy,
  PlacementCandidate,
  PlacementFit,
  PlacementPlan,
  QueuedPlacement,
} from './scheduling';
export type { EnqueuePlacementInput } from './scheduling';
export {
  buildFleetOverview,
  fleetTotalSeries,
  forecastResource,
  linearGrowthPerDay,
} from './overview';
export type {
  FleetCapacityForecast,
  FleetOverview,
  FleetResourceTotals,
  FleetTopConsumer,
} from './overview';
export {
  FLEET_QUOTAS_FILE,
  QUOTA_DEFAULT_WARN_PERCENT,
  QUOTA_MAX_ALERTS,
  checkBotQuotas,
  cpuRateFromSamples,
  evaluateBotQuota,
  getBotQuota,
  getFleetQuotasPath,
  loadBotQuotas,
  removeBotQuota,
  saveBotQuotas,
  setBotQuota,
  summarizeBotUsage,
  validateBotQuota,
} from './quotas';
export type {
  BotQuota,
  BotUsageSnapshot,
  BotUsageStats,
  QuotaAlert,
  QuotaEvaluation,
  QuotaLevel,
  QuotaResource,
  QuotaResourceStatus,
  SetBotQuotaInput,
} from './quotas';
export {
  USAGE_DISK_MAX_FILES,
  USAGE_FILE,
  USAGE_MAX_SAMPLES_PER_WORKSPACE,
  getUsagePath,
  measureDiskUsage,
  measureProcessUsage,
  measureWorkspaceUsage,
  pruneUsageLedger,
  readUsageSamples,
  readUsageSamplesFor,
  recordUsageSample,
  summarizeUsage,
  validateUsageSample,
} from './usage';
// v1.04 (Team T6): multi-machine nodes + dispatch v2 (work stealing).
export {
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_NODE_TTL_MS,
  FLEET_NODES_FILE,
  FLEET_NODE_ROLES,
  detectDeadNodes,
  findFleetNode,
  getFleetNodesPath,
  isLoopbackHost,
  isPrivateOrLoopbackHost,
  listFleetNodeViews,
  loadFleetNodes,
  nodeLiveness,
  pickBestNode,
  pruneDeadNodes,
  recordNodeHeartbeat,
  registerFleetNode,
  removeFleetNode,
  saveFleetNodes,
  scoreNodeForDispatch,
  validateNodeLoad,
  validateRegisterNodeInput,
  viewFleetNode,
} from './nodes';
export type {
  FleetNode,
  FleetNodeDispatchRequest,
  FleetNodeLiveness,
  FleetNodeLoad,
  FleetNodeRole,
  FleetNodeScore,
  FleetNodeView,
  RegisterFleetNodeInput,
} from './nodes';
export {
  DEFAULT_IDLE_JOB_THRESHOLD,
  DEFAULT_MAX_JOB_ATTEMPTS,
  DEFAULT_STEAL_CPU_THRESHOLD,
  DEFAULT_STEAL_POLICY,
  DEFAULT_STEAL_QUEUE_THRESHOLD,
  FLEET_DISPATCH_FILE,
  FLEET_JOB_KINDS,
  cancelJob,
  claimJob,
  completeJob,
  dispatchJob,
  failJob,
  findFleetJob,
  findStealableJobs,
  getFleetDispatchPath,
  isNodeBusyForStealing,
  isNodeIdleForStealing,
  listFleetJobs,
  loadFleetJobs,
  reassignDeadNodeJobs,
  saveFleetJobs,
  stealWork,
  submitJob,
  summarizeDispatch,
  validateJobResources,
  validateSubmitJobInput,
} from './dispatch';
export type {
  DispatchResult,
  FleetDispatchSummary,
  FleetJob,
  FleetJobHistoryEntry,
  FleetJobKind,
  FleetJobStatus,
  StealPolicy,
  SubmitFleetJobInput,
} from './dispatch';
// v1.04 (Team T6): node HTTP client (health probe + job fetch/report).
export {
  DEFAULT_NODE_CLIENT_TIMEOUT_MS,
  FleetNodeClient,
  NODE_CLIENT_USER_AGENT,
  nodeBaseUrl,
  validateNodeAssignedJob,
  validateNodeEndpoint,
} from './nodeClient';
export type {
  FleetNodeClientOptions,
  NodeAssignedJob,
  NodeFetch,
  NodeHealthProbe,
  NodeJobsResult,
  NodeReportResult,
} from './nodeClient';
// v1.05 (Team T6): fleet policy v4 + orchestration v4 (priority task
// queue, affinity/capability/load scheduling, health + auto-restart,
// shared memory blocks via SharedBlockGroupStore).
export {
  DEFAULT_FLEET_POLICY_V4,
  FLEET_POLICY_V4_FILE,
  FLEET_TASK_PRIORITIES,
  canAutoRestartBot,
  canStartAnotherBot,
  checkBotTokenQuota,
  enforceFleetPolicy,
  getFleetPolicyV4Path,
  loadFleetPolicyV4,
  saveFleetPolicyV4,
  validateFleetPolicyV4,
} from './policy';
export type {
  FleetPolicySnapshot,
  FleetPolicyV4,
  FleetPolicyViolation,
  FleetTaskPriority,
} from './policy';
// v1.05 (Team T6): fleet task templates v4 (recurring tasks).
export {
  FLEET_TASK_TEMPLATES_FILE,
  advanceFleetTaskTemplate,
  createFleetTaskTemplate,
  dueFleetTaskTemplates,
  instantiateFleetTaskTemplate,
  isFleetTaskTemplateDue,
  listFleetTaskTemplates,
  removeFleetTaskTemplate,
  setFleetTaskTemplateEnabled,
  validateFleetTaskTemplate,
} from './taskTemplates';
export type {
  CreateFleetTaskTemplateInput,
  FleetTaskTemplate,
} from './taskTemplates';
export {
  FLEET_BOT_HEALTHS,
  FLEET_DEGRADED_LATENCY_MS,
  FLEET_MAX_DECISIONS_IN_MEMORY,
  FLEET_SCHEDULING_DECISIONS_FILE,
  FLEET_TASKS_V4_FILE,
  FLEET_TASK_STATUSES,
  FleetOrchestrator,
  MockBotHealthProbe,
  MockBotLifecycle,
  validateFleetTaskV4,
} from './orchestration';
export type {
  BotHealthProbe,
  BotHealthProbeResult,
  BotLifecycle,
  FleetBotHealth,
  FleetBotNode,
  FleetBotScore,
  FleetHealthReport,
  FleetHealthSummary,
  FleetOrchestratorOptions,
  FleetSchedulingDecision,
  FleetSchedulingResult,
  FleetTaskStatus,
  FleetTaskV4,
  SubmitFleetTaskInput,
} from './orchestration';
