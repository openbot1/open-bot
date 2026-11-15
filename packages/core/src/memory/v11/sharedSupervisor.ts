/**
 * Memory v11 — shared-block supervisor gate (v1.11, Doi T1).
 *
 * Y tuong hoc tu Letta Conversations API (nhieu agent chia se memory
 * block — mot block attach vao nhieu agent, mot agent update thi tat
 * ca thay ngay; rui ro: write xau lan ra moi agent nen CHI SUPERVISOR
 * duoc write block chia se, block chia se giu nho), viet lai hoan
 * toan cho open-bot tren SharedBlockGroupStore (v1.03) +
 * MemoryBlockStore (v0.96) co san — KHONG sua hai store goc.
 *
 * Van de truoc v11: nhom share cua v1.03 co role `read`/`write` theo
 * thanh vien, nhung bat ky thanh vien `write` nao cung sua duoc block
 * chia se (write xau lan ra ca nhom), khong co gioi han kich thuoc
 * rieng cho block chia se, khong co block chia se mau san.
 *
 * Lop nay them 3 thu len tren nhom co san:
 *
 *  1. SUPERVISOR: moi nhom co mot supervisor bot (luu rieng trong
 *     `.open-bot/memory-v11-shared-supervisors.json` — khong sua
 *     dinh dang nhom v1.03). Chi supervisor (actor
 *     `agent:<supervisorBotId>`, sleep agent dai dien supervisor
 *     `sleep:v11:<supervisorBotId>`, hoac `user`) moi duoc write
 *     block chia se; thanh vien khac — ke ca role `write` cu — deu
 *     bi chan ngay tai day, truoc khi ghi file. Doi supervisor chi
 *     user lam duoc.
 *  2. SIZE CAP: block chia se toi da SHARED_BLOCK_CHAR_LIMIT ky tu
 *     (4000, nho hon gioi han mac dinh de giu block chia se gon nhe
 *     trong prompt cua moi bot); vuot 80% thi canh bao `warm`, vuot
 *     100% thi tu choi ghi (ke ca append — caller phai co dong roi
 *     ghi lai, dung hanh vi Letta).
 *  3. PRESET: hai block chia se mau — `current_plan` (ke hoach hien
 *     tai ca nhom dang lam) va `organization` (thong tin to chuc) —
 *     `ensureSharedPreset` tao (neu chua co) + dua vao nhom + attach
 *     cho moi thanh vien; `learned_context` (sleep agent viet) cung
 *     duoc tao bang cung duong nay.
 *
 * Moi write thanh cong deu ghi them mot entry vao bang block_history
 * thong nhat (backend `shared-v11`) de lich su noi that du backend.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryBlockStore, normalizeBlockLabel } from '../blocks';
import type { MemoryBlock } from '../blocks';
import { SharedBlockGroupStore } from '../sharedBlocks';
import type { SharedBlockGroup } from '../sharedBlocks';
import { v11LimitForLabel } from './blockKinds';
import { recordBlockHistoryChange, historyInputFromBlock } from './blockHistoryTable';

export const V11_SHARED_SUPERVISORS_REL_PATH = path.join(
  '.open-bot',
  'memory-v11-shared-supervisors.json',
);
/** Gioi han ky tu cung cua block chia se — giu nho de prompt moi bot khong phi. */
export const SHARED_BLOCK_CHAR_LIMIT = 4000;
/** Ty le day bat dau canh bao (80% cua gioi han chia se). */
export const SHARED_BLOCK_WARN_RATIO = 0.8;
/** Block chia se mau (preset) cua memory v11. Label la slug cua store (normalizeBlockLabel doi `_` thanh `-` nen dung dang hyphen). */
export const V11_SHARED_PRESET_LABELS = ['current-plan', 'organization', 'learned-context'] as const;
export type V11SharedPresetLabel = (typeof V11_SHARED_PRESET_LABELS)[number];

/** Mo ta mac dinh cua tung block chia se mau. */
export const V11_SHARED_PRESET_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'current-plan': 'Current plan shared by the whole bot group.',
  organization: 'Organization info shared by the whole bot group.',
  'learned-context': 'Context the sleep-time agent learned and shared with the group.',
};

/** Loi shared supervisor — message tieng Viet. */
export class V11SharedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V11SharedError';
  }
}

