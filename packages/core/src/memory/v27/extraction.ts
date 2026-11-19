/**
 * Memory v27 — single-pass add-only extraction (v1.42, Doi T3).
 *
 * Y tuong hoc tu Mem0 v3 (survey v142 muc 3): add-only, single-pass
 * extraction — 1 lan quet text, khong UPDATE/DELETE. Tu thiet ke
 * lai hoan toan cho open-bot, rule-based chay local, khong goi
 * model/mang.
 *
 * Luong 1 pass duy nhat:
 *   text -> tach cau (1 lan) -> moi cau: khop pattern theo thu
 *   tu uu tien (pattern manh truoc, yeu sau) -> cau nao khop
 *   pattern dau tien thi DUNG, khong thu pattern khac cho cau do
 *   -> sinh toi da 1 candidate/cau/pattern.
 * Khong co pass 2 sua lai ket qua pass 1.
 *
 * Add-only:
 *   - Extractor CHI sinh candidate ADD. Khong co ham sua/xoa fact.
 *   - Fact trung y het edge active da co -> danh dau duplicate,
 *     lop graph se bo qua (khong them lai).
 *   - Fact moi cung (subject, predicate) nhung object khac ->
 *     danh dau supersedesId tro ve edge cu; lop graph ADD edge
 *     moi + DONG edge cu (set invalid_at/expired_at), khong sua
 *     edge cu.
 *   - Fact moi cung (subject, predicate, object) nhung validAt
 *     khac -> van la ADD moi (lich su giu ca 2, queryAt phan biet
 *     theo cua so valid).
 *
 * Pattern ho tro tieng Anh + tieng Viet (chu cai co dau).
 * Subject lay tu cum tu viet hoa / dai tu o dau cau; predicate
 * chuan hoa lowercase; object giu nguyen dang hien thi.
 */
import {
  DEFAULT_V27_EXTRACTOR_CONFIG,
  normalizeTextV27,
  tokenizeV27,
  truncateV27,
  type V27CandidateFact,
  type V27ExtractionResult,
  type V27ExtractorConfig,
} from './types';
import type { V25FactEdge } from '../v25/types';

/** 1 pattern trich xuat: regex + cach lay subject/predicate/object. */
interface V27Pattern {
  /** Ten pattern (hien trong candidate.pattern). */
  name: string;
  /** Regex khop 1 cau (co group 1 = subject, group 2 = object...). */
  regex: RegExp;
  /** Predicate chuan hoa khi pattern khop. */
  predicate: string;
  /** Do tin cay khi pattern khop (0..1). */
  confidence: number;
  /** Vi tri group subject trong regex (mac dinh 1). */
  subjectGroup?: number;
  /** Vi tri group object trong regex (mac dinh 2). */
  objectGroup?: number;
}

/**
 * Thu tu pattern = thu tu uu tien: pattern cu the truoc, pattern
 * chung sau. Cau chi khop pattern DAU TIEN (single-pass).
 */
