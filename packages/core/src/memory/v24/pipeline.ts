/**
 * Memory v24 — pipeline (v1.39, Doi T1).
 *
 * Gop cac lop v24 thanh 1 pipeline duy nhat ma tool / agent goi:
 *  - addConversation(turns, scope, source): admission screen
 *    tung turn -> extract ADD-only -> detect conflict -> auto
 *    resolve (supersede/merge/keep_both/reject/quarantine) ->
 *    ghi fact + cap nhat MemFS node "conversations.md" (append
 *    tom tat) -> tra bao cao day du.
 *  - search / searchScoped: fused retrieval (fact + lesson +
 *    MemFS), kem scope.
 *  - snapshotForPrompt: snapshot MemFS + lesson + fact trong
 *    ngan sach ky tu (luon co trong system prompt).
 *  - runSleep: sleep-time consolidation (idle hoac force).
 *  - addLessonFromText: tao lesson kem evidence tu conversation
 *    (evidence = doan trich goc cua turn).
 *
 * Pipeline KHONG goi model, KHONG goi mang. Moi loi tra ket qua
 * co cau truc thay vi throw (tru dau vao sai kieu).
 */
import { V24AdmissionPolicy } from './admission';
import { extractV24Candidates, type V24Turn } from './extraction';
import { decideResolutionV24 } from './conflicts';
import { makeEvidenceV24 } from './evidence';
import { runV24Sleep } from './sleep';
import { V24Store, scopeVisibleV24 } from './store';
import {
  clamp01V24,
  isoAtV24,
  makeV24Id,
  truncateV24,
  type V24Fact,
  type V24FusionHit,
  type V24FusionWeights,
  type V24Lesson,
  type V24Scope,
  type V24Snapshot,
  type V24Stats,
  V24_EMPTY_SCOPE,
} from './types';

/** Bao cao 1 lan addConversation. */
export interface V24AddReport {
  /** So turn da xu ly. */
  turns: number;
  /** So candidate trich duoc. */
  extracted: number;
  /** So fact moi duoc them (add + keep_both). */
  added: number;
  /** So fact cu bi supersede. */
  superseded: number;
  /** So fact duoc merge. */
  merged: number;
  /** So candidate bi reject. */
  rejected: number;
  /** So turn bi admission chan (deny/quarantine). */
  blockedByAdmission: number;
  /** So turn noise. */
  noise: number;
  /** So conflict phat hien. */
  conflicts: number;
  /** Id fact moi. */
  addedIds: string[];
  /** Id lesson moi (neu co, tu decision). */
  lessonIds: string[];
  /** Thoi gian chay (ms). */
  durationMs: number;
  /** Dong log ngan cho nguoi doc. */
  log: string[];
}

/** Pipeline memory v24. */
export class V24Pipeline {
  readonly store: V24Store;
  private lastActivityMs: number | null = null;
  private readonly now: () => number;

  constructor(store?: V24Store, opts: { now?: () => number } = {}) {
    this.store = store ?? new V24Store({ now: opts.now });
    this.now = opts.now ?? Date.now;
  }

  /** Cap nhat thoi diem hoat dong cuoi (dung cho sleep idle check). */
  markActivity(nowMs?: number): void {
    this.lastActivityMs = nowMs ?? this.now();
  }

  getLastActivityMs(): number | null {
    return this.lastActivityMs;
  }

