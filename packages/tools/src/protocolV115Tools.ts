/**
 * Protocol triad tools for @open-bot/tools (v1.15, Team T2).
 *
 * The agent drives the protocol triad by tool call:
 *  - protocol_agui_emit        — validate + emit one AG-UI 1.0 event
 *    into a run stream (local action)
 *  - protocol_agui_catalog     — the 31 AG-UI event types in 8 groups (read)
 *  - protocol_interrupt_raise  — raise an approval/form/choice interrupt
 *    and block until the user answers (local action; needs approval)
 *  - protocol_interrupt_resolve — resume or cancel a pending interrupt (local action)
 *  - protocol_a2ui_render      — validate + register an A2UI surface spec (local action)
 *  - protocol_a2ui_answer      — answer a pending surface (local action)
 *  - protocol_a2a_card         — build + HMAC-sign an Agent Card (read;
 *    the signature is internal-hmac, NOT PKI — see core protocols/a2aCard.ts)
 *  - protocol_a2a_negotiate    — negotiate the A2A protocol version (read)
 *  - protocol_mcp_discover     — stateless MCP server/discover + list tools (read)
 *
 * Factory:
 *   createProtocolV115Tools(opts) -> Tool[]   (bound, usable)
 *   PROTOCOL_V115_TOOLS                       (unbound placeholder)
 *
 * SAFETY: interrupts and surfaces are DATA ONLY — validated in
 * the core module before they reach any renderer; no HTML, no
 * scripts. The HMAC key for card signing comes from the host
 * via opts (vault-backed in the app); the tools never log it
 * and never put it in a result. MCP discover never sends a
 * session id and never calls `initialize`.
 *
 * NOTE (v1.15 merge): exported from the tools package but NOT
 * yet wired into defaultToolFactory — the coordinator wires
 * createProtocolV115Tools and recounts the tool pin, as with
 * the v1.10 AG-UI v2 tools.
 */
