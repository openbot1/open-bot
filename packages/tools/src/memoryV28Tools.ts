/**
 * Memory v28 tools for @open-bot/tools (v1.44, Doi T1).
 *
 * Agent lam viec voi memory v28 bang tool call:
 *  - memory_v28_block         — tao/doc/ghi/archive block git-backed (ghi needsApproval: true)
 *  - memory_v28_block_history — lich su/diff/rollback/get-at cua block (rollback needsApproval: true)
 *  - memory_v28_share         — tao shared block / cap-thu quyen / attach-detach / list (ghi needsApproval: true)
 *  - memory_v28_share_audit   — audit log cua shared block (read)
 *  - memory_v28_fact          — them/vo hieu/supersede fact bi-temporal (ghi needsApproval: true)
 *  - memory_v28_fact_query    — tim/list/valid-at/known-at/history fact (read)
 *  - memory_v28_time_travel   — get_state_at / diff_timerange / timeline (read)
 *  - memory_v28_sleep         — chay sleep consolidation (dry-run hoac that) + xem run gan nhat (chay that needsApproval: true)
 *  - memory_v28_sleep_config  — xem/sua cau hinh sleep (sua needsApproval: true)
 *  - memory_v28_stats         — thong ke + panel view + export/import snapshot + integrity check + export/import bundle (import/bundle_import needsApproval: true)
 *
 * SAFETY: add-only o tang fact — KHONG co tool sua/xoa fact;
 * fact cu chi duoc vo hieu (invalidate) hoac supersede, lich
 * su con nguyen trong facts.jsonl. Block khong co lenh xoa —
 * chi archive (lich su git van giu). Rollback khong rewrite
 * history: noi dung cu duoc commit thanh version moi. Khong
 * goi model chat, khong goi API ngoai.
 *
 * Factory:
 *   createMemoryV28Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V28_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  V28Store,
  buildV28PanelView,
  buildV28Stats,
  exportV28Bundle,
  importV28Bundle,
  isQuietHoursV28,
  shouldSleepRunNowV28,
  verifyV28Integrity,
  type V28AclRole,
  type V28InvalidateReason,
  type V28SleepConfig,
  type V28SleepEpisode,
} from '@open-bot/core';

export interface MemoryV28ToolOptions {
  store?: V28Store;
  /** Thu muc workspace: store v28 luu tai day khi khong truyen store san. */
  workspaceDir?: string;
  botId?: string;
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

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" phai la object`);
  }
  return value as Record<string, unknown>;
}

function isAclRole(value: string): value is V28AclRole {
  return value === 'none' || value === 'read' || value === 'write' || value === 'admin';
}

