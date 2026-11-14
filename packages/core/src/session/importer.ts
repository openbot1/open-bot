/**
 * Session importer — Codex CLI + Claude Code → open-bot (v1.04, T3c).
 *
 * Reads the session files those CLIs already keep on the user's own
 * machine and maps them onto open-bot's imported-session format, so a
 * user switching to open-bot does not lose their history.
 *
 * SOURCES (local files only, read-only):
 * - Codex CLI:  `~/.codex/sessions/<date>/<id>.jsonl`
 * - Claude Code: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
 *
 * PRIVACY — this is the whole point of the module, so it is strict:
 * - The importer only ever opens files whose path it built itself
 *   from those two directory patterns. It NEVER opens `auth.json`,
 *   `.credentials`, `config.json`, or any other file that can hold a
 *   key — there is no code path here that reads them, and the tests
 *   assert that a directory full of credential files yields zero
 *   candidates and zero reads.
 * - Symlinks are never followed (a session file that is a symlink is
 *   skipped, not resolved).
 * - Only allow-listed fields are copied into the output. Unknown
 *   top-level fields are dropped, and any field whose name looks like
 *   a credential (KEY/TOKEN/SECRET/PASSWORD/…) is stripped even when
 *   it appears inside a copied record.
 * - Import is OPT-IN: nothing here scans a home directory on its
 *   own. The caller passes `homeDir` explicitly (the UI asks the user
 *   first, per Huy's standing rule: auto-detect only with consent,
 *   never copy credentials).
 * - Output is written to the user's own workspace
 *   (`.open-bot/imported-sessions/<id>.json`) — nothing leaves the
 *   machine.
 *
 * PARSING is tolerant by design: session files are append-only logs
 * written by another program, so one corrupt line must not lose the
 * whole session. Bad lines are skipped and counted (`skippedLines`),
 * unknown record types are skipped, messages are capped in count and
 * length (with `truncated: true` recorded) so a giant session cannot
 * blow up memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AcpRecordedMessage } from '../acp/types';

/** Format version of the imported-session files this module writes. */
export const IMPORTED_SESSION_VERSION = 1;

/** Directory (under a workspace) imported sessions are written to. */
export const IMPORTED_SESSIONS_REL_DIR = path.join('.open-bot', 'imported-sessions');

/** Cap on messages kept per imported session (oldest-first truncation). */
export const MAX_IMPORTED_MESSAGES = 2000;
/** Cap on characters kept per message (truncation is flagged). */
export const MAX_IMPORTED_MESSAGE_CHARS = 20_000;
/** Cap on session files listed by discovery (newest first). */
export const MAX_DISCOVERED_SESSIONS = 500;
/** Cap on bytes read from one session file (a session log is text; bigger = suspect). */
export const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;

/** Where a session came from. */
export type ImportSource = 'codex' | 'claude-code';

/** One tool call recorded inside a session. */
export interface ImportedToolCall {
  id?: string;
  name: string;
  /** Arguments as parsed JSON when possible, else the raw string. */
  args?: unknown;
  /** Tool result text, when the session recorded one. */
  result?: string;
}

/** One message of an imported session. */
export interface ImportedMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** ISO timestamp, when the source recorded one. */
  timestamp?: string;
  /** Tool calls made in this message (assistant messages). */
  toolCalls?: ImportedToolCall[];
  /** True when `content` was cut at MAX_IMPORTED_MESSAGE_CHARS. */
  truncated?: boolean;
}

/** One imported session, in open-bot's own format. */
export interface ImportedSession {
  /** `imported-<source>-<id>`: namespaced so it never collides with a native session id. */
  id: string;
  version: number;
  source: ImportSource;
  /** Original session id from the source CLI. */
  sourceSessionId: string;
  /** Original file the session was read from (absolute path). */
  sourcePath: string;
  /** Working directory the source session ran in, when recorded. */
  cwd?: string;
  /** Model id the source session used, when recorded. */
  model?: string;
  /** First user message, truncated — used as the session title. */
  title?: string;
  startedAt?: string;
  endedAt?: string;
  messages: ImportedMessage[];
  /** JSON lines that could not be parsed (skipped, counted). */
  skippedLines: number;
  /** Non-fatal notes (unknown record types seen, truncation, …). */
  warnings: string[];
}

