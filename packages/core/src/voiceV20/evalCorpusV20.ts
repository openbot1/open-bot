/**
 * Eval corpus v20 (voice v20, v1.29 Team T5).
 *
 * The extended eval harness needs data to score against — and
 * that data must be offline, deterministic and reviewable, not a
 * live provider call. This module is the corpus: scripted
 * dialogues (Vietnamese + English) with labelled barge-in
 * points and silence gaps, reference/hypothesis transcript
 * pairs with known error patterns, and prosody scripts with
 * expected contours, emphasis and pauses.
 *
 * The pairs are deliberately small and hand-written: each one
 * pins one behaviour (a homophone, a number, a name, a filler
 * pause, a question contour), so a regression names the exact
 * case that broke instead of moving an opaque average. The
 * corpus is also self-validating (`validateEvalCorpusV20`):
 * ids unique, texts non-empty, every dialogue turn has a
 * speaker, every transcript pair has a reference. Nothing here
 * needs a key, a network or audio — it is text in, scores out.
 */
import type { ProsodyV20Script } from './prosodyEvalV20';

export interface EvalCorpusV20DialogueTurn {
  role: 'user' | 'agent';
  text: string;
  /** Reply the mock brain should return for this user turn. */
  reply?: string;
  /** Silence (ms) after this turn before the next one starts. */
  silenceAfterMs?: number;
  /** The user barges in while this agent turn speaks. */
  bargeInAtChars?: number;
}

export interface EvalCorpusV20Dialogue {
  id: string;
  language: 'vi' | 'en';
  label: string;
  turns: EvalCorpusV20DialogueTurn[];
}

export interface EvalCorpusV20TranscriptPair {
  id: string;
  language: 'vi' | 'en';
  /** What was really said. */
  reference: string;
  /** What the (mock) STT produced. */
  hypothesis: string;
  /** What this pair pins down (shown in reports). */
  pins: string;
}

export interface EvalCorpusV20TurnScenario {
  id: string;
  userText: string;
  /** Silence (ms) after the transcript before the turn must end. */
  silenceAfterMs: number;
  reply: string;
  /** Expected turn end: the user finished, or is still thinking. */
  expectedEnd: 'end' | 'hold';
}

export const EVAL_CORPUS_V20_DIALOGUES: readonly EvalCorpusV20Dialogue[] = [
  {
    id: 'dlg-vi-greeting',
    language: 'vi',
    label: 'Chào hỏi + hỏi giờ (vi)',
    turns: [
      { role: 'user', text: 'Chào bạn, hôm nay trời thế nào?', reply: 'Chào bạn! Hôm nay trời nắng đẹp, rất thích hợp để đi dạo.', silenceAfterMs: 800 },
      { role: 'user', text: 'Mấy giờ rồi?', reply: 'Bây giờ là ba giờ chiều.', silenceAfterMs: 500 },
    ],
  },
  {
    id: 'dlg-vi-bargein',
    language: 'vi',
    label: 'Ngắt lời giữa câu trả lời dài (vi)',
    turns: [
      { role: 'user', text: 'Kể cho tôi nghe về Hà Nội đi.', reply: 'Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ, hồ Hoàn Kiếm và ẩm thực đường phố rất phong phú.', silenceAfterMs: 300 },
      { role: 'user', text: 'Dừng lại, chỉ nói về ẩm thực thôi.', reply: 'Được rồi, ẩm thực Hà Nội nổi tiếng với phở, bún chả và cà phê trứng.', silenceAfterMs: 600 },
    ],
  },
  {
    id: 'dlg-vi-thinking',
    language: 'vi',
    label: 'Khoảng lặng suy nghĩ giữa câu (vi)',
    turns: [
      { role: 'user', text: 'Tôi muốn đặt vé… ừm… đi Đà Nẵng.', reply: 'Được rồi, bạn muốn đi Đà Nẵng vào ngày nào?', silenceAfterMs: 1200 },
      { role: 'user', text: 'Ngày mai, buổi sáng.', reply: 'Đã ghi nhận: Đà Nẵng, sáng mai.', silenceAfterMs: 400 },
    ],
  },
  {
    id: 'dlg-en-booking',
    language: 'en',
    label: 'Booking flow with a correction (en)',
    turns: [
      { role: 'user', text: 'Book me a table for two tonight.', reply: 'Sure — a table for two tonight. Which time works for you?', silenceAfterMs: 900 },
      { role: 'user', text: 'Seven pm, please.', reply: 'Booked for seven pm tonight. Anything else?', silenceAfterMs: 500 },
    ],
  },
  {
    id: 'dlg-en-bargein',
    language: 'en',
    label: 'Barge-in during a long answer (en)',
    turns: [
      { role: 'user', text: 'Explain photosynthesis to me.', reply: 'Photosynthesis is how plants turn sunlight, water and carbon dioxide into energy and oxygen.', silenceAfterMs: 300 },
      { role: 'user', text: 'Stop — just the short version.', reply: 'Short version: plants make food from sunlight.', silenceAfterMs: 600 },
    ],
  },
  {
    id: 'dlg-en-backchannel',
    language: 'en',
    label: 'Backchannel while the agent speaks (en)',
    turns: [
      { role: 'user', text: 'Tell me a joke.', reply: 'Why did the scarecrow win an award? Because he was outstanding in his field!', silenceAfterMs: 1000 },
    ],
  },
];

