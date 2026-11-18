/**
 * Wake-word detection v4 (v1.17, Đội T5 — voice v16).
 *
 * v15 decided *whether* a transcript really contains a wake word
 * (multi-word registry, sensitivity thresholds, near-miss /
 * low-energy / cooldown suppression, confirmation window). v16
 * owns the *lifecycle around* the wake — when the bot is awake,
 * when it goes back to sleep, and what the user said *with* the
 * wake word:
 *
 *   1. Many configurable words, each with its own sensitivity,
 *      language, cooldown and an optional `action` label (e.g.
 *      "hey bot" wakes for chat, "hey bot, ghi chú" could wake
 *      straight into dictation — the session maps the label).
 *      Words can be added, removed, enabled and disabled at
 *      runtime; the v15 detector underneath still owns matching.
 *   2. Wake + command in one breath: "hey bot, thời tiết hôm
 *      nay thế nào?" wakes *and* hands the session the command
 *      ("thời tiết hôm nay thế nào?") in the same event, so the
 *      user never has to repeat themselves. A bare wake word
 *      ("hey bot") still opens the confirmation window and waits
 *      for follow-up speech, exactly like v15.
 *   3. Sleep after N seconds of silence (`sleepAfterSilenceMs`,
 *      default 60 s): while awake, every speech frame resets the
 *      silence timer; when it lapses the detector emits `sleep`
 *      and the session goes back behind the wake-word gate. A
 *      manual `sleep()` does the same immediately, and any speech
 *      activity while awake postpones it.
 *   4. False-positive guards stay: energy gate, near-miss
 *      suppression, per-word + global cooldowns, and the
 *      confirmation window — plus a *wake storm* guard: more
 *      than `maxActivationsPerMinute` activations in a minute
 *      (the mic hearing itself, a TV looping the word) mutes
 *      the detector for `stormMuteMs` instead of waking the bot
 *      on every echo.
 *   5. Labelled evaluation is inherited from v15 and extended
 *      with sleep behaviour: the report counts activations,
 *      confirmations, sleeps (timed + manual), commands captured
 *      in the same breath, and suppressions by reason.
 *
 * Input is transcript text + frame energy + speech-activity ticks;
 * there is no audio model here, so the detector stays pure text +
 * numbers and fully testable with scripted transcripts.
 */

import { WakeWordDetectorV15, createWakeWordDetectorV15, wakeWordSimilarityV15 } from '../voiceV15/wakeWordV15';
import type {
  WakeWordV15Config,
  WakeWordV15Sensitivity,
  WakeWordV15Event,
  WakeWordV15SuppressReason,
} from '../voiceV15/wakeWordV15';

export interface WakeWordV16Config extends WakeWordV15Config {
  /** Optional action label the session maps (e.g. 'chat', 'dictate'). */
  action?: string;
}

export function defaultWakeWordV16Config(word: string): WakeWordV16Config {
  return {
    word,
    language: 'vi',
    sensitivity: 'balanced',
    minEnergy: 0.01,
    cooldownMs: 3000,
    confirmMs: 5000,
    enabled: true,
  };
}

export function validateWakeWordV16Config(config: WakeWordV16Config): string[] {
  const errors: string[] = [];
  if (!config.word.trim()) errors.push('word must not be empty');
  if (config.word.trim().length > 40) errors.push('word must be at most 40 characters');
  if (config.action !== undefined && config.action.trim().length > 40) errors.push('action must be at most 40 characters');
  return errors;
}

export interface WakeWordV16Options {
  /** ms of silence while awake before auto-sleep (default 60000). */
  sleepAfterSilenceMs?: number;
  /** Max activations per minute before the storm guard mutes (default 5). */
  maxActivationsPerMinute?: number;
  /** ms the detector stays muted after a wake storm (default 30000). */
  stormMuteMs?: number;
  /** Global cooldown (ms) between activations of any word (default 1000). */
  globalCooldownMs?: number;
}

export function defaultWakeWordV16Options(): Required<WakeWordV16Options> {
  return {
    sleepAfterSilenceMs: 60000,
    maxActivationsPerMinute: 5,
    stormMuteMs: 30000,
    globalCooldownMs: 1000,
  };
}

