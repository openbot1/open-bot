/**
 * Memory v24 — shared memory blocks (v1.39, Doi T1).
 *
 * Y tuong Letta shared memory blocks (chi y tuong): mot block
 * (vd "organization", "current_plan") gan vao nhieu agent qua
 * block_ids; mot agent cap nhat la cac agent khac thay ngay,
 * khong can nhan tin agent-to-agent.
 *
 * Tu thiet ke lai hoan toan cho open-bot, chay local:
 *  - Block: {name (duy nhat trong scope), title, content,
 *    version, history[], attachedBotIds[], lock, scope}.
 *  - Khoa viet (lease): acquireLock(botId, ttlMs) — chi 1 bot
 *    viet tai 1 thoi diem; khoa het han tu giai phong; release
 *    ro rang; giu khoa cua bot khac -> loi co ten bot dang giu.
 *  - Optimistic concurrency: update can expectedVersion; sai
 *    version -> loi kem version hien tai (khong ghi de lang).
 *  - Lich su version day du: moi update them 1 entry
 *    {version, content, updatedBy, updatedAt, reason, hash}.
 *  - Merge 3-way don gian theo dong: base vs theirs vs mine —
 *    dong giong nhau giu 1, dong khac nhau ca 2 ben -> conflict
 *    marker `<<<<<<<` / `>>>>>>>` de nguoi duyet.
 *  - Attach/detach bot: bot attach moi thay block ngay o lan
 *    snapshot ke tiep (khong can restart).
 *  - Export/import Markdown: block <-> `# title\n\ncontent`.
 */
import {
  contentHashV24,
  isoAtV24,
  makeV24Id,
  type V24BlockLock,
  type V24BlockVersion,
  type V24Scope,
  type V24SharedBlock,
  V24_MAX_BLOCK_CONTENT_CHARS,
  V24_MAX_SHARED_BLOCKS,
} from './types';

/** Ket qua thao tac block (khong throw). */
export interface V24BlockResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): V24BlockResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): V24BlockResult<T> {
  return { ok: false, error };
}

