/**
 * A2A v1.0 tools for @open-bot/tools (v1.42, Doi T1).
 *
 * Agent lam viec voi A2A v1.0 bang tool call:
 *  - a2a_v11_card      — build/validate/negotiate/sign/verify Agent Card (read; sign needsApproval: true)
 *  - a2a_v11_peer      — register/list peer, pin key, allowlist/blocklist/unsuspend (ghi needsApproval: true)
 *  - a2a_v11_delegate  — delegate 1 message toi peer allowlisted + verified (needsApproval: true; sensitive action can doi xac nhan)
 *  - a2a_v11_send      — send message toi server noi bo (loopback) + stream events (ghi needsApproval: true)
 *  - a2a_v11_task      — get/cancel/resume/list (cursor) task (cancel needsApproval: true)
 *  - a2a_v11_guard     — scan text bang injection guard, session multi-turn, outbound secret scan (read)
 *  - a2a_v11_audit     — query/verify/export audit log (read)
 *  - a2a_v11_server    — start/stop server noi bo + extended card (start/stop needsApproval: true)
 *  - a2a_v11_sign      — tao key HS256/ES256, sign/verify card (sign needsApproval: true)
 *  - a2a_v11_stats     — thong ke peer/task/guard/audit + health (read)
 *
 * SAFETY (bai hoc Unit 42): khong co tool nao allowlist peer —
 * allowlist chi qua UI/settings cua user (a2a_v11_peer chi doc
 * trang thai; cac action allowlist/blocklist o day la placeholder
 * bi chan: can user xac nhan qua ToolContext? — thuc te: cac action
 * doi trang thai peer deu needsApproval: true, va host phai truyen
 * userConfirmed=true thi moi thuc hien). Khong co tool nao doc
 * system prompt / tool list / history cua host de gui cho peer.
 * Moi gui di deu qua guard secret-scan. Khong goi API ngoai that —
 * peer remote chi qua transport/fetch do host cung cap (mock trong test).
 *
 * Factory:
 *   createA2aV11Tools(opts) -> Tool[]   (bound, usable)
 *   A2A_V11_TOOLS                       (unbound placeholder)
 */

import type { Tool } from '@open-bot/core';
import {
  V11A2aServer,
  V11AuditLog,
  V11PeerRegistry,
  V11SessionGuard,
  buildV11AgentCard,
  createV11LoopbackClient,
  delegateV11ToPeer,
  generateV11Es256Key,
  generateV11Hs256Key,
  isV11CardStructurallyValid,
  negotiateV11ProtocolVersion,
  parseV11SseLine,
  scanV11OutboundText,
  scanV11PeerMessage,
  signV11AgentCard,
  summarizeV11AgentCard,
  v11CardForTenant,
  v11PeerIdForCard,
  v11PublicKeyOf,
  v11TextMessage,
  validateV11AgentCard,
  verifyV11AgentCardAgainstKeys,
  type V11AgentCard,
  type V11PeerStatus,
  type V11TaskState,
  type V11VerificationKey,
} from '@open-bot/core';

