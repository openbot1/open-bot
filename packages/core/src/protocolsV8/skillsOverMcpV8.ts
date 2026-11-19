/**
 * Protocols v8 — Skills over MCP (v1.39, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v139.md (sections 1–2): Skills over MCP is
 * an extension in the MCP spec 2026-07-28 framework, and the
 * Agent Skills format is a directory + SKILL.md (plus scripts
 * / assets) with progressive disclosure in three tiers —
 * tier 1 metadata (name + description, ~100 tokens, loaded at
 * startup), tier 2 the SKILL.md body (<5k tokens, loaded when
 * triggered), tier 3 scripts / assets when needed.
 *
 * This module is open-bot's own implementation, written from
 * that description:
 *
 *   - `McpV8SkillPack`: one skill (name, version, description,
 *     SKILL.md body, optional scripts + assets). Names are
 *     `lowercase-with-dashes`, versions are semver.
 *   - `McpV8SkillPackRegistry`: holds packs, serves them over
 *     MCP resource URIs (`skill://<name>` for metadata,
 *     `skill://<name>/SKILL.md` for the body,
 *     `skill://<name>/assets/<path>` for assets). Tier 1 is
 *     always cheap (metadata only); tier 2/3 are fetched on
 *     demand — the registry never hands out a whole pack
 *     when the caller only asked for metadata.
 *   - Validation is structural: name format, semver, body
 *     size limits, asset path safety (no `..`, no absolute
 *     paths, no backslashes), script allow-list. A pack that
 *     fails validation is refused at registration.
 *   - `McpV8SkillPackPublisher`: renders a pack as MCP
 *     resources (list + read) so a stateless server can serve
 *     it, and resolves a `skill://` URI to its tier.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no disk: packs live in memory; the host mirrors
 * them when it wants persistence.
 */

/** Error raised by the Skills-over-MCP layer. */
export class McpV8SkillsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpV8SkillsError';
    this.code = code;
  }
}

/** Skill name format: lowercase letters, digits, dashes. */
export const MCP_V8_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Semver format for skill versions. */
export const MCP_V8_SKILL_VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
/** Max SKILL.md body bytes (5k tokens ≈ 20 KiB of text). */
export const MCP_V8_SKILL_MAX_BODY_BYTES = 20 * 1024;
/** Max description characters (tier 1 must stay ~100 tokens). */
export const MCP_V8_SKILL_MAX_DESCRIPTION_CHARS = 500;
/** Max assets per pack. */
export const MCP_V8_SKILL_MAX_ASSETS = 32;
/** Max asset bytes. */
export const MCP_V8_SKILL_MAX_ASSET_BYTES = 256 * 1024;
/** Resource URI scheme for skills. */
export const MCP_V8_SKILL_URI_SCHEME = 'skill://' as const;

/** Progressive-disclosure tier. */
export const MCP_V8_SKILL_TIERS = ['metadata', 'body', 'assets'] as const;
export type McpV8SkillTier = (typeof MCP_V8_SKILL_TIERS)[number];

/** One script bundled with a skill pack. */
export interface McpV8SkillScript {
  /** File name (e.g. `run.sh`, `check.py` — no path separators). */
  name: string;
  /** Script content. */
  content: string;
  /** Language / interpreter hint (e.g. `bash`, `python`). */
  language?: string;
}

/** One asset bundled with a skill pack. */
export interface McpV8SkillAsset {
  /** Relative path inside the pack (e.g. `templates/form.md`). */
  path: string;
  /** Asset content (text). */
  content: string;
  /** MIME type. */
  mimeType: string;
}

/** A skill pack. */
export interface McpV8SkillPack {
  /** Skill name (`lowercase-with-dashes`). */
  name: string;
  /** Semver version. */
  version: string;
  /** One-line description (tier 1, ≤500 chars). */
  description: string;
  /** SKILL.md body (tier 2, Markdown). */
  body: string;
  /** Optional allowed-tools declaration (tier 1 metadata). */
  allowedTools?: string[];
  /** Optional argument description (tier 1 metadata). */
  argumentHint?: string;
  /** Scripts (tier 3). */
  scripts?: McpV8SkillScript[];
  /** Assets (tier 3). */
  assets?: McpV8SkillAsset[];
}

/** Tier 1 metadata (what a client loads at startup). */
export interface McpV8SkillMetadata {
  name: string;
  version: string;
  description: string;
  /** Resource URI for the metadata. */
  uri: string;
  /** Resource URI for the body (tier 2, fetched on demand). */
  bodyUri: string;
  /** Approximate token cost of tier 1 (rough: chars / 4). */
  approxTokens: number;
  allowedTools?: string[];
  argumentHint?: string;
  /** Asset paths available (names only — contents are tier 3). */
  assetPaths: string[];
  /** Script names available (names only). */
  scriptNames: string[];
}

