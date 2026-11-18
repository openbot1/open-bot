/**
 * Scheduler v2 cho fleet v23 (v1.36, Đội T6) — hàng đợi ưu tiên +
 * cron + SLA + preemption.
 *
 * Fleet v21 chỉ đặt MỘT run lên node tốt nhất NGAY LÚC ĐÓ (không hàng
 * đợi, không ưu tiên, không hẹn giờ). Khi fleet bận, run mới hoặc bị
 * từ chối hoặc phải chờ ngoài hệ thống. Module này là hàng đợi thật:
 *
 * - Priority class: `critical` > `high` > `normal` > `low`. Job chờ lâu
 *   được AGING: mỗi phút chờ cộng điểm ưu tiên hiệu dụng (chống job
 *   `low` đói mãi khi job `high` vào liên tục).
 * - Cron: job lặp theo biểu thức cron 5 trường (phút giờ ngày tháng
 *   thứ) — tính lần chạy kế tiếp từ một thời điểm, không cần thư viện.
 * - SLA: mỗi job có deadline (ms). Quá deadline mà chưa chạy → breach
 *   (dashboard báo; scheduler vẫn chạy job nếu còn chỗ, nhưng ghi rõ
 *   breach để host xem lại capacity).
 * - Preemption: job `critical` mới vào mà hết chỗ thì được CƯỚP chỗ
 *   của job đang chạy có priority thấp hơn — nhưng có luật bảo vệ:
 *   không cướp job `critical`, không cướp job mới chạy chưa đủ
 *   `minRuntimeBeforePreemptMs`, nạn nhân là job thấp nhất / còn lâu
 *   nhất; job bị cướp quay lại hàng đợi với priority giữ nguyên +
 *   ghi lý do.
 *
 * Module thuần: không chạy job thật, không spawn — host lấy quyết
 * định (job nào chạy tiếp, job nào bị preempt) rồi thực thi.
 */

/** Mức ưu tiên của job (số lớn = quan trọng hơn). */
export type FleetV23Priority = 'critical' | 'high' | 'normal' | 'low';

/** Mọi mức ưu tiên, theo thứ tự giảm dần. */
export const FLEET_V23_PRIORITIES: readonly FleetV23Priority[] = ['critical', 'high', 'normal', 'low'];

/** Điểm cơ số của mỗi mức ưu tiên (để tính ưu tiên hiệu dụng + aging). */
export const FLEET_V23_PRIORITY_BASE_SCORE: Readonly<Record<FleetV23Priority, number>> = {
  critical: 400,
  high: 300,
  normal: 200,
  low: 100,
};

/** Trạng thái job trong hàng đợi. */
export type FleetV23JobStatus = 'queued' | 'running' | 'preempted' | 'completed' | 'failed' | 'cancelled';

/** Mọi trạng thái job. */
export const FLEET_V23_JOB_STATUSES: readonly FleetV23JobStatus[] = [
  'queued',
  'running',
  'preempted',
  'completed',
  'failed',
  'cancelled',
];

/** Một job chờ / đang chạy trong scheduler v2. */
export interface FleetV23Job {
  /** Id job. */
  id: string;
  /** Bot chạy job. */
  botId: string;
  /** Mô tả ngắn (để UI/audit). */
  title: string;
  priority: FleetV23Priority;
  status: FleetV23JobStatus;
  /** Lúc job vào hàng đợi (epoch ms). */
  submittedAt: number;
  /** Deadline SLA (epoch ms) — undefined = không có SLA. */
  slaDeadlineMs?: number;
  /** Thời gian chạy ước tính (ms) — dùng để chọn nạn nhân preempt. */
  estimatedMs: number;
  /** Lúc bắt đầu chạy (epoch ms) — null khi chưa chạy. */
  startedAt: number | null;
  /** Tài nguyên job cần (để scheduler biết job có vừa node trống không). */
  demand: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Biểu thức cron 5 trường khi job lặp (undefined = chạy 1 lần). */
  cron?: string;
  /** Số lần job đã bị preempt (để tránh cướp đi cướp lại vô hạn). */
  preemptCount: number;
  /** Lý do preempt gần nhất. */
  preemptReason?: string;
}

