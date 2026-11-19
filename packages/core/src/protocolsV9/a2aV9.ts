/**
 * Protocols v9 — A2A v1.1: Agent Card discovery, delegation,
 * message + artifact exchange, task lifecycle (v1.40, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v140.md (section 5): A2A (Google 04/2025,
 * Linux Foundation, v1.0 in 2026) is agent-to-agent. Each
 * agent publishes an Agent Card (JSON at a well-known URL);
 * a client reads the card, then delegates a task; the task
 * lifecycle carries messages and artifacts, with streaming.
 * A2A absorbed the IBM/BeeAI ACP in 08/2025. This module
 * builds on the v7 A2A task layer (`protocolsV7/a2aTaskV7.ts`,
 * same state machine) without touching it, and adds the v9
 * delegation surface:
 *
 *   - `isA2aV9LoopbackUrl` — the loopback guard: only
 *     `http(s)://localhost`, `127.0.0.1` or `[::1]` (any
 *     port) pass. Everything else is refused before
 *     anything is sent. A2A in open-bot is local-only;
 *     cross-org delegation over the public internet is
 *     out of scope by the standing direction.
 *   - `buildA2aV9AgentCard` / `validateA2aV9AgentCard` —
 *     card construction + validation (loopback URL,
 *     supported protocol version, skills with unique ids,
 *     capability flags), plus the well-known URL builder
 *     (`/.well-known/agent-card.json`).
 *   - `A2aV9CardRegistry` — local discovery: register /
 *     discover by name, skill or capability; no network.
 *   - `A2aV9TaskStore` — task lifecycle (same states and
 *     transitions as v7), message + artifact exchange,
 *     delegation with capability matching against the card
 *     registry, push-notification configs (loopback URLs
 *     only; delivery is a host-supplied callback, never a
 *     fetch from here), snapshot / restore, expiry pruning.
 *
 * No code, text or asset from any other repo is copied here.
 * No network: delegation picks a local agent and records
 * the task; the host supplies the runner that does the work.
 */

import { randomUUID } from 'node:crypto';
import {
  A2A_V9_ARTIFACT_KINDS,
  A2A_V9_CURRENT_VERSION,
  A2A_V9_TASK_TRANSITIONS,
  A2A_V9_VERSIONS,
  isA2aV9TaskTerminal,
  isA2aV9TaskTransitionLegal,
  type A2aV9ArtifactKind,
  type A2aV9TaskState,
} from './versionsV9';

/** Error raised by the A2A v9 layer. */
export class A2aV9Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'A2aV9Error';
    this.code = code;
  }
}

/** Max artifact payload bytes (default 256 KiB). */
export const A2A_V9_MAX_ARTIFACT_BYTES = 256 * 1024;
/** Max artifacts per task (default 64). */
export const A2A_V9_MAX_ARTIFACTS_PER_TASK = 64;
/** Max messages kept per task (default 500). */
export const A2A_V9_MAX_MESSAGES_PER_TASK = 500;
/** Max skills per Agent Card (default 64, same as v7). */
export const A2A_V9_CARD_MAX_SKILLS = 64;
/** Max tasks kept per store (default 512). */
export const A2A_V9_MAX_TASKS = 512;
/** Max events kept in the task log. */
export const A2A_V9_MAX_TASK_EVENTS = 500;

/**
 * The loopback guard. True only for `http://` / `https://`
 * URLs whose host is `localhost`, `127.0.0.1` or `[::1]`
 * (any port, any path). Hostnames that merely look local
 * (`*.local`, `10.*`, `192.168.*`) are NOT loopback and are
 * refused — the guard is deliberately narrow.
 */
export function isA2aV9LoopbackUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Throw unless the URL passes the loopback guard. */
export function requireA2aV9LoopbackUrl(rawUrl: string, what: string): void {
  if (!isA2aV9LoopbackUrl(rawUrl)) {
    throw new A2aV9Error(
      'not-loopback',
      `${what} URL "${rawUrl}" is not loopback (only http(s)://localhost, 127.0.0.1 or [::1] are allowed). A2A delegation is local-only.`,
    );
  }
}

/** Well-known path where an Agent Card is published. */
export const A2A_V9_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json' as const;

