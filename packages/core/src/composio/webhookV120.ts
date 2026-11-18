/**
 * Composio webhook v3 — receiver hardening: signature rotation,
 * replay protection manh hon, idempotency key, retry queue co
 * jitter + leo thang (v1.20, Doi T4).
 *
 * Tang tren webhookV119.ts — KHONG viet lai:
 * - `ComposioV119WebhookQueue` van la hang doi xu ly: FIFO,
 *   dedupe (eventId + deliveryId + hash body), retry co gioi
 *   han, dead-letter, replay theo tuoi event. V3 DUNG LAI queue
 *   do lam lop xu ly — v3 chi them lop NHAN (receiver) phia
 *   truoc queue.
 * - `verifyComposioWebhookSignature` / `parseComposioTriggerPayload`
 *   trong triggers.ts van la tang verify/parse goc.
 *
 * Moi trong v3 (lop receiver, truoc khi event vao queue v119):
 * 1. Signature verify voi key rotation: host co the cau hinh
 *    NHIEU secret (secret hien tai + secret cu trong thoi gian
 *    grace khi doi secret). Receiver thu tung secret theo thu
 *    tu moi → cu; secret nao verify duoc thi ghi lai `keyIndex`
 *    (de biet khi nao secret cu het luot dung). Doi secret
 *    khong lam rot delivery dang bay — bai hoc tu viec doi
 *    webhook secret o v0.89c.
 * 2. Replay protection manh hon v119: ngoai tuoi event (qua cu
 *    bi tu choi), v3 kiem tra CA chieu — timestamp TUONG LAI
 *    qua xa cung bi tu choi (ke xau khong the "dat truoc"
 *    delivery); nonce (`deliveryId` + timestamp) da thay trong
 *    cua so thi bi tu choi ngay ca khi body khac (v119 chi
 *    dedupe theo eventId/deliveryId/hash body — ke xau doi
 *    body van lot).
 * 3. Idempotency key: header `Idempotency-Key` (hoac field
 *    `idempotencyKey` trong payload) duoc luu kem KET QUA nhan
 *    (`accepted`/`duplicate`/ly do + queueId). Gui lai cung key
 *    thi tra ve ket qua CU ma khong enqueue them — client retry
 *    an toan. Store: memory + JSON file (mode 0600), co TTL
 *    (mac dinh 24h), prune khi day.
 * 4. Retry queue co jitter + leo thang: drain cua v3 boc queue
 *    v119 — delay retry them jitter (tranh nhieu trigger cung
 *    retry mot luc), theo doi so lan that bai lien tuc theo
 *    trigger; vuot nguong thi goi `onEscalate` MOT lan moi cua
 *    so (de host gui canh bao / tat trigger loi) thay vi retry
 *    mai trong im lang.
 *
 * Module nay KHONG chay automation va KHONG goi mang. Handler
 * that (chay automation theo event) do host cung cap nhu v119.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyComposioWebhookSignature, type ComposioTriggerEvent } from './triggers';
import {
  ComposioV119WebhookQueue,
  hashComposioV119WebhookBody,
  parseComposioV119EventTimestamp,
  type ComposioV119QueuedWebhookEvent,
  type ComposioV119WebhookAcceptResult,
  type ComposioV119WebhookHandler,
  type ComposioV119WebhookQueueOptions,
  type ComposioV119WebhookRejectReason,
} from './webhookV119';

/** File idempotency keys trong thu muc composio cua userData. */
export const COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_FILE = 'composio-webhook-idempotency-v120.json';
/** Phien ban dinh dang file idempotency. */
export const COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_VERSION = 1;
/** TTL mac dinh cua idempotency key (ms) — 24 gio. */
export const COMPOSIO_V120_DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** So idempotency key giu toi da. */
export const COMPOSIO_V120_DEFAULT_MAX_IDEMPOTENCY_KEYS = 10_000;
/** Do dai toi da cua idempotency key (ky tu). */
export const COMPOSIO_V120_MAX_IDEMPOTENCY_KEY_CHARS = 256;
/** Leech timestamp tuong lai toi da chap nhan (ms) — 5 phut. */
export const COMPOSIO_V120_DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Cua so nonce replay (ms) — 1 gio. */
export const COMPOSIO_V120_DEFAULT_NONCE_WINDOW_MS = 60 * 60 * 1000;
/** So nonce giu toi da. */
export const COMPOSIO_V120_DEFAULT_MAX_NONCES = 10_000;
/** Phan tram jitter ap len delay retry (0 = tat, de test xac dinh). */
export const COMPOSIO_V120_DEFAULT_RETRY_JITTER_FRACTION = 0.2;
/** So lan that bai lien tuc cua mot trigger thi leo thang (mac dinh). */
export const COMPOSIO_V120_DEFAULT_ESCALATION_AFTER_FAILURES = 5;
/** Cua so leo thang: moi trigger chi leo thang 1 lan moi khoang nay (ms) — 1 gio. */
export const COMPOSIO_V120_DEFAULT_ESCALATION_COOLDOWN_MS = 60 * 60 * 1000;
/** Dung sai timestamp khi verify chu ky (giay) — bang v119. */
export const COMPOSIO_V120_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Ly do tu choi them cua receiver v3 (mo rong ly do v119). */
export type ComposioV120WebhookRejectReason =
  | ComposioV119WebhookRejectReason
  | 'future-timestamp'
  | 'replay-nonce'
  | 'bad-idempotency-key';