/** Tạo job mới (trạng thái ban đầu `queued`). */
export function createFleetV23Job(input: {
  id: string;
  botId: string;
  title: string;
  priority?: FleetV23Priority;
  submittedAt?: number;
  slaDeadlineMs?: number;
  estimatedMs?: number;
  demand?: { cpuCores: number; ramBytes: number; diskBytes: number };
  cron?: string;
}): FleetV23Job {
  return {
    id: input.id,
    botId: input.botId,
    title: input.title,
    priority: input.priority ?? 'normal',
    status: 'queued',
    submittedAt: input.submittedAt ?? Date.now(),
    ...(input.slaDeadlineMs !== undefined ? { slaDeadlineMs: input.slaDeadlineMs } : {}),
    estimatedMs: input.estimatedMs ?? 60_000,
    startedAt: null,
    demand: input.demand ?? { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 1024 ** 3 },
    ...(input.cron ? { cron: input.cron } : {}),
    preemptCount: 0,
  };
}

/** Validate job từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23Job(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['job phải là object.'];
  const j = input as Record<string, unknown>;
  if (typeof j.id !== 'string' || j.id.trim().length === 0) errors.push('job.id phải là chuỗi không rỗng.');
  if (typeof j.botId !== 'string' || j.botId.trim().length === 0) errors.push('job.botId phải là chuỗi không rỗng.');
  if (typeof j.priority !== 'string' || !(FLEET_V23_PRIORITIES as readonly string[]).includes(j.priority)) {
    errors.push(`job.priority phải là một trong: ${FLEET_V23_PRIORITIES.join(', ')}.`);
  }
  if (typeof j.submittedAt !== 'number' || !Number.isFinite(j.submittedAt) || (j.submittedAt as number) < 0) {
    errors.push('job.submittedAt phải là epoch ms >= 0.');
  }
  if (j.slaDeadlineMs !== undefined && (typeof j.slaDeadlineMs !== 'number' || (j.slaDeadlineMs as number) <= (j.submittedAt as number))) {
    errors.push('job.slaDeadlineMs (nếu có) phải lớn hơn submittedAt.');
  }
  if (typeof j.estimatedMs !== 'number' || (j.estimatedMs as number) <= 0) {
    errors.push('job.estimatedMs phải là số > 0.');
  }
  if (j.cron !== undefined) {
    const cronErrors = validateFleetV23Cron(j.cron as string);
    errors.push(...cronErrors.map((e) => `job.cron: ${e}`));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Ưu tiên hiệu dụng + aging
// ---------------------------------------------------------------------------

/** Cấu hình aging: mỗi phút chờ cộng bao nhiêu điểm ưu tiên hiệu dụng. */
export const FLEET_V23_AGING_POINTS_PER_MINUTE = 1;

/** Số lần preempt tối đa của một job — quá thì không preempt nữa (tránh lật qua lật lại). */
export const FLEET_V23_MAX_PREEMPTIONS = 3;

/**
 * Ưu tiên hiệu dụng của job tại `now`: điểm cơ số + aging theo thời
 * gian chờ (phút, làm tròn xuống). Job `low` chờ đủ lâu có thể vượt
 * job `normal` mới vào — đó chính là mục đích của aging (chống đói).
 * Job đang chạy không tính aging (nó đã có chỗ).
 */
export function effectivePriorityV23(job: FleetV23Job, now: number = Date.now()): number {
  const base = FLEET_V23_PRIORITY_BASE_SCORE[job.priority];
  if (job.status !== 'queued') return base;
  const waitedMs = Math.max(0, now - job.submittedAt);
  const waitedMinutes = Math.floor(waitedMs / 60_000);
  return base + waitedMinutes * FLEET_V23_AGING_POINTS_PER_MINUTE;
}

