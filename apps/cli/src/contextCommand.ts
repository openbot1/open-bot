/**
 * Lệnh `context` (v1.05, Team T4) — context engineering v2 từ terminal.
 *
 *   open-bot context status [--bot <id>] [--workspace DIR] [--json]
 *   open-bot context policy [--bot <id>] [--workspace DIR] [--preset NAME]
 *              [--set triggerRatio=0.7] [--set maxTier=2] [--set keepRecentTurns=4]
 *              [--set frequency=hourly] [--set keepAnchorKinds=decision,metric] [--json]
 *   open-bot context inspect [--bot <id>] [--workspace DIR] [--json]
 *   open-bot context export [--bot <id>] [--workspace DIR] [--out FILE]
 *   open-bot context assemble [--bot <id>] [--workspace DIR] [--budget N] [--json]
 *   open-bot context schedule [--bot <id>] [--workspace DIR] [--json]
 *   open-bot context restore [--bot <id>] [--workspace DIR] [--json]
 *
 * State sống dưới `<workspace>/context-v2/` (cùng chỗ desktop +
 * coordinator dùng: policies.json, schedule.json, tiers/, spill/).
 * Mọi lệnh chỉ đọc, trừ `policy --set/--preset` (ghi policy) và
 * `restore` (nạp tiers đã lưu vào window trong process này rồi in
 * kết quả — window của process CLI là tạm, không chạm window của
 * desktop đang chạy). Không gọi model, không chạm mạng.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ContextV2Runtime,
  inspectWindow,
  presetCompactionPolicy,
  snapshotToMarkdown,
} from '@open-bot/core';

/** Flags đã parse (cùng shape CliFlags của cli.ts). */
export type ContextCliFlags = Record<string, string | boolean | string[]>;

function fail(message: string, code = 1): never {
  process.stderr.write(`open-bot: ${message}\n`);
  process.exit(code);
}