/** Mot secret webhook (co the nhieu secret khi rotation). */
export interface ComposioV120WebhookSecret {
  /** Gia tri secret (host giu — KHONG log, KHONG dua vao error). */
  value: string;
  /** true = secret hien tai; false = secret cu trong grace. */
  current: boolean;
  /** Nhan de trace (vd '2026-11-16') — khong chua secret. */
  label?: string;
}

/** Cau hinh receiver webhook v3. */
export interface ComposioV120WebhookConfig {
  /** TTL idempotency key (ms). */
  idempotencyTtlMs: number;
  /** So idempotency key giu toi da. */
  maxIdempotencyKeys: number;
  /** Leech timestamp tuong lai toi da (ms). */
  maxFutureSkewMs: number;
  /** Cua so nonce replay (ms). */
  nonceWindowMs: number;
  /** So nonce giu toi da. */
  maxNonces: number;
  /** Phan tram jitter retry (0..0.5). */
  retryJitterFraction: number;
  /** So that bai lien tuc thi leo thang. */
  escalationAfterFailures: number;
  /** Cooldown leo thang moi trigger (ms). */
  escalationCooldownMs: number;
  /** Cau hinh queue v119 ben duoi. */
  queue: ComposioV119WebhookQueueOptions['config'];
}

/** Cau hinh mac dinh cua receiver v3. */
export const DEFAULT_COMPOSIO_V120_WEBHOOK_CONFIG: ComposioV120WebhookConfig = {
  idempotencyTtlMs: COMPOSIO_V120_DEFAULT_IDEMPOTENCY_TTL_MS,
  maxIdempotencyKeys: COMPOSIO_V120_DEFAULT_MAX_IDEMPOTENCY_KEYS,
  maxFutureSkewMs: COMPOSIO_V120_DEFAULT_MAX_FUTURE_SKEW_MS,
  nonceWindowMs: COMPOSIO_V120_DEFAULT_NONCE_WINDOW_MS,
  maxNonces: COMPOSIO_V120_DEFAULT_MAX_NONCES,
  retryJitterFraction: COMPOSIO_V120_DEFAULT_RETRY_JITTER_FRACTION,
  escalationAfterFailures: COMPOSIO_V120_DEFAULT_ESCALATION_AFTER_FAILURES,
  escalationCooldownMs: COMPOSIO_V120_DEFAULT_ESCALATION_COOLDOWN_MS,
  queue: undefined,
};