/** Kiem tra ten block hop le: [a-z0-9_-], 1..64 ky tu. */
export function isValidBlockNameV24(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

/** Kiem tra khoa con hieu luc khong (het han -> coi nhu khong co). */
export function isLockLiveV24(lock: V24BlockLock | null, nowMs: number): boolean {
  if (!lock) return false;
  const expires = new Date(lock.expiresAt).getTime();
  return !Number.isNaN(expires) && nowMs < expires;
}

/** Store shared block in-memory (persist qua V24Store). */
export class V24SharedBlockStore {
  private blocks = new Map<string, V24SharedBlock>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** So block dang co. */
  get size(): number {
    return this.blocks.size;
  }

  /** Lay block theo id (null neu khong co). */
  get(id: string): V24SharedBlock | null {
    const b = this.blocks.get(id);
    return b ? cloneBlockV24(b) : null;
  }

  /** Lay block theo name + scope (name duy nhat trong scope). */
  getByName(name: string, scope: V24Scope): V24SharedBlock | null {
    for (const b of this.blocks.values()) {
      if (b.name === name && scopesMatchForBlockV24(b.scope, scope)) return cloneBlockV24(b);
    }
    return null;
  }

  /** Liet ke block (loc theo bot attach / scope). */
  list(opts: { botId?: string; scope?: V24Scope; limit?: number } = {}): V24SharedBlock[] {
    const out: V24SharedBlock[] = [];
    for (const b of this.blocks.values()) {
      if (opts.botId && !b.attachedBotIds.includes(opts.botId)) continue;
      if (opts.scope && !scopesMatchForBlockV24(b.scope, opts.scope)) continue;
      out.push(cloneBlockV24(b));
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return opts.limit !== undefined ? out.slice(0, Math.max(0, opts.limit)) : out;
  }

  /** Tao block moi (name duy nhat trong scope). */
  create(input: {
    name: string;
    title: string;
    content: string;
    scope: V24Scope;
    createdBy?: string;
    attachBotIds?: string[];
    expiresAt?: string | null;
  }): V24BlockResult<V24SharedBlock> {
    if (!isValidBlockNameV24(input.name)) {
      return fail(`Ten block khong hop le: "${input.name}" (chi a-z0-9_- , 1..64 ky tu).`);
    }
    if (this.getByName(input.name, input.scope)) {
      return fail(`Block "${input.name}" da ton tai trong scope nay.`);
    }
    if (input.content.length > V24_MAX_BLOCK_CONTENT_CHARS) {
      return fail(`Noi dung block vuot ${V24_MAX_BLOCK_CONTENT_CHARS} ky tu.`);
    }
    if (this.blocks.size >= V24_MAX_SHARED_BLOCKS) {
      return fail(`Da dat gioi han ${V24_MAX_SHARED_BLOCKS} shared block.`);
    }
    const nowIso = isoAtV24(this.now());
    const block: V24SharedBlock = {
      id: makeV24Id('blk'),
      name: input.name,
      title: input.title.trim().slice(0, 200),
      content: input.content,
      version: 1,
      history: [{
        version: 1,
        content: input.content,
        updatedBy: input.createdBy ?? '',
        updatedAt: nowIso,
        reason: 'create',
        contentHash: contentHashV24(input.content),
      }],
      attachedBotIds: [...new Set(input.attachBotIds ?? [])],
      lock: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      updatedBy: input.createdBy ?? '',
      scope: { ...input.scope },
      expiresAt: input.expiresAt ?? null,
    };
    this.blocks.set(block.id, block);
    return ok(cloneBlockV24(block));
  }

  /** Attach 1 bot vao block (bot se thay block o snapshot ke tiep). */
  attach(id: string, botId: string): V24BlockResult<V24SharedBlock> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    if (!botId.trim()) return fail('botId rong.');
    if (!b.attachedBotIds.includes(botId)) b.attachedBotIds.push(botId);
    return ok(cloneBlockV24(b));
  }

  /** Detach 1 bot khoi block. */
  detach(id: string, botId: string): V24BlockResult<V24SharedBlock> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    b.attachedBotIds = b.attachedBotIds.filter((x) => x !== botId);
    // Bot dang giu khoa ma detach -> giai phong khoa luon.
    if (b.lock && b.lock.holderBotId === botId) b.lock = null;
    return ok(cloneBlockV24(b));
  }

  /** Lay khoa viet (lease). Bot khac dang giu khoa song -> loi. */
  acquireLock(
    id: string,
    botId: string,
    opts: { ttlMs?: number; reason?: string } = {},
  ): V24BlockResult<V24BlockLock> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    if (!botId.trim()) return fail('botId rong.');
    const nowMs = this.now();
    if (isLockLiveV24(b.lock, nowMs)) {
      if (b.lock!.holderBotId === botId) {
        // Gia han khoa cua chinh minh.
        b.lock = {
          ...b.lock!,
          expiresAt: isoAtV24(nowMs + (opts.ttlMs ?? 5 * 60 * 1000)),
          reason: opts.reason ?? b.lock!.reason,
        };
        return ok({ ...b.lock });
      }
      return fail(
        `Block "${b.name}" dang bi khoa boi bot "${b.lock!.holderBotId}" den ${b.lock!.expiresAt} — thu lai sau.`,
      );
    }
    const lock: V24BlockLock = {
      holderBotId: botId,
      acquiredAt: isoAtV24(nowMs),
      expiresAt: isoAtV24(nowMs + (opts.ttlMs ?? 5 * 60 * 1000)),
      reason: opts.reason ?? 'write',
    };
    b.lock = lock;
    return ok({ ...lock });
  }

  /** Tra khoa viet (chi holder hoac het han moi tra duoc). */
  releaseLock(id: string, botId: string): V24BlockResult<boolean> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    if (!b.lock) return ok(true);
    const nowMs = this.now();
    if (isLockLiveV24(b.lock, nowMs) && b.lock.holderBotId !== botId) {
      return fail(`Khoa dang do bot "${b.lock.holderBotId}" giu — ban khong the tra ho.`);
    }
    b.lock = null;
    return ok(true);
  }

  /** Giai phong khoa het han (sleep job goi). Tra so khoa da giai phong. */
  releaseExpiredLocks(): number {
    const nowMs = this.now();
    let released = 0;
    for (const b of this.blocks.values()) {
      if (b.lock && !isLockLiveV24(b.lock, nowMs)) {
        b.lock = null;
        released++;
      }
    }
    return released;
  }

  /** Cap nhat noi dung block: can khoa (neu co khoa song) + expectedVersion. */
  update(
    id: string,
    content: string,
    opts: { botId: string; expectedVersion?: number; reason?: string },
  ): V24BlockResult<V24SharedBlock> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    if (content.length > V24_MAX_BLOCK_CONTENT_CHARS) {
      return fail(`Noi dung block vuot ${V24_MAX_BLOCK_CONTENT_CHARS} ky tu.`);
    }
    const nowMs = this.now();
    if (isLockLiveV24(b.lock, nowMs) && b.lock!.holderBotId !== opts.botId) {
      return fail(
        `Block "${b.name}" dang bi khoa boi bot "${b.lock!.holderBotId}" — khong the ghi de.`,
      );
    }
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== b.version) {
      return fail(
        `Version conflict: ban dua expectedVersion=${opts.expectedVersion} nhung block "${b.name}" dang o v${b.version} — doc lai roi ghi tiep.`,
      );
    }
    if (content === b.content) return ok(cloneBlockV24(b));
    const nowIso = isoAtV24(nowMs);
    b.content = content;
    b.version += 1;
    b.updatedAt = nowIso;
    b.updatedBy = opts.botId;
    b.history.push({
      version: b.version,
      content,
      updatedBy: opts.botId,
      updatedAt: nowIso,
      reason: opts.reason ?? 'update',
      contentHash: contentHashV24(content),
    });
    return ok(cloneBlockV24(b));
  }

  /** Lich su version cua block. */
  history(id: string): V24BlockVersion[] {
    const b = this.blocks.get(id);
    if (!b) return [];
    return b.history.map((v) => ({ ...v }));
  }

  /** Khoi phuc block ve 1 version cu (tao version moi). */
  revert(id: string, version: number, botId: string): V24BlockResult<V24SharedBlock> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    const target = b.history.find((v) => v.version === version);
    if (!target) return fail(`Block "${b.name}" khong co version ${version}.`);
    return this.update(id, target.content, {
      botId,
      reason: `revert to v${version}`,
    });
  }

  /** Xoa block (chi khi khong co khoa song + khong bot nao attach). */
  delete(id: string, botId: string): V24BlockResult<boolean> {
    const b = this.blocks.get(id);
    if (!b) return fail(`Khong co block "${id}".`);
    const nowMs = this.now();
    if (isLockLiveV24(b.lock, nowMs)) {
      return fail(`Block "${b.name}" dang bi khoa boi "${b.lock!.holderBotId}" — khong xoa duoc.`);
    }
    if (b.attachedBotIds.length > 0) {
      return fail(`Block "${b.name}" con ${b.attachedBotIds.length} bot attach — detach het truoc khi xoa.`);
    }
    void botId;
    this.blocks.delete(id);
    return ok(true);
  }

  /** Nap block da luu (dung khi load tu disk). */
  restore(block: V24SharedBlock): void {
    this.blocks.set(block.id, cloneBlockV24(block));
  }

  /** Xuat tat ca block (dung khi save ra disk). */
  exportAll(): V24SharedBlock[] {
    return [...this.blocks.values()].map((b) => cloneBlockV24(b));
  }
}

