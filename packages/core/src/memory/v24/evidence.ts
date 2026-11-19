/**
 * Memory v24 — evidence + lessons (v1.39, Doi T1).
 *
 * Y tuong WikiTrace (chi y tuong): giu evidence dang sau moi
 * lesson — 52% loi do memory sai duoc follow khi lesson khong
 * kem bang chung. Ap dung: moi lesson PHAI link toi evidence
 * (nguon, doan trich, thoi diem); lesson khong evidence bi
 * quarantine, khong duoc dua vao system prompt.
 *
 * Tu thiet ke lai hoan toan cho open-bot, chay local:
 *  - Evidence: {kind, source, excerpt, uri, capturedAt,
 *    capturedBy, confidence}. Verify: excerpt khong rong,
 *    capturedAt hop le, source khong rong, uri (neu co) dung
 *    dinh dang (scheme://...).
 *  - Lesson: title + body + evidence[] + confidence +
 *    importance + status + valid-time + scope + appliedCount.
 *    addLesson: thieu evidence -> status quarantine + ly do;
 *    du evidence -> active.
 *  - Freshness: evidence cang moi thi lesson cang dang tin;
 *    evidence qua cu (> 365 ngay) thi lesson bi danh dau can
 *    re-verify (khong tu dong xoa).
 *  - Trace: lesson -> evidence -> source turn (qua excerpt);
 *    coverage: ti le lesson co evidence / tong lesson.
 *  - applyLesson: tang appliedCount + lastAppliedAt (dung de
 *    decay uu tien lesson hay duoc dung).
 */
import {
  clamp01V24,
  contentHashV24,
  isoAtV24,
  makeV24Id,
  parseIsoV24,
  truncateV24,
  type V24Evidence,
  type V24Lesson,
  type V24LessonStatus,
  type V24Scope,
  V24_MAX_EVIDENCE_EXCERPT_CHARS,
} from './types';

/** Ket qua thao tac lesson (khong throw). */
export interface V24LessonResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): V24LessonResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): V24LessonResult<T> {
  return { ok: false, error };
}

/** Kiem tra 1 evidence co hop le khong. Tra null neu hop le. */
export function validateEvidenceV24(evidence: V24Evidence): string | null {
  if (!evidence.source || !evidence.source.trim()) return 'Evidence thieu source.';
  if (!evidence.excerpt || !evidence.excerpt.trim()) return 'Evidence thieu excerpt (doan trich goc).';
  if (evidence.excerpt.length > V24_MAX_EVIDENCE_EXCERPT_CHARS) {
    return `Excerpt dai qua ${V24_MAX_EVIDENCE_EXCERPT_CHARS} ky tu.`;
  }
  if (!parseIsoV24(evidence.capturedAt)) return 'Evidence capturedAt khong hop le.';
  if (evidence.uri !== null && evidence.uri !== '') {
    if (!/^[a-z][a-z0-9+.-]*:\/\/.+/i.test(evidence.uri) && !evidence.uri.startsWith('memfs://')) {
      return `Evidence uri khong hop le: "${evidence.uri}".`;
    }
  }
  if (evidence.confidence < 0 || evidence.confidence > 1) return 'Evidence confidence phai trong [0, 1].';
  return null;
}

/** Tao evidence tu 1 doan trich (cat ngan, gan id). */
export function makeEvidenceV24(input: {
  kind: V24Evidence['kind'];
  source: string;
  excerpt: string;
  uri?: string | null;
  capturedAt?: string;
  capturedBy?: string;
  confidence?: number;
}): V24Evidence {
  return {
    id: makeV24Id('ev'),
    kind: input.kind,
    source: input.source.trim(),
    excerpt: truncateV24(input.excerpt.trim(), V24_MAX_EVIDENCE_EXCERPT_CHARS),
    uri: input.uri ?? null,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    capturedBy: input.capturedBy ?? '',
    confidence: clamp01V24(input.confidence ?? 0.7),
  };
}

/** Diem tuoi cua evidence: 1 = vua ghi, giam dan theo tuoi (ngay). */
export function evidenceFreshnessV24(evidence: V24Evidence, nowMs: number): number {
  const captured = parseIsoV24(evidence.capturedAt)?.getTime();
  if (captured === null || captured === undefined) return 0;
  const ageDays = Math.max(0, (nowMs - captured) / (24 * 3600 * 1000));
  if (ageDays <= 7) return 1;
  if (ageDays >= 365) return 0.1;
  return clamp01V24(1 - (ageDays - 7) / 358);
}

/** Diem tuoi trung binh cua lesson (theo evidence kem theo). */
export function lessonFreshnessV24(lesson: V24Lesson, nowMs: number): number {
  if (lesson.evidence.length === 0) return 0;
  const sum = lesson.evidence.reduce((acc, e) => acc + evidenceFreshnessV24(e, nowMs), 0);
  return sum / lesson.evidence.length;
}

/** Lesson co du evidence hop le khong. */
export function lessonHasValidEvidenceV24(lesson: V24Lesson): boolean {
  return lesson.evidence.length > 0 && lesson.evidence.every((e) => validateEvidenceV24(e) === null);
}

