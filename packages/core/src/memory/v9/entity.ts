/**
 * Memory v9 kiểu Letta — agent là thực thể bền vững (v1.09, Đội T2).
 *
 * Ý tưởng học từ Letta: mỗi agent là một thực thể có memory riêng
 * bền vững qua các phiên (core blocks + recall + archival + sleep
 * proposals), có thể snapshot / restore / xuất / nhập nguyên vẹn.
 * Viết lại hoàn toàn cho open-bot trên các store đã có — KHÔNG viết
 * lại store, chỉ gộp chúng thành một "entity" cho mỗi bot:
 *
 *  - PersistentAgentMemory: một bot = một entity. Gộp CoreMemoryManager
 *    (core blocks đã attach), RecallStore (phiên gần đây), ArchivalStore
 *    (kho dài hạn) và SleepProposalStore (đề xuất chờ quyết định).
 *  - snapshot(): chụp toàn bộ memory của bot thành một object JSON
 *    (kèm checksum SHA-256 để phát hiện file bị sửa tay) — restore()
 *    kiểm tra checksum trước khi ghi.
 *  - export/import: snapshot lưu thành file `.json` (người dùng tự
 *    chọn nơi lưu qua UI MemFS), import với 2 chế độ: `replace`
 *    (xoá memory cũ của bot rồi ghi snapshot) hoặc `merge` (giữ cũ,
 *    chỉ thêm mục mới / block chưa có, block đã có thì không ghi đè).
 *  - stats(): đếm nhanh 3 tầng + proposals cho UI.
 *  - renderContext(): core prompt + tóm tắt recall gần nhất — đoạn
 *    text host chèn vào system prompt khi mở phiên mới.
 *
 * Entity KHÔNG giữ model key hay secret nào: snapshot chỉ chứa text
 * memory. Embedding trong archival được giữ nguyên khi export (vẫn
 * là vector nội bộ, file export nằm trên máy user).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CoreMemoryManager } from './coreMemory';
import type { MemoryBlock } from '../blocks';
import { RecallStore } from './recall';
import type { RecallSession } from './recall';
import { ArchivalStore } from './archival';
import type { ArchivalItem } from './archival';
import { SleepProposalStore } from './sleepProposals';
import type { SleepProposal } from './sleepProposals';
import { V9_SLEEP_PROPOSALS_REL_PATH } from './sleepProposals';

/** Version của định dạng snapshot/export. */
export const LETTA_ENTITY_SNAPSHOT_VERSION = 1;

/** Một snapshot memory của bot (đủ để restore nguyên vẹn). */
export interface LettaEntitySnapshot {
  format: 'open-bot-letta-entity';
  version: number;
  botId: string;
  exportedAt: string;
  /** SHA-256 hex của payload (tính trên JSON ổn định, xem checksum). */
  checksum: string;
  coreBlocks: MemoryBlock[];
  /** botId -> danh sách block id đã attach (giữ thứ tự). */
  attachments: string[];
  recallSessions: RecallSession[];
  archivalItems: ArchivalItem[];
  proposals: SleepProposal[];
}

/** Chế độ restore/import. */
export type LettaRestoreMode = 'replace' | 'merge';

/** Kết quả restore/import. */
export interface LettaRestoreReport {
  botId: string;
  mode: LettaRestoreMode;
  blocksRestored: number;
  blocksSkipped: number;
  recallRestored: number;
  archivalRestored: number;
  proposalsRestored: number;
  detail: string;
}

/** Thống kê 3 tầng + proposals của một bot. */
export interface LettaEntityStats {
  botId: string;
  coreBlocks: Array<{ label: string; chars: number; limit: number; version: number }>;
  recallSessions: number;
  recallEpisodes: number;
  archivalItems: number;
  archivalEmbedded: number;
  proposalsPending: number;
  proposalsApplied: number;
}

/** Lỗi entity — message tiếng Việt. */
export class LettaEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LettaEntityError';
  }
}

/** SHA-256 hex của một chuỗi. */
export function lettaSha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Checksum của snapshot: hash trên payload đã loại checksum + sắp xếp
 * key ổn định (JSON.stringify với replacer sắp xếp) để cùng một nội
 * dung luôn cho cùng một checksum.
 */
