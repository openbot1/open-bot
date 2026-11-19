/**
 * Memory v23 — migration (v1.38, Doi T1).
 *
 * Dua du lieu memory cu vao store v23 ma khong mat thong tin:
 *  - V21PortableRecord -> V23MemoryRecord (map kind, giu version
 *    goc trong tags, giu valid window `staleAfter` -> validTo,
 *    giu sources, giu verified trong tags).
 *  - Legacy entry dang { text, kind?, confidence?, ... } (vd tu
 *    long-term memory cu, JSONL thu cong) -> V23MemoryRecord.
 *  - V20 core block dang { id, label, content } -> record kind=note.
 *
 * Migration la thuan tuy (khong ghi store): caller tu put tung
 * record (de kiem soat trung lap qua consolidator). Moi record
 * loi duoc bao cao rieng, khong lam hong ca dot.
 *
 * Scope mac dinh khi migrate: app-wide (rong) — du lieu cu khong
 * co scope ro rang, khong doan mo scope sai.
 */

import { normalizeV23Text } from './types';
import type { V23MemoryStore } from './store';
import type { V23MemoryRecord, V23NewRecordInput, V23RecordKind } from './types';
import { V23_RECORD_KINDS } from './types';

/** Dang toi thieu cua V21PortableRecord (khong import kieu v21 de tranh vong tron). */
export interface V23MigrationV21Record {
  id: string;
  type: string;
  title: string;
  body: string;
  tags?: string[];
  sources?: string[];
  verified?: { by: string; at: number; note?: string };
  staleAfter?: string;
  codeRefs?: string[];
  version?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** Dang legacy entry tu do (long-term / JSONL). */
export interface V23MigrationLegacyEntry {
  text: string;
  kind?: string;
  confidence?: number;
  source?: string;
  tags?: string[];
  entities?: string[];
  createdAt?: number;
  updatedAt?: number;
}

/** Dang V20 core block toi thieu. */
export interface V23MigrationV20Block {
  id: string;
  label?: string;
  content: string;
  updatedAt?: number;
}

/** Ket qua migrate mot dot. */
export interface V23MigrationResult {
  /** Input da chuyen thanh cong (san sang put vao store). */
  inputs: (V23NewRecordInput & { id: string; createdAt: number; updatedAt: number })[];
  /** So input loi (kem ly do). */
  skipped: number;
  errors: string[];
}

/** Map kind v21 -> kind v23 (v21 co them 'person'/'project'/'procedure'/'custom'). */
export function mapV21KindToV23(type: string): V23RecordKind {
  const lowered = (type ?? '').toLowerCase().trim();
  if ((V23_RECORD_KINDS as string[]).includes(lowered)) return lowered as V23RecordKind;
  if (lowered === 'custom') return 'note';
  return 'fact';
}

/** Map kind legacy tu do -> kind v23 (khong biet -> fact). */
export function mapLegacyKindToV23(kind: string | undefined): V23RecordKind {
  if (!kind) return 'fact';
  return mapV21KindToV23(kind);
}

/**
 * Migrate mot record v21 -> input v23. Giu lai: id goc (de
 * trace), title + body gop thanh text, tags goc + tag danh dau
 * `migrated:v21` + `v21-version:<n>` + `verified-by:<by>` (neu co),
 * sources -> tags `src:<source>` (rut gon, toi da 5), staleAfter
 * -> validTo, codeRefs -> tags `code:<ref>` (toi da 5).
 */
export function migrateV21RecordToV23(
  record: V23MigrationV21Record,
  now = Date.now(),
): { ok: true; input: V23NewRecordInput & { id: string; createdAt: number; updatedAt: number } } | { ok: false; error: string } {
  if (!record || typeof record !== 'object') return { ok: false, error: 'record v21 khong phai object.' };
  const body = normalizeV23Text(record.body ?? '');
  const title = normalizeV23Text(record.title ?? '');
  if (!body && !title) return { ok: false, error: `record ${record.id ?? '?'} rong (khong title/body).` };
  const text = title && body && title !== body ? `${title}: ${body}` : body || title;
  if (text.length > 2000) return { ok: false, error: `record ${record.id ?? '?'} vuot 2000 ky tu.` };
  const tags = [...(record.tags ?? []).map((t) => String(t).trim()).filter(Boolean)];
  tags.push('migrated:v21');
  if (record.version !== undefined) tags.push(`v21-version:${record.version}`);
  if (record.verified?.by) tags.push(`verified-by:${record.verified.by}`);
  for (const src of (record.sources ?? []).slice(0, 5)) tags.push(`src:${src}`);
  for (const ref of (record.codeRefs ?? []).slice(0, 5)) tags.push(`code:${ref}`);
  return {
    ok: true,
    input: {
      id: `v23-migrated-${record.id}`,
      kind: mapV21KindToV23(record.type),
      text,
      tags: [...new Set(tags)],
      confidence: 0.7,
      source: 'migrate-v21-v23',
      ...(record.staleAfter ? { validTo: record.staleAfter } : {}),
      createdAt: record.createdAt ?? now,
      updatedAt: record.updatedAt ?? now,
    },
  };
}

/** Migrate mot dot record v21 (bao cao tung loi). */
export function migrateV21RecordsToV23(
  records: V23MigrationV21Record[],
  now = Date.now(),
): V23MigrationResult {
  const inputs: V23MigrationResult['inputs'] = [];
  const errors: string[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const record of records) {
    const res = migrateV21RecordToV23(record, now);
    if (!res.ok) {
      skipped += 1;
      errors.push(res.error);
      continue;
    }
    if (seen.has(res.input.id)) {
      skipped += 1;
      errors.push(`trung id migrate: ${res.input.id}`);
      continue;
    }
    seen.add(res.input.id);
    inputs.push(res.input);
  }
  return { inputs, skipped, errors: errors.slice(0, 20) };
}

/** Migrate mot legacy entry tu do -> input v23. */
export function migrateLegacyEntryToV23(
  entry: V23MigrationLegacyEntry,
  now = Date.now(),
): { ok: true; input: V23NewRecordInput & { id: string; createdAt: number; updatedAt: number } } | { ok: false; error: string } {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'entry khong phai object.' };
  const text = normalizeV23Text(entry.text ?? '');
  if (!text) return { ok: false, error: 'entry rong.' };
  if (text.length > 2000) return { ok: false, error: 'entry vuot 2000 ky tu.' };
  const confidence = typeof entry.confidence === 'number' && entry.confidence >= 0 && entry.confidence <= 1
    ? entry.confidence
    : 0.6;
  return {
    ok: true,
    input: {
      id: `v23-legacy-${Math.abs(hashStringV23(text)).toString(36)}`,
      kind: mapLegacyKindToV23(entry.kind),
      text,
      tags: [...new Set([...(entry.tags ?? []), 'migrated:legacy'])],
      entities: entry.entities ?? [],
      confidence,
      source: entry.source ?? 'migrate-legacy-v23',
      createdAt: entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
    },
  };
}

