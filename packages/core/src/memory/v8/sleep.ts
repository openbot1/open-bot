/**
 * Sleep-time compute v8 — consolidation lúc idle, có policy bền.
 *
 * Nối tiếp sleep v6 (`memory/v3/sleep.ts`: scheduler chạy nền khi
 * rảnh + consolidation 4 bước dedupe/summary/quarantine trên kho bản
 * ghi). v8 thêm ba thứ mà v6 chưa có:
 *
 *  1. `V8SleepPolicy` LƯU BỀN (file JSON trong workspace): bật/tắt,
 *     ngưỡng rảnh, giờ yên lặng (không chạy dù đang rảnh), giới hạn
 *     số lần chạy mỗi ngày. Host/UI chỉnh policy mà không cần sửa
 *     code hay khởi động lại.
 *  2. NÉN BLOCK (block-level compression): block v7 ở tier working/
 *     session, scope user, không read-only, cũ hơn ngưỡng -> gom
 *     theo (tier + scope) thành MỘT block tóm tắt ở tier semantic,
 *     rồi xóa block gốc. Bản gốc vẫn khôi phục được từ git history
 *     của projection (mỗi lần xóa là một git commit) — sleep không
 *     bao giờ xóa không dấu vết.
 *  3. DRY-RUN PREVIEW + LEDGER: `preview()` cho biết lần chạy tới sẽ
 *     làm gì (bao nhiêu bản ghi, bao nhiêu block) mà không ghi gì;
 *     mọi lần chạy đều ghi vào ledger (tối đa 50 lần gần nhất).
 *
 * Scheduler bọc `SleepV6Scheduler`: một lần chạy v8 = một lần chạy
 * v6 (dedupe/summary/quarantine bản ghi) + một bước nén block.
 * Không bao giờ chạy 2 lần chồng nhau; không chiếm turn của user
 * (chỉ chạy khi rảnh đủ lâu hoặc khi host gọi runNow tường minh).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { V6RecordStore } from '../v3/store';
import { runConsolidation, SleepV6Scheduler } from '../v3/sleep';
import type { V6SleepRunReport } from '../v3/types';
import { ageInDays } from '../v3/temporal';
import type { GitMemoryProjection, V7MemoryBlock } from '../gitProjection';
import type {
  V8BlockCompressionCandidate,
  V8BlockCompressionPlan,
  V8SleepLedgerFile,
  V8SleepPolicy,
  V8SleepPolicyFile,
  V8SleepRunReport,
} from './types';
import { DEFAULT_V8_SLEEP_POLICY } from './types';

/** Đường dẫn tương đối của policy sleep v8 trong workspace. */
export const V8_SLEEP_POLICY_REL_PATH = path.join('.open-bot', 'memory-v8-sleep-policy.json');
/** Đường dẫn tương đối của ledger sleep v8 trong workspace. */
export const V8_SLEEP_LEDGER_REL_PATH = path.join('.open-bot', 'memory-v8-sleep-ledger.json');
/** Số lần chạy tối đa giữ trong ledger. */
export const V8_SLEEP_LEDGER_KEEP = 50;
/** Actor ghi vào git/history khi sleep v8 nén block. */
export const V8_SLEEP_ACTOR = 'sleep:v8';

/** Lỗi sleep v8 — mọi message đều tiếng Việt. */
export class V8SleepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V8SleepError';
  }
}

/** Policy mặc định (bản sao mới mỗi lần gọi). */
export function defaultV8SleepPolicy(): V8SleepPolicy {
  return {
    ...DEFAULT_V8_SLEEP_POLICY,
    quietHours: { ...DEFAULT_V8_SLEEP_POLICY.quietHours },
  };
}

