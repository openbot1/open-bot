/**
 * Coding agent v7 tools (v1.15, Đội T4) — 7 tools.
 *
 * Stateless coding agent qua `CodingAgentV7` (core codingV7):
 *
 *  - coding_v7_start     — tạo session mới (log append-only + hash chain).
 *  - coding_v7_step      — chạy MỘT step stateless từ text model: parse
 *    action CodeAct v3, quét security (block = không chạy, warn = chạy
 *    kèm cảnh báo), chạy trong working dir bị nhốt qua executor v7
 *    (không cần BotBox), ghi observation vào log, lưu JSONL.
 *  - coding_v7_pause     — pause session (ghi event, agent dừng vòng lặp).
 *  - coding_v7_resume    — resume session đã pause (tiếp tục đúng chỗ).
 *  - coding_v7_replay    — verify chain + state tại seq / replay từ
 *    event N + fork tại seq (read-only, trừ fork).
 *  - coding_v7_security  — quét text code/command (allow/warn/block +
 *    rule đã khớp). Thuần — chạy được cả khi chưa nối base dir.
 *  - coding_v7_condense  — nén log thành summary 6 mục, append marker,
 *    không xoá lịch sử.
 *  - coding_v7_skills    — liệt kê skill (builtin + thư mục user) và
 *    khớp skill cho một task; `init` ghi 3 skill mẫu ra thư mục.
 *  - coding_v7_eval      — chạy bộ eval mẫu (3 task) với scripted
 *    model mặc định, trả pass rate.
 *
 * Placeholder trong ALL_TOOLS cho tới khi host bind
 * (`createCodingV7Tools(getBaseDir, opts)` với userData dir): log sống
 * ở `<baseDir>/coding-v7/<sessionId>.jsonl`. Executor v7 tự chủ (chạy
 * trong ctx.workspaceDir hoặc working dir do host chỉ định) — không
 * cần BotBox. Không gọi mạng, không gọi model thật (generate do host
 * nối ở tầng agent; tool `step` chỉ chạy action từ text đã có).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolContext, V7ModelGenerator } from '@open-bot/core';
import {
  CodingAgentV7,
  CodingV7Log,
  V7CodeActExecutor,
  V7SecurityAnalyzer,
  V7SkillRegistry,
  V7_EVAL_TASKS,
  condenseV7Log,
  discoverV7Skills,
  parseV7ActionsFromText,
  renderV7Summary,
  runV7EvalTask,
  scriptedV7Generator,
  V7_SCRIPT_FIX_GREET,
  V7_SCRIPT_FIX_OFF_BY_ONE,
  writeV7BuiltinSkills,
} from '@open-bot/core';

const NOT_WIRED =
  'Coding agent v7 is not configured: the host has not wired a base directory yet. ' +
  'Bind createCodingV7Tools(getBaseDir) with the app userData directory first.';

export const CODING_V7_TOOL_NAMES = [
  'coding_v7_start',
  'coding_v7_step',
  'coding_v7_pause',
  'coding_v7_resume',
  'coding_v7_replay',
  'coding_v7_security',
  'coding_v7_condense',
  'coding_v7_skills',
  'coding_v7_eval',
] as const;

export type CodingV7ToolName = (typeof CODING_V7_TOOL_NAMES)[number];

export function isCodingV7ToolName(name: string): boolean {
  return (CODING_V7_TOOL_NAMES as readonly string[]).includes(name);
}

export interface CodingV7ToolOptions {
  /** Model generator cho agent (host nối; không nối thì step chỉ parse, không chạy turn). */
  getModelGenerator?: (ctx: ToolContext) => V7ModelGenerator | null | undefined;
  /** Thư mục workspace fallback (ưu tiên ctx.workspaceDir). */
  getWorkspaceDir?: () => string | null | undefined;
  /** Thư mục skill thêm ngoài builtin (mặc định <baseDir>/coding-v7/skills). */
  getSkillsDir?: () => string | null | undefined;
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

export function codingV7DataDir(baseDir: string): string {
  return path.join(baseDir, 'coding-v7');
}

function sessionFilePath(baseDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(codingV7DataDir(baseDir), `${safe}.jsonl`);
}

function loadLog(baseDir: string, sessionId: string): CodingV7Log {
  const file = sessionFilePath(baseDir, sessionId);
  if (fs.existsSync(file)) {
    return CodingV7Log.fromJsonl(fs.readFileSync(file, 'utf8'));
  }
  return new CodingV7Log(sessionId);
}

