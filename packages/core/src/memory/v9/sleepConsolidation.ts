/**
 * Memory v9 kiểu Letta — sleep-time consolidation (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta (sleep-time compute: khi bot rảnh / giữa các
 * phiên, agent tự dọn dẹp và cô đọng memory của chính nó), viết lại
 * hoàn toàn cho open-bot, chạy local, không gọi model:
 *
 * Một "sleep pass" (chạy tay qua tool/UI, hoặc daemon v9 gọi khi idle)
 * làm 4 bước, mỗi bước đều ghi log những gì đã làm:
 *
 *  1. PRUNE RECALL: cắt phiên recall quá 90 ngày / vượt 500 phiên.
 *  2. CONDENSE SESSIONS: phiên cũ (hết 7 ngày) chưa có fact archival
 *     thì trích fact từ summary của nó (tách summary thành câu, mỗi
 *     câu đủ dài thành một fact) rồi đưa vào archival (dedupe theo
 *     text trùng — insert đã tự dedupe).
 *  3. DEDUPE ARCHIVAL: mục archival trùng nhau (Jaccard >= 0.75 trên
 *     text) thì giữ mục cũ nhất/điểm cao nhất, xoá mục còn lại.
 *  4. PROPOSE CORE UPDATES: từ fact archival mới tạo (hoặc fact do
 *     caller đưa vào), sinh proposal cập nhật core block — KHÔNG tự
 *     ghi đè block, user/agent quyết định sau.
 *
 * Kết quả trả về SleepPassReport đầy đủ số liệu + log từng bước, để
 * tool/UI hiển thị và để daemon v9 ghi vào run log của nó.
 *
 * Không phá API cũ: pass này chỉ đọc/ghi qua RecallStore /
 * ArchivalStore / SleepProposalStore / CoreMemoryManager — không đụng
 * tới SleepV9Agent hay SleepV8Scheduler.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RecallStore } from './recall';
import { ArchivalStore } from './archival';
import { SleepProposalStore } from './sleepProposals';
import { condenseWords, jaccardSimilarity, splitSentences } from './condense';

/** File log các sleep pass Letta (JSONL append-only). */
export const V9_LETTA_SLEEP_LOG_REL_PATH = path.join('.open-bot', 'memory-v9-letta-sleep-log.jsonl');
/** Phiên recall cũ hơn bấy nhiêu ngày thì được trích fact vào archival. */
export const V9_LETTA_SESSION_FACT_AGE_DAYS = 7;
/** Câu trong summary ngắn hơn bấy nhiêu ký tự thì không thành fact. */
export const V9_LETTA_MIN_FACT_CHARS = 20;
/** Jaccard: hai mục archival giống nhau trên mức này thì coi là trùng. */
export const V9_LETTA_ARCHIVAL_DUP_JACCARD = 0.75;
/** Số dòng log tối đa giữ khi đọc (cũ hơn bị cắt khi đọc). */
export const V9_LETTA_SLEEP_LOG_KEEP = 200;

/** Kết quả một bước trong sleep pass. */
export interface SleepPassStepResult {
  step: 'prune-recall' | 'condense-sessions' | 'dedupe-archival' | 'propose-core-updates';
  ok: boolean;
  detail: string;
  ms: number;
}

/** Báo cáo đầy đủ của một sleep pass Letta. */
export interface SleepPassReport {
  id: string;
  botId: string;
  at: string;
  dryRun: boolean;
  durationMs: number;
  sessionsPruned: number;
  sessionsCondensed: number;
  factsExtracted: number;
  factsStored: number;
  archivalDuplicatesRemoved: number;
  proposalsCreated: number;
  proposalsSkippedDuplicate: number;
  steps: SleepPassStepResult[];
  errors: string[];
}

/** Tuỳ chọn chạy sleep pass. */
export interface SleepPassOptions {
  /** true = chỉ tính toán, không ghi gì (để xem trước). */
  dryRun?: boolean;
  /** Fact do caller đưa thêm (vd fact trích bởi SleepTimeAgent v0.97). */
  extraFacts?: Array<{ text: string; source: string; confidence?: number }>;
  /** Bỏ qua bước đề xuất core update. */
  skipProposals?: boolean;
}

