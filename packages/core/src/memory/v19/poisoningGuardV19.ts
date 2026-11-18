/**
 * Memory v19 — Poisoning guard, lop mo rong tren v18 (v1.20, Doi T1).
 *
 * Y tuong hoc tu OWASP ASI06 (Memory & Context Poisoning) + ASI
 * 2026 (instruction injection smuggled qua memory) — tu thiet ke
 * lai hoan toan cho open-bot, KHONG copy code/text/tai san cua bat
 * ky repo nao.
 *
 * VI TRI CUA MODULE NAY (doc ky, tranh hieu lam):
 *  - Guard v3 DA CO trong v18 (`poisoningGuardV3.ts`): source
 *    trust scoring + mau tiem nhiem + contradiction alert +
 *    pipeline 4 buoc `screenCandidateV18`. Module nay KHONG viet
 *    lai v3, KHONG tao allowlist / trust book / quarantine thu
 *    hai — no la LOP TIEN QUET v19 chay TRUOC v18, them 3 ho
 *    phat hien moi ma v18 chua co, roi UY QUYEN lai cho v18
 *    quyet dinh tiep.
 *  - 3 ho moi cua v19:
 *    1. Mau tiem nhiem bo sung (gia mao admin/role-play, gia
 *       mao tool-call, luong du lieu ra ngoai, smuggling
 *       huong dan moi) — `V19_INJECTION_PATTERNS`.
 *    2. Phat hien MA HOA / NGUY TRANG (encoded payload):
 *       doan base64 giai ma ra cau lenh tiem nhiem, ky tu
 *       zero-width / dieu khien chen giua text de qua mat
 *       quet text thuong.
 *    3. Phat hien GIA MAO TOOL-CALL: dau hieu output tool /
 *       function-call gia de memory tu nhan la ket qua tool
 *       dang tin (vd `<tool_call>`, `function_call`).
 *  - NGUYEN TAC XU LY: bat ky phat hien v19 nao -> QUARANTINE
 *    (khong reject thang, khong admit). Memory text von la cau
 *    fact ngan nen dau hieu tiem nhiem o day hau nhu khong bao
 *    gio la noi dung hop le; nhung van co ngoai le hop le (vd
 *    fact \"user bat developer mode trong VS Code\"), nen nguoi
 *    duyet quarantine quyet dinh cuoi — do la dung muc dich
 *    cua quarantine. Viec duyet/reject van qua
 *    `store.reviewQuarantine` duy nhat cua store + cap nhat
 *    trust qua `recordReviewOutcomeV18` cua v18 (v19 khong tu
 *    hoc trust).
 *  - Neu tien quet v19 sach, ung vien di tiep nguyen pipeline
 *    v18 (deny -> tiem nhiem v18 -> gate v16 -> mau thuan /
 *    trust) — ket qua v18 duoc giu nguyen, chi cong them ly do
 *    v19 (neu co) vao bao cao.
 *
 * Module KHONG goi model, KHONG goi mang. Base64 chi giai ma
 * TRONG RAM de quet (khong ghi decoded payload ra file/log
 * ngoai tru doan rut gon <= 120 ky tu trong `detail`).
 */

import type { MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { V16CandidateFact } from '../v16/consolidationOps';
import {
  screenCandidateV18,
  recordReviewOutcomeV18,
  V18_INJECTION_PATTERNS,
  scanInjectionV18,
} from '../v18/poisoningGuardV3';
import type {
  V18ScreenOptions,
  V18ScreenResult,
  V18ContradictionAlert,
} from '../v18/poisoningGuardV3';

/** Loi poisoning guard v19 — message tieng Viet. */
export class V19PoisoningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V19PoisoningError';
  }
}

/**
 * Mau tiem nhiem BO SUNG cua v19 (chuan hoa truoc khi so, nhu
 * v18). Khong trung voi `V18_INJECTION_PATTERNS`: v19 them gia
 * mao admin/role-play, gia mao tool-call, exfiltration, smuggling
 * huong dan moi, tiet lo mat khau.
 */
