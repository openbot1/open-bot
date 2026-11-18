/**
 * Voice v22 tools for @open-bot/tools (v1.35, Đội T5).
 *
 * The agent drives the durable voice v22 realtime session by tool call:
 *  - voice_v22_session    — start / feed-final / feed-partial / pause /
 *    resume-paused / checkpoint / snapshot / restore / disconnect /
 *    reconnect / resume-queued / status / close a durable session
 *    (mock STT/model/TTS, virtual clock, journalled + checkpointed)
 *  - voice_v22_barge_in   — score a barge-in burst (ignore / duck-soft /
 *    duck-hard / interrupt), cut a reply, queue / take / drop the
 *    remainder, summarise a cut reply
 *  - voice_v22_turn       — turn-taking state machine v2: state / event /
 *    floor request / floor stats / overlap classification / silence
 *  - voice_v22_profile    — voice profiles: list / get / add / update /
 *    remove / switch / user default / resolve fallback chain
 *  - voice_v22_recovery   — heartbeat / disconnect / reconnect attempt /
 *    backoff delay / recovery status (mock transport, virtual clock)
 *  - voice_v22_monitor    — durability monitor panel snapshot / markdown
 *    (phase, floor, profile, journal, resume, recovery, queued replies)
 *
 * SAFETY: everything here is local — transcripts are caller
 * supplied text (no mic), TTS is synthetic PCM, heartbeats and
 * reconnects are mock (no transport is dialled), snapshots are
 * plain JSON the host persists, and no provider is called, no
 * key is read or stored, no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV22Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V22_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  VoiceSessionV22,
  TurnTakingMachineV22,
  BargeInEngineV22,
  VoiceProfileRegistryV22,
  RecoveryEngineV22,
  MonitorPanelV22,
  DurableSessionStoreV22,
  ResumeEngineV22,
  scoreBargeInV22,
  decideBargeInV22,
  splitReplyAtCutV22,
  isBackchannelBurstV22,
  backoffDelayV22,
  clampProsodyV22,
  validateProfileV22,
  builtinProfilesV22,
  parseResumeTokenV22,
  type VoiceV22Profile,
  type VoiceV22SessionOptions,
  type VoiceV22TurnTakingOptions,
  type VoiceV22BargeInOptions,
  type VoiceV22StoreOptions,
  type VoiceV22ResumeOptions,
  type VoiceV22RecoveryOptions,
  type VoiceV22ProfileOptions,
  type VoiceV22MonitorPanelOptions,
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

export interface VoiceV22ToolOptions {
  /** Session accessor (the host binds its session). */
  getSession?: () => VoiceSessionV22 | null;
  /** Turn-taking machine accessor. */
  getTurnMachine?: () => TurnTakingMachineV22 | null;
  /** Barge-in engine accessor. */
  getBargeInEngine?: () => BargeInEngineV22 | null;
  /** Voice profile registry accessor. */
  getProfileRegistry?: () => VoiceProfileRegistryV22 | null;
  /** Recovery engine accessor. */
  getRecoveryEngine?: () => RecoveryEngineV22 | null;
  /** Durable session store accessor. */
  getStore?: () => DurableSessionStoreV22 | null;
  /** Resume engine accessor. */
  getResumeEngine?: () => ResumeEngineV22 | null;
  /** Monitor panel accessor. */
  getMonitorPanel?: () => MonitorPanelV22 | null;
  /** Options for the default session. */
  sessionOptions?: Partial<VoiceV22SessionOptions>;
  /** Options for the default turn machine. */
  turnOptions?: Partial<VoiceV22TurnTakingOptions>;
  /** Options for the default barge-in engine. */
  bargeInOptions?: Partial<VoiceV22BargeInOptions>;
  /** Options for the default store. */
  storeOptions?: Partial<VoiceV22StoreOptions>;
  /** Options for the default resume engine. */
  resumeOptions?: Partial<VoiceV22ResumeOptions>;
  /** Options for the default recovery engine. */
  recoveryOptions?: Partial<VoiceV22RecoveryOptions>;
  /** Options for the default profile registry. */
  profileOptions?: Partial<VoiceV22ProfileOptions>;
  /** Options for the default monitor panel. */
  panelOptions?: Partial<VoiceV22MonitorPanelOptions>;
}

