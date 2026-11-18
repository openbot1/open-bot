/**
 * Memory v17 — Memory poisoning guard v2 (admission pipeline) (v1.18, Doi T1).
 *
 * Y tuong hoc tu OWASP ASI06 (Memory & Context Poisoning) + Mem0
 * 2026 (extraction 1 pass, judge truoc khi ghi) + Letta (agent tu
 * sua core block qua tool — nen moi fact vao core phai co nguon
 * goc day du) — tu thiet ke lai hoan toan cho open-bot, chay 100%
 * local, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `V16SourceAllowlist` / `corePromotionGateV16` /
 *    `verifyProvenanceV16` / `quarantineCandidateV16` /
 *    `reviewQuarantineBatchV16` / `expireStaleQuarantineV16` cua
 *    memory/v16/poisoningGuard: allowlist + gate + xac minh
 *    provenance + quarantine duy nhat cua store; v17 la lop
 *    ADMISSION PIPELINE ben tren — quyet dinh fact moi duoc
 *    vao thang, phai qua nguoi duyet, hay bi tu choi.
 *  - `judgeCandidateV14` cua memory/v14/poisoning: judge
 *    rule-based 5 tin hieu (duoc goi gian tiep qua gate v16).
 *  - `TemporalGraphStore.addToQuarantine` / `reviewQuarantine`:
 *    quarantine duy nhat cua store; v17 goi lai, khong tao
 *    quarantine song song.
 *
 * Moi trong v17:
 *  1. Provenance chain: `verifyProvenanceChainV17` — kiem tra
 *     chuoi nguon goc day du cua ung vien: episode goc ton tai,
 *     cac fact cha (parentFactIds, neu co) ton tai, khong co
 *     vong tron (fact cha khong tro lai chinh no), do sau chuoi
 *     <= gioi han. Fact "mo coi" hoac chuoi dut gay -> reject
 *     thang, khong cho vao quarantine (tranh dong ton rac).
 *  2. Admission pipeline 3 tang: `admitCandidateV17` —
 *     (a) nguon deny -> reject; (b) chain hong -> reject;
 *     (c) gate v16 reject -> reject; (d) gate quarantine / risk
 *     cao -> dua vao quarantine, doi nguoi duyet (staged review);
 *     (e) risk thap + provenance day du -> auto-admit vao graph
 *     ngay (ghi audit). Moi buoc ghi audit JSONL.
 *  3. Staged review: `reviewAdmissionV17` — duyet 1 muc
 *     quarantine theo pipeline v17 (approve -> fact vao graph
 *     qua store.reviewQuarantine; reject -> giu lai audit);
 *     `admitBatchV17` — admit hang loat ung vien, tra bao cao
 *     tung muc; `admissionStatsV17` — dem auto-admit / review /
 *     reject theo ngay.
 *  4. `exportProvenanceChainV17` — xuat chuoi provenance cua
 *     mot fact thanh text de UI hien thi ("fact nay den tu dau").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GraphFact, MemoryScope, QuarantineItem } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import {
  V16SourceAllowlist,
  corePromotionGateV16,
  quarantineCandidateV16,
} from '../v16/poisoningGuard';
import type { V16CandidateFact } from '../v16/consolidationOps';
import { reviewQuarantineV14 } from '../v14/poisoning';

/** Loi poisoning guard v2 — message tieng Viet. */
export class V17PoisoningGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V17PoisoningGuardError';
  }
}

/** Quyet dinh admission cua pipeline v17. */
export type V17AdmissionDecision = 'auto-admit' | 'human-review' | 'reject';

/** Ket qua xac minh chuoi provenance. */
export interface V17ProvenanceChainCheck {
  ok: boolean;
  errors: string[];
  /** Do sau chuoi (so fact cha noi nhau). */
  depth: number;
  /** Episode goc co ton tai khong. */
  episodeExists: boolean;
  /** So fact cha tim thay / tong so fact cha khai bao. */
  parentsFound: number;
  parentsTotal: number;
}

/** Ung vien admission v17 (mo rong ung vien v16 them chuoi cha). */
export interface V17AdmissionCandidate extends V16CandidateFact {
  /** Id cac fact cha ma ung vien nay suy ra / thay the (tuy chon). */
  parentFactIds?: string[];
}

