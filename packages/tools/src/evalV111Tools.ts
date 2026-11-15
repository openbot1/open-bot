/**
 * Harbor eval + training-data + Agent Profiles tools (v1.11, Đội T2).
 *
 * 9 tools, placeholder trong ALL_TOOLS cho tới khi host bind
 * (`createEvalV111Tools(getBaseDir, opts)` với userData dir của app):
 *
 *  - eval_v111_list_tasks      — liệt kê task Harbor (builtin + task
 *    trên đĩa `<baseDir>/harbor-tasks`), kèm kind/test/trọng số.
 *  - eval_v111_validate_task   — validate một task (builtin theo id
 *    hoặc thư mục task), trả về lỗi/cảnh báo cụ thể.
 *  - eval_v111_run_task        — chạy một task trong sandbox box,
 *    chấm bằng test.sh, điểm test = reward; ghi rollout JSONL.
 *    Agent chạy bằng executor: host bind executor thật qua opts;
 *    mặc định dùng executor "scripted" theo `agentFiles` (map
 *    đường dẫn → nội dung file agent sẽ tạo) hoặc no-op khi không
 *    truyền gì — tool báo rõ executor nào đã chạy, không giả vờ.
 *  - eval_v111_run_suite       — chạy toàn bộ task builtin (hoặc
 *    danh sách id), gom báo cáo tổng hợp + lưu report + JSONL.
 *  - eval_v111_export_rollout  — validate + thống kê file rollout
 *    JSONL, hoặc export sang SFT JSONL để fine-tune local.
 *  - eval_v111_list_profiles   — liệt kê Agent Profiles (builtin +
 *    custom, kèm enabled/model/tools).
 *  - eval_v111_set_profile     — bật/tắt profile hoặc đặt model
 *    mặc định cho profile.
 *  - eval_v111_profile_for_task — chọn profile cho một loại task
 *    (coding/research/writing/review/general/data) + resolve model
 *    qua ModelRegistry khi profile chưa đặt model cụ thể.
 *  - eval_v111_report          — báo cáo tổng hợp từ các lần chạy
 *    Harbor đã lưu (Markdown + số liệu theo task/profile).
 *
 * SAFETY: mọi lần chạy đều trong BotBoxManager (loopback-only,
 * bwrap/unshare khi có); rollout export redact secret trước khi
 * ghi; không gọi mạng, không gọi model trực tiếp.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  AgentProfileStore,
  HarborRunner,
  aggregateHarborResults,
  builtinHarborTasks,
  defaultHarborTasksDir,
  getBuiltinHarborTask,
  getHarborReportsDir,
  isAgentProfileKind,
  listHarborRunReports,
  loadHarborTaskFromDir,
  loadHarborTasksFromDir,
  materializeBuiltinHarborTasks,
  noopHarborExecutor,
  readRolloutJsonl,
  renderHarborReportMarkdown,
  resolveProfileModel,
  rolloutToSftJsonl,
  saveHarborRunResult,
  saveHarborSuiteResult,
  scriptedHarborExecutor,
  summarizeRollouts,
  validateHarborTask,
  validateRolloutJsonl,
  writeRolloutJsonl,
  type AgentProfileKind,
  type HarborAgentExecutor,
  type HarborRunResult,
  type HarborTask,
} from '@open-bot/core';

const NOT_WIRED =
  'Eval v1.11 is not configured: the host has not wired a base directory yet. ' +
  'Bind createEvalV111Tools(getBaseDir) with the app userData directory first.';

export const EVAL_V111_TOOL_NAMES = [
  'eval_v111_list_tasks',
  'eval_v111_validate_task',
  'eval_v111_run_task',
  'eval_v111_run_suite',
  'eval_v111_export_rollout',
  'eval_v111_list_profiles',
  'eval_v111_set_profile',
  'eval_v111_profile_for_task',
  'eval_v111_report',
] as const;

export function isEvalV111ToolName(name: string): boolean {
  return (EVAL_V111_TOOL_NAMES as readonly string[]).includes(name);
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

function getBooleanArg(args: Record<string, unknown>, name: string, defaultValue = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function taskSummary(task: HarborTask): Record<string, unknown> {
  const weights = task.meta.testWeights;
  return {
    id: task.meta.id,
    name: task.meta.name,
    kind: task.meta.kind,
    description: task.meta.description,
    version: task.meta.version,
    timeoutMs: task.meta.timeoutMs,
    maxTurns: task.meta.maxTurns,
    tests: Object.keys(weights).sort(),
    totalWeight: Object.values(weights).reduce((a, b) => a + b, 0),
    testWeights: weights,
    tags: task.meta.tags,
    environmentFiles: task.environment.map((f) => f.relativePath),
  };
}

function runSummary(result: HarborRunResult): Record<string, unknown> {
  return {
    rolloutId: result.rolloutId,
    taskId: result.taskId,
    taskVersion: result.taskVersion,
    profileId: result.profileId,
    model: result.model,
    passed: result.passed,
    reward: result.reward,
    tests: result.testRun.perTest,
    durationMs: result.durationMs,
    usage: result.usage,
    isolation: result.isolation,
    error: result.error,
  };
}

export interface EvalV111ToolOptions {
  /** Executor thật do host cung cấp (ghi đè executor mặc định theo agentFiles/no-op). */
  executor?: HarborAgentExecutor;
  /** Timeout chạy test.sh (mặc định 60_000 ms). */
  testTimeoutMs?: number;
}

