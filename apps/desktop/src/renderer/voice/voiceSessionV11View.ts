/**
 * Voice session v11 view models (v1.12, Team T5 - voice v11 + UI).
 *
 * Renderer-local mirror of the core v11 session shapes (the
 * BudgetMeter pattern): the renderer must NOT value-import from
 * `@open-bot/core` — the core bundles are CJS and vite inlines
 * them verbatim, which throws `ReferenceError: exports is not
 * defined` at startup and leaves a blank screen. This module
 * owns the view contract instead: defensive parsing of the IPC
 * payloads (`voice-v11:*` returns plain JSON), the eight-state
 * barge-in machine (idle / listening / thinking / speaking /
 * ducked / interrupted / cooldown / closed), the VAD v11
 * probability bar, the turn-taking floor + history, the
 * streaming TTS chunk list with per-chunk progress, the
 * barge-in receipt (cut word, played vs discarded, latency)
 * and the silence-nudge banner. Pure functions, no React, no
 * DOM, no IPC — unit-tested with plain node --test (see
 * tests/voice-v112.test.mjs).
 */

/** UI status of a v11 voice session (what the panel renders). */
export type VoiceSessionV11StatusView =
  | 'idle' | 'listening' | 'thinking' | 'speaking' | 'ducked' | 'interrupted' | 'cooldown' | 'closed';

/** Turn-taking floor (who holds the floor right now). */
export type VoiceV11FloorView = 'idle' | 'user' | 'agent' | 'thinking' | 'overlap';

/** Barge-in policy names the panel shows. */
export type VoiceV11BargeInPolicyView = 'immediate' | 'grace' | 'confirm' | 'smart';

/** One row in the voice session list (as the IPC returns it). */
export interface VoiceSessionV11RowView {
  id: string;
  status: VoiceSessionV11StatusView;
  floor: VoiceV11FloorView;
  botId: string;
  language: string;
  voice: string;
  connected: boolean;
  durationMs: number;
  turns: number;
  userTurns: number;
  agentTurns: number;
  interrupts: number;
  ducks: number;
  replies: number;
  repliesCut: number;
  overlaps: number;
  level: number;
  probability: number;
}

/** VAD v11 status for the panel. */
export interface VoiceV11VadView {
  preset: string;
  calibrated: boolean;
  lowFloor: number;
  highFloor: number;
  probability: number;
  /** 0..100 bar width for the probability meter. */
  probabilityPct: number;
  /** Meter tone: the panel colours the bar by band. */
  probabilityBand: 'silent' | 'maybe' | 'speech';
  speaking: boolean;
  turns: number;
  backchannels: number;
  falseStarts: number;
  mergedPauses: number;
  maxTurns: number;
  doubleTalkFrames: number;
  humRejections: number;
  hissRejections: number;
  speechMs: number;
}

/** Barge-in v11 status for the panel. */
export interface VoiceV11BargeInView {
  policy: VoiceV11BargeInPolicyView;
  state: VoiceSessionV11StatusView;
  ducked: boolean;
  attempts: number;
  interrupts: number;
  ignoredCooldown: number;
  ignoredEcho: number;
  ignoredTooShort: number;
  ignoredLowConfidence: number;
  ducks: number;
  resumes: number;
  illegalTransitions: number;
  meanLatencyMs: number | null;
  maxLatencyMs: number | null;
  lastInterruptAtMs: number | null;
  /** Cut receipt (null when nothing was cut yet). */
  cut: VoiceV11CutReceiptView | null;
}

/** The barge-in + TTS cut receipt the panel renders. */
export interface VoiceV11CutReceiptView {
  cutWord: string;
  cutWordIndex: number;
  playedMs: number;
  discardedMs: number;
  wordsPlayed: string[];
  wordsDiscarded: string[];
  wasThinking: boolean;
  latencyMs: number | null;
  ttsChunksCancelled: number;
  ttsCharsDiscarded: number;
  ttsCutChunkText: string;
  atMs: number;
}

/** One turn row for the turn history list. */
export interface VoiceV11TurnRowView {
  id: number;
  speaker: 'user' | 'agent';
  durationMs: number;
  endedBy: string;
  yieldLikely: boolean;
  overlaps: number;
  /** Short label: "Bạn 1,2s" / "Bot 3,4s" (vi) — the caller localises. */
  label: string;
}

/** One TTS chunk row for the streaming list. */
export interface VoiceV11TtsChunkRowView {
  id: number;
  text: string;
  status: 'queued' | 'playing' | 'done' | 'cancelled';
  /** 0..1 progress through the chunk's frames. */
  progress: number;
  estDurationMs: number;
  playedMs: number;
  /** Truncated text for the row (the full text is in `text`). */
  shortText: string;
}

