/**
 * Agent teams dashboard tools for @open-bot/tools (v1.10, Đội T5).
 *
 * The agent reads the teams dashboard by tool call:
 *  - teams_dashboard_summary  — totals across all teams (source,
 *    teams, teammates, tasks by status, blocked, stale claims,
 *    unread mail) (read)
 *  - teams_dashboard_list     — team cards (read)
 *  - teams_dashboard_team     — one team: teammates + tasks +
 *    mailbox counts (read)
 *  - teams_dashboard_tasks    — shared task list of a team, optional
 *    status filter, highest priority first (read)
 *  - teams_dashboard_mailbox  — mailbox of a team (or one teammate),
 *    newest first (read)
 *
 * All tools are read-only. The default provider is the mock seed
 * data (labelled `source: "mock"` in every response) until Team T3
 * wires the real teams v2 service — the host passes it via
 * `getProvider`. Nothing here writes to a team.
 *
 * Factory:
 *   createTeamsDashboardTools(opts) -> Tool[]   (bound, usable)
 *   TEAMS_DASHBOARD_TOOLS                       (unbound placeholder)
 *
 * NOTE (v1.10 merge): exported from the tools package but NOT yet
 * wired into defaultToolFactory — the coordinator wires
 * createTeamsDashboardTools and recounts the 556 tool pin (see wave
 * report).
 */
import type { Tool } from '@open-bot/core';
import {
  MockTeamDashboardProvider,
  dashboardMailboxForTeam,
  dashboardTasksForTeam,
  summarizeTeamDashboard,
  teamDashboardMarkdown,
  teamDashboardSummaryMarkdown,
  type TeamDashboardProvider,
  type TeamTaskStatus,
} from '@open-bot/core';

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

export interface TeamsDashboardToolOptions {
  /** Provider accessor (the host binds the real teams v2 service). */
  getProvider?: () => TeamDashboardProvider | null;
}

const TASK_STATUSES: TeamTaskStatus[] = ['pending', 'claimed', 'in-progress', 'done', 'failed', 'blocked'];

export function createTeamsDashboardTools(opts: TeamsDashboardToolOptions = {}): Tool[] {
  let fallbackProvider: TeamDashboardProvider | null = null;
  const needProvider = (): TeamDashboardProvider => {
    const provider = opts.getProvider?.() ?? fallbackProvider;
    if (!provider) {
      fallbackProvider = new MockTeamDashboardProvider();
      return fallbackProvider;
    }
    return provider;
  };

  const summary: Tool = {
    definition: toolDef(
      'teams_dashboard_summary',
      'Dashboard summary across all agent teams (read): totals, tasks by status, blocked tasks, stale claims, unread mail. Data source is labelled in the response ("mock" until the real teams service is wired).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const provider = needProvider();
        const result = summarizeTeamDashboard(provider);
        return JSON.stringify({ summary: result, markdown: teamDashboardSummaryMarkdown(result) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const list: Tool = {
    definition: toolDef(
      'teams_dashboard_list',
      'List agent teams as dashboard cards: status, lead, teammate/task/mailbox counts (read).',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const provider = needProvider();
        const teams = provider.listTeams().map((team) => ({
          id: team.id,
          name: team.name,
          goal: team.goal,
          status: team.status,
          leadId: team.leadId,
          teammates: team.teammates.length,
          working: team.teammates.filter((m) => m.status === 'working').length,
          tasks: team.tasks.length,
          tasksDone: team.tasks.filter((t) => t.status === 'done').length,
          messages: team.messages.length,
          unread: provider.unreadCount(team.id),
        }));
        return JSON.stringify({ source: provider.source, teams, count: teams.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const team: Tool = {
    definition: toolDef(
      'teams_dashboard_team',
      'One agent team in full: teammates, tasks and mailbox, plus the team as Markdown (read).',
      {
        teamId: { type: 'string', description: 'Id of the team.' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const provider = needProvider();
        const teamId = getStringArg(args, 'teamId');
        const found = provider.getTeam(teamId);
        if (!found) throw new Error(`Unknown team "${teamId}".`);
        return JSON.stringify(
          {
            source: provider.source,
            team: found,
            unread: provider.unreadCount(teamId),
            markdown: teamDashboardMarkdown(found),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tasks: Tool = {
    definition: toolDef(
      'teams_dashboard_tasks',
      'Shared task list of one team, highest priority first (read). Optional status filter: pending, claimed, in-progress, done, failed or blocked.',
      {
        teamId: { type: 'string', description: 'Id of the team.' },
        status: { type: 'string', description: 'Task status filter (optional).' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const provider = needProvider();
        const teamId = getStringArg(args, 'teamId');
        if (!provider.getTeam(teamId)) throw new Error(`Unknown team "${teamId}".`);
        const status = getOptionalStringArg(args, 'status');
        if (status !== undefined && !(TASK_STATUSES as readonly string[]).includes(status)) {
          throw new Error(`Unknown task status "${status}" (want one of ${TASK_STATUSES.join(', ')}).`);
        }
        const rows = dashboardTasksForTeam(provider, teamId, status as TeamTaskStatus | undefined);
        return JSON.stringify({ source: provider.source, teamId, tasks: rows, count: rows.length }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mailbox: Tool = {
    definition: toolDef(
      'teams_dashboard_mailbox',
      'Mailbox of one team (or one teammate), newest first (read).',
      {
        teamId: { type: 'string', description: 'Id of the team.' },
        teammateId: { type: 'string', description: 'Teammate id to filter by (optional; omit for the whole team).' },
      },
      ['teamId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const provider = needProvider();
        const teamId = getStringArg(args, 'teamId');
        if (!provider.getTeam(teamId)) throw new Error(`Unknown team "${teamId}".`);
        const teammateId = getOptionalStringArg(args, 'teammateId');
        const messages = dashboardMailboxForTeam(provider, teamId, teammateId);
        return JSON.stringify(
          { source: provider.source, teamId, ...(teammateId ? { teammateId } : {}), messages, count: messages.length },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [summary, list, team, tasks, mailbox];
}

/** Unbound placeholder (the host binds a provider via createTeamsDashboardTools). */
export const TEAMS_DASHBOARD_TOOLS: Tool[] = createTeamsDashboardTools();

export const TEAMS_DASHBOARD_TOOL_NAMES = [
  'teams_dashboard_summary',
  'teams_dashboard_list',
  'teams_dashboard_team',
  'teams_dashboard_tasks',
  'teams_dashboard_mailbox',
] as const;

export function isTeamsDashboardToolName(name: string): name is (typeof TEAMS_DASHBOARD_TOOL_NAMES)[number] {
  return (TEAMS_DASHBOARD_TOOL_NAMES as readonly string[]).includes(name);
}
