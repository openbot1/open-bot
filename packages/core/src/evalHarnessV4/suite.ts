/**
 * Named eval suites của Eval Harness v4 (v1.44, Đội T2).
 *
 * Một "suite" đặt tên là một preset config: chọn tập task +
 * số lần lặp + ngưỡng, để user chạy một lệnh ngắn thay vì nhớ
 * cả bộ cờ:
 *
 *   - `smoke`   — kiểm tra nhanh (4 task nhẹ, 1 lần lặp): dùng
 *     trước khi commit hoặc sau khi sửa runner.
 *   - `nightly` — toàn bộ task builtin (10 task), 2 lần lặp để
 *     đo flake: dùng cho chạy đêm / CI đêm.
 *   - `full`    — toàn bộ task builtin + task trên đĩa (nếu có),
 *     3 lần lặp: dùng cho release / báo cáo đầy đủ.
 *   - `coding`  — chỉ task coding: dùng khi chỉ sửa code agent.
 *
 * Suite chỉ là preset override lên config hiện tại (file config
 * hoặc default): CLI `--suite <id>` áp preset TRƯỚC rồi mới áp
 * các cờ CLI khác (cờ CLI thắng preset). Preset không đổi
 * taskDirs, profile, model hay baseline — những thứ đó vẫn lấy
 * từ config/cờ.
 */

import type { EvalHarnessV4Config } from './types';

/** Một preset suite: id + mô tả + override lên config. */
export interface EvalHarnessV4SuitePreset {
  id: string;
  name: string;
  description: string;
  /** Override áp lên config (merge nông — selection merge theo field). */
  overrides: {
    includeBuiltin?: boolean;
    includeBuiltinV4?: boolean;
    selection?: Partial<EvalHarnessV4Config['selection']>;
    repeats?: number;
    testTimeoutMs?: number;
    thresholds?: Partial<EvalHarnessV4Config['thresholds']>;
    failOnRegression?: boolean;
  };
}

/** Toàn bộ suite preset (ổn định — CLI/test dựa vào id). */
export const EVAL_HARNESS_V4_SUITES: readonly EvalHarnessV4SuitePreset[] = [
  {
    id: 'smoke',
    name: 'Smoke',
    description: 'Kiểm tra nhanh: 4 task nhẹ (hello-file, sum-csv, fix-import, sort-lines), 1 lần lặp.',
    overrides: {
      selection: { includeIds: ['hello-file', 'sum-csv', 'fix-import', 'sort-lines'] },
      repeats: 1,
    },
  },
  {
    id: 'nightly',
    name: 'Nightly',
    description: 'Toàn bộ task builtin (v1.11 + V4), 2 lần lặp để đo flake.',
    overrides: {
      repeats: 2,
    },
  },
  {
    id: 'full',
    name: 'Full',
    description: 'Toàn bộ task builtin, 3 lần lặp, ngưỡng chặt (min pass rate 0.9).',
    overrides: {
      repeats: 3,
      thresholds: { minPassRate: 0.9, minMeanReward: 0.9 },
    },
  },
  {
    id: 'coding',
    name: 'Coding',
    description: 'Chỉ task coding (sum-csv, fix-add, json-transform, fix-import).',
    overrides: {
      selection: { kinds: ['coding'] },
      repeats: 1,
    },
  },
];

/** Lấy preset theo id (undefined khi không có). */
export function getEvalHarnessV4Suite(id: string): EvalHarnessV4SuitePreset | undefined {
  return EVAL_HARNESS_V4_SUITES.find((s) => s.id === id);
}

/** Liệt kê id của mọi suite preset (để CLI in help). */
export function listEvalHarnessV4SuiteIds(): string[] {
  return EVAL_HARNESS_V4_SUITES.map((s) => s.id);
}

/**
 * Áp preset suite lên config (trả về config mới, không mutate
 * config gốc). Selection merge theo field (chỉ field preset đặt
 * mới bị ghi đè); thresholds cũng vậy.
 */
export function applyEvalHarnessV4Suite(
  config: EvalHarnessV4Config,
  suiteId: string,
): { config: EvalHarnessV4Config; suite: EvalHarnessV4SuitePreset | null } {
  const suite = getEvalHarnessV4Suite(suiteId);
  if (!suite) return { config, suite: null };
  const next: EvalHarnessV4Config = {
    ...config,
    selection: { ...config.selection },
    thresholds: { ...config.thresholds },
    sandbox: { ...config.sandbox },
    history: { ...config.history },
    output: { ...config.output, formats: [...config.output.formats] },
    name: config.name === 'default' ? suite.id : config.name,
  };
  const overrides = suite.overrides;
  if (overrides.includeBuiltin !== undefined) next.includeBuiltin = overrides.includeBuiltin;
  if (overrides.includeBuiltinV4 !== undefined) next.includeBuiltinV4 = overrides.includeBuiltinV4;
  if (overrides.selection) next.selection = { ...next.selection, ...overrides.selection };
  if (overrides.repeats !== undefined) next.repeats = overrides.repeats;
  if (overrides.testTimeoutMs !== undefined) next.testTimeoutMs = overrides.testTimeoutMs;
  if (overrides.thresholds) next.thresholds = { ...next.thresholds, ...overrides.thresholds };
  if (overrides.failOnRegression !== undefined) next.failOnRegression = overrides.failOnRegression;
  return { config: next, suite };
}

/** Mô tả ngắn các suite (để CLI in khi user gõ sai --suite). */
export function formatEvalHarnessV4Suites(): string {
  return EVAL_HARNESS_V4_SUITES.map((s) => `  ${s.id} — ${s.description}`).join('\n');
}
