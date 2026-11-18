/**
 * Eval Harness v3 tools (v1.35, Đội T4).
 *
 * 8 tools, placeholder trong ALL_TOOLS cho tới khi host bind
 * (`createEvalHarnessV3Tools(getBaseDir, opts)` với userData dir của app):
 *
 *  - eval_harness_v3_list_tasks    — liệt kê task v3 (builtin mẫu + task
 *    trên đĩa `<baseDir>/eval-harness-v3-tasks`), kèm kind/difficulty/
 *    container/test/oracle/guardrail có hay không.
 *  - eval_harness_v3_validate_task — validate một task (builtin theo id
 *    hoặc thư mục task), trả về lỗi/cảnh báo cụ thể; `checkOracle=true`
 *    chạy thêm oracle validation (chứng minh task giải được + ổn định).
 *  - eval_harness_v3_run_task      — chạy một task N trial trong container,
 *    chấm bằng test xác định, có guardrail + trace; agent chạy bằng
 *    executor: host bind executor thật qua opts; mặc định dùng executor
 *    "scripted" theo `agentFiles` hoặc no-op — tool báo rõ executor nào.
 *  - eval_harness_v3_run_suite     — chạy bộ task mẫu (hoặc danh sách
 *    id), gom báo cáo 4 chiều + pass@k + flake-adjusted + Wilson CI 95%,
 *    lưu report JSON + trace JSONL.
 *  - eval_harness_v3_run_set       — chạy một eval set từ registry
 *    (theo đúng thứ tự + version của set), báo task id thiếu nếu có.
 *  - eval_harness_v3_baseline      — chạy suite rồi lưu điểm làm baseline
 *    local (`eval-harness-v3/baseline.json`) cho regression gate.
 *  - eval_harness_v3_gate          — chạy suite rồi so với baseline đã
 *    lưu: tụt quá ngưỡng → gate FAIL kèm task nào tụt; chưa có baseline
 *    → PASS kèm ghi chú; khác set version → yêu cầu baseline mới.
 *  - eval_harness_v3_trace         — đọc trace quyết định của một run
 *    (`<baseDir>/eval-harness-v3-traces/<runId>.jsonl`): tóm tắt từng
 *    trial (span nào fail/trip/timeout) để truy vết không cần chạy lại.
 *
 * SAFETY: mọi lần chạy đều trong container (docker khi có, bwrap khi
 * không, fallback local có cảnh báo); không gọi mạng trừ khi task cho
 * network=proxy; không gọi model trực tiếp; report/baseline/trace lưu
 * local-first, mode 0600; secret trong trace đã redact.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  BUILTIN_EVAL_HARNESS_V3_SUITE,
  appendEvalHarnessV3GateHistory,
  appendEvalTraceToFile,
  buildEvalHarnessV3Baseline,
  builtinEvalHarnessV3Tasks,
  checkEvalHarnessV3Regression,
  countTraceProblems,
  defaultEvalHarnessV3TasksDir,
  defaultEvalHarnessV3TracesDir,
  DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS,
  defaultEvalHarnessV3Guardrails,
  loadEvalHarnessV3Baseline,
  loadEvalHarnessV3Registry,
  loadEvalHarnessV3TaskFromDir,
  loadEvalHarnessV3TasksFromDir,
  materializeBuiltinEvalHarnessV3Tasks,
  newEvalHarnessV3RunId,
  noopEvalHarnessV3Executor,
  readEvalTracesFromFile,
  renderEvalHarnessV3GateText,
  renderEvalHarnessV3RegistryText,
  renderEvalHarnessV3SuiteText,
  renderEvalHarnessV3ValidationText,
  renderGuardrailTripsText,
  renderOracleValidationTextV3,
  runEvalHarnessV3Suite,
  runEvalHarnessV3Task,
  saveEvalHarnessV3Baseline,
  saveEvalHarnessV3Registry,
  saveEvalHarnessV3Report,
  scriptedEvalHarnessV3Executor,
  summarizeEvalTrace,
  validateEvalHarnessV3Task,
  validateOracleSolutionV3,
  type EvalHarnessV3AgentResult,
  type EvalHarnessV3Executor,
  type EvalHarnessV3Registry,
  type EvalHarnessV3Suite,
  type EvalHarnessV3Task,
} from '@open-bot/core';

const NOT_WIRED =
  'Eval Harness v3 is not configured: the host has not wired a base directory yet. ' +
  'Bind createEvalHarnessV3Tools(getBaseDir) with the app userData directory first.';

export const EVAL_HARNESS_V3_TOOL_NAMES = [
  'eval_harness_v3_list_tasks',
  'eval_harness_v3_validate_task',
  'eval_harness_v3_run_task',
  'eval_harness_v3_run_suite',
  'eval_harness_v3_run_set',
  'eval_harness_v3_baseline',
  'eval_harness_v3_gate',
  'eval_harness_v3_trace',
] as const;

export function isEvalHarnessV3ToolName(name: string): boolean {
  return (EVAL_HARNESS_V3_TOOL_NAMES as readonly string[]).includes(name);
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

function getNumberArg(args: Record<string, unknown>, name: string, defaultValue: number): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
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

export interface EvalHarnessV3ToolOptions {
  /** Executor thật do host cung cấp (ghi đè executor mặc định scripted/no-op). */
  executor?: EvalHarnessV3Executor;
  /** Plan scripted mặc định: map taskId → kết quả agent (files/commands/steps/tokens). */
  agentFiles?: Record<string, EvalHarnessV3AgentResult>;
  /** Số trial mặc định mỗi task (mặc định = task.maxTrials). */
  trials?: number;
  /** Concurrency mặc định (mặc định 4). */
  concurrency?: number;
  /** Nhãn agent ghi vào report (mặc định 'scripted' / 'noop' / 'custom'). */
  agentLabel?: string;
  /** Chế độ chạy guardrail mặc định (mặc định 'parallel'). */
  guardrailMode?: 'parallel' | 'sequential';
}

