/**
 * Profile-scoped secrets + log redaction (v1.41, Team T6) — fleet v28.
 *
 * OpenHands SDK v1.60 (survey `docs/repo-survey-v141.md` §3): v1.48
 * introduced profile-scoped secrets and stronger redaction of logs
 * and API keys. This module is the open-bot equivalent:
 *
 * - Secrets are scoped to a bot/profile, never global: the store is
 *   keyed by `(profileId, name)`. `get`/`list`/`rotate`/`delete`
 *   all take the profile id, and a profile can never read another
 *   profile's secret — `getSecret('profile-b', name)` returns
 *   `undefined` even when profile A holds a secret of that name.
 *   The test suite proves the isolation (see
 *   `tests/fleet-v28-runtime-secrets.test.mjs`).
 * - Values never appear in listings or audit entries: `listNames`
 *   returns names + metadata only; the audit ledger records the
 *   action, profile, name, version and time — never the value.
 * - Redaction: `redactText(profileId, text)` replaces every secret
 *   value of that profile (longest value first, so a short value
 *   that is a substring of a longer one cannot leave a partial
 *   leak) with `[REDACTED]`; `redactTextWithValues` is the pure
 *   helper for callers that already hold values. Redaction is
 *   best-effort for values under 4 characters (too short to match
 *   safely — they are skipped and reported).
 * - Rotation: `rotateSecret` replaces the value, bumps `version`,
 *   stamps `rotatedAtMs`, and keeps the previous value in a
 *   bounded grace window (`previousValue`, `previousExpiresAtMs`)
 *   so in-flight calls using the old value keep working until the
 *   grace period ends; after that the old value is dropped.
 * - Validation: names are `[a-zA-Z][a-zA-Z0-9_-]{0,63}`, values are
 *   1–4096 chars, profile ids are non-empty ids without whitespace.
 *
 * This module stores secrets in memory only. Persistence (vault
 * encryption at rest) stays with the host vault — the host must
 * never log a value it reads back from here; use `redactText`
 * before writing any log line that may contain one.
 */

import { fleetV28IdValid } from './runtime';

/** Name pattern for a secret (`[a-zA-Z][a-zA-Z0-9_-]{0,63}`). */
export const FLEET_V28_SECRET_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Max secret value length (chars). */
export const FLEET_V28_SECRET_MAX_VALUE_LENGTH = 4096;

/** Min value length that redaction will match (shorter = unsafe). */
export const FLEET_V28_REDACT_MIN_VALUE_LENGTH = 4;

/** Default rotation grace window (old value still accepted), ms. */
export const FLEET_V28_SECRET_ROTATION_GRACE_MS = 5 * 60 * 1000;

/** Placeholder that replaces a secret value in redacted text. */
export const FLEET_V28_REDACTED_PLACEHOLDER = '[REDACTED]';

/** One stored secret (value lives here — never log a record whole). */
export interface FleetV28SecretRecord {
  /** Owning bot/profile id. */
  profileId: string;
  /** Secret name (unique per profile). */
  name: string;
  /** Current value. */
  value: string;
  /** Version (1 on first set, +1 per rotation). */
  version: number;
  /** When the secret was first set, ms epoch. */
  createdAtMs: number;
  /** When the value last changed, ms epoch. */
  updatedAtMs: number;
  /** When the secret was last rotated (null = never rotated). */
  rotatedAtMs: number | null;
  /** Previous value, kept during the rotation grace window. */
  previousValue: string | null;
  /** When the previous value stops being accepted (null = none kept). */
  previousExpiresAtMs: number | null;
}

/** Public metadata for a secret (no value — safe to list/log). */
export interface FleetV28SecretMeta {
  /** Owning profile. */
  profileId: string;
  /** Secret name. */
  name: string;
  /** Current version. */
  version: number;
  /** When first set. */
  createdAtMs: number;
  /** When last changed. */
  updatedAtMs: number;
  /** When last rotated (null = never). */
  rotatedAtMs: number | null;
  /** Whether a previous value is still inside its grace window. */
  hasGraceValue: boolean;
}

