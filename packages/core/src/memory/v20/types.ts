/**
 * Memory v20 — Letta-style core memory blocks + sleep-time consolidation
 * (v1.28, Doi T1).
 *
 * Y tuong hoc tu Letta 0.16.7 (core memory blocks do agent tu sua bang
 * tool; sleep-time compute cung co memory giua session) + OpenHands
 * event-sourced log — tu thiet ke lai hoan toan cho open-bot, KHONG
 * copy code/text/tai san cua bat ky repo nao.
 *
 * Thiet ke:
 *  - Core block: mot doan van ban co nhan (label), gioi han ky tu,
 *    phien ban tang dan, lich su append-only. Agent tu sua block
 *    bang tool (blockTools.ts), khong sua truc tiep file.
 *  - Sleep-time consolidation: chay nen GIUA session (khong nam
 *    tren critical path cua chat), gom fact moi thanh block,
 *    decay + dedup, bao cao qua sleepScheduler.ts / sleepWorker.ts.
 *  - Block chia se giua nhieu agent (blockSync.ts) + audit/rollback
 *    (blockAudit.ts).
 *  - Muc tieu: ~4.500 dong TS that (code + test + i18n 6 locale).
 */
export type V20BlockKind = 'persona' | 'human' | 'facts' | 'preferences' | 'project' | 'custom';
export type V20BlockScope = 'agent' | 'user' | 'shared';
export type V20EditOp = 'replace' | 'append' | 'prepend' | 'insert' | 'delete_range' | 'create' | 'archive' | 'restore' | 'rollback';
export type V20SleepTrigger = 'session_end' | 'idle' | 'manual' | 'scheduled' | 'memory_pressure';
export type V20SleepJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type V20SleepPhase = 'collect' | 'dedupe' | 'decay' | 'promote' | 'summarize' | 'prune' | 'report';
export type V20AuditAction = 'create' | 'edit' | 'archive' | 'restore' | 'rollback' | 'share' | 'unshare' | 'sleep_promote';

export interface V20CoreBlock {
  id: string;
  label: string;
  kind: V20BlockKind;
  scope: V20BlockScope;
  value: string;
  charLimit: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  archived: boolean;
  readonly?: boolean;
  tags: string[];
}

export interface V20BlockEdit {
  id: string;
  blockId: string;
  op: V20EditOp;
  actor: string;
  actorKind: 'agent' | 'user' | 'sleep' | 'system';
  before: string;
  after: string;
  reason: string;
  versionBefore: number;
  versionAfter: number;
  at: number;
  reverted: boolean;
  toolCallId?: string;
}

export interface V20BlockEditRequest {
  blockId: string;
  op: V20EditOp;
  actor: string;
  actorKind: 'agent' | 'user' | 'sleep' | 'system';
  newValue?: string;
  text?: string;
  start?: number;
  end?: number;
  reason: string;
  toolCallId?: string;
  expectedVersion?: number;
}

export interface V20BlockEditResult {
  ok: boolean;
  block?: V20CoreBlock;
  edit?: V20BlockEdit;
  error?: string;
  errorCode?: V20BlockErrorCode;
  charsUsed?: number;
  charsLimit?: number;
}

export type V20BlockErrorCode =
  | 'block_not_found'
  | 'block_archived'
  | 'block_readonly'
  | 'empty_value'
  | 'over_char_limit'
  | 'version_conflict'
  | 'invalid_range'
  | 'invalid_label'
  | 'duplicate_label'
  | 'invalid_op'
  | 'forbidden_actor'
  | 'empty_reason';

export interface V20SleepJob {
  id: string;
  trigger: V20SleepTrigger;
  status: V20SleepJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  phase: V20SleepPhase;
  progress: number;
  maxMs: number;
  chunkSize: number;
  report?: V20SleepReport;
  error?: string;
  cancelledAt?: number;
}

export interface V20SleepReport {
  jobId: string;
  trigger: V20SleepTrigger;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  factsCollected: number;
  duplicatesMerged: number;
  factsDecayed: number;
  factsPromoted: number;
  blocksUpdated: string[];
  factsPruned: number;
  summariesWritten: number;
  errors: string[];
  skipped: string[];
}

export interface V20BlockShare {
  blockId: string;
  sharedWith: string[];
  sharedAt: number;
  sharedBy: string;
  readOnly: boolean;
}

export const V20_DEFAULT_CHAR_LIMIT = 8000;
export const V20_MAX_BLOCKS_PER_AGENT = 32;
export const V20_MAX_LABEL_LENGTH = 64;
export const V20_MIN_REASON_LENGTH = 3;
export const V20_DEFAULT_SLEEP_MAX_MS = 60_000;
export const V20_DEFAULT_SLEEP_CHUNK_SIZE = 50;
