/**
 * Agent Teams v2 — public exports (v1.10, Đội T3).
 *
 * Shared task list với file-locked claiming (lock + lease +
 * heartbeat), mailbox disk peer-to-peer theo tên (inbox/outbox
 * bền vững + xác nhận đã đọc), vai lead/worker (lead spawn/giao
 * task/tổng hợp, worker chỉ làm task được giao, session/context
 * riêng), fork subagent (context riêng + merge kết quả, giới hạn
 * độ sâu + song song), hook TaskCompleted (exit 2 = giữ task mở
 * kèm feedback), giới hạn team 3–5 + cảnh báo chi phí token.
 */

export {
  ABSOLUTE_MAX_CONCURRENT_FORKS,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT_FORKS,
  DEFAULT_MAX_FORK_DEPTH,
  DEFAULT_TEAM_TOKEN_BUDGET,
  DEFAULT_TOKEN_WARN_RATIO,
  MAX_DISK_MAILBOX_PER_BOX,
  RECOMMENDED_MAX_TEAMMATES,
  RECOMMENDED_MIN_TEAMMATES,
  TEAMS_V2_DIR,
  TEAM_V2_STATE_FILE,
  defaultTeamV2Config,
  defaultTeamV2State,
  slugifyTeammateName,
  validateTeamV2Config,
} from './types';
export type {
  ClaimLock,
  ClaimLockResult,
  DiskMailboxBox,
  DiskMailboxMessage,
  ForkMergeResult,
  ForkNode,
  ForkStatus,
  ReviewFeedback,
  TaskAssignment,
  TaskCompletedHookInput,
  TaskCompletedHookResult,
  TeamAggregateReport,
  TeamCostEstimate,
  TeamSizeCheck,
  TeamV2Config,
  TeamV2Dashboard,
  TeamV2State,
  TeammateSession,
} from './types';

export {
  acquireClaimLock,
  findStaleClaimLocks,
  getClaimLock,
  heartbeatClaimLock,
  isLockStale,
  listClaimLocks,
  lockFilePath,
  readLockFile,
  reclaimStaleClaimLock,
  releaseClaimLock,
  teamLocksDir,
} from './claimLock';

export {
  diskUnreadByName,
  markDiskInboxRead,
  markDiskMessageRead,
  readDiskInbox,
  readDiskMailboxBox,
  readDiskOutbox,
  recentDiskMessages,
  sendDiskMessage,
  teamMailboxDir,
  teammateMailboxDir,
  validateDiskMessage,
} from './diskMailbox';
export type { DiskMailboxResult, SendDiskMessageInput } from './diskMailbox';

export {
  addAssignedTaskToSession,
  appendSessionNote,
  closeTeammateSession,
  createTeammateSession,
  isSessionOpen,
  listTeammateSessions,
  readTeammateSession,
  removeAssignedTaskFromSession,
  sessionFilePath,
  teamSessionsDir,
} from './sessions';
export type { SessionResult } from './sessions';

export {
  childForks,
  completeFork,
  countForksByStatus,
  createFork,
  failFork,
  forkDepthOf,
  forksForTask,
  mergeFork,
  runningForkCount,
  runningForksByTeammate,
  summarizeForksForParent,
  unmergedForks,
  validateSpawnFork,
} from './fork';
export type { ForkLimits, ForkResult, SpawnForkInput } from './fork';

export {
  checkTeamSize,
  defaultTokenBudget,
  defaultTokenWarnRatio,
  estimateTeamTokens,
  normalizeCostInputs,
} from './cost';
export type { CostInputs } from './cost';

export {
  TASK_COMPLETED_HOLD_EXIT_CODE,
  TASK_COMPLETED_HOOK_EVENT_ENV,
  defaultTaskCompletedHookRunner,
  interpretHookResult,
  lastNonEmptyLine,
  runTaskCompletedHook,
} from './taskCompletedHook';
export type { TaskCompletedHookRunner } from './taskCompletedHook';

export {
  aggregateTeamResults,
  assignTaskToTeammate,
  assignmentForTask,
  assignmentsForTeammate,
  canClaimAssignedTask,
  clearAssignmentForTask,
  idleWorkers,
  unassignTask,
  unassignedPendingTasks,
} from './leadWorker';
export type { LeadWorkerResult } from './leadWorker';

export { TeamV2Store, teamV2Dir, teamV2StatePath } from './stateStore';

export { TeamServiceV2 } from './serviceV2';
export type {
  CompleteTaskV2Result,
  CreateTeamV2Input,
  RequeueResult,
  TeamServiceV2Result,
} from './serviceV2';

export { buildTeamV2Dashboard } from './dashboard';
