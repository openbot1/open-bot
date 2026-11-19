/**
 * Voice command routing v28 (v1.41, Team T5).
 *
 * A spoken transcript is matched against builtin intents
 * (English + Vietnamese) and routed to a tool call. The
 * router itself never calls a tool — it returns a match
 * (`toolName` + `toolArgs` + how it may run) and the host
 * executes it. That keeps routing pure, testable, and safe:
 * a misheard command can never do anything by itself.
 *
 * Intents:
 *   stop-session    "dừng lại" / "stop" — ends the session
 *   pause-session   "tạm dừng" / "pause"
 *   resume-session  "tiếp tục" / "resume" / "continue"
 *   switch-voice    "đổi giọng X" / "switch voice to X"
 *   switch-style    "nói trang trọng hơn" / "speak formally"
 *   repeat-last     "nói lại" / "repeat that"
 *   summarise-session "tóm tắt" / "summarize"
 *   speak-slower / faster / softer / louder
 *   open-settings   "mở cài đặt" / "open settings"
 *
 * Execution policy:
 *   - stop-session is confirm-first (ending a session loses
 *     the live context) unless the caller passes
 *     `confirmStop: true` — the match then becomes direct;
 *   - switch-voice with an unknown voice is rejected (the
 *     router lists the known voices it was given);
 *   - everything else is direct.
 *
 * Matching is phrase-based, not ML: the transcript is
 * normalised (lowercase, punctuation stripped, Vietnamese
 * diacritics kept — patterns are written with diacritics),
 * then each intent's patterns are tried in order; the first
 * pattern that appears wins, and confidence is 1.0 for an
 * exact-phrase hit, 0.85 for a contains hit, 0.7 for a
 * multi-word partial hit. `unknown` (confidence 0) is
 * returned when nothing matches.
 *
 * Language detection is a diacritic/keyword heuristic:
 * Vietnamese diacritics or Vietnamese-only words -> vi,
 * else en when English words dominate, else other.
 */

import {
  clampV28,
  type VoiceV28CommandExecution,
  type VoiceV28CommandKind,
  type VoiceV28CommandMatch,
} from './types';

export interface VoiceCommandRouterV28Options {
  /** Voice ids the router accepts for switch-voice (empty = any well-formed id). */
  knownVoices?: string[];
  /** Style ids the router accepts for switch-style (default: the 5 builtin styles). */
  knownStyles?: string[];
  /** When true, stop-session matches are direct instead of confirm-first. */
  confirmStop?: boolean;
  /** Max command log entries kept. */
  maxLog?: number;
  /** Tool name prefix for session commands (default 'voice_v28_session'). */
  sessionToolName?: string;
  /** Tool name for style commands (default 'voice_v28_style'). */
  styleToolName?: string;
  /** Tool name for transcript commands (default 'voice_v28_transcript'). */
  transcriptToolName?: string;
  /** Tool name for casting commands (default 'voice_v28_casting'). */
  castingToolName?: string;
}

export interface VoiceV28CommandLogEntry {
  atMs: number;
  match: VoiceV28CommandMatch;
  /** True when the host reported the command executed. */
  executed: boolean | null;
}

interface PatternEntry {
  kind: VoiceV28CommandKind;
  patterns: string[];
  /** Tool the intent routes to (null = session-internal). */
  tool: 'session' | 'style' | 'transcript' | 'casting' | null;
  /** Extra args merged into the tool call. */
  toolArgs: Record<string, unknown>;
}