/** File supervisor: groupId -> supervisorBotId ('' = chua dat, chi user write). */
export interface SharedSupervisorsFile {
  version: 1;
  supervisors: Record<string, string>;
}

/** Trang thai day cua mot block chia se. */
export interface SharedBlockUsage {
  label: string;
  chars: number;
  limit: number;
  fillRatio: number;
  /** 'ok' < 80%, 'warm' 80-100%, 'over' > 100% (legacy vuot gioi han). */
  state: 'ok' | 'warm' | 'over';
  /** Canh bao hien thi cho user/agent (rong khi ok). */
  warning: string;
}

/** Mot block chia se ke ten nhom + supervisor + thanh vien thay no. */
export interface SharedBlockView {
  block: MemoryBlock;
  groupId: string;
  groupName: string;
  supervisorBotId: string;
  memberBotIds: string[];
  usage: SharedBlockUsage;
}

/** Ket qua write block chia se (ke muc day sau khi ghi). */
export interface SharedWriteResult {
  block: MemoryBlock;
  groupId: string;
  groupName: string;
  usage: SharedBlockUsage;
  mode: 'replace' | 'append';
}

/** Actor sleep agent dai dien supervisor: `sleep:v11:<botId>`. */
export function sleepV11Actor(supervisorBotId: string): string {
  return `sleep:v11:${supervisorBotId}`;
}

/** true khi actor la sleep agent dai dien dung supervisor do. */
export function isSleepV11ActorFor(actor: string, supervisorBotId: string): boolean {
  return actor === sleepV11Actor(supervisorBotId);
}

/** Gioi han thuc ap cho block chia se (gioi han kind, nhung khong qua cap chia se). Block preset chia se (`current_plan` / `organization` / `learned_context`) lay dung cap chia se vi chung sinh ra de chia se. */
export function sharedBlockLimitForLabel(label: string): number {
  const slug = normalizeBlockLabel(label);
  if ((V11_SHARED_PRESET_LABELS as readonly string[]).includes(slug)) {
    return SHARED_BLOCK_CHAR_LIMIT;
  }
  return Math.min(v11LimitForLabel(label), SHARED_BLOCK_CHAR_LIMIT);
}

/** Muc day + canh bao cua mot block chia se. */
export function sharedBlockUsage(block: MemoryBlock): SharedBlockUsage {
  const limit = sharedBlockLimitForLabel(block.label);
  const fillRatio = limit > 0 ? block.content.length / limit : 0;
  const state = fillRatio > 1 ? 'over' : fillRatio >= SHARED_BLOCK_WARN_RATIO ? 'warm' : 'ok';
  let warning = '';
  if (state === 'over') {
    warning =
      `Shared block "${block.label}" has ${block.content.length} chars, ` +
      `over the shared limit ${limit} — condense it before writing more.`;
  } else if (state === 'warm') {
    warning =
      `Shared block "${block.label}" is ${Math.round(fillRatio * 100)}% full ` +
      `(${block.content.length}/${limit} chars) — keep shared blocks small.`;
  }
  return { label: block.label, chars: block.content.length, limit, fillRatio, state, warning };
}

/**
 * Cua ghi supervisor cho block chia se cua mot nhom.
 *
 *  - Khong can nhom (block chua vao nhom nao): chan, vi khong co
 *    supervisor de xac thuc — block chia se phai thuoc nhom.
 *  - Nhom chua dat supervisor: chi `user` duoc write (de dat
 *    supervisor lan dau); agent bi chan.
 *  - Da co supervisor: chi `user`, `agent:<supervisor>` hoac
 *    `sleep:v11:<supervisor>` duoc write.
 *
 * Bot thanh vien nao khac — ke ca role `write` trong nhom v1.03 —
 * deu bi chan. Day la diem khac biet chinh so voi v1.03.
 */
export class SharedSupervisor {
  private readonly workspaceDir: string;
  private readonly blocks: MemoryBlockStore;
  private readonly groups: SharedBlockGroupStore;

  constructor(
    workspaceDir: string,
    blocksStore?: MemoryBlockStore,
    groupsStore?: SharedBlockGroupStore,
  ) {
    this.workspaceDir = workspaceDir;
    this.blocks = blocksStore ?? new MemoryBlockStore(workspaceDir);
    this.groups = groupsStore ?? new SharedBlockGroupStore(workspaceDir, this.blocks);
  }

