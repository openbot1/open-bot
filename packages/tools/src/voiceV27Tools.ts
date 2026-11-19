/**
 * Voice v27 tools for @open-bot/tools (v1.40, Team T5).
 *
 * The agent drives the voice v27 realtime v2 loop by tool call:
 *  - voice_v27_interrupt — barge-in v2: arm the agent reply,
 *    feed caller-measured speech bursts (policy modes always /
 *    keyword-only / never-critical / disabled, grace window,
 *    cooldown, storm protection), stop the TTS with measured
 *    stop latency (spoken prefix at a word boundary, resume
 *    decision), full event log + false positives
 *  - voice_v27_vad — VAD tuning + turn-taking v2: configure /
 *    presets (sensitive / balanced / strict), classify frames,
 *    calibrate from samples, VAD-driven turns (open on
 *    sustained speech, end on silence / keyword / timeout),
 *    short-noise rejection, turn history + stats
 *  - voice_v27_personas — multi-voice personas: builtin +
 *    custom personas (voice + rate + pitch + style), one
 *    remembered persona per bot, mid-session switching, mock
 *    preview (no audio), fallback ordering
 *  - voice_v27_session — a durable live session wiring all
 *    four: open, drive the whole turn flow (user frames,
 *    barge-in stops, agent replies as the bot persona), pause /
 *    resume, checkpoint, restore after restart, close; every
 *    transition is saved to a JSON file and confirmed first
 *  - voice_v27_state — the durable store itself: save / load /
 *    verify / recover unclean shutdowns / purge expired /
 *    checkpoint / transition / remove, per session file
 *  - voice_v27_report — aggregate report across the sessions
 *    opened through voice_v27_session
 *
 * SAFETY: everything here is local — clocks are virtual, audio
 * is mock/synthetic frame energy, TTS playback is a mock stub
 * (this machine has no TTS engine and no sound card; only the
 * control logic is real), providers are never dialled, no key
 * is read or stored. Session files live under the host-wired
 * baseDir (default: the OS temp dir) and hold no secrets.
 *
 * Factory:
 *   createVoiceV27Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V27_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import {
  DurableSessionStoreV27,
  InterruptPolicyV27,
  PersonaRegistryV27,
  TurnManagerV27,
  VoiceSessionV27,
  createDurableSessionStoreV27,
  createInterruptPolicyV27,
  createPersonaRegistryV27,
  createTurnManagerV27,
  createVoiceSessionV27,
  validatePersonaDefV27,
  type DurableSessionStoreV27Options,
  type InterruptPolicyV27Options,
  type PersonaRegistryV27Options,
  type TurnManagerV27Options,
  type VoiceV27InterruptMode,
  type VoiceV27PersonaDef,
  type VoiceV27PersonaStyle,
  type VoiceV27SessionState,
  type VoiceV27VadPreset,
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

function parseNumberArray(value: string | undefined, name: string): number[] {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${name} must be a JSON array of numbers`);
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`${name} entries must be finite numbers`);
  }
  return raw as number[];
}

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

export interface VoiceV27ToolOptions {
  /** Shared interrupt policy accessor (per session). */
  getInterrupt?: (sessionId: string) => InterruptPolicyV27 | null;
  /** Shared turn manager accessor (per session). */
  getTurnManager?: (sessionId: string) => TurnManagerV27 | null;
  /** Shared persona registry accessor. */
  getPersonas?: () => PersonaRegistryV27 | null;
  /** Shared durable store accessor. */
  getStore?: () => DurableSessionStoreV27 | null;
  /** Shared session accessor (per session). */
  getSession?: (sessionId: string) => VoiceSessionV27 | null;
  /** Base dir for durable session files (null = memory-only). */
  getBaseDir?: () => string | null;
  interruptOptions?: Partial<InterruptPolicyV27Options>;
  turnManagerOptions?: Partial<TurnManagerV27Options>;
  personasOptions?: Partial<PersonaRegistryV27Options>;
  storeOptions?: Partial<DurableSessionStoreV27Options>;
}

