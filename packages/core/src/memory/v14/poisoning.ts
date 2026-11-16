/**
 * Memory v14 — Memory poisoning defence, OWASP ASI06 (v1.15, Doi T1).
 *
 * Y tuong hoc tu OWASP Agentic AI Threats ASI06 (Memory & Context
 * Poisoning: ke tan cong chen fact doc hai vao bo nho de agent hanh
 * dong sai o phien sau) va tuyen phong thu quarantine da co cua
 * open-bot (consolidateGraph: mau nghi ngo -> quarantine cho user
 * duyet) — tu thiet ke lai hoan toan cho open-bot, KHONG copy
 * code/text/tai san cua bat ky repo nao.
 *
 * Ke thua, khong viet lai:
 *  - `findSuspiciousPattern` / `SUSPICIOUS_PATTERNS` cua
 *    consolidateGraph (v0.98): v14 GIU NGUYEN va THEM mau moi
 *    (gia mao danh tinh, chen chi thi "tu gio tro di", lo mat
 *    khau, lenh xoa sach...).
 *  - `TemporalGraphStore.addToQuarantine` / `listQuarantine` /
 *    `reviewQuarantine` (v0.98): kho quarantine duy nhat; v14 chi
 *    them lop judge + audit ben tren.
 *  - `V14ExtractionGate` cua extraction.ts: judge nay cam thang
 *    vao `applyExtractionV14` lam gate.
 *
 * Judge rule-based (khong goi model): moi ung vien duoc cham
 * diem rui ro 0..1 tu 5 tin hieu — mau nghi ngo, mau thuan voi
 * fact tin cay cao, nguon khong tin cay, confidence thap, tran
 * fact (flood). Nguong cau hinh duoc:
 *  - risk >= rejectRisk (mac dinh 0.85) -> REJECT (khong ghi, khong quarantine).
 *  - risk >= quarantineRisk (mac dinh 0.5) -> QUARANTINE (cho user duyet).
 *  - con lai -> ACCEPT.
 * Ngoai le cung: mau nghi ngo + trust < 0.3 -> reject thang;
 * confidence hieu dung < 0.3 -> reject thang (fact qua yeu).
 * Moi quyet dinh deu ghi audit JSONL (ai/quyet dinh gi/vi sao).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphFact, MemoryScope, QuarantineItem, QuarantineReason } from '../graph/types';
import { normalizeGraphText } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { ScopeFilter } from '../graph/store';
import { findSuspiciousPattern } from '../graph/consolidateGraph';
import type { V14ExtractedFact, V14ExtractionGate } from './extraction';
import { isSingleValuedPredicateV14 } from './extraction';

/** Loi poisoning defence v14 — message tieng Viet. */
export class V14PoisoningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V14PoisoningError';
  }
}

export type V14JudgeDecision = 'accept' | 'quarantine' | 'reject';

export interface V14JudgeSignals {
  /** Mau nghi ngo khop (neu co). */
  suspiciousPattern: string | null;
  /** Fact cu mau thuan manh nhat (neu co). */
  conflictingFact: GraphFact | null;
  /** Confidence cua fact cu mau thuan (0 neu khong co). */
  conflictingConfidence: number;
  sourceTrust: number;
  effectiveConfidence: number;
  /** So ung vien cung episode/turn (de phat hien flood). */
  sameEpisodeCount: number;
}

export interface V14JudgeVerdict {
  decision: V14JudgeDecision;
  /** Diem rui ro 0..1 (cao = nguy hiem). */
  risk: number;
  signals: V14JudgeSignals;
  reasons: string[];
  /** Ly do quarantine tuong ung trong store (neu decision != accept). */
  quarantineReason: QuarantineReason | null;
}

export interface V14JudgeThresholds {
  /** Risk >= nguong nay -> reject (mac dinh 0.85). */
  rejectRisk?: number;
  /** Risk >= nguong nay -> quarantine (mac dinh 0.5). */
  quarantineRisk?: number;
  /** Fact cu co confidence >= nguong nay thi coi la "tin cay cao" (mac dinh 0.85). */
  highConfidenceConflict?: number;
  /** Confidence hieu dung < nguong nay -> reject thang (mac dinh 0.3). */
  minAcceptConfidence?: number;
  /** Trust < nguong nay + mau nghi ngo -> reject thang (mac dinh 0.3). */
  lowTrustReject?: number;
  /** So ung vien cung episode vuot nguong nay -> tinh la flood (mac dinh 8). */
  floodThreshold?: number;
}

