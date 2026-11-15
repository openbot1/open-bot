/**
 * Providers v2 tools (v1.08, Đội T4) — registered in ALL_TOOLS (see tools.ts).
 *
 * Three groups, 17 tools:
 *
 * Composio v2 (8) — the new Composio layer from packages/core/src/composio:
 * - `composio_v2_toolkit_poll` — poll toolkit connection statuses once now
 *   (baseline on first run, changes afterwards);
 * - `composio_v2_toolkit_status` — last-known status per toolkit + totals;
 * - `composio_v2_toolkit_enable` / `composio_v2_toolkit_disable` — turn a
 *   toolkit on/off for this user (persisted);
 * - `composio_v2_toolkit_health` — health-check one toolkit (or all);
 * - `composio_v2_trigger_map` / `composio_v2_trigger_unmap` — add/remove a
 *   trigger → internal-action mapping;
 * - `composio_v2_trigger_mappings` — list mappings (+ dry-run resolve).
 *
 * Provider health (5) — the ProviderHealthMonitor:
 * - `provider_health_status` — snapshot of one provider (or all);
 * - `provider_health_check` — probe one provider now;
 * - `provider_health_alerts` — recent down/recovered/quota alerts;
 * - `provider_health_history` — probe history of one provider;
 * - `provider_health_reset` — forget recorded state of one provider (or all).
 *
 * New providers (4) — OpenRouter + Fireworks AI, promoted from presets:
 * - `provider_openrouter_models` / `provider_fireworks_models` — live model
 *   list (known-model fallback when the endpoint is unreachable);
 * - `provider_openrouter_info` / `provider_fireworks_info` — base URL,
 *   default model, known models, whether a key is configured.
 *
 * Like the fleet v3 tools, these are placeholders in ALL_TOOLS until the
 * host binds them: `createProvidersV108Tools(opts)` wires the health
 * monitor, the status poller, the trigger-mapping store, the toolkit
 * connection manager and the optional status fetcher. Unbound, the
 * Composio/health tools answer with a clear "not configured" message
 * instead of guessing; the provider models/info tools work unbound too
 * (they only need the public model list + the known-model fallback, and
 * they never print a key — only whether one is configured).
 *
 * Nothing here calls Composio or a provider directly except through the
 * injected functions / createProvider: no key is read, logged or sent by
 * this file (the api-key getter returns the key to createProvider only).
 */

import type { Provider, ProviderConfig, Tool } from '@open-bot/core';
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_MODEL,
  FIREWORKS_KNOWN_MODELS,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_KNOWN_MODELS,
  PROVIDERS,
  createProvider as createCoreProvider,
} from '@open-bot/core';
import type {
  ComposioToolkitConnection,
  ComposioToolkitConnectionManager,
  ComposioToolkitStatusFetchFn,
  ComposioTriggerActionKind,
  ComposioTriggerMappingStore,
  ComposioToolkitStatusPoller,
  ProviderHealthMonitor,
  ProviderHealthSnapshot,
} from '@open-bot/core';

export const PROVIDERS_V108_TOOL_NAMES = [
  'composio_v2_toolkit_poll',
  'composio_v2_toolkit_status',
  'composio_v2_toolkit_enable',
  'composio_v2_toolkit_disable',
  'composio_v2_toolkit_health',
  'composio_v2_trigger_map',
  'composio_v2_trigger_unmap',
  'composio_v2_trigger_mappings',
  'provider_health_status',
  'provider_health_check',
  'provider_health_alerts',
  'provider_health_history',
  'provider_health_reset',
  'provider_openrouter_models',
  'provider_fireworks_models',
  'provider_openrouter_info',
  'provider_fireworks_info',
] as const;