/** Clone sau 1 block (history + attachedBotIds copy moi). */
export function cloneBlockV24(block: V24SharedBlock): V24SharedBlock {
  return {
    ...block,
    history: block.history.map((v) => ({ ...v })),
    attachedBotIds: [...block.attachedBotIds],
    lock: block.lock ? { ...block.lock } : null,
    scope: { ...block.scope },
  };
}

/** Hai scope co cung "vung" block khong: khop userId + appId (bot/run khac nhau van share). */
export function scopesMatchForBlockV24(a: V24Scope, b: V24Scope): boolean {
  return a.userId === b.userId && a.appId === b.appId;
}

/** Export block ra Markdown: "# title\n\ncontent". */
export function blockToMarkdownV24(block: V24SharedBlock): string {
  return `# ${block.title}\n\n${block.content.trim()}\n`;
}

/** Import block tu Markdown (title = dong # dau tien). */
export function blockFromMarkdownV24(
  markdown: string,
  name: string,
  scope: V24Scope,
  createdBy?: string,
): { title: string; content: string } {
  const lines = markdown.split('\n');
  let title = name;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('# ')) {
      title = t.slice(2).trim() || name;
      bodyStart = i + 1;
      break;
    }
    if (t !== '') break;
  }
  void scope;
  void createdBy;
  return { title, content: lines.slice(bodyStart).join('\n').trim() };
}

/** Merge 3-way theo dong: base / mine / theirs -> {merged, conflicts}. */
export function mergeBlockContentsV24(
  base: string,
  mine: string,
  theirs: string,
): { merged: string; conflicts: number } {
  const baseLines = base.split('\n');
  const mineLines = new Set(mine.split('\n'));
  const theirsLines = new Set(theirs.split('\n'));
  const out: string[] = [];
  let conflicts = 0;
  const seen = new Set<string>();
  for (const line of baseLines) {
    const inMine = mineLines.has(line);
    const inTheirs = theirsLines.has(line);
    if (inMine && inTheirs) {
      if (!seen.has(line)) { out.push(line); seen.add(line); }
    } else if (inMine && !inTheirs) {
      // Theirs xoa dong nay, mine giu -> giu (theo rule giu ca 2 phia).
      if (!seen.has(line)) { out.push(line); seen.add(line); }
    } else if (!inMine && inTheirs) {
      if (!seen.has(line)) { out.push(line); seen.add(line); }
    }
    // Ca 2 deu xoa -> bo.
  }
  const mineOnly = mine.split('\n').filter((l) => !baseLines.includes(l));
  const theirsOnly = theirs.split('\n').filter((l) => !baseLines.includes(l));
  for (const line of mineOnly) {
    if (theirsOnly.includes(line)) {
      if (!seen.has(line)) { out.push(line); seen.add(line); }
    } else {
      // Dong chi mine co: them vao, danh dau conflict neu theirs co dong gan giong.
      const similar = theirsOnly.some((t) => t.trim() !== '' && line.trim() !== '' && (t.includes(line.trim().slice(0, 12)) || line.includes(t.trim().slice(0, 12))));
      if (similar) {
        conflicts++;
        out.push(`<<<<<<< mine\n${line}\n=======\n${theirsOnly.find((t) => t.includes(line.trim().slice(0, 12))) ?? ''}\n>>>>>>> theirs`);
      } else if (!seen.has(line)) {
        out.push(line);
        seen.add(line);
      }
    }
  }
  for (const line of theirsOnly) {
    if (!mineOnly.includes(line) && !seen.has(line)) {
      out.push(line);
      seen.add(line);
    }
  }
  return { merged: out.join('\n'), conflicts };
}
