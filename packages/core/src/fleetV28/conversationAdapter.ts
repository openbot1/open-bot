/**
 * Conversation <-> runtime adapter (v1.41, Team T6) — fleet v28.
 *
 * The conversation API stays unchanged: callers keep addressing a
 * conversation by id. This module is the glue that attaches the
 * fleet v28 machinery to those conversation events WITHOUT changing
 * the API — the host forwards the events it already has, and the
 * adapter drives the runtime store, the budget store, and the
 * secret redactor:
 *
 * - `attachConversation`: first message of a conversation — starts
 *   its runtime with the owning profile's preset bundle (limits +
 *   cap), creating the budget meter with the preset cap. Attaching
 *   an already-attached conversation is a no-op (returns the
 *   existing attachment); attaching with an unknown profile falls
 *   back to the medium preset.
 * - `onMessage`: a message arrived — touches the runtime (resets
 *   the idle clock) and records a health probe when the host
 *   reports the runtime healthy.
 * - `onToolCall`: a tool call finished — touches the runtime,
 *   records token usage on the budget meter (refused past the hard
 *   cap: the adapter reports `blocked: true` so the host can stop
 *   the turn instead of spending more), and returns the tool result
 *   with the profile's secrets redacted (so a secret echoed in a
 *   tool result never reaches the log / transcript unredacted).
 * - `onIdle`: the conversation went idle — runs the idle sweep
 *   (evicts when past the idle timeout, with state saved).
 * - `onEnd`: the conversation ended — stops the runtime (state
 *   saved) and detaches; the budget meter stays for reports.
 *
 * The adapter never spawns a process, never enforces cgroup limits
 * itself, and never holds a secret value longer than one call: the
 * host implements `FleetV28ConversationHost` (start/stop/restore
 * hooks) and the adapter only calls it. A null host means "decide
 * only": the stores still update, the host hooks are skipped.
 */

import type { FleetV28BudgetStore } from './budget';
import { resolveFleetV28Preset, type FleetV28PresetStore } from './presets';
import type { ConversationRuntime, FleetV28RuntimeStore } from './runtime';
import type { FleetV28SecretStore } from './secrets';

/** Host hooks the adapter calls (all optional; null host = decide-only). */
export interface FleetV28ConversationHost {
  /** Enforce limits on a live runtime (cgroups/Docker/etc.). */
  enforceLimits?(runtime: ConversationRuntime): void;
  /** Restore a saved state snapshot into a revived runtime. */
  restoreSnapshot?(conversationId: string, savedState: string): void;
  /** Destroy a runtime's OS resources after stop/evict/fail. */
  destroyRuntime?(conversationId: string): void;
}

/** What the adapter holds for one attached conversation. */
export interface FleetV28ConversationAttachment {
  /** Conversation id. */
  conversationId: string;
  /** Owning profile. */
  profileId: string;
  /** Preset the attachment resolved to. */
  presetName: string;
  /** Budget cap applied to the meter (null = no cap). */
  capUsd: number | null;
  /** When attached, ms epoch. */
  attachedAtMs: number;
  /** How many messages the adapter has seen. */
  messages: number;
  /** How many tool calls the adapter has seen. */
  toolCalls: number;
  /** How many tool results were blocked by the hard cap. */
  blockedToolCalls: number;
}

/** Result of `onToolCall` (usage recorded + result redacted). */
export interface FleetV28ToolCallResult {
  /** Whether the usage record was accepted (false = hard cap). */
  accepted: boolean;
  /** True when the hard cap refused the record. */
  blocked: boolean;
  /** Cost of the record, USD (0 when refused). */
  costUsd: number;
  /** Tool result with the profile's secrets redacted. */
  redactedResult: string;
  /** How many secret values were redacted from the result. */
  redactedCount: number;
  /** Meter level after the call (null when no meter). */
  level: string | null;
}

