/**
 * A2A v1.0 (spec 1.0.0 / 1.0.1) — shared types for the v11 generation.
 *
 * This module is a NEW generation built from the public A2A 1.0 spec
 * ideas only (survey docs/repo-survey-v142.md): it does not reuse the
 * older a2a generations in this repo (v097/v100/v107/v109) and does not
 * copy code from any external repo. All names are prefixed `V11` so
 * they never collide with the older generations.
 *
 * Spec notes the implementation follows:
 *  - One protocol model shared by three bindings: JSON-RPC 2.0,
 *    gRPC, and HTTP+JSON. This module models the shared model; the
 *    client/server in this folder implement the JSON-RPC and the
 *    HTTP+JSON bindings in-process / over fetch.
 *  - Agent Card: signed, multi-tenancy aware, version negotiation.
 *  - Operations: SendMessage, SendStreamingMessage (SSE),
 *    GetTask, ListTasks (cursor pagination — new in 1.0),
 *    CancelTask, SubscribeToTask, GetExtendedAgentCard.
 *  - Task states carry a `task/` prefix in the wire form used here
 *    (e.g. `task/submitted`); the bare state is kept alongside for
 *    local logic. New state in 1.0: `input-required`.
 *  - Security (Palo Alto Unit 42, 31/10/2025): a malicious peer
 *    inside an A2A session can inject multi-turn instructions, leak
 *    system prompt / tools / history, and trigger unauthorised
 *    purchases. Nothing in this module ever hands a peer the local
 *    system prompt, tool list, or conversation history; the guard
 *    module (guard.ts) strips/flags peer instructions and sensitive
 *    actions always need user confirmation.
 */

/** A2A protocol versions this generation speaks. 1.0.1 is newest. */
export const V11_PROTOCOL_VERSION_1_0_0 = '1.0.0';
export const V11_PROTOCOL_VERSION_1_0_1 = '1.0.1';
/** Default (newest) protocol version advertised on our cards. */
export const V11_PROTOCOL_VERSION = V11_PROTOCOL_VERSION_1_0_1;
/** Every version this generation can negotiate. Newest first. */
export const V11_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  V11_PROTOCOL_VERSION_1_0_1,
  V11_PROTOCOL_VERSION_1_0_0,
];

/** Transports / bindings defined by the A2A 1.0 spec. */
export type V11Binding = 'json-rpc' | 'grpc' | 'http-json';

/** Prefix every task state carries on the wire in this generation. */
export const V11_TASK_STATE_PREFIX = 'task/';

/**
 * Bare task states (local form). `input-required` is new in A2A 1.0:
 * the agent is blocked waiting for more input from the user.
 */
export type V11TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

/** Wire form of a task state, e.g. `task/working`. */
export type V11TaskStateWire = `task/${V11TaskState}`;

export const V11_TASK_STATES: readonly V11TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'cancelled',
  'rejected',
];

/** States after which a task never changes again. */
export const V11_TERMINAL_TASK_STATES: readonly V11TaskState[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
];

export function isV11TerminalState(state: V11TaskState): boolean {
  return (V11_TERMINAL_TASK_STATES as readonly V11TaskState[]).includes(state);
}

/** `submitted` -> `task/submitted`, `task/working` -> `working`, etc. */
export function toV11WireState(state: V11TaskState): V11TaskStateWire {
  return `${V11_TASK_STATE_PREFIX}${state}` as V11TaskStateWire;
}

/**
 * Parse a wire state back to its bare form. Accepts both the prefixed
 * wire form (`task/working`) and the bare form (`working`) so older or
 * sloppy peers still interoperate. Returns undefined for unknowns.
 */
export function fromV11WireState(raw: string): V11TaskState | undefined {
  const bare = raw.startsWith(V11_TASK_STATE_PREFIX)
    ? raw.slice(V11_TASK_STATE_PREFIX.length)
    : raw;
  return (V11_TASK_STATES as readonly string[]).includes(bare)
    ? (bare as V11TaskState)
    : undefined;
}

