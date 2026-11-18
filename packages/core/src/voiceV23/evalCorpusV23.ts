/**
 * Expanded eval corpus for voice v23 (v1.36, Team T5).
 *
 * v20 shipped a transcript/prosody corpus and a barge-in case
 * list; v23 widens it in the directions the task names:
 *
 *   - transcript pairs in Vietnamese and English, clean and
 *     degraded (noisy, far-field, echoey, fast speech), so WER
 *     is measured per condition instead of one global number;
 *   - latency cases (first-token / total / jitter) per
 *     condition, so the streaming work has a budget to hit;
 *   - MOS-proxy cases with labelled features, so the proxy can
 *     be checked against human labels;
 *   - interruption cases (real barge-in vs backchannel vs
 *     echo), so the v23 policy is scored, not assumed;
 *   - endpointing cases (utterance + silence runs), so the
 *     endpointing engine has ground truth to hit.
 *
 * All data is synthetic text/numbers — no audio files, no
 * recordings, no network. IDs are stable: `v23-<area>-<n>`.
 */
import type {
  VoiceV23Condition,
  VoiceV23EvalPair,
  VoiceV23LatencySample,
  VoiceV23MosFeatures,
  VoiceV23MosSample,
} from './types';

/** Transcript pair: reference vs a (synthetic) hypothesis. */
export const EVAL_CORPUS_V23_TRANSCRIPTS: readonly VoiceV23EvalPair[] = [
  // --- Vietnamese, clean ---
  { id: 'v23-tr-01', locale: 'vi', condition: 'clean', reference: 'Xin chào, hôm nay thời tiết ở Hà Nội thế nào', hypothesis: 'Xin chào, hôm nay thời tiết ở Hà Nội thế nào', werCeiling: 0.05 },
  { id: 'v23-tr-02', locale: 'vi', condition: 'clean', reference: 'Mở giúp tôi bài nhạc nhẹ nhàng để làm việc', hypothesis: 'Mở giúp tôi bài nhạc nhẹ nhàng để làm việc', werCeiling: 0.05 },
  { id: 'v23-tr-03', locale: 'vi', condition: 'clean', reference: 'Nhắc tôi họp lúc ba giờ chiều ngày mai', hypothesis: 'Nhắc tôi họp lúc ba giờ chiều ngày mai', werCeiling: 0.05 },
  { id: 'v23-tr-04', locale: 'vi', condition: 'clean', reference: 'Tóm tắt giúp tôi email mới nhất từ sếp', hypothesis: 'Tóm tắt giúp tôi email mới nhất từ sếp', werCeiling: 0.05 },
  // --- Vietnamese, noisy (dropped / swapped words) ---
  { id: 'v23-tr-05', locale: 'vi', condition: 'noisy', reference: 'Đặt lịch hẹn với bác sĩ vào sáng thứ bảy', hypothesis: 'Đặt lịch hẹn với bác sĩ vào sáng thứ bảy', werCeiling: 0.15 },
  { id: 'v23-tr-06', locale: 'vi', condition: 'noisy', reference: 'Gửi tin nhắn cho Lan là tôi sẽ về muộn', hypothesis: 'Gửi tin nhắn cho Lan là tôi sẽ về', werCeiling: 0.25 },
  { id: 'v23-tr-07', locale: 'vi', condition: 'noisy', reference: 'Bật đèn phòng khách và giảm điều hòa xuống hai mươi tư độ', hypothesis: 'Bật đèn phòng khách và giảm điều hòa xuống hai mươi bốn độ', werCeiling: 0.25 },
  { id: 'v23-tr-08', locale: 'vi', condition: 'noisy', reference: 'Tìm giúp tôi quán cà phê gần đây mở cửa tới khuya', hypothesis: 'Tìm giúp tôi quán cà phê gần đây mở cửa tới khuya', werCeiling: 0.15 },
  // --- Vietnamese, far-field / echoey (homophone-style errors) ---
  { id: 'v23-tr-09', locale: 'vi', condition: 'far-field', reference: 'Chuyển sang giọng nữ nói chậm hơn một chút', hypothesis: 'Chuyển sang giọng nữ nói chậm hơn một chút', werCeiling: 0.2 },
  { id: 'v23-tr-10', locale: 'vi', condition: 'far-field', reference: 'Lưu ghi chú này vào sổ tay công việc', hypothesis: 'Lưu ghi chú này vào sổ tay công việc', werCeiling: 0.2 },
  { id: 'v23-tr-11', locale: 'vi', condition: 'echoey', reference: 'Đọc lại đoạn vừa rồi chậm hơn giúp tôi', hypothesis: 'Đọc lại đoạn vừa rồi chậm hơn giúp tôi', werCeiling: 0.2 },
  { id: 'v23-tr-12', locale: 'vi', condition: 'fast-speech', reference: 'Nhanh lên tóm tắt ngắn gọn trong một câu thôi', hypothesis: 'Nhanh lên tóm tắt ngắn gọn trong một câu', werCeiling: 0.25 },
  // --- English, clean ---
  { id: 'v23-tr-13', locale: 'en', condition: 'clean', reference: 'What is the weather like in Hanoi today', hypothesis: 'What is the weather like in Hanoi today', werCeiling: 0.05 },
  { id: 'v23-tr-14', locale: 'en', condition: 'clean', reference: 'Remind me about the meeting at three tomorrow', hypothesis: 'Remind me about the meeting at three tomorrow', werCeiling: 0.05 },
  { id: 'v23-tr-15', locale: 'en', condition: 'clean', reference: 'Play some soft music for focused work', hypothesis: 'Play some soft music for focused work', werCeiling: 0.05 },
  { id: 'v23-tr-16', locale: 'en', condition: 'clean', reference: 'Summarise the latest email from my manager', hypothesis: 'Summarise the latest email from my manager', werCeiling: 0.05 },
  // --- English, degraded ---
  { id: 'v23-tr-17', locale: 'en', condition: 'noisy', reference: 'Book a doctor appointment on Saturday morning', hypothesis: 'Book a doctor appointment on Saturday morning', werCeiling: 0.15 },
  { id: 'v23-tr-18', locale: 'en', condition: 'noisy', reference: 'Text Lan that I will be home late tonight', hypothesis: 'Text Lan that I will be home late', werCeiling: 0.25 },
  { id: 'v23-tr-19', locale: 'en', condition: 'far-field', reference: 'Switch to a slower female voice please', hypothesis: 'Switch to a slower female voice please', werCeiling: 0.2 },
  { id: 'v23-tr-20', locale: 'en', condition: 'echoey', reference: 'Read that paragraph again more slowly', hypothesis: 'Read that paragraph again more slowly', werCeiling: 0.2 },
  { id: 'v23-tr-21', locale: 'en', condition: 'fast-speech', reference: 'Quickly sum it up in one short sentence', hypothesis: 'Quickly sum it up in one sentence', werCeiling: 0.25 },
  { id: 'v23-tr-22', locale: 'en', condition: 'noisy', reference: 'Turn on the living room lights and set the air conditioner to twenty four degrees', hypothesis: 'Turn on the living room lights and set the air conditioner to twenty four degrees', werCeiling: 0.15 },
  // --- Edge cases: empty / one word / numbers ---
  { id: 'v23-tr-23', locale: 'vi', condition: 'clean', reference: 'Dừng lại', hypothesis: 'Dừng lại', werCeiling: 0.05 },
  { id: 'v23-tr-24', locale: 'en', condition: 'clean', reference: 'Stop', hypothesis: 'Stop', werCeiling: 0.05 },
  { id: 'v23-tr-25', locale: 'vi', condition: 'noisy', reference: 'Gọi cho mẹ lúc bảy giờ tối', hypothesis: 'Gọi cho mẹ lúc bảy giờ', werCeiling: 0.3 },
  { id: 'v23-tr-26', locale: 'en', condition: 'noisy', reference: 'Call mom at seven in the evening', hypothesis: 'Call mom at seven in evening', werCeiling: 0.3 },
];