function saveLog(baseDir: string, log: CodingV7Log): void {
  fs.mkdirSync(codingV7DataDir(baseDir), { recursive: true });
  fs.writeFileSync(sessionFilePath(baseDir, log.sessionId), log.toJsonl(), 'utf8');
}

export function createCodingV7Tools(
  getBaseDir?: () => string | null | undefined,
  toolOptions: CodingV7ToolOptions = {},
): Tool[] {
  const resolveBase = (): string | null => {
    try {
      const dir = getBaseDir?.();
      return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
    } catch {
      return null;
    }
  };

  const resolveWorkspaceDir = (ctx: ToolContext): string => {
    if (ctx.workspaceDir && ctx.workspaceDir.trim().length > 0) return ctx.workspaceDir;
    const dir = toolOptions.getWorkspaceDir?.();
    if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    const base = resolveBase();
    return base ? path.join(base, 'coding-v7-workspace') : path.join(os.tmpdir(), 'open-bot-coding-v7-workspace');
  };

  const resolveSkillsDir = (): string | null => {
    const dir = toolOptions.getSkillsDir?.();
    if (typeof dir === 'string' && dir.trim().length > 0) return dir;
    const base = resolveBase();
    return base ? path.join(codingV7DataDir(base), 'skills') : null;
  };

  const startTool: Tool = {
    definition: toolDef(
      'coding_v7_start',
      'Start a new coding agent v7 session (v1.15): creates an append-only event-sourced log (hash chain) for a coding task. Returns the session id. The log lives under <baseDir>/coding-v7/.',
      {
        sessionId: { type: 'string', description: 'Optional id (default: generated uuid).' },
        title: { type: 'string', description: 'Short task title.' },
        prompt: { type: 'string', description: 'Task prompt for the agent.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId') || undefined;
        const title = getStringArg(args, 'title') || 'coding v7 session';
        const prompt = getStringArg(args, 'prompt');
        const log = new CodingV7Log(sessionId);
        const agent = new CodingAgentV7(log, { skills: new V7SkillRegistry(resolveSkillsDir() ? [resolveSkillsDir() as string] : []) });
        agent.startTask(title, prompt || title);
        saveLog(base, log);
        return JSON.stringify({ sessionId: log.sessionId, title, lastSeq: log.length, status: log.state().status }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stepTool: Tool = {
    definition: toolDef(
      'coding_v7_step',
      'Run ONE stateless step of coding agent v7 (v1.15): parses CodeAct v3 actions (fenced bash/python/edit/read/think/finish/ask or JSON) from the text, scans each action with the security analyzer (block = not run, warn = run with warning), executes in the workspace sandbox, and appends observation events to the log. Returns observations + session status.',
      {
        sessionId: { type: 'string', description: 'Session id from coding_v7_start.' },
        text: { type: 'string', description: 'Agent output text containing actions.' },
      },
      ['sessionId', 'text'],
    ),
    needsApproval: true,
    execute: async (args, ctx) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const text = getStringArg(args, 'text', true);
        const log = loadLog(base, sessionId);
        const parsed = parseV7ActionsFromText(text);
        if (parsed.actions.length === 0) {
          return errorResult(`no recognizable action: ${parsed.errors.join('; ')}`);
        }
        const executor = new V7CodeActExecutor({ workingDir: resolveWorkspaceDir(ctx) });
        const observations: Array<Record<string, unknown>> = [];
        for (const action of parsed.actions) {
          const { observation, verdict } = await executor.execute(action);
          if (verdict) {
            log.append('v7.security.verdict', { kind: action.kind, level: verdict.level, summary: verdict.summary });
          }
          if (observation.blocked) {
            log.append('v7.action.blocked', { kind: action.kind, reason: observation.blockReason ?? 'blocked' });
            observations.push({ kind: action.kind, blocked: true, reason: observation.blockReason });
            break;
          }
          log.append('v7.action.executed', { kind: action.kind, exitCode: observation.exitCode, durationMs: observation.durationMs });
          if (observation.fileWritten) {
            log.append('v7.file.changed', { path: observation.fileWritten.path, bytes: observation.fileWritten.bytes });
          }
          log.append('v7.observation', {
            kind: action.kind, ok: observation.ok, stdout: observation.stdout,
            stderr: observation.stderr, exitCode: observation.exitCode, timedOut: observation.timedOut, blocked: false,
          });
          observations.push({ kind: action.kind, ok: observation.ok, stdout: observation.stdout, stderr: observation.stderr, exitCode: observation.exitCode });
          if (!observation.ok) break;
        }
        saveLog(base, log);
        return JSON.stringify({ sessionId, status: log.state().status, lastSeq: log.length, parseErrors: parsed.errors, observations }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pauseTool: Tool = {
    definition: toolDef(
      'coding_v7_pause',
      'Pause a coding agent v7 session (v1.15): appends a pause event; the agent loop stops after the current step and resumes exactly where it left off.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        reason: { type: 'string', description: 'Why the session is paused.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      const log = loadLog(base, getStringArg(args, 'sessionId', true));
      log.pause(getStringArg(args, 'reason') || undefined);
      saveLog(base, log);
      return JSON.stringify({ sessionId: log.sessionId, status: log.state().status, pauses: log.state().pauses }, null, 2);
    },
  };

  const resumeTool: Tool = {
    definition: toolDef(
      'coding_v7_resume',
      'Resume a paused coding agent v7 session (v1.15): appends a resume event; the agent continues from the next step without re-running old steps.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        reason: { type: 'string', description: 'Why the session is resumed.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      const log = loadLog(base, getStringArg(args, 'sessionId', true));
      log.resume(getStringArg(args, 'reason') || undefined);
      saveLog(base, log);
      return JSON.stringify({ sessionId: log.sessionId, status: log.state().status, resumes: log.state().resumes }, null, 2);
    },
  };

  const replayTool: Tool = {
    definition: toolDef(
      'coding_v7_replay',
      'Replay / time-travel / fork a coding agent v7 log (v1.15): verifies the hash chain, returns the state at a seq, the events from a seq, or forks a new session at a seq.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        atSeq: { type: 'integer', description: 'Return state at this seq (1-based).' },
        fromSeq: { type: 'integer', description: 'Return events from this seq onward.' },
        forkAtSeq: { type: 'integer', description: 'Fork a new session at this seq; returns the child session id.' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const sessionId = getStringArg(args, 'sessionId', true);
        const log = loadLog(base, sessionId);
        const verify = log.verify();
        const atSeq = getIntArg(args, 'atSeq');
        const fromSeq = getIntArg(args, 'fromSeq');
        const forkAtSeq = getIntArg(args, 'forkAtSeq');
        if (forkAtSeq !== undefined) {
          const child = log.forkAt(forkAtSeq);
          saveLog(base, log);
          saveLog(base, child);
          return JSON.stringify({ sessionId, forkSessionId: child.sessionId, forkSeq: forkAtSeq, chainOk: verify.ok }, null, 2);
        }
        return JSON.stringify({
          sessionId,
          chainOk: verify.ok,
          checked: verify.checked,
          ...(atSeq !== undefined ? { stateAt: log.stateAt(atSeq) } : {}),
          ...(fromSeq !== undefined ? { events: log.replayFrom(fromSeq) } : {}),
          ...((atSeq === undefined && fromSeq === undefined) ? { state: log.state() } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const securityTool: Tool = {
    definition: toolDef(
      'coding_v7_security',
      'Scan code or a shell command with the coding agent v7 security analyzer (v1.15) before running it: returns allow/warn/block plus the matched rules. Pure — works without a wired base directory.',
      {
        kind: { type: 'string', description: 'What is scanned: bash | python | edit | read.' },
        text: { type: 'string', description: 'Code or command to scan.' },
      },
      ['kind', 'text'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const kind = getStringArg(args, 'kind', true);
      if (!['bash', 'python', 'edit', 'read'].includes(kind)) {
        return errorResult(`kind must be bash | python | edit | read, got ${kind}`);
      }
      const verdict = new V7SecurityAnalyzer().assessText(
        kind as 'bash' | 'python' | 'edit' | 'read',
        getStringArg(args, 'text', true),
      );
      return JSON.stringify(verdict, null, 2);
    },
  };

  const condenseTool: Tool = {
    definition: toolDef(
      'coding_v7_condense',
      'Condense a coding agent v7 log (v1.15) into a structured 6-section summary (goal/facts/decisions/files changed/errors/open items). Appends a marker event; the original history is kept.',
      {
        sessionId: { type: 'string', description: 'Session id.' },
        upToSeq: { type: 'integer', description: 'Condense up to this seq (default: last seq).' },
      },
      ['sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      const log = loadLog(base, getStringArg(args, 'sessionId', true));
      const upToSeq = getIntArg(args, 'upToSeq');
      const summary = condenseV7Log(log.all(), {}, upToSeq);
      log.append('v7.condensed', {
        upToSeq: summary.upToSeq, eventsCondensed: summary.eventsCondensed,
        tokensBefore: summary.tokensBefore, tokensAfter: summary.tokensAfter, goal: summary.goal,
      });
      saveLog(base, log);
      return JSON.stringify({ sessionId: log.sessionId, summary: renderV7Summary(summary), structured: summary }, null, 2);
    },
  };

  const skillsTool: Tool = {
    definition: toolDef(
      'coding_v7_skills',
      'List coding agent v7 Skills (v1.15, microagent-style markdown files) and match them to a task; action "init" writes the 3 builtin sample skills to the skills directory.',
      {
        action: { type: 'string', description: '"list" (default), "match", or "init".' },
        text: { type: 'string', description: 'Task text to match skills against (for "match").' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      const action = getStringArg(args, 'action') || 'list';
      const skillsDir = resolveSkillsDir() as string;
      if (action === 'init') {
        const written = writeV7BuiltinSkills(skillsDir);
        return JSON.stringify({ action: 'init', skillsDir, written }, null, 2);
      }
      const registry = new V7SkillRegistry([skillsDir]);
      if (action === 'match') {
        const text = getStringArg(args, 'text', true);
        const matches = registry.match(text).map((m) => ({
          skill: m.skill.name, matchedTrigger: m.matchedTrigger, score: m.score,
          description: m.skill.description,
        }));
        return JSON.stringify({ action: 'match', text, matches }, null, 2);
      }
      const discovered = discoverV7Skills(skillsDir);
      return JSON.stringify({
        action: 'list',
        skillsDir,
        skills: registry.list().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers, source: s.source })),
        warnings: discovered.warnings,
      }, null, 2);
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'coding_v7_eval',
      'Run the coding agent v7 sample eval (v1.15): 3 small coding tasks on sample repos in /tmp, measured by real test commands. Uses scripted model replies by default (deterministic); pass a "taskId" to run one task. Returns the pass rate.',
      {
        taskId: { type: 'string', description: 'Optional single task id (v7eval-fix-off-by-one | v7eval-add-function | v7eval-fix-failing-test).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const base = resolveBase();
      if (!base) return errorResult(NOT_WIRED);
      try {
        const taskId = getStringArg(args, 'taskId');
        const tasks = taskId ? V7_EVAL_TASKS.filter((t) => t.id === taskId) : [...V7_EVAL_TASKS];
        if (tasks.length === 0) return errorResult(`unknown eval task: ${taskId}`);
        const scripts: Record<string, readonly string[]> = {
          'v7eval-fix-off-by-one': V7_SCRIPT_FIX_OFF_BY_ONE,
          'v7eval-fix-failing-test': V7_SCRIPT_FIX_GREET,
        };
        // Task add-function: scripted model that writes is_prime + test.
        const addFunctionScript = [
          '```edit\ncalc.py\ndef sum_range(n):\n    return sum(range(n + 1))\n\n\ndef is_prime(n):\n    if n < 2:\n        return False\n    for i in range(2, int(n ** 0.5) + 1):\n        if n % i == 0:\n            return False\n    return True\n```',
          '```edit\ntest_calc.py\nfrom calc import sum_range, is_prime\n\n\ndef test_sum_range():\n    assert sum_range(5) == 15\n\n\ndef test_is_prime():\n    assert is_prime(2) is True\n    assert is_prime(7) is True\n    assert is_prime(4) is False\n    assert is_prime(1) is False\n```',
          '```bash\npython3 -c "import test_calc; [f() for n, f in vars(test_calc).items() if n.startswith(\'test_\')]; print(\'all tests passed\')"\n```',
          '```finish\nAdded is_prime with tests. Tests pass.\n```',
        ];
        const generate = (task: (typeof tasks)[number]): V7ModelGenerator => {
          const script = scripts[task.id] ?? (task.id === 'v7eval-add-function' ? addFunctionScript : ['```finish\nNo script for this task.\n```']);
          return scriptedV7Generator(script);
        };
        const results = [];
        for (const task of tasks) {
          results.push(await runV7EvalTask(task, generate(task)));
        }
        const passed = results.filter((r) => r.passed).length;
        return JSON.stringify({ total: results.length, passed, passRate: results.length ? passed / results.length : 0, results }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [startTool, stepTool, pauseTool, resumeTool, replayTool, securityTool, condenseTool, skillsTool, evalTool];
}

/** Placeholder tools (unbound) for ALL_TOOLS — same names, never a duplicate. */
export const CODING_V7_TOOLS: Tool[] = createCodingV7Tools();
