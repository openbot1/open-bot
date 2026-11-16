/**
 * Memory v13 — block-level ACL (v1.14, Doi T1).
 *
 * Y tuong hoc tu Letta (block read-only + runtime enforcement: agent
 * duoc tin sua core memory cua chinh no nen can co che chan o tang
 * runtime, khong chi o prompt) — tu thiet ke lai hoan toan cho
 * open-bot, KHONG copy code/text/tai san cua bat ky repo nao.
 *
 * Ba muc (luu trong sidecar `.open-bot/memory-blocks-v13-acl.json`,
 * rieng khoi file block chinh de khong doi dinh dang cu):
 *
 *  - `open` (mac dinh): ai cung doc/sua theo luat store san co.
 *  - `read-only`: chi actor `user` moi sua/xoa; agent chi doc.
 *    Kha voi co `readOnly` cua block o cho: co nay nam o tang ACL
 *    (doi duoc ma khong can mo khoa block), va duoc kiem tra ca khi
 *    bien dich prompt — block read-only van DUOC dua vao prompt.
 *  - `sensitive`: chi `user` moi doc/sua; agent khong doc duoc,
 *    KHONG bao gio lọt vao system prompt bien dich tu `compile`
 *    (v12) va KHONG bao gio xuat hien trong log — log chi giu
 *    placeholder. Day la rao chan mac dinh chong ro ri thong tin
 *    nhay cam (suc khoe, tai chinh, mat khau...) vao prompt/log.
 *
 * Luat actor: `user` = nguoi dung; `agent:<botId>` / `system:*` =
 * agent/he thong. Mọi thao tac doi ACL deu ghi `updatedBy` + ly do
 * de audit duoc ai da mo/khoa mot block.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryBlock } from '../blocks';

/** Loi ACL — message tieng Viet. */
export class V13BlockAclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V13BlockAclError';
  }
}

/** Duong dan file ACL (tuong doi trong workspace). */
export const V13_BLOCK_ACL_REL_PATH = path.join(
  '.open-bot',
  'memory-blocks-v13-acl.json',
);

/** Chu thay the noi dung nhay cam trong log/prompt debug. */
export const V13_SENSITIVE_REDACTED = '[sensitive — redacted]';

/** Muc ACL cua mot block. */
export type V13BlockAclLevel = 'open' | 'read-only' | 'sensitive';

/** Ban ghi ACL cua mot block. */
export interface V13BlockAcl {
  blockId: string;
  label: string;
  level: V13BlockAclLevel;
  updatedAt: string;
  updatedBy: string;
  reason?: string;
}

export interface V13BlockAclFile {
  version: 1;
  acls: V13BlockAcl[];
}

export function v13AclEmptyFile(): V13BlockAclFile {
  return { version: 1, acls: [] };
}

export function isValidV13AclLevel(level: string): level is V13BlockAclLevel {
  return level === 'open' || level === 'read-only' || level === 'sensitive';
}

/** `true` khi actor la user (khong phai agent/he thong). */
export function isUserActor(actor: string): boolean {
  return (actor ?? '').trim() === 'user';
}

export interface V13PromptFilterResult {
  /** Block duoc phep vao prompt (da bo sensitive). */
  visible: MemoryBlock[];
  /** Block bi loai (kem ly do de UI giai thich). */
  hidden: { label: string; level: V13BlockAclLevel; reason: string }[];
}

