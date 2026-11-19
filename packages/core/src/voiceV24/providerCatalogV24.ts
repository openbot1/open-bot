/**
 * Dynamic provider / model catalogue for voice v24 (v1.37, Team T5).
 *
 * The old model picker rendered a hard-coded list. v24's picker
 * renders whatever this catalogue holds *at the moment it
 * opens* — and the catalogue starts EMPTY. The host registers
 * one descriptor per provider it actually detected (a CLI
 * login, an API key in the Vault, a local model, a custom
 * endpoint), together with the probe result it measured
 * (reachable? how slow?). Nothing here invents a provider:
 * a provider that was never registered simply does not
 * appear, and a provider whose key was never configured
 * shows as `unconfigured` instead of a fake "online".
 *
 * Status derivation (one rule, in `deriveProviderStatusV24`):
 * unconfigured -> unknown (never probed / probe stale) ->
 * offline (last probe failed) -> degraded (probe latency
 * over the degraded threshold) -> online.
 *
 * All data is caller-supplied; this module never dials a
 * provider, never reads a key, never opens a socket.
 */
import {
  deriveProviderStatusV24,
  round2V24,
  VOICE_V24_DEGRADED_LATENCY_DEFAULT_MS,
  VOICE_V24_STALE_AFTER_DEFAULT_MS,
  type VoiceV24ModelInfo,
  type VoiceV24ModelRef,
  type VoiceV24ProviderKind,
  type VoiceV24ProviderStatus,
} from './types';

/** A provider as the host detected it — the unit the picker lists. */
export interface VoiceV24ProviderDescriptor {
  /** Stable id, e.g. "codex", "claude-code", "openai", "ollama". */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  kind: VoiceV24ProviderKind;
  /** Models this provider offers right now (may be empty). */
  models: VoiceV24ModelInfo[];
  /** True when the host has what this provider needs (login / key / binary). */
  configured: boolean;
  /** Account label from the detector ("user@example.com") — never a secret. */
  accountLabel?: string;
  /** Where the descriptor came from: CLI login, Vault key, local scan, custom. */
  source: 'cli' | 'api-key' | 'local' | 'custom';
}

/** One provider as the picker renders it, status included. */
export interface VoiceV24ProviderSnapshot {
  id: string;
  label: string;
  kind: VoiceV24ProviderKind;
  status: VoiceV24ProviderStatus;
  models: VoiceV24ModelInfo[];
  configured: boolean;
  accountLabel?: string;
  source: 'cli' | 'api-key' | 'local' | 'custom';
  lastProbeAtMs: number | null;
  lastProbeOk: boolean | null;
  lastProbeLatencyMs: number | null;
  lastProbeError?: string;
  /** True when the provider has at least one non-deprecated model. */
  hasUsableModel: boolean;
}

