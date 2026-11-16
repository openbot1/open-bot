/**
 * ACP Control Center tools for @open-bot/tools (v1.12, Team T4).
 *
 * Tools so an agent can manage external CLI agents through the
 * Control Center without touching a process directly (same factory
 * pattern as createAcpHostingTools):
 *  - `acp_control_discover` — list CLI agents installed on this machine
 *    (PATH + login label from the CLI's own status check). Read-only.
 *  - `acp_control_list` — registered managed agents: status, budget,
 *    today's usage. Read-only.
 *  - `acp_control_register` — register a discovered backend as a
 *    managed agent (disabled by default — starting needs a separate,
 *    explicit step). No process is spawned.
 *  - `acp_control_start` — spawn + ACP-handshake a managed agent
 *    (runs the CLI with its own login). Needs approval.
 *  - `acp_control_stop` — stop a running managed agent.
 *  - `acp_control_set_budget` — set/raise/lower one agent's daily
 *    caps (tokens / cost / calls / wall time).
 *  - `acp_control_usage` — usage summary + recent turns for one
 *    agent (or all agents). Read-only.
 *  - `acp_control_prompt` — send one prompt turn to a RUNNING
 *    managed agent and return its reply (budget-checked first).
 *    Needs approval: it runs the outside agent.
 *  - `acp_control_report` — per-day usage for the last N days plus
 *    recent budget alerts for one agent. Read-only.
 *
 * Factory (same pattern as createAcpHostingTools):
 *   createAcpControlTools(opts?) -> Tool[]   (bound, usable)
 *   ACP_CONTROL_TOOLS                       (unbound placeholders)
 *
 * Safety: tools never read, copy, or send a credential. `start`
 * spawns the CLI binary the user registered, with that CLI's own
 * login session on this machine.
 */

import type { Tool } from '@open-bot/core';
import {
  AcpControlCenter,
  AcpControlError,
  formatWallMs,
  type AgentBudget,
  type ControlCenterBackendId,
} from '@open-bot/core';
import { truncateText as truncate } from './truncate';

