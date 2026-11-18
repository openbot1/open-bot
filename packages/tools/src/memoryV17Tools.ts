/**
 * Memory v17 tools for @open-bot/tools (v1.18, Doi T1).
 *
 * Agent lam viec voi memory v17 bang tool call:
 *  - memory_v17_block_template  — tao block tu template (persona/human/custom/project/skill) + liet ke template (needsApproval: true khi tao)
 *  - memory_v17_block_lifecycle — pin / read-only / gioi han ky tu rieng / quota tong + bao cao quota (needsApproval: true khi doi cau hinh)
 *  - memory_v17_block_compile   — compile <memory_blocks> co pin len dau (read)
 *  - memory_v17_sleep_schedule  — xem lich sleep / chay sleep ngay / chay khi compact (needsApproval: true khi chay)
 *  - memory_v17_archival_score  — bao cao diem passage + promote/demote (needsApproval: true khi promote/demote)
 *  - memory_v17_block_commit    — commit block vao git-store (needsApproval: true)
 *  - memory_v17_block_history   — lich su commit + diff 2 commit (read)
 *  - memory_v17_block_rollback  — rollback block ve commit cu (needsApproval: true)
 *  - memory_v17_block_audit     — truy van audit log block (read)
 *  - memory_v17_admit           — admit fact moi qua pipeline (auto-admit / human-review / reject) + duyet quarantine + thong ke (needsApproval: true khi admit/duyet)
 *  - memory_v17_eval            — chay eval 25 case (read)
 *
 * SAFETY: moi edit block qua lifecycle guard (readOnly chan,
 * vuot maxChars rieng/quota tong chan). Moi fact admit deu qua
 * gate poisoning v16 + xac minh chuoi provenance; fact khong du
 * chuan chi vao quarantine, khong vao graph. Khong goi model
 * that, khong goi API ngoai.
 *
 * Factory:
 *   createMemoryV17Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V17_TOOLS                       (unbound placeholder)
 */
import type { Tool } from '@open-bot/core';
import {
  TemporalGraphStore,
  V15BlockStore,
  V17BlockLifecycleManager,
  loadLifecycleConfigV17,
  saveLifecycleConfigV17,
  compileBlocksWithLifecycleV17,
  listBlockTemplatesV17,
  getBlockTemplateV17,
  V16V15BlockAdapter,
  V17SleepScheduler,
  V16SourceAllowlist,
  scoreAllPassagesV17,
  promotePassagesV17,
  demotePassagesV17,
  archivalScoringReportV17,
  recordAccessV17,
  commitBlockV17,
  blockCommitHistoryV17,
  diffCommitsV17,
  rollbackToCommitV17,
  queryBlockAuditV17,
  blockGitStatsV17,
  shortHashV17,
  verifyProvenanceChainV17,
  admitCandidateV17,
  reviewAdmissionV17,
  admissionStatsV17,
  exportProvenanceChainV17,
  runV17Eval,
  formatV17EvalReport,
} from '@open-bot/core';
import type { V15BlockKind } from '@open-bot/core';
import type { V17BlockTemplateName } from '@open-bot/core';

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

export interface MemoryV17ToolOptions {
  /** Thu muc workspace cua bot (bat buoc khi bound neu khong co graphStore). */
  workspaceDir?: string;
  /** Store da tao san (test inject store RAM/dia tam). */
  graphStore?: TemporalGraphStore;
  /** Block store da tao san (test/host luu lau dai; mac dinh: store RAM moi). */
  blockStore?: V15BlockStore;
  /** Bot id goi tool (dung lam actor). */
  botId?: string;
}

