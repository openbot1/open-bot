/**
 * Memory v28 — fact store bi-temporal (v1.44, Doi T1).
 *
 * Y tuong hoc tu Mem0 v3 / Zep / Graphiti (survey v144 muc 3,
 * chi y tuong, KHONG copy code/text/tai san): fact cu bi VO
 * HIEU (invalidate) chu khong xoa — graph giu ca fact va cua
 * so hieu luc cua no. Ke thua quyet dinh add-only cua v27
 * (khong UPDATE/DELETE): fact moi mau thuan chi ADD edge moi
 * + DONG edge cu (supersede).
 *
 * Moi fact co 2 truc thoi gian (bi-temporal):
 *  - valid time: `validFrom` .. `validTo` — fact dung trong
 *    khoang nay (theo the gioi that).
 *  - transaction time: `createdAt` .. `invalidatedAt` — he
 *    thong biet ve fact trong khoang nay.
 *
 * Luu tru: file `facts.jsonl` append-only trong repo v28 — moi
 * dong la 1 snapshot day du cua fact sau moi lan thay doi
 * (them / invalidate / supersede). Doc len thi lay ban moi
 * nhat theo id. Khong bao gio sua/xoa dong da ghi.
 *
 * Cac thao tac:
 *  - addFact: them fact moi (status `active`).
 *  - invalidateFact: dong fact (validTo = bay gio, status
 *    `invalidated`, giu ly do + nguoi vo hieu).
 *  - supersedeFact: them fact moi + dong fact cu voi
 *    supersededBy tro ve fact moi (status `superseded`).
 *  - validAt(t): fact dung tai t (valid time).
 *  - knownAt(t): fact he thong da biet tai t (transaction time).
 *  - history(id): toan bo snapshot cua 1 fact theo thoi gian.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { V28GitBlockStore } from './gitStore';
import {
  errV28,
  factKnownAtV28,
  factValidAtV28,
  jaccardV28,
  makeV28Id,
  normalizeTextV28,
  okV28,
  parseIsoV28,
  tokenizeV28,
  V28_FACTS_FILENAME,
  V28_LIMITS,
  type V28Fact,
  type V28FactInput,
  type V28InvalidateReason,
  type V28Result,
} from './types';

/** Tuy chon khoi tao fact store. */
export interface V28FactStoreOptions {
  /** Git store v28 ben duoi (lay repoDir de dat facts.jsonl). */
  gitStore: V28GitBlockStore;
}

/** Ket qua tim kiem fact. */
export interface V28FactSearchHit {
  fact: V28Fact;
  /** Diem tuong dong lexical 0-1 (token Jaccard, khong phai embedding model). */
  score: number;
}

/**
 * Fact store bi-temporal, append-only.
 *
 * Giu toan bo fact trong RAM (index theo id) + ghi append xuong
 * `facts.jsonl` moi lan thay doi. Tai khoi dong, doc lai file de
 * khoi phuc index.
 */
export class V28FactStore {
  readonly factsPath: string;
  private byId = new Map<string, V28Fact>();
  private order: string[] = [];

  constructor(opts: V28FactStoreOptions) {
    this.factsPath = join(opts.gitStore.repoDir, V28_FACTS_FILENAME);
    mkdirSync(opts.gitStore.repoDir, { recursive: true });
    this.reload();
  }

  /** Doc lai facts.jsonl tu disk (khoi phuc index). */
  reload(): void {
    this.byId.clear();
    this.order = [];
    if (!existsSync(this.factsPath)) return;
    for (const line of readFileSync(this.factsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const fact = JSON.parse(line) as V28Fact;
        if (typeof fact?.id !== 'string') continue;
        if (!this.byId.has(fact.id)) this.order.push(fact.id);
        this.byId.set(fact.id, fact);
      } catch {
        // Dong loi thi bo qua, khong lam hong toan bo store.
      }
    }
  }

  private appendSnapshot(fact: V28Fact): void {
    appendFileSync(this.factsPath, `${JSON.stringify(fact)}\n`, 'utf8');
  }

  private index(fact: V28Fact): void {
    if (!this.byId.has(fact.id)) this.order.push(fact.id);
    this.byId.set(fact.id, fact);
  }

  /** Tong so fact (ke ca da vo hieu). */
  get size(): number {
    return this.byId.size;
  }

  /** So fact dang active. */
  get activeCount(): number {
    let n = 0;
    for (const fact of this.byId.values()) if (fact.status === 'active') n += 1;
    return n;
  }

  /** So fact da invalidated (khong tinh superseded). */
  get invalidatedCount(): number {
    let n = 0;
    for (const fact of this.byId.values()) if (fact.status === 'invalidated') n += 1;
    return n;
  }

  /** So fact da superseded. */
  get supersededCount(): number {
    let n = 0;
    for (const fact of this.byId.values()) if (fact.status === 'superseded') n += 1;
    return n;
  }

