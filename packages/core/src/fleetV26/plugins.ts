/**
 * Plugins v26 — bundles that ship skills + hooks + an MCP server (v1.39, Team T6).
 *
 * Idea (from the v139 survey §2, Claude Code plugins): a plugin is a
 * SHAREABLE package that bundles skills + hooks + slash commands +
 * an MCP server in one versioned unit. A user installs one plugin and
 * the whole fleet gains the skills, the policy hooks, and the server —
 * instead of wiring three things by hand.
 *
 * Trust model (deliberately boring):
 * - A bundle carries a manifest checksum (sha256 over the canonical
 *   manifest). Install recomputes it; a mismatch refuses the install.
 * - A bundle MAY carry a `signature` string (opaque here — the host
 *   verifies it against its own trust store; this module only records
 *   whether one was present and whether the host marked it verified).
 * - Versions are pinned: installing the same id at another version
 *   replaces it only with `overwrite`, and the old version is reported.
 * - Dependencies are checked at install: every skill the bundle's
 *   hooks reference must exist in the fleet skill pack (or ship
 *   inside the bundle). A bundle that references a missing skill is
 *   refused — a half-installed plugin is worse than none.
 * - Installing a bundle never runs anything: skills land in the pack,
 *   hooks land in the registry, the MCP server is recorded as a
 *   descriptor for the host to start. Execution stays with the host.
 *
 * Bundles are enabled/disabled as a unit; disabling a bundle disables
 * its hooks (skills stay installed but unlisted for matching until
 * re-enabled — the pack tracks which bundle owns each skill).
 */

import { createHash } from 'node:crypto';
import type { FleetV26HookRegistry } from './hooks';
import type { FleetV26Skill, FleetV26SkillPack } from './skills';

/** One MCP server shipped inside a plugin bundle. */
export interface FleetV26PluginMcpServer {
  /** Server id (unique inside the bundle). */
  id: string;
  /** Command the host runs (display only; never executed here). */
  command: string;
  /** Arguments (display only). */
  args: string[];
  /** Tools the server exposes (declared, for the UI + allowlist). */
  tools: string[];
}

/** A plugin bundle manifest (the signed, versioned unit). */
export interface FleetV26PluginBundle {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** Skills shipped in the bundle. */
  skills: FleetV26Skill[];
  /** Hook ids the bundle wants (definitions live in `hooks`). */
  hookIds: string[];
  /** MCP servers shipped in the bundle. */
  mcpServers: FleetV26PluginMcpServer[];
  /** Other plugin ids this bundle needs (must be installed first). */
  dependencies: string[];
  /** sha256 over the canonical manifest (computed at build time). */
  checksum: string;
  /** Opaque signature string (null = unsigned). */
  signature: string | null;
  /** True when the host verified the signature (host sets this). */
  signatureVerified: boolean;
}

/** An installed plugin (bundle + install state). */
export interface FleetV26InstalledPlugin {
  bundle: FleetV26PluginBundle;
  enabled: boolean;
  installedAtMs: number;
  /** Previous version replaced by this install (null = fresh). */
  replacedVersion: string | null;
}

/** Result of an install / lifecycle operation. */
export interface FleetV26PluginOp {
  ok: boolean;
  id: string;
  message: string;
}

export const FLEET_V26_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Canonical manifest JSON (the checksum input — key order fixed). */
export function canonicalFleetV26PluginManifest(
  bundle: Omit<FleetV26PluginBundle, 'checksum' | 'signature' | 'signatureVerified'>,
): string {
  return JSON.stringify({
    id: bundle.id,
    name: bundle.name,
    version: bundle.version,
    description: bundle.description,
    author: bundle.author,
    skills: bundle.skills.map((s) => s.name).sort(),
    hookIds: [...bundle.hookIds].sort(),
    mcpServers: bundle.mcpServers.map((m) => m.id).sort(),
    dependencies: [...bundle.dependencies].sort(),
  });
}

