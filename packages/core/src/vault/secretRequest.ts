/**
 * Inline secret request — service (v1.07, Team T4).
 *
 * When a tool needs a secret the Vault does not have, the agent asks
 * for it RIGHT IN THE CONVERSATION instead of failing with "go to
 * Settings" (OpenHands v1.28 pattern, learned from public release
 * notes). The flow:
 *
 *   1. Tool code calls `ensureSecret(vault, service, {namespace, key,
 *      label, reason, requestedBy})` — or the service's `requestSecret`
 *      directly when it wants the prompt payload.
 *   2. The Vault already has it → the value returns immediately, no
 *      prompt is created (the common path costs nothing).
 *   3. Otherwise a pending `SecretRequest` is created and its prompt
 *      payload (`SecretRequestPrompt`) is handed to the host, which
 *      renders it inline in the chat (password input + decline).
 *   4. The user answers → the host calls `resolveSecret(id, value)`:
 *      the value is validated, written to the Vault (durable, or
 *      session-only when `saveToVault: false`), the request is marked
 *      fulfilled, and the waiting tool continues with the value.
 *      The user declines → `declineSecret(id)` and the tool gets a
 *      `SecretRequestError` (`declined`) instead of a value.
 *   5. No answer within the timeout → the request expires; the tool
 *      gets `SecretRequestError` (`expired`).
 *
 * Safety:
 * - The secret value NEVER appears in a prompt, a log line, an error
 *   message, or a tool result. `resolveSecret` receives it, validates
 *   it, hands it to `Vault.trySetSecret` — and drops its own
 *   reference. The waiting tool receives the value in memory only;
 *   it must never print it.
 * - Concurrent requests for the SAME namespace:key are deduplicated:
 *   the second caller gets the first request's handle (one prompt in
 *   the chat, not two). The value is delivered to every waiter.
 * - A request that is not pending anymore (fulfilled / declined /
 *   expired / cancelled) cannot be resolved again — a stale answer
 *   from the UI is refused, never applied.
 * - Expiry timers are `unref`'d: a pending request never keeps the
 *   process alive.
 * - The service holds no secrets itself: after fulfilment it keeps
 *   only the request metadata (status + timestamps) for status
 *   lookups; the value lives in the Vault (or nowhere, when the
 *   caller asked for session-only and the process exits).
 */

import { randomUUID } from 'node:crypto';
import type { Vault } from './vault';
import {
  clampSecretRequestTimeoutMs,
  createSecretRequestPrompt,
  isValidSecretName,
  MAX_SECRET_REQUEST_HISTORY,
  validateSecretValue,
} from './secretPrompt';
import type { SecretRequest, SecretRequestPrompt, SecretRequestStatus } from './secretPrompt';

/** What a waiter learns when a request reaches a terminal status. */
export interface SecretRequestResult {
  status: SecretRequestStatus;
  /** The secret value, only when status is `fulfilled` (in memory only — never log or print it). */
  value: string | null;
  /** True when the value came from the Vault without any prompt. */
  fromVault: boolean;
  request: SecretRequest;
}

/** What `requestSecret` returns: metadata + prompt + a waiter. */
export interface SecretRequestHandle {
  request: SecretRequest;
  /** Null when the Vault already had the secret (no prompt needed). */
  prompt: SecretRequestPrompt | null;
  /** True when the Vault already had the secret. */
  fromVault: boolean;
  /** Resolves when the request is fulfilled / declined / expired / cancelled. */
  wait(): Promise<SecretRequestResult>;
}

export interface RequestSecretOptions {
  namespace: string;
  key: string;
  /** Human-readable label shown in the prompt, e.g. "Composio API key". */
  label: string;
  /** Optional hint shown under the input (never a value or a partial key). */
  hint?: string;
  /** Why the secret is needed (shown in the prompt). */
  reason?: string;
  /** Tool that asked (for the audit trail / prompt). */
  requestedBy?: string;
  /** How long the request stays answerable (ms, clamped to 10s … 1h). Default 5 min. */
  timeoutMs?: number;
  /** `false` keeps the secret session-only (never written to disk). Default true (persist). */
  saveToVault?: boolean;
  /** Optional lifetime for the Vault entry (ms; expired entries are refused on read). */
  maxAgeMs?: number;
}

export interface ResolveSecretOptions {
  saveToVault?: boolean;
  maxAgeMs?: number;
}

export interface InlineSecretServiceOptions {
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator override (tests). Defaults to `randomUUID()`. */
  createId?: () => string;
}