const INTERRUPT_ACTIONS = ['arm', 'progress', 'feed', 'stop', 'policy', 'set-policy', 'current', 'get', 'list', 'confirmed', 'ignored', 'stats', 'false-positive', 'markdown', 'reset'] as const;
const VAD_ACTIONS = ['configure', 'preset', 'classify', 'calibrate', 'turn-start', 'turn-frame', 'turn-end', 'turn-timeout', 'turn-abandon', 'current-turn', 'turns', 'get-turn', 'stats', 'vad-stats', 'markdown', 'reset'] as const;
const PERSONA_ACTIONS = ['list', 'get', 'register', 'remove', 'assign', 'assignment', 'switch', 'preview', 'fallback', 'stats', 'markdown'] as const;
const SESSION_ACTIONS = ['open', 'user-start', 'user-frame', 'user-end', 'agent-reply', 'progress', 'agent-done', 'switch-persona', 'pause', 'resume', 'timeout-check', 'checkpoint', 'restore', 'close', 'state', 'snapshot', 'summary', 'markdown'] as const;
const STATE_ACTIONS = ['save', 'load', 'list', 'verify', 'recover', 'purge', 'checkpoint', 'remove', 'transition', 'stats', 'markdown'] as const;
const REPORT_ACTIONS = ['summary', 'markdown'] as const;

