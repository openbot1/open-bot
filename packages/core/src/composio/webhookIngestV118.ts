/**
 * Composio webhook ingestion v1.18 (v1.18, Doi T4).
 *
 * Tang NHAN webhook ben tren `triggers.ts` (v0.83: parse V3 envelope
 * + verify HMAC-SHA256 + token fallback) va `triggerQueue.ts`
 * (v0.96: queue + dedupe theo eventId + long-poll). Tang do chi co
 * ham parse/verify roi — chua co CHO NHAN request hoan chinh nao
 * o muc core (route that nam trong `automations/webhook.ts`, gan
 * voi Local API + automation cu the). Tang nay la endpoint ingestion
 * dung rieng cho Composio v118:
 *
 * - Loopback-only: chi nhan request tu 127.0.0.1 / ::1 / localhost.
 *   Composio (public internet) khong the goi thang vao Local API
 *   (ghi trong triggers.ts): production van can tunnel (`cloudflared
 *   tunnel --url http://127.0.0.1:<port>`) hoac `composio dev
 *   triggers listen --forward` — endpoint nay chi chap nhan dau
 *   cuoi tunnel chay tren chinh may (loopback), khong mo port ra
 *   ngoai.
 * - Verify chu ky: dung lai `verifyComposioWebhookSignature`
 *   (HMAC-SHA256, tolerance 300s). Secret do host cung cap qua ham
 *   getter (doc tu Vault — module nay KHONG doc Vault, KHONG thay
 *   secret, KHONG log secret). Khong co chu ky thi chap nhan
 *   `?token=` (fallback trong triggers.ts) — chu ky co nhung SAI
 *   thi tu choi ngay ca khi token dung (dau hieu gia mao).
 * - Parse + route: parse V3 envelope bang
 *   `parseComposioTriggerPayload`, route event toi trigger instance
 *   da dang ky trong triggerInstancesV118 (theo triggerId) — instance
 *   chua dang ky thi nhan nhung ghi `ignored-unknown-trigger`
 *   (khong chay gi), instance disabled thi `ignored-disabled`.
 * - Dedupe: Composio retry cung delivery (cung `webhook-id` /
 *   eventId) — event da thay trong cua so thi tra 200 nhung ghi
 *   `duplicate`, khong route lan 2.
 * - Event log: moi delivery (ke ca bi tu choi) deu ghi 1 dong log
 *   (memory + JSONL file) — KHONG chua secret, KHONG chua toan bo
 *   data event (chi metadata + hash ngan cua data de doi chieu).
 *
 * Module nay KHONG chay automation va KHONG goi mang: no chi
 * verify + parse + route + log. Host (Local API route) goi
 * `ingest()` roi tu quyet dinh chay automation theo ket qua tra ve.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMPOSIO_WEBHOOK_ID_HEADER,
  COMPOSIO_WEBHOOK_SIGNATURE_HEADER,
  COMPOSIO_WEBHOOK_TIMESTAMP_HEADER,
  parseComposioTriggerPayload,
  verifyComposioTriggerToken,
  verifyComposioWebhookSignature,
  type ComposioTriggerEvent,
} from './triggers';
import type { ComposioV118TriggerInstance } from './triggerInstancesV118';

/** File event log webhook v118 trong thu muc composio cua userData. */
export const COMPOSIO_V118_WEBHOOK_LOG_FILE = 'composio-webhook-log-v118.jsonl';
/** Giu toi da tung nay dong log. */
export const COMPOSIO_V118_MAX_WEBHOOK_LOG_LINES = 1000;
/** Cua so dedupe eventId mac dinh: 24 gio. */
export const COMPOSIO_V118_WEBHOOK_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Duong dan endpoint webhook (Local API, loopback-only). */
export const COMPOSIO_V118_WEBHOOK_PATH = '/v1/composio/webhook';

/** true khi dia chi la loopback (chi nhan request tu chinh may). */
export function isComposioV118LoopbackAddress(address: string | undefined | null): boolean {
  if (typeof address !== 'string') return false;
  const a = address.trim().toLowerCase();
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    a === '::ffff:127.0.0.1' ||
    a === 'localhost' ||
    a === '0:0:0:0:0:0:0:1'
  );
}

