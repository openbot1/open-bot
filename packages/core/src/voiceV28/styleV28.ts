/**
 * Memory-block voice style v28 (v1.41, Team T5).
 *
 * Reads the `persona` block (who the bot is, how it talks)
 * and the `human` block (who the user is, how to address
 * them) and turns them into a voice config: rate, pitch,
 * speaking-style preset, language, greeting, address form.
 * When a block changes, the config is re-derived and every
 * subscriber is notified — so a voice session that listens
 * to the bridge always speaks the way the memory says it
 * should. When no block exists, the default preset applies.
 *
 * The idea (a block in the main context that the agent
 * curates, `human` + `persona` as the standard labels) is
 * learned from Letta's memory blocks (survey §2); the
 * parsing below is our own design, built for open-bot's
 * `MemoryBlockStore` shape (`label` / `content` /
 * `version`, see packages/core/src/memory/blocks.ts).
 *
 * Parsing is keyword-driven and deliberately conservative:
 *   - style: looks for style words in the persona block
 *     (formal / trang trọng, intimate / thân mật, concise /
 *     ngắn gọn, storyteller / kể chuyện) in either English
 *     or Vietnamese; first match wins, ties break towards
 *     the earliest word in the text;
 *   - pace: "nói nhanh / fast / nhanh" speeds up, "nói chậm
 *     / slow / chậm" slows down, "nói rất nhanh" pushes
 *     further; explicit `rate: 1.2` / `tốc độ: 1.2` numbers
 *     win over words;
 *   - pitch: explicit `pitch: -2` / `cao độ: 2` numbers win;
 *     "giọng cao / high voice" lifts, "giọng trầm / low
 *     voice" lowers;
 *   - language: "tiếng việt / vietnamese / vi" -> vi,
 *     "english / tiếng anh" -> en; defaults to the human
 *     block's language hint, else en;
 *   - address form: the human block's xưng hô — "xưng hô:
 *     anh", "gọi tôi là anh", "call me ..." — first match
 *     wins; Vietnamese pronouns (anh / chị / em / bạn /
 *     cô / chú / bác) are recognised, else "you";
 *   - name: "tên tôi là X" / "tên: X" / "my name is X" /
 *     "call me X".
 *
 * The bridge never writes to the block store and never
 * touches the network. The caller supplies a
 * `VoiceV28BlockSource` (usually a thin adapter over
 * `MemoryBlockStore`); `refresh()` re-reads the two labels
 * and reports what changed. `subscribe()` registers a
 * listener called with the new config whenever a refresh
 * actually changes it.
 */

import {
  clampV28,
  defaultVoiceConfigV28,
  greetingTemplateV28,
  round2V28,
  stylePresetV28,
  type VoiceV28BlockChange,
  type VoiceV28BlockSource,
  type VoiceV28MemoryBlockView,
  type VoiceV28SpeakingStyle,
  type VoiceV28StyleRefreshResult,
  type VoiceV28VoiceConfig,
} from './types';

/** Vietnamese address pronouns recognised from the human block. */
export const VOICE_V28_ADDRESS_FORMS_VI = [
  'anh',
  'chị',
  'em',
  'bạn',
  'cô',
  'chú',
  'bác',
  'thầy',
  'cô giáo',
] as const;

/** Style keywords, earliest match in the text wins. */
const STYLE_KEYWORDS: { style: VoiceV28SpeakingStyle; words: string[] }[] = [
  { style: 'formal', words: ['trang trọng', 'formal', 'lịch sự', 'nghiêm túc', 'professional'] },
  { style: 'intimate', words: ['thân mật', 'intimate', 'gần gũi', 'thân thiết', 'ấm áp'] },
  { style: 'concise', words: ['ngắn gọn', 'concise', 'súc tích', 'ngắn', 'brief', 'to the point'] },
  { style: 'storyteller', words: ['kể chuyện', 'storyteller', 'kể truyện', 'narrative', 'story'] },
];

