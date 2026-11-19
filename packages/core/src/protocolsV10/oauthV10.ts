/**
 * Protocols v10 — OAuth hardening (v1.41, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v141.md (section 1): the MCP spec
 * 2026-07-28 framework tightens OAuth — the client must
 * validate the token issuer (RFC 9207), and a token is bound
 * to the server that issued it, so a token stolen from one
 * server cannot be replayed at another. Dynamic Client
 * Registration is deprecated: new clients register
 * explicitly, or publish a Client ID Metadata Document the
 * server can fetch and validate. This module builds on the
 * v8 OAuth 2.1 layer (`protocolsV8/oauthV8.ts`: mandatory
 * PKCE S256, exact-match redirect URIs) and adds exactly
 * those three v10 rules, locally:
 *
 *   - Issuer validation (RFC 9207): the `iss` claim of a
 *     token (or of an authorization-server metadata
 *     document) must match the expected issuer exactly —
 *     same scheme, host and path, no trailing-slash games,
 *     no case games on the host, https only (loopback http
 *     only for local development servers).
 *   - Token binding: a token records the issuer that minted
 *     it plus an audience; presenting it to a different
 *     issuer, or to an audience that does not include the
 *     target server, is refused. A binding fingerprint
 *     (hash of issuer + audience + token id) lets the host
 *     detect a token that moved servers.
 *   - DCR deprecated: registering a client dynamically is
 *     refused by default and logged as a deprecation use;
 *     the supported paths are explicit registration (the
 *     host supplies client id + secret) and Client ID
 *     Metadata Documents (a JSON document at a well-known
 *     URL describing the client: redirect URIs, grant
 *     types, scope, client URI — validated structurally,
 *     never fetched by this module).
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no secrets are stored: tokens are opaque
 * strings the host supplies and this module only validates
 * their shape, issuer and binding. Client secrets never
 * leave the host.
 */

import { createHash } from 'node:crypto';

/** Error raised by the OAuth v10 layer. */
export class McpV10OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV10OAuthError';
    this.code = code;
  }
}

/** How Dynamic Client Registration is treated in v10. */
export const MCP_V10_DCR_STATUS = 'deprecated' as const;
/** Date DCR was deprecated (spec 2026-07-28). */
export const MCP_V10_DCR_DEPRECATED_SINCE = '2026-07-28';
/** Earliest removal under the 12-month deprecation policy. */
export const MCP_V10_DCR_EARLIEST_REMOVAL = '2027-07-28';

/** Registration paths a v10 client may use. */
export const MCP_V10_REGISTRATION_METHODS = ['explicit', 'client-id-metadata-document'] as const;
export type McpV10RegistrationMethod = (typeof MCP_V10_REGISTRATION_METHODS)[number];

/** A token as the host presents it for validation (opaque value, structured claims). */
export interface McpV10Token {
  /** Opaque token value (never logged; only its id is used in diagnostics). */
  value: string;
  /** Issuer that minted the token (`iss` claim). */
  issuer: string;
  /** Audience the token was minted for (`aud` claim, one or more servers). */
  audience: string | string[];
  /** Stable token id (`jti` claim, when present). */
  tokenId?: string;
  /** Expiry (seconds since epoch, `exp` claim). */
  expiresAtSec?: number;
  /** Scopes granted (`scope` claim, space-separated). */
  scope?: string;
}

/** A server the client talks to (the token's intended target). */
export interface McpV10ServerIdentity {
  /** Issuer URL the server claims (must match the token's `iss`). */
  issuer: string;
  /** Audience value the server expects (must be in the token's `aud`). */
  audience: string;
  /** Scopes the server requires for this call (subset check). */
  requiredScopes?: string[];
}

/**
 * Normalise an issuer URL for comparison: lowercase scheme
 * and host, drop a single trailing slash on the path (the
 * root path `/` becomes empty), keep the port when explicit.
 * Returns undefined when the value is not a parseable URL.
 */
