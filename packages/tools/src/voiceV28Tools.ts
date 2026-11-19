/**
 * Voice v28 tools for @open-bot/tools (v1.41, Team T5).
 *
 * The agent drives the voice v28 realtime v3 loop by tool call:
 *  - voice_v28_session — a realtime session: start / pause /
 *    resume / stop, feed user audio (chunks or energy
 *    frames), record what the user said, speak an agent
 *    reply (mock TTS stream), finish it, barge in (stop
 *    playback, keep the remainder), resume the remainder,
 *    route a spoken command, refresh the memory-driven
 *    style, snapshot / stats / session log
 *  - voice_v28_stream — the mock realtime transport itself:
 *    push/pull inbound + outbound chunks, drain, flush,
 *    stats, events, synthetic tone/silence chunks
 *  - voice_v28_style — memory-block voice style: current
 *    config, derive from persona/human blocks, set block
 *    content (in-memory source), refresh on block change,
 *    apply a speaking-style preset, adjust rate/pitch,
 *    render the greeting
 *  - voice_v28_commands — voice command routing: route one
 *    transcript (or many) to a tool call, command log, stats
 *  - voice_v28_transcript — transcript + summary: record a
 *    turn, list turns, summarise, export JSON / Markdown
 *  - voice_v28_casting — multi-voice casting: assign /
 *    switch / unassign a voice per role per bot, resolve
 *    the voice for a role (with fallback), whole-cast
 *    snapshot, switch history, clone a cast
 *  - voice_v28_report — aggregate report over the sessions
 *    opened through voice_v28_session: totals, averages,
 *    per-bot and per-style breakdowns, one rollup per
 *    session, Markdown export
 *
 * SAFETY: everything here is local — clocks are virtual,
 * audio is mock/synthetic frame energy, TTS playback is a
 * mock stub (this machine has no TTS engine and no sound
 * card; only the control logic is real), providers are
 * never dialled, no key is read or stored. Memory blocks
 * live in an in-memory source unless the host injects its
 * own source; nothing is written to disk by these tools.
 *
 * Factory:
 *   createVoiceV28Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V28_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  MockRealtimeTransportV28,
  RealtimeVoiceSessionV28,
  TranscriptRecorderV28,
  VoiceCastingV28,
  VoiceCommandRouterV28,
  VoiceSessionRegistryV28,
  createInMemoryBlockSourceV28,
  createMemoryVoiceStyleBridgeV28,
  createMockRealtimeTransportV28,
  createRealtimeVoiceSessionV28,
  createTranscriptRecorderV28,
  createVoiceCastingV28,
  createVoiceCommandRouterV28,
  createVoiceSessionRegistryV28,
  synthSilenceChunkV28,
  synthToneChunkV28,
  type MemoryVoiceStyleBridgeV28,
  type VoiceV28BlockSource,
  type VoiceV28CastRole,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value);
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

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = getOptionalNumberArg(args, name);
  return value === undefined ? fallback : value;
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

function assertCastRole(value: string): VoiceV28CastRole {
  if (value !== 'narrator' && value !== 'assistant' && value !== 'announcer' && value !== 'alert') {
    throw new Error(`Unknown cast role: ${value}`);
  }
  return value;
}

export interface VoiceV28ToolOptions {
  /** Shared realtime session accessor (per session id). */
  getSession?: (sessionId: string) => RealtimeVoiceSessionV28 | null;
  /** Shared style bridge accessor (per bot id). */
  getStyleBridge?: (botId: string | null) => MemoryVoiceStyleBridgeV28 | null;
  /** Shared casting accessor (one instance for all bots). */
  getCasting?: () => VoiceCastingV28 | null;
  /** Shared command router accessor. */
  getRouter?: () => VoiceCommandRouterV28 | null;
  /** Block source the style bridges read (default: a fresh in-memory source). */
  blockSource?: VoiceV28BlockSource & {
    setBlock?: (label: string, content: string) => void;
    deleteBlock?: (label: string) => void;
  };
  /** Default bot id used when an action omits botId. */
  defaultBotId?: string | null;
}

