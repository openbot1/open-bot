/**
 * Mock provider registry v20 (voice v20, v1.28 Team T5).
 *
 * The realtime pipeline never talks to a real STT/TTS/speech-to-speech
 * service directly: it talks to a *provider slot* (stt / tts / s2s),
 * and the registry owns which concrete mock provider fills that slot.
 * Each provider is a small in-process mock with scripted behaviour —
 * latency, failure modes, quality score — so failover, health
 * degradation and recovery can be exercised deterministically without
 * a network, a key, or a sound card.
 *
 * A provider degrades after consecutive failures and is taken out of
 * rotation; the registry fails over to the next healthy provider of
 * the same kind and emits an event so the session can log it. A
 * background (virtual-clock) probe can bring a down provider back.
 * All clocks virtual, all audio mock/synthetic.
 */
import type { VoiceV20ProviderHealth, VoiceV20ProviderKind } from './types';

export type ProviderV20FailureMode =
  | 'timeout'
  | 'rate-limited'
  | 'bad-audio'
  | 'auth'
  | 'overloaded'
  | 'disconnected';

export type ProviderV20Capability =
  | 'streaming'
  | 'partials'
  | 'word-timestamps'
  | 'speaker-labels'
  | 'prosody'
  | 'barge-in'
  | 'low-latency'
  | 'multilingual';

export interface ProviderV20ScriptStep {
  /** Virtual ms after the call starts when this step fires. */
  atMs: number;
  /** What happens at this step. */
  outcome: 'ok' | 'fail';
  failureMode?: ProviderV20FailureMode;
  /** Latency (ms) reported for an ok step. */
  latencyMs?: number;
}

export interface MockProviderV20Config {
  id: string;
  kind: VoiceV20ProviderKind;
  label: string;
  /** Base quality 0..1: higher = preferred when all are healthy. */
  quality: number;
  /** Base latency the mock reports, in ms. */
  baseLatencyMs: number;
  capabilities: ProviderV20Capability[];
  /** Scripted outcomes; when exhausted the provider answers ok. */
  script: ProviderV20ScriptStep[];
  /** Failures in a row before the provider is marked degraded. */
  degradeAfterFailures: number;
  /** Failures in a row before the provider is marked down. */
  downAfterFailures: number;
}

export function defaultMockProviderV20Config(
  id: string,
  kind: VoiceV20ProviderKind,
): MockProviderV20Config {
  return {
    id,
    kind,
    label: id,
    quality: 0.8,
    baseLatencyMs: 120,
    capabilities: kind === 'stt'
      ? ['streaming', 'partials', 'word-timestamps']
      : kind === 'tts'
        ? ['streaming', 'prosody', 'low-latency']
        : ['streaming', 'partials', 'barge-in', 'low-latency'],
    script: [],
    degradeAfterFailures: 2,
    downAfterFailures: 4,
  };
}

export function validateMockProviderV20Config(o: Partial<MockProviderV20Config>): string[] {
  const e: string[] = [];
  if (o.id !== undefined && o.id.trim() === '') e.push('id must not be empty');
  if (o.quality !== undefined && (o.quality < 0 || o.quality > 1)) e.push('quality must be 0..1');
  if (o.baseLatencyMs !== undefined && o.baseLatencyMs < 0) e.push('baseLatencyMs must be >= 0');
  if (o.degradeAfterFailures !== undefined && o.degradeAfterFailures < 1) e.push('degradeAfterFailures must be >= 1');
  if (o.downAfterFailures !== undefined && o.downAfterFailures < 1) e.push('downAfterFailures must be >= 1');
  if (o.degradeAfterFailures !== undefined && o.downAfterFailures !== undefined
    && o.downAfterFailures < o.degradeAfterFailures) {
    e.push('downAfterFailures must be >= degradeAfterFailures');
  }
  if (o.script !== undefined) {
    for (const [i, s] of o.script.entries()) {
      if (s.atMs < 0) e.push(`script[${i}].atMs must be >= 0`);
      if (s.outcome === 'fail' && !s.failureMode) e.push(`script[${i}] fails without a failureMode`);
      if (s.latencyMs !== undefined && s.latencyMs < 0) e.push(`script[${i}].latencyMs must be >= 0`);
    }
  }
  return e;
}

export interface ProviderV20CallResult {
  providerId: string;
  ok: boolean;
  latencyMs: number;
  failureMode?: ProviderV20FailureMode;
  /** Script step index consumed, -1 when the default ok path ran. */
  stepIndex: number;
}

