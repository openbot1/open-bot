/**
 * Protocols v2 — unified UI renderer, wave v1.17 (Team T2).
 *
 * Idea only, learned from the public descriptions in
 * docs/repo-survey-v117.md section 3: AG-UI is an event stream
 * between backend and app, A2UI is declarative client-rendered
 * generative UI, and MCP Apps is the MCP extension where a
 * server supplies an interactive UI resource (`ui://`). The
 * three overlap but have different contracts — this module
 * unifies them in ONE renderer instead of three: every input
 * (an AG-UI event, an A2UI render frame, an MCP Apps resource)
 * becomes a node in the same component tree, and the frontend
 * renders that one tree.
 *
 * This builds on the existing layers without touching them:
 *  - `protocols/aguiEvents.ts` — the 31-type AG-UI vocabulary;
 *  - `protocolsV2/aguiStreamV2.ts` — the ordered, replayable
 *    AG-UI v2 stream (this renderer consumes its events);
 *  - `protocolsV2/a2uiV2.ts` — the A2UI v2 catalog + render
 *    frames (this renderer mounts its frames as nodes);
 *  - `mcp/apps.ts` — MCP Apps HTML validation + iframe
 *    descriptor (`validateAppHtml`, `buildAppFrameDescriptor`).
 * Nothing here executes app HTML or component code: MCP Apps
 * HTML is validated and described (sandbox + CSP) exactly as
 * `mcp/apps.ts` requires, and A2UI state is data only.
 */

import {
  validateProtocolAgUiEvent,
  type ProtocolAgUiEvent,
} from '../protocols/aguiEvents';
import { A2uiV2Catalog, type A2uiV2RenderFrame } from './a2uiV2';
import type { A2uiComponentKind } from '../protocols/a2ui';
import {
  buildAppFrameDescriptor,
  parseAppResource,
  validateAppHtml,
  type AppFrameDescriptor,
  type McpAppResource,
} from '../mcp/apps';

/** Renderer version. */
export const UNIFIED_RENDERER_VERSION = '1.0.0';
/** Maximum nodes in one tree (a runaway stream must not grow it forever). */
export const UNIFIED_RENDERER_MAX_NODES = 500;

/** Error raised by the unified renderer. */
export class UnifiedRendererError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UnifiedRendererError';
    this.code = code;
  }
}

/** Where a node came from. */
export type UnifiedNodeSource = 'agui' | 'a2ui' | 'mcp-apps' | 'system';

/** Kinds of node in the unified tree. */
export type UnifiedNodeKind =
  | 'root'
  | 'text'
  | 'thinking'
  | 'tool-call'
  | 'status'
  | 'form'
  | 'table'
  | 'chart'
  | 'card'
  | 'options'
  | 'approval'
  | 'progress'
  | 'list'
  | 'message'
  | 'app';

/** One node in the unified component tree. */
export interface UnifiedNode {
  id: string;
  kind: UnifiedNodeKind;
  source: UnifiedNodeSource;
  /** Human title (from the frame/spec/event, never a secret). */
  title?: string;
  /** Render data: text, rows, fields, frame descriptor, ... */
  props: Record<string, unknown>;
  /** Child node ids, in render order. */
  children: string[];
  /** Monotonic version of this node (1 = created, +1 per update). */
  version: number;
  /** Node lifecycle. */
  status: 'active' | 'answered' | 'dismissed' | 'error' | 'done';
  /** AG-UI sequence that last touched this node, when applicable. */
  lastSequence?: number;
}

/** A snapshot of the whole tree (what the frontend renders). */
export interface UnifiedTreeSnapshot {
  version: number;
  rootId: string;
  nodes: UnifiedNode[];
  /** Run ids currently feeding the tree. */
  runIds: string[];
  /** Number of nodes, by source. */
  bySource: Record<UnifiedNodeSource, number>;
}

/** What changed between two snapshots. */
export interface UnifiedTreeDiff {
  added: string[];
  updated: string[];
  removed: string[];
  /** True when the root itself changed (structure reset). */
  rootChanged: boolean;
}

/** Loader for an MCP Apps `ui://` resource. */
export type McpAppResourceLoader = (uri: string) => Promise<unknown>;

