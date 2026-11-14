/**
 * Composio trigger → internal-action mapping (v1.08, Đội T4).
 *
 * The webhook side (triggers.ts) only RECEIVES events and verifies
 * them; the automation scheduler only runs automations whose
 * `triggerSlug` matches. This module is the configurable MIDDLE:
 * a user-editable table that says "when Composio trigger X fires, do
 * internal action Y" — without touching code or the Composio
 * dashboard.
 *
 * Actions (all local-first, all explicit):
 * - `automation` — run the automation with this id (the scheduler
 *   already knows how to run it; the mapping only names it).
 * - `tool` — call an internal open-bot tool by name with the given
 *   args (the agent core resolves the tool; unknown tool names fail
 *   at resolve time, never silently).
 * - `notify` — produce a notification text from a template
 *   (`{field}` placeholders are filled from the event payload;
 *   `{triggerSlug}` is always available).
 *
 * Rules:
 * - Trigger slugs must have the right SHAPE (`^[A-Z][A-Z0-9_]{2,}$`,
 *   same as triggers.ts). A slug outside the curated picker list is
 *   ALLOWED (the catalog has 447 trigger types; the picker is a
 *   subset) — `resolve()` reports `knownSlug: false` for those so the
 *   UI can warn, but the mapping still works.
 * - An exact duplicate (same trigger slug + action kind + target)
 *   is rejected — a doubled mapping would run the same action twice
 *   per event.
 * - Only ENABLED mappings resolve. Disabling is the safe way to pause
 *   a mapping without deleting it.
 * - Mappings persist to a JSON file when `file` is given (same shape
 *   as the other Composio JSON stores); without it the store is
 *   memory-only (tests, or a host that persists elsewhere). A corrupt
 *   or wrong-shaped file loads as empty — never crashes startup.
 * - This module never creates trigger instances in Composio and never
 *   calls Composio: the user still creates triggers in the Composio
 *   dashboard (see triggers.ts header). It only decides what open-bot
 *   DOES when an event arrives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findComposioTriggerDef, isKnownComposioTriggerSlug, isValidComposioTriggerSlug } from './triggers';

/** What a trigger event can turn into inside open-bot. */
export type ComposioTriggerActionKind = 'automation' | 'tool' | 'notify';

