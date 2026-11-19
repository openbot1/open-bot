/**
 * Memory v22 — Eval harness: kiem chung dreaming bang case co
 * dinh (v1.37, Doi T1).
 *
 * Y tuong (eval co san o v19/v21): dreaming kho kiem chung bang
 * mat thuong — can bo case co dinh, chay dreamer len tung case
 * va cham so lieu thuc te voi ky vong. Case nao lech thi fail
 * co ly do ro (ky vong bao nhieu, thuc te bao nhieu).
 *
 * Bo case mac dinh (6 case) bao phu toan bo pipeline:
 *  1. duplicate-pair — cap trung -> gop 1, con 1 active.
 *  2. numbers-review — cap giong nhau nhung so khac nhau ->
 *     KHONG tu gop (can xem lai), con 2 active.
 *  3. contradiction — cap mau thuan du manh -> supersede 1.
 *  4. weak-contradiction — cap mau thuan yeu -> khong tu thay.
 *  5. expiry — 1 fact qua han -> het han 1.
 *  6. pattern-repeat — 1 fact lap o 3 session (sau dedupe chi
 *     con keeper giu 3 session) -> pattern moi 1.
 *  7. mixed-dream — tron tat ca: gop 3, supersede 1, het han 1,
 *     pattern 1 (giong test end-to-end nhung chay qua eval).
 *
 * Khong goi model, khong goi mang. Chay hoan toan local, xac
 * dinh (now co dinh truyen vao).
 */
import type { V22DreamFactInput } from './types';
import { V22Dreamer } from './dreamer';

/** Mot case eval: seed + ky vong so lieu sau dream. */
export interface V22DreamEvalCase {
  /** Ten case (duy nhat). */
  name: string;
  /** Mo ta ngan de hien bao cao. */
  description: string;
  /** Fact seed (nap vao store truoc khi dream). */
  seed: V22DreamFactInput[];
  /** Ky vong (chi cac field co trong expect moi duoc cham). */
  expect: Partial<{
    duplicatesMerged: number;
    factsSuperseded: number;
    factsExpired: number;
    patternsCreated: number;
    factsAfter: number;
    wikiPages: number;
    errors: number;
  }>;
}

/** Ket qua mot case eval. */
export interface V22DreamEvalCaseResult {
  name: string;
  passed: boolean;
  /** Chi tiet lech (rong khi pass). */
  mismatches: string[];
  actual: {
    duplicatesMerged: number;
    factsSuperseded: number;
    factsExpired: number;
    patternsCreated: number;
    factsAfter: number;
    wikiPages: number;
    errors: number;
  };
}

/** Ket qua toan bo bo eval. */
export interface V22DreamEvalReport {
  at: number;
  total: number;
  passed: number;
  failed: number;
  results: V22DreamEvalCaseResult[];
}

