/**
 * Memory v24 — ADD-only extraction (v1.39, Doi T1).
 *
 * Y tuong Mem0 v3 (chi y tuong): bo pass LLM thu hai; chi add,
 * khong quyet dinh overwrite luc ghi — fact moi nam canh fact
 * cu, retrieval tu phan xu cai nao con dung. Y tuong Graphiti
 * (chi y tuong): fact co valid-time — biet fact dung khi nao.
 *
 * Tu thiet ke lai hoan toan cho open-bot, rule-based, chay local:
 *  - 1 pass duy nhat tren cac turn: tach cau -> loc noise ->
 *    phan loai kind -> trich triple (subject, edge, object) ->
 *    suy valid-time tu cum tu thoi gian (vi + en) -> confidence
 *    -> dedupe trong pass.
 *  - KHONG bao gio sua/xoa fact cu trong luc trich xuat: output
 *    chi la candidate; moi thay doi deu di qua conflict resolver
 *    (conflicts.ts) co provenance.
 *  - Negation: "khong con thich X", "no longer likes X" ->
 *    isNegation=true de resolver xu ly (khong tu dong invalid).
 *  - Entity: trich ten rieng (chu hoa giua cau) + tu khoa sau
 *    gioi tu ("o Ha Noi", "in Paris") de fusion dung sau.
 */
import {
  clamp01V24,
  normalizeTextV24,
  type V24EdgeType,
  type V24ExtractedFact,
  type V24ExtractionResult,
  type V24RecordKind,
  V24_DEFAULT_MIN_CONFIDENCE,
  V24_EXTRACTOR_VERSION,
  V24_MAX_OBJECT_CHARS,
  V24_MAX_SOURCE_TEXT_CHARS,
} from './types';

/** Mot turn hoi thoai dau vao. */
export interface V24Turn {
  role: 'user' | 'agent' | 'system';
  text: string;
}

/** Cau hoi / chao hoi / cam on -> noise, khong trich. */
const NOISE_PATTERNS: RegExp[] = [
  /^(xin chao|chao|hi|hello|hey|good (morning|afternoon|evening))\b/i,
  /^(cam on|thanks|thank you|cảm ơn)\b/i,
  /^(ok|okay|duoc|được|uh|ừ|vâng|yes|no)\s*[.!?]*$/i,
  /\?$/,
  /^(ban co the|can you|please|lam on|hãy|hay)\b/i,
  /^(tam biet|bye|goodbye|good night)\b/i,
];

/** Pattern trich triple: [subject] [verb-phrase] [object]. */
interface V24TriplePattern {
  re: RegExp;
  edge: V24EdgeType;
  kind: V24RecordKind;
  /** Nhom regex nao la object (mac dinh nhom cuoi). */
  objectGroup: number;
  /** Nhom regex nao la subject (0 = user). */
  subjectGroup: number;
  confidence: number;
  reason: string;
}

