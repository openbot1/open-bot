/**
 * Reasoning-block persistence (v1.29, Đội T3 — coding agent v14).
 *
 * Khối suy luận (thinking / reasoning_content / plan / self_critique)
 * là dữ liệu của run: phải lưu bền, replay được, và khôi phục khi
 * resume session — không mất khi ngắt giữa chừng.
 *
 * Thiết kế 2 lớp (không tin một lớp duy nhất):
 * - Sidecar JSONL (`<dataDir>/<runId>.reasoning.jsonl`): giữ FULL TEXT
 *   của mọi block, append-only, mỗi dòng một block kèm hash chain
 *   (seq + prevHash + hash SHA-256). Đọc lại là replay: rebuild đúng
 *   thứ tự block, verify chain để phát hiện file bị sửa/tụt dòng.
 * - Digest event trong run log chung (`reasoning.block`, xem
 *   `eventLogAdapter.ts`): chỉ mang blockId/step/kind/chars/sha256/
 *   excerpt ngắn — vừa đủ để audit + đối chiếu với sidecar, không
 *   mang full text (run log chung sanitize cắt chuỗi 2000 ký tự và
 *   không phải chỗ giữ nội dung dài).
 *
 * Secret trong text (API key, token) được redact trước khi ghi —
 * cùng họ pattern với `sanitize.ts` của event-log (sk-*, ghp_*,
 * AKIA*, `api_key=...`, `Bearer ...`) — và block được đánh dấu
 * `redacted: true` để caller biết nội dung đã đổi.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV14Error, V14_TOKEN_CHARS_PER_TOKEN } from './types';
import type {
  V14NewReasoningBlock,
  V14ReasoningBlock,
  V14ReasoningChainReport,
  V14ReasoningKind,
  V14ReasoningResumeState,
} from './types';

/** Hash chain genesis của sidecar reasoning (block đầu có prevHash này). */
export const V14_REASONING_GENESIS = 'v14-reasoning-genesis';

/** Suffix file sidecar reasoning của một run. */
export const V14_REASONING_SUFFIX = '.reasoning.jsonl';

/** Số block gần nhất mà resume trả về mặc định. */
export const V14_RESUME_RECENT_BLOCKS = 10;

/** Ước lượng token của một đoạn text (4 ký tự ≈ 1 token, giống event-log). */
export function v14EstimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / V14_TOKEN_CHARS_PER_TOKEN));
}

/** SHA-256 hex của một chuỗi (utf8). */
export function v14Sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Id ổn định cho một block mới. */
export function v14NewBlockId(runId: string, step: number, n: number): string {
  return `rb-${runId}-${step}-${n}`;
}

/** Các pattern secret cần redact khỏi reasoning text trước khi ghi. */
const V14_SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /\b(?:sk-ant|sk|xai)-[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED-KEY]' },
  { re: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{8,}\b/g, replacement: '[REDACTED-TOKEN]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED-KEY]' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/g, replacement: 'Bearer [REDACTED]' },
  {
    re: /\b(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._/-]{8,}['"]?/gi,
    replacement: '$1=[REDACTED]',
  },
];

/**
 * Redact secret trong text. Trả `{ text, redacted }` — `redacted` true
 * khi có ít nhất một pattern khớp (kể cả khi replacement giống hệt,
 * caller vẫn biết block đã qua xử lý).
 */
export function v14RedactText(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const { re, replacement } of V14_SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) redacted = true;
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return { text: out, redacted };
}

/** Nội dung chuẩn hoá để hash một block (ổn định, không phụ thuộc thứ tự key). */
export function v14BlockHashInput(block: {
  id: string;
  runId: string;
  step: number;
  kind: V14ReasoningKind;
  text: string;
  createdAt: string;
  seq: number;
  prevHash: string;
}): string {
  return JSON.stringify([
    block.id,
    block.runId,
    block.step,
    block.kind,
    block.text,
    block.createdAt,
    block.seq,
    block.prevHash,
  ]);
}