/** Migrate mot dot legacy entry (bao cao tung loi). */
export function migrateLegacyEntriesToV23(
  entries: V23MigrationLegacyEntry[],
  now = Date.now(),
): V23MigrationResult {
  const inputs: V23MigrationResult['inputs'] = [];
  const errors: string[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const res = migrateLegacyEntryToV23(entry, now);
    if (!res.ok) {
      skipped += 1;
      errors.push(res.error);
      continue;
    }
    if (seen.has(res.input.id)) {
      skipped += 1;
      errors.push(`trung id migrate: ${res.input.id}`);
      continue;
    }
    seen.add(res.input.id);
    inputs.push(res.input);
  }
  return { inputs, skipped, errors: errors.slice(0, 20) };
}

/** Migrate mot V20 core block -> input v23 (kind=note). */
export function migrateV20BlockToV23(
  block: V23MigrationV20Block,
  now = Date.now(),
): { ok: true; input: V23NewRecordInput & { id: string; createdAt: number; updatedAt: number } } | { ok: false; error: string } {
  if (!block || typeof block !== 'object') return { ok: false, error: 'block khong phai object.' };
  const text = normalizeV23Text(block.content ?? '');
  if (!text) return { ok: false, error: `block ${block.id ?? '?'} rong.` };
  if (text.length > 2000) return { ok: false, error: `block ${block.id ?? '?'} vuot 2000 ky tu.` };
  const label = normalizeV23Text(block.label ?? '');
  return {
    ok: true,
    input: {
      id: `v23-migrated-block-${block.id}`,
      kind: 'note',
      text,
      tags: [...new Set(['migrated:v20-block', ...(label ? [`block:${label}`] : [])])],
      confidence: 0.6,
      source: 'migrate-v20-block-v23',
      createdAt: block.updatedAt ?? now,
      updatedAt: block.updatedAt ?? now,
    },
  };
}

/** Hash don gian (FNV-1a) dung lam id legacy on dinh theo text. */
export function hashStringV23(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Kiem tra xem mot V23MemoryRecord co phai hang migrate khong
 * (de UI loc / bao cao ty le migrate).
 */
export function isMigratedV23Record(record: V23MemoryRecord): boolean {
  return record.tags.some((t) => t.startsWith('migrated:'));
}

/**
 * Ap dung ket qua migrate vao store: put tung input, bo qua id da
 * co trong store (khong ghi de du lieu hien tai). Tra so put duoc
 * + so bo qua + loi put (neu co).
 */
export function applyMigrationToStoreV23(
  store: V23MemoryStore,
  result: V23MigrationResult,
): { put: number; skippedExisting: number; errors: string[] } {
  let put = 0;
  let skippedExisting = 0;
  const errors: string[] = [];
  for (const input of result.inputs) {
    if (store.get(input.id)) {
      skippedExisting += 1;
      continue;
    }
    const res = store.put({
      id: input.id,
      kind: input.kind,
      text: input.text,
      tags: input.tags,
      entities: input.entities,
      confidence: input.confidence,
      source: input.source,
      ...(input.validTo ? { validTo: input.validTo } : {}),
    });
    if (res.ok) put += 1;
    else errors.push(`${input.id}: ${res.error ?? 'put loi'}`);
  }
  return { put, skippedExisting, errors: errors.slice(0, 20) };
}
