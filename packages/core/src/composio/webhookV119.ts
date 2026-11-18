/**
 * Composio webhook v2 — hang doi xu ly + dedup + dead-letter
 * (v1.19, Doi T4).
 *
 * Tang tren webhookIngestV118.ts — KHONG viet lai:
 * - `ComposioV118WebhookIngester` van la cho nhan delivery: chi
 *   nhan loopback, verify chu ky HMAC (hoac token fallback),
 *   parse V3 envelope, route toi trigger instance da dang ky,
 *   dedupe theo eventId, ghi log. V2 KHONG thay the ingester —
 *   v2 nhan event DA VERIFY tu ingester roi dua vao HANG DOI
 *   xu ly.
 * - `verifyComposioWebhookSignature` / `parseComposioTriggerPayload`
 *   trong triggers.ts van la tang verify/parse goc.
 *
 * Moi trong v2:
 * 1. Hang doi xu ly (processing queue): event da verify duoc
 *    enqueue (FIFO, gioi han `maxQueueSize` — day thi tu choi
 *    event moi nhat voi ly do `queue-full`, khong lam mat event
 *    cu). Worker xu ly tuan tu (`concurrency` mac dinh 1 — giu
 *    thu tu event cua cung trigger; co the tang len toi da 4).
 * 2. Retry khi handler loi: moi event duoc thu toi da
 *    `maxAttempts` lan, moi lan cach nhau delay tang dan (cap o
 *    maxRetryDelayMs). Het luot thi event vao DEAD-LETTER (giu
 *    lai de kiem tra tay, khong xoa lang).
 * 3. Dedup manh hon v118: ngoai eventId, v2 con dedup theo
 *    `deliveryId` (header `webhook-id` — Composio retry cung
 *    delivery) + theo hash body (cung noi dung gui 2 lan voi id
 *    khac nhau van bi bat). Cua so dedup co the cau hinh (mac
 *    dinh 24h).
 * 4. Replay protection: event co timestamp qua cu (vuot qua
 *    `maxEventAgeMs`, mac dinh 10 phut) thi bi tu choi ngay
 *    (`stale`) — tranh ke xau gui lai delivery cu da danh cap.
 * 5. Dead-letter queue: event het luot retry nam o day voi ly do
 *    loi cuoi + so lan thu; host co the `requeue` (dua lai vao
 *    hang doi) hoac `discard` (xoa han). Dead-letter co cap
 *    (`maxDeadLetters`) — day thi event cu nhat bi xoa de nhuong
 *    cho (co ghi log).
 * 6. Thong ke hang doi: so event dang cho, dang xu ly, da xu ly
 *    thanh cong/that bai, dead-letter, thoi gian xu ly trung
 *    binh — de UI + usage metering dem dung.
 *
 * Module nay KHONG chay automation va KHONG goi mang: no chi
 * verify (lai, phong thu sau) + dedupe + queue + retry + log.
 * Handler that (chay automation theo event) do host cung cap.
 */

import * as crypto from 'node:crypto';
import {
  parseComposioTriggerPayload,
  verifyComposioWebhookSignature,
  type ComposioTriggerEvent,
} from './triggers';

/** Phien ban dinh dang queue state v119 (de migrate sau nay). */
export const COMPOSIO_V119_WEBHOOK_STATE_VERSION = 1;
/** So event toi da trong hang doi (mac dinh). */
export const COMPOSIO_V119_DEFAULT_MAX_QUEUE_SIZE = 500;
/** So worker xu ly song song mac dinh (1 = giu thu tu). */
export const COMPOSIO_V119_DEFAULT_CONCURRENCY = 1;
/** So worker toi da cho phep. */
export const COMPOSIO_V119_MAX_CONCURRENCY = 4;
/** So lan xu ly toi da moi event (mac dinh). */
export const COMPOSIO_V119_DEFAULT_MAX_ATTEMPTS = 3;
/** Delay co so giua cac lan retry (ms). */
export const COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS = 2000;
/** He so nhan delay moi lan retry. */
export const COMPOSIO_V119_DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;
/** Delay retry toi da (ms). */
export const COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
/** Cua so dedup event mac dinh: 24 gio. */
export const COMPOSIO_V119_DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Tuoi event toi da chap nhan (ms) — qua thi `stale`. */
export const COMPOSIO_V119_DEFAULT_MAX_EVENT_AGE_MS = 10 * 60 * 1000;
/** So dead-letter giu toi da. */
export const COMPOSIO_V119_DEFAULT_MAX_DEAD_LETTERS = 200;
/** Dung sai timestamp khi verify chu ky (giay) — bang triggers.ts. */
export const COMPOSIO_V119_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Trang thai cua mot event trong hang doi. */
export type ComposioV119WebhookEventStatus =
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'dead-letter'
  | 'duplicate'
  | 'stale'
  | 'rejected';