/** Ket qua mot lan admit. */
export interface V17AdmissionResult {
  decision: V17AdmissionDecision;
  /** Ly do bang tieng Viet (de UI hien thi). */
  reasons: string[];
  /** Fact da tao (chi khi auto-admit). */
  fact?: GraphFact;
  /** Muc quarantine da tao (chi khi human-review). */
  quarantineItem?: QuarantineItem;
  /** Ket qua xac minh chuoi provenance. */
  chainCheck: V17ProvenanceChainCheck;
  /** Risk cua judge v16 (neu da chay). */
  risk: number | null;
}

/** Tuy chon admission pipeline. */
export interface V17AdmissionOptions {
  allowlist?: V16SourceAllowlist;
  /** Risk toi da de auto-admit (mac dinh 0.2 — thap = chat). */
  maxAutoAdmitRisk?: number;
  /** Confidence hieu dung toi thieu de auto-admit (mac dinh 0.7). */
  minAutoAdmitConfidence?: number;
  /** Do sau chuoi provenance toi da (mac dinh 5). */
  maxChainDepth?: number;
  /** Actor ghi audit (mac dinh 'system:v17-admission'). */
  actor?: string;
  /** Thoi diem danh gia (mac dinh: bay gio). */
  now?: Date;
}

/** Mot muc audit admission (dong JSONL). */
export interface V17AdmissionAuditEntry {
  at: string;
  decision: V17AdmissionDecision;
  subject: string;
  predicate: string;
  objectText: string;
  sourceName: string;
  risk: number | null;
  reasons: string;
  actor: string;
}

export const V17_ADMISSION_AUDIT_REL_PATH = path.join('.open-bot', 'memory-v17-admission-audit.jsonl');
/** Risk mac dinh de auto-admit (chat: chi fact sach moi tu vao). */
export const V17_DEFAULT_MAX_AUTO_ADMIT_RISK = 0.2;
/** Confidence hieu dung toi thieu de auto-admit. */
export const V17_DEFAULT_MIN_AUTO_ADMIT_CONFIDENCE = 0.7;
/** Do sau chuoi provenance toi da. */
export const V17_DEFAULT_MAX_CHAIN_DEPTH = 5;

