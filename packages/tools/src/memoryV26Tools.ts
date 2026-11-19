/**
 * Memory v26 tools for @open-bot/tools (v1.41, Doi T1).
 *
 * Agent lam viec voi memory v26 bang tool call:
 *  - memory_v26_registry  — tao/list/tim shared block trong registry (kind/owner/bot), tao tu template (ghi needsApproval: true)
 *  - memory_v26_block     — ghi/append/replace/read/attach/detach/transfer/readonly/revert/history (ghi needsApproval: true)
 *  - memory_v26_conflict  — list/get/resolve/reopen xung dot 2 agent sua cung block (ghi needsApproval: true)
 *  - memory_v26_audit     — audit log: ai sua, khi nao, version cu/moi, noi dung cu/moi (read)
 *  - memory_v26_budget    — dat/xem trang thai budget token moi block (sua needsApproval: true)
 *  - memory_v26_curate    — tom tat trich xuat 1 doan text + curate block vuot budget (ghi needsApproval: true)
 *  - memory_v26_archival  — them/list/search/prune kho luu tru theo ngay + noi dung (ghi needsApproval: true, search read)
 *  - memory_v26_recall    — recall memory theo ngay + ghi turn hoi thoai (ghi needsApproval: true)
 *  - memory_v26_template  — list/get/dang ky/xoa template block, khoi tao value (ghi needsApproval: true)
 *  - memory_v26_stats     — thong ke + health + quota + export/import block + snapshot prompt co budget (read; import needsApproval: true)
 *
 * SAFETY: ghi block kem expectedVersion — version lech thi ghi bi
 * tu choi + tao conflict, KHONG ghi de lang le; audit append-only;
 * archive khong xoa (chi prune khi goi ro rang); curate luu tru
 * version cu + phan bi loai truoc khi ghi; khong goi model chat,
 * khong goi API ngoai — summarise la trich xuat noi bo, token la
 * estimate (ky tu / 4).
 *
 * Factory:
 *   createMemoryV26Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V26_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  V26Pipeline,
  V26Store,
  loadV26StoreFromDir,
  makeV25Scope,
  type V26ArchiveKind,
  type V26BlockKind,
  type V26ConflictResolution,
  type V25Scope,
} from '@open-bot/core';

export interface MemoryV26ToolOptions {
  store?: V26Store;
  pipeline?: V26Pipeline;
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

function describeBlockV26(block: { id: string; label: string; value: string; version: number; ownerBotId: string; attachedBotIds: string[]; readOnly: boolean; updatedAt: string }): string {
  return [
    `Block "${block.label}" (${block.id}) v${block.version} — owner ${block.ownerBotId}, attach: ${block.attachedBotIds.join(', ') || '(khong co)'}${block.readOnly ? ', READ-ONLY' : ''}, cap nhat ${block.updatedAt}.`,
    block.value,
  ].join('\n');
}

export function createMemoryV26Tools(opts: MemoryV26ToolOptions = {}): Tool[] {
  const loadedStore = opts.workspaceDir ? loadV26StoreFromDir(opts.workspaceDir) : null;
  const store = opts.store ??
    (loadedStore && loadedStore.ok ? loadedStore.value : new V26Store());
  const pipeline = opts.pipeline ?? new V26Pipeline(store);
  const defaultScope: Partial<V25Scope> = opts.scope ?? {};
  const defaultBotId = opts.botId;

  const persist = (): void => {
    if (opts.workspaceDir) store.saveToDir(opts.workspaceDir);
  };

  const callerBot = (args: Record<string, unknown>): string =>
    getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '';

  // -- registry ---------------------------------------------------------------

  const registryTool: Tool = {
    definition: toolDef(
      'memory_v26_registry',
      'Registry shared block v26: tao block moi (co the tu template human/persona/task/project), liet ke block theo kind/owner/bot (1 bot cap nhat thi bot khac thay ngay), xem 1 block. Tao block ghi du lieu — can approval.',
      {
        action: { type: 'string', description: '"create" | "create-from-template" | "list" | "get" | "visible".' },
        label: { type: 'string', description: 'Label block (create / get theo label).' },
        id: { type: 'string', description: 'Id block (get).' },
        templateId: { type: 'string', description: 'Id template (create-from-template): human | persona | task | project | template tu tao.' },
        kind: { type: 'string', description: 'Loai block: human | persona | task | project | custom.' },
        value: { type: 'string', description: 'Gia tri khoi tao (create).' },
        description: { type: 'string', description: 'Mo ta block (tuy chon).' },
        ownerBotId: { type: 'string', description: 'Bot so huu (mac dinh bot goi tool).' },
        attachBotIds: { type: 'array', items: { type: 'string' }, description: 'Bot attach ngay khi tao (tuy chon).' },
        readOnly: { type: 'boolean', description: 'Danh dau read-only (mac dinh false).' },
        tokenBudget: { type: 'number', description: 'Gioi han token (0 = khong gioi han).' },
        botId: { type: 'string', description: 'Bot dang hoi (list/visible, mac dinh bot goi tool).' },
        labelContains: { type: 'string', description: 'Loc label chua chuoi nay (list).' },
        hasOpenConflict: { type: 'boolean', description: 'Chi block co xung dot mo (list).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        const scope = makeV25Scope(scopeFromArgs(args, defaultScope));
        if (action === 'list' || action === 'visible') {
          const botId = callerBot(args);
          const entries = store.registry.list({
            scope,
            ...(botId ? { botId } : {}),
            ...(getOptionalStringArg(args, 'kind') ? { kind: getOptionalStringArg(args, 'kind') as V26BlockKind } : {}),
            ...(getOptionalStringArg(args, 'ownerBotId') ? { ownerBotId: getOptionalStringArg(args, 'ownerBotId') } : {}),
            ...(getOptionalStringArg(args, 'labelContains') ? { labelContains: getOptionalStringArg(args, 'labelContains') } : {}),
            ...(args.hasOpenConflict !== undefined ? { hasOpenConflict: getBoolArg(args, 'hasOpenConflict', false) } : {}),
            limit,
          });
          if (entries.length === 0) return 'Registry dang rong (theo bo loc).';
          return [
            `${entries.length} block trong registry:`,
            ...entries.map((e) => {
              const block = store.registry.blocks.get(e.blockId);
              const tokens = block ? pipeline.estimateTokens(block.value) : 0;
              return `- ${e.label} [${e.kind}] (${e.blockId}) v${block?.version ?? '?'} — owner ${e.ownerBotId}, attach ${e.attachedBotIds.length} bot, ~${tokens} token (budget ${e.tokenBudget || 'khong gioi han'})${e.hasOpenConflict ? ' — CO XUNG DOT MO' : ''}`;
            }),
          ].join('\n');
        }
        if (action === 'get') {
          const id = getOptionalStringArg(args, 'id');
          const label = getOptionalStringArg(args, 'label');
          let block = id ? store.registry.blocks.get(id) : undefined;
          if (!block && label) block = store.registry.blocks.getByLabel(label, scope);
          if (!block) return errorResult(`Khong tim thay block "${id ?? label}".`);
          const entry = store.registry.getEntry(block.id);
          return [
            describeBlockV26(block),
            entry ? `Registry: kind=${entry.kind}, template=${entry.templateId || '(khong co)'}, tokenBudget=${entry.tokenBudget}, updateCount=${entry.updateCount}, hasOpenConflict=${entry.hasOpenConflict}` : '',
          ].filter(Boolean).join('\n');
        }
        if (action === 'create') {
          const botId = getOptionalStringArg(args, 'ownerBotId') ?? callerBot(args);
          if (!botId) return errorResult('Can ownerBotId (hoac cau hinh botId khi tao tool).');
          const res = pipeline.createBlock(
            {
              label: getStringArg(args, 'label'),
              description: getOptionalStringArg(args, 'description') ?? '',
              value: getStringArg(args, 'value'),
              ownerBotId: botId,
              kind: (getOptionalStringArg(args, 'kind') ?? 'custom') as V26BlockKind,
              scope,
              readOnly: getBoolArg(args, 'readOnly', false),
              attachBotIds: getStringListArg(args, 'attachBotIds') ?? [],
              tokenBudget: getNumberArg(args, 'tokenBudget') ?? 0,
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da tao block "${res.value.block.label}" (${res.value.block.id}) v1 — kind ${res.value.entry.kind}, owner ${botId}${res.value.warning ? `\nCanh bao: ${res.value.warning}` : ''}.`;
        }
        if (action === 'create-from-template') {
          const botId = getOptionalStringArg(args, 'ownerBotId') ?? callerBot(args);
          if (!botId) return errorResult('Can ownerBotId (hoac cau hinh botId khi tao tool).');
          const res = pipeline.createBlockFromTemplate(
            getStringArg(args, 'templateId'),
            {
              label: getStringArg(args, 'label'),
              ownerBotId: botId,
              description: getOptionalStringArg(args, 'description'),
              scope,
              attachBotIds: getStringListArg(args, 'attachBotIds') ?? [],
              readOnly: getBoolArg(args, 'readOnly', false),
              tokenBudget: getNumberArg(args, 'tokenBudget'),
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da tao block "${res.value.block.label}" (${res.value.block.id}) tu template "${getStringArg(args, 'templateId')}" — kind ${res.value.entry.kind}, budget goi y ${res.value.entry.tokenBudget} token${res.value.missingRequired.length > 0 ? `\nTruong bat buoc con thieu trong value khoi tao: ${res.value.missingRequired.join(', ')} (dien sau bang memory_v26_block write).` : ''}${res.value.warning ? `\nCanh bao: ${res.value.warning}` : ''}.`;
        }
        return errorResult(`action "${action}" khong hop le (create | create-from-template | list | get | visible).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- block -------------------------------------------------------------------

  const blockTool: Tool = {
    definition: toolDef(
      'memory_v26_block',
      'Lam viec voi shared block v26: read/write/append/replace, attach/detach, transfer ownership, bat/tat read-only, revert version, xem lich su version. Ghi kem expectedVersion: version lech thi bi tu choi + tao conflict (khong ghi de). Ghi can approval.',
      {
        action: { type: 'string', description: '"read" | "write" | "append" | "replace" | "attach" | "detach" | "transfer" | "readonly" | "revert" | "history".' },
        id: { type: 'string', description: 'Id block (hoac label neu co label).' },
        label: { type: 'string', description: 'Label block (thay cho id).' },
        value: { type: 'string', description: 'Gia tri moi (write) hoac text chen them (append).' },
        oldText: { type: 'string', description: 'Doan can thay (replace).' },
        newText: { type: 'string', description: 'Doan thay the (replace).' },
        botId: { type: 'string', description: 'Bot thuc hien / bot attach-detach (mac dinh bot goi tool).' },
        toBotId: { type: 'string', description: 'Bot nhan ownership (transfer).' },
        fromBotId: { type: 'string', description: 'Owner cu (transfer).' },
        readOnly: { type: 'boolean', description: 'Gia tri read-only moi (readonly).' },
        version: { type: 'number', description: 'Version dich (revert) hoac version da doc (expectedVersion).' },
        expectedVersion: { type: 'number', description: 'Version agent da doc — lech thi tao conflict, khong ghi.' },
        baseValue: { type: 'string', description: 'Gia tri agent da doc (ghi vao conflict neu lech).' },
        reason: { type: 'string', description: 'Ly do ghi (ghi vao audit).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = makeV25Scope(scopeFromArgs(args, defaultScope));
        const resolveId = (): string | undefined => {
          const id = getOptionalStringArg(args, 'id');
          if (id) return id;
          const label = getOptionalStringArg(args, 'label');
          if (label) return store.registry.blocks.getByLabel(label, scope)?.id;
          return undefined;
        };
        const botId = callerBot(args);
        if (action === 'history') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          const history = store.registry.blocks.history(id);
          if (!history.ok) return errorResult(history.error);
          if (history.value.length === 0) return `Block "${id}" khong co lich su.`;
          return [`Lich su block ${id} (${history.value.length} version):`, ...history.value.map((v) => `- v${v.version} ${v.updatedAt} boi ${v.updatedBy || '(?)'}: ${v.reason}`)].join('\n');
        }
        if (action === 'read') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          if (!botId) return errorResult('Can botId de kiem tra quyen doc.');
          const res = store.registry.readForBot(id, botId);
          if (!res.ok) return errorResult(res.error);
          return describeBlockV26(res.value);
        }
        if (action === 'attach' || action === 'detach') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          const target = getStringArg(args, 'botId');
          const res = action === 'attach'
            ? store.registry.attach(id, target, botId || target)
            : store.registry.detach(id, target, botId || target);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da ${action === 'attach' ? 'attach' : 'detach'} bot "${target}" ${action === 'attach' ? 'vao' : 'khoi'} block "${res.value.label}" (hien attach ${res.value.attachedBotIds.length} bot).`;
        }
        if (action === 'transfer') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          const from = getStringArg(args, 'fromBotId');
          const to = getStringArg(args, 'toBotId');
          const res = store.registry.transferOwnership(id, from, to);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da chuyen ownership block "${res.value.label}" tu "${from}" sang "${to}".`;
        }
        if (action === 'readonly') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          const ro = getBoolArg(args, 'readOnly', true);
          const res = store.registry.setReadOnly(id, ro, botId);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Block "${res.value.label}" hien ${ro ? 'READ-ONLY (bot khac owner chi doc)' : 'ghi duoc cho bot da attach'}.`;
        }
        if (action === 'revert') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          if (!botId) return errorResult('Can botId.');
          const version = getNumberArg(args, 'version');
          if (version === undefined) return errorResult('Can version de revert.');
          const res = store.registry.revert(id, version, botId, { reason: getOptionalStringArg(args, 'reason') });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da revert block "${res.value.block.label}" ve version ${version} (hien v${res.value.block.version}).`;
        }
        if (action === 'write' || action === 'append' || action === 'replace') {
          const id = resolveId();
          if (!id) return errorResult('Can id hoac label cua block.');
          if (!botId) return errorResult('Can botId.');
          const expectedVersion = getNumberArg(args, 'expectedVersion');
          const baseValue = getOptionalStringArg(args, 'baseValue');
          const reason = getOptionalStringArg(args, 'reason');
          if (action === 'write') {
            const res = pipeline.writeBlock(id, getStringArg(args, 'value'), botId, {
              reason,
              ...(expectedVersion !== undefined ? { expectedVersion } : {}),
              ...(baseValue !== undefined ? { baseValue } : {}),
            });
            if (!res.ok) return errorResult(res.error);
            persist();
            return `Da ghi block "${res.value.block.label}" -> v${res.value.block.version} (~${pipeline.estimateTokens(res.value.block.value)} token)${res.value.curated ? `\nTu curate vi vuot budget: tiet kiem ${res.value.curated.tokensSaved} token (v${res.value.curated.fromVersion} -> v${res.value.curated.toVersion}).` : ''}`;
          }
          if (action === 'append') {
            const block = store.registry.blocks.get(id);
            if (!block) return errorResult(`Khong co block "${id}".`);
            const res = pipeline.writeBlock(id, `${block.value}\n${getStringArg(args, 'value')}`, botId, {
              reason: reason ?? 'append',
              ...(expectedVersion !== undefined ? { expectedVersion } : {}),
              ...(baseValue !== undefined ? { baseValue } : {}),
            });
            if (!res.ok) return errorResult(res.error);
            persist();
            return `Da append vao block "${res.value.block.label}" -> v${res.value.block.version}.`;
          }
          const block = store.registry.blocks.get(id);
          if (!block) return errorResult(`Khong co block "${id}".`);
          const oldText = getStringArg(args, 'oldText');
          const newText = getStringArg(args, 'newText');
          if (!block.value.includes(oldText)) return errorResult(`Block "${block.label}" khong chua doan can thay.`);
          const res = pipeline.writeBlock(id, block.value.replace(oldText, newText), botId, {
            reason: reason ?? 'replace',
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
            ...(baseValue !== undefined ? { baseValue } : {}),
          });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da replace trong block "${res.value.block.label}" -> v${res.value.block.version}.`;
        }
        return errorResult(`action "${action}" khong hop le (read | write | append | replace | attach | detach | transfer | readonly | revert | history).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- conflict ------------------------------------------------------------------

  const conflictTool: Tool = {
    definition: toolDef(
      'memory_v26_conflict',
      'Xung dot shared block v26: khi 2 agent sua cung block dua tren cung version, ghi sau bi tu choi + tao conflict (base/current/incoming). Xem list, xem chi tiet, giai quyet keep-current / keep-incoming / merge-lines / manual, mo lai. Giai quyet ghi du lieu — can approval.',
      {
        action: { type: 'string', description: '"list" | "get" | "resolve" | "reopen".' },
        id: { type: 'string', description: 'Id conflict (get/resolve/reopen).' },
        blockId: { type: 'string', description: 'Loc theo block (list).' },
        status: { type: 'string', description: '"open" | "resolved" (list).' },
        resolution: { type: 'string', description: '"keep-current" | "keep-incoming" | "merge-lines" | "manual" (resolve).' },
        manualValue: { type: 'string', description: 'Gia tri cuoi (resolve manual).' },
        botId: { type: 'string', description: 'Bot giai quyet (mac dinh bot goi tool).' },
        note: { type: 'string', description: 'Ghi chu khi giai quyet.' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'list') {
          const list = store.conflicts.list({
            ...(getOptionalStringArg(args, 'blockId') ? { blockId: getOptionalStringArg(args, 'blockId') } : {}),
            ...(getOptionalStringArg(args, 'status') === 'open' || getOptionalStringArg(args, 'status') === 'resolved'
              ? { status: getOptionalStringArg(args, 'status') as 'open' | 'resolved' }
              : {}),
            limit,
          });
          if (list.length === 0) return 'Khong co xung dot nao (theo bo loc).';
          return [
            `${list.length} xung dot:`,
            ...list.map((c) => `- ${c.id} [${c.status}] block "${c.label}": base v${c.baseVersion} -> current v${c.currentVersion} (boi ${c.currentBy}), incoming boi ${c.by} (${c.detectedAt})${c.status === 'resolved' ? ` — resolved ${c.resolution} boi ${c.resolvedBy} -> v${c.resolvedVersion}` : ''}`),
          ].join('\n');
        }
        if (action === 'get') {
          const c = store.conflicts.get(getStringArg(args, 'id'));
          if (!c) return errorResult(`Khong co conflict "${getStringArg(args, 'id')}".`);
          return [
            `Conflict ${c.id} [${c.status}] — block "${c.label}" (${c.blockId}).`,
            `Base v${c.baseVersion} (luc ${c.by} doc):`,
            c.baseValue,
            `Current v${c.currentVersion} (boi ${c.currentBy}):`,
            c.currentValue,
            `Incoming (boi ${c.by}, dinh ghi):`,
            c.incomingValue,
            c.status === 'resolved' ? `Da giai quyet: ${c.resolution} boi ${c.resolvedBy} (${c.resolvedAt}) -> v${c.resolvedVersion}. ${c.resolutionNote}` : 'Chua giai quyet — dung resolve (keep-current / keep-incoming / merge-lines / manual).',
          ].join('\n');
        }
        if (action === 'resolve') {
          const botId = callerBot(args);
          if (!botId) return errorResult('Can botId.');
          const res = pipeline.resolveConflict(
            getStringArg(args, 'id'),
            getStringArg(args, 'resolution') as V26ConflictResolution,
            botId,
            {
              manualValue: getOptionalStringArg(args, 'manualValue'),
              note: getOptionalStringArg(args, 'note'),
            },
          );
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da giai quyet conflict ${res.value.conflict.id} (${getStringArg(args, 'resolution')})${res.value.block ? ` — block "${res.value.block.label}" hien v${res.value.block.version}` : ' — giu nguyen block hien tai'}${res.value.mergeLines > 0 ? ` (${res.value.mergeLines} cap dong xung dot, dong incoming co danh dau "<< incoming").` : '.'}`;
        }
        if (action === 'reopen') {
          const botId = callerBot(args);
          const res = store.conflicts.reopen(getStringArg(args, 'id'), botId || 'user', { note: getOptionalStringArg(args, 'note') });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da mo lai conflict ${res.value.id} (status open).`;
        }
        return errorResult(`action "${action}" khong hop le (list | get | resolve | reopen).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- audit ---------------------------------------------------------------------

  const auditTool: Tool = {
    definition: toolDef(
      'memory_v26_audit',
      'Audit log memory v26 (append-only): ai sua block, khi nao, version cu -> moi, noi dung cu/moi. Loc theo block/label/bot/hanh dong/ngay. Read — khong ghi gi.',
      {
        blockId: { type: 'string', description: 'Loc theo block.' },
        label: { type: 'string', description: 'Loc theo label.' },
        by: { type: 'string', description: 'Loc theo bot/user.' },
        action: { type: 'string', description: 'Loc theo hanh dong (created/write/append/replace/curate/revert/attach/detach/transfer/readonly/budget/template/conflict/resolved/archived/imported).' },
        fromDay: { type: 'string', description: 'Tu ngay YYYY-MM-DD.' },
        toDay: { type: 'string', description: 'Den ngay YYYY-MM-DD.' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        const entries = store.registry.listAudit({
          ...(getOptionalStringArg(args, 'blockId') ? { blockId: getOptionalStringArg(args, 'blockId') } : {}),
          ...(getOptionalStringArg(args, 'label') ? { label: getOptionalStringArg(args, 'label') } : {}),
          ...(getOptionalStringArg(args, 'by') ? { by: getOptionalStringArg(args, 'by') } : {}),
          ...(getOptionalStringArg(args, 'action') ? { action: getOptionalStringArg(args, 'action') as never } : {}),
          ...(getOptionalStringArg(args, 'fromDay') ? { fromDay: getOptionalStringArg(args, 'fromDay') } : {}),
          ...(getOptionalStringArg(args, 'toDay') ? { toDay: getOptionalStringArg(args, 'toDay') } : {}),
          limit,
        });
        if (entries.length === 0) return 'Audit log dang rong (theo bo loc).';
        return [
          `${entries.length} muc audit gan nhat:`,
          ...entries.map((e) => `- [${e.action} · ${e.at}] block "${e.label}" v${e.fromVersion} -> v${e.toVersion} boi ${e.by}: ${e.reason}`),
        ].join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- budget ----------------------------------------------------------------------

  const budgetTool: Tool = {
    definition: toolDef(
      'memory_v26_budget',
      'Budget token block v26: dat budget (maxTokens, warnRatio, onExceed curate/warn, curateTargetTokens), xem trang thai budget 1 block hoac tat ca (ok/warn/over, token estimate). Sua budget can approval.',
      {
        action: { type: 'string', description: '"set" | "get" | "status" | "all".' },
        id: { type: 'string', description: 'Id block (hoac label neu co label).' },
        label: { type: 'string', description: 'Label block (thay cho id).' },
        maxTokens: { type: 'number', description: 'Gioi han token (0 = khong gioi han).' },
        warnRatio: { type: 'number', description: 'Ti le canh bao 0..1 (mac dinh 0.8).' },
        onExceed: { type: 'string', description: '"curate" | "warn".' },
        curateTargetTokens: { type: 'number', description: 'Token dich khi curate.' },
        botId: { type: 'string', description: 'Bot dat budget (mac dinh bot goi tool).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const scope = makeV25Scope(scopeFromArgs(args, defaultScope));
        const resolveId = (): string | undefined => {
          const id = getOptionalStringArg(args, 'id');
          if (id) return id;
          const label = getOptionalStringArg(args, 'label');
          if (label) return store.registry.blocks.getByLabel(label, scope)?.id;
          return undefined;
        };
        if (action === 'all') {
          const statuses = store.budgets.statuses(store.listBlocks().map((b) => ({ id: b.id, label: b.label, value: b.value })));
          if (statuses.length === 0) return 'Chua co block nao.';
          return [
            `${statuses.length} block — trang thai budget (token = estimate ky tu/4):`,
            ...statuses.map((s) => `- ${s.label}: ${s.tokens}/${s.maxTokens || '∞'} token (${s.status})${s.needsCurate ? ' — CAN CURATE' : ''}`),
          ].join('\n');
        }
        const id = resolveId();
        if (!id) return errorResult('Can id hoac label cua block.');
        const block = store.registry.blocks.get(id);
        if (!block) return errorResult(`Khong co block "${id}".`);
        if (action === 'set') {
          const maxTokens = getNumberArg(args, 'maxTokens');
          if (maxTokens === undefined) return errorResult('Can maxTokens.');
          const existing = store.budgets.getBudget(id);
          const res = store.budgets.setBudget({
            blockId: id,
            label: block.label,
            maxTokens,
            warnRatio: getNumberArg(args, 'warnRatio') ?? existing?.warnRatio ?? 0.8,
            onExceed: (getOptionalStringArg(args, 'onExceed') ?? existing?.onExceed ?? 'warn') as 'curate' | 'warn',
            curateTargetTokens: getNumberArg(args, 'curateTargetTokens') ?? existing?.curateTargetTokens ?? Math.max(50, Math.floor(maxTokens * 0.6) || 1000),
          });
          if (!res.ok) return errorResult(res.error);
          store.registry.setTokenBudget(id, maxTokens, callerBot(args) || 'user');
          persist();
          return `Da dat budget block "${block.label}": max ${maxTokens} token, warn o ${Math.round(res.value.warnRatio * 100)}%, vuot thi ${res.value.onExceed} (curate ve ${res.value.curateTargetTokens} token).`;
        }
        if (action === 'get' || action === 'status') {
          const st = store.budgets.status(id, block.label, block.value);
          const budget = store.budgets.getBudget(id);
          return `Block "${block.label}": ${st.tokens} token hien tai / ${st.maxTokens || 'khong gioi han'} — status ${st.status} (dung ${Math.round(st.usageRatio * 100)}%)${st.overByTokens > 0 ? `, vuot ${st.overByTokens} token` : ''}${budget ? `; onExceed=${budget.onExceed}, curate ve ${budget.curateTargetTokens} token` : '; chua dat budget'}.`;
        }
        return errorResult(`action "${action}" khong hop le (set | get | status | all).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- curate ----------------------------------------------------------------------

  const curateTool: Tool = {
    definition: toolDef(
      'memory_v26_curate',
      'Curate memory v26: tom tat trich xuat 1 doan text (preview, khong ghi) hoac curate 1 block vuot budget — tom tat ve token dich, luu tru version cu + phan bi loai truoc khi ghi. Ghi can approval.',
      {
        action: { type: 'string', description: '"preview" | "curate".' },
        id: { type: 'string', description: 'Id block (curate; hoac label neu co label).' },
        label: { type: 'string', description: 'Label block (thay cho id).' },
        text: { type: 'string', description: 'Text can tom tat (preview).' },
        targetTokens: { type: 'number', description: 'Token dich (preview, mac dinh 500).' },
        botId: { type: 'string', description: 'Bot curate (mac dinh bot goi tool).' },
        reason: { type: 'string', description: 'Ly do curate.' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'preview') {
          const text = getStringArg(args, 'text');
          const target = getNumberArg(args, 'targetTokens') ?? 500;
          const summary = pipeline.summariseText(text, target);
          return [
            `Tom tat trich xuat: ${summary.originalTokens} -> ${summary.summaryTokens} token (giu ${summary.itemsKept}/${summary.itemsTotal} y).`,
            summary.summary || '(rong — text goc rong hoac target qua nho)',
            summary.keptHeadings.length > 0 ? `Heading giu lai: ${summary.keptHeadings.join(' | ')}` : '',
          ].filter(Boolean).join('\n');
        }
        if (action === 'curate') {
          const scope = makeV25Scope(scopeFromArgs(args, defaultScope));
          const id = getOptionalStringArg(args, 'id')
            ?? (getOptionalStringArg(args, 'label') ? store.registry.blocks.getByLabel(getOptionalStringArg(args, 'label') as string, scope)?.id : undefined);
          if (!id) return errorResult('Can id hoac label cua block.');
          const botId = callerBot(args);
          if (!botId) return errorResult('Can botId.');
          const res = store.curateBlock(id, botId, { reason: getOptionalStringArg(args, 'reason') });
          if (!res.ok) return errorResult(res.error);
          persist();
          const r = res.value;
          if (!r.applied) return `Block "${r.label}" khong can curate: ${r.reason}.`;
          return `Da curate block "${r.label}": v${r.fromVersion} -> v${r.toVersion}, ${r.originalTokens} -> ${r.summaryTokens} token (tiet kiem ${r.tokensSaved}), giu ${r.itemsKept}/${r.itemsTotal} y. Version cu + phan bi loai da luu vao archival.`;
        }
        return errorResult(`action "${action}" khong hop le (preview | curate).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- archival ----------------------------------------------------------------------

  const archivalTool: Tool = {
    definition: toolDef(
      'memory_v26_archival',
      'Kho luu tru memory v26: them muc luu tru (block-version/fact/turn/note), liet ke, search theo ngay + noi dung, xoa muc cu hon N ngay (prune, goi ro rang moi xoa). Search la read, them/prune can approval.',
      {
        action: { type: 'string', description: '"add" | "list" | "search" | "prune" | "days".' },
        kind: { type: 'string', description: 'Loai muc: block-version | fact | turn | note | curated-out.' },
        content: { type: 'string', description: 'Noi dung luu tru (add).' },
        sourceBlockId: { type: 'string', description: 'Block nguon.' },
        sourceLabel: { type: 'string', description: 'Label block nguon.' },
        query: { type: 'string', description: 'Tu khoa search.' },
        fromDay: { type: 'string', description: 'Tu ngay YYYY-MM-DD.' },
        toDay: { type: 'string', description: 'Den ngay YYYY-MM-DD.' },
        tag: { type: 'string', description: 'Loc theo tag.' },
        by: { type: 'string', description: 'Bot/user tao muc.' },
        at: { type: 'string', description: 'Thoi diem ISO cua muc (add); mac dinh bay gio. Dung de backfill ngay cu.' },
        days: { type: 'number', description: 'Prune muc cu hon N ngay.' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const limit = Math.min(100, Math.max(1, getNumberArg(args, 'limit') ?? 20));
        if (action === 'days') {
          const days = store.archive.daysWithEntries();
          if (days.length === 0) return 'Kho luu tru dang rong.';
          return `Cac ngay co muc luu tru (${days.length} ngay): ${days.join(', ')}.`;
        }
        if (action === 'add') {
          const res = store.archive.add({
            kind: (getStringArg(args, 'kind') as V26ArchiveKind),
            content: getStringArg(args, 'content'),
            ...(getOptionalStringArg(args, 'at') ? { at: getOptionalStringArg(args, 'at') as string } : {}),
            sourceBlockId: getOptionalStringArg(args, 'sourceBlockId'),
            sourceLabel: getOptionalStringArg(args, 'sourceLabel'),
            tags: getStringListArg(args, 'tag') ?? (getOptionalStringArg(args, 'tag') ? [getOptionalStringArg(args, 'tag') as string] : []),
            by: getOptionalStringArg(args, 'by') ?? callerBot(args),
          });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da luu tru muc ${res.value.id} (${res.value.kind}, ngay ${res.value.dayKey}).`;
        }
        if (action === 'list') {
          const list = store.archive.list({
            ...(getOptionalStringArg(args, 'kind') ? { kind: getOptionalStringArg(args, 'kind') as V26ArchiveKind } : {}),
            ...(getOptionalStringArg(args, 'sourceBlockId') ? { sourceBlockId: getOptionalStringArg(args, 'sourceBlockId') } : {}),
            ...(getOptionalStringArg(args, 'sourceLabel') ? { sourceLabel: getOptionalStringArg(args, 'sourceLabel') } : {}),
            limit,
          });
          if (list.length === 0) return 'Kho luu tru dang rong (theo bo loc).';
          return [
            `${list.length} muc luu tru gan nhat:`,
            ...list.map((e) => `- ${e.id} [${e.kind} · ${e.dayKey}] ${e.sourceLabel || '(khong gan block)'}: ${e.content.slice(0, 120)}${e.content.length > 120 ? '...' : ''}`),
          ].join('\n');
        }
        if (action === 'search') {
          const hits = store.archive.search({
            query: getOptionalStringArg(args, 'query'),
            fromDay: getOptionalStringArg(args, 'fromDay'),
            toDay: getOptionalStringArg(args, 'toDay'),
            kind: getOptionalStringArg(args, 'kind') as V26ArchiveKind | undefined,
            sourceBlockId: getOptionalStringArg(args, 'sourceBlockId'),
            sourceLabel: getOptionalStringArg(args, 'sourceLabel'),
            tag: getOptionalStringArg(args, 'tag'),
            by: getOptionalStringArg(args, 'by'),
            limit,
          });
          if (hits.length === 0) return 'Khong tim thay muc luu tru nao (theo bo loc).';
          return [
            `${hits.length} ket qua search archival:`,
            ...hits.map((h) => `- [diem ${h.score} · ${h.entry.dayKey} · ${h.entry.kind}] ${h.entry.sourceLabel || '(khong gan block)'}: ${h.entry.content.slice(0, 150)}${h.entry.content.length > 150 ? '...' : ''} (${h.explanation})`),
          ].join('\n');
        }
        if (action === 'prune') {
          const days = getNumberArg(args, 'days');
          if (days === undefined) return errorResult('Can days (prune muc cu hon N ngay).');
          const res = store.archive.pruneOlderThan(days);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da prune ${res.value.pruned} muc cu hon ${days} ngay (con ${res.value.kept} muc).`;
        }
        return errorResult(`action "${action}" khong hop le (add | list | search | prune | days).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- recall --------------------------------------------------------------------------

  const recallTool: Tool = {
    definition: toolDef(
      'memory_v26_recall',
      'Recall memory v26: xem ngay X da co gi (turn hoi thoai, version block, fact) + ngay ke truoc/sau co muc; ghi turn hoi thoai vao recall memory. Ghi turn can approval, xem ngay la read.',
      {
        action: { type: 'string', description: '"day" | "add-turns".' },
        day: { type: 'string', description: 'Ngay YYYY-MM-DD (day).' },
        turns: { type: 'array', items: { type: 'object' }, description: 'Danh sach turn {role, text, at} (add-turns).' },
        by: { type: 'string', description: 'Bot/user ghi turn.' },
        sourceLabel: { type: 'string', description: 'Nhan nguon cua turn.' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'day') {
          const day = getStringArg(args, 'day');
          const res = pipeline.recallForDate(day, { limit: getNumberArg(args, 'limit') ?? 20 });
          if (!res.ok) return errorResult(res.error);
          const r = res.value;
          if (r.total === 0) return `${r.summary}.`;
          return [
            r.summary,
            ...r.entries.map((e) => `- [${e.kind} · ${e.at}] ${e.sourceLabel || '(recall)'}: ${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`),
          ].join('\n');
        }
        if (action === 'add-turns') {
          const rawTurns = args.turns;
          if (!Array.isArray(rawTurns)) return errorResult('Can turns la danh sach {role, text, at}.');
          const turns = rawTurns as Array<{ role: string; text: string; at: string }>;
          const res = pipeline.addRecallTurns(turns, {
            by: getOptionalStringArg(args, 'by') ?? callerBot(args),
            sourceLabel: getOptionalStringArg(args, 'sourceLabel'),
          });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da ghi ${res.value.added} turn vao recall memory (${res.value.skipped} turn rong/bo qua).`;
        }
        return errorResult(`action "${action}" khong hop le (day | add-turns).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- template --------------------------------------------------------------------------

  const templateTool: Tool = {
    definition: toolDef(
      'memory_v26_template',
      'Template block v26: list template co san (human/persona/task/project + tu tao), xem chi tiet, khoi tao value tu template, dang ky template tu tao, xoa template tu tao (built-in khong xoa duoc). Dang ky/xoa can approval.',
      {
        action: { type: 'string', description: '"list" | "get" | "instantiate" | "register" | "remove".' },
        id: { type: 'string', description: 'Id template.' },
        kind: { type: 'string', description: 'Loai block template tao ra (register): human | persona | task | project | custom.' },
        name: { type: 'string', description: 'Ten hien thi (register).' },
        description: { type: 'string', description: 'Mo ta (register).' },
        requiredFields: { type: 'array', items: { type: 'string' }, description: 'Truong bat buoc (register).' },
        optionalFields: { type: 'array', items: { type: 'string' }, description: 'Truong tuy chon (register).' },
        defaultValue: { type: 'string', description: 'Gia tri mau (register).' },
        suggestedBudgetTokens: { type: 'number', description: 'Budget goi y (register).' },
        values: { type: 'object', description: 'Gia tri thay placeholder {{Field}} (instantiate).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const list = store.templates.list({
            ...(getOptionalStringArg(args, 'kind') ? { kind: getOptionalStringArg(args, 'kind') as V26BlockKind } : {}),
          });
          return [
            `${list.length} template:`,
            ...list.map((t) => `- ${t.id} [${t.kind}] ${t.name}${t.builtin ? ' (built-in)' : ''} — truong bat buoc: ${t.requiredFields.join(', ') || '(khong co)'}; budget goi y ${t.suggestedBudgetTokens} token`),
          ].join('\n');
        }
        if (action === 'get') {
          const t = store.templates.get(getStringArg(args, 'id'));
          if (!t) return errorResult(`Khong co template "${getStringArg(args, 'id')}".`);
          return [
            `Template "${t.id}" [${t.kind}] ${t.name}${t.builtin ? ' (built-in)' : ''}: ${t.description}`,
            `Truong bat buoc: ${t.requiredFields.join(', ') || '(khong co)'}. Truong tuy chon: ${t.optionalFields.join(', ') || '(khong co)'}. Budget goi y: ${t.suggestedBudgetTokens} token.`,
            'Gia tri mau:',
            t.defaultValue,
          ].join('\n');
        }
        if (action === 'instantiate') {
          const values = (args.values ?? {}) as Record<string, string>;
          const res = store.templates.instantiate(getStringArg(args, 'id'), values);
          if (!res.ok) return errorResult(res.error);
          return [
            `Value khoi tao tu template "${res.value.template.id}"${res.value.missingRequired.length > 0 ? ` (thieu truong bat buoc: ${res.value.missingRequired.join(', ')})` : ' (du truong bat buoc)'}:`,
            res.value.value,
          ].join('\n');
        }
        if (action === 'register') {
          const res = store.templates.register({
            id: getStringArg(args, 'id'),
            kind: (getOptionalStringArg(args, 'kind') ?? 'custom') as V26BlockKind,
            name: getStringArg(args, 'name'),
            description: getOptionalStringArg(args, 'description') ?? '',
            requiredFields: getStringListArg(args, 'requiredFields') ?? [],
            optionalFields: getStringListArg(args, 'optionalFields') ?? [],
            defaultValue: getStringArg(args, 'defaultValue'),
            suggestedBudgetTokens: getNumberArg(args, 'suggestedBudgetTokens') ?? 0,
          });
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da dang ky template "${res.value.id}" [${res.value.kind}] ${res.value.name}.`;
        }
        if (action === 'remove') {
          const res = store.templates.remove(getStringArg(args, 'id'));
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da xoa template "${getStringArg(args, 'id')}".`;
        }
        return errorResult(`action "${action}" khong hop le (list | get | instantiate | register | remove).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  // -- stats ------------------------------------------------------------------------------

  const statsTool: Tool = {
    definition: toolDef(
      'memory_v26_stats',
      'Thong ke memory v26: block theo kind, xung dot mo, audit, archival, template, curate + health + quota 1 bot + snapshot prompt co budget token + export/import block JSON. Read, tru import (ghi) can approval.',
      {
        action: { type: 'string', description: '"stats" | "quota" | "snapshot" | "export" | "import".' },
        botId: { type: 'string', description: 'Bot xem quota / render snapshot (mac dinh bot goi tool).' },
        id: { type: 'string', description: 'Id block (export).' },
        label: { type: 'string', description: 'Label block (export, thay cho id).' },
        json: { type: 'string', description: 'JSON block da export (import).' },
        totalBudgetTokens: { type: 'number', description: 'Ngan sach token tong cho snapshot (mac dinh 4000).' },
        ...SCOPE_PROPS,
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'stats') {
          const stats = store.stats();
          const health = store.health();
          return [
            'Memory v26:',
            `- Block: ${stats.blocksTotal} tong (human ${stats.blocksByKind.human}, persona ${stats.blocksByKind.persona}, task ${stats.blocksByKind.task}, project ${stats.blocksByKind.project}, custom ${stats.blocksByKind.custom}); ${stats.attachedTotal} luot attach; ${stats.blocksWithOpenConflict} block co xung dot mo.`,
            `- Budget: ${stats.blocksOverBudget} block vuot budget, ${stats.blocksWarnBudget} block gan vuot.`,
            `- Conflict: ${stats.conflictsTotal} tong (${stats.conflictsOpen} mo, ${stats.conflictsResolved} da giai quyet). Audit: ${stats.auditTotal} muc.`,
            `- Archival: ${stats.archivedTotal} muc (block-version ${stats.archivedByKind['block-version']}, fact ${stats.archivedByKind.fact}, turn ${stats.archivedByKind.turn}, note ${stats.archivedByKind.note}, curated-out ${stats.archivedByKind['curated-out']}).`,
            `- Template: ${stats.templatesTotal} (${stats.templatesBuiltin} built-in). Curate: ${stats.curationsTotal} lan, tiet kiem ${stats.tokensSavedByCuration} token.`,
            `- Health: ${health.map((h) => `[${h.severity}] ${h.code}: ${h.detail}`).join(' | ')}`,
          ].join('\n');
        }
        if (action === 'quota') {
          const botId = callerBot(args);
          if (!botId) return errorResult('Can botId.');
          const usage = store.quota.usage(botId, store.listBlocks());
          return [
            `Quota bot "${botId}": so huu ${usage.ownedBlocks}/${usage.quota.maxOwnedBlocks} block, attach ${usage.attachedBlocks}/${usage.quota.maxAttachedBlocks} block, token so huu ${usage.ownedTokens}/${usage.quota.maxOwnedTokens || '∞'}, ky tu so huu ${usage.ownedChars}/${usage.quota.maxOwnedChars || '∞'}.`,
            usage.over.length > 0 ? `VUOT QUOTA: ${usage.over.join(', ')}.` : `Muc su dung cao nhat: ${Math.round(usage.maxUsageRatio * 100)}%.`,
          ].join('\n');
        }
        if (action === 'snapshot') {
          const botId = callerBot(args);
          if (!botId) return errorResult('Can botId.');
          const scope = makeV25Scope(scopeFromArgs(args, defaultScope));
          const total = getNumberArg(args, 'totalBudgetTokens') ?? 4000;
          const snap = pipeline.snapshotForPrompt(botId, total, scope);
          if (snap.blocksRendered === 0) return 'Khong co block nao bot nay duoc doc trong ngan sach.';
          return [
            `Snapshot prompt: ${snap.tokens}/${snap.budgetTokens} token (estimate) — ${snap.blocksRendered} block render, ${snap.blocksSkipped} block bo qua (het budget)${snap.blocksTruncated.length > 0 ? `, cat ngan: ${snap.blocksTruncated.join(', ')}` : ''}.`,
            snap.text,
          ].join('\n');
        }
        if (action === 'export') {
          const scope = makeV25Scope(scopeFromArgs(args, defaultScope));
          const id = getOptionalStringArg(args, 'id')
            ?? (getOptionalStringArg(args, 'label') ? store.registry.blocks.getByLabel(getOptionalStringArg(args, 'label') as string, scope)?.id : undefined);
          if (!id) return errorResult('Can id hoac label cua block.');
          const res = store.exportBlock(id);
          if (!res.ok) return errorResult(res.error);
          return res.value;
        }
        if (action === 'import') {
          const botId = callerBot(args);
          if (!botId) return errorResult('Can botId (lam owner block import).');
          const res = store.importBlock(getStringArg(args, 'json'), botId);
          if (!res.ok) return errorResult(res.error);
          persist();
          return `Da import block "${res.value.label}" (${res.value.id}) v${res.value.version} — owner ${botId}.`;
        }
        return errorResult(`action "${action}" khong hop le (stats | quota | snapshot | export | import).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    registryTool,
    blockTool,
    conflictTool,
    auditTool,
    budgetTool,
    curateTool,
    archivalTool,
    recallTool,
    templateTool,
    statsTool,
  ];
}

/** Ten tool memory v26 (thu tu nhu createMemoryV26Tools tra ve). */
export const MEMORY_V26_TOOL_NAMES = [
  'memory_v26_registry',
  'memory_v26_block',
  'memory_v26_conflict',
  'memory_v26_audit',
  'memory_v26_budget',
  'memory_v26_curate',
  'memory_v26_archival',
  'memory_v26_recall',
  'memory_v26_template',
  'memory_v26_stats',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v26 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V26_TOOLS: Tool[] = createMemoryV26Tools();