/** Options for the renderer. */
export interface UnifiedRendererOptions {
  /** A2UI catalog to mount frames against (a fresh one is created when omitted). */
  catalog?: A2uiV2Catalog;
  /** Maximum nodes (default 500). */
  maxNodes?: number;
  /** Called whenever the tree changes (transport hook). */
  onChange?: (snapshot: UnifiedTreeSnapshot) => void;
}

const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.\/-]{0,127}$/;

/** Map an A2UI component kind to a unified node kind. */
export function a2uiKindToUnifiedNodeKind(kind: A2uiComponentKind): UnifiedNodeKind {
  switch (kind) {
    case 'form': return 'form';
    case 'table': return 'table';
    case 'chart': return 'chart';
    case 'card': return 'card';
    case 'options': return 'options';
    case 'approval': return 'approval';
    case 'progress': return 'progress';
    case 'list': return 'list';
    case 'message': return 'message';
    case 'detail': return 'card';
  }
}

/**
 * ONE renderer for three UI sources.
 *
 *   AG-UI stream  -> text / thinking / tool-call / status nodes
 *   A2UI frame    -> form / table / chart / card / ... nodes
 *   MCP Apps ui://-> app nodes (validated HTML + iframe descriptor)
 *
 * The tree is the single source of truth for the frontend: it
 * never has to know which protocol produced a node. Nodes are
 * addressed by stable ids (`agui:<runId>:<messageId>`,
 * `a2ui:<surfaceId>`, `app:<uri>`), so an AG-UI delta, an A2UI
 * state update and an MCP Apps reload all patch the same node
 * instead of appending duplicates. Out-of-order AG-UI events
 * (sequence <= last applied) are ignored, so a replayed stream
 * cannot corrupt the tree.
 */
export class UnifiedRenderer {
  readonly catalog: A2uiV2Catalog;
  private readonly maxNodes: number;
  private readonly onChange?: (snapshot: UnifiedTreeSnapshot) => void;
  private readonly nodes = new Map<string, UnifiedNode>();
  private readonly runIds = new Set<string>();
  private readonly textByMessage = new Map<string, string>();
  private readonly surfaceToNode = new Map<string, string>();
  private readonly appByUri = new Map<string, string>();
  private treeVersion = 0;
  private nodeCounter = 0;
  private lastAgUiSequence = new Map<string, number>();

  constructor(options: UnifiedRendererOptions = {}) {
    this.catalog = options.catalog ?? new A2uiV2Catalog();
    this.maxNodes = options.maxNodes ?? UNIFIED_RENDERER_MAX_NODES;
    this.onChange = options.onChange;
    this.nodes.set('root', {
      id: 'root',
      kind: 'root',
      source: 'system',
      props: {},
      children: [],
      version: 1,
      status: 'active',
    });
  }

  /** Root node id. */
  rootId(): string {
    return 'root';
  }

  /** Number of nodes in the tree (including root). */
  nodeCount(): number {
    return this.nodes.size;
  }

  /** Look up one node. */
  getNode(id: string): UnifiedNode | undefined {
    const node = this.nodes.get(id);
    return node ? { ...node, props: { ...node.props }, children: [...node.children] } : undefined;
  }

  /** All nodes, in insertion order. */
  listNodes(): UnifiedNode[] {
    return [...this.nodes.values()].map((n) => ({ ...n, props: { ...n.props }, children: [...n.children] }));
  }

  /** Nodes from one source. */
  nodesBySource(source: UnifiedNodeSource): UnifiedNode[] {
    return this.listNodes().filter((n) => n.source === source);
  }

  /** Nodes of one kind. */
  nodesOfKind(kind: UnifiedNodeKind): UnifiedNode[] {
    return this.listNodes().filter((n) => n.kind === kind);
  }

  /** Nodes matching a predicate (search the tree). */
  findNodes(predicate: (node: UnifiedNode) => boolean): UnifiedNode[] {
    return this.listNodes().filter(predicate);
  }

  /**
   * Export the whole tree as JSON (snapshot). A renderer can be
   * rebuilt from it with `importTree` — e.g. to restore the UI
   * after a reload without re-running the agent.
   */
  exportTree(): string {
    return JSON.stringify(this.snapshot());
  }

