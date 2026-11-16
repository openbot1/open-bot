/**
 * Memory v12 — sleep-time janitor cho memory block (v1.12, Doi T1).
 *
 * Y tuong hoc tu Letta sleep-time compute (don dep bo nho luc ranh,
 * ngoai critical path): khi bot idle, mot pass nen chay 4 viec tren
 * CHINH CAC BLOCK (khac voi consolidate.ts v0.96 lam viec tren
 * long-term memory entry, va khac sleep agent v11 lam viec tren raw
 * fact + archival) — viet lai hoan toan, 100% local, KHONG goi model:
 *
 *  1. DEDUPE trong block: dong trung nhau (sau chuan hoa: trim,
 *     gom khoang trang, khong phan biet hoa/thuong) chi giu lan dau;
 *     dong trong lien tiep gom lai thanh 1.
 *  2. MERGE giua cac block: cung mot dong bullet (`- ...`) xuat hien
 *     o 2 block tro len thi chi giu o block uu tien cao nhat
 *     (human > persona > task > project > safety > custom), xoa o
 *     block khac.
 *  3. TRIM vuot gioi han: block nao van dai hon charLimit sau khi
 *     dedupe thi bo dong CU NHAT (dau block — dong duoc append theo
 *     thoi gian nen dau la cu nhat) cho den khi vua, kem gioi han so
 *     dong toi da moi block.
 *  4. PROMOTE: bullet trong block `learned-context` (sleep agent v11
 *     ghi vao — label luu trong store la slug `learned-context`) chua
 *     co trong block `human` thi chuyen sang `human` (append) roi xoa
 *     khoi `learned-context` — fact da hoc thanh fact lau dai ve user.
 *
 * An toan: block read-only hoac block he thong (systemOwned) DUOC BO
 * QUA (ghi vao `skipped`, khong sua len); dry-run chi tinh toan,
 * khong ghi gi; moi lan ghi that di qua `store.replace()` nen tu
 * dong tang version + ghi audit (`replace`, actor `system:sleep-v12`)
 * + snapshot lich su. Pass chay log append-only vao
 * `.open-bot/memory-v12-janitor-log.jsonl`.
 *
 * Lich chay: `runJanitorIfIdle()` doc cau hinh consolidation san co
 * trong file memory-blocks (`enabled` + `idleMinutes`, mac dinh TAT)
 * va chi chay khi bot da idle du lau + da qua khoang cach toi thieu
 * giua 2 pass — host goi luc setup turn (best-effort, fail-open),
 * giong ConsolidationScheduler cua v0.96.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryBlockStore } from '../blocks';
import type { MemoryBlock } from '../blocks';
import { sortBlocksForRender, v11LimitForLabel } from '../v11/blockKinds';
import { ensureTypedBlock } from '../v11/blockKinds';

export const V12_JANITOR_LOG_REL_PATH = path.join('.open-bot', 'memory-v12-janitor-log.jsonl');
/** Actor ghi vao audit khi janitor sua block. */
export const V12_JANITOR_ACTOR = 'system:sleep-v12';
/** Khoang cach toi thieu giua 2 janitor pass cua cung bot (mac dinh 30 phut). */
export const V12_JANITOR_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** So dong toi da giu trong mot block sau khi don (mac dinh 200). */
export const V12_JANITOR_MAX_LINES_PER_BLOCK = 200;
/** Label block nhan fact da hoc (mac dinh `human`). */
export const V12_JANITOR_HUMAN_LABEL = 'human';
/** Label block chua fact da hoc tu sleep agent v11. */
/** Label block chua fact da hoc — dang slug (`learned_context` -> `learned-context`). */
export const V12_JANITOR_LEARNED_LABEL = 'learned-context';
/** So dong log chay toi da giu khi doc. */
export const V12_JANITOR_LOG_KEEP = 100;

/** Loi janitor — message tieng Viet. */
export class V12JanitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V12JanitorError';
  }
}