export interface ProviderV20Stats {
  calls: number;
  ok: number;
  failures: number;
  consecutiveFailures: number;
  meanLatencyMs: number;
  lastFailureMode: ProviderV20FailureMode | null;
  health: VoiceV20ProviderHealth;
}

export class MockProviderV20 {
  readonly id: string;
  readonly kind: VoiceV20ProviderKind;
  readonly label: string;
  readonly quality: number;
  readonly baseLatencyMs: number;
  readonly capabilities: ProviderV20Capability[];
  private script: ProviderV20ScriptStep[];
  private stepCursor = 0;
  private degradeAfter: number;
  private downAfter: number;
  private calls = 0;
  private okCount = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private latencies: number[] = [];
  private lastFailureMode: ProviderV20FailureMode | null = null;
  private forcedHealth: VoiceV20ProviderHealth | null = null;

  constructor(cfg: MockProviderV20Config) {
    this.id = cfg.id;
    this.kind = cfg.kind;
    this.label = cfg.label;
    this.quality = cfg.quality;
    this.baseLatencyMs = cfg.baseLatencyMs;
    this.capabilities = [...cfg.capabilities];
    this.script = cfg.script.map((s) => ({ ...s }));
    this.degradeAfter = cfg.degradeAfterFailures;
    this.downAfter = cfg.downAfterFailures;
  }

  get health(): VoiceV20ProviderHealth {
    if (this.forcedHealth) return this.forcedHealth;
    if (this.consecutiveFailures >= this.downAfter) return 'down';
    if (this.consecutiveFailures >= this.degradeAfter) return 'degraded';
    return 'healthy';
  }

  hasCapability(cap: ProviderV20Capability): boolean {
    return this.capabilities.includes(cap);
  }

  /** Force a health state (tests / operator override). Pass null to clear. */
  forceHealth(h: VoiceV20ProviderHealth | null): void {
    this.forcedHealth = h;
  }

  /** Append scripted outcomes, e.g. to simulate an outage mid-call. */
  appendScript(steps: ProviderV20ScriptStep[]): void {
    this.script.push(...steps.map((s) => ({ ...s })));
  }

  /** Reset counters and rewind the script to the start. */
  reset(): void {
    this.stepCursor = 0;
    this.calls = 0;
    this.okCount = 0;
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.latencies = [];
    this.lastFailureMode = null;
    this.forcedHealth = null;
  }

  /** Simulate one call. Deterministic: consumes the next script step, if any. */
  call(): ProviderV20CallResult {
    this.calls += 1;
    const step = this.stepCursor < this.script.length ? this.script[this.stepCursor] : null;
    if (step) this.stepCursor += 1;
    if (step && step.outcome === 'fail') {
      this.failures += 1;
      this.consecutiveFailures += 1;
      this.lastFailureMode = step.failureMode ?? 'disconnected';
      return {
        providerId: this.id,
        ok: false,
        latencyMs: step.latencyMs ?? this.baseLatencyMs,
        failureMode: this.lastFailureMode,
        stepIndex: this.stepCursor - 1,
      };
    }
    const latency = step?.latencyMs ?? this.baseLatencyMs;
    this.okCount += 1;
    this.consecutiveFailures = 0;
    this.latencies.push(latency);
    if (this.latencies.length > 50) this.latencies.shift();
    return { providerId: this.id, ok: true, latencyMs: latency, stepIndex: step ? this.stepCursor - 1 : -1 };
  }

  /**
   * Health probe: consumes the next script step and reports whether
   * the provider answers, WITHOUT touching the call counters or the
   * consecutive-failure streak. A plain `call()` would clear the
   * streak on success, which would instantly mark a down provider
   * healthy and defeat the multi-probe recovery rule.
   */
  probe(): boolean {
    const step = this.stepCursor < this.script.length ? this.script[this.stepCursor] : null;
    if (step) this.stepCursor += 1;
    return !(step && step.outcome === 'fail');
  }

  getStats(): ProviderV20Stats {
    const mean = this.latencies.length > 0
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0;
    return {
      calls: this.calls,
      ok: this.okCount,
      failures: this.failures,
      consecutiveFailures: this.consecutiveFailures,
      meanLatencyMs: Math.round(mean),
      lastFailureMode: this.lastFailureMode,
      health: this.health,
    };
  }
}

