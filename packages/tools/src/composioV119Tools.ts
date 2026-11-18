/**
 * Composio v119 tools (v1.19, Doi T4) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * Mock toolkits v119 (2):
 * - `composio_mock_toolkit_list_v119` — liet ke 3 toolkit Composio
 *   MOCK v119 (wrike/bamboohr/ringcentral) + slug ung vien + cach
 *   xac thuc tung toolkit. Chay duoc ngay, khong can key.
 * - `composio_mock_toolkit_execute_v119` — chay mot tool mock bang
 *   du lieu mau local (khong goi mang, khong can key). Response
 *   luon mang `mock: true, live: false`.
 *
 * Polling v6 (1):
 * - `composio_poll_batch_v119` — gom nhieu page thanh mot batch
 *   (dedupe theo id + cursor, dung khi gap cursor lap), retry co
 *   gioi han khi fetch loi, tinh lich poll ke tiep theo outcome
 *   hit/miss/error. Ham thuan.
 *
 * Trigger instances v2 (1):
 * - `composio_trigger_instances_v2` — dang ky/liet ke/chuyen vong
 *   doi (draft/active/paused/stopped/archived)/mo-dong run/lich
 *   su chay + tom tat. Store trong bo nho dung chung trong
 *   session (host that giu store ben ngoai).
 *
 * OAuth refresh v2 (1):
 * - `composio_oauth_refresh_v2` — lam moi token tu dong (mock):
 *   luu refresh token MOCK vao Vault gia lap trong bo nho, retry
 *   co gioi han, xoay token, fallback khi refresh fail (het luot
 *   → can ket noi lai). KHONG goi Composio that, KHONG nhan key
 *   that — `mockOutcome` chi dieu khien mock refreshFn.
 *
 * Webhook v2 (1):
 * - `composio_webhook_queue_v2` — nhan delivery webhook (verify
 *   chu ky HMAC bang mock secret do caller dua, dedupe theo
 *   eventId/deliveryId/hash body, tu choi event cu), dua vao
 *   hang doi, xu ly (handler mock), retry + dead-letter. Khong
 *   goi mang, khong mo port.
 *
 * Toolkit prefs per-user (1):
 * - `composio_toolkit_prefs_v119` — bat/tat toolkit theo user
 *   (set/bulk/clear/reset/list), hieu dung theo catalog. Store
 *   trong bo nho dung chung trong session.
 *
 * Usage metering (1):
 * - `composio_usage_v119` — dem luot goi theo toolkit/user,
 *   kiem tra quota local truoc khi goi, bao cao su dung
 *   (top toolkit/user, vuot quota, ti le loi). Store trong bo
 *   nho dung chung trong session.
 *
 * Tat ca 8 tool chay duoc ngay ca khi chua bind, khong doc/ghi
 * file, khong can Composio API key.
 */

import type { Tool } from '@open-bot/core';
import {
  COMPOSIO_V119_MOCK_TOOLKITS,
  ComposioV119WebhookQueue,
  MemoryComposioV119ToolkitPrefsStore,
  MemoryComposioV119TriggerInstanceStore,
  MemoryComposioV119UsageStore,
  MockComposioV119Executor,
  buildComposioV119UsageReport,
  composioV119RetryDelayMs,
  createComposioV118ConnState,
  createComposioV118OAuthEntry,
  createComposioV119PollConnBatchState,
  createComposioV119RefreshState,
  fetchComposioV119Batch,
  finishComposioV119TriggerRun,
  isComposioV119TriggerInstanceRunnable,
  listComposioV119EnabledToolkitsForUser,
  mockComposioV119ToolNeedsApproval,
  nextComposioV118Poll,
  recordComposioV119SeenCursor,
  recordComposioV119Usage,
  resetComposioV119Refresh,
  startComposioV119TriggerRun,
  summarizeComposioV119TriggerInstance,
  summarizeComposioV119TriggerInstances,
  summarizeComposioV119TriggerRuns,
  summarizeComposioV119Usage,
  summarizeMockComposioV119Catalogue,
  transitionComposioV119TriggerLifecycle,
  validateComposioV119PollBatchConfig,
  type ComposioV118PollConnState,
  type ComposioV119PollBatchConfig,
  type ComposioV119TriggerLifecycle,
} from '@open-bot/core';
import {
  attemptComposioV119Refresh,
  hasComposioV119RefreshToken,
  setComposioV119RefreshToken,
  type ComposioV119RefreshTokenVault,
} from '@open-bot/core';

