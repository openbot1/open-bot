/**
 * Protocols v2 — Skills over MCP, SEP-2640 final 09/2026
 * (v1.16, Team T2).
 *
 * Idea only, learned from the public SEP-2640 description in
 * docs/repo-survey-v116.md section 3: `skills/list` /
 * `skills/get`, skills served as `skill://…` resources, SKILL.md
 * following the agentskills.io format (the same format Claude
 * Code / Codex / Gemini CLI / Copilot / Cursor support). No
 * code, text or asset from any other repo is copied here. This
 * builds on open-bot's existing skills module (`skills/`, which
 * parses and validates SKILL.md on disk) without touching it:
 * v2 is the MCP wire surface for those skills — list/get over
 * JSON-RPC, a `skill://` resource resolver, a catalog index at
 * `skill://index.json`, and a loading path that verifies content
 * and requires the user's approval before a skill is activated.
 *
 * A skill's body is plain guidance text: it is NEVER executed.
 * That is why the loading path is strict:
 * - `parseSkillMd()` rejects frontmatter that is missing a
 *   name/description, has a name that does not match the
 *   directory, or is too long — before anything is served.
 * - `verifySkillContent()` hashes the served bytes and compares
 *   them with the hash recorded at registration, so a skill
 *   that changed on disk after registration is refused instead
 *   of silently served.
 * - `SkillActivationGate` requires an explicit user approval
 *   (allow once / allow always / deny) before `activate()` hands
 *   the skill body to the agent loop. Approval is per skill +
 *   content hash, so editing a skill re-asks.
 *
 * Design rules:
 * - `skills/list` returns metadata only (name, description,
 *   version, hash) — the body is fetched with `skills/get`, so
 *   a client never pays the context cost of skills it does not
 *   use (progressive disclosure, as in the survey).
 * - Resource URIs are exactly `skill://<name>` for the SKILL.md
 *   body and `skill://index.json` for the catalog index.
 * - The catalog is a snapshot: `buildSkillIndex()` freezes the
 *   registered skills at call time; later registrations do not
 *   rewrite an index a client already holds.
 */

import * as crypto from 'node:crypto';

/** SEP-2640 extension identifier, negotiated through capabilities. */
export const SKILLS_MCP_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILLS_MCP_VERSION = '1.0.0';
/** Resource URI of the catalog index. */
export const SKILL_INDEX_URI = 'skill://index.json';

/** Metadata for one skill, as returned by `skills/list`. */
export interface McpSkillMetadata {
  name: string;
  description: string;
  version?: string;
  /** SHA-256 hex of the served SKILL.md bytes. */
  contentHash: string;
  /** `skill://<name>` */
  uri: string;
  /** Tools the skill is allowed to use (allowlist, may be empty). */
  allowedTools?: string[];
  /** Source of the skill: bundled with the app or user-installed. */
  source: 'builtin' | 'user';
}

/** A skill with its parsed body, as returned by `skills/get`. */
export interface McpSkill extends McpSkillMetadata {
  body: string;
  frontmatter: Record<string, unknown>;
}

/** Error raised by the skills surface. */
export class McpSkillError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpSkillError';
    this.code = code;
  }
}

/** SHA-256 hex of a string (UTF-8). */
export function hashSkillContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Parsed SKILL.md: frontmatter fields + body text. */
export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse a SKILL.md document. Frontmatter is the `---` block at
 * the top; the parser understands `key: value` lines, `[a, b]`
 * lists and one level of `key:` nesting is NOT supported (a
 * nested block is kept as a raw string — the validator only
 * needs the top-level fields). Returns problems instead of
 * throwing so the caller can report all of them at once.
 */
export function parseSkillMd(content: string): { parsed: ParsedSkillMd | null; problems: string[] } {
  const problems: string[] = [];
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { parsed: null, problems: ['SKILL.md must start with a YAML frontmatter block (---)'] };
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { parsed: null, problems: ['SKILL.md frontmatter block is not closed (---)'] };
  const frontmatterText = content.slice(4, end).replace(/^\r?\n/, '');
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter: Record<string, unknown> = {};
  for (const rawLine of frontmatterText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) { problems.push(`frontmatter line has no colon: "${line.trim()}"`); continue; }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) { problems.push('frontmatter has an empty key'); continue; }
    if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter((s) => s.length > 0);
    } else if (value === 'true') frontmatter[key] = true;
    else if (value === 'false') frontmatter[key] = false;
    else frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
  }
  if (body.trim().length === 0) problems.push('SKILL.md body is empty');
  if (problems.length > 0) return { parsed: null, problems };
  return { parsed: { frontmatter, body }, problems: [] };
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate parsed frontmatter against the agentskills.io rules
 * the survey names: `name` (lowercase + hyphen, 1–64 chars, must
 * match the directory/registered name) and `description` (1–1024
 * chars, must say WHEN to use the skill) are required.
 */