/** Ket qua route cua mot event da verify. */
export type ComposioV118WebhookRoute =
  | 'routed'
  | 'ignored-disabled'
  | 'ignored-unknown-trigger'
  | 'duplicate';

/** Mot delivery webhook (request HTTP tho, chua parse). */
export interface ComposioV118WebhookRequest {
  /** Phuong thuc HTTP — chi POST duoc chap nhan. */
  method: string;
  /** Duong dan — phai la COMPOSIO_V118_WEBHOOK_PATH. */
  path: string;
  /** Dia chi remote — phai la loopback. */
  remoteAddress?: string;
  /** Header (key khong phan biet hoa/thuong). */
  headers?: Record<string, string | string[] | undefined>;
  /** Body tho (chua parse) — dung de verify chu ky. */
  rawBody: string | Buffer;
  /** Token tu `?token=` (neu co) — fallback khi khong co chu ky. */
  queryToken?: string;
}

/** Ket qua xu ly mot delivery (de Local API route tra HTTP). */
export interface ComposioV118WebhookResult {
  /** Ma HTTP tra ve: 200 (nhan/routed/duplicate/ignored), 400 (body sai), 401 (xac thuc sai), 403 (khong phai loopback), 404 (sai duong dan), 405 (sai method). */
  status: number;
  /** true khi delivery duoc chap nhan (ke ca duplicate/ignored). */
  accepted: boolean;
  /** Route cua event (undefined khi bi tu choi truoc khi parse). */
  route?: ComposioV118WebhookRoute;
  /** Ly do ngan (de log/UI — khong chua secret). */
  reason: string;
  /** Event da parse (chi khi route = routed). */
  event?: ComposioTriggerEvent;
}

/** Mot dong event log webhook. */
export interface ComposioV118WebhookLogEntry {
  id: string;
  /** Event id (`msg_...`) khi parse duoc, neu khong thi webhook-id. */
  eventId: string | null;
  triggerSlug: string | null;
  triggerId: string | null;
  connectionId: string | null;
  route: ComposioV118WebhookRoute | 'rejected';
  status: number;
  reason: string;
  /** Hash SHA-256 ngan (12 ky tu) cua raw body — de doi chieu ma khong luu data. */
  bodyHash: string;
  receivedAtMs: number;
}

/** Ham host tiem: lay webhook secret tu Vault (tra null khi chua co secret). */
export type ComposioV118WebhookSecretFn = () => string | null;
/** Ham host tiem: lay token URL tu Vault (tra null khi chua co token). */
export type ComposioV118WebhookTokenFn = () => string | null;
/** Ham host tiem: tim trigger instance theo triggerId (undefined = chua dang ky). */
export type ComposioV118InstanceLookupFn = (
  triggerId: string,
) => ComposioV118TriggerInstance | undefined;

/** Tuy chon ingester. */
export interface ComposioV118WebhookIngesterOptions {
  /** Ham lay secret (bat buoc — khong co secret thi moi delivery co chu ky deu bi tu choi). */
  getSecret: ComposioV118WebhookSecretFn;
  /** Ham lay token URL (tuy chon — khong co thi khong co fallback token). */
  getToken?: ComposioV118WebhookTokenFn;
  /** Ham tim trigger instance (mac dinh: khong co instance nao — moi event deu ignored-unknown-trigger). */
  lookupInstance?: ComposioV118InstanceLookupFn;
  /** Cua so dedupe eventId (ms). */
  dedupeWindowMs?: number;
  /** Dong ho tiem duoc (test). */
  now?: () => number;
  /** Ham ghi log (mac dinh: memory — host truyen file logger khi co userData). */
  onLog?: (entry: ComposioV118WebhookLogEntry) => void;
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      if (Array.isArray(value)) return value[0];
      return value;
    }
  }
  return undefined;
}

