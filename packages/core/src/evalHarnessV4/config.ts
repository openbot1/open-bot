/**
 * Cấu hình Eval Harness v4 (v1.44, Đội T2).
 *
 * Định dạng file `eval.config.json` (đặt trong thư mục làm việc hoặc
 * trỏ bằng `--config` của CLI):
 *
 *   {
 *     "version": 4,
 *     "name": "nightly",
 *     "taskDirs": ["./eval-tasks"],
 *     "includeBuiltin": true,
 *     "includeBuiltinV4": true,
 *     "selection": { "tags": ["coding"], "excludeIds": ["fix-add"] },
 *     "repeats": 2,
 *     "taskTimeoutMs": null,
 *     "testTimeoutMs": 60000,
 *     "thresholds": { "maxRegressionDrop": 0.05, "minPassRate": 0.8 }
 *   }
 *
 * Mọi field đều có default hợp lý nên config tối thiểu chỉ cần
 * `{ "version": 4 }`. Parser KHÔNG throw khi config sai — trả về
 * issues để CLI in ra và exit 2, giống phong cách validate của
 * HarborTask (v1.11). Giá trị ngoài khoảng bị chặn (clamp) hoặc
 * báo lỗi tuỳ field: timeout/repeats ngoài khoảng = lỗi (user cần
 * sửa config), còn ngưỡng reward ngoài [0, 1] = lỗi.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { HARBOR_DEFAULT_TEST_TIMEOUT_MS } from '../eval/harborRunner';
import {
  HARBOR_MAX_TIMEOUT_MS,
  HARBOR_MIN_TIMEOUT_MS,
} from '../eval/harborTask';
import type {
  EvalHarnessV4Config,
  EvalHarnessV4Issue,
  EvalHarnessV4TaskSelection,
  EvalHarnessV4Thresholds,
  EvalHarnessV4ValidationResult,
} from './types';

/** Tên file config mặc định mà CLI tự tìm trong thư mục làm việc. */
export const EVAL_HARNESS_V4_CONFIG_FILE = 'eval.config.json' as const;

/** Số lần lặp tối đa cho phép (chống config nhầm 1000 lần lặp). */
export const EVAL_HARNESS_V4_MAX_REPEATS = 10 as const;
/** Số task tối đa trong một lần chạy (chống task set vô tình quá lớn). */
export const EVAL_HARNESS_V4_MAX_TASKS_PER_RUN = 500 as const;
/** Giới hạn lịch sử mặc định (run). */
export const EVAL_HARNESS_V4_DEFAULT_MAX_RUNS = 100 as const;
/** Giới hạn tuổi lịch sử mặc định (ngày). */
export const EVAL_HARNESS_V4_DEFAULT_MAX_AGE_DAYS = 90 as const;

/** Selection rỗng = chọn tất cả (không lọc gì). */
export function defaultEvalHarnessV4Selection(): EvalHarnessV4TaskSelection {
  return {
    includeIds: [],
    excludeIds: [],
    tags: [],
    kinds: [],
    includeGlobs: [],
    excludeGlobs: [],
  };
}

/** Ngưỡng mặc định (xem types.ts để biết ý nghĩa từng ngưỡng). */
export function defaultEvalHarnessV4Thresholds(): EvalHarnessV4Thresholds {
  return {
    minReward: 1,
    maxRegressionDrop: 0.05,
    minPassRate: 0.8,
    minMeanReward: 0.8,
    alwaysFailingRuns: 3,
  };
}

/** Config mặc định đầy đủ (dir lịch sử/output = '' nghĩa là dùng `<dataDir>/eval-harness-v4`). */
export function defaultEvalHarnessV4Config(): EvalHarnessV4Config {
  return {
    version: 4,
    name: 'default',
    taskDirs: [],
    includeBuiltin: true,
    includeBuiltinV4: true,
    selection: defaultEvalHarnessV4Selection(),
    repeats: 1,
    taskTimeoutMs: null,
    testTimeoutMs: HARBOR_DEFAULT_TEST_TIMEOUT_MS,
    profileId: '',
    model: null,
    sandbox: { mode: 'auto', keepWorkspace: false },
    thresholds: defaultEvalHarnessV4Thresholds(),
    history: { dir: '', maxRuns: EVAL_HARNESS_V4_DEFAULT_MAX_RUNS, maxAgeDays: EVAL_HARNESS_V4_DEFAULT_MAX_AGE_DAYS },
    output: { dir: '', formats: ['markdown', 'json'] },
    baselineRunId: '',
    failOnRegression: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((v) => typeof v !== 'string')) return null;
  return [...(value as string[])];
}

