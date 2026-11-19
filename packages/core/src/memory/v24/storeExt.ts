
/** --- Store v24: lessons + search + snapshot + stats + persistence (phan 2) --- */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createLessonV24,
  lessonHasValidEvidenceV24,
  type V24NewLessonInput,
} from './evidence';
import { loadMemfsFromDirV24, saveMemfsToDirV24, snapshotMemfsV24, brokenMemLinksV24 } from './memfsGraph';
import {
  clamp01V24,
  isoAtV24,
  scopeLevelV24,
  type V24FactStatus,
  type V24FusionHit,
  type V24FusionWeights,
  type V24HealthIssue,
  type V24Lesson,
  type V24RecordKind,
  type V24Scope,
  type V24Snapshot,
  type V24Stats,
  V24_DEFAULT_SNAPSHOT_BUDGET_CHARS,
  V24_MAX_LESSONS_PER_SCOPE,
} from './types';
import { applyDecayToFactV24, applyDecayToLessonV24, recordAccessFactV24 } from './decay';
import {
  factToCandidateV24,
  fusedSearchV24,
  lessonToCandidateV24,
  memNodeToCandidateV24,
} from './fusion';
import { V24Store, V24_MEMFS_DIRNAME, V24_STORE_FILE, scopeVisibleV24, type V24StoreResult } from './store';

/** Them cac method mo rong vao V24Store qua declaration merging (cung file logic). */

declare module './store' {
  interface V24Store {
    addLesson(input: V24NewLessonInput): V24StoreResult<V24Lesson>;
    getLesson(id: string): V24Lesson | null;
    listLessons(opts?: { scope?: V24Scope; status?: V24Lesson['status']; limit?: number }): V24Lesson[];
    applyLesson(id: string): V24StoreResult<V24Lesson>;
    retractLesson(id: string, reason: string): V24StoreResult<V24Lesson>;
    search(query: string, opts?: { topK?: number; scope?: V24Scope; weights?: V24FusionWeights; includeMemfs?: boolean; nowMs?: number }): V24FusionHit[];
    searchScoped(query: string, scope: V24Scope, opts?: { topK?: number; nowMs?: number }): { hits: V24FusionHit[]; scope: V24Scope };
    snapshotForPrompt(opts?: { budgetChars?: number; scope?: V24Scope }): V24Snapshot;
    stats(): V24Stats;
    health(): V24HealthIssue[];
    save(dir: string): V24StoreResult<{ file: string; facts: number; lessons: number }>;
  }
}

// Thuc thi cac method mo rong (gan vao prototype — giu 1 class duy nhat).
const proto = V24Store.prototype as unknown as Record<string, unknown>;

proto.addLesson = function (
  this: V24Store,
  input: V24NewLessonInput,
): V24StoreResult<V24Lesson> {
  const self = this as unknown as {
    lessons: Map<string, V24Lesson>;
    now: () => number;
  };
  const scopeCount = [...self.lessons.values()].filter(
    (l) => l.scope.userId === input.scope.userId && l.scope.agentId === input.scope.agentId,
  ).length;
  if (scopeCount >= V24_MAX_LESSONS_PER_SCOPE) {
    return { ok: false, error: `Scope da dat gioi han ${V24_MAX_LESSONS_PER_SCOPE} lesson.` };
  }
  const lesson = createLessonV24(input);
  self.lessons.set(lesson.id, lesson);
  return { ok: true, value: { ...lesson, evidence: lesson.evidence.map((e) => ({ ...e })) } };
};

proto.getLesson = function (this: V24Store, id: string): V24Lesson | null {
  const self = this as unknown as { lessons: Map<string, V24Lesson> };
  const l = self.lessons.get(id);
  return l ? { ...l, evidence: l.evidence.map((e) => ({ ...e })), tags: [...l.tags] } : null;
};