/** Build the well-known Agent Card URL for a loopback base URL. */
export function buildA2aV9WellKnownUrl(baseUrl: string): string {
  requireA2aV9LoopbackUrl(baseUrl, 'Agent Card base');
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${A2A_V9_CARD_WELL_KNOWN_PATH}`;
}

/** One skill an agent advertises on its card. */
export interface A2aV9AgentSkill {
  /** Stable skill id (unique on the card). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What the skill does. */
  description: string;
  /** Example prompts / inputs (optional). */
  examples?: string[];
  /** Tags for matching (optional). */
  tags?: string[];
}

/** Agent capabilities advertised on the card. */
export interface A2aV9AgentCapabilities {
  /** The agent can stream task updates. */
  streaming?: boolean;
  /** The agent accepts push-notification configs. */
  pushNotifications?: boolean;
  /** The agent supports extended (multi-turn) tasks. */
  extendedTask?: boolean;
  /** The agent accepts file artifacts. */
  fileArtifacts?: boolean;
}

/** An A2A v1.1 Agent Card (local, loopback-only). */
export interface A2aV9AgentCard {
  /** Agent name (unique in the registry). */
  name: string;
  /** What the agent does. */
  description: string;
  /** Base URL of the agent (must be loopback). */
  url: string;
  /** Agent version string. */
  version: string;
  /** A2A protocol versions the agent speaks (must include a supported one). */
  protocolVersions: string[];
  /** Capabilities the agent advertises. */
  capabilities: A2aV9AgentCapabilities;
  /** Skills the agent offers. */
  skills: A2aV9AgentSkill[];
  /** Optional provider / owner label (free text, never a credential). */
  provider?: string;
}

/** Input for building a card (url is validated as loopback). */
export type A2aV9AgentCardInput = Omit<A2aV9AgentCard, 'protocolVersions'> & {
  protocolVersions?: string[];
};

/** Validate an Agent Card; returns problems (empty when valid). */
export function validateA2aV9AgentCard(card: A2aV9AgentCard): string[] {
  const problems: string[] = [];
  if (typeof card.name !== 'string' || card.name.trim().length === 0) {
    problems.push('Agent Card needs a non-empty name.');
  }
  if (typeof card.description !== 'string' || card.description.trim().length === 0) {
    problems.push('Agent Card needs a non-empty description.');
  }
  if (typeof card.url !== 'string' || card.url.length === 0) {
    problems.push('Agent Card needs a URL.');
  } else if (!isA2aV9LoopbackUrl(card.url)) {
    problems.push(`Agent Card url "${card.url}" is not loopback (only http(s)://localhost, 127.0.0.1 or [::1] are allowed).`);
  }
  if (typeof card.version !== 'string' || card.version.trim().length === 0) {
    problems.push('Agent Card needs a non-empty version.');
  }
  if (!Array.isArray(card.protocolVersions) || card.protocolVersions.length === 0) {
    problems.push('Agent Card needs at least one protocol version.');
  } else {
    const supported = card.protocolVersions.some((v) => (A2A_V9_VERSIONS as readonly string[]).includes(v));
    if (!supported) {
      problems.push(`Agent Card protocol versions [${card.protocolVersions.join(', ')}] include no version open-bot speaks (${A2A_V9_VERSIONS.join(', ')}).`);
    }
  }
  if (typeof card.capabilities !== 'object' || card.capabilities === null || Array.isArray(card.capabilities)) {
    problems.push('Agent Card capabilities must be an object.');
  }
  if (!Array.isArray(card.skills)) {
    problems.push('Agent Card skills must be an array.');
  } else {
    if (card.skills.length > A2A_V9_CARD_MAX_SKILLS) {
      problems.push(`Agent Card declares ${card.skills.length} skills (max ${A2A_V9_CARD_MAX_SKILLS}).`);
    }
    const ids = new Set<string>();
    for (const skill of card.skills) {
      if (typeof skill.id !== 'string' || skill.id.trim().length === 0) {
        problems.push('Every skill needs a non-empty id.');
      } else if (ids.has(skill.id)) {
        problems.push(`Duplicate skill id "${skill.id}" on the card.`);
      } else {
        ids.add(skill.id);
      }
      if (typeof skill.name !== 'string' || skill.name.trim().length === 0) {
        problems.push(`Skill "${skill.id}" needs a non-empty name.`);
      }
      if (typeof skill.description !== 'string' || skill.description.trim().length === 0) {
        problems.push(`Skill "${skill.id}" needs a non-empty description.`);
      }
    }
  }
  return problems;
}

