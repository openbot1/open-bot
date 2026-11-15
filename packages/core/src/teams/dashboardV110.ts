/**
 * Agent teams dashboard (v1.10, Đội T5 — dashboard cho agent teams).
 *
 * The dashboard is the read-only view over agent teams: one screen
 * showing every team, its teammates, the shared task list and the
 * mailbox. The data comes from Team T3's teams v2 service; this
 * module defines the narrow interface the dashboard needs so the two
 * sides can meet without sharing internals:
 *
 *   TeamDashboardProvider — listTeams / getTeam / teammatesOf /
 *   tasksOf / mailboxOf (+ unread counts). T3 implements it on top
 *   of the real service; until then `MockTeamDashboardProvider`
 *   serves deterministic seed data so the UI, the tools and the
 *   tests can all run today. The mock is labelled as a mock
 *   everywhere it appears (summary, markdown, tool output).
 *
 * On top of the provider, this module owns the dashboard's
 * aggregation (the summary a header renders: totals, tasks by
 * status, blocked work, unread mail, stale claims) and its Markdown
 * rendering. The desktop renderer owns the visual view models
 * (apps/desktop/src/renderer/teams/teamDashboardView.ts) — this
 * module never touches React or the DOM.
 *
 * Idea only, learned from Claude Code Agent Teams in
 * docs/repo-survey-v110.md §2 (shared task list with claiming,
 * peer-to-peer mailbox, lead + teammates): only the idea — all
 * types here reuse open-bot's own v1.09 team types.
 */

import type {
  AgentTeamV109,
  AgentTeamV109Status,
  MailboxMessage,
  TeamTask,
  TeamTaskStatus,
  Teammate,
  TeammateStatus,
} from './types';

/**
 * The narrow read interface the dashboard needs. Implementations:
 * `MockTeamDashboardProvider` (seed data, this module) and — once
 * Team T3 ships it — the real teams v2 service adapter. The
 * dashboard never writes through this interface.
 */
export interface TeamDashboardProvider {
  /** Short name identifying the source (`mock`, `teams-v2`, ...). */
  readonly source: string;
  listTeams(): AgentTeamV109[];
  getTeam(teamId: string): AgentTeamV109 | undefined;
  teammatesOf(teamId: string): Teammate[];
  tasksOf(teamId: string): TeamTask[];
  mailboxOf(teamId: string, teammateId?: string): MailboxMessage[];
  unreadCount(teamId: string, teammateId?: string): number;
}

/** Dashboard summary: the numbers the header renders. */
export interface TeamDashboardSummary {
  source: string;
  teams: number;
  activeTeams: number;
  teammates: number;
  workingTeammates: number;
  blockedTeammates: number;
  tasks: number;
  tasksByStatus: Record<TeamTaskStatus, number>;
  blockedTasks: number;
  staleClaims: number;
  messages: number;
  unreadMessages: number;
  /** Teammate with the most done tasks (null when no team). */
  busiestTeammate: { teamId: string; name: string; tasksDone: number } | null;
  generatedAtMs: number;
}

export const TEAM_DASHBOARD_TASK_STATUSES: TeamTaskStatus[] = [
  'pending', 'claimed', 'in-progress', 'done', 'failed', 'blocked',
];

export const TEAM_DASHBOARD_TEAM_STATUSES: AgentTeamV109Status[] = [
  'active', 'paused', 'completed', 'dissolved',
];

export const TEAM_DASHBOARD_TEAMMATE_STATUSES: TeammateStatus[] = [
  'idle', 'working', 'waiting', 'blocked', 'done', 'failed',
];

