/**
 * Shared memory-block groups (v1.03, Đội T2 — Memory v4).
 *
 * Ý tưởng học từ Letta "shared memory blocks" (một block gắn nhiều
 * agent, update một nơi thấy ở mọi nơi) nhưng tự thiết kế lại hoàn
 * toàn cho open-bot, chạy 100% local, không copy code/tài sản nào.
 *
 * Vấn đề mà `MemoryBlockStore.share()` (v0.96) chưa giải quyết: share
 * là thao tác một lần, không có NHÓM — không biết block đang được
 * share cho những bot nào theo nhóm nào, không phát hiện được bot mới
 * vào nhóm chưa thấy block, và không có vai trò (read/write) theo
 * thành viên. Module này thêm lớp NHÓM lên trên store có sẵn:
 *
 *   SharedBlockGroup = { id, name, description, members, blockIds }
 *   member           = { botId, role: 'read' | 'write', joinedAt }
 *
 * Một block thuộc nhóm được attach vào MỌI bot thành viên (qua
 * `MemoryBlockStore.share()` — cùng một block id, cùng một nội dung:
 * sửa một nơi, mọi bot trong nhóm đều thấy). Khi bot mới gia nhập
 * nhóm, mọi block của nhóm được attach cho nó ngay (catch-up). Khi
 * bot rời nhóm, block của nhóm được detach khỏi nó (trừ khi block
 * đó còn được attach trực tiếp hoặc qua nhóm khác).
 *
 * `resolveBlocksForBot(botId)` trả về mọi block bot đó thấy được
 * (trực tiếp + qua nhóm), kèm nguồn nhóm — để render vào system
 * prompt và để UI hiển thị "block này tới từ nhóm nào".
 *
 * `groupSyncReport(groupId)` phát hiện lệch (drift): thành viên nào
 * chưa attach đủ block của nhóm (vd file blocks bị sửa tay), block
 * nào đã bị xoá khỏi store nhưng vẫn còn trong nhóm.
 *
 * Lưu trữ: JSON local `.open-bot/memory-shared-groups.json`, ghi
 * atomic (temp + rename, mode 0600) như MemoryBlockStore. Nội dung
 * block vẫn sống duy nhất trong MemoryBlockStore — module này chỉ
 * lưu quan hệ nhóm ↔ bot ↔ block, không nhân bản nội dung.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MemoryBlockStore } from './blocks';
import type { MemoryBlock } from './blocks';

export const MEMORY_SHARED_GROUPS_REL_PATH = path.join(
  '.open-bot',
  'memory-shared-groups.json',
);
/** Độ dài tối đa của tên nhóm (sau trim). */
export const MAX_SHARED_GROUP_NAME_LENGTH = 80;
/** Số block tối đa trong một nhóm (chống nhóm phình vô hạn). */
export const MAX_BLOCKS_PER_SHARED_GROUP = 50;
/** Số thành viên tối đa trong một nhóm. */
export const MAX_MEMBERS_PER_SHARED_GROUP = 50;

/** Vai trò của một bot trong nhóm. */
export type SharedGroupRole = 'read' | 'write';

/** Một bot thành viên của nhóm. */
export interface SharedGroupMember {
  botId: string;
  role: SharedGroupRole;
  joinedAt: string;
}

/** Một nhóm share block cross-agent. */
export interface SharedBlockGroup {
  id: string;
  /** Tên nhóm (duy nhất sau khi trim + lowercase, vd "team-sales"). */
  name: string;
  description: string;
  /** Bot tạo nhóm ('' = user tạo). */
  createdByBotId: string;
  members: SharedGroupMember[];
  /** Block id trong nhóm (thứ tự attach). */
  blockIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SharedGroupsFile {
  version: 1;
  groups: SharedBlockGroup[];
}

/** Một block bot thấy được, kèm nguồn (trực tiếp hay qua nhóm nào). */
export interface ResolvedSharedBlock {
  block: MemoryBlock;
  /** 'direct' = attach trực tiếp; còn lại là id nhóm đã share block. */
  via: string;
  /** Tên nhóm (khi via là nhóm). */
  viaGroupName?: string;
  /** Vai trò của bot trong nhóm đó (khi via là nhóm). */
  roleInGroup?: SharedGroupRole;
}

/** Kết quả kiểm tra đồng bộ của một nhóm. */
export interface GroupSyncReport {
  groupId: string;
  groupName: string;
  checkedAt: string;
  /** Thành viên thiếu block nào (bot chưa attach đủ block nhóm). */
  missingAttachments: Array<{ botId: string; blockId: string; label: string }>;
  /** Block id còn trong nhóm nhưng đã bị xoá khỏi block store. */
  orphanBlockIds: string[];
  /** Block đang read-only (thành viên write vẫn không sửa được). */
  readOnlyBlockIds: string[];
  /** true = mọi thành viên đã attach đủ mọi block còn sống của nhóm. */
  inSync: boolean;
}

function normalizeGroupName(raw: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

export class SharedBlockGroupStore {
  private readonly filePath: string;
  private readonly workspaceDir: string;
  private readonly blocks: MemoryBlockStore;

  constructor(workspaceDir: string, blocksStore?: MemoryBlockStore) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, MEMORY_SHARED_GROUPS_REL_PATH);
    this.blocks = blocksStore ?? new MemoryBlockStore(workspaceDir);
  }