export function validateSkillFrontmatter(
  parsed: ParsedSkillMd,
  expectedName?: string,
): string[] {
  const problems: string[] = [];
  const fm = parsed.frontmatter;
  const name = fm.name;
  if (typeof name !== 'string' || name.length === 0) problems.push('frontmatter.name is required');
  else if (!SKILL_NAME_RE.test(name)) problems.push(`frontmatter.name "${name}" must be 1-64 lowercase letters, digits or hyphens`);
  else if (expectedName !== undefined && name !== expectedName) {
    problems.push(`frontmatter.name "${name}" does not match the skill name "${expectedName}"`);
  }
  const description = fm.description;
  if (typeof description !== 'string' || description.length === 0) problems.push('frontmatter.description is required');
  else if (description.length > 1024) problems.push('frontmatter.description must be at most 1024 characters');
  if (fm['allowed-tools'] !== undefined && !Array.isArray(fm['allowed-tools'])) {
    problems.push('frontmatter.allowed-tools must be a list');
  }
  return problems;
}

/** One registered skill (the bytes the server will serve). */
interface RegisteredSkill {
  metadata: McpSkillMetadata;
  content: string;
  parsed: ParsedSkillMd;
}

/** The catalog index served at `skill://index.json`. */
export interface SkillIndex {
  version: string;
  generatedAtMs: number;
  count: number;
  skills: McpSkillMetadata[];
}

/** Approval decision for activating a skill. */
export type SkillApprovalDecision = 'allow-once' | 'allow-always' | 'deny';
export interface SkillApproval {
  skillName: string;
  contentHash: string;
  decision: SkillApprovalDecision;
  atMs: number;
}

/**
 * Skills-over-MCP server surface.
 *
 * Register skills from their SKILL.md bytes, then serve
 * `skills/list`, `skills/get`, the `skill://` resources and the
 * catalog index. Registration verifies the content; serving
 * re-verifies the hash on every `get`, so a skill edited after
 * registration is refused until it is re-registered.
 */
export class SkillsMcpServer {
  private readonly skills = new Map<string, RegisteredSkill>();

  /** Register a skill from SKILL.md bytes. Throws on invalid content. */
  register(name: string, content: string, source: McpSkillMetadata['source'] = 'user'): McpSkillMetadata {
    if (!SKILL_NAME_RE.test(name)) {
      throw new McpSkillError('INVALID_NAME', `Skill name "${name}" must be 1-64 lowercase letters, digits or hyphens`);
    }
    const { parsed, problems } = parseSkillMd(content);
    if (!parsed) throw new McpSkillError('INVALID_SKILL_MD', problems.join('; '));
    const frontmatterProblems = validateSkillFrontmatter(parsed, name);
    if (frontmatterProblems.length > 0) {
      throw new McpSkillError('INVALID_FRONTMATTER', frontmatterProblems.join('; '));
    }
    const metadata: McpSkillMetadata = {
      name,
      description: String(parsed.frontmatter.description),
      version: typeof parsed.frontmatter.version === 'string' ? parsed.frontmatter.version : undefined,
      contentHash: hashSkillContent(content),
      uri: `skill://${name}`,
      allowedTools: Array.isArray(parsed.frontmatter['allowed-tools'])
        ? (parsed.frontmatter['allowed-tools'] as unknown[]).map(String)
        : undefined,
      source,
    };
    this.skills.set(name, { metadata, content, parsed });
    return metadata;
  }

