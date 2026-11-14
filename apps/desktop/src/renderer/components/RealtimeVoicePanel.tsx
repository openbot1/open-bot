import { useT } from '../i18n/useT';

/**
 * Realtime voice panel (v0.95, Team D3) — the live 2-way voice
 * conversation controls, rendered inside ChatView next to CallView
 * while a realtime session is available.
 *
 * Presentational: connect/disconnect, mic capture and the transcript
 * subscription live in ChatView; this panel only renders the state
 * and fires the callbacks. Provider + turn-taking mode are chosen
 * here (advanced controls behind the panel, not in the composer):
 *
 *   - provider: openai (OpenAI Realtime wire) / gemini (Gemini
 *     Live) — the bot's provider is the default.
 *   - turn mode: server_vad (default), local_vad, push_to_talk
 *     (hold the talk button).
 *
 * While the model speaks, the Interrupt button (and the server/local
 * VAD) barges in: the response is cancelled and playback flushed.
 * The barge-in counter shows how often that happened this session.
 */
export type RealtimeProviderOption = 'openai' | 'gemini' | 'openai-compatible';
export type RealtimeTurnModeOption = 'server_vad' | 'local_vad' | 'push_to_talk';
export type RealtimePanelState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'reconnecting'
  | 'closed';

/** Per-adapter health, as the main process reports it (v0.96). */
export interface RealtimeAdapterHealth {
  provider: string;
  status: 'unknown' | 'healthy' | 'degraded' | 'down';
  keyConfigured: boolean;
  connected: boolean;
  connectLatencyMs: number | null;
  firstAudioLatencyMs: number | null;
  detail?: string;
  /** True when this is the mock fallback, not a live adapter. */
  mock?: boolean;
}

/** Measured barge-in stats, as main reports them (v0.98). */
export interface RealtimeBargeInStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  lastMs: number | null;
  breaches: number;
  budgetMs: number;
}

/** One live transcript line (from the voice:transcript channel). */
export interface RealtimeTranscriptLine {
  text: string;
  isFinal: boolean;
}

/** Long-session stats from VoiceSessionV2 (v1.02). */
export interface RealtimeV2LongSessionStats {
  totalTurns: number;
  compactedTurns: number;
  compactions: number;
  hasSummary: boolean;
}

/** One media item attached to the voice call (v1.02). */
export interface RealtimeV2MediaItem {
  id: string;
  kind: 'image' | 'video';
  name?: string;
  caption?: string;
  status: 'pending' | 'described' | 'failed';
}

/** Barge-in v2 ignores, as the controller reports them (v1.02). */
export interface RealtimeV2BargeInIgnored {
  grace: number;
  tooShort: number;
}

/** Long-session v3 status, as VoiceSessionV3 reports it (v1.03). */
export interface RealtimeV3Status {
  /** Checkpoints written so far in this call. */
  checkpoints: number;
  /** Sequence of the latest checkpoint (0 when none yet). */
  lastCheckpointSeq: number;
  /** True when this call resumed from a checkpoint. */
  resumed: boolean;
  /** Reconnect attempt in progress (0 when not reconnecting). */
  reconnectAttempt: number;
  /** Max reconnect attempts per drop. */
  reconnectMax: number;
  /** Backchannels noted ("uh-huh" while the model speaks). */
  backchannels: number;
  /** Audio recordings attached to the call. */
  audioMedia: number;
  /** Video frames attached to the call. */
  videoFrames: number;
  /** Current interrupt grace window (ms). */
  graceMs: number;
  /** Local STT engines in the fallback chain, e.g. "whisper-cli → vosk". */
  sttEngines?: string;
  /** Local TTS engines in the fallback chain, e.g. "piper → system-tts". */
  ttsEngines?: string;
  /** Engine currently answering (null when none yet). */
  fallbackEngine?: string | null;
}

/** One voice profile offered in the picker (v1.04). */
export interface RealtimeV104VoiceProfileOption {
  id: string;
  name: string;
  lang: string;
  rate: number;
}

