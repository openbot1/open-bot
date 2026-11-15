/**
 * Memory v11 — sleep-time consolidation agent (v1.11, Doi T1).
 *
 * Y tuong hoc tu Letta sleep-time compute (agent thu hai chay nen,
 * ngoai critical path — xu ly transcript, viet `learned_context`
 * vao block chia se, consolidate/invalidate archival record; turn
 * chinh chi ghi raw fact nhanh, sleep pass don dep sau), viet lai
 * hoan toan cho open-bot tren cac store co san — KHONG goi model,
 * KHONG sua API cu.
 *
 * Luong chay dung kieu Letta:
 *
 *  TURN CHINH (critical path, phai nhanh):
 *    `recordRawFact(workspaceDir, { botId, text, source })` — chi
 *    append mot dong JSONL vao hop thu `.open-bot/memory-v11-raw-
 *    facts.jsonl` (ghi dong bo, khong phan tich, khong goi store
 *    nao khac). Duoi 1ms tren may thuong; turn chinh KHONG bao gio
 *    doi sleep pass.
 *
 *  SLEEP PASS (giua cac turn, ngoai critical path):
 *    `SleepConsolidationAgent.runSleepPass({ botId, ... })` lam 4 buoc:
 *     1. READ INBOX: doc raw fact chua xu ly, tach thanh cau
 *        (splitSentences cua v9) + dedupe (Jaccard >= 0.7).
 *     2. LEARNED_CONTEXT: ghi cac fact moi (dang "- fact") vao block
 *        chia se `learned_context` — qua SharedSupervisor voi actor
 *        `sleep:v11:<supervisorBotId>` (chi supervisor moi viet
 *        duoc block chia se); neu khong cau hinh nhom/supervisor thi
 *        ghi vao block thuong `learned_context` attach vao chinh bot
 *        do (van dung gioi han kind + ghi lich su backend `sleep-v11`).
 *     3. CONSOLIDATE ARCHIVAL: fact manh (xuat hien >= 2 lan, hoac
 *        do dai du lon) duoc dua vao ArchivalStore (source `fact`).
 *     4. INVALIDATE ARCHIVAL: fact moi co dau phu dinh ("khong con",
 *        "da doi", "no longer", "not anymore", ...) va trung tu khoa
 *        voi mot muc archival cu -> muc cu bi INVALIDATE (danh dau
 *        `invalidatedAt`/`invalidatedReason`, khong xoa cung — lich
 *        su con nguyen, search sau nay bo qua muc da invalidate).
 *    Cuoi pass: danh dau raw fact da xu ly + ghi log chay vao
 *    `.open-bot/memory-v11-sleep-log.jsonl` + tra SleepPassReport.
 *
 * Chong chay chong: `runSleepPassBetweenTurns` nho lan chay cuoi
 * (trong RAM, theo workspace+bot) va bo qua neu pass truoc chay
 * chua du MIN_SLEEP_INTERVAL_MS (mac dinh 10 phut) tru khi `force`.
 * Dry-run chi tinh toan, khong ghi gi.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryBlockStore } from '../blocks';
import { ArchivalStore } from '../v9/archival';
import { splitSentences, dedupeSentences, jaccardSimilarity, condenseWords } from '../v9/condense';
import { ensureTypedBlock, v11LimitForLabel } from './blockKinds';
import { SharedSupervisor, sleepV11Actor, sharedBlockLimitForLabel } from './sharedSupervisor';
import { recordBlockHistoryChange, historyInputFromBlock } from './blockHistoryTable';

export const V11_RAW_FACTS_REL_PATH = path.join('.open-bot', 'memory-v11-raw-facts.jsonl');
export const V11_SLEEP_LOG_REL_PATH = path.join('.open-bot', 'memory-v11-sleep-log.jsonl');
/** Raw fact ngan hon muc nay thi khong co du thong tin de thanh fact. */
export const V11_MIN_RAW_FACT_CHARS = 12;
/** Raw fact dai hon muc nay bi cat (chong hop thu phi). */
export const V11_MAX_RAW_FACT_CHARS = 2000;
/** So raw fact toi da xu ly trong mot sleep pass. */
export const V11_SLEEP_MAX_FACTS_PER_PASS = 200;
/** Jaccard: hai cau giong nhau tren muc nay thi coi la mot fact. */
export const V11_SLEEP_DUP_JACCARD = 0.7;
/** Jaccard: fact moi trung tu khoa voi muc archival cu tren muc nay thi xet mau thuan. */
export const V11_SLEEP_CONTRADICT_JACCARD = 0.45;
/** Khoang cach toi thieu giua hai sleep pass cua cung bot (chong chay chong). */
export const V11_MIN_SLEEP_INTERVAL_MS = 10 * 60 * 1000;
/** So dong log chay toi da giu khi doc. */
export const V11_SLEEP_LOG_KEEP = 100;
/** So dong `learned_context` toi da giu trong block (cu nhat rot truoc). */
export const V11_LEARNED_CONTEXT_MAX_LINES = 100;