const PATTERNS: PatternEntry[] = [
  {
    kind: 'stop-session',
    patterns: ['dừng lại', 'dừng phiên', 'kết thúc phiên', 'stop the session', 'end the session', 'stop session', 'stop', 'dừng'],
    tool: 'session',
    toolArgs: { action: 'stop' },
  },
  {
    kind: 'pause-session',
    patterns: ['tạm dừng', 'dừng một chút', 'pause the session', 'pause session', 'pause', 'tạm ngưng'],
    tool: 'session',
    toolArgs: { action: 'pause' },
  },
  {
    kind: 'resume-session',
    patterns: ['tiếp tục', 'tiếp tục đi', 'resume the session', 'resume session', 'resume', 'continue', 'nói tiếp đi'],
    tool: 'session',
    toolArgs: { action: 'resume' },
  },
  {
    kind: 'repeat-last',
    patterns: ['nói lại', 'nói lại đi', 'lặp lại', 'repeat that', 'say that again', 'repeat', 'nhắc lại'],
    tool: 'session',
    toolArgs: { action: 'repeat-last' },
  },
  {
    kind: 'summarise-session',
    patterns: ['tóm tắt phiên', 'tóm tắt lại', 'tóm tắt', 'summarize the session', 'summarise the session', 'summarize', 'summarise'],
    tool: 'transcript',
    toolArgs: { action: 'summarise' },
  },
  {
    kind: 'speak-slower',
    patterns: ['nói chậm lại', 'chậm lại', 'nói chậm hơn', 'speak slower', 'speak more slowly', 'slower'],
    tool: 'style',
    toolArgs: { action: 'adjust-rate', delta: -0.15 },
  },
  {
    kind: 'speak-faster',
    patterns: ['nói nhanh lên', 'nói nhanh hơn', 'nhanh lên', 'speak faster', 'speak more quickly', 'faster'],
    tool: 'style',
    toolArgs: { action: 'adjust-rate', delta: 0.15 },
  },
  {
    kind: 'speak-softer',
    patterns: ['nói nhỏ lại', 'nói khẽ thôi', 'nói nhỏ hơn', 'speak softer', 'speak more quietly', 'quieter', 'softer'],
    tool: 'style',
    toolArgs: { action: 'adjust-pitch', delta: -1 },
  },
  {
    kind: 'speak-louder',
    patterns: ['nói to lên', 'nói to hơn', 'to lên', 'speak louder', 'speak up', 'louder'],
    tool: 'style',
    toolArgs: { action: 'adjust-pitch', delta: 1 },
  },
  {
    kind: 'open-settings',
    patterns: ['mở cài đặt', 'mở cài đặt giọng nói', 'open settings', 'open voice settings', 'settings'],
    tool: null,
    toolArgs: {},
  },
];

const STYLE_WORDS: { style: string; words: string[] }[] = [
  { style: 'formal', words: ['trang trọng', 'formal', 'lịch sự'] },
  { style: 'intimate', words: ['thân mật', 'intimate', 'gần gũi'] },
  { style: 'concise', words: ['ngắn gọn', 'concise', 'súc tích'] },
  { style: 'storyteller', words: ['kể chuyện', 'storyteller'] },
  { style: 'default', words: ['bình thường', 'mặc định', 'normal'] },
];

const VOICE_NAME_WORDS = ['giọng', 'voice'];

