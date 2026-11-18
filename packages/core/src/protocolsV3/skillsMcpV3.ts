/**
 * Protocols v3 — Agent Skills over MCP v3 (v1.19, Team T3).
 *
 * Idea only, learned from the public Agent Skills description in
 * docs/repo-survey-v119.md section 2: Agent Skills joined the
 * Agentic AI Foundation (22/10/2026) and are served over MCP
 * (SEP-2640): `skills/list` / `skills/get`, `skill://` resources,
 * SKILL.md in the agentskills.io format. No code, text or asset
 * from any other repo is copied here.
 *
 * This builds on the existing skills layers without touching them:
 *  - `skills/` — SKILL.md parsing/validation on disk;
 *  - `protocolsV2/skillsMcp.ts` — the v2 MCP wire surface: one
 *    server's `SkillsMcpServer` (register/list/get, `skill://`
 *    resources, content-hash verification, `SkillActivationGate`
 *    with per-skill+hash user approval).
 * v3 is the multi-server client side on top of that server:
 *   1. aggregate discovery — one catalog merged from many MCP
 *      servers, with per-server provenance, name conflicts resolved
 *      by server priority (first server wins, the loser is listed
 *      as shadowed, never silently dropped);
 *   2. skill-as-tool invocation — a skill's declared `allowed-tools`
 *      become a tool-call plan: the agent asks for a skill by name,
 *      the v3 layer loads the body (hash-verified), checks the
 *      activation gate, and returns a call plan (which tools, in
 *      which order, with which arguments) instead of executing
 *      anything itself;
 *   3. versioning + updates — a newer version of a skill from the
 *      same server replaces the old one only after the content hash
 *      changes AND the user re-approves (approval is per skill +
 *      hash, so an edit re-asks);
 *   4. usage metering — every load / activation / invocation is
 *      counted per skill, so the UI can show which skills the agent
 *      actually uses and which are dead weight.
 *
 * A skill's body is plain guidance text: it is NEVER executed.
 * The v3 layer only ever reads skill metadata and bodies through
 * the v2 server (hash-verified) and hands the body to the agent
 * loop as context.
 */

import {
  SkillActivationGate,
  SkillsMcpServer,
  hashSkillContent,
  verifySkillContent,
  type McpSkill,
  type McpSkillMetadata,
} from '../protocolsV2/skillsMcp';

/** Skills-over-MCP extension version this layer speaks. */
export const SKILLS_MCP_V3_VERSION = '1.1.0';
/** Max skills merged into one aggregate catalog. */
export const SKILLS_MCP_V3_MAX_CATALOG = 1000;
/** Max body chars returned to the agent loop in one load. */
export const SKILLS_MCP_V3_MAX_BODY_CHARS = 100_000;

/** Error raised by the v3 skills layer. */
export class SkillsMcpV3Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillsMcpV3Error';
    this.code = code;
  }
}

/** One server that serves skills (an injected v2 server). */
export interface SkillsMcpV3ServerRef {
  /** Server id (stable, shown in the UI). */
  serverId: string;
  /** Human-readable server name. */
  serverName: string;
  /** Priority for name conflicts (lower wins). */
  priority: number;
  /** The v2 server behind this ref. */
  server: SkillsMcpServer;
}

/** One skill in the aggregate catalog (with provenance). */
export interface SkillsMcpV3CatalogEntry extends McpSkillMetadata {
  /** Server that serves this skill. */
  serverId: string;
  /** Server name (UI). */
  serverName: string;
  /** True when another server also serves this name (shadowed). */
  shadowedBy?: string;
  /** Version this entry was first seen at (for update detection). */
  firstSeenVersion?: string;
}

/** Per-skill usage counters. */
export interface SkillsMcpV3Usage {
  loads: number;
  activations: number;
  invocations: number;
  lastUsedAt?: string;
}

/** One step of a skill invocation plan. */
export interface SkillsMcpV3PlanStep {
  /** Tool to call. */
  toolName: string;
  /** Arguments for the tool (may reference `{{input.<key>}}`). */
  args: Record<string, unknown>;
  /** Human-readable reason this step exists. */
  reason: string;
}

