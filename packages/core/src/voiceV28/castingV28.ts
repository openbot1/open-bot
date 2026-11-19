/**
 * Multi-voice casting v28 (v1.41, Team T5).
 *
 * One bot can speak in several voices, one per role:
 * narrator (long-form reading / stories), assistant (the
 * everyday reply voice), announcer (short alerts / status)
 * and alert (urgent, attention-grabbing). A cast is a
 * per-bot table role -> voiceId, with a fallback chain per
 * role: when the assigned voice is unavailable the next
 * voice in the chain speaks instead, and the fallback is
 * recorded (never silent, never an error to the user).
 *
 * Switching a role mid-session is allowed and audited
 * (switch events with from/to/reason); the session reads
 * the cast through `voiceFor(role)` every turn, so a
 * switch takes effect on the next turn, not the next
 * session.
 *
 * Voice availability is caller-supplied (`isAvailable`):
 * the casting layer never dials a provider — the host
 * tells it which mock/provider voices exist right now.
 * When no voice is available at all for a role, the
 * builtin mock voice for that role speaks.
 */

import {
  clampV28,
  type VoiceV28CastAssignment,
  type VoiceV28CastRole,
  type VoiceV28CastSwitchEvent,
} from './types';

/** Builtin mock voice per role (always available). */
export const VOICE_V28_CAST_DEFAULT_VOICES: Record<VoiceV28CastRole, string> = {
  narrator: 'mock-narrator',
  assistant: 'mock-default',
  announcer: 'mock-announcer',
  alert: 'mock-alert',
};

/** Default fallback chain per role (tried in order after the assigned voice). */
export const VOICE_V28_CAST_FALLBACK_CHAINS: Record<VoiceV28CastRole, string[]> = {
  narrator: ['mock-storyteller', 'mock-default', 'mock-narrator'],
  assistant: ['mock-default', 'mock-friendly', 'mock-narrator'],
  announcer: ['mock-formal', 'mock-default', 'mock-announcer'],
  alert: ['mock-energetic', 'mock-default', 'mock-alert'],
};

export const VOICE_V28_CAST_ROLES: readonly VoiceV28CastRole[] = [
  'narrator',
  'assistant',
  'announcer',
  'alert',
];

export interface VoiceCastingV28Options {
  /** Which voices exist right now (default: everything is available). */
  isAvailable?: (voiceId: string) => boolean;
  /** Max switch events kept per bot. */
  maxEventsPerBot?: number;
  /** Custom fallback chains (merged over the defaults). */
  fallbackChains?: Partial<Record<VoiceV28CastRole, string[]>>;
}

export interface VoiceV28CastSnapshot {
  botId: string;
  roles: Record<VoiceV28CastRole, { voiceId: string; fallbackUsed: boolean; assignedAtMs: number | null; switches: number }>;
  switchEvents: VoiceV28CastSwitchEvent[];
}

export interface VoiceV28CastResolve {
  role: VoiceV28CastRole;
  voiceId: string;
  /** True when the assigned voice was unavailable and a fallback spoke. */
  fallbackUsed: boolean;
  /** The assigned voice (null = no assignment, builtin default spoke). */
  assignedVoiceId: string | null;
  /** Why this voice was chosen, in plain words. */
  reason: string;
}

export function defaultVoiceCastingV28Options(): VoiceCastingV28Options {
  return { maxEventsPerBot: 200 };
}

export function createVoiceCastingV28(opts: VoiceCastingV28Options = {}): VoiceCastingV28 {
  return new VoiceCastingV28(opts);
}

export class VoiceCastingV28 {
  private readonly isAvailable: (voiceId: string) => boolean;
  private readonly maxEventsPerBot: number;
  private readonly fallbackChains: Record<VoiceV28CastRole, string[]>;
  /** botId -> role -> assignment. */
  private casts = new Map<string, Map<VoiceV28CastRole, VoiceV28CastAssignment>>();
  /** botId -> switch events. */
  private events = new Map<string, VoiceV28CastSwitchEvent[]>();