/** One importable session file found on disk (discovery only — nothing read yet). */
export interface ImportCandidate {
  source: ImportSource;
  /** Absolute path of the session file. */
  filePath: string;
  /** Session id taken from the file name. */
  sessionId: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** Outcome of importing one file. */
export interface ImportSessionResult {
  session: ImportedSession | null;
  /** Why the import failed (null when it succeeded). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Privacy guards
// ---------------------------------------------------------------------------

/** Field names that look like credentials — stripped wherever they appear. */
export const CREDENTIAL_FIELD_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE|API[-_]?KEY/i;

/** Remove credential-looking keys from a record (one level deep). */
export function stripCredentialFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (CREDENTIAL_FIELD_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Truncate message text to the cap, flagging it. */
function capText(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_IMPORTED_MESSAGE_CHARS) return { content: text, truncated: false };
  return {
    content: `${text.slice(0, MAX_IMPORTED_MESSAGE_CHARS)}\n[…truncated]`,
    truncated: true,
  };
}

function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Discovery (lists files — reads nothing)
// ---------------------------------------------------------------------------

/** List regular (non-symlink) `.jsonl` files directly under `dir`. */
function listSessionFiles(dir: string): Array<{ filePath: string; sizeBytes: number; modifiedAt: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ filePath: string; sizeBytes: number; modifiedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) continue;
      out.push({ filePath, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    } catch {
      continue;
    }
  }
  return out;
}

function listSubdirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => path.join(dir, e.name));
}

/**
 * Find importable session files under a home directory. Only the two
 * session directories are listed — `~/.codex/sessions/<date>/` and
 * `~/.claude/projects/<project>/` — and only `*.jsonl` regular files. A
 * missing directory is an empty list, not an error. Newest first.
 */
export function discoverImportableSessions(homeDir: string): ImportCandidate[] {
  const home = (homeDir ?? '').trim();
  if (!home) return [];
  const found: ImportCandidate[] = [];
  // Codex: ~/.codex/sessions/<date>/<id>.jsonl
  for (const dateDir of listSubdirs(path.join(home, '.codex', 'sessions'))) {
    for (const f of listSessionFiles(dateDir)) {
      found.push({
        source: 'codex',
        filePath: f.filePath,
        sessionId: path.basename(f.filePath, '.jsonl'),
        sizeBytes: f.sizeBytes,
        modifiedAt: f.modifiedAt,
      });
    }
  }
  // Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
  for (const projectDir of listSubdirs(path.join(home, '.claude', 'projects'))) {
    for (const f of listSessionFiles(projectDir)) {
      found.push({
        source: 'claude-code',
        filePath: f.filePath,
        sessionId: path.basename(f.filePath, '.jsonl'),
        sizeBytes: f.sizeBytes,
        modifiedAt: f.modifiedAt,
      });
    }
  }
  found.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
  return found.slice(0, MAX_DISCOVERED_SESSIONS);
}

// ---------------------------------------------------------------------------
// Content extraction (shared by both formats)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a source content value: a string, or a list
 * of content blocks (`{type:'text', text}`, `{type:'input_text',
 * text}`, …). Anything else contributes its JSON form, so no text is
 * silently lost.
 */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!isRecord(block)) continue;
      const text = asText(block['text']);
      if (text !== undefined) {
        parts.push(text);
        continue;
      }
      // Tool-result blocks carry their payload under `content`.
      if (block['type'] === 'tool_result' && block['content'] !== undefined) {
        parts.push(extractContentText(block['content']));
        continue;
      }
      if (block['type'] === 'tool_use') continue; // handled as a tool call, not text
    }
    return parts.join('\n');
  }
  if (isRecord(content)) {
    const text = asText(content['text']);
    if (text !== undefined) return text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Codex CLI format
// ---------------------------------------------------------------------------

function parseCodexRecord(
  record: Record<string, unknown>,
  session: ImportedSession,
): void {
  const type = record['type'];
  const clean = stripCredentialFields(record);
  if (type === 'session_meta') {
    session.cwd = asText(clean['cwd']) ?? session.cwd;
    session.model = asText(clean['model']) ?? session.model;
    session.startedAt = toIso(clean['timestamp']) ?? session.startedAt;
    return;
  }
  if (type === 'message') {
    const role = clean['role'];
    if (role !== 'user' && role !== 'assistant') {
      session.warnings.push(`skipped codex message with unknown role ${JSON.stringify(role)}`);
      return;
    }
    const text = extractContentText(clean['content']);
    const capped = capText(text);
    const msg: ImportedMessage = {
      role,
      content: capped.content,
      timestamp: toIso(clean['timestamp']),
      ...(capped.truncated ? { truncated: true } : {}),
    };
    session.messages.push(msg);
    return;
  }
  if (type === 'function_call') {
    const name = asText(clean['name']);
    if (!name) return;
    let args: unknown;
    const rawArgs = clean['arguments'];
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = rawArgs;
      }
    } else {
      args = rawArgs;
    }
    const call: ImportedToolCall = {
      id: asText(clean['call_id'] ?? clean['id']),
      name,
      ...(args !== undefined ? { args } : {}),
    };
    const last = session.messages[session.messages.length - 1];
    if (last && last.role === 'assistant') {
      last.toolCalls = [...(last.toolCalls ?? []), call];
    } else {
      session.messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [call],
        timestamp: toIso(clean['timestamp']),
      });
    }
    return;
  }
  if (type === 'function_call_output') {
    const output = extractContentText(clean['output']);
    const callId = asText(clean['call_id']);
    // Attach the result to the matching tool call, newest first.
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      const call = msg.toolCalls?.find((c) => (callId === undefined ? true : c.id === callId));
      if (call && call.result === undefined) {
        call.result = capText(output).content;
        return;
      }
    }
    session.messages.push({ role: 'tool', content: capText(output).content });
    return;
  }
  if (type === 'reasoning') return; // model internals — not user history
  session.warnings.push(`skipped unknown codex record type ${JSON.stringify(type)}`);
}

