/**
 * Memory v23 — eval harness (v1.38, Doi T1).
 *
 * Bo case eval offline (khong can model, khong can mang) cho 5
 * nhom: extract / fusion / scope / sleep / procedural. Moi case co
 * input + dieu kien pass cu the; harness chay va tra bao cao.
 * Dung de kiem chung hoi quy sau moi thay doi (coordinator co the
 * chay lai bat cu luc nao, khong can Ollama).
 */

import { extractV23Candidates } from './extractor';
import { fuseV23 } from './fusion';
import { V23LocalEmbedder } from './localEmbedder';
import { V23ProceduralStore } from './procedural';
import { retrieveV23Scoped } from './scopedRetrievalV23';
import { V23SleepConsolidator } from './sleepV2';
import { V23MemoryStore } from './store';
import type { V23EvalCase, V23EvalResult, V23EvalSummary } from './types';

/** Cac case eval co dinh cua v23 (30 case). */
export const V23_EVAL_CASES: readonly V23EvalCase[] = [
  // --- extract (6) ---
  { id: 'v23-extract-01', group: 'extract', name: 'Nhan preference tieng Viet', input: [{ role: 'user', text: 'Toi thich ca phe den, khong duong.' }], expect: '>= 1 candidate kind=preference' },
  { id: 'v23-extract-02', group: 'extract', name: 'Nhan decision tieng Anh', input: [{ role: 'user', text: 'We decided to use Postgres for the new service.' }], expect: '>= 1 candidate kind=decision' },
  { id: 'v23-extract-03', group: 'extract', name: 'Bo chao hoi / cam on', input: [{ role: 'user', text: 'Chao ban! Cam on ban rat nhieu.' }], expect: '0 candidate' },
  { id: 'v23-extract-04', group: 'extract', name: 'Nhan procedure co buoc', input: [{ role: 'user', text: 'Cach lam: buoc 1 mo file config, buoc 2 sua port thanh 8080.' }], expect: '>= 1 candidate kind=procedure' },
  { id: 'v23-extract-05', group: 'extract', name: 'Cau agent khong thanh preference cua user', input: [{ role: 'agent', text: 'Toi thich lam viec voi ban.' }], expect: '0 candidate preference' },
  { id: 'v23-extract-06', group: 'extract', name: 'Dedupe cau lap', input: [{ role: 'user', text: 'Toi thich ca phe den. Toi thich ca phe den.' }], expect: '1 candidate cho cau lap' },
  // --- fusion (6) ---
  { id: 'v23-fusion-01', group: 'fusion', name: 'BM25 tim dung record theo tu khoa', input: { query: 'ca phe den', seed: ['User thich ca phe den khong duong.', 'Du an dung Postgres lam database.', 'Thoi tiet Ha Noi hom nay mua.'] }, expect: 'top1 chua "ca phe"' },
  { id: 'v23-fusion-02', group: 'fusion', name: 'Entity boost: ten rieng thang', input: { query: 'Ha Noi', seed: ['Thoi tiet Ha Noi hom nay mua to.', 'User thich ca phe den.', 'Du an dung Postgres.'] }, expect: 'top1 chua "Ha Noi"' },
  { id: 'v23-fusion-03', group: 'fusion', name: 'Query rong tra []', input: { query: '   ', seed: ['User thich ca phe den.'] }, expect: '0 hit' },
  { id: 'v23-fusion-04', group: 'fusion', name: 'Record het han bi loai', input: { query: 'ca phe', seed: ['User thich ca phe den.'], validTo: '2020-01-01' }, expect: '0 hit' },
  { id: 'v23-fusion-05', group: 'fusion', name: 'Giai thich co du 3 tin hieu', input: { query: 'ca phe', seed: ['User thich ca phe den khong duong.'] }, expect: 'explanation chua semantic/bm25/entity' },
  { id: 'v23-fusion-06', group: 'fusion', name: 'Khong embedder van tra ket qua BM25', input: { query: 'Postgres', seed: ['Du an dung Postgres lam database.', 'User thich ca phe den.'] }, expect: 'top1 chua "Postgres"' },
  // --- scope (6) ---
  { id: 'v23-scope-01', group: 'scope', name: 'Run thay duoc record cua agent', input: { query: 'ca phe', scope: { userId: 'u1', agentId: 'bot1', runId: 'run1' }, seedScope: { userId: 'u1', agentId: 'bot1', runId: '' } }, expect: '>= 1 hit' },
  { id: 'v23-scope-02', group: 'scope', name: 'User khac khong thay record run rieng', input: { query: 'ca phe', scope: { userId: 'u2', agentId: 'bot1', runId: '' }, seedScope: { userId: 'u1', agentId: 'bot1', runId: 'run1' } }, expect: '0 hit' },
  { id: 'v23-scope-03', group: 'scope', name: 'Record app-wide thay o moi scope', input: { query: 'ca phe', scope: { userId: 'u9', agentId: 'bot9', runId: 'run9' }, seedScope: { userId: '', agentId: '', runId: '' } }, expect: '>= 1 hit' },
  { id: 'v23-scope-04', group: 'scope', name: 'Query rong tra recent theo scope', input: { query: '', scope: { userId: 'u1', agentId: '', runId: '' }, seedScope: { userId: 'u1', agentId: '', runId: '' } }, expect: '>= 1 hit' },
  { id: 'v23-scope-05', group: 'scope', name: 'Dedupe cung fact o 2 scope', input: { query: 'ca phe', scope: { userId: 'u1', agentId: 'bot1', runId: 'run1' }, seedScope: { userId: 'u1', agentId: 'bot1', runId: '' }, seedScope2: { userId: 'u1', agentId: '', runId: '' } }, expect: '1 hit, mergedSources >= 1' },
  { id: 'v23-scope-06', group: 'scope', name: 'Scope weight: run > user', input: { query: 'ca phe', scope: { userId: 'u1', agentId: 'bot1', runId: 'run1' }, seedScope: { userId: 'u1', agentId: '', runId: '' }, seedScope2: { userId: 'u1', agentId: 'bot1', runId: 'run1' } }, expect: 'hit run dung truoc hit user' },
  // --- sleep (6) ---
  { id: 'v23-sleep-01', group: 'sleep', name: 'Decay giam confidence record cu', input: { ageDays: 60, confidence: 0.8 }, expect: 'confidence sau < 0.8' },
  { id: 'v23-sleep-02', group: 'sleep', name: 'Merge cap trung lap', input: { a: 'User thich ca phe den khong duong moi sang.', b: 'User thich ca phe den khong duong vao buoi sang.' }, expect: 'merged >= 1' },
  { id: 'v23-sleep-03', group: 'sleep', name: 'Promote record duoc retrieval nhieu', input: { retrievals: 5, confidence: 0.5 }, expect: 'promoted >= 1' },
  { id: 'v23-sleep-04', group: 'sleep', name: 'Stale theo validTo', input: { validTo: '2020-01-01' }, expect: 'markedStale >= 1' },
  { id: 'v23-sleep-05', group: 'sleep', name: 'Budget dung pass khi het ops', input: { maxOps: 1, records: 5 }, expect: 'budgetHit = true' },
  { id: 'v23-sleep-06', group: 'sleep', name: 'Store rong chay khong loi', input: {}, expect: 'scanned = 0, khong throw' },
  // --- procedural (6) ---
  { id: 'v23-proc-01', group: 'procedural', name: '3 success -> candidate skill', input: { workflow: 'deploy-preview', successes: 3 }, expect: 'skill ton tai, status=candidate' },
  { id: 'v23-proc-02', group: 'procedural', name: 'Failure rieng khong tao skill', input: { workflow: 'deploy-preview', successes: 0, failures: 1 }, expect: 'khong co skill' },
  { id: 'v23-proc-03', group: 'procedural', name: 'Approve candidate -> active', input: { workflow: 'deploy-preview', successes: 3, approve: true }, expect: 'status=active' },
  { id: 'v23-proc-04', group: 'procedural', name: 'Steps cai tien tang version', input: { workflow: 'fix-flaky-test', successes: 3, improvedSteps: true }, expect: 'version >= 2' },
  { id: 'v23-proc-05', group: 'procedural', name: 'Search skill theo tu khoa', input: { workflow: 'deploy-preview', successes: 3, query: 'deploy preview' }, expect: '>= 1 ket qua' },
  { id: 'v23-proc-06', group: 'procedural', name: 'Rating thap -> deprecate', input: { workflow: 'deploy-preview', successes: 3, ratings: [1, 1, 1] }, expect: 'status=deprecated' },
];