/** Build an Agent Card (throws A2aV9Error when invalid). */
export function buildA2aV9AgentCard(input: A2aV9AgentCardInput): A2aV9AgentCard {
  const card: A2aV9AgentCard = {
    name: input.name,
    description: input.description,
    url: input.url,
    version: input.version,
    protocolVersions: input.protocolVersions ?? [A2A_V9_CURRENT_VERSION],
    capabilities: { ...input.capabilities },
    skills: input.skills.map((s) => ({
      ...s,
      ...(s.examples !== undefined ? { examples: [...s.examples] } : {}),
      ...(s.tags !== undefined ? { tags: [...s.tags] } : {}),
    })),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
  };
  const problems = validateA2aV9AgentCard(card);
  if (problems.length > 0) {
    throw new A2aV9Error('invalid-agent-card', `Agent Card "${input.name}" is invalid: ${problems.join('; ')}`);
  }
  return card;
}

/** One registered card (with registration metadata). */
export interface A2aV9RegisteredCard {
  card: A2aV9AgentCard;
  /** Well-known URL the card is served at. */
  wellKnownUrl: string;
  /** Milliseconds since epoch when registered. */
  registeredAt: number;
}

/**
 * Local Agent Card registry: discovery without a network.
 * Cards are registered by the host (or by the tools layer);
 * discovery matches on skill id, skill tag, or capability.
 */
export class A2aV9CardRegistry {
  private cards = new Map<string, A2aV9RegisteredCard>();

  /** Number of registered cards. */
  size(): number {
    return this.cards.size;
  }

  /** Registered agent names (sorted). */
  names(): string[] {
    return [...this.cards.keys()].sort();
  }

  /** Register (or replace) a card. Throws when the card is invalid. */
  register(card: A2aV9AgentCard): A2aV9RegisteredCard {
    const problems = validateA2aV9AgentCard(card);
    if (problems.length > 0) {
      throw new A2aV9Error('invalid-agent-card', `Agent Card "${card.name}" is invalid: ${problems.join('; ')}`);
    }
    const registered: A2aV9RegisteredCard = {
      card: {
        ...card,
        protocolVersions: [...card.protocolVersions],
        capabilities: { ...card.capabilities },
        skills: card.skills.map((s) => ({ ...s })),
      },
      wellKnownUrl: buildA2aV9WellKnownUrl(card.url),
      registeredAt: Date.now(),
    };
    this.cards.set(card.name, registered);
    return {
      ...registered,
      card: { ...registered.card, protocolVersions: [...registered.card.protocolVersions] },
    };
  }

  /** Get one card (undefined when missing). */
  get(name: string): A2aV9RegisteredCard | undefined {
    const found = this.cards.get(name);
    if (found === undefined) return undefined;
    return { ...found, card: { ...found.card, protocolVersions: [...found.card.protocolVersions] } };
  }

  /** Unregister a card (false when missing). */
  unregister(name: string): boolean {
    return this.cards.delete(name);
  }

  /** All cards (sorted by name). */
  list(): A2aV9RegisteredCard[] {
    return [...this.cards.values()]
      .sort((a, b) => (a.card.name < b.card.name ? -1 : 1))
      .map((r) => ({ ...r, card: { ...r.card, protocolVersions: [...r.card.protocolVersions] } }));
  }

  /** Cards offering a skill id. */
  discoverBySkill(skillId: string): A2aV9RegisteredCard[] {
    return this.list().filter((r) => r.card.skills.some((s) => s.id === skillId));
  }

  /** Cards offering a skill tag. */
  discoverByTag(tag: string): A2aV9RegisteredCard[] {
    const wanted = tag.toLowerCase();
    return this.list().filter((r) =>
      r.card.skills.some((s) => (s.tags ?? []).some((t) => t.toLowerCase() === wanted)),
    );
  }

  /** Cards with a capability set to true. */
  discoverByCapability(capability: keyof A2aV9AgentCapabilities): A2aV9RegisteredCard[] {
    return this.list().filter((r) => r.card.capabilities[capability] === true);
  }

