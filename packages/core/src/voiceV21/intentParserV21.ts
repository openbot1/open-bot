/**
 * Voice intent parser v21 (voice v21, v1.34 Team T5).
 *
 * Turns a final transcript into a tool-call intent. The parser is
 * deliberately small and deterministic: it matches trigger phrases
 * registered per tool, scores them by coverage, and pulls arguments
 * out of the remaining words (quoted strings, numbers, or the free
 * text after the trigger). It never calls a tool itself — the
 * voice tool-call engine decides policy and execution.
 *
 * Two extra jobs live here because they belong to understanding,
 * not to execution:
 *
 *   - Confirmation / refusal detection. When the session is
 *     waiting on a spoken "yes, do it" for a side-effecting tool,
 *     the next transcript is not a new intent — it is an answer.
 *     "đồng ý", "yes", "ok làm đi" confirm; "không", "hủy", "thôi"
 *     refuse. Both lists cover Vietnamese and English because
 *     the panel and the TTS speak both.
 *   - Argument extraction. A trigger such as "search the web for"
 *     leaves "cats in Hanoi" as the query; "remind me to" leaves
 *     the reminder text. Quoted spans ("...") are kept intact so
 *     a file name or a message with spaces survives as one arg.
 *
 * Everything is pure: same transcript + same descriptors always
 * yields the same intent. No network, no key, no audio.
 */
import {
  normaliseSpeechV21,
  speechWordsV21,
  clampV21,
  round4V21,
  type VoiceV21Intent,
  type VoiceV21ToolDescriptor,
} from './types';

/** Phrases that confirm a pending tool call (normalised, lowercase). */
export const VOICE_V21_CONFIRM_WORDS = [
  'yes',
  'yeah',
  'ok',
  'okay',
  'do it',
  'go ahead',
  'confirm',
  'confirmed',
  'please do',
  'đồng ý',
  'đồng ý làm đi',
  'ok làm đi',
  'làm đi',
  'được',
  'được rồi',
  'xác nhận',
  'ừ',
  'ừ làm đi',
] as const;

/** Phrases that refuse a pending tool call (normalised, lowercase). */
export const VOICE_V21_REFUSE_WORDS = [
  'no',
  'nope',
  'cancel',
  'stop',
  "don't",
  'do not',
  'never mind',
  'không',
  'không làm',
  'hủy',
  'huỷ',
  'thôi',
  'thôi đừng',
  'dừng lại',
  'đừng',
] as const;

export interface VoiceV21IntentParserOptions {
  /** Minimum confidence for a trigger to count as a match (default 0.4). */
  minConfidence: number;
  /** Maximum descriptors the parser keeps (default 200). */
  maxDescriptors: number;
}

export function defaultIntentParserV21Options(): VoiceV21IntentParserOptions {
  return { minConfidence: 0.4, maxDescriptors: 200 };
}

export function validateIntentParserV21Options(o: Partial<VoiceV21IntentParserOptions>): string[] {
  const e: string[] = [];
  if (o.minConfidence !== undefined && (o.minConfidence < 0 || o.minConfidence > 1)) {
    e.push('minConfidence must be 0..1');
  }
  if (o.maxDescriptors !== undefined && (!Number.isInteger(o.maxDescriptors) || o.maxDescriptors < 1)) {
    e.push('maxDescriptors must be a positive integer');
  }
  return e;
}

/** Does the (normalised) text contain any of the given phrases as a whole word run? */
function containsPhrase(normalised: string, phrase: string): boolean {
  const padded = ` ${normalised} `;
  return padded.includes(` ${phrase} `);
}

/** True when the transcript is a confirmation of a pending tool call. */
export function isVoiceConfirmationV21(transcript: string): boolean {
  const n = normaliseSpeechV21(transcript);
  if (n === '') return false;
  return VOICE_V21_CONFIRM_WORDS.some((w) => containsPhrase(n, w));
}

