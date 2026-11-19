/**
 * Protocols v7 tools for @open-bot/tools (v1.38, Team T2).
 *
 * The agent drives the protocols-v7 stack by tool call:
 *  - protocol_v7_negotiate          — negotiate protocol versions per family, or all families at once, plus capability advertisement (read)
 *  - protocol_v7_versions           — version matrix, deprecation calendar, changes since v6, downgrade to v6 (read)
 *  - protocol_v7_a2a_card           — A2A 1.0.1 Agent Card: issue / verify / rotate-key / revoke-key / register / get / list / find-by-capability / trust (local action)
 *  - protocol_v7_a2a_task           — A2A 1.0.1 long tasks: submit / start / get / cancel / list / resume / counts / snapshot / restore / sweep-overdue (local action)
 *  - protocol_v7_a2a_client         — A2A 1.0.1 client over the loopback pair: connect / send / stream / get / cancel / list / resubscribe / push-config (local action)
 *  - protocol_v7_a2a_server         — A2A 1.0.1 server: raw JSON-RPC dispatch (single + batch), card serving, rate usage (local action)
 *  - protocol_v7_mcp_stateless      — MCP stateless HTTP: ping / tools list+call / resources list+read / prompts list+get / stateless check (local action)
 *  - protocol_v7_ucp_catalog        — UCP read-only catalog: search / get / list (read)
 *  - protocol_v7_ucp_order          — UCP read-only cart/order/identity: cart get, order get/list, identity status, attempt (checkout/payment refused) (read)
 *  - protocol_v7_govern_delegate    — governance delegation: grant / get / list / check / revoke / revoke-cascade / revoke-by-delegate / revoke-by-scope / sweep / counts (needs approval)
 *  - protocol_v7_govern_escalate    — human escalation: file / get / pending / list / approve / deny / sweep-expired (needs approval)
 *  - protocol_v7_govern_audit       — governance audit log: list / filter / verify / snapshot / restore (read)
 *
 * Factory:
 *   createProtocolV7Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V7_TOOLS                       (unbound placeholder)
 *
 * State: when the host does not bind its own stores, the factory
 * creates one shared in-memory set (card issuer + registry +
 * trust store, task store + engine with an echo runner, A2A
 * server + loopback client, MCP stateless server with a demo
 * echo tool, UCP demo backend, governance engine + escalation
 * queue + audit log) and shares it across the 12 tools, so the
 * tools work standalone. The host may override any piece via
 * ProtocolV7ToolOptions accessors.
 *
 * SAFETY: the tools never carry credentials (card private keys
 * stay inside the issuer; UCP has no payment path at all —
 * checkout / payment / order placement are refused with a typed
 * error), never write to disk by themselves (task snapshots and
 * the audit log are in-memory; the host mirrors them), and
 * never open a Poppy or ACP session (both are watch-only /
 * merged — the version matrix refuses them).
 */
