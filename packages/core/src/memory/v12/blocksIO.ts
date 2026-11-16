/**
 * Memory v12 — export/import memory block (v1.12, Doi T1).
 *
 * Backup kho block thanh mot file JSON de user luu tru / chuyen may
 * / khoi phuc sau khi xoa nham. Viet moi hoan toan cho open-bot,
 * chi dung MemoryBlockStore san co — KHONG goi model, KHONG goi API.
 *
 * Dinh dang export (version 1, tu mo ta):
 *   {
 *     "format": "open-bot-memory-blocks",
 *     "version": 1,
 *     "exportedAt": "<ISO>",
 *     "blocks": [ { label, description, content, charLimit,
 *                   readOnly, systemOwned?, createdByBotId } ],
 *     "attachments": { "<botId>": ["<label>", ...] }
 *   }
 * Chu y: export theo LABEL (khong theo id) — id la duy nhat theo
 * may, label moi la dinh danh ben vung de import sang may khac.
 * Block he thong (systemOwned) duoc export binh thuong (de backup du)
 * nhung khi import chi user moi khoi phuc duoc co systemOwned
 * (store.setSystemOwned chan agent); import voi actor agent se tao
 * block thuong + ghi ro trong report.
 *
 * Quy tac import (an toan, khong ghi de len):
 *  - Label da ton tai: bo qua (ghi vao `skipped`), tru khi
 *    `overwrite=true` — khi do chi user moi duoc phep ghi de, va
 *    block dich dang read-only/systemOwned thi bi chan nhu moi
 *    thao tac sua khac (ghi vao `refused`).
 *  - Label khong hop le / noi dung vuot charLimit: bo qua, ghi vao
 *    `invalid` (khong throw ca file — mot block hong khong lam hong
 *    ca ban backup).
 *  - Attachment chi khoi phuc cho botId co trong file export; botId
 *    la (vd "") thi bo qua.
 *  - Moi block tao/ghi de deu di qua store.create/replace nen tu
 *    dong tang version + ghi audit + snapshot lich su nhu binh thuong.
 */

import { MemoryBlockStore, normalizeBlockLabel, isValidBlockLabel } from '../blocks';
import type { MemoryBlock } from '../blocks';

/** Loi export/import — message tieng Viet. */
export class V12BlocksIOError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V12BlocksIOError';
  }
}

/** Dinh danh format export (de import nhan dien file la cua minh). */
export const V12_BLOCKS_EXPORT_FORMAT = 'open-bot-memory-blocks';
/** Phien ban format export hien tai. */
export const V12_BLOCKS_EXPORT_VERSION = 1;

export interface V12ExportedBlock {
  label: string;
  description: string;
  content: string;
  charLimit: number;
  readOnly: boolean;
  systemOwned?: boolean;
  createdByBotId: string;
}

export interface V12BlocksExport {
  format: typeof V12_BLOCKS_EXPORT_FORMAT;
  version: typeof V12_BLOCKS_EXPORT_VERSION;
  exportedAt: string;
  blocks: V12ExportedBlock[];
  attachments: Record<string, string[]>;
}

export interface V12BlocksImportReport {
  /** So block da tao moi. */
  created: number;
  /** So block da ghi de (chi khi overwrite=true). */
  overwritten: number;
  /** Label block da ton tai nen bo qua (overwrite=false). */
  skipped: string[];
  /** Label block bi chan ghi de (read-only/systemOwned, actor agent). */
  refused: string[];
  /** Label block loi du lieu nen bo qua (kem ly do). */
  invalid: { label: string; reason: string }[];
  /** So attachment da khoi phuc (botId -> so block). */
  attachmentsRestored: Record<string, number>;
  /** Tong so block trong file export. */
  totalInFile: number;
}

export interface ImportBlocksOptions {
  /** true = ghi de block da ton tai (chi actor `user` moi duoc). */
  overwrite?: boolean;
  /** Chi import cac label nay (bo qua = import tat ca). */
  onlyLabels?: string[];
}

/**
 * Export toan bo block (kem attachment) thanh object JSON.
 * `botId` -> chi export block attach vao bot do (attachment cung chi
 * ghi bot do); khong truyen -> export tat ca.
 */