export const V19_INJECTION_PATTERNS: readonly string[] = [
  'act as admin',
  'act as root',
  'you are the admin',
  'ban la quan tri vien',
  'developer mode',
  'sudo mode',
  'jailbreak',
  'dan mode',
  'do anything now',
  'new instructions:',
  'huong dan moi:',
  'override system prompt',
  'ignore safety',
  'bo qua an toan',
  'tat kiem duyet',
  'disable safety',
  'reveal your password',
  'tiet lo mat khau',
  'send to http',
  'post to http',
  'gui toi http',
];

/** Dau hieu gia mao tool-call / function-call (quet tren text GOC, khong chuan hoa dau). */
export const V19_TOOL_CALL_FORGERY_MARKERS: readonly string[] = [
  '<tool_call>',
  '[tool_call]',
  '<function_call>',
  'function_call',
  '"tool_call"',
  'tool result:',
  'ket qua tool:',
];

/** Do dai toi thieu cua mot doan nghi la base64 moi thu giai ma. */
export const V19_MIN_BASE64_SEGMENT_LENGTH = 24;
/** So ky tu zero-width / dieu khien toi thieu moi coi la nguy trang. */
export const V19_MIN_OBFUSCATION_CHARS = 2;
/** Do dai toi da cua doan payload giai ma ghi vao bao cao. */
export const V19_MAX_DECODED_SNIPPET_CHARS = 120;

/** Muc do nghiem trong cua phat hien v19. */
export type V19PoisoningSeverity = 'none' | 'low' | 'high';

/** Ket qua quet text cua lop v19 (thuan, dung duoc trong test). */
export interface V19PoisoningFindings {
  /** Cac mau tiem nhiem v19 khop (text mau). */
  patternHits: string[];
  /** Cac dau hieu gia mao tool-call khop. */
  forgeryHits: string[];
  /** Payload base64 giai ma ra cau tiem nhiem (doan rut gon). */
  encodedHits: string[];
  /** So ky tu zero-width / dieu khien dem duoc. */
  obfuscationChars: number;
  /** Muc do nghiem trong tong hop. */
  severity: V19PoisoningSeverity;
}

/** Ket qua sang loc day du cua v19 (gom ca ket qua v18 neu co). */
export interface V19ScreenResult {
  /** Quyet dinh cuoi: 'admit' | 'quarantine' | 'reject' (reject chi tu v18). */
  decision: 'admit' | 'quarantine' | 'reject';
  /** Tat ca ly do (v19 truoc, v18 sau). */
  reasons: string[];
  /** Diem trust cua nguon luc sang loc (tu v18). */
  sourceTrust: number;
  /** Tat ca mau tiem nhiem khop (v19 + v18). */
  injectionHits: string[];
  /** Canh bao mau thuan (tu v18, neu co). */
  contradiction: V18ContradictionAlert | null;
  /** Quarantine item da tao (khi decision = quarantine). */
  quarantineId: string | null;
  /** Phat hien cua lop v19 (null = tien quet sach, da uy quyen cho v18). */
  v19Findings: V19PoisoningFindings | null;
  /** Ket qua goc cua v18 (null khi v19 da quarantine truoc). */
  v18Result: V18ScreenResult | null;
}

/** Regex doan base64 dai (chi chu + so + `+/=`). */
const BASE64_SEGMENT_RE = /[A-Za-z0-9+/=]{24,}/g;
/** Ky tu zero-width / dieu khien / BOM thuong dung de nguy trang. */
const OBFUSCATION_CHARS_RE = /[​-‍﻿­]/g;

/** Dem ky tu zero-width / dieu khien trong text. */
export function countObfuscationCharsV19(text: string): number {
  const matches = (text ?? '').match(OBFUSCATION_CHARS_RE);
  return matches ? matches.length : 0;
}

