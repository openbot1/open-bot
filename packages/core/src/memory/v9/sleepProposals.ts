/**
 * Memory v9 kiểu Letta — đề xuất cập nhật core block lúc sleep
 * (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta (sleep-time compute: agent tự suy nghĩ khi
 * rảnh rồi đề xuất sửa memory của chính nó) — viết lại hoàn toàn cho
 * open-bot, chạy local, KHÔNG tự ý ghi đè core memory:
 *
 *  - Sleep pass trích fact từ phiên vừa xong (hoặc từ recall), mỗi
 *    fact được xếp vào một block đích (human / persona / project)
 *    theo luật từ khoá + heuristic, thành một "proposal": dòng fact
 *    đề xuất thêm, lý do, độ tin cậy, nguồn (session/fact id).
 *  - Proposal ở trạng thái `pending` cho tới khi user (hoặc agent ở
 *    phiên sau, với quyền tương đương) quyết định: approve (append
 *    vào block đích qua CoreMemoryManager — có thể kích hoạt cô đọng
 *    khi block đầy), reject (bỏ, ghi lý do), hoặc apply-as-edited
 *    (sửa dòng fact rồi mới append).
 *  - Mọi quyết định đều ghi log append-only
 *    `.open-bot/memory-v9-sleep-proposals-decisions.jsonl` để audit.
 *  - Dedupe: fact đã có trong block đích (so trùng theo từ khoá) hoặc
 *    đã có proposal pending trùng nội dung thì không tạo proposal mới.
 *
 * Lưu trữ: một file JSON `.open-bot/memory-v9-sleep-proposals.json`
 * (danh sách proposal, tối đa 200 pending + lịch sử đã quyết định
 * giữ 500), ghi atomic (temp + rename, mode 0600).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreMemoryManager, isLettaCoreLabel } from './coreMemory';
import type { LettaCoreLabel } from './coreMemory';
import { condenseWords, jaccardSimilarity } from './condense';

/** File proposals (JSON). */
export const V9_SLEEP_PROPOSALS_REL_PATH = path.join('.open-bot', 'memory-v9-sleep-proposals.json');
/** Log quyết định proposal (JSONL append-only). */
export const V9_SLEEP_PROPOSAL_DECISIONS_REL_PATH = path.join(
  '.open-bot',
  'memory-v9-sleep-proposals-decisions.jsonl',
);
/** Số proposal pending tối đa giữ (cũ nhất, điểm thấp nhất rớt trước). */
export const V9_SLEEP_PROPOSALS_MAX_PENDING = 200;
/** Số proposal đã quyết định tối đa giữ trong file. */
export const V9_SLEEP_PROPOSALS_MAX_DECIDED = 500;
/** Jaccard: fact giống proposal pending trên mức này thì coi là trùng. */
export const V9_SLEEP_PROPOSAL_DUP_JACCARD = 0.75;

/** Trạng thái proposal. */
export type SleepProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';

/** Cách proposal được quyết định. */
export type SleepProposalDecision = 'approve' | 'reject' | 'apply-edited';

/** Một đề xuất cập nhật core block. */
export interface SleepProposal {
  id: string;
  botId: string;
  /** Block đích: human / persona / project. */
  targetLabel: LettaCoreLabel;
  /** Dòng fact đề xuất thêm vào block. */
  proposedLine: string;
  /** Vì sao đề xuất (vd "xuất hiện 3 lần trong phiên ..."). */
  reason: string;
  /** Độ tin cậy 0..1. */
  confidence: number;
  /** Nguồn: session/fact id nào sinh ra proposal này. */
  source: string;
  status: SleepProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Lý do reject (nếu có). */
  decisionNote: string | null;
  /** Dòng fact cuối cùng đã append (khi apply-edited khác proposedLine). */
  appliedLine: string | null;
}

/** File proposals trên đĩa. */
export interface SleepProposalsFile {
  version: 1;
  proposals: SleepProposal[];
}

/** Một dòng log quyết định (JSONL). */
export interface SleepProposalDecisionLog {
  at: string;
  proposalId: string;
  botId: string;
  targetLabel: string;
  decision: SleepProposalDecision;
  decidedBy: string;
  note?: string;
  appliedLine?: string;
}

/** Lỗi proposal — message tiếng Việt. */
export class SleepProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SleepProposalError';
  }
}

/**
 * Xếp một fact vào block đích theo luật từ khoá (heuristic, không
 * model — đủ tốt cho sleep pass, user/agent vẫn là người quyết định
 * cuối cùng):
 *  - persona: câu về tính cách, giọng điệu, cách xưng hô, sở thích
 *    phong cách của bot ("hãy trả lời ngắn gọn", "xưng ...").
 *  - project: câu về công việc/dự án/công nghệ đang làm.
 *  - human: mặc định — sự thật về người dùng.
 */