export function exportBlocks(
  store: MemoryBlockStore,
  botId?: string,
): V12BlocksExport {
  const blocks =
    botId !== undefined ? store.listAttached(botId) : store.list();
  const exported: V12ExportedBlock[] = blocks.map((b) => ({
    label: b.label,
    description: b.description,
    content: b.content,
    charLimit: b.charLimit,
    readOnly: b.readOnly,
    ...(b.systemOwned === true ? { systemOwned: true as const } : {}),
    createdByBotId: b.createdByBotId,
  }));
  const attachments: Record<string, string[]> = {};
  if (botId !== undefined) {
    const labels = blocks.map((b) => b.label);
    if (labels.length > 0) attachments[botId] = labels;
  } else {
    const all = store.list();
    const byId = new Map(all.map((b) => [b.id, b.label]));
    for (const block of all) {
      for (const attachedBot of store.attachedBotIds(block.id)) {
        const list = attachments[attachedBot] ?? [];
        const label = byId.get(block.id);
        if (label && !list.includes(label)) list.push(label);
        attachments[attachedBot] = list;
      }
    }
  }
  return {
    format: V12_BLOCKS_EXPORT_FORMAT,
    version: V12_BLOCKS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    blocks: exported,
    attachments,
  };
}

/** Export thanh chuoi JSON (de ghi file / copy). */
export function exportBlocksJson(store: MemoryBlockStore, botId?: string): string {
  return JSON.stringify(exportBlocks(store, botId), null, 2);
}

/** Kiem tra nhanh mot object co phai file export block hop le khong. */
export function isV12BlocksExport(value: unknown): value is V12BlocksExport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<V12BlocksExport>;
  return (
    v.format === V12_BLOCKS_EXPORT_FORMAT &&
    v.version === V12_BLOCKS_EXPORT_VERSION &&
    Array.isArray(v.blocks) &&
    typeof v.attachments === 'object' &&
    v.attachments !== null
  );
}

/**
 * Doc + kiem tra file export (JSON string). Sai format -> throw
 * V12BlocksIOError (khong ghi gi). Block hong le trong file khong
 * lam hong ca file — chung duoc ghi vao report.invalid luc import.
 */
export function parseBlocksExport(json: string): V12BlocksExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new V12BlocksIOError('File export không phải JSON hợp lệ.');
  }
  if (!isV12BlocksExport(parsed)) {
    throw new V12BlocksIOError(
      `File export không đúng định dạng (cần format "${V12_BLOCKS_EXPORT_FORMAT}" version ${V12_BLOCKS_EXPORT_VERSION}).`,
    );
  }
  return parsed;
}

function validateExportedBlock(raw: unknown): { block: V12ExportedBlock } | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'block không phải object' };
  }
  const b = raw as Partial<V12ExportedBlock>;
  const label = normalizeBlockLabel(typeof b.label === 'string' ? b.label : '');
  if (!isValidBlockLabel(label)) {
    return { error: `label không hợp lệ: ${JSON.stringify(b.label)}` };
  }
  if (typeof b.content !== 'string') {
    return { error: `label "${label}": content phải là chuỗi` };
  }
  const charLimit =
    typeof b.charLimit === 'number' && Number.isFinite(b.charLimit)
      ? Math.floor(b.charLimit)
      : 2000;
  if (b.content.length > Math.max(100, charLimit)) {
    return {
      error: `label "${label}": nội dung dài ${b.content.length} ký tự, vượt giới hạn ${charLimit}`,
    };
  }
  return {
    block: {
      label,
      description: typeof b.description === 'string' ? b.description : '',
      content: b.content,
      charLimit,
      readOnly: b.readOnly === true,
      ...(b.systemOwned === true ? { systemOwned: true as const } : {}),
      createdByBotId: typeof b.createdByBotId === 'string' ? b.createdByBotId : '',
    },
  };
}

/**
 * Import block tu object export (da qua parseBlocksExport). Tra
 * report chi tiet: tao moi / ghi de / bo qua / bi chan / loi.
 * Khong bao gio xoa block hien co (chi them hoac ghi de khi user
 * yeu cau ro rang).
 */
