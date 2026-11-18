/**
 * Voice-driven tool-call engine v21 (voice v21, v1.34 Team T5).
 *
 * The loop is: speech → transcript → intent → (confirm?) → a
 * real tool call → the result spoken back. This engine owns the
 * middle of that loop: policy, confirmation and execution.
 *
 * Policy first, execution second. Every tool has an effect class
 * (read / local-write / send / delete) and the policy decides per
 * tool whether a voice request is allowed straight away, needs a
 * spoken confirmation, or is denied outright:
 *
 *   - read tools run immediately (search, time, read notes);
 *   - local-write / send / delete tools wait in
 *     `pending-confirmation` until the user says yes out loud
 *     ("đồng ý", "yes", "làm đi") — or no ("không", "hủy");
 *   - a denied tool never runs and the engine returns a spoken
 *     refusal the session can read back instead of silence.
 *
 * The host binds the real executor — a function that calls the
 * open-bot tool registry by name and returns speakable text.
 * The default executor is a mock that answers the built-in
 * descriptors (time, notes in memory, canned search) so tests and
 * the panel work with no registry and no network. A pending call
 * expires after a configurable timeout so a stale "yes" five
 * minutes later cannot fire a delete the user forgot about.
 *
 * The engine is async only at the executor boundary; everything
 * else (policy, state, stats) is synchronous and deterministic
 * under a virtual clock supplied by the caller.
 */
import {
  round2V21,
  type VoiceV21Event,
  type VoiceV21EventSink,
  type VoiceV21Intent,
  type VoiceV21ToolCallRecord,
  type VoiceV21ToolCallStatus,
  type VoiceV21ToolDescriptor,
  type VoiceV21ToolEffect,
} from './types';
import { defaultVoiceToolDescriptorsV21 } from './intentParserV21';

export type VoiceV21PolicyDecision = 'allow' | 'confirm' | 'deny';

/** A function that really runs a tool and returns speakable text. */
export type VoiceV21ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<string>;

export interface VoiceV21ToolPolicy {
  /** Decision per effect class (defaults below when omitted). */
  defaultForEffect: Partial<Record<VoiceV21ToolEffect, VoiceV21PolicyDecision>>;
  /** Decision per tool name — overrides the effect default. */
  perTool: Record<string, VoiceV21PolicyDecision>;
}

export function defaultVoiceToolPolicyV21(): VoiceV21ToolPolicy {
  return {
    defaultForEffect: {
      read: 'allow',
      'local-write': 'confirm',
      send: 'confirm',
      delete: 'confirm',
    },
    perTool: {},
  };
}

export function validateVoiceToolPolicyV21(policy: VoiceV21ToolPolicy): string[] {
  const e: string[] = [];
  const ok: VoiceV21PolicyDecision[] = ['allow', 'confirm', 'deny'];
  for (const [effect, d] of Object.entries(policy.defaultForEffect)) {
    if (!ok.includes(d)) e.push(`defaultForEffect.${effect} must be allow/confirm/deny`);
  }
  for (const [name, d] of Object.entries(policy.perTool)) {
    if (name.trim() === '') e.push('perTool keys must not be empty');
    if (!ok.includes(d)) e.push(`perTool.${name} must be allow/confirm/deny`);
  }
  return e;
}

/** Resolve the policy decision for one descriptor. */
export function decideVoiceToolPolicyV21(
  descriptor: VoiceV21ToolDescriptor,
  policy: VoiceV21ToolPolicy,
): VoiceV21PolicyDecision {
  const perTool = policy.perTool[descriptor.name];
  if (perTool !== undefined) return perTool;
  const byEffect = policy.defaultForEffect[descriptor.effect];
  if (byEffect !== undefined) return byEffect;
  return descriptor.effect === 'read' ? 'allow' : 'confirm';
}

export interface VoiceV21ToolCallEngineOptions {
  policy: VoiceV21ToolPolicy;
  /** Descriptors the engine may call (default: built-in set). */
  descriptors: VoiceV21ToolDescriptor[];
  /** Executor for real calls (default: mock executor). */
  executor?: VoiceV21ToolExecutor;
  /** Pending-confirmation expiry in ms (default 60_000). */
  confirmTimeoutMs: number;
  /** Max spoken result length in chars (default 500). */
  maxSpokenResultChars: number;
  /** Max records kept (default 200, oldest dropped). */
  maxRecords: number;
}

