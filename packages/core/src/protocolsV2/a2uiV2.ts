/**
 * Protocols v2 — A2UI generative UI v2 (v1.16, Team T2).
 *
 * Idea only, learned from the public A2UI 1.0 description in
 * docs/repo-survey-v116.md section 7: generative UI rendered
 * from the app's own component catalog, running on the AG-UI
 * stream. No code, text or asset from any other repo is copied
 * here. This builds on the v1.15 A2UI layer (`protocols/a2ui.ts`:
 * 10-kind catalog, spec validation, negotiation, surface
 * registry) without touching it: v1.15 validates one spec at a
 * time; v2 is the catalog itself — apps register their own
 * components (with props schema, capabilities and fallbacks),
 * the agent renders declarative state against that catalog, and
 * surfaces carry a render state machine (draft -> rendered ->
 * answered | dismissed | expired) with per-component answer
 * validation.
 *
 * A component registration is data, not code: an id, a kind
 * from the v1.15 catalog, a JSON-Schema-style props shape
 * (required props + prop types), the capabilities it needs, and
 * the kind to fall back to when the client cannot render it.
 * Nothing here executes component code and no spec may carry a
 * script URL — the renderer only ever receives validated data.
 *
 * Render state is declarative: `renderSurface()` takes a spec +
 * a state object (values for the component's props) and returns
 * a render frame the frontend can apply without re-running agent
 * logic; `updateState()` patches the state and re-validates it,
 * so a chart that gains a point or a form that gains a value is
 * a state transition, not a new surface.
 */

import {
  A2UI_COMPONENT_KINDS,
  A2UI_DEFAULT_CAPABILITIES,
  negotiateA2uiSpec,
  validateA2uiAnswer,
  validateA2uiSpec,
  type A2uiClientCapabilities,
  type A2uiComponentKind,
  type A2uiSpec,
  type A2uiSurface,
} from '../protocols/a2ui';

/** A2UI v2 identifier. */
export const A2UI_V2_VERSION = '1.0.0';

/** Prop types a catalog component may declare. */
export const A2UI_V2_PROP_TYPES = ['string', 'number', 'boolean', 'stringArray', 'record', 'recordArray'] as const;
export type A2uiV2PropType = (typeof A2UI_V2_PROP_TYPES)[number];

/** One declared prop of a catalog component. */
export interface A2uiV2PropDeclaration {
  name: string;
  type: A2uiV2PropType;
  required: boolean;
  /** Human-readable hint for the agent filling the prop. */
  hint?: string;
}

/** A component registered in the v2 catalog. */
export interface A2uiV2Component {
  componentId: string;
  kind: A2uiComponentKind;
  /** Props the component accepts (declarative schema). */
  props: A2uiV2PropDeclaration[];
  /** Capabilities the client must have to render it. */
  requiresCapabilities?: string[];
  /** Kind to render instead when the client cannot render this one. */
  fallbackKind?: A2uiComponentKind;
  description: string;
}

/** Error raised by the v2 catalog / renderer. */
export class A2uiV2Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2uiV2Error';
    this.code = code;
  }
}

const COMPONENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Validate a state object against a component's declared props.
 * Returns the problems (empty = valid). Unknown props are
 * refused — a typo in a prop name must fail loudly instead of
 * silently rendering nothing.
 */
export function validateA2uiV2State(component: A2uiV2Component, state: unknown): string[] {
  const problems: string[] = [];
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return ['state must be an object'];
  }
  const record = state as Record<string, unknown>;
  const declared = new Map(component.props.map((p) => [p.name, p]));
  for (const [key, value] of Object.entries(record)) {
    const prop = declared.get(key);
    if (!prop) { problems.push(`unknown prop "${key}" for component "${component.componentId}"`); continue; }
    const ok = checkPropType(prop.type, value);
    if (!ok) problems.push(`prop "${key}" must be ${prop.type}`);
  }
  for (const prop of component.props) {
    if (prop.required && (record[prop.name] === undefined || record[prop.name] === null)) {
      problems.push(`required prop "${prop.name}" is missing for component "${component.componentId}"`);
    }
  }
  return problems;
}

function checkPropType(type: A2uiV2PropType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'stringArray': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'record': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'recordArray': return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v));
  }
}

