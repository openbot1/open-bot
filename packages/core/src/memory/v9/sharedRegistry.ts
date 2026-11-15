/**
 * Shared-block registry v9 (v1.08, Đội T1).
 *
 * Ý tưởng học từ Letta "shared memory blocks" (nhiều agent chia sẻ
 * cùng block, update một nơi thấy ở mọi nơi) và Conversations API
 * (memory là tài nguyên dùng chung có quyền), viết lại hoàn toàn cho
 * open-bot, chạy 100% local, không copy code/tài sản nào. v1.03 đã
 * có nhóm share (SharedBlockGroup — share theo nhóm, role theo
 * thành viên) và v8 có gói sync fleet (export/import theo packet) —
 * nhưng chưa có REGISTRY cấp block:
 *
 *  - ĐĂNG KÝ: một block trong projection được đăng ký dùng chung
 *    (owner là bot đăng ký; block vẫn sống duy nhất trong
 *    projection, registry chỉ lưu quan hệ + metadata).
 *  - ACL THEO BOT: mỗi bot có role read | write | admin trên từng
 *    block; chỉ owner/admin mới cấp/thu quyền; owner không bao giờ
 *    mất quyền admin.
 *  - CHANGE FEED: mỗi lần ghi thành công append một change (seq
 *    tăng đơn điệu theo block) — bot khác gọi sync() để lấy những
 *    change mình chưa thấy; seenSeq ghi lại mỗi bot đã thấy tới đâu.
 *  - XUNG ĐỘT GHI: ghi phải kèm baseVersion (phiên bản mà writer
 *    đã đọc). Nếu block đã đổi từ lúc đó (version hiện tại != base)
 *    thì KHÔNG ghi đè: ghi lại xung đột (pending) kèm nội dung
 *    writer muốn ghi, để owner/admin hoặc chính writer resolve sau
 *    (keep-mine / keep-theirs / merged). Không bao giờ mất dữ liệu
 *    trong im lặng.
 *  - VERSION VECTOR: mỗi bot ghi tới version nào — để UI/fleet
 *    thấy ai đang "đi trước" ai, và để phát hiện ghi đồng thời.
 *
 * Lưu trữ: registry JSON + change feed JSONL + conflicts JSON, đều
 * dưới `.open-bot/`, ghi atomic (temp + rename, mode 0600) như các
 * module memory khác. Nội dung block KHÔNG nhân bản vào registry
 * (trừ nội dung của xung đột pending — cần giữ để resolve).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GitMemoryProjection } from '../gitProjection';
import { GitMemoryProjection as GitMemoryProjectionClass } from '../gitProjection';
import {
  normalizeV9BlockLabel,
  normalizeV9BotId,
  V9_MAX_MERGED_CONTENT_CHARS,
  V9_MAX_NOTE_CHARS,
  V9_SHARED_ACTOR_PREFIX,
  V9_SHARED_CHANGES_PER_BLOCK_KEEP,
  V9_SHARED_CHANGES_REL_PATH,
  V9_SHARED_CONFLICTS_KEEP,
  V9_SHARED_CONFLICTS_REL_PATH,
  V9_SHARED_REGISTRY_REL_PATH,
  V9_SHARED_ROLE_RANK,
  V9Error,
} from './types';
import type {
  V9SharedAclEntry,
  V9SharedBlockEntry,
  V9SharedChange,
  V9SharedConflict,
  V9SharedConflictResolution,
  V9SharedConflictStatus,
  V9SharedConflictsFile,
  V9SharedRegistryFile,
  V9SharedRole,
  V9SharedSyncStatus,
  V9SharedWriteResult,
} from './types';
import { v9Sha256Hex } from './versioning';

/** Tuỳ chọn registry. */
export interface SharedBlockRegistryOptions {
  /** Projection block v7 (mặc định tạo mới từ workspace). */
  projection?: GitMemoryProjection;
}

