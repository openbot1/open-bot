/**
 * Voice v24 tools for @open-bot/tools (v1.37, Đội T5).
 *
 * The agent drives the voice v24 session stack by tool call:
 *  - voice_v24_timers    — per-tool-call timers: start/end/
 *    fail/cancel a call, live running calls with elapsed time,
 *    per-tool and per-session aggregates, threshold alerts,
 *    live threshold check, markdown
 *  - voice_v24_providers — dynamic provider catalogue: register
 *    a detected provider, record a host-measured probe, list
 *    providers with live status, usable providers, models,
 *    find a model, providers needing a probe, markdown
 *  - voice_v24_model     — mid-session model switch: switch to
 *    a catalogued model (transcript checksummed before/after),
 *    roll back to the previous model, current model, history
 *  - voice_v24_health    — provider health: record probes,
 *    score / grade / degraded per provider, worst-first list,
 *    mean score, prune old probes, markdown
 *  - voice_v24_session   — a live voice session: open, add
 *    transcript turns, start/end/fail tool calls, switch or
 *    roll back the model, auto-fallback, snapshot, close
 *    (cancels running calls), summary/markdown
 *  - voice_v24_panel     — timer + provider panel snapshot /
 *    markdown for one session (running calls, finished table,
 *    alerts, dynamic providers, switches, health)
 *  - voice_v24_report    — aggregate report across sessions,
 *    providers and health: totals, slowest tools, degraded
 *    providers, switch counts, markdown
 *  - voice_v24_fallback  — model fallback chains: set the
 *    ordered chain, pick the next usable model, links with
 *    live usability, decision history
 *  - voice_v24_budgets   — tool-call time budgets: per-tool
 *    and per-session budgets, breach checks, burn-down
 *
 * SAFETY: everything here is local — timers are virtual-clock
 * arithmetic, providers are caller-supplied descriptors,
 * probes are caller-supplied measurements, transcripts are
 * caller-supplied text. No provider is dialled, no key is
 * read or stored, no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV24Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V24_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  DynamicProviderCatalogV24,
  ModelFallbackChainV24,
  ProviderHealthTrackerV24,
  ProviderRefreshSchedulerV24,
  TimerPanelV24,
  ToolBudgetRegistryV24,
  ToolCallTimerRegistryV24,
  VoiceModelSwitcherV24,
  VoiceSessionV24,
  createDynamicProviderCatalogV24,
  createModelFallbackChainV24,
  createProviderHealthTrackerV24,
  createProviderRefreshSchedulerV24,
  createTimerPanelV24,
  createToolBudgetRegistryV24,
  createToolCallTimerRegistryV24,
  formatDurationV24,
  providerDescriptorV24,
  type DynamicProviderCatalogV24Options,
  type ModelFallbackV24Options,
  type ModelSwitchV24Options,
  type ProviderHealthV24Options,
  type ProviderRefreshV24Options,
  type TimerPanelV24Options,
  type ToolBudgetV24Options,
  type ToolCallTimerV24Options,
  type VoiceV24ModelRef,
  type VoiceV24ProviderDescriptor,
  type VoiceV24TranscriptTurn,
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
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a finite number, got ${String(value)}`);
  }
  return value;
}

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  throw new Error(`Argument "${name}" must be a boolean, got ${String(value)}`);
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

function parseJsonArg(value: string | undefined, name: string): unknown {
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Argument "${name}" is not valid JSON`);
  }
}

function parseTranscriptArg(value: string | undefined): VoiceV24TranscriptTurn[] {
  const raw = parseJsonArg(value, 'transcriptJson');
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('transcriptJson must be a JSON array');
  const turns: VoiceV24TranscriptTurn[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (typeof item !== 'object' || item === null) throw new Error('transcriptJson entries must be objects');
    const role = item.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new Error('transcriptJson entries need role "user" | "assistant" | "system"');
    }
    if (typeof item.text !== 'string') throw new Error('transcriptJson entries need a string "text"');
    if (typeof item.atMs !== 'number') throw new Error('transcriptJson entries need a numeric "atMs"');
    turns.push({ role, text: item.text, atMs: item.atMs });
  }
  return turns;
}

function parseModelRefArray(value: string | undefined, name: string): VoiceV24ModelRef[] {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${name} must be a JSON array`);
  const refs: VoiceV24ModelRef[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (typeof item !== 'object' || item === null) throw new Error(`${name} entries must be objects`);
    if (typeof item.providerId !== 'string' || typeof item.model !== 'string') {
      throw new Error(`${name} entries need string "providerId" and "model"`);
    }
    refs.push({ providerId: item.providerId, model: item.model });
  }
  return refs;
}

export interface VoiceV24ToolOptions {
  /** Shared timer registry accessor. */
  getTimers?: () => ToolCallTimerRegistryV24 | null;
  /** Dynamic catalogue accessor. */
  getCatalog?: () => DynamicProviderCatalogV24 | null;
  /** Health tracker accessor. */
  getHealth?: () => ProviderHealthTrackerV24 | null;
  /** Panel accessor. */
  getPanel?: () => TimerPanelV24 | null;
  /** Tool budget registry accessor. */
  getBudgets?: () => ToolBudgetRegistryV24 | null;
  /** Refresh scheduler accessor. */
  getRefresh?: () => ProviderRefreshSchedulerV24 | null;
  timerOptions?: Partial<ToolCallTimerV24Options>;
  catalogOptions?: Partial<DynamicProviderCatalogV24Options>;
  healthOptions?: Partial<ProviderHealthV24Options>;
  panelOptions?: Partial<TimerPanelV24Options>;
  switchOptions?: Partial<ModelSwitchV24Options>;
  budgetOptions?: Partial<ToolBudgetV24Options>;
  refreshOptions?: Partial<ProviderRefreshV24Options>;
  fallbackOptions?: Partial<ModelFallbackV24Options>;
}

