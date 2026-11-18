/**
 * Memory v18 — Extraction v2 + entity linking (v1.19, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 (2026: extraction 1 pass gan entity, fact
 * nao cung co provenance nguon day du) — tu thiet ke lai hoan toan
 * cho open-bot, chay 100% local, KHONG copy code/text/tai san cua
 * bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `extractFactsV15Sync` cua memoryV15/consolidation: trich fact
 *    rule-based 1 pass (khong goi model); v18 goi lai lam lop trich
 *    tho, roi NANG CAP ket qua (khong viet lai mau luat v15).
 *  - `V16EntityLinker` cua memory/v16/entityLinking: resolve ten
 *    thanh entity chuan (alias/abbreviation/Jaccard); v18 dung no
 *    de gan entity cho ca subject lan object, va ghi lai bang lien
 *    ket de audit.
 *  - `TemporalGraphStore.addFact` / `ensureEntity`: kho ghi duy
 *    nhat; v18 khong tao kho song song.
 *
 * Moi trong v18:
 *  1. `extractV18` — trich tu mot turn: lay ung vien v15, doi
 *     subject mac dinh ("user" / ten nguoi dung) thanh subject that
 *     neu text co mau dinh danh ("Tôi tên là X", "My name is X",
 *     "Tôi là X"), gan entity cho subject + object (neu object la
 *     entity), nhan confidence voi sourceTrust, loai ung vien trung
 *     lap, tra ve `V18ExtractedFact` co day du provenance.
 *  2. `V18ExtractionProvenance` — provenance mo rong: episodeId,
 *     turnId, sourceName, sourceTrust, pattern, extractAt — moi fact
 *     v18 ghi xuong store deu mang theo (qua `FactProvenance`
 *     chuan + truong phu trong bao cao).
 *  3. `extractAndWriteV18` — trich + ghi thang vao store: ung vien
 *     vuot `minConfidence` thi `addFact` (subject/object da resolve),
 *     ung vien duoi nguong thi tra ve danh sach bo qua co ly do;
 *     tra bao cao gom factIds da ghi + so luong bo qua.
 *  4. `dedupeCandidatesV18` — gop ung vien trung (cung subject
 *     chuan hoa + predicate + object chuan hoa): giu confidence cao
 *     nhat, cong don pattern.
 *  5. `extractEpisodeV18` — trich tu mot episode da ingest trong
 *     store (lay text episode, trich, ghi fact, danh dau episode
 *     processed qua `markEpisodeProcessed`).
 */

import type { GraphEntity, GraphFact, MemoryScope } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import { extractFactsV15Sync } from '../../memoryV15/consolidation';
import type { V15ExtractedFact } from '../../memoryV15/consolidation';
import { V16EntityLinker } from '../v16/entityLinking';

/** Loi extraction v2 — message tieng Viet. */
export class V18ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V18ExtractionError';
  }
}

/** Confidence toi thieu mac dinh de ghi fact v18 vao store. */
export const V18_DEFAULT_MIN_CONFIDENCE = 0.5;
/** So ky tu toi da cua ten subject tu mau dinh danh. */
export const V18_MAX_SUBJECT_CHARS = 80;

/** Provenance mo rong cua mot fact trich bang v18. */
export interface V18ExtractionProvenance {
  episodeId: string;
  turnId: string;
  runId: string;
  botId: string;
  userId: string;
  /** Ten nguon (vd 'user-chat', 'imported-notes', 'web-scrape'). */
  sourceName: string;
  /** Do tin cay nguon 0..1 (da nhan vao confidence). */
  sourceTrust: number;
  /** Mau luat v15 nao sinh ra ung vien. */
  pattern: string;
  /** Thoi diem trich (ISO). */
  extractedAt: string;
  /** Cau goc da rut ra fact. */
  sourceText: string;
}