  /** Cards whose name or description mentions the query (case-insensitive). */
  search(query: string): A2aV9RegisteredCard[] {
    const wanted = query.toLowerCase();
    return this.list().filter(
      (r) =>
        r.card.name.toLowerCase().includes(wanted) ||
        r.card.description.toLowerCase().includes(wanted) ||
        r.card.skills.some((s) => s.name.toLowerCase().includes(wanted) || s.description.toLowerCase().includes(wanted)),
    );
  }
}

/** One message in a task's history. */
export interface A2aV9TaskMessage {
  messageId: string;
  role: 'user' | 'agent';
  text: string;
  at: number;
  /** Task this message belongs to (for cross-task tracing). */
  taskId: string;
}

/** One artifact attached to a task. */
export interface A2aV9Artifact {
  artifactId: string;
  /** What kind of payload this is. */
  kind: A2aV9ArtifactKind;
  /** Human-readable name (e.g. `summary.md`). */
  name: string;
  /** Payload (text for text/file, JSON value for data, base64 or URL for image). */
  payload: string;
  /** MIME type (optional, e.g. `text/markdown`). */
  mimeType?: string;
  /** Milliseconds since epoch when attached. */
  at: number;
  /** Agent that produced the artifact. */
  producedBy: string;
}

/** One delegated task. */
export interface A2aV9Task {
  /** Stable task id (`a2a-<uuid>`). */
  id: string;
  /** Conversation context the task belongs to. */
  contextId: string;
  /** Agent the task was delegated to (card name). */
  agentName: string;
  /** Skill id the delegation targeted (if any). */
  skillId?: string;
  /** Current lifecycle state. */
  state: A2aV9TaskState;
  /** Milliseconds since epoch when created. */
  createdAt: number;
  /** Milliseconds since epoch of the last state change. */
  updatedAt: number;
  /** Messages exchanged (in order, capped). */
  history: A2aV9TaskMessage[];
  /** Artifacts produced (in order, capped). */
  artifacts: A2aV9Artifact[];
  /** Why a task needs input / failed / was rejected / cancelled. */
  reason?: string;
  /** Optional deadline (ms since epoch); overdue tasks are swept to failed. */
  deadlineMs?: number;
}

/** One task lifecycle event. */
export interface A2aV9TaskEvent {
  seq: number;
  taskId: string;
  kind: 'created' | 'delegated' | 'message' | 'artifact' | 'transition' | 'input-required' | 'input-provided' | 'push-config' | 'pruned';
  at: number;
  detail?: string;
}

/** Push-notification config (loopback URL only; delivery is host-supplied). */
export interface A2aV9PushConfig {
  configId: string;
  taskId: string;
  /** Loopback URL the host calls on state change. */
  url: string;
  /** States that trigger a push (default: terminal states). */
  states: A2aV9TaskState[];
  at: number;
}

/** Options for the task store. */
export interface A2aV9TaskStoreOptions {
  /** Max tasks kept (default 512). */
  maxTasks?: number;
  /** Max messages per task (default 500). */
  maxMessagesPerTask?: number;
  /** Max artifacts per task (default 64). */
  maxArtifactsPerTask?: number;
  /** Max artifact payload bytes (default 256 KiB). */
  maxArtifactBytes?: number;
  /** Max events kept (default 500). */
  maxEvents?: number;
}

/** Serialisable snapshot of one task. */
export interface A2aV9TaskSnapshot {
  id: string;
  contextId: string;
  agentName: string;
  skillId?: string;
  state: A2aV9TaskState;
  createdAt: number;
  updatedAt: number;
  history: A2aV9TaskMessage[];
  artifacts: A2aV9Artifact[];
  reason?: string;
  deadlineMs?: number;
}

/** Serialisable snapshot of the task store. */
export interface A2aV9TaskStoreSnapshot {
  version: 9;
  tasks: A2aV9TaskSnapshot[];
  pushConfigs: A2aV9PushConfig[];
}

/**
 * A2A v9 task store: delegation, message + artifact
 * exchange, lifecycle, push configs, snapshot / restore.
 * The store never opens a network connection: delegation
 * records the task against a locally registered card, and
 * the host's runner does the work and drives transitions.
 */
export class A2aV9TaskStore {
  private tasks = new Map<string, A2aV9Task>();
  private pushConfigs = new Map<string, A2aV9PushConfig>();
  private events: A2aV9TaskEvent[] = [];
  private seq = 1;
  private maxTasks: number;
  private maxMessagesPerTask: number;
  private maxArtifactsPerTask: number;
  private maxArtifactBytes: number;
  private maxEvents: number;