/** Ly do tu choi / that bai cua mot event. */
export type ComposioV119WebhookRejectReason =
  | 'bad-signature'
  | 'bad-payload'
  | 'queue-full'
  | 'stale-event'
  | 'duplicate-event'
  | 'handler-error'
  | 'not-loopback';

/** Mot event webhook da verify, nam trong hang doi. */
export interface ComposioV119QueuedWebhookEvent {
  /** Id duy nhat cua event trong queue (de theo doi). */
  queueId: string;
  /** Id event Composio (de dedupe). */
  eventId: string;
  /** Id delivery (`webhook-id` header, de dedupe retry). */
  deliveryId: string | null;
  /** Hash SHA-256 cua body tho (de dedupe theo noi dung). */
  bodyHash: string;
  /** Trigger slug cua event. */
  triggerSlug: string;
  /** Trigger instance id (neu route duoc). */
  triggerId: string | null;
  /** ms epoch event duoc nhan. */
  receivedAtMs: number;
  /** ms epoch event (timestamp trong envelope, neu co). */
  eventAtMs: number | null;
  /** Trang thai hien tai. */
  status: ComposioV119WebhookEventStatus;
  /** So lan da thu xu ly. */
  attempts: number;
  /** ms epoch lan thu ke tiep (neu dang cho retry). */
  nextAttemptAtMs: number | null;
  /** Loi cua lan thu cuoi (null neu chua loi). */
  lastError: string | null;
  /** Du lieu event (da parse — khong chua secret). */
  payload: ComposioTriggerEvent;
}

/** Mot dead-letter (event het luot retry). */
export interface ComposioV119DeadLetter {
  queueId: string;
  eventId: string;
  triggerSlug: string;
  triggerId: string | null;
  attempts: number;
  lastError: string;
  receivedAtMs: number;
  deadAtMs: number;
  payload: ComposioTriggerEvent;
}

/** Cau hinh webhook v2. */
export interface ComposioV119WebhookConfig {
  maxQueueSize: number;
  concurrency: number;
  maxAttempts: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  maxRetryDelayMs: number;
  dedupeWindowMs: number;
  maxEventAgeMs: number;
  maxDeadLetters: number;
}

/** Cau hinh mac dinh cua webhook v2. */
export const DEFAULT_COMPOSIO_V119_WEBHOOK_CONFIG: ComposioV119WebhookConfig = {
  maxQueueSize: COMPOSIO_V119_DEFAULT_MAX_QUEUE_SIZE,
  concurrency: COMPOSIO_V119_DEFAULT_CONCURRENCY,
  maxAttempts: COMPOSIO_V119_DEFAULT_MAX_ATTEMPTS,
  retryDelayMs: COMPOSIO_V119_DEFAULT_RETRY_DELAY_MS,
  retryBackoffMultiplier: COMPOSIO_V119_DEFAULT_RETRY_BACKOFF_MULTIPLIER,
  maxRetryDelayMs: COMPOSIO_V119_DEFAULT_MAX_RETRY_DELAY_MS,
  dedupeWindowMs: COMPOSIO_V119_DEFAULT_DEDUPE_WINDOW_MS,
  maxEventAgeMs: COMPOSIO_V119_DEFAULT_MAX_EVENT_AGE_MS,
  maxDeadLetters: COMPOSIO_V119_DEFAULT_MAX_DEAD_LETTERS,
};

