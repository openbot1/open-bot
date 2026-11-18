/**
 * Composio job polling v1.29 (v1.29, Doi T4 — Composio v6).
 *
 * Poll long job v129 ma khong block agent turn: moi lan poll chi
 * chay toi da mot tick (xem `advanceComposioV129Job`) roi tra ve
 * ngay kem `nextPollAtMs` — agent/scheduler quyet dinh khi nao poll
 * lai, khong co vong lap doi ben trong.
 *
 * Chinh sach poll:
 * - Backoff mu: delay = base * factor^attempt, tran o maxMs. Job
 *   co tien trien (progress) thi reset attempt ve 0 (poll nhanh lai);
 *   khong tien trien thi attempt tang (poll thua dan); loi fetch thi
 *   attempt tang gap doi (error x2) de tranh dap lien tuc.
 * - Jitter xac dinh (deterministic): dua tren hash(jobId, attempt),
 *   trong [0, maxJitterMs] — de nhieu job khong poll cung luc (tranh
 *   thundering herd) ma van lap lai duoc trong test.
 * - Gioi han poll: maxPolls — vuot thi job chuyen 'failed' voi loi
 *   ro rang (khong poll vo han). Timeout tuyet doi cua job (xem
 *   longJobsV129) van la gioi han cuoi cung.
 * - Poll schedule co the serialize (checkpoint) — host luu/tai qua
 *   restart ma khong mat lich poll.
 */

import {
  advanceComposioV129Job,
  checkComposioV129JobTimeout,
  isComposioV129TerminalJobStatus,
  type ComposioV129AdvanceResult,
  type ComposioV129JobConfig,
  type ComposioV129LongJob,
  type ComposioV129StepFn,
} from './longJobsV129';

/** Ket qua mot lan poll (outcome de tinh delay ke tiep). */
export type ComposioV129PollOutcome = 'progress' | 'no-progress' | 'error' | 'done';

/** Version checkpoint JSON cua poll schedule v129. */
export const COMPOSIO_V129_POLL_SCHEDULE_VERSION = 1;

/** Chinh sach poll mac dinh cho long job v129. */
export const DEFAULT_COMPOSIO_V129_POLL_POLICY = {
  /** Delay co so giua cac lan poll: 2 giay. */
  baseMs: 2000,
  /** Delay toi da: 60 giay. */
  maxMs: 60000,
  /** He so backoff mu. */
  factor: 2,
  /** Jitter toi da them vao delay: 500ms. */
  maxJitterMs: 500,
  /** So lan poll toi da truoc khi danh dau failed: 500. */
  maxPolls: 500,
} as const;

export interface ComposioV129PollPolicy {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  maxJitterMs?: number;
  maxPolls?: number;
}

export function resolveComposioV129PollPolicy(
  policy: ComposioV129PollPolicy = {},
): Required<ComposioV129PollPolicy> {
  return {
    baseMs: policy.baseMs ?? DEFAULT_COMPOSIO_V129_POLL_POLICY.baseMs,
    maxMs: policy.maxMs ?? DEFAULT_COMPOSIO_V129_POLL_POLICY.maxMs,
    factor: policy.factor ?? DEFAULT_COMPOSIO_V129_POLL_POLICY.factor,
    maxJitterMs: policy.maxJitterMs ?? DEFAULT_COMPOSIO_V129_POLL_POLICY.maxJitterMs,
    maxPolls: policy.maxPolls ?? DEFAULT_COMPOSIO_V129_POLL_POLICY.maxPolls,
  };
}

export function validateComposioV129PollPolicy(policy: ComposioV129PollPolicy): string[] {
  const errors: string[] = [];
  const resolved = resolveComposioV129PollPolicy(policy);
  if (!Number.isFinite(resolved.baseMs) || resolved.baseMs <= 0) errors.push('baseMs must be a positive number');
  if (!Number.isFinite(resolved.maxMs) || resolved.maxMs <= 0) errors.push('maxMs must be a positive number');
  if (resolved.baseMs > resolved.maxMs) errors.push('baseMs must not exceed maxMs');
  if (!Number.isFinite(resolved.factor) || resolved.factor < 1) errors.push('factor must be a number >= 1');
  if (!Number.isFinite(resolved.maxJitterMs) || resolved.maxJitterMs < 0) errors.push('maxJitterMs must be a number >= 0');
  if (!Number.isInteger(resolved.maxPolls) || resolved.maxPolls < 1) errors.push('maxPolls must be an integer >= 1');
  return errors;
}

/**
 * Hash xac dinh (FNV-1a 32-bit) — dung cho jitter + id, khong dung
 * Math.random de test lap lai duoc.
 */