/** One mapping row: a trigger slug → one internal action. */
export interface ComposioTriggerMapping {
  /** Stable id (`map_<uuid>`). */
  id: string;
  /** Composio trigger slug, e.g. 'GMAIL_NEW_GMAIL_MESSAGE'. */
  triggerSlug: string;
  /** What kind of internal action this mapping runs. */
  actionKind: ComposioTriggerActionKind;
  /**
   * Action target: automation id (`automation`), internal tool name
   * (`tool`, snake_case), or notification template (`notify`).
   */
  target: string;
  /** Fixed args merged into a `tool` call (ignored for other kinds). */
  args?: Record<string, unknown>;
  /** Disabled mappings never resolve (pause without deleting). */
  enabled: boolean;
  /** Human note (shown in the UI picker). */
  description?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Input for creating a mapping (id + timestamps are assigned). */
export interface ComposioTriggerMappingInput {
  triggerSlug: string;
  actionKind: ComposioTriggerActionKind;
  target: string;
  args?: Record<string, unknown>;
  enabled?: boolean;
  description?: string;
}

/** Patch for updating a mapping (id + triggerSlug are immutable). */
export interface ComposioTriggerMappingPatch {
  actionKind?: ComposioTriggerActionKind;
  target?: string;
  args?: Record<string, unknown>;
  enabled?: boolean;
  description?: string;
}

/** A resolved action: what the host should do for one event. */
export interface ComposioResolvedTriggerAction {
  mappingId: string;
  triggerSlug: string;
  /** True when the slug is in the curated picker list. */
  knownSlug: boolean;
  actionKind: ComposioTriggerActionKind;
  target: string;
  args?: Record<string, unknown>;
  /** Rendered text for `notify` actions (template already filled). */
  text?: string;
  description?: string;
}

/** Result of resolving one trigger event against the mapping table. */
export interface ComposioTriggerResolveResult {
  triggerSlug: string;
  knownSlug: boolean;
  actions: ComposioResolvedTriggerAction[];
}

/** One trigger event as the resolver sees it (subset of ComposioTriggerEvent). */
export interface ComposioTriggerMappingEvent {
  triggerSlug: string;
  /** Event payload (`data` of the V3 envelope) — feeds `{placeholders}`. */
  data?: Record<string, unknown>;
}

export const COMPOSIO_TRIGGER_MAPPINGS_FILE = 'composio-trigger-mappings.json';
export const COMPOSIO_TRIGGER_MAPPINGS_VERSION = 1;
/** Longest allowed notify template (prevents a pasted novel). */
export const COMPOSIO_TRIGGER_MAPPING_MAX_TARGET_CHARS = 2000;
/** Longest allowed human description. */
export const COMPOSIO_TRIGGER_MAPPING_MAX_DESCRIPTION_CHARS = 500;

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a mapping input. Returns error messages (empty = valid).
 * `existing` is used for the duplicate check (pass the store's other
 * mappings; the caller excludes the mapping being updated).
 */
export function validateComposioTriggerMapping(
  input: ComposioTriggerMappingInput,
  existing: readonly ComposioTriggerMapping[] = [],
): string[] {
  const errors: string[] = [];
  if (!isValidComposioTriggerSlug(input.triggerSlug)) {
    errors.push(
      `triggerSlug "${String(input.triggerSlug)}" is invalid — use uppercase letters, digits and underscores (e.g. GMAIL_NEW_GMAIL_MESSAGE).`,
    );
  }
  if (input.actionKind !== 'automation' && input.actionKind !== 'tool' && input.actionKind !== 'notify') {
    errors.push(`actionKind must be 'automation', 'tool' or 'notify', got "${String(input.actionKind)}".`);
  }
  if (typeof input.target !== 'string' || input.target.trim() === '') {
    errors.push('target must be a non-empty string.');
  } else {
    if (input.target.length > COMPOSIO_TRIGGER_MAPPING_MAX_TARGET_CHARS) {
      errors.push(`target is too long (max ${COMPOSIO_TRIGGER_MAPPING_MAX_TARGET_CHARS} characters).`);
    }
    if (input.actionKind === 'tool' && !TOOL_NAME_RE.test(input.target.trim())) {
      errors.push(
        `tool target "${input.target}" is not a valid internal tool name (lowercase snake_case, e.g. send_message).`,
      );
    }
  }
  if (input.args !== undefined && !isRecord(input.args)) {
    errors.push('args must be a plain object when given.');
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' || input.description.length > COMPOSIO_TRIGGER_MAPPING_MAX_DESCRIPTION_CHARS)
  ) {
    errors.push(`description must be a string of at most ${COMPOSIO_TRIGGER_MAPPING_MAX_DESCRIPTION_CHARS} characters.`);
  }
  if (errors.length === 0) {
    const duplicate = existing.find(
      (m) =>
        m.triggerSlug === input.triggerSlug &&
        m.actionKind === input.actionKind &&
        m.target === input.target.trim(),
    );
    if (duplicate) {
      errors.push(
        `a mapping for ${input.triggerSlug} → ${input.actionKind}:${input.target.trim()} already exists (${duplicate.id}).`,
      );
    }
  }
  return errors;
}

/** Validate + normalise one raw mapping read from disk (null = drop it). */
export function resolveComposioTriggerMapping(raw: unknown): ComposioTriggerMapping | null {
  if (!isRecord(raw)) return null;
  const triggerSlug = raw.triggerSlug;
  const actionKind = raw.actionKind;
  const target = raw.target;
  if (!isValidComposioTriggerSlug(triggerSlug)) return null;
  if (actionKind !== 'automation' && actionKind !== 'tool' && actionKind !== 'notify') return null;
  if (typeof target !== 'string' || target.trim() === '') return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const createdAtMs =
    typeof raw.createdAtMs === 'number' && Number.isFinite(raw.createdAtMs) ? Math.floor(raw.createdAtMs) : 0;
  const updatedAtMs =
    typeof raw.updatedAtMs === 'number' && Number.isFinite(raw.updatedAtMs) ? Math.floor(raw.updatedAtMs) : createdAtMs;
  const mapping: ComposioTriggerMapping = {
    id: raw.id,
    triggerSlug,
    actionKind,
    target: target.trim(),
    enabled: raw.enabled !== false,
    createdAtMs,
    updatedAtMs,
  };
  if (isRecord(raw.args)) mapping.args = { ...raw.args };
  if (typeof raw.description === 'string' && raw.description !== '') {
    mapping.description = raw.description.slice(0, COMPOSIO_TRIGGER_MAPPING_MAX_DESCRIPTION_CHARS);
  }
  return mapping;
}

/**
 * Fill `{placeholders}` in a notify template from event data.
 * Unknown placeholders are left as-is (visible, not silently empty);
 * values are stringified (objects become compact JSON). `{triggerSlug}`
 * is always available.
 */
export function renderComposioTriggerTemplate(
  template: string,
  event: ComposioTriggerMappingEvent,
): string {
  const data = event.data ?? {};
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (whole, key: string) => {
    if (key === 'triggerSlug') return event.triggerSlug;
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (isRecord(acc)) return acc[part];
      return undefined;
    }, data);
    if (value === undefined || value === null) return whole;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value) ?? whole;
    } catch {
      return whole;
    }
  });
}

