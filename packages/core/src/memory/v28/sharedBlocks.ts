/**
 * Memory v28 — shared blocks giua cac bot (v1.44, Doi T1).
 *
 * Y tuong hoc tu Letta v0.16.7 Conversations API (survey v144
 * muc 2, chi y tuong, KHONG copy code/text/tai san): memory la
 * tai nguyen CHUNG, nhieu agent doc/ghi chung mot block — khong
 * phai state rieng cua tung agent. Tu thiet ke lai hoan toan cho
 * open-bot tren nen git store v28 + ACL rieng.
 *
 * Mo hinh quyen (theo bot):
 *  - `admin`  — doc/ghi + cap/thu quyen + attach/detach bot khac.
 *  - `write`  — doc + ghi noi dung block.
 *  - `read`   — chi doc.
 *  - `none`   — khong thay block ton tai (list/read deu an).
 *  - Owner luon la admin, khong thu hoi duoc.
 *
 * Moi hanh dong deu ghi audit log (`audit.jsonl`, append-only):
 * create/grant/revoke/attach/detach/write/rollback/archive.
 * ACL luu o `acl.json` (ghi atomic qua file tam + rename).
 * Noi dung block van nam trong git store v28 — moi lan ghi la
 * 1 commit, lich su day du.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { V28GitBlockStore } from './gitStore';
import {
  errV28,
  isValidBlockLabelV28,
  normalizeBlockLabelV28,
  okV28,
  V28_ACL_FILENAME,
  V28_AUDIT_FILENAME,
  V28_LIMITS,
  V28_ROLE_RANK,
  type V28AclEntry,
  type V28AclRole,
  type V28AuditEntry,
  type V28BlockMeta,
  type V28Result,
  type V28SharedBlock,
} from './types';

/** Tuy chon khoi tao registry. */
export interface V28SharedBlockRegistryOptions {
  /** Git store v28 ben duoi (noi dung block nam o day). */
  gitStore: V28GitBlockStore;
}

/** Ket qua ghi shared block. */
export interface V28SharedWriteResult {
  label: string;
  version: number;
  commit: string;
  hash: string;
}

/** Kiem tra role co du quyen yeu cau khong. */
export function roleAtLeastV28(have: V28AclRole, need: V28AclRole): boolean {
  return V28_ROLE_RANK[have] >= V28_ROLE_RANK[need];
}

/**
 * Registry shared block: ACL + attach + audit, tren nen git store.
 *
 * Luu y an toan: `readForBot`/`writeForBot` tra loi chung chung
 * khi bot khong co quyen (khong tiet lo block co ton tai hay
 * khong, tru khi bot la owner/admin).
 */
export class V28SharedBlockRegistry {
  readonly gitStore: V28GitBlockStore;
  private aclPath: string;
  private auditPath: string;

  constructor(opts: V28SharedBlockRegistryOptions) {
    this.gitStore = opts.gitStore;
    this.aclPath = join(this.gitStore.repoDir, V28_ACL_FILENAME);
    this.auditPath = join(this.gitStore.repoDir, V28_AUDIT_FILENAME);
    mkdirSync(this.gitStore.repoDir, { recursive: true });
  }

  // ---------------------------------------------------------------- ACL

