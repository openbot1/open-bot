/**
 * Memory v17 (mem0-v3 style) tools for @open-bot/tools (v1.36, Doi T1).
 *
 * LUU Y TEN: `memoryV17Tools.ts` + tool `memory_v17_*` da thuoc memory v17
 * kieu block cua v1.18 — file nay la memory v17 mem0-style RIENG, ten tool
 * co tien to `memory_v17_mem0_` de khong xung dot registry.
 *
 * Agent lam viec voi memory v17 mem0-style bang tool call:
 *  - memory_v17_mem0_extract        — ingest turn: extract single-pass ADD-only (0..1 LLM call), detect conflict, auto-resolve an toan / queue cho duyet, link entity (needsApproval: true)
 *  - memory_v17_mem0_entity_link    — link 1 fact vao entity (tao/lay entity + typed edge) (needsApproval: true)
 *  - memory_v17_mem0_entity_list    — liet ke entity trong scope + edge cua entity (read)
 *  - memory_v17_mem0_entity_merge   — merge 2 entity cung scope (ten/alias khop, kem ly do) (needsApproval: true)
 *  - memory_v17_mem0_conflict_list  — liet ke conflict dang cho duyet + lich su resolve (read)
 *  - memory_v17_mem0_conflict_resolve — giai quyet 1 conflict (overwrite/merge/keep_both/reject_incoming, kem ly do) (needsApproval: true)
 *  - memory_v17_mem0_search         — retrieval fusion semantic + BM25 + entity + time-aware, kem score breakdown (read)
 *  - memory_v17_mem0_state_at       — fact dung tai thoi diem T (valid time) + he thong biet gi tai T (transaction time) (read)
 *  - memory_v17_mem0_fact_timeline  — timeline cua 1 fact + chuoi supersession (read)
 *  - memory_v17_mem0_scope_audit    — quet leak scope toan store + violation log + grant share (read)
 *  - memory_v17_mem0_eval           — chay eval 40 case, tra so lieu theo category (read)
 *
 * SAFETY: extraction CHI ADD (khong tu UPDATE/DELETE fact cu); moi thay
 * doi fact cu deu qua resolver co provenance + ly do. Moi lan doc deu qua
 * scope guard chat (doc cheo scope bi chan + ghi violation). Khong goi
 * model that, khong goi API ngoai (rule extractor xac dinh; LLM chi qua
 * ham host truyen vao factory neu co).
 *
 * Factory:
 *   createMemoryV17Mem0Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V17_MEM0_TOOLS                      (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  M17Store,
  M17_LOCAL_SCOPE,
  M17ResolutionStrategy,
  createM17Store,
  describeConflictM17,
  describeEntityM17,
  extractTurnsSinglePassM17,
  formatFactTimelineM17,
  formatFusionHitM17,
  formatLeakReportM17,
  formatM17EvalReport,
  isValidEdgeTypeM17,
  runM17Eval,
  validateScopeM17,
} from '@open-bot/core';
import type { M17Scope, M17TurnInput } from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`Argument "${name}" must be an array of strings.`);
    }
  }
  return value as string[];
}

/** Tuy chon factory tool memory v17 mem0-style. */
export interface MemoryV17Mem0ToolOptions {
  /** Store da tao san (test inject store RAM; mac dinh: store RAM moi). */
  store?: M17Store;
  /** Ten collection fact (khi tao store moi). */
  factCollection?: string;
  /** Tu dong resolve conflict an toan (mac dinh true). */
  autoResolve?: boolean;
  /** Bot id goi tool (dung lam actor). */
  botId?: string;
  /** Ham LLM tuy chon cho extraction (goi toi da 1 lan / pass). */
  llmExtract?: (turns: { role: string; text: string }[]) => Promise<
    import('@open-bot/core').M17ExtractedFact[]
  >;
}