/** Chuẩn hoá policy đọc từ đĩa (thiếu trường -> mặc định, sai -> throw). */
export function normalizeV8SleepPolicy(raw: Partial<V8SleepPolicy>): V8SleepPolicy {
  const base = defaultV8SleepPolicy();
  const policy: V8SleepPolicy = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    idleMs: Number.isFinite(raw.idleMs) && (raw.idleMs as number) >= 0 ? Math.floor(raw.idleMs as number) : base.idleMs,
    checkIntervalMs:
      Number.isFinite(raw.checkIntervalMs) && (raw.checkIntervalMs as number) > 0
        ? Math.floor(raw.checkIntervalMs as number)
        : base.checkIntervalMs,
    quietHours: {
      startHour: clampHour(raw.quietHours?.startHour, base.quietHours.startHour),
      endHour: clampHour(raw.quietHours?.endHour, base.quietHours.endHour),
    },
    maxRunsPerDay:
      Number.isFinite(raw.maxRunsPerDay) && (raw.maxRunsPerDay as number) >= 0
        ? Math.floor(raw.maxRunsPerDay as number)
        : base.maxRunsPerDay,
    compressBlocksOlderThanDays:
      Number.isFinite(raw.compressBlocksOlderThanDays) && (raw.compressBlocksOlderThanDays as number) >= 0
        ? Math.floor(raw.compressBlocksOlderThanDays as number)
        : base.compressBlocksOlderThanDays,
    minBlocksToCompress:
      Number.isFinite(raw.minBlocksToCompress) && (raw.minBlocksToCompress as number) >= 1
        ? Math.floor(raw.minBlocksToCompress as number)
        : base.minBlocksToCompress,
    maxBlocksPerRun:
      Number.isFinite(raw.maxBlocksPerRun) && (raw.maxBlocksPerRun as number) >= 0
        ? Math.floor(raw.maxBlocksPerRun as number)
        : base.maxBlocksPerRun,
  };
  return policy;
}

function clampHour(value: unknown, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 23
    ? Math.floor(value as number)
    : fallback;
}

/** true khi `date` rơi vào giờ yên lặng của policy (giờ địa phương). */
export function isInQuietHours(policy: V8SleepPolicy, date = new Date()): boolean {
  const { startHour, endHour } = policy.quietHours;
  if (startHour === endHour) return false;
  const hour = date.getHours();
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/* ------------------------------------------------------------------ */
/* Policy store (lưu bền)                                             */
/* ------------------------------------------------------------------ */

/**
 * Store policy sleep v8 (file JSON, atomic temp + rename, mode 0600).
 * In-memory khi không có dir (dùng cho test).
 */
export class V8SleepPolicyStore {
  private readonly filePath: string | null;
  private policy: V8SleepPolicy | null = null;

  constructor(opts: { dir?: string; filePath?: string; inMemory?: boolean } = {}) {
    if (opts.inMemory) {
      this.filePath = null;
    } else if (opts.filePath) {
      this.filePath = opts.filePath;
    } else if (opts.dir) {
      this.filePath = path.join(opts.dir, V8_SLEEP_POLICY_REL_PATH);
    } else {
      this.filePath = null;
    }
  }

  static fromWorkspace(workspaceDir: string): V8SleepPolicyStore {
    return new V8SleepPolicyStore({ dir: workspaceDir });
  }

  static inMemory(): V8SleepPolicyStore {
    return new V8SleepPolicyStore({ inMemory: true });
  }

  get path(): string | null {
    return this.filePath;
  }

  /** Policy hiện tại (đọc đĩa lần đầu, thiếu file -> mặc định). */
  get(): V8SleepPolicy {
    if (this.policy) return { ...this.policy, quietHours: { ...this.policy.quietHours } };
    let raw: Partial<V8SleepPolicy> = {};
    if (this.filePath) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const file = parsed as Partial<V8SleepPolicyFile> & Partial<V8SleepPolicy>;
          raw = (file.policy ?? file) as Partial<V8SleepPolicy>;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new V8SleepError(`File policy sleep v8 hỏng: ${this.filePath}`);
        }
      }
    }
    this.policy = normalizeV8SleepPolicy(raw);
    return { ...this.policy, quietHours: { ...this.policy.quietHours } };
  }

  /** Lưu policy mới (ghi bền ngay). Trả về policy đã chuẩn hoá. */
  set(patch: Partial<V8SleepPolicy>): V8SleepPolicy {
    const next = normalizeV8SleepPolicy({ ...this.get(), ...patch });
    this.policy = next;
    if (this.filePath) {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      const payload: V8SleepPolicyFile = { version: 1, policy: next };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    }
    return { ...next, quietHours: { ...next.quietHours } };
  }
}

/* ------------------------------------------------------------------ */
/* Ledger (lịch sử lần chạy)                                          */
/* ------------------------------------------------------------------ */