/** Mot fact ung vien da qua extraction v2 (chua ghi). */
export interface V18ExtractedFact {
  /** Ten subject goc (truoc khi resolve). */
  subjectName: string;
  /** Entity chuan cua subject (da resolve qua linker). */
  subjectEntity: GraphEntity;
  /** Entity chuan cua object — null khi object la text tu do. */
  objectEntity: GraphEntity | null;
  predicate: string;
  objectText: string;
  /** Object co phai entity khong (de store noi objectId). */
  objectIsEntity: boolean;
  /** Confidence goc cua mau v15. */
  rawConfidence: number;
  /** Confidence hieu dung = raw * sourceTrust (0..1). */
  confidence: number;
  sourceTrust: number;
  /** Cac pattern da gop lai (khi dedupe). */
  patterns: string[];
  provenance: V18ExtractionProvenance;
}

/** Dau vao trich mot turn. */
export interface V18ExtractInput {
  text: string;
  episodeId?: string;
  turnId?: string;
  runId?: string;
  botId?: string;
  userId?: string;
  at?: string;
  scope?: MemoryScope;
  /** Do tin cay nguon 0..1 (mac dinh 1). */
  sourceTrust?: number;
  /** Ten nguon (mac dinh 'user-chat'). */
  sourceName?: string;
  /** Ten hien thi cua user — dung lam subject mac dinh. */
  userDisplayName?: string;
}

/** Ung vien bi bo qua khi ghi (kem ly do). */
export interface V18SkippedCandidate {
  subjectName: string;
  predicate: string;
  objectText: string;
  confidence: number;
  reason: string;
}

/** Bao cao trich + ghi mot turn. */
export interface V18ExtractReport {
  extracted: number;
  written: number;
  skipped: V18SkippedCandidate[];
  factIds: string[];
  /** So entity moi duoc tao khi resolve (khong tim thay truoc do). */
  entitiesCreated: number;
  /** So alias moi duoc gan khi resolve. */
  aliasesAdded: number;
}

/** Mau dinh danh subject trong text (VI + EN). */
const V18_IDENTITY_PATTERNS: { regex: RegExp; group: number }[] = [
  { regex: /(?:tôi\s+tên\s+là|tớ\s+tên\s+là|mình\s+tên\s+là|tên\s+tôi\s+là)\s+([A-ZÀ-Ỹ][\wÀ-ỹ]*(?:\s+[A-ZÀ-ỹ][\wÀ-ỹ]*){0,3})/i, group: 1 },
  { regex: /(?:my\s+name\s+is|i\s+am|i'm|call\s+me)\s+([A-Z][\w]*(?:\s+[A-Z][\w]*){0,3})/i, group: 1 },
  { regex: /(?:tôi\s+là|tớ\s+là|mình\s+là)\s+([A-ZÀ-Ỹ][\wÀ-ỹ]*(?:\s+[A-ZÀ-ỹ][\wÀ-ỹ]*){0,3})/i, group: 1 },
];

/**
 * Doan subject that tu text: mau dinh danh ("Tôi tên là An") thang
 * truoc subject mac dinh ("user"). Tra ve '' neu khong doan duoc.
 */
export function detectSubjectV18(text: string): string {
  const clean = (text ?? '').trim();
  if (clean === '') return '';
  for (const { regex, group } of V18_IDENTITY_PATTERNS) {
    const m = regex.exec(clean);
    if (m && m[group]) {
      const rawName = m[group].trim().replace(/[.,;!?]+$/, '').slice(0, V18_MAX_SUBJECT_CHARS);
      // Mau dung /i nen nhom ten co the "an" them tu thuong dung
      // sau ten ("My name is Binh and I like coffee" -> "Binh and
      // I like"). Chi giu cac tu dau viet hoa lien tiep — ten
      // rieng that su — bo phan con lai.
      const words = rawName.split(/\s+/).filter((w) => w !== '');
      const kept: string[] = [];
      for (const w of words) {
        const first = w[0] ?? '';
        if (first === first.toUpperCase() && first !== first.toLowerCase()) kept.push(w);
        else break;
      }
      const name = kept.join(' ');
      if (name.length >= 2) return name;
    }
  }
  return '';
}

/** Clamp 0..1. */
export function clamp01V18(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Gop ung vien trung lap: cung subject chuan hoa + predicate +
 * object chuan hoa -> giu confidence cao nhat, gop pattern.
 */
export function dedupeCandidatesV18(candidates: V18ExtractedFact[]): V18ExtractedFact[] {
  const byKey = new Map<string, V18ExtractedFact>();
  for (const cand of candidates) {
    const key = [
      normalizeGraphText(cand.subjectName),
      normalizeGraphText(cand.predicate).replace(/\s+/g, '_'),
      normalizeGraphText(cand.objectText),
    ].join('|');
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...cand, patterns: [...cand.patterns] });
      continue;
    }
    if (cand.confidence > prev.confidence) {
      prev.confidence = cand.confidence;
      prev.rawConfidence = cand.rawConfidence;
    }
    for (const p of cand.patterns) if (!prev.patterns.includes(p)) prev.patterns.push(p);
  }
  return [...byKey.values()];
}

