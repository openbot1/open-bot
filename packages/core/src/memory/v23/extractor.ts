/**
 * Memory v23 — extractor (v1.38, Doi T1).
 *
 * Mem0-style extract, chay local bang luat (khong goi model):
 * tach hoi thoai thanh cau -> loc nhieu (noise) -> phan loai
 * kind + danh gia confidence -> trich entity.
 *
 * Luat phan loai (tieng Viet + tieng Anh, mo rong duoc qua
 * `extraPatterns`):
 *  - preference: "thich / ghet / muon / khong thich / prefer / love / hate / want"
 *  - decision: "quyet dinh / chon / se dung / decided / decided to / will use"
 *  - procedure: "buoc / cach lam / quy trinh / step / how to / first ... then"
 *  - person: cau co ten rieng + dong tu lien he (la / is / lam ...)
 *  - project: cau nhac ten du an / repo / he thong + trang thai
 *  - fact: mac dinh khi cau co chu the + vi ngu day du
 *  - noise: chao hoi, cam on, xac nhan ngan, cau hoi khong co noi
 *    dung luu duoc, cau qua ngan / qua dai, lap lai.
 *
 * Confidence: diem co so theo kind + cong khi co entity, so lieu,
 * ngay thang; tru khi cau mo ho ("co le", "maybe"), phu dinh
 * khong ro rang. Muc dich la recall cao, precision duoc
 * consolidator lo sau (quyet dinh noise/drop).
 */

import { extractEntitiesV23 } from './entityIndex';
import { contentTokensV23, normalizeV23Text } from './types';
import type { V23ExtractCandidate, V23RecordKind } from './types';

/** Mot tin nhan trong hoi thoai (dau vao extract). */
export interface V23ChatMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
}

/** Pattern bo sung cua caller: { kind, regex, confidenceBoost }. */
export interface V23ExtraPattern {
  kind: V23RecordKind;
  pattern: RegExp;
  boost: number;
}

/** Tuy chon extractor. */
export interface V23ExtractorOptions {
  /** Do dai cau toi thieu (ky tu) de xet (mac dinh 12). */
  minSentenceLength?: number;
  /** Do dai cau toi da (ky tu) de xet (mac dinh 500). */
  maxSentenceLength?: number;
  /** Confidence toi thieu de tra ung vien (mac dinh 0.3). */
  minConfidence?: number;
  /** Pattern bo sung (vd ten du an rieng cua user). */
  extraPatterns?: V23ExtraPattern[];
  /** Tu khoa entity bo sung (truyen xuong entityIndex). */
  extraEntityKeywords?: string[];
}

/** Mau cau noise: chao hoi / cam on / xac nhan / cau hoi rong. */
const NOISE_PATTERNS: RegExp[] = [
  /^(chao|hi|hello|hey|xin chao|good\s+(morning|afternoon|evening))\b/i,
  /^(cam on|thanks?|thank you|cảm ơn)\b/i,
  /^(ok|oke|okay|duoc|được|vâng|vang|uh|ừ|ừm|hm+|ah+)\.?$/i,
  /^(tạm biệt|tam biet|bye|goodbye|see you)\b/i,
  /^(bạn có nghe|ban co nghe|are you (there|ready))\b/i,
  /^\?+$/,
  /^(giúp tôi|giup toi|help me)\.?$/i,
  /^(làm ơn|lam on|please)\.?$/i,
];

/** Tu mo ho — tru confidence. */
const HEDGE_WORDS = [
  'co le', 'co the', 'maybe', 'perhaps', 'possibly', 'hinh nhu',
  'khong chac', 'not sure', 'tạm', 'tam', 'dang suy nghi',
];

/** Tu chi so lieu / ngay thang — cong confidence (fact cu the). */
const CONCRETE_PATTERNS: RegExp[] = [
  /\b\d+(\.\d+)?\s*(%|usd|vnd|gb|mb|ms|giay|phut|gio|ngay|tuan|thang|nam)\b/i,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(version|v\d+\.\d+|bản \d+|ban \d+)\b/i,
];

/** Rule phan loai theo thu tu uu tien (kind dau tien khop se thang). */
interface V23KindRule {
  kind: V23RecordKind;
  patterns: RegExp[];
  base: number;
}

const KIND_RULES: V23KindRule[] = [
  {
    kind: 'preference',
    base: 0.75,
    patterns: [
      /\b(thich|ghét|ghet|không thích|khong thich|muốn|muon|ưa|ua|khoái|khoai)\b/i,
      /\b(prefer|love|like|hate|dislike|want|enjoy|favourite|favorite)\b/i,
      /\bto (thích|thich|ghét|ghet) (nhất|nhat|hon)\b/i,
    ],
  },
  {
    kind: 'decision',
    base: 0.8,
    patterns: [
      /\b(quyết định|quyet dinh|đã chọn|da chon|sẽ dùng|se dung|chốt|chot|quyết|quyet)\b/i,
      /\b(decided|decision|chose|chosen|will use|going with|settled on)\b/i,
      /\bthay vì (dùng|sử dụng|dung|su dung)\b/i,
    ],
  },
  {
    kind: 'procedure',
    base: 0.75,
    patterns: [
      /\b(bước \d+|buoc \d+|cách làm|cach lam|quy trình|quy trinh|các bước|cac buoc)\b/i,
      /\b(step \d+|how to|first .* then|to do this,)\b/i,
      /\b(trước tiên|truoc tien|sau đó|sau do|cuối cùng|cuoi cung)\b.*\b(rồi|roi|thì|thi)\b/i,
    ],
  },
  {
    kind: 'person',
    base: 0.7,
    patterns: [
      /\b(là (trưởng|truong|giám đốc|giam doc|quản lý|quan ly|kỹ sư|ky su|người|nguoi))\b/i,
      /\b(is (the )?(lead|manager|director|engineer|owner|author))\b/i,
      /\b(tên là|ten la|tên đầy đủ|ten day du|gọi là|goi la)\b/i,
    ],
  },
  {
    kind: 'project',
    base: 0.7,
    patterns: [
      /\b(dự án|du an|repo|repository|hệ thống|he thong|dịch vụ|dich vu|module)\b/i,
      /\b(project|service|system|codebase|pipeline)\b/i,
    ],
  },
];

