/**
 * Protocols v6 tools for @open-bot/tools (v1.37, Team T2).
 *
 * The agent drives the protocols-v6 stack by tool call:
 *  - protocol_v6_negotiate          — negotiate protocol versions per family, or all families at once, plus capability advertisement (read)
 *  - protocol_v6_versions           — version matrix, deprecation calendar, changes since v5, downgrade to v5 (read)
 *  - protocol_v6_acp_session        — ACP v2 session ops: new / prompt (returns the user message id) / cancel / complete / resume / get / list / link-v1 (local action)
 *  - protocol_v6_acp_update         — ACP v2 out-of-turn updates: send / list / ack / for-message (local action)
 *  - protocol_v6_acp_file_changes   — ACP v2 structured file changes: propose / preview / apply-hunk / reject-hunk / apply-all / apply-kind / rollback / get / list / summary / preload (local action, needs approval)
 *  - protocol_v6_elicit_form        — stable elicitation, form mode: create / submit / cancel / get / list (local action)
 *  - protocol_v6_elicit_url         — stable elicitation, URL mode: create / complete-by-callback / get / list (local action)
 *  - protocol_v6_elicit_modes       — advertise + negotiate elicitation modes (read)
 *  - protocol_v6_a2a_stream_start   — start an A2A 1.1 two-way stream for a running task (local action)
 *  - protocol_v6_a2a_stream_send    — send on a two-way stream: client input / interrupt / cancel / resume, agent message / status / finish / fail (local action)
 *  - protocol_v6_a2a_stream_control — stream control: get / list / pause / resume-delivery / ack / frames / reassemble-artifact / resume-token (read-ish)
 *  - protocol_v6_registry           — protocol registry: Poppy watch status, IETF ACP-WG watch, tested-with rows, compatibility report (read, plus local add/remove of test rows)
 *
 * Factory:
 *   createProtocolV6Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V6_TOOLS                       (unbound placeholder)
 *
 * SAFETY: the tools never carry credentials (elicitation refuses
 * sensitive fields; URL-mode tokens are single-use and never
 * logged with values), never write to disk by themselves (the
 * file-change store is in-memory; the host mirrors it to disk),
 * and never open a Poppy session (the registry refuses it).
 * The A2A stream is a loopback pair unless the host binds its
 * own transport; without a bound agent the agent side echoes
 * and says so.
 *
 * NOTE (v1.37): exported from the tools package but NOT yet wired
 * into defaultToolFactory — the coordinator wires
 * createProtocolV6Tools and recounts the tool pin, as with the
 * v1.29 protocol v5 tools.
 */