/** Bo case mac dinh (7 case) — dung de kiem chung dreaming. */
export const V22_DREAM_EVAL_CASES: readonly V22DreamEvalCase[] = [
  {
    name: 'duplicate-pair',
    description: 'Cap fact trung lap -> gop 1, con 1 active.',
    seed: [
      { text: 'User thich ca phe den moi sang.', confidence: 0.9, sessionIds: ['s1'] },
      { text: 'User thich ca phe den moi sang khong duong.', confidence: 0.7, sessionIds: ['s2'] },
    ],
    expect: { duplicatesMerged: 1, factsAfter: 1, errors: 0 },
  },
  {
    name: 'numbers-review',
    description: 'Cap giong nhau nhung so khac nhau -> KHONG tu gop.',
    seed: [
      { text: 'Hop voi An luc 9h sang.', confidence: 0.9 },
      { text: 'Hop voi An luc 10h sang.', confidence: 0.85 },
    ],
    expect: { duplicatesMerged: 0, factsAfter: 2, errors: 0 },
  },
  {
    name: 'contradiction',
    description: 'Cap mau thuan du manh (gap 0.3) -> supersede 1.',
    seed: [
      { text: 'User thich uong tra dao.', topic: 'user|thich_uong', value: 'tra-dao', confidence: 0.6 },
      { text: 'Do uong yeu thich cua user hien la ca phe den.', topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.9 },
    ],
    expect: { factsSuperseded: 1, factsAfter: 1, errors: 0 },
  },
  {
    name: 'weak-contradiction',
    description: 'Cap mau thuan yeu (gap 0.02) -> khong tu thay, con 2 active.',
    seed: [
      { text: 'User o Ha Noi.', topic: 'user|dia_diem', value: 'ha-noi', confidence: 0.62 },
      { text: 'User o Da Nang.', topic: 'user|dia_diem', value: 'da-nang', confidence: 0.6 },
    ],
    expect: { factsSuperseded: 0, factsAfter: 2, errors: 0 },
  },
  {
    name: 'expiry',
    description: '1 fact qua han -> het han 1, con 1 active.',
    seed: [
      { text: 'User dang o Ha Noi den 20/11.', validUntil: 1794000000000 - 86_400_000 },
      { text: 'User thich ca phe.', validUntil: 1794000000000 + 30 * 86_400_000 },
    ],
    expect: { factsExpired: 1, factsAfter: 1, errors: 0 },
  },
  {
    name: 'pattern-repeat',
    description: '1 fact lap o 3 session -> pattern moi 1 (keeper + pattern = 2 active).',
    seed: [
      { text: 'User tap the duc buoi sang.', confidence: 0.8, sessionIds: ['s1'] },
      { text: 'User tap the duc buoi sang.', confidence: 0.8, sessionIds: ['s2'] },
      { text: 'User tap the duc buoi sang.', confidence: 0.8, sessionIds: ['s3'] },
    ],
    expect: { duplicatesMerged: 2, patternsCreated: 1, factsAfter: 2, errors: 0 },
  },
  {
    name: 'mixed-dream',
    description: 'Tron: gop 3, supersede 1, het han 1, pattern 1.',
    seed: [
      { text: 'User thich ca phe den moi sang.', confidence: 0.9, sessionIds: ['s1'] },
      { text: 'User thich ca phe den moi sang khong duong.', confidence: 0.7, sessionIds: ['s2'] },
      { text: 'User thich uong tra dao.', topic: 'user|thich_uong', value: 'tra-dao', confidence: 0.6 },
      { text: 'Do uong yeu thich cua user hien la ca phe den.', topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.9 },
      { text: 'User dang o Ha Noi den 20/11.', validUntil: 1794000000000 - 86_400_000 },
      { text: 'User tap the duc buoi sang.', confidence: 0.8, sessionIds: ['s1'] },
      { text: 'User tap the duc buoi sang.', confidence: 0.8, sessionIds: ['s2'] },
      { text: 'User tap the duc buoi sang.', confidence: 0.8, sessionIds: ['s3'] },
      { text: 'User thich pho bo Ha Noi.', topic: 'user|thich_an', value: 'pho-bo', confidence: 0.85 },
    ],
    expect: { duplicatesMerged: 3, factsSuperseded: 1, factsExpired: 1, patternsCreated: 1, factsAfter: 5, errors: 0 },
  },
];

/**
 * Chay mot case: nap seed vao dreamer moi, chay dream, cham
 * so lieu thuc te voi ky vong.
 */
export function runDreamEvalCaseV22(
  evalCase: V22DreamEvalCase,
  opts: { now?: number } = {},
): V22DreamEvalCaseResult {
  const now = opts.now ?? 1794000000000;
  const dreamer = new V22Dreamer();
  for (const input of evalCase.seed) {
    const res = dreamer.store.addFact(input, now);
    if (!res.ok) {
      return {
        name: evalCase.name,
        passed: false,
        mismatches: [`seed khong nap duoc: ${res.error ?? 'loi khong ro'}`],
        actual: { duplicatesMerged: 0, factsSuperseded: 0, factsExpired: 0, patternsCreated: 0, factsAfter: 0, wikiPages: 0, errors: 1 },
      };
    }
  }
  const report = dreamer.runDream('manual', { now });
  const actual = {
    duplicatesMerged: report.duplicatesMerged,
    factsSuperseded: report.factsSuperseded,
    factsExpired: report.factsExpired,
    patternsCreated: report.patternsCreated,
    factsAfter: report.factsAfter,
    wikiPages: report.wikiPages,
    errors: report.errors.length,
  };
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(evalCase.expect) as [keyof typeof actual, number][]) {
    if (actual[key] !== expected) {
      mismatches.push(`${key}: ky vong ${expected}, thuc te ${actual[key]}`);
    }
  }
  return { name: evalCase.name, passed: mismatches.length === 0, mismatches, actual };
}

/** Chay toan bo bo eval (mac dinh = bo case mac dinh). */
export function runDreamEvalV22(
  cases: readonly V22DreamEvalCase[] = V22_DREAM_EVAL_CASES,
  opts: { now?: number } = {},
): V22DreamEvalReport {
  const results = cases.map((c) => runDreamEvalCaseV22(c, opts));
  const passed = results.filter((r) => r.passed).length;
  return {
    at: opts.now ?? 1794000000000,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

/** Bao cao eval thanh text de doc. */
export function formatDreamEvalReportV22(report: V22DreamEvalReport): string {
  const lines: string[] = [];
  lines.push(`Dream eval: ${report.passed}/${report.total} case pass.`);
  for (const result of report.results) {
    if (result.passed) {
      lines.push(`- PASS ${result.name}`);
    } else {
      lines.push(`- FAIL ${result.name}: ${result.mismatches.join('; ')}`);
    }
  }
  return lines.join('\n');
}
