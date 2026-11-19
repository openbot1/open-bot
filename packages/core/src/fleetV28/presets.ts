/**
 * Runtime + budget presets per profile (v1.41, Team T6) — fleet v28.
 *
 * OpenHands Canvas 1.38 (survey `docs/repo-survey-v141.md` §3)
 * added prompt/plugin presets per agent profile. This module is
 * the open-bot equivalent for the fleet v28 runtime + budget:
 * a profile picks one named preset and gets a coherent bundle —
 * runtime limits (CPU/RAM/disk/timeout/idle) AND a conversation
 * budget cap — instead of tuning six numbers by hand.
 *
 * Presets are data, not policy: `applyFleetV28Preset` resolves a
 * preset name to concrete limits + cap; the caller still creates
 * the runtime / meter with those values, so a preset can never
 * bypass validation in `runtime.ts` / `budget.ts`. A profile's
 * preset choice is stored in `FleetV28PresetStore` (one preset
 * per profile; `custom` means the profile tuned values by hand
 * and the store keeps the last custom bundle for reference).
 *
 * Built-in presets:
 * - `small` — light work: 0.5 CPU, 512 MiB RAM, 1 GiB disk,
 *   10 min timeout, 5 min idle, $1 cap.
 * - `medium` — the default (matches `FLEET_V28_DEFAULT_RUNTIME_LIMITS`):
 *   1 CPU, 2 GiB RAM, 5 GiB disk, 30 min timeout, 15 min idle, $5 cap.
 * - `large` — heavy work: 2 CPU, 4 GiB RAM, 10 GiB disk,
 *   60 min timeout, 30 min idle, $20 cap.
 * - `custom` — hand-tuned values (no fixed bundle; the store
 *   records whatever the profile set last).
 */

import {
  FLEET_V28_DEFAULT_RUNTIME_LIMITS,
  resolveFleetV28RuntimeLimits,
  validateFleetV28RuntimeLimits,
  type FleetV28RuntimeLimits,
} from './runtime';

/** Preset names (built-ins + `custom`). */
export type FleetV28PresetName = 'small' | 'medium' | 'large' | 'custom';

/** One preset bundle: runtime limits + conversation budget cap. */
export interface FleetV28Preset {
  /** Preset name. */
  name: FleetV28PresetName;
  /** Short label (English; UI uses i18n keys). */
  label: string;
  /** One-line description (English). */
  description: string;
  /** Runtime limits the preset applies. */
  limits: FleetV28RuntimeLimits;
  /** Conversation budget cap, USD (null = no cap). */
  capUsd: number | null;
}

/** Built-in preset bundles (frozen data — never mutated). */
export const FLEET_V28_PRESETS: readonly FleetV28Preset[] = [
  {
    name: 'small',
    label: 'Small',
    description: 'Light work: quick answers, small tools, short sessions.',
    limits: {
      cpuCores: 0.5,
      ramMB: 512,
      diskMB: 1024,
      timeoutMs: 10 * 60 * 1000,
      idleTimeoutMs: 5 * 60 * 1000,
      maxRestarts: 2,
    },
    capUsd: 1,
  },
  {
    name: 'medium',
    label: 'Medium',
    description: 'Everyday work: the default runtime and budget.',
    limits: { ...FLEET_V28_DEFAULT_RUNTIME_LIMITS },
    capUsd: 5,
  },
  {
    name: 'large',
    label: 'Large',
    description: 'Heavy work: long runs, big repos, large tool calls.',
    limits: {
      cpuCores: 2,
      ramMB: 4096,
      diskMB: 10240,
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs: 30 * 60 * 1000,
      maxRestarts: 5,
    },
    capUsd: 20,
  },
];

/** Find a built-in preset by name (undefined for `custom` / unknown). */
export function findFleetV28Preset(name: string): FleetV28Preset | undefined {
  return FLEET_V28_PRESETS.find((p) => p.name === name);
}

/** List the built-in presets (copies). */
export function listFleetV28Presets(): FleetV28Preset[] {
  return FLEET_V28_PRESETS.map((p) => ({ ...p, limits: { ...p.limits } }));
}

/** true when the name is a built-in preset (`small`/`medium`/`large`). */
export function isFleetV28BuiltinPreset(name: string): boolean {
  return findFleetV28Preset(name) !== undefined;
}

/**
 * Resolve a preset name to its bundle. `custom` resolves to the
 * profile's stored custom bundle when one exists, otherwise to
 * the medium bundle (a custom preset with nothing customised yet
 * is just the default). Unknown names resolve to medium as well —
 * the caller can tell by `resolvedAs`.
 */
export function resolveFleetV28Preset(
  name: string,
  customBundle?: { limits: FleetV28RuntimeLimits; capUsd: number | null },
): { preset: FleetV28Preset; resolvedAs: FleetV28PresetName } {
  const builtin = findFleetV28Preset(name);
  if (builtin) {
    return { preset: { ...builtin, limits: { ...builtin.limits } }, resolvedAs: builtin.name };
  }
  if (name === 'custom' && customBundle) {
    return {
      preset: {
        name: 'custom',
        label: 'Custom',
        description: 'Hand-tuned limits and budget for this profile.',
        limits: { ...customBundle.limits },
        capUsd: customBundle.capUsd,
      },
      resolvedAs: 'custom',
    };
  }
  const medium = findFleetV28Preset('medium') as FleetV28Preset;
  return { preset: { ...medium, limits: { ...medium.limits } }, resolvedAs: 'medium' };
}

