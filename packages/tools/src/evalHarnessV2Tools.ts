/**
 * Eval Harness v2 tools (v1.34, Đội T4).
 *
 * 6 tools, placeholder trong ALL_TOOLS cho tới khi host bind
 * (`createEvalHarnessV2Tools(getBaseDir, opts)` với userData dir của app):
 *
 *  - eval_harness_v2_list_tasks    — liệt kê task v2 (builtin mẫu + task
 *    trên đĩa `<baseDir>/eval-harness-v2-tasks`), kèm kind/difficulty/
 *    test/oracle có hay không.
 *  - eval_harness_v2_validate_task — validate một task (builtin theo id
 *    hoặc thư mục task), trả về lỗi/cảnh báo cụ thể; `checkOracle=true`
 *    chạy thêm oracle validation (chứng minh task giải được).
 *  - eval_harness_v2_run_task      — chạy một task N trial trong sandbox,
 *    chấm bằng test xác định; agent chạy bằng executor: host bind
 *    executor thật qua opts; mặc định dùng executor "scripted" theo
 *    `agentFiles` (map taskId → files/commands agent sẽ làm) hoặc
 *    no-op khi không truyền gì — tool báo rõ executor nào đã chạy.
 *  - eval_harness_v2_run_suite     — chạy bộ task mẫu (hoặc danh sách
 *    id), gom báo cáo 4 chiều + Wilson CI 95%, lưu report JSON.
 *  - eval_harness_v2_baseline      — chạy suite rồi lưu điểm làm baseline
 *    local (`eval-harness-v2/baseline.json`) cho regression gate.
 *  - eval_harness_v2_gate          — chạy suite rồi so với baseline đã
 *    lưu: tụt quá ngưỡng → gate FAIL kèm task nào tụt; chưa có baseline
 *    → PASS kèm ghi chú.
 *
 * SAFETY: mọi lần chạy đều trong sandbox (bwrap khi có, fallback local
 * có cảnh báo); không gọi mạng, không gọi model trực tiếp; report và
 * baseline lưu local-first, mode 0600.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  BUILTIN_EVAL_HARNESS_V2_SUITE,
  buildEvalHarnessV2Baseline,
  builtinEvalHarnessV2Tasks,
  checkEvalHarnessV2Regression,
  DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS,
  defaultEvalHarnessV2TasksDir,
  loadEvalHarnessV2Baseline,
  loadEvalHarnessV2TaskFromDir,
  loadEvalHarnessV2TasksFromDir,
  materializeBuiltinEvalHarnessV2Tasks,
  noopEvalHarnessV2Executor,
  renderEvalHarnessV2GateText,
  renderEvalHarnessV2SuiteText,
  renderEvalHarnessV2ValidationText,
  renderOracleValidationText,
  runEvalHarnessV2Suite,
  runEvalHarnessV2Task,
  saveEvalHarnessV2Baseline,
  saveEvalHarnessV2Report,
  scriptedEvalHarnessV2Executor,
  validateEvalHarnessV2Task,
  validateOracleSolution,
  type EvalHarnessV2AgentResult,
  type EvalHarnessV2Executor,
  type EvalHarnessV2Suite,
  type EvalHarnessV2Task,
} from '@open-bot/core';

const NOT_WIRED =
  'Eval Harness v2 is not configured: the host has not wired a base directory yet. ' +
  'Bind createEvalHarnessV2Tools(getBaseDir) with the app userData directory first.';

export const EVAL_HARNESS_V2_TOOL_NAMES = [
  'eval_harness_v2_list_tasks',
  'eval_harness_v2_validate_task',
  'eval_harness_v2_run_task',
  'eval_harness_v2_run_suite',
  'eval_harness_v2_baseline',
  'eval_harness_v2_gate',
] as const;

export function isEvalHarnessV2ToolName(name: string): boolean {
  return (EVAL_HARNESS_V2_TOOL_NAMES as readonly string[]).includes(name);
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

export interface EvalHarnessV2ToolOptions {
  /** Executor thật do host cung cấp (ghi đè executor mặc định scripted/no-op). */
  executor?: EvalHarnessV2Executor;
  /** Plan scripted mặc định: map taskId → kết quả agent (files/commands/steps/tokens). */
  agentFiles?: Record<string, EvalHarnessV2AgentResult>;
  /** Số trial mặc định mỗi task (mặc định = task.maxTrials). */
  trials?: number;
  /** Concurrency mặc định (mặc định 4). */
  concurrency?: number;
  /** Nhãn agent ghi vào report (mặc định 'scripted' / 'noop' / 'custom'). */
  agentLabel?: string;
}