/** Hash ngan cua raw body (12 ky tu dau cua SHA-256 hex). */
export function hashComposioV118WebhookBody(rawBody: string | Buffer): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

/**
 * Ingester webhook: verify → parse → dedupe → route → log.
 * Khong bao gio nem — moi loi deu thanh mot ket qua co status.
 * Thu tu kiem tra (fail-closed):
 * 1. method != POST → 405; path sai → 404; khong phai loopback → 403.
 * 2. Co header chu ky: verify HMAC — sai → 401 (ke ca token dung).
 *    Khong co header chu ky: so token `?token=` voi token luu —
 *    sai/khong co → 401.
 * 3. Parse V3 envelope — sai → 400.
 * 4. Dedupe theo eventId — trung → 200 duplicate.
 * 5. Route theo triggerId — chua dang ky → 200 ignored-unknown-
 *    trigger; disabled → 200 ignored-disabled; con lai → 200 routed.
 */
export class ComposioV118WebhookIngester {
  private readonly getSecret: ComposioV118WebhookSecretFn;
  private readonly getToken: ComposioV118WebhookTokenFn;
  private readonly lookupInstance: ComposioV118InstanceLookupFn;
  private readonly dedupeWindowMs: number;
  private readonly now: () => number;
  private readonly onLog: (entry: ComposioV118WebhookLogEntry) => void;
  private readonly seen = new Map<string, number>();
  private readonly log: ComposioV118WebhookLogEntry[] = [];

  constructor(options: ComposioV118WebhookIngesterOptions) {
    if (typeof options.getSecret !== 'function') throw new Error('getSecret must be a function');
    this.getSecret = options.getSecret;
    this.getToken = options.getToken ?? (() => null);
    this.lookupInstance = options.lookupInstance ?? (() => undefined);
    this.dedupeWindowMs = options.dedupeWindowMs ?? COMPOSIO_V118_WEBHOOK_DEDUPE_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.onLog =
      options.onLog ??
      ((entry) => {
        this.log.push(entry);
      });
  }

  /** Log trong bo nho (moi nhat truoc) — chi co khi dung logger mac dinh. */
  listLog(limit?: number): ComposioV118WebhookLogEntry[] {
    const reversed = [...this.log].reverse();
    return limit !== undefined ? reversed.slice(0, Math.max(0, limit)) : reversed;
  }

  /** So eventId dang nho trong cua so dedupe. */
  get seenCount(): number {
    return this.seen.size;
  }

  private record(entry: ComposioV118WebhookLogEntry): void {
    this.onLog(entry);
    if (this.log.length > COMPOSIO_V118_MAX_WEBHOOK_LOG_LINES) {
      this.log.splice(0, this.log.length - COMPOSIO_V118_MAX_WEBHOOK_LOG_LINES);
    }
  }

  private makeEntry(
    partial: Omit<ComposioV118WebhookLogEntry, 'id' | 'bodyHash' | 'receivedAtMs'>,
    rawBody: string | Buffer,
    receivedAtMs: number,
  ): ComposioV118WebhookLogEntry {
    const entry: ComposioV118WebhookLogEntry = {
      id: `wh118-${crypto.randomUUID()}`,
      ...partial,
      bodyHash: hashComposioV118WebhookBody(rawBody),
      receivedAtMs,
    };
    this.record(entry);
    return entry;
  }

  private purgeSeen(nowMs: number): void {
    for (const [id, at] of [...this.seen.entries()]) {
      if (nowMs - at > this.dedupeWindowMs) this.seen.delete(id);
    }
  }

