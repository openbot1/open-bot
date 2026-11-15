/**
 * Xóa theo yêu cầu v8 (GDPR Article 17 — Right to erasure).
 *
 * Memory v6 là kho ADD-ONLY (retire/quarantine chỉ ẩn bản ghi, nội
 * dung vẫn nằm trong file) — điều đó mâu thuẫn với quyền được xóa:
 * user yêu cầu xóa thì nội dung phải biến mất thật. v8 giải quyết
 * bằng `ErasureService`:
 *
 *  1. EXPORT TRƯỚC KHI XÓA (quyền portability): gói JSON đầy đủ dữ
 *     liệu của user (bản ghi v6 + block v7 + shared block) để user
 *     giữ lại nếu muốn, rồi mới xóa.
 *  2. XÓA BẢN GHI v6: từng bản ghi có scope.userId = userId -> retire
 *     (event, để không còn active) + `scrubRecord` (thay nội dung
 *     bằng tombstone — ngoại lệ duy nhất của add-only, xem store.ts).
 *  3. XÓA BLOCK v7: block v7 KHÔNG gắn userId (chỉ có scope user/
 *     system của workspace) nên không tự đoán "block nào là của
 *     user". Caller truyền `blockLabels` tường minh (user chọn từ
 *     bản export) — không có labels thì không xóa block nào và báo
 *     rõ trong kết quả (skipped + lý do).
 *  4. XÓA SHARED BLOCK: shared block gắn ownerBotId (bot, không phải
 *     user). Caller truyền `botIds` của user — block do các bot đó
 *     sở hữu thì xóa; không có botIds thì không xóa block nào.
 *  5. SCRUB LOG: dòng provenance log (JSONL) chứa userId được viết
 *     lại với userId thay bằng "[erased]" (giữ lại quyết định audit,
 *     xóa định danh).
 *  6. AUDIT LOG: mỗi yêu cầu xóa append một dòng JSONL (requestId,
 *     userId, scope, tổng số đã xóa, verified) — audit log KHÔNG bị
 *     xóa (đó là bằng chứng đã thực hiện yêu cầu).
 *  7. VERIFY: sau khi xóa, quét lại toàn bộ kho — bản ghi nào của
 *     user còn nội dung thật (không phải tombstone) thì liệt kê vào
 *     verifyFindings và verified = false.
 *
 * LƯU Ý TRUNG THỰC: xóa local không xóa được bản sao đã đồng bộ sang
 * máy khác qua gói fleet (gói đã mang đi thì máy nhận phải tự xóa).
 * Báo cáo xóa ghi rõ giới hạn này; tool hiển thị cho user.
 * 100% local, không mạng. Không tuyên bố điểm benchmark nào.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { V6RecordStore } from '../v3/store';
import type { V6RecordView } from '../v3/types';
import type { GitMemoryProjection } from '../gitProjection';
import type { SharedBlockStore } from '../v3/blocks';
import { MEMORY_PROVENANCE_LOG_REL_PATH } from '../provenance';
import type {
  V8ErasureAuditEntry,
  V8ErasureItemResult,
  V8ErasureReport,
  V8ErasureRequest,
  V8ErasureScope,
  V8UserDataExport,
} from './types';

/** Đường dẫn tương đối của audit log xóa v8 trong workspace. */
export const V8_ERASURE_AUDIT_REL_PATH = path.join('.open-bot', 'memory-v8-erasure-audit.jsonl');
/** Text tombstone thay cho nội dung đã xóa (khớp với scrubRecord). */
export const V8_ERASURE_TOMBSTONE = '[đã xóa theo yêu cầu]';

/** Lỗi erasure v8 — mọi message đều tiếng Việt. */
export class V8ErasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V8ErasureError';
  }
}

/** Tuỳ chọn cho ErasureService. */
export interface ErasureServiceOptions {
  /** Store v6 (bắt buộc). */
  store: V6RecordStore;
  /** Thư mục workspace (audit log + scrub provenance log; bắt buộc để ghi audit). */
  workspaceDir: string;
  /** Projection block v7 (để xóa block theo label; không có thì bỏ qua hạng mục này). */
  projection?: GitMemoryProjection;
  /** Store shared block v6 (để xóa block theo ownerBotId). */
  sharedBlocks?: SharedBlockStore;
}

