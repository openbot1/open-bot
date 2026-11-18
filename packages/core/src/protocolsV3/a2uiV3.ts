/**
 * Protocols v3 — A2UI declarative components v3 (v1.19, Team T3).
 *
 * Idea only, learned from the public A2UI 1.0 description in
 * docs/repo-survey-v119.md section 2: declarative UI rendered from
 * the app's own component catalog, running on the AG-UI stream —
 * the agent describes *what* to show, the client decides *how*.
 * No code, text or asset from any other repo is copied here.
 *
 * This builds on the existing A2UI layers without touching them:
 *  - `protocols/a2ui.ts` — the 10-kind catalog, spec validation,
 *    negotiation, surface registry, answer validation;
 *  - `protocolsV2/a2uiV2.ts` — the v2 catalog (components with
 *    declared props, render frames, surface state machine
 *    draft/rendered/answered/dismissed/expired).
 * v3 extends the catalog and the render model:
 *   1. new component kinds — `tabs`, `stepper`, `timeline`,
 *      `kanban`, `media`, `code`, `markdown`, `metric` — each with
 *      declared props and a fallback kind from the v1.15 set, so a
 *      client that cannot render `kanban` still shows a `list`;
 *   2. layouts — a render tree: `stack` (vertical) and `grid`
 *      (columns) nodes that compose components into one surface,
 *      validated recursively with a depth cap;
 *   3. data binding — a surface state may bind a prop to a path in
 *      the run's shared state (`bind: "state.todos"`), resolved at
 *      render time and re-resolved on every state delta;
 *   4. actions — declarative actions a component may raise
 *      (`submit`, `select`, `dismiss`, `open-link`, `tool-call`),
 *      each validated (no script URLs, only https links, tool
 *      calls only to tools the run already declared);
 *   5. surface lifecycle v3 — `draft -> rendered -> answered |
 *      dismissed | expired`, plus `updated` (state changed) and
 *      `superseded` (a newer surface replaced this one).
 *
 * Components are data, never code: no spec may carry a script URL,
 * an inline handler, or an executable payload. The renderer only
 * ever receives validated data.
 */

import {
  A2UI_COMPONENT_KINDS,
  type A2uiComponentKind,
} from '../protocols/a2ui';
import {
  A2uiV2Catalog,
  validateA2uiV2State,
  type A2uiV2Component,
  type A2uiV2PropDeclaration,
  type A2uiV2PropType,
  type A2uiV2RenderFrame,
  type A2uiV2Surface,
} from '../protocolsV2/a2uiV2';

/** A2UI version this layer speaks. */
export const A2UI_V3_VERSION = '1.0';
/** Max depth of a render tree (layout nesting). */
export const A2UI_V3_MAX_TREE_DEPTH = 4;
/** Max components in one render tree. */
export const A2UI_V3_MAX_TREE_NODES = 32;
/** Max chars of a markdown/code prop. */
export const A2UI_V3_MAX_TEXT_PROP = 50_000;

/** Error raised by the v3 A2UI layer. */
export class A2uiV3Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2uiV3Error';
    this.code = code;
  }
}

/** Component kinds added in v3. */
export const A2UI_V3_NEW_KINDS = [
  'tabs',
  'stepper',
  'timeline',
  'kanban',
  'media',
  'code',
  'markdown',
  'metric',
] as const;
export type A2uiV3NewKind = (typeof A2UI_V3_NEW_KINDS)[number];

/** All kinds the v3 catalog knows (v1.15 + v3). */
export const A2UI_V3_COMPONENT_KINDS = [
  ...A2UI_COMPONENT_KINDS,
  ...A2UI_V3_NEW_KINDS,
] as const;
export type A2uiV3ComponentKind = (typeof A2UI_V3_COMPONENT_KINDS)[number];

/** True when the kind is one the v3 catalog knows. */
export function isA2uiV3ComponentKind(value: unknown): value is A2uiV3ComponentKind {
  return (
    typeof value === 'string' &&
    (A2UI_V3_COMPONENT_KINDS as readonly string[]).includes(value)
  );
}

