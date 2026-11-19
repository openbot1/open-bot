/**
 * Memory v27 tools for @open-bot/tools (v1.42, Doi T3).
 *
 * Agent lam viec voi memory v27 bang tool call:
 *  - memory_v27_ingest      — ingest episode: single-pass extract + link entity luc ghi + add fact add-only (ghi needsApproval: true)
 *  - memory_v27_extract     — trich xuat kho (dry-run): xem truoc candidate/trung/supersede, khong ghi (read)
 *  - memory_v27_fact        — them/xem/lich su/liet ke fact bi-temporal (them needsApproval: true)
 *  - memory_v27_search      — hybrid search: BM25 + lexical-embedding proxy + entity boost + graph traversal + recency, co asOf time-travel (read)
 *  - memory_v27_time_travel — fact dung tai X + gia tri block tai X (read)
 *  - memory_v27_entity      — dang ky/link/liet ke/gop entity + trong so boosting (ghi needsApproval: true)
 *  - memory_v27_episode     — tao/xem/liet ke episode + provenance fact -> episode goc (tao needsApproval: true)
 *  - memory_v27_graph       — ke 1/2 hop, duong noi 2 subject, kiem tra nhat quan graph (read)
 *  - memory_v27_block       — shared block bi-temporal: dang ky/cap nhat dong bo/gan fact/value-at/timeline/sync-log (ghi needsApproval: true)
 *  - memory_v27_stats       — thong ke + health + panel view + export/import snapshot (read; import needsApproval: true)
 *
 * SAFETY: add-only — KHONG co tool sua/xoa fact, episode hay
 * entity; fact moi mau thuan chi ADD edge moi + DONG edge cu
 * (supersede), lich su con nguyen. "Embedding" trong search la
 * lexical proxy xac dinh (token-overlap), khong phai vector
 * model — ghi ro trong ket qua. Khong goi model chat, khong
 * goi API ngoai.
 *
 * Factory:
 *   createMemoryV27Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V27_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  buildV27PanelView,
  makeV25Scope,
  V27Pipeline,
  V27Store,
  type V25Scope,
  type V27EntityKind,
} from '@open-bot/core';

export interface MemoryV27ToolOptions {
  store?: V27Store;
  pipeline?: V27Pipeline;
  /** Thu muc workspace: store JSON luu tai day khi khong truyen store san. */
  workspaceDir?: string;
  botId?: string;
  /** Scope mac dinh cho record moi (khi tool khong truyen scope). */
  scope?: Partial<V25Scope>;
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
  fallback: Partial<V25Scope>,
): Partial<V25Scope> {
  return {
    userId: getOptionalStringArg(args, 'userId') ?? fallback.userId ?? '',
    agentId: getOptionalStringArg(args, 'agentId') ?? fallback.agentId ?? '',
    runId: getOptionalStringArg(args, 'runId') ?? fallback.runId ?? '',
    appId: getOptionalStringArg(args, 'appId') ?? fallback.appId ?? '',
  };
}