/** Kiem tra + chuan hoa cau hinh receiver v3 (throw neu sai). */
export function validateComposioV120WebhookConfig(
  raw: Partial<ComposioV120WebhookConfig> | undefined,
): ComposioV120WebhookConfig {
  const cfg: ComposioV120WebhookConfig = { ...DEFAULT_COMPOSIO_V120_WEBHOOK_CONFIG, ...(raw ?? {}) };
  if (!Number.isInteger(cfg.idempotencyTtlMs) || cfg.idempotencyTtlMs < 1) {
    throw new Error('webhook v3 config idempotencyTtlMs must be a positive integer');
  }
  if (!Number.isInteger(cfg.maxIdempotencyKeys) || cfg.maxIdempotencyKeys < 1) {
    throw new Error('webhook v3 config maxIdempotencyKeys must be a positive integer');
  }
  if (!Number.isInteger(cfg.maxFutureSkewMs) || cfg.maxFutureSkewMs < 0) {
    throw new Error('webhook v3 config maxFutureSkewMs must be a non-negative integer');
  }
  if (!Number.isInteger(cfg.nonceWindowMs) || cfg.nonceWindowMs < 1) {
    throw new Error('webhook v3 config nonceWindowMs must be a positive integer');
  }
  if (!Number.isInteger(cfg.maxNonces) || cfg.maxNonces < 1) {
    throw new Error('webhook v3 config maxNonces must be a positive integer');
  }
  if (typeof cfg.retryJitterFraction !== 'number' || cfg.retryJitterFraction < 0 || cfg.retryJitterFraction > 0.5) {
    throw new Error('webhook v3 config retryJitterFraction must be a number between 0 and 0.5');
  }
  if (!Number.isInteger(cfg.escalationAfterFailures) || cfg.escalationAfterFailures < 1) {
    throw new Error('webhook v3 config escalationAfterFailures must be a positive integer');
  }
  if (!Number.isInteger(cfg.escalationCooldownMs) || cfg.escalationCooldownMs < 0) {
    throw new Error('webhook v3 config escalationCooldownMs must be a non-negative integer');
  }
  return cfg;
}

/**
 * Verify chu ky voi DANH SACH secret (rotation): thu tung
 * secret theo thu tu truyen vao (moi → cu), tra ve index cua
 * secret verify duoc, hoac -1 khi khong secret nao khop. Ham
 * thuan (khong log secret).
 */
