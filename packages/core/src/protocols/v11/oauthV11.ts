/**
 * Protocols v11 — OAuth issuer (`iss`) validation (v1.42, Team T2).
 *
 * Idea only, learned from the public MCP 2.0 description in
 * docs/repo-survey-v142.md (section 2): OAuth `iss`
 * validation is mandatory in MCP 2.0. A token's `iss` claim
 * must match the issuer the client expects (RFC 9207); a
 * mismatch is a hard reject, never a warning. No code, text
 * or asset from any other repo is copied here. No network is
 * opened by this module: every function here validates values
 * the host supplies (tokens, metadata documents, issuer
 * strings) — discovery of those documents is the host's job.
 *
 * What this module owns:
 *  - Issuer URL validation + normalisation (https only, no
 *    fragment / query / userinfo, host required, one trailing
 *    slash stripped).
 *  - `validateMcpV11TokenIssuer()`: the token `iss` claim
 *    must exactly match the expected issuer; `exp` / `iat`
 *    are checked against the clock with a small skew
 *    allowance; `aud` is checked when the host passes one.
 *  - Authorization-server metadata validation: the metadata
 *    document's `issuer` must equal the expected issuer, and
 *    the endpoints the client needs must be present.
 *  - Protected-resource metadata validation: the resource
 *    must name its authorization servers, and the expected
 *    issuer must be among them.
 *  - Token binding: a fingerprint binds a token to its
 *    issuing server (sha256 of issuer + token value, first
 *    16 hex chars — a hash, never the token itself).
 */

import { createHash } from 'node:crypto';

/** A decoded token, as the host supplies it (never fetched here). */
export interface McpV11Token {
  /** Opaque token value (used only for the binding fingerprint). */
  value: string;
  /** Issuer claim (`iss`). */
  issuer: string;
  /** Audience claim (`aud`): string or list. */
  audience?: string | string[];
  /** Optional token id for audit logs. */
  tokenId?: string;
  /** Expiry, seconds since epoch. */
  expiresAtSec?: number;
  /** Issued-at, seconds since epoch. */
  issuedAtSec?: number;
  /** Scope string, space separated. */
  scope?: string;
}

/** Outcome of an issuer validation. */
export interface McpV11IssuerValidation {
  valid: boolean;
  /** Every problem found (empty when valid). */
  problems: string[];
  /** Normalised expected issuer (when it parsed). */
  expectedIssuer?: string;
  /** Normalised token issuer (when it parsed). */
  tokenIssuer?: string;
}

/** Error raised by the OAuth v11 layer. */
export class McpV11OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV11OAuthError';
    this.code = code;
  }
}

/** Clock-skew allowance for `exp` / `iat` checks (seconds). */
export const MCP_V11_OAUTH_CLOCK_SKEW_SEC = 60;

/**
 * Normalise an issuer URL: parse it, require https, drop one
 * trailing slash. Returns null when the URL is not usable.
 */
export function normalizeMcpV11IssuerUrl(issuer: string): string | null {
  if (typeof issuer !== 'string' || !issuer) return null;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hash || url.search || url.username || url.password) return null;
  if (!url.hostname) return null;
  const path = url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Validate an issuer URL string. Returns problems (empty = valid). */
export function validateMcpV11IssuerUrl(issuer: unknown): string[] {
  const problems: string[] = [];
  if (typeof issuer !== 'string' || !issuer) return ['issuer must be a non-empty string.'];
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [`issuer "${issuer}" is not a valid URL.`];
  }
  if (url.protocol !== 'https:') problems.push(`issuer "${issuer}" must use https (got "${url.protocol}").`);
  if (url.hash) problems.push('issuer must not contain a fragment (#...).');
  if (url.search) problems.push('issuer must not contain a query string (?...) — the issuer is the bare origin + path.');
  if (url.username || url.password) problems.push('issuer must not contain userinfo (user:pass@).');
  if (!url.hostname) problems.push('issuer must contain a host.');
  if (issuer.endsWith('/')) problems.push('issuer must not end with a trailing slash.');
  return problems;
}

/**
 * Validate a token against its expected issuer (RFC 9207).
 * The `iss` claim must exactly match the expected issuer
 * after normalisation; anything else is a hard reject.
 * `exp` (when present) must be in the future and `iat`
 * (when present) must not be in the future, both with a
 * 60-second skew allowance. When `expectedAudience` is
 * passed, the token's `aud` must contain it.
 */
