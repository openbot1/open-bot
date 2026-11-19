/**
 * Memory v23 tools for @open-bot/tools (v1.38, Doi T1).
 *
 * Agent lam viec voi memory v23 bang tool call:
 *  - memory_v23_add          — them hoi thoai vao memory (extract + consolidate + embed, needsApproval: true)
 *  - memory_v23_extract      — trich ung vien tu text (dry-run, khong ghi, read)
 *  - memory_v23_search       — fusion search 3 tin hieu (semantic + BM25 + entity, read)
 *  - memory_v23_scope_search — multi-scope retrieval user/agent/run (read)
 *  - memory_v23_consolidate  — chay consolidation tren text (dryRun de xem truoc, needsApproval: true khi ghi)
 *  - memory_v23_sleep        — chay sleep-time consolidation v2 (needsApproval: true)
 *  - memory_v23_record       — CRUD record v23 (needsApproval: true)
 *  - memory_v23_skill        — ghi workflow attempt / duyet / cham diem / retire skill (needsApproval: true)
 *  - memory_v23_skill_search — tim procedural skill theo tu khoa (read)
 *  - memory_v23_stats        — thong ke store + skill + eval 30 case (read)
 *
 * SAFETY: ghi chi qua store/pipeline co validation; xoa chi la
 * soft-delete (status deleted, giu audit); sleep khong xoa cung
 * du lieu (deleted -> archived); khong goi model chat, khong goi
 * API ngoai — embedder mac dinh la Ollama local, fallback hash
 * co ghi ro provenance.
 *
 * Factory:
 *   createMemoryV23Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V23_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  V23Consolidator,
  V23LocalEmbedder,
  V23MemoryStore,
  V23Pipeline,
  V23ProceduralStore,
  checkV23Health,
  extractV23Candidates,
  runV23Eval,
  summarizeV23Health,
  type V23MemoryRecord,
  type V23RecordKind,
  type V23Scope,
} from '@open-bot/core';

export interface MemoryV23ToolOptions {
  store?: V23MemoryStore;
  pipeline?: V23Pipeline;
  skillStore?: V23ProceduralStore;
  embedder?: V23LocalEmbedder;
  /** Thu muc workspace: store + skill luu file JSON tai day khi khong truyen store san. */
  workspaceDir?: string;
  botId?: string;
  /** Scope mac dinh cho record moi (khi tool khong truyen scope). */
  scope?: Partial<V23Scope>;
}

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
    throw new Error(`Argument "${name}" phai la so, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" phai la boolean, got ${typeof value}`);
  }
  return value;
}

function getStringListArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`Argument "${name}" phai la danh sach chuoi`);
  }
  return [...(value as string[])];
}

const SCOPE_PROPS: Record<string, unknown> = {
  userId: { type: 'string', description: 'Scope user (tuy chon).' },
  agentId: { type: 'string', description: 'Scope agent/bot (tuy chon).' },
  runId: { type: 'string', description: 'Scope run (tuy chon).' },
  appId: { type: 'string', description: 'Scope app (tuy chon).' },
};

function scopeFromArgs(
  args: Record<string, unknown>,
  fallback: Partial<V23Scope>,
): Partial<V23Scope> {
  return {
    userId: getOptionalStringArg(args, 'userId') ?? fallback.userId ?? '',
    agentId: getOptionalStringArg(args, 'agentId') ?? fallback.agentId ?? '',
    runId: getOptionalStringArg(args, 'runId') ?? fallback.runId ?? '',
    appId: getOptionalStringArg(args, 'appId') ?? fallback.appId ?? '',
  };
}

function describeRecordV23(record: V23MemoryRecord): string {
  const scopeParts = [
    record.scope.runId ? `run=${record.scope.runId}` : '',
    record.scope.agentId ? `agent=${record.scope.agentId}` : '',
    record.scope.userId ? `user=${record.scope.userId}` : '',
    record.scope.appId ? `app=${record.scope.appId}` : '',
  ].filter(Boolean);
  const scope = scopeParts.length > 0 ? ` [${scopeParts.join(' ')}]` : ' [app-wide]';
  return `- ${record.id} (${record.kind}, v${record.version}, conf ${record.confidence}, ${record.status})${scope}: ${record.text}`;
}

