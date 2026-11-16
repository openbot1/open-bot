/**
 * Speech-to-speech path v15 (v1.16, Đội T5 — voice realtime v15).
 *
 * Research ideas only (no copied code): OpenAI Realtime `gpt-realtime`
 * (GA 28/08/2025) and Gemini Live both speak full-duplex audio over one
 * WebSocket — PCM16 24 kHz in, PCM16 24 kHz out — with server-side VAD,
 * streaming transcripts and function calls that can land *mid-conversation*
 * (the model calls a tool, the client runs it, the result goes back into
 * the same turn without tearing the audio down). End-to-end 300–600 ms,
 * against 1.5–3 s for the classic STT → LLM → TTS pipeline. That is the
 * whole reason this module exists: when S2S is available it is the fast
 * path; when it is not, the pipeline in `pipelineV15.ts` is the fallback.
 *
 * MOCK-FIRST: nothing here opens a socket or needs a key. The transport
 * is injected (`S2STransportV15`); production binds a real WebSocket
 * adapter, tests and the default session bind `MockS2STransportV15`,
 * a scripted transport driven by a virtual clock. The adapters below
 * (OpenAI Realtime / Gemini Live) are protocol *shapers*: they build the
 * exact wire-shaped JSON each provider expects (session.update,
 * input_audio_buffer.append, response.create, response.cancel,
 * conversation.item.create …) and parse the provider's server events
 * back into one normalised `S2SEventV15` stream, so the session layer
 * never sees provider differences. The live wire itself is out of scope
 * here — a host that wants it implements `S2STransportV15` on a real
 * WebSocket and passes it to `S2SAdapterV15`; these adapters refuse to
 * run without a transport, and never read, log or store a key.
 *
 * State machine: idle → connecting → connected → (reconnecting → …) →
 * closed, plus failed (terminal after the reconnect budget is spent).
 * Reconnect uses exponential backoff with jitter-free deterministic
 * delays (the virtual clock makes tests exact): base × multiplier^n,
 * capped, max `maxReconnectAttempts` tries, then `failed` and the
 * session asks for pipeline fallback (`shouldFallbackToPipeline`).
 * A `speech_started` server event while the agent is speaking is a
 * barge-in signal; the adapter emits it and leaves the actual cancel
 * to `bargeInV15.ts` (CancelScope), which owns flushing TTS + LLM.
 *
 * Determinism: the adapter owns a virtual clock (`nowMs`, starts at 0).
 * `tick(ms)` advances it and drains due mock-transport events. No
 * sound card, no network, no key.
 */

export const S2S_V15_SAMPLE_RATE_HZ = 24000;
export const S2S_V15_FRAME_MS = 20;
export const S2S_V15_FRAME_SAMPLES = (S2S_V15_SAMPLE_RATE_HZ * S2S_V15_FRAME_MS) / 1000;
export const S2S_V15_MAX_RECONNECT_ATTEMPTS = 5;
export const S2S_V15_BASE_RECONNECT_DELAY_MS = 250;
export const S2S_V15_MAX_RECONNECT_DELAY_MS = 8000;
export const S2S_V15_RECONNECT_BACKOFF_MULTIPLIER = 2;

export type S2SProviderKindV15 = 'openai-realtime' | 'gemini-live' | 'mock';
export const S2S_V15_PROVIDER_KINDS: readonly S2SProviderKindV15[] = [
  'openai-realtime',
  'gemini-live',
  'mock',
];

export function isS2SProviderKindV15(value: unknown): value is S2SProviderKindV15 {
  return typeof value === 'string' && (S2S_V15_PROVIDER_KINDS as readonly string[]).includes(value);
}

export type S2SStateV15 =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export const S2S_V15_STATES: readonly S2SStateV15[] = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
  'closed',
];

export type S2SEventKindV15 =
  | 'state'
  | 'transcript-partial'
  | 'transcript-final'
  | 'audio'
  | 'speech-started'
  | 'speech-stopped'
  | 'function-call'
  | 'function-result'
  | 'turn-end'
  | 'error'
  | 'fallback';

export interface S2SFunctionCallV15 {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Virtual-clock ms when the call arrived. */
  atMs: number;
}

