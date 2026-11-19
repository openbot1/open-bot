/**
 * Memory v25 tools for @open-bot/tools (v1.40, Doi T1).
 *
 * Agent lam viec voi memory v25 bang tool call:
 *  - memory_v25_sleep        — trang thai sleep agent + chay sleep pass (ghi needsApproval: true)
 *  - memory_v25_block        — shared block lien-bot co read-only: create/attach/detach/readonly/write/history/revert/render (ghi needsApproval: true)
 *  - memory_v25_fact         — fact edge bi-temporal: add/list/at/current/history/close/expire (ghi needsApproval: true)
 *  - memory_v25_judge        — judge ADD/UPDATE/DELETE/NOISE cho fact moi + xem log (apply needsApproval: true)
 *  - memory_v25_add          — buffer hoi thoai cho sleep pass (primary agent KHONG tu sua core memory) (ghi needsApproval: true)
 *  - memory_v25_search       — tim keyword + time-aware as-of (read)
 *  - memory_v25_consolidate  — xem truoc extraction + chay consolidation thu cong (ghi needsApproval: true)
 *  - memory_v25_config       — xem/sua cau hinh sleep agent (sua needsApproval: true)
 *  - memory_v25_audit        — audit: fact bi dong, judge log, block history, sleep pass (read)
 *  - memory_v25_stats        — thong ke store + health + snapshot prompt (read)
 *
 * SAFETY: primary agent chi buffer turn — chi sleep pass moi sua
 * core memory; fact bi supersede/DELETE chi DONG hieu luc
 * (invalid_at/expired_at), KHONG xoa vat ly; block read-only thi
 * bot khac owner chi doc; khong goi model chat, khong goi API
 * ngoai — judge mac dinh la rule judge noi bo, ghi ro model vao
 * sleep pass + judge log.
 *
 * Factory:
 *   createMemoryV25Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V25_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  V25Pipeline,
  V25Store,
  loadV25StoreFromDir,
  makeV25Scope,
  type V25FactEdgeInput,
  type V25JudgeDecision,
  type V25Scope,
  type V25SleepConfig,
} from '@open-bot/core';

export interface MemoryV25ToolOptions {
  store?: V25Store;
  pipeline?: V25Pipeline;
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

function describeSleepConfigV25(config: V25SleepConfig): string {
  return [
    `Sleep agent: ${config.enabled ? 'bat' : 'tat'} (model ${config.model}, trigger sau ${config.triggerSteps} turn).`,
    `Budget moi pass: ${config.budget.maxFactsPerPass} fact, ${config.budget.maxTurnsPerPass} turn, ${config.budget.maxCharsPerPass} ky tu.`,
    `Block dich: ${config.blockTargets.join(', ') || '(khong co)'}.`,
  ].join('\n');
}

export function createMemoryV25Tools(opts: MemoryV25ToolOptions = {}): Tool[] {
  const loadedStore = opts.workspaceDir ? loadV25StoreFromDir(opts.workspaceDir) : null;
  const store = opts.store ??
    (loadedStore && loadedStore.ok ? loadedStore.value : new V25Store());
  const pipeline = opts.pipeline ?? new V25Pipeline(store);
  const defaultScope: Partial<V25Scope> = opts.scope ?? {};
  const defaultBotId = opts.botId;

  const scopeWithBot = (scope: Partial<V25Scope>): Partial<V25Scope> => {
    if (scope.agentId) return scope;
    if (defaultBotId) return { ...scope, agentId: defaultBotId };
    return scope;
  };

  const fullScope = (scope: Partial<V25Scope>): V25Scope =>
    makeV25Scope(scopeWithBot(scope));

  /**
   * Scope cho DOC: chi loc khi user truyen ro scope (hoac factory
   * defaultScope co gia tri) — khong tu them botId vao doc. Doc mac
   * dinh thay tat ca (ke ca record do sleep pass ghi voi scope
   * rong). Ghi thi dung fullScope de giu provenance.
   */
  const readScope = (args: Record<string, unknown>): Partial<V25Scope> => {
    const hasArg = ['userId', 'agentId', 'runId', 'appId'].some(
      (k) => args[k] !== undefined && args[k] !== null && args[k] !== '',
    );
    const hasDefault = Boolean(
      defaultScope.userId || defaultScope.agentId || defaultScope.runId || defaultScope.appId,
    );
    if (!hasArg && !hasDefault) return {};
    return makeV25Scope(scopeFromArgs(args, defaultScope));
  };

  const persist = (): void => {
    if (!opts.workspaceDir) return;
    try {
      store.save(opts.workspaceDir);
    } catch {
      // Luu that bai khong lam hong tool call — store in-memory van dung duoc.
    }
  };

  const sleepTool: Tool = {
    definition: toolDef(
      'memory_v25_sleep',
      'Sleep-time consolidation agent: xem trang thai (so turn cho, pass gan nhat) hoac chay 1 sleep pass ngay — trich fact tu turn da buffer, judge ADD/UPDATE/DELETE/NOISE, cap nhat block dich ngoai vong lap chinh. Chi sleep pass moi sua core memory. Chay pass — can duyet.',
      {
        action: { type: 'string', description: '"status" | "run" | "passes".' },
        reason: { type: 'string', description: 'Ly do chay pass (run).' },
        limit: { type: 'number', description: 'So pass toi da khi xem lich su (mac dinh 5).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const agent = store.sleep;
        if (action === 'status') {
          const config = agent.getConfig();
          const last = agent.getLastPass();
          const lines = [
            describeSleepConfigV25(config),
            `Turn cho xu ly: ${agent.getPendingTurnCount()} (tu pass gan nhat: ${agent.getTurnsSinceLastPass()} turn) — ${agent.shouldRun() ? 'DU NGUONG, nen chay pass.' : 'chua du nguong.'}`,
            `Tong pass da chay: ${agent.getTotalPasses()}.`,
          ];
          if (last) {
            lines.push(
              `Pass gan nhat ${last.id} (${last.model}, ${last.reason}): quet ${last.turnsScanned} turn — trich ${last.factsExtracted}, judge ${last.judged}: +${last.added} add, ${last.updated} update, ${last.closed} close, ${last.noise} noise, ${last.blocksUpdated} block cap nhat${last.budgetHit ? ' (HET BUDGET)' : ''}.`,
            );
          }
          return lines.join('\n');
        }
        if (action === 'passes') {
          const limit = Math.min(20, Math.max(1, getNumberArg(args, 'limit') ?? 5));
          const passes = agent.listPasses(limit);
          if (passes.length === 0) return 'Chua co sleep pass nao.';
          return [
            `${passes.length} sleep pass gan nhat:`,
            ...passes.map(
              (p) =>
                `- ${p.id} (${p.model}, ${p.reason}, ${p.startedAt}): ${p.turnsScanned} turn, ${p.factsExtracted} fact — +${p.added} add, ${p.updated} update, ${p.closed} close, ${p.noise} noise, ${p.blocksUpdated} block${p.budgetHit ? ' (HET BUDGET)' : ''}.`,
            ),
          ].join('\n');
        }
        if (action === 'run') {
          const reason = getOptionalStringArg(args, 'reason') ?? 'manual';
          const res = await pipeline.runSleepNow({ reason });
          if (!res.ok) return errorResult(res.error);
          const p = res.value;
          persist();
          const lines = [
            `Sleep pass ${p.id} xong (${p.model}, ${p.reason}): quet ${p.turnsScanned} turn (${p.charsScanned} ky tu) — trich ${p.factsExtracted}, judge ${p.judged}: +${p.added} add, ${p.updated} update, ${p.closed} close, ${p.noise} noise, ${p.blocksUpdated} block cap nhat${p.budgetHit ? ' (HET BUDGET — turn thua de pass sau)' : ''}.`,
          ];
          for (const a of p.actions.slice(0, 20)) lines.push(`- [${a.kind}] ${a.detail}`);
          return lines.join('\n');
        }
        return errorResult(`action "${action}" khong hop le (status | run | passes).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const blockTool: Tool = {
    definition: toolDef(
      'memory_v25_block',
      'Shared memory block lien-bot (Letta-style): label + mo ta + gia tri, attach/detach nhieu bot, read-only — bot khac owner chi doc, khong ghi. Ghi — can duyet.',
      {
        action: { type: 'string', description: '"create" | "list" | "get" | "attach" | "detach" | "readonly" | "write" | "history" | "revert" | "render" | "transfer".' },
        label: { type: 'string', description: 'Label block (create/get, vd "human").' },
        id: { type: 'string', description: 'Id block (attach/detach/readonly/write/history/revert/transfer).' },
        description: { type: 'string', description: 'Mo ta block (create).' },
        value: { type: 'string', description: 'Gia tri block (create/write).' },
        botId: { type: 'string', description: 'Bot attach/detach/write/transfer (mac dinh bot hien tai).' },
        readOnly: { type: 'boolean', description: 'Bat/tat read-only (readonly).' },
        toBotId: { type: 'string', description: 'Bot nhan quyen so huu (transfer).' },
        version: { type: 'number', description: 'Version can revert ve (revert).' },
        expectedVersion: { type: 'number', description: 'Version mong doi khi write (chong ghi de).' },
        maxChars: { type: 'number', description: 'Gioi han ky tu value (create, 0 = khong gioi han).' },
        reason: { type: 'string', description: 'Ly do write/revert/readonly.' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const blocks = store.blocks;
        const scope = fullScope(scopeFromArgs(args, defaultScope));
        const botId = getOptionalStringArg(args, 'botId') ?? defaultBotId ?? scope.agentId;
        if (action === 'list') {
          const list = blocks.list({ ...(botId ? { botId } : {}), scope: makeV25Scope(readScope(args)) });
          if (list.length === 0) return 'Chua co shared block nao.';
          return [
            `${list.length} shared block:`,
            ...list.map(
              (b) =>
                `- ${b.label} (${b.id}, v${b.version}${b.readOnly ? ', READ-ONLY' : ''}, owner ${b.ownerBotId}, attach: ${b.attachedBotIds.join(', ') || '(khong bot nao)'}): ${b.description || b.value.slice(0, 60)}`,
            ),
          ].join('\n');
        }
        if (action === 'create') {
          const label = getStringArg(args, 'label');
          const value = getStringArg(args, 'value');
          if (!botId) return errorResult('Can botId (hoac cau hinh botId mac dinh) lam owner.');
          const res = blocks.create({
            label,
            description: getOptionalStringArg(args, 'description') ?? '',
            value,
            ownerBotId: botId,
            scope,
            readOnly: getBoolArg(args, 'readOnly', false),
            ...(getNumberArg(args, 'maxChars') !== undefined ? { maxChars: getNumberArg(args, 'maxChars') as number } : {}),
          });
          if (!res.ok) return errorResult(res.error);
          if (!res.value) return errorResult('create block that bai.');
          persist();
          return `Da tao shared block ${res.value.label} (${res.value.id}, v1${res.value.readOnly ? ', READ-ONLY' : ''}, owner ${botId}).`;
        }
        if (action === 'get') {
          const label = getStringArg(args, 'label');
          const block = blocks.getByLabel(label, makeV25Scope(readScope(args)));
          if (!block) return errorResult(`Khong co block "${label}" trong scope nay.`);
          if (botId && block.ownerBotId !== botId && !block.attachedBotIds.includes(botId)) {
            return errorResult(`Bot "${botId}" khong duoc doc block "${label}" (chua attach).`);
          }
          return `# ${block.label} (v${block.version}${block.readOnly ? ', READ-ONLY' : ''})\n${block.description ? `${block.description}\n\n` : ''}${block.value}\n\nOwner: ${block.ownerBotId} · Attach: ${block.attachedBotIds.join(', ') || '(khong bot nao)'}`;
        }
        if (action === 'render') {
          const list = blocks.list({ scope: makeV25Scope(readScope(args)) });
          const rendered = blocks.renderForPrompt(list, botId ?? '');
          if (!rendered) return 'Khong co block nao bot nay duoc doc.';
          return rendered;
        }
        const id = getStringArg(args, 'id');
        if (action === 'attach' || action === 'detach') {
          if (!botId) return errorResult('Can botId (hoac cau hinh botId mac dinh).');
          const res = action === 'attach' ? blocks.attach(id, botId) : blocks.detach(id, botId);
          if (!res.ok) return errorResult(res.error);
          if (!res.value) return errorResult(`${action} that bai.`);
          persist();
          return `Da ${action === 'attach' ? 'attach' : 'detach'} bot "${botId}" ${action === 'attach' ? 'vao' : 'khoi'} block ${res.value.label} (attach hien tai: ${res.value.attachedBotIds.join(', ') || '(khong bot nao)'}).`;
        }
        if (action === 'readonly') {
          if (!botId) return errorResult('Can botId (chi owner moi doi read-only).');
          const readOnly = getBoolArg(args, 'readOnly', true);
          const res = blocks.setReadOnly(id, readOnly, botId);
          if (!res.ok) return errorResult(res.error);
          if (!res.value) return errorResult('doi read-only that bai.');
          persist();
          return `Block ${res.value.label} gio ${readOnly ? 'READ-ONLY (bot khac owner chi doc)' : 'ghi duoc (bot attach duoc ghi)'}.`;
        }
        if (action === 'transfer') {
          if (!botId) return errorResult('Can botId (owner hien tai).');
          const toBotId = getStringArg(args, 'toBotId');
          const res = blocks.transferOwnership(id, botId, toBotId);
          if (!res.ok) return errorResult(res.error);
          if (!res.value) return errorResult('transfer that bai.');
          persist();
          return `Da chuyen owner block ${res.value.label} sang bot "${toBotId}".`;
        }
        if (action === 'write') {
          if (!botId) return errorResult('Can botId de ghi block.');
          const value = getStringArg(args, 'value');
          const expectedVersion = getNumberArg(args, 'expectedVersion');
          const res = blocks.write(id, value, botId, {
            reason: getOptionalStringArg(args, 'reason') ?? 'tool:memory_v25_block',
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          });
          if (!res.ok) return errorResult(res.error);
          if (!res.value) return errorResult('write that bai.');
          persist();
          return `Da ghi block ${res.value.label} len v${res.value.version}.`;
        }
        if (action === 'history') {
          const history = blocks.history(id);
          if (!history.ok) return errorResult(history.error);
          if (history.value.length === 0) return `Block "${id}" khong co lich su.`;
          return [`Lich su block (${history.value.length} version):`, ...history.value.map((v) => `- v${v.version} ${v.updatedAt} boi ${v.updatedBy || '(?)'}: ${v.reason}`)].join('\n');
        }
        if (action === 'revert') {
          if (!botId) return errorResult('Can botId de revert block.');
          const version = getNumberArg(args, 'version');
          if (version === undefined) return errorResult('Can "version" (so version muon revert ve).');
          const res = blocks.revert(id, version, botId, {
            reason: getOptionalStringArg(args, 'reason') ?? 'tool:memory_v25_block',
          });
          if (!res.ok) return errorResult(res.error);
          if (!res.value) return errorResult('revert that bai.');
          persist();
          return `Da revert block ${res.value.label} ve v${version} (hien tai v${res.value.version}).`;
        }
        return errorResult(`action "${action}" khong hop le (create | list | get | attach | detach | readonly | write | history | revert | render | transfer).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const factTool: Tool = {
    definition: toolDef(
      'memory_v25_fact',
      'Fact edge bi-temporal (Graphiti-style): moi edge co valid_at/invalid_at/created_at/expired_at; fact moi mau thuan fact cu thi DONG khoang hieu luc (supersede/close), KHONG xoa vat ly; query "dung tai X" (at) va "hien tai" (current). Ghi — can duyet.',
      {
        action: { type: 'string', description: '"add" | "list" | "get" | "at" | "current" | "history" | "close" | "expire".' },
        subject: { type: 'string', description: 'Subject cua fact (add/list/at/current).' },
        predicate: { type: 'string', description: 'Predicate cua fact (add/list/at/current).' },
        object: { type: 'string', description: 'Object cua fact (add).' },
        id: { type: 'string', description: 'Id edge (get/history/close/expire).' },
        at: { type: 'string', description: 'Thoi diem ISO de query "dung tai X" (at).' },
        validAt: { type: 'string', description: 'Valid time bat dau (ISO, add).' },
        episodeId: { type: 'string', description: 'Episode/turn nguon (add).' },
        sourceText: { type: 'string', description: 'Doan text goc (add).' },
        reason: { type: 'string', description: 'Ly do close/expire.' },
        supersede: { type: 'boolean', description: 'Add kem supersede fact cu cung subject+predicate (add, mac dinh false).' },
        limit: { type: 'number', description: 'So edge toi da khi list (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = fullScope(scopeFromArgs(args, defaultScope));
        const facts = store.facts;
        if (action === 'list') {
          const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
          const list = facts.list({
            scope: makeV25Scope(readScope(args)),
            ...(getOptionalStringArg(args, 'subject') ? { subject: getOptionalStringArg(args, 'subject') as string } : {}),
            ...(getOptionalStringArg(args, 'predicate') ? { predicate: getOptionalStringArg(args, 'predicate') as string } : {}),
            limit,
          });
          if (list.length === 0) return 'Chua co fact edge nao.';
          return [`${list.length} fact edge:`, ...list.map((e) => `- ${e.id} [${e.status}] ${e.subject} ${e.predicate} ${e.object} (valid ${e.validAt ?? '...'} → ${e.invalidAt ?? '...'}, created ${e.createdAt})`)].join('\n');
        }
        if (action === 'at') {
          const at = getStringArg(args, 'at');
          const res = pipeline.queryFactsAt(at, {
            ...(getOptionalStringArg(args, 'subject') ? { subject: getOptionalStringArg(args, 'subject') as string } : {}),
            ...(getOptionalStringArg(args, 'predicate') ? { predicate: getOptionalStringArg(args, 'predicate') as string } : {}),
            scope: makeV25Scope(readScope(args)),
          });
          if (!res.ok) return errorResult(res.error);
          if (res.value.length === 0) return `Khong co fact nao dung tai ${at}.`;
          return [`${res.value.length} fact dung tai ${at}:`, ...res.value.map((e) => `- ${e.subject} ${e.predicate} ${e.object} (valid ${e.validAt ?? '...'} → ${e.invalidAt ?? '...'})`)].join('\n');
        }
        if (action === 'current') {
          const list = pipeline.queryCurrentFacts({
            ...(getOptionalStringArg(args, 'subject') ? { subject: getOptionalStringArg(args, 'subject') as string } : {}),
            ...(getOptionalStringArg(args, 'predicate') ? { predicate: getOptionalStringArg(args, 'predicate') as string } : {}),
            scope: makeV25Scope(readScope(args)),
          });
          if (list.length === 0) return 'Khong co fact hien tai nao.';
          return [`${list.length} fact hien tai:`, ...list.map((e) => `- ${e.subject} ${e.predicate} ${e.object} (tu ${e.validAt ?? e.createdAt})`)].join('\n');
        }
        if (action === 'get') {
          const id = getStringArg(args, 'id');
          const edge = facts.get(id);
          if (!edge) return errorResult(`Khong co fact edge "${id}".`);
          return [
            `${edge.subject} ${edge.predicate} ${edge.object} [${edge.status}]`,
            `valid: ${edge.validAt ?? '(khong ro)'} → ${edge.invalidAt ?? '(van dung)'}`,
            `transaction: created ${edge.createdAt}, expired ${edge.expiredAt ?? '(van luu)'}`,
            `episode: ${edge.episodeId || '(khong co)'} · source: "${edge.sourceText || '(khong co)'}"`,
            `confidence: ${edge.confidence} · judge: ${edge.judgeDecision ?? '(khong co)'} · supersedes: ${edge.supersedesId ?? '-'} · superseded by: ${edge.supersededById ?? '-'}`,
            `history (${edge.history.length}): ${edge.history.map((h) => `${h.kind}@${h.at}`).join(', ')}`,
          ].join('\n');
        }
        if (action === 'history') {
          const id = getStringArg(args, 'id');
          const res = facts.history(id);
          if (!res.ok) return errorResult(res.error);
          if (res.value.length === 0) return `Edge "${id}" khong co lich su.`;
          return [`Lich su edge ${id} (${res.value.length} su kien):`, ...res.value.map((h) => `- [${h.kind}] ${h.at} boi ${h.by}: ${h.detail}`)].join('\n');
        }
        if (action === 'add') {
          const input: V25FactEdgeInput = {
            subject: getStringArg(args, 'subject'),
            predicate: getStringArg(args, 'predicate'),
            object: getStringArg(args, 'object'),
            episodeId: getOptionalStringArg(args, 'episodeId') ?? 'tool:memory_v25_fact',
            sourceText: getOptionalStringArg(args, 'sourceText') ?? '',
            scope,
            ...(getOptionalStringArg(args, 'validAt') ? { validAt: getOptionalStringArg(args, 'validAt') as string } : {}),
          };
          const supersede = getBoolArg(args, 'supersede', false);
          if (supersede) {
            const res = facts.addSuperseding(input, { by: defaultBotId ?? 'user', reason: 'tool supersede' });
            if (!res.ok) return errorResult(res.error);
            persist();
            return `Da them edge ${res.value.edge.id} (${input.subject} ${input.predicate} ${input.object})${res.value.closed.length > 0 ? `, dong ${res.value.closed.length} edge cu: ${res.value.closed.map((c) => c.id).join(', ')}` : ', khong co edge cu nao bi dong'}.`;
          }
          const res = facts.add(input, { by: defaultBotId ?? 'user' });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da them edge ${res.value.id}: ${input.subject} ${input.predicate} ${input.object} (valid tu ${res.value.validAt ?? res.value.createdAt}).`;
        }
        if (action === 'close' || action === 'expire') {
          const id = getStringArg(args, 'id');
          const reason = getOptionalStringArg(args, 'reason') ?? `tool:memory_v25_fact:${action}`;
          const res = action === 'close'
            ? facts.closeEdge(id, { by: defaultBotId ?? 'user', reason })
            : facts.expireEdge(id, { by: defaultBotId ?? 'user', reason });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da ${action === 'close' ? 'dong hieu luc' : 'danh dau het han'} edge ${id} (${res.value.subject} ${res.value.predicate} ${res.value.object}) — edge van con trong lich su, khong bi xoa.`;
        }
        return errorResult(`action "${action}" khong hop le (add | list | get | at | current | history | close | expire).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const judgeTool: Tool = {
    definition: toolDef(
      'memory_v25_judge',
      'LLM judge kieu Mem0: judge 1 fact ung vien so voi memory hien co — ADD (moi) / UPDATE (gia tri moi, supersede cu) / DELETE (phu dinh fact cu: chi dong hieu luc, khong xoa) / NOISE (trung lap / khong phai fact). Co the chi xem truoc (apply=false) hoac ap dung ngay. Apply — can duyet.',
      {
        subject: { type: 'string', description: 'Subject cua fact ung vien.' },
        predicate: { type: 'string', description: 'Predicate cua fact ung vien.' },
        object: { type: 'string', description: 'Object cua fact ung vien.' },
        sourceText: { type: 'string', description: 'Doan text goc cua ung vien.' },
        action: { type: 'string', description: '"judge" | "log".' },
        apply: { type: 'boolean', description: 'Ap dung quyet dinh ngay (mac dinh true; false = chi xem truoc).' },
        decision: { type: 'string', description: 'Loc log theo quyet dinh (log): ADD | UPDATE | DELETE | NOISE.' },
        limit: { type: 'number', description: 'So log toi da (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'log') {
          const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
          const decisionRaw = getOptionalStringArg(args, 'decision');
          const valid: V25JudgeDecision[] = ['ADD', 'UPDATE', 'DELETE', 'NOISE'];
          if (decisionRaw && !valid.includes(decisionRaw as V25JudgeDecision)) {
            return errorResult(`decision "${decisionRaw}" khong hop le (ADD | UPDATE | DELETE | NOISE).`);
          }
          const entries = store.listJudgeLog({
            ...(decisionRaw ? { decision: decisionRaw as V25JudgeDecision } : {}),
            limit,
          });
          if (entries.length === 0) return 'Judge log dang rong.';
          const counts = store.countJudgeByDecision();
          return [
            `Judge log (${entries.length} muc gan nhat; ADD ${counts.ADD}, UPDATE ${counts.UPDATE}, DELETE ${counts.DELETE}, NOISE ${counts.NOISE}):`,
            ...entries.map((e) => `- [${e.decision} · conf ${e.confidence.toFixed(2)} · ${e.at}] ${e.candidateSubject} ${e.candidatePredicate} ${e.candidateObject} — ${e.reason} (applied: ${e.applied ? e.appliedDetail : 'chua'})`),
          ].join('\n');
        }
        if (action === 'judge') {
          const sourceText = getOptionalStringArg(args, 'sourceText');
          const candidate: V25FactEdgeInput = {
            subject: getStringArg(args, 'subject'),
            predicate: getStringArg(args, 'predicate'),
            object: getStringArg(args, 'object'),
            ...(sourceText ? { sourceText } : {}),
            scope: fullScope(scopeFromArgs(args, defaultScope)),
            episodeId: 'tool:memory_v25_judge',
          };
          const apply = getBoolArg(args, 'apply', true);
          const res = await pipeline.judgeCandidate(candidate, { apply, source: 'tool:memory_v25_judge', by: defaultBotId ?? 'judge' });
          if (!res.ok) return errorResult(res.error);
          persist();
          const lines = [
            `Judge: ${res.value.verdict.decision} (conf ${res.value.verdict.confidence.toFixed(2)}) — ${res.value.verdict.reason}`,
          ];
          if (res.value.verdict.matchedFactId) lines.push(`Fact lien quan: ${res.value.verdict.matchedFactId}`);
          if (res.value.applied) lines.push(`Da ap dung: ${res.value.applied.detail}`);
          else lines.push('(Chi xem truoc — chua ap dung.)');
          return lines.join('\n');
        }
        return errorResult(`action "${action}" khong hop le (judge | log).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const addTool: Tool = {
    definition: toolDef(
      'memory_v25_add',
      'Buffer hoi thoai vao sleep agent de sleep pass tong hop sau. PRIMARY AGENT KHONG TU SUA CORE MEMORY TRONG LUC CHAT — turn chi duoc buffer, fact/block chi duoc sleep pass cap nhat. Ghi — can duyet.',
      {
        text: { type: 'string', description: 'Noi dung turn hoi thoai can buffer.' },
        role: { type: 'string', description: '"user" | "agent" | "system" (mac dinh user).' },
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
        const res = pipeline.addConversation([
          { role: roleRaw as 'user' | 'agent' | 'system', text, at: new Date().toISOString() },
        ]);
        if (!res.ok) return errorResult(res.error);
        persist();
        return `Da buffer ${res.value.buffered} turn (tong cho: ${res.value.turnsSinceLastPass} turn)${res.value.shouldRunSleep ? ' — DU NGUONG, nen chay memory_v25_sleep run.' : ' — chua du nguong sleep.'} Luu y: turn chi duoc buffer, core memory chi doi khi sleep pass chay.`;
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const searchTool: Tool = {
    definition: toolDef(
      'memory_v25_search',
      'Tim memory v25: keyword (Jaccard token + substring) tren fact hien tai hoac fact dung tai thoi diem X (at) + shared block. Read.',
      {
        query: { type: 'string', description: 'Cau truy van.' },
        at: { type: 'string', description: 'Thoi diem ISO — chi lay fact dung tai luc do (rong = fact hien tai).' },
        topK: { type: 'number', description: 'So hit toi da (mac dinh 10, toi da 50).' },
        includeBlocks: { type: 'boolean', description: 'Co tim trong shared block khong (mac dinh true).' },
        ...SCOPE_PROPS,
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const topK = Math.min(50, Math.max(1, getNumberArg(args, 'topK') ?? 10));
        const at = getOptionalStringArg(args, 'at');
        const includeBlocks = getBoolArg(args, 'includeBlocks', true);
        const res = pipeline.search(query, {
          topK,
          includeBlocks,
          ...(at ? { at } : {}),
          scope: makeV25Scope(readScope(args)),
        });
        if (!res.ok) return errorResult(res.error);
        if (res.value.length === 0) return `Khong tim thay memory nao cho "${query}"${at ? ` tai ${at}` : ''}.`;
        return [
          `Tim thay ${res.value.length} memory cho "${query}"${at ? ` tai ${at}` : ''}:`,
          ...res.value.map((h) => `- [${h.score.toFixed(2)} · ${h.kind}] ${h.text} (${h.explanation})`),
        ].join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const consolidateTool: Tool = {
    definition: toolDef(
      'memory_v25_consolidate',
      'Consolidation thu cong: xem truoc fact trich duoc tu text (preview) hoac chay sleep pass ngay (run) de tong hop turn da buffer thanh memory. Run — can duyet.',
      {
        action: { type: 'string', description: '"preview" | "run".' },
        text: { type: 'string', description: 'Text can trich fact thu (preview).' },
        reason: { type: 'string', description: 'Ly do chay pass (run).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'preview') {
          const text = getStringArg(args, 'text');
          const res = pipeline.previewExtraction(text, {});
          if (!res.ok) return errorResult(res.error);
          if (res.value.length === 0) return 'Khong trich duoc fact ung vien nao tu text nay (chi xem truoc — chua ghi gi).';
          return [
            `Trich duoc ${res.value.length} fact ung vien (chi xem truoc — chua ghi):`,
            ...res.value.map((c) => `- ${c.subject} ${c.predicate} ${c.object} (tu: "${c.sentence}")`),
          ].join('\n');
        }
        if (action === 'run') {
          const reason = getOptionalStringArg(args, 'reason') ?? 'manual-consolidate';
          const res = await pipeline.runSleepNow({ reason });
          if (!res.ok) return errorResult(res.error);
          const p = res.value;
          persist();
          return `Consolidation xong (pass ${p.id}, ${p.model}): quet ${p.turnsScanned} turn — trich ${p.factsExtracted}, judge ${p.judged}: +${p.added} add, ${p.updated} update, ${p.closed} close, ${p.noise} noise, ${p.blocksUpdated} block cap nhat${p.budgetHit ? ' (HET BUDGET)' : ''}.`;
        }
        return errorResult(`action "${action}" khong hop le (preview | run).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const configTool: Tool = {
    definition: toolDef(
      'memory_v25_config',
      'Cau hinh sleep-time agent: xem (get) hoac sua (set) — triggerSteps (so turn thi chay pass), model dung cho sleep pass, budget moi pass, blockTargets (block sleep agent duoc cap nhat). Sua — can duyet.',
      {
        action: { type: 'string', description: '"get" | "set".' },
        triggerSteps: { type: 'number', description: 'So turn thi chay 1 pass (1..1000).' },
        model: { type: 'string', description: 'Model dung cho sleep pass (vd "local-rule-v1").' },
        enabled: { type: 'boolean', description: 'Bat/tat sleep agent.' },
        maxFactsPerPass: { type: 'number', description: 'So fact toi da moi pass (1..500).' },
        maxTurnsPerPass: { type: 'number', description: 'So turn toi da moi pass (1..200).' },
        maxCharsPerPass: { type: 'number', description: 'So ky tu toi da moi pass (100..500000).' },
        blockTargets: { type: 'array', description: 'Label cac block sleep agent duoc cap nhat.', items: { type: 'string' } },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'get') {
          return describeSleepConfigV25(store.sleep.getConfig());
        }
        if (action === 'set') {
          const patch: Partial<V25SleepConfig> = {};
          const triggerSteps = getNumberArg(args, 'triggerSteps');
          if (triggerSteps !== undefined) patch.triggerSteps = triggerSteps;
          const model = getOptionalStringArg(args, 'model');
          if (model !== undefined) patch.model = model;
          const enabled = args.enabled;
          if (enabled !== undefined) {
            if (typeof enabled !== 'boolean') return errorResult('Argument "enabled" phai la boolean.');
            patch.enabled = enabled;
          }
          const budget: Partial<V25SleepConfig['budget']> = {};
          const maxFacts = getNumberArg(args, 'maxFactsPerPass');
          if (maxFacts !== undefined) budget.maxFactsPerPass = maxFacts;
          const maxTurns = getNumberArg(args, 'maxTurnsPerPass');
          if (maxTurns !== undefined) budget.maxTurnsPerPass = maxTurns;
          const maxChars = getNumberArg(args, 'maxCharsPerPass');
          if (maxChars !== undefined) budget.maxCharsPerPass = maxChars;
          if (Object.keys(budget).length > 0) patch.budget = budget as V25SleepConfig['budget'];
          const blockTargets = getStringListArg(args, 'blockTargets');
          if (blockTargets !== undefined) patch.blockTargets = blockTargets;
          if (Object.keys(patch).length === 0) return errorResult('Khong co truong nao de sua — truyen it nhat 1 trong: triggerSteps, model, enabled, maxFactsPerPass, maxTurnsPerPass, maxCharsPerPass, blockTargets.');
          const res = store.sleep.updateConfig(patch);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da cap nhat cau hinh sleep:\n${describeSleepConfigV25(res.value)}`;
        }
        return errorResult(`action "${action}" khong hop le (get | set).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const auditTool: Tool = {
    definition: toolDef(
      'memory_v25_audit',
      'Audit memory v25: fact da dong hieu luc (superseded/expired, van con lich su), judge log, lich su block, sleep pass. Read — khong ghi gi.',
      {
        action: { type: 'string', description: '"superseded" | "judge" | "passes" | "block-history".' },
        id: { type: 'string', description: 'Id block (block-history) hoac id edge (khong bat buoc).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'superseded') {
          const closed = [
            ...store.facts.list({ status: 'superseded', limit }),
            ...store.facts.list({ status: 'expired', limit }),
          ].slice(0, limit);
          if (closed.length === 0) return 'Khong co fact nao bi dong hieu luc.';
          return [
            `${closed.length} fact da dong hieu luc (van con trong lich su — khong bi xoa):`,
            ...closed.map((e) => `- ${e.id} [${e.status}] ${e.subject} ${e.predicate} ${e.object} (valid ${e.validAt ?? '...'} → ${e.invalidAt ?? '...'}; superseded by ${e.supersededById ?? '-'})`),
          ].join('\n');
        }
        if (action === 'judge') {
          const entries = store.listJudgeLog({ limit });
          if (entries.length === 0) return 'Judge log dang rong.';
          return [
            `${entries.length} muc judge gan nhat:`,
            ...entries.map((e) => `- [${e.decision} · ${e.at}] ${e.candidateSubject} ${e.candidatePredicate} ${e.candidateObject} — ${e.reason} (applied: ${e.applied})`),
          ].join('\n');
        }
        if (action === 'passes') {
          const passes = store.sleep.listPasses(limit);
          if (passes.length === 0) return 'Chua co sleep pass nao.';
          return [
            `${passes.length} sleep pass gan nhat:`,
            ...passes.map((p) => `- ${p.id} (${p.model}, ${p.reason}): +${p.added} add, ${p.updated} update, ${p.closed} close, ${p.noise} noise, ${p.blocksUpdated} block${p.budgetHit ? ' (HET BUDGET)' : ''}`),
          ].join('\n');
        }
        if (action === 'block-history') {
          const id = getStringArg(args, 'id');
          const history = store.blocks.history(id);
          if (!history.ok) return errorResult(history.error);
          if (history.value.length === 0) return `Block "${id}" khong co lich su.`;
          return [`Lich su block ${id} (${history.value.length} version):`, ...history.value.map((v) => `- v${v.version} ${v.updatedAt} boi ${v.updatedBy || '(?)'}: ${v.reason}`)].join('\n');
        }
        return errorResult(`action "${action}" khong hop le (superseded | judge | passes | block-history).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const statsTool: Tool = {
    definition: toolDef(
      'memory_v25_stats',
      'Thong ke memory v25: fact (active/superseded/expired), block (tong/read-only), judge theo quyet dinh, sleep pass, turn buffer + health + snapshot prompt (so ky tu). Read.',
      {
        includeSnapshot: { type: 'boolean', description: 'Kem snapshot prompt (mac dinh false).' },
        budgetChars: { type: 'number', description: 'Ngan sach ky tu snapshot (mac dinh 8000).' },
        ...SCOPE_PROPS,
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const stats = store.stats();
        const health = store.health();
        const lines = [
          'Memory v25:',
          `- Fact: ${stats.factsTotal} tong (${stats.factsActive} active, ${stats.factsSuperseded} superseded, ${stats.factsExpired} expired — khong co fact nao bi xoa vat ly).`,
          `- Shared block: ${stats.blocksTotal} tong (${stats.blocksReadOnly} read-only, ${stats.blocksAttached} luot attach).`,
          `- Judge: ${stats.judgeTotal} muc (ADD ${stats.judgeByDecision.ADD}, UPDATE ${stats.judgeByDecision.UPDATE}, DELETE ${stats.judgeByDecision.DELETE}, NOISE ${stats.judgeByDecision.NOISE}).`,
          `- Sleep: ${stats.sleepPasses} pass da chay, ${stats.turnsBuffered} turn dang cho (${stats.turnsSinceLastPass} turn tu pass gan nhat).`,
          `- Health: ${health.map((h) => `[${h.severity}] ${h.code}: ${h.detail}`).join(' | ')}`,
        ];
        const includeSnapshot = getBoolArg(args, 'includeSnapshot', false);
        if (includeSnapshot) {
          const scope = makeV25Scope(readScope(args));
          const budget = getNumberArg(args, 'budgetChars') ?? 8000;
          const snap = pipeline.snapshotForPrompt({
            budgetChars: budget,
            scope,
            botId: defaultBotId ?? '',
          });
          lines.push(`- Snapshot prompt: ${snap.chars}/${snap.budgetChars} ky tu — ${snap.blocksRendered} block render, ${snap.facts.length} fact${snap.truncated ? ' (bi cat ngan sach)' : ''}.`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    sleepTool,
    blockTool,
    factTool,
    judgeTool,
    addTool,
    searchTool,
    consolidateTool,
    configTool,
    auditTool,
    statsTool,
  ];
}

/** Ten tool memory v25 (thu tu nhu createMemoryV25Tools tra ve). */
export const MEMORY_V25_TOOL_NAMES = [
  'memory_v25_sleep',
  'memory_v25_block',
  'memory_v25_fact',
  'memory_v25_judge',
  'memory_v25_add',
  'memory_v25_search',
  'memory_v25_consolidate',
  'memory_v25_config',
  'memory_v25_audit',
  'memory_v25_stats',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v25 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V25_TOOLS: Tool[] = createMemoryV25Tools();