export function normalizeMcpV10Issuer(issuer: string): string | undefined {
  if (typeof issuer !== 'string' || issuer.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${path}`;
}

/**
 * Validate an issuer URL structurally: https only (loopback
 * http allowed for local development), no userinfo, no
 * fragment, no query. Returns problems (empty when valid).
 */
export function validateMcpV10IssuerUrl(issuer: unknown, allowLoopbackHttp = true): string[] {
  const problems: string[] = [];
  if (typeof issuer !== 'string' || issuer.length === 0) {
    problems.push('Issuer must be a non-empty string URL.');
    return problems;
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    problems.push(`Issuer "${issuer}" is not a valid URL.`);
    return problems;
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if (url.protocol === 'http:' && !(allowLoopbackHttp && isLoopback)) {
    problems.push('Issuer must use https (http is only allowed for loopback development servers).');
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push(`Issuer must use https (got "${url.protocol}").`);
  }
  if (url.username !== '' || url.password !== '') problems.push('Issuer must not contain userinfo.');
  if (url.hash !== '') problems.push('Issuer must not contain a fragment.');
  if (url.search !== '') problems.push('Issuer must not contain a query string.');
  return problems;
}

/**
 * Validate a token's issuer against the expected issuer
 * (RFC 9207): exact match after normalisation. The check is
 * case-insensitive on scheme/host only — the path is
 * case-sensitive, and a trailing slash does not make two
 * different issuers equal when the paths differ.
 */
export function validateMcpV10TokenIssuer(
  tokenIssuer: unknown,
  expectedIssuer: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  problems.push(...validateMcpV10IssuerUrl(expectedIssuer));
  if (typeof tokenIssuer !== 'string' || tokenIssuer.length === 0) {
    problems.push('Token issuer (iss claim) is missing or empty.');
    return { ok: false, problems };
  }
  problems.push(...validateMcpV10IssuerUrl(tokenIssuer));
  if (problems.length > 0) return { ok: false, problems };
  const tokenNorm = normalizeMcpV10Issuer(tokenIssuer);
  const expectedNorm = normalizeMcpV10Issuer(expectedIssuer);
  if (tokenNorm === undefined || expectedNorm === undefined) {
    problems.push('Issuer could not be normalised for comparison.');
    return { ok: false, problems };
  }
  if (tokenNorm !== expectedNorm) {
    problems.push(
      `Token issuer "${tokenIssuer}" does not match the expected issuer "${expectedIssuer}" (RFC 9207: iss must match exactly).`,
    );
  }
  return { ok: problems.length === 0, problems };
}

/** Audience of a token, normalised to a list. */
export function mcpV10TokenAudiences(token: McpV10Token): string[] {
  return Array.isArray(token.audience) ? token.audience : [token.audience];
}

/**
 * Binding fingerprint: a short hash of issuer + audience +
 * token id. The host stores the fingerprint next to the
 * server it was issued for; a token presented elsewhere
 * produces a different fingerprint and is refused.
 */
export function mcpV10TokenBindingFingerprint(token: McpV10Token): string {
  const audiences = mcpV10TokenAudiences(token).slice().sort().join(' ');
  const material = [
    normalizeMcpV10Issuer(token.issuer) ?? token.issuer,
    audiences,
    token.tokenId ?? '',
  ].join('\n');
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/** Result of validating a token for one server. */
export interface McpV10TokenValidation {
  ok: boolean;
  problems: string[];
  /** Binding fingerprint (present when the token was structurally valid). */
  fingerprint?: string;
}

/**
 * Validate a token for a server: issuer must match (RFC
 * 9207), audience must include the server, required scopes
 * must be a subset of the granted scopes, and the token must
 * not be expired. The token value itself is never inspected
 * beyond its length — it stays opaque.
 */
export function validateMcpV10TokenForServer(
  token: McpV10Token,
  server: McpV10ServerIdentity,
  nowSec = Math.floor(Date.now() / 1000),
): McpV10TokenValidation {
  const problems: string[] = [];
  if (typeof token.value !== 'string' || token.value.length === 0) {
    problems.push('Token value must be a non-empty string.');
    return { ok: false, problems };
  }
  const issuer = validateMcpV10TokenIssuer(token.issuer, server.issuer);
  problems.push(...issuer.problems);
  const audiences = mcpV10TokenAudiences(token);
  if (audiences.length === 0 || audiences.some((a) => typeof a !== 'string' || a.length === 0)) {
    problems.push('Token audience (aud claim) must be a non-empty string or array of strings.');
  } else if (!audiences.includes(server.audience)) {
    problems.push(
      `Token is not bound to this server: audience ${JSON.stringify(audiences)} does not include "${server.audience}". A token minted for one server must never be replayed at another.`,
    );
  }
  if (typeof token.expiresAtSec === 'number') {
    if (token.expiresAtSec <= nowSec) problems.push('Token is expired (exp claim is in the past).');
  }
  if (server.requiredScopes && server.requiredScopes.length > 0) {
    const granted = new Set((token.scope ?? '').split(/\s+/).filter(Boolean));
    const missing = server.requiredScopes.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      problems.push(`Token is missing required scopes: ${missing.join(', ')}.`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, problems, fingerprint: mcpV10TokenBindingFingerprint(token) };
}

/**
 * Check a presented token against the binding the host
 * recorded when the token was issued: the fingerprint must
 * match, otherwise the token moved servers and is refused.
 */
export function checkMcpV10TokenBinding(
  token: McpV10Token,
  recordedFingerprint: string,
): { ok: boolean; problems: string[] } {
  const actual = mcpV10TokenBindingFingerprint(token);
  if (actual !== recordedFingerprint) {
    return {
      ok: false,
      problems: [
        'Token binding mismatch: this token was issued for a different server (issuer / audience / token id differ). Refusing replay across servers.',
      ],
    };
  }
  return { ok: true, problems: [] };
}

/** A client registered explicitly by the host (no DCR). */
export interface McpV10ExplicitClient {
  clientId: string;
  /** Registration method actually used. */
  method: McpV10RegistrationMethod;
  /** Redirect URIs (exact-match, validated by the v8 layer's rules). */
  redirectUris: string[];
  /** Grant types the client uses. */
  grantTypes: string[];
  /** Scopes the client may request. */
  scopes: string[];
  /** Public client URI (informational). */
  clientUri?: string;
}

/** Validate an explicit client registration. Returns problems. */
export function validateMcpV10ExplicitClient(client: unknown): string[] {
  const problems: string[] = [];
  if (typeof client !== 'object' || client === null || Array.isArray(client)) {
    problems.push('Client registration must be an object.');
    return problems;
  }
  const c = client as Record<string, unknown>;
  if (typeof c.clientId !== 'string' || c.clientId.length === 0) {
    problems.push('clientId must be a non-empty string.');
  }
  if (c.method !== 'explicit' && c.method !== 'client-id-metadata-document') {
    problems.push('Registration method must be "explicit" or "client-id-metadata-document" (Dynamic Client Registration is deprecated).');
  }
  if (!Array.isArray(c.redirectUris) || c.redirectUris.length === 0 || c.redirectUris.some((u) => typeof u !== 'string' || u.length === 0)) {
    problems.push('redirectUris must be a non-empty array of strings.');
  } else {
    for (const uri of c.redirectUris as string[]) {
      if (uri.includes('*')) problems.push(`Redirect URI "${uri}" must not contain a wildcard.`);
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        problems.push(`Redirect URI "${uri}" is not a valid URL.`);
        continue;
      }
      if (parsed.hash !== '') problems.push(`Redirect URI "${uri}" must not contain a fragment.`);
      const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost';
      if (parsed.protocol === 'http:' && !loopback) {
        problems.push(`Redirect URI "${uri}" must use https (http only for loopback).`);
      }
    }
  }
  if (!Array.isArray(c.grantTypes) || c.grantTypes.length === 0 || c.grantTypes.some((g) => typeof g !== 'string')) {
    problems.push('grantTypes must be a non-empty array of strings.');
  }
  if (!Array.isArray(c.scopes) || c.scopes.some((s) => typeof s !== 'string')) {
    problems.push('scopes must be an array of strings.');
  }
  if (c.clientUri !== undefined && typeof c.clientUri !== 'string') {
    problems.push('clientUri must be a string.');
  }
  return problems;
}

/** A Client ID Metadata Document (RFC 7591-style, served by the client). */
export interface McpV10ClientIdMetadataDocument {
  clientId: string;
  /** URL of the document itself (must be https, must match the fetch URL). */
  clientIdDocumentUrl: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  clientUri?: string;
  /** Token endpoint auth method the client uses. */
  tokenEndpointAuthMethod?: string;
}

/**
 * Validate a Client ID Metadata Document: the document URL
 * must be https, the client id must be that URL (the
 * document IS the client id), redirect URIs must be exact
 * and wildcard-free, grant types must be known. The module
 * never fetches the document — the host does.
 */
export function validateMcpV10ClientIdMetadataDocument(doc: unknown): string[] {
  const problems: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    problems.push('Client ID Metadata Document must be an object.');
    return problems;
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.clientIdDocumentUrl !== 'string' || d.clientIdDocumentUrl.length === 0) {
    problems.push('clientIdDocumentUrl must be a non-empty string.');
    return problems;
  }
  const urlProblems = validateMcpV10IssuerUrl(d.clientIdDocumentUrl, false);
  if (urlProblems.length > 0) {
    problems.push(`Client ID Metadata Document URL is invalid: ${urlProblems.join(' ')}`);
  }
  if (typeof d.clientId !== 'string' || d.clientId.length === 0) {
    problems.push('clientId must be a non-empty string.');
  } else if (d.clientId !== d.clientIdDocumentUrl) {
    problems.push('clientId must equal clientIdDocumentUrl: the document URL IS the client id.');
  }
  problems.push(
    ...validateMcpV10ExplicitClient({
      clientId: d.clientId,
      method: 'client-id-metadata-document',
      redirectUris: d.redirectUris,
      grantTypes: d.grantTypes,
      scopes: d.scopes,
      clientUri: d.clientUri,
    }),
  );
  const knownAuthMethods = ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'];
  if (d.tokenEndpointAuthMethod !== undefined && !knownAuthMethods.includes(d.tokenEndpointAuthMethod as string)) {
    problems.push(`tokenEndpointAuthMethod "${String(d.tokenEndpointAuthMethod)}" is not a known method (${knownAuthMethods.join(', ')}).`);
  }
  return problems;
}

/** One recorded use of a deprecated registration path (for the audit trail). */
export interface McpV10DcrUse {
  at: number;
  clientId?: string;
  reason: string;
}

/**
 * The DCR gate: Dynamic Client Registration is deprecated
 * and refused by default. The host may allow it explicitly
 * during migration, but every use is recorded so the audit
 * trail shows exactly who still relies on it.
 */
export class McpV10DcrGate {
  private readonly allowDcr: boolean;
  private readonly uses: McpV10DcrUse[] = [];

  constructor(allowDcr = false) {
    this.allowDcr = allowDcr;
  }

  /** Whether DCR is currently allowed (migration only). */
  get allowsDcr(): boolean {
    return this.allowDcr;
  }

  /**
   * Attempt a dynamic registration. Refused unless the host
   * explicitly allowed DCR; either way the attempt is logged.
   */
  attemptDynamicRegistration(clientId?: string): { allowed: boolean; problems: string[] } {
    const reason = this.allowDcr
      ? 'Dynamic Client Registration is deprecated (since 2026-07-28, earliest removal 2027-07-28); allowed only because the host enabled migration mode.'
      : 'Dynamic Client Registration is deprecated (since 2026-07-28, earliest removal 2027-07-28). Register explicitly or publish a Client ID Metadata Document instead.';
    this.uses.push({ at: Date.now(), clientId, reason });
    if (!this.allowDcr) {
      return { allowed: false, problems: [reason] };
    }
    return { allowed: true, problems: [reason] };
  }

  /** Recorded DCR uses (copy). */
  listUses(): McpV10DcrUse[] {
    return [...this.uses];
  }

  /** How many DCR attempts have been recorded. */
  get useCount(): number {
    return this.uses.length;
  }
}

/** Authorization-server metadata (validated structurally, never fetched here). */
export interface McpV10AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Registration endpoint, when the server still offers DCR (deprecated). */
  registrationEndpoint?: string;
  /** Whether the server supports PKCE S256 (required). */
  codeChallengeMethodsSupported?: string[];
}

/** Validate authorization-server metadata. Returns problems. */
export function validateMcpV10AuthServerMetadata(meta: unknown): string[] {
  const problems: string[] = [];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    problems.push('Authorization server metadata must be an object.');
    return problems;
  }
  const m = meta as Record<string, unknown>;
  problems.push(...validateMcpV10IssuerUrl(m.issuer));
  for (const field of ['authorizationEndpoint', 'tokenEndpoint'] as const) {
    const value = m[field];
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${field} must be a non-empty string URL.`);
    } else {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        problems.push(`${field} "${value}" is not a valid URL.`);
        continue;
      }
      if (url.protocol !== 'https:') problems.push(`${field} must use https.`);
    }
  }
  if (m.issuer !== undefined && typeof m.issuer === 'string') {
    // RFC 9207: the issuer in the metadata must be usable as
    // the expected issuer for token validation.
    const norm = normalizeMcpV10Issuer(m.issuer);
    if (norm === undefined) problems.push('issuer could not be normalised.');
  }
  if (m.codeChallengeMethodsSupported !== undefined) {
    if (!Array.isArray(m.codeChallengeMethodsSupported) || !m.codeChallengeMethodsSupported.includes('S256')) {
      problems.push('Authorization server must support PKCE S256 (code_challenge_methods_supported must include "S256").');
    }
  }
  if (typeof m.registrationEndpoint === 'string') {
    problems.push(
      'This server still offers a Dynamic Client Registration endpoint, which is deprecated (earliest removal 2027-07-28). Prefer explicit registration.',
    );
  }
  return problems;
}
