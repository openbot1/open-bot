/**
 * Sandbox v6 — per-bot secret scoping (v1.38, Team T3).
 *
 * A secret belongs to exactly one bot. The store enforces
 * that ownership on every read:
 *
 *  - `put(ownerBotId, name, value, purposes?)` stores a value
 *    for one bot, with an optional purpose list (e.g. only
 *    for `github` calls) and expiry. Storing under the same
 *    name replaces the old value (the old value is forgotten,
 *    not kept in history).
 *  - `get(callerBotId, ownerBotId, name, purpose?)` returns
 *    the value ONLY when the caller is the owner, the purpose
 *    is allowed, and the secret has not expired. Any other
 *    caller gets a denial — and the denial is counted on the
 *    secret's metadata so `list()` shows that someone tried.
 *  - `list(ownerBotId)` returns metadata only (names,
 *    purposes, expiry, read/denied counts) — never values.
 *  - `revoke(ownerBotId, name)` deletes the value. `purgeBot`
 *    deletes everything a bot owns (called when its runtime
 *    is destroyed — a finished bot leaves no credential).
 *
 * The store calls back into the audit layer through an
 * `onAccessDenied` hook (the service wires it to the bot's
 * audit logger) so a cross-bot read attempt is itself an
 * audit event, not a silent `null`.
 *
 * Persistence: values live in memory AND in a JSON file
 * (`secrets.json`, mode 0600, one file per bot under the
 * service base dir). The file is the same trust level as the
 * rest of the app's userData: readable only by the OS user
 * running open-bot. Values are stored as-is (no home-grown
 * "encryption" — a reversible obfuscation would be a lie
 * about security; the real protection is the file mode plus
 * the access check above). Callers that need stronger
 * protection should use the OS keychain / Vault instead.
 * `load()` re-reads the file on service start; expired
 * entries are dropped on load.
 *
 * The value itself is never logged anywhere in this module:
 * every error message carries the secret *name* and bot ids
 * only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  sandboxV6BotIdError,
  sandboxV6SecretNameError,
  type SandboxV6SecretAccess,
  type SandboxV6SecretMeta,
} from './types';

export const SANDBOX_V6_SECRETS_FILE = 'secrets.json';

export interface SandboxV6SecretPutInput {
  /** Bot that will own the secret. */
  ownerBotId: string;
  name: string;
  value: string;
  /** Purposes the value may be used for (empty = any purpose for the owner). */
  purposes?: string[];
  /** TTL in ms (0 = never expires). */
  ttlMs?: number;
}

export interface SandboxV6SecretStoreOptions {
  /** Directory holding this bot's secrets.json. */
  dir: string;
  /** Bot this store belongs to. */
  botId: string;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
  /** Called on every denied read (service wires it to the audit logger). */
  onAccessDenied?: (info: {
    callerBotId: string;
    ownerBotId: string;
    name: string;
    reason: string;
  }) => void;
}

interface StoredSecret {
  value: string;
  purposes: string[];
  createdAtMs: number;
  expiresAtMs: number;
  readCount: number;
  lastReadAtMs: number;
  deniedCount: number;
}

/**
 * Per-bot secret store. One instance per bot; the `botId` in
 * the options is the owner, and `get()` additionally takes the
 * *caller's* bot id so a confused caller cannot read another
 * bot's store by passing the wrong instance.
 */
export class SandboxV6SecretStore {
  readonly dir: string;
  readonly botId: string;
  private readonly nowMs: () => number;
  private readonly onAccessDenied?: SandboxV6SecretStoreOptions['onAccessDenied'];
  private readonly secrets = new Map<string, StoredSecret>();