export function defaultVoiceToolCallEngineOptions(): VoiceV21ToolCallEngineOptions {
  return {
    policy: defaultVoiceToolPolicyV21(),
    descriptors: defaultVoiceToolDescriptorsV21(),
    confirmTimeoutMs: 60_000,
    maxSpokenResultChars: 500,
    maxRecords: 200,
  };
}

export function validateVoiceToolCallEngineOptions(o: Partial<VoiceV21ToolCallEngineOptions>): string[] {
  const e: string[] = [];
  if (o.policy !== undefined) e.push(...validateVoiceToolPolicyV21(o.policy));
  if (o.confirmTimeoutMs !== undefined && (o.confirmTimeoutMs < 1000 || o.confirmTimeoutMs > 600_000)) {
    e.push('confirmTimeoutMs must be 1000..600000');
  }
  if (o.maxSpokenResultChars !== undefined && (o.maxSpokenResultChars < 20 || o.maxSpokenResultChars > 5000)) {
    e.push('maxSpokenResultChars must be 20..5000');
  }
  if (o.maxRecords !== undefined && (!Number.isInteger(o.maxRecords) || o.maxRecords < 1)) {
    e.push('maxRecords must be a positive integer');
  }
  return e;
}

export interface VoiceV21ToolCallStats {
  requested: number;
  succeeded: number;
  failed: number;
  declined: number;
  denied: number;
  pendingConfirmation: number;
  /** Mean execution time of finished calls, ms (0 when none). */
  meanExecMs: number;
}

/** In-memory notes for the mock executor (no disk, no network). */
export function createMockVoiceToolExecutorV21(): { executor: VoiceV21ToolExecutor; notes: string[] } {
  const notes: string[] = [];
  const executor: VoiceV21ToolExecutor = async (toolName, args) => {
    switch (toolName) {
      case 'get_time':
        return `The time is ${new Date().toLocaleTimeString()}.`;
      case 'web_search': {
        const q = String(args.query ?? '');
        return q === '' ? 'Nothing to search for.' : `Search results for "${q}": (mock) 3 results, top hit is a summary page.`;
      }
      case 'take_note': {
        const text = String(args.text ?? '');
        if (text === '') return 'Nothing to note.';
        notes.push(text);
        return `Note saved: ${text}`;
      }
      case 'read_notes':
        return notes.length === 0 ? 'No notes yet.' : `Your notes: ${notes.join('; ')}`;
      case 'delete_note': {
        const title = String(args.title ?? '');
        const idx = notes.findIndex((n) => n.toLowerCase().includes(title.toLowerCase()));
        if (idx === -1 || title === '') return `No note matching "${title}" found.`;
        notes.splice(idx, 1);
        return `Deleted note: ${title}`;
      }
      case 'set_reminder': {
        const text = String(args.text ?? '');
        const minutes = Number(args.minutes ?? 0);
        return `Reminder set: ${text}${minutes > 0 ? ` in ${minutes} minutes` : ''}.`;
      }
      case 'send_message': {
        const recipient = String(args.recipient ?? 'someone');
        const message = String(args.message ?? '');
        return `Message to ${recipient} queued: ${message}`;
      }
      case 'open_app': {
        const app = String(args.app ?? '');
        return app === '' ? 'Which app?' : `Opening ${app} (mock).`;
      }
      default:
        return `Tool ${toolName} is not available in the mock executor.`;
    }
  };
  return { executor, notes };
}