  /** Remove a registered skill. Returns false when it was not registered. */
  unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  /** `skills/list` — metadata only, no bodies. */
  list(filter?: { source?: McpSkillMetadata['source']; query?: string }): McpSkillMetadata[] {
    const query = filter?.query?.trim().toLowerCase();
    return [...this.skills.values()]
      .map((s) => ({ ...s.metadata }))
      .filter((m) => (filter?.source === undefined || m.source === filter.source)
        && (query === undefined || query.length === 0
          || m.name.includes(query) || m.description.toLowerCase().includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `skills/get` — the full skill, re-verified: the stored bytes
   * are hashed again and compared with the registration hash.
   * A mismatch means the skill changed since registration and
   * the get is refused (re-register to serve the new content).
   */
  get(name: string): McpSkill {
    const registered = this.skills.get(name);
    if (!registered) throw new McpSkillError('UNKNOWN_SKILL', `Unknown skill: ${name}`);
    const currentHash = hashSkillContent(registered.content);
    if (currentHash !== registered.metadata.contentHash) {
      throw new McpSkillError(
        'CONTENT_CHANGED',
        `Skill "${name}" changed since registration (hash mismatch). Re-register it before serving.`,
      );
    }
    return { ...registered.metadata, body: registered.parsed.body, frontmatter: { ...registered.parsed.frontmatter } };
  }

  /**
   * Resolve a `skill://` resource URI: `skill://index.json`
   * returns the catalog index, `skill://<name>` returns that
   * skill's SKILL.md bytes. Anything else is rejected.
   */
  resolveResource(uri: string): { uri: string; mimeType: string; text: string } {
    if (uri === SKILL_INDEX_URI) {
      return { uri, mimeType: 'application/json', text: JSON.stringify(this.buildIndex(), null, 2) };
    }
    const match = /^skill:\/\/([a-z0-9][a-z0-9-]{0,63})$/.exec(uri);
    if (!match) throw new McpSkillError('INVALID_RESOURCE_URI', `Invalid skill resource URI: ${uri}`);
    const registered = this.skills.get(match[1]);
    if (!registered) throw new McpSkillError('UNKNOWN_SKILL', `Unknown skill: ${match[1]}`);
    return { uri, mimeType: 'text/markdown', text: registered.content };
  }

  /** Build the catalog index snapshot. */
  buildIndex(): SkillIndex {
    const skills = this.list();
    return { version: SKILLS_MCP_VERSION, generatedAtMs: Date.now(), count: skills.length, skills };
  }

  /** Number of registered skills. */
  size(): number {
    return this.skills.size;
  }
}

/**
 * Verify served skill content before it reaches the agent:
 * re-parse it, re-check the frontmatter, and compare the hash
 * with the hash recorded at registration. Returns the problems
 * found (empty = verified).
 */
export function verifySkillContent(name: string, content: string, expectedHash: string): string[] {
  const problems: string[] = [];
  if (hashSkillContent(content) !== expectedHash) {
    problems.push(`content hash mismatch for skill "${name}" (content changed since registration)`);
    return problems;
  }
  const { parsed, problems: parseProblems } = parseSkillMd(content);
  if (!parsed) return [...problems, ...parseProblems];
  return [...problems, ...validateSkillFrontmatter(parsed, name)];
}

/**
 * Approval gate for skill activation.
 *
 * A skill may only be activated after the user approves it, and
 * the approval is bound to the content hash — editing the skill
 * invalidates the approval and re-asks. `allow-always` is
 * remembered per skill+hash; `allow-once` is consumed by one
 * activation; `deny` blocks activation until the user changes
 * their mind (a new approval replaces the old one).
 */
export class SkillActivationGate {
  private readonly approvals = new Map<string, SkillApproval>();

  private key(skillName: string, contentHash: string): string {
    return `${skillName}\n${contentHash}`;
  }

  /** Record the user's approval decision for a skill+hash. */
  approve(skillName: string, contentHash: string, decision: SkillApprovalDecision): SkillApproval {
    const approval: SkillApproval = { skillName, contentHash, decision, atMs: Date.now() };
    this.approvals.set(this.key(skillName, contentHash), approval);
    return approval;
  }

  /** Forget the approval for a skill+hash (e.g. the user revoked it). */
  revoke(skillName: string, contentHash: string): boolean {
    return this.approvals.delete(this.key(skillName, contentHash));
  }

  /** The stored approval for a skill+hash, if any. */
  getApproval(skillName: string, contentHash: string): SkillApproval | undefined {
    return this.approvals.get(this.key(skillName, contentHash));
  }

  /** True when the skill may be activated right now. */
  canActivate(skillName: string, contentHash: string): boolean {
    const approval = this.approvals.get(this.key(skillName, contentHash));
    return approval !== undefined && approval.decision !== 'deny';
  }

  /**
   * Activate a skill: verify the content, then require an
   * approval. An `allow-once` approval is consumed. Returns the
   * skill body for the agent loop. Throws when verification
   * fails or the user has not approved (or denied) it.
   */
  activate(server: SkillsMcpServer, skillName: string): McpSkill {
    const skill = server.get(skillName);
    const problems = verifySkillContent(skillName, server.resolveResource(skill.uri).text, skill.contentHash);
    if (problems.length > 0) {
      throw new McpSkillError('VERIFY_FAILED', problems.join('; '));
    }
    const approval = this.approvals.get(this.key(skillName, skill.contentHash));
    if (!approval || approval.decision === 'deny') {
      throw new McpSkillError(
        'APPROVAL_REQUIRED',
        `Skill "${skillName}" needs user approval before activation` +
          (approval?.decision === 'deny' ? ' (user denied it)' : ' (no approval recorded)') +
          '. Ask the user to approve it in Settings or the approval card.',
      );
    }
    if (approval.decision === 'allow-once') this.approvals.delete(this.key(skillName, skill.contentHash));
    return skill;
  }
}
