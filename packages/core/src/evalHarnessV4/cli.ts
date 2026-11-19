/**
 * Lệnh CLI của Eval Harness v4 (v1.44, Đội T2).
 *
 * Lớp CLI thuần trong core (không gọi `process.exit`, không ghi
 * trực tiếp ra stdout — trả về `{ exitCode, stdout, json }` để
 * `apps/cli` in ra và quyết định exit code, và để test gọi trực
 * tiếp mà không cần spawn process):
 *
 *   eval v4 run         — chạy suite theo config, ghi lịch sử,
 *                         so hồi quy, render dashboard.
 *   eval v4 list        — liệt kê task trong task set đã resolve.
 *   eval v4 history     — liệt kê các run đã lưu (mới nhất trước).
 *   eval v4 regressions — báo cáo hồi quy của một run (mặc định
 *                         run mới nhất) so với baseline.
 *   eval v4 dashboard   — build + render dashboard hồi quy.
 *   eval v4 flakes      — phân tích flake + gợi ý quarantine.
 *   eval v4 config      — in config đã resolve; `--init` ghi file
 *                         `eval.config.json` mẫu.
 *   eval v4 pin         — pin một run làm baseline (`--run <id>`).
 *   eval v4 unpin       — xoá baseline đã pin.
 *
 * Cờ chung: `--config <path>`, `--json`, `--tasks a,b`,
 * `--tags a,b`, `--kinds a,b`, `--exclude a,b`, `--repeats N`,
 * `--task-timeout N`, `--test-timeout N`, `--profile ID`,
 * `--agent-files FILE.json`, `--agent-files-by-task FILE.json`,
 * `--baseline <runId>`, `--no-fail-on-regression`, `--limit N`,
 * `--name <name>`, `--formats md,html,json`.
 *
 * Executor: CLI không gọi model trực tiếp — `--agent-files` là
 * JSON `{ đường-dẫn: nội dung }` mà agent scripted sẽ tạo (giống
 * `eval harbor run` v1.11); không truyền thì chạy no-op (đo
 * baseline: reward 0 khi task thiết kế đúng). Host muốn chạy agent
 * thật thì bind executor qua `EvalHarnessV4CliContext.executor`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { harborTestScriptWarnings, loadHarborTaskFromDir, validateHarborTask, type HarborTask } from '../eval/harborTask';
import {
  noopHarborExecutor,
  scriptedHarborExecutor,
  type HarborAgentExecutor,
} from '../eval/harborRunner';
import { materializeBuiltinHarborTasks } from '../eval/harborLibrary';
import type { EvalHarnessV4Config, EvalHarnessV4RunRecord } from './types';
import {
  applyEvalHarnessV4CliOverrides,
  defaultEvalHarnessV4Config,
  evalHarnessV4ConfigJsonSchema,
  findEvalHarnessV4ConfigFile,
  loadEvalHarnessV4ConfigFile,
  sampleEvalHarnessV4Config,
  serializeEvalHarnessV4Config,
  type EvalHarnessV4CliOverrides,
} from './config';
import { materializeBuiltinEvalHarnessV4Tasks } from './builtinTasks';
import {
  collectEvalHarnessV4Tasks,
  describeEvalHarnessV4TaskSet,
  filterHarborTasksBySelection,
  resolveEvalHarnessV4TaskSet,
} from './taskSet';
import {
  getEvalHarnessV4HistoryDir,
  loadEvalHarnessV4History,
  loadEvalHarnessV4Run,
  pinEvalHarnessV4Baseline,
  resolveEvalHarnessV4BaselineRun,
  unpinEvalHarnessV4Baseline,
} from './history';
import {
  buildEvalHarnessV4DashboardFromHistory,
  renderEvalHarnessV4DashboardHtml,
  renderEvalHarnessV4DashboardMarkdown,
} from './dashboard';
import {
  analyzeEvalHarnessV4FlakesFromHistory,
  formatEvalHarnessV4FlakeText,
} from './flake';
import { applyEvalHarnessV4Suite, listEvalHarnessV4SuiteIds } from './suite';
import {
  detectEvalHarnessV4Regressions,
  evalHarnessV4GateExitCode,
  formatEvalHarnessV4RegressionText,
} from './regression';
import { EvalHarnessV4Runner, formatEvalHarnessV4RunSummary, isEvalHarnessV4AbortError } from './runner';

/** Lệnh con của `eval v4`. */
export type EvalHarnessV4CliCommand =
  | 'run'
  | 'list'
  | 'validate'
  | 'history'
  | 'regressions'
  | 'dashboard'
  | 'flakes'
  | 'config'
  | 'pin'
  | 'unpin'
  | 'help';