export interface ComposioTriggerMappingStoreOptions {
  /** JSON file to persist to (undefined = memory-only store). */
  file?: string;
  /** Clock, injectable for tests (defaults to Date.now). */
  now?: () => number;
}

export class ComposioTriggerMappingStore {
  private readonly file?: string;
  private readonly now: () => number;
  private readonly mappings = new Map<string, ComposioTriggerMapping>();

  constructor(options: ComposioTriggerMappingStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    if (this.file) this.loadFromFile();
  }

  /** Create a mapping (throws on invalid input or duplicate). */
  create(input: ComposioTriggerMappingInput): ComposioTriggerMapping {
    const errors = validateComposioTriggerMapping(input, [...this.mappings.values()]);
    if (errors.length > 0) {
      throw new Error(`Invalid trigger mapping: ${errors.join(' ')}`);
    }
    const at = this.now();
    const mapping: ComposioTriggerMapping = {
      id: `map_${randomUUID()}`,
      triggerSlug: input.triggerSlug,
      actionKind: input.actionKind,
      target: input.target.trim(),
      enabled: input.enabled !== false,
      createdAtMs: at,
      updatedAtMs: at,
    };
    if (input.args !== undefined) mapping.args = { ...input.args };
    if (input.description !== undefined && input.description !== '') {
      mapping.description = input.description;
    }
    this.mappings.set(mapping.id, mapping);
    this.saveToFile();
    return { ...mapping, args: mapping.args ? { ...mapping.args } : undefined };
  }

  /** Update a mapping (throws on unknown id, invalid patch or duplicate). */
  update(id: string, patch: ComposioTriggerMappingPatch): ComposioTriggerMapping {
    const existing = this.mappings.get(id);
    if (!existing) throw new Error(`Unknown trigger mapping: ${id}`);
    const merged: ComposioTriggerMappingInput = {
      triggerSlug: existing.triggerSlug,
      actionKind: patch.actionKind ?? existing.actionKind,
      target: patch.target ?? existing.target,
      args: patch.args ?? existing.args,
      enabled: patch.enabled ?? existing.enabled,
      description: patch.description ?? existing.description,
    };
    const others = [...this.mappings.values()].filter((m) => m.id !== id);
    const errors = validateComposioTriggerMapping(merged, others);
    if (errors.length > 0) {
      throw new Error(`Invalid trigger mapping: ${errors.join(' ')}`);
    }
    const updated: ComposioTriggerMapping = {
      ...existing,
      actionKind: merged.actionKind,
      target: merged.target.trim(),
      enabled: merged.enabled !== false,
      updatedAtMs: this.now(),
    };
    if (merged.args !== undefined) updated.args = { ...merged.args };
    else delete updated.args;
    if (merged.description !== undefined && merged.description !== '') updated.description = merged.description;
    else delete updated.description;
    this.mappings.set(id, updated);
    this.saveToFile();
    return { ...updated, args: updated.args ? { ...updated.args } : undefined };
  }

  /** Delete a mapping. Returns false when the id was unknown. */
  remove(id: string): boolean {
    const removed = this.mappings.delete(id);
    if (removed) this.saveToFile();
    return removed;
  }