export interface A2aV11ToolOptions {
  /** Server noi bo dung chung (tao moi khi khong truyen). */
  server?: V11A2aServer;
  /** Registry peer dung chung (tao moi khi khong truyen). */
  registry?: V11PeerRegistry;
  /** Audit log dung chung. */
  audit?: V11AuditLog;
  /** Card mac dinh cua agent noi bo (dung cho server + card tools). */
  card?: V11AgentCard;
  /** Ten agent noi bo. */
  agentName?: string;
  /** URL agent noi bo. */
  agentUrl?: string;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string`);
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Argument "${name}" must be a boolean`);
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Argument "${name}" must be a number`);
  }
  return value;
}

function parseJsonArg<T>(args: Record<string, unknown>, name: string, required: boolean): T | undefined {
  const raw = getOptionalStringArg(args, name);
  if (raw === undefined) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Argument "${name}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function defaultLocalCard(opts: A2aV11ToolOptions): V11AgentCard {
  if (opts.card) return opts.card;
  return buildV11AgentCard({
    name: opts.agentName ?? 'open-bot',
    url: opts.agentUrl ?? 'http://127.0.0.1:8765/',
    description: 'open-bot local A2A v1.0 agent',
    skills: [
      { id: 'chat', name: 'Chat', description: 'Answer questions and help with tasks' },
      { id: 'search', name: 'Search', description: 'Search the web and local files' },
    ],
    streaming: true,
    stateTransitionHistory: true,
    multiTenancy: false,
    extendedCard: true,
  });
}

export function createA2aV11Tools(opts: A2aV11ToolOptions = {}): Tool[] {
  const audit = opts.audit ?? new V11AuditLog();
  const registry = opts.registry ?? new V11PeerRegistry(audit);
  const serverHolder: { server: V11A2aServer | null } = {
    server: opts.server ?? null,
  };
  const sessionGuards = new Map<string, V11SessionGuard>();

  function getOrCreateServer(): V11A2aServer {
    if (!serverHolder.server) {
      serverHolder.server = new V11A2aServer({ card: defaultLocalCard(opts), audit });
    }
    return serverHolder.server;
  }

  function guardForSession(sessionId: string): V11SessionGuard {
    let guard = sessionGuards.get(sessionId);
    if (!guard) {
      guard = new V11SessionGuard();
      sessionGuards.set(sessionId, guard);
    }
    return guard;
  }

  const tools: Tool[] = [
    {
      definition: toolDef(
        'a2a_v11_card',
        'A2A v1.0 Agent Card: build a local card, validate a peer card, negotiate the protocol version, summarise a card, or derive a per-tenant card view. Signing/verification live in a2a_v11_sign.',
        {
          action: { type: 'string', enum: ['build', 'validate', 'negotiate', 'summarise', 'tenant-view'], description: 'What to do with the card.' },
          card: { type: 'string', description: 'Agent Card JSON (validate / negotiate / summarise / tenant-view).' },
          peerCard: { type: 'string', description: 'Peer card JSON for negotiate.' },
          tenantId: { type: 'string', description: 'Tenant id for tenant-view.' },
          name: { type: 'string', description: 'Agent name for build.' },
          url: { type: 'string', description: 'Agent url for build.' },
          description: { type: 'string', description: 'Agent description for build.' },
        },
        ['action'],
      ),
      needsApproval: false,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          if (action === 'build') {
            const card = buildV11AgentCard({
              name: getOptionalStringArg(args, 'name') ?? opts.agentName ?? 'open-bot',
              url: getOptionalStringArg(args, 'url') ?? opts.agentUrl ?? 'http://127.0.0.1:8765/',
              description: getOptionalStringArg(args, 'description'),
              skills: [
                { id: 'chat', name: 'Chat', description: 'Answer questions and help with tasks' },
              ],
              streaming: true,
              stateTransitionHistory: true,
              extendedCard: true,
            });
            return okResult({ card, summary: summarizeV11AgentCard(card) });
          }
          const card = parseJsonArg<V11AgentCard>(args, 'card', true) as V11AgentCard;
          if (action === 'validate') {
            const result = validateV11AgentCard(card);
            return okResult({
              valid: result.valid,
              expired: result.expired,
              protocolVersion: result.protocolVersion,
              issues: result.issues,
              summary: summarizeV11AgentCard(card),
            });
          }
          if (action === 'negotiate') {
            const peerCard = parseJsonArg<V11AgentCard>(args, 'peerCard', false) ?? card;
            const local = defaultLocalCard(opts);
            const result = negotiateV11ProtocolVersion(peerCard);
            void local;
            return okResult({
              version: result.version,
              peerVersions: result.peerVersions,
              ourVersions: [...result.ourVersions],
              peerIsNewer: result.peerIsNewer,
              reason: result.reason,
            });
          }
          if (action === 'summarise') {
            return okResult({
              summary: summarizeV11AgentCard(card),
              structurallyValid: isV11CardStructurallyValid(card),
              signed: card.signature !== undefined,
            });
          }
          if (action === 'tenant-view') {
            const tenantId = getStringArg(args, 'tenantId');
            const view = v11CardForTenant(card, tenantId);
            if (!view) return errorResult(`tenant not found on card: ${tenantId}`);
            return okResult({ card: view, summary: summarizeV11AgentCard(view) });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_peer',
        'A2A v1.0 peer registry: register/list a peer, pin verification keys, check whether delegation is allowed. Allowlist/blocklist changes need userConfirmed=true (user decision, never automatic) and are audited.',
        {
          action: { type: 'string', enum: ['register', 'list', 'get', 'pin-keys', 'check', 'allowlist', 'blocklist', 'unsuspend'], description: 'Registry action.' },
          card: { type: 'string', description: 'Agent Card JSON for register.' },
          peerId: { type: 'string', description: 'Peer id for get / pin-keys / check / allowlist / blocklist / unsuspend.' },
          keys: { type: 'string', description: 'Verification keys JSON array for pin-keys.' },
          status: { type: 'string', enum: ['registered', 'allowlisted', 'blocklisted', 'suspended'], description: 'Filter for list.' },
          note: { type: 'string', description: 'User note for allowlist / blocklist.' },
          userConfirmed: { type: 'boolean', description: 'Required true for allowlist/blocklist/unsuspend (user decision).' },
        },
        ['action'],
      ),
      needsApproval: true,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          if (action === 'register') {
            const card = parseJsonArg<V11AgentCard>(args, 'card', true) as V11AgentCard;
            const keys = parseJsonArg<V11VerificationKey[]>(args, 'keys', false);
            const { record, validationIssues } = registry.registerPeer(card, {
              ...(keys ? { keys } : {}),
            });
            return okResult({
              peerId: record.id,
              status: record.status,
              signatureVerified: record.signatureVerified,
              trustScore: record.trustScore,
              validationIssues,
            });
          }
          if (action === 'list') {
            const status = getOptionalStringArg(args, 'status') as V11PeerStatus | undefined;
            const peers = registry.listPeers(status).map((p) => ({
              id: p.id,
              name: p.card.name,
              url: p.card.url,
              status: p.status,
              signatureVerified: p.signatureVerified,
              trustScore: p.trustScore,
              guardBlocks: p.guardBlocks,
              successfulDelegations: p.successfulDelegations,
              failedDelegations: p.failedDelegations,
            }));
            return okResult({ count: peers.length, peers });
          }
          if (action === 'get') {
            const peerId = getStringArg(args, 'peerId');
            const peer = registry.getPeer(peerId);
            if (!peer) return errorResult(`unknown peer: ${peerId}`);
            return okResult({
              id: peer.id,
              card: peer.card,
              status: peer.status,
              signatureVerified: peer.signatureVerified,
              trustScore: peer.trustScore,
              guardBlocks: peer.guardBlocks,
              successfulDelegations: peer.successfulDelegations,
              failedDelegations: peer.failedDelegations,
              firstSeenAt: peer.firstSeenAt,
              lastSeenAt: peer.lastSeenAt,
              note: peer.note,
            });
          }
          if (action === 'pin-keys') {
            const peerId = getStringArg(args, 'peerId');
            const keys = parseJsonArg<V11VerificationKey[]>(args, 'keys', true) as V11VerificationKey[];
            registry.pinKeys(peerId, keys);
            const peer = registry.getPeer(peerId);
            return okResult({ peerId, signatureVerified: peer?.signatureVerified ?? false });
          }
          if (action === 'check') {
            const peerId = getStringArg(args, 'peerId');
            const check = registry.checkDelegation(peerId);
            return okResult({ peerId, allowed: check.allowed, reasons: check.reasons });
          }
          if (action === 'allowlist' || action === 'blocklist' || action === 'unsuspend') {
            if (!getBoolArg(args, 'userConfirmed', false)) {
              return errorResult(`${action} requires userConfirmed=true (user decision, never automatic)`);
            }
            const peerId = getStringArg(args, 'peerId');
            const note = getOptionalStringArg(args, 'note');
            const peer =
              action === 'allowlist'
                ? registry.allowlistPeer(peerId, note)
                : action === 'blocklist'
                  ? registry.blocklistPeer(peerId, note)
                  : registry.unsuspendPeer(peerId);
            return okResult({ peerId, status: peer.status });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_delegate',
        'Delegate one message to an allowlisted, signature-verified A2A v1.0 peer over a loopback (in-process) server. Denied when the peer is not allowlisted, unsigned, unverified, suspended or blocklisted. Sensitive actions in the peer reply need confirmSensitive=true.',
        {
          peerId: { type: 'string', description: 'Allowlisted peer id.' },
          text: { type: 'string', description: 'Message text to delegate.' },
          contextId: { type: 'string', description: 'Conversation context id (default: new).' },
          stream: { type: 'boolean', description: 'Use SendStreamingMessage. Default false.' },
          confirmSensitive: { type: 'boolean', description: 'User approval for sensitive actions the peer requests. Default false (deny).' },
        },
        ['peerId', 'text'],
      ),
      needsApproval: true,
      async execute(args) {
        try {
          const peerId = getStringArg(args, 'peerId');
          const text = getStringArg(args, 'text');
          const contextId = getOptionalStringArg(args, 'contextId');
          const stream = getBoolArg(args, 'stream', false);
          const confirmSensitive = getBoolArg(args, 'confirmSensitive', false);
          // Loopback delegation: the peer is the local server. A remote
          // peer needs a clientFactory from the host; the tool surface
          // only exposes the safe loopback path.
          const server = getOrCreateServer();
          if (!server.isStarted) server.start();
          const peer = registry.getPeer(peerId);
          if (!peer) return errorResult(`unknown peer: ${peerId}`);
          const result = await delegateV11ToPeer(
            registry,
            {
              peerId,
              message: v11TextMessage('user', text, contextId ? { contextId } : {}),
              stream,
              confirm: () => confirmSensitive,
              clientFactory: () =>
                createV11LoopbackClient((req) => server.handleJsonRpc(req), {
                  card: peer.card,
                  allowUnsigned: true,
                }),
            },
            audit,
          );
          if (!result.allowed) {
            return errorResult(`delegation denied: ${result.reasons.join('; ')}`);
          }
          return okResult({
            peerId,
            result: result.result,
            guard: {
              decision: result.guard.decision,
              score: result.guard.score,
              codes: result.guard.findings.map((f) => f.code),
              needsConfirmation: result.guard.needsConfirmation,
              sensitiveActions: result.guard.sensitiveActions,
            },
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_send',
        'Send a message to the local A2A v1.0 server (SendMessage or SendStreamingMessage). The server runs the inbound text through the multi-turn injection guard first; blocked text never creates a task.',
        {
          text: { type: 'string', description: 'Message text.' },
          contextId: { type: 'string', description: 'Conversation context id (default: new).' },
          stream: { type: 'boolean', description: 'Stream events (SSE-style). Default false.' },
        },
        ['text'],
      ),
      needsApproval: true,
      async execute(args) {
        try {
          const text = getStringArg(args, 'text');
          const contextId = getOptionalStringArg(args, 'contextId');
          const stream = getBoolArg(args, 'stream', false);
          const server = getOrCreateServer();
          if (!server.isStarted) server.start();
          const message = v11TextMessage('user', text, contextId ? { contextId } : {});
          if (!stream) {
            const result = await server.sendMessage(message);
            return okResult({ result });
          }
          const events: unknown[] = [];
          const gen = server.sendStreamingMessage(message);
          let final: unknown;
          for (;;) {
            const step = await gen.next();
            if (step.done) {
              final = step.value;
              break;
            }
            events.push(step.value);
          }
          return okResult({ events, result: final });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_task',
        'A2A v1.0 task operations on the local server: get one task, cancel it, resume an input-required task with new input, list tasks with cursor pagination (new in 1.0), or prune old terminal tasks (live tasks are never pruned).',
        {
          action: { type: 'string', enum: ['get', 'cancel', 'resume', 'list', 'prune'], description: 'Task action.' },
          taskId: { type: 'string', description: 'Task id for get / cancel / resume.' },
          text: { type: 'string', description: 'Input text for resume.' },
          reason: { type: 'string', description: 'Cancel reason.' },
          olderThanHours: { type: 'number', description: 'Prune terminal tasks older than this many hours. Default 24.' },
          state: { type: 'string', enum: ['submitted', 'working', 'input-required', 'completed', 'failed', 'cancelled', 'rejected'], description: 'State filter for list.' },
          cursor: { type: 'string', description: 'Opaque cursor for the next page.' },
          pageSize: { type: 'number', description: 'Page size 1..100. Default 20.' },
        },
        ['action'],
      ),
      needsApproval: true,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          const server = getOrCreateServer();
          if (!server.isStarted) server.start();
          if (action === 'get') {
            const taskId = getStringArg(args, 'taskId');
            return okResult({ task: server.getTask(taskId) });
          }
          if (action === 'cancel') {
            const taskId = getStringArg(args, 'taskId');
            const reason = getOptionalStringArg(args, 'reason');
            return okResult({ task: server.cancelTask(taskId, reason) });
          }
          if (action === 'resume') {
            const taskId = getStringArg(args, 'taskId');
            const text = getStringArg(args, 'text');
            const task = server.getTask(taskId);
            const result = await server.resumeTask(
              taskId,
              v11TextMessage('user', text, { contextId: task.contextId }),
            );
            return okResult({ result });
          }
          if (action === 'list') {
            const state = getOptionalStringArg(args, 'state') as V11TaskState | undefined;
            const cursor = getOptionalStringArg(args, 'cursor');
            const pageSize = getNumberArg(args, 'pageSize', 20);
            const page = server.listTasks(
              state ? { state } : {},
              cursor,
              pageSize,
            );
            return okResult({
              tasks: page.tasks,
              nextCursor: page.nextCursor,
              totalCount: page.totalCount,
            });
          }
          if (action === 'prune') {
            const olderThanHours = getNumberArg(args, 'olderThanHours', 24);
            const removed = server.pruneTerminalTasks(olderThanHours * 3600_000);
            return okResult({ removed, count: removed.length });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_guard',
        'A2A v1.0 injection guard: scan one message for multi-turn injection patterns, run a multi-turn session scan (Unit 42 lesson), scan outbound text for secrets, or parse one SSE line.',
        {
          action: { type: 'string', enum: ['scan', 'session-scan', 'outbound-scan', 'parse-sse'], description: 'Guard action.' },
          text: { type: 'string', description: 'Text to scan (scan / outbound-scan) or SSE line (parse-sse).' },
          sessionId: { type: 'string', description: 'Session id for session-scan (stateful across calls).' },
        },
        ['action'],
      ),
      needsApproval: false,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          if (action === 'scan') {
            const text = getStringArg(args, 'text');
            const verdict = scanV11PeerMessage(text);
            return okResult({
              decision: verdict.decision,
              score: verdict.score,
              findings: verdict.findings,
              cleanedText: verdict.cleanedText,
              needsConfirmation: verdict.needsConfirmation,
              sensitiveActions: verdict.sensitiveActions,
              exfiltrationAttempt: verdict.exfiltrationAttempt,
            });
          }
          if (action === 'session-scan') {
            const text = getStringArg(args, 'text');
            const sessionId = getStringArg(args, 'sessionId');
            const guard = guardForSession(sessionId);
            const verdict = guard.scanTurn(text);
            return okResult({
              decision: verdict.decision,
              score: verdict.score,
              sessionScore: guard.totalScore,
              sessionBlocked: guard.isBlocked,
              turnCount: guard.turnCount,
              findings: verdict.findings,
              cleanedText: verdict.cleanedText,
            });
          }
          if (action === 'outbound-scan') {
            const text = getStringArg(args, 'text');
            const scan = scanV11OutboundText(text);
            return okResult({ blocked: scan.blocked, codes: scan.codes });
          }
          if (action === 'parse-sse') {
            const text = getStringArg(args, 'text');
            return okResult({ event: parseV11SseLine(text) });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_audit',
        'A2A v1.0 audit log: list recent entries (optionally filtered by kind / peer / task), verify the hash chain, or export the whole log as JSON.',
        {
          action: { type: 'string', enum: ['list', 'verify', 'export'], description: 'Audit action.' },
          kind: { type: 'string', description: 'Event kind filter for list.' },
          peerId: { type: 'string', description: 'Peer filter for list.' },
          taskId: { type: 'string', description: 'Task filter for list.' },
          limit: { type: 'number', description: 'Max entries for list. Default 50.' },
        },
        ['action'],
      ),
      needsApproval: false,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          if (action === 'list') {
            const kind = getOptionalStringArg(args, 'kind') as never;
            const peerId = getOptionalStringArg(args, 'peerId');
            const taskId = getOptionalStringArg(args, 'taskId');
            const limit = getNumberArg(args, 'limit', 50);
            const entries = audit
              .query({ ...(kind ? { kind } : {}), ...(peerId ? { peerId } : {}), ...(taskId ? { taskId } : {}) })
              .slice(-limit);
            return okResult({ count: entries.length, entries });
          }
          if (action === 'verify') {
            return okResult({ chain: audit.verifyChain(), count: audit.count() });
          }
          if (action === 'export') {
            return okResult({ json: audit.toJson(), count: audit.count() });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_server',
        'A2A v1.0 local server: start/stop it, read its (extended) Agent Card, or negotiate the protocol version with a peer card.',
        {
          action: { type: 'string', enum: ['start', 'stop', 'card', 'extended-card', 'negotiate'], description: 'Server action.' },
          peerCard: { type: 'string', description: 'Peer card JSON for negotiate.' },
        },
        ['action'],
      ),
      needsApproval: true,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          const server = getOrCreateServer();
          if (action === 'start') {
            server.start();
            return okResult({ started: true, card: server.getAgentCard() });
          }
          if (action === 'stop') {
            server.stop();
            return okResult({ started: false });
          }
          if (action === 'card') {
            return okResult({ card: server.getAgentCard(), started: server.isStarted });
          }
          if (action === 'extended-card') {
            return okResult({ extended: server.getExtendedAgentCard(), started: server.isStarted });
          }
          if (action === 'negotiate') {
            const peerCard = parseJsonArg<V11AgentCard>(args, 'peerCard', true) as V11AgentCard;
            const version = server.negotiateWith(peerCard);
            return okResult({ version, peer: peerCard.name });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_sign',
        'A2A v1.0 card signing keys: generate an HS256 shared secret or ES256 key pair, sign a card, or verify a card signature against pinned keys. Private keys / secrets are never returned in full — only public material.',
        {
          action: { type: 'string', enum: ['generate-hs256', 'generate-es256', 'sign', 'verify'], description: 'Signing action.' },
          keyId: { type: 'string', description: 'Key id for generate.' },
          card: { type: 'string', description: 'Agent Card JSON for sign / verify.' },
          key: { type: 'string', description: 'Signing key JSON (HS256: {algorithm, keyId, secret}; ES256: {algorithm, keyId, privateKey}) for sign.' },
          keys: { type: 'string', description: 'Verification keys JSON array for verify.' },
        },
        ['action'],
      ),
      needsApproval: true,
      async execute(args) {
        try {
          const action = getStringArg(args, 'action');
          if (action === 'generate-hs256') {
            const key = generateV11Hs256Key(getOptionalStringArg(args, 'keyId'));
            // NEVER return the secret: for HS256 the "public" material
            // is the secret itself, so only the key id + algorithm go
            // back. The host must store the secret in the vault
            // (Settings) — the agent never sees it.
            return okResult({
              keyId: key.keyId,
              algorithm: key.algorithm,
              warning: 'HS256 secret is held by the host vault and is never shown to the agent — supply keys for signing via the host, not via tool calls.',
            });
          }
          if (action === 'generate-es256') {
            const key = generateV11Es256Key(getOptionalStringArg(args, 'keyId'));
            return okResult({ public: v11PublicKeyOf(key), keyId: key.keyId });
          }
          if (action === 'sign') {
            const card = parseJsonArg<V11AgentCard>(args, 'card', true) as V11AgentCard;
            const key = parseJsonArg<Record<string, unknown>>(args, 'key', true) as unknown as Parameters<typeof signV11AgentCard>[1];
            const signed = signV11AgentCard(card, key);
            return okResult({ card: signed, summary: summarizeV11AgentCard(signed) });
          }
          if (action === 'verify') {
            const card = parseJsonArg<V11AgentCard>(args, 'card', true) as V11AgentCard;
            const keys = parseJsonArg<V11VerificationKey[]>(args, 'keys', true) as V11VerificationKey[];
            const result = verifyV11AgentCardAgainstKeys(card, keys);
            return okResult({ valid: result.valid, algorithm: result.algorithm, keyId: result.keyId, reason: result.reason, signedAt: result.signedAt });
          }
          return errorResult(`unknown action: ${action}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'a2a_v11_stats',
        'A2A v1.0 stats + health: peer counts by status, task counts by state, tasks awaiting input, guard session count, audit entry count and chain health.',
        {},
        [],
      ),
      needsApproval: false,
      async execute() {
        try {
          const server = getOrCreateServer();
          const taskCounts: Record<string, number> = {};
          for (const task of server.store.all()) {
            taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1;
          }
          const peerCounts: Record<string, number> = {};
          for (const peer of registry.listPeers()) {
            peerCounts[peer.status] = (peerCounts[peer.status] ?? 0) + 1;
          }
          const usable = registry.usablePeers().length;
          return okResult({
            serverStarted: server.isStarted,
            protocolVersion: server.card.protocolVersion,
            peers: { total: registry.count(), byStatus: peerCounts, usable },
            tasks: { total: server.store.count(), byState: taskCounts, awaitingInput: server.store.awaitingInput().length, active: server.store.active().length },
            guardSessions: sessionGuards.size,
            audit: { entries: audit.count(), chain: audit.verifyChain() },
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  return tools;
}

/** Ten A2A v1.0 tools (thu tu nhu createA2aV11Tools tra ve). */
export const A2A_V11_TOOLS: Tool[] = createA2aV11Tools();

/** Tool names, in order (handy for tests / registry counts). */
export const A2A_V11_TOOL_NAMES: readonly string[] = [
  'a2a_v11_card',
  'a2a_v11_peer',
  'a2a_v11_delegate',
  'a2a_v11_send',
  'a2a_v11_task',
  'a2a_v11_guard',
  'a2a_v11_audit',
  'a2a_v11_server',
  'a2a_v11_sign',
  'a2a_v11_stats',
];
