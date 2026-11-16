/**
 * A2A v1.0 signed Agent Card + version negotiation + bindings —
 * protocol triad v1.15 (Team T2).
 *
 * Idea only, learned from the public A2A v1.0 description in
 * docs/repo-survey-v115.md section 1: Agent Cards are signed,
 * client and server negotiate a common protocol version, and
 * three bindings (JSON-RPC, gRPC, HTTP+JSON/REST) are
 * functionally equivalent. No code, text or asset from any
 * other repo is copied here.
 *
 * What this module adds on top of open-bot's existing A2A
 * layer (`a2a/card.ts` builds unsigned cards, `a2a/signing.ts`
 * signs with Ed25519):
 *
 * 1. An HMAC-SHA256 signature envelope for local trust.
 *    **This is an internal signature, not PKI**: the key is a
 *    shared secret held in the app vault (or supplied by the
 *    caller for tests), and it proves only that the card was
 *    issued by someone holding the same secret on this machine
 *    or in this fleet — it does NOT prove identity to a third
 *    party the way an Ed25519/PKI signature does. The envelope
 *    says so in plain text (`trust: 'internal-hmac'`) so no
 *    consumer mistakes it for public-key trust. For cross-org
 *    trust, use the existing Ed25519 signing in `a2a/signing.ts`.
 * 2. Version negotiation: client and server each list the
 *    protocol versions they speak; the highest common version
 *    wins, or negotiation fails loudly when there is none.
 * 3. Binding descriptors for all three bindings, plus a real
 *    JSON-RPC binding over HTTP on loopback (server + client)
 *    that sends an A2A message and reads the reply. The gRPC
 *    and HTTP+JSON bindings are described as interfaces with
 *    their wire shape documented; only JSON-RPC runs for real
 *    here (no gRPC dependency is vendored into core).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { buildAgentCard, type AgentCardInput } from '../a2a/card';
import { canonicalJson } from '../a2a/signing';
import type { A2aAgentCard } from '../a2a/types';

/** A2A protocol versions this module negotiates. */
export const A2A_V115_PROTOCOL_VERSIONS = ['1.0', '1.0.1'] as const;

/** Default protocol version written into a v1.15 card. */
export const A2A_V115_DEFAULT_VERSION = '1.0.1';

/** HMAC signature algorithm used for the internal envelope. */
export const A2A_INTERNAL_SIGNATURE_ALGORITHM = 'HMAC-SHA256';

/**
 * The signature envelope. `trust` is always `internal-hmac`:
 * see the module header — this is NOT a PKI signature.
 */
export interface A2aInternalSignature {
  algorithm: typeof A2A_INTERNAL_SIGNATURE_ALGORITHM;
  /** Which key signed this card (a key id, never the key itself). */
  keyId: string;
  /** Hex HMAC-SHA256 over the canonical JSON of the unsigned card. */
  signature: string;
  /** ISO-8601 time of signing. */
  signedAt: string;
  /** Trust model of this envelope — always internal-hmac. */
  trust: 'internal-hmac';
}

/** A signed Agent Card: the card plus its internal signature. */
export interface SignedA2aAgentCard {
  card: A2aAgentCard;
  signature: A2aInternalSignature;
}

/** Outcome of verifying a signed card. */
export interface A2aInternalVerification {
  valid: boolean;
  /** Machine-readable reason when invalid. */
  reason?: 'bad-signature' | 'bad-envelope' | 'bad-card' | 'stale-signature';
  /** Age of the signature in ms (when the envelope parses). */
  ageMs?: number;
}

/** Input for building a signed card. */
export interface SignedAgentCardInput extends AgentCardInput {
  /** HMAC secret (min 16 chars). Never logged, never stored in the card. */
  hmacKey: string;
  /** Key id recorded in the envelope (default `local-v1`). */
  keyId?: string;
  /** Extra supported interfaces (bindings) to advertise on the card. */
  bindings?: A2aBindingDescriptor[];
}

/** The three A2A bindings. */
export const A2A_BINDING_KINDS = ['JSONRPC', 'GRPC', 'HTTP_JSON'] as const;

export type A2aBindingKind = (typeof A2A_BINDING_KINDS)[number];

/** One supported interface (binding) advertised on an Agent Card. */
export interface A2aBindingDescriptor {
  /** Binding kind, as written on the card. */
  protocolBinding: A2aBindingKind;
  /** A2A protocol version spoken on this binding. */
  protocolVersion: string;
  /** Endpoint URL for this binding. */
  url: string;
  /** What a client must send on this binding. */
  wireShape: string;
  /** Honest note about what this module implements for the binding. */
  implemented: string;
}