export interface S2SEventV15 {
  kind: S2SEventKindV15;
  atMs: number;
  state?: S2SStateV15;
  /** Partial / final transcript text (user or agent, see `speaker`). */
  text?: string;
  speaker?: 'user' | 'agent';
  /** PCM16 24 kHz audio chunk (agent output). */
  audio?: Int16Array;
  call?: S2SFunctionCallV15;
  /** Result payload sent back to the model after a function call. */
  result?: string;
  message?: string;
  /** Why fallback / error happened. */
  reason?: string;
  /** Attempt number for reconnect events. */
  attempt?: number;
}

export type S2SEventSinkV15 = (event: S2SEventV15) => void;

/** One scripted server event for the mock transport. */
export interface MockS2SScriptEventV15 {
  /** Virtual ms after connect() when the event fires. */
  atMs: number;
  kind: Exclude<S2SEventKindV15, 'state' | 'error' | 'fallback'>;
  text?: string;
  speaker?: 'user' | 'agent';
  callName?: string;
  callArgs?: Record<string, unknown>;
  /** Audio chunk length in samples (synthetic silence-ish PCM). */
  audioSamples?: number;
}

export interface MockS2STransportOptionsV15 {
  connectDelayMs?: number;
  /** Script of server events, fired by tick(). */
  script?: MockS2SScriptEventV15[];
  /** Fail the next connect() with this message (once). */
  failNextConnectWith?: string;
  /** Drop the connection at this virtual ms after connect (once). */
  dropAtMs?: number;
}

/**
 * Transport contract. A real WebSocket implementation sends the JSON
 * string / binary frame and calls `onEvent` for inbound server events.
 * The mock implements the same contract on a virtual clock.
 */
export interface S2STransportV15 {
  kind: S2SProviderKindV15;
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  sendJson(message: Record<string, unknown>): void;
  sendAudio(frame: Int16Array): void;
  /** Advance the virtual clock; mock drains due scripted events. */
  tick(ms: number): void;
  onEvent: S2SEventSinkV15 | null;
  sentJson(): Record<string, unknown>[];
  sentAudioFrames(): Int16Array[];
}

export class MockS2STransportV15 implements S2STransportV15 {
  readonly kind: S2SProviderKindV15;
  onEvent: S2SEventSinkV15 | null = null;
  private connected = false;
  private nowMs = 0;
  private connectAtMs = 0;
  private readonly options: Required<Omit<MockS2STransportOptionsV15, 'failNextConnectWith' | 'dropAtMs'>> &
    Pick<MockS2STransportOptionsV15, 'failNextConnectWith' | 'dropAtMs'>;
  private readonly sentJsonMessages: Record<string, unknown>[] = [];
  private readonly sentFrames: Int16Array[] = [];
  private fired = 0;
  private dropped = false;
  private failNext: string | undefined;

  constructor(kind: S2SProviderKindV15 = 'mock', options: MockS2STransportOptionsV15 = {}) {
    this.kind = kind;
    this.options = {
      connectDelayMs: options.connectDelayMs ?? 50,
      script: options.script ?? [],
      failNextConnectWith: options.failNextConnectWith,
      dropAtMs: options.dropAtMs,
    };
    this.failNext = options.failNextConnectWith;
  }

