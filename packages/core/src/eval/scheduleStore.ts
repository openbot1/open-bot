/**
 * Eval schedule store (v1.05, Team T6) — lưu cấu hình lịch chạy eval
 * theo dataset vào `<baseDir>/eval-memory-schedule.json` (atomic tmp
 * + rename, cùng posture với eval-memory-history.json).
 *
 * Runner v3 (`runner.ts`) đã có `EvalScheduleConfig` + `isEvalRunDue`
 * (pure); module này là lớp LƯU TRỮ để automation/scheduler bên
 * ngoài hỏi "dataset nào tới hạn chạy rồi" mà không cần giữ config
 * trong bộ nhớ. Mỗi dataset có tối đa một lịch; lịch tắt (enabled
 * false) thì không bao giờ tới hạn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvalScheduleConfig } from './runner';
import { DEFAULT_EVAL_SCHEDULE, isEvalRunDue } from './runner';

export const EVAL_MEMORY_SCHEDULE_FILE = 'eval-memory-schedule.json';

/** Một lịch chạy eval gắn với một dataset. */
export interface EvalScheduleEntry {
  datasetId: string;
  schedule: EvalScheduleConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function evalMemorySchedulePath(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('eval schedule store needs a non-empty baseDir.');
  }
  return path.join(baseDir, EVAL_MEMORY_SCHEDULE_FILE);
}

function validateSchedule(raw: unknown): EvalScheduleConfig {
  if (!isRecord(raw)) throw new Error('eval schedule must be an object.');
  const { enabled, intervalMs, lastRunAt } = raw;
  if (typeof enabled !== 'boolean') throw new Error('eval schedule enabled must be a boolean.');
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('eval schedule intervalMs must be a number > 0.');
  }
  if (lastRunAt !== null && (typeof lastRunAt !== 'number' || !Number.isFinite(lastRunAt))) {
    throw new Error('eval schedule lastRunAt must be a number or null.');
  }
  return { enabled, intervalMs, lastRunAt: (lastRunAt as number | null) ?? null };
}

function validateEntry(raw: unknown): EvalScheduleEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.datasetId !== 'string' || raw.datasetId.trim() === '') return null;
  try {
    return { datasetId: raw.datasetId.trim(), schedule: validateSchedule(raw.schedule) };
  } catch {
    return null;
  }
}

/** Mọi lịch đã lưu (file thiếu = chưa có lịch nào). */
export function listEvalSchedules(baseDir: string): EvalScheduleEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(evalMemorySchedulePath(baseDir), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  const entries = parsed
    .map((row) => validateEntry(row))
    .filter((e): e is EvalScheduleEntry => e !== null);
  // Trùng datasetId (file sửa tay) thì giữ entry cuối cùng.
  const byDataset = new Map<string, EvalScheduleEntry>();
  for (const entry of entries) byDataset.set(entry.datasetId, entry);
  return [...byDataset.values()].sort((a, b) => a.datasetId.localeCompare(b.datasetId));
}

function saveEvalSchedules(baseDir: string, entries: EvalScheduleEntry[]): void {
  const filePath = evalMemorySchedulePath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Đặt / cập nhật lịch cho một dataset. Thiếu field trong `schedule`
 * thì lấy từ lịch cũ (nếu có) hoặc từ DEFAULT_EVAL_SCHEDULE.
 */
export function setEvalSchedule(
  baseDir: string,
  datasetId: string,
  schedule: Partial<EvalScheduleConfig>,
): EvalScheduleEntry {
  if (typeof datasetId !== 'string' || datasetId.trim() === '') {
    throw new Error('eval schedule needs a non-empty datasetId.');
  }
  const entries = listEvalSchedules(baseDir);
  const existing = entries.find((e) => e.datasetId === datasetId.trim());
  const merged: EvalScheduleConfig = {
    ...(existing?.schedule ?? DEFAULT_EVAL_SCHEDULE),
    ...schedule,
  };
  const valid = validateSchedule(merged);
  const entry: EvalScheduleEntry = { datasetId: datasetId.trim(), schedule: valid };
  const next = existing
    ? entries.map((e) => (e.datasetId === entry.datasetId ? entry : e))
    : [...entries, entry];
  saveEvalSchedules(baseDir, next);
  return entry;
}

/** Xóa lịch của một dataset. Trả true khi có lịch bị xóa. */
export function removeEvalSchedule(baseDir: string, datasetId: string): boolean {
  const entries = listEvalSchedules(baseDir);
  const next = entries.filter((e) => e.datasetId !== datasetId);
  if (next.length === entries.length) return false;
  saveEvalSchedules(baseDir, next);
  return true;
}

/** Lịch của một dataset (null khi chưa đặt). */
export function getEvalSchedule(baseDir: string, datasetId: string): EvalScheduleEntry | null {
  return listEvalSchedules(baseDir).find((e) => e.datasetId === datasetId) ?? null;
}

/** Ghi nhận một lần chạy tự động vừa xong (cập nhật lastRunAt). */
export function markEvalScheduleRun(baseDir: string, datasetId: string, at: number = Date.now()): EvalScheduleEntry {
  const existing = getEvalSchedule(baseDir, datasetId);
  if (!existing) throw new Error(`no eval schedule for dataset: ${datasetId}`);
  return setEvalSchedule(baseDir, datasetId, { lastRunAt: at });
}

/**
 * Các dataset tới hạn chạy tại `now` (lịch bật + đã quá interval,
 * hoặc chưa chạy lần nào). Scheduler bên ngoài gọi hàm này mỗi vòng
 * rồi chạy eval cho từng dataset trả về.
 */
export function dueEvalSchedules(baseDir: string, now: number = Date.now()): EvalScheduleEntry[] {
  return listEvalSchedules(baseDir).filter((entry) => isEvalRunDue(entry.schedule, now));
}