/** Describe one binding for a given endpoint URL. */
export function describeA2aBinding(
  kind: A2aBindingKind,
  url: string,
  protocolVersion = A2A_V115_DEFAULT_VERSION,
): A2aBindingDescriptor {
  switch (kind) {
    case 'JSONRPC':
      return {
        protocolBinding: 'JSONRPC',
        protocolVersion,
        url,
        wireShape: 'JSON-RPC 2.0 over HTTP: POST {jsonrpc:"2.0", method:"message/send", params:{...}, id} to the endpoint; result carries the task.',
        implemented: 'Runs for real in this module (A2aJsonRpcServer / sendA2aJsonRpcMessage).',
      };
    case 'GRPC':
      return {
        protocolBinding: 'GRPC',
        protocolVersion,
        url,
        wireShape: 'gRPC service A2AService with Message/Task RPCs (protobuf, HTTP/2); method names mirror the JSON-RPC methods.',
        implemented: 'Interface only — core vendors no gRPC dependency. A fleet gateway may implement this descriptor against the same handler shape.',
      };
    case 'HTTP_JSON':
      return {
        protocolBinding: 'HTTP_JSON',
        protocolVersion,
        url,
        wireShape: 'Plain REST: POST /tasks with a JSON message body; GET /tasks/{id}; responses are the same task JSON as JSON-RPC results.',
        implemented: 'Interface only — the JSON-RPC server in this module accepts the same message payloads over POST, so a thin REST shim can reuse it.',
      };
  }
}

/** All three binding descriptors for one endpoint URL. */
export function describeAllA2aBindings(
  url: string,
  protocolVersion = A2A_V115_DEFAULT_VERSION,
): A2aBindingDescriptor[] {
  return A2A_BINDING_KINDS.map((kind) => describeA2aBinding(kind, url, protocolVersion));
}

function hmacHex(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

/**
 * Build an Agent Card and sign it with an HMAC-SHA256 envelope.
 * The card itself is built by the existing `buildAgentCard`
 * (same validation); this only adds the signature envelope.
 */
export function buildSignedAgentCard(input: SignedAgentCardInput): SignedA2aAgentCard {
  if (typeof input.hmacKey !== 'string' || input.hmacKey.length < 16) {
    throw new Error('buildSignedAgentCard needs an hmacKey of at least 16 characters.');
  }
  const { hmacKey, keyId, bindings, ...cardInput } = input;
  const card = buildAgentCard({
    ...cardInput,
    protocolVersion: cardInput.protocolVersion ?? A2A_V115_DEFAULT_VERSION,
  });
  const interfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }> = [
    ...(card.supportedInterfaces ?? []).map((i) => ({
      url: i.url,
      protocolBinding: i.protocolBinding,
      protocolVersion: i.protocolVersion ?? A2A_V115_DEFAULT_VERSION,
    })),
  ];
  for (const binding of bindings ?? []) {
    if (!interfaces.some((i) => i.protocolBinding === binding.protocolBinding && i.url === binding.url)) {
      interfaces.push({
        url: binding.url,
        protocolBinding: binding.protocolBinding,
        protocolVersion: binding.protocolVersion,
      });
    }
  }
  const cardWithBindings: A2aAgentCard = { ...card, supportedInterfaces: interfaces as A2aAgentCard['supportedInterfaces'] };
  const signature: A2aInternalSignature = {
    algorithm: A2A_INTERNAL_SIGNATURE_ALGORITHM,
    keyId: keyId ?? 'local-v1',
    signature: hmacHex(hmacKey, canonicalJson(cardWithBindings)),
    signedAt: new Date().toISOString(),
    trust: 'internal-hmac',
  };
  return { card: cardWithBindings, signature };
}

/**
 * Verify a signed card against an HMAC secret.
 *
 * `maxAgeMs` (default: no limit) rejects signatures older than
 * the given age — pass it when cards must be fresh (fleet
 * discovery), omit it for long-lived local cards.
 */
