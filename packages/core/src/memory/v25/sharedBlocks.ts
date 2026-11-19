/**
 * Memory v25 — shared memory blocks (v1.40, Doi T1).
 *
 * Y tuong hoc tu Letta (survey v140 muc 2, chi y tuong): core
 * memory render thang vao prompt duoi dang <memory_blocks>; block
 * co label + mo ta + gia tri (vd `human` ve user, `persona` vai
 * tro agent); block co the attach/detach, CHIA SE giua cac agent
 * hoac danh dau READ-ONLY — nhieu agent song song chia se block,
 * giu hieu biet chung nhat quan.
 *
 * Quy tac v25 (k hac v24: v24 dung khoa lease + expectedVersion):
 *  - Owner luon duoc ghi, ke ca khi block read-only.
 *  - Bot khac chi duoc ghi khi block KHONG read-only va bot da
 *    attach; khi read-only thi bot khac CHI DOC.
 *  - Doc chi cho owner + bot da attach (block khong phai la public).
 *  - Moi lan ghi/revert tao version moi, lich su giu day du.
 *  - Sleep agent ghi block qua write() voi byBotId='sleep-agent'
 *    nen cung tuan thu read-only (chi ghi block no so huu hoac
 *    block mo da attach).
 *
 * Chay 100% local, khong goi model/mang.
 */
import {
  blockReadableByV25,
  blockWritableByV25,
  errV25,
  isValidBlockLabelV25,
  isoAtV25,
  makeV25Id,
  okV25,
  scopeMatchesV25,
  type V25Result,
  type V25Scope,
  type V25SharedBlock,
  type V25SharedBlockInput,
} from './types';

/** Bo loc khi liet ke block. */
export interface V25BlockFilter {
  scope?: V25Scope;
  /** Chi block bot nay attach (hoac so huu). */
  botId?: string;
  readOnly?: boolean;
  limit?: number;
}

/** Store shared block trong bo nho. */
export class V25SharedBlockStore {
  private readonly blocks = new Map<string, V25SharedBlock>();

  get size(): number {
    return this.blocks.size;
  }

  /** Tao block moi — label duy nhat trong scope. */
  create(input: V25SharedBlockInput, opts: { nowMs?: number } = {}): V25Result<V25SharedBlock> {
    const label = input.label.trim().toLowerCase();
    if (!isValidBlockLabelV25(label)) {
      return errV25(`Label block "${input.label}" khong hop le (a-z, 0-9, _-, 1..64 ky tu, bat dau bang chu/so).`);
    }
    const ownerBotId = input.ownerBotId.trim();
    if (!ownerBotId) return errV25('ownerBotId khong duoc rong.');
    const value = input.value;
    if (typeof value !== 'string' || value.length === 0) return errV25('value khong duoc rong.');
    const maxChars = input.maxChars ?? 0;
    if (maxChars < 0 || maxChars > 200000) return errV25('maxChars phai 0..200000 (0 = khong gioi han).');
    if (maxChars > 0 && value.length > maxChars) {
      return errV25(`value dai ${value.length} ky tu, vuot maxChars ${maxChars}.`);
    }
    const scope: V25Scope = {
      userId: input.scope?.userId ?? '',
      agentId: input.scope?.agentId ?? '',
      runId: input.scope?.runId ?? '',
      appId: input.scope?.appId ?? '',
    };
    const clash = this.getByLabel(label, scope);
    if (clash) return errV25(`Da co block label "${label}" trong scope nay (${clash.id}).`);
    const nowMs = opts.nowMs ?? Date.now();
    const nowIso = isoAtV25(nowMs);
    const attached = new Set<string>([ownerBotId, ...(input.attachBotIds ?? [])]);
    const block: V25SharedBlock = {
      id: makeV25Id('blk'),
      label,
      description: (input.description ?? '').trim(),
      value,
      ownerBotId,
      attachedBotIds: [...attached],
      readOnly: input.readOnly ?? false,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      scope,
      maxChars,
      history: [
        { version: 1, value, updatedAt: nowIso, updatedBy: ownerBotId, reason: 'created' },
      ],
    };
    this.blocks.set(block.id, block);
    return okV25(block);
  }