/** Result of probing one provider (host-measured, passed in). */
export interface VoiceV24ProbeResult {
  providerId: string;
  atMs: number;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface DynamicProviderCatalogV24Options {
  /** A probe older than this makes the status `unknown` (default 60000 ms). */
  staleAfterMs: number;
  /** Probe latency above this makes the status `degraded` (default 2000 ms). */
  degradedLatencyMs: number;
}

export function defaultDynamicProviderCatalogV24Options(): DynamicProviderCatalogV24Options {
  return {
    staleAfterMs: VOICE_V24_STALE_AFTER_DEFAULT_MS,
    degradedLatencyMs: VOICE_V24_DEGRADED_LATENCY_DEFAULT_MS,
  };
}

export function validateDynamicProviderCatalogV24Options(
  o: Partial<DynamicProviderCatalogV24Options>,
): string[] {
  const errors: string[] = [];
  if (o.staleAfterMs !== undefined && !(o.staleAfterMs > 0 && o.staleAfterMs <= 3600000)) {
    errors.push('staleAfterMs must be > 0 and <= 3600000');
  }
  if (o.degradedLatencyMs !== undefined && !(o.degradedLatencyMs > 0 && o.degradedLatencyMs <= 60000)) {
    errors.push('degradedLatencyMs must be > 0 and <= 60000');
  }
  return errors;
}

/** Validate one descriptor; returns error strings (empty = valid). */
export function validateProviderDescriptorV24(d: VoiceV24ProviderDescriptor): string[] {
  const errors: string[] = [];
  if (typeof d.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(d.id)) {
    errors.push('id must be a non-empty id (letters/digits/_/-)');
  }
  if (typeof d.label !== 'string' || d.label.trim().length === 0) errors.push('label must be non-empty');
  const kinds: readonly string[] = ['subscription', 'api', 'custom', 'local'];
  if (!kinds.includes(d.kind)) errors.push(`kind must be one of ${kinds.join(', ')}`);
  const sources: readonly string[] = ['cli', 'api-key', 'local', 'custom'];
  if (!sources.includes(d.source)) errors.push(`source must be one of ${sources.join(', ')}`);
  if (!Array.isArray(d.models)) {
    errors.push('models must be an array');
  } else {
    const seen = new Set<string>();
    for (const m of d.models) {
      if (typeof m.id !== 'string' || m.id.length === 0) errors.push('every model needs a non-empty id');
      if (seen.has(m.id)) errors.push(`duplicate model id "${m.id}"`);
      seen.add(m.id);
      if (m.contextWindow !== undefined && !(Number.isInteger(m.contextWindow) && m.contextWindow > 0)) {
        errors.push(`model "${m.id}" contextWindow must be a positive integer`);
      }
    }
  }
  if (typeof d.configured !== 'boolean') errors.push('configured must be a boolean');
  if (d.accountLabel !== undefined && typeof d.accountLabel !== 'string') {
    errors.push('accountLabel must be a string');
  }
  return errors;
}

/** Build a descriptor with the common fields defaulted; validates before returning. */
export function providerDescriptorV24(
  partial: Omit<VoiceV24ProviderDescriptor, 'models' | 'configured' | 'source'> &
    Partial<Pick<VoiceV24ProviderDescriptor, 'models' | 'configured' | 'source'>>,
): VoiceV24ProviderDescriptor {
  const descriptor: VoiceV24ProviderDescriptor = {
    models: [],
    configured: false,
    source: 'custom',
    ...partial,
  };
  const errors = validateProviderDescriptorV24(descriptor);
  if (errors.length > 0) throw new Error(`Invalid provider descriptor: ${errors.join('; ')}`);
  return descriptor;
}

export function createDynamicProviderCatalogV24(
  opts: Partial<DynamicProviderCatalogV24Options> = {},
): DynamicProviderCatalogV24 {
  return new DynamicProviderCatalogV24(opts);
}

/**
 * The live catalogue. Starts empty on purpose: the host
 * registers what it detected, and the picker renders exactly
 * that — no provider is ever assumed to exist.
 */
export class DynamicProviderCatalogV24 {
  private readonly opts: DynamicProviderCatalogV24Options;
  private readonly providers = new Map<string, VoiceV24ProviderDescriptor>();
  private readonly probes = new Map<
    string,
    { atMs: number; ok: boolean; latencyMs: number | null; error?: string }
  >();
  private updatedAtMs = 0;

  constructor(opts: Partial<DynamicProviderCatalogV24Options> = {}) {
    const errors = validateDynamicProviderCatalogV24Options(opts);
    if (errors.length > 0) {
      throw new Error(`Invalid DynamicProviderCatalogV24 options: ${errors.join('; ')}`);
    }
    this.opts = { ...defaultDynamicProviderCatalogV24Options(), ...opts };
  }

  options(): DynamicProviderCatalogV24Options {
    return { ...this.opts };
  }