/** Validate a skill pack structurally. Returns problems (empty when valid). */
export function validateMcpV8SkillPack(pack: McpV8SkillPack): string[] {
  const problems: string[] = [];
  if (typeof pack.name !== 'string' || !MCP_V8_SKILL_NAME_RE.test(pack.name)) {
    problems.push(`Skill name "${pack.name}" must match ${MCP_V8_SKILL_NAME_RE} (lowercase letters, digits, dashes).`);
  }
  if (typeof pack.version !== 'string' || !MCP_V8_SKILL_VERSION_RE.test(pack.version)) {
    problems.push(`Skill version "${pack.version}" must be semver (e.g. 1.2.0).`);
  }
  if (typeof pack.description !== 'string' || pack.description.trim().length === 0) {
    problems.push('Skill needs a non-empty description.');
  } else if (pack.description.length > MCP_V8_SKILL_MAX_DESCRIPTION_CHARS) {
    problems.push(`Skill description is ${pack.description.length} chars (max ${MCP_V8_SKILL_MAX_DESCRIPTION_CHARS} — tier 1 must stay small).`);
  }
  if (typeof pack.body !== 'string' || pack.body.trim().length === 0) {
    problems.push('Skill needs a non-empty SKILL.md body.');
  } else if (Buffer.byteLength(pack.body, 'utf-8') > MCP_V8_SKILL_MAX_BODY_BYTES) {
    problems.push(`Skill body is ${Buffer.byteLength(pack.body, 'utf-8')} bytes (max ${MCP_V8_SKILL_MAX_BODY_BYTES} — tier 2 must stay under ~5k tokens).`);
  }
  if (pack.allowedTools !== undefined) {
    if (!Array.isArray(pack.allowedTools)) {
      problems.push('allowedTools must be an array of tool names.');
    } else {
      for (const t of pack.allowedTools) {
        if (typeof t !== 'string' || t.length === 0) problems.push('allowedTools must contain non-empty tool names.');
      }
    }
  }
  if (pack.scripts !== undefined) {
    if (!Array.isArray(pack.scripts)) {
      problems.push('scripts must be an array.');
    } else {
      for (const s of pack.scripts) {
        if (typeof s.name !== 'string' || s.name.length === 0 || s.name.includes('/') || s.name.includes('\\')) {
          problems.push(`Script name "${s.name}" must be a bare file name (no path separators).`);
        }
        if (typeof s.content !== 'string' || s.content.length === 0) {
          problems.push(`Script "${s.name}" needs non-empty content.`);
        }
      }
    }
  }
  if (pack.assets !== undefined) {
    if (!Array.isArray(pack.assets)) {
      problems.push('assets must be an array.');
    } else {
      if (pack.assets.length > MCP_V8_SKILL_MAX_ASSETS) {
        problems.push(`Skill has ${pack.assets.length} assets (max ${MCP_V8_SKILL_MAX_ASSETS}).`);
      }
      for (const a of pack.assets) {
        problems.push(...validateMcpV8SkillAssetPath(a.path));
        if (typeof a.content !== 'string') {
          problems.push(`Asset "${a.path}" needs string content.`);
        } else if (Buffer.byteLength(a.content, 'utf-8') > MCP_V8_SKILL_MAX_ASSET_BYTES) {
          problems.push(`Asset "${a.path}" is ${Buffer.byteLength(a.content, 'utf-8')} bytes (max ${MCP_V8_SKILL_MAX_ASSET_BYTES}).`);
        }
        if (typeof a.mimeType !== 'string' || a.mimeType.length === 0) {
          problems.push(`Asset "${a.path}" needs a mimeType.`);
        }
      }
    }
  }
  return problems;
}

/** Validate one asset path (relative, no escape from the pack). */
export function validateMcpV8SkillAssetPath(path: string): string[] {
  const problems: string[] = [];
  if (typeof path !== 'string' || path.length === 0) {
    problems.push('Asset path must be a non-empty string.');
    return problems;
  }
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    problems.push(`Asset path "${path}" must be relative and must not escape the pack (no leading /, no backslash, no "..").`);
  }
  return problems;
}

/** Resource URI for a skill's metadata (tier 1). */
export function mcpV8SkillMetadataUri(name: string): string {
  return `${MCP_V8_SKILL_URI_SCHEME}${name}`;
}

/** Resource URI for a skill's body (tier 2). */
export function mcpV8SkillBodyUri(name: string): string {
  return `${MCP_V8_SKILL_URI_SCHEME}${name}/SKILL.md`;
}

