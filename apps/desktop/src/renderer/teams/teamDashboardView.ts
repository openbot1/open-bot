/**
 * Agent teams dashboard view models (v1.10, Đội T5 — dashboard teams).
 *
 * Renderer-local mirror of the core dashboard shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module owns
 * the view contract instead: defensive parsing of the IPC payloads
 * (`teams-dashboard:*` returns plain JSON), team cards, teammate
 * rows, task rows (filter + sort), mailbox rows and the summary
 * header. Pure functions, no React, no DOM, no IPC — unit-tested
 * with plain node --test (see tests/agui-v110.test.mjs).
 *
 * The data source is the dashboard provider interface in
 * packages/core/src/teams/dashboardV110.ts. Until Team T3 wires the
 * real teams v2 service, the provider is the mock — every view
 * carries `source: 'mock'` so the UI can label it honestly.
 */

/** Team status (same values as the core team types). */
export type TeamDashboardStatusView = 'active' | 'paused' | 'completed' | 'dissolved';

/** Teammate status. */
export type TeammateStatusView = 'idle' | 'working' | 'waiting' | 'blocked' | 'done' | 'failed';

/** Task status. */
export type TeamTaskStatusView = 'pending' | 'claimed' | 'in-progress' | 'done' | 'failed' | 'blocked';

/** Mailbox message kind. */
export type MailboxKindView = 'request' | 'result' | 'question' | 'broadcast';

/** One team card for the dashboard grid. */
export interface TeamCardView {
  id: string;
  name: string;
  goal: string;
  status: TeamDashboardStatusView;
  leadName: string;
  teammates: number;
  working: number;
  blocked: number;
  tasks: number;
  tasksDone: number;
  tasksBlocked: number;
  messages: number;
  unread: number;
  source: string;
}

/** One teammate row inside a team card. */
export interface TeammateRowView {
  id: string;
  name: string;
  role: string;
  specialty: string | null;
  model: string | null;
  status: TeammateStatusView;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  partition: string | null;
  tasksDone: number;
  tasksFailed: number;
}

/** One task row in the shared task list. */
export interface TeamTaskRowView {
  id: string;
  title: string;
  detail: string | null;
  status: TeamTaskStatusView;
  priority: number;
  claimedBy: string | null;
  claimedByName: string | null;
  blocked: boolean;
  dependsOn: string[];
  attempts: number;
  maxAttempts: number;
  resultSummary: string | null;
  error: string | null;
  staleClaim: boolean;
}

/** One mailbox row. */
export interface MailboxRowView {
  id: string;
  fromName: string;
  toName: string;
  kind: MailboxKindView;
  taskId: string | null;
  body: string;
  read: boolean;
  broadcast: boolean;
  createdAt: number;
}

/** Dashboard summary header. */
export interface TeamDashboardSummaryView {
  source: string;
  teams: number;
  activeTeams: number;
  teammates: number;
  workingTeammates: number;
  blockedTeammates: number;
  tasks: number;
  tasksByStatus: Record<TeamTaskStatusView, number>;
  blockedTasks: number;
  staleClaims: number;
  messages: number;
  unreadMessages: number;
  busiestTeammateName: string | null;
  busiestTeammateTasks: number;
}

/** i18n key for a team status. */
export function teamStatusLabelKey(status: TeamDashboardStatusView): string {
  return `teams.dashboard.status.${status}`;
}

/** i18n key for a teammate status. */
export function teammateStatusLabelKey(status: TeammateStatusView): string {
  return `teams.dashboard.teammate.${status}`;
}

/** i18n key for a task status. */
export function teamTaskStatusLabelKey(status: TeamTaskStatusView): string {
  return `teams.dashboard.task.${status}`;
}