/** So sánh 2 job queued: ưu tiên hiệu dụng cao hơn trước; hoà → deadline sớm hơn trước; hoà nữa → nộp sớm hơn trước; cuối cùng id nhỏ hơn (ổn định). */
export function compareFleetV23Jobs(a: FleetV23Job, b: FleetV23Job, now: number = Date.now()): number {
  const scoreDiff = effectivePriorityV23(b, now) - effectivePriorityV23(a, now);
  if (scoreDiff !== 0) return scoreDiff;
  const deadlineA = a.slaDeadlineMs ?? Number.POSITIVE_INFINITY;
  const deadlineB = b.slaDeadlineMs ?? Number.POSITIVE_INFINITY;
  if (deadlineA !== deadlineB) return deadlineA - deadlineB;
  if (a.submittedAt !== b.submittedAt) return a.submittedAt - b.submittedAt;
  return a.id.localeCompare(b.id);
}

/** Sắp hàng đợi: job queued theo thứ tự sẽ được chạy (đầu = chạy tiếp theo). */
export function sortFleetV23Queue(jobs: readonly FleetV23Job[], now: number = Date.now()): FleetV23Job[] {
  return [...jobs].filter((j) => j.status === 'queued').sort((a, b) => compareFleetV23Jobs(a, b, now));
}

// ---------------------------------------------------------------------------
// Cron 5 trường (phút giờ ngày tháng thứ)
// ---------------------------------------------------------------------------

/** Một trường cron đã parse: tập giá trị cho phép (null = `*`). */
type CronFieldSet = Set<number> | null;

/** Cron đã parse. */
export interface FleetV23CronParsed {
  minute: CronFieldSet;
  hour: CronFieldSet;
  dayOfMonth: CronFieldSet;
  month: CronFieldSet;
  dayOfWeek: CronFieldSet;
}

const CRON_FIELD_RANGES: [number, number][] = [
  [0, 59], // phút
  [0, 23], // giờ
  [1, 31], // ngày trong tháng
  [1, 12], // tháng
  [0, 6], // thứ (0 = Chủ nhật; 7 cũng là Chủ nhật, chuẩn hoá về 0)
];

/** Parse một trường cron: `*`, `5`, `1,5`, `1-5`, `*\/15`, `1-10/2`. Lỗi → throw kèm vị trí. */
export function parseFleetV23CronField(field: string, fieldIndex: number): CronFieldSet {
  // Thứ: cho phép 0..7 (7 = Chủ nhật, chuẩn hoá về 0); các trường khác theo bảng.
  const [min, max] = fieldIndex === 4 ? [0, 7] : (CRON_FIELD_RANGES[fieldIndex] as [number, number]);
  const name = ['phút', 'giờ', 'ngày trong tháng', 'tháng', 'thứ'][fieldIndex] as string;
  if (field === '*') return null;
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Cron trường ${name}: bước "${stepPart}" phải là số nguyên >= 1.`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if ((rangePart as string).includes('-')) {
      const [a, b] = (rangePart as string).split('-').map(Number);
      lo = a as number;
      hi = b as number;
    } else {
      lo = Number(rangePart);
      hi = Number(rangePart);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Cron trường ${name}: "${part}" ngoài khoảng ${min}..${max}.`);
    }
    for (let v = lo; v <= hi; v += step) {
      // Thứ 7 = Chủ nhật → chuẩn hoá về 0.
      values.add(fieldIndex === 4 && v === 7 ? 0 : v);
    }
  }
  return values;
}