function pushIssue(issues: EvalHarnessV4Issue[], field: string, message: string): void {
  issues.push({ field, message });
}

function parseSelection(raw: unknown, issues: EvalHarnessV4Issue[]): EvalHarnessV4TaskSelection {
  const selection = defaultEvalHarnessV4Selection();
  if (raw === undefined) return selection;
  if (!isRecord(raw)) {
    pushIssue(issues, 'selection', 'selection phải là một object.');
    return selection;
  }
  const fields: Array<keyof EvalHarnessV4TaskSelection> = [
    'includeIds',
    'excludeIds',
    'tags',
    'kinds',
    'includeGlobs',
    'excludeGlobs',
  ];
  for (const field of fields) {
    const value = raw[field];
    if (value === undefined) continue;
    const parsed = asStringArray(value);
    if (parsed === null) {
      pushIssue(issues, `selection.${field}`, `selection.${field} phải là mảng chuỗi.`);
      continue;
    }
    selection[field] = parsed;
  }
  for (const kind of selection.kinds) {
    if (!['coding', 'research', 'writing', 'review', 'general'].includes(kind)) {
      pushIssue(issues, 'selection.kinds', `kind không hợp lệ: "${kind}" (coding, research, writing, review, general).`);
    }
  }
  return selection;
}

function parseThresholds(raw: unknown, issues: EvalHarnessV4Issue[]): EvalHarnessV4Thresholds {
  const thresholds = defaultEvalHarnessV4Thresholds();
  if (raw === undefined) return thresholds;
  if (!isRecord(raw)) {
    pushIssue(issues, 'thresholds', 'thresholds phải là một object.');
    return thresholds;
  }
  const ratioFields: Array<keyof EvalHarnessV4Thresholds> = [
    'minReward',
    'maxRegressionDrop',
    'minPassRate',
    'minMeanReward',
  ];
  for (const field of ratioFields) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      pushIssue(issues, `thresholds.${field}`, `thresholds.${field} phải là số trong [0, 1].`);
      continue;
    }
    thresholds[field] = value;
  }
  const alwaysFailing = raw['alwaysFailingRuns'];
  if (alwaysFailing !== undefined) {
    if (typeof alwaysFailing !== 'number' || !Number.isInteger(alwaysFailing) || alwaysFailing < 1) {
      pushIssue(issues, 'thresholds.alwaysFailingRuns', 'thresholds.alwaysFailingRuns phải là số nguyên >= 1.');
    } else {
      thresholds.alwaysFailingRuns = alwaysFailing;
    }
  }
  return thresholds;
}

/**
 * Parse config từ một object chưa biết kiểu (thường là JSON đã đọc).
 * Trả về config đã điền default + danh sách issue; config vẫn dùng
 * được khi chỉ có warning-level issue? Không — mọi issue ở đây đều
 * là lỗi (valid = false) vì config sai mà chạy ngầm sẽ cho kết quả
 * sai tập task. Caller quyết định: valid thì chạy, không thì dừng.
 */