function taskSummary(task: EvalHarnessV2Task): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    kind: task.kind,
    difficulty: task.difficulty,
    description: task.description,
    version: task.version,
    timeoutMs: task.timeoutMs,
    maxTrials: task.maxTrials,
    tests: task.tests.map((t) => ({ id: t.id, name: t.name, group: t.group, weight: t.weight ?? 1 })),
    hasOracle: Object.keys(task.oracle.files ?? {}).length > 0 || (task.oracle.commands ?? []).length > 0,
    tags: task.tags ?? [],
  };
}

export function createEvalHarnessV2Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: EvalHarnessV2ToolOptions = {},
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
  const loadAvailableTasks = (base: string): { tasks: EvalHarnessV2Task[]; skipped: Array<{ dir: string; reason: string }> } => {
    const tasksDir = defaultEvalHarnessV2TasksDir(base);
    materializeBuiltinEvalHarnessV2Tasks(tasksDir);
    const loaded = loadEvalHarnessV2TasksFromDir(tasksDir);
    const byId = new Map<string, EvalHarnessV2Task>();
    for (const task of builtinEvalHarnessV2Tasks()) byId.set(task.id, task);
    for (const task of loaded.tasks) byId.set(task.id, task);
    return {
      tasks: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
      skipped: loaded.skipped,
    };
  };

  const findTask = (base: string, taskId: string): EvalHarnessV2Task | undefined => {
    const { tasks } = loadAvailableTasks(base);
    return tasks.find((t) => t.id === taskId);
  };

  /** Executor cho một lần chạy: host executor > scripted plan > noop. */
  const resolveExecutor = (
    agentFilesJson: string,
  ): { executor: EvalHarnessV2Executor; agentLabel: string } => {
    if (toolOptions.executor !== undefined) {
      return { executor: toolOptions.executor, agentLabel: toolOptions.agentLabel ?? 'custom' };
    }
    let plan: Record<string, EvalHarnessV2AgentResult> = { ...(toolOptions.agentFiles ?? {}) };
    if (agentFilesJson !== '') {
      try {
        const parsed = JSON.parse(agentFilesJson) as Record<string, EvalHarnessV2AgentResult>;
        plan = { ...plan, ...parsed };
      } catch (err) {
        throw new Error(`agentFilesJson không parse được: ${(err as Error).message}`);
      }
    }
    if (Object.keys(plan).length > 0) {
      return { executor: scriptedEvalHarnessV2Executor(plan), agentLabel: toolOptions.agentLabel ?? 'scripted' };
    }
    return { executor: noopEvalHarnessV2Executor, agentLabel: toolOptions.agentLabel ?? 'noop' };
  };

  const listTasksTool: Tool = {
    definition: toolDef(
      'eval_harness_v2_list_tasks',
      'List Eval Harness v2 tasks available locally (built-in sample tasks plus tasks on disk under <baseDir>/eval-harness-v2-tasks). Returns id, kind (issue-patch or state-check), difficulty, description, tests and whether an oracle solution exists. No network, no model calls.',
      {
        kind: { type: 'string', description: 'Optional filter: "issue-patch" or "state-check".' },
        difficulty: { type: 'string', description: 'Optional filter: "easy", "medium" or "hard".' },
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
        const { tasks, skipped } = loadAvailableTasks(base);
        const filtered = tasks.filter(
          (t) =>
            (kind === '' || t.kind === kind) && (difficulty === '' || t.difficulty === difficulty),
        );
        return JSON.stringify({ tasks: filtered.map(taskSummary), skippedDirs: skipped, count: filtered.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const validateTaskTool: Tool = {
    definition: toolDef(
      'eval_harness_v2_validate_task',
      'Validate an Eval Harness v2 task (by built-in task id, or by task directory path). Returns valid true/false plus every validation issue (bad format/version, missing oracle, unsafe paths, forbidden test commands) and warnings. With checkOracle=true it also runs the oracle solution to prove the task is solvable. Read-only except oracle validation runs tests in a temp sandbox.',
      {
        taskId: { type: 'string', description: 'Built-in task id (e.g. "v2-sample-add").' },
        taskDir: { type: 'string', description: 'Task directory path (alternative to taskId).' },
        checkOracle: { type: 'boolean', description: 'Also run the oracle solution to prove the task is solvable (default false).' },
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
        if (taskId === '' && taskDir === '') {
          return errorResult('Provide taskId (built-in task) or taskDir (task directory).');
        }
        let task: EvalHarnessV2Task;
        let rawForValidation: unknown;
        if (taskDir !== '') {
          if (!fs.existsSync(taskDir)) return errorResult(`Task directory does not exist: "${taskDir}".`);
          task = loadEvalHarnessV2TaskFromDir(taskDir);
          rawForValidation = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as unknown;
        } else {
          const found = findTask(base, taskId);
          if (found === undefined) {
            return errorResult(`No Eval Harness v2 task "${taskId}". Use eval_harness_v2_list_tasks to see available tasks.`);
          }
          task = found;
          rawForValidation = task;
        }
        const validation = validateEvalHarnessV2Task(rawForValidation);
        let oracleText = '';
        let oracleValid: boolean | null = null;
        if (checkOracle && validation.valid) {
          const oracleResult = await validateOracleSolution(task);
          oracleValid = oracleResult.valid;
          oracleText = renderOracleValidationText(oracleResult);
        }
        return JSON.stringify(
          {
            taskId: task.id,
            valid: validation.valid && (oracleValid ?? true),
            issues: validation.issues,
            warnings: validation.warnings,
            oracleValid,
            text: `${renderEvalHarnessV2ValidationText(task.id, validation)}${oracleText}`,
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
      'eval_harness_v2_run_task',
      'Run one Eval Harness v2 task N times (trials) in the sandbox and score it with deterministic tests (no LLM judge). Returns per-trial status, weighted score, duration, steps and estimated cost, plus the 4-dimension summary. Agent runs via the bound executor, a scripted agentFiles plan, or no-op when nothing is provided (reported honestly as agentLabel "noop").',
      {
        taskId: { type: 'string', description: 'Task id to run (e.g. "v2-sample-add").' },
        trials: { type: 'number', description: 'Number of trials (default: task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> {files, commands, steps, inputTokens, outputTokens} for the scripted executor.' },
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
          return errorResult(`No Eval Harness v2 task "${taskId}". Use eval_harness_v2_list_tasks to see available tasks.`);
        }
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const result = await runEvalHarnessV2Task(task, executor, {
          trials: getNumberArg(args, 'trials', toolOptions.trials ?? task.maxTrials ?? 3),
          concurrency: getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
        });
        return JSON.stringify({ agentLabel, ...result }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runSuiteTool: Tool = {
    definition: toolDef(
      'eval_harness_v2_run_suite',
      'Run the Eval Harness v2 sample suite (or a given list of task ids) with N trials per task in parallel, then aggregate: trial pass rate with Wilson 95% CI, task pass rate, mean score/duration/steps/cost. Saves a JSON report under <baseDir>/eval-harness-v2-reports. No network, no model calls unless the bound executor uses one.',
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
            ? [...BUILTIN_EVAL_HARNESS_V2_SUITE.tasks]
            : taskIds.map((id) => {
                const found = tasks.find((t) => t.id === id);
                if (found === undefined) throw new Error(`No Eval Harness v2 task "${id}".`);
                return found;
              });
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const suite: EvalHarnessV2Suite = {
          id: taskIds.length === 0 ? BUILTIN_EVAL_HARNESS_V2_SUITE.id : 'v2-custom',
          name: 'Eval Harness v2 suite',
          description: '',
          tasks: selected,
        };
        const result = await runEvalHarnessV2Suite(suite, executor, {
          trials: getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          concurrency: getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
          agentLabel,
          saveReport: false,
        });
        const reportPath = saveEvalHarnessV2Report(base, result);
        return JSON.stringify(
          { ...result, reportPath, text: renderEvalHarnessV2SuiteText(result) },
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
      'eval_harness_v2_baseline',
      'Run the Eval Harness v2 sample suite and save its scores as the local baseline (<baseDir>/eval-harness-v2/baseline.json) for the regression gate. Overwrites the previous baseline. Returns the baseline summary.',
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
        const result = await runEvalHarnessV2Suite(BUILTIN_EVAL_HARNESS_V2_SUITE, executor, {
          trials: getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          concurrency: getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
          agentLabel,
          baseDir: base,
        });
        const baseline = buildEvalHarnessV2Baseline(result);
        const baselinePath = saveEvalHarnessV2Baseline(base, baseline);
        return JSON.stringify({ baselinePath, ...baseline }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const gateTool: Tool = {
    definition: toolDef(
      'eval_harness_v2_gate',
      'Regression gate for CI: run the Eval Harness v2 sample suite and compare with the saved local baseline. Returns passed=false when the suite trial pass rate drops more than 0.05 or any task drops more than 0.10, with per-task findings. No baseline yet -> passed=true with noBaseline=true.',
      {
        trials: { type: 'number', description: 'Trials per task (default: each task maxTrials).' },
        concurrency: { type: 'number', description: 'Max parallel trials (default 4).' },
        agentFilesJson: { type: 'string', description: 'Optional JSON map taskId -> scripted agent result.' },
        suitePassRateDrop: { type: 'number', description: 'Max allowed suite pass-rate drop (default 0.05).' },
        taskPassRateDrop: { type: 'number', description: 'Max allowed per-task pass-rate drop (default 0.10).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const { executor, agentLabel } = resolveExecutor(getStringArg(args, 'agentFilesJson'));
        const result = await runEvalHarnessV2Suite(BUILTIN_EVAL_HARNESS_V2_SUITE, executor, {
          trials: getNumberArg(args, 'trials', toolOptions.trials ?? 3),
          concurrency: getNumberArg(args, 'concurrency', toolOptions.concurrency ?? 4),
          agentLabel,
          baseDir: base,
        });
        const baseline = loadEvalHarnessV2Baseline(base);
        const gate = checkEvalHarnessV2Regression(baseline, result, {
          ...DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS,
          suitePassRateDrop: getNumberArg(args, 'suitePassRateDrop', DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS.suitePassRateDrop),
          taskPassRateDrop: getNumberArg(args, 'taskPassRateDrop', DEFAULT_EVAL_HARNESS_V2_GATE_THRESHOLDS.taskPassRateDrop),
        });
        if (gate.noBaseline) {
          // Lần chạy đầu: lưu luôn làm baseline để lần sau có cái để so.
          saveEvalHarnessV2Baseline(base, buildEvalHarnessV2Baseline(result));
        }
        return JSON.stringify({ ...gate, text: renderEvalHarnessV2GateText(gate) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [listTasksTool, validateTaskTool, runTaskTool, runSuiteTool, baselineTool, gateTool];
}

/** Placeholder tools (NOT_WIRED) cho ALL_TOOLS — host bind bản có baseDir sau. */
export const EVAL_HARNESS_V2_TOOLS: Tool[] = createEvalHarnessV2Tools();