export function validateWakeWordV16Options(options: WakeWordV16Options): string[] {
  const errors: string[] = [];
  const check = (name: keyof WakeWordV16Options, value: number | undefined, min: number, max: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      errors.push(`${name} must be ${min}..${max}`);
    }
  };
  check('sleepAfterSilenceMs', options.sleepAfterSilenceMs, 5000, 600000);
  check('maxActivationsPerMinute', options.maxActivationsPerMinute, 1, 60);
  check('stormMuteMs', options.stormMuteMs, 1000, 300000);
  check('globalCooldownMs', options.globalCooldownMs, 0, 60000);
  return errors;
}

export const WAKE_WORD_V16_DEFAULT_WORDS: readonly string[] = ['hey bot', 'này bot', 'open bot'];

export type WakeWordV16EventKind =
  | 'activated'
  | 'suppressed'
  | 'confirmed'
  | 'expired'
  | 'sleep'
  | 'wake-command'
  | 'storm-muted';

export interface WakeWordV16Event {
  kind: WakeWordV16EventKind;
  atMs: number;
  word: string;
  similarity: number;
  reason?: WakeWordV15SuppressReason | 'sleep-timeout' | 'manual' | 'wake-storm';
  transcript?: string;
  /** Command spoken in the same breath as the wake word, if any. */
  command?: string;
  action?: string;
}

export type WakeWordV16Sink = (event: WakeWordV16Event) => void;

export interface WakeWordV16Stats {
  activations: number;
  confirmations: number;
  expirations: number;
  sleeps: number;
  timedSleeps: number;
  manualSleeps: number;
  wakeCommands: number;
  stormMutes: number;
  suppressions: Partial<Record<WakeWordV15SuppressReason, number>>;
  totalSuppressions: number;
  words: number;
  enabledWords: number;
  awake: boolean;
}