/** Parse biểu thức cron 5 trường (lỗi → throw). */
export function parseFleetV23Cron(expr: string): FleetV23CronParsed {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron phải có đúng 5 trường (phút giờ ngày tháng thứ), nhận được ${fields.length} trường: "${expr}".`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  return {
    minute: parseFleetV23CronField(minute, 0),
    hour: parseFleetV23CronField(hour, 1),
    dayOfMonth: parseFleetV23CronField(dayOfMonth, 2),
    month: parseFleetV23CronField(month, 3),
    dayOfWeek: parseFleetV23CronField(dayOfWeek, 4),
  };
}

/** Validate cron (lỗi → danh sách, rỗng = hợp lệ). */
export function validateFleetV23Cron(expr: unknown): string[] {
  if (typeof expr !== 'string' || expr.trim().length === 0) return ['cron phải là chuỗi không rỗng.'];
  try {
    parseFleetV23Cron(expr);
    return [];
  } catch (err) {
    return [(err as Error).message];
  }
}

function cronFieldMatches(set: CronFieldSet, value: number): boolean {
  return set === null || set.has(value);
}

/**
 * Lần chạy kế tiếp của cron SAU thời điểm `fromMs` (không bao gồm
 * chính `fromMs`; quét từng phút, tối đa 366 ngày — quá thì throw vì
 * cron không bao giờ khớp, vd 31/2). Dùng UTC để kết quả ổn định
 * không phụ thuộc múi giờ máy host.
 */
export function nextFleetV23CronRun(expr: string, fromMs: number): number {
  const cron = parseFleetV23Cron(expr);
  // Bắt đầu từ phút tiếp theo (làm tròn lên).
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000;
  while (t <= limit) {
    const d = new Date(t);
    const domMatch = cronFieldMatches(cron.dayOfMonth, d.getUTCDate());
    const dowMatch = cronFieldMatches(cron.dayOfWeek, d.getUTCDay());
    // Quy ước cron chuẩn: ngày-tháng VÀ thứ đều hạn chế thì khớp khi
    // MỘT trong hai khớp (OR); chỉ một bên hạn chế thì bên đó quyết.
    const dayOk =
      cron.dayOfMonth !== null && cron.dayOfWeek !== null
        ? domMatch || dowMatch
        : domMatch && dowMatch;
    if (
      cronFieldMatches(cron.minute, d.getUTCMinutes()) &&
      cronFieldMatches(cron.hour, d.getUTCHours()) &&
      cronFieldMatches(cron.month, d.getUTCMonth() + 1) &&
      dayOk
    ) {
      return t;
    }
    t += 60_000;
  }
  throw new Error(`Cron "${expr}" không có lần chạy nào trong 366 ngày tới (có thể là ngày không tồn tại như 31/2).`);
}

/** true khi cron khớp đúng tại thời điểm `atMs` (so theo phút UTC). */
export function cronMatchesAtV23(expr: string, atMs: number): boolean {
  const cron = parseFleetV23Cron(expr);
  const d = new Date(Math.floor(atMs / 60_000) * 60_000);
  const domMatch = cronFieldMatches(cron.dayOfMonth, d.getUTCDate());
  const dowMatch = cronFieldMatches(cron.dayOfWeek, d.getUTCDay());
  const dayOk =
    cron.dayOfMonth !== null && cron.dayOfWeek !== null ? domMatch || dowMatch : domMatch && dowMatch;
  return (
    cronFieldMatches(cron.minute, d.getUTCMinutes()) &&
    cronFieldMatches(cron.hour, d.getUTCHours()) &&
    cronFieldMatches(cron.month, d.getUTCMonth() + 1) &&
    dayOk
  );
}

// ---------------------------------------------------------------------------
// Hàng đợi ưu tiên (queue)
// ---------------------------------------------------------------------------

/** Hàng đợi scheduler v2 trong bộ nhớ — host giữ 1 instance. */
export class FleetV23SchedulerQueue {
  private readonly jobs = new Map<string, FleetV23Job>();

  /** Thêm job (id trùng → throw; job lỗi validate → throw). */
  enqueue(job: FleetV23Job): void {
    if (this.jobs.has(job.id)) throw new Error(`Job "${job.id}" đã có trong hàng đợi scheduler v23.`);
    const errors = validateFleetV23Job(job);
    if (errors.length > 0) throw new Error(`Job "${job.id}" không hợp lệ: ${errors.join(' ')}`);
    this.jobs.set(job.id, structuredClone(job));
  }

  /** Lấy job theo id (bản sao; undefined khi không có). */
  get(jobId: string): FleetV23Job | undefined {
    const j = this.jobs.get(jobId);
    return j ? structuredClone(j) : undefined;
  }

  /** Mọi job (bản sao). */
  list(): FleetV23Job[] {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }

  /** Job theo trạng thái. */
  byStatus(status: FleetV23JobStatus): FleetV23Job[] {
    return this.list().filter((j) => j.status === status);
  }

  /** Job queued theo thứ tự chạy (đầu = chạy tiếp theo). */
  orderedQueue(now: number = Date.now()): FleetV23Job[] {
    return sortFleetV23Queue(this.list(), now);
  }

  /** Job queued tiếp theo (undefined khi hàng đợi rỗng). */
  peekNext(now: number = Date.now()): FleetV23Job | undefined {
    return this.orderedQueue(now)[0];
  }

  /**
   * Đánh dấu job bắt đầu chạy (chỉ job queued mới chạy được; job
   * khác trạng thái → throw).
   */
  start(jobId: string, now: number = Date.now()): FleetV23Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job "${jobId}" không có trong hàng đợi scheduler v23.`);
    if (job.status !== 'queued' && job.status !== 'preempted') {
      throw new Error(`Job "${jobId}" đang "${job.status}" — chỉ job queued/preempted mới bắt đầu chạy được.`);
    }
    const next: FleetV23Job = { ...job, status: 'running', startedAt: now };
    this.jobs.set(jobId, next);
    return structuredClone(next);
  }

  /** Đánh dấu job bị preempt (chỉ job running): quay lại hàng đợi, preemptCount +1. */
  preempt(jobId: string, reason: string): FleetV23Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job "${jobId}" không có trong hàng đợi scheduler v23.`);
    if (job.status !== 'running') {
      throw new Error(`Job "${jobId}" đang "${job.status}" — chỉ job running mới bị preempt được.`);
    }
    const next: FleetV23Job = {
      ...job,
      status: 'preempted',
      preemptCount: job.preemptCount + 1,
      preemptReason: reason,
    };
    this.jobs.set(jobId, next);
    return structuredClone(next);
  }

  /** Đánh dấu job xong / fail / huỷ (chỉ job queued/running/preempted mới kết thúc được). */
  finish(jobId: string, status: 'completed' | 'failed' | 'cancelled', now: number = Date.now()): FleetV23Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job "${jobId}" không có trong hàng đợi scheduler v23.`);
    if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'preempted') {
      throw new Error(`Job "${jobId}" đang "${job.status}" — không kết thúc được nữa.`);
    }
    const next: FleetV23Job = { ...job, status, startedAt: job.startedAt ?? now };
    this.jobs.set(jobId, next);
    return structuredClone(next);
  }

  /** Xoá job khỏi hàng đợi (chỉ job đã kết thúc mới xoá được — job đang chạy/queued phải finish/cancel trước). */
  remove(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'queued' || job.status === 'running') {
      throw new Error(`Job "${jobId}" đang "${job.status}" — finish/cancel trước khi xoá khỏi hàng đợi.`);
    }
    return this.jobs.delete(jobId);
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Số job queued. */
  get queuedCount(): number {
    return this.byStatus('queued').length;
  }

  /** Số job đang chạy. */
  get runningCount(): number {
    return this.byStatus('running').length;
  }
}