export const EVAL_HARNESS_V4_CLI_COMMANDS: readonly EvalHarnessV4CliCommand[] = [
  'run',
  'list',
  'validate',
  'history',
  'regressions',
  'dashboard',
  'flakes',
  'config',
  'pin',
  'unpin',
  'help',
];

/** Kết quả parse argv (lỗi parse trả về `errors`, không throw). */
export interface EvalHarnessV4CliParsed {
  command: EvalHarnessV4CliCommand;
  positionals: string[];
  flags: Record<string, string | boolean>;
  errors: string[];
}

/** Context mà host (apps/cli) cung cấp khi thực thi lệnh. */
export interface EvalHarnessV4CliContext {
  /** Thư mục dữ liệu gốc (chứa boxes + lịch sử V4). */
  baseDir: string;
  /** Thư mục làm việc (để tìm eval.config.json mặc định). */
  cwd: string;
  /** Executor chạy agent thật (nếu có — thắng executor scripted/no-op). */
  executor?: HarborAgentExecutor;
  /** System prompt gắn vào executor (khi host resolve profile). */
  systemPrompt?: string;
  /** Model gắn vào executor (khi host resolve profile/model). */
  model?: { provider: string; model: string };
}

export interface EvalHarnessV4CliResult {
  exitCode: number;
  stdout: string;
  /** Bản JSON khi `--json` (để apps/cli in thay cho text). */
  json?: unknown;
}

const VALUE_FLAGS = new Set([
  'config',
  'tasks',
  'tags',
  'kinds',
  'exclude',
  'repeats',
  'task-timeout',
  'test-timeout',
  'profile',
  'agent-files',
  'agent-files-by-task',
  'baseline',
  'limit',
  'min-runs',
  'threshold',
  'suite',
  'name',
  'note',
  'formats',
  'run',
]);
const BOOLEAN_FLAGS = new Set(['json', 'init', 'no-fail-on-regression', 'schema']);

/**
 * Parse argv của `eval v4 ...` (đã bỏ `eval v4` ở đầu).
 * Hỗ trợ `--flag value` và `--flag=value`; cờ không biết → error.
 */
export function parseEvalHarnessV4CliArgs(argv: readonly string[]): EvalHarnessV4CliParsed {
  const errors: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: EvalHarnessV4CliCommand = 'help';
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
      if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) {
          errors.push(`Cờ --${name} không nhận giá trị.`);
        } else {
          flags[name] = true;
        }
        continue;
      }
      if (!VALUE_FLAGS.has(name)) {
        errors.push(`Cờ không biết: --${name}.`);
        continue;
      }
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`Cờ --${name} cần một giá trị.`);
        continue;
      }
      flags[name] = next;
      i += 1;
      continue;
    }
    if (!commandSet) {
      if ((EVAL_HARNESS_V4_CLI_COMMANDS as readonly string[]).includes(arg)) {
        command = arg as EvalHarnessV4CliCommand;
      } else {
        errors.push(`Lệnh không biết: "${arg}" (run, list, history, regressions, dashboard, config, pin, unpin, help).`);
        command = 'help';
      }
      commandSet = true;
      continue;
    }
    positionals.push(arg);
  }
  return { command, positionals, flags, errors };
}

function splitCsv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

function parseIntFlag(flags: Record<string, string | boolean>, name: string, errors: string[]): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`Cờ --${name} cần một số nguyên.`);
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    errors.push(`Cờ --${name} phải là số nguyên (nhận được "${raw}").`);
    return undefined;
  }
  return parsed;
}