  constructor(opts: VoiceCastingV28Options = {}) {
    this.isAvailable = opts.isAvailable ?? (() => true);
    this.maxEventsPerBot = Math.max(1, opts.maxEventsPerBot ?? 200);
    this.fallbackChains = {
      narrator: [...(opts.fallbackChains?.narrator ?? VOICE_V28_CAST_FALLBACK_CHAINS.narrator)],
      assistant: [...(opts.fallbackChains?.assistant ?? VOICE_V28_CAST_FALLBACK_CHAINS.assistant)],
      announcer: [...(opts.fallbackChains?.announcer ?? VOICE_V28_CAST_FALLBACK_CHAINS.announcer)],
      alert: [...(opts.fallbackChains?.alert ?? VOICE_V28_CAST_FALLBACK_CHAINS.alert)],
    };
  }

  /** Assign a voice to a role for a bot (creates the bot's cast on first use). */
  assign(
    botId: string,
    role: VoiceV28CastRole,
    voiceId: string,
    atMs: number,
    reason = 'assign',
  ): VoiceV28CastAssignment {
    this.assertBotId(botId);
    this.assertRole(role);
    this.assertVoiceId(voiceId);
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('assign atMs must be >= 0');
    const cast = this.castFor(botId);
    const prev = cast.get(role);
    if (prev && prev.voiceId === voiceId) return { ...prev };
    const assignment: VoiceV28CastAssignment = {
      botId,
      role,
      voiceId,
      assignedAtMs: prev ? prev.assignedAtMs : atMs,
      lastSwitchedAtMs: prev ? atMs : null,
      switches: (prev?.switches ?? 0) + (prev ? 1 : 0),
    };
    cast.set(role, assignment);
    this.recordEvent(botId, {
      atMs,
      botId,
      role,
      fromVoiceId: prev?.voiceId ?? null,
      toVoiceId: voiceId,
      reason,
    });
    return { ...assignment };
  }

  /** Switch a role to another voice mid-session (same as assign, audited as a switch). */
  switchRole(
    botId: string,
    role: VoiceV28CastRole,
    voiceId: string,
    atMs: number,
    reason = 'switch',
  ): VoiceV28CastAssignment {
    return this.assign(botId, role, voiceId, atMs, reason);
  }

  /** Remove one role assignment (the builtin default speaks afterwards). */
  unassign(botId: string, role: VoiceV28CastRole, atMs: number): boolean {
    this.assertBotId(botId);
    this.assertRole(role);
    const cast = this.casts.get(botId);
    if (!cast || !cast.has(role)) return false;
    const prev = cast.get(role)!;
    cast.delete(role);
    this.recordEvent(botId, {
      atMs,
      botId,
      role,
      fromVoiceId: prev.voiceId,
      toVoiceId: VOICE_V28_CAST_DEFAULT_VOICES[role],
      reason: 'unassign',
    });
    return true;
  }

  /** Resolve the voice that should speak a role right now (with fallback). */
  voiceFor(botId: string, role: VoiceV28CastRole): VoiceV28CastResolve {
    this.assertBotId(botId);
    this.assertRole(role);
    const assigned = this.casts.get(botId)?.get(role)?.voiceId ?? null;
    if (assigned && this.isAvailable(assigned)) {
      return { role, voiceId: assigned, fallbackUsed: false, assignedVoiceId: assigned, reason: 'assigned voice available' };
    }
    for (const candidate of this.fallbackChains[role]) {
      if (this.isAvailable(candidate)) {
        return {
          role,
          voiceId: candidate,
          fallbackUsed: true,
          assignedVoiceId: assigned,
          reason: assigned
            ? `assigned voice ${assigned} unavailable, fallback ${candidate}`
            : `no assignment, fallback ${candidate}`,
        };
      }
    }
    const builtin = VOICE_V28_CAST_DEFAULT_VOICES[role];
    return {
      role,
      voiceId: builtin,
      fallbackUsed: assigned !== null,
      assignedVoiceId: assigned,
      reason: 'no available voice in chain, builtin default',
    };
  }

  /** Resolve every role for a bot at once. */
  castForBot(botId: string): Record<VoiceV28CastRole, VoiceV28CastResolve> {
    this.assertBotId(botId);
    return {
      narrator: this.voiceFor(botId, 'narrator'),
      assistant: this.voiceFor(botId, 'assistant'),
      announcer: this.voiceFor(botId, 'announcer'),
      alert: this.voiceFor(botId, 'alert'),
    };
  }

