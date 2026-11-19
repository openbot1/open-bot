/**
 * Protocols v8 — OAuth 2.1 / OIDC alignment (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (section 1): the MCP spec
 * 2026-07-28 framework adds OAuth Client Credentials and
 * Enterprise Managed Authorization as extensions, aligned
 * with OAuth 2.1 / OIDC. OAuth 2.1 makes PKCE mandatory for
 * authorization-code flows and tightens redirect URIs; this
 * module implements exactly those rules, locally:
 *
 *   - PKCE (S256) is MANDATORY: a code challenge must be
 *     `BASE64URL(SHA256(code_verifier))`, the verifier is
 *     43–128 characters from the unreserved set, and plain
 *     (`plain`) challenges are refused. No challenge, no
 *     authorization request.
 *   - Redirect URIs are EXACT-matched against the registered
 *     list: https only, except loopback http (`127.0.0.1`,
 *     `[::1]`, `localhost`) which may use http; no fragment,
 *     no wildcard, no userinfo, no open-redirect prefix
 *     matching, no trailing-slash games (exact string match).
 *   - Client Credentials grant: machine-to-machine, scoped,
 *     short-lived, no user involved; the client authenticates
 *     with its own credential (never a user password).
 *   - Enterprise Managed Authorization: the client advertises
 *     that authorization is managed by the enterprise — it
 *     never prompts the user for consent it does not own, and
 *     a managed client that asks for user consent is refused.
 *   - OIDC discovery documents are validated structurally
 *     (issuer https, endpoints https, required fields) before
 *     the host trusts them; the module never fetches them.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no secrets are stored: tokens are opaque
 * strings the host supplies and this module only validates
 * their shape and expiry. Private keys / client secrets never
 * leave the host.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Error raised by the OAuth 2.1 / OIDC layer. */
export class McpV8OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV8OAuthError';
    this.code = code;
  }
}