  /** Lay fact theo id (ban moi nhat). */
  get(id: string): V28Fact | null {
    return this.byId.get(id) ?? null;
  }

  /** Tat ca fact theo thu tu them vao. */
  all(): V28Fact[] {
    return this.order.map((id) => this.byId.get(id) as V28Fact).filter(Boolean);
  }

  /** Kiem tra du lieu dau vao cua fact moi. */
  private validateInput(input: V28FactInput): string | null {
    if (!input.subject.trim()) return 'subject khong duoc rong';
    if (!input.predicate.trim()) return 'predicate khong duoc rong';
    if (!input.object.trim()) return 'object khong duoc rong';
    const text = input.text ?? `${input.subject} ${input.predicate} ${input.object}`;
    if (text.length > V28_LIMITS.maxFactChars) {
      return `text fact vuot gioi han ${V28_LIMITS.maxFactChars} ky tu`;
    }
    if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
      return 'confidence phai nam trong [0, 1]';
    }
    if (input.validFrom !== undefined && parseIsoV28(input.validFrom) === null) {
      return `validFrom khong hop le: "${input.validFrom}"`;
    }
    return null;
  }

  /** Them fact moi (status `active`, validFrom mac dinh = bay gio). */
  addFact(input: V28FactInput): V28Result<V28Fact> {
    const problem = this.validateInput(input);
    if (problem) return errV28(problem);
    const now = new Date().toISOString();
    const text = (input.text ?? `${input.subject} ${input.predicate} ${input.object}`).trim();
    const fact: V28Fact = {
      id: makeV28Id('fact'),
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      object: input.object.trim(),
      text,
      source: input.source ?? 'user',
      episodeId: input.episodeId,
      botId: input.botId ?? '',
      userId: input.userId,
      agentId: input.agentId,
      runId: input.runId,
      appId: input.appId,
      confidence: input.confidence ?? 0.8,
      tags: [...(input.tags ?? [])],
      createdAt: now,
      updatedAt: now,
      validFrom: input.validFrom ?? now,
      validTo: null,
      invalidatedAt: null,
      status: 'active',
    };
    this.index(fact);
    this.appendSnapshot(fact);
    return okV28({ ...fact });
  }

  /**
   * Vo hieu mot fact: dong cua so hieu luc (validTo = bay gio),
   * ghi ly do + nguoi vo hieu. Fact van con trong store, chi
   * khong con `active` nua. Fact da vo hieu thi khong vo hieu
   * lai duoc.
   */
  invalidateFact(
    id: string,
    opts: { reason: V28InvalidateReason; by: string; note?: string } ,
  ): V28Result<V28Fact> {
    const fact = this.byId.get(id);
    if (!fact) return errV28(`Khong co fact "${id}"`);
    if (fact.status !== 'active') {
      return errV28(`Fact "${id}" da o trang thai ${fact.status}, khong vo hieu lai duoc`);
    }
    const now = new Date().toISOString();
    const updated: V28Fact = {
      ...fact,
      status: 'invalidated',
      validTo: now,
      invalidatedAt: now,
      invalidatedBy: opts.by,
      invalidateReason: opts.reason,
      updatedAt: now,
    };
    if (opts.note) updated.tags = [...new Set([...fact.tags, `note:${opts.note}`])];
    this.index(updated);
    this.appendSnapshot(updated);
    return okV28({ ...updated });
  }

  /**
   * Supersede: them fact moi thay the fact cu, dong fact cu voi
   * `supersededBy` tro ve fact moi. Ca 2 ban ghi deu duoc giu.
   */
  supersedeFact(
    oldId: string,
    replacement: V28FactInput,
    opts: { by: string; reason?: V28InvalidateReason } = { by: 'system' },
  ): V28Result<{ oldFact: V28Fact; newFact: V28Fact }> {
    const old = this.byId.get(oldId);
    if (!old) return errV28(`Khong co fact "${oldId}" de supersede`);
    if (old.status !== 'active') {
      return errV28(`Fact "${oldId}" da o trang thai ${old.status}, khong supersede duoc`);
    }
    const created = this.addFact({
      ...replacement,
      source: replacement.source ?? 'system',
    });
    if (!created.ok) return errV28(created.error);
    const now = new Date().toISOString();
    const closed: V28Fact = {
      ...old,
      status: 'superseded',
      validTo: now,
      invalidatedAt: now,
      invalidatedBy: opts.by,
      invalidateReason: opts.reason ?? 'superseded',
      supersededBy: created.value.id,
      updatedAt: now,
    };
    this.index(closed);
    this.appendSnapshot(closed);
    return okV28({ oldFact: { ...closed }, newFact: created.value });
  }

  /**
   * Fact dung tai thoi diem `at` (valid time) — ke ca fact da bi
   * vo hieu SAU `at` (vi tai `at` no van dung).
   */
  validAt(at: string | Date | number): V28Result<V28Fact[]> {
    const atMs = parseIsoV28(at);
    if (atMs === null) return errV28(`Thoi diem khong hop le: "${String(at)}"`);
    return okV28(this.all().filter((f) => factValidAtV28(f, atMs)));
  }

  /**
   * Fact he thong da biet tai thoi diem `at` (transaction time)
   * — chi fact da duoc tao truoc `at` va chua bi vo hieu truoc `at`.
   */
  knownAt(at: string | Date | number): V28Result<V28Fact[]> {
    const atMs = parseIsoV28(at);
    if (atMs === null) return errV28(`Thoi diem khong hop le: "${String(at)}"`);
    return okV28(this.all().filter((f) => factKnownAtV28(f, atMs)));
  }

  /**
   * Fact dung tai `at` MA he thong da biet truoc `at` (ca 2 truc
   * — giong time-travel chat cua v27, mo rong cho v28).
   */
  validAndKnownAt(at: string | Date | number): V28Result<V28Fact[]> {
    const atMs = parseIsoV28(at);
    if (atMs === null) return errV28(`Thoi diem khong hop le: "${String(at)}"`);
    return okV28(this.all().filter((f) => factValidAtV28(f, atMs) && factKnownAtV28(f, atMs)));
  }

  /** Fact cua mot subject (mac dinh chi active; `includeInactive` de lay ca da dong). */
  factsForSubject(subject: string, opts: { includeInactive?: boolean } = {}): V28Fact[] {
    const normalized = normalizeTextV28(subject);
    return this.all().filter(
      (f) =>
        normalizeTextV28(f.subject) === normalized &&
        (opts.includeInactive === true || f.status === 'active'),
    );
  }

  /** Fact theo (subject, predicate) — dung de phat hien mau thuan. */
  factsForSubjectPredicate(subject: string, predicate: string): V28Fact[] {
    const s = normalizeTextV28(subject);
    const p = normalizeTextV28(predicate);
    return this.all().filter(
      (f) => normalizeTextV28(f.subject) === s && normalizeTextV28(f.predicate) === p,
    );
  }

  /**
   * Lich su cua 1 fact: toan bo snapshot trong facts.jsonl theo
   * thu tu thoi gian (them -> ... -> invalidate/supersede).
   */
  history(id: string): V28Fact[] {
    if (!existsSync(this.factsPath)) return [];
    const out: V28Fact[] = [];
    for (const line of readFileSync(this.factsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const fact = JSON.parse(line) as V28Fact;
        if (fact.id === id) out.push(fact);
      } catch {
        // Dong loi thi bo qua.
      }
    }
    return out;
  }

  /** Tim fact active giong text cho truoc (dedupe: Jaccard >= nguong). */
  findDuplicates(text: string, threshold: number = V28_LIMITS.defaultDedupeThreshold): V28FactSearchHit[] {
    const queryTokens = tokenizeV28(text);
    const hits: V28FactSearchHit[] = [];
    for (const fact of this.all()) {
      if (fact.status !== 'active') continue;
      const score = jaccardV28(queryTokens, tokenizeV28(fact.text));
      if (score >= threshold) hits.push({ fact: { ...fact }, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /** Tim kiem fact theo tu khoa (token overlap), mac dinh chi active. */
  searchFacts(query: string, opts: { limit?: number; includeInactive?: boolean } = {}): V28FactSearchHit[] {
    const queryTokens = tokenizeV28(query);
    if (queryTokens.length === 0) return [];
    const hits: V28FactSearchHit[] = [];
    for (const fact of this.all()) {
      if (opts.includeInactive !== true && fact.status !== 'active') continue;
      const score = jaccardV28(queryTokens, tokenizeV28(fact.text));
      if (score > 0) hits.push({ fact: { ...fact }, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, opts.limit ?? 20));
  }

  /** Xuat toan bo fact (de backup/export). */
  exportFacts(): V28Fact[] {
    return this.all().map((f) => ({ ...f }));
  }

  /**
   * Nhap fact tu snapshot: chi them fact chua co id (khong ghi
   * de fact da co — lich su cu duoc ton trong). Tra so luong da them.
   */
  importFacts(facts: V28Fact[]): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    for (const fact of facts) {
      if (!fact || typeof fact.id !== 'string') {
        skipped += 1;
        continue;
      }
      if (this.byId.has(fact.id)) {
        skipped += 1;
        continue;
      }
      const copy: V28Fact = {
        ...fact,
        tags: [...(fact.tags ?? [])],
      };
      this.index(copy);
      this.appendSnapshot(copy);
      imported += 1;
    }
    return { imported, skipped };
  }

  /** Ghi lai toan bo facts.jsonl tu index (dung sau import lon). */
  rewriteFile(): void {
    const tmp = `${this.factsPath}.tmp`;
    const body = this.all()
      .map((f) => JSON.stringify(f))
      .join('\n');
    writeFileSync(tmp, body.length > 0 ? `${body}\n` : '', 'utf8');
    renameSync(tmp, this.factsPath);
  }
}