/** A declarative render frame the frontend applies. */
export interface A2uiV2RenderFrame {
  surfaceId: string;
  componentId: string;
  kind: A2uiComponentKind;
  title: string;
  state: Record<string, unknown>;
  /** True when a fallback kind was applied during negotiation. */
  fallbackApplied: boolean;
  fallbackFrom?: A2uiComponentKind;
  blocking: boolean;
  /** Monotonic version of this surface's state (1 = first render). */
  stateVersion: number;
}

/** Render state of one surface. */
export type A2uiV2SurfaceStatus = 'draft' | 'rendered' | 'answered' | 'dismissed' | 'expired';

export interface A2uiV2Surface extends A2uiSurface {
  componentId: string;
  state: Record<string, unknown>;
  stateVersion: number;
  v2Status: A2uiV2SurfaceStatus;
}

/**
 * The v2 component catalog + renderer.
 *
 * Register components once (usually at app startup, from the
 * app's own UI catalog), then render surfaces against them.
 * The catalog ships with the 10 v1.15 kinds pre-registered as
 * generic components so a surface can always be rendered even
 * before the app registers anything of its own.
 */
export class A2uiV2Catalog {
  private readonly components = new Map<string, A2uiV2Component>();
  private readonly surfaces = new Map<string, A2uiV2Surface>();
  private readonly now: () => number;
  private surfaceCounter = 0;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    for (const kind of A2UI_COMPONENT_KINDS) {
      this.components.set(`generic-${kind}`, {
        componentId: `generic-${kind}`,
        kind,
        props: [{ name: 'text', type: 'string', required: false }],
        description: `Generic ${kind} surface (built-in fallback).`,
      });
    }
  }

  /** Register (or replace) a component. Throws on an invalid registration. */
  registerComponent(component: A2uiV2Component): A2uiV2Component {
    const problems: string[] = [];
    if (!COMPONENT_ID_RE.test(component.componentId)) problems.push(`componentId "${component.componentId}" is not a safe identifier`);
    if (!(A2UI_COMPONENT_KINDS as readonly string[]).includes(component.kind)) problems.push(`kind "${component.kind}" is not a known catalog component`);
    if (!Array.isArray(component.props)) problems.push('props must be an array');
    else {
      const names = new Set<string>();
      for (const prop of component.props) {
        if (!prop.name || names.has(prop.name)) problems.push(`duplicate or empty prop name "${prop.name}"`);
        names.add(prop.name);
        if (!(A2UI_V2_PROP_TYPES as readonly string[]).includes(prop.type)) problems.push(`prop "${prop.name}" has unknown type "${String(prop.type)}"`);
      }
    }
    if (component.fallbackKind !== undefined && !(A2UI_COMPONENT_KINDS as readonly string[]).includes(component.fallbackKind)) {
      problems.push(`fallbackKind "${component.fallbackKind}" is not a known catalog component`);
    }
    if (typeof component.description !== 'string' || component.description.length === 0) problems.push('description is required');
    if (problems.length > 0) throw new A2uiV2Error('INVALID_COMPONENT', problems.join('; '));
    this.components.set(component.componentId, { ...component, props: component.props.map((p) => ({ ...p })) });
    return component;
  }

  /** Look up a component by id. */
  getComponent(componentId: string): A2uiV2Component | undefined {
    return this.components.get(componentId);
  }

  /** All registered components, sorted by id. */
  listComponents(): A2uiV2Component[] {
    return [...this.components.values()].sort((a, b) => a.componentId.localeCompare(b.componentId));
  }

  /** Components of one kind. */
  componentsOfKind(kind: A2uiComponentKind): A2uiV2Component[] {
    return this.listComponents().filter((c) => c.kind === kind);
  }

  /**
   * Render a surface: validate the v1.15 spec, resolve the
   * component, validate the state against its props, negotiate
   * against the client's capabilities (falling back when the
   * client cannot render the requested kind), and store the
   * surface as `rendered`. Returns the render frame.
   */
  renderSurface(
    spec: A2uiSpec,
    state: Record<string, unknown>,
    clientCapabilities: A2uiClientCapabilities = A2UI_DEFAULT_CAPABILITIES,
  ): A2uiV2RenderFrame {
    const specProblems = validateA2uiSpec(spec);
    if (specProblems.length > 0) throw new A2uiV2Error('INVALID_SPEC', specProblems.join('; '));
    const component = this.components.get(spec.componentId);
    if (!component) throw new A2uiV2Error('UNKNOWN_COMPONENT', `Unknown component: ${spec.componentId}`);
    const stateProblems = validateA2uiV2State(component, state);
    if (stateProblems.length > 0) throw new A2uiV2Error('INVALID_STATE', stateProblems.join('; '));
    const negotiated = negotiateA2uiSpec(spec, clientCapabilities);
    this.surfaceCounter += 1;
    const surfaceId = `surface-v2-${this.now().toString(36)}-${this.surfaceCounter}`;
    const surface: A2uiV2Surface = {
      spec: negotiated.spec,
      status: 'pending',
      createdAt: new Date(this.now()).toISOString(),
      componentId: spec.componentId,
      state: { ...state },
      stateVersion: 1,
      v2Status: 'rendered',
    };
    this.surfaces.set(surfaceId, surface);
    return {
      surfaceId,
      componentId: spec.componentId,
      kind: negotiated.spec.kind,
      title: spec.title,
      state: { ...state },
      fallbackApplied: negotiated.fallbackApplied,
      fallbackFrom: negotiated.fallbackFrom,
      blocking: spec.blocking ?? false,
      stateVersion: 1,
    };
  }

  /** Patch a rendered surface's state (re-validated); bumps `stateVersion`. */
  updateState(surfaceId: string, patch: Record<string, unknown>): A2uiV2RenderFrame {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV2Error('UNKNOWN_SURFACE', `Unknown surface: ${surfaceId}`);
    if (surface.v2Status !== 'rendered') {
      throw new A2uiV2Error('INVALID_SURFACE_STATE', `Cannot update a ${surface.v2Status} surface`);
    }
    const component = this.components.get(surface.componentId);
    if (!component) throw new A2uiV2Error('UNKNOWN_COMPONENT', `Unknown component: ${surface.componentId}`);
    const nextState = { ...surface.state, ...patch };
    const problems = validateA2uiV2State(component, nextState);
    if (problems.length > 0) throw new A2uiV2Error('INVALID_STATE', problems.join('; '));
    surface.state = nextState;
    surface.stateVersion += 1;
    return {
      surfaceId,
      componentId: surface.componentId,
      kind: surface.spec.kind,
      title: surface.spec.title,
      state: { ...nextState },
      fallbackApplied: false,
      blocking: surface.spec.blocking ?? false,
      stateVersion: surface.stateVersion,
    };
  }

  /** Answer a rendered surface (validated against the v1.15 answer rules). */
  answerSurface(surfaceId: string, answer: Record<string, unknown>): A2uiV2Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV2Error('UNKNOWN_SURFACE', `Unknown surface: ${surfaceId}`);
    if (surface.v2Status !== 'rendered') {
      throw new A2uiV2Error('INVALID_SURFACE_STATE', `Cannot answer a ${surface.v2Status} surface`);
    }
    const problems = validateA2uiAnswer(surface.spec, answer);
    if (problems.length > 0) throw new A2uiV2Error('INVALID_ANSWER', problems.join('; '));
    surface.status = 'answered';
    surface.v2Status = 'answered';
    surface.answeredAt = new Date(this.now()).toISOString();
    surface.answer = { ...answer };
    return surface;
  }

  /** Dismiss a rendered surface without answering it. */
  dismissSurface(surfaceId: string): A2uiV2Surface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface) throw new A2uiV2Error('UNKNOWN_SURFACE', `Unknown surface: ${surfaceId}`);
    if (surface.v2Status !== 'rendered') {
      throw new A2uiV2Error('INVALID_SURFACE_STATE', `Cannot dismiss a ${surface.v2Status} surface`);
    }
    surface.status = 'dismissed';
    surface.v2Status = 'dismissed';
    return surface;
  }

  /** Look up a surface by id. */
  getSurface(surfaceId: string): A2uiV2Surface | undefined {
    return this.surfaces.get(surfaceId);
  }

  /** Surfaces in one render state. */
  surfacesByStatus(status: A2uiV2SurfaceStatus): A2uiV2Surface[] {
    return [...this.surfaces.values()].filter((s) => s.v2Status === status);
  }

  /** Number of surfaces rendered so far. */
  surfaceCount(): number {
    return this.surfaces.size;
  }
}