export function composioV129Hash32(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Jitter xac dinh cho mot lan poll: 0..maxJitterMs, phu thuoc vao
 * jobId + attempt — cung job + cung attempt luon cho cung jitter.
 */
export function composioV129PollJitterMs(jobId: string, attempt: number, maxJitterMs: number): number {
  if (maxJitterMs <= 0) return 0;
  return composioV129Hash32(`${jobId}:${attempt}`) % (Math.floor(maxJitterMs) + 1);
}

/**
 * Delay poll ke tiep (ms, chua cong jitter) theo outcome:
 * - progress: reset ve base (job dang chay tot, poll nhanh).
 * - no-progress: base * factor^attempt, tran maxMs.
 * - error: base * factor^(attempt+1) (nang hon no-progress mot bac).
 * - done: 0 (khong poll nua).
 */
export function composioV129PollDelayMs(
  outcome: ComposioV129PollOutcome,
  attempt: number,
  policy: ComposioV129PollPolicy = {},
): number {
  const resolved = resolveComposioV129PollPolicy(policy);
  if (outcome === 'done') return 0;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  if (outcome === 'progress') return resolved.baseMs;
  const exponent = outcome === 'error' ? safeAttempt + 1 : safeAttempt;
  const delay = resolved.baseMs * Math.pow(resolved.factor, exponent);
  return Math.min(resolved.maxMs, Math.floor(delay));
}

/**
 * Delay day du (delay + jitter xac dinh) cho lan poll ke tiep.
 */
export function composioV129NextPollDelayMs(
  jobId: string,
  outcome: ComposioV129PollOutcome,
  attempt: number,
  policy: ComposioV129PollPolicy = {},
): number {
  const resolved = resolveComposioV129PollPolicy(policy);
  const base = composioV129PollDelayMs(outcome, attempt, resolved);
  if (base === 0) return 0;
  return base + composioV129PollJitterMs(jobId, attempt, resolved.maxJitterMs);
}

/** Bang delay mau (de UI/test hien lich poll ma khong can tinh tay). */
export function composioV129PollDelayTable(
  policy: ComposioV129PollPolicy = {},
  attempts = 6,
): { attempt: number; noProgressMs: number; errorMs: number }[] {
  const table: { attempt: number; noProgressMs: number; errorMs: number }[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    table.push({
      attempt,
      noProgressMs: composioV129PollDelayMs('no-progress', attempt, policy),
      errorMs: composioV129PollDelayMs('error', attempt, policy),
    });
  }
  return table;
}

/** Lich poll cua mot job (de host luu/tai + hien UI). */
export interface ComposioV129PollSchedule {
  jobId: string;
  /** Epoch ms poll ke tiep. */
  nextPollAtMs: number;
  /** So lan da poll. */
  pollCount: number;
  /** So lan poll lien tiep khong tien trien. */
  consecutiveMisses: number;
  /** Outcome cua lan poll gan nhat. */
  lastOutcome?: ComposioV129PollOutcome;
  /** Epoch ms poll gan nhat. */
  lastPollAtMs?: number;
}

/** Tao lich poll moi cho mot job (poll dau tien ngay sau baseMs). */
export function createComposioV129PollSchedule(
  jobId: string,
  nowMs: number,
  policy: ComposioV129PollPolicy = {},
): ComposioV129PollSchedule {
  const resolved = resolveComposioV129PollPolicy(policy);
  return {
    jobId,
    nextPollAtMs: nowMs + resolved.baseMs,
    pollCount: 0,
    consecutiveMisses: 0,
  };
}

/**
 * Cap nhat lich poll sau mot lan poll: tang pollCount, tinh
 * nextPollAtMs tu outcome. Progress reset consecutiveMisses ve 0.
 */
export function updateComposioV129PollSchedule(
  schedule: ComposioV129PollSchedule,
  outcome: ComposioV129PollOutcome,
  nowMs: number,
  policy: ComposioV129PollPolicy = {},
): ComposioV129PollSchedule {
  const resolved = resolveComposioV129PollPolicy(policy);
  const pollCount = schedule.pollCount + 1;
  const consecutiveMisses = outcome === 'progress' ? 0 : schedule.consecutiveMisses + 1;
  const delay = composioV129NextPollDelayMs(
    schedule.jobId,
    outcome,
    consecutiveMisses,
    resolved,
  );
  return {
    ...schedule,
    nextPollAtMs: outcome === 'done' ? nowMs : nowMs + delay,
    pollCount,
    consecutiveMisses,
    lastOutcome: outcome,
    lastPollAtMs: nowMs,
  };
}

/** true khi da toi luc poll (now >= nextPollAtMs). */
export function isComposioV129PollDue(schedule: ComposioV129PollSchedule, nowMs: number): boolean {
  return nowMs >= schedule.nextPollAtMs;
}

/** Ms con lai toi lan poll ke tiep (0 = da toi han). */
export function composioV129MsUntilNextPoll(schedule: ComposioV129PollSchedule, nowMs: number): number {
  return Math.max(0, schedule.nextPollAtMs - nowMs);
}

export function validateComposioV129PollSchedule(schedule: unknown): string[] {
  const errors: string[] = [];
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    errors.push('schedule must be an object');
    return errors;
  }
  const s = schedule as Record<string, unknown>;
  if (typeof s['jobId'] !== 'string' || (s['jobId'] as string).trim() === '') errors.push('jobId must be a non-empty string');
  if (typeof s['nextPollAtMs'] !== 'number' || !Number.isFinite(s['nextPollAtMs'] as number)) errors.push('nextPollAtMs must be a finite number');
  if (!Number.isInteger(s['pollCount']) || (s['pollCount'] as number) < 0) errors.push('pollCount must be an integer >= 0');
  if (!Number.isInteger(s['consecutiveMisses']) || (s['consecutiveMisses'] as number) < 0) errors.push('consecutiveMisses must be an integer >= 0');
  if (s['lastOutcome'] !== undefined && !['progress', 'no-progress', 'error', 'done'].includes(s['lastOutcome'] as string)) {
    errors.push(`lastOutcome must be a ComposioV129PollOutcome, got ${String(s['lastOutcome'])}`);
  }
  return errors;
}

