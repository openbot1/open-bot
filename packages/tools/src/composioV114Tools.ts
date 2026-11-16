/**
 * Composio v114 tools (v1.14, Doi T4) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * Composio mock toolkits v114 (2):
 * - `composio_mock_toolkit_list_v114` — liet ke 6 toolkit Composio
 *   MOCK v114 (webflow/pipedrive/chargebee/xero/eventbrite/
 *   surveymonkey) + slug ung vien + cach xac thuc tung toolkit.
 *   Chay duoc ngay, khong can key.
 * - `composio_mock_toolkit_execute_v114` — chay mot tool mock bang
 *   du lieu mau local (khong goi mang, khong can key). Response
 *   luon mang `mock: true, live: false`.
 *
 * Poll scheduler v2 (1):
 * - `composio_poll_schedule_v2` — tinh lich poll ke tiep cho mot
 *   connection (theo outcome hit/miss/error: thanh cong reset
 *   ve base, loi thi backoff theo cap so nhan) + dedupe item moi
 *   theo id da thay + checkpoint (de resume sau restart). Ham
 *   thuan — chay duoc ngay ca khi chua bind.
 *
 * Connection health dashboard (1):
 * - `composio_connection_health` — danh gia suc khoe mot hoac
 *   nhieu connection tu so lieu sync (tong poll/loi, latency,
 *   lan sync cuoi, han het han): trang thai healthy/degraded/
 *   unhealthy/expired/unknown + canh bao. Ham thuan.
 *
 * Trigger templates v2 (1):
 * - `composio_trigger_templates` — tim template trigger v114
 *   (35 template: 29 curated + 6 candidate) theo toolkit/
 *   category/tu khoa, tra schema field + vi du payload. Ham thuan.
 *
 * MCP Apps/Tasks bridge (1):
 * - `composio_mcp_app_open` — mo MCP App cho mot tool mock v114
 *   (tra app URI `ui://composio/...` + HTML tinh an toan + task
 *   mock da chay xong voi ket qua mau). Chi client goi mock —
 *   khong goi mang, khong can key.
 *
 * Tat ca 6 tool la ham thuan — chay duoc ngay ca khi chua bind,
 * khong doc/ghi file, khong can Composio API key.
 */

import type { Tool } from '@open-bot/core';
import {
  COMPOSIO_V114_MOCK_TOOLKITS,
  COMPOSIO_V114_TRIGGER_TEMPLATES,
  MockComposioV114Executor,
  checkpointComposioV114Schedule,
  composioV114BackoffDelayMs,
  composioV114MsUntilNextPoll,
  createComposioV114McpApp,
  createComposioV114Schedule,
  emptyComposioV114ConnectionHealth,
  evaluateComposioV114Health,
  executeMockComposioV114ToolViaApp,
  filterComposioV114NewItems,
  findComposioV114TriggerTemplate,
  isComposioV114McpAppUri,
  mockComposioV114ToolNeedsApproval,
  nextComposioV114PollAfterError,
  nextComposioV114PollAfterSuccess,
  recordComposioV114SyncError,
  recordComposioV114SyncSuccess,
  resumeComposioV114Schedule,
  searchComposioV114TriggerTemplates,
  summarizeComposioV114HealthDashboard,
  summarizeMockComposioV114Catalogue,
  validateComposioV114Checkpoint,
  validateComposioV114TriggerTemplates,
  type ComposioV114Checkpoint,
  type ComposioV114ConnectionHealth,
  type ComposioV114PollSchedule,
  type ComposioV114TriggerCategory,
} from '@open-bot/core';

export const COMPOSIO_V114_TOOL_NAMES = [
  'composio_mock_toolkit_list_v114',
  'composio_mock_toolkit_execute_v114',
  'composio_poll_schedule_v2',
  'composio_connection_health',
  'composio_trigger_templates',
  'composio_mcp_app_open',
] as const;

