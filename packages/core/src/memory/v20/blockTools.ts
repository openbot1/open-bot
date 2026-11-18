/**
 * Memory v20 — Block tools (Letta-style, v1.28, Doi T1).
 *
 * Agent chi duoc sua core block QUA TOOL — khong sua truc tiep
 * `value`, khong sua file. Moi tool call deu di qua
 * `V20CoreBlockStore.applyEdit` (ly do bat buoc, optimistic
 * version, char limit) va duoc ghi audit.
 *
 * Tool set (ten on dinh, mo ta tieng Viet cho model):
 *  - memory_v20_list_blocks   — liet ke block dang hoat dong
 *  - memory_v20_get_block     — doc mot block + version + lich su gan
 *  - memory_v20_create_block  — tao block moi (label duy nhat)
 *  - memory_v20_edit_block    — replace/append/prepend/insert/delete_range
 *  - memory_v20_archive_block — luu tru block (khoi phuc duoc)
 *  - memory_v20_restore_block — khoi phuc block da luu tru
 *  - memory_v20_block_history — lich su sua doi cua mot block
 *  - memory_v20_rollback_block— khoi phuc ve mot version cu (tao version moi)
 *  - memory_v20_search_blocks — tim block theo tu khoa / tag / kind
 *
 * Dinh dang tham so: JSON Schema don gian (type/required/
 * properties/enum/description) de host map sang dinh dang tool
 * cua tung provider (OpenAI function calling, Anthropic, ...).
 * Ham `dispatchV20BlockTool` la diem vao duy nhat: parse +
 * validate + goi store + tra ket qua co cau truc.
 */
import type { V20BlockEditRequest, V20BlockEditResult, V20CoreBlock, V20EditOp } from './types';
import { V20CoreBlockStore } from './coreBlocks';

export type V20ToolName =
  | 'memory_v20_list_blocks'
  | 'memory_v20_get_block'
  | 'memory_v20_create_block'
  | 'memory_v20_edit_block'
  | 'memory_v20_archive_block'
  | 'memory_v20_restore_block'
  | 'memory_v20_block_history'
  | 'memory_v20_rollback_block'
  | 'memory_v20_search_blocks';

export interface V20ToolParamSchema {
  type: 'object';
  required: string[];
  properties: Record<string, V20ToolPropertySchema>;
}

export interface V20ToolPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  enum?: string[];
  items?: { type: 'string' };
  default?: string | number | boolean;
}

export interface V20ToolDefinition {
  name: V20ToolName;
  description: string;
  parameters: V20ToolParamSchema;
  /** Tool co ghi vao block hay chi doc. */
  mutating: boolean;
  /** Actor kind mac dinh khi agent goi tool nay. */
  actorKind: 'agent' | 'user' | 'sleep' | 'system';
}

