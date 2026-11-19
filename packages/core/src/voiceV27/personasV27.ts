/**
 * Multi-voice personas (voice v27).
 *
 * v26 owns providers: the *engines* that speak (local, system,
 * API-key, mock). v27 owns personas: the *characters* layered on
 * top of an engine. A persona is a voice name + rate + pitch +
 * language + style tags — "Calm", "Energetic", "Formal", the
 * Vietnamese "Ấm áp" — not an engine, so switching persona
 * never re-provisions a provider, it just retunes the voice
 * the next reply is spoken with.
 *
 *   - builtin personas ship with the module (8, English +
 *     Vietnamese, mock voices — no engine, no sound card);
 *   - custom personas can be registered per user (validated:
 *     id shape, rate 0.5..2, pitch -12..12, at least one style);
 *   - one persona is remembered per bot (`assign`), survives
 *     in the assignment map, and can be switched mid-session
 *     (`switchPersona` records the switch, including whether
 *     it happened while the agent was speaking);
 *   - `preview` returns a mock synthesis descriptor (sample
 *     text + estimated duration) — no audio is ever produced;
 *   - `fallbackFor` orders personas for a language/style so a
 *     missing voice degrades to the closest character instead
 *     of failing the reply.
 *
 * Assignments are plain JSON and can be serialised / restored
 * (the session store persists the active persona id per
 * session; the registry persists the per-bot assignment).
 */
import {
  VOICE_V27_BUILTIN_PERSONAS,
  isValidVoiceV27Id,
  type VoiceV27PersonaAssignment,
  type VoiceV27PersonaDef,
  type VoiceV27PersonaPreview,
  type VoiceV27PersonaStyle,
} from './types';

export interface PersonaRegistryV27Options {
  /** Extra personas registered at construction (in addition to builtins). */
  extraPersonas?: VoiceV27PersonaDef[];
  /** Default persona id when a bot has no assignment (default 'v27-friendly'). */
  defaultPersonaId: string;
  /** Max custom personas kept (builtins never count). */
  maxCustomPersonas: number;
}

export function defaultPersonaRegistryV27Options(): PersonaRegistryV27Options {
  return {
    extraPersonas: [],
    defaultPersonaId: 'v27-friendly',
    maxCustomPersonas: 100,
  };
}

export function validatePersonaDefV27(def: Partial<VoiceV27PersonaDef>): string[] {
  const errors: string[] = [];
  if (typeof def.id !== 'string' || !isValidVoiceV27Id(def.id)) {
    errors.push('id must match /^[a-z0-9][a-z0-9_-]{0,63}$/');
  }
  if (typeof def.name !== 'string' || def.name.trim() === '') errors.push('name must be a non-empty string');
  if (typeof def.language !== 'string' || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(def.language)) {
    errors.push('language must be a BCP-47 tag like "en" or "vi"');
  }
  if (typeof def.voice !== 'string' || def.voice.trim() === '') errors.push('voice must be a non-empty string');
  if (typeof def.rate !== 'number' || !Number.isFinite(def.rate) || def.rate < 0.5 || def.rate > 2) {
    errors.push('rate must be 0.5..2');
  }
  if (typeof def.pitch !== 'number' || !Number.isFinite(def.pitch) || def.pitch < -12 || def.pitch > 12) {
    errors.push('pitch must be -12..12 semitones');
  }
  const styles: readonly string[] = [
    'calm', 'energetic', 'formal', 'friendly', 'concise', 'warm', 'storyteller', 'professional',
  ];
  if (!Array.isArray(def.styles) || def.styles.length === 0 || def.styles.some((s) => !styles.includes(s))) {
    errors.push(`styles must be a non-empty array of: ${styles.join(', ')}`);
  }
  if (typeof def.description !== 'string') errors.push('description must be a string');
  return errors;
}

export interface VoiceV27PersonaStats {
  personas: number;
  builtin: number;
  custom: number;
  assignments: number;
  switches: number;
  midSessionSwitches: number;
  languages: string[];
  defaultPersonaId: string;
}

export interface VoiceV27PersonaSwitchResult {
  botId: string;
  previousPersonaId: string | null;
  currentPersonaId: string;
  switchedAtMs: number;
  midSession: boolean;
  switches: number;
}

export function createPersonaRegistryV27(
  opts: Partial<PersonaRegistryV27Options> = {},
): PersonaRegistryV27 {
  return new PersonaRegistryV27(opts);
}

export class PersonaRegistryV27 {
  private personas = new Map<string, VoiceV27PersonaDef>();
  private assignments = new Map<string, VoiceV27PersonaAssignment>();
  private defaultPersonaId: string;
  private readonly maxCustomPersonas: number;
  private switches = 0;
  private midSessionSwitches = 0;