  constructor(options: A2aV9TaskStoreOptions = {}) {
    this.maxTasks = options.maxTasks ?? A2A_V9_MAX_TASKS;
    this.maxMessagesPerTask = options.maxMessagesPerTask ?? A2A_V9_MAX_MESSAGES_PER_TASK;
    this.maxArtifactsPerTask = options.maxArtifactsPerTask ?? A2A_V9_MAX_ARTIFACTS_PER_TASK;
    this.maxArtifactBytes = options.maxArtifactBytes ?? A2A_V9_MAX_ARTIFACT_BYTES;
    this.maxEvents = options.maxEvents ?? A2A_V9_MAX_TASK_EVENTS;
  }

  /** Number of tasks. */
  size(): number {
    return this.tasks.size;
  }

  /** All tasks, newest first. */
  list(state?: A2aV9TaskState): A2aV9Task[] {
    const all = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    return (state === undefined ? all : all.filter((t) => t.state === state))
      .map((t) => ({ ...t, history: t.history.map((m) => ({ ...m })), artifacts: t.artifacts.map((a) => ({ ...a })) }));
  }

  /** Tasks delegated to one agent. */
  listForAgent(agentName: string): A2aV9Task[] {
    return this.list().filter((t) => t.agentName === agentName);
  }

  /** Tasks in one context. */
  listForContext(contextId: string): A2aV9Task[] {
    return this.list().filter((t) => t.contextId === contextId);
  }

  /** Get one task (undefined when missing). */
  get(taskId: string): A2aV9Task | undefined {
    const found = this.tasks.get(taskId);
    if (found === undefined) return undefined;
    return { ...found, history: found.history.map((m) => ({ ...m })), artifacts: found.artifacts.map((a) => ({ ...a })) };
  }

  /** Counts per state + totals. */
  counts(): Record<A2aV9TaskState, number> & { total: number; open: number } {
    const counts: Record<A2aV9TaskState, number> = {
      submitted: 0,
      working: 0,
      'input-required': 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      rejected: 0,
    };
    for (const task of this.tasks.values()) counts[task.state] += 1;
    return { ...counts, total: this.tasks.size, open: counts.submitted + counts.working + counts['input-required'] };
  }

  /** The task event log (oldest first, capped). */
  getEvents(): A2aV9TaskEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Events for one task (oldest first). */
  eventsFor(taskId: string): A2aV9TaskEvent[] {
    return this.events.filter((e) => e.taskId === taskId).map((e) => ({ ...e }));
  }