export function verifyComposioV120WebhookSignatureWithRotation(
  secrets: readonly string[],
  webhookId: string | null | undefined,
  timestamp: string | number | null | undefined,
  rawBody: string | Buffer,
  signature: string | null | undefined,
  opts?: { now?: Date; toleranceSeconds?: number },
): number {
  for (let i = 0; i < secrets.length; i += 1) {
    const secret = secrets[i];
    if (typeof secret !== 'string' || secret === '') continue;
    if (
      verifyComposioWebhookSignature(secret, webhookId, timestamp, rawBody, signature, {
        now: opts?.now,
        toleranceSeconds: opts?.toleranceSeconds ?? COMPOSIO_V120_WEBHOOK_TOLERANCE_SECONDS,
      })
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Kiem tra timestamp co lech qua xa khong: qua cu (vuot
 * maxAgeMs) hoac TUONG LAI qua xa (vuot maxFutureSkewMs) deu
 * la replay/khong hop le. Tra 'stale' | 'future' | null (ok).
 * Ham thuan.
 */
export function checkComposioV120TimestampSkew(
  eventAtMs: number | null,
  nowMs: number,
  maxAgeMs: number,
  maxFutureSkewMs: number,
): 'stale' | 'future' | null {
  if (eventAtMs === null) return null;
  if (nowMs - eventAtMs > maxAgeMs) return 'stale';
  if (eventAtMs - nowMs > maxFutureSkewMs) return 'future';
  return null;
}

/** Chuan hoa + kiem tra idempotency key (null = khong co key). */
export function normalizeComposioV120IdempotencyKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new Error('idempotency key must be a string');
  const key = raw.trim();
  if (key === '') return null;
  if (key.length > COMPOSIO_V120_MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new Error(`idempotency key must be at most ${COMPOSIO_V120_MAX_IDEMPOTENCY_KEY_CHARS} chars`);
  }
  return key;
}

/** Mot key idempotency da luu kem ket qua nhan. */
export interface ComposioV120IdempotencyEntry {
  key: string;
  accepted: boolean;
  reason: ComposioV120WebhookRejectReason | null;
  queueId: string | null;
  atMs: number;
}

/** Kiem tra mot entry idempotency (throw neu sai). */
export function validateComposioV120IdempotencyEntry(raw: unknown): ComposioV120IdempotencyEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV120IdempotencyEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['key'] !== 'string' || (rec['key'] as string).trim() === '') {
    throw new Error('idempotency entry key must be a non-empty string.');
  }
  if (typeof rec['accepted'] !== 'boolean') throw new Error('idempotency entry accepted must be a boolean.');
  if (
    rec['reason'] !== null &&
    typeof rec['reason'] !== 'string'
  ) {
    throw new Error('idempotency entry reason must be a string or null.');
  }
  if (rec['queueId'] !== null && typeof rec['queueId'] !== 'string') {
    throw new Error('idempotency entry queueId must be a string or null.');
  }
  if (typeof rec['atMs'] !== 'number' || !Number.isFinite(rec['atMs']) || (rec['atMs'] as number) < 0) {
    throw new Error('idempotency entry atMs must be a non-negative number.');
  }
  return {
    key: rec['key'] as string,
    accepted: rec['accepted'] as boolean,
    reason: rec['reason'] as ComposioV120WebhookRejectReason | null,
    queueId: rec['queueId'] as string | null,
    atMs: rec['atMs'] as number,
  };
}

/** Ket qua nhan delivery cua receiver v3. */
export interface ComposioV120WebhookAcceptResult {
  accepted: boolean;
  reason?: ComposioV120WebhookRejectReason;
  /** true = key idempotency da thay — tra ket qua cu, khong enqueue them. */
  idempotentReplay?: boolean;
  /** Index secret da verify duoc (-1 = khong verify / khong co secret). */
  verifiedKeyIndex?: number;
  event?: ComposioV119QueuedWebhookEvent;
  duplicate?: boolean;
}

/** Thong tin leo thang (mot trigger loi lien tuc). */
export interface ComposioV120WebhookEscalation {
  triggerSlug: string;
  consecutiveFailures: number;
  lastError: string;
  atMs: number;
}

/** Tuy chon cho receiver v3. */
export interface ComposioV120WebhookReceiverOptions {
  config?: Partial<ComposioV120WebhookConfig>;
  /** Secrets webhook theo thu tu moi → cu (doi secret khong rot delivery). */
  secrets?: ComposioV120WebhookSecret[] | readonly string[];
  /** Ham doi that giua cac lan retry (mac dinh: khong doi). */
  sleep?: (ms: number) => Promise<void>;
  /** Ham lay thoi gian hien tai (mac dinh Date.now). */
  now?: () => number;
  /** Ham random cho jitter retry (mac dinh Math.random). */
  random?: () => number;
  /** Callback khi mot trigger loi lien tuc vuot nguong (host gui canh bao). */
  onEscalate?: (escalation: ComposioV120WebhookEscalation) => void;
}

/**
 * Receiver webhook v3: verify (rotation) → chong replay (tuoi +
 * nonce) → idempotency key → queue v119. Queue v119 giu nguyen
 * trach nhiem dedupe/retry/dead-letter ben duoi.
 */