export const V14_DEFAULT_JUDGE_THRESHOLDS: Required<V14JudgeThresholds> = {
  rejectRisk: 0.85,
  quarantineRisk: 0.5,
  highConfidenceConflict: 0.85,
  minAcceptConfidence: 0.3,
  lowTrustReject: 0.3,
  floodThreshold: 8,
};

// ---------------------------------------------------------------------------
// Source trust registry
// ---------------------------------------------------------------------------

/** Do tin cay mac dinh theo loai nguon (0..1). */
export const V14_DEFAULT_SOURCE_TRUSTS: Record<string, number> = {
  'user-chat': 1.0,
  'user-notes': 0.9,
  'user-import': 0.7,
  'agent-self': 0.8,
  'web-scrape': 0.4,
  'third-party-agent': 0.3,
  'unknown': 0.5,
};

export interface V14SourceTrustEntry {
  sourceName: string;
  trust: number;
  reason: string;
  updatedAt: string;
}

/**
 * Registry do tin cay nguon (in-memory; host co the luu/khoi phuc
 * bang export/import). Nguon chua dang ky dung gia tri mac dinh
 * theo loai, khong biet -> 0.5.
 */
export class V14SourceTrustRegistry {
  private readonly entries = new Map<string, V14SourceTrustEntry>();