  /** One mapping by id (copy), or undefined. */
  get(id: string): ComposioTriggerMapping | undefined {
    const found = this.mappings.get(id);
    return found ? { ...found, args: found.args ? { ...found.args } : undefined } : undefined;
  }

  /** All mappings, oldest first (copies). */
  list(): ComposioTriggerMapping[] {
    return [...this.mappings.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((m) => ({ ...m, args: m.args ? { ...m.args } : undefined }));
  }

  /** Enabled mappings for one trigger slug (creation order). */
  listEnabledFor(triggerSlug: string): ComposioTriggerMapping[] {
    return this.list().filter((m) => m.triggerSlug === triggerSlug && m.enabled);
  }

  /** Number of mappings (enabled + disabled). */
  count(): number {
    return this.mappings.size;
  }

  /**
   * Resolve one trigger event to the actions the host should run.
   * Only ENABLED mappings resolve; actions keep creation order.
   * `knownSlug` tells the caller whether the slug is in the curated
   * picker list (false = valid shape, uncurated catalog slug).
   */
  resolve(event: ComposioTriggerMappingEvent): ComposioTriggerResolveResult {
    const triggerSlug = event.triggerSlug;
    const knownSlug = isKnownComposioTriggerSlug(triggerSlug);
    const actions: ComposioResolvedTriggerAction[] = [];
    for (const mapping of this.listEnabledFor(triggerSlug)) {
      const action: ComposioResolvedTriggerAction = {
        mappingId: mapping.id,
        triggerSlug,
        knownSlug,
        actionKind: mapping.actionKind,
        target: mapping.target,
      };
      if (mapping.args !== undefined) action.args = { ...mapping.args };
      if (mapping.description !== undefined) action.description = mapping.description;
      if (mapping.actionKind === 'notify') {
        action.text = renderComposioTriggerTemplate(mapping.target, event);
      }
      actions.push(action);
    }
    return { triggerSlug, knownSlug, actions };
  }

  /** Curated trigger definition for a slug (picker help), or undefined. */
  describeTrigger(triggerSlug: string): ReturnType<typeof findComposioTriggerDef> {
    return findComposioTriggerDef(triggerSlug);
  }

  /** Export all mappings as a plain JSON-able document (for backup/UI). */
  exportMappings(): { version: number; mappings: ComposioTriggerMapping[] } {
    return { version: COMPOSIO_TRIGGER_MAPPINGS_VERSION, mappings: this.list() };
  }

  /**
   * Import mappings from an exported document. Invalid rows are
   * skipped (counted in `skipped`); duplicates are skipped too.
   * With `replace: true` the current table is cleared first.
   */
  importMappings(
    raw: unknown,
    options: { replace?: boolean } = {},
  ): { imported: number; skipped: number } {
    if (!isRecord(raw) || !Array.isArray(raw.mappings)) {
      throw new Error('importMappings needs an exported document ({ mappings: [...] }).');
    }
    if (options.replace) {
      this.mappings.clear();
    }
    let imported = 0;
    let skipped = 0;
    for (const row of raw.mappings as unknown[]) {
      const mapping = resolveComposioTriggerMapping(row);
      if (!mapping) {
        skipped += 1;
        continue;
      }
      const duplicate = [...this.mappings.values()].some(
        (m) =>
          m.triggerSlug === mapping.triggerSlug &&
          m.actionKind === mapping.actionKind &&
          m.target === mapping.target,
      );
      if (duplicate || this.mappings.has(mapping.id)) {
        skipped += 1;
        continue;
      }
      this.mappings.set(mapping.id, mapping);
      imported += 1;
    }
    this.saveToFile();
    return { imported, skipped };
  }

  private loadFromFile(): void {
    if (!this.file) return;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.mappings)) return;
    for (const row of parsed.mappings as unknown[]) {
      const mapping = resolveComposioTriggerMapping(row);
      if (mapping && !this.mappings.has(mapping.id)) this.mappings.set(mapping.id, mapping);
    }
  }

  private saveToFile(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.exportMappings(), null, 2), 'utf8');
    } catch {
      // Persistence is best-effort: a failed write must not break the
      // mapping operation that just succeeded in memory.
    }
  }
}