function isInvalidateReason(value: string): value is V28InvalidateReason {
  return (
    value === 'superseded' ||
    value === 'contradicted' ||
    value === 'outdated' ||
    value === 'incorrect' ||
    value === 'duplicate' ||
    value === 'user-request' ||
    value === 'sleep-consolidation'
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export const MEMORY_V28_TOOL_NAMES = [
  'memory_v28_block',
  'memory_v28_block_history',
  'memory_v28_share',
  'memory_v28_share_audit',
  'memory_v28_fact',
  'memory_v28_fact_query',
  'memory_v28_time_travel',
  'memory_v28_sleep',
  'memory_v28_sleep_config',
  'memory_v28_stats',
] as const;

export function createMemoryV28Tools(opts: MemoryV28ToolOptions = {}): Tool[] {
  let storeRef: V28Store | null = opts.store ?? null;
  /**
   * Store duoc tao LUOI (lazy): placeholder MEMORY_V28_TOOLS
   * (khong truyen store) khong cham disk khi import — tranh
   * tao repo memory-v28/ trong thu muc lam viec chi vi import
   * module. Store that chi duoc tao o lan execute dau tien
   * (hoac khi host truyen store/workspaceDir san).
   */
  const getStore = (): V28Store => {
    if (!storeRef) {
      storeRef = new V28Store({ rootDir: opts.workspaceDir ?? process.cwd(), botId: opts.botId ?? '' });
    }
    return storeRef;
  };
  const botId = opts.botId ?? storeRef?.botId ?? '';
  const actor = botId ? `agent:${botId}` : 'user';

  const tools: Tool[] = [
    {
      definition: toolDef(
        'memory_v28_block',
        'Block memory git-backed v28: tao/doc/ghi/archive block. Moi lan ghi la 1 commit git (history/diff/rollback co san). Block he thong human/persona chi user/he thong sua — agent bi chan.',
        {
          action: { type: 'string', description: 'create | read | write | archive | list', enum: ['create', 'read', 'write', 'archive', 'list'] },
          label: { type: 'string', description: 'Label block (vd human, persona, project-notes).' },
          content: { type: 'string', description: 'Noi dung block (cho create/write).' },
          kind: { type: 'string', description: 'Loai block.', enum: ['human', 'persona', 'note', 'fact', 'shared', 'custom'] },
          description: { type: 'string', description: 'Mo ta block (cho create).' },
          scope: { type: 'string', description: 'Pham vi block.', enum: ['system', 'user', 'shared'] },
          message: { type: 'string', description: 'Commit message (cho write).' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'list') {
            const blocks = getStore().gitStore.listBlocks().map((m) => ({
              label: m.label,
              kind: m.kind,
              scope: m.scope,
              version: m.version,
              commit: m.commit,
              updatedAt: m.updatedAt,
              shared: getStore().shared.isShared(m.label),
            }));
            return json({ blocks, total: blocks.length, gitAvailable: getStore().gitStore.gitAvailable() });
          }
          const label = getStringArg(args, 'label');
          if (action === 'read') {
            const block = getStore().gitStore.readBlock(label);
            if (!block) return errorResult(`Khong co block "${label}"`);
            return json({ label: block.meta.label, version: block.meta.version, commit: block.meta.commit, updatedAt: block.meta.updatedAt, content: block.content });
          }
          if (action === 'archive') {
            const result = getStore().gitStore.archiveBlock(label, { actor, message: getOptionalStringArg(args, 'message') });
            return result.ok ? result.value : errorResult(result.error);
          }
          const content = getStringArg(args, 'content');
          if (action === 'create' || action === 'write') {
            const written = getStore().gitStore.writeBlock(label, content, {
              kind: getOptionalStringArg(args, 'kind') as 'human' | 'persona' | 'note' | 'fact' | 'shared' | 'custom' | undefined,
              description: getOptionalStringArg(args, 'description'),
              scope: getOptionalStringArg(args, 'scope') as 'system' | 'user' | 'shared' | undefined,
              actor,
              message: getOptionalStringArg(args, 'message') ?? `${action} via tool`,
              ownerBotId: botId || undefined,
            });
            if (!written.ok) return errorResult(written.error);
            return json({ label, version: written.value.version, commit: written.value.commit, hash: written.value.hash, message: written.value.message });
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_block_history',
        'Lich su git cua block v28: history/diff/rollback/get-at. Rollback khong rewrite history — noi dung cu duoc commit thanh version moi.',
        {
          action: { type: 'string', description: 'history | diff | rollback | get_at', enum: ['history', 'diff', 'rollback', 'get_at'] },
          label: { type: 'string', description: 'Label block.' },
          limit: { type: 'number', description: 'So version toi da (cho history, mac dinh 50).' },
          from: { type: 'string', description: 'Commit SHA hoac so version bat dau (cho diff).' },
          to: { type: 'string', description: 'Commit SHA hoac so version ket thuc (cho diff).' },
          target: { type: 'string', description: 'Version/commit can rollback ve (cho rollback).' },
          at: { type: 'string', description: 'Thoi diem ISO (cho get_at).' },
        },
        ['action', 'label'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        const label = getStringArg(args, 'label');
        try {
          if (action === 'history') {
            const versions = getStore().gitStore.history(label, getNumberArg(args, 'limit') ?? 50);
            return json({ label, versions, total: versions.length });
          }
          if (action === 'diff') {
            const from = getStringArg(args, 'from');
            const to = getStringArg(args, 'to');
            const result = getStore().gitStore.diff(label, from, to);
            return result.ok ? result.value : errorResult(result.error);
          }
          if (action === 'rollback') {
            const target = getStringArg(args, 'target');
            const result = getStore().gitStore.rollback(label, target, { actor });
            if (!result.ok) return errorResult(result.error);
            return json({ label, newVersion: result.value.version, commit: result.value.commit, message: result.value.message });
          }
          if (action === 'get_at') {
            const at = getStringArg(args, 'at');
            const result = getStore().gitStore.getAt(label, at);
            if (!result.ok) return errorResult(result.error);
            return json({ label, at: result.value.at, version: result.value.version, commit: result.value.commit, content: result.value.content });
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_share',
        'Shared block v28 giua cac bot: tao block chung, cap/thu quyen (read/write/admin), attach/detach bot, list block bot doc duoc. Owner luon admin.',
        {
          action: { type: 'string', description: 'create | grant | revoke | attach | detach | read | write | list', enum: ['create', 'grant', 'revoke', 'attach', 'detach', 'read', 'write', 'list'] },
          label: { type: 'string', description: 'Label shared block.' },
          content: { type: 'string', description: 'Noi dung block (cho create/write).' },
          targetBotId: { type: 'string', description: 'Bot duoc cap/thu quyen hoac attach/detach.' },
          role: { type: 'string', description: 'Quyen cap.', enum: ['none', 'read', 'write', 'admin'] },
          description: { type: 'string', description: 'Mo ta block (cho create).' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'list') {
            return json({ botId, blocks: getStore().shared.listForBot(botId) });
          }
          const label = getStringArg(args, 'label');
          if (action === 'create') {
            const result = getStore().shared.createSharedBlock(label, getStringArg(args, 'content'), botId, {
              description: getOptionalStringArg(args, 'description'),
              actor,
            });
            if (!result.ok) return errorResult(result.error);
            return json({ label: result.value.label, version: result.value.meta.version, ownerBotId: result.value.ownerBotId, attachedBots: result.value.attachedBots });
          }
          if (action === 'read') {
            const result = getStore().shared.readForBot(label, botId);
            return result.ok ? json({ label, ...result.value }) : errorResult(result.error);
          }
          if (action === 'write') {
            const result = getStore().shared.writeForBot(label, botId, getStringArg(args, 'content'));
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          const targetBotId = getStringArg(args, 'targetBotId');
          if (action === 'grant') {
            const role = getStringArg(args, 'role');
            if (!isAclRole(role)) return errorResult(`Role khong hop le: "${role}"`);
            const result = getStore().shared.grantRole(label, targetBotId, role, botId);
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          if (action === 'revoke') {
            const result = getStore().shared.revokeRole(label, targetBotId, botId);
            return result.ok ? result.value : errorResult(result.error);
          }
          if (action === 'attach') {
            const result = getStore().shared.attachBot(label, targetBotId, botId);
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          if (action === 'detach') {
            const result = getStore().shared.detachBot(label, targetBotId, botId);
            return result.ok ? result.value : errorResult(result.error);
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_share_audit',
        'Audit log cua shared block v28: ai tao/cap quyen/ghi/rollback block, luc nao (read-only).',
        {
          label: { type: 'string', description: 'Label shared block (bo trong de lay audit toan bo).' },
          limit: { type: 'number', description: 'So muc toi da (mac dinh 50).' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const label = getOptionalStringArg(args, 'label');
          const limit = getNumberArg(args, 'limit') ?? 50;
          const entries = label ? getStore().shared.auditFor(label, limit) : getStore().shared.loadAudit(limit);
          return json({ entries, total: entries.length });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_fact',
        'Fact bi-temporal v28: them fact moi, vo hieu fact cu (invalidate — giu lai kem cua so hieu luc), supersede fact cu bang fact moi. Khong co sua/xoa fact.',
        {
          action: { type: 'string', description: 'add | invalidate | supersede', enum: ['add', 'invalidate', 'supersede'] },
          subject: { type: 'string', description: 'Chu the cua fact (vd user).' },
          predicate: { type: 'string', description: 'Vi ngu cua fact (vd likes).' },
          object: { type: 'string', description: 'Tan ngu cua fact.' },
          text: { type: 'string', description: 'Cau text day du (mac dinh ghep subject predicate object).' },
          id: { type: 'string', description: 'Id fact can vo hieu/supersede.' },
          reason: { type: 'string', description: 'Ly do vo hieu.', enum: ['superseded', 'contradicted', 'outdated', 'incorrect', 'duplicate', 'user-request', 'sleep-consolidation'] },
          confidence: { type: 'number', description: 'Do tin cay 0-1 (cho add/supersede).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag cua fact.' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'add') {
            const result = getStore().facts.addFact({
              subject: getStringArg(args, 'subject'),
              predicate: getStringArg(args, 'predicate'),
              object: getStringArg(args, 'object'),
              text: getOptionalStringArg(args, 'text'),
              source: 'agent',
              botId,
              confidence: getNumberArg(args, 'confidence'),
              tags: getStringListArg(args, 'tags'),
            });
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          const id = getStringArg(args, 'id');
          if (action === 'invalidate') {
            const reason = getStringArg(args, 'reason');
            if (!isInvalidateReason(reason)) return errorResult(`Reason khong hop le: "${reason}"`);
            const result = getStore().facts.invalidateFact(id, { reason, by: actor });
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          if (action === 'supersede') {
            const reason = getOptionalStringArg(args, 'reason') ?? 'superseded';
            if (!isInvalidateReason(reason)) return errorResult(`Reason khong hop le: "${reason}"`);
            const result = getStore().facts.supersedeFact(
              id,
              {
                subject: getStringArg(args, 'subject'),
                predicate: getStringArg(args, 'predicate'),
                object: getStringArg(args, 'object'),
                text: getOptionalStringArg(args, 'text'),
                source: 'agent',
                botId,
                confidence: getNumberArg(args, 'confidence'),
                tags: getStringListArg(args, 'tags'),
              },
              { by: actor, reason },
            );
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_fact_query',
        'Truy van fact v28 (read-only): tim kiem, fact cua subject, fact dung tai X (valid time), fact he thong da biet tai X (transaction time), lich su 1 fact.',
        {
          action: { type: 'string', description: 'search | subject | valid_at | known_at | history | list', enum: ['search', 'subject', 'valid_at', 'known_at', 'history', 'list'] },
          query: { type: 'string', description: 'Tu khoa tim kiem (cho search).' },
          subject: { type: 'string', description: 'Subject can lay fact (cho subject).' },
          at: { type: 'string', description: 'Thoi diem ISO (cho valid_at/known_at).' },
          id: { type: 'string', description: 'Id fact (cho history).' },
          limit: { type: 'number', description: 'So ket qua toi da (mac dinh 20).' },
          includeInactive: { type: 'boolean', description: 'Lay ca fact da vo hieu.' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          const includeInactive = getBoolArg(args, 'includeInactive', false);
          if (action === 'search') {
            const hits = getStore().facts.searchFacts(getStringArg(args, 'query'), {
              limit: getNumberArg(args, 'limit') ?? 20,
              includeInactive,
            });
            return json({ hits, total: hits.length });
          }
          if (action === 'subject') {
            const facts = getStore().facts.factsForSubject(getStringArg(args, 'subject'), { includeInactive });
            return json({ facts, total: facts.length });
          }
          if (action === 'valid_at' || action === 'known_at') {
            const at = getStringArg(args, 'at');
            const result = action === 'valid_at' ? getStore().facts.validAt(at) : getStore().facts.knownAt(at);
            return result.ok ? json({ at, facts: result.value, total: result.value.length }) : errorResult(result.error);
          }
          if (action === 'history') {
            const history = getStore().facts.history(getStringArg(args, 'id'));
            return json({ history, total: history.length });
          }
          if (action === 'list') {
            const facts = getStore().facts.all().filter((f) => includeInactive || f.status === 'active');
            const limit = getNumberArg(args, 'limit') ?? 20;
            return json({ facts: facts.slice(0, limit), total: facts.length });
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_time_travel',
        'Time-travel v28 (read-only): get_state_at tra toan bo trang thai memory (block + fact) tai 1 thoi diem; diff_timerange liet ke moi thay doi trong 1 khoang; timeline tra lich su 1 block hoac 1 subject.',
        {
          action: { type: 'string', description: 'get_state_at | diff_timerange | block_timeline | fact_timeline', enum: ['get_state_at', 'diff_timerange', 'block_timeline', 'fact_timeline'] },
          at: { type: 'string', description: 'Thoi diem ISO (cho get_state_at).' },
          from: { type: 'string', description: 'Thoi diem bat dau ISO (cho diff_timerange).' },
          to: { type: 'string', description: 'Thoi diem ket thuc ISO (cho diff_timerange).' },
          label: { type: 'string', description: 'Label block (cho block_timeline).' },
          subject: { type: 'string', description: 'Subject (cho fact_timeline).' },
          limit: { type: 'number', description: 'So muc toi da (cho block_timeline, mac dinh 50).' },
        },
        ['action'],
      ),
      needsApproval: false,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'get_state_at') {
            const result = getStore().timeTravel.getStateAt(getStringArg(args, 'at'));
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          if (action === 'diff_timerange') {
            const result = getStore().timeTravel.diffTimerange(getStringArg(args, 'from'), getStringArg(args, 'to'));
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          if (action === 'block_timeline') {
            const entries = getStore().timeTravel.blockTimeline(getStringArg(args, 'label'), getNumberArg(args, 'limit') ?? 50);
            return json({ timeline: entries, total: entries.length });
          }
          if (action === 'fact_timeline') {
            const entries = getStore().timeTravel.factTimeline(getStringArg(args, 'subject'));
            return json({ timeline: entries, total: entries.length });
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_sleep',
        'Sleep-time consolidation v28: chay subagent gom/khu trung/tom tat memory khi ranh (khong chen vao turn). Dry-run chi trich xuat + bao cao, khong ghi. Trang thai run gan nhat xem bang action=status.',
        {
          action: { type: 'string', description: 'run | dry_run | status | should_run', enum: ['run', 'dry_run', 'status', 'should_run'] },
          episodes: { type: 'array', items: { type: 'object' }, description: 'Danh sach episode moi: [{id, text, botId, at}].' },
          idleMinutes: { type: 'number', description: 'So phut idle hien tai (cho should_run).' },
          activeBots: { type: 'number', description: 'So bot dang chay turn (cho should_run).' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'status') {
            return json({
              enabled: getStore().sleep.config.enabled,
              lastRun: getStore().sleep.lastRun,
              runsTotal: getStore().sleep.runsTotal,
              nextRunAt: getStore().sleep.lastRun
                ? new Date(Date.now() + getStore().sleep.config.minIdleMinutes * 60_000).toISOString()
                : null,
            });
          }
          if (action === 'should_run') {
            const result = shouldSleepRunNowV28(getStore().sleep.config, {
              now: new Date(),
              idleMinutes: getNumberArg(args, 'idleMinutes') ?? 0,
              activeBots: getNumberArg(args, 'activeBots') ?? 0,
              lastRunAt: getStore().sleep.lastRun?.finishedAt ?? null,
              botId,
            });
            return json({
              ...result,
              inQuietHours: isQuietHoursV28(getStore().sleep.config, new Date()),
              enabled: getStore().sleep.config.enabled,
            });
          }
          const episodesArg = args.episodes;
          if (!Array.isArray(episodesArg)) return errorResult('Argument "episodes" phai la danh sach episode');
          const episodes: V28SleepEpisode[] = [];
          for (const raw of episodesArg as unknown[]) {
            if (!raw || typeof raw !== 'object') return errorResult('Moi episode phai la object {id, text, botId, at}');
            const episode = raw as Record<string, unknown>;
            if (typeof episode.id !== 'string' || typeof episode.text !== 'string') {
              return errorResult('Moi episode can co id (string) va text (string)');
            }
            episodes.push({
              id: episode.id,
              text: episode.text,
              botId: typeof episode.botId === 'string' ? episode.botId : botId,
              at: typeof episode.at === 'string' ? episode.at : new Date().toISOString(),
            });
          }
          const report = getStore().sleep.consolidate(episodes, {
            dryRun: action === 'dry_run',
            botId,
          });
          if (!report.dryRun) getStore().saveSleepState();
          return json(report);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_sleep_config',
        'Cau hinh sleep consolidation v28: xem hoac sua (enabled, quiet hours, minIdleMinutes, maxFactsPerRun, dedupeThreshold, summaryBlockLabel, allowedBotIds).',
        {
          action: { type: 'string', description: 'get | set', enum: ['get', 'set'] },
          enabled: { type: 'boolean', description: 'Bat/tat sleep consolidation.' },
          quietHoursStart: { type: 'number', description: 'Gio bat dau quiet hours (0-23).' },
          quietHoursEnd: { type: 'number', description: 'Gio ket thuc quiet hours (0-23).' },
          onlyInQuietHours: { type: 'boolean', description: 'Chi chay trong quiet hours.' },
          minIdleMinutes: { type: 'number', description: 'So phut idle toi thieu.' },
          maxFactsPerRun: { type: 'number', description: 'So fact toi da moi run.' },
          dedupeThreshold: { type: 'number', description: 'Nguong Jaccard khu trung (0-1).' },
          summaryBlockLabel: { type: 'string', description: 'Block nhan ban tom tat.' },
          allowedBotIds: { type: 'array', items: { type: 'string' }, description: 'Bot duoc phep chay sleep run (rong = moi bot).' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'get') return json(getStore().sleep.config);
          const patch: Partial<V28SleepConfig> = {};
          if (args.enabled !== undefined) patch.enabled = getBoolArg(args, 'enabled', false);
          if (args.quietHoursStart !== undefined) patch.quietHoursStart = getNumberArg(args, 'quietHoursStart');
          if (args.quietHoursEnd !== undefined) patch.quietHoursEnd = getNumberArg(args, 'quietHoursEnd');
          if (args.onlyInQuietHours !== undefined) patch.onlyInQuietHours = getBoolArg(args, 'onlyInQuietHours', false);
          if (args.minIdleMinutes !== undefined) patch.minIdleMinutes = getNumberArg(args, 'minIdleMinutes');
          if (args.maxFactsPerRun !== undefined) patch.maxFactsPerRun = getNumberArg(args, 'maxFactsPerRun');
          if (args.dedupeThreshold !== undefined) patch.dedupeThreshold = getNumberArg(args, 'dedupeThreshold');
          if (args.summaryBlockLabel !== undefined) patch.summaryBlockLabel = getOptionalStringArg(args, 'summaryBlockLabel');
          if (args.allowedBotIds !== undefined) patch.allowedBotIds = getStringListArg(args, 'allowedBotIds');
          const updated = getStore().sleep.updateConfig(patch);
          getStore().saveSleepState();
          return json(updated);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      definition: toolDef(
        'memory_v28_stats',
        'Thong ke + panel view + export/import snapshot + integrity check + export/import bundle v28 (read; import/bundle_import ghi — needsApproval).',
        {
          action: { type: 'string', description: 'stats | panel | export | import | integrity | bundle_export | bundle_import', enum: ['stats', 'panel', 'export', 'import', 'integrity', 'bundle_export', 'bundle_import'] },
          snapshot: { type: 'object', description: 'Snapshot JSON (cho import).' },
          bundleDir: { type: 'string', description: 'Thu muc bundle (cho bundle_export/bundle_import).' },
          dryRun: { type: 'boolean', description: 'Chi kiem tra, khong ghi (cho bundle_import).' },
        },
        ['action'],
      ),
      needsApproval: true,
      execute: async (args) => {
        const action = getStringArg(args, 'action');
        try {
          if (action === 'stats') {
            return json(buildV28Stats({
              gitStore: getStore().gitStore,
              factStore: getStore().facts,
              registry: getStore().shared,
              sleep: getStore().sleep,
              timeTravel: getStore().timeTravel,
            }));
          }
          if (action === 'panel') {
            return json(buildV28PanelView({
              gitStore: getStore().gitStore,
              factStore: getStore().facts,
              registry: getStore().shared,
              sleep: getStore().sleep,
              timeTravel: getStore().timeTravel,
            }));
          }
          if (action === 'export') {
            return json(getStore().exportSnapshot());
          }
          if (action === 'import') {
            const snapshot = getObjectArg(args, 'snapshot');
            if (!snapshot) return errorResult('Argument "snapshot" la bat buoc cho import');
            const result = getStore().importSnapshot(snapshot as unknown as Parameters<V28Store['importSnapshot']>[0]);
            return json(result);
          }
          if (action === 'integrity') {
            return json(verifyV28Integrity(getStore()));
          }
          if (action === 'bundle_export') {
            const bundleDir = getStringArg(args, 'bundleDir');
            const result = exportV28Bundle(getStore(), bundleDir);
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          if (action === 'bundle_import') {
            const bundleDir = getStringArg(args, 'bundleDir');
            const result = importV28Bundle(getStore(), bundleDir, {
              dryRun: getBoolArg(args, 'dryRun', false),
              actor,
            });
            return result.ok ? json(result.value) : errorResult(result.error);
          }
          return errorResult(`Action khong hop le: "${action}"`);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
  return tools;
}

/** Placeholder chua bound (dung trong ALL_TOOLS) — giong pattern v27. */
export const MEMORY_V28_TOOLS: Tool[] = createMemoryV28Tools();
