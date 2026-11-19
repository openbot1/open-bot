/**
 * Memory v22 — barrel export (v1.37, Doi T1).
 *
 * Dreaming consolidation: luot chay nen ngoai critical path cua
 * chat — gop trung lap, supersede fact mau thuan, het han fact
 * co thoi han, tong hop pattern lap lai thanh fact ben, xay wiki
 * representation, giu lop always-loaded duoi ngan sach ky tu,
 * moi thay doi revert duoc (snapshot + audit log + rollback).
 *
 * Y tuong hoc tu Anthropic Dreams for Claude Managed Agents,
 * Mem0 Dream, Letta dreaming / sleep-time compute — tu thiet ke
 * lai hoan toan cho open-bot, KHONG copy code/text/tai san cua
 * bat ky repo nao.
 */
export * from './types';
export * from './store';
export * from './dedupe';
export * from './supersede';
export * from './expiry';
export * from './patterns';
export * from './wiki';
export * from './budget';
export * from './snapshot';
export * from './scheduler';
export * from './collect';
export * from './report';
export * from './eval';
export * from './dreamer';