  /** Doc toan bo ACL tu disk (mang rong khi chua co file). */
  loadAcl(): V28AclEntry[] {
    if (!existsSync(this.aclPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.aclPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return (parsed as V28AclEntry[]).filter(
        (e) => typeof e?.label === 'string' && typeof e?.botId === 'string' && typeof e?.role === 'string',
      );
    } catch {
      return [];
    }
  }

  /** Ghi ACL xuong disk (atomic qua file tam + rename). */
  saveAcl(entries: V28AclEntry[]): void {
    const tmp = `${this.aclPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.aclPath);
  }

  /** ACL cua mot block (sap xep theo botId). */
  getAcl(label: string): V28AclEntry[] {
    const normalized = normalizeBlockLabelV28(label);
    return this.loadAcl()
      .filter((e) => e.label === normalized)
      .sort((a, b) => a.botId.localeCompare(b.botId));
  }

  /** Quyen cua mot bot tren mot block (mac dinh `none`). */
  roleOf(label: string, botId: string): V28AclRole {
    const normalized = normalizeBlockLabelV28(label);
    const block = this.gitStore.readBlock(normalized);
    if (block && block.meta.ownerBotId === botId) return 'admin';
    const entry = this.loadAcl().find((e) => e.label === normalized && e.botId === botId);
    return entry?.role ?? 'none';
  }

  /** Block co phai shared block khong (scope shared hoac co ACL). */
  isShared(label: string): boolean {
    const normalized = normalizeBlockLabelV28(label);
    const block = this.gitStore.readBlock(normalized);
    if (!block) return false;
    if (block.meta.scope === 'shared') return true;
    return this.loadAcl().some((e) => e.label === normalized);
  }

  // ---------------------------------------------------------------- audit

  /** Doc audit log (moi nhat truoc). */
  loadAudit(limit: number = V28_LIMITS.maxAuditEntries): V28AuditEntry[] {
    if (!existsSync(this.auditPath)) return [];
    const out: V28AuditEntry[] = [];
    for (const line of readFileSync(this.auditPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as V28AuditEntry);
      } catch {
        // Dong loi thi bo qua.
      }
    }
    return out.slice(-Math.max(1, limit)).reverse();
  }

  private appendAudit(entry: V28AuditEntry): void {
    appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Audit cua mot block (moi nhat truoc). */
  auditFor(label: string, limit: number = V28_LIMITS.maxAuditEntries): V28AuditEntry[] {
    const normalized = normalizeBlockLabelV28(label);
    return this.loadAudit(V28_LIMITS.maxAuditEntries).filter((e) => e.label === normalized).slice(0, limit);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Tao shared block moi: ghi file qua git store (scope `shared`),
   * owner nhan admin, ghi audit `create`.
   */
  createSharedBlock(
    label: string,
    content: string,
    ownerBotId: string,
    opts: { description?: string; kind?: V28BlockMeta['kind']; actor?: string } = {},
  ): V28Result<V28SharedBlock> {
    const normalized = normalizeBlockLabelV28(label);
    if (!isValidBlockLabelV28(normalized)) {
      return errV28(`Label block khong hop le: "${label}"`);
    }
    if (!ownerBotId.trim()) return errV28('ownerBotId khong duoc rong');
    if (this.gitStore.readBlock(normalized)) {
      return errV28(`Block "${normalized}" da ton tai — dung writeForBot de cap nhat`);
    }
    const actor = opts.actor ?? `user`;
    const written = this.gitStore.writeBlock(normalized, content, {
      kind: opts.kind ?? 'shared',
      description: opts.description ?? '',
      scope: 'shared',
      ownerBotId,
      actor,
      message: `create shared block (owner ${ownerBotId})`,
    });
    if (!written.ok) return errV28(written.error);
    this.appendAudit({
      at: new Date().toISOString(),
      label: normalized,
      actor,
      action: 'create',
      detail: `owner=${ownerBotId}`,
      version: written.value.version,
    });
    const block = this.getSharedBlock(normalized, ownerBotId);
    if (!block.ok) return errV28(block.error);
    return okV28(block.value);
  }

  /** Lay shared block day du (chi admin/read tro len moi xem duoc). */
  getSharedBlock(label: string, botId: string): V28Result<V28SharedBlock> {
    const normalized = normalizeBlockLabelV28(label);
    const block = this.gitStore.readBlock(normalized);
    if (!block) return errV28(`Khong co quyen truy cap block "${normalized}"`);
    const role = this.roleOf(normalized, botId);
    if (!roleAtLeastV28(role, 'read')) {
      return errV28(`Bot "${botId}" khong co quyen doc block "${normalized}"`);
    }
    return okV28({
      label: normalized,
      meta: block.meta,
      content: block.content,
      ownerBotId: block.meta.ownerBotId,
      attachedBots: this.attachedBots(normalized),
      acl: this.getAcl(normalized),
    });
  }

  /** Danh sach bot dang attach vao block (owner + bot co ACL). */
  attachedBots(label: string): string[] {
    const normalized = normalizeBlockLabelV28(label);
    const block = this.gitStore.readBlock(normalized);
    const set = new Set<string>();
    if (block?.meta.ownerBotId) set.add(block.meta.ownerBotId);
    for (const entry of this.getAcl(normalized)) {
      if (entry.role !== 'none') set.add(entry.botId);
    }
    return [...set].sort();
  }

  /** Liet ke shared block ma mot bot doc duoc (kem role cua no). */
  listForBot(botId: string): Array<{ label: string; role: V28AclRole; version: number; updatedAt: string }> {
    const out: Array<{ label: string; role: V28AclRole; version: number; updatedAt: string }> = [];
    for (const meta of this.gitStore.listBlocks()) {
      if (!this.isShared(meta.label)) continue;
      const role = this.roleOf(meta.label, botId);
      if (!roleAtLeastV28(role, 'read')) continue;
      out.push({ label: meta.label, role, version: meta.version, updatedAt: meta.updatedAt });
    }
    return out;
  }

  // ------------------------------------------------------------- ACL admin

  /**
   * Cap/thay quyen cho bot. Chi owner/admin duoc cap. Khong the
   * ha quyen cua owner. Cap `admin` chi owner moi duoc cap.
   */
  grantRole(
    label: string,
    botId: string,
    role: V28AclRole,
    grantedBy: string,
  ): V28Result<V28AclEntry> {
    const normalized = normalizeBlockLabelV28(label);
    if (!botId.trim()) return errV28('botId khong duoc rong');
    const block = this.gitStore.readBlock(normalized);
    if (!block) return errV28(`Khong co block "${normalized}"`);
    const granterRole = this.roleOf(normalized, grantedBy);
    if (!roleAtLeastV28(granterRole, 'admin')) {
      return errV28(`"${grantedBy}" khong co quyen admin tren block "${normalized}"`);
    }
    if (block.meta.ownerBotId === botId) {
      return errV28(`"${botId}" la owner cua block "${normalized}" — luon co quyen admin`);
    }
    if (role === 'admin' && block.meta.ownerBotId !== grantedBy) {
      return errV28('Chi owner moi duoc cap quyen admin');
    }
    const acl = this.loadAcl();
    const now = new Date().toISOString();
    const existing = acl.find((e) => e.label === normalized && e.botId === botId);
    let entry: V28AclEntry;
    if (existing) {
      existing.role = role;
      existing.grantedBy = grantedBy;
      existing.grantedAt = now;
      entry = existing;
    } else {
      entry = { label: normalized, botId, role, grantedBy, grantedAt: now };
      acl.push(entry);
    }
    this.saveAcl(acl);
    this.appendAudit({
      at: now,
      label: normalized,
      actor: grantedBy,
      action: 'grant',
      detail: `${botId} -> ${role}`,
    });
    return okV28({ ...entry });
  }

  /** Thu hoi quyen cua bot (ve `none`). Chi owner/admin duoc thu. */
  revokeRole(label: string, botId: string, revokedBy: string): V28Result<string> {
    const normalized = normalizeBlockLabelV28(label);
    const block = this.gitStore.readBlock(normalized);
    if (!block) return errV28(`Khong co block "${normalized}"`);
    if (block.meta.ownerBotId === botId) {
      return errV28(`Khong the thu quyen cua owner "${botId}"`);
    }
    const revokerRole = this.roleOf(normalized, revokedBy);
    if (!roleAtLeastV28(revokerRole, 'admin')) {
      return errV28(`"${revokedBy}" khong co quyen admin tren block "${normalized}"`);
    }
    const acl = this.loadAcl();
    const idx = acl.findIndex((e) => e.label === normalized && e.botId === botId);
    if (idx === -1) return errV28(`Bot "${botId}" chua co quyen gi tren block "${normalized}"`);
    acl.splice(idx, 1);
    this.saveAcl(acl);
    this.appendAudit({
      at: new Date().toISOString(),
      label: normalized,
      actor: revokedBy,
      action: 'revoke',
      detail: `${botId} -> none`,
    });
    return okV28(`Da thu quyen cua bot "${botId}" tren block "${normalized}"`);
  }

  /** Attach bot vao block (cap quyen read neu chua co quyen). */
  attachBot(label: string, botId: string, attachedBy: string): V28Result<V28AclEntry> {
    const normalized = normalizeBlockLabelV28(label);
    const current = this.roleOf(normalized, botId);
    if (roleAtLeastV28(current, 'read')) {
      return okV28({
        label: normalized,
        botId,
        role: current,
        grantedBy: attachedBy,
        grantedAt: new Date().toISOString(),
      });
    }
    const granted = this.grantRole(normalized, botId, 'read', attachedBy);
    if (!granted.ok) return errV28(granted.error);
    this.appendAudit({
      at: new Date().toISOString(),
      label: normalized,
      actor: attachedBy,
      action: 'attach',
      detail: `bot=${botId}`,
    });
    return okV28(granted.value);
  }

  /** Detach bot khoi block (thu het quyen). Owner khong detach duoc. */
  detachBot(label: string, botId: string, detachedBy: string): V28Result<string> {
    const result = this.revokeRole(label, botId, detachedBy);
    if (!result.ok) return errV28(result.error);
    this.appendAudit({
      at: new Date().toISOString(),
      label: normalizeBlockLabelV28(label),
      actor: detachedBy,
      action: 'detach',
      detail: `bot=${botId}`,
    });
    return okV28(`Da detach bot "${botId}" khoi block "${normalizeBlockLabelV28(label)}"`);
  }

  // ----------------------------------------------------------------- write

  /**
   * Ghi noi dung shared block voi tu cach mot bot. Can quyen
   * `write` tro len. Ghi that qua git store (1 commit), ghi
   * audit `write`. Bot co quyen `read` se nhan loi tu choi.
   */
  writeForBot(
    label: string,
    botId: string,
    content: string,
    opts: { message?: string } = {},
  ): V28Result<V28SharedWriteResult> {
    const normalized = normalizeBlockLabelV28(label);
    const role = this.roleOf(normalized, botId);
    if (!roleAtLeastV28(role, 'write')) {
      return errV28(`Bot "${botId}" khong co quyen ghi block "${normalized}" (quyen hien tai: ${role})`);
    }
    const block = this.gitStore.readBlock(normalized);
    if (!block) return errV28(`Khong co block "${normalized}"`);
    if (block.meta.readOnly) return errV28(`Block "${normalized}" dang read-only`);
    const written = this.gitStore.writeBlock(normalized, content, {
      actor: `agent:${botId}`,
      message: opts.message ?? `shared write by ${botId}`,
      kind: block.meta.kind,
      description: block.meta.description,
      scope: 'shared',
      ownerBotId: block.meta.ownerBotId,
    });
    if (!written.ok) return errV28(written.error);
    this.appendAudit({
      at: new Date().toISOString(),
      label: normalized,
      actor: `agent:${botId}`,
      action: 'write',
      detail: `bot=${botId}`,
      version: written.value.version,
    });
    return okV28({
      label: normalized,
      version: written.value.version,
      commit: written.value.commit,
      hash: written.value.hash,
    });
  }

  /** Doc noi dung shared block voi tu cach mot bot (can quyen read). */
  readForBot(label: string, botId: string): V28Result<{ content: string; version: number; updatedAt: string }> {
    const block = this.getSharedBlock(label, botId);
    if (!block.ok) return errV28(block.error);
    return okV28({
      content: block.value.content,
      version: block.value.meta.version,
      updatedAt: block.value.meta.updatedAt,
    });
  }

  /** Tong so muc ACL (dung cho stats). */
  aclTotal(): number {
    return this.loadAcl().length;
  }

  /** Tong so muc audit (dung cho stats). */
  auditTotal(): number {
    return this.loadAudit(V28_LIMITS.maxAuditEntries * 10).length;
  }
}
