/**
 * Memory v18 tools for @open-bot/tools (v1.19, Doi T1-TEST).
 *
 * Agent lam viec voi memory v18 bang tool call:
 *  - memory_v18_extract      — trich fact tu mot turn (xem truoc) hoac trich + ghi vao graph (needsApproval: true khi ghi)
 *  - memory_v18_retrieve     — truy van hybrid 3 tin hieu (semantic + BM25 + entity) kem giai thich diem (read)
 *  - memory_v18_block_edit   — sua block qua guardrail v3 (snapshot truoc khi sua, chan mau cam / xoa ca block / doi qua lon) (needsApproval: true)
 *  - memory_v18_block_rollback — khoi phuc block ve mot snapshot (needsApproval: true)
 *  - memory_v18_block_drift  — bao cao drift / snapshot / audit cua mot block (read)
 *  - memory_v18_correct      — hieu chinh mot fact (supersede, giu lich su) hoac xem timeline hieu chinh (needsApproval: true khi hieu chinh)
 *  - memory_v18_snapshot     — anh chup tri thuc "da biet tai R ve thoi diem T" (read)
 *  - memory_v18_screen       — sang loc ung vien fact (admit / quarantine / reject) + xem so trust + ghi ket qua duyet (needsApproval: true)
 *  - memory_v18_erase        — xoa du lieu GDPR (user / entity / time-range, soft / hard); mac dinh dryRun=true, chi xoa that khi dryRun=false (needsApproval: true)
 *  - memory_v18_sleep        — chay mot pass cung co luc ngu (gop fact trung, ha cap fact cu) (needsApproval: true)
 *  - memory_v18_eval         — chay eval nho dai han kieu LOCOMO tren store tam (khong dung store production) (read)
 *
 * SAFETY: moi fact ghi qua extraction deu mang provenance day du;
 * moi ung vien admit deu qua pipeline sang loc v18 (deny -> tiem
 * nhiem -> gate v16 -> mau thuan -> trust); erase that luon ghi
 * audit JSONL; eval khong bao gio seed vao store production.
 * Khong goi model that, khong goi API ngoai.
 *
 * Factory:
 *   createMemoryV18Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V18_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  V15BlockStore,
  V18BlockEditor,
  createBlockV18,
  extractV18,
  extractAndWriteV18,
  retrieveV18,
  explainHitV18,
  applyCorrectionV18,
  correctionTimelineV18,
  snapshotAtV18,
  explainBiTemporalViewV18,
  V18SourceTrustBook,
  screenCandidateV18,
  recordReviewOutcomeV18,
  eraseV18,
  readErasureAuditV18,
  runSleepConsolidationV18,
  buildV18LocomoDataset,
  seedV18LocomoDataset,
  runV18LocomoEval,
  formatV18LocomoReport,
} from '@open-bot/core';
import type { V15BlockEditAction, V15BlockEditOp, V15BlockKind, V18CorrectionRecord } from '@open-bot/core';

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

export interface MemoryV18ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound neu khong co graphStore). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam). */
  graphStore?: TemporalGraphStore;
  /** Block store da tao san (test/host luu lau dai; mac dinh: store RAM moi). */
  blockStore?: V15BlockStore;
  /** Bot id goi tool (dung lam actor). */
  botId?: string;
}