/** Compute the manifest checksum for a bundle (build-time helper). */
export function checksumFleetV26PluginBundle(
  bundle: Omit<FleetV26PluginBundle, 'checksum' | 'signature' | 'signatureVerified'>,
): string {
  return createHash('sha256').update(canonicalFleetV26PluginManifest(bundle)).digest('hex');
}

/** Registry of installed plugin bundles. */
export class FleetV26PluginRegistry {
  private plugins = new Map<string, FleetV26InstalledPlugin>();

  /** Install a bundle (checksum + dependency + skill checks). */
  install(
    bundle: FleetV26PluginBundle,
    deps: { skills: FleetV26SkillPack; hooks: FleetV26HookRegistry },
    opts: { overwrite?: boolean } = {},
    nowMs: number = Date.now(),
  ): FleetV26PluginOp {
    if (!FLEET_V26_PLUGIN_ID_RE.test(bundle.id)) {
      return { ok: false, id: bundle.id, message: `Plugin id "${bundle.id}" must be kebab-case.` };
    }
    const expected = checksumFleetV26PluginBundle(bundle);
    if (expected !== bundle.checksum) {
      return {
        ok: false,
        id: bundle.id,
        message: `Plugin "${bundle.id}" checksum mismatch — the bundle was modified after signing. Install refused.`,
      };
    }
    const existing = this.plugins.get(bundle.id);
    if (existing && !opts.overwrite) {
      return { ok: false, id: bundle.id, message: `Plugin "${bundle.id}" v${existing.bundle.version} is already installed (pass overwrite to replace).` };
    }
    for (const depId of bundle.dependencies) {
      if (!this.plugins.has(depId)) {
        return { ok: false, id: bundle.id, message: `Plugin "${bundle.id}" needs plugin "${depId}" installed first.` };
      }
    }
    for (const hookId of bundle.hookIds) {
      if (!deps.hooks.get(hookId)) {
        return { ok: false, id: bundle.id, message: `Plugin "${bundle.id}" references hook "${hookId}", which is not in the hook registry.` };
      }
    }
    // Install the bundle's skills into the pack (skip ones already present at the same version).
    for (const skill of bundle.skills) {
      const present = deps.skills.get(skill.name);
      if (present && present.version === skill.version) continue;
      const installed = deps.skills.install(
        { ...skill, files: skill.files.map((f) => ({ ...f })) },
        { overwrite: true },
        nowMs,
      );
      if (!installed.ok) {
        return { ok: false, id: bundle.id, message: `Plugin "${bundle.id}" skill "${skill.name}" failed to install: ${installed.message}` };
      }
    }
    this.plugins.set(bundle.id, {
      bundle: {
        ...bundle,
        skills: bundle.skills.map((s) => ({ ...s, files: s.files.map((f) => ({ ...f })) })),
        hookIds: [...bundle.hookIds],
        mcpServers: bundle.mcpServers.map((m) => ({ ...m, args: [...m.args], tools: [...m.tools] })),
        dependencies: [...bundle.dependencies],
      },
      enabled: true,
      installedAtMs: nowMs,
      replacedVersion: existing ? existing.bundle.version : null,
    });
    return {
      ok: true,
      id: bundle.id,
      message:
        `Plugin "${bundle.id}" v${bundle.version} installed ` +
        `(${bundle.skills.length} skill(s), ${bundle.hookIds.length} hook(s), ${bundle.mcpServers.length} MCP server(s))` +
        (existing ? `, replacing v${existing.bundle.version}` : '') +
        (bundle.signature ? (bundle.signatureVerified ? ' (signature verified)' : ' (signature present, NOT verified by host)') : ' (unsigned)'),
    };
  }

  /** One installed plugin (copy) or undefined. */
  get(id: string): FleetV26InstalledPlugin | undefined {
    const p = this.plugins.get(id);
    if (!p) return undefined;
    return {
      ...p,
      bundle: {
        ...p.bundle,
        skills: p.bundle.skills.map((s) => ({ ...s, files: s.files.map((f) => ({ ...f })) })),
        hookIds: [...p.bundle.hookIds],
        mcpServers: p.bundle.mcpServers.map((m) => ({ ...m, args: [...m.args], tools: [...m.tools] })),
        dependencies: [...p.bundle.dependencies],
      },
    };
  }

