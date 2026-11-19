/**
 * MCP Apps render v2 — render MCP Apps as interactive UI (v1.44, Team T3).
 *
 * What existed before:
 *   - `apps.ts` / `appsManager.ts` (v1): render raw HTML a server
 *     returned, inside a sandboxed iframe.
 *   - `appsV2.ts` (v1.04): declare the template BEFORE render —
 *     prefetch resources, cache policy, review state, the exact list
 *     of actions the UI may initiate (`allowedActions`), fingerprint.
 *   - `appsUiV15.ts` / `appsComponentsV2.ts`: component catalogues
 *     and UI dialect helpers.
 *
 * What was still missing — and what this module adds:
 *
 *   1. A **safe UI descriptor** instead of raw HTML. The server
 *      describes its UI as a JSON tree of typed nodes (`text`,
 *      `button`, `input`, `form`, `list`, `progress`, `alert`, …).
 *      The host validates the tree (bounded depth / node count,
 *      unique ids, safe image URLs, actions restricted to the
 *      template's `allowedActions`) and the renderer only ever
 *      renders validated nodes. No HTML parsing, no script, no
 *      `innerHTML` anywhere on this path.
 *   2. A **render session lifecycle**: `mounting -> mounted ->
 *      suspended -> mounted -> unmounted`, plus an `error` state a
 *      failed descriptor or a denied action can land in without
 *      killing the host. Sessions keep their own input state
 *      (form fields, selections), an action history (capped), and
 *      render statistics — so the UI panel can show "this app is
 *      suspended / errored / waiting for review" instead of a
 *      blank frame.
 *   3. **Action dispatch with policy**: every UI action (button
 *      click, form submit, select change) is checked against the
 *      declared template (`appActionAllowed`) AND the session
 *      state (mounted only). Denied actions are recorded in the
 *      session history and, when an audit log is attached, via
 *      `recordAppAction` / `recordAppActionDenied` from `appsV2.ts`.
 *      The dispatch result tells the renderer exactly what
 *      happened (`ok`, the tool to call, the form values, or the
 *      denial reason) — the renderer never guesses.
 *
 * Ideas only — no code copied from any MCP implementation, SDK,
 * or the Grok Bot / Cursor installers. The descriptor shape is
 * this repo's own design, informed by the OpenHands "Agent
 * Plugins declared in mcp.json" idea (survey v1.44): a plugin
 * declares its UI up front, the host renders it.
 */

import type { McpAuditLog } from './auditLog';
import {
  APP_UI_ACTION_KINDS,
  appActionAllowed,
  recordAppAction,
  recordAppActionDenied,
} from './appsV2';
import type { AppUiActionKind, DeclaredAppTemplate } from './appsV2';

/** Error raised by the render-v2 layer (bad descriptor, bad session use). */
export class AppRenderV2Error extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'AppRenderV2Error';
    this.code = code;
  }
}

/** Kinds of node a server UI descriptor may contain (closed list). */
export type AppUiNodeKind =
  | 'container'
  | 'heading'
  | 'text'
  | 'alert'
  | 'divider'
  | 'image'
  | 'button'
  | 'input'
  | 'select'
  | 'progress'
  | 'list'
  | 'form';

export const APP_UI_NODE_KINDS: readonly AppUiNodeKind[] = [
  'container',
  'heading',
  'text',
  'alert',
  'divider',
  'image',
  'button',
  'input',
  'select',
  'progress',
  'list',
  'form',
];

/** Visual tone of an alert / button node. */
export type AppUiTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export const APP_UI_TONES: readonly AppUiTone[] = [
  'info',
  'success',
  'warning',
  'error',
  'neutral',
];

