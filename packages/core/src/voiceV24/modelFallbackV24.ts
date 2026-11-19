/**
 * Model fallback chains for voice v24 (v1.37, Team T5).
 *
 * A voice session should survive its model going away
 * mid-conversation: the provider goes offline, the key
 * expires, the model is deprecated. The fallback chain is
 * the session's ordered "if not this, then that" list —
 * the host builds it from the dynamic catalogue (usable
 * providers first), and the chain answers two questions:
 *
 *   - pickFallback(): given the current model and the
 *     catalogue's live statuses, which model should the
 *     session use instead? The first usable model after
 *     the current one in chain order; null when the chain
 *     is exhausted (the session must tell the user, not
 *     silently pick a model the user never approved);
 *   - whyNot(): for a candidate model, the plain-language
 *     reason it cannot be used right now (unconfigured /
 *     offline / unknown / deprecated / not in the
 *     catalogue), so the UI can show the chain with its
 *     blocked links instead of a bare "no fallback".
 *
 * A fallback *application* is a normal model switch: the
 * caller performs it through VoiceModelSwitcherV24 (or the
 * session), which checksums the transcript. This module
 * only decides *which* model to fall back to, and records
 * the decision. The chain never auto-switches by itself.
 */
import type { DynamicProviderCatalogV24 } from './providerCatalogV24';
import type { VoiceV24ModelRef } from './types';

export interface ModelFallbackV24Options {
  /** Max fallback decisions kept in history (default 100). */
  maxHistory: number;
  /**
   * When true (default), a `degraded` provider may serve as
   * a fallback; when false only `online` providers qualify.
   */
  allowDegradedFallback: boolean;
}

export function defaultModelFallbackV24Options(): ModelFallbackV24Options {
  return { maxHistory: 100, allowDegradedFallback: true };
}

export function validateModelFallbackV24Options(o: Partial<ModelFallbackV24Options>): string[] {
  const errors: string[] = [];
  if (o.maxHistory !== undefined && (!Number.isInteger(o.maxHistory) || o.maxHistory < 1 || o.maxHistory > 1000)) {
    errors.push('maxHistory must be an integer 1..1000');
  }
  if (o.allowDegradedFallback !== undefined && typeof o.allowDegradedFallback !== 'boolean') {
    errors.push('allowDegradedFallback must be a boolean');
  }
  return errors;
}

/** One recorded fallback decision. */
export interface VoiceV24FallbackDecision {
  id: string;
  sessionId: string;
  from: VoiceV24ModelRef;
  to: VoiceV24ModelRef | null;
  atMs: number;
  /** Why the current model had to be abandoned. */
  reason: string;
  /** Candidates that were skipped, with why each was unusable. */
  skipped: { ref: VoiceV24ModelRef; reason: string }[];
}

/** One chain link with its live usability, for the UI. */
export interface VoiceV24FallbackLink {
  ref: VoiceV24ModelRef;
  usable: boolean;
  reason: string | null;
}

export function createModelFallbackChainV24(
  chain: readonly VoiceV24ModelRef[],
  opts: Partial<ModelFallbackV24Options> = {},
): ModelFallbackChainV24 {
  return new ModelFallbackChainV24(chain, opts);
}

export class ModelFallbackChainV24 {
  private readonly opts: ModelFallbackV24Options;
  private readonly chain: VoiceV24ModelRef[];
  private readonly history: VoiceV24FallbackDecision[] = [];
  private seq = 0;