/** Kết quả sync: trạng thái + change chưa thấy + xung đột đang chờ. */
export interface V9SharedSyncResult {
  status: V9SharedSyncStatus;
  changes: V9SharedChange[];
  pendingConflicts: V9SharedConflict[];
  /** Seq mới nhất bot này đã thấy sau lần sync này. */
  seenSeq: number;
}

/** Kết quả đăng ký / cấp quyền (trả entry sau khi đổi). */
export type V9SharedRegistryChange = V9SharedBlockEntry;

function isValidRole(role: unknown): role is V9SharedRole {
  return role === 'read' || role === 'write' || role === 'admin';
}

/**
 * Registry block dùng chung: đăng ký, ACL, ghi có kiểm tra xung
 * đột, change feed, resolve xung đột. Chạy trên projection v7.
 */
export class SharedBlockRegistry {
  private readonly workspaceDir: string;
  private readonly projection: GitMemoryProjection;

  constructor(workspaceDir: string, opts: SharedBlockRegistryOptions = {}) {
    this.workspaceDir = workspaceDir;
    this.projection = opts.projection ?? new GitMemoryProjectionClass(workspaceDir);
  }

  /** Projection đang dùng. */
  getProjection(): GitMemoryProjection {
    return this.projection;
  }

  /* ---------------- persistence ---------------- */

  private registryPath(): string {
    return path.join(this.workspaceDir, V9_SHARED_REGISTRY_REL_PATH);
  }

  private conflictsPath(): string {
    return path.join(this.workspaceDir, V9_SHARED_CONFLICTS_REL_PATH);
  }

  private changesPath(): string {
    return path.join(this.workspaceDir, V9_SHARED_CHANGES_REL_PATH);
  }