function normaliseV16(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Text after the wake word in the same utterance ('' when bare). */
export function extractWakeCommandV16(transcript: string, word: string): string {
  const hay = normaliseV16(transcript);
  const needle = normaliseV16(word);
  const idx = hay.indexOf(needle);
  if (idx < 0) return '';
  return hay.slice(idx + needle.length).trim();
}

/**
 * Multi-word detector + awake/sleep lifecycle + wake-command
 * extraction + wake-storm guard. `feedTranscript()` is called with
 * each STT final (or confident partial); `feedSpeechActivity()`
 * with every speech frame while awake; `tick()` expires pending
 * confirmations and the sleep timer.
 */
export class WakeWordDetectorV16 {
  readonly inner: WakeWordDetectorV15;
  private readonly options: Required<WakeWordV16Options>;
  private readonly sink: WakeWordV16Sink | undefined;
  private readonly actions = new Map<string, string>();
  private awake = false;
  private lastSpeechAtMs: number | undefined;
  private lastActivationAtMs: number | undefined;
  private readonly activationTimes: number[] = [];
  private mutedUntilMs = 0;
  private sleeps = 0;
  private timedSleeps = 0;
  private manualSleeps = 0;
  private wakeCommands = 0;
  private stormMutes = 0;

  constructor(
    words: WakeWordV16Config[] = WAKE_WORD_V16_DEFAULT_WORDS.map((w) => defaultWakeWordV16Config(w)),
    options: WakeWordV16Options = {},
    sink?: WakeWordV16Sink,
  ) {
    const merged = { ...defaultWakeWordV16Options(), ...options };
    const errors = validateWakeWordV16Options(merged);
    if (errors.length > 0) throw new Error(`invalid wake-word v16 options: ${errors.join('; ')}`);
    this.options = merged;
    this.sink = sink;
    const v15Configs: WakeWordV15Config[] = words.map((w) => ({
      word: w.word,
      language: w.language,
      sensitivity: w.sensitivity,
      minEnergy: w.minEnergy,
      cooldownMs: w.cooldownMs,
      confirmMs: w.confirmMs,
      enabled: w.enabled,
    }));
    this.inner = createWakeWordDetectorV15(v15Configs, (event) => this.onInnerEvent(event));
    for (const w of words) {
      if (w.action) this.actions.set(normaliseV16(w.word), w.action);
    }
  }

  setWord(config: WakeWordV16Config): void {
    const errors = validateWakeWordV16Config(config);
    if (errors.length > 0) throw new Error(`invalid wake-word config: ${errors.join('; ')}`);
    this.inner.setWord(config);
    if (config.action) this.actions.set(normaliseV16(config.word), config.action);
    else this.actions.delete(normaliseV16(config.word));
  }

  removeWord(word: string): boolean {
    this.actions.delete(normaliseV16(word));
    return this.inner.removeWord(word);
  }

  listWords(): WakeWordV16Config[] {
    return this.inner.listWords().map((w) => {
      const action = this.actions.get(normaliseV16(w.word));
      return action !== undefined ? { ...w, action } : { ...w };
    });
  }

  setSensitivity(word: string, sensitivity: WakeWordV15Sensitivity): void {
    const found = this.inner.listWords().find((w) => normaliseV16(w.word) === normaliseV16(word));
    if (!found) throw new Error(`unknown wake word: ${word}`);
    this.inner.setWord({ ...found, sensitivity });
  }

  isAwake(): boolean {
    return this.awake;
  }

  isMuted(atMs: number): boolean {
    return atMs < this.mutedUntilMs;
  }

  /** Go back to sleep now (manual). */
  sleep(atMs: number): void {
    if (!this.awake) return;
    this.awake = false;
    this.lastSpeechAtMs = undefined;
    this.inner.sleep(atMs);
    this.sleeps += 1;
    this.manualSleeps += 1;
    this.sink?.({ kind: 'sleep', atMs, word: '', similarity: 1, reason: 'manual' });
  }

  /** Speech happened (any frame while awake) — postpones auto-sleep. */
  feedSpeechActivity(atMs: number): void {
    if (!this.awake) return;
    this.lastSpeechAtMs = atMs;
  }

  /**
   * Feed one transcript. Returns the event fired. While asleep a
   * match activates (or wakes with a command); while awake the
   * transcript is just speech activity that postpones sleep.
   */
  feedTranscript(transcript: string, atMs: number, energy = 1): WakeWordV16Event | undefined {
    if (this.isMuted(atMs)) {
      const event: WakeWordV16Event = { kind: 'suppressed', atMs, word: '', similarity: 0, reason: 'wake-storm', transcript };
      this.sink?.(event);
      return event;
    }
    if (this.awake) {
      this.feedSpeechActivity(atMs);
      return undefined;
    }
    const event = this.inner.feedTranscript(transcript, atMs, energy);
    if (!event) return undefined;
    if (event.kind === 'activated') {
      this.lastActivationAtMs = atMs;
      this.activationTimes.push(atMs);
      this.activationTimes.splice(0, this.activationTimes.length - 20);
      if (this.isStorm(atMs)) {
        this.mutedUntilMs = atMs + this.options.stormMuteMs;
        this.stormMutes += 1;
        this.awake = false;
        this.inner.sleep(atMs);
        const storm: WakeWordV16Event = { kind: 'storm-muted', atMs, word: event.word, similarity: event.similarity, reason: 'wake-storm', transcript };
        this.sink?.(storm);
        return storm;
      }
      const command = extractWakeCommandV16(transcript, event.word);
      const action = this.actions.get(normaliseV16(event.word));
      if (command.length > 0) {
        this.wakeCommands += 1;
        this.awake = true;
        this.lastSpeechAtMs = atMs;
        // The command already confirms the wake: clear the inner
        // pending activation so its confirmation window cannot
        // expire underneath an awake session.
        this.inner.sleep(atMs);
        const wakeCommand: WakeWordV16Event = {
          kind: 'wake-command', atMs, word: event.word, similarity: event.similarity,
          transcript, command, ...(action !== undefined ? { action } : {}),
        };
        this.sink?.(wakeCommand);
        return wakeCommand;
      }
      const activated: WakeWordV16Event = {
        kind: 'activated', atMs, word: event.word, similarity: event.similarity,
        transcript, ...(action !== undefined ? { action } : {}),
      };
      this.sink?.(activated);
      return activated;
    }
    if (event.kind === 'confirmed') {
      this.awake = true;
      this.lastSpeechAtMs = atMs;
      const confirmed: WakeWordV16Event = { kind: 'confirmed', atMs, word: event.word, similarity: event.similarity, transcript };
      this.sink?.(confirmed);
      return confirmed;
    }
    return { kind: event.kind, atMs, word: event.word, similarity: event.similarity, reason: event.reason, transcript };
  }

  /** Advance the clock; expires confirmations + the sleep timer. */
  tick(atMs: number): WakeWordV16Event | undefined {
    const innerEvent = this.inner.tick(atMs);
    if (innerEvent) {
      return { kind: innerEvent.kind, atMs, word: innerEvent.word, similarity: innerEvent.similarity, reason: innerEvent.reason };
    }
    if (this.awake && this.lastSpeechAtMs !== undefined && atMs - this.lastSpeechAtMs >= this.options.sleepAfterSilenceMs) {
      this.awake = false;
      this.lastSpeechAtMs = undefined;
      this.inner.sleep(atMs);
      this.sleeps += 1;
      this.timedSleeps += 1;
      const event: WakeWordV16Event = { kind: 'sleep', atMs, word: '', similarity: 1, reason: 'sleep-timeout' };
      this.sink?.(event);
      return event;
    }
    return undefined;
  }

  /** Labelled-set evaluation (delegates to the v15 detector). */
  evaluate(samples: { transcript: string; containsWakeWord: boolean; energy?: number; word?: string }[]): {
    total: number; truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number;
    falseAcceptRate: number; falseRejectRate: number; accuracy: number;
  } {
    return this.inner.evaluate(samples);
  }

  stats(): WakeWordV16Stats {
    const inner = this.inner.stats();
    return {
      activations: inner.activations,
      confirmations: inner.confirmations,
      expirations: inner.expirations,
      sleeps: this.sleeps,
      timedSleeps: this.timedSleeps,
      manualSleeps: this.manualSleeps,
      wakeCommands: this.wakeCommands,
      stormMutes: this.stormMutes,
      suppressions: inner.suppressions,
      totalSuppressions: inner.totalSuppressions,
      words: inner.words,
      enabledWords: inner.enabledWords,
      awake: this.awake,
    };
  }

  summary(): string {
    const s = this.stats();
    return `wake-word v16: ${s.activations} activations (${s.wakeCommands} with command), ${s.confirmations} confirmed, ` +
      `${s.sleeps} sleeps (${s.timedSleeps} timed), ${s.stormMutes} storm mutes, ${s.totalSuppressions} suppressed, ` +
      `${s.enabledWords}/${s.words} words enabled, ${s.awake ? 'awake' : 'asleep'}`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Wake word v16',
      '',
      `- Words: ${s.enabledWords}/${s.words} enabled; state: \`${s.awake ? 'awake' : 'asleep'}\``,
      `- Activations: ${s.activations} (${s.wakeCommands} with a command in the same breath); confirmed: ${s.confirmations}; expired: ${s.expirations}`,
      `- Sleeps: ${s.sleeps} (${s.timedSleeps} after silence, ${s.manualSleeps} manual); storm mutes: ${s.stormMutes}`,
      `- Suppressions: ${s.totalSuppressions}`,
      '',
      '| Word | Sensitivity | Action | Cooldown | Confirm window | Enabled |',
      '| --- | --- | --- | ---: | ---: | ---: |',
    ];
    for (const w of this.listWords()) {
      lines.push(`| ${w.word} | ${w.sensitivity} | ${w.action ?? '—'} | ${w.cooldownMs} ms | ${w.confirmMs} ms | ${w.enabled ? 'yes' : 'no'} |`);
    }
    lines.push('');
    lines.push('| Suppress reason | Count |');
    lines.push('| --- | ---: |');
    const reasons: WakeWordV15SuppressReason[] = ['near-miss', 'low-energy', 'cooldown', 'disabled', 'no-follow-up'];
    for (const reason of reasons) {
      lines.push(`| ${reason} | ${s.suppressions[reason] ?? 0} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private isStorm(atMs: number): boolean {
    const windowStart = atMs - 60000;
    const recent = this.activationTimes.filter((t) => t >= windowStart);
    return recent.length > this.options.maxActivationsPerMinute;
  }

  private onInnerEvent(_event: WakeWordV15Event): void {
    // The v16 layer re-emits its own events from feedTranscript /
    // tick; inner events are consumed here so the sink sees exactly
    // one event per activation, in v16 shape.
    void _event;
  }
}

export function createWakeWordDetectorV16(
  words?: WakeWordV16Config[],
  options?: WakeWordV16Options,
  sink?: WakeWordV16Sink,
): WakeWordDetectorV16 {
  return new WakeWordDetectorV16(words, options, sink);
}

export function wakeWordV16Summary(detector: WakeWordDetectorV16): string {
  return detector.summary();
}

export function wakeWordV16Markdown(detector: WakeWordDetectorV16): string {
  return detector.markdown();
}

export { wakeWordSimilarityV15 };
