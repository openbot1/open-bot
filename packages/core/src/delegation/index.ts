/**
 * Delegation v2 — public surface (v1.04, Đội T4).
 *
 * Ủy quyền qua tool call, có theo dõi tiến độ (tracker) + hợp nhất
 * kết quả nhiều chiến lược (merge). Runner do caller tiêm vào.
 */
export { DelegationTracker, DELEGATION_TRACKER_MAX_SESSIONS, deriveSessionStatus } from './tracker';
export type { DelegationSessionSummary } from './tracker';
export {
  DELEGATION_SUMMARIZE_CHARS_PER_CHILD,
  detectVerdictConflicts,
  majorityVerdict,
  mergeDelegationResults,
  normalizeVerdict,
} from './merge';
export type { DelegationMergeResult } from './merge';
export type {
  DelegationChildInput,
  DelegationChildProgress,
  DelegationChildRecord,
  DelegationChildResult,
  DelegationChildStatus,
  DelegationLogStore,
  DelegationMergeReport,
  DelegationMergeStrategy,
  DelegationSession,
  DelegationSessionStatus,
} from './types';