/** Đọc ledger các lần chạy sleep v8 (mới nhất cuối mảng). */
export function readV8SleepLedger(workspaceDir: string): V8SleepRunReport[] {
  const filePath = path.join(workspaceDir, V8_SLEEP_LEDGER_REL_PATH);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const file = parsed as Partial<V8SleepLedgerFile>;
    if (!Array.isArray(file.runs)) return [];
    return file.runs as V8SleepRunReport[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

/** Append một báo cáo lần chạy vào ledger (giữ tối đa 50 lần gần nhất). */
export function appendV8SleepLedger(workspaceDir: string, report: V8SleepRunReport): void {
  const filePath = path.join(workspaceDir, V8_SLEEP_LEDGER_REL_PATH);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readV8SleepLedger(workspaceDir);
  existing.push(report);
  const kept = existing.slice(-V8_SLEEP_LEDGER_KEEP);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: kept } satisfies V8SleepLedgerFile, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Đếm số lần chạy trong ngày (giờ địa phương) từ ledger. */
export function countV8SleepRunsToday(workspaceDir: string, now = new Date()): number {
  const runs = readV8SleepLedger(workspaceDir);
  const day = now.toDateString();
  return runs.filter((r) => new Date(r.startedAt).toDateString() === day).length;
}

/* ------------------------------------------------------------------ */
/* Nén block v7                                                       */
/* ------------------------------------------------------------------ */

/** Block có đủ điều kiện nén không: user-scope, không read-only, tier working/session, đủ cũ. */
export function isCompressibleBlock(block: V7MemoryBlock, olderThanDays: number, now: Date): boolean {
  if (block.scope !== 'user') return false;
  if (block.readOnly) return false;
  if (block.tier !== 'working' && block.tier !== 'session') return false;
  return ageInDays(block.updatedAt, now) >= olderThanDays;
}

/** Tìm các block cũ đủ điều kiện nén (cũ nhất trước, tối đa maxBlocks). */
export function findCompressibleBlocks(
  projection: GitMemoryProjection,
  policy: V8SleepPolicy,
  now = new Date(),
): V8BlockCompressionCandidate[] {
  const blocks = projection
    .list()
    .filter((b) => isCompressibleBlock(b, policy.compressBlocksOlderThanDays, now))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .slice(0, Math.max(0, policy.maxBlocksPerRun));
  return blocks.map((b) => ({
    label: b.label,
    tier: b.tier,
    scope: b.scope,
    ageDays: ageInDays(b.updatedAt, now),
    chars: b.content.length,
  }));
}

/** Gom candidate thành cụm theo (tier + scope) để tạo block tóm tắt. */
export function groupCompressionCandidates(
  candidates: V8BlockCompressionCandidate[],
): Array<{ tier: string; scope: string; members: V8BlockCompressionCandidate[] }> {
  const groups = new Map<string, V8BlockCompressionCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.tier}|${candidate.scope}`;
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, members]) => {
    const [tier, scope] = key.split('|') as [string, string];
    return { tier, scope, members };
  });
}

/**
 * Lập kế hoạch nén block (dry-run): chưa ghi gì cả.
 * Chỉ cụm nào đủ `minBlocksToCompress` block mới được nén.
 */
export function planBlockCompression(
  projection: GitMemoryProjection,
  policy: V8SleepPolicy,
  now = new Date(),
): V8BlockCompressionPlan {
  const candidates = findCompressibleBlocks(projection, policy, now);
  const groups = groupCompressionCandidates(candidates).filter(
    (g) => g.members.length >= policy.minBlocksToCompress,
  );
  const dateTag = now.toISOString().slice(0, 10);
  const summaryLabels = groups.map((g) => `sleep-summary-${g.tier}-${g.scope}-${dateTag}`);
  const totalChars = groups.reduce(
    (sum, g) => sum + g.members.reduce((s, m) => s + m.chars, 0),
    0,
  );
  return {
    candidates: groups.flatMap((g) => g.members),
    clusters: groups.length,
    summaryLabels,
    totalChars,
  };
}

/** Nội dung block tóm tắt cho một cụm (liệt kê block gốc + nội dung cắt ngắn). */
export function summarizeBlockCluster(
  blocks: V7MemoryBlock[],
  tier: string,
  scope: string,
  runId: string,
): string {
  const lines: string[] = [];
  lines.push(`Tóm tắt ${blocks.length} block cũ (${tier}/${scope}) — sleep-time v8, run ${runId}.`);
  lines.push('Bản gốc vẫn xem lại được trong git history của memory-v7 (mỗi lần xóa là một commit).');
  for (const block of blocks) {
    const content = block.content.replace(/\s+/g, ' ').trim();
    lines.push(`- [${block.label}] ${content.slice(0, 400)}${content.length > 400 ? '…' : ''}`);
  }
  return lines.join('\n');
}

/**
 * Nén block thật: tạo block tóm tắt (tier semantic) rồi xóa block gốc.
 * Chỉ nén cụm đủ `minBlocksToCompress`. Trả về số block đã nén + số
 * block tóm tắt đã tạo. Lỗi từng cụm không fail cả lần chạy.
 */
export function compressBlocks(
  projection: GitMemoryProjection,
  policy: V8SleepPolicy,
  runId: string,
  opts: { now?: Date; errors?: string[] } = {},
): { blocksCompressed: number; summaryBlocksCreated: number } {
  const now = opts.now ?? new Date();
  const errors = opts.errors ?? [];
  const candidates = findCompressibleBlocks(projection, policy, now);
  const groups = groupCompressionCandidates(candidates).filter(
    (g) => g.members.length >= policy.minBlocksToCompress,
  );
  let blocksCompressed = 0;
  let summaryBlocksCreated = 0;
  const dateTag = now.toISOString().slice(0, 10);
  for (const group of groups) {
    try {
      const originals: V7MemoryBlock[] = [];
      for (const member of group.members) {
        const block = projection.get(member.label);
        if (block) originals.push(block);
      }
      if (originals.length < policy.minBlocksToCompress) continue;
      const label = `sleep-summary-${group.tier}-${group.scope}-${dateTag}`;
      const existing = projection.get(label);
      const summary = summarizeBlockCluster(originals, group.tier, group.scope, runId);
      if (existing) {
        projection.append(label, `\n${summary}`, V8_SLEEP_ACTOR);
      } else {
        projection.create(
          {
            label,
            content: summary,
            description: `Tóm tắt ${originals.length} block cũ (${group.tier}/${group.scope}) bởi sleep v8.`,
            tier: 'semantic',
            scope: 'user',
          },
          V8_SLEEP_ACTOR,
        );
      }
      summaryBlocksCreated += 1;
      for (const block of originals) {
        try {
          if (projection.delete(block.label, V8_SLEEP_ACTOR)) blocksCompressed += 1;
        } catch (err) {
          errors.push(`Xóa block "${block.label}" lỗi: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      errors.push(`Nén cụm ${group.tier}/${group.scope} lỗi: ${(err as Error).message}`);
    }
  }
  return { blocksCompressed, summaryBlocksCreated };
}