export function validateMcpV11TokenIssuer(
  token: McpV11Token,
  expectedIssuer: string,
  opts: { expectedAudience?: string; nowSec?: number; clockSkewSec?: number } = {},
): McpV11IssuerValidation {
  const problems: string[] = [];
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? MCP_V11_OAUTH_CLOCK_SKEW_SEC;

  const expectedProblems = validateMcpV11IssuerUrl(expectedIssuer);
  if (expectedProblems.length > 0) {
    return { valid: false, problems: ['expected issuer is invalid: ' + expectedProblems.join(' ')] };
  }
  const expected = normalizeMcpV11IssuerUrl(expectedIssuer) as string;

  if (typeof token !== 'object' || token === null) {
    return { valid: false, problems: ['token must be an object.'], expectedIssuer: expected };
  }
  if (typeof token.value !== 'string' || !token.value) {
    problems.push('token.value is required.');
  }
  if (typeof token.issuer !== 'string' || !token.issuer) {
    problems.push('token.iss is required (MCP 2.0 mandates iss validation).');
  } else {
    // The token iss is compared after normalisation (one trailing
    // slash is stripped), so a token issued for "https://host/"
    // still matches "https://host" — but a token whose iss is not
    // even a usable issuer URL (http, fragment, userinfo) is rejected.
    const tokenIssuer = normalizeMcpV11IssuerUrl(token.issuer);
    if (!tokenIssuer) {
      problems.push('token iss is not a valid issuer URL: ' + validateMcpV11IssuerUrl(token.issuer).join(' '));
    } else {
      if (tokenIssuer !== expected) {
        problems.push(
          `token iss "${tokenIssuer}" does not match the expected issuer "${expected}" (RFC 9207: exact match required).`,
        );
      }
      if (problems.length === 0) return finish(tokenIssuer);
    }
  }
  return finish(undefined);

  function finish(tokenIssuer?: string): McpV11IssuerValidation {
    if (token.expiresAtSec !== undefined) {
      if (typeof token.expiresAtSec !== 'number' || Number.isNaN(token.expiresAtSec)) {
        problems.push('token.exp must be a number (seconds since epoch).');
      } else if (token.expiresAtSec + skew < nowSec) {
        problems.push('token is expired (exp is in the past).');
      }
    }
    if (token.issuedAtSec !== undefined) {
      if (typeof token.issuedAtSec !== 'number' || Number.isNaN(token.issuedAtSec)) {
        problems.push('token.iat must be a number (seconds since epoch).');
      } else if (token.issuedAtSec - skew > nowSec) {
        problems.push('token.iat is in the future (beyond clock skew).');
      }
    }
    if (opts.expectedAudience !== undefined) {
      const aud = token.audience;
      const list = Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : [];
      if (!list.includes(opts.expectedAudience)) {
        problems.push(`token aud does not include the expected audience "${opts.expectedAudience}".`);
      }
    }
    return {
      valid: problems.length === 0,
      problems,
      expectedIssuer: expected,
      ...(tokenIssuer ? { tokenIssuer } : {}),
    };
  }
}

/** Authorization-server metadata document (RFC 8414). */
export interface McpV11AuthServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  [key: string]: unknown;
}

/** Validate an authorization-server metadata document against its expected issuer. */
export function validateMcpV11AuthServerMetadata(
  metadata: unknown,
  expectedIssuer: string,
): string[] {
  const problems: string[] = [];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return ['authorization server metadata must be an object.'];
  }
  const m = metadata as Record<string, unknown>;
  const expected = normalizeMcpV11IssuerUrl(expectedIssuer);
  if (!expected) {
    problems.push('expected issuer is not a valid issuer URL.');
    return problems;
  }
  if (typeof m.issuer !== 'string' || !m.issuer) {
    problems.push('metadata.issuer is required.');
  } else {
    const metaIssuer = normalizeMcpV11IssuerUrl(m.issuer);
    if (!metaIssuer) problems.push(`metadata.issuer "${m.issuer}" is not a valid issuer URL.`);
    else if (metaIssuer !== expected) {
      problems.push(`metadata.issuer "${metaIssuer}" does not match the expected issuer "${expected}".`);
    }
  }
  if (typeof m.authorization_endpoint !== 'string' || !m.authorization_endpoint) {
    problems.push('metadata.authorization_endpoint is required.');
  } else if (!m.authorization_endpoint.startsWith('https://')) {
    problems.push('metadata.authorization_endpoint must use https.');
  }
  if (typeof m.token_endpoint !== 'string' || !m.token_endpoint) {
    problems.push('metadata.token_endpoint is required.');
  } else if (!m.token_endpoint.startsWith('https://')) {
    problems.push('metadata.token_endpoint must use https.');
  }
  if (m.response_types_supported !== undefined) {
    if (!Array.isArray(m.response_types_supported) || !m.response_types_supported.includes('code')) {
      problems.push('metadata.response_types_supported must include "code".');
    }
  }
  return problems;
}

/** Protected-resource metadata document (RFC 9728). */
export interface McpV11ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  [key: string]: unknown;
}

/** Validate protected-resource metadata: the expected issuer must be listed as an authorization server. */
export function validateMcpV11ProtectedResourceMetadata(
  metadata: unknown,
  expectedIssuer: string,
): string[] {
  const problems: string[] = [];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return ['protected resource metadata must be an object.'];
  }
  const m = metadata as Record<string, unknown>;
  if (typeof m.resource !== 'string' || !m.resource) {
    problems.push('metadata.resource is required.');
  }
  if (!Array.isArray(m.authorization_servers) || m.authorization_servers.length === 0) {
    problems.push('metadata.authorization_servers must be a non-empty array.');
    return problems;
  }
  const expected = normalizeMcpV11IssuerUrl(expectedIssuer);
  if (!expected) {
    problems.push('expected issuer is not a valid issuer URL.');
    return problems;
  }
  const listed = (m.authorization_servers as unknown[]).map((s) =>
    typeof s === 'string' ? normalizeMcpV11IssuerUrl(s) : null,
  );
  if (!listed.includes(expected)) {
    problems.push(`expected issuer "${expected}" is not listed in metadata.authorization_servers.`);
  }
  return problems;
}

/**
 * Fingerprint binding a token to its issuing server: the
 * first 16 hex chars of sha256(issuer + ':' + token value).
 * A hash only — the token value itself never leaves this function.
 */
export function mcpV11TokenBindingFingerprint(issuer: string, tokenValue: string): string {
  return createHash('sha256').update(`${issuer}:${tokenValue}`).digest('hex').slice(0, 16);
}

/** Check a token binding: does the fingerprint match the (issuer, token) pair? */
export function checkMcpV11TokenBinding(
  fingerprint: string,
  issuer: string,
  tokenValue: string,
): boolean {
  return fingerprint === mcpV11TokenBindingFingerprint(issuer, tokenValue);
}