/** One node of a validated app UI descriptor tree. */
export interface AppUiNode {
  /** Stable id inside the tree (unique per descriptor). */
  id: string;
  kind: AppUiNodeKind;
  /** Display text (heading / text / button label / alert body). */
  text?: string;
  /** Visual tone (alert / button). */
  tone?: AppUiTone;
  /** Image URL — `https://…` or `ui://…` only (validated). */
  src?: string;
  /** Alt text for images. */
  alt?: string;
  /** Input field name (input / select inside a form). */
  name?: string;
  /** Input type (`text` | `number` | `password` | `email`). */
  inputType?: 'text' | 'number' | 'password' | 'email';
  /** Placeholder / initial value for inputs. */
  placeholder?: string;
  /** Default value for inputs / selects. */
  value?: string;
  /** Options for a select node. */
  options?: { value: string; label: string }[];
  /** Progress 0..1 (progress node). */
  progress?: number;
  /** Progress label (progress node). */
  progressLabel?: string;
  /** List items (list node) — plain strings, rendered as rows. */
  items?: string[];
  /** Action this node triggers (button / form submit). */
  action?: AppRenderUiAction;
  /** Child nodes (container / form / list containers). */
  children?: AppUiNode[];
}

/** An action a UI node may trigger. */
export interface AppRenderUiAction {
  /** Kind — must be in the template's `allowedActions`. */
  kind: AppUiActionKind;
  /** Tool to call (for `tool-call`). */
  toolName?: string;
  /** Arguments to pass to the tool (JSON-safe). */
  args?: Record<string, unknown>;
  /** Link to open (for `link-open`) — https:// only. */
  href?: string;
  /** Resource to read (for `resource-read`) — ui:// or https://. */
  uri?: string;
  /** Free-form label shown in the audit trail. */
  label?: string;
}

/** A full UI descriptor: one tree + the template it belongs to. */
export interface AppUiDescriptor {
  /** Template id this descriptor was built for. */
  templateId: string;
  /** Root node (usually a `container`). */
  root: AppUiNode;
  /** Descriptor version (host only understands 1). */
  version: number;
}

/** Validation limits for a descriptor tree. */
export const APP_RENDER_V2_MAX_DEPTH = 8;
export const APP_RENDER_V2_MAX_NODES = 200;
export const APP_RENDER_V2_MAX_TEXT = 4000;
export const APP_RENDER_V2_MAX_ITEMS = 100;
export const APP_RENDER_V2_MAX_OPTIONS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeUiUri(uri: string): boolean {
  if (uri.startsWith('ui://')) return uri.length > 'ui://'.length;
  if (uri.startsWith('https://')) {
    try {
      const parsed = new URL(uri);
      return parsed.hostname.length > 0 && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }
  return false;
}

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value !== 'number' || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, depth + 1));
  if (isRecord(value)) return Object.values(value).every((v) => isJsonSafe(v, depth + 1));
  return false;
}

interface NodeCheck {
  errors: string[];
  warnings: string[];
  count: number;
}

function checkAction(
  action: unknown,
  nodeId: string,
  template: DeclaredAppTemplate,
  check: NodeCheck,
): AppRenderUiAction | undefined {
  if (action === undefined) return undefined;
  if (!isRecord(action)) {
    check.errors.push(`Node "${nodeId}": action phải là object.`);
    return undefined;
  }
  const kind = action['kind'];
  if (typeof kind !== 'string' || !(APP_UI_ACTION_KINDS as readonly string[]).includes(kind)) {
    check.errors.push(
      `Node "${nodeId}": action kind không biết: ${JSON.stringify(kind)}.`,
    );
    return undefined;
  }
  const actionKind = kind as AppUiActionKind;
  if (!appActionAllowed(template, actionKind)) {
    check.errors.push(
      `Node "${nodeId}": template "${template.id}" không cho phép action "${actionKind}" ` +
        `(allowed: ${template.allowedActions.join(', ') || 'không có'}).`,
    );
    return undefined;
  }
  if (actionKind === 'tool-call' && typeof action['toolName'] !== 'string') {
    check.errors.push(`Node "${nodeId}": action tool-call cần toolName.`);
    return undefined;
  }
  if (actionKind === 'link-open') {
    const href = action['href'];
    if (typeof href !== 'string' || !href.startsWith('https://')) {
      check.errors.push(`Node "${nodeId}": action link-open cần href https://.`);
      return undefined;
    }
  }
  if (actionKind === 'resource-read') {
    const uri = action['uri'];
    if (typeof uri !== 'string' || !isSafeUiUri(uri)) {
      check.errors.push(`Node "${nodeId}": action resource-read cần uri https:// hoặc ui://.`);
      return undefined;
    }
  }
  if (action['args'] !== undefined && !isJsonSafe(action['args'])) {
    check.errors.push(`Node "${nodeId}": action args phải JSON-safe.`);
    return undefined;
  }
  const out: AppRenderUiAction = { kind: actionKind };
  if (typeof action['toolName'] === 'string') out.toolName = action['toolName'];
  if (isRecord(action['args'])) out.args = { ...(action['args'] as Record<string, unknown>) };
  if (typeof action['href'] === 'string') out.href = action['href'];
  if (typeof action['uri'] === 'string') out.uri = action['uri'];
  if (typeof action['label'] === 'string') out.label = action['label'];
  return out;
}