export function serializeComposioV129PollSchedule(schedule: ComposioV129PollSchedule): string {
  return JSON.stringify({ version: COMPOSIO_V129_POLL_SCHEDULE_VERSION, schedule });
}

export function parseComposioV129PollSchedule(text: string): ComposioV129PollSchedule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid Composio v129 poll schedule: not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Composio v129 poll schedule: expected an object');
  }
  const { version, schedule } = parsed as { version?: unknown; schedule?: unknown };
  if (version !== COMPOSIO_V129_POLL_SCHEDULE_VERSION) {
    throw new Error(`Unsupported Composio v129 poll schedule version: ${String(version)}`);
  }
  const errors = validateComposioV129PollSchedule(schedule);
  if (errors.length > 0) throw new Error(`Invalid Composio v129 poll schedule: ${errors.join('; ')}`);
  return schedule as ComposioV129PollSchedule;
}

// ---------------------------------------------------------------------------
// Poll driver — mot lan poll = mot tick advance + tinh lich ke tiep
// ---------------------------------------------------------------------------

export interface ComposioV129PollOnceResult {
  /** Job sau tick (da luu trang thai moi). */
  job: ComposioV129LongJob;
  /** Lich poll sau tick. */
  schedule: ComposioV129PollSchedule;
  /** Outcome cua lan poll nay. */
  outcome: ComposioV129PollOutcome;
  /** Delay (ms) toi lan poll ke tiep (0 = khong poll nua). */
  nextDelayMs: number;
  /** true khi job vua ket thuc o tick nay. */
  finished: boolean;
  /** Ghi chu ngan cho agent (de hien/log). */
  note: string;
}

/**
 * Poll mot job mot lan (khong block):
 *
 * 1. Job terminal -> outcome 'done', khong chay step, delay 0.
 * 2. Job qua timeout -> 'timed-out' (outcome 'error' cho lich poll,
 *    nhung job da ket thuc nen khong poll nua).
 * 3. Vuot maxPolls -> job 'failed' (poll vo han bi chan).
 * 4. Con lai: advance mot step. Step chay duoc -> 'progress'
 *    (hoac 'done' khi vua xong het step); step loi -> 'failed'
 *    (outcome 'error'); cancelRequested -> 'cancelled'.
 *
 * Tra ve job + schedule moi — host luu ca hai (store.save + lich
 * poll) roi tra ket qua ve agent ngay.
 */