/** Fallback kind (from the v1.15 set) for each new v3 kind. */
export const A2UI_V3_FALLBACK_KINDS: Record<A2uiV3NewKind, A2uiComponentKind> = {
  tabs: 'list',
  stepper: 'progress',
  timeline: 'list',
  kanban: 'table',
  media: 'card',
  code: 'message',
  markdown: 'message',
  metric: 'card',
};

/** Default props for each new v3 kind (the catalog registers these). */
export function a2uiV3DefaultProps(kind: A2uiV3NewKind): A2uiV2PropDeclaration[] {
  switch (kind) {
    case 'tabs':
      return [
        { name: 'tabs', type: 'recordArray', required: true, hint: 'Tab labels + ids' },
        { name: 'activeTab', type: 'string', required: false, hint: 'Id of the active tab' },
      ];
    case 'stepper':
      return [
        { name: 'steps', type: 'stringArray', required: true, hint: 'Step labels in order' },
        { name: 'currentStep', type: 'number', required: true, hint: 'Index of the current step' },
      ];
    case 'timeline':
      return [
        { name: 'events', type: 'recordArray', required: true, hint: 'Timeline events (time + label)' },
      ];
    case 'kanban':
      return [
        { name: 'columns', type: 'recordArray', required: true, hint: 'Columns with cards' },
        { name: 'cards', type: 'recordArray', required: false, hint: 'Cards (id, column, title)' },
      ];
    case 'media':
      return [
        { name: 'url', type: 'string', required: true, hint: 'https URL of the media' },
        { name: 'alt', type: 'string', required: false, hint: 'Alt text' },
        { name: 'caption', type: 'string', required: false, hint: 'Caption under the media' },
      ];
    case 'code':
      return [
        { name: 'language', type: 'string', required: false, hint: 'Language for highlighting' },
        { name: 'code', type: 'string', required: true, hint: 'Source code text' },
      ];
    case 'markdown':
      return [{ name: 'text', type: 'string', required: true, hint: 'Markdown text' }];
    case 'metric':
      return [
        { name: 'label', type: 'string', required: true, hint: 'Metric label' },
        { name: 'value', type: 'string', required: true, hint: 'Metric value (formatted)' },
        { name: 'delta', type: 'string', required: false, hint: 'Change vs previous (e.g. +12%)' },
      ];
  }
}

/** Layout node kinds for a render tree. */
export type A2uiV3LayoutKind = 'stack' | 'grid';

/** One node of a declarative render tree. */
export interface A2uiV3RenderNode {
  /** `component` renders one catalog component; layout kinds group children. */
  kind: 'component' | A2uiV3LayoutKind;
  /** Component id (only for `component` nodes). */
  componentId?: string;
  /** State for the component (only for `component` nodes). */
  state?: Record<string, unknown>;
  /** Children (only for layout nodes). */
  children?: A2uiV3RenderNode[];
  /** Grid columns (only for `grid` nodes, 1..6). */
  columns?: number;
  /** Weight inside a stack (relative flex, > 0). */
  weight?: number;
}

/** A declarative action a component may raise. */
export interface A2uiV3Action {
  /** Action kind. */
  kind: 'submit' | 'select' | 'dismiss' | 'open-link' | 'tool-call';
  /** Label shown on the control (for submit/select/dismiss). */
  label?: string;
  /** URL (only for `open-link`; must be https). */
  url?: string;
  /** Tool name (only for `tool-call`). */
  toolName?: string;
  /** Tool arguments (only for `tool-call`). */
  toolArgs?: Record<string, unknown>;
  /** Value carried by a `select` action. */
  value?: string;
}

/** A data binding: a prop reads a path out of the run state. */
export interface A2uiV3Binding {
  /** Prop name the binding fills. */
  prop: string;
  /** Dot path inside the run state, e.g. `todos` or `user.name`. */
  path: string;
}

/** Surface lifecycle states in v3. */
export type A2uiV3SurfaceStatus =
  | 'draft'
  | 'rendered'
  | 'updated'
  | 'answered'
  | 'dismissed'
  | 'expired'
  | 'superseded';