/** Host wiring for the v1.08 provider tools (all optional — see header). */
export interface ProvidersV108ToolOptions {
  /** Health monitor (Settings → Providers dashboard data). */
  getHealthMonitor?: () => ProviderHealthMonitor | null | undefined;
  /** Toolkit-status poller (Composio connection statuses). */
  getToolkitStatusPoller?: () => ComposioToolkitStatusPoller | null | undefined;
  /** Trigger → action mapping store. */
  getTriggerMappingStore?: () => ComposioTriggerMappingStore | null | undefined;
  /** Per-toolkit connection manager (enable/disable + health). */
  getToolkitConnectionManager?: () => ComposioToolkitConnectionManager | null | undefined;
  /**
   * Status fetcher for health checks (host wires the router's
   * COMPOSIO_MANAGE_CONNECTIONS result). Without it,
   * `composio_v2_toolkit_health` reports "not configured".
   */
  getToolkitStatusFetcher?: () => ComposioToolkitStatusFetchFn | null | undefined;
  /** API key for a provider id (Vault) — only whether one exists is ever shown. */
  getProviderApiKey?: (providerId: string) => string | undefined;
  /** Provider factory (defaults to core createProvider; tests inject a stub). */
  createProviderFn?: (config: ProviderConfig) => Provider;
  /** Provider ids the health dashboard covers (defaults to all API providers). */
  listHealthProviderIds?: () => string[];
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

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Thiếu tham số bắt buộc: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Tham số "${name}" phải là chuỗi, nhận được ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Tham số "${name}" phải là boolean, nhận được ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Tham số "${name}" phải là số > 0.`);
  }
  return Math.floor(value);
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Tham số "${name}" phải là object.`);
  }
  return value as Record<string, unknown>;
}