  constructor(opts: Partial<PersonaRegistryV27Options> = {}) {
    const defaults = defaultPersonaRegistryV27Options();
    this.defaultPersonaId = opts.defaultPersonaId ?? defaults.defaultPersonaId;
    this.maxCustomPersonas = opts.maxCustomPersonas ?? defaults.maxCustomPersonas;
    for (const p of VOICE_V27_BUILTIN_PERSONAS) this.personas.set(p.id, { ...p, styles: [...p.styles] });
    for (const extra of opts.extraPersonas ?? []) {
      const errors = validatePersonaDefV27(extra);
      if (errors.length > 0) throw new Error(`Invalid persona: ${errors.join('; ')}`);
      this.personas.set(extra.id, { ...extra, styles: [...extra.styles] });
    }
    if (!this.personas.has(this.defaultPersonaId)) {
      throw new Error(`defaultPersonaId "${this.defaultPersonaId}" is not a known persona`);
    }
  }

  defaultPersonaIdNow(): string {
    return this.defaultPersonaId;
  }

  list(filter: {
    language?: string | null;
    style?: VoiceV27PersonaStyle | null;
    builtin?: boolean | null;
  } = {}): VoiceV27PersonaDef[] {
    return [...this.personas.values()]
      .filter((p) => (filter.language === undefined || filter.language === null || p.language === filter.language))
      .filter((p) => (filter.style === undefined || filter.style === null || p.styles.includes(filter.style)))
      .filter((p) => (filter.builtin === undefined || filter.builtin === null || p.builtin === filter.builtin))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({ ...p, styles: [...p.styles] }));
  }

  get(personaId: string): VoiceV27PersonaDef | null {
    const found = this.personas.get(personaId);
    return found === undefined ? null : { ...found, styles: [...found.styles] };
  }

  has(personaId: string): boolean {
    return this.personas.has(personaId);
  }

  register(def: VoiceV27PersonaDef): VoiceV27PersonaDef {
    const errors = validatePersonaDefV27(def);
    if (errors.length > 0) throw new Error(`Invalid persona: ${errors.join('; ')}`);
    const existing = this.personas.get(def.id);
    if (existing?.builtin) throw new Error(`Cannot overwrite builtin persona "${def.id}"`);
    if (!existing) {
      const customCount = [...this.personas.values()].filter((p) => !p.builtin).length;
      if (customCount >= this.maxCustomPersonas) throw new Error(`Custom persona limit reached (${this.maxCustomPersonas})`);
    }
    this.personas.set(def.id, { ...def, styles: [...def.styles], builtin: false });
    return this.get(def.id) as VoiceV27PersonaDef;
  }

  /** Remove a custom persona (builtins are protected). */
  remove(personaId: string): boolean {
    const existing = this.personas.get(personaId);
    if (!existing || existing.builtin) return false;
    // Bots assigned to the removed persona fall back to default.
    for (const [botId, assignment] of this.assignments) {
      if (assignment.personaId === personaId) {
        this.assignments.set(botId, { ...assignment, personaId: this.defaultPersonaId });
      }
    }
    return this.personas.delete(personaId);
  }

  /** Remember a persona for a bot (creates or overwrites the assignment). */
  assign(botId: string, personaId: string, atMs: number): VoiceV27PersonaAssignment {
    if (typeof botId !== 'string' || botId === '') throw new Error('botId must be a non-empty string');
    if (!this.personas.has(personaId)) throw new Error(`Unknown persona: "${personaId}"`);
    const previous = this.assignments.get(botId);
    const assignment: VoiceV27PersonaAssignment = {
      botId,
      personaId,
      assignedAtMs: previous?.assignedAtMs ?? atMs,
      lastSwitchedAtMs: previous?.lastSwitchedAtMs ?? null,
      switches: previous?.switches ?? 0,
      midSessionSwitches: previous?.midSessionSwitches ?? 0,
    };
    this.assignments.set(botId, assignment);
    return { ...assignment };
  }

  assignmentFor(botId: string): VoiceV27PersonaAssignment | null {
    const found = this.assignments.get(botId);
    return found === undefined ? null : { ...found };
  }

  /** The persona a bot speaks with (assigned one, else the default). */
  personaFor(botId: string): VoiceV27PersonaDef {
    const assignment = this.assignments.get(botId);
    const persona = assignment !== undefined ? this.personas.get(assignment.personaId) : undefined;
    return { ...(persona ?? this.personas.get(this.defaultPersonaId) as VoiceV27PersonaDef), styles: [...(persona ?? this.personas.get(this.defaultPersonaId) as VoiceV27PersonaDef).styles] };
  }

  /**
   * Switch a bot's persona mid-conversation. `midSession`
   * records whether the agent was speaking when it switched.
   */
  switchPersona(
    botId: string,
    personaId: string,
    input: { atMs: number; midSession?: boolean },
  ): VoiceV27PersonaSwitchResult {
    if (!this.personas.has(personaId)) throw new Error(`Unknown persona: "${personaId}"`);
    const previous = this.assignments.get(botId);
    const previousPersonaId = previous?.personaId ?? null;
    const assignment: VoiceV27PersonaAssignment = {
      botId,
      personaId,
      assignedAtMs: previous?.assignedAtMs ?? input.atMs,
      lastSwitchedAtMs: input.atMs,
      switches: (previous?.switches ?? 0) + 1,
      midSessionSwitches: (previous?.midSessionSwitches ?? 0) + (input.midSession === true ? 1 : 0),
    };
    this.assignments.set(botId, assignment);
    this.switches += 1;
    if (input.midSession === true) this.midSessionSwitches += 1;
    return {
      botId,
      previousPersonaId,
      currentPersonaId: personaId,
      switchedAtMs: input.atMs,
      midSession: input.midSession ?? false,
      switches: assignment.switches,
    };
  }

  /** Mock preview: sample text + estimated duration, no audio. */
  preview(personaId: string, text: string): VoiceV27PersonaPreview {
    const persona = this.personas.get(personaId);
    if (!persona) throw new Error(`Unknown persona: "${personaId}"`);
    if (typeof text !== 'string' || text === '') throw new Error('text must be a non-empty string');
    // ~800 chars per minute at rate 1, scaled by the persona rate.
    const charsPerMinute = 800 * persona.rate;
    const durationEstimateMs = Math.max(200, Math.round((text.length / charsPerMinute) * 60_000));
    return {
      personaId,
      voice: persona.voice,
      rate: persona.rate,
      pitch: persona.pitch,
      language: persona.language,
      sampleText: text,
      durationEstimateMs,
      mock: true,
    };
  }

  /**
   * Order personas for a language/style: exact language first,
   * then matching style, then the default. Never throws — an
   * empty registry still yields the default.
   */
  fallbackFor(input: { language?: string | null; style?: VoiceV27PersonaStyle | null }): VoiceV27PersonaDef[] {
    const all = this.list();
    const score = (p: VoiceV27PersonaDef): number => {
      let s = 0;
      if (input.language !== undefined && input.language !== null && p.language === input.language) s += 10;
      if (input.style !== undefined && input.style !== null && p.styles.includes(input.style)) s += 5;
      if (p.id === this.defaultPersonaId) s += 1;
      if (p.builtin) s += 0.5;
      return s;
    };
    return all
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
      .map((p) => ({ ...p, styles: [...p.styles] }));
  }

  assignmentsList(): VoiceV27PersonaAssignment[] {
    return [...this.assignments.values()]
      .sort((a, b) => a.botId.localeCompare(b.botId))
      .map((a) => ({ ...a }));
  }

  /** Plain-JSON assignments (for the durable session store). */
  serializeAssignments(): VoiceV27PersonaAssignment[] {
    return this.assignmentsList();
  }

  restoreAssignments(assignments: readonly VoiceV27PersonaAssignment[]): number {
    let restored = 0;
    for (const a of assignments) {
      if (typeof a.botId !== 'string' || a.botId === '') continue;
      if (!this.personas.has(a.personaId)) continue;
      this.assignments.set(a.botId, { ...a });
      restored += 1;
    }
    return restored;
  }

  stats(): VoiceV27PersonaStats {
    const languages = [...new Set([...this.personas.values()].map((p) => p.language))].sort();
    return {
      personas: this.personas.size,
      builtin: [...this.personas.values()].filter((p) => p.builtin).length,
      custom: [...this.personas.values()].filter((p) => !p.builtin).length,
      assignments: this.assignments.size,
      switches: this.switches,
      midSessionSwitches: this.midSessionSwitches,
      languages,
      defaultPersonaId: this.defaultPersonaId,
    };
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Voice personas v27',
      '',
      `- Personas: ${s.personas} (${s.builtin} builtin, ${s.custom} custom) · languages: ${s.languages.join(', ') || '-'}`,
      `- Assignments: ${s.assignments} bots · switches: ${s.switches} (${s.midSessionSwitches} mid-session) · default: ${s.defaultPersonaId}`,
      '',
      '| id | name | language | voice | rate | pitch | styles |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const p of this.list()) {
      lines.push(`| ${p.id} | ${p.name} | ${p.language} | ${p.voice} | ${p.rate} | ${p.pitch} | ${p.styles.join(', ')} |`);
    }
    if (this.assignments.size > 0) {
      lines.push('', '| bot | persona | switches | mid-session |', '| --- | --- | --- | --- |');
      for (const a of this.assignmentsList()) {
        lines.push(`| ${a.botId} | ${a.personaId} | ${a.switches} | ${a.midSessionSwitches} |`);
      }
    }
    return lines.join('\n');
  }

  reset(): void {
    this.assignments.clear();
    this.switches = 0;
    this.midSessionSwitches = 0;
    for (const id of [...this.personas.keys()]) {
      const p = this.personas.get(id);
      if (p !== undefined && !p.builtin) this.personas.delete(id);
    }
  }
}
