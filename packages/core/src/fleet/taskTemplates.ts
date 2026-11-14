/**
 * Fleet task templates v4 (v1.05, Team T6) — task định kỳ của fleet:
 * một template mô tả một task lặp lại (vd "weekly progress report"
 * mỗi 7 ngày, "nightly backup check" mỗi ngày), kèm lịch chạy tiếp
 * theo. Scheduler/automation bên ngoài hỏi `dueTaskTemplates()` rồi
 * nộp task qua `FleetOrchestrator.submitTask()` — module này chỉ
 * quản lý ĐỊNH NGHĨA + LỊCH, không tự chạy task.
 *
 * Lưu trữ: `<fleetRoot>/fleet-task-templates.json` (atomic tmp +
 * rename, mode 0600, cùng posture với fleet-policy-v4.json).
 * Nối tiếp `FleetTaskV4` (`orchestration.ts`): template sinh ra task
 * v4 qua `instantiateTemplate()`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetTaskPriority } from './policy';
import type { SubmitFleetTaskInput } from './orchestration';

export const FLEET_TASK_TEMPLATES_FILE = 'fleet-task-templates.json';

/** Một template task định kỳ. */
export interface FleetTaskTemplate {
  id: string;
  title: string;
  kind: string;
  priority: FleetTaskPriority;
  requiredCapabilities: string[];
  affinityBotId?: string;
  affinityTags: string[];
  tokenBudget?: number;
  submittedBy: string;
  /** Khoảng cách giữa hai lần sinh task (ms). */
  intervalMs: number;
  /** Lần sinh task tiếp theo (epoch ms). */
  nextRunAt: number;
  /** Lần sinh task gần nhất (epoch ms), null khi chưa sinh lần nào. */
  lastRunAt: number | null;
  /** Tắt template thì không bao giờ tới hạn. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFleetTaskTemplateInput {
  title: string;
  kind?: string;
  priority?: FleetTaskPriority;
  requiredCapabilities?: string[];
  affinityBotId?: string;
  affinityTags?: string[];
  tokenBudget?: number;
  submittedBy: string;
  intervalMs: number;
  /** Lần chạy đầu tiên (mặc định: ngay bây giờ). */
  firstRunAt?: number;
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function templateId(): string {
  return `ftmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getFleetTaskTemplatesPath(fleetRoot: string): string {
  if (typeof fleetRoot !== 'string' || fleetRoot.trim().length === 0) {
    throw new Error('fleet task templates need a non-empty fleetRoot.');
  }
  return path.join(fleetRoot, FLEET_TASK_TEMPLATES_FILE);
}

/** Validate một template (throws khi sai). */
export function validateFleetTaskTemplate(raw: unknown): FleetTaskTemplate {
  if (!isRecord(raw)) throw new Error('fleet task template must be an object.');
  const { id, title, kind, priority, requiredCapabilities, affinityBotId, affinityTags, tokenBudget, submittedBy, intervalMs, nextRunAt, lastRunAt, enabled, createdAt, updatedAt } = raw;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('fleet task template needs a non-empty id.');
  if (typeof title !== 'string' || title.trim() === '') throw new Error('fleet task template needs a non-empty title.');
  if (typeof kind !== 'string' || kind.trim() === '') throw new Error('fleet task template needs a non-empty kind.');
  if (![1, 2, 3, 4, 5].includes(priority as number)) throw new Error('fleet task template priority must be an integer 1..5.');
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((c) => typeof c !== 'string')) {
    throw new Error('fleet task template requiredCapabilities must be an array of strings.');
  }
  if (affinityBotId !== undefined && typeof affinityBotId !== 'string') {
    throw new Error('fleet task template affinityBotId must be a string when given.');
  }
  if (!Array.isArray(affinityTags) || affinityTags.some((t) => typeof t !== 'string')) {
    throw new Error('fleet task template affinityTags must be an array of strings.');
  }
  if (tokenBudget !== undefined && (typeof tokenBudget !== 'number' || !Number.isFinite(tokenBudget) || tokenBudget < 0)) {
    throw new Error('fleet task template tokenBudget must be a number >= 0.');
  }
  if (typeof submittedBy !== 'string' || submittedBy.trim() === '') {
    throw new Error('fleet task template needs a non-empty submittedBy.');
  }
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('fleet task template intervalMs must be a number > 0.');
  }
  if (typeof nextRunAt !== 'number' || !Number.isFinite(nextRunAt)) {
    throw new Error('fleet task template nextRunAt must be a number.');
  }
  if (lastRunAt !== null && (typeof lastRunAt !== 'number' || !Number.isFinite(lastRunAt))) {
    throw new Error('fleet task template lastRunAt must be a number or null.');
  }
  if (typeof enabled !== 'boolean') throw new Error('fleet task template enabled must be a boolean.');
  if (typeof createdAt !== 'string' || createdAt.trim() === '') throw new Error('fleet task template needs createdAt.');
  if (typeof updatedAt !== 'string' || updatedAt.trim() === '') throw new Error('fleet task template needs updatedAt.');
  return {
    id: id.trim(),
    title: title.trim(),
    kind: kind.trim(),
    priority: priority as FleetTaskPriority,
    requiredCapabilities: [...(requiredCapabilities as string[])],
    ...(affinityBotId !== undefined ? { affinityBotId: affinityBotId as string } : {}),
    affinityTags: [...(affinityTags as string[])],
    ...(tokenBudget !== undefined ? { tokenBudget: tokenBudget as number } : {}),
    submittedBy: submittedBy.trim(),
    intervalMs: intervalMs as number,
    nextRunAt: nextRunAt as number,
    lastRunAt: lastRunAt as number | null,
    enabled: enabled as boolean,
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
}

/** Mọi template đã lưu (file thiếu = chưa có template nào). */
export function listFleetTaskTemplates(fleetRoot: string): FleetTaskTemplate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getFleetTaskTemplatesPath(fleetRoot), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_TASK_TEMPLATES_FILE} is corrupt: expected an array.`);
  const templates = parsed.map((entry, i) => {
    try {
      return validateFleetTaskTemplate(entry);
    } catch (err) {
      throw new Error(`${FLEET_TASK_TEMPLATES_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
  return templates.sort((a, b) => a.title.localeCompare(b.title));
}

function saveFleetTaskTemplates(fleetRoot: string, templates: FleetTaskTemplate[]): void {
  const valid = templates.map((t) => validateFleetTaskTemplate(t));
  const filePath = getFleetTaskTemplatesPath(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

/** Tạo template mới. Trả về template đã lưu. */
export function createFleetTaskTemplate(
  fleetRoot: string,
  input: CreateFleetTaskTemplateInput,
  now: number = Date.now(),
): FleetTaskTemplate {
  if (!isRecord(input)) throw new Error('fleet task template input must be an object.');
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new Error('fleet task template needs a non-empty title.');
  }
  if (typeof input.submittedBy !== 'string' || input.submittedBy.trim() === '') {
    throw new Error('fleet task template needs a non-empty submittedBy.');
  }
  if (typeof input.intervalMs !== 'number' || !Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error('fleet task template intervalMs must be a number > 0.');
  }
  if (input.priority !== undefined && ![1, 2, 3, 4, 5].includes(input.priority)) {
    throw new Error('fleet task template priority must be an integer 1..5.');
  }
  if (input.firstRunAt !== undefined && (typeof input.firstRunAt !== 'number' || !Number.isFinite(input.firstRunAt))) {
    throw new Error('fleet task template firstRunAt must be a number when given.');
  }
  const stamp = new Date(now).toISOString();
  const template: FleetTaskTemplate = {
    id: templateId(),
    title: input.title.trim(),
    kind: typeof input.kind === 'string' && input.kind.trim() !== '' ? input.kind.trim() : 'general',
    priority: input.priority ?? 3,
    requiredCapabilities: [...(input.requiredCapabilities ?? [])],
    ...(input.affinityBotId ? { affinityBotId: input.affinityBotId } : {}),
    affinityTags: [...(input.affinityTags ?? [])],
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    submittedBy: input.submittedBy.trim(),
    intervalMs: input.intervalMs,
    nextRunAt: input.firstRunAt ?? now,
    lastRunAt: null,
    enabled: input.enabled ?? true,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const templates = listFleetTaskTemplates(fleetRoot);
  saveFleetTaskTemplates(fleetRoot, [...templates, template]);
  return { ...template };
}

/** Xóa template. Trả true khi có template bị xóa. */
export function removeFleetTaskTemplate(fleetRoot: string, id: string): boolean {
  const templates = listFleetTaskTemplates(fleetRoot);
  const next = templates.filter((t) => t.id !== id);
  if (next.length === templates.length) return false;
  saveFleetTaskTemplates(fleetRoot, next);
  return true;
}

/** Bật / tắt một template. */
export function setFleetTaskTemplateEnabled(fleetRoot: string, id: string, enabled: boolean): FleetTaskTemplate {
  const templates = listFleetTaskTemplates(fleetRoot);
  const found = templates.find((t) => t.id === id);
  if (!found) throw new Error(`no fleet task template with id "${id}".`);
  const updated: FleetTaskTemplate = { ...found, enabled, updatedAt: new Date().toISOString() };
  saveFleetTaskTemplates(
    fleetRoot,
    templates.map((t) => (t.id === id ? updated : t)),
  );
  return updated;
}

/** Template có tới hạn sinh task tại `now` không (bật + đã tới nextRunAt). */
export function isFleetTaskTemplateDue(template: FleetTaskTemplate, now: number = Date.now()): boolean {
  return template.enabled && now >= template.nextRunAt;
}

/** Các template tới hạn tại `now`, xếp theo nextRunAt (cũ nhất trước). */
export function dueFleetTaskTemplates(fleetRoot: string, now: number = Date.now()): FleetTaskTemplate[] {
  return listFleetTaskTemplates(fleetRoot)
    .filter((t) => isFleetTaskTemplateDue(t, now))
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
}

/**
 * Sinh task v4 từ một template (input cho `FleetOrchestrator.submitTask`).
 * Không tự cập nhật lịch — caller gọi `advanceFleetTaskTemplate()` sau
 * khi nộp task thành công để đẩy nextRunAt tới kỳ sau.
 */
export function instantiateFleetTaskTemplate(template: FleetTaskTemplate): SubmitFleetTaskInput {
  return {
    title: template.title,
    kind: template.kind,
    priority: template.priority,
    requiredCapabilities: [...template.requiredCapabilities],
    ...(template.affinityBotId ? { affinityBotId: template.affinityBotId } : {}),
    affinityTags: [...template.affinityTags],
    ...(template.tokenBudget !== undefined ? { tokenBudget: template.tokenBudget } : {}),
    submittedBy: template.submittedBy,
  };
}

/**
 * Đẩy lịch của template tới kỳ sau sau khi đã sinh task: lastRunAt =
 * `at`, nextRunAt = `at` + intervalMs. Trả về template đã cập nhật.
 */
export function advanceFleetTaskTemplate(
  fleetRoot: string,
  id: string,
  at: number = Date.now(),
): FleetTaskTemplate {
  const templates = listFleetTaskTemplates(fleetRoot);
  const found = templates.find((t) => t.id === id);
  if (!found) throw new Error(`no fleet task template with id "${id}".`);
  const updated: FleetTaskTemplate = {
    ...found,
    lastRunAt: at,
    nextRunAt: at + found.intervalMs,
    updatedAt: new Date(at).toISOString(),
  };
  saveFleetTaskTemplates(
    fleetRoot,
    templates.map((t) => (t.id === id ? updated : t)),
  );
  return updated;
}