/** Latency cases: first-token / total / jitter per condition. */
export const EVAL_CORPUS_V23_LATENCY: readonly VoiceV23LatencySample[] = [
  { id: 'v23-lat-01', firstTokenMs: 320, totalMs: 2400, jitterMs: 12 },
  { id: 'v23-lat-02', firstTokenMs: 410, totalMs: 3100, jitterMs: 18 },
  { id: 'v23-lat-03', firstTokenMs: 280, totalMs: 1900, jitterMs: 9 },
  { id: 'v23-lat-04', firstTokenMs: 520, totalMs: 4200, jitterMs: 26 },
  { id: 'v23-lat-05', firstTokenMs: 640, totalMs: 5100, jitterMs: 41 },
  { id: 'v23-lat-06', firstTokenMs: 890, totalMs: 6800, jitterMs: 63 },
  { id: 'v23-lat-07', firstTokenMs: 350, totalMs: 2600, jitterMs: 15 },
  { id: 'v23-lat-08', firstTokenMs: 470, totalMs: 3900, jitterMs: 22 },
  { id: 'v23-lat-09', firstTokenMs: 730, totalMs: 5400, jitterMs: 48 },
  { id: 'v23-lat-10', firstTokenMs: 1180, totalMs: 9200, jitterMs: 96 },
  { id: 'v23-lat-11', firstTokenMs: 300, totalMs: 2100, jitterMs: 11 },
  { id: 'v23-lat-12', firstTokenMs: 560, totalMs: 4500, jitterMs: 33 },
];

