/**
 * Voice budget meters (v1.20, Đội T5 — voice v18).
 *
 * Voice costs real money (or real minutes) on every provider, but
 * nothing in v15–v17 ever counted it: a long session could burn a
 * whole day's allowance before anyone noticed, and the only answer
 * was a hard stop. v18 counts first and degrades gracefully:
 *
 *   1. Meters. Three meters, per session and per day: voice
 *      minutes (spoken audio, STT + TTS), TTS tokens and STT
 *      tokens. TTS tokens are estimated from text (`chars / 4`,
 *      the usual rough ratio); STT tokens from audio seconds
 *      (`seconds × 10`); TTS audio seconds from text length at
 *      the profile rate (`chars / 15 / rate`). All three are
 *      *estimates* — providers bill differently — and the constants
 *      are exported so a host can recalibrate them; the meter
 *      never claims to be a bill.
 *   2. Thresholds. Each meter has a budget (0 = unlimited) and
 *      two thresholds: `warnAt` (default 0.8) and `criticalAt`
 *      (default 0.95). Crossing a threshold fires an event once
 *      per meter per day, so the panel can warn without spam.
 *   3. Auto-degrade. `qualityFor()` maps a requested TTS quality
 *      to the quality the budget allows: `warn` drops `high` to
 *      `standard`, `critical` drops everything to `fast`, and
 *      `exceeded` blocks new TTS outright (the reply is still
 *      delivered as text). The caller gets the reason, so the UI
 *      can say "giọng đã hạ xuống nhanh để tiết kiệm budget".
 *   4. Day rollover. Day totals reset when the local date key
 *      changes; sessions keep their own totals and a short
 *      history of finished sessions.
 *   5. Persistence. `toJSON()` / `fromJSON()` round-trip the day
 *      totals, the session history and the budgets (version 1,
 *      invalid entries dropped, never fatal).
 *
 * Mock-first, no provider, no key: the host records usage from its
 * real STT/TTS calls, or from the mock synth in tests.
 */

import {
  downgradeQualityV18,
  type TtsV18Quality,
} from './ttsStreamV18';

/** Rough estimation ratios (providers bill differently). */
export const VOICE_BUDGET_V18_TTS_CHARS_PER_TOKEN = 4;
export const VOICE_BUDGET_V18_STT_TOKENS_PER_SECOND = 10;
export const VOICE_BUDGET_V18_TTS_CHARS_PER_SECOND = 15;

export type VoiceBudgetV18MeterId = 'voiceMinutes' | 'ttsTokens' | 'sttTokens';

export type VoiceBudgetV18Level = 'ok' | 'warn' | 'critical' | 'exceeded';

export const VOICE_BUDGET_V18_METERS: readonly VoiceBudgetV18MeterId[] = [
  'voiceMinutes',
  'ttsTokens',
  'sttTokens',
];

export interface VoiceBudgetV18Budgets {
  /** Max voice minutes per day (0 = unlimited). */
  dailyVoiceMinutes?: number;
  /** Max TTS tokens per day (0 = unlimited). */
  dailyTtsTokens?: number;
  /** Max STT tokens per day (0 = unlimited). */
  dailySttTokens?: number;
  /** Max voice minutes per session (0 = unlimited). */
  sessionVoiceMinutes?: number;
}

export interface VoiceBudgetV18Options extends VoiceBudgetV18Budgets {
  /** Fraction of budget that warns (default 0.8). */
  warnAt?: number;
  /** Fraction of budget that is critical (default 0.95). */
  criticalAt?: number;
  /** Finished sessions kept in history (default 20). */
  maxSessionHistory?: number;
}