/** Turn-taking stats for the panel. */
export interface VoiceV11TurnTakingView {
  floor: VoiceV11FloorView;
  turns: number;
  userTurns: number;
  agentTurns: number;
  overlaps: number;
  silenceTimeouts: number;
  nudges: number;
  turnTimeouts: number;
  meanUserTurnMs: number;
  meanAgentTurnMs: number;
  meanSwitchMs: number;
  p95SwitchMs: number;
  maxSwitchMs: number;
  idleMs: number;
  currentTurnMs: number;
  yieldLikely: boolean;
}

/** TTS stream stats for the panel. */
export interface VoiceV11TtsView {
  chunks: number;
  chunksDone: number;
  chunksCancelled: number;
  chars: number;
  charsPlayed: number;
  charsDiscarded: number;
  playedMs: number;
  firstChunkLatencyMs: number | null;
  meanChunkLatencyMs: number;
  queuedChunks: number;
  playing: boolean;
  paused: boolean;
  drained: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

const V11_STATUSES: VoiceSessionV11StatusView[] = [
  'idle', 'listening', 'thinking', 'speaking', 'ducked', 'interrupted', 'cooldown', 'closed',
];

const V11_FLOORS: VoiceV11FloorView[] = ['idle', 'user', 'agent', 'thinking', 'overlap'];

/** Parse a status string defensively (unknown → 'idle'). */
export function parseVoiceV11Status(value: unknown): VoiceSessionV11StatusView {
  return typeof value === 'string' && (V11_STATUSES as string[]).includes(value)
    ? (value as VoiceSessionV11StatusView)
    : 'idle';
}

/** Parse a floor string defensively (unknown → 'idle'). */
export function parseVoiceV11Floor(value: unknown): VoiceV11FloorView {
  return typeof value === 'string' && (V11_FLOORS as string[]).includes(value)
    ? (value as VoiceV11FloorView)
    : 'idle';
}

/** Parse a barge-in policy defensively (unknown → 'smart'). */
export function parseVoiceV11BargeInPolicy(value: unknown): VoiceV11BargeInPolicyView {
  return value === 'immediate' || value === 'grace' || value === 'confirm' || value === 'smart'
    ? value
    : 'smart';
}

/** Parse a v11 session row (IPC payload → view). Never throws. */
export function parseVoiceSessionV11Row(value: unknown): VoiceSessionV11RowView {
  const r = asRecord(value);
  const stats = asRecord(r['stats']);
  return {
    id: asString(r['sessionId'] ?? r['id']),
    status: parseVoiceV11Status(r['state'] ?? stats['state']),
    floor: parseVoiceV11Floor(asRecord(stats['turnTaking'])['floor']),
    botId: asString(r['botId'], 'default'),
    language: asString(r['language'], 'en'),
    voice: asString(r['voice']),
    connected: asBoolean(r['connected'], asBoolean(r['isConnected'])),
    durationMs: Math.max(0, asNumber(r['nowMs'] ?? stats['nowMs'])),
    turns: Math.max(0, asNumber(stats['turns'])),
    userTurns: Math.max(0, asNumber(stats['userTurns'])),
    agentTurns: Math.max(0, asNumber(stats['agentTurns'])),
    interrupts: Math.max(0, asNumber(stats['interrupts'])),
    ducks: Math.max(0, asNumber(stats['ducks'])),
    replies: Math.max(0, asNumber(stats['replies'])),
    repliesCut: Math.max(0, asNumber(stats['repliesCut'])),
    overlaps: Math.max(0, asNumber(asRecord(stats['turnTaking'])['overlaps'])),
    level: Math.max(0, Math.min(1, asNumber(r['level']))),
    probability: Math.max(0, Math.min(1, asNumber(asRecord(stats['vad'])['probability']))),
  };
}

/** Build the VAD v11 view from stats (IPC payload shape). */
export function voiceV11VadView(stats: unknown, preset = 'office'): VoiceV11VadView {
  const s = asRecord(stats);
  const probability = Math.max(0, Math.min(1, asNumber(s['probability'])));
  const probabilityBand: VoiceV11VadView['probabilityBand'] =
    probability >= 0.6 ? 'speech' : probability >= 0.35 ? 'maybe' : 'silent';
  return {
    preset: asString(s['preset'], preset),
    calibrated: asBoolean(s['calibrated']),
    lowFloor: asNumber(s['lowFloor']),
    highFloor: asNumber(s['highFloor']),
    probability,
    probabilityPct: Math.round(probability * 100),
    probabilityBand,
    speaking: asBoolean(s['speaking']),
    turns: Math.max(0, asNumber(s['turns'])),
    backchannels: Math.max(0, asNumber(s['backchannels'])),
    falseStarts: Math.max(0, asNumber(s['falseStarts'])),
    mergedPauses: Math.max(0, asNumber(s['mergedPauses'])),
    maxTurns: Math.max(0, asNumber(s['maxTurns'])),
    doubleTalkFrames: Math.max(0, asNumber(s['doubleTalkFrames'])),
    humRejections: Math.max(0, asNumber(s['humRejections'])),
    hissRejections: Math.max(0, asNumber(s['hissRejections'])),
    speechMs: Math.max(0, asNumber(s['speechMs'])),
  };
}

/** Build the barge-in v11 view from stats + the last cut receipt. */
export function voiceV11BargeInView(
  stats: unknown,
  cut: unknown,
  policy: unknown = 'smart',
): VoiceV11BargeInView {
  const s = asRecord(stats);
  const c = asRecord(cut);
  const bargeIn = asRecord(c['bargeIn']);
  const tts = asRecord(c['tts']);
  const hasCut = typeof c['cutWord'] === 'string' || typeof bargeIn['cutWord'] === 'string';
  return {
    policy: parseVoiceV11BargeInPolicy(policy ?? s['policy']),
    state: parseVoiceV11Status(s['state']),
    ducked: asBoolean(s['ducked']),
    attempts: Math.max(0, asNumber(s['attempts'])),
    interrupts: Math.max(0, asNumber(s['interrupts'])),
    ignoredCooldown: Math.max(0, asNumber(s['ignoredCooldown'])),
    ignoredEcho: Math.max(0, asNumber(s['ignoredEcho'])),
    ignoredTooShort: Math.max(0, asNumber(s['ignoredTooShort'])),
    ignoredLowConfidence: Math.max(0, asNumber(s['ignoredLowConfidence'])),
    ducks: Math.max(0, asNumber(s['ducks'])),
    resumes: Math.max(0, asNumber(s['resumes'])),
    illegalTransitions: Math.max(0, asNumber(s['illegalTransitions'])),
    meanLatencyMs: typeof s['meanLatencyMs'] === 'number' ? s['meanLatencyMs'] : null,
    maxLatencyMs: typeof s['maxLatencyMs'] === 'number' ? s['maxLatencyMs'] : null,
    lastInterruptAtMs: typeof s['lastInterruptAtMs'] === 'number' ? s['lastInterruptAtMs'] : null,
    cut: !hasCut
      ? null
      : {
          cutWord: asString(bargeIn['cutWord'] ?? c['cutWord']),
          cutWordIndex: asNumber(bargeIn['cutWordIndex'] ?? c['cutWordIndex'], -1),
          playedMs: Math.max(0, asNumber(bargeIn['playedMs'] ?? c['playedMs'])),
          discardedMs: Math.max(0, asNumber(bargeIn['discardedMs'] ?? c['discardedMs'])),
          wordsPlayed: asStringArray(bargeIn['wordsPlayed'] ?? c['wordsPlayed']),
          wordsDiscarded: asStringArray(bargeIn['wordsDiscarded'] ?? c['wordsDiscarded']),
          wasThinking: asBoolean(bargeIn['wasThinking'] ?? c['wasThinking']),
          latencyMs: typeof bargeIn['latencyMs'] === 'number' ? bargeIn['latencyMs'] : null,
          ttsChunksCancelled: Math.max(0, asNumber(tts['chunksCancelled'] ?? c['ttsChunksCancelled'])),
          ttsCharsDiscarded: Math.max(0, asNumber(tts['charsDiscarded'] ?? c['ttsCharsDiscarded'])),
          ttsCutChunkText: asString(tts['cutChunkText'] ?? c['ttsCutChunkText']),
          atMs: Math.max(0, asNumber(bargeIn['atMs'] ?? c['atMs'])),
        },
  };
}

/** Build turn rows from the turn history (newest last, as stored). */
export function voiceV11TurnRows(turns: unknown): VoiceV11TurnRowView[] {
  if (!Array.isArray(turns)) return [];
  return turns.map((value) => {
    const t = asRecord(value);
    const speaker = t['speaker'] === 'agent' ? 'agent' : 'user';
    const durationMs = Math.max(0, asNumber(t['durationMs']));
    return {
      id: asNumber(t['id']),
      speaker,
      durationMs,
      endedBy: asString(t['endedBy'], 'speech-end'),
      yieldLikely: asBoolean(t['yieldLikely']),
      overlaps: Math.max(0, asNumber(t['overlaps'])),
      label: `${speaker === 'user' ? 'Bạn' : 'Bot'} ${(durationMs / 1000).toFixed(1)}s`,
    };
  });
}

/** Build TTS chunk rows (progress from played frames). */
export function voiceV11TtsChunkRows(chunks: unknown, maxTextChars = 80): VoiceV11TtsChunkRowView[] {
  if (!Array.isArray(chunks)) return [];
  return chunks.map((value) => {
    const c = asRecord(value);
    const status = c['status'] === 'playing' || c['status'] === 'done' || c['status'] === 'cancelled'
      ? c['status']
      : 'queued';
    const frames = Array.isArray(c['frames']) ? c['frames'].length : 0;
    const playedFrames = Math.max(0, asNumber(c['playedFrames']));
    const progress = frames > 0 ? Math.max(0, Math.min(1, playedFrames / frames)) : 0;
    const text = asString(c['text']);
    return {
      id: asNumber(c['id']),
      text,
      status,
      progress,
      estDurationMs: Math.max(0, asNumber(c['estDurationMs'])),
      playedMs: playedFrames * 20,
      shortText: text.length > maxTextChars ? `${text.slice(0, maxTextChars - 1)}…` : text,
    };
  });
}

/** Build the turn-taking view from stats. */
export function voiceV11TurnTakingView(stats: unknown, nowMs = 0): VoiceV11TurnTakingView {
  const s = asRecord(stats);
  return {
    floor: parseVoiceV11Floor(s['floor']),
    turns: Math.max(0, asNumber(s['turns'])),
    userTurns: Math.max(0, asNumber(s['userTurns'])),
    agentTurns: Math.max(0, asNumber(s['agentTurns'])),
    overlaps: Math.max(0, asNumber(s['overlaps'])),
    silenceTimeouts: Math.max(0, asNumber(s['silenceTimeouts'])),
    nudges: Math.max(0, asNumber(s['nudges'])),
    turnTimeouts: Math.max(0, asNumber(s['turnTimeouts'])),
    meanUserTurnMs: Math.max(0, asNumber(s['meanUserTurnMs'])),
    meanAgentTurnMs: Math.max(0, asNumber(s['meanAgentTurnMs'])),
    meanSwitchMs: Math.max(0, asNumber(s['meanSwitchMs'])),
    p95SwitchMs: Math.max(0, asNumber(s['p95SwitchMs'])),
    maxSwitchMs: Math.max(0, asNumber(s['maxSwitchMs'])),
    idleMs: Math.max(0, asNumber(s['idleMs'], nowMs)),
    currentTurnMs: Math.max(0, asNumber(s['currentTurnMs'])),
    yieldLikely: asBoolean(s['yieldLikely']),
  };
}

/** Build the TTS stream view from stats. */
export function voiceV11TtsView(stats: unknown): VoiceV11TtsView {
  const s = asRecord(stats);
  return {
    chunks: Math.max(0, asNumber(s['chunks'])),
    chunksDone: Math.max(0, asNumber(s['chunksDone'])),
    chunksCancelled: Math.max(0, asNumber(s['chunksCancelled'])),
    chars: Math.max(0, asNumber(s['chars'])),
    charsPlayed: Math.max(0, asNumber(s['charsPlayed'])),
    charsDiscarded: Math.max(0, asNumber(s['charsDiscarded'])),
    playedMs: Math.max(0, asNumber(s['playedMs'])),
    firstChunkLatencyMs: typeof s['firstChunkLatencyMs'] === 'number' ? s['firstChunkLatencyMs'] : null,
    meanChunkLatencyMs: Math.max(0, asNumber(s['meanChunkLatencyMs'])),
    queuedChunks: Math.max(0, asNumber(s['queuedChunks'])),
    playing: asBoolean(s['playing']),
    paused: asBoolean(s['paused']),
    drained: asBoolean(s['drained']),
  };
}

/** Status badge text key for the panel (the caller localises the key). */
export function voiceV11StatusKey(status: VoiceSessionV11StatusView): string {
  return `voice.v11.status.${status}`;
}

/** One-line summary lines for the diagnostics panel. */
export function voiceV11SummaryLines(row: VoiceSessionV11RowView): string[] {
  return [
    `Trạng thái: ${row.status} · lượt: ${row.turns} (bạn ${row.userTurns}, bot ${row.agentTurns})`,
    `Ngắt lời: ${row.interrupts} · giảm âm: ${row.ducks} · chồng lượt: ${row.overlaps}`,
    `Trả lời: ${row.replies} (${row.repliesCut} bị cắt) · xác suất giọng nói: ${Math.round(row.probability * 100)}%`,
  ];
}