/** A single content part inside a message or artifact. */
export type V11Part =
  | { kind: 'text'; text: string; metadata?: Record<string, unknown> }
  | { kind: 'data'; data: Record<string, unknown>; metadata?: Record<string, unknown> }
  | {
      kind: 'file';
      file: { name: string; mimeType: string; bytes?: string; uri?: string };
      metadata?: Record<string, unknown>;
    };

/** Who sent a message. */
export type V11MessageRole = 'user' | 'agent';

/** One message in an A2A conversation. */
export interface V11Message {
  messageId: string;
  role: V11MessageRole;
  parts: V11Part[];
  /** Task this message belongs to, when known. */
  taskId?: string;
  /** Id of the message this one answers, for multi-turn threading. */
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** An artifact produced by a task (a file, a document, structured data). */
export interface V11Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: V11Part[];
  metadata?: Record<string, unknown>;
}

/** One skill an agent advertises on its card. */
export interface V11AgentSkill {
  id: string;
  name: string;
  description?: string;
  /** Free-form tags, e.g. `["search", "web"]`. */
  tags?: string[];
  /** Example prompts a user may send to this skill. */
  examples?: string[];
  /** Input/output modes the skill accepts, e.g. `["text/plain"]`. */
  inputModes?: string[];
  outputModes?: string[];
}

/** Security scheme an agent card may declare (informational). */
export interface V11SecurityScheme {
  type: string;
  description?: string;
  /** e.g. `apiKey`, `http`, `oauth2`, `openIdConnect`, `mutualTLS`. */
  scheme?: string;
}

/**
 * Multi-tenancy descriptor (A2A 1.0): a card may serve several
 * tenants; each tenant gets its own endpoint / card view.
 */
export interface V11TenantInfo {
  tenantId: string;
  /** Optional per-tenant endpoint overriding the card url. */
  url?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The A2A 1.0 Agent Card.
 *
 * `protocolVersion` is the version this card speaks; `supportedVersions`
 * lists every version the agent can negotiate down to. `signature` is
 * present on a SIGNED card (see card.ts / signing.ts); an unsigned card
 * is never trusted for delegation (registry.ts enforces this).
 */
export interface V11AgentCard {
  name: string;
  description?: string;
  /** Base URL of the agent (its A2A endpoint). */
  url: string;
  /** Protocol version this card was written for. */
  protocolVersion: string;
  /** All protocol versions the agent supports, newest first. */
  supportedVersions?: string[];
  version?: string;
  provider?: { organization?: string; url?: string };
  skills: V11AgentSkill[];
  /** Capabilities the agent claims. */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
    multiTenancy?: boolean;
    extendedCard?: boolean;
  };
  /** Default input/output modes, e.g. `["text/plain"]`. */
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  securitySchemes?: Record<string, V11SecurityScheme>;
  security?: Array<Record<string, string[]>>;
  /** Tenants this card serves (empty / absent = single tenant). */
  tenants?: V11TenantInfo[];
  /** Tenant this card view is scoped to, when multi-tenant. */
  tenantId?: string;
  /** ISO-8601 expiry; expired cards are rejected. */
  validUntil?: string;
  /** Signature envelope (see signing.ts). Absent = unsigned card. */
  signature?: V11CardSignature;
  /** Extra fields a peer may attach; ignored by validation. */
  [extra: string]: unknown;
}

/** Signature envelope carried on a signed Agent Card. */
export interface V11CardSignature {
  /** Algorithm, e.g. `HS256` (shared secret) or `ES256` (EC key). */
  algorithm: string;
  /** Key id that signed the card. */
  keyId: string;
  /** Base64url signature over the canonical card JSON. */
  value: string;
  /** ISO-8601 time the signature was made. */
  signedAt: string;
}