export const EVAL_CORPUS_V20_TRANSCRIPTS: readonly EvalCorpusV20TranscriptPair[] = [
  { id: 'tr-vi-clean', language: 'vi', reference: 'Xin chào, tôi muốn đặt vé đi Hà Nội', hypothesis: 'Xin chào, tôi muốn đặt vé đi Hà Nội', pins: 'clean transcript — WER 0' },
  { id: 'tr-vi-homophone', language: 'vi', reference: 'Năm nay tôi năm mươi tuổi', hypothesis: 'Nam nay tôi năm mươi tuổi', pins: 'homophone năm/nam (diacritic dropped)' },
  { id: 'tr-vi-number', language: 'vi', reference: 'Hẹn lúc ba giờ ba mươi phút', hypothesis: 'Hẹn lúc ba giờ ba mươi phút', pins: 'numbers read correctly' },
  { id: 'tr-vi-substitution', language: 'vi', reference: 'Tôi muốn mua hai vé xem phim', hypothesis: 'Tôi muốn mua hai vé xem phím', pins: 'one substitution: phim → phím' },
  { id: 'tr-vi-deletion', language: 'vi', reference: 'Bạn có thể giúp tôi được không', hypothesis: 'Bạn có thể giúp tôi không', pins: 'one deletion: được' },
  { id: 'tr-vi-insertion', language: 'vi', reference: 'Trời hôm nay đẹp quá', hypothesis: 'Trời hôm nay rất đẹp quá', pins: 'one insertion: rất' },
  { id: 'tr-vi-name', language: 'vi', reference: 'Tôi tên là Nguyễn Văn An', hypothesis: 'Tôi tên là Nguyễn Văn An', pins: 'proper name intact' },
  { id: 'tr-en-clean', language: 'en', reference: 'Hello, I would like to book a table', hypothesis: 'Hello, I would like to book a table', pins: 'clean transcript — WER 0' },
  { id: 'tr-en-substitution', language: 'en', reference: 'The meeting starts at nine o clock', hypothesis: 'The meeting starts at nine a clock', pins: 'one substitution: o → a' },
  { id: 'tr-en-deletion', language: 'en', reference: 'Please turn off the lights', hypothesis: 'Please turn the lights', pins: 'one deletion: off' },
  { id: 'tr-en-insertion', language: 'en', reference: 'What time is it now', hypothesis: 'What time is it right now', pins: 'one insertion: right' },
  { id: 'tr-en-homophone', language: 'en', reference: 'I need to write a letter', hypothesis: 'I need to right a letter', pins: 'homophone write/right' },
];

export const EVAL_CORPUS_V20_PROSODY: readonly ProsodyV20Script[] = [
  {
    id: 'pros-vi-question',
    label: 'Câu hỏi phải lên giọng (vi)',
    sentences: [
      { text: 'Bạn có muốn đi cùng tôi không?', contour: 'question', emphasisWords: [] },
      { text: 'Tôi sẽ đợi bạn ở cổng.', contour: 'statement', emphasisWords: [] },
    ],
  },
  {
    id: 'pros-vi-emphasis',
    label: 'Nhấn mạnh từ quan trọng (vi)',
    sentences: [
      { text: 'Bạn phải đến đúng giờ.', contour: 'statement', emphasisWords: ['phải'], strongEmphasis: true },
      { text: 'Đừng quên mang theo vé.', contour: 'statement', emphasisWords: [] },
    ],
  },
  {
    id: 'pros-vi-list',
    label: 'Liệt kê + nghỉ giữa các mục (vi)',
    sentences: [
      { text: 'Chúng ta cần ba thứ.', contour: 'statement', emphasisWords: [], pauseAfterMs: 320 },
      { text: '1. Vé máy bay.', contour: 'list-item', emphasisWords: [] },
      { text: '2. Khách sạn.', contour: 'list-item', emphasisWords: [] },
    ],
  },
  {
    id: 'pros-en-question',
    label: 'Question must rise (en)',
    sentences: [
      { text: 'Are you coming with me?', contour: 'question', emphasisWords: [] },
      { text: 'I will wait for you at the gate.', contour: 'statement', emphasisWords: [] },
    ],
  },
  {
    id: 'pros-en-exclamation',
    label: 'Exclamation lifts volume (en)',
    sentences: [
      { text: 'That is amazing!', contour: 'exclamation', emphasisWords: ['amazing'], strongEmphasis: true },
      { text: 'We did it.', contour: 'statement', emphasisWords: [] },
    ],
  },
  {
    id: 'pros-en-long',
    label: 'Long reply slows toward the end (en)',
    sentences: [
      { text: 'Photosynthesis is how plants turn sunlight, water and carbon dioxide into energy.', contour: 'statement', emphasisWords: [] },
      { text: 'It happens mostly in the leaves, where chlorophyll captures the light.', contour: 'statement', emphasisWords: [] },
      { text: 'The oxygen released is what we breathe every day.', contour: 'statement', emphasisWords: [] },
      { text: 'Without it, life on Earth would look very different.', contour: 'statement', emphasisWords: [] },
    ],
  },
];