import type { Tool } from '@open-bot/core';
import {
  A2aV7CardIssuer,
  A2aV7CardRegistry,
  A2aV7Client,
  A2aV7LoopbackTransport,
  A2aV7Server,
  A2aV7TaskEngine,
  A2aV7TaskStore,
  A2aV7TrustStore,
  GovV7AuditLog,
  GovV7EscalationQueue,
  GovV7PolicyEngine,
  McpV7StatelessClient,
  McpV7StatelessServer,
  UcpV7MemoryBackend,
  UcpV7MoneyRefusedError,
  UcpV7ReadOnlyAdapter,
  buildA2aV7AgentCard,
  buildMcpV7Request,
  checkMcpV7Stateless,
  createLoopbackMcpV7Sender,
  defaultProtocolV7Capabilities,
  govV7ScopeMatches,
  isUcpV7RefusedOperation,
  negotiateAllProtocolsV7,
  negotiateProtocolV7Capabilities,
  negotiateProtocolV7Version,
  protocolV7ChangesSinceV6,
  protocolV7DeprecationCalendar,
  protocolV7DowngradeToV6,
  protocolV7MatrixSummary,
  summarizeGovV7Grant,
  summarizeUcpV7Item,
  summarizeUcpV7Order,
  verifyA2aV7AgentCard,
  PROTOCOL_V7_CURRENT_VERSIONS,
  type A2aV7AgentCard,
  type A2aV7AgentCardInput,
  type A2aV7TaskState,
  type GovV7Escalation,
  type McpV7RequestMeta,
  type McpV7ToolDefinition,
  type ProtocolV7Family,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

const strProp = (description: string): Record<string, unknown> => ({ type: 'string', description });
const numProp = (description: string): Record<string, unknown> => ({ type: 'number', description });
const boolProp = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const objProp = (description: string): Record<string, unknown> => ({ type: 'object', description });
const arrProp = (description: string): Record<string, unknown> => ({ type: 'array', description, items: { type: 'string' } });

/** Host bindings for the v7 tools (all optional — defaults are created lazily). */
export interface ProtocolV7ToolOptions {
  /** Card issuer accessor (host binds its issuer). */
  getCardIssuer?: () => A2aV7CardIssuer | null;
  /** Card registry accessor (host binds its registry). */
  getCardRegistry?: () => A2aV7CardRegistry | null;
  /** Trust store accessor (host binds its trust store). */
  getTrustStore?: () => A2aV7TrustStore | null;
  /** Task store accessor (host binds its store). */
  getTaskStore?: () => A2aV7TaskStore | null;
  /** Task engine accessor (host binds its engine). */
  getTaskEngine?: () => A2aV7TaskEngine | null;
  /** A2A server accessor (host binds its server). */
  getServer?: () => A2aV7Server | null;
  /** MCP stateless server accessor (host binds its server). */
  getMcpServer?: () => McpV7StatelessServer | null;
  /** UCP read-only adapter accessor (host binds its adapter). */
  getUcpAdapter?: () => UcpV7ReadOnlyAdapter | null;
  /** Governance policy engine accessor (host binds its engine). */
  getPolicyEngine?: () => GovV7PolicyEngine | null;
  /** Escalation queue accessor (host binds its queue). */
  getEscalationQueue?: () => GovV7EscalationQueue | null;
  /** Audit log accessor (host binds its log). */
  getAuditLog?: () => GovV7AuditLog | null;
}

export const PROTOCOL_V7_TOOL_NAMES = [
  'protocol_v7_negotiate',
  'protocol_v7_versions',
  'protocol_v7_a2a_card',
  'protocol_v7_a2a_task',
  'protocol_v7_a2a_client',
  'protocol_v7_a2a_server',
  'protocol_v7_mcp_stateless',
  'protocol_v7_ucp_catalog',
  'protocol_v7_ucp_order',
  'protocol_v7_govern_delegate',
  'protocol_v7_govern_escalate',
  'protocol_v7_govern_audit',
] as const;

export type ProtocolV7ToolName = (typeof PROTOCOL_V7_TOOL_NAMES)[number];

export function isProtocolV7ToolName(name: string): name is ProtocolV7ToolName {
  return (PROTOCOL_V7_TOOL_NAMES as readonly string[]).includes(name);
}

/** Unbound placeholder definitions (registry shape only). */
export const PROTOCOL_V7_TOOLS: Tool[] = PROTOCOL_V7_TOOL_NAMES.map((name) => ({
  definition: toolDef(name, `Protocols v7 tool ${name}.`, {}, []),
  needsApproval: false,
  async execute() {
    return errorResult(`Tool ${name} is not bound. Use createProtocolV7Tools() to bind it.`);
  },
}));

const PROTOCOL_V7_FAMILY_LIST: readonly string[] = ['a2a', 'mcp', 'ucp', 'acp', 'gov', 'agui', 'a2ui', 'poppy'];
const A2A_V7_CARD_ACTIONS: readonly string[] = [
  'issue', 'verify', 'rotate-key', 'revoke-key', 'list-keys',
  'register', 'get', 'list', 'find-by-capability', 'revoke-card',
  'revoke-by-key', 'trust-decide', 'trust-pin', 'trust-summary', 'prune-expired',
];
const A2A_V7_TASK_ACTIONS: readonly string[] = [
  'submit', 'start', 'get', 'cancel', 'list', 'resume', 'counts',
  'add-push-config', 'list-push-configs', 'remove-push-config',
  'snapshot', 'restore', 'sweep-overdue', 'prune-terminal',
];
const A2A_V7_CLIENT_ACTIONS: readonly string[] = [
  'connect', 'send', 'stream', 'get', 'cancel', 'list', 'resubscribe',
  'push-set', 'push-get', 'push-list', 'push-delete',
];
const A2A_V7_SERVER_ACTIONS: readonly string[] = ['dispatch', 'batch', 'card', 'rate-usage'];
const MCP_V7_ACTIONS: readonly string[] = [
  'ping', 'tools-list', 'tools-call', 'resources-list', 'resources-read',
  'prompts-list', 'prompts-get', 'stateless-check', 'register-echo-tool',
];
const UCP_V7_CATALOG_ACTIONS: readonly string[] = ['search', 'get', 'list'];
const UCP_V7_ORDER_ACTIONS: readonly string[] = [
  'cart-get', 'order-get', 'order-list', 'identity-status', 'attempt',
];
const GOV_V7_DELEGATE_ACTIONS: readonly string[] = [
  'grant', 'get', 'list', 'for-delegate', 'in-tenant', 'check',
  'revoke', 'revoke-cascade', 'revoke-by-delegate', 'revoke-by-scope',
  'sweep', 'counts', 'scope-matches',
];
const GOV_V7_ESCALATE_ACTIONS: readonly string[] = [
  'file', 'get', 'pending', 'list', 'approve', 'deny', 'sweep-expired',
];
const GOV_V7_AUDIT_ACTIONS: readonly string[] = ['list', 'filter', 'verify', 'snapshot', 'restore'];

/** Shared state owned by one createProtocolV7Tools() call. */
interface ProtocolV7SharedState {
  cardIssuer: A2aV7CardIssuer;
  cardRegistry: A2aV7CardRegistry;
  trustStore: A2aV7TrustStore;
  taskStore: A2aV7TaskStore;
  taskEngine: A2aV7TaskEngine;
  server: A2aV7Server;
  mcpServer: McpV7StatelessServer;
  mcpClient: McpV7StatelessClient;
  ucpAdapter: UcpV7ReadOnlyAdapter;
  policyEngine: GovV7PolicyEngine;
  escalationQueue: GovV7EscalationQueue;
  auditLog: GovV7AuditLog;
}

function createDefaultSharedState(): ProtocolV7SharedState {
  const cardIssuer = new A2aV7CardIssuer();
  const cardRegistry = new A2aV7CardRegistry();
  const trustStore = new A2aV7TrustStore('tofu');
  const taskStore = new A2aV7TaskStore();
  const taskEngine = new A2aV7TaskEngine(taskStore, async (task) => {
    const first = task.history.find((m) => m.role === 'user');
    const text = first?.parts.find((p) => p.kind === 'text')?.text ?? '';
    return { text: `Echo (v7 engine): ${text}` };
  });
  const server = new A2aV7Server({ store: taskStore, engine: taskEngine, cardRegistry });
  const mcpServer = new McpV7StatelessServer();
  mcpServer.registerTool(
    {
      name: 'echo',
      description: 'Demo echo tool on the v7 stateless server (returns its arguments).',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    (args) => ({
      content: [{ type: 'text', text: `echo: ${String(args.text ?? '')}` }],
      isError: false,
      structuredContent: { echoed: args.text ?? '' },
    }),
  );
  const mcpClient = new McpV7StatelessClient(createLoopbackMcpV7Sender(mcpServer), { clientName: 'open-bot' });
  const ucpAdapter = new UcpV7ReadOnlyAdapter(new UcpV7MemoryBackend());
  const auditLog = new GovV7AuditLog();
  const policyEngine = new GovV7PolicyEngine(auditLog);
  const escalationQueue = new GovV7EscalationQueue();
  return {
    cardIssuer, cardRegistry, trustStore, taskStore, taskEngine,
    server, mcpServer, mcpClient, ucpAdapter, policyEngine,
    escalationQueue, auditLog,
  };
}

/** Parse a card input object from tool args into a validated card. */
function parseCardInput(args: Record<string, unknown>): A2aV7AgentCard {
  const raw = getRecordArg(args, 'card');
  const skillsRaw = getArrayArg({ skills: raw.skills }, 'skills');
  const skills = skillsRaw.map((s) => {
    const r = s as Record<string, unknown>;
    if (typeof r !== 'object' || r === null) throw new Error('Each skill must be an object with id, name and description.');
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      description: String(r.description ?? ''),
      examples: Array.isArray(r.examples) ? (r.examples as unknown[]).map(String) : undefined,
    };
  });
  const input: A2aV7AgentCardInput = {
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    version: String(raw.version ?? '0.1.0'),
    url: String(raw.url ?? ''),
    protocolVersions: Array.isArray(raw.protocolVersions) ? (raw.protocolVersions as unknown[]).map(String) : undefined,
    capabilities: Array.isArray(raw.capabilities) ? (raw.capabilities as unknown[]).map(String) : [],
    skills,
    authSchemes: Array.isArray(raw.authSchemes)
      ? (raw.authSchemes as unknown[]).map((v) => String(v)) as A2aV7AgentCard['authSchemes']
      : ['none'],
    tenant: typeof raw.tenant === 'string' ? raw.tenant : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
  };
  return buildA2aV7AgentCard(input);
}

/** Create the 12 bound protocol v7 tools. */
export function createProtocolV7Tools(opts: ProtocolV7ToolOptions = {}): Tool[] {
  const defaults = createDefaultSharedState();
  const cardIssuer = () => opts.getCardIssuer?.() ?? defaults.cardIssuer;
  const cardRegistry = () => opts.getCardRegistry?.() ?? defaults.cardRegistry;
  const trustStore = () => opts.getTrustStore?.() ?? defaults.trustStore;
  const taskStore = () => opts.getTaskStore?.() ?? defaults.taskStore;
  const taskEngine = () => opts.getTaskEngine?.() ?? defaults.taskEngine;
  const server = () => opts.getServer?.() ?? defaults.server;
  const mcpServer = () => opts.getMcpServer?.() ?? defaults.mcpServer;
  const mcpClient = () => defaults.mcpClient;
  const ucpAdapter = () => opts.getUcpAdapter?.() ?? defaults.ucpAdapter;
  const policyEngine = () => opts.getPolicyEngine?.() ?? defaults.policyEngine;
  const escalationQueue = () => opts.getEscalationQueue?.() ?? defaults.escalationQueue;
  const auditLog = () => opts.getAuditLog?.() ?? defaults.auditLog;

  const negotiateTool: Tool = {
    definition: toolDef(
      'protocol_v7_negotiate',
      'Protocols v7: negotiate protocol versions per family (a2a/mcp/ucp/acp/gov/agui/a2ui/poppy) or all families at once, plus capability advertisement. ACP negotiates null (merged into A2A); Poppy is watch-only.',
      {
        action: strProp('Action: negotiate | negotiate-all | capabilities.'),
        family: strProp('Protocol family (negotiate).'),
        serverVersions: arrProp('Versions the peer offers, newest first (negotiate).'),
        peerCapabilities: objProp('Peer capability advertisement to intersect with (capabilities).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'negotiate') {
          const family = getStringArg(args, 'family') as ProtocolV7Family;
          if (!PROTOCOL_V7_FAMILY_LIST.includes(family)) {
            return errorResult(`Unknown family "${family}" (known: ${PROTOCOL_V7_FAMILY_LIST.join(', ')}).`);
          }
          return okResult(negotiateProtocolV7Version(family, getStringArrayArg(args, 'serverVersions')));
        }
        if (action === 'negotiate-all') {
          const offered = getRecordArg(args, 'serverVersionsByFamily');
          const mapped: Partial<Record<ProtocolV7Family, readonly string[]>> = {};
          for (const family of PROTOCOL_V7_FAMILY_LIST) {
            const value = offered[family];
            if (Array.isArray(value)) mapped[family as ProtocolV7Family] = (value as unknown[]).map(String);
          }
          return okResult(negotiateAllProtocolsV7(mapped));
        }
        if (action === 'capabilities') {
          const peer = getRecordArg(args, 'peerCapabilities');
          const local = defaultProtocolV7Capabilities();
          const negotiated = negotiateProtocolV7Capabilities(
            Object.keys(peer).length === 0 ? undefined : (peer as Partial<ReturnType<typeof defaultProtocolV7Capabilities>>),
          );
          return okResult({ local, negotiated });
        }
        return errorResult(`Unknown action "${action}" (known: negotiate, negotiate-all, capabilities).`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const versionsTool: Tool = {
    definition: toolDef(
      'protocol_v7_versions',
      'Protocols v7: version matrix, deprecation calendar, changes since v6, downgrade to v6, matrix summary. Read-only.',
      {
        action: strProp('Action: matrix | deprecation | changes | downgrade | summary.'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (action === 'matrix') {
          return okResult({
            families: PROTOCOL_V7_FAMILY_LIST,
            current: PROTOCOL_V7_CURRENT_VERSIONS,
            summary: protocolV7MatrixSummary(),
          });
        }
        if (action === 'deprecation') return okResult(protocolV7DeprecationCalendar());
        if (action === 'changes') return okResult(protocolV7ChangesSinceV6());
        if (action === 'downgrade') return okResult(protocolV7DowngradeToV6());
        if (action === 'summary') return okResult({ summary: protocolV7MatrixSummary() });
        return errorResult(`Unknown action "${action}" (known: matrix, deprecation, changes, downgrade, summary).`);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const cardTool: Tool = {
    definition: toolDef(
      'protocol_v7_a2a_card',
      'A2A v1.0.1 Agent Card: issue (JWS-signed), verify, rotate/revoke keys, register/get/list/find in the multi-tenant registry, revoke cards, trust decisions. Private keys never leave the issuer.',
      {
        action: strProp(`Action: ${A2A_V7_CARD_ACTIONS.join(' | ')}.`),
        card: objProp('Card object (issue / register): name, description, version, url, capabilities, skills, authSchemes, tenant.'),
        jws: strProp('JWS compact token (verify / register).'),
        publicKeyPem: strProp('Public key PEM for verification (verify).'),
        keyId: strProp('Key id (revoke-key / revoke-by-key / trust-pin).'),
        tenant: strProp('Tenant (get / list / find-by-capability / trust-summary).'),
        name: strProp('Agent name (get / revoke-card).'),
        capability: strProp('Capability to search (find-by-capability).'),
        reason: strProp('Revocation reason (revoke-key / revoke-card).'),
        ttlSeconds: numProp('Card lifetime in seconds (issue).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const issuer = cardIssuer();
        const registry = cardRegistry();
        const trust = trustStore();
        switch (action) {
          case 'issue': {
            const card = parseCardInput(args);
            const ttlSeconds = args.ttlSeconds === undefined ? undefined : getNumberArg(args, 'ttlSeconds');
            const issued = issuer.issue(card, ttlSeconds !== undefined ? { ttlSeconds } : {});
            return okResult({ jws: issued.jws, keyId: issued.keyId, expiresAtMs: issued.expiresAtMs, card });
          }
          case 'verify': {
            const jws = getStringArg(args, 'jws');
            const publicKeyPem = getStringArg(args, 'publicKeyPem');
            return okResult(verifyA2aV7AgentCard(jws, publicKeyPem));
          }
          case 'rotate-key': {
            const key = issuer.rotate();
            return okResult({ keyId: key.keyId, status: key.status, createdAtMs: key.createdAtMs });
          }
          case 'revoke-key': {
            const keyId = getStringArg(args, 'keyId');
            const revoked = issuer.revokeKey(keyId, getStringArg(args, 'reason', false) || undefined);
            const cards = revoked ? registry.revokeByKey(keyId, getStringArg(args, 'reason', false) || undefined) : 0;
            return okResult({ revoked, cardsRevoked: cards });
          }
          case 'list-keys':
            return okResult(issuer.listKeys().map((k) => ({ keyId: k.keyId, status: k.status, createdAtMs: k.createdAtMs, rotatedAtMs: k.rotatedAtMs })));
          case 'register': {
            const card = parseCardInput(args);
            const jws = getStringArg(args, 'jws');
            const publicKeyPem = getStringArg(args, 'publicKeyPem');
            return okResult(registry.register(card, jws, publicKeyPem));
          }
          case 'get': {
            const entry = registry.get(getStringArg(args, 'tenant', false) || 'default', getStringArg(args, 'name'));
            if (!entry) return errorResult('Card not found (missing, revoked or expired).');
            return okResult(entry);
          }
          case 'list':
            return okResult(registry.list(getStringArg(args, 'tenant', false) || 'default'));
          case 'find-by-capability':
            return okResult(registry.findByCapability(
              getStringArg(args, 'capability'),
              getStringArg(args, 'tenant', false) || undefined,
            ));
          case 'revoke-card': {
            const revoked = registry.revoke(
              getStringArg(args, 'tenant', false) || 'default',
              getStringArg(args, 'name'),
              getStringArg(args, 'reason', false) || undefined,
            );
            return okResult({ revoked });
          }
          case 'revoke-by-key':
            return okResult({ cardsRevoked: registry.revokeByKey(getStringArg(args, 'keyId'), getStringArg(args, 'reason', false) || undefined) });
          case 'trust-decide': {
            const card = parseCardInput(args);
            const keyId = getStringArg(args, 'keyId');
            return okResult(trust.decide(card, keyId));
          }
          case 'trust-pin':
            trust.pinKey(getStringArg(args, 'keyId'));
            return okResult({ pinned: getStringArg(args, 'keyId') });
          case 'trust-summary':
            return okResult(trust.summary());
          case 'prune-expired':
            return okResult({ pruned: registry.pruneExpired() });
          default:
            return errorResult(`Unknown action "${action}" (known: ${A2A_V7_CARD_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const taskTool: Tool = {
    definition: toolDef(
      'protocol_v7_a2a_task',
      'A2A v1.0.1 long-running tasks: submit/start/get/cancel/list/resume, push configs, counts, snapshot/restore, sweep overdue, prune terminal. The engine runs tasks asynchronously with an injected runner.',
      {
        action: strProp(`Action: ${A2A_V7_TASK_ACTIONS.join(' | ')}.`),
        message: strProp('First user message (submit).'),
        taskId: strProp('Task id (start / get / cancel / resume / push actions).'),
        answer: strProp('User answer for an input-required task (resume).'),
        tenant: strProp('Tenant filter (list / counts).'),
        status: strProp('Status filter (list).'),
        contextId: strProp('Context filter (list).'),
        limit: numProp('Max tasks (list).'),
        timeoutMs: numProp('Per-task timeout in ms (submit).'),
        url: strProp('Push webhook URL (add-push-config).'),
        configId: strProp('Push config id (remove-push-config).'),
        snapshot: strProp('Task snapshot JSON (restore).'),
        olderThanMs: numProp('Age threshold in ms (prune-terminal).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const store = taskStore();
        const engine = taskEngine();
        switch (action) {
          case 'submit': {
            const running = engine.submit({
              message: getStringArg(args, 'message'),
              tenant: getStringArg(args, 'tenant', false) || undefined,
              contextId: getStringArg(args, 'contextId', false) || undefined,
              timeoutMs: args.timeoutMs === undefined ? undefined : getNumberArg(args, 'timeoutMs'),
            });
            return okResult({ taskId: running.taskId, task: store.get(running.taskId) });
          }
          case 'start': {
            const running = engine.start(getStringArg(args, 'taskId'));
            return okResult({ taskId: running.taskId, task: store.get(running.taskId) });
          }
          case 'get': {
            const task = store.get(getStringArg(args, 'taskId'));
            if (!task) return errorResult('Task not found.');
            return okResult(task);
          }
          case 'cancel':
            return okResult(engine.cancel(getStringArg(args, 'taskId')));
          case 'list':
            return okResult(store.list({
              tenant: getStringArg(args, 'tenant', false) || undefined,
              status: (getStringArg(args, 'status', false) || undefined) as A2aV7TaskState | undefined,
              contextId: getStringArg(args, 'contextId', false) || undefined,
              limit: args.limit === undefined ? undefined : getNumberArg(args, 'limit'),
            }));
          case 'resume': {
            const running = engine.resume(getStringArg(args, 'taskId'), getStringArg(args, 'answer'));
            return okResult({ taskId: running.taskId, task: store.get(running.taskId) });
          }
          case 'counts':
            return okResult(store.countsByStatus(getStringArg(args, 'tenant', false) || undefined));
          case 'add-push-config':
            return okResult(store.addPushConfig(
              getStringArg(args, 'taskId'),
              getStringArg(args, 'url'),
              { tokenId: getStringArg(args, 'tokenId', false) || undefined },
            ));
          case 'list-push-configs':
            return okResult(store.listPushConfigs(getStringArg(args, 'taskId')));
          case 'remove-push-config':
            return okResult({ removed: store.removePushConfig(getStringArg(args, 'taskId'), getStringArg(args, 'configId')) });
          case 'snapshot':
            return okResult({ snapshot: store.snapshot() });
          case 'restore':
            return okResult({ restored: store.restore(getStringArg(args, 'snapshot')) });
          case 'sweep-overdue':
            return okResult({ failed: engine.sweepOverdue() });
          case 'prune-terminal':
            return okResult({ pruned: store.pruneTerminal(getNumberArg(args, 'olderThanMs')) });
          default:
            return errorResult(`Unknown action "${action}" (known: ${A2A_V7_TASK_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const clientTool: Tool = {
    definition: toolDef(
      'protocol_v7_a2a_client',
      'A2A v1.0.1 client over the loopback pair: connect (card JWS verify + trust), send/stream/get/cancel/list/resubscribe, push configs. No network — the pair runs in-process.',
      {
        action: strProp(`Action: ${A2A_V7_CLIENT_ACTIONS.join(' | ')}.`),
        message: strProp('Message to send (send / stream).'),
        taskId: strProp('Task id (get / cancel / resubscribe / push actions).'),
        contextId: strProp('Context id (send / stream).'),
        waitForCompletion: boolProp('Wait for the task to finish (send).'),
        url: strProp('Push webhook URL (push-set).'),
        configId: strProp('Push config id (push-get / push-delete).'),
        status: strProp('Status filter (list).'),
        limit: numProp('Max tasks (list).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const srv = server();
        const issuer = cardIssuer();
        const active = issuer.activeKey();
        if (!active) return errorResult('No active card issuer key — issue a card key first.');
        // Self-sufficient loopback: when no card is registered yet,
        // issue + register a default card so connect() can verify it.
        if (!srv.agentCard('default')) {
          const defaultCard = buildA2aV7AgentCard({
            name: 'open-bot-agent',
            description: 'Default loopback agent for the v7 A2A client.',
            version: '1.38.0',
            url: 'http://localhost:8080',
            capabilities: ['echo'],
            skills: [],
            authSchemes: ['none'],
            tenant: 'default',
          });
          const issued = issuer.issue(defaultCard);
          cardRegistry().register(defaultCard, issued.jws, active.publicKeyPem);
        }
        const transport = new A2aV7LoopbackTransport(srv);
        const client = new A2aV7Client(transport, {
          peerPublicKeyPem: active.publicKeyPem,
          trustStore: trustStore(),
          sleep: () => Promise.resolve(),
        });
        switch (action) {
          case 'connect':
            return okResult(await client.connect());
          case 'send': {
            await client.connect();
            return okResult(await client.sendMessage(getStringArg(args, 'message'), {
              contextId: getStringArg(args, 'contextId', false) || undefined,
              waitForCompletion: getBooleanArg(args, 'waitForCompletion', false),
            }));
          }
          case 'stream': {
            await client.connect();
            return okResult(await client.streamMessage(getStringArg(args, 'message'), {
              contextId: getStringArg(args, 'contextId', false) || undefined,
            }));
          }
          case 'get':
            await client.connect();
            return okResult(await client.getTask(getStringArg(args, 'taskId')));
          case 'cancel':
            await client.connect();
            return okResult(await client.cancelTask(getStringArg(args, 'taskId')));
          case 'list': {
            await client.connect();
            return okResult(await client.listTasks({
              status: (getStringArg(args, 'status', false) || undefined) as A2aV7TaskState | undefined,
              contextId: getStringArg(args, 'contextId', false) || undefined,
              limit: args.limit === undefined ? undefined : getNumberArg(args, 'limit'),
            }));
          }
          case 'resubscribe':
            await client.connect();
            return okResult(await client.resubscribe(getStringArg(args, 'taskId')));
          case 'push-set': {
            await client.connect();
            return okResult(await client.setPushConfig(getStringArg(args, 'taskId'), getStringArg(args, 'url')));
          }
          case 'push-get': {
            await client.connect();
            return okResult(await client.getPushConfig(getStringArg(args, 'taskId'), getStringArg(args, 'configId')));
          }
          case 'push-list': {
            await client.connect();
            return okResult(await client.listPushConfigs(getStringArg(args, 'taskId')));
          }
          case 'push-delete': {
            await client.connect();
            return okResult(await client.deletePushConfig(getStringArg(args, 'taskId'), getStringArg(args, 'configId')));
          }
          default:
            return errorResult(`Unknown action "${action}" (known: ${A2A_V7_CLIENT_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const serverTool: Tool = {
    definition: toolDef(
      'protocol_v7_a2a_server',
      'A2A v1.0.1 server: dispatch one raw JSON-RPC request (or a batch), serve the Agent Card, report rate-limit usage. Transport-free — the host binds HTTP.',
      {
        action: strProp(`Action: ${A2A_V7_SERVER_ACTIONS.join(' | ')}.`),
        request: objProp('JSON-RPC request object (dispatch): { jsonrpc, id, method, params }.'),
        requests: arrProp('JSON-RPC request objects (batch).'),
        tenant: strProp('Tenant (card / dispatch header).'),
        authorization: strProp('Authorization header value (dispatch).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const srv = server();
        const tenant = getStringArg(args, 'tenant', false) || 'default';
        const headers: Record<string, string | undefined> = {
          'x-a2a-tenant': tenant,
          authorization: getStringArg(args, 'authorization', false) || undefined,
        };
        switch (action) {
          case 'dispatch': {
            const request = getRecordArg(args, 'request');
            return okResult(await srv.handle(request, headers));
          }
          case 'batch': {
            const requests = getArrayArg(args, 'requests');
            return okResult(await srv.handleBatch(requests, headers));
          }
          case 'card': {
            const card = srv.agentCard(tenant);
            if (!card) return errorResult(`No Agent Card for tenant "${tenant}".`);
            return okResult({ mediaType: card.mediaType, card: card.json, jws: card.jws });
          }
          case 'rate-usage':
            return okResult(srv.rateUsage());
          default:
            return errorResult(`Unknown action "${action}" (known: ${A2A_V7_SERVER_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const mcpTool: Tool = {
    definition: toolDef(
      'protocol_v7_mcp_stateless',
      'MCP stateless HTTP (spec 2026-07-28): ping, tools list/call, resources list/read, prompts list/get, statelessness check. Every request is self-describing — no handshake, no session id.',
      {
        action: strProp(`Action: ${MCP_V7_ACTIONS.join(' | ')}.`),
        name: strProp('Tool / prompt name (tools-call / prompts-get).'),
        uri: strProp('Resource URI (resources-read).'),
        arguments: objProp('Tool / prompt arguments (tools-call / prompts-get).'),
        protocolVersion: strProp('Protocol version stamped on the request (default 2026-07-28).'),
        tenant: strProp('Tenant stamped on the request.'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const serverInstance = mcpServer();
        const meta: McpV7RequestMeta = {
          protocolVersion: getStringArg(args, 'protocolVersion', false) || '2026-07-28',
          clientName: 'open-bot',
          tenant: getStringArg(args, 'tenant', false) || 'default',
        };
        const clientWithMeta = new McpV7StatelessClient(createLoopbackMcpV7Sender(serverInstance), {
          protocolVersion: meta.protocolVersion,
          clientName: meta.clientName,
          tenant: meta.tenant,
        });
        switch (action) {
          case 'ping':
            return okResult(await clientWithMeta.ping());
          case 'tools-list':
            return okResult(await clientWithMeta.listTools());
          case 'tools-call':
            return okResult(await clientWithMeta.callTool(getStringArg(args, 'name'), getRecordArg(args, 'arguments')));
          case 'resources-list':
            return okResult(await clientWithMeta.listResources());
          case 'resources-read':
            return okResult(await clientWithMeta.readResource(getStringArg(args, 'uri')));
          case 'prompts-list':
            return okResult(await clientWithMeta.listPrompts());
          case 'prompts-get':
            return okResult(await clientWithMeta.getPrompt(getStringArg(args, 'name'), getRecordArg(args, 'arguments')));
          case 'stateless-check': {
            const request = buildMcpV7Request('tools/list', {}, {
              protocolVersion: meta.protocolVersion,
              clientName: 'open-bot',
              tenant: meta.tenant,
            });
            return okResult(await checkMcpV7Stateless(serverInstance, request));
          }
          case 'register-echo-tool': {
            const toolDefArg: McpV7ToolDefinition = {
              name: getStringArg(args, 'name'),
              description: getStringArg(args, 'description', false) || 'Echo tool registered via protocol_v7_mcp_stateless.',
              inputSchema: { type: 'object', properties: {}, required: [] },
            };
            serverInstance.registerTool(toolDefArg, (toolArgs) => ({
              content: [{ type: 'text', text: `echo: ${JSON.stringify(toolArgs)}` }],
              isError: false,
              structuredContent: { ...toolArgs },
            }));
            return okResult({ registered: toolDefArg.name });
          }
          default:
            return errorResult(`Unknown action "${action}" (known: ${MCP_V7_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const ucpCatalogTool: Tool = {
    definition: toolDef(
      'protocol_v7_ucp_catalog',
      'UCP read-only catalog (v2026-08-25): search / get / list. Read-only — no checkout, no payment, no order placement exists on this path.',
      {
        action: strProp(`Action: ${UCP_V7_CATALOG_ACTIONS.join(' | ')}.`),
        query: strProp('Search query (search).'),
        id: strProp('Catalog item id (get).'),
        offset: numProp('Page offset.'),
        limit: numProp('Page size (max 100).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const adapter = ucpAdapter();
        const offset = args.offset === undefined ? undefined : getNumberArg(args, 'offset');
        const limit = args.limit === undefined ? undefined : getNumberArg(args, 'limit');
        switch (action) {
          case 'search': {
            const page = await adapter.searchCatalog(getStringArg(args, 'query'), { offset, limit });
            return okResult({ ...page, summaries: page.items.map(summarizeUcpV7Item) });
          }
          case 'get': {
            const item = await adapter.getCatalogItem(getStringArg(args, 'id'));
            return okResult({ ...item, summary: summarizeUcpV7Item(item) });
          }
          case 'list': {
            const page = await adapter.listCatalog({ offset, limit });
            return okResult({ ...page, summaries: page.items.map(summarizeUcpV7Item) });
          }
          default:
            return errorResult(`Unknown action "${action}" (known: ${UCP_V7_CATALOG_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const ucpOrderTool: Tool = {
    definition: toolDef(
      'protocol_v7_ucp_order',
      'UCP read-only cart / order / identity: cart get, order get/list, identity status. The "attempt" action proves money operations are refused (checkout / payment / order placement throw a typed refusal).',
      {
        action: strProp(`Action: ${UCP_V7_ORDER_ACTIONS.join(' | ')}.`),
        id: strProp('Cart / order id (cart-get / order-get).'),
        ownerId: strProp('Owner id (order-list / identity-status).'),
        operation: strProp('UCP operation to attempt (attempt): e.g. checkout/create — always refused.'),
        offset: numProp('Page offset.'),
        limit: numProp('Page size (max 100).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const adapter = ucpAdapter();
        const offset = args.offset === undefined ? undefined : getNumberArg(args, 'offset');
        const limit = args.limit === undefined ? undefined : getNumberArg(args, 'limit');
        switch (action) {
          case 'cart-get':
            return okResult(await adapter.getCart(getStringArg(args, 'id')));
          case 'order-get': {
            const order = await adapter.getOrder(getStringArg(args, 'id'));
            return okResult({ ...order, summary: summarizeUcpV7Order(order) });
          }
          case 'order-list': {
            const page = await adapter.listOrders(getStringArg(args, 'ownerId'), { offset, limit });
            return okResult({ ...page, summaries: page.orders.map(summarizeUcpV7Order) });
          }
          case 'identity-status':
            return okResult(await adapter.identityStatus(getStringArg(args, 'ownerId')));
          case 'attempt': {
            const operation = getStringArg(args, 'operation');
            if (isUcpV7RefusedOperation(operation)) {
              return errorResult(new UcpV7MoneyRefusedError(operation).message);
            }
            return okResult(await adapter.attemptOperation(operation, {
              id: getStringArg(args, 'id', false) || undefined,
              ownerId: getStringArg(args, 'ownerId', false) || undefined,
              query: getStringArg(args, 'query', false) || undefined,
            }));
          }
          default:
            return errorResult(`Unknown action "${action}" (known: ${UCP_V7_ORDER_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const governDelegateTool: Tool = {
    definition: toolDef(
      'protocol_v7_govern_delegate',
      'Governance delegation: grant scoped, expiring permissions; check them; revoke (single / cascade / by delegate / by scope); sweep expired; counts. Grants are short-lived (max 24h) and can never exceed their parent scope.',
      {
        action: strProp(`Action: ${GOV_V7_DELEGATE_ACTIONS.join(' | ')}.`),
        delegator: strProp('Who grants (grant).'),
        delegate: strProp('Who receives / is checked / is revoked (grant / check / for-delegate / revoke-by-delegate).'),
        scopes: arrProp('Scopes granted (grant), e.g. ["a2a:send", "mcp:tools/call:*"].'),
        tenant: strProp('Tenant (grant / check / in-tenant).'),
        operation: strProp('Operation to authorize (check / scope-matches), e.g. "mcp:tools/call:echo".'),
        grantId: strProp('Grant id (get / check / revoke / revoke-cascade).'),
        scope: strProp('Scope to revoke / match (revoke-by-scope / scope-matches).'),
        ttlMs: numProp('Grant lifetime in ms (grant, default 1h, max 24h).'),
        maxUses: numProp('Max total uses (grant).'),
        parentGrantId: strProp('Parent grant for sub-delegation (grant).'),
        purpose: strProp('Human-readable purpose (grant).'),
        reason: strProp('Revocation reason (revoke actions).'),
        actor: strProp('Who revokes (revoke actions, default "user").'),
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const engine = policyEngine();
        const actor = getStringArg(args, 'actor', false) || 'user';
        switch (action) {
          case 'grant': {
            const grant = engine.grant({
              delegator: getStringArg(args, 'delegator'),
              delegate: getStringArg(args, 'delegate'),
              scopes: getStringArrayArg(args, 'scopes'),
              tenant: getStringArg(args, 'tenant', false) || 'default',
              ttlMs: args.ttlMs === undefined ? undefined : getNumberArg(args, 'ttlMs'),
              maxUses: args.maxUses === undefined ? undefined : getNumberArg(args, 'maxUses'),
              parentGrantId: getStringArg(args, 'parentGrantId', false) || undefined,
              purpose: getStringArg(args, 'purpose', false) || undefined,
            });
            return okResult({ ...grant, summary: summarizeGovV7Grant(grant) });
          }
          case 'get': {
            const grant = engine.getGrant(getStringArg(args, 'grantId'));
            if (!grant) return errorResult('Grant not found.');
            return okResult({ ...grant, summary: summarizeGovV7Grant(grant) });
          }
          case 'list':
            return okResult(engine.grantsInTenant(getStringArg(args, 'tenant', false) || 'default'));
          case 'for-delegate':
            return okResult(engine.grantsFor(getStringArg(args, 'delegate')));
          case 'in-tenant':
            return okResult(engine.grantsInTenant(getStringArg(args, 'tenant')));
          case 'check':
            return okResult(engine.authorize({
              delegate: getStringArg(args, 'delegate'),
              operation: getStringArg(args, 'operation'),
              tenant: getStringArg(args, 'tenant', false) || 'default',
              grantId: getStringArg(args, 'grantId', false) || undefined,
            }));
          case 'revoke':
            return okResult({ revoked: engine.revoke(getStringArg(args, 'grantId'), actor, getStringArg(args, 'reason', false) || undefined) });
          case 'revoke-cascade':
            return okResult({ revoked: engine.revokeCascade(getStringArg(args, 'grantId'), actor, getStringArg(args, 'reason', false) || undefined) });
          case 'revoke-by-delegate':
            return okResult({ revoked: engine.revokeByDelegate(getStringArg(args, 'delegate'), actor, getStringArg(args, 'reason', false) || undefined) });
          case 'revoke-by-scope':
            return okResult({ revoked: engine.revokeByScope(getStringArg(args, 'scope'), actor, getStringArg(args, 'reason', false) || undefined) });
          case 'sweep':
            return okResult({ swept: engine.sweep() });
          case 'counts':
            return okResult(engine.countsByStatus());
          case 'scope-matches':
            return okResult({ matches: govV7ScopeMatches(getStringArg(args, 'scope'), getStringArg(args, 'operation')) });
          default:
            return errorResult(`Unknown action "${action}" (known: ${GOV_V7_DELEGATE_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const governEscalateTool: Tool = {
    definition: toolDef(
      'protocol_v7_govern_escalate',
      'Human escalation: file a request when the agent cannot decide alone; the user approves or denies; unanswered requests auto-deny at their deadline (never auto-approve).',
      {
        action: strProp(`Action: ${GOV_V7_ESCALATE_ACTIONS.join(' | ')}.`),
        requester: strProp('Agent / delegate filing the request (file).'),
        operation: strProp('Operation needing a human decision (file).'),
        reason: strProp('Why the agent cannot decide alone (file).'),
        tenant: strProp('Tenant (file / pending / list).'),
        grantId: strProp('Related grant id (file).'),
        context: objProp('Context for the user (file).'),
        ttlMs: numProp('Escalation deadline in ms (file, default 15 min).'),
        id: strProp('Escalation id (get / approve / deny).'),
        resolvedBy: strProp('User resolving the request (approve / deny).'),
        note: strProp('Resolution note (approve / deny).'),
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const queue = escalationQueue();
        switch (action) {
          case 'file': {
            const req: GovV7Escalation = queue.file({
              requester: getStringArg(args, 'requester'),
              operation: getStringArg(args, 'operation'),
              reason: getStringArg(args, 'reason'),
              tenant: getStringArg(args, 'tenant', false) || 'default',
              grantId: getStringArg(args, 'grantId', false) || undefined,
              context: getRecordArg(args, 'context'),
              ttlMs: args.ttlMs === undefined ? undefined : getNumberArg(args, 'ttlMs'),
            });
            return okResult(req);
          }
          case 'get': {
            const req = queue.get(getStringArg(args, 'id'));
            if (!req) return errorResult('Escalation not found.');
            return okResult(req);
          }
          case 'pending':
            return okResult(queue.pending(getStringArg(args, 'tenant', false) || undefined));
          case 'list':
            return okResult(queue.list(getStringArg(args, 'tenant', false) || undefined));
          case 'approve':
            return okResult(queue.approve(
              getStringArg(args, 'id'),
              getStringArg(args, 'resolvedBy'),
              getStringArg(args, 'note', false) || undefined,
            ));
          case 'deny':
            return okResult(queue.deny(
              getStringArg(args, 'id'),
              getStringArg(args, 'resolvedBy'),
              getStringArg(args, 'note', false) || undefined,
            ));
          case 'sweep-expired':
            return okResult({ expired: queue.sweepExpired() });
          default:
            return errorResult(`Unknown action "${action}" (known: ${GOV_V7_ESCALATE_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const governAuditTool: Tool = {
    definition: toolDef(
      'protocol_v7_govern_audit',
      'Governance audit log: list / filter entries, verify the hash chain (tamper detection), snapshot / restore. Append-only — entries are never edited or deleted.',
      {
        action: strProp(`Action: ${GOV_V7_AUDIT_ACTIONS.join(' | ')}.`),
        kind: strProp('Entry kind filter (filter): grant / revoke / check / escalate.'),
        actor: strProp('Actor filter (filter).'),
        tenant: strProp('Tenant filter (filter).'),
        subjectId: strProp('Subject filter (filter).'),
        outcome: strProp('Outcome filter (filter).'),
        snapshot: strProp('Audit snapshot JSON (restore).'),
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        const log = auditLog();
        switch (action) {
          case 'list':
            return okResult(log.list());
          case 'filter':
            return okResult(log.filter({
              kind: getStringArg(args, 'kind', false) || undefined,
              actor: getStringArg(args, 'actor', false) || undefined,
              tenant: getStringArg(args, 'tenant', false) || undefined,
              subjectId: getStringArg(args, 'subjectId', false) || undefined,
              outcome: getStringArg(args, 'outcome', false) || undefined,
            }));
          case 'verify':
            return okResult(log.verifyChain());
          case 'snapshot':
            return okResult({ snapshot: log.snapshot(), size: log.size() });
          case 'restore':
            return okResult({ restored: log.restore(getStringArg(args, 'snapshot')) });
          default:
            return errorResult(`Unknown action "${action}" (known: ${GOV_V7_AUDIT_ACTIONS.join(', ')}).`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [
    negotiateTool,
    versionsTool,
    cardTool,
    taskTool,
    clientTool,
    serverTool,
    mcpTool,
    ucpCatalogTool,
    ucpOrderTool,
    governDelegateTool,
    governEscalateTool,
    governAuditTool,
  ];
}
