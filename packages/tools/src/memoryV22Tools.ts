/**
 * Memory v22 tools for @open-bot/tools (v1.37, Doi T1).
 *
 * Agent lam viec voi dreaming consolidation bang tool call:
 *  - memory_v22_dream         — chay mot luot dream (gop/supersede/het han/pattern/wiki/budget) (needsApproval: true)
 *  - memory_v22_dream_config  — xem / doi cau hinh dreaming (lich, buoc, ngan sach, nguong) (needsApproval: true khi set)
 *  - memory_v22_dream_status  — trang thai scheduler + tom tat dream gan nhat (read)
 *  - memory_v22_dream_report  — bao cao dream day du (bang chung tung thay doi) (read)
 *  - memory_v22_fact          — CRUD fact trong dream store (needsApproval: true khi ghi)
 *  - memory_v22_wiki          — liet ke trang wiki / doc markdown mot trang (read)
 *  - memory_v22_budget        — ke hoach always-loaded: fact nao vao, fact nao bi cat va vi sao (read)
 *  - memory_v22_snapshot      — liet ke / chup snapshot truoc dream (needsApproval: true)
 *  - memory_v22_rollback      — rollback ve snapshot (khoi phuc dung trang thai luc chup) (needsApproval: true)
 *  - memory_v22_audit         — doc audit log append-only (read)
 *
 * SAFETY: dream khong bao gio xoa fact — chi doi status (co lich
 * su); moi dream deu chup snapshot truoc khi sua; rollback khoi
 * phuc dung snapshot (kiem tra hash). Dry-run mo phong tren ban
 * sao, khong ghi gi. Khong goi model, khong goi API ngoai.
 *
 * Factory:
 *   createMemoryV22Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V22_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  V22Dreamer,
  V22DreamStore,
  expiryStatsV22,
  findWikiPageForFactV22,
  resolveDreamConfigV22,
  summarizeBudgetChangeV22,
  supersedeHistoryV22,
  validateDreamConfigV22,
  type V22DreamConfig,
  type V22DreamTrigger,
  type V22TranscriptTurn,
} from '@open-bot/core';

export interface MemoryV22ToolOptions {
  dreamer?: V22Dreamer;
  store?: V22DreamStore;
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

function getJsonArg<T>(args: Record<string, unknown>, name: string, required = true): T | undefined {
  const raw = getOptionalStringArg(args, name);
  if (raw === undefined) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Argument "${name}" phai la JSON hop le`);
  }
}

const V22_TRIGGERS: readonly string[] = ['scheduled', 'steps', 'compaction', 'manual', 'memory_pressure'];

function formatReportSummaryV22(report: ReturnType<V22Dreamer['runDream']>): string {
  const lines: string[] = [];
  lines.push(`Dream ${report.jobId} (${report.trigger}${report.dryRun ? ', dry-run' : ''}) xong trong ${report.durationMs}ms.`);
  lines.push(`Fact active: ${report.factsBefore} -> ${report.factsAfter} (thu thap them ${report.factsCollected}); gop ${report.duplicatesMerged}, supersede ${report.factsSuperseded}, het han ${report.factsExpired}, pattern moi ${report.patternsCreated} / cap nhat ${report.patternsUpdated}, wiki ${report.wikiPages} trang.`);
  lines.push(summarizeBudgetChangeV22(report.budgetBefore, report.budgetAfter));
  if (report.snapshotId) lines.push(`Snapshot: ${report.snapshotId}.`);
  if (report.rolledBack) lines.push('CANH BAO: dream gap loi va da rollback ve snapshot.');
  if (report.errors.length > 0) lines.push(`Loi: ${report.errors.join('; ')}`);
  if (report.skipped.length > 0) lines.push(`Bo qua (${report.skipped.length}): ${report.skipped.slice(0, 5).join(' | ')}${report.skipped.length > 5 ? ' ...' : ''}`);
  if (report.changes.length > 0) {
    lines.push(`Thay doi (${report.changes.length}):`);
    for (const change of report.changes.slice(0, 10)) {
      lines.push(`- [${change.kind}] ${change.reason}`);
    }
    if (report.changes.length > 10) lines.push(`- ... va ${report.changes.length - 10} thay doi khac (xem memory_v22_dream_report).`);
  } else {
    lines.push('Khong co thay doi nao.');
  }
  return lines.join('\n');
}

export function createMemoryV22Tools(opts: MemoryV22ToolOptions = {}): Tool[] {
  const dreamer = opts.dreamer ?? new V22Dreamer({ store: opts.store });
  const store = dreamer.store;
  const defaultBotId = opts.botId;

  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'dream:v22';
  };

  const dreamTool: Tool = {
    definition: toolDef(
      'memory_v22_dream',
      'Chay mot luot dreaming consolidation: gop fact trung lap, supersede fact mau thuan, het han fact co thoi han, tong hop pattern lap lai, xay wiki, giu lop always-loaded duoi ngan sach. Truoc khi sua se chup snapshot de rollback. Dung dryRun=true de xem truoc ma khong ghi gi.',
      {
        trigger: { type: 'string', description: '"scheduled" | "steps" | "compaction" | "manual" | "memory_pressure".' },
        dryRun: { type: 'boolean', description: 'true = chi mo phong, khong ghi thay doi nao.' },
        configOverride: { type: 'string', description: 'JSON ghi de mot phan config chi cho lan chay nay (tuy chon).' },
        transcript: { type: 'string', description: 'JSON danh sach turn transcript [{role: "user"|"agent"|"system", text, sessionId?}] de phase collect nap ung vien fact (tuy chon).' },
      },
      ['trigger'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const triggerRaw = getStringArg(args, 'trigger');
        if (!V22_TRIGGERS.includes(triggerRaw)) {
          return errorResult(`trigger "${triggerRaw}" khong hop le (chi co ${V22_TRIGGERS.join(' | ')}).`);
        }
        const trigger = triggerRaw as V22DreamTrigger;
        const dryRun = getBoolArg(args, 'dryRun', false);
        const configOverride = getJsonArg<Partial<V22DreamConfig>>(args, 'configOverride', false);
        const transcriptTurns = getJsonArg<V22TranscriptTurn[]>(args, 'transcript', false);
        if (configOverride !== undefined) {
          try {
            resolveDreamConfigV22({ ...dreamer.getConfig(), ...configOverride });
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : String(e));
          }
        }
        if (!dreamer.getConfig().enabled && !dryRun) {
          return 'Dreaming dang tat (config.enabled=false) — bat len bang memory_v22_dream_config hoac chay dryRun de xem truoc.';
        }
        const report = dreamer.runDream(trigger, {
          dryRun,
          actor: actorOf(),
          ...(configOverride ? { configOverride } : {}),
          ...(transcriptTurns ? { transcriptTurns } : {}),
        });
        return formatReportSummaryV22(report);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const configTool: Tool = {
    definition: toolDef(
      'memory_v22_dream_config',
      'Xem (action=get) hoac doi (action=set, can duyet) cau hinh dreaming: bat/tat, khoang lich chay, nguong buoc, chay khi compaction, ngan sach ky tu always-loaded, nguong dedupe/supersede/pattern.',
      {
        action: { type: 'string', description: '"get" | "set".' },
        config: { type: 'string', description: 'JSON config rieng phan khi action=set (vd {"enabled": false, "stepsThreshold": 100}).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'get') {
          return JSON.stringify(dreamer.getConfig(), null, 2);
        }
        if (action === 'set') {
          const partial = getJsonArg<Partial<V22DreamConfig>>(args, 'config');
          if (!partial) return errorResult('Can JSON "config" khi action=set.');
          try {
            validateDreamConfigV22({ ...dreamer.getConfig(), ...partial });
          } catch (e) {
            return errorResult(e instanceof Error ? e.message : String(e));
          }
          const next = dreamer.updateConfig(partial);
          return `Da cap nhat cau hinh dreaming:\n${JSON.stringify(next, null, 2)}`;
        }
        return errorResult(`action "${action}" khong hop le (chi co get | set).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const statusTool: Tool = {
    definition: toolDef(
      'memory_v22_dream_status',
      'Trang thai scheduler dreaming: co dang chay khong, bao nhieu buoc ke tu lan dream cuoi, lan dream tiep theo du kien khi nao, tom tat dream gan nhat, thong ke han cua fact.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const state = dreamer.scheduler.getState();
        const stats = expiryStatsV22(store);
        const counts = store.countByStatus();
        const lines: string[] = [];
        lines.push(`Trang thai: ${state.status}; buoc ke tu lan dream cuoi: ${state.stepsSinceRun}.`);
        if (state.lastRunAt !== undefined) {
          lines.push(`Dream cuoi: ${new Date(state.lastRunAt).toISOString()} (trigger ${state.lastTrigger ?? '?'}).`);
        } else {
          lines.push('Chua dream lan nao.');
        }
        if (state.nextDueAt !== undefined) {
          lines.push(`Dream tiep theo (theo lich) du kien: ${new Date(state.nextDueAt).toISOString()}.`);
        }
        lines.push(`Fact: ${store.size()} tong (${counts.active} active, ${counts.superseded} superseded, ${counts.expired} het han, ${counts.merged} da gop, ${counts.invalidated} invalidated).`);
        lines.push(`Han: ${stats.withDeadline} fact co han, ${stats.expiringSoon} sap het han (7 ngay), ${stats.notYetValid} chua toi han hieu luc.`);
        if (state.lastError) lines.push(`Loi lan cuoi: ${state.lastError}`);
        const last = dreamer.getLastReport();
        if (last) {
          lines.push(`Dream gan nhat ${last.jobId}: gop ${last.duplicatesMerged}, supersede ${last.factsSuperseded}, het han ${last.factsExpired}, pattern ${last.patternsCreated}/${last.patternsUpdated}, wiki ${last.wikiPages} trang.`);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'memory_v22_dream_report',
      'Bao cao dream day du (JSON): bang chung tung thay doi (fact truoc/sau + ly do), do luong always-loaded truoc/sau, loi va muc bo qua. Mac dinh la bao cao dream gan nhat.',
      {
        detail: { type: 'boolean', description: 'true = tra full JSON (kem toan bo changes); false = chi tom tat.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const report = dreamer.getLastReport();
        if (!report) return 'Chua co dream nao chay — chay memory_v22_dream truoc.';
        const detail = getBoolArg(args, 'detail', false);
        if (!detail) return formatReportSummaryV22(report);
        return JSON.stringify(report, null, 2);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const factTool: Tool = {
    definition: toolDef(
      'memory_v22_fact',
      'CRUD fact trong dream store: create (ghi, can duyet), get, list (loc theo status/kind/topic/tag), setConfidence, setStatus (supersede/expire/merge/invalidate thu cong, can duyet), history (lich su thay the cua mot fact).',
      {
        action: { type: 'string', description: '"create" | "get" | "list" | "setConfidence" | "setStatus" | "history".' },
        id: { type: 'string', description: 'Id fact (get/setConfidence/setStatus/history).' },
        fact: { type: 'string', description: 'JSON fact khi create (text bat buoc; topic/value tuy chon de supersede).' },
        status: { type: 'string', description: 'Trang thai loc khi list, hoac trang thai moi khi setStatus.' },
        kind: { type: 'string', description: 'Loai loc khi list (fact/preference/decision/observation/pattern/note).' },
        topic: { type: 'string', description: 'Chu de loc khi list.' },
        tag: { type: 'string', description: 'Tag loc khi list.' },
        confidence: { type: 'number', description: 'Confidence moi khi setConfidence (0..1).' },
        supersededBy: { type: 'string', description: 'Id fact thang khi setStatus=superseded.' },
        mergedInto: { type: 'string', description: 'Id keeper khi setStatus=merged.' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'create') {
          const input = getJsonArg<Record<string, unknown>>(args, 'fact');
          if (!input || typeof input.text !== 'string') {
            return errorResult('Can JSON "fact" voi "text" khi create.');
          }
          const allowedKinds = ['fact', 'preference', 'decision', 'observation', 'pattern', 'note'];
          if (typeof input.kind === 'string' && !allowedKinds.includes(input.kind)) {
            return errorResult(`kind "${input.kind}" khong hop le (chi co ${allowedKinds.join(' | ')}).`);
          }
          const res = store.addFact({
            text: input.text,
            ...(typeof input.kind === 'string' ? { kind: input.kind as 'fact' } : {}),
            ...(typeof input.topic === 'string' ? { topic: input.topic } : {}),
            ...(typeof input.value === 'string' ? { value: input.value } : {}),
            ...(typeof input.confidence === 'number' ? { confidence: input.confidence } : {}),
            ...(Array.isArray(input.sources) ? { sources: input.sources as string[] } : {}),
            ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
            ...(Array.isArray(input.sessionIds) ? { sessionIds: input.sessionIds as string[] } : {}),
            ...(typeof input.validUntil === 'number' ? { validUntil: input.validUntil } : {}),
            ...(typeof input.validFrom === 'number' ? { validFrom: input.validFrom } : {}),
          });
          if (!res.ok || !res.data) return errorResult(res.error ?? 'Khong tao duoc fact.');
          return `Da tao fact ${res.data.id} (confidence ${res.data.confidence}, status active).`;
        }
        if (action === 'get') {
          const id = getStringArg(args, 'id');
          const fact = store.get(id);
          if (!fact) return errorResult(`khong co fact "${id}".`);
          return JSON.stringify(fact, null, 2);
        }
        if (action === 'list') {
          const status = getOptionalStringArg(args, 'status');
          const kind = getOptionalStringArg(args, 'kind');
          const topic = getOptionalStringArg(args, 'topic');
          const tag = getOptionalStringArg(args, 'tag');
          const facts = store.list({
            ...(status ? { status: status as 'active' } : {}),
            ...(kind ? { kind: kind as 'fact' } : {}),
            ...(topic ? { topic } : {}),
            ...(tag ? { tag } : {}),
          });
          if (facts.length === 0) return 'Khong co fact nao khop bo loc.';
          return facts.map((f) => `- ${f.id} [${f.kind}/${f.status}] conf ${f.confidence.toFixed(2)}: ${f.text.slice(0, 120)}`).join('\n');
        }
        if (action === 'setConfidence') {
          const id = getStringArg(args, 'id');
          const confidence = getNumberArg(args, 'confidence');
          if (confidence === undefined) return errorResult('Can "confidence" (0..1).');
          if (!store.setConfidence(id, confidence)) return errorResult(`khong co fact "${id}" hoac confidence khong hop le.`);
          return `Da doi confidence cua ${id} thanh ${confidence}.`;
        }
        if (action === 'setStatus') {
          const id = getStringArg(args, 'id');
          const status = getStringArg(args, 'status');
          if (!['active', 'superseded', 'expired', 'merged', 'invalidated'].includes(status)) {
            return errorResult(`status "${status}" khong hop le.`);
          }
          const ok = store.setStatus(id, status as 'active', {
            ...(getOptionalStringArg(args, 'supersededBy') ? { supersededBy: getOptionalStringArg(args, 'supersededBy') as string } : {}),
            ...(getOptionalStringArg(args, 'mergedInto') ? { mergedInto: getOptionalStringArg(args, 'mergedInto') as string } : {}),
          });
          if (!ok) return errorResult(`khong co fact "${id}".`);
          return `Da doi status cua ${id} thanh ${status}.`;
        }
        if (action === 'history') {
          const id = getStringArg(args, 'id');
          const history = supersedeHistoryV22(store, id);
          if (history.length === 0) return errorResult(`khong co fact "${id}" hoac fact chua co lich su thay the.`);
          return history.map((h) => `#${h.version} ${h.factId} [${h.status}] conf ${h.confidence.toFixed(2)}: ${h.text.slice(0, 100)}${h.isCurrent ? ' (hien tai)' : ''}`).join('\n');
        }
        return errorResult(`action "${action}" khong hop le.`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const wikiTool: Tool = {
    definition: toolDef(
      'memory_v22_wiki',
      'Doc wiki representation cua memory: list (liet ke trang + tom tat + so fact) hoac page (Markdown day du cua mot trang theo slug) hoac find (tim trang chua mot fact).',
      {
        action: { type: 'string', description: '"list" | "page" | "find".' },
        slug: { type: 'string', description: 'Slug trang khi action=page.' },
        factId: { type: 'string', description: 'Id fact khi action=find.' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const index = dreamer.getWikiIndex();
        if (!index) return 'Chua co wiki — chay memory_v22_dream truoc.';
        if (action === 'list') {
          if (index.pages.length === 0) return 'Wiki rong (khong co fact active).';
          return index.pages.map((p) => `- ${p.slug} — ${p.title}: ${p.summary} [${p.factIds.length} fact, ${p.links.length} link]`).join('\n');
        }
        if (action === 'page') {
          const slug = getStringArg(args, 'slug');
          const page = index.pages.find((p) => p.slug === slug);
          if (!page) return errorResult(`khong co trang wiki "${slug}".`);
          return page.markdown;
        }
        if (action === 'find') {
          const factId = getStringArg(args, 'factId');
          const page = findWikiPageForFactV22(index, factId);
          if (!page) return errorResult(`fact "${factId}" khong nam trong trang wiki nao.`);
          return `Fact ${factId} nam trong trang "${page.slug}" (${page.title}).`;
        }
        return errorResult(`action "${action}" khong hop le (chi co list | page | find).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const budgetTool: Tool = {
    definition: toolDef(
      'memory_v22_budget',
      'Ke hoach always-loaded: do luong lop always-loaded hien tai (ky tu / token uoc tinh / so fact), fact nao duoc chon, fact nao bi cat va vi sao, text ghep san de dua vao prompt.',
      {
        includeText: { type: 'boolean', description: 'true = kem text ghep san de dua vao prompt.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const plan = dreamer.getBudgetPlan();
        const lines: string[] = [];
        lines.push(`Always-loaded: ${plan.measurement.chars}/${plan.measurement.budgetChars} ky tu (~${plan.measurement.estimatedTokens} token), ${plan.measurement.factCount} fact${plan.measurement.withinBudget ? ' — vua ngan sach.' : ` — VUOT ngan sach ${plan.measurement.overByChars} ky tu.`}`);
        lines.push(`Duoc chon: ${plan.measurement.includedIds.join(', ') || '(rong)'}`);
        const excluded = Object.entries(plan.excludedReasons);
        if (excluded.length > 0) {
          lines.push(`Bi cat (${excluded.length}):`);
          for (const [id, reason] of excluded.slice(0, 10)) lines.push(`- ${id}: ${reason}`);
          if (excluded.length > 10) lines.push(`- ... va ${excluded.length - 10} fact khac.`);
        }
        if (getBoolArg(args, 'includeText', false) && plan.renderedText) {
          lines.push('--- text dua vao prompt ---');
          lines.push(plan.renderedText);
        }
        return lines.join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const snapshotTool: Tool = {
    definition: toolDef(
      'memory_v22_snapshot',
      'Snapshot memory truoc dream: list (liet ke snapshot + hash toan ven) hoac create (chup snapshot moi, can duyet). Rollback ve snapshot bang memory_v22_rollback.',
      {
        action: { type: 'string', description: '"list" | "create".' },
        reason: { type: 'string', description: 'Ly do chup khi action=create.' },
        label: { type: 'string', description: 'Nhan tu do khi action=create.' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const snaps = dreamer.snapshots.list();
          if (snaps.length === 0) return 'Chua co snapshot nao.';
          return snaps.map((s) => `- ${s.id} (${new Date(s.createdAt).toISOString()}, ${s.facts.length} fact, hash ${s.hash.slice(0, 12)}..., ly do: ${s.reason})`).join('\n');
        }
        if (action === 'create') {
          const snapshot = dreamer.snapshots.create(store, {
            actor: actorOf(),
            reason: getOptionalStringArg(args, 'reason') ?? 'snapshot thu cong',
            ...(getOptionalStringArg(args, 'label') ? { label: getOptionalStringArg(args, 'label') as string } : {}),
            wiki: dreamer.getWikiIndex(),
          });
          return `Da chup snapshot ${snapshot.id} (${snapshot.facts.length} fact, hash ${snapshot.hash.slice(0, 12)}...).`;
        }
        return errorResult(`action "${action}" khong hop le (chi co list | create).`);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const rollbackTool: Tool = {
    definition: toolDef(
      'memory_v22_rollback',
      'Rollback memory ve dung mot snapshot (khoi phuc fact + wiki luc chup; ban than rollback cung ghi vao audit log). Can duyet. Lay id snapshot tu memory_v22_snapshot list.',
      {
        snapshotId: { type: 'string', description: 'Id snapshot can khoi phuc (vd snap-...).' },
      },
      ['snapshotId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const snapshotId = getStringArg(args, 'snapshotId');
        const res = dreamer.rollbackToSnapshot(snapshotId, actorOf());
        if (!res.ok) return errorResult(res.error ?? 'Rollback that bai.');
        return `Da rollback ve snapshot ${snapshotId}: khoi phuc ${res.restoredFacts ?? 0} fact${res.wikiRestored ? ' + wiki' : ''}.`;
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const auditTool: Tool = {
    definition: toolDef(
      'memory_v22_audit',
      'Doc audit log append-only cua dreaming: moi dream / rollback / import deu ghi lai ai lam, khi nao, fact nao, snapshot nao. Loc theo actor, action, factId, snapshotId.',
      {
        actor: { type: 'string', description: 'Loc theo actor (tuy chon).' },
        action: { type: 'string', description: 'Loc theo action (vd dream:done, rollback).' },
        factId: { type: 'string', description: 'Loc theo factId (tuy chon).' },
        snapshotId: { type: 'string', description: 'Loc theo snapshotId (tuy chon).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const entries = dreamer.audit.list({
          ...(getOptionalStringArg(args, 'actor') ? { actor: getOptionalStringArg(args, 'actor') as string } : {}),
          ...(getOptionalStringArg(args, 'action') ? { action: getOptionalStringArg(args, 'action') as string } : {}),
          ...(getOptionalStringArg(args, 'factId') ? { factId: getOptionalStringArg(args, 'factId') as string } : {}),
          ...(getOptionalStringArg(args, 'snapshotId') ? { snapshotId: getOptionalStringArg(args, 'snapshotId') as string } : {}),
          limit: getNumberArg(args, 'limit') ?? 20,
        });
        if (entries.length === 0) return 'Audit log rong (chua co dream/rollback/import nao).';
        return entries.map((e) => `- ${e.id} ${new Date(e.at).toISOString()} ${e.actor} ${e.action}: ${e.detail}`).join('\n');
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [
    dreamTool,
    configTool,
    statusTool,
    reportTool,
    factTool,
    wikiTool,
    budgetTool,
    snapshotTool,
    rollbackTool,
    auditTool,
  ];
}

/** Ten tool memory v22 (thu tu nhu createMemoryV22Tools tra ve). */
export const MEMORY_V22_TOOL_NAMES = [
  'memory_v22_dream',
  'memory_v22_dream_config',
  'memory_v22_dream_status',
  'memory_v22_dream_report',
  'memory_v22_fact',
  'memory_v22_wiki',
  'memory_v22_budget',
  'memory_v22_snapshot',
  'memory_v22_rollback',
  'memory_v22_audit',
] as const;

/**
 * Placeholder (unbound) cua 10 tool memory v22 — nam trong ALL_TOOLS.
 * Goi factory khong co dreamer rieng; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V22_TOOLS: Tool[] = createMemoryV22Tools();
