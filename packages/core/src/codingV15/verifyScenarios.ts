/**
 * Coding agent v15 — verify scenarios vượt happy path.
 *
 * Một agent chỉ pass happy path thì chưa đáng tin: ngoài đời thật
 * tool lỗi, model trả JSON vỡ, file bị sửa đồng thời, test fail
 * giữa chừng, response rỗng, quyền bị từ chối, diff quá lớn...
 * v15 định nghĩa bộ scenario kiểm chứng, mỗi scenario có kỳ vọng
 * rõ ràng (agent PHẢI làm gì), runner chạy từng scenario với kết
 * quả mô phỏng do host/script tiêm vào và báo cáo pass/fail từng
 * scenario kèm từng check nhỏ bên trong.
 *
 * Runner KHÔNG gọi model thật, KHÔNG chạy tool thật: `stepFn` của
 * mỗi scenario trả về `V15VerifyStepOutcome` mô phỏng (tool error,
 * timeout, malformed...) và runner đối chiếu hành vi kỳ vọng:
 * agent có dừng đúng cách không, có báo lỗi rõ ràng không, có thử
 * lại đúng giới hạn không, có làm hỏng file không.
 *
 * Kỳ vọng theo kind (đọc trong `V15_VERIFY_EXPECTATIONS`):
 * - tool_error: agent báo lỗi + dừng hoặc thử lại tối đa 2 lần rồi dừng, không ghi file nửa vời.
 * - timeout: step quá timeoutMs thì agent coi là timeout, không chờ mãi, báo timeout.
 * - malformed_output: output sai định dạng thì agent báo parse error, không dùng dữ liệu vỡ.
 * - file_conflict: hai edit cùng file nội dung khác nhau thì agent phát hiện xung đột, không ghi đè mù.
 * - mid_run_test_failure: test fail giữa chừng thì agent dừng, báo test nào fail, không tuyên bố done.
 * - empty_response: response rỗng thì agent không coi là done, hỏi lại hoặc dừng có báo cáo.
 * - permission_denied: bị từ chối quyền thì agent dừng ngay, không thử lại vô hạn.
 * - large_diff: diff vượt ngưỡng thì agent cảnh báo + xin xác nhận, không apply mù.
 * - happy_path: baseline — mọi step ok thì agent done và ghi file.
 */

import { CodingV15Error } from './types';
import type {
  V15VerifyCheck,
  V15VerifyReport,
  V15VerifyScenario,
  V15VerifyScenarioKind,
  V15VerifyScenarioResult,
  V15VerifyStepOutcome,
} from './types';
import { V15_VERIFY_SCENARIO_KINDS } from './types';

/** Số lần thử lại tối đa mà scenario tool_error chấp nhận. */
export const V15_VERIFY_MAX_RETRIES = 2;

/** Ngưỡng diff lớn (ký tự) cho scenario large_diff. */
export const V15_VERIFY_LARGE_DIFF_CHARS = 20_000;

/** Timeout mặc định của scenario (ms). */
export const V15_VERIFY_DEFAULT_TIMEOUT_MS = 30_000;

/** Kỳ vọng rõ ràng cho từng kind (dùng làm `expectation` của scenario built-in). */
export const V15_VERIFY_EXPECTATIONS: Record<V15VerifyScenarioKind, string> = {
  happy_path:
    'All steps succeed: agent marks done, writes the intended files, reports no errors.',
  tool_error:
    'When a tool errors, the agent reports the error clearly, retries at most 2 times, then stops without writing a half-finished file.',
  timeout:
    'When a step exceeds its timeout, the agent treats it as a timeout, stops waiting, and reports the timeout instead of hanging.',
  malformed_output:
    'When a tool returns malformed output, the agent reports a parse error and does not use the broken data.',
  file_conflict:
    'When two edits target the same file with different content, the agent detects the conflict and does not blindly overwrite.',
  mid_run_test_failure:
    'When tests fail mid-run, the agent stops, reports which tests failed, and does not claim done.',
  empty_response:
    'When the model returns an empty response, the agent does not treat it as done; it asks again or stops with a report.',
  permission_denied:
    'When a tool call is denied (permission), the agent stops immediately and does not retry in a loop.',
  large_diff:
    'When a diff exceeds 20000 chars, the agent warns and asks for confirmation instead of applying it blindly.',
};