export function createMockProviderV20(
  cfg: Partial<MockProviderV20Config> & { id: string; kind: VoiceV20ProviderKind },
): MockProviderV20 {
  const merged: MockProviderV20Config = { ...defaultMockProviderV20Config(cfg.id, cfg.kind), ...cfg };
  return new MockProviderV20(merged);
}

export type ProviderRegistryV20EventKind =
  | 'registered'
  | 'unregistered'
  | 'failover'
  | 'health-changed'
  | 'no-healthy-provider';
export type ProviderRegistryV20Event = {
  kind: ProviderRegistryV20EventKind;
  atMs: number;
  detail?: Record<string, unknown>;
};
export type ProviderRegistryV20EventSink = (event: ProviderRegistryV20Event) => void;

export interface ProviderRegistryV20Options {
  /** Probe a down provider this often (virtual ms) to see if it recovered. */
  probeIntervalMs: number;
  /** A provider must pass this many probes in a row to come back. */
  probesToRecover: number;
  /** Prefer the highest-quality healthy provider (else first registered). */
  preferQuality: boolean;
}

export function defaultProviderRegistryV20Options(): ProviderRegistryV20Options {
  return { probeIntervalMs: 5000, probesToRecover: 2, preferQuality: true };
}

export function validateProviderRegistryV20Options(o: Partial<ProviderRegistryV20Options>): string[] {
  const e: string[] = [];
  if (o.probeIntervalMs !== undefined && o.probeIntervalMs <= 0) e.push('probeIntervalMs must be > 0');
  if (o.probesToRecover !== undefined && o.probesToRecover < 1) e.push('probesToRecover must be >= 1');
  return e;
}

export interface ProviderRegistryV20Stats {
  providers: number;
  failovers: number;
  noHealthy: number;
  callsRouted: number;
  byKind: Record<VoiceV20ProviderKind, { total: number; healthy: number; degraded: number; down: number }>;
}

/**
 * Registry of mock providers per kind, with failover.
 * `route(kind)` returns the best currently-healthy provider;
 * `reportCall` feeds the outcome back so health follows reality.
 */
export class ProviderRegistryV20 {
  private opts: ProviderRegistryV20Options;
  private sink?: ProviderRegistryV20EventSink;
  private providers = new Map<string, MockProviderV20>();
  private lastFailoverAtMs = new Map<VoiceV20ProviderKind, number>();
  private probeSuccesses = new Map<string, number>();
  private stats: ProviderRegistryV20Stats = {
    providers: 0, failovers: 0, noHealthy: 0, callsRouted: 0,
    byKind: {
      stt: { total: 0, healthy: 0, degraded: 0, down: 0 },
      tts: { total: 0, healthy: 0, degraded: 0, down: 0 },
      s2s: { total: 0, healthy: 0, degraded: 0, down: 0 },
    },
  };

  constructor(opts: Partial<ProviderRegistryV20Options> = {}, sink?: ProviderRegistryV20EventSink) {
    this.opts = { ...defaultProviderRegistryV20Options(), ...opts };
    this.sink = sink;
  }

  get options(): ProviderRegistryV20Options { return { ...this.opts }; }
  get size(): number { return this.providers.size; }

  register(p: MockProviderV20): void {
    const isNew = !this.providers.has(p.id);
    this.providers.set(p.id, p);
    if (isNew) this.sink?.({ kind: 'registered', atMs: 0, detail: { id: p.id, kind: p.kind } });
  }

  unregister(id: string): boolean {
    const ok = this.providers.delete(id);
    if (ok) this.sink?.({ kind: 'unregistered', atMs: 0, detail: { id } });
    return ok;
  }

  get(id: string): MockProviderV20 | undefined {
    return this.providers.get(id);
  }

  providersFor(kind: VoiceV20ProviderKind): MockProviderV20[] {
    return [...this.providers.values()].filter((p) => p.kind === kind);
  }

  /** Best provider for a kind: healthy first, then degraded, highest quality first. */
  route(kind: VoiceV20ProviderKind, atMs: number, requireCapability?: ProviderV20Capability): MockProviderV20 | null {
    let candidates = this.providersFor(kind);
    if (requireCapability) candidates = candidates.filter((p) => p.hasCapability(requireCapability));
    const rank = (h: VoiceV20ProviderHealth): number => (h === 'healthy' ? 0 : h === 'degraded' ? 1 : 2);
    candidates.sort((a, b) => {
      const r = rank(a.health) - rank(b.health);
      if (r !== 0) return r;
      return this.opts.preferQuality ? b.quality - a.quality : 0;
    });
    const pick = candidates.find((p) => p.health !== 'down') ?? null;
    if (!pick) {
      this.stats.noHealthy += 1;
      this.sink?.({ kind: 'no-healthy-provider', atMs, detail: { kind, capability: requireCapability ?? null } });
      return null;
    }
    this.stats.callsRouted += 1;
    return pick;
  }

