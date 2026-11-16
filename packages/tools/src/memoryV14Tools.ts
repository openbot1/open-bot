/**
 * Memory v14 tools for @open-bot/tools (v1.15, Doi T1).
 *
 * Agent lam viec voi memory v14 bang tool call:
 *  - memory_v14_extract          — trich fact tu text (rule + mock LLM tuy chon), qua judge poisoning, ghi vao temporal KG (needsApproval: true)
 *  - memory_v14_fused_search     — retrieval fusion 3 tin hieu (semantic + BM25 + graph) (read)
 *  - memory_v14_state_at         — tri thuc dung tai thoi diem T + timeline (read)
 *  - memory_v14_quarantine_list  — liet ke quarantine + thong ke (read)
 *  - memory_v14_quarantine_review— duyet quarantine (approve/reject) (needsApproval: true)
 *  - memory_v14_erase            — GDPR erasure theo user/subject, co dry-run + verify (needsApproval: true)
 *  - memory_v14_eval             — chay eval 24 case, tra so lieu recall/precision/block rate (read)
 *
 * SAFETY: extract mac dinh bat judge poisoning (applyJudge=true):
 * ung vien doc hai vao quarantine chu khong vao do thi. Erase bat
 * buoc `confirm` trung khop target. Khong goi model that, khong goi
 * API ngoai (mock LLM chi la regex xac dinh).
 *
 * Factory:
 *   createMemoryV14Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V14_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  TemporalGraphStore,
  V14MockLlmExtractor,
  extractFactsV14Sync,
  applyExtractionV14,
  fusedRetrieveV14,
  factsValidAt,
  factTimelineV14,
  formatTimelineV14,
  judgeCandidateV14,
  quarantineCandidateV14,
  listQuarantineV14,
  quarantineStatsV14,
  reviewQuarantineV14,
  eraseUserV14,
  eraseSubjectV14,
  formatErasureReceiptV14,
  runV14Eval,
  formatV14EvalReport,
  V14_DEFAULT_FUSION_WEIGHTS,
} from '@open-bot/core';

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

export interface MemoryV14ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound neu khong co graphStore). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam). */
  graphStore?: TemporalGraphStore;
  /** Bot id goi tool (dung lam actor). */
  botId?: string;
}