  ingest(req: ComposioV118WebhookRequest): ComposioV118WebhookResult {
    const nowMs = this.now();
    const reject = (
      status: number,
      reason: string,
    ): ComposioV118WebhookResult => {
      this.makeEntry(
        {
          eventId: null,
          triggerSlug: null,
          triggerId: null,
          connectionId: null,
          route: 'rejected',
          status,
          reason,
        },
        req.rawBody,
        nowMs,
      );
      return { status, accepted: false, reason };
    };

    if (typeof req.method !== 'string' || req.method.toUpperCase() !== 'POST') {
      return reject(405, 'webhook only accepts POST');
    }
    if (req.path !== COMPOSIO_V118_WEBHOOK_PATH) {
      return reject(404, `unknown webhook path: ${req.path}`);
    }
    if (!isComposioV118LoopbackAddress(req.remoteAddress)) {
      return reject(403, 'webhook endpoint is loopback-only');
    }

    const webhookId = headerValue(req.headers, COMPOSIO_WEBHOOK_ID_HEADER);
    const timestamp = headerValue(req.headers, COMPOSIO_WEBHOOK_TIMESTAMP_HEADER);
    const signature = headerValue(req.headers, COMPOSIO_WEBHOOK_SIGNATURE_HEADER);
    // Co header chu ky → phai verify HMAC; sai thi tu choi ngay ca khi token dung.
    if (signature !== undefined && signature !== '') {
      const secret = this.getSecret();
      const ok = verifyComposioWebhookSignature(secret ?? '', webhookId, timestamp, req.rawBody, signature, {
        now: new Date(nowMs),
      });
      if (!ok) return reject(401, 'invalid webhook signature');
    } else {
      // Khong co chu ky → fallback token ?token=.
      const storedToken = this.getToken();
      if (!verifyComposioTriggerToken(storedToken, req.queryToken ?? null)) {
        return reject(401, 'missing or invalid webhook signature or token');
      }
    }

    let event: ComposioTriggerEvent;
    try {
      event = parseComposioTriggerPayload(req.rawBody);
    } catch (err) {
      return reject(400, err instanceof Error ? err.message : 'invalid webhook body');
    }

    const eventKey = event.eventId ?? webhookId ?? null;
    this.purgeSeen(nowMs);
    if (eventKey !== null && this.seen.has(eventKey)) {
      this.makeEntry(
        {
          eventId: event.eventId ?? null,
          triggerSlug: event.triggerSlug,
          triggerId: event.triggerId ?? null,
          connectionId: event.connectedAccountId ?? null,
          route: 'duplicate',
          status: 200,
          reason: 'duplicate delivery — already received',
        },
        req.rawBody,
        nowMs,
      );
      return { status: 200, accepted: true, route: 'duplicate', reason: 'duplicate delivery — already received', event };
    }
    if (eventKey !== null) this.seen.set(eventKey, nowMs);

    const instance = event.triggerId !== undefined ? this.lookupInstance(event.triggerId) : undefined;
    if (event.triggerId === undefined || instance === undefined) {
      this.makeEntry(
        {
          eventId: event.eventId ?? null,
          triggerSlug: event.triggerSlug,
          triggerId: event.triggerId ?? null,
          connectionId: event.connectedAccountId ?? null,
          route: 'ignored-unknown-trigger',
          status: 200,
          reason: 'trigger instance not registered in open-bot — event ignored',
        },
        req.rawBody,
        nowMs,
      );
      return {
        status: 200,
        accepted: true,
        route: 'ignored-unknown-trigger',
        reason: 'trigger instance not registered in open-bot — event ignored',
        event,
      };
    }
    if (instance.status === 'disabled') {
      this.makeEntry(
        {
          eventId: event.eventId ?? null,
          triggerSlug: event.triggerSlug,
          triggerId: event.triggerId ?? null,
          connectionId: event.connectedAccountId ?? null,
          route: 'ignored-disabled',
          status: 200,
          reason: 'trigger instance is disabled — event ignored',
        },
        req.rawBody,
        nowMs,
      );
      return {
        status: 200,
        accepted: true,
        route: 'ignored-disabled',
        reason: 'trigger instance is disabled — event ignored',
        event,
      };
    }

    this.makeEntry(
      {
        eventId: event.eventId ?? null,
        triggerSlug: event.triggerSlug,
        triggerId: event.triggerId ?? null,
        connectionId: event.connectedAccountId ?? null,
        route: 'routed',
        status: 200,
        reason: 'event verified and routed to trigger instance',
      },
      req.rawBody,
      nowMs,
    );
    return { status: 200, accepted: true, route: 'routed', reason: 'event verified and routed to trigger instance', event };
  }
}

