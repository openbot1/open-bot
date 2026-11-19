/**
 * Proactive audio v29 (v1.42, Team T4).
 *
 * The agent may speak first — a greeting when the user
 * joins, a nudge after a long silence, a scheduled
 * reminder, an announcement when something the user asked
 * to watch actually happens. Idea: Gemini 3.8 Live
 * proactive audio, always on (survey §4) — but in
 * open-bot it is gated, never unconditional:
 *
 *   - consent: proactive audio is off unless the session
 *     enables it (the user opts in);
 *   - quiet hours: a daily window (e.g. 22:00–07:00)
 *     during which nothing proactive fires;
 *   - cooldown: the same kind of trigger cannot fire
 *     twice inside its cooldown window;
 *   - never while the user is speaking: a due trigger is
 *     suppressed (not lost — it stays due) while the
 *     floor belongs to the user, and while the agent is
 *     already speaking;
 *   - priority: when several triggers are due, the
 *     highest priority fires first.
 *
 * Triggers are one-shot by default; `repeat` reschedules
 * them after firing. The scheduler never opens a mic and
 * never plays audio — it decides *what* to say and *when*;
 * the session speaks it. All clocks virtual.
 */

import {
  VOICE_V29_PROACTIVE_COOLDOWN_DEFAULT_MS,
  VOICE_V29_PROACTIVE_MAX_TRIGGERS_DEFAULT,
  type VoiceV29ProactiveEvent,
  type VoiceV29ProactiveKind,
  type VoiceV29ProactiveTrigger,
} from './types';

export interface ProactiveAudioV29Options {
  /** Master switch (default false: opt-in). */
  enabled?: boolean;
  /** Quiet hours start (0–23, local hour). null = no quiet hours. */
  quietHoursStart?: number | null;
  /** Quiet hours end (0–23, local hour). null = no quiet hours. */
  quietHoursEnd?: number | null;
  /** Default cooldown between two firings of the same kind (ms). */
  defaultCooldownMs?: number;
  /** Max triggers kept (oldest fired dropped first). */
  maxTriggers?: number;
  /** Called when a trigger fires. */
  onFire?: (trigger: VoiceV29ProactiveTrigger) => void;
  /** Called when a trigger is suppressed (with the reason). */
  onSuppressed?: (event: VoiceV29ProactiveEvent) => void;
}

export interface VoiceV29ProactiveStats {
  enabled: boolean;
  triggers: number;
  pending: number;
  fired: number;
  suppressed: number;
  suppressedSpeaking: number;
  suppressedCooldown: number;
  suppressedConsent: number;
  suppressedQuietHours: number;
  lastFiredAtMs: number | null;
  lastFiredKind: VoiceV29ProactiveKind | null;
}

export interface VoiceV29QuietHours {
  start: number | null;
  end: number | null;
}

export function defaultProactiveAudioV29Options(): ProactiveAudioV29Options {
  return {
    enabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    defaultCooldownMs: VOICE_V29_PROACTIVE_COOLDOWN_DEFAULT_MS,
    maxTriggers: VOICE_V29_PROACTIVE_MAX_TRIGGERS_DEFAULT,
  };
}

let triggerCounter = 0;

export class ProactiveAudioV29 {
  private enabled: boolean;
  private quietStart: number | null;
  private quietEnd: number | null;
  private readonly defaultCooldownMs: number;
  private readonly maxTriggers: number;
  private readonly onFire?: (trigger: VoiceV29ProactiveTrigger) => void;
  private readonly onSuppressed?: (event: VoiceV29ProactiveEvent) => void;

  private readonly triggers = new Map<string, VoiceV29ProactiveTrigger>();
  private readonly order: string[] = [];
  private readonly events: VoiceV29ProactiveEvent[] = [];
  private readonly lastFiredByKind = new Map<VoiceV29ProactiveKind, number>();
  private fired = 0;
  private suppressedSpeaking = 0;
  private suppressedCooldown = 0;
  private suppressedConsent = 0;
  private suppressedQuietHours = 0;
  private lastFiredAtMs: number | null = null;
  private lastFiredKind: VoiceV29ProactiveKind | null = null;