/** Hash của một block (tính trên nội dung đã chuẩn hoá). */
export function v14HashBlock(block: {
  id: string;
  runId: string;
  step: number;
  kind: V14ReasoningKind;
  text: string;
  createdAt: string;
  seq: number;
  prevHash: string;
}): string {
  return v14Sha256(v14BlockHashInput(block));
}

/** Tên file sidecar reasoning của một run (chống path traversal). */
export function v14ReasoningFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'run';
  return `${safe}${V14_REASONING_SUFFIX}`;
}

/** Tuỳ chọn của `V14ReasoningStore`. */
export interface V14ReasoningStoreOptions {
  /** Thư mục chứa sidecar JSONL. Undefined = chỉ giữ trong memory (không ghi đĩa). */
  dataDir?: string;
  /** Ghi đè thời điểm tạo block — chủ yếu cho test determinism. */
  now?: () => string;
}

/**
 * Store khối suy luận của nhiều run (mỗi run một file sidecar JSONL).
 * Append-only: không bao giờ sửa dòng cũ; prune chỉ viết lại file qua
 * `writePruned` một cách tường minh (kèm dòng tombstone ghi rõ đã prune).
 */
export class V14ReasoningStore {
  private readonly dataDir: string | undefined;
  private readonly now: () => string;
  /** Block trong memory, theo runId (đã load từ đĩa hoặc mới append). */
  private readonly blocksByRun = new Map<string, V14ReasoningBlock[]>();
  /** Run nào đã load từ đĩa (tránh đọc lại nhiều lần). */
  private readonly loaded = new Set<string>();

