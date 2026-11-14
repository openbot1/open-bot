/**
 * Context assembly — build the prompt the model actually sees from
 * the window (context engineering v2, v1.05 Team T4).
 *
 * The window holds segments; the model needs messages in order.
 * `assemblePrompt` lays the window out as a message list that fits
 * the budget:
 *
 *   1. system segments first, verbatim (never dropped),
 *   2. anchors next, verbatim (decisions/constraints the model must
 *      not lose — they are small and high-value),
 *   3. summaries, newest tier first within the budget (a tier-1
 *      turn summary is closer to the source than a tier-3 session
 *      summary, so tier 1 wins when space is tight),
 *   4. recent turns last, newest first, until the budget runs out.
 *
 * When the window does not fit, the lowest-priority segments are
 * dropped and listed in `droppedIds` — the caller can log them or
 * spill them instead of silently losing them. The result carries a
 * manifest (what was included, what was dropped, token counts) so
 * the inspector can show exactly what the model saw.
 *
 * Assembly is deterministic and model-free (chars/4 estimation).
 */

import { estimateTokens } from './estimator';
import type { ContextSegment } from './windowManager';

/** One assembled message (role + text, in prompt order). */
export interface AssembledMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Window segment ids this message came from. */
  segmentIds: string[];
}

/** Result of assembling a prompt from the window. */
export interface AssemblyResult {
  messages: AssembledMessage[];
  includedIds: string[];
  droppedIds: string[];
  tokensUsed: number;
  tokenBudget: number;
  fits: boolean;
  /** Segments by kind that made it into the prompt. */
  includedByKind: Record<string, number>;
}

export interface AssembleOptions {
  /** Token budget for the assembled prompt (default: whole window). */
  tokenBudget?: number;
  /** Max recent turns to include (default: all that fit). */
  maxTurns?: number;
  /** Include spilled segments as placeholders (default: skip them). */
  includeSpilled?: boolean;
}

/** Role for a segment kind when it becomes a message. */
function roleFor(segment: ContextSegment): 'system' | 'user' | 'assistant' {
  if (segment.kind === 'system') return 'system';
  if (segment.kind === 'turn') return 'assistant';
  return 'system';
}

/**
 * Assemble the prompt from window segments, in priority order,
 * until the token budget runs out. System segments are always
 * included (even over budget — dropping them would change the
 * model's instructions); everything else is dropped lowest
 * priority first.
 */
export function assemblePrompt(
  segments: ContextSegment[],
  options: AssembleOptions = {},
): AssemblyResult {
  const includeSpilled = options.includeSpilled ?? false;
  const usable = segments.filter((s) => includeSpilled || !s.spilled);
  const budget = options.tokenBudget ?? usable.reduce((sum, s) => sum + s.tokens, 0);
  const maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY;

  const byKind = (kind: ContextSegment['kind']) =>
    usable.filter((s) => s.kind === kind);
  const system = byKind('system');
  const anchors = byKind('anchor');
  const summaries = byKind('summary').sort((a, b) => {
    // Selection priority: tier 1 closest to source, then newest.
    const ta = a.tier ?? 1;
    const tb = b.tier ?? 1;
    if (ta !== tb) return ta - tb;
    return b.seq - a.seq;
  });
  const turns = byKind('turn').sort((a, b) => b.seq - a.seq);
  const toolResults = byKind('tool-result').sort((a, b) => b.seq - a.seq);

  // Selection order (who gets budget first): system, anchors,
  // summaries (tier 1 first), turns (newest first), tool results
  // (newest first). Emission order is chronological within each
  // kind, so the model sees turns in the order they happened.
  const selectionOrder = [
    ...system,
    ...anchors,
    ...summaries,
    ...turns.slice(0, maxTurns),
    ...toolResults,
  ];
  const selected = new Set<string>();
  const droppedIds: string[] = [];
  let tokensUsed = 0;
  for (const segment of selectionOrder) {
    const isSystem = segment.kind === 'system';
    if (tokensUsed + segment.tokens > budget && !isSystem) {
      droppedIds.push(segment.id);
      continue;
    }
    selected.add(segment.id);
    tokensUsed += segment.tokens;
  }

  const emitOrder = [
    ...system,
    ...anchors,
    ...[...summaries].sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1) || a.seq - b.seq),
    ...[...turns].sort((a, b) => a.seq - b.seq),
    ...[...toolResults].sort((a, b) => a.seq - b.seq),
  ].filter((s) => selected.has(s.id));

  const messages: AssembledMessage[] = [];
  const includedIds: string[] = [];
  const includedByKind: Record<string, number> = {};
  for (const segment of emitOrder) {
    const role = roleFor(segment);
    const last = messages[messages.length - 1];
    if (last && last.role === role && segment.kind !== 'turn') {
      // Merge adjacent same-role non-turn segments into one message.
      last.content += `\n${segment.text}`;
      last.segmentIds.push(segment.id);
    } else {
      messages.push({ role, content: segment.text, segmentIds: [segment.id] });
    }
    includedIds.push(segment.id);
    includedByKind[segment.kind] = (includedByKind[segment.kind] ?? 0) + 1;
  }

  return {
    messages,
    includedIds,
    droppedIds,
    tokensUsed,
    tokenBudget: budget,
    fits: droppedIds.length === 0,
    includedByKind,
  };
}

/** Token estimate for an assembled message list (sanity check). */
export function estimateAssemblyTokens(messages: AssembledMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0);
}

/**
 * Short manifest of an assembly (for logs / inspector): what went
 * in, what was dropped, and how much room is left.
 */
export function assemblyManifest(result: AssemblyResult): string {
  const lines = [
    `Assembled ${result.messages.length} messages, ${result.tokensUsed}/${result.tokenBudget} tokens` +
      (result.fits ? '' : ` — dropped ${result.droppedIds.length} segment(s) over budget`),
    `Included: ${Object.entries(result.includedByKind)
      .map(([kind, count]) => `${kind} x${count}`)
      .join(', ') || '(none)'}`,
  ];
  if (result.droppedIds.length > 0) {
    lines.push(`Dropped: ${result.droppedIds.join(', ')}`);
  }
  return lines.join('\n');
}
