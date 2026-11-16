/**
 * Memory v15 tools for @open-bot/tools (v1.16, Doi T1).
 *
 * Agent lam viec voi memory v15 bang tool call:
 *  - memory_v15_consolidate      — trich fact 1 pass (rule + mock LLM tuy chon), qua judge poisoning, append ADD-ONLY vao temporal KG, mau thuan chi ghi lai (needsApproval: true)
 *  - memory_v15_search           — hybrid search 4 tin hieu (semantic + BM25 + graph 2-hop + recency), co resolveSuperseded (read)
 *  - memory_v15_state_at         — tri thuc dung tai thoi diem T + timeline (read)
 *  - memory_v15_time_travel      — time-travel: dung tai validAt theo nhung gi he thong biet tai txAt (read)
 *  - memory_v15_block_edit       — agent tu edit memory block (create/replace/append/insert/delete_range/delete) co validation (needsApproval: true)
 *  - memory_v15_block_list       — liet ke block + compile <memory_blocks> preview (read)
 *  - memory_v15_sleep_reorganize — sleep-time reorganizer: gop/truncate/summarize block luc idle (needsApproval: true)
 *  - memory_v15_eval             — chay eval 40 case, tra so lieu recall/precision/block rate (read)
 *
 * SAFETY: consolidate mac dinh bat judge poisoning (applyJudge=true):
 * ung vien doc hai vao quarantine chu khong vao do thi. Block edit
 * validate chat (gioi han 8000 ky tu/block, cam tag <memory_blocks>).
 * Khong goi model that, khong goi API ngoai (mock LLM chi la regex
 * xac dinh). Block store mac dinh nam trong bo nho cua factory (host
 * co the truyen blockStore rieng de luu lau dai).
 *
 * Factory:
 *   createMemoryV15Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V15_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  TemporalGraphStore,
  V15MockLlmExtractor,
  V15BlockStore,
  consolidateTurnsV15,
  resolveCurrentV15,
  hybridSearchV15,
  factsValidAtV15,
  factTimelineV15,
  formatTimelineV15,
  timeTravelQueryV15,
  applyBlockEditV15,
  compileBlocksV15,
  runSleepReorganizeV15,
  gateExtractedV15,
  quarantineExtractedV15,
  runV15Eval,
  formatV15EvalReport,
} from '@open-bot/core';
import type { V15BlockKind, V15BlockEditAction } from '@open-bot/core';

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

export interface MemoryV15ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound neu khong co graphStore). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam). */
  graphStore?: TemporalGraphStore;
  /** Block store da tao san (test/host luu lau dai; mac dinh: store RAM moi). */
  blockStore?: V15BlockStore;
  /** Bot id goi tool (dung lam actor). */
  botId?: string;
}

