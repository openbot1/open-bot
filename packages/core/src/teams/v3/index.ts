/**
 * Agent Teams v3 — public exports (v1.11, Đội T3).
 *
 * Đúng 7 primitives (TeamCreate/Task/SendMessage/lifecycle 3 trạng
 * thái/file-lock/dependency waves/lead control) + shared task list
 * file-locked + teammate messaging trực tiếp + challenge kết luận +
 * lead delegate/implement mode + pane tmux + agent-view background
 * sessions + chi phí token tuyến tính + giới hạn 1 team/session,
 * cấm team con, 2 teammate không sửa cùng file.
 *
 * Xây trên v2 (không viết lại): TeamServiceV3 bọc TeamServiceV2.
 */

export {
  MAX_PANE_LOG_LINES,
  MAX_TEAM_CHALLENGES,
  MAX_TEAM_CONVERSATION_ENTRIES,
  TEAMS_V3_DIR,
  TEAM_V3_PRIMITIVES,
  TEAM_V3_PRIMITIVE_DESCRIPTIONS,
  TEAM_V3_SESSIONS_FILE,
  TEAM_V3_STATE_FILE,
  V3_BASE_SESSION_TOKENS,
  V3_RECOMMENDED_MAX_TEAMMATES,
  V3_RECOMMENDED_MIN_TEAMMATES,
  V3_TOKENS_PER_MESSAGE,
  V3_TOKENS_PER_TASK,
  V3_TOKENS_PER_TEAMMATE,
  autoPaneColumns,
  defaultTeamV3Config,
  defaultTeamV3State,
  isValidV3Transition,
  leadModeLabel,
  panePosition,
  v3OutcomeOf,
  v3StateLabel,
  v3StateOf,
  validateTeamV3Config,
} from './types';
export type {
  LeadMode,
  LeadTeammateBoardEntry,
  PaneLogLine,
  TeamBackgroundSession,
  TeamChallenge,
  TeamChallengeStatus,
  TeamConversationEntry,
  TeamConversationKind,
  TeamSessionEntry,
  TeamV3Config,
  TeamV3CostEstimate,
  TeamV3Primitive,
  TeamV3Result,
  TeamV3State,
  TeamWave,
  TeamWaveStatus,
  TeammatePane,
  V3TaskOutcome,
  V3TaskState,
} from './types';

export {
  allWavesDone,
  canClaimByWave,
  computeWaves,
  currentWave,
  summarizeWaves,
  waveOfTask,
} from './waves';

export {
  canOverrideFileGuard,
  checkFileGuard,
  checkPartitionGuard,
  summarizeFileHolds,
} from './fileGuard';
export type { FileGuardCheck, FileHold, PartitionGuardCheck } from './fileGuard';

export {
  buildLeadBoard,
  canLeadWork,
  checkLeadClaim,
  checkLeadWorkerClaim,
  leadModeSwitchNote,
  leadOpenTasks,
  leadWorkerName,
  summarizeLeadBoard,
  validateLeadModeSwitch,
} from './leadControl';

export {
  answerChallenge,
  challengesByStatus,
  openChallenge,
  openChallengeCounts,
  openChallengesForTask,
  resolveChallenge,
  summarizeChallenges,
} from './challenges';
export type { OpenChallengeInput } from './challenges';

export {
  appendPaneLog,
  createPane,
  focusPane,
  focusedPane,
  paneGridSize,
  renderPaneGrid,
  summarizeBackgroundSession,
  syncPanes,
} from './panes';

export {
  assertCanCreateTeam,
  listTeamSessions,
  readSessionRegistry,
  registerTeamSession,
  sessionHasTeam,
  teamOfSession,
  teamV3Dir,
  teamV3SessionsPath,
  unregisterTeamSession,
  writeSessionRegistry,
} from './sessionRegistry';

export {
  estimateCostBeforeCreate,
  estimateTeamV3Cost,
  linearCostWarning,
  normalizeV3CostInputs,
} from './cost';
export type { TeamV3CostInputs, NormalizedV3CostInputs } from './cost';

export { TeamV3Store, teamV3StatePath } from './stateStore';

export { TeamServiceV3, checkTeamSizeV3, estimateCostBeforeCreateV3, estimateTeamTokensV2 } from './serviceV3';
export type { CloseTaskV3Result, CreateTeamV3Input } from './serviceV3';

export { teamV3DashboardMarkdown } from './dashboard';
export type { TeamV3Dashboard } from './dashboard';