/** Kiem tra + chuan hoa cau hinh webhook v2 (throw neu sai). */
export function validateComposioV119WebhookConfig(
  raw: Partial<ComposioV119WebhookConfig> | undefined,
): ComposioV119WebhookConfig {
  const cfg: ComposioV119WebhookConfig = { ...DEFAULT_COMPOSIO_V119_WEBHOOK_CONFIG, ...(raw ?? {}) };
  if (!Number.isInteger(cfg.maxQueueSize) || cfg.maxQueueSize < 1) {
    throw new Error('webhook config maxQueueSize must be a positive integer');
  }
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > COMPOSIO_V119_MAX_CONCURRENCY) {
    throw new Error(`webhook config concurrency must be an integer between 1 and ${COMPOSIO_V119_MAX_CONCURRENCY}`);
  }
  if (!Number.isInteger(cfg.maxAttempts) || cfg.maxAttempts < 1) {
    throw new Error('webhook config maxAttempts must be a positive integer');
  }
  if (!Number.isInteger(cfg.retryDelayMs) || cfg.retryDelayMs < 0) {
    throw new Error('webhook config retryDelayMs must be a non-negative integer');
  }
  if (typeof cfg.retryBackoffMultiplier !== 'number' || cfg.retryBackoffMultiplier < 1) {
    throw new Error('webhook config retryBackoffMultiplier must be a number >= 1');
  }
  if (!Number.isInteger(cfg.maxRetryDelayMs) || cfg.maxRetryDelayMs < cfg.retryDelayMs) {
    throw new Error('webhook config maxRetryDelayMs must be an integer >= retryDelayMs');
  }
  if (!Number.isInteger(cfg.dedupeWindowMs) || cfg.dedupeWindowMs < 1) {
    throw new Error('webhook config dedupeWindowMs must be a positive integer');
  }
  if (!Number.isInteger(cfg.maxEventAgeMs) || cfg.maxEventAgeMs < 1) {
    throw new Error('webhook config maxEventAgeMs must be a positive integer');
  }
  if (!Number.isInteger(cfg.maxDeadLetters) || cfg.maxDeadLetters < 1) {
    throw new Error('webhook config maxDeadLetters must be a positive integer');
  }
  return cfg;
}

/** Hash SHA-256 cua body tho (hex) — de dedupe theo noi dung. */
export function hashComposioV119WebhookBody(rawBody: string | Buffer): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Parse timestamp cua event ve epoch ms: epoch giay dang string
 * ("1730000000") → *1000, ISO string → Date.parse, khong parse
 * duoc → null.
 */