/* ------------------------------------------------------------------ */
/* Scheduler v8 (bọc scheduler v6)                                    */
/* ------------------------------------------------------------------ */

/** Tuỳ chọn scheduler v8. */
export interface SleepV8SchedulerOptions {
  /** Store v6 mà scheduler dọn (bản ghi). */
  store: V6RecordStore;
  /** Thư mục workspace (policy + ledger + projection block). */
  workspaceDir?: string;
  /** Projection block v7 (để nén block; không có thì chỉ dọn bản ghi). */
  projection?: GitMemoryProjection;
  /** Policy ban đầu (mặc định đọc từ store/file, thiếu -> mặc định). */
  policy?: Partial<V8SleepPolicy>;
  /** Callback sau mỗi lần chạy (để host log/UI). */
  onRun?: (report: V8SleepRunReport) => void;
}

/**
 * Scheduler sleep-time compute v8: chạy nền khi rảnh.
 *
 *  - `start()` bật interval kiểm tra; `stop()` dừng hẳn.
 *  - `setEnabled(true/false)` bật/tắt (ghi bền vào policy store).
 *  - `setPolicy(patch)` đổi policy (ghi bền).
 *  - `markActivity()` host gọi mỗi khi có hoạt động.
 *  - `preview()` dry-run: báo cáo lần chạy tới sẽ làm gì, không ghi.
 *  - `runNow()` chạy một lần ngay (bỏ qua điều kiện rảnh, vẫn tôn
 *    trọng giờ yên lặng? KHÔNG — runNow tường minh thì chạy luôn,
 *    giờ yên lặng chỉ chặn chạy tự động).
 *  - Không bao giờ chạy 2 lần chồng nhau (`running` guard).
 *  - Giới hạn ngày: quá maxRunsPerDay thì lần chạy tự động bị bỏ qua
 *    (runNow tường minh vẫn chạy, nhưng báo stoppedByDailyBudget).
 */