/** True when the transcript is a refusal of a pending tool call. */
export function isVoiceRefusalV21(transcript: string): boolean {
  const n = normaliseSpeechV21(transcript);
  if (n === '') return false;
  return VOICE_V21_REFUSE_WORDS.some((w) => containsPhrase(n, w));
}

/**
 * Extract the free-text argument after a trigger: the transcript
 * minus the trigger words, with quoted spans kept as one token.
 * Returns '' when nothing is left.
 */
export function extractFreeTextV21(transcript: string, trigger: string): string {
  const n = normaliseSpeechV21(transcript);
  const t = normaliseSpeechV21(trigger);
  if (t === '') return n;
  const idx = n.indexOf(t);
  if (idx === -1) return n;
  const before = n.slice(0, idx).trim();
  const after = n.slice(idx + t.length).trim();
  // Prefer the text after the trigger; fall back to the text before it
  // ("cats — search the web" still yields "cats").
  return after !== '' ? after : before;
}

/** Split text into tokens, keeping "..." quoted spans as one token. */
export function quotedTokensV21(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter((t) => t !== '');
}

/**
 * Pull named arguments out of a transcript for one descriptor.
 * Rules, in order:
 *   1. `"quoted"` spans fill argNames in order (first quote → first arg).
 *   2. A bare number fills the first arg whose name looks numeric
 *      (count, minutes, seconds, amount, limit, page).
 *   3. The free text after the trigger fills the first remaining
 *      arg (usually `query`, `text`, `message` or `title`).
 */
export function extractArgsV21(
  transcript: string,
  trigger: string,
  descriptor: VoiceV21ToolDescriptor,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const remaining = [...descriptor.argNames];
  const quotes = quotedTokensV21(transcript).filter((t) => transcript.includes(`"${t}"`) || transcript.includes(`'${t}'`));
  for (const q of quotes) {
    const name = remaining.shift();
    if (name === undefined) break;
    args[name] = q;
  }
  const numbers = normaliseSpeechV21(transcript).match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const num of numbers) {
    const idx = remaining.findIndex((n) => /count|minutes|seconds|amount|limit|page|number|duration/i.test(n));
    if (idx === -1) break;
    const name = remaining.splice(idx, 1)[0]!;
    args[name] = Number(num.replace(',', '.'));
  }
  if (remaining.length > 0) {
    const free = extractFreeTextV21(transcript, trigger);
    if (free !== '') {
      args[remaining[0]!] = free;
    }
  }
  return args;
}

export interface VoiceV21TriggerScore {
  descriptor: VoiceV21ToolDescriptor;
  trigger: string;
  confidence: number;
  matchedWords: number;
  triggerWords: number;
}

function scoreTriggerV21(
  words: string[],
  descriptor: VoiceV21ToolDescriptor,
  trigger: string,
): VoiceV21TriggerScore | null {
  const triggerWords = speechWordsV21(trigger);
  if (triggerWords.length === 0) return null;
  // The trigger must appear as a contiguous run of words.
  let matched = 0;
  for (let i = 0; i + triggerWords.length <= words.length; i += 1) {
    let ok = true;
    for (let j = 0; j < triggerWords.length; j += 1) {
      if (words[i + j] !== triggerWords[j]) { ok = false; break; }
    }
    if (ok) { matched = triggerWords.length; break; }
  }
  if (matched === 0) {
    // Partial credit: most trigger words present anywhere, in order.
    let cursor = 0;
    for (const w of words) {
      if (cursor < triggerWords.length && w === triggerWords[cursor]) cursor += 1;
    }
    matched = cursor;
    if (matched < triggerWords.length - 1 || matched < 2) return null;
  }
  // Longer, more specific triggers score higher; coverage matters most.
  const coverage = matched / triggerWords.length;
  const specificity = Math.min(1, triggerWords.length / 5);
  const confidence = round4V21(clampV21(0.55 * coverage + 0.45 * specificity + 0.1, 0, 1));
  return { descriptor, trigger, confidence, matchedWords: matched, triggerWords: triggerWords.length };
}