  private log(taskId: string, kind: A2aV9TaskEvent['kind'], detail?: string): void {
    this.events.push({ seq: this.seq, taskId, kind, at: Date.now(), detail });
    this.seq += 1;
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  private requireTask(taskId: string): A2aV9Task {
    const found = this.tasks.get(taskId);
    if (found === undefined) {
      throw new A2aV9Error('task-not-found', `No A2A task "${taskId}".`);
    }
    return found;
  }

  private touch(task: A2aV9Task): void {
    task.updatedAt = Date.now();
  }

  /**
   * Create a task in `submitted`. The caller supplies the
   * context and the agent; `delegate` (below) is the
   * capability-matching entry point that picks the agent.
   */
  create(input: {
    contextId: string;
    agentName: string;
    skillId?: string;
    initialMessage?: string;
    deadlineMs?: number;
  }): A2aV9Task {
    if (this.tasks.size >= this.maxTasks) {
      throw new A2aV9Error('too-many-tasks', `Cannot create a task: ${this.tasks.size} tasks already exist (max ${this.maxTasks}). Prune terminal tasks first.`);
    }
    if (typeof input.contextId !== 'string' || input.contextId.trim().length === 0) {
      throw new A2aV9Error('invalid-task', 'Task needs a non-empty contextId.');
    }
    if (typeof input.agentName !== 'string' || input.agentName.trim().length === 0) {
      throw new A2aV9Error('invalid-task', 'Task needs a non-empty agentName.');
    }
    if (input.deadlineMs !== undefined && (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= Date.now())) {
      throw new A2aV9Error('invalid-task', 'deadlineMs must be a future timestamp when given.');
    }
    const now = Date.now();
    const task: A2aV9Task = {
      id: `a2a-${randomUUID()}`,
      contextId: input.contextId,
      agentName: input.agentName,
      ...(input.skillId !== undefined ? { skillId: input.skillId } : {}),
      state: 'submitted',
      createdAt: now,
      updatedAt: now,
      history: [],
      artifacts: [],
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    };
    this.tasks.set(task.id, task);
    this.log(task.id, 'created', `delegated to ${input.agentName}${input.skillId !== undefined ? ` (skill ${input.skillId})` : ''}`);
    if (input.initialMessage !== undefined && input.initialMessage.length > 0) {
      this.sendMessage(task.id, 'user', input.initialMessage);
    }
    return { ...task, history: task.history.map((m) => ({ ...m })), artifacts: [] };
  }

  /**
   * Delegate a task with capability matching: find agents
   * offering the skill, prefer one whose card also matches
   * the requested capability, and create the task against
   * the best match. Throws when no registered agent offers
   * the skill (the caller must register the card first).
   */
  delegate(
    registry: A2aV9CardRegistry,
    input: {
      contextId: string;
      skillId: string;
      initialMessage?: string;
      capability?: keyof A2aV9AgentCapabilities;
      deadlineMs?: number;
    },
  ): { task: A2aV9Task; agentName: string; candidates: string[] } {
    const candidates = registry.discoverBySkill(input.skillId);
    if (candidates.length === 0) {
      throw new A2aV9Error(
        'no-agent-for-skill',
        `No registered agent offers skill "${input.skillId}". Register an Agent Card first (protocol_v9_a2a_cards register).`,
      );
    }
    const candidateNames = candidates.map((c) => c.card.name);
    let chosen = candidates[0];
    if (input.capability !== undefined) {
      const withCapability = candidates.find((c) => c.card.capabilities[input.capability as keyof A2aV9AgentCapabilities] === true);
      if (withCapability !== undefined) chosen = withCapability;
    }
    const task = this.create({
      contextId: input.contextId,
      agentName: chosen.card.name,
      skillId: input.skillId,
      initialMessage: input.initialMessage,
      deadlineMs: input.deadlineMs,
    });
    this.log(task.id, 'delegated', `skill ${input.skillId} -> ${chosen.card.name} (${candidates.length} candidate${candidates.length === 1 ? '' : 's'})`);
    return { task, agentName: chosen.card.name, candidates: candidateNames };
  }

  /** Move a task to a new state (legal transitions only). */
  transition(taskId: string, to: A2aV9TaskState, reason?: string): A2aV9Task {
    const task = this.requireTask(taskId);
    const from = task.state;
    if (!isA2aV9TaskTransitionLegal(from, to)) {
      throw new A2aV9Error(
        'illegal-transition',
        `Cannot move task "${taskId}" from ${from} to ${to}. Legal from ${from}: ${A2A_V9_TASK_TRANSITIONS[from].join(', ') || 'none (terminal)'}.`,
      );
    }
    task.state = to;
    task.reason = reason;
    this.touch(task);
    this.log(taskId, 'transition', `${from} -> ${to}${reason !== undefined ? ` (${reason})` : ''}`);
    return { ...task, history: task.history.map((m) => ({ ...m })), artifacts: task.artifacts.map((a) => ({ ...a })) };
  }

  /** Convenience: cancel a task (legal from submitted / working / input-required). */
  cancel(taskId: string, reason?: string): A2aV9Task {
    return this.transition(taskId, 'canceled', reason);
  }

  /** Convenience: complete a task (legal from working only). */
  complete(taskId: string, reason?: string): A2aV9Task {
    return this.transition(taskId, 'completed', reason);
  }

  /** Mark a task input-required (the agent is waiting on the user). */
  requestInput(taskId: string, reason: string): A2aV9Task {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new A2aV9Error('invalid-task', 'requestInput needs a non-empty reason (what the agent is waiting for).');
    }
    const task = this.transition(taskId, 'input-required', reason);
    this.log(taskId, 'input-required', reason);
    return task;
  }

  /**
   * Provide the awaited input: appends the user's message
   * and moves the task back to `working`.
   */
  provideInput(taskId: string, text: string): A2aV9Task {
    const task = this.requireTask(taskId);
    if (task.state !== 'input-required') {
      throw new A2aV9Error('not-waiting-for-input', `Task "${taskId}" is ${task.state}, not input-required.`);
    }
    this.sendMessage(taskId, 'user', text);
    const moved = this.transition(taskId, 'working', 'input provided');
    this.log(taskId, 'input-provided', text.slice(0, 120));
    return moved;
  }