/** One v3 surface (a rendered tree + its lifecycle). */
export interface A2uiV3Surface {
  surfaceId: string;
  runId: string;
  title: string;
  tree: A2uiV3RenderNode;
  status: A2uiV3SurfaceStatus;
  stateVersion: number;
  bindings: A2uiV3Binding[];
  actions: A2uiV3Action[];
  blocking: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Resolve a dot path inside a state object (undefined when missing). */
export function resolveA2uiV3BindingPath(state: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').filter((p) => p !== '');
  if (parts.length === 0) return undefined;
  let current: unknown = state;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Validate one declarative action. Returns the problems. */
export function validateA2uiV3Action(
  action: unknown,
  allowedToolNames: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return ['action must be an object'];
  }
  const record = action as Record<string, unknown>;
  const kind = record['kind'];
  if (
    kind !== 'submit' &&
    kind !== 'select' &&
    kind !== 'dismiss' &&
    kind !== 'open-link' &&
    kind !== 'tool-call'
  ) {
    return [`unknown action kind: ${String(kind)}`];
  }
  if (kind === 'open-link') {
    const url = record['url'];
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      problems.push('open-link action needs an https URL');
    }
  }
  if (kind === 'tool-call') {
    const toolName = record['toolName'];
    if (typeof toolName !== 'string' || toolName === '') {
      problems.push('tool-call action needs a toolName');
    } else if (allowedToolNames.length > 0 && !allowedToolNames.includes(toolName)) {
      problems.push(`tool-call action names undeclared tool "${toolName}"`);
    }
    if (record['toolArgs'] !== undefined && typeof record['toolArgs'] !== 'object') {
      problems.push('tool-call toolArgs must be an object when present');
    }
  }
  if (kind === 'select' && typeof record['value'] !== 'string') {
    problems.push('select action needs a string value');
  }
  // Anything that smells like code is refused outright.
  for (const key of Object.keys(record)) {
    if (/^(on\w+|script|href|javascript)$/i.test(key)) {
      problems.push(`action must not carry "${key}" (components are data, never code)`);
    }
  }
  return problems;
}

/** Component lookup used by tree validation (v2 catalog or v3 catalog). */
export type A2uiV3ComponentLookup = (componentId: string) => A2uiV2Component | null;

/** Validate a render tree against a component lookup. Returns the problems. */
export function validateA2uiV3Tree(
  tree: unknown,
  lookup: A2uiV3ComponentLookup,
  options: { depth?: number } = {},
): string[] {
  const problems: string[] = [];
  let nodeCount = 0;
  const walk = (node: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > A2UI_V3_MAX_TREE_NODES) {
      problems.push(`Render tree exceeds ${A2UI_V3_MAX_TREE_NODES} nodes`);
      return;
    }
    if (depth > A2UI_V3_MAX_TREE_DEPTH) {
      problems.push(`Render tree exceeds max depth ${A2UI_V3_MAX_TREE_DEPTH}`);
      return;
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      problems.push('Render node must be an object');
      return;
    }
    const record = node as Record<string, unknown>;
    const kind = record['kind'];
    if (kind === 'component') {
      const componentId = record['componentId'];
      if (typeof componentId !== 'string' || componentId === '') {
        problems.push('Component node needs a componentId');
        return;
      }
      const component = lookup(componentId);
      if (!component) {
        problems.push(`Unknown component "${componentId}"`);
        return;
      }
      const state = record['state'];
      if (state !== undefined) {
        problems.push(...validateA2uiV2State(component, state));
        // Text props are size-capped (a runaway agent must not flood the UI).
        for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
          if (
            typeof value === 'string' &&
            value.length > A2UI_V3_MAX_TEXT_PROP &&
            (key === 'text' || key === 'code')
          ) {
            problems.push(`prop "${key}" exceeds ${A2UI_V3_MAX_TEXT_PROP} chars`);
          }
        }
      }
      if (record['children'] !== undefined) problems.push('Component node must not have children');
      return;
    }
    if (kind === 'stack' || kind === 'grid') {
      const children = record['children'];
      if (!Array.isArray(children) || children.length === 0) {
        problems.push(`${kind} node needs a non-empty children array`);
        return;
      }
      if (kind === 'grid') {
        const columns = record['columns'];
        if (typeof columns !== 'number' || !Number.isInteger(columns) || columns < 1 || columns > 6) {
          problems.push('grid node needs columns as an integer 1..6');
        }
      }
      for (const child of children) walk(child, depth + 1);
      return;
    }
    problems.push(`Unknown render node kind: ${String(kind)}`);
  };
  walk(tree, options.depth ?? 0);
  return problems;
}