/** Mô tả ngắn cho từng kind. */
export const V15_VERIFY_DESCRIPTIONS: Record<V15VerifyScenarioKind, string> = {
  happy_path: 'Baseline: every step succeeds and the agent finishes cleanly.',
  tool_error: 'A tool call fails with an error mid-run.',
  timeout: 'A step takes longer than the scenario timeout.',
  malformed_output: 'A tool returns output that is not valid JSON / not the expected shape.',
  file_conflict: 'Two edits target the same file with different content.',
  mid_run_test_failure: 'Tests fail halfway through the run.',
  empty_response: 'The model returns an empty response with no tool calls.',
  permission_denied: 'A tool call is refused for permission reasons.',
  large_diff: 'A proposed edit produces a very large diff.',
};

/** Tên hiển thị cho từng kind. */
export const V15_VERIFY_NAMES: Record<V15VerifyScenarioKind, string> = {
  happy_path: 'Happy path',
  tool_error: 'Tool error',
  timeout: 'Step timeout',
  malformed_output: 'Malformed output',
  file_conflict: 'File conflict',
  mid_run_test_failure: 'Mid-run test failure',
  empty_response: 'Empty response',
  permission_denied: 'Permission denied',
  large_diff: 'Large diff',
};

/** Tạo một scenario built-in từ kind. */
export function v15BuiltinScenario(kind: V15VerifyScenarioKind, timeoutMs: number = V15_VERIFY_DEFAULT_TIMEOUT_MS): V15VerifyScenario {
  return {
    id: `v15-${kind.replace(/_/g, '-')}`,
    kind,
    name: V15_VERIFY_NAMES[kind],
    description: V15_VERIFY_DESCRIPTIONS[kind],
    expectation: V15_VERIFY_EXPECTATIONS[kind],
    timeoutMs,
    builtin: true,
  };
}

/** Toàn bộ 9 scenario built-in (thứ tự: happy path trước, rồi các lỗi). */
export function v15BuiltinScenarios(timeoutMs: number = V15_VERIFY_DEFAULT_TIMEOUT_MS): V15VerifyScenario[] {
  const order: V15VerifyScenarioKind[] = [
    'happy_path',
    'tool_error',
    'timeout',
    'malformed_output',
    'file_conflict',
    'mid_run_test_failure',
    'empty_response',
    'permission_denied',
    'large_diff',
  ];
  return order.map((kind) => v15BuiltinScenario(kind, timeoutMs));
}

/** Tìm scenario theo id trong catalog (throw khi không có). */
export function v15FindScenario(scenarios: readonly V15VerifyScenario[], id: string): V15VerifyScenario {
  const found = scenarios.find((s) => s.id === id);
  if (!found) throw new CodingV15Error('verify-scenario-not-found', `Không tìm thấy verify scenario "${id}".`);
  return found;
}

/** Validate một scenario custom trước khi chạy. */
export function v15ValidateScenario(scenario: V15VerifyScenario): void {
  if (!scenario || typeof scenario !== 'object') {
    throw new CodingV15Error('verify-invalid', 'Verify scenario phải là object.');
  }
  if (typeof scenario.id !== 'string' || scenario.id.trim().length === 0) {
    throw new CodingV15Error('verify-invalid', 'Verify scenario cần id không rỗng.');
  }
  if (typeof scenario.name !== 'string' || scenario.name.trim().length === 0) {
    throw new CodingV15Error('verify-invalid', 'Verify scenario cần name không rỗng.');
  }
  if (typeof scenario.expectation !== 'string' || scenario.expectation.trim().length === 0) {
    throw new CodingV15Error('verify-invalid', 'Verify scenario cần expectation không rỗng (kỳ vọng rõ ràng).');
  }
  if (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs <= 0) {
    throw new CodingV15Error('verify-invalid', 'Verify scenario timeoutMs phải là số nguyên > 0.');
  }
}

/* ================================================================== */
/* Checkers — đối chiếu outcome mô phỏng với kỳ vọng từng kind        */
/* ================================================================== */