function checkNode(
  raw: unknown,
  template: DeclaredAppTemplate,
  ids: Set<string>,
  depth: number,
  check: NodeCheck,
): AppUiNode | undefined {
  check.count += 1;
  if (check.count > APP_RENDER_V2_MAX_NODES) {
    check.errors.push(
      `Descriptor vượt quá ${APP_RENDER_V2_MAX_NODES} node.`,
    );
    return undefined;
  }
  if (depth > APP_RENDER_V2_MAX_DEPTH) {
    check.errors.push(`Node quá sâu (tối đa ${APP_RENDER_V2_MAX_DEPTH} tầng).`);
    return undefined;
  }
  if (!isRecord(raw)) {
    check.errors.push('Node phải là object.');
    return undefined;
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    check.errors.push(`Node id không hợp lệ: ${JSON.stringify(id)}.`);
    return undefined;
  }
  if (ids.has(id)) {
    check.errors.push(`Node id trùng: "${id}".`);
    return undefined;
  }
  ids.add(id);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(APP_UI_NODE_KINDS as readonly string[]).includes(kind)) {
    check.errors.push(`Node "${id}": kind không biết: ${JSON.stringify(kind)}.`);
    return undefined;
  }
  const nodeKind = kind as AppUiNodeKind;
  const node: AppUiNode = { id, kind: nodeKind };
  const text = raw['text'];
  if (text !== undefined) {
    if (typeof text !== 'string' || text.length > APP_RENDER_V2_MAX_TEXT) {
      check.errors.push(`Node "${id}": text phải là string tối đa ${APP_RENDER_V2_MAX_TEXT} ký tự.`);
    } else {
      node.text = text;
    }
  }
  if (nodeKind === 'heading' || nodeKind === 'text' || nodeKind === 'button') {
    if (typeof node.text !== 'string' || node.text.length === 0) {
      check.errors.push(`Node "${id}" (${nodeKind}) cần text không rỗng.`);
    }
  }
  const tone = raw['tone'];
  if (tone !== undefined) {
    if (typeof tone !== 'string' || !(APP_UI_TONES as readonly string[]).includes(tone)) {
      check.errors.push(`Node "${id}": tone không biết: ${JSON.stringify(tone)}.`);
    } else {
      node.tone = tone as AppUiTone;
    }
  }
  if (nodeKind === 'image') {
    const src = raw['src'];
    if (typeof src !== 'string' || !isSafeUiUri(src)) {
      check.errors.push(`Node "${id}": image cần src https:// hoặc ui:// an toàn.`);
    } else {
      node.src = src;
    }
    if (typeof raw['alt'] === 'string') node.alt = raw['alt'];
  }
  if (nodeKind === 'input' || nodeKind === 'select') {
    const name = raw['name'];
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
      check.errors.push(`Node "${id}": input/select cần name hợp lệ (chữ + số + _).`);
    } else {
      node.name = name;
    }
    if (nodeKind === 'input') {
      const inputType = raw['inputType'];
      if (inputType !== undefined) {
        if (inputType !== 'text' && inputType !== 'number' && inputType !== 'password' && inputType !== 'email') {
          check.errors.push(`Node "${id}": inputType không biết: ${JSON.stringify(inputType)}.`);
        } else {
          node.inputType = inputType;
        }
      }
      if (typeof raw['placeholder'] === 'string') node.placeholder = raw['placeholder'];
    }
    if (nodeKind === 'select') {
      const options = raw['options'];
      if (!Array.isArray(options) || options.length === 0 || options.length > APP_RENDER_V2_MAX_OPTIONS) {
        check.errors.push(
          `Node "${id}": select cần 1..${APP_RENDER_V2_MAX_OPTIONS} options.`,
        );
      } else {
        const parsed: { value: string; label: string }[] = [];
        for (const opt of options as unknown[]) {
          if (!isRecord(opt) || typeof opt['value'] !== 'string' || typeof opt['label'] !== 'string') {
            check.errors.push(`Node "${id}": select option phải có { value, label } string.`);
            break;
          }
          parsed.push({ value: opt['value'] as string, label: opt['label'] as string });
        }
        if (parsed.length === (options as unknown[]).length) node.options = parsed;
      }
    }
    if (typeof raw['value'] === 'string') node.value = raw['value'];
  }
  if (nodeKind === 'progress') {
    const progress = raw['progress'];
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) {
      check.errors.push(`Node "${id}": progress phải là số 0..1.`);
    } else {
      node.progress = progress;
    }
    if (typeof raw['progressLabel'] === 'string') node.progressLabel = raw['progressLabel'];
  }
  if (nodeKind === 'list') {
    const items = raw['items'];
    if (!Array.isArray(items) || items.length > APP_RENDER_V2_MAX_ITEMS) {
      check.errors.push(`Node "${id}": list cần mảng tối đa ${APP_RENDER_V2_MAX_ITEMS} item.`);
    } else if (!items.every((i) => typeof i === 'string')) {
      check.errors.push(`Node "${id}": list items phải là string.`);
    } else {
      node.items = [...(items as string[])];
    }
  }
  const action = checkAction(raw['action'], id, template, check);
  if (action) node.action = action;
  if (nodeKind === 'button' && !action) {
    check.warnings.push(`Node "${id}": button không có action — sẽ render như nút trơ.`);
  }
  const children = raw['children'];
  if (children !== undefined) {
    if (nodeKind !== 'container' && nodeKind !== 'form') {
      check.errors.push(`Node "${id}" (${nodeKind}) không được có children.`);
    } else if (!Array.isArray(children)) {
      check.errors.push(`Node "${id}": children phải là mảng.`);
    } else {
      const parsed: AppUiNode[] = [];
      for (const child of children as unknown[]) {
        const parsedChild = checkNode(child, template, ids, depth + 1, check);
        if (parsedChild) parsed.push(parsedChild);
      }
      node.children = parsed;
    }
  }
  if (nodeKind === 'container' && (!node.children || node.children.length === 0)) {
    check.warnings.push(`Node "${id}": container rỗng.`);
  }
  return node;
}