export function importBlocks(
  store: MemoryBlockStore,
  exported: V12BlocksExport,
  actor = 'user',
  opts: ImportBlocksOptions = {},
): V12BlocksImportReport {
  if (!isV12BlocksExport(exported)) {
    throw new V12BlocksIOError(
      `Dữ liệu import không đúng định dạng (cần format "${V12_BLOCKS_EXPORT_FORMAT}" version ${V12_BLOCKS_EXPORT_VERSION}).`,
    );
  }
  const onlyLabels =
    opts.onlyLabels !== undefined
      ? new Set(opts.onlyLabels.map((l) => normalizeBlockLabel(l)))
      : undefined;
  const report: V12BlocksImportReport = {
    created: 0,
    overwritten: 0,
    skipped: [],
    refused: [],
    invalid: [],
    attachmentsRestored: {},
    totalInFile: exported.blocks.length,
  };
  const importedLabels = new Set<string>();
  for (const raw of exported.blocks) {
    const checked = validateExportedBlock(raw);
    if ('error' in checked) {
      const label =
        typeof raw === 'object' && raw !== null && typeof (raw as { label?: unknown }).label === 'string'
          ? ((raw as { label: string }).label ?? '(không label)')
          : '(không label)';
      report.invalid.push({ label, reason: checked.error });
      continue;
    }
    const block = checked.block;
    if (onlyLabels !== undefined && !onlyLabels.has(block.label)) continue;
    importedLabels.add(block.label);
    const existing: MemoryBlock | null = store.get(block.label);
    if (existing) {
      if (opts.overwrite !== true) {
        report.skipped.push(block.label);
        continue;
      }
      // Ghi de: chi user; block dich read-only/systemOwned thi store chan.
      try {
        store.replace(block.label, block.content, actor);
        if (existing.description !== block.description) {
          store.update(block.label, { description: block.description }, actor);
        }
        if (block.systemOwned === true && actor === 'user') {
          store.setSystemOwned(block.label, true, actor);
          store.setReadOnly(block.label, true, actor);
        }
        report.overwritten += 1;
      } catch (err) {
        report.refused.push(block.label);
        void err;
      }
      continue;
    }
    try {
      const created = store.create(
        {
          label: block.label,
          description: block.description,
          content: block.content,
          charLimit: block.charLimit,
          readOnly: block.readOnly,
          ...(block.systemOwned === true && actor === 'user'
            ? { systemOwned: true as const }
            : {}),
          createdByBotId: block.createdByBotId,
        },
        actor,
      );
      // Block he thong import bang actor agent: tao thanh block
      // thuong (khong co systemOwned) — bao ve chi user moi dung len
      // duoc, khong tu dong phong qua import.
      void created;
      report.created += 1;
    } catch (err) {
      report.invalid.push({ label: block.label, reason: (err as Error).message });
    }
  }

  // Khoi phuc attachment (chi cho label vua import / da co trong store).
  for (const [botId, labels] of Object.entries(exported.attachments ?? {})) {
    const targetBot = (botId ?? '').trim();
    if (targetBot === '') continue;
    let restored = 0;
    for (const rawLabel of labels) {
      const label = normalizeBlockLabel(rawLabel);
      if (!isValidBlockLabel(label)) continue;
      if (onlyLabels !== undefined && !onlyLabels.has(label)) continue;
      const block = store.get(label);
      if (!block) continue;
      if (!store.isAttached(targetBot, block.id)) {
        try {
          store.attach(targetBot, block.id, actor);
          restored += 1;
        } catch {
          // Attach that bai (vd block vua bi xoa) — bo qua.
        }
      }
    }
    if (restored > 0) report.attachmentsRestored[targetBot] = restored;
  }
  return report;
}

/** Import tu chuoi JSON (tien ich: parse + import mot lan). */
export function importBlocksJson(
  store: MemoryBlockStore,
  json: string,
  actor = 'user',
  opts: ImportBlocksOptions = {},
): V12BlocksImportReport {
  return importBlocks(store, parseBlocksExport(json), actor, opts);
}
