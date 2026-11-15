/**
 * Inline secret request — chat payload (v1.07, Team T4).
 *
 * Idea learned from OpenHands v1.28 (public release notes, 2026):
 * the agent asks for a secret via a modal right inside the
 * conversation instead of sending the user away to Settings. This
 * file is the PURE half of that flow: the shape of one request and
 * the payload the chat UI renders. The stateful half (pending
 * requests, timeouts, Vault writes) lives in `secretRequest.ts`.
 *
 * The golden rule of this module: a prompt NEVER carries a secret
 * value — only metadata (namespace, key, label, reason). The value
 * travels in exactly one direction: user → `resolveSecret` → Vault.
 * Nothing here logs, formats or returns a value.
 */

/** Lifecycle of one inline secret request. */
export type SecretRequestStatus =
  | 'pending'
  | 'fulfilled'
  | 'declined'
  | 'expired'
  | 'cancelled';

/** One inline secret request (metadata only — never a value). */
export interface SecretRequest {
  /** Stable id (also the id the UI sends back to resolve/decline). */
  id: string;
  /** Vault namespace, e.g. `composio`, `media-keys`. */
  namespace: string;
  /** Vault key inside the namespace, e.g. `api-key`. */
  key: string;
  /** Human-readable label shown in the prompt, e.g. "Composio API key". */
  label: string;
  /** Optional hint shown under the input (never a value or a partial key). */
  hint?: string;
  /** Why the secret is needed, e.g. "to call the image model". */
  reason?: string;
  /** Tool that asked, e.g. `generate_image` (for the audit trail). */
  requestedBy?: string;
  status: SecretRequestStatus;
  /** Epoch ms when the request was created. */
  createdAtMs: number;
  /** Epoch ms when the request expires if unanswered. */
  expiresAtMs: number;
  /** Epoch ms when the request reached its terminal status (when not pending). */
  finishedAtMs?: number;
  /** Reason for a decline/cancel (user-supplied or system). */
  finishReason?: string;
}

/**
 * What the chat UI renders for a pending request: an inline prompt
 * (modal / input row) with a password field. The renderer MUST treat
 * this as the only source of truth for what to show — it must never
 * invent extra fields, and it must never display a value (there is
 * none here to display).
 */
export interface SecretRequestPrompt {
  kind: 'secret-request';
  requestId: string;
  namespace: string;
  key: string;
  label: string;
  hint?: string;
  reason?: string;
  requestedBy?: string;
  /** Always `password`: the input masks what the user types. */
  inputType: 'password';
  /** The user may decline instead of answering. */
  cancellable: boolean;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Hard limits for an inline secret value (a pasted key is short; a PEM is longer — 4k covers both). */
export const MAX_SECRET_REQUEST_VALUE_CHARS = 4096;
/** Default time a request stays answerable (5 minutes). */
export const DEFAULT_SECRET_REQUEST_TIMEOUT_MS = 300_000;
/** Smallest / largest timeout a caller may ask for (10s … 1h). */
export const MIN_SECRET_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_SECRET_REQUEST_TIMEOUT_MS = 3_600_000;
/** How many finished requests the service remembers (for status lookups). */
export const MAX_SECRET_REQUEST_HISTORY = 200;

/** Build the chat payload for a pending request. Pure — no I/O, no value involved. */
export function createSecretRequestPrompt(request: SecretRequest): SecretRequestPrompt {
  return {
    kind: 'secret-request',
    requestId: request.id,
    namespace: request.namespace,
    key: request.key,
    label: request.label,
    ...(request.hint !== undefined ? { hint: request.hint } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    ...(request.requestedBy !== undefined ? { requestedBy: request.requestedBy } : {}),
    inputType: 'password',
    cancellable: true,
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

/** One-line text fallback for a prompt (plain-text chat / logs). Never includes a value. */
export function formatSecretRequestMessage(prompt: SecretRequestPrompt): string {
  const lines = [
    `Cần secret: ${prompt.label} (${prompt.namespace}:${prompt.key})`,
  ];
  if (prompt.requestedBy) lines.push(`Tool yêu cầu: ${prompt.requestedBy}`);
  if (prompt.reason) lines.push(`Lý do: ${prompt.reason}`);
  if (prompt.hint) lines.push(`Gợi ý: ${prompt.hint}`);
  lines.push('Nhập secret vào ô mật khẩu (sẽ lưu vào Vault) hoặc từ chối — agent sẽ chờ.');
  return lines.join('\n');
}

/** Validate a user-supplied secret value (never logs the value). */
export function validateSecretValue(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'Secret phải là chuỗi.' };
  }
  if (value.trim() === '') {
    return { ok: false, reason: 'Secret không được để trống.' };
  }
  if (value.length > MAX_SECRET_REQUEST_VALUE_CHARS) {
    return {
      ok: false,
      reason: `Secret quá dài (${value.length} ký tự, tối đa ${MAX_SECRET_REQUEST_VALUE_CHARS}).`,
    };
  }
  return { ok: true };
}

/** Validate a Vault namespace/key name (same rule as Vault itself). */
export function isValidSecretName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Clamp a requested timeout into the allowed range. */
export function clampSecretRequestTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_SECRET_REQUEST_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SECRET_REQUEST_TIMEOUT_MS,
    Math.max(MIN_SECRET_REQUEST_TIMEOUT_MS, Math.floor(timeoutMs)),
  );
}