const FAST_WORDS = ['nói rất nhanh', 'rất nhanh', 'very fast', 'nói nhanh', 'fast', 'nhanh'];
const SLOW_WORDS = ['nói rất chậm', 'rất chậm', 'very slow', 'nói chậm', 'slow', 'chậm', 'từ tốn'];
const HIGH_PITCH_WORDS = ['giọng cao', 'high voice', 'high pitch', 'giọng the thé'];
const LOW_PITCH_WORDS = ['giọng trầm', 'low voice', 'low pitch', 'giọng thấp'];

/** Find the earliest occurrence of any word in `text` (lowercased). */
function earliestMatch(text: string, words: readonly string[]): { word: string; index: number } | null {
  let best: { word: string; index: number } | null = null;
  for (const word of words) {
    const idx = text.indexOf(word);
    if (idx !== -1 && (best === null || idx < best.index)) best = { word, index: idx };
  }
  return best;
}

/** Detect the speaking style from persona text (null = no hint). */
export function detectStyleFromPersonaV28(personaText: string): VoiceV28SpeakingStyle | null {
  const text = (personaText ?? '').toLowerCase();
  if (!text.trim()) return null;
  let best: { style: VoiceV28SpeakingStyle; index: number } | null = null;
  for (const entry of STYLE_KEYWORDS) {
    const hit = earliestMatch(text, entry.words);
    if (hit && (best === null || hit.index < best.index)) {
      best = { style: entry.style, index: hit.index };
    }
  }
  return best?.style ?? null;
}

/** Detect language from block text ('vi' | 'en' | null). */
export function detectLanguageV28(text: string): 'vi' | 'en' | null {
  const lower = (text ?? '').toLowerCase();
  const viHit = earliestMatch(lower, ['tiếng việt', 'vietnamese', 'ngôn ngữ: vi', 'language: vi']);
  const enHit = earliestMatch(lower, ['tiếng anh', 'english', 'ngôn ngữ: en', 'language: en']);
  if (viHit && (!enHit || viHit.index <= enHit.index)) return 'vi';
  if (enHit) return 'en';
  // Heuristic: Vietnamese diacritics strongly suggest vi.
  if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/.test(lower)) return 'vi';
  return null;
}

