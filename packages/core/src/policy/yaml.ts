/**
 * Minimal YAML subset — parser + emitter (v1.04, T3b).
 *
 * The policy file may be YAML or JSON, but open-bot has no YAML
 * dependency (and must not gain a heavy one for one config file), so
 * this module implements the small subset a policy file needs:
 *
 * - block mappings by indentation (`key: value`, `key:` + nested block)
 * - block sequences (`- item`, `- key: value` maps inside sequences)
 * - scalars: plain, single-quoted, double-quoted (with escapes),
 *   integers, floats, booleans, null (`null`, `~`, empty)
 * - flow collections: `[a, b]`, `{k: v}` (including nested)
 * - full-line and trailing `#` comments (outside quotes)
 *
 * NOT supported (rejected with a clear error, never silently
 * misread): tabs for indentation, anchors/aliases (`&a`, `*a`),
 * multi-line block scalars (`|`, `>`), tags (`!!str`), multi-document
 * files (`---` / `...`), duplicate keys, merge keys (`<<:`).
 *
 * A policy file that needs any of those should be written as JSON
 * instead — `parsePolicyDocument` in `validate.ts` accepts both.
 * The emitter only ever produces the supported subset, so a
 * parse → emit round-trip is always safe.
 */

export class PolicyYamlError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(line !== undefined ? `YAML line ${line}: ${message}` : message);
    this.name = 'PolicyYamlError';
    this.line = line;
  }
}

interface LogicalLine {
  indent: number;
  text: string;
  num: number;
}

/** Strip a trailing comment (` # ...`) outside quotes; `#` at line start is a full-line comment. */
function stripComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") {
        // '' inside a single-quoted scalar is an escaped quote.
        if (line[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function logicalLines(text: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  for (const [idx, raw] of text.split('\n').entries()) {
    const num = idx + 1;
    const noCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (noCr.includes('\t')) {
      // A tab anywhere in the line: reject — tabs are never valid
      // indentation in YAML, and guessing is how files get misread.
      const stripped = stripComment(noCr);
      if (stripped.trim() !== '') {
        throw new PolicyYamlError('tabs are not allowed for indentation (use spaces)', num);
      }
      continue;
    }
    const stripped = stripComment(noCr);
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ indent, text: stripped.trimStart(), num });
  }
  return out;
}

/** Split `key: value` at the first `:` followed by space or end-of-line. */
function splitKeyValue(text: string, num: number): { key: string; rest: string } | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) {
      return { key: text.slice(0, i), rest: text.slice(i + 1).trimStart() };
    }
  }
  return null;
}