function flagString(flags: ContextCliFlags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(flags: ContextCliFlags, key: string): number | undefined {
  const raw = flagString(flags, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fail(`--${key} cần là số, nhận "${raw}".`);
}

function resolveWorkspace(flags: ContextCliFlags): string {
  const flag = flagString(flags, 'workspace');
  if (flag && flag.trim() !== '') return path.resolve(flag.trim());
  return process.cwd();
}

function resolveBotId(flags: ContextCliFlags): string {
  const flag = flagString(flags, 'bot');
  return flag && flag.trim() !== '' ? flag.trim() : 'default';
}

function runtimeFor(flags: ContextCliFlags): { runtime: ContextV2Runtime; botId: string; workspace: string } {
  const workspace = resolveWorkspace(flags);
  const botId = resolveBotId(flags);
  return { runtime: new ContextV2Runtime({ workspaceDir: workspace }), botId, workspace };
}

function print(flags: ContextCliFlags, obj: unknown, text: string): void {
  if (flags['json'] === true) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  } else {
    process.stdout.write(text);
  }
}

/** `status`: window stats + schedule + last compaction report. */
function cmdStatus(flags: ContextCliFlags): number {
  const { runtime, botId } = runtimeFor(flags);
  const stats = runtime.window.stats();
  const schedule = runtime.scheduleStatus(botId);
  const policy = runtime.policyFor(botId);
  const report = runtime.report;
  const text = [
    `Bot: ${botId}`,
    `Window: ${stats.usedTokens.toLocaleString()}/${stats.limit.toLocaleString()} tokens ` +
      `(${(stats.usageRatio * 100).toFixed(1)}%) · segments: ${stats.segmentCount} · spilled: ${stats.spilledCount}`,
    `Thresholds crossed: ${stats.thresholdsCrossed.join(', ') || 'none'}`,
    `Policy: trigger ${(policy.triggerRatio * 100).toFixed(0)}% · max tier ${policy.maxTier} · ` +
      `keep ${policy.keepRecentTurns} recent · ${policy.frequency}`,
    `Schedule: ${schedule.frequency} · last run ${schedule.lastRunAt ?? 'never'} · ` +
      `next allowed ${schedule.nextAllowedAt ?? 'now'} · runs ${schedule.runsTotal}`,
    report
      ? `Last compaction: ${report.at} · saved ${report.tokensSaved.toLocaleString()} tokens ` +
        `(${Math.round(report.savedRatio * 100)}%) · ${report.verifiedClaims} claims, ` +
        `${Math.round(report.verifiedRatio * 100)}% verified`
      : 'Last compaction: never',
    '',
  ].join('\n');
  print(flags, { botId, stats, schedule, policy, report }, text);
  return 0;
}

/** `policy`: xem / đặt policy (preset hoặc --set key=value). */
function cmdPolicy(flags: ContextCliFlags): number {
  const { runtime, botId } = runtimeFor(flags);
  const preset = flagString(flags, 'preset');
  const sets = flags['set'];
  const setList: string[] = Array.isArray(sets) ? sets : typeof sets === 'string' ? [sets] : [];
  if (preset === undefined && setList.length === 0) {
    const policy = runtime.policyFor(botId);
    print(flags, { botId, policy }, `Bot: ${botId}\n${JSON.stringify(policy, null, 2)}\n`);
    return 0;
  }
  try {
    let policy = runtime.policyFor(botId);
    if (preset) {
      policy = runtime.setPolicy(botId, { ...presetCompactionPolicy(botId, preset) });
    }
    if (setList.length > 0) {
      const patch: Record<string, unknown> = {};
      for (const item of setList) {
        const eq = item.indexOf('=');
        if (eq <= 0) fail(`--set cần dạng key=value, nhận "${item}".`);
        const key = item.slice(0, eq);
        const value = item.slice(eq + 1);
        if (key === 'triggerRatio' || key === 'keepRecentTurns' || key === 'maxTier') {
          const n = Number(value);
          if (!Number.isFinite(n)) fail(`--set ${key} cần là số.`);
          patch[key] = n;
        } else if (key === 'frequency') {
          patch[key] = value;
        } else if (key === 'keepAnchorKinds') {
          patch[key] = value.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          fail(`--set không biết key "${key}" (triggerRatio/maxTier/keepRecentTurns/frequency/keepAnchorKinds).`);
        }
      }
      policy = runtime.setPolicy(botId, patch as Parameters<ContextV2Runtime['setPolicy']>[1]);
    }
    print(flags, { botId, policy }, `Bot: ${botId}\n${JSON.stringify(policy, null, 2)}\n`);
    return 0;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** `inspect`: cây window (JSON hoặc tóm tắt text). */
function cmdInspect(flags: ContextCliFlags): number {
  const { runtime } = runtimeFor(flags);
  const tree = inspectWindow(runtime.window);
  const text = [
    `Window: ${tree.usedTokens.toLocaleString()}/${tree.limit.toLocaleString()} tokens ` +
      `(${(tree.usageRatio * 100).toFixed(1)}%)`,
    ...tree.groups
      .filter((g) => g.count > 0)
      .map((g) => `- ${g.kind}: ${g.count} segment(s), ${g.tokens.toLocaleString()} tokens`),
    '',
  ].join('\n');
  print(flags, tree, text);
  return 0;
}

/** `export`: snapshot JSON ra stdout hoặc --out FILE. */
function cmdExport(flags: ContextCliFlags): number {
  const { runtime, botId } = runtimeFor(flags);
  const snapshot = runtime.snapshot(botId);
  const out = flagString(flags, 'out');
  if (out) {
    fs.writeFileSync(path.resolve(out), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    process.stdout.write(`Snapshot written to ${path.resolve(out)} (${snapshot.segments.length} segments).\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  return 0;
}

/** `assemble`: prompt đã ráp từ window (+ manifest). */
function cmdAssemble(flags: ContextCliFlags): number {
  const { runtime } = runtimeFor(flags);
  const budget = flagNumber(flags, 'budget');
  const result = runtime.assemblePrompt({
    ...(budget !== undefined ? { tokenBudget: budget } : {}),
  });
  const text = [
    `Assembled ${result.messages.length} message(s), ${result.tokensUsed}/${result.tokenBudget} tokens` +
      (result.fits ? '' : ` — dropped ${result.droppedIds.length} segment(s)`),
    ...result.messages.map((m) => `--- [${m.role}] (${m.segmentIds.join(', ')})\n${m.content}`),
    '',
  ].join('\n');
  print(flags, result, text);
  return 0;
}

/** `schedule`: trạng thái scheduler của bot. */
function cmdSchedule(flags: ContextCliFlags): number {
  const { runtime, botId } = runtimeFor(flags);
  const status = runtime.scheduleStatus(botId);
  const text =
    `Bot: ${botId}\n` +
    `Frequency: ${status.frequency}\n` +
    `Last run: ${status.lastRunAt ?? 'never'}\n` +
    `Next allowed: ${status.nextAllowedAt ?? 'now'}\n` +
    `Runs total: ${status.runsTotal}\n` +
    `Due now: ${status.due ? 'yes' : 'no'}\n`;
  print(flags, status, text);
  return 0;
}

/** `restore`: nạp tiers đã lưu vào window (in số lượng + markdown snapshot). */
function cmdRestore(flags: ContextCliFlags): number {
  const { runtime, botId } = runtimeFor(flags);
  const restored = runtime.restoreTiers(botId);
  const snapshot = runtime.snapshot(botId);
  const text =
    `Restored ${restored.restored} tier summar(ies) for bot ${botId}` +
    (restored.lastCompactedAt ? ` (last compacted ${restored.lastCompactedAt})` : '') +
    `\n${snapshotToMarkdown(snapshot)}\n`;
  print(flags, { botId, restored, snapshot }, text);
  return 0;
}

/** Dispatch `open-bot context <sub> ...` (gọi từ cli.ts). */
export async function cmdContext(
  sub: string | undefined,
  flags: ContextCliFlags,
): Promise<number> {
  switch (sub) {
    case 'status':
      return cmdStatus(flags);
    case 'policy':
      return cmdPolicy(flags);
    case 'inspect':
      return cmdInspect(flags);
    case 'export':
      return cmdExport(flags);
    case 'assemble':
      return cmdAssemble(flags);
    case 'schedule':
      return cmdSchedule(flags);
    case 'restore':
      return cmdRestore(flags);
    case undefined:
      return cmdStatus(flags);
    default:
      return fail(
        `Không rõ lệnh context "${sub}" (status/policy/inspect/export/assemble/schedule/restore).`,
      );
  }
}
