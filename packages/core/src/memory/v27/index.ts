/**
 * Memory v27 — barrel export (v1.42, Doi T3).
 *
 * Add-only single-pass extraction (Mem0 v3-style) + entity
 * linking luc ghi + boosting luc search + bi-temporal fact
 * graph (Graphiti-style: valid_at/invalid_at/created_at/
 * expired_at, dong edge cu thay vi xoa) + episode provenance
 * + time-travel chat (valid time + transaction time) + shared
 * memory block bi-temporal tren nen v26 (Letta-style).
 *
 * Y tuong hoc tu survey v142 muc 3 — tu thiet ke lai hoan
 * toan cho open-bot, KHONG copy code/text/tai san cua bat ky
 * repo nao. Chay 100% local (khong goi model/mang); diem
 * "embedding" trong search la lexical proxy xac dinh.
 */
export * from './types';
export * from './extraction';
export * from './entities';
export * from './graph';
export * from './episodes';
export * from './search';
export * from './sharedBlocks';
export * from './store';
export * from './pipeline';
export * from './panel';

/** Phien ban memory v27. */
export const V27_VERSION = '27.0.0';