  /** The bot's current assignments (roles without one are absent). */
  assignments(botId: string): VoiceV28CastAssignment[] {
    this.assertBotId(botId);
    const cast = this.casts.get(botId);
    if (!cast) return [];
    return [...cast.values()].map((a) => ({ ...a }));
  }

  /** Assignment for one role (null when unassigned). */
  assignmentFor(botId: string, role: VoiceV28CastRole): VoiceV28CastAssignment | null {
    this.assertBotId(botId);
    this.assertRole(role);
    const found = this.casts.get(botId)?.get(role);
    return found ? { ...found } : null;
  }

  /** Snapshot of a bot's whole cast (assignments + switch history). */
  snapshot(botId: string): VoiceV28CastSnapshot {
    this.assertBotId(botId);
    const resolved = this.castForBot(botId);
    const assignments = this.casts.get(botId);
    const roles = {} as VoiceV28CastSnapshot['roles'];
    for (const role of VOICE_V28_CAST_ROLES) {
      const a = assignments?.get(role);
      roles[role] = {
        voiceId: resolved[role].voiceId,
        fallbackUsed: resolved[role].fallbackUsed,
        assignedAtMs: a?.assignedAtMs ?? null,
        switches: a?.switches ?? 0,
      };
    }
    return { botId, roles, switchEvents: this.switchEvents(botId) };
  }

  /** Switch history for a bot (oldest first). */
  switchEvents(botId: string): VoiceV28CastSwitchEvent[] {
    this.assertBotId(botId);
    return [...(this.events.get(botId) ?? [])];
  }

  /** All bot ids that have a cast. */
  botIds(): string[] {
    return [...this.casts.keys()];
  }

  /** Remove a bot's whole cast (assignments + history). */
  removeBot(botId: string): boolean {
    this.assertBotId(botId);
    const hadCast = this.casts.delete(botId);
    const hadEvents = this.events.delete(botId);
    return hadCast || hadEvents;
  }

  /** Copy one bot's cast to another bot (fresh timestamps, switches reset). */
  cloneCast(fromBotId: string, toBotId: string, atMs: number): VoiceV28CastAssignment[] {
    this.assertBotId(fromBotId);
    this.assertBotId(toBotId);
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('cloneCast atMs must be >= 0');
    const source = this.casts.get(fromBotId);
    if (!source || source.size === 0) return [];
    const out: VoiceV28CastAssignment[] = [];
    for (const assignment of source.values()) {
      out.push(this.assign(toBotId, assignment.role, assignment.voiceId, atMs, `cloned from ${fromBotId}`));
    }
    return out;
  }

  private castFor(botId: string): Map<VoiceV28CastRole, VoiceV28CastAssignment> {
    let cast = this.casts.get(botId);
    if (!cast) {
      cast = new Map();
      this.casts.set(botId, cast);
    }
    return cast;
  }

  private recordEvent(botId: string, event: VoiceV28CastSwitchEvent): void {
    let list = this.events.get(botId);
    if (!list) {
      list = [];
      this.events.set(botId, list);
    }
    list.push(event);
    if (list.length > this.maxEventsPerBot) list.shift();
  }

  private assertBotId(botId: string): void {
    if (typeof botId !== 'string' || botId.trim() === '') {
      throw new Error('botId must be a non-empty string');
    }
  }

  private assertRole(role: string): void {
    if (!(VOICE_V28_CAST_ROLES as readonly string[]).includes(role)) {
      throw new Error(`unknown cast role: ${role}`);
    }
  }

  private assertVoiceId(voiceId: string): void {
    if (typeof voiceId !== 'string' || voiceId.trim() === '') {
      throw new Error('voiceId must be a non-empty string');
    }
    if (voiceId.length > 80) throw new Error('voiceId is too long (max 80)');
  }
}

/** Clamp helper re-export for the tools layer (rate/pitch adjustments). */
export function clampRateV28(rate: number): number {
  return clampV28(rate, 0.5, 2);
}