export interface V20ToolCallResult {
  ok: boolean;
  tool: V20ToolName;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

function strProp(description: string, extra?: Partial<V20ToolPropertySchema>): V20ToolPropertySchema {
  return { type: 'string', description, ...extra };
}

function numProp(description: string, extra?: Partial<V20ToolPropertySchema>): V20ToolPropertySchema {
  return { type: 'number', description, ...extra };
}

function boolProp(description: string, extra?: Partial<V20ToolPropertySchema>): V20ToolPropertySchema {
  return { type: 'boolean', description, ...extra };
}

export const V20_BLOCK_TOOL_DEFINITIONS: V20ToolDefinition[] = [
  {
    name: 'memory_v20_list_blocks',
    description: 'Liet ke cac core memory block dang hoat dong (label, kind, scope, version, so ky tu). Dung truoc khi doc/sua de biet block nao ton tai.',
    parameters: {
      type: 'object',
      required: [],
      properties: {
        includeArchived: boolProp('Bao gom ca block da luu tru (mac dinh false).', { default: false }),
        kind: strProp('Chi lay block thuoc kind nay.', { enum: ['persona', 'human', 'facts', 'preferences', 'project', 'custom'] }),
      },
    },
    mutating: false,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_get_block',
    description: 'Doc noi dung day du cua mot core memory block theo id hoac label, kem version hien tai va 5 lan sua gan nhat.',
    parameters: {
      type: 'object',
      required: ['blockId'],
      properties: { blockId: strProp('Id hoac label cua block (vd "persona").') },
    },
    mutating: false,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_create_block',
    description: 'Tao core memory block moi. Label duy nhat trong agent. Dat charLimit nho cho block ngan (vd preferences 2000), lon cho block facts.',
    parameters: {
      type: 'object',
      required: ['label', 'kind', 'value'],
      properties: {
        label: strProp('Nhan cua block, duy nhat, toi da 64 ky tu (vd "persona", "so thich").'),
        kind: strProp('Loai block.', { enum: ['persona', 'human', 'facts', 'preferences', 'project', 'custom'] }),
        value: strProp('Noi dung ban dau cua block.'),
        scope: strProp('Pham vi: agent (rieng bot nay), user (theo user), shared (chia se).', { enum: ['agent', 'user', 'shared'], default: 'agent' }),
        charLimit: numProp('Gioi han ky tu toi da (mac dinh 8000).'),
        tags: { type: 'array', description: 'Tag phan loai (vd ["ca-nhan", "du-an"]).', items: { type: 'string' } },
      },
    },
    mutating: true,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_edit_block',
    description: 'Sua mot core memory block. BAT BUOC ghi ro ly do (reason). Dung expectedVersion de tranh ghi de khi block da doi. Cac op: replace (thay toan bo), append (them cuoi), prepend (them dau), insert (chen tai vi tri), delete_range (xoa doan [start, end)).',
    parameters: {
      type: 'object',
      required: ['blockId', 'op', 'reason'],
      properties: {
        blockId: strProp('Id hoac label cua block.'),
        op: strProp('Loai sua doi.', { enum: ['replace', 'append', 'prepend', 'insert', 'delete_range'] }),
        newValue: strProp('Gia tri moi day du (chi dung voi replace).'),
        text: strProp('Doan text them/chen (append, prepend, insert).'),
        start: numProp('Vi tri bat dau (insert: vi tri chen; delete_range: dau doan xoa).'),
        end: numProp('Vi tri ket thuc (chi delete_range, khong bao gom).'),
        reason: strProp('Ly do sua doi, toi thieu 3 ky tu (vd "user doi so thich").'),
        expectedVersion: numProp('Version ky vong; neu block da doi thi tu choi de tranh ghi de.'),
        toolCallId: strProp('Id cua tool call nay (de audit).'),
      },
    },
    mutating: true,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_archive_block',
    description: 'Luu tru mot block: block khong con xuat hien trong prompt nua nhung van giu lich su, khoi phuc duoc.',
    parameters: {
      type: 'object',
      required: ['blockId', 'reason'],
      properties: {
        blockId: strProp('Id hoac label cua block.'),
        reason: strProp('Ly do luu tru, toi thieu 3 ky tu.'),
      },
    },
    mutating: true,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_restore_block',
    description: 'Khoi phuc mot block da luu tru ve trang thai hoat dong (tao version moi, khong xoa lich su).',
    parameters: {
      type: 'object',
      required: ['blockId', 'reason'],
      properties: {
        blockId: strProp('Id hoac label cua block.'),
        reason: strProp('Ly do khoi phuc, toi thieu 3 ky tu.'),
      },
    },
    mutating: true,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_block_history',
    description: 'Xem lich su sua doi cua mot block: ai sua, luc nao, op gi, ly do gi, version truoc/sau.',
    parameters: {
      type: 'object',
      required: ['blockId'],
      properties: {
        blockId: strProp('Id hoac label cua block.'),
        limit: numProp('So ban ghi toi da tra ve (mac dinh 20, toi da 100).', { default: 20 }),
      },
    },
    mutating: false,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_rollback_block',
    description: 'Khoi phuc block ve noi dung cua mot version cu. Lich su KHONG bi viet lai: rollback tao mot version MOI copy noi dung ban cu.',
    parameters: {
      type: 'object',
      required: ['blockId', 'targetVersion', 'reason'],
      properties: {
        blockId: strProp('Id hoac label cua block.'),
        targetVersion: numProp('Version muon khoi phuc ve (phai ton tai trong lich su).'),
        reason: strProp('Ly do rollback, toi thieu 3 ky tu.'),
      },
    },
    mutating: true,
    actorKind: 'agent',
  },
  {
    name: 'memory_v20_search_blocks',
    description: 'Tim block theo tu khoa trong label/noi dung, hoac loc theo tag/kind. Tra ve block khop kem doan trich ngan.',
    parameters: {
      type: 'object',
      required: [],
      properties: {
        query: strProp('Tu khoa can tim (khong phan biet hoa thuong).'),
        tag: strProp('Chi lay block co tag nay.'),
        kind: strProp('Chi lay block thuoc kind nay.', { enum: ['persona', 'human', 'facts', 'preferences', 'project', 'custom'] }),
        limit: numProp('So ket qua toi da (mac dinh 10, toi da 32).', { default: 10 }),
      },
    },
    mutating: false,
    actorKind: 'agent',
  },
];

export function getV20ToolDefinition(name: string): V20ToolDefinition | undefined {
  return V20_BLOCK_TOOL_DEFINITIONS.find((d) => d.name === name);
}

export function listV20ToolNames(): V20ToolName[] {
  return V20_BLOCK_TOOL_DEFINITIONS.map((d) => d.name);
}

/** Tom tat mot block de tra ve cho model (khong kem toan bo lich su). */
export function summarizeBlockV20(block: V20CoreBlock): Record<string, unknown> {
  return {
    id: block.id,
    label: block.label,
    kind: block.kind,
    scope: block.scope,
    version: block.version,
    charsUsed: block.value.length,
    charLimit: block.charLimit,
    archived: block.archived,
    readonly: block.readonly ?? false,
    tags: block.tags,
    updatedAt: block.updatedAt,
    updatedBy: block.updatedBy,
  };
}

function err(tool: V20ToolName, error: string, errorCode = 'invalid_args'): V20ToolCallResult {
  return { ok: false, tool, error, errorCode };
}

function reqStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Diem vao duy nhat de agent goi block tool. `actor` la id cua
 * agent/bot dang goi; moi loi tham so deu tra ve ket qua co cau
 * truc thay vi throw, de model doc duoc va sua lai.
 */
export function dispatchV20BlockTool(
  store: V20CoreBlockStore,
  toolName: string,
  args: Record<string, unknown>,
  actor: string,
): V20ToolCallResult {
  const def = getV20ToolDefinition(toolName);
  if (!def) return err(toolName as V20ToolName, `khong co tool "${toolName}"`, 'unknown_tool');
  const tool = def.name;
  switch (tool) {
    case 'memory_v20_list_blocks': {
      const includeArchived = args.includeArchived === true;
      const kind = typeof args.kind === 'string' ? args.kind : undefined;
      let blocks = store.listBlocks(includeArchived);
      if (kind) blocks = blocks.filter((b) => b.kind === kind);
      return { ok: true, tool, data: { blocks: blocks.map(summarizeBlockV20), total: blocks.length, totalChars: store.totalChars() } };
    }
    case 'memory_v20_get_block': {
      const id = reqStr(args, 'blockId');
      if (!id) return err(tool, 'thieu blockId', 'missing_arg');
      const block = store.getBlock(id);
      if (!block) return err(tool, `khong tim thay block "${id}"`, 'block_not_found');
      const history = store.getHistory(block.id).slice(-5).map((e) => ({ id: e.id, op: e.op, actor: e.actor, reason: e.reason, versionBefore: e.versionBefore, versionAfter: e.versionAfter, at: e.at }));
      return { ok: true, tool, data: { ...summarizeBlockV20(block), value: block.value, recentHistory: history } };
    }
    case 'memory_v20_create_block': {
      const label = reqStr(args, 'label');
      const kind = reqStr(args, 'kind') as V20CoreBlock['kind'] | undefined;
      const value = typeof args.value === 'string' ? args.value : undefined;
      if (!label || !kind || value === undefined) return err(tool, 'thieu label/kind/value', 'missing_arg');
      if (!['persona', 'human', 'facts', 'preferences', 'project', 'custom'].includes(kind)) return err(tool, `kind khong hop le: "${kind}"`, 'invalid_args');
      const scope = reqStr(args, 'scope') as V20CoreBlock['scope'] | undefined;
      const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string') : undefined;
      const res = store.createBlock({ label, kind, value, scope, charLimit: optNum(args, 'charLimit'), actor, tags });
      return toToolResult(tool, res);
    }
    case 'memory_v20_edit_block': {
      const blockId = reqStr(args, 'blockId');
      const op = reqStr(args, 'op') as V20EditOp | undefined;
      const reason = reqStr(args, 'reason');
      if (!blockId || !op || !reason) return err(tool, 'thieu blockId/op/reason', 'missing_arg');
      if (!['replace', 'append', 'prepend', 'insert', 'delete_range'].includes(op)) return err(tool, `op khong hop le: "${op}"`, 'invalid_args');
      const req: V20BlockEditRequest = {
        blockId, op, actor, actorKind: 'agent', reason,
        newValue: typeof args.newValue === 'string' ? args.newValue : undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        start: optNum(args, 'start'), end: optNum(args, 'end'),
        expectedVersion: optNum(args, 'expectedVersion'),
        toolCallId: reqStr(args, 'toolCallId'),
      };
      return toToolResult(tool, store.applyEdit(req));
    }
    case 'memory_v20_archive_block': {
      const blockId = reqStr(args, 'blockId');
      const reason = reqStr(args, 'reason');
      if (!blockId || !reason) return err(tool, 'thieu blockId/reason', 'missing_arg');
      return toToolResult(tool, store.applyEdit({ blockId, op: 'archive', actor, actorKind: 'agent', reason }));
    }
    case 'memory_v20_restore_block': {
      const blockId = reqStr(args, 'blockId');
      const reason = reqStr(args, 'reason');
      if (!blockId || !reason) return err(tool, 'thieu blockId/reason', 'missing_arg');
      const block = store.getBlock(blockId);
      if (!block) return err(tool, `khong tim thay block "${blockId}"`, 'block_not_found');
      if (!block.archived) return err(tool, `block "${block.label}" khong o trang thai luu tru`, 'invalid_args');
      // Restore = replace bang chinh noi dung hien tai + mo khoa archive:
      // store hien chi mo archive qua applyEdit 'archive'; o day dung
      // restore truc tiep qua versioning helper (xem blockVersioning).
      return { ok: false, tool, error: 'restore can blockVersioning.restoreBlockV20 — goi truc tiep tu host, khong qua tool nay', errorCode: 'use_host_api' };
    }
    case 'memory_v20_block_history': {
      const blockId = reqStr(args, 'blockId');
      if (!blockId) return err(tool, 'thieu blockId', 'missing_arg');
      const block = store.getBlock(blockId);
      if (!block) return err(tool, `khong tim thay block "${blockId}"`, 'block_not_found');
      const limit = Math.min(Math.max(optNum(args, 'limit') ?? 20, 1), 100);
      const history = store.getHistory(block.id).slice(-limit).reverse();
      return { ok: true, tool, data: { blockId: block.id, label: block.label, version: block.version, total: store.historySize(block.id), edits: history } };
    }
    case 'memory_v20_rollback_block': {
      const blockId = reqStr(args, 'blockId');
      const reason = reqStr(args, 'reason');
      const targetVersion = optNum(args, 'targetVersion');
      if (!blockId || !reason || targetVersion === undefined) return err(tool, 'thieu blockId/targetVersion/reason', 'missing_arg');
      return { ok: false, tool, error: 'rollback can blockVersioning.rollbackBlockV20 — goi truc tiep tu host, khong qua tool nay', errorCode: 'use_host_api' };
    }
    case 'memory_v20_search_blocks': {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const tag = reqStr(args, 'tag');
      const kind = typeof args.kind === 'string' ? args.kind : undefined;
      const limit = Math.min(Math.max(optNum(args, 'limit') ?? 10, 1), 32);
      let blocks = store.listBlocks(true);
      if (kind) blocks = blocks.filter((b) => b.kind === kind);
      if (tag) blocks = blocks.filter((b) => b.tags.includes(tag));
      const scored = blocks
        .map((b) => {
          const hay = `${b.label}\n${b.value}`.toLowerCase();
          const score = query ? (hay.includes(query) ? 2 : 0) + (b.label.toLowerCase().includes(query) ? 3 : 0) : 1;
          const idx = query ? hay.indexOf(query) : -1;
          const snippet = idx >= 0 ? b.value.slice(Math.max(0, idx - 40), idx + 120) : b.value.slice(0, 160);
          return { block: b, score, snippet };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return { ok: true, tool, data: { query: query || undefined, total: scored.length, results: scored.map((s) => ({ ...summarizeBlockV20(s.block), snippet: s.snippet })) } };
    }
    default:
      return err(tool, `tool "${tool}" chua duoc cai dat dispatch`, 'not_implemented');
  }
}

function toToolResult(tool: V20ToolName, res: V20BlockEditResult): V20ToolCallResult {
  if (!res.ok) return { ok: false, tool, error: res.error, errorCode: res.errorCode };
  return { ok: true, tool, data: res.block ? { ...summarizeBlockV20(res.block), value: res.block.value, editId: res.edit?.id } : undefined };
}