const TIMER_ACTIONS = ['start', 'end', 'fail', 'cancel', 'running', 'stats', 'session', 'alerts', 'check', 'markdown', 'reset'] as const;
const PROVIDER_ACTIONS = ['register', 'remove', 'probe', 'list', 'status', 'usable', 'models', 'find', 'needs-probe', 'counts', 'markdown', 'refresh-due', 'refresh-record', 'refresh-state'] as const;
const MODEL_ACTIONS = ['switch', 'rollback', 'current', 'history', 'models-used', 'summary'] as const;
const HEALTH_ACTIONS = ['record', 'score', 'list', 'degraded', 'mean', 'prune', 'markdown'] as const;
const SESSION_ACTIONS = ['open', 'turn', 'tool-start', 'tool-end', 'tool-fail', 'switch', 'rollback', 'snapshot', 'close', 'summary', 'markdown', 'auto-fallback'] as const;
const PANEL_ACTIONS = ['snapshot', 'markdown'] as const;
const REPORT_ACTIONS = ['summary', 'markdown'] as const;
const FALLBACK_ACTIONS = ['set-chain', 'pick', 'links', 'history', 'summary'] as const;
const BUDGET_ACTIONS = ['set', 'get', 'set-session', 'check', 'breaches', 'burndown', 'summary'] as const;

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