function parseQuoted(text: string, num: number): string {
  const q = text[0];
  if (q === "'") {
    // Scan for the closing quote, honouring '' as an escaped quote.
    let j = 1;
    while (j < text.length) {
      if (text[j] === "'") {
        if (text[j + 1] === "'") j += 2;
        else break;
      } else j++;
    }
    if (j >= text.length) {
      throw new PolicyYamlError('unterminated single-quoted string', num);
    }
    if (j !== text.length - 1) {
      throw new PolicyYamlError('unexpected content after closing quote', num);
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  // Double-quoted: handle the common escapes.
  let out = '';
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (i !== text.length - 1) {
        throw new PolicyYamlError('unexpected content after closing quote', num);
      }
      return out;
    }
    if (ch === '\\') {
      const esc = text[i + 1];
      const map: Record<string, string> = {
        n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'",
      };
      if (esc === undefined || !(esc in map)) {
        throw new PolicyYamlError(`unsupported escape \\${esc ?? ''}`, num);
      }
      out += map[esc];
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  throw new PolicyYamlError('unterminated double-quoted string', num);
}

const INT_RE = /^[-+]?\d+$/;
const FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;

/** Parse one scalar token (plain / quoted / flow / null / bool / number). */
export function parseYamlScalar(token: string, num: number): unknown {
  const t = token.trim();
  if (t === '') return null;
  if (t.startsWith('[') || t.startsWith('{')) return parseFlow(t, num);
  if (t[0] === "'" || t[0] === '"') return parseQuoted(t, num);
  if (/^[!&*|>@`%#]/.test(t) || t === '---' || t === '...') {
    throw new PolicyYamlError(
      `unsupported YAML feature: "${t.slice(0, 12)}" (anchors, tags, block scalars and multi-document files are not supported — use JSON for those)`,
      num,
    );
  }
  const lower = t.toLowerCase();
  if (lower === 'null' || lower === '~') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (INT_RE.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
  }
  if (FLOAT_RE.test(t) && t !== '.' && !INT_RE.test(t)) return Number(t);
  return t;
}

/** Parse a flow value: `[a, b]` or `{k: v, ...}` (nesting allowed). */
function parseFlow(text: string, num: number): unknown {
  let i = 0;
  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const parseValue = (): unknown => {
    skipWs();
    if (i >= text.length) throw new PolicyYamlError('unexpected end of flow value', num);
    const ch = text[i];
    if (ch === '[' || ch === '{') return parseCollection();
    if (ch === "'" || ch === '"') {
      // Reuse the quoted parser on the remainder up to the closing quote.
      let j = i + 1;
      if (ch === "'") {
        while (j < text.length) {
          if (text[j] === "'") {
            if (text[j + 1] === "'") j += 2;
            else break;
          } else j++;
        }
        if (j >= text.length) throw new PolicyYamlError('unterminated quoted string in flow value', num);
        const raw = text.slice(i, j + 1);
        i = j + 1;
        return parseQuoted(raw, num);
      }
      while (j < text.length) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      if (j >= text.length) throw new PolicyYamlError('unterminated quoted string in flow value', num);
      const raw = text.slice(i, j + 1);
      i = j + 1;
      return parseQuoted(raw, num);
    }
    let j = i;
    let depth = 0;
    while (j < text.length) {
      const c = text[j];
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      else if (c === ':' && depth === 0 && (text[j + 1] === ' ' || text[j + 1] === ',' || text[j + 1] === '}')) break;
      j++;
    }
    const raw = text.slice(i, j).trim();
    i = j;
    if (raw === '') throw new PolicyYamlError('empty value in flow collection', num);
    return parseYamlScalar(raw, num);
  };
  const parseCollection = (): unknown => {
    const open = text[i];
    const close = open === '[' ? ']' : '}';
    i++;
    const isSeq = open === '[';
    const seq: unknown[] = [];
    const map = new Map<string, unknown>();
    skipWs();
    if (text[i] === close) {
      i++;
      return isSeq ? seq : Object.fromEntries(map);
    }
    for (;;) {
      skipWs();
      if (!isSeq) {
        // Map entry: key: value
        const keyVal = parseValue();
        skipWs();
        if (text[i] !== ':') throw new PolicyYamlError('expected ":" in flow mapping', num);
        i++;
        const value = parseValue();
        const key = String(keyVal);
        if (map.has(key)) throw new PolicyYamlError(`duplicate key "${key}"`, num);
        map.set(key, value);
      } else {
        seq.push(parseValue());
      }
      skipWs();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === close) {
        i++;
        return isSeq ? seq : Object.fromEntries(map);
      }
      throw new PolicyYamlError(`expected "," or "${close}" in flow collection`, num);
    }
  };
  const value = parseCollection();
  skipWs();
  if (i !== text.length) {
    throw new PolicyYamlError('unexpected content after flow value', num);
  }
  return value;
}

function parseKey(rawKey: string, num: number): string {
  const k = rawKey.trim();
  if (k === '') throw new PolicyYamlError('empty key', num);
  if (k[0] === "'" || k[0] === '"') return parseQuoted(k, num);
  if (k.includes(':')) throw new PolicyYamlError(`bad key "${k}"`, num);
  return k;
}

/** Parse a block starting at `lines[pos]` with the given indent. Returns [value, nextPos]. */
function parseBlock(lines: LogicalLine[], pos: number, indent: number): [unknown, number] {
  if (pos >= lines.length) return [null, pos];
  const first = lines[pos];
  if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(lines, pos, indent);
  return parseMap(lines, pos, indent);
}

function parseMap(lines: LogicalLine[], pos: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = pos;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent) break;
    if (line.text === '-' || line.text.startsWith('- ')) break;
    const kv = splitKeyValue(line.text, line.num);
    if (!kv) {
      throw new PolicyYamlError(`expected "key: value" (got "${line.text.slice(0, 40)}")`, line.num);
    }
    const key = parseKey(kv.key, line.num);
    if (key in out) throw new PolicyYamlError(`duplicate key "${key}"`, line.num);
    i++;
    if (kv.rest !== '') {
      out[key] = parseYamlScalar(kv.rest, line.num);
    } else if (i < lines.length && lines[i].indent > indent) {
      const [nested, next] = parseBlock(lines, i, lines[i].indent);
      out[key] = nested;
      i = next;
    } else {
      out[key] = null;
    }
  }
  return [out, i];
}

function parseSeq(lines: LogicalLine[], pos: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let i = pos;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent) break;
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const content = line.text === '-' ? '' : line.text.slice(2);
    const itemNum = line.num;
    i++;
    if (content === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const [nested, next] = parseBlock(lines, i, lines[i].indent);
        out.push(nested);
        i = next;
      } else {
        out.push(null);
      }
      continue;
    }
    // `- key: value` — an inline map whose first line is the item
    // content; continuation lines sit at indent + 2.
    if (splitKeyValue(content, itemNum) !== null) {
      const sub: LogicalLine[] = [{ indent: indent + 2, text: content, num: itemNum }];
      while (i < lines.length && lines[i].indent >= indent + 2) {
        sub.push(lines[i]);
        i++;
      }
      // A nested block under a `- key:` line sits deeper than indent+2;
      // parseMap handles it via the normal indent rules.
      const [map, next] = parseMap(sub, 0, indent + 2);
      void next;
      out.push(map);
      continue;
    }
    out.push(parseYamlScalar(content, itemNum));
  }
  return [out, i];
}

/**
 * Parse a YAML-subset document. An empty document parses to `null`.
 * Throws `PolicyYamlError` on anything outside the subset.
 */
export function parseYamlSubset(text: string): unknown {
  const lines = logicalLines(text);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    const bad = lines[next];
    throw new PolicyYamlError(
      `unexpected content at indent ${bad.indent} (expected ${lines[0].indent})`,
      bad.num,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Emitter (only produces the supported subset)
// ---------------------------------------------------------------------------

function needsQuotes(s: string): boolean {
  if (s === '') return true;
  if (s.trim() !== s) return true;
  if (/^(true|false|null|~)$/i.test(s)) return true;
  if (INT_RE.test(s) || FLOAT_RE.test(s)) return true;
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(s) || s.includes(': ') || s.includes(' #')) return true;
  if (s.startsWith('- ') || s === '-') return true;
  return false;
}

function emitScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const s = String(value);
  if (s.includes('\n')) {
    // No block scalars in the subset: fall back to double quotes.
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  if (needsQuotes(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}

function emitNode(value: unknown, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        if (Array.isArray(item)) {
          out.push(`${pad}-`);
          emitNode(item, indent + 2, out);
        } else {
          const entries = Object.entries(item as Record<string, unknown>);
          if (entries.length === 0) {
            out.push(`${pad}- {}`);
          } else {
            entries.forEach(([k, v], idx) => {
              const prefix = idx === 0 ? `${pad}- ` : `${pad}  `;
              emitKeyValue(prefix, k, v, indent + 2, out);
            });
          }
        }
      } else {
        out.push(`${pad}- ${emitScalar(item)}`);
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push(`${pad}{}`);
      return;
    }
    for (const [k, v] of entries) emitKeyValue(pad, k, v, indent, out);
    return;
  }
  out.push(`${pad}${emitScalar(value)}`);
}

function emitKeyValue(prefix: string, key: string, value: unknown, indent: number, out: string[]): void {
  const k = needsQuotes(key) ? `'${key.replace(/'/g, "''")}'` : key;
  if (value === null || typeof value !== 'object') {
    out.push(`${prefix}${k}: ${emitScalar(value)}`);
    return;
  }
  if (Array.isArray(value) && value.length === 0) {
    out.push(`${prefix}${k}: []`);
    return;
  }
  if (!Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
    out.push(`${prefix}${k}: {}`);
    return;
  }
  out.push(`${prefix}${k}:`);
  emitNode(value, indent + 2, out);
}

/** Serialise a value to the YAML subset this module can parse back. */
export function emitYamlSubset(value: unknown): string {
  const out: string[] = [];
  emitNode(value, 0, out);
  return `${out.join('\n')}\n`;
}
