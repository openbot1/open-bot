/**
 * Memory eval suite (v1.06, Đội T6).
 *
 * Kiểm tra bộ nhớ dài hạn + memory block bằng code thật
 * (`LongTermMemory`, `MemoryBlockStore`) trong một workspace tạm —
 * không dùng dữ liệu thật của user, không cần model/embedding.
 *
 * Ba nhóm case:
 *
 * 1. Recall đúng fact sau N lượt — ghi 5 fact mục tiêu, rồi ghi thêm
 *    N fact gây nhiễu ("N lượt" hội thoại khác chen vào), sau đó recall
 *    từng fact mục tiêu theo query: tất cả phải tìm lại được, và fact
 *    đứng đầu phải là fact đúng (không bị nhiễu lấn).
 * 2. Tier promotion — LƯU Ý TRUNG THỰC: repo hiện KHÔNG có khái niệm
 *    tier cho memory (không có field tier, không có promotion trong
 *    `memory/*`). Suite này định nghĩa tier ngay trong module eval
 *    (ephemeral → working → durable, theo số lần recall thành công +
 *    confidence) và kiểm tra LUẬT ĐÓ: recall lặp lại thì promote,
 *    recall một lần không promote lên durable, mâu thuẫn (ghi đè value
 *    khác) thì demote. Luật này là đề xuất chuẩn cho memory v4/v5 về
 *    sau — eval không giả vờ repo đã có tier.
 * 3. Block edit không làm mất fact — tạo block chứa 3 fact, sửa block
 *    (thêm fact thứ 4): 3 fact gốc còn nguyên, version +1; block
 *    read-only thì sửa bị chặn và nội dung không đổi.
 *
 * Thêm 2 case nền: scope isolation (fact của bot A không recall được
 * dưới scope bot B) và overwrite giữ id (ghi đè cùng key giữ id cũ,
 * value mới recall được).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LongTermMemory, type LongTermMemoryEntry } from '../memory/longterm';
import { MemoryBlockStore } from '../memory/blocks';
import { buildEvalSuiteResult, runEvalCase, type EvalCaseResult, type EvalSuiteResult } from './types';

/** Các tier của một memory entry (định nghĩa trong eval — xem header). */
export type MemoryTier = 'ephemeral' | 'working' | 'durable';

export const MEMORY_TIERS: readonly MemoryTier[] = ['ephemeral', 'working', 'durable'];

/** Số lần recall thành công để lên tier (ngưỡng của luật eval). */
export const TIER_PROMOTE_RECALLS: Record<MemoryTier, number> = {
  ephemeral: 0,
  working: 3,
  durable: 8,
};
/** Confidence tối thiểu để được xét promote lên durable. */
export const TIER_DURABLE_MIN_CONFIDENCE = 0.8;

/**
 * Tier của một entry theo số lần recall thành công + confidence
 * (pure — dễ test, dễ dùng lại cho memory v4/v5 sau này):
 * - < 3 recall → ephemeral;
 * - >= 3 recall → working;
 * - >= 8 recall VÀ confidence >= 0.8 → durable.
 */
export function memoryTierFor(
  entry: Pick<LongTermMemoryEntry, 'confidence'>,
  successfulRecalls: number,
): MemoryTier {
  const recalls = Math.max(0, Math.floor(successfulRecalls));
  if (recalls >= TIER_PROMOTE_RECALLS.durable && entry.confidence >= TIER_DURABLE_MIN_CONFIDENCE) {
    return 'durable';
  }
  if (recalls >= TIER_PROMOTE_RECALLS.working) return 'working';
  return 'ephemeral';
}

/** Tier tiếp theo sau một lần recall thành công nữa (hoặc giữ nguyên). */
export function promoteTierOnRecall(
  entry: Pick<LongTermMemoryEntry, 'confidence'>,
  successfulRecalls: number,
): MemoryTier {
  return memoryTierFor(entry, successfulRecalls + 1);
}

/**
 * Tier sau khi entry bị mâu thuẫn (value bị ghi đè khác, hoặc user
 * phủ nhận): durable → working, working → ephemeral, ephemeral giữ
 * nguyên. Mâu thuẫn không xoá fact — chỉ hạ độ tin cậy của tier.
 */
export function demoteTierOnContradiction(tier: MemoryTier): MemoryTier {
  if (tier === 'durable') return 'working';
  if (tier === 'working') return 'ephemeral';
  return 'ephemeral';
}

/** Số lượt nhiễu mặc định cho case recall (20 lượt). */
export const MEMORY_EVAL_DEFAULT_DISTRACTOR_TURNS = 20;
/** Số lượt nhiễu cho case recall nặng (50 lượt). */
export const MEMORY_EVAL_HEAVY_DISTRACTOR_TURNS = 50;