/** Aggregate every team a provider serves into one summary. */
export function summarizeTeamDashboard(
  provider: TeamDashboardProvider,
  nowMs = Date.now(),
): TeamDashboardSummary {
  const teams = provider.listTeams();
  const tasksByStatus = Object.fromEntries(
    TEAM_DASHBOARD_TASK_STATUSES.map((s) => [s, 0]),
  ) as Record<TeamTaskStatus, number>;
  let teammates = 0;
  let workingTeammates = 0;
  let blockedTeammates = 0;
  let tasks = 0;
  let blockedTasks = 0;
  let staleClaims = 0;
  let messages = 0;
  let unreadMessages = 0;
  let busiest: TeamDashboardSummary['busiestTeammate'] = null;
  for (const team of teams) {
    teammates += team.teammates.length;
    for (const mate of team.teammates) {
      if (mate.status === 'working') workingTeammates += 1;
      if (mate.status === 'blocked') blockedTeammates += 1;
      if (!busiest || mate.tasksDone > busiest.tasksDone) {
        busiest = { teamId: team.id, name: mate.name, tasksDone: mate.tasksDone };
      }
    }
    tasks += team.tasks.length;
    for (const task of team.tasks) {
      tasksByStatus[task.status] += 1;
      if (task.status === 'blocked') blockedTasks += 1;
      if (
        task.status === 'claimed' && task.claimedAt !== undefined &&
        nowMs - task.claimedAt > team.config.claimTimeoutMs
      ) {
        staleClaims += 1;
      }
    }
    messages += team.messages.length;
    unreadMessages += team.messages.filter((m) => !m.read && m.toId !== '*').length;
  }
  return {
    source: provider.source,
    teams: teams.length,
    activeTeams: teams.filter((t) => t.status === 'active').length,
    teammates,
    workingTeammates,
    blockedTeammates,
    tasks,
    tasksByStatus,
    blockedTasks,
    staleClaims,
    messages,
    unreadMessages,
    busiestTeammate: busiest,
    generatedAtMs: nowMs,
  };
}