export function parseComposioV119EventTimestamp(timestamp: string | undefined): number | null {
  if (typeof timestamp !== 'string' || timestamp.trim() === '') return null;
  const text = timestamp.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Delay truoc lan retry thu `attempt` (0-based): delay co so nhan
 * he so mu, cap o max. Ham thuan.
 */
export function composioV119WebhookRetryDelayMs(
  attempt: number,
  config: ComposioV119WebhookConfig,
): number {
  if (attempt < 0) throw new Error('webhook retry attempt must be a non-negative integer');
  return Math.min(
    config.retryDelayMs * Math.pow(config.retryBackoffMultiplier, attempt),
    config.maxRetryDelayMs,
  );
}

/** Kiem tra mot event da verify co hop le khong (throw neu sai). */
export function validateComposioV119QueuedWebhookEvent(raw: unknown): ComposioV119QueuedWebhookEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV119QueuedWebhookEvent must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['queueId'] !== 'string' || (rec['queueId'] as string).trim() === '') throw new Error('event queueId must be a non-empty string.');
  if (typeof rec['eventId'] !== 'string' || (rec['eventId'] as string).trim() === '') throw new Error('event eventId must be a non-empty string.');
  if (rec['deliveryId'] !== null && typeof rec['deliveryId'] !== 'string') throw new Error('event deliveryId must be a string or null.');
  if (typeof rec['bodyHash'] !== 'string' || (rec['bodyHash'] as string).trim() === '') throw new Error('event bodyHash must be a non-empty string.');
  if (typeof rec['triggerSlug'] !== 'string' || (rec['triggerSlug'] as string).trim() === '') throw new Error('event triggerSlug must be a non-empty string.');
  if (rec['triggerId'] !== null && typeof rec['triggerId'] !== 'string') throw new Error('event triggerId must be a string or null.');
  if (typeof rec['receivedAtMs'] !== 'number' || !Number.isFinite(rec['receivedAtMs']) || (rec['receivedAtMs'] as number) < 0) throw new Error('event receivedAtMs must be a non-negative number.');
  if (rec['eventAtMs'] !== null && (typeof rec['eventAtMs'] !== 'number' || !Number.isFinite(rec['eventAtMs']))) throw new Error('event eventAtMs must be null or a number.');
  const statuses: readonly string[] = ['queued', 'processing', 'done', 'failed', 'dead-letter', 'duplicate', 'stale', 'rejected'];
  if (typeof rec['status'] !== 'string' || !statuses.includes(rec['status'])) throw new Error('event status is invalid.');
  if (!Number.isInteger(rec['attempts']) || (rec['attempts'] as number) < 0) throw new Error('event attempts must be a non-negative integer.');
  if (rec['nextAttemptAtMs'] !== null && (typeof rec['nextAttemptAtMs'] !== 'number' || !Number.isFinite(rec['nextAttemptAtMs']))) throw new Error('event nextAttemptAtMs must be null or a number.');
  if (rec['lastError'] !== null && typeof rec['lastError'] !== 'string') throw new Error('event lastError must be a string or null.');
  if (typeof rec['payload'] !== 'object' || rec['payload'] === null || Array.isArray(rec['payload'])) throw new Error('event payload must be an object.');
  return rec as unknown as ComposioV119QueuedWebhookEvent;
}

/** Ket qua nhan mot delivery (truoc khi vao queue). */
export interface ComposioV119WebhookAcceptResult {
  accepted: boolean;
  /** Ly do khi khong nhan (undefined khi nhan). */
  reason?: ComposioV119WebhookRejectReason;
  /** Event trong queue (khi nhan) hoac event bi danh dau duplicate/stale (khi khong nhan). */
  event?: ComposioV119QueuedWebhookEvent;
  /** true khi event nay da thay truoc do (dedupe). */
  duplicate?: boolean;
}

/** Handler xu ly mot event (do host cung cap — chay automation). */
export type ComposioV119WebhookHandler = (
  event: ComposioV119QueuedWebhookEvent,
) => Promise<void>;

/** Tuy chon cho queue webhook v2. */
export interface ComposioV119WebhookQueueOptions {
  config?: Partial<ComposioV119WebhookConfig>;
  /** Ham doi that giua cac lan retry (mac dinh: khong doi — test truyen mock). */
  sleep?: (ms: number) => Promise<void>;
  /** Ham lay thoi gian hien tai (mac dinh Date.now — test co the tiem). */
  now?: () => number;
}

/**
 * Hang doi xu ly webhook v2 (memory — host giu mot instance dung
 * chung). Quy trinh: `accept` (verify + dedupe + enqueue) →
 * `drain` (xu ly event den han, retry co gioi han, het luot thi
 * dead-letter) → `requeue` / `discard` dead-letter.
 */
export class ComposioV119WebhookQueue {
  private readonly config: ComposioV119WebhookConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly events: ComposioV119QueuedWebhookEvent[] = [];
  private readonly deadLetters: ComposioV119DeadLetter[] = [];
  private readonly seenEventIds: { id: string; atMs: number }[] = [];
  private readonly seenDeliveryIds: { id: string; atMs: number }[] = [];
  private readonly seenBodyHashes: { hash: string; atMs: number }[] = [];
  private totalProcessed = 0;
  private totalSucceeded = 0;
  private totalFailed = 0;
  private totalDuplicates = 0;
  private totalStale = 0;
  private totalRejected = 0;
  private totalProcessingMs = 0;

  constructor(options: ComposioV119WebhookQueueOptions = {}) {
    this.config = validateComposioV119WebhookConfig(options.config);
    this.sleep = options.sleep ?? (async () => undefined);
    this.nowFn = options.now ?? (() => Date.now());
  }