export function createVoiceV28Tools(opts: VoiceV28ToolOptions = {}): Tool[] {
  const sessions = new Map<string, RealtimeVoiceSessionV28>();
  const openedSessions = new Set<string>();
  const standaloneTransports = new Map<string, MockRealtimeTransportV28>();
  const standaloneTranscripts = new Map<string, TranscriptRecorderV28>();
  const sharedCasting = new VoiceCastingV28();
  const sharedRouter = new VoiceCommandRouterV28();
  const registry = createVoiceSessionRegistryV28();
  const blockSource =
    opts.blockSource ??
    createInMemoryBlockSourceV28({
      persona: { content: '', version: 0 },
      human: { content: '', version: 0 },
    });
  // The default source starts empty: drop the placeholder
  // blocks so "no block" really means "no block".
  if (!opts.blockSource && typeof (blockSource as { deleteBlock?: unknown }).deleteBlock === 'function') {
    (blockSource as { deleteBlock: (label: string) => void }).deleteBlock('persona');
    (blockSource as { deleteBlock: (label: string) => void }).deleteBlock('human');
  }
  const styleBridges = new Map<string, MemoryVoiceStyleBridgeV28>();

  const needSession = (sessionId: string, botId: string | null): RealtimeVoiceSessionV28 => {
    const shared = opts.getSession?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = sessions.get(sessionId);
    if (found === undefined) {
      found = createRealtimeVoiceSessionV28(sessionId, {
        botId,
        styleBridge: { source: blockSource, botId },
      });
      sessions.set(sessionId, found);
    }
    return found;
  };

  const needBridge = (botId: string | null): MemoryVoiceStyleBridgeV28 => {
    const shared = opts.getStyleBridge?.(botId);
    if (shared !== null && shared !== undefined) return shared;
    const key = botId ?? '';
    let found = styleBridges.get(key);
    if (found === undefined) {
      found = createMemoryVoiceStyleBridgeV28({ source: blockSource, botId });
      styleBridges.set(key, found);
    }
    return found;
  };

  const needCasting = (): VoiceCastingV28 => {
    const shared = opts.getCasting?.();
    if (shared !== null && shared !== undefined) return shared;
    return sharedCasting;
  };

  const needRouter = (): VoiceCommandRouterV28 => {
    const shared = opts.getRouter?.();
    if (shared !== null && shared !== undefined) return shared;
    return sharedRouter;
  };

  const needStandaloneTransport = (sessionId: string): MockRealtimeTransportV28 => {
    let found = standaloneTransports.get(sessionId);
    if (found === undefined) {
      found = createMockRealtimeTransportV28();
      standaloneTransports.set(sessionId, found);
    }
    return found;
  };

  const needTranscript = (sessionId: string, botId: string | null): TranscriptRecorderV28 => {
    const session = sessions.get(sessionId);
    if (session) return session.transcript;
    let found = standaloneTranscripts.get(sessionId);
    if (found === undefined) {
      found = createTranscriptRecorderV28({ sessionId, botId });
      standaloneTranscripts.set(sessionId, found);
    }
    return found;
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v28_session',
      'Realtime voice session v28 (local, mock audio): start / pause / resume / stop a realtime voice session, feed user audio (synthetic chunks or energy frames), record what the user said, speak an agent reply (mock TTS stream), finish it, barge in (stop playback, keep the unspoken remainder), resume the remainder, route a spoken command, refresh the memory-driven voice style, snapshot / stats / session log. No mic, sound card, network or key is touched.',
      {
        action: { type: 'string', description: 'start, pause, resume, stop, status, stats, log, reply, reply-done, feed-chunk, feed-frame, user-said, barge-in, resume-remainder, route-command, refresh-style, apply-preset, greeting or snapshot.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        botId: { type: 'string', description: 'Bot id (start, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        reason: { type: 'string', description: 'Stop reason: user-request, command, timeout, transport-error or idle-timeout (stop, optional).' },
        text: { type: 'string', description: 'Reply text (reply) or what the user said (user-said, barge-in).' },
        castRole: { type: 'string', description: 'Cast role for the reply: narrator, assistant, announcer or alert (reply, optional).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed-frame).' },
        speechMs: { type: 'number', description: 'Caller-measured user speech duration ms (barge-in).' },
        samplesJson: { type: 'string', description: 'PCM16-normalised samples as a JSON number array (feed-chunk).' },
        sampleRate: { type: 'number', description: 'Sample rate Hz (feed-chunk, optional).' },
        style: { type: 'string', description: 'Speaking-style preset id (apply-preset).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        const botId = getOptionalStringArg(args, 'botId') ?? opts.defaultBotId ?? null;
        if (!isAction(
          ['start', 'pause', 'resume', 'stop', 'status', 'stats', 'log', 'reply', 'reply-done', 'feed-chunk', 'feed-frame', 'user-said', 'barge-in', 'resume-remainder', 'route-command', 'refresh-style', 'apply-preset', 'greeting', 'snapshot'],
          action,
        )) {
          return errorResult(`Unknown action: ${action}`);
        }
        if (action === 'start') {
          if (openedSessions.has(sessionId)) return errorResult(`Session already started: ${sessionId}`);
          const session = needSession(sessionId, botId);
          openedSessions.add(sessionId);
          registry.register(session);
          return okResult(session.start(atMs));
        }
        const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
        if (session === null) return errorResult(`Unknown session: ${sessionId} (start it first)`);
        switch (action) {
          case 'pause':
            return okResult(session.pause(atMs));
          case 'resume':
            return okResult(session.resume(atMs));
          case 'stop': {
            const reasonRaw = getOptionalStringArg(args, 'reason') ?? 'user-request';
            const allowedReasons = ['user-request', 'command', 'timeout', 'transport-error', 'idle-timeout'];
            if (!allowedReasons.includes(reasonRaw)) return errorResult(`Unknown stop reason: ${reasonRaw}`);
            return okResult(session.stop(atMs, reasonRaw as never));
          }
          case 'status':
          case 'snapshot':
            return okResult(session.snapshot());
          case 'stats':
            return okResult(session.stats());
          case 'log':
            return okResult(session.sessionLog());
          case 'reply': {
            const text = getStringArg(args, 'text');
            const role = assertCastRole(getOptionalStringArg(args, 'castRole') ?? 'assistant');
            return okResult(session.agentReply(text, atMs, role));
          }
          case 'reply-done':
            return okResult(session.agentReplyDone(atMs));
          case 'feed-chunk': {
            const samples = parseNumberArray(getOptionalStringArg(args, 'samplesJson'), 'samplesJson');
            const sampleRate = getOptionalNumberArg(args, 'sampleRate') ?? 16000;
            const chunk = {
              seq: session.transport.stats().nextSeqIn,
              atMs,
              source: 'mic' as const,
              samples,
              sampleRate,
              channels: 1,
              final: false,
            };
            return okResult(session.feedUserChunk(chunk, atMs));
          }
          case 'feed-frame': {
            const energy = getNumberArg(args, 'energy', 0);
            session.feedUserFrames([{ atMs, energy }]);
            return okResult({ fed: true, atMs, energy });
          }
          case 'user-said': {
            const text = getStringArg(args, 'text');
            session.userSaid(text, atMs);
            return okResult({ recorded: true, text });
          }
          case 'barge-in': {
            const speechMs = getNumberArg(args, 'speechMs', 0);
            const userText = getOptionalStringArg(args, 'text') ?? '';
            return okResult(session.handleBargeIn(speechMs, atMs, userText));
          }
          case 'resume-remainder': {
            const resumed = session.resumeRemainder(atMs);
            return okResult(resumed ?? { resumed: false, reason: 'no remainder kept' });
          }
          case 'route-command': {
            const text = getStringArg(args, 'text');
            return okResult(session.routeCommand(text, atMs));
          }
          case 'refresh-style': {
            const result = session.refreshStyle(atMs);
            return okResult(result ?? { refreshed: false, reason: 'no style bridge' });
          }
          case 'apply-preset': {
            const style = getStringArg(args, 'style');
            const result = session.applyStylePreset(style, atMs);
            return okResult(result ?? { applied: false, reason: 'no style bridge' });
          }
          case 'greeting':
            return okResult({ greeting: session.greeting() });
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const streamTool: Tool = {
    definition: toolDef(
      'voice_v28_stream',
      'Mock realtime transport v28 (local, synthetic audio): push/pull inbound (mic) and outbound (tts) chunks through the streaming transport, drain both directions, flush queues, read transport stats + events, or synthesise tone/silence chunks. No network, key, mic or sound card is touched.',
      {
        action: { type: 'string', description: 'push-in, push-out, pull-in, pull-out, drain, flush, stats, events, synth-tone or synth-silence.' },
        sessionId: { type: 'string', description: 'Voice session id (uses the session transport when the session exists, else a standalone transport).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        seq: { type: 'number', description: 'Chunk sequence number (push, optional — auto-assigned).' },
        source: { type: 'string', description: 'Chunk source: mic or tts (push, synth).' },
        samplesJson: { type: 'string', description: 'PCM16-normalised samples as a JSON number array (push).' },
        sampleRate: { type: 'number', description: 'Sample rate Hz (push, synth, optional).' },
        frequencyHz: { type: 'number', description: 'Tone frequency Hz (synth-tone, optional).' },
        amplitude: { type: 'number', description: 'Tone amplitude 0..1 (synth-tone, optional).' },
        final: { type: 'string', description: '"true" when the chunk ends a burst (push, optional).' },
        expectingAudio: { type: 'string', description: '"true" to count an empty pull-out as an underrun (pull-out, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['push-in', 'push-out', 'pull-in', 'pull-out', 'drain', 'flush', 'stats', 'events', 'synth-tone', 'synth-silence'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const session = sessions.get(sessionId) ?? opts.getSession?.(sessionId) ?? null;
        const transport = session ? session.transport : needStandaloneTransport(sessionId);
        switch (action) {
          case 'stats':
            return okResult(transport.stats());
          case 'events':
            return okResult(transport.events());
          case 'flush':
            return okResult(transport.flush(atMs));
          case 'drain':
            return okResult(transport.drain(atMs));
          case 'pull-in':
            return okResult(transport.pullIn(atMs) ?? { pulled: false });
          case 'pull-out': {
            const expecting = getOptionalStringArg(args, 'expectingAudio') === 'true';
            return okResult(transport.pullOut(atMs, expecting) ?? { pulled: false });
          }
          case 'push-in':
          case 'push-out': {
            const source = action === 'push-in' ? 'mic' as const : 'tts' as const;
            const samples = parseNumberArray(getOptionalStringArg(args, 'samplesJson'), 'samplesJson');
            if (samples.length === 0) return errorResult('samplesJson must be a non-empty JSON array of numbers');
            const stats = transport.stats();
            const seq = getOptionalNumberArg(args, 'seq') ?? (source === 'mic' ? stats.nextSeqIn : stats.nextSeqOut);
            const chunk = {
              seq,
              atMs,
              source,
              samples,
              sampleRate: getOptionalNumberArg(args, 'sampleRate') ?? 16000,
              channels: 1,
              final: getOptionalStringArg(args, 'final') === 'true',
            };
            const accepted = source === 'mic' ? transport.pushIn(chunk) : transport.pushOut(chunk);
            return okResult({ accepted, seq, source });
          }
          case 'synth-tone':
          case 'synth-silence': {
            const source = (getOptionalStringArg(args, 'source') ?? 'mic') as 'mic' | 'tts';
            if (source !== 'mic' && source !== 'tts') return errorResult('source must be "mic" or "tts"');
            const stats = transport.stats();
            const seq = getOptionalNumberArg(args, 'seq') ?? (source === 'mic' ? stats.nextSeqIn : stats.nextSeqOut);
            const chunk =
              action === 'synth-tone'
                ? synthToneChunkV28(seq, atMs, source, {
                    frequencyHz: getOptionalNumberArg(args, 'frequencyHz'),
                    amplitude: getOptionalNumberArg(args, 'amplitude'),
                  })
                : synthSilenceChunkV28(seq, atMs, source);
            const accepted = source === 'mic' ? transport.pushIn(chunk) : transport.pushOut(chunk);
            return okResult({ accepted, seq, source, samples: chunk.samples.length });
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const styleTool: Tool = {
    definition: toolDef(
      'voice_v28_style',
      'Memory-block voice style v28 (local): read the current voice config derived from the persona/human memory blocks, set block content, refresh the config when blocks change, apply a speaking-style preset (formal / intimate / concise / storyteller / default), adjust rate or pitch, or render the greeting. Falls back to the default preset when no block exists. No network or key is touched.',
      {
        action: { type: 'string', description: 'current, derive, set-block, delete-block, refresh, apply-preset, adjust-rate, adjust-pitch or greeting.' },
        botId: { type: 'string', description: 'Bot id (optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        label: { type: 'string', description: 'Block label: persona or human (set-block, delete-block).' },
        content: { type: 'string', description: 'Block content (set-block).' },
        style: { type: 'string', description: 'Speaking-style preset id (apply-preset).' },
        delta: { type: 'number', description: 'Rate/pitch adjustment (adjust-rate, adjust-pitch).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const atMs = getNumberArg(args, 'atMs', 0);
        const botId = getOptionalStringArg(args, 'botId') ?? opts.defaultBotId ?? null;
        if (!isAction(['current', 'derive', 'set-block', 'delete-block', 'refresh', 'apply-preset', 'adjust-rate', 'adjust-pitch', 'greeting'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const bridge = needBridge(botId);
        switch (action) {
          case 'current':
            return okResult(bridge.current);
          case 'derive':
          case 'refresh': {
            const result = bridge.refresh(atMs);
            return okResult(result);
          }
          case 'set-block': {
            const label = getStringArg(args, 'label');
            const content = getStringArg(args, 'content');
            if (label !== 'persona' && label !== 'human') return errorResult('label must be "persona" or "human"');
            if (typeof (blockSource as { setBlock?: unknown }).setBlock !== 'function') {
              return errorResult('this block source is read-only (set-block needs the default in-memory source)');
            }
            (blockSource as { setBlock: (label: string, content: string) => void }).setBlock(label, content);
            return okResult(bridge.refresh(atMs));
          }
          case 'delete-block': {
            const label = getStringArg(args, 'label');
            if (label !== 'persona' && label !== 'human') return errorResult('label must be "persona" or "human"');
            if (typeof (blockSource as { deleteBlock?: unknown }).deleteBlock !== 'function') {
              return errorResult('this block source is read-only (delete-block needs the default in-memory source)');
            }
            (blockSource as { deleteBlock: (label: string) => void }).deleteBlock(label);
            return okResult(bridge.refresh(atMs));
          }
          case 'apply-preset': {
            const style = getStringArg(args, 'style');
            const allowedStyles = ['formal', 'intimate', 'concise', 'storyteller', 'default'];
            if (!allowedStyles.includes(style)) return errorResult(`Unknown speaking style: ${style}`);
            return okResult(bridge.applyPreset(style as never, atMs));
          }
          case 'adjust-rate': {
            const delta = getNumberArg(args, 'delta', 0);
            return okResult(bridge.adjustRate(delta, atMs));
          }
          case 'adjust-pitch': {
            const delta = getNumberArg(args, 'delta', 0);
            return okResult(bridge.adjustPitch(delta, atMs));
          }
          case 'greeting':
            return okResult({ greeting: bridge.greeting() });
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const commandsTool: Tool = {
    definition: toolDef(
      'voice_v28_commands',
      'Voice command routing v28 (local): match a spoken transcript against builtin intents (English + Vietnamese) and route it to a tool call — stop / pause / resume the session, switch voice or style, repeat the last reply, summarise the session, speak slower / faster / softer / louder, open settings. Routing never executes anything; the host runs the returned tool call. Unknown transcripts return kind "unknown".',
      {
        action: { type: 'string', description: 'route, route-many or log or stats.' },
        transcript: { type: 'string', description: 'Spoken transcript to route (route).' },
        transcriptsJson: { type: 'string', description: 'JSON array of transcripts (route-many).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['route', 'route-many', 'log', 'stats'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const router = needRouter();
        switch (action) {
          case 'route': {
            const transcript = getStringArg(args, 'transcript');
            return okResult(router.route(transcript, atMs));
          }
          case 'route-many': {
            const raw = parseJsonArg(getOptionalStringArg(args, 'transcriptsJson'), 'transcriptsJson');
            if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
              return errorResult('transcriptsJson must be a JSON array of strings');
            }
            return okResult(router.routeMany(raw as string[], atMs));
          }
          case 'log':
            return okResult(router.commandLog());
          case 'stats':
            return okResult(router.stats());
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const transcriptTool: Tool = {
    definition: toolDef(
      'voice_v28_transcript',
      'Transcript + summary v28 (local): record a finished turn, list the turns of a session, summarise the session (counts, durations, interruptions, top phrases, key sentences), or export the whole record as JSON / Markdown. Everything is plain data; nothing is written to disk.',
      {
        action: { type: 'string', description: 'record, turns, summary, export-json or export-markdown.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        botId: { type: 'string', description: 'Bot id (record, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        speaker: { type: 'string', description: 'Turn speaker: user or agent (record).' },
        text: { type: 'string', description: 'Turn text (record).' },
        startedAtMs: { type: 'number', description: 'Turn start, virtual ms (record).' },
        endedAtMs: { type: 'number', description: 'Turn end, virtual ms (record).' },
        interrupted: { type: 'string', description: '"true" when the turn was cut by a barge-in (record, optional).' },
        voiceId: { type: 'string', description: 'Voice that spoke the turn (record, optional).' },
        castRole: { type: 'string', description: 'Cast role that spoke the turn (record, optional).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getNumberArg(args, 'atMs', 0);
        const botId = getOptionalStringArg(args, 'botId') ?? opts.defaultBotId ?? null;
        if (!isAction(['record', 'turns', 'summary', 'export-json', 'export-markdown'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const recorder = needTranscript(sessionId, botId);
        switch (action) {
          case 'record': {
            const speaker = getStringArg(args, 'speaker');
            if (speaker !== 'user' && speaker !== 'agent') return errorResult('speaker must be "user" or "agent"');
            const text = getStringArg(args, 'text');
            const startedAtMs = getNumberArg(args, 'startedAtMs', atMs);
            const endedAtMs = getNumberArg(args, 'endedAtMs', atMs);
            const role = getOptionalStringArg(args, 'castRole');
            return okResult(
              recorder.recordTurn(speaker, text, startedAtMs, endedAtMs, {
                interrupted: getOptionalStringArg(args, 'interrupted') === 'true',
                voiceId: getOptionalStringArg(args, 'voiceId') ?? null,
                castRole: role ? assertCastRole(role) : null,
              }),
            );
          }
          case 'turns':
            return okResult(recorder.allTurns());
          case 'summary': {
            const session = sessions.get(sessionId) ?? null;
            return okResult(
              recorder.summarise(atMs, {
                style: session?.snapshot().style ?? 'default',
                voiceId: session?.snapshot().voiceId ?? null,
              }),
            );
          }
          case 'export-json': {
            const session = sessions.get(sessionId) ?? null;
            return okResult(
              recorder.exportJson(atMs, {
                style: session?.snapshot().style ?? 'default',
                voiceId: session?.snapshot().voiceId ?? null,
              }),
            );
          }
          case 'export-markdown': {
            const session = sessions.get(sessionId) ?? null;
            return okResult(
              recorder.exportMarkdown(atMs, {
                style: session?.snapshot().style ?? 'default',
                voiceId: session?.snapshot().voiceId ?? null,
              }),
            );
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const castingTool: Tool = {
    definition: toolDef(
      'voice_v28_casting',
      'Multi-voice casting v28 (local): assign / switch / unassign a voice per role (narrator / assistant / announcer / alert) per bot, resolve the voice that should speak a role right now (with the fallback chain when the assigned voice is unavailable), read a whole-cast snapshot, list switch history, or clone one bot cast to another. No provider is dialled; availability is what the host reports.',
      {
        action: { type: 'string', description: 'assign, switch, unassign, resolve, cast, snapshot, events, clone or remove-bot.' },
        botId: { type: 'string', description: 'Bot id.' },
        role: { type: 'string', description: 'Cast role: narrator, assistant, announcer or alert.' },
        voiceId: { type: 'string', description: 'Voice id (assign, switch).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        reason: { type: 'string', description: 'Switch reason (assign, switch, optional).' },
        fromBotId: { type: 'string', description: 'Source bot id (clone).' },
        toBotId: { type: 'string', description: 'Destination bot id (clone).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['assign', 'switch', 'unassign', 'resolve', 'cast', 'snapshot', 'events', 'clone', 'remove-bot'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        const casting = needCasting();
        switch (action) {
          case 'assign':
          case 'switch': {
            const botId = getStringArg(args, 'botId');
            const role = assertCastRole(getStringArg(args, 'role'));
            const voiceId = getStringArg(args, 'voiceId');
            const reason = getOptionalStringArg(args, 'reason') ?? action;
            return okResult(casting.assign(botId, role, voiceId, atMs, reason));
          }
          case 'unassign': {
            const botId = getStringArg(args, 'botId');
            const role = assertCastRole(getStringArg(args, 'role'));
            return okResult({ removed: casting.unassign(botId, role, atMs) });
          }
          case 'resolve': {
            const botId = getStringArg(args, 'botId');
            const role = assertCastRole(getStringArg(args, 'role'));
            return okResult(casting.voiceFor(botId, role));
          }
          case 'cast': {
            const botId = getStringArg(args, 'botId');
            return okResult(casting.castForBot(botId));
          }
          case 'snapshot': {
            const botId = getStringArg(args, 'botId');
            return okResult(casting.snapshot(botId));
          }
          case 'events': {
            const botId = getStringArg(args, 'botId');
            return okResult(casting.switchEvents(botId));
          }
          case 'clone': {
            const fromBotId = getStringArg(args, 'fromBotId');
            const toBotId = getStringArg(args, 'toBotId');
            return okResult(casting.cloneCast(fromBotId, toBotId, atMs));
          }
          case 'remove-bot': {
            const botId = getStringArg(args, 'botId');
            return okResult({ removed: casting.removeBot(botId) });
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'voice_v28_report',
      'Aggregate voice report v28 (local): totals, averages, per-bot and per-style breakdowns over the realtime sessions opened through voice_v28_session, one rollup per session, or the whole report as Markdown. Read-only: reporting never drives a live session.',
      {
        action: { type: 'string', description: 'report, markdown, rollup, list or unregister.' },
        sessionId: { type: 'string', description: 'Voice session id (rollup, unregister).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        const atMs = getNumberArg(args, 'atMs', 0);
        if (!isAction(['report', 'markdown', 'rollup', 'list', 'unregister'], action)) {
          return errorResult(`Unknown action: ${action}`);
        }
        switch (action) {
          case 'report':
            return okResult(registry.aggregate(atMs));
          case 'markdown':
            return okResult(registry.toMarkdown(atMs));
          case 'list':
            return okResult(registry.ids());
          case 'rollup': {
            const sessionId = getStringArg(args, 'sessionId');
            const rollup = registry.rollup(sessionId, atMs);
            if (rollup === null) return errorResult(`Unknown session: ${sessionId}`);
            return okResult(rollup);
          }
          case 'unregister': {
            const sessionId = getStringArg(args, 'sessionId');
            return okResult({ removed: registry.unregister(sessionId) });
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [sessionTool, streamTool, styleTool, commandsTool, transcriptTool, castingTool, reportTool];
}

export const VOICE_V28_TOOLS: Tool[] = createVoiceV28Tools();

export const VOICE_V28_TOOL_NAMES = [
  'voice_v28_session',
  'voice_v28_stream',
  'voice_v28_style',
  'voice_v28_commands',
  'voice_v28_transcript',
  'voice_v28_casting',
  'voice_v28_report',
] as const;

export function isVoiceV28ToolName(name: string): name is (typeof VOICE_V28_TOOL_NAMES)[number] {
  return (VOICE_V28_TOOL_NAMES as readonly string[]).includes(name);
}