/** Full-duplex loop v2 status, as the loop reports it (v1.04). */
export interface RealtimeV104Status {
  /** Id of the active voice profile. */
  profileId: string;
  /** Display name of the active voice profile. */
  profileName: string;
  /** Speaking rate of the active profile. */
  profileRate: number;
  /** Loop state (VoiceLoopState from core). */
  loopState:
    | 'idle'
    | 'listening'
    | 'user-speaking'
    | 'processing'
    | 'model-speaking'
    | 'confirming-tool'
    | 'ended';
  /** Last measured interrupt latency (ms, null when never interrupted). */
  lastInterruptLatencyMs: number | null;
  /** Mean interrupt latency (ms, null when never interrupted). */
  avgInterruptLatencyMs: number | null;
  /** Interrupts so far this call. */
  interrupts: number;
  /** A spoken tool command is waiting for a yes/no answer. */
  toolAwaitingConfirmation: boolean;
  /** The confirmation prompt to show (when awaiting confirmation). */
  toolConfirmPrompt?: string;
  /** Voice tools executed so far this call. */
  toolExecuted: number;
  /** Voice tool requests refused so far this call. */
  toolBlocked: number;
  /** The echo guard is dropping quiet mic frames while the model speaks. */
  echoGuardOn: boolean;
  /** Current interim transcript (live, not final yet). */
  liveInterim?: string;
}

