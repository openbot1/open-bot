/**
 * Sandbox v5 — profile-scoped secrets (v1.37, Team T3).
 *
 * A secret is granted to exactly one (bot, run, profile)
 * triple — never to "the bot" in general, never to "any run".
 * The grant carries:
 *
 *  - a TTL (the grant expires on its own),
 *  - a use budget (`maxUses`, 1 = single-use),
 *  - a purpose (shown to the auditor),
 *  - and the value — which lives in MEMORY ONLY. The value is
 *    never written to disk, never written to a log, never put
 *    into a report, a list, or an audit entry. The persisted
 *    grant file (`secret-grants.json`) and the audit log
 *    (`secret-audit.jsonl`) carry metadata only.
 *
 * Lifecycle:
 *  - `grant` — create a grant (value held in memory).
 *  - `consume` — hand the value out ONCE per use (the caller
 *    must not log or persist it). When uses run out the grant
 *    becomes `consumed` and the value is dropped from memory.
 *  - `revoke` — end one grant early (operator action).
 *  - `revokeRun` — end EVERY grant of a run (called when the
 *    run ends: a finished run leaves no credential behind).
 *  - `sweepExpired` — expire grants past their TTL.
 *
 * Every grant / consume / revoke / expiry is written to a
 * hash-chained audit log: each entry carries the sha-256 of
 * (previous hash + this entry without its own hash), so a
 * tampered log is detectable with `verifyAuditChain`. The
 * audit entries carry metadata only — `redactText` scrubs
 * live values out of any text before it is logged, so even a
 * caller that pastes a value into a log message cannot leak
 * it through this module.
 *
 * The v4 secret-request flow (ask → user fulfils in a modal)
 * and this module are complementary: v4 moves a value from
 * the user into memory; v5 scopes a value already in memory
 * to one bot/run/profile and kills it when the run ends.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  sandboxV5BotIdProblem,
  sandboxV5ProfileIdProblem,
  sandboxV5RunIdProblem,
  sandboxV5SecretNameProblem,
  type SandboxV5RunRevokeResult,
  type SandboxV5SecretAuditEntry,
  type SandboxV5SecretConsumeResult,
  type SandboxV5SecretGrant,
  type SandboxV5SecretGrantStatus,
  type SandboxV5SecretGrantSummary,
} from './types';

export const SANDBOX_V5_SECRET_GRANTS_FILE = 'secret-grants.json';
export const SANDBOX_V5_SECRET_AUDIT_FILE = 'secret-audit.jsonl';

/** Default base dir: OS temp dir / open-bot-sandbox-v5. */
export function defaultSandboxV5SecretBaseDir(): string {
  return path.join(os.tmpdir(), 'open-bot-sandbox-v5');
}

export interface SandboxV5SecretManagerOptions {
  /** Base dir for the grants file + audit log. */
  baseDir?: string;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

/** Input for granting a secret. */
export interface GrantSandboxV5SecretInput {
  /** Secret name (UPPER_CASE). */
  name: string;
  /** The secret value — memory only, never persisted. */
  value: string;
  /** Bot the grant is scoped to. */
  botId: string;
  /** Run the grant is scoped to. */
  runId: string;
  /** Profile the grant is scoped to. */
  profileId: string;
  /** Max consumes (default 1 = single-use). */
  maxUses?: number;
  /** TTL in ms (default 0 = never expires on its own — still revoked at run end). */
  ttlMs?: number;
  /** Who grants it. Default `system`. */
  grantedBy?: string;
  /** Why it is granted. */
  purpose?: string;
}

/** sha-256 hex of a string. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readGrantsFile(filePath: string): SandboxV5SecretGrant[] {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SandboxV5SecretGrant[];
  } catch {
    return [];
  }
}

function readAuditFile(filePath: string): SandboxV5SecretAuditEntry[] {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const out: SandboxV5SecretAuditEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as SandboxV5SecretAuditEntry);
      } catch {
        // Torn last line — skip.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Metadata-only summary of a grant (what lists / reports may show). */
export function summarizeSandboxV5Grant(grant: SandboxV5SecretGrant): SandboxV5SecretGrantSummary {
  return {
    id: grant.id,
    name: grant.name,
    botId: grant.botId,
    runId: grant.runId,
    profileId: grant.profileId,
    status: grant.status,
    maxUses: grant.maxUses,
    uses: grant.uses,
    createdAtMs: grant.createdAtMs,
    expiresAtMs: grant.expiresAtMs,
    endedAtMs: grant.endedAtMs,
    grantedBy: grant.grantedBy,
    endedBy: grant.endedBy,
    purpose: grant.purpose,
    endReason: grant.endReason,
  };
}

/**
 * Profile-scoped secret manager. Values live in the `values`
 * map (memory only); the grants file and the audit log carry
 * metadata only.
 */
export class SandboxV5SecretManager {
  readonly baseDir: string;
  private readonly grants: Map<string, SandboxV5SecretGrant> = new Map();
  private readonly values: Map<string, string> = new Map();
  private readonly nowMs: () => number;

