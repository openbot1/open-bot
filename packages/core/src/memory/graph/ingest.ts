/**
 * Cognee-style ingestion — Memory v5 (v1.04, Đội T1).
 *
 * Ý tưởng học từ Cognee (ingest file/repo → chunk → trích
 * entity/relation thành graph, dedup, provenance ghi rõ nguồn) —
 * tự thiết kế lại hoàn toàn cho open-bot, 100% local, không copy
 * code/text/tài sản của bất kỳ repo nào.
 *
 * Kế thừa, không làm lại:
 *  - `RuleBasedFactExtractor` (v0.98) rút fact từ text — ingestion
 *    dùng lại nó (mặc định), không viết extractor mới.
 *  - `TemporalGraphStore.ingestEpisode` (v0.98) đã dedupe episode
 *    theo turnId — mỗi chunk là một episode với turnId
 *    `ingest:<source>:<chunkIndex>` nên ingest lại cùng file không
 *    tạo episode trùng.
 *  - `consolidateCandidates` (v0.98) áp dụng fact ứng viên với
 *    quarantine cho mẫu nghi ngờ — ingestion đi qua nó, không tự
 *    ghi fact thẳng vào store.
 *  - `normalizeGraphText` (v0.98) là chìa khoá dedup.
 *
 * Pipeline một tài liệu:
 *   text → chunk (theo heading markdown / đoạn văn / fence code,
 *   có overlap) → dedup chunk (hash) → extract fact từng chunk →
 *   dedup fact (subject|predicate|object chuẩn hoá) → consolidate
 *   (ADD/UPDATE/DELETE/QUARANTINE/SKIP như đường chat) → report.
 *
 * Provenance: mỗi fact trỏ về episode của chunk đã sinh ra nó
 * (`provenance.sourceText` = câu gốc, `episodeId` = chunk);
 * report ghi rõ `sourceLabel` (file + chunk) cho từng fact, nên
 * luôn truy vết được "fact này từ file nào, đoạn nào".
 *
 * Giới hạn: extractor rule-based chỉ rút được fact diễn đạt theo
 * pattern (thích/sống/làm/...); tài liệu kỹ thuật (code, log) cho
 * ít fact — đó là giới hạn thật của extractor, không phải của
 * pipeline: chunk + entity từ heading vẫn được ghi nhận trong
 * report để host thấy ingestion đã làm gì.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { CandidateFact, GraphFact, MemoryScope } from './types';
import { normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';
import { MAX_EPISODE_TEXT_CHARS } from './store';
import { consolidateCandidates } from './consolidateGraph';
import { RuleBasedFactExtractor } from './extract';
import type { FactExtractor } from './extract';

/** Kích thước chunk mặc định (ký tự). */
export const INGEST_DEFAULT_MAX_CHUNK_CHARS = 2000;
/** Overlap giữa hai chunk kề nhau (ký tự, lấy từ cuối chunk trước). */
export const INGEST_DEFAULT_OVERLAP_CHARS = 200;
/** Số chunk tối đa cho một tài liệu (chặn file khổng lồ). */
export const INGEST_MAX_CHUNKS_PER_DOCUMENT = 500;
/** Số file tối đa cho một lần ingest thư mục. */
export const INGEST_MAX_FILES_PER_DIRECTORY = 200;
/** File lớn hơn từng này byte thì bỏ qua (tránh đọc file rác). */
export const INGEST_MAX_FILE_BYTES = 1_000_000;
/** Thư mục luôn bỏ qua khi đi thư mục. */
export const INGEST_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.open-bot',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);
/** Đuôi file được ingest (mặc định). */
export const INGEST_DEFAULT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.json',
]);

export type IngestSourceKind = 'markdown' | 'text' | 'log' | 'code' | 'json';

/** Một chunk: đơn vị nhỏ nhất được extract + ghi provenance. */
export interface IngestChunk {
  id: string;
  index: number;
  text: string;
  /** Heading markdown gần nhất bao chunk (nếu có). */
  heading?: string;
  startLine: number;
  endLine: number;
  /** Hash nội dung chunk — dùng để dedupe khi ingest lại. */
  hash: string;
}