/** Latency v4 status, as VoiceSessionV4 reports it (v1.05). */
export interface RealtimeV4LatencyStage {
  stage: 'capture' | 'vad' | 'stt' | 'llm' | 'tts' | 'playback';
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** One voice turn for the v4 history (v1.05). */
export interface RealtimeV4TurnHistoryEntry {
  speaker: 'user' | 'model';
  text: string;
  interrupted: boolean;
}

/** Voice realtime v4 status, as VoiceSessionV4 reports it (v1.05). */
export interface RealtimeV4Status {
  /** Latency mode in effect. */
  latencyMode: 'balanced' | 'low-latency';
  /** Last turn latency (ms, null when no turn finished yet). */
  turnLatencyMs: number | null;
  /** End-to-end percentiles (null when no turn finished yet). */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Slowest measured stage by p95 (null when nothing measured). */
  slowestStage?: string | null;
  slowestP95Ms?: number | null;
  /** Adaptive jitter-buffer depth in use (ms). */
  jitterBufferMs: number;
  /** Barge-in v4 state machine state. */
  bargeInState: 'idle' | 'listening' | 'interrupted';
  /** Last measured TTS stop latency (ms, null when never stopped). */
  lastStopMs: number | null;
  /** TTS stop budget (ms, 50). */
  stopBudgetMs: number;
  /** Stops that missed the budget. */
  stopBreaches: number;
  /** Text of the cut reply, kept for resume (null when none). */
  partialText?: string | null;
  /** Mock mic levels 0..1 for the waveform (real levels arrive via IPC later). */
  waveform: number[];
  /** Voice turns, oldest first. */
  turnHistory: RealtimeV4TurnHistoryEntry[];
}

interface Props {
  available: boolean;
  provider: RealtimeProviderOption;
  turnMode: RealtimeTurnModeOption;
  state: RealtimePanelState;
  bargeInCount: number;
  talkHeld: boolean;
  /** Per-adapter health from main (v0.96 — null until connected). */
  adapterHealth?: RealtimeAdapterHealth | null;
  /** Measured barge-in stats from main (v0.98 — null until measured). */
  bargeInStats?: RealtimeBargeInStats | null;
  /** Live transcript lines, oldest first (v0.96 — last lines shown). */
  transcript?: RealtimeTranscriptLine[];
  /** Persisted session id (v0.96 — resumed sessions keep it). */
  sessionId?: string;
  /** Long-session stats (v1.02 — null until the first turn). */
  longSessionStats?: RealtimeV2LongSessionStats | null;
  /** Media attached to the call (v1.02 — null until attached). */
  mediaItems?: RealtimeV2MediaItem[] | null;
  /** Barge-in v2 ignores (v1.02 — null until measured). */
  bargeInV2Ignored?: RealtimeV2BargeInIgnored | null;
  /** Long-session v3 status (v1.03 — null until the first checkpoint). */
  v3Status?: RealtimeV3Status | null;
  /** Voice profiles for the picker (v1.04 — null until loaded). */
  v104Profiles?: RealtimeV104VoiceProfileOption[] | null;
  /** Full-duplex loop v2 status (v1.04 — null until the loop starts). */
  v104Status?: RealtimeV104Status | null;
  /** Voice realtime v4 status (v1.05 — null until the session starts). */
  v4Status?: RealtimeV4Status | null;
  /** Per-stage latency (v1.05 — null until measured). */
  v4Stages?: RealtimeV4LatencyStage[] | null;
  onProviderChange: (provider: RealtimeProviderOption) => void;
  onTurnModeChange: (mode: RealtimeTurnModeOption) => void;
  onStart: () => void;
  onStop: () => void;
  onInterrupt: () => void;
  onTalkHold: (held: boolean) => void;
  /** Voice profile picked (v1.04 — optional; no picker without it). */
  onProfileChange?: (id: string) => void;
  /** Spoken tool confirmation answered by tapping (v1.04). */
  onToolConfirmAnswer?: (answer: 'yes' | 'no') => void;
  /** Latency mode picked (v1.05 — optional; no switch without it). */
  onLatencyModeChange?: (mode: 'balanced' | 'low-latency') => void;
  /** Barge-in test fired (v1.05 — optional; no button without it). */
  onBargeInTest?: () => void;
  /** Resume the cut reply (v1.05 — optional; no button without it). */
  onResumePartial?: () => void;
}

export default function RealtimeVoicePanel({
  available,
  provider,
  turnMode,
  state,
  bargeInCount,
  talkHeld,
  adapterHealth,
  bargeInStats,
  transcript,
  sessionId,
  longSessionStats,
  mediaItems,
  bargeInV2Ignored,
  v3Status,
  v104Profiles,
  v104Status,
  v4Status,
  v4Stages,
  onProviderChange,
  onTurnModeChange,
  onStart,
  onStop,
  onInterrupt,
  onTalkHold,
  onProfileChange,
  onToolConfirmAnswer,
  onLatencyModeChange,
  onBargeInTest,
  onResumePartial,
}: Props) {
  const t = useT();
  const active = state === 'listening' || state === 'speaking' || state === 'interrupted';
  const connecting = state === 'connecting' || state === 'reconnecting';

  // v1.04 loop state in the panel's own words (the loop has no
  // 'interrupted' state — an interrupt is a transient event, so the
  // panel shows the last latency instead of a state for it).
  const v104LoopStateText = v104Status
    ? v104Status.loopState === 'user-speaking'
      ? t('voice.v104.userSpeaking')
      : v104Status.loopState === 'model-speaking' || v104Status.loopState === 'processing'
        ? t('voice.v104.modelSpeaking')
        : v104Status.loopState === 'confirming-tool'
          ? t('voice.v104.toolConfirm')
          : t('voice.v104.listening')
    : null;

  const stateText =
    state === 'connecting'
      ? t('voice.realtime.stateConnecting')
      : state === 'listening'
        ? t('voice.realtime.stateListening')
        : state === 'speaking'
          ? t('voice.realtime.stateSpeaking')
          : state === 'interrupted'
            ? t('voice.realtime.stateInterrupted')
            : state === 'reconnecting'
              ? t('voice.realtime.stateReconnecting')
              : state === 'closed'
                ? t('voice.realtime.stateClosed')
                : t('voice.realtime.stateIdle');

  const healthText = adapterHealth
    ? adapterHealth.status === 'healthy'
      ? t('voice.realtime.live.healthHealthy')
      : adapterHealth.status === 'degraded'
        ? t('voice.realtime.live.healthDegraded')
        : adapterHealth.status === 'down'
          ? t('voice.realtime.live.healthDown')
          : t('voice.realtime.live.healthUnknown')
    : null;
  const latencyText =
    adapterHealth?.connectLatencyMs !== null && adapterHealth?.connectLatencyMs !== undefined
      ? t('voice.realtime.live.latency', {
          connect: String(adapterHealth.connectLatencyMs),
          firstAudio:
            adapterHealth.firstAudioLatencyMs === null ||
            adapterHealth.firstAudioLatencyMs === undefined
              ? '—'
              : String(adapterHealth.firstAudioLatencyMs),
        })
      : t('voice.realtime.live.latencyUnknown');
  const liveLines = (transcript ?? []).slice(-6);

  return (
    <section
      className="card realtime-voice-panel"
      data-testid="realtime-voice-panel"
      aria-label={t('voice.realtime.title')}
    >
      <div className="row">
        <strong>{t('voice.realtime.title')}</strong>
        <span className="status" data-testid="realtime-state">
          {stateText}
        </span>
      </div>
      <div className="row">
        <label>
          {t('voice.realtime.provider')}{' '}
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as RealtimeProviderOption)}
            aria-label={t('voice.realtime.provider')}
            disabled={active || connecting}
            data-testid="realtime-provider"
          >
            <option value="openai">{t('voice.realtime.providerOpenai')}</option>
            <option value="gemini">{t('voice.realtime.providerGemini')}</option>
            <option value="openai-compatible">{t('voice.realtime.providerOpenaiCompatible')}</option>
          </select>
        </label>
        <label>
          {t('voice.realtime.turnMode')}{' '}
          <select
            value={turnMode}
            onChange={(e) => onTurnModeChange(e.target.value as RealtimeTurnModeOption)}
            aria-label={t('voice.realtime.turnMode')}
            data-testid="realtime-turn-mode"
          >
            <option value="server_vad">{t('voice.realtime.turnServerVad')}</option>
            <option value="local_vad">{t('voice.realtime.turnLocalVad')}</option>
            <option value="push_to_talk">{t('voice.realtime.turnPushToTalk')}</option>
          </select>
        </label>
      </div>
      <div className="row">
        {!active && !connecting && (
          <button
            className="btn"
            data-testid="realtime-start"
            onClick={onStart}
            disabled={!available}
          >
            {t('voice.realtime.start')}
          </button>
        )}
        {(active || connecting) && (
          <button className="btn" data-testid="realtime-stop" onClick={onStop}>
            {t('voice.realtime.stop')}
          </button>
        )}
        {state === 'speaking' && (
          <button className="btn" data-testid="realtime-interrupt" onClick={onInterrupt}>
            {t('voice.realtime.interrupt')}
          </button>
        )}
        {turnMode === 'push_to_talk' && active && (
          <button
            className="btn"
            data-testid="realtime-talk"
            onMouseDown={() => onTalkHold(true)}
            onMouseUp={() => onTalkHold(false)}
            onMouseLeave={() => {
              if (talkHeld) onTalkHold(false);
            }}
            onTouchStart={() => onTalkHold(true)}
            onTouchEnd={() => onTalkHold(false)}
          >
            {talkHeld ? t('voice.realtime.talking') : t('voice.realtime.holdToTalk')}
          </button>
        )}
      </div>
      {bargeInCount > 0 && (
        <p className="hint" data-testid="realtime-bargeins">
          {t('voice.realtime.bargeIns', { count: String(bargeInCount) })}
        </p>
      )}
      {/* v0.98 (Team T5 — voice live): measured barge-in stats
          (mean / p95 / last against the 500 ms budget). */}
      {bargeInStats && bargeInStats.count > 0 && (
        <p className="hint" data-testid="realtime-bargein-stats">
          {t('voice.realtime.live.bargeInStats', {
            count: String(bargeInStats.count),
            mean: String(bargeInStats.meanMs),
            p95: String(bargeInStats.p95Ms),
            last: bargeInStats.lastMs === null ? '—' : String(bargeInStats.lastMs),
            budget: String(bargeInStats.budgetMs),
          })}
          {bargeInStats.breaches > 0 && (
            <>
              {' '}
              {t('voice.realtime.live.bargeInBreaches', {
                breaches: String(bargeInStats.breaches),
              })}
            </>
          )}
        </p>
      )}
      {/* v0.96 (Team T5 — voice live): per-adapter health + latency. */}
      {adapterHealth && (
        <div data-testid="realtime-adapter-health">
          {adapterHealth.mock && (
            <p className="hint" data-testid="realtime-mock-mode">
              {t('voice.realtime.live.mockMode')}
            </p>
          )}
          <p className="hint">
            {t('voice.realtime.live.adapterStatus', {
              provider: adapterHealth.provider,
              status: healthText ?? '',
            })}{' '}
            —{' '}
            {adapterHealth.keyConfigured
              ? t('voice.realtime.live.keyConfigured')
              : t('voice.realtime.live.keyMissing')}
          </p>
          <p className="hint" data-testid="realtime-latency">
            {latencyText}
          </p>
          {adapterHealth.detail && adapterHealth.status !== 'healthy' && (
            <p className="hint">{adapterHealth.detail}</p>
          )}
        </div>
      )}
      {/* v0.96 (Team T5 — voice live): live transcript in the panel. */}
      <div data-testid="realtime-transcript">
        <p className="hint">
          <strong>{t('voice.realtime.live.transcriptTitle')}</strong>
        </p>
        {liveLines.length === 0 ? (
          <p className="hint">{t('voice.realtime.live.transcriptEmpty')}</p>
        ) : (
          <ul>
            {liveLines.map((line, i) => (
              <li key={`${i}-${line.text.slice(0, 24)}`}>
                {line.text}
                {!line.isFinal && ` ${t('voice.realtime.live.transcriptInterim')}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {sessionId && (
        <p className="hint" data-testid="realtime-session-id">
          {t('voice.realtime.live.sessionResumed', { id: sessionId })}
        </p>
      )}
      {/* v1.02 (Team T5 — voice v2): long-session stats, attached
          media, and barge-in v2 ignores. Shown only when the caller
          passes v2 data — older callers see the panel unchanged. */}
      {(longSessionStats || mediaItems || bargeInV2Ignored) && (
        <div data-testid="realtime-v2">
          <p className="hint">
            <strong>{t('voice.v2.title')}</strong>
          </p>
          {longSessionStats && (
            <p className="hint" data-testid="realtime-v2-long-session">
              {t('voice.v2.longSession', {
                turns: String(longSessionStats.totalTurns),
                compacted: String(longSessionStats.compactedTurns),
                summaries: String(longSessionStats.compactions),
              })}
            </p>
          )}
          {mediaItems && (
            <div data-testid="realtime-v2-media">
              <p className="hint">{t('voice.v2.mediaTitle')}</p>
              {mediaItems.length === 0 ? (
                <p className="hint">{t('voice.v2.mediaEmpty')}</p>
              ) : (
                <ul>
                  {mediaItems.map((item) => (
                    <li key={item.id}>
                      {item.kind} {item.caption?.trim() || item.name?.trim() || item.id} —{' '}
                      {item.status === 'described'
                        ? t('voice.v2.mediaDescribed')
                        : item.status === 'failed'
                          ? t('voice.v2.mediaFailed')
                          : t('voice.v2.mediaPending')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {bargeInV2Ignored && (bargeInV2Ignored.grace > 0 || bargeInV2Ignored.tooShort > 0) && (
            <p className="hint" data-testid="realtime-v2-bargein">
              {t('voice.v2.bargeInIgnored', {
                grace: String(bargeInV2Ignored.grace),
                short: String(bargeInV2Ignored.tooShort),
              })}
            </p>
          )}
        </div>
      )}
      {/* v1.03 (Team T5 — voice v3): checkpoints, resume, backchannels,
          audio media, video frames, and the local engine chain. Shown
          only when the caller passes v3 data — older callers see the
          panel unchanged. */}
      {v3Status && (
        <div data-testid="realtime-v3">
          <p className="hint">
            <strong>{t('voice.realtime.v3.title')}</strong>
          </p>
          {v3Status.checkpoints > 0 ? (
            <p className="hint" data-testid="realtime-v3-checkpoints">
              {t('voice.realtime.v3.checkpoints', {
                count: String(v3Status.checkpoints),
                seq: String(v3Status.lastCheckpointSeq),
              })}
            </p>
          ) : (
            <p className="hint" data-testid="realtime-v3-checkpoints">
              {t('voice.realtime.v3.noCheckpoint')}
            </p>
          )}
          {v3Status.resumed && (
            <p className="hint" data-testid="realtime-v3-resumed">
              {t('voice.realtime.v3.resumed', { seq: String(v3Status.lastCheckpointSeq) })}
            </p>
          )}
          {v3Status.reconnectAttempt > 0 && (
            <p className="hint" data-testid="realtime-v3-reconnecting">
              {t('voice.realtime.v3.reconnecting', {
                attempt: String(v3Status.reconnectAttempt),
                max: String(v3Status.reconnectMax),
              })}
            </p>
          )}
          {v3Status.backchannels > 0 && (
            <p className="hint" data-testid="realtime-v3-backchannels">
              {t('voice.realtime.v3.backchannels', { count: String(v3Status.backchannels) })}
            </p>
          )}
          {v3Status.audioMedia > 0 && (
            <p className="hint" data-testid="realtime-v3-audio">
              {t('voice.realtime.v3.audioMedia', { count: String(v3Status.audioMedia) })}
            </p>
          )}
          {v3Status.videoFrames > 0 && (
            <p className="hint" data-testid="realtime-v3-frames">
              {t('voice.realtime.v3.mediaFrames', { count: String(v3Status.videoFrames) })}
            </p>
          )}
          <p className="hint" data-testid="realtime-v3-grace">
            {t('voice.realtime.v3.graceAdapted', { ms: String(v3Status.graceMs) })}
          </p>
          {(v3Status.sttEngines || v3Status.ttsEngines) && (
            <p className="hint" data-testid="realtime-v3-engines">
              {t('voice.realtime.v3.engines', {
                stt: v3Status.sttEngines ?? '—',
                tts: v3Status.ttsEngines ?? '—',
              })}
            </p>
          )}
          {v3Status.fallbackEngine && (
            <p className="hint" data-testid="realtime-v3-fallback">
              {t('voice.realtime.v3.fallbackUsed', { engine: v3Status.fallbackEngine })}
            </p>
          )}
        </div>
      )}
      {/* v1.04 (Team T5 — voice realtime v3, part 2): voice profiles,
          full-duplex loop state, interrupt latency, spoken tool
          confirmations, and the live interim line. Shown only when
          the caller passes v104 data — older callers see the panel
          unchanged. */}
      {v104Status && (
        <div data-testid="realtime-v104">
          <p className="hint">
            <strong>{t('voice.v104.title')}</strong>
          </p>
          {v104Profiles && v104Profiles.length > 0 && onProfileChange && (
            <label>
              {t('voice.v104.profiles')}{' '}
              <select
                value={v104Status.profileId}
                onChange={(e) => onProfileChange(e.target.value)}
                aria-label={t('voice.v104.profiles')}
                data-testid="realtime-v104-profile"
              >
                {v104Profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.lang}, {profile.rate}x)
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="hint" data-testid="realtime-v104-profile-active">
            {t('voice.v104.profileActive', { name: v104Status.profileName })}
          </p>
          <p className="hint" data-testid="realtime-v104-state">
            {v104LoopStateText}
          </p>
          {v104Status.lastInterruptLatencyMs !== null && (
            <p className="hint" data-testid="realtime-v104-interrupted">
              {t('voice.v104.interrupted', { ms: String(v104Status.lastInterruptLatencyMs) })}
            </p>
          )}
          {v104Status.liveInterim && (
            <p className="hint" data-testid="realtime-v104-interim">
              {v104Status.liveInterim}…
            </p>
          )}
          {v104Status.toolAwaitingConfirmation && v104Status.toolConfirmPrompt && (
            <div data-testid="realtime-v104-confirm">
              <p className="hint">{t('voice.v104.toolConfirm')}</p>
              <p className="hint">{v104Status.toolConfirmPrompt}</p>
              <button
                className="btn"
                data-testid="realtime-v104-confirm-yes"
                onClick={() => onToolConfirmAnswer?.('yes')}
              >
                {t('voice.v104.confirmYes')}
              </button>{' '}
              <button
                className="btn"
                data-testid="realtime-v104-confirm-no"
                onClick={() => onToolConfirmAnswer?.('no')}
              >
                {t('voice.v104.confirmNo')}
              </button>
            </div>
          )}
          {v104Status.toolBlocked > 0 && (
            <p className="hint" data-testid="realtime-v104-blocked">
              {t('voice.v104.toolBlocked')}
            </p>
          )}
          {v104Status.echoGuardOn && (
            <p className="hint" data-testid="realtime-v104-echo">
              {t('voice.v104.echoGuard')}
            </p>
          )}
        </div>
      )}
      {/* v1.05 (Team T5 — voice realtime v4): per-stage latency,
          latency mode switch, barge-in v4 state + test button,
          realtime waveform (mock levels until IPC feeds real
          ones), and voice turn history. Shown only when the
          caller passes v4 data — older callers see the panel
          unchanged. */}
      {v4Status && (
        <div data-testid="realtime-v4">
          <p className="hint">
            <strong>{t('voice.realtime.v4.title')}</strong>
          </p>
          {onLatencyModeChange && (
            <label>
              {t('voice.realtime.v4.latencyMode')}{' '}
              <select
                value={v4Status.latencyMode}
                onChange={(e) =>
                  onLatencyModeChange(e.target.value as 'balanced' | 'low-latency')
                }
                aria-label={t('voice.realtime.v4.latencyMode')}
                data-testid="realtime-v4-latency-mode"
              >
                <option value="balanced">{t('voice.realtime.v4.modeBalanced')}</option>
                <option value="low-latency">{t('voice.realtime.v4.modeLowLatency')}</option>
              </select>
            </label>
          )}
          {v4Status.turnLatencyMs !== null ? (
            <p className="hint" data-testid="realtime-v4-turn-latency">
              {t('voice.realtime.v4.turnLatency', {
                ms: String(v4Status.turnLatencyMs),
                p50: v4Status.p50Ms === null ? '—' : String(v4Status.p50Ms),
                p95: v4Status.p95Ms === null ? '—' : String(v4Status.p95Ms),
                p99: v4Status.p99Ms === null ? '—' : String(v4Status.p99Ms),
              })}
            </p>
          ) : (
            <p className="hint" data-testid="realtime-v4-turn-latency">
              {t('voice.realtime.v4.stageNotMeasured')}
            </p>
          )}
          {v4Status.slowestStage && v4Status.slowestP95Ms !== null && v4Status.slowestP95Ms !== undefined && (
            <p className="hint" data-testid="realtime-v4-slowest">
              {t('voice.realtime.v4.slowestStage', {
                stage: v4Status.slowestStage,
                p95: String(v4Status.slowestP95Ms),
              })}
            </p>
          )}
          <p className="hint" data-testid="realtime-v4-jitter">
            {t('voice.realtime.v4.jitterBuffer', { ms: String(v4Status.jitterBufferMs) })}
          </p>
          {v4Stages && v4Stages.length > 0 && (
            <ul data-testid="realtime-v4-stages">
              {v4Stages.map((stage) => (
                <li key={stage.stage}>
                  {stage.stage}:{' '}
                  {stage.p95Ms === null
                    ? t('voice.realtime.v4.stageNotMeasured')
                    : `p50 ${stage.p50Ms}ms · p95 ${stage.p95Ms}ms · p99 ${stage.p99Ms}ms`}
                </li>
              ))}
            </ul>
          )}
          <p className="hint" data-testid="realtime-v4-bargein-state">
            {t('voice.realtime.v4.bargeInState', { state: v4Status.bargeInState })}
          </p>
          {v4Status.lastStopMs !== null && (
            <p className="hint" data-testid="realtime-v4-bargein-stop">
              {t('voice.realtime.v4.bargeInStop', {
                ms: String(v4Status.lastStopMs),
                budget: String(v4Status.stopBudgetMs),
              })}
              {v4Status.stopBreaches > 0 && (
                <>
                  {' '}
                  {t('voice.realtime.v4.bargeInBreaches', {
                    count: String(v4Status.stopBreaches),
                  })}
                </>
              )}
            </p>
          )}
          {onBargeInTest && (
            <button
              className="btn"
              data-testid="realtime-v4-bargein-test"
              onClick={onBargeInTest}
            >
              {t('voice.realtime.v4.bargeInTest')}
            </button>
          )}
          {v4Status.partialText && onResumePartial && (
            <button
              className="btn"
              data-testid="realtime-v4-resume-partial"
              onClick={onResumePartial}
            >
              {t('voice.realtime.v4.partialResume')}
            </button>
          )}
          <div data-testid="realtime-v4-waveform" aria-label={t('voice.realtime.v4.waveform')}>
            {v4Status.waveform.map((level, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  width: 4,
                  height: Math.max(2, Math.round(level * 24)),
                  marginRight: 2,
                  verticalAlign: 'bottom',
                  background: 'currentColor',
                  opacity: 0.6,
                }}
              />
            ))}
          </div>
          <div data-testid="realtime-v4-turn-history">
            <p className="hint">
              <strong>{t('voice.realtime.v4.turnHistory')}</strong>
            </p>
            {v4Status.turnHistory.length === 0 ? (
              <p className="hint">{t('voice.realtime.v4.turnHistoryEmpty')}</p>
            ) : (
              <ul>
                {v4Status.turnHistory.slice(-6).map((turn, i) => (
                  <li key={`${i}-${turn.text.slice(0, 24)}`}>
                    {turn.speaker === 'user' ? 'You' : 'Bot'}: {turn.text}
                    {turn.interrupted && ` (${t('voice.realtime.v4.interruptedTurn')})`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {!available && <p className="hint">{t('voice.realtime.notAvailable')}</p>}
      <p className="hint">{t('voice.realtime.hint')}</p>
    </section>
  );
}