/** Ghi audit admission (append-only JSONL, best-effort). */
export function appendV17AdmissionAudit(workspaceDir: string, entry: V17AdmissionAuditEntry): void {
  try {
    const filePath = path.join(workspaceDir, V17_ADMISSION_AUDIT_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Audit best-effort.
  }
}

/** Doc audit admission (moi nhat cuoi, gioi han so dong). */
export function readV17AdmissionAudit(workspaceDir: string, limit = 500): V17AdmissionAuditEntry[] {
  try {
    const filePath = path.join(workspaceDir, V17_ADMISSION_AUDIT_REL_PATH);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const out: V17AdmissionAuditEntry[] = [];
    for (const line of lines.slice(-Math.max(0, limit))) {
      try {
        const parsed = JSON.parse(line) as V17AdmissionAuditEntry;
        if (parsed && typeof parsed.decision === 'string') out.push(parsed);
      } catch {
        // Bo dong hong.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Xac minh chuoi provenance cua ung vien: episode goc phai ton
 * tai; moi fact cha khai bao phai ton tai; khong co vong tron
 * (fact cha khong duoc la chinh ung vien / khong tro ve ung vien
 * qua supersedes); do sau chuoi (di theo supersedes nguoc) khong
 * vuot gioi han.
 */
export function verifyProvenanceChainV17(
  store: TemporalGraphStore,
  candidate: V17AdmissionCandidate,
  opts: { maxChainDepth?: number } = {},
): V17ProvenanceChainCheck {
  const errors: string[] = [];
  const maxDepth = opts.maxChainDepth ?? V17_DEFAULT_MAX_CHAIN_DEPTH;
  const episodeId = candidate.episodeId ?? '';
  let episodeExists = false;
  if (episodeId === '') {
    errors.push('Ung vien khong co episodeId — fact mo coi.');
  } else {
    episodeExists = store.getEpisode(episodeId) !== undefined && store.getEpisode(episodeId) !== null;
    if (!episodeExists) errors.push(`Episode goc "${episodeId}" khong ton tai trong store.`);
  }
  if ((candidate.sourceText ?? '').trim() === '') {
    errors.push('Ung vien thieu sourceText (cau goc).');
  }
  const parents = candidate.parentFactIds ?? [];
  let parentsFound = 0;
  const seen = new Set<string>();
  for (const parentId of parents) {
    if (seen.has(parentId)) {
      errors.push(`Fact cha "${parentId}" lap lai trong chuoi.`);
      continue;
    }
    seen.add(parentId);
    const parent = store.getFact(parentId);
    if (!parent) {
      errors.push(`Fact cha "${parentId}" khong ton tai trong store.`);
    } else {
      parentsFound += 1;
    }
  }
  // Do sau: di theo supersedes tu fact cha dau tien.
  let depth = parents.length > 0 ? 1 : 0;
  let cursor: string | undefined = parents[0];
  const visited = new Set<string>();
  while (cursor && depth <= maxDepth + 1) {
    if (visited.has(cursor)) {
      errors.push('Chuoi supersedes co vong tron.');
      break;
    }
    visited.add(cursor);
    const fact = store.getFact(cursor);
    if (!fact || !fact.supersedes) break;
    depth += 1;
    cursor = fact.supersedes;
  }
  if (depth > maxDepth) {
    errors.push(`Chuoi provenance sau ${depth} vuot gioi han ${maxDepth}.`);
  }
  return {
    ok: errors.length === 0,
    errors,
    depth,
    episodeExists,
    parentsFound,
    parentsTotal: parents.length,
  };
}

/**
 * Admission pipeline 3 tang cho mot ung vien fact moi:
 * deny -> reject; chain hong -> reject; gate v16 reject ->
 * reject; gate quarantine hoac risk/confidence khong du chuan
 * auto -> human-review (vao quarantine); con lai -> auto-admit
 * vao graph ngay. Khong bao gio ghi thang vao core block o day
 * (core promotion la buoc rieng, co gate rieng).
 */
export function admitCandidateV17(
  store: TemporalGraphStore,
  workspaceDir: string,
  candidate: V17AdmissionCandidate,
  scope: MemoryScope,
  sourceName: string,
  opts: V17AdmissionOptions = {},
): V17AdmissionResult {
  const allowlist = opts.allowlist ?? new V16SourceAllowlist();
  const maxRisk = opts.maxAutoAdmitRisk ?? V17_DEFAULT_MAX_AUTO_ADMIT_RISK;
  const minConfidence = opts.minAutoAdmitConfidence ?? V17_DEFAULT_MIN_AUTO_ADMIT_CONFIDENCE;
  const actor = opts.actor ?? 'system:v17-admission';
  const now = opts.now ?? new Date();
  const atIso = now.toISOString();

  const finish = (
    decision: V17AdmissionDecision,
    reasons: string[],
    extra: Partial<V17AdmissionResult> = {},
  ): V17AdmissionResult => {
    const result: V17AdmissionResult = {
      decision,
      reasons,
      chainCheck: extra.chainCheck ?? {
        ok: true,
        errors: [],
        depth: 0,
        episodeExists: false,
        parentsFound: 0,
        parentsTotal: 0,
      },
      risk: extra.risk ?? null,
      ...(extra.fact ? { fact: extra.fact } : {}),
      ...(extra.quarantineItem ? { quarantineItem: extra.quarantineItem } : {}),
    };
    appendV17AdmissionAudit(workspaceDir, {
      at: atIso,
      decision,
      subject: candidate.subject,
      predicate: candidate.predicate,
      objectText: candidate.objectText,
      sourceName,
      risk: result.risk,
      reasons: reasons.join(' '),
      actor,
    });
    return result;
  };

  if (allowlist.isDenied(sourceName)) {
    return finish('reject', [`Nguon "${sourceName}" nam trong denylist — tu choi.`]);
  }

  const chainCheck = verifyProvenanceChainV17(store, candidate, {
    maxChainDepth: opts.maxChainDepth,
  });
  if (!chainCheck.ok) {
    return finish('reject', [`Chuoi provenance khong hop le: ${chainCheck.errors.join(' ')}`], { chainCheck });
  }

  const gate = corePromotionGateV16(store, candidate, scope, sourceName, { allowlist });
  const risk = gate.judgeVerdict?.risk ?? null;
  if (gate.decision === 'reject') {
    return finish('reject', [`Gate v16 reject: ${gate.reasons.join(' ')}`], { chainCheck, risk });
  }
  if (gate.decision === 'quarantine') {
    const item = quarantineCandidateV16(store, candidate, scope, gate.judgeVerdict!);
    return finish(
      'human-review',
      [`Gate v16 quarantine — doi nguoi duyet: ${gate.reasons.join(' ')}`],
      { chainCheck, risk, quarantineItem: item },
    );
  }

  // Gate allow nhung chua du chuan auto-admit (risk/confidence) -> human-review.
  const effective = candidate.effectiveConfidence;
  if ((risk !== null && risk > maxRisk) || effective < minConfidence) {
    const item = quarantineCandidateV16(store, candidate, scope, gate.judgeVerdict!);
    return finish(
      'human-review',
      [
        `Chua du chuan auto-admit (risk ${risk !== null ? risk.toFixed(2) : '?'} > ${maxRisk}, confidence ${effective.toFixed(2)} < ${minConfidence}) — doi nguoi duyet.`,
      ],
      { chainCheck, risk, quarantineItem: item },
    );
  }

  // Auto-admit: ghi fact vao graph (qua store.addFact — co provenance day du).
  const fact = store.addFact({
    subjectName: candidate.subject,
    predicate: candidate.predicate,
    objectText: candidate.objectText,
    confidence: candidate.confidence,
    scope,
    provenance: {
      episodeId: candidate.episodeId ?? '',
      turnId: candidate.turnId ?? '',
      runId: candidate.runId ?? scope.runId,
      botId: candidate.botId ?? scope.botId,
      userId: candidate.userId ?? scope.userId,
      at: candidate.at ?? atIso,
      sourceText: candidate.sourceText ?? '',
    },
    ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
    ...(candidate.validUntil !== undefined ? { validUntil: candidate.validUntil } : {}),
  });
  return finish(
    'auto-admit',
    [`Auto-admit: risk ${risk !== null ? risk.toFixed(2) : '0.00'} <= ${maxRisk}, confidence ${effective.toFixed(2)} >= ${minConfidence}, chuoi provenance day du.`],
    { chainCheck, risk, fact },
  );
}

/** Duyet 1 muc quarantine theo pipeline v17 (goi lai review v14 cua store). */
export function reviewAdmissionV17(
  store: TemporalGraphStore,
  workspaceDir: string,
  quarantineId: string,
  decision: 'approved' | 'rejected',
  reviewedBy: string,
): { item: QuarantineItem; fact?: GraphFact } {
  if ((reviewedBy ?? '').trim() === '') {
    throw new V17PoisoningGuardError('reviewedBy khong duoc rong (can audit ai duyet).');
  }
  const result = reviewQuarantineV14(store, quarantineId, decision, reviewedBy);
  appendV17AdmissionAudit(workspaceDir, {
    at: new Date().toISOString(),
    decision: decision === 'approved' ? 'auto-admit' : 'reject',
    subject: result.item.candidate.subjectName,
    predicate: result.item.candidate.predicate,
    objectText: result.item.candidate.objectText,
    sourceName: 'quarantine-review',
    risk: null,
    reasons: `Nguoi duyet ${reviewedBy} ${decision === 'approved' ? 'chap nhan' : 'tu choi'} muc quarantine ${quarantineId}.`,
    actor: reviewedBy,
  });
  return result;
}

/** Ket qua admit hang loat. */
export interface V17AdmissionBatchReport {
  total: number;
  autoAdmitted: number;
  humanReview: number;
  rejected: number;
  results: V17AdmissionResult[];
}

/** Admit hang loat ung vien (moi muc ghi audit rieng, loi 1 muc khong dung ca lo). */
export function admitBatchV17(
  store: TemporalGraphStore,
  workspaceDir: string,
  candidates: V17AdmissionCandidate[],
  scope: MemoryScope,
  sourceName: string,
  opts: V17AdmissionOptions = {},
): V17AdmissionBatchReport {
  const report: V17AdmissionBatchReport = {
    total: candidates.length,
    autoAdmitted: 0,
    humanReview: 0,
    rejected: 0,
    results: [],
  };
  for (const candidate of candidates) {
    try {
      const result = admitCandidateV17(store, workspaceDir, candidate, scope, sourceName, opts);
      report.results.push(result);
      if (result.decision === 'auto-admit') report.autoAdmitted += 1;
      else if (result.decision === 'human-review') report.humanReview += 1;
      else report.rejected += 1;
    } catch (err) {
      const chainCheck: V17ProvenanceChainCheck = {
        ok: false,
        errors: [err instanceof Error ? err.message : String(err)],
        depth: 0,
        episodeExists: false,
        parentsFound: 0,
        parentsTotal: 0,
      };
      report.results.push({
        decision: 'reject',
        reasons: [`Loi khi admit: ${chainCheck.errors[0]}`],
        chainCheck,
        risk: null,
      });
      report.rejected += 1;
    }
  }
  return report;
}

/** Thong ke admission theo ngay (tu audit log). */
export interface V17AdmissionStats {
  at: string;
  total: number;
  autoAdmitted: number;
  humanReview: number;
  rejected: number;
  /** Ty le auto-admit (0..1). */
  autoAdmitRate: number;
}

/** Thong ke admission trong N ngay gan nhat (mac dinh 7). */
export function admissionStatsV17(
  workspaceDir: string,
  opts: { days?: number; now?: Date } = {},
): V17AdmissionStats {
  const days = opts.days ?? 7;
  const now = opts.now ?? new Date();
  const sinceMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const entries = readV17AdmissionAudit(workspaceDir, 10000).filter(
    (e) => Date.parse(e.at) >= sinceMs,
  );
  const autoAdmitted = entries.filter((e) => e.decision === 'auto-admit').length;
  const humanReview = entries.filter((e) => e.decision === 'human-review').length;
  const rejected = entries.filter((e) => e.decision === 'reject').length;
  return {
    at: now.toISOString(),
    total: entries.length,
    autoAdmitted,
    humanReview,
    rejected,
    autoAdmitRate: entries.length > 0 ? autoAdmitted / entries.length : 0,
  };
}

/**
 * Xuat chuoi provenance cua mot fact thanh text de UI hien thi:
 * fact -> episode goc -> (fact cha qua supersedes) -> ... Kiem
 * tra vong tron khi di chuoi (dung lai neu gap lai id da thay).
 */
export function exportProvenanceChainV17(store: TemporalGraphStore, factId: string): string {
  const fact = store.getFact(factId);
  if (!fact) return `Khong tim thay fact "${factId}".`;
  const lines: string[] = [];
  const subjectName = store.getEntity(fact.subjectId)?.name ?? fact.subjectId;
  lines.push(`Fact: ${subjectName} —${fact.predicate}→ ${fact.objectText ?? ''} (confidence ${fact.confidence.toFixed(2)}, ${fact.status})`);
  lines.push(`  Episode goc: ${fact.provenance.episodeId} (turn ${fact.provenance.turnId}, ${fact.provenance.at})`);
  lines.push(`  Cau goc: "${(fact.provenance.sourceText ?? '').slice(0, 200)}"`);
  lines.push(`  Scope: user=${fact.scope.userId || '(rong)'} bot=${fact.scope.botId || '(rong)'} run=${fact.scope.runId || '(rong)'}`);
  const seen = new Set<string>([fact.id]);
  let cursor: string | undefined = fact.supersedes;
  let depth = 0;
  while (cursor && depth < V17_DEFAULT_MAX_CHAIN_DEPTH) {
    if (seen.has(cursor)) {
      lines.push(`  [vong tron tai ${cursor} — dung chuoi]`);
      break;
    }
    seen.add(cursor);
    const parent = store.getFact(cursor);
    if (!parent) {
      lines.push(`  [fact cha ${cursor} khong ton tai]`);
      break;
    }
    const parentName = store.getEntity(parent.subjectId)?.name ?? parent.subjectId;
    lines.push(`  Thay the: ${parentName} —${parent.predicate}→ ${parent.objectText ?? ''} (${parent.status})`);
    cursor = parent.supersedes;
    depth += 1;
  }
  return lines.join('\n');
}