/** Result of validating a UI descriptor. */
export interface AppUiDescriptorValidation {
  valid: boolean;
  descriptor?: AppUiDescriptor;
  errors: string[];
  warnings: string[];
  nodeCount: number;
}

/**
 * Validate a raw UI descriptor against a declared template.
 * Returns `{ valid: false, errors }` instead of throwing, so the
 * renderer can show the errors — a bad descriptor is a UI state,
 * not a crash. Actions are checked against the template's
 * `allowedActions` here, at declaration time, not at click time.
 */
export function validateAppUiDescriptor(
  raw: unknown,
  template: DeclaredAppTemplate,
): AppUiDescriptorValidation {
  const check: NodeCheck = { errors: [], warnings: [], count: 0 };
  if (!isRecord(raw)) {
    return { valid: false, errors: ['Descriptor phải là object.'], warnings: [], nodeCount: 0 };
  }
  if (raw['version'] !== 1) {
    return {
      valid: false,
      errors: [`Descriptor version không hỗ trợ: ${JSON.stringify(raw['version'])} (host chỉ hiểu version 1).`],
      warnings: [],
      nodeCount: 0,
    };
  }
  if (typeof raw['templateId'] !== 'string' || raw['templateId'] !== template.id) {
    return {
      valid: false,
      errors: [`Descriptor templateId "${String(raw['templateId'])}" không khớp template "${template.id}".`],
      warnings: [],
      nodeCount: 0,
    };
  }
  const ids = new Set<string>();
  const root = checkNode(raw['root'], template, ids, 0, check);
  if (!root) {
    check.errors.push('Descriptor thiếu root node hợp lệ.');
  }
  if (check.errors.length > 0) {
    return { valid: false, errors: check.errors, warnings: check.warnings, nodeCount: check.count };
  }
  return {
    valid: true,
    descriptor: { templateId: template.id, root: root as AppUiNode, version: 1 },
    errors: [],
    warnings: check.warnings,
    nodeCount: check.count,
  };
}

