/**
 * Tests for v1.10 — AG-UI generative UI v2 + agent teams dashboard (Team T5).
 *
 *   1. AG-UI v2 (genuiV2.ts): card/chart validation, the
 *      context-driven suggester (numbers -> chart, rows -> table,
 *      choices -> options, key-values -> card, inputs -> form,
 *      confirm/message/progress), capability negotiation with
 *      fallback (chart -> table, card -> message, table -> message,
 *      progress -> message; interactive kinds have no fallback),
 *      v2 registry lifecycle (request/answer/dismiss/expire, no
 *      double answer), markdown.
 *   2. Teams dashboard (dashboardV110.ts): provider interface +
 *      mock provider (seed data), summary aggregation (stale
 *      claims, blocked, unread), task/mailbox helpers, markdown.
 *   3. Dashboard view models (teamDashboardView.ts): team cards,
 *      teammate/task/mailbox rows, filters, sort, summary view.
 *   4. AG-UI v2 tools (aguiV2Tools.ts): 6 tools, unique names,
 *      placeholder refuses, suggest/validate/request/answer/
 *      pending/capabilities through the tools.
 *   5. Dashboard tools (teamsDashboardTools.ts): 5 tools, unique
 *      names, placeholder refuses, summary/list/team/tasks/
 *      mailbox through the tools on the mock provider.
 *   6. i18n: agui.v2.* + teams.dashboard.* keys in all 6 locales,
 *      non-empty, placeholders match en.
 *
 * No network, no sound card. Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/agui-v110.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgUiV2Registry,
  AG_UI_V2_KINDS,
  isAgUiV2Kind,
  validateAgUiV2Request,
  validateAgUiV2Response,
  suggestAgUiV2Component,
  negotiateAgUiV2,
  agUiV2RequestMarkdown,
  agUiV2Summary,
} from '../packages/core/dist/agui/genuiV2.js';
import {
  MockTeamDashboardProvider,
  summarizeTeamDashboard,
  dashboardTasksForTeam,
  dashboardMailboxForTeam,
  teamDashboardMarkdown,
  teamDashboardSummaryMarkdown,
  seedMockTeams,
  TEAM_DASHBOARD_TASK_STATUSES,
} from '../packages/core/dist/teams/dashboardV110.js';
import {
  createAguiV2Tools,
  AGUI_V2_TOOLS,
  AGUI_V2_TOOL_NAMES,
  isAguiV2ToolName,
  AGUI_V2_DEFAULT_CAPABILITIES,
} from '../packages/tools/dist/aguiV2Tools.js';
import {
  createTeamsDashboardTools,
  TEAMS_DASHBOARD_TOOLS,
  TEAMS_DASHBOARD_TOOL_NAMES,
  isTeamsDashboardToolName,
} from '../packages/tools/dist/teamsDashboardTools.js';
import {
  toTeamCardView,
  toTeamCardViews,
  toTeammateRowViews,
  toTeamTaskRowViews,
  toMailboxRowViews,
  toTeamDashboardSummaryView,
  teamStatusLabelKey,
  teammateStatusLabelKey,
  teamTaskStatusLabelKey,
  mailboxKindLabelKey,
  teamCardSummary,
} from '../apps/desktop/src/renderer/teams/teamDashboardView.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const V110_AGUI_KEYS = [
  'agui.v2.kind.card',
  'agui.v2.kind.chart',
  'agui.v2.kind.form',
  'agui.v2.kind.table',
  'agui.v2.kind.options',
  'agui.v2.kind.confirm',
  'agui.v2.kind.message',
  'agui.v2.kind.progress',
  'agui.v2.suggest.chart',
  'agui.v2.suggest.table',
  'agui.v2.suggest.card',
  'agui.v2.suggest.form',
  'agui.v2.suggest.options',
  'agui.v2.suggest.message',
  'agui.v2.fallback.applied',
  'agui.v2.fallback.unsupported',
  'agui.v2.answer.submitted',
  'agui.v2.answer.dismissed',
  'agui.v2.answer.expired',
];

const V110_DASHBOARD_KEYS = [
  'teams.dashboard.title',
  'teams.dashboard.summary',
  'teams.dashboard.teams',
  'teams.dashboard.teammates',
  'teams.dashboard.tasks',
  'teams.dashboard.mailbox',
  'teams.dashboard.status.active',
  'teams.dashboard.status.paused',
  'teams.dashboard.status.completed',
  'teams.dashboard.status.dissolved',
  'teams.dashboard.task.pending',
  'teams.dashboard.task.claimed',
  'teams.dashboard.task.in-progress',
  'teams.dashboard.task.done',
  'teams.dashboard.task.failed',
  'teams.dashboard.task.blocked',
  'teams.dashboard.teammate.idle',
  'teams.dashboard.teammate.working',
  'teams.dashboard.teammate.waiting',
  'teams.dashboard.teammate.blocked',
  'teams.dashboard.teammate.done',
  'teams.dashboard.teammate.failed',
  'teams.dashboard.mailbox.unread',
  'teams.dashboard.mailbox.empty',
  'teams.dashboard.mailbox.kind.request',
  'teams.dashboard.mailbox.kind.result',
  'teams.dashboard.mailbox.kind.question',
  'teams.dashboard.mailbox.kind.broadcast',
];

// ------------------------------------------------------------- validation v2

test('genui v2: card and chart validate, bad shapes rejected', () => {
  assert.equal(isAgUiV2Kind('card'), true);
  assert.equal(isAgUiV2Kind('chart'), true);
  assert.equal(isAgUiV2Kind('video'), false);
  assert.deepEqual(AG_UI_V2_KINDS, ['confirm', 'options', 'form', 'table', 'progress', 'message', 'card', 'chart']);
  const card = validateAgUiV2Request(
    {
      componentId: 'c1', kind: 'card', title: 'Deploy summary',
      props: {
        headline: 'v1.10 ready',
        body: 'All green.',
        fields: [{ label: 'Tests', value: '6203 pass' }],
        actions: [{ id: 'deploy', label: 'Deploy', kind: 'primary' }],
      },
    },
    'run-1',
  );
  assert.equal(card.kind, 'card');
  assert.equal(card.props.fields[0].label, 'Tests');
  const chart = validateAgUiV2Request(
    {
      componentId: 'c2', kind: 'chart', title: 'Lines per wave',
      props: { chartType: 'bar', series: [{ name: 'lines', points: [{ label: 'v1.09', value: 23768 }, { label: 'v1.10', value: 5000 }] }] },
    },
    'run-1',
  );
  assert.equal(chart.props.chartType, 'bar');
  assert.throws(
    () => validateAgUiV2Request({ componentId: 'c3', kind: 'chart', title: 'x', props: { chartType: 'pie', series: [{ name: 'a', points: [{ label: 'x', value: 1 }] }, { name: 'b', points: [{ label: 'x', value: 2 }] }] } }, 'run-1'),
    /pie.*exactly one series/,
  );
  assert.throws(
    () => validateAgUiV2Request({ componentId: 'c4', kind: 'card', title: 'x', props: { body: 'ok', actions: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A2' }] } }, 'run-1'),
    /repeat id/,
  );
  assert.throws(
    () => validateAgUiV2Request({ componentId: 'c5', kind: 'card', title: 'x', props: { body: '<script>alert(1)</script>' } }, 'run-1'),
    /scripts/,
  );
  assert.throws(
    () => validateAgUiV2Request({ componentId: 'c6', kind: 'chart', title: 'x', props: { chartType: 'bar', series: [{ name: 'a', points: [{ label: 'x', value: NaN }] }] } }, 'run-1'),
    /finite number/,
  );
  assert.throws(() => validateAgUiV2Request({ componentId: 'c7', kind: 'video', title: 'x', props: {} }, 'run-1'), /known component kind/);
  // v1 kinds still validate through the v2 entry point.
  const table = validateAgUiV2Request(
    { componentId: 'c8', kind: 'table', title: 'T', props: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] } },
    'run-1',
  );
  assert.equal(table.kind, 'table');
});

test('genui v2: suggester maps every context to exactly one kind', () => {
  const base = { componentId: 's1', title: 'S', runId: 'run-1' };
  const chart = suggestAgUiV2Component({ ...base, context: { kind: 'numbers', series: [{ name: 'lines', points: [{ label: 'v1.09', value: 1 }, { label: 'v1.10', value: 2 }] }] } });
  assert.equal(chart.request.kind, 'chart');
  assert.equal(chart.confidence, 1);
  assert.ok(chart.reason.includes('chart'));
  const table = suggestAgUiV2Component({ ...base, context: { kind: 'rows', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] } });
  assert.equal(table.request.kind, 'table');
  const options = suggestAgUiV2Component({ ...base, context: { kind: 'choices', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } });
  assert.equal(options.request.kind, 'options');
  const card = suggestAgUiV2Component({ ...base, context: { kind: 'keyValues', body: 'Summary', fields: [{ label: 'K', value: 'V' }], actions: [{ id: 'ok', label: 'OK' }] } });
  assert.equal(card.request.kind, 'card');
  const form = suggestAgUiV2Component({ ...base, context: { kind: 'inputs', fields: [{ name: 'x', label: 'X', type: 'text' }] } });
  assert.equal(form.request.kind, 'form');
  const confirm = suggestAgUiV2Component({ ...base, context: { kind: 'confirm', summary: 'Deploy?' } });
  assert.equal(confirm.request.kind, 'confirm');
  const message = suggestAgUiV2Component({ ...base, context: { kind: 'message', body: 'Hello', tone: 'info' } });
  assert.equal(message.request.kind, 'message');
  const progress = suggestAgUiV2Component({ ...base, context: { kind: 'progress', value: 0.5, label: 'Half' } });
  assert.equal(progress.request.kind, 'progress');
  assert.equal(progress.request.props.value, 0.5);
  // A single small series suggests a pie chart by default.
  const pie = suggestAgUiV2Component({ ...base, context: { kind: 'numbers', series: [{ name: 'share', points: [{ label: 'a', value: 3 }, { label: 'b', value: 1 }] }] } });
  assert.equal(pie.request.props.chartType, 'pie');
});

test('genui v2: negotiation falls back with data kept, interactive kinds have no fallback', () => {
  const full = { kinds: ['confirm', 'options', 'form', 'table', 'progress', 'message', 'card', 'chart'], interactive: true };
  const chart = validateAgUiV2Request(
    { componentId: 'n1', kind: 'chart', title: 'T', props: { chartType: 'bar', series: [{ name: 's', points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }] } },
    'run-1',
  );
  assert.deepEqual(negotiateAgUiV2(chart, full), { renderable: true, effective: chart });
  const noChart = negotiateAgUiV2(chart, { kinds: ['table', 'message'], interactive: true });
  assert.equal(noChart.renderable, true);
  assert.equal(noChart.effective.kind, 'table');
  assert.deepEqual(noChart.fallbackApplied.from, 'chart');
  assert.equal(noChart.fallbackApplied.to, 'table');
  assert.equal(noChart.effective.props.rows.length, 2);
  assert.equal(noChart.effective.props.rows[0].s, 1);

  const card = validateAgUiV2Request(
    { componentId: 'n2', kind: 'card', title: 'T', props: { body: 'Body', fields: [{ label: 'K', value: 'V' }] } },
    'run-1',
  );
  const cardFallback = negotiateAgUiV2(card, { kinds: ['message'], interactive: true });
  assert.equal(cardFallback.effective.kind, 'message');
  assert.ok(cardFallback.effective.props.body.includes('K: V'));

  const table = validateAgUiV2Request(
    { componentId: 'n3', kind: 'table', title: 'T', props: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] } },
    'run-1',
  );
  assert.equal(negotiateAgUiV2(table, { kinds: ['message'], interactive: true }).effective.kind, 'message');

  const confirm = validateAgUiV2Request({ componentId: 'n4', kind: 'confirm', title: 'T', props: {} }, 'run-1');
  const noConfirm = negotiateAgUiV2(confirm, { kinds: ['message'], interactive: true });
  assert.equal(noConfirm.renderable, false);
  assert.ok(noConfirm.reason.includes('no safe fallback'));
  const nonInteractive = negotiateAgUiV2(confirm, { kinds: ['confirm'], interactive: false });
  assert.equal(nonInteractive.renderable, false);
  assert.ok(nonInteractive.reason.includes('interactive=false'));
});

test('genui v2: registry lifecycle — request, answer, dismiss, expire, no double answer', () => {
  const registry = new AgUiV2Registry({ ttlMs: 1000 });
  const card = validateAgUiV2Request(
    { componentId: 'r1', kind: 'card', title: 'T', props: { body: 'B', actions: [{ id: 'save', label: 'Save' }] } },
    'run-1',
  );
  const record = registry.request(card);
  assert.equal(record.status, 'requested');
  assert.equal(registry.size, 1);
  assert.equal(registry.pendingForRun('run-1').length, 1);
  // A wrong card action is rejected.
  assert.throws(() => registry.answer('r1', { action: 'explode' }), /not one of/);
  const answered = registry.answer('r1', { action: 'save' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.action, 'save');
  assert.throws(() => registry.answer('r1', { action: 'save' }), /already answered/);

  // Chart answers only dismiss/acknowledge.
  const chart = validateAgUiV2Request(
    { componentId: 'r2', kind: 'chart', title: 'T', props: { chartType: 'bar', series: [{ name: 's', points: [{ label: 'a', value: 1 }] }] } },
    'run-1',
  );
  registry.request(chart);
  assert.throws(() => registry.answer('r2', { action: 'save' }), /dismiss.*acknowledge/);
  const dismissed = registry.answer('r2', { action: 'dismiss' });
  assert.equal(dismissed.status, 'dismissed');

  // v1 kinds flow through the same registry.
  const form = validateAgUiV2Request(
    { componentId: 'r3', kind: 'form', title: 'T', props: { fields: [{ name: 'x', label: 'X', type: 'text', required: true }] } },
    'run-1',
  );
  registry.request(form);
  const formAnswered = registry.answer('r3', { componentId: 'r3', response: { x: 'hello' }, action: 'submit' });
  assert.equal(formAnswered.status, 'answered');
  assert.equal(formAnswered.response.x, 'hello');
  assert.throws(() => registry.answer('r3', { componentId: 'r3', response: { x: 'again' } }), /already answered/);

  // Dismiss + expire.
  const msg = validateAgUiV2Request({ componentId: 'r4', kind: 'message', title: 'T', props: { body: 'hi' } }, 'run-1');
  registry.request(msg);
  assert.equal(registry.dismiss('r4').status, 'dismissed');
  const stale = validateAgUiV2Request({ componentId: 'r5', kind: 'message', title: 'T', props: { body: 'old' } }, 'run-1');
  registry.request(stale);
  const expired = registry.expire(Date.now() + 60_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].request.componentId, 'r5');
  assert.equal(expired[0].status, 'expired');
  assert.equal(registry.forRun('run-1').length, 5);
  assert.ok(agUiV2Summary(registry.forRun('run-1')).includes('5 components'));
  assert.ok(agUiV2RequestMarkdown(card).includes('Deploy') === false);
  assert.ok(agUiV2RequestMarkdown(card).includes('(card)'));

  // Unknown component ids are rejected.
  assert.throws(() => registry.answer('nope', { action: 'dismiss' }), /No generative UI/);
  assert.throws(() => registry.dismiss('nope'), /No generative UI/);
  // validateAgUiV2Response directly: card action must be offered.
  assert.deepEqual(validateAgUiV2Response({ action: 'dismiss' }, card), { action: 'dismiss', response: { action: 'dismiss' } });
  registry.clearRun('run-1');
  assert.equal(registry.pendingForRun('run-1').length, 0);
  registry.clearAll();
  assert.equal(registry.size, 0);
});

test('genui v2: request applies capability negotiation and records the fallback', () => {
  const registry = new AgUiV2Registry();
  const chart = validateAgUiV2Request(
    { componentId: 'f1', kind: 'chart', title: 'T', props: { chartType: 'bar', series: [{ name: 's', points: [{ label: 'a', value: 1 }] }] } },
    'run-1',
  );
  const record = registry.request(chart, { kinds: ['table', 'message'], interactive: true });
  assert.equal(record.request.kind, 'table');
  assert.equal(record.fallback.from, 'chart');
  assert.equal(record.fallback.to, 'table');
  assert.throws(
    () => registry.request(
      validateAgUiV2Request({ componentId: 'f2', kind: 'confirm', title: 'T', props: {} }, 'run-1'),
      { kinds: ['message'], interactive: true },
    ),
    /no safe fallback/,
  );
});

// ------------------------------------------------------------- dashboard core

test('dashboard: mock provider serves the seed teams, summary aggregates', () => {
  const provider = new MockTeamDashboardProvider();
  assert.equal(provider.source, 'mock');
  const teams = provider.listTeams();
  assert.equal(teams.length, 2);
  assert.equal(teams[0].name, 'voice-v5');
  assert.equal(teams[1].status, 'paused');
  assert.equal(provider.getTeam('team-mock-voice')?.goal.includes('voice v5'), true);
  assert.equal(provider.getTeam('nope'), undefined);
  assert.equal(provider.teammatesOf('team-mock-voice').length, 3);
  assert.equal(provider.tasksOf('team-mock-voice').length, 5);
  assert.equal(provider.mailboxOf('team-mock-voice').length, 4);
  assert.equal(provider.mailboxOf('team-mock-voice', 'mate-vad').length, 4, 'broadcasts + own mail');
  assert.equal(provider.unreadCount('team-mock-voice'), 1, 'broadcasts do not count as unread');
  assert.equal(provider.unreadCount('team-mock-voice', 'mate-lead'), 1, 'the question to lead is unread');
  assert.deepEqual(provider.teammatesOf('nope'), []);
  assert.deepEqual(provider.tasksOf('nope'), []);

  const summary = summarizeTeamDashboard(provider, 1_700_000_000_000 + 10 * 60_000);
  assert.equal(summary.source, 'mock');
  assert.equal(summary.teams, 2);
  assert.equal(summary.activeTeams, 1);
  assert.equal(summary.teammates, 4);
  assert.equal(summary.workingTeammates, 2);
  assert.equal(summary.tasks, 6);
  assert.deepEqual(summary.tasksByStatus, {
    pending: 2, claimed: 1, 'in-progress': 1, done: 1, failed: 0, blocked: 1,
  });
  assert.equal(summary.blockedTasks, 1);
  assert.equal(summary.staleClaims, 0, 'claims are fresh at base+10min');
  assert.equal(summary.unreadMessages, 1);
  assert.equal(summary.busiestTeammate.name, 'vad');
  assert.equal(summary.busiestTeammate.tasksDone, 3);
  assert.ok(teamDashboardSummaryMarkdown(summary).includes('Agent teams dashboard (mock)'));

  // A claim older than the timeout counts as stale (only the
  // 'claimed' task counts — 'in-progress' tasks already started).
  const stale = summarizeTeamDashboard(provider, 1_700_000_000_000 + 60 * 60_000);
  assert.equal(stale.staleClaims, 1, 'the claimed task is stale after an hour');
  assert.deepEqual(Object.keys(summary.tasksByStatus).sort(), [...TEAM_DASHBOARD_TASK_STATUSES].sort());
});

test('dashboard: task/mailbox helpers filter and sort', () => {
  const provider = new MockTeamDashboardProvider();
  const pending = dashboardTasksForTeam(provider, 'team-mock-voice', 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'task-tools');
  const all = dashboardTasksForTeam(provider, 'team-mock-voice');
  assert.equal(all.length, 5);
  assert.equal(all[0].priority, 5, 'highest priority first');
  assert.equal(all[0].id, 'task-vad');
  const mail = dashboardMailboxForTeam(provider, 'team-mock-voice');
  assert.equal(mail.length, 4);
  assert.equal(mail[0].id, 'msg-4', 'newest first');
  const mine = dashboardMailboxForTeam(provider, 'team-mock-voice', 'mate-vad');
  assert.equal(mine.length, 4);
  const md = teamDashboardMarkdown(provider.getTeam('team-mock-voice'));
  assert.ok(md.includes('## Team voice-v5 (active)'));
  assert.ok(md.includes('Lead: lead'));
  assert.deepEqual(seedMockTeams().length, 2);
});

// ------------------------------------------------------------- dashboard views

test('dashboard view: team cards, teammate/task/mailbox rows, summary view', () => {
  const provider = new MockTeamDashboardProvider();
  const team = provider.getTeam('team-mock-voice');
  const card = toTeamCardView(team, 'mock');
  assert.ok(card);
  assert.equal(card.name, 'voice-v5');
  assert.equal(card.status, 'active');
  assert.equal(card.leadName, 'lead');
  assert.equal(card.teammates, 3);
  assert.equal(card.working, 2);
  assert.equal(card.tasks, 5);
  assert.equal(card.tasksDone, 1);
  assert.equal(card.tasksBlocked, 1);
  assert.equal(card.unread, 1);
  assert.equal(card.source, 'mock');
  assert.ok(teamCardSummary(card).includes('voice-v5: active'));
  assert.equal(toTeamCardView(null), null);
  assert.equal(toTeamCardView({}), null);
  assert.equal(toTeamCardViews(provider.listTeams(), 'mock').length, 2);
  assert.equal(toTeamCardViews('nope').length, 0);

  const mates = toTeammateRowViews(team);
  assert.equal(mates.length, 3);
  assert.equal(mates[0].role, 'lead');
  assert.equal(mates[1].currentTaskTitle, 'Mock VAD v9');
  assert.equal(mates[1].partition, 'src/voice/');
  assert.equal(mates[2].status, 'idle');

  const rows = toTeamTaskRowViews(team, { nowMs: 1_700_000_000_000 + 60 * 60_000 });
  assert.equal(rows.length, 5);
  assert.equal(rows[0].id, 'task-vad');
  assert.equal(rows[0].claimedByName, 'vad');
  assert.equal(rows.find((r) => r.id === 'task-barge').staleClaim, true);
  assert.equal(rows.find((r) => r.id === 'task-blocked').error, 'No live key in Vault — mock only.');
  const done = toTeamTaskRowViews(team, { filter: 'done' });
  assert.deepEqual(done.map((r) => r.id), ['task-transcript']);
  assert.deepEqual(toTeamTaskRowViews(null), []);

  const mail = toMailboxRowViews(team);
  assert.equal(mail.length, 4);
  assert.equal(mail[0].broadcast, true);
  assert.equal(mail[0].kind, 'broadcast');
  assert.equal(mail[1].fromName, 'vad');
  const mine = toMailboxRowViews(team, 'mate-vad');
  assert.equal(mine.length, 4);

  const summary = toTeamDashboardSummaryView(summarizeTeamDashboard(provider, 1_700_000_000_000 + 10 * 60_000));
  assert.ok(summary);
  assert.equal(summary.teams, 2);
  assert.equal(summary.tasksByStatus.done, 1);
  assert.equal(summary.busiestTeammateName, 'vad');
  assert.equal(toTeamDashboardSummaryView(null), null);

  assert.equal(teamStatusLabelKey('paused'), 'teams.dashboard.status.paused');
  assert.equal(teammateStatusLabelKey('working'), 'teams.dashboard.teammate.working');
  assert.equal(teamTaskStatusLabelKey('in-progress'), 'teams.dashboard.task.in-progress');
  assert.equal(mailboxKindLabelKey('question'), 'teams.dashboard.mailbox.kind.question');
});

// ------------------------------------------------------------- tools

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function runTool(tools, name, args = {}) {
  return JSON.parse(await toolByName(tools, name).execute(args));
}

test('tools agui v2: 6 tools, unique names, placeholder refuses without a registry', async () => {
  assert.equal(AGUI_V2_TOOLS.length, 6);
  assert.deepEqual([...AGUI_V2_TOOL_NAMES].sort(), AGUI_V2_TOOLS.map((t) => t.definition.name).sort());
  assert.equal(new Set(AGUI_V2_TOOL_NAMES).size, 6);
  assert.equal(isAguiV2ToolName('agui_v2_suggest'), true);
  assert.equal(isAguiV2ToolName('agui_v2_request'), true);
  assert.equal(isAguiV2ToolName('agui_v2_nope'), false);
  assert.deepEqual(AGUI_V2_DEFAULT_CAPABILITIES.kinds, ['confirm', 'options', 'form', 'table', 'progress', 'message', 'card', 'chart']);
  // The placeholder binds a throwaway registry on first use, so
  // suggest works but request/answer use that same throwaway one.
  const out = await runTool(AGUI_V2_TOOLS, 'agui_v2_capabilities');
  assert.equal(out.capabilities.interactive, true);
});

test('tools agui v2: suggest/validate/request/answer/pending through the tools', async () => {
  const tools = createAguiV2Tools({});
  const suggested = await runTool(tools, 'agui_v2_suggest', {
    componentId: 's1', title: 'Lines', runId: 'run-9',
    context: { kind: 'numbers', series: [{ name: 'lines', points: [{ label: 'v1.09', value: 1 }, { label: 'v1.10', value: 2 }] }] },
  });
  assert.equal(suggested.suggestion.request.kind, 'chart');
  assert.ok(suggested.suggestion.reason.includes('chart'));

  const validated = await runTool(tools, 'agui_v2_validate', {
    componentId: 's2', kind: 'chart', title: 'T', runId: 'run-9',
    props: { chartType: 'bar', series: [{ name: 's', points: [{ label: 'a', value: 1 }] }] },
    capabilities: { kinds: ['table', 'message'], interactive: true },
  });
  assert.equal(validated.negotiation.effective.kind, 'table');
  assert.equal(validated.negotiation.fallbackApplied.from, 'chart');

  const requested = await runTool(tools, 'agui_v2_request', {
    componentId: 's3', kind: 'card', title: 'Summary', runId: 'run-9',
    props: { body: 'All green.', actions: [{ id: 'deploy', label: 'Deploy' }] },
  });
  assert.equal(requested.record.request.kind, 'card');
  assert.equal(requested.record.status, 'requested');
  const pending = await runTool(tools, 'agui_v2_pending', { runId: 'run-9' });
  assert.equal(pending.count, 1);
  const answered = await runTool(tools, 'agui_v2_answer', {
    componentId: 's3', response: { action: 'deploy' }, action: 'deploy',
  });
  assert.equal(answered.record.status, 'answered');
  assert.equal(answered.record.action, 'deploy');
  const pendingAfter = await runTool(tools, 'agui_v2_pending', { runId: 'run-9' });
  assert.equal(pendingAfter.count, 0);

  // Errors are returned, not thrown.
  const bad = await toolByName(tools, 'agui_v2_validate').execute({
    componentId: 's4', kind: 'video', title: 'T', runId: 'run-9', props: {},
  });
  assert.ok(bad.startsWith('Error:'));
  const missing = await toolByName(tools, 'agui_v2_answer').execute({ componentId: 'nope', response: {} });
  assert.ok(missing.startsWith('Error: No generative UI'));
});

test('tools dashboard: 5 tools, unique names, mock summary/list/team/tasks/mailbox', async () => {
  assert.equal(TEAMS_DASHBOARD_TOOLS.length, 5);
  assert.deepEqual([...TEAMS_DASHBOARD_TOOL_NAMES].sort(), TEAMS_DASHBOARD_TOOLS.map((t) => t.definition.name).sort());
  assert.equal(new Set(TEAMS_DASHBOARD_TOOL_NAMES).size, 5);
  assert.equal(isTeamsDashboardToolName('teams_dashboard_summary'), true);
  assert.equal(isTeamsDashboardToolName('teams_dashboard_nope'), false);

  const tools = createTeamsDashboardTools({});
  const summary = await runTool(tools, 'teams_dashboard_summary');
  assert.equal(summary.summary.source, 'mock');
  assert.equal(summary.summary.teams, 2);
  assert.equal(summary.summary.tasks, 6);
  assert.ok(summary.markdown.includes('Agent teams dashboard (mock)'));

  const listed = await runTool(tools, 'teams_dashboard_list');
  assert.equal(listed.count, 2);
  assert.equal(listed.teams[0].name, 'voice-v5');
  assert.equal(listed.teams[0].unread, 1);

  const team = await runTool(tools, 'teams_dashboard_team', { teamId: 'team-mock-voice' });
  assert.equal(team.team.name, 'voice-v5');
  assert.equal(team.team.teammates.length, 3);
  assert.ok(team.markdown.includes('## Team voice-v5'));

  const tasks = await runTool(tools, 'teams_dashboard_tasks', { teamId: 'team-mock-voice' });
  assert.equal(tasks.count, 5);
  assert.equal(tasks.tasks[0].priority, 5);
  const blocked = await runTool(tools, 'teams_dashboard_tasks', { teamId: 'team-mock-voice', status: 'blocked' });
  assert.deepEqual(blocked.tasks.map((t) => t.id), ['task-blocked']);

  const mail = await runTool(tools, 'teams_dashboard_mailbox', { teamId: 'team-mock-voice' });
  assert.equal(mail.count, 4);
  assert.equal(mail.messages[0].id, 'msg-4');
  const mine = await runTool(tools, 'teams_dashboard_mailbox', { teamId: 'team-mock-voice', teammateId: 'mate-lead' });
  assert.ok(mine.count >= 1);

  // Errors are returned, not thrown.
  const missing = await toolByName(tools, 'teams_dashboard_team').execute({ teamId: 'nope' });
  assert.ok(missing.startsWith('Error: Unknown team'));
  const badStatus = await toolByName(tools, 'teams_dashboard_tasks').execute({ teamId: 'team-mock-voice', status: 'loud' });
  assert.ok(badStatus.startsWith('Error: Unknown task status'));
});

// ------------------------------------------------------------- i18n

function placeholders(text) {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

test('i18n v1.10: agui.v2.* + teams.dashboard.* keys in all 6 locales, placeholders match en', () => {
  const localesDir = path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales');
  const names = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];
  const locales = Object.fromEntries(
    names.map((name) => [name, JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf-8'))]),
  );
  const counts = names.map((name) => Object.keys(locales[name]).length);
  assert.ok(counts.every((c) => c === counts[0]), `locales must agree on key count, got ${counts.join(', ')}`);
  for (const key of [...V110_AGUI_KEYS, ...V110_DASHBOARD_KEYS]) {
    for (const name of names) {
      const value = locales[name][key];
      assert.equal(typeof value, 'string', `${key} missing in ${name}`);
      assert.ok(value.trim().length > 0, `${key} empty in ${name}`);
      assert.deepEqual(placeholders(value), placeholders(locales.en[key]), `${key} placeholders differ in ${name}`);
    }
  }
});