  /**
   * Send a message on a task. Terminal tasks refuse new
   * messages; the message is recorded in the task history.
   */
  sendMessage(taskId: string, role: 'user' | 'agent', text: string): A2aV9TaskMessage {
    const task = this.requireTask(taskId);
    if (isA2aV9TaskTerminal(task.state)) {
      throw new A2aV9Error('task-terminal', `Task "${taskId}" is ${task.state}; no more messages.`);
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new A2aV9Error('empty-message', 'Message text must be a non-empty string.');
    }
    const message: A2aV9TaskMessage = {
      messageId: `${taskId}-m${task.history.length + 1}`,
      role,
      text,
      at: Date.now(),
      taskId,
    };
    task.history.push(message);
    while (task.history.length > this.maxMessagesPerTask) task.history.shift();
    this.touch(task);
    this.log(taskId, 'message', `${role}: ${text.slice(0, 120)}`);
    return { ...message };
  }

  /**
   * Attach an artifact to a task. The payload size is
   * capped; `data` artifacts must be valid JSON; terminal
   * tasks refuse new artifacts.
   */
  addArtifact(
    taskId: string,
    input: { kind: A2aV9ArtifactKind; name: string; payload: string; mimeType?: string; producedBy: string },
  ): A2aV9Artifact {
    const task = this.requireTask(taskId);
    if (isA2aV9TaskTerminal(task.state)) {
      throw new A2aV9Error('task-terminal', `Task "${taskId}" is ${task.state}; no more artifacts.`);
    }
    if (!((A2A_V9_ARTIFACT_KINDS as readonly string[]).includes(input.kind))) {
      throw new A2aV9Error('invalid-artifact', `Artifact kind must be one of ${A2A_V9_ARTIFACT_KINDS.join(', ')} (got "${input.kind}").`);
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new A2aV9Error('invalid-artifact', 'Artifact needs a non-empty name.');
    }
    if (typeof input.payload !== 'string') {
      throw new A2aV9Error('invalid-artifact', 'Artifact payload must be a string.');
    }
    if (Buffer.byteLength(input.payload, 'utf-8') > this.maxArtifactBytes) {
      throw new A2aV9Error('artifact-too-large', `Artifact payload is ${Buffer.byteLength(input.payload, 'utf-8')} bytes (max ${this.maxArtifactBytes}).`);
    }
    if (input.kind === 'data') {
      try {
        JSON.parse(input.payload);
      } catch {
        throw new A2aV9Error('invalid-artifact', 'A "data" artifact payload must be valid JSON.');
      }
    }
    if (task.artifacts.length >= this.maxArtifactsPerTask) {
      throw new A2aV9Error('too-many-artifacts', `Task "${taskId}" already has ${task.artifacts.length} artifacts (max ${this.maxArtifactsPerTask}).`);
    }
    const artifact: A2aV9Artifact = {
      artifactId: `${taskId}-a${task.artifacts.length + 1}`,
      kind: input.kind,
      name: input.name,
      payload: input.payload,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      at: Date.now(),
      producedBy: input.producedBy,
    };
    task.artifacts.push(artifact);
    this.touch(task);
    this.log(taskId, 'artifact', `${input.kind} ${input.name} (${Buffer.byteLength(input.payload, 'utf-8')} bytes)`);
    return { ...artifact };
  }

  /** Artifacts of one task (in order). */
  listArtifacts(taskId: string): A2aV9Artifact[] {
    return this.requireTask(taskId).artifacts.map((a) => ({ ...a }));
  }

  /**
   * Add a push-notification config to a task. The URL must
   * be loopback; the store never fetches it — the host
   * delivers pushes through its own callback.
   */
  addPushConfig(
    taskId: string,
    url: string,
    states?: A2aV9TaskState[],
  ): A2aV9PushConfig {
    this.requireTask(taskId);
    requireA2aV9LoopbackUrl(url, 'Push-notification');
    const config: A2aV9PushConfig = {
      configId: `push-${randomUUID()}`,
      taskId,
      url,
      states: states !== undefined && states.length > 0 ? [...states] : ['completed', 'failed', 'canceled'],
      at: Date.now(),
    };
    this.pushConfigs.set(config.configId, config);
    this.log(taskId, 'push-config', `${url} on [${config.states.join(', ')}]`);
    return { ...config, states: [...config.states] };
  }