/** Apply bindings: fill bound props from the run state. */
export function applyA2uiV3Bindings(
  state: Record<string, unknown>,
  bindings: readonly A2uiV3Binding[],
  runState: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...state };
  for (const binding of bindings) {
    const value = resolveA2uiV3BindingPath(runState, binding.path);
    if (value !== undefined) out[binding.prop] = value;
  }
  return out;
}

/**
 * The v3 catalog + renderer. Wraps the v2 catalog (which already
 * knows the 10 v1.15 kinds) and registers the 8 new v3 kinds with
 * their props + fallbacks. Surfaces render whole trees, not single
 * components.
 */
export class A2uiV3Catalog {
  private readonly v2: A2uiV2Catalog;
  /** v3 kinds live here: the v2 catalog only accepts v1.15 kinds. */
  private readonly own = new Map<string, A2uiV2Component>();
  private readonly surfaces = new Map<string, A2uiV3Surface>();
  private readonly allowedTools: string[];

  constructor(allowedToolNames: readonly string[] = []) {
    this.v2 = new A2uiV2Catalog();
    this.allowedTools = [...allowedToolNames];
    for (const kind of A2UI_V3_NEW_KINDS) {
      const component: A2uiV2Component = {
        componentId: `v3-${kind}`,
        kind: kind as unknown as A2uiComponentKind,
        props: a2uiV3DefaultProps(kind),
        fallbackKind: A2UI_V3_FALLBACK_KINDS[kind],
        description: `v3 ${kind} component (fallback: ${A2UI_V3_FALLBACK_KINDS[kind]})`,
      };
      this.own.set(component.componentId, component);
    }
  }

  /** The underlying v2 catalog (for single-component renders). */
  getV2Catalog(): A2uiV2Catalog {
    return this.v2;
  }

  /** Register a custom component (v1.15 kind; validated by the v2 catalog). */
  register(component: A2uiV2Component): void {
    this.v2.registerComponent(component);
  }

  /** One component by id (v3 kinds first, then the v2 catalog), or null. */
  get(componentId: string): A2uiV2Component | null {
    return this.own.get(componentId) ?? this.v2.getComponent(componentId) ?? null;
  }

