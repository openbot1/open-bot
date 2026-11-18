/**
 * Memory v16 tools for @open-bot/tools (v1.35, Doi T1).
 *
 * Agent lam viec voi memory v16 bang tool call:
 *  - memory_v16_core_memory_replace — thay CHINH XAC 1 doan text
 *    trong core block (oldText phai khop dung 1 lan, kieu Letta)
 *  - memory_v16_block_edit          — edit block (create/replace/
 *    append/insert/delete_range/delete/pin/unpin) co validation
 *  - memory_v16_block_list          — liet ke block + compile
 *    <memory_blocks> preview + budget report (read)
 *  - memory_v16_block_pin           — pin/unpin block, pin version,
 *    khoi phuc snapshot da pin
 *  - memory_v16_block_audit         — xem audit trail (moi lan sua
 *    block: ai, luc nao, version nao) (read)
 *  - memory_v16_sleep_consolidate   — sleep-time consolidation:
 *    extract + fuse turn cho luc idle, promote fact ben vung
 *  - memory_v16_extract_fuse        — trich fact 1 text roi fuse
 *    da scope (ADD/UPDATE/DELETE/IGNORE)
 *  - memory_v16_validity_set        — dat/het han/gia han cua so
 *    hieu luc, thay the fact (ghi lich su cua so)
 *  - memory_v16_validity_query      — fact dung tai T, sap het han,
 *    da het han, expiry sweep (read)
 *  - memory_v16_archival_recall     — recall bo nho lanh (4 tin
 *    hieu: text IDF + recency + importance + access) (read)
 *  - memory_v16_archival_promote    — promote record archival ve
 *    graph / archive fact active xuong lanh
 *  - memory_v16_eval                — chay eval 40 case, tra PASS/
 *    FAIL theo nhom (read)
 *
 * Tong: 13 tools.
 *
 * SAFETY: block edit validate chat (8000 ky tu/block, budget theo
 * kind, cam tag <memory_blocks>); block PINNED chi sua khi force +
 * ly do. Fuse mac dinh bat nguong tin cay 0.5 (duoi nguong -> IGNORE,
 * khong ghi). Khong goi model that, khong goi API ngoai (rule
 * extractor xac dinh, offline). Store mac dinh nam trong bo nho cua
 * factory (host co the truyen store rieng de luu lau dai).
 *
 * Factory:
 *   createMemoryV16Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V16_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  TemporalGraphStore,
  M16BlockStore,
  M16ValidityLedger,
  M16ArchivalStore,
  M16SleepConsolidator,
  coreMemoryReplaceM16,
  applyBlockEditM16,
  compileBlocksM16,
  exportAuditM16,
  searchBlocksM16,
  runSleepReorganizeM16,
  extractFactsM16Sync,
  applyFuseM16,
  previewConsolidationM16,
  factsValidAtM16,
  factsExpiringSoonM16,
  expiredFactsM16,
  sweepExpiredM16,
  validityReportM16,
  formatValidityReportM16,
  replaceFactM16,
  factValidityTimelineM16,
  formatValidityTimelineM16,
  archivalRecallM16,
  archiveExpiredFactsM16,
  promoteArchivedToGraphM16,
  suggestArchivalCandidatesM16,
  runM16Eval,
  formatM16EvalReport,
} from '@open-bot/core';
import type { M16BlockKind, M16BlockEditAction, M16Scope } from '@open-bot/core';

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

export interface MemoryV16ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound neu khong co graphStore). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam). */
  graphStore?: TemporalGraphStore;
  /** Block store da tao san (test/host luu lau dai; mac dinh: store RAM moi). */
  blockStore?: M16BlockStore;
  /** Validity ledger da tao san (mac dinh: ledger RAM moi). */
  ledger?: M16ValidityLedger;
  /** Archival store da tao san (mac dinh: store RAM moi). */
  archivalStore?: M16ArchivalStore;
  /** Bot id goi tool (dung lam actor). */
  botId?: string;
}

const M16_SCOPES: ReadonlySet<string> = new Set(['user', 'agent', 'session', 'shared']);