  async connect(): Promise<void> {
    if (this.failNext !== undefined) {
      const message = this.failNext;
      this.failNext = undefined;
      throw new Error(message);
    }
    this.connected = true;
    this.connectAtMs = this.nowMs;
    this.fired = 0;
    this.dropped = false;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  sendJson(message: Record<string, unknown>): void {
    this.sentJsonMessages.push(message);
  }

  sendAudio(frame: Int16Array): void {
    this.sentFrames.push(frame);
  }

  tick(ms: number): void {
    this.nowMs += ms;
    if (!this.connected) return;
    if (this.options.dropAtMs !== undefined && !this.dropped) {
      const elapsed = this.nowMs - this.connectAtMs;
      if (elapsed >= this.options.dropAtMs) {
        this.dropped = true;
        this.connected = false;
        this.onEvent?.({ kind: 'error', atMs: this.nowMs, message: 'mock transport dropped', reason: 'transport-drop' });
        return;
      }
    }
    const script = [...this.options.script].sort((a, b) => a.atMs - b.atMs);
    while (this.fired < script.length) {
      const item = script[this.fired];
      if (this.nowMs - this.connectAtMs < item.atMs) break;
      this.fired += 1;
      this.emitScript(item);
    }
  }

  private emitScript(item: MockS2SScriptEventV15): void {
    const atMs = this.nowMs;
    switch (item.kind) {
      case 'transcript-partial':
      case 'transcript-final':
        this.onEvent?.({ kind: item.kind, atMs, text: item.text ?? '', speaker: item.speaker ?? 'user' });
        break;
      case 'audio': {
        const samples = item.audioSamples ?? S2S_V15_FRAME_SAMPLES;
        this.onEvent?.({ kind: 'audio', atMs, audio: new Int16Array(samples), speaker: 'agent' });
        break;
      }
      case 'speech-started':
      case 'speech-stopped':
      case 'turn-end':
        this.onEvent?.({ kind: item.kind, atMs });
        break;
      case 'function-call':
        this.onEvent?.({
          kind: 'function-call',
          atMs,
          call: { id: `call_${this.fired}`, name: item.callName ?? 'unknown_tool', args: item.callArgs ?? {}, atMs },
        });
        break;
      case 'function-result':
        this.onEvent?.({ kind: 'function-result', atMs, result: item.text ?? '' });
        break;
    }
  }

  sentJson(): Record<string, unknown>[] {
    return [...this.sentJsonMessages];
  }

  sentAudioFrames(): Int16Array[] {
    return [...this.sentFrames];
  }

  now(): number {
    return this.nowMs;
  }
}

export interface S2SAdapterOptionsV15 {
  provider: S2SProviderKindV15;
  model?: string;
  voice?: string;
  language?: string;
  instructions?: string;
  /** Tools the model may call mid-conversation (names only here). */
  tools?: string[];
  maxReconnectAttempts?: number;
  baseReconnectDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  maxReconnectDelayMs?: number;
  /** Server VAD silence that ends a user turn (ms). */
  serverVadSilenceMs?: number;
}

export function defaultS2SAdapterOptionsV15(): S2SAdapterOptionsV15 {
  return {
    provider: 'mock',
    model: 'gpt-realtime',
    voice: 'alloy',
    language: 'vi',
    instructions: '',
    tools: [],
    maxReconnectAttempts: S2S_V15_MAX_RECONNECT_ATTEMPTS,
    baseReconnectDelayMs: S2S_V15_BASE_RECONNECT_DELAY_MS,
    reconnectBackoffMultiplier: S2S_V15_RECONNECT_BACKOFF_MULTIPLIER,
    maxReconnectDelayMs: S2S_V15_MAX_RECONNECT_DELAY_MS,
    serverVadSilenceMs: 450,
  };
}

export function validateS2SAdapterOptionsV15(options: S2SAdapterOptionsV15): string[] {
  const errors: string[] = [];
  if (!isS2SProviderKindV15(options.provider)) errors.push(`unknown provider: ${String(options.provider)}`);
  if (options.maxReconnectAttempts !== undefined && (options.maxReconnectAttempts < 0 || options.maxReconnectAttempts > 20)) {
    errors.push('maxReconnectAttempts must be 0..20');
  }
  if (options.baseReconnectDelayMs !== undefined && options.baseReconnectDelayMs < 0) {
    errors.push('baseReconnectDelayMs must be >= 0');
  }
  if (options.reconnectBackoffMultiplier !== undefined && options.reconnectBackoffMultiplier < 1) {
    errors.push('reconnectBackoffMultiplier must be >= 1');
  }
  if (options.serverVadSilenceMs !== undefined && (options.serverVadSilenceMs < 100 || options.serverVadSilenceMs > 5000)) {
    errors.push('serverVadSilenceMs must be 100..5000');
  }
  if (options.language !== undefined && !/^[a-z]{2}(-[A-Z]{2})?$/.test(options.language)) {
    errors.push(`language must look like a BCP-47 tag, got ${options.language}`);
  }
  return errors;
}

/** Deterministic reconnect delay for attempt n (0-based). */
export function s2sReconnectDelayV15(options: S2SAdapterOptionsV15, attempt: number): number {
  const base = options.baseReconnectDelayMs ?? S2S_V15_BASE_RECONNECT_DELAY_MS;
  const mult = options.reconnectBackoffMultiplier ?? S2S_V15_RECONNECT_BACKOFF_MULTIPLIER;
  const max = options.maxReconnectDelayMs ?? S2S_V15_MAX_RECONNECT_DELAY_MS;
  return Math.min(max, Math.round(base * Math.pow(mult, attempt)));
}

export interface S2SFunctionHandlerV15 {
  (call: S2SFunctionCallV15): Promise<string> | string;
}

export interface S2SAdapterStatsV15 {
  state: S2SStateV15;
  provider: S2SProviderKindV15;
  connectAttempts: number;
  reconnects: number;
  uptimeMs: number;
  audioFramesSent: number;
  audioChunksReceived: number;
  transcriptPartials: number;
  transcriptFinals: number;
  functionCalls: number;
  functionResults: number;
  errors: number;
  fallbacks: number;
  lastError: string | undefined;
}

/**
 * One adapter for one S2S provider. It owns the state machine, the
 * reconnect loop and the wire shaping; the transport owns the bytes.
 * `tick(ms)` advances the virtual clock, drains the transport and
 * fires due reconnect attempts.
 */
export class S2SAdapterV15 {
  readonly options: S2SAdapterOptionsV15;
  private readonly transport: S2STransportV15;
  private readonly sink: S2SEventSinkV15;
  private readonly handlers = new Map<string, S2SFunctionHandlerV15>();
  private state: S2SStateV15 = 'idle';
  private nowMs = 0;
  private connectAttempts = 0;
  private reconnects = 0;
  private reconnectAttempt = 0;
  private nextReconnectAtMs: number | undefined;
  private connectedAtMs: number | undefined;
  private uptimeMs = 0;
  private audioFramesSent = 0;
  private audioChunksReceived = 0;
  private transcriptPartials = 0;
  private transcriptFinals = 0;
  private functionCalls = 0;
  private functionResults = 0;
  private errors = 0;
  private fallbacks = 0;
  private lastError: string | undefined;
  private readonly userTranscript: string[] = [];
  private readonly agentTranscript: string[] = [];