/** Lifecycle state of a render session. */
export type AppRenderSessionState =
  | 'mounting'
  | 'mounted'
  | 'suspended'
  | 'error'
  | 'unmounted';

/** One entry in a session's action history (capped). */
export interface AppRenderActionRecord {
  seq: number;
  at: number;
  nodeId: string;
  kind: AppUiActionKind;
  outcome: 'ok' | 'denied';
  detail: string;
}

/** Statistics of a render session. */
export interface AppRenderSessionStats {
  mounts: number;
  actions: number;
  denied: number;
  errors: number;
  stateChanges: number;
}

/** Serializable snapshot of a render session (for the UI / IPC). */
export interface AppRenderSessionSnapshot {
  sessionId: string;
  templateId: string;
  serverName: string;
  title: string;
  state: AppRenderSessionState;
  nodeCount: number;
  reviewWarning: boolean;
  inputState: Record<string, string>;
  actionCount: number;
  deniedCount: number;
  error?: string;
  mountedAt?: number;
  updatedAt: number;
}

export const APP_RENDER_V2_MAX_HISTORY = 200;

/** Options for creating a render session. */
export interface AppRenderSessionOptions {
  /** Who triggered actions in this session (audit `actor`). */
  actor?: string;
  /** Audit log to record actions into (optional). */
  auditLog?: McpAuditLog;
  /** Clock override (tests). */
  nowMs?: () => number;
}

/** Result of dispatching a UI action. */
export type AppActionDispatch =
  | { ok: true; kind: AppUiActionKind; toolName?: string; args?: Record<string, unknown>; href?: string; uri?: string; formValues?: Record<string, string> }
  | { ok: false; reason: string };

/**
 * A live render session: one validated descriptor mounted for one
 * template. Owns input state, action history and lifecycle; the
 * renderer component is purely presentational and reads snapshots.
 */
export class AppRenderSession {
  readonly sessionId: string;
  readonly template: DeclaredAppTemplate;
  readonly descriptor: AppUiDescriptor;
  state: AppRenderSessionState = 'mounting';
  error?: string;
  private readonly inputState = new Map<string, string>();
  private readonly history: AppRenderActionRecord[] = [];
  private readonly stats: AppRenderSessionStats = {
    mounts: 0,
    actions: 0,
    denied: 0,
    errors: 0,
    stateChanges: 0,
  };
  private seq = 0;
  private readonly actor: string;
  private readonly auditLog?: McpAuditLog;
  private readonly nowMs: () => number;
  private mountedAt?: number;
  private updatedAt: number;

  constructor(
    sessionId: string,
    template: DeclaredAppTemplate,
    descriptor: AppUiDescriptor,
    options: AppRenderSessionOptions = {},
  ) {
    this.sessionId = sessionId;
    this.template = template;
    this.descriptor = descriptor;
    this.actor = options.actor ?? 'user';
    this.auditLog = options.auditLog;
    this.nowMs = options.nowMs ?? Date.now;
    this.updatedAt = this.nowMs();
    this.collectDefaults(descriptor.root);
  }