const TARGET_FACTS: Array<{ key: string; value: string }> = [
  { key: 'user-favourite-drink', value: 'user likes iced Vietnamese coffee with condensed milk' },
  { key: 'user-work-hours', value: 'user works from 9am to 6pm on weekdays' },
  { key: 'user-pet-name', value: 'user has a cat named Mimi' },
  { key: 'user-hometown', value: 'user hometown is Da Lat in Vietnam' },
  { key: 'user-language', value: 'user prefers Vietnamese for daily chat' },
];

function tmpWorkspaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memory-eval-'));
}

function seedTargets(memory: LongTermMemory, botId: string): void {
  for (const fact of TARGET_FACTS) {
    memory.remember({ key: fact.key, value: fact.value, tags: ['eval-target'], confidence: 0.9, botId });
  }
}

function seedDistractors(memory: LongTermMemory, botId: string, turns: number): void {
  for (let i = 0; i < turns; i += 1) {
    memory.remember({
      key: `distractor-turn-${i}`,
      value: `unrelated chatter turn ${i} about weather and traffic news`,
      tags: ['eval-distractor'],
      confidence: 0.5,
      botId,
    });
  }
}

/** Kiểm tra một fact mục tiêu recall được (query theo value, top hit phải chứa value). */
function factRecalled(memory: LongTermMemory, botId: string, fact: { key: string; value: string }): { found: boolean; topIsTarget: boolean } {
  const hits = memory.recall({ query: fact.value, botId, limit: 5 });
  const found = hits.some((h) => h.key === fact.key && h.value === fact.value);
  const topIsTarget = hits.length > 0 && hits[0].key === fact.key;
  return { found, topIsTarget };
}