export function createMemoryV23Tools(opts: MemoryV23ToolOptions = {}): Tool[] {
  const embedder = opts.embedder ?? new V23LocalEmbedder();
  const store = opts.store ??
    new V23MemoryStore({
      ...(opts.workspaceDir ? { filePath: V23MemoryStore.defaultFilePath(opts.workspaceDir) } : {}),
      embedder,
    });
  const pipeline = opts.pipeline ?? new V23Pipeline(store, embedder);
  const skillStore = opts.skillStore ??
    new V23ProceduralStore({
      ...(opts.workspaceDir ? { filePath: V23ProceduralStore.defaultFilePath(opts.workspaceDir) } : {}),
    });
  const defaultScope: Partial<V23Scope> = opts.scope ?? {};
  const defaultBotId = opts.botId;

  const scopeWithBot = (scope: Partial<V23Scope>): Partial<V23Scope> => {
    if (scope.agentId) return scope;
    if (defaultBotId) return { ...scope, agentId: defaultBotId };
    return scope;
  };

  const addTool: Tool = {
    definition: toolDef(
      'memory_v23_add',
      'Them hoi thoai (text) vao memory v23: extract ung vien, consolidate (add/update/supersede/merge), embed record moi. Ghi store — can duyet.',
      {
        text: { type: 'string', description: 'Noi dung hoi thoai / ghi chu can ghi nho.' },
        role: { type: 'string', description: '"user" | "agent" | "system" (mac dinh user).' },
        ...SCOPE_PROPS,
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const text = getStringArg(args, 'text');
        const roleRaw = getOptionalStringArg(args, 'role') ?? 'user';
        if (roleRaw !== 'user' && roleRaw !== 'agent' && roleRaw !== 'system') {
          return errorResult(`role "${roleRaw}" khong hop le (user | agent | system).`);
        }
        const scope = scopeWithBot(scopeFromArgs(args, defaultScope));
        const res = await pipeline.addConversation(
          [{ role: roleRaw as 'user' | 'agent' | 'system', text }],
          scope,
          'tool:memory_v23_add',
        );
        const r = res.report;
        const lines = [
          `Da xu ly ${res.extracted} ung vien: +${r.added} add, ${r.updated} update, ${r.superseded} supersede, ${r.merged} merge, ${r.noise} noise, ${r.dropped} drop.`,
          `Embed moi: ${res.embedded} ok, ${res.embedFailed} loi.`,
        ];
        if (res.addedIds.length > 0) lines.push(`Record moi: ${res.addedIds.join(', ')}`);
        for (const err of res.embedErrors.slice(0, 5)) lines.push(`  - Embed loi: ${err}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const extractTool: Tool = {
    definition: toolDef(
      'memory_v23_extract',
      'Trich ung vien memory tu text (Mem0-style extract, chay local, khong ghi store). Tra danh sach ung vien kem kind/confidence/entity.',
      {
        text: { type: 'string', description: 'Text can trich xuat.' },
        role: { type: 'string', description: '"user" | "agent" | "system" (mac dinh user).' },
      },
      ['text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const text = getStringArg(args, 'text');
        const roleRaw = getOptionalStringArg(args, 'role') ?? 'user';
        if (roleRaw !== 'user' && roleRaw !== 'agent' && roleRaw !== 'system') {
          return errorResult(`role "${roleRaw}" khong hop le (user | agent | system).`);
        }
        const candidates = extractV23Candidates([{ role: roleRaw as 'user' | 'agent' | 'system', text }]);
        if (candidates.length === 0) return 'Khong trich duoc ung vien nao (toan noise / cau qua ngan).';
        const lines = [`Trich duoc ${candidates.length} ung vien:`];
        for (const c of candidates) {
          const entities = c.entities.length > 0 ? ` [entity: ${c.entities.join(', ')}]` : '';
          lines.push(`- (${c.kind}, conf ${c.confidence}) ${c.text}${entities} — ${c.reason}`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const searchTool: Tool = {
    definition: toolDef(
      'memory_v23_search',
      'Tim memory v23 bang fusion 3 tin hieu (semantic + BM25 + entity). Tra hit kem diem tung tin hieu va giai thich.',
      {
        query: { type: 'string', description: 'Cau truy van.' },
        topK: { type: 'number', description: 'So hit toi da (mac dinh 10, toi da 50).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const topK = Math.min(50, Math.max(1, getNumberArg(args, 'topK') ?? 10));
        const hits = await pipeline.search(query, { topK });
        if (hits.length === 0) return `Khong tim thay memory nao cho "${query}".`;
        const lines = [`Tim thay ${hits.length} memory cho "${query}":`];
        for (const hit of hits) {
          lines.push(`- [${hit.score.toFixed(2)}] ${hit.record.text} (${hit.explanation})`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const scopeSearchTool: Tool = {
    definition: toolDef(
      'memory_v23_scope_search',
      'Tim memory v23 theo scope (user/agent/run): chi thay record thuoc scope hoac scope cha; record run rieng duoc uu tien. Query rong = record moi nhat theo scope.',
      {
        query: { type: 'string', description: 'Cau truy van (rong = recent).' },
        topK: { type: 'number', description: 'So hit toi da (mac dinh 10, toi da 50).' },
        ...SCOPE_PROPS,
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query', false);
        const topK = Math.min(50, Math.max(1, getNumberArg(args, 'topK') ?? 10));
        const scope = scopeWithBot(scopeFromArgs(args, defaultScope));
        const res = await pipeline.searchScoped(query, scope, { topK });
        if (res.hits.length === 0) return `Khong tim thay memory nao trong scope cho "${query}".`;
        const lines = [`Tim thay ${res.hits.length} memory (scope: user=${res.scope.userId || '-'} agent=${res.scope.agentId || '-'} run=${res.scope.runId || '-'}; embedding: ${res.embeddingKind}):`];
        for (const hit of res.hits) {
          const merged = hit.mergedSources.length > 0 ? ` (gop tu ${hit.mergedSources.length} record khac)` : '';
          lines.push(`- [${hit.score.toFixed(2)} · scope ${hit.scopeLevel}] ${hit.record.text}${merged}`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const consolidateTool: Tool = {
    definition: toolDef(
      'memory_v23_consolidate',
      'Chay consolidation Mem0-style tren text: extract roi quyet dinh add/update/supersede/merge/noise/drop tung ung vien. dryRun=true chi xem quyet dinh, khong ghi.',
      {
        text: { type: 'string', description: 'Text can consolidate.' },
        role: { type: 'string', description: '"user" | "agent" | "system" (mac dinh user).' },
        dryRun: { type: 'boolean', description: 'Chi xem truoc quyet dinh (mac dinh false).' },
        ...SCOPE_PROPS,
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const text = getStringArg(args, 'text');
        const roleRaw = getOptionalStringArg(args, 'role') ?? 'user';
        if (roleRaw !== 'user' && roleRaw !== 'agent' && roleRaw !== 'system') {
          return errorResult(`role "${roleRaw}" khong hop le (user | agent | system).`);
        }
        const dryRun = getBoolArg(args, 'dryRun', false);
        const scope = scopeWithBot(scopeFromArgs(args, defaultScope));
        const candidates = extractV23Candidates([{ role: roleRaw as 'user' | 'agent' | 'system', text }]);
        if (candidates.length === 0) return 'Khong co ung vien de consolidate.';
        if (dryRun) {
          const consolidator = new V23Consolidator();
          const preview = consolidator.preview(candidates, store);
          const lines = [`Preview ${candidates.length} ung vien (khong ghi):`];
          for (const d of preview) {
            lines.push(`- ${d.decision}: ${d.candidate.text} — ${d.reason}`);
          }
          return lines.join('\n');
        }
        const report = pipeline.consolidateWithScope(candidates, scope, 'tool:memory_v23_consolidate');
        const lines = [
          `Consolidate ${report.candidates} ung vien: +${report.added} add, ${report.updated} update, ${report.superseded} supersede, ${report.merged} merge, ${report.noise} noise, ${report.dropped} drop (${report.durationMs}ms).`,
        ];
        for (const d of report.decisions) {
          lines.push(`- ${d.decision}: ${d.candidate.text} — ${d.reason}`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const sleepTool: Tool = {
    definition: toolDef(
      'memory_v23_sleep',
      'Chay sleep-time consolidation v2 luc idle: decay confidence, merge trung lap, promote record hay duoc dung, danh dau stale, prune record cu. Co ngan sach ops/time — can duyet.',
      {
        maxOps: { type: 'number', description: 'So thao tac toi da moi pass (mac dinh 200).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const maxOps = getNumberArg(args, 'maxOps');
        const pipe = maxOps !== undefined
          ? new V23Pipeline(store, embedder, { sleep: { maxOps } })
          : pipeline;
        const report = pipe.runSleep();
        const lines = [
          `Sleep v2: quet ${report.scanned} record — decay ${report.decayed}, prune ${report.pruned}, merge ${report.merged}, promote ${report.promoted}, stale ${report.markedStale} (${report.durationMs}ms${report.budgetHit ? ', het ngan sach — pass sau lam tiep' : ''}).`,
        ];
        for (const action of report.actions.slice(0, 20)) lines.push(`- ${action}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const recordTool: Tool = {
    definition: toolDef(
      'memory_v23_record',
      'CRUD record memory v23: get/list/put/update/delete (soft-delete, giu audit)/restore. Ghi — can duyet.',
      {
        action: { type: 'string', description: '"get" | "list" | "put" | "update" | "delete" | "restore".' },
        id: { type: 'string', description: 'Id record (get/update/delete/restore).' },
        text: { type: 'string', description: 'Text record (put/update).' },
        kind: { type: 'string', description: 'Kind: fact | preference | decision | procedure | person | project | note.' },
        confidence: { type: 'number', description: 'Do tin cay 0..1 (put/update).' },
        tags: { type: 'array', description: 'Tags (put/update).', items: { type: 'string' } },
        ...SCOPE_PROPS,
        limit: { type: 'number', description: 'So record toi da khi list (mac dinh 20).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'get') {
          const id = getStringArg(args, 'id');
          const record = store.get(id);
          if (!record) return errorResult(`Khong co record "${id}".`);
          return describeRecordV23(record);
        }
        if (action === 'list') {
          const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
          const kindRaw = getOptionalStringArg(args, 'kind');
          const records = store.list({
            ...(kindRaw ? { kind: kindRaw as V23RecordKind } : {}),
            limit,
          });
          if (records.length === 0) return 'Store v23 dang rong.';
          return [`${records.length} record (moi nhat truoc):`, ...records.map(describeRecordV23)].join('\n');
        }
        if (action === 'put') {
          const text = getStringArg(args, 'text');
          const kindRaw = getOptionalStringArg(args, 'kind') ?? 'fact';
          const confidence = getNumberArg(args, 'confidence');
          const tags = getStringListArg(args, 'tags');
          const scope = scopeWithBot(scopeFromArgs(args, defaultScope));
          const res = store.put({
            kind: kindRaw as V23RecordKind,
            text,
            scope,
            ...(tags ? { tags } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
            source: 'tool:memory_v23_record',
          });
          if (!res.ok || !res.record) return errorResult(res.error ?? 'put that bai.');
          return `Da them record ${res.record.id} (${res.record.kind}, conf ${res.record.confidence}).`;
        }
        if (action === 'update') {
          const id = getStringArg(args, 'id');
          const text = getOptionalStringArg(args, 'text');
          const kindRaw = getOptionalStringArg(args, 'kind');
          const confidence = getNumberArg(args, 'confidence');
          const tags = getStringListArg(args, 'tags');
          const res = store.update(id, {
            ...(text !== undefined ? { text } : {}),
            ...(kindRaw !== undefined ? { kind: kindRaw as V23RecordKind } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
            ...(tags !== undefined ? { tags } : {}),
          });
          if (!res.ok || !res.record) return errorResult(res.error ?? 'update that bai.');
          return `Da cap nhat record ${res.record.id} len v${res.record.version}.`;
        }
        if (action === 'delete') {
          const id = getStringArg(args, 'id');
          const res = store.delete(id);
          if (!res.ok) return errorResult(res.error ?? 'delete that bai.');
          return `Da soft-delete record ${id} (status deleted, giu audit; sleep se archive sau).`;
        }
        if (action === 'restore') {
          const id = getStringArg(args, 'id');
          const res = store.restore(id);
          if (!res.ok) return errorResult(res.error ?? 'restore that bai.');
          return `Da khoi phuc record ${id} ve active.`;
        }
        return errorResult(`action "${action}" khong hop le (get | list | put | update | delete | restore).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const skillTool: Tool = {
    definition: toolDef(
      'memory_v23_skill',
      'Procedural memory: ghi workflow attempt (record), duyet skill (approve), cham diem (rate), dat trigger, retire, xem review deprecate. Ghi — can duyet.',
      {
        action: { type: 'string', description: '"record" | "approve" | "rate" | "list" | "retire" | "set-trigger" | "review".' },
        workflow: { type: 'string', description: 'Ten workflow (record/approve/rate/retire/set-trigger).' },
        steps: { type: 'array', description: 'Cac buoc workflow (record).', items: { type: 'string' } },
        toolsUsed: { type: 'array', description: 'Tool da dung (record).', items: { type: 'string' } },
        outcome: { type: 'string', description: '"success" | "failure" (record).' },
        durationMs: { type: 'number', description: 'Thoi gian chay ms (record).' },
        note: { type: 'string', description: 'Ghi chu / loi (record).' },
        rating: { type: 'number', description: 'Diem 1..5 (rate).' },
        trigger: { type: 'string', description: 'Mo ta khi nao dung skill (set-trigger).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const skills = skillStore.listSkills({ limit: 20 });
          if (skills.length === 0) return 'Chua co procedural skill nao.';
          const lines = [`${skills.length} skill:`];
          for (const s of skills) {
            lines.push(`- ${s.id} (v${s.version}, ${s.status}, success ${s.successCount}/${s.totalCount} = ${s.successRate}, rating ${s.rating} x${s.ratingCount}): ${s.trigger}`);
          }
          return lines.join('\n');
        }
        if (action === 'review') {
          const deprecated = skillStore.reviewDeprecations();
          return deprecated.length === 0
            ? 'Khong co skill nao can deprecate.'
            : `Da deprecate ${deprecated.length} skill: ${deprecated.join(', ')}`;
        }
        const workflow = getStringArg(args, 'workflow');
        if (action === 'record') {
          const steps = getStringListArg(args, 'steps');
          if (!steps || steps.length === 0) return errorResult('Can "steps" (it nhat 1 buoc).');
          const outcome = getOptionalStringArg(args, 'outcome') ?? 'success';
          if (outcome !== 'success' && outcome !== 'failure') {
            return errorResult(`outcome "${outcome}" khong hop le (success | failure).`);
          }
          const toolsUsed = getStringListArg(args, 'toolsUsed') ?? [];
          const durationMs = getNumberArg(args, 'durationMs') ?? 0;
          const note = getOptionalStringArg(args, 'note');
          const res = skillStore.recordAttempt({
            workflow,
            steps,
            toolsUsed,
            outcome: outcome as 'success' | 'failure',
            durationMs,
            ...(note ? { note } : {}),
            ranAt: Date.now(),
          });
          if (!res.ok) return errorResult(res.error ?? 'record attempt that bai.');
          if (!res.skill) return `Da ghi attempt failure cho "${workflow}" (chua du success de tao skill).`;
          return `Da ghi attempt ${outcome} cho "${workflow}": skill ${res.skill.id} v${res.skill.version} (${res.skill.status}, success ${res.skill.successCount}/${res.skill.totalCount}).`;
        }
        if (action === 'approve') {
          const res = skillStore.approve(workflow);
          if (!res.ok || !res.skill) return errorResult(res.error ?? 'approve that bai.');
          return `Da duyet skill ${res.skill.id} -> active.`;
        }
        if (action === 'rate') {
          const stars = getNumberArg(args, 'rating');
          if (stars === undefined) return errorResult('Can "rating" (1..5).');
          const res = skillStore.rate(workflow, stars);
          if (!res.ok || !res.skill) return errorResult(res.error ?? 'rate that bai.');
          return `Da cham ${stars} sao cho ${res.skill.id}: rating hien tai ${res.skill.rating} (x${res.skill.ratingCount}).`;
        }
        if (action === 'set-trigger') {
          const trigger = getStringArg(args, 'trigger');
          const res = skillStore.setTrigger(workflow, trigger);
          if (!res.ok || !res.skill) return errorResult(res.error ?? 'set-trigger that bai.');
          return `Da dat trigger cho ${res.skill.id}: ${res.skill.trigger}`;
        }
        if (action === 'retire') {
          const res = skillStore.retire(workflow);
          if (!res.ok || !res.skill) return errorResult(res.error ?? 'retire that bai.');
          return `Da retire skill ${res.skill.id}.`;
        }
        return errorResult(`action "${action}" khong hop le (record | approve | rate | list | retire | set-trigger | review).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const skillSearchTool: Tool = {
    definition: toolDef(
      'memory_v23_skill_search',
      'Tim procedural skill theo tu khoa (workflow/trigger/steps). Chi tra skill active/candidate.',
      {
        query: { type: 'string', description: 'Tu khoa mo ta viec can lam.' },
        limit: { type: 'number', description: 'So skill toi da (mac dinh 5).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const limit = Math.min(20, Math.max(1, getNumberArg(args, 'limit') ?? 5));
        const found = skillStore.searchSkills(query, limit);
        if (found.length === 0) return `Khong co skill nao phu hop voi "${query}".`;
        const lines = [`Tim thay ${found.length} skill cho "${query}":`];
        for (const { skill, score } of found) {
          lines.push(`- [${score.toFixed(2)}] ${skill.workflow} (v${skill.version}, ${skill.status}, success ${skill.successRate}): ${skill.steps.join(' -> ')}`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const statsTool: Tool = {
    definition: toolDef(
      'memory_v23_stats',
      'Thong ke memory v23: so record theo kind/scope/status, embedding, skill, va eval 30 case (khi includeEval=true).',
      {
        includeEval: { type: 'boolean', description: 'Chay eval 30 case offline (mac dinh false).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const includeEval = getBoolArg(args, 'includeEval', false);
        const stats = store.stats();
        const skills = skillStore.listSkills({});
        const health = checkV23Health(store, skillStore);
        const lines = [
          'Memory v23:',
          `- Record: ${stats.total} tong, ${stats.active} active, ${stats.withEmbedding} co embedding, confidence TB ${stats.avgConfidence}.`,
          `- Health: ${summarizeV23Health(health)}`,
        ];
        for (const issue of health.issues.slice(0, 10)) {
          lines.push(`  - [${issue.severity}] ${issue.code}: ${issue.detail} (${issue.suggestion})`);
        }
        lines.push(
          `- Theo kind: ${Object.entries(stats.byKind).map(([k, v]) => `${k}=${v}`).join(', ') || '(rong)'}`,
          `- Theo scope: ${Object.entries(stats.byScopeLevel).map(([k, v]) => `${k}=${v}`).join(', ') || '(rong)'}`,
          `- Theo status: ${Object.entries(stats.byStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '(rong)'}`,
          `- Skill: ${skills.length} (${skills.filter((s) => s.status === 'active').length} active, ${skills.filter((s) => s.status === 'candidate').length} candidate, ${skills.filter((s) => s.status === 'deprecated').length} deprecated).`,
          `- Embedder lan cuoi: ${embedder.lastKind} (Ollama kha dung lan cuoi: ${embedder.lastOllamaAvailable ?? 'chua kiem tra'}).`,
        );
        if (includeEval) {
          const summary = await runV23Eval();
          lines.push(`- Eval: ${summary.passed}/${summary.total} pass, ${summary.failed} fail.`);
          for (const r of summary.results.filter((x) => !x.passed)) {
            lines.push(`  - FAIL ${r.caseId}: ${r.detail}`);
          }
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    addTool,
    extractTool,
    searchTool,
    scopeSearchTool,
    consolidateTool,
    sleepTool,
    recordTool,
    skillTool,
    skillSearchTool,
    statsTool,
  ];
}

/** Ten tool memory v23 (thu tu nhu createMemoryV23Tools tra ve). */
export const MEMORY_V23_TOOL_NAMES = [
  'memory_v23_add',
  'memory_v23_extract',
  'memory_v23_search',
  'memory_v23_scope_search',
  'memory_v23_consolidate',
  'memory_v23_sleep',
  'memory_v23_record',
  'memory_v23_skill',
  'memory_v23_skill_search',
  'memory_v23_stats',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v23 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V23_TOOLS: Tool[] = createMemoryV23Tools();
