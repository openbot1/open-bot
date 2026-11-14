/**
 * Fleet campaign v5 — điều phối nhiều agent trên nhiều repo cùng lúc
 * (v1.08, Đội T6).
 *
 * Một campaign = 1 mục tiêu lớn, tách thành nhiều task chạy trên nhiều
 * repo. Mỗi task có repo + title + brief + độ ưu tiên + các đường dẫn
 * nó chạm tới (paths) + task nó phụ thuộc (dependsOn).
 *
 * - Hàng đợi theo độ ưu tiên: task được claim theo điểm ưu tiên
 *   (critical > high > medium > low), task chờ lâu được cộng điểm
 *   "aging" để không bị đói; task có dependsOn chưa xong thì không
 *   được claim; task xung đột file với task đang chạy thì bị bỏ qua
 *   cho tới khi task kia xong.
 * - Dedup: 2 task cùng repo + cùng title đã chuẩn hoá + cùng tập paths
 *   thì chỉ giữ 1 — task thứ hai trả về task đã có, campaign đếm
 *   `dedupMerged` để biết đã gộp bao nhiêu.
 * - Conflict guard theo dependency sweep: interface `DependencySweep`
 *   do module này tự định nghĩa (không đợi code T3, không copy code
 *   T3). `analyzeImportGraph` quét import/require từ nội dung file do
 *   caller cung cấp (thuần, không đọc đĩa) rồi dựng đồ thị; `findCampaignConflicts`
 *   báo 3 loại xung đột: cùng file, chồng đường dẫn (thư mục chứa file
 *   của task kia), và thứ tự phụ thuộc (task A import file task B sở
 *   hữu → B phải xong trước A).
 * - Campaign + task lưu ở `<fleetRoot>/fleet-campaigns-v108.json`
 *   (ghi atomic tmp + rename, mode 0600 — cùng tư thế với quotas).
 *
 * Chỉ local: campaign không biết gì về máy khác, không gọi mạng, không
 * chạy git — host quyết định khi nào dispatch bot thật.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Độ ưu tiên của task trong campaign. */
export const FLEET_V5_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FleetV5Priority = (typeof FLEET_V5_PRIORITIES)[number];

/** Trọng số ưu tiên (claim sort theo điểm này trước, rồi tới createdAt). */
export const FLEET_V5_PRIORITY_WEIGHTS: Record<FleetV5Priority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Trạng thái của một task trong campaign. */
export const FLEET_V5_TASK_STATUSES = [
  'queued',
  'assigned',
  'running',
  'done',
  'failed',
  'cancelled',
  'blocked',
] as const;
export type FleetV5TaskStatus = (typeof FLEET_V5_TASK_STATUSES)[number];

/** Trạng thái của một campaign. */
export const FLEET_V5_CAMPAIGN_STATUSES = ['active', 'paused', 'done', 'cancelled'] as const;
export type FleetV5CampaignStatus = (typeof FLEET_V5_CAMPAIGN_STATUSES)[number];

export const FLEET_V5_CAMPAIGNS_FILE = 'fleet-campaigns-v108.json';
/** Task chờ đủ lâu thì được cộng 1 điểm aging (mặc định 30 phút). */
export const FLEET_V5_DEFAULT_AGING_MS = 30 * 60_000;
/** Cộng tối đa 2 điểm aging — task low không bao giờ vượt critical mới. */
export const FLEET_V5_MAX_AGING_BONUS = 2;
/** Số lần fail tối đa trước khi task bị đánh failed hẳn. */
export const FLEET_V5_DEFAULT_MAX_ATTEMPTS = 3;

export interface FleetV5TaskHistoryEntry {
  at: number;
  status: FleetV5TaskStatus;
  note?: string;
}

export interface FleetV5Task {
  id: string;
  campaignId: string;
  repo: string;
  title: string;
  brief: string;
  priority: FleetV5Priority;
  status: FleetV5TaskStatus;
  /** Đường dẫn (file/thư mục, tương đối với repo root) task chạm tới. */
  paths: string[];
  /** Id các task phải done trước task này. */
  dependsOn: string[];
  assignedBotId: string | null;
  attempts: number;
  /** Fingerprint dedup (repo + title chuẩn hoá + paths đã sort). */
  fingerprint: string;
  /** Task này là bản gộp của task đã có (id đó) — chỉ set khi dedup. */
  dedupOf?: string;
  createdAt: number;
  updatedAt: number;
  history: FleetV5TaskHistoryEntry[];
}