export const COMPOSIO_V119_TOOL_NAMES = [
  'composio_mock_toolkit_list_v119',
  'composio_mock_toolkit_execute_v119',
  'composio_poll_batch_v119',
  'composio_trigger_instances_v2',
  'composio_oauth_refresh_v2',
  'composio_webhook_queue_v2',
  'composio_toolkit_prefs_v119',
  'composio_usage_v119',
] as const;

export function isComposioV119ToolName(name: string): boolean {
  return (COMPOSIO_V119_TOOL_NAMES as readonly string[]).includes(name);
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

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getObjectArrayArg(args: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    throw new Error(`Argument "${name}" must be an array of objects.`);
  }
  return [...(value as Record<string, unknown>[])];
}

const V119_LIFECYCLES: readonly string[] = ['draft', 'active', 'paused', 'stopped', 'archived'];

/** Vault gia lap trong bo nho — chi dung cho tool refresh v2 (mock, khong persist, khong key that). */
class MemoryMockRefreshVault implements ComposioV119RefreshTokenVault {
  private readonly secrets = new Map<string, string>();

  getSecret(namespace: string, key: string): string | null {
    return this.secrets.get(`${namespace}:${key}`) ?? null;
  }

  setSecret(namespace: string, key: string, value: string): void {
    this.secrets.set(`${namespace}:${key}`, value);
  }

  deleteSecret(namespace: string, key: string): boolean {
    return this.secrets.delete(`${namespace}:${key}`);
  }

  hasSecret(namespace: string, key: string): boolean {
    return this.secrets.has(`${namespace}:${key}`);
  }
}

