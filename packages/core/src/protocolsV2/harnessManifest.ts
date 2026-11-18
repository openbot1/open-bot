/**
 * Protocols v2 — UHP-style harness manifest, wave v1.17 (Team T2).
 *
 * Idea only, learned from the public UHP description in
 * docs/repo-survey-v117.md section 3: UHP is a young standard
 * for the configured-harness boundary — one manifest declares
 * the model, skills, MCP servers and tool restrictions for a
 * harness, and the harness is driven through task / session /
 * streaming / file / cancel. No code, text or asset from any
 * other repo is copied here.
 *
 * This builds on the existing harness layers without touching
 * them: `harness/types.ts` (local harness events/registry),
 * `harness/v2` and `harness/v3` (headless, routines, budgets,
 * delegation). v117 adds the missing declarative layer on top:
 * a manifest you can write, validate, hash and load, plus a
 * controller that starts/cancels/streams tasks under that
 * manifest and reads/writes files inside a sandboxed workspace
 * root — with tool restrictions enforced before any tool runs.
 *
 * Security: file access is confined to the workspace root
 * (path traversal is refused), writes are size-capped, and
 * secrets are never read from the manifest (model keys live
 * in the vault, not here — the manifest only names the model).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Manifest format version. */
export const HARNESS_MANIFEST_VERSION = 'uhp/1.0';
/** Maximum file bytes a harness task may read/write in one call. */
export const HARNESS_MANIFEST_MAX_FILE_BYTES = 1024 * 1024;
/** Maximum tasks a controller tracks (oldest terminal tasks are pruned). */
export const HARNESS_MANIFEST_MAX_TASKS = 100;

/** Error raised by the harness manifest layer. */
export class HarnessManifestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HarnessManifestError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Manifest shape + validation
// ---------------------------------------------------------------------------

/** Model a harness runs on. */
export interface HarnessManifestModel {
  provider: string;
  model: string;
  /** Temperature, when the harness sets one. */
  temperature?: number;
  /** Max output tokens, when the harness sets one. */
  maxTokens?: number;
}

/** One MCP server declared in the manifest. */
export interface HarnessManifestMcpServer {
  /** `stdio` (command) or `http` (url) server. */
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** Environment names (not values) the server may read. */
  envAllowlist?: string[];
}

/** Tool restrictions for a harness. */
export interface HarnessManifestToolRestrictions {
  /** When set, ONLY these tools may run. */
  allow?: string[];
  /** Tools that may never run (deny wins over allow). */
  deny?: string[];
  /** When true, tools that need approval ask the user first. */
  requireApprovalFor?: string[];
}

/** Limits for tasks run under this manifest. */
export interface HarnessManifestLimits {
  maxTurns?: number;
  timeoutMs?: number;
  maxFileBytes?: number;
}

/**
 * A UHP-style harness manifest: everything one harness needs,
 * in one document — model, skills, MCP servers, tool
 * restrictions, workspace, limits.
 */
