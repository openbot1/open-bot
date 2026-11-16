/**
 * Memory v13 — extraction add-only + invalidation (v1.14, Doi T1).
 *
 * Y tuong hoc tu Mem0 (extraction add-only mot pass: khong UPDATE/
 * DELETE am tham; fact mau thuan duoc danh dau chu khong xoa) va
 * Zep/Graphiti (fact mau thuan ghi `invalid_at`, lich su truoc do
 * van truy van duoc) — tu thiet ke lai hoan toan cho open-bot, chay
 * 100% local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `appendFactAddOnly` cua graph/addOnly (v1.04): append canh fact
 *    cu, dedupe chinh xac, khong bao gio sua fact cu luc ghi.
 *  - `invalidateFact` cua graph/biTemporal (v1.12): dong cua so
 *    hieu luc + ghi `invalidAt`/`invalidatedBy`/`invalidationReason`
 *    + audit JSONL, fact cu van truy van duoc truoc invalidAt.
 *  - `TemporalGraphStore` lam kho duy nhat.
 *
 * Luat v13:
 *  1. Trich xuat bang luat (regex tieng Viet + tieng Anh) tu turn
 *     hoi thoai — khong goi model, chay offline hoan toan.
 *  2. Fact moi LUON append (add-only). Trung lap chinh xac thi
 *     dedupe (khong tao ban sao).
 *  3. Fact moi mau thuan fact cu cung (subject, predicate) khac
 *     object: fact CU bi INVALIDATE (co ly do + tro toi fact moi),
 *     KHONG bi xoa, KHONG bi ghi de. Chi invalidate khi fact moi
 *     co confidence >= nguong (`minConfidenceToInvalidate`, mac
 *     dinh 0.6) — fact yeu khong duoc phep ha fact manh.
 *  4. Moi fact deu mang provenance day du (episode/turn/run/bot/
 *     user/at/sourceText) — khong co fact nao khong ro nguon.
 */

import type { GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { appendFactAddOnly } from '../graph/addOnly';
import { invalidateFact } from '../graph/biTemporal';
import type { InvalidationRecord } from '../graph/biTemporal';

/** Loi extraction — message tieng Viet. */
export class V13ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13ExtractionError';
  }
}

/** Mot turn hoi thoai dua vao trich xuat. */
export interface V13TurnInput {
  text: string;
  episodeId?: string;
  turnId?: string;
  runId?: string;
  botId?: string;
  userId?: string;
  /** Thoi diem turn dien ra (mac dinh bay gio) — lam validFrom. */
  at?: string;
  /** Scope ghi fact (mac dinh lay tu cac truong tren). */
  scope?: MemoryScope;
}

/** Mot ung vien fact trich duoc tu text (chua ghi). */
export interface V13ExtractedCandidate {
  subject: string;
  predicate: string;
  objectText: string;
  confidence: number;
  /** Cau goc (da cat ngan) sinh ra ung vien. */
  sourceText: string;
  /** Mau luat nao khop (de debug/audit). */
  pattern: string;
}

export interface V13ApplyExtractionOptions {
  /** Confidence toi thieu de mot ung vien duoc ghi (mac dinh 0.5). */
  minConfidence?: number;
  /** Confidence toi thieu de fact moi duoc invalidate fact cu (mac dinh 0.6). */
  minConfidenceToInvalidate?: number;
  /** Actor ghi fact (mac dinh 'system:extract-v13'). */
  actor?: string;
  /** Thu muc workspace (de ghi audit invalidation JSONL). */
  workspaceDir?: string;
  /** Thoi diem "bay gio" (de test xac dinh). */
  now?: Date;
}

export interface V13ExtractionReport {
  turns: number;
  candidates: number;
  appended: V13ExtractedCandidate[];
  /** Ung vien trung lap chinh xac — khong tao fact moi. */
  duplicates: { candidate: V13ExtractedCandidate; existingFactId: string }[];
  /** Fact cu bi invalidate vi mau thuan (kem ban ghi invalidation). */
  invalidated: { oldFact: GraphFact; record: InvalidationRecord }[];
  /** Ung vien bi bo vi confidence thap. */
  dropped: V13ExtractedCandidate[];
  /** Ung vien mau thuan nhung chua du confidence de invalidate. */
  deferred: { candidate: V13ExtractedCandidate; conflictingFact: GraphFact; reason: string }[];
}