/** PKCE code-challenge method. Only S256 is allowed (OAuth 2.1). */
export const MCP_V8_PKCE_METHOD = 'S256' as const;
/** PKCE verifier length bounds (RFC 7636 / OAuth 2.1). */
export const MCP_V8_PKCE_VERIFIER_MIN = 43;
export const MCP_V8_PKCE_VERIFIER_MAX = 128;
/** Characters allowed in a PKCE verifier. */
export const MCP_V8_PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Generate a random PKCE verifier (43–128 unreserved chars). */
export function generateMcpV8PkceVerifier(length = 64): string {
  if (!Number.isInteger(length) || length < MCP_V8_PKCE_VERIFIER_MIN || length > MCP_V8_PKCE_VERIFIER_MAX) {
    throw new McpV8OAuthError(
      'invalid-verifier-length',
      `PKCE verifier length must be ${MCP_V8_PKCE_VERIFIER_MIN}–${MCP_V8_PKCE_VERIFIER_MAX} (got ${length}).`,
    );
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Compute the S256 code challenge for a verifier. */
export function mcpV8PkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Validate a PKCE verifier's shape. Returns problems (empty when valid). */
export function validateMcpV8PkceVerifier(verifier: unknown): string[] {
  const problems: string[] = [];
  if (typeof verifier !== 'string') {
    problems.push('PKCE code_verifier must be a string.');
    return problems;
  }
  if (!MCP_V8_PKCE_VERIFIER_RE.test(verifier)) {
    problems.push(
      `PKCE code_verifier must be ${MCP_V8_PKCE_VERIFIER_MIN}–${MCP_V8_PKCE_VERIFIER_MAX} characters from [A-Za-z0-9-._~] (got ${verifier.length} chars).`,
    );
  }
  return problems;
}

/**
 * Verify a PKCE challenge: the challenge must equal
 * `BASE64URL(SHA256(verifier))` and the method must be S256.
 * `plain` is refused (OAuth 2.1 makes S256 mandatory).
 */
export function verifyMcpV8Pkce(
  verifier: string,
  challenge: string,
  method: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (method !== MCP_V8_PKCE_METHOD) {
    problems.push(`PKCE code_challenge_method must be "S256" (OAuth 2.1); got "${method}". "plain" is refused.`);
  }
  problems.push(...validateMcpV8PkceVerifier(verifier));
  if (typeof challenge !== 'string' || challenge.length === 0) {
    problems.push('PKCE code_challenge is required.');
  } else if (method === MCP_V8_PKCE_METHOD && problems.length === 0) {
    const expected = mcpV8PkceChallengeS256(verifier);
    if (challenge !== expected) problems.push('PKCE code_challenge does not match the code_verifier (S256).');
  }
  return { ok: problems.length === 0, problems };
}

/** A registered OAuth client (as the authorization server sees it). */
export interface McpV8OAuthClient {
  /** Client id. */
  clientId: string;
  /** Exact redirect URIs registered for this client (exact-match only). */
  redirectUris: string[];
  /** Whether the client is confidential (has a secret) or public (PKCE-only). */
  confidential: boolean;
  /** Whether authorization is enterprise-managed (never prompts the user). */
  enterpriseManaged: boolean;
  /** Scopes the client may request. */
  allowedScopes: string[];
}

/** Validate a redirect URI's shape (before exact-matching it). */
export function validateMcpV8RedirectUriShape(uri: unknown): string[] {
  const problems: string[] = [];
  if (typeof uri !== 'string' || uri.length === 0) {
    problems.push('redirect_uri must be a non-empty string.');
    return problems;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    problems.push(`redirect_uri "${uri}" is not a valid absolute URL.`);
    return problems;
  }
  if (parsed.hash.length > 0) {
    problems.push(`redirect_uri "${uri}" must not contain a fragment.`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    problems.push(`redirect_uri "${uri}" must not contain userinfo.`);
  }
  if (uri.includes('*')) {
    problems.push(`redirect_uri "${uri}" must not contain a wildcard.`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'localhost';
  if (parsed.protocol === 'https:') {
    // https is always fine (any host).
  } else if (parsed.protocol === 'http:' && isLoopback) {
    // Loopback http is the OAuth 2.1 exception for native / local clients.
  } else {
    problems.push(
      `redirect_uri "${uri}" must use https (http is allowed only for loopback hosts 127.0.0.1 / [::1] / localhost).`,
    );
  }
  return problems;
}

/** True when the host is a loopback host (http redirect exception). */
export function mcpV8IsLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === 'localhost';
}

/**
 * Exact-match a redirect URI against a registered list. The
 * match is a plain string equality — no prefix matching, no
 * trailing-slash normalisation, no case folding of the path.
 * Returns the matched URI, or undefined.
 */
export function matchMcpV8RedirectUri(
  requested: string,
  registered: readonly string[],
): string | undefined {
  return registered.find((r) => r === requested);
}

/** An authorization request (what the client sends to the authorization server). */
export interface McpV8AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  /** Scopes requested (space-separated in the wire form; array here). */
  scope: string[];
  /** Response type: only `code` (authorization-code flow). */
  responseType: string;
  /** PKCE challenge (S256, mandatory). */
  codeChallenge: string;
  /** PKCE method (must be S256). */
  codeChallengeMethod: string;
  /** Opaque state the client round-trips (CSRF protection). */
  state: string;
  /** Optional OIDC nonce. */
  nonce?: string;
}

/** Validate an authorization request against a registered client. */
export function validateMcpV8AuthorizationRequest(
  request: McpV8AuthorizationRequest,
  client: McpV8OAuthClient,
): string[] {
  const problems: string[] = [];
  if (request.clientId !== client.clientId) {
    problems.push(`Unknown client_id "${request.clientId}".`);
    return problems;
  }
  if (request.responseType !== 'code') {
    problems.push(`response_type must be "code" (authorization-code flow); got "${request.responseType}". Implicit flow is refused in OAuth 2.1.`);
  }
  problems.push(...validateMcpV8RedirectUriShape(request.redirectUri));
  if (problems.length === 0 && matchMcpV8RedirectUri(request.redirectUri, client.redirectUris) === undefined) {
    problems.push(
      `redirect_uri "${request.redirectUri}" is not registered for client "${client.clientId}" (exact match required; registered: ${client.redirectUris.join(', ') || 'none'}).`,
    );
  }
  if (typeof request.codeChallenge !== 'string' || request.codeChallenge.length === 0) {
    problems.push('PKCE code_challenge is required (OAuth 2.1 makes PKCE mandatory).');
  }
  if (request.codeChallengeMethod !== MCP_V8_PKCE_METHOD) {
    problems.push(`code_challenge_method must be "S256" (got "${request.codeChallengeMethod}").`);
  }
  if (typeof request.state !== 'string' || request.state.length < 8) {
    problems.push('state must be an opaque value of at least 8 characters (CSRF protection).');
  }
  for (const scope of request.scope) {
    if (!client.allowedScopes.includes(scope)) {
      problems.push(`Scope "${scope}" is not allowed for client "${client.clientId}".`);
    }
  }
  if (client.enterpriseManaged) {
    problems.push(
      'Client is enterprise-managed: the user must not be prompted for consent. Authorization is granted by the enterprise, not by an interactive consent screen.',
    );
  }
  return problems;
}

/**
 * Build an authorization request URL (query string) from a
 * validated request. The caller must have validated the
 * request first; this only serialises it.
 */
export function buildMcpV8AuthorizationUrl(
  authorizationEndpoint: string,
  request: McpV8AuthorizationRequest,
): string {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('response_type', request.responseType);
  url.searchParams.set('scope', request.scope.join(' '));
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
  url.searchParams.set('state', request.state);
  if (request.nonce !== undefined) url.searchParams.set('nonce', request.nonce);
  return url.toString();
}

/** A token request (authorization-code exchange). */
export interface McpV8TokenRequest {
  grantType: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  clientId: string;
  scope?: string[];
}

/** Validate a token request (authorization-code exchange with PKCE). */
export function validateMcpV8TokenRequest(
  request: McpV8TokenRequest,
  expected: { code: string; redirectUri: string; codeChallenge: string; clientId: string },
): string[] {
  const problems: string[] = [];
  if (request.grantType !== 'authorization_code') {
    problems.push(`grant_type must be "authorization_code" (got "${request.grantType}").`);
  }
  if (request.clientId !== expected.clientId) {
    problems.push(`client_id "${request.clientId}" does not match the authorization request.`);
  }
  if (request.code !== expected.code) {
    problems.push('Authorization code does not match the issued code.');
  }
  if (request.redirectUri !== expected.redirectUri) {
    problems.push('redirect_uri must be identical to the one in the authorization request (exact match).');
  }
  if (typeof request.codeVerifier !== 'string' || request.codeVerifier.length === 0) {
    problems.push('code_verifier is required (PKCE is mandatory in OAuth 2.1).');
  } else {
    const check = verifyMcpV8Pkce(request.codeVerifier, expected.codeChallenge, MCP_V8_PKCE_METHOD);
    problems.push(...check.problems);
  }
  return problems;
}

/** Client Credentials grant request (machine-to-machine). */
export interface McpV8ClientCredentialsRequest {
  grantType: 'client_credentials';
  clientId: string;
  scope: string[];
  /** How the client authenticates (secret / private-key JWT / none for public clients is refused here). */
  clientAuth: 'client_secret' | 'private_key_jwt' | 'tls_client_auth';
}

/** Validate a Client Credentials grant request. */
export function validateMcpV8ClientCredentials(
  request: McpV8ClientCredentialsRequest,
  client: McpV8OAuthClient,
): string[] {
  const problems: string[] = [];
  if (request.grantType !== 'client_credentials') {
    problems.push(`grant_type must be "client_credentials" (got "${request.grantType}").`);
  }
  if (request.clientId !== client.clientId) {
    problems.push(`Unknown client_id "${request.clientId}".`);
    return problems;
  }
  if (client.confidential === false) {
    problems.push('Client Credentials grant needs a confidential client (a public client cannot authenticate itself).');
  }
  for (const scope of request.scope) {
    if (!client.allowedScopes.includes(scope)) {
      problems.push(`Scope "${scope}" is not allowed for client "${client.clientId}".`);
    }
  }
  if (request.scope.length === 0) {
    problems.push('Client Credentials grant needs at least one scope.');
  }
  return problems;
}

/** A token the host issued / received (opaque value + metadata). */
export interface McpV8TokenInfo {
  /** Token type (always Bearer here). */
  tokenType: 'Bearer';
  /** Scopes the token carries. */
  scope: string[];
  /** Lifetime in seconds. */
  expiresIn: number;
  /** When the token was issued (ms since epoch). */
  issuedAtMs: number;
  /** Client the token was issued to. */
  clientId: string;
  /** Whether the token came from an enterprise-managed authorization. */
  enterpriseManaged: boolean;
}

/** Validate token metadata (shape + expiry), never the token value itself. */
export function validateMcpV8TokenInfo(
  token: McpV8TokenInfo,
  nowMs: number,
): string[] {
  const problems: string[] = [];
  if (token.tokenType !== 'Bearer') {
    problems.push(`token_type must be "Bearer" (got "${token.tokenType}").`);
  }
  if (!Array.isArray(token.scope) || token.scope.length === 0) {
    problems.push('Token must carry at least one scope.');
  }
  if (!Number.isInteger(token.expiresIn) || token.expiresIn <= 0) {
    problems.push('expires_in must be a positive integer (seconds).');
  } else if (token.expiresIn > 3600) {
    problems.push(`expires_in is ${token.expiresIn}s; MCP access tokens should live at most 3600s (1 hour).`);
  }
  if (typeof token.clientId !== 'string' || token.clientId.length === 0) {
    problems.push('Token needs a client_id.');
  }
  if (nowMs >= token.issuedAtMs + token.expiresIn * 1000) {
    problems.push('Token is expired.');
  }
  return problems;
}

/** True when the token is expired at `nowMs`. */
export function mcpV8TokenIsExpired(token: McpV8TokenInfo, nowMs: number): boolean {
  return nowMs >= token.issuedAtMs + token.expiresIn * 1000;
}

/** OIDC discovery document (as fetched by the host — this module never fetches). */
export interface McpV8OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

/** Validate an OIDC discovery document structurally. */
export function validateMcpV8OidcDiscovery(doc: McpV8OidcDiscovery): string[] {
  const problems: string[] = [];
  const httpsFields: [string, string | undefined][] = [
    ['issuer', doc.issuer],
    ['authorization_endpoint', doc.authorizationEndpoint],
    ['token_endpoint', doc.tokenEndpoint],
    ['jwks_uri', doc.jwksUri],
    ['userinfo_endpoint', doc.userinfoEndpoint],
    ['registration_endpoint', doc.registrationEndpoint],
  ];
  for (const [field, value] of httpsFields) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`OIDC discovery field "${field}" must be a non-empty string.`);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      problems.push(`OIDC discovery field "${field}" ("${value}") is not a valid absolute URL.`);
      continue;
    }
    if (parsed.protocol !== 'https:') {
      problems.push(`OIDC discovery field "${field}" ("${value}") must use https.`);
    }
  }
  if (typeof doc.issuer !== 'string' || doc.issuer.length === 0) {
    problems.push('OIDC discovery needs an issuer.');
  }
  if (typeof doc.authorizationEndpoint !== 'string' || doc.authorizationEndpoint.length === 0) {
    problems.push('OIDC discovery needs an authorization_endpoint.');
  }
  if (typeof doc.tokenEndpoint !== 'string' || doc.tokenEndpoint.length === 0) {
    problems.push('OIDC discovery needs a token_endpoint.');
  }
  if (typeof doc.jwksUri !== 'string' || doc.jwksUri.length === 0) {
    problems.push('OIDC discovery needs a jwks_uri.');
  }
  if (doc.issuer !== undefined && doc.authorizationEndpoint !== undefined) {
    try {
      const issuerHost = new URL(doc.issuer).hostname;
      const authHost = new URL(doc.authorizationEndpoint).hostname;
      if (issuerHost !== authHost) {
        problems.push(`OIDC authorization_endpoint host "${authHost}" does not match the issuer host "${issuerHost}".`);
      }
    } catch {
      // Already reported above.
    }
  }
  if (doc.codeChallengeMethodsSupported !== undefined
    && !doc.codeChallengeMethodsSupported.includes('S256')) {
    problems.push('OIDC provider must support the S256 PKCE method (OAuth 2.1).');
  }
  if (doc.responseTypesSupported !== undefined
    && !doc.responseTypesSupported.includes('code')) {
    problems.push('OIDC provider must support the "code" response type (authorization-code flow).');
  }
  return problems;
}

