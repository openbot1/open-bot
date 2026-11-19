/**
 * Proactive audio v30 (v1.44, Team T4).
 *
 * What v29 got wrong and v30 fixes:
 *
 *   - Triggers fired in schedule order. v30 runs a priority
 *     queue: a critical alert pre-empts a normal idle nudge,
 *     and a trigger that arrives while a lower-priority one
 *     is waiting jumps ahead of it. Kinds gained two new
 *     members: `task-complete` (a background task finished)
 *     and `alert` (something needs the user's attention now).
 *   - No rate limiting beyond one global cooldown. v30 adds
 *     a token bucket per kind *plus* a global bucket: each
 *     kind refills slowly, so a chatty task-completer cannot
 *     drown out reminders, and the global bucket caps total
 *     interruptions per minute.
 *   - The same event could be announced twice. v30
 *     deduplicates by key: a second trigger with the same
 *     `dedupeKey` inside the window is dropped and recorded
 *     as `deduplicated`, never spoken.
 *   - Triggers never expired. v30 gives every trigger a TTL:
 *     a reminder that is still undelivered when its TTL runs
 *     out expires instead of blurting out stale news.
 *   - v29 only checked quiet hours. v30 also gates on
 *     do-not-disturb and on user presence (the agent only
 *     speaks first when the user is present and not in
 *     another call), and on whether the user is speaking.
 *   - Suppressed triggers vanished silently. v30 escalates:
 *     when audio is suppressed and the trigger allows it, a
 *     text notification is recorded instead, so the event is
 *     never lost — the user sees it in text even when the
 *     agent may not speak.
 *
 * Consent still gates everything: when disabled, nothing is
 * scheduled and nothing fires. All clocks virtual (the
 * caller passes `atMs`); no audio is played, no provider
 * is dialled.
 */

import {
  VOICE_V30_PROACTIVE_BUCKET_CAPACITY_DEFAULT,
  VOICE_V30_PROACTIVE_BUCKET_REFILL_PER_MIN_DEFAULT,
  VOICE_V30_PROACTIVE_COOLDOWN_DEFAULT_MS,
  VOICE_V30_PROACTIVE_DEDUPE_WINDOW_DEFAULT_MS,
  VOICE_V30_PROACTIVE_IDLE_NUDGE_DEFAULT_MS,
  VOICE_V30_PROACTIVE_MAX_TRIGGERS_DEFAULT,
  VOICE_V30_PROACTIVE_TTL_DEFAULT_MS,
  type VoiceV30ProactiveEvent,
  type VoiceV30ProactiveKind,
  type VoiceV30ProactiveOutcome,
  type VoiceV30ProactivePriority,
  type VoiceV30ProactiveTrigger,
} from './types';

export interface ProactiveAudioV30Options {
  /** Master switch (consent). When false, nothing fires. */
  enabled?: boolean;
  /** Idle (ms) before an idle nudge may fire. */
  idleNudgeMs?: number;
  /** Minimum gap (ms) between two spoken triggers. */
  cooldownMs?: number;
  /** Max triggers kept (oldest dropped first). */
  maxTriggers?: number;
  /** Token-bucket capacity per kind (and globally). */
  bucketCapacity?: number;
  /** Tokens refilled per minute, per bucket. */
  bucketRefillPerMin?: number;
  /** Dedupe window (ms) for identical dedupe keys. */
  dedupeWindowMs?: number;
  /** Default TTL (ms) for triggers without an explicit one. */
  defaultTtlMs?: number;
  /** Quiet hours start (0-23 UTC hour, null = none). */
  quietHoursStart?: number | null;
  /** Quiet hours end (0-23 UTC hour, null = none). */
  quietHoursEnd?: number | null;
  /** Do-not-disturb: when true, audio is suppressed (text fallback applies). */
  doNotDisturb?: boolean;
  /** The user is present (seated, app focused). When false, audio is suppressed. */
  userPresent?: boolean;
  /** The user is in another call. When true, audio is suppressed. */
  userInCall?: boolean;
  /** Called when a trigger fires or is suppressed. */
  onEvent?: (event: VoiceV30ProactiveEvent) => void;
  /** Called when a text fallback notification is recorded. */
  onTextFallback?: (trigger: VoiceV30ProactiveTrigger) => void;
}

export interface VoiceV30ProactiveStats {
  enabled: boolean;
  scheduled: number;
  fired: number;
  suppressed: number;
  expired: number;
  deduplicated: number;
  textFallbacks: number;
  byKind: Record<string, { scheduled: number; fired: number; suppressed: number }>;
  byPriority: Record<string, number>;
  bucketTokens: Record<string, number>;
  globalBucketTokens: number;
  lastFiredAtMs: number | null;
}