/** Phát hiện loại nguồn từ đuôi file / nhãn nguồn. */
export function detectSourceKind(sourceLabel: string): IngestSourceKind {
  const lower = (sourceLabel ?? '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.log')) return 'log';
  if (lower.endsWith('.json')) return 'json';
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h)$/.test(lower)) return 'code';
  return 'text';
}

function chunkHash(text: string): string {
  return createHash('sha256').update(normalizeGraphText(text)).digest('hex').slice(0, 16);
}

/**
 * Chia text thành chunk. Ưu tiên biên tự nhiên, theo thứ tự:
 *  1. Heading markdown (`# ...`) — mỗi section là một biên cứng.
 *  2. Khối code fence (``` ... ```) — không bao giờ chẻ đôi.
 *  3. Đoạn văn (cách nhau bằng dòng trống).
 *  4. Đoạn nào vẫn dài hơn maxChars thì chẻ theo dòng, rồi theo
 *     ký tự (cắt ở khoảng trắng gần nhất).
 * Chunk kề nhau overlap `overlapChars` ký tự cuối chunk trước để
 * fact nằm ở biên không bị mất.
 */
export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number; sourceLabel?: string } = {},
): IngestChunk[] {
  const maxChars = Math.min(Math.max(Math.floor(opts.maxChars ?? INGEST_DEFAULT_MAX_CHUNK_CHARS), 200), 20000);
  const overlapChars = Math.min(
    Math.max(Math.floor(opts.overlapChars ?? INGEST_DEFAULT_OVERLAP_CHARS), 0),
    Math.floor(maxChars / 2),
  );
  const sourceLabel = opts.sourceLabel ?? 'text';
  const lines = (text ?? '').split('\n');
  // Bước 1: gom line thành các block theo biên tự nhiên.
  interface Block {
    text: string;
    heading?: string;
    startLine: number;
    endLine: number;
  }
  const blocks: Block[] = [];
  let current: string[] = [];
  let currentStart = 1;
  let currentHeading: string | undefined;
  let inFence = false;
  const flush = (endLine: number) => {
    const joined = current.join('\n').trim();
    if (joined !== '') {
      blocks.push({
        text: joined,
        ...(currentHeading ? { heading: currentHeading } : {}),
        startLine: currentStart,
        endLine,
      });
    }
    current = [];
  };
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (current.length === 0) currentStart = lineNo;
      current.push(line);
      inFence = !inFence;
      return;
    }
    if (inFence) {
      current.push(line);
      return;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flush(idx);
      currentHeading = headingMatch[2]?.trim().slice(0, 200);
      currentStart = lineNo;
      current.push(line);
      return;
    }
    if (trimmed === '') {
      flush(idx);
      currentStart = lineNo + 1;
      return;
    }
    if (current.length === 0) currentStart = lineNo;
    current.push(line);
  });
  flush(lines.length);
  // Bước 2: pack block thành chunk ≤ maxChars (block dài thì chẻ).
  const chunks: IngestChunk[] = [];
  let pending = '';
  let pendingStart = 1;
  let pendingEnd = 1;
  let pendingHeading: string | undefined;
  const emitChunk = (chunkTextContent: string, startLine: number, endLine: number, heading?: string) => {
    const clean = chunkTextContent.trim();
    if (clean === '') return;
    const index = chunks.length;
    chunks.push({
      id: `${sourceLabel}#${index}`,
      index,
      text: clean,
      ...(heading ? { heading } : {}),
      startLine,
      endLine,
      hash: chunkHash(clean),
    });
  };
  const pushBlock = (block: Block) => {
    if (block.text.length > maxChars) {
      // Chẻ block dài theo dòng, rồi theo ký tự nếu một dòng quá dài.
      if (pending !== '') {
        emitChunk(pending, pendingStart, pendingEnd, pendingHeading);
        pending = '';
      }
      let piece = '';
      let pieceStart = block.startLine;
      let pieceEnd = block.startLine;
      for (const line of block.text.split('\n')) {
        if (piece.length + line.length + 1 > maxChars && piece !== '') {
          emitChunk(piece, pieceStart, pieceEnd, block.heading);
          piece = '';
          pieceStart = pieceEnd + 1;
        }
        if (line.length > maxChars) {
          for (let i = 0; i < line.length; i += maxChars - overlapChars) {
            emitChunk(line.slice(i, i + maxChars), pieceStart, pieceEnd, block.heading);
          }
          piece = '';
          continue;
        }
        piece = piece === '' ? line : `${piece}\n${line}`;
        pieceEnd += 1;
      }
      if (piece.trim() !== '') emitChunk(piece, pieceStart, pieceEnd, block.heading);
      return;
    }
    if (pending !== '' && pending.length + block.text.length + 2 > maxChars) {
      emitChunk(pending, pendingStart, pendingEnd, pendingHeading);
      pending = '';
    }
    if (pending === '') {
      pendingStart = block.startLine;
      pendingHeading = block.heading;
    }
    pending = pending === '' ? block.text : `${pending}\n\n${block.text}`;
    pendingEnd = block.endLine;
    if (block.heading) pendingHeading = block.heading;
  };
  for (const block of blocks) pushBlock(block);
  if (pending !== '') emitChunk(pending, pendingStart, pendingEnd, pendingHeading);
  // Bước 3: overlap — nối đuôi chunk trước vào đầu chunk sau.
  if (overlapChars > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      if (!prev || !cur) continue;
      const tail = prev.text.slice(-overlapChars);
      if (tail.trim() !== '' && !cur.text.startsWith(tail.trim())) {
        cur.text = `${tail}\n${cur.text}`;
        cur.hash = chunkHash(cur.text);
      }
    }
  }
  return chunks.slice(0, INGEST_MAX_CHUNKS_PER_DOCUMENT);
}