  /**
   * Them hoi thoai vao memory: admission -> extract ADD-only ->
   * conflict auto-resolve -> ghi fact -> cap nhat MemFS.
   */
  async addConversation(
    turns: V24Turn[],
    scope: Partial<V24Scope> = {},
    source = 'pipeline:addConversation',
  ): Promise<V24AddReport> {
    const started = Date.now();
    const fullScope: V24Scope = { ...V24_EMPTY_SCOPE, ...scope };
    const log: string[] = [];
    this.markActivity();
    let blockedByAdmission = 0;
    const admittedTurns: V24Turn[] = [];
    for (const turn of turns) {
      const decision = this.store.admission.screen({
        text: turn.text,
        scope: fullScope,
        confidence: 0.6,
        nowMs: this.now(),
      });
      if (decision.verdict === 'deny') {
        blockedByAdmission++;
        log.push(`Deny turn (${decision.triggeredRules.join(', ')}): ${truncateV24(turn.text, 80)}`);
        continue;
      }
      if (decision.verdict === 'quarantine') {
        blockedByAdmission++;
        log.push(`Quarantine turn (${decision.triggeredRules.join(', ')}): ${truncateV24(turn.text, 80)}`);
        continue;
      }
      admittedTurns.push(turn);
    }

    const extraction = extractV24Candidates(admittedTurns, { nowMs: this.now() });
    let added = 0;
    let superseded = 0;
    let merged = 0;
    let rejected = 0;
    let conflictsFound = 0;
    const addedIds: string[] = [];
    const lessonIds: string[] = [];

    for (const candidate of extraction.candidates) {
      const conflicts = this.store.detectConflicts(candidate, fullScope);
      conflictsFound += conflicts.length;
      const provenance = {
        episodeId: makeV24Id('ep'),
        turnId: makeV24Id('turn'),
        runId: fullScope.runId,
        botId: fullScope.agentId,
        userId: fullScope.userId,
        sourceText: candidate.sourceText,
        method: 'rule' as const,
        extractor: 'v24-rule-v1',
        embeddingKind: 'hash' as const,
      };
      if (conflicts.length === 0) {
        const put = this.store.putFact(candidate, { scope: fullScope, provenance });
        if (put.ok && put.value) {
          added++;
          addedIds.push(put.value.id);
        } else {
          log.push(`Put fact that bai: ${put.error}`);
        }
        continue;
      }
      // Giai quyet tung conflict theo thu tu nghiem trong; chi
      // conflict dau tien quyet dinh so phan cua candidate nay.
      const first = conflicts[0];
      const existing = this.store.getFact(first.existingFactId);
      if (!existing) {
        const put = this.store.putFact(candidate, { scope: fullScope, provenance });
        if (put.ok && put.value) {
          added++;
          addedIds.push(put.value.id);
        }
        continue;
      }
      const decided = decideResolutionV24(first, existing);
      const applied = this.store.applyResolution(first, decided.strategy, {
        scope: fullScope,
        provenance,
        decidedBy: 'auto',
        reason: decided.reason,
      });
      if (!applied.ok || !applied.value) {
        log.push(`Resolve conflict that bai: ${applied.error}`);
        continue;
      }
      const strategy = applied.value.resolution.strategy;
      if (strategy === 'supersede') superseded++;
      else if (strategy === 'merge') merged++;
      else if (strategy === 'reject_incoming') rejected++;
      else if (strategy === 'keep_both') {
        added++;
        if (applied.value.resultingFactId) addedIds.push(applied.value.resultingFactId);
      }
      if (applied.value.resultingFactId) {
        addedIds.push(applied.value.resultingFactId);
      }
      log.push(`${strategy}: ${candidate.subject} ${candidate.edge} ${candidate.object} — ${decided.reason}`);
      // Conflict con lai (neu co > 1) van giu o store de duyet sau.
    }

    // Decision -> lesson kem evidence (doan trich goc cua turn).
    for (const candidate of extraction.candidates) {
      if (candidate.kind !== 'decision') continue;
      const evidence = makeEvidenceV24({
        kind: 'conversation',
        source: `conversation:${fullScope.runId || 'adhoc'}`,
        excerpt: candidate.sourceText,
        uri: null,
        capturedAt: isoAtV24(this.now()),
        capturedBy: fullScope.agentId,
        confidence: candidate.confidence,
      });
      const lesson = this.store.addLesson({
        title: `Quyet dinh: ${truncateV24(candidate.object, 80)}`,
        body: `Da quyet dinh: ${candidate.subject} ${candidate.edge} ${candidate.object}. Nguon: "${candidate.sourceText}"`,
        evidence: [evidence],
        confidence: candidate.confidence,
        importance: 0.7,
        tags: ['decision', 'auto'],
        scope: fullScope,
        authorBotId: fullScope.agentId,
        nowMs: this.now(),
      });
      if (lesson.ok && lesson.value) lessonIds.push(lesson.value.id);
    }

    // Cap nhat MemFS: append tom tat vao conversations.md (neu co fact moi).
    if (addedIds.length > 0) {
      const summary = admittedTurns
        .map((t) => `- [${t.role}] ${truncateV24(t.text, 200)}`)
        .join('\n');
      const existingNode = this.store.memfs.get('conversations.md');
      if (existingNode) {
        const merged = `${existingNode.body}\n\n## ${isoAtV24(this.now())}\n${summary}`;
        this.store.memfs.editNode('conversations.md', merged, {
          updatedBy: fullScope.agentId,
          reason: `append ${addedIds.length} fact`,
        });
      } else {
        this.store.memfs.addNode(
          'conversations.md',
          `# Conversations\n\n## ${isoAtV24(this.now())}\n${summary}`,
          { updatedBy: fullScope.agentId, scope: fullScope, reason: 'create' },
        );
      }
    }

    void source;
    return {
      turns: turns.length,
      extracted: extraction.candidates.length,
      added,
      superseded,
      merged,
      rejected,
      blockedByAdmission,
      noise: extraction.noiseTurns,
      conflicts: conflictsFound,
      addedIds,
      lessonIds,
      durationMs: Date.now() - started,
      log,
    };
  }