export class ComposioV120WebhookReceiver {
  private readonly config: ComposioV120WebhookConfig;
  private readonly queue: ComposioV119WebhookQueue;
  private readonly secrets: ComposioV120WebhookSecret[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly random: () => number;
  private readonly onEscalate: ((e: ComposioV120WebhookEscalation) => void) | undefined;
  private readonly idempotency: ComposioV120IdempotencyEntry[] = [];
  private readonly nonces: { nonce: string; atMs: number }[] = [];
  private readonly failuresByTrigger: Map<string, { count: number; lastError: string }> = new Map();
  private readonly escalatedAt: Map<string, number> = new Map();
  private totalIdempotentReplays = 0;
  private totalReplayNonces = 0;
  private totalFutureTimestamps = 0;

  constructor(options: ComposioV120WebhookReceiverOptions = {}) {
    this.config = validateComposioV120WebhookConfig(options.config);
    this.queue = new ComposioV119WebhookQueue({
      config: options.config?.queue,
      sleep: options.sleep,
      now: options.now,
    });
    const rawSecrets = options.secrets ?? [];
    this.secrets = rawSecrets.map((s, i) =>
      typeof s === 'string' ? { value: s, current: i === 0 } : s,
    );
    this.sleep = options.sleep ?? (async () => undefined);
    this.nowFn = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.onEscalate = options.onEscalate;
  }

  /** Cau hinh dang dung (ban sao — khong lo secret). */
  getConfig(): ComposioV120WebhookConfig {
    return { ...this.config, queue: { ...this.config.queue } };
  }

  /** Queue v119 ben duoi (de host drain/list truc tiep khi can). */
  getQueue(): ComposioV119WebhookQueue {
    return this.queue;
  }

  /** So secret da cau hinh (khong lo gia tri). */
  getSecretCount(): number {
    return this.secrets.length;
  }

  /** Them secret moi len dau danh sach (rotation): secret cu xuong hang sau, van verify duoc. */
  addSecret(secret: ComposioV120WebhookSecret): void {
    if (typeof secret.value !== 'string' || secret.value === '') {
      throw new Error('webhook secret value must be a non-empty string');
    }
    this.secrets.unshift({ ...secret, current: true });
    for (let i = 1; i < this.secrets.length; i += 1) {
      const s = this.secrets[i];
      if (s) s.current = false;
    }
  }

  private pruneIdempotency(nowMs: number): void {
    const cutoff = nowMs - this.config.idempotencyTtlMs;
    const kept = this.idempotency.filter((e) => e.atMs >= cutoff);
    this.idempotency.splice(0, this.idempotency.length, ...kept);
  }

  private pruneNonces(nowMs: number): void {
    const cutoff = nowMs - this.config.nonceWindowMs;
    const kept = this.nonces.filter((n) => n.atMs >= cutoff);
    this.nonces.splice(0, this.nonces.length, ...kept);
  }

  /** Lay entry idempotency theo key (null khi chua co / het han). */
  getIdempotencyEntry(key: string, nowMs?: number): ComposioV120IdempotencyEntry | null {
    const now = nowMs ?? this.nowFn();
    this.pruneIdempotency(now);
    const found = this.idempotency.find((e) => e.key === key);
    return found ? { ...found } : null;
  }

  private recordIdempotency(
    key: string,
    accepted: boolean,
    reason: ComposioV120WebhookRejectReason | null,
    queueId: string | null,
    nowMs: number,
  ): void {
    this.pruneIdempotency(nowMs);
    this.idempotency.push({ key, accepted, reason, queueId, atMs: nowMs });
    if (this.idempotency.length > this.config.maxIdempotencyKeys) {
      this.idempotency.splice(0, this.idempotency.length - this.config.maxIdempotencyKeys);
    }
  }

  /**
   * Nhan mot delivery: verify chu ky (rotation) → kiem tra tuoi
   * + nonce (replay) → idempotency key → enqueue vao queue
   * v119. Khong bao gio nem (tra ly do tu choi de host log).
   * Luu y: secret duoc truyen qua `secrets` luc khoi tao (hoac
   * `addSecret`); `secret` trong input chi dung khi host muon
   * verify bang 1 secret rieng cho delivery nay.
   */
  accept(input: {
    rawBody: string | Buffer;
    signature?: string;
    timestamp?: string;
    secret?: string | null;
    deliveryId?: string | null;
    idempotencyKey?: string | null;
    receivedAtMs?: number;
  }): ComposioV120WebhookAcceptResult {
    const nowMs = input.receivedAtMs ?? this.nowFn();
    const bodyHash = hashComposioV119WebhookBody(input.rawBody);

    // 1. Idempotency key: da thay thi tra ket qua cu, khong xu ly lai.
    let idemKey: string | null = null;
    try {
      idemKey = normalizeComposioV120IdempotencyKey(input.idempotencyKey ?? null);
    } catch {
      return { accepted: false, reason: 'bad-idempotency-key' };
    }
    if (idemKey !== null) {
      const prev = this.getIdempotencyEntry(idemKey, nowMs);
      if (prev !== null) {
        this.totalIdempotentReplays += 1;
        const replay: ComposioV120WebhookAcceptResult = {
          accepted: prev.accepted,
          idempotentReplay: true,
          verifiedKeyIndex: -1,
        };
        if (prev.reason !== null) replay.reason = prev.reason;
        if (prev.queueId !== null) {
          const event = this.queue.getEvent(prev.queueId);
          if (event) replay.event = event;
        }
        return replay;
      }
    }

    // 2. Verify chu ky (rotation): thu tung secret.
    let verifiedKeyIndex = -1;
    const secretValues =
      input.secret !== undefined && input.secret !== null
        ? [input.secret]
        : this.secrets.map((s) => s.value);
    if (input.signature !== undefined && secretValues.length > 0) {
      verifiedKeyIndex = verifyComposioV120WebhookSignatureWithRotation(
        secretValues,
        input.deliveryId ?? null,
        input.timestamp ?? '',
        input.rawBody,
        input.signature,
        { now: new Date(nowMs), toleranceSeconds: COMPOSIO_V120_WEBHOOK_TOLERANCE_SECONDS },
      );
      if (verifiedKeyIndex < 0) {
        if (idemKey !== null) this.recordIdempotency(idemKey, false, 'bad-signature', null, nowMs);
        return { accepted: false, reason: 'bad-signature', verifiedKeyIndex: -1 };
      }
    }

    // 3. Replay protection: timestamp trong envelope (ca 2 chieu)
    // + nonce (deliveryId + timestamp) da thay trong cua so.
    let eventAtMs: number | null = null;
    try {
      const parsed = JSON.parse(
        typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8'),
      ) as Record<string, unknown>;
      const metadata = parsed['metadata'];
      const metaTs =
        typeof metadata === 'object' && metadata !== null
          ? (metadata as Record<string, unknown>)['timestamp']
          : undefined;
      // Timestamp nam o top-level envelope (obj.timestamp); chi
      // dung metadata.timestamp khi top-level khong co.
      const ts = parsed['timestamp'] ?? metaTs;
      eventAtMs = typeof ts === 'string' ? parseComposioV119EventTimestamp(ts) : null;
    } catch {
      // Body hong — de queue v119 bao bad-payload ben duoi.
      eventAtMs = null;
    }
    const queueCfg = this.queue.getConfig();
    const skew = checkComposioV120TimestampSkew(
      eventAtMs,
      nowMs,
      queueCfg.maxEventAgeMs,
      this.config.maxFutureSkewMs,
    );
    if (skew === 'future') {
      this.totalFutureTimestamps += 1;
      if (idemKey !== null) this.recordIdempotency(idemKey, false, 'future-timestamp', null, nowMs);
      return { accepted: false, reason: 'future-timestamp', verifiedKeyIndex };
    }
    if (skew === 'stale') {
      if (idemKey !== null) this.recordIdempotency(idemKey, false, 'stale-event', null, nowMs);
      return { accepted: false, reason: 'stale-event', verifiedKeyIndex };
    }

    const nonce = `${input.deliveryId ?? ''}|${input.timestamp ?? ''}|${bodyHash.slice(0, 16)}`;
    this.pruneNonces(nowMs);
    if (this.nonces.some((n) => n.nonce === nonce)) {
      this.totalReplayNonces += 1;
      if (idemKey !== null) this.recordIdempotency(idemKey, false, 'replay-nonce', null, nowMs);
      return { accepted: false, reason: 'replay-nonce', duplicate: true, verifiedKeyIndex };
    }
    this.nonces.push({ nonce, atMs: nowMs });
    if (this.nonces.length > this.config.maxNonces) {
      this.nonces.splice(0, this.nonces.length - this.config.maxNonces);
    }

    // 4. Dua vao queue v119 (dedupe + enqueue + bad-payload o day).
    const result: ComposioV119WebhookAcceptResult = this.queue.accept({
      rawBody: input.rawBody,
      // Chu ky da verify o lop v3 — khong verify lai (tranh loi
      // khi deliveryId null): truyen secret null de bo qua.
      secret: null,
      deliveryId: input.deliveryId ?? null,
      receivedAtMs: nowMs,
    });
    const v3: ComposioV120WebhookAcceptResult = {
      accepted: result.accepted,
      verifiedKeyIndex,
    };
    if (result.reason !== undefined) v3.reason = result.reason;
    if (result.event !== undefined) v3.event = result.event;
    if (result.duplicate === true) v3.duplicate = true;
    if (idemKey !== null) {
      this.recordIdempotency(
        idemKey,
        result.accepted,
        (result.reason as ComposioV120WebhookRejectReason | undefined) ?? null,
        result.event?.queueId ?? null,
        nowMs,
      );
    }
    return v3;
  }

  /** Delay retry co jitter (ham thuan): base * (1 ± fraction). */
  retryDelayWithJitterMs(baseMs: number, random: () => number = Math.random): number {
    const f = this.config.retryJitterFraction;
    if (f <= 0) return Math.max(0, Math.round(baseMs));
    const jitter = baseMs * f * (random() * 2 - 1);
    return Math.max(0, Math.round(baseMs + jitter));
  }

  /**
   * Drain queue v119 (xu ly event den han) + leo thang: trigger
   * nao that bai lien tuc vuot nguong thi goi `onEscalate` 1 lan
   * moi cooldown. Tra so event da xu ly. Truoc moi lan goi
   * handler, neu event dang cho retry thi doi them jitter
   * (tranh nhieu trigger cung retry mot luc) — jitter chi ap
   * khi event da tung that bai (attempts > 0).
   */
  async drain(handler: ComposioV119WebhookHandler, nowMs?: number): Promise<number> {
    const now = nowMs ?? this.nowFn();
    const wrapped: ComposioV119WebhookHandler = async (event) => {
      if (event.attempts > 0 && this.config.retryJitterFraction > 0) {
        await this.sleep(this.retryDelayWithJitterMs(100, this.random));
      }
      try {
        await handler(event);
        this.failuresByTrigger.delete(event.triggerSlug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const prev = this.failuresByTrigger.get(event.triggerSlug) ?? { count: 0, lastError: '' };
        const count = prev.count + 1;
        this.failuresByTrigger.set(event.triggerSlug, { count, lastError: message });
        if (count >= this.config.escalationAfterFailures) {
          const lastEscalatedAt = this.escalatedAt.get(event.triggerSlug);
          if (lastEscalatedAt === undefined || now - lastEscalatedAt >= this.config.escalationCooldownMs) {
            this.escalatedAt.set(event.triggerSlug, now);
            this.onEscalate?.({ triggerSlug: event.triggerSlug, consecutiveFailures: count, lastError: message, atMs: now });
          }
        }
        throw err;
      }
    };
    return this.queue.drain(wrapped, now);
  }

  /** Thong ke receiver v3 (gom ca queue v119). */
  summarize(): ReturnType<ComposioV119WebhookQueue['summarize']> & {
    idempotentReplays: number;
    replayNonces: number;
    futureTimestamps: number;
    idempotencyKeys: number;
    escalatedTriggers: number;
  } {
    const q = this.queue.summarize();
    return {
      ...q,
      idempotentReplays: this.totalIdempotentReplays,
      replayNonces: this.totalReplayNonces,
      futureTimestamps: this.totalFutureTimestamps,
      idempotencyKeys: this.idempotency.length,
      escalatedTriggers: this.escalatedAt.size,
    };
  }

  /** Xoa sach receiver (de test). */
  clear(): void {
    this.queue.clear();
    this.idempotency.length = 0;
    this.nonces.length = 0;
    this.failuresByTrigger.clear();
    this.escalatedAt.clear();
    this.totalIdempotentReplays = 0;
    this.totalReplayNonces = 0;
    this.totalFutureTimestamps = 0;
  }
}

// ---------------------------------------------------------------------------
// Store idempotency tren dia (memory + JSON file atomic, mode 0600)
// ---------------------------------------------------------------------------

/** Interface store idempotency. */
export interface ComposioV120IdempotencyStore {
  load(): ComposioV120IdempotencyEntry[];
  save(entries: ComposioV120IdempotencyEntry[]): void;
  clear(): void;
}

/** Duong dan file idempotency. */
export function getComposioV120IdempotencyPath(dir: string): string {
  return path.join(dir, COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_FILE);
}

/** Store trong bo nho — de test + host khong co userData dir. */
export class MemoryComposioV120IdempotencyStore implements ComposioV120IdempotencyStore {
  private entries: ComposioV120IdempotencyEntry[] = [];

  load(): ComposioV120IdempotencyEntry[] {
    return JSON.parse(JSON.stringify(this.entries)) as ComposioV120IdempotencyEntry[];
  }

  save(entries: ComposioV120IdempotencyEntry[]): void {
    const valid = entries.map((e) => validateComposioV120IdempotencyEntry(e));
    this.entries = JSON.parse(JSON.stringify(valid)) as ComposioV120IdempotencyEntry[];
  }

  clear(): void {
    this.entries = [];
  }
}

/** Store tren dia (file JSON atomic, mode 0600). */
export class JsonFileComposioV120IdempotencyStore implements ComposioV120IdempotencyStore {
  private readonly filePath: string;

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('idempotency store dir must be a non-empty string');
    }
    this.filePath = getComposioV120IdempotencyPath(dir);
  }

