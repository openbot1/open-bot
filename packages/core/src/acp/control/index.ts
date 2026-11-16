/**
 * ACP Control Center (v1.12, Team T4) — public surface of
 * `packages/core/src/acp/control/`.
 *
 * A control plane over external CLI agents (Claude Code, Codex,
 * Gemini CLI, OpenCode, ...): discover them on the machine, register
 * them as managed agents, start/stop them through their own CLI
 * login, cap them with budgets, and record their usage. Builds only
 * on the existing ACP stack (`acp/backends`, `acp/detect`,
 * `acp/externalAgent`, `detected/`); no credential is ever read,
 * copied, or sent anywhere.
 */

export {
  AcpControlAlertStore,
  CONTROL_ALERTS_FILENAME,
  CONTROL_ALERTS_MAX,
} from './alerts';
export type { AlertStoreOptions, AcpControlBudgetAlert, AcpControlBudgetAlertKind } from './alerts';

export {
  buildAcpControlAgentView,
  buildAcpControlReport,
  buildAcpControlSnapshot,
  toAcpControlDiscoveredView,
  toAcpControlTurnView,
} from './views';
export type {
  AcpControlAgentSnapshot,
  AcpControlDiscoveredSnapshot,
  AcpControlReportSnapshot,
  AcpControlSnapshot,
  AcpControlTurnSnapshot,
} from './views';

export {
  AcpControlCenter,
  AcpControlError,
  CONTROL_AGENTS_FILENAME,
  extractUsageNumbers,
} from './manager';
export type {
  AcpControlCenterOptions,
  AcpControlErrorCode,
  PromptTurnResult,
  RegisterAgentInput,
} from './manager';

export { discoverControlCenterAgents, getControlBackend, BACKEND_TO_DETECTED_KIND } from './discovery';
export type { DetectedLoginSnapshot, DiscoverOptions, DiscoveryDeps, LoginInfo } from './discovery';

export {
  AcpControlUsageStore,
  CONTROL_USAGE_FILENAME,
  CONTROL_USAGE_MAX_TURNS,
  summarizeTurns,
} from './usageStore';
export type { ControlUsageFile, RecordTurnInput, UsageStoreOptions } from './usageStore';

export {
  BUDGET_DIMENSION_LABELS,
  applyBudgetPatch,
  evaluateBudget,
  evaluateBudgetEmpty,
  evaluateDimension,
  formatWallMs,
  validateBudget,
} from './budgets';

export {
  DEFAULT_BUDGET_WARN_FRACTION,
  defaultBudget,
  emptyUsageSummary,
  localDay,
} from './types';
export type {
  AgentBudget,
  AgentUsageDay,
  AgentUsageReport,
  AgentUsageSummary,
  AgentUsageTurn,
  BudgetDimensionState,
  BudgetEvaluation,
  ControlCenterBackendId,
  ControlCenterEvent,
  ControlCenterEventListener,
  ControlCenterLoginMethod,
  DiscoveredControlAgent,
  ManagedAgentRecord,
  ManagedAgentStatus,
  ManagedAgentView,
} from './types';