  constructor(transport: S2STransportV15, options: Partial<S2SAdapterOptionsV15>, sink: S2SEventSinkV15) {
    const merged: S2SAdapterOptionsV15 = { ...defaultS2SAdapterOptionsV15(), ...options, provider: transport.kind };
    const errors = validateS2SAdapterOptionsV15(merged);
    if (errors.length > 0) throw new Error(`invalid S2S options: ${errors.join('; ')}`);
    this.transport = transport;
    this.options = merged;
    this.sink = sink;
    this.transport.onEvent = (event) => this.handleTransportEvent(event);
  }

  getState(): S2SStateV15 {
    return this.state;
  }

  now(): number {
    return this.nowMs;
  }

  registerFunction(name: string, handler: S2SFunctionHandlerV15): void {
    this.handlers.set(name, handler);
  }

  unregisterFunction(name: string): boolean {
    return this.handlers.delete(name);
  }

  registeredFunctions(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.setState('connecting');
    this.connectAttempts += 1;
    try {
      await this.transport.connect();
    } catch (err) {
      this.errors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.sink({ kind: 'error', atMs: this.nowMs, message: this.lastError, reason: 'connect-failed', attempt: this.connectAttempts });
      this.scheduleReconnectOrFail('connect-failed');
      return;
    }
    this.enterConnected();
    this.sendSessionUpdate();
  }

  disconnect(reason = 'client-close'): void {
    if (this.state === 'closed' || this.state === 'idle') return;
    if (this.connectedAtMs !== undefined) this.uptimeMs += this.nowMs - this.connectedAtMs;
    this.connectedAtMs = undefined;
    this.nextReconnectAtMs = undefined;
    try {
      this.transport.disconnect();
    } catch {
      // Disconnect is best-effort; state still moves to closed.
    }
    this.setState('closed');
    this.sink({ kind: 'state', atMs: this.nowMs, state: 'closed', reason });
  }

  /** Advance the virtual clock; drains transport + due reconnects. */
  tick(ms: number): void {
    this.nowMs += ms;
    this.transport.tick(ms);
    if (this.state === 'reconnecting' && this.nextReconnectAtMs !== undefined && this.nowMs >= this.nextReconnectAtMs) {
      this.nextReconnectAtMs = undefined;
      void this.connect();
    }
  }

  sendAudioFrame(frame: Int16Array): void {
    if (this.state !== 'connected') return;
    if (frame.length !== S2S_V15_FRAME_SAMPLES) {
      throw new Error(`S2S frame must be ${S2S_V15_FRAME_SAMPLES} samples (20 ms @ 24 kHz), got ${frame.length}`);
    }
    this.transport.sendAudio(frame);
    this.audioFramesSent += 1;
  }

  sendText(text: string): void {
    if (this.state !== 'connected') return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.transport.sendJson(this.shapeTextInput(trimmed));
    this.transport.sendJson(this.shapeResponseCreate());
  }