/** Trim a tool result to speakable length, keeping whole words. */
export function speakableResultV21(result: string, maxChars: number): string {
  const t = result.trim().replace(/\s+/g, ' ');
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export class VoiceToolCallEngineV21 {
  private readonly opts: VoiceV21ToolCallEngineOptions;
  private readonly executor: VoiceV21ToolExecutor;
  private readonly sink?: VoiceV21EventSink;
  private readonly sessionId: string;
  private readonly records: VoiceV21ToolCallRecord[] = [];
  private readonly descriptorsByName = new Map<string, VoiceV21ToolDescriptor>();
  private counter = 0;
  private execTotalMs = 0;
  private execCount = 0;

  constructor(sessionId: string, opts: Partial<VoiceV21ToolCallEngineOptions> = {}, sink?: VoiceV21EventSink) {
    this.sessionId = sessionId;
    this.opts = { ...defaultVoiceToolCallEngineOptions(), ...opts };
    if (opts.policy !== undefined) this.opts.policy = opts.policy;
    if (opts.descriptors !== undefined) this.opts.descriptors = opts.descriptors;
    this.executor = opts.executor ?? createMockVoiceToolExecutorV21().executor;
    this.sink = sink;
    for (const d of this.opts.descriptors) this.descriptorsByName.set(d.name, d);
  }

  /** Descriptors this engine can call. */
  descriptors(): VoiceV21ToolDescriptor[] {
    return [...this.opts.descriptors];
  }

  descriptorFor(toolName: string): VoiceV21ToolDescriptor | undefined {
    return this.descriptorsByName.get(toolName);
  }

  /** All records, newest last. */
  history(): VoiceV21ToolCallRecord[] {
    return [...this.records];
  }

  /** The currently pending confirmation, if any (oldest unexpired). */
  pending(atMs: number): VoiceV21ToolCallRecord | undefined {
    this.expirePending(atMs);
    return this.records.find((r) => r.status === 'pending-confirmation');
  }

  private push(record: VoiceV21ToolCallRecord): void {
    this.records.push(record);
    while (this.records.length > this.opts.maxRecords) this.records.shift();
  }

  private emit(kind: VoiceV21Event['kind'], atMs: number, detail?: Record<string, unknown>): void {
    this.sink?.({ kind, atMs, sessionId: this.sessionId, detail });
  }

  /** Expire pending confirmations older than confirmTimeoutMs. */
  expirePending(atMs: number): VoiceV21ToolCallRecord[] {
    const expired: VoiceV21ToolCallRecord[] = [];
    for (const r of this.records) {
      if (r.status === 'pending-confirmation' && atMs - r.requestedAtMs > this.opts.confirmTimeoutMs) {
        r.status = 'declined';
        r.denialReason = 'Confirmation timed out.';
        r.finishedAtMs = atMs;
        expired.push(r);
        this.emit('tool-call-declined', atMs, { callId: r.id, toolName: r.toolName, reason: r.denialReason });
      }
    }
    return expired;
  }

  /**
   * Handle one parsed intent. Returns the record created, or null
   * when the intent names no tool. Read tools run at once; tools
   * that need confirmation park in `pending-confirmation` and the
   * caller should speak the confirmation prompt.
   */
  async request(intent: VoiceV21Intent, turnId: string, atMs: number): Promise<VoiceV21ToolCallRecord | null> {
    if (intent.toolName === '') return null;
    const descriptor = this.descriptorsByName.get(intent.toolName);
    if (descriptor === undefined) {
      const record: VoiceV21ToolCallRecord = {
        id: `vtc-${++this.counter}`,
        sessionId: this.sessionId,
        turnId,
        toolName: intent.toolName,
        args: intent.args,
        effect: 'read',
        status: 'denied',
        requestedAtMs: atMs,
        finishedAtMs: atMs,
        denialReason: `Unknown tool "${intent.toolName}".`,
        confirmationRequired: false,
        resultText: `I don't know the tool ${intent.toolName}.`,
      };
      this.push(record);
      this.emit('tool-call-denied', atMs, { callId: record.id, toolName: record.toolName, reason: record.denialReason });
      return record;
    }
    const decision = decideVoiceToolPolicyV21(descriptor, this.opts.policy);
    const record: VoiceV21ToolCallRecord = {
      id: `vtc-${++this.counter}`,
      sessionId: this.sessionId,
      turnId,
      toolName: descriptor.name,
      args: intent.args,
      effect: descriptor.effect,
      status: decision === 'deny' ? 'denied' : decision === 'confirm' ? 'pending-confirmation' : 'running',
      requestedAtMs: atMs,
      confirmationRequired: decision !== 'allow',
    };
    if (decision === 'deny') {
      record.finishedAtMs = atMs;
      record.denialReason = `Tool "${descriptor.name}" is denied by voice policy.`;
      record.resultText = `I can't ${descriptor.description.toLowerCase()} by voice — it is blocked by policy.`;
      this.push(record);
      this.emit('tool-call-denied', atMs, { callId: record.id, toolName: record.toolName, reason: record.denialReason });
      return record;
    }
    this.push(record);
    this.emit('tool-call-requested', atMs, {
      callId: record.id,
      toolName: record.toolName,
      effect: record.effect,
      needsConfirmation: record.confirmationRequired,
    });
    if (decision === 'allow') {
      await this.run(record, atMs);
    }
    return record;
  }

  private async run(record: VoiceV21ToolCallRecord, atMs: number): Promise<void> {
    record.status = 'running';
    record.startedAtMs = atMs;
    const started = Date.now();
    try {
      const raw = await this.executor(record.toolName, record.args);
      record.resultText = speakableResultV21(raw, this.opts.maxSpokenResultChars);
      record.status = 'succeeded';
    } catch (err) {
      record.resultText = `That failed: ${err instanceof Error ? err.message : String(err)}`;
      record.status = 'failed';
    }
    record.finishedAtMs = atMs;
    const execMs = Math.max(0, Date.now() - started);
    this.execTotalMs += execMs;
    this.execCount += 1;
    this.emit('tool-call-finished', atMs, {
      callId: record.id,
      toolName: record.toolName,
      status: record.status,
      execMs: round2V21(execMs),
    });
  }

  /** Spoken prompt to read when a call is waiting for confirmation. */
  confirmationPrompt(record: VoiceV21ToolCallRecord): string {
    const args = Object.entries(record.args).map(([k, v]) => `${k} ${String(v)}`).join(', ');
    const what = args === '' ? record.toolName : `${record.toolName} (${args})`;
    return `Should I ${what}? Say yes to confirm, or no to cancel.`;
  }

  /** Answer a pending confirmation with a spoken yes. Runs the call. */
  async confirm(callId: string, atMs: number): Promise<VoiceV21ToolCallRecord | null> {
    const record = this.records.find((r) => r.id === callId);
    if (record === undefined || record.status !== 'pending-confirmation') return null;
    record.confirmationGiven = true;
    this.emit('tool-call-confirmed', atMs, { callId: record.id, toolName: record.toolName });
    await this.run(record, atMs);
    return record;
  }

  /** Answer a pending confirmation with a spoken no. */
  decline(callId: string, atMs: number, reason = 'Declined by voice.'): VoiceV21ToolCallRecord | null {
    const record = this.records.find((r) => r.id === callId);
    if (record === undefined || record.status !== 'pending-confirmation') return null;
    record.status = 'declined';
    record.denialReason = reason;
    record.finishedAtMs = atMs;
    this.emit('tool-call-declined', atMs, { callId: record.id, toolName: record.toolName, reason });
    return record;
  }

  /**
   * Route a fresh intent while a confirmation is pending: a
   * confirmation runs the call, a refusal declines it, anything
   * else is returned as 'other' so the session can treat it as a
   * new request (and optionally cancel the pending one first).
   */
  async handleConfirmationIntent(
    intent: VoiceV21Intent,
    atMs: number,
  ): Promise<{ action: 'confirmed' | 'declined' | 'other'; record: VoiceV21ToolCallRecord | null }> {
    const pendingRecord = this.pending(atMs);
    if (pendingRecord === undefined) return { action: 'other', record: null };
    if (intent.isRefusal) {
      return { action: 'declined', record: this.decline(pendingRecord.id, atMs, 'Declined by voice.') };
    }
    if (intent.isConfirmation) {
      return { action: 'confirmed', record: await this.confirm(pendingRecord.id, atMs) };
    }
    return { action: 'other', record: pendingRecord };
  }

  stats(atMs: number): VoiceV21ToolCallStats {
    this.expirePending(atMs);
    const by = (s: VoiceV21ToolCallStatus): number => this.records.filter((r) => r.status === s).length;
    return {
      requested: this.records.length,
      succeeded: by('succeeded'),
      failed: by('failed'),
      declined: by('declined'),
      denied: by('denied'),
      pendingConfirmation: by('pending-confirmation'),
      meanExecMs: this.execCount === 0 ? 0 : round2V21(this.execTotalMs / this.execCount),
    };
  }

  summary(atMs: number): string {
    const s = this.stats(atMs);
    return `voice tool calls: ${s.requested} requested, ${s.succeeded} ok, ${s.failed} failed, ` +
      `${s.declined} declined, ${s.denied} denied, ${s.pendingConfirmation} pending, mean exec ${s.meanExecMs} ms`;
  }
}

export function createVoiceToolCallEngineV21(
  sessionId: string,
  opts: Partial<VoiceV21ToolCallEngineOptions> = {},
  sink?: VoiceV21EventSink,
): VoiceToolCallEngineV21 {
  return new VoiceToolCallEngineV21(sessionId, opts, sink);
}