  // -- supervisor map (file rieng, ghi atomic) --

  private readSupervisors(): SharedSupervisorsFile {
    const filePath = path.join(this.workspaceDir, V11_SHARED_SUPERVISORS_REL_PATH);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, supervisors: {} };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V11SharedError('Shared supervisors file is not valid JSON.');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as SharedSupervisorsFile).version !== 1 ||
      typeof (parsed as SharedSupervisorsFile).supervisors !== 'object' ||
      (parsed as SharedSupervisorsFile).supervisors === null
    ) {
      throw new V11SharedError('Shared supervisors file has an unexpected shape.');
    }
    return parsed as SharedSupervisorsFile;
  }

  private writeSupervisors(file: SharedSupervisorsFile): void {
    const filePath = path.join(this.workspaceDir, V11_SHARED_SUPERVISORS_REL_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  /** Supervisor hien tai cua nhom ('' = chua dat). */
  getSupervisor(groupIdOrName: string): string {
    const group = this.groups.getGroup(groupIdOrName);
    if (!group) throw new V11SharedError(`Shared group "${groupIdOrName}" not found.`);
    return this.readSupervisors().supervisors[group.id] ?? '';
  }

  /**
   * Dat / doi supervisor cua nhom. Chi `user` lam duoc (actor khac
   * bi chan). Supervisor moi phai la thanh vien cua nhom (neu nhom
   * da co thanh vien) — tranh dat nham bot ngoai nhom.
   */
  setSupervisor(groupIdOrName: string, supervisorBotId: string, actor = 'user'): SharedBlockGroup {
    if (actor !== 'user') {
      throw new V11SharedError('Only the user can set a group supervisor.');
    }
    const botId = (supervisorBotId ?? '').trim();
    if (botId === '') throw new V11SharedError('supervisorBotId is empty.');
    const group = this.groups.getGroup(groupIdOrName);
    if (!group) throw new V11SharedError(`Shared group "${groupIdOrName}" not found.`);
    if (group.members.length > 0 && !group.members.some((m) => m.botId === botId)) {
      throw new V11SharedError(
        `Bot "${botId}" is not a member of group "${group.name}" — add it first.`,
      );
    }
    const file = this.readSupervisors();
    file.supervisors[group.id] = botId;
    this.writeSupervisors(file);
    this.blocks.audit('shared-supervisor-set', group.id, actor, `supervisor=${botId}`, group.name);
    return group;
  }

  /** Nhom nao chua block nay (block chia se thuoc nhom moi co supervisor). */
  groupsOfBlock(blockId: string): SharedBlockGroup[] {
    return this.groups.listGroups().filter((g) => g.blockIds.includes(blockId));
  }

  /** Kiem tra quyen write (dung chung cho moi duong ghi). */
  assertCanWriteShared(group: SharedBlockGroup, actor: string): void {
    if (actor === 'user') return;
    const supervisor = this.readSupervisors().supervisors[group.id] ?? '';
    if (supervisor === '') {
      throw new V11SharedError(
        `Group "${group.name}" has no supervisor yet — only the user can write its shared blocks.`,
      );
    }
    if (actor === `agent:${supervisor}` || actor === sleepV11Actor(supervisor)) return;
    throw new V11SharedError(
      `Only the supervisor (bot "${supervisor}") or the user can write shared blocks ` +
        `of group "${group.name}" — actor "${actor}" is not allowed.`,
    );
  }

  /** Kiem tra kich thuoc truoc khi ghi (append tinh ca noi dung cu). */
  private assertSharedSize(label: string, nextContent: string): void {
    const limit = sharedBlockLimitForLabel(label);
    if (nextContent.length > limit) {
      throw new V11SharedError(
        `Shared block "${label}" would have ${nextContent.length} chars, ` +
          `over the shared limit ${limit} — condense the block before writing.`,
      );
    }
  }

  /**
   * Tao block chia se mau (neu chua co) + dua vao nhom + attach cho
   * moi thanh vien. Label phai la mot trong 3 preset. Tra block hien
   * tai (ke ca khi da ton tai truoc). Tao block khong can supervisor
   * (tao != write noi dung) — nhung ghi noi dung ban dau thi can.
   */
  ensureSharedPreset(
    groupIdOrName: string,
    label: V11SharedPresetLabel,
    actor = 'user',
  ): MemoryBlock {
    const slug = normalizeBlockLabel(label);
    const group = this.groups.getGroup(groupIdOrName);
    if (!group) throw new V11SharedError(`Shared group "${groupIdOrName}" not found.`);
    let block = this.blocks.get(slug);
    if (!block) {
      block = this.blocks.create(
        {
          label: slug,
          description: V11_SHARED_PRESET_DESCRIPTIONS[slug] ?? `Shared block "${slug}".`,
          content: '',
          charLimit: sharedBlockLimitForLabel(slug),
          createdByBotId: '',
        },
        actor,
      );
      recordBlockHistoryChange(
        this.workspaceDir,
        historyInputFromBlock(block, 'shared-v11', 'create', actor),
      );
    }
    if (!group.blockIds.includes(block.id)) {
      this.groups.attachBlockToGroup(group.id, block.id, actor);
    }
    return this.blocks.get(block.id) ?? block;
  }

  /**
   * Write block chia se (replace toan bo hoac append). Chi supervisor
   * / user duoc goi — thanh vien thuong bi chan. Noi dung moi vuot
   * cap chia se -> throw, khong cat len. Ghi xong: ghi them entry vao
   * bang block_history (backend `shared-v11`) de lich su noi that.
   */
  writeSharedBlock(
    groupIdOrName: string,
    blockIdOrLabel: string,
    input: { content?: string; append?: string },
    actor: string,
  ): SharedWriteResult {
    const group = this.groups.getGroup(groupIdOrName);
    if (!group) throw new V11SharedError(`Shared group "${groupIdOrName}" not found.`);
    const block = this.blocks.get(blockIdOrLabel);
    if (!block) throw new V11SharedError(`Shared block "${blockIdOrLabel}" not found.`);
    if (!group.blockIds.includes(block.id)) {
      throw new V11SharedError(
        `Block "${block.label}" is not in group "${group.name}" — it is not a shared block of this group.`,
      );
    }
    this.assertCanWriteShared(group, actor);
    const hasContent = input.content !== undefined;
    const hasAppend = input.append !== undefined;
    if (hasContent === hasAppend) {
      throw new V11SharedError('Pass exactly one of "content" (replace) or "append".');
    }
    let updated: MemoryBlock;
    let mode: 'replace' | 'append';
    if (hasContent) {
      const next = input.content ?? '';
      this.assertSharedSize(block.label, next);
      updated = this.blocks.replace(block.id, next, actor);
      mode = 'replace';
    } else {
      // Store append noi them '\n' giua noi dung cu va phan them
      // (xem MemoryBlockStore.append) — tinh dung kich thuoc thuc.
      const addition = (input.append ?? '').trim();
      const next =
        block.content === '' ? addition : `${block.content}\n${addition}`;
      this.assertSharedSize(block.label, next);
      updated = this.blocks.append(block.id, input.append ?? '', actor);
      mode = 'append';
    }
    recordBlockHistoryChange(
      this.workspaceDir,
      historyInputFromBlock(updated, 'shared-v11', mode === 'replace' ? 'replace' : 'append', actor),
    );
    return {
      block: updated,
      groupId: group.id,
      groupName: group.name,
      usage: sharedBlockUsage(updated),
      mode,
    };
  }

  /** Moi block chia se cua mot nhom (hoac tat ca nhom khi khong truyen). */
  listSharedBlocks(groupIdOrName?: string): SharedBlockView[] {
    const groups =
      groupIdOrName !== undefined
        ? [this.groups.getGroup(groupIdOrName)].filter(
            (g): g is SharedBlockGroup => g !== null,
          )
        : this.groups.listGroups();
    if (groupIdOrName !== undefined && groups.length === 0) {
      throw new V11SharedError(`Shared group "${groupIdOrName}" not found.`);
    }
    const supervisors = this.readSupervisors().supervisors;
    const out: SharedBlockView[] = [];
    for (const group of groups) {
      for (const blockId of group.blockIds) {
        const block = this.blocks.get(blockId);
        if (!block) continue; // block da bi xoa — sync report cua v1.03 phat hien
        out.push({
          block,
          groupId: group.id,
          groupName: group.name,
          supervisorBotId: supervisors[group.id] ?? '',
          memberBotIds: group.members.map((m) => m.botId),
          usage: sharedBlockUsage(block),
        });
      }
    }
    return out;
  }
}
