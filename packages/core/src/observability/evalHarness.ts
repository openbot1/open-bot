/**
 * Eval harness (observability v3) — score recorded runs against
 * expectations.
 *
 * An eval case says what a good run looks like; an eval suite is a
 * named set of cases stored in `<baseDir>/evals.json` (atomic write,
 * same posture as the other local JSON stores). Scoring is pure:
 * `scoreEvalCase` folds one `ReplayedRunState` — the deterministic
 * replay of a recorded run (event-log/replay.ts, Team T1; this module
 * only reads that state, never the log) — against a case's checks:
 *
 * - `tool-used`: the run called this tool at least once;
 * - `tool-not-used`: the run never called this tool;
 * - `no-errors`: no error in the replayed state;
 * - `tokens-under`: total tokens below a budget;
 * - `duration-under`: run duration below a budget (ms);
 * - `file-changed`: the run changed this relative path;
 * - `text-contains`: the final text / any transcript text contains this string.
 *
 * A case passes when every check passes; the suite report aggregates
 * pass rate, per-case results, and the slowest/most expensive runs,
 * so the UI can show which cases regressed without re-running anything.
 * Running the eval against live bots is out of scope — the harness
 * scores recordings, which is deterministic and free.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReplayedRunState } from '../event-log/types';

export const EVAL_SUITES_FILE = 'evals.json';

/** One check inside an eval case. */
export type EvalCheck =
  | { kind: 'tool-used'; tool: string }
  | { kind: 'tool-not-used'; tool: string }
  | { kind: 'no-errors' }
  | { kind: 'tokens-under'; maxTokens: number }
  | { kind: 'duration-under'; maxMs: number }
  | { kind: 'file-changed'; path: string }
  | { kind: 'text-contains'; text: string };

/** One eval case: what a good run looks like. */
export interface EvalCase {
  id: string;
  name: string;
  /** Human-readable expectation (shown in the UI). */
  description: string;
  /** Prompt the run was supposed to answer (for reference only). */
  prompt: string;
  checks: EvalCheck[];
  createdAt: string;
  updatedAt: string;
}

/** A named set of eval cases. */
export interface EvalSuite {
  id: string;
  name: string;
  description: string;
  cases: EvalCase[];
  createdAt: string;
  updatedAt: string;
}

/** One check's verdict. */
export interface EvalCheckResult {
  check: EvalCheck;
  passed: boolean;
  /** Plain-English detail (e.g. actual token count vs budget). */
  detail: string;
}

/** One case scored against one run. */
export interface EvalCaseResult {
  caseId: string;
  caseName: string;
  runId: string;
  passed: boolean;
  checks: EvalCheckResult[];
  /** Passed checks / total checks. */
  score: number;
}

/** A whole suite scored against a set of runs (one run per case id). */
export interface EvalSuiteReport {
  suiteId: string;
  suiteName: string;
  at: number;
  results: EvalCaseResult[];
  passed: number;
  failed: number;
  /** Cases with no run supplied (skipped, not failed). */
  skipped: string[];
  passRate: number;
  /** Total tokens across scored runs. */
  totalTokens: number;
  /** Slowest scored run (ms) — null when nothing was scored. */
  slowestMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evalSuitesPath(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('eval harness needs a non-empty baseDir.');
  }
  return path.join(baseDir, EVAL_SUITES_FILE);
}

function validateCheck(raw: unknown): EvalCheck | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case 'tool-used':
    case 'tool-not-used':
      if (typeof raw.tool !== 'string' || raw.tool.trim().length === 0) return null;
      return { kind: raw.kind, tool: raw.tool.trim() };
    case 'no-errors':
      return { kind: 'no-errors' };
    case 'tokens-under':
      if (typeof raw.maxTokens !== 'number' || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0) return null;
      return { kind: 'tokens-under', maxTokens: raw.maxTokens };
    case 'duration-under':
      if (typeof raw.maxMs !== 'number' || !Number.isFinite(raw.maxMs) || raw.maxMs <= 0) return null;
      return { kind: 'duration-under', maxMs: raw.maxMs };
    case 'file-changed':
      if (typeof raw.path !== 'string' || raw.path.trim().length === 0) return null;
      return { kind: 'file-changed', path: raw.path.trim() };
    case 'text-contains':
      if (typeof raw.text !== 'string' || raw.text.trim().length === 0) return null;
      return { kind: 'text-contains', text: raw.text.trim() };
    default:
      return null;
  }
}