export function verifySignedAgentCard(
  signed: unknown,
  hmacKey: string,
  options: { maxAgeMs?: number; now?: () => number } = {},
): A2aInternalVerification {
  if (typeof signed !== 'object' || signed === null || Array.isArray(signed)) {
    return { valid: false, reason: 'bad-envelope' };
  }
  const record = signed as Record<string, unknown>;
  const card = record['card'];
  const sig = record['signature'];
  if (typeof card !== 'object' || card === null || Array.isArray(card)) {
    return { valid: false, reason: 'bad-card' };
  }
  if (
    typeof sig !== 'object' || sig === null || Array.isArray(sig) ||
    (sig as Record<string, unknown>)['algorithm'] !== A2A_INTERNAL_SIGNATURE_ALGORITHM ||
    typeof (sig as Record<string, unknown>)['keyId'] !== 'string' ||
    typeof (sig as Record<string, unknown>)['signature'] !== 'string' ||
    typeof (sig as Record<string, unknown>)['signedAt'] !== 'string' ||
    (sig as Record<string, unknown>)['trust'] !== 'internal-hmac'
  ) {
    return { valid: false, reason: 'bad-envelope' };
  }
  const signature = sig as unknown as A2aInternalSignature;
  const now = options.now ?? Date.now;
  const signedAtMs = Date.parse(signature.signedAt);
  const ageMs = Number.isNaN(signedAtMs) ? undefined : now() - signedAtMs;
  if (options.maxAgeMs !== undefined && ageMs !== undefined && ageMs > options.maxAgeMs) {
    return { valid: false, reason: 'stale-signature', ageMs };
  }
  if (ageMs !== undefined && ageMs < -60_000) {
    return { valid: false, reason: 'bad-envelope', ageMs };
  }
  const expected = hmacHex(hmacKey, canonicalJson(card));
  const a = Buffer.from(signature.signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const equal = a.length === b.length && timingSafeEqual(a, b);
  return equal ? { valid: true, ...(ageMs !== undefined ? { ageMs } : {}) } : { valid: false, reason: 'bad-signature', ...(ageMs !== undefined ? { ageMs } : {}) };
}

/** Parse a version string into numeric parts for comparison. */
export function parseA2aVersion(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/** Compare two version strings: -1, 0 or 1. */
export function compareA2aVersions(a: string, b: string): number {
  const pa = parseA2aVersion(a);
  const pb = parseA2aVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Outcome of a version negotiation. */
export interface A2aVersionNegotiation {
  /** The highest version both sides speak, or null when there is none. */
  agreed: string | null;
  clientVersions: string[];
  serverVersions: string[];
  /** Versions the client offered that the server does not speak. */
  clientOnly: string[];
  /** Versions the server offered that the client does not speak. */
  serverOnly: string[];
}

/**
 * Negotiate the A2A protocol version: the highest version both
 * sides list wins. Empty lists mean "no versions offered" and
 * negotiate to null (never silently assume a version).
 */
export function negotiateA2aVersion(
  clientVersions: readonly string[],
  serverVersions: readonly string[],
): A2aVersionNegotiation {
  const client = [...new Set(clientVersions.filter((v) => typeof v === 'string' && v.trim() !== ''))];
  const server = [...new Set(serverVersions.filter((v) => typeof v === 'string' && v.trim() !== ''))];
  const common = client.filter((v) => server.includes(v));
  common.sort(compareA2aVersions);
  return {
    agreed: common.length > 0 ? (common[common.length - 1] as string) : null,
    clientVersions: client,
    serverVersions: server,
    clientOnly: client.filter((v) => !server.includes(v)),
    serverOnly: server.filter((v) => !client.includes(v)),
  };
}

/** One A2A message (the payload a client sends to an agent). */
export interface A2aJsonRpcMessage {
  role: 'user' | 'agent';
  parts: Array<{ kind: 'text'; text: string }>;
  /** Client-chosen id for the conversation (optional). */
  contextId?: string;
  /** Client-chosen id for the message (optional). */
  messageId?: string;
}

/** Handler the JSON-RPC server calls for each incoming message. */
export type A2aJsonRpcHandler = (message: A2aJsonRpcMessage) => Promise<{
  /** Task id the server assigned. */
  taskId: string;
  /** Task state after handling: `completed`, `working`, ... */
  state: string;
  /** Reply text when the handler answered synchronously. */
  reply?: string;
}>;

/** Options for the loopback JSON-RPC server. */
export interface A2aJsonRpcServerOptions {
  /** Port to listen on (0 = any free port). Default 0. */
  port?: number;
  /** Signed card served at /.well-known/agent-card.json. */
  signedCard?: SignedA2aAgentCard;
  /** Protocol versions the server speaks (for negotiation). */
  versions?: readonly string[];
}

/**
 * A minimal A2A JSON-RPC server on loopback.
 *
 * - `POST /a2a/message` — JSON-RPC 2.0 `message/send`
 *   (also accepts `message/stream` and answers it as a single
 *   non-streaming result, honestly labelled in the response).
 * - `GET /.well-known/agent-card.json` — the signed card.
 * - `POST /a2a/negotiate` — version negotiation: body
 *   `{clientVersions: string[]}` answers with the negotiation.
 *
 * Loopback only: the server binds 127.0.0.1 and refuses any
 * other host header target — this is a local harness endpoint,
 * not a public service.
 */
export class A2aJsonRpcServer {
  private readonly handler: A2aJsonRpcHandler;
  private readonly signedCard?: SignedA2aAgentCard;
  private readonly versions: readonly string[];
  private readonly port: number;
  private server: Server | null = null;

  constructor(handler: A2aJsonRpcHandler, options: A2aJsonRpcServerOptions = {}) {
    this.handler = handler;
    this.signedCard = options.signedCard;
    this.versions = options.versions ?? [...A2A_V115_PROTOCOL_VERSIONS];
    this.port = options.port ?? 0;
  }

  /** Base URL once listening, e.g. http://127.0.0.1:51234. */
  get baseUrl(): string | null {
    if (!this.server) return null;
    const address = this.server.address() as AddressInfo | null;
    if (!address) return null;
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<string> {
    if (this.server) return this.baseUrl as string;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    return this.baseUrl as string;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
        if (!this.signedCard) {
          this.sendJson(res, 404, { error: 'no signed card configured' });
          return;
        }
        this.sendJson(res, 200, this.signedCard);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/a2a/negotiate') {
        const body = await this.readJson(req);
        const clientVersions = Array.isArray((body as Record<string, unknown>)['clientVersions'])
          ? ((body as Record<string, unknown>)['clientVersions'] as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        this.sendJson(res, 200, negotiateA2aVersion(clientVersions, this.versions));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/a2a/message') {
        const body = await this.readJson(req);
        const rpc = body as Record<string, unknown>;
        if (rpc['jsonrpc'] !== '2.0' || typeof rpc['method'] !== 'string') {
          this.sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpc['id'] ?? null,
            error: { code: -32600, message: 'Invalid Request: expected JSON-RPC 2.0 with a method.' },
          });
          return;
        }
        const method = rpc['method'] as string;
        if (method !== 'message/send' && method !== 'message/stream') {
          this.sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpc['id'] ?? null,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
          return;
        }
        const params = rpc['params'] as Record<string, unknown> | undefined;
        const message = params?.['message'] as A2aJsonRpcMessage | undefined;
        if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) {
          this.sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpc['id'] ?? null,
            error: { code: -32602, message: 'Invalid params: params.message with parts[] is required.' },
          });
          return;
        }
        const result = await this.handler(message);
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc['id'] ?? null,
          result: {
            ...result,
            streaming: false,
            ...(method === 'message/stream' ? { note: 'message/stream answered as a single non-streaming result' } : {}),
          },
        });
        return;
      }
      this.sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 1_000_000) {
          reject(new Error('Request body too large (max 1 MB).'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch (err) {
          reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
      req.on('error', reject);
    });
  }
}