  /**
   * Replace the tree with an exported snapshot. The snapshot is
   * validated (root present, node ids safe, children reference
   * known nodes); a bad snapshot is refused and the current
   * tree is left untouched.
   */
  importTree(json: string): UnifiedTreeSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (err) {
      throw new UnifiedRendererError('INVALID_SNAPSHOT', `Tree snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const problems = validateUnifiedTreeSnapshot(parsed);
    if (problems.length > 0) {
      throw new UnifiedRendererError('INVALID_SNAPSHOT', problems.join('; '));
    }
    const snapshot = parsed as UnifiedTreeSnapshot;
    const next = new Map<string, UnifiedNode>();
    for (const node of snapshot.nodes) {
      next.set(node.id, {
        ...node,
        props: { ...node.props },
        children: [...node.children],
      });
    }
    this.nodes.clear();
    for (const [id, node] of next) this.nodes.set(id, node);
    this.runIds.clear();
    for (const runId of snapshot.runIds) this.runIds.add(runId);
    this.textByMessage.clear();
    this.surfaceToNode.clear();
    this.appByUri.clear();
    for (const node of snapshot.nodes) {
      if (node.kind === 'text' && typeof node.props['text'] === 'string') {
        const messageId = typeof node.props['messageId'] === 'string' ? (node.props['messageId'] as string) : node.id;
        this.textByMessage.set(messageId, node.props['text'] as string);
      }
      if (node.source === 'a2ui' && typeof node.props['surfaceId'] === 'string') {
        this.surfaceToNode.set(node.props['surfaceId'] as string, node.id);
      }
      if (node.source === 'mcp-apps' && typeof node.props['uri'] === 'string') {
        this.appByUri.set(node.props['uri'] as string, node.id);
      }
    }
    this.lastAgUiSequence.clear();
    this.bump();
    return this.snapshot();
  }

  /** Current tree snapshot (what the frontend renders). */
  snapshot(): UnifiedTreeSnapshot {
    const nodes = this.listNodes();
    const bySource: Record<UnifiedNodeSource, number> = { agui: 0, a2ui: 0, 'mcp-apps': 0, system: 0 };
    for (const node of nodes) bySource[node.source] += 1;
    return {
      version: this.treeVersion,
      rootId: 'root',
      nodes,
      runIds: [...this.runIds].sort(),
      bySource,
    };
  }

  /** Diff this snapshot against an older one (by node id + version). */
  static diffSnapshots(before: UnifiedTreeSnapshot, after: UnifiedTreeSnapshot): UnifiedTreeDiff {
    const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
    const afterById = new Map(after.nodes.map((n) => [n.id, n]));
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const node of after.nodes) {
      const prev = beforeById.get(node.id);
      if (!prev) added.push(node.id);
      else if (prev.version !== node.version || prev.status !== node.status) updated.push(node.id);
    }
    for (const node of before.nodes) {
      if (!afterById.has(node.id)) removed.push(node.id);
    }
    return { added, updated, removed, rootChanged: before.rootId !== after.rootId };
  }

  // -- AG-UI ---------------------------------------------------------------

  /**
   * Apply one AG-UI event to the tree. The event is validated
   * first (same rules as the v2 stream); out-of-order events
   * for a run are ignored (replay safety); unknown event types
   * are ignored rather than crashing the renderer.
   * Returns the node id touched, or null when nothing changed.
   */
  applyAgUiEvent(event: ProtocolAgUiEvent): string | null {
    const problems = validateProtocolAgUiEvent(event);
    if (problems.length > 0) {
      throw new UnifiedRendererError('INVALID_AGUI_EVENT', problems.join('; '));
    }
    const last = this.lastAgUiSequence.get(event.runId);
    if (last !== undefined && event.sequence <= last) return null;
    this.lastAgUiSequence.set(event.runId, event.sequence);
    this.runIds.add(event.runId);
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case 'RUN_STARTED': {
        return this.upsertNode(`agui:${event.runId}:status`, 'status', 'agui', {
          title: typeof data['label'] === 'string' ? (data['label'] as string) : event.runId,
          props: { runId: event.runId, state: 'running', resumed: data['resumed'] === true },
          sequence: event.sequence,
        });
      }
      case 'RUN_FINISHED': {
        return this.upsertNode(`agui:${event.runId}:status`, 'status', 'agui', {
          title: event.runId,
          props: { runId: event.runId, state: 'finished', status: data['status'] ?? 'completed' },
          nodeStatus: 'done',
          sequence: event.sequence,
        });
      }
      case 'RUN_ERROR':
      case 'RUN_CANCELLED': {
        return this.upsertNode(`agui:${event.runId}:status`, 'status', 'agui', {
          title: event.runId,
          props: { runId: event.runId, state: event.type === 'RUN_ERROR' ? 'error' : 'cancelled', message: data['message'] ?? data['error'] ?? '' },
          nodeStatus: 'error',
          sequence: event.sequence,
        });
      }
      case 'RUN_PAUSED': {
        return this.upsertNode(`agui:${event.runId}:status`, 'status', 'agui', {
          title: event.runId,
          props: { runId: event.runId, state: 'paused', interruptId: data['interruptId'] ?? '' },
          sequence: event.sequence,
        });
      }
      case 'TEXT_MESSAGE_START': {
        const messageId = typeof data['messageId'] === 'string' ? (data['messageId'] as string) : `m-${event.sequence}`;
        this.textByMessage.set(messageId, '');
        return this.upsertNode(`agui:${event.runId}:${messageId}`, 'text', 'agui', {
          title: messageId,
          props: { runId: event.runId, messageId, role: data['role'] ?? 'assistant', text: '' },
          sequence: event.sequence,
        });
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = typeof data['messageId'] === 'string' ? (data['messageId'] as string) : 'm1';
        const delta = typeof data['delta'] === 'string' ? (data['delta'] as string) : '';
        const text = (this.textByMessage.get(messageId) ?? '') + delta;
        this.textByMessage.set(messageId, text);
        return this.upsertNode(`agui:${event.runId}:${messageId}`, 'text', 'agui', {
          title: messageId,
          props: { runId: event.runId, messageId, text },
          sequence: event.sequence,
        });
      }
      case 'TEXT_MESSAGE_END': {
        const messageId = typeof data['messageId'] === 'string' ? (data['messageId'] as string) : 'm1';
        return this.upsertNode(`agui:${event.runId}:${messageId}`, 'text', 'agui', {
          title: messageId,
          props: { runId: event.runId, messageId, text: this.textByMessage.get(messageId) ?? '' },
          nodeStatus: 'done',
          sequence: event.sequence,
        });
      }
      case 'THINKING_CONTENT': {
        const delta = typeof data['delta'] === 'string' ? (data['delta'] as string) : '';
        const key = `thinking-${event.runId}`;
        const text = (this.textByMessage.get(key) ?? '') + delta;
        this.textByMessage.set(key, text);
        return this.upsertNode(`agui:${event.runId}:thinking`, 'thinking', 'agui', {
          title: 'thinking',
          props: { runId: event.runId, text },
          sequence: event.sequence,
        });
      }
      case 'TOOL_CALL_START':
      case 'TOOL_CALL_ARGS':
      case 'TOOL_CALL_END':
      case 'TOOL_CALL_RESULT':
      case 'TOOL_CALL_ERROR': {
        const callId = typeof data['toolCallId'] === 'string'
          ? (data['toolCallId'] as string)
          : typeof data['name'] === 'string' ? (data['name'] as string) : `tool-${event.sequence}`;
        const existing = this.nodes.get(`agui:${event.runId}:tool:${callId}`);
        const args = existing?.props['args'] ?? data['args'] ?? {};
        const result = event.type === 'TOOL_CALL_RESULT' ? data['result'] : existing?.props['result'];
        const state = event.type === 'TOOL_CALL_ERROR' ? 'error' : event.type === 'TOOL_CALL_RESULT' || event.type === 'TOOL_CALL_END' ? 'done' : 'running';
        return this.upsertNode(`agui:${event.runId}:tool:${callId}`, 'tool-call', 'agui', {
          title: typeof data['name'] === 'string' ? (data['name'] as string) : callId,
          props: {
            runId: event.runId, toolCallId: callId, name: data['name'] ?? callId,
            args, ...(result !== undefined ? { result } : {}),
            ...(event.type === 'TOOL_CALL_ERROR' ? { error: data['error'] ?? data['message'] ?? '' } : {}),
            state,
          },
          nodeStatus: event.type === 'TOOL_CALL_ERROR' ? 'error' : state === 'done' ? 'done' : 'active',
          sequence: event.sequence,
        });
      }
      case 'GENERATIVE_UI_START':
      case 'GENERATIVE_UI_DELTA':
      case 'GENERATIVE_UI_END': {
        // AG-UI generative-UI events carry a component payload;
        // they become a card node (the A2UI frame path handles
        // the full declarative surface when one is provided).
        const componentId = typeof data['componentId'] === 'string' ? (data['componentId'] as string) : `genui-${event.sequence}`;
        const key = `genui-${event.runId}-${componentId}`;
        const text = (this.textByMessage.get(key) ?? '') + (typeof data['delta'] === 'string' ? (data['delta'] as string) : '');
        this.textByMessage.set(key, text);
        return this.upsertNode(`agui:${event.runId}:genui:${componentId}`, 'card', 'agui', {
          title: componentId,
          props: { runId: event.runId, componentId, text, state: event.type === 'GENERATIVE_UI_END' ? 'done' : 'running' },
          nodeStatus: event.type === 'GENERATIVE_UI_END' ? 'done' : 'active',
          sequence: event.sequence,
        });
      }
      case 'INTERRUPT_STARTED': {
        return this.upsertNode(`agui:${event.runId}:interrupt`, 'approval', 'agui', {
          title: 'interrupt',
          props: { runId: event.runId, interruptId: data['interruptId'] ?? '', kind: data['kind'] ?? 'approval', payload: data['payload'] ?? {} },
          sequence: event.sequence,
        });
      }
      case 'INTERRUPT_RESOLVED':
      case 'INTERRUPT_CANCELLED': {
        return this.upsertNode(`agui:${event.runId}:interrupt`, 'approval', 'agui', {
          title: 'interrupt',
          props: { runId: event.runId, interruptId: data['interruptId'] ?? '', resolved: event.type === 'INTERRUPT_RESOLVED' },
          nodeStatus: 'answered',
          sequence: event.sequence,
        });
      }
      default:
        return null;
    }
  }

  /** Apply a whole AG-UI stream (in order); returns touched node ids. */
  applyAgUiEvents(events: readonly ProtocolAgUiEvent[]): string[] {
    const touched: string[] = [];
    for (const event of events) {
      const id = this.applyAgUiEvent(event);
      if (id) touched.push(id);
    }
    return touched;
  }

  // -- A2UI ----------------------------------------------------------------

  /**
   * Mount an A2UI v2 render frame as a node. The frame comes
   * from `A2uiV2Catalog.renderSurface()`; the node kind follows
   * the frame kind and the node carries the frame state, so a
   * state update re-renders the same node.
   */
  mountA2uiFrame(frame: A2uiV2RenderFrame): string {
    const nodeId = `a2ui:${frame.surfaceId}`;
    const node = this.upsertNode(nodeId, a2uiKindToUnifiedNodeKind(frame.kind), 'a2ui', {
      title: frame.title,
      props: {
        surfaceId: frame.surfaceId, componentId: frame.componentId, kind: frame.kind,
        state: { ...frame.state }, stateVersion: frame.stateVersion,
        blocking: frame.blocking, fallbackApplied: frame.fallbackApplied,
        ...(frame.fallbackFrom ? { fallbackFrom: frame.fallbackFrom } : {}),
      },
    });
    this.surfaceToNode.set(frame.surfaceId, nodeId);
    return node;
  }

  /** Patch an A2UI surface's state (from `catalog.updateState`). */
  updateA2uiFrame(frame: A2uiV2RenderFrame): string {
    return this.mountA2uiFrame(frame);
  }

  /** Answer an A2UI surface through the catalog; marks its node answered. */
  answerA2uiSurface(surfaceId: string, answer: Record<string, unknown>): string {
    const surface = this.catalog.answerSurface(surfaceId, answer);
    const nodeId = this.surfaceToNode.get(surfaceId);
    if (!nodeId) throw new UnifiedRendererError('UNKNOWN_SURFACE', `No mounted node for surface ${surfaceId}`);
    const node = this.nodes.get(nodeId)!;
    node.status = 'answered';
    node.version += 1;
    node.props['answer'] = { ...answer };
    this.bump();
    return nodeId;
  }

  /** Dismiss an A2UI surface; marks its node dismissed. */
  dismissA2uiSurface(surfaceId: string): string {
    this.catalog.dismissSurface(surfaceId);
    const nodeId = this.surfaceToNode.get(surfaceId);
    if (!nodeId) throw new UnifiedRendererError('UNKNOWN_SURFACE', `No mounted node for surface ${surfaceId}`);
    const node = this.nodes.get(nodeId)!;
    node.status = 'dismissed';
    node.version += 1;
    this.bump();
    return nodeId;
  }

  /** Active interrupt (approval) nodes from AG-UI streams, by run id. */
  pendingInterrupts(runId?: string): UnifiedNode[] {
    return this.listNodes().filter(
      (n) =>
        n.kind === 'approval' &&
        n.source === 'agui' &&
        n.status === 'active' &&
        (runId === undefined || n.props['runId'] === runId),
    );
  }

  /**
   * Resolve an AG-UI interrupt from the tree: marks the run's
   * approval node answered with the user's answer and returns
   * the node id. The AG-UI stream itself is resolved by its
   * owner (the stream's `resolveInterrupt`); this is the
   * renderer side — what the user clicked, recorded on the
   * node so the UI and the stream agree.
   */
  resolveAgUiInterrupt(runId: string, answer: Record<string, unknown>): string {
    const nodeId = `agui:${runId}:interrupt`;
    const node = this.nodes.get(nodeId);
    if (!node) throw new UnifiedRendererError('UNKNOWN_INTERRUPT', `No interrupt node for run ${runId}`);
    if (node.status !== 'active') {
      throw new UnifiedRendererError('INTERRUPT_ALREADY_RESOLVED', `Interrupt for run ${runId} is already ${node.status}`);
    }
    node.status = 'answered';
    node.version += 1;
    node.props = { ...node.props, answer: { ...answer }, resolved: true };
    this.bump();
    return nodeId;
  }

  // -- MCP Apps ------------------------------------------------------------

  /**
   * Load an MCP Apps `ui://` resource and mount it as an `app`
   * node. The resource is parsed + validated exactly as
   * `mcp/apps.ts` requires (HTML findings are blocking when
   * severe); the node carries the iframe descriptor (srcdoc,
   * sandbox, CSP) — the frontend mounts it verbatim and never
   * relaxes the sandbox. A second load of the same URI patches
   * the same node.
   */
  async loadMcpApp(uri: string, loadResource: McpAppResourceLoader): Promise<string> {
    if (!uri.startsWith('ui://')) {
      throw new UnifiedRendererError('INVALID_APP_URI', `MCP Apps resource must be a ui:// URI, got ${uri}`);
    }
    const raw = await loadResource(uri);
    let app: McpAppResource;
    try {
      app = parseAppResource(raw);
    } catch (err) {
      throw new UnifiedRendererError('INVALID_APP_RESOURCE', err instanceof Error ? err.message : String(err));
    }
    const validation = validateAppHtml(app.html);
    if (!validation.valid) {
      throw new UnifiedRendererError(
        'APP_HTML_REJECTED',
        validation.findings.filter((f) => f.severity === 'blocking').map((f) => `${f.code}: ${f.message}`).join('; ') || 'App HTML failed validation',
      );
    }
    const frame: AppFrameDescriptor = buildAppFrameDescriptor(app);
    const nodeId = `app:${uri}`;
    this.upsertNode(nodeId, 'app', 'mcp-apps', {
      title: frame.title,
      props: {
        uri, title: frame.title, srcdoc: frame.srcdoc, sandbox: frame.sandbox, csp: frame.csp,
        warnings: frame.warnings.map((w) => ({ severity: w.severity, code: w.code })),
      },
    });
    this.appByUri.set(uri, nodeId);
    return nodeId;
  }

  /** Remove the app node for a URI. Returns true when one was mounted. */
  unloadMcpApp(uri: string): boolean {
    const nodeId = this.appByUri.get(uri);
    if (!nodeId) return false;
    this.appByUri.delete(uri);
    return this.removeNode(nodeId);
  }

  // -- Tree ops ------------------------------------------------------------

  /** Remove a node (and detach it from the root). The root cannot be removed (returns false). */
  removeNode(id: string): boolean {
    if (id === 'root') return false;
    const node = this.nodes.get(id);
    if (!node) return false;
    this.nodes.delete(id);
    const root = this.nodes.get('root')!;
    root.children = root.children.filter((c) => c !== id);
    this.bump();
    return true;
  }

  /** Reset the tree to just the root (new run, new conversation). */
  reset(): void {
    this.nodes.clear();
    this.nodes.set('root', {
      id: 'root', kind: 'root', source: 'system', props: {}, children: [], version: 1, status: 'active',
    });
    this.runIds.clear();
    this.textByMessage.clear();
    this.surfaceToNode.clear();
    this.appByUri.clear();
    this.lastAgUiSequence.clear();
    this.bump();
  }

  private upsertNode(
    id: string,
    kind: UnifiedNodeKind,
    source: UnifiedNodeSource,
    input: {
      title?: string;
      props: Record<string, unknown>;
      nodeStatus?: UnifiedNode['status'];
      sequence?: number;
    },
  ): string {
    if (!NODE_ID_RE.test(id)) throw new UnifiedRendererError('INVALID_NODE_ID', `Unsafe node id: ${id}`);
    if (!this.nodes.has(id) && this.nodes.size >= this.maxNodes) {
      throw new UnifiedRendererError('TREE_FULL', `Unified tree is full (${this.maxNodes} nodes)`);
    }
    const existing = this.nodes.get(id);
    if (existing) {
      existing.kind = kind;
      existing.source = source;
      if (input.title !== undefined) existing.title = input.title;
      existing.props = { ...input.props };
      if (input.nodeStatus) existing.status = input.nodeStatus;
      if (input.sequence !== undefined) existing.lastSequence = input.sequence;
      existing.version += 1;
    } else {
      this.nodes.set(id, {
        id,
        kind,
        source,
        ...(input.title !== undefined ? { title: input.title } : {}),
        props: { ...input.props },
        children: [],
        version: 1,
        status: input.nodeStatus ?? 'active',
        ...(input.sequence !== undefined ? { lastSequence: input.sequence } : {}),
      });
      const root = this.nodes.get('root')!;
      if (!root.children.includes(id)) root.children.push(id);
    }
    this.bump();
    return id;
  }

  private bump(): void {
    this.treeVersion += 1;
    if (this.onChange) this.onChange(this.snapshot());
  }
}

/** Validate an exported tree snapshot (returns problems, empty = valid). */
export function validateUnifiedTreeSnapshot(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['snapshot must be an object'];
  const snap = value as Record<string, unknown>;
  if (snap['rootId'] !== 'root') problems.push('snapshot.rootId must be "root"');
  if (!Array.isArray(snap['nodes']) || snap['nodes'].length === 0) {
    problems.push('snapshot.nodes must be a non-empty array');
    return problems;
  }
  const ids = new Set<string>();
  for (const node of snap['nodes'] as unknown[]) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      problems.push('snapshot.nodes entries must be objects');
      break;
    }
    const n = node as Record<string, unknown>;
    if (typeof n['id'] !== 'string' || !NODE_ID_RE.test(n['id'] as string)) {
      problems.push(`snapshot node id "${String(n['id'])}" is not safe`);
      continue;
    }
    if (ids.has(n['id'] as string)) problems.push(`snapshot duplicates node "${n['id'] as string}"`);
    ids.add(n['id'] as string);
    if (typeof n['kind'] !== 'string' || !n['kind']) problems.push(`snapshot node "${n['id'] as string}" needs a kind`);
    if (typeof n['props'] !== 'object' || n['props'] === null || Array.isArray(n['props'])) {
      problems.push(`snapshot node "${n['id'] as string}" needs props`);
    }
    if (!Array.isArray(n['children'])) problems.push(`snapshot node "${n['id'] as string}" needs children`);
  }
  if (!ids.has('root')) problems.push('snapshot must contain the root node');
  for (const node of snap['nodes'] as Array<Record<string, unknown>>) {
    if (!Array.isArray(node['children'])) continue;
    for (const child of node['children'] as unknown[]) {
      if (typeof child !== 'string' || !ids.has(child)) {
        problems.push(`snapshot node "${String(node['id'])}" references unknown child "${String(child)}"`);
      }
    }
  }
  return problems;
}
