/**
 * Anchors — the facts a compaction must never compress away
 * (context engineering v2, v1.05 Team T4).
 *
 * A tiered compaction throws away most turn text, but a few lines
 * carry the session: a decision that was made, a number that was
 * agreed, a file that was changed, a constraint the user stated.
 * Those lines are *anchors*. Every tier keeps its anchors verbatim
 * (with their source turn/message ids) so a later summary can still
 * be checked against them, and the window manager evicts anchors
 * last (after summaries and old turns, never before the system
 * prompt).
 *
 * Extraction is deterministic and model-free: small pattern lists
 * (English + Vietnamese) over lines of source text. It is a
 * heuristic — it finds the obvious anchors reliably and never
 * invents one. A caller that knows better can pass anchors in
 * directly; `TieredCompactor` accepts both.
 */

/** Kinds of anchor a line can carry. */
export type AnchorKind = 'decision' | 'metric' | 'file-change' | 'constraint' | 'fact';

/** One anchor: a verbatim line plus where it came from. */
export interface Anchor {
  id: string;
  kind: AnchorKind;
  /** Verbatim source line (trimmed, single line). */
  text: string;
  /** Ids of the source messages/turns the line came from. */
  sourceIds: string[];
  /** Turn index in the session (0-based), when known. */
  turnIndex?: number;
  /** ISO timestamp, when known. */
  at?: string;
}

/** A source message the anchor extractor can read. */
export interface AnchorSourceMessage {
  /** Stable id (turn id or message id) used for citations. */
  id: string;
  role: string;
  content?: string;
  /** Turn index in the session (0-based), when known. */
  turnIndex?: number;
  at?: string;
}

/** Decision markers (English + Vietnamese), matched case-insensitively. */
const DECISION_PATTERNS: RegExp[] = [
  /\bdecided?\b/i,
  /\bdecision\b/i,
  /\bwe (will|should|must)\b/i,
  /\bagreed\b/i,
  /\bchosen\b/i,
  /\bgo with\b/i,
  /\bquyết định\b/i,
  /\bđã chọn\b/i,
  /\bthống nhất\b/i,
  /\bchốt\b/i,
  /\bquyết\b/i,
];

/** Constraint markers — rules the user stated that must survive. */
const CONSTRAINT_PATTERNS: RegExp[] = [
  /\bnever\b/i,
  /\balways\b/i,
  /\bmust not\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bforbidden\b/i,
  /\bkhông được\b/i,
  /\bkhông bao giờ\b/i,
  /\bluôn luôn\b/i,
  /\bbắt buộc\b/i,
  /\bphải\b/i,
  /\bcấm\b/i,
];

/** A line that names a changed/created file (path with an extension). */
const FILE_PATH_PATTERN =
  /(?:^|[\s"'`(\[])(?:[\w.@/-]+\/)?[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|java|md|json|yaml|yml|toml|css|html|sql|sh)\b/;

/** A line that states a number with a unit or a comparison. */
const METRIC_PATTERN =
  /\b\d[\d,]*(?:\.\d+)?\s*(?:%|ms|s|mb|gb|kb|tokens?|lines?|tests?|files?|users?|usd|\$|vnd|đ)\b/i;

/** A line that states a plain number that looks like a result. */
const BARE_NUMBER_PATTERN = /\b\d[\d,]*(?:\.\d+)?\b/;

/** Stop words ignored when scoring whether a line is a fact. */
const ANCHOR_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'what', 'how', 'why', 'when',
  'là', 'của', 'và', 'có', 'không', 'cho', 'với', 'trong', 'này', 'đó', 'làm', 'để', 'tôi', 'bạn',
  'ok', 'okay', 'yes', 'no', 'hi', 'hello', 'thanks', 'thank', 'please', 'sure',
]);

function matchesAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function wordsOf(line: string): string[] {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !ANCHOR_STOP_WORDS.has(word));
}

/**
 * Classify one line. Returns the strongest kind that matches, or
 * null when the line carries nothing worth anchoring. Priority:
 * decision > constraint > file-change > metric > fact (a long,
 * content-bearing line). Short chatty lines never anchor.
 */
export function classifyAnchorLine(line: string): AnchorKind | null {
  const trimmed = line.trim();
  if (trimmed.length < 12 || trimmed.length > 500) return null;
  if (matchesAny(trimmed, DECISION_PATTERNS)) return 'decision';
  if (matchesAny(trimmed, CONSTRAINT_PATTERNS)) return 'constraint';
  if (FILE_PATH_PATTERN.test(trimmed)) return 'file-change';
  if (METRIC_PATTERN.test(trimmed)) return 'metric';
  // A "fact" line: long enough, several content words, and a number
  // or a colon-separated key/value — e.g. "Total: 4,686 tests pass".
  const words = wordsOf(trimmed);
  if (words.length >= 5 && (BARE_NUMBER_PATTERN.test(trimmed) || trimmed.includes(':'))) {
    return 'fact';
  }
  return null;
}

/**
 * Extract anchors from source messages. Each source line is tested
 * once; a line that anchors is kept verbatim with its source id.
 * Duplicate lines (same kind + same text) collapse to the first
 * occurrence. `maxAnchors` caps the result (default 200).
 */
export function extractAnchors(
  messages: AnchorSourceMessage[],
  options: { maxAnchors?: number; kinds?: AnchorKind[] } = {},
): Anchor[] {
  const maxAnchors = options.maxAnchors ?? 200;
  const wanted = options.kinds ? new Set(options.kinds) : null;
  const anchors: Anchor[] = [];
  const seen = new Set<string>();
  let counter = 0;
  for (const message of messages) {
    if (typeof message.content !== 'string' || message.content === '') continue;
    const lines = message.content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '') continue;
      const kind = classifyAnchorLine(line);
      if (kind === null) continue;
      if (wanted && !wanted.has(kind)) continue;
      const key = `${kind}::${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({
        id: `anchor-${counter++}`,
        kind,
        text: line,
        sourceIds: [message.id],
        ...(typeof message.turnIndex === 'number' ? { turnIndex: message.turnIndex } : {}),
        ...(message.at ? { at: message.at } : {}),
      });
      if (anchors.length >= maxAnchors) return anchors;
    }
  }
  return anchors;
}

/** Count anchors by kind (for stats / inspector views). */
export function countAnchorsByKind(anchors: Anchor[]): Record<AnchorKind, number> {
  const counts: Record<AnchorKind, number> = {
    decision: 0,
    metric: 0,
    'file-change': 0,
    constraint: 0,
    fact: 0,
  };
  for (const anchor of anchors) counts[anchor.kind]++;
  return counts;
}

/** Keep only anchors of the given kinds (policy: which anchors a tier keeps). */
export function filterAnchors(anchors: Anchor[], keepKinds: AnchorKind[]): Anchor[] {
  const wanted = new Set(keepKinds);
  return anchors.filter((anchor) => wanted.has(anchor.kind));
}

/** Render anchors as a compact, citable block for a summary or prompt. */
export function formatAnchors(anchors: Anchor[]): string {
  if (anchors.length === 0) return '';
  const lines = anchors.map(
    (anchor) => `- [${anchor.kind}] ${anchor.text} (src: ${anchor.sourceIds.join(', ')})`,
  );
  return `Anchors (${anchors.length}):\n${lines.join('\n')}`;
}
