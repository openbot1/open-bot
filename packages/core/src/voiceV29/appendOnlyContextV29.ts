/**
 * Append-only conversation context v29 (v1.42, Team T4).
 *
 * The conversation log only ever grows — the rule learned
 * from GPT-Live full-duplex (survey §4: "context
 * append-only"). Nothing here edits or deletes an item in
 * place: there is no `update`, no `delete`, no `splice`
 * exposed at all. When the log gets long, `compact()`
 * appends a summary item and marks the summarised items
 * superseded — the originals stay in the log, with a
 * pointer to the summary that replaced them, so the
 * history keeps its provenance and can still be read as
 * it stood at any earlier time ("time-travel": list the
 * items that were live at time X, ignoring later
 * supersede markers).
 *
 * Token accounting is a rough local estimate (4 chars per
 * token); the numbers are for budgeting and caps, not
 * billing. All clocks virtual (the caller passes `atMs`).
 */

import {
  VOICE_V29_MAX_CONTEXT_ITEMS_DEFAULT,
  VOICE_V29_MAX_CONTEXT_TOKENS_DEFAULT,
  estimateTokensV29,
  type VoiceV29ContextItem,
  type VoiceV29ContextItemKind,
} from './types';

export interface AppendOnlyContextV29Options {
  /** Max items kept (oldest *superseded* items are dropped first when full). */
  maxItems?: number;
  /** Soft token cap: compaction is suggested past this, never forced. */
  maxTokens?: number;
  /** Session id the context belongs to ('' = standalone). */
  sessionId?: string;
}

export interface VoiceV29ContextStats {
  items: number;
  liveItems: number;
  supersededItems: number;
  tokens: number;
  liveTokens: number;
  turns: number;
  userItems: number;
  agentItems: number;
  toolItems: number;
  summaries: number;
  lastSeq: number;
}

export interface VoiceV29CompactionResult {
  atMs: number;
  summarySeq: number;
  summaryText: string;
  supersededCount: number;
  supersededSeqs: number[];
  tokensBefore: number;
  liveTokensAfter: number;
}

export function defaultAppendOnlyContextV29Options(): AppendOnlyContextV29Options {
  return {
    maxItems: VOICE_V29_MAX_CONTEXT_ITEMS_DEFAULT,
    maxTokens: VOICE_V29_MAX_CONTEXT_TOKENS_DEFAULT,
    sessionId: '',
  };
}

export class AppendOnlyContextV29 {
  private readonly maxItems: number;
  private readonly maxTokens: number;
  private readonly sessionId: string;
  private readonly items: VoiceV29ContextItem[] = [];
  private nextSeq = 1;
  private turnCounter = 0;