  private loadRegistry(): V9SharedRegistryFile {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.registryPath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as V9SharedRegistryFile).blocks)) {
        return parsed as V9SharedRegistryFile;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new V9Error(`File registry shared-block v9 hỏng: ${this.registryPath()}`);
      }
    }
    return { version: 1, blocks: [] };
  }

  private saveRegistry(file: V9SharedRegistryFile): void {
    const filePath = this.registryPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  private loadConflicts(): V9SharedConflictsFile {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.conflictsPath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as V9SharedConflictsFile).conflicts)) {
        return parsed as V9SharedConflictsFile;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new V9Error(`File xung đột shared-block v9 hỏng: ${this.conflictsPath()}`);
      }
    }
    return { version: 1, conflicts: [] };
  }

  private saveConflicts(file: V9SharedConflictsFile): void {
    const filePath = this.conflictsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  /** Mọi change trong feed (cũ nhất trước). */
  readChanges(): V9SharedChange[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.changesPath(), 'utf8');
    } catch {
      return [];
    }
    const out: V9SharedChange[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as V9SharedChange;
        if (parsed && typeof parsed.label === 'string' && typeof parsed.seq === 'number') out.push(parsed);
      } catch {
        // Dòng hỏng — bỏ qua.
      }
    }
    return out;
  }

  private appendChange(change: V9SharedChange): void {
    const filePath = this.changesPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(change)}\n`, { mode: 0o600 });
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim() !== '');
      const blockLines = lines.filter((l) => {
        try {
          return (JSON.parse(l) as V9SharedChange).label === change.label;
        } catch {
          return true;
        }
      });
      if (blockLines.length > V9_SHARED_CHANGES_PER_BLOCK_KEEP) {
        const keptBlock = blockLines.slice(-V9_SHARED_CHANGES_PER_BLOCK_KEEP);
        const other = lines.filter((l) => {
          try {
            return (JSON.parse(l) as V9SharedChange).label !== change.label;
          } catch {
            return true;
          }
        });
        const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, [...other, ...keptBlock].join('\n') + '\n', { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      }
    } catch {
      // Prune best-effort.
    }
  }

  /* ---------------- lookup + ACL ---------------- */

  /** Entry của một block (null khi chưa đăng ký). */
  get(label: string): V9SharedBlockEntry | null {
    const slug = normalizeV9BlockLabel(label);
    if (!slug) return null;
    return this.loadRegistry().blocks.find((b) => b.label === slug) ?? null;
  }

  /** Mọi block đã đăng ký. */
  list(): V9SharedBlockEntry[] {
    return this.loadRegistry().blocks;
  }

  /** Block mà một bot thấy được (có quyền read trở lên), kèm role của nó. */
  listForBot(botId: string): Array<{ entry: V9SharedBlockEntry; role: V9SharedRole }> {
    const bot = normalizeV9BotId(botId);
    if (!bot) return [];
    const out: Array<{ entry: V9SharedBlockEntry; role: V9SharedRole }> = [];
    for (const entry of this.loadRegistry().blocks) {
      const role = this.roleOf(entry, bot);
      if (role) out.push({ entry, role });
    }
    return out;
  }

  /** Role của bot trên entry (null = không có quyền). Owner luôn admin. */
  roleOf(entry: V9SharedBlockEntry, botId: string): V9SharedRole | null {
    const bot = normalizeV9BotId(botId);
    if (!bot) return null;
    if (entry.ownerBotId === bot) return 'admin';
    return entry.acl.find((a) => a.botId === bot)?.role ?? null;
  }

  /** true khi bot có ít nhất quyền `needed` (read < write < admin). */
  hasRole(entry: V9SharedBlockEntry, botId: string, needed: V9SharedRole): boolean {
    const role = this.roleOf(entry, botId);
    if (!role) return false;
    return V9_SHARED_ROLE_RANK[role] >= V9_SHARED_ROLE_RANK[needed];
  }

  private requireEntry(label: string): V9SharedBlockEntry {
    const entry = this.get(label);
    if (!entry) throw new V9Error(`Block "${normalizeV9BlockLabel(label)}" chưa đăng ký dùng chung.`);
    return entry;
  }

  /* ---------------- đăng ký / huỷ đăng ký ---------------- */

  /**
   * Đăng ký một block làm block dùng chung. Block phải tồn tại trong
   * projection; label chưa được đăng ký. Owner nhận quyền admin.
   * `grants` là quyền ban đầu cho các bot khác.
   */
  register(
    label: string,
    ownerBotId: string,
    opts: { description?: string; grants?: Array<{ botId: string; role: V9SharedRole }> } = {},
  ): V9SharedRegistryChange {
    const slug = normalizeV9BlockLabel(label);
    const owner = normalizeV9BotId(ownerBotId);
    if (!slug) throw new V9Error('Label block rỗng.');
    if (!owner) throw new V9Error('ownerBotId rỗng.');
    const block = this.projection.get(slug);
    if (!block) throw new V9Error(`Không tìm thấy memory block "${slug}" để đăng ký dùng chung.`);
    const file = this.loadRegistry();
    if (file.blocks.some((b) => b.label === slug)) {
      throw new V9Error(`Block "${slug}" đã đăng ký dùng chung rồi.`);
    }
    const now = new Date().toISOString();
    const acl: V9SharedAclEntry[] = [];
    for (const g of opts.grants ?? []) {
      const bot = normalizeV9BotId(g.botId);
      if (!bot || bot === owner || !isValidRole(g.role)) continue;
      if (acl.some((a) => a.botId === bot)) continue;
      acl.push({ botId: bot, role: g.role, grantedBy: owner, grantedAt: now });
    }
    const entry: V9SharedBlockEntry = {
      id: randomUUID(),
      label: block.label,
      ownerBotId: owner,
      description: (opts.description ?? '').slice(0, V9_MAX_NOTE_CHARS),
      createdAt: now,
      updatedAt: now,
      version: block.version,
      versionVector: { [owner]: block.version },
      acl,
      seenSeq: { [owner]: 0 },
      lastChangeSeq: 0,
    };
    file.blocks.push(entry);
    this.saveRegistry(file);
    return entry;
  }

  /**
   * Huỷ đăng ký block dùng chung (chỉ owner/admin). Block trong
   * projection KHÔNG bị xoá; change feed + xung đột cũ vẫn còn để
   * audit. Trả true khi huỷ được.
   */
  unregister(label: string, byBotId: string): boolean {
    const entry = this.requireEntry(label);
    if (!this.hasRole(entry, byBotId, 'admin')) {
      throw new V9Error(`Bot "${normalizeV9BotId(byBotId)}" không có quyền admin trên block "${entry.label}".`);
    }
    const file = this.loadRegistry();
    const before = file.blocks.length;
    file.blocks = file.blocks.filter((b) => b.label !== entry.label);
    if (file.blocks.length === before) return false;
    this.saveRegistry(file);
    return true;
  }

  /* ---------------- ACL ---------------- */

  /**
   * Cấp quyền cho một bot (chỉ owner/admin). Owner không bao giờ
   * bị hạ quyền. Trả entry sau khi đổi.
   */
  grant(label: string, botId: string, role: V9SharedRole, grantedBy: string): V9SharedRegistryChange {
    if (!isValidRole(role)) throw new V9Error(`Role phải là "read", "write" hoặc "admin", nhận được "${String(role)}".`);
    const entry = this.requireEntry(label);
    const by = normalizeV9BotId(grantedBy);
    if (!this.hasRole(entry, by, 'admin')) {
      throw new V9Error(`Bot "${by}" không có quyền admin trên block "${entry.label}".`);
    }
    const bot = normalizeV9BotId(botId);
    if (!bot) throw new V9Error('botId rỗng.');
    if (bot === entry.ownerBotId) {
      throw new V9Error(`Bot "${bot}" là owner của block "${entry.label}" (luôn admin, không cần cấp).`);
    }
    const now = new Date().toISOString();
    const existing = entry.acl.find((a) => a.botId === bot);
    if (existing) {
      existing.role = role;
      existing.grantedBy = by;
      existing.grantedAt = now;
    } else {
      entry.acl.push({ botId: bot, role, grantedBy: by, grantedAt: now });
    }
    entry.updatedAt = now;
    this.persistEntry(entry);
    return entry;
  }

  /**
   * Thu quyền của một bot (chỉ owner/admin; không thu quyền của
   * owner). Trả true khi thu được (bot có trong ACL).
   */
  revoke(label: string, botId: string, byBotId: string): boolean {
    const entry = this.requireEntry(label);
    const by = normalizeV9BotId(byBotId);
    if (!this.hasRole(entry, by, 'admin')) {
      throw new V9Error(`Bot "${by}" không có quyền admin trên block "${entry.label}".`);
    }
    const bot = normalizeV9BotId(botId);
    if (bot === entry.ownerBotId) {
      throw new V9Error(`Không thể thu quyền của owner "${bot}".`);
    }
    const before = entry.acl.length;
    entry.acl = entry.acl.filter((a) => a.botId !== bot);
    if (entry.acl.length === before) return false;
    entry.updatedAt = new Date().toISOString();
    this.persistEntry(entry);
    return true;
  }

  private persistEntry(updated: V9SharedBlockEntry): void {
    const file = this.loadRegistry();
    const idx = file.blocks.findIndex((b) => b.id === updated.id);
    if (idx === -1) throw new V9Error(`Block "${updated.label}" không còn trong registry.`);
    file.blocks[idx] = updated;
    this.saveRegistry(file);
  }

  /* ---------------- ghi (có kiểm tra xung đột) ---------------- */

  /**
   * Ghi nội dung mới vào block dùng chung.
   *
   *  - Chưa đăng ký -> outcome 'not-registered'.
   *  - Block không còn trong projection -> 'not-found'.
   *  - Bot không có quyền write -> 'forbidden' (không ghi gì).
   *  - baseVersion != version hiện tại -> 'conflict': KHÔNG ghi đè,
   *    ghi lại xung đột pending kèm nội dung muốn ghi (để resolve
   *    sau). baseVersion null = ghi mù (chỉ dùng khi caller chắc
   *    chắn, vẫn kiểm tra quyền).
   *  - Ngược lại -> ghi qua projection, bump version + version
   *    vector, append change vào feed, trả 'written'.
   */
  write(
    label: string,
    botId: string,
    content: string,
    baseVersion: number | null,
    summary = '',
  ): V9SharedWriteResult {
    const slug = normalizeV9BlockLabel(label);
    const bot = normalizeV9BotId(botId);
    if (!slug || !bot) throw new V9Error('Label block hoặc botId rỗng.');
    const entry = this.get(slug);
    if (!entry) {
      return { label: slug, botId: bot, ok: false, outcome: 'not-registered', detail: `Block "${slug}" chưa đăng ký dùng chung.` };
    }
    const block = this.projection.get(slug);
    if (!block) {
      return { label: slug, botId: bot, ok: false, outcome: 'not-found', detail: `Block "${slug}" không còn trong projection.` };
    }
    if (!this.hasRole(entry, bot, 'write')) {
      return { label: slug, botId: bot, ok: false, outcome: 'forbidden', detail: `Bot "${bot}" không có quyền write trên block "${slug}" (role: ${this.roleOf(entry, bot) ?? 'none'}).` };
    }
    if (baseVersion !== null && baseVersion !== block.version) {
      const conflict = this.recordConflict(entry, bot, baseVersion, block.version, content, summary);
      return {
        label: slug,
        botId: bot,
        ok: false,
        outcome: 'conflict',
        conflictId: conflict.id,
        detail: `Xung đột ghi: block "${slug}" đang ở v${block.version}, writer dựa trên v${baseVersion}. Nội dung chưa ghi — resolve xung đột ${conflict.id}.`,
      };
    }
    const updated = this.projection.update(slug, { content }, `${V9_SHARED_ACTOR_PREFIX}:${bot}`);
    entry.version = updated.version;
    entry.versionVector[bot] = updated.version;
    entry.updatedAt = new Date().toISOString();
    entry.lastChangeSeq += 1;
    entry.seenSeq[bot] = entry.lastChangeSeq;
    this.persistEntry(entry);
    const change: V9SharedChange = {
      seq: entry.lastChangeSeq,
      label: entry.label,
      botId: bot,
      baseVersion: baseVersion ?? block.version,
      newVersion: updated.version,
      contentHash: v9Sha256Hex(content),
      summary: (summary ?? '').slice(0, V9_MAX_NOTE_CHARS),
      at: new Date().toISOString(),
    };
    this.appendChange(change);
    return {
      label: slug,
      botId: bot,
      ok: true,
      outcome: 'written',
      newVersion: updated.version,
      changeSeq: change.seq,
      detail: `Đã ghi block "${slug}" v${updated.version} (bot "${bot}").`,
    };
  }

  /**
   * Ghi lại một change tới từ bên ngoài (vd packet fleet đã merge)
   * vào feed + version vector — không sửa nội dung block (caller đã
   * sửa qua projection/import). Dùng để đồng bộ thấy được change.
   */
  recordExternalChange(
    label: string,
    botId: string,
    newVersion: number,
    summary = '',
    contentHash = '',
  ): V9SharedChange | null {
    const entry = this.get(label);
    if (!entry) return null;
    const bot = normalizeV9BotId(botId);
    entry.version = Math.max(entry.version, newVersion);
    entry.versionVector[bot] = Math.max(entry.versionVector[bot] ?? 0, newVersion);
    entry.updatedAt = new Date().toISOString();
    entry.lastChangeSeq += 1;
    this.persistEntry(entry);
    const change: V9SharedChange = {
      seq: entry.lastChangeSeq,
      label: entry.label,
      botId: bot,
      baseVersion: newVersion - 1,
      newVersion,
      contentHash,
      summary: (summary ?? '').slice(0, V9_MAX_NOTE_CHARS),
      at: new Date().toISOString(),
    };
    this.appendChange(change);
    return change;
  }

  private recordConflict(
    entry: V9SharedBlockEntry,
    writerBotId: string,
    baseVersion: number,
    localVersion: number,
    incomingContent: string,
    summary: string,
  ): V9SharedConflict {
    const file = this.loadConflicts();
    const conflict: V9SharedConflict = {
      id: randomUUID(),
      label: entry.label,
      writerBotId,
      baseVersion,
      localVersion,
      incomingVersion: localVersion + 1,
      incomingContentHash: v9Sha256Hex(incomingContent),
      incomingSummary: (summary ?? '').slice(0, V9_MAX_NOTE_CHARS),
      incomingContent: incomingContent.slice(0, V9_MAX_MERGED_CONTENT_CHARS),
      status: 'pending',
      at: new Date().toISOString(),
    };
    file.conflicts.push(conflict);
    if (file.conflicts.length > V9_SHARED_CONFLICTS_KEEP) {
      file.conflicts = file.conflicts.slice(-V9_SHARED_CONFLICTS_KEEP);
    }
    this.saveConflicts(file);
    return conflict;
  }

  /* ---------------- sync ---------------- */

  /** Change của block có seq > sinceSeq (cũ nhất trước). */
  changesSince(label: string, sinceSeq = 0): V9SharedChange[] {
    const slug = normalizeV9BlockLabel(label);
    return this.readChanges()
      .filter((c) => c.label === slug && c.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Trạng thái đồng bộ của một block (null khi chưa đăng ký). */
  syncStatus(label: string): V9SharedSyncStatus | null {
    const entry = this.get(label);
    if (!entry) return null;
    const pending = this.listConflicts(entry.label, 'pending').length;
    const lastChange = this.readChanges()
      .filter((c) => c.label === entry.label)
      .sort((a, b) => b.seq - a.seq)[0];
    const bots: V9SharedSyncStatus['bots'] = [
      { botId: entry.ownerBotId, role: 'admin', lastSeenSeq: entry.seenSeq[entry.ownerBotId] ?? 0 },
      ...entry.acl.map((a) => ({
        botId: a.botId,
        role: a.role,
        lastSeenSeq: entry.seenSeq[a.botId] ?? 0,
      })),
    ];
    return {
      label: entry.label,
      registered: true,
      ownerBotId: entry.ownerBotId,
      version: entry.version,
      versionVector: { ...entry.versionVector },
      bots,
      pendingConflicts: pending,
      lastChangeSeq: entry.lastChangeSeq,
      ...(lastChange ? { lastChangeAt: lastChange.at } : {}),
    };
  }

  /**
   * Đồng bộ cho một bot: trả change mà bot chưa thấy + xung đột
   * đang chờ, đồng thời đánh dấu bot đã thấy tới seq mới nhất.
   * Bot phải có quyền read. Throw khi block chưa đăng ký hoặc bot
   * không có quyền.
   */
  sync(label: string, botId: string, sinceSeq = 0): V9SharedSyncResult {
    const entry = this.requireEntry(label);
    const bot = normalizeV9BotId(botId);
    if (!this.hasRole(entry, bot, 'read')) {
      throw new V9Error(`Bot "${bot}" không có quyền read trên block "${entry.label}".`);
    }
    const changes = this.changesSince(entry.label, sinceSeq);
    const status = this.syncStatus(entry.label) as V9SharedSyncStatus;
    const pendingConflicts = this.listConflicts(entry.label, 'pending');
    const seenSeq = changes.length > 0 ? (changes[changes.length - 1] as V9SharedChange).seq : entry.lastChangeSeq;
    if (seenSeq > (entry.seenSeq[bot] ?? 0)) {
      entry.seenSeq[bot] = seenSeq;
      this.persistEntry(entry);
    }
    return { status, changes, pendingConflicts, seenSeq };
  }

  /* ---------------- xung đột ---------------- */

  /** Xung đột (lọc theo block và/hoặc trạng thái), mới nhất trước. */
  listConflicts(label?: string, status?: V9SharedConflictStatus): V9SharedConflict[] {
    const slug = label ? normalizeV9BlockLabel(label) : '';
    return this.loadConflicts()
      .conflicts.filter(
        (c) => (!slug || c.label === slug) && (!status || c.status === status),
      )
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  /** Một xung đột theo id (null khi không có). */
  getConflict(conflictId: string): V9SharedConflict | null {
    return this.loadConflicts().conflicts.find((c) => c.id === conflictId) ?? null;
  }

  /**
   * Resolve một xung đột pending. Chỉ owner/admin của block hoặc
   * chính writer mới được resolve.
   *
   *  - 'keep-mine': giữ nội dung hiện tại, bỏ nội dung writer.
   *  - 'keep-theirs': ghi nội dung của writer thành version mới.
   *  - 'merged': ghi `mergedContent` (bắt buộc) thành version mới.
   *
   * Ghi thành công thì bump version + version vector + append
   * change (botId = writer, summary ghi rõ cách resolve).
   */
  resolveConflict(
    conflictId: string,
    resolution: V9SharedConflictResolution,
    byBotId: string,
    mergedContent?: string,
  ): V9SharedConflict {
    const file = this.loadConflicts();
    const conflict = file.conflicts.find((c) => c.id === conflictId);
    if (!conflict) throw new V9Error(`Không tìm thấy xung đột "${conflictId}".`);
    if (conflict.status !== 'pending') {
      throw new V9Error(`Xung đột "${conflictId}" đã được resolve (${conflict.resolution ?? '?'}) lúc ${conflict.resolvedAt ?? '?'}.`);
    }
    const entry = this.requireEntry(conflict.label);
    const by = normalizeV9BotId(byBotId);
    const isOwnerOrAdmin = this.hasRole(entry, by, 'admin');
    const isWriter = conflict.writerBotId === by;
    if (!isOwnerOrAdmin && !isWriter) {
      throw new V9Error(`Bot "${by}" không được resolve xung đột này (chỉ owner/admin hoặc writer "${conflict.writerBotId}").`);
    }
    if (resolution === 'merged' && (mergedContent === undefined || mergedContent === '')) {
      throw new V9Error('Resolve "merged" cần mergedContent (nội dung đã gộp tay).');
    }
    let appliedHash: string | undefined;
    if (resolution === 'keep-theirs' || resolution === 'merged') {
      const content = resolution === 'merged' ? (mergedContent as string) : conflict.incomingContent;
      const block = this.projection.get(conflict.label);
      if (!block) throw new V9Error(`Block "${conflict.label}" không còn trong projection.`);
      const updated = this.projection.update(conflict.label, { content }, `${V9_SHARED_ACTOR_PREFIX}:${by}`);
      entry.version = updated.version;
      entry.versionVector[conflict.writerBotId] = updated.version;
      entry.updatedAt = new Date().toISOString();
      entry.lastChangeSeq += 1;
      entry.seenSeq[conflict.writerBotId] = entry.lastChangeSeq;
      this.persistEntry(entry);
      this.appendChange({
        seq: entry.lastChangeSeq,
        label: entry.label,
        botId: conflict.writerBotId,
        baseVersion: conflict.localVersion,
        newVersion: updated.version,
        contentHash: v9Sha256Hex(content),
        summary: `resolve conflict ${conflict.id} (${resolution})`,
        at: new Date().toISOString(),
      });
      appliedHash = v9Sha256Hex(content);
    }
    conflict.status = 'resolved';
    conflict.resolution = resolution;
    conflict.resolvedBy = by;
    conflict.resolvedAt = new Date().toISOString();
    if (appliedHash) conflict.resolvedContentHash = appliedHash;
    this.saveConflicts(file);
    return conflict;
  }
}