/** Chuan hoa mot dong de so sanh trung lap (trim + gom space + lower). */
export function normalizeJanitorLine(line: string): string {
  return (line ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** true khi dong la bullet fact (`- ...`, `* ...` hoac `• ...`). */
export function isBulletLine(line: string): boolean {
  return /^[-*•]\s+\S/.test((line ?? '').trim());
}

/** Tach noi dung block thanh dong (bo `\r`, giu nguyen thu tu). */
export function splitBlockLines(content: string): string[] {
  if (!content) return [];
  return content.replace(/\r\n?/g, '\n').split('\n');
}

/** Ghep dong thanh noi dung block (cat dong trong thua o dau/cuoi). */
export function joinBlockLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

export interface DedupeLinesResult {
  lines: string[];
  /** So dong trung lap / dong trong thua da bo. */
  removed: number;
  /** Cac dong (da chuan hoa) da bo — de bao cao. */
  removedNormalized: string[];
}

/**
 * Dedupe trong mot block: dong trung nhau (sau chuan hoa) chi giu lan
 * dau; dong trong lien tiep gom lai thanh 1. Dong trong don le giua
 * cac dong noi dung duoc giu (de dinh dang doan khong vo).
 */
export function dedupeBlockLines(lines: string[]): DedupeLinesResult {
  const seen = new Set<string>();
  const out: string[] = [];
  const removedNormalized: string[] = [];
  let previousBlank = true; // dong trong o dau bi bo (join se cat anyway)
  for (const line of lines) {
    if (line.trim() === '') {
      if (previousBlank) {
        removedNormalized.push('');
        continue;
      }
      previousBlank = true;
      out.push('');
      continue;
    }
    previousBlank = false;
    const key = normalizeJanitorLine(line);
    if (seen.has(key)) {
      removedNormalized.push(key);
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  return { lines: out, removed: removedNormalized.length, removedNormalized };
}

export interface V12JanitorBlockChange {
  label: string;
  beforeVersion: number;
  afterVersion: number;
  linesDeduped: number;
  linesMerged: number;
  linesTrimmed: number;
  /** So bullet da chuyen DI khoi block nay (chi learned-context). */
  promotedOut: number;
  /** So bullet da chuyen VAO block nay (chi human). */
  promotedIn: number;
}

export interface V12JanitorSkipped {
  label: string;
  reason: 'read-only' | 'system-owned' | 'empty';
}

export interface V12JanitorReport {
  passId: string;
  at: string;
  botId?: string;
  dryRun: boolean;
  blocksExamined: number;
  blocksChanged: number;
  linesDeduped: number;
  linesMerged: number;
  linesTrimmed: number;
  linesPromoted: number;
  skipped: V12JanitorSkipped[];
  changes: V12JanitorBlockChange[];
}

export interface RunJanitorOptions {
  /** Chi don block attach vao bot nay (bo qua = don toan bo block trong store). */
  botId?: string;
  /** true = chi tinh toan, khong ghi store, khong ghi log. */
  dryRun?: boolean;
  /** Actor ghi audit (mac dinh `system:sleep-v12`). */
  actor?: string;
  /** So dong toi da giu moi block (mac dinh 200). */
  maxLinesPerBlock?: number;
  /** true = chay buoc promote learned-context -> human (mac dinh true). */
  promoteLearnedContext?: boolean;
  /** Label block nhan fact (mac dinh `human`). */
  humanBlockLabel?: string;
  /** Label block chua fact da hoc (mac dinh `learned-context`). */
  learnedContextLabel?: string;
}

interface WorkingBlock {
  block: MemoryBlock;
  lines: string[];
  deduped: number;
  merged: number;
  trimmed: number;
  promotedOut: number;
  promotedIn: number;
}

function newChange(w: WorkingBlock, afterVersion: number): V12JanitorBlockChange {
  return {
    label: w.block.label,
    beforeVersion: w.block.version,
    afterVersion,
    linesDeduped: w.deduped,
    linesMerged: w.merged,
    linesTrimmed: w.trimmed,
    promotedOut: w.promotedOut,
    promotedIn: w.promotedIn,
  };
}

/**
 * Chay mot janitor pass tren block. Idempotent: chay lai ngay sau khi
 * chay xong se tra report 0 thay doi (khong con gi de don).
 */
export function runBlockJanitorPass(
  store: MemoryBlockStore,
  opts: RunJanitorOptions = {},
): V12JanitorReport {
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? V12_JANITOR_ACTOR;
  const maxLines =
    opts.maxLinesPerBlock !== undefined && Number.isFinite(opts.maxLinesPerBlock)
      ? Math.max(1, Math.floor(opts.maxLinesPerBlock))
      : V12_JANITOR_MAX_LINES_PER_BLOCK;
  const doPromote = opts.promoteLearnedContext !== false;
  const humanLabel = opts.humanBlockLabel ?? V12_JANITOR_HUMAN_LABEL;
  const learnedLabel = opts.learnedContextLabel ?? V12_JANITOR_LEARNED_LABEL;

  const targets =
    opts.botId !== undefined
      ? sortBlocksForRender(store.listAttached(opts.botId))
      : sortBlocksForRender(store.list());

  const report: V12JanitorReport = {
    passId: randomUUID(),
    at: new Date().toISOString(),
    ...(opts.botId !== undefined ? { botId: opts.botId } : {}),
    dryRun,
    blocksExamined: targets.length,
    blocksChanged: 0,
    linesDeduped: 0,
    linesMerged: 0,
    linesTrimmed: 0,
    linesPromoted: 0,
    skipped: [],
    changes: [],
  };

  const working = new Map<string, WorkingBlock>();
  for (const block of targets) {
    if (block.systemOwned === true) {
      report.skipped.push({ label: block.label, reason: 'system-owned' });
      continue;
    }
    if (block.readOnly) {
      report.skipped.push({ label: block.label, reason: 'read-only' });
      continue;
    }
    if (block.content.trim() === '') {
      report.skipped.push({ label: block.label, reason: 'empty' });
      continue;
    }
    const lines = splitBlockLines(block.content);
    working.set(block.label, {
      block,
      lines,
      deduped: 0,
      merged: 0,
      trimmed: 0,
      promotedOut: 0,
      promotedIn: 0,
    });
  }

  // Buoc 1 — dedupe trong tung block.
  for (const w of working.values()) {
    const deduped = dedupeBlockLines(w.lines);
    w.lines = deduped.lines;
    w.deduped = deduped.removed;
  }

  // Buoc 2 — merge bullet trung nhau giua cac block: giu o block uu
  // tien cao nhat (thu tu targets da sort theo uu tien), xoa o cac
  // block con lai. Chi xet bullet (fact dang `- ...`).
  const bulletOwner = new Map<string, string>();
  for (const w of working.values()) {
    for (const line of w.lines) {
      if (!isBulletLine(line)) continue;
      const key = normalizeJanitorLine(line);
      if (!bulletOwner.has(key)) bulletOwner.set(key, w.block.label);
    }
  }
  for (const w of working.values()) {
    const before = w.lines.length;
    w.lines = w.lines.filter((line) => {
      if (!isBulletLine(line)) return true;
      return bulletOwner.get(normalizeJanitorLine(line)) === w.block.label;
    });
    w.merged = before - w.lines.length;
  }

  // Buoc 3 — trim vuot gioi han: bo dong cu nhat (dau block) cho den
  // khi vua charLimit va vua so dong toi da. Khong bao gio xoa het.
  for (const w of working.values()) {
    let content = joinBlockLines(w.lines);
    while (w.lines.length > 1 && (content.length > w.block.charLimit || w.lines.length > maxLines)) {
      w.lines.shift();
      w.trimmed += 1;
      content = joinBlockLines(w.lines);
    }
  }

  // Buoc 4 — promote learned-context -> human.
  if (doPromote) {
    const learned = working.get(learnedLabel);
    if (learned) {
      const humanInStore = store.get(humanLabel);
      const humanWritable =
        humanInStore !== null && !humanInStore.readOnly && humanInStore.systemOwned !== true;
      // Human chua ton tai: tao moi (qua ensureTypedBlock — lay gioi
      // han kind) de co cho nhan fact; chi khi co bullet de chuyen.
      const bullets = learned.lines.filter((l) => isBulletLine(l));
      if (bullets.length > 0 && (humanWritable || humanInStore === null)) {
        let humanWorking = working.get(humanLabel);
        if (!humanWorking && humanInStore === null) {
          // Human chua ton tai: tao that (neu khong dry-run) hoac mo
          // phong bang block ao (dry-run) de bao cao dung so lieu.
          if (!dryRun) {
            const created = opts.botId
              ? ensureTypedBlock(store, opts.botId, humanLabel, actor)
              : store.create(
                  {
                    label: humanLabel,
                    description: 'Facts about the user.',
                    content: '',
                    charLimit: v11LimitForLabel(humanLabel),
                    createdByBotId: '',
                  },
                  actor,
                );
            humanWorking = {
              block: created,
              lines: splitBlockLines(created.content),
              deduped: 0,
              merged: 0,
              trimmed: 0,
              promotedOut: 0,
              promotedIn: 0,
            };
          } else {
            humanWorking = {
              block: {
                id: `dry-run:${humanLabel}`,
                label: humanLabel,
                description: '',
                content: '',
                charLimit: v11LimitForLabel(humanLabel),
                readOnly: false,
                createdByBotId: '',
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              lines: [],
              deduped: 0,
              merged: 0,
              trimmed: 0,
              promotedOut: 0,
              promotedIn: 0,
            };
          }
          working.set(humanLabel, humanWorking);
        } else if (!humanWorking && humanInStore !== null) {
          humanWorking = {
            block: humanInStore,
            lines: splitBlockLines(humanInStore.content),
            deduped: 0,
            merged: 0,
            trimmed: 0,
            promotedOut: 0,
            promotedIn: 0,
          };
          working.set(humanLabel, humanWorking);
        }
        if (humanWorking) {
          const humanKeys = new Set(
            humanWorking.lines.map((l) => normalizeJanitorLine(l)),
          );
          const toPromote = bullets.filter((b) => !humanKeys.has(normalizeJanitorLine(b)));
          const kept: string[] = [];
          let promoted = 0;
          for (const line of learned.lines) {
            if (isBulletLine(line) && toPromote.includes(line)) {
              // Kiem tra vua gioi han truoc khi chuyen tung dong.
              const candidate = joinBlockLines([...humanWorking.lines, line]);
              if (candidate.length <= humanWorking.block.charLimit) {
                humanWorking.lines.push(line);
                humanWorking.promotedIn += 1;
                promoted += 1;
                continue;
              }
            }
            kept.push(line);
          }
          if (promoted > 0) {
            learned.lines = kept;
            learned.promotedOut = promoted;
          }
        }
      }
    }
  }

  // Ghi that (tru dry-run): moi block doi thi 1 lan store.replace.
  for (const w of working.values()) {
    const next = joinBlockLines(w.lines);
    const changed =
      next !== w.block.content ||
      w.deduped > 0 ||
      w.merged > 0 ||
      w.trimmed > 0 ||
      w.promotedIn > 0 ||
      w.promotedOut > 0;
    if (!changed) continue;
    report.linesDeduped += w.deduped;
    report.linesMerged += w.merged;
    report.linesTrimmed += w.trimmed;
    report.linesPromoted += w.promotedIn;
    report.blocksChanged += 1;
    if (dryRun) {
      report.changes.push(newChange(w, w.block.version));
      continue;
    }
    const updated = store.replace(w.block.id, next, actor);
    report.changes.push(newChange(w, updated.version));
  }
  // Human moi tao o buoc 4 (chua co trong working luc dau) van duoc
  // tinh dung o tren (promotedIn > 0 nen da ghi qua replace). Truong
  // hop human moi tao nhung khong co bullet nao de chuyen thi khong
  // tao block (da kiem tra bullets.length > 0 truoc khi tao).

  if (!dryRun) {
    appendV12JanitorLog(store.dir, report);
  }
  return report;
}

/** Ghi mot dong log chay janitor (best-effort, khong throw). */
export function appendV12JanitorLog(workspaceDir: string, report: V12JanitorReport): boolean {
  try {
    const logPath = path.join(workspaceDir, V12_JANITOR_LOG_REL_PATH);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(report) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Doc N report janitor gan nhat (bo dong hong, khong throw khi chua co file). */
export function readV12JanitorLog(workspaceDir: string, limit = 20): V12JanitorReport[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspaceDir, V12_JANITOR_LOG_REL_PATH), 'utf8');
  } catch {
    return [];
  }
  const out: V12JanitorReport[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as V12JanitorReport;
      if (typeof parsed.passId === 'string') out.push(parsed);
    } catch {
      // Dong hong — bo qua.
    }
  }
  const n = Math.min(Math.max(Math.floor(limit), 1), V12_JANITOR_LOG_KEEP);
  return out.slice(-n).reverse();
}

/** Lan chay janitor gan nhat trong RAM (chong chay chong giua cac goi). */
const lastJanitorRunByKey = new Map<string, number>();

export interface RunJanitorIfIdleOptions extends RunJanitorOptions {
  /** Thoi diem hien tai (de test; mac dinh Date.now()). */
  now?: number;
  /** Khoang cach toi thieu giua 2 pass (mac dinh 30 phut). */
  minIntervalMs?: number;
  /** true = chay bat chap idle/interval (de test va chay tay). */
  force?: boolean;
}

export interface RunJanitorIfIdleResult {
  ran: boolean;
  reason: 'disabled' | 'not-idle' | 'too-soon' | 'ran' | 'forced';
  /** So phut idle hien tai (neu tinh duoc). */
  idleMinutes?: number;
  report?: V12JanitorReport;
}

/**
 * Chay janitor khi bot idle: doc cau hinh consolidation san co
 * (`enabled` + `idleMinutes` + `lastActivityAt`/`lastRunAt` trong
 * file memory-blocks). Mac dinh TAT (enabled=false) — host bat len
 * khi muon janitor tu chay luc ranh. Fail-open: loi cau hinh thi coi
 * nhu chua den luc chay (khong throw).
 */
export function runJanitorIfIdle(
  store: MemoryBlockStore,
  opts: RunJanitorIfIdleOptions = {},
): RunJanitorIfIdleResult {
  const now = opts.now ?? Date.now();
  const config = store.getConsolidationConfig();
  const force = opts.force === true;
  const key = `${store.dir}::${opts.botId ?? ''}`;
  if (!config.enabled && !force) {
    return { ran: false, reason: 'disabled' };
  }
  const lastActivity = config.lastActivityAt ? Date.parse(config.lastActivityAt) : NaN;
  const idleMs = Number.isFinite(lastActivity) ? now - lastActivity : Number.POSITIVE_INFINITY;
  const idleMinutes = Number.isFinite(idleMs) ? Math.floor(idleMs / 60000) : undefined;
  if (!force && Number.isFinite(idleMs) && idleMs < config.idleMinutes * 60000) {
    return { ran: false, reason: 'not-idle', ...(idleMinutes !== undefined ? { idleMinutes } : {}) };
  }
  const minInterval = opts.minIntervalMs ?? V12_JANITOR_MIN_INTERVAL_MS;
  const lastRun = lastJanitorRunByKey.get(key);
  const lastRunAt = config.lastRunAt ? Date.parse(config.lastRunAt) : NaN;
  const lastRunMs = lastRun ?? (Number.isFinite(lastRunAt) ? lastRunAt : undefined);
  if (!force && lastRunMs !== undefined && now - lastRunMs < minInterval) {
    return { ran: false, reason: 'too-soon', ...(idleMinutes !== undefined ? { idleMinutes } : {}) };
  }
  const report = runBlockJanitorPass(store, opts);
  lastJanitorRunByKey.set(key, now);
  if (!report.dryRun) {
    try {
      store.setConsolidationConfig({ lastRunAt: new Date(now).toISOString() }, V12_JANITOR_ACTOR);
    } catch {
      // Ghi lastRunAt that bai thi pass van co gia tri — bo qua.
    }
  }
  return {
    ran: true,
    reason: force ? 'forced' : 'ran',
    ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    report,
  };
}