  /** Cau hinh dang dung (ban sao). */
  getConfig(): ComposioV119WebhookConfig {
    return { ...this.config };
  }

  private pruneSeen(nowMs: number): void {
    const windowStart = nowMs - this.config.dedupeWindowMs;
    const keep = <T extends { atMs: number }>(list: T[]): T[] => list.filter((e) => e.atMs >= windowStart);
    this.seenEventIds.splice(0, this.seenEventIds.length, ...keep(this.seenEventIds));
    this.seenDeliveryIds.splice(0, this.seenDeliveryIds.length, ...keep(this.seenDeliveryIds));
    this.seenBodyHashes.splice(0, this.seenBodyHashes.length, ...keep(this.seenBodyHashes));
  }

  private isDuplicate(eventId: string, deliveryId: string | null, bodyHash: string, nowMs: number): boolean {
    this.pruneSeen(nowMs);
    if (this.seenEventIds.some((e) => e.id === eventId)) return true;
    if (deliveryId !== null && this.seenDeliveryIds.some((e) => e.id === deliveryId)) return true;
    if (this.seenBodyHashes.some((e) => e.hash === bodyHash)) return true;
    // Event dang trong queue / da xu ly roi cung la trung.
    if (this.events.some((e) => e.eventId === eventId)) return true;
    return false;
  }

  private markSeen(eventId: string, deliveryId: string | null, bodyHash: string, nowMs: number): void {
    this.seenEventIds.push({ id: eventId, atMs: nowMs });
    if (deliveryId !== null) this.seenDeliveryIds.push({ id: deliveryId, atMs: nowMs });
    this.seenBodyHashes.push({ hash: bodyHash, atMs: nowMs });
  }

  /**
   * Nhan mot delivery da qua ingester v118: verify lai chu ky
   * (phong thu sau — secret do host cung cap qua getter), parse
   * envelope, kiem tra tuoi event, dedupe (eventId + deliveryId +
   * hash body), roi enqueue. Tra `accepted: false` + ly do khi
   * tu choi — khong bao gio nem (host log ly do).
   */
  accept(input: {
    rawBody: string | Buffer;
    signature?: string;
    timestamp?: string;
    secret: string | null;
    deliveryId?: string | null;
    receivedAtMs?: number;
  }): ComposioV119WebhookAcceptResult {
    const nowMs = input.receivedAtMs ?? this.nowFn();
    const bodyHash = hashComposioV119WebhookBody(input.rawBody);
    const reject = (
      reason: ComposioV119WebhookRejectReason,
    ): ComposioV119WebhookAcceptResult => {
      this.totalRejected += 1;
      return { accepted: false, reason };
    };

    // Verify chu ky (khi co secret + chu ky + delivery id): sai thi tu choi ngay.
    if (input.secret !== null && input.signature !== undefined) {
      const ok = verifyComposioWebhookSignature(
        input.secret,
        input.deliveryId ?? null,
        input.timestamp ?? '',
        input.rawBody,
        input.signature,
        { now: new Date(nowMs), toleranceSeconds: COMPOSIO_V119_WEBHOOK_TOLERANCE_SECONDS },
      );
      if (!ok) return reject('bad-signature');
    }

    let parsed: ComposioTriggerEvent;
    try {
      parsed = parseComposioTriggerPayload(input.rawBody);
    } catch {
      return reject('bad-payload');
    }

    // Replay protection: event qua cu thi tu choi. Timestamp trong
    // envelope la string: epoch giay ("1730000000") hoac ISO.
    const eventAtMs = parseComposioV119EventTimestamp(parsed.timestamp);
    if (eventAtMs !== null && nowMs - eventAtMs > this.config.maxEventAgeMs) {
      this.totalStale += 1;
      return { accepted: false, reason: 'stale-event' };
    }

    const eventId = typeof parsed.eventId === 'string' ? parsed.eventId : bodyHash.slice(0, 32);
    const deliveryId = input.deliveryId ?? null;
    if (this.isDuplicate(eventId, deliveryId, bodyHash, nowMs)) {
      this.totalDuplicates += 1;
      return { accepted: false, reason: 'duplicate-event', duplicate: true };
    }

    const queued = this.events.filter((e) => e.status === 'queued' || e.status === 'processing').length;
    if (queued >= this.config.maxQueueSize) {
      return reject('queue-full');
    }

    const event: ComposioV119QueuedWebhookEvent = {
      queueId: `wq119-${crypto.randomUUID()}`,
      eventId,
      deliveryId,
      bodyHash,
      triggerSlug: parsed.triggerSlug,
      triggerId: typeof parsed.triggerId === 'string' ? parsed.triggerId : null,
      receivedAtMs: nowMs,
      eventAtMs,
      status: 'queued',
      attempts: 0,
      nextAttemptAtMs: null,
      lastError: null,
      payload: parsed,
    };
    this.markSeen(eventId, deliveryId, bodyHash, nowMs);
    this.events.push(event);
    return { accepted: true, event: JSON.parse(JSON.stringify(event)) as ComposioV119QueuedWebhookEvent };
  }