/** Parse an explicit `rate:` / `tốc độ:` number from text (null = absent). */
export function parseRateHintV28(text: string): number | null {
  const lower = (text ?? '').toLowerCase();
  const m = lower.match(/(?:rate|tốc độ|toc do)\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  return clampV28(value, 0.5, 2);
}

/** Parse an explicit `pitch:` / `cao độ:` number from text (null = absent). */
export function parsePitchHintV28(text: string): number | null {
  const lower = (text ?? '').toLowerCase();
  const m = lower.match(/(?:pitch|cao độ|cao do)\s*[:=]\s*(-?[0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  return clampV28(value, -12, 12);
}

/** Parse an explicit `voice:` / `giọng:` name from text (null = absent). */
export function parseVoiceHintV28(text: string): string | null {
  const lower = (text ?? '').toLowerCase();
  const m = lower.match(/(?:voice|giọng)\s*[:=]\s*([a-z0-9][a-z0-9_-]{0,63})/);
  if (!m) return null;
  return m[1];
}

/** Detect how to address the user from the human block. */
export function detectAddressFormV28(humanText: string): string {
  const lower = (humanText ?? '').toLowerCase();
  if (!lower.trim()) return 'you';
  const explicit = lower.match(/(?:xưng hô|gọi tôi là|call me|address me as)\s*[: ]\s*([a-zà-ỹ]+)/);
  if (explicit) {
    const form = explicit[1].trim();
    if (form.length > 0 && form.length <= 20) return form;
  }
  const hit = earliestMatch(lower, VOICE_V28_ADDRESS_FORMS_VI);
  if (hit) return hit.word;
  return 'you';
}

/** Detect the user's name from the human block ('' = unknown). */
export function detectUserNameV28(humanText: string): string {
  const text = humanText ?? '';
  const patterns = [
    /(?:tên tôi là|tên là|tên:|my name is|call me)\s+([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ' -]{0,40})/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const name = m[1].trim().replace(/[.,;]+$/, '');
      if (name.length > 0 && name.length <= 40) return name;
    }
  }
  return '';
}

/** Derive a full voice config from the two memory blocks. */
export function deriveVoiceConfigV28(
  persona: VoiceV28MemoryBlockView | null,
  human: VoiceV28MemoryBlockView | null,
  fallback: VoiceV28VoiceConfig = defaultVoiceConfigV28(),
): VoiceV28VoiceConfig {
  const personaText = persona?.content ?? '';
  const humanText = human?.content ?? '';
  const style = detectStyleFromPersonaV28(personaText) ?? fallback.style;
  const preset = stylePresetV28(style) ?? stylePresetV28('default')!;
  const language =
    detectLanguageV28(personaText) ?? detectLanguageV28(humanText) ?? fallback.language;
  const rateHint = parseRateHintV28(personaText) ?? parseRateHintV28(humanText);
  const pitchHint = parsePitchHintV28(personaText) ?? parsePitchHintV28(humanText);
  const voiceHint = parseVoiceHintV28(personaText);
  let rate = rateHint ?? preset.rate;
  let pitch = pitchHint ?? preset.pitch;
  if (rateHint === null) {
    if (earliestMatch(personaText.toLowerCase(), FAST_WORDS)) rate = clampV28(preset.rate + 0.15, 0.5, 2);
    else if (earliestMatch(personaText.toLowerCase(), SLOW_WORDS)) rate = clampV28(preset.rate - 0.15, 0.5, 2);
  }
  if (pitchHint === null) {
    if (earliestMatch(personaText.toLowerCase(), HIGH_PITCH_WORDS)) pitch = clampV28(preset.pitch + 2, -12, 12);
    else if (earliestMatch(personaText.toLowerCase(), LOW_PITCH_WORDS)) pitch = clampV28(preset.pitch - 2, -12, 12);
  }
  const addressForm = humanText.trim() ? detectAddressFormV28(humanText) : fallback.addressForm;
  const userName = detectUserNameV28(humanText) || fallback.userName;
  const source: VoiceV28VoiceConfig['source'] =
    persona || human ? 'memory-blocks' : 'fallback';
  return {
    rate: round2V28(rate),
    pitch: round2V28(pitch),
    style,
    language,
    voice: voiceHint ?? fallback.voice,
    addressForm,
    userName,
    greetingTemplate: greetingTemplateV28(style, language),
    source,
    blockVersions: { persona: persona?.version ?? null, human: human?.version ?? null },
  };
}

/** Compare two configs field by field (for the change report). */
export function diffVoiceConfigV28(
  before: VoiceV28VoiceConfig,
  after: VoiceV28VoiceConfig,
): string[] {
  const changed: string[] = [];
  if (before.rate !== after.rate) changed.push('rate');
  if (before.pitch !== after.pitch) changed.push('pitch');
  if (before.style !== after.style) changed.push('style');
  if (before.language !== after.language) changed.push('language');
  if (before.voice !== after.voice) changed.push('voice');
  if (before.addressForm !== after.addressForm) changed.push('addressForm');
  if (before.userName !== after.userName) changed.push('userName');
  if (before.greetingTemplate !== after.greetingTemplate) changed.push('greetingTemplate');
  if (before.source !== after.source) changed.push('source');
  return changed;
}

export interface MemoryVoiceStyleBridgeV28Options {
  /** Block source to read from (required). */
  source: VoiceV28BlockSource;
  /** Bot the bridge reads attached blocks for (null = global labels only). */
  botId?: string | null;
  /** Fallback config when no block exists. */
  fallback?: VoiceV28VoiceConfig;
  /** Labels to read (default ['persona', 'human']). */
  labels?: { persona?: string; human?: string };
}

export type VoiceV28StyleListener = (
  config: VoiceV28VoiceConfig,
  result: VoiceV28StyleRefreshResult,
) => void;

export function createMemoryVoiceStyleBridgeV28(
  opts: MemoryVoiceStyleBridgeV28Options,
): MemoryVoiceStyleBridgeV28 {
  return new MemoryVoiceStyleBridgeV28(opts);
}

/**
 * The bridge: reads persona/human blocks, derives the voice
 * config, and notifies subscribers when it changes.
 * `refresh(atMs)` is the polling entry point — the host calls
 * it after a block write (or on a timer); the bridge compares
 * versions, so a refresh with no change is cheap and silent.
 */
export class MemoryVoiceStyleBridgeV28 {
  private readonly source: VoiceV28BlockSource;
  private readonly botId: string | null;
  private readonly fallback: VoiceV28VoiceConfig;
  private readonly personaLabel: string;
  private readonly humanLabel: string;
  private config: VoiceV28VoiceConfig;
  private lastSeen: { persona: VoiceV28MemoryBlockView | null; human: VoiceV28MemoryBlockView | null };
  private listeners = new Set<VoiceV28StyleListener>();
  private refreshCount = 0;

  constructor(opts: MemoryVoiceStyleBridgeV28Options) {
    if (!opts || !opts.source || typeof opts.source.getBlock !== 'function') {
      throw new Error('MemoryVoiceStyleBridgeV28 needs a block source with getBlock()');
    }
    this.source = opts.source;
    this.botId = opts.botId ?? null;
    this.fallback = opts.fallback ?? defaultVoiceConfigV28();
    this.personaLabel = opts.labels?.persona ?? 'persona';
    this.humanLabel = opts.labels?.human ?? 'human';
    this.lastSeen = { persona: null, human: null };
    this.config = this.derive();
  }

  /** Current voice config (derived from the blocks last read). */
  get current(): VoiceV28VoiceConfig {
    return { ...this.config, blockVersions: { ...this.config.blockVersions } };
  }

  get bot(): string | null {
    return this.botId;
  }

  get refreshes(): number {
    return this.refreshCount;
  }

  /** Register a listener (returns an unsubscribe function). */
  subscribe(listener: VoiceV28StyleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-read the blocks and re-derive the config. */
  refresh(atMs: number): VoiceV28StyleRefreshResult {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error('refresh atMs must be >= 0');
    this.refreshCount += 1;
    const before = this.config;
    const persona = this.readBlock(this.personaLabel);
    const human = this.readBlock(this.humanLabel);
    const changes: VoiceV28BlockChange[] = [
      this.describeChange('persona', this.lastSeen.persona, persona, atMs),
      this.describeChange('human', this.lastSeen.human, human, atMs),
    ].filter((c) => c.kind !== 'unchanged');
    this.lastSeen = { persona, human };
    this.config = this.deriveFrom(persona, human);
    const changedFields = diffVoiceConfigV28(before, this.config);
    const changed = changedFields.length > 0;
    const result: VoiceV28StyleRefreshResult = {
      atMs,
      config: this.current,
      changes,
      changed,
      changedFields,
    };
    if (changed) {
      for (const listener of [...this.listeners]) listener(this.current, result);
    }
    return result;
  }

  /** Apply a style preset directly (overrides the block-derived style until the next refresh). */
  applyPreset(style: VoiceV28SpeakingStyle, atMs: number): VoiceV28StyleRefreshResult {
    const preset = stylePresetV28(style);
    if (!preset) throw new Error(`unknown speaking style: ${style}`);
    const before = this.config;
    this.config = {
      ...this.config,
      style,
      rate: preset.rate,
      pitch: preset.pitch,
      greetingTemplate: greetingTemplateV28(style, this.config.language),
      source: 'preset',
    };
    const changedFields = diffVoiceConfigV28(before, this.config);
    const result: VoiceV28StyleRefreshResult = {
      atMs,
      config: this.current,
      changes: [],
      changed: changedFields.length > 0,
      changedFields,
    };
    if (result.changed) {
      for (const listener of [...this.listeners]) listener(this.current, result);
    }
    return result;
  }

  /** Adjust the rate of the current config by a delta (clamped 0.5..2, notifies listeners). */
  adjustRate(delta: number, atMs: number): VoiceV28StyleRefreshResult {
    if (!Number.isFinite(delta)) throw new Error('adjustRate delta must be finite');
    const before = this.config;
    this.config = {
      ...this.config,
      rate: round2V28(clampV28(this.config.rate + delta, 0.5, 2)),
    };
    return this.emitAdjust(before, atMs);
  }

  /** Adjust the pitch of the current config by a delta (clamped -12..12, notifies listeners). */
  adjustPitch(delta: number, atMs: number): VoiceV28StyleRefreshResult {
    if (!Number.isFinite(delta)) throw new Error('adjustPitch delta must be finite');
    const before = this.config;
    this.config = {
      ...this.config,
      pitch: round2V28(clampV28(this.config.pitch + delta, -12, 12)),
    };
    return this.emitAdjust(before, atMs);
  }

  private emitAdjust(before: VoiceV28VoiceConfig, atMs: number): VoiceV28StyleRefreshResult {
    const changedFields = diffVoiceConfigV28(before, this.config);
    const result: VoiceV28StyleRefreshResult = {
      atMs,
      config: this.current,
      changes: [],
      changed: changedFields.length > 0,
      changedFields,
    };
    if (result.changed) {
      for (const listener of [...this.listeners]) listener(this.current, result);
    }
    return result;
  }

  /** Render the greeting for the current config. */
  greeting(): string {
    const name = this.config.userName.trim() || 'friend';
    return this.config.greetingTemplate
      .replaceAll('{name}', name)
      .replaceAll('{address}', this.config.addressForm || 'you');
  }

  private readBlock(label: string): VoiceV28MemoryBlockView | null {
    if (this.botId && typeof this.source.listAttached === 'function') {
      const attached = this.source.listAttached(this.botId) ?? [];
      const found = attached.find((b) => b.label === label);
      if (found) return { label: found.label, content: found.content, version: found.version };
    }
    return this.source.getBlock(label);
  }

  private derive(): VoiceV28VoiceConfig {
    const persona = this.readBlock(this.personaLabel);
    const human = this.readBlock(this.humanLabel);
    this.lastSeen = { persona, human };
    return this.deriveFrom(persona, human);
  }

  private deriveFrom(
    persona: VoiceV28MemoryBlockView | null,
    human: VoiceV28MemoryBlockView | null,
  ): VoiceV28VoiceConfig {
    return deriveVoiceConfigV28(persona, human, this.fallback);
  }

  private describeChange(
    label: string,
    before: VoiceV28MemoryBlockView | null,
    after: VoiceV28MemoryBlockView | null,
    atMs: number,
  ): VoiceV28BlockChange {
    if (before === null && after === null) {
      return { atMs, label, previousVersion: null, newVersion: null, kind: 'unchanged' };
    }
    if (before === null) {
      return { atMs, label, previousVersion: null, newVersion: after!.version, kind: 'created' };
    }
    if (after === null) {
      return { atMs, label, previousVersion: before.version, newVersion: null, kind: 'deleted' };
    }
    if (before.version === after.version && before.content === after.content) {
      return { atMs, label, previousVersion: before.version, newVersion: after.version, kind: 'unchanged' };
    }
    return { atMs, label, previousVersion: before.version, newVersion: after.version, kind: 'updated' };
  }
}

/** Build an in-memory block source for tests / hosts without a store. */
export function createInMemoryBlockSourceV28(
  initial: Record<string, { content: string; version?: number }> = {},
): VoiceV28BlockSource & {
  setBlock(label: string, content: string): void;
  deleteBlock(label: string): void;
} {
  const blocks = new Map<string, VoiceV28MemoryBlockView>();
  for (const [label, value] of Object.entries(initial)) {
    blocks.set(label, { label, content: value.content, version: value.version ?? 1 });
  }
  return {
    getBlock(label: string): VoiceV28MemoryBlockView | null {
      const found = blocks.get(label);
      return found ? { ...found } : null;
    },
    setBlock(label: string, content: string): void {
      const prev = blocks.get(label);
      blocks.set(label, { label, content, version: (prev?.version ?? 0) + 1 });
    },
    deleteBlock(label: string): void {
      blocks.delete(label);
    },
  };
}