/**
 * Trich fact tu mot turn (khong ghi): lop nang cap tren v15.
 *
 *  - Lay ung vien v15 (rule-based, khong goi model).
 *  - Subject: neu text co mau dinh danh thi dung ten do, khong thi
 *    dung `userDisplayName` (mac dinh 'user').
 *  - Resolve subject + object qua `V16EntityLinker` (ghi alias khi
 *    gap bien the, tao entity moi khi chua co).
 *  - Confidence hieu dung = raw * sourceTrust.
 */
export function extractV18(
  store: TemporalGraphStore,
  input: V18ExtractInput,
  linker?: V16EntityLinker,
): V18ExtractedFact[] {
  const text = (input.text ?? '').trim();
  if (text === '') return [];
  const at = input.at ?? new Date().toISOString();
  const sourceTrust = clamp01V18(input.sourceTrust ?? 1);
  const sourceName = (input.sourceName ?? 'user-chat').trim() || 'user-chat';
  const detected = detectSubjectV18(text);
  const defaultSubject = (input.userDisplayName ?? '').trim() || 'user';
  const subjectName = detected || defaultSubject;
  const activeLinker = linker ?? new V16EntityLinker(store);
  const scope: MemoryScope = input.scope ?? {
    userId: input.userId ?? '',
    botId: input.botId ?? '',
    runId: input.runId ?? '',
  };

  const raw: V15ExtractedFact[] = extractFactsV15Sync(text, sourceTrust);
  const out: V18ExtractedFact[] = [];
  for (const cand of raw) {
    // Ung vien v15 mang subject tu do; chuan hoa ve subject that
    // cua turn nay khi subject goc la dai tu chi nguoi dung.
    const rawSubject = (cand.subject ?? '').trim();
    const isSelfPronoun = /^(user|tôi|tớ|mình|em|anh|chị|i|we)$/i.test(rawSubject);
    const finalSubject = isSelfPronoun || rawSubject === '' ? subjectName : rawSubject;
    let subjectEntity: GraphEntity;
    try {
      subjectEntity = activeLinker.resolve(finalSubject, 'person').entity;
    } catch {
      subjectEntity = store.ensureEntity(finalSubject, 'person');
    }
    // Object: chi resolve lam entity khi v15 danh dau object la
    // entity (vd ten rieng); khong thi giu text tu do.
    let objectEntity: GraphEntity | null = null;
    let objectIsEntity = false;
    if (/^[A-ZÀ-Ỹ]/.test((cand.objectText ?? '').trim())) {
      try {
        const resolved = activeLinker.resolve(cand.objectText.trim(), 'other');
        objectEntity = resolved.entity;
        objectIsEntity = true;
      } catch {
        objectEntity = null;
        objectIsEntity = false;
      }
    }
    out.push({
      subjectName: finalSubject,
      subjectEntity,
      objectEntity,
      predicate: normalizeGraphText(cand.predicate).replace(/\s+/g, '_'),
      objectText: (cand.objectText ?? '').trim(),
      objectIsEntity,
      rawConfidence: clamp01V18(cand.confidence),
      confidence: clamp01V18(cand.confidence * sourceTrust),
      sourceTrust,
      patterns: [cand.pattern],
      provenance: {
        episodeId: input.episodeId ?? '',
        turnId: input.turnId ?? '',
        runId: input.runId ?? '',
        botId: input.botId ?? '',
        userId: input.userId ?? '',
        sourceName,
        sourceTrust,
        pattern: cand.pattern,
        extractedAt: at,
        sourceText: (cand.sourceText ?? text).slice(0, 500),
      },
    });
  }
  void scope;
  return dedupeCandidatesV18(out);
}