export function parseEvalHarnessV4Config(raw: unknown): {
  config: EvalHarnessV4Config;
  validation: EvalHarnessV4ValidationResult;
} {
  const issues: EvalHarnessV4Issue[] = [];
  const config = defaultEvalHarnessV4Config();
  if (!isRecord(raw)) {
    return {
      config,
      validation: { valid: false, issues: [{ field: 'config', message: 'config phải là một object JSON.' }] },
    };
  }
  if (raw['version'] !== undefined && raw['version'] !== 4) {
    pushIssue(issues, 'version', `version phải là 4 (nhận được ${JSON.stringify(raw['version'])}).`);
  }
  if (raw['name'] !== undefined) {
    if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
      pushIssue(issues, 'name', 'name phải là chuỗi không rỗng.');
    } else {
      config.name = raw['name'].trim();
    }
  }
  if (raw['taskDirs'] !== undefined) {
    const parsed = asStringArray(raw['taskDirs']);
    if (parsed === null) pushIssue(issues, 'taskDirs', 'taskDirs phải là mảng chuỗi (đường dẫn thư mục).');
    else config.taskDirs = parsed;
  }
  if (raw['includeBuiltin'] !== undefined) {
    if (typeof raw['includeBuiltin'] !== 'boolean') pushIssue(issues, 'includeBuiltin', 'includeBuiltin phải là boolean.');
    else config.includeBuiltin = raw['includeBuiltin'];
  }
  if (raw['includeBuiltinV4'] !== undefined) {
    if (typeof raw['includeBuiltinV4'] !== 'boolean') pushIssue(issues, 'includeBuiltinV4', 'includeBuiltinV4 phải là boolean.');
    else config.includeBuiltinV4 = raw['includeBuiltinV4'];
  }
  config.selection = parseSelection(raw['selection'], issues);
  config.thresholds = parseThresholds(raw['thresholds'], issues);
  if (raw['repeats'] !== undefined) {
    const value = raw['repeats'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > EVAL_HARNESS_V4_MAX_REPEATS) {
      pushIssue(issues, 'repeats', `repeats phải là số nguyên trong [1, ${EVAL_HARNESS_V4_MAX_REPEATS}].`);
    } else {
      config.repeats = value;
    }
  }
  if (raw['taskTimeoutMs'] !== undefined && raw['taskTimeoutMs'] !== null) {
    const value = raw['taskTimeoutMs'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < HARBOR_MIN_TIMEOUT_MS || value > HARBOR_MAX_TIMEOUT_MS) {
      pushIssue(issues, 'taskTimeoutMs', `taskTimeoutMs phải là số nguyên trong [${HARBOR_MIN_TIMEOUT_MS}, ${HARBOR_MAX_TIMEOUT_MS}] hoặc null.`);
    } else {
      config.taskTimeoutMs = value;
    }
  }
  if (raw['testTimeoutMs'] !== undefined) {
    const value = raw['testTimeoutMs'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < HARBOR_MIN_TIMEOUT_MS || value > HARBOR_MAX_TIMEOUT_MS) {
      pushIssue(issues, 'testTimeoutMs', `testTimeoutMs phải là số nguyên trong [${HARBOR_MIN_TIMEOUT_MS}, ${HARBOR_MAX_TIMEOUT_MS}].`);
    } else {
      config.testTimeoutMs = value;
    }
  }
  if (raw['profileId'] !== undefined) {
    if (typeof raw['profileId'] !== 'string') pushIssue(issues, 'profileId', 'profileId phải là chuỗi.');
    else config.profileId = raw['profileId'];
  }
  if (raw['model'] !== undefined && raw['model'] !== null) {
    const model = raw['model'];
    if (!isRecord(model) || typeof model['provider'] !== 'string' || typeof model['model'] !== 'string') {
      pushIssue(issues, 'model', 'model phải là { provider: string, model: string } hoặc null.');
    } else {
      config.model = { provider: model['provider'] as string, model: model['model'] as string };
    }
  }
  if (raw['sandbox'] !== undefined) {
    const sandbox = raw['sandbox'];
    if (!isRecord(sandbox)) {
      pushIssue(issues, 'sandbox', 'sandbox phải là một object.');
    } else {
      if (sandbox['mode'] !== undefined) {
        if (sandbox['mode'] !== 'auto' && sandbox['mode'] !== 'bwrap' && sandbox['mode'] !== 'plain') {
          pushIssue(issues, 'sandbox.mode', 'sandbox.mode phải là "auto", "bwrap" hoặc "plain".');
        } else {
          config.sandbox.mode = sandbox['mode'];
        }
      }
      if (sandbox['keepWorkspace'] !== undefined) {
        if (typeof sandbox['keepWorkspace'] !== 'boolean') pushIssue(issues, 'sandbox.keepWorkspace', 'sandbox.keepWorkspace phải là boolean.');
        else config.sandbox.keepWorkspace = sandbox['keepWorkspace'];
      }
    }
  }
  if (raw['history'] !== undefined) {
    const history = raw['history'];
    if (!isRecord(history)) {
      pushIssue(issues, 'history', 'history phải là một object.');
    } else {
      if (history['dir'] !== undefined) {
        if (typeof history['dir'] !== 'string') pushIssue(issues, 'history.dir', 'history.dir phải là chuỗi.');
        else config.history.dir = history['dir'];
      }
      if (history['maxRuns'] !== undefined) {
        const value = history['maxRuns'];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) pushIssue(issues, 'history.maxRuns', 'history.maxRuns phải là số nguyên >= 0.');
        else config.history.maxRuns = value;
      }
      if (history['maxAgeDays'] !== undefined) {
        const value = history['maxAgeDays'];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) pushIssue(issues, 'history.maxAgeDays', 'history.maxAgeDays phải là số nguyên >= 0.');
        else config.history.maxAgeDays = value;
      }
    }
  }
  if (raw['output'] !== undefined) {
    const output = raw['output'];
    if (!isRecord(output)) {
      pushIssue(issues, 'output', 'output phải là một object.');
    } else {
      if (output['dir'] !== undefined) {
        if (typeof output['dir'] !== 'string') pushIssue(issues, 'output.dir', 'output.dir phải là chuỗi.');
        else config.output.dir = output['dir'];
      }
      if (output['formats'] !== undefined) {
        const formats = output['formats'];
        if (!Array.isArray(formats) || formats.some((f) => f !== 'markdown' && f !== 'html' && f !== 'json')) {
          pushIssue(issues, 'output.formats', 'output.formats chỉ chứa "markdown", "html", "json".');
        } else {
          config.output.formats = [...new Set(formats as Array<'markdown' | 'html' | 'json'>)];
        }
      }
    }
  }
  if (raw['baselineRunId'] !== undefined) {
    if (typeof raw['baselineRunId'] !== 'string') pushIssue(issues, 'baselineRunId', 'baselineRunId phải là chuỗi.');
    else config.baselineRunId = raw['baselineRunId'];
  }
  if (raw['failOnRegression'] !== undefined) {
    if (typeof raw['failOnRegression'] !== 'boolean') pushIssue(issues, 'failOnRegression', 'failOnRegression phải là boolean.');
    else config.failOnRegression = raw['failOnRegression'];
  }
  return { config, validation: { valid: issues.length === 0, issues } };
}