/** Lỗi sleep pass — message tiếng Việt. */
export class SleepPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SleepPassError';
  }
}

/**
 * Trích fact từ tóm tắt phiên: tách summary thành câu, câu nào đủ dài
 * và có đủ từ nội dung thì thành một fact. Fact là câu gốc (không bịa).
 */
export function extractFactsFromSummary(
  summary: string,
  source: string,
): Array<{ text: string; source: string; confidence: number }> {
  const sentences = splitSentences(summary ?? '');
  const out: Array<{ text: string; source: string; confidence: number }> = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    const text = s.text.trim();
    if (text.length < V9_LETTA_MIN_FACT_CHARS) continue;
    if (s.words.size < 3) continue;
    const key = [...s.words].sort().join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, source, confidence: 0.6 });
  }
  return out;
}

/**
 * Chạy một sleep pass Letta cho một bot. Mỗi bước được bọc try/catch
 * riêng — bước nào lỗi thì ghi vào errors, các bước còn lại vẫn chạy.
 */
export function runLettaSleepPass(
  workspaceDir: string,
  botId: string,
  opts: SleepPassOptions = {},
): SleepPassReport {
  const started = Date.now();
  const dryRun = opts.dryRun === true;
  const report: SleepPassReport = {
    id: `letta-sleep-${started}-${Math.floor(Math.random() * 10000)}`,
    botId,
    at: new Date().toISOString(),
    dryRun,
    durationMs: 0,
    sessionsPruned: 0,
    sessionsCondensed: 0,
    factsExtracted: 0,
    factsStored: 0,
    archivalDuplicatesRemoved: 0,
    proposalsCreated: 0,
    proposalsSkippedDuplicate: 0,
    steps: [],
    errors: [],
  };
  const recall = new RecallStore(workspaceDir);
  const archival = new ArchivalStore(workspaceDir);
  const proposals = new SleepProposalStore(workspaceDir);

  const runStep = (
    step: SleepPassStepResult['step'],
    fn: () => string,
  ): void => {
    const t0 = Date.now();
    try {
      const detail = fn();
      report.steps.push({ step, ok: true, detail, ms: Date.now() - t0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push(`${step}: ${message}`);
      report.steps.push({ step, ok: false, detail: `Lỗi: ${message}`, ms: Date.now() - t0 });
    }
  };

  // Bước 1: prune recall (cắt phiên quá hạn / vượt dung lượng).
  runStep('prune-recall', () => {
    if (dryRun) {
      const all = recall.readAll();
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const stale = all.filter((s) => new Date(s.endedAt).getTime() < cutoff).length;
      const over = Math.max(0, all.length - 500);
      return `Dry-run: sẽ cắt ${stale + over} phiên recall cũ/vượt dung lượng.`;
    }
    const removed = recall.prune();
    report.sessionsPruned = removed;
    return `Đã cắt ${removed} phiên recall cũ/vượt dung lượng.`;
  });

  // Bước 2: condense phiên cũ thành fact archival.
  runStep('condense-sessions', () => {
    const cutoff = Date.now() - V9_LETTA_SESSION_FACT_AGE_DAYS * 24 * 60 * 60 * 1000;
    const sessions = recall.readAll().filter((s) => s.botId === botId);
    const existingArchival = archival.readAll();
    const existingTexts = new Set(existingArchival.map((it) => it.text));
    const facts: Array<{ text: string; source: string; confidence: number }> = [];
    let condensed = 0;
    for (const session of sessions) {
      if (new Date(session.endedAt).getTime() >= cutoff) continue;
      const sessionFacts = extractFactsFromSummary(session.summary, `session:${session.sessionId}`);
      if (sessionFacts.length === 0) continue;
      condensed += 1;
      for (const fact of sessionFacts) {
        if (existingTexts.has(fact.text)) continue;
        facts.push(fact);
      }
    }
    report.sessionsCondensed = condensed;
    report.factsExtracted = facts.length;
    if (!dryRun) {
      let stored = 0;
      for (const fact of facts) {
        archival.insert({ text: fact.text, source: 'session', sourceId: fact.source, confidence: fact.confidence });
        stored += 1;
      }
      report.factsStored = stored;
    }
    return dryRun
      ? `Dry-run: sẽ trích ${facts.length} fact từ ${condensed} phiên cũ.`
      : `Đã trích ${facts.length} fact từ ${condensed} phiên cũ, lưu ${report.factsStored} fact mới vào archival.`;
  });

  // Bước 3: dedupe archival (giữ mục cũ nhất/điểm cao nhất).
  runStep('dedupe-archival', () => {
    const items = archival.readAll();
    const toDelete: string[] = [];
    const kept: Array<{ words: Set<string> }> = [];
    for (const item of items) {
      const words = condenseWords(item.text);
      // Trùng với một mục đã giữ (giữ mục gặp trước = mục cũ nhất vì
      // file archival ghi theo thứ tự tạo) thì xoá mục hiện tại.
      const dup = kept.some((k) => jaccardSimilarity(words, k.words) >= V9_LETTA_ARCHIVAL_DUP_JACCARD);
      if (dup) {
        toDelete.push(item.id);
        continue;
      }
      kept.push({ words });
    }
    report.archivalDuplicatesRemoved = toDelete.length;
    if (!dryRun) {
      for (const id of toDelete) archival.delete(id);
    }
    return dryRun
      ? `Dry-run: sẽ xoá ${toDelete.length} mục archival trùng lặp.`
      : `Đã xoá ${toDelete.length} mục archival trùng lặp.`;
  });

  // Bước 4: đề xuất cập nhật core block từ fact mới + fact caller đưa.
  runStep('propose-core-updates', () => {
    if (opts.skipProposals === true) return 'Bỏ qua bước đề xuất core update theo tuỳ chọn.';
    const cutoff = Date.now() - V9_LETTA_SESSION_FACT_AGE_DAYS * 24 * 60 * 60 * 1000;
    const sessions = recall.readAll().filter((s) => s.botId === botId);
    const facts: Array<{ text: string; source: string; confidence?: number }> = [];
    for (const session of sessions) {
      if (new Date(session.endedAt).getTime() >= cutoff) continue;
      for (const fact of extractFactsFromSummary(session.summary, `session:${session.sessionId}`)) {
        facts.push(fact);
      }
    }
    for (const extra of opts.extraFacts ?? []) facts.push(extra);
    if (facts.length === 0) return 'Không có fact nào để đề xuất core update.';
    if (dryRun) {
      return `Dry-run: sẽ đề xuất core update từ ${facts.length} fact.`;
    }
    const result = proposals.generateForBot(botId, facts);
    report.proposalsCreated = result.created.length;
    report.proposalsSkippedDuplicate = result.skippedDuplicate;
    return (
      `Đã tạo ${result.created.length} proposal cập nhật core block ` +
      `(bỏ qua ${result.skippedDuplicate} fact trùng, ${result.skippedEmpty} fact rỗng).`
    );
  });

  report.durationMs = Date.now() - started;
  if (!dryRun) appendLettaSleepLog(workspaceDir, report);
  return report;
}

/** Ghi một sleep pass vào log JSONL (append-only). */
export function appendLettaSleepLog(workspaceDir: string, report: SleepPassReport): void {
  const filePath = path.join(workspaceDir, V9_LETTA_SLEEP_LOG_REL_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(report) + '\n', { mode: 0o600 });
}

/** Đọc log sleep pass (mới nhất trước, tối đa `limit` lần chạy). */
export function readLettaSleepLog(workspaceDir: string, limit = 20): SleepPassReport[] {
  const filePath = path.join(workspaceDir, V9_LETTA_SLEEP_LOG_REL_PATH);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const out: SleepPassReport[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      try {
        out.push(JSON.parse(t) as SleepPassReport);
      } catch {
        // Bỏ dòng hỏng.
      }
    }
    return out.slice(-Math.max(1, limit)).reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