  constructor(chain: readonly VoiceV24ModelRef[], opts: Partial<ModelFallbackV24Options> = {}) {
    const errors = validateModelFallbackV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid ModelFallbackChainV24 options: ${errors.join('; ')}`);
    }
    if (chain.length === 0) throw new Error('Fallback chain must list at least one model');
    const seen = new Set<string>();
    for (const ref of chain) {
      if (typeof ref.providerId !== 'string' || ref.providerId.length === 0) {
        throw new Error('Every chain link needs a non-empty providerId');
      }
      if (typeof ref.model !== 'string' || ref.model.length === 0) {
        throw new Error('Every chain link needs a non-empty model');
      }
      const key = `${ref.providerId}/${ref.model}`;
      if (seen.has(key)) throw new Error(`Duplicate chain link "${key}"`);
      seen.add(key);
    }
    this.opts = { ...defaultModelFallbackV24Options(), ...opts };
    this.chain = chain.map((r) => ({ ...r }));
  }

  options(): ModelFallbackV24Options {
    return { ...this.opts };
  }

  /** The chain in order; copies so callers cannot mutate it. */
  links(): VoiceV24ModelRef[] {
    return this.chain.map((r) => ({ ...r }));
  }

  length(): number {
    return this.chain.length;
  }

  /** Index of a model in the chain (-1 when not in the chain). */
  indexOf(ref: VoiceV24ModelRef): number {
    return this.chain.findIndex((r) => r.providerId === ref.providerId && r.model === ref.model);
  }

  /** Plain-language reason a model cannot be used right now (null when usable). */
  whyNot(catalog: DynamicProviderCatalogV24, ref: VoiceV24ModelRef, atMs: number): string | null {
    if (!catalog.has(ref.providerId)) {
      return `Provider "${ref.providerId}" is not in the dynamic catalogue`;
    }
    const model = catalog.findModel(ref);
    if (model === null) return `Model "${ref.model}" is not offered by provider "${ref.providerId}"`;
    if (model.deprecated) return `Model "${ref.model}" is deprecated by provider "${ref.providerId}"`;
    const status = catalog.statusOf(ref.providerId, atMs);
    if (status === 'unconfigured') return `Provider "${ref.providerId}" is unconfigured (no login / key)`;
    if (status === 'offline') return `Provider "${ref.providerId}" is offline (last probe failed)`;
    if (status === 'unknown') return `Provider "${ref.providerId}" has no fresh probe — status unknown`;
    if (status === 'degraded' && !this.opts.allowDegradedFallback) {
      return `Provider "${ref.providerId}" is degraded and degraded fallbacks are disabled`;
    }
    return null;
  }

  /** True when the model is usable as a fallback right now. */
  isUsable(catalog: DynamicProviderCatalogV24, ref: VoiceV24ModelRef, atMs: number): boolean {
    return this.whyNot(catalog, ref, atMs) === null;
  }

  /** Every chain link with its live usability, in chain order. */
  linksWithUsability(catalog: DynamicProviderCatalogV24, atMs: number): VoiceV24FallbackLink[] {
    return this.chain.map((ref) => {
      const reason = this.whyNot(catalog, ref, atMs);
      return { ref: { ...ref }, usable: reason === null, reason };
    });
  }

  /** Usable links only, in chain order. */
  usableLinks(catalog: DynamicProviderCatalogV24, atMs: number): VoiceV24ModelRef[] {
    return this.linksWithUsability(catalog, atMs)
      .filter((l) => l.usable)
      .map((l) => ({ ...l.ref }));
  }

  /**
   * Pick the fallback for `current`: the first usable link
   * *after* the current model in chain order (wrapping to
   * the start of the chain when the current model is the
   * last link). The current model itself is never picked.
   * Returns null + the skipped reasons when nothing is usable.
   */
  pickFallback(
    catalog: DynamicProviderCatalogV24,
    current: VoiceV24ModelRef,
    atMs: number,
  ): { to: VoiceV24ModelRef | null; skipped: { ref: VoiceV24ModelRef; reason: string }[] } {
    const start = this.indexOf(current);
    const ordered: VoiceV24ModelRef[] = [];
    if (start === -1) {
      ordered.push(...this.chain);
    } else {
      ordered.push(...this.chain.slice(start + 1), ...this.chain.slice(0, start));
    }
    const skipped: { ref: VoiceV24ModelRef; reason: string }[] = [];
    for (const ref of ordered) {
      const reason = this.whyNot(catalog, ref, atMs);
      if (reason === null) return { to: { ...ref }, skipped };
      skipped.push({ ref: { ...ref }, reason });
    }
    return { to: null, skipped };
  }

  /**
   * Record a fallback decision (the caller performs the
   * actual switch through the switcher). Returns the
   * recorded decision.
   */
  recordDecision(
    sessionId: string,
    from: VoiceV24ModelRef,
    to: VoiceV24ModelRef | null,
    reason: string,
    skipped: { ref: VoiceV24ModelRef; reason: string }[],
    atMs: number,
  ): VoiceV24FallbackDecision {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId must be a non-empty string');
    }
    this.seq += 1;
    const decision: VoiceV24FallbackDecision = {
      id: `fallback-${this.seq}`,
      sessionId,
      from: { ...from },
      to: to === null ? null : { ...to },
      atMs,
      reason,
      skipped: skipped.map((s) => ({ ref: { ...s.ref }, reason: s.reason })),
    };
    this.history.push(decision);
    while (this.history.length > this.opts.maxHistory) this.history.shift();
    return {
      ...decision,
      from: { ...decision.from },
      to: decision.to === null ? null : { ...decision.to },
      skipped: decision.skipped.map((s) => ({ ref: { ...s.ref }, reason: s.reason })),
    };
  }

  /** Fallback decisions, oldest first. */
  historyList(sessionId?: string): VoiceV24FallbackDecision[] {
    return this.history
      .filter((d) => sessionId === undefined || d.sessionId === sessionId)
      .map((d) => ({
        ...d,
        from: { ...d.from },
        to: d.to === null ? null : { ...d.to },
        skipped: d.skipped.map((s) => ({ ref: { ...s.ref }, reason: s.reason })),
      }));
  }

  decisionCount(sessionId?: string): number {
    return this.historyList(sessionId).length;
  }

  /** Decisions where no fallback existed (chain exhausted). */
  exhaustedDecisions(sessionId?: string): VoiceV24FallbackDecision[] {
    return this.historyList(sessionId).filter((d) => d.to === null);
  }

  summary(catalog: DynamicProviderCatalogV24, atMs: number): string {
    const usable = this.usableLinks(catalog, atMs).length;
    return (
      `Fallback chain: ${this.chain.length} links, ${usable} usable now, ` +
      `${this.history.length} decisions recorded, ${this.exhaustedDecisions().length} exhausted.`
    );
  }
}