// ---------------------------------------------------------------------------
// SLA: breach + thời gian chờ
// ---------------------------------------------------------------------------

/** Kết quả kiểm tra SLA của một job tại `now`. */
export interface FleetV23SlaCheck {
  jobId: string;
  /** Có deadline SLA không. */
  hasSla: boolean;
  /** Đã quá deadline chưa (chỉ tính khi job chưa chạy xong). */
  breached: boolean;
  /** Còn bao nhiêu ms tới deadline (âm = đã quá; null khi không có SLA). */
  remainingMs: number | null;
  /** Đã chờ bao nhiêu ms từ lúc nộp (job queued) hoặc tới lúc chạy. */
  waitedMs: number;
}

/** Kiểm tra SLA một job. */
export function checkFleetV23Sla(job: FleetV23Job, now: number = Date.now()): FleetV23SlaCheck {
  const waitedMs = Math.max(0, (job.startedAt ?? now) - job.submittedAt);
  if (job.slaDeadlineMs === undefined) {
    return { jobId: job.id, hasSla: false, breached: false, remainingMs: null, waitedMs };
  }
  const remainingMs = job.slaDeadlineMs - now;
  const breached =
    (job.status === 'queued' || job.status === 'running' || job.status === 'preempted') && remainingMs < 0;
  return { jobId: job.id, hasSla: true, breached, remainingMs, waitedMs };
}