/** Tasks of one team, optionally filtered by status, highest priority first. */
export function dashboardTasksForTeam(
  provider: TeamDashboardProvider,
  teamId: string,
  status?: TeamTaskStatus,
): TeamTask[] {
  const tasks = provider.tasksOf(teamId);
  const filtered = status ? tasks.filter((t) => t.status === status) : [...tasks];
  return filtered.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

/** Mailbox of one team (or one teammate), newest first. */
export function dashboardMailboxForTeam(
  provider: TeamDashboardProvider,
  teamId: string,
  teammateId?: string,
): MailboxMessage[] {
  return provider
    .mailboxOf(teamId, teammateId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** One team as Markdown (for logs / the run transcript). */
export function teamDashboardMarkdown(team: AgentTeamV109): string {
  const byStatus = new Map<string, number>();
  for (const t of team.tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const lines = [
    `## Team ${team.name} (${team.status})`,
    ``,
    team.goal,
    ``,
    `- Lead: ${team.teammates.find((m) => m.id === team.leadId)?.name ?? team.leadId}`,
    `- Teammates: ${team.teammates.length} (${team.teammates.filter((m) => m.status === 'working').length} working, ${team.teammates.filter((m) => m.status === 'blocked').length} blocked)`,
    `- Tasks: ${team.tasks.length} (${[...byStatus.entries()].map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`,
    `- Mailbox: ${team.messages.length} messages (${team.messages.filter((m) => !m.read && m.toId !== '*').length} unread)`,
  ];
  for (const mate of team.teammates) {
    lines.push(`- ${mate.name} (${mate.role}${mate.specialty ? `, ${mate.specialty}` : ''}): ${mate.status}${mate.currentTaskId ? ` on ${mate.currentTaskId}` : ''} — ${mate.tasksDone} done, ${mate.tasksFailed} failed`);
  }
  return lines.join('\n');
}

/** Dashboard summary as Markdown. */
export function teamDashboardSummaryMarkdown(summary: TeamDashboardSummary): string {
  const lines = [
    `## Agent teams dashboard (${summary.source})`,
    ``,
    `- Teams: ${summary.teams} (${summary.activeTeams} active)`,
    `- Teammates: ${summary.teammates} (${summary.workingTeammates} working, ${summary.blockedTeammates} blocked)`,
    `- Tasks: ${summary.tasks} (${TEAM_DASHBOARD_TASK_STATUSES.map((s) => `${summary.tasksByStatus[s]} ${s}`).join(', ')})`,
    `- Blocked tasks: ${summary.blockedTasks} · stale claims: ${summary.staleClaims}`,
    `- Mailbox: ${summary.messages} messages (${summary.unreadMessages} unread)`,
  ];
  if (summary.busiestTeammate) {
    lines.push(`- Busiest teammate: ${summary.busiestTeammate.name} (${summary.busiestTeammate.tasksDone} done)`);
  }
  return lines.join('\n');
}

/** Default config shared by the mock teams. */
export const MOCK_TEAM_CONFIG = {
  maxTeammates: 8,
  maxParallelTasks: 8,
  partitionMode: 'directory' as const,
  claimTimeoutMs: 10 * 60_000,
  taskTimeoutMs: 30 * 60_000,
  allowQuestionsToLead: true,
};

/**
 * Deterministic seed data for the dashboard: two teams, one active
 * (3 teammates, 5 tasks, 4 mailbox messages) and one paused. The
 * timestamps are fixed offsets from `baseMs` so tests can assert
 * exact values. THIS IS MOCK DATA — the real provider is T3's
 * teams v2 service; the dashboard labels it as mock.
 */
export function seedMockTeams(baseMs = 1_700_000_000_000): AgentTeamV109[] {
  const t = (offsetMs: number): number => baseMs + offsetMs;
  const active: AgentTeamV109 = {
    id: 'team-mock-voice',
    name: 'voice-v5',
    goal: 'Ship realtime voice v5: mock VAD, barge-in, streaming transcript.',
    leadId: 'mate-lead',
    defaultModel: 'mock',
    teammates: [
      { id: 'mate-lead', name: 'lead', role: 'lead', specialty: 'coordination', status: 'working', currentTaskId: 'task-vad', tasksDone: 2, tasksFailed: 0, createdAt: t(0), updatedAt: t(1000) },
      { id: 'mate-vad', name: 'vad', role: 'teammate', specialty: 'researcher', status: 'working', currentTaskId: 'task-vad', tasksDone: 3, tasksFailed: 0, createdAt: t(0), updatedAt: t(1000), partition: 'src/voice/' },
      { id: 'mate-ui', name: 'ui', role: 'teammate', specialty: 'coder', status: 'idle', tasksDone: 1, tasksFailed: 1, createdAt: t(0), updatedAt: t(1000), partition: 'src/renderer/voice/' },
    ],
    tasks: [
      { id: 'task-vad', title: 'Mock VAD v9', status: 'in-progress', dependsOn: [], priority: 5, claimedBy: 'mate-vad', claimedAt: t(2000), touchesFiles: ['packages/core/src/voice/vadV9.ts'], attempts: 1, maxAttempts: 3, createdAt: t(0), updatedAt: t(2000), startedAt: t(2000) },
      { id: 'task-barge', title: 'Barge-in v9 controller', status: 'claimed', dependsOn: ['task-vad'], priority: 4, claimedBy: 'mate-vad', claimedAt: t(3000), touchesFiles: ['packages/core/src/voice/bargeInV9.ts'], attempts: 1, maxAttempts: 3, createdAt: t(0), updatedAt: t(3000) },
      { id: 'task-transcript', title: 'Streaming transcript v9', status: 'done', dependsOn: [], priority: 4, claimedBy: 'mate-lead', claimedAt: t(1000), touchesFiles: ['packages/core/src/voice/transcriptStreamV9.ts'], attempts: 1, maxAttempts: 3, resultSummary: 'Partial + commit + tool-call attach.', createdAt: t(0), updatedAt: t(4000), startedAt: t(1000), finishedAt: t(4000) },
      { id: 'task-tools', title: 'Voice v9 tools', status: 'pending', dependsOn: ['task-barge'], priority: 3, touchesFiles: ['packages/tools/src/voiceV9Tools.ts'], attempts: 0, maxAttempts: 3, createdAt: t(0), updatedAt: t(0) },
      { id: 'task-blocked', title: 'Live voice probe', status: 'blocked', dependsOn: [], priority: 2, touchesFiles: [], attempts: 2, maxAttempts: 3, error: 'No live key in Vault — mock only.', createdAt: t(0), updatedAt: t(5000) },
    ],
    messages: [
      { id: 'msg-1', teamId: 'team-mock-voice', fromId: 'mate-lead', fromName: 'lead', toId: 'mate-vad', kind: 'request', taskId: 'task-vad', body: 'Start the mock VAD first — the session needs it.', read: true, createdAt: t(1500) },
      { id: 'msg-2', teamId: 'team-mock-voice', fromId: 'mate-vad', fromName: 'vad', toId: 'mate-lead', kind: 'result', taskId: 'task-vad', body: 'VAD v9 done: energy + ZCR, hangover, backchannels.', read: true, createdAt: t(2500) },
      { id: 'msg-3', teamId: 'team-mock-voice', fromId: 'mate-vad', fromName: 'vad', toId: 'mate-lead', kind: 'question', body: 'Should a 120 ms burst count as a turn or a backchannel?', read: false, createdAt: t(3500) },
      { id: 'msg-4', teamId: 'team-mock-voice', fromId: 'mate-lead', fromName: 'lead', toId: '*', kind: 'broadcast', body: 'Mock only until the live key lands in the Vault.', read: false, createdAt: t(4500) },
    ],
    config: { ...MOCK_TEAM_CONFIG },
    status: 'active',
    events: [{ at: t(0), type: 'created', message: 'Team voice-v5 created (mock seed).' }],
    createdAt: t(0),
    updatedAt: t(5000),
  };
  const paused: AgentTeamV109 = {
    id: 'team-mock-agui',
    name: 'agui-v2',
    goal: 'AG-UI generative UI v2: card, chart, suggester, fallback.',
    leadId: 'mate-agui-lead',
    defaultModel: 'mock',
    teammates: [
      { id: 'mate-agui-lead', name: 'lead', role: 'lead', status: 'idle', tasksDone: 0, tasksFailed: 0, createdAt: t(0), updatedAt: t(0) },
    ],
    tasks: [
      { id: 'task-chart', title: 'Chart component', status: 'pending', dependsOn: [], priority: 4, touchesFiles: ['packages/core/src/agui/genuiV2.ts'], attempts: 0, maxAttempts: 3, createdAt: t(0), updatedAt: t(0) },
    ],
    messages: [],
    config: { ...MOCK_TEAM_CONFIG },
    status: 'paused',
    events: [{ at: t(0), type: 'created', message: 'Team agui-v2 created (mock seed).' }],
    createdAt: t(0),
    updatedAt: t(0),
  };
  return [active, paused];
}

/**
 * Mock provider over the seed teams. Read-only; `source` is 'mock'
 * so every consumer can label the data honestly.
 */
export class MockTeamDashboardProvider implements TeamDashboardProvider {
  readonly source = 'mock';
  private readonly teams: AgentTeamV109[];

  constructor(teams: AgentTeamV109[] = seedMockTeams()) {
    // Deep-ish copy so callers cannot mutate the seed.
    this.teams = teams.map((team) => ({
      ...team,
      teammates: team.teammates.map((m) => ({ ...m })),
      tasks: team.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn], touchesFiles: [...t.touchesFiles] })),
      messages: team.messages.map((m) => ({ ...m })),
      config: { ...team.config },
      events: team.events.map((e) => ({ ...e })),
    }));
  }

  listTeams(): AgentTeamV109[] {
    return this.teams.map((team) => ({ ...team }));
  }

  getTeam(teamId: string): AgentTeamV109 | undefined {
    return this.teams.find((t) => t.id === teamId);
  }

  teammatesOf(teamId: string): Teammate[] {
    return this.getTeam(teamId)?.teammates.map((m) => ({ ...m })) ?? [];
  }

  tasksOf(teamId: string): TeamTask[] {
    return this.getTeam(teamId)?.tasks.map((t) => ({ ...t })) ?? [];
  }

  mailboxOf(teamId: string, teammateId?: string): MailboxMessage[] {
    const team = this.getTeam(teamId);
    if (!team) return [];
    if (!teammateId) return team.messages.map((m) => ({ ...m }));
    return team.messages
      .filter((m) => m.toId === teammateId || m.fromId === teammateId || m.toId === '*')
      .map((m) => ({ ...m }));
  }

  unreadCount(teamId: string, teammateId?: string): number {
    return this.mailboxOf(teamId, teammateId).filter((m) => !m.read && m.toId !== '*').length;
  }
}