  /**
   * Record a call outcome. A failure on the routed provider triggers
   * failover bookkeeping (the next `route` call picks the next best);
   * a success on a previously-failing provider counts toward recovery.
   */
  reportCall(result: ProviderV20CallResult, atMs: number): MockProviderV20 | null {
    const p = this.providers.get(result.providerId);
    if (!p) return null;
    const before = p.health;
    if (!result.ok) {
      const prev = this.lastFailoverAtMs.get(p.kind);
      if (prev === undefined || atMs - prev >= 1000) {
        this.lastFailoverAtMs.set(p.kind, atMs);
        this.stats.failovers += 1;
        const next = this.route(p.kind, atMs);
        this.sink?.({
          kind: 'failover', atMs,
          detail: { kind: p.kind, from: p.id, to: next?.id ?? null, mode: result.failureMode ?? null },
        });
        void before;
        return next;
      }
      return null;
    }
    const successes = (this.probeSuccesses.get(p.id) ?? 0) + 1;
    this.probeSuccesses.set(p.id, successes);
    void before;
    return null;
  }

  /**
   * Virtual-clock probe pass: probe each down provider once;
   * `probesToRecover` consecutive ok probes restore it (script
   * exhausted = ok). Returns the ids that recovered.
   */
  probeDown(atMs: number): string[] {
    const recovered: string[] = [];
    for (const p of this.providers.values()) {
      if (p.health !== 'down') continue;
      const ok = p.probe();
      if (ok) {
        const n = (this.probeSuccesses.get(p.id) ?? 0) + 1;
        this.probeSuccesses.set(p.id, n);
        if (n >= this.opts.probesToRecover) {
          p.reset();
          this.probeSuccesses.set(p.id, 0);
          recovered.push(p.id);
          this.sink?.({ kind: 'health-changed', atMs, detail: { id: p.id, from: 'down', to: 'healthy' } });
        }
      } else {
        this.probeSuccesses.set(p.id, 0);
      }
    }
    return recovered;
  }

  getStats(): ProviderRegistryV20Stats {
    const byKind: ProviderRegistryV20Stats['byKind'] = {
      stt: { total: 0, healthy: 0, degraded: 0, down: 0 },
      tts: { total: 0, healthy: 0, degraded: 0, down: 0 },
      s2s: { total: 0, healthy: 0, degraded: 0, down: 0 },
    };
    for (const p of this.providers.values()) {
      const slot = byKind[p.kind];
      slot.total += 1;
      slot[p.health] += 1;
    }
    return { ...this.stats, providers: this.providers.size, byKind };
  }
}

export function createProviderRegistryV20(
  opts: Partial<ProviderRegistryV20Options> = {},
  sink?: ProviderRegistryV20EventSink,
): ProviderRegistryV20 {
  return new ProviderRegistryV20(opts, sink);
}

export function providerRegistryV20Summary(r: ProviderRegistryV20): string {
  const s = r.getStats();
  const parts = (['stt', 'tts', 's2s'] as const).map((k) => {
    const b = s.byKind[k];
    return `${k} ${b.healthy}/${b.total} healthy`;
  });
  return `Providers v20: ${s.providers} registered, ${parts.join(', ')}, ${s.failovers} failovers, ${s.noHealthy} no-healthy`;
}

export function providerRegistryV20Markdown(r: ProviderRegistryV20): string {
  const s = r.getStats();
  const lines = [`# Providers v20`, ``, `- Registered: ${s.providers}`, `- Failovers: ${s.failovers}`, `- No-healthy events: ${s.noHealthy}`, `- Calls routed: ${s.callsRouted}`, ``];
  for (const k of ['stt', 'tts', 's2s'] as const) {
    const b = s.byKind[k];
    lines.push(`- ${k}: ${b.healthy} healthy / ${b.degraded} degraded / ${b.down} down / ${b.total} total`);
  }
  return lines.join('\n') + '\n';
}