/** Job queued nào đã breach SLA tại `now` (sắp theo deadline sớm nhất). */
export function breachedSlaJobsV23(jobs: readonly FleetV23Job[], now: number = Date.now()): FleetV23Job[] {
  return jobs
    .filter((j) => j.status === 'queued' && checkFleetV23Sla(j, now).breached)
    .sort((a, b) => (a.slaDeadlineMs as number) - (b.slaDeadlineMs as number));
}

// ---------------------------------------------------------------------------
// Preemption: job critical cướp chỗ job thấp hơn
// ---------------------------------------------------------------------------

/** Cấu hình preemption. */
export interface FleetV23PreemptionPolicy {
  /** Job đang chạy ít nhất bao nhiêu ms mới được preempt (tránh cướp job vừa bắt đầu). */
  minRuntimeBeforePreemptMs: number;
  /** Có cho phép preempt job `high` không (critical thì không bao giờ bị preempt). */
  allowPreemptHigh: boolean;
}

/** Preemption mặc định: job chạy ít nhất 30s mới bị cướp; được cướp job high. */
export const DEFAULT_FLEET_V23_PREEMPTION_POLICY: FleetV23PreemptionPolicy = {
  minRuntimeBeforePreemptMs: 30_000,
  allowPreemptHigh: true,
};

/** Quyết định preemption: cướp job nào để nhường chỗ cho job mới. */
export type FleetV23PreemptionDecision =
  | {
      preempt: true;
      /** Job mới sẽ chạy. */
      incomingJobId: string;
      /** Job đang chạy bị cướp (quay lại hàng đợi). */
      victimJobId: string;
      reason: string;
    }
  | { preempt: false; incomingJobId: string; reason: string };

/**
 * Chọn nạn nhân preemption cho job mới vào:
 * - Chỉ job `critical` mới được preempt (job khác hết chỗ thì chờ).
 * - Nạn nhân phải đang `running`, priority thấp hơn `critical`,
 *   (`high` chỉ khi policy cho phép), đã chạy đủ lâu, chưa bị
 *   preempt quá `FLEET_V23_MAX_PREEMPTIONS` lần.
 * - Trong các nạn nhân đủ điều kiện: priority thấp nhất thắng; hoà
 *   thì job còn lâu nhất (estimated - đã chạy) thắng — cướp job tốn
 *   ít tiến độ nhất theo tỉ lệ? Không: cướp job còn lâu nhất vì nó
 *   giữ chỗ lâu nhất; job gần xong thì để nó xong cho rồi.
 * - Không có nạn nhân → không preempt, job mới chờ.
 */