function check(name: string, passed: boolean, detail: string): V15VerifyCheck {
  return { name, passed, detail };
}

/**
 * Kiểm tra outcome của MỘT step mô phỏng theo kind của scenario.
 * Trả về danh sách check (pass/fail từng cái) — runner cộng dồn.
 */
export function v15CheckStepOutcome(
  kind: V15VerifyScenarioKind,
  outcome: V15VerifyStepOutcome,
  scenario: V15VerifyScenario,
): V15VerifyCheck[] {
  const checks: V15VerifyCheck[] = [];
  const retries = outcome.agentRetries ?? 0;
  switch (kind) {
    case 'happy_path': {
      checks.push(check('step-ok', outcome.status === 'ok', outcome.status === 'ok' ? 'Step succeeded.' : `Expected ok, got ${outcome.status}.`));
      checks.push(check('agent-done', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent finished.' : 'Agent did not finish on happy path.'));
      checks.push(check('no-error-reported', outcome.agentReportedError !== true, 'No error reported on happy path.'));
      break;
    }
    case 'tool_error': {
      checks.push(check('error-detected', outcome.status === 'error', outcome.status === 'error' ? `Tool error seen: ${outcome.error ?? outcome.tool ?? 'unknown'}.` : `Expected tool error, got ${outcome.status}.`));
      checks.push(check('error-reported', outcome.agentReportedError === true, outcome.agentReportedError === true ? 'Agent reported the error clearly.' : 'Agent did not report the error.'));
      checks.push(check('retries-bounded', retries <= V15_VERIFY_MAX_RETRIES, retries <= V15_VERIFY_MAX_RETRIES ? `Retries ${retries} within limit ${V15_VERIFY_MAX_RETRIES}.` : `Agent retried ${retries} times — over the limit ${V15_VERIFY_MAX_RETRIES}.`));
      checks.push(check('stopped-after-error', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent stopped after the error.' : 'Agent kept going after a tool error.'));
      break;
    }
    case 'timeout': {
      const duration = outcome.durationMs ?? 0;
      checks.push(check('timeout-detected', duration > scenario.timeoutMs || outcome.status === 'timeout', duration > scenario.timeoutMs || outcome.status === 'timeout' ? `Step took ${duration}ms > timeout ${scenario.timeoutMs}ms.` : `Step took ${duration}ms — no timeout detected.`));
      checks.push(check('reported-timeout', outcome.agentReportedError === true, outcome.agentReportedError === true ? 'Agent reported the timeout.' : 'Agent did not report the timeout.'));
      checks.push(check('did-not-hang', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent stopped instead of hanging.' : 'Agent kept waiting after timeout.'));
      break;
    }
    case 'malformed_output': {
      checks.push(check('malformed-detected', outcome.status === 'malformed', outcome.status === 'malformed' ? 'Malformed output detected.' : `Expected malformed output, got ${outcome.status}.`));
      checks.push(check('parse-error-reported', outcome.agentReportedError === true, outcome.agentReportedError === true ? 'Agent reported a parse error.' : 'Agent did not report a parse error.'));
      checks.push(check('broken-data-unused', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent stopped instead of using broken data.' : 'Agent continued with broken data.'));
      if (outcome.output !== undefined) {
        let parses = true;
        try {
          JSON.parse(outcome.output);
        } catch {
          parses = false;
        }
        checks.push(check('output-indeed-malformed', !parses, parses ? 'Output actually parses as JSON — not a malformed case.' : 'Output does not parse as JSON (genuinely malformed).'));
      }
      break;
    }
    case 'file_conflict': {
      checks.push(check('conflict-detected', outcome.status === 'conflict', outcome.status === 'conflict' ? `Conflict on ${outcome.filePath ?? 'file'}.` : `Expected a file conflict, got ${outcome.status}.`));
      checks.push(check('no-blind-overwrite', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent stopped instead of overwriting blindly.' : 'Agent overwrote without resolving the conflict.'));
      checks.push(check('conflict-reported', outcome.agentReportedError === true, outcome.agentReportedError === true ? 'Agent reported the conflict.' : 'Agent did not report the conflict.'));
      break;
    }
    case 'mid_run_test_failure': {
      checks.push(check('test-failure-seen', outcome.testsPassed === false, outcome.testsPassed === false ? 'Tests failed mid-run.' : 'Tests did not fail — not a mid-run failure case.'));
      checks.push(check('stopped-on-failure', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent stopped when tests failed.' : 'Agent kept going after tests failed.'));
      checks.push(check('failure-reported', outcome.agentReportedError === true, outcome.agentReportedError === true ? 'Agent reported which tests failed.' : 'Agent did not report the failing tests.'));
      break;
    }
    case 'empty_response': {
      const empty = (outcome.output ?? '').trim().length === 0 && outcome.status === 'ok';
      checks.push(check('empty-detected', empty || outcome.status === 'ok', empty ? 'Empty response detected.' : 'Response was not empty.'));
      checks.push(check('not-treated-as-done', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent did not treat empty response as done.' : 'Agent treated an empty response as done.'));
      checks.push(check('reported-or-retried', outcome.agentReportedError === true || retries >= 1, outcome.agentReportedError === true || retries >= 1 ? 'Agent reported or asked again.' : 'Agent silently accepted the empty response.'));
      break;
    }
    case 'permission_denied': {
      checks.push(check('denied-detected', outcome.status === 'denied', outcome.status === 'denied' ? `Permission denied on ${outcome.tool ?? 'tool'}.` : `Expected denied, got ${outcome.status}.`));
      checks.push(check('stopped-immediately', outcome.agentStopped === true, outcome.agentStopped === true ? 'Agent stopped immediately.' : 'Agent kept going after denial.'));
      checks.push(check('no-retry-loop', retries === 0, retries === 0 ? 'No retry after denial.' : `Agent retried ${retries} times after denial — must stop immediately.`));
      break;
    }
    case 'large_diff': {
      const diffChars = outcome.diffChars ?? 0;
      checks.push(check('large-diff-detected', diffChars > V15_VERIFY_LARGE_DIFF_CHARS, diffChars > V15_VERIFY_LARGE_DIFF_CHARS ? `Diff ${diffChars} chars > ${V15_VERIFY_LARGE_DIFF_CHARS}.` : `Diff ${diffChars} chars — not large.`));
      checks.push(check('warned-before-apply', outcome.agentReportedError === true || outcome.agentStopped === true, outcome.agentReportedError === true || outcome.agentStopped === true ? 'Agent warned / asked before applying.' : 'Agent applied a large diff without warning.'));
      break;
    }
    default: {
      checks.push(check('unknown-kind', false, `Unknown scenario kind: ${String(kind)}.`));
      break;
    }
  }
  return checks;
}

/* ================================================================== */
/* Runner                                                              */
/* ================================================================== */

/** Hàm mô phỏng một scenario: trả outcome của agent trong tình huống đó. */
export type V15VerifyStepFn = (
  scenario: V15VerifyScenario,
) => V15VerifyStepOutcome | Promise<V15VerifyStepOutcome>;

export interface V15VerifyRunOptions {
  runId: string;
  profileId?: string;
  scenarios?: V15VerifyScenario[];
  /** true = dừng ở scenario fail đầu tiên (mặc định false: chạy hết để báo cáo đủ). */
  failFast?: boolean;
  now?: () => string;
}

/** Chạy một scenario với stepFn mô phỏng, trả kết quả pass/fail + checks. */
export async function v15RunScenario(
  scenario: V15VerifyScenario,
  stepFn: V15VerifyStepFn,
): Promise<V15VerifyScenarioResult> {
  v15ValidateScenario(scenario);
  if (typeof stepFn !== 'function') {
    throw new CodingV15Error('verify-runner-invalid', 'Verify runner cần stepFn là function.');
  }
  const started = Date.now();
  const outcome = await stepFn(scenario);
  const durationMs = Date.now() - started;
  const checks = v15CheckStepOutcome(scenario.kind, outcome, scenario);
  const passed = checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);
  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    name: scenario.name,
    passed,
    expectation: scenario.expectation,
    actual:
      passed
        ? `All ${checks.length} checks passed (${scenario.kind}).`
        : `Failed checks: ${failedChecks.map((c) => `${c.name} — ${c.detail}`).join('; ')}`,
    checks,
    durationMs,
  };
}

/** Chạy toàn bộ bộ scenario, trả báo cáo pass/fail từng scenario. */
export async function v15RunVerifyScenarios(
  stepFn: V15VerifyStepFn,
  options: V15VerifyRunOptions,
): Promise<V15VerifyReport> {
  if (typeof stepFn !== 'function') {
    throw new CodingV15Error('verify-runner-invalid', 'Verify runner cần stepFn là function.');
  }
  if (!options || typeof options.runId !== 'string' || options.runId.trim().length === 0) {
    throw new CodingV15Error('verify-invalid', 'Verify run cần runId không rỗng.');
  }
  const scenarios = options.scenarios ?? v15BuiltinScenarios();
  if (scenarios.length === 0) {
    throw new CodingV15Error('verify-invalid', 'Verify run cần ít nhất một scenario.');
  }
  const started = Date.now();
  const results: V15VerifyScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await v15RunScenario(scenario, stepFn);
    results.push(result);
    if (!result.passed && options.failFast) break;
  }
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  return {
    runId: options.runId,
    profileId: options.profileId ?? '',
    total: results.length,
    passed,
    failed,
    results,
    durationMs: Date.now() - started,
    summary: `Verify ${options.runId}: ${passed}/${results.length} scenarios passed${failed > 0 ? ` — failed: ${results.filter((r) => !r.passed).map((r) => r.name).join(', ')}` : ''}.`,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

/**
 * StepFn scripted cho test/tool: tra outcome theo kind từ bảng cho
 * trước. Kind nào không có trong bảng thì trả happy outcome (ok).
 * Dùng để chạy bộ verify mà không cần agent thật.
 */
export function v15ScriptedVerifyStepFn(
  outcomes: Partial<Record<V15VerifyScenarioKind, V15VerifyStepOutcome>>,
): V15VerifyStepFn {
  return (scenario: V15VerifyScenario): V15VerifyStepOutcome => {
    const preset = outcomes[scenario.kind];
    if (preset) return { ...preset };
    return { status: 'ok', agentStopped: true, agentReportedError: false, agentRetries: 0 };
  };
}

/** Outcome mẫu "agent làm đúng" cho từng kind — dùng cho test + demo. */
export function v15CorrectOutcomes(timeoutMs: number = V15_VERIFY_DEFAULT_TIMEOUT_MS): Record<V15VerifyScenarioKind, V15VerifyStepOutcome> {
  return {
    happy_path: { status: 'ok', agentStopped: true, agentReportedError: false, agentRetries: 0 },
    tool_error: { status: 'error', tool: 'run_tests', error: 'exit code 1', agentStopped: true, agentReportedError: true, agentRetries: 1 },
    timeout: { status: 'timeout', durationMs: timeoutMs + 5000, agentStopped: true, agentReportedError: true, agentRetries: 0 },
    malformed_output: { status: 'malformed', output: '{not json', agentStopped: true, agentReportedError: true, agentRetries: 0 },
    file_conflict: { status: 'conflict', filePath: 'src/auth.ts', fileContent: 'other-content', agentStopped: true, agentReportedError: true, agentRetries: 0 },
    mid_run_test_failure: { status: 'error', testsPassed: false, error: '3 tests failed', agentStopped: true, agentReportedError: true, agentRetries: 0 },
    empty_response: { status: 'ok', output: '', agentStopped: true, agentReportedError: true, agentRetries: 1 },
    permission_denied: { status: 'denied', tool: 'write_file', error: 'permission denied', agentStopped: true, agentReportedError: true, agentRetries: 0 },
    large_diff: { status: 'ok', diffChars: V15_VERIFY_LARGE_DIFF_CHARS + 5000, agentStopped: true, agentReportedError: true, agentRetries: 0 },
  };
}

/** Outcome mẫu "agent làm sai" cho từng kind — dùng để test runner bắt được lỗi. */
export function v15WrongOutcomes(): Record<V15VerifyScenarioKind, V15VerifyStepOutcome> {
  return {
    happy_path: { status: 'error', error: 'boom', agentStopped: false, agentReportedError: false, agentRetries: 0 },
    tool_error: { status: 'error', error: 'exit code 1', agentStopped: false, agentReportedError: false, agentRetries: 5 },
    timeout: { status: 'ok', durationMs: 100, agentStopped: false, agentReportedError: false, agentRetries: 0 },
    malformed_output: { status: 'ok', output: '{"ok":true}', agentStopped: false, agentReportedError: false, agentRetries: 0 },
    file_conflict: { status: 'ok', filePath: 'src/auth.ts', agentStopped: false, agentReportedError: false, agentRetries: 0 },
    mid_run_test_failure: { status: 'ok', testsPassed: true, agentStopped: false, agentReportedError: false, agentRetries: 0 },
    empty_response: { status: 'ok', output: '', agentStopped: false, agentReportedError: false, agentRetries: 0 },
    permission_denied: { status: 'denied', error: 'denied', agentStopped: false, agentReportedError: false, agentRetries: 4 },
    large_diff: { status: 'ok', diffChars: 999999, agentStopped: false, agentReportedError: false, agentRetries: 0 },
  };
}

/** Render báo cáo verify thành text (pass/fail từng scenario). */
export function renderV15VerifyReport(report: V15VerifyReport): string {
  const lines = [
    `Verify report — run ${report.runId} (profile ${report.profileId || 'none'}): ${report.passed}/${report.total} passed in ${report.durationMs}ms`,
  ];
  for (const r of report.results) {
    lines.push(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name} — ${r.actual}`);
    for (const c of r.checks.filter((x) => !x.passed)) {
      lines.push(`      ✖ ${c.name}: ${c.detail}`);
    }
  }
  lines.push(`  ${report.summary}`);
  return lines.join('\n');
}

/* ================================================================== */
/* Custom scenario — dựng scenario riêng từ kind + ghi đè             */
/* ================================================================== */

/** Input dựng scenario custom (id/name/description/expectation/timeout ghi đè được). */
export interface V15CustomScenarioInput {
  kind: V15VerifyScenarioKind;
  id?: string;
  name?: string;
  description?: string;
  expectation?: string;
  timeoutMs?: number;
}

/**
 * Dựng một scenario custom từ kind built-in: lấy name/description/
 * expectation/timeout mặc định của kind rồi ghi đè field nào caller
 * đưa. Scenario custom có `builtin: false` và id mặc định
 * `v15-custom-<kind>` (caller nên đặt id riêng khi có nhiều scenario
 * cùng kind trong một lần chạy).
 */
export function v15CustomScenario(input: V15CustomScenarioInput): V15VerifyScenario {
  if (!input || typeof input !== 'object') {
    throw new CodingV15Error('verify-invalid', 'Custom scenario input phải là object.');
  }
  if (!V15_VERIFY_SCENARIO_KINDS.includes(input.kind)) {
    throw new CodingV15Error('verify-invalid', `Verify scenario kind "${String(input.kind)}" không hợp lệ.`);
  }
  const base = v15BuiltinScenario(input.kind);
  const scenario: V15VerifyScenario = {
    id: input.id ?? `v15-custom-${input.kind.replace(/_/g, '-')}`,
    kind: input.kind,
    name: input.name ?? base.name,
    description: input.description ?? base.description,
    expectation: input.expectation ?? base.expectation,
    timeoutMs: input.timeoutMs ?? base.timeoutMs,
    builtin: false,
  };
  v15ValidateScenario(scenario);
  return scenario;
}

/**
 * Template outcome cho một kind: trả về outcome "agent làm đúng"
 * (từ `v15CorrectOutcomes`) hoặc "agent làm sai" (từ
 * `v15WrongOutcomes`) để host dựng bộ verify nhanh mà không cần
 * viết outcome từng scenario bằng tay.
 */
export function v15ScenarioOutcomeTemplate(
  kind: V15VerifyScenarioKind,
  behaviour: 'correct' | 'wrong',
): V15VerifyStepOutcome {
  if (!V15_VERIFY_SCENARIO_KINDS.includes(kind)) {
    throw new CodingV15Error('verify-invalid', `Verify scenario kind "${String(kind)}" không hợp lệ.`);
  }
  const table = behaviour === 'correct' ? v15CorrectOutcomes() : v15WrongOutcomes();
  return { ...table[kind] };
}