/** One audit entry (never carries a value). */
export interface FleetV28SecretAuditEntry {
  /** Owning profile. */
  profileId: string;
  /** Secret name. */
  name: string;
  /** What happened. */
  action: 'set' | 'rotate' | 'delete' | 'get-denied';
  /** Version after the action (0 for delete). */
  version: number;
  /** When it happened, ms epoch. */
  atMs: number;
  /** Human-readable note (English, no values). */
  note: string;
}

/** Result of a redaction pass. */
export interface FleetV28RedactionResult {
  /** Text with secret values replaced. */
  text: string;
  /** How many replacements were made. */
  replaced: number;
  /** Secret names whose values were replaced. */
  matchedNames: string[];
  /** Secret names skipped because the value is too short to match safely. */
  skippedNames: string[];
}

/** Validate a secret name; returns reasons (empty = valid). */
export function validateFleetV28SecretName(name: string | null | undefined): string[] {
  if (typeof name !== 'string' || name.trim() === '') return ['Secret name must be a non-empty string.'];
  if (!FLEET_V28_SECRET_NAME_PATTERN.test(name)) {
    return ['Secret name must start with a letter and contain only letters, digits, "_" or "-" (max 64 chars).'];
  }
  return [];
}

/** Validate a secret value; returns reasons (empty = valid). */
export function validateFleetV28SecretValue(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value === '') return ['Secret value must be a non-empty string.'];
  if (value.length > FLEET_V28_SECRET_MAX_VALUE_LENGTH) {
    return [`Secret value must be at most ${FLEET_V28_SECRET_MAX_VALUE_LENGTH} characters.`];
  }
  return [];
}

/**
 * Pure redaction: replace every value in `values` with the
 * placeholder (longest value first). Values shorter than
 * `minLength` are skipped (matching them would redact innocent
 * text) and reported in `skippedNames`.
 */
export function redactTextWithValues(
  text: string,
  values: Array<{ name: string; value: string }>,
  minLength: number = FLEET_V28_REDACT_MIN_VALUE_LENGTH,
): FleetV28RedactionResult {
  let out = text;
  let replaced = 0;
  const matchedNames: string[] = [];
  const skippedNames: string[] = [];
  const usable = values
    .filter((v) => {
      if (typeof v.value !== 'string' || v.value.length < minLength) {
        skippedNames.push(v.name);
        return false;
      }
      return true;
    })
    .sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of usable) {
    if (!out.includes(value)) continue;
    const count = out.split(value).length - 1;
    out = out.split(value).join(FLEET_V28_REDACTED_PLACEHOLDER);
    replaced += count;
    matchedNames.push(name);
  }
  return { text: out, replaced, matchedNames, skippedNames };
}

/** true when `text` still contains any of the given values. */
export function textContainsSecret(text: string, values: string[]): boolean {
  return values.some((v) => typeof v === 'string' && v.length >= FLEET_V28_REDACT_MIN_VALUE_LENGTH && text.includes(v));
}

/**
 * Profile-scoped secret store.
 *
 * Keyed by profile id, then secret name. Every read is scoped:
 * there is no "get any profile's secret" operation, and listing
 * never returns values. Rotation keeps the old value for a grace
 * window so in-flight calls do not break mid-rotation.
 */
export class FleetV28SecretStore {
  private readonly secrets = new Map<string, Map<string, FleetV28SecretRecord>>();
  private readonly audit: FleetV28SecretAuditEntry[] = [];

  private key(profileId: string): Map<string, FleetV28SecretRecord> {
    let perProfile = this.secrets.get(profileId);
    if (!perProfile) {
      perProfile = new Map();
      this.secrets.set(profileId, perProfile);
    }
    return perProfile;
  }