async function caseRecallAfterTurns(turns: number): Promise<{ passed: boolean; detail: string }> {
  const dir = tmpWorkspaceDir();
  try {
    const memory = new LongTermMemory(dir);
    seedTargets(memory, 'eval-bot');
    seedDistractors(memory, 'eval-bot', turns);
    const missed: string[] = [];
    const notTop: string[] = [];
    for (const fact of TARGET_FACTS) {
      const { found, topIsTarget } = factRecalled(memory, 'eval-bot', fact);
      if (!found) missed.push(fact.key);
      else if (!topIsTarget) notTop.push(fact.key);
    }
    const passed = missed.length === 0 && notTop.length === 0;
    return {
      passed,
      detail: passed
        ? `all ${TARGET_FACTS.length} target facts recalled top-1 after ${turns} distractor turns`
        : `missed=[${missed.join(',')}] not-top-1=[${notTop.join(',')}] after ${turns} distractor turns`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function caseTierPromotion(): Promise<{ passed: boolean; detail: string }> {
  const entry = { confidence: 0.9 };
  const checks: Array<[string, boolean]> = [
    ['0 recalls -> ephemeral', memoryTierFor(entry, 0) === 'ephemeral'],
    ['2 recalls -> ephemeral', memoryTierFor(entry, 2) === 'ephemeral'],
    ['3 recalls -> working', memoryTierFor(entry, 3) === 'working'],
    ['7 recalls -> working', memoryTierFor(entry, 7) === 'working'],
    ['8 recalls + conf 0.9 -> durable', memoryTierFor(entry, 8) === 'durable'],
    ['8 recalls + conf 0.5 -> working (not durable)', memoryTierFor({ confidence: 0.5 }, 8) === 'working'],
    ['promote on recall 2->3 reaches working', promoteTierOnRecall(entry, 2) === 'working'],
    ['promote on recall 7->8 reaches durable', promoteTierOnRecall(entry, 7) === 'durable'],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'tier promotion thresholds hold (3 recalls -> working, 8 recalls + conf>=0.8 -> durable)'
      : `tier checks failed: [${failed.join('; ')}]`,
  };
}

async function caseTierNoFalsePromotion(): Promise<{ passed: boolean; detail: string }> {
  const entry = { confidence: 1 };
  const tier = memoryTierFor(entry, 1);
  const demotedDurable = demoteTierOnContradiction('durable');
  const demotedWorking = demoteTierOnContradiction('working');
  const demotedEphemeral = demoteTierOnContradiction('ephemeral');
  const passed =
    tier === 'ephemeral' && demotedDurable === 'working' && demotedWorking === 'ephemeral' && demotedEphemeral === 'ephemeral';
  return {
    passed,
    detail: passed
      ? 'single recall never promotes to durable; contradiction demotes one tier (durable->working->ephemeral)'
      : `tier=${tier} demote durable->${demotedDurable} working->${demotedWorking} ephemeral->${demotedEphemeral}`,
  };
}

async function caseBlockEditPreservesFacts(): Promise<{ passed: boolean; detail: string }> {
  const dir = tmpWorkspaceDir();
  try {
    const store = new MemoryBlockStore(dir);
    const facts = [
      'fact one: user likes iced coffee',
      'fact two: user works 9 to 6',
      'fact three: user cat is Mimi',
    ];
    const created = store.create(
      { label: 'eval-profile', description: 'eval block', content: facts.join('\n') },
      'eval',
    );
    const updated = store.update(
      'eval-profile',
      { content: `${created.content}\nfact four: user hometown is Da Lat` },
      'eval',
    );
    const missing = facts.filter((f) => !updated.content.includes(f));
    const passed = missing.length === 0 && updated.version === created.version + 1 && updated.content.includes('fact four');
    return {
      passed,
      detail: passed
        ? `block edit kept all ${facts.length} original facts, version ${created.version} -> ${updated.version}`
        : `missing facts after edit: [${missing.join('; ')}], version ${created.version} -> ${updated.version}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function caseBlockReadonlyBlocked(): Promise<{ passed: boolean; detail: string }> {
  const dir = tmpWorkspaceDir();
  try {
    const store = new MemoryBlockStore(dir);
    store.create(
      { label: 'eval-locked', description: 'locked block', content: 'fact: user likes iced coffee' },
      'eval',
    );
    store.setReadOnly('eval-locked', true, 'eval');
    let threw = false;
    try {
      store.update('eval-locked', { content: 'fact: overwritten' }, 'eval');
    } catch {
      threw = true;
    }
    const after = store.get('eval-locked');
    const passed = threw && after !== null && after.content === 'fact: user likes iced coffee';
    return {
      passed,
      detail: passed
        ? 'read-only block rejected the edit and kept its original content'
        : `read-only edit threw=${threw}, content after=${after?.content ?? 'null'}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function caseScopeIsolation(): Promise<{ passed: boolean; detail: string }> {
  const dir = tmpWorkspaceDir();
  try {
    const memory = new LongTermMemory(dir);
    memory.remember({ key: 'bot-a-secret', value: 'bot A private preference alpha', tags: ['eval'], confidence: 0.9, botId: 'bot-a' });
    const underB = memory.recall({ query: 'private preference alpha', botId: 'bot-b', limit: 10 });
    const leaked = underB.some((h) => h.key === 'bot-a-secret');
    const underA = memory.recall({ query: 'private preference alpha', botId: 'bot-a', limit: 10 });
    const foundUnderA = underA.some((h) => h.key === 'bot-a-secret');
    const passed = !leaked && foundUnderA;
    return {
      passed,
      detail: passed
        ? 'bot A fact recalled under bot A scope, not leaked under bot B scope'
        : `leaked-under-B=${leaked} found-under-A=${foundUnderA}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function caseOverwriteKeepsId(): Promise<{ passed: boolean; detail: string }> {
  const dir = tmpWorkspaceDir();
  try {
    const memory = new LongTermMemory(dir);
    const first = memory.remember({ key: 'user-drink', value: 'user likes tea', tags: ['eval'], confidence: 0.7, botId: 'eval-bot' });
    const second = memory.remember({ key: 'user-drink', value: 'user likes iced coffee', tags: ['eval'], confidence: 0.9, botId: 'eval-bot' });
    const hits = memory.recall({ query: 'iced coffee', botId: 'eval-bot', limit: 5 });
    const recalled = hits.some((h) => h.key === 'user-drink' && h.value === 'user likes iced coffee');
    const passed = first.id === second.id && recalled;
    return {
      passed,
      detail: passed
        ? 'overwrite kept the same entry id and the new value is recalled'
        : `id kept=${first.id === second.id} new value recalled=${recalled}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Chạy toàn bộ suite memory eval. `workspaceDir` chỉ dùng khi caller muốn giữ lại dữ liệu (mặc định dùng thư mục tạm riêng từng case). */
export async function runMemoryEval(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];
  cases.push(await runEvalCase('memory.recall-after-20-turns', 'Recall facts after 20 distractor turns', () => caseRecallAfterTurns(MEMORY_EVAL_DEFAULT_DISTRACTOR_TURNS)));
  cases.push(await runEvalCase('memory.recall-after-50-turns', 'Recall facts after 50 distractor turns', () => caseRecallAfterTurns(MEMORY_EVAL_HEAVY_DISTRACTOR_TURNS)));
  cases.push(await runEvalCase('memory.tier-promotion', 'Tier promotion thresholds', caseTierPromotion));
  cases.push(await runEvalCase('memory.tier-no-false-promotion', 'No false promotion; contradiction demotes', caseTierNoFalsePromotion));
  cases.push(await runEvalCase('memory.block-edit-preserves-facts', 'Block edit keeps original facts', caseBlockEditPreservesFacts));
  cases.push(await runEvalCase('memory.block-readonly-blocked', 'Read-only block rejects edits', caseBlockReadonlyBlocked));
  cases.push(await runEvalCase('memory.scope-isolation', 'Bot scope isolation', caseScopeIsolation));
  cases.push(await runEvalCase('memory.overwrite-keeps-id', 'Overwrite keeps entry id', caseOverwriteKeepsId));
  return buildEvalSuiteResult('memory', startedAt, cases);
}