import type { Tool } from '@open-bot/core';
import {
  A2aV6Stream,
  AcpV6FileChangeSet,
  AcpV6FileStore,
  AcpV6SessionEngine,
  ElicitationV6Manager,
  ProtocolV6Registry,
  createLoopbackA2aV6Pair,
  defaultElicitationV6Advertisement,
  defaultProtocolV6Capabilities,
  negotiateElicitationV6Mode,
  negotiateAllProtocolsV6,
  negotiateProtocolV6Capabilities,
  negotiateProtocolV6Version,
  parseA2aV6ResumeToken,
  protocolV6ChangesSinceV5,
  protocolV6CompatibilityReport,
  protocolV6DeprecationCalendar,
  protocolV6DowngradeToV5,
  protocolV6MatrixSummary,
  protocolV6RegistrySummary,
  reassembleA2aV6Artifact,
  splitA2aV6Artifact,
  v1DiffToV6Change,
  type A2aV6ArtifactChunkPayload,
  type A2aV6Frame,
  type A2aV6TaskState,
  type AcpV6FileChangeKind,
  type AcpV6LineOp,
  type AcpV6UpdateKind,
  type ElicitationV6Advertisement,
  type ElicitationV6Field,
  type ElicitationV6Mode,
  type ProtocolV6CapabilityAdvertisement,
  type ProtocolV6Family,
  type ProtocolV6TestResult,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, required = true): number {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, defaultValue = false): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getRecordArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getArrayArg(args: Record<string, unknown>, name: string): unknown[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an array.`);
  }
  return [...(value as unknown[])];
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

/** How the agent's answers are produced for ACP v2 sessions (bound by the host). */
export type ProtocolV6AgentRunner = (
  sessionId: string,
  prompt: string,
  messageId: string,
  signal: AbortSignal,
) => Promise<{ text: string; toolCalls?: string[] }>;

export interface ProtocolV6ToolOptions {
  /** ACP v2 session engine accessor (host binds its engine). */
  getSessionEngine?: () => AcpV6SessionEngine | null;
  /** Agent runner for ACP v2 sessions (host binds its agent). */
  agentRunner?: ProtocolV6AgentRunner;
  /** Structured file-change set accessor (host binds its set/store). */
  getFileChangeSet?: () => AcpV6FileChangeSet | null;
  /** Elicitation manager accessor (host binds its manager). */
  getElicitationManager?: () => ElicitationV6Manager | null;
  /** Protocol registry accessor (host binds its registry). */
  getRegistry?: () => ProtocolV6Registry | null;
}

export const PROTOCOL_V6_TOOL_NAMES = [
  'protocol_v6_negotiate',
  'protocol_v6_versions',
  'protocol_v6_acp_session',
  'protocol_v6_acp_update',
  'protocol_v6_acp_file_changes',
  'protocol_v6_elicit_form',
  'protocol_v6_elicit_url',
  'protocol_v6_elicit_modes',
  'protocol_v6_a2a_stream_start',
  'protocol_v6_a2a_stream_send',
  'protocol_v6_a2a_stream_control',
  'protocol_v6_registry',
] as const;

export type ProtocolV6ToolName = (typeof PROTOCOL_V6_TOOL_NAMES)[number];

export function isProtocolV6ToolName(name: string): name is ProtocolV6ToolName {
  return (PROTOCOL_V6_TOOL_NAMES as readonly string[]).includes(name);
}

/** Unbound placeholder definitions (registry shape only). */
export const PROTOCOL_V6_TOOLS: Tool[] = PROTOCOL_V6_TOOL_NAMES.map((name) => ({
  definition: toolDef(name, `Protocols v6 tool ${name}.`, {}, []),
  needsApproval: false,
  async execute() {
    return errorResult(`Tool ${name} is not bound. Use createProtocolV6Tools() to bind it.`);
  },
}));

const PROTOCOL_V6_FAMILY_LIST: readonly string[] = ['acp', 'poppy', 'mcp', 'a2a', 'agui', 'a2ui'];
const ACP_V6_SESSION_ACTIONS: readonly string[] = [
  'new',
  'prompt',
  'cancel',
  'complete',
  'resume',
  'get',
  'list',
  'list-parallel',
  'link-v1',
  'unlink-v1',
  'replay',
];
const ACP_V6_UPDATE_ACTIONS: readonly string[] = ['send', 'list', 'ack', 'for-message', 'by-kind', 'pending'];
const ACP_V6_UPDATE_KINDS: readonly string[] = ['progress', 'file-change', 'message', 'permission', 'completed'];
const ACP_V6_FILE_ACTIONS: readonly string[] = [
  'propose',
  'preview',
  'apply-hunk',
  'reject-hunk',
  'apply-all',
  'apply-kind',
  'rollback-last',
  'rollback-change',
  'get',
  'list',
  'summary',
  'preload',
  'store-get',
  'store-list',
  'v1-diff',
];
const ACP_V6_FILE_KINDS: readonly string[] = ['create', 'update', 'delete', 'rename'];
const ELICIT_FORM_ACTIONS: readonly string[] = ['create', 'submit', 'cancel', 'get', 'list', 'pending'];
const ELICIT_URL_ACTIONS: readonly string[] = ['create', 'complete', 'cancel', 'get', 'list', 'pending'];
const A2A_V6_SEND_ACTIONS: readonly string[] = [
  'input',
  'interrupt',
  'cancel',
  'resume',
  'agent-message',
  'agent-status',
  'agent-finish',
  'agent-fail',
  'agent-artifact',
  'agent-request-input',
];
const A2A_V6_CONTROL_ACTIONS: readonly string[] = [
  'get',
  'list',
  'pause',
  'resume-delivery',
  'ack',
  'frames',
  'resume-token',
  'reassemble',
  'close',
];
const REGISTRY_V6_ACTIONS: readonly string[] = [
  'summary',
  'poppy',
  'watch',
  'compatibility',
  'tested-add',
  'tested-list',
  'tested-remove',
  'capabilities',
];

/** One live loopback A2A stream pair, with the frames the client side received. */
interface A2aV6LivePair {
  client: A2aV6Stream;
  agent: A2aV6Stream;
  clientInbox: A2aV6Frame[];
  agentInbox: A2aV6Frame[];
  artifactChunks: A2aV6ArtifactChunkPayload[];
}

export function createProtocolV6Tools(opts: ProtocolV6ToolOptions = {}): Tool[] {
  let fallbackEngine: AcpV6SessionEngine | null = null;
  let fallbackFileSet: AcpV6FileChangeSet | null = null;
  let fallbackElicitation: ElicitationV6Manager | null = null;
  let fallbackRegistry: ProtocolV6Registry | null = null;
  const livePairs = new Map<string, A2aV6LivePair>();

  const needEngine = (): AcpV6SessionEngine =>
    opts.getSessionEngine?.() ??
    (fallbackEngine ??= new AcpV6SessionEngine({
      runner: opts.agentRunner ?? (async (_sessionId, prompt) => ({ text: `Echo (no agent bound): ${prompt}` })),
    }));
  const needFileSet = (): AcpV6FileChangeSet =>
    opts.getFileChangeSet?.() ?? (fallbackFileSet ??= new AcpV6FileChangeSet(new AcpV6FileStore()));
  const needElicitation = (): ElicitationV6Manager =>
    opts.getElicitationManager?.() ?? (fallbackElicitation ??= new ElicitationV6Manager());
  const needRegistry = (): ProtocolV6Registry =>
    opts.getRegistry?.() ?? (fallbackRegistry ??= new ProtocolV6Registry());

  const negotiate: Tool = {
    definition: toolDef(
      'protocol_v6_negotiate',
      'Negotiate protocol v6 versions (read): one family (acp, poppy, mcp, a2a, agui, a2ui) when family is given, or all six families at once. Also negotiates capability advertisement (elicitation modes, ACP v2 draft features, A2A two-way streaming) against the peer advertisement when given. Poppy negotiates for description only — open-bot never implements it.',
      {
        family: { type: 'string', description: 'Protocol family: acp, poppy, mcp, a2a, agui or a2ui. Omit to negotiate all families.' },
        serverVersions: { type: 'array', items: { type: 'string' }, description: 'Versions the peer supports (single-family mode).' },
        serverVersionsByFamily: { type: 'object', description: 'All-families mode: { acp: [...], poppy: [...], mcp: [...], a2a: [...], agui: [...], a2ui: [...] }.' },
        peerCapabilities: { type: 'object', description: 'Optional peer capability advertisement to intersect with (elicitationModes, a2aTwoWayStreaming, acpStructuredFileChanges, acpOutOfTurnUpdates, acpPromptMessageIds, acpV1Parallel).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const peerCapabilities = args['peerCapabilities'] === undefined
          ? undefined
          : (getRecordArg(args, 'peerCapabilities') as Partial<ProtocolV6CapabilityAdvertisement>);
        const capabilities = peerCapabilities !== undefined
          ? negotiateProtocolV6Capabilities(peerCapabilities)
          : defaultProtocolV6Capabilities();
        const family = args['family'] === undefined ? undefined : getStringArg(args, 'family');
        if (family !== undefined) {
          if (!PROTOCOL_V6_FAMILY_LIST.includes(family)) {
            throw new Error(`Unknown protocol family "${family}". Use acp, poppy, mcp, a2a, agui or a2ui.`);
          }
          const result = negotiateProtocolV6Version(
            family as ProtocolV6Family,
            getStringArrayArg(args, 'serverVersions'),
          );
          return JSON.stringify({ negotiation: result, capabilities }, null, 2);
        }
        const byFamily = args['serverVersionsByFamily'] === undefined
          ? {}
          : getRecordArg(args, 'serverVersionsByFamily');
        const serverVersions: Partial<Record<ProtocolV6Family, readonly string[]>> = {};
        for (const f of PROTOCOL_V6_FAMILY_LIST) {
          const v = byFamily[f];
          if (v !== undefined) {
            if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
              throw new Error(`serverVersionsByFamily.${f} must be an array of strings.`);
            }
            serverVersions[f as ProtocolV6Family] = [...(v as string[])];
          }
        }
        return JSON.stringify(
          {
            negotiations: negotiateAllProtocolsV6(serverVersions),
            capabilities,
            deprecationCalendar: protocolV6DeprecationCalendar(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const versions: Tool = {
    definition: toolDef(
      'protocol_v6_versions',
      'Protocol v6 version matrix (read): current versions per family, the deprecation calendar, what changed since v5, the downgrade report against a v5 peer, and the one-line matrix summary.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        return JSON.stringify(
          {
            summary: protocolV6MatrixSummary(),
            current: {
              acp: '2.0-draft',
              poppy: '1.0 (watch-only, not implemented)',
              mcp: '2026-07-28',
              a2a: '1.1',
              agui: '1.0',
              a2ui: '1.0',
            },
            deprecationCalendar: protocolV6DeprecationCalendar(),
            changesSinceV5: protocolV6ChangesSinceV5(),
            downgradeToV5: protocolV6DowngradeToV5(),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const acpSession: Tool = {
    definition: toolDef(
      'protocol_v6_acp_session',
      'ACP v2 session operations (local action): new (start a session, optionally mirroring a parallel ACP v1 session), prompt (one turn — returns the user message id, the v2 draft change), cancel, complete, resume (a cancelled session), get, list, list-parallel, link-v1 / unlink-v1, replay (messages from a message id).',
      {
        action: { type: 'string', description: 'new, prompt, cancel, complete, resume, get, list, list-parallel, link-v1, unlink-v1 or replay.' },
        agentId: { type: 'string', description: 'Agent id (new).' },
        sessionId: { type: 'string', description: 'Session id (prompt/cancel/complete/resume/get/link-v1/unlink-v1/replay).' },
        text: { type: 'string', description: 'Prompt text (prompt).' },
        v1SessionId: { type: 'string', description: 'Parallel ACP v1 session id (new/link-v1).' },
        messageId: { type: 'string', description: 'Message id to replay from (replay).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!ACP_V6_SESSION_ACTIONS.includes(action)) {
          throw new Error(`Unknown ACP session action "${action}". Use ${ACP_V6_SESSION_ACTIONS.join(', ')}.`);
        }
        const engine = needEngine();
        if (action === 'new') {
          const v1SessionId = args['v1SessionId'] === undefined ? undefined : getStringArg(args, 'v1SessionId');
          const sessionId = engine.newSession(getStringArg(args, 'agentId'), { v1SessionId });
          return JSON.stringify({ sessionId, session: engine.getSession(sessionId) }, null, 2);
        }
        if (action === 'list') {
          return JSON.stringify({ sessions: engine.listSessions() }, null, 2);
        }
        if (action === 'list-parallel') {
          return JSON.stringify({ sessions: engine.listParallelSessions() }, null, 2);
        }
        const sessionId = getStringArg(args, 'sessionId');
        if (action === 'prompt') {
          const result = await engine.prompt(sessionId, getStringArg(args, 'text'));
          return JSON.stringify({ sessionId, ...result, note: 'Keep messageId: later file changes, updates and elicitations reference this turn by it.' }, null, 2);
        }
        if (action === 'cancel') {
          return JSON.stringify({ sessionId, cancelled: engine.cancel(sessionId) }, null, 2);
        }
        if (action === 'complete') {
          engine.complete(sessionId);
          return JSON.stringify({ sessionId, status: engine.getSession(sessionId)?.status }, null, 2);
        }
        if (action === 'resume') {
          engine.resume(sessionId);
          return JSON.stringify({ sessionId, status: engine.getSession(sessionId)?.status }, null, 2);
        }
        if (action === 'link-v1') {
          engine.linkParallelV1(sessionId, getStringArg(args, 'v1SessionId'));
          return JSON.stringify({ sessionId, session: engine.getSession(sessionId) }, null, 2);
        }
        if (action === 'unlink-v1') {
          engine.unlinkParallelV1(sessionId);
          return JSON.stringify({ sessionId, session: engine.getSession(sessionId) }, null, 2);
        }
        if (action === 'replay') {
          const messages = engine.replayFrom(sessionId, getStringArg(args, 'messageId'));
          return JSON.stringify({ sessionId, messages }, null, 2);
        }
        const session = engine.getSession(sessionId);
        if (!session) throw new Error(`Unknown ACP session "${sessionId}".`);
        return JSON.stringify({ session }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const acpUpdate: Tool = {
    definition: toolDef(
      'protocol_v6_acp_update',
      'ACP v2 out-of-turn updates (local action): send an update outside any prompt turn (progress / file-change / message / permission / completed, optionally in reply to a user message id), list updates, ack one, list updates for one message, list by kind, or list pending updates.',
      {
        action: { type: 'string', description: 'send, list, ack, for-message, by-kind or pending.' },
        sessionId: { type: 'string', description: 'Session id.' },
        kind: { type: 'string', description: 'Update kind (send/by-kind): progress, file-change, message, permission or completed.' },
        payload: { type: 'object', description: 'Update payload (send).' },
        messageId: { type: 'string', description: 'User message id the update belongs to (send/for-message).' },
        updateId: { type: 'string', description: 'Update id (ack).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!ACP_V6_UPDATE_ACTIONS.includes(action)) {
          throw new Error(`Unknown ACP update action "${action}". Use ${ACP_V6_UPDATE_ACTIONS.join(', ')}.`);
        }
        const engine = needEngine();
        const sessionId = getStringArg(args, 'sessionId');
        if (action === 'send') {
          const kind = getStringArg(args, 'kind');
          if (!ACP_V6_UPDATE_KINDS.includes(kind)) {
            throw new Error(`Unknown update kind "${kind}". Use ${ACP_V6_UPDATE_KINDS.join(', ')}.`);
          }
          const messageId = args['messageId'] === undefined ? undefined : getStringArg(args, 'messageId');
          const update = engine.sendUpdate(sessionId, kind as AcpV6UpdateKind, getRecordArg(args, 'payload'), messageId);
          return JSON.stringify({ update }, null, 2);
        }
        if (action === 'ack') {
          return JSON.stringify({ sessionId, acknowledged: engine.acknowledgeUpdate(sessionId, getStringArg(args, 'updateId')) }, null, 2);
        }
        if (action === 'for-message') {
          return JSON.stringify({ sessionId, updates: engine.updatesForMessage(sessionId, getStringArg(args, 'messageId')) }, null, 2);
        }
        if (action === 'by-kind') {
          const kind = getStringArg(args, 'kind');
          if (!ACP_V6_UPDATE_KINDS.includes(kind)) {
            throw new Error(`Unknown update kind "${kind}". Use ${ACP_V6_UPDATE_KINDS.join(', ')}.`);
          }
          return JSON.stringify({ sessionId, updates: engine.updatesByKind(sessionId, kind as AcpV6UpdateKind) }, null, 2);
        }
        if (action === 'pending') {
          return JSON.stringify({ sessionId, updates: engine.pendingUpdates(sessionId) }, null, 2);
        }
        const session = engine.getSession(sessionId);
        if (!session) throw new Error(`Unknown ACP session "${sessionId}".`);
        return JSON.stringify({ sessionId, updates: session.updates }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const acpFileChanges: Tool = {
    definition: toolDef(
      'protocol_v6_acp_file_changes',
      'ACP v2 structured file changes (local action, needs approval): propose a change (create/update/delete/rename with per-hunk line ops), preview a hunk without applying it, apply or reject one hunk, apply all hunks, apply a create/delete/rename, roll back, get/list/summary, preload files into the in-memory store, or convert an ACP v1 oldText/newText diff into a structured change.',
      {
        action: { type: 'string', description: 'propose, preview, apply-hunk, reject-hunk, apply-all, apply-kind, rollback-last, rollback-change, get, list, summary, preload, store-get, store-list or v1-diff.' },
        sessionId: { type: 'string', description: 'Session id (propose/list).' },
        changeId: { type: 'string', description: 'Change id (most actions).' },
        hunkId: { type: 'string', description: 'Hunk id (preview/apply-hunk/reject-hunk).' },
        path: { type: 'string', description: 'File path (propose/preload/store-get/v1-diff).' },
        kind: { type: 'string', description: 'Change kind (propose): create, update, delete or rename.' },
        newPath: { type: 'string', description: 'New path (rename).' },
        content: { type: 'string', description: 'Full content (create/preload) or current file content (v1-diff).' },
        hunks: { type: 'array', description: 'Hunks (propose): [{ summary, ops: [{ op: insert/delete/replace, ... }] }].' },
        messageId: { type: 'string', description: 'User message id the change belongs to (propose).' },
        reason: { type: 'string', description: 'Why a hunk is rejected (reject-hunk).' },
        oldText: { type: 'string', description: 'ACP v1 diff oldText (v1-diff).' },
        newText: { type: 'string', description: 'ACP v1 diff newText (v1-diff).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!ACP_V6_FILE_ACTIONS.includes(action)) {
          throw new Error(`Unknown file change action "${action}". Use ${ACP_V6_FILE_ACTIONS.join(', ')}.`);
        }
        const set = needFileSet();
        if (action === 'summary') {
          return JSON.stringify({ summary: set.summary(), files: set.getStore().list() }, null, 2);
        }
        if (action === 'preload') {
          set.getStore().put(getStringArg(args, 'path'), getStringArg(args, 'content'));
          return JSON.stringify({ path: getStringArg(args, 'path'), stored: true }, null, 2);
        }
        if (action === 'store-list') {
          return JSON.stringify({ files: set.getStore().list() }, null, 2);
        }
        if (action === 'store-get') {
          const path = getStringArg(args, 'path');
          const content = set.getStore().get(path);
          if (content === undefined) throw new Error(`File "${path}" is not in the store.`);
          return JSON.stringify({ path, content }, null, 2);
        }
        if (action === 'rollback-last') {
          const entry = set.rollbackLast();
          if (!entry) throw new Error('Nothing to roll back.');
          return JSON.stringify({ rolledBack: entry }, null, 2);
        }
        if (action === 'list') {
          const sessionId = args['sessionId'] === undefined ? undefined : getStringArg(args, 'sessionId');
          return JSON.stringify({ changes: set.list(sessionId) }, null, 2);
        }
        if (action === 'v1-diff') {
          const converted = v1DiffToV6Change(
            getStringArg(args, 'sessionId', false) || 'v1-migration',
            getStringArg(args, 'path'),
            getStringArg(args, 'oldText'),
            getStringArg(args, 'newText'),
            getStringArg(args, 'content'),
          );
          return JSON.stringify({ converted }, null, 2);
        }
        const changeId = args['changeId'] === undefined ? '' : getStringArg(args, 'changeId');
        if (action === 'propose') {
          const kind = getStringArg(args, 'kind');
          if (!ACP_V6_FILE_KINDS.includes(kind)) {
            throw new Error(`Unknown file change kind "${kind}". Use ${ACP_V6_FILE_KINDS.join(', ')}.`);
          }
          const rawHunks = getArrayArg(args, 'hunks');
          const hunks: { summary: string; ops: AcpV6LineOp[] }[] = rawHunks.map((raw) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each hunk must be an object { summary, ops }.');
            const h = raw as { summary?: unknown; ops?: unknown };
            if (typeof h.summary !== 'string' || !Array.isArray(h.ops)) {
              throw new Error('Each hunk needs a string summary and an ops array.');
            }
            return { summary: h.summary, ops: h.ops as AcpV6LineOp[] };
          });
          const change = set.propose({
            sessionId: getStringArg(args, 'sessionId'),
            messageId: args['messageId'] === undefined ? undefined : getStringArg(args, 'messageId'),
            path: getStringArg(args, 'path'),
            kind: kind as AcpV6FileChangeKind,
            newPath: args['newPath'] === undefined ? undefined : getStringArg(args, 'newPath'),
            content: args['content'] === undefined ? undefined : getStringArg(args, 'content'),
            hunks,
          });
          return JSON.stringify({ change }, null, 2);
        }
        if (action === 'preview') {
          if (!changeId) throw new Error('Missing required argument: "changeId"');
          return JSON.stringify({ preview: set.previewHunk(changeId, getStringArg(args, 'hunkId')) }, null, 2);
        }
        if (action === 'apply-hunk') {
          const result = set.applyHunk(changeId, getStringArg(args, 'hunkId'));
          return JSON.stringify({ changeId, ...result, change: set.get(changeId) }, null, 2);
        }
        if (action === 'reject-hunk') {
          set.rejectHunk(changeId, getStringArg(args, 'hunkId'), args['reason'] === undefined ? undefined : getStringArg(args, 'reason'));
          return JSON.stringify({ changeId, change: set.get(changeId) }, null, 2);
        }
        if (action === 'apply-all') {
          const result = set.applyAll(changeId);
          return JSON.stringify({ changeId, ...result, change: set.get(changeId) }, null, 2);
        }
        if (action === 'apply-kind') {
          const result = set.applyKind(changeId);
          return JSON.stringify({ changeId, ...result, change: set.get(changeId) }, null, 2);
        }
        if (action === 'rollback-change') {
          const rolledBack = set.rollbackChange(changeId);
          return JSON.stringify({ changeId, rolledBack, change: set.get(changeId) }, null, 2);
        }
        const change = set.get(changeId);
        if (!change) throw new Error(`Unknown file change "${changeId}".`);
        return JSON.stringify({ change, previews: set.previewChange(changeId) }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  function parseElicitationFields(args: Record<string, unknown>): ElicitationV6Field[] {
    const raw = getArrayArg(args, 'fields');
    return raw.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each field must be an object.');
      return item as ElicitationV6Field;
    });
  }

  function parseAdvertisement(args: Record<string, unknown>): ElicitationV6Advertisement | undefined {
    if (args['advertised'] === undefined) return undefined;
    const raw = getRecordArg(args, 'advertised');
    return {
      modes: getStringArrayArg({ advertised: raw['modes'] }, 'advertised') as ElicitationV6Mode[],
      maxFields: typeof raw['maxFields'] === 'number' ? raw['maxFields'] : 20,
      canOpenExternalUrl: raw['canOpenExternalUrl'] !== false,
    };
  }

  const elicitForm: Tool = {
    definition: toolDef(
      'protocol_v6_elicit_form',
      'Stable elicitation, form mode (local action): create a structured form (fields with schema, validated on submit), submit values, cancel, get one, list, or list pending for a session. Sensitive fields (password/secret/token/api-key, or sensitive: true) are refused.',
      {
        action: { type: 'string', description: 'create, submit, cancel, get, list or pending.' },
        elicitationId: { type: 'string', description: 'Elicitation id (submit/cancel/get).' },
        sessionId: { type: 'string', description: 'Session id (create/list/pending).' },
        messageId: { type: 'string', description: 'User message id the elicitation belongs to (create).' },
        title: { type: 'string', description: 'Form title (create).' },
        fields: { type: 'array', description: 'Field schema (create): [{ id, label, kind, required, min, max, pattern, options, ... }].' },
        values: { type: 'object', description: 'Submitted values (submit): { fieldId: value }.' },
        reason: { type: 'string', description: 'Why the elicitation is cancelled (cancel).' },
        ttlMs: { type: 'number', description: 'Time to live in ms (create).' },
        advertised: { type: 'object', description: 'Client advertisement to check the mode against (create).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!ELICIT_FORM_ACTIONS.includes(action)) {
          throw new Error(`Unknown elicitation action "${action}". Use ${ELICIT_FORM_ACTIONS.join(', ')}.`);
        }
        const manager = needElicitation();
        if (action === 'create') {
          const request = manager.create({
            sessionId: getStringArg(args, 'sessionId'),
            messageId: args['messageId'] === undefined ? undefined : getStringArg(args, 'messageId'),
            mode: 'form',
            title: getStringArg(args, 'title'),
            fields: parseElicitationFields(args),
            ttlMs: args['ttlMs'] === undefined ? undefined : getNumberArg(args, 'ttlMs'),
            advertised: parseAdvertisement(args),
          });
          return JSON.stringify({ elicitation: request }, null, 2);
        }
        if (action === 'list') {
          const sessionId = args['sessionId'] === undefined ? undefined : getStringArg(args, 'sessionId');
          return JSON.stringify({ elicitations: manager.list({ sessionId }) }, null, 2);
        }
        if (action === 'pending') {
          return JSON.stringify({ elicitations: manager.pendingForSession(getStringArg(args, 'sessionId')) }, null, 2);
        }
        const elicitationId = getStringArg(args, 'elicitationId');
        if (action === 'submit') {
          const result = manager.submit(elicitationId, getRecordArg(args, 'values'));
          return JSON.stringify(result, null, 2);
        }
        if (action === 'cancel') {
          const request = manager.cancel(elicitationId, args['reason'] === undefined ? undefined : getStringArg(args, 'reason'));
          return JSON.stringify({ elicitation: request }, null, 2);
        }
        const request = manager.get(elicitationId);
        if (!request) throw new Error(`Unknown elicitation "${elicitationId}".`);
        return JSON.stringify({ elicitation: request }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const elicitUrl: Tool = {
    definition: toolDef(
      'protocol_v6_elicit_url',
      'Stable elicitation, URL mode (local action): create a URL-mode elicitation (the user is sent to an external https URL; the flow completes with a one-time callback token), complete it by callback token, cancel, get one, list, or list pending for a session.',
      {
        action: { type: 'string', description: 'create, complete, cancel, get, list or pending.' },
        elicitationId: { type: 'string', description: 'Elicitation id (cancel/get).' },
        sessionId: { type: 'string', description: 'Session id (create/list/pending).' },
        messageId: { type: 'string', description: 'User message id the elicitation belongs to (create).' },
        title: { type: 'string', description: 'Title (create).' },
        fields: { type: 'array', description: 'Field schema the returned values are validated against (create).' },
        url: { type: 'string', description: 'External https URL (create).' },
        callbackToken: { type: 'string', description: 'One-time callback token (complete).' },
        values: { type: 'object', description: 'Values from the external flow (complete).' },
        reason: { type: 'string', description: 'Why the elicitation is cancelled (cancel).' },
        ttlMs: { type: 'number', description: 'Time to live in ms (create).' },
        advertised: { type: 'object', description: 'Client advertisement to check the mode against (create).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!ELICIT_URL_ACTIONS.includes(action)) {
          throw new Error(`Unknown elicitation action "${action}". Use ${ELICIT_URL_ACTIONS.join(', ')}.`);
        }
        const manager = needElicitation();
        if (action === 'create') {
          const request = manager.create({
            sessionId: getStringArg(args, 'sessionId'),
            messageId: args['messageId'] === undefined ? undefined : getStringArg(args, 'messageId'),
            mode: 'url',
            title: getStringArg(args, 'title'),
            fields: parseElicitationFields(args),
            url: getStringArg(args, 'url'),
            ttlMs: args['ttlMs'] === undefined ? undefined : getNumberArg(args, 'ttlMs'),
            advertised: parseAdvertisement(args),
          });
          return JSON.stringify({ elicitation: request }, null, 2);
        }
        if (action === 'list') {
          const sessionId = args['sessionId'] === undefined ? undefined : getStringArg(args, 'sessionId');
          return JSON.stringify({ elicitations: manager.list({ sessionId }) }, null, 2);
        }
        if (action === 'pending') {
          return JSON.stringify({ elicitations: manager.pendingForSession(getStringArg(args, 'sessionId')) }, null, 2);
        }
        if (action === 'complete') {
          const result = manager.completeByCallback(
            getStringArg(args, 'callbackToken'),
            getRecordArg(args, 'values'),
          );
          return JSON.stringify(result, null, 2);
        }
        const elicitationId = getStringArg(args, 'elicitationId');
        if (action === 'cancel') {
          const request = manager.cancel(elicitationId, args['reason'] === undefined ? undefined : getStringArg(args, 'reason'));
          return JSON.stringify({ elicitation: request }, null, 2);
        }
        const request = manager.get(elicitationId);
        if (!request) throw new Error(`Unknown elicitation "${elicitationId}".`);
        return JSON.stringify({ elicitation: request }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const elicitModes: Tool = {
    definition: toolDef(
      'protocol_v6_elicit_modes',
      'Elicitation capability advertisement (read): what this client advertises (form + URL modes, max fields, can open external URLs), and which mode is negotiated for a request (agent preference intersected with the advertisement; form wins ties).',
      {
        preferred: { type: 'string', description: 'Agent-preferred mode: form or url. Omit to see the default pick.' },
        advertised: { type: 'object', description: 'Client advertisement to negotiate against (modes, maxFields, canOpenExternalUrl). Omit for the open-bot default.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const advertised = parseAdvertisement(args) ?? defaultElicitationV6Advertisement();
        const preferred = args['preferred'] === undefined ? undefined : getStringArg(args, 'preferred');
        if (preferred !== undefined && preferred !== 'form' && preferred !== 'url') {
          throw new Error(`Unknown elicitation mode "${preferred}". Use form or url.`);
        }
        const negotiated = negotiateElicitationV6Mode(advertised, preferred as ElicitationV6Mode | undefined);
        return JSON.stringify({ advertised, preferred: preferred ?? null, negotiated }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  function startLivePair(taskId: string): A2aV6LivePair {
    const { client, agent } = createLoopbackA2aV6Pair(taskId);
    const pair: A2aV6LivePair = { client, agent, clientInbox: [], agentInbox: [], artifactChunks: [] };
    client.onFrame((frame) => {
      pair.clientInbox.push({ ...frame, payload: { ...frame.payload } });
      if (frame.kind === 'artifact-chunk') {
        pair.artifactChunks.push(frame.payload as unknown as A2aV6ArtifactChunkPayload);
      }
    });
    agent.onFrame((frame) => {
      pair.agentInbox.push({ ...frame, payload: { ...frame.payload } });
      // Echo agent: answer client input with a message, report
      // status on interrupt/resume, so the loopback stream does
      // something observable without a real agent bound.
      try {
        if (frame.kind === 'input') {
          const text = String((frame.payload as { text?: unknown })['text'] ?? '');
          agent.sendMessage(`Echo (no agent bound): ${text}`);
        } else if (frame.kind === 'interrupt') {
          agent.sendStatus('paused', 'Interrupted by the client.');
        } else if (frame.kind === 'resume') {
          agent.sendStatus('working', 'Resumed by the client.');
        }
      } catch {
        // The echo agent must never break the stream.
      }
    });
    livePairs.set(taskId, pair);
    return pair;
  }

  function needLivePair(taskId: string): A2aV6LivePair {
    const pair = livePairs.get(taskId);
    if (!pair) throw new Error(`No A2A v6 stream for task "${taskId}". Start one with protocol_v6_a2a_stream_start first.`);
    return pair;
  }

  const a2aStreamStart: Tool = {
    definition: toolDef(
      'protocol_v6_a2a_stream_start',
      'Start an A2A 1.1 two-way stream for a running task (local action): creates a loopback client/agent pair for the task and returns the stream view plus a resume token. The agent side echoes without a bound agent and says so.',
      {
        taskId: { type: 'string', description: 'Task id to stream for.' },
        window: { type: 'number', description: 'Flow-control window (default 16).' },
      },
      ['taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const taskId = getStringArg(args, 'taskId');
        if (livePairs.has(taskId)) throw new Error(`An A2A v6 stream already exists for task "${taskId}".`);
        const window = args['window'] === undefined ? undefined : getNumberArg(args, 'window');
        const pair = startLivePair(taskId);
        if (window !== undefined) {
          // The window is fixed at construction; report what was requested vs used.
          return JSON.stringify({
            taskId,
            client: pair.client.view(),
            agent: pair.agent.view(),
            resumeToken: pair.client.makeResumeToken(),
            note: `Requested window ${window} is recorded; this loopback pair uses the default window ${16}.`,
          }, null, 2);
        }
        return JSON.stringify({
          taskId,
          client: pair.client.view(),
          agent: pair.agent.view(),
          resumeToken: pair.client.makeResumeToken(),
        }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const a2aStreamSend: Tool = {
    definition: toolDef(
      'protocol_v6_a2a_stream_send',
      'Send on an A2A 1.1 two-way stream (local action). Client side: input (new input mid-task), interrupt (pause), cancel (terminal), resume (from a resume token). Agent side: agent-message, agent-status, agent-artifact (one chunk), agent-request-input, agent-finish, agent-fail.',
      {
        action: { type: 'string', description: 'input, interrupt, cancel, resume, agent-message, agent-status, agent-artifact, agent-request-input, agent-finish or agent-fail.' },
        taskId: { type: 'string', description: 'Task id.' },
        text: { type: 'string', description: 'Input / message text (input/agent-message).' },
        reason: { type: 'string', description: 'Why (interrupt/cancel).' },
        resumeToken: { type: 'string', description: 'Resume token (resume).' },
        state: { type: 'string', description: 'Task state (agent-status): submitted, working, input-required, paused, cancelled, completed or failed.' },
        detail: { type: 'string', description: 'Status detail (agent-status).' },
        progressPercent: { type: 'number', description: 'Progress 0..100 (agent-status).' },
        artifactId: { type: 'string', description: 'Artifact id (agent-artifact).' },
        index: { type: 'number', description: 'Chunk index (agent-artifact).' },
        total: { type: 'number', description: 'Total chunks (agent-artifact).' },
        data: { type: 'string', description: 'Chunk data (agent-artifact).' },
        last: { type: 'boolean', description: 'Last chunk (agent-artifact).' },
        prompt: { type: 'string', description: 'What the agent needs (agent-request-input).' },
        elicitationId: { type: 'string', description: 'Elicitation id (agent-request-input).' },
        summary: { type: 'string', description: 'Finish summary (agent-finish).' },
        code: { type: 'string', description: 'Error code (agent-fail).' },
        message: { type: 'string', description: 'Error message (agent-fail).' },
      },
      ['action', 'taskId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!A2A_V6_SEND_ACTIONS.includes(action)) {
          throw new Error(`Unknown stream send action "${action}". Use ${A2A_V6_SEND_ACTIONS.join(', ')}.`);
        }
        const pair = needLivePair(getStringArg(args, 'taskId'));
        let frame: A2aV6Frame;
        if (action === 'input') {
          frame = pair.client.sendInput(getStringArg(args, 'text'));
        } else if (action === 'interrupt') {
          frame = pair.client.interrupt(args['reason'] === undefined ? undefined : getStringArg(args, 'reason'));
        } else if (action === 'cancel') {
          frame = pair.client.cancelTask(args['reason'] === undefined ? undefined : getStringArg(args, 'reason'));
        } else if (action === 'resume') {
          const token = args['resumeToken'] === undefined ? undefined : getStringArg(args, 'resumeToken');
          if (token !== undefined) parseA2aV6ResumeToken(token);
          frame = pair.client.resumeTask(token);
        } else if (action === 'agent-message') {
          frame = pair.agent.sendMessage(getStringArg(args, 'text'));
        } else if (action === 'agent-status') {
          const state = getStringArg(args, 'state');
          frame = pair.agent.sendStatus(
            state as A2aV6TaskState,
            args['detail'] === undefined ? undefined : getStringArg(args, 'detail'),
            args['progressPercent'] === undefined ? undefined : getNumberArg(args, 'progressPercent'),
          );
        } else if (action === 'agent-artifact') {
          frame = pair.agent.sendArtifactChunk(
            getStringArg(args, 'artifactId'),
            getNumberArg(args, 'index'),
            getNumberArg(args, 'total'),
            getStringArg(args, 'data'),
            getBooleanArg(args, 'last', false),
          );
        } else if (action === 'agent-request-input') {
          frame = pair.agent.requestInput(
            getStringArg(args, 'prompt'),
            args['elicitationId'] === undefined ? undefined : getStringArg(args, 'elicitationId'),
          );
        } else if (action === 'agent-finish') {
          frame = pair.agent.finish(args['summary'] === undefined ? undefined : getStringArg(args, 'summary'));
        } else {
          frame = pair.agent.fail(getStringArg(args, 'code'), getStringArg(args, 'message'));
        }
        return JSON.stringify({ taskId: pair.client.taskId, frame, client: pair.client.view(), agent: pair.agent.view() }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const a2aStreamControl: Tool = {
    definition: toolDef(
      'protocol_v6_a2a_stream_control',
      'A2A 1.1 two-way stream control (read-ish): get a stream view, list streams, pause delivery, resume delivery, ack a frame, list received frames, make a resume token, reassemble a streamed artifact from its chunks, or close a stream.',
      {
        action: { type: 'string', description: 'get, list, pause, resume-delivery, ack, frames, resume-token, reassemble or close.' },
        taskId: { type: 'string', description: 'Task id (all except list).' },
        seq: { type: 'number', description: 'Frame seq to ack (ack).' },
        side: { type: 'string', description: 'Which inbox to read (frames): client or agent. Default client.' },
        artifactId: { type: 'string', description: 'Artifact id to reassemble (reassemble).' },
        chunks: { type: 'array', description: 'Artifact chunks to reassemble (reassemble): [{ artifactId, index, total, data, last }].' },
        content: { type: 'string', description: 'Artifact content to split into chunks first (reassemble helper: pass content instead of chunks to preview the split).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!A2A_V6_CONTROL_ACTIONS.includes(action)) {
          throw new Error(`Unknown stream control action "${action}". Use ${A2A_V6_CONTROL_ACTIONS.join(', ')}.`);
        }
        if (action === 'list') {
          return JSON.stringify({
            streams: [...livePairs.values()].map((p) => ({ client: p.client.view(), agent: p.agent.view() })),
          }, null, 2);
        }
        const pair = needLivePair(getStringArg(args, 'taskId'));
        if (action === 'get') {
          return JSON.stringify({ client: pair.client.view(), agent: pair.agent.view() }, null, 2);
        }
        if (action === 'pause') {
          pair.client.pause();
          return JSON.stringify({ taskId: pair.client.taskId, client: pair.client.view() }, null, 2);
        }
        if (action === 'resume-delivery') {
          pair.client.resumeDelivery();
          return JSON.stringify({ taskId: pair.client.taskId, client: pair.client.view() }, null, 2);
        }
        if (action === 'ack') {
          pair.client.ack(getNumberArg(args, 'seq'));
          return JSON.stringify({ taskId: pair.client.taskId, client: pair.client.view() }, null, 2);
        }
        if (action === 'frames') {
          const side = args['side'] === undefined ? 'client' : getStringArg(args, 'side');
          if (side !== 'client' && side !== 'agent') throw new Error('side must be client or agent.');
          const inbox = side === 'client' ? pair.clientInbox : pair.agentInbox;
          return JSON.stringify({ taskId: pair.client.taskId, side, frames: inbox }, null, 2);
        }
        if (action === 'resume-token') {
          return JSON.stringify({
            taskId: pair.client.taskId,
            resumeToken: pair.client.makeResumeToken(),
            parsed: parseA2aV6ResumeToken(pair.client.makeResumeToken()),
          }, null, 2);
        }
        if (action === 'reassemble') {
          if (args['content'] !== undefined) {
            const chunks = splitA2aV6Artifact(
              getStringArg(args, 'artifactId', false) || 'artifact',
              getStringArg(args, 'content'),
            );
            return JSON.stringify({ taskId: pair.client.taskId, chunks, reassembled: reassembleA2aV6Artifact(chunks) }, null, 2);
          }
          const rawChunks = getArrayArg(args, 'chunks');
          const chunks = rawChunks.map((c) => {
            if (!c || typeof c !== 'object') throw new Error('Each chunk must be an object.');
            return c as A2aV6ArtifactChunkPayload;
          });
          const artifactId = args['artifactId'] === undefined ? undefined : getStringArg(args, 'artifactId');
          const filtered = artifactId === undefined ? chunks : chunks.filter((c) => c.artifactId === artifactId);
          return JSON.stringify({ taskId: pair.client.taskId, reassembled: reassembleA2aV6Artifact(filtered) }, null, 2);
        }
        // close
        pair.client.close();
        pair.agent.close();
        livePairs.delete(pair.client.taskId);
        return JSON.stringify({ taskId: pair.client.taskId, closed: true }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const registry: Tool = {
    definition: toolDef(
      'protocol_v6_registry',
      'Protocol v6 registry (read, plus local test-row edits): summary, the Poppy watch entry (watch-only, not implemented — this tool never opens a Poppy session), all watch entries, the v5/v4 compatibility report, add/list/remove dated tested-with rows, or the capability advertisement.',
      {
        action: { type: 'string', description: 'summary, poppy, watch, compatibility, tested-add, tested-list, tested-remove or capabilities.' },
        peer: { type: 'string', description: 'Peer name (tested-add/tested-list).' },
        family: { type: 'string', description: 'Protocol family (tested-add/tested-list).' },
        version: { type: 'string', description: 'Protocol version (tested-add).' },
        testedOn: { type: 'string', description: 'Test date YYYY-MM-DD (tested-add).' },
        result: { type: 'string', description: 'Test result (tested-add/tested-list): pass, partial, fail or not-tested.' },
        coverage: { type: 'string', description: 'What was exercised (tested-add).' },
        note: { type: 'string', description: 'Note (tested-add).' },
        rowId: { type: 'string', description: 'Tested-with row id (tested-remove).' },
        status: { type: 'string', description: 'Watch-entry status filter (watch): implemented, watch-only or not-planned.' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!REGISTRY_V6_ACTIONS.includes(action)) {
          throw new Error(`Unknown registry action "${action}". Use ${REGISTRY_V6_ACTIONS.join(', ')}.`);
        }
        const reg = needRegistry();
        if (action === 'summary') {
          return JSON.stringify({ summary: protocolV6RegistrySummary(reg), details: reg.summary() }, null, 2);
        }
        if (action === 'poppy') {
          return JSON.stringify({ poppy: reg.poppyStatus() }, null, 2);
        }
        if (action === 'watch') {
          const status = args['status'] === undefined ? undefined : getStringArg(args, 'status');
          if (status !== undefined && !['implemented', 'watch-only', 'not-planned'].includes(status)) {
            throw new Error(`Unknown watch status "${status}".`);
          }
          return JSON.stringify({ watchEntries: reg.listWatchEntries(status as never) }, null, 2);
        }
        if (action === 'compatibility') {
          return JSON.stringify({ compatibility: protocolV6CompatibilityReport() }, null, 2);
        }
        if (action === 'capabilities') {
          return JSON.stringify({ capabilities: reg.getCapabilities() }, null, 2);
        }
        if (action === 'tested-add') {
          const family = getStringArg(args, 'family');
          if (!PROTOCOL_V6_FAMILY_LIST.includes(family)) {
            throw new Error(`Unknown protocol family "${family}".`);
          }
          const result = getStringArg(args, 'result');
          if (!(['pass', 'partial', 'fail', 'not-tested'] as readonly string[]).includes(result)) {
            throw new Error(`Unknown test result "${result}". Use pass, partial, fail or not-tested.`);
          }
          const row = reg.addTestedWith({
            peer: getStringArg(args, 'peer'),
            family: family as ProtocolV6Family,
            version: getStringArg(args, 'version'),
            testedOn: getStringArg(args, 'testedOn'),
            result: result as ProtocolV6TestResult,
            coverage: getStringArg(args, 'coverage'),
            note: args['note'] === undefined ? undefined : getStringArg(args, 'note'),
          });
          return JSON.stringify({ row }, null, 2);
        }
        if (action === 'tested-list') {
          const family = args['family'] === undefined ? undefined : getStringArg(args, 'family');
          const result = args['result'] === undefined ? undefined : getStringArg(args, 'result');
          const peer = args['peer'] === undefined ? undefined : getStringArg(args, 'peer');
          return JSON.stringify({
            rows: reg.listTestedWith({
              family: family as ProtocolV6Family | undefined,
              result: result as ProtocolV6TestResult | undefined,
              peer,
            }),
          }, null, 2);
        }
        const removed = reg.removeTestedWith(getStringArg(args, 'rowId'));
        return JSON.stringify({ rowId: getStringArg(args, 'rowId'), removed }, null, 2);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    negotiate,
    versions,
    acpSession,
    acpUpdate,
    acpFileChanges,
    elicitForm,
    elicitUrl,
    elicitModes,
    a2aStreamStart,
    a2aStreamSend,
    a2aStreamControl,
    registry,
  ];
}