/** Resource URI for one asset (tier 3). */
export function mcpV8SkillAssetUri(name: string, assetPath: string): string {
  return `${MCP_V8_SKILL_URI_SCHEME}${name}/assets/${assetPath}`;
}

/**
 * Resolve a `skill://` URI to (skill name, tier, asset path).
 * Returns undefined when the URI is not a skill URI.
 */
export function resolveMcpV8SkillUri(uri: string): {
  name: string;
  tier: McpV8SkillTier;
  assetPath?: string;
} | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(MCP_V8_SKILL_URI_SCHEME)) return undefined;
  const rest = uri.slice(MCP_V8_SKILL_URI_SCHEME.length);
  if (rest.length === 0 || rest.includes('?') || rest.includes('#')) return undefined;
  const parts = rest.split('/');
  const name = parts[0] ?? '';
  if (!MCP_V8_SKILL_NAME_RE.test(name)) return undefined;
  if (parts.length === 1) return { name, tier: 'metadata' };
  if (parts.length === 2 && parts[1] === 'SKILL.md') return { name, tier: 'body' };
  if (parts.length >= 3 && parts[1] === 'assets') {
    const assetPath = parts.slice(2).join('/');
    if (validateMcpV8SkillAssetPath(assetPath).length > 0) return undefined;
    return { name, tier: 'assets', assetPath };
  }
  return undefined;
}

/** Build tier-1 metadata for a pack (cheap — never includes the body). */
export function mcpV8SkillMetadata(pack: McpV8SkillPack): McpV8SkillMetadata {
  const meta: McpV8SkillMetadata = {
    name: pack.name,
    version: pack.version,
    description: pack.description,
    uri: mcpV8SkillMetadataUri(pack.name),
    bodyUri: mcpV8SkillBodyUri(pack.name),
    approxTokens: Math.ceil(pack.description.length / 4) + 24,
    assetPaths: (pack.assets ?? []).map((a) => a.path),
    scriptNames: (pack.scripts ?? []).map((s) => s.name),
  };
  if (pack.allowedTools !== undefined) meta.allowedTools = [...pack.allowedTools];
  if (pack.argumentHint !== undefined) meta.argumentHint = pack.argumentHint;
  return meta;
}

/** Registry options. */
export interface McpV8SkillPackRegistryOptions {
  /** Max packs held (default 256; oldest replaced first is not applied — register refuses past the cap). */
  maxPacks?: number;
}

/**
 * Registry of skill packs, served over `skill://` resource
 * URIs with progressive disclosure: `metadata()` lists tier 1
 * only; `body()` and `asset()` fetch tier 2/3 on demand.
 */
export class McpV8SkillPackRegistry {
  private packs = new Map<string, McpV8SkillPack>();
  private maxPacks: number;

  constructor(options: McpV8SkillPackRegistryOptions = {}) {
    this.maxPacks = options.maxPacks ?? 256;
  }

  /** Number of packs held. */
  size(): number {
    return this.packs.size;
  }

  /** Pack names (sorted). */
  names(): string[] {
    return [...this.packs.keys()].sort();
  }