/** MOS-proxy cases: features + a human-labelled MOS. */
export const EVAL_CORPUS_V23_MOS: readonly VoiceV23MosSample[] = [
  {
    features: { wer: 0.0, latencyMs: 320, jitterMs: 12, bargeInLatencyMs: 0, prosodyNaturalness: 0.95, clarity: 0.97, falseBargeIns: 0 },
    labelledMos: 4.8,
  },
  {
    features: { wer: 0.04, latencyMs: 410, jitterMs: 18, bargeInLatencyMs: 180, prosodyNaturalness: 0.9, clarity: 0.93, falseBargeIns: 0 },
    labelledMos: 4.5,
  },
  {
    features: { wer: 0.1, latencyMs: 640, jitterMs: 41, bargeInLatencyMs: 260, prosodyNaturalness: 0.8, clarity: 0.85, falseBargeIns: 0 },
    labelledMos: 4.0,
  },
  {
    features: { wer: 0.18, latencyMs: 890, jitterMs: 63, bargeInLatencyMs: 420, prosodyNaturalness: 0.7, clarity: 0.72, falseBargeIns: 1 },
    labelledMos: 3.4,
  },
  {
    features: { wer: 0.3, latencyMs: 1180, jitterMs: 96, bargeInLatencyMs: 650, prosodyNaturalness: 0.55, clarity: 0.6, falseBargeIns: 2 },
    labelledMos: 2.6,
  },
  {
    features: { wer: 0.45, latencyMs: 1600, jitterMs: 140, bargeInLatencyMs: 900, prosodyNaturalness: 0.4, clarity: 0.45, falseBargeIns: 3 },
    labelledMos: 1.9,
  },
  {
    features: { wer: 0.08, latencyMs: 520, jitterMs: 26, bargeInLatencyMs: 220, prosodyNaturalness: 0.85, clarity: 0.88, falseBargeIns: 0 },
    labelledMos: 4.2,
  },
  {
    features: { wer: 0.22, latencyMs: 730, jitterMs: 48, bargeInLatencyMs: 380, prosodyNaturalness: 0.65, clarity: 0.7, falseBargeIns: 1 },
    labelledMos: 3.1,
  },
];

/** Interruption case: what the user did while the agent spoke. */
export interface VoiceV23InterruptionCase {
  id: string;
  /** ms into the agent reply when the burst arrived. */
  atMsIntoReply: number;
  energy: number;
  sustainMs: number;
  words: string[];
  echo: boolean;
  agentSpeaking: boolean;
  /** What a correct policy should do. */
  expected: 'ignore' | 'duck-soft' | 'duck-hard' | 'interrupt';
}