  /** Duong dan file dang dung (de UI/log hien). */
  get path(): string {
    return this.filePath;
  }

  load(): ComposioV120IdempotencyEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('idempotency file must be an object.');
    }
    const rec = raw as Record<string, unknown>;
    if (rec['version'] !== COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_VERSION) {
      throw new Error(`unsupported idempotency file version: ${JSON.stringify(rec['version'])}`);
    }
    if (!Array.isArray(rec['entries'])) throw new Error('idempotency file entries must be an array.');
    return (rec['entries'] as unknown[]).map((e) => validateComposioV120IdempotencyEntry(e));
  }

  save(entries: ComposioV120IdempotencyEntry[]): void {
    const valid = entries.map((e) => validateComposioV120IdempotencyEntry(e));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: COMPOSIO_V120_WEBHOOK_IDEMPOTENCY_VERSION, entries: valid }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows khong co chmod unix — bo qua.
    }
  }

  clear(): void {
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }
}

/** Tom tat receiver v3 (1 dong) cho UI/log. */
export function summarizeComposioV120WebhookReceiver(receiver: ComposioV120WebhookReceiver): string {
  const s = receiver.summarize();
  return `webhook v3: ${s.queued} queued, ${s.done} done, ${s.deadLetters} dead-letter, ${s.idempotentReplays} idempotent replays, ${s.replayNonces} replay nonces blocked, ${s.futureTimestamps} future timestamps rejected.`;
}

/** Re-export kieu queue v119 ma host v3 hay dung kem (de import 1 cho). */
export type { ComposioV119QueuedWebhookEvent, ComposioV119WebhookHandler };