  register(sourceName: string, trust: number, reason = ''): V14SourceTrustEntry {
    const clean = (sourceName ?? '').trim() || 'unknown';
    if (!Number.isFinite(trust) || trust < 0 || trust > 1) {
      throw new V14PoisoningError(`Do tin cay phai trong [0, 1], nhan ${trust}.`);
    }
    const entry: V14SourceTrustEntry = {
      sourceName: clean,
      trust,
      reason: reason.slice(0, 500),
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(clean, entry);
    return entry;
  }

  trustOf(sourceName: string): number {
    const clean = (sourceName ?? '').trim() || 'unknown';
    const direct = this.entries.get(clean);
    if (direct) return direct.trust;
    return V14_DEFAULT_SOURCE_TRUSTS[clean] ?? V14_DEFAULT_SOURCE_TRUSTS['unknown'] ?? 0.5;
  }

  get(sourceName: string): V14SourceTrustEntry | undefined {
    return this.entries.get((sourceName ?? '').trim() || 'unknown');
  }

  list(): V14SourceTrustEntry[] {
    return [...this.entries.values()].sort((a, b) => a.sourceName.localeCompare(b.sourceName));
  }

  export(): V14SourceTrustEntry[] {
    return this.list();
  }

  import(entries: V14SourceTrustEntry[]): number {
    let count = 0;
    for (const e of entries ?? []) {
      if (!e || typeof e.sourceName !== 'string') continue;
      this.register(e.sourceName, e.trust, e.reason ?? '');
      count += 1;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Mau nghi ngo bo sung cua v14 (them vao mau cua consolidateGraph)
// ---------------------------------------------------------------------------

export const V14_SUSPICIOUS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /từ\s+giờ\s+(trở\s+đi|tro\s+di)/iu, label: 'chi thi vinh vien "tu gio tro di"' },
  { re: /from\s+now\s+on/iu, label: 'from now on (chi thi vinh vien)' },
  { re: /mật\s+khẩu\s+(của\s+)?(tôi|toi|mình|minh)\s+là/iu, label: 'lo mat khau vao memory' },
  { re: /\bpassword\s+is\b/iu, label: 'password is (lo mat khau)' },
  { re: /hãy\s+(giả\s+vờ|gia\s+vo|đóng\s+vai)\s+/iu, label: 'gia vo / dong vai' },
  { re: /pretend\s+(to\s+be|you\s+are)/iu, label: 'pretend to be (gia mao)' },
  { re: /bạn\s+là\s+(một\s+)?(ai|con\s+người|người)\s+khác/iu, label: 'doi danh tinh agent' },
  { re: /ghi\s+đè\s+(lên\s+)?(mọi|moi|tất\s+cả|tat\s+ca)/iu, label: 'ghi de toan bo memory' },
  { re: /overwrite\s+(all|everything)/iu, label: 'overwrite all (ghi de toan bo)' },
  { re: /\[INST\]|\[\/INST\]/iu, label: 'the prompt-injection [INST]' },
  { re: /<\|?(system|im_start)\|?>/iu, label: 'the system gia mao' },
];

export function findV14SuspiciousPattern(text: string): string | null {
  const base = findSuspiciousPattern(text ?? '');
  if (base) return base;
  for (const entry of V14_SUSPICIOUS_PATTERNS) {
    if (entry.re.test(text ?? '')) return entry.label;
  }
  // Kiem tra KHONG DAU (normalizeGraphText bo dau tieng Viet): cau
  // tan cong viet khong dau ("Hay quen het moi thu di") van phai
  // bi bat, khong chi ban co dau.
  const norm = normalizeGraphText(text ?? '');
  if (norm === '') return null;
  for (const entry of V14_SUSPICIOUS_PATTERNS_NORM) {
    if (entry.re.test(norm)) return entry.label;
  }
  return null;
}

/**
 * Mau nghi ngo dang KHONG DAU (test tren text da normalizeGraphText:
 * chu thuong, bo dau, bo dau cau). Bao phu ca mau goc cua
 * consolidateGraph lan mau bo sung cua v14.
 */
export const V14_SUSPICIOUS_PATTERNS_NORM: { re: RegExp; label: string }[] = [
  { re: /quen\s+(het|tat\s+ca|moi)/, label: 'lệnh quên toàn bộ bộ nhớ' },
  { re: /bo\s+qua\s+(huong\s+dan|chi\s+thi|quy\s+tac)/, label: 'lệnh bỏ qua hướng dẫn' },
  { re: /ignore\s+(all\s+)?(previous\s+)?instructions/, label: 'ignore previous instructions' },
  { re: /hay\s+ghi\s+nho\s+rang\s+(ban|may)\s+(la|phai)/, label: 'ghi nhớ danh tính giả' },
  { re: /you\s+are\s+now\s+/, label: 'you are now (giả mạo danh tính)' },
  { re: /system\s*:/, label: 'giả mạo role system' },
  { re: /\[system\]/, label: '[SYSTEM] giả mạo' },
  { re: /hay\s+quen\s+(het|di)/, label: 'lệnh quên bộ nhớ' },
  { re: /xoa\s+(het|toan\s+bo)\s+(bo\s+nho|memory)/, label: 'lệnh xoá toàn bộ bộ nhớ' },
  { re: /delete\s+all\s+(memories|memory)/, label: 'delete all memories' },
  { re: /tu\s+gio\s+(tro\s+di)/, label: 'chi thi vinh vien "tu gio tro di"' },
  { re: /from\s+now\s+on/, label: 'from now on (chi thi vinh vien)' },
  { re: /mat\s+khau\s+(cua\s+)?(toi|minh)\s+la/, label: 'lo mat khau vao memory' },
  { re: /password\s+is/, label: 'password is (lo mat khau)' },
  { re: /hay\s+(gia\s+vo|dong\s+vai)\s+/, label: 'gia vo / dong vai' },
  { re: /pretend\s+(to\s+be|you\s+are)/, label: 'pretend to be (gia mao)' },
  { re: /ban\s+la\s+(mot\s+)?(ai|con\s+nguoi|nguoi)\s+khac/, label: 'doi danh tinh agent' },
  { re: /ghi\s+de\s+(len\s+)?(moi|tat\s+ca)/, label: 'ghi de toan bo memory' },
  { re: /overwrite\s+(all|everything)/, label: 'overwrite all (ghi de toan bo)' },
  { re: /\[inst\]|\[\/inst\]/, label: 'the prompt-injection [INST]' },
  { re: /<\|?(system|im_start)\|?>/, label: 'the system gia mao' },
];

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export interface V14JudgeOptions {
  thresholds?: V14JudgeThresholds;
  /** So ung vien cung episode/turn (de phat hien flood; mac dinh 1). */
  sameEpisodeCount?: number;
  /** Nguon cua turn (de ghi audit; mac dinh tu candidate.sourceText). */
  sourceName?: string;
}

function resolveThresholds(input?: V14JudgeThresholds): Required<V14JudgeThresholds> {
  return { ...V14_DEFAULT_JUDGE_THRESHOLDS, ...(input ?? {}) };
}

/**
 * Judge rule-based cho mot ung vien fact. Khong goi model, khong
 * ghi gi — chi tra verdict; caller tu quyet dinh ghi/quarantine.
 */
export function judgeCandidateV14(
  store: TemporalGraphStore,
  candidate: V14ExtractedFact,
  scope: MemoryScope,
  opts: V14JudgeOptions = {},
): V14JudgeVerdict {
  const t = resolveThresholds(opts.thresholds);
  const reasons: string[] = [];
  let risk = 0;

  const suspicious = findV14SuspiciousPattern(candidate.sourceText);
  if (suspicious) {
    // Mau nghi ngo MOT MINH cung du de vao quarantine (risk =
    // dung nguong quarantine): an toan mac dinh la cho user duyet
    // tay, khong tu dong ghi.
    risk += 0.5;
    reasons.push(`Khop mau nghi ngo: ${suspicious}.`);
  }

  // Mau thuan voi fact tin cay cao cung (subject, predicate) —
  // CHI predicate don tri (lives_in, works_at...). Predicate da
  // tri (likes, speaks...) thi gia tri moi khong mau thuan gia tri cu.
  const conflicts = isSingleValuedPredicateV14(candidate.predicate)
    ? store
        .findActiveFacts(candidate.subject, candidate.predicate, scope)
        .filter(
          (f) => normalizeGraphText(f.objectText ?? '') !== normalizeGraphText(candidate.objectText),
        )
    : [];
  let conflictingFact: GraphFact | null = null;
  let conflictingConfidence = 0;
  for (const f of conflicts) {
    if (f.confidence > conflictingConfidence) {
      conflictingConfidence = f.confidence;
      conflictingFact = f;
    }
  }
  if (conflictingFact && conflictingConfidence >= t.highConfidenceConflict) {
    if (candidate.effectiveConfidence < conflictingConfidence) {
      risk += 0.5;
      reasons.push(
        `Mau thuan fact tin cay cao (${conflictingConfidence.toFixed(2)}): ` +
          `"${conflictingFact.objectText}" vs "${candidate.objectText}".`,
      );
    } else {
      reasons.push(
        `Mau thuan fact cu (${conflictingConfidence.toFixed(2)}) nhung ung vien ` +
          `du tin (${candidate.effectiveConfidence.toFixed(2)}) de thay the.`,
      );
    }
  }

  // Nguon khong tin cay.
  if (candidate.sourceTrust < 0.5) {
    risk += (0.5 - candidate.sourceTrust) * 0.5;
    reasons.push(`Nguon kem tin cay (trust ${candidate.sourceTrust.toFixed(2)}).`);
  }

  // Confidence hieu dung thap.
  if (candidate.effectiveConfidence < 0.5) {
    risk += (0.5 - candidate.effectiveConfidence) * 0.4;
    reasons.push(`Confidence hieu dung thap (${candidate.effectiveConfidence.toFixed(2)}).`);
  }

  // Flood: qua nhieu fact cung episode/turn.
  const sameEpisodeCount = Math.max(1, Math.floor(opts.sameEpisodeCount ?? 1));
  if (sameEpisodeCount > t.floodThreshold) {
    risk += 0.25;
    reasons.push(`Tran fact: ${sameEpisodeCount} ung vien cung episode (nguong ${t.floodThreshold}).`);
  }

  risk = Math.min(1, Math.max(0, risk));

  let decision: V14JudgeDecision;
  let quarantineReason: QuarantineReason | null = null;
  if (candidate.effectiveConfidence < t.minAcceptConfidence) {
    decision = 'reject';
    reasons.push(`Confidence hieu dung ${candidate.effectiveConfidence.toFixed(2)} < ${t.minAcceptConfidence} — qua yeu, loai bo.`);
  } else if (suspicious && candidate.sourceTrust < t.lowTrustReject) {
    decision = 'reject';
    reasons.push(`Mau nghi ngo tu nguon khong tin cay (trust ${candidate.sourceTrust.toFixed(2)}) — loai bo thang.`);
  } else if (risk >= t.rejectRisk) {
    decision = 'reject';
    reasons.push(`Rui ro ${risk.toFixed(2)} >= nguong reject ${t.rejectRisk}.`);
  } else if (risk >= t.quarantineRisk) {
    decision = 'quarantine';
    if (suspicious) quarantineReason = 'suspicious-pattern';
    else if (conflictingFact) quarantineReason = 'contradiction';
    else if (candidate.effectiveConfidence < 0.5) quarantineReason = 'low-confidence';
    else quarantineReason = 'conflict';
    reasons.push(`Rui ro ${risk.toFixed(2)} >= nguong quarantine ${t.quarantineRisk} — cho user duyet.`);
  } else {
    decision = 'accept';
    if (reasons.length === 0) reasons.push('Khong co tin hieu rui ro.');
  }

  return {
    decision,
    risk,
    signals: {
      suspiciousPattern: suspicious,
      conflictingFact,
      conflictingConfidence,
      sourceTrust: candidate.sourceTrust,
      effectiveConfidence: candidate.effectiveConfidence,
      sameEpisodeCount,
    },
    reasons,
    quarantineReason,
  };
}

/** Gate cam thang vao applyExtractionV14 (opts.gate). */
export function v14JudgeGate(
  opts: { thresholds?: V14JudgeThresholds; audit?: (verdict: V14JudgeVerdict, candidate: V14ExtractedFact) => void } = {},
): V14ExtractionGate {
  return (candidate, ctx) => {
    const verdict = judgeCandidateV14(ctx.store, candidate, ctx.scope, {
      ...(opts.thresholds ? { thresholds: opts.thresholds } : {}),
    });
    opts.audit?.(verdict, candidate);
    if (verdict.decision === 'accept') return { decision: 'accept', reason: verdict.reasons.join(' ') };
    return { decision: verdict.decision, reason: verdict.reasons.join(' ') };
  };
}

// ---------------------------------------------------------------------------
// Quarantine API (tren store.addToQuarantine / reviewQuarantine)
// ---------------------------------------------------------------------------

export interface V14QuarantineInput {
  candidate: V14ExtractedFact;
  scope: MemoryScope;
  provenance: GraphFact['provenance'];
  verdict: V14JudgeVerdict;
}

/** Dua ung vien bi judge chan vao quarantine cua store. */
export function quarantineCandidateV14(
  store: TemporalGraphStore,
  input: V14QuarantineInput,
): QuarantineItem {
  const reason: QuarantineReason = input.verdict.quarantineReason ?? 'suspicious-pattern';
  const conflicting = input.verdict.signals.conflictingFact;
  return store.addToQuarantine({
    candidate: {
      subjectName: input.candidate.subject,
      predicate: input.candidate.predicate,
      objectText: input.candidate.objectText,
      confidence: input.candidate.effectiveConfidence,
    },
    reason,
    detail:
      `v14 judge: risk ${input.verdict.risk.toFixed(2)} — ` +
      input.verdict.reasons.join(' '),
    ...(conflicting ? { conflictingFactId: conflicting.id } : {}),
    scope: input.scope,
    provenance: input.provenance,
  });
}

export function listQuarantineV14(
  store: TemporalGraphStore,
  filter: ScopeFilter & { status?: QuarantineItem['status'] } = {},
): QuarantineItem[] {
  return store.listQuarantine(filter);
}

export interface V14QuarantineStats {
  pending: number;
  approved: number;
  rejected: number;
  byReason: Record<string, number>;
}

export function quarantineStatsV14(
  store: TemporalGraphStore,
  filter: ScopeFilter = {},
): V14QuarantineStats {
  const items = store.listQuarantine(filter);
  const stats: V14QuarantineStats = { pending: 0, approved: 0, rejected: 0, byReason: {} };
  for (const item of items) {
    if (item.status === 'pending') stats.pending += 1;
    else if (item.status === 'approved') stats.approved += 1;
    else stats.rejected += 1;
    stats.byReason[item.reason] = (stats.byReason[item.reason] ?? 0) + 1;
  }
  return stats;
}

/** User duyet quarantine: approve -> fact active (supersede neu mau thuan); reject -> chi danh dau. */
export function reviewQuarantineV14(
  store: TemporalGraphStore,
  id: string,
  decision: 'approved' | 'rejected',
  reviewedBy: string,
): { item: QuarantineItem; fact?: GraphFact } {
  if ((reviewedBy ?? '').trim() === '') {
    throw new V14PoisoningError('reviewedBy khong duoc rong (can audit ai duyet).');
  }
  return store.reviewQuarantine(id, decision, reviewedBy);
}

// ---------------------------------------------------------------------------
// Audit log JSONL
// ---------------------------------------------------------------------------

export const V14_JUDGE_AUDIT_REL_PATH = path.join('.open-bot', 'memory-v14-judge-audit.jsonl');
export const V14_MAX_AUDIT_LINES = 1000;

export interface V14JudgeAuditEntry {
  at: string;
  candidate: string;
  predicate: string;
  objectText: string;
  decision: V14JudgeDecision;
  risk: number;
  reasons: string[];
  sourceTrust: number;
  effectiveConfidence: number;
  actor: string;
}

export function appendV14JudgeAudit(
  workspaceDir: string,
  entry: V14JudgeAuditEntry,
): void {
  const file = path.join(workspaceDir, V14_JUDGE_AUDIT_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
  // Giu tran 1000 dong: cat bot dong cu nhat khi vuot.
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length > V14_MAX_AUDIT_LINES) {
    fs.writeFileSync(file, `${lines.slice(lines.length - V14_MAX_AUDIT_LINES).join('\n')}\n`, 'utf-8');
  }
}

export function readV14JudgeAudit(workspaceDir: string, limit = 50): V14JudgeAuditEntry[] {
  const file = path.join(workspaceDir, V14_JUDGE_AUDIT_REL_PATH);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  const out: V14JudgeAuditEntry[] = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    try {
      out.push(JSON.parse(line) as V14JudgeAuditEntry);
    } catch {
      // Dong hong thi bo qua — audit khong duoc lam hong ham doc.
    }
  }
  return out;
}