/** Thrown by `ensureSecret` when no value can be obtained. */
export class SecretRequestError extends Error {
  readonly kind: 'declined' | 'expired' | 'cancelled' | 'timeout' | 'vault-refused' | 'not-found';
  readonly requestId?: string;
  constructor(
    kind: SecretRequestError['kind'],
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = 'SecretRequestError';
    this.kind = kind;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

interface PendingEntry {
  request: SecretRequest;
  resolve: (result: SecretRequestResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Defaults the requester set for the Vault write (resolve-time opts override). */
  saveToVault: boolean;
  maxAgeMs?: number;
}

export class InlineSecretService {
  private readonly vault: Vault;
  private readonly now: () => number;
  private readonly createId: () => string;
  /** Every request ever created, newest last (bounded — see pruneHistory). */
  private readonly byId = new Map<string, SecretRequest>();
  /** Pending requests by composite key `${namespace}:${key}` (dedupe). */
  private readonly pendingByKey = new Map<string, PendingEntry>();
  /** Pending requests by id (resolve/decline/cancel lookup). */
  private readonly pendingById = new Map<string, PendingEntry>();

  constructor(vault: Vault, opts: InlineSecretServiceOptions = {}) {
    this.vault = vault;
    this.now = opts.now ?? Date.now;
    this.createId = opts.createId ?? (() => randomUUID());
  }

  /**
   * Ask for a secret, inline in the chat. Returns immediately with a
   * handle: when the Vault already has the secret, `fromVault` is
   * true, `prompt` is null and `wait()` resolves at once; otherwise
   * `prompt` is the payload the host renders, and `wait()` resolves
   * when the user answers (or the request expires). A second call
   * for the same namespace:key while one is pending returns the SAME
   * handle — one prompt in the chat, not two.
   */
  requestSecret(opts: RequestSecretOptions): SecretRequestHandle {
    if (!isValidSecretName(opts.namespace)) {
      throw new SecretRequestError(
        'not-found',
        `Invalid secret namespace ${JSON.stringify(opts.namespace)}: must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.`,
      );
    }
    if (!isValidSecretName(opts.key)) {
      throw new SecretRequestError(
        'not-found',
        `Invalid secret key ${JSON.stringify(opts.key)}: must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.`,
      );
    }
    if (typeof opts.label !== 'string' || opts.label.trim() === '') {
      throw new SecretRequestError('not-found', 'Secret request needs a non-empty label.');
    }
    const composite = `${opts.namespace}:${opts.key}`;
    // Fast path: the Vault already has it — no prompt at all.
    let existing: string | null = null;
    try {
      existing = this.vault.getSecret(opts.namespace, opts.key);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      const nowMs = this.now();
      const request: SecretRequest = {
        id: this.createId(),
        namespace: opts.namespace,
        key: opts.key,
        label: opts.label.trim(),
        ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        ...(opts.requestedBy !== undefined ? { requestedBy: opts.requestedBy } : {}),
        status: 'fulfilled',
        createdAtMs: nowMs,
        expiresAtMs: nowMs,
        finishedAtMs: nowMs,
      };
      this.remember(request);
      const result: SecretRequestResult = {
        status: 'fulfilled',
        value: existing,
        fromVault: true,
        request,
      };
      return {
        request,
        prompt: null,
        fromVault: true,
        wait: () => Promise.resolve(result),
      };
    }
    // Dedupe: a pending request for the same secret already exists.
    const pending = this.pendingByKey.get(composite);
    if (pending) {
      const handle = this.handleForPending(pending);
      return { ...handle, fromVault: false };
    }
    const nowMs = this.now();
    const timeoutMs = clampSecretRequestTimeoutMs(opts.timeoutMs);
    const request: SecretRequest = {
      id: this.createId(),
      namespace: opts.namespace,
      key: opts.key,
      label: opts.label.trim(),
      ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.requestedBy !== undefined ? { requestedBy: opts.requestedBy } : {}),
      status: 'pending',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + timeoutMs,
    };
    this.remember(request);
    let resolveFn!: (result: SecretRequestResult) => void;
    const waited = new Promise<SecretRequestResult>((resolve) => {
      resolveFn = resolve;
    });
    const timer = setTimeout(() => {
      this.finish(request.id, 'expired', undefined);
    }, timeoutMs);
    // A pending request must never keep the process alive.
    if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    const entry: PendingEntry = {
      request,
      resolve: resolveFn,
      timer,
      saveToVault: opts.saveToVault !== false,
      ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
    };
    this.pendingByKey.set(composite, entry);
    this.pendingById.set(request.id, entry);
    const prompt = createSecretRequestPrompt(request);
    return {
      request,
      prompt,
      fromVault: false,
      wait: () => waited,
    };
  }

  /**
   * The user answered the inline prompt. Validates the value, writes
   * it to the Vault, marks the request fulfilled and wakes the
   * waiters with the value. Returns `{ok:false}` when the request is
   * not pending, the value is invalid, or the Vault refuses the
   * write (e.g. vault full) — the request stays pending on a Vault
   * refusal so the user can retry (e.g. session-only) instead of
   * losing the prompt.
   */
  resolveSecret(
    requestId: string,
    value: string,
    opts: ResolveSecretOptions = {},
  ): { ok: true; request: SecretRequest } | { ok: false; reason: string } {
    const entry = this.pendingById.get(requestId);
    if (!entry) {
      return { ok: false, reason: `No pending secret request with id ${JSON.stringify(requestId)}.` };
    }
    const valueCheck = validateSecretValue(value);
    if (!valueCheck.ok) return { ok: false, reason: valueCheck.reason };
    const saveToVault = opts.saveToVault ?? entry.saveToVault;
    const maxAgeMs = opts.maxAgeMs ?? entry.maxAgeMs;
    const result = this.vault.trySetSecret(entry.request.namespace, entry.request.key, value, {
      saveToVault,
      ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
    });
    if (!result.ok) {
      return { ok: false, reason: result.refusal.message };
    }
    this.finish(requestId, 'fulfilled', value);
    return { ok: true, request: entry.request };
  }

  /** The user declined the inline prompt. Waiters get `declined` (no value). */
  declineSecret(
    requestId: string,
    reason?: string,
  ): { ok: true; request: SecretRequest } | { ok: false; reason: string } {
    const entry = this.pendingById.get(requestId);
    if (!entry) {
      return { ok: false, reason: `No pending secret request with id ${JSON.stringify(requestId)}.` };
    }
    this.finish(requestId, 'declined', undefined, reason);
    return { ok: true, request: entry.request };
  }

  /** The host cancelled the request (e.g. the chat was cleared). Waiters get `cancelled`. */
  cancelSecret(
    requestId: string,
  ): { ok: true; request: SecretRequest } | { ok: false; reason: string } {
    const entry = this.pendingById.get(requestId);
    if (!entry) {
      return { ok: false, reason: `No pending secret request with id ${JSON.stringify(requestId)}.` };
    }
    this.finish(requestId, 'cancelled', undefined);
    return { ok: true, request: entry.request };
  }

  /** Expire every pending request past its deadline (also runs on a per-request timer). */
  expireStaleRequests(nowMs: number = this.now()): number {
    let expired = 0;
    for (const entry of [...this.pendingById.values()]) {
      if (entry.request.expiresAtMs <= nowMs) {
        this.finish(entry.request.id, 'expired', undefined);
        expired++;
      }
    }
    return expired;
  }

  /** One request by id (pending or finished), or undefined. Metadata only — never a value. */
  getRequest(requestId: string): SecretRequest | undefined {
    return this.byId.get(requestId);
  }

  /** Pending requests, oldest first. */
  listPending(): SecretRequest[] {
    return [...this.pendingById.values()]
      .map((e) => e.request)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** All remembered requests, newest first (bounded history). */
  listRequests(): SecretRequest[] {
    return [...this.byId.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /**
   * The tool-side entry point: return the Vault value when present,
   * otherwise ask inline and wait for the answer. Throws
   * SecretRequestError (`declined` / `expired` / `cancelled`) when no
   * value can be obtained. The returned value is for the CALLER's
   * in-memory use only — it must never be printed, logged or put in
   * a tool result.
   */
  async ensureSecret(opts: RequestSecretOptions): Promise<string> {
    const handle = this.requestSecret(opts);
    const result = await handle.wait();
    if (result.status === 'fulfilled' && result.value !== null) {
      return result.value;
    }
    const kind =
      result.status === 'declined'
        ? 'declined'
        : result.status === 'expired'
          ? 'expired'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'timeout';
    throw new SecretRequestError(
      kind,
      `Secret "${opts.label}" (${opts.namespace}:${opts.key}) was not provided (${result.status}).`,
      handle.request.id,
    );
  }

  private handleForPending(entry: PendingEntry): Omit<SecretRequestHandle, 'fromVault'> {
    const prompt = createSecretRequestPrompt(entry.request);
    let resolveFn!: (result: SecretRequestResult) => void;
    // The deduped caller waits on the SAME outcome: subscribe by
    // wrapping the original promise — the entry's resolver is called
    // once and every waiter (original + deduped) resolves.
    const waited = new Promise<SecretRequestResult>((resolve) => {
      resolveFn = resolve;
    });
    const originalResolve = entry.resolve;
    entry.resolve = (result) => {
      originalResolve(result);
      resolveFn(result);
    };
    return { request: entry.request, prompt, wait: () => waited };
  }

  private finish(
    requestId: string,
    status: 'fulfilled' | 'declined' | 'expired' | 'cancelled',
    value: string | undefined,
    finishReason?: string,
  ): void {
    const entry = this.pendingById.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    const composite = `${entry.request.namespace}:${entry.request.key}`;
    this.pendingByKey.delete(composite);
    this.pendingById.delete(requestId);
    entry.request.status = status;
    entry.request.finishedAtMs = this.now();
    if (finishReason !== undefined) entry.request.finishReason = finishReason;
    entry.resolve({
      status,
      value: status === 'fulfilled' ? (value ?? null) : null,
      fromVault: false,
      request: entry.request,
    });
  }

  private remember(request: SecretRequest): void {
    this.byId.set(request.id, request);
    // Bound the history: drop the oldest FINISHED requests first.
    if (this.byId.size > MAX_SECRET_REQUEST_HISTORY) {
      for (const [id, req] of this.byId) {
        if (req.status !== 'pending') {
          this.byId.delete(id);
          if (this.byId.size <= MAX_SECRET_REQUEST_HISTORY) break;
        }
      }
    }
  }
}
