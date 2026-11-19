/**
 * Memory v24 tools for @open-bot/tools (v1.39, Doi T1).
 *
 * Agent lam viec voi memory v24 bang tool call:
 *  - memory_v24_add        — them hoi thoai vao memory (admission + extract ADD-only + resolve, needsApproval: true)
 *  - memory_v24_memfs      — MemFS: doc/list/edit/tao/xoa node Markdown + snapshot (ghi needsApproval: true)
 *  - memory_v24_search     — fused search (semantic + BM25 + entity + time-aware, read)
 *  - memory_v24_lesson     — lesson kem evidence: add/get/list/apply/retract/trace (ghi needsApproval: true)
 *  - memory_v24_block      — shared block lien-bot: create/attach/detach/lock/unlock/write/history/revert (ghi needsApproval: true)
 *  - memory_v24_sleep      — chay sleep-time consolidation luc idle (needsApproval: true)
 *  - memory_v24_decay      — xem truoc + ap dung decay/forgetting (needsApproval: true khi ap dung)
 *  - memory_v24_admission  — screen text truoc khi ghi / xem admission log (read)
 *  - memory_v24_conflict   — liet ke conflict mo / resolve (ghi needsApproval: true)
 *  - memory_v24_stats      — thong ke store + health + snapshot prompt (read)
 *
 * SAFETY: ghi chi qua store/pipeline co validation; xoa chi la
 * soft-delete (MemFS tombstone, fact archived, lesson retracted);
 * lesson khong evidence bi quarantine, khong vao prompt;
 * admission chan credential/injection/PII; shared block ghi can
 * khoa + expectedVersion; khong goi model chat, khong goi API
 * ngoai — embedder la hash noi bo, ghi ro provenance.
 *
 * Factory:
 *   createMemoryV24Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V24_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  V24AdmissionPolicy,
  V24Pipeline,
  V24Store,
  applyDecayToFactV24,
  applyDecayToLessonV24,
  decideResolutionV24,
  loadV24StoreFromDir,
  makeV24Scope,
  snapshotMemfsV24,
  traceLessonV24,
  type V24Lesson,
  type V24ResolutionStrategy,
  type V24Scope,
} from '@open-bot/core';

export interface MemoryV24ToolOptions {
  store?: V24Store;
  pipeline?: V24Pipeline;
  /** Thu muc workspace: store JSON + MemFS luu tai day khi khong truyen store san. */
  workspaceDir?: string;
  botId?: string;
  /** Scope mac dinh cho record moi (khi tool khong truyen scope). */
  scope?: Partial<V24Scope>;
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
  fallback: Partial<V24Scope>,
): Partial<V24Scope> {
  return {
    userId: getOptionalStringArg(args, 'userId') ?? fallback.userId ?? '',
    agentId: getOptionalStringArg(args, 'agentId') ?? fallback.agentId ?? '',
    runId: getOptionalStringArg(args, 'runId') ?? fallback.runId ?? '',
    appId: getOptionalStringArg(args, 'appId') ?? fallback.appId ?? '',
  };
}

function describeLessonV24(lesson: V24Lesson): string {
  return `- ${lesson.id} (${lesson.status}, v-confidence ${lesson.confidence}, evidence ${lesson.evidence.length}): ${lesson.title}`;
}