export interface HarnessManifest {
  version: string;
  name: string;
  description?: string;
  model: HarnessManifestModel;
  skills: string[];
  mcpServers: Record<string, HarnessManifestMcpServer>;
  toolRestrictions: HarnessManifestToolRestrictions;
  workspace?: string;
  limits?: HarnessManifestLimits;
  metadata?: Record<string, unknown>;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SKILL_RE = /^[A-Za-z][A-Za-z0-9_/-]{0,127}$/;

/** Validate a parsed manifest. Returns problems (empty = valid). */
export function validateHarnessManifest(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['manifest must be an object'];
  }
  const m = value as Record<string, unknown>;
  if (m['version'] !== HARNESS_MANIFEST_VERSION) {
    problems.push(`manifest.version must be "${HARNESS_MANIFEST_VERSION}"`);
  }
  if (typeof m['name'] !== 'string' || !NAME_RE.test(m['name'])) {
    problems.push('manifest.name must be a safe identifier (letters, digits, _ and -, max 64)');
  }
  if (m['description'] !== undefined && typeof m['description'] !== 'string') {
    problems.push('manifest.description must be a string');
  }
  const model = m['model'];
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    problems.push('manifest.model is required');
  } else {
    const mo = model as Record<string, unknown>;
    if (typeof mo['provider'] !== 'string' || !mo['provider'].trim()) problems.push('manifest.model.provider is required');
    if (typeof mo['model'] !== 'string' || !mo['model'].trim()) problems.push('manifest.model.model is required');
    if (mo['temperature'] !== undefined && (typeof mo['temperature'] !== 'number' || mo['temperature'] < 0 || mo['temperature'] > 2)) {
      problems.push('manifest.model.temperature must be a number between 0 and 2');
    }
    if (mo['maxTokens'] !== undefined && (typeof mo['maxTokens'] !== 'number' || !Number.isInteger(mo['maxTokens']) || (mo['maxTokens'] as number) <= 0)) {
      problems.push('manifest.model.maxTokens must be a positive integer');
    }
  }
  if (!Array.isArray(m['skills'])) {
    problems.push('manifest.skills must be an array');
  } else {
    const seen = new Set<string>();
    for (const skill of m['skills'] as unknown[]) {
      if (typeof skill !== 'string' || !SKILL_RE.test(skill)) {
        problems.push(`manifest.skills entry "${String(skill)}" is not a safe skill id`);
        break;
      }
      if (seen.has(skill)) { problems.push(`manifest.skills duplicates "${skill}"`); break; }
      seen.add(skill);
    }
  }
  if (typeof m['mcpServers'] !== 'object' || m['mcpServers'] === null || Array.isArray(m['mcpServers'])) {
    problems.push('manifest.mcpServers must be an object');
  } else {
    for (const [serverName, server] of Object.entries(m['mcpServers'] as Record<string, unknown>)) {
      if (!NAME_RE.test(serverName)) { problems.push(`mcp server name "${serverName}" is not a safe identifier`); continue; }
      if (typeof server !== 'object' || server === null || Array.isArray(server)) {
        problems.push(`mcp server "${serverName}" must be an object`);
        continue;
      }
      const s = server as Record<string, unknown>;
      if (s['transport'] === 'stdio') {
        if (typeof s['command'] !== 'string' || !s['command'].trim()) {
          problems.push(`mcp server "${serverName}" (stdio) needs a command`);
        }
        if (s['args'] !== undefined && (!Array.isArray(s['args']) || (s['args'] as unknown[]).some((a) => typeof a !== 'string'))) {
          problems.push(`mcp server "${serverName}" args must be strings`);
        }
      } else if (s['transport'] === 'http') {
        if (typeof s['url'] !== 'string' || !/^https?:\/\//i.test(s['url'] as string)) {
          problems.push(`mcp server "${serverName}" (http) needs an http(s) url`);
        }
      } else {
        problems.push(`mcp server "${serverName}" transport must be "stdio" or "http"`);
      }
      if (s['envAllowlist'] !== undefined && (!Array.isArray(s['envAllowlist']) || (s['envAllowlist'] as unknown[]).some((e) => typeof e !== 'string'))) {
        problems.push(`mcp server "${serverName}" envAllowlist must be string[]`);
      }
    }
  }
  const restrictions = m['toolRestrictions'];
  if (typeof restrictions !== 'object' || restrictions === null || Array.isArray(restrictions)) {
    problems.push('manifest.toolRestrictions is required');
  } else {
    const r = restrictions as Record<string, unknown>;
    for (const key of ['allow', 'deny', 'requireApprovalFor'] as const) {
      const list = r[key];
      if (list !== undefined && (!Array.isArray(list) || list.some((t) => typeof t !== 'string' || !t.trim()))) {
        problems.push(`manifest.toolRestrictions.${key} must be an array of tool names`);
      }
    }
    const allow = Array.isArray(r['allow']) ? (r['allow'] as string[]) : [];
    const deny = Array.isArray(r['deny']) ? (r['deny'] as string[]) : [];
    for (const tool of allow) {
      if (deny.includes(tool)) problems.push(`tool "${tool}" is both allowed and denied — deny wins, remove it from allow`);
    }
  }
  const limits = m['limits'];
  if (limits !== undefined) {
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
      problems.push('manifest.limits must be an object');
    } else {
      const l = limits as Record<string, unknown>;
      if (l['maxTurns'] !== undefined && (typeof l['maxTurns'] !== 'number' || !Number.isInteger(l['maxTurns']) || (l['maxTurns'] as number) <= 0)) {
        problems.push('manifest.limits.maxTurns must be a positive integer');
      }
      if (l['timeoutMs'] !== undefined && (typeof l['timeoutMs'] !== 'number' || (l['timeoutMs'] as number) <= 0)) {
        problems.push('manifest.limits.timeoutMs must be a positive number');
      }
      if (l['maxFileBytes'] !== undefined && (typeof l['maxFileBytes'] !== 'number' || !Number.isInteger(l['maxFileBytes']) || (l['maxFileBytes'] as number) <= 0)) {
        problems.push('manifest.limits.maxFileBytes must be a positive integer');
      }
    }
  }
  if (m['workspace'] !== undefined && typeof m['workspace'] !== 'string') {
    problems.push('manifest.workspace must be a string');
  }
  return problems;
}