  /** Fused search (fact + lesson + MemFS). */
  search(
    query: string,
    opts: { topK?: number; scope?: V24Scope; weights?: V24FusionWeights; includeMemfs?: boolean } = {},
  ): V24FusionHit[] {
    this.markActivity();
    return this.store.search(query, { ...opts, nowMs: this.now() });
  }

  /** Search theo scope (user/agent/run). */
  searchScoped(
    query: string,
    scope: Partial<V24Scope>,
    opts: { topK?: number } = {},
  ): { hits: V24FusionHit[]; scope: V24Scope } {
    this.markActivity();
    const fullScope: V24Scope = { ...V24_EMPTY_SCOPE, ...scope };
    return this.store.searchScoped(query, fullScope, { topK: opts.topK, nowMs: this.now() });
  }

  /** Snapshot cho system prompt (MemFS + lesson + fact trong ngan sach). */
  snapshotForPrompt(opts: { budgetChars?: number; scope?: V24Scope } = {}): V24Snapshot {
    return this.store.snapshotForPrompt(opts);
  }

  /** Render snapshot thanh text de dua vao system prompt. */
  renderPromptSnapshot(opts: { budgetChars?: number; scope?: V24Scope } = {}): string {
    const snap = this.snapshotForPrompt(opts);
    const lines: string[] = ['# Memory (v24 snapshot)'];
    lines.push(`## Files (${snap.tree.length})`);
    for (const p of snap.tree) lines.push(`- ${p}`);
    for (const [p, content] of Object.entries(snap.nodes)) {
      lines.push(`## ${p}\n${content}`);
    }
    if (snap.lessons.length > 0) {
      lines.push('## Lessons');
      for (const l of snap.lessons) lines.push(`- ${l.title}: ${truncateV24(l.body, 200)}`);
    }
    if (snap.facts.length > 0) {
      lines.push('## Facts');
      for (const f of snap.facts) lines.push(`- ${f}`);
    }
    // Shared blocks cua bot (neu co scope agentId).
    if (opts.scope?.agentId) {
      const blocks = this.store.blocks.list({ botId: opts.scope.agentId });
      if (blocks.length > 0) {
        lines.push('## Shared blocks');
        for (const b of blocks) {
          lines.push(`### ${b.name} (v${b.version})`);
          lines.push(truncateV24(b.content, 1000));
        }
      }
    }
    return lines.join('\n');
  }

  /** Chay sleep-time consolidation (idle hoac force). */
  runSleep(opts: { maxOps?: number; force?: boolean } = {}): import('./types').V24SleepReport {
    return runV24Sleep(this.store, {
      maxOps: opts.maxOps,
      force: opts.force ?? true,
      lastActivityAtMs: this.lastActivityMs,
      nowMs: this.now(),
    });
  }

  /** Thong ke + health. */
  stats(): V24Stats {
    return this.store.stats();
  }

  health(): import('./types').V24HealthIssue[] {
    return this.store.health();
  }

  /** Tao lesson truc tiep kem evidence (tool memory_v24_lesson). */
  addLessonFromText(input: {
    title: string;
    body: string;
    evidenceText: string;
    evidenceSource: string;
    scope: Partial<V24Scope>;
    authorBotId?: string;
    confidence?: number;
    importance?: number;
    tags?: string[];
  }): { ok: boolean; lesson?: V24Lesson; error?: string } {
    const fullScope: V24Scope = { ...V24_EMPTY_SCOPE, ...input.scope };
    const evidence = makeEvidenceV24({
      kind: 'conversation',
      source: input.evidenceSource,
      excerpt: input.evidenceText,
      capturedAt: isoAtV24(this.now()),
      capturedBy: input.authorBotId ?? fullScope.agentId,
      confidence: input.confidence ?? 0.7,
    });
    const res = this.store.addLesson({
      title: input.title,
      body: input.body,
      evidence: [evidence],
      confidence: input.confidence ?? 0.7,
      importance: input.importance ?? 0.5,
      tags: input.tags ?? [],
      scope: fullScope,
      authorBotId: input.authorBotId ?? fullScope.agentId,
      nowMs: this.now(),
    });
    if (!res.ok || !res.value) return { ok: false, error: res.error ?? 'add lesson that bai.' };
    return { ok: true, lesson: res.value };
  }

  /** Kiem tra scope cua 1 fact co thay trong scope query khong. */
  isFactVisible(fact: V24Fact, scope: V24Scope): boolean {
    return scopeVisibleV24(fact.scope, scope);
  }

  /** Clamp helper (de test dung). */
  clamp01(value: number): number {
    return clamp01V24(value);
  }
}