  /** Push configs for one task. */
  listPushConfigs(taskId: string): A2aV9PushConfig[] {
    return [...this.pushConfigs.values()]
      .filter((c) => c.taskId === taskId)
      .map((c) => ({ ...c, states: [...c.states] }));
  }

  /** Remove a push config (false when missing). */
  removePushConfig(configId: string): boolean {
    return this.pushConfigs.delete(configId);
  }

  /** Mark overdue tasks (past deadline, still open) as failed. */
  sweepOverdue(nowMs: number = Date.now()): string[] {
    const failed: string[] = [];
    for (const task of [...this.tasks.values()]) {
      if (task.deadlineMs !== undefined && task.deadlineMs <= nowMs && !isA2aV9TaskTerminal(task.state)) {
        task.state = 'failed';
        task.reason = 'Deadline passed while the task was still open.';
        task.updatedAt = nowMs;
        this.log(task.id, 'transition', `${task.state} (deadline sweep)`);
        failed.push(task.id);
      }
    }
    return failed;
  }

  /** Drop terminal tasks older than the given age. */
  pruneTerminal(olderThanMs?: number): number {
    if (olderThanMs === undefined) return 0;
    const cutoff = Date.now() - olderThanMs;
    let pruned = 0;
    for (const task of [...this.tasks.values()]) {
      if (isA2aV9TaskTerminal(task.state) && task.updatedAt < cutoff) {
        this.tasks.delete(task.id);
        this.log(task.id, 'pruned', `terminal task older than ${olderThanMs}ms`);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Serialise the store (the host mirrors this to disk). */
  snapshot(): A2aV9TaskStoreSnapshot {
    return {
      version: 9,
      tasks: this.list().map((t) => ({
        id: t.id,
        contextId: t.contextId,
        agentName: t.agentName,
        ...(t.skillId !== undefined ? { skillId: t.skillId } : {}),
        state: t.state,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        history: t.history.map((m) => ({ ...m })),
        artifacts: t.artifacts.map((a) => ({ ...a })),
        ...(t.reason !== undefined ? { reason: t.reason } : {}),
        ...(t.deadlineMs !== undefined ? { deadlineMs: t.deadlineMs } : {}),
      })),
      pushConfigs: [...this.pushConfigs.values()].map((c) => ({ ...c, states: [...c.states] })),
    };
  }

  /**
   * Restore a snapshot. Tasks come back in their saved
   * state; `working` tasks come back `submitted` (no live
   * runner survives a restart — the host must resume them).
   * Push configs with non-loopback URLs are dropped.
   */
  restore(snapshot: A2aV9TaskStoreSnapshot): { restored: number; dropped: string[] } {
    if (snapshot.version !== 9 || !Array.isArray(snapshot.tasks)) {
      throw new A2aV9Error('invalid-snapshot', 'A2A task snapshot must have version 9 and a tasks array.');
    }
    const dropped: string[] = [];
    let restored = 0;
    for (const snap of snapshot.tasks) {
      if (!((['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'rejected'] as readonly string[]).includes(snap.state))) {
        dropped.push(`${snap.id}: unknown state "${snap.state}"`);
        continue;
      }
      const task: A2aV9Task = {
        id: snap.id,
        contextId: snap.contextId,
        agentName: snap.agentName,
        ...(snap.skillId !== undefined ? { skillId: snap.skillId } : {}),
        state: snap.state === 'working' ? 'submitted' : snap.state,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        history: snap.history.map((m) => ({ ...m })),
        artifacts: snap.artifacts.map((a) => ({ ...a })),
        ...(snap.reason !== undefined ? { reason: snap.reason } : {}),
        ...(snap.deadlineMs !== undefined ? { deadlineMs: snap.deadlineMs } : {}),
      };
      this.tasks.set(task.id, task);
      restored += 1;
    }
    if (Array.isArray(snapshot.pushConfigs)) {
      for (const config of snapshot.pushConfigs) {
        if (!isA2aV9LoopbackUrl(config.url)) {
          dropped.push(`${config.configId}: push URL is not loopback, dropped`);
          continue;
        }
        this.pushConfigs.set(config.configId, { ...config, states: [...config.states] });
      }
    }
    return { restored, dropped };
  }
}
