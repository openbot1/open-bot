/**
 * Verified summaries — every summary claim cites its sources, and
 * every claim can be checked back against them
 * (context engineering v2, v1.05 Team T4).
 *
 * A summary is a list of claims. Each claim carries the ids of the
 * source turns/messages it came from. `verifySummary` re-reads
 * those sources and grades each claim:
 *
 *   verified      — every salient token of the claim (content words,
 *                   numbers, names) appears in a cited source.
 *   unverifiable  — a cited source is missing, or some ordinary
 *                   words of the claim are absent from the sources
 *                   (the claim may be a paraphrase, not a fact).
 *   contradicted  — a salient number or capitalised name in the
 *                   claim appears nowhere in the cited sources: the
 *                   claim states something the sources do not say.
 *                   This is the hallucination tripwire — a summary
 *                   that invents a number, a name or a file is caught
 *                   here, never silently trusted.
 *
 * Verification is deterministic string matching, never model-based:
 * the same summary + sources always grade the same way. A claim
 * that paraphrases heavily will grade `unverifiable` rather than
 * `verified` — that is the honest answer for a paraphrase.
 */

import { randomUUID } from 'node:crypto';

/** How one claim graded against its cited sources. */
export type ClaimStatus = 'verified' | 'unverifiable' | 'contradicted';

/** One claim inside a summary. */
export interface SummaryClaim {
  id: string;
  /** The claim text (one sentence / one fact). */
  text: string;
  /** Ids of the source turns/messages this claim came from. */
  sourceIds: string[];
}

/** One claim after verification. */
export interface VerifiedClaim extends SummaryClaim {
  status: ClaimStatus;
  /** Human-readable reason (which tokens were missing, if any). */
  detail: string;
}

/** A summary with verifiable claims. */
export interface VerifiedSummary {
  id: string;
  /** Tier the summary belongs to (1 = turn, 2 = topic, 3 = session). */
  tier: 1 | 2 | 3;
  /** Topic label (tier 2) or '' otherwise. */
  topic: string;
  claims: VerifiedClaim[];
  createdAt: string;
  /** Share of claims graded `verified` (0..1). */
  verifiedRatio: number;
  /** True when every claim verified. */
  fullyVerified: boolean;
}

/** A source a claim can cite. */
export interface VerificationSource {
  id: string;
  content: string;
}

/** Stop words ignored when extracting a claim's salient tokens. */
const CLAIM_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'has', 'have', 'had', 'will', 'would', 'should', 'can', 'could', 'it', 'its',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'what', 'how', 'why', 'when',
  'là', 'của', 'và', 'có', 'không', 'cho', 'với', 'trong', 'này', 'đó', 'làm', 'để', 'tôi', 'bạn',
  'đã', 'sẽ', 'các', 'một', 'những', 'như', 'khi', 'thì',
]);

/**
 * Salient tokens of a claim: content words (length > 2, not a stop
 * word) plus every number. A token is "hard" (a number or a
 * capitalised word in the original text) when its absence means the
 * claim states a fact the sources never stated.
 */
export interface SalientToken {
  token: string;
  hard: boolean;
}