/** i18n key for a mailbox kind. */
export function mailboxKindLabelKey(kind: MailboxKindView): string {
  return `teams.dashboard.mailbox.kind.${kind}`;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTeamStatus(value: unknown): TeamDashboardStatusView {
  return value === 'paused' || value === 'completed' || value === 'dissolved' ? value : 'active';
}

function parseTeammateStatus(value: unknown): TeammateStatusView {
  return value === 'working' || value === 'waiting' || value === 'blocked' || value === 'done' || value === 'failed'
    ? value
    : 'idle';
}

function parseTaskStatus(value: unknown): TeamTaskStatusView {
  return value === 'claimed' || value === 'in-progress' || value === 'done' || value === 'failed' || value === 'blocked'
    ? value
    : 'pending';
}

function parseMailboxKind(value: unknown): MailboxKindView {
  return value === 'result' || value === 'question' || value === 'broadcast' ? value : 'request';
}

const TASK_STATUSES: TeamTaskStatusView[] = ['pending', 'claimed', 'in-progress', 'done', 'failed', 'blocked'];

/** Parse one team card from an IPC payload (defensive). */
export function toTeamCardView(payload: unknown, source = 'mock'): TeamCardView | null {
  if (!isRecord(payload)) return null;
  const id = asString(payload['id']);
  if (id.length === 0) return null;
  const teammates = Array.isArray(payload['teammates']) ? payload['teammates'].filter(isRecord) : [];
  const tasks = Array.isArray(payload['tasks']) ? payload['tasks'].filter(isRecord) : [];
  const messages = Array.isArray(payload['messages']) ? payload['messages'].filter(isRecord) : [];
  const lead = teammates.find((m) => m['id'] === payload['leadId']);
  return {
    id,
    name: asString(payload['name'], id),
    goal: asString(payload['goal']),
    status: parseTeamStatus(payload['status']),
    leadName: lead ? asString(lead['name'], 'lead') : asString(payload['leadId'], 'lead'),
    teammates: teammates.length,
    working: teammates.filter((m) => m['status'] === 'working').length,
    blocked: teammates.filter((m) => m['status'] === 'blocked').length,
    tasks: tasks.length,
    tasksDone: tasks.filter((t) => t['status'] === 'done').length,
    tasksBlocked: tasks.filter((t) => t['status'] === 'blocked').length,
    messages: messages.length,
    unread: messages.filter((m) => m['read'] !== true && m['toId'] !== '*').length,
    source,
  };
}

/** Parse many team cards (skips unparseable entries). */
export function toTeamCardViews(payload: unknown, source = 'mock'): TeamCardView[] {
  if (!Array.isArray(payload)) return [];
  const cards: TeamCardView[] = [];
  for (const item of payload) {
    const card = toTeamCardView(item, source);
    if (card) cards.push(card);
  }
  return cards;
}

/** Parse teammate rows for one team (task titles resolved from the same payload). */
export function toTeammateRowViews(teamPayload: unknown): TeammateRowView[] {
  if (!isRecord(teamPayload)) return [];
  const teammates = Array.isArray(teamPayload['teammates']) ? teamPayload['teammates'].filter(isRecord) : [];
  const tasks = Array.isArray(teamPayload['tasks']) ? teamPayload['tasks'].filter(isRecord) : [];
  const titleOf = (taskId: string | null): string | null => {
    if (!taskId) return null;
    const task = tasks.find((t) => t['id'] === taskId);
    return task ? asString(task['title']) : null;
  };
  return teammates.map((m) => {
    const currentTaskId = typeof m['currentTaskId'] === 'string' ? m['currentTaskId'] : null;
    return {
      id: asString(m['id']),
      name: asString(m['name']),
      role: asString(m['role'], 'teammate'),
      specialty: typeof m['specialty'] === 'string' ? m['specialty'] : null,
      model: typeof m['model'] === 'string' ? m['model'] : null,
      status: parseTeammateStatus(m['status']),
      currentTaskId,
      currentTaskTitle: titleOf(currentTaskId),
      partition: typeof m['partition'] === 'string' ? m['partition'] : null,
      tasksDone: asNumber(m['tasksDone']),
      tasksFailed: asNumber(m['tasksFailed']),
    };
  });
}

/**
 * Parse task rows for one team. `filter` narrows by status;
 * `claimTimeoutMs` marks claims older than the timeout as stale.
 */
export function toTeamTaskRowViews(
  teamPayload: unknown,
  input?: { filter?: TeamTaskStatusView | 'all'; claimTimeoutMs?: number; nowMs?: number },
): TeamTaskRowView[] {
  if (!isRecord(teamPayload)) return [];
  const tasks = Array.isArray(teamPayload['tasks']) ? teamPayload['tasks'].filter(isRecord) : [];
  const teammates = Array.isArray(teamPayload['teammates']) ? teamPayload['teammates'].filter(isRecord) : [];
  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    const mate = teammates.find((m) => m['id'] === id);
    return mate ? asString(mate['name']) : id;
  };
  const filter = input?.filter ?? 'all';
  const claimTimeoutMs = input?.claimTimeoutMs ?? 10 * 60_000;
  const nowMs = input?.nowMs ?? Date.now();
  const rows: TeamTaskRowView[] = [];
  for (const t of tasks) {
    const status = parseTaskStatus(t['status']);
    if (filter !== 'all' && status !== filter) continue;
    const claimedBy = typeof t['claimedBy'] === 'string' ? t['claimedBy'] : null;
    const claimedAt = typeof t['claimedAt'] === 'number' ? t['claimedAt'] : null;
    rows.push({
      id: asString(t['id']),
      title: asString(t['title']),
      detail: typeof t['detail'] === 'string' ? t['detail'] : null,
      status,
      priority: asNumber(t['priority'], 1),
      claimedBy,
      claimedByName: nameOf(claimedBy),
      blocked: status === 'blocked',
      dependsOn: Array.isArray(t['dependsOn']) ? t['dependsOn'].filter((d): d is string => typeof d === 'string') : [],
      attempts: asNumber(t['attempts']),
      maxAttempts: asNumber(t['maxAttempts'], 3),
      resultSummary: typeof t['resultSummary'] === 'string' ? t['resultSummary'] : null,
      error: typeof t['error'] === 'string' ? t['error'] : null,
      staleClaim: status === 'claimed' && claimedAt !== null && nowMs - claimedAt > claimTimeoutMs,
    });
  }
  // Highest priority first, oldest first inside a priority.
  rows.sort((a, b) => b.priority - a.priority);
  return rows;
}