/** Quet dau hieu gia mao tool-call (khop chuoi chinh xac, khong phan biet hoa/thuong). */
export function scanToolCallForgeryV19(text: string): string[] {
  const hay = (text ?? '').toLowerCase();
  if (hay === '') return [];
  return V19_TOOL_CALL_FORGERY_MARKERS.filter((marker) => hay.includes(marker.toLowerCase()));
}

/**
 * Quet payload ma hoa: tim doan base64 dai, giai ma trong RAM,
 * quet text giai ma bang ca mau v18 + v19. Chi bao khi text giai
 * ma CHUA mau tiem nhiem (doan base64 vo hai nhu hash/ID thi
 * khong bao — tranh false positive).
 */
export function scanEncodedPayloadV19(text: string): string[] {
  const hits: string[] = [];
  const raw = text ?? '';
  if (raw === '') return hits;
  const segments = raw.match(BASE64_SEGMENT_RE) ?? [];
  for (const segment of segments) {
    if (segment.length < V19_MIN_BASE64_SEGMENT_LENGTH) continue;
    let decoded = '';
    try {
      decoded = Buffer.from(segment, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (decoded === '' || /�/.test(decoded)) continue;
    const printable = decoded.replace(/[^\x20-\x7EÀ-ỹ]/g, '').trim();
    if (printable.length < 8) continue;
    const v18Hits = scanInjectionV18(printable);
    const norm = normalizeGraphText(printable);
    const v19Hits = V19_INJECTION_PATTERNS.filter((pattern) => {
      const normPattern = normalizeGraphText(pattern);
      return normPattern !== '' && norm.includes(normPattern);
    });
    if (v18Hits.length > 0 || v19Hits.length > 0) {
      const snippet = printable.slice(0, V19_MAX_DECODED_SNIPPET_CHARS);
      hits.push(`base64:${snippet}`);
    }
  }
  return hits;
}

/**
 * Quet text bang toan bo lop v19: mau bo sung + gia mao tool-call
 * + payload ma hoa + nguy trang. Thuan, khong can store.
 */
export function scanTextV19(text: string): V19PoisoningFindings {
  const raw = text ?? '';
  const norm = normalizeGraphText(raw);
  const patternHits: string[] = [];
  if (norm !== '') {
    for (const pattern of V19_INJECTION_PATTERNS) {
      const normPattern = normalizeGraphText(pattern);
      if (normPattern !== '' && norm.includes(normPattern)) patternHits.push(pattern);
    }
  }
  const forgeryHits = scanToolCallForgeryV19(raw);
  const encodedHits = scanEncodedPayloadV19(raw);
  const obfuscationChars = countObfuscationCharsV19(raw);
  const obfuscated = obfuscationChars >= V19_MIN_OBFUSCATION_CHARS;
  let severity: V19PoisoningSeverity = 'none';
  if (forgeryHits.length > 0 || encodedHits.length > 0 || patternHits.length >= 2) {
    severity = 'high';
  } else if (patternHits.length === 1 || obfuscated) {
    severity = 'low';
  }
  return { patternHits, forgeryHits, encodedHits, obfuscationChars, severity };
}

/** true = tien quet v19 tim thay it nhat mot dau hieu. */
export function hasPoisoningFindingsV19(findings: V19PoisoningFindings): boolean {
  return findings.severity !== 'none';
}

/** Tom tat phat hien v19 thanh text (tieng Viet) cho `detail` quarantine / log. */
export function formatV19PoisoningFindings(findings: V19PoisoningFindings): string {
  const parts: string[] = [];
  if (findings.patternHits.length > 0) {
    parts.push(`mau tiem nhiem v19: ${findings.patternHits.join('; ')}`);
  }
  if (findings.forgeryHits.length > 0) {
    parts.push(`gia mao tool-call: ${findings.forgeryHits.join('; ')}`);
  }
  if (findings.encodedHits.length > 0) {
    parts.push(`payload ma hoa: ${findings.encodedHits.join('; ')}`);
  }
  if (findings.obfuscationChars >= V19_MIN_OBFUSCATION_CHARS) {
    parts.push(`nguy trang: ${findings.obfuscationChars} ky tu an`);
  }
  if (parts.length === 0) return 'Lop quet v19: sach.';
  return `Lop quet v19 (${findings.severity}): ${parts.join(' | ')}.`;
}

/**
 * Sang loc mot ung vien fact moi: tien quet v19 truoc, roi uy
 * quyen cho pipeline v18. Thu tu:
 *  (a) tien quet v19 co phat hien -> quarantine ngay (ly do chi
 *      tiet, kem ca mau v18 neu text cung khop), khong goi v18;
 *  (b) tien quet sach -> goi `screenCandidateV18` nguyen ven,
 *      tra ket qua cua no (decision / trust / contradiction /
 *      quarantineId) kem `v19Findings: null`.
 *
 * Quarantine van qua `store.addToQuarantine` duy nhat; duyet sau
 * do van qua `store.reviewQuarantine` + `recordReviewOutcomeV18`.
 */
export function screenCandidateV19(
  store: TemporalGraphStore,
  candidate: V16CandidateFact,
  scope: MemoryScope,
  opts: V18ScreenOptions = {},
): V19ScreenResult {
  const sourceName = (candidate.sourceName ?? 'user-chat').trim() || 'user-chat';
  const text = `${candidate.subject ?? ''} ${candidate.predicate ?? ''} ${candidate.objectText ?? ''} ${candidate.sourceText ?? ''}`;
  const findings = scanTextV19(text);
  const provenance = {
    episodeId: candidate.episodeId ?? '',
    turnId: candidate.turnId ?? '',
    runId: candidate.runId ?? scope.runId ?? '',
    botId: candidate.botId ?? scope.botId ?? '',
    userId: candidate.userId ?? scope.userId ?? '',
    at: candidate.at ?? new Date().toISOString(),
    sourceText: (candidate.sourceText ?? '').slice(0, 500),
  };

  if (hasPoisoningFindingsV19(findings)) {
    const v18Hits = scanInjectionV18(text);
    const detail = formatV19PoisoningFindings(findings);
    const item = store.addToQuarantine({
      candidate: {
        subjectName: candidate.subject ?? '',
        predicate: candidate.predicate ?? '',
        objectText: candidate.objectText ?? '',
        confidence: candidate.effectiveConfidence ?? candidate.confidence ?? 0.5,
      },
      reason: 'suspicious-pattern',
      detail: `Nghi ngo dau doc memory (lop v19): ${detail}`,
      scope,
      provenance,
    });
    return {
      decision: 'quarantine',
      reasons: [
        `Lop quet v19 (${findings.severity}): ${detail}`,
        'Ung vien vao quarantine cho nguoi duyet (khong tu reject).',
      ],
      sourceTrust: opts.trustBook ? opts.trustBook.trustOf(sourceName) : 0.5,
      injectionHits: [...findings.patternHits, ...v18Hits],
      contradiction: null,
      quarantineId: item.id,
      v19Findings: findings,
      v18Result: null,
    };
  }

  const v18Result = screenCandidateV18(store, candidate, scope, opts);
  return {
    decision: v18Result.decision,
    reasons: v18Result.reasons,
    sourceTrust: v18Result.sourceTrust,
    injectionHits: v18Result.injectionHits,
    contradiction: v18Result.contradiction,
    quarantineId: v18Result.quarantineId,
    v19Findings: null,
    v18Result,
  };
}

/**
 * Re-export de host cap nhat trust sau khi duyet quarantine v19:
 * dung ham goc cua v18 (mot noi duy nhat hoc trust), khong tu
 * hoc o tang v19.
 */
export { recordReviewOutcomeV18 };
export type { V18ScreenOptions };