export function decideFleetV23Preemption(
  incoming: FleetV23Job,
  running: readonly FleetV23Job[],
  policy: FleetV23PreemptionPolicy = DEFAULT_FLEET_V23_PREEMPTION_POLICY,
  now: number = Date.now(),
): FleetV23PreemptionDecision {
  if (incoming.priority !== 'critical') {
    return {
      preempt: false,
      incomingJobId: incoming.id,
      reason: `Job "${incoming.id}" ưu tiên "${incoming.priority}" — chỉ job critical mới được preempt job đang chạy, job này chờ hàng đợi.`,
    };
  }
  const candidates = running.filter((r) => {
    if (r.status !== 'running') return false;
    if (r.priority === 'critical') return false;
    if (r.priority === 'high' && !policy.allowPreemptHigh) return false;
    if (r.preemptCount >= FLEET_V23_MAX_PREEMPTIONS) return false;
    if (r.startedAt === null) return false;
    if (now - r.startedAt < policy.minRuntimeBeforePreemptMs) return false;
    return true;
  });
  if (candidates.length === 0) {
    return {
      preempt: false,
      incomingJobId: incoming.id,
      reason: `Job critical "${incoming.id}" muốn preempt nhưng không có job đang chạy nào đủ điều kiện (critical / mới chạy / đã preempt ${FLEET_V23_MAX_PREEMPTIONS} lần).`,
    };
  }
  const rank = (j: FleetV23Job): number => FLEET_V23_PRIORITY_BASE_SCORE[j.priority];
  const remaining = (j: FleetV23Job): number =>
    j.estimatedMs - (j.startedAt === null ? 0 : now - j.startedAt);
  const sorted = [...candidates].sort(
    (a, b) => rank(a) - rank(b) || remaining(b) - remaining(a) || a.id.localeCompare(b.id),
  );
  const victim = sorted[0] as FleetV23Job;
  return {
    preempt: true,
    incomingJobId: incoming.id,
    victimJobId: victim.id,
    reason:
      `Job critical "${incoming.id}" preempt job "${victim.id}" (ưu tiên "${victim.priority}", ` +
      `đã chạy ${now - (victim.startedAt as number)}ms, còn ~${Math.max(0, remaining(victim))}ms) — ` +
      `job bị cướp quay lại hàng đợi.`,
  };
}

/**
 * Thực hiện preemption trên queue: nạn nhân → `preempted` (quay lại
 * hàng đợi, preemptCount +1), job mới → `running`. Quyết định không
 * preempt → throw (caller kiểm tra `decide` trước).
 */
export function applyFleetV23Preemption(
  queue: FleetV23SchedulerQueue,
  decision: Extract<FleetV23PreemptionDecision, { preempt: true }>,
  now: number = Date.now(),
): { victim: FleetV23Job; incoming: FleetV23Job } {
  const victim = queue.preempt(decision.victimJobId, decision.reason);
  const incoming = queue.start(decision.incomingJobId, now);
  return { victim, incoming };
}

/**
 * Ảnh chụp hàng đợi: bao nhiêu job mỗi trạng thái/priority, job breach
 * SLA, job chờ lâu nhất — để dashboard đọc.
 */
export function snapshotFleetV23Queue(
  jobs: readonly FleetV23Job[],
  now: number = Date.now(),
): {
  total: number;
  queued: number;
  running: number;
  preempted: number;
  completed: number;
  failed: number;
  cancelled: number;
  byPriorityQueued: Record<FleetV23Priority, number>;
  breachedSlaIds: string[];
  longestWaitingJobId: string | null;
  longestWaitMs: number;
} {
  const count = (s: FleetV23JobStatus): number => jobs.filter((j) => j.status === s).length;
  const queued = jobs.filter((j) => j.status === 'queued');
  const byPriorityQueued = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  } as Record<FleetV23Priority, number>;
  for (const j of queued) byPriorityQueued[j.priority] += 1;
  let longest: FleetV23Job | null = null;
  for (const j of queued) {
    if (longest === null || j.submittedAt < longest.submittedAt) longest = j;
  }
  return {
    total: jobs.length,
    queued: count('queued'),
    running: count('running'),
    preempted: count('preempted'),
    completed: count('completed'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    byPriorityQueued,
    breachedSlaIds: breachedSlaJobsV23(jobs, now).map((j) => j.id),
    longestWaitingJobId: longest?.id ?? null,
    longestWaitMs: longest === null ? 0 : Math.max(0, now - longest.submittedAt),
  };
}