  constructor(opts: AppendOnlyContextV29Options = {}) {
    this.maxItems = opts.maxItems ?? VOICE_V29_MAX_CONTEXT_ITEMS_DEFAULT;
    this.maxTokens = opts.maxTokens ?? VOICE_V29_MAX_CONTEXT_TOKENS_DEFAULT;
    this.sessionId = opts.sessionId ?? '';
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Append one item. The sequence number is never reused. */
  append(
    kind: VoiceV29ContextItemKind,
    speaker: VoiceV29ContextItem['speaker'],
    text: string,
    atMs: number,
    opts: { turnIndex?: number; meta?: Record<string, string> } = {},
  ): VoiceV29ContextItem {
    const item: VoiceV29ContextItem = {
      seq: this.nextSeq,
      kind,
      atMs,
      speaker,
      text,
      tokens: estimateTokensV29(text),
      turnIndex: opts.turnIndex ?? -1,
      superseded: false,
      supersededBySeq: null,
      meta: { ...(opts.meta ?? {}) },
    };
    this.nextSeq += 1;
    this.items.push(item);
    this.enforceMaxItems();
    return { ...item, meta: { ...item.meta } };
  }

  /** Convenience: append a user turn and bump the turn counter. */
  appendUserTurn(text: string, atMs: number, meta: Record<string, string> = {}): VoiceV29ContextItem {
    const item = this.append('user-turn', 'user', text, atMs, { turnIndex: this.turnCounter, meta });
    this.turnCounter += 1;
    return item;
  }

  /** Convenience: append an agent turn for the current turn index. */
  appendAgentTurn(text: string, atMs: number, meta: Record<string, string> = {}): VoiceV29ContextItem {
    return this.append('agent-turn', 'agent', text, atMs, { turnIndex: this.turnCounter - 1, meta });
  }

  /** Convenience: append a tool call + result pair (two items). */
  appendToolCall(
    toolName: string,
    argsJson: string,
    resultJson: string,
    atMs: number,
    turnIndex = -1,
  ): { call: VoiceV29ContextItem; result: VoiceV29ContextItem } {
    const call = this.append('tool-call', 'tool', `${toolName}(${argsJson})`, atMs, {
      turnIndex,
      meta: { tool: toolName },
    });
    const result = this.append('tool-result', 'tool', resultJson, atMs, {
      turnIndex,
      meta: { tool: toolName, callSeq: String(call.seq) },
    });
    return { call, result };
  }

  /** All items, oldest first (copies — the log itself is never exposed). */
  all(): VoiceV29ContextItem[] {
    return this.items.map((i) => ({ ...i, meta: { ...i.meta } }));
  }

  /** Only the items that are still live (not superseded). */
  live(): VoiceV29ContextItem[] {
    return this.all().filter((i) => !i.superseded);
  }

  /** Items live at a given time: appended by then, not yet superseded then. */
  asOf(atMs: number): VoiceV29ContextItem[] {
    return this.all().filter((i) => {
      if (i.atMs > atMs) return false;
      if (!i.superseded) return true;
      const marker = this.items.find((m) => m.seq === i.supersededBySeq);
      return marker !== undefined && marker.atMs > atMs;
    });
  }

  /** Items of one kind, oldest first. */
  byKind(kind: VoiceV29ContextItemKind): VoiceV29ContextItem[] {
    return this.all().filter((i) => i.kind === kind);
  }

  /** Items of one turn index. */
  byTurn(turnIndex: number): VoiceV29ContextItem[] {
    return this.all().filter((i) => i.turnIndex === turnIndex);
  }

  /** Case-insensitive substring search over live items (all when `liveOnly` is false). */
  search(query: string, liveOnly = true): VoiceV29ContextItem[] {
    const needle = query.toLowerCase();
    if (!needle) return [];
    return (liveOnly ? this.live() : this.all()).filter((i) => i.text.toLowerCase().includes(needle));
  }

  /** Look one item up by seq (null when unknown). */
  get(seq: number): VoiceV29ContextItem | null {
    const found = this.items.find((i) => i.seq === seq);
    return found ? { ...found, meta: { ...found.meta } } : null;
  }

  /**
   * Compact the log: append a summary item covering every
   * live item up to `throughSeq` (default: all live items),
   * then mark those items superseded by it. The originals
   * stay — compaction adds, it never removes. Returns null
   * when there is nothing live to summarise.
   */
  compact(atMs: number, throughSeq?: number, summaryText?: string): VoiceV29CompactionResult | null {
    const live = this.live().filter((i) => throughSeq === undefined || i.seq <= throughSeq);
    if (live.length === 0) return null;
    const tokensBefore = this.stats().liveTokens;
    const text =
      summaryText ??
      `Summary of ${live.length} item(s) (${live[0].seq}–${live[live.length - 1].seq}): ` +
        live
          .map((i) => `[${i.speaker}] ${i.text.slice(0, 120)}`)
          .join(' | ')
          .slice(0, 2000);
    const summary = this.append('summary', 'system', text, atMs, {
      turnIndex: -1,
      meta: { coversFromSeq: String(live[0].seq), coversToSeq: String(live[live.length - 1].seq) },
    });
    const supersededSeqs: number[] = [];
    for (const item of live) {
      const stored = this.items.find((i) => i.seq === item.seq);
      if (stored) {
        stored.superseded = true;
        stored.supersededBySeq = summary.seq;
        supersededSeqs.push(item.seq);
      }
    }
    return {
      atMs,
      summarySeq: summary.seq,
      summaryText: text,
      supersededCount: supersededSeqs.length,
      supersededSeqs,
      tokensBefore,
      liveTokensAfter: this.stats().liveTokens,
    };
  }

  /** True when the live token count is past the soft cap. */
  needsCompaction(): boolean {
    return this.stats().liveTokens > this.maxTokens;
  }

  stats(): VoiceV29ContextStats {
    const live = this.items.filter((i) => !i.superseded);
    const turns = new Set(this.items.filter((i) => i.turnIndex >= 0).map((i) => i.turnIndex)).size;
    return {
      items: this.items.length,
      liveItems: live.length,
      supersededItems: this.items.length - live.length,
      tokens: this.items.reduce((a, i) => a + i.tokens, 0),
      liveTokens: live.reduce((a, i) => a + i.tokens, 0),
      turns,
      userItems: this.items.filter((i) => i.speaker === 'user').length,
      agentItems: this.items.filter((i) => i.speaker === 'agent').length,
      toolItems: this.items.filter((i) => i.kind === 'tool-call' || i.kind === 'tool-result').length,
      summaries: this.items.filter((i) => i.kind === 'summary').length,
      lastSeq: this.nextSeq - 1,
    };
  }

  /** Plain-JSON snapshot (for export / restore). */
  snapshot(): { sessionId: string; nextSeq: number; turnCounter: number; items: VoiceV29ContextItem[] } {
    return {
      sessionId: this.sessionId,
      nextSeq: this.nextSeq,
      turnCounter: this.turnCounter,
      items: this.all(),
    };
  }

  /** Restore from a snapshot (only accepts snapshots of the same session). */
  restore(snapshot: { sessionId: string; nextSeq: number; turnCounter: number; items: VoiceV29ContextItem[] }): void {
    if (snapshot.sessionId !== this.sessionId) {
      throw new Error(`Context snapshot belongs to session "${snapshot.sessionId}", not "${this.sessionId}"`);
    }
    this.items.length = 0;
    for (const item of snapshot.items) this.items.push({ ...item, meta: { ...item.meta } });
    this.nextSeq = snapshot.nextSeq;
    this.turnCounter = snapshot.turnCounter;
  }

  /** Export the live log as Markdown (one line per item). */
  toMarkdown(): string {
    const lines = [`# Voice context ${this.sessionId || '(standalone)'}`, ''];
    for (const item of this.live()) {
      lines.push(`- \`#${item.seq}\` **[${item.kind}] ${item.speaker}** (${item.atMs}ms): ${item.text}`);
    }
    return lines.join('\n');
  }

  private enforceMaxItems(): void {
    if (this.items.length <= this.maxItems) return;
    // Drop oldest *superseded* items first; live history is
    // only dropped when there is nothing superseded left.
    let overflow = this.items.length - this.maxItems;
    for (let i = 0; i < this.items.length && overflow > 0; i += 1) {
      if (this.items[i].superseded) {
        this.items.splice(i, 1);
        i -= 1;
        overflow -= 1;
      }
    }
    if (overflow > 0) this.items.splice(0, overflow);
  }
}

export function createAppendOnlyContextV29(opts: AppendOnlyContextV29Options = {}): AppendOnlyContextV29 {
  return new AppendOnlyContextV29(opts);
}