export interface AcpControlToolOptions {
  /** Shared center (default: a new one backed by `stateDir`). */
  center?: AcpControlCenter;
  /** State dir for registrations + usage (default: memory only). */
  stateDir?: string;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
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

function formatCost(costUsd: number | null): string {
  return costUsd === null ? 'unknown' : `$${costUsd.toFixed(4)}`;
}

function formatBudgetLine(budget: AgentBudget): string {
  const parts: string[] = [];
  if (budget.maxTokensPerDay !== undefined) parts.push(`tokens/day ≤ ${budget.maxTokensPerDay}`);
  if (budget.maxCostUsdPerDay !== undefined) parts.push(`cost/day ≤ $${budget.maxCostUsdPerDay}`);
  if (budget.maxCallsPerDay !== undefined) parts.push(`calls/day ≤ ${budget.maxCallsPerDay}`);
  if (budget.maxWallMsPerDay !== undefined) parts.push(`wall/day ≤ ${formatWallMs(budget.maxWallMsPerDay)}`);
  return parts.length > 0 ? parts.join(', ') : 'no caps';
}

const DISCOVER_DEF = () =>
  toolDef(
    'acp_control_discover',
    'Discover external CLI agents installed on this machine (Claude Code, Codex, Gemini CLI, OpenCode, Grok CLI, Cursor, Copilot, Devin, Zed): installed or not, login label reported by the CLI itself, and whether each is already registered. Read-only; no process is spawned unless probeAcp is true.',
    {
      probeAcp: { type: 'boolean', description: 'Also run a real ACP initialize handshake against each installed binary (slower; default false).' },
    },
    [],
  );

const LIST_DEF = () =>
  toolDef(
    'acp_control_list',
    'List registered managed agents in the ACP Control Center: status, enabled, login, budget caps, and today\'s usage (tokens, cost, calls, wall time). Read-only.',
    {},
    [],
  );

const REGISTER_DEF = () =>
  toolDef(
    'acp_control_register',
    'Register a discovered CLI backend as a managed agent in the ACP Control Center. The agent starts DISABLED (enable + start are separate steps) and no process is spawned.',
    {
      backendId: { type: 'string', description: 'Backend id from acp_control_discover (e.g. "claude", "codex", "gemini", "opencode").' },
    },
    ['backendId'],
  );

const START_DEF = () =>
  toolDef(
    'acp_control_start',
    'Start a registered managed agent: spawns its CLI binary (with the CLI\'s own login on this machine) and runs the ACP handshake. Needs approval: it spawns a real process. Refused when the agent is disabled or its daily budget is already exceeded.',
    {
      agentId: { type: 'string', description: 'Managed agent id (e.g. "cc-claude") from acp_control_list.' },
    },
    ['agentId'],
  );

const STOP_DEF = () =>
  toolDef(
    'acp_control_stop',
    'Stop a running managed agent (kills its CLI process).',
    {
      agentId: { type: 'string', description: 'Managed agent id from acp_control_list.' },
    },
    ['agentId'],
  );

const SET_BUDGET_DEF = () =>
  toolDef(
    'acp_control_set_budget',
    'Set one managed agent\'s daily budget caps. Omit a cap to leave it unchanged; pass 0 or null to clear that cap (unlimited). Caps: maxTokensPerDay, maxCostUsdPerDay, maxCallsPerDay, maxWallMsPerDay.',
    {
      agentId: { type: 'string', description: 'Managed agent id from acp_control_list.' },
      maxTokensPerDay: { type: 'number', description: 'Max input+output tokens per local day.' },
      maxCostUsdPerDay: { type: 'number', description: 'Max estimated USD cost per local day.' },
      maxCallsPerDay: { type: 'number', description: 'Max prompt turns per local day.' },
      maxWallMsPerDay: { type: 'number', description: 'Max total turn wall time per local day, milliseconds.' },
    },
    ['agentId'],
  );

const USAGE_DEF = () =>
  toolDef(
    'acp_control_usage',
    'Usage for managed agents: today + all-time tokens, cost, calls, wall time, and recent turns. Read-only.',
    {
      agentId: { type: 'string', description: 'Managed agent id (optional; omit for all agents).' },
      limit: { type: 'number', description: 'How many recent turns to show per agent (default 5).' },
    },
    [],
  );

const PROMPT_DEF = () =>
  toolDef(
    'acp_control_prompt',
    'Send one prompt turn to a RUNNING managed agent and return its reply text, stop reason, and the turn\'s token usage. The center refuses the turn when the agent\'s daily budget is already exceeded. Needs approval: it runs the outside agent.',
    {
      agentId: { type: 'string', description: 'Managed agent id from acp_control_list.' },
      text: { type: 'string', description: 'The prompt text to send.' },
      cwd: { type: 'string', description: 'Working directory for the session (optional; defaults to the workspace).' },
    },
    ['agentId', 'text'],
  );

const REPORT_DEF = () =>
  toolDef(
    'acp_control_report',
    'Per-day usage for one managed agent over the last N local days (tokens, cost, calls, wall time) plus its recent budget alerts. Read-only.',
    {
      agentId: { type: 'string', description: 'Managed agent id from acp_control_list.' },
      days: { type: 'number', description: 'How many days to cover (default 7, max 30).' },
    },
    ['agentId'],
  );

export const ACP_CONTROL_TOOLS: Tool[] = [
  { definition: DISCOVER_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_discover is not bound — use createAcpControlTools().'); } },
  { definition: LIST_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_list is not bound — use createAcpControlTools().'); } },
  { definition: REGISTER_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_register is not bound — use createAcpControlTools().'); } },
  { definition: START_DEF(), needsApproval: true, async execute() { return errorResult('acp_control_start is not bound — use createAcpControlTools().'); } },
  { definition: STOP_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_stop is not bound — use createAcpControlTools().'); } },
  { definition: SET_BUDGET_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_set_budget is not bound — use createAcpControlTools().'); } },
  { definition: USAGE_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_usage is not bound — use createAcpControlTools().'); } },
  { definition: PROMPT_DEF(), needsApproval: true, async execute() { return errorResult('acp_control_prompt is not bound — use createAcpControlTools().'); } },
  { definition: REPORT_DEF(), needsApproval: false, async execute() { return errorResult('acp_control_report is not bound — use createAcpControlTools().'); } },
];

/** Turn a tool error into a readable `Error:` result (never throws out of execute). */
function describeError(err: unknown): string {
  if (err instanceof AcpControlError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function createAcpControlTools(opts: AcpControlToolOptions = {}): Tool[] {
  const center = opts.center ?? new AcpControlCenter({ stateDir: opts.stateDir });

  const discover: Tool = {
    definition: DISCOVER_DEF(),
    needsApproval: false,
    async execute(args) {
      try {
        const probeAcp = getOptionalBooleanArg(args, 'probeAcp') ?? false;
        const found = await center.discover({ probeAcp });
        if (found.length === 0) return 'No known CLI agent backends.';
        const lines: string[] = ['Discovered CLI agents:'];
        for (const f of found) {
          lines.push(
            `- ${f.backendId} (${f.name}): ${f.installed ? `installed at ${f.resolvedPath ?? f.command}` : 'not installed'}` +
              (f.speaksAcp ? ` — speaks ACP${f.agentVersion ? ` v${f.agentVersion}` : ''}` : '') +
              (f.loggedIn ? ` — logged in${f.loginLabel ? ` as ${f.loginLabel}` : ''}` : ' — not logged in') +
              (f.alreadyRegistered ? ' — already registered' : '') +
              (f.error ? ` — ${f.error}` : ''),
          );
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const list: Tool = {
    definition: LIST_DEF(),
    needsApproval: false,
    async execute() {
      try {
        const views = center.views();
        if (views.length === 0) {
          return 'No managed agents registered yet. Run acp_control_discover, then acp_control_register.';
        }
        const lines: string[] = ['Managed agents:'];
        for (const view of views) {
          const r = view.record;
          lines.push(
            `- ${r.id} (${r.name}): ${r.status}${r.enabled ? '' : ' [disabled]'}` +
              (r.loggedIn ? ` — logged in${r.loginLabel ? ` as ${r.loginLabel}` : ''}` : ' — not logged in') +
              (r.agentVersion ? ` — v${r.agentVersion}` : '') +
              (r.lastError ? ` — last error: ${r.lastError}` : ''),
          );
          lines.push(
            `  Budget: ${formatBudgetLine(r.budget)}` +
              (view.budget.blocked ? ` — BLOCKED: ${view.budget.reasons.join('; ')}` : view.budget.warned ? ` — warning: ${view.budget.reasons.join('; ')}` : ''),
          );
          lines.push(
            `  Today: ${view.today.totalTokens} tokens, ${formatCost(view.today.costUsd)}, ${view.today.calls} calls, ${formatWallMs(view.today.wallMs)}` +
              ` | Total: ${view.total.totalTokens} tokens, ${formatCost(view.total.costUsd)}, ${view.total.calls} calls`,
          );
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const register: Tool = {
    definition: REGISTER_DEF(),
    needsApproval: false,
    async execute(args) {
      try {
        const backendId = getStringArg(args, 'backendId') as ControlCenterBackendId;
        const found = await center.discover();
        const match = found.find((f) => f.backendId === backendId);
        if (!match) return errorResult(`unknown backend: ${backendId}`);
        if (!match.installed) return errorResult(`${match.name} is not installed on this machine.`);
        const record = center.registerDiscovered(match);
        return truncate(
          `Registered ${record.name} as ${record.id} (disabled by default). ` +
            `Enable it in the Control Center UI, then start it — it runs with the CLI's own login.`,
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const start: Tool = {
    definition: START_DEF(),
    needsApproval: true,
    async execute(args) {
      try {
        const agentId = getStringArg(args, 'agentId');
        const record = await center.start(agentId);
        return truncate(`Started ${record.name} (${record.id}) — status: ${record.status}${record.agentVersion ? `, agent v${record.agentVersion}` : ''}.`);
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const stop: Tool = {
    definition: STOP_DEF(),
    needsApproval: false,
    async execute(args) {
      try {
        const agentId = getStringArg(args, 'agentId');
        const record = center.get(agentId);
        if (!record) return errorResult(`unknown managed agent: ${agentId}`);
        const stopped = center.stop(agentId);
        return stopped ? `Stopped ${record.name} (${agentId}).` : `${record.name} (${agentId}) was not running.`;
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const setBudget: Tool = {
    definition: SET_BUDGET_DEF(),
    needsApproval: false,
    async execute(args) {
      try {
        const agentId = getStringArg(args, 'agentId');
        const patch: Partial<AgentBudget> = {};
        const readCap = (name: 'maxTokensPerDay' | 'maxCostUsdPerDay' | 'maxCallsPerDay' | 'maxWallMsPerDay') => {
          const raw = args[name];
          if (raw === undefined || raw === null) return;
          if (typeof raw !== 'number') throw new Error(`Argument "${name}" must be a number.`);
          // 0 clears the cap (unlimited); the validator rejects 0, so map it to undefined.
          patch[name] = raw === 0 ? undefined : raw;
        };
        readCap('maxTokensPerDay');
        readCap('maxCostUsdPerDay');
        readCap('maxCallsPerDay');
        readCap('maxWallMsPerDay');
        if (Object.keys(patch).length === 0) return errorResult('no budget cap given — pass at least one of maxTokensPerDay, maxCostUsdPerDay, maxCallsPerDay, maxWallMsPerDay.');
        const { record, evaluation } = center.setBudget(agentId, patch);
        return truncate(
          `Budget for ${record.name} (${agentId}): ${formatBudgetLine(record.budget)}` +
            (evaluation.blocked ? ` — BLOCKED: ${evaluation.reasons.join('; ')}` : evaluation.warned ? ` — warning: ${evaluation.reasons.join('; ')}` : ' — within budget.'),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const usage: Tool = {
    definition: USAGE_DEF(),
    needsApproval: false,
    async execute(args) {
      try {
        const agentId = getOptionalStringArg(args, 'agentId');
        const limit = getOptionalNumberArg(args, 'limit') ?? 5;
        const ids = agentId ? [agentId] : center.list().map((r) => r.id);
        if (ids.length === 0) return 'No managed agents registered yet.';
        const lines: string[] = [];
        for (const id of ids) {
          const record = center.get(id);
          if (!record) return errorResult(`unknown managed agent: ${id}`);
          const today = center.todayUsage(id);
          const total = center.totalUsage(id);
          lines.push(`${record.name} (${id}):`);
          lines.push(`  Today: ${today.totalTokens} tokens (${today.inputTokens} in / ${today.outputTokens} out), ${formatCost(today.costUsd)}, ${today.calls} calls, ${formatWallMs(today.wallMs)}, ${today.toolCalls} tool calls`);
          lines.push(`  Total: ${total.totalTokens} tokens, ${formatCost(total.costUsd)}, ${total.calls} calls, ${formatWallMs(total.wallMs)}`);
          const turns = center.history(id, limit);
          if (turns.length > 0) {
            lines.push('  Recent turns:');
            for (const turn of turns.slice().reverse()) {
              lines.push(
                `  - ${turn.at} [${turn.status}] ${turn.inputTokens + turn.outputTokens} tokens, ${formatCost(turn.costUsd)}, ${formatWallMs(turn.durationMs)}, stop: ${turn.stopReason}`,
              );
            }
          }
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const prompt: Tool = {
    definition: PROMPT_DEF(),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const agentId = getStringArg(args, 'agentId');
        const text = getStringArg(args, 'text');
        const cwd = getOptionalStringArg(args, 'cwd') ?? ctx.workspaceDir;
        const record = center.get(agentId);
        if (!record) return errorResult(`unknown managed agent: ${agentId}`);
        // Reuse the session for this cwd when one exists, else create one.
        let sessionId = record.sessions[cwd];
        if (!sessionId) {
          const session = await center.newSession(agentId, cwd);
          sessionId = session.sessionId;
        }
        const result = await center.prompt(agentId, sessionId, text);
        const lines = [
          `Agent: ${record.name} (${agentId}), session ${sessionId}, stop: ${result.stopReason}`,
          `Turn usage: ${result.turn.inputTokens + result.turn.outputTokens} tokens (${result.turn.inputTokens} in / ${result.turn.outputTokens} out), ${formatCost(result.turn.costUsd)}, ${formatWallMs(result.turn.durationMs)}`,
          '',
          result.text || '(no text reply)',
        ];
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  const report: Tool = {
    definition: REPORT_DEF(),
    needsApproval: false,
    async execute(args) {
      try {
        const agentId = getStringArg(args, 'agentId');
        const rawDays = getOptionalNumberArg(args, 'days') ?? 7;
        const days = Math.max(1, Math.min(30, Math.floor(rawDays)));
        const record = center.get(agentId);
        if (!record) return errorResult(`unknown managed agent: ${agentId}`);
        const reportData = center.usageReport(agentId, days);
        const lines: string[] = [`Usage report for ${record.name} (${agentId}) — last ${days} day(s):`];
        for (const day of reportData.days) {
          const s = day.summary;
          lines.push(
            `- ${day.day}: ${s.totalTokens} tokens, ${formatCost(s.costUsd)}, ${s.calls} calls, ${formatWallMs(s.wallMs)}${day.blocked ? ' [blocked]' : ''}`,
          );
        }
        lines.push(`Total: ${reportData.total.totalTokens} tokens, ${formatCost(reportData.total.costUsd)}, ${reportData.total.calls} calls`);
        const alerts = center.alertsFor(agentId, 5);
        if (alerts.length > 0) {
          lines.push('Recent budget alerts:');
          for (const alert of alerts) {
            lines.push(`- ${alert.at} [${alert.kind}] ${alert.reasons.join('; ')}`);
          }
        } else {
          lines.push('Recent budget alerts: none');
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  };

  return [discover, list, register, start, stop, setBudget, usage, prompt, report];
}