/** A task as tracked by the v11 task store / server. */
export interface V11Task {
  id: string;
  /** Conversation id grouping the task's messages. */
  contextId: string;
  /** Bare state; the wire form is `task/<state>`. */
  state: V11TaskState;
  /** History of state transitions (newest last). */
  history?: V11TaskHistoryEntry[];
  artifacts?: V11Artifact[];
  /** Latest agent message, when the task produced one. */
  lastMessage?: V11Message;
  /** Human-readable status detail (e.g. why it failed). */
  statusMessage?: string;
  /** Tenant that owns the task (multi-tenancy). */
  tenantId?: string;
  /** Peer agent this task was delegated to, when any. */
  peerId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/** One entry in a task's state-transition history. */
export interface V11TaskHistoryEntry {
  state: V11TaskState;
  at: string;
  message?: string;
}

/** A task status update event (streaming / subscription). */
export interface V11TaskStatusUpdate {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  state: V11TaskState;
  stateWire: V11TaskStateWire;
  final: boolean;
  message?: V11Message;
}

/** An artifact update event (streaming / subscription). */
export interface V11ArtifactUpdate {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: V11Artifact;
  append?: boolean;
  lastChunk?: boolean;
}

/** Any event a streaming / subscription channel can deliver. */
export type V11TaskEvent = V11TaskStatusUpdate | V11ArtifactUpdate;

/** Result of sending a message: either a task or a direct message. */
export type V11SendResult =
  | { kind: 'task'; task: V11Task }
  | { kind: 'message'; message: V11Message };

/** Cursor page of tasks (ListTasks, new in A2A 1.0). */
export interface V11TaskPage {
  tasks: V11Task[];
  /** Opaque cursor for the next page; absent = last page. */
  nextCursor?: string;
  /** Total matching tasks, when the server knows it. */
  totalCount?: number;
}

/** Filters accepted by ListTasks. */
export interface V11ListTasksFilter {
  state?: V11TaskState;
  tenantId?: string;
  peerId?: string;
  contextId?: string;
}

/** JSON-RPC 2.0 request envelope (A2A JSON-RPC binding). */
export interface V11JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success envelope. */
export interface V11JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

/** JSON-RPC 2.0 error envelope. */
export interface V11JsonRpcError {
  jsonrpc: '2.0';
  id: string | number;
  error: { code: number; message: string; data?: unknown };
}

export type V11JsonRpcResponse = V11JsonRpcSuccess | V11JsonRpcError;

/** A2A 1.0 method names on the JSON-RPC binding. */
export const V11_METHODS = {
  sendMessage: 'message/send',
  sendStreamingMessage: 'message/stream',
  getTask: 'tasks/get',
  listTasks: 'tasks/list',
  cancelTask: 'tasks/cancel',
  subscribeToTask: 'tasks/subscribe',
  getAgentCard: 'agent/getCard',
  getExtendedAgentCard: 'agent/getExtendedCard',
} as const;

/** Standard JSON-RPC error codes used by the v11 server. */
export const V11_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancellable: -32002,
  unauthenticated: -32003,
  forbidden: -32004,
  peerNotAllowed: -32005,
  cardInvalid: -32006,
  injectionBlocked: -32007,
  inputRequired: -32008,
} as const;

/** Error thrown by v11 client/server code; carries a JSON-RPC code. */
export class V11A2aError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number = V11_RPC_ERRORS.internalError, data?: unknown) {
    super(message);
    this.name = 'V11A2aError';
    this.code = code;
    this.data = data;
  }
}

/** Concatenate the text parts of a message. */
export function v11PartsToText(parts: V11Part[]): string {
  return parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** Concatenate the text parts of a list of messages. */
export function v11MessagesToText(messages: V11Message[]): string {
  return messages.map((m) => v11PartsToText(m.parts)).join('\n');
}

/** Build a minimal text message. */
export function v11TextMessage(
  role: V11MessageRole,
  text: string,
  extra: Partial<V11Message> = {},
): V11Message {
  return {
    messageId: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts: [{ kind: 'text', text }],
    ...extra,
  };
}

/** True when the value looks like a usable http(s) URL. */
export function isV11HttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