export function createMemoryV18Tools(opts: MemoryV18ToolOptions = {}): Tool[] {
  const store =
    opts.graphStore ?? (opts.workspaceDir ? TemporalGraphStore.fromWorkspace(opts.workspaceDir) : undefined);
  const blockStore = opts.blockStore ?? new V15BlockStore();
  const workspaceDir = opts.workspaceDir ?? '';
  const defaultBotId = opts.botId;
  const editor = new V18BlockEditor(blockStore);
  const trustBook = new V18SourceTrustBook();
  /** Correction records made through this factory (for timelines). */
  const corrections: V18CorrectionRecord[] = [];

  const needStore = (): TemporalGraphStore => {
    if (!store) {
      throw new Error(
        'memory v18 chưa được hỗ trợ trong phiên này (host phải truyền graphStore hoặc workspaceDir vào createMemoryV18Tools).',
      );
    }
    return store;
  };
  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };
  const scopeOf = (args: Record<string, unknown>): { userId: string; botId: string; runId: string } => ({
    userId: getOptionalStringArg(args, 'userId') ?? '',
    botId: getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '',
    runId: getOptionalStringArg(args, 'runId') ?? '',
  });

  const extract: Tool = {
    definition: toolDef(
      'memory_v18_extract',
      'Extract facts v18 from one turn: action "preview" lists candidates with provenance (no write); action "write" extracts and writes candidates above minConfidence into the graph (default 0.5). Needs approval when writing.',
      {
        action: { type: 'string', description: '"preview" (chi xem) hoac "write" (trich + ghi).' },
        text: { type: 'string', description: 'Text cua turn can trich.' },
        episodeId: { type: 'string', description: 'Id episode (tuy chon).' },
        turnId: { type: 'string', description: 'Id turn (tuy chon).' },
        userId: { type: 'string', description: 'User id (tuy chon).' },
        botId: { type: 'string', description: 'Bot id (tuy chon).' },
        runId: { type: 'string', description: 'Run id (tuy chon).' },
        sourceName: { type: 'string', description: 'Ten nguon (mac dinh "user-chat").' },
        sourceTrust: { type: 'number', description: 'Do tin cay nguon 0..1 (mac dinh 1).' },
        minConfidence: { type: 'number', description: 'Confidence toi thieu de ghi (mac dinh 0.5, chi khi write).' },
        userDisplayName: { type: 'string', description: 'Ten hien thi cua user, dung lam subject mac dinh (tuy chon).' },
      },
      ['action', 'text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        if (action !== 'preview' && action !== 'write') {
          throw new Error(`Action khong hop le: "${action}" (chi co "preview" | "write").`);
        }
        const input = {
          text: getStringArg(args, 'text'),
          episodeId: getOptionalStringArg(args, 'episodeId'),
          turnId: getOptionalStringArg(args, 'turnId'),
          userId: getOptionalStringArg(args, 'userId'),
          botId: getOptionalStringArg(args, 'botId'),
          runId: getOptionalStringArg(args, 'runId'),
          sourceName: getOptionalStringArg(args, 'sourceName'),
          sourceTrust: getNumberArg(args, 'sourceTrust'),
          userDisplayName: getOptionalStringArg(args, 'userDisplayName'),
        };
        if (action === 'preview') {
          const facts = extractV18(s, input);
          if (facts.length === 0) return 'Khong trich duoc fact nao tu turn nay.';
          const lines = [`Trich duoc ${facts.length} fact (xem truoc, chua ghi):`];
          for (const f of facts) {
            lines.push(
              `  - ${f.subjectName} —${f.predicate}→ ${f.objectText} (confidence ${f.confidence.toFixed(2)}, nguon ${f.provenance.sourceName})`,
            );
          }
          return lines.join('\n');
        }
        const minConfidence = getNumberArg(args, 'minConfidence');
        const report = extractAndWriteV18(s, { ...input, scope: scopeOf(args) }, { minConfidence });
        const lines = [`Da trich ${report.extracted} fact, ghi ${report.written} fact vao graph.`];
        for (const sk of report.skipped) {
          lines.push(`  Bo qua: ${sk.subjectName} —${sk.predicate}→ ${sk.objectText} (${sk.reason}).`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const retrieve: Tool = {
    definition: toolDef(
      'memory_v18_retrieve',
      'Hybrid retrieval v18 over the graph: combines semantic (0 without an embedder), BM25 and entity signals with configurable weights, and explains each hit (which signal led). Read-only.',
      {
        query: { type: 'string', description: 'Cau truy van.' },
        topK: { type: 'number', description: 'So hit toi da (mac dinh 10).' },
        minScore: { type: 'number', description: 'Diem tong hop toi thieu (mac dinh 0).' },
        predicate: { type: 'string', description: 'Chi lay predicate nay (tuy chon).' },
        userId: { type: 'string', description: 'User id (tuy chon).' },
        botId: { type: 'string', description: 'Bot id (tuy chon).' },
        runId: { type: 'string', description: 'Run id (tuy chon).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const hits = retrieveV18(s, query, scopeOf(args), {
          topK: getNumberArg(args, 'topK'),
          minScore: getNumberArg(args, 'minScore'),
          predicate: getOptionalStringArg(args, 'predicate'),
        });
        if (hits.length === 0) return 'Khong tim thay fact nao phu hop.';
        const lines = [`Tim thay ${hits.length} fact cho "${query}":`];
        for (const hit of hits) {
          const subjectName = s.getEntity(hit.fact.subjectId)?.name ?? '?';
          lines.push(`  - ${subjectName} —${hit.fact.predicate}→ ${hit.fact.objectText} (${explainHitV18(hit)})`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockEdit: Tool = {
    definition: toolDef(
      'memory_v18_block_edit',
      'Edit a memory block v18 through the drift guardrail: create / replace / append / insert / delete_range. Each edit is snapshotted first and audited; forbidden content, whole-block delete, and changes over 400 chars or 25% are rejected before any write. Needs approval.',
      {
        action: { type: 'string', description: '"create" | "replace" | "append" | "insert" | "delete_range".' },
        label: { type: 'string', description: 'Label block.' },
        kind: { type: 'string', description: 'Kind khi create: "persona" | "human" | "task" | "system" | "custom".' },
        content: { type: 'string', description: 'Noi dung moi khi create / replace.' },
        text: { type: 'string', description: 'Text them khi append / insert.' },
        position: { type: 'number', description: 'Vi tri chen khi insert.' },
        start: { type: 'number', description: 'Vi tri bat dau khi delete_range.' },
        end: { type: 'number', description: 'Vi tri ket thuc khi delete_range.' },
        reason: { type: 'string', description: 'Ly do sua (ghi vao audit, tuy chon).' },
      },
      ['action', 'label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action');
        const label = getStringArg(args, 'label');
        const actor = actorOf(ctx);
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        if (action === 'create') {
          const kind = getStringArg(args, 'kind') as V15BlockKind;
          const content = getStringArg(args, 'content');
          const block = createBlockV18(editor, label, kind, content, actor);
          return `Da tao block "${block.label}" (${block.kind}), ${block.content.length} ky tu, version ${block.version}.`;
        }
        if (!['replace', 'append', 'insert', 'delete_range'].includes(action)) {
          throw new Error(`Action khong hop le: "${action}".`);
        }
        const op: V15BlockEditOp = { action: action as V15BlockEditAction, label };
        if (action === 'replace') op.content = getStringArg(args, 'content');
        if (action === 'append' || action === 'insert') op.text = getStringArg(args, 'text');
        if (action === 'insert') op.position = getNumberArg(args, 'position');
        if (action === 'delete_range') {
          op.start = getNumberArg(args, 'start');
          op.end = getNumberArg(args, 'end');
        }
        const block = editor.edit(
          op,
          actor,
          reason,
        );
        return `Da sua block "${block.label}" (${action}), version ${block.version}, ${block.content.length} ky tu.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockRollback: Tool = {
    definition: toolDef(
      'memory_v18_block_rollback',
      'Roll a memory block v18 back to one of its snapshots (taken before each guarded edit). Lists snapshots first via memory_v18_block_drift action "snapshots". Needs approval.',
      {
        label: { type: 'string', description: 'Label block.' },
        snapshotId: { type: 'string', description: 'Id snapshot can khoi phuc.' },
      },
      ['label', 'snapshotId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const label = getStringArg(args, 'label');
        const snapshotId = getStringArg(args, 'snapshotId');
        const block = editor.rollback(label, snapshotId, actorOf(ctx));
        return `Da rollback block "${block.label}" ve snapshot ${snapshotId}, version ${block.version}.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockDrift: Tool = {
    definition: toolDef(
      'memory_v18_block_drift',
      'Inspect a memory block v18: action "drift" reports how far the block drifted from its original snapshot; "snapshots" lists saved snapshots; "audit" lists the edit audit log. Read-only.',
      {
        action: { type: 'string', description: '"drift" | "snapshots" | "audit".' },
        label: { type: 'string', description: 'Label block (bat buoc tru khi action = "audit").' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'audit') {
          const label = getOptionalStringArg(args, 'label');
          const entries = editor.listAudit(label);
          if (entries.length === 0) return 'Chua co audit sua block nao.';
          const lines = [`Audit sua block (${entries.length} dong):`];
          for (const e of entries) {
            lines.push(
              `  - [${e.at}] ${e.label} ${e.action} ${e.decision} (${e.changedChars} ky tu) — ${e.reason}`,
            );
          }
          return lines.join('\n');
        }
        const label = getStringArg(args, 'label');
        if (action === 'snapshots') {
          const snaps = editor.listSnapshots(label);
          if (snaps.length === 0) return `Block "${label}" chua co snapshot nao.`;
          const lines = [`Snapshot cua block "${label}" (${snaps.length}):`];
          for (const snap of snaps) {
            lines.push(`  - ${snap.id} (version ${snap.version}, ${snap.at}) — ${snap.reason}`);
          }
          return lines.join('\n');
        }
        if (action !== 'drift') throw new Error(`Action khong hop le: "${action}".`);
        const report = editor.driftReport(label);
        if (!report) return `Khong tim thay block "${label}".`;
        return (
          `Drift block "${report.label}": ${report.edits} lan sua, ${report.totalChangedChars} ky tu da doi, ` +
          `giu lai ${Math.round(report.originalLinesKept * 100)}% dong goc — ${report.verdict}.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const correct: Tool = {
    definition: toolDef(
      'memory_v18_correct',
      'Correct a fact v18 (bi-temporal): action "correct" supersedes the old fact with the true value and keeps the old version queryable in the past; action "timeline" shows the correction history of one edge. Needs approval when correcting.',
      {
        action: { type: 'string', description: '"correct" | "timeline".' },
        oldFactId: { type: 'string', description: 'Id fact cu khi correct.' },
        newObjectText: { type: 'string', description: 'Gia tri dung khi correct.' },
        reason: { type: 'string', description: 'Ly do hieu chinh (bat buoc khi correct).' },
        evidence: { type: 'string', description: 'Bang chung ngan (tuy chon).' },
        correctedAt: { type: 'string', description: 'Thoi diem hieu chinh ISO (mac dinh bay gio).' },
        subjectName: { type: 'string', description: 'Ten subject khi timeline.' },
        predicate: { type: 'string', description: 'Predicate khi timeline.' },
        userId: { type: 'string', description: 'User id (tuy chon).' },
        botId: { type: 'string', description: 'Bot id (tuy chon).' },
        runId: { type: 'string', description: 'Run id (tuy chon).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        if (action === 'timeline') {
          const subjectName = getStringArg(args, 'subjectName');
          const predicate = getStringArg(args, 'predicate');
          const steps = correctionTimelineV18(
            s,
            subjectName,
            predicate,
            corrections.filter((c) => c.subjectName === subjectName && c.predicate === predicate),
            scopeOf(args),
          );
          if (steps.length === 0) return `Khong co lich su nao cho ${subjectName} —${predicate}→.`;
          const lines = [`Timeline ${subjectName} —${predicate}→ (${steps.length} buoc):`];
          for (const step of steps) {
            lines.push(
              `  - ${step.objectText} (${step.status}, dung tu ${step.validFrom}${step.validUntil ? ` den ${step.validUntil}` : ''})${step.correctionReason ? ` — ${step.correctionReason}` : ''}`,
            );
          }
          return lines.join('\n');
        }
        if (action !== 'correct') throw new Error(`Action khong hop le: "${action}".`);
        const { fact, record } = applyCorrectionV18(s, getStringArg(args, 'oldFactId'), {
          newObjectText: getStringArg(args, 'newObjectText'),
          reason: getStringArg(args, 'reason'),
          evidence: getOptionalStringArg(args, 'evidence'),
          actor: actorOf(ctx),
          correctedAt: getOptionalStringArg(args, 'correctedAt'),
        });
        corrections.push(record);
        return (
          `Da hieu chinh fact: "${record.oldObjectText}" -> "${record.newObjectText}" ` +
          `(fact moi ${fact.id}, ly do: ${record.reason}). Ban cu van truy van duoc o qua khu.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const snapshot: Tool = {
    definition: toolDef(
      'memory_v18_snapshot',
      'Take a bi-temporal snapshot v18: the knowledge valid at time T as known at record time R (audit what the agent knew at a past moment). Read-only.',
      {
        at: { type: 'string', description: 'Thoi diem su kien T (ISO).' },
        recordedAt: { type: 'string', description: 'Thoi diem ghi nhan R (ISO, mac dinh bay gio).' },
        limit: { type: 'number', description: 'So fact toi da (tuy chon).' },
        userId: { type: 'string', description: 'User id (tuy chon).' },
        botId: { type: 'string', description: 'Bot id (tuy chon).' },
        runId: { type: 'string', description: 'Run id (tuy chon).' },
      },
      ['at'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const snap = snapshotAtV18(s, getStringArg(args, 'at'), {
          recordedAt: getOptionalStringArg(args, 'recordedAt'),
          scope: scopeOf(args),
          limit: getNumberArg(args, 'limit'),
        });
        if (snap.facts.length === 0) return `Khong co fact nao dung tai ${snap.at} theo tri thuc tai ${snap.recordedAt}.`;
        const lines = [
          `Anh chup tri thuc tai ${snap.at} (biet tai ${snap.recordedAt}): ${snap.currentCount} fact hien hanh, ${snap.supersededCount} fact da bi thay the.`,
        ];
        for (const view of snap.facts) {
          lines.push(`  - ${explainBiTemporalViewV18(view)}`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const screen: Tool = {
    definition: toolDef(
      'memory_v18_screen',
      'Screen a candidate fact v18 (poisoning guard): action "screen" runs deny -> injection scan -> v16 gate -> contradiction -> source trust and returns admit / quarantine / reject; "trust" lists source trust scores; "review" records a human review outcome (approved / rejected) to update trust. Needs approval.',
      {
        action: { type: 'string', description: '"screen" | "trust" | "review".' },
        subject: { type: 'string', description: 'Subject khi screen.' },
        predicate: { type: 'string', description: 'Predicate khi screen.' },
        objectText: { type: 'string', description: 'Object khi screen.' },
        sourceName: { type: 'string', description: 'Ten nguon khi screen / review.' },
        sourceText: { type: 'string', description: 'Cau goc cua ung vien (tuy chon).' },
        confidence: { type: 'number', description: 'Confidence ung vien 0..1 (mac dinh 0.9).' },
        decision: { type: 'string', description: '"approved" | "rejected" khi review.' },
        injection: { type: 'boolean', description: 'Muc review bi reject vi tiem nhiem (tuy chon).' },
        userId: { type: 'string', description: 'User id (tuy chon).' },
        botId: { type: 'string', description: 'Bot id (tuy chon).' },
        runId: { type: 'string', description: 'Run id (tuy chon).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'trust') {
          const entries = trustBook.list();
          if (entries.length === 0) return 'Chua co nguon nao trong so trust (nguon moi mac dinh 0.5).';
          const lines = [`So trust nguon (${entries.length}):`];
          for (const e of entries) {
            lines.push(
              `  - ${e.sourceName}: ${e.trust.toFixed(2)} (approve ${e.approved}, reject ${e.rejected}, quarantine ${e.quarantined})`,
            );
          }
          return lines.join('\n');
        }
        if (action === 'review') {
          const sourceName = getStringArg(args, 'sourceName');
          const decision = getStringArg(args, 'decision');
          if (decision !== 'approved' && decision !== 'rejected') {
            throw new Error(`Decision khong hop le: "${decision}" (chi co "approved" | "rejected").`);
          }
          const entry = recordReviewOutcomeV18(trustBook, sourceName, decision, {
            injection: getBoolArg(args, 'injection', false),
          });
          return `Trust cua "${sourceName}" hien la ${entry.trust.toFixed(2)} (approve ${entry.approved}, reject ${entry.rejected}).`;
        }
        if (action !== 'screen') throw new Error(`Action khong hop le: "${action}".`);
        const s = needStore();
        const confidence = getNumberArg(args, 'confidence') ?? 0.9;
        const result = screenCandidateV18(
          s,
          {
            subject: getStringArg(args, 'subject'),
            predicate: getStringArg(args, 'predicate'),
            objectText: getStringArg(args, 'objectText'),
            confidence,
            effectiveConfidence: confidence,
            sourceTrust: 1,
            sourceText: getOptionalStringArg(args, 'sourceText') ?? '',
            pattern: 'tool',
            origin: 'rule',
            intent: 'assert',
            episodeId: '',
            turnId: '',
            runId: scopeOf(args).runId,
            botId: scopeOf(args).botId,
            userId: scopeOf(args).userId,
            at: new Date().toISOString(),
            sourceName: getOptionalStringArg(args, 'sourceName') ?? 'user-chat',
          },
          scopeOf(args),
          { trustBook },
        );
        const lines = [`Ket qua sang loc: ${result.decision} (trust nguon ${result.sourceTrust.toFixed(2)}).`];
        for (const reason of result.reasons) lines.push(`  - ${reason}`);
        if (result.injectionHits.length > 0) {
          lines.push(`  Mau tiem nhiem: ${result.injectionHits.join(', ')}.`);
        }
        if (result.contradiction) {
          lines.push(`  Mau thuan: ${result.contradiction.reason}`);
        }
        if (result.quarantineId) lines.push(`  Da vao quarantine: ${result.quarantineId} (doi nguoi duyet).`);
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const erase: Tool = {
    definition: toolDef(
      'memory_v18_erase',
      'Erase data v18 (GDPR right to erasure): by user, by entity, or by time-range, in soft mode (kept as deleted history) or hard mode (gone). Defaults to dryRun=true (counts only, no delete); pass dryRun=false to really erase. Every run (including dry-runs) is written to the erasure audit log. Needs approval.',
      {
        kind: { type: 'string', description: '"user" | "entity" | "time-range".' },
        userId: { type: 'string', description: 'User id khi kind = "user".' },
        entityId: { type: 'string', description: 'Entity id khi kind = "entity".' },
        from: { type: 'string', description: 'Bat dau khoang ISO khi kind = "time-range".' },
        to: { type: 'string', description: 'Ket thuc khoang ISO khi kind = "time-range".' },
        mode: { type: 'string', description: '"soft" (mac dinh) | "hard".' },
        dryRun: { type: 'boolean', description: 'Chi dem, khong xoa that (mac dinh true).' },
        requestedBy: { type: 'string', description: 'Ai yeu cau xoa.' },
        reason: { type: 'string', description: 'Ly do xoa (vd "GDPR article 17").' },
        removeEntityIfOrphaned: { type: 'boolean', description: 'Xoa luon entity khi khong con fact (chi kind = "entity").' },
      },
      ['kind', 'requestedBy'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const kind = getStringArg(args, 'kind') as 'user' | 'entity' | 'time-range';
        const dryRun = getBoolArg(args, 'dryRun', true);
        const mode = (getOptionalStringArg(args, 'mode') ?? 'soft') as 'soft' | 'hard';
        const result = eraseV18(
          s,
          {
            kind,
            userId: getOptionalStringArg(args, 'userId'),
            entityId: getOptionalStringArg(args, 'entityId'),
            from: getOptionalStringArg(args, 'from'),
            to: getOptionalStringArg(args, 'to'),
            mode,
            requestedBy: getStringArg(args, 'requestedBy'),
            reason: getOptionalStringArg(args, 'reason'),
            removeEntityIfOrphaned: getBoolArg(args, 'removeEntityIfOrphaned', false),
          },
          { dryRun, workspaceDir: workspaceDir === '' ? undefined : workspaceDir },
        );
        const verb = dryRun ? 'Se xoa (dry-run)' : 'Da xoa';
        return (
          `${verb} (${result.kind}, ${result.mode}): ${result.factsRemoved} fact, ` +
          `${result.episodesRemoved} episode, ${result.quarantineRemoved} muc quarantine, ` +
          `${result.entitiesRemoved} entity.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sleep: Tool = {
    definition: toolDef(
      'memory_v18_sleep',
      'Run one sleep-consolidation v18 pass: merges duplicate facts, decays stale facts (lowers confidence, never deletes), optionally merges near-duplicate entities. Budgeted (max merges / max time) so it never blocks a user turn. Needs approval.',
      {
        maxMergesPerRun: { type: 'number', description: 'So cap gop toi da (mac dinh 50).' },
        maxFactsPerRun: { type: 'number', description: 'So fact quet toi da (mac dinh 2000).' },
        staleAfterDays: { type: 'number', description: 'So ngay khong doi thi coi la cu (mac dinh 90).' },
        decayStep: { type: 'number', description: 'Buoc giam confidence moi lan ha cap (mac dinh 0.1).' },
        mergeEntities: { type: 'boolean', description: 'Co gop entity trung lap diem cao khong (mac dinh false).' },
        userId: { type: 'string', description: 'User id (tuy chon).' },
        botId: { type: 'string', description: 'Bot id (tuy chon).' },
        runId: { type: 'string', description: 'Run id (tuy chon).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const report = runSleepConsolidationV18(s, scopeOf(args), {
          maxMergesPerRun: getNumberArg(args, 'maxMergesPerRun'),
          maxFactsPerRun: getNumberArg(args, 'maxFactsPerRun'),
          staleAfterDays: getNumberArg(args, 'staleAfterDays'),
          decayStep: getNumberArg(args, 'decayStep'),
          mergeEntities: getBoolArg(args, 'mergeEntities', false),
        }, { workspaceDir: workspaceDir === '' ? undefined : workspaceDir });
        return (
          `Sleep consolidation v18: quet ${report.factsScanned} fact, ${report.duplicateGroups} nhom trung, ` +
          `gop ${report.factsMerged} fact, ha cap ${report.factsDecayed} fact (${report.factsBelowMin} duoi nguong), ` +
          `gop ${report.entitiesMerged} entity, ${report.durationMs}ms — ${report.stoppedBecause}.`
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'memory_v18_eval',
      'Run the LOCOMO-style long-term memory eval v18 (24 hand-written cases: single-hop / multi-hop / temporal / unanswerable) on a fresh temporary store — never on the production store. Read-only.',
      {
        topK: { type: 'number', description: 'So hit toi da moi query (mac dinh 5).' },
        minScore: { type: 'number', description: 'Diem toi thieu de tinh la co ket qua (mac dinh 0.1).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const evalStore = new TemporalGraphStore(new InMemoryGraphBackend());
        const dataset = buildV18LocomoDataset();
        const ids = seedV18LocomoDataset(evalStore, dataset);
        const result = runV18LocomoEval(evalStore, dataset, ids, {
          topK: getNumberArg(args, 'topK'),
          minScore: getNumberArg(args, 'minScore'),
        });
        return formatV18LocomoReport(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const eraseAudit: Tool = {
    definition: toolDef(
      'memory_v18_erase_audit',
      'Read the GDPR erasure audit log v18 (who erased what, when, dry-run or real). Read-only; returns an empty list when no audit file exists yet.',
      {
        limit: { type: 'number', description: 'So dong moi nhat (mac dinh 100).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        if (workspaceDir === '') return 'Chua co workspaceDir — khong co file audit de doc.';
        const entries = readErasureAuditV18(workspaceDir, getNumberArg(args, 'limit') ?? 100);
        if (entries.length === 0) return 'Chua co lan xoa nao trong audit.';
        const lines = [`Audit xoa (${entries.length} dong moi nhat):`];
        for (const e of entries) {
          lines.push(
            `  - [${e.at}] ${e.kind} ${e.target} (${e.mode}${e.dryRun ? ', dry-run' : ''}): ${e.factsRemoved} fact, ${e.episodesRemoved} episode — ${e.requestedBy} (${e.reason})`,
          );
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    extract,
    retrieve,
    blockEdit,
    blockRollback,
    blockDrift,
    correct,
    snapshot,
    screen,
    erase,
    sleep,
    evalTool,
    eraseAudit,
  ];
}

/** Ten tool memory v18 (thu tu nhu createMemoryV18Tools tra ve). */
export const MEMORY_V18_TOOL_NAMES = [
  'memory_v18_extract',
  'memory_v18_retrieve',
  'memory_v18_block_edit',
  'memory_v18_block_rollback',
  'memory_v18_block_drift',
  'memory_v18_correct',
  'memory_v18_snapshot',
  'memory_v18_screen',
  'memory_v18_erase',
  'memory_v18_sleep',
  'memory_v18_eval',
  'memory_v18_erase_audit',
] as const;

/**
 * Placeholder (unbound) cua 12 tool memory v18 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V18_TOOLS: Tool[] = createMemoryV18Tools();
