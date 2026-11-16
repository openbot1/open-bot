/**
 * @open-bot/core automations — public surface for the automations module.
 * (v0.4; imported directly as `@open-bot/core/dist/automations/index.js`
 * until the core barrel `src/index.ts` gains these exports — see
 * docs/v04-worker2-integration.md.)
 */

export type {
  Automation,
  AutomationAccessPolicy,
  AutomationAction,
  AutomationCondition,
  AutomationEvent,
  AutomationEventKind,
  AutomationHandlers,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationTriggerPresentation,
  AutomationCronWindow,
} from './types';

export {
  automationDue,
  buildTriggerPresentation,
  cronMatches,
  describeTrigger,
  evaluateCondition,
  executeAutomation,
  getTriggerDescription,
  getTriggerPresentation,
  globMatch,
  isValidCronExpression,
  MAX_AUTOMATION_OUTPUT_CHARS,
  MAX_TRIGGER_INPUT_CHARS,
  nextCronOccurrence,
  nextRunAtFor,
  parseCronExpression,
  validateAutomation,
  validateForEnable,
} from './engine';
export type { CronFields, ExecuteAutomationOptions, ValidateForEnableOptions } from './engine';

export {
  computeWebhookSignature,
  handleWebhookDelivery,
  applyTriggerInputToAction,
  parseWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
} from './webhook';
export type { WebhookDeliveryOptions } from './webhook';

export {
  AUTOMATION_WEBHOOK_KEYS_NAMESPACE,
  createAutomationWebhookKey,
  deleteAutomationWebhookKey,
  getAutomationWebhookKey,
  hasAutomationWebhookKey,
  migrateAutomationWebhookKey,
  rotateAutomationWebhookKey,
} from './webhookKeys';
export type {
  AutomationWebhookKey,
  AutomationWebhookKeyStore,
  AutomationWebhookKeyStores,
  AutomationWebhookKeyStoreInput,
  DedicatedWebhookKeyStore,
} from './webhookKeys';

export {
  AUTOMATION_POLICY_ACTIONS,
  automationAccessAllows,
  automationPolicyDeniedMessage,
  canAutomationAction,
  createRolePolicyChecker,
  viewerAutomationCapabilities,
} from './policy';
export type {
  AutomationPolicyAction,
  AutomationPolicyChecker,
  AutomationPolicyCheckOptions,
  AutomationPolicyContext,
} from './policy';

export {
  AutomationScheduler,
  JsonFileAutomationStore,
  AUTOMATIONS_FILE,
  DEFAULT_EVENT_COOLDOWN_MS,
  MAX_RUN_HISTORY,
  missedGraceMs,
} from './scheduler';
export type { AutomationSchedulerOptions, AutomationStore, SeedSampleAutomationsResult, SkippedRunInfo, SlackInboundResult } from './scheduler';

export {
  buildDreamPrompt,
  DreamEngine,
  DEFAULT_DREAM_HISTORY_LIMIT,
  DEFAULT_DREAM_IDLE_MINUTES,
} from './dream';
export type { DreamConfig, DreamEngineOptions, DreamResult, DreamSkipReason } from './dream';

export { SAMPLE_AUTOMATIONS, sampleAutomations } from './samples';

// v1.12 (Đội T6): automations v2 — trigger time/file/webhook-local,
// điều kiện cây, action chain, run log bền.
export {
  AUTOMATIONS_V2_FILE,
  AUTOMATIONS_V2_MAX_AUTOMATIONS,
  AUTOMATIONS_V2_MAX_RUNS,
  AUTOMATIONS_V2_RUNS_FILE,
  AUTOMATION_V2_COMPARE_OPS,
  AUTOMATION_V2_DEFAULT_COOLDOWN_MS,
  AUTOMATION_V2_FILE_EVENT_KINDS,
  AUTOMATION_V2_MAX_STEPS,
  AUTOMATION_V2_MAX_WAIT_MS,
  AUTOMATION_V2_STEP_KINDS,
  AUTOMATION_V2_TRIGGER_KINDS,
  appendAutomationV2Run,
  automationV2EventPayload,
  automationV2InCooldown,
  automationV2TriggerMatches,
  createAutomationV2,
  describeAutomationV2Event,
  dryRunAutomationV2,
  evaluateAutomationV2Condition,
  executeAutomationV2,
  findAutomationV2,
  getAutomationV2Field,
  getAutomationsV2Path,
  getAutomationsV2RunsPath,
  listAutomationV2Runs,
  loadAutomationsV2,
  nextRunForAutomationV2,
  pruneAutomationV2Runs,
  removeAutomationV2,
  renderAutomationV2Args,
  renderAutomationV2Template,
  saveAutomationsV2,
  setAutomationV2Enabled,
  signAutomationV2WebhookDelivery,
  summarizeAutomationV2Runs,
  validateAutomationV2,
  validateAutomationV2Condition,
  validateAutomationV2Trigger,
  verifyAutomationV2WebhookDelivery,
} from './automationsV2';
export type {
  AutomationV2,
  AutomationV2ActionStep,
  AutomationV2CompareOp,
  AutomationV2Condition,
  AutomationV2Event,
  AutomationV2FileEventKind,
  AutomationV2Handlers,
  AutomationV2RunLogEntry,
  AutomationV2RunStatus,
  AutomationV2StepOnError,
  AutomationV2StepResult,
  AutomationV2StepStatus,
  AutomationV2Trigger,
  CreateAutomationV2Input,
  ExecuteAutomationV2Options,
} from './automationsV2';
