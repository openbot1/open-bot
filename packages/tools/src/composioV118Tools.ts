/**
 * Composio v118 tools (v1.18, Doi T4) — registered in ALL_TOOLS
 * (see tools.ts).
 *
 * Mock toolkits v118 (2):
 * - `composio_mock_toolkit_list_v118` — liet ke 3 toolkit Composio
 *   MOCK v118 (canva/pandadoc/loom) + slug ung vien + cach xac thuc
 *   tung toolkit. Chay duoc ngay, khong can key.
 * - `composio_mock_toolkit_execute_v118` — chay mot tool mock bang
 *   du lieu mau local (khong goi mang, khong can key). Response
 *   luon mang `mock: true, live: false`.
 *
 * Polling v5 (1):
 * - `composio_poll_adaptive_v118` — tinh lich poll ke tiep cho mot
 *   connection theo outcome hit/miss/error: hit rut interval
 *   (burst ve min khi hit lien tiep), miss gian interval (idle cap
 *   o max khi miss lien tiep), error backoff; dedupe item moi theo
 *   id da thay; tra state serialize de persist. Ham thuan.
 *
 * Trigger instances (1):
 * - `composio_trigger_instances` — dang ky/liet ke/bat/tat/xoa
 *   trigger instance + suc khoe + lan fire cuoi. Luu trong bo nho
 *   (moi lan goi tool la mot store moi — host that giu store ben
 *   ngoai; tool nay dung de thao tac nhanh + kiem tra logic).
 *
 * OAuth state machine (1):
 * - `composio_oauth_state` — xem/chuyen trang thai OAuth cua mot
 *   connection (connected/connecting/expired/revoked/refreshing),
 *   auto-refresh mock (khong goi Composio that), tra UI state
 *   (nhan + badge + nut). Ham thuan.
 *
 * Webhook ingestion (1):
 * - `composio_webhook_ingest` — nhan mot delivery webhook Composio
 *   (raw body + header + dia chi remote): chi nhan loopback, verify
 *   chu ky HMAC bang mock secret do caller dua (KHONG phai secret
 *   that trong Vault), parse V3 document, route toi trigger
 *   instance, dedupe theo eventId. Khong goi mang, khong mo port.
 *
 * Tat ca 6 tool la ham thuan — chay duoc ngay ca khi chua bind,
 * khong doc/ghi file, khong can Composio API key.
 */

import type { Tool } from '@open-bot/core';
import {
  COMPOSIO_V118_MOCK_TOOLKITS,
  COMPOSIO_V118_TRIGGER_AUDIT_ACTIONS,
  ComposioV118WebhookIngester,
  MemoryComposioV118TriggerInstanceStore,
  MockComposioV118Executor,
  autoRefreshComposioV118OAuth,
  composioV118OAuthUiState,
  createComposioV118ConnState,
  createComposioV118OAuthEntry,
  createComposioV118TriggerInstance,
  decideComposioV118AutoRefresh,
  disableComposioV118TriggerInstance,
  enableComposioV118TriggerInstance,
  evaluateComposioV118TriggerHealth,
  filterComposioV118NewItems,
  isComposioV118TokenExpiringSoon,
  mockComposioV118ToolNeedsApproval,
  nextComposioV118Poll,
  parseComposioV118PollState,
  recordComposioV118TriggerFired,
  serializeComposioV118PollState,
  summarizeComposioV118TriggerInstances,
  summarizeMockComposioV118Catalogue,
  transitionComposioV118OAuth,
  validateComposioV118OAuthEntry,
  type ComposioV118OAuthState,
  type ComposioV118TriggerInstance,
} from '@open-bot/core';

export const COMPOSIO_V118_TOOL_NAMES = [
  'composio_mock_toolkit_list_v118',
  'composio_mock_toolkit_execute_v118',
  'composio_poll_adaptive_v118',
  'composio_trigger_instances',
  'composio_oauth_state',
  'composio_webhook_ingest',
] as const;