const PATTERNS: V27Pattern[] = [
  // "Huy's favourite colour is blue" / "Mau yeu thich cua Huy la xanh"
  {
    name: 'favourite',
    regex: /^(.+?)'s\s+(?:favourite|favorite)\s+(.+?)\s+is\s+(.+)$/iu,
    predicate: 'favourite',
    confidence: 0.92,
    subjectGroup: 1,
    objectGroup: 3,
  },
  // "My name is Huy" / "Ten toi la Huy"
  {
    name: 'my-name-is',
    regex: /^(?:my|tên tôi|ten toi)\s+(?:name|tên|ten)\s+(?:is|là|la)\s+(.+)$/iu,
    predicate: 'name',
    confidence: 0.95,
    subjectGroup: 0,
    objectGroup: 1,
  },
  // "Ten toi la Huy" (khong lap lai tu "ten" lan 2)
  {
    name: 'my-name-is-vi',
    regex: /^(?:my\s+name|tên\s+tôi|ten\s+toi)\s+(?:is|là|la)\s+(.+)$/iu,
    predicate: 'name',
    confidence: 0.95,
    subjectGroup: 0,
    objectGroup: 1,
  },
  // "Huy was born in Hanoi" / "Huy sinh ra o Ha Noi"
  {
    name: 'born-in',
    regex: /^(.+?)\s+(?:was\s+born\s+in|born\s+in|sinh\s+(?:ra\s+)?(?:ở|o|tại|tai))\s+(.+)$/iu,
    predicate: 'born_in',
    confidence: 0.9,
  },
  // "Huy works at xAI" / "Huy lam viec tai xAI"
  {
    name: 'works-at',
    regex: /^(.+?)\s+(?:works?\s+(?:at|in|for)|làm việc\s+(?:tại|tai|ở|o)|lam\s+viec\s+(?:tai|o))\s+(.+)$/iu,
    predicate: 'works_at',
    confidence: 0.9,
  },
  // "Huy lives in Saigon" / "Huy song o Sai Gon"
  {
    name: 'lives-in',
    regex: /^(.+?)\s+(?:lives?\s+in|sống\s+(?:ở|o|tại|tai)|song\s+(?:o|tai))\s+(.+)$/iu,
    predicate: 'lives_in',
    confidence: 0.9,
  },
  // "Huy likes coffee" / "Huy thich ca phe" / "Huy loves X" / "Huy prefers X"
  {
    name: 'likes',
    regex: /^(.+?)\s+(?:likes?|loves?|prefers?|enjoys?|thích|thich|yêu thích|yeu\s+thich|ưa|ua)\s+(.+)$/iu,
    predicate: 'likes',
    confidence: 0.88,
  },
  // "Huy is a developer" / "Huy la lap trinh vien"
  {
    name: 'is-a',
    regex: /^(.+?)\s+(?:is|are|was|were|là|la)\s+(?:a\s+|an\s+|the\s+)?(.+)$/iu,
    predicate: 'is',
    confidence: 0.85,
  },
  // "Huy has a cat" / "Huy co mot con meo"
  {
    name: 'has',
    regex: /^(.+?)\s+(?:has|have|had|có|co)\s+(.+)$/iu,
    predicate: 'has',
    confidence: 0.85,
  },
  // "Huy's cat is Mimi" -> subject "Huy's cat", predicate is, object Mimi
  {
    name: 'possessive-is',
    regex: /^(.+?'s\s+.+?)\s+(?:is|are|là|la)\s+(.+)$/iu,
    predicate: 'is',
    confidence: 0.84,
  },
  // "Huy speaks Vietnamese" / "Huy noi tieng Viet"
  {
    name: 'speaks',
    regex: /^(.+?)\s+(?:speaks?|nói|noi)\s+(.+)$/iu,
    predicate: 'speaks',
    confidence: 0.85,
  },
  // "Huy uses VS Code" / "Huy dung VS Code"
  {
    name: 'uses',
    regex: /^(.+?)\s+(?:uses?|use|dùng|dung|sử dụng|su\s+dung)\s+(.+)$/iu,
    predicate: 'uses',
    confidence: 0.82,
  },
  // "Huy wants to build X" / "Huy muon xay X"
  {
    name: 'wants',
    regex: /^(.+?)\s+(?:wants?|want|muốn|muon)\s+(?:to\s+)?(.+)$/iu,
    predicate: 'wants',
    confidence: 0.8,
  },
  // "Huy: developer" — dang key: value
  {
    name: 'key-value',
    regex: /^([^:]{1,80}):\s+(.+)$/u,
    predicate: 'has_detail',
    confidence: 0.7,
  },
];

/** Cac tu mo dau cau khong phai subject (bo qua khi tach subject). */
const LEADING_FILLERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'tôi', 'toi', 'mình', 'minh', 'anh', 'chị', 'chi', 'em',
]);

/**
 * Tach text thanh cau (1 lan duy nhat — single-pass).
 * Cat theo dau cau . ! ? + xuong dong; cau qua dai thi cat ngan.
 */
export function splitSentencesV27(text: string, maxSentenceChars: number): string[] {
  const out: string[] = [];
  const parts = text.split(/(?<=[.!?\n])\s+/u);
  for (const raw of parts) {
    const sentence = raw.replace(/\s+/gu, ' ').trim().replace(/[.!?]+$/u, '').trim();
    if (!sentence) continue;
    // Cau qua dai: cat theo dau phay thanh manh nho hon.
    if (sentence.length > maxSentenceChars) {
      for (const chunk of sentence.split(/,\s+/u)) {
        const c = chunk.trim();
        if (c) out.push(truncateV27(c, maxSentenceChars));
      }
    } else {
      out.push(sentence);
    }
  }
  return out;
}

/**
 * Lay cum tu viet hoa trong cau — ung vien mention entity.
 * Bo tu dau cau viet hoa do dau cau (vd "The", "Toi") tru khi
 * cum co >= 2 tu viet hoa lien nhau.
 */
