/**
 * Memory v26 — per-bot quota (v1.41, Doi T1).
 *
 * 1 bot khong duoc chiem het memory: gioi han so block 1 bot
 * duoc so huu, so block duoc attach, tong token/ky tu tren cac
 * block bot so huu. Quota mac dinh rong rai (50 block so huu /
 * 200 attach / 50k token / 200k ky tu) — chi chong lam dung
 * (vd vong lap agent tao block lien tuc), khong lam kho bot
 * binh thuong.
 *
 * Kiem tra o 2 diem: truoc khi tao block (so block so huu) va
 * truoc khi ghi (tong token/ky tu sau khi ghi). Attach vuot
 * gioi han thi bi tu choi — bot phai detach block cu truoc.
 *
 * Chay 100% local, khong goi model/mang.
 */
import {
  V26_DEFAULT_QUOTA,
  estimateTokensV26,
  validateQuotaV26,
  type V26BotQuota,
  type V26BotQuotaUsage,
  type V26Result,
} from './types';
import { errV26, okV26 } from './types';

/** 1 block toi thieu de tinh quota (id/label/value/owner). */
export interface V26QuotaBlockView {
  id: string;
  ownerBotId: string;
  attachedBotIds: string[];
  value: string;
}

/** Quan ly quota (1 quota chung cho moi bot, sua duoc). */
export class V26QuotaManager {
  private quota: V26BotQuota = { ...V26_DEFAULT_QUOTA };

  /** Lay quota hien tai. */
  getQuota(): V26BotQuota {
    return { ...this.quota };
  }

  /** Doi quota (kiem tra hop le). */
  setQuota(partial: Partial<V26BotQuota>): V26Result<V26BotQuota> {
    const merged: V26BotQuota = { ...this.quota, ...partial };
    const err = validateQuotaV26(merged);
    if (err) return errV26(err);
    this.quota = merged;
    return okV26({ ...this.quota });
  }

  /**
   * Tinh muc su dung quota cua 1 bot tren danh sach block hien
   * tai. `over` liet ke cac gioi han dang vuot (vd
   * "maxOwnedBlocks", "maxOwnedTokens").
   */
  usage(botId: string, blocks: V26QuotaBlockView[]): V26BotQuotaUsage {
    let ownedBlocks = 0;
    let attachedBlocks = 0;
    let ownedTokens = 0;
    let ownedChars = 0;
    for (const b of blocks) {
      const attached = b.ownerBotId === botId || b.attachedBotIds.includes(botId);
      if (attached) attachedBlocks++;
      if (b.ownerBotId === botId) {
        ownedBlocks++;
        ownedTokens += estimateTokensV26(b.value);
        ownedChars += b.value.length;
      }
    }
    const over: string[] = [];
    const ratios: number[] = [];
    const check = (name: string, used: number, limit: number): void => {
      if (limit > 0) {
        ratios.push(used / limit);
        if (used > limit) over.push(name);
      } else {
        ratios.push(0);
      }
    };
    check('maxOwnedBlocks', ownedBlocks, this.quota.maxOwnedBlocks);
    check('maxAttachedBlocks', attachedBlocks, this.quota.maxAttachedBlocks);
    check('maxOwnedTokens', ownedTokens, this.quota.maxOwnedTokens);
    check('maxOwnedChars', ownedChars, this.quota.maxOwnedChars);
    return {
      botId,
      ownedBlocks,
      attachedBlocks,
      ownedTokens,
      ownedChars,
      quota: { ...this.quota },
      over,
      maxUsageRatio: Math.round(Math.max(0, ...ratios) * 1000) / 1000,
    };
  }

  /**
   * Bot co duoc tao them 1 block khong? Tra loi neu vuot
   * maxOwnedBlocks (so block so huu hien tai + 1).
   */
  checkCreate(botId: string, blocks: V26QuotaBlockView[]): V26Result<void> {
    const u = this.usage(botId, blocks);
    if (u.ownedBlocks + 1 > this.quota.maxOwnedBlocks) {
      return errV26(
        `Bot "${botId}" da so huu ${u.ownedBlocks}/${this.quota.maxOwnedBlocks} block — khong tao them duoc (xoa hoac chuyen owner block cu truoc).`,
      );
    }
    return okV26(undefined);
  }

  /**
   * Bot co duoc attach them 1 block khong?
   */
  checkAttach(botId: string, blocks: V26QuotaBlockView[]): V26Result<void> {
    const u = this.usage(botId, blocks);
    if (u.attachedBlocks + 1 > this.quota.maxAttachedBlocks) {
      return errV26(
        `Bot "${botId}" da attach ${u.attachedBlocks}/${this.quota.maxAttachedBlocks} block — khong attach them duoc (detach block cu truoc).`,
      );
    }
    return okV26(undefined);
  }

  /**
   * Ghi gia tri moi co lam bot vuot quota token/ky tu khong?
   * `newValue` la gia tri sau khi ghi; cac block khac giu nguyen.
   */
  checkWrite(
    botId: string,
    blocks: V26QuotaBlockView[],
    blockId: string,
    newValue: string,
  ): V26Result<void> {
    let ownedTokens = 0;
    let ownedChars = 0;
    for (const b of blocks) {
      if (b.ownerBotId !== botId) continue;
      if (b.id === blockId) {
        ownedTokens += estimateTokensV26(newValue);
        ownedChars += newValue.length;
      } else {
        ownedTokens += estimateTokensV26(b.value);
        ownedChars += b.value.length;
      }
    }
    if (this.quota.maxOwnedTokens > 0 && ownedTokens > this.quota.maxOwnedTokens) {
      return errV26(
        `Ghi nay lam bot "${botId}" vuot quota token so huu (${ownedTokens}/${this.quota.maxOwnedTokens} token) — curate bot block cu truoc.`,
      );
    }
    if (this.quota.maxOwnedChars > 0 && ownedChars > this.quota.maxOwnedChars) {
      return errV26(
        `Ghi nay lam bot "${botId}" vuot quota ky tu so huu (${ownedChars}/${this.quota.maxOwnedChars} ky tu) — curate bot block cu truoc.`,
      );
    }
    return okV26(undefined);
  }

  toJSON(): V26BotQuota {
    return { ...this.quota };
  }

  static fromJSON(data: unknown): V26QuotaManager {
    const manager = new V26QuotaManager();
    if (!data || typeof data !== 'object') return manager;
    const raw = data as Partial<V26BotQuota>;
    const err = validateQuotaV26(raw);
    if (!err) manager.quota = { ...V26_DEFAULT_QUOTA, ...raw };
    return manager;
  }
}