  constructor(options: V14ReasoningStoreOptions = {}) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.dataDir) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /** Đường dẫn file sidecar của một run (null khi memory-only). */
  filePath(runId: string): string | null {
    if (!this.dataDir) return null;
    return path.join(this.dataDir, v14ReasoningFileName(runId));
  }

  /** Đọc sidecar từ đĩa vào memory (idempotent; file không có = run mới). */
  load(runId: string): V14ReasoningBlock[] {
    if (this.loaded.has(runId)) return [...(this.blocksByRun.get(runId) ?? [])];
    const file = this.filePath(runId);
    const blocks: V14ReasoningBlock[] = [];
    if (file && fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (isV14ReasoningBlock(parsed)) blocks.push(parsed);
        } catch {
          // Dòng hỏng: bỏ qua (sidecar vẫn replay được phần còn lại);
          // verify() sẽ báo chain broken nếu hash không khớp.
        }
      }
    }
    blocks.sort((a, b) => a.seq - b.seq);
    this.blocksByRun.set(runId, blocks);
    this.loaded.add(runId);
    return [...blocks];
  }

  /** Mọi block của một run (theo seq tăng dần). */
  blocks(runId: string): V14ReasoningBlock[] {
    return this.load(runId);
  }

  /**
   * Nạp block đã lưu từ trước vào memory (dùng khi resume từ
   * `V14ResumeState` mà không có dataDir — vd chạy tiếp trong cùng
   * tiến trình test). Block được sắp theo seq; block trùng id với
   * block đã có thì bỏ qua. Không ghi lại đĩa.
   */
  importBlocks(blocks: V14ReasoningBlock[]): void {
    if (blocks.length === 0) return;
    const runId = blocks[0]!.runId;
    const existing = this.load(runId);
    const ids = new Set(existing.map((b) => b.id));
    const fresh = blocks.filter((b) => b.runId === runId && !ids.has(b.id));
    if (fresh.length === 0) return;
    const merged = [...existing, ...fresh].sort((a, b) => a.seq - b.seq);
    this.blocksByRun.set(runId, merged);
  }

  /** Các block của một step cụ thể. */
  blocksForStep(runId: string, step: number): V14ReasoningBlock[] {
    return this.load(runId).filter((b) => b.step === step);
  }

  /** N block gần nhất của một run (mặc định 10). */
  latestBlocks(runId: string, n: number = V14_RESUME_RECENT_BLOCKS): V14ReasoningBlock[] {
    const all = this.load(runId);
    return all.slice(Math.max(0, all.length - n));
  }

  /** Các block được ghim của một run. */
  pinnedBlocks(runId: string): V14ReasoningBlock[] {
    return this.load(runId).filter((b) => b.pinned);
  }

  /**
   * Ghi một block mới: redact secret, tính sha256 text + hash chain,
   * append vào memory và (nếu có dataDir) append một dòng JSONL + fsync.
   * Ném `CodingV14Error` khi text rỗng hoặc runId/step không hợp lệ.
   */
  record(input: V14NewReasoningBlock): V14ReasoningBlock {
    if (!input.runId || input.runId.trim() === '') {
      throw new CodingV14Error('reasoning-invalid', 'runId must be a non-empty string.');
    }
    if (!Number.isInteger(input.step) || input.step < 0) {
      throw new CodingV14Error('reasoning-invalid', 'step must be a non-negative integer.');
    }
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new CodingV14Error('reasoning-invalid', 'reasoning text must be a non-empty string.');
    }
    const existing = this.load(input.runId);
    const seq = existing.length + 1;
    const prevHash = existing.length === 0 ? V14_REASONING_GENESIS : existing[existing.length - 1]!.hash;
    const { text, redacted } = v14RedactText(input.text);
    const createdAt = input.createdAt ?? this.now();
    const id = v14NewBlockId(input.runId, input.step, seq);
    const base = {
      id,
      runId: input.runId,
      step: input.step,
      kind: input.kind,
      text,
      createdAt,
      seq,
      prevHash,
    };
    const block: V14ReasoningBlock = {
      ...base,
      ...(input.model ? { model: input.model } : {}),
      chars: text.length,
      sha256: v14Sha256(text),
      redacted,
      pinned: input.pinned ?? false,
      hash: v14HashBlock(base),
    };
    existing.push(block);
    this.blocksByRun.set(input.runId, existing);
    const file = this.filePath(input.runId);
    if (file) {
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, `${JSON.stringify(block)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return block;
  }

  /** Shortcut ghi khối `thinking`. */
  recordThinking(runId: string, step: number, text: string, model?: string): V14ReasoningBlock {
    return this.record({ runId, step, kind: 'thinking', text, ...(model ? { model } : {}) });
  }

  /** Shortcut ghi khối `reasoning_content`. */
  recordReasoningContent(runId: string, step: number, text: string, model?: string): V14ReasoningBlock {
    return this.record({ runId, step, kind: 'reasoning_content', text, ...(model ? { model } : {}) });
  }

  /**
   * Verify hash chain của một run: hash từng block + prevHash nối tiếp
   * + sha256 của text. Trả báo cáo (không throw) để caller quyết định.
   */
  verify(runId: string): V14ReasoningChainReport {
    const blocks = this.load(runId);
    let expectedPrev = V14_REASONING_GENESIS;
    for (const block of blocks) {
      if (block.prevHash !== expectedPrev) {
        return { runId, blocks: blocks.length, ok: false, brokenAtSeq: block.seq, reason: `prevHash mismatch at seq ${block.seq}` };
      }
      if (block.hash !== v14HashBlock(block)) {
        return { runId, blocks: blocks.length, ok: false, brokenAtSeq: block.seq, reason: `hash mismatch at seq ${block.seq}` };
      }
      if (block.sha256 !== v14Sha256(block.text)) {
        return { runId, blocks: blocks.length, ok: false, brokenAtSeq: block.seq, reason: `text sha256 mismatch at seq ${block.seq}` };
      }
      if (block.chars !== block.text.length) {
        return { runId, blocks: blocks.length, ok: false, brokenAtSeq: block.seq, reason: `chars mismatch at seq ${block.seq}` };
      }
      expectedPrev = block.hash;
    }
    return { runId, blocks: blocks.length, ok: true, brokenAtSeq: 0, reason: '' };
  }

  /**
   * Trạng thái resume của một run: step lớn nhất, tổng block, block
   * gần nhất + block ghim — đủ để agent tiếp tục mà không nạp toàn bộ
   * history vào context.
   */
  resumeState(runId: string, keepLast: number = V14_RESUME_RECENT_BLOCKS): V14ReasoningResumeState {
    const blocks = this.load(runId);
    const lastStep = blocks.length === 0 ? 0 : Math.max(...blocks.map((b) => b.step));
    return {
      runId,
      lastStep,
      totalBlocks: blocks.length,
      recentBlocks: blocks.slice(Math.max(0, blocks.length - keepLast)),
      pinnedBlocks: blocks.filter((b) => b.pinned),
    };
  }

  /**
   * Prune trong memory: giữ `keepLast` block gần nhất + mọi block ghim
   * (không xoá file đĩa). Trả danh sách còn lại — caller tự quyết có
   * gọi `writePruned` để ghi đè file hay không.
   */
  prune(runId: string, keepLast: number): V14ReasoningBlock[] {
    const blocks = this.load(runId);
    if (keepLast < 0) throw new CodingV14Error('reasoning-invalid', 'keepLast must be >= 0.');
    if (blocks.length <= keepLast) return [...blocks];
    const tail = blocks.slice(blocks.length - keepLast);
    const tailIds = new Set(tail.map((b) => b.id));
    const kept = blocks.filter((b) => b.pinned || tailIds.has(b.id));
    kept.sort((a, b) => a.seq - b.seq);
    return kept;
  }

  /**
   * Ghi đè file sidecar bằng danh sách đã prune (kèm dòng tombstone
   * ghi rõ số block đã bỏ — lịch sử prune vẫn audit được). Chỉ dùng
   * khi caller đã xác nhận; memory cũng được cập nhật theo.
   */
  writePruned(runId: string, kept: V14ReasoningBlock[]): { kept: number; dropped: number } {
    const file = this.filePath(runId);
    const before = this.load(runId).length;
    if (!file) {
      this.blocksByRun.set(runId, [...kept]);
      return { kept: kept.length, dropped: before - kept.length };
    }
    const tombstone = JSON.stringify({
      prunedAt: this.now(),
      dropped: before - kept.length,
      kept: kept.length,
      note: 'v14 reasoning prune tombstone (append-only history preserved in run log digests)',
    });
    const body = kept.map((b) => JSON.stringify(b)).join('\n');
    fs.writeFileSync(file, `${tombstone}\n${body === '' ? '' : `${body}\n`}`, 'utf8');
    this.blocksByRun.set(runId, [...kept]);
    return { kept: kept.length, dropped: before - kept.length };
  }

  /** Tổng token ước lượng của mọi block trong một run (đo thật trên text). */
  totalTokens(runId: string): number {
    return this.load(runId).reduce((sum, b) => sum + v14EstimateTokens(b.text), 0);
  }

  /** Digest payload để ghi event `reasoning.block` vào run log chung. */
  digestFor(block: V14ReasoningBlock): {
    blockId: string;
    step: number;
    kind: V14ReasoningKind;
    chars: number;
    sha256: string;
    excerpt: string;
    model?: string;
  } {
    return {
      blockId: block.id,
      step: block.step,
      kind: block.kind,
      chars: block.chars,
      sha256: block.sha256,
      excerpt: block.text.slice(0, 200),
      ...(block.model ? { model: block.model } : {}),
    };
  }
}

/** Type guard cho một dòng sidecar parse từ JSON. */
export function isV14ReasoningBlock(value: unknown): value is V14ReasoningBlock {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['runId'] === 'string' &&
    typeof v['step'] === 'number' &&
    typeof v['kind'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['chars'] === 'number' &&
    typeof v['sha256'] === 'string' &&
    typeof v['redacted'] === 'boolean' &&
    typeof v['pinned'] === 'boolean' &&
    typeof v['seq'] === 'number' &&
    typeof v['prevHash'] === 'string' &&
    typeof v['hash'] === 'string'
  );
}

/** Render ngắn một block để hiển thị/log (không mang full text). */
export function renderV14ReasoningBlockSummary(block: V14ReasoningBlock): string {
  return `[${block.kind} step ${block.step} #${block.seq} ${block.chars} chars sha256=${block.sha256.slice(0, 12)}${block.redacted ? ' redacted' : ''}${block.pinned ? ' pinned' : ''}]`;
}