  get(id: string): V25SharedBlock | undefined {
    return this.blocks.get(id);
  }

  /** Tim block theo label trong scope (label duy nhat theo scope). */
  getByLabel(label: string, scope: V25Scope): V25SharedBlock | undefined {
    const norm = label.trim().toLowerCase();
    for (const block of this.blocks.values()) {
      if (block.label !== norm) continue;
      if (!scopeMatchesV25(block.scope, scope)) continue;
      return block;
    }
    return undefined;
  }

  /** Liet ke block theo bo loc (moi nhat truoc). */
  list(filter: V25BlockFilter = {}): V25SharedBlock[] {
    const out: V25SharedBlock[] = [];
    for (const block of this.blocks.values()) {
      if (filter.scope && !scopeMatchesV25(block.scope, filter.scope)) continue;
      if (filter.botId !== undefined) {
        const mine = block.ownerBotId === filter.botId || block.attachedBotIds.includes(filter.botId);
        if (!mine) continue;
      }
      if (filter.readOnly !== undefined && block.readOnly !== filter.readOnly) continue;
      out.push(block);
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    if (filter.limit !== undefined) return out.slice(0, Math.max(0, filter.limit));
    return out;
  }

  /** Attach 1 bot vao block (bot duoc doc; ghi tuy readOnly). */
  attach(id: string, botId: string): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    const bot = botId.trim();
    if (!bot) return errV25('botId khong duoc rong.');
    if (block.attachedBotIds.includes(bot)) return okV25(block);
    block.attachedBotIds.push(bot);
    return okV25(block);
  }