  constructor(options: SandboxV6SecretStoreOptions) {
    const botErr = sandboxV6BotIdError(options.botId);
    if (botErr !== '') throw new Error(botErr);
    this.dir = options.dir;
    this.botId = options.botId;
    this.nowMs = options.nowMs ?? Date.now;
    this.onAccessDenied = options.onAccessDenied;
    fs.mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** Path of the persistence file. */
  get filePath(): string {
    return path.join(this.dir, SANDBOX_V6_SECRETS_FILE);
  }

  /** Names owned by this bot. */
  names(): string[] {
    this.dropExpired();
    return [...this.secrets.keys()].sort();
  }

  /** Does this bot own a live secret with this name? */
  has(name: string): boolean {
    this.dropExpired();
    return this.secrets.has(name);
  }

  /** Store (or replace) a secret for this bot. */
  put(input: SandboxV6SecretPutInput): SandboxV6SecretMeta {
    if (input.ownerBotId !== this.botId) {
      throw new Error(
        `Secret "${input.name}" belongs to bot "${input.ownerBotId}", not to store bot "${this.botId}".`,
      );
    }
    const nameErr = sandboxV6SecretNameError(input.name);
    if (nameErr !== '') throw new Error(nameErr);
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new Error(`Secret "${input.name}": value must be a non-empty string.`);
    }
    const purposes = [...(input.purposes ?? [])];
    for (const p of purposes) {
      if (!/^[a-z0-9][a-z0-9_/-]{0,63}$/.test(p)) {
        throw new Error(`Invalid secret purpose "${p}" for secret "${input.name}".`);
      }
    }
    const ttlMs = input.ttlMs ?? 0;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error(`Invalid ttlMs ${ttlMs} for secret "${input.name}": must be >= 0.`);
    }
    const now = this.nowMs();
    const stored: StoredSecret = {
      value: input.value,
      purposes,
      createdAtMs: now,
      expiresAtMs: ttlMs > 0 ? now + ttlMs : 0,
      readCount: 0,
      lastReadAtMs: 0,
      deniedCount: 0,
    };
    this.secrets.set(input.name, stored);
    this.save();
    return this.meta(input.name);
  }

  /**
   * Read a secret. Only the owner bot may read, only for an
   * allowed purpose, only before expiry. Every denial is
   * counted and reported through `onAccessDenied`.
   */
  get(
    callerBotId: string,
    name: string,
    purpose?: string,
  ): { access: SandboxV6SecretAccess; value?: string } {
    const deny = (reason: string): { access: SandboxV6SecretAccess } => {
      const stored = this.secrets.get(name);
      if (stored !== undefined) stored.deniedCount += 1;
      this.save();
      this.onAccessDenied?.({ callerBotId, ownerBotId: this.botId, name, reason });
      return { access: { allowed: false, reason } };
    };
    const nameErr = sandboxV6SecretNameError(name);
    if (nameErr !== '') return deny(nameErr);
    if (callerBotId !== this.botId) {
      return deny(`Bot "${callerBotId}" is not the owner of secret "${name}" (owner is "${this.botId}").`);
    }
    // Expiry is checked BEFORE the general sweep, so a read of
    // an expired secret reports "expired", not "no such secret".
    const pre = this.secrets.get(name);
    if (pre !== undefined && pre.expiresAtMs > 0 && pre.expiresAtMs <= this.nowMs()) {
      this.secrets.delete(name);
      this.save();
      this.onAccessDenied?.({
        callerBotId,
        ownerBotId: this.botId,
        name,
        reason: `Secret "${name}" for bot "${this.botId}" has expired.`,
      });
      return { access: { allowed: false, reason: `Secret "${name}" for bot "${this.botId}" has expired.` } };
    }
    this.dropExpired();
    const stored = this.secrets.get(name);
    if (stored === undefined) {
      return deny(`No live secret named "${name}" for bot "${this.botId}".`);
    }
    if (purpose !== undefined && stored.purposes.length > 0 && !stored.purposes.includes(purpose)) {
      return deny(
        `Secret "${name}" for bot "${this.botId}" is not granted for purpose "${purpose}" ` +
          `(granted: ${stored.purposes.join(', ')}).`,
      );
    }
    stored.readCount += 1;
    stored.lastReadAtMs = this.nowMs();
    this.save();
    return { access: { allowed: true }, value: stored.value };
  }

  /** Check access without reading the value (no read counted). */
  checkAccess(callerBotId: string, name: string, purpose?: string): SandboxV6SecretAccess {
    if (callerBotId !== this.botId) {
      return {
        allowed: false,
        reason: `Bot "${callerBotId}" is not the owner of secret "${name}" (owner is "${this.botId}").`,
      };
    }
    const stored = this.secrets.get(name);
    if (stored === undefined) {
      return { allowed: false, reason: `No live secret named "${name}" for bot "${this.botId}".` };
    }
    if (stored.expiresAtMs > 0 && stored.expiresAtMs <= this.nowMs()) {
      return { allowed: false, reason: `Secret "${name}" for bot "${this.botId}" has expired.` };
    }
    if (purpose !== undefined && stored.purposes.length > 0 && !stored.purposes.includes(purpose)) {
      return {
        allowed: false,
        reason: `Secret "${name}" is not granted for purpose "${purpose}".`,
      };
    }
    return { allowed: true };
  }

  /** Metadata for one secret (never the value). Undefined when absent/expired. */
  meta(name: string): SandboxV6SecretMeta {
    this.dropExpired();
    const stored = this.secrets.get(name);
    if (stored === undefined) {
      throw new Error(`No live secret named "${name}" for bot "${this.botId}".`);
    }
    return {
      name,
      ownerBotId: this.botId,
      purposes: [...stored.purposes],
      createdAtMs: stored.createdAtMs,
      expiresAtMs: stored.expiresAtMs,
      readCount: stored.readCount,
      lastReadAtMs: stored.lastReadAtMs,
      deniedCount: stored.deniedCount,
    };
  }

  /** Metadata for all live secrets of this bot (never values). */
  list(): SandboxV6SecretMeta[] {
    this.dropExpired();
    return this.names().map((name) => this.meta(name));
  }

  /** Delete one secret. Returns true when something was deleted. */
  revoke(name: string): boolean {
    const existed = this.secrets.delete(name);
    if (existed) this.save();
    return existed;
  }

  /** Delete every secret this bot owns. Returns how many were deleted. */
  purge(): number {
    const count = this.secrets.size;
    this.secrets.clear();
    this.save();
    return count;
  }

  /** All live values (for the audit scrubber only — never log the result). */
  valuesForScrubbing(): string[] {
    this.dropExpired();
    return [...this.secrets.values()].map((s) => s.value);
  }

  private dropExpired(): void {
    const now = this.nowMs();
    let changed = false;
    for (const [name, stored] of this.secrets) {
      if (stored.expiresAtMs > 0 && stored.expiresAtMs <= now) {
        this.secrets.delete(name);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // No file yet — fresh store.
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, StoredSecret>;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [name, stored] of Object.entries(parsed)) {
        if (sandboxV6SecretNameError(name) !== '') continue;
        if (typeof stored?.value !== 'string' || stored.value.length === 0) continue;
        this.secrets.set(name, {
          value: stored.value,
          purposes: Array.isArray(stored.purposes) ? stored.purposes.filter((p) => typeof p === 'string') : [],
          createdAtMs: typeof stored.createdAtMs === 'number' ? stored.createdAtMs : this.nowMs(),
          expiresAtMs: typeof stored.expiresAtMs === 'number' ? stored.expiresAtMs : 0,
          readCount: typeof stored.readCount === 'number' ? stored.readCount : 0,
          lastReadAtMs: typeof stored.lastReadAtMs === 'number' ? stored.lastReadAtMs : 0,
          deniedCount: typeof stored.deniedCount === 'number' ? stored.deniedCount : 0,
        });
      }
    } catch {
      // Corrupt file: start empty rather than crash the service.
      // The old file is left in place for forensics.
      this.secrets.clear();
    }
    this.dropExpired();
  }

  private save(): void {
    const obj: Record<string, StoredSecret> = {};
    for (const [name, stored] of this.secrets) obj[name] = stored;
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // chmod best-effort (non-POSIX fs).
    }
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}