export function isComposioV114ToolName(name: string): boolean {
  return (COMPOSIO_V114_TOOL_NAMES as readonly string[]).includes(name);
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

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getNullableNumberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number or null.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Argument "${name}" must be a boolean.`);
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function getObjectArrayArg(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return [...(value as Record<string, unknown>[])];
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

const V114_CATEGORIES: readonly string[] = [
  'communication',
  'code',
  'project',
  'sales',
  'support',
  'calendar',
  'document',
  'billing',
  'marketing',
];

export function createComposioV114Tools(): Tool[] {
  const mockToolkitListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list_v114',
      'List the 6 Composio MOCK toolkits v114 (webflow/pipedrive/chargebee/xero/eventbrite/surveymonkey) with candidate tool slugs + auth kind/note per toolkit. Mock-only, no key, no network — slugs are candidates, NOT live-verified.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const summary = summarizeMockComposioV114Catalogue();
        return okResult({
          mock: true,
          live: false,
          totalToolkits: COMPOSIO_V114_MOCK_TOOLKITS.length,
          totalSlugs: summary.totalSlugs,
          writeSlugs: summary.writeSlugs,
          readSlugs: summary.readSlugs,
          toolkits: COMPOSIO_V114_MOCK_TOOLKITS.map((t) => ({
            slug: t.slug,
            label: t.label,
            icon: t.icon,
            description: t.description,
            candidateToolSlugs: [...t.candidateToolSlugs],
            authKind: t.authKind,
            authNote: t.authNote,
            mockOnly: t.mockOnly,
            liveVerified: t.liveVerified,
          })),
          note: 'Mock-only: no live Composio call. To run for real, add a Composio API key to the Vault and verify each slug against the live Composio catalog first.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mockToolkitExecuteTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_execute_v114',
      'Run one mock Composio v114 tool with deterministic local sample data (no network, no key). The response always carries mock: true, live: false. Throws for unknown toolkits/slugs.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug: webflow, pipedrive, chargebee, xero, eventbrite or surveymonkey.' },
        slug: { type: 'string', description: 'Candidate tool slug of that toolkit, e.g. WEBFLOW_LIST_SITES.' },
        args: { type: 'object', description: 'Tool arguments (echoed back in data.echo; the mock never executes anything).' },
      },
      ['toolkit', 'slug'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolkit = getStringArg(args, 'toolkit');
        const slug = getStringArg(args, 'slug');
        const toolArgs = getObjectArg(args, 'args');
        const needsApproval = mockComposioV114ToolNeedsApproval(slug);
        const result = new MockComposioV114Executor().execute(toolkit, slug, toolArgs);
        return okResult({ ...result, needsApproval });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pollScheduleTool: Tool = {
    definition: toolDef(
      'composio_poll_schedule_v2',
      'Composio poll scheduler v2: given one connection poll schedule + last outcome (success/error) + polled item ids, compute the next poll time (success resets to base interval; errors back off exponentially), dedupe new vs duplicate items, and return a checkpoint JSON to resume after restart. Pure function — no network, no key.',
      {
        scheduleId: { type: 'string', description: 'Schedule id, e.g. poll:gmail:ca_123.' },
        connectionId: { type: 'string', description: 'Composio connection id.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. gmail.' },
        triggerSlug: { type: 'string', description: 'Trigger slug being polled, e.g. GMAIL_NEW_GMAIL_MESSAGE.' },
        outcome: { type: 'string', enum: ['success', 'error'], description: 'Outcome of the last poll.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
        baseIntervalMs: { type: 'number', description: 'Base interval ms (default: per-toolkit default).' },
        consecutiveErrors: { type: 'number', description: 'Consecutive errors so far (default 0).' },
        lastPollAtMs: { type: 'number', description: 'Epoch ms of the last poll (null = never polled).' },
        lastCursor: { type: 'string', description: 'Cursor returned by the last poll (null = none).' },
        newItemIds: { type: 'array', items: { type: 'string' }, description: 'Ids returned by the last poll (for dedupe).' },
        seenIds: { type: 'array', items: { type: 'string' }, description: 'Ids already seen (duplicates are filtered out).' },
        nextCursor: { type: 'string', description: 'Cursor returned by the last poll (null = none).' },
        noJitter: { type: 'boolean', description: 'True = deterministic next time without jitter (default false).' },
        checkpointJson: { type: 'string', description: 'Optional checkpoint JSON from a previous run to resume from (overrides schedule fields).' },
      },
      ['scheduleId', 'connectionId', 'toolkit', 'triggerSlug', 'outcome'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const noJitter = getBooleanArg(args, 'noJitter', false);
        const random = noJitter ? () => 0.5 : Math.random;
        let schedule: ComposioV114PollSchedule = createComposioV114Schedule({
          id: getStringArg(args, 'scheduleId'),
          connectionId: getStringArg(args, 'connectionId'),
          toolkit: getStringArg(args, 'toolkit'),
          triggerSlug: getStringArg(args, 'triggerSlug'),
          startAtMs: nowMs,
          ...(args['baseIntervalMs'] !== undefined && args['baseIntervalMs'] !== null
            ? { baseIntervalMs: getNumberArg(args, 'baseIntervalMs', 0) }
            : {}),
          jitterFraction: noJitter ? 0 : undefined,
        });
        // Resume tu checkpoint neu caller dua (ghi de lich hien tai).
        const checkpointJson = getStringArg(args, 'checkpointJson', false);
        if (checkpointJson !== '') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(checkpointJson);
          } catch {
            throw new Error('checkpointJson is not valid JSON');
          }
          validateComposioV114Checkpoint(parsed as ComposioV114Checkpoint);
          const cp = parsed as ComposioV114Checkpoint;
          schedule = resumeComposioV114Schedule(
            { ...schedule, id: cp.scheduleId, connectionId: cp.connectionId, toolkit: cp.toolkit, triggerSlug: cp.triggerSlug },
            cp,
            nowMs,
          );
        }
        schedule = {
          ...schedule,
          consecutiveErrors: Math.max(0, Math.trunc(getNumberArg(args, 'consecutiveErrors', schedule.consecutiveErrors))),
          lastPollAtMs: getNullableNumberArg(args, 'lastPollAtMs') ?? schedule.lastPollAtMs,
          lastCursor:
            args['lastCursor'] !== undefined && args['lastCursor'] !== null
              ? getStringArg(args, 'lastCursor', false)
              : schedule.lastCursor,
        };
        const outcome = getStringArg(args, 'outcome');
        if (outcome !== 'success' && outcome !== 'error') {
          throw new Error('outcome must be one of: success, error.');
        }
        const seenIds = getStringArrayArg(args, 'seenIds');
        const newItemIds = getStringArrayArg(args, 'newItemIds');
        const seen = seenIds.map((id) => ({ id, atMs: schedule.lastPollAtMs ?? nowMs }));
        const { fresh, duplicates } = filterComposioV114NewItems(
          newItemIds.map((id) => ({ id })),
          seen,
          nowMs,
        );
        const nextCursor =
          args['nextCursor'] !== undefined && args['nextCursor'] !== null
            ? getStringArg(args, 'nextCursor', false)
            : schedule.lastCursor;
        const next =
          outcome === 'success'
            ? nextComposioV114PollAfterSuccess(
                schedule,
                nowMs,
                { newItems: fresh.length, duplicates: duplicates.length, cursor: nextCursor },
                random,
              )
            : nextComposioV114PollAfterError(schedule, nowMs, random);
        const checkpoint = checkpointComposioV114Schedule(
          next,
          fresh.map((i) => ({ id: i.id, atMs: nowMs })),
          nowMs,
        );
        return okResult({
          scheduleId: next.id,
          toolkit: next.toolkit,
          triggerSlug: next.triggerSlug,
          outcome,
          consecutiveErrors: next.consecutiveErrors,
          currentIntervalMs: next.currentIntervalMs,
          backoffDelayMs:
            outcome === 'error'
              ? composioV114BackoffDelayMs(next.baseIntervalMs, next.consecutiveErrors, next.backoffMultiplier, next.maxBackoffMs)
              : next.baseIntervalMs,
          nextPollAtMs: next.nextPollAtMs,
          msUntilNextPoll: composioV114MsUntilNextPoll(next, nowMs),
          freshItems: fresh.length,
          duplicateItems: duplicates.length,
          checkpointJson: JSON.stringify(checkpoint),
          note: 'Pure computation — no live Composio call was made.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const connectionHealthTool: Tool = {
    definition: toolDef(
      'composio_connection_health',
      'Composio connection health dashboard: given sync stats for one or more connections (total polls/errors, last sync, latencies, expiry), evaluate each connection health (healthy/degraded/unhealthy/expired/unknown) + alerts and return the dashboard summary. Pure function — no network, no key.',
      {
        connections: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Array of {connectionId, toolkit, totalPolls, totalErrors, consecutiveErrors, lastSyncAtMs (or null), lastSuccessAtMs (or null), latenciesMs (array), expiresAtMs (or null), accountLabel?}.',
        },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
        recordOutcome: { type: 'string', enum: ['success', 'error', 'none'], description: 'Record one more sync outcome for the first connection before evaluating (default none).' },
        recordLatencyMs: { type: 'number', description: 'Latency ms of the recorded sync (only with recordOutcome=success).' },
      },
      ['connections'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const raw = getObjectArrayArg(args, 'connections');
        if (raw.length === 0) throw new Error('Argument "connections" must be a non-empty array.');
        const recordOutcome = getStringArg(args, 'recordOutcome', false);
        if (recordOutcome !== '' && !['success', 'error', 'none'].includes(recordOutcome)) {
          throw new Error('recordOutcome must be one of: success, error, none.');
        }
        const recordLatencyMs = getNumberArg(args, 'recordLatencyMs', 0);
        const evaluated: ComposioV114ConnectionHealth[] = raw.map((entry, i) => {
          const connectionId = entry['connectionId'];
          const toolkit = entry['toolkit'];
          if (typeof connectionId !== 'string' || connectionId.trim() === '') {
            throw new Error(`connections[${i}].connectionId must be a non-empty string.`);
          }
          if (typeof toolkit !== 'string' || toolkit.trim() === '') {
            throw new Error(`connections[${i}].toolkit must be a non-empty string.`);
          }
          const totalPolls = entry['totalPolls'];
          const totalErrors = entry['totalErrors'];
          if (typeof totalPolls !== 'number' || !Number.isInteger(totalPolls) || totalPolls < 0) {
            throw new Error(`connections[${i}].totalPolls must be a non-negative integer.`);
          }
          if (typeof totalErrors !== 'number' || !Number.isInteger(totalErrors) || totalErrors < 0 || totalErrors > totalPolls) {
            throw new Error(`connections[${i}].totalErrors must be within [0, totalPolls].`);
          }
          const latencies = Array.isArray(entry['latenciesMs'])
            ? (entry['latenciesMs'] as unknown[]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)
            : [];
          let health = emptyComposioV114ConnectionHealth(connectionId, toolkit, nowMs,
            typeof entry['accountLabel'] === 'string' ? entry['accountLabel'] : undefined);
          health = {
            ...health,
            totalPolls,
            totalErrors,
            consecutiveErrors:
              typeof entry['consecutiveErrors'] === 'number' && Number.isInteger(entry['consecutiveErrors'])
                ? entry['consecutiveErrors']
                : 0,
            errorRate: totalPolls > 0 ? totalErrors / totalPolls : 0,
            lastSyncAtMs:
              typeof entry['lastSyncAtMs'] === 'number' ? entry['lastSyncAtMs'] : null,
            lastSuccessAtMs:
              typeof entry['lastSuccessAtMs'] === 'number' ? entry['lastSuccessAtMs'] : null,
            recentLatenciesMs: latencies.slice(-100),
            expiresAtMs:
              typeof entry['expiresAtMs'] === 'number' ? entry['expiresAtMs'] : null,
          };
          // Ghi them 1 lan sync cho connection dau tien neu caller yeu cau.
          if (i === 0 && recordOutcome === 'success') {
            health = recordComposioV114SyncSuccess(health, nowMs, recordLatencyMs > 0 ? recordLatencyMs : undefined);
          } else if (i === 0 && recordOutcome === 'error') {
            health = recordComposioV114SyncError(health, nowMs);
          } else {
            const { status, alerts } = evaluateComposioV114Health(health, nowMs);
            health = { ...health, status, alerts };
          }
          return health;
        });
        const dashboard = summarizeComposioV114HealthDashboard(evaluated);
        return okResult({ evaluated, dashboard });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const triggerTemplatesTool: Tool = {
    definition: toolDef(
      'composio_trigger_templates',
      'Search the Composio trigger template catalog v114 (35 templates: 29 curated with live-verified slugs + 6 candidates for mock v114 toolkits). Each template has a description, input schema (fields) and an example payload. Pure function — no network, no key.',
      {
        query: { type: 'string', description: 'Keyword to search in slug/name/description/toolkit (empty = list all).' },
        toolkit: { type: 'string', description: 'Filter by toolkit slug, e.g. github.' },
        category: { type: 'string', enum: [...V114_CATEGORIES], description: 'Filter by category.' },
        slug: { type: 'string', description: 'Get one template by exact trigger slug.' },
        validate: { type: 'boolean', description: 'True = also validate the whole catalog before returning (default false).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        if (getBooleanArg(args, 'validate', false)) validateComposioV114TriggerTemplates();
        const slug = getStringArg(args, 'slug', false);
        if (slug !== '') {
          const template = findComposioV114TriggerTemplate(slug);
          if (!template) throw new Error(`Unknown Composio v114 trigger template: ${slug}`);
          return okResult({ total: 1, templates: [template] });
        }
        let templates = [...COMPOSIO_V114_TRIGGER_TEMPLATES];
        const query = getStringArg(args, 'query', false);
        if (query !== '') templates = searchComposioV114TriggerTemplates(query);
        const toolkit = getStringArg(args, 'toolkit', false);
        if (toolkit !== '') templates = templates.filter((t) => t.toolkit === toolkit);
        const category = getStringArg(args, 'category', false);
        if (category !== '') {
          if (!(V114_CATEGORIES as readonly string[]).includes(category)) {
            throw new Error(`category must be one of: ${V114_CATEGORIES.join(', ')}.`);
          }
          templates = templates.filter((t) => t.category === (category as ComposioV114TriggerCategory));
        }
        return okResult({
          total: templates.length,
          curated: templates.filter((t) => t.source === 'curated').length,
          candidates: templates.filter((t) => t.source === 'candidate').length,
          templates,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpAppOpenTool: Tool = {
    definition: toolDef(
      'composio_mcp_app_open',
      'Open an MCP App for one mock Composio v114 tool: returns the app URI (ui://composio/<toolkit>/<TOOL_SLUG>), the safe static HTML for the sandboxed iframe, and the mock task result (mock: true, live: false). Client-side only — no network, no key.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug: webflow, pipedrive, chargebee, xero, eventbrite or surveymonkey.' },
        slug: { type: 'string', description: 'Candidate tool slug, e.g. WEBFLOW_LIST_SITES.' },
        args: { type: 'object', description: 'Tool arguments (echoed in the mock result).' },
        appUri: { type: 'string', description: 'Alternative: open by full app URI ui://composio/<toolkit>/<SLUG> instead of toolkit+slug.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const toolArgs = getObjectArg(args, 'args');
        const nowMs = Date.now();
        const appUri = getStringArg(args, 'appUri', false);
        let uri: string;
        if (appUri !== '') {
          if (!isComposioV114McpAppUri(appUri)) throw new Error(`Unknown Composio v114 MCP app URI: ${appUri}`);
          uri = appUri;
        } else {
          const toolkit = getStringArg(args, 'toolkit');
          const slug = getStringArg(args, 'slug');
          uri = createComposioV114McpApp(toolkit, slug).uri;
        }
        const { task, html } = executeMockComposioV114ToolViaApp(uri, toolArgs, nowMs);
        return okResult({
          mock: true,
          live: false,
          appUri: uri,
          app: { appId: task.appUri, toolkit: task.toolkit, toolSlug: task.toolSlug },
          html,
          task: {
            taskId: task.taskId,
            status: task.status,
            result: task.result ?? null,
            error: task.error ?? null,
          },
          note: 'Mock-only: the task ran on local sample data. To run for real, add a Composio API key to the Vault and verify the slug against the live Composio catalog first.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    mockToolkitListTool,
    mockToolkitExecuteTool,
    pollScheduleTool,
    connectionHealthTool,
    triggerTemplatesTool,
    mcpAppOpenTool,
  ];
}

export const COMPOSIO_V114_TOOLS: Tool[] = createComposioV114Tools();