import type { Tool } from '@open-bot/core';
import {
  A2uiSurfaceRegistry,
  A2UI_DEFAULT_CAPABILITIES,
  McpStatelessClientV115,
  ProtocolAgUiEmitter,
  ProtocolInterruptManager,
  buildSignedAgentCard,
  describeA2aBinding,
  isProtocolAgUiEventType,
  negotiateA2aVersion,
  negotiateA2uiSpec,
  validateA2uiSpec,
  validateProtocolInterruptPayload,
  verifySignedAgentCard,
  PROTOCOL_AGUI_EVENT_TYPES,
  protocolAgUiEventGroup,
  protocolAgUiEventTypesOfGroup,
  type A2aBindingKind,
  type A2uiClientCapabilities,
  type A2uiSpec,
  type McpStatelessTransport,
  type ProtocolAgUiEventType,
  type ProtocolInterruptPayload,
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

function getRecordArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
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

export interface ProtocolV115ToolOptions {
  /** Emitter lookup: the host binds its run emitters. */
  getEmitter?: (runId: string) => ProtocolAgUiEmitter | undefined;
  /** Create a fresh emitter for a run id when none exists. */
  createEmitter?: (runId: string) => ProtocolAgUiEmitter;
  /** Interrupt manager accessor (the host binds its manager). */
  getInterruptManager?: () => ProtocolInterruptManager | null;
  /** Surface registry accessor (the host binds its registry). */
  getSurfaceRegistry?: () => A2uiSurfaceRegistry | null;
  /** HMAC key for A2A card signing (vault-backed in the app). */
  getHmacKey?: () => string | null;
  /** MCP transport accessor (the host binds its server endpoint). */
  getMcpTransport?: () => McpStatelessTransport | null;
  /** Default A2UI client capabilities. */
  defaultCapabilities?: A2uiClientCapabilities;
}

export function createProtocolV115Tools(opts: ProtocolV115ToolOptions = {}): Tool[] {
  let fallbackEmitter: ProtocolAgUiEmitter | null = null;
  let fallbackInterrupts: ProtocolInterruptManager | null = null;
  let fallbackSurfaces: A2uiSurfaceRegistry | null = null;

  const needEmitter = (runId: string): ProtocolAgUiEmitter => {
    const found = opts.getEmitter?.(runId);
    if (found) return found;
    const created = opts.createEmitter?.(runId);
    if (created) return created;
    if (!fallbackEmitter || fallbackEmitter.runId !== runId) {
      fallbackEmitter = new ProtocolAgUiEmitter(runId);
    }
    return fallbackEmitter;
  };
  const needInterrupts = (): ProtocolInterruptManager => {
    const manager = opts.getInterruptManager?.() ?? fallbackInterrupts;
    if (!manager) {
      fallbackInterrupts = new ProtocolInterruptManager();
      return fallbackInterrupts;
    }
    return manager;
  };
  const needSurfaces = (): A2uiSurfaceRegistry => {
    const registry = opts.getSurfaceRegistry?.() ?? fallbackSurfaces;
    if (!registry) {
      fallbackSurfaces = new A2uiSurfaceRegistry();
      return fallbackSurfaces;
    }
    return registry;
  };

  const emit: Tool = {
    definition: toolDef(
      'protocol_agui_emit',
      'Emit one AG-UI 1.0 event into a run stream (local action): the event type must be one of the 31 types (see protocol_agui_catalog); sequence and timestamp are assigned by the emitter. Terminal events (RUN_FINISHED/RUN_ERROR/RUN_CANCELLED) end the run. Returns the emitted event.',
      {
        runId: { type: 'string', description: 'Run the event belongs to.' },
        type: { type: 'string', description: 'AG-UI 1.0 event type, e.g. TEXT_MESSAGE_CONTENT.' },
        data: { type: 'object', description: 'Event payload object for the type.' },
        stepId: { type: 'string', description: 'Optional step inside the run.' },
      },
      ['runId', 'type', 'data'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const runId = getStringArg(args, 'runId');
        const type = getStringArg(args, 'type');
        if (!isProtocolAgUiEventType(type)) {
          throw new Error(`Unknown AG-UI 1.0 event type "${type}". See protocol_agui_catalog.`);
        }
        const data = getRecordArg(args, 'data');
        const stepId = args['stepId'] === undefined ? undefined : getStringArg(args, 'stepId');
        const emitter = needEmitter(runId);
        const event = emitter.emit(type as ProtocolAgUiEventType, data as never, stepId);
        if (!event) return errorResult(`Run ${runId} already ended; event dropped.`);
        return JSON.stringify({ event }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const catalog: Tool = {
    definition: toolDef(
      'protocol_agui_catalog',
      'The AG-UI 1.0 event catalog (read): all 31 event types in 8 groups (lifecycle, text, toolCall, state, interrupt, subagent, generativeUi, custom), plus the 3 terminal types.',
      {
        group: { type: 'string', description: 'Optional group to filter by (lifecycle, text, toolCall, state, interrupt, subagent, generativeUi, custom).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const group = args['group'] === undefined ? undefined : getStringArg(args, 'group');
        const types = group === undefined
          ? [...PROTOCOL_AGUI_EVENT_TYPES]
          : protocolAgUiEventTypesOfGroup(group as never);
        return JSON.stringify({
          version: 'agui/1.0',
          count: types.length,
          types: types.map((t) => ({ type: t, group: protocolAgUiEventGroup(t) })),
          terminalTypes: ['RUN_FINISHED', 'RUN_ERROR', 'RUN_CANCELLED'],
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const interruptRaise: Tool = {
    definition: toolDef(
      'protocol_interrupt_raise',
      'Raise an approval/form/choice interrupt and block until the user answers (local action): the run pauses mid-run and the frontend shows the payload. Resolves with the user answer; the tool result reports the answer or the cancel/timeout reason. Needs approval because it blocks the run on a human.',
      {
        runId: { type: 'string', description: 'Run that pauses for the interrupt.' },
        payload: { type: 'object', description: 'Interrupt payload: {kind: approval|form|choice, title, detail?, fields?, choices?, approvalText?, timeoutMs?}.' },
        stepId: { type: 'string', description: 'Optional step inside the run.' },
      },
      ['runId', 'payload'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const runId = getStringArg(args, 'runId');
        const payload = getRecordArg(args, 'payload') as unknown as ProtocolInterruptPayload;
        const stepId = args['stepId'] === undefined ? undefined : getStringArg(args, 'stepId');
        const problems = validateProtocolInterruptPayload(payload);
        if (problems.length > 0) throw new Error(`Invalid interrupt payload: ${problems.join('; ')}`);
        const manager = needInterrupts();
        const answer = await manager.raise(runId, payload, stepId);
        return JSON.stringify({ resolved: true, answer }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const interruptResolve: Tool = {
    definition: toolDef(
      'protocol_interrupt_resolve',
      'Resume or cancel a pending interrupt (local action): resume with the user answer object, or cancel with a reason. The first resolution wins; a later one reports already-resolved.',
      {
        interruptId: { type: 'string', description: 'Interrupt id from protocol_interrupt_raise or the pending list.' },
        outcome: { type: 'string', description: 'resume or cancel.' },
        answer: { type: 'object', description: 'Answer object for resume (approval: {approved}, choice: {choiceId}, form: field values).' },
        reason: { type: 'string', description: 'Reason for cancel.' },
      },
      ['interruptId', 'outcome'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const interruptId = getStringArg(args, 'interruptId');
        const outcome = getStringArg(args, 'outcome');
        if (outcome !== 'resume' && outcome !== 'cancel') {
          throw new Error('Argument "outcome" must be resume or cancel.');
        }
        const answer = args['answer'] === undefined ? undefined : getRecordArg(args, 'answer');
        const reason = args['reason'] === undefined ? undefined : getStringArg(args, 'reason');
        const manager = needInterrupts();
        const resolution = manager.resolve(interruptId, outcome, answer, reason);
        return JSON.stringify({ resolution }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2uiRender: Tool = {
    definition: toolDef(
      'protocol_a2ui_render',
      'Validate and register an A2UI generative surface (local action): the spec must use one of the 10 catalog kinds (card, form, table, chart, approval, options, message, progress, list, detail). Invalid specs are refused with the validation problems. Returns the registered surface.',
      {
        spec: { type: 'object', description: 'A2UI spec: {componentId, kind, runId, title, data, blocking?, expiresAfterMs?}.' },
        capabilities: { type: 'object', description: 'Optional client capabilities to negotiate against ({kinds, charts, interactive, maxTableRows}).' },
      },
      ['spec'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const spec = getRecordArg(args, 'spec') as unknown as A2uiSpec;
        const problems = validateA2uiSpec(spec);
        if (problems.length > 0) throw new Error(`Invalid A2UI spec: ${problems.join('; ')}`);
        const capabilities = args['capabilities'] === undefined
          ? (opts.defaultCapabilities ?? A2UI_DEFAULT_CAPABILITIES)
          : (getRecordArg(args, 'capabilities') as unknown as A2uiClientCapabilities);
        const negotiated = negotiateA2uiSpec(spec, capabilities);
        const registry = needSurfaces();
        const surface = registry.register(negotiated.spec);
        return JSON.stringify({ surface, negotiated: { fallbackApplied: negotiated.fallbackApplied, ...(negotiated.fallbackFrom !== undefined ? { fallbackFrom: negotiated.fallbackFrom } : {}) } }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2uiAnswer: Tool = {
    definition: toolDef(
      'protocol_a2ui_answer',
      'Answer a pending A2UI surface (local action): form answers carry field values, approval answers carry {actionId}, options answers carry {selectedId} (or {selectedIds} for multi). A second answer is refused as already-resolved.',
      {
        componentId: { type: 'string', description: 'Component id of the pending surface.' },
        answer: { type: 'object', description: 'Answer object for the surface kind.' },
      },
      ['componentId', 'answer'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const componentId = getStringArg(args, 'componentId');
        const answer = getRecordArg(args, 'answer');
        const registry = needSurfaces();
        const outcome = registry.answer(componentId, answer);
        return JSON.stringify({ outcome }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aCard: Tool = {
    definition: toolDef(
      'protocol_a2a_card',
      'Build and HMAC-sign an A2A v1.0 Agent Card (read): returns the card plus its internal-hmac signature envelope. The signature proves only that the card was issued by a holder of the same local secret — it is NOT a PKI signature. Needs the host HMAC key (vault-backed); without it the tool refuses.',
      {
        name: { type: 'string', description: 'Agent name.' },
        description: { type: 'string', description: 'Agent description.' },
        url: { type: 'string', description: 'Agent endpoint URL (http(s)).' },
        version: { type: 'string', description: 'Optional agent version.' },
        protocolVersion: { type: 'string', description: 'Optional A2A protocol version (default 1.0.1).' },
        bindings: { type: 'array', description: 'Optional binding kinds to advertise: JSONRPC, GRPC, HTTP_JSON.' },
        keyId: { type: 'string', description: 'Optional key id recorded in the envelope.' },
      },
      ['name', 'description', 'url'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const name = getStringArg(args, 'name');
        const description = getStringArg(args, 'description');
        const url = getStringArg(args, 'url');
        const hmacKey = opts.getHmacKey?.() ?? null;
        if (!hmacKey) {
          return errorResult('No HMAC key configured (host must supply one via opts.getHmacKey).');
        }
        const version = args['version'] === undefined ? undefined : getStringArg(args, 'version');
        const protocolVersion = args['protocolVersion'] === undefined ? undefined : getStringArg(args, 'protocolVersion');
        const keyId = args['keyId'] === undefined ? undefined : getStringArg(args, 'keyId');
        const bindings = args['bindings'] === undefined
          ? undefined
          : getStringArrayArg(args, 'bindings').map((b) => {
            if (b !== 'JSONRPC' && b !== 'GRPC' && b !== 'HTTP_JSON') {
              throw new Error(`Unknown binding kind "${b}". Use JSONRPC, GRPC or HTTP_JSON.`);
            }
            return b as A2aBindingKind;
          });
        const signed = buildSignedAgentCard({
          name,
          description,
          url,
          ...(version !== undefined ? { version } : {}),
          ...(protocolVersion !== undefined ? { protocolVersion } : {}),
          ...(keyId !== undefined ? { keyId } : {}),
          hmacKey,
          ...(bindings !== undefined
            ? { bindings: bindings.map((kind) => describeA2aBinding(kind, url, protocolVersion ?? '1.0.1')) }
            : {}),
        });
        const check = verifySignedAgentCard(signed, hmacKey);
        return JSON.stringify({ signedCard: signed, selfCheck: check }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const a2aNegotiate: Tool = {
    definition: toolDef(
      'protocol_a2a_negotiate',
      'Negotiate the A2A protocol version (read): given the client versions and the server versions, returns the highest common version, or null when the two sides share none.',
      {
        clientVersions: { type: 'array', description: 'Protocol versions the client speaks, e.g. ["1.0", "1.0.1"].' },
        serverVersions: { type: 'array', description: 'Protocol versions the server speaks.' },
      },
      ['clientVersions', 'serverVersions'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const clientVersions = getStringArrayArg(args, 'clientVersions');
        const serverVersions = getStringArrayArg(args, 'serverVersions');
        const negotiation = negotiateA2aVersion(clientVersions, serverVersions);
        return JSON.stringify({ negotiation }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpDiscover: Tool = {
    definition: toolDef(
      'protocol_mcp_discover',
      'Stateless MCP server/discover (read): asks the configured MCP server for its discovery document (protocol version, capabilities, server info) and lists its tools. Stateless 2026-07-28 — no initialize handshake, no session id. Needs the host MCP transport; without it the tool refuses.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const transport = opts.getMcpTransport?.() ?? null;
        if (!transport) {
          return errorResult('No MCP transport configured (host must supply one via opts.getMcpTransport).');
        }
        const client = new McpStatelessClientV115(transport);
        const discovered = await client.discover();
        const tools = await client.listTools();
        return JSON.stringify({ discovered, tools }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [emit, catalog, interruptRaise, interruptResolve, a2uiRender, a2uiAnswer, a2aCard, a2aNegotiate, mcpDiscover];
}

/** Unbound placeholder (the host binds state via createProtocolV115Tools). */
export const PROTOCOL_V115_TOOLS: Tool[] = createProtocolV115Tools();

export const PROTOCOL_V115_TOOL_NAMES = [
  'protocol_agui_emit',
  'protocol_agui_catalog',
  'protocol_interrupt_raise',
  'protocol_interrupt_resolve',
  'protocol_a2ui_render',
  'protocol_a2ui_answer',
  'protocol_a2a_card',
  'protocol_a2a_negotiate',
  'protocol_mcp_discover',
] as const;

export function isProtocolV115ToolName(name: string): name is (typeof PROTOCOL_V115_TOOL_NAMES)[number] {
  return (PROTOCOL_V115_TOOL_NAMES as readonly string[]).includes(name);
}