  private collectDefaults(node: AppUiNode): void {
    if ((node.kind === 'input' || node.kind === 'select') && node.name) {
      this.inputState.set(node.name, node.value ?? '');
    }
    for (const child of node.children ?? []) this.collectDefaults(child);
  }

  private findNode(node: AppUiNode, nodeId: string): AppUiNode | undefined {
    if (node.id === nodeId) return node;
    for (const child of node.children ?? []) {
      const found = this.findNode(child, nodeId);
      if (found) return found;
    }
    return undefined;
  }

  private setState(next: AppRenderSessionState): void {
    if (this.state !== next) {
      this.state = next;
      this.stats.stateChanges += 1;
      this.updatedAt = this.nowMs();
    }
  }

  private recordHistory(nodeId: string, kind: AppUiActionKind, outcome: 'ok' | 'denied', detail: string): void {
    this.seq += 1;
    this.history.push({ seq: this.seq, at: this.nowMs(), nodeId, kind, outcome, detail });
    if (this.history.length > APP_RENDER_V2_MAX_HISTORY) {
      this.history.splice(0, this.history.length - APP_RENDER_V2_MAX_HISTORY);
    }
  }

  /** Mount the session — moves `mounting -> mounted`. */
  mount(): void {
    if (this.state === 'unmounted') {
      throw new AppRenderV2Error(`Session "${this.sessionId}" đã unmount, không mount lại được.`, 'already-unmounted');
    }
    this.stats.mounts += 1;
    this.mountedAt = this.nowMs();
    this.setState('mounted');
  }

  /** Suspend rendering (server busy / app hidden). Input state is kept. */
  suspend(): void {
    if (this.state !== 'mounted') {
      throw new AppRenderV2Error(
        `Session "${this.sessionId}" chỉ suspend được khi mounted (hiện tại: ${this.state}).`,
        'bad-state',
      );
    }
    this.setState('suspended');
  }

  /** Resume a suspended session. */
  resume(): void {
    if (this.state !== 'suspended') {
      throw new AppRenderV2Error(
        `Session "${this.sessionId}" chỉ resume được khi suspended (hiện tại: ${this.state}).`,
        'bad-state',
      );
    }
    this.setState('mounted');
  }

  /** Mark the session errored (bad update from the server, render fault). */
  fail(error: string): void {
    this.error = error;
    this.stats.errors += 1;
    this.setState('error');
  }

  /** Clear an error and go back to mounted (after the server fixes the descriptor). */
  clearError(): void {
    if (this.state !== 'error') return;
    this.error = undefined;
    this.setState('mounted');
  }

  /** Unmount — terminal. Input state and history stay readable via snapshot. */
  unmount(): void {
    this.setState('unmounted');
  }

  /** True when the host must show a review warning for this session. */
  get reviewWarning(): boolean {
    return this.template.review === 'unreviewed' || this.template.review === 'rejected';
  }

  /** Set one input field's value (typing in the rendered UI). */
  setInput(name: string, value: string): void {
    if (this.state === 'unmounted') {
      throw new AppRenderV2Error(`Session "${this.sessionId}" đã unmount.`, 'already-unmounted');
    }
    if (!this.inputState.has(name)) {
      throw new AppRenderV2Error(`Session "${this.sessionId}" không có input "${name}".`, 'unknown-input');
    }
    this.inputState.set(name, value);
    this.updatedAt = this.nowMs();
  }

  /** Current input values (a copy). */
  getInputs(): Record<string, string> {
    return Object.fromEntries(this.inputState);
  }