export function defaultVoiceBudgetV18Options(): Required<Omit<VoiceBudgetV18Options, 'dailyVoiceMinutes' | 'dailyTtsTokens' | 'dailySttTokens' | 'sessionVoiceMinutes'>> & VoiceBudgetV18Budgets {
  return {
    dailyVoiceMinutes: 0,
    dailyTtsTokens: 0,
    dailySttTokens: 0,
    sessionVoiceMinutes: 0,
    warnAt: 0.8,
    criticalAt: 0.95,
    maxSessionHistory: 20,
  };
}

export function validateVoiceBudgetV18Options(options: VoiceBudgetV18Options): string[] {
  const errors: string[] = [];
  const checkBudget = (name: keyof VoiceBudgetV18Budgets, value: number | undefined): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100000000)) {
      errors.push(`${name} must be 0..100000000`);
    }
  };
  checkBudget('dailyVoiceMinutes', options.dailyVoiceMinutes);
  checkBudget('dailyTtsTokens', options.dailyTtsTokens);
  checkBudget('dailySttTokens', options.dailySttTokens);
  checkBudget('sessionVoiceMinutes', options.sessionVoiceMinutes);
  if (options.warnAt !== undefined && (!Number.isFinite(options.warnAt) || options.warnAt <= 0 || options.warnAt >= 1)) {
    errors.push('warnAt must be 0..1 (exclusive)');
  }
  if (options.criticalAt !== undefined && (!Number.isFinite(options.criticalAt) || options.criticalAt <= 0 || options.criticalAt >= 1)) {
    errors.push('criticalAt must be 0..1 (exclusive)');
  }
  if (
    options.warnAt !== undefined && options.criticalAt !== undefined &&
    options.warnAt >= options.criticalAt
  ) {
    errors.push('warnAt must be below criticalAt');
  }
  if (options.maxSessionHistory !== undefined && (!Number.isInteger(options.maxSessionHistory) || options.maxSessionHistory < 1 || options.maxSessionHistory > 200)) {
    errors.push('maxSessionHistory must be 1..200');
  }
  return errors;
}

/** Pure estimate: TTS tokens for a text. */
export function estimateTtsTokensV18(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / VOICE_BUDGET_V18_TTS_CHARS_PER_TOKEN);
}

/** Pure estimate: STT tokens for audio seconds. */
export function estimateSttTokensV18(audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return 0;
  return Math.ceil(audioSeconds * VOICE_BUDGET_V18_STT_TOKENS_PER_SECOND);
}

/** Pure estimate: spoken seconds for TTS text at a playback rate. */
export function estimateTtsSecondsV18(chars: number, rate = 1): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return chars / VOICE_BUDGET_V18_TTS_CHARS_PER_SECOND / safeRate;
}

export interface VoiceBudgetV18MeterState {
  meter: VoiceBudgetV18MeterId;
  used: number;
  budget: number;
  /** Fraction used (Infinity when budget is 0/unlimited is reported as 0). */
  fraction: number;
  level: VoiceBudgetV18Level;
  remaining: number;
}

export type VoiceBudgetV18EventKind = 'threshold' | 'degraded' | 'blocked' | 'session-end' | 'day-rollover';

export interface VoiceBudgetV18Event {
  kind: VoiceBudgetV18EventKind;
  atMs: number;
  meter?: VoiceBudgetV18MeterId;
  level?: VoiceBudgetV18Level;
  used?: number;
  budget?: number;
  sessionId?: string;
  reason?: string;
}

export type VoiceBudgetV18EventSink = (event: VoiceBudgetV18Event) => void;

export interface VoiceBudgetV18SessionRecord {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number | undefined;
  voiceSeconds: number;
  ttsTokens: number;
  sttTokens: number;
  sttSeconds: number;
  ttsChars: number;
  degradedTurns: number;
  blockedTurns: number;
}

export interface VoiceBudgetV18Stats {
  dayKey: string;
  sessionId: string | undefined;
  session: VoiceBudgetV18SessionRecord | undefined;
  dayVoiceSeconds: number;
  dayVoiceMinutes: number;
  dayTtsTokens: number;
  daySttTokens: number;
  meters: VoiceBudgetV18MeterState[];
  level: VoiceBudgetV18Level;
  degradedTurns: number;
  blockedTurns: number;
  sessionsToday: number;
}

