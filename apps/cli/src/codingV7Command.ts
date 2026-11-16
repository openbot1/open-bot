/**
 * Lệnh `coding-v7` cho CLI headless (v1.15, Đội T4).
 *
 * Dùng coding agent v7 (core) trực tiếp từ terminal, không cần mở app:
 *
 *   open-bot coding-v7 security <bash|python|edit|read> <text> [--json]
 *   open-bot coding-v7 skills list [--json]
 *   open-bot coding-v7 skills match <text> [--json]
 *   open-bot coding-v7 skills init [--json]
 *   open-bot coding-v7 eval [--task <id>] [--json]
 *   open-bot coding-v7 replay <sessionId> [--at N] [--from N] [--json]
 *
 * Log đọc từ <dataDir>/coding-v7/<sessionId>.jsonl (cùng chỗ tool
 * coding_v7_* ghi). Không gọi model thật, không gọi mạng; eval dùng
 * scripted model nên chạy xác định.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CodingV7Log,
  V7SecurityAnalyzer,
  V7SkillRegistry,
  V7_EVAL_TASKS,
  V7_SCRIPT_FIX_GREET,
  V7_SCRIPT_FIX_OFF_BY_ONE,
  discoverV7Skills,
  runV7EvalTask,
  scriptedV7Generator,
  writeV7BuiltinSkills,
} from '@open-bot/core';
import type { V7ModelGenerator } from '@open-bot/core';

export interface CodingV7CliFlags {
  [key: string]: string | boolean | string[] | undefined;
}

export function codingV7Help(): string {
  return [
    'open-bot coding-v7 — coding agent v7 (stateless + event log + CodeAct-lite v3 + security + Skills + eval)',
    '  open-bot coding-v7 security <bash|python|edit|read> <text> [--json]',
    '  open-bot coding-v7 skills list [--json]',
    '  open-bot coding-v7 skills match <text> [--json]',
    '  open-bot coding-v7 skills init [--json]',
    '  open-bot coding-v7 eval [--task <id>] [--json]',
    '  open-bot coding-v7 replay <sessionId> [--at N] [--from N] [--json]',
  ].join('\n');
}

function fail(message: string): never {
  throw new Error(message);
}

function asJson(flags: CodingV7CliFlags): boolean {
  return flags['json'] === true;
}

function out(flags: CodingV7CliFlags, obj: unknown, text: string): void {
  process.stdout.write(asJson(flags) ? `${JSON.stringify(obj, null, 2)}\n` : `${text}\n`);
}

function numFlag(flags: CodingV7CliFlags, key: string): number | undefined {
  const raw = flags[key];
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function cmdCodingV7(
  sub: string | undefined,
  positional: string[],
  flags: CodingV7CliFlags,
  dataDir: string,
): Promise<number> {
  const baseDir = path.join(dataDir, 'coding-v7');
  const skillsDir = path.join(baseDir, 'skills');

  if (sub === 'security') {
    const kind = positional[0] ?? '';
    if (!['bash', 'python', 'edit', 'read'].includes(kind)) {
      fail('coding-v7 security cần kind bash|python|edit|read: open-bot coding-v7 security <kind> <text>.');
    }
    const text = positional.slice(1).join(' ');
    if (!text) fail('coding-v7 security cần <text> để quét.');
    const verdict = new V7SecurityAnalyzer().assessText(kind as 'bash' | 'python' | 'edit' | 'read', text);
    out(flags, verdict, `level: ${verdict.level}\n${verdict.summary}${verdict.findings.length ? `\nfindings:\n${verdict.findings.map((f) => `  - ${f.ruleId}: ${f.message}`).join('\n')}` : ''}`);
    return verdict.level === 'block' ? 2 : 0;
  }

  if (sub === 'skills') {
    const action = positional[0] ?? 'list';
    if (action === 'init') {
      const written = writeV7BuiltinSkills(skillsDir);
      out(flags, { skillsDir, written }, `Wrote ${written.length} builtin skills to ${skillsDir}:\n${written.join('\n')}`);
      return 0;
    }
    if (action === 'match') {
      const text = positional.slice(1).join(' ');
      if (!text) fail('coding-v7 skills match cần <text>.');
      const registry = new V7SkillRegistry([skillsDir]);
      const matches = registry.match(text).map((m) => ({
        skill: m.skill.name, matchedTrigger: m.matchedTrigger, score: m.score, description: m.skill.description,
      }));
      out(flags, { text, matches }, matches.length ? matches.map((m) => `${m.skill} (score ${m.score}, trigger "${m.matchedTrigger}"): ${m.description}`).join('\n') : 'No skill matched.');
      return 0;
    }
    if (action === 'list') {
      const registry = new V7SkillRegistry([skillsDir]);
      const discovered = discoverV7Skills(skillsDir);
      const skills = registry.list().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers, source: s.source }));
      out(flags, { skillsDir, skills, warnings: discovered.warnings },
        skills.map((s) => `${s.name}: ${s.description} [${s.triggers.join(', ')}]`).join('\n') || 'No skills found.');
      return 0;
    }
    fail('coding-v7 skills chỉ hỗ trợ list|match|init.');
  }

  if (sub === 'eval') {
    const taskId = typeof flags['task'] === 'string' ? flags['task'] : '';
    const tasks = taskId ? V7_EVAL_TASKS.filter((t) => t.id === taskId) : [...V7_EVAL_TASKS];
    if (tasks.length === 0) fail(`Không có eval task "${taskId}".`);
    const scripts: Record<string, readonly string[]> = {
      'v7eval-fix-off-by-one': V7_SCRIPT_FIX_OFF_BY_ONE,
      'v7eval-fix-failing-test': V7_SCRIPT_FIX_GREET,
    };
    const addFunctionScript = [
      '```edit\ncalc.py\ndef sum_range(n):\n    return sum(range(n + 1))\n\n\ndef is_prime(n):\n    if n < 2:\n        return False\n    for i in range(2, int(n ** 0.5) + 1):\n        if n % i == 0:\n            return False\n    return True\n```',
      '```edit\ntest_calc.py\nfrom calc import sum_range, is_prime\n\n\ndef test_sum_range():\n    assert sum_range(5) == 15\n\n\ndef test_is_prime():\n    assert is_prime(2) is True\n    assert is_prime(7) is True\n    assert is_prime(4) is False\n    assert is_prime(1) is False\n```',
      '```bash\npython3 -c "import test_calc; [f() for n, f in vars(test_calc).items() if n.startswith(\'test_\')]; print(\'all tests passed\')"\n```',
      '```finish\nAdded is_prime with tests. Tests pass.\n```',
    ];
    const results = [];
    for (const task of tasks) {
      const script = scripts[task.id] ?? (task.id === 'v7eval-add-function' ? addFunctionScript : ['```finish\nNo script for this task.\n```']);
      const generate: V7ModelGenerator = scriptedV7Generator(script);
      results.push(await runV7EvalTask(task, generate));
    }
    const passed = results.filter((r) => r.passed).length;
    const report = { total: results.length, passed, passRate: results.length ? passed / results.length : 0, results };
    out(flags, report, `Eval v7: ${passed}/${results.length} passed (${Math.round(report.passRate * 100)}%)\n${results.map((r) => `  ${r.passed ? 'PASS' : 'FAIL'} ${r.taskId} (${r.steps} steps, ${r.actions} actions)`).join('\n')}`);
    return passed === results.length ? 0 : 2;
  }

  if (sub === 'replay') {
    const sessionId = positional[0] ?? '';
    if (!sessionId) fail('coding-v7 replay cần <sessionId>: open-bot coding-v7 replay <sessionId> [--at N] [--from N].');
    const file = path.join(baseDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
    if (!fs.existsSync(file)) fail(`Không có log session "${sessionId}" tại ${file}.`);
    const log = CodingV7Log.fromJsonl(fs.readFileSync(file, 'utf8'));
    const verify = log.verify();
    const at = numFlag(flags, 'at');
    const from = numFlag(flags, 'from');
    const payload: Record<string, unknown> = { sessionId, chainOk: verify.ok, checked: verify.checked };
    if (at !== undefined) payload['stateAt'] = log.stateAt(at);
    if (from !== undefined) payload['events'] = log.replayFrom(from);
    if (at === undefined && from === undefined) payload['state'] = log.state();
    out(flags, payload, `session: ${sessionId}\nchain: ${verify.ok ? 'OK' : `INVALID at seq ${verify.firstBadSeq} (${verify.reason})`} (${verify.checked} events)${at !== undefined ? `\nstate at seq ${at}: ${JSON.stringify(payload['stateAt'], null, 2)}` : ''}${from !== undefined ? `\nevents from seq ${from}: ${(payload['events'] as unknown[]).length}` : ''}`);
    return verify.ok ? 0 : 2;
  }

  process.stdout.write(`${codingV7Help()}\n`);
  return fail(`Không rõ lệnh "coding-v7 ${sub ?? ''}".`);
}