export interface VoiceV30QuietHours {
  start: number | null;
  end: number | null;
}

/** Priority rank (higher fires first). */
export const VOICE_V30_PROACTIVE_PRIORITY_RANK: Record<VoiceV30ProactivePriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** Default priority per kind (the caller may override per trigger). */
export const VOICE_V30_PROACTIVE_KIND_PRIORITY: Record<VoiceV30ProactiveKind, VoiceV30ProactivePriority> = {
  alert: 'critical',
  'task-complete': 'high',
  'scheduled-reminder': 'high',
  greeting: 'normal',
  'idle-nudge': 'low',
  'event-announcement': 'normal',
  'follow-up': 'normal',
  digest: 'low',
};

export function defaultProactiveAudioV30Options(): ProactiveAudioV30Options {
  return {
    enabled: true,
    idleNudgeMs: VOICE_V30_PROACTIVE_IDLE_NUDGE_DEFAULT_MS,
    cooldownMs: VOICE_V30_PROACTIVE_COOLDOWN_DEFAULT_MS,
    maxTriggers: VOICE_V30_PROACTIVE_MAX_TRIGGERS_DEFAULT,
    bucketCapacity: VOICE_V30_PROACTIVE_BUCKET_CAPACITY_DEFAULT,
    bucketRefillPerMin: VOICE_V30_PROACTIVE_BUCKET_REFILL_PER_MIN_DEFAULT,
    dedupeWindowMs: VOICE_V30_PROACTIVE_DEDUPE_WINDOW_DEFAULT_MS,
    defaultTtlMs: VOICE_V30_PROACTIVE_TTL_DEFAULT_MS,
    quietHoursStart: null,
    quietHoursEnd: null,
    doNotDisturb: false,
    userPresent: true,
    userInCall: false,
  };
}

export class ProactiveAudioV30 {
  private enabled: boolean;
  private readonly idleNudgeMs: number;
  private readonly cooldownMs: number;
  private readonly maxTriggers: number;
  private readonly bucketCapacity: number;
  private readonly bucketRefillPerMin: number;
  private readonly dedupeWindowMs: number;
  private readonly defaultTtlMs: number;
  private quietHours: VoiceV30QuietHours;
  private doNotDisturb: boolean;
  private userPresent: boolean;
  private userInCall: boolean;
  private readonly onEvent?: (event: VoiceV30ProactiveEvent) => void;
  private readonly onTextFallback?: (trigger: VoiceV30ProactiveTrigger) => void;

  private readonly triggers = new Map<string, VoiceV30ProactiveTrigger>();
  private readonly events: VoiceV30ProactiveEvent[] = [];
  private readonly textFallbacks: VoiceV30ProactiveTrigger[] = [];
  private triggerCount = 0;
  private lastFiredAtMs: number | null = null;
  private lastBucketRefillAtMs: number | null = null;
  /** Tokens per kind bucket. */
  private readonly buckets = new Map<string, number>();
  /** Global bucket tokens. */
  private globalTokens: number;
  /** Last fired atMs per dedupe key (for the dedupe window). */
  private readonly dedupeSeen = new Map<string, number>();