function formatHealthSnapshot(snapshot: ProviderHealthSnapshot): string {
  const parts: string[] = [`${snapshot.providerId} (${snapshot.label}): ${snapshot.status}`];
  if (snapshot.lastLatencyMs !== undefined) parts.push(`${snapshot.lastLatencyMs}ms`);
  if (snapshot.lastCheckedAtMs !== undefined) {
    parts.push(`lần cuối ${new Date(snapshot.lastCheckedAtMs).toISOString()}`);
  }
  if (snapshot.uptimePct !== null) parts.push(`uptime ${snapshot.uptimePct}%`);
  if (snapshot.consecutiveFailures > 0) parts.push(`lỗi liên tiếp ${snapshot.consecutiveFailures}`);
  if (snapshot.lastError !== undefined) parts.push(`lỗi gần nhất: ${snapshot.lastError}`);
  if (snapshot.quota !== undefined) {
    const q = snapshot.quota;
    const remainingLimit =
      (q.remaining !== undefined ? `còn ${q.remaining}` : '') +
      (q.limit !== undefined ? `/${q.limit}` : '');
    const quotaText = [
      remainingLimit !== '' ? remainingLimit : undefined,
      q.resetAtMs !== undefined ? `reset ${new Date(q.resetAtMs).toISOString()}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (quotaText !== '') parts.push(`quota ${quotaText}${snapshot.quotaLow ? ' (THẤP)' : ''}`);
  }
  return `• ${parts.join(' — ')}`;
}

const NOT_WIRED_HEALTH =
  'provider health chưa được cấu hình trong host này (chưa có ProviderHealthMonitor) — mở Settings → Providers trên bản desktop thay vì dùng tool này.';
const NOT_WIRED_POLLER =
  'composio v2 chưa được cấu hình trong host này (chưa có ComposioToolkitStatusPoller) — mở Settings → Composio trên bản desktop thay vì dùng tool này.';
const NOT_WIRED_MAPPINGS =
  'composio v2 chưa được cấu hình trong host này (chưa có ComposioTriggerMappingStore) — mở Settings → Composio trên bản desktop thay vì dùng tool này.';
const NOT_WIRED_MANAGER =
  'composio v2 chưa được cấu hình trong host này (chưa có ComposioToolkitConnectionManager) — mở Settings → Composio trên bản desktop thay vì dùng tool này.';
const NOT_WIRED_FETCHER =
  'composio v2 chưa được cấu hình trong host này (chưa có status fetcher cho health check) — mở Settings → Composio trên bản desktop thay vì dùng tool này.';

/** API provider ids known to the health dashboard (CLI providers excluded — they have no HTTP endpoint to probe). */
function defaultHealthProviderIds(): string[] {
  return PROVIDERS.filter((p) => p.kind !== 'cli').map((p) => p.id);
}

interface NewProviderInfo {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  knownModels: string[];
}

const NEW_PROVIDERS: Record<string, NewProviderInfo> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: OPENROUTER_BASE_URL,
    defaultModel: OPENROUTER_DEFAULT_MODEL,
    knownModels: [...OPENROUTER_KNOWN_MODELS],
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: FIREWORKS_BASE_URL,
    defaultModel: FIREWORKS_DEFAULT_MODEL,
    knownModels: [...FIREWORKS_KNOWN_MODELS],
  },
};

/**
 * Build the 17 providers-v2 tools. Every resolver is lazy (called per
 * tool call, not at build time) so a host can wire managers after
 * startup; a missing manager makes only the tools that need it report
 * "not configured" — the others keep working.
 */
export function createProvidersV108Tools(
  options: ProvidersV108ToolOptions = {},
): Tool[] {
  const createProviderFn = options.createProviderFn ?? createCoreProvider;
  const getApiKey = options.getProviderApiKey ?? (() => undefined);
  const listHealthIds = options.listHealthProviderIds ?? defaultHealthProviderIds;

  // Unbound tools answer with a clear "not configured" message (same
  // shape as the fleet v3 placeholders) instead of throwing — the
  // agent sees guidance, not a crash. Each execute checks its own
  // manager and returns the matching NOT_WIRED_* string when missing.
  const getMonitor = (): ProviderHealthMonitor | null => options.getHealthMonitor?.() ?? null;
  const getPoller = (): ComposioToolkitStatusPoller | null => options.getToolkitStatusPoller?.() ?? null;
  const getMappingStore = (): ComposioTriggerMappingStore | null =>
    options.getTriggerMappingStore?.() ?? null;
  const getManager = (): ComposioToolkitConnectionManager | null =>
    options.getToolkitConnectionManager?.() ?? null;
  const getFetcher = (): ComposioToolkitStatusFetchFn | null =>
    options.getToolkitStatusFetcher?.() ?? null;

  const buildProviderModelsTool = (info: NewProviderInfo): Tool => ({
    definition: toolDef(
      `provider_${info.id}_models`,
      `Liệt kê model của ${info.label} (danh sách live từ API, fallback về model đã biết khi endpoint không trả về).`,
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const key = getApiKey(info.id);
      let provider: Provider;
      try {
        provider = createProviderFn({
          id: info.id,
          label: info.label,
          apiKey: key,
          baseUrl: info.baseUrl,
          defaultModel: info.defaultModel,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      let models: string[] = [...info.knownModels];
      let live = false;
      const listModels = (provider as { listModels?: () => Promise<string[]> }).listModels;
      if (typeof listModels === 'function') {
        try {
          const listed = await listModels.call(provider);
          if (Array.isArray(listed) && listed.length > 0) {
            models = listed;
            live = true;
          }
        } catch {
          // Unreachable endpoint — known-model fallback below.
        }
      }
      const lines = [
        `${info.label} models (${models.length}${live ? ', live' : ', fallback khi endpoint không trả về'}):`,
        ...models.map((m) => `• ${m}`),
        key ? 'API key: đã cấu hình.' : 'API key: chưa cấu hình (danh sách trên là model đã biết).',
      ];
      return lines.join('\n');
    },
  });

  const buildProviderInfoTool = (info: NewProviderInfo): Tool => ({
    definition: toolDef(
      `provider_${info.id}_info`,
      `Thông tin provider ${info.label}: base URL, model mặc định, model đã biết, key đã cấu hình chưa.`,
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const key = getApiKey(info.id);
      const meta = PROVIDERS.find((p) => p.id === info.id);
      return [
        `${info.label} (${info.id})`,
        `Base URL: ${info.baseUrl}`,
        `Model mặc định: ${info.defaultModel}`,
        `Cần API key: ${meta?.needsKey === true ? 'có' : 'không'}`,
        `API key: ${key ? 'đã cấu hình' : 'chưa cấu hình (nhập key trong Settings → Providers)'}`,
        `Model đã biết (${info.knownModels.length}): ${info.knownModels.join(', ')}`,
      ].join('\n');
    },
  });

  const tools: Tool[] = [
    {
      definition: toolDef(
        'composio_v2_toolkit_poll',
        'Poll trạng thái kết nối các toolkit Composio một lần ngay (lần đầu lập baseline, các lần sau báo toolkit nào đổi trạng thái).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        const poller = getPoller();
        if (!poller) return NOT_WIRED_POLLER;
        const result = await poller.pollNow();
        if (result.error !== undefined) {
          return errorResult(`Poll trạng thái Composio lỗi: ${result.error} (giữ trạng thái cũ, lần sau poll lại).`);
        }
        const lines = [
          `Đã poll ${result.checked} toolkit lúc ${new Date(result.polledAtMs).toISOString()}: ${result.changes.length} thay đổi.`,
        ];
        for (const change of result.changes) {
          const label = change.accountLabel !== undefined ? ` (${change.accountLabel})` : '';
          lines.push(`• ${change.toolkit}: ${change.from} → ${change.to}${label}`);
        }
        if (result.changes.length === 0) lines.push('Không có toolkit nào đổi trạng thái.');
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'composio_v2_toolkit_status',
        'Trạng thái kết nối từng toolkit Composio (lần poll cuối, toolkit nào active/initiated/none, tổng quan enable/disable).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        const poller = getPoller();
        if (!poller) return NOT_WIRED_POLLER;
        const status = poller.getStatus();
        const lines = [
          `Composio toolkit status — poll lần cuối: ${status.lastPolledAtMs > 0 ? new Date(status.lastPolledAtMs).toISOString() : 'chưa poll lần nào'}, ` +
            `chu kỳ ${Math.round(status.intervalMs / 60000)} phút, tổng ${status.totalPolls} lần poll, ${status.totalChanges} thay đổi.`,
        ];
        if (status.lastError !== undefined) lines.push(`Lỗi poll gần nhất: ${status.lastError}`);
        for (const entry of status.toolkits) {
          const label = entry.accountLabel !== undefined ? ` (${entry.accountLabel})` : '';
          lines.push(`• ${entry.toolkit}: ${entry.seen ? entry.status : 'chưa poll'}${label}`);
        }
        const manager = getManager();
        if (manager) {
          const summary = manager.summary();
          lines.push(
            `Tổng quan kết nối: ${summary.enabled}/${summary.total} toolkit bật, ${summary.active} active, ${summary.initiated} initiated, ${summary.none} none` +
              (summary.unhealthy.length > 0 ? `, cần chú ý: ${summary.unhealthy.join(', ')}` : ', không có toolkit nào cần chú ý.'),
          );
        }
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'composio_v2_toolkit_enable',
        'Bật một toolkit Composio (toolkit được bật lại được agent dùng, được poll trạng thái và tính vào health).',
        { toolkit: { type: 'string', description: 'Toolkit slug, vd "gmail".' } },
        ['toolkit'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const manager = getManager();
        if (!manager) return NOT_WIRED_MANAGER;
        const toolkit = getStringArg(args, 'toolkit');
        try {
          const state = manager.setEnabled(toolkit, true);
          return `Đã bật toolkit ${state.toolkit} (trạng thái hiện tại: ${state.status}).`;
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'composio_v2_toolkit_disable',
        'Tắt một toolkit Composio (toolkit bị tắt không được agent dùng, không bị poll, không tính là unhealthy).',
        { toolkit: { type: 'string', description: 'Toolkit slug, vd "slack".' } },
        ['toolkit'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const manager = getManager();
        if (!manager) return NOT_WIRED_MANAGER;
        const toolkit = getStringArg(args, 'toolkit');
        try {
          const state = manager.setEnabled(toolkit, false);
          return `Đã tắt toolkit ${state.toolkit} (trạng thái giữ nguyên: ${state.status}).`;
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'composio_v2_toolkit_health',
        'Health-check toolkit Composio: một toolkit (toolkit=...) hoặc tất cả toolkit đang bật (không tham số).',
        { toolkit: { type: 'string', description: 'Toolkit slug cần check (bỏ trống = tất cả toolkit đang bật).' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        const manager = getManager();
        if (!manager) return NOT_WIRED_MANAGER;
        const fetcher = getFetcher();
        if (!fetcher) return NOT_WIRED_FETCHER;
        const toolkit = getStringArg(args, 'toolkit', false);
        if (toolkit !== '') {
          try {
            const fetchOne = async (slug: string): Promise<ComposioToolkitConnection> => {
              const list = await fetcher();
              const found = list.find((entry) => entry.toolkit === slug);
              if (!found) throw new Error(`health check không trả về toolkit ${slug}`);
              return found;
            };
            const state = await manager.healthCheck(toolkit, fetchOne);
            const lines = [
              `${state.toolkit}: ${state.enabled ? 'bật' : 'tắt'} — ${state.status}` +
                (state.accountLabel !== undefined ? ` (${state.accountLabel})` : '') +
                (state.lastCheckedAtMs !== undefined ? `, check lúc ${new Date(state.lastCheckedAtMs).toISOString()}` : ''),
            ];
            if (state.lastError !== undefined) lines.push(`Lỗi: ${state.lastError} (lỗi liên tiếp: ${state.consecutiveFailures})`);
            return lines.join('\n');
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
        const result = await manager.healthCheckAll(fetcher);
        const lines = [
          `Health-check ${result.enabled}/${result.total} toolkit đang bật: ${result.active} active, ${result.initiated} initiated, ${result.none} none.`,
        ];
        if (result.error !== undefined) lines.push(`Lỗi chung: ${result.error}`);
        if (result.unhealthy.length > 0) lines.push(`Cần chú ý: ${result.unhealthy.join(', ')}`);
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'composio_v2_trigger_map',
        'Tạo mapping trigger Composio → action nội bộ (automation / tool nội bộ / notify).',
        {
          triggerSlug: { type: 'string', description: 'Trigger slug Composio, vd "GMAIL_NEW_GMAIL_MESSAGE".' },
          actionKind: { type: 'string', description: '"automation", "tool" hoặc "notify".', enum: ['automation', 'tool', 'notify'] },
          target: { type: 'string', description: 'Automation id, tên tool nội bộ (snake_case), hoặc template notify với {placeholder}.' },
          args: { type: 'object', description: 'Arg cố định cho tool call (chỉ dùng với actionKind "tool").' },
          enabled: { type: 'boolean', description: 'Bật mapping ngay (mặc định true).' },
          description: { type: 'string', description: 'Ghi chú cho mapping.' },
        },
        ['triggerSlug', 'actionKind', 'target'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const store = getMappingStore();
        if (!store) return NOT_WIRED_MAPPINGS;
        const triggerSlug = getStringArg(args, 'triggerSlug');
        const actionKind = getStringArg(args, 'actionKind') as ComposioTriggerActionKind;
        const target = getStringArg(args, 'target');
        const mappingArgs = getObjectArg(args, 'args');
        const enabled = getBoolArg(args, 'enabled', true);
        const description = getStringArg(args, 'description', false);
        try {
          const mapping = store.create({
            triggerSlug,
            actionKind,
            target,
            ...(mappingArgs !== undefined ? { args: mappingArgs } : {}),
            enabled,
            ...(description !== '' ? { description } : {}),
          });
          return `Đã tạo mapping ${mapping.id}: ${mapping.triggerSlug} → ${mapping.actionKind}:${mapping.target} (${mapping.enabled ? 'bật' : 'tắt'}).`;
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'composio_v2_trigger_unmap',
        'Xoá một mapping trigger Composio (theo id mapping).',
        { id: { type: 'string', description: 'Id mapping (map_...), xem composio_v2_trigger_mappings.' } },
        ['id'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const store = getMappingStore();
        if (!store) return NOT_WIRED_MAPPINGS;
        const id = getStringArg(args, 'id');
        const removed = store.remove(id);
        return removed ? `Đã xoá mapping ${id}.` : `Không có mapping ${id}.`;
      },
    },
    {
      definition: toolDef(
        'composio_v2_trigger_mappings',
        'Liệt kê mapping trigger Composio (lọc theo triggerSlug, kèm dry-run resolve khi có eventData).',
        {
          triggerSlug: { type: 'string', description: 'Chỉ liệt kê mapping của trigger này (bỏ trống = tất cả).' },
          includeDisabled: { type: 'boolean', description: 'Kèm mapping đã tắt (mặc định false — chỉ mapping đang bật).' },
          eventData: { type: 'object', description: 'Payload event để dry-run resolve (kèm triggerSlug) — không chạy action thật.' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        const store = getMappingStore();
        if (!store) return NOT_WIRED_MAPPINGS;
        const triggerSlug = getStringArg(args, 'triggerSlug', false);
        const includeDisabled = getBoolArg(args, 'includeDisabled', false);
        const eventData = getObjectArg(args, 'eventData');
        let mappings = store.list();
        if (triggerSlug !== '') mappings = mappings.filter((m) => m.triggerSlug === triggerSlug);
        if (!includeDisabled) mappings = mappings.filter((m) => m.enabled);
        const lines = [`Trigger mappings (${mappings.length}${triggerSlug !== '' ? ` cho ${triggerSlug}` : ''}):`];
        for (const mapping of mappings) {
          lines.push(
            `• ${mapping.id}: ${mapping.triggerSlug} → ${mapping.actionKind}:${mapping.target}` +
              (mapping.enabled ? '' : ' (tắt)') +
              (mapping.description !== undefined ? ` — ${mapping.description}` : ''),
          );
        }
        if (mappings.length === 0) lines.push('Chưa có mapping nào.');
        if (triggerSlug !== '' && eventData !== undefined) {
          const resolved = store.resolve({ triggerSlug, data: eventData });
          lines.push(
            `Dry-run resolve ${triggerSlug}: ${resolved.actions.length} action(s)` +
              (resolved.knownSlug ? '' : ' (slug chưa có trong danh sách gợi ý — vẫn resolve được).'),
          );
          for (const action of resolved.actions) {
            lines.push(
              `• ${action.actionKind}:${action.target}` +
                (action.text !== undefined ? ` — "${action.text}"` : ''),
            );
          }
        }
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'provider_health_status',
        'Trạng thái sức khoẻ provider: một provider (providerId=...) hoặc tất cả provider API (up/down, latency, lỗi gần nhất, quota).',
        { providerId: { type: 'string', description: 'Id provider, vd "openrouter" (bỏ trống = tất cả).' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        const monitor = getMonitor();
        if (!monitor) return NOT_WIRED_HEALTH;
        const providerId = getStringArg(args, 'providerId', false);
        if (providerId !== '') {
          return formatHealthSnapshot(monitor.getSnapshot(providerId));
        }
        const snapshots = monitor.getAllSnapshots(listHealthIds());
        const summary = monitor.summary(listHealthIds());
        const lines = [
          `Provider health: ${summary.up} up, ${summary.degraded} degraded, ${summary.down} down, ${summary.unknown} chưa check (tổng ${summary.total}).`,
        ];
        for (const snapshot of snapshots) lines.push(formatHealthSnapshot(snapshot));
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'provider_health_check',
        'Probe một provider ngay (GET /models, không tốn token chat) và ghi lại latency/lỗi/quota.',
        { providerId: { type: 'string', description: 'Id provider cần probe, vd "fireworks".' } },
        ['providerId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        const monitor = getMonitor();
        if (!monitor) return NOT_WIRED_HEALTH;
        const providerId = getStringArg(args, 'providerId');
        const snapshot = await monitor.check(providerId);
        return formatHealthSnapshot(snapshot);
      },
    },
    {
      definition: toolDef(
        'provider_health_alerts',
        'Cảnh báo provider gần đây (provider chết, hồi phục, quota thấp) — mới nhất trước.',
        { limit: { type: 'number', description: 'Số cảnh báo tối đa (mặc định 10).' } },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        const monitor = getMonitor();
        if (!monitor) return NOT_WIRED_HEALTH;
        const limit = getNumberArg(args, 'limit', 10);
        const alerts = monitor.getAlerts(limit);
        if (alerts.length === 0) return 'Chưa có cảnh báo provider nào.';
        const lines = [`Provider alerts (${alerts.length}):`];
        for (const alert of alerts) {
          lines.push(`• [${alert.kind}] ${alert.providerId} — ${alert.message} (${new Date(alert.atMs).toISOString()})`);
        }
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'provider_health_history',
        'Lịch sử probe của một provider (latency, lỗi, quota từng lần) — mới nhất trước.',
        {
          providerId: { type: 'string', description: 'Id provider, vd "openrouter".' },
          limit: { type: 'number', description: 'Số mẫu tối đa (mặc định 10).' },
        },
        ['providerId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        const monitor = getMonitor();
        if (!monitor) return NOT_WIRED_HEALTH;
        const providerId = getStringArg(args, 'providerId');
        const limit = getNumberArg(args, 'limit', 10);
        const history = monitor.getHistory(providerId, limit);
        if (history.length === 0) return `Provider ${providerId} chưa được probe lần nào.`;
        const lines = [`Lịch sử ${providerId} (${history.length} mẫu mới nhất):`];
        for (const sample of history) {
          lines.push(
            `• ${new Date(sample.checkedAtMs).toISOString()} — ${sample.ok ? 'ok' : 'FAIL'} ${sample.latencyMs}ms` +
              (sample.error !== undefined ? ` — ${sample.error}` : '') +
              (sample.quota?.remaining !== undefined ? ` — quota còn ${sample.quota.remaining}` : ''),
          );
        }
        return lines.join('\n');
      },
    },
    {
      definition: toolDef(
        'provider_health_reset',
        'Quên trạng thái health đã ghi của một provider (hoặc tất cả khi bỏ trống providerId) — provider về "unknown".',
        { providerId: { type: 'string', description: 'Id provider cần reset (bỏ trống = tất cả).' } },
        [],
      ),
      needsApproval: true,
      execute: async (args) => {
        const monitor = getMonitor();
        if (!monitor) return NOT_WIRED_HEALTH;
        const providerId = getStringArg(args, 'providerId', false);
        monitor.reset(providerId !== '' ? providerId : undefined);
        return providerId !== ''
          ? `Đã reset health của provider ${providerId} (về unknown).`
          : 'Đã reset health của tất cả provider (về unknown).';
      },
    },
    buildProviderModelsTool(NEW_PROVIDERS.openrouter as NewProviderInfo),
    buildProviderModelsTool(NEW_PROVIDERS.fireworks as NewProviderInfo),
    buildProviderInfoTool(NEW_PROVIDERS.openrouter as NewProviderInfo),
    buildProviderInfoTool(NEW_PROVIDERS.fireworks as NewProviderInfo),
  ];

  return tools;
}

/** Unbound placeholders (đăng ký vào ALL_TOOLS; host bind lại bằng factory). */
export const PROVIDERS_V108_TOOLS: Tool[] = createProvidersV108Tools();