export function snapshotChecksum(snapshot: Omit<LettaEntitySnapshot, 'checksum'>): string {
  const stable = lettaStableStringify({
    format: snapshot.format,
    version: snapshot.version,
    botId: snapshot.botId,
    exportedAt: snapshot.exportedAt,
    coreBlocks: snapshot.coreBlocks,
    attachments: snapshot.attachments,
    recallSessions: snapshot.recallSessions,
    archivalItems: snapshot.archivalItems,
    proposals: snapshot.proposals,
  });
  return lettaSha256Hex(stable);
}

/** JSON.stringify với key đã sắp xếp (đệ quy) — checksum ổn định. */
export function lettaStableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(lettaStableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${lettaStableStringify(obj[k])}`).join(',')}}`;
}

/** Kiểm tra một object có phải snapshot hợp lệ không (kèm checksum). */
export function validateLettaSnapshot(raw: unknown): LettaEntitySnapshot {
  if (!raw || typeof raw !== 'object') throw new LettaEntityError('Snapshot không phải object JSON.');
  const s = raw as Partial<LettaEntitySnapshot>;
  if (s.format !== 'open-bot-letta-entity') {
    throw new LettaEntityError('File không phải snapshot memory kiểu Letta của open-bot.');
  }
  if (s.version !== LETTA_ENTITY_SNAPSHOT_VERSION) {
    throw new LettaEntityError(`Phiên bản snapshot ${String(s.version)} không được hỗ trợ (cần v${LETTA_ENTITY_SNAPSHOT_VERSION}).`);
  }
  if (typeof s.botId !== 'string' || s.botId.trim() === '') {
    throw new LettaEntityError('Snapshot thiếu botId.');
  }
  if (!Array.isArray(s.coreBlocks) || !Array.isArray(s.recallSessions) || !Array.isArray(s.archivalItems)) {
    throw new LettaEntityError('Snapshot thiếu coreBlocks/recallSessions/archivalItems.');
  }
  if (typeof s.checksum !== 'string' || s.checksum === '') {
    throw new LettaEntityError('Snapshot thiếu checksum.');
  }
  const { checksum, ...rest } = s as LettaEntitySnapshot;
  const expected = snapshotChecksum(rest);
  if (expected !== checksum) {
    throw new LettaEntityError('Checksum snapshot không khớp — file có thể đã bị sửa tay hoặc hỏng.');
  }
  return s as LettaEntitySnapshot;
}

/**
 * Thực thể memory bền vững của một bot: gộp core + recall + archival
 * + proposals, snapshot/restore/export/import qua một API duy nhất.
 */
export class PersistentAgentMemory {
  readonly botId: string;
  private readonly workspaceDir: string;
  readonly core: CoreMemoryManager;
  readonly recall: RecallStore;
  readonly archival: ArchivalStore;
  readonly proposals: SleepProposalStore;

  constructor(workspaceDir: string, botId: string) {
    if ((botId ?? '').trim() === '') throw new LettaEntityError('botId không được rỗng.');
    this.botId = botId;
    this.workspaceDir = workspaceDir;
    this.core = new CoreMemoryManager(workspaceDir);
    this.recall = new RecallStore(workspaceDir);
    this.archival = new ArchivalStore(workspaceDir);
    this.proposals = new SleepProposalStore(workspaceDir);
  }

  /** Chụp toàn bộ memory hiện tại của bot thành snapshot (kèm checksum). */
  snapshot(): LettaEntitySnapshot {
    const attached = this.core.listAttached(this.botId);
    const base: Omit<LettaEntitySnapshot, 'checksum'> = {
      format: 'open-bot-letta-entity',
      version: LETTA_ENTITY_SNAPSHOT_VERSION,
      botId: this.botId,
      exportedAt: new Date().toISOString(),
      coreBlocks: attached,
      attachments: attached.map((b) => b.id),
      recallSessions: this.recall.readAll().filter((s) => s.botId === this.botId),
      archivalItems: this.archival.readAll(),
      proposals: this.proposals.readAll().filter((p) => p.botId === this.botId),
    };
    return { ...base, checksum: snapshotChecksum(base) };
  }