export function pollComposioV129JobOnce(
  job: ComposioV129LongJob,
  schedule: ComposioV129PollSchedule,
  nowMs: number,
  stepFn: ComposioV129StepFn,
  policy: ComposioV129PollPolicy = {},
  jobConfig: ComposioV129JobConfig = {},
): ComposioV129PollOnceResult {
  const resolved = resolveComposioV129PollPolicy(policy);
  const errors = validateComposioV129PollPolicy(policy);
  if (errors.length > 0) throw new Error(`Invalid Composio v129 poll policy: ${errors.join('; ')}`);
  if (schedule.jobId !== job.id) {
    throw new Error(`Poll schedule job mismatch: schedule is for ${schedule.jobId}, job is ${job.id}`);
  }

  if (isComposioV129TerminalJobStatus(job.status)) {
    const nextSchedule = updateComposioV129PollSchedule(schedule, 'done', nowMs, resolved);
    return {
      job: { ...job, pollCount: job.pollCount + 1, updatedAtMs: nowMs },
      schedule: nextSchedule,
      outcome: 'done',
      nextDelayMs: 0,
      finished: true,
      note: `Job already ${job.status}; no further polling.`,
    };
  }

  if (schedule.pollCount >= resolved.maxPolls) {
    const failed: ComposioV129LongJob = {
      ...job,
      status: 'failed',
      error: `Poll limit exceeded: ${schedule.pollCount} polls >= max ${resolved.maxPolls}.`,
      pollCount: job.pollCount + 1,
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    };
    const nextSchedule = updateComposioV129PollSchedule(schedule, 'error', nowMs, resolved);
    return {
      job: failed,
      schedule: nextSchedule,
      outcome: 'error',
      nextDelayMs: 0,
      finished: true,
      note: `Poll limit exceeded (${resolved.maxPolls}); job failed.`,
    };
  }

  const timedOut = checkComposioV129JobTimeout(job, nowMs);
  if (timedOut.status === 'timed-out') {
    const nextSchedule = updateComposioV129PollSchedule(schedule, 'error', nowMs, resolved);
    return {
      job: { ...timedOut, pollCount: timedOut.pollCount + 1 },
      schedule: nextSchedule,
      outcome: 'error',
      nextDelayMs: 0,
      finished: true,
      note: 'Job timed out.',
    };
  }

  const before = job.stepsDone;
  const advance: ComposioV129AdvanceResult = advanceComposioV129Job(job, nowMs, stepFn, jobConfig);
  const advancedJob: ComposioV129LongJob = {
    ...advance.job,
    pollCount: advance.job.pollCount + 1,
  };
  let outcome: ComposioV129PollOutcome;
  let note: string;
  if (advancedJob.status === 'done') {
    outcome = 'done';
    note = `Job done: ${advancedJob.stepsDone}/${advancedJob.totalSteps} steps.`;
  } else if (advancedJob.status === 'failed') {
    outcome = 'error';
    note = `Job failed: ${advancedJob.error ?? 'unknown error'}.`;
  } else if (advancedJob.status === 'cancelled') {
    outcome = 'done';
    note = 'Job cancelled.';
  } else if (advancedJob.stepsDone > before) {
    outcome = 'progress';
    note = `Step ${advancedJob.stepsDone}/${advancedJob.totalSteps} done.`;
  } else {
    outcome = 'no-progress';
    note = advance.reason ?? 'No progress this poll.';
  }
  const nextSchedule = updateComposioV129PollSchedule(schedule, outcome, nowMs, resolved);
  const nextDelayMs = outcome === 'done' ? 0 : nextSchedule.nextPollAtMs - nowMs;
  return {
    job: { ...advancedJob, nextPollAtMs: outcome === 'done' ? undefined : nextSchedule.nextPollAtMs },
    schedule: nextSchedule,
    outcome,
    nextDelayMs,
    finished: isComposioV129TerminalJobStatus(advancedJob.status),
    note,
  };
}

/**
 * Poll nhieu job trong mot luot (batch): moi job toi da mot tick,
 * job nao chua toi han poll thi bo qua. Tra ket qua tung job + tong
 * hop — de scheduler chay dinh ky ma khong block turn nao.
 */
export function pollComposioV129JobsBatch(
  jobs: readonly ComposioV129LongJob[],
  schedules: Readonly<Record<string, ComposioV129PollSchedule>>,
  nowMs: number,
  stepFn: ComposioV129StepFn,
  policy: ComposioV129PollPolicy = {},
  jobConfig: ComposioV129JobConfig = {},
): {
  results: ComposioV129PollOnceResult[];
  skipped: string[];
  finished: number;
  stillRunning: number;
} {
  const results: ComposioV129PollOnceResult[] = [];
  const skipped: string[] = [];
  for (const job of jobs) {
    const schedule = schedules[job.id];
    if (!schedule) {
      skipped.push(job.id);
      continue;
    }
    if (!isComposioV129PollDue(schedule, nowMs) && !isComposioV129TerminalJobStatus(job.status)) {
      skipped.push(job.id);
      continue;
    }
    results.push(pollComposioV129JobOnce(job, schedule, nowMs, stepFn, policy, jobConfig));
  }
  return {
    results,
    skipped,
    finished: results.filter((r) => r.finished).length,
    stillRunning: results.filter((r) => !r.finished).length,
  };
}