/** Confidence mac dinh theo do tin cay cua mau luat. */
export const V13_DEFAULT_MIN_CONFIDENCE = 0.5;
export const V13_DEFAULT_MIN_CONFIDENCE_TO_INVALIDATE = 0.6;

interface V13Pattern {
  name: string;
  predicate: string;
  confidence: number;
  /** Nhom 1 = subject (co the rong -> 'user'), nhom 2 = object. */
  regexes: RegExp[];
}

/**
 * Bang mau luat trich xuat (tieng Viet + tieng Anh). Subject mac
 * dinh la user khi cau khong neu ten ("Toi thich pho" -> subject
 * "user"). Mau nao cung yeu cau object co it nhat 2 ky tu de tranh
 * trich rac tu cau ngan.
 */
const V13_PATTERNS: V13Pattern[] = [
  {
    name: 'likes',
    predicate: 'likes',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:rất\s+)?thích\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+(?:really\s+)?(?:like|love)\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'dislikes',
    predicate: 'dislikes',
    confidence: 0.8,
    // "không" BAT BUOC (hoac "ghet") — neu khong, cau "Tôi thích X"
    // se khop ca likes lan dislikes va tao 2 fact mau thuan nhau.
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+không\s+(?:thích|ưa)\s+([^,.;!?\n]{2,80})/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+ghét\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+(?:don't|do not|dont)\s+like\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+(?:hate|dislike)\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'lives_in',
    predicate: 'lives_in',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?sống\s+(?:ở|tại)\s+([^,.;!?\n]{2,80})/i,
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?ở\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+live\s+in\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'works_at',
    predicate: 'works_at',
    confidence: 0.85,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?làm\s+(?:việc\s+)?(?:ở|tại|cho)\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+work\s+(?:at|for)\s+([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'prefers',
    predicate: 'prefers',
    confidence: 0.75,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+thích\s+([^,.;!?\n]{2,60})\s+hơn\s+([^,.;!?\n]{2,60})/i,
      /(?:i|we)\s+prefer\s+([^,.;!?\n]{2,60})\s+(?:over|to)\s+([^,.;!?\n]{2,60})/i,
    ],
  },
  {
    name: 'speaks',
    predicate: 'speaks',
    confidence: 0.8,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:nói|biết)\s+tiếng\s+([^,.;!?\n]{2,40})/i,
      /(?:i|we)\s+speak\s+([^,.;!?\n]{2,40})/i,
    ],
  },
  {
    name: 'uses_tool',
    predicate: 'uses',
    confidence: 0.7,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+(?:đang\s+)?(?:dùng|sử dụng)\s+([^,.;!?\n]{2,60})\s+để/i,
      /(?:i|we)\s+use\s+([^,.;!?\n]{2,60})\s+for/i,
    ],
  },
  {
    name: 'wants',
    predicate: 'wants',
    confidence: 0.7,
    regexes: [
      /(?:tôi|tớ|mình|em|anh|chị)\s+muốn\s+([^,.;!?\n]{2,80})/i,
      /(?:i|we)\s+want\s+(?:to\s+)?([^,.;!?\n]{2,80})/i,
    ],
  },
  {
    name: 'named_subject_likes',
    predicate: 'likes',
    confidence: 0.8,
    regexes: [
      /([A-ZÀ-Ỹ][\wÀ-ỹ]{1,30})\s+(?:rất\s+)?thích\s+([^,.;!?\n]{2,80})/,
      /([A-Z][\w]{1,30})\s+(?:really\s+)?(?:likes|loves)\s+([^,.;!?\n]{2,80})/,
    ],
  },
  {
    name: 'named_subject_lives_in',
    predicate: 'lives_in',
    confidence: 0.85,
    regexes: [
      /([A-ZÀ-Ỹ][\wÀ-ỹ]{1,30})\s+(?:đang\s+)?sống\s+(?:ở|tại)\s+([^,.;!?\n]{2,80})/,
      /([A-Z][\w]{1,30})\s+lives\s+in\s+([^,.;!?\n]{2,80})/,
    ],
  },
];