export function createComposioV119Tools(): Tool[] {
  // Store dung chung trong session cho cac tool co trang thai.
  const triggerStore = new MemoryComposioV119TriggerInstanceStore();
  const prefsStore = new MemoryComposioV119ToolkitPrefsStore();
  const usageStore = new MemoryComposioV119UsageStore();
  const webhookQueue = new ComposioV119WebhookQueue();
  const mockVault = new MemoryMockRefreshVault();
  const refreshStates = new Map<string, ReturnType<typeof createComposioV119RefreshState>>();

  const mockToolkitListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list_v119',
      'List the 3 Composio MOCK toolkits v119 (wrike/bamboohr/ringcentral) with candidate tool slugs + auth kind/note per toolkit. Mock-only, no key, no network — slugs are candidates, NOT live-verified.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const summary = summarizeMockComposioV119Catalogue();
        return okResult({
          mock: true,
          live: false,
          totalToolkits: COMPOSIO_V119_MOCK_TOOLKITS.length,
          totalSlugs: summary.totalSlugs,
          writeSlugs: summary.writeSlugs,
          readSlugs: summary.readSlugs,
          toolkits: COMPOSIO_V119_MOCK_TOOLKITS.map((t) => ({
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
      'composio_mock_toolkit_execute_v119',
      'Run one mock Composio v119 tool with deterministic local sample data (no network, no key). The response always carries mock: true, live: false. Throws for unknown toolkits/slugs.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug: wrike, bamboohr or ringcentral.' },
        slug: { type: 'string', description: 'Candidate tool slug of that toolkit, e.g. WRIKE_LIST_TASKS.' },
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
        const needsApproval = mockComposioV119ToolNeedsApproval(slug);
        const result = new MockComposioV119Executor().execute(toolkit, slug, toolArgs);
        return okResult({ ...result, needsApproval });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pollBatchTool: Tool = {
    definition: toolDef(
      'composio_poll_batch_v119',
      'Composio polling v6: given one connection + a list of fetched pages (items + cursor each), batch them with dedupe by item id and by cursor (stops on a repeated cursor), bounded retry is reported, then compute the next poll time from the outcome (hit/miss/error). Pure function — no network, no key.',
      {
        connectionId: { type: 'string', description: 'Composio connection id.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. gmail.' },
        triggerSlug: { type: 'string', description: 'Trigger slug being polled, e.g. GMAIL_NEW_GMAIL_MESSAGE.' },
        pages: {
          type: 'array',
          items: { type: 'object' },
          description: 'Fetched pages: each { items: [{id, ...}], cursor: string|null }. Cursor null = last page.',
        },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
        batchSize: { type: 'number', description: 'Max pages per batch (default 5).' },
        maxBatchItems: { type: 'number', description: 'Max fresh items per batch (default 200).' },
        maxRetries: { type: 'number', description: 'Max fetch retries (default 3) — reported in the retry delay table.' },
        seenCursors: { type: 'array', items: { type: 'string' }, description: 'Cursors already seen (a page repeating one stops the batch).' },
      },
      ['connectionId', 'toolkit', 'triggerSlug', 'pages'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const pages = getObjectArrayArg(args, 'pages');
        const batchConfig: Partial<ComposioV119PollBatchConfig> = {};
        const batchSize = getNumberArg(args, 'batchSize', 5);
        const maxBatchItems = getNumberArg(args, 'maxBatchItems', 200);
        const maxRetries = getNumberArg(args, 'maxRetries', 3);
        if (args['batchSize'] !== undefined) batchConfig.batchSize = batchSize;
        if (args['maxBatchItems'] !== undefined) batchConfig.maxBatchItems = maxBatchItems;
        if (args['maxRetries'] !== undefined) batchConfig.maxRetries = maxRetries;
        const pollState: ComposioV118PollConnState = createComposioV118ConnState({
          connectionId: getStringArg(args, 'connectionId'),
          toolkit: getStringArg(args, 'toolkit'),
          triggerSlug: getStringArg(args, 'triggerSlug'),
          startAtMs: nowMs,
        });
        let batchState = createComposioV119PollConnBatchState(pollState.connectionId, batchConfig, nowMs);
        for (const cursor of getStringArrayArg(args, 'seenCursors')) {
          batchState = recordComposioV119SeenCursor(batchState, cursor, nowMs);
        }
        let pageIdx = 0;
        const { result, batchState: afterBatch } = await fetchComposioV119Batch(
          pollState,
          batchState,
          async () => {
            const page = pages[pageIdx] ?? { items: [], cursor: null };
            pageIdx += 1;
            const items = Array.isArray(page['items']) ? (page['items'] as Record<string, unknown>[]) : [];
            return {
              items: items.map((i) => ({ id: String(i['id'] ?? ''), ...i })),
              cursor: typeof page['cursor'] === 'string' ? page['cursor'] : null,
            };
          },
          nowMs,
        );
        const outcome = result.fresh.length > 0 ? 'hit' : 'miss';
        const next = nextComposioV118Poll(pollState, outcome, {
          nowMs,
          newItemIds: result.fresh.map((i) => i.id),
          cursor: result.lastCursor,
        });
        const policy = validateComposioV119PollBatchConfig(batchConfig);
        return okResult({
          mock: true,
          live: false,
          batch: result,
          nextPollAtMs: next.nextPollAtMs,
          nextIntervalMs: next.policyState.currentIntervalMs,
          totalNewItems: next.totalNewItems,
          seenCursors: afterBatch.seenCursors.map((c) => c.cursor),
          retryDelaysMs: [0, 1, 2].slice(0, Math.max(0, Math.min(maxRetries, 3))).map((a) =>
            composioV119RetryDelayMs(a, policy, () => 0.5),
          ),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const triggerInstancesV2Tool: Tool = {
    definition: toolDef(
      'composio_trigger_instances_v2',
      'Composio trigger instances v2: register/list/transition lifecycle (draft/active/paused/stopped/archived)/start-run/finish-run/run summary. The store is shared in-session (memory); nothing is persisted to disk and no Composio API is called.',
      {
        action: { type: 'string', enum: ['register', 'list', 'transition', 'start-run', 'finish-run', 'summary', 'runs'], description: 'Action to perform.' },
        triggerId: { type: 'string', description: 'Trigger instance id, e.g. ti_xyz789.' },
        triggerSlug: { type: 'string', description: 'Trigger slug, e.g. GITHUB_COMMIT_EVENT.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. github.' },
        connectionId: { type: 'string', description: 'Connected account id, e.g. ca_abc123.' },
        label: { type: 'string', description: 'Friendly label for the instance.' },
        lifecycle: { type: 'string', enum: ['draft', 'active', 'paused', 'stopped', 'archived'], description: 'Target lifecycle for transition, or initial lifecycle for register.' },
        reason: { type: 'string', description: 'Reason for the lifecycle transition.' },
        runId: { type: 'string', description: 'Run id for finish-run.' },
        status: { type: 'string', enum: ['success', 'failed', 'skipped'], description: 'Outcome for finish-run.' },
        error: { type: 'string', description: 'Error message for a failed run.' },
        eventId: { type: 'string', description: 'Event id that started the run.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        if (action === 'register') {
          const instance = triggerStore.register(
            {
              triggerId: getStringArg(args, 'triggerId'),
              triggerSlug: getStringArg(args, 'triggerSlug'),
              toolkit: getStringArg(args, 'toolkit'),
              connectionId: getStringArg(args, 'connectionId'),
              ...(args['label'] !== undefined ? { label: getStringArg(args, 'label', false) } : {}),
              ...(args['lifecycle'] !== undefined
                ? { lifecycle: getStringArg(args, 'lifecycle') as ComposioV119TriggerLifecycle }
                : {}),
            },
            nowMs,
          );
          return okResult({ mock: true, live: false, instance });
        }
        if (action === 'list') {
          const filter: Record<string, unknown> = {};
          if (args['toolkit'] !== undefined) filter['toolkit'] = getStringArg(args, 'toolkit', false);
          if (args['lifecycle'] !== undefined) filter['lifecycle'] = getStringArg(args, 'lifecycle', false);
          const list = triggerStore.list(filter as never);
          return okResult({ mock: true, live: false, total: list.length, instances: list });
        }
        if (action === 'transition') {
          const prev = triggerStore.get(getStringArg(args, 'triggerId'));
          if (!prev) throw new Error(`unknown trigger instance id: ${getStringArg(args, 'triggerId')}`);
          const next = transitionComposioV119TriggerLifecycle(
            prev,
            getStringArg(args, 'lifecycle') as ComposioV119TriggerLifecycle,
            getStringArg(args, 'reason', false),
            nowMs,
          );
          triggerStore.update(next);
          return okResult({ mock: true, live: false, instance: next });
        }
        if (action === 'start-run') {
          const prev = triggerStore.get(getStringArg(args, 'triggerId'));
          if (!prev) throw new Error(`unknown trigger instance id: ${getStringArg(args, 'triggerId')}`);
          const { instance, run } = startComposioV119TriggerRun(
            prev,
            args['eventId'] !== undefined ? getStringArg(args, 'eventId', false) : null,
            nowMs,
          );
          triggerStore.update(instance);
          return okResult({ mock: true, live: false, instance, run });
        }
        if (action === 'finish-run') {
          const prev = triggerStore.get(getStringArg(args, 'triggerId'));
          if (!prev) throw new Error(`unknown trigger instance id: ${getStringArg(args, 'triggerId')}`);
          const status = getStringArg(args, 'status');
          if (status !== 'success' && status !== 'failed' && status !== 'skipped') {
            throw new Error('status must be one of: success, failed, skipped.');
          }
          const next = finishComposioV119TriggerRun(prev, getStringArg(args, 'runId'), status, {
            ...(args['error'] !== undefined ? { error: getStringArg(args, 'error', false) } : {}),
            nowMs,
          });
          triggerStore.update(next);
          return okResult({ mock: true, live: false, instance: next });
        }
        if (action === 'runs') {
          const prev = triggerStore.get(getStringArg(args, 'triggerId'));
          if (!prev) throw new Error(`unknown trigger instance id: ${getStringArg(args, 'triggerId')}`);
          return okResult({
            mock: true,
            live: false,
            summary: summarizeComposioV119TriggerRuns(prev, nowMs),
            runs: prev.runs,
            runnable: isComposioV119TriggerInstanceRunnable(prev),
          });
        }
        if (action === 'summary') {
          const all = triggerStore.list();
          return okResult({
            mock: true,
            live: false,
            summary: summarizeComposioV119TriggerInstances(all, nowMs),
            instances: all.map((i) => summarizeComposioV119TriggerInstance(i, nowMs)),
          });
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const oauthRefreshV2Tool: Tool = {
    definition: toolDef(
      'composio_oauth_refresh_v2',
      'Composio OAuth refresh v2 (MOCK): store a mock refresh token in an in-memory fake Vault, then run an auto-refresh cycle with a mock refresh function controlled by mockOutcome (success/fail/revoked/no-token). Retries with backoff, rotates the token on success, falls back to reconnect-required after repeated failures. Never calls Composio for real and never accepts a real key.',
      {
        action: { type: 'string', enum: ['store-mock-token', 'refresh', 'status', 'reset'], description: 'Action to perform.' },
        connectionId: { type: 'string', description: 'Composio connection id.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. gmail.' },
        mockToken: { type: 'string', description: 'Mock refresh token value (fixture only, kept in memory for this session).' },
        mockOutcome: { type: 'string', enum: ['success', 'fail', 'revoked'], description: 'What the mock refresh function should do.' },
        expiresAtMs: { type: 'number', description: 'Current token expiry epoch ms (default: now + 60s).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action', 'connectionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const connectionId = getStringArg(args, 'connectionId');
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        if (action === 'store-mock-token') {
          const token = getStringArg(args, 'mockToken');
          setComposioV119RefreshToken(mockVault, connectionId, token);
          if (!refreshStates.has(connectionId)) {
            refreshStates.set(connectionId, createComposioV119RefreshState(connectionId, getStringArg(args, 'toolkit', false) || 'unknown'));
          }
          return okResult({ mock: true, live: false, stored: true, hasToken: hasComposioV119RefreshToken(mockVault, connectionId) });
        }
        if (action === 'reset') {
          const state = refreshStates.get(connectionId) ??
            createComposioV119RefreshState(connectionId, getStringArg(args, 'toolkit', false) || 'unknown');
          const reset = resetComposioV119Refresh(state, mockVault);
          refreshStates.set(connectionId, reset);
          return okResult({ mock: true, live: false, refresh: reset, hasToken: hasComposioV119RefreshToken(mockVault, connectionId) });
        }
        if (action === 'status') {
          const state = refreshStates.get(connectionId);
          return okResult({
            mock: true,
            live: false,
            hasToken: hasComposioV119RefreshToken(mockVault, connectionId),
            refresh: state ?? null,
          });
        }
        if (action === 'refresh') {
          const toolkit = getStringArg(args, 'toolkit', false) || 'unknown';
          const expiresAtMs = getNumberArg(args, 'expiresAtMs', nowMs + 60_000);
          const mockOutcome = getStringArg(args, 'mockOutcome', false) || 'success';
          const oauth = createComposioV118OAuthEntry(connectionId, toolkit, {
            expiresAtMs,
            state: 'connected',
            nowMs,
          });
          const refresh = refreshStates.get(connectionId) ?? createComposioV119RefreshState(connectionId, toolkit);
          const attempt = await attemptComposioV119Refresh(oauth, refresh, {
            vault: mockVault,
            refreshFn: async () => {
              if (mockOutcome === 'revoked') return { newExpiresAtMs: nowMs + 3600_000, revoked: true };
              if (mockOutcome === 'fail') throw new Error('mock refresh failed (fixture)');
              return {
                newExpiresAtMs: nowMs + 3600_000,
                newRefreshToken: `mock-rotated-${connectionId}`,
              };
            },
            nowMs,
            sleep: async () => undefined,
            random: () => 0.5,
          });
          refreshStates.set(connectionId, attempt.refresh);
          return okResult({ mock: true, live: false, ...attempt, tokenRotated: attempt.outcome === 'refreshed' });
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const webhookQueueV2Tool: Tool = {
    definition: toolDef(
      'composio_webhook_queue_v2',
      'Composio webhook v2: accept a webhook delivery (verify HMAC signature with a MOCK secret supplied by the caller, dedupe by event/delivery/body hash, reject stale events), enqueue it, drain the queue with a mock handler, and manage dead-letters (requeue/discard). No network, no open port.',
      {
        action: { type: 'string', enum: ['accept', 'drain', 'list', 'dead-letters', 'requeue', 'discard', 'summary'], description: 'Action to perform.' },
        rawBody: { type: 'string', description: 'Raw JSON webhook body (V3 envelope) as a string.' },
        mockSecret: { type: 'string', description: 'Mock signing secret for HMAC verification (fixture only — never a real secret).' },
        signature: { type: 'string', description: 'Webhook signature header value.' },
        timestamp: { type: 'string', description: 'Webhook timestamp header value (epoch seconds).' },
        deliveryId: { type: 'string', description: 'Webhook delivery id (webhook-id header).' },
        mockHandler: { type: 'string', enum: ['succeed', 'fail'], description: 'What the mock handler should do when draining.' },
        queueId: { type: 'string', description: 'Queue id for requeue/discard.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        if (action === 'accept') {
          const rawBody = getStringArg(args, 'rawBody');
          const result = webhookQueue.accept({
            rawBody,
            ...(args['signature'] !== undefined ? { signature: getStringArg(args, 'signature', false) } : {}),
            ...(args['timestamp'] !== undefined ? { timestamp: getStringArg(args, 'timestamp', false) } : {}),
            secret: args['mockSecret'] !== undefined ? getStringArg(args, 'mockSecret', false) : null,
            ...(args['deliveryId'] !== undefined ? { deliveryId: getStringArg(args, 'deliveryId', false) } : {}),
            receivedAtMs: nowMs,
          });
          return okResult({ mock: true, live: false, ...result });
        }
        if (action === 'drain') {
          const mockHandler = getStringArg(args, 'mockHandler', false) || 'succeed';
          const processed = await webhookQueue.drain(async () => {
            if (mockHandler === 'fail') throw new Error('mock handler failed (fixture)');
          }, nowMs);
          return okResult({ mock: true, live: false, processed, summary: webhookQueue.summarize() });
        }
        if (action === 'list') {
          return okResult({ mock: true, live: false, events: webhookQueue.listEvents() });
        }
        if (action === 'dead-letters') {
          return okResult({ mock: true, live: false, deadLetters: webhookQueue.listDeadLetters() });
        }
        if (action === 'requeue') {
          const ok = webhookQueue.requeueDeadLetter(getStringArg(args, 'queueId'), nowMs);
          return okResult({ mock: true, live: false, requeued: ok });
        }
        if (action === 'discard') {
          const ok = webhookQueue.discardDeadLetter(getStringArg(args, 'queueId'));
          return okResult({ mock: true, live: false, discarded: ok });
        }
        if (action === 'summary') {
          return okResult({ mock: true, live: false, summary: webhookQueue.summarize() });
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const toolkitPrefsTool: Tool = {
    definition: toolDef(
      'composio_toolkit_prefs_v119',
      'Composio toolkit prefs per-user: enable/disable toolkits for one user (set/bulk/clear/reset/list-enabled). Defaults to enabled; machine-level disables (if any) still win. The store is shared in-session (memory).',
      {
        action: { type: 'string', enum: ['set', 'bulk', 'clear', 'reset', 'get', 'list-enabled'], description: 'Action to perform.' },
        userId: { type: 'string', description: 'User id.' },
        toolkit: { type: 'string', description: 'Toolkit slug.' },
        toolkits: { type: 'array', items: { type: 'string' }, description: 'Toolkit slugs for bulk/list-enabled.' },
        catalog: { type: 'array', items: { type: 'string' }, description: 'Full toolkit catalog for list-enabled.' },
        enabled: { type: 'boolean', description: 'Enable (true) or disable (false) the toolkit(s).' },
        reason: { type: 'string', description: 'Reason for the change.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action', 'userId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const userId = getStringArg(args, 'userId');
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        if (action === 'set') {
          const prefs = prefsStore.set(
            userId,
            getStringArg(args, 'toolkit'),
            getBooleanArg(args, 'enabled', true),
            args['reason'] !== undefined ? getStringArg(args, 'reason', false) : null,
            nowMs,
          );
          return okResult({ mock: true, live: false, prefs });
        }
        if (action === 'bulk') {
          const { prefs, changed } = prefsStore.setBulk(
            userId,
            getStringArrayArg(args, 'toolkits'),
            getBooleanArg(args, 'enabled', true),
            args['reason'] !== undefined ? getStringArg(args, 'reason', false) : null,
            nowMs,
          );
          return okResult({ mock: true, live: false, prefs, changed });
        }
        if (action === 'clear') {
          const cleared = prefsStore.clearToolkit(userId, getStringArg(args, 'toolkit'));
          return okResult({ mock: true, live: false, cleared, prefs: prefsStore.get(userId) ?? null });
        }
        if (action === 'reset') {
          const reset = prefsStore.resetUser(userId);
          return okResult({ mock: true, live: false, reset });
        }
        if (action === 'get') {
          return okResult({ mock: true, live: false, prefs: prefsStore.get(userId) ?? null });
        }
        if (action === 'list-enabled') {
          const catalog = getStringArrayArg(args, 'catalog');
          const enabled = listComposioV119EnabledToolkitsForUser(catalog, prefsStore.get(userId));
          return okResult({ mock: true, live: false, enabled, total: catalog.length });
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const usageTool: Tool = {
    definition: toolDef(
      'composio_usage_v119',
      'Composio usage metering: record a tool call (checks the local daily quota first — over-quota calls are blocked, not counted), or build a usage report (totals, top toolkits/users, over-quota, high-failure). The store is shared in-session (memory).',
      {
        action: { type: 'string', enum: ['record', 'report', 'summary'], description: 'Action to perform.' },
        userId: { type: 'string', description: 'User id.' },
        toolkit: { type: 'string', description: 'Toolkit slug.' },
        succeeded: { type: 'boolean', description: 'Whether the call succeeded (default true).' },
        mock: { type: 'boolean', description: 'Whether the call was a mock call (default true).' },
        day: { type: 'string', description: 'Report day YYYY-MM-DD (default: today UTC).' },
        dailyCapPerToolkit: { type: 'number', description: 'Override the daily per-toolkit cap for this session.' },
        dailyCapPerUser: { type: 'number', description: 'Override the daily per-user cap for this session.' },
        dailyCapGlobal: { type: 'number', description: 'Override the daily global cap for this session.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const quotaOverride: Record<string, number> = {};
        if (args['dailyCapPerToolkit'] !== undefined) quotaOverride['dailyCapPerToolkit'] = getNumberArg(args, 'dailyCapPerToolkit', 10000);
        if (args['dailyCapPerUser'] !== undefined) quotaOverride['dailyCapPerUser'] = getNumberArg(args, 'dailyCapPerUser', 50000);
        if (args['dailyCapGlobal'] !== undefined) quotaOverride['dailyCapGlobal'] = getNumberArg(args, 'dailyCapGlobal', 200000);
        if (action === 'record') {
          let state = usageStore.load();
          if (Object.keys(quotaOverride).length > 0) {
            state = { ...state, quota: { ...state.quota, ...quotaOverride } };
          }
          const { state: next, result } = recordComposioV119Usage(
            state,
            {
              userId: getStringArg(args, 'userId'),
              toolkit: getStringArg(args, 'toolkit'),
              succeeded: getBooleanArg(args, 'succeeded', true),
              mock: getBooleanArg(args, 'mock', true),
            },
            nowMs,
          );
          usageStore.save(next);
          return okResult({ mock: true, live: false, ...result });
        }
        if (action === 'report') {
          const state = usageStore.load();
          const report = buildComposioV119UsageReport(state, {
            ...(args['day'] !== undefined ? { day: getStringArg(args, 'day', false) } : {}),
            nowMs,
          });
          return okResult({ mock: true, live: false, report });
        }
        if (action === 'summary') {
          const state = usageStore.load();
          return okResult({ mock: true, live: false, summary: summarizeComposioV119Usage(state, nowMs) });
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    mockToolkitListTool,
    mockToolkitExecuteTool,
    pollBatchTool,
    triggerInstancesV2Tool,
    oauthRefreshV2Tool,
    webhookQueueV2Tool,
    toolkitPrefsTool,
    usageTool,
  ];
}

export const COMPOSIO_V119_TOOLS: Tool[] = createComposioV119Tools();