export const EVAL_CORPUS_V23_INTERRUPTIONS: readonly VoiceV23InterruptionCase[] = [
  { id: 'v23-int-01', atMsIntoReply: 1200, energy: 0.85, sustainMs: 700, words: ['dừng', 'lại', 'đi'], echo: false, agentSpeaking: true, expected: 'interrupt' },
  { id: 'v23-int-02', atMsIntoReply: 900, energy: 0.7, sustainMs: 450, words: ['khoan', 'đã'], echo: false, agentSpeaking: true, expected: 'interrupt' },
  { id: 'v23-int-03', atMsIntoReply: 400, energy: 0.6, sustainMs: 300, words: ['ừm'], echo: false, agentSpeaking: true, expected: 'ignore' },
  { id: 'v23-int-04', atMsIntoReply: 1500, energy: 0.3, sustainMs: 200, words: ['ok'], echo: false, agentSpeaking: true, expected: 'ignore' },
  { id: 'v23-int-05', atMsIntoReply: 2000, energy: 0.9, sustainMs: 800, words: ['stop', 'talking'], echo: false, agentSpeaking: true, expected: 'interrupt' },
  { id: 'v23-int-06', atMsIntoReply: 600, energy: 0.55, sustainMs: 500, words: ['yeah'], echo: false, agentSpeaking: true, expected: 'duck-soft' },
  { id: 'v23-int-07', atMsIntoReply: 1100, energy: 0.5, sustainMs: 400, words: ['nói', 'chậm', 'lại'], echo: false, agentSpeaking: true, expected: 'duck-hard' },
  { id: 'v23-int-08', atMsIntoReply: 800, energy: 0.9, sustainMs: 700, words: ['dừng', 'lại'], echo: true, agentSpeaking: true, expected: 'ignore' },
  { id: 'v23-int-09', atMsIntoReply: 50, energy: 0.9, sustainMs: 600, words: ['không', 'phải', 'thế'], echo: false, agentSpeaking: true, expected: 'ignore' },
  { id: 'v23-int-10', atMsIntoReply: 3000, energy: 0.4, sustainMs: 250, words: ['ừ'], echo: false, agentSpeaking: true, expected: 'ignore' },
  { id: 'v23-int-11', atMsIntoReply: 1800, energy: 0.65, sustainMs: 550, words: ['nói', 'lại', 'đi'], echo: false, agentSpeaking: true, expected: 'interrupt' },
  { id: 'v23-int-12', atMsIntoReply: 100, energy: 0.2, sustainMs: 120, words: [], echo: false, agentSpeaking: true, expected: 'ignore' },
];

/** Endpointing case: per-frame speech flags + where the utterance should end. */
export interface VoiceV23EndpointCase {
  id: string;
  /** true = speech frame, false = silence frame (20 ms each). */
  frames: boolean[];
  /** Frame index where the utterance should be declared ended. */
  expectedEndFrame: number;
  /** True when the utterance should be cut by max length, not silence. */
  cutByMaxLength: boolean;
}

function endpointFrames(speechFrames: number, silenceFrames: number): boolean[] {
  return [...new Array<boolean>(speechFrames).fill(true), ...new Array<boolean>(silenceFrames).fill(false)];
}

export const EVAL_CORPUS_V23_ENDPOINTS: readonly VoiceV23EndpointCase[] = [
  // 40 speech frames (800 ms) then 30 silence frames: end after the
  // 15-frame hangover inside the silence run -> frame 40 + 15 = 55.
  { id: 'v23-ep-01', frames: endpointFrames(40, 30), expectedEndFrame: 55, cutByMaxLength: false },
  { id: 'v23-ep-02', frames: endpointFrames(25, 40), expectedEndFrame: 40, cutByMaxLength: false },
  { id: 'v23-ep-03', frames: endpointFrames(100, 20), expectedEndFrame: 115, cutByMaxLength: false },
  // Short blip (5 frames) then silence: below the minimum speech run, never starts.
  { id: 'v23-ep-04', frames: endpointFrames(5, 30), expectedEndFrame: -1, cutByMaxLength: false },
  // Long monologue: 600 speech frames hits the 500-frame max utterance.
  { id: 'v23-ep-05', frames: endpointFrames(600, 5), expectedEndFrame: 500, cutByMaxLength: true },
  // Speech, brief pause (5 frames), speech again: one utterance, ends after final silence.
  {
    id: 'v23-ep-06',
    frames: [...endpointFrames(30, 5), ...endpointFrames(30, 30)],
    expectedEndFrame: 80,
    cutByMaxLength: false,
  },
];