/** Co so thoi gian co dinh cho eval (de ket qua on dinh). */
export const V23_EVAL_NOW = 1794000000000;

function attempt(
  workflow: string,
  outcome: 'success' | 'failure',
  steps: string[],
  durationMs = 1000,
  ranAt = V23_EVAL_NOW,
): Parameters<V23ProceduralStore['recordAttempt']>[0] {
  return { workflow, steps, toolsUsed: ['shell_exec'], outcome, durationMs, ranAt };
}

async function runCaseV23(c: V23EvalCase): Promise<V23EvalResult> {
  const fail = (detail: string): V23EvalResult => ({ caseId: c.id, group: c.group, passed: false, detail });
  const pass = (detail: string): V23EvalResult => ({ caseId: c.id, group: c.group, passed: true, detail });
  try {
    const input = c.input as Record<string, unknown>;
    if (c.group === 'extract') {
      const candidates = extractV23Candidates(
        (input as unknown as { role: 'user' | 'agent' | 'system'; text: string }[]),
      );
      if (c.id === 'v23-extract-01') {
        return candidates.some((x) => x.kind === 'preference')
          ? pass(`${candidates.length} candidate, co preference`)
          : fail(`khong co preference trong ${candidates.length} candidate`);
      }
      if (c.id === 'v23-extract-02') {
        return candidates.some((x) => x.kind === 'decision')
          ? pass('co decision')
          : fail('khong co decision');
      }
      if (c.id === 'v23-extract-03') {
        return candidates.length === 0 ? pass('0 candidate') : fail(`${candidates.length} candidate`);
      }
      if (c.id === 'v23-extract-04') {
        return candidates.some((x) => x.kind === 'procedure')
          ? pass('co procedure')
          : fail('khong co procedure');
      }
      if (c.id === 'v23-extract-05') {
        return candidates.some((x) => x.kind === 'preference')
          ? fail('agent tao preference (sai)')
          : pass('khong co preference tu agent');
      }
      return candidates.length === 1
        ? pass('dedupe: 1 candidate')
        : fail(`${candidates.length} candidate, ky vong 1`);
    }

    if (c.group === 'fusion') {
      const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
      const seeds = input.seed as string[];
      const validTo = input.validTo as string | undefined;
      for (const text of seeds) {
        store.put({
          text,
          confidence: 0.7,
          source: 'eval',
          ...(validTo ? { validTo } : {}),
        });
      }
      const useEmbedder = c.id !== 'v23-fusion-06';
      const embedder = useEmbedder ? new V23LocalEmbedder({ embedder: { embed: async () => [0, 0, 0] } }) : undefined;
      // Embedder gia tra vector 0 de semantic = 0, BM25/entity quyet dinh.
      const hits = await fuseV23(store.listActive(), String(input.query ?? ''), embedder, {
        entityIndex: store.getEntityIndex(),
        now: () => V23_EVAL_NOW,
      });
      if (c.id === 'v23-fusion-01') {
        return hits[0]?.record.text.includes('ca phe')
          ? pass(`top1: ${hits[0].record.text}`)
          : fail(`top1 sai: ${hits[0]?.record.text ?? '(rong)'}`);
      }
      if (c.id === 'v23-fusion-02') {
        return hits[0]?.record.text.includes('Ha Noi')
          ? pass(`top1: ${hits[0].record.text}`)
          : fail(`top1 sai: ${hits[0]?.record.text ?? '(rong)'}`);
      }
      if (c.id === 'v23-fusion-03') {
        return hits.length === 0 ? pass('0 hit') : fail(`${hits.length} hit`);
      }
      if (c.id === 'v23-fusion-04') {
        return hits.length === 0 ? pass('0 hit (het han bi loai)') : fail(`${hits.length} hit`);
      }
      if (c.id === 'v23-fusion-05') {
        const exp = hits[0]?.explanation ?? '';
        return exp.includes('semantic') && exp.includes('bm25') && exp.includes('entity')
          ? pass(exp)
          : fail(`explanation thieu tin hieu: ${exp}`);
      }
      return hits[0]?.record.text.includes('Postgres')
        ? pass(`top1 (khong embedder): ${hits[0].record.text}`)
        : fail(`top1 sai: ${hits[0]?.record.text ?? '(rong)'}`);
    }

    if (c.group === 'scope') {
      const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
      const seedScope = input.seedScope as { userId: string; agentId: string; runId: string };
      const seedScope2 = input.seedScope2 as { userId: string; agentId: string; runId: string } | undefined;
      store.put({ text: 'User thich ca phe den khong duong.', confidence: 0.8, source: 'eval', scope: seedScope });
      if (seedScope2) {
        // scope-06: text khac de khong bi dedupe (can 2 hit de so thu tu).
        const secondText = c.id === 'v23-scope-06'
          ? 'User uong ca phe den moi sang truoc khi lam viec.'
          : 'User thich ca phe den khong duong.';
        store.put({ text: secondText, confidence: 0.8, source: 'eval', scope: seedScope2 });
      }
      const hits = await retrieveV23Scoped(
        store,
        String(input.query ?? ''),
        input.scope as { userId: string; agentId: string; runId: string; appId: string },
        undefined,
        { entityIndex: store.getEntityIndex(), now: () => V23_EVAL_NOW },
      );
      if (c.id === 'v23-scope-01' || c.id === 'v23-scope-03' || c.id === 'v23-scope-04') {
        return hits.length >= 1 ? pass(`${hits.length} hit`) : fail('0 hit');
      }
      if (c.id === 'v23-scope-02') {
        return hits.length === 0 ? pass('0 hit (bi chan scope)') : fail(`${hits.length} hit (ro ri scope)`);
      }
      if (c.id === 'v23-scope-05') {
        return hits.length === 1 && hits[0].mergedSources.length >= 1
          ? pass(`1 hit, merged ${hits[0].mergedSources.length}`)
          : fail(`${hits.length} hit, mergedSources=${hits[0]?.mergedSources.length ?? 0}`);
      }
      // v23-scope-06: hit run phai dung truoc hit user.
      return hits.length >= 2 && hits[0].scopeLevel === 'run'
        ? pass(`thu tu: ${hits.map((h) => h.scopeLevel).join(' > ')}`)
        : fail(`thu tu sai: ${hits.map((h) => h.scopeLevel).join(', ')}`);
    }

    if (c.group === 'sleep') {
      if (c.id === 'v23-sleep-06') {
        const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
        const report = new V23SleepConsolidator({ now: () => V23_EVAL_NOW }).run(store);
        return report.scanned === 0 ? pass('scanned=0') : fail(`scanned=${report.scanned}`);
      }
      if (c.id === 'v23-sleep-01') {
        // Tao record o clock cu (60 ngay truoc), chay sleep o clock moi.
        const store2 = new V23MemoryStore({ now: () => V23_EVAL_NOW - 60 * 86_400_000 });
        const r2 = store2.put({ text: 'User thich ca phe den.', confidence: 0.8, source: 'eval' });
        const report = new V23SleepConsolidator({ now: () => V23_EVAL_NOW }).run(store2);
        const after = r2.record ? store2.get(r2.record.id) : undefined;
        void report;
        return after && after.confidence < 0.8
          ? pass(`confidence ${0.8} -> ${after.confidence}`)
          : fail(`confidence khong giam: ${after?.confidence}`);
      }
      if (c.id === 'v23-sleep-02') {
        const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
        store.put({ text: String(input.a), confidence: 0.7, source: 'eval' });
        store.put({ text: String(input.b), confidence: 0.7, source: 'eval' });
        const report = new V23SleepConsolidator({ now: () => V23_EVAL_NOW }).run(store);
        return report.merged >= 1 ? pass(`merged=${report.merged}`) : fail('khong merge');
      }
      if (c.id === 'v23-sleep-03') {
        const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
        const r = store.put({ text: 'User thich ca phe den.', confidence: 0.5, source: 'eval' });
        if (r.record) for (let i = 0; i < 5; i += 1) store.markRetrieved(r.record.id);
        const report = new V23SleepConsolidator({ now: () => V23_EVAL_NOW }).run(store);
        return report.promoted >= 1 ? pass(`promoted=${report.promoted}`) : fail('khong promote');
      }
      if (c.id === 'v23-sleep-04') {
        const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
        store.put({ text: 'User thich ca phe den.', confidence: 0.7, source: 'eval', validTo: String(input.validTo) });
        const report = new V23SleepConsolidator({ now: () => V23_EVAL_NOW }).run(store);
        return report.markedStale >= 1 ? pass(`markedStale=${report.markedStale}`) : fail('khong stale');
      }
      const store = new V23MemoryStore({ now: () => V23_EVAL_NOW });
      for (let i = 0; i < 5; i += 1) {
        store.put({ text: `Fact so ${i} ve ca phe den.`, confidence: 0.7, source: 'eval' });
      }
      const report = new V23SleepConsolidator({ maxOps: 1, now: () => V23_EVAL_NOW }).run(store);
      return report.budgetHit ? pass('budgetHit=true') : fail('budget khong hit');
    }

    // --- procedural ---
    const proc = new V23ProceduralStore({ now: () => V23_EVAL_NOW });
    const workflow = String(input.workflow ?? 'deploy-preview');
    const successes = (input.successes as number) ?? 0;
    const failures = (input.failures as number) ?? 0;
    const baseSteps = ['mo terminal', 'chay test', 'deploy preview'];
    for (let i = 0; i < successes; i += 1) {
      proc.recordAttempt(attempt(workflow, 'success', baseSteps, 1000, V23_EVAL_NOW + i));
    }
    for (let i = 0; i < failures; i += 1) {
      proc.recordAttempt(attempt(workflow, 'failure', baseSteps, 1000, V23_EVAL_NOW + 100 + i));
    }
    if (c.id === 'v23-proc-01') {
      const skill = proc.getSkill(workflow);
      return skill && skill.status === 'candidate'
        ? pass(`candidate, success=${skill.successCount}`)
        : fail(`skill=${skill?.status ?? 'none'}`);
    }
    if (c.id === 'v23-proc-02') {
      return proc.getSkill(workflow) === undefined
        ? pass('khong co skill')
        : fail('co skill sau failure rieng');
    }
    if (c.id === 'v23-proc-03') {
      const res = proc.approve(workflow);
      return res.ok && res.skill?.status === 'active'
        ? pass('active')
        : fail(`approve that bai: ${res.error ?? res.skill?.status}`);
    }
    if (c.id === 'v23-proc-04') {
      proc.recordAttempt(
        attempt(workflow, 'success', ['mo terminal', 'chay test nhanh', 'deploy preview'], 500, V23_EVAL_NOW + 50),
      );
      const skill = proc.getSkill(workflow);
      return skill && skill.version >= 2
        ? pass(`version=${skill.version}`)
        : fail(`version=${skill?.version}`);
    }
    if (c.id === 'v23-proc-05') {
      const found = proc.searchSkills(String(input.query ?? ''), 5);
      return found.length >= 1 ? pass(`tim thay ${found.length}`) : fail('khong tim thay');
    }
    const ratings = (input.ratings as number[]) ?? [];
    for (const stars of ratings) proc.rate(workflow, stars);
    const deprecated = proc.reviewDeprecations();
    const skill = proc.getSkill(workflow);
    return skill?.status === 'deprecated' && deprecated.includes(workflow)
      ? pass('deprecated')
      : fail(`status=${skill?.status}`);
  } catch (e) {
    return fail(`throw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Chay toan bo case eval v23 (offline). */
export async function runV23Eval(
  cases: readonly V23EvalCase[] = V23_EVAL_CASES,
): Promise<V23EvalSummary> {
  const results: V23EvalResult[] = [];
  for (const c of cases) results.push(await runCaseV23(c));
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results, ranAt: Date.now() };
}