/** Kho ACL theo block (mot workspace = mot file sidecar). */
export class V13BlockAclStore {
  private readonly filePath: string;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, V13_BLOCK_ACL_REL_PATH);
  }

  get dir(): string {
    return this.workspaceDir;
  }

  private readFile(): V13BlockAclFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return v13AclEmptyFile();
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new V13BlockAclError(
        `File ACL block v13 khong phai JSON hop le: ${V13_BLOCK_ACL_REL_PATH}`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as V13BlockAclFile).version !== 1 ||
      !Array.isArray((parsed as V13BlockAclFile).acls)
    ) {
      throw new V13BlockAclError(
        `File ACL block v13 co dinh dang khong ho tro: ${V13_BLOCK_ACL_REL_PATH}`,
      );
    }
    return parsed as V13BlockAclFile;
  }

  private writeFile(file: V13BlockAclFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Muc ACL cua mot block (mac dinh `open` khi chua dat). */
  get(blockIdOrLabel: string, blocks?: MemoryBlock[]): V13BlockAclLevel {
    const file = this.readFile();
    const byId = file.acls.find((a) => a.blockId === blockIdOrLabel);
    if (byId) return byId.level;
    if (blocks) {
      const block = blocks.find((b) => b.label === blockIdOrLabel);
      if (block) {
        const byBlockId = file.acls.find((a) => a.blockId === block.id);
        if (byBlockId) return byBlockId.level;
      }
    }
    return 'open';
  }

  /** Ban ghi ACL day du (null khi chua dat). */
  getRecord(blockId: string): V13BlockAcl | null {
    const file = this.readFile();
    const found = file.acls.find((a) => a.blockId === blockId);
    return found ? { ...found } : null;
  }

  /** Liet ke toan bo ACL da dat. */
  list(): V13BlockAcl[] {
    return this.readFile().acls.map((a) => ({ ...a }));
  }

  /**
   * Dat muc ACL cho mot block. Chi `user` moi doi ACL — agent tu khoa
   * block cua minh roi mo lai la lo hong bao mat.
   */
  set(
    blockId: string,
    level: V13BlockAclLevel,
    actor = 'user',
    opts: { label?: string; reason?: string } = {},
  ): V13BlockAcl {
    if (!isUserActor(actor)) {
      throw new V13BlockAclError('Chi user moi doi duoc ACL cua block.');
    }
    if (!isValidV13AclLevel(level)) {
      throw new V13BlockAclError(`Muc ACL khong hop le: "${level}".`);
    }
    const file = this.readFile();
    const now = new Date().toISOString();
    const existing = file.acls.find((a) => a.blockId === blockId);
    if (existing) {
      existing.level = level;
      existing.updatedAt = now;
      existing.updatedBy = actor;
      if (opts.label !== undefined) existing.label = opts.label;
      if (opts.reason !== undefined) existing.reason = opts.reason.slice(0, 500);
      else delete existing.reason;
      this.writeFile(file);
      return { ...existing };
    }
    const record: V13BlockAcl = {
      blockId,
      label: opts.label ?? '',
      level,
      updatedAt: now,
      updatedBy: actor,
      ...(opts.reason !== undefined ? { reason: opts.reason.slice(0, 500) } : {}),
    };
    file.acls.push(record);
    this.writeFile(file);
    return { ...record };
  }

  /** Xoa ACL cua mot block (ve mac dinh `open`). Chi user. */
  clear(blockId: string, actor = 'user'): boolean {
    if (!isUserActor(actor)) {
      throw new V13BlockAclError('Chi user moi xoa duoc ACL cua block.');
    }
    const file = this.readFile();
    const before = file.acls.length;
    file.acls = file.acls.filter((a) => a.blockId !== blockId);
    if (file.acls.length === before) return false;
    this.writeFile(file);
    return true;
  }

  /** Actor co duoc doc block nay khong (sensitive chi user). */
  canRead(block: MemoryBlock, actor: string): boolean {
    const level = this.get(block.id);
    if (level === 'sensitive' && !isUserActor(actor)) return false;
    return true;
  }

  /** Actor co duoc sua block nay khong (read-only/sensitive chi user). */
  canEdit(block: MemoryBlock, actor: string): boolean {
    const level = this.get(block.id);
    if (level === 'sensitive' || level === 'read-only') {
      return isUserActor(actor);
    }
    return true;
  }

  /** Chan sua neu actor khong du quyen — throw truoc khi store ghi. */
  assertCanEdit(block: MemoryBlock, actor: string): void {
    if (!this.canEdit(block, actor)) {
      const level = this.get(block.id);
      throw new V13BlockAclError(
        `Block "${block.label}" dang o muc ACL "${level}" — actor "${actor}" khong duoc sua.`,
      );
    }
  }

  /** Chan doc neu actor khong du quyen. */
  assertCanRead(block: MemoryBlock, actor: string): void {
    if (!this.canRead(block, actor)) {
      throw new V13BlockAclError(
        `Block "${block.label}" dang o muc ACL "sensitive" — actor "${actor}" khong duoc doc.`,
      );
    }
  }
}

/**
 * Loc block truoc khi bien dich vao prompt: block `sensitive` bi loai
 * hoan toan (ca label lan noi dung); block `read-only` van duoc dua
 * vao (no chi cam sua, khong cam doc). Dung chung voi
 * `BlockPromptCompiler` cua v12: loc truoc roi moi compile.
 */
export function filterBlocksForPrompt(
  blocks: MemoryBlock[],
  aclStore: V13BlockAclStore,
): V13PromptFilterResult {
  const visible: MemoryBlock[] = [];
  const hidden: V13PromptFilterResult['hidden'] = [];
  for (const block of blocks) {
    const level = aclStore.get(block.id);
    if (level === 'sensitive') {
      hidden.push({
        label: block.label,
        level,
        reason: 'Block sensitive khong dua vao prompt mac dinh.',
      });
    } else {
      visible.push({ ...block });
    }
  }
  return { visible, hidden };
}

/** Tien ich: chi lay block duoc phep vao prompt. */
export function promptSafeBlocks(
  blocks: MemoryBlock[],
  aclStore: V13BlockAclStore,
): MemoryBlock[] {
  return filterBlocksForPrompt(blocks, aclStore).visible;
}

/**
 * Che noi dung block de ghi log: block `sensitive` chi giu lai label
 * + placeholder; block thuong giu nguyen. Log khong bao gio duoc
 * chua noi dung nhay cam du caller co quen loc hay khong.
 */
export function redactBlockForLog(
  block: MemoryBlock,
  aclStore: V13BlockAclStore,
): MemoryBlock {
  if (aclStore.get(block.id) !== 'sensitive') return { ...block };
  return { ...block, content: V13_SENSITIVE_REDACTED, description: V13_SENSITIVE_REDACTED };
}

/** Tom tat ACL de hien trong UI cai dat (so block theo tung muc). */
export function summarizeAcl(
  blocks: MemoryBlock[],
  aclStore: V13BlockAclStore,
): { open: number; readOnly: number; sensitive: number; total: number } {
  const out = { open: 0, readOnly: 0, sensitive: 0, total: blocks.length };
  for (const block of blocks) {
    const level = aclStore.get(block.id);
    if (level === 'read-only') out.readOnly += 1;
    else if (level === 'sensitive') out.sensitive += 1;
    else out.open += 1;
  }
  return out;
}