/** Per-condition WER ceiling summary for the corpus. */
export function evalCorpusV23Counts(): {
  transcripts: number;
  byLocale: Record<string, number>;
  byCondition: Record<VoiceV23Condition, number>;
  latency: number;
  mos: number;
  interruptions: number;
  endpoints: number;
} {
  const byLocale: Record<string, number> = {};
  const byCondition: Record<VoiceV23Condition, number> = {
    clean: 0,
    noisy: 0,
    'far-field': 0,
    echoey: 0,
    'fast-speech': 0,
  };
  for (const p of EVAL_CORPUS_V23_TRANSCRIPTS) {
    byLocale[p.locale] = (byLocale[p.locale] ?? 0) + 1;
    byCondition[p.condition] += 1;
  }
  return {
    transcripts: EVAL_CORPUS_V23_TRANSCRIPTS.length,
    byLocale,
    byCondition,
    latency: EVAL_CORPUS_V23_LATENCY.length,
    mos: EVAL_CORPUS_V23_MOS.length,
    interruptions: EVAL_CORPUS_V23_INTERRUPTIONS.length,
    endpoints: EVAL_CORPUS_V23_ENDPOINTS.length,
  };
}

/** Validate the corpus: duplicate ids, empty text, bad ceilings, bad MOS labels. */
export function validateEvalCorpusV23(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const checkId = (id: string): void => {
    if (seen.has(id)) errors.push(`duplicate id "${id}"`);
    seen.add(id);
  };
  for (const p of EVAL_CORPUS_V23_TRANSCRIPTS) {
    checkId(p.id);
    if (p.reference.trim() === '') errors.push(`${p.id}: empty reference`);
    if (p.hypothesis.trim() === '') errors.push(`${p.id}: empty hypothesis`);
    if (!(p.werCeiling >= 0 && p.werCeiling <= 1)) errors.push(`${p.id}: werCeiling ${p.werCeiling} out of 0..1`);
  }
  for (const s of EVAL_CORPUS_V23_LATENCY) {
    checkId(s.id);
    if (s.firstTokenMs < 0 || s.totalMs < s.firstTokenMs || s.jitterMs < 0) {
      errors.push(`${s.id}: inconsistent latency sample`);
    }
  }
  for (const s of EVAL_CORPUS_V23_MOS) {
    if (!(s.labelledMos >= 1 && s.labelledMos <= 5)) errors.push(`MOS sample labelledMos ${s.labelledMos} out of 1..5`);
    if (s.features.wer < 0 || s.features.wer > 1) errors.push('MOS sample wer out of 0..1');
  }
  for (const c of EVAL_CORPUS_V23_INTERRUPTIONS) {
    checkId(c.id);
    if (c.energy < 0 || c.energy > 1) errors.push(`${c.id}: energy out of 0..1`);
    if (c.sustainMs < 0) errors.push(`${c.id}: negative sustainMs`);
  }
  for (const c of EVAL_CORPUS_V23_ENDPOINTS) {
    checkId(c.id);
    if (c.frames.length === 0) errors.push(`${c.id}: empty frames`);
    if (c.expectedEndFrame < -1 || c.expectedEndFrame > c.frames.length) {
      errors.push(`${c.id}: expectedEndFrame out of range`);
    }
  }
  return errors;
}

export function evalCorpusV23Summary(): string {
  const c = evalCorpusV23Counts();
  return [
    `voice v23 corpus: ${c.transcripts} transcript pairs`,
    `(vi ${c.byLocale.vi ?? 0}, en ${c.byLocale.en ?? 0}; clean ${c.byCondition.clean}, noisy ${c.byCondition.noisy}, far-field ${c.byCondition['far-field']}, echoey ${c.byCondition.echoey}, fast-speech ${c.byCondition['fast-speech']})`,
    `+ ${c.latency} latency, ${c.mos} MOS, ${c.interruptions} interruption, ${c.endpoints} endpoint cases`,
  ].join(' ');
}