  /**
   * Dispatch a UI action from a node. Only `mounted` sessions act:
   * a suspended / errored / unmounted session denies with a clear
   * reason. The action must exist on the node AND be allowed by
   * the template; form submits attach the current input values.
   * Denials are recorded in history + audit log.
   */
  dispatchAction(nodeId: string): AppActionDispatch {
    const node = this.findNode(this.descriptor.root, nodeId);
    if (!node) {
      const reason = `Không có node "${nodeId}" trong app.`;
      this.stats.denied += 1;
      return { ok: false, reason };
    }
    if (!node.action) {
      const reason = `Node "${nodeId}" không có action.`;
      this.stats.denied += 1;
      this.recordHistory(nodeId, 'tool-call', 'denied', reason);
      return { ok: false, reason };
    }
    const action = node.action;
    if (this.state !== 'mounted') {
      const reason = `App chưa sẵn sàng để nhận action (trạng thái: ${this.state}).`;
      this.stats.denied += 1;
      this.recordHistory(nodeId, action.kind, 'denied', reason);
      recordAppActionDenied(this.auditLog, {
        templateId: this.template.id,
        serverName: this.template.serverName,
        kind: action.kind,
        actor: this.actor,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.label ? { label: action.label } : {}),
      }, reason);
      return { ok: false, reason };
    }
    if (!appActionAllowed(this.template, action.kind)) {
      const reason = `Template "${this.template.id}" không cho phép action "${action.kind}".`;
      this.stats.denied += 1;
      this.recordHistory(nodeId, action.kind, 'denied', reason);
      recordAppActionDenied(this.auditLog, {
        templateId: this.template.id,
        serverName: this.template.serverName,
        kind: action.kind,
        actor: this.actor,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.label ? { label: action.label } : {}),
      }, reason);
      return { ok: false, reason };
    }
    this.stats.actions += 1;
    this.recordHistory(nodeId, action.kind, 'ok', action.label ?? action.kind);
    recordAppAction(this.auditLog, {
      templateId: this.template.id,
      serverName: this.template.serverName,
      kind: action.kind,
      actor: this.actor,
      ...(action.toolName ? { toolName: action.toolName } : {}),
      ...(action.args ? { args: action.args } : {}),
      ...(action.label ? { label: action.label } : {}),
    });
    const formValues = action.kind === 'form-submit' ? this.getInputs() : undefined;
    return {
      ok: true,
      kind: action.kind,
      ...(action.toolName ? { toolName: action.toolName } : {}),
      ...(action.args ? { args: action.args } : {}),
      ...(action.href ? { href: action.href } : {}),
      ...(action.uri ? { uri: action.uri } : {}),
      ...(formValues ? { formValues } : {}),
    };
  }

  /** Action history, newest last (a copy). */
  getHistory(): AppRenderActionRecord[] {
    return this.history.map((h) => ({ ...h }));
  }

  /** Session statistics (a copy). */
  getStats(): AppRenderSessionStats {
    return { ...this.stats };
  }

  /** Count nodes in the descriptor tree. */
  nodeCount(): number {
    let count = 0;
    const walk = (node: AppUiNode): void => {
      count += 1;
      for (const child of node.children ?? []) walk(child);
    };
    walk(this.descriptor.root);
    return count;
  }

  /** Serializable snapshot for the UI / IPC. */
  snapshot(): AppRenderSessionSnapshot {
    return {
      sessionId: this.sessionId,
      templateId: this.template.id,
      serverName: this.template.serverName,
      title: this.template.title,
      state: this.state,
      nodeCount: this.nodeCount(),
      reviewWarning: this.reviewWarning,
      inputState: this.getInputs(),
      actionCount: this.stats.actions,
      deniedCount: this.stats.denied,
      ...(this.error ? { error: this.error } : {}),
      ...(this.mountedAt !== undefined ? { mountedAt: this.mountedAt } : {}),
      updatedAt: this.updatedAt,
    };
  }

  /** Serialise the session (snapshot + descriptor) for persistence across restarts. */
  toJSON(): { snapshot: AppRenderSessionSnapshot; descriptor: AppUiDescriptor } {
    return { snapshot: this.snapshot(), descriptor: this.descriptor };
  }

  /**
   * Restore a session from `toJSON()` output. The descriptor is
   * re-validated against the template first (a stored descriptor
   * from an older host version must not bypass validation);
   * lifecycle state, input values and action counters are then
   * restored. Action history itself is not persisted (it is
   * audit detail, rebuilt from the audit log when needed).
   * Throws `AppRenderV2Error` when the stored data is invalid.
   */
  static fromJSON(
    data: { snapshot: AppRenderSessionSnapshot; descriptor: AppUiDescriptor },
    template: DeclaredAppTemplate,
    options: AppRenderSessionOptions = {},
  ): AppRenderSession {
    if (!data || typeof data !== 'object' || !data.snapshot || !data.descriptor) {
      throw new AppRenderV2Error('Dữ liệu session không hợp lệ (cần snapshot + descriptor).', 'bad-session-data');
    }
    const validation = validateAppUiDescriptor(data.descriptor, template);
    if (!validation.valid || !validation.descriptor) {
      throw new AppRenderV2Error(
        `Descriptor đã lưu không còn hợp lệ: ${validation.errors.join('; ')}`,
        'bad-descriptor',
      );
    }
    if (data.snapshot.templateId !== template.id) {
      throw new AppRenderV2Error(
        `Snapshot thuộc template "${data.snapshot.templateId}", không phải "${template.id}".`,
        'template-mismatch',
      );
    }
    const session = new AppRenderSession(data.snapshot.sessionId, template, validation.descriptor, options);
    // Restore input values (unknown inputs from an older descriptor are skipped).
    for (const [name, value] of Object.entries(data.snapshot.inputState)) {
      try {
        session.setInput(name, value);
      } catch {
        // Input no longer exists in the descriptor — skip it.
      }
    }
    session.stats.actions = data.snapshot.actionCount;
    session.stats.denied = data.snapshot.deniedCount;
    if (data.snapshot.mountedAt !== undefined) session.mountedAt = data.snapshot.mountedAt;
    session.updatedAt = data.snapshot.updatedAt;
    session.mount();
    if (data.snapshot.state === 'suspended') {
      session.suspend();
    } else if (data.snapshot.state === 'error') {
      session.fail(data.snapshot.error ?? 'App báo lỗi (khôi phục từ snapshot).');
    } else if (data.snapshot.state === 'unmounted') {
      session.unmount();
    }
    return session;
  }
}