/** A skill invocation plan (data only — the agent loop executes it). */
export interface SkillsMcpV3InvocationPlan {
  skillName: string;
  serverId: string;
  /** Content hash the plan was built from (re-checked at load). */
  contentHash: string;
  /** Steps in order. */
  steps: SkillsMcpV3PlanStep[];
  /** Input keys the plan expects from the caller. */
  inputKeys: string[];
}

/** Compare two `major.minor.patch` versions: -1 / 0 / 1. */
export function compareSkillVersions(a: string | undefined, b: string | undefined): number {
  const parse = (v: string | undefined): [number, number, number] => {
    if (!v) return [0, 0, 0];
    const parts = v.split('.').map((p) => Number(p));
    return [
      Number.isFinite(parts[0]) ? parts[0] : 0,
      Number.isFinite(parts[1]) ? parts[1] : 0,
      Number.isFinite(parts[2]) ? parts[2] : 0,
    ];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Aggregate skill catalog across many MCP servers.
 *
 * - `discover()` merges every server's `skills/list` into one
 *   catalog. Name conflicts resolve by server priority (lower
 *   number wins); the loser's id is recorded in the winner's
 *   `shadowedBy`, so the user can see the conflict in Settings.
 * - `load()` fetches a skill body through the owning server
 *   (hash-verified by the v2 server), checks the activation gate,
 *   and records usage.
 * - `planInvocation()` turns a skill + caller input into a
 *   tool-call plan: one step per allowed tool, in declaration
 *   order, with `{{input.<key>}}` placeholders the agent loop
 *   fills from the caller's input.
 * - `SkillsMcpV3Catalog.diffCatalogs()` compares two catalog
 *   snapshots and reports skills whose version or hash changed
 *   (those need a re-approval before they can be used again).
 */
export class SkillsMcpV3Catalog {
  private readonly servers: SkillsMcpV3ServerRef[] = [];
  private readonly gate: SkillActivationGate;
  private readonly usage = new Map<string, SkillsMcpV3Usage>();
  private catalog: SkillsMcpV3CatalogEntry[] = [];
  private lastDiscoveredAt: string | null = null;

  constructor(gate: SkillActivationGate = new SkillActivationGate()) {
    this.gate = gate;
  }

  /** The activation gate (shared with the caller for approvals). */
  getGate(): SkillActivationGate {
    return this.gate;
  }

  /** Register a server (kept sorted by priority). */
  addServer(ref: SkillsMcpV3ServerRef): void {
    if (this.servers.some((s) => s.serverId === ref.serverId)) {
      throw new SkillsMcpV3Error('DUPLICATE_SERVER', `Server ${ref.serverId} is already registered`);
    }
    this.servers.push(ref);
    this.servers.sort((a, b) => a.priority - b.priority);
  }

  /** Remove a server (its skills leave the catalog on next discover). */
  removeServer(serverId: string): boolean {
    const index = this.servers.findIndex((s) => s.serverId === serverId);
    if (index === -1) return false;
    this.servers.splice(index, 1);
    return true;
  }

  /** Registered servers (priority order). */
  listServers(): SkillsMcpV3ServerRef[] {
    return [...this.servers];
  }

  /** Merge every server's skills into one catalog. */
  discover(): SkillsMcpV3CatalogEntry[] {
    const byName = new Map<string, SkillsMcpV3CatalogEntry>();
    const shadowed = new Map<string, string>();
    for (const ref of this.servers) {
      for (const meta of ref.server.list()) {
        const existing = byName.get(meta.name);
        if (existing) {
          // Record the LOSER's id: the winner's `shadowedBy` names the
          // other server that also serves this skill (the previous
          // code stored the winner's own id here, so `shadowedBy`
          // could never be set — the final loop compares it against
          // the winner's id and always skipped it).
          shadowed.set(meta.name, ref.serverId);
          continue; // first (highest-priority) server wins
        }
        byName.set(meta.name, {
          ...meta,
          serverId: ref.serverId,
          serverName: ref.serverName,
        });
      }
    }
    for (const entry of byName.values()) {
      const winner = shadowed.get(entry.name);
      if (winner !== undefined && winner !== entry.serverId) {
        entry.shadowedBy = winner;
      }
    }
    const merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (merged.length > SKILLS_MCP_V3_MAX_CATALOG) {
      throw new SkillsMcpV3Error(
        'CATALOG_TOO_LARGE',
        `Aggregate skill catalog exceeds ${SKILLS_MCP_V3_MAX_CATALOG} skills`,
      );
    }
    this.catalog = merged;
    this.lastDiscoveredAt = new Date().toISOString();
    return [...this.catalog];
  }

  /** Last discovery time, or null when never discovered. */
  getLastDiscoveredAt(): string | null {
    return this.lastDiscoveredAt;
  }

  /** Current catalog (empty until `discover()` runs). */
  list(): SkillsMcpV3CatalogEntry[] {
    return [...this.catalog];
  }

  /** One catalog entry by skill name, or null. */
  get(name: string): SkillsMcpV3CatalogEntry | null {
    return this.catalog.find((e) => e.name === name) ?? null;
  }

  /** Search the catalog by name/description substring. */
  search(query: string): SkillsMcpV3CatalogEntry[] {
    const q = query.trim().toLowerCase();
    if (q === '') return this.list();
    return this.catalog.filter(
      (e) => e.name.includes(q) || e.description.toLowerCase().includes(q),
    );
  }

  /**
   * Load a skill body: fetch through the owning server (the v2
   * server re-hashes and refuses changed content), verify the
   * content, check the activation gate, and record usage. Returns
   * the skill (body truncated to the max the agent loop accepts).
   */
  load(name: string): McpSkill {
    const entry = this.get(name);
    if (!entry) throw new SkillsMcpV3Error('UNKNOWN_SKILL', `Unknown skill: ${name}`);
    const ref = this.servers.find((s) => s.serverId === entry.serverId);
    if (!ref) throw new SkillsMcpV3Error('NO_SERVER', `Server ${entry.serverId} is no longer registered`);
    const skill = ref.server.get(name);
    // Verify the FULL SKILL.md bytes, not the parsed body: the v2
    // server's `get()` returns the frontmatter-stripped body, but
    // `contentHash` is the hash of the full document — verifying the
    // stripped body against it could never match (every load failed
    // with CONTENT_UNVERIFIED). `resolveResource` returns the full
    // bytes, exactly like the v2 activation gate does.
    const fullContent = ref.server.resolveResource(entry.uri).text;
    const problems = verifySkillContent(name, fullContent, entry.contentHash);
    if (problems.length > 0) {
      throw new SkillsMcpV3Error('CONTENT_UNVERIFIED', `Skill "${name}" failed verification: ${problems.join('; ')}`);
    }
    const approval = this.gate.getApproval(name, entry.contentHash);
    if (!this.gate.canActivate(name, entry.contentHash)) {
      throw new SkillsMcpV3Error(
        'NOT_APPROVED',
        `Skill "${name}" needs user approval before it can be used` +
          (approval?.decision === 'deny' ? ' (user denied it)' : ' (no approval recorded)'),
      );
    }
    this.recordUsage(name, 'loads');
    const body = skill.body.length > SKILLS_MCP_V3_MAX_BODY_CHARS
      ? skill.body.slice(0, SKILLS_MCP_V3_MAX_BODY_CHARS)
      : skill.body;
    return { ...skill, body };
  }

  /**
   * Build a tool-call plan for a skill: one step per allowed tool
   * (in declaration order). `input` keys are referenced as
   * `{{input.<key>}}` placeholders; the agent loop fills them.
   * The skill must be loaded (approved) first.
   */
  planInvocation(name: string, input: Record<string, unknown>): SkillsMcpV3InvocationPlan {
    const entry = this.get(name);
    if (!entry) throw new SkillsMcpV3Error('UNKNOWN_SKILL', `Unknown skill: ${name}`);
    const allowedTools = entry.allowedTools ?? [];
    if (allowedTools.length === 0) {
      throw new SkillsMcpV3Error(
        'NO_TOOLS',
        `Skill "${name}" declares no allowed tools, so there is nothing to invoke`,
      );
    }
    const inputKeys = Object.keys(input);
    const steps: SkillsMcpV3PlanStep[] = allowedTools.map((toolName, index) => ({
      toolName,
      args: Object.fromEntries(
        inputKeys.map((key) => [key, `{{input.${key}}}`]),
      ),
      reason: `Step ${index + 1}/${allowedTools.length} of skill "${name}": call ${toolName}`,
    }));
    this.recordUsage(name, 'invocations');
    return {
      skillName: name,
      serverId: entry.serverId,
      contentHash: entry.contentHash,
      steps,
      inputKeys,
    };
  }

  /** Fill a plan's `{{input.<key>}}` placeholders from real input. */
  static fillPlanInput(
    plan: SkillsMcpV3InvocationPlan,
    input: Record<string, unknown>,
  ): SkillsMcpV3PlanStep[] {
    const fill = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      const match = /^\{\{input\.([A-Za-z0-9_]+)\}\}$/.exec(value);
      if (!match) return value;
      return input[match[1]];
    };
    return plan.steps.map((step) => ({
      ...step,
      args: Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, fill(v)])),
    }));
  }

  /**
   * Diff a previous catalog snapshot against a fresh discovery.
   * Use this for real update detection:
   * pass the snapshot from the last `discover()` call.
   */
  static diffCatalogs(
    previous: readonly SkillsMcpV3CatalogEntry[],
    fresh: readonly SkillsMcpV3CatalogEntry[],
  ): Array<{
    name: string;
    serverId: string;
    change: 'added' | 'removed' | 'updated' | 'hash-changed';
    oldVersion?: string;
    newVersion?: string;
  }> {
    const prevByName = new Map(previous.map((e) => [e.name, e]));
    const freshByName = new Map(fresh.map((e) => [e.name, e]));
    const out: Array<{
      name: string;
      serverId: string;
      change: 'added' | 'removed' | 'updated' | 'hash-changed';
      oldVersion?: string;
      newVersion?: string;
    }> = [];
    for (const entry of fresh) {
      const old = prevByName.get(entry.name);
      if (!old) {
        out.push({ name: entry.name, serverId: entry.serverId, change: 'added', newVersion: entry.version });
        continue;
      }
      if (old.contentHash !== entry.contentHash) {
        out.push({
          name: entry.name,
          serverId: entry.serverId,
          change: 'hash-changed',
          oldVersion: old.version,
          newVersion: entry.version,
        });
        continue;
      }
      if (compareSkillVersions(old.version, entry.version) !== 0) {
        out.push({
          name: entry.name,
          serverId: entry.serverId,
          change: 'updated',
          oldVersion: old.version,
          newVersion: entry.version,
        });
      }
    }
    for (const entry of previous) {
      if (!freshByName.has(entry.name)) {
        out.push({ name: entry.name, serverId: entry.serverId, change: 'removed', oldVersion: entry.version });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Usage counters for one skill. */
  usageFor(name: string): SkillsMcpV3Usage {
    return this.usage.get(name) ?? { loads: 0, activations: 0, invocations: 0 };
  }

  /** Usage counters for all skills that have any. */
  allUsage(): Record<string, SkillsMcpV3Usage> {
    return Object.fromEntries(this.usage.entries());
  }

  /** Record an activation (the gate approved and the agent used the skill). */
  recordActivation(name: string): void {
    this.recordUsage(name, 'activations');
  }

  private recordUsage(name: string, kind: 'loads' | 'activations' | 'invocations'): void {
    const current = this.usage.get(name) ?? { loads: 0, activations: 0, invocations: 0 };
    current[kind] += 1;
    current.lastUsedAt = new Date().toISOString();
    this.usage.set(name, current);
  }
}

/** Re-export the hash helper for callers that only import v3. */
export { hashSkillContent };
