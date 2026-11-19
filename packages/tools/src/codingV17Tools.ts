/**
 * Coding agent v17 tools (v1.39, Đội T4) — 9 tools.
 *
 * Nối coding agent v16 tools (v1.38): placeholder trong ALL_TOOLS cho
 * tới khi host bind (`createCodingV17Tools(getBaseDir)` với userData
 * dir). Không gọi model thật, không gọi mạng — mọi tool làm việc trên
 * file local trong thư mục dữ liệu v17 và sandbox bwrap của bot:
 *
 *   <base>/coding-v17/
 *     trajectories/<session>.jsonl   (append-only trajectory log)
 *     plans.json                     (plan theo task)
 *     repomaps.json                  (repo map đã build, kèm fingerprint)
 *     evals.json                     (eval report đã chạy)
 *   <base>/coding-v17-boxes/
 *     boxes/<botId>/                 (BotBoxManager — bwrap thật)
 *
 *  - coding_v17_trajectory — append/list/verify/replay/recover event
 *    trong trajectory log (hash chain, deterministic replay).
 *  - coding_v17_repomap    — build/query/update repo map PageRank v+1
 *    (personalized theo seed, cập nhật tăng dần khi file đổi).
 *  - coding_v17_eval       — chạy eval task (oracle + test xác định),
 *    chấm patch trước khi trình (gate pass/fail).
 *  - coding_v17_critic     — critic chấm trajectory (từ log) hoặc patch.
 *  - coding_v17_review     — review skill tự động trên patch (secret /
 *    lệnh phá hoại / file nhạy cảm / patch quá rộng / thiếu test).
 *  - coding_v17_plan       — Plan Mode: create/refine/approve/status/
 *    complete/finish/reject (đa file bắt buộc plan approved).
 *  - coding_v17_sandbox    — probe bwrap / chạy lệnh trong box bwrap
 *    thật qua BotBoxManager (giới hạn CPU/RAM từng bot, non-root,
 *    fallback ghi rõ khi bwrap không có).
 *  - coding_v17_agent      — chạy phiên agent v17 scripted end-to-end
 *    (plan + repo map + sandbox + verification stack).
 *  - coding_v17_verify     — verification stack nhiều tầng cho một
 *    phiên: critic trajectory + review skill + eval gate (+ plan).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import {
  TrajectoryLog,
  V17SandboxRunner,
  renderV17AgentReport,
  renderV17EvalReport,
  renderV17PatchCriticScore,
  renderV17Plan,
  renderV17RepoMap,
  renderV17ReplayState,
  renderV17ReviewResult,
  renderV17SandboxRun,
  renderV17Trajectory,
  renderV17TrajectoryCriticScore,
  runV17Agent,
  v17BuildRepoMap,
  v17BuildVerificationReport,
  v17CheckPlanDeviation,
  v17CompletePlanStep,
  v17CreatePlan,
  v17FinishPlan,
  v17PlanProgress,
  v17ProbeSandbox,
  v17QueryRepoMap,
  v17RefinePlan,
  v17RejectPlan,
  v17RequirePlanForTask,
  v17ReplayEvents,
  v17ReviewPatch,
  v17RunEvalTask,
  v17ScorePatch,
  v17ScoreTrajectory,
  v17TransitionPlan,
  v17UpdateRepoMap,
  v17ValidatePlan,
  v17ValidateSandboxLimits,
} from '@open-bot/core';
import type {
  V17EvalReport,
  V17EvalTask,
  V17Plan,
  V17RepoMap,
  V17SandboxLimits,
  V17TrajectoryEventKind,
} from '@open-bot/core';

export const CODING_V17_TOOL_NAMES = [
  'coding_v17_trajectory',
  'coding_v17_repomap',
  'coding_v17_eval',
  'coding_v17_critic',
  'coding_v17_review',
  'coding_v17_plan',
  'coding_v17_sandbox',
  'coding_v17_agent',
  'coding_v17_verify',
] as const;

export type CodingV17ToolName = (typeof CODING_V17_TOOL_NAMES)[number];

export function isCodingV17ToolName(name: string): boolean {
  return (CODING_V17_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV17ToolOptions {
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
}

/** Thư mục dữ liệu v17 trong base dir của host. */
export function codingV17DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v17');
}