  /** Event dang trong queue (ban sao, cu truoc). */
  listEvents(): ComposioV119QueuedWebhookEvent[] {
    return this.events.map((e) => JSON.parse(JSON.stringify(e)) as ComposioV119QueuedWebhookEvent);
  }

  /** Dead-letter hien co (ban sao, cu truoc). */
  listDeadLetters(): ComposioV119DeadLetter[] {
    return this.deadLetters.map((d) => JSON.parse(JSON.stringify(d)) as ComposioV119DeadLetter);
  }

  /** Lay mot event theo queueId (ban sao). */
  getEvent(queueId: string): ComposioV119QueuedWebhookEvent | undefined {
    const e = this.events.find((x) => x.queueId === queueId);
    return e ? (JSON.parse(JSON.stringify(e)) as ComposioV119QueuedWebhookEvent) : undefined;
  }

  /**
   * Xu ly tat ca event den han (queued + retry da toi gio): goi
   * handler tung event; loi thi hen retry (neu con luot) hoac
   * chuyen sang dead-letter (neu het luot). Tra so event da xu
   * ly trong lan drain nay. Xu ly tuan tu theo thu tu enqueue
   * (concurrency = 1 o muc logic — host co the goi drain song
   * song neu cau hinh concurrency > 1, moi lan drain xu ly mot
   * event rieng).
   */
  async drain(handler: ComposioV119WebhookHandler, nowMs?: number): Promise<number> {
    const now = nowMs ?? this.nowFn();
    let processed = 0;
    const due = this.events.filter(
      (e) => e.status === 'queued' || (e.status === 'failed' && e.nextAttemptAtMs !== null && now >= e.nextAttemptAtMs),
    );
    for (const event of due) {
      event.status = 'processing';
      event.attempts += 1;
      // Duration is measured on the wall clock; scheduling (retry /
      // dead-letter timestamps) uses the drain's logical `now` so a
      // caller driving the queue with injected time stays consistent.
      const startedAt = this.nowFn();
      try {
        await handler(JSON.parse(JSON.stringify(event)) as ComposioV119QueuedWebhookEvent);
        event.status = 'done';
        event.lastError = null;
        event.nextAttemptAtMs = null;
        this.totalSucceeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        event.lastError = message;
        this.totalFailed += 1;
        if (event.attempts >= this.config.maxAttempts) {
          event.status = 'dead-letter';
          const dead: ComposioV119DeadLetter = {
            queueId: event.queueId,
            eventId: event.eventId,
            triggerSlug: event.triggerSlug,
            triggerId: event.triggerId,
            attempts: event.attempts,
            lastError: message,
            receivedAtMs: event.receivedAtMs,
            deadAtMs: now,
            payload: JSON.parse(JSON.stringify(event.payload)) as ComposioTriggerEvent,
          };
          this.deadLetters.push(dead);
          if (this.deadLetters.length > this.config.maxDeadLetters) {
            this.deadLetters.splice(0, this.deadLetters.length - this.config.maxDeadLetters);
          }
          // Xoa khoi queue chinh (da nam trong dead-letter).
          const idx = this.events.findIndex((x) => x.queueId === event.queueId);
          if (idx >= 0) this.events.splice(idx, 1);
        } else {
          event.status = 'failed';
          event.nextAttemptAtMs = now + composioV119WebhookRetryDelayMs(event.attempts - 1, this.config);
        }
      } finally {
        this.totalProcessed += 1;
        this.totalProcessingMs += Math.max(0, this.nowFn() - startedAt);
      }
      processed += 1;
    }
    return processed;
  }

