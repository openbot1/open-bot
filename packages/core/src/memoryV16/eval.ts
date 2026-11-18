/**
 * Memory v16 — Eval set (v1.35, Doi T1).
 *
 * Bo eval offline, xac dinh, khong goi model, khong goi mang — 40
 * case co dinh chia 4 nhom:
 *  - blocks (11): core_memory_replace exact-match, pin bao ve edit,
 *    pinVersion/restore, budget kind, compile pinned-first, audit.
 *  - fuse (11): ADD/UPDATE/DELETE/IGNORE da scope, retract,
 *    session promote, trung lap, preview dry-run.
 *  - validity (9): active/not_yet/expired, ledger override, expiry
 *    sweep, replace + timeline, validity report.
 *  - archival (9): recall dung record, promote tro lai graph, decay
 *    importance, asOf filter, candidate suggestion.
 *
 * Moi case tra PASS/FAIL + ly do; ket qua tong hop theo nhom + toan
 * bo, co nguong PASS/FAIL mac dinh. Dung cho tool memory_v16_eval
 * va CI.
 */

import { TemporalGraphStore, InMemoryGraphBackend } from '../memory/graph/store';
import { M16BlockStore, coreMemoryReplaceM16, compileBlocksM16, runSleepReorganizeM16, exportAuditM16 } from './blocks';
import { M16ValidityLedger, validityStatusM16, factsValidAtM16, sweepExpiredM16, replaceFactM16, factValidityTimelineM16, validityReportM16, formatValidityReportM16 } from './temporalKg';
import { extractFactsM16Sync, applyFuseM16, consolidateTurnsM16, M16SleepConsolidator, previewConsolidationM16 } from './consolidation';
import { M16ArchivalStore, archivalRecallM16, promoteArchivedToGraphM16, archiveExpiredFactsM16, suggestArchivalCandidatesM16 } from './hybridSearch';

/** Loi eval v16 — message tieng Viet. */
export class M16EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M16EvalError';
  }
}

export type M16EvalCategory = 'blocks' | 'fuse' | 'validity' | 'archival';

export interface M16EvalCase {
  id: string;
  category: M16EvalCategory;
  title: string;
  /** Ham chay case — tra true = PASS. Nem loi = FAIL (ghi message). */
  run: () => boolean;
}

export interface M16EvalPerCase {
  id: string;
  category: M16EvalCategory;
  title: string;
  passed: boolean;
  detail: string;
}

export interface M16EvalCategoryScore {
  category: M16EvalCategory;
  total: number;
  passed: number;
  rate: number;
}

export interface M16EvalThresholds {
  overall: number;
  blocks: number;
  fuse: number;
  validity: number;
  archival: number;
}

export const M16_EVAL_THRESHOLDS: M16EvalThresholds = {
  overall: 0.9,
  blocks: 0.9,
  fuse: 0.9,
  validity: 0.85,
  archival: 0.85,
};

export interface M16EvalResult {
  total: number;
  passed: number;
  failed: number;
  rate: number;
  perCategory: M16EvalCategoryScore[];
  perCase: M16EvalPerCase[];
  thresholds: M16EvalThresholds;
  overallPass: boolean;
}

export interface M16EvalOptions {
  thresholds?: Partial<M16EvalThresholds>;
}

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore(): TemporalGraphStore {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText: string) {
  return {
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
    sourceText,
  };
}

function seedFact(
  store: TemporalGraphStore,
  subject: string,
  predicate: string,
  objectText: string,
  opts: { validFrom?: string; validUntil?: string | null; confidence?: number } = {},
) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: SCOPE,
    provenance: prov(`${subject} ${predicate} ${objectText}`),
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
  });
}

function check(condition: boolean, message: string): boolean {
  if (!condition) throw new Error(message);
  return true;
}