export function evalV111TasksDir(baseDir: string): string {
  return defaultHarborTasksDir(baseDir);
}

export function evalV111RolloutsPath(baseDir: string): string {
  return path.join(baseDir, 'eval-harbor', 'rollouts.jsonl');
}

export function createEvalV111Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: EvalV111ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  /** Task có sẵn: builtin + task trên đĩa (ghi đè builtin cùng id thì disk thắng). */
  const loadAvailableTasks = (base: string): { tasks: HarborTask[]; skipped: { dir: string; issues: { field: string; message: string }[] }[] } => {
    const tasksDir = evalV111TasksDir(base);
    materializeBuiltinHarborTasks(tasksDir);
    const { tasks, skipped } = loadHarborTasksFromDir(tasksDir);
    const byId = new Map<string, HarborTask>();
    for (const task of builtinHarborTasks()) byId.set(task.meta.id, task);
    for (const task of tasks) byId.set(task.meta.id, task);
    return { tasks: [...byId.values()].sort((a, b) => a.meta.id.localeCompare(b.meta.id)), skipped };
  };

  const findTask = (base: string, taskId: string): HarborTask | undefined => {
    const { tasks } = loadAvailableTasks(base);
    return tasks.find((t) => t.meta.id === taskId);
  };

  const listTasksTool: Tool = {
    definition: toolDef(
      'eval_v111_list_tasks',
      'List Harbor-format eval tasks available locally (built-in sample tasks plus tasks on disk under <baseDir>/harbor-tasks). Returns id, kind, description, test names with weights, timeout and environment files. No network, no model calls.',
      { kind: { type: 'string', description: 'Optional filter: coding, research, writing, review, general, or data.' } },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const kind = getStringArg(args, 'kind');
        const { tasks, skipped } = loadAvailableTasks(base);
        const filtered = kind === '' ? tasks : tasks.filter((t) => t.meta.kind === kind);
        return JSON.stringify({ tasks: filtered.map(taskSummary), skippedDirs: skipped.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validateTaskTool: Tool = {
    definition: toolDef(
      'eval_v111_validate_task',
      'Validate a Harbor eval task (by built-in task id, or by task directory path). Returns valid true/false plus every validation issue (missing files, bad weights, unsafe paths, forbidden test.sh patterns) and warnings. Read-only.',
      {
        taskId: { type: 'string', description: 'Built-in task id (e.g. "sum-csv").' },
        taskDir: { type: 'string', description: 'Task directory path (alternative to taskId).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const taskId = getStringArg(args, 'taskId');
        const taskDir = getStringArg(args, 'taskDir');
        if (taskId === '' && taskDir === '') {
          return errorResult('Provide taskId (built-in task) or taskDir (task directory).');
        }
        let task: HarborTask;
        if (taskDir !== '') {
          task = loadHarborTaskFromDir(taskDir);
          return JSON.stringify({ taskId: task.meta.id, valid: true, issues: [], warnings: [] }, null, 2);
        }
        const found = findTask(base, taskId);
        if (!found) return errorResult(`No Harbor task "${taskId}". Use eval_v111_list_tasks to see available tasks.`);
        const result = validateHarborTask(found);
        return JSON.stringify({ taskId: found.meta.id, valid: result.valid, issues: result.issues, warnings: [] }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runTaskTool: Tool = {
    definition: toolDef(
      'eval_v111_run_task',
      'Run one Harbor eval task inside the local sandbox box (loopback-only, bwrap/unshare when available), score it with tests/test.sh (test score = reward), and append the rollout to eval-harbor/rollouts.jsonl. The agent runs through the host executor when bound; otherwise agentFiles (path -> file content the agent would create) scripts the agent, or no agent runs at all (reward then measures the starting environment). Returns reward, per-test results, duration, tokens and isolation.',
      {
        taskId: { type: 'string', description: 'Task id to run (e.g. "sum-csv").' },
        profileId: { type: 'string', description: 'Agent Profile id to record on the rollout (default "").' },
        agentFiles: { type: 'object', description: 'Optional map of workspace path -> file content the scripted agent creates (e.g. {"result.txt": "50\\n"}).' },
      },
      ['taskId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const taskId = getStringArg(args, 'taskId', true);
        const profileId = getStringArg(args, 'profileId');
        const task = findTask(base, taskId);
        if (!task) return errorResult(`No Harbor task "${taskId}". Use eval_v111_list_tasks to see available tasks.`);
        const rawFiles = args['agentFiles'];
        let executor = toolOptions.executor;
        let executorKind = 'host';
        if (!executor) {
          if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
            const files: Record<string, string> = {};
            for (const [k, v] of Object.entries(rawFiles as Record<string, unknown>)) {
              if (typeof v !== 'string') return errorResult(`agentFiles["${k}"] must be a string.`);
              files[k] = v;
            }
            executor = scriptedHarborExecutor(files);
            executorKind = 'scripted';
          } else {
            executor = noopHarborExecutor;
            executorKind = 'noop';
          }
        }
        const store = new AgentProfileStore(base);
        const profile = profileId !== '' ? store.get(profileId) : undefined;
        if (profileId !== '' && !profile) return errorResult(`No Agent Profile "${profileId}".`);
        const runner = new HarborRunner({
          baseDir: path.join(base, 'eval-harbor'),
          executor,
          ...(toolOptions.testTimeoutMs !== undefined ? { testTimeoutMs: toolOptions.testTimeoutMs } : {}),
        });
        const result = await runner.runTask(task, {
          ...(profileId !== '' ? { profileId } : {}),
          ...(profile ? { systemPrompt: profile.systemPrompt } : {}),
          ...(profile ? { model: resolveProfileModel(profile) } : {}),
        });
        const reportPath = saveHarborRunResult(base, result);
        writeRolloutJsonl(evalV111RolloutsPath(base), [result.rollout], 'append');
        return JSON.stringify({ executor: executorKind, reportPath, ...runSummary(result) }, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runSuiteTool: Tool = {
    definition: toolDef(
      'eval_v111_run_suite',
      'Run a Harbor eval suite (all built-in tasks by default, or the given task ids) sequentially in the sandbox, one task at a time. Scores each task with its test.sh, aggregates pass rate / mean reward / time / tokens, saves the suite report and appends every rollout to eval-harbor/rollouts.jsonl. Returns the aggregate summary.',
      {
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Task ids to run (default: all built-in tasks).' },
        profileId: { type: 'string', description: 'Agent Profile id to record on every rollout (default "").' },
        agentFilesByTask: { type: 'object', description: 'Optional map taskId -> { path -> content } for the scripted agent, per task.' },
      },
      [],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const requestedIds = getStringArrayArg(args, 'taskIds');
        const profileId = getStringArg(args, 'profileId');
        const { tasks } = loadAvailableTasks(base);
        const selected = requestedIds.length === 0 ? tasks : tasks.filter((t) => requestedIds.includes(t.meta.id));
        if (selected.length === 0) return errorResult('No tasks selected. Use eval_v111_list_tasks to see available tasks.');
        const missing = requestedIds.filter((id) => !tasks.some((t) => t.meta.id === id));
        if (missing.length > 0) return errorResult(`Unknown task ids: ${missing.join(', ')}.`);
        const store = new AgentProfileStore(base);
        const profile = profileId !== '' ? store.get(profileId) : undefined;
        if (profileId !== '' && !profile) return errorResult(`No Agent Profile "${profileId}".`);
        const rawByTask = args['agentFilesByTask'];
        const byTaskFiles: Record<string, Record<string, string>> = {};
        if (rawByTask && typeof rawByTask === 'object' && !Array.isArray(rawByTask)) {
          for (const [taskId, files] of Object.entries(rawByTask as Record<string, unknown>)) {
            if (!files || typeof files !== 'object' || Array.isArray(files)) {
              return errorResult(`agentFilesByTask["${taskId}"] must be an object of path -> content.`);
            }
            const mapped: Record<string, string> = {};
            for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
              if (typeof v !== 'string') return errorResult(`agentFilesByTask["${taskId}"]["${k}"] must be a string.`);
              mapped[k] = v;
            }
            byTaskFiles[taskId] = mapped;
          }
        }
        const runner = new HarborRunner({
          baseDir: path.join(base, 'eval-harbor'),
          executor: toolOptions.executor ?? (async (ctx) => {
            const files = byTaskFiles[ctx.task.meta.id];
            if (files) return scriptedHarborExecutor(files)(ctx);
            return noopHarborExecutor();
          }),
          ...(toolOptions.testTimeoutMs !== undefined ? { testTimeoutMs: toolOptions.testTimeoutMs } : {}),
        });
        const suite = await runner.runSuite(selected, {
          ...(profileId !== '' ? { profileId } : {}),
          ...(profile ? { systemPrompt: profile.systemPrompt } : {}),
          ...(profile ? { model: resolveProfileModel(profile) } : {}),
        });
        const suitePath = saveHarborSuiteResult(base, suite);
        writeRolloutJsonl(evalV111RolloutsPath(base), suite.results.map((r) => r.rollout), 'append');
        const aggregate = aggregateHarborResults(suite.results);
        return JSON.stringify(
          {
            suitePath,
            rolloutsPath: evalV111RolloutsPath(base),
            passed: suite.passed,
            failed: suite.failed,
            passRate: suite.passRate,
            meanReward: suite.meanReward,
            durationMs: suite.durationMs,
            totalTokens: suite.totalPromptTokens + suite.totalCompletionTokens,
            markdown: renderHarborReportMarkdown(aggregate),
            results: suite.results.map(runSummary),
          },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const exportRolloutTool: Tool = {
    definition: toolDef(
      'eval_v111_export_rollout',
      'Validate the local rollout JSONL file (eval-harbor/rollouts.jsonl) and report stats (rollouts, pass rate, mean reward, tokens by task). With format "sft", also export the rollouts as SFT training JSONL (one assistant turn per line) to eval-harbor/rollouts-sft.jsonl for local fine-tuning. Secrets are redacted before export.',
      { format: { type: 'string', description: '"rollout" (validate + stats only) or "sft" (also write SFT JSONL). Default "rollout".' } },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const format = getStringArg(args, 'format') || 'rollout';
        if (format !== 'rollout' && format !== 'sft') {
          return errorResult('format must be "rollout" or "sft".');
        }
        const rolloutsPath = evalV111RolloutsPath(base);
        if (!fs.existsSync(rolloutsPath)) {
          return JSON.stringify({ rolloutsPath, rollouts: 0, message: 'No rollouts recorded yet — run a task or suite first.' }, null, 2);
        }
        const content = fs.readFileSync(rolloutsPath, 'utf-8');
        const validation = validateRolloutJsonl(content);
        const records = readRolloutJsonl(rolloutsPath);
        const stats = summarizeRollouts(records);
        let sftPath: string | null = null;
        let sftLines = 0;
        if (format === 'sft') {
          const lines: string[] = [];
          for (const record of records) lines.push(...rolloutToSftJsonl(record));
          sftPath = path.join(base, 'eval-harbor', 'rollouts-sft.jsonl');
          fs.mkdirSync(path.dirname(sftPath), { recursive: true });
          fs.writeFileSync(sftPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf-8');
          sftLines = lines.length;
        }
        return JSON.stringify(
          { rolloutsPath, valid: validation.valid, issues: validation.issues.slice(0, 20), stats, ...(sftPath ? { sftPath, sftLines } : {}) },
          null,
          2,
        ).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listProfilesTool: Tool = {
    definition: toolDef(
      'eval_v111_list_profiles',
      'List Agent Profiles (built-in presets plus user custom profiles): id, kind, label, provider, model (empty = registry default), tools allow-list, deny-list, turn budget, enabled flag. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const store = new AgentProfileStore(base);
        return JSON.stringify(
          {
            profiles: store.list().map((p) => ({
              id: p.id,
              label: p.label,
              kind: p.kind,
              description: p.description,
              provider: p.provider,
              model: p.model,
              tools: p.tools,
              denyTools: p.denyTools,
              turnBudget: p.turnBudget,
              enabled: p.enabled,
              builtin: p.builtin,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setProfileTool: Tool = {
    definition: toolDef(
      'eval_v111_set_profile',
      'Change an Agent Profile: enable/disable it, or set its default provider + model (empty model = use the ModelRegistry default for that provider). Persists to agent-profiles.json. Built-in profiles cannot be deleted, only disabled.',
      {
        profileId: { type: 'string', description: 'Profile id (e.g. "coding").' },
        enabled: { type: 'boolean', description: 'Enable (true) or disable (false) the profile.' },
        provider: { type: 'string', description: 'Provider to set as the profile default (e.g. "ollama").' },
        model: { type: 'string', description: 'Model to set as the profile default ("" = registry default).' },
      },
      ['profileId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const profileId = getStringArg(args, 'profileId', true);
        const store = new AgentProfileStore(base);
        const profile = store.get(profileId);
        if (!profile) return errorResult(`No Agent Profile "${profileId}".`);
        const enabled = args['enabled'];
        const provider = getStringArg(args, 'provider');
        const model = getStringArg(args, 'model');
        let updated = profile;
        if (typeof enabled === 'boolean') updated = store.setEnabled(profileId, enabled);
        if (provider !== '') {
          if (args['model'] === undefined) return errorResult('Setting a provider also needs "model" (use "" for the registry default).');
          updated = store.setModel(profileId, provider, model);
        } else if (args['model'] !== undefined) {
          return errorResult('Setting a model also needs "provider".');
        }
        return JSON.stringify(
          { id: updated.id, label: updated.label, kind: updated.kind, provider: updated.provider, model: updated.model, enabled: updated.enabled },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const profileForTaskTool: Tool = {
    definition: toolDef(
      'eval_v111_profile_for_task',
      'Pick the Agent Profile for a task kind (coding, research, writing, review, general, data) and resolve its model: an explicit profile model wins, otherwise the ModelRegistry default for the profile provider is used (self-hosted path). Also returns the profile system prompt and the tool allow-list after deny-list filtering.',
      { kind: { type: 'string', description: 'Task kind: coding, research, writing, review, general, or data.' } },
      ['kind'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const kind = getStringArg(args, 'kind', true);
        if (!isAgentProfileKind(kind)) {
          return errorResult(`kind must be one of: coding, research, writing, review, general, data (got "${kind}").`);
        }
        const store = new AgentProfileStore(base);
        const profile = store.profileForKind(kind as AgentProfileKind);
        if (!profile) return errorResult('No enabled Agent Profile available (all profiles are disabled).');
        const resolved = resolveProfileModel(profile);
        return JSON.stringify(
          {
            profileId: profile.id,
            label: profile.label,
            kind: profile.kind,
            provider: resolved.provider,
            model: resolved.model,
            modelResolved: resolved.model !== '',
            systemPrompt: profile.systemPrompt,
            turnBudget: profile.turnBudget,
            tools: profile.tools,
            denyTools: profile.denyTools,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'eval_v111_report',
      'Aggregate report over saved Harbor eval runs (eval-harbor-reports/*.json): pass rate, mean reward, time, tokens by task and by profile, worst runs, rendered as Markdown. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const reportsDir = getHarborReportsDir(base);
        const files = listHarborRunReports(base);
        const results: HarborRunResult[] = [];
        for (const file of files) {
          try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as HarborRunResult & { results?: HarborRunResult[] };
            if (parsed && typeof parsed === 'object' && parsed.rolloutId) results.push(parsed);
            else if (parsed && Array.isArray(parsed.results)) {
              for (const item of parsed.results) {
                if (item && typeof item === 'object' && item.rolloutId) results.push(item);
              }
            }
          } catch {
            // File báo cáo hỏng — bỏ qua, không làm hỏng cả báo cáo.
          }
        }
        if (results.length === 0) {
          return JSON.stringify({ reportsDir, runs: 0, message: 'No Harbor runs saved yet — run a task or suite first.' }, null, 2);
        }
        const aggregate = aggregateHarborResults(results);
        return JSON.stringify({ reportsDir, ...aggregate, runs: results.length, markdown: renderHarborReportMarkdown(aggregate) }, null, 2).slice(0, 20000);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    listTasksTool,
    validateTaskTool,
    runTaskTool,
    runSuiteTool,
    exportRolloutTool,
    listProfilesTool,
    setProfileTool,
    profileForTaskTool,
    reportTool,
  ];
}

/** Unbound placeholders — vào ALL_TOOLS, trả lời "not configured" khi chưa bind. */
export const EVAL_V111_TOOLS: Tool[] = createEvalV111Tools();