/** Key dedupe fact: subject|predicate|object đã chuẩn hoá. */
export function ingestCandidateKey(candidate: CandidateFact): string {
  return [
    normalizeGraphText(candidate.subjectName),
    normalizeGraphText(candidate.predicate).replace(/\s+/g, '_'),
    normalizeGraphText(candidate.objectText),
  ].join('|');
}

export interface IngestedFactRef {
  factId: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  /** Chunk đã sinh ra fact (để truy vết nguồn). */
  chunkId: string;
  sourceLabel: string;
}

export interface IngestionReport {
  sourceLabel: string;
  kind: IngestSourceKind;
  ranAt: string;
  chunks: number;
  /** Chunk trùng nội dung đã ingest trước đó (bỏ qua). */
  chunksSkippedDuplicate: number;
  candidates: number;
  /** Ứng viên trùng nhau trong cùng tài liệu (bỏ qua). */
  candidatesDeduped: number;
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  /** Fact đã vào đồ thị (kèm chunk nguồn). */
  facts: IngestedFactRef[];
  /** Entity suy ra từ heading của chunk (chưa chắc đã thành fact). */
  headingEntities: string[];
  details: string[];
}

export interface IngestDocumentOptions {
  scope: MemoryScope;
  /** Nhãn nguồn: tên file / tiêu đề tài liệu (ghi vào provenance). */
  sourceLabel: string;
  /** Extractor (mặc định RuleBasedFactExtractor — không gọi model). */
  extractor?: FactExtractor;
  /** Chunk đã ingest trước đó (hash) — để bỏ qua chunk trùng. */
  knownChunkHashes?: Set<string>;
  /** Bỏ qua consolidate, chỉ extract + dedup (dry-run). */
  dryRun?: boolean;
  maxChars?: number;
  overlapChars?: number;
  /** runId ghi vào provenance (mặc định ''). */
  runId?: string;
  now?: Date;
}

/**
 * Ingest một tài liệu text vào đồ thị. Mỗi chunk là một episode
 * riêng (turnId `ingest:<sourceLabel>:<index>`) nên ingest lại cùng
 * file không tạo episode trùng; fact ứng viên đi qua
 * `consolidateCandidates` như đường chat.
 */