function validateCase(raw: unknown): EvalCase | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, prompt, checks, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof description !== 'string') return null;
  if (typeof prompt !== 'string') return null;
  if (!Array.isArray(checks)) return null;
  const validChecks = checks.map((c) => validateCheck(c)).filter((c): c is EvalCheck => c !== null);
  if (validChecks.length !== checks.length) return null;
  if (typeof createdAt !== 'string' || createdAt.trim().length === 0) return null;
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) return null;
  return {
    id: id.trim(),
    name: name.trim(),
    description,
    prompt,
    checks: validChecks,
    createdAt,
    updatedAt,
  };
}

function validateSuite(raw: unknown): EvalSuite | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, cases, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof description !== 'string') return null;
  if (!Array.isArray(cases)) return null;
  const validCases = cases.map((c) => validateCase(c)).filter((c): c is EvalCase => c !== null);
  if (validCases.length !== cases.length) return null;
  if (typeof createdAt !== 'string' || createdAt.trim().length === 0) return null;
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) return null;
  return {
    id: id.trim(),
    name: name.trim(),
    description,
    cases: validCases,
    createdAt,
    updatedAt,
  };
}

/** All eval suites (missing file = none; corrupt rows dropped). */
export function listEvalSuites(baseDir: string): EvalSuite[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(evalSuitesPath(baseDir), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => validateSuite(row))
    .filter((s): s is EvalSuite => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function saveEvalSuites(baseDir: string, suites: EvalSuite[]): void {
  const filePath = evalSuitesPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(suites, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function suiteId(name: string): string {
  return `eval-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}-${Date.now().toString(36)}`;
}

function caseId(name: string): string {
  return `case-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}-${Date.now().toString(36)}`;
}

/** Create a suite (empty cases). */
export function createEvalSuite(baseDir: string, name: string, description = ''): EvalSuite {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('eval suite needs a non-empty name.');
  }
  const now = new Date().toISOString();
  const suite: EvalSuite = {
    id: suiteId(name),
    name: name.trim(),
    description,
    cases: [],
    createdAt: now,
    updatedAt: now,
  };
  saveEvalSuites(baseDir, [...listEvalSuites(baseDir), suite]);
  return suite;
}

/** Remove a suite. Returns true when one was removed. */
export function removeEvalSuite(baseDir: string, id: string): boolean {
  const suites = listEvalSuites(baseDir);
  const next = suites.filter((s) => s.id !== id);
  if (next.length === suites.length) return false;
  saveEvalSuites(baseDir, next);
  return true;
}

export interface AddEvalCaseInput {
  name: string;
  description?: string;
  prompt?: string;
  checks: EvalCheck[];
}

/** Add a case to a suite. Returns the created case. */
export function addEvalCase(baseDir: string, suiteIdValue: string, input: AddEvalCaseInput): EvalCase {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error('eval case needs a non-empty name.');
  }
  if (!Array.isArray(input.checks) || input.checks.length === 0) {
    throw new Error('eval case needs at least one check.');
  }
  const suites = listEvalSuites(baseDir);
  const suite = suites.find((s) => s.id === suiteIdValue);
  if (!suite) throw new Error(`eval suite not found: ${suiteIdValue}`);
  const now = new Date().toISOString();
  const validChecks = input.checks.map((c) => validateCheck(c)).filter((c): c is EvalCheck => c !== null);
  if (validChecks.length !== input.checks.length) {
    throw new Error('eval case has an invalid check.');
  }
  const evalCase: EvalCase = {
    id: caseId(input.name),
    name: input.name.trim(),
    description: input.description ?? '',
    prompt: input.prompt ?? '',
    checks: validChecks,
    createdAt: now,
    updatedAt: now,
  };
  saveEvalSuites(
    baseDir,
    suites.map((s) =>
      s.id === suiteIdValue ? { ...s, cases: [...s.cases, evalCase], updatedAt: now } : s,
    ),
  );
  return evalCase;
}

/** Remove a case from a suite. Returns true when one was removed. */
export function removeEvalCase(baseDir: string, suiteIdValue: string, caseIdValue: string): boolean {
  const suites = listEvalSuites(baseDir);
  const suite = suites.find((s) => s.id === suiteIdValue);
  if (!suite) return false;
  if (!suite.cases.some((c) => c.id === caseIdValue)) return false;
  const now = new Date().toISOString();
  saveEvalSuites(
    baseDir,
    suites.map((s) =>
      s.id === suiteIdValue
        ? { ...s, cases: s.cases.filter((c) => c.id !== caseIdValue), updatedAt: now }
        : s,
    ),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

function runDurationMs(state: ReplayedRunState): number | null {
  if (!state.startedAt) return null;
  const end = state.endedAt ?? state.startedAt;
  const ms = Date.parse(end) - Date.parse(state.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function transcriptText(state: ReplayedRunState): string {
  return state.transcript
    .map((entry) => (entry.kind === 'text' ? entry.text : entry.kind === 'tool_result' ? entry.outputPreview : ''))
    .join('\n');
}

function checkOne(check: EvalCheck, state: ReplayedRunState): EvalCheckResult {
  const toolsUsed = new Set(state.toolCalls.map((t) => t.tool));
  switch (check.kind) {
    case 'tool-used': {
      const passed = toolsUsed.has(check.tool);
      return {
        check,
        passed,
        detail: passed ? `run called ${check.tool}.` : `run never called ${check.tool}.`,
      };
    }
    case 'tool-not-used': {
      const passed = !toolsUsed.has(check.tool);
      return {
        check,
        passed,
        detail: passed ? `run never called ${check.tool}.` : `run called ${check.tool}.`,
      };
    }
    case 'no-errors': {
      const passed = state.errors.length === 0;
      return {
        check,
        passed,
        detail: passed ? 'run had no errors.' : `run had ${state.errors.length} error(s): ${state.errors[0]}`,
      };
    }
    case 'tokens-under': {
      const passed = state.tokensUsed < check.maxTokens;
      return {
        check,
        passed,
        detail: `used ${state.tokensUsed} tokens (budget ${check.maxTokens}).`,
      };
    }
    case 'duration-under': {
      const duration = runDurationMs(state);
      if (duration === null) {
        return { check, passed: false, detail: 'run duration is unknown.' };
      }
      return {
        check,
        passed: duration < check.maxMs,
        detail: `ran ${duration} ms (budget ${check.maxMs} ms).`,
      };
    }
    case 'file-changed': {
      const passed = state.fileChanges.some((f) => f.path === check.path);
      return {
        check,
        passed,
        detail: passed ? `run changed ${check.path}.` : `run never changed ${check.path}.`,
      };
    }
    case 'text-contains': {
      const passed = transcriptText(state).toLowerCase().includes(check.text.toLowerCase());
      return {
        check,
        passed,
        detail: passed ? `transcript contains "${check.text}".` : `transcript lacks "${check.text}".`,
      };
    }
  }
}

/** Score one case against one replayed run. */
export function scoreEvalCase(evalCase: EvalCase, state: ReplayedRunState): EvalCaseResult {
  const checks = evalCase.checks.map((check) => checkOne(check, state));
  const passedCount = checks.filter((c) => c.passed).length;
  return {
    caseId: evalCase.id,
    caseName: evalCase.name,
    runId: state.runId,
    passed: passedCount === checks.length,
    checks,
    score: checks.length === 0 ? 0 : passedCount / checks.length,
  };
}

/**
 * Score a whole suite. `statesByCaseId` maps case id -> the replayed
 * run to score it against. Cases without a run are skipped (reported
 * in `skipped`, not failed).
 */
export function runEvalSuite(
  suite: EvalSuite,
  statesByCaseId: Record<string, ReplayedRunState>,
  at: number = Date.now(),
): EvalSuiteReport {
  const results: EvalCaseResult[] = [];
  const skipped: string[] = [];
  let totalTokens = 0;
  let slowestMs: number | null = null;
  for (const evalCase of suite.cases) {
    const state = statesByCaseId[evalCase.id];
    if (!state) {
      skipped.push(evalCase.id);
      continue;
    }
    const result = scoreEvalCase(evalCase, state);
    results.push(result);
    totalTokens += state.tokensUsed;
    const duration = runDurationMs(state);
    if (duration !== null && (slowestMs === null || duration > slowestMs)) slowestMs = duration;
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    suiteId: suite.id,
    suiteName: suite.name,
    at,
    results,
    passed,
    failed: results.length - passed,
    skipped,
    passRate: results.length === 0 ? 0 : passed / results.length,
    totalTokens,
    slowestMs,
  };
}