export function extractMentionsV27(sentence: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  // Cum 1-4 tu viet hoa lien nhau (ho tro tieng Viet co dau).
  const re = /\b([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂÂĐÊÔƠƯ][a-zàáâãèéêìíòóôõùúýăâđêôơưảấầẩẫậắằẳẵặẹẻẽềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]*(?:\s+[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂÂĐÊÔƠƯ][a-zàáâãèéêìíòóôõùúýăâđêôơưảấầẩẫậắằẳẵặẹẻẽềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]*){0,3})/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    const mention = (m[1] ?? '').trim();
    if (!mention || mention.length < 2) continue;
    const words = mention.split(/\s+/u);
    // 1 tu viet hoa o dau cau thi bo (co the chi la dau cau).
    if (words.length === 1 && sentence.startsWith(mention)) continue;
    if (LEADING_FILLERS.has(normalizeTextV27(words[0] ?? ''))) continue;
    const key = normalizeTextV27(mention);
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(mention);
  }
  return mentions;
}

/**
 * Lay mention entity trong 1 SEARCH QUERY — giong
 * extractMentionsV27 nhung GIU LAI tu viet hoa don o dau cau
 * (query thuong go ten entity ngay dau, vd "Huy likes coffee"
 * thi "Huy" la entity that, khong phai dau cau).
 */