  /** All registered components (v2 generics + v3 kinds). */
  list(): A2uiV2Component[] {
    return [...this.v2.listComponents(), ...this.own.values()].sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    );
  }

  /** All v3 surfaces (oldest first). */
  listSurfaces(): A2uiV3Surface[] {
    return [...this.surfaces.values()];
  }

  /** One surface by id, or null. */
  getSurface(surfaceId: string): A2uiV3Surface | null {
    return this.surfaces.get(surfaceId) ?? null;
  }

  /**
   * Render a tree as a new surface. Validates the tree, the actions
   * and the bindings; resolves bindings against `runState` for the
   * first frame. Returns the surface + its first render frame.
   */
  renderSurface(options: {
    surfaceId: string;
    runId: string;
    title: string;
    tree: A2uiV3RenderNode;
    bindings?: A2uiV3Binding[];
    actions?: A2uiV3Action[];
    blocking?: boolean;
    runState?: Record<string, unknown>;
  }): { surface: A2uiV3Surface; frame: A2uiV2RenderFrame } {
    if (this.surfaces.has(options.surfaceId)) {
      throw new A2uiV3Error('DUPLICATE_SURFACE', `Surface ${options.surfaceId} already exists`);
    }
    const treeProblems = validateA2uiV3Tree(options.tree, (id) => this.get(id));
    if (treeProblems.length > 0) {
      throw new A2uiV3Error('INVALID_TREE', `Invalid render tree: ${treeProblems.join('; ')}`);
    }
    const actions = options.actions ?? [];
    for (const action of actions) {
      const problems = validateA2uiV3Action(action, this.allowedTools);
      if (problems.length > 0) {
        throw new A2uiV3Error('INVALID_ACTION', `Invalid action: ${problems.join('; ')}`);
      }
    }
    const bindings = options.bindings ?? [];
    const runState = options.runState ?? {};
    const resolvedTree = this.resolveTreeBindings(options.tree, bindings, runState);
    const now = new Date().toISOString();
    const surface: A2uiV3Surface = {
      surfaceId: options.surfaceId,
      runId: options.runId,
      title: options.title,
      tree: resolvedTree,
      status: 'rendered',
      stateVersion: 1,
      bindings,
      actions,
      blocking: options.blocking ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.surfaces.set(options.surfaceId, surface);
    const firstComponent = this.firstComponentId(options.tree) ?? 'v3-markdown';
    const frame: A2uiV2RenderFrame = {
      surfaceId: options.surfaceId,
      componentId: firstComponent,
      kind: 'message',
      title: options.title,
      state: {},
      fallbackApplied: false,
      blocking: surface.blocking,
      stateVersion: 1,
    };
    return { surface, frame };
  }

  /** Update a surface's run state (re-resolves bindings, bumps version). */
  updateSurfaceState(
    surfaceId: string,
    runState: Record<string, unknown>,
  ): A2uiV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    if (surface.status !== 'rendered' && surface.status !== 'updated') {
      throw new A2uiV3Error('BAD_STATUS', `Cannot update a surface in state ${surface.status}`);
    }
    surface.tree = this.resolveTreeBindings(surface.tree, surface.bindings, runState);
    surface.stateVersion += 1;
    surface.status = 'updated';
    surface.updatedAt = new Date().toISOString();
    return surface;
  }

  /** Answer a surface (a submit/select action was taken). */
  answerSurface(surfaceId: string, answer: Record<string, unknown>): A2uiV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    if (surface.status !== 'rendered' && surface.status !== 'updated') {
      throw new A2uiV3Error('BAD_STATUS', `Cannot answer a surface in state ${surface.status}`);
    }
    void answer;
    surface.status = 'answered';
    surface.updatedAt = new Date().toISOString();
    return surface;
  }

  /** Dismiss a surface. */
  dismissSurface(surfaceId: string): A2uiV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    surface.status = 'dismissed';
    surface.updatedAt = new Date().toISOString();
    return surface;
  }

  /** Expire a surface (timeout). */
  expireSurface(surfaceId: string): A2uiV3Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV3Error('NO_SUCH_SURFACE', `No surface ${surfaceId}`);
    surface.status = 'expired';
    surface.updatedAt = new Date().toISOString();
    return surface;
  }

  /** Supersede a surface with a newer one (the old one stays readable). */
  supersedeSurface(oldSurfaceId: string, newSurfaceId: string): A2uiV3Surface {
    const surface = this.surfaces.get(oldSurfaceId);
    if (!surface) throw new A2uiV3Error('NO_SUCH_SURFACE', `No surface ${oldSurfaceId}`);
    if (!this.surfaces.has(newSurfaceId)) {
      throw new A2uiV3Error('NO_SUCH_SURFACE', `No surface ${newSurfaceId}`);
    }
    surface.status = 'superseded';
    surface.updatedAt = new Date().toISOString();
    return surface;
  }

  private resolveTreeBindings(
    tree: A2uiV3RenderNode,
    bindings: readonly A2uiV3Binding[],
    runState: Record<string, unknown>,
  ): A2uiV3RenderNode {
    if (tree.kind === 'component') {
      return {
        ...tree,
        state: applyA2uiV3Bindings(tree.state ?? {}, bindings, runState),
      };
    }
    return {
      ...tree,
      children: (tree.children ?? []).map((child) =>
        this.resolveTreeBindings(child, bindings, runState),
      ),
    };
  }

  private firstComponentId(tree: A2uiV3RenderNode): string | null {
    if (tree.kind === 'component') return tree.componentId ?? null;
    for (const child of tree.children ?? []) {
      const found = this.firstComponentId(child);
      if (found) return found;
    }
    return null;
  }
}

/** Prop types re-exported for callers that only import v3. */
export type { A2uiV2PropType };