export function createMemoryV16Tools(opts: MemoryV16ToolOptions = {}): Tool[] {
  const store =
    opts.graphStore ?? (opts.workspaceDir ? TemporalGraphStore.fromWorkspace(opts.workspaceDir) : undefined);
  const blockStore = opts.blockStore ?? new M16BlockStore();
  const ledger = opts.ledger ?? new M16ValidityLedger();
  const archivalStore = opts.archivalStore ?? new M16ArchivalStore();
  const sleepAgent = new M16SleepConsolidator();
  const defaultBotId = opts.botId;

  const needStore = (): TemporalGraphStore => {
    if (!store) {
      throw new Error(
        'memory v16 chưa được hỗ trợ trong phiên này (host phải truyền graphStore hoặc workspaceDir vào createMemoryV16Tools).',
      );
    }
    return store;
  };
  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };
  const scopeOf = (args: Record<string, unknown>): { userId: string; botId: string; runId: string; sessionId?: string } => {
    const userId = getOptionalStringArg(args, 'userId') ?? '';
    const botId = getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '';
    const runId = getOptionalStringArg(args, 'runId') ?? '';
    const sessionId = getOptionalStringArg(args, 'sessionId');
    return sessionId ? { userId, botId, runId, sessionId } : { userId, botId, runId };
  };

  const coreMemoryReplace: Tool = {
    definition: toolDef(
      'memory_v16_core_memory_replace',
      'Letta-style core_memory_replace for memory v16: replace EXACTLY ONE occurrence of oldText inside a core memory block (persona/human/task) with newText. oldText must match exactly once — 0 matches or multiple matches fail with a hint (occurrence count + nearby context) so the agent can re-read the block and retry. The block version bumps and history is kept. Pinned blocks need force=true plus a reason. Needs approval.',
      {
        label: { type: 'string', description: 'Label block (vd "persona", "human", "task").' },
        oldText: { type: 'string', description: 'Doan text cu phai khop CHINH XAC 1 lan trong block.' },
        newText: { type: 'string', description: 'Doan text moi thay the oldText.' },
        reason: { type: 'string', description: 'Ly do sua (bat buoc khi sua block PIN).' },
        force: { type: 'boolean', description: 'true = cho phep sua block dang PIN (mac dinh false).' },
      },
      ['label', 'oldText', 'newText'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const label = getStringArg(args, 'label');
        const oldText = getStringArg(args, 'oldText');
        const newText = getStringArg(args, 'newText');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const force = getBoolArg(args, 'force', false);
        const block = coreMemoryReplaceM16(blockStore, label, oldText, newText, actorOf(ctx), reason, force);
        return (
          `core_memory_replace v16: block "${block.label}" (kind ${block.kind}) len v${block.version}.\n` +
          `Noi dung moi:\n${block.content.slice(0, 2000)}`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockEdit: Tool = {
    definition: toolDef(
      'memory_v16_block_edit',
      'Edit a memory v16 block (create/replace/append/insert/delete_range/delete/rename/pin/unpin) with strict validation: label rules, 8000 chars/block, per-kind char budget, no <memory_blocks> tag, no control chars. Pinned blocks reject normal edits (use force=true with a reason). Every edit bumps the version and keeps history. Needs approval.',
      {
        action: { type: 'string', description: '"create" | "replace" | "append" | "insert" | "delete_range" | "delete" | "rename" | "pin" | "unpin".' },
        label: { type: 'string', description: 'Label block.' },
        newLabel: { type: 'string', description: 'Label moi — bat buoc khi rename.' },
        kind: { type: 'string', description: 'Kind — bat buoc khi create (persona/human/task/system/custom).' },
        content: { type: 'string', description: 'Noi dung moi — bat buoc khi create/replace.' },
        text: { type: 'string', description: 'Text them/chen — bat buoc khi append/insert.' },
        position: { type: 'number', description: 'Vi tri chen — bat buoc khi insert.' },
        start: { type: 'number', description: 'Khoang xoa [start, end) — bat buoc khi delete_range.' },
        end: { type: 'number', description: 'Khoang xoa [start, end) — bat buoc khi delete_range.' },
        reason: { type: 'string', description: 'Ly do edit (bat buoc khi sua block PIN).' },
        force: { type: 'boolean', description: 'true = cho phep sua block dang PIN (mac dinh false).' },
      },
      ['action', 'label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action') as M16BlockEditAction;
        const label = getStringArg(args, 'label');
        const newLabel = getOptionalStringArg(args, 'newLabel');
        const kind = getOptionalStringArg(args, 'kind') as M16BlockKind | undefined;
        const content = getOptionalStringArg(args, 'content');
        const text = getOptionalStringArg(args, 'text');
        const position = getNumberArg(args, 'position');
        const start = getNumberArg(args, 'start');
        const end = getNumberArg(args, 'end');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const force = getBoolArg(args, 'force', false);
        const result = applyBlockEditM16(
          blockStore,
          {
            action,
            label,
            ...(newLabel !== undefined ? { newLabel } : {}),
            ...(kind ? { kind } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(text !== undefined ? { text } : {}),
            ...(position !== undefined ? { position } : {}),
            ...(start !== undefined ? { start } : {}),
            ...(end !== undefined ? { end } : {}),
            force,
            reason,
          },
          actorOf(ctx),
        );
        if (result.deleted) return `Block "${label}" da xoa.`;
        const b = result.block;
        return `Block "${b?.label}" (${b?.kind}) ${result.action} xong — v${b?.version}${b?.pinned ? ' 📌pinned' : ''} (${b?.content.length ?? 0} ky tu).`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockList: Tool = {
    definition: toolDef(
      'memory_v16_block_list',
      'List memory v16 blocks (pinned first, then persona > human > task > system > custom) with versions, pin state and a compiled <memory_blocks> preview plus the per-kind/total char budget report. Optional query filters by keyword (label match ranks higher). Read-only.',
      {
        kind: { type: 'string', description: 'Loc theo kind (persona/human/task/system/custom) — bo trong = tat ca.' },
        coreOnly: { type: 'boolean', description: 'true = chi block core (persona/human/task).' },
        query: { type: 'string', description: 'Tu khoa tim trong label + noi dung block.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const kind = getOptionalStringArg(args, 'kind') as M16BlockKind | undefined;
        const coreOnly = getBoolArg(args, 'coreOnly', false);
        const query = getOptionalStringArg(args, 'query');
        const blocks = blockStore.list(kind).filter((b) => !coreOnly || b.core);
        const lines = [`Memory v16 blocks: ${blocks.length} block, tong ${blockStore.totalChars()} ky tu.`];
        if (query) {
          const hits = searchBlocksM16(blockStore, query);
          lines.push(`Tim "${query}": ${hits.length} block khop.`);
          for (const h of hits) {
            lines.push(
              `  - [${h.score}] [${h.block.kind}:${h.block.label}] v${h.block.version}${h.block.pinned ? ' 📌pinned' : ''} (khop ${h.matchedIn}) — ${h.block.content.slice(0, 120)}`,
            );
          }
          return lines.join('\n');
        }
        for (const b of blocks) {
          lines.push(
            `  - [${b.kind}:${b.label}] v${b.version}${b.pinned ? ' 📌pinned' : ''}${b.pinnedSnapshot ? ` (snapshot v${b.pinnedSnapshot.version})` : ''} — ${b.content.length} ky tu`,
          );
        }
        const budget = blockStore.budgetReport();
        lines.push(
          `Budget: tong ${budget.totalChars}/${budget.totalBudget} ky tu${budget.totalOver ? ' (VUOT)' : ''}; ` +
            budget.perKind.map((p) => `${p.kind} ${p.chars}/${p.budget}${p.over ? ' (VUOT)' : ''}`).join(', ') +
            '.',
        );
        const compiled = compileBlocksM16(blockStore, {
          ...(kind ? { includeKinds: [kind] } : {}),
          ...(coreOnly ? { coreOnly: true } : {}),
        });
        lines.push('Compiled preview:');
        lines.push(compiled.slice(0, 2000));
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockPin: Tool = {
    definition: toolDef(
      'memory_v16_block_pin',
      'Pin management for memory v16 blocks: pin (protect from normal edits + sleep reorganizer), unpin, pin_version (freeze a version as a snapshot), restore_pinned (restore content from the pinned snapshot). Needs approval.',
      {
        action: { type: 'string', description: '"pin" | "unpin" | "pin_version" | "restore_pinned".' },
        label: { type: 'string', description: 'Label block.' },
        version: { type: 'number', description: 'Version can pin — bat buoc khi pin_version.' },
        reason: { type: 'string', description: 'Ly do pin/khoi phuc.' },
        force: { type: 'boolean', description: 'true = cho phep khoi phuc ca khi block dang PIN (mac dinh false).' },
      },
      ['action', 'label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action');
        const label = getStringArg(args, 'label');
        const version = getNumberArg(args, 'version');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const force = getBoolArg(args, 'force', false);
        const actor = actorOf(ctx);
        if (action === 'pin') {
          const b = blockStore.pin(label, actor, reason);
          return `Block "${b.label}" da PIN (v${b.version}) — bao ve khoi edit thuong + sleep reorganizer.`;
        }
        if (action === 'unpin') {
          const b = blockStore.unpin(label, actor, reason);
          return `Block "${b.label}" da bo PIN (v${b.version}).`;
        }
        if (action === 'pin_version') {
          if (version === undefined) throw new Error('pin_version can co version (number).');
          const b = blockStore.pinVersion(label, version, actor, reason);
          return `Block "${b.label}" da pin snapshot version ${version} (noi dung hien tai van la v${b.version}).`;
        }
        if (action === 'restore_pinned') {
          const b = blockStore.restorePinnedVersion(label, actor, force);
          return `Block "${b.label}" da khoi phuc tu snapshot v${b.pinnedSnapshot?.version ?? '?'} — hien tai v${b.version}.`;
        }
        throw new Error(`Action pin khong hop le: "${action}" (pin/unpin/pin_version/restore_pinned).`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockAudit: Tool = {
    definition: toolDef(
      'memory_v16_block_audit',
      'Read the memory v16 block audit trail: every mutation (create/edit/pin/unpin/rollback/delete/restore) with actor, time, version after, and reason — for one block or the whole store. Read-only.',
      {
        label: { type: 'string', description: 'Label block — bo trong = toan bo store.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const label = getOptionalStringArg(args, 'label');
        return exportAuditM16(blockStore, label);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sleepConsolidate: Tool = {
    definition: toolDef(
      'memory_v16_sleep_consolidate',
      'Run the v16 sleep-time consolidation agent: takes queued conversation turns, extracts facts (rule-based, Vietnamese/English), fuses them into the graph (ADD/UPDATE/DELETE/IGNORE, multi-scope), promotes session facts seen in 2+ sessions to user scope, and promotes durable high-confidence facts into the human/persona core block (never into a PINNED block). Only runs when idle long enough unless forced. With preview=true, only shows the fuse plan (dry-run) without writing anything. Needs approval.',
      {
        turns: { type: 'string', description: 'JSON array cac turn: [{text, scope?, userId?, botId?, runId?, sessionId?}] — neu rong thi chay queue da co.' },
        idleMs: { type: 'number', description: 'Thoi gian idle (ms) — du nguong 5 phut moi chay neu khong force.' },
        force: { type: 'boolean', description: 'true = chay ngay ca khi chua idle (mac dinh false).' },
        preview: { type: 'boolean', description: 'true = chi xem truoc ke hoach fuse (dry-run, khong ghi, khong xoa queue).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const turnsRaw = getOptionalStringArg(args, 'turns');
        const idleMs = getNumberArg(args, 'idleMs');
        const force = getBoolArg(args, 'force', false);
        const preview = getBoolArg(args, 'preview', false);
        if (turnsRaw) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(turnsRaw);
          } catch {
            throw new Error('turns phai la JSON array hop le.');
          }
          if (!Array.isArray(parsed)) throw new Error('turns phai la JSON array.');
          for (const t of parsed as Record<string, unknown>[]) {
            if (typeof t?.text !== 'string') throw new Error('Moi turn can co text (string).');
            sleepAgent.enqueue({
              text: t.text,
              ...(typeof t.scope === 'string' && M16_SCOPES.has(t.scope) ? { scope: t.scope as M16Scope } : {}),
              ...(typeof t.userId === 'string' ? { userId: t.userId } : {}),
              ...(typeof t.botId === 'string' ? { botId: t.botId } : {}),
              ...(typeof t.runId === 'string' ? { runId: t.runId } : {}),
              ...(typeof t.sessionId === 'string' ? { sessionId: t.sessionId } : {}),
            });
          }
        }
        const s = needStore();
        if (preview) {
          const queued = sleepAgent.peekQueue();
          if (queued.length === 0) return 'Preview sleep consolidate v16: queue dang trong — khong co turn nao de xem truoc.';
          const result = previewConsolidationM16(s, queued);
          const lines = [
            `Preview sleep consolidate v16 (dry-run, khong ghi): ${result.turns} turn, ${result.extracted} fact trich — ` +
              `${result.counts.add} add / ${result.counts.update} update / ${result.counts.delete} delete / ${result.counts.ignore} ignore.`,
          ];
          for (const p of result.plans) {
            lines.push(`  - [${p.decision}] ${p.candidate.subject} ${p.candidate.predicate}: ${p.candidate.objectText} — ${p.reason}`);
          }
          return lines.join('\n');
        }
        const report = sleepAgent.run(
          s,
          { ...(idleMs !== undefined ? { idleMs } : {}), force, actor: actorOf(ctx) },
          blockStore,
        );
        const lines = [report.ran ? `Sleep consolidate v16: ${report.reason}` : `Sleep consolidate v16 khong chay: ${report.reason}`];
        for (const a of report.actions) lines.push(`  - ${a}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const extractFuse: Tool = {
    definition: toolDef(
      'memory_v16_extract_fuse',
      'Extract facts from one text (rule-based, Vietnamese/English: name, lives_in, works_at, likes, dislikes, prefers, speaks, has_pet, owns, goal, favorites + retraction patterns) and fuse them into the graph in the given scope (user/agent/session/shared) with ADD/UPDATE/DELETE/IGNORE. Contradictions on single-valued predicates supersede the old fact (history kept); retractions invalidate it. Needs approval.',
      {
        text: { type: 'string', description: 'Noi dung can trich fact.' },
        scope: { type: 'string', description: 'Scope fuse: "user" (mac dinh) | "agent" | "session" | "shared".' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
        sessionId: { type: 'string', description: 'Session ghi fact (khi scope=session).' },
        sourceTrust: { type: 'number', description: 'Do tin cay nguon 0..1 (mac dinh 1).' },
        minConfidence: { type: 'number', description: 'Nguong tin cay toi thieu de fuse (mac dinh 0.5).' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const text = getStringArg(args, 'text');
        const scopeArg = getOptionalStringArg(args, 'scope') ?? 'user';
        if (!M16_SCOPES.has(scopeArg)) throw new Error(`Scope khong hop le: "${scopeArg}" (user/agent/session/shared).`);
        const scope = scopeArg as M16Scope;
        const baseScope = scopeOf(args);
        const sourceTrust = getNumberArg(args, 'sourceTrust');
        const minConfidence = getNumberArg(args, 'minConfidence');
        const candidates = extractFactsM16Sync(text, {
          scope,
          ...(sourceTrust !== undefined ? { sourceTrust } : {}),
        });
        if (candidates.length === 0) return 'Extract v16: khong trich duoc fact nao tu text nay.';
        const lines = [`Extract v16: trich duoc ${candidates.length} fact, dang fuse (scope ${scope})...`];
        for (const c of candidates) {
          const result = applyFuseM16(s, c, baseScope, {
            actor: actorOf(ctx),
            ...(minConfidence !== undefined ? { minConfidence } : {}),
            ledger,
          });
          lines.push(`  - [${result.decision}] ${c.subject} ${c.predicate}: ${c.objectText} — ${result.reason}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const validitySet: Tool = {
    definition: toolDef(
      'memory_v16_validity_set',
      'Manage temporal validity of a fact in memory v16: set (set/override the validity window in the ledger), expire (close the window at a time), extend (push validUntil later or clear it), replace (supersede the old fact with a new one, keeping window history). History is never deleted. Needs approval.',
      {
        action: { type: 'string', description: '"set" | "expire" | "extend" | "replace".' },
        factId: { type: 'string', description: 'Id fact can doi hieu luc (set/expire/extend) hoac fact cu can thay the (replace).' },
        validFrom: { type: 'string', description: 'Cua so bat dau (ISO) — dung cho set/replace.' },
        validUntil: { type: 'string', description: 'Cua so ket thuc (ISO, rong = vo han) — dung cho set/extend/replace.' },
        at: { type: 'string', description: 'Thoi diem het han (ISO) — dung cho expire.' },
        subjectName: { type: 'string', description: 'Ten subject — bat buoc khi replace.' },
        predicate: { type: 'string', description: 'Predicate — bat buoc khi replace.' },
        objectText: { type: 'string', description: 'Object moi — bat buoc khi replace.' },
        reason: { type: 'string', description: 'Ly do doi hieu luc.' },
      },
      ['action', 'factId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        const factId = getStringArg(args, 'factId');
        const validFrom = getOptionalStringArg(args, 'validFrom');
        const validUntil = getOptionalStringArg(args, 'validUntil');
        const at = getOptionalStringArg(args, 'at');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const actor = actorOf(ctx);
        if (action === 'set') {
          if (!validFrom) throw new Error('set can co validFrom (ISO).');
          const record = ledger.set(
            factId,
            { validFrom, validUntil: validUntil === '' ? null : (validUntil ?? null) },
            actor,
            reason,
          );
          return `Validity v16: fact ${factId} hieu luc ${record.validFrom} → ${record.validUntil ?? '∞'} (${reason || 'khong ro ly do'}).`;
        }
        if (action === 'expire') {
          if (!at) throw new Error('expire can co at (ISO).');
          const record = ledger.expire(factId, at, actor, reason);
          return `Validity v16: fact ${factId} het hieu luc tai ${record.validUntil}.`;
        }
        if (action === 'extend') {
          const record = ledger.extend(factId, validUntil === '' ? null : (validUntil ?? null), actor, reason);
          return `Validity v16: fact ${factId} gia han hieu luc toi ${record.validUntil ?? '∞'}.`;
        }
        if (action === 'replace') {
          const subjectName = getStringArg(args, 'subjectName');
          const predicate = getStringArg(args, 'predicate');
          const objectText = getStringArg(args, 'objectText');
          const baseScope = scopeOf(args);
          const oldFact = s.getFact(factId);
          if (!oldFact) throw new Error(`Khong tim thay fact ${factId}.`);
          const result = replaceFactM16(
            s,
            factId,
            {
              subjectName,
              predicate,
              objectText,
              scope: { userId: baseScope.userId || oldFact.scope.userId, botId: baseScope.botId || oldFact.scope.botId, runId: baseScope.runId || oldFact.scope.runId },
              sourceText: reason || `replace fact ${factId}`,
            },
            {
              ...(validFrom || validUntil
                ? { window: { validFrom: validFrom ?? new Date().toISOString(), validUntil: validUntil === '' ? null : (validUntil ?? null) } }
                : {}),
              actor,
              reason,
              ledger,
            },
          );
          return (
            `Validity v16: fact cu ${result.oldFact.id} (${result.oldFact.objectText ?? ''}) da superseded; ` +
            `fact moi ${result.newFact.id} (${result.newFact.objectText}) hieu luc ${result.newWindow.validFrom} → ${result.newWindow.validUntil ?? '∞'}.`
          );
        }
        throw new Error(`Action validity khong hop le: "${action}" (set/expire/extend/replace).`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const validityQuery: Tool = {
    definition: toolDef(
      'memory_v16_validity_query',
      'Query temporal validity in memory v16: facts valid at a time T, facts expiring soon, already-expired facts, a full expiry sweep, a per-status validity report, or the validity timeline of one fact. Read-only.',
      {
        action: { type: 'string', description: '"valid_at" | "expiring_soon" | "expired" | "sweep" | "report" | "timeline" (mac dinh "valid_at").' },
        at: { type: 'string', description: 'Thoi diem truy van (ISO, mac dinh: bay gio).' },
        factId: { type: 'string', description: 'Id fact — bat buoc khi timeline.' },
        withinDays: { type: 'number', description: 'So ngay toi cho expiring_soon/sweep (mac dinh 7).' },
        userId: { type: 'string', description: 'Loc theo user.' },
        botId: { type: 'string', description: 'Loc theo bot.' },
        runId: { type: 'string', description: 'Loc theo run.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'valid_at';
        const at = getOptionalStringArg(args, 'at');
        const factId = getOptionalStringArg(args, 'factId');
        const withinDays = getNumberArg(args, 'withinDays') ?? 7;
        const scope = scopeOf(args);
        const now = at ? new Date(at) : new Date();
        if (Number.isNaN(now.getTime())) throw new Error(`Thoi gian khong hop le: "${at}".`);
        if (action === 'timeline') {
          if (!factId) throw new Error('timeline can co factId.');
          const fact = s.getFact(factId);
          if (!fact) throw new Error(`Khong tim thay fact ${factId}.`);
          return formatValidityTimelineM16(fact, ledger, now);
        }
        if (action === 'expiring_soon') {
          const soon = factsExpiringSoonM16(s, withinDays * 24 * 60 * 60 * 1000, now, { scope, ledger });
          const lines = [`Fact sap het han trong ${withinDays} ngay: ${soon.length}.`];
          for (const e of soon) {
            lines.push(`  - ${e.fact.id}: ${e.fact.predicate} = ${e.fact.objectText ?? ''} (het han sau ${Math.round(e.msLeft / 3600000)} gio).`);
          }
          return lines.join('\n');
        }
        if (action === 'expired') {
          const expired = expiredFactsM16(s, now, { scope, ledger });
          const lines = [`Fact da het han: ${expired.length}.`];
          for (const e of expired) {
            lines.push(`  - ${e.fact.id}: ${e.fact.predicate} = ${e.fact.objectText ?? ''} (het han luc ${e.expiredAt}).`);
          }
          return lines.join('\n');
        }
        if (action === 'sweep') {
          const report = sweepExpiredM16(s, { withinMs: withinDays * 24 * 60 * 60 * 1000, now, scope, ledger });
          return (
            `Expiry sweep v16 tai ${report.at}: quet ${report.scanned} fact, ${report.expired} da het han, ` +
            `${report.expiringSoon} sap het han trong ${withinDays} ngay.`
          );
        }
        if (action === 'report') {
          const report = validityReportM16(s, { withinMs: withinDays * 24 * 60 * 60 * 1000, now, scope, ledger });
          return formatValidityReportM16(report);
        }
        if (action === 'valid_at') {
          const result = factsValidAtM16(s, now, { scope, ledger });
          const lines = [`Fact dung tai ${result.at}: ${result.facts.length}.`];
          for (const e of result.facts.slice(0, 50)) {
            lines.push(
              `  - ${e.fact.id}: ${e.fact.predicate} = ${e.fact.objectText ?? ''} ` +
                `(${e.window.validFrom} → ${e.window.validUntil ?? '∞'}).`,
            );
          }
          return lines.join('\n');
        }
        throw new Error(`Action validity query khong hop le: "${action}".`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const archivalRecall: Tool = {
    definition: toolDef(
      'memory_v16_archival_recall',
      'Recall cold facts from the v16 archival store: ranks by 4 signals (IDF-weighted token overlap + recency decay + importance + access boost) in weighted or RRF mode. Optional asOf filters out records expired at that time. Read-only.',
      {
        query: { type: 'string', description: 'Cau hoi / tu khoa tim kiem trong kho lanh.' },
        topK: { type: 'number', description: 'So ket qua toi da (mac dinh 10).' },
        mode: { type: 'string', description: '"weighted" (mac dinh) hoac "rrf".' },
        asOf: { type: 'string', description: 'Chi lay record dung tai thoi diem ISO nay.' },
        predicate: { type: 'string', description: 'Loc theo predicate (vd "likes").' },
        minScore: { type: 'number', description: 'Diem toi thieu (mac dinh 0).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query');
        const topK = getNumberArg(args, 'topK');
        const mode = getOptionalStringArg(args, 'mode') as 'weighted' | 'rrf' | undefined;
        const asOf = getOptionalStringArg(args, 'asOf');
        const predicate = getOptionalStringArg(args, 'predicate');
        const minScore = getNumberArg(args, 'minScore');
        const result = archivalRecallM16(archivalStore, query, {
          ...(topK !== undefined ? { topK } : {}),
          ...(mode === 'weighted' || mode === 'rrf' ? { mode } : {}),
          ...(asOf ? { asOf } : {}),
          ...(predicate ? { predicate } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
        });
        const lines = [`Archival recall v16: "${query}" — ${result.hits.length}/${result.total} record.`];
        for (const h of result.hits) {
          lines.push(
            `  #${h.rank} [${h.score.toFixed(3)}] ${h.record.subject} ${h.record.predicate}: ${h.record.objectText} ` +
              `(text ${h.scores.text.toFixed(2)}, recency ${h.scores.recency.toFixed(2)}, importance ${h.scores.importance.toFixed(2)}, access ${h.scores.access.toFixed(2)}, mo ${h.record.accessCount} lan)`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const archivalPromote: Tool = {
    definition: toolDef(
      'memory_v16_archival_promote',
      'Move facts between the active graph and the v16 archival store: promote (bring an archival record back to the active graph, removing it from cold storage), archive (move an active fact down to cold storage, keeping provenance + validity window), archive_expired (bulk-archive every fact already expired at now), or suggest (list active facts that are good archival candidates: stale or expired with low confidence). Needs approval.',
      {
        action: { type: 'string', description: '"promote" | "archive" | "archive_expired" | "suggest".' },
        archivalId: { type: 'string', description: 'Id record archival — bat buoc khi promote.' },
        factId: { type: 'string', description: 'Id fact trong graph — bat buoc khi archive.' },
        reason: { type: 'string', description: 'Ly do promote/archive.' },
        withinDays: { type: 'number', description: 'So ngay toi cho archive_expired (mac dinh 7).' },
        olderThanDays: { type: 'number', description: 'So ngay khong cap nhat toi thieu cho suggest (mac dinh 180).' },
        maxConfidence: { type: 'number', description: 'Do tin cay toi da cho suggest (mac dinh 0.7).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        const archivalId = getOptionalStringArg(args, 'archivalId');
        const factId = getOptionalStringArg(args, 'factId');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const withinDays = getNumberArg(args, 'withinDays') ?? 7;
        const actor = actorOf(ctx);
        if (action === 'suggest') {
          const olderThanDays = getNumberArg(args, 'olderThanDays');
          const maxConfidence = getNumberArg(args, 'maxConfidence');
          const candidates = suggestArchivalCandidatesM16(s, {
            ...(olderThanDays !== undefined ? { olderThanDays } : {}),
            ...(maxConfidence !== undefined ? { maxConfidence } : {}),
          });
          const lines = [`Archival candidates v16: ${candidates.length} fact nen dua xuong kho lanh.`];
          for (const c of candidates.slice(0, 20)) {
            lines.push(`  - ${c.fact.id}: ${c.fact.predicate} = ${c.fact.objectText ?? ''} (${c.reason}).`);
          }
          return lines.join('\n');
        }
        if (action === 'promote') {
          if (!archivalId) throw new Error('promote can co archivalId.');
          const fact = promoteArchivedToGraphM16(s, archivalStore, archivalId, actor);
          return `Archival promote v16: record ${archivalId} da tro lai graph thanh fact ${fact.id} (${fact.predicate} = ${fact.objectText ?? ''}).`;
        }
        if (action === 'archive') {
          if (!factId) throw new Error('archive can co factId.');
          const fact = s.getFact(factId);
          if (!fact) throw new Error(`Khong tim thay fact ${factId}.`);
          const record = archivalStore.archiveFact(fact, actor, reason || 'archive thu cong');
          return `Archival v16: fact ${factId} da xuong kho lanh thanh record ${record.id} (fact goc van giu trong graph — dung delete neu muon xoa).`;
        }
        if (action === 'archive_expired') {
          const expired = expiredFactsM16(s, new Date(), { ledger });
          const result = archiveExpiredFactsM16(archivalStore, expired.map((e) => e.fact), actor, reason || 'het han — dua xuong archival');
          return `Archival v16: archive_expired — ${result.archived} fact het han da xuong kho lanh, ${result.skipped} da co san (bo qua).`;
        }
        throw new Error(`Action archival khong hop le: "${action}" (promote/archive/archive_expired/suggest).`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sleepReorganize: Tool = {
    definition: toolDef(
      'memory_v16_sleep_reorganize',
      'Run the v16 sleep-time block reorganizer: merges small blocks of the same kind, truncates over-limit blocks, extractively summarizes long blocks — but NEVER touches a PINNED block (pinned blocks are logged as protected). Only runs when idle long enough unless forced. Needs approval.',
      {
        idleMs: { type: 'number', description: 'Thoi gian idle (ms) — du nguong 5 phut moi chay neu khong force.' },
        force: { type: 'boolean', description: 'true = chay ngay ca khi chua idle (mac dinh false).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const idleMs = getNumberArg(args, 'idleMs');
        const force = getBoolArg(args, 'force', false);
        const report = runSleepReorganizeM16(blockStore, {
          ...(idleMs !== undefined ? { idleMs } : {}),
          force,
          actor: actorOf(ctx),
        });
        const lines = [report.ran ? `Sleep reorganize v16: ${report.reason}` : `Sleep reorganize v16 khong chay: ${report.reason}`];
        for (const a of report.actions) {
          lines.push(`  - [${a.action}] ${a.label}: ${a.detail}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'memory_v16_eval',
      'Run the memory v16 eval (40 fixed offline cases: 11 blocks + 11 fuse + 9 validity + 9 archival) and return per-category PASS rates with PASS/FAIL against thresholds. No model, no network.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const result = await runM16Eval();
        return formatM16EvalReport(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    coreMemoryReplace,
    blockEdit,
    blockList,
    blockPin,
    blockAudit,
    sleepConsolidate,
    extractFuse,
    validitySet,
    validityQuery,
    archivalRecall,
    archivalPromote,
    sleepReorganize,
    evalTool,
  ];
}

/** Ten tool memory v16 (thu tu nhu createMemoryV16Tools tra ve). */
export const MEMORY_V16_TOOL_NAMES = [
  'memory_v16_core_memory_replace',
  'memory_v16_block_edit',
  'memory_v16_block_list',
  'memory_v16_block_pin',
  'memory_v16_block_audit',
  'memory_v16_sleep_consolidate',
  'memory_v16_extract_fuse',
  'memory_v16_validity_set',
  'memory_v16_validity_query',
  'memory_v16_archival_recall',
  'memory_v16_archival_promote',
  'memory_v16_sleep_reorganize',
  'memory_v16_eval',
] as const;

/**
 * Placeholder (unbound) cua 13 tool memory v16 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V16_TOOLS: Tool[] = createMemoryV16Tools();