export const EVAL_CORPUS_V20_TURNS: readonly EvalCorpusV20TurnScenario[] = [
  { id: 'turn-vi-complete', userText: 'Cho tôi biết bây giờ là mấy giờ?', silenceAfterMs: 800, reply: 'Bây giờ là ba giờ chiều.', expectedEnd: 'end' },
  { id: 'turn-vi-thinking', userText: 'Tôi muốn đặt vé… ừm…', silenceAfterMs: 800, reply: 'Bạn muốn đi đâu?', expectedEnd: 'hold' },
  { id: 'turn-vi-continuer', userText: 'Tôi muốn đi Đà Nẵng và', silenceAfterMs: 900, reply: 'Và sau đó thì sao?', expectedEnd: 'hold' },
  { id: 'turn-vi-short-gap', userText: 'Xin chào.', silenceAfterMs: 150, reply: 'Chào bạn!', expectedEnd: 'hold' },
  { id: 'turn-en-complete', userText: 'What time is it?', silenceAfterMs: 800, reply: 'It is three in the afternoon.', expectedEnd: 'end' },
  { id: 'turn-en-thinking', userText: 'I want to book a ticket, um…', silenceAfterMs: 900, reply: 'Where to?', expectedEnd: 'hold' },
];

export interface EvalCorpusV20Counts {
  dialogues: number;
  dialogueTurns: number;
  transcriptPairs: number;
  prosodyScripts: number;
  prosodySentences: number;
  turnScenarios: number;
}

export function evalCorpusV20Counts(): EvalCorpusV20Counts {
  return {
    dialogues: EVAL_CORPUS_V20_DIALOGUES.length,
    dialogueTurns: EVAL_CORPUS_V20_DIALOGUES.reduce((s, d) => s + d.turns.length, 0),
    transcriptPairs: EVAL_CORPUS_V20_TRANSCRIPTS.length,
    prosodyScripts: EVAL_CORPUS_V20_PROSODY.length,
    prosodySentences: EVAL_CORPUS_V20_PROSODY.reduce((s, p) => s + p.sentences.length, 0),
    turnScenarios: EVAL_CORPUS_V20_TURNS.length,
  };
}

/** Self-check: ids unique, texts non-empty, every turn has a speaker. */
export function validateEvalCorpusV20(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const checkId = (id: string, where: string): void => {
    if (id === '') errors.push(`${where}: empty id`);
    if (seen.has(id)) errors.push(`${where}: duplicate id "${id}"`);
    seen.add(id);
  };
  for (const d of EVAL_CORPUS_V20_DIALOGUES) {
    checkId(d.id, 'dialogue');
    if (d.turns.length === 0) errors.push(`dialogue ${d.id}: no turns`);
    for (const t of d.turns) {
      if (t.text.trim() === '') errors.push(`dialogue ${d.id}: empty turn text`);
      if (t.role === 'user' && (t.reply === undefined || t.reply.trim() === '')) {
        errors.push(`dialogue ${d.id}: user turn without a mock reply`);
      }
    }
  }
  for (const p of EVAL_CORPUS_V20_TRANSCRIPTS) {
    checkId(p.id, 'transcript pair');
    if (p.reference.trim() === '') errors.push(`transcript ${p.id}: empty reference`);
    if (p.hypothesis.trim() === '') errors.push(`transcript ${p.id}: empty hypothesis`);
  }
  for (const s of EVAL_CORPUS_V20_PROSODY) {
    checkId(s.id, 'prosody script');
    if (s.sentences.length === 0) errors.push(`prosody ${s.id}: no sentences`);
    for (const sentence of s.sentences) {
      if (sentence.text.trim() === '') errors.push(`prosody ${s.id}: empty sentence`);
    }
  }
  for (const t of EVAL_CORPUS_V20_TURNS) {
    checkId(t.id, 'turn scenario');
    if (t.userText.trim() === '') errors.push(`turn ${t.id}: empty userText`);
    if (t.reply.trim() === '') errors.push(`turn ${t.id}: empty reply`);
  }
  return errors;
}

export function evalCorpusV20Summary(): string {
  const c = evalCorpusV20Counts();
  return `Eval corpus v20: ${c.dialogues} dialogues (${c.dialogueTurns} turns), ` +
    `${c.transcriptPairs} transcript pairs, ${c.prosodyScripts} prosody scripts ` +
    `(${c.prosodySentences} sentences), ${c.turnScenarios} turn scenarios`;
}