export async function ingestDocument(
  store: TemporalGraphStore,
  text: string,
  opts: IngestDocumentOptions,
): Promise<IngestionReport> {
  const now = opts.now ?? new Date();
  const kind = detectSourceKind(opts.sourceLabel);
  const extractor = opts.extractor ?? new RuleBasedFactExtractor();
  const chunks = chunkText(text, {
    sourceLabel: opts.sourceLabel,
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    ...(opts.overlapChars !== undefined ? { overlapChars: opts.overlapChars } : {}),
  });
  const report: IngestionReport = {
    sourceLabel: opts.sourceLabel,
    kind,
    ranAt: now.toISOString(),
    chunks: chunks.length,
    chunksSkippedDuplicate: 0,
    candidates: 0,
    candidatesDeduped: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    quarantined: 0,
    skipped: 0,
    facts: [],
    headingEntities: [],
    details: [],
  };
  const seenCandidates = new Set<string>();
  const seenHashes = opts.knownChunkHashes ?? new Set<string>();
  for (const chunk of chunks) {
    if (seenHashes.has(chunk.hash)) {
      report.chunksSkippedDuplicate += 1;
      continue;
    }
    seenHashes.add(chunk.hash);
    if (chunk.heading) {
      const heading = chunk.heading.trim();
      if (heading !== '' && !report.headingEntities.includes(heading)) {
        report.headingEntities.push(heading);
      }
    }
    let candidates: CandidateFact[];
    try {
      candidates = await extractor.extract(chunk.text, opts.scope, chunk.text.slice(0, 500));
    } catch {
      report.details.push(`Chunk ${chunk.index}: extractor lỗi — bỏ qua chunk.`);
      report.skipped += 1;
      continue;
    }
    const fresh: CandidateFact[] = [];
    for (const candidate of candidates) {
      report.candidates += 1;
      const key = ingestCandidateKey(candidate);
      if (seenCandidates.has(key)) {
        report.candidatesDeduped += 1;
        continue;
      }
      seenCandidates.add(key);
      fresh.push(candidate);
    }
    if (fresh.length === 0) continue;
    if (opts.dryRun === true) {
      report.details.push(`Chunk ${chunk.index}: dry-run, ${fresh.length} ứng viên chưa ghi.`);
      continue;
    }
    const turnId = `ingest:${opts.sourceLabel}:${chunk.index}`;
    const episode = store.ingestEpisode({
      turnId,
      runId: opts.runId ?? '',
      botId: opts.scope.botId,
      userId: opts.scope.userId,
      role: 'system',
      text: chunk.text,
    });
    const result = consolidateCandidates(
      store,
      fresh,
      opts.scope,
      { turnId, runId: opts.runId ?? '', episodeId: episode.id, at: now.toISOString() },
    );
    report.added += result.added;
    report.updated += result.updated;
    report.deleted += result.deleted;
    report.quarantined += result.quarantined;
    report.skipped += result.skipped;
    for (const action of result.actions) {
      if ((action.decision === 'ADD' || action.decision === 'UPDATE') && action.factId) {
        report.facts.push({
          factId: action.factId,
          subjectName: action.candidate.subjectName,
          predicate: action.candidate.predicate,
          objectText: action.candidate.objectText,
          chunkId: chunk.id,
          sourceLabel: opts.sourceLabel,
        });
      }
    }
    report.details.push(...result.details);
  }
  if (report.facts.length === 0 && report.candidates === 0) {
    report.details.push(
      `Không rút được fact nào từ ${opts.sourceLabel} — extractor rule-based chỉ nhận diện được fact diễn đạt theo pattern (thích/sống/làm/...); tài liệu kỹ thuật cần LLM extractor (interface FactExtractor đã có).`,
    );
  }
  return report;
}

export interface IngestFileOptions extends Omit<IngestDocumentOptions, 'sourceLabel'> {
  /** Đọc tối đa từng này byte (mặc định 1MB). */
  maxBytes?: number;
}