/** Thư mục gốc sandbox v17 (boxes của bot) trong base dir của host. */
export function codingV17SandboxRootDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v17-boxes');
}

/** Tạo (nếu chưa có) thư mục dữ liệu v17, trả đường dẫn. */
export function codingV17EnsureDataDir(baseDir: string): string {
  const dir = codingV17DataDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string, required = false): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${name}" must be an integer, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Parse một JSON string thành object (lỗi rõ ràng khi sai định dạng). */
function parseJsonObjectArg(raw: string, name: string): Record<string, unknown> {
  if (raw.trim() === '') throw new Error(`Argument "${name}" must be valid JSON object.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Argument "${name}" must be valid JSON object.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Parse một JSON string thành map path -> nội dung file. */
function parseFilesArg(raw: string, name: string): Record<string, string> {
  const obj = parseJsonObjectArg(raw, name);
  for (const [filePath, content] of Object.entries(obj)) {
    if (typeof content !== 'string') {
      throw new Error(`Argument "${name}[${filePath}]" must be a string.`);
    }
  }
  return obj as Record<string, string>;
}

/** Đọc JSON file (trả fallback khi chưa có / lỗi parse). */
function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Ghi JSON file (tạo thư mục cha khi cần). */
function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** File plans.json / repomaps.json / evals.json trong data dir. */
function plansFile(dataDir: string): string {
  return path.join(dataDir, 'plans.json');
}
function repoMapsFile(dataDir: string): string {
  return path.join(dataDir, 'repomaps.json');
}
function evalsFile(dataDir: string): string {
  return path.join(dataDir, 'evals.json');
}

/** File trajectory log của một session trong data dir. */
function trajectoryFile(dataDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(dataDir, 'trajectories', `${safe}.jsonl`);
}

/** Load plan đã lưu theo id (undefined khi chưa có). */
function loadPlan(dataDir: string, planId: string): V17Plan | undefined {
  const store = readJsonFile<Record<string, V17Plan>>(plansFile(dataDir), {});
  const plan = store[planId];
  if (!plan) return undefined;
  try {
    return v17ValidatePlan(plan);
  } catch {
    return undefined;
  }
}

/** Lưu plan (ghi đè theo id). */
function savePlan(dataDir: string, plan: V17Plan): void {
  const store = readJsonFile<Record<string, V17Plan>>(plansFile(dataDir), {});
  store[plan.id] = plan;
  writeJsonFile(plansFile(dataDir), store);
}

/** Load repo map đã lưu theo root (undefined khi chưa có). */
function loadRepoMap(dataDir: string, root: string): V17RepoMap | undefined {
  const store = readJsonFile<Record<string, V17RepoMap>>(repoMapsFile(dataDir), {});
  return store[root];
}

/** Lưu repo map (ghi đè theo root). */
function saveRepoMap(dataDir: string, map: V17RepoMap): void {
  const store = readJsonFile<Record<string, V17RepoMap>>(repoMapsFile(dataDir), {});
  store[map.root] = map;
  writeJsonFile(repoMapsFile(dataDir), store);
}

/** Lưu eval report (append theo task id + thời gian). */
function saveEvalReport(dataDir: string, report: V17EvalReport): void {
  const store = readJsonFile<Record<string, V17EvalReport[]>>(evalsFile(dataDir), {});
  const list = store[report.taskId] ?? [];
  list.push(report);
  store[report.taskId] = list.slice(-20);
  writeJsonFile(evalsFile(dataDir), store);
}

/** Parse giới hạn sandbox từ JSON (mặc định {} khi rỗng). */
function parseSandboxLimits(raw: string): V17SandboxLimits {
  if (raw.trim() === '') return {};
  const obj = parseJsonObjectArg(raw, 'limitsJson');
  const limits: V17SandboxLimits = {};
  if (typeof obj['cpuSeconds'] === 'number') limits.cpuSeconds = obj['cpuSeconds'];
  if (typeof obj['maxMemoryBytes'] === 'number') limits.maxMemoryBytes = obj['maxMemoryBytes'];
  if (typeof obj['maxProcesses'] === 'number') limits.maxProcesses = obj['maxProcesses'];
  if (typeof obj['timeoutMs'] === 'number') limits.timeoutMs = obj['timeoutMs'];
  if (typeof obj['maxWriteBytes'] === 'number') limits.maxWriteBytes = obj['maxWriteBytes'];
  if (typeof obj['maxOutputChars'] === 'number') limits.maxOutputChars = obj['maxOutputChars'];
  return v17ValidateSandboxLimits(limits);
}

/** Parse eval task từ JSON (validate đầy đủ ở core). */
function parseEvalTask(raw: string): V17EvalTask {
  const obj = parseJsonObjectArg(raw, 'evalTaskJson');
  return obj as unknown as V17EvalTask;
}

/** Dựng diff text đơn giản từ patchFiles (cho review/critic khi caller không đưa diff). */
function buildDiffText(patchFiles: Record<string, string>): string {
  return Object.entries(patchFiles)
    .map(([file, content]) => `--- a/${file}\n+++ b/${file}\n${content.split('\n').map((l) => `+${l}`).join('\n')}`)
    .join('\n');
}

export function createCodingV17Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV17ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveDataDir = (ctx: ToolContext): string => {
    const base = resolveBase();
    if (base) return codingV17EnsureDataDir(base);
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      return codingV17EnsureDataDir(path.join(ctx.workspaceDir, '.open-bot'));
    }
    const fallback = toolOptions.getWorkspaceDir?.();
    if (typeof fallback === 'string' && fallback.trim().length > 0) {
      return codingV17EnsureDataDir(path.join(fallback, '.open-bot'));
    }
    return codingV17EnsureDataDir(path.join(os.tmpdir(), 'open-bot-coding-v17'));
  };

  const resolveSandboxRootDir = (ctx: ToolContext): string => {
    const base = resolveBase();
    if (base) {
      const dir = codingV17SandboxRootDir(base);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) {
      const dir = path.join(ctx.workspaceDir, '.open-bot', 'coding-v17-boxes');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    const dir = path.join(os.tmpdir(), 'open-bot-coding-v17-boxes');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const tools: Tool[] = [
    {
      definition: toolDef(
        'coding_v17_trajectory',
        'Append/list/verify/replay/recover events in a coding v17 append-only trajectory log (hash-chained, deterministic replay). Read-only actions: list, verify, replay. Mutating: append, recover.',
        {
          sessionId: { type: 'string', description: 'Session id owning the trajectory log.' },
          action: { type: 'string', description: 'Action: append | list | verify | replay | recover.' },
          kind: { type: 'string', description: 'Event kind for append (e.g. prompt, bash, file_write, compiler_error).' },
          payloadJson: { type: 'string', description: 'JSON object payload for append (optional, default {}).' },
        },
        ['sessionId', 'action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const sessionId = getStringArg(args, 'sessionId', true);
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          const log = new TrajectoryLog(sessionId, trajectoryFile(dataDir, sessionId));
          if (action === 'append') {
            const kind = getStringArg(args, 'kind', true) as V17TrajectoryEventKind;
            const payloadRaw = getStringArg(args, 'payloadJson');
            const payload = payloadRaw.trim() === '' ? {} : parseJsonObjectArg(payloadRaw, 'payloadJson');
            const event = log.append(kind, payload);
            return `Appended event #${event.seq} (${event.kind}) to trajectory ${sessionId} (hash ${event.hash.slice(0, 12)}…).`;
          }
          if (action === 'list') return renderV17Trajectory(log.load());
          if (action === 'verify') {
            const verification = log.verify();
            if (verification.ok) {
              return `Trajectory ${sessionId} OK: ${verification.eventsChecked} events, hash chain liên tục.`;
            }
            return `Trajectory ${sessionId} HỎNG tại seq ${String(verification.firstBadSeq)}: ${verification.reason ?? ''} (${verification.eventsChecked} events đã kiểm tra). Dùng action=recover để cắt đuôi hỏng.`;
          }
          if (action === 'replay') {
            return renderV17ReplayState(log.replay());
          }
          if (action === 'recover') {
            const recovery = log.recover();
            if (recovery.droppedEvents === 0) {
              return `Trajectory ${sessionId} nguyên vẹn — không cần recovery (${recovery.keptEvents} events).`;
            }
            return `Recovery ${sessionId}: giữ ${recovery.keptEvents} events, bỏ ${recovery.droppedEvents} events hỏng (từ seq ${String(recovery.firstBadSeq)}: ${recovery.reason ?? ''}).\n${renderV17ReplayState(recovery.state)}`;
          }
          return errorResult(`Unknown action "${action}" (append | list | verify | replay | recover).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_repomap',
        'Build/query/incrementally update a coding v17 repo map (PageRank v+1: personalized PageRank + reference frequency + freshness). Read-only after build; update reuses ranks for unchanged files.',
        {
          root: { type: 'string', description: 'Repo root label for the map (e.g. absolute path or repo name).' },
          action: { type: 'string', description: 'Action: build | query | update.' },
          filesJson: { type: 'string', description: 'JSON object path -> file content (required for build/update).' },
          query: { type: 'string', description: 'Task text for query (top files relevant to the task).' },
          topK: { type: 'integer', description: 'How many top files to return for query (default 10).' },
          seedsJson: { type: 'string', description: 'JSON array of seed file paths for personalized PageRank (optional).' },
        },
        ['root', 'action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const root = getStringArg(args, 'root', true);
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'query') {
            const map = loadRepoMap(dataDir, root);
            if (!map) return errorResult(`Chưa có repo map cho "${root}" — chạy action=build trước.`);
            const query = getStringArg(args, 'query');
            const topK = getIntArg(args, 'topK') ?? 10;
            const top = v17QueryRepoMap(map, query, topK);
            if (top.length === 0) return `Repo map "${root}" không có file nào.`;
            return `Top ${top.length} files cho "${query || '(toàn repo)'}":\n${top.map((r) => `  ${r.score.toFixed(3)} ${r.path}`).join('\n')}`;
          }
          const filesRaw = getStringArg(args, 'filesJson', true);
          const files = new Map(Object.entries(parseFilesArg(filesRaw, 'filesJson')));
          const seedsRaw = getStringArg(args, 'seedsJson');
          const seeds = seedsRaw.trim() === '' ? undefined : (JSON.parse(seedsRaw) as string[]);
          if (action === 'build') {
            const map = v17BuildRepoMap(root, files, { seeds });
            saveRepoMap(dataDir, map);
            return renderV17RepoMap(map, 10);
          }
          if (action === 'update') {
            const oldMap = loadRepoMap(dataDir, root);
            if (!oldMap) return errorResult(`Chưa có repo map cho "${root}" — chạy action=build trước.`);
            const update = v17UpdateRepoMap(oldMap, files, { seeds });
            saveRepoMap(dataDir, update.map);
            return `Repo map "${root}" cập nhật tăng dần: ${update.changedFiles.length} files đổi (${update.changedFiles.join(', ') || 'không có'}), ${update.affectedFiles.length} files tính lại rank, ${update.reusedFiles} files tái sử dụng rank cũ.\n${renderV17RepoMap(update.map, 10)}`;
          }
          return errorResult(`Unknown action "${action}" (build | query | update).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_eval',
        'Run a coding v17 eval task (deterministic oracle tests) on a patch and report the pass/fail gate. The patch is scored BEFORE it is presented to the user.',
        {
          evalTaskJson: { type: 'string', description: 'JSON eval task (id, title, startFiles, tests with command + expectations, protectedFiles, requiredFiles).' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (the patch to score).' },
        },
        ['evalTaskJson', 'patchJson'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const task = parseEvalTask(getStringArg(args, 'evalTaskJson', true));
          const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
          const dataDir = resolveDataDir(ctx);
          const report = await v17RunEvalTask(task, patch, { isolation: 'v17-tool-local-executor' });
          saveEvalReport(dataDir, report);
          return renderV17EvalReport(report);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_critic',
        'Score a coding v17 trajectory (from its log) or a patch with the deterministic critic (completeness/efficiency/error-recovery/safety for trajectories; correctness/focus/test-coverage/safety for patches).',
        {
          target: { type: 'string', description: 'What to score: trajectory | patch.' },
          sessionId: { type: 'string', description: 'Session id (for target=trajectory).' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (for target=patch).' },
          diffText: { type: 'string', description: 'Diff text for the patch (optional; built from patchJson when empty).' },
          plannedFilesJson: { type: 'string', description: 'JSON array of planned file paths (optional, for focus scoring).' },
        },
        ['target'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const target = getStringArg(args, 'target', true);
          const dataDir = resolveDataDir(ctx);
          if (target === 'trajectory') {
            const sessionId = getStringArg(args, 'sessionId', true);
            const log = new TrajectoryLog(sessionId, trajectoryFile(dataDir, sessionId));
            const events = log.load();
            if (events.length === 0) return errorResult(`Trajectory ${sessionId} rỗng — chưa có event để chấm.`);
            const state = v17ReplayEvents(events, sessionId);
            const score = v17ScoreTrajectory(sessionId, events, state);
            return renderV17TrajectoryCriticScore(score);
          }
          if (target === 'patch') {
            const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
            const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
            const plannedRaw = getStringArg(args, 'plannedFilesJson');
            const plannedFiles = plannedRaw.trim() === '' ? undefined : (JSON.parse(plannedRaw) as string[]);
            const score = v17ScorePatch(patch, diffText, {
              ...(plannedFiles ? { plannedFiles } : {}),
            });
            return renderV17PatchCriticScore(score);
          }
          return errorResult(`Unknown target "${target}" (trajectory | patch).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_review',
        'Run the coding v17 automatic review skill on a patch: secrets, destructive commands, sensitive files, oversized patch, missing tests. Returns PASS/FAIL with findings.',
        {
          patchJson: { type: 'string', description: 'JSON object path -> new file content (the change to review).' },
          diffText: { type: 'string', description: 'Diff text (optional; built from patchJson when empty).' },
        },
        ['patchJson'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
          const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
          return renderV17ReviewResult(v17ReviewPatch(patch, diffText));
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_plan',
        'Plan Mode for coding v17: create/refine/approve/status/complete/finish/reject a plan. Multi-file tasks REQUIRE an approved plan before building.',
        {
          action: { type: 'string', description: 'Action: create | refine | submit | approve | status | complete | finish | reject | check.' },
          planId: { type: 'string', description: 'Plan id (for refine/submit/approve/status/complete/finish/reject).' },
          taskId: { type: 'string', description: 'Task id (for create).' },
          task: { type: 'string', description: 'Task description (for create).' },
          stepsJson: { type: 'string', description: 'JSON array of {title, files[]} steps (for create).' },
          change: { type: 'string', description: 'Refinement description (for refine).' },
          refineJson: { type: 'string', description: 'JSON array of steps after refinement (for refine).' },
          stepId: { type: 'string', description: 'Step id to mark done (for complete).' },
          reason: { type: 'string', description: 'Rejection reason (for reject).' },
          filesJson: { type: 'string', description: 'JSON array of files the task touches (for check: enforces the multi-file plan gate).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          const dataDir = resolveDataDir(ctx);
          if (action === 'create') {
            const taskId = getStringArg(args, 'taskId', true);
            const task = getStringArg(args, 'task', true);
            const stepsRaw = getStringArg(args, 'stepsJson', true);
            const steps = JSON.parse(stepsRaw) as Array<{ title: string; files?: string[] }>;
            const plan = v17CreatePlan(taskId, task, steps);
            savePlan(dataDir, plan);
            return `Plan ${plan.id} tạo xong (draft, ${plan.steps.length} bước, ${plan.fileCount} files${plan.multiFile ? ' — đa file, Plan Mode bắt buộc' : ''}).\n${renderV17Plan(plan)}`;
          }
          if (action === 'check') {
            const filesRaw = getStringArg(args, 'filesJson', true);
            const files = JSON.parse(filesRaw) as string[];
            const planId = getStringArg(args, 'planId');
            const plan = planId ? loadPlan(dataDir, planId) : undefined;
            v17RequirePlanForTask(files, plan);
            return files.length >= 2
              ? `Plan gate PASS: task ${files.length} files có plan ${plan?.id ?? ''} (${plan?.status ?? ''}).`
              : `Plan gate không bắt buộc: task chỉ ${files.length} file.`;
          }
          const planId = getStringArg(args, 'planId', true);
          const stored = loadPlan(dataDir, planId);
          if (!stored) return errorResult(`Không có plan ${planId} — chạy action=create trước.`);
          let plan = stored;
          if (action === 'refine') {
            const change = getStringArg(args, 'change', true);
            const refineRaw = getStringArg(args, 'refineJson', true);
            const nextSteps = JSON.parse(refineRaw) as Array<{ id: string; title: string; files: string[]; done: boolean }>;
            if (plan.status === 'draft' || plan.status === 'awaiting-approval') {
              plan = v17TransitionPlan(plan, 'refining');
            }
            plan = v17RefinePlan(plan, change, () => nextSteps);
            plan = v17TransitionPlan(plan, 'awaiting-approval');
            savePlan(dataDir, plan);
            return `Plan ${plan.id} đã refine ("${change}").\n${renderV17Plan(plan)}`;
          }
          if (action === 'submit') {
            if (plan.status === 'draft' || plan.status === 'refining') {
              plan = v17TransitionPlan(plan, 'awaiting-approval');
            }
            savePlan(dataDir, plan);
            return `Plan ${plan.id} đã gửi duyệt (awaiting-approval).\n${renderV17Plan(plan)}`;
          }
          if (action === 'approve') {
            // Duyệt plan đang draft/refining = gửi duyệt rồi duyệt luôn
            // (một nhịp cho agent); plan đã awaiting-approval thì duyệt trực tiếp.
            if (plan.status === 'draft' || plan.status === 'refining') {
              plan = v17TransitionPlan(plan, 'awaiting-approval');
            }
            plan = v17TransitionPlan(plan, 'approved');
            savePlan(dataDir, plan);
            return `Plan ${plan.id} ĐÃ DUYỆT — được phép build.\n${renderV17Plan(plan)}`;
          }
          if (action === 'status') {
            const progress = v17PlanProgress(plan);
            return `${renderV17Plan(plan)}\nTiến độ: ${progress.done}/${progress.total} (${progress.percent}%).`;
          }
          if (action === 'complete') {
            const stepId = getStringArg(args, 'stepId', true);
            plan = v17CompletePlanStep(plan, stepId);
            savePlan(dataDir, plan);
            return `Bước ${stepId} xong.\n${renderV17Plan(plan)}`;
          }
          if (action === 'finish') {
            plan = v17FinishPlan(plan);
            savePlan(dataDir, plan);
            return `Plan ${plan.id} DONE.\n${renderV17Plan(plan)}`;
          }
          if (action === 'reject') {
            const reason = getStringArg(args, 'reason', true);
            plan = v17RejectPlan(plan, reason);
            savePlan(dataDir, plan);
            return `Plan ${plan.id} BỊ TỪ CHỐI: ${reason}.`;
          }
          if (action === 'deviation') {
            const filesRaw = getStringArg(args, 'filesJson', true);
            const files = JSON.parse(filesRaw) as string[];
            const check = v17CheckPlanDeviation(plan, files);
            return check.deviations.length === 0
              ? `Không lệch plan: mọi file đều trong plan (${check.inPlan.join(', ') || 'không có'}).`
              : `LỆCH PLAN: file ngoài plan: ${check.deviations.join(', ')}. Cập nhật plan hoặc dừng lại trước khi build tiếp.`;
          }
          return errorResult(`Unknown action "${action}" (create | refine | submit | approve | status | complete | finish | reject | check | deviation).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_sandbox',
        'Run code in a real bwrap sandbox via BotBoxManager (per-bot CPU/RAM limits, non-root, explicit fallback when bwrap is missing). Probe reports what this host can isolate.',
        {
          action: { type: 'string', description: 'Action: probe | run | run-shell | run-python.' },
          botId: { type: 'string', description: 'Bot id owning the box (for run/run-shell/run-python).' },
          command: { type: 'string', description: 'Program to run (for run) or shell command (for run-shell).' },
          argsJson: { type: 'string', description: 'JSON array of args (for run).' },
          code: { type: 'string', description: 'Python code (for run-python).' },
          limitsJson: { type: 'string', description: 'JSON limits {cpuSeconds, maxMemoryBytes, maxProcesses, timeoutMs, maxWriteBytes, maxOutputChars} (optional).' },
          allowRoot: { type: 'boolean', description: 'Explicit opt-in to run agent code when the HOST itself runs as root (uid 0). Default false = refuse. The run still records nonRoot=false + uid in its result; prefer running the host as a normal user.' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args, ctx) => {
        try {
          const action = getStringArg(args, 'action', true);
          if (action === 'probe') {
            const probe = v17ProbeSandbox();
            return [
              `Sandbox probe (${probe.platform}): isolation=${probe.isolation}, bwrap=${probe.bwrapAvailable}, unshare=${probe.unshareAvailable}, prlimit=${probe.prlimitAvailable}, uid=${probe.uid}.`,
              probe.recommendation,
            ].join('\n');
          }
          const botId = getStringArg(args, 'botId', true);
          const limits = parseSandboxLimits(getStringArg(args, 'limitsJson'));
          const allowRoot = getBoolArg(args, 'allowRoot') === true;
          const sandboxRootDir = resolveSandboxRootDir(ctx);
          const runner = new V17SandboxRunner(sandboxRootDir, { ...(allowRoot ? { allowRoot: true } : {}) });
          if (action === 'run') {
            const command = getStringArg(args, 'command', true);
            const argsRaw = getStringArg(args, 'argsJson');
            const runArgs = argsRaw.trim() === '' ? [] : (JSON.parse(argsRaw) as string[]);
            const run = await runner.run(botId, command, runArgs, limits);
            return renderV17SandboxRun(run);
          }
          if (action === 'run-shell') {
            const shellCommand = getStringArg(args, 'command', true);
            const run = await runner.runShell(botId, shellCommand, limits);
            return renderV17SandboxRun(run);
          }
          if (action === 'run-python') {
            const code = getStringArg(args, 'code', true);
            const argsRaw = getStringArg(args, 'argsJson');
            const runArgs = argsRaw.trim() === '' ? [] : (JSON.parse(argsRaw) as string[]);
            const run = await runner.runPython(botId, code, runArgs, limits);
            return renderV17SandboxRun(run);
          }
          return errorResult(`Unknown action "${action}" (probe | run | run-shell | run-python).`);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_agent',
        'Run a scripted coding v17 agent session end-to-end (Plan Mode for multi-file tasks + repo map context + real bwrap sandbox execution + verification stack). No real model calls; steps are supplied as JSON.',
        {
          sessionId: { type: 'string', description: 'Session id (unique; reuses the trajectory log when resuming).' },
          task: { type: 'string', description: 'Task description.' },
          botId: { type: 'string', description: 'Bot id (own box, own limits).' },
          stepsJson: { type: 'string', description: 'JSON array of steps {text, bashCommand?, fileWrite? {path, content, kind, oldText?}, isTest?, done?}.' },
          evalTaskJson: { type: 'string', description: 'JSON eval task to gate the patch (optional).' },
          repoFilesJson: { type: 'string', description: 'JSON object path -> content for the repo map (optional).' },
          limitsJson: { type: 'string', description: 'JSON sandbox limits (optional).' },
          allowRoot: { type: 'boolean', description: 'Explicit opt-in to run agent code when the HOST itself runs as root (uid 0). Default false = refuse. Prefer running the host as a normal user.' },
        },
        ['sessionId', 'task', 'botId', 'stepsJson'],
      ),
      needsApproval: true,
      execute: async (args, ctx) => {
        try {
          const sessionId = getStringArg(args, 'sessionId', true);
          const task = getStringArg(args, 'task', true);
          const botId = getStringArg(args, 'botId', true);
          const steps = JSON.parse(getStringArg(args, 'stepsJson', true)) as Array<{
            text: string;
            bashCommand?: string;
            fileWrite?: { path: string; content: string; kind: 'create' | 'write' | 'edit'; oldText?: string };
            isTest?: boolean;
            done?: boolean;
          }>;
          const dataDir = resolveDataDir(ctx);
          const sandboxRootDir = resolveSandboxRootDir(ctx);
          const limits = parseSandboxLimits(getStringArg(args, 'limitsJson'));
          const allowRoot = getBoolArg(args, 'allowRoot') === true;
          const evalRaw = getStringArg(args, 'evalTaskJson');
          const evalTask = evalRaw.trim() === '' ? undefined : parseEvalTask(evalRaw);
          const repoRaw = getStringArg(args, 'repoFilesJson');
          const repoFiles = repoRaw.trim() === ''
            ? undefined
            : new Map(Object.entries(parseFilesArg(repoRaw, 'repoFilesJson')));
          const report = await runV17Agent({
            sessionId,
            task,
            botId,
            steps,
            dataDir,
            sandboxRootDir,
            sandboxLimits: limits,
            allowRoot,
            ...(evalTask ? { evalTask } : {}),
            ...(repoFiles ? { repoFiles } : {}),
          });
          return renderV17AgentReport(report);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
    {
      definition: toolDef(
        'coding_v17_verify',
        'Run the full coding v17 verification stack for a session: critic on the trajectory log + automatic review skill on the patch + eval gate (when an eval task is given) + plan status. The patch is presentable only when every layer passes.',
        {
          sessionId: { type: 'string', description: 'Session id (trajectory log + plan).' },
          patchJson: { type: 'string', description: 'JSON object path -> new file content (the patch to verify).' },
          diffText: { type: 'string', description: 'Diff text (optional; built from patchJson when empty).' },
          evalTaskJson: { type: 'string', description: 'JSON eval task to gate the patch (optional).' },
        },
        ['sessionId', 'patchJson'],
      ),
      needsApproval: false,
      execute: async (args, ctx) => {
        try {
          const sessionId = getStringArg(args, 'sessionId', true);
          const patch = parseFilesArg(getStringArg(args, 'patchJson', true), 'patchJson');
          const diffText = getStringArg(args, 'diffText') || buildDiffText(patch);
          const dataDir = resolveDataDir(ctx);
          const log = new TrajectoryLog(sessionId, trajectoryFile(dataDir, sessionId));
          const events = log.load();
          if (events.length === 0) return errorResult(`Trajectory ${sessionId} rỗng — chưa có phiên để verify.`);
          const state = v17ReplayEvents(events, sessionId);
          const trajectoryScore = v17ScoreTrajectory(sessionId, events, state);
          const review = v17ReviewPatch(patch, diffText);
          const evalRaw = getStringArg(args, 'evalTaskJson');
          const evalTask = evalRaw.trim() === '' ? undefined : parseEvalTask(evalRaw);
          const evalReport = evalTask ? await v17RunEvalTask(evalTask, patch, { isolation: 'v17-tool-local-executor' }) : undefined;
          if (evalReport) saveEvalReport(dataDir, evalReport);
          const patchScore = v17ScorePatch(patch, diffText, {
            ...(evalReport ? { evalReport } : {}),
            ...(state.plan ? { plannedFiles: state.plan.steps.flatMap((s) => s.files) } : {}),
          });
          const verification = v17BuildVerificationReport(sessionId, {
            trajectoryScore,
            patchScore,
            review,
            ...(evalReport ? { eval: evalReport } : {}),
            ...(state.plan ? { plan: state.plan } : {}),
          });
          const lines = [
            `Verification stack ${sessionId}: ${verification.allPassed ? 'ALL PASSED — presentable' : 'FAILED — không được trình'}.`,
            renderV17TrajectoryCriticScore(trajectoryScore),
            renderV17PatchCriticScore(patchScore),
            renderV17ReviewResult(review),
          ];
          if (evalReport) lines.push(renderV17EvalReport(evalReport));
          if (!verification.allPassed) {
            lines.push(`Tầng chưa pass: ${verification.failingLayers.join(', ')}.`);
          }
          return lines.join('\n');
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    },
  ];
  return tools;
}

/** Placeholder tools (ALL_TOOLS) — host thay bằng bản bound khi có base dir. */
export const CODING_V17_TOOLS: Tool[] = createCodingV17Tools();

/** Đảm bảo base dir có thư mục dữ liệu v17 (dùng khi host bind). */
export function codingV17EnsureBaseDir(baseDir: string): string {
  return codingV17EnsureDataDir(baseDir);
}