export function createMemoryV24Tools(opts: MemoryV24ToolOptions = {}): Tool[] {
  const store = opts.store ??
    (opts.workspaceDir
      ? (loadV24StoreFromDir(opts.workspaceDir).value ?? new V24Store())
      : new V24Store());
  const pipeline = opts.pipeline ?? new V24Pipeline(store);
  const defaultScope: Partial<V24Scope> = opts.scope ?? {};
  const defaultBotId = opts.botId;

  const scopeWithBot = (scope: Partial<V24Scope>): Partial<V24Scope> => {
    if (scope.agentId) return scope;
    if (defaultBotId) return { ...scope, agentId: defaultBotId };
    return scope;
  };

  const fullScope = (scope: Partial<V24Scope>): V24Scope =>
    makeV24Scope(scopeWithBot(scope));

  const persist = (): void => {
    if (!opts.workspaceDir) return;
    try {
      store.save(opts.workspaceDir);
    } catch {
      // Luu that bai khong lam hong tool call — store in-memory van dung duoc.
    }
  };

  const addTool: Tool = {
    definition: toolDef(
      'memory_v24_add',
      'Them hoi thoai (text) vao memory v24: admission screen, extract ADD-only, auto-resolve conflict, ghi fact + cap nhat MemFS conversations.md. Ghi — can duyet.',
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
        const report = await pipeline.addConversation(
          [{ role: roleRaw as 'user' | 'agent' | 'system', text }],
          scope,
          'tool:memory_v24_add',
        );
        persist();
        const lines = [
          `Da xu ly ${report.turns} turn: trich ${report.extracted} ung vien — +${report.added} add, ${report.superseded} supersede, ${report.merged} merge, ${report.rejected} reject, ${report.conflicts} conflict, ${report.blockedByAdmission} bi admission chan, ${report.noise} noise.`,
        ];
        if (report.addedIds.length > 0) lines.push(`Fact moi: ${report.addedIds.join(', ')}`);
        if (report.lessonIds.length > 0) lines.push(`Lesson moi: ${report.lessonIds.join(', ')}`);
        for (const entry of report.log.slice(0, 10)) lines.push(`- ${entry}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const memfsTool: Tool = {
    definition: toolDef(
      'memory_v24_memfs',
      'MemFS — memory dang cay Markdown co version: read/list/create/edit/delete/restore/snapshot. Doc la read; tao/sua/xoa can duyet.',
      {
        action: { type: 'string', description: '"read" | "list" | "create" | "edit" | "delete" | "restore" | "snapshot" | "history".' },
        path: { type: 'string', description: 'Path node, vd "profile/preferences.md" (read/create/edit/delete/restore/history).' },
        body: { type: 'string', description: 'Noi dung Markdown (create/edit).' },
        prefix: { type: 'string', description: 'Loc theo thu muc khi list (vd "profile/").' },
        reason: { type: 'string', description: 'Ly do edit (ghi vao lich su version).' },
        budgetChars: { type: 'number', description: 'Ngan sach ky tu khi snapshot (mac dinh 4000).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const memfs = store.memfs;
        if (action === 'list') {
          const prefix = getOptionalStringArg(args, 'prefix');
          const nodes = memfs.list({ ...(prefix ? { prefix } : {}) });
          if (nodes.length === 0) return 'Cay MemFS dang rong.';
          return [`${nodes.length} node:`, ...nodes.map((n) => `- ${n.path} (v${n.version}, ${n.title})`)].join('\n');
        }
        if (action === 'snapshot') {
          const budget = getNumberArg(args, 'budgetChars') ?? 4000;
          const snap = snapshotMemfsV24(memfs, { budgetChars: budget });
          const lines = [
            `MemFS snapshot: ${snap.tree.length} file, ${Object.keys(snap.nodes).length} node trong ngan sach (${snap.chars}/${budget} ky tu).`,
            `Cay: ${snap.tree.join(', ') || '(rong)'}`,
          ];
          for (const [p, content] of Object.entries(snap.nodes)) {
            lines.push(`--- ${p} ---\n${content}`);
          }
          if (snap.truncated.length > 0) lines.push(`(Cat ngan: ${snap.truncated.join(', ')})`);
          return lines.join('\n');
        }
        if (action === 'history') {
          const p = getStringArg(args, 'path');
          const history = memfs.history(p);
          if (history.length === 0) return `Node "${p}" khong co lich su.`;
          return [`Lich su ${p} (${history.length} version):`, ...history.map((v) => `- v${v.version} ${v.updatedAt} boi ${v.updatedBy || '(?)'}: ${v.reason}`)].join('\n');
        }
        const p = getStringArg(args, 'path');
        if (action === 'read') {
          const node = memfs.get(p);
          if (!node) return errorResult(`Khong co node "${p}".`);
          return `# ${node.title}\n(v${node.version}, cap nhat ${node.updatedAt} boi ${node.updatedBy || '(?)'})\n\n${node.body}`;
        }
        if (action === 'create') {
          const body = getStringArg(args, 'body');
          const res = memfs.addNode(p, body, {
            updatedBy: defaultBotId ?? '',
            scope: fullScope(scopeFromArgs(args, defaultScope)),
            reason: getOptionalStringArg(args, 'reason') ?? 'tool:memory_v24_memfs',
          });
          if (!res.ok || !res.value) return errorResult(res.error ?? 'create that bai.');
          persist();
          return `Da tao node ${res.value.path} (v${res.value.version}): ${res.value.title}`;
        }
        if (action === 'edit') {
          const body = getStringArg(args, 'body');
          const res = memfs.editNode(p, body, {
            updatedBy: defaultBotId ?? '',
            reason: getOptionalStringArg(args, 'reason') ?? 'tool:memory_v24_memfs',
          });
          if (!res.ok || !res.value) return errorResult(res.error ?? 'edit that bai.');
          persist();
          return `Da sua node ${res.value.path} len v${res.value.version}.`;
        }
        if (action === 'delete') {
          const res = memfs.deleteNode(p, { updatedBy: defaultBotId ?? '' });
          if (!res.ok) return errorResult(res.error ?? 'delete that bai.');
          persist();
          return `Da xoa mem node ${p} (tombstone, giu lich su; restore de khoi phuc).`;
        }
        if (action === 'restore') {
          const res = memfs.restoreNode(p, { updatedBy: defaultBotId ?? '' });
          if (!res.ok || !res.value) return errorResult(res.error ?? 'restore that bai.');
          persist();
          return `Da khoi phuc node ${p} (v${res.value.version}).`;
        }
        return errorResult(`action "${action}" khong hop le (read | list | create | edit | delete | restore | snapshot | history).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const searchTool: Tool = {
    definition: toolDef(
      'memory_v24_search',
      'Tim memory v24 bang fused retrieval: semantic (hash-embedding) + BM25 + entity + time-aware (valid-time + recency). Tra hit kem diem tung tin hieu va giai thich.',
      {
        query: { type: 'string', description: 'Cau truy van.' },
        topK: { type: 'number', description: 'So hit toi da (mac dinh 10, toi da 50).' },
        includeMemfs: { type: 'boolean', description: 'Co tim trong cay MemFS khong (mac dinh true).' },
        ...SCOPE_PROPS,
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const topK = Math.min(50, Math.max(1, getNumberArg(args, 'topK') ?? 10));
        const includeMemfs = getBoolArg(args, 'includeMemfs', true);
        const scope = scopeWithBot(scopeFromArgs(args, defaultScope));
        const hits = pipeline.search(query, {
          topK,
          scope: fullScope(scope),
          includeMemfs,
        });
        if (hits.length === 0) return `Khong tim thay memory nao cho "${query}".`;
        const lines = [`Tim thay ${hits.length} memory cho "${query}":`];
        for (const hit of hits) {
          lines.push(
            `- [${hit.score.total.toFixed(2)} · ${hit.sourceKind} · sem ${hit.score.semantic.toFixed(2)} / bm25 ${hit.score.keyword.toFixed(2)} / ent ${hit.score.entity.toFixed(2)} / time ${hit.score.time.toFixed(2)}] ${hit.text} (${hit.explanation})`,
          );
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const lessonTool: Tool = {
    definition: toolDef(
      'memory_v24_lesson',
      'Lesson kem evidence (WikiTrace-style): add/get/list/apply/retract/trace. Lesson BAT BUOC kem evidence (nguon + doan trich + thoi diem); thieu evidence se bi quarantine, khong vao system prompt. Ghi — can duyet.',
      {
        action: { type: 'string', description: '"add" | "get" | "list" | "apply" | "retract" | "trace".' },
        id: { type: 'string', description: 'Id lesson (get/apply/retract/trace).' },
        title: { type: 'string', description: 'Tieu de lesson (add).' },
        body: { type: 'string', description: 'Noi dung lesson (add).' },
        evidenceText: { type: 'string', description: 'Doan trich goc lam evidence (add).' },
        evidenceSource: { type: 'string', description: 'Nguon cua evidence, vd ten conversation/file (add).' },
        reason: { type: 'string', description: 'Ly do retract (retract).' },
        confidence: { type: 'number', description: 'Do tin cay 0..1 (add).' },
        tags: { type: 'array', description: 'Tags (add).', items: { type: 'string' } },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const scope = fullScope(scopeFromArgs(args, defaultScope));
          const lessons = store.listLessons({ scope });
          if (lessons.length === 0) return 'Chua co lesson nao.';
          return [`${lessons.length} lesson:`, ...lessons.map(describeLessonV24)].join('\n');
        }
        if (action === 'get' || action === 'trace') {
          const id = getStringArg(args, 'id');
          const lesson = store.getLesson(id);
          if (!lesson) return errorResult(`Khong co lesson "${id}".`);
          if (action === 'get') {
            return [
              `${lesson.title} (${lesson.status}, conf ${lesson.confidence}, importance ${lesson.importance})`,
              lesson.body,
              `Evidence (${lesson.evidence.length}):`,
              ...lesson.evidence.map((e) => `- [${e.kind}] ${e.source} @ ${e.capturedAt}: "${e.excerpt}"${e.uri ? ` (${e.uri})` : ''}`),
              `Tags: ${lesson.tags.join(', ') || '(khong co)'} · Applied ${lesson.appliedCount} lan.`,
            ].join('\n');
          }
          return traceLessonV24(lesson).join('\n');
        }
        if (action === 'apply') {
          const id = getStringArg(args, 'id');
          const res = store.applyLesson(id);
          if (!res.ok || !res.value) return errorResult(res.error ?? 'apply that bai.');
          return `Da ap dung lesson "${res.value.title}" (lan ${res.value.appliedCount}).`;
        }
        if (action === 'retract') {
          const id = getStringArg(args, 'id');
          const reason = getStringArg(args, 'reason');
          const res = store.retractLesson(id, reason);
          if (!res.ok || !res.value) return errorResult(res.error ?? 'retract that bai.');
          persist();
          return `Da retract lesson "${id}": ${reason}`;
        }
        if (action === 'add') {
          const title = getStringArg(args, 'title');
          const body = getStringArg(args, 'body');
          const evidenceText = getStringArg(args, 'evidenceText');
          const evidenceSource = getStringArg(args, 'evidenceSource');
          const scope = fullScope(scopeFromArgs(args, defaultScope));
          const res = pipeline.addLessonFromText({
            title,
            body,
            evidenceText,
            evidenceSource,
            scope,
            authorBotId: defaultBotId,
            confidence: getNumberArg(args, 'confidence'),
            tags: getStringListArg(args, 'tags'),
          });
          if (!res.ok || !res.lesson) return errorResult(res.error ?? 'add lesson that bai.');
          persist();
          const statusNote = res.lesson.status === 'quarantined'
            ? ' (QUARANTINED — evidence khong hop le, can bo sung)'
            : '';
          return `Da them lesson ${res.lesson.id}: "${res.lesson.title}" (${res.lesson.status})${statusNote}`;
        }
        return errorResult(`action "${action}" khong hop le (add | get | list | apply | retract | trace).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const blockTool: Tool = {
    definition: toolDef(
      'memory_v24_block',
      'Shared memory block lien-bot (Letta-style): 1 block nhieu bot doc/ghi, co khoa viet (lease) + lich su version + optimistic concurrency (expectedVersion). Ghi — can duyet.',
      {
        action: { type: 'string', description: '"create" | "list" | "get" | "attach" | "detach" | "lock" | "unlock" | "write" | "history" | "revert".' },
        name: { type: 'string', description: 'Ten block (create/get, vd "organization").' },
        id: { type: 'string', description: 'Id block (attach/detach/lock/unlock/write/history/revert).' },
        title: { type: 'string', description: 'Tieu de hien thi (create).' },
        content: { type: 'string', description: 'Noi dung Markdown (create/write).' },
        botId: { type: 'string', description: 'Bot attach/detach/lock/write (mac dinh bot hien tai).' },
        expectedVersion: { type: 'number', description: 'Version mong doi khi write (chong ghi de lang).' },
        version: { type: 'number', description: 'Version can revert ve (revert).' },
        reason: { type: 'string', description: 'Ly do lock/write/revert.' },
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
          const list = blocks.list({ ...(botId ? { botId } : {}), scope });
          if (list.length === 0) return 'Chua co shared block nao.';
          return [`${list.length} shared block:`, ...list.map((b) => `- ${b.name} (${b.id}, v${b.version}, attach: ${b.attachedBotIds.join(', ') || '(khong bot nao)'}${b.lock ? `, LOCK boi ${b.lock.holderBotId} den ${b.lock.expiresAt}` : ''}): ${b.title}`)].join('\n');
        }
        if (action === 'create') {
          const name = getStringArg(args, 'name');
          const title = getOptionalStringArg(args, 'title') ?? name;
          const content = getStringArg(args, 'content');
          const res = blocks.create({
            name,
            title,
            content,
            scope,
            createdBy: botId,
            attachBotIds: botId ? [botId] : [],
          });
          if (!res.ok || !res.value) return errorResult(res.error ?? 'create block that bai.');
          persist();
          return `Da tao shared block ${res.value.name} (${res.value.id}, v1).`;
        }
        if (action === 'get') {
          const name = getStringArg(args, 'name');
          const block = blocks.getByName(name, scope);
          if (!block) return errorResult(`Khong co block "${name}" trong scope nay.`);
          return `# ${block.title} (v${block.version})\n\n${block.content}\n\nAttach: ${block.attachedBotIds.join(', ') || '(khong bot nao)'}${block.lock ? `\nLOCK boi ${block.lock.holderBotId} den ${block.lock.expiresAt} (${block.lock.reason})` : ''}`;
        }
        const id = getStringArg(args, 'id');
        if (action === 'attach' || action === 'detach') {
          if (!botId) return errorResult('Can botId (hoac cau hinh botId mac dinh).');
          const res = action === 'attach' ? blocks.attach(id, botId) : blocks.detach(id, botId);
          if (!res.ok || !res.value) return errorResult(res.error ?? `${action} that bai.`);
          persist();
          return `Da ${action === 'attach' ? 'attach' : 'detach'} bot "${botId}" ${action === 'attach' ? 'vao' : 'khoi'} block ${res.value.name} (attach hien tai: ${res.value.attachedBotIds.join(', ') || '(khong bot nao)'}).`;
        }
        if (action === 'lock') {
          if (!botId) return errorResult('Can botId de lay khoa.');
          const res = blocks.acquireLock(id, botId, { reason: getOptionalStringArg(args, 'reason') ?? 'tool:memory_v24_block' });
          if (!res.ok || !res.value) return errorResult(res.error ?? 'lock that bai.');
          persist();
          return `Bot "${botId}" da giu khoa block den ${res.value.expiresAt}.`;
        }
        if (action === 'unlock') {
          if (!botId) return errorResult('Can botId de tra khoa.');
          const res = blocks.releaseLock(id, botId);
          if (!res.ok) return errorResult(res.error ?? 'unlock that bai.');
          persist();
          return 'Da tra khoa block.';
        }
        if (action === 'write') {
          if (!botId) return errorResult('Can botId de ghi block.');
          const content = getStringArg(args, 'content');
          const expectedVersion = getNumberArg(args, 'expectedVersion');
          const res = blocks.update(id, content, {
            botId,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
            reason: getOptionalStringArg(args, 'reason') ?? 'tool:memory_v24_block',
          });
          if (!res.ok || !res.value) return errorResult(res.error ?? 'write that bai.');
          persist();
          return `Da ghi block ${res.value.name} len v${res.value.version}.`;
        }
        if (action === 'history') {
          const history = blocks.history(id);
          if (history.length === 0) return `Block "${id}" khong co lich su.`;
          return [`Lich su block (${history.length} version):`, ...history.map((v) => `- v${v.version} ${v.updatedAt} boi ${v.updatedBy || '(?)'}: ${v.reason}`)].join('\n');
        }
        if (action === 'revert') {
          if (!botId) return errorResult('Can botId de revert block.');
          const version = getNumberArg(args, 'version');
          if (version === undefined) return errorResult('Can "version" (so version muon revert ve).');
          const res = blocks.revert(id, version, botId);
          if (!res.ok || !res.value) return errorResult(res.error ?? 'revert that bai.');
          persist();
          return `Da revert block ${res.value.name} ve v${version} (hien tai v${res.value.version}).`;
        }
        return errorResult(`action "${action}" khong hop le (create | list | get | attach | detach | lock | unlock | write | history | revert).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const sleepTool: Tool = {
    definition: toolDef(
      'memory_v24_sleep',
      'Chay sleep-time consolidation luc idle: decay confidence, merge trung lap, promote record hay duoc dung, quarantine lesson thieu evidence, giai phong khoa block het han. Co ngan sach ops — can duyet.',
      {
        maxOps: { type: 'number', description: 'So thao tac toi da moi pass (mac dinh 200).' },
        force: { type: 'boolean', description: 'Chay ngay ke ca khi chua idle (mac dinh true).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const maxOps = getNumberArg(args, 'maxOps');
        const force = getBoolArg(args, 'force', true);
        const report = pipeline.runSleep({
          ...(maxOps !== undefined ? { maxOps } : {}),
          force,
        });
        persist();
        const lines = [
          `Sleep v24: quet ${report.scanned} record — decay ${report.decayed}, merge ${report.merged}, promote ${report.promoted}, stale ${report.markedStale}, archive ${report.archived}, lesson quarantine ${report.lessonsQuarantined}, khoa giai phong ${report.locksReleased} (${report.durationMs}ms${report.budgetHit ? ', het ngan sach — pass sau lam tiep' : ''}).`,
        ];
        for (const action of report.actions.slice(0, 20)) lines.push(`- [${action.kind}] ${action.detail}`);
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const decayTool: Tool = {
    definition: toolDef(
      'memory_v24_decay',
      'Decay/forgetting: preview (xem fact/lesson nao se decay/stale/archive) hoac apply (ap dung decay that). KHONG xoa du lieu — archive chi doi status. Apply — can duyet.',
      {
        apply: { type: 'boolean', description: 'Ap dung that (mac dinh false = chi preview).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const apply = getBoolArg(args, 'apply', false);
        const nowMs = Date.now();
        const facts = store.listFacts({});
        const lessons = store.listLessons({});
        if (!apply) {
          const lines = ['Preview decay (khong ghi):'];
          let stale = 0;
          let archived = 0;
          for (const f of facts) {
            const res = applyDecayToFactV24(f, undefined, nowMs);
            if (res.outcome.action === 'stale') { stale++; lines.push(`- stale: ${f.id} ${f.subject} ${f.edge} ${f.object} (${res.outcome.detail})`); }
            if (res.outcome.action === 'archived' || res.outcome.action === 'expired') { archived++; lines.push(`- archive: ${f.id} ${f.subject} ${f.edge} ${f.object} (${res.outcome.detail})`); }
          }
          for (const l of lessons) {
            const res = applyDecayToLessonV24(l, undefined, nowMs);
            if (res.outcome.action === 'stale') { stale++; lines.push(`- stale: lesson ${l.id} "${l.title}" (${res.outcome.detail})`); }
            if (res.outcome.action === 'archived' || res.outcome.action === 'expired') { archived++; lines.push(`- archive: lesson ${l.id} "${l.title}" (${res.outcome.detail})`); }
          }
          lines.unshift(`Preview: ${facts.length} fact + ${lessons.length} lesson — ${stale} se stale, ${archived} se archive.`);
          return lines.join('\n');
        }
        const report = pipeline.runSleep({ maxOps: 1000, force: true });
        persist();
        return `Decay da ap dung: decay ${report.decayed}, stale ${report.markedStale}, archive ${report.archived} (sleep pass ${report.durationMs}ms).`;
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const admissionTool: Tool = {
    definition: toolDef(
      'memory_v24_admission',
      'Admission policy: screen 1 text truoc khi ghi (chan credential/injection/PII/spam) hoac xem admission log (allow/quarantine/deny). Read.',
      {
        action: { type: 'string', description: '"screen" | "log".' },
        text: { type: 'string', description: 'Text can screen (screen).' },
        limit: { type: 'number', description: 'So log toi da (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'log') {
          const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
          const entries = store.admission.listLog({ limit });
          if (entries.length === 0) return 'Admission log dang rong.';
          const counts = store.admission.counts();
          const lines = [`Admission log (${entries.length} muc gan nhat; allow ${counts.allow}, quarantine ${counts.quarantine}, deny ${counts.deny}):`];
          for (const e of entries) {
            lines.push(`- [${e.verdict} · risk ${e.riskScore.toFixed(2)} · ${e.screenedAt}] ${e.reasons.join(' ')} (preview: "${e.sourcePreview}")`);
          }
          return lines.join('\n');
        }
        if (action === 'screen') {
          const text = getStringArg(args, 'text');
          const scope = fullScope(scopeFromArgs(args, defaultScope));
          const decision = new V24AdmissionPolicy().screen({ text, scope, nowMs: Date.now() });
          return [
            `Admission: ${decision.verdict} (risk ${decision.riskScore.toFixed(2)}, policy ${decision.policyVersion}).`,
            ...decision.reasons.map((r) => `- ${r}`),
            `Rule kich hoat: ${decision.triggeredRules.join(', ') || '(khong co)'}`,
            `Scope gan luc ghi: user=${scope.userId || '-'} agent=${scope.agentId || '-'} run=${scope.runId || '-'}; het han: ${decision.expiresAt ?? '(khong het han)'}.`,
          ].join('\n');
        }
        return errorResult(`action "${action}" khong hop le (screen | log).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const conflictTool: Tool = {
    definition: toolDef(
      'memory_v24_conflict',
      'Liet ke conflict mo giua fact moi/cu (Graphiti-style) va resolve: supersede/merge/keep_both/reject_incoming/quarantine_both — kem provenance day du. Resolve — can duyet.',
      {
        action: { type: 'string', description: '"list" | "resolve".' },
        conflictId: { type: 'string', description: 'Id conflict (resolve).' },
        strategy: { type: 'string', description: '"supersede" | "merge" | "keep_both" | "reject_incoming" | "quarantine_both" (resolve; rong = auto).' },
        reason: { type: 'string', description: 'Ly do quyet dinh (resolve, bat buoc khi supersede/reject).' },
        limit: { type: 'number', description: 'So conflict toi da khi list (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
          const open = store.listConflicts({ openOnly: true, limit });
          if (open.length === 0) return 'Khong co conflict mo.';
          const lines = [`${open.length} conflict mo:`];
          for (const c of open) {
            lines.push(`- ${c.id} [${c.kind} · severity ${c.severity.toFixed(2)}]: ${c.explanation} (phat hien ${c.detectedAt})`);
          }
          return lines.join('\n');
        }
        if (action === 'resolve') {
          const conflictId = getStringArg(args, 'conflictId');
          const open = store.listConflicts({ openOnly: false });
          const conflict = open.find((c) => c.id === conflictId);
          if (!conflict) return errorResult(`Khong co conflict "${conflictId}".`);
          const existing = store.getFact(conflict.existingFactId);
          if (!existing) return errorResult(`Fact cu ${conflict.existingFactId} khong con.`);
          const strategyRaw = getOptionalStringArg(args, 'strategy');
          const validStrategies: V24ResolutionStrategy[] = ['supersede', 'merge', 'keep_both', 'reject_incoming', 'quarantine_both'];
          let strategy: V24ResolutionStrategy;
          let reason = getOptionalStringArg(args, 'reason');
          if (strategyRaw) {
            if (!validStrategies.includes(strategyRaw as V24ResolutionStrategy)) {
              return errorResult(`strategy "${strategyRaw}" khong hop le (${validStrategies.join(' | ')}).`);
            }
            strategy = strategyRaw as V24ResolutionStrategy;
            if ((strategy === 'supersede' || strategy === 'reject_incoming') && !reason) {
              return errorResult(`strategy "${strategy}" can "reason" (bat buoc).`);
            }
            reason = reason ?? `User resolve ${conflict.kind} -> ${strategy}.`;
          } else {
            const decided = decideResolutionV24(conflict, existing);
            strategy = decided.strategy;
            reason = decided.reason;
          }
          const scope = fullScope(scopeFromArgs(args, defaultScope));
          const applied = store.applyResolution(conflict, strategy, {
            scope,
            provenance: {
              episodeId: `resolve:${conflict.id}`,
              turnId: 'tool:memory_v24_conflict',
              runId: scope.runId,
              botId: scope.agentId,
              userId: scope.userId,
              sourceText: conflict.incoming.sourceText,
              method: 'resolver',
              extractor: 'v24-rule-v1',
              embeddingKind: 'hash',
            },
            decidedBy: 'user',
            reason,
          });
          if (!applied.ok || !applied.value) return errorResult(applied.error ?? 'resolve that bai.');
          persist();
          return `Da resolve conflict ${conflict.id} bang ${strategy}: ${reason}${applied.value.resultingFactId ? ` (fact moi ${applied.value.resultingFactId})` : ''}`;
        }
        return errorResult(`action "${action}" khong hop le (list | resolve).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const statsTool: Tool = {
    definition: toolDef(
      'memory_v24_stats',
      'Thong ke memory v24: fact/lesson/MemFS/block/conflict/admission + health + snapshot prompt (so ky tu). Read.',
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
          'Memory v24:',
          `- Fact: ${stats.factsTotal} tong (${stats.factsActive} active, confidence TB ${stats.avgConfidence}).`,
          `- Theo kind: ${Object.entries(stats.factsByKind).map(([k, v]) => `${k}=${v}`).join(', ') || '(rong)'}`,
          `- Theo status: ${Object.entries(stats.factsByStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '(rong)'}`,
          `- Lesson: ${stats.lessonsTotal} tong (${stats.lessonsActive} active, ${stats.lessonsQuarantined} quarantined, ${stats.lessonsWithEvidence} co evidence).`,
          `- MemFS: ${stats.memfsNodes} node (${stats.memfsDeleted} tombstone).`,
          `- Shared block: ${stats.sharedBlocks} (${stats.sharedBlocksLocked} dang khoa).`,
          `- Conflict mo: ${stats.conflictsOpen}; resolution: ${stats.resolutionsTotal}.`,
          `- Admission: allow ${stats.admissionAllowed}, quarantine ${stats.admissionQuarantined}, deny ${stats.admissionDenied}.`,
          `- Health: ${health.map((h) => `[${h.severity}] ${h.code}: ${h.detail}`).join(' | ')}`,
        ];
        const includeSnapshot = getBoolArg(args, 'includeSnapshot', false);
        if (includeSnapshot) {
          const scope = fullScope(scopeFromArgs(args, defaultScope));
          const budget = getNumberArg(args, 'budgetChars') ?? 8000;
          const snap = pipeline.snapshotForPrompt({ budgetChars: budget, scope });
          lines.push(`- Snapshot prompt: ${snap.chars}/${snap.budgetChars} ky tu — ${snap.tree.length} file MemFS, ${Object.keys(snap.nodes).length} node, ${snap.lessons.length} lesson, ${snap.facts.length} fact.`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    addTool,
    memfsTool,
    searchTool,
    lessonTool,
    blockTool,
    sleepTool,
    decayTool,
    admissionTool,
    conflictTool,
    statsTool,
  ];
}

/** Ten tool memory v24 (thu tu nhu createMemoryV24Tools tra ve). */
export const MEMORY_V24_TOOL_NAMES = [
  'memory_v24_add',
  'memory_v24_memfs',
  'memory_v24_search',
  'memory_v24_lesson',
  'memory_v24_block',
  'memory_v24_sleep',
  'memory_v24_decay',
  'memory_v24_admission',
  'memory_v24_conflict',
  'memory_v24_stats',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v24 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V24_TOOLS: Tool[] = createMemoryV24Tools();