export function salientTokensOf(claimText: string): SalientToken[] {
  const tokens: SalientToken[] = [];
  const seen = new Set<string>();
  for (const raw of claimText.split(/\s+/)) {
    const cleaned = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (cleaned === '') continue;
    const lower = cleaned.toLowerCase();
    const isNumber = /^\d[\d,]*(\.\d+)?$/.test(cleaned);
    const isCapitalised = /^[A-ZÀ-Ỹ][\p{L}\p{N}]/u.test(cleaned) && lower !== cleaned;
    if (!isNumber && (lower.length <= 2 || CLAIM_STOP_WORDS.has(lower))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    tokens.push({ token: lower, hard: isNumber || isCapitalised });
  }
  return tokens;
}

/** Normalised haystack of the cited sources (lower-cased text). */
function citedText(sources: Map<string, VerificationSource>, sourceIds: string[]): string {
  const parts: string[] = [];
  for (const id of sourceIds) {
    const source = sources.get(id);
    if (source) parts.push(source.content);
  }
  return parts.join('\n').toLowerCase();
}

/**
 * Grade one claim against its cited sources.
 * - No cited source exists at all -> `unverifiable` ("no source").
 * - Every salient token present in the cited text -> `verified`.
 * - A missing hard token (number / name) -> `contradicted`.
 * - Only soft tokens missing -> `unverifiable` (paraphrase).
 */
export function verifyClaim(
  claim: SummaryClaim,
  sources: Map<string, VerificationSource> | VerificationSource[],
): VerifiedClaim {
  const sourceMap =
    sources instanceof Map
      ? sources
      : new Map(sources.map((source) => [source.id, source]));
  const missingSources = claim.sourceIds.filter((id) => !sourceMap.has(id));
  if (claim.sourceIds.length === 0 || missingSources.length === claim.sourceIds.length) {
    return {
      ...claim,
      status: 'unverifiable',
      detail:
        claim.sourceIds.length === 0
          ? 'claim cites no source'
          : `cited source(s) not found: ${missingSources.join(', ')}`,
    };
  }
  const haystack = citedText(sourceMap, claim.sourceIds);
  const tokens = salientTokensOf(claim.text);
  if (tokens.length === 0) {
    return { ...claim, status: 'unverifiable', detail: 'claim has no checkable content words' };
  }
  const missing = tokens.filter((t) => !haystack.includes(t.token));
  if (missing.length === 0) {
    return { ...claim, status: 'verified', detail: 'all salient tokens found in cited sources' };
  }
  const missingHard = missing.filter((t) => t.hard);
  if (missingHard.length > 0) {
    return {
      ...claim,
      status: 'contradicted',
      detail: `states ${missingHard.map((t) => t.token).join(', ')} which no cited source contains`,
    };
  }
  return {
    ...claim,
    status: 'unverifiable',
    detail: `paraphrase? missing words: ${missing.map((t) => t.token).join(', ')}`,
  };
}

/**
 * Build a verified summary from claims + sources: every claim is
 * graded at build time, so a summary is never stored unverified.
 */
export function buildVerifiedSummary(
  claims: SummaryClaim[],
  sources: Map<string, VerificationSource> | VerificationSource[],
  options: { tier?: 1 | 2 | 3; topic?: string } = {},
): VerifiedSummary {
  const verified = claims.map((claim) => verifyClaim(claim, sources));
  const verifiedCount = verified.filter((c) => c.status === 'verified').length;
  return {
    id: `vsum-${randomUUID()}`,
    tier: options.tier ?? 1,
    topic: options.topic ?? '',
    claims: verified,
    createdAt: new Date().toISOString(),
    verifiedRatio: verified.length === 0 ? 1 : verifiedCount / verified.length,
    fullyVerified: verified.length > 0 && verified.every((c) => c.status === 'verified'),
  };
}

/**
 * Re-verify an existing summary against (possibly newer) sources.
 * Claims are re-graded; the summary id and tier are kept.
 */
export function verifySummary(
  summary: VerifiedSummary,
  sources: Map<string, VerificationSource> | VerificationSource[],
): VerifiedSummary {
  const verified = summary.claims.map((claim) => verifyClaim(claim, sources));
  const verifiedCount = verified.filter((c) => c.status === 'verified').length;
  return {
    ...summary,
    claims: verified,
    verifiedRatio: verified.length === 0 ? 1 : verifiedCount / verified.length,
    fullyVerified: verified.length > 0 && verified.every((c) => c.status === 'verified'),
  };
}

/** Split summary text into one claim per sentence (for tool input). */
export function claimsFromText(
  text: string,
  sourceIds: string[],
): SummaryClaim[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
    .map((sentence) => ({ id: `claim-${randomUUID()}`, text: sentence, sourceIds: [...sourceIds] }));
}

/** Render a verified summary as markdown (claims + status marks). */
export function verifiedSummaryMarkdown(summary: VerifiedSummary): string {
  const lines = [
    `## Summary ${summary.id} (tier ${summary.tier}${summary.topic ? `, topic: ${summary.topic}` : ''})`,
    `Verified: ${summary.claims.filter((c) => c.status === 'verified').length}/${summary.claims.length} claims (${Math.round(summary.verifiedRatio * 100)}%)`,
    '',
  ];
  for (const claim of summary.claims) {
    const mark = claim.status === 'verified' ? '✓' : claim.status === 'contradicted' ? '✗' : '?';
    lines.push(`- [${mark} ${claim.status}] ${claim.text} _(src: ${claim.sourceIds.join(', ')})_`);
    if (claim.status !== 'verified') lines.push(`  - ${claim.detail}`);
  }
  return lines.join('\n');
}

/** One summary after an audit pass (grades may have changed). */
export interface AuditedSummary {
  summary: VerifiedSummary;
  /** True when any claim grade changed vs the stored summary. */
  changed: boolean;
  /** Claims that changed grade (claim id + old -> new). */
  changedClaims: Array<{ claimId: string; from: ClaimStatus; to: ClaimStatus }>;
}

/**
 * Audit stored verified summaries against (possibly newer) sources:
 * re-grade every claim and report which summaries changed. A claim
 * that was `verified` can become `contradicted` when its source was
 * corrected — the audit catches drift instead of trusting a stale
 * grade. Pure function: nothing is written.
 */
export function auditVerifiedSummaries(
  summaries: VerifiedSummary[],
  sources: Map<string, VerificationSource> | VerificationSource[],
): AuditedSummary[] {
  return summaries.map((summary) => {
    const regraded = verifySummary(summary, sources);
    const changedClaims: AuditedSummary['changedClaims'] = [];
    for (let i = 0; i < summary.claims.length; i++) {
      const before = summary.claims[i];
      const after = regraded.claims[i];
      if (before && after && before.status !== after.status) {
        changedClaims.push({ claimId: before.id, from: before.status, to: after.status });
      }
    }
    return { summary: regraded, changed: changedClaims.length > 0, changedClaims };
  });
}