  constructor(opts: ProactiveAudioV29Options = {}) {
    this.enabled = opts.enabled ?? false;
    this.quietStart = opts.quietHoursStart ?? null;
    this.quietEnd = opts.quietHoursEnd ?? null;
    this.defaultCooldownMs = opts.defaultCooldownMs ?? VOICE_V29_PROACTIVE_COOLDOWN_DEFAULT_MS;
    this.maxTriggers = opts.maxTriggers ?? VOICE_V29_PROACTIVE_MAX_TRIGGERS_DEFAULT;
    this.onFire = opts.onFire;
    this.onSuppressed = opts.onSuppressed;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Set quiet hours (local hours 0–23; both null clears them). */
  setQuietHours(start: number | null, end: number | null): void {
    if (start !== null && (!Number.isInteger(start) || start < 0 || start > 23)) {
      throw new Error('Quiet hours start must be an hour 0–23 or null');
    }
    if (end !== null && (!Number.isInteger(end) || end < 0 || end > 23)) {
      throw new Error('Quiet hours end must be an hour 0–23 or null');
    }
    this.quietStart = start;
    this.quietEnd = end;
  }

  getQuietHours(): VoiceV29QuietHours {
    return { start: this.quietStart, end: this.quietEnd };
  }

  /** True when `atMs` (as a wall-clock ms epoch) falls in quiet hours. */
  inQuietHours(atMs: number): boolean {
    if (this.quietStart === null || this.quietEnd === null) return false;
    const hour = new Date(atMs).getHours();
    if (this.quietStart === this.quietEnd) return false;
    if (this.quietStart < this.quietEnd) return hour >= this.quietStart && hour < this.quietEnd;
    return hour >= this.quietStart || hour < this.quietEnd;
  }

  /** Schedule a trigger. Returns the trigger (with its id). */
  schedule(
    kind: VoiceV29ProactiveKind,
    text: string,
    dueAtMs: number,
    opts: {
      priority?: number;
      cooldownMs?: number;
      repeat?: boolean;
      repeatMs?: number;
      createdAtMs?: number;
    } = {},
  ): VoiceV29ProactiveTrigger {
    if (!text.trim()) throw new Error('Proactive trigger text must not be empty');
    triggerCounter += 1;
    const trigger: VoiceV29ProactiveTrigger = {
      id: `pro-${triggerCounter}`,
      kind,
      text,
      dueAtMs,
      priority: opts.priority ?? 0,
      cooldownMs: opts.cooldownMs ?? this.defaultCooldownMs,
      fired: false,
      firedAtMs: null,
      repeat: opts.repeat ?? false,
      repeatMs: opts.repeatMs ?? 0,
      createdAtMs: opts.createdAtMs ?? dueAtMs,
    };
    this.triggers.set(trigger.id, trigger);
    this.order.push(trigger.id);
    this.pushEvent({ atMs: trigger.createdAtMs, kind: 'scheduled', triggerId: trigger.id, detail: `${kind} due at ${dueAtMs}ms` });
    this.enforceMaxTriggers();
    return { ...trigger };
  }

  /** Cancel a trigger before it fires (false when unknown / already fired). */
  cancel(triggerId: string, atMs: number): boolean {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || trigger.fired) return false;
    this.triggers.delete(triggerId);
    const idx = this.order.indexOf(triggerId);
    if (idx !== -1) this.order.splice(idx, 1);
    this.pushEvent({ atMs, kind: 'cancelled', triggerId, detail: `${trigger.kind} cancelled before firing` });
    return true;
  }

  get(triggerId: string): VoiceV29ProactiveTrigger | null {
    const found = this.triggers.get(triggerId);
    return found ? { ...found } : null;
  }

  list(): VoiceV29ProactiveTrigger[] {
    return this.order
      .map((id) => this.triggers.get(id))
      .filter((t): t is VoiceV29ProactiveTrigger => t !== undefined)
      .map((t) => ({ ...t }));
  }

  /** Triggers that are due at `atMs` and have not fired yet, highest priority first. */
  due(atMs: number): VoiceV29ProactiveTrigger[] {
    return this.list()
      .filter((t) => !t.fired && t.dueAtMs <= atMs)
      .sort((a, b) => b.priority - a.priority || a.dueAtMs - b.dueAtMs);
  }