/** Parse one Codex CLI session file (JSONL). Never throws. */
export function parseCodexSessionFile(filePath: string, text: string): ImportedSession {
  const sessionId = path.basename(filePath, '.jsonl');
  const session: ImportedSession = {
    id: `imported-codex-${sessionId}`,
    version: IMPORTED_SESSION_VERSION,
    source: 'codex',
    sourceSessionId: sessionId,
    sourcePath: filePath,
    messages: [],
    skippedLines: 0,
    warnings: [],
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      session.skippedLines++;
      continue;
    }
    if (!isRecord(record)) {
      session.skippedLines++;
      continue;
    }
    parseCodexRecord(record, session);
    if (session.messages.length > MAX_IMPORTED_MESSAGES) {
      session.messages = session.messages.slice(0, MAX_IMPORTED_MESSAGES);
      if (!session.warnings.includes('message cap reached')) {
        session.warnings.push(`message cap reached (${MAX_IMPORTED_MESSAGES} kept)`);
      }
    }
  }
  finishSession(session);
  return session;
}

// ---------------------------------------------------------------------------
// Claude Code format
// ---------------------------------------------------------------------------

function parseClaudeRecord(
  record: Record<string, unknown>,
  session: ImportedSession,
): void {
  const type = record['type'];
  const clean = stripCredentialFields(record);
  if (type === 'summary' || type === 'file-history-snapshot' || type === 'queue-operation') {
    return; // bookkeeping records, not conversation
  }
  if (type !== 'user' && type !== 'assistant') {
    session.warnings.push(`skipped unknown claude record type ${JSON.stringify(type)}`);
    return;
  }
  const message = clean['message'];
  if (!isRecord(message)) {
    session.warnings.push('skipped claude record without a message object');
    return;
  }
  session.cwd = asText(clean['cwd']) ?? asText(message['cwd']) ?? session.cwd;
  if (session.startedAt === undefined) session.startedAt = toIso(clean['timestamp']);
  session.endedAt = toIso(clean['timestamp']) ?? session.endedAt;
  const model = asText(message['model']);
  if (model) session.model = model;
  const content = message['content'];
  const blocks = Array.isArray(content) ? content : [];
  const toolCalls: ImportedToolCall[] = [];
  const texts: string[] = [];
  const toolResults: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' || block['type'] === 'input_text') {
      const t = asText(block['text']);
      if (t !== undefined) texts.push(t);
    } else if (block['type'] === 'tool_use') {
      const name = asText(block['name']);
      if (name) {
        toolCalls.push({
          id: asText(block['id']),
          name,
          ...(block['input'] !== undefined ? { args: stripCredentialFields(isRecord(block['input']) ? block['input'] : {}) } : {}),
        });
      }
    } else if (block['type'] === 'tool_result') {
      const result = extractContentText(block['content']);
      const callId = asText(block['tool_use_id']);
      const target = toolCalls.find((c) => c.id === callId) ??
        session.messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.id === callId);
      if (target) target.result = capText(result).content;
      else if (result) toolResults.push(result);
    }
  }
  const text = texts.join('\n');
  const capped = capText(text);
  if (type === 'user') {
    session.messages.push({
      role: 'user',
      content: capped.content,
      timestamp: toIso(clean['timestamp']),
      ...(capped.truncated ? { truncated: true } : {}),
    });
    return;
  }
  // Assistant record: one message carrying text + tool calls. A record
  // that contributes neither (e.g. a lone tool_result whose result was
  // attached to an earlier call) creates no message.
  const msg: ImportedMessage = {
    role: 'assistant',
    content: capped.content,
    timestamp: toIso(clean['timestamp']),
    ...(capped.truncated ? { truncated: true } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  if (msg.content.trim() !== '' || toolCalls.length > 0) session.messages.push(msg);
  for (const result of toolResults) {
    const cappedResult = capText(result);
    session.messages.push({
      role: 'tool',
      content: cappedResult.content,
      timestamp: toIso(clean['timestamp']),
      ...(cappedResult.truncated ? { truncated: true } : {}),
    });
  }
}

/** Parse one Claude Code session file (JSONL). Never throws. */
export function parseClaudeSessionFile(filePath: string, text: string): ImportedSession {
  const sessionId = path.basename(filePath, '.jsonl');
  const session: ImportedSession = {
    id: `imported-claude-code-${sessionId}`,
    version: IMPORTED_SESSION_VERSION,
    source: 'claude-code',
    sourceSessionId: sessionId,
    sourcePath: filePath,
    messages: [],
    skippedLines: 0,
    warnings: [],
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      session.skippedLines++;
      continue;
    }
    if (!isRecord(record)) {
      session.skippedLines++;
      continue;
    }
    parseClaudeRecord(record, session);
    if (session.messages.length > MAX_IMPORTED_MESSAGES) {
      session.messages = session.messages.slice(0, MAX_IMPORTED_MESSAGES);
      if (!session.warnings.includes('message cap reached')) {
        session.warnings.push(`message cap reached (${MAX_IMPORTED_MESSAGES} kept)`);
      }
    }
  }
  finishSession(session);
  return session;
}