/**
 * Conversation <-> runtime adapter.
 *
 * Owns the attachment map (conversation -> attachment). All store
 * writes go through the three stores the host provides; the host
 * hooks are best-effort (a throwing hook is caught and reported in
 * the returned `hostErrors` — a host failure must never break the
 * conversation).
 */
export class FleetV28ConversationAdapter {
  private readonly attachments = new Map<string, FleetV28ConversationAttachment>();

  constructor(
    private readonly runtimes: FleetV28RuntimeStore,
    private readonly secrets: FleetV28SecretStore,
    private readonly budget: FleetV28BudgetStore,
    private readonly presets: FleetV28PresetStore,
    private readonly host: FleetV28ConversationHost | null = null,
  ) {}

  /** Get an attachment (undefined when not attached). Returns a copy. */
  getAttachment(conversationId: string): FleetV28ConversationAttachment | undefined {
    const a = this.attachments.get(conversationId);
    return a ? { ...a } : undefined;
  }

  /** List attachments (oldest first). */
  listAttachments(): FleetV28ConversationAttachment[] {
    return [...this.attachments.values()].map((a) => ({ ...a }));
  }

  /** true when the conversation is attached. */
  isAttached(conversationId: string): boolean {
    return this.attachments.has(conversationId);
  }

  /**
   * Attach a conversation: resolve the profile's preset, start the
   * runtime with the preset limits, create the budget meter with
   * the preset cap. Returns the attachment + the runtime (or the
   * refusal reasons when the runtime could not start).
   */
  attachConversation(
    conversationId: string,
    profileId: string,
    opts: { botId?: string; nowMs?: number } = {},
  ): {
    ok: boolean;
    attachment?: FleetV28ConversationAttachment;
    runtime?: ConversationRuntime;
    reasons?: string[];
    hostErrors?: string[];
  } {
    const nowMs = opts.nowMs ?? Date.now();
    const existing = this.attachments.get(conversationId);
    if (existing) {
      return { ok: true, attachment: { ...existing }, runtime: this.runtimes.getRuntime(conversationId) };
    }
    const resolved = this.presets.resolveForProfile(profileId);
    const started = this.runtimes.startRuntime(conversationId, profileId, {
      botId: opts.botId,
      limits: resolved.preset.limits,
      nowMs,
    });
    if (!started.ok || started.status !== 'started') {
      if (started.ok && started.status === 'queued') {
        // Queued: still attach (the runtime starts when a slot frees).
        const attachment = this.recordAttachment(conversationId, profileId, resolved.preset.name, resolved.preset.capUsd, nowMs);
        this.budget.ensureMeter(conversationId, profileId, { capUsd: resolved.preset.capUsd, nowMs });
        return { ok: true, attachment, hostErrors: [] };
      }
      return { ok: false, reasons: started.ok ? ['Runtime start queued unexpectedly.'] : started.reasons };
    }
    const runtime = started.runtime;
    const hostErrors = this.callHost((h) => h.enforceLimits?.(runtime));
    this.budget.ensureMeter(conversationId, profileId, { capUsd: resolved.preset.capUsd, nowMs });
    const attachment = this.recordAttachment(
      conversationId,
      profileId,
      resolved.preset.name,
      resolved.preset.capUsd,
      nowMs,
    );
    return { ok: true, attachment, runtime, hostErrors };
  }

  /**
   * A message arrived: touch the runtime (idle clock) and record a
   * healthy probe when the host says the runtime is healthy.
   * Returns false when the conversation is not attached.
   */
  onMessage(
    conversationId: string,
    opts: { healthy?: boolean; nowMs?: number } = {},
  ): { ok: boolean; hostErrors: string[] } {
    const nowMs = opts.nowMs ?? Date.now();
    const attachment = this.attachments.get(conversationId);
    if (!attachment) return { ok: false, hostErrors: [] };
    attachment.messages += 1;
    this.runtimes.touch(conversationId, nowMs);
    if (opts.healthy !== undefined) {
      const probed = this.runtimes.probe(conversationId, opts.healthy, nowMs);
      if (probed && probed.state === 'failed') {
        return { ok: true, hostErrors: this.callHost((h) => h.destroyRuntime?.(conversationId)) };
      }
    }
    return { ok: true, hostErrors: [] };
  }