/** Scope tu args (tenant/user/bot/conversation) — mac dinh local scope. */
function scopeOf(args: Record<string, unknown>, defaultBotId?: string): M17Scope {
  const scope: M17Scope = {
    tenantId: getOptionalStringArg(args, 'tenantId') ?? M17_LOCAL_SCOPE.tenantId,
    userId: getOptionalStringArg(args, 'userId') ?? M17_LOCAL_SCOPE.userId,
    botId: getOptionalStringArg(args, 'botId') ?? defaultBotId ?? M17_LOCAL_SCOPE.botId,
    conversationId:
      getOptionalStringArg(args, 'conversationId') ?? M17_LOCAL_SCOPE.conversationId,
  };
  const error = validateScopeM17(scope);
  if (error) throw new Error(error);
  return scope;
}

const M17_MEM0_RESOLUTION_STRATEGIES: ReadonlySet<string> = new Set([
  'overwrite',
  'merge',
  'keep_both',
  'reject_incoming',
]);

export function createMemoryV17Mem0Tools(opts: MemoryV17Mem0ToolOptions = {}): Tool[] {
  const store =
    opts.store ??
    createM17Store({
      factCollection: opts.factCollection,
      autoResolve: opts.autoResolve,
    });
  const defaultBotId = opts.botId;

  const extract: Tool = {
    definition: toolDef(
      'memory_v17_mem0_extract',
      'Ingest conversation turns into memory v17 (mem0-v3 style): single-pass ADD-only extraction (rule-based, 0 LLM calls unless the host wired one — at most 1 call per pass), conflict detection against active facts in scope, safe auto-resolve or queue for human review, then entity linking (typed edge into the <name>_entities collection). Never updates or deletes an old fact during extraction. Needs approval.',
      {
        turns: {
          type: 'array',
          description: 'Danh sach turn: [{role: "user"|"assistant", text, episodeId, turnId}].',
          items: { type: 'object' },
        },
        text: { type: 'string', description: 'Text 1 turn user (dung thay cho turns khi chi co 1 turn).' },
        episodeId: { type: 'string', description: 'Episode id — bat buoc khi dung text.' },
        turnId: { type: 'string', description: 'Turn id — bat buoc khi dung text.' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant (mac dinh rong = single-tenant local).' },
        minConfidence: { type: 'number', description: 'Nguong confidence toi thieu (mac dinh 0.5).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const minConfidence = getNumberArg(args, 'minConfidence');
        let turns: M17TurnInput[] = [];
        const rawTurns = args.turns;
        if (Array.isArray(rawTurns)) {
          for (const t of rawTurns as Record<string, unknown>[]) {
            if (!t || typeof t !== 'object') throw new Error('Moi turn phai la object.');
            const role = t.role === 'assistant' ? 'assistant' : 'user';
            const text = typeof t.text === 'string' ? t.text : '';
            turns.push({
              role,
              text,
              episodeId: typeof t.episodeId === 'string' ? t.episodeId : 'ep',
              turnId: typeof t.turnId === 'string' ? t.turnId : 't',
            });
          }
        } else {
          const text = getStringArg(args, 'text');
          turns = [
            {
              role: 'user',
              text,
              episodeId: getStringArg(args, 'episodeId'),
              turnId: getStringArg(args, 'turnId'),
            },
          ];
        }
        if (turns.length === 0) throw new Error('Can it nhat 1 turn.');
        const result = await store.ingestTurns(turns, scope, {
          ...(minConfidence !== undefined ? { minConfidence } : {}),
          ...(opts.llmExtract ? { llmExtract: opts.llmExtract } : {}),
        });
        return (
          `memory v17 extract: ${result.turnsProcessed} turn, ${result.candidates} candidate, ` +
          `${result.factsAdded} fact moi, ${result.conflictsFound} conflict ` +
          `(${result.autoResolved} auto-resolve, ${result.queued} cho duyet, ${result.duplicates} duplicate), ` +
          `${result.entitiesCreated} entity moi, ${result.edgesCreated} edge moi, ${result.llmCalls} LLM call.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const entityLink: Tool = {
    definition: toolDef(
      'memory_v17_mem0_entity_link',
      'Link one extracted fact into the entity graph: get-or-create the subject entity and the object entity in the <name>_entities collection, then get-or-create the typed edge between them (lives_in / prefers / owns / works_at / knows / ...). Subject "user" maps to the stable person entity user:<userId>. Needs approval.',
      {
        subject: { type: 'string', description: 'Chu the (vd "user" hoac ten entity).' },
        edge: { type: 'string', description: 'Typed edge (lives_in/prefers/owns/works_at/works_as/studies_at/knows/member_of/speaks/interested_in/allergic_to/has_goal/uses/located_in/related_to).' },
        object: { type: 'string', description: 'Doi tuong (ten entity / gia tri).' },
        kind: { type: 'string', description: 'Kind cua object entity (person/place/organization/thing/food/activity/language/tool/other).' },
        confidence: { type: 'number', description: 'Do tin cay 0..1 (mac dinh 0.85).' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      ['subject', 'edge', 'object'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const subject = getStringArg(args, 'subject');
        const edge = getStringArg(args, 'edge');
        const object = getStringArg(args, 'object');
        if (!isValidEdgeTypeM17(edge)) throw new Error(`Edge khong hop le: "${edge}".`);
        const kind = (getOptionalStringArg(args, 'kind') ?? 'other') as
          | 'person' | 'place' | 'organization' | 'thing' | 'food' | 'activity' | 'language' | 'tool' | 'other';
        const confidence = getNumberArg(args, 'confidence') ?? 0.85;
        const nowIso = new Date().toISOString();
        const link = store.entities.linkFact(
          {
            subject,
            edge: edge as import('@open-bot/core').M17EdgeType,
            object,
            confidence,
            isNegation: false,
            validFrom: null,
            validTo: null,
            mentionedEntities: [{ name: object, kind }],
            sourceText: `${subject} ${edge} ${object}`,
          },
          scope,
          nowIso,
        );
        return (
          `entity_link: ${describeEntityM17(link.subjectEntity)} —${link.edge.edge}→ ` +
          `${describeEntityM17(link.objectEntity)} ` +
          `(entity moi: subject=${link.createdSubject}, object=${link.createdObject}, edge moi=${link.createdEdge}).`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const entityList: Tool = {
    definition: toolDef(
      'memory_v17_mem0_entity_list',
      'List entities in scope from the <name>_entities collection (filter by kind / keyword, paginated) and show the typed edges of one entity. Also reports orphan entities (active, 0 facts). Read-only.',
      {
        kind: { type: 'string', description: 'Loc theo kind (person/place/organization/thing/food/activity/language/tool/other).' },
        query: { type: 'string', description: 'Tu khoa tim trong ten / alias.' },
        entityId: { type: 'string', description: 'Id entity — neu co, chi hien edge cua entity nay.' },
        limit: { type: 'number', description: 'So ket qua toi da (mac dinh 50, toi da 200).' },
        offset: { type: 'number', description: 'Vi tri bat dau (mac dinh 0).' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const entityId = getOptionalStringArg(args, 'entityId');
        const limit = getNumberArg(args, 'limit');
        const offset = getNumberArg(args, 'offset');
        if (entityId) {
          const edges = store.entities.edgesOf(entityId, scope);
          if (edges.length === 0) return `Entity ${entityId} khong co edge nao trong scope.`;
          return edges
            .map((e) => `${e.fromEntityId} —${e.edge}→ ${e.toEntityId} (conf=${e.confidence.toFixed(2)})`)
            .join('\n');
        }
        const kind = getOptionalStringArg(args, 'kind') as
          | 'person' | 'place' | 'organization' | 'thing' | 'food' | 'activity' | 'language' | 'tool' | 'other' | undefined;
        const query = getOptionalStringArg(args, 'query');
        const { entities, total } = store.entities.listEntities(scope, {
          ...(kind ? { kind } : {}),
          ...(query ? { query } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });
        const orphans = store.entities.orphanEntities(scope).length;
        const lines = [
          `Entities (${entities.length}/${total}, orphans: ${orphans}) — collection "${store.entities.entityCollection}":`,
        ];
        for (const entity of entities) lines.push(`  - ${describeEntityM17(entity)}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const entityMerge: Tool = {
    definition: toolDef(
      'memory_v17_mem0_entity_merge',
      'Merge two entities in the same scope (source into target): aliases and edges move to the survivor, the source becomes status merged (kept, never deleted) with mergedIntoId pointing at the survivor. Requires a reason (provenance). Needs approval.',
      {
        sourceId: { type: 'string', description: 'Id entity nguon (bi gop).' },
        targetId: { type: 'string', description: 'Id entity dich (giu lai).' },
        reason: { type: 'string', description: 'Ly do merge (bat buoc).' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      ['sourceId', 'targetId', 'reason'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const sourceId = getStringArg(args, 'sourceId');
        const targetId = getStringArg(args, 'targetId');
        const reason = getStringArg(args, 'reason');
        const result = store.entities.mergeEntities(sourceId, targetId, scope, reason);
        return (
          `entity_merge: "${result.merged.name}" da gop vao "${result.survivor.name}" ` +
          `(${result.aliasesMoved} alias chuyen, ${result.edgesMoved} edge chuyen). ` +
          `Entity cu giu status merged (khong xoa).`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const conflictList: Tool = {
    definition: toolDef(
      'memory_v17_mem0_conflict_list',
      'List pending conflicts waiting for human review (highest severity first) and the resolution history / audit log. Read-only.',
      {
        history: { type: 'boolean', description: 'true = hien lich su resolve + audit thay vi pending (mac dinh false).' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        scopeOf(args, defaultBotId);
        const showHistory = getBoolArg(args, 'history', false);
        if (showHistory) {
          const audit = store.conflicts.listAudit();
          if (audit.length === 0) return 'Chua co resolution nao.';
          return audit
            .slice(0, 50)
            .map(
              (a) =>
                `[${a.decidedAt}] ${a.kind} ${a.incomingSummary} -> ${a.strategy} (by ${a.decidedBy}): ${a.reason}`,
            )
            .join('\n');
        }
        const pending = store.conflicts.listPending();
        if (pending.length === 0) return 'Khong co conflict dang cho duyet.';
        return pending.map((c) => describeConflictM17(c)).join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const conflictResolve: Tool = {
    definition: toolDef(
      'memory_v17_mem0_conflict_resolve',
      'Resolve one pending conflict: overwrite (new fact wins, old fact superseded — kept in history), merge (old + new values merged into one new fact, old marked merged), keep_both (both facts stay active), or reject_incoming (new fact dropped, old fact confidence bumped). Merge is rejected for single-valued edges; overwrite requires a reason. Needs approval.',
      {
        conflictId: { type: 'string', description: 'Id conflict dang cho.' },
        strategy: { type: 'string', description: '"overwrite" | "merge" | "keep_both" | "reject_incoming".' },
        reason: { type: 'string', description: 'Ly do quyet dinh (bat buoc khi overwrite).' },
        decidedBy: { type: 'string', description: 'Ai quyet dinh (mac dinh "user").' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      ['conflictId', 'strategy', 'reason'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const conflictId = getStringArg(args, 'conflictId');
        const strategy = getStringArg(args, 'strategy');
        if (!M17_MEM0_RESOLUTION_STRATEGIES.has(strategy)) {
          throw new Error(`Strategy khong hop le: "${strategy}".`);
        }
        const reason = getStringArg(args, 'reason');
        const decidedBy = getOptionalStringArg(args, 'decidedBy') ?? 'user';
        void ctx;
        const { resolution, resultingFact } = store.resolvePendingConflict(
          conflictId,
          strategy as M17ResolutionStrategy,
          decidedBy,
          reason,
          scope,
        );
        return (
          `conflict_resolve: ${resolution.strategy} (by ${resolution.decidedBy}) — ` +
          (resultingFact
            ? `fact ket qua ${resultingFact.id}: ${resultingFact.subject} —${resultingFact.edge}→ ${resultingFact.object}.`
            : 'khong tao fact moi.') +
          ` Fact cu ${resolution.affectedFactId ?? ''} da duoc xu ly theo strategy.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const search: Tool = {
    definition: toolDef(
      'memory_v17_mem0_search',
      'Retrieval fusion over active facts in scope: semantic (local hashed embedding) + BM25 keyword + entity matching + time-aware ranking, fused with RRF. Each hit carries an explainable score breakdown (semantic/keyword/entity/time/total). Cross-scope facts never leak into results. Read-only.',
      {
        query: { type: 'string', description: 'Cau truy van.' },
        topK: { type: 'number', description: 'So ket qua toi da (mac dinh 10).' },
        edge: { type: 'string', description: 'Loc theo edge (vd lives_in).' },
        queryEntities: { type: 'array', description: 'Entity trong query (ten) de tinh entity score.', items: { type: 'string' } },
        atIso: { type: 'string', description: 'Thoi diem truy van (ISO, de tinh time score; mac dinh now).' },
        minTotalScore: { type: 'number', description: 'Chi lay hit co tong diem >= nguong nay.' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const query = getStringArg(args, 'query');
        const topK = getNumberArg(args, 'topK');
        const edge = getOptionalStringArg(args, 'edge');
        const queryEntities = getStringArrayArg(args, 'queryEntities');
        const atIso = getOptionalStringArg(args, 'atIso');
        const minTotalScore = getNumberArg(args, 'minTotalScore');
        const result = store.search(query, scope, {
          ...(topK !== undefined ? { topK } : {}),
          ...(edge ? { edge } : {}),
          ...(queryEntities.length > 0 ? { queryEntities } : {}),
          ...(atIso ? { atIso } : {}),
          ...(minTotalScore !== undefined ? { minTotalScore } : {}),
        });
        if (result.hits.length === 0) {
          return `Khong tim thay fact nao cho "${query}" (da xet ${result.considered} fact trong scope).`;
        }
        const lines = [`Fusion search "${query}" (${result.hits.length} hit / ${result.considered} fact):`];
        result.hits.forEach((hit, i) => lines.push(formatFusionHitM17(hit, i + 1)));
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const stateAt: Tool = {
    definition: toolDef(
      'memory_v17_mem0_state_at',
      'Bi-temporal query: facts valid at time T (valid time — what was true then) and facts as known at time T (transaction time — what the system knew then). Old facts are marked invalid/superseded, never deleted, so history stays queryable. Read-only.',
      {
        atIso: { type: 'string', description: 'Thoi diem truy van (ISO).' },
        mode: { type: 'string', description: '"valid" = fact dung tai T (mac dinh) | "known" = he thong biet gi tai T.' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      ['atIso'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const atIso = getStringArg(args, 'atIso');
        const mode = getOptionalStringArg(args, 'mode') ?? 'valid';
        if (mode !== 'valid' && mode !== 'known') throw new Error('mode phai la "valid" hoac "known".');
        const result = mode === 'valid' ? store.stateAt(scope, atIso) : store.asKnownAt(scope, atIso);
        const lines = [
          `state_at (${mode}) @ ${result.at}: ${result.facts.length} fact (tong active trong scope: ${result.totalActiveInScope}).`,
        ];
        for (const fact of result.facts) {
          lines.push(`  - ${fact.subject} —${fact.edge}→ ${fact.object} [hoc ${fact.learnedAt}]`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const factTimeline: Tool = {
    definition: toolDef(
      'memory_v17_mem0_fact_timeline',
      'Show the timeline of one fact (learned / invalidated / superseded / merged / restored steps with timestamps and reasons) plus its supersession chain. Read-only.',
      {
        factId: { type: 'string', description: 'Id fact.' },
        userId: { type: 'string', description: 'User so huu memory (mac dinh local-user).' },
        botId: { type: 'string', description: 'Bot ghi memory.' },
        conversationId: { type: 'string', description: 'Conversation / session.' },
        tenantId: { type: 'string', description: 'Tenant.' },
      },
      ['factId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const scope = scopeOf(args, defaultBotId);
        const factId = getStringArg(args, 'factId');
        const fact = store.graph.getFactInScope(factId, scope);
        const steps = store.factTimeline(factId, scope);
        const chain = store.graph.supersessionChain(factId, scope);
        const lines = [formatFactTimelineM17(fact, steps)];
        if (chain.length > 1) {
          lines.push('Chuoi supersession:');
          for (const f of chain) {
            lines.push(`  - ${f.id}: ${f.subject} —${f.edge}→ ${f.object} [${f.status}]`);
          }
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const scopeAudit: Tool = {
    definition: toolDef(
      'memory_v17_mem0_scope_audit',
      'Audit scope isolation across the whole store: scan every fact/entity/edge for an invalid scope, count blocked cross-scope reads (violation log), list active share grants, and report whether any leak exists. Read-only.',
      {
        showViolations: { type: 'boolean', description: 'true = liet ke violation log (mac dinh false).' },
        showGrants: { type: 'boolean', description: 'true = liet ke grant share (mac dinh false).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const showViolations = getBoolArg(args, 'showViolations', false);
        const showGrants = getBoolArg(args, 'showGrants', false);
        const report = store.scanLeaks();
        const lines = [formatLeakReportM17(report)];
        if (showViolations) {
          const violations = store.guard.listViolations();
          lines.push(`Violations (${violations.length}):`);
          for (const v of violations.slice(0, 20)) {
            lines.push(`  - [${v.at}] ${v.action}: ${v.detail}`);
          }
        }
        if (showGrants) {
          const grants = store.guard.listGrants();
          lines.push(`Grants (${grants.length}):`);
          for (const g of grants) {
            lines.push(
              `  - ${g.id}: ${g.fromScope.userId} -> ${g.toScope.userId} (by ${g.grantedBy}, het han: ${g.expiresAt ?? 'khong'})`,
            );
          }
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'memory_v17_mem0_eval',
      'Run the memory v17 eval (40 cases, no model, no network): extraction, conflict, fusion, bi-temporal and scope-isolation categories. Returns pass rates per category and the list of failing cases. Read-only.',
      {
        category: { type: 'string', description: 'Chi chay 1 category (extraction/conflict/fusion/bi-temporal/isolation) — bo trong = tat ca.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const category = getOptionalStringArg(args, 'category') as
          | 'extraction' | 'conflict' | 'fusion' | 'bi-temporal' | 'isolation' | undefined;
        if (
          category &&
          !['extraction', 'conflict', 'fusion', 'bi-temporal', 'isolation'].includes(category)
        ) {
          throw new Error(`Category khong hop le: "${category}".`);
        }
        const result = await runM17Eval(
          category ? { categories: [category] } : {},
        );
        return formatM17EvalReport(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    extract,
    entityLink,
    entityList,
    entityMerge,
    conflictList,
    conflictResolve,
    search,
    stateAt,
    factTimeline,
    scopeAudit,
    evalTool,
  ];
}

/** Ten tool memory v17 mem0-style (thu tu nhu createMemoryV17Mem0Tools tra ve). */
export const MEMORY_V17_MEM0_TOOL_NAMES = [
  'memory_v17_mem0_extract',
  'memory_v17_mem0_entity_link',
  'memory_v17_mem0_entity_list',
  'memory_v17_mem0_entity_merge',
  'memory_v17_mem0_conflict_list',
  'memory_v17_mem0_conflict_resolve',
  'memory_v17_mem0_search',
  'memory_v17_mem0_state_at',
  'memory_v17_mem0_fact_timeline',
  'memory_v17_mem0_scope_audit',
  'memory_v17_mem0_eval',
] as const;

/**
 * Placeholder (unbound) cua 11 tool memory v17 mem0-style — nam trong
 * ALL_TOOLS. Goi factory khong co store; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V17_MEM0_TOOLS: Tool[] = createMemoryV17Mem0Tools();