export function createMemoryV14Tools(opts: MemoryV14ToolOptions = {}): Tool[] {
  const store =
    opts.graphStore ?? (opts.workspaceDir ? TemporalGraphStore.fromWorkspace(opts.workspaceDir) : undefined);
  const workspaceDir = opts.workspaceDir;
  const defaultBotId = opts.botId;

  const needStore = (): TemporalGraphStore => {
    if (!store) {
      throw new Error(
        'memory v14 chưa được hỗ trợ trong phiên này (host phải truyền graphStore hoặc workspaceDir vào createMemoryV14Tools).',
      );
    }
    return store;
  };
  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };

  const extract: Tool = {
    definition: toolDef(
      'memory_v14_extract',
      'Extract facts from a conversation turn into the temporal knowledge graph (memory v14): rule-based extraction plus optional mock-LLM patterns, temporal hints ("tu 2020"), retract intents ("khong con thich X nua"). By default every candidate passes the poisoning judge (OWASP ASI06): risky ones go to quarantine instead of the graph. Returns counts of appended / superseded / retracted / quarantined / dropped facts. Needs approval.',
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
        const trust =
          sourceTrust !== undefined
            ? sourceTrust
            : undefined;
        const report = await applyExtractionV14(
          s,
          [
            {
              text,
              userId,
              botId,
              runId,
              ...(trust !== undefined ? { sourceTrust: trust } : {}),
              ...(sourceName ? { sourceName } : {}),
            },
          ],
          {
            actor: actorOf(ctx),
            ...(useMockLlm ? { llmExtractor: new V14MockLlmExtractor() } : {}),
            ...(applyJudge
              ? {
                  gate: (candidate, gateCtx) => {
                    const verdict = judgeCandidateV14(gateCtx.store, candidate, gateCtx.scope);
                    if (verdict.decision === 'accept') {
                      return { decision: 'accept' as const, reason: verdict.reasons.join(' ') };
                    }
                    return { decision: verdict.decision, reason: verdict.reasons.join(' ') };
                  },
                  onGated: (candidate, decision, reason) => {
                    if (decision === 'quarantine') {
                      const verdict = judgeCandidateV14(s, candidate, scope);
                      quarantineCandidateV14(s, {
                        candidate,
                        scope,
                        provenance: {
                          episodeId: '',
                          turnId: '',
                          runId,
                          botId,
                          userId,
                          at: new Date().toISOString(),
                          sourceText: candidate.sourceText,
                        },
                        verdict,
                      });
                      void reason;
                    }
                  },
                }
              : {}),
          },
        );
        return JSON.stringify(
          {
            extracted: true,
            ruleCandidates: report.ruleCandidates,
            llmCandidates: report.llmCandidates,
            appended: report.appended.map((c) => `${c.subject} ${c.predicate} ${c.objectText}`),
            superseded: report.superseded.length,
            retracted: report.retracted.length,
            duplicates: report.duplicates.length,
            dropped: report.dropped.length,
            gated: report.gated.map((g) => ({ fact: `${g.candidate.subject} ${g.candidate.predicate} ${g.candidate.objectText}`, decision: g.decision, reason: g.reason })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const fusedSearch: Tool = {
    definition: toolDef(
      'memory_v14_fused_search',
      'Search memory with 3-signal fusion (memory v14): semantic embedding + BM25 keyword + graph (entity match = 1, 1-hop neighbour = 0.5). Modes: "weighted" (default) or "rrf". Filters by validity at "asOf" (default now). Returns ranked facts with per-signal scores and explanations. Read-only.',
      {
        query: { type: 'string', description: 'Cau hoi / tu khoa tim trong memory.' },
        topK: { type: 'number', description: 'So ket qua toi da (mac dinh 10).' },
        mode: { type: 'string', description: '"weighted" hoac "rrf" (mac dinh "weighted").' },
        asOf: { type: 'string', description: 'Thoi diem ISO de loc hieu luc (mac dinh bay gio).' },
        semanticWeight: { type: 'number', description: 'Trong so semantic (mac dinh 0.4).' },
        bm25Weight: { type: 'number', description: 'Trong so BM25 (mac dinh 0.35).' },
        graphWeight: { type: 'number', description: 'Trong so graph (mac dinh 0.25).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const topK = getNumberArg(args, 'topK');
        const mode = getOptionalStringArg(args, 'mode');
        const asOf = getOptionalStringArg(args, 'asOf');
        const semanticWeight = getNumberArg(args, 'semanticWeight');
        const bm25Weight = getNumberArg(args, 'bm25Weight');
        const graphWeight = getNumberArg(args, 'graphWeight');
        const res = await fusedRetrieveV14(s, query, {
          ...(topK !== undefined ? { topK } : {}),
          ...(mode === 'rrf' || mode === 'weighted' ? { mode } : {}),
          ...(asOf ? { asOf: new Date(asOf) } : {}),
          weights: {
            semantic: semanticWeight ?? V14_DEFAULT_FUSION_WEIGHTS.semantic,
            bm25: bm25Weight ?? V14_DEFAULT_FUSION_WEIGHTS.bm25,
            graph: graphWeight ?? V14_DEFAULT_FUSION_WEIGHTS.graph,
          },
        });
        return JSON.stringify(
          {
            query: res.query,
            mode: res.mode,
            candidates: res.candidates,
            hits: res.hits.map((h) => ({
              fact: `${h.subjectName} ${h.fact.predicate} ${h.objectName ?? h.fact.objectText ?? ''}`,
              scores: h.scores,
              ranks: h.ranks,
              sources: h.sources,
              validFrom: h.fact.validFrom,
              validUntil: h.fact.validUntil,
              confidence: h.fact.confidence,
              explanation: h.explanation,
            })),
            notes: res.notes,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stateAt: Tool = {
    definition: toolDef(
      'memory_v14_state_at',
      'Answer "what was true at time T?" (memory v14 temporal KG v3): facts valid at "at" (including superseded history), optionally filtered by subject/predicate, plus the full version timeline of a (subject, predicate). Read-only.',
      {
        at: { type: 'string', description: 'Thoi diem ISO can hoi (vd "2026-02-15T00:00:00.000Z").' },
        subject: { type: 'string', description: 'Subject can loc (vd "Lan").' },
        predicate: { type: 'string', description: 'Predicate can loc (vd "lives_in").' },
        includeTimeline: { type: 'boolean', description: 'true = kem timeline day du cua (subject, predicate).' },
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
        const includeTimeline = getBoolArg(args, 'includeTimeline', false);
        const state = factsValidAt(s, at, {
          ...(subject ? { subject } : {}),
          ...(predicate ? { predicate } : {}),
        });
        let timeline: string | undefined;
        if (includeTimeline && subject && predicate) {
          timeline = formatTimelineV14(factTimelineV14(s, subject, predicate));
        }
        return JSON.stringify(
          {
            at: state.at,
            summary: state.summary,
            totalValid: state.totalValid,
            facts: state.facts.map((f) => ({
              fact: `${f.subjectName} ${f.fact.predicate} ${f.objectText}`,
              validFrom: f.fact.validFrom,
              validUntil: f.fact.validUntil,
              status: f.fact.status,
              confidence: f.fact.confidence,
            })),
            ...(timeline ? { timeline } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quarantineList: Tool = {
    definition: toolDef(
      'memory_v14_quarantine_list',
      'List memory quarantine items (memory v14, OWASP ASI06 defence) with stats by status and reason: facts held for human review because they matched a suspicious pattern, contradicted a high-confidence fact, or came from an untrusted source. Read-only.',
      {
        status: { type: 'string', description: '"pending" | "approved" | "rejected" (mac dinh tat ca).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const status = getOptionalStringArg(args, 'status');
        const items = listQuarantineV14(
          s,
          status === 'pending' || status === 'approved' || status === 'rejected'
            ? { status }
            : {},
        );
        return JSON.stringify(
          {
            stats: quarantineStatsV14(s),
            items: items.map((q) => ({
              id: q.id,
              candidate: `${q.candidate.subjectName} ${q.candidate.predicate} ${q.candidate.objectText}`,
              reason: q.reason,
              detail: q.detail,
              status: q.status,
              createdAt: q.createdAt,
              ...(q.conflictingFactId ? { conflictingFactId: q.conflictingFactId } : {}),
              ...(q.reviewedBy ? { reviewedBy: q.reviewedBy } : {}),
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const quarantineReview: Tool = {
    definition: toolDef(
      'memory_v14_quarantine_review',
      'Review one quarantine item (memory v14): "approved" adds the candidate fact to the graph (superseding the conflicting fact if any); "rejected" only marks it rejected for audit, never entering the graph. Needs approval.',
      {
        id: { type: 'string', description: 'Id muc quarantine.' },
        decision: { type: 'string', description: '"approved" hoac "rejected".' },
        reviewedBy: { type: 'string', description: 'Ai duyet (vd user id) — bat buoc de audit.' },
      },
      ['id', 'decision', 'reviewedBy'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const id = getStringArg(args, 'id');
        const decision = getStringArg(args, 'decision');
        const reviewedBy = getStringArg(args, 'reviewedBy');
        if (decision !== 'approved' && decision !== 'rejected') {
          return errorResult('decision phai la "approved" hoac "rejected".');
        }
        const res = reviewQuarantineV14(s, id, decision, reviewedBy);
        return JSON.stringify(
          {
            reviewed: true,
            id: res.item.id,
            status: res.item.status,
            ...(res.fact
              ? { fact: `${s.getEntity(res.fact.subjectId)?.name ?? ''} ${res.fact.predicate} ${res.fact.objectText ?? ''}` }
              : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const erase: Tool = {
    definition: toolDef(
      'memory_v14_erase',
      'GDPR erasure (memory v14): HARD-delete all data of one user ("user") or about one subject ("subject") — facts (all statuses, embeddings included), episodes, quarantine items, orphan entities. Requires "confirm" exactly equal to the target. Use "dryRun"=true first to preview counts. Returns a receipt with verification (remaining must be 0). Needs approval.',
      {
        kind: { type: 'string', description: '"user" (xoa theo userId) hoac "subject" (xoa theo ten subject).' },
        target: { type: 'string', description: 'userId hoac ten subject can xoa.' },
        confirm: { type: 'string', description: 'Bat buoc trung khop target moi duoc xoa.' },
        dryRun: { type: 'boolean', description: 'true = chi dem, khong xoa that (mac dinh false).' },
      },
      ['kind', 'target', 'confirm'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const kind = getStringArg(args, 'kind');
        const target = getStringArg(args, 'target');
        const confirm = getStringArg(args, 'confirm');
        const dryRun = getBoolArg(args, 'dryRun', false);
        if (kind !== 'user' && kind !== 'subject') {
          return errorResult('kind phai la "user" hoac "subject".');
        }
        const receipt =
          kind === 'user'
            ? eraseUserV14(s, target, {
                confirm,
                actor: actorOf(ctx),
                dryRun,
                ...(workspaceDir ? { workspaceDir } : {}),
              })
            : eraseSubjectV14(s, target, {
                confirm,
                actor: actorOf(ctx),
                dryRun,
                ...(workspaceDir ? { workspaceDir } : {}),
              });
        return JSON.stringify(
          { receipt: formatErasureReceiptV14(receipt), counts: receipt.counts, verified: receipt.verified, remaining: receipt.remaining },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'memory_v14_eval',
      'Run the memory v14 eval set (24 cases: 16 retrieval + 8 poisoning) on a fresh in-memory store and report measured recall / precision / F1 and poisoning block rate + false-positive rate. Offline, no model, no network. Read-only.',
      {
        topK: { type: 'number', description: 'topK cho retrieval (mac dinh 5).' },
        mode: { type: 'string', description: 'Che do fusion: "weighted" hoac "rrf" (mac dinh "weighted").' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const topK = getNumberArg(args, 'topK');
        const mode = getOptionalStringArg(args, 'mode');
        const result = await runV14Eval(undefined, {
          ...(topK !== undefined ? { topK } : {}),
          ...(mode === 'rrf' || mode === 'weighted'
            ? { fusion: { mode } }
            : {}),
        });
        return JSON.stringify(
          {
            dataset: result.dataset,
            retrieval: {
              cases: result.retrieval.cases,
              answerHitRate: result.retrieval.answerHitRate,
              supportRecall: result.retrieval.supportRecall,
              precision: result.retrieval.precision,
              f1: result.retrieval.f1,
            },
            poisoning: {
              cases: result.poisoning.cases,
              blockRate: result.poisoning.blockRate,
              falsePositiveRate: result.poisoning.falsePositiveRate,
              decisionAccuracy: result.poisoning.decisionAccuracy,
            },
            report: formatV14EvalReport(result),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // Dung cho test nhanh: xem ung vien rule trich duoc tu text (khong ghi).
  const previewExtract: Tool = {
    definition: toolDef(
      'memory_v14_extract_preview',
      'Preview rule-based fact extraction (memory v14) for a text without writing anything: returns candidates with predicate, confidence, temporal hints and retract intents. Read-only.',
      {
        text: { type: 'string', description: 'Text can xem truoc trich xuat.' },
        sourceTrust: { type: 'number', description: 'Do tin cay nguon 0..1 (mac dinh 1).' },
      },
      ['text'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const text = getStringArg(args, 'text');
        const sourceTrust = getNumberArg(args, 'sourceTrust');
        const candidates = extractFactsV14Sync(text, sourceTrust ?? 1);
        return JSON.stringify(
          {
            candidates: candidates.map((c) => ({
              subject: c.subject,
              predicate: c.predicate,
              objectText: c.objectText,
              confidence: c.confidence,
              effectiveConfidence: c.effectiveConfidence,
              origin: c.origin,
              intent: c.intent,
              pattern: c.pattern,
              ...(c.validFrom ? { validFrom: c.validFrom } : {}),
              ...(c.validUntil ? { validUntil: c.validUntil } : {}),
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [extract, fusedSearch, stateAt, quarantineList, quarantineReview, erase, evalTool, previewExtract];
}

/** Ten tool memory v14 (thu tu nhu createMemoryV14Tools tra ve). */
export const MEMORY_V14_TOOL_NAMES = [
  'memory_v14_extract',
  'memory_v14_fused_search',
  'memory_v14_state_at',
  'memory_v14_quarantine_list',
  'memory_v14_quarantine_review',
  'memory_v14_erase',
  'memory_v14_eval',
  'memory_v14_extract_preview',
] as const;

/**
 * Placeholder (unbound) cua 8 tool memory v14 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V14_TOOLS: Tool[] = createMemoryV14Tools();