  /**
   * Khôi phục memory của bot từ snapshot (đã validate checksum).
   *  - replace: xoá toàn bộ core blocks đã attach + recall của bot +
   *    proposals của bot, rồi ghi snapshot; archival là kho chung của
   *    workspace nên replace chỉ xoá mục có trong snapshot cũ? Không
   *    — archival KHÔNG bị xoá ở chế độ nào (kho chung, xoá nhầm sẽ
   *    mất dữ liệu của bot khác); replace chỉ thay core/recall/proposals.
   *  - merge: giữ nguyên memory cũ, chỉ thêm block chưa có (theo
   *    label), recall session chưa có (theo sessionId), archival mục
   *    chưa có (theo id), proposal chưa có (theo id).
   */
  restore(snapshot: LettaEntitySnapshot, mode: LettaRestoreMode = 'replace'): LettaRestoreReport {
    const validated = validateLettaSnapshot(snapshot);
    if (validated.botId !== this.botId) {
      throw new LettaEntityError(
        `Snapshot thuộc bot "${validated.botId}", không restore vào bot "${this.botId}" được.`,
      );
    }
    const report: LettaRestoreReport = {
      botId: this.botId,
      mode,
      blocksRestored: 0,
      blocksSkipped: 0,
      recallRestored: 0,
      archivalRestored: 0,
      proposalsRestored: 0,
      detail: '',
    };
    const actor = 'user:restore';
    if (mode === 'replace') {
      // Xoá core blocks đã attach vào bot (chỉ detach + xoá block nào
      // không còn bot nào khác attach — store.delete đã xử lý detach;
      // block share với bot khác vẫn còn vì delete xoá hẳn block...
      // nên replace chỉ detach khỏi bot này, rồi tạo lại từ snapshot).
      for (const block of this.core.listAttached(this.botId)) {
        this.core.blockStore.detach(this.botId, block.id, actor);
      }
      // Recall: xoá session của bot này.
      for (const s of this.recall.readAll().filter((x) => x.botId === this.botId)) {
        this.recall.deleteSession(s.sessionId);
      }
      // Proposals của bot: xoá bằng cách ghi lại file đã lọc (qua API
      // nội bộ của store — dùng readAll + write lại qua generate? Không
      // có API xoá — dùng cách: tạo store mới không làm được. Thay vào
      // đó, replace proposals bằng cách ghi đè trực tiếp file JSON.
      this.clearProposalsForBot();
    }
    // Core blocks: tạo lại (replace) hoặc chỉ thêm block chưa có (merge).
    for (const snapBlock of validated.coreBlocks) {
      const existing = this.core.read(snapBlock.label);
      if (mode === 'merge' && existing) {
        report.blocksSkipped += 1;
        if (!this.core.blockStore.isAttached(this.botId, existing.id)) {
          this.core.blockStore.attach(this.botId, existing.id, actor);
        }
        continue;
      }
      if (mode === 'replace' && existing) {
        // Block cùng label đã có (thuộc bot khác hoặc detach rồi):
        // xoá hẳn để tạo lại đúng nội dung snapshot.
        this.core.blockStore.delete(existing.id, actor);
      }
      const created = this.core.blockStore.create(
        {
          label: snapBlock.label,
          description: snapBlock.description,
          content: snapBlock.content,
          charLimit: snapBlock.charLimit,
          readOnly: snapBlock.readOnly,
          createdByBotId: this.botId,
        },
        actor,
      );
      this.core.blockStore.attach(this.botId, created.id, actor);
      report.blocksRestored += 1;
    }
    // Recall: ghi lại session (ghi trực tiếp qua recordSession sẽ
    // cô đọng lại summary — nên append thẳng vào file JSONL qua API
    // nội bộ: dùng lại recordSession với episode gốc để summary khớp).
    const existingSessions = new Set(this.recall.readAll().map((s) => s.sessionId));
    for (const s of validated.recallSessions) {
      if (mode === 'merge' && existingSessions.has(s.sessionId)) continue;
      this.recall.recordSession({
        sessionId: s.sessionId,
        botId: s.botId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        episodes: s.episodes.map((ep) => ({ role: ep.role, text: ep.text, at: ep.at })),
      });
      report.recallRestored += 1;
    }
    // Archival: chỉ thêm mục chưa có (theo id) — cả 2 chế độ đều không xoá.
    const existingArchival = new Set(this.archival.readAll().map((it) => it.id));
    for (const item of validated.archivalItems) {
      if (existingArchival.has(item.id)) continue;
      this.archival.insert({
        text: item.text,
        source: item.source,
        sourceId: item.sourceId,
        tags: item.tags,
        confidence: item.confidence,
        embedding: item.embedding,
      });
      report.archivalRestored += 1;
    }
    // Proposals: chỉ thêm proposal chưa có (theo id).
    const existingProposals = new Set(this.proposals.readAll().map((p) => p.id));
    const toAdd = validated.proposals.filter((p) => !existingProposals.has(p.id));
    if (toAdd.length > 0) {
      this.appendProposals(toAdd);
      report.proposalsRestored = toAdd.length;
    }
    report.detail =
      `Restore ${mode}: ${report.blocksRestored} block, ${report.recallRestored} phiên recall, ` +
      `${report.archivalRestored} mục archival, ${report.proposalsRestored} proposal` +
      (report.blocksSkipped > 0 ? `, bỏ qua ${report.blocksSkipped} block đã có` : '') +
      `.`;
    return report;
  }

