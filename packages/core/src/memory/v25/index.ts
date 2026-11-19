/**
 * Memory v25 — barrel export (v1.40, Doi T1).
 *
 * Sleep-time consolidation agent (chay nen sau N buoc, cap nhat
 * memory block ngoai vong lap chinh, model + budget cau hinh
 * duoc) + memory block chia se giua cac bot (label/mo ta/gia tri,
 * attach/detach, read-only: bot khac chi doc) + fact edge
 * bi-temporal (valid_at/invalid_at/created_at/expired_at, supersede
 * dong khoang hieu luc thay vi xoa, query "dung tai X" va "hien
 * tai") + LLM judge ADD/UPDATE/DELETE/NOISE kieu Mem0 (DELETE la
 * dong hieu luc, khong xoa vat ly).
 *
 * Y tuong hoc tu survey v140 muc 2 + 3 + 4 — tu thiet ke lai hoan
 * toan cho open-bot, KHONG copy code/text/tai san cua bat ky repo
 * nao. Chay 100% local voi judge mac dinh (rule-based).
 */
export * from './types';
export * from './factEdges';
export * from './judge';
export * from './sharedBlocks';
export * from './sleep';
export * from './store';
export * from './pipeline';

/** Phien ban memory v25. */
export const V25_VERSION = '25.0.0';