/** Normalise a transcript for matching (lowercase, punctuation -> space). */
export function normalizeTranscriptV28(transcript: string): string {
  return (transcript ?? '')
    .toLowerCase()
    .replace(/[.,!?;:"'()[\]{}<>_+=/\\|~`@#$%^&*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Detect the transcript language ('en' | 'vi' | 'other'). */
export function detectCommandLanguageV28(transcript: string): 'en' | 'vi' | 'other' {
  const lower = (transcript ?? '').toLowerCase();
  if (!lower.trim()) return 'other';
  if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/.test(lower)) return 'vi';
  // Whole-word match: short Vietnamese words ('to', 'lại', 'mở')
  // also occur inside English words ('stop', 'today'), so
  // substring matching would misclassify English as Vietnamese.
  const tokens = new Set(lower.split(/[^a-zà-ỹđ]+/).filter(Boolean));
  const viWords = ['dừng', 'tạm', 'tiếp', 'nói', 'giọng', 'tóm', 'tắt', 'mở', 'cài', 'đặt', 'lại', 'chậm', 'nhanh', 'nhỏ', 'to'];
  if (viWords.some((w) => tokens.has(w))) return 'vi';
  const enWords = ['stop', 'pause', 'resume', 'continue', 'repeat', 'summarize', 'summarise', 'speak', 'voice', 'settings', 'slower', 'faster', 'louder', 'softer'];
  if (enWords.some((w) => tokens.has(w))) return 'en';
  return 'other';
}

export function defaultVoiceCommandRouterV28Options(): VoiceCommandRouterV28Options {
  return {
    knownVoices: [],
    knownStyles: ['formal', 'intimate', 'concise', 'storyteller', 'default'],
    confirmStop: false,
    maxLog: 200,
    sessionToolName: 'voice_v28_session',
    styleToolName: 'voice_v28_style',
    transcriptToolName: 'voice_v28_transcript',
    castingToolName: 'voice_v28_casting',
  };
}

export function createVoiceCommandRouterV28(
  opts: VoiceCommandRouterV28Options = {},
): VoiceCommandRouterV28 {
  return new VoiceCommandRouterV28(opts);
}

export class VoiceCommandRouterV28 {
  private readonly knownVoices: string[];
  private readonly knownStyles: string[];
  private readonly confirmStop: boolean;
  private readonly maxLog: number;
  private readonly toolNames: Record<'session' | 'style' | 'transcript' | 'casting', string>;
  private log: VoiceV28CommandLogEntry[] = [];
  private matches = 0;
  private unknowns = 0;
  private rejected = 0;

  constructor(opts: VoiceCommandRouterV28Options = {}) {
    const merged = { ...defaultVoiceCommandRouterV28Options(), ...opts };
    this.knownVoices = (merged.knownVoices ?? []).map((v) => v.toLowerCase());
    this.knownStyles = (merged.knownStyles ?? []).map((s) => s.toLowerCase());
    this.confirmStop = merged.confirmStop ?? false;
    this.maxLog = Math.max(1, merged.maxLog ?? 200);
    this.toolNames = {
      session: merged.sessionToolName ?? 'voice_v28_session',
      style: merged.styleToolName ?? 'voice_v28_style',
      transcript: merged.transcriptToolName ?? 'voice_v28_transcript',
      casting: merged.castingToolName ?? 'voice_v28_casting',
    };
  }

  /** Route one transcript to a command match (never executes anything). */
  route(transcript: string, atMs = 0): VoiceV28CommandMatch {
    const language = detectCommandLanguageV28(transcript);
    const normalized = normalizeTranscriptV28(transcript);
    const match = this.matchNormalized(normalized, transcript, language);
    this.matches += 1;
    if (match.kind === 'unknown') this.unknowns += 1;
    if (match.execution === 'rejected') this.rejected += 1;
    this.log.push({ atMs, match, executed: null });
    if (this.log.length > this.maxLog) this.log.shift();
    return match;
  }

  /** Mark a logged match executed (by index in the log). */
  markExecuted(logIndex: number, executed: boolean): void {
    const entry = this.log[logIndex];
    if (entry) entry.executed = executed;
  }

  /** Route many transcripts in order. */
  routeMany(transcripts: readonly string[], startAtMs = 0): VoiceV28CommandMatch[] {
    return transcripts.map((t, i) => this.route(t, startAtMs + i));
  }

  /** Recent command log (newest last). */
  commandLog(): VoiceV28CommandLogEntry[] {
    return [...this.log];
  }

  stats(): { matches: number; unknowns: number; rejected: number; logged: number } {
    return { matches: this.matches, unknowns: this.unknowns, rejected: this.rejected, logged: this.log.length };
  }

  private matchNormalized(
    normalized: string,
    rawTranscript: string,
    language: 'en' | 'vi' | 'other',
  ): VoiceV28CommandMatch {
    const unknown: VoiceV28CommandMatch = {
      kind: 'unknown',
      transcript: rawTranscript,
      confidence: 0,
      toolName: null,
      toolArgs: {},
      execution: 'direct',
      reason: 'no intent matched',
      pattern: null,
      language,
    };
    if (!normalized) return unknown;

    // switch-voice / switch-style carry a parameter: try them
    // before the plain phrase table so "đổi giọng Lan" does not
    // match a shorter pattern first.
    const voiceSwitch = this.matchVoiceSwitch(normalized, rawTranscript, language);
    if (voiceSwitch) return voiceSwitch;
    const styleSwitch = this.matchStyleSwitch(normalized, rawTranscript, language);
    if (styleSwitch) return styleSwitch;

    for (const entry of PATTERNS) {
      for (const pattern of entry.patterns) {
        const normPattern = normalizeTranscriptV28(pattern);
        if (normalized === normPattern) {
          return this.buildMatch(entry, rawTranscript, language, 1.0, pattern, normalized);
        }
      }
    }
    for (const entry of PATTERNS) {
      for (const pattern of entry.patterns) {
        const normPattern = normalizeTranscriptV28(pattern);
        if (normalized.includes(normPattern)) {
          return this.buildMatch(entry, rawTranscript, language, 0.85, pattern, normalized);
        }
      }
    }
    // Partial multi-word hit: at least 2 words of a pattern present.
    for (const entry of PATTERNS) {
      for (const pattern of entry.patterns) {
        const words = normalizeTranscriptV28(pattern).split(' ').filter(Boolean);
        if (words.length >= 2) {
          const hits = words.filter((w) => normalized.split(' ').includes(w)).length;
          if (hits >= 2 && hits / words.length >= 0.6) {
            return this.buildMatch(entry, rawTranscript, language, 0.7, pattern, normalized);
          }
        }
      }
    }
    return unknown;
  }

  private matchVoiceSwitch(
    normalized: string,
    rawTranscript: string,
    language: 'en' | 'vi' | 'other',
  ): VoiceV28CommandMatch | null {
    const hasMarker = VOICE_NAME_WORDS.some((w) => normalized.includes(w));
    const hasSwitchVerb =
      normalized.includes('đổi') ||
      normalized.includes('chuyển') ||
      normalized.includes('switch') ||
      normalized.includes('change');
    if (!hasMarker || !hasSwitchVerb) return null;
    // The voice name is the token(s) after the marker word.
    const tokens = normalized.split(' ').filter(Boolean);
    const markerIdx = tokens.findIndex((t) => VOICE_NAME_WORDS.includes(t));
    const after = tokens.slice(markerIdx + 1).filter((t) => !['sang', 'thành', 'to', 'the'].includes(t));
    const voiceId = after.join('-');
    if (!voiceId) return null;
    if (this.knownVoices.length > 0 && !this.knownVoices.includes(voiceId)) {
      return {
        kind: 'switch-voice',
        transcript: rawTranscript,
        confidence: 0.8,
        toolName: this.toolNames.casting,
        toolArgs: { action: 'switch', voiceId },
        execution: 'rejected',
        reason: `unknown voice: ${voiceId}`,
        pattern: 'switch-voice',
        language,
      };
    }
    return {
      kind: 'switch-voice',
      transcript: rawTranscript,
      confidence: 0.9,
      toolName: this.toolNames.casting,
      toolArgs: { action: 'switch', voiceId },
      execution: 'direct',
      reason: null,
      pattern: 'switch-voice',
      language,
    };
  }

  private matchStyleSwitch(
    normalized: string,
    rawTranscript: string,
    language: 'en' | 'vi' | 'other',
  ): VoiceV28CommandMatch | null {
    const hasSwitchVerb =
      normalized.includes('nói') ||
      normalized.includes('speak') ||
      normalized.includes('chuyển') ||
      normalized.includes('switch');
    if (!hasSwitchVerb) return null;
    for (const entry of STYLE_WORDS) {
      const hit = entry.words.find((w) => normalized.includes(normalizeTranscriptV28(w)));
      if (!hit) continue;
      if (!this.knownStyles.includes(entry.style)) {
        return {
          kind: 'switch-style',
          transcript: rawTranscript,
          confidence: 0.8,
          toolName: this.toolNames.style,
          toolArgs: { action: 'apply-preset', style: entry.style },
          execution: 'rejected',
          reason: `unknown style: ${entry.style}`,
          pattern: `switch-style:${entry.style}`,
          language,
        };
      }
      return {
        kind: 'switch-style',
        transcript: rawTranscript,
        confidence: 0.9,
        toolName: this.toolNames.style,
        toolArgs: { action: 'apply-preset', style: entry.style },
        execution: 'direct',
        reason: null,
        pattern: `switch-style:${entry.style}`,
        language,
      };
    }
    return null;
  }

  private buildMatch(
    entry: PatternEntry,
    rawTranscript: string,
    language: 'en' | 'vi' | 'other',
    confidence: number,
    pattern: string,
    _normalized: string,
  ): VoiceV28CommandMatch {
    let execution: VoiceV28CommandExecution = 'direct';
    let reason: string | null = null;
    if (entry.kind === 'stop-session' && !this.confirmStop) {
      execution = 'confirm-first';
      reason = 'stopping a session ends the live conversation';
    }
    const toolName = entry.tool === null ? null : this.toolNames[entry.tool];
    return {
      kind: entry.kind,
      transcript: rawTranscript,
      confidence: clampV28(confidence, 0, 1),
      toolName,
      toolArgs: { ...entry.toolArgs },
      execution,
      reason,
      pattern,
      language,
    };
  }
}