  constructor(opts: ProactiveAudioV30Options = {}) {
    const d = defaultProactiveAudioV30Options();
    this.enabled = opts.enabled ?? d.enabled ?? true;
    this.idleNudgeMs = opts.idleNudgeMs ?? d.idleNudgeMs ?? 60_000;
    this.cooldownMs = opts.cooldownMs ?? d.cooldownMs ?? 30_000;
    this.maxTriggers = opts.maxTriggers ?? d.maxTriggers ?? 50;
    this.bucketCapacity = opts.bucketCapacity ?? d.bucketCapacity ?? 5;
    this.bucketRefillPerMin = opts.bucketRefillPerMin ?? d.bucketRefillPerMin ?? 1;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? d.dedupeWindowMs ?? 60_000;
    this.defaultTtlMs = opts.defaultTtlMs ?? d.defaultTtlMs ?? 300_000;
    this.quietHours = {
      start: opts.quietHoursStart ?? d.quietHoursStart ?? null,
      end: opts.quietHoursEnd ?? d.quietHoursEnd ?? null,
    };
    this.doNotDisturb = opts.doNotDisturb ?? d.doNotDisturb ?? false;
    this.userPresent = opts.userPresent ?? d.userPresent ?? true;
    this.userInCall = opts.userInCall ?? d.userInCall ?? false;
    this.onEvent = opts.onEvent;
    this.onTextFallback = opts.onTextFallback;
    this.globalTokens = this.bucketCapacity;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setQuietHours(start: number | null, end: number | null): void {
    this.quietHours = { start, end };
  }

  getQuietHours(): VoiceV30QuietHours {
    return { ...this.quietHours };
  }

  setDoNotDisturb(value: boolean): void {
    this.doNotDisturb = value;
  }

  setPresence(present: boolean, inCall: boolean): void {
    this.userPresent = present;
    this.userInCall = inCall;
  }

  inQuietHours(atMs: number): boolean {
    const { start, end } = this.quietHours;
    if (start === null || end === null) return false;
    const hour = new Date(atMs).getUTCHours();
    if (start <= end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  /** Tokens left in a kind bucket (after refill to `atMs`). */
  bucketTokens(kind: VoiceV30ProactiveKind, atMs: number): number {
    this.refillBuckets(atMs);
    return this.buckets.get(kind) ?? this.bucketCapacity;
  }

  globalBucketTokens(atMs: number): number {
    this.refillBuckets(atMs);
    return this.globalTokens;
  }

  /**
   * Schedule a trigger. Returns null when disabled (nothing
   * is ever scheduled without consent) and the trigger when
   * accepted. A duplicate dedupe key inside the window is
   * dropped immediately and recorded as `deduplicated`.
   */
  schedule(
    kind: VoiceV30ProactiveKind,
    text: string,
    atMs: number,
    opts: {
      priority?: VoiceV30ProactivePriority;
      delayMs?: number;
      ttlMs?: number;
      dedupeKey?: string | null;
      payload?: Record<string, string>;
      allowTextFallback?: boolean;
    } = {},
  ): VoiceV30ProactiveTrigger | null {
    if (!this.enabled) return null;
    if (!text.trim()) throw new Error('Proactive trigger text must not be empty');
    const dedupeKey = opts.dedupeKey ?? null;
    if (dedupeKey !== null) {
      const last = this.dedupeSeen.get(dedupeKey);
      if (last !== undefined && atMs - last < this.dedupeWindowMs) {
        this.triggerCount += 1;
        const dropped: VoiceV30ProactiveTrigger = {
          id: `pro-${this.triggerCount}`,
          kind,
          priority: opts.priority ?? VOICE_V30_PROACTIVE_KIND_PRIORITY[kind],
          text,
          scheduledAtMs: atMs + (opts.delayMs ?? 0),
          ttlMs: opts.ttlMs ?? this.defaultTtlMs,
          dedupeKey,
          payload: { ...(opts.payload ?? {}) },
          allowTextFallback: opts.allowTextFallback ?? true,
          state: 'deduplicated',
          outcome: 'deduplicated',
          firedAtMs: null,
        };
        this.recordEvent(atMs, dropped, 'deduplicated', `Duplicate of key "${dedupeKey}" inside the dedupe window`);
        this.triggers.set(dropped.id, dropped);
        return dropped;
      }
      this.dedupeSeen.set(dedupeKey, atMs);
    }
    this.triggerCount += 1;
    const trigger: VoiceV30ProactiveTrigger = {
      id: `pro-${this.triggerCount}`,
      kind,
      priority: opts.priority ?? VOICE_V30_PROACTIVE_KIND_PRIORITY[kind],
      text,
      scheduledAtMs: atMs + (opts.delayMs ?? 0),
      ttlMs: opts.ttlMs ?? this.defaultTtlMs,
      dedupeKey,
      payload: { ...(opts.payload ?? {}) },
      allowTextFallback: opts.allowTextFallback ?? true,
      state: 'scheduled',
      outcome: null,
      firedAtMs: null,
    };
    this.triggers.set(trigger.id, trigger);
    if (this.triggers.size > this.maxTriggers) {
      // Drop the lowest-priority oldest scheduled trigger.
      const scheduled = [...this.triggers.values()]
        .filter((t) => t.state === 'scheduled')
        .sort((a, b) => VOICE_V30_PROACTIVE_PRIORITY_RANK[a.priority] - VOICE_V30_PROACTIVE_PRIORITY_RANK[b.priority]);
      const victim = scheduled[0];
      if (victim && victim.id !== trigger.id) {
        victim.state = 'cancelled';
        victim.outcome = 'cancelled';
        this.triggers.delete(victim.id);
      }
    }
    return { ...trigger };
  }

  cancel(triggerId: string, atMs: number): boolean {
    const t = this.triggers.get(triggerId);
    if (!t || t.state !== 'scheduled') return false;
    t.state = 'cancelled';
    t.outcome = 'cancelled';
    this.recordEvent(atMs, t, 'cancelled', 'Cancelled by the host');
    return true;
  }

  get(triggerId: string): VoiceV30ProactiveTrigger | null {
    const t = this.triggers.get(triggerId);
    return t ? { ...t, payload: { ...t.payload } } : null;
  }

  /** Scheduled triggers due at `atMs`, highest priority first. */
  due(atMs: number): VoiceV30ProactiveTrigger[] {
    return [...this.triggers.values()]
      .filter((t) => t.state === 'scheduled' && t.scheduledAtMs <= atMs)
      .sort((a, b) =>
        VOICE_V30_PROACTIVE_PRIORITY_RANK[b.priority] - VOICE_V30_PROACTIVE_PRIORITY_RANK[a.priority] ||
        a.scheduledAtMs - b.scheduledAtMs,
      )
      .map((t) => ({ ...t, payload: { ...t.payload } }));
  }

  list(): VoiceV30ProactiveTrigger[] {
    return [...this.triggers.values()].map((t) => ({ ...t, payload: { ...t.payload } }));
  }

  /**
   * Tick the queue at `atMs`. Returns the trigger that was
   * spoken, or null when nothing fired. Each due trigger is
   * evaluated in priority order: expired triggers expire,
   * suppressed triggers escalate to a text fallback when
   * allowed, and the first trigger that passes every gate
   * fires. Only one trigger fires per tick.
   *
   * `userSpeaking` — never speak over the user.
   */
  tick(atMs: number, userSpeaking: boolean): VoiceV30ProactiveTrigger | null {
    if (!this.enabled) return null;
    this.refillBuckets(atMs);
    for (const trigger of this.due(atMs)) {
      const stored = this.triggers.get(trigger.id);
      if (!stored) continue;
      // Expired: TTL ran out before delivery.
      if (stored.ttlMs > 0 && atMs - stored.scheduledAtMs > stored.ttlMs) {
        stored.state = 'expired';
        stored.outcome = 'expired';
        this.recordEvent(atMs, stored, 'expired', `TTL ${stored.ttlMs}ms ran out before delivery`);
        continue;
      }
      const suppression = this.suppressionReason(atMs, userSpeaking);
      if (suppression !== null) {
        // Critical alerts may still speak during DND/quiet
        // hours only when the host explicitly allows it via
        // the payload flag; otherwise they escalate to text.
        const forceAudio = stored.priority === 'critical' && stored.payload.forceAudio === 'true';
        if (!forceAudio) {
          stored.state = 'suppressed';
          stored.outcome = suppression;
          this.recordEvent(atMs, stored, suppression, this.suppressionDetail(suppression));
          this.escalateToText(stored, atMs);
          continue;
        }
      }
      // Rate limit: one token from the kind bucket and the global bucket.
      const kindTokens = this.buckets.get(stored.kind) ?? this.bucketCapacity;
      if (kindTokens < 1 || this.globalTokens < 1) {
        stored.state = 'suppressed';
        stored.outcome = 'suppressed-rate-limit';
        this.recordEvent(atMs, stored, 'suppressed-rate-limit', `Rate limit: ${stored.kind} bucket ${kindTokens}, global ${this.globalTokens}`);
        this.escalateToText(stored, atMs);
        continue;
      }
      // Cooldown between spoken triggers (critical bypasses it).
      if (
        stored.priority !== 'critical' &&
        this.lastFiredAtMs !== null &&
        atMs - this.lastFiredAtMs < this.cooldownMs
      ) {
        continue; // stays scheduled; a later tick may fire it.
      }
      this.buckets.set(stored.kind, kindTokens - 1);
      this.globalTokens -= 1;
      stored.state = 'fired';
      stored.outcome = 'spoken';
      stored.firedAtMs = atMs;
      this.lastFiredAtMs = atMs;
      this.recordEvent(atMs, stored, 'spoken', `Spoke (${stored.priority} ${stored.kind}): ${stored.text}`);
      return { ...stored, payload: { ...stored.payload } };
    }
    return null;
  }

  /** Text fallback notifications recorded so far. */
  textFallbacksSoFar(): VoiceV30ProactiveTrigger[] {
    return this.textFallbacks.map((t) => ({ ...t, payload: { ...t.payload } }));
  }

  eventsSoFar(): VoiceV30ProactiveEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  stats(): VoiceV30ProactiveStats {
    const byKind: VoiceV30ProactiveStats['byKind'] = {};
    const byPriority: Record<string, number> = {};
    let fired = 0;
    let suppressed = 0;
    let expired = 0;
    let deduplicated = 0;
    for (const t of this.triggers.values()) {
      const row = byKind[t.kind] ?? { scheduled: 0, fired: 0, suppressed: 0 };
      row.scheduled += 1;
      if (t.state === 'fired') { row.fired += 1; fired += 1; }
      if (t.state === 'suppressed') { row.suppressed += 1; suppressed += 1; }
      if (t.state === 'expired') expired += 1;
      if (t.state === 'deduplicated') deduplicated += 1;
      byKind[t.kind] = row;
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    }
    const bucketTokens: Record<string, number> = {};
    for (const [kind, tokens] of this.buckets) bucketTokens[kind] = tokens;
    return {
      enabled: this.enabled,
      scheduled: this.triggers.size,
      fired,
      suppressed,
      expired,
      deduplicated,
      textFallbacks: this.textFallbacks.length,
      byKind,
      byPriority,
      bucketTokens,
      globalBucketTokens: this.globalTokens,
      lastFiredAtMs: this.lastFiredAtMs,
    };
  }

  reset(): void {
    this.triggers.clear();
    this.events.length = 0;
    this.textFallbacks.length = 0;
    this.triggerCount = 0;
    this.lastFiredAtMs = null;
    this.lastBucketRefillAtMs = null;
    this.buckets.clear();
    this.globalTokens = this.bucketCapacity;
    this.dedupeSeen.clear();
  }

  /** First suppression gate that applies, or null when clear. */
  private suppressionReason(atMs: number, userSpeaking: boolean): VoiceV30ProactiveOutcome | null {
    if (this.inQuietHours(atMs)) return 'suppressed-quiet-hours';
    if (this.doNotDisturb) return 'suppressed-dnd';
    if (!this.userPresent) return 'suppressed-not-present';
    if (this.userInCall) return 'suppressed-not-present';
    if (userSpeaking) return 'suppressed-user-speaking';
    return null;
  }

  private suppressionDetail(outcome: VoiceV30ProactiveOutcome): string {
    switch (outcome) {
      case 'suppressed-quiet-hours': return 'Suppressed: quiet hours';
      case 'suppressed-dnd': return 'Suppressed: do-not-disturb is on';
      case 'suppressed-user-speaking': return 'Suppressed: user is speaking';
      case 'suppressed-not-present': return 'Suppressed: user is not present (or in another call)';
      default: return `Suppressed: ${outcome}`;
    }
  }

  /** Record a text fallback (the event is not lost when audio is suppressed). */
  private escalateToText(trigger: VoiceV30ProactiveTrigger, atMs: number): void {
    if (!trigger.allowTextFallback) return;
    const copy: VoiceV30ProactiveTrigger = { ...trigger, payload: { ...trigger.payload }, outcome: 'text-fallback' };
    this.textFallbacks.push(copy);
    this.recordEvent(atMs, copy, 'text-fallback', `Text fallback recorded: ${trigger.text}`);
    this.onTextFallback?.({ ...copy, payload: { ...copy.payload } });
  }

  private recordEvent(atMs: number, trigger: VoiceV30ProactiveTrigger, outcome: VoiceV30ProactiveOutcome, detail: string): void {
    const event: VoiceV30ProactiveEvent = {
      atMs,
      triggerId: trigger.id,
      kind: trigger.kind,
      priority: trigger.priority,
      outcome,
      detail,
    };
    this.events.push(event);
    this.onEvent?.({ ...event });
  }

  /** Refill all token buckets by elapsed time (1 token per refill interval). */
  private refillBuckets(atMs: number): void {
    if (this.lastBucketRefillAtMs === null) {
      this.lastBucketRefillAtMs = atMs;
      return;
    }
    const elapsedMs = atMs - this.lastBucketRefillAtMs;
    if (elapsedMs <= 0) return;
    const refillMsPerToken = 60_000 / Math.max(0.001, this.bucketRefillPerMin);
    const tokens = Math.floor(elapsedMs / refillMsPerToken);
    if (tokens <= 0) return;
    this.lastBucketRefillAtMs = atMs;
    this.globalTokens = Math.min(this.bucketCapacity, this.globalTokens + tokens);
    for (const [kind, value] of this.buckets) {
      this.buckets.set(kind, Math.min(this.bucketCapacity, value + tokens));
    }
  }
}

export function createProactiveAudioV30(opts: ProactiveAudioV30Options = {}): ProactiveAudioV30 {
  return new ProactiveAudioV30(opts);
}