export function classifyFactTarget(factText: string): LettaCoreLabel {
  const text = (factText ?? '').toLowerCase();
  const personaHints = [
    'trả lời', 'xưng', 'giọng', 'phong cách', 'tính cách', 'ngắn gọn',
    'chi tiết', 'hài hước', 'nghiêm túc', 'thân mật', 'trang trọng',
    'luôn', 'đừng', 'hãy',
  ];
  const projectHints = [
    'dự án', 'project', 'repo', 'code', 'lập trình', 'triển khai',
    'deploy', 'bug', 'tính năng', 'feature', 'api', 'database',
    'mục tiêu', 'deadline', 'kế hoạch',
  ];
  const has = (hints: string[]): boolean => hints.some((h) => text.includes(h));
  if (has(personaHints)) return 'persona';
  if (has(projectHints)) return 'project';
  return 'human';
}

/**
 * Tạo các proposal từ danh sách fact (text + nguồn + độ tin cậy).
 * Fact đã có trong block đích hoặc đã có proposal pending trùng thì
 * bị bỏ qua. Trả về proposal mới tạo + số fact bị bỏ qua (để sleep log).
 */
export function buildSleepProposals(
  facts: Array<{ text: string; source: string; confidence?: number }>,
  existing: SleepProposal[],
  blockContents: Record<string, string>,
): { created: SleepProposal[]; skippedDuplicate: number; skippedEmpty: number } {
  const created: SleepProposal[] = [];
  let skippedDuplicate = 0;
  let skippedEmpty = 0;
  const pending = existing.filter((p) => p.status === 'pending');
  for (const fact of facts) {
    const line = (fact.text ?? '').trim();
    if (line === '') {
      skippedEmpty += 1;
      continue;
    }
    const target = classifyFactTarget(line);
    const lineWords = condenseWords(line);
    // Đã có trong block đích? So trùng theo Jaccard từng dòng.
    const blockLines = (blockContents[target] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const inBlock = blockLines.some(
      (bl) => jaccardSimilarity(lineWords, condenseWords(bl)) >= V9_SLEEP_PROPOSAL_DUP_JACCARD,
    );
    if (inBlock) {
      skippedDuplicate += 1;
      continue;
    }
    // Đã có proposal pending trùng?
    const dupPending = pending
      .concat(created)
      .some(
        (p) =>
          p.targetLabel === target &&
          jaccardSimilarity(lineWords, condenseWords(p.proposedLine)) >= V9_SLEEP_PROPOSAL_DUP_JACCARD,
      );
    if (dupPending) {
      skippedDuplicate += 1;
      continue;
    }
    const now = new Date().toISOString();
    created.push({
      id: randomUUID(),
      botId: '',
      targetLabel: target,
      proposedLine: line,
      reason: `Fact từ ${fact.source} (độ tin cậy ${Math.round((fact.confidence ?? 0.5) * 100)}%).`,
      confidence: Math.max(0, Math.min(1, fact.confidence ?? 0.5)),
      source: fact.source,
      status: 'pending',
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      appliedLine: null,
    });
  }
  return { created, skippedDuplicate, skippedEmpty };
}

/**
 * Store proposal: tạo từ fact, liệt kê, quyết định (approve/reject/
 * apply-edited — approve/apply ghi vào core block qua CoreMemoryManager).
 */
export class SleepProposalStore {
  private readonly filePath: string;
  private readonly decisionsPath: string;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, V9_SLEEP_PROPOSALS_REL_PATH);
    this.decisionsPath = path.join(workspaceDir, V9_SLEEP_PROPOSAL_DECISIONS_REL_PATH);
  }

  readAll(): SleepProposal[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SleepProposalsFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.proposals)) return [];
      return parsed.proposals.filter((p) => p && typeof p.id === 'string');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (err instanceof SyntaxError) return [];
      throw err;
    }
  }

  private writeAll(proposals: SleepProposal[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, proposals }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  private logDecision(entry: SleepProposalDecisionLog): void {
    fs.mkdirSync(path.dirname(this.decisionsPath), { recursive: true });
    fs.appendFileSync(this.decisionsPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  /** Đọc log quyết định (mới nhất trước, tối đa `limit` dòng). */
  readDecisions(limit = 100): SleepProposalDecisionLog[] {
    try {
      const raw = fs.readFileSync(this.decisionsPath, 'utf8');
      const out: SleepProposalDecisionLog[] = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t === '') continue;
        try {
          out.push(JSON.parse(t) as SleepProposalDecisionLog);
        } catch {
          // Bỏ dòng hỏng.
        }
      }
      return out.slice(-Math.max(1, limit)).reverse();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Tạo proposal từ danh sách fact cho một bot. Nội dung block đích
   * được đọc từ CoreMemoryManager để dedupe với fact đã có.
   */
  generateForBot(
    botId: string,
    facts: Array<{ text: string; source: string; confidence?: number }>,
  ): { created: SleepProposal[]; skippedDuplicate: number; skippedEmpty: number } {
    const core = new CoreMemoryManager(this.workspaceDir);
    const blockContents: Record<string, string> = {};
    for (const label of ['persona', 'human', 'project'] as const) {
      const block = core.read(label);
      blockContents[label] = block ? block.content : '';
    }
    const all = this.readAll();
    const result = buildSleepProposals(facts, all, blockContents);
    for (const p of result.created) p.botId = botId;
    if (result.created.length > 0) {
      const next = [...all, ...result.created];
      this.pruneInPlace(next);
      this.writeAll(next);
    }
    return result;
  }

  /** Liệt kê proposal (lọc theo bot/status, mới nhất trước). */
  list(opts: { botId?: string; status?: SleepProposalStatus; limit?: number } = {}): SleepProposal[] {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    return this.readAll()
      .filter((p) => (opts.botId ? p.botId === opts.botId : true))
      .filter((p) => (opts.status ? p.status === opts.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /**
   * Quyết định một proposal:
   *  - approve: append proposedLine vào block đích (có thể cô đọng).
   *  - apply-edited: append `editedLine` (bắt buộc) thay cho proposedLine.
   *  - reject: chỉ ghi log, không sửa block.
   * Trả về proposal sau khi quyết định + dòng đã append (nếu có).
   */
  decide(
    proposalId: string,
    decision: SleepProposalDecision,
    opts: { decidedBy: string; note?: string; editedLine?: string },
  ): { proposal: SleepProposal; appendedLine: string | null; condensed: boolean } {
    const all = this.readAll();
    const proposal = all.find((p) => p.id === proposalId);
    if (!proposal) throw new SleepProposalError(`Không tìm thấy proposal "${proposalId}".`);
    if (proposal.status !== 'pending') {
      throw new SleepProposalError(
        `Proposal đã được quyết định (${proposal.status}), không quyết định lại được.`,
      );
    }
    const now = new Date().toISOString();
    let appendedLine: string | null = null;
    let condensed = false;
    if (decision === 'reject') {
      proposal.status = 'rejected';
    } else {
      const line = decision === 'apply-edited' ? (opts.editedLine ?? '').trim() : proposal.proposedLine;
      if (line === '') throw new SleepProposalError('Dòng fact để append không được rỗng.');
      if (!isLettaCoreLabel(proposal.targetLabel)) {
        throw new SleepProposalError(`Block đích "${proposal.targetLabel}" không phải block hệ thống.`);
      }
      const core = new CoreMemoryManager(this.workspaceDir);
      const result = core.append(proposal.targetLabel, line, proposal.botId, `user:${opts.decidedBy}`);
      condensed = result.condensed;
      appendedLine = line;
      proposal.status = 'applied';
      proposal.appliedLine = line;
    }
    proposal.decidedAt = now;
    proposal.decidedBy = opts.decidedBy;
    proposal.decisionNote = opts.note ?? null;
    this.writeAll(all);
    this.logDecision({
      at: now,
      proposalId: proposal.id,
      botId: proposal.botId,
      targetLabel: proposal.targetLabel,
      decision,
      decidedBy: opts.decidedBy,
      ...(opts.note ? { note: opts.note } : {}),
      ...(appendedLine ? { appliedLine: appendedLine } : {}),
    });
    return { proposal, appendedLine, condensed };
  }

  /**
   * Cắt danh sách proposal về giới hạn (giữ pending mới nhất/điểm cao
   * nhất + decided gần nhất). Gọi nội bộ trước khi ghi.
   */
  private pruneInPlace(proposals: SleepProposal[]): void {
    const pending = proposals
      .filter((p) => p.status === 'pending')
      .sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt))
      .slice(0, V9_SLEEP_PROPOSALS_MAX_PENDING);
    const decided = proposals
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))
      .slice(0, V9_SLEEP_PROPOSALS_MAX_DECIDED);
    proposals.splice(0, proposals.length, ...pending, ...decided);
  }

  /** Thống kê nhanh cho UI. */
  stats(botId?: string): { pending: number; applied: number; rejected: number; approved: number } {
    const all = this.readAll().filter((p) => (botId ? p.botId === botId : true));
    return {
      pending: all.filter((p) => p.status === 'pending').length,
      applied: all.filter((p) => p.status === 'applied').length,
      rejected: all.filter((p) => p.status === 'rejected').length,
      approved: all.filter((p) => p.status === 'approved').length,
    };
  }
}