export function createVoiceV27Tools(opts: VoiceV27ToolOptions = {}): Tool[] {
  const defaultPersonas = createPersonaRegistryV27(opts.personasOptions ?? {});
  const defaultBaseDir = (): string => {
    const wired = opts.getBaseDir?.();
    if (wired !== undefined && wired !== null) return wired;
    if (opts.storeOptions?.baseDir !== undefined && opts.storeOptions.baseDir !== null) return opts.storeOptions.baseDir;
    return path.join(os.tmpdir(), 'open-bot-voice-v27');
  };
  const needStore = (): DurableSessionStoreV27 => {
    const shared = opts.getStore?.();
    if (shared !== null && shared !== undefined) return shared;
    return createDurableSessionStoreV27({
      ...(opts.storeOptions ?? {}),
      baseDir: opts.storeOptions?.baseDir ?? defaultBaseDir(),
    });
  };
  // One store instance per factory when the host wires none, so
  // the state tool and the session tool see the same files.
  let factoryStore: DurableSessionStoreV27 | null = null;
  const needFactoryStore = (): DurableSessionStoreV27 => {
    const shared = opts.getStore?.();
    if (shared !== null && shared !== undefined) return shared;
    if (factoryStore === null) factoryStore = needStore();
    return factoryStore;
  };
  const needPersonas = (): PersonaRegistryV27 => opts.getPersonas?.() ?? defaultPersonas;
  const policies = new Map<string, InterruptPolicyV27>();
  const managers = new Map<string, TurnManagerV27>();
  const sessions = new Map<string, VoiceSessionV27>();
  /** Session ids actually opened (not merely touched by a failed call). */
  const openedSessions = new Set<string>();

  const needInterrupt = (sessionId: string): InterruptPolicyV27 => {
    const shared = opts.getInterrupt?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = policies.get(sessionId);
    if (found === undefined) {
      found = createInterruptPolicyV27(sessionId, opts.interruptOptions ?? {});
      policies.set(sessionId, found);
    }
    return found;
  };
  const needTurnManager = (sessionId: string): TurnManagerV27 => {
    const shared = opts.getTurnManager?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = managers.get(sessionId);
    if (found === undefined) {
      found = createTurnManagerV27(sessionId, opts.turnManagerOptions ?? {});
      managers.set(sessionId, found);
    }
    return found;
  };
  const needSession = (sessionId: string): VoiceSessionV27 => {
    const shared = opts.getSession?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = sessions.get(sessionId);
    if (found === undefined) {
      found = createVoiceSessionV27(sessionId, {
        interrupt: opts.interruptOptions,
        turnManager: opts.turnManagerOptions,
        personas: opts.personasOptions,
        store: { ...(opts.storeOptions ?? {}), baseDir: needFactoryStore().baseDirNow() },
      });
      sessions.set(sessionId, found);
    }
    return found;
  };

  const interruptTool: Tool = {
    definition: toolDef(
      'voice_v27_interrupt',
      'Barge-in v2: interrupt policy + event log for a voice session (local action): arm the agent reply, feed caller-measured speech bursts (policy modes always / keyword-only / never-critical / disabled, grace window after reply start, cooldown, storm protection for repeated interruptions), stop the TTS with measured stop latency (spoken prefix cut at a word boundary, resume decision), list events, or mark a false positive. Short bursts are backchannels; no mic or sound card is touched.',
      {
        action: { type: 'string', description: 'arm, progress, feed, stop, policy, set-policy, current, get, list, confirmed, ignored, stats, false-positive, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        turnId: { type: 'string', description: 'Assistant turn id (arm).' },
        replyText: { type: 'string', description: 'Planned agent reply text (arm).' },
        critical: { type: 'string', description: '"true" when the reply must not be interrupted (arm, optional).' },
        spokenChars: { type: 'number', description: 'Chars the TTS engine has spoken (progress / stop).' },
        speechMs: { type: 'number', description: 'Caller-measured speech duration ms (feed).' },
        energy: { type: 'number', description: 'Peak frame energy 0..1 (feed).' },
        text: { type: 'string', description: 'What the user said (feed, optional).' },
        isKeyword: { type: 'string', description: '"true" when the burst is a keyword interruption (feed, optional).' },
        eventId: { type: 'string', description: 'Interruption event id (stop / get / false-positive).' },
        stopLatencyMs: { type: 'number', description: 'Measured ms from confirm to TTS stop (stop, optional).' },
        userText: { type: 'string', description: 'What the user said (stop, optional).' },
        policyJson: { type: 'string', description: 'Partial policy as JSON (set-policy).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(INTERRUPT_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const policy = needInterrupt(sessionId);
        switch (action) {
          case 'arm':
            return JSON.stringify(policy.armReply({
              turnId: getStringArg(args, 'turnId'),
              replyText: getStringArg(args, 'replyText'),
              critical: getOptionalBooleanArg(args, 'critical') ?? false,
              atMs,
            }));
          case 'progress':
            policy.noteProgress(atMs, getOptionalNumberArg(args, 'spokenChars') ?? 0);
            return JSON.stringify({ ok: true, sessionId, speaking: policy.isAgentSpeaking() });
          case 'feed':
            return JSON.stringify(policy.feedBurst({
              atMs,
              speechMs: getOptionalNumberArg(args, 'speechMs') ?? 0,
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              text: getOptionalStringArg(args, 'text') ?? null,
              isKeyword: getOptionalBooleanArg(args, 'isKeyword'),
            }));
          case 'stop': {
            const stopped = policy.stop({
              eventId: getStringArg(args, 'eventId'),
              atMs,
              spokenChars: getOptionalNumberArg(args, 'spokenChars') ?? null,
              stopLatencyMs: getOptionalNumberArg(args, 'stopLatencyMs') ?? null,
              userText: getOptionalStringArg(args, 'userText') ?? null,
            });
            if (!stopped) return errorResult('No confirmed interruption to stop for that event');
            return JSON.stringify(stopped);
          }
          case 'policy':
            return JSON.stringify(policy.policyNow());
          case 'set-policy': {
            const raw = parseJsonArg(getOptionalStringArg(args, 'policyJson'), 'policyJson') as Record<string, unknown> | undefined;
            if (!raw || typeof raw !== 'object') return errorResult('policyJson must be a policy object');
            return JSON.stringify(policy.setPolicy(raw as Partial<InterruptPolicyV27Options>));
          }
          case 'current':
            return JSON.stringify(policy.currentConfirmed() ?? { confirmed: null });
          case 'get': {
            const event = policy.get(getStringArg(args, 'eventId'));
            if (!event) return errorResult(`Unknown event: "${getStringArg(args, 'eventId')}"`);
            return JSON.stringify(event);
          }
          case 'list':
            return JSON.stringify(policy.list());
          case 'confirmed':
            return JSON.stringify(policy.confirmedList());
          case 'ignored':
            return JSON.stringify(policy.ignoredList());
          case 'stats':
            return JSON.stringify(policy.stats(atMs));
          case 'false-positive': {
            const ok = policy.markFalsePositive(getStringArg(args, 'eventId'));
            return JSON.stringify({ ok, eventId: getStringArg(args, 'eventId') });
          }
          case 'markdown':
            return policy.markdown();
          case 'reset':
            policy.reset();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const vadTool: Tool = {
    definition: toolDef(
      'voice_v27_vad',
      'VAD tuning + turn-taking v2 for a voice session (local action): configure the VAD (silence threshold, sensitivity, minimum speech, end-of-turn silence, hangover, adaptive noise floor), apply a preset (sensitive / balanced / strict), classify energy frames, calibrate from a sample, and run VAD-driven turns (open on sustained speech, end on silence / keyword / timeout). Short bursts are rejected as noise and never open a turn; no mic is read.',
      {
        action: { type: 'string', description: 'configure, preset, classify, calibrate, turn-start, turn-frame, turn-end, turn-timeout, turn-abandon, current-turn, turns, get-turn, stats, vad-stats, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        configJson: { type: 'string', description: 'Partial VAD config as JSON (configure).' },
        preset: { type: 'string', description: 'VAD preset: sensitive | balanced | strict (preset).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (classify / turn-frame).' },
        isSpeech: { type: 'string', description: '"true" when the frame is speech (classify / turn-frame, optional).' },
        text: { type: 'string', description: 'Transcript fragment (classify / turn-frame / turn-start / turn-end, optional).' },
        frameMs: { type: 'number', description: 'Ms per frame (classify / turn-frame, optional).' },
        samplesJson: { type: 'string', description: 'Frame energies as JSON array (calibrate).' },
        apply: { type: 'string', description: '"true" to apply the calibration (calibrate, optional).' },
        turnId: { type: 'string', description: 'Turn id (get-turn).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(VAD_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const manager = needTurnManager(sessionId);
        switch (action) {
          case 'configure': {
            const raw = parseJsonArg(getOptionalStringArg(args, 'configJson'), 'configJson') as Record<string, unknown> | undefined;
            if (!raw || typeof raw !== 'object') return errorResult('configJson must be a VAD config object');
            return JSON.stringify(manager.vad.configure(raw as Parameters<TurnManagerV27['vad']['configure']>[0]));
          }
          case 'preset': {
            const preset = getStringArg(args, 'preset') as VoiceV27VadPreset;
            if (preset !== 'sensitive' && preset !== 'balanced' && preset !== 'strict') {
              return errorResult(`Unknown preset: "${preset}"`);
            }
            return JSON.stringify(manager.vad.applyPreset(preset));
          }
          case 'classify':
            return JSON.stringify(manager.vad.classifyFrame({
              atMs,
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              isSpeech: getOptionalBooleanArg(args, 'isSpeech'),
              text: getOptionalStringArg(args, 'text') ?? null,
            }, getOptionalNumberArg(args, 'frameMs')));
          case 'calibrate':
            return JSON.stringify(manager.vad.calibrate(
              parseNumberArray(getOptionalStringArg(args, 'samplesJson'), 'samplesJson'),
              getOptionalBooleanArg(args, 'apply') ?? false,
            ));
          case 'turn-start':
            return JSON.stringify(manager.userStart(atMs, getOptionalStringArg(args, 'text') ?? ''));
          case 'turn-frame': {
            const result = manager.userFrame({
              atMs,
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              isSpeech: getOptionalBooleanArg(args, 'isSpeech'),
              text: getOptionalStringArg(args, 'text') ?? null,
            }, getOptionalNumberArg(args, 'frameMs'));
            return JSON.stringify(result);
          }
          case 'turn-end': {
            const turn = manager.userEnd(atMs, getOptionalStringArg(args, 'text'));
            return JSON.stringify(turn ?? { ended: false });
          }
          case 'turn-timeout': {
            const turn = manager.timeoutCheck(atMs);
            return JSON.stringify(turn ?? { timedOut: false });
          }
          case 'turn-abandon': {
            const turn = manager.abandon(atMs);
            return JSON.stringify(turn ?? { abandoned: false });
          }
          case 'current-turn':
            return JSON.stringify(manager.currentTurn() ?? { turn: null });
          case 'turns':
            return JSON.stringify(manager.listTurns());
          case 'get-turn': {
            const turn = manager.getTurn(getStringArg(args, 'turnId'));
            if (!turn) return errorResult(`Unknown turn: "${getStringArg(args, 'turnId')}"`);
            return JSON.stringify(turn);
          }
          case 'stats':
            return JSON.stringify(manager.stats());
          case 'vad-stats':
            return JSON.stringify(manager.vad.stats());
          case 'markdown':
            return manager.markdown();
          case 'reset':
            manager.reset();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const personasTool: Tool = {
    definition: toolDef(
      'voice_v27_personas',
      'Multi-voice personas (local action): list / register / remove voice characters (voice + rate + pitch + language + style — a character layered on a provider, not an engine), remember one persona per bot, switch mid-session, mock preview (sample text + estimated duration, no audio), fallback ordering for a language/style.',
      {
        action: { type: 'string', description: 'list, get, register, remove, assign, assignment, switch, preview, fallback, stats or markdown.' },
        personaId: { type: 'string', description: 'Persona id (get / remove / assign / switch / preview).' },
        botId: { type: 'string', description: 'Bot id (assign / assignment / switch).' },
        language: { type: 'string', description: 'Language BCP-47 tag (list / fallback, optional).' },
        style: { type: 'string', description: 'Persona style: calm | energetic | formal | friendly | concise | warm | storyteller | professional (list / fallback, optional).' },
        builtin: { type: 'string', description: '"true" / "false" (list, optional).' },
        definitionJson: { type: 'string', description: 'Persona definition as JSON (register).' },
        text: { type: 'string', description: 'Sample text (preview).' },
        midSession: { type: 'string', description: '"true" when switching while the agent is speaking (switch, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(PERSONA_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const registry = needPersonas();
        const styleArg = getOptionalStringArg(args, 'style') as VoiceV27PersonaStyle | undefined;
        switch (action) {
          case 'list':
            return JSON.stringify(registry.list({
              language: getOptionalStringArg(args, 'language') ?? null,
              style: styleArg ?? null,
              builtin: getOptionalBooleanArg(args, 'builtin') ?? null,
            }));
          case 'get': {
            const persona = registry.get(getStringArg(args, 'personaId'));
            if (!persona) return errorResult(`Unknown persona: "${getStringArg(args, 'personaId')}"`);
            return JSON.stringify(persona);
          }
          case 'register': {
            const raw = parseJsonArg(getOptionalStringArg(args, 'definitionJson'), 'definitionJson') as Record<string, unknown> | undefined;
            if (!raw || typeof raw !== 'object') return errorResult('definitionJson must be a persona definition object');
            const errors = validatePersonaDefV27(raw as unknown as Partial<VoiceV27PersonaDef>);
            if (errors.length > 0) return errorResult(`Invalid persona: ${errors.join('; ')}`);
            return JSON.stringify(registry.register(raw as unknown as VoiceV27PersonaDef));
          }
          case 'remove':
            return JSON.stringify({ removed: registry.remove(getStringArg(args, 'personaId')) });
          case 'assign':
            return JSON.stringify(registry.assign(getStringArg(args, 'botId'), getStringArg(args, 'personaId'), atMs));
          case 'assignment': {
            const found = registry.assignmentFor(getStringArg(args, 'botId'));
            if (!found) return errorResult(`No persona assigned for bot "${getStringArg(args, 'botId')}"`);
            return JSON.stringify(found);
          }
          case 'switch':
            return JSON.stringify(registry.switchPersona(
              getStringArg(args, 'botId'),
              getStringArg(args, 'personaId'),
              { atMs, midSession: getOptionalBooleanArg(args, 'midSession') ?? false },
            ));
          case 'preview':
            return JSON.stringify(registry.preview(getStringArg(args, 'personaId'), getStringArg(args, 'text')));
          case 'fallback':
            return JSON.stringify(registry.fallbackFor({
              language: getOptionalStringArg(args, 'language') ?? null,
              style: styleArg ?? null,
            }));
          case 'stats':
            return JSON.stringify(registry.stats());
          case 'markdown':
            return registry.markdown();
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v27_session',
      'A durable realtime voice session wiring interrupt policy + VAD turn-taking + personas + durable state (local action): open, drive the whole turn flow (user frames, barge-in stops with resume decision, agent replies spoken as the bot persona), pause / resume, checkpoint, restore after restart, close. Every transition is saved to a JSON file and the saved state is confirmed before each operation; TTS is a mock stub (no engine, no sound card).',
      {
        action: { type: 'string', description: 'open, user-start, user-frame, user-end, agent-reply, progress, agent-done, switch-persona, pause, resume, timeout-check, checkpoint, restore, close, state, snapshot, summary or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        botId: { type: 'string', description: 'Bot id (open, optional).' },
        personaId: { type: 'string', description: 'Persona id to assign at open / switch to (open / switch-persona).' },
        text: { type: 'string', description: 'Turn text / reply text / user text (user-start / user-frame / agent-reply, optional).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (user-frame).' },
        isSpeech: { type: 'string', description: '"true" when the frame is speech (user-frame, optional).' },
        speechMs: { type: 'number', description: 'Caller-measured speech ms while the agent speaks (user-frame, optional).' },
        stopLatencyMs: { type: 'number', description: 'Measured ms from confirm to TTS stop (user-frame, optional).' },
        spokenChars: { type: 'number', description: 'Chars spoken (progress / agent-done).' },
        critical: { type: 'string', description: '"true" when the reply must not be interrupted (agent-reply, optional).' },
        label: { type: 'string', description: 'Checkpoint label (checkpoint).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(SESSION_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const session = needSession(sessionId);
        switch (action) {
          case 'open': {
            const opened = session.open(atMs, {
              botId: getOptionalStringArg(args, 'botId') ?? null,
              personaId: getOptionalStringArg(args, 'personaId') ?? null,
            });
            openedSessions.add(sessionId);
            return JSON.stringify(opened);
          }
          case 'user-start':
            return JSON.stringify(session.userStart(atMs, getOptionalStringArg(args, 'text') ?? ''));
          case 'user-frame':
            return JSON.stringify(session.userFrame({
              atMs,
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              isSpeech: getOptionalBooleanArg(args, 'isSpeech'),
              text: getOptionalStringArg(args, 'text') ?? null,
              speechMs: getOptionalNumberArg(args, 'speechMs') ?? null,
              stopLatencyMs: getOptionalNumberArg(args, 'stopLatencyMs') ?? null,
            }));
          case 'user-end':
            return JSON.stringify(session.userEnd(atMs, getOptionalStringArg(args, 'text')));
          case 'agent-reply':
            return JSON.stringify(session.agentReply({
              atMs,
              text: getStringArg(args, 'text'),
              critical: getOptionalBooleanArg(args, 'critical') ?? false,
            }));
          case 'progress':
            session.agentSpeechProgress(atMs, getOptionalNumberArg(args, 'spokenChars') ?? 0);
            return JSON.stringify({ ok: true, sessionId });
          case 'agent-done':
            return JSON.stringify(session.agentDone(atMs, getOptionalNumberArg(args, 'spokenChars') ?? null));
          case 'switch-persona':
            return JSON.stringify(session.switchPersona(getStringArg(args, 'personaId'), atMs));
          case 'pause':
            return JSON.stringify(session.pause(atMs));
          case 'resume':
            return JSON.stringify(session.resume(atMs));
          case 'timeout-check':
            return JSON.stringify(session.timeoutCheck(atMs));
          case 'checkpoint':
            return JSON.stringify(session.checkpoint(getStringArg(args, 'label'), atMs));
          case 'restore': {
            const restored = session.restore(atMs);
            if (!restored) return errorResult(`No durable record for session "${sessionId}"`);
            return JSON.stringify(restored);
          }
          case 'close':
            return JSON.stringify(session.close(atMs));
          case 'state':
            return JSON.stringify({ sessionId, state: session.stateNow() });
          case 'snapshot':
            return JSON.stringify(session.snapshot());
          case 'summary':
            return session.summary();
          case 'markdown':
            return session.markdown();
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const stateTool: Tool = {
    definition: toolDef(
      'voice_v27_state',
      'The durable voice session store itself (local action): save / load a session record, list sessions, verify a record (missing file / corrupt JSON / unclean close), recover sessions left open by a crash or restart (parked paused, marked recovered), purge ended sessions older than the TTL, checkpoint, transition state, or remove a record. Session files hold no secrets.',
      {
        action: { type: 'string', description: 'save, load, list, verify, recover, purge, checkpoint, remove, transition, stats or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id (save / load / verify / checkpoint / remove / transition).' },
        recordJson: { type: 'string', description: 'Durable session record as JSON (save).' },
        label: { type: 'string', description: 'Checkpoint label (checkpoint).' },
        to: { type: 'string', description: 'Target state: idle | listening | thinking | speaking | paused | ended (transition).' },
        note: { type: 'string', description: 'Note attached to the transition (transition, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(STATE_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const store = needFactoryStore();
        switch (action) {
          case 'save': {
            const raw = parseJsonArg(getOptionalStringArg(args, 'recordJson'), 'recordJson') as Record<string, unknown> | undefined;
            if (!raw || typeof raw !== 'object') return errorResult('recordJson must be a session record object');
            return JSON.stringify(store.save(raw as unknown as Parameters<DurableSessionStoreV27['save']>[0]));
          }
          case 'load': {
            const record = store.load(getStringArg(args, 'sessionId'));
            if (!record) return errorResult(`No durable record for session "${getStringArg(args, 'sessionId')}"`);
            return JSON.stringify(record);
          }
          case 'list':
            return JSON.stringify(store.list());
          case 'verify':
            return JSON.stringify(store.verify(getStringArg(args, 'sessionId')));
          case 'recover':
            return JSON.stringify(store.recoverUnclean(atMs));
          case 'purge':
            return JSON.stringify(store.purgeExpired(atMs));
          case 'checkpoint': {
            const record = store.checkpoint(
              getStringArg(args, 'sessionId'),
              getStringArg(args, 'label'),
              atMs,
            );
            if (!record) return errorResult(`Unknown session: "${getStringArg(args, 'sessionId')}"`);
            return JSON.stringify(record);
          }
          case 'remove':
            return JSON.stringify({ removed: store.remove(getStringArg(args, 'sessionId')) });
          case 'transition': {
            const to = getStringArg(args, 'to') as VoiceV27SessionState;
            if (!['idle', 'listening', 'thinking', 'speaking', 'paused', 'ended'].includes(to)) {
              return errorResult(`Unknown state: "${to}"`);
            }
            const moved = store.transition(
              getStringArg(args, 'sessionId'),
              to,
              atMs,
              getOptionalStringArg(args, 'note'),
            );
            if (!moved) return errorResult(`Illegal transition for session "${getStringArg(args, 'sessionId')}"`);
            return JSON.stringify(moved);
          }
          case 'stats':
            return JSON.stringify(store.stats());
          case 'markdown':
            return store.markdown();
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'voice_v27_report',
      'Aggregate report across the voice sessions opened through voice_v27_session (local action): session states, turn totals, interruption counts, persona usage, recovered sessions, and markdown. Sessions opened outside this tool set are not visible here.',
      {
        action: { type: 'string', description: 'summary or markdown.' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(REPORT_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const rows = [...openedSessions]
          .map((id) => sessions.get(id))
          .filter((s): s is VoiceSessionV27 => s !== undefined)
          .map((s) => {
            const snap = s.snapshot();
          return {
            sessionId: snap.sessionId,
            botId: snap.botId,
            personaId: snap.persona?.id ?? null,
            state: snap.state,
            turns: snap.turns,
            interrupts: snap.interrupts,
            recovered: snap.recovered,
            checkpoints: snap.checkpoints.length,
            open: snap.closedAtMs === null,
          };
        });
        const totals = {
          sessions: rows.length,
          open: rows.filter((r) => r.open).length,
          turns: rows.reduce((a, r) => a + r.turns, 0),
          interrupts: rows.reduce((a, r) => a + r.interrupts, 0),
          recovered: rows.filter((r) => r.recovered).length,
        };
        if (action === 'summary') {
          return JSON.stringify({ totals, sessions: rows });
        }
        const lines = [
          '# Voice report v27',
          '',
          `- Sessions: ${totals.sessions} (${totals.open} open, ${totals.recovered} recovered)`,
          `- Turns: ${totals.turns}`,
          `- Interrupts: ${totals.interrupts}`,
          '',
          '| session | bot | persona | state | turns | interrupts | recovered | open |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ];
        for (const r of rows) {
          lines.push(`| ${r.sessionId} | ${r.botId ?? '-'} | ${r.personaId ?? '-'} | ${r.state} | ${r.turns} | ${r.interrupts} | ${r.recovered} | ${r.open} |`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [interruptTool, vadTool, personasTool, sessionTool, stateTool, reportTool];
}

export const VOICE_V27_TOOLS: Tool[] = createVoiceV27Tools();

export const VOICE_V27_TOOL_NAMES = [
  'voice_v27_interrupt',
  'voice_v27_vad',
  'voice_v27_personas',
  'voice_v27_session',
  'voice_v27_state',
  'voice_v27_report',
] as const;

export function isVoiceV27ToolName(name: string): name is (typeof VOICE_V27_TOOL_NAMES)[number] {
  return (VOICE_V27_TOOL_NAMES as readonly string[]).includes(name);
}

export type { VoiceV27InterruptMode };