/** Đọc file JSON (throw với message rõ khi file lỗi). */
export function readEvalHarnessV4JsonFile(filePath: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Không đọc được ${what} "${filePath}": ${(err as Error).message}`);
  }
}

/**
 * Build executor cho CLI: executor host cung cấp thắng;
 * `--agent-files-by-task` (theo task) thắng `--agent-files` (chung);
 * không có gì thì no-op (đo baseline).
 */
export function buildEvalHarnessV4CliExecutor(
  ctx: EvalHarnessV4CliContext,
  flags: Record<string, string | boolean>,
): HarborAgentExecutor {
  if (ctx.executor) return ctx.executor;
  const readFiles = (filePath: string): Record<string, string> => {
    const parsed = readEvalHarnessV4JsonFile(filePath, 'agent files');
    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') throw new Error(`agent-files "${filePath}": giá trị của "${key}" phải là chuỗi.`);
      files[key] = value;
    }
    return files;
  };
  const globalFiles =
    typeof flags['agent-files'] === 'string' ? readFiles(flags['agent-files']) : null;
  let byTask: Record<string, Record<string, string>> | null = null;
  if (typeof flags['agent-files-by-task'] === 'string') {
    const parsed = readEvalHarnessV4JsonFile(flags['agent-files-by-task'], 'agent files by task');
    byTask = {};
    for (const [taskId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`agent-files-by-task: giá trị của task "${taskId}" phải là object { đường-dẫn: nội dung }.`);
      }
      const files: Record<string, string> = {};
      for (const [key, content] of Object.entries(value as Record<string, unknown>)) {
        if (typeof content !== 'string') throw new Error(`agent-files-by-task: giá trị của "${taskId}/${key}" phải là chuỗi.`);
        files[key] = content;
      }
      byTask[taskId] = files;
    }
  }
  if (globalFiles === null && byTask === null) return noopHarborExecutor;
  return async (agentCtx) => {
    const files = byTask?.[agentCtx.task.meta.id] ?? globalFiles ?? {};
    return scriptedHarborExecutor(files)(agentCtx);
  };
}

/** Text help của `eval v4` (apps/cli in khi user gõ `eval v4 help`). */
export function evalHarnessV4CliHelp(): string {
  return [
    'open-bot eval v4 run [--config FILE] [--tasks a,b] [--tags a,b] [--kinds a,b] [--exclude a,b]',
    '    [--repeats N] [--task-timeout MS] [--test-timeout MS] [--profile ID]',
    '    [--agent-files FILE.json] [--agent-files-by-task FILE.json] [--baseline RUNID]',
    '    [--no-fail-on-regression] [--name NAME] [--json]',
    '  Chạy suite Harbor theo config, ghi lịch sử, so hồi quy, render dashboard.',
    '  Exit 0 khi gate pass/warn, exit 1 khi gate block (trừ khi --no-fail-on-regression).',
    'open-bot eval v4 list [--config FILE] [--tasks a,b] [--tags a,b] [--kinds a,b] [--exclude a,b] [--json]',
    '  Liệt kê task trong task set đã resolve (builtin + builtin-v4 + thư mục task).',
    'open-bot eval v4 validate <taskId|dir> [--json]',
    '  Validate một task Harbor (thiếu file, trọng số sai, đường dẫn',
    '  không an toàn, test.sh phá hoại) + cảnh báo test.sh đáng ngờ.',
    'open-bot eval v4 history [--limit N] [--json]',
    '  Liệt kê các run đã lưu (mới nhất trước).',
    'open-bot eval v4 regressions [--run RUNID] [--baseline RUNID] [--json]',
    '  Báo cáo hồi quy của một run (mặc định run mới nhất) so với baseline.',
    'open-bot eval v4 dashboard [--formats md,html,json] [--limit N] [--json]',
    '  Build + render dashboard hồi quy từ lịch sử.',
    'open-bot eval v4 flakes [--limit N] [--min-runs N] [--threshold X] [--json]',
    '  Phân tích flake qua lịch sử (task/test lúc pass lúc fail) +',
    '  gợi ý quarantine (task nên cách ly khỏi gate).',
    'open-bot eval v4 config [--config FILE] [--init] [--schema] [--json]',
    '  In config đã resolve; --init ghi file eval.config.json mẫu;',
    '  --schema in JSON Schema của eval.config.json.',
    'open-bot eval v4 pin <runId> [--note TEXT]',
    '  Pin một run làm baseline cho các lần so sánh sau.',
    'open-bot eval v4 unpin',
    '  Xoá baseline đã pin (về so với lần chạy trước đó).',
    '',
  ].join('\n');
}

/**
 * Resolve config cho lệnh: file config (nếu có) + override từ cờ CLI.
 * Trả về config + issues (caller dừng khi issues không rỗng).
 */
export function resolveEvalHarnessV4CliConfig(
  ctx: EvalHarnessV4CliContext,
  flags: Record<string, string | boolean>,
): { config: EvalHarnessV4Config; issues: { field: string; message: string }[]; configPath: string | null } {
  const configPath = findEvalHarnessV4ConfigFile(
    typeof flags['config'] === 'string' ? flags['config'] : undefined,
    ctx.cwd,
  );
  let config: EvalHarnessV4Config = defaultEvalHarnessV4Config();
  const issues: { field: string; message: string }[] = [];
  if (configPath !== null) {
    const loaded = loadEvalHarnessV4ConfigFile(configPath);
    config = loaded.config;
    issues.push(...loaded.validation.issues);
  }
  // Suite preset áp TRƯỚC cờ CLI (cờ CLI thắng preset).
  if (typeof flags['suite'] === 'string') {
    const applied = applyEvalHarnessV4Suite(config, flags['suite']);
    if (!applied.suite) {
      issues.push({
        field: 'suite',
        message: `Không có suite "${flags['suite']}". Các suite: ${listEvalHarnessV4SuiteIds().join(', ')}.`,
      });
    } else {
      config = applied.config;
    }
  }
  const overrides: EvalHarnessV4CliOverrides = {};
  const parseErrors: string[] = [];
  const repeats = parseIntFlag(flags, 'repeats', parseErrors);
  if (repeats !== undefined) overrides.repeats = repeats;
  const taskTimeout = parseIntFlag(flags, 'task-timeout', parseErrors);
  if (taskTimeout !== undefined) overrides.taskTimeoutMs = taskTimeout;
  const testTimeout = parseIntFlag(flags, 'test-timeout', parseErrors);
  if (testTimeout !== undefined) overrides.testTimeoutMs = testTimeout;
  for (const message of parseErrors) issues.push({ field: 'cli', message });
  if (typeof flags['tasks'] === 'string') overrides.includeIds = splitCsv(flags['tasks']);
  if (typeof flags['exclude'] === 'string') overrides.excludeIds = splitCsv(flags['exclude']);
  if (typeof flags['tags'] === 'string') overrides.tags = splitCsv(flags['tags']);
  if (typeof flags['kinds'] === 'string') overrides.kinds = splitCsv(flags['kinds']);
  if (typeof flags['profile'] === 'string') overrides.profileId = flags['profile'];
  if (typeof flags['baseline'] === 'string') overrides.baselineRunId = flags['baseline'];
  if (flags['no-fail-on-regression'] === true) overrides.failOnRegression = false;
  if (typeof flags['name'] === 'string') overrides.name = flags['name'];
  const applied = applyEvalHarnessV4CliOverrides(config, overrides);
  issues.push(...applied.issues);
  return { config: applied.config, issues, configPath };
}

/** Thư mục task Harbor mặc định trong dataDir (materialize task mẫu vào đây). */
export function defaultEvalHarnessV4TasksDir(baseDir: string): string {
  return path.join(baseDir, 'harbor-tasks');
}

/**
 * Load mọi task khả dụng (builtin + builtin-v4 + thư mục task)
 * — materialize task mẫu ra đĩa trước (để task trên đĩa của user
 * override được task mẫu), giống `eval harbor` của apps/cli.
 */
export function loadEvalHarnessV4AvailableTasks(
  config: EvalHarnessV4Config,
  baseDir: string,
): { tasks: HarborTask[]; skipped: { id: string; reason: string }[] } {
  const tasksDir = defaultEvalHarnessV4TasksDir(baseDir);
  materializeBuiltinHarborTasks(tasksDir);
  materializeBuiltinEvalHarnessV4Tasks(tasksDir);
  const collected = collectEvalHarnessV4Tasks({
    ...config,
    taskDirs: [...new Set([...config.taskDirs, tasksDir])],
  });
  return { tasks: collected.tasks, skipped: collected.skipped };
}

function asJsonResult(result: EvalHarnessV4CliResult): EvalHarnessV4CliResult {
  return result;
}

function issueText(issues: { field: string; message: string }[]): string {
  return issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n');
}

/** Thực thi một lệnh `eval v4` đã parse. Không gọi process.exit. */
export async function executeEvalHarnessV4Command(
  parsed: EvalHarnessV4CliParsed,
  ctx: EvalHarnessV4CliContext,
): Promise<EvalHarnessV4CliResult> {
  const asJson = parsed.flags['json'] === true;
  if (parsed.errors.length > 0) {
    return { exitCode: 2, stdout: `Lỗi tham số:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}\n${evalHarnessV4CliHelp()}` };
  }
  const historyDir = getEvalHarnessV4HistoryDir(ctx.baseDir, '');
  switch (parsed.command) {
    case 'help': {
      return { exitCode: 0, stdout: evalHarnessV4CliHelp() };
    }
    case 'config': {
      if (parsed.flags['schema'] === true) {
        const schema = evalHarnessV4ConfigJsonSchema();
        return asJsonResult({
          exitCode: 0,
          stdout: `${JSON.stringify(schema, null, 2)}\n`,
          json: schema,
        });
      }
      if (parsed.flags['init'] === true) {
        const target =
          typeof parsed.flags['config'] === 'string'
            ? path.isAbsolute(parsed.flags['config'])
              ? parsed.flags['config']
              : path.join(ctx.cwd, parsed.flags['config'])
            : path.join(ctx.cwd, 'eval.config.json');
        if (fs.existsSync(target)) {
          return { exitCode: 1, stdout: `File config đã tồn tại: "${target}" (xoá tay trước khi --init lại).\n` };
        }
        fs.writeFileSync(target, serializeEvalHarnessV4Config(sampleEvalHarnessV4Config()), 'utf-8');
        return { exitCode: 0, stdout: `Đã ghi config mẫu: "${target}".\n` };
      }
      const { config, issues, configPath } = resolveEvalHarnessV4CliConfig(ctx, parsed.flags);
      if (issues.length > 0) {
        return { exitCode: 2, stdout: `Config không hợp lệ${configPath ? ` ("${configPath}")` : ''}:\n${issueText(issues)}\n` };
      }
      const text = `Config${configPath ? ` ("${configPath}")` : ' (mặc định)'}:\n${serializeEvalHarnessV4Config(config)}`;
      return asJsonResult({ exitCode: 0, stdout: text, json: config });
    }
    case 'list': {
      const { config, issues } = resolveEvalHarnessV4CliConfig(ctx, parsed.flags);
      if (issues.length > 0) {
        return { exitCode: 2, stdout: `Config không hợp lệ:\n${issueText(issues)}\n` };
      }
      // Materialize trước rồi mới resolve (để task trên đĩa override task mẫu).
      const { tasks, skipped } = loadEvalHarnessV4AvailableTasks(config, ctx.baseDir);
      const taskSet = resolveEvalHarnessV4TaskSet({
        ...config,
        taskDirs: [...new Set([...config.taskDirs, defaultEvalHarnessV4TasksDir(ctx.baseDir)])],
      });
      const taskSetIds = new Set(taskSet.tasks.map((t) => t.taskId));
      const { kept, excluded } = filterHarborTasksBySelection(
        tasks.filter((t) => taskSetIds.has(t.meta.id)),
        config.selection,
      );
      const summary = describeEvalHarnessV4TaskSet(taskSet, kept);
      const json = {
        tasks: kept.map((t) => ({
          id: t.meta.id,
          name: t.meta.name,
          kind: t.meta.kind,
          description: t.meta.description,
          tests: Object.keys(t.meta.testWeights).sort(),
          totalWeight: Object.values(t.meta.testWeights).reduce((a, b) => a + b, 0),
          timeoutMs: t.meta.timeoutMs,
          tags: t.meta.tags,
        })),
        total: summary.total,
        byKind: summary.byKind,
        bySource: summary.bySource,
        skipped: [...skipped, ...taskSet.skipped.map((s) => ({ id: s.id, reason: s.reason }))].length,
        excluded: excluded.map((e) => ({ id: e.id, reason: e.reason })),
      };
      const text =
        kept.length === 0
          ? 'Không có task nào trong task set (kiểm tra config selection / thư mục task).\n'
          : `${kept.map((t) => `${t.meta.id}  [${t.meta.kind}] ${t.meta.name} — ${t.meta.description} (tests: ${Object.keys(t.meta.testWeights).sort().join(', ')})`).join('\n')}\n` +
            `Tổng: ${summary.total} task (kind: ${JSON.stringify(summary.byKind)}, nguồn: ${JSON.stringify(summary.bySource)}).\n`;
      return asJsonResult({ exitCode: 0, stdout: text, json });
    }
    case 'validate': {
      const target = parsed.positionals[0] ?? '';
      if (target === '') {
        return { exitCode: 2, stdout: 'eval v4 validate cần <taskId|dir>: open-bot eval v4 validate sum-csv.\n' };
      }
      const { config } = resolveEvalHarnessV4CliConfig(ctx, parsed.flags);
      let task: HarborTask | undefined;
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        try {
          task = loadHarborTaskFromDir(target);
        } catch (err) {
          const issues = (err as { issues?: { field: string; message: string }[] }).issues ?? [
            { field: 'task', message: (err as Error).message },
          ];
          return asJsonResult({
            exitCode: 1,
            stdout: `Task không hợp lệ:\n${issueText(issues)}\n`,
            json: { valid: false, issues },
          });
        }
      } else {
        const { tasks } = loadEvalHarnessV4AvailableTasks(config, ctx.baseDir);
        task = tasks.find((t) => t.meta.id === target);
        if (!task) {
          return { exitCode: 1, stdout: `Không có task "${target}". Xem bằng: open-bot eval v4 list.\n` };
        }
      }
      const result = validateHarborTask(task);
      const warnings = harborTestScriptWarnings(task.testScript);
      const text = result.valid
        ? `Task "${task.meta.id}" hợp lệ.${warnings.length > 0 ? `\nCảnh báo:\n${warnings.map((w) => `  - ${w.field}: ${w.message}`).join('\n')}\n` : ''}`
        : `Task "${task.meta.id}" không hợp lệ:\n${issueText(result.issues)}\n`;
      return asJsonResult({
        exitCode: result.valid ? 0 : 1,
        stdout: text,
        json: { taskId: task.meta.id, valid: result.valid, issues: result.issues, warnings },
      });
    }
    case 'history': {
      const limit = parseIntFlag(parsed.flags, 'limit', []) ?? 20;
      const { records, corruptLines, exists } = loadEvalHarnessV4History(historyDir, { limit });
      if (!exists || records.length === 0) {
        return asJsonResult({ exitCode: 0, stdout: 'Chưa có run nào trong lịch sử.\n', json: { runs: [], corruptLines } });
      }
      const shown = [...records].reverse();
      const json = {
        runs: shown.map((r) => ({
          runId: r.runId,
          configName: r.configName,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          passed: r.passed,
          total: r.total,
          passRate: r.passRate,
          meanReward: r.meanReward,
          flakyTasks: r.flakyTasks,
        })),
        corruptLines,
      };
      const text = `${shown
        .map(
          (r) =>
            `${r.runId}  [${r.configName}] ${new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 19)}  ${r.passed}/${r.total} pass (rate ${r.passRate.toFixed(2)}, reward ${r.meanReward.toFixed(2)}, ${r.flakyTasks} flaky)`,
        )
        .join('\n')}\n${corruptLines > 0 ? `Cảnh báo: ${corruptLines} dòng lịch sử hỏng đã bị bỏ qua.\n` : ''}`;
      return asJsonResult({ exitCode: 0, stdout: text, json });
    }
    case 'regressions': {
      const runId = typeof parsed.flags['run'] === 'string' ? parsed.flags['run'] : undefined;
      const baselineId = typeof parsed.flags['baseline'] === 'string' ? parsed.flags['baseline'] : undefined;
      const { config } = resolveEvalHarnessV4CliConfig(ctx, parsed.flags);
      const current: EvalHarnessV4RunRecord | undefined = runId
        ? loadEvalHarnessV4Run(historyDir, runId)
        : loadEvalHarnessV4History(historyDir, { limit: 1 }).records[0];
      if (!current) {
        return { exitCode: 1, stdout: runId ? `Không có run "${runId}" trong lịch sử.\n` : 'Chưa có run nào trong lịch sử.\n' };
      }
      const baseline = baselineId
        ? loadEvalHarnessV4Run(historyDir, baselineId)
        : resolveEvalHarnessV4BaselineRun(historyDir, config.baselineRunId, current.runId);
      if (baselineId && !baseline) {
        return { exitCode: 1, stdout: `Không có baseline run "${baselineId}" trong lịch sử.\n` };
      }
      const report = detectEvalHarnessV4Regressions(current, baseline ?? null, config.thresholds);
      const text = formatEvalHarnessV4RegressionText(report);
      return asJsonResult({
        exitCode: evalHarnessV4GateExitCode(report.gate, config.failOnRegression),
        stdout: text,
        json: report,
      });
    }
    case 'dashboard': {
      const limit = parseIntFlag(parsed.flags, 'limit', []) ?? 0;
      const { config } = resolveEvalHarnessV4CliConfig(ctx, parsed.flags);
      const dashboard = buildEvalHarnessV4DashboardFromHistory(historyDir, {
        thresholds: config.thresholds,
        limit,
      });
      const formats = typeof parsed.flags['formats'] === 'string' ? splitCsv(parsed.flags['formats']) : ['markdown'];
      const markdown = renderEvalHarnessV4DashboardMarkdown(dashboard);
      const html = renderEvalHarnessV4DashboardHtml(dashboard);
      const wanted = new Set(formats);
      const parts: string[] = [];
      if (wanted.has('markdown')) parts.push(markdown);
      if (wanted.has('html')) parts.push(html);
      if (wanted.has('json')) parts.push(`${JSON.stringify(dashboard, null, 2)}\n`);
      const text = parts.join('\n');
      return asJsonResult({ exitCode: 0, stdout: text, json: dashboard });
    }
    case 'flakes': {
      const limit = parseIntFlag(parsed.flags, 'limit', []) ?? 0;
      const minRuns = parseIntFlag(parsed.flags, 'min-runs', []) ?? 3;
      const thresholdRaw = parsed.flags['threshold'];
      const threshold =
        typeof thresholdRaw === 'string' ? Number.parseFloat(thresholdRaw) : 0.5;
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return { exitCode: 2, stdout: 'Cờ --threshold phải là số trong [0, 1].\n' };
      }
      const report = analyzeEvalHarnessV4FlakesFromHistory(historyDir, {
        quarantineThreshold: threshold,
        minRuns,
        limit,
      });
      const text = formatEvalHarnessV4FlakeText(report);
      return asJsonResult({ exitCode: 0, stdout: text, json: report });
    }
    case 'pin': {
      const runId = parsed.positionals[0] ?? (typeof parsed.flags['run'] === 'string' ? parsed.flags['run'] : '');
      if (runId === '') {
        return { exitCode: 2, stdout: 'eval v4 pin cần <runId>: open-bot eval v4 pin v4-20261119T051500-abc123.\n' };
      }
      const run = loadEvalHarnessV4Run(historyDir, runId);
      if (!run) {
        return { exitCode: 1, stdout: `Không có run "${runId}" trong lịch sử.\n` };
      }
      const note = typeof parsed.flags['note'] === 'string' ? parsed.flags['note'] : '';
      pinEvalHarnessV4Baseline(historyDir, runId, note);
      return asJsonResult({
        exitCode: 0,
        stdout: `Đã pin run "${runId}" làm baseline.\n`,
        json: { runId, pinnedAt: Date.now(), note },
      });
    }
    case 'unpin': {
      const removed = unpinEvalHarnessV4Baseline(historyDir);
      return {
        exitCode: 0,
        stdout: removed ? 'Đã xoá baseline đã pin (về so với lần chạy trước đó).\n' : 'Chưa pin baseline nào.\n',
      };
    }
    case 'run': {
      const { config, issues } = resolveEvalHarnessV4CliConfig(ctx, parsed.flags);
      if (issues.length > 0) {
        return { exitCode: 2, stdout: `Config không hợp lệ:\n${issueText(issues)}\n` };
      }
      // Materialize task mẫu ra đĩa TRƯỚC khi resolve (để task trên
      // đĩa override task mẫu, và để taskSet khớp với task sẽ chạy).
      const { tasks: availableTasks } = loadEvalHarnessV4AvailableTasks(config, ctx.baseDir);
      const taskSet = resolveEvalHarnessV4TaskSet({
        ...config,
        taskDirs: [...new Set([...config.taskDirs, defaultEvalHarnessV4TasksDir(ctx.baseDir)])],
      });
      if (taskSet.tasks.length === 0) {
        return {
          exitCode: 1,
          stdout: `Không có task nào trong task set (tổng khả dụng: ${taskSet.totalAvailable}). Kiểm tra config selection / thư mục task.\n`,
        };
      }
      const byId = new Map(availableTasks.map((t) => [t.meta.id, t]));
      const tasks: HarborTask[] = [];
      for (const resolved of taskSet.tasks) {
        const task = byId.get(resolved.taskId);
        if (task) tasks.push(task);
      }
      const sources = new Map(taskSet.tasks.map((t) => [t.taskId, t.source]));
      let executor: HarborAgentExecutor;
      try {
        executor = buildEvalHarnessV4CliExecutor(ctx, parsed.flags);
      } catch (err) {
        return { exitCode: 2, stdout: `Không build được executor: ${(err as Error).message}\n` };
      }
      const lines: string[] = [];
      const runner = new EvalHarnessV4Runner({
        baseDir: ctx.baseDir,
        executor,
        config,
        note: typeof parsed.flags['name'] === 'string' ? parsed.flags['name'] : '',
        onTaskDone: (result) => {
          lines.push(
            `  ${result.taskId}: ${result.passed ? 'PASS' : 'FAIL'} (reward ${result.meanReward.toFixed(2)}, ${result.passes}/${result.attempts.length} attempt)${result.flaky ? ' [flaky]' : ''}`,
          );
        },
      });
      let outcome: Awaited<ReturnType<EvalHarnessV4Runner['runSuiteAndRecord']>>;
      try {
        outcome = await runner.runSuiteAndRecord(tasks, {
          sources,
          skipped: taskSet.skipped,
          ...(ctx.systemPrompt !== undefined ? { systemPrompt: ctx.systemPrompt } : {}),
          ...(ctx.model !== undefined ? { model: ctx.model } : {}),
        });
      } catch (err) {
        if (isEvalHarnessV4AbortError(err)) {
          return { exitCode: 130, stdout: 'Eval run đã bị huỷ (AbortSignal). Không ghi lịch sử cho run dở dang.\n' };
        }
        throw err;
      }
      lines.unshift(`Chạy ${tasks.length} task, ${config.repeats} lần lặp/task (config "${config.name}").`);
      lines.push(formatEvalHarnessV4RunSummary(outcome.record));
      if (outcome.regressionReport) {
        lines.push(formatEvalHarnessV4RegressionText(outcome.regressionReport));
      } else {
        lines.push('Chưa có baseline để so hồi quy (run đầu tiên).');
      }
      if (outcome.dashboardPaths.length > 0) {
        lines.push(`Dashboard: ${outcome.dashboardPaths.join(', ')}`);
      }
      if (outcome.pruned > 0) {
        lines.push(`Đã prune ${outcome.pruned} run cũ khỏi lịch sử.`);
      }
      const text = `${lines.join('\n')}\n`;
      return asJsonResult({
        exitCode: outcome.exitCode,
        stdout: text,
        json: { record: outcome.record, regressionReport: outcome.regressionReport, dashboard: outcome.dashboard },
      });
    }
  }
}