proto.listLessons = function (
  this: V24Store,
  opts: { scope?: V24Scope; status?: V24Lesson['status']; limit?: number } = {},
): V24Lesson[] {
  const self = this as unknown as { lessons: Map<string, V24Lesson> };
  const out: V24Lesson[] = [];
  for (const l of self.lessons.values()) {
    if (opts.scope && !scopeVisibleV24(l.scope, opts.scope)) continue;
    if (opts.status && l.status !== opts.status) continue;
    out.push({ ...l, evidence: l.evidence.map((e) => ({ ...e })), tags: [...l.tags] });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
};

proto.applyLesson = function (this: V24Store, id: string): V24StoreResult<V24Lesson> {
  const self = this as unknown as { lessons: Map<string, V24Lesson>; now: () => number };
  const l = self.lessons.get(id);
  if (!l) return { ok: false, error: `Khong co lesson "${id}".` };
  if (l.status !== 'active') return { ok: false, error: `Lesson "${id}" o status ${l.status}, khong ap dung duoc.` };
  l.appliedCount += 1;
  l.lastAppliedAt = isoAtV24(self.now());
  return { ok: true, value: { ...l, evidence: l.evidence.map((e) => ({ ...e })) } };
};

proto.retractLesson = function (this: V24Store, id: string, reason: string): V24StoreResult<V24Lesson> {
  const self = this as unknown as { lessons: Map<string, V24Lesson>; now: () => number };
  const l = self.lessons.get(id);
  if (!l) return { ok: false, error: `Khong co lesson "${id}".` };
  l.status = 'retracted';
  l.statusReason = reason;
  l.updatedAt = isoAtV24(self.now());
  return { ok: true, value: { ...l, evidence: l.evidence.map((e) => ({ ...e })) } };
};

proto.search = function (
  this: V24Store,
  query: string,
  opts: { topK?: number; scope?: V24Scope; weights?: V24FusionWeights; includeMemfs?: boolean; nowMs?: number } = {},
): V24FusionHit[] {
  const self = this as unknown as {
    listFacts: (o?: unknown) => import('./types').V24Fact[];
    listLessons: (o?: unknown) => V24Lesson[];
    memfs: import('./memfs').V24MemFS;
    now: () => number;
  };
  const nowMs = opts.nowMs ?? self.now();
  const candidates: import('./fusion').V24SearchCandidate[] = [];
  for (const f of self.listFacts({ status: 'active' as V24FactStatus, ...(opts.scope ? { scope: opts.scope } : {}) })) {
    candidates.push(factToCandidateV24(f));
  }
  for (const l of self.listLessons({ status: 'active', ...(opts.scope ? { scope: opts.scope } : {}) })) {
    candidates.push(lessonToCandidateV24(l));
  }
  if (opts.includeMemfs !== false) {
    for (const n of self.memfs.list()) {
      // Node MemFS cung ton trong scope (neu query co scope).
      if (opts.scope && !scopeVisibleV24(n.scope, opts.scope)) continue;
      candidates.push(memNodeToCandidateV24(n));
    }
  }
  const hits = fusedSearchV24(query, candidates, {
    topK: opts.topK ?? 10,
    weights: opts.weights,
    nowMs,
  });
  // Ghi nhan access cho fact duoc tra ve (boost + revive).
  const access = this as unknown as {
    facts: Map<string, import('./types').V24Fact>;
  };
  for (const hit of hits) {
    if (hit.sourceKind !== 'fact') continue;
    const f = access.facts.get(hit.id);
    if (f) {
      const res = recordAccessFactV24(f, undefined, nowMs);
      access.facts.set(hit.id, res.fact);
    }
  }
  return hits;
};

proto.searchScoped = function (
  this: V24Store,
  query: string,
  scope: V24Scope,
  opts: { topK?: number; nowMs?: number } = {},
): { hits: V24FusionHit[]; scope: V24Scope } {
  const search = (this as unknown as { search: (q: string, o?: unknown) => V24FusionHit[] }).search;
  const hits = search.call(this, query, { topK: opts.topK ?? 10, scope, nowMs: opts.nowMs });
  return { hits, scope: { ...scope } };
};

proto.snapshotForPrompt = function (
  this: V24Store,
  opts: { budgetChars?: number; scope?: V24Scope } = {},
): V24Snapshot {
  const self = this as unknown as {
    memfs: import('./memfs').V24MemFS;
    listFacts: (o?: unknown) => import('./types').V24Fact[];
    listLessons: (o?: unknown) => V24Lesson[];
    blocks: import('./sharedBlocks').V24SharedBlockStore;
  };
  const budget = opts.budgetChars ?? V24_DEFAULT_SNAPSHOT_BUDGET_CHARS;
  const memfsBudget = Math.floor(budget * 0.5);
  const snap = snapshotMemfsV24(self.memfs, { budgetChars: memfsBudget });
  const lessons = self
    .listLessons({ status: 'active', ...(opts.scope ? { scope: opts.scope } : {}), limit: 50 })
    .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
  const facts = self
    .listFacts({ status: 'active' as V24FactStatus, ...(opts.scope ? { scope: opts.scope } : {}), limit: 100 })
    .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
  const outLessons: V24Snapshot['lessons'] = [];
  const outFacts: string[] = [];
  let chars = snap.chars;
  for (const l of lessons) {
    const text = `${l.title}: ${l.body}`;
    if (chars + text.length > budget) break;
    outLessons.push({ id: l.id, title: l.title, body: l.body });
    chars += text.length + 1;
  }
  for (const f of facts) {
    const text = `${f.subject} ${f.edge} ${f.object}`;
    if (chars + text.length > budget) break;
    outFacts.push(text);
    chars += text.length + 1;
  }
  return {
    tree: snap.tree,
    nodes: snap.nodes,
    lessons: outLessons,
    facts: outFacts,
    chars,
    budgetChars: budget,
    generatedAt: new Date().toISOString(),
  };
};

proto.stats = function (this: V24Store): V24Stats {
  const self = this as unknown as {
    facts: Map<string, import('./types').V24Fact>;
    lessons: Map<string, V24Lesson>;
    memfs: import('./memfs').V24MemFS;
    blocks: import('./sharedBlocks').V24SharedBlockStore;
    conflicts: import('./types').V24Conflict[];
    resolutions: import('./types').V24Resolution[];
    admission: import('./admission').V24AdmissionPolicy;
    now: () => number;
  };
  const facts = [...self.facts.values()];
  const lessons = [...self.lessons.values()];
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let confSum = 0;
  for (const f of facts) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    confSum += f.confidence;
  }
  const admissionCounts = self.admission.counts();
  const nowMs = self.now();
  return {
    factsTotal: facts.length,
    factsActive: facts.filter((f) => f.status === 'active').length,
    factsByKind: byKind,
    factsByStatus: byStatus,
    lessonsTotal: lessons.length,
    lessonsActive: lessons.filter((l) => l.status === 'active').length,
    lessonsQuarantined: lessons.filter((l) => l.status === 'quarantined').length,
    lessonsWithEvidence: lessons.filter((l) => lessonHasValidEvidenceV24(l)).length,
    memfsNodes: self.memfs.size,
    memfsDeleted: self.memfs.list({ includeDeleted: true }).filter((n) => n.deleted).length,
    sharedBlocks: self.blocks.size,
    sharedBlocksLocked: self.blocks.list().filter((b) => b.lock !== null).length,
    conflictsOpen: self.conflicts.length - self.resolutions.length,
    resolutionsTotal: self.resolutions.length,
    admissionAllowed: admissionCounts.allow,
    admissionQuarantined: admissionCounts.quarantine,
    admissionDenied: admissionCounts.deny,
    avgConfidence: facts.length === 0 ? 0 : Math.round((confSum / facts.length) * 100) / 100,
  };
};