/** Dau hieu phu dinh — fact moi co cum nay co the mau thuan fact cu. */
export const V11_NEGATION_CUES = [
  'không còn',
  'khong con',
  'đã đổi',
  'da doi',
  'đã thay đổi',
  'da thay doi',
  'không phải',
  'khong phai',
  'ngừng',
  'ngung',
  'dừng',
  'dung',
  'no longer',
  'not anymore',
  'no more',
  'changed to',
  'moved to',
] as const;

/** Loi sleep agent — message tieng Viet. */
export class V11SleepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V11SleepError';
  }
}

/** Mot raw fact trong hop thu (turn chinh ghi nhanh). */
export interface V11RawFact {
  id: string;
  botId: string;
  text: string;
  source: string;
  turnId?: string;
  at: string;
  processed: boolean;
  processedAt?: string;
}

/** Input ghi raw fact (turn chinh). */
export interface RecordRawFactInput {
  botId: string;
  text: string;
  source: string;
  turnId?: string;
}

/** Mot buoc trong sleep pass. */
export interface V11SleepStepResult {
  step: 'read-inbox' | 'learned-context' | 'consolidate-archival' | 'invalidate-archival';
  ok: boolean;
  detail: string;
  ms: number;
}

/** Bao cao day du cua mot sleep pass v11. */
export interface V11SleepPassReport {
  id: string;
  botId: string;
  at: string;
  dryRun: boolean;
  durationMs: number;
  rawFactsRead: number;
  factsExtracted: number;
  factsDeduped: number;
  learnedContextLinesAdded: number;
  archivalConsolidated: number;
  archivalInvalidated: Array<{ id: string; reason: string }>;
  steps: V11SleepStepResult[];
  errors: string[];
}

/** Tuy chon chay sleep pass. */
export interface V11SleepPassOptions {
  botId: string;
  /** Nhom share de ghi `learned_context` (vang = ghi block thuong cua bot). */
  groupIdOrName?: string;
  /** Supervisor cua nhom (bat buoc khi co groupIdOrName). */
  supervisorBotId?: string;
  /** true = chi tinh toan, khong ghi gi. */
  dryRun?: boolean;
  /** Ghi de khoang cach toi thieu (ms) — dung cho test. */
  minIntervalMs?: number;
  /** Bo qua khoang cach toi thieu (chay ngay). */
  force?: boolean;
  /** Gioi han raw fact xu ly (mac dinh V11_SLEEP_MAX_FACTS_PER_PASS). */
  maxFacts?: number;
}

function rawFactsFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, V11_RAW_FACTS_REL_PATH);
}

function sleepLogFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, V11_SLEEP_LOG_REL_PATH);
}

/**
 * Turn chinh ghi raw fact — CHI append mot dong JSONL, khong phan
 * tich gi. Text rong / qua ngan -> throw (turn chinh biet ngay de
 * khong ghi rac); text qua dai bi cat ve gioi han.
 */