export class SleepV8Scheduler {
  private readonly store: V6RecordStore;
  private readonly workspaceDir: string | undefined;
  private readonly projection: GitMemoryProjection | undefined;
  private readonly policyStore: V8SleepPolicyStore;
  private readonly inner: SleepV6Scheduler;
  private readonly onRun: ((report: V8SleepRunReport) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastActivityAt = Date.now();
  private lastReportValue: V8SleepRunReport | null = null;
  private runCount = 0;

  constructor(opts: SleepV8SchedulerOptions) {
    this.store = opts.store;
    this.workspaceDir = opts.workspaceDir;
    this.projection = opts.projection;
    this.policyStore = opts.workspaceDir
      ? V8SleepPolicyStore.fromWorkspace(opts.workspaceDir)
      : V8SleepPolicyStore.inMemory();
    const initial = this.policyStore.get();
    if (opts.policy) {
      this.policyStore.set({ ...initial, ...opts.policy });
    }
    const policy = this.policyStore.get();
    this.inner = new SleepV6Scheduler({
      store: opts.store,
      ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      config: {
        enabled: policy.enabled,
        idleMs: policy.idleMs,
        checkIntervalMs: policy.checkIntervalMs,
        maxRecordsPerRun: 500,
        maxMsPerRun: 30_000,
        summarizeOlderThanDays: 30,
        minClusterSize: 3,
        maxSummaryChars: 2000,
        nearDupJaccard: 0.8,
      },
    });
    this.onRun = opts.onRun;
  }

  /** Policy hiện tại (bản sao). */
  getPolicy(): V8SleepPolicy {
    return this.policyStore.get();
  }

  /** Đổi policy (ghi bền). */
  setPolicy(patch: Partial<V8SleepPolicy>): V8SleepPolicy {
    const next = this.policyStore.set(patch);
    this.inner.setEnabled(next.enabled);
    return next;
  }

  /** Bật/tắt sleep compute (ghi bền vào policy). */
  setEnabled(enabled: boolean): void {
    this.setPolicy({ enabled });
  }

  /** Sleep compute có đang bật không. */
  get enabled(): boolean {
    return this.policyStore.get().enabled;
  }

  /** Scheduler có đang chạy interval không. */
  get started(): boolean {
    return this.timer !== null;
  }

  /** Có đang chạy một lần consolidation không. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Báo cáo lần chạy gần nhất (null khi chưa chạy lần nào). */
  get lastReport(): V8SleepRunReport | null {
    return this.lastReportValue;
  }

  /** Tổng số lần đã chạy. */
  get totalRuns(): number {
    return this.runCount;
  }

  /** Ghi nhận hoạt động (user/bot vừa nhắn) — reset đồng hồ rảnh. */
  markActivity(): void {
    this.lastActivityAt = Date.now();
    this.inner.markActivity();
  }

  /** Bật interval kiểm tra rảnh (gọi 1 lần; gọi lại không tạo thêm timer). */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.policyStore.get().checkIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Dừng interval (không huỷ lần chạy đang diễn ra). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Một nhịp kiểm tra: đủ rảnh + đang bật + không trong giờ yên lặng + chưa quá giới hạn ngày -> chạy. */
  async tick(): Promise<V8SleepRunReport | null> {
    const policy = this.policyStore.get();
    if (!policy.enabled || this.running) return null;
    if (isInQuietHours(policy)) return null;
    if (Date.now() - this.lastActivityAt < policy.idleMs) return null;
    if (policy.maxRunsPerDay > 0 && this.workspaceDir) {
      if (countV8SleepRunsToday(this.workspaceDir) >= policy.maxRunsPerDay) return null;
    }
    return this.runNow();
  }

  /**
   * Dry-run: báo cáo lần chạy tới sẽ làm gì (bản ghi + block) mà
   * không ghi gì vào kho.
   *
   *  - Phần v6 CHỈ ước lượng (số bản ghi active sẽ xem xét) vì
   *    runConsolidation v6 không có chế độ dry-run thật — gọi nó
   *    trong preview sẽ sửa kho, nên preview tuyệt đối không gọi.
   *    Muốn biết số dedupe/quarantine chính xác thì chạy thật
   *    (runNow) rồi đọc báo cáo.
   *  - Phần block là kế hoạch chính xác (đọc projection, không ghi).
   */
  preview(): { v6DryRun: V6SleepRunReport; blockPlan: V8BlockCompressionPlan | null } {
    const policy = this.policyStore.get();
    const blockPlan = this.projection ? planBlockCompression(this.projection, policy) : null;
    const actives = this.store.listActive();
    const estimatedV6: V6SleepRunReport = {
      runId: 'preview',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      examined: actives.length,
      dedupedExact: 0,
      dedupedNear: 0,
      summarizedClusters: 0,
      summaryRecords: 0,
      quarantined: 0,
      superseded: 0,
      stoppedByBudget: false,
      errors: ['Preview v6 chỉ ước lượng số bản ghi sẽ xem xét; chạy thật mới biết số dedupe/quarantine chính xác.'],
    };
    return { v6DryRun: estimatedV6, blockPlan };
  }

  /** Chạy một lần consolidation ngay (bỏ qua điều kiện rảnh). */
  async runNow(opts: { dryRun?: boolean } = {}): Promise<V8SleepRunReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const policy = this.policyStore.get();
      const startedAt = new Date();
      const runId = randomUUID();
      const errors: string[] = [];
      const dryRun = opts.dryRun === true;

      let blocksCompressed = 0;
      let summaryBlocksCreated = 0;
      let v6report: V6SleepRunReport;
      if (dryRun) {
        const preview = this.preview();
        v6report = preview.v6DryRun;
        blocksCompressed = preview.blockPlan ? preview.blockPlan.candidates.length : 0;
        summaryBlocksCreated = preview.blockPlan ? preview.blockPlan.clusters : 0;
      } else {
        v6report = runConsolidation(this.store, {
          config: {
            enabled: true,
            idleMs: 0,
            checkIntervalMs: policy.checkIntervalMs,
            maxRecordsPerRun: 500,
            maxMsPerRun: 30_000,
            summarizeOlderThanDays: 30,
            minClusterSize: 3,
            maxSummaryChars: 2000,
            nearDupJaccard: 0.8,
          },
          actor: V8_SLEEP_ACTOR,
        });
        if (this.projection) {
          const compressed = compressBlocks(this.projection, policy, runId, { errors });
          blocksCompressed = compressed.blocksCompressed;
          summaryBlocksCreated = compressed.summaryBlocksCreated;
        }
      }

      const stoppedByDailyBudget =
        policy.maxRunsPerDay > 0 &&
        this.workspaceDir !== undefined &&
        countV8SleepRunsToday(this.workspaceDir) >= policy.maxRunsPerDay;
      const finishedAt = new Date();
      const report: V8SleepRunReport = {
        runId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        v6: {
          examined: v6report.examined,
          dedupedExact: v6report.dedupedExact,
          dedupedNear: v6report.dedupedNear,
          summarizedClusters: v6report.summarizedClusters,
          summaryRecords: v6report.summaryRecords,
          quarantined: v6report.quarantined,
          superseded: v6report.superseded,
          stoppedByBudget: v6report.stoppedByBudget,
          errors: v6report.errors,
        },
        blocksCompressed,
        summaryBlocksCreated,
        stoppedByDailyBudget,
        dryRun,
        errors,
      };
      this.lastReportValue = report;
      this.runCount += 1;
      if (this.workspaceDir && !dryRun) {
        try {
          appendV8SleepLedger(this.workspaceDir, report);
        } catch {
          // Ghi ledger lỗi thì bỏ qua — không fail lần chạy.
        }
      }
      this.onRun?.(report);
      return report;
    } finally {
      this.running = false;
    }
  }
}