/** Đọc + parse file config (throw khi file không đọc được / JSON lỗi). */
export function loadEvalHarnessV4ConfigFile(filePath: string): {
  config: EvalHarnessV4Config;
  validation: EvalHarnessV4ValidationResult;
} {
  let rawText: string;
  try {
    rawText = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Không đọc được config "${filePath}": ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (err) {
    throw new Error(`Không đọc được config "${filePath}": JSON lỗi — ${(err as Error).message}`);
  }
  return parseEvalHarnessV4Config(raw);
}

/** Tìm file config mặc định: `--config` > `./eval.config.json` > không có. */
export function findEvalHarnessV4ConfigFile(explicitPath: string | undefined, cwd: string): string | null {
  if (explicitPath !== undefined && explicitPath !== '') {
    return path.isAbsolute(explicitPath) ? explicitPath : path.join(cwd, explicitPath);
  }
  const candidate = path.join(cwd, EVAL_HARNESS_V4_CONFIG_FILE);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Ghi đè CLI lên config đã load (chỉ các field CLI cho phép). */
export interface EvalHarnessV4CliOverrides {
  repeats?: number;
  taskTimeoutMs?: number;
  testTimeoutMs?: number;
  profileId?: string;
  includeIds?: string[];
  excludeIds?: string[];
  tags?: string[];
  kinds?: string[];
  baselineRunId?: string;
  failOnRegression?: boolean;
  name?: string;
}

/**
 * Áp override của CLI lên config. Override sai (vd repeats = 0)
 * trả về issue thay vì lặng lẽ bỏ qua — CLI in issue và dừng.
 */
export function applyEvalHarnessV4CliOverrides(
  config: EvalHarnessV4Config,
  overrides: EvalHarnessV4CliOverrides,
): { config: EvalHarnessV4Config; issues: EvalHarnessV4Issue[] } {
  const issues: EvalHarnessV4Issue[] = [];
  const next: EvalHarnessV4Config = {
    ...config,
    selection: { ...config.selection },
    thresholds: { ...config.thresholds },
    sandbox: { ...config.sandbox },
    history: { ...config.history },
    output: { ...config.output, formats: [...config.output.formats] },
  };
  if (overrides.repeats !== undefined) {
    if (!Number.isInteger(overrides.repeats) || overrides.repeats < 1 || overrides.repeats > EVAL_HARNESS_V4_MAX_REPEATS) {
      pushIssue(issues, 'repeats', `repeats phải là số nguyên trong [1, ${EVAL_HARNESS_V4_MAX_REPEATS}].`);
    } else {
      next.repeats = overrides.repeats;
    }
  }
  if (overrides.taskTimeoutMs !== undefined) {
    if (!Number.isInteger(overrides.taskTimeoutMs) || overrides.taskTimeoutMs < HARBOR_MIN_TIMEOUT_MS || overrides.taskTimeoutMs > HARBOR_MAX_TIMEOUT_MS) {
      pushIssue(issues, 'taskTimeoutMs', `taskTimeoutMs phải là số nguyên trong [${HARBOR_MIN_TIMEOUT_MS}, ${HARBOR_MAX_TIMEOUT_MS}].`);
    } else {
      next.taskTimeoutMs = overrides.taskTimeoutMs;
    }
  }
  if (overrides.testTimeoutMs !== undefined) {
    if (!Number.isInteger(overrides.testTimeoutMs) || overrides.testTimeoutMs < HARBOR_MIN_TIMEOUT_MS || overrides.testTimeoutMs > HARBOR_MAX_TIMEOUT_MS) {
      pushIssue(issues, 'testTimeoutMs', `testTimeoutMs phải là số nguyên trong [${HARBOR_MIN_TIMEOUT_MS}, ${HARBOR_MAX_TIMEOUT_MS}].`);
    } else {
      next.testTimeoutMs = overrides.testTimeoutMs;
    }
  }
  if (overrides.profileId !== undefined) next.profileId = overrides.profileId;
  if (overrides.includeIds !== undefined) next.selection.includeIds = [...overrides.includeIds];
  if (overrides.excludeIds !== undefined) next.selection.excludeIds = [...overrides.excludeIds];
  if (overrides.tags !== undefined) next.selection.tags = [...overrides.tags];
  if (overrides.kinds !== undefined) {
    const bad = overrides.kinds.filter((k) => !['coding', 'research', 'writing', 'review', 'general'].includes(k));
    if (bad.length > 0) pushIssue(issues, 'selection.kinds', `kind không hợp lệ: ${bad.join(', ')}.`);
    else next.selection.kinds = [...overrides.kinds];
  }
  if (overrides.baselineRunId !== undefined) next.baselineRunId = overrides.baselineRunId;
  if (overrides.failOnRegression !== undefined) next.failOnRegression = overrides.failOnRegression;
  if (overrides.name !== undefined && overrides.name.trim() !== '') next.name = overrides.name.trim();
  return { config: next, issues };
}

/** Serialize config ra JSON đẹp (để `eval v4 config --init` ghi file mẫu). */
export function serializeEvalHarnessV4Config(config: EvalHarnessV4Config): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Config mẫu (điền sẵn taskDirs + selection ví dụ) để user copy sửa. */
export function sampleEvalHarnessV4Config(): EvalHarnessV4Config {
  const config = defaultEvalHarnessV4Config();
  config.name = 'nightly';
  config.taskDirs = ['./eval-tasks'];
  config.repeats = 2;
  config.selection.tags = [];
  return config;
}

/**
 * JSON Schema cho `eval.config.json` (để editor validate + gợi ý
 * khi user sửa config tay). Schema mô tả đúng những gì
 * `parseEvalHarnessV4Config` chấp nhận (kèm default từng field);
 * field lạ ngoài schema vẫn được parser bỏ qua (không lỗi).
 */
export function evalHarnessV4ConfigJsonSchema(): Record<string, unknown> {
  const stringArray = { type: 'array', items: { type: 'string' } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://open-bot.local/schemas/eval-harness-v4-config.json',
    title: 'Eval Harness v4 config',
    description: 'Cấu hình Eval Harness v4 (eval.config.json) — xem packages/core/src/evalHarnessV4/config.ts.',
    type: 'object',
    required: ['version'],
    additionalProperties: true,
    properties: {
      version: { type: 'integer', const: 4, description: 'Phiên bản format config (luôn 4).' },
      name: { type: 'string', default: 'default', description: 'Tên gợi nhớ của bộ config (vd nightly, smoke).' },
      taskDirs: { ...stringArray, default: [], description: 'Thư mục chứa task Harbor trên đĩa (mỗi thư mục con = 1 task).' },
      includeBuiltin: { type: 'boolean', default: true, description: 'Nạp task mẫu v1.11 (hello-file, sum-csv, fix-add, markdown-table).' },
      includeBuiltinV4: { type: 'boolean', default: true, description: 'Nạp task mẫu V4 (json-transform, sort-lines, fix-import, readme-headings, word-count, log-grep, config-fix).' },
      selection: {
        type: 'object',
        description: 'Bộ lọc chọn tập task (áp theo thứ tự: includeIds → includeGlobs → tags → kinds → excludeIds → excludeGlobs).',
        properties: {
          includeIds: { ...stringArray, description: 'Chỉ chạy các id này (rỗng = không lọc).' },
          excludeIds: { ...stringArray, description: 'Bỏ các id này.' },
          tags: { ...stringArray, description: 'Chỉ chạy task có ÍT NHẤT một tag này.' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['coding', 'research', 'writing', 'review', 'general'] },
            description: 'Chỉ chạy task thuộc các kind này.',
          },
          includeGlobs: { ...stringArray, description: 'Glob khớp id (vd fix-*).' },
          excludeGlobs: { ...stringArray, description: 'Glob loại trừ khớp id.' },
        },
      },
      repeats: { type: 'integer', minimum: 1, maximum: EVAL_HARNESS_V4_MAX_REPEATS, default: 1, description: 'Số lần lặp mỗi task (>1 để đo flake).' },
      taskTimeoutMs: {
        type: ['integer', 'null'],
        minimum: HARBOR_MIN_TIMEOUT_MS,
        maximum: HARBOR_MAX_TIMEOUT_MS,
        default: null,
        description: 'Timeout toàn task, ms — ghi đè task.meta.timeoutMs (null = dùng timeout của task).',
      },
      testTimeoutMs: { type: 'integer', minimum: HARBOR_MIN_TIMEOUT_MS, maximum: HARBOR_MAX_TIMEOUT_MS, default: 60_000, description: 'Timeout chạy tests/test.sh, ms.' },
      profileId: { type: 'string', default: '', description: 'Profile agent mặc định (rỗng = không ép profile).' },
      model: {
        type: ['object', 'null'],
        default: null,
        description: 'Model mặc định { provider, model } (null = không ép model).',
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['provider', 'model'],
      },
      sandbox: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'bwrap', 'plain'], default: 'auto', description: 'Chế độ sandbox cho mỗi task.' },
          keepWorkspace: { type: 'boolean', default: false, description: 'Giữ lại workspace box sau khi chạy (để debug).' },
        },
      },
      thresholds: {
        type: 'object',
        description: 'Ngưỡng hồi quy + gate.',
        properties: {
          minReward: { type: 'number', minimum: 0, maximum: 1, default: 1, description: 'Reward tối thiểu để task coi là pass.' },
          maxRegressionDrop: { type: 'number', minimum: 0, maximum: 1, default: 0.05, description: 'Mức sụt reward tối đa cho phép so với baseline.' },
          minPassRate: { type: 'number', minimum: 0, maximum: 1, default: 0.8, description: 'Pass rate tối thiểu của cả suite.' },
          minMeanReward: { type: 'number', minimum: 0, maximum: 1, default: 0.8, description: 'Reward trung bình tối thiểu của cả suite.' },
          alwaysFailingRuns: { type: 'integer', minimum: 1, default: 3, description: 'Số lần fail liên tiếp để coi là always-failing.' },
        },
      },
      history: {
        type: 'object',
        properties: {
          dir: { type: 'string', default: '', description: 'Thư mục lưu lịch sử (rỗng = <dataDir>/eval-harness-v4).' },
          maxRuns: { type: 'integer', minimum: 0, default: 100, description: 'Giữ tối đa bao nhiêu run (0 = không giới hạn).' },
          maxAgeDays: { type: 'integer', minimum: 0, default: 90, description: 'Xoá run cũ hơn bao nhiêu ngày (0 = không xoá theo tuổi).' },
        },
      },
      output: {
        type: 'object',
        properties: {
          dir: { type: 'string', default: '', description: 'Thư mục ghi dashboard (rỗng = <historyDir>/dashboards).' },
          formats: {
            type: 'array',
            items: { type: 'string', enum: ['markdown', 'html', 'json'] },
            default: ['markdown', 'json'],
            description: 'Định dạng dashboard muốn render.',
          },
        },
      },
      baselineRunId: { type: 'string', default: '', description: 'Run id đã pin làm baseline (rỗng = so với lần chạy trước đó).' },
      failOnRegression: { type: 'boolean', default: true, description: 'Chặn (exit != 0) khi gate = block.' },
    },
  };
}