  /** Xuất snapshot ra file JSON (ghi atomic, mode 0600). Trả về đường dẫn. */
  exportToFile(filePath: string): string {
    const snapshot = this.snapshot();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return filePath;
  }

  /** Nhập snapshot từ file JSON (validate checksum rồi restore). */
  importFromFile(filePath: string, mode: LettaRestoreMode = 'merge'): LettaRestoreReport {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LettaEntityError(`Không tìm thấy file snapshot "${filePath}".`);
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LettaEntityError('File snapshot không phải JSON hợp lệ.');
    }
    return this.restore(validateLettaSnapshot(parsed), mode);
  }

  /** Thống kê 3 tầng + proposals của bot (cho UI). */
  stats(): LettaEntityStats {
    const recallStats = this.recall.stats();
    const archivalStats = this.archival.stats();
    const proposalStats = this.proposals.stats(this.botId);
    return {
      botId: this.botId,
      coreBlocks: this.core.listAttached(this.botId).map((b) => ({
        label: b.label,
        chars: b.content.length,
        limit: b.charLimit,
        version: b.version,
      })),
      recallSessions: recallStats.sessions,
      recallEpisodes: recallStats.episodes,
      archivalItems: archivalStats.items,
      archivalEmbedded: archivalStats.embedded,
      proposalsPending: proposalStats.pending,
      proposalsApplied: proposalStats.applied,
    };
  }

  /**
   * Context cho phiên mới: core prompt + tóm tắt 3 phiên gần nhất.
   * Host chèn đoạn này vào system prompt khi mở phiên.
   */
  renderContext(): string {
    const corePrompt = this.core.renderCorePrompt(this.botId);
    const recent = this.recall.recall({ botId: this.botId, limit: 3 });
    const recallPart =
      recent.length === 0
        ? ''
        : '\n## Recent sessions (recall — tóm tắt phiên gần đây)\n' +
          recent
            .map((hit) => `- [${hit.session.endedAt}] ${hit.session.summary}`)
            .join('\n') +
          '\n## Hết recall';
    return [corePrompt, recallPart].filter((part) => part !== '').join('\n');
  }

  /** Xoá proposals của bot này (dùng khi restore chế độ replace). */
  private clearProposalsForBot(): void {
    const filePath = path.join(this.workspaceDir, V9_SLEEP_PROPOSALS_REL_PATH);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { version: 1; proposals: SleepProposal[] };
      if (!parsed || !Array.isArray(parsed.proposals)) return;
      const kept = parsed.proposals.filter((p) => p.botId !== this.botId);
      const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, proposals: kept }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /** Thêm thẳng proposal vào file (dùng khi restore — giữ nguyên id/status). */
  private appendProposals(toAdd: SleepProposal[]): void {
    const filePath = path.join(this.workspaceDir, V9_SLEEP_PROPOSALS_REL_PATH);
    let existing: SleepProposal[] = [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { version: 1; proposals: SleepProposal[] };
      if (parsed && Array.isArray(parsed.proposals)) existing = parsed.proposals;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const next = [...existing, ...toAdd];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, proposals: next }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }
}