/** Registry of live render sessions (one per mounted app). */
export class AppRenderRegistry {
  private readonly sessions = new Map<string, AppRenderSession>();
  private counter = 0;

  /** Create + mount a session from a validated descriptor. */
  create(
    template: DeclaredAppTemplate,
    descriptor: AppUiDescriptor,
    options: AppRenderSessionOptions = {},
  ): AppRenderSession {
    this.counter += 1;
    const sessionId = `app-render-${this.counter}-${Date.now()}`;
    const session = new AppRenderSession(sessionId, template, descriptor, options);
    this.sessions.set(sessionId, session);
    session.mount();
    return session;
  }

  get(sessionId: string): AppRenderSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Unmount + drop a session. Returns false when unknown. */
  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.unmount();
    this.sessions.delete(sessionId);
    return true;
  }

  /** Snapshots of all live sessions, mounted first. */
  listSnapshots(): AppRenderSessionSnapshot[] {
    return [...this.sessions.values()]
      .map((s) => s.snapshot())
      .sort((a, b) => (a.state === 'mounted' ? 0 : 1) - (b.state === 'mounted' ? 0 : 1));
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Unmount everything (server disconnect / host shutdown). */
  clear(): void {
    for (const session of this.sessions.values()) session.unmount();
    this.sessions.clear();
  }
}

/** One-line summary of a session, for logs / the app list. */
export function describeRenderSession(session: AppRenderSession): string {
  const snap = session.snapshot();
  return `${snap.title} (${snap.sessionId}) — ${snap.state}, ${snap.nodeCount} node, ` +
    `action ${snap.actionCount}, từ chối ${snap.deniedCount}` +
    (snap.reviewWarning ? ', CHƯA REVIEW' : '');
}

/**
 * Flatten a descriptor tree to a node list (depth-first) — the
 * renderer uses it to build its component tree without recursion
 * in the view layer.
 */
export function flattenDescriptor(descriptor: AppUiDescriptor): { node: AppUiNode; depth: number }[] {
  const out: { node: AppUiNode; depth: number }[] = [];
  const walk = (node: AppUiNode, depth: number): void => {
    out.push({ node, depth });
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(descriptor.root, 0);
  return out;
}