  /**
   * A tool call finished: touch the runtime, record token usage,
   * redact the profile's secrets from the result. When the hard
   * cap refuses the record, the call is reported blocked and the
   * host should stop the turn (the adapter never spends past cap).
   */
  onToolCall(
    conversationId: string,
    opts: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      resultText: string;
      nowMs?: number;
    },
  ): FleetV28ToolCallResult & { ok: boolean; hostErrors: string[] } {
    const nowMs = opts.nowMs ?? Date.now();
    const attachment = this.attachments.get(conversationId);
    if (!attachment) {
      return {
        ok: false,
        accepted: false,
        blocked: false,
        costUsd: 0,
        redactedResult: opts.resultText,
        redactedCount: 0,
        level: null,
        hostErrors: [],
      };
    }
    attachment.toolCalls += 1;
    this.runtimes.touch(conversationId, nowMs);
    const record = this.budget.recordUsage(
      conversationId,
      attachment.profileId,
      opts.model,
      opts.inputTokens,
      opts.outputTokens,
      nowMs,
    );
    if (!record.accepted && record.blocked) attachment.blockedToolCalls += 1;
    const redacted = this.secrets.redactText(attachment.profileId, opts.resultText);
    return {
      ok: true,
      accepted: record.accepted,
      blocked: record.blocked,
      costUsd: record.costUsd,
      redactedResult: redacted.text,
      redactedCount: redacted.replaced,
      level: record.meter.level,
      hostErrors: [],
    };
  }

  /**
   * The conversation went idle: run the idle sweep. Returns the
   * evicted conversations (this conversation included when it was
   * evicted) and any host errors from destroying runtimes.
   */
  onIdle(nowMs: number = Date.now()): { evicted: string[]; hostErrors: string[] } {
    const sweep = this.runtimes.sweepIdle(nowMs);
    const hostErrors = this.callHost((h) => {
      for (const id of sweep.evicted) h.destroyRuntime?.(id);
    });
    return { evicted: sweep.evicted, hostErrors };
  }

  /**
   * The conversation ended: stop the runtime (state saved),
   * destroy its OS resources via the host, detach. The budget
   * meter stays for reports.
   */
  onEnd(conversationId: string, nowMs: number = Date.now()): { ok: boolean; hostErrors: string[] } {
    const attachment = this.attachments.get(conversationId);
    if (!attachment) return { ok: false, hostErrors: [] };
    this.runtimes.stopRuntime(conversationId, nowMs);
    this.attachments.delete(conversationId);
    return { ok: true, hostErrors: this.callHost((h) => h.destroyRuntime?.(conversationId)) };
  }

  /** Detach without stopping the runtime (host keeps it running). */
  detach(conversationId: string): boolean {
    return this.attachments.delete(conversationId);
  }

  private recordAttachment(
    conversationId: string,
    profileId: string,
    presetName: string,
    capUsd: number | null,
    nowMs: number,
  ): FleetV28ConversationAttachment {
    const attachment: FleetV28ConversationAttachment = {
      conversationId,
      profileId,
      presetName,
      capUsd,
      attachedAtMs: nowMs,
      messages: 0,
      toolCalls: 0,
      blockedToolCalls: 0,
    };
    this.attachments.set(conversationId, attachment);
    return { ...attachment };
  }

  /** Call a host hook, catching throws into error strings. */
  private callHost(fn: (host: FleetV28ConversationHost) => void): string[] {
    if (!this.host) return [];
    try {
      fn(this.host);
      return [];
    } catch (err) {
      return [err instanceof Error ? err.message : String(err)];
    }
  }
}