/** Tach text thanh cau (giữ dấu ., !, ?; cat theo xuong dong). */
export function splitSentencesV23(text: string): string[] {
  const out: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ỹ0-9"“])/u);
    for (const part of parts) {
      const sentence = normalizeV23Text(part);
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

/** Cau co phai noise khong (tra ly do, '' = khong phai noise). */
export function noiseReasonV23(sentence: string): string {
  const s = sentence.trim();
  if (s.length < 8) return 'qua ngan';
  if (s.length > 1200) return 'qua dai';
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(s)) return 'chao hoi / cam on / xac nhan';
  }
  // Cau hoi khong co noi dung luu duoc (khong co menh de khang dinh).
  if (/^[A-ZÀ-Ỹ]?.*\?\s*$/.test(s) && !/\b(la|is|thich|prefer|quyet|decided)\b/i.test(s)) {
    return 'cau hoi khong co fact';
  }
  return '';
}

/** Phan loai kind + confidence co so cho mot cau. */
export function classifySentenceV23(
  sentence: string,
  extraPatterns: V23ExtraPattern[] = [],
): { kind: V23RecordKind; confidence: number; reason: string } {
  for (const extra of extraPatterns) {
    if (extra.pattern.test(sentence)) {
      return {
        kind: extra.kind,
        confidence: Math.min(0.95, 0.7 + extra.boost),
        reason: `khop pattern bo sung (${extra.kind})`,
      };
    }
  }
  for (const rule of KIND_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(sentence)) {
        return { kind: rule.kind, confidence: rule.base, reason: `khop rule ${rule.kind}` };
      }
    }
  }
  // Mac dinh: fact neu co it nhat 4 token co nghia.
  const tokens = contentTokensV23(sentence);
  if (tokens.length >= 4) {
    return { kind: 'fact', confidence: 0.55, reason: 'cau khang dinh co du token' };
  }
  return { kind: 'fact', confidence: 0.3, reason: 'cau ngan, confidence thap' };
}

/** Dieu chinh confidence theo dac diem cau (entity, so lieu, mo ho). */
export function adjustConfidenceV23(
  sentence: string,
  base: number,
  entityCount: number,
): number {
  let score = base;
  if (entityCount > 0) score += 0.08;
  if (entityCount >= 2) score += 0.05;
  for (const pattern of CONCRETE_PATTERNS) {
    if (pattern.test(sentence)) {
      score += 0.07;
      break;
    }
  }
  const lowered = sentence.toLowerCase();
  for (const hedge of HEDGE_WORDS) {
    if (lowered.includes(hedge)) {
      score -= 0.12;
      break;
    }
  }
  // Phu dinh ro rang ("khong", "never") khong tru — no la fact co gia tri.
  if (score > 0.95) score = 0.95;
  if (score < 0.05) score = 0.05;
  return Math.round(score * 100) / 100;
}

/**
 * Trich ung vien tu mot hoi thoai. Thu tu: user truoc, agent sau
 * (cau agent chi lay khi la decision/procedure/fact ro rang —
 * tranh ghi loi noi cua agent thanh so thich cua user).
 */
export function extractV23Candidates(
  messages: V23ChatMessage[],
  opts: V23ExtractorOptions = {},
): V23ExtractCandidate[] {
  const minLen = opts.minSentenceLength ?? 12;
  const maxLen = opts.maxSentenceLength ?? 500;
  const minConf = opts.minConfidence ?? 0.3;
  const extraPatterns = opts.extraPatterns ?? [];
  const extraKeywords = opts.extraEntityKeywords ?? [];
  const out: V23ExtractCandidate[] = [];
  const seen = new Set<string>();
  let sentenceIndex = 0;

  for (const message of messages) {
    const role = message.role === 'agent' ? 'agent' : message.role === 'system' ? 'system' : 'user';
    for (const sentence of splitSentencesV23(message.text)) {
      const currentIndex = sentenceIndex;
      sentenceIndex += 1;
      if (sentence.length < minLen || sentence.length > maxLen) continue;
      if (noiseReasonV23(sentence)) continue;
      const key = normalizeV23Text(sentence).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const classified = classifySentenceV23(sentence, extraPatterns);
      // Cau cua agent: chi giu decision/procedure/fact chac chan.
      if (role === 'agent' && classified.kind === 'preference') continue;
      if (role === 'agent' && classified.confidence < 0.6) continue;
      if (role === 'system' && classified.confidence < 0.7) continue;
      const entities = extractEntitiesV23(sentence, extraKeywords);
      const confidence = adjustConfidenceV23(sentence, classified.confidence, entities.length);
      if (confidence < minConf) continue;
      out.push({
        text: sentence,
        kind: classified.kind,
        confidence,
        entities,
        reason: classified.reason,
        sentenceIndex: currentIndex,
        speaker: role === 'system' ? 'system' : role,
      });
    }
  }
  return out;
}

/** Dem nhanh: so ung vien moi kind trong mot danh sach. */
export function countCandidatesByKindV23(
  candidates: V23ExtractCandidate[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}