const SESSION_ACTIONS = [
  'start', 'feed-final', 'feed-partial', 'pause', 'resume-paused',
  'checkpoint', 'snapshot', 'restore', 'disconnect', 'reconnect',
  'resume-queued', 'resume-token', 'status', 'close',
] as const;
const TURN_ACTIONS = ['state', 'event', 'stats', 'classify-overlap', 'floor-request', 'silence'] as const;
const PROFILE_ACTIONS = ['list', 'get', 'add', 'update', 'remove', 'switch', 'user-default', 'resolve', 'stats'] as const;
const RECOVERY_ACTIONS = ['heartbeat', 'disconnect', 'attempt', 'backoff', 'status'] as const;
const MONITOR_ACTIONS = ['snapshot', 'markdown'] as const;

function isSessionAction(v: string): v is (typeof SESSION_ACTIONS)[number] {
  return (SESSION_ACTIONS as readonly string[]).includes(v);
}
function isTurnAction(v: string): v is (typeof TURN_ACTIONS)[number] {
  return (TURN_ACTIONS as readonly string[]).includes(v);
}
function isProfileAction(v: string): v is (typeof PROFILE_ACTIONS)[number] {
  return (PROFILE_ACTIONS as readonly string[]).includes(v);
}
function isRecoveryAction(v: string): v is (typeof RECOVERY_ACTIONS)[number] {
  return (RECOVERY_ACTIONS as readonly string[]).includes(v);
}
function isMonitorAction(v: string): v is (typeof MONITOR_ACTIONS)[number] {
  return (MONITOR_ACTIONS as readonly string[]).includes(v);
}