/** Parse + validate a manifest (object or JSON string). Throws on invalid. */
export function parseHarnessManifest(value: unknown): HarnessManifest {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (err) {
      throw new HarnessManifestError('INVALID_JSON', `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const problems = validateHarnessManifest(parsed);
  if (problems.length > 0) {
    throw new HarnessManifestError('INVALID_MANIFEST', problems.join('; '));
  }
  return parsed as HarnessManifest;
}

/** Build a manifest from its pieces (defaults filled in). */
export function buildHarnessManifest(input: {
  name: string;
  model: HarnessManifestModel;
  skills?: string[];
  mcpServers?: Record<string, HarnessManifestMcpServer>;
  toolRestrictions?: HarnessManifestToolRestrictions;
  description?: string;
  workspace?: string;
  limits?: HarnessManifestLimits;
  metadata?: Record<string, unknown>;
}): HarnessManifest {
  const manifest: HarnessManifest = {
    version: HARNESS_MANIFEST_VERSION,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    model: { ...input.model },
    skills: [...(input.skills ?? [])],
    mcpServers: { ...(input.mcpServers ?? {}) },
    toolRestrictions: { ...(input.toolRestrictions ?? {}) },
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.limits ? { limits: { ...input.limits } } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
  const problems = validateHarnessManifest(manifest);
  if (problems.length > 0) throw new HarnessManifestError('INVALID_MANIFEST', problems.join('; '));
  return manifest;
}

/** Canonical JSON (sorted keys) for hashing / comparison. */
export function canonicaliseHarnessManifest(manifest: HarnessManifest): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sort(manifest));
}

/** SHA-256 hex of the canonical manifest (identity for caching / audit). */
export function hashHarnessManifest(manifest: HarnessManifest): string {
  return createHash('sha256').update(canonicaliseHarnessManifest(manifest), 'utf8').digest('hex');
}

/** Load a manifest JSON file from disk (parse + validate). */
export async function loadHarnessManifestFromFile(filePath: string): Promise<HarnessManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new HarnessManifestError('MANIFEST_READ_FAILED', `Cannot read manifest ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseHarnessManifest(raw);
}

/** Write a manifest to disk as pretty JSON (validated first). */
export async function saveHarnessManifestToFile(manifest: HarnessManifest, filePath: string): Promise<void> {
  const problems = validateHarnessManifest(manifest);
  if (problems.length > 0) throw new HarnessManifestError('INVALID_MANIFEST', problems.join('; '));
  try {
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw new HarnessManifestError('MANIFEST_WRITE_FAILED', `Cannot write manifest ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One difference between two manifests. */
export interface HarnessManifestDiff {
  /** Dotted path, e.g. `model.model`, `skills`, `mcpServers.fs`. */
  path: string;
  from: unknown;
  to: unknown;
}

/**
 * Diff two manifests: reports changed scalar fields (name,
 * model provider/model/temperature/maxTokens, workspace,
 * limits), added/removed skills and MCP servers, and changed
 * tool restrictions. Identical manifests diff to `[]`.
 * Used when a harness is reloaded to show exactly what changed.
 */
export function diffHarnessManifests(a: HarnessManifest, b: HarnessManifest): HarnessManifestDiff[] {
  const diffs: HarnessManifestDiff[] = [];
  const cmp = (pathName: string, from: unknown, to: unknown): void => {
    if (JSON.stringify(from) !== JSON.stringify(to)) diffs.push({ path: pathName, from, to });
  };
  cmp('name', a.name, b.name);
  cmp('description', a.description ?? null, b.description ?? null);
  cmp('model.provider', a.model.provider, b.model.provider);
  cmp('model.model', a.model.model, b.model.model);
  cmp('model.temperature', a.model.temperature ?? null, b.model.temperature ?? null);
  cmp('model.maxTokens', a.model.maxTokens ?? null, b.model.maxTokens ?? null);
  cmp('workspace', a.workspace ?? null, b.workspace ?? null);
  cmp('limits', a.limits ?? null, b.limits ?? null);
  const skillsA = new Set(a.skills);
  const skillsB = new Set(b.skills);
  for (const skill of [...skillsA].filter((s) => !skillsB.has(s))) {
    diffs.push({ path: `skills.-${skill}`, from: skill, to: null });
  }
  for (const skill of [...skillsB].filter((s) => !skillsA.has(s))) {
    diffs.push({ path: `skills.+${skill}`, from: null, to: skill });
  }
  const serversA = new Set(Object.keys(a.mcpServers));
  const serversB = new Set(Object.keys(b.mcpServers));
  for (const server of [...serversA].filter((s) => !serversB.has(s))) {
    diffs.push({ path: `mcpServers.-${server}`, from: a.mcpServers[server], to: null });
  }
  for (const server of [...serversB].filter((s) => !serversA.has(s))) {
    diffs.push({ path: `mcpServers.+${server}`, from: null, to: b.mcpServers[server] });
  }
  for (const server of [...serversA].filter((s) => serversB.has(s))) {
    cmp(`mcpServers.${server}`, a.mcpServers[server], b.mcpServers[server]);
  }
  cmp('toolRestrictions', a.toolRestrictions, b.toolRestrictions);
  return diffs.sort((x, y) => x.path.localeCompare(y.path));
}

// ---------------------------------------------------------------------------
// Tool restriction enforcement
// ---------------------------------------------------------------------------

/** Outcome of a tool-allowance check. */
export interface HarnessToolCheck {
  allowed: boolean;
  /** True when the tool may run only after user approval. */
  needsApproval: boolean;
  reason: string;
}

/**
 * Check one tool name against the manifest restrictions.
 * Deny always wins; when `allow` is set, anything not listed
 * is refused; otherwise everything not denied is allowed.
 */
export function checkHarnessTool(manifest: HarnessManifest, toolName: string): HarnessToolCheck {
  const r = manifest.toolRestrictions;
  if (r.deny?.includes(toolName)) {
    return { allowed: false, needsApproval: false, reason: `tool "${toolName}" is denied by the manifest` };
  }
  if (r.allow && !r.allow.includes(toolName)) {
    return { allowed: false, needsApproval: false, reason: `tool "${toolName}" is not in the manifest allowlist` };
  }
  const needsApproval = r.requireApprovalFor?.includes(toolName) ?? false;
  return {
    allowed: true,
    needsApproval,
    reason: needsApproval ? `tool "${toolName}" needs user approval` : `tool "${toolName}" is allowed`,
  };
}

// ---------------------------------------------------------------------------
// Controller: tasks, streaming, cancel, files
// ---------------------------------------------------------------------------

/** Status of a harness task. */
export type HarnessTaskStatus = 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One event in a harness task stream. */
export interface HarnessTaskEvent {
  taskId: string;
  sequence: number;
  kind: 'started' | 'text' | 'tool' | 'file' | 'finished' | 'failed' | 'cancelled';
  text?: string;
  toolName?: string;
  filePath?: string;
  at: string;
}

/** A harness task record. */
export interface HarnessTask {
  id: string;
  manifestName: string;
  manifestHash: string;
  prompt: string;
  status: HarnessTaskStatus;
  events: HarnessTaskEvent[];
  resultText?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** What a task runner receives (the harness side of a run). */
export interface HarnessRunnerContext {
  taskId: string;
  manifest: HarnessManifest;
  signal: AbortSignal;
  /** Emit a text chunk to the task stream. */
  emitText: (text: string) => void;
  /** Emit a tool-use event (checked against restrictions first). */
  emitTool: (toolName: string, detail?: string) => void;
  /** Check a tool before running it (throws when denied). */
  requireTool: (toolName: string) => HarnessToolCheck;
  /** Read a workspace file (sandboxed to the workspace root). */
  readFile: (relPath: string) => Promise<string>;
  /** Write a workspace file (sandboxed, size-capped). */
  writeFile: (relPath: string, content: string) => Promise<void>;
}

/** Runner a controller calls to do the work of one task. */
export type HarnessTaskRunner = (context: HarnessRunnerContext) => Promise<string>;

/** Options for the controller. */
export interface HarnessManifestControllerOptions {
  /** Workspace root for file control (defaults to the manifest workspace, else cwd). */
  workspaceRoot?: string;
  /** Runner that does the work (a fake in tests; the agent loop in production). */
  runner: HarnessTaskRunner;
  /** Now (injectable clock). */
  now?: () => number;
}

/**
 * Controller for one harness manifest: starts tasks under the
 * manifest (model/skills/MCP servers/restrictions are fixed by
 * it), streams their events, cancels them, and reads/writes
 * files inside the workspace root.
 *
 * File control is sandboxed: every path is resolved under the
 * workspace root and refused when it escapes (`..`, absolute
 * paths outside the root, symlinks are not followed by the
 * check — the resolved path must stay inside the root).
 */
export class HarnessManifestController {
  readonly manifest: HarnessManifest;
  readonly manifestHash: string;
  private readonly workspaceRoot: string;
  private readonly runner: HarnessTaskRunner;
  private readonly now: () => number;
  private readonly tasks = new Map<string, HarnessTask>();
  private readonly aborters = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(event: HarnessTaskEvent) => void>>();
  private counter = 0;

  constructor(manifest: HarnessManifest, options: HarnessManifestControllerOptions) {
    const problems = validateHarnessManifest(manifest);
    if (problems.length > 0) throw new HarnessManifestError('INVALID_MANIFEST', problems.join('; '));
    this.manifest = manifest;
    this.manifestHash = hashHarnessManifest(manifest);
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? manifest.workspace ?? process.cwd());
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
  }

  /** Workspace root file control is confined to. */
  root(): string {
    return this.workspaceRoot;
  }

  /** Maximum file bytes for this manifest (limit or default). */
  maxFileBytes(): number {
    return this.manifest.limits?.maxFileBytes ?? HARNESS_MANIFEST_MAX_FILE_BYTES;
  }

  /** Check a tool against this manifest's restrictions. */
  checkTool(toolName: string): HarnessToolCheck {
    return checkHarnessTool(this.manifest, toolName);
  }

  /** MCP servers declared by the manifest. */
  mcpServers(): Record<string, HarnessManifestMcpServer> {
    return JSON.parse(JSON.stringify(this.manifest.mcpServers)) as Record<string, HarnessManifestMcpServer>;
  }

  /** Skills declared by the manifest. */
  skills(): string[] {
    return [...this.manifest.skills];
  }

  /**
   * Start a task under this manifest. The task runs async;
   * the returned record is the submitted task — follow it
   * with `getTask`, `waitFor`, or `subscribe`.
   */
  startTask(prompt: string): HarnessTask {
    if (!prompt.trim()) throw new HarnessManifestError('EMPTY_PROMPT', 'Harness task needs a prompt');
    this.counter += 1;
    const id = `harness-task-${this.counter}`;
    const at = new Date(this.now()).toISOString();
    const task: HarnessTask = {
      id,
      manifestName: this.manifest.name,
      manifestHash: this.manifestHash,
      prompt,
      status: 'submitted',
      events: [],
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(id, task);
    const aborter = new AbortController();
    this.aborters.set(id, aborter);
    void this.runTask(task, aborter.signal);
    this.prune();
    return this.snapshot(task);
  }

  /** Read a task (with its events). */
  getTask(taskId: string): HarnessTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new HarnessManifestError('TASK_NOT_FOUND', `No harness task ${taskId}`);
    return this.snapshot(task);
  }

  /** All tasks, oldest first. */
  listTasks(): HarnessTask[] {
    return [...this.tasks.values()].map((t) => this.snapshot(t));
  }

  /**
   * Subscribe to a task's events. Events already emitted are
   * replayed to the new subscriber first, so subscribing just
   * after `startTask` never misses the `started`/early events.
   * Returns an unsubscribe fn.
   */
  subscribe(taskId: string, listener: (event: HarnessTaskEvent) => void): () => void {
    const task = this.tasks.get(taskId);
    if (!task) throw new HarnessManifestError('TASK_NOT_FOUND', `No harness task ${taskId}`);
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    for (const event of task.events) listener({ ...event });
    return () => {
      this.listeners.get(taskId)?.delete(listener);
    };
  }

  /** Cancel a running task. Terminal tasks are returned unchanged. */
  cancelTask(taskId: string, reason = 'cancelled by user'): HarnessTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new HarnessManifestError('TASK_NOT_FOUND', `No harness task ${taskId}`);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return this.snapshot(task);
    }
    this.aborters.get(taskId)?.abort();
    task.status = 'cancelled';
    task.error = reason;
    task.updatedAt = new Date(this.now()).toISOString();
    this.emit(task, { kind: 'cancelled', text: reason });
    return this.snapshot(task);
  }

  /** Wait until a task reaches a terminal state (polls). */
  async waitFor(taskId: string, timeoutMs = 10_000, pollMs = 25): Promise<HarnessTask> {
    const started = Date.now();
    for (;;) {
      const task = this.getTask(taskId);
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task;
      if (Date.now() - started > timeoutMs) {
        throw new HarnessManifestError('WAIT_TIMEOUT', `Harness task ${taskId} did not finish within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // -- File control (sandboxed to the workspace root) ----------------------

  /** Resolve a relative path under the root; throws when it escapes. */
  resolveWorkspacePath(relPath: string): string {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new HarnessManifestError('INVALID_PATH', 'File path must be a non-empty string');
    }
    if (path.isAbsolute(relPath)) {
      throw new HarnessManifestError('INVALID_PATH', `File path must be relative to the workspace: ${relPath}`);
    }
    const resolved = path.resolve(this.workspaceRoot, relPath);
    const rootWithSep = this.workspaceRoot.endsWith(path.sep) ? this.workspaceRoot : `${this.workspaceRoot}${path.sep}`;
    if (resolved !== this.workspaceRoot && !resolved.startsWith(rootWithSep)) {
      throw new HarnessManifestError('PATH_ESCAPES_WORKSPACE', `File path escapes the workspace root: ${relPath}`);
    }
    return resolved;
  }

  /** Read a workspace file as UTF-8 (size-capped). */
  async readFile(relPath: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(relPath);
    let content: string;
    try {
      content = await fs.readFile(resolved, 'utf8');
    } catch (err) {
      throw new HarnessManifestError('FILE_READ_FAILED', `Cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes()) {
      throw new HarnessManifestError('FILE_TOO_LARGE', `File ${relPath} exceeds ${this.maxFileBytes()} bytes`);
    }
    return content;
  }

  /** Write a workspace file (creates parent dirs, size-capped). */
  async writeFile(relPath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes()) {
      throw new HarnessManifestError('FILE_TOO_LARGE', `Content for ${relPath} exceeds ${this.maxFileBytes()} bytes`);
    }
    const resolved = this.resolveWorkspacePath(relPath);
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf8');
    } catch (err) {
      throw new HarnessManifestError('FILE_WRITE_FAILED', `Cannot write ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** List files directly under a workspace directory (names only). */
  async listFiles(relDir = '.'): Promise<string[]> {
    const resolved = this.resolveWorkspacePath(relDir);
    try {
      return await fs.readdir(resolved);
    } catch (err) {
      throw new HarnessManifestError('FILE_READ_FAILED', `Cannot list ${relDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Export a task's events as NDJSON (one JSON event per line)
   * into the workspace. Returns the relative path written.
   * The audit trail of a harness run lives next to its files.
   */
  async exportTaskEvents(taskId: string, relPath?: string): Promise<string> {
    const task = this.getTask(taskId);
    const target = relPath ?? `harness-events/${taskId}.ndjson`;
    const content = task.events.map((e) => JSON.stringify(e)).join('\n') + (task.events.length > 0 ? '\n' : '');
    await this.writeFile(target, content);
    return target;
  }

  /**
   * Save a task snapshot (status + events + result) as JSON in
   * the workspace, for audit or resume-after-restart. Returns
   * the relative path written.
   */
  async saveTaskSnapshot(taskId: string, relPath?: string): Promise<string> {
    const task = this.getTask(taskId);
    const target = relPath ?? `harness-tasks/${taskId}.json`;
    await this.writeFile(target, `${JSON.stringify(task, null, 2)}\n`);
    return target;
  }

  /**
   * Load a task snapshot saved by `saveTaskSnapshot` back into
   * this controller (e.g. after a restart). The task keeps its
   * id and events; a task that was `running` when saved is
   * honestly marked `failed` (it did not survive the restart)
   * instead of pretending it is still running.
   */
  async loadTaskSnapshot(relPath: string): Promise<HarnessTask> {
    const raw = await this.readFile(relPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new HarnessManifestError('INVALID_SNAPSHOT', `Task snapshot ${relPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HarnessManifestError('INVALID_SNAPSHOT', `Task snapshot ${relPath} is not an object`);
    }
    const snap = parsed as Record<string, unknown>;
    if (typeof snap['id'] !== 'string' || !snap['id']) {
      throw new HarnessManifestError('INVALID_SNAPSHOT', `Task snapshot ${relPath} has no id`);
    }
    if (!Array.isArray(snap['events'])) {
      throw new HarnessManifestError('INVALID_SNAPSHOT', `Task snapshot ${relPath} has no events array`);
    }
    const task: HarnessTask = {
      id: snap['id'] as string,
      manifestName: typeof snap['manifestName'] === 'string' ? (snap['manifestName'] as string) : this.manifest.name,
      manifestHash: typeof snap['manifestHash'] === 'string' ? (snap['manifestHash'] as string) : this.manifestHash,
      prompt: typeof snap['prompt'] === 'string' ? (snap['prompt'] as string) : '',
      status: snap['status'] === 'running' ? 'failed' : (snap['status'] as HarnessTaskStatus),
      events: (snap['events'] as HarnessTaskEvent[]).map((e) => ({ ...e })),
      ...(typeof snap['resultText'] === 'string' ? { resultText: snap['resultText'] as string } : {}),
      ...(typeof snap['error'] === 'string'
        ? { error: snap['error'] as string }
        : snap['status'] === 'running'
          ? { error: 'task was running when the harness stopped' }
          : {}),
      createdAt: typeof snap['createdAt'] === 'string' ? (snap['createdAt'] as string) : new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.tasks.set(task.id, task);
    return this.snapshot(task);
  }

  private async runTask(task: HarnessTask, signal: AbortSignal): Promise<void> {
    task.status = 'running';
    task.updatedAt = new Date(this.now()).toISOString();
    this.emit(task, { kind: 'started' });
    const timeoutMs = this.manifest.limits?.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = timeoutMs
      ? new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HarnessManifestError('TASK_TIMEOUT', `Harness task ${task.id} timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      : null;
    const context: HarnessRunnerContext = {
      taskId: task.id,
      manifest: this.manifest,
      signal,
      emitText: (text) => this.emit(task, { kind: 'text', text }),
      emitTool: (toolName, detail) => {
        this.requireToolOrThrow(toolName);
        this.emit(task, { kind: 'tool', toolName, ...(detail ? { text: detail } : {}) });
      },
      requireTool: (toolName) => this.requireToolOrThrow(toolName),
      readFile: (relPath) => this.readFile(relPath),
      writeFile: (relPath, content) => this.writeFile(relPath, content),
    };
    try {
      const result = timeout ? await Promise.race([this.runner(context), timeout]) : await this.runner(context);
      if (signal.aborted) {
        task.status = 'cancelled';
        task.error = 'cancelled by user';
        this.emit(task, { kind: 'cancelled', text: 'cancelled by user' });
      } else {
        task.status = 'completed';
        task.resultText = result;
        this.emit(task, { kind: 'finished', text: result });
      }
    } catch (err) {
      if (signal.aborted || task.status === 'cancelled') {
        task.status = 'cancelled';
        task.error = 'cancelled by user';
        this.emit(task, { kind: 'cancelled', text: 'cancelled by user' });
      } else {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        this.emit(task, { kind: 'failed', text: task.error });
      }
    } finally {
      if (timer) clearTimeout(timer);
      task.updatedAt = new Date(this.now()).toISOString();
      this.aborters.delete(task.id);
    }
  }

  private requireToolOrThrow(toolName: string): HarnessToolCheck {
    const check = checkHarnessTool(this.manifest, toolName);
    if (!check.allowed) throw new HarnessManifestError('TOOL_DENIED', check.reason);
    return check;
  }

  private emit(task: HarnessTask, partial: Omit<HarnessTaskEvent, 'taskId' | 'sequence' | 'at'>): HarnessTaskEvent {
    const event: HarnessTaskEvent = {
      taskId: task.id,
      sequence: task.events.length,
      ...partial,
      at: new Date(this.now()).toISOString(),
    };
    task.events.push(event);
    for (const listener of this.listeners.get(task.id) ?? []) listener(event);
    return event;
  }

  private snapshot(task: HarnessTask): HarnessTask {
    return { ...task, events: task.events.map((e) => ({ ...e })) };
  }

  private prune(): void {
    if (this.tasks.size <= HARNESS_MANIFEST_MAX_TASKS) return;
    const terminal = [...this.tasks.values()].filter(
      (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
    );
    for (const task of terminal.slice(0, this.tasks.size - HARNESS_MANIFEST_MAX_TASKS)) {
      this.tasks.delete(task.id);
      this.listeners.delete(task.id);
    }
  }
}