export interface FleetV5Campaign {
  id: string;
  goal: string;
  status: FleetV5CampaignStatus;
  repos: string[];
  tasks: FleetV5Task[];
  /** Số task đã bị gộp bởi dedup kể từ khi campaign được tạo. */
  dedupMerged: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFleetV5CampaignInput {
  goal: string;
  repos: string[];
  id?: string;
  tasks?: CreateFleetV5TaskInput[];
}

export interface CreateFleetV5TaskInput {
  repo: string;
  title: string;
  brief: string;
  priority?: FleetV5Priority;
  paths?: string[];
  dependsOn?: string[];
  id?: string;
}

export interface FleetV5CampaignSummary {
  id: string;
  goal: string;
  status: FleetV5CampaignStatus;
  repos: string[];
  totalTasks: number;
  queued: number;
  assigned: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  blocked: number;
  dedupMerged: number;
  /** Phần trăm task đã done (0..100, 0 khi chưa có task). */
  progressPercent: number;
  createdAt: number;
  updatedAt: number;
}

export function getFleetV5CampaignsPath(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('fleet v5 campaigns need a non-empty fleetRoot.');
  }
  return path.join(fleetRoot, FLEET_V5_CAMPAIGNS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Chuẩn hoá một path: slash xuôi, bỏ `./` đầu, bỏ `/` cuối. */
export function normalizeCampaignPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Hai path chồng nhau khi bằng nhau, hoặc một cái là thư mục cha của
 * cái kia (`packages/core/src/fleet/` chứa `packages/core/src/fleet/quotas.ts`).
 */
export function campaignPathsOverlap(a: string, b: string): boolean {
  const na = normalizeCampaignPath(a);
  const nb = normalizeCampaignPath(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  return na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Fingerprint dedup: repo (lowercase) + title chuẩn hoá + paths đã
 * chuẩn hoá và sort. Hai task cùng fingerprint là cùng một việc.
 */
export function taskFingerprint(repo: string, title: string, paths: string[]): string {
  const normPaths = [...new Set(paths.map(normalizeCampaignPath).filter((p) => p.length > 0))].sort();
  return `${repo.trim().toLowerCase()}|${normalizeTitle(title)}|${normPaths.join(',')}`;
}

function validatePriority(value: unknown, where: string): FleetV5Priority {
  if (typeof value === 'string' && (FLEET_V5_PRIORITIES as readonly string[]).includes(value)) {
    return value as FleetV5Priority;
  }
  throw new Error(`${where} priority phải là một trong: ${FLEET_V5_PRIORITIES.join(', ')}.`);
}

function validateStringArray(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${where} phải là mảng chuỗi.`);
  }
  return [...(value as string[])];
}

export function validateFleetV5Task(raw: unknown): FleetV5Task {
  if (!isRecord(raw)) throw new Error('fleet v5 task must be an object.');
  const { id, campaignId, repo, title, brief, priority, status, paths, dependsOn } = raw;
  if (!isNonEmptyString(id)) throw new Error('fleet v5 task needs a non-empty id.');
  if (!isNonEmptyString(campaignId)) throw new Error('fleet v5 task needs a non-empty campaignId.');
  if (!isNonEmptyString(repo)) throw new Error('fleet v5 task needs a non-empty repo.');
  if (!isNonEmptyString(title)) throw new Error('fleet v5 task needs a non-empty title.');
  if (!isNonEmptyString(brief)) throw new Error('fleet v5 task needs a non-empty brief.');
  const prio = validatePriority(priority, 'fleet v5 task');
  if (typeof status !== 'string' || !(FLEET_V5_TASK_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`fleet v5 task status phải là một trong: ${FLEET_V5_TASK_STATUSES.join(', ')}.`);
  }
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new Error('fleet v5 task paths phải là mảng chuỗi.');
  }
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
    throw new Error('fleet v5 task dependsOn phải là mảng chuỗi.');
  }
  if (typeof raw['attempts'] !== 'number' || !Number.isInteger(raw['attempts']) || (raw['attempts'] as number) < 0) {
    throw new Error('fleet v5 task attempts phải là số nguyên >= 0.');
  }
  if (typeof raw['createdAt'] !== 'number' || typeof raw['updatedAt'] !== 'number') {
    throw new Error('fleet v5 task needs numeric createdAt/updatedAt.');
  }
  if (!Array.isArray(raw['history'])) throw new Error('fleet v5 task history phải là mảng.');
  const assignedBotId = raw['assignedBotId'];
  if (assignedBotId !== null && typeof assignedBotId !== 'string') {
    throw new Error('fleet v5 task assignedBotId phải là chuỗi hoặc null.');
  }
  const fingerprint = taskFingerprint(repo as string, title as string, paths as string[]);
  return {
    id: (id as string).trim(),
    campaignId: (campaignId as string).trim(),
    repo: (repo as string).trim(),
    title: (title as string).trim(),
    brief: (brief as string).trim(),
    priority: prio,
    status: status as FleetV5TaskStatus,
    paths: (paths as string[]).map(normalizeCampaignPath).filter((p) => p.length > 0),
    dependsOn: [...new Set((dependsOn as string[]).map((d) => d.trim()).filter((d) => d.length > 0))],
    assignedBotId: assignedBotId as string | null,
    attempts: raw['attempts'] as number,
    fingerprint,
    ...(typeof raw['dedupOf'] === 'string' && (raw['dedupOf'] as string).trim().length > 0
      ? { dedupOf: (raw['dedupOf'] as string).trim() }
      : {}),
    createdAt: raw['createdAt'] as number,
    updatedAt: raw['updatedAt'] as number,
    history: (raw['history'] as FleetV5TaskHistoryEntry[]).map((h) => ({
      at: h.at,
      status: h.status,
      ...(typeof h.note === 'string' ? { note: h.note } : {}),
    })),
  };
}

export function validateFleetV5Campaign(raw: unknown): FleetV5Campaign {
  if (!isRecord(raw)) throw new Error('fleet v5 campaign must be an object.');
  if (!isNonEmptyString(raw['id'])) throw new Error('fleet v5 campaign needs a non-empty id.');
  if (!isNonEmptyString(raw['goal'])) throw new Error('fleet v5 campaign needs a non-empty goal.');
  if (
    typeof raw['status'] !== 'string' ||
    !(FLEET_V5_CAMPAIGN_STATUSES as readonly string[]).includes(raw['status'])
  ) {
    throw new Error(`fleet v5 campaign status phải là một trong: ${FLEET_V5_CAMPAIGN_STATUSES.join(', ')}.`);
  }
  if (!Array.isArray(raw['repos']) || raw['repos'].some((r) => typeof r !== 'string')) {
    throw new Error('fleet v5 campaign repos phải là mảng chuỗi.');
  }
  if (!Array.isArray(raw['tasks'])) throw new Error('fleet v5 campaign tasks phải là mảng.');
  if (typeof raw['dedupMerged'] !== 'number' || (raw['dedupMerged'] as number) < 0) {
    throw new Error('fleet v5 campaign dedupMerged phải là số >= 0.');
  }
  if (typeof raw['createdAt'] !== 'number' || typeof raw['updatedAt'] !== 'number') {
    throw new Error('fleet v5 campaign needs numeric createdAt/updatedAt.');
  }
  const tasks = (raw['tasks'] as unknown[]).map((t, i) => {
    try {
      return validateFleetV5Task(t);
    } catch (err) {
      throw new Error(`fleet v5 campaign task[${i}]: ${(err as Error).message}`);
    }
  });
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new Error('fleet v5 campaign có task id trùng nhau.');
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`fleet v5 task "${task.id}" dependsOn task không tồn tại: "${dep}".`);
      }
      if (dep === task.id) throw new Error(`fleet v5 task "${task.id}" không được dependsOn chính nó.`);
    }
  }
  return {
    id: (raw['id'] as string).trim(),
    goal: (raw['goal'] as string).trim(),
    status: raw['status'] as FleetV5CampaignStatus,
    repos: [...new Set((raw['repos'] as string[]).map((r) => r.trim()).filter((r) => r.length > 0))],
    tasks,
    dedupMerged: raw['dedupMerged'] as number,
    createdAt: raw['createdAt'] as number,
    updatedAt: raw['updatedAt'] as number,
  };
}

/** Tạo campaign mới (chưa lưu — caller gọi saveFleetV5Campaigns). */
export function createFleetV5Campaign(input: CreateFleetV5CampaignInput, now = Date.now()): FleetV5Campaign {
  if (!isNonEmptyString(input.goal)) throw new Error('fleet v5 campaign cần goal không rỗng.');
  if (!Array.isArray(input.repos) || input.repos.length === 0) {
    throw new Error('fleet v5 campaign cần ít nhất 1 repo.');
  }
  const repos = [...new Set(input.repos.map((r) => r.trim()).filter((r) => r.length > 0))];
  if (repos.length === 0) throw new Error('fleet v5 campaign cần ít nhất 1 repo không rỗng.');
  const campaign: FleetV5Campaign = {
    id: typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : newId('cmp'),
    goal: input.goal.trim(),
    status: 'active',
    repos,
    tasks: [],
    dedupMerged: 0,
    createdAt: now,
    updatedAt: now,
  };
  for (const taskInput of input.tasks ?? []) {
    addFleetV5Task(campaign, taskInput, now);
  }
  return campaign;
}

/** Tìm task trùng fingerprint trong campaign (dedup), hoặc undefined. */
export function findDuplicateFleetV5Task(
  campaign: FleetV5Campaign,
  input: CreateFleetV5TaskInput,
): FleetV5Task | undefined {
  const fingerprint = taskFingerprint(input.repo, input.title, input.paths ?? []);
  return campaign.tasks.find((t) => t.fingerprint === fingerprint && t.status !== 'cancelled');
}

/**
 * Thêm task vào campaign. Task trùng (dedup) thì KHÔNG tạo mới: trả về
 * task đã có kèm `deduplicated: true`, campaign.dedupMerged tăng 1.
 */
export function addFleetV5Task(
  campaign: FleetV5Campaign,
  input: CreateFleetV5TaskInput,
  now = Date.now(),
): { task: FleetV5Task; deduplicated: boolean; existingTaskId?: string } {
  if (!isNonEmptyString(input.repo)) throw new Error('fleet v5 task cần repo không rỗng.');
  if (!isNonEmptyString(input.title)) throw new Error('fleet v5 task cần title không rỗng.');
  if (!isNonEmptyString(input.brief)) throw new Error('fleet v5 task cần brief không rỗng.');
  const duplicate = findDuplicateFleetV5Task(campaign, input);
  if (duplicate) {
    campaign.dedupMerged += 1;
    campaign.updatedAt = now;
    return { task: duplicate, deduplicated: true, existingTaskId: duplicate.id };
  }
  const priority = input.priority === undefined ? 'medium' : validatePriority(input.priority, 'fleet v5 task');
  const paths = [...new Set((input.paths ?? []).map(normalizeCampaignPath).filter((p) => p.length > 0))];
  const dependsOn = [...new Set((input.dependsOn ?? []).map((d) => d.trim()).filter((d) => d.length > 0))];
  const taskId =
    typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : newId('task');
  if (campaign.tasks.some((t) => t.id === taskId)) {
    throw new Error(`fleet v5 campaign đã có task id "${taskId}".`);
  }
  for (const dep of dependsOn) {
    if (dep === taskId) throw new Error('fleet v5 task không được dependsOn chính nó.');
    if (!campaign.tasks.some((t) => t.id === dep)) {
      throw new Error(`fleet v5 task dependsOn task không tồn tại trong campaign: "${dep}".`);
    }
  }
  if (!campaign.repos.some((r) => r.toLowerCase() === input.repo.trim().toLowerCase())) {
    campaign.repos.push(input.repo.trim());
  }
  const task: FleetV5Task = {
    id: taskId,
    campaignId: campaign.id,
    repo: input.repo.trim(),
    title: input.title.trim(),
    brief: input.brief.trim(),
    priority,
    status: 'queued',
    paths,
    dependsOn,
    assignedBotId: null,
    attempts: 0,
    fingerprint: taskFingerprint(input.repo, input.title, paths),
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, status: 'queued' }],
  };
  campaign.tasks.push(task);
  campaign.updatedAt = now;
  return { task, deduplicated: false };
}

/** Load tất cả campaign (file chưa có = chưa có campaign nào). */
export function loadFleetV5Campaigns(fleetRoot: string): FleetV5Campaign[] {
  const filePath = getFleetV5CampaignsPath(fleetRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FLEET_V5_CAMPAIGNS_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_V5_CAMPAIGNS_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateFleetV5Campaign(entry);
    } catch (err) {
      throw new Error(`${FLEET_V5_CAMPAIGNS_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Lưu tất cả campaign (atomic tmp + rename, mode 0600). */
export function saveFleetV5Campaigns(fleetRoot: string, campaigns: FleetV5Campaign[]): void {
  const valid = campaigns.map((c) => validateFleetV5Campaign(c));
  const filePath = getFleetV5CampaignsPath(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

export function findFleetV5Campaign(campaigns: FleetV5Campaign[], id: string): FleetV5Campaign | undefined {
  return campaigns.find((c) => c.id === id);
}

export function findFleetV5Task(campaign: FleetV5Campaign, taskId: string): FleetV5Task | undefined {
  return campaign.tasks.find((t) => t.id === taskId);
}

/** Tóm tắt một campaign: đếm theo trạng thái + tiến độ %. `blocked`
 * là số task đang kẹt vì dependsOn failed/cancelled (xem
 * blockedFleetV5Tasks) cộng task có status 'blocked' — một task kẹt
 * vẫn giữ nguyên status queued của nó nên blocked là lớp phủ, không
 * cộng dồn vào tổng. */
export function summarizeFleetV5Campaign(campaign: FleetV5Campaign): FleetV5CampaignSummary {
  const counts: Record<FleetV5TaskStatus, number> = {
    queued: 0,
    assigned: 0,
    running: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    blocked: 0,
  };
  for (const task of campaign.tasks) counts[task.status] += 1;
  const blockedIds = new Set([
    ...blockedFleetV5Tasks(campaign).map((t) => t.id),
    ...campaign.tasks.filter((t) => t.status === 'blocked').map((t) => t.id),
  ]);
  counts.blocked = blockedIds.size;
  const total = campaign.tasks.length;
  return {
    id: campaign.id,
    goal: campaign.goal,
    status: campaign.status,
    repos: [...campaign.repos],
    totalTasks: total,
    ...counts,
    dedupMerged: campaign.dedupMerged,
    progressPercent: total === 0 ? 0 : Math.round((counts.done / total) * 100),
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

/** true khi mọi dependsOn của task đã done. */
export function taskDependenciesDone(campaign: FleetV5Campaign, task: FleetV5Task): boolean {
  return task.dependsOn.every((depId) => {
    const dep = findFleetV5Task(campaign, depId);
    return dep !== undefined && dep.status === 'done';
  });
}

/**
 * Điểm xếp hàng của task: trọng số ưu tiên + điểm aging (mỗi
 * `agingMs` chờ được +1, tối đa +2). Điểm cao claim trước; hoà thì
 * task tạo trước claim trước.
 */
export function fleetV5QueueScore(task: FleetV5Task, now = Date.now(), agingMs = FLEET_V5_DEFAULT_AGING_MS): number {
  const waited = Math.max(0, now - task.createdAt);
  const bonus = Math.min(FLEET_V5_MAX_AGING_BONUS, Math.floor(waited / agingMs));
  return FLEET_V5_PRIORITY_WEIGHTS[task.priority] + bonus;
}

function taskTouchesPaths(task: FleetV5Task, paths: string[]): boolean {
  return task.paths.some((p) => paths.some((q) => campaignPathsOverlap(p, q)));
}

/**
 * Task có xung đột với task đang chạy/gán không: cùng repo + chồng
 * paths với một task active khác. Xung đột thì chưa claim được.
 */
export function fleetV5TaskConflictsWithActive(task: FleetV5Task, activeTasks: FleetV5Task[]): FleetV5Task | undefined {
  return activeTasks.find(
    (other) =>
      other.id !== task.id &&
      other.repo.toLowerCase() === task.repo.toLowerCase() &&
      taskTouchesPaths(task, other.paths),
  );
}

export interface ClaimFleetV5TaskOptions {
  /** Số task active tối đa một bot giữ cùng lúc (mặc định 1). */
  maxActivePerBot?: number;
  agingMs?: number;
  /** Chỉ claim trong campaign này (mặc định: mọi campaign active). */
  campaignId?: string;
}

export interface ClaimFleetV5TaskResult {
  task: FleetV5Task | null;
  /** Lý do không claim được task nào (null khi claim được). */
  reason: string | null;
  /** Số task queued đã bị bỏ qua vì dependsOn chưa xong / xung đột. */
  skipped: number;
}

/**
 * Claim task tiếp theo cho một bot: quét mọi campaign active, lấy task
 * queued có điểm cao nhất mà (a) dependsOn đã done, (b) không xung
 * đột file với task đang chạy, (c) bot chưa vượt maxActivePerBot.
 * Claim xong task chuyển sang 'assigned' + gắn bot.
 */
export function claimNextFleetV5Task(
  campaigns: FleetV5Campaign[],
  botId: string,
  now = Date.now(),
  options: ClaimFleetV5TaskOptions = {},
): ClaimFleetV5TaskResult {
  if (!isNonEmptyString(botId)) throw new Error('claim fleet v5 task cần botId không rỗng.');
  const maxActive = options.maxActivePerBot ?? 1;
  const agingMs = options.agingMs ?? FLEET_V5_DEFAULT_AGING_MS;
  const allTasks = campaigns.flatMap((c) => c.tasks);
  const activeForBot = allTasks.filter(
    (t) => t.assignedBotId === botId && (t.status === 'assigned' || t.status === 'running'),
  );
  if (activeForBot.length >= maxActive) {
    return { task: null, reason: `Bot "${botId.trim()}" đã giữ ${activeForBot.length} task active (tối đa ${maxActive}).`, skipped: 0 };
  }
  const activeTasks = allTasks.filter((t) => t.status === 'assigned' || t.status === 'running');
  const candidates: { task: FleetV5Task; campaign: FleetV5Campaign; score: number }[] = [];
  let skipped = 0;
  for (const campaign of campaigns) {
    if (campaign.status !== 'active') continue;
    if (options.campaignId !== undefined && campaign.id !== options.campaignId) continue;
    for (const task of campaign.tasks) {
      if (task.status !== 'queued') continue;
      if (!taskDependenciesDone(campaign, task)) {
        skipped += 1;
        continue;
      }
      if (fleetV5TaskConflictsWithActive(task, activeTasks) !== undefined) {
        skipped += 1;
        continue;
      }
      candidates.push({ task, campaign, score: fleetV5QueueScore(task, now, agingMs) });
    }
  }
  if (candidates.length === 0) {
    return { task: null, reason: 'Không có task queued nào claim được (hết task, dependsOn chưa xong, hoặc xung đột file với task đang chạy).', skipped };
  }
  candidates.sort((a, b) => b.score - a.score || a.task.createdAt - b.task.createdAt);
  const picked = candidates[0].task;
  picked.status = 'assigned';
  picked.assignedBotId = botId.trim();
  picked.updatedAt = now;
  picked.history.push({ at: now, status: 'assigned', note: `Claimed by bot "${botId.trim()}".` });
  candidates[0].campaign.updatedAt = now;
  return { task: picked, reason: null, skipped };
}

function setTaskStatus(
  campaign: FleetV5Campaign,
  task: FleetV5Task,
  status: FleetV5TaskStatus,
  now: number,
  note?: string,
): FleetV5Task {
  task.status = status;
  task.updatedAt = now;
  task.history.push({ at: now, status, ...(note !== undefined ? { note } : {}) });
  campaign.updatedAt = now;
  return task;
}

/** Đánh dấu task đang chạy (chỉ từ assigned). */
export function startFleetV5Task(campaign: FleetV5Campaign, taskId: string, now = Date.now()): FleetV5Task {
  const task = findFleetV5Task(campaign, taskId);
  if (!task) throw new Error(`Không có task "${taskId}" trong campaign "${campaign.id}".`);
  if (task.status !== 'assigned') {
    throw new Error(`Task "${taskId}" đang ${task.status} — chỉ start được task assigned.`);
  }
  return setTaskStatus(campaign, task, 'running', now);
}

/** Hoàn thành task (done). Trả về task đã cập nhật. */
export function completeFleetV5Task(
  campaign: FleetV5Campaign,
  taskId: string,
  now = Date.now(),
  note?: string,
): FleetV5Task {
  const task = findFleetV5Task(campaign, taskId);
  if (!task) throw new Error(`Không có task "${taskId}" trong campaign "${campaign.id}".`);
  if (task.status !== 'assigned' && task.status !== 'running') {
    throw new Error(`Task "${taskId}" đang ${task.status} — chỉ complete được task assigned/running.`);
  }
  return setTaskStatus(campaign, task, 'done', now, note);
}

/**
 * Task fail: attempts tăng 1; còn lượt thì về lại 'queued' để bot khác
 * (hoặc cùng bot) claim lại, hết lượt thì 'failed' hẳn.
 */
export function failFleetV5Task(
  campaign: FleetV5Campaign,
  taskId: string,
  maxAttempts = FLEET_V5_DEFAULT_MAX_ATTEMPTS,
  now = Date.now(),
  note?: string,
): FleetV5Task {
  const task = findFleetV5Task(campaign, taskId);
  if (!task) throw new Error(`Không có task "${taskId}" trong campaign "${campaign.id}".`);
  if (task.status !== 'assigned' && task.status !== 'running') {
    throw new Error(`Task "${taskId}" đang ${task.status} — chỉ fail được task assigned/running.`);
  }
  task.attempts += 1;
  const next: FleetV5TaskStatus = task.attempts >= maxAttempts ? 'failed' : 'queued';
  if (next === 'queued') task.assignedBotId = null;
  return setTaskStatus(
    campaign,
    task,
    next,
    now,
    note ?? (next === 'failed' ? `Failed sau ${task.attempts} lần thử.` : `Fail lần ${task.attempts}/${maxAttempts} — requeue.`),
  );
}

/** Huỷ một task (queued/assigned/running đều huỷ được). */
export function cancelFleetV5Task(campaign: FleetV5Campaign, taskId: string, now = Date.now(), note?: string): FleetV5Task {
  const task = findFleetV5Task(campaign, taskId);
  if (!task) throw new Error(`Không có task "${taskId}" trong campaign "${campaign.id}".`);
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new Error(`Task "${taskId}" đã ${task.status} — không huỷ được.`);
  }
  task.assignedBotId = null;
  return setTaskStatus(campaign, task, 'cancelled', now, note);
}

/** Đổi trạng thái campaign (pause/resume/cancel/done). */
export function setFleetV5CampaignStatus(
  campaign: FleetV5Campaign,
  status: FleetV5CampaignStatus,
  now = Date.now(),
): FleetV5Campaign {
  if (campaign.status === 'done' || campaign.status === 'cancelled') {
    throw new Error(`Campaign "${campaign.id}" đã ${campaign.status} — không đổi trạng thái được.`);
  }
  if (status === 'done' && campaign.tasks.some((t) => t.status === 'queued' || t.status === 'assigned' || t.status === 'running')) {
    throw new Error('Campaign còn task chưa xong — không đánh done được.');
  }
  campaign.status = status;
  campaign.updatedAt = now;
  if (status === 'cancelled') {
    for (const task of campaign.tasks) {
      if (task.status === 'queued' || task.status === 'assigned' || task.status === 'running') {
        task.status = 'cancelled';
        task.assignedBotId = null;
        task.updatedAt = now;
        task.history.push({ at: now, status: 'cancelled', note: 'Campaign cancelled.' });
      }
    }
  }
  return campaign;
}

// ---------------------------------------------------------------------------
// Dependency sweep (interface riêng của T6 — không đợi/không copy code T3)
// ---------------------------------------------------------------------------

/** Một file nguồn đưa vào sweep: đường dẫn + nội dung. */
export interface DependencySweepFile {
  path: string;
  content: string;
}

/** Kết quả sweep: đồ thị import giữa các file trong tập đã cho. */
export interface DependencySweep {
  /** Mọi file đã sweep (đường dẫn chuẩn hoá, đã sort). */
  files: string[];
  /** Cạnh có hướng: file `from` import file `to`. */
  edges: { from: string; to: string }[];
  /** Kề: file → danh sách file nó import trực tiếp. */
  adjacency: Record<string, string[]>;
  /** Import không resolve được tới file nào trong tập (thư viện ngoài / file thiếu). */
  unresolved: { from: string; specifier: string }[];
}

/** Import specifier của một file: dạng `from 'x'`, `require('x')`, `import('x')`, `from x import` (Python). */
const IMPORT_PATTERNS: RegExp[] = [
  /(?:import\s+[^'";]+?\s+from\s+|export\s+[^'";]+?\s+from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g,
  /(?:require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g,
  /^\s*from\s+([\w.]+)\s+import\s+/gm,
  /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/gm,
];

function extractSpecifiers(content: string): string[] {
  const out: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      if (typeof m[1] === 'string' && m[1].length > 0) out.push(m[1]);
    }
  }
  return out;
}

const SWEEP_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.py', '.json'];

/** Resolve specifier tương đối thành path file trong tập (thử đuôi + index). */
export function resolveSweepSpecifier(fromPath: string, specifier: string, knownFiles: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null; // import tuyệt đối / package ngoài
  const dir = path.posix.dirname(fromPath);
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  const candidates = [base];
  for (const ext of SWEEP_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of SWEEP_EXTENSIONS) candidates.push(path.posix.join(base, `index${ext}`));
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  // Python: `from .util import` / `from ..shared import` — dấu chấm
  // đầu = package hiện tại (1 chấm) / package cha (2 chấm), phần còn
  // lại là đường dẫn module phân cách bằng chấm.
  if (!specifier.includes('/')) {
    const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
    if (leadingDots > 0) {
      const rest = specifier.slice(leadingDots).split('.').filter((s) => s.length > 0);
      let baseDir = dir;
      for (let i = 1; i < leadingDots; i += 1) baseDir = path.posix.dirname(baseDir);
      const pyBase = rest.length > 0 ? path.posix.join(baseDir, ...rest) : baseDir;
      for (const candidate of [`${pyBase}.py`, `${pyBase}/__init__.py`]) {
        if (knownFiles.has(candidate)) return candidate;
      }
    }
  }
  // Python: `from a.b import` (tuyệt đối trong repo) → a/b.py / a/b/__init__.py
  if (specifier.includes('.') && !specifier.includes('/')) {
    const pyBase = specifier.replace(/\./g, '/');
    for (const candidate of [`${pyBase}.py`, `${pyBase}/__init__.py`]) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Quét đồ thị import từ nội dung file do caller cung cấp. Thuần —
 * không đọc đĩa, không chạy code. File trùng path (sau chuẩn hoá)
 * thì file sau ghi đè file trước.
 */
export function analyzeImportGraph(files: DependencySweepFile[]): DependencySweep {
  if (!Array.isArray(files)) throw new Error('analyzeImportGraph cần mảng file.');
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Mỗi file sweep cần { path: string, content: string }.');
    }
    byPath.set(normalizeCampaignPath(file.path), file.content);
  }
  const knownFiles = new Set(byPath.keys());
  const fileList = [...knownFiles].sort();
  const edges: { from: string; to: string }[] = [];
  const seenEdge = new Set<string>();
  const adjacency: Record<string, string[]> = {};
  const unresolved: { from: string; specifier: string }[] = [];
  for (const filePath of fileList) {
    const content = byPath.get(filePath) ?? '';
    const targets: string[] = [];
    for (const specifier of extractSpecifiers(content)) {
      if (!specifier.startsWith('.')) {
        // Import package ngoài (vd 'node:fs', 'react') — không phải
        // cạnh nội bộ, nhưng ghi lại để caller biết sweep đã thấy.
        continue;
      }
      const resolved = resolveSweepSpecifier(filePath, specifier, knownFiles);
      if (resolved === null) {
        unresolved.push({ from: filePath, specifier });
        continue;
      }
      if (resolved === filePath) continue; // tự import chính mình: bỏ qua
      const key = `${filePath}\n${resolved}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ from: filePath, to: resolved });
      targets.push(resolved);
    }
    adjacency[filePath] = [...new Set(targets)].sort();
  }
  edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
  return { files: fileList, edges, adjacency, unresolved };
}

// ---------------------------------------------------------------------------
// Conflict guard
// ---------------------------------------------------------------------------

export type FleetV5ConflictKind = 'same-file' | 'path-overlap' | 'dependency-order';

export interface FleetV5Conflict {
  kind: FleetV5ConflictKind;
  taskAId: string;
  taskBId: string;
  /** File / đường dẫn gây xung đột (hoặc cạnh phụ thuộc). */
  detail: string;
  files: string[];
}

function taskOwnedFiles(task: FleetV5Task): string[] {
  return task.paths.map(normalizeCampaignPath).filter((p) => p.length > 0);
}

/**
 * Tìm xung đột giữa các task (mặc định chỉ task chưa xong: queued /
 * assigned / running). Cần sweep để phát hiện `dependency-order`;
 * không có sweep thì chỉ kiểm tra cùng file / chồng path.
 */
export function findCampaignConflicts(
  tasks: FleetV5Task[],
  sweep?: DependencySweep,
): FleetV5Conflict[] {
  const live = tasks.filter((t) => t.status === 'queued' || t.status === 'assigned' || t.status === 'running');
  const conflicts: FleetV5Conflict[] = [];
  const seen = new Set<string>();
  const push = (c: FleetV5Conflict): void => {
    const key = `${c.kind}|${[c.taskAId, c.taskBId].sort().join('|')}|${c.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push(c);
  };
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      if (a.repo.toLowerCase() !== b.repo.toLowerCase()) continue;
      const aFiles = taskOwnedFiles(a);
      const bFiles = taskOwnedFiles(b);
      for (const fa of aFiles) {
        for (const fb of bFiles) {
          if (fa === fb) {
            push({ kind: 'same-file', taskAId: a.id, taskBId: b.id, detail: `Cả hai task cùng sửa file "${fa}".`, files: [fa] });
          } else if (campaignPathsOverlap(fa, fb)) {
            push({ kind: 'path-overlap', taskAId: a.id, taskBId: b.id, detail: `Đường dẫn "${fa}" chồng với "${fb}".`, files: [fa, fb] });
          }
        }
      }
      if (sweep !== undefined) {
        // A import file của B → B phải xong trước A (và ngược lại).
        for (const edge of sweep.edges) {
          const aOwnsFrom = aFiles.some((p) => campaignPathsOverlap(edge.from, p));
          const bOwnsTo = bFiles.some((p) => campaignPathsOverlap(edge.to, p));
          const bOwnsFrom = bFiles.some((p) => campaignPathsOverlap(edge.from, p));
          const aOwnsTo = aFiles.some((p) => campaignPathsOverlap(edge.to, p));
          if (aOwnsFrom && bOwnsTo) {
            push({ kind: 'dependency-order', taskAId: a.id, taskBId: b.id, detail: `Task "${a.id}" import "${edge.from}" → "${edge.to}" thuộc task "${b.id}" — "${b.id}" nên xong trước.`, files: [edge.from, edge.to] });
          } else if (bOwnsFrom && aOwnsTo) {
            push({ kind: 'dependency-order', taskAId: b.id, taskBId: a.id, detail: `Task "${b.id}" import "${edge.from}" → "${edge.to}" thuộc task "${a.id}" — "${a.id}" nên xong trước.`, files: [edge.from, edge.to] });
          }
        }
      }
    }
  }
  return conflicts;
}

/**
 * Chia task của campaign thành các wave chạy song song được: wave sau
 * chỉ chứa task có dependsOn nằm ở wave trước. Chu trình dependsOn →
 * throw rõ ràng.
 */
export function planCampaignWaves(campaign: FleetV5Campaign): string[][] {
  const byId = new Map(campaign.tasks.map((t) => [t.id, t]));
  const remaining = new Set(campaign.tasks.map((t) => t.id));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const id of [...remaining].sort()) {
      const task = byId.get(id);
      if (task === undefined) continue;
      if (task.dependsOn.every((dep) => done.has(dep))) wave.push(id);
    }
    if (wave.length === 0) {
      throw new Error(
        `Campaign "${campaign.id}" có chu trình dependsOn giữa các task: ${[...remaining].sort().join(', ')}.`,
      );
    }
    for (const id of wave) {
      remaining.delete(id);
      done.add(id);
    }
    waves.push(wave);
  }
  return waves;
}

/** Task nào trong campaign đang bị kẹt vì dependsOn failed/cancelled. */
export function blockedFleetV5Tasks(campaign: FleetV5Campaign): FleetV5Task[] {
  return campaign.tasks.filter(
    (task) =>
      task.status === 'queued' &&
      task.dependsOn.some((depId) => {
        const dep = findFleetV5Task(campaign, depId);
        return dep !== undefined && (dep.status === 'failed' || dep.status === 'cancelled');
      }),
  );
}