/**
 * Trich + ghi thang vao store. Ung vien vuot `minConfidence` thi
 * `addFact` (subject/object da resolve, mang provenance day du);
 * ung vien duoi nguong thi ghi vao `skipped` co ly do, khong ghi.
 */
export function extractAndWriteV18(
  store: TemporalGraphStore,
  input: V18ExtractInput & { scope: MemoryScope },
  opts: { minConfidence?: number; linker?: V16EntityLinker } = {},
): V18ExtractReport {
  const minConfidence = clamp01V18(opts.minConfidence ?? V18_DEFAULT_MIN_CONFIDENCE);
  const linker = opts.linker ?? new V16EntityLinker(store);
  const beforeLinks = linker.size;
  const candidates = extractV18(store, input, linker);
  const report: V18ExtractReport = {
    extracted: candidates.length,
    written: 0,
    skipped: [],
    factIds: [],
    entitiesCreated: 0,
    aliasesAdded: 0,
  };
  // Dem entity moi / alias moi tu bang lien ket sau khi resolve.
  // (linker chi dem dong link; dem don gian: so entity tang them.)
  const entityCountBefore = store.listEntities().length;
  for (const cand of candidates) {
    if (cand.confidence < minConfidence) {
      report.skipped.push({
        subjectName: cand.subjectName,
        predicate: cand.predicate,
        objectText: cand.objectText,
        confidence: cand.confidence,
        reason: `confidence ${cand.confidence.toFixed(2)} duoi nguong ${minConfidence.toFixed(2)}`,
      });
      continue;
    }
    if (cand.objectText === '') {
      report.skipped.push({
        subjectName: cand.subjectName,
        predicate: cand.predicate,
        objectText: '',
        confidence: cand.confidence,
        reason: 'object rong',
      });
      continue;
    }
    const fact: GraphFact = store.addFact({
      subjectName: cand.subjectEntity.name,
      kind: cand.subjectEntity.kind,
      predicate: cand.predicate,
      objectText: cand.objectText,
      objectIsEntity: cand.objectIsEntity,
      confidence: cand.confidence,
      scope: input.scope,
      provenance: {
        episodeId: cand.provenance.episodeId,
        turnId: cand.provenance.turnId,
        runId: cand.provenance.runId,
        botId: cand.provenance.botId,
        userId: cand.provenance.userId,
        at: cand.provenance.extractedAt,
        sourceText: cand.provenance.sourceText,
      },
    });
    report.factIds.push(fact.id);
    report.written += 1;
  }
  void beforeLinks;
  report.entitiesCreated = Math.max(0, store.listEntities().length - entityCountBefore);
  // Alias moi: dem alias tren cac entity duoc resolve trong dot nay.
  let aliases = 0;
  for (const cand of candidates) {
    aliases += cand.subjectEntity.aliases.length;
    if (cand.objectEntity) aliases += cand.objectEntity.aliases.length;
  }
  report.aliasesAdded = aliases;
  return report;
}

/**
 * Trich tu mot episode da ingest trong store: lay text episode,
 * trich bang `extractV18`, ghi fact, danh dau episode processed.
 * Tra ve bao cao ghi + id episode (null neu khong tim thay).
 */
export function extractEpisodeV18(
  store: TemporalGraphStore,
  episodeId: string,
  opts: { minConfidence?: number; sourceName?: string; sourceTrust?: number } = {},
): (V18ExtractReport & { episodeId: string }) | null {
  const episode = store.getEpisode(episodeId);
  if (!episode) return null;
  const report = extractAndWriteV18(
    store,
    {
      text: episode.text,
      episodeId: episode.id,
      turnId: episode.turnId,
      runId: episode.runId,
      botId: episode.botId,
      userId: episode.userId,
      at: episode.createdAt,
      scope: { userId: episode.userId, botId: episode.botId, runId: episode.runId },
      sourceTrust: opts.sourceTrust ?? 1,
      sourceName: opts.sourceName ?? 'user-chat',
    },
    { minConfidence: opts.minConfidence },
  );
  store.markEpisodeProcessed(episodeId, report.factIds);
  return { ...report, episodeId };
}