export function createMemoryV17Tools(opts: MemoryV17ToolOptions = {}): Tool[] {
  const store =
    opts.graphStore ?? (opts.workspaceDir ? TemporalGraphStore.fromWorkspace(opts.workspaceDir) : undefined);
  const blockStore = opts.blockStore ?? new V15BlockStore();
  const workspaceDir = opts.workspaceDir ?? '';
  const defaultBotId = opts.botId;
  const lifecycle =
    workspaceDir !== ''
      ? loadLifecycleConfigV17(blockStore, workspaceDir)
      : new V17BlockLifecycleManager(blockStore);

  const needStore = (): TemporalGraphStore => {
    if (!store) {
      throw new Error(
        'memory v17 chưa được hỗ trợ trong phiên này (host phải truyền graphStore hoặc workspaceDir vào createMemoryV17Tools).',
      );
    }
    return store;
  };
  const actorOf = (ctx?: { botId?: string }): string => {
    const botId = ctx?.botId ?? defaultBotId;
    return botId ? `agent:${botId}` : 'user';
  };
  const saveLifecycle = (): void => {
    if (workspaceDir !== '') saveLifecycleConfigV17(workspaceDir, lifecycle);
  };
  const scopeOf = (args: Record<string, unknown>): { userId: string; botId: string; runId: string } => ({
    userId: getOptionalStringArg(args, 'userId') ?? '',
    botId: getOptionalStringArg(args, 'botId') ?? defaultBotId ?? '',
    runId: getOptionalStringArg(args, 'runId') ?? '',
  });

  const blockTemplate: Tool = {
    definition: toolDef(
      'memory_v17_block_template',
      'Create a memory block v17 from a template (persona / human / custom / project / skill) with {{variable}} substitution, or list the 5 available templates. Creating validates required variables and records the template origin in the block lifecycle config. Needs approval when creating.',
      {
        action: { type: 'string', description: '"list" (liet ke template) hoac "create".' },
        template: { type: 'string', description: 'Ten template khi create: "persona" | "human" | "custom" | "project" | "skill".' },
        label: { type: 'string', description: 'Label block moi khi create.' },
        agentName: { type: 'string', description: 'Bien {{agentName}} (template persona).' },
        userName: { type: 'string', description: 'Bien {{userName}} (template human).' },
        projectName: { type: 'string', description: 'Bien {{projectName}} (template project).' },
        skillName: { type: 'string', description: 'Bien {{skillName}} (template skill).' },
        title: { type: 'string', description: 'Bien {{title}} (template custom).' },
        tone: { type: 'string', description: 'Bien {{tone}} (template persona, tuy chon).' },
        language: { type: 'string', description: 'Bien {{language}} (template persona, tuy chon).' },
        timezone: { type: 'string', description: 'Bien {{timezone}} (template human, tuy chon).' },
        goal: { type: 'string', description: 'Bien {{goal}} (template human, tuy chon).' },
        stack: { type: 'string', description: 'Bien {{stack}} (template project, tuy chon).' },
        repoPath: { type: 'string', description: 'Bien {{repoPath}} (template project, tuy chon).' },
        trigger: { type: 'string', description: 'Bien {{trigger}} (template skill, tuy chon).' },
        notes: { type: 'string', description: 'Bien {{notes}} (template skill, tuy chon).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'list') {
          const lines = ['Block template v17 (5 mau):'];
          for (const name of listBlockTemplatesV17()) {
            const t = getBlockTemplateV17(name);
            if (!t) continue;
            lines.push(
              `  - ${t.name} (${t.kind}): ${t.description} Bien bat buoc: ${t.requiredVars.join(', ') || '(khong co)'}; tuy chon: ${Object.keys(t.optionalVars).join(', ') || '(khong co)'}.`,
            );
          }
          return lines.join('\n');
        }
        if (action !== 'create') throw new Error(`Action khong hop le: "${action}" (chi co "list" | "create").`);
        const template = getStringArg(args, 'template') as V17BlockTemplateName;
        const label = getStringArg(args, 'label');
        const vars: Record<string, string> = {};
        for (const key of ['agentName', 'userName', 'projectName', 'skillName', 'title', 'tone', 'language', 'timezone', 'goal', 'stack', 'repoPath', 'trigger', 'notes']) {
          const v = getOptionalStringArg(args, key);
          if (v !== undefined) vars[key] = v;
        }
        const block = lifecycle.createFromTemplate(template, label, vars, actorOf(ctx));
        saveLifecycle();
        return `Da tao block "${block.label}" (${block.kind}) tu template "${template}", ${block.content.length} ky tu, version ${block.version}.`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockLifecycle: Tool = {
    definition: toolDef(
      'memory_v17_block_lifecycle',
      'Manage a memory block v17 lifecycle: pin (compiled first, never merged/truncated by sleep), read-only (blocks all edits until a user unlocks it), per-block max chars, or the total quota across all blocks. Also reports the quota (total chars, remaining, largest block, near-limit blocks). Needs approval when changing config.',
      {
        action: { type: 'string', description: '"pin" | "unpin" | "readonly" | "unreadonly" | "maxchars" | "quota" | "report".' },
        label: { type: 'string', description: 'Label block (tru khi action = "quota" | "report").' },
        maxChars: { type: 'number', description: 'Gioi han ky tu rieng khi action = "maxchars".' },
        quotaChars: { type: 'number', description: 'Quota tong (ky tu) khi action = "quota".' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const action = getStringArg(args, 'action');
        const actor = actorOf(ctx);
        if (action === 'report') {
          const report = lifecycle.quotaReport();
          const lines = [
            `Quota block v17: ${report.totalChars}/${report.totalQuotaChars} ky tu (con ${report.remainingChars}), ${report.blockCount}/${report.maxBlocks} block.`,
          ];
          if (report.largestBlock) {
            lines.push(`  Block lon nhat: "${report.largestBlock.label}" (${report.largestBlock.chars} ky tu).`);
          }
          for (const n of report.nearLimit) {
            lines.push(`  Gan vuot gioi han: "${n.label}" ${n.chars}/${n.maxChars} (${Math.round(n.pct * 100)}%).`);
          }
          const pinned = lifecycle.listPinned();
          if (pinned.length > 0) lines.push(`  Block pin: ${pinned.map((b) => b.label).join(', ')}.`);
          const ro = lifecycle.listReadOnly();
          if (ro.length > 0) lines.push(`  Block chi doc: ${ro.map((b) => b.label).join(', ')}.`);
          return lines.join('\n');
        }
        if (action === 'quota') {
          const quotaChars = getNumberArg(args, 'quotaChars');
          if (quotaChars === undefined) throw new Error('Action "quota" can co quotaChars (number).');
          const next = lifecycle.setTotalQuota(quotaChars, actor);
          saveLifecycle();
          return `Quota tong block v17 dat ${next} ky tu (hien dung ${lifecycle.blockStore.totalChars()}).`;
        }
        const label = getStringArg(args, 'label');
        if (action === 'pin' || action === 'unpin') {
          const cfg = lifecycle.setPinned(label, action === 'pin', actor);
          saveLifecycle();
          return cfg.pinned ? `Da pin block "${label}" (compile len dau).` : `Da bo pin block "${label}".`;
        }
        if (action === 'readonly' || action === 'unreadonly') {
          const cfg = lifecycle.setReadOnly(label, action === 'readonly', actor);
          saveLifecycle();
          return cfg.readOnly ? `Block "${label}" da chi doc (moi edit deu bi chan).` : `Block "${label}" da mo khoa chi doc.`;
        }
        if (action === 'maxchars') {
          const maxChars = getNumberArg(args, 'maxChars');
          if (maxChars === undefined) throw new Error('Action "maxchars" can co maxChars (number).');
          const cfg = lifecycle.setMaxChars(label, maxChars, actor);
          saveLifecycle();
          return `Block "${label}" gioi han rieng ${cfg.maxChars} ky tu.`;
        }
        throw new Error(`Action khong hop le: "${action}".`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockCompile: Tool = {
    definition: toolDef(
      'memory_v17_block_compile',
      'Compile memory blocks v17 into <memory_blocks> prompt text: pinned blocks come first (in pin order), then the rest in v15 kind order (persona > human > task > system > custom). Read-only blocks compile normally (only edits are blocked).',
      {
        kind: { type: 'string', description: 'Loc theo kind (tuy chon).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const kind = getOptionalStringArg(args, 'kind') as V15BlockKind | undefined;
        const compiled = compileBlocksWithLifecycleV17(lifecycle, {
          ...(kind ? { includeKinds: [kind] } : {}),
        });
        if (compiled === '') return 'Chua co memory block v17 nao.';
        return compiled.slice(0, 4000);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sleepSchedule: Tool = {
    definition: toolDef(
      'memory_v17_sleep_schedule',
      'Sleep-time compute scheduler v17: view the schedule (next run, runs today, quiet hours), run sleep consolidation now, or run it on context compaction. Scheduled runs respect the interval, quiet hours and max runs per day; manual runs bypass the schedule. Needs approval when running.',
      {
        action: { type: 'string', description: '"status" | "run" | "compact".' },
        intervalMs: { type: 'number', description: 'Khoang cach lich (ms) — chi dung khi doi cau hinh qua status? (khong doi o tool nay).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        void ctx;
        void args;
        const scheduler = new V17SleepScheduler(s, workspaceDir !== '' ? workspaceDir : '/tmp', scopeOf(args), {
          enabled: true,
        });
        if (action === 'status') {
          const state = scheduler.getState();
          const config = scheduler.getConfig();
          return [
            `Lich sleep v17: ${config.enabled ? 'bat' : 'tat'}, moi ${Math.round(config.intervalMs / 60000)} phut, toi da ${config.maxRunsPerDay} lan/ngay.`,
            `  Lan chay cuoi: ${state.lastRunAt ?? '(chua chay)'}; lan chay ke tiep: ${scheduler.nextRunAt().toISOString()}.`,
            `  Hom nay: ${state.runsToday} lan; tong: ${state.totalRuns} lan; loi lien tiep: ${state.consecutiveFailures}.`,
            config.quietHours
              ? `  Gio yen lang: ${config.quietHours.startHour}h–${config.quietHours.endHour}h.`
              : '  Khong co gio yen lang.',
          ].join('\n');
        }
        if (action === 'run' || action === 'compact') {
          const adapter = new V16V15BlockAdapter(blockStore);
          const report = action === 'run'
            ? scheduler.runManual({ blocks: adapter, blockStore })
            : scheduler.runOnCompact({ blocks: adapter, blockStore });
          if (!report) return 'Sleep v17 khong chay (dang trong gio yen lang hoac lich tat).';
          if (report.error) return `Sleep v17 chay loi: ${report.error}`;
          return `Sleep v17 chay xong (${report.trigger}): ${report.episodesProcessed} episode, ${report.candidatesExtracted} ung vien, ${report.promoted} promote, ${report.expiredSwept} het han, ${report.quarantined} quarantine.`;
        }
        throw new Error(`Action khong hop le: "${action}" (chi co "status" | "run" | "compact").`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const archivalScore: Tool = {
    definition: toolDef(
      'memory_v17_archival_score',
      'Score archival passages v17 (access frequency + confidence + recency + freshness) and promote high-scoring passages to core blocks or demote stale low-scoring ones to archival. Promotions pass the v16 poisoning gate; demoted facts stay in the graph (only leave core). Needs approval when promoting/demoting.',
      {
        action: { type: 'string', description: '"report" | "promote" | "demote" | "record-access".' },
        factId: { type: 'string', description: 'Id fact khi action = "record-access".' },
        sourceName: { type: 'string', description: 'Ten nguon khi promote (mac dinh "user-chat").' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        const scope = scopeOf(args);
        if (action === 'record-access') {
          if (workspaceDir === '') throw new Error('record-access can co workspaceDir (de luu dem truy cap).');
          const factId = getStringArg(args, 'factId');
          const entry = recordAccessV17(workspaceDir, factId);
          return `Da ghi nhan truy cap fact ${factId.slice(0, 8)} (tong ${entry.accessCount} lan).`;
        }
        if (action === 'report') {
          const report = archivalScoringReportV17(s, scope, workspaceDir !== '' ? workspaceDir : '/tmp');
          const lines = [
            `Archival scoring v17: ${report.considered} passage, diem trung binh ${report.avgScore.toFixed(2)}, ${report.promoteReady} san sang promote, ${report.demoteReady} san sang demote, ${report.staleCount} loi thoi.`,
          ];
          for (const t of report.top) {
            lines.push(`  - ${t.subjectName} —${t.predicate}→ ${t.objectText} (diem ${t.score.toFixed(2)}, ${t.accessCount} lan truy cap${t.stale ? ', LOI THOI' : ''})`);
          }
          return lines.join('\n');
        }
        const adapter = new V16V15BlockAdapter(blockStore);
        const sourceName = getOptionalStringArg(args, 'sourceName') ?? 'user-chat';
        if (action === 'promote') {
          const report = promotePassagesV17(s, scope, workspaceDir !== '' ? workspaceDir : '/tmp', adapter, sourceName);
          return `Promote v17: xet ${report.considered} passage, promote ${report.promoted.length}, gate chan ${report.gatedOut}, bo qua ${report.skipped.length}.`;
        }
        if (action === 'demote') {
          const report = demotePassagesV17(s, scope, workspaceDir !== '' ? workspaceDir : '/tmp', adapter);
          return `Demote v17: xet ${report.considered} passage, demote ${report.demoted.length}, bo qua ${report.skipped.length}.`;
        }
        throw new Error(`Action khong hop le: "${action}".`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockCommit: Tool = {
    definition: toolDef(
      'memory_v17_block_commit',
      'Commit a memory block v17 into the git-style store (sha256 hash chained to the parent commit, author, reason, line counts). No new commit is created when the content is unchanged. Needs approval.',
      {
        label: { type: 'string', description: 'Label block can commit.' },
        reason: { type: 'string', description: 'Ly do thay doi (luu vao commit + audit).' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        if (workspaceDir === '') throw new Error('Block commit can co workspaceDir (de luu git-store).');
        const label = getStringArg(args, 'label');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const { commit, created } = commitBlockV17(blockStore, workspaceDir, label, actorOf(ctx), reason);
        return created
          ? `Da commit block "${label}" ${shortHashV17(commit.hash)} (+${commit.linesAdded}/-${commit.linesRemoved} dong, tac gia ${commit.author}).`
          : `Block "${label}" khong doi — khong tao commit moi (HEAD ${shortHashV17(commit.hash)}).`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockHistory: Tool = {
    definition: toolDef(
      'memory_v17_block_history',
      'List the commit history of a memory block v17 (newest first) and diff any two commits (added/removed/unchanged lines).',
      {
        label: { type: 'string', description: 'Label block.' },
        fromHash: { type: 'string', description: 'Hash commit cu khi diff (tuy chon).' },
        toHash: { type: 'string', description: 'Hash commit moi khi diff (tuy chon).' },
        limit: { type: 'number', description: 'So commit toi da (mac dinh 10).' },
      },
      ['label'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        if (workspaceDir === '') throw new Error('Block history can co workspaceDir (de doc git-store).');
        const label = getStringArg(args, 'label');
        const fromHash = getOptionalStringArg(args, 'fromHash');
        const toHash = getOptionalStringArg(args, 'toHash');
        if (fromHash && toHash) {
          const diff = diffCommitsV17(workspaceDir, fromHash, toHash);
          const lines = [
            `Diff block "${label}": ${shortHashV17(diff.fromHash)} -> ${shortHashV17(diff.toHash)} (+${diff.added}/-${diff.removed} dong, ${diff.unchanged} khong doi):`,
          ];
          for (const l of diff.lines.slice(0, 60)) {
            lines.push(`  ${l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' '} ${l.text}`);
          }
          return lines.join('\n');
        }
        const limit = getNumberArg(args, 'limit') ?? 10;
        const history = blockCommitHistoryV17(workspaceDir, label, limit);
        if (history.length === 0) return `Block "${label}" chua co commit v17 nao.`;
        const stats = blockGitStatsV17(workspaceDir);
        const lines = [`Lich su commit block "${label}" (${history.length} commit, tong ${stats.commitCount} commit trong git-store):`];
        for (const c of history) {
          lines.push(`  - ${shortHashV17(c.hash)} (cha ${c.parent ? shortHashV17(c.parent) : '(goc)'}) ${c.at.slice(0, 10)} ${c.author}: ${c.reason} (+${c.linesAdded}/-${c.linesRemoved})`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockRollback: Tool = {
    definition: toolDef(
      'memory_v17_block_rollback',
      'Roll back a memory block v17 to an old commit (restores its content via a normal v15 edit, then records a NEW commit for the rollback — history is never erased, like git revert). Needs approval.',
      {
        label: { type: 'string', description: 'Label block.' },
        hash: { type: 'string', description: 'Hash commit muon quay ve.' },
        reason: { type: 'string', description: 'Ly do rollback (tuy chon).' },
      },
      ['label', 'hash'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        if (workspaceDir === '') throw new Error('Block rollback can co workspaceDir (de doc/ghi git-store).');
        const label = getStringArg(args, 'label');
        const hash = getStringArg(args, 'hash');
        const reason = getOptionalStringArg(args, 'reason') ?? '';
        const { block, commit } = rollbackToCommitV17(blockStore, workspaceDir, label, hash, actorOf(ctx), reason);
        return `Da rollback block "${label}" ve commit ${shortHashV17(hash)} (commit rollback moi ${shortHashV17(commit.hash)}, version v15 hien tai ${block.version}).`;
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const blockAudit: Tool = {
    definition: toolDef(
      'memory_v17_block_audit',
      'Query the v17 block audit log (append-only): filter by block label, author, reason text, or a time range. Newest first.',
      {
        label: { type: 'string', description: 'Loc theo label block (tuy chon).' },
        author: { type: 'string', description: 'Loc theo tac gia (tuy chon).' },
        reasonContains: { type: 'string', description: 'Loc ly do chua chuoi nay (tuy chon).' },
        from: { type: 'string', description: 'Chi lay tu thoi diem ISO nay (tuy chon).' },
        to: { type: 'string', description: 'Chi lay den thoi diem ISO nay (tuy chon).' },
        limit: { type: 'number', description: 'So muc toi da (mac dinh 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        if (workspaceDir === '') throw new Error('Block audit can co workspaceDir (de doc audit log).');
        const entries = queryBlockAuditV17(workspaceDir, {
          ...(getOptionalStringArg(args, 'label') ? { label: getOptionalStringArg(args, 'label') as string } : {}),
          ...(getOptionalStringArg(args, 'author') ? { author: getOptionalStringArg(args, 'author') as string } : {}),
          ...(getOptionalStringArg(args, 'reasonContains') ? { reasonContains: getOptionalStringArg(args, 'reasonContains') as string } : {}),
          ...(getOptionalStringArg(args, 'from') ? { from: getOptionalStringArg(args, 'from') as string } : {}),
          ...(getOptionalStringArg(args, 'to') ? { to: getOptionalStringArg(args, 'to') as string } : {}),
          limit: getNumberArg(args, 'limit') ?? 20,
        });
        if (entries.length === 0) return 'Khong co muc audit block v17 nao khop bo loc.';
        const lines = [`Audit block v17 (${entries.length} muc, moi nhat truoc):`];
        for (const e of entries) {
          lines.push(`  - ${e.at} [${e.action}] ${e.label} ${shortHashV17(e.hash)} ${e.author}: ${e.reason} (+${e.linesAdded}/-${e.linesRemoved})`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const admit: Tool = {
    definition: toolDef(
      'memory_v17_admit',
      'Admit a new fact v17 through the poisoning-guard pipeline: (1) denied source -> reject; (2) broken provenance chain -> reject; (3) v16 gate reject -> reject; (4) risky/low-confidence -> human-review (into quarantine); (5) clean + high-confidence -> auto-admit into the graph. Also reviews a quarantined item, shows admission stats, or exports a fact provenance chain. Needs approval when admitting/reviewing.',
      {
        action: { type: 'string', description: '"admit" | "review" | "stats" | "chain" | "verify-chain".' },
        subject: { type: 'string', description: 'Chu the fact khi admit (vd "Huy").' },
        predicate: { type: 'string', description: 'Vi ngu fact khi admit (vd "likes").' },
        objectText: { type: 'string', description: 'Tan ngu fact khi admit.' },
        confidence: { type: 'number', description: 'Do tin cay 0..1 khi admit (mac dinh 0.9).' },
        sourceText: { type: 'string', description: 'Cau goc khi admit.' },
        episodeId: { type: 'string', description: 'Episode goc khi admit.' },
        sourceName: { type: 'string', description: 'Ten nguon khi admit (mac dinh "user-chat").' },
        parentFactIds: { type: 'string', description: 'Id fact cha, phan tach bang dau phay (tuy chon).' },
        quarantineId: { type: 'string', description: 'Id muc quarantine khi review.' },
        decision: { type: 'string', description: '"approved" | "rejected" khi review.' },
        factId: { type: 'string', description: 'Id fact khi chain.' },
        userId: { type: 'string', description: 'User so huu fact (mac dinh "").' },
        botId: { type: 'string', description: 'Bot ghi fact (mac dinh "").' },
        runId: { type: 'string', description: 'Run ghi fact (mac dinh "").' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        const scope = scopeOf(args);
        if (workspaceDir === '' && (action === 'admit' || action === 'review' || action === 'stats')) {
          throw new Error('Admit/review/stats can co workspaceDir (de luu audit admission).');
        }
        if (action === 'stats') {
          const stats = admissionStatsV17(workspaceDir);
          return `Admission v17 (7 ngay qua): ${stats.total} luot, auto-admit ${stats.autoAdmitted}, doi nguoi duyet ${stats.humanReview}, tu choi ${stats.rejected} (ty le auto-admit ${(stats.autoAdmitRate * 100).toFixed(0)}%).`;
        }
        if (action === 'chain') {
          const factId = getStringArg(args, 'factId');
          return exportProvenanceChainV17(s, factId);
        }
        if (action === 'review') {
          const quarantineId = getStringArg(args, 'quarantineId');
          const decision = getStringArg(args, 'decision') as 'approved' | 'rejected';
          if (decision !== 'approved' && decision !== 'rejected') {
            throw new Error('decision phai la "approved" hoac "rejected".');
          }
          const result = reviewAdmissionV17(s, workspaceDir, quarantineId, decision, actorOf(ctx));
          return decision === 'approved'
            ? `Da duyet muc quarantine ${quarantineId}: fact vao graph${result.fact ? ` (id ${result.fact.id.slice(0, 8)})` : ''}.`
            : `Da tu choi muc quarantine ${quarantineId} (ghi audit, khong vao graph).`;
        }
        if (action === 'verify-chain' || action === 'admit') {
          const subject = getStringArg(args, 'subject');
          const predicate = getStringArg(args, 'predicate');
          const objectText = getStringArg(args, 'objectText');
          const confidence = getNumberArg(args, 'confidence') ?? 0.9;
          const sourceText = getStringArg(args, 'sourceText');
          const episodeId = getStringArg(args, 'episodeId');
          const sourceName = getOptionalStringArg(args, 'sourceName') ?? 'user-chat';
          const parentRaw = getOptionalStringArg(args, 'parentFactIds') ?? '';
          const parentFactIds = parentRaw.split(',').map((x) => x.trim()).filter((x) => x !== '');
          const candidate = {
            subject,
            predicate,
            objectText,
            confidence,
            effectiveConfidence: confidence,
            sourceTrust: 1,
            sourceText,
            pattern: 'tool-admit',
            origin: 'rule' as const,
            intent: 'assert' as const,
            episodeId,
            turnId: '',
            runId: scope.runId,
            botId: scope.botId,
            userId: scope.userId,
            at: new Date().toISOString(),
            sourceName,
            parentFactIds,
          };
          if (action === 'verify-chain') {
            const check = verifyProvenanceChainV17(s, candidate);
            return check.ok
              ? `Chuoi provenance hop le (sau ${check.depth}, episode ton tai, ${check.parentsFound}/${check.parentsTotal} fact cha tim thay).`
              : `Chuoi provenance KHONG hop le: ${check.errors.join(' ')}`;
          }
          const result = admitCandidateV17(s, workspaceDir, candidate, scope, sourceName, {
            allowlist: new V16SourceAllowlist(),
          });
          if (result.decision === 'auto-admit') {
            return `Auto-admit: fact "${subject} ${predicate} ${objectText}" vao graph (id ${result.fact?.id.slice(0, 8)}). ${result.reasons.join(' ')}`;
          }
          if (result.decision === 'human-review') {
            return `Human-review: fact vao quarantine (id ${result.quarantineItem?.id.slice(0, 8)}) doi nguoi duyet. ${result.reasons.join(' ')}`;
          }
          return `Reject: ${result.reasons.join(' ')}`;
        }
        throw new Error(`Action khong hop le: "${action}".`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'memory_v17_eval',
      'Run the memory v17 eval (25 fixed offline cases: 5 lifecycle + 5 scheduler + 5 scoring + 5 versioning + 5 guard) and return per-category pass rates with PASS/FAIL against thresholds. No model, no network.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const result = runV17Eval();
        return formatV17EvalReport(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    blockTemplate,
    blockLifecycle,
    blockCompile,
    sleepSchedule,
    archivalScore,
    blockCommit,
    blockHistory,
    blockRollback,
    blockAudit,
    admit,
    evalTool,
  ];
}

/** Ten tool memory v17 (thu tu nhu createMemoryV17Tools tra ve). */
export const MEMORY_V17_TOOL_NAMES = [
  'memory_v17_block_template',
  'memory_v17_block_lifecycle',
  'memory_v17_block_compile',
  'memory_v17_sleep_schedule',
  'memory_v17_archival_score',
  'memory_v17_block_commit',
  'memory_v17_block_history',
  'memory_v17_block_rollback',
  'memory_v17_block_audit',
  'memory_v17_admit',
  'memory_v17_eval',
] as const;

/**
 * Placeholder (unbound) cua 11 tool memory v17 — nam trong ALL_TOOLS.
 * Goi factory khong co workspaceDir; execute tra loi ro rang thay vi
 * crash, va needsApproval giu dung nhu tool that.
 */
export const MEMORY_V17_TOOLS: Tool[] = createMemoryV17Tools();