/** Ingest một file từ đĩa (đọc UTF-8, bỏ qua file nhị phân). */
export async function ingestFile(
  store: TemporalGraphStore,
  filePath: string,
  opts: IngestFileOptions,
): Promise<IngestionReport> {
  const maxBytes = opts.maxBytes ?? INGEST_MAX_FILE_BYTES;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Không đọc được file: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`Không phải file: ${filePath}`);
  if (stat.size > maxBytes) {
    throw new Error(`File quá lớn (${stat.size} byte > ${maxBytes}) — bỏ qua.`);
  }
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    throw new Error(`Không đọc được file: ${filePath}`);
  }
  // File nhị phân (byte NUL) thì không phải text — bỏ qua.
  if (raw.includes(0)) throw new Error(`File không phải text (chứa byte NUL): ${filePath}`);
  const text = raw.toString('utf8');
  const label = path.basename(filePath);
  return ingestDocument(store, text, { ...opts, sourceLabel: label });
}

export interface IngestDirectoryOptions extends Omit<IngestFileOptions, 'sourceLabel'> {
  /** Đuôi file cho phép (mặc định INGEST_DEFAULT_EXTENSIONS). */
  extensions?: Set<string>;
  /** Số file tối đa (mặc định 200). */
  maxFiles?: number;
  /** Đệ quy vào thư mục con (mặc định true). */
  recursive?: boolean;
}

export interface IngestDirectoryReport {
  dir: string;
  ranAt: string;
  filesSeen: number;
  filesIngested: number;
  filesSkipped: string[];
  reports: IngestionReport[];
  totals: { chunks: number; candidates: number; added: number; updated: number; quarantined: number; skipped: number };
}

/** Một turn trong transcript chat (`User: ...` / `Assistant: ...`). */
export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Số thứ tự turn trong transcript (bắt đầu 0). */
  index: number;
}

/** Parse transcript text thành các turn. Dòng bắt đầu bằng
 *  `User:` / `Assistant:` / `System:` (không phân biệt hoa thường,
 *  chấp nhận cả `Huy:` / `Bot:`) mở turn mới; các dòng sau nối vào
 *  turn đang mở. Dòng không khớp mẫu nào trước turn đầu tiên thì
 *  thành turn `user` đầu tiên. */
export function parseChatTranscript(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  const roleOf = (line: string): { role: TranscriptTurn['role']; rest: string } | null => {
    const m = /^(user|assistant|system|huy|bot|ai)\s*:\s*(.*)$/iu.exec(line.trim());
    if (!m) return null;
    const label = (m[1] ?? '').toLowerCase();
    const role: TranscriptTurn['role'] =
      label === 'assistant' || label === 'bot' || label === 'ai'
        ? 'assistant'
        : label === 'system'
          ? 'system'
          : 'user';
    return { role, rest: m[2] ?? '' };
  };
  for (const rawLine of (text ?? '').split('\n')) {
    const parsed = roleOf(rawLine);
    if (parsed) {
      if (current) turns.push(current);
      current = { role: parsed.role, text: parsed.rest, index: turns.length };
      continue;
    }
    if (!current) {
      current = { role: 'user', text: rawLine, index: 0 };
    } else {
      current.text += `\n${rawLine}`;
    }
  }
  if (current) turns.push(current);
  return turns
    .map((t) => ({ ...t, text: t.text.trim() }))
    .filter((t) => t.text !== '');
}

export interface IngestTranscriptOptions {
  scope: MemoryScope;
  /** Nhãn nguồn: tên file export / tiêu đề cuộc trò chuyện. */
  sourceLabel: string;
  extractor?: FactExtractor;
  runId?: string;
  now?: Date;
  /** Chỉ ingest turn của role này (mặc định: mọi role). */
  roles?: Array<'user' | 'assistant' | 'system'>;
}

export interface IngestTranscriptReport {
  sourceLabel: string;
  ranAt: string;
  turns: number;
  turnsIngested: number;
  turnsSkippedDuplicate: number;
  candidates: number;
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  facts: IngestedFactRef[];
  details: string[];
}

/**
 * Ingest một transcript chat: mỗi turn là một episode riêng
 * (turnId `transcript:<sourceLabel>:<index>`, dedupe theo turnId
 * nên ingest lại cùng export không tạo episode trùng), extract +
 * consolidate từng turn như đường chat. Khác `ingestDocument` ở
 * chỗ không chunk theo heading — turn đã là đơn vị tự nhiên.
 */