  /** Ask the model to stop the current response (barge-in path). */
  cancelResponse(): void {
    if (this.state !== 'connected') return;
    this.transport.sendJson(this.shapeResponseCancel());
  }

  userTranscriptText(): string {
    return this.userTranscript.join(' ');
  }

  agentTranscriptText(): string {
    return this.agentTranscript.join(' ');
  }

  shouldFallbackToPipeline(): { fallback: boolean; reason: string } {
    if (this.state === 'failed') return { fallback: true, reason: this.lastError ?? 's2s-failed' };
    if (this.options.provider !== 'mock' && this.state !== 'connected') {
      return { fallback: true, reason: 's2s-unavailable' };
    }
    return { fallback: false, reason: '' };
  }

  stats(): S2SAdapterStatsV15 {
    const uptime = this.uptimeMs + (this.connectedAtMs !== undefined ? this.nowMs - this.connectedAtMs : 0);
    return {
      state: this.state,
      provider: this.options.provider,
      connectAttempts: this.connectAttempts,
      reconnects: this.reconnects,
      uptimeMs: uptime,
      audioFramesSent: this.audioFramesSent,
      audioChunksReceived: this.audioChunksReceived,
      transcriptPartials: this.transcriptPartials,
      transcriptFinals: this.transcriptFinals,
      functionCalls: this.functionCalls,
      functionResults: this.functionResults,
      errors: this.errors,
      fallbacks: this.fallbacks,
      lastError: this.lastError,
    };
  }

  summary(): string {
    const s = this.stats();
    return `s2s ${s.provider} state=${s.state} attempts=${s.connectAttempts} reconnects=${s.reconnects} ` +
      `uptime=${s.uptimeMs}ms frames=${s.audioFramesSent}/${s.audioChunksReceived} ` +
      `transcript=${s.transcriptPartials}p/${s.transcriptFinals}f calls=${s.functionCalls}`;
  }

  markdown(): string {
    const s = this.stats();
    const lines = [
      '## Speech-to-speech v15',
      '',
      `- Provider: \`${s.provider}\` (model \`${this.options.model ?? ''}\`, voice \`${this.options.voice ?? ''}\`, lang \`${this.options.language ?? ''}\`)`,
      `- State: \`${s.state}\` — attempts ${s.connectAttempts}, reconnects ${s.reconnects}, uptime ${s.uptimeMs} ms`,
      `- Audio: ${s.audioFramesSent} frames sent, ${s.audioChunksReceived} chunks received (PCM16 24 kHz)`,
      `- Transcript: ${s.transcriptPartials} partials, ${s.transcriptFinals} finals`,
      `- Function calls: ${s.functionCalls} received, ${s.functionResults} results sent`,
      `- Errors: ${s.errors}${s.lastError ? ` (last: ${s.lastError})` : ''}; fallbacks: ${s.fallbacks}`,
      `- User transcript: ${this.userTranscriptText() || '(empty)'}`,
      `- Agent transcript: ${this.agentTranscriptText() || '(empty)'}`,
      '',
    ];
    return lines.join('\n');
  }

  private setState(next: S2SStateV15): void {
    this.state = next;
    this.sink({ kind: 'state', atMs: this.nowMs, state: next });
  }

  private enterConnected(): void {
    this.connectedAtMs = this.nowMs;
    this.reconnectAttempt = 0;
    this.setState('connected');
  }

  private scheduleReconnectOrFail(reason: string): void {
    const max = this.options.maxReconnectAttempts ?? S2S_V15_MAX_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempt >= max) {
      this.fallbacks += 1;
      this.setState('failed');
      this.sink({ kind: 'fallback', atMs: this.nowMs, reason, message: 'S2S failed; fall back to the STT→LLM→TTS pipeline.' });
      return;
    }
    const delay = s2sReconnectDelayV15(this.options, this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnects += 1;
    this.nextReconnectAtMs = this.nowMs + delay;
    this.setState('reconnecting');
    this.sink({ kind: 'error', atMs: this.nowMs, reason, attempt: this.reconnectAttempt, message: `reconnecting in ${delay} ms` });
  }