export function createMemoryV15Tools(opts: MemoryV15ToolOptions = {}): Tool[] {
  const store =
    opts.graphStore ?? (opts.workspaceDir ? TemporalGraphStore.fromWorkspace(opts.workspaceDir) : undefined);
  const blockStore = opts.blockStore ?? new V15BlockStore();
  const defaultBotId = opts.botId;

  const needStore = (): TemporalGraphStore => {
    if (!store) {
      throw new Error(
        'memory v15 chưa được hỗ trợ trong phiên này (host phải truyền graphStore hoặc workspaceDir vào createMemoryV15Tools).',
      );
    }
    return store;
  };
  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };

  const consolidate: Tool = {
    definition: toolDef(
      'memory_v15_consolidate',
      'Consolidate conversation turns into memory v15 (Mem0-v3 style): single-pass extraction (rule-based + optional mock-LLM patterns), then APPEND-ONLY into the temporal knowledge graph — never updates/deletes old facts at write time; contradictions are recorded as coexisting and resolved only at retrieval time. By default every candidate passes the poisoning judge (OWASP ASI06): risky ones go to quarantine instead of the graph. Returns counts of appended / coexisting / retracted / quarantined / dropped facts. Needs approval.',
      {
        text: { type: 'string', description: 'Noi dung turn hoi thoai can trich fact.' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
        sourceTrust: { type: 'number', description: 'Do tin cay nguon 0..1 (mac dinh 1).' },
        sourceName: { type: 'string', description: 'Ten nguon (vd "user-chat", "web-scrape").' },
        useMockLlm: { type: 'boolean', description: 'true = them mock LLM extractor (xac dinh, offline).' },
        applyJudge: { type: 'boolean', description: 'true = bat judge poisoning (mac dinh true).' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const text = getStringArg(args, 'text');
        const userId = getOptionalStringArg(args, 'userId') ?? '';
        const botId = getOptionalStringArg(args, 'botId') ?? ctx?.botId ?? defaultBotId ?? '';
        const runId = getOptionalStringArg(args, 'runId') ?? '';
        const sourceTrust = getNumberArg(args, 'sourceTrust');
        const sourceName = getOptionalStringArg(args, 'sourceName');
        const useMockLlm = getBoolArg(args, 'useMockLlm', false);
        const applyJudge = getBoolArg(args, 'applyJudge', true);
        const scope = { userId, botId, runId };
        const report = await consolidateTurnsV15(
          s,
          [
            {
              text,
              userId,
              botId,
              runId,
              ...(sourceTrust !== undefined ? { sourceTrust } : {}),
              ...(sourceName ? { sourceName } : {}),
            },
          ],
          {
            actor: actorOf(ctx),
            ...(useMockLlm ? { llmExtractor: new V15MockLlmExtractor() } : {}),
            ...(applyJudge
              ? {
                  gate: (candidate, gateCtx) => {
                    const verdict = gateExtractedV15(gateCtx.store, candidate, gateCtx.scope);
                    return { decision: verdict.decision, reason: verdict.reason };
                  },
                  onGated: (candidate, decision, reason) => {
                    if (decision === 'quarantine') {
                      quarantineExtractedV15(s, candidate, scope, {
                        episodeId: '',
                        turnId: '',
                        runId,
                        botId,
                        userId,
                        at: new Date().toISOString(),
                        sourceText: candidate.sourceText,
                      }, reason);
                    }
                  },
                }
              : {}),
          },
        );
        const lines = [
          `Consolidate v15: ${report.appended.length} appended, ${report.duplicates.length} duplicates, ` +
            `${report.coexisting.length} coexisting (mau thuan, chua giai quyet), ${report.retracted.length} retracted, ` +
            `${report.gated.length} gated, ${report.dropped.length} dropped (llmCalls ${report.llmCalls}).`,
        ];
        for (const c of report.coexisting) {
          lines.push(
            `  Coexisting: "${c.candidate.objectText}" vs cu "${c.existingFact.objectText ?? ''}" ` +
              `(${c.candidate.subject}, ${c.candidate.predicate}) — retrieval se quyet.`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const search: Tool = {
    definition: toolDef(
      'memory_v15_search',
      'Hybrid search v15 over the temporal knowledge graph: fuses 4 signals (semantic cosine on a local hash embedding + BM25 keyword + graph proximity 0/1/2-hop + recency decay with 180-day half-life). Optional resolveSuperseded collapses single-valued groups to the retrieval-time winner. Quarantined facts and facts without provenance are excluded. Returns ranked facts with per-signal scores and an explanation.',
      {
        query: { type: 'string', description: 'Cau hoi / tu khoa tim kiem.' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
        topK: { type: 'number', description: 'So ket qua toi da (mac dinh 10).' },
        asOf: { type: 'string', description: 'Chi lay fact dung tai thoi diem ISO nay (mac dinh: bay gio).' },
        mode: { type: 'string', description: '"weighted" (mac dinh) hoac "rrf".' },
        resolveSuperseded: { type: 'boolean', description: 'true = collapse nhom don tri ve winner (mac dinh false).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const userId = getOptionalStringArg(args, 'userId') ?? '';
        const botId = getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '';
        const runId = getOptionalStringArg(args, 'runId') ?? '';
        const topK = getNumberArg(args, 'topK');
        const asOf = getOptionalStringArg(args, 'asOf');
        const modeRaw = getOptionalStringArg(args, 'mode');
        const mode = modeRaw === 'rrf' ? 'rrf' as const : 'weighted' as const;
        const resolveSuperseded = getBoolArg(args, 'resolveSuperseded', false);
        const result = await hybridSearchV15(s, query, {
          scope: { userId, botId, runId },
          ...(topK !== undefined ? { topK } : {}),
          ...(asOf ? { asOf } : {}),
          mode,
          resolveSuperseded,
        });
        if (result.hits.length === 0) {
          return `Khong tim thay fact nao cho "${query}" (${result.totalCandidates} ung vien, ` +
            `loai ${result.excludedQuarantined} quarantined, ${result.excludedNoProvenance} thieu provenance, ${result.excludedNotValidAt} het hieu luc).`;
        }
        const lines = [
          `Hybrid search v15 (${result.mode}, ${result.hits.length}/${result.totalCandidates} ung vien` +
            `${result.collapsedGroups > 0 ? `, collapse ${result.collapsedGroups} nhom` : ''}):`,
        ];
        for (const hit of result.hits) {
          lines.push(
            `  - ${hit.subjectName} —${hit.fact.predicate}→ ${hit.fact.objectText ?? ''} ` +
              `(total ${hit.scores.total.toFixed(3)}; ${hit.explanation})`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const stateAt: Tool = {
    definition: toolDef(
      'memory_v15_state_at',
      'What was true at time T (memory v15 temporal KG)? Lists facts valid at T (validity-window based, so superseded history still answers) plus the full timeline of a (subject, predicate) when given. Invalidated facts still answer for T before their invalidAt.',
      {
        at: { type: 'string', description: 'Thoi diem ISO can hoi (vd "2026-03-01T00:00:00.000Z").' },
        subject: { type: 'string', description: 'Chu the can xem timeline (tuy chon).' },
        predicate: { type: 'string', description: 'Vi ngu can loc/timeline (tuy chon).' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
      },
      ['at'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const at = getStringArg(args, 'at');
        const subject = getOptionalStringArg(args, 'subject');
        const predicate = getOptionalStringArg(args, 'predicate');
        const userId = getOptionalStringArg(args, 'userId') ?? '';
        const botId = getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '';
        const runId = getOptionalStringArg(args, 'runId') ?? '';
        const scope = { userId, botId, runId };
        const result = factsValidAtV15(s, at, scope, {
          ...(predicate ? { predicate } : {}),
          ...(subject ? { subject } : {}),
        });
        const lines = [`Fact dung tai ${result.at} (${result.facts.length}):`];
        for (const f of result.facts) {
          lines.push(`  - ${f.subjectName} —${f.fact.predicate}→ ${f.fact.objectText ?? ''} (tu ${f.fact.validFrom.slice(0, 10)})`);
        }
        if (subject && predicate) {
          const steps = factTimelineV15(s, subject, predicate, scope);
          lines.push(formatTimelineV15(steps, subject, predicate));
          const resolved = resolveCurrentV15(s, subject, predicate, scope, at);
          lines.push(
            resolved.winner
              ? `Hien dung tai ${at}: "${resolved.winner.objectText ?? ''}" (${resolved.supersededInView.length} fact cu thua o view).`
              : 'Khong co fact nao thang tai thoi diem nay.',
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const timeTravel: Tool = {
    definition: toolDef(
      'memory_v15_time_travel',
      'Time-travel query (memory v15 bi-temporal KG): what was true at validAt, according to what the system already knew at txAt? Facts created after txAt are excluded (counted as not-yet-known); validity windows still decide what was true at validAt.',
      {
        validAt: { type: 'string', description: 'Thoi diem the gioi that (ISO).' },
        txAt: { type: 'string', description: 'Thoi diem he thong (ISO, mac dinh: bay gio).' },
        subject: { type: 'string', description: 'Chu the can loc (tuy chon).' },
        predicate: { type: 'string', description: 'Vi ngu can loc (tuy chon).' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
      },
      ['validAt'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const validAt = getStringArg(args, 'validAt');
        const txAt = getOptionalStringArg(args, 'txAt');
        const subject = getOptionalStringArg(args, 'subject');
        const predicate = getOptionalStringArg(args, 'predicate');
        const userId = getOptionalStringArg(args, 'userId') ?? '';
        const botId = getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '';
        const runId = getOptionalStringArg(args, 'runId') ?? '';
        const result = timeTravelQueryV15(s, { userId, botId, runId }, {
          validAt,
          ...(txAt ? { txAt } : {}),
          ...(predicate ? { predicate } : {}),
          ...(subject ? { subject } : {}),
        });
        const lines = [
          `Time-travel: dung tai ${result.validAt} theo hieu biet luc ${result.txAt} ` +
            `(${result.facts.length} fact; loai ${result.excludedNotYetKnown} chua biet, ${result.excludedNotValid} khong dung):`,
        ];
        for (const f of result.facts) {
          lines.push(`  - ${f.subjectName} —${f.fact.predicate}→ ${f.fact.objectText ?? ''}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockEdit: Tool = {
    definition: toolDef(
      'memory_v15_block_edit',
      'Edit a versioned memory block v15 (Letta-style core memory) via a tool call: create / replace / append / insert / delete_range / delete. Every successful edit bumps the version and keeps the old snapshot in history (rollback possible). Validated: label format, 8000 chars/block max, 32 blocks max, no <memory_blocks> tags. Needs approval.',
      {
        action: { type: 'string', description: '"create" | "replace" | "append" | "insert" | "delete_range" | "delete".' },
        label: { type: 'string', description: 'Label block (vd "persona", "preferences").' },
        kind: { type: 'string', description: 'Kind khi create: "persona" | "human" | "task" | "system" | "custom".' },
        content: { type: 'string', description: 'Noi dung moi khi create/replace.' },
        text: { type: 'string', description: 'Text them/chen khi append/insert.' },
        position: { type: 'number', description: 'Vi tri chen (ky tu) khi insert.' },
        start: { type: 'number', description: 'Dau khoang xoa khi delete_range.' },
        end: { type: 'number', description: 'Cuoi khoang xoa (khong bao gom) khi delete_range.' },
        reason: { type: 'string', description: 'Ly do edit (luu vao history).' },
      },
      ['action', 'label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action') as V15BlockEditAction;
        const label = getStringArg(args, 'label');
        const kind = getOptionalStringArg(args, 'kind') as V15BlockKind | undefined;
        const content = getOptionalStringArg(args, 'content');
        const text = getOptionalStringArg(args, 'text');
        const position = getNumberArg(args, 'position');
        const start = getNumberArg(args, 'start');
        const end = getNumberArg(args, 'end');
        const reason = getOptionalStringArg(args, 'reason');
        const result = applyBlockEditV15(blockStore, {
          action,
          label,
          ...(kind ? { kind } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(position !== undefined ? { position } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
          ...(reason ? { reason } : {}),
        }, actorOf(ctx));
        if (result.deleted) return `Da xoa block "${label}".`;
        const b = result.block;
        return `Block "${label}" (${b?.kind}) — ${result.action} xong, version ${b?.version}, ${b?.content.length ?? 0} ky tu.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockList: Tool = {
    definition: toolDef(
      'memory_v15_block_list',
      'List versioned memory blocks v15 (label, kind, version, size, history length) and preview the compiled <memory_blocks> prompt text.',
      {
        kind: { type: 'string', description: 'Loc theo kind (tuy chon).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const kind = getOptionalStringArg(args, 'kind') as V15BlockKind | undefined;
        const blocks = blockStore.list(kind);
        if (blocks.length === 0) return 'Chua co memory block v15 nao.';
        const lines = [`Memory blocks v15 (${blocks.length}, tong ${blockStore.totalChars()} ky tu):`];
        for (const b of blocks) {
          lines.push(
            `  - [${b.kind}:${b.label}] v${b.version}, ${b.content.length} ky tu, ${b.history.length} version cu`,
          );
        }
        const compiled = compileBlocksV15(blockStore, {
          ...(kind ? { includeKinds: [kind] } : {}),
        });
        lines.push('Compiled preview:');
        lines.push(compiled.slice(0, 2000));
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sleepReorganize: Tool = {
    definition: toolDef(
      'memory_v15_sleep_reorganize',
      'Run the v15 sleep-time reorganizer (Letta-style background maintenance): merges small blocks of the same kind, truncates over-limit blocks (keeps head + tail), and extractively summarizes long blocks. Only runs when idle long enough unless forced. Every action bumps the block version, keeps history, and is logged. Needs approval.',
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
        const report = runSleepReorganizeV15(blockStore, {
          ...(idleMs !== undefined ? { idleMs } : {}),
          force,
          actor: actorOf(ctx),
        });
        const lines = [report.ran ? `Sleep reorganize v15: ${report.reason}` : `Sleep reorganize v15 khong chay: ${report.reason}`];
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
      'memory_v15_eval',
      'Run the memory v15 eval (40 fixed offline cases: 30 retrieval + 10 poisoning) and return answer-hit rate, support recall, precision, F1 per category, block rate and false-positive rate, with PASS/FAIL against thresholds. No model, no network.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const result = await runV15Eval();
        return formatV15EvalReport(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [consolidate, search, stateAt, timeTravel, blockEdit, blockList, sleepReorganize, evalTool];
}

/** Ten tool memory v15 (thu tu nhu createMemoryV15Tools tra ve). */
export const MEMORY_V15_TOOL_NAMES = [
  'memory_v15_consolidate',
  'memory_v15_search',
  'memory_v15_state_at',
  'memory_v15_time_travel',
  'memory_v15_block_edit',
  'memory_v15_block_list',
  'memory_v15_sleep_reorganize',
  'memory_v15_eval',
] as const;

/**
 * Placeholder (unbound) cua 8 tool memory v15 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V15_TOOLS: Tool[] = createMemoryV15Tools();