  constructor(options: SandboxV5SecretManagerOptions = {}) {
    this.baseDir = options.baseDir ?? defaultSandboxV5SecretBaseDir();
    this.nowMs = options.nowMs ?? Date.now;
    // Grants persisted on disk are metadata only (no values) —
    // after a restart they load as `expired`: the value is gone
    // with the process, so a grant that survived a restart must
    // never hand out a value it no longer holds. Expired-on-load
    // is the safe reading of "value lost".
    for (const grant of readGrantsFile(path.join(this.baseDir, SANDBOX_V5_SECRET_GRANTS_FILE))) {
      if (grant.status === 'active') {
        grant.status = 'expired';
        grant.endedAtMs = this.nowMs();
        grant.endReason = 'value lost on restart (values are memory-only)';
      }
      this.grants.set(grant.id, grant);
    }
    this.persistGrants();
  }

  private persistGrants(): void {
    const file = path.join(this.baseDir, SANDBOX_V5_SECRET_GRANTS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const sorted = [...this.grants.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  private audit(
    grant: SandboxV5SecretGrant,
    event: SandboxV5SecretAuditEntry['event'],
    actor: string,
    detail: string,
  ): SandboxV5SecretAuditEntry {
    const file = path.join(this.baseDir, SANDBOX_V5_SECRET_AUDIT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = readAuditFile(file);
    const prevHash = existing.length > 0 ? (existing[existing.length - 1]?.hash ?? '') : '';
    const entry: SandboxV5SecretAuditEntry = {
      seq: existing.length + 1,
      atMs: this.nowMs(),
      grantId: grant.id,
      name: grant.name,
      botId: grant.botId,
      runId: grant.runId,
      profileId: grant.profileId,
      event,
      actor,
      detail,
      hash: '',
      prevHash,
    };
    const { hash: _ignored, ...withoutHash } = entry;
    void _ignored;
    entry.hash = sha256Hex(`${prevHash}${JSON.stringify(withoutHash)}`);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  /** Number of live (in-memory) values held right now. */
  liveValueCount(): number {
    return this.values.size;
  }

  /**
   * Scrub text of every live secret value (longest first, so a
   * value that contains another value is scrubbed whole).
   * Callers must run log text through this before logging.
   */
  redactText(text: string): string {
    let out = text;
    const values = [...this.values.values()].sort((a, b) => b.length - a.length);
    for (const value of values) {
      if (value !== '' && out.includes(value)) {
        out = out.split(value).join('[REDACTED]');
      }
    }
    return out;
  }

  /**
   * Grant a secret to one (bot, run, profile) triple. Validates
   * the name, the scope ids, the value (non-empty) and the use
   * budget. The value is held in memory only.
   */
  grant(input: GrantSandboxV5SecretInput): SandboxV5SecretGrantSummary {
    const nameProblem = sandboxV5SecretNameProblem(input.name);
    if (nameProblem !== '') throw new Error(nameProblem);
    const botProblem = sandboxV5BotIdProblem(input.botId);
    if (botProblem !== '') throw new Error(botProblem);
    const runProblem = sandboxV5RunIdProblem(input.runId);
    if (runProblem !== '') throw new Error(runProblem);
    const profileProblem = sandboxV5ProfileIdProblem(input.profileId);
    if (profileProblem !== '') throw new Error(profileProblem);
    if (input.value === '') throw new Error('Cannot grant an empty secret value.');
    const maxUses = input.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      throw new Error('maxUses must be an integer >= 1.');
    }
    const ttlMs = input.ttlMs ?? 0;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('ttlMs must be a finite number >= 0.');
    const now = this.nowMs();
    const grant: SandboxV5SecretGrant = {
      id: `grant-${randomUUID()}`,
      name: input.name,
      botId: input.botId,
      runId: input.runId,
      profileId: input.profileId,
      status: 'active',
      maxUses,
      uses: 0,
      createdAtMs: now,
      expiresAtMs: ttlMs > 0 ? now + ttlMs : 0,
      endedAtMs: 0,
      grantedBy: input.grantedBy ?? 'system',
      endedBy: '',
      purpose: input.purpose ?? '',
      endReason: '',
    };
    this.grants.set(grant.id, grant);
    this.values.set(grant.id, input.value);
    this.persistGrants();
    this.audit(
      grant,
      'granted',
      grant.grantedBy,
      `Granted ${grant.name} to ${grant.botId}/${grant.runId}/${grant.profileId} ` +
        `(maxUses=${maxUses}${ttlMs > 0 ? `, ttl=${ttlMs}ms` : ', no expiry'}).`,
    );
    return summarizeSandboxV5Grant(grant);
  }

  /** One grant's metadata (undefined when unknown). Never a value. */
  get(grantId: string): SandboxV5SecretGrantSummary | undefined {
    const grant = this.grants.get(grantId);
    return grant ? summarizeSandboxV5Grant(grant) : undefined;
  }

  /** All grants (metadata only), oldest first. */
  list(filter?: { botId?: string; runId?: string; profileId?: string; status?: SandboxV5SecretGrantStatus }): SandboxV5SecretGrantSummary[] {
    const out: SandboxV5SecretGrantSummary[] = [];
    for (const grant of this.grants.values()) {
      if (filter?.botId !== undefined && grant.botId !== filter.botId) continue;
      if (filter?.runId !== undefined && grant.runId !== filter.runId) continue;
      if (filter?.profileId !== undefined && grant.profileId !== filter.profileId) continue;
      if (filter?.status !== undefined && grant.status !== filter.status) continue;
      out.push(summarizeSandboxV5Grant(grant));
    }
    out.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return out;
  }

  /** Active grants for one run (what `revokeRun` would end). */
  listActiveForRun(botId: string, runId: string): SandboxV5SecretGrantSummary[] {
    return this.list({ botId, runId, status: 'active' });
  }

  /**
   * Consume a grant: hand the value out for one use. The caller
   * must be the scoped bot/run/profile — a consume from any
   * other scope throws and the grant is untouched. When uses
   * run out the grant becomes `consumed` and the value is
   * dropped from memory immediately.
   */
  consume(
    grantId: string,
    scope: { botId: string; runId: string; profileId: string },
  ): SandboxV5SecretConsumeResult {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error(`Unknown sandbox v5 secret grant "${grantId}".`);
    if (grant.status !== 'active') {
      throw new Error(`Grant "${grantId}" is ${grant.status} — it cannot be consumed.`);
    }
    if (grant.expiresAtMs > 0 && this.nowMs() >= grant.expiresAtMs) {
      this.endGrantWithEvent(grant, 'expired', 'system', 'TTL expired at consume time.', 'expired');
      throw new Error(`Grant "${grantId}" expired — it cannot be consumed.`);
    }
    if (
      grant.botId !== scope.botId ||
      grant.runId !== scope.runId ||
      grant.profileId !== scope.profileId
    ) {
      throw new Error(
        `Grant "${grantId}" is scoped to ${grant.botId}/${grant.runId}/${grant.profileId} — ` +
          `a consume from ${scope.botId}/${scope.runId}/${scope.profileId} is denied.`,
      );
    }
    const value = this.values.get(grantId);
    if (value === undefined) {
      throw new Error(`Grant "${grantId}" has no live value (lost on restart) — it cannot be consumed.`);
    }
    grant.uses += 1;
    const usesLeft = grant.maxUses - grant.uses;
    let status: SandboxV5SecretGrantStatus = 'active';
    if (usesLeft <= 0) {
      grant.status = 'consumed';
      grant.endedAtMs = this.nowMs();
      grant.endReason = 'use budget exhausted';
      this.values.delete(grantId);
      status = 'consumed';
    }
    this.persistGrants();
    this.audit(grant, 'consumed', `${scope.botId}/${scope.runId}`, `Consumed ${grant.name} (use ${grant.uses}/${grant.maxUses}).`);
    return { grantId, name: grant.name, value, usesLeft: Math.max(0, usesLeft), status };
  }

  /** Revoke one grant early. Returns false when unknown / already ended. */
  revoke(grantId: string, actor = 'system', reason = ''): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.status !== 'active') return false;
    this.endGrantWithEvent(grant, 'revoked', actor, reason !== '' ? reason : 'revoked by operator', 'revoked');
    return true;
  }

  /**
   * Revoke EVERY grant of a run — call when the run ends. A
   * finished run leaves no credential behind: values are
   * dropped from memory and the grants are marked revoked.
   */
  revokeRun(botId: string, runId: string, actor = 'system'): SandboxV5RunRevokeResult {
    const revokedGrantIds: string[] = [];
    const alreadyEndedGrantIds: string[] = [];
    for (const grant of this.grants.values()) {
      if (grant.botId !== botId || grant.runId !== runId) continue;
      if (grant.status !== 'active') {
        alreadyEndedGrantIds.push(grant.id);
        continue;
      }
      this.endGrantWithEvent(grant, 'revoked', actor, `run ${runId} ended`, 'revoked-run-end');
      revokedGrantIds.push(grant.id);
    }
    return { runId, botId, revokedGrantIds, alreadyEndedGrantIds, revokedAtMs: this.nowMs() };
  }

  /** Expire grants past their TTL. Returns the expired grant ids. */
  sweepExpired(now?: number): string[] {
    const nowMs = now ?? this.nowMs();
    const expired: string[] = [];
    for (const grant of this.grants.values()) {
      if (grant.status !== 'active') continue;
      if (grant.expiresAtMs > 0 && nowMs >= grant.expiresAtMs) {
        this.endGrantWithEvent(grant, 'expired', 'system', 'TTL expired.', 'expired');
        expired.push(grant.id);
      }
    }
    return expired;
  }

  /** Full audit log, oldest first (metadata only). */
  auditLog(): SandboxV5SecretAuditEntry[] {
    return readAuditFile(path.join(this.baseDir, SANDBOX_V5_SECRET_AUDIT_FILE));
  }

  /**
   * Verify the audit chain: every entry's prevHash must match
   * the previous entry's hash, and every hash must recompute.
   * Returns the problems (empty = the chain is intact).
   */
  verifyAuditChain(): string[] {
    const problems: string[] = [];
    const entries = this.auditLog();
    let prevHash = '';
    for (const entry of entries) {
      if (entry.prevHash !== prevHash) {
        problems.push(`Entry ${entry.seq}: prevHash mismatch (chain broken before this entry).`);
      }
      const { hash: _ignored, ...withoutHash } = entry;
      void _ignored;
      const recomputed = sha256Hex(`${entry.prevHash}${JSON.stringify(withoutHash)}`);
      if (recomputed !== entry.hash) {
        problems.push(`Entry ${entry.seq}: hash mismatch (entry was tampered with).`);
      }
      prevHash = entry.hash;
    }
    return problems;
  }

  private endGrant(
    grant: SandboxV5SecretGrant,
    status: 'revoked' | 'expired',
    actor: string,
    reason: string,
  ): void {
    grant.status = status;
    grant.endedAtMs = this.nowMs();
    grant.endedBy = actor;
    grant.endReason = reason;
    this.values.delete(grant.id);
    this.persistGrants();
  }

  private endGrantWithEvent(
    grant: SandboxV5SecretGrant,
    status: 'revoked' | 'expired',
    actor: string,
    reason: string,
    event: SandboxV5SecretAuditEntry['event'],
  ): void {
    this.endGrant(grant, status, actor, reason);
    this.audit(grant, event, actor, reason);
  }
}