export function voiceBudgetDayKeyV18(atMs: number): string {
  const d = new Date(atMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Budget meter: record STT/TTS usage, watch the thresholds, and
 * tell the caller which TTS quality the budget still allows.
 * All times are the caller's virtual clock (ms).
 */
export class VoiceBudgetMeterV18 {
  private readonly options: Required<VoiceBudgetV18Options>;
  private readonly sink: VoiceBudgetV18EventSink | undefined;
  private dayKey: string;
  private dayVoiceSeconds = 0;
  private dayTtsTokens = 0;
  private daySttTokens = 0;
  private session: VoiceBudgetV18SessionRecord | undefined;
  private readonly sessionHistoryRecords: VoiceBudgetV18SessionRecord[] = [];
  private readonly firedLevels = new Map<VoiceBudgetV18MeterId, VoiceBudgetV18Level>();
  private degradedTurns = 0;
  private blockedTurns = 0;

  constructor(options: VoiceBudgetV18Options = {}, sink?: VoiceBudgetV18EventSink, atMs = 0) {
    const merged = { ...defaultVoiceBudgetV18Options(), ...options };
    const errors = validateVoiceBudgetV18Options(merged);
    if (errors.length > 0) throw new Error(`invalid voice budget v18 options: ${errors.join('; ')}`);
    this.options = merged as Required<VoiceBudgetV18Options>;
    this.sink = sink;
    this.dayKey = voiceBudgetDayKeyV18(atMs);
  }

  day(): string {
    return this.dayKey;
  }

  sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  startSession(sessionId: string, atMs: number): void {
    this.rolloverIfNeeded(atMs);
    if (this.session) this.endSession(atMs);
    this.session = {
      sessionId,
      startedAtMs: atMs,
      endedAtMs: undefined,
      voiceSeconds: 0,
      ttsTokens: 0,
      sttTokens: 0,
      sttSeconds: 0,
      ttsChars: 0,
      degradedTurns: 0,
      blockedTurns: 0,
    };
  }

  endSession(atMs: number): VoiceBudgetV18SessionRecord | undefined {
    if (!this.session) return undefined;
    this.session.endedAtMs = atMs;
    const done = { ...this.session };
    this.sessionHistoryRecords.push(done);
    while (this.sessionHistoryRecords.length > this.options.maxSessionHistory) this.sessionHistoryRecords.shift();
    this.session = undefined;
    this.sink?.({ kind: 'session-end', atMs, sessionId: done.sessionId, reason: `${done.voiceSeconds.toFixed(1)}s voice, ${done.ttsTokens} TTS tokens, ${done.sttTokens} STT tokens` });
    return done;
  }

  sessionHistory(): VoiceBudgetV18SessionRecord[] {
    return this.sessionHistoryRecords.map((s) => ({ ...s }));
  }

  /** Record recognised speech: audio seconds + estimated STT tokens. */
  recordStt(audioSeconds: number, atMs: number): void {
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return;
    this.rolloverIfNeeded(atMs);
    const tokens = estimateSttTokensV18(audioSeconds);
    this.dayVoiceSeconds += audioSeconds;
    this.daySttTokens += tokens;
    if (this.session) {
      this.session.voiceSeconds += audioSeconds;
      this.session.sttSeconds += audioSeconds;
      this.session.sttTokens += tokens;
    }
    this.checkThresholds(atMs);
  }

  /** Record synthesised speech: text chars + rate → tokens + audio seconds. */
  recordTts(chars: number, rate: number, atMs: number): void {
    if (!Number.isFinite(chars) || chars <= 0) return;
    this.rolloverIfNeeded(atMs);
    const tokens = estimateTtsTokensV18(chars);
    const seconds = estimateTtsSecondsV18(chars, rate);
    this.dayVoiceSeconds += seconds;
    this.dayTtsTokens += tokens;
    if (this.session) {
      this.session.voiceSeconds += seconds;
      this.session.ttsChars += chars;
      this.session.ttsTokens += tokens;
    }
    this.checkThresholds(atMs);
  }

  /** Record raw voice seconds (e.g. a live duplex stream) without a token split. */
  recordVoiceSeconds(seconds: number, atMs: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.rolloverIfNeeded(atMs);
    this.dayVoiceSeconds += seconds;
    if (this.session) this.session.voiceSeconds += seconds;
    this.checkThresholds(atMs);
  }

  level(): VoiceBudgetV18Level {
    let worst: VoiceBudgetV18Level = 'ok';
    for (const m of this.meters()) {
      if (m.level === 'exceeded') return 'exceeded';
      if (m.level === 'critical') worst = 'critical';
      else if (m.level === 'warn' && worst === 'ok') worst = 'warn';
    }
    return worst;
  }

  meters(): VoiceBudgetV18MeterState[] {
    const dayMinutes = this.dayVoiceSeconds / 60;
    const sessionMinutes = this.session ? this.session.voiceSeconds / 60 : 0;
    const minuteBudget = this.options.dailyVoiceMinutes > 0 ? this.options.dailyVoiceMinutes : 0;
    const sessionBudget = this.options.sessionVoiceMinutes > 0 ? this.options.sessionVoiceMinutes : 0;
    // The voice-minutes meter is the tighter of the day and session budgets.
    let minuteUsed = dayMinutes;
    let minuteLimit = minuteBudget;
    if (sessionBudget > 0 && (minuteLimit === 0 || sessionMinutes / sessionBudget > dayMinutes / Math.max(minuteLimit, 1))) {
      minuteUsed = sessionMinutes;
      minuteLimit = sessionBudget;
    }
    return [
      this.meterState('voiceMinutes', minuteUsed, minuteLimit),
      this.meterState('ttsTokens', this.dayTtsTokens, this.options.dailyTtsTokens),
      this.meterState('sttTokens', this.daySttTokens, this.options.dailySttTokens),
    ];
  }

  meter(meter: VoiceBudgetV18MeterId): VoiceBudgetV18MeterState {
    return this.meters().find((m) => m.meter === meter) as VoiceBudgetV18MeterState;
  }

  /**
   * Which TTS quality the budget still allows. Returns the quality
   * to use, whether it was degraded, and whether TTS is blocked.
   * A degraded or blocked turn is counted for the stats.
   */
  qualityFor(requested: TtsV18Quality, atMs: number): { quality: TtsV18Quality; degraded: boolean; blocked: boolean; reason: string } {
    this.rolloverIfNeeded(atMs);
    const level = this.level();
    if (level === 'exceeded') {
      this.blockedTurns += 1;
      if (this.session) this.session.blockedTurns += 1;
      this.sink?.({ kind: 'blocked', atMs, level, reason: 'voice budget exceeded — TTS blocked, reply as text' });
      return { quality: 'fast', degraded: true, blocked: true, reason: 'budget exceeded' };
    }
    if (level === 'critical') {
      const quality = 'fast';
      const degraded = quality !== requested;
      if (degraded) this.noteDegraded(atMs, 'critical budget — TTS quality lowered to fast');
      return { quality, degraded, blocked: false, reason: degraded ? 'critical budget' : 'critical budget (already fast)' };
    }
    if (level === 'warn' && requested === 'high') {
      const quality = downgradeQualityV18(requested);
      this.noteDegraded(atMs, 'budget warning — TTS quality lowered to standard');
      return { quality, degraded: true, blocked: false, reason: 'budget warning' };
    }
    return { quality: requested, degraded: false, blocked: false, reason: 'within budget' };
  }

  stats(): VoiceBudgetV18Stats {
    return {
      dayKey: this.dayKey,
      sessionId: this.session?.sessionId,
      session: this.session ? { ...this.session } : undefined,
      dayVoiceSeconds: this.dayVoiceSeconds,
      dayVoiceMinutes: this.dayVoiceSeconds / 60,
      dayTtsTokens: this.dayTtsTokens,
      daySttTokens: this.daySttTokens,
      meters: this.meters(),
      level: this.level(),
      degradedTurns: this.degradedTurns,
      blockedTurns: this.blockedTurns,
      sessionsToday: this.sessionHistoryRecords.length + (this.session ? 1 : 0),
    };
  }

  summary(): string {
    const s = this.stats();
    const meterText = s.meters
      .map((m) => `${m.meter} ${m.used.toFixed(m.meter === 'voiceMinutes' ? 1 : 0)}/${m.budget > 0 ? m.budget : '∞'} (${m.level})`)
      .join(', ');
    return `voice budget v18: day ${s.dayKey}, ${meterText}, ${s.degradedTurns} degraded turns, ${s.blockedTurns} blocked turns`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Voice budget v18',
      '',
      `- Day: ${s.dayKey}; session: ${s.sessionId ?? '—'}; overall level: ${s.level}`,
      `- Voice minutes today: ${s.dayVoiceMinutes.toFixed(1)}; TTS tokens: ${s.dayTtsTokens}; STT tokens: ${s.daySttTokens}`,
      `- Degraded turns: ${s.degradedTurns}; blocked turns: ${s.blockedTurns}; sessions today: ${s.sessionsToday}`,
      '',
      '| Meter | Used | Budget | Level |',
      '| --- | ---: | ---: | --- |',
    ];
    for (const m of s.meters) {
      lines.push(`| ${m.meter} | ${m.used.toFixed(m.meter === 'voiceMinutes' ? 1 : 0)} | ${m.budget > 0 ? m.budget : 'unlimited'} | ${m.level} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  toJSON(): {
    version: 1;
    dayKey: string;
    dayVoiceSeconds: number;
    dayTtsTokens: number;
    daySttTokens: number;
    budgets: VoiceBudgetV18Budgets;
    degradedTurns: number;
    blockedTurns: number;
    sessionHistory: VoiceBudgetV18SessionRecord[];
  } {
    return {
      version: 1,
      dayKey: this.dayKey,
      dayVoiceSeconds: this.dayVoiceSeconds,
      dayTtsTokens: this.dayTtsTokens,
      daySttTokens: this.daySttTokens,
      budgets: {
        dailyVoiceMinutes: this.options.dailyVoiceMinutes,
        dailyTtsTokens: this.options.dailyTtsTokens,
        dailySttTokens: this.options.dailySttTokens,
        sessionVoiceMinutes: this.options.sessionVoiceMinutes,
      },
      degradedTurns: this.degradedTurns,
      blockedTurns: this.blockedTurns,
      sessionHistory: this.sessionHistory(),
    };
  }

  fromJSON(data: unknown, atMs = 0): { loaded: boolean; dropped: number } {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('voice budget v18 JSON must be an object');
    }
    const obj = data as { version?: unknown; dayKey?: unknown; dayVoiceSeconds?: unknown; dayTtsTokens?: unknown; daySttTokens?: unknown; budgets?: unknown; degradedTurns?: unknown; blockedTurns?: unknown; sessionHistory?: unknown };
    if (obj.version !== 1) throw new Error(`unsupported voice budget v18 version: ${String(obj.version)}`);
    let dropped = 0;
    // A stale day is dropped, not loaded: yesterday's totals must
    // never count against today's budget.
    const todayKey = voiceBudgetDayKeyV18(atMs);
    if (typeof obj.dayKey === 'string' && obj.dayKey === todayKey) {
      if (typeof obj.dayVoiceSeconds === 'number' && Number.isFinite(obj.dayVoiceSeconds) && obj.dayVoiceSeconds >= 0) {
        this.dayVoiceSeconds = obj.dayVoiceSeconds;
      } else dropped += 1;
      if (typeof obj.dayTtsTokens === 'number' && Number.isFinite(obj.dayTtsTokens) && obj.dayTtsTokens >= 0) {
        this.dayTtsTokens = Math.floor(obj.dayTtsTokens);
      } else dropped += 1;
      if (typeof obj.daySttTokens === 'number' && Number.isFinite(obj.daySttTokens) && obj.daySttTokens >= 0) {
        this.daySttTokens = Math.floor(obj.daySttTokens);
      } else dropped += 1;
    } else if (typeof obj.dayKey === 'string') {
      dropped += 1; // stale day: totals ignored
    }
    if (typeof obj.degradedTurns === 'number' && obj.degradedTurns >= 0) this.degradedTurns = Math.floor(obj.degradedTurns);
    if (typeof obj.blockedTurns === 'number' && obj.blockedTurns >= 0) this.blockedTurns = Math.floor(obj.blockedTurns);
    if (Array.isArray(obj.sessionHistory)) {
      for (const raw of obj.sessionHistory as VoiceBudgetV18SessionRecord[]) {
        if (raw && typeof raw.sessionId === 'string' && typeof raw.startedAtMs === 'number') {
          this.sessionHistoryRecords.push({ ...raw });
        } else dropped += 1;
      }
      while (this.sessionHistoryRecords.length > this.options.maxSessionHistory) this.sessionHistoryRecords.shift();
    }
    return { loaded: true, dropped };
  }

  private meterState(meter: VoiceBudgetV18MeterId, used: number, budget: number): VoiceBudgetV18MeterState {
    if (budget <= 0) return { meter, used, budget: 0, fraction: 0, level: 'ok', remaining: Infinity };
    const fraction = used / budget;
    const level: VoiceBudgetV18Level =
      fraction >= 1 ? 'exceeded' : fraction >= this.options.criticalAt ? 'critical' : fraction >= this.options.warnAt ? 'warn' : 'ok';
    return { meter, used, budget, fraction, level, remaining: Math.max(0, budget - used) };
  }

  private checkThresholds(atMs: number): void {
    for (const m of this.meters()) {
      if (m.budget <= 0) continue;
      const fired = this.firedLevels.get(m.meter);
      if (fired !== m.level && m.level !== 'ok') {
        this.firedLevels.set(m.meter, m.level);
        this.sink?.({ kind: 'threshold', atMs, meter: m.meter, level: m.level, used: m.used, budget: m.budget, reason: `${m.meter} at ${Math.round(m.fraction * 100)}% of budget` });
      } else if (m.level === 'ok') {
        this.firedLevels.delete(m.meter);
      }
    }
  }

  private noteDegraded(atMs: number, reason: string): void {
    this.degradedTurns += 1;
    if (this.session) this.session.degradedTurns += 1;
    this.sink?.({ kind: 'degraded', atMs, level: this.level(), reason });
  }

  private rolloverIfNeeded(atMs: number): void {
    const key = voiceBudgetDayKeyV18(atMs);
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.dayVoiceSeconds = 0;
    this.dayTtsTokens = 0;
    this.daySttTokens = 0;
    this.firedLevels.clear();
    this.sink?.({ kind: 'day-rollover', atMs, reason: `new day ${key} — day totals reset` });
  }
}

export function createVoiceBudgetMeterV18(
  options?: VoiceBudgetV18Options,
  sink?: VoiceBudgetV18EventSink,
  atMs = 0,
): VoiceBudgetMeterV18 {
  return new VoiceBudgetMeterV18(options, sink, atMs);
}

export function voiceBudgetV18Summary(meter: VoiceBudgetMeterV18): string {
  return meter.summary();
}

export function voiceBudgetV18Markdown(meter: VoiceBudgetMeterV18): string {
  return meter.markdown();
}