/** Tuỳ chọn một lần xóa (ngoài request). */
export interface EraseUserOptions {
  /** Label block v7 cần xóa (user chọn từ bản export). */
  blockLabels?: string[];
  /** Bot id của user — shared block do các bot này sở hữu sẽ bị xóa. */
  botIds?: string[];
  /** "Bây giờ" (để test; mặc định new Date()). */
  now?: Date;
}

/** Đọc audit log xóa (mới nhất cuối mảng). */
export function readV8ErasureAudit(workspaceDir: string): V8ErasureAuditEntry[] {
  const filePath = path.join(workspaceDir, V8_ERASURE_AUDIT_REL_PATH);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const out: V8ErasureAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        out.push(JSON.parse(trimmed) as V8ErasureAuditEntry);
      } catch {
        // Bỏ qua một dòng hỏng, giữ các dòng còn lại.
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

/** Append một dòng vào audit log xóa (mode 0600, fail-open). */
export function appendV8ErasureAudit(workspaceDir: string, entry: V8ErasureAuditEntry): void {
  try {
    const filePath = path.join(workspaceDir, V8_ERASURE_AUDIT_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Audit ghi lỗi thì bỏ qua — không fail lần xóa.
  }
}

/**
 * Dịch vụ xóa theo yêu cầu (GDPR).
 *
 *  - `exportUserData(userId, opts?)`: gói portability (đọc, không sửa).
 *  - `eraseUser(request, opts?)`: chạy xóa theo phạm vi + verify +
 *    audit. Trả về báo cáo đầy đủ.
 *  - `verifyUserGone(userId)`: quét lại kho sau xóa (dùng nội bộ
 *    trong eraseUser, cũng expose để UI kiểm tra lại sau).
 */
export class ErasureService {
  private readonly store: V6RecordStore;
  private readonly workspaceDir: string;
  private readonly projection: GitMemoryProjection | undefined;
  private readonly sharedBlocks: SharedBlockStore | undefined;

  constructor(opts: ErasureServiceOptions) {
    if (!opts.store) throw new V8ErasureError('ErasureService cần V6RecordStore.');
    if (!opts.workspaceDir || opts.workspaceDir.trim() === '') {
      throw new V8ErasureError('ErasureService cần workspaceDir để ghi audit log.');
    }
    this.store = opts.store;
    this.workspaceDir = opts.workspaceDir;
    this.projection = opts.projection;
    this.sharedBlocks = opts.sharedBlocks;
  }

  /** Gói export dữ liệu của user (portability) — chỉ đọc, không sửa. */
  exportUserData(userId: string, opts: { botIds?: string[]; now?: Date } = {}): V8UserDataExport {
    const trimmedUserId = (userId ?? '').trim();
    if (trimmedUserId === '') throw new V8ErasureError('userId không được rỗng khi export dữ liệu.');
    const records = this.store
      .listAll()
      .filter((r) => r.scope.userId === trimmedUserId)
      .map((r) => ({ ...r }));
    const blocks: Array<Record<string, unknown>> = [];
    if (this.projection) {
      for (const block of this.projection.list()) {
        if (block.scope === 'user') blocks.push({ ...block });
      }
    }
    const sharedBlocks: Array<Record<string, unknown>> = [];
    if (this.sharedBlocks && opts.botIds && opts.botIds.length > 0) {
      const botSet = new Set(opts.botIds);
      for (const block of this.sharedBlocks.listBlocks()) {
        if (botSet.has(block.ownerBotId)) sharedBlocks.push({ ...block });
      }
    }
    return {
      format: 'open-bot-user-data-v8',
      version: 1,
      userId: trimmedUserId,
      exportedAt: (opts.now ?? new Date()).toISOString(),
      records: records as unknown as Array<Record<string, unknown>>,
      blocks,
      sharedBlocks,
    };
  }

  /**
   * Chạy một yêu cầu xóa: export ngầm KHÔNG tự động — host nên gọi
   * exportUserData trước và đưa gói cho user giữ (tool memory_v8 làm
   * việc này trong cùng một lần gọi: export rồi mới xóa).
   */
  eraseUser(request: V8ErasureRequest, opts: EraseUserOptions = {}): V8ErasureReport {
    const userId = (request.userId ?? '').trim();
    if (userId === '') throw new V8ErasureError('userId không được rỗng khi xóa dữ liệu.');
    const startedAt = (opts.now ?? new Date()).toISOString();
    const actor = (request.requestedBy ?? 'user').trim() || 'user';
    const results: V8ErasureItemResult[] = [];
    const scope = request.scope;

    // --- Hạng mục 1: bản ghi v6. ---
    if (scope === 'all' || scope === 'records') {
      const result: V8ErasureItemResult = { category: 'v6-records', erased: 0, skipped: 0, errors: [] };
      const mine = this.store.listAll().filter((r) => r.scope.userId === userId);
      for (const record of mine) {
        try {
          if (record.text === V8_ERASURE_TOMBSTONE && record.status === 'retired') {
            result.skipped += 1;
            continue;
          }
          const scrubbed = this.store.scrubRecord(
            record.id,
            actor,
            `Xóa theo yêu cầu ${request.id} (${request.reason}).`,
          );
          if (scrubbed) result.erased += 1;
          else result.skipped += 1;
        } catch (err) {
          result.errors.push(`Bản ghi ${record.id}: ${(err as Error).message}`);
        }
      }
      results.push(result);
    }

    // --- Hạng mục 2: block v7 (chỉ label do user chỉ định). ---
    if (scope === 'all' || scope === 'blocks') {
      const result: V8ErasureItemResult = { category: 'v7-blocks', erased: 0, skipped: 0, errors: [] };
      const labels = opts.blockLabels ?? [];
      if (!this.projection) {
        result.errors.push('Không có projection v7 nên không xóa được block nào.');
      } else if (labels.length === 0) {
        result.errors.push(
          'Block v7 không gắn userId nên không tự đoán block nào là của user — cần truyền blockLabels (chọn từ bản export). Không xóa block nào.',
        );
      } else {
        for (const label of labels) {
          try {
            const deleted = this.projection.delete(label, actor);
            if (deleted) result.erased += 1;
            else result.skipped += 1;
          } catch (err) {
            result.errors.push(`Block "${label}": ${(err as Error).message}`);
          }
        }
      }
      results.push(result);
    }

    // --- Hạng mục 3: shared block (chỉ bot của user). ---
    if (scope === 'all' || scope === 'shared-blocks') {
      const result: V8ErasureItemResult = { category: 'shared-blocks', erased: 0, skipped: 0, errors: [] };
      const botIds = opts.botIds ?? [];
      if (!this.sharedBlocks) {
        result.errors.push('Không có shared block store nên không xóa được block nào.');
      } else if (botIds.length === 0) {
        result.errors.push(
          'Shared block gắn ownerBotId (bot, không phải user) nên cần truyền botIds của user — không xóa block nào.',
        );
      } else {
        const botSet = new Set(botIds);
        for (const block of this.sharedBlocks.listBlocks()) {
          if (!botSet.has(block.ownerBotId)) {
            result.skipped += 1;
            continue;
          }
          try {
            if (this.sharedBlocks.deleteBlock(block.ownerBotId, block.id)) result.erased += 1;
            else result.skipped += 1;
          } catch (err) {
            result.errors.push(`Shared block "${block.name}": ${(err as Error).message}`);
          }
        }
      }
      results.push(result);
    }

    // --- Hạng mục 4: scrub provenance log (xóa định danh userId). ---
    const logResult: V8ErasureItemResult = { category: 'provenance-log', erased: 0, skipped: 0, errors: [] };
    try {
      logResult.erased = this.scrubProvenanceLog(userId);
    } catch (err) {
      logResult.errors.push(`Scrub provenance log lỗi: ${(err as Error).message}`);
    }
    results.push(logResult);

    // --- Verify + audit. ---
    const verifyFindings = this.verifyUserGone(userId, opts);
    const totalErased = results.reduce((sum, r) => sum + r.erased, 0);
    const report: V8ErasureReport = {
      requestId: request.id,
      userId,
      scope,
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
      totalErased,
      verified: verifyFindings.length === 0,
      verifyFindings,
    };
    appendV8ErasureAudit(this.workspaceDir, {
      requestId: request.id,
      userId,
      scope,
      totalErased,
      verified: report.verified,
      requestedBy: actor,
      at: report.finishedAt,
    });
    return report;
  }

  /**
   * Verify: quét lại kho — bản ghi nào của user còn nội dung thật
   * (không phải tombstone) thì liệt kê. Trả về danh sách findings
   * (rỗng = sạch).
   */
  verifyUserGone(userId: string, opts: { blockLabels?: string[]; botIds?: string[] } = {}): string[] {
    const findings: string[] = [];
    const trimmed = (userId ?? '').trim();
    if (trimmed === '') return ['userId rỗng — không verify được.'];
    for (const record of this.store.listAll()) {
      if (record.scope.userId !== trimmed) continue;
      if (record.text !== V8_ERASURE_TOMBSTONE) {
        findings.push(`Bản ghi ${record.id} còn nội dung (status ${record.status}).`);
      }
    }
    if (this.projection && opts.blockLabels) {
      for (const label of opts.blockLabels) {
        if (this.projection.get(label)) findings.push(`Block v7 "${label}" vẫn còn.`);
      }
    }
    if (this.sharedBlocks && opts.botIds) {
      const botSet = new Set(opts.botIds);
      for (const block of this.sharedBlocks.listBlocks()) {
        if (botSet.has(block.ownerBotId)) findings.push(`Shared block "${block.name}" vẫn còn.`);
      }
    }
    return findings;
  }

  /**
   * Scrub provenance log: viết lại file JSONL, thay userId bằng
   * "[erased]" trong các dòng chứa nó. Trả về số dòng đã scrub.
   * Audit log xóa (v8-erasure-audit.jsonl) KHÔNG bị scrub — đó là
   * bằng chứng đã thực hiện yêu cầu xóa.
   */
  scrubProvenanceLog(userId: string): number {
    const filePath = path.join(this.workspaceDir, MEMORY_PROVENANCE_LOG_REL_PATH);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    const lines = raw.split('\n');
    let scrubbed = 0;
    const out = lines.map((line) => {
      if (line.trim() === '' || !line.includes(userId)) return line;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        let changed = false;
        for (const [key, value] of Object.entries(entry)) {
          if (typeof value === 'string' && value.includes(userId)) {
            entry[key] = value.split(userId).join('[erased]');
            changed = true;
          }
        }
        if (changed) scrubbed += 1;
        return JSON.stringify(entry);
      } catch {
        // Dòng hỏng mà chứa userId: thay thẳng chuỗi (best-effort).
        scrubbed += 1;
        return line.split(userId).join('[erased]');
      }
    });
    if (scrubbed > 0) {
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    }
    return scrubbed;
  }
}

/** Tạo một yêu cầu xóa mới (id + thời gian tự sinh). */
export function newV8ErasureRequest(opts: {
  userId: string;
  scope?: V8ErasureScope;
  reason?: string;
  requestedBy?: string;
  now?: Date;
}): V8ErasureRequest {
  const userId = (opts.userId ?? '').trim();
  if (userId === '') throw new V8ErasureError('userId không được rỗng khi tạo yêu cầu xóa.');
  return {
    id: randomUUID(),
    userId,
    scope: opts.scope ?? 'all',
    reason: (opts.reason ?? 'User yêu cầu xóa dữ liệu (GDPR Article 17).').slice(0, 500),
    requestedBy: (opts.requestedBy ?? 'user').trim() || 'user',
    requestedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/** Định dạng báo cáo xóa thành text đọc được (trả cho user). */
export function formatV8ErasureReport(report: V8ErasureReport): string {
  const lines: string[] = [];
  lines.push(`Yêu cầu xóa ${report.requestId} — user ${report.userId} (phạm vi ${report.scope})`);
  lines.push(`  tổng đã xóa/scrub: ${report.totalErased} mục · verify: ${report.verified ? 'SẠCH' : 'CÒN SÓT'}`);
  for (const result of report.results) {
    lines.push(`  - ${result.category}: xóa ${result.erased}, bỏ qua ${result.skipped}`);
    for (const error of result.errors) lines.push(`      lưu ý: ${error}`);
  }
  if (!report.verified) {
    for (const finding of report.verifyFindings) lines.push(`  CÒN SÓT: ${finding}`);
  }
  lines.push('  Giới hạn: xóa local không xóa được bản sao đã đồng bộ sang máy khác qua gói fleet — máy nhận phải tự xóa.');
  return lines.join('\n');
}