function taskSummary(task: EvalHarnessV3Task): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    difficulty: task.difficulty,
    description: task.description,
    version: task.version,
    timeoutMs: task.timeoutMs,
    maxTrials: task.maxTrials,
    container: task.container ?? {},
    tests: task.tests.map((t) => ({ id: t.id, name: t.name, group: t.group, weight: t.weight ?? 1 })),
    hasOracle: Object.keys(task.oracle.files ?? {}).length > 0 || (task.oracle.commands ?? []).length > 0,
    guardrails: {
      enabled: task.guardrails?.enabled !== false,
      mode: task.guardrails?.mode ?? 'parallel',
      deniedTools: task.guardrails?.deniedTools ?? [],
      count: defaultEvalHarnessV3Guardrails(task).length,
    },
    tags: task.tags ?? [],
  };
}

export function createEvalHarnessV3Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: EvalHarnessV3ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  /** Task có sẵn: builtin + task trên đĩa (disk thắng builtin cùng id). */
  const loadAvailableTasks = (base: string): { tasks: EvalHarnessV3Task[]; skipped: Array<{ dir: string; reason: string }> } => {
    const tasksDir = defaultEvalHarnessV3TasksDir(base);
    materializeBuiltinEvalHarnessV3Tasks(tasksDir);
    const loaded = loadEvalHarnessV3TasksFromDir(tasksDir);
    const byId = new Map<string, EvalHarnessV3Task>();
    for (const task of builtinEvalHarnessV3Tasks()) byId.set(task.id, task);
    for (const task of loaded.tasks) byId.set(task.id, task);
    return {
      tasks: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
      skipped: loaded.skipped,
    };
  };

  const findTask = (base: string, taskId: string): EvalHarnessV3Task | undefined => {
    const { tasks } = loadAvailableTasks(base);
    return tasks.find((t) => t.id === taskId);
  };

  /** Registry: builtin set chỉ thêm khi chưa có (set của user thắng builtin). */
  const loadRegistry = (base: string): EvalHarnessV3Registry => {
    const { registry } = loadEvalHarnessV3Registry(base);
    registry.registerTasks(builtinEvalHarnessV3Tasks());
    if (registry.getSet('v3-sample') === undefined) {
      registry.upsertSet({
        id: 'v3-sample',
        name: 'Eval Harness v3 — sample set',
        description: 'Bộ task mẫu v3 (4 task).',
        taskIds: [...BUILTIN_EVAL_HARNESS_V3_SUITE.tasks.map((t) => t.id)],
        tags: ['sample'],
      });
    }
    if (registry.getSet('v3-smoke') === undefined) {
      registry.upsertSet({
        id: 'v3-smoke',
        name: 'Eval Harness v3 — smoke set',
        description: 'Bộ smoke nhanh (2 task).',
        taskIds: ['v3-sample-add', 'v3-sample-greet'],
        tags: ['smoke'],
      });
    }
    return registry;
  };

  /** Executor cho một lần chạy: host executor > scripted plan > noop. */
  const resolveExecutor = (
    agentFilesJson: string,
  ): { executor: EvalHarnessV3Executor; agentLabel: string } => {
    if (toolOptions.executor !== undefined) {
      return { executor: toolOptions.executor, agentLabel: toolOptions.agentLabel ?? 'custom' };
    }
    let plan: Record<string, EvalHarnessV3AgentResult> = { ...(toolOptions.agentFiles ?? {}) };
    if (agentFilesJson !== '') {
      try {
        const parsed = JSON.parse(agentFilesJson) as Record<string, EvalHarnessV3AgentResult>;
        plan = { ...plan, ...parsed };
      } catch (err) {
        throw new Error(`agentFilesJson không parse được: ${(err as Error).message}`);
      }
    }
    if (Object.keys(plan).length > 0) {
      return { executor: scriptedEvalHarnessV3Executor(plan), agentLabel: toolOptions.agentLabel ?? 'scripted' };
    }
    return { executor: noopEvalHarnessV3Executor, agentLabel: toolOptions.agentLabel ?? 'noop' };
  };

  /** Chạy một suite và lưu trace JSONL của mọi trial (trả về runId + đường dẫn). */
  const runSuiteWithTraces = async (
    base: string,
    suite: EvalHarnessV3Suite,
    executor: EvalHarnessV3Executor,
    agentLabel: string,
    trials: number,
    concurrency: number,
  ) => {
    const runId = newEvalHarnessV3RunId();
    const tracesDir = defaultEvalHarnessV3TracesDir(base);
    const result = await runEvalHarnessV3Suite(suite, executor, {
      trials,
      concurrency,
      agentLabel,
      baseDir: base,
      guardrailMode: toolOptions.guardrailMode ?? 'parallel',
      onTrace: (trace) => appendEvalTraceToFile(tracesDir, runId, trace),
    });
    // runEvalHarnessV3Suite tự tạo runId riêng cho report — đồng bộ
    // trace file theo runId của report để tool trace tìm được.
    const traceFile = `${path.join(tracesDir, runId)}.jsonl`;
    const reportRunTraceFile = path.join(tracesDir, `${result.runId}.jsonl`);
    if (fs.existsSync(traceFile) && traceFile !== reportRunTraceFile) {
      fs.renameSync(traceFile, reportRunTraceFile);
    }
    return { result, tracePath: reportRunTraceFile };
  };

  const listTasksTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_list_tasks',
      'List Eval Harness v3 tasks available locally (built-in sample tasks plus tasks on disk under <baseDir>/eval-harness-v3-tasks). Returns id, kind (issue-patch or state-check), difficulty, container spec, tests, oracle and guardrail config. No network, no model calls.',
      {
        kind: { type: 'string', description: 'Optional filter: "issue-patch" or "state-check".' },
        difficulty: { type: 'string', description: 'Optional filter: "easy", "medium" or "hard".' },
        includeRegistry: { type: 'boolean', description: 'Also include the eval registry (sets) in the output (default false).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const kind = getStringArg(args, 'kind');
        const difficulty = getStringArg(args, 'difficulty');
        const includeRegistry = getBooleanArg(args, 'includeRegistry', false);
        const { tasks, skipped } = loadAvailableTasks(base);
        const filtered = tasks.filter(
          (t) =>
            (kind === '' || t.kind === kind) && (difficulty === '' || t.difficulty === difficulty),
        );
        const out: Record<string, unknown> = {
          tasks: filtered.map(taskSummary),
          skippedDirs: skipped,
          count: filtered.length,
        };
        if (includeRegistry) out['registry'] = renderEvalHarnessV3RegistryText(loadRegistry(base));
        return JSON.stringify(out, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validateTaskTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_validate_task',
      'Validate an Eval Harness v3 task (by built-in task id, or by task directory path). Returns valid true/false plus every validation issue (bad format/version, missing oracle, unsafe paths, forbidden test commands, bad container spec, bad guardrail config) and warnings. With checkOracle=true it also runs the oracle solution N times to prove the task is solvable and deterministic (no flaky tests). Read-only except oracle validation runs tests in a temp container.',
      {
        taskId: { type: 'string', description: 'Built-in task id (e.g. "v3-sample-add").' },
        taskDir: { type: 'string', description: 'Task directory path (alternative to taskId).' },
        checkOracle: { type: 'boolean', description: 'Also run the oracle solution to prove the task is solvable and stable (default false).' },
        oracleRepeats: { type: 'number', description: 'How many times to run the oracle tests (default 3).' },
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
        const checkOracle = getBooleanArg(args, 'checkOracle', false);
        const oracleRepeats = getNumberArg(args, 'oracleRepeats', 3);
        if (taskId === '' && taskDir === '') {
          return errorResult('Provide taskId (built-in task) or taskDir (task directory).');
        }
        let task: EvalHarnessV3Task;
        let rawForValidation: unknown;
        if (taskDir !== '') {
          if (!fs.existsSync(taskDir)) return errorResult(`Task directory does not exist: "${taskDir}".`);
          task = loadEvalHarnessV3TaskFromDir(taskDir);
          rawForValidation = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as unknown;
        } else {
          const found = findTask(base, taskId);
          if (found === undefined) {
            return errorResult(`No Eval Harness v3 task "${taskId}". Use eval_harness_v3_list_tasks to see available tasks.`);
          }
          task = found;
          rawForValidation = task;
        }
        const validation = validateEvalHarnessV3Task(rawForValidation);
        let oracleText = '';
        let oracleValid: boolean | null = null;
        if (checkOracle && validation.valid) {
          const oracleResult = await validateOracleSolutionV3(task, { repeats: oracleRepeats });
          oracleValid = oracleResult.valid;
          oracleText = renderOracleValidationTextV3(oracleResult);
        }
        return JSON.stringify(
          {
            taskId: task.id,
            valid: validation.valid && (oracleValid ?? true),
            issues: validation.issues,
            warnings: validation.warnings,
            oracleValid,
            text: `${renderEvalHarnessV3ValidationText(task.id, validation)}${oracleText}`,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runTaskTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_run_task',
      'Run one Eval Harness v3 task N times (trials) in its container and score it with deterministic tests (no LLM judge). Input/output/tool guardrails run on every trial; a blocking trip stops the trial with status "guardrail-trip" before the agent patch is applied. Returns per-trial status, weighted + flake-adjusted score, pass@k, duration, steps, estimated cost and guardrail trips, plus the decision trace id. Agent runs via the bound executor, a scripted agentFiles plan, or no-op when nothing is provided (reported honestly as agentLabel "noop").',
      {
        taskId: { type: 'string', description: 'Task id to run (e.g. "v3-sample-add").' },
        trials: { type: 'number', description: 'Number of trials (default: task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> {files, commands, toolCalls, steps, inputTokens, outputTokens} for the scripted executor.' },
        guardrailMode: { type: 'string', description: 'Guardrail mode: "parallel" (default) or "sequential".' },
      },
      ['taskId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const taskId = getStringArg(args, 'taskId', true);
        const task = findTask(base, taskId);
        if (task === undefined) {
          return errorResult(`No Eval Harness v3 task "${taskId}". Use eval_harness_v3_list_tasks to see available tasks.`);
        }
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const modeArg = getStringArg(args, 'guardrailMode');
        const guardrailMode = modeArg === 'sequential' ? 'sequential' as const : 'parallel' as const;
        const tracesDir = defaultEvalHarnessV3TracesDir(base);
        const runId = newEvalHarnessV3RunId();
        const result = await runEvalHarnessV3Task(task, executor, {
          trials: getNumberArg(args, 'trials', toolOptions.trials ?? task.maxTrials ?? 3),
          concurrency: getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
          guardrailMode,
          onTrace: (trace) => appendEvalTraceToFile(tracesDir, runId, trace),
        });
        const trips = result.trials.flatMap((t) => t.guardrailTrips ?? []);
        return JSON.stringify(
          {
            agentLabel,
            traceRunId: runId,
            guardrailTripsText: renderGuardrailTripsText(trips),
            ...result,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runSuiteTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_run_suite',
      'Run the Eval Harness v3 sample suite (or a given list of task ids) with N trials per task in parallel, then aggregate: trial pass rate with Wilson 95% CI, task pass rate, mean score + flake-adjusted score, pass@k, guardrail trip count. Saves a JSON report under <baseDir>/eval-harness-v3-reports and decision traces under <baseDir>/eval-harness-v3-traces. No network, no model calls unless the bound executor uses one.',
      {
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Optional task ids to run (default: whole sample suite).' },
        trials: { type: 'number', description: 'Trials per task (default: each task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> scripted agent result.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const taskIds = getStringArrayArg(args, 'taskIds');
        const { tasks } = loadAvailableTasks(base);
        const selected =
          taskIds.length === 0
            ? [...BUILTIN_EVAL_HARNESS_V3_SUITE.tasks]
            : taskIds.map((id) => {
                const found = tasks.find((t) => t.id === id);
                if (found === undefined) throw new Error(`No Eval Harness v3 task "${id}".`);
                return found;
              });
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const suite: EvalHarnessV3Suite = {
          id: taskIds.length === 0 ? BUILTIN_EVAL_HARNESS_V3_SUITE.id : 'v3-custom',
          name: 'Eval Harness v3 suite',
          description: '',
          tasks: selected,
        };
        const { result, tracePath } = await runSuiteWithTraces(
          base,
          suite,
          executor,
          agentLabel,
          getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
        );
        const reportPath = saveEvalHarnessV3Report(base, result);
        return JSON.stringify(
          { ...result, reportPath, tracePath, text: renderEvalHarnessV3SuiteText(result) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runSetTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_run_set',
      'Run one eval set from the registry (tasks in the set order, pinned to the set version). Returns the suite result plus the set version and any task ids missing from the registry (reported, not silently skipped). Saves a JSON report and decision traces like run_suite.',
      {
        setId: { type: 'string', description: 'Eval set id (e.g. "v3-sample" or "v3-smoke").' },
        trials: { type: 'number', description: 'Trials per task (default: each task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> scripted agent result.' },
      },
      ['setId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const setId = getStringArg(args, 'setId', true);
        const registry = loadRegistry(base);
        const { set, tasks, missing } = registry.resolveEvalSet(setId);
        if (tasks.length === 0) {
          return errorResult(`Eval set "${setId}" has no registered tasks (missing: ${missing.join(', ') || 'none'}).`);
        }
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const suite: EvalHarnessV3Suite = {
          id: set.id,
          name: set.name,
          description: set.description,
          tasks,
        };
        const { result, tracePath } = await runSuiteWithTraces(
          base,
          suite,
          executor,
          agentLabel,
          getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
        );
        const reportPath = saveEvalHarnessV3Report(base, result);
        return JSON.stringify(
          {
            ...result,
            setId: set.id,
            setVersion: set.version,
            missingTaskIds: missing,
            reportPath,
            tracePath,
            text: renderEvalHarnessV3SuiteText(result),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const baselineTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_baseline',
      'Run the Eval Harness v3 sample suite and save its scores as the local baseline (<baseDir>/eval-harness-v3/baseline.json) for the regression gate. Overwrites the previous baseline. Returns the baseline summary.',
      {
        trials: { type: 'number', description: 'Trials per task (default: each task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> scripted agent result.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const { result } = await runSuiteWithTraces(
          base,
          BUILTIN_EVAL_HARNESS_V3_SUITE,
          executor,
          agentLabel,
          getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
        );
        const baseline = buildEvalHarnessV3Baseline(result);
        const baselinePath = saveEvalHarnessV3Baseline(base, baseline);
        return JSON.stringify({ baselinePath, ...baseline }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gateTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_gate',
      'Regression gate for CI: run the Eval Harness v3 sample suite and compare with the saved local baseline. Returns passed=false when the suite trial pass rate drops more than 0.05, any task drops more than 0.10, mean score drops more than 0.05, cost/duration rise past their limits, or any guardrail trips (limit 0 by default), with per-task findings. No baseline yet -> passed=true with noBaseline=true (and saves the baseline). A set version change -> versionMismatch, save a new baseline first.',
      {
        trials: { type: 'number', description: 'Trials per task (default: each task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> scripted agent result.' },
        suitePassRateDrop: { type: 'number', description: 'Max allowed suite pass-rate drop (default 0.05).' },
        taskPassRateDrop: { type: 'number', description: 'Max allowed per-task pass-rate drop (default 0.10).' },
        meanScoreDrop: { type: 'number', description: 'Max allowed mean-score drop (default 0.05).' },
        maxGuardrailTrips: { type: 'number', description: 'Max allowed guardrail trips in the suite (default 0).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const { result } = await runSuiteWithTraces(
          base,
          BUILTIN_EVAL_HARNESS_V3_SUITE,
          executor,
          agentLabel,
          getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
        );
        const baseline = loadEvalHarnessV3Baseline(base);
        const gate = checkEvalHarnessV3Regression(baseline, result, {
          ...DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS,
          suitePassRateDrop: getNumberArg(args, 'suitePassRateDrop', DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS.suitePassRateDrop ?? 0.05),
          taskPassRateDrop: getNumberArg(args, 'taskPassRateDrop', DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS.taskPassRateDrop ?? 0.1),
          meanScoreDrop: getNumberArg(args, 'meanScoreDrop', DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS.meanScoreDrop ?? 0.05),
          maxGuardrailTrips: getNumberArg(args, 'maxGuardrailTrips', DEFAULT_EVAL_HARNESS_V3_GATE_THRESHOLDS.maxGuardrailTrips ?? 0),
        });
        appendEvalHarnessV3GateHistory(base, gate);
        if (gate.noBaseline) {
          // Lần chạy đầu: lưu luôn làm baseline để lần sau có cái để so.
          saveEvalHarnessV3Baseline(base, buildEvalHarnessV3Baseline(result));
        }
        return JSON.stringify({ ...gate, text: renderEvalHarnessV3GateText(gate) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const traceTool: Tool = {
    definition: toolDef(
      'eval_harness_v3_trace',
      'Read decision traces of an Eval Harness v3 run (<baseDir>/eval-harness-v3-traces/<runId>.jsonl). Returns one summary line per trial (outcome, duration, span counts, fail/trip/timeout/error counts) so you can see why a trial passed, failed or tripped without re-running it. With trialId set, returns the full span timeline of that trial.',
      {
        runId: { type: 'string', description: 'Run id (the <runId> in the trace file name, e.g. from run_suite output).' },
        trialId: { type: 'string', description: 'Optional trial id to show the full span timeline for (e.g. "v3-sample-add-t0").' },
      },
      ['runId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const runId = getStringArg(args, 'runId', true);
        const trialId = getStringArg(args, 'trialId');
        const tracesDir = defaultEvalHarnessV3TracesDir(base);
        const filePath = path.join(tracesDir, `${runId}.jsonl`);
        if (!fs.existsSync(filePath)) {
          return errorResult(`No traces for run "${runId}" (${filePath} does not exist). Run a suite/task first.`);
        }
        const traces = readEvalTracesFromFile(filePath);
        if (trialId !== '') {
          const found = traces.find((t) => t.trialId === trialId);
          if (found === undefined) {
            return errorResult(`No trace for trial "${trialId}" in run "${runId}".`);
          }
          // Render timeline trực tiếp tại đây.
          const lines: string[] = [
            `Trace ${found.traceId} — trial ${found.trialId} (${found.taskId}) → ${found.outcome}`,
            `  started ${new Date(found.startedAt).toISOString()}, duration ${found.finishedAt - found.startedAt}ms, spans ${found.spans.length}`,
          ];
          for (const span of found.spans) {
            const offset = span.startedAt - found.startedAt;
            lines.push(
              `  +${offset}ms [${span.kind}] ${span.name} — ${span.status} (${span.durationMs}ms)${span.note !== undefined ? ` — ${span.note}` : ''}`,
            );
          }
          return JSON.stringify({ runId, trialId, trace: found, text: `${lines.join('\n')}\n` }, null, 2);
        }
        const summaries = traces.map((t) => ({
          trialId: t.trialId,
          taskId: t.taskId,
          outcome: t.outcome,
          durationMs: t.finishedAt - t.startedAt,
          spans: t.spans.length,
          problems: countTraceProblems(t),
          summary: summarizeEvalTrace(t),
        }));
        return JSON.stringify({ runId, tracePath: filePath, count: traces.length, trials: summaries }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [listTasksTool, validateTaskTool, runTaskTool, runSuiteTool, runSetTool, baselineTool, gateTool, traceTool];
}

/** Placeholder tools (NOT_WIRED) cho ALL_TOOLS — host bind bản có baseDir sau. */
export const EVAL_HARNESS_V3_TOOLS: Tool[] = createEvalHarnessV3Tools();

/** Lưu registry v3 ra đĩa (tiện cho host/CLI dùng lại sau khi upsert set). */
export { saveEvalHarnessV3Registry };