/** Enterprise Managed Authorization: a managed-client advertisement. */
export interface McpV8ManagedAuthorization {
  /** Client id. */
  clientId: string;
  /** Enterprise / tenant that manages the authorization. */
  managedBy: string;
  /** Scopes the enterprise granted (the client may not ask for more). */
  grantedScopes: string[];
  /** When the grant expires (ms since epoch; undefined = until revoked). */
  expiresAtMs?: number;
}

/** Validate a managed-authorization grant. */
export function validateMcpV8ManagedAuthorization(
  grant: McpV8ManagedAuthorization,
  nowMs: number,
): string[] {
  const problems: string[] = [];
  if (typeof grant.clientId !== 'string' || grant.clientId.length === 0) {
    problems.push('Managed authorization needs a client_id.');
  }
  if (typeof grant.managedBy !== 'string' || grant.managedBy.length === 0) {
    problems.push('Managed authorization needs a managedBy enterprise / tenant.');
  }
  if (!Array.isArray(grant.grantedScopes) || grant.grantedScopes.length === 0) {
    problems.push('Managed authorization needs at least one granted scope.');
  }
  if (grant.expiresAtMs !== undefined && nowMs >= grant.expiresAtMs) {
    problems.push('Managed authorization grant is expired.');
  }
  return problems;
}

/** True when a scope request fits inside a managed grant. */
export function mcpV8ManagedScopeAllowed(
  grant: McpV8ManagedAuthorization,
  scope: readonly string[],
): boolean {
  return scope.every((s) => grant.grantedScopes.includes(s));
}