// ---------------------------------------------------------------------------
// File event log (JSONL, append) — de host luu log xuong dia
// ---------------------------------------------------------------------------

/** Duong dan file log webhook. */
export function getComposioV118WebhookLogPath(dir: string): string {
  return path.join(dir, COMPOSIO_V118_WEBHOOK_LOG_FILE);
}

/** Kiem tra mot dong log (throw neu sai). */
export function validateComposioV118WebhookLogEntry(raw: unknown): ComposioV118WebhookLogEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ComposioV118WebhookLogEntry must be an object.');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || (rec['id'] as string).trim() === '') throw new Error('log id must be a non-empty string.');
  if (rec['eventId'] !== null && typeof rec['eventId'] !== 'string') throw new Error('log eventId must be null or a string.');
  if (rec['triggerSlug'] !== null && typeof rec['triggerSlug'] !== 'string') throw new Error('log triggerSlug must be null or a string.');
  if (rec['triggerId'] !== null && typeof rec['triggerId'] !== 'string') throw new Error('log triggerId must be null or a string.');
  if (rec['connectionId'] !== null && typeof rec['connectionId'] !== 'string') throw new Error('log connectionId must be null or a string.');
  const routes: readonly string[] = ['routed', 'ignored-disabled', 'ignored-unknown-trigger', 'duplicate', 'rejected'];
  if (typeof rec['route'] !== 'string' || !routes.includes(rec['route'])) throw new Error('log route is invalid.');
  if (typeof rec['status'] !== 'number' || !Number.isInteger(rec['status'])) throw new Error('log status must be an integer.');
  if (typeof rec['reason'] !== 'string' || (rec['reason'] as string).trim() === '') throw new Error('log reason must be a non-empty string.');
  if (typeof rec['bodyHash'] !== 'string' || (rec['bodyHash'] as string).length !== 12) throw new Error('log bodyHash must be 12 hex chars.');
  if (typeof rec['receivedAtMs'] !== 'number' || !Number.isFinite(rec['receivedAtMs'])) throw new Error('log receivedAtMs must be a number.');
  return {
    id: rec['id'] as string,
    eventId: rec['eventId'] as string | null,
    triggerSlug: rec['triggerSlug'] as string | null,
    triggerId: rec['triggerId'] as string | null,
    connectionId: rec['connectionId'] as string | null,
    route: rec['route'] as ComposioV118WebhookRoute | 'rejected',
    status: rec['status'] as number,
    reason: rec['reason'] as string,
    bodyHash: rec['bodyHash'] as string,
    receivedAtMs: rec['receivedAtMs'] as number,
  };
}

/** Ghi them mot dong log vao file JSONL (ghi de khi qua gioi han). */
export function appendComposioV118WebhookLog(dir: string, entry: ComposioV118WebhookLogEntry): void {
  const file = getComposioV118WebhookLogPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(validateComposioV118WebhookLogEntry(entry))}\n`, { mode: 0o600 });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length > COMPOSIO_V118_MAX_WEBHOOK_LOG_LINES) {
    const kept = lines.slice(-COMPOSIO_V118_MAX_WEBHOOK_LOG_LINES);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

/** Doc log webhook tu file (moi nhat truoc). */
export function listComposioV118WebhookLog(
  dir: string,
  opts: { route?: ComposioV118WebhookRoute | 'rejected'; triggerSlug?: string; limit?: number } = {},
): ComposioV118WebhookLogEntry[] {
  const file = getComposioV118WebhookLogPath(dir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const all = lines.map((line) => validateComposioV118WebhookLogEntry(JSON.parse(line) as unknown));
  const filtered = all.filter(
    (e) =>
      (opts.route === undefined || e.route === opts.route) &&
      (opts.triggerSlug === undefined || e.triggerSlug === opts.triggerSlug),
  );
  const reversed = filtered.reverse();
  return opts.limit !== undefined ? reversed.slice(0, Math.max(0, opts.limit)) : reversed;
}