const TRIPLE_PATTERNS: V24TriplePattern[] = [
  // Tieng Viet — so thich.
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+không còn thích\s+(.+)/i, edge: 'prefers', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.7, reason: 'khong con thich (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+thích\s+(.+)/i, edge: 'prefers', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.85, reason: 'thich (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+không thích\s+(.+)/i, edge: 'dislikes', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.85, reason: 'khong thich (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+ghét\s+(.+)/i, edge: 'dislikes', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.8, reason: 'ghet (vi)' },
  // Tieng Viet — noi o / lam viec / hoc.
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+không còn sống ở\s+(.+)/i, edge: 'lives_in', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.7, reason: 'khong con song o (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+sống ở\s+(.+)/i, edge: 'lives_in', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.9, reason: 'song o (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+ở\s+(.+)/i, edge: 'lives_in', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.55, reason: 'o (vi, yeu)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+làm (?:việc )?(?:ở|tại)\s+(.+)/i, edge: 'works_at', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.9, reason: 'lam viec o (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+là\s+(.+)/i, edge: 'works_as', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.6, reason: 'la (vi, yeu)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+học (?:ở|tại)\s+(.+)/i, edge: 'studies_at', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.85, reason: 'hoc o (vi)' },
  // Tieng Viet — so huu / muc tieu / ngon ngu.
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+có\s+(.+)/i, edge: 'owns', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.6, reason: 'co (vi, yeu)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+nói (?:được )?(.+)/i, edge: 'speaks', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.8, reason: 'noi (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+muốn\s+(.+)/i, edge: 'has_goal', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.6, reason: 'muon (vi)' },
  { re: /(?:tôi|tớ|mình|em|anh|chị|tui)\s+dùng\s+(.+)/i, edge: 'uses', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.7, reason: 'dung (vi)' },
  // Tieng Viet — quyet dinh / du an.
  { re: /(?:chúng ta|chúng tôi|team|nhóm)\s+(?:đã )?quyết định\s+(?:dùng|chọn|sử dụng)\s+(.+)/i, edge: 'uses', kind: 'decision', objectGroup: 1, subjectGroup: 0, confidence: 0.9, reason: 'quyet dinh dung (vi)' },
  { re: /dự án\s+(.+?)\s+(?:dùng|sử dụng)\s+(.+)/i, edge: 'uses', kind: 'project', objectGroup: 2, subjectGroup: 1, confidence: 0.75, reason: 'du an dung (vi)' },
  // Tieng Anh — so thich.
  { re: /\bI no longer like\s+(.+)/i, edge: 'prefers', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.7, reason: 'no longer like (en)' },
  { re: /\bI (?:really )?(like|love|prefer)\s+(.+)/i, edge: 'prefers', kind: 'preference', objectGroup: 2, subjectGroup: 0, confidence: 0.85, reason: 'like/love (en)' },
  { re: /\bI (?:do not|don't|dont) like\s+(.+)/i, edge: 'dislikes', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.85, reason: 'dont like (en)' },
  { re: /\bI hate\s+(.+)/i, edge: 'dislikes', kind: 'preference', objectGroup: 1, subjectGroup: 0, confidence: 0.8, reason: 'hate (en)' },
  // Tieng Anh — noi o / lam viec / hoc.
  { re: /\bI live in\s+(.+)/i, edge: 'lives_in', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.9, reason: 'live in (en)' },
  { re: /\bI work (?:at|for)\s+(.+)/i, edge: 'works_at', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.9, reason: 'work at (en)' },
  { re: /\bI am a[n]?\s+(.+)/i, edge: 'works_as', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.65, reason: 'am a (en)' },
  { re: /\bI study at\s+(.+)/i, edge: 'studies_at', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.85, reason: 'study at (en)' },
  { re: /\bI (?:own|have)\s+(?:a |an |the )?(.+)/i, edge: 'owns', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.6, reason: 'own/have (en)' },
  { re: /\bI speak\s+(.+)/i, edge: 'speaks', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.8, reason: 'speak (en)' },
  { re: /\bI want to\s+(.+)/i, edge: 'has_goal', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.6, reason: 'want to (en)' },
  { re: /\bI use\s+(.+)/i, edge: 'uses', kind: 'fact', objectGroup: 1, subjectGroup: 0, confidence: 0.7, reason: 'use (en)' },
  { re: /\bwe decided to use\s+(.+)/i, edge: 'uses', kind: 'decision', objectGroup: 1, subjectGroup: 0, confidence: 0.9, reason: 'decided to use (en)' },
];

/** Pattern phu dinh: fact moi phu dinh fact cu. */
const NEGATION_PATTERNS: RegExp[] = [
  /không còn/i, /không nữa/i, /no longer/i, /not anymore/i, /don't .* anymore/i, /đã (bỏ|ngừng|dừng)/i,
];

/** Pattern procedure: "buoc 1 ... buoc 2 ..." / "step 1 ...". */
const PROCEDURE_PATTERNS: RegExp[] = [
  /(?:bước|buoc)\s*\d/i, /(?:step)\s*\d/i, /cách làm:/i, /các bước:/i,
];

/** Cum tu thoi gian -> valid-time (tuong doi theo nowMs). */
interface V24TimeCue {
  re: RegExp;
  fromOffsetMs: number | null;
  toOffsetMs: number | null;
}

const DAY = 24 * 3600 * 1000;
const TIME_CUES: V24TimeCue[] = [
  { re: /từ nay|hiện tại|hien tai|bây giờ|bay gio|from now|currently|nowadays/i, fromOffsetMs: 0, toOffsetMs: null },
  { re: /trước đây|truoc day|trước kia|used to|previously|before/i, fromOffsetMs: null, toOffsetMs: 0 },
  { re: /từ (?:tháng|thang)\s*\d+/i, fromOffsetMs: -30 * DAY, toOffsetMs: null },
  { re: /đến (?:tháng|thang)\s*\d+|until (?:june|july|december|january)/i, fromOffsetMs: null, toOffsetMs: 180 * DAY },
  { re: /trong (?:năm|nam) nay|this year/i, fromOffsetMs: -180 * DAY, toOffsetMs: 180 * DAY },
  { re: /tuần này|tuan nay|this week/i, fromOffsetMs: -7 * DAY, toOffsetMs: 7 * DAY },
];

/** Ngay tuyet doi ISO trong text: YYYY-MM-DD. */
const ISO_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

/** Suy valid-time tu text (tuong doi theo nowMs). */
export function inferValidTimeV24(
  text: string,
  nowMs: number,
): { validFrom: string | null; validTo: string | null } {
  const abs = ISO_DATE_RE.exec(text);
  if (abs) {
    const d = new Date(`${abs[1]}-${abs[2]}-${abs[3]}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) {
      return { validFrom: d.toISOString(), validTo: null };
    }
  }
  for (const cue of TIME_CUES) {
    if (cue.re.test(text)) {
      return {
        validFrom: cue.fromOffsetMs === null ? null : new Date(nowMs + cue.fromOffsetMs).toISOString(),
        validTo: cue.toOffsetMs === null ? null : new Date(nowMs + cue.toOffsetMs).toISOString(),
      };
    }
  }
  return { validFrom: null, validTo: null };
}

/** Tach turn thanh cac cau (giữ dau cau de phan biet cau hoi). */
export function splitSentencesV24(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Cau co phai noise khong (chao hoi / cam on / cau hoi / qua ngan).
 *  So pattern tren text da chuan hoa (strip dau) de "Xin chào" hay
 *  "Cảm ơn" deu nhan ra. */
export function isNoiseSentenceV24(sentence: string): boolean {
  const s = sentence.trim();
  if (s.length < 4) return true;
  const words = s.split(/\s+/).length;
  if (words < 2) return true;
  if (/\?$/.test(s)) return true;
  const n = normalizeTextV24(s);
  return NOISE_PATTERNS.some((re) => re.test(n));
}

/** Trich ten rieng (entity) trong cau: tu viet hoa giua cau + sau gioi tu. */
export function extractEntitiesV24(sentence: string): string[] {
  const entities: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const n = name.trim().replace(/[.,;:!?]+$/, '');
    if (n.length < 2 || n.length > 60) return;
    if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      entities.push(n);
    }
  };
  // Tu viet hoa (khong phai dau cau), co the la cu 2-3 tu.
  const capRe = /(?:^|[\s(])([A-ZÀ-Ỹ][a-zà-ỹ]+(?:\s+[A-ZÀ-Ỹ][a-zà-ỹ]+){0,2})/g;
  let m: RegExpExecArray | null;
  while ((m = capRe.exec(sentence)) !== null) {
    if (m.index === 0) continue; // bo tu dau cau (viet hoa do dau cau).
    add(m[1]);
  }
  // Sau gioi tu dia diem / to chuc.
  const prepRe = /(?:ở|tại|o|in|at)\s+([A-ZÀ-Ỹ][\wà-ỹÀ-Ỹ]+(?:\s+[A-ZÀ-Ỹ][\wà-ỹÀ-Ỹ]+){0,2})/g;
  while ((m = prepRe.exec(sentence)) !== null) add(m[1]);
  return entities;
}

/** Lam sach object: bo dau cau thua, cat ngan. */
function cleanObjectV24(raw: string): string {
  let o = raw.trim().replace(/[.,;:!?]+$/, '').trim();
  o = o.replace(/^(là|la|is|a|an|the)\s+/i, '');
  if (o.length > V24_MAX_OBJECT_CHARS) o = o.slice(0, V24_MAX_OBJECT_CHARS);
  return o;
}

/** Trich candidate tu 1 cau (null neu khong khop pattern nao). */
export function extractFromSentenceV24(
  sentence: string,
  nowMs: number,
  opts: { minConfidence?: number } = {},
): V24ExtractedFact | null {
  const minConfidence = opts.minConfidence ?? V24_DEFAULT_MIN_CONFIDENCE;
  const isNegation = NEGATION_PATTERNS.some((re) => re.test(sentence));
  const time = inferValidTimeV24(sentence, nowMs);
  const entities = extractEntitiesV24(sentence);
  for (const pattern of TRIPLE_PATTERNS) {
    const m = pattern.re.exec(sentence);
    if (!m) continue;
    const object = cleanObjectV24(m[pattern.objectGroup] ?? '');
    if (!object || object.length < 2) continue;
    let subject = 'user';
    if (pattern.subjectGroup > 0 && m[pattern.subjectGroup]) {
      subject = m[pattern.subjectGroup].trim().slice(0, 200);
    }
    let confidence = pattern.confidence;
    if (isNegation) confidence = Math.min(confidence, 0.7);
    if (confidence < minConfidence) return null;
    return {
      subject,
      edge: pattern.edge,
      object,
      kind: pattern.kind,
      confidence: clamp01V24(confidence),
      isNegation,
      validFrom: time.validFrom,
      validTo: time.validTo,
      mentionedEntities: entities,
      sourceText: sentence.slice(0, V24_MAX_SOURCE_TEXT_CHARS),
      reason: `${pattern.reason}${isNegation ? ' + negation' : ''} (rule ${V24_EXTRACTOR_VERSION})`,
    };
  }
  // Procedure: cau mo ta cac buoc, khong co triple ro rang.
  if (PROCEDURE_PATTERNS.some((re) => re.test(sentence))) {
    return {
      subject: 'user',
      edge: 'uses',
      object: cleanObjectV24(sentence),
      kind: 'procedure',
      confidence: 0.6,
      isNegation,
      validFrom: time.validFrom,
      validTo: time.validTo,
      mentionedEntities: entities,
      sourceText: sentence.slice(0, V24_MAX_SOURCE_TEXT_CHARS),
      reason: `procedure steps (rule ${V24_EXTRACTOR_VERSION})`,
    };
  }
  return null;
}

/** Trich xuat ADD-only 1 pass tren cac turn. */
export function extractV24Candidates(
  turns: V24Turn[],
  opts: { minConfidence?: number; nowMs?: number } = {},
): V24ExtractionResult {
  const started = Date.now();
  const nowMs = opts.nowMs ?? started;
  const candidates: V24ExtractedFact[] = [];
  const seen = new Set<string>();
  let noiseTurns = 0;
  let dedupedWithinPass = 0;
  let belowThreshold = 0;
  for (const turn of turns) {
    if (!turn.text || !turn.text.trim()) {
      noiseTurns++;
      continue;
    }
    const sentences = splitSentencesV24(turn.text);
    let turnHadCandidate = false;
    for (const sentence of sentences) {
      if (isNoiseSentenceV24(sentence)) continue;
      const candidate = extractFromSentenceV24(sentence, nowMs, opts);
      if (!candidate) continue;
      if (candidate.confidence < (opts.minConfidence ?? V24_DEFAULT_MIN_CONFIDENCE)) {
        belowThreshold++;
        continue;
      }
      const key = normalizeTextV24(`${candidate.subject}|${candidate.edge}|${candidate.object}`);
      if (seen.has(key)) {
        dedupedWithinPass++;
        continue;
      }
      seen.add(key);
      candidates.push(candidate);
      turnHadCandidate = true;
    }
    if (!turnHadCandidate && sentences.every((s) => isNoiseSentenceV24(s))) noiseTurns++;
  }
  return {
    candidates,
    noiseTurns,
    dedupedWithinPass,
    belowThreshold,
    blockedByAdmission: 0,
    elapsedMs: Date.now() - started,
  };
}