export function recordRawFact(workspaceDir: string, input: RecordRawFactInput): V11RawFact {
  const botId = (input.botId ?? '').trim();
  if (botId === '') throw new V11SleepError('botId is empty.');
  const text = (input.text ?? '').trim().slice(0, V11_MAX_RAW_FACT_CHARS);
  if (text.length < V11_MIN_RAW_FACT_CHARS) {
    throw new V11SleepError(
      `Raw fact is too short (${text.length} chars, need at least ${V11_MIN_RAW_FACT_CHARS}).`,
    );
  }
  const fact: V11RawFact = {
    id: randomUUID(),
    botId,
    text,
    source: (input.source ?? 'turn').trim() || 'turn',
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    at: new Date().toISOString(),
    processed: false,
  };
  const filePath = rawFactsFilePath(workspaceDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(fact)}\n`, { mode: 0o600 });
  return fact;
}

/** Doc toan bo raw fact (dong hong bi bo qua). */
export function readRawFacts(workspaceDir: string): V11RawFact[] {
  let raw: string;
  try {
    raw = fs.readFileSync(rawFactsFilePath(workspaceDir), 'utf8');
  } catch {
    return [];
  }
  const out: V11RawFact[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as V11RawFact;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.text === 'string') out.push(parsed);
    } catch {
      // Dong hong — bo qua.
    }
  }
  return out;
}

/** Raw fact chua xu ly cua mot bot (cu nhat truoc, gioi han so luong). */
export function readUnprocessedRawFacts(
  workspaceDir: string,
  botId: string,
  limit = V11_SLEEP_MAX_FACTS_PER_PASS,
): V11RawFact[] {
  return readRawFacts(workspaceDir)
    .filter((f) => f.botId === botId && !f.processed)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, Math.max(1, Math.floor(limit)));
}

/**
 * Danh dau raw fact da xu ly (ghi lai file atomic). Best-effort:
 * ghi hong khong throw — pass sau se doc lai va dedupe (khong mat
 * du lieu, chi co the xu ly trung, dedupe se loai).
 */
export function markRawFactsProcessed(workspaceDir: string, ids: string[]): void {
  try {
    const filePath = rawFactsFilePath(workspaceDir);
    const all = readRawFacts(workspaceDir);
    const wanted = new Set(ids);
    const now = new Date().toISOString();
    const updated = all.map((f) =>
      wanted.has(f.id) ? { ...f, processed: true, processedAt: now } : f,
    );
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, updated.map((f) => JSON.stringify(f)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort.
  }
}

/** true khi cau chua dau hieu phu dinh (co the mau thuan fact cu). */
export function hasNegationCue(text: string): boolean {
  const lower = (text ?? '').toLowerCase();
  return (V11_NEGATION_CUES as readonly string[]).some((cue) => lower.includes(cue));
}

/**
 * Tim muc archival co the bi fact moi mau thuan: trung tu khoa
 * (Jaccard >= nguong) VA fact moi co dau phu dinh. Chi xet muc chua
 * bi invalidate. Tra danh sach id + ly do.
 */
export function findContradictedArchival(
  factText: string,
  archivalItems: Array<{ id: string; text: string }>,
): Array<{ id: string; reason: string }> {
  if (!hasNegationCue(factText)) return [];
  const words = condenseWords(factText);
  if (words.size === 0) return [];
  const out: Array<{ id: string; reason: string }> = [];
  for (const item of archivalItems) {
    const itemWords = condenseWords(item.text);
    if (jaccardSimilarity(words, itemWords) >= V11_SLEEP_CONTRADICT_JACCARD) {
      out.push({
        id: item.id,
        reason: `Contradicted by new fact: "${factText.slice(0, 120)}"`,
      });
    }
  }
  return out;
}

/** Ghi log chay sleep pass (append-only JSONL, best-effort). */
export function appendV11SleepLog(workspaceDir: string, report: V11SleepPassReport): void {
  try {
    const filePath = sleepLogFilePath(workspaceDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  } catch {
    // Log hong khong anh huong pass.
  }
}

/** Doc log chay gan nhat (moi nhat truoc). */
export function readV11SleepLog(workspaceDir: string, limit = 20): V11SleepPassReport[] {
  let raw: string;
  try {
    raw = fs.readFileSync(sleepLogFilePath(workspaceDir), 'utf8');
  } catch {
    return [];
  }
  const out: V11SleepPassReport[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as V11SleepPassReport;
      if (parsed && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      // Dong hong — bo qua.
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, Math.max(1, Math.min(V11_SLEEP_LOG_KEEP, Math.floor(limit))));
}

/**
 * Sleep-time consolidation agent v11 — chay giua cac turn, ngoai
 * critical path. Khong goi model: tach cau + dedupe + khop tu khoa
 * bang ham local cua v9/v3.
 */
export class V11SleepConsolidationAgent {
  private readonly workspaceDir: string;
  private readonly blocks: MemoryBlockStore;
  private readonly archival: ArchivalStore;
  private readonly supervisor: SharedSupervisor;
  /** Lan chay cuoi theo `botId` (chong chay chong trong cung process). */
  private readonly lastRunAt = new Map<string, number>();

  constructor(
    workspaceDir: string,
    blocksStore?: MemoryBlockStore,
    archivalStore?: ArchivalStore,
    supervisor?: SharedSupervisor,
  ) {
    this.workspaceDir = workspaceDir;
    this.blocks = blocksStore ?? new MemoryBlockStore(workspaceDir);
    this.archival = archivalStore ?? new ArchivalStore(workspaceDir);
    this.supervisor = supervisor ?? new SharedSupervisor(workspaceDir, this.blocks);
  }

  /** Test hook: xoa dau lan chay cuoi (de chay pass lien tiep trong test). */
  resetRunGuardForTests(botId?: string): void {
    if (botId === undefined) this.lastRunAt.clear();
    else this.lastRunAt.delete(botId);
  }

  /**
   * Chay mot sleep pass day du. `force` bo qua khoang cach toi thieu.
   * Dry-run: tinh toan het nhung khong ghi block/archival/raw-fact.
   * Loi o mot buoc ghi vao report.errors, pass van chay cac buoc sau.
   */
  runSleepPass(opts: V11SleepPassOptions): V11SleepPassReport {
    const startedAt = Date.now();
    const botId = (opts.botId ?? '').trim();
    if (botId === '') throw new V11SleepError('botId is empty.');
    if (opts.groupIdOrName !== undefined && (opts.supervisorBotId ?? '').trim() === '') {
      throw new V11SleepError('supervisorBotId is required when a shared group is given.');
    }
    const dryRun = opts.dryRun === true;
    const minInterval = opts.minIntervalMs ?? V11_MIN_SLEEP_INTERVAL_MS;
    const lastRun = this.lastRunAt.get(botId) ?? 0;
    if (!opts.force && !dryRun && Date.now() - lastRun < minInterval) {
      throw new V11SleepError(
        `Sleep pass for bot "${botId}" ran ${Math.round((Date.now() - lastRun) / 1000)}s ago — ` +
          `wait ${Math.round(minInterval / 1000)}s between passes (or pass force=true).`,
      );
    }
    const report: V11SleepPassReport = {
      id: randomUUID(),
      botId,
      at: new Date().toISOString(),
      dryRun,
      durationMs: 0,
      rawFactsRead: 0,
      factsExtracted: 0,
      factsDeduped: 0,
      learnedContextLinesAdded: 0,
      archivalConsolidated: 0,
      archivalInvalidated: [],
      steps: [],
      errors: [],
    };
    const step = (
      name: V11SleepStepResult['step'],
      fn: () => string,
    ): void => {
      const t0 = Date.now();
      try {
        const detail = fn();
        report.steps.push({ step: name, ok: true, detail, ms: Date.now() - t0 });
      } catch (err) {
        const message = (err as Error).message;
        report.steps.push({ step: name, ok: false, detail: message, ms: Date.now() - t0 });
        report.errors.push(`${name}: ${message}`);
      }
    };

    // Buoc 1 — doc inbox + tach fact + dedupe.
    let facts: Array<{ text: string; words: Set<string>; occurrences: number }> = [];
    let rawFacts: V11RawFact[] = [];
    step('read-inbox', () => {
      rawFacts = readUnprocessedRawFacts(
        this.workspaceDir,
        botId,
        opts.maxFacts ?? V11_SLEEP_MAX_FACTS_PER_PASS,
      );
      report.rawFactsRead = rawFacts.length;
      const sentences = rawFacts.flatMap((f) => splitSentences(f.text));
      // Dem so lan xuat hien TRUOC khi dedupe (fact lap lai nhieu lan
      // la fact manh — dedupe xong thi moi fact chi con 1 lan).
      const occurrences = new Map<string, number>();
      for (const s of sentences) occurrences.set(s.text, (occurrences.get(s.text) ?? 0) + 1);
      const deduped = dedupeSentences(sentences, V11_SLEEP_DUP_JACCARD);
      report.factsExtracted = sentences.length;
      report.factsDeduped = deduped.removed;
      facts = deduped.kept.map((s) => ({
        text: s.text,
        words: s.words,
        occurrences: occurrences.get(s.text) ?? 1,
      }));
      return `${rawFacts.length} raw facts -> ${facts.length} unique facts (${deduped.removed} duplicates removed).`;
    });

    // Buoc 2 — ghi learned_context (block chia se neu co nhom, khong thi block thuong).
    step('learned-context', () => {
      if (facts.length === 0) return 'No new facts — learned_context unchanged.';
      const lines = facts.map((f) => `- ${f.text}`);
      if (dryRun) {
        report.learnedContextLinesAdded = lines.length;
        return `Dry run: would add ${lines.length} lines to learned_context.`;
      }
      let added = 0;
      if (opts.groupIdOrName !== undefined) {
        const supervisorBotId = (opts.supervisorBotId ?? '').trim();
        const block = this.supervisor.ensureSharedPreset(
          opts.groupIdOrName,
          'learned-context',
          'user',
        );
        const current = block.content === '' ? [] : block.content.split('\n');
        const next = [...current, ...lines].slice(-V11_LEARNED_CONTEXT_MAX_LINES);
        const result = this.supervisor.writeSharedBlock(
          opts.groupIdOrName,
          block.id,
          { content: next.join('\n') },
          sleepV11Actor(supervisorBotId),
        );
        added = lines.length;
        recordBlockHistoryChange(
          this.workspaceDir,
          historyInputFromBlock(result.block, 'sleep-v11', 'consolidate', sleepV11Actor(supervisorBotId)),
        );
      } else {
        const block = ensureTypedBlock(this.blocks, botId, 'learned-context', `sleep:v11:${botId}`);
        const current = block.content === '' ? [] : block.content.split('\n');
        const next = [...current, ...lines].slice(-V11_LEARNED_CONTEXT_MAX_LINES);
        if (next.join('\n').length > v11LimitForLabel('learned-context')) {
          throw new V11SleepError(
            'learned_context would exceed its limit — condense it before the next sleep pass.',
          );
        }
        const updated = this.blocks.replace(block.id, next.join('\n'), `sleep:v11:${botId}`);
        added = lines.length;
        recordBlockHistoryChange(
          this.workspaceDir,
          historyInputFromBlock(updated, 'sleep-v11', 'consolidate', `sleep:v11:${botId}`),
        );
      }
      report.learnedContextLinesAdded = added;
      return `Added ${added} lines to learned_context.`;
    });

    // Buoc 3 — consolidate fact manh vao archival.
    step('consolidate-archival', () => {
      if (facts.length === 0 || dryRun) {
        return dryRun ? 'Dry run: archival consolidation skipped.' : 'No facts to consolidate.';
      }
      let added = 0;
      for (const f of facts) {
        // Fact xuat hien >= 2 lan trong inbox, hoac du dai, moi vao kho.
        const strong = f.occurrences >= 2 || f.text.length >= 60;
        if (!strong) continue;
        try {
          this.archival.insert({ text: f.text, source: 'fact', confidence: 0.7 });
          added += 1;
        } catch {
          // Trung y het / loi ghi — bo qua muc nay, pass tiep tuc.
        }
      }
      report.archivalConsolidated = added;
      return `Consolidated ${added} strong facts into archival.`;
    });

    // Buoc 4 — invalidate muc archival bi fact moi mau thuan.
    step('invalidate-archival', () => {
      if (facts.length === 0) return 'No facts — nothing to invalidate.';
      const items = this.archival
        .readAll()
        .filter((it) => !it.invalidatedAt)
        .map((it) => ({ id: it.id, text: it.text }));
      const invalidated: Array<{ id: string; reason: string }> = [];
      for (const f of facts) {
        for (const hit of findContradictedArchival(f.text, items)) {
          if (invalidated.some((x) => x.id === hit.id)) continue;
          if (dryRun) {
            invalidated.push(hit);
            continue;
          }
          try {
            if (this.archival.invalidate(hit.id, hit.reason)) invalidated.push(hit);
          } catch {
            // Muc da mat giua chung — bo qua.
          }
        }
      }
      report.archivalInvalidated = invalidated;
      return dryRun
        ? `Dry run: would invalidate ${invalidated.length} archival items.`
        : `Invalidated ${invalidated.length} contradicted archival items.`;
    });

    if (!dryRun) {
      this.lastRunAt.set(botId, Date.now());
      if (rawFacts.length > 0 && report.errors.length === 0) {
        markRawFactsProcessed(this.workspaceDir, rawFacts.map((f) => f.id));
      }
      appendV11SleepLog(this.workspaceDir, { ...report, durationMs: Date.now() - startedAt });
    }
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  /**
   * Chay sleep pass giua cac turn (duong goi chuan cho daemon / tool):
   * bo qua em khi pass truoc moi chay (tra null), khong throw vi
   * khoang cach — chi throw loi that (botId rong, nhom sai...).
   * Tra null = "chua toi luc chay", khong phai loi.
   */
  runSleepPassBetweenTurns(opts: V11SleepPassOptions): V11SleepPassReport | null {
    const botId = (opts.botId ?? '').trim();
    const lastRun = this.lastRunAt.get(botId) ?? 0;
    const minInterval = opts.minIntervalMs ?? V11_MIN_SLEEP_INTERVAL_MS;
    if (!opts.force && Date.now() - lastRun < minInterval) return null;
    return this.runSleepPass(opts);
  }
}