  private handleTransportEvent(event: S2SEventV15): void {
    switch (event.kind) {
      case 'transcript-partial':
        this.transcriptPartials += 1;
        this.sink(event);
        break;
      case 'transcript-final': {
        this.transcriptFinals += 1;
        const text = (event.text ?? '').trim();
        if (text.length > 0) {
          if (event.speaker === 'agent') this.agentTranscript.push(text);
          else this.userTranscript.push(text);
        }
        this.sink(event);
        break;
      }
      case 'audio':
        this.audioChunksReceived += 1;
        this.sink(event);
        break;
      case 'speech-started':
      case 'speech-stopped':
      case 'turn-end':
        this.sink(event);
        break;
      case 'function-call': {
        this.functionCalls += 1;
        this.sink(event);
        if (event.call) void this.runFunctionCall(event.call);
        break;
      }
      case 'error': {
        this.errors += 1;
        this.lastError = event.message ?? event.reason ?? 'transport error';
        this.sink(event);
        if (this.state === 'connected') {
          if (this.connectedAtMs !== undefined) {
            this.uptimeMs += this.nowMs - this.connectedAtMs;
            this.connectedAtMs = undefined;
          }
          try {
            this.transport.disconnect();
          } catch {
            // Best effort.
          }
          this.scheduleReconnectOrFail(event.reason ?? 'transport-error');
        }
        break;
      }
      default:
        this.sink(event);
        break;
    }
  }

  private async runFunctionCall(call: S2SFunctionCallV15): Promise<void> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      this.transport.sendJson(this.shapeFunctionResult(call.id, `Error: no handler registered for tool "${call.name}"`));
      this.functionResults += 1;
      this.sink({ kind: 'function-result', atMs: this.nowMs, result: `Error: no handler for ${call.name}`, call });
      return;
    }
    let result: string;
    try {
      result = await handler(call);
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.transport.sendJson(this.shapeFunctionResult(call.id, result));
    this.functionResults += 1;
    this.sink({ kind: 'function-result', atMs: this.nowMs, result, call });
  }

  // --- Wire shaping (provider-specific JSON, no socket here) ---

  private sendSessionUpdate(): void {
    this.transport.sendJson(this.shapeSessionUpdate());
  }

  shapeSessionUpdate(): Record<string, unknown> {
    if (this.options.provider === 'gemini-live') {
      return {
        type: 'setup',
        model: this.options.model ?? 'gemini-2.5-flash-native-audio-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voice ?? 'Aoede' } } },
        },
        systemInstruction: { parts: [{ text: this.options.instructions ?? '' }] },
        tools: (this.options.tools ?? []).map((name) => ({ functionDeclarations: [{ name }] })),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      };
    }
    // OpenAI Realtime (and mock, which speaks the OpenAI shape).
    return {
      type: 'session.update',
      session: {
        model: this.options.model ?? 'gpt-realtime',
        voice: this.options.voice ?? 'alloy',
        instructions: this.options.instructions ?? '',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'gpt-4o-transcribe' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          silence_duration_ms: this.options.serverVadSilenceMs ?? 450,
        },
        tools: (this.options.tools ?? []).map((name) => ({
          type: 'function',
          name,
          description: `Tool ${name}`,
          parameters: { type: 'object', properties: {} },
        })),
      },
    };
  }

  shapeTextInput(text: string): Record<string, unknown> {
    if (this.options.provider === 'gemini-live') {
      return { type: 'client_content', turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true };
    }
    return {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    };
  }

  shapeResponseCreate(): Record<string, unknown> {
    if (this.options.provider === 'gemini-live') return { type: 'generate', realtimeInput: {} };
    return { type: 'response.create', response: { modalities: ['audio', 'text'] } };
  }

  shapeResponseCancel(): Record<string, unknown> {
    if (this.options.provider === 'gemini-live') return { type: 'cancel' };
    return { type: 'response.cancel' };
  }

  shapeFunctionResult(callId: string, result: string): Record<string, unknown> {
    if (this.options.provider === 'gemini-live') {
      return {
        type: 'tool_response',
        functionResponse: { id: callId, name: '', response: { result } },
      };
    }
    return {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: result },
    };
  }
}

export function createS2SAdapterV15(
  transport: S2STransportV15,
  options: Partial<S2SAdapterOptionsV15>,
  sink: S2SEventSinkV15,
): S2SAdapterV15 {
  return new S2SAdapterV15(transport, options, sink);
}

export function s2sV15Summary(adapter: S2SAdapterV15): string {
  return adapter.summary();
}

export function s2sV15Markdown(adapter: S2SAdapterV15): string {
  return adapter.markdown();
}