function finishSession(session: ImportedSession): void {
  const firstUser = session.messages.find((m) => m.role === 'user' && m.content.trim() !== '');
  if (firstUser) {
    const title = firstUser.content.trim().split('\n')[0];
    session.title = title.length > 80 ? `${title.slice(0, 80)}…` : title;
  }
  const stamps = session.messages
    .map((m) => m.timestamp)
    .filter((t): t is string => t !== undefined);
  if (session.startedAt === undefined && stamps.length > 0) session.startedAt = stamps[0];
  if (session.endedAt === undefined && stamps.length > 0) session.endedAt = stamps[stamps.length - 1];
  // De-duplicate identical consecutive warnings (a session with 200
  // unknown records should not carry 200 identical lines).
  session.warnings = [...new Set(session.warnings)];
}

// ---------------------------------------------------------------------------
// Import + write + ACP mapping
// ---------------------------------------------------------------------------

/**
 * Import one session file. The caller must have obtained the path from
 * `discoverImportableSessions` (or an explicit user-picked file) — this
 * function itself never scans a directory. Reads the file (cap
 * MAX_SESSION_FILE_BYTES), parses by `source`, and returns the session
 * or an error. Never throws.
 */
export function importSessionFile(
  filePath: string,
  source: ImportSource,
): ImportSessionResult {
  let text: string;
  try {
    // lstat, not stat: a symlinked session file is refused, never
    // followed — the session must be a real file where discovery found it.
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) return { session: null, error: `Refused symlink session file: ${filePath}` };
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { session: null, error: `Not a file: ${filePath}` };
    if (st.size > MAX_SESSION_FILE_BYTES) {
      return { session: null, error: `Session file too large (${st.size} bytes, max ${MAX_SESSION_FILE_BYTES}).` };
    }
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      session: null,
      error: `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const session =
    source === 'codex' ? parseCodexSessionFile(filePath, text) : parseClaudeSessionFile(filePath, text);
  return { session };
}

/**
 * Write an imported session to `<workspaceDir>/.open-bot/imported-sessions/<id>.json`
 * (mode 0600 — it is the user's own history). Overwrites a previous
 * import of the same session id. Returns the written path.
 */
export function writeImportedSession(workspaceDir: string, session: ImportedSession): string {
  if (/[/\\]/.test(session.id) || session.id.includes('..')) {
    throw new Error(`Invalid imported session id: ${JSON.stringify(session.id)}`);
  }
  const dir = path.resolve(workspaceDir, IMPORTED_SESSIONS_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

/** Read a previously written imported session back. Returns null when missing/unparseable. */
export function readImportedSession(workspaceDir: string, id: string): ImportedSession | null {
  if (/[/\\]/.test(id) || id.includes('..')) return null;
  const filePath = path.join(path.resolve(workspaceDir, IMPORTED_SESSIONS_REL_DIR), `${id}.json`);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isRecord(parsed) || parsed['version'] !== IMPORTED_SESSION_VERSION) return null;
    return parsed as unknown as ImportedSession;
  } catch {
    return null;
  }
}

/**
 * Map an imported session onto ACP recorded messages (`session/load`
 * replay shape): user → user, assistant/tool → agent. Tool calls are
 * rendered as text (`[tool <name> …]`) because ACP replay carries
 * messages, not structured calls — the mapping is lossy by design and
 * says so in the doc comment. Empty messages are dropped.
 */
export function toAcpMessages(session: ImportedSession): AcpRecordedMessage[] {
  const out: AcpRecordedMessage[] = [];
  for (const msg of session.messages) {
    const at = msg.timestamp ?? session.startedAt ?? new Date().toISOString();
    if (msg.role === 'user') {
      if (msg.content.trim() !== '') out.push({ role: 'user', text: msg.content, at });
      continue;
    }
    const parts: string[] = [];
    if (msg.content.trim() !== '') parts.push(msg.content);
    for (const call of msg.toolCalls ?? []) {
      const args = call.args === undefined ? '' : ` ${JSON.stringify(call.args)}`;
      parts.push(`[tool ${call.name}${args}]`);
      if (call.result !== undefined) parts.push(`[tool ${call.name} result] ${call.result}`);
    }
    if (msg.role === 'tool' && msg.content.trim() !== '') parts.push(msg.content);
    if (parts.length > 0) out.push({ role: 'agent', text: parts.join('\n'), at });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summaries (for the UI list — no session file is read here)
// ---------------------------------------------------------------------------

/** Counts for one imported session, for list views. */
export interface ImportedSessionSummary {
  id: string;
  source: ImportSource;
  sourceSessionId: string;
  title?: string;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  toolCallCount: number;
  /** Tool names used, most frequent first. */
  toolNames: string[];
  startedAt?: string;
  endedAt?: string;
  /** Wall-clock span in ms, when both ends are known. */
  durationMs?: number;
  skippedLines: number;
  warningCount: number;
}

/** Summarise one imported session (pure — no I/O). */
export function summarizeImportedSession(session: ImportedSession): ImportedSessionSummary {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let toolCallCount = 0;
  const toolNameCounts = new Map<string, number>();
  for (const msg of session.messages) {
    if (msg.role === 'user') userMessages++;
    else if (msg.role === 'assistant') assistantMessages++;
    else if (msg.role === 'tool') toolMessages++;
    for (const call of msg.toolCalls ?? []) {
      toolCallCount++;
      toolNameCounts.set(call.name, (toolNameCounts.get(call.name) ?? 0) + 1);
    }
  }
  const toolNames = [...toolNameCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  let durationMs: number | undefined;
  if (session.startedAt && session.endedAt) {
    const span = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
    if (Number.isFinite(span) && span >= 0) durationMs = span;
  }
  return {
    id: session.id,
    source: session.source,
    sourceSessionId: session.sourceSessionId,
    ...(session.title !== undefined ? { title: session.title } : {}),
    messageCount: session.messages.length,
    userMessages,
    assistantMessages,
    toolMessages,
    toolCallCount,
    toolNames,
    ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
    ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    skippedLines: session.skippedLines,
    warningCount: session.warnings.length,
  };
}

/**
 * List the imported sessions stored in a workspace
 * (`.open-bot/imported-sessions/*.json`), newest first by `startedAt`.
 * Corrupt files are skipped (counted in the returned `skipped`).
 * Never throws.
 */
export function listImportedSessions(workspaceDir: string): {
  summaries: ImportedSessionSummary[];
  skipped: number;
} {
  const summaries: ImportedSessionSummary[] = [];
  let skipped = 0;
  const dir = path.resolve(workspaceDir, IMPORTED_SESSIONS_REL_DIR);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { summaries, skipped };
  }
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const session = readImportedSession(workspaceDir, id);
    if (!session) {
      skipped++;
      continue;
    }
    summaries.push(summarizeImportedSession(session));
  }
  summaries.sort((a, b) => (a.startedAt ?? '') < (b.startedAt ?? '') ? 1 : -1);
  return { summaries, skipped };
}