  /**
   * Detach 1 bot khoi block. Owner khong duoc tu detach — phai
   * transferOwnership truoc (tranh block mo coi khong ai so huu).
   */
  detach(id: string, botId: string): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    const bot = botId.trim();
    if (bot === block.ownerBotId) {
      return errV25('Owner khong duoc detach khoi block cua minh — dung transferOwnership truoc.');
    }
    const idx = block.attachedBotIds.indexOf(bot);
    if (idx === -1) return errV25(`Bot "${bot}" khong attach block ${block.label}.`);
    block.attachedBotIds.splice(idx, 1);
    return okV25(block);
  }

  /** Chuyen quyen so huu block sang bot khac (chi owner cu goi). */
  transferOwnership(id: string, fromBotId: string, toBotId: string): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    if (fromBotId !== block.ownerBotId) {
      return errV25(`Chi owner (${block.ownerBotId}) moi duoc chuyen quyen so huu.`);
    }
    const to = toBotId.trim();
    if (!to) return errV25('toBotId khong duoc rong.');
    if (to === block.ownerBotId) return okV25(block);
    block.ownerBotId = to;
    if (!block.attachedBotIds.includes(to)) block.attachedBotIds.push(to);
    return okV25(block);
  }

  /**
   * Bat/tat read-only (chi owner). Khi read-only, bot khac owner
   * chi doc, khong ghi — giu hieu biet chung nhat quan.
   */
  setReadOnly(id: string, readOnly: boolean, byBotId: string): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    if (byBotId !== block.ownerBotId) {
      return errV25(`Chi owner (${block.ownerBotId}) moi duoc doi read-only.`);
    }
    block.readOnly = readOnly;
    return okV25(block);
  }

  /** Doi mo ta block (chi owner). */
  setDescription(id: string, description: string, byBotId: string): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    if (byBotId !== block.ownerBotId) {
      return errV25(`Chi owner (${block.ownerBotId}) moi duoc doi mo ta.`);
    }
    block.description = description.trim();
    return okV25(block);
  }

  /**
   * Ghi gia tri moi cho block. Kiem tra quyen ghi (read-only: bot
   * khac owner chi doc) + maxChars. Ghi thanh cong tang version
   * va ghi lich su.
   */
  write(
    id: string,
    value: string,
    byBotId: string,
    opts: { nowMs?: number; reason?: string; expectedVersion?: number } = {},
  ): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    if (!blockWritableByV25(block, byBotId)) {
      if (block.readOnly) {
        return errV25(
          `Block "${block.label}" dang read-only — bot "${byBotId}" chi duoc doc (owner la "${block.ownerBotId}").`,
        );
      }
      return errV25(`Bot "${byBotId}" chua attach block "${block.label}" — khong duoc ghi.`);
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== block.version) {
      return errV25(
        `expectedVersion ${opts.expectedVersion} khong khop version hien tai ${block.version} — co the bi ghi de.`,
      );
    }
    if (block.maxChars > 0 && value.length > block.maxChars) {
      return errV25(`value dai ${value.length} ky tu, vuot maxChars ${block.maxChars}.`);
    }
    const nowIso = isoAtV25(opts.nowMs ?? Date.now());
    block.value = value;
    block.version += 1;
    block.updatedAt = nowIso;
    block.history.push({
      version: block.version,
      value,
      updatedAt: nowIso,
      updatedBy: byBotId,
      reason: opts.reason ?? 'write',
    });
    return okV25(block);
  }

  /**
   * Revert ve 1 version cu — tao version MOI mang gia tri cu
   * (lich su khong bi xoa). Tuan thu quyen ghi nhu write().
   */
  revert(
    id: string,
    version: number,
    byBotId: string,
    opts: { nowMs?: number; reason?: string } = {},
  ): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    if (!blockWritableByV25(block, byBotId)) {
      return errV25(`Bot "${byBotId}" khong duoc ghi block "${block.label}" (read-only hoac chua attach).`);
    }
    const target = block.history.find((v) => v.version === version);
    if (!target) return errV25(`Block "${block.label}" khong co version ${version}.`);
    if (target.version === block.version) return okV25(block);
    return this.write(id, target.value, byBotId, {
      nowMs: opts.nowMs,
      reason: opts.reason ?? `revert to v${version}`,
    });
  }

  /** Doc block — chi owner + bot da attach. */
  readForBot(id: string, botId: string): V25Result<V25SharedBlock> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    if (!blockReadableByV25(block, botId)) {
      return errV25(`Bot "${botId}" khong duoc doc block "${block.label}" (chua attach).`);
    }
    return okV25(block);
  }

  /** Lich su version cua block. */
  history(id: string): V25Result<V25SharedBlock['history']> {
    const block = this.blocks.get(id);
    if (!block) return errV25(`Khong co block "${id}".`);
    return okV25([...block.history]);
  }

  /**
   * Render cac block thanh <memory_blocks> de dua vao prompt
   * (Letta-style). Chi render block bot duoc doc.
   */
  renderForPrompt(blocks: V25SharedBlock[], botId: string): string {
    const readable = blocks.filter((b) => blockReadableByV25(b, botId));
    if (readable.length === 0) return '';
    const parts = ['<memory_blocks>'];
    for (const b of readable) {
      const ro = b.readOnly && b.ownerBotId !== botId ? ' read_only="true"' : '';
      parts.push(`<block label="${escapeXmlV25(b.label)}"${ro}>`);
      if (b.description) parts.push(`<description>${escapeXmlV25(b.description)}</description>`);
      parts.push(`<value>${escapeXmlV25(b.value)}</value>`);
      parts.push('</block>');
    }
    parts.push('</memory_blocks>');
    return parts.join('\n');
  }

  toJSON(): V25SharedBlock[] {
    return [...this.blocks.values()];
  }

  static fromJSON(data: unknown): V25SharedBlockStore {
    const store = new V25SharedBlockStore();
    if (!Array.isArray(data)) return store;
    for (const raw of data as V25SharedBlock[]) {
      if (!raw || typeof raw.id !== 'string') continue;
      store.blocks.set(raw.id, {
        ...raw,
        attachedBotIds: Array.isArray(raw.attachedBotIds) ? raw.attachedBotIds : [],
        history: Array.isArray(raw.history) ? raw.history : [],
      });
    }
    return store;
  }
}

function escapeXmlV25(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