/** What a profile chose (preset name + the bundle it resolves to). */
export interface FleetV28ProfilePreset {
  /** Profile id. */
  profileId: string;
  /** Chosen preset name. */
  presetName: FleetV28PresetName;
  /** Custom bundle (only meaningful when presetName is `custom`). */
  customLimits: FleetV28RuntimeLimits | null;
  /** Custom cap (only meaningful when presetName is `custom`). */
  customCapUsd: number | null;
  /** When the choice was last changed, ms epoch. */
  updatedAtMs: number;
}

/**
 * Per-profile preset choices.
 *
 * One choice per profile; profiles never see each other's choices.
 * `setPreset` validates custom bundles with the same validator
 * the runtime store uses, so a stored custom preset can never be
 * applied to a runtime and fail there.
 */
export class FleetV28PresetStore {
  private readonly choices = new Map<string, FleetV28ProfilePreset>();

  /** A profile's preset choice (undefined = never chose; default medium). */
  getPreset(profileId: string): FleetV28ProfilePreset | undefined {
    const c = this.choices.get(profileId);
    return c ? { ...c, customLimits: c.customLimits ? { ...c.customLimits } : null } : undefined;
  }

  /** The bundle a profile currently resolves to (medium when never chose). */
  resolveForProfile(profileId: string): { preset: FleetV28Preset; resolvedAs: FleetV28PresetName } {
    const choice = this.choices.get(profileId);
    if (!choice) return resolveFleetV28Preset('medium');
    if (choice.presetName === 'custom' && choice.customLimits) {
      return resolveFleetV28Preset('custom', { limits: choice.customLimits, capUsd: choice.customCapUsd });
    }
    return resolveFleetV28Preset(choice.presetName);
  }

  /**
   * Set a profile's preset. Built-in names need no bundle; `custom`
   * needs a valid limits bundle (validated) and a cap (null or > 0).
   */
  setPreset(
    profileId: string,
    presetName: string,
    opts: {
      customLimits?: Partial<FleetV28RuntimeLimits>;
      customCapUsd?: number | null;
      nowMs?: number;
    } = {},
  ): { ok: boolean; choice?: FleetV28ProfilePreset; reasons?: string[] } {
    const nowMs = opts.nowMs ?? Date.now();
    const reasons: string[] = [];
    if (typeof profileId !== 'string' || profileId.trim() === '' || /\s/.test(profileId)) {
      reasons.push('profileId must be a non-empty id without whitespace.');
    }
    const builtin = findFleetV28Preset(presetName);
    if (!builtin && presetName !== 'custom') {
      reasons.push(`Unknown preset "${presetName}" (expected small|medium|large|custom).`);
    }
    let customLimits: FleetV28RuntimeLimits | null = null;
    let customCapUsd: number | null = null;
    if (presetName === 'custom') {
      customLimits = resolveFleetV28RuntimeLimits(opts.customLimits, FLEET_V28_DEFAULT_RUNTIME_LIMITS);
      reasons.push(...validateFleetV28RuntimeLimits(customLimits));
      customCapUsd = opts.customCapUsd ?? null;
      if (customCapUsd !== null && (typeof customCapUsd !== 'number' || !Number.isFinite(customCapUsd) || customCapUsd <= 0)) {
        reasons.push('customCapUsd must be null or a number > 0.');
      }
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const choice: FleetV28ProfilePreset = {
      profileId,
      presetName: (builtin ? builtin.name : 'custom') as FleetV28PresetName,
      customLimits,
      customCapUsd,
      updatedAtMs: nowMs,
    };
    this.choices.set(profileId, choice);
    return { ok: true, choice: this.getPreset(profileId) as FleetV28ProfilePreset };
  }

  /** Clear a profile's choice (falls back to medium). Returns false when none. */
  clearPreset(profileId: string): boolean {
    return this.choices.delete(profileId);
  }

  /** All profiles with a stored choice (sorted). */
  listProfiles(): string[] {
    return [...this.choices.keys()].sort();
  }

  /**
   * Compare two bundles: which preset is "bigger" (more CPU, then
   * more RAM, then more disk, then higher cap). Returns -1 / 0 / 1
   * (a < b, a == b, a > b). Used by the UI to order presets and by
   * the dashboard to summarise a profile's footprint.
   */
  static compareBundles(
    a: { limits: FleetV28RuntimeLimits; capUsd: number | null },
    b: { limits: FleetV28RuntimeLimits; capUsd: number | null },
  ): number {
    const keys: Array<'cpuCores' | 'ramMB' | 'diskMB'> = ['cpuCores', 'ramMB', 'diskMB'];
    for (const key of keys) {
      if (a.limits[key] !== b.limits[key]) return a.limits[key] < b.limits[key] ? -1 : 1;
    }
    const capA = a.capUsd ?? Number.POSITIVE_INFINITY;
    const capB = b.capUsd ?? Number.POSITIVE_INFINITY;
    if (capA !== capB) return capA < capB ? -1 : 1;
    return 0;
  }
}