/** Input tao lesson moi. */
export interface V24NewLessonInput {
  title: string;
  body: string;
  evidence: V24Evidence[];
  confidence?: number;
  importance?: number;
  tags?: string[];
  scope: V24Scope;
  authorBotId?: string;
  validFrom?: string | null;
  validTo?: string | null;
  expiresAt?: string | null;
  nowMs?: number;
}

/** Tao lesson: thieu evidence -> quarantine; du evidence -> active. */
export function createLessonV24(input: V24NewLessonInput): V24Lesson {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = isoAtV24(nowMs);
  const invalidReasons: string[] = [];
  for (const e of input.evidence) {
    const err = validateEvidenceV24(e);
    if (err) invalidReasons.push(err);
  }
  let status: V24LessonStatus = 'active';
  let statusReason: string | null = null;
  if (input.evidence.length === 0) {
    status = 'quarantined';
    statusReason = 'Lesson khong kem evidence — can bo sung nguon/doan trich/thoi diem truoc khi dung.';
  } else if (invalidReasons.length > 0) {
    status = 'quarantined';
    statusReason = `Evidence khong hop le: ${invalidReasons[0]}`;
  }
  return {
    id: makeV24Id('les'),
    title: input.title.trim().slice(0, 200),
    body: input.body.trim().slice(0, 4000),
    evidence: input.evidence.map((e) => ({ ...e })),
    confidence: clamp01V24(input.confidence ?? 0.7),
    importance: clamp01V24(input.importance ?? 0.5),
    status,
    statusReason,
    supersedesId: null,
    supersededById: null,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: input.expiresAt ?? null,
    tags: [...(input.tags ?? [])].slice(0, 20),
    scope: { ...input.scope },
    authorBotId: input.authorBotId ?? '',
    appliedCount: 0,
    lastAppliedAt: null,
  };
}

/** Gan them evidence cho lesson dang quarantine -> active neu du. */
export function attachEvidenceV24(
  lesson: V24Lesson,
  evidence: V24Evidence,
): V24LessonResult<V24Lesson> {
  const err = validateEvidenceV24(evidence);
  if (err) return fail(`Evidence khong hop le: ${err}`);
  const updated: V24Lesson = {
    ...lesson,
    evidence: [...lesson.evidence, { ...evidence }],
    updatedAt: new Date().toISOString(),
  };
  if (updated.status === 'quarantined' && lessonHasValidEvidenceV24(updated)) {
    updated.status = 'active';
    updated.statusReason = null;
  }
  return ok(updated);
}

/** Danh dau lesson da duoc ap dung (tang appliedCount, cap nhat lastAppliedAt). */
export function applyLessonV24(lesson: V24Lesson, nowMs?: number): V24Lesson {
  return {
    ...lesson,
    appliedCount: lesson.appliedCount + 1,
    lastAppliedAt: isoAtV24(nowMs ?? Date.now()),
  };
}

/** Lesson co can re-verify khong (evidence qua cu + chua ap dung lau). */
export function lessonNeedsReverifyV24(lesson: V24Lesson, nowMs: number): boolean {
  if (lesson.status !== 'active') return false;
  if (lessonFreshnessV24(lesson, nowMs) < 0.2) return true;
  const lastApplied = parseIsoV24(lesson.lastAppliedAt)?.getTime();
  if (lastApplied !== null && lastApplied !== undefined) {
    const idleDays = (nowMs - lastApplied) / (24 * 3600 * 1000);
    if (idleDays > 365 && lesson.confidence < 0.5) return true;
  }
  return false;
}

/** Chuoi trace cua lesson: lesson -> evidence (nguon + thoi diem). */
export function traceLessonV24(lesson: V24Lesson): string[] {
  const lines = [`Lesson ${lesson.id}: "${lesson.title}" (${lesson.status})`];
  if (lesson.evidence.length === 0) {
    lines.push('  - (khong co evidence — lesson bi quarantine)');
    return lines;
  }
  for (const e of lesson.evidence) {
    lines.push(
      `  - [${e.kind}] ${e.source} @ ${e.capturedAt}: "${truncateV24(e.excerpt, 120)}"${e.uri ? ` (${e.uri})` : ''}`,
    );
  }
  if (lesson.supersedesId) lines.push(`  - Thay the lesson ${lesson.supersedesId}.`);
  if (lesson.supersededById) lines.push(`  - Bi thay the boi lesson ${lesson.supersededById}.`);
  return lines;
}

/** Ti le bao phu evidence: lesson co evidence hop le / tong lesson. */
export function evidenceCoverageV24(lessons: V24Lesson[]): { covered: number; total: number; ratio: number } {
  const total = lessons.length;
  const covered = lessons.filter((l) => lessonHasValidEvidenceV24(l)).length;
  return { covered, total, ratio: total === 0 ? 1 : covered / total };
}

/** Hash noi dung lesson (dung de phat hien trung lap). */
export function lessonContentHashV24(lesson: Pick<V24Lesson, 'title' | 'body'>): string {
  return contentHashV24(`${lesson.title}\n${lesson.body}`);
}