export function extractQueryMentionsV27(query: string): string[] {
  const mentions = extractMentionsV27(query);
  const first = query.trim().split(/\s+/u)[0] ?? '';
  if (
    /^[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝĂÂĐÊÔƠƯ][a-zàáâãèéêìíòóôõùúýăâđêôơưảấầẩẫậắằẳẵặẹẻẽềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+$/u.test(first) &&
    !LEADING_FILLERS.has(normalizeTextV27(first)) &&
    !mentions.some((m) => normalizeTextV27(m) === normalizeTextV27(first))
  ) {
    mentions.unshift(first);
  }
  return mentions;
}

/** Chuan hoa subject: bo filler dau, cat ngan, giu hoa/thuong goc. */
function cleanSubjectV27(raw: string): string {
  let s = raw.trim().replace(/^(the|a|an)\s+/iu, '');
  // "my name" o pattern my-name-is da xu ly rieng; o day "my X" -> "user".
  if (/^my\s+/iu.test(s)) s = s.replace(/^my\s+/iu, 'user ');
  return truncateV27(s, 200);
}

/** Chuan hoa object: bo dau cau thua, cat ngan. */
function cleanObjectV27(raw: string): string {
  const s = raw.trim().replace(/^(a\s+|an\s+|the\s+)?/iu, (m) => m);
  return truncateV27(s.replace(/[.,;]+$/u, '').trim(), 500);
}

/**
 * Trich 1 candidate tu 1 cau: khop pattern DAU TIEN (uu tien
 * manh truoc). Tra null neu khong khop pattern nao.
 */
export function extractCandidateFromSentenceV27(
  sentence: string,
  config: V27ExtractorConfig,
): V27CandidateFact | null {
  const tokens = tokenizeV27(sentence);
  if (tokens.length < config.minSentenceTokens) return null;
  if (sentence.length < config.minSentenceChars) return null;
  for (const pattern of PATTERNS) {
    const m = pattern.regex.exec(sentence);
    if (!m) continue;
    const subjectGroup = pattern.subjectGroup ?? 1;
    const objectGroup = pattern.objectGroup ?? 2;
    let subject = '';
    if (subjectGroup === 0) {
      // Pattern my-name-is: subject mac dinh la user.
      subject = 'user';
    } else {
      subject = cleanSubjectV27(m[subjectGroup] ?? '');
    }
    const object = cleanObjectV27(m[objectGroup] ?? '');
    if (!subject || !object) continue;
    if (normalizeTextV27(subject) === normalizeTextV27(object)) continue;
    return {
      subject,
      predicate: pattern.predicate,
      object,
      confidence: pattern.confidence,
      sourceSentence: sentence,
      entityIds: [],
      pattern: pattern.name,
      supersedesId: '',
      supersedeReason: '',
    };
  }
  return null;
}

/**
 * Single-pass extraction tren toan bo text: 1 lan tach cau, moi
 * cau chi thu pattern 1 lan theo thu tu uu tien. Khong pass 2.
 *
 * `existingActive` (tuy chon): edge active hien co de danh dau
 * duplicate / supersede NGAY trong pass — khong can quet lai.
 */
export function extractTextV27(
  text: string,
  opts: {
    config?: Partial<V27ExtractorConfig>;
    /** Edge active hien co (de danh dau duplicate/supersede). */
    existingActive?: V25FactEdge[];
    /** Gioi han fact toi da (mac dinh 200). */
    maxFacts?: number;
  } = {},
): V27ExtractionResult {
  const startedAt = Date.now();
  const config: V27ExtractorConfig = {
    ...DEFAULT_V27_EXTRACTOR_CONFIG,
    ...(opts.config ?? {}),
  };
  const maxFacts = opts.maxFacts ?? 200;
  const sentences = splitSentencesV27(text, 2000);
  const candidates: V27CandidateFact[] = [];
  const seenCandidate = new Set<string>();
  let sentencesWithNoFact = 0;
  let duplicates = 0;
  let supersedes = 0;

  // Chi muc edge active theo (subject|predicate) — tra 1 lan.
  const activeByKey = new Map<string, V25FactEdge[]>();
  for (const edge of opts.existingActive ?? []) {
    const key = `${normalizeTextV27(edge.subject)}|${normalizeTextV27(edge.predicate)}`;
    const list = activeByKey.get(key) ?? [];
    list.push(edge);
    activeByKey.set(key, list);
  }

  for (const sentence of sentences) {
    if (candidates.length >= maxFacts) break;
    const candidate = extractCandidateFromSentenceV27(sentence, config);
    if (!candidate) {
      sentencesWithNoFact++;
      continue;
    }
    // Dedup trong chinh pass: cung (subject,predicate,object) thi bo.
    const candKey = [
      normalizeTextV27(candidate.subject),
      normalizeTextV27(candidate.predicate),
      normalizeTextV27(candidate.object),
    ].join('|');
    if (seenCandidate.has(candKey)) {
      duplicates++;
      continue;
    }
    seenCandidate.add(candKey);
    // Doi chieu edge active: trung y het -> duplicate; cung
    // subject+predicate, object khac -> supersede edge cu.
    const key = `${normalizeTextV27(candidate.subject)}|${normalizeTextV27(candidate.predicate)}`;
    const actives = activeByKey.get(key) ?? [];
    for (const edge of actives) {
      if (normalizeTextV27(edge.object) === normalizeTextV27(candidate.object)) {
        duplicates++;
        candidate.supersedesId = '';
        break;
      }
      if (!candidate.supersedesId) {
        candidate.supersedesId = edge.id;
        candidate.supersedeReason =
          `cung subject+predicate "${candidate.subject} ${candidate.predicate}", object khac ("${edge.object}" -> "${candidate.object}")`;
        supersedes++;
      }
    }
    // Candidate trung edge active thi khong dua vao danh sach them.
    const isDuplicate = actives.some(
      (e) => normalizeTextV27(e.object) === normalizeTextV27(candidate.object),
    );
    if (isDuplicate) continue;
    candidates.push(candidate);
  }

  return {
    sentencesScanned: sentences.length,
    candidates,
    entityLinks: [],
    sentencesWithNoFact,
    duplicates,
    supersedes,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Danh dau lai duplicate/supersede cho candidate khi edge active
 * thay doi sau luc trich (vd ingest dong loat). Khong sua noi
 * dung fact — chi set supersedesId/reason.
 */
export function annotateCandidatesV27(
  candidates: V27CandidateFact[],
  existingActive: V25FactEdge[],
): { duplicates: number; supersedes: number } {
  let duplicates = 0;
  let supersedes = 0;
  const activeByKey = new Map<string, V25FactEdge[]>();
  for (const edge of existingActive) {
    const key = `${normalizeTextV27(edge.subject)}|${normalizeTextV27(edge.predicate)}`;
    const list = activeByKey.get(key) ?? [];
    list.push(edge);
    activeByKey.set(key, list);
  }
  for (const candidate of candidates) {
    const key = `${normalizeTextV27(candidate.subject)}|${normalizeTextV27(candidate.predicate)}`;
    const actives = activeByKey.get(key) ?? [];
    candidate.supersedesId = '';
    candidate.supersedeReason = '';
    for (const edge of actives) {
      if (normalizeTextV27(edge.object) === normalizeTextV27(candidate.object)) {
        duplicates++;
        break;
      }
      if (!candidate.supersedesId) {
        candidate.supersedesId = edge.id;
        candidate.supersedeReason =
          `cung subject+predicate "${candidate.subject} ${candidate.predicate}", object khac ("${edge.object}" -> "${candidate.object}")`;
        supersedes++;
      }
    }
  }
  return { duplicates, supersedes };
}