  /** Dua mot dead-letter tro lai hang doi (thu lai tu dau). Tra false neu khong co. */
  requeueDeadLetter(queueId: string, nowMs?: number): boolean {
    const idx = this.deadLetters.findIndex((d) => d.queueId === queueId);
    if (idx < 0) return false;
    const dead = this.deadLetters[idx];
    this.deadLetters.splice(idx, 1);
    const queued = this.events.filter((e) => e.status === 'queued' || e.status === 'processing').length;
    if (queued >= this.config.maxQueueSize) {
      // Queue day — tra dead-letter ve cho cu.
      this.deadLetters.splice(idx, 0, dead);
      return false;
    }
    const event: ComposioV119QueuedWebhookEvent = {
      queueId: dead.queueId,
      eventId: dead.eventId,
      deliveryId: null,
      bodyHash: hashComposioV119WebhookBody(JSON.stringify(dead.payload)),
      triggerSlug: dead.triggerSlug,
      triggerId: dead.triggerId,
      receivedAtMs: nowMs ?? this.nowFn(),
      eventAtMs: null,
      status: 'queued',
      attempts: 0,
      nextAttemptAtMs: null,
      lastError: null,
      payload: JSON.parse(JSON.stringify(dead.payload)) as ComposioTriggerEvent,
    };
    this.events.push(event);
    return true;
  }

  /** Xoa han mot dead-letter. Tra false neu khong co. */
  discardDeadLetter(queueId: string): boolean {
    const idx = this.deadLetters.findIndex((d) => d.queueId === queueId);
    if (idx < 0) return false;
    this.deadLetters.splice(idx, 1);
    return true;
  }

  /** Xoa tat ca event da xong (done) khoi queue — de don dep. Tra so da xoa. */
  pruneDone(): number {
    const before = this.events.length;
    const kept = this.events.filter((e) => e.status !== 'done');
    this.events.splice(0, this.events.length, ...kept);
    return before - kept.length;
  }

  /** Thong ke hang doi cho UI. */
  summarize(): {
    queued: number;
    processing: number;
    failedAwaitingRetry: number;
    done: number;
    deadLetters: number;
    totalProcessed: number;
    totalSucceeded: number;
    totalFailed: number;
    totalDuplicates: number;
    totalStale: number;
    totalRejected: number;
    avgProcessingMs: number | null;
  } {
    const queued = this.events.filter((e) => e.status === 'queued').length;
    const processing = this.events.filter((e) => e.status === 'processing').length;
    const failedAwaitingRetry = this.events.filter((e) => e.status === 'failed').length;
    const done = this.events.filter((e) => e.status === 'done').length;
    return {
      queued,
      processing,
      failedAwaitingRetry,
      done,
      deadLetters: this.deadLetters.length,
      totalProcessed: this.totalProcessed,
      totalSucceeded: this.totalSucceeded,
      totalFailed: this.totalFailed,
      totalDuplicates: this.totalDuplicates,
      totalStale: this.totalStale,
      totalRejected: this.totalRejected,
      avgProcessingMs: this.totalProcessed === 0 ? null : Math.round(this.totalProcessingMs / this.totalProcessed),
    };
  }

  /** Xoa sach queue + dead-letter + dedupe (de test). */
  clear(): void {
    this.events.length = 0;
    this.deadLetters.length = 0;
    this.seenEventIds.length = 0;
    this.seenDeliveryIds.length = 0;
    this.seenBodyHashes.length = 0;
    this.totalProcessed = 0;
    this.totalSucceeded = 0;
    this.totalFailed = 0;
    this.totalDuplicates = 0;
    this.totalStale = 0;
    this.totalRejected = 0;
    this.totalProcessingMs = 0;
  }
}