export function createVoiceV22Tools(opts: VoiceV22ToolOptions = {}): Tool[] {
  const defaultSession = new VoiceSessionV22('default', opts.sessionOptions);
  const defaultTurns = new TurnTakingMachineV22('default', opts.turnOptions);
  const defaultBargeIn = new BargeInEngineV22('default', opts.bargeInOptions);
  const defaultProfiles = new VoiceProfileRegistryV22('default', opts.profileOptions);
  const defaultRecovery = new RecoveryEngineV22('default', opts.recoveryOptions);
  const defaultStore = new DurableSessionStoreV22('default', opts.storeOptions);
  const defaultResume = new ResumeEngineV22('default', opts.resumeOptions);
  const defaultPanel = new MonitorPanelV22('default', opts.panelOptions);
  const needSession = (): VoiceSessionV22 => opts.getSession?.() ?? defaultSession;
  const needTurns = (): TurnTakingMachineV22 => opts.getTurnMachine?.() ?? defaultTurns;
  const needBargeIn = (): BargeInEngineV22 => opts.getBargeInEngine?.() ?? defaultBargeIn;
  const needProfiles = (): VoiceProfileRegistryV22 => opts.getProfileRegistry?.() ?? defaultProfiles;
  const needRecovery = (): RecoveryEngineV22 => opts.getRecoveryEngine?.() ?? defaultRecovery;
  const needStore = (): DurableSessionStoreV22 => opts.getStore?.() ?? defaultStore;
  const needResume = (): ResumeEngineV22 => opts.getResumeEngine?.() ?? defaultResume;
  const needPanel = (): MonitorPanelV22 => opts.getMonitorPanel?.() ?? defaultPanel;

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v22_session',
      'Drive a durable voice v22 realtime session (local action): start, feed a final/partial transcript, pause/resume, write a checkpoint, snapshot/restore the store, simulate a disconnect, attempt a reconnect (resume from checkpoint), resume a queued cut reply, or read status. STT/model/TTS are mock (scripted), the clock is virtual, no mic or network.',
      {
        action: { type: 'string', description: 'start, feed-final, feed-partial, pause, resume-paused, checkpoint, snapshot, restore, disconnect, reconnect, resume-queued, resume-token, status or close.' },
        sessionId: { type: 'string', description: 'Session id (default session when omitted).' },
        text: { type: 'string', description: 'Transcript text (feed-final / feed-partial).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default: session clock).' },
        snapshotJson: { type: 'string', description: 'Snapshot JSON to restore (restore).' },
        outcome: { type: 'string', description: '"success" or "failure" for a reconnect attempt (reconnect).' },
        token: { type: 'string', description: 'Resume token (resume-token).' },
        message: { type: 'string', description: 'Disconnect message (disconnect, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isSessionAction(action)) return errorResult(`Unknown action "${action}" (${SESSION_ACTIONS.join(', ')})`);
        const session = needSession();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? session.nowMs();
        if (action === 'start') {
          session.start(atMs);
          return JSON.stringify({ ok: true, action, sessionId: session.sessionId, state: session.state(), phase: session.phase(), atMs });
        }
        if (action === 'status') {
          return JSON.stringify({ ok: true, sessionId: session.sessionId, ...session.stats(), durability: session.durabilityReport(atMs) });
        }
        if (action === 'close') {
          session.close(atMs);
          return JSON.stringify({ ok: true, action, sessionId: session.sessionId });
        }
        if (action === 'pause') {
          session.pause(atMs);
          return JSON.stringify({ ok: true, action, state: session.state(), phase: session.phase() });
        }
        if (action === 'resume-paused') {
          session.resumePaused(atMs);
          return JSON.stringify({ ok: true, action, state: session.state(), phase: session.phase() });
        }
        if (action === 'feed-partial') {
          const text = getStringArg(args, 'text');
          await session.feedPartial(text, atMs);
          return JSON.stringify({ ok: true, action, state: session.state(), livePartial: text });
        }
        if (action === 'feed-final') {
          const text = getStringArg(args, 'text');
          const reply = await session.feedFinal(text, atMs);
          return JSON.stringify({ ok: true, action, state: session.state(), phase: session.phase(), reply });
        }
        if (action === 'checkpoint') {
          const result = session.checkpointNow(atMs);
          return JSON.stringify({
            ok: true, action,
            journalSeq: result === null ? null : result.checkpoint.journalSeq,
            checksum: result === null ? null : result.checksum,
            resumeToken: result === null ? null : result.checkpoint.resumeToken,
          });
        }
        if (action === 'snapshot') {
          return JSON.stringify({ ok: true, action, snapshotJson: session.snapshotJson(atMs) });
        }
        if (action === 'restore') {
          const json = getStringArg(args, 'snapshotJson');
          const errors = session.restoreSnapshotJson(json);
          if (errors.length > 0) return errorResult(`Restore failed: ${errors.join('; ')}`);
          return JSON.stringify({ ok: true, action, restored: true });
        }
        if (action === 'disconnect') {
          session.simulateDisconnect(atMs, getOptionalStringArg(args, 'message'));
          return JSON.stringify({ ok: true, action, phase: session.phase(), state: session.state() });
        }
        if (action === 'reconnect') {
          const outcome = getOptionalStringArg(args, 'outcome') ?? 'success';
          if (outcome !== 'success' && outcome !== 'failure') return errorResult(`outcome must be "success" or "failure", got "${outcome}"`);
          const report = await session.attemptReconnect(atMs, outcome);
          return JSON.stringify({ ok: true, action, outcome, phase: session.phase(), state: session.state(), report });
        }
        if (action === 'resume-queued') {
          const spoken = await session.resumeQueuedReply(atMs);
          return JSON.stringify({ ok: true, action, spoken, state: session.state() });
        }
        // resume-token
        const token = getStringArg(args, 'token');
        const parsed = parseResumeTokenV22(token);
        const report = session.resumeWithToken(token, atMs);
        return JSON.stringify({ ok: true, action, parsed, report });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bargeInTool: Tool = {
    definition: toolDef(
      'voice_v22_barge_in',
      'Barge-in v2 scoring and reply cutting (local action): score a burst of user audio while the agent speaks (ignore / duck-soft / duck-hard / interrupt), cut a reply at the spoken point with a resume disposition, list/take/drop queued cut replies, or summarise a cut reply.',
      {
        action: { type: 'string', description: 'score, cut, queued, take, drop or summarise.' },
        energy: { type: 'number', description: 'Burst energy 0..1 (score).' },
        sustainMs: { type: 'number', description: 'Burst sustain in ms (score).' },
        wordsJson: { type: 'string', description: 'Burst words as a JSON array (score).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        echo: { type: 'string', description: '"true" when the burst is known agent echo (score, optional).' },
        replyText: { type: 'string', description: 'Agent reply text to cut (cut / summarise).' },
        spokenChars: { type: 'number', description: 'Chars already spoken (cut).' },
        queueId: { type: 'string', description: 'Queued reply id (drop).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const valid = ['score', 'cut', 'queued', 'take', 'drop', 'summarise'] as const;
        if (!(valid as readonly string[]).includes(action)) return errorResult(`Unknown action "${action}" (${valid.join(', ')})`);
        const engine = needBargeIn();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'queued') {
          return JSON.stringify({ ok: true, queued: engine.queuedReplies(), stats: engine.stats() });
        }
        if (action === 'take') {
          const taken = engine.takeQueued();
          return JSON.stringify({ ok: true, taken });
        }
        if (action === 'drop') {
          const id = getStringArg(args, 'queueId');
          return JSON.stringify({ ok: true, dropped: engine.dropQueued(id), queued: engine.queuedReplies() });
        }
        if (action === 'summarise') {
          const replyText = getStringArg(args, 'replyText');
          const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
          const cut = splitReplyAtCutV22(replyText, spokenChars);
          return JSON.stringify({ ok: true, cut, summary: engine.summariseCut(cut) });
        }
        if (action === 'cut') {
          const replyText = getStringArg(args, 'replyText');
          const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
          const cut = engine.cutReply(replyText, spokenChars, atMs, 'tool-turn');
          return JSON.stringify({ ok: true, cut, queued: engine.queuedReplies() });
        }
        // score
        const energy = getOptionalNumberArg(args, 'energy') ?? 0;
        const sustainMs = getOptionalNumberArg(args, 'sustainMs') ?? 0;
        const wordsRaw = parseJsonArg(getOptionalStringArg(args, 'wordsJson'), 'wordsJson');
        const words = Array.isArray(wordsRaw) ? wordsRaw.filter((w): w is string => typeof w === 'string') : [];
        const echo = getOptionalStringArg(args, 'echo') === 'true';
        const score = scoreBargeInV22({ atMs, energy, sustainMs, words, echo, agentSpeaking: true });
        const decision = decideBargeInV22(score);
        return JSON.stringify({
          ok: true,
          decision,
          score,
          backchannel: isBackchannelBurstV22(words),
          cooldownMs: engine.cooldownRemainingMs(atMs),
          stats: engine.stats(),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const turnTool: Tool = {
    definition: toolDef(
      'voice_v22_turn',
      'Turn-taking state machine v2 (local action): read the current state/floor/stats, feed one turn event, request the floor (polite / duck / interrupt), classify an overlap duration (backchannel / overlap / barge-in), or check silence (nudge / yield).',
      {
        action: { type: 'string', description: 'state, event, stats, classify-overlap, floor-request or silence.' },
        event: { type: 'string', description: 'Turn event (event action): user-speech-start, user-speech-end, agent-speak-start, agent-speak-end, barge-in, duck-hard, duck-soft, yield, resume-held, pause, resume, confirm-requested, confirm-resolved, timeout, silence-nudge, reset.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        text: { type: 'string', description: 'Turn text (event action, optional).' },
        durationMs: { type: 'number', description: 'Overlap duration in ms (classify-overlap).' },
        requester: { type: 'string', description: 'Floor requester: user, agent or system (floor-request).' },
        priority: { type: 'string', description: 'Floor priority: polite, duck or interrupt (floor-request).' },
        reason: { type: 'string', description: 'Floor request reason (floor-request, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isTurnAction(action)) return errorResult(`Unknown action "${action}" (${TURN_ACTIONS.join(', ')})`);
        const machine = needTurns();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'state') {
          return JSON.stringify({ ok: true, state: machine.currentState(), floor: machine.currentFloor(), msInState: machine.msInState(atMs) });
        }
        if (action === 'stats') {
          return JSON.stringify({ ok: true, ...machine.stats(), summary: machine.summary() });
        }
        if (action === 'classify-overlap') {
          const durationMs = getOptionalNumberArg(args, 'durationMs');
          if (durationMs === undefined) return errorResult('Missing required argument: "durationMs"');
          return JSON.stringify({ ok: true, durationMs, classification: machine.classifyOverlap(durationMs) });
        }
        if (action === 'silence') {
          return JSON.stringify({ ok: true, result: machine.checkSilence(atMs), state: machine.currentState(), floor: machine.currentFloor() });
        }
        if (action === 'floor-request') {
          const requester = getStringArg(args, 'requester');
          if (requester !== 'user' && requester !== 'agent' && requester !== 'system') {
            return errorResult(`requester must be "user", "agent" or "system", got "${requester}"`);
          }
          const priority = getStringArg(args, 'priority');
          if (priority !== 'polite' && priority !== 'duck' && priority !== 'interrupt') {
            return errorResult(`priority must be "polite", "duck" or "interrupt", got "${priority}"`);
          }
          const reason = getOptionalStringArg(args, 'reason') ?? '';
          const request = machine.requestFloor(requester, priority, reason, atMs);
          return JSON.stringify({ ok: true, request, floor: machine.currentFloor() });
        }
        const event = getStringArg(args, 'event');
        const valid = ['user-speech-start', 'user-speech-end', 'agent-speak-start', 'agent-speak-end', 'barge-in', 'duck-hard', 'duck-soft', 'yield', 'resume-held', 'pause', 'resume', 'confirm-requested', 'confirm-resolved', 'timeout', 'silence-nudge', 'reset'] as const;
        if (!(valid as readonly string[]).includes(event)) return errorResult(`Unknown event "${event}"`);
        const text = getOptionalStringArg(args, 'text');
        const transition = machine.handle(event as (typeof valid)[number], atMs, text === undefined ? undefined : { text });
        return JSON.stringify({ ok: true, ...transition, floor: machine.currentFloor() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const profileTool: Tool = {
    definition: toolDef(
      'voice_v22_profile',
      'Voice profiles (local action): list/get built-in and custom profiles, add/update/remove a custom profile, switch the current profile (parked until the reply ends when speaking), set a per-user default, or resolve a profile through its fallback chain.',
      {
        action: { type: 'string', description: 'list, get, add, update, remove, switch, user-default, resolve or stats.' },
        profileId: { type: 'string', description: 'Profile id (get / update / remove / switch / resolve).' },
        profileJson: { type: 'string', description: 'Profile as JSON (add / update).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        userId: { type: 'string', description: 'User id (user-default).' },
        locale: { type: 'string', description: 'Locale filter (list, optional).' },
        reason: { type: 'string', description: 'Switch reason (switch, optional).' },
        agentSpeaking: { type: 'string', description: '"true" when the agent is speaking (switch, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isProfileAction(action)) return errorResult(`Unknown action "${action}" (${PROFILE_ACTIONS.join(', ')})`);
        const registry = needProfiles();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'list') {
          const locale = getOptionalStringArg(args, 'locale');
          const profiles = locale === undefined ? registry.list() : registry.listByLocale(locale);
          return JSON.stringify({ ok: true, current: registry.current(), profiles });
        }
        if (action === 'stats') {
          return JSON.stringify({ ok: true, ...registry.stats(), summary: registry.summary(), current: registry.current() });
        }
        if (action === 'get') {
          const profile = registry.get(getStringArg(args, 'profileId'));
          if (profile === null) return errorResult(`No profile "${getStringArg(args, 'profileId')}".`);
          return JSON.stringify({ ok: true, profile });
        }
        if (action === 'resolve') {
          const resolved = registry.resolve(getStringArg(args, 'profileId'));
          return JSON.stringify({ ok: true, ...resolved });
        }
        if (action === 'user-default') {
          const userId = getStringArg(args, 'userId');
          const profileId = getOptionalStringArg(args, 'profileId');
          if (profileId !== undefined) {
            const errors = registry.setUserDefault(userId, profileId);
            if (errors.length > 0) return errorResult(errors.join('; '));
            return JSON.stringify({ ok: true, userId, profileId });
          }
          return JSON.stringify({ ok: true, userId, profileId: registry.userDefault(userId), profile: registry.profileForUser(userId) });
        }
        if (action === 'switch') {
          const profileId = getStringArg(args, 'profileId');
          const speaking = getOptionalBooleanArg(args, 'agentSpeaking') ?? false;
          const errors = registry.switchTo(profileId, atMs, speaking, getOptionalStringArg(args, 'reason'));
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, current: registry.current(), pending: registry.pendingSwitch() });
        }
        if (action === 'remove') {
          const errors = registry.remove(getStringArg(args, 'profileId'));
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, removed: true, profiles: registry.list() });
        }
        // add / update
        const profileRaw = parseJsonArg(getOptionalStringArg(args, 'profileJson'), 'profileJson');
        if (typeof profileRaw !== 'object' || profileRaw === null) return errorResult('profileJson must be a JSON object');
        const profileObj = profileRaw as Record<string, unknown>;
        if (action === 'add') {
          const profile = profileObj as unknown as VoiceV22Profile;
          const errors = registry.add(profile);
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, profile: registry.get(profile.id) });
        }
        const profileId = getStringArg(args, 'profileId');
        const patch: Record<string, unknown> = {};
        if (typeof profileObj.name === 'string') patch.name = profileObj.name;
        if (typeof profileObj.locale === 'string') patch.locale = profileObj.locale;
        if (typeof profileObj.engine === 'string') patch.engine = profileObj.engine;
        if (typeof profileObj.description === 'string') patch.description = profileObj.description;
        if (typeof profileObj.fallbackId === 'string') patch.fallbackId = profileObj.fallbackId;
        if (typeof profileObj.prosody === 'object' && profileObj.prosody !== null) {
          patch.prosody = clampProsodyV22(profileObj.prosody as Partial<{ rate: number; pitch: number; volume: number }>);
        }
        const errors = registry.update(profileId, patch as Partial<Omit<VoiceV22Profile, 'id' | 'builtin'>>);
        if (errors.length > 0) return errorResult(errors.join('; '));
        return JSON.stringify({ ok: true, profile: registry.get(profileId) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const recoveryTool: Tool = {
    definition: toolDef(
      'voice_v22_recovery',
      'Session recovery (local action): feed a mock heartbeat, force a disconnect, report a reconnect attempt outcome, compute the backoff delay for an attempt, or read recovery status (phase, heartbeats, RTT, attempts, degradation). No transport is dialled.',
      {
        action: { type: 'string', description: 'heartbeat, disconnect, attempt, backoff or status.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        rttMs: { type: 'number', description: 'Heartbeat round-trip time in ms (heartbeat).' },
        ok: { type: 'string', description: '"true" when the heartbeat arrived (heartbeat, optional).' },
        kind: { type: 'string', description: 'Failure kind (disconnect / attempt).' },
        message: { type: 'string', description: 'Failure message (disconnect, optional).' },
        outcome: { type: 'string', description: '"success" or "failure" (attempt).' },
        attempt: { type: 'number', description: 'Attempt number for the backoff delay (backoff).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isRecoveryAction(action)) return errorResult(`Unknown action "${action}" (${RECOVERY_ACTIONS.join(', ')})`);
        const engine = needRecovery();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'status') {
          return JSON.stringify({ ok: true, ...engine.stats(), summary: engine.summary(), nextAttemptAtMs: engine.nextAttemptAt() });
        }
        if (action === 'backoff') {
          const attempt = getOptionalNumberArg(args, 'attempt') ?? 1;
          return JSON.stringify({ ok: true, attempt, delayMs: backoffDelayV22(attempt) });
        }
        if (action === 'heartbeat') {
          const rttMs = getOptionalNumberArg(args, 'rttMs') ?? 120;
          const ok = getOptionalBooleanArg(args, 'ok') ?? true;
          const phase = engine.heartbeat({ atMs, rttMs, ok });
          return JSON.stringify({ ok: true, ...engine.stats(), phase });
        }
        if (action === 'disconnect') {
          const kind = getOptionalStringArg(args, 'kind') ?? 'transport-lost';
          const validKinds = ['transport-lost', 'heartbeat-timeout', 'checkpoint-corrupt', 'journal-gap', 'resume-token-expired', 'resume-token-unknown', 'provider-error', 'unknown'] as const;
          if (!(validKinds as readonly string[]).includes(kind)) return errorResult(`Unknown failure kind "${kind}"`);
          const failure = engine.markDisconnected(atMs, kind as (typeof validKinds)[number], getOptionalStringArg(args, 'message') ?? 'transport lost');
          return JSON.stringify({ ok: true, failure, phase: engine.phaseNow() });
        }
        // attempt
        const outcome = getOptionalStringArg(args, 'outcome') ?? 'success';
        if (outcome !== 'success' && outcome !== 'failure') return errorResult(`outcome must be "success" or "failure", got "${outcome}"`);
        const kind = getOptionalStringArg(args, 'kind');
        const phase = engine.reportAttempt(atMs, outcome, kind as Parameters<typeof engine.reportAttempt>[2]);
        return JSON.stringify({ ok: true, outcome, ...engine.stats(), phase, nextAttemptAtMs: engine.nextAttemptAt() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const monitorTool: Tool = {
    definition: toolDef(
      'voice_v22_monitor',
      'Durability monitor panel (local action): snapshot of the session (turn state, floor, profile, live transcript, durability phase + score, journal + checkpoint, last resume, recovery, queued cut replies, alerts) or its markdown rendering.',
      {
        action: { type: 'string', description: 'snapshot or markdown.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        sessionId: { type: 'string', description: 'Session id to mirror from the live session (optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isMonitorAction(action)) return errorResult(`Unknown action "${action}" (${MONITOR_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const session = needSession();
        const panel = needPanel();
        // Mirror the live session into the panel, then report it.
        panel.mirrorSession(session.stats(), atMs);
        const report = session.durabilityReport(atMs);
        panel.setDurability({
          phase: report.phase,
          journalSeq: report.journalSeq,
          lastCheckpointSeq: report.lastCheckpointSeq,
          durabilityScore: report.durabilityScore,
          disconnects: report.counters.disconnects,
          resumes: report.counters.resumes,
          recoveries: report.counters.recoveries,
          nextReconnectAtMs: report.nextReconnectAtMs,
        }, atMs);
        panel.setRecovery(session.recovery.stats(), atMs);
        if (report.lastResume !== null) panel.setLastResume(report.lastResume, atMs);
        panel.setQueuedReplies(
          session.bargeIn.queuedReplies().map((q) => ({
            id: q.id,
            turnId: q.turnId,
            remainingChars: q.cut.remainingChars,
            disposition: q.cut.disposition,
            queuedAtMs: q.queuedAtMs,
          })),
          atMs,
        );
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: panel.markdown(atMs), snapshot: panel.snapshot(atMs) });
        }
        return JSON.stringify({ ok: true, ...panel.snapshot(atMs) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [sessionTool, bargeInTool, turnTool, profileTool, recoveryTool, monitorTool];
}

/** Unbound placeholder (own default instances — mock sessions only). */
export const VOICE_V22_TOOLS: Tool[] = createVoiceV22Tools();

export const VOICE_V22_TOOL_NAMES = [
  'voice_v22_session',
  'voice_v22_barge_in',
  'voice_v22_turn',
  'voice_v22_profile',
  'voice_v22_recovery',
  'voice_v22_monitor',
] as const;

export function isVoiceV22ToolName(name: string): name is (typeof VOICE_V22_TOOL_NAMES)[number] {
  return (VOICE_V22_TOOL_NAMES as readonly string[]).includes(name);
}

/** Built-in profiles, re-exported for the tools layer. */
export { builtinProfilesV22, validateProfileV22 };