  get dir(): string {
    return this.workspaceDir;
  }

  private readFile(): SharedGroupsFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, groups: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Shared groups file is not valid JSON: ${MEMORY_SHARED_GROUPS_REL_PATH}`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as SharedGroupsFile).version !== 1 ||
      !Array.isArray((parsed as SharedGroupsFile).groups)
    ) {
      throw new Error(
        `Shared groups file has an unsupported shape: ${MEMORY_SHARED_GROUPS_REL_PATH}`,
      );
    }
    return parsed as SharedGroupsFile;
  }

  private writeFile(file: SharedGroupsFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Tạo nhóm mới. Tên trùng (sau chuẩn hoá) -> throw. */
  createGroup(
    input: { name: string; description?: string; createdByBotId?: string },
    actor = 'user',
  ): SharedBlockGroup {
    const name = normalizeGroupName(input.name);
    if (name === '' || name.length > MAX_SHARED_GROUP_NAME_LENGTH) {
      throw new Error('Tên nhóm share không hợp lệ (rỗng hoặc quá dài).');
    }
    const file = this.readFile();
    if (file.groups.some((g) => normalizeGroupName(g.name) === name)) {
      throw new Error(`Nhóm share "${name}" đã tồn tại.`);
    }
    const now = new Date().toISOString();
    const group: SharedBlockGroup = {
      id: randomUUID(),
      name,
      description: (input.description ?? '').trim().slice(0, 500),
      createdByBotId: (input.createdByBotId ?? '').trim(),
      members: [],
      blockIds: [],
      createdAt: now,
      updatedAt: now,
    };
    file.groups.push(group);
    this.writeFile(file);
    this.blocks.audit('share-group-create', group.id, actor, `name=${name}`, name);
    return { ...group, members: [], blockIds: [] };
  }

  getGroup(idOrName: string): SharedBlockGroup | null {
    const file = this.readFile();
    const norm = normalizeGroupName(idOrName);
    const found =
      file.groups.find((g) => g.id === idOrName) ??
      file.groups.find((g) => normalizeGroupName(g.name) === norm);
    return found ? structuredClone(found) : null;
  }

  listGroups(): SharedBlockGroup[] {
    return this.readFile().groups.map((g) => structuredClone(g));
  }

  /** Mọi nhóm mà bot này là thành viên. */
  listGroupsForBot(botId: string): SharedBlockGroup[] {
    const id = (botId ?? '').trim();
    if (id === '') return [];
    return this.readFile()
      .groups.filter((g) => g.members.some((m) => m.botId === id))
      .map((g) => structuredClone(g));
  }

  /** Xoá nhóm (không xoá block, chỉ gỡ quan hệ + detach khỏi thành viên). */
  deleteGroup(idOrName: string, actor = 'user'): boolean {
    const file = this.readFile();
    const idx = file.groups.findIndex(
      (g) => g.id === idOrName || normalizeGroupName(g.name) === normalizeGroupName(idOrName),
    );
    if (idx === -1) return false;
    const [group] = file.groups.splice(idx, 1);
    // Detach block nhóm khỏi thành viên — trừ khi block còn thuộc
    // nhóm khác của bot đó (giữ lại để bot không mất block oan).
    for (const member of group.members) {
      for (const blockId of group.blockIds) {
        if (this.isBlockInAnotherGroup(file.groups, member.botId, blockId)) continue;
        try {
          this.blocks.detach(member.botId, blockId, actor);
        } catch {
          // Block đã bị xoá khỏi store — bỏ qua, nhóm đã xoá rồi.
        }
      }
    }
    this.writeFile(file);
    this.blocks.audit('share-group-delete', group.id, actor, `name=${group.name}`, group.name);
    return true;
  }

  private isBlockInAnotherGroup(
    groups: SharedBlockGroup[],
    botId: string,
    blockId: string,
  ): boolean {
    return groups.some(
      (g) =>
        g.blockIds.includes(blockId) &&
        g.members.some((m) => m.botId === botId),
    );
  }

  /**
   * Thêm bot vào nhóm (role mặc định 'read'). Bot mới gia nhập được
   * catch-up ngay: mọi block của nhóm được attach cho nó.
   */
  addMember(
    idOrName: string,
    botId: string,
    role: SharedGroupRole = 'read',
    actor = 'user',
  ): SharedBlockGroup {
    const id = (botId ?? '').trim();
    if (id === '') throw new Error('botId không được rỗng.');
    if (role !== 'read' && role !== 'write') {
      throw new Error(`Role không hợp lệ: ${role} (chỉ 'read' hoặc 'write').`);
    }
    const file = this.readFile();
    const group = this.resolveGroup(file, idOrName);
    if (group.members.length >= MAX_MEMBERS_PER_SHARED_GROUP) {
      throw new Error(`Nhóm "${group.name}" đã đủ ${MAX_MEMBERS_PER_SHARED_GROUP} thành viên.`);
    }
    const existing = group.members.find((m) => m.botId === id);
    if (existing) {
      // Đã là thành viên — chỉ cập nhật role (không attach lại).
      existing.role = role;
      group.updatedAt = new Date().toISOString();
      this.writeFile(file);
      return structuredClone(group);
    }
    group.members.push({ botId: id, role, joinedAt: new Date().toISOString() });
    group.updatedAt = new Date().toISOString();
    this.writeFile(file);
    // Catch-up: attach mọi block của nhóm cho thành viên mới.
    for (const blockId of group.blockIds) {
      try {
        this.blocks.attach(id, blockId, actor);
      } catch {
        // Block đã bị xoá khỏi store — để sync report phát hiện sau.
      }
    }
    this.blocks.audit('share-group-join', group.id, actor, `bot=${id} role=${role}`, group.name);
    return structuredClone(group);
  }

  /** Bot rời nhóm: gỡ khỏi nhóm + detach block nhóm (trừ block còn thuộc nhóm khác). */
  removeMember(idOrName: string, botId: string, actor = 'user'): SharedBlockGroup {
    const id = (botId ?? '').trim();
    const file = this.readFile();
    const group = this.resolveGroup(file, idOrName);
    const idx = group.members.findIndex((m) => m.botId === id);
    if (idx === -1) throw new Error(`Bot "${id}" không phải thành viên nhóm "${group.name}".`);
    group.members.splice(idx, 1);
    group.updatedAt = new Date().toISOString();
    this.writeFile(file);
    for (const blockId of group.blockIds) {
      if (this.isBlockInAnotherGroup(file.groups, id, blockId)) continue;
      try {
        this.blocks.detach(id, blockId, actor);
      } catch {
        // Block đã mất — bỏ qua.
      }
    }
    this.blocks.audit('share-group-leave', group.id, actor, `bot=${id}`, group.name);
    return structuredClone(group);
  }

  /**
   * Thêm block vào nhóm: block được attach vào MỌI bot thành viên
   * (share một nơi, thấy mọi nơi). Block không tồn tại -> throw.
   */
  attachBlockToGroup(
    idOrName: string,
    blockIdOrLabel: string,
    actor = 'user',
  ): SharedBlockGroup {
    const file = this.readFile();
    const group = this.resolveGroup(file, idOrName);
    const block = this.blocks.get(blockIdOrLabel);
    if (!block) throw new Error(`Không tìm thấy block "${blockIdOrLabel}".`);
    if (group.blockIds.length >= MAX_BLOCKS_PER_SHARED_GROUP) {
      throw new Error(`Nhóm "${group.name}" đã đủ ${MAX_BLOCKS_PER_SHARED_GROUP} block.`);
    }
    if (!group.blockIds.includes(block.id)) {
      group.blockIds.push(block.id);
      group.updatedAt = new Date().toISOString();
      this.writeFile(file);
    }
    // Propagate: attach cho mọi thành viên (share() tự bỏ qua bot đã có).
    this.blocks.share(block.id, group.members.map((m) => m.botId), actor);
    this.blocks.audit(
      'share-group-attach',
      block.id,
      actor,
      `group=${group.name}`,
      block.label,
    );
    return structuredClone(group);
  }

  /** Gỡ block khỏi nhóm: detach khỏi thành viên (trừ block còn thuộc nhóm khác). */
  detachBlockFromGroup(
    idOrName: string,
    blockIdOrLabel: string,
    actor = 'user',
  ): SharedBlockGroup {
    const file = this.readFile();
    const group = this.resolveGroup(file, idOrName);
    const block = this.blocks.get(blockIdOrLabel);
    const blockId = block?.id ?? blockIdOrLabel;
    const idx = group.blockIds.indexOf(blockId);
    if (idx === -1) throw new Error(`Block "${blockIdOrLabel}" không thuộc nhóm "${group.name}".`);
    group.blockIds.splice(idx, 1);
    group.updatedAt = new Date().toISOString();
    this.writeFile(file);
    for (const member of group.members) {
      if (this.isBlockInAnotherGroup(file.groups, member.botId, blockId)) continue;
      try {
        this.blocks.detach(member.botId, blockId, actor);
      } catch {
        // Block đã mất — bỏ qua.
      }
    }
    this.blocks.audit(
      'share-group-detach',
      blockId,
      actor,
      `group=${group.name}`,
      block?.label,
    );
    return structuredClone(group);
  }

  /**
   * Mọi block một bot thấy được: block qua nhóm TRƯỚC (kèm tên nhóm +
   * role — nhóm là cơ chế share, nên provenance nhóm thắng attach
   * trực tiếp), rồi block attach trực tiếp chưa thấy qua nhóm nào.
   * Một block vừa trực tiếp vừa qua nhóm chỉ xuất hiện một lần.
   */
  resolveBlocksForBot(botId: string): ResolvedSharedBlock[] {
    const id = (botId ?? '').trim();
    if (id === '') return [];
    const out: ResolvedSharedBlock[] = [];
    const seen = new Set<string>();
    for (const group of this.listGroupsForBot(id)) {
      const role = group.members.find((m) => m.botId === id)?.role ?? 'read';
      for (const blockId of group.blockIds) {
        if (seen.has(blockId)) continue;
        const block = this.blocks.get(blockId);
        if (!block) continue; // Block đã bị xoá — sync report sẽ nêu.
        seen.add(blockId);
        out.push({ block, via: group.id, viaGroupName: group.name, roleInGroup: role });
      }
    }
    for (const block of this.blocks.listAttached(id)) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      out.push({ block, via: 'direct' });
    }
    return out;
  }

  /**
   * Kiểm tra đồng bộ của nhóm: thành viên nào chưa attach đủ block,
   * block nào đã mồ côi (bị xoá khỏi store), block nào read-only.
   * Chỉ đọc — không tự sửa (caller quyết định có chạy catch-up lại
   * bằng addMember/attachBlockToGroup hay không).
   */
  groupSyncReport(idOrName: string): GroupSyncReport {
    const group = this.getGroup(idOrName);
    if (!group) throw new Error(`Không tìm thấy nhóm share "${idOrName}".`);
    const missingAttachments: GroupSyncReport['missingAttachments'] = [];
    const orphanBlockIds: string[] = [];
    const readOnlyBlockIds: string[] = [];
    for (const blockId of group.blockIds) {
      const block = this.blocks.get(blockId);
      if (!block) {
        orphanBlockIds.push(blockId);
        continue;
      }
      if (block.readOnly) readOnlyBlockIds.push(blockId);
      for (const member of group.members) {
        if (!this.blocks.isAttached(member.botId, blockId)) {
          missingAttachments.push({ botId: member.botId, blockId, label: block.label });
        }
      }
    }
    return {
      groupId: group.id,
      groupName: group.name,
      checkedAt: new Date().toISOString(),
      missingAttachments,
      orphanBlockIds,
      readOnlyBlockIds,
      inSync: missingAttachments.length === 0 && orphanBlockIds.length === 0,
    };
  }

  private resolveGroup(file: SharedGroupsFile, idOrName: string): SharedBlockGroup {
    const norm = normalizeGroupName(idOrName);
    const group =
      file.groups.find((g) => g.id === idOrName) ??
      file.groups.find((g) => normalizeGroupName(g.name) === norm);
    if (!group) throw new Error(`Không tìm thấy nhóm share "${idOrName}".`);
    return group;
  }
}