export function createVoiceV24Tools(opts: VoiceV24ToolOptions = {}): Tool[] {
  const defaultTimers = createToolCallTimerRegistryV24(opts.timerOptions);
  const defaultCatalog = createDynamicProviderCatalogV24(opts.catalogOptions);
  const defaultHealth = createProviderHealthTrackerV24(opts.healthOptions);
  const defaultPanel = createTimerPanelV24(opts.panelOptions);
  const defaultBudgets = createToolBudgetRegistryV24(opts.budgetOptions);
  const defaultRefresh = createProviderRefreshSchedulerV24(opts.refreshOptions);
  const needTimers = (): ToolCallTimerRegistryV24 => opts.getTimers?.() ?? defaultTimers;
  const needCatalog = (): DynamicProviderCatalogV24 => opts.getCatalog?.() ?? defaultCatalog;
  const needHealth = (): ProviderHealthTrackerV24 => opts.getHealth?.() ?? defaultHealth;
  const needPanel = (): TimerPanelV24 => opts.getPanel?.() ?? defaultPanel;
  const needBudgets = (): ToolBudgetRegistryV24 => opts.getBudgets?.() ?? defaultBudgets;
  const needRefresh = (): ProviderRefreshSchedulerV24 => opts.getRefresh?.() ?? defaultRefresh;
  /** Fallback chains, one per session id (set through voice_v24_fallback). */
  const chains = new Map<string, ModelFallbackChainV24>();
  /** Live voice sessions opened through voice_v24_session. */
  const sessions = new Map<string, VoiceSessionV24>();
  /** Standalone switchers for voice_v24_model (one per session id). */
  const switchers = new Map<string, VoiceModelSwitcherV24>();

  const needSwitcher = (sessionId: string, initial: VoiceV24ModelRef): VoiceModelSwitcherV24 => {
    const existing = switchers.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new VoiceModelSwitcherV24(sessionId, initial, opts.switchOptions ?? {});
    switchers.set(sessionId, created);
    return created;
  };

  const timersTool: Tool = {
    definition: toolDef(
      'voice_v24_timers',
      'Per-tool-call timers in a voice session (local action): start a timer when the bot calls a tool, end/fail/cancel it when the call returns, read live running calls with elapsed time, per-tool and per-session aggregates (mean/p95/max/slow), threshold alerts, or a live threshold check that flags running calls past slow/timeout without waiting for them to finish.',
      {
        action: { type: 'string', description: 'start, end, fail, cancel, running, stats, session, alerts, check, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        toolName: { type: 'string', description: 'Tool name (start / stats).' },
        callId: { type: 'string', description: 'Timer id returned by start (end / fail / cancel).' },
        turnIndex: { type: 'number', description: 'Turn index the call belongs to (start, optional, default 0).' },
        error: { type: 'string', description: 'Error text (fail).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(TIMER_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${TIMER_ACTIONS.join(', ')})`);
        const timers = needTimers();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'reset') {
          timers.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'check') {
          const raised = timers.checkRunning(atMs);
          return JSON.stringify({ ok: true, raised, alerts: timers.alertsList() });
        }
        if (action === 'alerts') {
          return JSON.stringify({ ok: true, alerts: timers.alertsList(getOptionalStringArg(args, 'sessionId')) });
        }
        if (action === 'running') {
          return JSON.stringify({ ok: true, running: timers.running(getOptionalStringArg(args, 'sessionId'), atMs) });
        }
        if (action === 'stats') {
          const toolName = getStringArg(args, 'toolName');
          return JSON.stringify({ ok: true, ...timers.toolStats(toolName, getOptionalStringArg(args, 'sessionId')) });
        }
        if (action === 'session') {
          const sessionId = getStringArg(args, 'sessionId');
          return JSON.stringify({ ok: true, ...timers.sessionStats(sessionId) });
        }
        if (action === 'markdown') {
          const sessionId = getStringArg(args, 'sessionId');
          return JSON.stringify({ ok: true, markdown: timers.markdown(sessionId), stats: timers.sessionStats(sessionId) });
        }
        if (action === 'start') {
          const sessionId = getStringArg(args, 'sessionId');
          const toolName = getStringArg(args, 'toolName');
          const turnIndex = getOptionalNumberArg(args, 'turnIndex') ?? 0;
          const callId = timers.start(sessionId, toolName, atMs, turnIndex);
          return JSON.stringify({ ok: true, callId, record: timers.get(callId) });
        }
        const callId = getStringArg(args, 'callId');
        if (action === 'fail') {
          const record = timers.fail(callId, atMs, getStringArg(args, 'error'));
          return JSON.stringify({ ok: true, record, duration: formatDurationV24(record.durationMs ?? 0) });
        }
        if (action === 'cancel') {
          const record = timers.cancel(callId, atMs);
          return JSON.stringify({ ok: true, record });
        }
        const record = timers.end(callId, atMs);
        return JSON.stringify({ ok: true, record, duration: formatDurationV24(record.durationMs ?? 0) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const providersTool: Tool = {
    definition: toolDef(
      'voice_v24_providers',
      'Dynamic provider/model catalogue for the voice model picker (local action): register a provider the host actually detected (never a hard-coded list), record a host-measured probe, list providers with live status (online/degraded/unknown/offline/unconfigured), usable providers only, models of one provider, find one model, providers whose probe is stale, or refresh scheduling (which providers are due for a re-probe, record a refresh round, per-provider refresh state). No provider is dialled and no key is read.',
      {
        action: { type: 'string', description: 'register, remove, probe, list, status, usable, models, find, needs-probe, counts, markdown, refresh-due, refresh-record or refresh-state.' },
        providerJson: { type: 'string', description: 'Provider descriptor as JSON {id, label, kind, models, configured, accountLabel?, source} (register).' },
        providerId: { type: 'string', description: 'Provider id.' },
        model: { type: 'string', description: 'Model id (find).' },
        ok: { type: 'string', description: '"true" when the probe succeeded (probe).' },
        latencyMs: { type: 'number', description: 'Probe round-trip ms (probe, optional).' },
        error: { type: 'string', description: 'Probe error text (probe, optional).' },
        resultsJson: { type: 'string', description: 'Refresh-round results as JSON [{providerId, ok}] (refresh-record).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(PROVIDER_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${PROVIDER_ACTIONS.join(', ')})`);
        const catalog = needCatalog();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'register') {
          const raw = parseJsonArg(getOptionalStringArg(args, 'providerJson'), 'providerJson');
          if (typeof raw !== 'object' || raw === null) return errorResult('providerJson must be a JSON object');
          const descriptor = providerDescriptorV24(raw as Omit<VoiceV24ProviderDescriptor, 'models' | 'configured' | 'source'> & Partial<Pick<VoiceV24ProviderDescriptor, 'models' | 'configured' | 'source'>>);
          catalog.register(descriptor, atMs);
          return JSON.stringify({ ok: true, provider: catalog.snapshot(descriptor.id, atMs) });
        }
        if (action === 'list') {
          return JSON.stringify({ ok: true, providers: catalog.list(atMs), counts: catalog.counts(atMs), summary: catalog.summary(atMs) });
        }
        if (action === 'counts') {
          return JSON.stringify({ ok: true, ...catalog.counts(atMs), summary: catalog.summary(atMs) });
        }
        if (action === 'usable') {
          return JSON.stringify({ ok: true, providers: catalog.usable(atMs) });
        }
        if (action === 'needs-probe') {
          return JSON.stringify({ ok: true, providerIds: catalog.needsProbe(atMs) });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: catalog.markdown(atMs) });
        }
        if (action === 'refresh-due') {
          const refresh = needRefresh();
          const configured = (id: string): boolean => catalog.get(id)?.configured ?? false;
          return JSON.stringify({
            ok: true,
            due: refresh.dueList(atMs, configured),
            summary: refresh.summary(atMs),
            freshness: refresh.freshness(catalog.ids(), atMs, configured),
          });
        }
        if (action === 'refresh-record') {
          const refresh = needRefresh();
          const resultsRaw = parseJsonArg(getOptionalStringArg(args, 'resultsJson'), 'resultsJson');
          if (!Array.isArray(resultsRaw)) return errorResult('resultsJson must be a JSON array of {providerId, ok}');
          const results: { providerId: string; ok: boolean }[] = [];
          for (const item of resultsRaw as Record<string, unknown>[]) {
            if (typeof item !== 'object' || item === null || typeof item.providerId !== 'string' || typeof item.ok !== 'boolean') {
              return errorResult('resultsJson entries need string "providerId" and boolean "ok"');
            }
            results.push({ providerId: item.providerId, ok: item.ok });
          }
          const configured = (id: string): boolean => catalog.get(id)?.configured ?? false;
          const round = refresh.recordRound(results, atMs, configured);
          return JSON.stringify({ ok: true, ...round });
        }
        if (action === 'refresh-state') {
          const refresh = needRefresh();
          const providerId = getStringArg(args, 'providerId');
          const state = refresh.stateOf(providerId);
          if (state === null) return errorResult(`Provider "${providerId}" is not tracked for refresh`);
          return JSON.stringify({ ok: true, ...state });
        }
        const providerId = getStringArg(args, 'providerId');
        if (action === 'remove') {
          const removed = catalog.remove(providerId);
          if (!removed) return errorResult(`No provider "${providerId}".`);
          return JSON.stringify({ ok: true, removed: true, providers: catalog.list(atMs) });
        }
        if (action === 'probe') {
          const ok = getOptionalBooleanArg(args, 'ok');
          if (ok === undefined) return errorResult('Missing required argument: "ok"');
          catalog.recordProbe({
            providerId,
            atMs,
            ok,
            latencyMs: getOptionalNumberArg(args, 'latencyMs'),
            error: getOptionalStringArg(args, 'error'),
          });
          return JSON.stringify({ ok: true, provider: catalog.snapshot(providerId, atMs) });
        }
        if (action === 'status') {
          return JSON.stringify({ ok: true, provider: catalog.snapshot(providerId, atMs) });
        }
        if (action === 'models') {
          return JSON.stringify({ ok: true, providerId, models: catalog.modelsFor(providerId) });
        }
        // find
        const model = catalog.findModel({ providerId, model: getStringArg(args, 'model') });
        if (model === null) return errorResult(`Model "${getStringArg(args, 'model')}" not found on provider "${providerId}".`);
        return JSON.stringify({ ok: true, providerId, model });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const modelTool: Tool = {
    definition: toolDef(
      'voice_v24_model',
      'Mid-session model switch for a voice session (local action): switch to a model from the dynamic catalogue while the transcript stays exactly where it was (checksummed before/after), roll back to the previous model, or read the current model / switch history / models used. Switching to an unconfigured, offline or unknown provider is refused unless the factory was created with allowUnusableSwitch.',
      {
        action: { type: 'string', description: 'switch, rollback, current, history, models-used or summary.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        providerId: { type: 'string', description: 'Current provider id (creates the switcher on first use).' },
        model: { type: 'string', description: 'Current model id (creates the switcher on first use).' },
        toProviderId: { type: 'string', description: 'Target provider id (switch).' },
        toModel: { type: 'string', description: 'Target model id (switch).' },
        transcriptJson: { type: 'string', description: 'Transcript turns as JSON [{role, text, atMs}] (switch / rollback).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(MODEL_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${MODEL_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        // providerId/model are only required the first time a
        // switcher is created; afterwards the stored switcher wins.
        const existing = switchers.get(sessionId);
        let switcher: VoiceModelSwitcherV24;
        if (existing !== undefined) {
          switcher = existing;
        } else {
          const initial: VoiceV24ModelRef = {
            providerId: getStringArg(args, 'providerId'),
            model: getStringArg(args, 'model'),
          };
          switcher = needSwitcher(sessionId, initial);
        }
        const transcript = parseTranscriptArg(getOptionalStringArg(args, 'transcriptJson'));
        if (action === 'current') {
          return JSON.stringify({ ok: true, sessionId, current: switcher.currentModel(), previous: switcher.previousModel(), canRollback: switcher.canRollback() });
        }
        if (action === 'history') {
          return JSON.stringify({ ok: true, sessionId, history: switcher.historyList(), rolledBack: switcher.rolledBackSwitches() });
        }
        if (action === 'models-used') {
          return JSON.stringify({ ok: true, sessionId, models: switcher.modelsUsed() });
        }
        if (action === 'summary') {
          return JSON.stringify({ ok: true, sessionId, summary: switcher.summary() });
        }
        if (action === 'rollback') {
          const result = switcher.rollback(transcript, atMs);
          if (!result.ok) return errorResult(result.reason ?? 'Rollback failed');
          return JSON.stringify({ ...result, ok: true });
        }
        // switch
        const to: VoiceV24ModelRef = {
          providerId: getStringArg(args, 'toProviderId'),
          model: getStringArg(args, 'toModel'),
        };
        const result = switcher.switchTo(needCatalog(), to, transcript, atMs);
        if (!result.ok) return errorResult(result.reason ?? 'Switch failed');
        return JSON.stringify({ ...result, ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const healthTool: Tool = {
    definition: toolDef(
      'voice_v24_health',
      'Provider health from probe history (local action): record a host-measured probe, score one provider (0..100, grade A..F, degraded flag from score or consecutive failures), list all providers worst-first, degraded providers only, the mean score, prune probes older than the window, or a markdown table. No probe history means "no data", never a made-up score.',
      {
        action: { type: 'string', description: 'record, score, list, degraded, mean, prune or markdown.' },
        providerId: { type: 'string', description: 'Provider id.' },
        ok: { type: 'string', description: '"true" when the probe succeeded (record).' },
        latencyMs: { type: 'number', description: 'Probe round-trip ms (record).' },
        error: { type: 'string', description: 'Probe error text (record, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(HEALTH_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${HEALTH_ACTIONS.join(', ')})`);
        const health = needHealth();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'record') {
          const providerId = getStringArg(args, 'providerId');
          const ok = getOptionalBooleanArg(args, 'ok');
          if (ok === undefined) return errorResult('Missing required argument: "ok"');
          const latencyMs = getOptionalNumberArg(args, 'latencyMs');
          if (latencyMs === undefined) return errorResult('Missing required argument: "latencyMs"');
          health.record({ providerId, atMs, ok, latencyMs, error: getOptionalStringArg(args, 'error') });
          return JSON.stringify({ ok: true, health: health.score(providerId, atMs) });
        }
        if (action === 'list') {
          return JSON.stringify({ ok: true, providers: health.allScores(atMs), summary: health.summary(atMs) });
        }
        if (action === 'degraded') {
          return JSON.stringify({ ok: true, providers: health.degradedProviders(atMs) });
        }
        if (action === 'mean') {
          return JSON.stringify({ ok: true, meanScore: health.meanScore(atMs), summary: health.summary(atMs) });
        }
        if (action === 'prune') {
          return JSON.stringify({ ok: true, dropped: health.prune(atMs), providers: health.allScores(atMs) });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: health.markdown(atMs) });
        }
        const providerId = getStringArg(args, 'providerId');
        return JSON.stringify({ ok: true, ...health.score(providerId, atMs) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v24_session',
      'A live voice session with timers + model switching (local action): open a session on a catalogued model, append transcript turns (append-only), start/end/fail a tool-call timer in the current turn, switch or roll back the model mid-session (transcript preserved, checksummed), fall back automatically to the next usable model in the session fallback chain, read a snapshot, close the session (running calls are cancelled), or render summary/markdown. No provider is dialled.',
      {
        action: { type: 'string', description: 'open, turn, tool-start, tool-end, tool-fail, switch, rollback, auto-fallback, snapshot, close, summary or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        providerId: { type: 'string', description: 'Initial provider id (open).' },
        model: { type: 'string', description: 'Initial model id (open).' },
        role: { type: 'string', description: '"user" | "assistant" | "system" (turn).' },
        text: { type: 'string', description: 'Transcript text (turn).' },
        toolName: { type: 'string', description: 'Tool name (tool-start).' },
        callId: { type: 'string', description: 'Timer id (tool-end / tool-fail).' },
        error: { type: 'string', description: 'Error text (tool-fail).' },
        toProviderId: { type: 'string', description: 'Target provider id (switch).' },
        toModel: { type: 'string', description: 'Target model id (switch).' },
        reason: { type: 'string', description: 'Why the current model must be abandoned (auto-fallback).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(SESSION_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${SESSION_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const sessionId = getStringArg(args, 'sessionId');
        if (action === 'open') {
          if (sessions.has(sessionId)) return errorResult(`Session "${sessionId}" is already open`);
          const initial: VoiceV24ModelRef = {
            providerId: getStringArg(args, 'providerId'),
            model: getStringArg(args, 'model'),
          };
          const session = VoiceSessionV24.open(sessionId, initial, needCatalog(), atMs);
          sessions.set(sessionId, session);
          return JSON.stringify({ ok: true, snapshot: session.snapshot(atMs) });
        }
        const session = sessions.get(sessionId);
        if (session === undefined) return errorResult(`No session "${sessionId}" — open it first`);
        if (action === 'snapshot') {
          return JSON.stringify({ ok: true, ...session.snapshot(atMs) });
        }
        if (action === 'summary') {
          return JSON.stringify({ ok: true, summary: session.summary(atMs), snapshot: session.snapshot(atMs) });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: session.markdown(atMs) });
        }
        if (action === 'turn') {
          const role = getStringArg(args, 'role');
          if (role !== 'user' && role !== 'assistant' && role !== 'system') {
            return errorResult('role must be "user" | "assistant" | "system"');
          }
          const count = session.addTurn(role, getStringArg(args, 'text'), atMs);
          return JSON.stringify({ ok: true, transcriptTurns: count, checksum: session.transcriptChecksum() });
        }
        if (action === 'tool-start') {
          const callId = session.startToolCall(getStringArg(args, 'toolName'), atMs);
          return JSON.stringify({ ok: true, callId, running: session.runningCalls(atMs) });
        }
        if (action === 'tool-end') {
          const record = session.endToolCall(getStringArg(args, 'callId'), atMs);
          return JSON.stringify({ ok: true, record, duration: formatDurationV24(record.durationMs ?? 0) });
        }
        if (action === 'tool-fail') {
          const record = session.failToolCall(getStringArg(args, 'callId'), atMs, getStringArg(args, 'error'));
          return JSON.stringify({ ok: true, record, duration: formatDurationV24(record.durationMs ?? 0) });
        }
        if (action === 'switch') {
          const result = session.switchModel(
            { providerId: getStringArg(args, 'toProviderId'), model: getStringArg(args, 'toModel') },
            atMs,
          );
          if (!result.ok) return errorResult(result.reason ?? 'Switch failed');
          return JSON.stringify({ ...result, ok: true, checksum: session.transcriptChecksum() });
        }
        if (action === 'rollback') {
          const result = session.rollbackModel(atMs);
          if (!result.ok) return errorResult(result.reason ?? 'Rollback failed');
          return JSON.stringify({ ...result, ok: true, checksum: session.transcriptChecksum() });
        }
        if (action === 'auto-fallback') {
          const chain = chains.get(sessionId);
          if (chain === undefined) {
            return errorResult(`No fallback chain for session "${sessionId}" — set one with voice_v24_fallback first`);
          }
          const reason = getStringArg(args, 'reason');
          const fallback = session.autoFallback(chain, reason, atMs);
          if (!fallback.switched || fallback.result === null) {
            return JSON.stringify({ ok: true, switched: false, to: null, reason: 'Fallback chain exhausted — no usable model' });
          }
          return JSON.stringify({ ...fallback.result, ok: true, switched: true, checksum: session.transcriptChecksum() });
        }
        // close
        const closed = session.close(atMs);
        return JSON.stringify({ ok: true, ...closed, snapshot: session.snapshot(atMs) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const panelTool: Tool = {
    definition: toolDef(
      'voice_v24_panel',
      'Voice v24 timer + provider panel (local action): snapshot or markdown for one session — live running tool calls with elapsed time, the finished-call table, threshold alerts, the dynamic provider list at panel time, the model-switch history with transcript preservation, and provider health. Uses the shared timers/catalogue/health and the session opened through voice_v24_session.',
      {
        action: { type: 'string', description: 'snapshot or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id (opened through voice_v24_session).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(PANEL_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${PANEL_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const session = sessions.get(sessionId);
        if (session === undefined) return errorResult(`No session "${sessionId}" — open it first with voice_v24_session`);
        const panel = needPanel();
        const snapshot = panel.snapshot({
          sessionId,
          timers: session.timerRegistry(),
          catalog: needCatalog(),
          atMs,
          switcher: session.modelSwitcher(),
          health: needHealth(),
        });
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: panel.markdown(snapshot), snapshot });
        }
        return JSON.stringify({ ok: true, ...snapshot, summary: panel.summary(snapshot) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'voice_v24_report',
      'Aggregate voice v24 report (local action): totals across the shared timer registry (calls, tool time, slowest tools), the dynamic catalogue (providers by status), provider health (mean / worst / degraded), and all sessions opened through voice_v24_session (models used, switches). Summary text or markdown.',
      {
        action: { type: 'string', description: 'summary or markdown.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(REPORT_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${REPORT_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const timers = needTimers();
        const catalog = needCatalog();
        const health = needHealth();
        const toolStats = timers.allToolStats();
        const totalCalls = toolStats.reduce((a, t) => a + t.calls, 0);
        const totalMs = toolStats.reduce((a, t) => a + t.totalMs, 0);
        const slowest = toolStats.length === 0 ? null : toolStats[0];
        const sessionSummaries = [...sessions.values()].map((s) => ({
          sessionId: s.sessionId,
          phase: s.phaseOf(),
          currentModel: s.currentModel(),
          transcriptTurns: s.transcriptCount(),
          switches: s.modelSwitcher().switchCount(),
          timers: s.timerStats(),
        }));
        const totalSwitches = sessionSummaries.reduce((a, s) => a + s.switches, 0);
        const report = {
          atMs,
          timers: {
            totalCalls,
            totalMs,
            totalFormatted: formatDurationV24(totalMs),
            tools: toolStats,
            slowest: slowest === null ? null : { toolName: slowest.toolName, p95Ms: slowest.p95Ms, maxMs: slowest.maxMs },
            alerts: timers.alertsList().length,
          },
          providers: { ...catalog.counts(atMs), summary: catalog.summary(atMs) },
          health: {
            meanScore: health.meanScore(atMs),
            degraded: health.degradedProviders(atMs),
            worst: health.allScores(atMs)[0] ?? null,
          },
          sessions: sessionSummaries,
          totalSwitches,
          checksumNote: 'Transcript checksums are verified on every switch (see voice_v24_model / voice_v24_session).',
        };
        if (action === 'markdown') {
          const lines: string[] = ['# Voice v24 report', '', `At ${atMs}ms.`];
          lines.push(
            `Tool calls: ${totalCalls} (${formatDurationV24(totalMs)} total); slowest tool: ${slowest === null ? 'none' : `${slowest.toolName} (p95 ${formatDurationV24(slowest.p95Ms)}, max ${formatDurationV24(slowest.maxMs)})`}; alerts: ${timers.alertsList().length}.`,
          );
          lines.push(`Providers: ${catalog.summary(atMs)}`);
          lines.push(`Health: ${health.summary(atMs)}`);
          lines.push(`Sessions: ${sessionSummaries.length} (${totalSwitches} model switches).`);
          for (const s of sessionSummaries) {
            lines.push(`- ${s.sessionId} (${s.phase}): ${s.currentModel.providerId}/${s.currentModel.model}, ${s.transcriptTurns} turns, ${s.switches} switches, ${s.timers.calls} tool calls.`);
          }
          return JSON.stringify({ ok: true, markdown: lines.join('\n'), ...report });
        }
        return JSON.stringify({ ok: true, ...report });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const fallbackTool: Tool = {
    definition: toolDef(
      'voice_v24_fallback',
      'Model fallback chains for voice sessions (local action): set the ordered fallback chain for a session, pick the fallback for the current model from the live catalogue statuses, list chain links with live usability and the reason each unusable link is blocked, or read the fallback decision history. The chain only decides — the switch itself goes through voice_v24_model / voice_v24_session, which checksums the transcript.',
      {
        action: { type: 'string', description: 'set-chain, pick, links, history or summary.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        chainJson: { type: 'string', description: 'Ordered chain as JSON [{providerId, model}] (set-chain).' },
        providerId: { type: 'string', description: 'Current provider id (pick).' },
        model: { type: 'string', description: 'Current model id (pick).' },
        reason: { type: 'string', description: 'Why the current model must be abandoned (pick, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(FALLBACK_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${FALLBACK_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'set-chain') {
          const chain = parseModelRefArray(getOptionalStringArg(args, 'chainJson'), 'chainJson');
          if (chain.length === 0) return errorResult('chainJson must list at least one model');
          const created = createModelFallbackChainV24(chain, opts.fallbackOptions ?? {});
          chains.set(sessionId, created);
          return JSON.stringify({ ok: true, sessionId, chain: created.links(), summary: created.summary(needCatalog(), atMs) });
        }
        const chain = chains.get(sessionId);
        if (chain === undefined) return errorResult(`No fallback chain for session "${sessionId}" — set one with action "set-chain" first`);
        if (action === 'links') {
          return JSON.stringify({ ok: true, sessionId, links: chain.linksWithUsability(needCatalog(), atMs) });
        }
        if (action === 'history') {
          return JSON.stringify({ ok: true, sessionId, history: chain.historyList(sessionId), exhausted: chain.exhaustedDecisions(sessionId) });
        }
        if (action === 'summary') {
          return JSON.stringify({ ok: true, sessionId, summary: chain.summary(needCatalog(), atMs), decisions: chain.decisionCount(sessionId) });
        }
        // pick
        const current: VoiceV24ModelRef = {
          providerId: getStringArg(args, 'providerId'),
          model: getStringArg(args, 'model'),
        };
        const picked = chain.pickFallback(needCatalog(), current, atMs);
        const decision = chain.recordDecision(
          sessionId,
          current,
          picked.to,
          getOptionalStringArg(args, 'reason') ?? 'Current model unusable',
          picked.skipped,
          atMs,
        );
        return JSON.stringify({ ok: true, sessionId, ...picked, decision });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const budgetsTool: Tool = {
    definition: toolDef(
      'voice_v24_budgets',
      'Tool-call time budgets for voice sessions (local action): set per-tool budgets (per call / per session / per turn), set a session tool-time budget, check one finished call against its budgets (raises per-call / per-session / per-turn breaches), list breaches, or burn-down of the session budget (spent / remaining / burn rate / projected exhaustion). Budgets are judged from finished calls the caller reports — this tool never starts timers.',
      {
        action: { type: 'string', description: 'set, get, set-session, check, breaches, burndown or summary.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        toolName: { type: 'string', description: 'Tool name.' },
        perCallMs: { type: 'number', description: 'Per-call budget ms (set, optional).' },
        perSessionMs: { type: 'number', description: 'Per-session budget ms for this tool (set, optional).' },
        perTurnMs: { type: 'number', description: 'Per-turn budget ms for this tool (set, optional).' },
        budgetMs: { type: 'number', description: 'Session tool-time budget ms (set-session).' },
        callJson: { type: 'string', description: 'Finished call as JSON {id, sessionId, toolName, turnIndex, startedAtMs, endedAtMs, durationMs, status} (check).' },
        sessionTotalMs: { type: 'number', description: 'Session tool-time total including this call (check).' },
        turnTotalMs: { type: 'number', description: 'Turn tool-time total including this call (check).' },
        callsJson: { type: 'string', description: 'Finished calls as JSON array (burndown / summary).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(BUDGET_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${BUDGET_ACTIONS.join(', ')})`);
        const budgets = needBudgets();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'set') {
          const toolName = getStringArg(args, 'toolName');
          budgets.setBudget({
            toolName,
            perCallMs: getOptionalNumberArg(args, 'perCallMs'),
            perSessionMs: getOptionalNumberArg(args, 'perSessionMs'),
            perTurnMs: getOptionalNumberArg(args, 'perTurnMs'),
          });
          return JSON.stringify({ ok: true, budget: budgets.getBudget(toolName) });
        }
        if (action === 'get') {
          return JSON.stringify({ ok: true, budget: budgets.getBudget(getStringArg(args, 'toolName')) });
        }
        if (action === 'set-session') {
          const sessionId = getStringArg(args, 'sessionId');
          const budgetMs = getOptionalNumberArg(args, 'budgetMs');
          if (budgetMs === undefined) return errorResult('Missing required argument: "budgetMs"');
          budgets.setSessionBudget(sessionId, budgetMs);
          return JSON.stringify({ ok: true, sessionId, budgetMs: budgets.sessionBudgetMs(sessionId) });
        }
        if (action === 'breaches') {
          return JSON.stringify({
            ok: true,
            breaches: budgets.breachesList(getOptionalStringArg(args, 'sessionId'), getOptionalStringArg(args, 'toolName')),
          });
        }
        if (action === 'check') {
          const raw = parseJsonArg(getOptionalStringArg(args, 'callJson'), 'callJson');
          if (typeof raw !== 'object' || raw === null) return errorResult('callJson must be a JSON object');
          const record = raw as unknown as import('@open-bot/core').VoiceV24ToolCallRecord;
          if (typeof record.id !== 'string' || typeof record.sessionId !== 'string' || typeof record.toolName !== 'string') {
            return errorResult('callJson needs string "id", "sessionId" and "toolName"');
          }
          if (typeof record.durationMs !== 'number') return errorResult('callJson needs numeric "durationMs"');
          const sessionTotalMs = getOptionalNumberArg(args, 'sessionTotalMs');
          const turnTotalMs = getOptionalNumberArg(args, 'turnTotalMs');
          if (sessionTotalMs === undefined) return errorResult('Missing required argument: "sessionTotalMs"');
          if (turnTotalMs === undefined) return errorResult('Missing required argument: "turnTotalMs"');
          const raised = budgets.recordFinished(record, sessionTotalMs, turnTotalMs);
          return JSON.stringify({ ok: true, raised, breaches: budgets.breachesList(record.sessionId) });
        }
        // burndown / summary need the finished calls.
        const sessionId = getStringArg(args, 'sessionId');
        const callsRaw = parseJsonArg(getOptionalStringArg(args, 'callsJson'), 'callsJson');
        if (!Array.isArray(callsRaw)) return errorResult('callsJson must be a JSON array of finished calls');
        const calls = callsRaw as unknown as import('@open-bot/core').VoiceV24ToolCallRecord[];
        const burn = budgets.sessionBurnDown(sessionId, calls, atMs);
        if (action === 'burndown') {
          return JSON.stringify({ ok: true, sessionId, burn, perTool: budgets.perToolBurnDown(sessionId, calls) });
        }
        return JSON.stringify({ ok: true, sessionId, summary: budgets.summary(sessionId, calls, atMs), burn, breaches: budgets.breachCount(sessionId) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [timersTool, providersTool, modelTool, healthTool, sessionTool, panelTool, reportTool, fallbackTool, budgetsTool];
}

/** Unbound placeholder (own default instances — mock sessions only). */
export const VOICE_V24_TOOLS: Tool[] = createVoiceV24Tools();

export const VOICE_V24_TOOL_NAMES = [
  'voice_v24_timers',
  'voice_v24_providers',
  'voice_v24_model',
  'voice_v24_health',
  'voice_v24_session',
  'voice_v24_panel',
  'voice_v24_report',
  'voice_v24_fallback',
  'voice_v24_budgets',
] as const;

export function isVoiceV24ToolName(name: string): name is (typeof VOICE_V24_TOOL_NAMES)[number] {
  return (VOICE_V24_TOOL_NAMES as readonly string[]).includes(name);
}