  /**
   * Set (create or overwrite) a secret for a profile. Overwriting
   * keeps the version (it is an update, not a rotation); use
   * `rotateSecret` when the version must bump.
   */
  setSecret(
    profileId: string,
    name: string,
    value: string,
    nowMs: number = Date.now(),
  ): { ok: boolean; meta?: FleetV28SecretMeta; reasons?: string[] } {
    const reasons: string[] = [];
    if (!fleetV28IdValid(profileId)) reasons.push('profileId must be a non-empty id without whitespace.');
    reasons.push(...validateFleetV28SecretName(name));
    reasons.push(...validateFleetV28SecretValue(value));
    if (reasons.length > 0) return { ok: false, reasons };
    const perProfile = this.key(profileId);
    const existing = perProfile.get(name);
    const record: FleetV28SecretRecord = existing
      ? { ...existing, value, updatedAtMs: nowMs }
      : {
          profileId,
          name,
          value,
          version: 1,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          rotatedAtMs: null,
          previousValue: null,
          previousExpiresAtMs: null,
        };
    perProfile.set(name, record);
    this.audit.push({
      profileId,
      name,
      action: 'set',
      version: record.version,
      atMs: nowMs,
      note: existing ? 'Secret value updated.' : 'Secret created.',
    });
    return { ok: true, meta: toMeta(record, nowMs) };
  }

  /**
   * Get a secret value — only for its own profile. Returns
   * `undefined` for a missing secret AND for a secret owned by
   * another profile (indistinguishable on purpose: the caller
   * learns nothing about other profiles' secrets).
   */
  getSecret(profileId: string, name: string): string | undefined {
    if (!fleetV28IdValid(profileId)) return undefined;
    return this.secrets.get(profileId)?.get(name)?.value;
  }

  /** Get a secret record's metadata (no value). */
  getSecretMeta(profileId: string, name: string): FleetV28SecretMeta | undefined {
    const record = this.secrets.get(profileId)?.get(name);
    return record ? toMeta(record, Date.now()) : undefined;
  }