/**
 * Parse one final transcript into the best-matching tool intent.
 * Returns an intent with toolName '' when nothing matches above
 * the confidence floor — the caller then treats the transcript as
 * plain conversation, not a tool call.
 */
export function parseVoiceIntentV21(
  transcript: string,
  descriptors: readonly VoiceV21ToolDescriptor[],
  opts: Partial<VoiceV21IntentParserOptions> = {},
): VoiceV21Intent {
  const o = { ...defaultIntentParserV21Options(), ...opts };
  const base: VoiceV21Intent = {
    toolName: '',
    args: {},
    confidence: 0,
    transcript,
    isConfirmation: isVoiceConfirmationV21(transcript),
    isRefusal: isVoiceRefusalV21(transcript),
  };
  const words = speechWordsV21(transcript);
  if (words.length === 0) return base;
  let best: VoiceV21TriggerScore | null = null;
  for (const d of descriptors.slice(0, o.maxDescriptors)) {
    for (const trigger of d.triggers) {
      const scored = scoreTriggerV21(words, d, trigger);
      if (scored === null) continue;
      if (best === null || scored.confidence > best.confidence
        || (scored.confidence === best.confidence && scored.triggerWords > best.triggerWords)) {
        best = scored;
      }
    }
  }
  if (best === null || best.confidence < o.minConfidence) return base;
  return {
    toolName: best.descriptor.name,
    args: extractArgsV21(transcript, best.trigger, best.descriptor),
    confidence: best.confidence,
    trigger: best.trigger,
    transcript,
    isConfirmation: base.isConfirmation,
    isRefusal: base.isRefusal,
  };
}

/** Default descriptors for the built-in voice-callable tools. */
export function defaultVoiceToolDescriptorsV21(): VoiceV21ToolDescriptor[] {
  return [
    {
      name: 'web_search',
      description: 'Search the web for a query.',
      effect: 'read',
      triggers: ['search the web for', 'search for', 'tìm kiếm', 'tìm trên mạng', 'google'],
      argNames: ['query'],
    },
    {
      name: 'get_time',
      description: 'Tell the current time.',
      effect: 'read',
      triggers: ['what time is it', 'mấy giờ rồi', 'what is the time', 'giờ là mấy giờ'],
      argNames: [],
    },
    {
      name: 'take_note',
      description: 'Save a short note.',
      effect: 'local-write',
      triggers: ['take a note', 'ghi chú', 'note this', 'lưu ghi chú'],
      argNames: ['text'],
    },
    {
      name: 'send_message',
      description: 'Send a message to a contact or channel.',
      effect: 'send',
      triggers: ['send a message to', 'gửi tin nhắn cho', 'message', 'nhắn cho'],
      argNames: ['recipient', 'message'],
    },
    {
      name: 'delete_note',
      description: 'Delete a saved note.',
      effect: 'delete',
      triggers: ['delete note', 'xóa ghi chú', 'xoá ghi chú', 'remove note'],
      argNames: ['title'],
    },
    {
      name: 'set_reminder',
      description: 'Set a reminder.',
      effect: 'local-write',
      triggers: ['remind me to', 'nhắc tôi', 'set a reminder', 'đặt nhắc nhở'],
      argNames: ['text', 'minutes'],
    },
    {
      name: 'read_notes',
      description: 'Read back saved notes.',
      effect: 'read',
      triggers: ['read my notes', 'đọc ghi chú', 'show my notes', 'xem ghi chú'],
      argNames: [],
    },
    {
      name: 'open_app',
      description: 'Open an application by name.',
      effect: 'local-write',
      triggers: ['open', 'mở'],
      argNames: ['app'],
    },
  ];
}

/** One-line summary of an intent, for the panel and the session log. */
export function intentV21Summary(intent: VoiceV21Intent): string {
  if (intent.toolName === '') {
    return `no tool intent (confirmation=${intent.isConfirmation}, refusal=${intent.isRefusal})`;
  }
  const args = Object.entries(intent.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  return `${intent.toolName}(${(args)}) confidence=${(intent.confidence * 100).toFixed(0)}%`;
}