export function isComposioV118ToolName(name: string): boolean {
  return (COMPOSIO_V118_TOOL_NAMES as readonly string[]).includes(name);
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

const V118_OAUTH_STATES: readonly string[] = ['connected', 'connecting', 'expired', 'revoked', 'refreshing'];

export function createComposioV118Tools(): Tool[] {
  const mockToolkitListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list_v118',
      'List the 3 Composio MOCK toolkits v118 (canva/pandadoc/loom) with candidate tool slugs + auth kind/note per toolkit. Mock-only, no key, no network — slugs are candidates, NOT live-verified.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const summary = summarizeMockComposioV118Catalogue();
        return okResult({
          mock: true,
          live: false,
          totalToolkits: COMPOSIO_V118_MOCK_TOOLKITS.length,
          totalSlugs: summary.totalSlugs,
          writeSlugs: summary.writeSlugs,
          readSlugs: summary.readSlugs,
          toolkits: COMPOSIO_V118_MOCK_TOOLKITS.map((t) => ({
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
      'composio_mock_toolkit_execute_v118',
      'Run one mock Composio v118 tool with deterministic local sample data (no network, no key). The response always carries mock: true, live: false. Throws for unknown toolkits/slugs.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug: canva, pandadoc or loom.' },
        slug: { type: 'string', description: 'Candidate tool slug of that toolkit, e.g. CANVA_LIST_DESIGNS.' },
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
        const needsApproval = mockComposioV118ToolNeedsApproval(slug);
        const result = new MockComposioV118Executor().execute(toolkit, slug, toolArgs);
        return okResult({ ...result, needsApproval });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const pollAdaptiveTool: Tool = {
    definition: toolDef(
      'composio_poll_adaptive_v118',
      'Composio polling v5: given one connection poll state + last outcome (hit/miss/error) + polled item ids, compute the next poll time (hit shrinks the interval, burst goes straight to min on consecutive hits; miss grows it, idle caps at max on consecutive misses; errors back off), dedupe new vs duplicate items, and return the serialized state to persist. Pure function — no network, no key.',
      {
        connectionId: { type: 'string', description: 'Composio connection id.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. gmail.' },
        triggerSlug: { type: 'string', description: 'Trigger slug being polled, e.g. GMAIL_NEW_GMAIL_MESSAGE.' },
        outcome: { type: 'string', enum: ['hit', 'miss', 'error'], description: 'Outcome of the last poll.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
        baseIntervalMs: { type: 'number', description: 'Base interval ms (default: per-toolkit default).' },
        stateJson: { type: 'string', description: 'Optional serialized poll state from a previous run to resume from (overrides connection fields).' },
        newItemIds: { type: 'array', items: { type: 'string' }, description: 'Ids returned by the last poll (for dedupe).' },
        seenIds: { type: 'array', items: { type: 'string' }, description: 'Ids already seen (duplicates are filtered out).' },
        error: { type: 'string', description: 'Error message of the last poll (only with outcome=error).' },
        cursor: { type: 'string', description: 'Cursor returned by the last poll (null = none).' },
      },
      ['connectionId', 'toolkit', 'triggerSlug', 'outcome'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const outcome = getStringArg(args, 'outcome');
        if (outcome !== 'hit' && outcome !== 'miss' && outcome !== 'error') {
          throw new Error('outcome must be one of: hit, miss, error.');
        }
        let state = createComposioV118ConnState({
          connectionId: getStringArg(args, 'connectionId'),
          toolkit: getStringArg(args, 'toolkit'),
          triggerSlug: getStringArg(args, 'triggerSlug'),
          startAtMs: nowMs,
          ...(args['baseIntervalMs'] !== undefined && args['baseIntervalMs'] !== null
            ? { policy: { baseIntervalMs: getNumberArg(args, 'baseIntervalMs', 0) } }
            : {}),
        });
        const stateJson = getStringArg(args, 'stateJson', false);
        if (stateJson !== '') {
          state = parseComposioV118PollState(stateJson);
        }
        const seenIds = getStringArrayArg(args, 'seenIds');
        const newItemIds = getStringArrayArg(args, 'newItemIds');
        // Ghi seen cu vao state truoc khi tinh dedupe (de resume dung).
        const stateWithSeen = {
          ...state,
          policyState: {
            ...state.policyState,
            seenIds: seenIds.map((id) => ({ id, atMs: state.lastPollAtMs ?? nowMs })),
          },
        };
        const { fresh, duplicates } = filterComposioV118NewItems(
          newItemIds.map((id) => ({ id })),
          stateWithSeen,
          nowMs,
        );
        const error = getStringArg(args, 'error', false);
        const cursor =
          args['cursor'] !== undefined && args['cursor'] !== null ? getStringArg(args, 'cursor', false) : null;
        const next = nextComposioV118Poll(stateWithSeen, outcome, {
          nowMs,
          newItemIds: fresh.map((i) => i.id),
          ...(error !== '' ? { error } : {}),
          ...(cursor !== null ? { cursor } : {}),
        });
        return okResult({
          connectionId: next.connectionId,
          toolkit: next.toolkit,
          triggerSlug: next.triggerSlug,
          outcome,
          mode: next.policyState.consecutiveErrors > 0 ? 'error' : next.policyState.consecutiveHits >= next.burstAfterHits ? 'burst' : next.policyState.consecutiveMisses >= next.idleCapAfterMisses ? 'idle' : 'normal',
          currentIntervalMs: next.policyState.currentIntervalMs,
          consecutiveHits: next.policyState.consecutiveHits,
          consecutiveMisses: next.policyState.consecutiveMisses,
          consecutiveErrors: next.policyState.consecutiveErrors,
          nextPollAtMs: next.nextPollAtMs,
          freshItems: fresh.length,
          duplicateItems: duplicates.length,
          totalNewItems: next.totalNewItems,
          stateJson: serializeComposioV118PollState(next, nowMs),
          note: 'Pure computation — no live Composio call was made.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const triggerInstancesTool: Tool = {
    definition: toolDef(
      'composio_trigger_instances',
      'Manage Composio trigger instances registered in open-bot (metadata only — the trigger itself is created by the user in Composio): register/list/enable/disable/delete an instance, record a fire, and read health + last-fired. In-memory per call — the host keeps the durable store.',
      {
        action: {
          type: 'string',
          enum: ['register', 'list', 'enable', 'disable', 'delete', 'fire'],
          description: 'Action to run.',
        },
        triggerId: { type: 'string', description: 'Trigger instance id (ti_...). Required for register/enable/disable/delete/fire.' },
        triggerSlug: { type: 'string', description: 'Trigger slug, e.g. GITHUB_COMMIT_EVENT. Required for register.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. github. Required for register.' },
        connectionId: { type: 'string', description: 'Connected account id (ca_...). Required for register.' },
        label: { type: 'string', description: 'Display label for the instance (register only).' },
        note: { type: 'string', description: 'Free-form note (register only).' },
        instances: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Seed instances for list/enable/disable/delete/fire: array of {triggerId, triggerSlug, toolkit, connectionId, label?, status?, createdAtMs?, updatedAtMs?, lastFiredAtMs?, totalFired?, consecutiveErrors?, lastError?}. Without seeds, the store starts empty.',
        },
        status: { type: 'string', enum: ['enabled', 'disabled'], description: 'Filter by status (list only).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const action = getStringArg(args, 'action');
        if (!['register', 'list', 'enable', 'disable', 'delete', 'fire'].includes(action)) {
          throw new Error(`action must be one of: register, list, enable, disable, delete, fire.`);
        }
        const store = new MemoryComposioV118TriggerInstanceStore();
        for (const raw of getObjectArrayArg(args, 'instances')) {
          const seed = createComposioV118TriggerInstance(
            {
              triggerId: typeof raw['triggerId'] === 'string' ? raw['triggerId'] : '',
              triggerSlug: typeof raw['triggerSlug'] === 'string' ? raw['triggerSlug'] : '',
              toolkit: typeof raw['toolkit'] === 'string' ? raw['toolkit'] : '',
              connectionId: typeof raw['connectionId'] === 'string' ? raw['connectionId'] : '',
              ...(typeof raw['label'] === 'string' ? { label: raw['label'] } : {}),
              ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
            },
            typeof raw['createdAtMs'] === 'number' ? raw['createdAtMs'] : nowMs,
          );
          const full: ComposioV118TriggerInstance = {
            ...seed,
            status: raw['status'] === 'disabled' ? 'disabled' : 'enabled',
            updatedAtMs: typeof raw['updatedAtMs'] === 'number' ? raw['updatedAtMs'] : seed.updatedAtMs,
            lastFiredAtMs: typeof raw['lastFiredAtMs'] === 'number' ? raw['lastFiredAtMs'] : null,
            totalFired: typeof raw['totalFired'] === 'number' ? raw['totalFired'] : 0,
            consecutiveErrors: typeof raw['consecutiveErrors'] === 'number' ? raw['consecutiveErrors'] : 0,
            lastError: typeof raw['lastError'] === 'string' ? raw['lastError'] : null,
          };
          store.register(
            {
              triggerId: full.triggerId,
              triggerSlug: full.triggerSlug,
              toolkit: full.toolkit,
              connectionId: full.connectionId,
              label: full.label,
              status: full.status,
              ...(full.note !== undefined ? { note: full.note } : {}),
            },
            full.createdAtMs,
          );
          store.update(full);
        }
        if (action === 'list') {
          const status = getStringArg(args, 'status', false);
          const list = store.list(
            status === '' ? {} : { status: status as 'enabled' | 'disabled' },
            nowMs,
          );
          return okResult({
            total: list.length,
            instances: list.map((i) => ({ ...i, health: evaluateComposioV118TriggerHealth(i, nowMs) })),
            summary: summarizeComposioV118TriggerInstances(list, nowMs),
          });
        }
        const triggerId = getStringArg(args, 'triggerId');
        if (action === 'register') {
          const instance = store.register(
            {
              triggerId,
              triggerSlug: getStringArg(args, 'triggerSlug'),
              toolkit: getStringArg(args, 'toolkit'),
              connectionId: getStringArg(args, 'connectionId'),
              ...(getStringArg(args, 'label', false) !== '' ? { label: getStringArg(args, 'label', false) } : {}),
              ...(getStringArg(args, 'note', false) !== '' ? { note: getStringArg(args, 'note', false) } : {}),
            },
            nowMs,
          );
          return okResult({ action, instance: { ...instance, health: evaluateComposioV118TriggerHealth(instance, nowMs) } });
        }
        if (action === 'delete') {
          const removed = store.remove(triggerId);
          if (!removed) throw new Error(`unknown trigger instance id: ${triggerId}`);
          return okResult({ action, triggerId, removed: true });
        }
        const prev = store.get(triggerId);
        if (!prev) throw new Error(`unknown trigger instance id: ${triggerId}`);
        let next: ComposioV118TriggerInstance;
        if (action === 'enable') next = enableComposioV118TriggerInstance(prev, nowMs);
        else if (action === 'disable') next = disableComposioV118TriggerInstance(prev, nowMs);
        else next = recordComposioV118TriggerFired(prev, nowMs);
        store.update(next);
        return okResult({
          action,
          instance: { ...next, health: evaluateComposioV118TriggerHealth(next, nowMs) },
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const oauthStateTool: Tool = {
    definition: toolDef(
      'composio_oauth_state',
      'Composio OAuth state machine for one connection: inspect the state (connected/connecting/expired/revoked/refreshing), transition it (invalid transitions are rejected), or run a MOCK auto-refresh (no live Composio call — the mock refresher is chosen by refreshOutcome). Returns the UI state (label key, badge, action) for Settings → Composio.',
      {
        connectionId: { type: 'string', description: 'Composio connection id.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. gmail.' },
        action: {
          type: 'string',
          enum: ['inspect', 'transition', 'auto-refresh'],
          description: 'inspect = show current state + UI state; transition = move to `to` state; auto-refresh = run one mock refresh round.',
        },
        state: { type: 'string', enum: [...V118_OAUTH_STATES], description: 'Current OAuth state (default: connected).' },
        to: { type: 'string', enum: [...V118_OAUTH_STATES], description: 'Target state (transition only).' },
        reason: { type: 'string', description: 'Reason for the transition (transition only).' },
        expiresAtMs: { type: 'number', description: 'Epoch ms the token expires (null = unknown).' },
        refreshOutcome: {
          type: 'string',
          enum: ['success', 'error', 'revoked'],
          description: 'Mock refresh outcome (auto-refresh only, default success).',
        },
        refreshExpiresAtMs: { type: 'number', description: 'Expiry of the refreshed token (auto-refresh success only).' },
        autoRefreshAttempts: { type: 'number', description: 'Auto-refresh attempts used so far (default 0).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['connectionId', 'toolkit', 'action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const connectionId = getStringArg(args, 'connectionId');
        const toolkit = getStringArg(args, 'toolkit');
        const action = getStringArg(args, 'action');
        if (!['inspect', 'transition', 'auto-refresh'].includes(action)) {
          throw new Error('action must be one of: inspect, transition, auto-refresh.');
        }
        const stateArg = getStringArg(args, 'state', false);
        const state = (stateArg === '' ? 'connected' : stateArg) as ComposioV118OAuthState;
        if (!V118_OAUTH_STATES.includes(state)) throw new Error(`state must be one of: ${V118_OAUTH_STATES.join(', ')}.`);
        const expiresAtMs =
          args['expiresAtMs'] !== undefined && args['expiresAtMs'] !== null
            ? getNumberArg(args, 'expiresAtMs', 0)
            : null;
        const entry = createComposioV118OAuthEntry(connectionId, toolkit, { state, expiresAtMs, nowMs });
        entry.autoRefreshAttempts = Math.max(0, Math.trunc(getNumberArg(args, 'autoRefreshAttempts', 0)));
        validateComposioV118OAuthEntry(entry);
        if (action === 'inspect') {
          const decision = decideComposioV118AutoRefresh(entry, nowMs);
          return okResult({
            entry,
            ui: composioV118OAuthUiState(entry, nowMs),
            expiringSoon: isComposioV118TokenExpiringSoon(entry, nowMs),
            autoRefresh: decision,
          });
        }
        if (action === 'transition') {
          const to = getStringArg(args, 'to') as ComposioV118OAuthState;
          if (!V118_OAUTH_STATES.includes(to)) throw new Error(`to must be one of: ${V118_OAUTH_STATES.join(', ')}.`);
          const reason = getStringArg(args, 'reason', false);
          const { entry: next, audit } = transitionComposioV118OAuth(entry, to, reason === '' ? `${state} -> ${to}` : reason, { nowMs });
          return okResult({ entry: next, ui: composioV118OAuthUiState(next, nowMs), audit });
        }
        // auto-refresh (mock refresher — no live call).
        const refreshOutcome = getStringArg(args, 'refreshOutcome', false) || 'success';
        if (!['success', 'error', 'revoked'].includes(refreshOutcome)) {
          throw new Error('refreshOutcome must be one of: success, error, revoked.');
        }
        const refreshExpiresAtMs =
          args['refreshExpiresAtMs'] !== undefined && args['refreshExpiresAtMs'] !== null
            ? getNumberArg(args, 'refreshExpiresAtMs', 0)
            : null;
        const { entry: next, audits } = await autoRefreshComposioV118OAuth(
          entry,
          async () => {
            if (refreshOutcome === 'success') return { ok: true as const, expiresAtMs: refreshExpiresAtMs };
            if (refreshOutcome === 'revoked') return { ok: false as const, error: 'token revoked by the app', revoked: true as const };
            return { ok: false as const, error: 'mock refresh failed (network)' };
          },
          nowMs,
        );
        return okResult({
          entry: next,
          ui: composioV118OAuthUiState(next, nowMs),
          audits,
          note: 'Mock refresh — no live Composio call was made.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const webhookIngestTool: Tool = {
    definition: toolDef(
      'composio_webhook_ingest',
      'Ingest one Composio webhook delivery locally: only loopback senders are accepted; the HMAC signature is verified with the mock secret supplied by the caller (NOT the real Vault secret — never pass a real secret here); the V3 document is parsed and the event is routed to a registered trigger instance, with dedupe by event id. No network, no open port.',
      {
        rawBody: { type: 'string', description: 'Raw webhook body (V3 document JSON).' },
        webhookId: { type: 'string', description: 'webhook-id header value.' },
        timestamp: { type: 'string', description: 'webhook-timestamp header value (epoch seconds).' },
        signature: { type: 'string', description: 'webhook-signature header value (v1,<base64 HMAC>). Empty = use token fallback.' },
        mockSecret: { type: 'string', description: 'MOCK secret used to verify the signature (test only — never a real secret).' },
        token: { type: 'string', description: 'Token for the ?token= fallback (only when signature is empty).' },
        mockToken: { type: 'string', description: 'Stored MOCK token to compare ?token= against (test only).' },
        remoteAddress: { type: 'string', description: 'Remote address of the sender (default 127.0.0.1).' },
        path: { type: 'string', description: 'Request path (default /v1/composio/webhook).' },
        method: { type: 'string', description: 'HTTP method (default POST).' },
        registeredTriggerIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Trigger instance ids registered in open-bot (enabled). Events for other trigger ids are ignored-unknown-trigger.',
        },
        disabledTriggerIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Trigger instance ids registered but disabled — their events are ignored-disabled.',
        },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['rawBody', 'mockSecret'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const nowMs = getNumberArg(args, 'nowMs', Date.now());
        const rawBody = getStringArg(args, 'rawBody');
        const mockSecret = getStringArg(args, 'mockSecret');
        const registered = new Set(getStringArrayArg(args, 'registeredTriggerIds'));
        const disabled = new Set(getStringArrayArg(args, 'disabledTriggerIds'));
        const ingester = new ComposioV118WebhookIngester({
          getSecret: () => mockSecret,
          getToken: () => {
            const t = getStringArg(args, 'mockToken', false);
            return t === '' ? null : t;
          },
          lookupInstance: (triggerId) => {
            if (registered.has(triggerId)) {
              return {
                triggerId,
                triggerSlug: 'GITHUB_COMMIT_EVENT',
                toolkit: 'github',
                connectionId: 'ca_mock',
                label: triggerId,
                status: 'enabled' as const,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                lastFiredAtMs: null,
                totalFired: 0,
                consecutiveErrors: 0,
                lastError: null,
              };
            }
            if (disabled.has(triggerId)) {
              return {
                triggerId,
                triggerSlug: 'GITHUB_COMMIT_EVENT',
                toolkit: 'github',
                connectionId: 'ca_mock',
                label: triggerId,
                status: 'disabled' as const,
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                lastFiredAtMs: null,
                totalFired: 0,
                consecutiveErrors: 0,
                lastError: null,
              };
            }
            return undefined;
          },
          now: () => nowMs,
        });
        const result = ingester.ingest({
          method: getStringArg(args, 'method', false) || 'POST',
          path: getStringArg(args, 'path', false) || '/v1/composio/webhook',
          remoteAddress: getStringArg(args, 'remoteAddress', false) || '127.0.0.1',
          headers: {
            'webhook-id': getStringArg(args, 'webhookId', false),
            'webhook-timestamp': getStringArg(args, 'timestamp', false),
            'webhook-signature': getStringArg(args, 'signature', false),
          },
          rawBody,
          ...(getStringArg(args, 'token', false) !== '' ? { queryToken: getStringArg(args, 'token', false) } : {}),
        });
        return okResult({
          ...result,
          log: ingester.listLog(5),
          note: 'Mock secret only — the real Vault webhook secret is never passed to this tool.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    mockToolkitListTool,
    mockToolkitExecuteTool,
    pollAdaptiveTool,
    triggerInstancesTool,
    oauthStateTool,
    webhookIngestTool,
  ];
}

export const COMPOSIO_V118_TOOLS: Tool[] = createComposioV118Tools();

// Re-export de test khoi phai import tu core khi chi can hang audit.
export { COMPOSIO_V118_TRIGGER_AUDIT_ACTIONS };