/** Parse mailbox rows for one team (or one teammate), newest first. */
export function toMailboxRowViews(teamPayload: unknown, teammateId?: string): MailboxRowView[] {
  if (!isRecord(teamPayload)) return [];
  const teammates = Array.isArray(teamPayload['teammates']) ? teamPayload['teammates'].filter(isRecord) : [];
  const nameOf = (id: string): string => {
    if (id === '*') return '*';
    const mate = teammates.find((m) => m['id'] === id);
    return mate ? asString(mate['name'], id) : id;
  };
  const messages = Array.isArray(teamPayload['messages']) ? teamPayload['messages'].filter(isRecord) : [];
  const rows: MailboxRowView[] = [];
  for (const m of messages) {
    const toId = asString(m['toId']);
    const fromId = asString(m['fromId']);
    if (teammateId && toId !== teammateId && fromId !== teammateId && toId !== '*') continue;
    rows.push({
      id: asString(m['id']),
      fromName: asString(m['fromName'], nameOf(fromId)),
      toName: toId === '*' ? '*' : asString(m['toName'], nameOf(toId)),
      kind: parseMailboxKind(m['kind']),
      taskId: typeof m['taskId'] === 'string' ? m['taskId'] : null,
      body: asString(m['body']),
      read: asBoolean(m['read']),
      broadcast: toId === '*',
      createdAt: asNumber(m['createdAt']),
    });
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}

/** Parse a dashboard summary payload for the header. */
export function toTeamDashboardSummaryView(payload: unknown): TeamDashboardSummaryView | null {
  if (!isRecord(payload)) return null;
  const byStatus = isRecord(payload['tasksByStatus']) ? payload['tasksByStatus'] : {};
  const tasksByStatus = Object.fromEntries(
    TASK_STATUSES.map((s) => [s, asNumber(byStatus[s])]),
  ) as Record<TeamTaskStatusView, number>;
  const busiest = isRecord(payload['busiestTeammate']) ? payload['busiestTeammate'] : null;
  return {
    source: asString(payload['source'], 'mock'),
    teams: asNumber(payload['teams']),
    activeTeams: asNumber(payload['activeTeams']),
    teammates: asNumber(payload['teammates']),
    workingTeammates: asNumber(payload['workingTeammates']),
    blockedTeammates: asNumber(payload['blockedTeammates']),
    tasks: asNumber(payload['tasks']),
    tasksByStatus,
    blockedTasks: asNumber(payload['blockedTasks']),
    staleClaims: asNumber(payload['staleClaims']),
    messages: asNumber(payload['messages']),
    unreadMessages: asNumber(payload['unreadMessages']),
    busiestTeammateName: busiest ? asString(busiest['name']) : null,
    busiestTeammateTasks: busiest ? asNumber(busiest['tasksDone']) : 0,
  };
}

/** One-line summary for a team card (for the grid + a11y). */
export function teamCardSummary(card: TeamCardView): string {
  return `${card.name}: ${card.status}, ${card.teammates} teammates (${card.working} working), ${card.tasks} tasks (${card.tasksDone} done), ${card.unread} unread`;
}