proto.health = function (this: V24Store): V24HealthIssue[] {
  const self = this as unknown as {
    lessons: Map<string, V24Lesson>;
    memfs: import('./memfs').V24MemFS;
    conflicts: import('./types').V24Conflict[];
    resolutions: import('./types').V24Resolution[];
    admission: import('./admission').V24AdmissionPolicy;
    stats: () => V24Stats;
  };
  const issues: V24HealthIssue[] = [];
  const stats = self.stats();
  const lessons = [...self.lessons.values()];
  const noEvidence = lessons.filter((l) => l.status === 'active' && !lessonHasValidEvidenceV24(l));
  if (noEvidence.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'lesson-no-evidence',
      detail: `${noEvidence.length} lesson active khong co evidence hop le.`,
      suggestion: 'Bo sung evidence (nguon/doan trich/thoi diem) hoac retract lesson.',
    });
  }
  const openConflicts = self.conflicts.length - self.resolutions.length;
  if (openConflicts > 0) {
    issues.push({
      severity: 'info',
      code: 'conflict-open',
      detail: `${openConflicts} conflict chua co resolution.`,
      suggestion: 'Chay memory_v24_conflict de resolve (auto hoac duyet tay).',
    });
  }
  const broken = brokenMemLinksV24(self.memfs);
  if (broken.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'memfs-broken-link',
      detail: `${broken.length} link MemFS do (vd ${broken[0].from} -> ${broken[0].to}).`,
      suggestion: 'Sua link hoac tao node dich.',
    });
  }
  const counts = self.admission.counts();
  if (counts.deny >= 5) {
    issues.push({
      severity: 'warning',
      code: 'admission-deny-many',
      detail: `${counts.deny} lan ghi bi admission deny (co the co memory poisoning).`,
      suggestion: 'Xem admission log, kiem tra nguon du lieu.',
    });
  }
  if (stats.lessonsTotal > 0 && stats.lessonsWithEvidence / stats.lessonsTotal < 0.5) {
    issues.push({
      severity: 'warning',
      code: 'evidence-coverage-low',
      detail: `Evidence coverage thap (${Math.round((stats.lessonsWithEvidence / stats.lessonsTotal) * 100)}%).`,
      suggestion: 'Lesson moi phai kem evidence; bo sung evidence cho lesson cu.',
    });
  }
  if (issues.length === 0) {
    issues.push({
      severity: 'info',
      code: 'healthy',
      detail: 'Store v24 khoe: khong co van de.',
      suggestion: 'Khong can hanh dong.',
    });
  }
  return issues;
};