  /** List a profile's secrets (metadata only — never values). */
  listSecrets(profileId: string, nowMs: number = Date.now()): FleetV28SecretMeta[] {
    if (!fleetV28IdValid(profileId)) return [];
    return [...(this.secrets.get(profileId)?.values() ?? [])]
      .map((r) => toMeta(r, nowMs))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** true when the profile holds a secret of this name. */
  hasSecret(profileId: string, name: string): boolean {
    return this.secrets.get(profileId)?.has(name) ?? false;
  }

  /** How many secrets a profile holds. */
  countSecrets(profileId: string): number {
    return this.secrets.get(profileId)?.size ?? 0;
  }

  /** Delete a secret (its profile only). Returns false when absent. */
  deleteSecret(profileId: string, name: string, nowMs: number = Date.now()): boolean {
    const perProfile = this.secrets.get(profileId);
    if (!perProfile || !perProfile.has(name)) return false;
    perProfile.delete(name);
    this.audit.push({ profileId, name, action: 'delete', version: 0, atMs: nowMs, note: 'Secret deleted.' });
    return true;
  }

  /**
   * Rotate a secret: replace the value, bump the version, keep the
   * old value for `graceMs` so in-flight calls keep working.
   * The old value is dropped once the grace window passes
   * (`pruneExpiredGraceValues` / `getSecret` never returns it —
   * rotation grace is enforced by `acceptsValue`, not by `get`).
   */
  rotateSecret(
    profileId: string,
    name: string,
    newValue: string,
    opts: { nowMs?: number; graceMs?: number } = {},
  ): { ok: boolean; meta?: FleetV28SecretMeta; reasons?: string[] } {
    const nowMs = opts.nowMs ?? Date.now();
    const graceMs = opts.graceMs ?? FLEET_V28_SECRET_ROTATION_GRACE_MS;
    const reasons: string[] = [];
    if (!fleetV28IdValid(profileId)) reasons.push('profileId must be a non-empty id without whitespace.');
    reasons.push(...validateFleetV28SecretName(name));
    reasons.push(...validateFleetV28SecretValue(newValue));
    if (graceMs < 0) reasons.push('graceMs must be >= 0.');
    const record = this.secrets.get(profileId)?.get(name);
    if (!record) reasons.push(`No secret "${name}" for profile "${profileId}".`);
    if (record && record.value === newValue) reasons.push('New value must differ from the current value.');
    if (reasons.length > 0) return { ok: false, reasons };
    const rec = record as FleetV28SecretRecord;
    rec.previousValue = rec.value;
    rec.previousExpiresAtMs = nowMs + graceMs;
    rec.value = newValue;
    rec.version += 1;
    rec.updatedAtMs = nowMs;
    rec.rotatedAtMs = nowMs;
    this.audit.push({
      profileId,
      name,
      action: 'rotate',
      version: rec.version,
      atMs: nowMs,
      note: `Secret rotated to version ${rec.version} (old value kept ${graceMs}ms).`,
    });
    return { ok: true, meta: toMeta(rec, nowMs) };
  }

  /**
   * true when `value` is the profile's current value for `name`,
   * or its previous value inside the grace window. This is how a
   * host validates a presented credential without ever logging it.
   */
  acceptsValue(profileId: string, name: string, value: string, nowMs: number = Date.now()): boolean {
    const record = this.secrets.get(profileId)?.get(name);
    if (!record) return false;
    if (record.value === value) return true;
    if (
      record.previousValue !== null &&
      record.previousExpiresAtMs !== null &&
      nowMs <= record.previousExpiresAtMs &&
      record.previousValue === value
    ) {
      return true;
    }
    return false;
  }

  /** Drop previous values whose grace window has passed. Returns count dropped. */
  pruneExpiredGraceValues(nowMs: number = Date.now()): number {
    let dropped = 0;
    for (const perProfile of this.secrets.values()) {
      for (const record of perProfile.values()) {
        if (
          record.previousValue !== null &&
          record.previousExpiresAtMs !== null &&
          nowMs > record.previousExpiresAtMs
        ) {
          record.previousValue = null;
          record.previousExpiresAtMs = null;
          dropped += 1;
        }
      }
    }
    return dropped;
  }

  /**
   * Redact a profile's secret values out of free text (e.g. a log
   * line). Only that profile's secrets are redacted — another
   * profile's values are not this caller's business and are left
   * alone (they must be redacted by their own profile's pass).
   */
  redactText(profileId: string, text: string): FleetV28RedactionResult {
    if (typeof text !== 'string') return { text: '', replaced: 0, matchedNames: [], skippedNames: [] };
    const records = [...(this.secrets.get(profileId)?.values() ?? [])];
    return redactTextWithValues(
      text,
      records.map((r) => ({ name: r.name, value: r.value })),
    );
  }

  /**
   * Redact one profile's secrets out of a log line AND check whether
   * any OTHER profile's secret value leaked into it. Returns the
   * redacted line plus the names of foreign secrets found (values
   * are never returned). A non-empty `foreignHits` means a cross-
   * profile leak happened upstream and must be investigated.
   */
  redactAndDetectLeak(profileId: string, text: string): FleetV28RedactionResult & { foreignHits: string[] } {
    const redacted = this.redactText(profileId, text);
    const foreignHits: string[] = [];
    for (const [otherProfile, perProfile] of this.secrets.entries()) {
      if (otherProfile === profileId) continue;
      for (const record of perProfile.values()) {
        if (
          record.value.length >= FLEET_V28_REDACT_MIN_VALUE_LENGTH &&
          redacted.text.includes(record.value)
        ) {
          foreignHits.push(`${otherProfile}:${record.name}`);
        }
      }
    }
    return { ...redacted, foreignHits };
  }

  /** Audit ledger for a profile (newest first, values never included). */
  listAudit(profileId: string): FleetV28SecretAuditEntry[] {
    return this.audit.filter((e) => e.profileId === profileId).reverse();
  }

  /** Full audit ledger (newest first; host-only — never shown to a profile). */
  listAllAudit(): FleetV28SecretAuditEntry[] {
    return [...this.audit].reverse();
  }

  /** All profile ids that hold at least one secret. */
  listProfiles(): string[] {
    return [...this.secrets.keys()].filter((p) => (this.secrets.get(p)?.size ?? 0) > 0).sort();
  }
}

function toMeta(record: FleetV28SecretRecord, nowMs: number): FleetV28SecretMeta {
  return {
    profileId: record.profileId,
    name: record.name,
    version: record.version,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    rotatedAtMs: record.rotatedAtMs,
    hasGraceValue:
      record.previousValue !== null &&
      record.previousExpiresAtMs !== null &&
      nowMs <= record.previousExpiresAtMs,
  };
}