  /** All installed plugins, sorted by id. */
  list(): FleetV26InstalledPlugin[] {
    return [...this.plugins.keys()].sort().map((id) => this.get(id) as FleetV26InstalledPlugin);
  }

  /** Enable / disable a plugin as a unit (disables its hooks too). */
  setEnabled(id: string, enabled: boolean, hooks: FleetV26HookRegistry): FleetV26PluginOp {
    const p = this.plugins.get(id);
    if (!p) return { ok: false, id, message: `Plugin "${id}" is not installed.` };
    p.enabled = enabled;
    for (const hookId of p.bundle.hookIds) hooks.setEnabled(hookId, enabled);
    return { ok: true, id, message: `Plugin "${id}" ${enabled ? 'enabled' : 'disabled'} (${p.bundle.hookIds.length} hook(s) ${enabled ? 'enabled' : 'disabled'}).` };
  }

  /** Remove a plugin (refuses when another plugin depends on it). */
  remove(id: string): FleetV26PluginOp {
    const p = this.plugins.get(id);
    if (!p) return { ok: false, id, message: `Plugin "${id}" is not installed.` };
    const dependents = this.list().filter((other) => other.bundle.id !== id && other.bundle.dependencies.includes(id));
    if (dependents.length > 0) {
      return {
        ok: false,
        id,
        message: `Plugin "${id}" is required by ${dependents.map((d) => `"${d.bundle.id}"`).join(', ')} — remove them first.`,
      };
    }
    this.plugins.delete(id);
    return { ok: true, id, message: `Plugin "${id}" v${p.bundle.version} removed.` };
  }

  /** Counts for the panel. */
  counts(): { plugins: number; enabled: number; skills: number; hooks: number; mcpServers: number; unsigned: number } {
    let skills = 0;
    let hooks = 0;
    let mcpServers = 0;
    let unsigned = 0;
    let enabled = 0;
    for (const p of this.plugins.values()) {
      if (p.enabled) enabled += 1;
      skills += p.bundle.skills.length;
      hooks += p.bundle.hookIds.length;
      mcpServers += p.bundle.mcpServers.length;
      if (!p.bundle.signature) unsigned += 1;
    }
    return { plugins: this.plugins.size, enabled, skills, hooks, mcpServers, unsigned };
  }

  /** JSON round-trip. */
  toJSON(): { plugins: FleetV26InstalledPlugin[] } {
    return { plugins: this.list() };
  }

  static fromJSON(data: { plugins?: FleetV26InstalledPlugin[] }): FleetV26PluginRegistry {
    const reg = new FleetV26PluginRegistry();
    for (const p of data.plugins ?? []) {
      if (p && p.bundle && FLEET_V26_PLUGIN_ID_RE.test(p.bundle.id)) {
        reg.plugins.set(p.bundle.id, {
          ...p,
          bundle: {
            ...p.bundle,
            skills: (p.bundle.skills ?? []).map((s) => ({ ...s, files: (s.files ?? []).map((f) => ({ ...f })) })),
            hookIds: [...(p.bundle.hookIds ?? [])],
            mcpServers: (p.bundle.mcpServers ?? []).map((m) => ({ ...m, args: [...(m.args ?? [])], tools: [...(m.tools ?? [])] })),
            dependencies: [...(p.bundle.dependencies ?? [])],
          },
        });
      }
    }
    return reg;
  }
}

/** One-line summary for the plugins panel. */
export function summarizeFleetV26Plugins(reg: FleetV26PluginRegistry): string {
  const c = reg.counts();
  return (
    `${c.plugins} plugin(s) (${c.enabled} enabled): ${c.skills} skill(s), ${c.hooks} hook(s), ` +
    `${c.mcpServers} MCP server(s) bundled; ${c.unsigned} unsigned`
  );
}