export function createMemoryV27Tools(opts: MemoryV27ToolOptions = {}): Tool[] {
  const loadedStore = opts.workspaceDir ? V27Store.loadFromDir(opts.workspaceDir) : null;
  const store = opts.store ??
    (loadedStore && loadedStore.ok ? loadedStore.value : new V27Store());
  const pipeline = opts.pipeline ?? new V27Pipeline(store);
  const defaultScope: Partial<V25Scope> = opts.scope ?? {};
  const defaultBotId = opts.botId;

  const persist = (): void => {
    if (opts.workspaceDir) store.saveToDir(opts.workspaceDir);
  };

  const callerBot = (args: Record<string, unknown>): string =>
    getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '';

  const scopeOf = (args: Record<string, unknown>): V25Scope =>
    makeV25Scope(scopeFromArgs(args, defaultScope));

  // -- ingest -----------------------------------------------------------------

  const ingestTool: Tool = {
    definition: toolDef(
      'memory_v27_ingest',
      'Ingest episode v27: ghi doan text goc lam episode, single-pass extract fact (add-only, 1 lan quet), link entity LUC GHI, them fact vao graph bi-temporal (fact moi mau thuan thi ADD moi + DONG edge cu, khong sua/xoa). Co the sync fact moi vao shared block (syncBlockLabel). Ghi du lieu — can approval.',
      {
        text: { type: 'string', description: 'Doan text goc lam episode (chat/turn/voice transcript...).' },
        source: { type: 'string', description: 'Nguon episode: chat | tool | sleep | import | system | voice (mac dinh chat).' },
        agentId: { type: 'string', description: 'Agent ghi episode (mac dinh bot goi tool).' },
        at: { type: 'string', description: 'Thoi diem episode xay ra (ISO, mac dinh luc goi).' },
        syncBlockLabel: { type: 'string', description: 'Label shared block se nhan fact moi (tuy chon, block phai dang ky lop bi-temporal).' },
        botId: { type: 'string', description: 'Bot goi tool (mac dinh bot cau hinh).' },
        ...SCOPE_PROPS,
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const scope = scopeOf(args);
        const res = pipeline.ingestEpisode(
          {
            text: getStringArg(args, 'text'),
            source: (getOptionalStringArg(args, 'source') ?? 'chat') as 'chat' | 'tool' | 'sleep' | 'import' | 'system' | 'voice',
            agentId: getOptionalStringArg(args, 'agentId') ?? callerBot(args),
            userId: getOptionalStringArg(args, 'userId') ?? '',
            ...(getOptionalStringArg(args, 'at') ? { at: getOptionalStringArg(args, 'at') } : {}),
            scope,
          },
          {
            by: callerBot(args) || 'system',
            ...(getOptionalStringArg(args, 'syncBlockLabel')
              ? { syncBlockLabel: getOptionalStringArg(args, 'syncBlockLabel') }
              : {}),
            scope,
          },
        );
        if (!res.ok) return errorResult(res.error);
        const r = res.value;
        const lines = [
          `Da ingest episode ${r.episode.id} (${r.episode.source}, ${r.extraction.sentencesScanned} cau quet 1 pass): ${r.factsAdded} fact moi, ${r.edgesClosed} edge cu bi dong (supersede), ${r.extraction.duplicates} duplicate bo qua.`,
        ];
        for (const added of r.addedFacts) {
          const e = added.edge;
          lines.push(
            `- ${added.added ? 'ADD' : 'TRUNG'} ${e.id}: ${e.subject} ${e.predicate} ${e.object}` +
            (added.closed.length > 0 ? ` (dong ${added.closed.length} edge cu: ${added.closed.map((c) => c.id).join(', ')})` : '') +
            (added.duplicateOf ? ` (trung ${added.duplicateOf})` : ''),
          );
        }
        if (r.extraction.entityLinks.length > 0) {
          lines.push(`Entity link luc ghi: ${r.extraction.entityLinks.map((l) => `${l.mention} -> ${l.entityName} (${l.match}${l.created ? ', moi' : ''})`).join('; ')}.`);
        }
        if (r.syncedBlocks.length > 0) {
          lines.push(`Da sync fact moi vao block: ${r.syncedBlocks.join(', ')}.`);
        }
        persist();
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- extract (dry-run) ------------------------------------------------------

  const extractTool: Tool = {
    definition: toolDef(
      'memory_v27_extract',
      'Trich xuat kho v27 (dry-run, khong ghi): chay single-pass extraction tren text, tra candidate fact + fact nao trung edge active + fact nao se supersede edge cu + mention entity. Dung de xem truoc truoc khi ingest.',
      {
        text: { type: 'string', description: 'Text can trich xuat thu.' },
        ...SCOPE_PROPS,
      },
      ['text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const res = pipeline.extractDryRun(getStringArg(args, 'text'), {
          scope: scopeFromArgs(args, defaultScope),
        });
        if (!res.ok) return errorResult(res.error);
        const r = res.value;
        const lines = [
          `Dry-run: ${r.sentencesScanned} cau, ${r.candidates.length} candidate, ${r.duplicates} trung, ${r.supersedes} supersede, ${r.sentencesWithNoFact} cau khong co fact (${r.elapsedMs}ms).`,
        ];
        for (const c of r.candidates) {
          lines.push(
            `- ${c.subject} ${c.predicate} ${c.object} [${c.pattern}, tin cay ${c.confidence}]` +
            (c.supersedesId ? ` — se dong edge cu ${c.supersedesId}` : ''),
          );
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- fact -------------------------------------------------------------------

  const factTool: Tool = {
    definition: toolDef(
      'memory_v27_fact',
      'Fact bi-temporal v27: them fact moi (add-only: trung thi bo qua, mau thuan thi ADD moi + DONG edge cu), xem 1 fact, xem lich su thay doi cua 1 cap subject+predicate, liet ke fact. Them fact ghi du lieu — can approval.',
      {
        action: { type: 'string', description: '"add" | "get" | "history" | "list".' },
        subject: { type: 'string', description: 'Subject (add/history/list).' },
        predicate: { type: 'string', description: 'Predicate (add/history/list).' },
        object: { type: 'string', description: 'Object (add).' },
        id: { type: 'string', description: 'Id fact (get).' },
        episodeId: { type: 'string', description: 'Id episode nguon (add, tuy chon).' },
        validAt: { type: 'string', description: 'Valid time bat dau (ISO, tuy chon).' },
        status: { type: 'string', description: 'Loc status: active | superseded | expired (list).' },
        currentOnly: { type: 'boolean', description: 'Chi fact con hieu luc (list, mac dinh false).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = scopeOf(args);
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'add') {
          const res = store.graph.addFact(
            {
              subject: getStringArg(args, 'subject'),
              predicate: getStringArg(args, 'predicate'),
              object: getStringArg(args, 'object'),
              confidence: 0.8,
              sourceSentence: `${getStringArg(args, 'subject')} ${getStringArg(args, 'predicate')} ${getStringArg(args, 'object')}`,
              entityIds: [],
              pattern: 'tool-add',
              supersedesId: '',
              supersedeReason: '',
            },
            {
              episodeId: getOptionalStringArg(args, 'episodeId'),
              scope,
              ...(getOptionalStringArg(args, 'validAt') ? { validAt: getOptionalStringArg(args, 'validAt') } : {}),
              by: callerBot(args) || 'system',
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          const r = res.value;
          if (!r.added) return `Fact da ton tai (trung edge ${r.duplicateOf}) — khong them lai (add-only).`;
          return `Da ADD fact ${r.edge.id}: ${r.edge.subject} ${r.edge.predicate} ${r.edge.object}` +
            (r.closed.length > 0 ? ` — da dong ${r.closed.length} edge cu: ${r.closed.map((c) => `${c.id} (${c.subject} ${c.predicate} ${c.object})`).join('; ')}.` : '.');
        }
        if (action === 'get') {
          const fact = store.graph.get(getStringArg(args, 'id'));
          if (!fact) return errorResult(`Khong co fact "${getStringArg(args, 'id')}".`);
          return [
            `Fact ${fact.id} [${fact.status}]: ${fact.subject} ${fact.predicate} ${fact.object}`,
            `Valid: ${fact.validAt ?? '(khong ro)'} -> ${fact.invalidAt ?? '(van dung)'}; biet tu ${fact.createdAt}${fact.expiredAt ? `, het luu ${fact.expiredAt}` : ''}.`,
            `Episode: ${fact.episodeId || '(khong co)'}; chung cu: "${fact.sourceText}"; tin cay ${fact.confidence}.`,
          ].join('\n');
        }
        if (action === 'history') {
          const res = pipeline.factHistory(
            getStringArg(args, 'subject'),
            getStringArg(args, 'predicate'),
            scope,
          );
          if (!res.ok) return errorResult(res.error);
          if (res.value.length === 0) return 'Chua co fact nao cho cap subject+predicate nay.';
          return [
            `Lich su ${res.value.length} fact (cu nhat truoc):`,
            ...res.value.map((f) => `- ${f.id} [${f.status}] ${f.subject} ${f.predicate} ${f.object} — valid ${f.validAt ?? '?'} -> ${f.invalidAt ?? 'nay'}, biet tu ${f.createdAt}`),
          ].join('\n');
        }
        if (action === 'list') {
          const facts = store.graph.list({
            scope,
            ...(getOptionalStringArg(args, 'subject') ? { subject: getOptionalStringArg(args, 'subject') } : {}),
            ...(getOptionalStringArg(args, 'predicate') ? { predicate: getOptionalStringArg(args, 'predicate') } : {}),
            ...(getOptionalStringArg(args, 'status')
              ? { status: getOptionalStringArg(args, 'status') as 'active' | 'superseded' | 'expired' }
              : {}),
            currentOnly: getBoolArg(args, 'currentOnly', false),
            limit,
          });
          if (facts.length === 0) return 'Khong co fact nao theo bo loc.';
          return [
            `${facts.length} fact:`,
            ...facts.map((f) => `- ${f.id} [${f.status}] ${f.subject} ${f.predicate} ${f.object} (biet tu ${f.createdAt})`),
          ].join('\n');
        }
        return errorResult(`action "${action}" khong hop le (add | get | history | list).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- search -----------------------------------------------------------------

  const searchTool: Tool = {
    definition: toolDef(
      'memory_v27_search',
      'Hybrid search v27: BM25 + lexical-embedding proxy (token-overlap, KHONG phai vector model) + entity boosting + graph traversal + recency. asOf loc time-travel (fact dung tai X). Tra diem thanh phan tung hit. Read.',
      {
        query: { type: 'string', description: 'Cau truy van.' },
        asOf: { type: 'string', description: 'Chi fact dung tai thoi diem X (ISO, time-travel, tuy chon).' },
        currentOnly: { type: 'boolean', description: 'Chi fact con hieu luc (mac dinh false).' },
        useEntityBoost: { type: 'boolean', description: 'Bat entity boosting (mac dinh true).' },
        useTraversal: { type: 'boolean', description: 'Bat graph traversal mo rong (mac dinh true).' },
        limit: { type: 'number', description: 'So ket qua toi da (mac dinh 10, toi da 100).' },
        ...SCOPE_PROPS,
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const res = pipeline.search({
          query: getStringArg(args, 'query'),
          ...(getOptionalStringArg(args, 'asOf') ? { asOf: getOptionalStringArg(args, 'asOf') } : {}),
          currentOnly: getBoolArg(args, 'currentOnly', false),
          useEntityBoost: getBoolArg(args, 'useEntityBoost', true),
          useTraversal: getBoolArg(args, 'useTraversal', true),
          limit: getNumberArg(args, 'limit') ?? 10,
          scope: scopeFromArgs(args, defaultScope),
        });
        if (!res.ok) return errorResult(res.error);
        const r = res.value;
        if (r.hits.length === 0) return `Khong tim thay fact nao cho "${r.query}" (da xet ${r.considered} fact${r.timeTravel ? ', time-travel' : ''}).`;
        const lines = [
          `Tim thay ${r.hits.length} fact cho "${r.query}" (da xet ${r.considered} fact, ${r.elapsedMs}ms${r.timeTravel ? ', time-travel' : ''}${r.queryEntities.length > 0 ? `, entity trong query: ${r.queryEntities.map((e) => e.entityName).join(', ')}` : ''}):`,
        ];
        for (const hit of r.hits) {
          const s = hit.score;
          lines.push(
            `- [${s.total}] ${hit.fact.subject} ${hit.fact.predicate} ${hit.fact.object} (bm25 ${s.bm25}, emb-proxy ${s.embeddingProxy}, entity ${s.entityBoost}, graph ${s.graphBonus}, recency ${s.recency}) — ${hit.reason}${hit.viaTraversal ? ' [traversal]' : ''}`,
          );
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- time travel ------------------------------------------------------------

  const timeTravelTool: Tool = {
    definition: toolDef(
      'memory_v27_time_travel',
      'Time-travel v27: fact nao dung tai thoi diem X (loc CA valid time VA transaction time — chat hon query thuong) + gia tri shared block tai X (timeline bi-temporal). Read.',
      {
        at: { type: 'string', description: 'Thoi diem X (ISO).' },
        blockLabels: { type: 'array', items: { type: 'string' }, description: 'Label block can lay gia tri tai X (mac dinh tat ca block).' },
        ...SCOPE_PROPS,
      },
      ['at'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const res = pipeline.timeTravel(getStringArg(args, 'at'), {
          ...(getStringListArg(args, 'blockLabels') ? { blockLabels: getStringListArg(args, 'blockLabels') } : {}),
          scope: scopeFromArgs(args, defaultScope),
        });
        if (!res.ok) return errorResult(res.error);
        const r = res.value;
        const lines = [
          `Tai ${r.at}: ${r.factsAtTime} fact dung.`,
        ];
        for (const fact of r.facts.slice(0, 20)) {
          lines.push(`- ${fact.subject} ${fact.predicate} ${fact.object} [${fact.status}]`);
        }
        if (r.facts.length > 20) lines.push(`... va ${r.facts.length - 20} fact nua.`);
        const labels = Object.keys(r.blockValues);
        if (labels.length > 0) {
          lines.push('Gia tri block tai X:');
          for (const label of labels) {
            lines.push(`- ${label}: ${r.blockValues[label] ? JSON.stringify(r.blockValues[label]?.slice(0, 200)) : '(chua co)'}`);
          }
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- entity -----------------------------------------------------------------

  const entityTool: Tool = {
    definition: toolDef(
      'memory_v27_entity',
      'Entity v27: dang ky entity moi, link mention ve entity chuan (luc ghi), liet ke entity theo kind, gop 2 entity (alias chuyen sang, entity cu danh dau merged, khong xoa), xem trong so boosting. Dang ky/gop ghi du lieu — can approval.',
      {
        action: { type: 'string', description: '"register" | "link" | "list" | "get" | "merge" | "boost".' },
        name: { type: 'string', description: 'Ten entity (register/link).' },
        mention: { type: 'string', description: 'Mention can link (link, mac dinh lay name).' },
        kind: { type: 'string', description: 'Loai entity: person | place | org | project | tool | topic | unknown.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Ten phu (register).' },
        id: { type: 'string', description: 'Id entity (get/boost/merge-from).' },
        intoId: { type: 'string', description: 'Id entity dich (merge).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = scopeOf(args);
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'register') {
          const res = store.entities.register(
            {
              name: getStringArg(args, 'name'),
              ...(getOptionalStringArg(args, 'kind')
                ? { kind: getOptionalStringArg(args, 'kind') as V27EntityKind }
                : {}),
              aliases: getStringListArg(args, 'aliases') ?? [],
              scope,
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da dang ky entity "${res.value.name}" [${res.value.kind}] (${res.value.id}).`;
        }
        if (action === 'link') {
          const mention = getOptionalStringArg(args, 'mention') ?? getStringArg(args, 'name');
          const link = store.entities.linkMention(mention, { scope });
          if (link.match === 'none') return `Khong link duoc mention "${mention}" (tu dung chung hoac rong).`;
          persist();
          return `Link "${link.mention}" -> "${link.entityName}" (${link.entityId}, ${link.match}, tin cay ${link.confidence}${link.created ? ', entity moi' : ''}).`;
        }
        if (action === 'list') {
          const list = store.entities.list({
            ...(getOptionalStringArg(args, 'kind')
              ? { kind: getOptionalStringArg(args, 'kind') as V27EntityKind }
              : {}),
            scope,
            limit,
          });
          if (list.length === 0) return 'Chua co entity nao theo bo loc.';
          return [
            `${list.length} entity:`,
            ...list.map((e) => `- ${e.id} "${e.name}" [${e.kind}] — ${e.mentionCount} mention, ${e.activeFactCount} fact active${e.aliases.length > 0 ? `, alias: ${e.aliases.join(', ')}` : ''}${e.mergedIntoId ? ` (da gop vao ${e.mergedIntoId})` : ''}`),
          ].join('\n');
        }
        if (action === 'get') {
          const entity = store.entities.get(getStringArg(args, 'id'));
          if (!entity) return errorResult(`Khong co entity "${getStringArg(args, 'id')}".`);
          const boost = store.entities.boostFor(entity);
          return [
            `Entity "${entity.name}" [${entity.kind}] (${entity.id}): ${entity.mentionCount} mention, ${entity.activeFactCount} fact active, tao ${entity.createdAt}, mention gan nhat ${entity.lastMentionedAt}.`,
            `Alias: ${entity.aliases.join(', ') || '(khong co)'}${entity.mergedIntoId ? `. Da gop vao ${entity.mergedIntoId}.` : ''}`,
            `Trong so boosting hien tai: ${boost.weight}.`,
          ].join('\n');
        }
        if (action === 'merge') {
          const res = store.entities.merge(getStringArg(args, 'id'), getStringArg(args, 'intoId'));
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da gop entity vao "${res.value.name}" (${res.value.id}) — alias + mention da chuyen sang, entity cu chi danh dau merged (khong xoa).`;
        }
        if (action === 'boost') {
          const entity = store.entities.get(getStringArg(args, 'id'));
          if (!entity) return errorResult(`Khong co entity "${getStringArg(args, 'id')}".`);
          const boost = store.entities.boostFor(entity);
          return `Boosting "${entity.name}": trong so ${boost.weight} (mention ${boost.mentionCount}, lan cuoi ${boost.lastMentionedAt}).`;
        }
        return errorResult(`action "${action}" khong hop le (register | link | list | get | merge | boost).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- episode ----------------------------------------------------------------

  const episodeTool: Tool = {
    definition: toolDef(
      'memory_v27_episode',
      'Episode v27: tao episode moi (bang chung goc, khong sua/xoa), xem 1 episode, liet ke episode theo ngay/nguon/noi dung, xem provenance cua 1 fact (fact -> episode goc + fact anh em). Tao episode ghi du lieu — can approval.',
      {
        action: { type: 'string', description: '"create" | "get" | "list" | "provenance" | "search".' },
        text: { type: 'string', description: 'Text episode (create).' },
        id: { type: 'string', description: 'Id episode (get) hoac id fact (provenance).' },
        source: { type: 'string', description: 'Nguon episode: chat | tool | sleep | import | system | voice (create/list).' },
        agentId: { type: 'string', description: 'Agent ghi episode (create/list).' },
        day: { type: 'string', description: 'Ngay YYYY-MM-DD (list).' },
        textContains: { type: 'string', description: 'Tim theo noi dung (list).' },
        query: { type: 'string', description: 'Query search episode (search).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = scopeOf(args);
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'create') {
          const res = store.episodes.create(
            {
              text: getStringArg(args, 'text'),
              source: (getOptionalStringArg(args, 'source') ?? 'chat') as 'chat' | 'tool' | 'sleep' | 'import' | 'system' | 'voice',
              agentId: getOptionalStringArg(args, 'agentId') ?? callerBot(args),
              scope,
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da tao episode ${res.value.id} (${res.value.source}, ${res.value.at}). Dung memory_v27_ingest de trich fact tu episode, hoac episode nay chi luu bang chung goc.`;
        }
        if (action === 'get') {
          const episode = store.episodes.get(getStringArg(args, 'id'));
          if (!episode) return errorResult(`Khong co episode "${getStringArg(args, 'id')}".`);
          return [
            `Episode ${episode.id} (${episode.source}, agent "${episode.agentId || 'system'}", ${episode.at}):`,
            episode.text,
            `Fact: ${episode.factIds.length} (${episode.factIds.join(', ') || 'chua trich'}); entity: ${episode.entityIds.length}; cau da quet: ${episode.sentencesScanned}.`,
          ].join('\n');
        }
        if (action === 'list') {
          const day = getOptionalStringArg(args, 'day');
          const list = store.episodes.list({
            scope,
            ...(getOptionalStringArg(args, 'source')
              ? { source: getOptionalStringArg(args, 'source') as 'chat' | 'tool' | 'sleep' | 'import' | 'system' | 'voice' }
              : {}),
            ...(getOptionalStringArg(args, 'agentId') ? { agentId: getOptionalStringArg(args, 'agentId') } : {}),
            ...(day ? { fromDay: day, toDay: day } : {}),
            ...(getOptionalStringArg(args, 'textContains') ? { textContains: getOptionalStringArg(args, 'textContains') } : {}),
            limit,
          });
          if (list.length === 0) return 'Khong co episode nao theo bo loc.';
          return [
            `${list.length} episode:`,
            ...list.map((e) => `- ${e.id} (${e.source}, ${e.at}): ${e.text.slice(0, 120)}${e.text.length > 120 ? '...' : ''} [${e.factIds.length} fact]`),
          ].join('\n');
        }
        if (action === 'provenance') {
          const res = pipeline.provenance(getStringArg(args, 'id'));
          if (!res.ok) return errorResult(res.error);
          const p = res.value;
          return [
            `Provenance fact ${p.fact.id}: ${p.fact.subject} ${p.fact.predicate} ${p.fact.object}`,
            p.chain,
            p.episode ? `Episode text: "${p.episodeText}"` : 'Fact khong co episode goc.',
            p.siblingFacts.length > 0
              ? `Fact anh em cung episode (${p.siblingFacts.length}): ${p.siblingFacts.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join('; ')}.`
              : 'Khong co fact anh em cung episode.',
          ].join('\n');
        }
        if (action === 'search') {
          const res = pipeline.searchEpisodes(getStringArg(args, 'query'), { limit });
          if (!res.ok) return errorResult(res.error);
          if (res.value.length === 0) return `Khong tim thay episode nao cho "${getStringArg(args, 'query')}".`;
          return [
            `${res.value.length} episode:`,
            ...res.value.map((h) => `- ${h.episodeId} (diem ${h.score}): ${h.snippet}`),
          ].join('\n');
        }
        return errorResult(`action "${action}" khong hop le (create | get | list | provenance | search).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- graph ------------------------------------------------------------------

  const graphTool: Tool = {
    definition: toolDef(
      'memory_v27_graph',
      'Graph v27: ke 1 hop / 2 hop cua 1 fact, duong noi ngan nhat giua 2 subject, kiem tra tinh nhat quan graph, dem fact theo status. Read.',
      {
        action: { type: 'string', description: '"neighbors" | "two-hop" | "path" | "validate" | "counts".' },
        id: { type: 'string', description: 'Id fact goc (neighbors/two-hop).' },
        from: { type: 'string', description: 'Subject bat dau (path).' },
        to: { type: 'string', description: 'Subject dich (path).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'neighbors') {
          const list = store.graph.neighbors(getStringArg(args, 'id'), { limit });
          if (list.length === 0) return 'Fact khong co ke 1 hop nao (hoac khong co fact).';
          return [
            `${list.length} ke 1 hop:`,
            ...list.map((f) => `- ${f.id} [${f.status}] ${f.subject} ${f.predicate} ${f.object}`),
          ].join('\n');
        }
        if (action === 'two-hop') {
          const { hop1, hop2 } = store.graph.twoHop(getStringArg(args, 'id'), { limit });
          return [
            `Ke 1 hop (${hop1.length}): ${hop1.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join('; ') || '(khong co)'}.`,
            `Ke 2 hop (${hop2.length}): ${hop2.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join('; ') || '(khong co)'}.`,
          ].join('\n');
        }
        if (action === 'path') {
          const path = store.graph.findPath(getStringArg(args, 'from'), getStringArg(args, 'to'));
          if (path.length === 0) return `Khong tim duoc duong (<=3 hop) giua "${getStringArg(args, 'from')}" va "${getStringArg(args, 'to')}".`;
          return [
            `Duong ${path.length} hop:`,
            ...path.map((f, i) => `${i + 1}. ${f.subject} ${f.predicate} ${f.object}`),
          ].join('\n');
        }
        if (action === 'validate') {
          const problems = store.graph.validate();
          if (problems.length === 0) return 'Graph nhat quan: khong co van de.';
          return [`Graph co ${problems.length} van de:`, ...problems.map((p) => `- ${p}`)].join('\n');
        }
        if (action === 'counts') {
          const counts = store.graph.countByStatus();
          return `Fact theo status: active ${counts.active}, superseded ${counts.superseded}, expired ${counts.expired} (tong ${store.graph.size}).`;
        }
        return errorResult(`action "${action}" khong hop le (neighbors | two-hop | path | validate | counts).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- block (bi-temporal shared block) ----------------------------------------

  const blockTool: Tool = {
    definition: toolDef(
      'memory_v27_block',
      'Shared block bi-temporal v27 (tren nen v26): dang ky block lam block bi-temporal, cap nhat dong bo cho moi agent attach (1 lan ghi, tat ca thay), gan fact vao block, xem gia tri block tai thoi diem X, xem timeline + sync log. Cap nhat ghi du lieu — can approval.',
      {
        action: { type: 'string', description: '"register" | "update" | "append-fact" | "value-at" | "timeline" | "sync-log" | "sees-latest".' },
        blockId: { type: 'string', description: 'Id block v26 (update/append-fact/value-at/timeline/sync-log/sees-latest).' },
        label: { type: 'string', description: 'Label block (register: tim theo label; thay cho blockId).' },
        value: { type: 'string', description: 'Gia tri moi cua block (update).' },
        factLine: { type: 'string', description: 'Dong fact gan vao block (append-fact, vd "Huy likes coffee").' },
        factIds: { type: 'array', items: { type: 'string' }, description: 'Id fact lien quan cap nhat (update/append-fact, tuy chon).' },
        at: { type: 'string', description: 'Thoi diem X (ISO, value-at).' },
        agentId: { type: 'string', description: 'Agent can kiem tra (sees-latest).' },
        reason: { type: 'string', description: 'Ly do cap nhat (update/append-fact, tuy chon).' },
        expectedVersion: { type: 'number', description: 'Version du kien (update, chong ghi de khi lech).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
        botId: { type: 'string', description: 'Bot cap nhat (mac dinh bot goi tool).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = scopeOf(args);
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        const resolveBlockId = (): string => {
          const byId = getOptionalStringArg(args, 'blockId');
          if (byId) return byId;
          const label = getOptionalStringArg(args, 'label');
          if (!label) throw new Error('Can blockId hoac label cua block.');
          const block = store.v26.listBlocks().find((b) => b.label === label);
          if (!block) throw new Error(`Khong co block label "${label}".`);
          return block.id;
        };
        if (action === 'register') {
          const blockId = resolveBlockId();
          const res = store.blocks.registerBlock(blockId);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da dang ky block "${res.value.label}" (${res.value.blockId}) lam block bi-temporal v27 — owner ${res.value.ownerBotId}, attach ${res.value.attachedBotIds.join(', ') || '(khong co)'}.`;
        }
        if (action === 'update') {
          const blockId = resolveBlockId();
          const res = store.blocks.updateBlock(
            blockId,
            getStringArg(args, 'value'),
            callerBot(args) || 'system',
            {
              ...(getOptionalStringArg(args, 'reason') ? { reason: getOptionalStringArg(args, 'reason') } : {}),
              ...(getNumberArg(args, 'expectedVersion') !== undefined ? { expectedVersion: getNumberArg(args, 'expectedVersion') } : {}),
              factIds: getStringListArg(args, 'factIds') ?? [],
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da cap nhat block "${res.value.label}" len v${res.value.version} — dong bo cho ${res.value.syncedAgents.length} agent (${res.value.syncedAgents.join(', ') || '(chi owner)'}), ${res.value.attachedCount} agent attach.`;
        }
        if (action === 'append-fact') {
          const blockId = resolveBlockId();
          const res = store.blocks.appendFactToBlock(
            blockId,
            getStringArg(args, 'factLine'),
            callerBot(args) || 'system',
            {
              factIds: getStringListArg(args, 'factIds') ?? [],
              ...(getOptionalStringArg(args, 'reason') ? { reason: getOptionalStringArg(args, 'reason') } : {}),
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da gan fact vao block "${res.value.label}" (v${res.value.version}) — dong bo cho ${res.value.syncedAgents.length} agent.`;
        }
        if (action === 'value-at') {
          const blockId = resolveBlockId();
          const res = store.blocks.valueAt(blockId, getStringArg(args, 'at'));
          if (!res.ok) return errorResult(res.error);
          return `Gia tri block tai ${getStringArg(args, 'at')}: ${res.value ? JSON.stringify(res.value.slice(0, 500)) : '(chua co)'}.`;
        }
        if (action === 'timeline') {
          const blockId = resolveBlockId();
          const entries = store.blocks.timelineFor(blockId).slice(0, limit);
          if (entries.length === 0) return 'Block chua co timeline entry nao (chua dang ky lop bi-temporal?).';
          return [
            `Timeline ${entries.length} entry (cu nhat truoc):`,
            ...entries.map((e) => `- v${e.version} ${e.validFrom} -> ${e.validTo ?? 'nay'} (bo "${e.by}", ${e.reason})${e.factIds.length > 0 ? ` [${e.factIds.length} fact]` : ''}: ${e.value.slice(0, 100)}${e.value.length > 100 ? '...' : ''}`),
          ].join('\n');
        }
        if (action === 'sync-log') {
          const blockId = resolveBlockId();
          const entries = store.blocks.syncLogFor(blockId, limit);
          if (entries.length === 0) return 'Chua co sync log nao cho block nay.';
          return [
            `Sync log ${entries.length} muc (moi nhat truoc):`,
            ...entries.map((s) => `- ${s.at}: agent ${s.agentId} nhan timeline ${s.timelineEntryId} (applied: ${s.applied})`),
          ].join('\n');
        }
        if (action === 'sees-latest') {
          const blockId = resolveBlockId();
          const agentId = getOptionalStringArg(args, 'agentId') ?? callerBot(args);
          if (!agentId) return errorResult('Can agentId (hoac botId).');
          const res = store.blocks.agentSeesLatest(blockId, agentId);
          if (!res.ok) return errorResult(res.error);
          return res.value
            ? `Agent "${agentId}" thay gia tri moi nhat cua block (doc chung 1 store).`
            : `Agent "${agentId}" khong attach block nay (hoac chua nhan cap nhat moi nhat).`;
        }
        void scope;
        return errorResult(`action "${action}" khong hop le (register | update | append-fact | value-at | timeline | sync-log | sees-latest).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- stats ------------------------------------------------------------------

  const statsTool: Tool = {
    definition: toolDef(
      'memory_v27_stats',
      'Thong ke memory v27: fact/entity/episode/block bi-temporal + bo dem add-only (duplicate da bo, edge da dong) + health + panel view + export/import snapshot JSON. Read, tru import (ghi) can approval.',
      {
        action: { type: 'string', description: '"stats" | "health" | "panel" | "export" | "import".' },
        json: { type: 'string', description: 'JSON snapshot v27 da export (import).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'stats') {
          const stats = store.stats();
          return [
            'Memory v27:',
            `- Fact: ${stats.factsTotal} tong (${stats.factsActive} active, ${stats.factsSuperseded} superseded, ${stats.factsExpired} expired).`,
            `- Entity: ${stats.entitiesTotal} (${Object.entries(stats.entitiesByKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'chua co'}). Episode: ${stats.episodesTotal} (${Object.entries(stats.episodesBySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'chua co'}).`,
            `- Shared block bi-temporal: ${stats.sharedBlocksTotal} block, ${stats.timelineEntriesTotal} timeline entry, ${stats.syncEntriesTotal} sync entry.`,
            `- Add-only: ${stats.duplicatesSkipped} duplicate da bo, ${stats.edgesClosedBySupersede} edge da dong do supersede, ${stats.candidatesExtractedTotal} candidate da trich.`,
          ].join('\n');
        }
        if (action === 'health') {
          const problems = store.health();
          if (problems.length === 0) return 'Memory v27 khoe: khong co van de nhat quan.';
          return [`Memory v27 co ${problems.length} van de:`, ...problems.map((p) => `- ${p}`)].join('\n');
        }
        if (action === 'panel') {
          const view = buildV27PanelView(store);
          return [
            view.summary,
            `Top fact (${view.topFacts.length}): ${view.topFacts.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join('; ') || '(chua co)'}.`,
            `Top entity (${view.topEntities.length}): ${view.topEntities.map((e) => `${e.name} [${e.kind}, boost ${e.boostWeight}]`).join('; ') || '(chua co)'}.`,
            `Episode gan nhat (${view.recentEpisodes.length}): ${view.recentEpisodes.map((e) => e.preview).join(' | ') || '(chua co)'}.`,
            view.warnings.length > 0 ? `Canh bao: ${view.warnings.join('; ')}.` : 'Khong co canh bao.',
          ].join('\n');
        }
        if (action === 'export') {
          return JSON.stringify(store.snapshot(), null, 2);
        }
        if (action === 'import') {
          let data: unknown;
          try {
            data = JSON.parse(getStringArg(args, 'json'));
          } catch {
            return errorResult('JSON snapshot khong hop le.');
          }
          const res = store.importSnapshot(data);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da import snapshot: ${res.value.factsAdded} fact moi, ${res.value.entitiesAdded} entity moi, ${res.value.episodesAdded} episode moi (add-only: cai da co giu nguyen).`;
        }
        return errorResult(`action "${action}" khong hop le (stats | health | panel | export | import).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    ingestTool,
    extractTool,
    factTool,
    searchTool,
    timeTravelTool,
    entityTool,
    episodeTool,
    graphTool,
    blockTool,
    statsTool,
  ];
}

/** Ten tool memory v27 (thu tu nhu createMemoryV27Tools tra ve). */
export const MEMORY_V27_TOOL_NAMES = [
  'memory_v27_ingest',
  'memory_v27_extract',
  'memory_v27_fact',
  'memory_v27_search',
  'memory_v27_time_travel',
  'memory_v27_entity',
  'memory_v27_episode',
  'memory_v27_graph',
  'memory_v27_block',
  'memory_v27_stats',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v27 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V27_TOOLS: Tool[] = createMemoryV27Tools();