/** Build bo 40 case eval co dinh. */
export function buildM16EvalDataset(): M16EvalCase[] {
  const cases: M16EvalCase[] = [];

  // ---- blocks (11) ------------------------------------------------------
  cases.push({
    id: 'blocks-01',
    category: 'blocks',
    title: 'core_memory_replace thay dung 1 doan khop chinh xac',
    run: () => {
      const s = new M16BlockStore();
      s.create('human', 'human', 'User thich ca phe. User song o Ha Noi.', 'user');
      const out = coreMemoryReplaceM16(s, 'human', 'ca phe', 'tra da', 'agent');
      return check(out.content === 'User thich tra da. User song o Ha Noi.', 'replace sai noi dung');
    },
  });
  cases.push({
    id: 'blocks-02',
    category: 'blocks',
    title: 'core_memory_replace tu choi khi oldText khong khop',
    run: () => {
      const s = new M16BlockStore();
      s.create('human', 'human', 'User thich ca phe.', 'user');
      try {
        coreMemoryReplaceM16(s, 'human', 'tra sua', 'tra da', 'agent');
      } catch {
        return check(s.get('human')?.content === 'User thich ca phe.', 'block bi doi du khong khop');
      }
      throw new Error('le ra phai nem loi khi oldText khong khop');
    },
  });
  cases.push({
    id: 'blocks-03',
    category: 'blocks',
    title: 'core_memory_replace tu choi khi oldText xuat hien nhieu lan',
    run: () => {
      const s = new M16BlockStore();
      s.create('human', 'human', 'A va A va A.', 'user');
      try {
        coreMemoryReplaceM16(s, 'human', 'A', 'B', 'agent');
      } catch (err) {
        return check(String((err as Error).message).includes('3 lan'), 'loi phai neu so lan xuat hien');
      }
      throw new Error('le ra phai nem loi khi oldText trung lap');
    },
  });
  cases.push({
    id: 'blocks-04',
    category: 'blocks',
    title: 'block pinned chan edit thuong, cho edit khi force + reason',
    run: () => {
      const s = new M16BlockStore();
      s.create('persona', 'persona', 'Ban la tro ly.', 'user');
      s.pin('persona', 'user', 'khoa persona');
      let blocked = false;
      try {
        s.replace('persona', 'Doi het.', 'agent');
      } catch {
        blocked = true;
      }
      if (!blocked) throw new Error('block pinned le ra phai chan edit thuong');
      const out = s.replace('persona', 'Ban la tro ly moi.', 'agent', 'cap nhat co phep', true);
      return check(out.content === 'Ban la tro ly moi.', 'force edit khong doi duoc block pinned');
    },
  });
  cases.push({
    id: 'blocks-05',
    category: 'blocks',
    title: 'pinVersion + restorePinnedVersion khoi phuc dung version cu',
    run: () => {
      const s = new M16BlockStore();
      s.create('task', 'task', 'Viec 1.', 'user');
      s.replace('task', 'Viec 1 + viec 2.', 'user');
      s.pinVersion('task', 1, 'user', 'giu ban dau');
      s.replace('task', 'Viec 3.', 'user');
      const out = s.restorePinnedVersion('task', 'user');
      return check(out.content === 'Viec 1.', 'restore pinned version sai noi dung');
    },
  });
  cases.push({
    id: 'blocks-06',
    category: 'blocks',
    title: 'budget kind chan tao block vuot 4000 ky tu (persona)',
    run: () => {
      const s = new M16BlockStore();
      try {
        s.create('persona', 'persona', 'x'.repeat(4001), 'user');
      } catch {
        return true;
      }
      throw new Error('le ra phai chan tao block vuot budget kind');
    },
  });
  cases.push({
    id: 'blocks-07',
    category: 'blocks',
    title: 'compileBlocksM16 dua pinned len truoc kind priority',
    run: () => {
      const s = new M16BlockStore();
      s.create('human', 'human', 'Ve user.', 'user');
      s.create('notes', 'custom', 'Ghi chu.', 'user');
      s.pin('notes', 'user');
      const compiled = compileBlocksM16(s);
      const idxNotes = compiled.indexOf('[custom:notes]');
      const idxHuman = compiled.indexOf('[human:human]');
      return check(idxNotes >= 0 && idxHuman >= 0 && idxNotes < idxHuman, 'pinned phai dung truoc human');
    },
  });
  cases.push({
    id: 'blocks-08',
    category: 'blocks',
    title: 'ensureCoreBlocks tao du 3 core block mac dinh',
    run: () => {
      const s = new M16BlockStore();
      const created = s.ensureCoreBlocks('system');
      const again = s.ensureCoreBlocks('system');
      return check(created.length === 3 && again.length === 0 && s.listCore().length === 3, 'ensureCoreBlocks phai idempotent');
    },
  });
  cases.push({
    id: 'blocks-09',
    category: 'blocks',
    title: 'sleep reorganizer v16 khong dong vao block pinned',
    run: () => {
      const s = new M16BlockStore();
      const long = 'Cau dai de test sleep. '.repeat(250);
      s.create('big', 'custom', long, 'user');
      s.pin('big', 'user');
      const report = runSleepReorganizeM16(s, { force: true });
      const after = s.get('big');
      return check(
        report.protectedPinned === 1 && report.summarized === 0 && after?.content === long,
        `pinned phai duoc bao ve: protected=${report.protectedPinned} summarized=${report.summarized}`,
      );
    },
  });
  cases.push({
    id: 'blocks-10',
    category: 'blocks',
    title: 'rollback ve version cu tang version + giu history',
    run: () => {
      const s = new M16BlockStore();
      s.create('human', 'human', 'Ban dau.', 'user');
      s.replace('human', 'Sau 1.', 'user');
      s.replace('human', 'Sau 2.', 'user');
      const out = s.rollback('human', 1, 'user');
      return check(out.content === 'Ban dau.' && out.version === 4 && out.history.length === 3, 'rollback sai version/history');
    },
  });

  cases.push({
    id: 'blocks-11',
    category: 'blocks',
    title: 'audit trail ghi moi lan sua + export doc duoc',
    run: () => {
      const s = new M16BlockStore();
      s.create('human', 'human', 'Ban dau.', 'user');
      s.replace('human', 'Sau 1.', 'agent', 'cap nhat');
      s.pin('human', 'user', 'khoa');
      const trail = s.auditTrail('human');
      const summary = s.auditSummary();
      const text = exportAuditM16(s, 'human');
      return check(
        trail.length === 3 &&
          summary.total === 3 &&
          summary.byAction.create === 1 &&
          summary.byAction.edit === 1 &&
          summary.byAction.pin === 1 &&
          text.includes('Audit trail v16') &&
          text.includes('pin'),
        `audit sai: ${trail.length} muc, summary=${JSON.stringify(summary.byAction)}`,
      );
    },
  });

  // ---- fuse (11) --------------------------------------------------------
  cases.push({
    id: 'fuse-01',
    category: 'fuse',
    title: 'extract tieng Viet: ten + noi song + thich',
    run: () => {
      const facts = extractFactsM16Sync('Tôi tên là Huy, tôi sống ở Hà Nội, tôi thích cà phê.');
      const preds = facts.map((f) => f.predicate);
      return check(
        preds.includes('name') && preds.includes('lives_in') && preds.includes('likes'),
        `thieu predicate, chi co: ${preds.join(',')}`,
      );
    },
  });
  cases.push({
    id: 'fuse-02',
    category: 'fuse',
    title: 'extract tieng Anh: name + works_at',
    run: () => {
      const facts = extractFactsM16Sync('My name is Huy, I work at OpenBot.');
      return check(
        facts.some((f) => f.predicate === 'name' && f.objectText === 'Huy') &&
          facts.some((f) => f.predicate === 'works_at'),
        'khong trich duoc name/works_at tieng Anh',
      );
    },
  });
  cases.push({
    id: 'fuse-03',
    category: 'fuse',
    title: 'fuse ADD: fact moi duoc them vao graph',
    run: () => {
      const store = freshStore();
      const r = applyFuseM16(store, {
        subject: 'user', predicate: 'likes', objectText: 'cà phê', confidence: 0.9,
        sourceText: 'tôi thích cà phê', scope: 'user', intent: 'assert',
      }, SCOPE);
      return check(r.decision === 'add' && store.listFacts({ status: 'active' }).length === 1, 'ADD khong ghi fact');
    },
  });
  cases.push({
    id: 'fuse-04',
    category: 'fuse',
    title: 'fuse UPDATE: don tri doi gia tri thi supersede fact cu',
    run: () => {
      const store = freshStore();
      const old = seedFact(store, 'user', 'lives_in', 'Hà Nội');
      const r = applyFuseM16(store, {
        subject: 'user', predicate: 'lives_in', objectText: 'TP. HCM', confidence: 0.9,
        sourceText: 'tôi sống ở TP. HCM', scope: 'user', intent: 'assert',
      }, SCOPE);
      const after = store.getFact(old.id);
      return check(
        r.decision === 'update' && after?.status === 'superseded' && after?.supersededBy === r.fact?.id,
        'UPDATE khong supersede fact cu',
      );
    },
  });
  cases.push({
    id: 'fuse-05',
    category: 'fuse',
    title: 'fuse DELETE: "không còn ... nữa" invalidate fact cu',
    run: () => {
      const store = freshStore();
      const old = seedFact(store, 'user', 'works_at', 'Acme');
      const r = applyFuseM16(store, {
        subject: 'user', predicate: 'works_at', objectText: 'Acme', confidence: 0.9,
        sourceText: 'tôi không còn làm ở Acme', scope: 'user', intent: 'retract',
      }, SCOPE);
      const after = store.getFact(old.id);
      return check(r.decision === 'delete' && after?.invalidAt !== undefined, 'DELETE khong invalidate fact cu');
    },
  });
  cases.push({
    id: 'fuse-06',
    category: 'fuse',
    title: 'fuse IGNORE: fact trung lap khong ghi them',
    run: () => {
      const store = freshStore();
      seedFact(store, 'user', 'likes', 'cà phê');
      const r = applyFuseM16(store, {
        subject: 'user', predicate: 'likes', objectText: 'cà phê', confidence: 0.9,
        sourceText: 'tôi thích cà phê', scope: 'user', intent: 'assert',
      }, SCOPE);
      return check(r.decision === 'ignore' && store.listFacts({ status: 'active' }).length === 1, 'IGNORE khong chan trung lap');
    },
  });
  cases.push({
    id: 'fuse-07',
    category: 'fuse',
    title: 'fuse da scope: cung predicate khac scope khong fuse lan nhau',
    run: () => {
      const store = freshStore();
      const report = consolidateTurnsM16(store, [
        { text: 'Tôi thích cà phê.', scope: 'user', userId: 'u1', botId: 'b1', runId: 'r1' },
        { text: 'Tôi thích cà phê.', scope: 'session', userId: 'u1', botId: 'b1', runId: 'r1', sessionId: 's1' },
      ]);
      return check(report.added === 2, `khac scope phai ADD ca 2, chi ADD ${report.added}`);
    },
  });
  cases.push({
    id: 'fuse-08',
    category: 'fuse',
    title: 'sleep consolidation chay khi force, xu ly het queue',
    run: () => {
      const store = freshStore();
      const agent = new M16SleepConsolidator();
      agent.enqueue({ text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' });
      agent.enqueue({ text: 'Tôi sống ở Hà Nội.', userId: 'u1', botId: 'b1', runId: 'r1' });
      const report = agent.run(store, { force: true });
      return check(report.ran && report.turnsProcessed === 2 && report.added >= 2, 'sleep consolidation khong xu ly het queue');
    },
  });
  cases.push({
    id: 'fuse-09',
    category: 'fuse',
    title: 'sleep consolidation tu choi khi chua idle va khong force',
    run: () => {
      const store = freshStore();
      const agent = new M16SleepConsolidator();
      agent.enqueue({ text: 'Tôi tên là Huy.', userId: 'u1', botId: 'b1', runId: 'r1' });
      const report = agent.run(store, { idleMs: 1000 });
      return check(!report.ran && agent.pendingTurns === 1, 'phai tu choi khi chua idle va giu queue');
    },
  });
  cases.push({
    id: 'fuse-10',
    category: 'fuse',
    title: 'session fact lap lai 2 session duoc promote len user scope',
    run: () => {
      const store = freshStore();
      const agent = new M16SleepConsolidator();
      agent.enqueue({ text: 'Tôi thích trà đá.', scope: 'session', userId: 'u1', botId: 'b1', runId: 'r1', sessionId: 's1' });
      agent.run(store, { force: true });
      agent.enqueue({ text: 'Tôi thích trà đá.', scope: 'session', userId: 'u1', botId: 'b1', runId: 'r2', sessionId: 's2' });
      const report = agent.run(store, { force: true });
      return check(report.sessionPromoted >= 1, `session promote khong chay (promoted=${report.sessionPromoted})`);
    },
  });

  cases.push({
    id: 'fuse-11',
    category: 'fuse',
    title: 'preview consolidation dry-run: lap ke hoach, khong ghi',
    run: () => {
      const store = freshStore();
      seedFact(store, 'user', 'lives_in', 'Hà Nội');
      const preview = previewConsolidationM16(store, [
        { text: 'Tôi sống ở TP. HCM.', userId: 'u1', botId: 'b1', runId: 'r1' },
      ]);
      const active = store.listFacts({ status: 'active', predicate: 'lives_in' });
      return check(
        preview.extracted === 1 &&
          preview.counts.update === 1 &&
          preview.plans[0].decision === 'update' &&
          active.length === 1 &&
          active[0].objectText === 'Hà Nội',
        `preview sai hoac da ghi: ${JSON.stringify(preview.counts)} active=${active.length}`,
      );
    },
  });

  // ---- validity (9) -----------------------------------------------------
  cases.push({
    id: 'validity-01',
    category: 'validity',
    title: 'fact dung trong cua so, het han sau validUntil',
    run: () => {
      const store = freshStore();
      const fact = seedFact(store, 'user', 'works_at', 'Acme', {
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-06-01T00:00:00.000Z',
      });
      const inside = validityStatusM16(fact, '2026-03-01T00:00:00.000Z');
      const after = validityStatusM16(fact, '2026-07-01T00:00:00.000Z');
      return check(inside === 'active' && after === 'expired', `trang thai sai: ${inside}/${after}`);
    },
  });
  cases.push({
    id: 'validity-02',
    category: 'validity',
    title: 'fact chua toi validFrom co trang thai not_yet',
    run: () => {
      const store = freshStore();
      const fact = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2027-01-01T00:00:00.000Z' });
      return check(validityStatusM16(fact, '2026-06-01T00:00:00.000Z') === 'not_yet', 'phai la not_yet truoc validFrom');
    },
  });
  cases.push({
    id: 'validity-03',
    category: 'validity',
    title: 'ledger override thu hep cua so hieu luc',
    run: () => {
      const store = freshStore();
      const ledger = new M16ValidityLedger();
      const fact = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
      ledger.set(fact.id, { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }, 'system', 'hop dong het han');
      return check(validityStatusM16(fact, '2026-03-01T00:00:00.000Z', ledger) === 'expired', 'ledger override khong co hieu luc');
    },
  });
  cases.push({
    id: 'validity-04',
    category: 'validity',
    title: 'factsValidAt chi tra fact dung tai thoi diem T',
    run: () => {
      const store = freshStore();
      seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' });
      seedFact(store, 'user', 'likes', 'cà phê', { validFrom: '2026-01-01T00:00:00.000Z' });
      const result = factsValidAtM16(store, '2026-06-01T00:00:00.000Z');
      return check(
        result.facts.length === 1 && result.facts[0].fact.predicate === 'likes',
        `factsValidAt tra sai: ${result.facts.length} fact`,
      );
    },
  });
  cases.push({
    id: 'validity-05',
    category: 'validity',
    title: 'expiry sweep dem dung het han + sap het han',
    run: () => {
      const store = freshStore();
      seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-01-10T00:00:00.000Z' });
      seedFact(store, 'user', 'likes', 'trà đá', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-01-20T00:00:00.000Z' });
      const report = sweepExpiredM16(store, { withinMs: 30 * 24 * 60 * 60 * 1000, now: new Date('2026-01-15T00:00:00.000Z') });
      return check(report.expired === 1 && report.expiringSoon === 1, `sweep sai: expired=${report.expired} soon=${report.expiringSoon}`);
    },
  });
  cases.push({
    id: 'validity-06',
    category: 'validity',
    title: 'replaceFact dong cua so cu + tao fact moi co cua so moi',
    run: () => {
      const store = freshStore();
      const old = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
      const ledger = new M16ValidityLedger();
      const result = replaceFactM16(
        store,
        old.id,
        { subjectName: 'user', predicate: 'works_at', objectText: 'Beta', scope: SCOPE, sourceText: 'doi viec' },
        { ledger, now: new Date('2026-05-01T00:00:00.000Z') },
      );
      return check(
        result.newFact.objectText === 'Beta' &&
          result.oldFact.status === 'superseded' &&
          result.newWindow.validFrom === '2026-05-01T00:00:00.000Z',
        'replaceFact sai cua so/trang thai',
      );
    },
  });
  cases.push({
    id: 'validity-07',
    category: 'validity',
    title: 'timeline validity co du moc created + window_change + expired',
    run: () => {
      const store = freshStore();
      const ledger = new M16ValidityLedger();
      const fact = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z' });
      ledger.set(fact.id, { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }, 'system', 'het han');
      const steps = factValidityTimelineM16(fact, ledger, new Date('2026-03-01T00:00:00.000Z'));
      const kinds = steps.map((s) => s.kind);
      return check(
        kinds.includes('created') && kinds.includes('window_change') && kinds.includes('expired'),
        `timeline thieu moc: ${kinds.join(',')}`,
      );
    },
  });
  cases.push({
    id: 'validity-08',
    category: 'validity',
    title: 'ledger tu choi cua so rong (validUntil < validFrom)',
    run: () => {
      const ledger = new M16ValidityLedger();
      try {
        ledger.set('f1', { validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-01-01T00:00:00.000Z' }, 'system');
      } catch {
        return true;
      }
      throw new Error('le ra phai tu choi cua so rong');
    },
  });

  cases.push({
    id: 'validity-09',
    category: 'validity',
    title: 'validity report dem dung theo trang thai + mo/ledger',
    run: () => {
      const store = freshStore();
      const ledger = new M16ValidityLedger();
      const f1 = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' });
      seedFact(store, 'user', 'likes', 'cà phê', { validFrom: '2026-01-01T00:00:00.000Z' });
      ledger.set(f1.id, { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' }, 'system', 'het han');
      const report = validityReportM16(store, { now: new Date('2026-06-01T00:00:00.000Z'), ledger });
      const text = formatValidityReportM16(report);
      return check(
        report.scanned === 2 &&
          report.byStatus.expired === 1 &&
          report.byStatus.active === 1 &&
          report.openEnded === 1 &&
          report.ledgerOverridden === 1 &&
          text.includes('Validity report v16'),
        `report sai: ${JSON.stringify(report.byStatus)} open=${report.openEnded} ledger=${report.ledgerOverridden}`,
      );
    },
  });

  // ---- archival (9) -----------------------------------------------------
  cases.push({
    id: 'archival-01',
    category: 'archival',
    title: 'archival recall tim dung record theo tu khoa',
    run: () => {
      const s = new M16ArchivalStore();
      s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê trứng', importance: 0.9 });
      s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'trà đá vỉa hè', importance: 0.5 });
      const result = archivalRecallM16(s, 'cà phê trứng');
      return check(
        result.hits.length >= 1 && result.hits[0].record.objectText === 'cà phê trứng',
        'recall khong dua dung record len dau',
      );
    },
  });
  cases.push({
    id: 'archival-02',
    category: 'archival',
    title: 'promote dua record archival tro lai graph + xoa kho lanh',
    run: () => {
      const store = freshStore();
      const arch = new M16ArchivalStore();
      const record = arch.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê' });
      const fact = promoteArchivedToGraphM16(store, arch, record.id, 'user');
      return check(
        fact.objectText === 'cà phê' && arch.size === 0 && store.listFacts({ status: 'active' }).length === 1,
        'promote khong dua fact ve graph / khong xoa archival',
      );
    },
  });
  cases.push({
    id: 'archival-03',
    category: 'archival',
    title: 'recordAccess tang dem + tang importance',
    run: () => {
      const s = new M16ArchivalStore();
      const record = s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.5 });
      const after = s.recordAccess(record.id);
      return check(after.accessCount === 1 && after.importance > 0.5, 'recordAccess khong cap nhat dem/importance');
    },
  });
  cases.push({
    id: 'archival-04',
    category: 'archival',
    title: 'decay importance giam dan theo thoi gian khong dung',
    run: () => {
      const s = new M16ArchivalStore();
      const record = s.archiveText(
        { subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.8 },
        'system',
        '',
        new Date('2025-01-01T00:00:00.000Z'),
      );
      const before = s.get(record.id)?.importance ?? 0;
      s.decayImportance(new Date('2026-01-01T00:00:00.000Z'));
      const after = s.get(record.id)?.importance ?? 0;
      return check(after < before, `decay khong giam importance (${before} -> ${after})`);
    },
  });
  cases.push({
    id: 'archival-05',
    category: 'archival',
    title: 'asOf filter loai record het hieu luc tai thoi diem truy van',
    run: () => {
      const s = new M16ArchivalStore();
      s.archiveText({ subject: 'user', predicate: 'works_at', objectText: 'Acme', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-02-01T00:00:00.000Z' });
      s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', validFrom: '2026-01-01T00:00:00.000Z' });
      const result = archivalRecallM16(s, '', { asOf: '2026-06-01T00:00:00.000Z' });
      return check(
        result.hits.length === 1 && result.hits[0].record.predicate === 'likes',
        `asOf khong loc het han: ${result.hits.length} hit`,
      );
    },
  });
  cases.push({
    id: 'archival-06',
    category: 'archival',
    title: 'archiveExpiredFacts chi archive fact het han, bo qua da archive',
    run: () => {
      const store = freshStore();
      const arch = new M16ArchivalStore();
      const fact = seedFact(store, 'user', 'works_at', 'Acme', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-01-10T00:00:00.000Z' });
      const first = archiveExpiredFactsM16(arch, [fact]);
      const second = archiveExpiredFactsM16(arch, [fact]);
      return check(
        first.archived === 1 && second.archived === 0 && second.skipped === 1 && arch.size === 1,
        `archive het han sai: first=${first.archived} second=${second.archived} skipped=${second.skipped}`,
      );
    },
  });
  cases.push({
    id: 'archival-07',
    category: 'archival',
    title: 'RRF mode van xep record khop text len dau',
    run: () => {
      const s = new M16ArchivalStore();
      s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê trứng Hà Nội', importance: 0.1 });
      s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'trà đá', importance: 0.9 });
      const result = archivalRecallM16(s, 'cà phê trứng Hà Nội', { mode: 'rrf' });
      return check(result.hits[0].record.objectText.includes('cà phê'), 'RRF khong dua record khop text len dau');
    },
  });
  cases.push({
    id: 'archival-08',
    category: 'archival',
    title: 'archival store JSON round-trip giu nguyen record',
    run: () => {
      const s = new M16ArchivalStore();
      s.archiveText({ subject: 'user', predicate: 'likes', objectText: 'cà phê', importance: 0.7 });
      const { store } = M16ArchivalStore.fromJSON(s.toJSON());
      return check(store.size === 1 && store.list()[0].objectText === 'cà phê', 'JSON round-trip mat record');
    },
  });

  cases.push({
    id: 'archival-09',
    category: 'archival',
    title: 'suggestArchivalCandidates goi y fact het han tin cay thap',
    run: () => {
      const store = freshStore();
      seedFact(store, 'user', 'works_at', 'OldCo', {
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-01-10T00:00:00.000Z',
        confidence: 0.6,
      });
      seedFact(store, 'user', 'likes', 'cà phê', { confidence: 0.95 });
      const candidates = suggestArchivalCandidatesM16(store, { now: new Date('2026-06-01T00:00:00.000Z') });
      return check(
        candidates.length === 1 &&
          candidates[0].fact.predicate === 'works_at' &&
          candidates[0].reason.includes('het hieu luc'),
        `candidate sai: ${candidates.length} ung vien`,
      );
    },
  });

  return cases;
}

/** Chay toan bo eval set, tra ket qua + PASS/FAIL theo nguong. */
export function runM16Eval(opts: M16EvalOptions = {}): M16EvalResult {
  const thresholds: M16EvalThresholds = { ...M16_EVAL_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const dataset = buildM16EvalDataset();
  const perCase: M16EvalPerCase[] = [];
  for (const c of dataset) {
    try {
      const passed = c.run() === true;
      perCase.push({ id: c.id, category: c.category, title: c.title, passed, detail: passed ? 'PASS' : 'Case tra ve false.' });
    } catch (err) {
      perCase.push({
        id: c.id,
        category: c.category,
        title: c.title,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const categories: M16EvalCategory[] = ['blocks', 'fuse', 'validity', 'archival'];
  const perCategory: M16EvalCategoryScore[] = categories.map((category) => {
    const items = perCase.filter((p) => p.category === category);
    const passed = items.filter((p) => p.passed).length;
    return { category, total: items.length, passed, rate: items.length === 0 ? 0 : passed / items.length };
  });
  const passed = perCase.filter((p) => p.passed).length;
  const rate = perCase.length === 0 ? 0 : passed / perCase.length;
  const overallPass =
    rate >= thresholds.overall &&
    (perCategory.find((c) => c.category === 'blocks')?.rate ?? 0) >= thresholds.blocks &&
    (perCategory.find((c) => c.category === 'fuse')?.rate ?? 0) >= thresholds.fuse &&
    (perCategory.find((c) => c.category === 'validity')?.rate ?? 0) >= thresholds.validity &&
    (perCategory.find((c) => c.category === 'archival')?.rate ?? 0) >= thresholds.archival;
  return {
    total: perCase.length,
    passed,
    failed: perCase.length - passed,
    rate,
    perCategory,
    perCase,
    thresholds,
    overallPass,
  };
}

/** Format ket qua eval thanh text doc duoc (dung cho tool + log). */
export function formatM16EvalReport(result: M16EvalResult): string {
  const lines = [
    `Memory v16 eval: ${result.passed}/${result.total} PASS (${(result.rate * 100).toFixed(1)}%) — ${result.overallPass ? 'OVERALL PASS' : 'OVERALL FAIL'}.`,
  ];
  for (const c of result.perCategory) {
    const threshold = result.thresholds[c.category];
    lines.push(
      `  ${c.category}: ${c.passed}/${c.total} (${(c.rate * 100).toFixed(1)}%, nguong ${(threshold * 100).toFixed(0)}%) ${c.rate >= threshold ? 'PASS' : 'FAIL'}`,
    );
  }
  for (const p of result.perCase.filter((x) => !x.passed)) {
    lines.push(`  FAIL ${p.id} [${p.category}] ${p.title}: ${p.detail}`);
  }
  return lines.join('\n');
}