  /** Register (or replace) one provider descriptor. */
  register(descriptor: VoiceV24ProviderDescriptor, atMs = 0): void {
    const errors = validateProviderDescriptorV24(descriptor);
    if (errors.length > 0) throw new Error(`Invalid provider descriptor: ${errors.join('; ')}`);
    this.providers.set(descriptor.id, {
      ...descriptor,
      models: descriptor.models.map((m) => ({ ...m })),
    });
    this.updatedAtMs = Math.max(this.updatedAtMs, atMs);
  }

  /** Remove a provider (and its probe history). True when it existed. */
  remove(providerId: string): boolean {
    this.probes.delete(providerId);
    return this.providers.delete(providerId);
  }

  /** Record one host-measured probe result for a provider. */
  recordProbe(result: VoiceV24ProbeResult): void {
    if (!this.providers.has(result.providerId)) {
      throw new Error(`Unknown provider "${result.providerId}" — register it first`);
    }
    if (!Number.isFinite(result.atMs) || result.atMs < 0) {
      throw new Error('probe atMs must be a finite number >= 0');
    }
    if (result.latencyMs !== undefined && !(result.latencyMs >= 0 && Number.isFinite(result.latencyMs))) {
      throw new Error('probe latencyMs must be >= 0');
    }
    this.probes.set(result.providerId, {
      atMs: result.atMs,
      ok: result.ok,
      latencyMs: result.latencyMs ?? null,
      error: result.error,
    });
    this.updatedAtMs = Math.max(this.updatedAtMs, result.atMs);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  get(providerId: string): VoiceV24ProviderDescriptor | null {
    const d = this.providers.get(providerId);
    return d === undefined
      ? null
      : { ...d, models: d.models.map((m) => ({ ...m })) };
  }

  ids(): string[] {
    return [...this.providers.keys()].sort();
  }

  count(): number {
    return this.providers.size;
  }

  updatedAt(): number {
    return this.updatedAtMs;
  }

  /** Status of one provider at `nowMs` (defaults to the last probe time). */
  statusOf(providerId: string, nowMs?: number): VoiceV24ProviderStatus {
    const descriptor = this.providers.get(providerId);
    if (descriptor === undefined) throw new Error(`Unknown provider "${providerId}"`);
    const probe = this.probes.get(providerId);
    const now = nowMs ?? probe?.atMs ?? 0;
    return deriveProviderStatusV24({
      configured: descriptor.configured,
      everProbed: probe !== undefined,
      lastProbeOk: probe?.ok ?? false,
      lastProbeAtMs: probe?.atMs ?? null,
      lastProbeLatencyMs: probe?.latencyMs ?? null,
      nowMs: now,
      staleAfterMs: this.opts.staleAfterMs,
      degradedLatencyMs: this.opts.degradedLatencyMs,
    });
  }

  /** One provider as the picker renders it. */
  snapshot(providerId: string, nowMs?: number): VoiceV24ProviderSnapshot {
    const descriptor = this.providers.get(providerId);
    if (descriptor === undefined) throw new Error(`Unknown provider "${providerId}"`);
    const probe = this.probes.get(providerId);
    return {
      id: descriptor.id,
      label: descriptor.label,
      kind: descriptor.kind,
      status: this.statusOf(providerId, nowMs),
      models: descriptor.models.map((m) => ({ ...m })),
      configured: descriptor.configured,
      accountLabel: descriptor.accountLabel,
      source: descriptor.source,
      lastProbeAtMs: probe?.atMs ?? null,
      lastProbeOk: probe?.ok ?? null,
      lastProbeLatencyMs: probe?.latencyMs ?? null,
      lastProbeError: probe?.error,
      hasUsableModel: descriptor.models.some((m) => !m.deprecated),
    };
  }

  /** All providers, online first, then degraded, unknown, offline, unconfigured. */
  list(nowMs?: number): VoiceV24ProviderSnapshot[] {
    const rank: Record<VoiceV24ProviderStatus, number> = {
      online: 0,
      degraded: 1,
      unknown: 2,
      offline: 3,
      unconfigured: 4,
    };
    return this.ids()
      .map((id) => this.snapshot(id, nowMs))
      .sort((a, b) => rank[a.status] - rank[b.status] || a.label.localeCompare(b.label));
  }

  /** Providers the picker can actually select from right now. */
  usable(nowMs?: number): VoiceV24ProviderSnapshot[] {
    return this.list(nowMs).filter(
      (s) => (s.status === 'online' || s.status === 'degraded') && s.hasUsableModel,
    );
  }

  /** Models of one provider, non-deprecated first, then by id. */
  modelsFor(providerId: string): VoiceV24ModelInfo[] {
    const descriptor = this.providers.get(providerId);
    if (descriptor === undefined) throw new Error(`Unknown provider "${providerId}"`);
    return [...descriptor.models]
      .sort((a, b) => Number(a.deprecated ?? false) - Number(b.deprecated ?? false) || a.id.localeCompare(b.id))
      .map((m) => ({ ...m }));
  }

  /** Find one model; null when the provider or the model is unknown. */
  findModel(ref: VoiceV24ModelRef): VoiceV24ModelInfo | null {
    const descriptor = this.providers.get(ref.providerId);
    if (descriptor === undefined) return null;
    const model = descriptor.models.find((m) => m.id === ref.model);
    return model === undefined ? null : { ...model };
  }

  /** True when the ref names a registered, non-deprecated model. */
  hasModel(ref: VoiceV24ModelRef): boolean {
    const model = this.findModel(ref);
    return model !== null && !model.deprecated;
  }

  /** Counts by status — the picker's summary line. */
  counts(nowMs?: number): Record<VoiceV24ProviderStatus, number> & { total: number } {
    const out: Record<VoiceV24ProviderStatus, number> & { total: number } = {
      online: 0,
      offline: 0,
      unconfigured: 0,
      degraded: 0,
      unknown: 0,
      total: this.providers.size,
    };
    for (const snapshot of this.list(nowMs)) out[snapshot.status] += 1;
    return out;
  }

  /** Providers whose probe is stale or missing at `nowMs` — the host should re-probe them. */
  needsProbe(nowMs: number): string[] {
    const out: string[] = [];
    for (const id of this.ids()) {
      const probe = this.probes.get(id);
      if (probe === undefined || nowMs - probe.atMs > this.opts.staleAfterMs) out.push(id);
    }
    return out;
  }

  /** Mean probe latency across providers that answered, ms (0 when none). */
  meanProbeLatencyMs(): number {
    const latencies: number[] = [];
    for (const probe of this.probes.values()) {
      if (probe.ok && probe.latencyMs !== null) latencies.push(probe.latencyMs);
    }
    if (latencies.length === 0) return 0;
    return round2V24(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  }

  reset(): void {
    this.providers.clear();
    this.probes.clear();
    this.updatedAtMs = 0;
  }

  summary(nowMs?: number): string {
    const counts = this.counts(nowMs);
    const usable = this.usable(nowMs).length;
    return (
      `${counts.total} providers (${counts.online} online, ${counts.degraded} degraded, ` +
      `${counts.offline} offline, ${counts.unconfigured} unconfigured, ${counts.unknown} unknown), ` +
      `${usable} usable, mean probe latency ${this.meanProbeLatencyMs()}ms.`
    );
  }

  markdown(nowMs?: number): string {
    const lines: string[] = ['# Voice v24 dynamic providers', '', this.summary(nowMs), ''];
    lines.push('| Provider | Kind | Status | Models | Account |');
    lines.push('| --- | --- | --- | ---: | --- |');
    for (const s of this.list(nowMs)) {
      lines.push(
        `| ${s.label} (${s.id}) | ${s.kind} | ${s.status} | ${s.models.length} | ${s.accountLabel ?? '—'} |`,
      );
    }
    return lines.join('\n');
  }
}