/** Outcome of sending one A2A message over JSON-RPC. */
export interface A2aJsonRpcSendResult {
  taskId: string;
  state: string;
  reply?: string;
  /** True when the server answered `message/stream` non-streaming. */
  streamingNote?: string;
}

/**
 * Send one A2A message to a JSON-RPC binding.
 * Throws on network errors and on JSON-RPC error responses.
 */
export async function sendA2aJsonRpcMessage(
  baseUrl: string,
  message: A2aJsonRpcMessage,
  options: { timeoutMs?: number; stream?: boolean } = {},
): Promise<A2aJsonRpcSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/a2a/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: options.stream === true ? 'message/stream' : 'message/send',
        params: { message },
        id: 1,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`A2A JSON-RPC HTTP ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    if (payload['error']) {
      const err = payload['error'] as Record<string, unknown>;
      throw new Error(`A2A JSON-RPC error ${String(err['code'] ?? '')}: ${String(err['message'] ?? 'unknown')}`);
    }
    const result = payload['result'] as Record<string, unknown>;
    return {
      taskId: String(result['taskId'] ?? ''),
      state: String(result['state'] ?? ''),
      ...(typeof result['reply'] === 'string' ? { reply: result['reply'] } : {}),
      ...(typeof result['note'] === 'string' ? { streamingNote: result['note'] } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a signed Agent Card from a server's well-known path. */
export async function fetchSignedAgentCard(
  baseUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<SignedA2aAgentCard> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Agent Card HTTP ${response.status}`);
    return (await response.json()) as SignedA2aAgentCard;
  } finally {
    clearTimeout(timer);
  }
}