  /** Tier 1 metadata for every pack (sorted by name) — the startup list. */
  listMetadata(): McpV8SkillMetadata[] {
    return [...this.packs.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((p) => mcpV8SkillMetadata(p));
  }

  /** Get one pack (a copy; undefined when missing). */
  get(name: string): McpV8SkillPack | undefined {
    const found = this.packs.get(name);
    if (found === undefined) return undefined;
    return {
      ...found,
      body: found.body,
      ...(found.allowedTools !== undefined ? { allowedTools: [...found.allowedTools] } : {}),
      ...(found.argumentHint !== undefined ? { argumentHint: found.argumentHint } : {}),
      ...(found.scripts !== undefined
        ? { scripts: found.scripts.map((s) => ({ ...s })) }
        : {}),
      ...(found.assets !== undefined
        ? { assets: found.assets.map((a) => ({ ...a })) }
        : {}),
    };
  }

  /** Tier 1 metadata for one pack (undefined when missing). */
  metadata(name: string): McpV8SkillMetadata | undefined {
    const pack = this.packs.get(name);
    return pack === undefined ? undefined : mcpV8SkillMetadata(pack);
  }

  /** Tier 2 body for one pack (undefined when missing). */
  body(name: string): string | undefined {
    return this.packs.get(name)?.body;
  }

  /** Tier 3 asset for one pack (undefined when missing). */
  asset(name: string, assetPath: string): McpV8SkillAsset | undefined {
    const pack = this.packs.get(name);
    if (pack === undefined) return undefined;
    const found = (pack.assets ?? []).find((a) => a.path === assetPath);
    return found === undefined ? undefined : { ...found };
  }

  /** Register (or replace) a pack. Throws McpV8SkillsError when invalid. */
  register(pack: McpV8SkillPack): McpV8SkillMetadata {
    const problems = validateMcpV8SkillPack(pack);
    if (problems.length > 0) {
      throw new McpV8SkillsError('invalid-skill-pack', `Skill pack "${pack.name}" is invalid: ${problems.join('; ')}`);
    }
    if (!this.packs.has(pack.name) && this.packs.size >= this.maxPacks) {
      throw new McpV8SkillsError('registry-full', `Skill registry is full (${this.maxPacks} packs).`);
    }
    this.packs.set(pack.name, {
      ...pack,
      ...(pack.allowedTools !== undefined ? { allowedTools: [...pack.allowedTools] } : {}),
      ...(pack.scripts !== undefined ? { scripts: pack.scripts.map((s) => ({ ...s })) } : {}),
      ...(pack.assets !== undefined ? { assets: pack.assets.map((a) => ({ ...a })) } : {}),
    });
    return mcpV8SkillMetadata(pack);
  }

  /** Unregister a pack (false when missing). */
  unregister(name: string): boolean {
    return this.packs.delete(name);
  }

  /** Find packs whose metadata matches a query (name or description substring, case-insensitive). */
  search(query: string): McpV8SkillMetadata[] {
    const q = query.toLowerCase();
    return this.listMetadata().filter(
      (m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
    );
  }

  /**
   * Read a `skill://` URI: returns the resource contents
   * (metadata JSON for tier 1, SKILL.md for tier 2, asset
   * content for tier 3). Throws McpV8SkillsError when the
   * URI is unknown or the pack/asset is missing.
   */
  read(uri: string): { uri: string; mimeType: string; text: string } {
    const resolved = resolveMcpV8SkillUri(uri);
    if (resolved === undefined) {
      throw new McpV8SkillsError('invalid-skill-uri', `URI "${uri}" is not a valid skill:// resource URI.`);
    }
    const pack = this.packs.get(resolved.name);
    if (pack === undefined) {
      throw new McpV8SkillsError('skill-not-found', `Skill "${resolved.name}" is not registered.`);
    }
    if (resolved.tier === 'metadata') {
      return { uri, mimeType: 'application/json', text: JSON.stringify(mcpV8SkillMetadata(pack), null, 2) };
    }
    if (resolved.tier === 'body') {
      return { uri, mimeType: 'text/markdown', text: pack.body };
    }
    const asset = this.asset(resolved.name, resolved.assetPath ?? '');
    if (asset === undefined) {
      throw new McpV8SkillsError('asset-not-found', `Asset "${resolved.assetPath}" is not part of skill "${resolved.name}".`);
    }
    return { uri, mimeType: asset.mimeType, text: asset.content };
  }

  /** Resource URIs this registry serves (metadata + body + assets, sorted). */
  resourceUris(): string[] {
    const out: string[] = [];
    for (const pack of this.packs.values()) {
      out.push(mcpV8SkillMetadataUri(pack.name));
      out.push(mcpV8SkillBodyUri(pack.name));
      for (const asset of pack.assets ?? []) out.push(mcpV8SkillAssetUri(pack.name, asset.path));
    }
    return out.sort();
  }
}

/**
 * Publisher: renders a registry as MCP resources (list + read)
 * so a stateless server can serve skill packs without knowing
 * the registry internals.
 */
export class McpV8SkillPackPublisher {
  private registry: McpV8SkillPackRegistry;

  constructor(registry: McpV8SkillPackRegistry) {
    this.registry = registry;
  }

  /** Resource list (uri, name, mimeType) for every served URI. */
  listResources(): { uri: string; name: string; mimeType: string }[] {
    const out: { uri: string; name: string; mimeType: string }[] = [];
    for (const uri of this.registry.resourceUris()) {
      const resolved = resolveMcpV8SkillUri(uri);
      if (resolved === undefined) continue;
      out.push({
        uri,
        name: resolved.tier === 'metadata'
          ? `skill ${resolved.name} (metadata)`
          : resolved.tier === 'body'
            ? `skill ${resolved.name} (SKILL.md)`
            : `skill ${resolved.name} asset ${resolved.assetPath ?? ''}`,
        mimeType: resolved.tier === 'metadata' ? 'application/json' : resolved.tier === 'body' ? 'text/markdown' : 'text/plain',
      });
    }
    return out;
  }

  /** Read one resource URI (delegates to the registry). */
  readResource(uri: string): { contents: { uri: string; mimeType: string; text: string }[] } {
    const read = this.registry.read(uri);
    return { contents: [read] };
  }
}