  /**
   * Tick the scheduler at virtual time `atMs`. Fires at
   * most one trigger per tick (the highest-priority due
   * one) and reports what happened. `userSpeaking` /
   * `agentSpeaking` suppress firing without losing the
   * trigger — it stays due for the next tick.
   */
  tick(
    atMs: number,
    opts: { userSpeaking?: boolean; agentSpeaking?: boolean } = {},
  ): { fired: VoiceV29ProactiveTrigger | null; suppressed: VoiceV29ProactiveEvent[] } {
    const suppressed: VoiceV29ProactiveEvent[] = [];
    const due = this.due(atMs);
    if (due.length === 0) return { fired: null, suppressed };
    if (!this.enabled) {
      for (const t of due) {
        const event: VoiceV29ProactiveEvent = { atMs, kind: 'suppressed-consent', triggerId: t.id, detail: 'Proactive audio is disabled (opt-in)' };
        this.suppressedConsent += 1;
        this.pushEvent(event);
        suppressed.push(event);
        this.onSuppressed?.(event);
      }
      return { fired: null, suppressed };
    }
    if (this.inQuietHours(atMs)) {
      for (const t of due) {
        const event: VoiceV29ProactiveEvent = { atMs, kind: 'suppressed-quiet-hours', triggerId: t.id, detail: 'Inside quiet hours' };
        this.suppressedQuietHours += 1;
        this.pushEvent(event);
        suppressed.push(event);
        this.onSuppressed?.(event);
      }
      return { fired: null, suppressed };
    }
    if (opts.userSpeaking || opts.agentSpeaking) {
      for (const t of due) {
        const event: VoiceV29ProactiveEvent = {
          atMs,
          kind: 'suppressed-speaking',
          triggerId: t.id,
          detail: opts.userSpeaking ? 'User is speaking' : 'Agent is already speaking',
        };
        this.suppressedSpeaking += 1;
        this.pushEvent(event);
        suppressed.push(event);
        this.onSuppressed?.(event);
      }
      return { fired: null, suppressed };
    }
    const next = due[0];
    const lastFired = this.lastFiredByKind.get(next.kind);
    if (lastFired !== undefined && atMs - lastFired < next.cooldownMs) {
      const event: VoiceV29ProactiveEvent = {
        atMs,
        kind: 'suppressed-cooldown',
        triggerId: next.id,
        detail: `${next.kind} fired ${atMs - lastFired}ms ago, inside its ${next.cooldownMs}ms cooldown`,
      };
      this.suppressedCooldown += 1;
      this.pushEvent(event);
      suppressed.push(event);
      this.onSuppressed?.(event);
      return { fired: null, suppressed };
    }
    next.fired = true;
    next.firedAtMs = atMs;
    this.fired += 1;
    this.lastFiredAtMs = atMs;
    this.lastFiredKind = next.kind;
    this.lastFiredByKind.set(next.kind, atMs);
    this.pushEvent({ atMs, kind: 'fired', triggerId: next.id, detail: `${next.kind}: "${next.text.slice(0, 80)}"` });
    if (next.repeat && next.repeatMs > 0) {
      // Repeating triggers reschedule themselves instead of dying.
      next.fired = false;
      next.firedAtMs = null;
      next.dueAtMs = atMs + next.repeatMs;
    }
    this.onFire?.({ ...next });
    return { fired: { ...next }, suppressed };
  }

  eventsSoFar(): VoiceV29ProactiveEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  stats(): VoiceV29ProactiveStats {
    const all = this.list();
    return {
      enabled: this.enabled,
      triggers: all.length,
      pending: all.filter((t) => !t.fired).length,
      fired: this.fired,
      suppressed: this.suppressedSpeaking + this.suppressedCooldown + this.suppressedConsent + this.suppressedQuietHours,
      suppressedSpeaking: this.suppressedSpeaking,
      suppressedCooldown: this.suppressedCooldown,
      suppressedConsent: this.suppressedConsent,
      suppressedQuietHours: this.suppressedQuietHours,
      lastFiredAtMs: this.lastFiredAtMs,
      lastFiredKind: this.lastFiredKind,
    };
  }

  private pushEvent(event: VoiceV29ProactiveEvent): void {
    this.events.push(event);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  private enforceMaxTriggers(): void {
    while (this.order.length > this.maxTriggers) {
      // Drop the oldest *fired* trigger first; pending ones are kept.
      const firedIdx = this.order.findIndex((id) => this.triggers.get(id)?.fired === true);
      if (firedIdx === -1) break;
      const dropId = this.order[firedIdx];
      this.order.splice(firedIdx, 1);
      this.triggers.delete(dropId);
    }
  }
}

export function createProactiveAudioV29(opts: ProactiveAudioV29Options = {}): ProactiveAudioV29 {
  return new ProactiveAudioV29(opts);
}