export async function ingestTranscript(
  store: TemporalGraphStore,
  text: string,
  opts: IngestTranscriptOptions,
): Promise<IngestTranscriptReport> {
  const now = opts.now ?? new Date();
  const extractor = opts.extractor ?? new RuleBasedFactExtractor();
  const turns = parseChatTranscript(text).filter(
    (t) => !opts.roles || opts.roles.includes(t.role),
  );
  const report: IngestTranscriptReport = {
    sourceLabel: opts.sourceLabel,
    ranAt: now.toISOString(),
    turns: turns.length,
    turnsIngested: 0,
    turnsSkippedDuplicate: 0,
    candidates: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    quarantined: 0,
    skipped: 0,
    facts: [],
    details: [],
  };
  for (const turn of turns) {
    const turnId = `transcript:${opts.sourceLabel}:${turn.index}`;
    const candidates = await extractor.extract(turn.text, opts.scope, turn.text.slice(0, 500));
    report.candidates += candidates.length;
    if (candidates.length === 0) continue;
    const episode = store.ingestEpisode({
      turnId,
      runId: opts.runId ?? '',
      botId: opts.scope.botId,
      userId: opts.scope.userId,
      role: turn.role,
      text: turn.text.slice(0, MAX_EPISODE_TEXT_CHARS),
    });
    if (episode.duplicate) {
      report.turnsSkippedDuplicate += 1;
      continue;
    }
    report.turnsIngested += 1;
    const result = consolidateCandidates(
      store,
      candidates,
      opts.scope,
      { turnId, runId: opts.runId ?? '', episodeId: episode.id, at: now.toISOString() },
    );
    report.added += result.added;
    report.updated += result.updated;
    report.deleted += result.deleted;
    report.quarantined += result.quarantined;
    report.skipped += result.skipped;
    for (const action of result.actions) {
      if ((action.decision === 'ADD' || action.decision === 'UPDATE') && action.factId) {
        report.facts.push({
          factId: action.factId,
          subjectName: action.candidate.subjectName,
          predicate: action.candidate.predicate,
          objectText: action.candidate.objectText,
          chunkId: turnId,
          sourceLabel: opts.sourceLabel,
        });
      }
    }
    report.details.push(...result.details);
  }
  return report;
}

/** Ingest cả thư mục: đi file theo thứ tự tên, bỏ qua thư mục hệ thống. */
export async function ingestDirectory(
  store: TemporalGraphStore,
  dir: string,
  opts: IngestDirectoryOptions,
): Promise<IngestDirectoryReport> {
  const extensions = opts.extensions ?? INGEST_DEFAULT_EXTENSIONS;
  const maxFiles = Math.min(Math.max(Math.floor(opts.maxFiles ?? INGEST_MAX_FILES_PER_DIRECTORY), 1), 1000);
  const recursive = opts.recursive !== false;
  const report: IngestDirectoryReport = {
    dir,
    ranAt: (opts.now ?? new Date()).toISOString(),
    filesSeen: 0,
    filesIngested: 0,
    filesSkipped: [],
    reports: [],
    totals: { chunks: 0, candidates: 0, added: 0, updated: 0, quarantined: 0, skipped: 0 },
  };
  const walk = (current: string, depth: number): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < 10 && !INGEST_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          files.push(...walk(full, depth + 1));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      report.filesSeen += 1;
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(full);
    }
    return files;
  };
  const files = walk(dir, 0).slice(0, maxFiles);
  const sharedHashes = opts.knownChunkHashes ?? new Set<string>();
  for (const file of files) {
    try {
      const one = await ingestFile(store, file, { ...opts, knownChunkHashes: sharedHashes });
      report.filesIngested += 1;
      report.reports.push(one);
      report.totals.chunks += one.chunks;
      report.totals.candidates += one.candidates;
      report.totals.added += one.added;
      report.totals.updated += one.updated;
      report.totals.quarantined += one.quarantined;
      report.totals.skipped += one.skipped;
    } catch (err) {
      report.filesSkipped.push(`${file}: ${(err as Error).message}`);
    }
  }
  return report;
}