proto.save = function (
  this: V24Store,
  dir: string,
): V24StoreResult<{ file: string; facts: number; lessons: number }> {
  const self = this as unknown as {
    facts: Map<string, import('./types').V24Fact>;
    lessons: Map<string, V24Lesson>;
    memfs: import('./memfs').V24MemFS;
    blocks: import('./sharedBlocks').V24SharedBlockStore;
    conflicts: import('./types').V24Conflict[];
    resolutions: import('./types').V24Resolution[];
    admission: import('./admission').V24AdmissionPolicy;
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const memfsDir = path.join(dir, V24_MEMFS_DIRNAME);
    const memRes = saveMemfsToDirV24(self.memfs, memfsDir);
    if (!memRes.ok) return { ok: false, error: `Luu MemFS that bai: ${memRes.error}` };
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      facts: [...self.facts.values()],
      lessons: [...self.lessons.values()],
      conflicts: self.conflicts,
      resolutions: self.resolutions,
      admissionLog: self.admission.listLog({}),
      blocks: self.blocks.exportAll(),
    };
    const file = path.join(dir, V24_STORE_FILE);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, value: { file, facts: self.facts.size, lessons: self.lessons.size } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** Load store tu thu muc disk (tra store moi; loi -> {ok:false}). */
export function loadV24StoreFromDir(
  dir: string,
  opts: { now?: () => number } = {},
): V24StoreResult<V24Store> {
  try {
    const store = new V24Store({ now: opts.now });
    const file = path.join(dir, V24_STORE_FILE);
    if (fs.existsSync(file)) {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        facts?: import('./types').V24Fact[];
        lessons?: V24Lesson[];
        conflicts?: import('./types').V24Conflict[];
        resolutions?: import('./types').V24Resolution[];
        blocks?: import('./types').V24SharedBlock[];
      };
      const self = store as unknown as {
        facts: Map<string, import('./types').V24Fact>;
        lessons: Map<string, V24Lesson>;
        conflicts: import('./types').V24Conflict[];
        resolutions: import('./types').V24Resolution[];
      };
      for (const f of payload.facts ?? []) self.facts.set(f.id, f);
      for (const l of payload.lessons ?? []) self.lessons.set(l.id, l);
      self.conflicts = [...(payload.conflicts ?? [])];
      self.resolutions = [...(payload.resolutions ?? [])];
      for (const b of payload.blocks ?? []) store.blocks.restore(b);
    }
    const memfsDir = path.join(dir, V24_MEMFS_DIRNAME);
    if (fs.existsSync(memfsDir)) {
      const loaded = loadMemfsFromDirV24(memfsDir);
      if (!loaded.ok || !loaded.value) return { ok: false, error: `Load MemFS that bai: ${loaded.error}` };
      const target = store.memfs as unknown as {
        nodes: Map<string, import('./types').V24MemNode>;
        versions: Map<string, import('./types').V24MemVersion[]>;
      };
      const source = loaded.value as unknown as {
        nodes: Map<string, import('./types').V24MemNode>;
        versions: Map<string, import('./types').V24MemVersion[]>;
      };
      target.nodes = source.nodes;
      target.versions = source.versions;
    }
    return { ok: true, value: store };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ap dung decay cho toan bo fact/lesson trong store (dung boi sleep job).
 *  Co gioi han `limit`: chi xu ly toi da `limit` fact/lesson moi pass
 *  (het ngan sach thi pass sau lam tiep) — tra so da xu ly / tong so. */
export function decayStoreV24(
  store: V24Store,
  nowMs: number = Date.now(),
  limit: number = Number.POSITIVE_INFINITY,
): { outcomes: import('./types').V24DecayOutcome[]; archived: number; stale: number; processed: number; total: number } {
  const self = store as unknown as {
    facts: Map<string, import('./types').V24Fact>;
    lessons: Map<string, V24Lesson>;
  };
  const outcomes: import('./types').V24DecayOutcome[] = [];
  let archived = 0;
  let stale = 0;
  let processed = 0;
  const total = self.facts.size + self.lessons.size;
  const take = (): boolean => {
    if (processed >= limit) return false;
    processed++;
    return true;
  };
  for (const f of [...self.facts.values()]) {
    if (!take()) break;
    const res = applyDecayToFactV24(f, undefined, nowMs);
    self.facts.set(f.id, res.fact);
    if (res.outcome.action !== 'unchanged') outcomes.push(res.outcome);
    if (res.outcome.action === 'archived' || res.outcome.action === 'expired') archived++;
    if (res.outcome.action === 'stale') stale++;
  }
  if (processed < limit) {
    for (const l of [...self.lessons.values()]) {
      if (!take()) break;
      const res = applyDecayToLessonV24(l, undefined, nowMs);
      self.lessons.set(l.id, res.lesson);
      if (res.outcome.action !== 'unchanged') outcomes.push(res.outcome);
      if (res.outcome.action === 'archived' || res.outcome.action === 'expired') archived++;
      if (res.outcome.action === 'stale') stale++;
    }
  }
  return { outcomes, archived, stale, processed, total };
}