/** Dai tu / tu thuong khong bao gio la ten rieng lam subject (da chuan hoa bo dau). */
const V13_NON_NAME_SUBJECTS = new Set([
  'toi', 'to', 'minh', 'em', 'anh', 'chi', 'ong', 'ba', 'ban', 'no',
  'i', 'we', 'he', 'she', 'they', 'you', 'khong',
]);

function cleanObject(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;!?\s]+$/, '')
    .slice(0, 200);
}

/**
 * Subject co ten rieng hop le khong: bat dau bang chu hoa (kiem tra
 * theo Unicode, khong dung dai À-Ỹ vi dai do lan ca chu thuong) va
 * khong phai dai tu/tu thuong ("Tôi", "không" -> "ông").
 */
function isValidNamedSubject(subject: string): boolean {
  const clean = (subject ?? '').trim();
  if (clean === '') return false;
  if (V13_NON_NAME_SUBJECTS.has(normalizeGraphText(clean))) return false;
  const first = clean[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/** Trich ung vien fact tu mot doan text (thuan, khong ghi gi ca). */
export function extractCandidatesFromText(text: string): V13ExtractedCandidate[] {
  const clean = (text ?? '').trim();
  if (clean === '') return [];
  const out: V13ExtractedCandidate[] = [];
  const seen = new Set<string>();
  for (const pattern of V13_PATTERNS) {
    for (const re of pattern.regexes) {
      // Reset lastIndex (regex khong co /g nhung phong thu).
      re.lastIndex = 0;
      const m = re.exec(clean);
      if (!m) continue;
      let subject = 'user';
      let objectRaw: string;
      if (pattern.name.startsWith('named_subject_')) {
        subject = (m[1] ?? '').trim();
        // Bo subject khong phai ten rieng ("Tôi", "không" -> "ông").
        if (!isValidNamedSubject(subject)) continue;
        objectRaw = m[2] ?? '';
      } else if (pattern.name === 'prefers') {
        objectRaw = m[1] ?? '';
      } else {
        objectRaw = m[1] ?? '';
      }
      const objectText = cleanObject(objectRaw);
      if (objectText.length < 2) continue;
      const key = `${normalizeGraphText(subject)}|${pattern.predicate}|${normalizeGraphText(objectText)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        subject,
        predicate: pattern.predicate,
        objectText,
        confidence: pattern.confidence,
        sourceText: clean.slice(0, 500),
        pattern: pattern.name,
      });
    }
  }
  return out;
}

function scopeOfTurn(turn: V13TurnInput): MemoryScope {
  if (turn.scope) return { ...turn.scope };
  return {
    userId: turn.userId ?? '',
    botId: turn.botId ?? '',
    runId: turn.runId ?? '',
  };
}

/**
 * Ghi mot ung vien theo luat add-only: trung lap chinh xac thi
 * dedupe; neu khong, append fact moi canh fact cu.
 */
export function appendCandidateAddOnly(
  store: TemporalGraphStore,
  candidate: V13ExtractedCandidate,
  scope: MemoryScope,
  provenance: GraphFact['provenance'],
  opts: { validFrom?: string; now?: Date } = {},
): { fact: GraphFact; duplicate: boolean; existingFactId?: string } {
  const result = appendFactAddOnly(
    store,
    {
      subjectName: candidate.subject,
      predicate: candidate.predicate,
      objectText: candidate.objectText,
      confidence: candidate.confidence,
      scope,
      provenance: {
        ...provenance,
        sourceText: candidate.sourceText.slice(0, 500),
      },
      ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    },
    opts.now ?? new Date(),
  );
  return {
    fact: result.fact,
    duplicate: result.duplicate,
    ...(result.existingFactId ? { existingFactId: result.existingFactId } : {}),
  };
}

/**
 * Invalidate mot fact cu vi mau thuan voi fact moi (ghi ly do +
 * audit). Fact cu KHONG bi xoa: truoc invalidAt no van dung.
 */
export function invalidateFactV13(
  store: TemporalGraphStore,
  factId: string,
  reason: string,
  actor: string,
  opts: { workspaceDir?: string; conflictingFactId?: string; invalidAt?: string | Date; now?: Date } = {},
): { fact: GraphFact; record: InvalidationRecord } {
  const result = invalidateFact(
    store,
    factId,
    opts.invalidAt ?? opts.now ?? new Date(),
    reason,
    actor,
    {
      ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      ...(opts.conflictingFactId ? { conflictingFactId: opts.conflictingFactId } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    },
  );
  return { fact: result.fact, record: result.record };
}

/**
 * Ap dung trich xuat add-only cho mot loat turn: trich -> loc theo
 * confidence -> append (dedupe) -> invalidate fact cu mau thuan khi
 * du confidence. Khong bao gio overwrite/xoa fact cu.
 */
export function applyExtractionV13(
  store: TemporalGraphStore,
  turns: V13TurnInput[],
  opts: V13ApplyExtractionOptions = {},
): V13ExtractionReport {
  const minConfidence = opts.minConfidence ?? V13_DEFAULT_MIN_CONFIDENCE;
  const minToInvalidate =
    typeof opts.minConfidenceToInvalidate === 'number'
      ? opts.minConfidenceToInvalidate
      : V13_DEFAULT_MIN_CONFIDENCE_TO_INVALIDATE;
  const actor = (opts.actor ?? 'system:extract-v13').trim() || 'system:extract-v13';
  const now = opts.now ?? new Date();
  const report: V13ExtractionReport = {
    turns: turns.length,
    candidates: 0,
    appended: [],
    duplicates: [],
    invalidated: [],
    dropped: [],
    deferred: [],
  };
  for (const turn of turns) {
    const scope = scopeOfTurn(turn);
    const at = turn.at ?? now.toISOString();
    const candidates = extractCandidatesFromText(turn.text);
    report.candidates += candidates.length;
    for (const candidate of candidates) {
      if (candidate.confidence < minConfidence) {
        report.dropped.push(candidate);
        continue;
      }
      const provenance: GraphFact['provenance'] = {
        episodeId: turn.episodeId ?? '',
        turnId: turn.turnId ?? '',
        runId: turn.runId ?? scope.runId,
        botId: turn.botId ?? scope.botId,
        userId: turn.userId ?? scope.userId,
        at,
        sourceText: candidate.sourceText,
      };
      const appended = appendCandidateAddOnly(store, candidate, scope, provenance, {
        validFrom: at,
        now,
      });
      if (appended.duplicate) {
        report.duplicates.push({
          candidate,
          existingFactId: appended.existingFactId ?? appended.fact.id,
        });
        continue;
      }
      report.appended.push(candidate);
      // Mau thuan: fact active cung (subject, predicate) khac object.
      const conflicts = store
        .findActiveFacts(candidate.subject, candidate.predicate, scope)
        .filter(
          (f) =>
            f.id !== appended.fact.id &&
            normalizeGraphText(f.objectText ?? '') !== normalizeGraphText(candidate.objectText),
        );
      for (const old of conflicts) {
        if (candidate.confidence >= minToInvalidate) {
          try {
            const inv = invalidateFactV13(store, old.id, `Mau thuan voi fact moi "${candidate.objectText}" (confidence ${candidate.confidence}).`, actor, {
              ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
              conflictingFactId: appended.fact.id,
              invalidAt: at,
              now,
            });
            report.invalidated.push({ oldFact: inv.fact, record: inv.record });
          } catch {
            report.deferred.push({
              candidate,
              conflictingFact: old,
              reason: 'Khong invalidate duoc fact cu (co the da het hieu luc).',
            });
          }
        } else {
          report.deferred.push({
            candidate,
            conflictingFact: old,
            reason: `Confidence ${candidate.confidence} < nguong invalidate ${minToInvalidate} — fact cu van giu.`,
          });
        }
      }
    }
  }
  return report;
}
