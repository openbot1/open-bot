/**
 * Local voice engines (v1.03, Team T5 — realtime voice v3).
 *
 * v1.02 had one local STT (whisper.cpp) and one local TTS family
 * (eSpeak, picked first-on-PATH) — when either was missing the
 * local path was dead, and there was nowhere to plug a second
 * engine in. This module is the registry + fallback chain for
 * local speech engines:
 *
 *   probe all ──▶ ordered chain (preferred ids first, then
 *   built-in priority) ──▶ FallbackSttEngine / FallbackTtsEngine
 *   try engine 1 → fails? → engine 2 → … → all failed? → a
 *   clear error naming every engine tried (never a guessed
 *   transcript, never silent speech).
 *
 * Engines known here (all probed, none assumed present):
 *
 *   STT: whisper-cli (v0.96 — binary + ggml model), vosk
 *        (`vosk-transcriber` + model dir), command (any CLI the
 *        user configures: wav in, transcript on stdout), mock.
 *   TTS: piper (`piper` + .onnx voice model, wav out → played
 *        with aplay/ffplay/paplay), espeak-ng / espeak / spd-say /
 *        say / flite (the v0.83 family), command (any CLI the user
 *        configures), mock.
 *
 * Probing never runs audio and never touches the network: it only
 * looks for binaries on PATH (and model files where the engine
 * needs one). Engines that need a model report `available: false`
 * with the reason ("piper binary found, no voice model") instead
 * of claiming readiness they do not have. Command runners are
 * injectable — the default runner spawns argv-only (no shell)
 * with a timeout; tests pass a fake runner and never spawn.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LocalSttEngine, LocalSttStatus, LocalSttTranscribeOptions } from './localStt';
import { MockLocalSttEngine, detectLocalStt } from './localStt';
import type { TtsEngine, TtsSpeakOptions, TtsSpeakResult } from './tts';
import { MockTtsEngine, SystemTtsEngine } from './tts';
import { pcm16ToWav } from './dictation';
import { isValidPcm16Frame } from './audio';

const execFileAsync = promisify(execFile);

/** Default timeout (ms) for one engine attempt. */
export const LOCAL_VOICE_ENGINE_TIMEOUT_MS = 120_000;
/** Default timeout (ms) for a TTS speak attempt. */
export const LOCAL_VOICE_TTS_TIMEOUT_MS = 60_000;

export type VoiceEngineKind = 'stt' | 'tts';

/** Result of probing one engine (no audio run, no network). */
export interface VoiceEngineProbe {
  id: string;
  kind: VoiceEngineKind;
  label: string;
  available: boolean;
  /** Human-readable reason when unavailable (null when available). */
  reason: string | null;
  binaryPath: string | null;
  modelPath: string | null;
}

/** One engine the registry knows: how to probe it + build it. */
export interface VoiceEngineDescriptor {
  id: string;
  kind: VoiceEngineKind;
  label: string;
  /** Lower runs first when no preference is given. */
  priority: number;
  probe: () => VoiceEngineProbe | Promise<VoiceEngineProbe>;
  /** Build the engine (called only after a successful probe). */
  createStt?: () => LocalSttEngine;
  createTts?: () => TtsEngine;
}

/** One attempt inside a fallback chain (diagnostics). */
export interface FallbackAttempt {
  engineId: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Look for a binary on PATH (same scan as tts.ts / localStt.ts). */
export function findBinaryOnPath(binary: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not executable here — keep looking.
    }
  }
  return null;
}

/** Probe result for a plain binary engine (found / not found). */
export function probeBinaryEngine(
  id: string,
  kind: VoiceEngineKind,
  label: string,
  binary: string,
  pathEnv?: string,
): VoiceEngineProbe {
  const found = findBinaryOnPath(binary, pathEnv);
  return {
    id,
    kind,
    label,
    available: found !== null,
    reason: found ? null : `Binary '${binary}' was not found on PATH.`,
    binaryPath: found,
    modelPath: null,
  };
}

// ---------------------------------------------------------------------------
// Command runner (injectable; default spawns argv-only, no shell)
// ---------------------------------------------------------------------------

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code (null when killed / spawn failed). */
  code: number | null;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<CommandRunResult>;

/** Default runner: `execFile` with a timeout, argv-only (no shell). */
export const defaultCommandRunner: CommandRunner = async (command, args, opts = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: opts.timeoutMs ?? LOCAL_VOICE_ENGINE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      ...(opts.stdin !== undefined ? { input: opts.stdin } : {}),
    });
    return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
      code: typeof e.code === 'number' ? e.code : null,
    };
  }
};

/** Write bytes to a temp file, run `fn`, then delete the file. */
async function withTempFile<T>(
  prefix: string,
  suffix: string,
  bytes: Uint8Array,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, `input${suffix}`);
  try {
    fs.writeFileSync(file, bytes);
    return await fn(file);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // Best-effort.
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      // Best-effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Vosk STT (binary + model dir)
// ---------------------------------------------------------------------------

export interface VoskSttEngineOptions {
  binaryPath?: string;
  /** Model directory (or $VOSK_MODEL_PATH). */
  modelPath?: string;
  runner?: CommandRunner;
  timeoutMs?: number;
  pathEnv?: string;
}

/**
 * Vosk offline STT over the `vosk-transcriber` CLI: PCM16 → temp
 * WAV → `vosk-transcriber -i <wav> -m <model>` → JSON `{"text":
 * "..."}` on stdout. Unavailable when the binary or the model dir
 * is missing — the error says which one.
 */
export class VoskSttEngine implements LocalSttEngine {
  readonly id = 'vosk';
  private readonly binaryPath: string | null;
  private readonly modelPath: string | null;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(options: VoskSttEngineOptions = {}) {
    this.binaryPath =
      options.binaryPath ?? findBinaryOnPath('vosk-transcriber', options.pathEnv);
    this.modelPath =
      options.modelPath ?? process.env.VOSK_MODEL_PATH ?? null;
    this.runner = options.runner ?? defaultCommandRunner;
    this.timeoutMs = options.timeoutMs ?? LOCAL_VOICE_ENGINE_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return (
      this.binaryPath !== null &&
      this.modelPath !== null &&
      fs.existsSync(this.modelPath)
    );
  }

  status(): LocalSttStatus {
    if (!this.binaryPath) {
      return {
        available: false,
        engineId: null,
        binaryPath: null,
        modelPath: this.modelPath,
        reason: "Binary 'vosk-transcriber' was not found on PATH.",
      };
    }
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      return {
        available: false,
        engineId: null,
        binaryPath: this.binaryPath,
        modelPath: this.modelPath,
        reason: 'No Vosk model directory found (set VOSK_MODEL_PATH).',
      };
    }
    return {
      available: true,
      engineId: this.id,
      binaryPath: this.binaryPath,
      modelPath: this.modelPath,
    };
  }

  async transcribe(pcm16: Uint8Array, opts?: LocalSttTranscribeOptions): Promise<string> {
    if (!isValidPcm16Frame(pcm16)) {
      throw new Error('VoskSttEngine: audio must be a non-empty even-length PCM16 buffer.');
    }
    if (!this.isAvailable()) {
      throw new Error(`VoskSttEngine: ${this.status().reason ?? 'engine unavailable.'}`);
    }
    const wav = pcm16ToWav(pcm16, opts?.sampleRateHz ?? 16_000);
    const result = await withTempFile('open-bot-vosk-', '.wav', wav, async (file) => {
      return this.runner(this.binaryPath as string, ['-i', file, '-m', this.modelPath as string], {
        timeoutMs: this.timeoutMs,
      });
    });
    if (result.code !== 0) {
      throw new Error(
        `VoskSttEngine: vosk-transcriber exited with code ${result.code ?? 'unknown'}${result.stderr ? `: ${result.stderr.trim().slice(0, 200)}` : '.'}`,
      );
    }
    let text = '';
    try {
      const parsed = JSON.parse(result.stdout) as { text?: unknown };
      text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    } catch {
      text = result.stdout.trim();
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// Piper TTS (binary + .onnx model, wav out → player)
// ---------------------------------------------------------------------------

export interface PiperTtsEngineOptions {
  binaryPath?: string;
  /** Voice model file (.onnx). Or $PIPER_MODEL_PATH. */
  modelPath?: string;
  /** Player binary for the synthesised WAV (aplay/ffplay/paplay). */
  playerBinary?: string;
  runner?: CommandRunner;
  timeoutMs?: number;
  pathEnv?: string;
}

/** Players tried in order to play a synthesised WAV (no sound card
 *  on this VM — the player reports the failure honestly). */
export const PIPER_PLAYER_CANDIDATES: readonly string[] = ['aplay', 'ffplay', 'paplay'];

/**
 * Piper neural TTS: text → `piper --model <model> --output_file
 * <wav>` → play the WAV with the first available player. The
 * engine is only `available` when binary + model + a player are
 * all present; `speak()` reports `spoken: false` with the reason
 * otherwise (or when the player fails — e.g. no sound card).
 */
export class PiperTtsEngine implements TtsEngine {
  readonly id = 'piper';
  readonly name = 'Piper';
  readonly kind = 'system' as const;
  private readonly binaryPath: string | null;
  private readonly modelPath: string | null;
  private readonly playerPath: string | null;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(options: PiperTtsEngineOptions = {}) {
    this.binaryPath = options.binaryPath ?? findBinaryOnPath('piper', options.pathEnv);
    this.modelPath = options.modelPath ?? process.env.PIPER_MODEL_PATH ?? null;
    const player =
      options.playerBinary ??
      PIPER_PLAYER_CANDIDATES.map((b) => findBinaryOnPath(b, options.pathEnv)).find((p) => p !== null) ??
      null;
    this.playerPath = player;
    this.runner = options.runner ?? defaultCommandRunner;
    this.timeoutMs = options.timeoutMs ?? LOCAL_VOICE_TTS_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    return (
      this.binaryPath !== null &&
      this.modelPath !== null &&
      fs.existsSync(this.modelPath) &&
      this.playerPath !== null
    );
  }

  async speak(text: string, _opts?: TtsSpeakOptions): Promise<TtsSpeakResult> {
    const clean = String(text ?? '').trim();
    if (!clean) return { spoken: false, engineId: this.id, reason: 'empty-text' };
    if (!(await this.isAvailable())) {
      const missing = !this.binaryPath
        ? "piper binary not found"
        : !this.modelPath || !fs.existsSync(this.modelPath)
          ? 'no Piper voice model (.onnx) found (set PIPER_MODEL_PATH)'
          : 'no audio player found (aplay/ffplay/paplay)';
      return { spoken: false, engineId: this.id, reason: missing };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-piper-'));
    const wavFile = path.join(dir, 'out.wav');
    try {
      const synth = await this.runner(
        this.binaryPath as string,
        ['--model', this.modelPath as string, '--output_file', wavFile],
        { timeoutMs: this.timeoutMs, stdin: clean },
      );
      if (synth.code !== 0 || !fs.existsSync(wavFile)) {
        return {
          spoken: false,
          engineId: this.id,
          reason: `engine-exit-${synth.code ?? 'unknown'}`,
        };
      }
      const play = await this.runner(this.playerPath as string, [wavFile], {
        timeoutMs: this.timeoutMs,
      });
      if (play.code !== 0) {
        return { spoken: false, engineId: this.id, reason: `engine-exit-${play.code ?? 'unknown'}` };
      }
      return { spoken: true, engineId: this.id };
    } finally {
      try {
        fs.unlinkSync(wavFile);
      } catch {
        // Best-effort.
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        // Best-effort.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// User-configured command engines
// ---------------------------------------------------------------------------

export interface CommandSttEngineOptions {
  id: string;
  label?: string;
  /** Command (binary on PATH, or an absolute path). */
  command: string;
  /** argv; `{wav}` is replaced with the temp WAV path. */
  args?: string[];
  /** Parse stdout: 'text' (whole stdout) or 'json-text' ({"text"}). */
  parse?: 'text' | 'json-text';
  runner?: CommandRunner;
  timeoutMs?: number;
}

/**
 * Any CLI as an STT engine: PCM16 → temp WAV → `command <args>`
 * (`{wav}` → the temp file) → transcript on stdout. The command
 * runs argv-only (no shell) with a timeout; a non-zero exit is a
 * failure, never an empty transcript.
 */
export class CommandSttEngine implements LocalSttEngine {
  readonly id: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly parse: 'text' | 'json-text';
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(options: CommandSttEngineOptions) {
    this.id = options.id;
    this.command = options.command;
    this.args = options.args ?? ['{wav}'];
    this.parse = options.parse ?? 'text';
    this.runner = options.runner ?? defaultCommandRunner;
    this.timeoutMs = options.timeoutMs ?? LOCAL_VOICE_ENGINE_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    return findBinaryOnPath(this.command) !== null || fs.existsSync(this.command);
  }

  status(): LocalSttStatus {
    const available = this.isAvailable();
    return {
      available,
      engineId: available ? this.id : null,
      binaryPath: findBinaryOnPath(this.command),
      modelPath: null,
      reason: available ? undefined : `Command '${this.command}' was not found.`,
    };
  }

  async transcribe(pcm16: Uint8Array, opts?: LocalSttTranscribeOptions): Promise<string> {
    if (!isValidPcm16Frame(pcm16)) {
      throw new Error('CommandSttEngine: audio must be a non-empty even-length PCM16 buffer.');
    }
    if (!this.isAvailable()) {
      throw new Error(`CommandSttEngine: ${this.status().reason ?? 'engine unavailable.'}`);
    }
    const wav = pcm16ToWav(pcm16, opts?.sampleRateHz ?? 16_000);
    const result = await withTempFile('open-bot-cmd-stt-', '.wav', wav, async (file) => {
      const argv = this.args.map((a) => (a === '{wav}' ? file : a));
      return this.runner(this.command, argv, { timeoutMs: this.timeoutMs });
    });
    if (result.code !== 0) {
      throw new Error(
        `CommandSttEngine: '${this.command}' exited with code ${result.code ?? 'unknown'}${result.stderr ? `: ${result.stderr.trim().slice(0, 200)}` : '.'}`,
      );
    }
    if (this.parse === 'json-text') {
      try {
        const parsed = JSON.parse(result.stdout) as { text?: unknown };
        return typeof parsed.text === 'string' ? parsed.text.trim() : '';
      } catch {
        return result.stdout.trim();
      }
    }
    return result.stdout.trim();
  }
}

export interface CommandTtsEngineOptions {
  id: string;
  label?: string;
  command: string;
  /** argv; `{text}` is replaced with the text to speak. */
  args?: string[];
  runner?: CommandRunner;
  timeoutMs?: number;
}

/** Any CLI as a TTS engine: `command <args>` (`{text}` → the text
 *  to speak); exit 0 means spoken. */
export class CommandTtsEngine implements TtsEngine {
  readonly id: string;
  readonly name: string;
  readonly kind = 'system' as const;
  private readonly command: string;
  private readonly args: string[];
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(options: CommandTtsEngineOptions) {
    this.id = options.id;
    this.name = options.label ?? options.command;
    this.command = options.command;
    this.args = options.args ?? ['{text}'];
    this.runner = options.runner ?? defaultCommandRunner;
    this.timeoutMs = options.timeoutMs ?? LOCAL_VOICE_TTS_TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> {
    return findBinaryOnPath(this.command) !== null || fs.existsSync(this.command);
  }

  async speak(text: string, _opts?: TtsSpeakOptions): Promise<TtsSpeakResult> {
    const clean = String(text ?? '').trim();
    if (!clean) return { spoken: false, engineId: this.id, reason: 'empty-text' };
    if (!(await this.isAvailable())) {
      return { spoken: false, engineId: this.id, reason: `Command '${this.command}' was not found.` };
    }
    const argv = this.args.map((a) => (a === '{text}' ? clean : a));
    const result = await this.runner(this.command, argv, { timeoutMs: this.timeoutMs });
    if (result.code !== 0) {
      return { spoken: false, engineId: this.id, reason: `engine-exit-${result.code ?? 'unknown'}` };
    }
    return { spoken: true, engineId: this.id };
  }
}

// ---------------------------------------------------------------------------
// Fallback chains
// ---------------------------------------------------------------------------

/**
 * An STT engine that tries a chain of engines in order and returns
 * the first transcript that succeeds. Every attempt is recorded
 * (`getAttempts()`), so the panel can say which engine actually
 * answered — and a total failure names every engine tried. The
 * chain never returns a guessed transcript: no engine succeeding
 * means a throw.
 */
export class FallbackSttEngine implements LocalSttEngine {
  readonly id = 'fallback-stt';
  private readonly engines: LocalSttEngine[];
  private attempts: FallbackAttempt[] = [];
  private fallbacksUsed = 0;

  constructor(engines: LocalSttEngine[]) {
    this.engines = [...engines];
  }

  /** Engine ids in chain order. */
  chainIds(): string[] {
    return this.engines.map((e) => e.id);
  }

  /** Attempts of the last `transcribe()` call (oldest first). */
  getAttempts(): FallbackAttempt[] {
    return this.attempts.map((a) => ({ ...a }));
  }

  /** Times a transcribe needed an engine past the first. */
  getFallbacksUsed(): number {
    return this.fallbacksUsed;
  }

  /** Id of the engine that answered last (null when none yet). */
  lastWorkingEngineId(): string | null {
    const ok = [...this.attempts].reverse().find((a) => a.ok);
    return ok ? ok.engineId : null;
  }

  isAvailable(): boolean {
    return this.engines.some((e) => {
      try {
        return e.isAvailable();
      } catch {
        return false;
      }
    });
  }

  status(): LocalSttStatus {
    for (const engine of this.engines) {
      try {
        const s = engine.status();
        if (s.available) return s;
      } catch {
        // Keep looking.
      }
    }
    return {
      available: false,
      engineId: null,
      binaryPath: null,
      modelPath: null,
      reason: `No local STT engine is available (tried: ${this.chainIds().join(', ') || 'none'}).`,
    };
  }

  async transcribe(pcm16: Uint8Array, opts?: LocalSttTranscribeOptions): Promise<string> {
    if (!isValidPcm16Frame(pcm16)) {
      throw new Error('FallbackSttEngine: audio must be a non-empty even-length PCM16 buffer.');
    }
    this.attempts = [];
    const errors: string[] = [];
    for (let i = 0; i < this.engines.length; i++) {
      const engine = this.engines[i];
      const started = Date.now();
      try {
        if (!engine.isAvailable()) {
          this.attempts.push({ engineId: engine.id, ok: false, ms: Date.now() - started, error: 'unavailable' });
          errors.push(`${engine.id}: unavailable`);
          continue;
        }
        const text = await engine.transcribe(pcm16, opts);
        this.attempts.push({ engineId: engine.id, ok: true, ms: Date.now() - started });
        if (i > 0) this.fallbacksUsed += 1;
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.attempts.push({ engineId: engine.id, ok: false, ms: Date.now() - started, error: message });
        errors.push(`${engine.id}: ${message}`);
      }
    }
    throw new Error(
      `FallbackSttEngine: all local STT engines failed (${errors.join(' | ') || 'no engines configured'}).`,
    );
  }
}

/**
 * A TTS engine that tries a chain in order and returns the first
 * `spoken: true`. Attempts are recorded; a total failure returns
 * `spoken: false` with the chain named in the reason (the transcript
 * still flows — speech is best-effort, silence is not an error in
 * the call).
 */
export class FallbackTtsEngine implements TtsEngine {
  readonly id = 'fallback-tts';
  readonly name = 'Fallback speech';
  readonly kind: 'system' | 'mock';
  private readonly engines: TtsEngine[];
  private attempts: FallbackAttempt[] = [];
  private fallbacksUsed = 0;
  private active: TtsEngine | null = null;

  constructor(engines: TtsEngine[]) {
    this.engines = [...engines];
    this.kind = engines.every((e) => e.kind === 'mock') ? 'mock' : 'system';
  }

  chainIds(): string[] {
    return this.engines.map((e) => e.id);
  }

  getAttempts(): FallbackAttempt[] {
    return this.attempts.map((a) => ({ ...a }));
  }

  getFallbacksUsed(): number {
    return this.fallbacksUsed;
  }

  lastWorkingEngineId(): string | null {
    const ok = [...this.attempts].reverse().find((a) => a.ok);
    return ok ? ok.engineId : null;
  }

  async isAvailable(): Promise<boolean> {
    for (const engine of this.engines) {
      try {
        if (await engine.isAvailable()) return true;
      } catch {
        // Keep looking.
      }
    }
    return false;
  }

  async speak(text: string, opts?: TtsSpeakOptions): Promise<TtsSpeakResult> {
    const clean = String(text ?? '').trim();
    if (!clean) return { spoken: false, engineId: this.id, reason: 'empty-text' };
    this.attempts = [];
    this.active = null;
    const errors: string[] = [];
    for (let i = 0; i < this.engines.length; i++) {
      const engine = this.engines[i];
      const started = Date.now();
      try {
        if (!(await engine.isAvailable())) {
          this.attempts.push({ engineId: engine.id, ok: false, ms: Date.now() - started, error: 'unavailable' });
          errors.push(`${engine.id}: unavailable`);
          continue;
        }
        this.active = engine;
        const result = await engine.speak(text, opts);
        this.attempts.push({
          engineId: engine.id,
          ok: result.spoken,
          ms: Date.now() - started,
          ...(result.spoken ? {} : { error: result.reason ?? 'not spoken' }),
        });
        if (result.spoken) {
          if (i > 0) this.fallbacksUsed += 1;
          return { ...result };
        }
        errors.push(`${engine.id}: ${result.reason ?? 'not spoken'}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.attempts.push({ engineId: engine.id, ok: false, ms: Date.now() - started, error: message });
        errors.push(`${engine.id}: ${message}`);
      }
    }
    this.active = null;
    return {
      spoken: false,
      engineId: this.id,
      reason: `all TTS engines failed (${errors.join(' | ') || 'no engines configured'})`,
    };
  }

  async stop(): Promise<boolean> {
    if (!this.active?.stop) return false;
    try {
      return await this.active.stop();
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface LocalVoiceEnginesReport {
  stt: { chain: string[]; active: string | null; fallbacksUsed: number; available: boolean };
  tts: { chain: string[]; active: string | null; fallbacksUsed: number; available: boolean };
  probedAt: number;
}

/**
 * The registry: every local voice engine this machine knows, with
 * a probe each. `pickChain()` returns the available engines in
 * order — caller-preferred ids first, then built-in priority —
 * which is exactly what the fallback engines take. Probing is
 * cheap (PATH scans + file checks) and never runs audio.
 */
export class LocalVoiceEngineRegistry {
  private readonly descriptors = new Map<string, VoiceEngineDescriptor>();

  register(descriptor: VoiceEngineDescriptor): void {
    this.descriptors.set(`${descriptor.kind}:${descriptor.id}`, descriptor);
  }

  list(kind?: VoiceEngineKind): VoiceEngineDescriptor[] {
    return [...this.descriptors.values()]
      .filter((d) => !kind || d.kind === kind)
      .sort((a, b) => a.priority - b.priority);
  }

  async probeAll(kind?: VoiceEngineKind): Promise<VoiceEngineProbe[]> {
    const out: VoiceEngineProbe[] = [];
    for (const descriptor of this.list(kind)) {
      try {
        out.push(await descriptor.probe());
      } catch (err) {
        out.push({
          id: descriptor.id,
          kind: descriptor.kind,
          label: descriptor.label,
          available: false,
          reason: err instanceof Error ? err.message : 'Probe failed.',
          binaryPath: null,
          modelPath: null,
        });
      }
    }
    return out;
  }

  /**
   * Available engines of a kind, in chain order: preferred ids
   * first (in the given order), then the rest by priority. Unknown
   * preferred ids are ignored, never an error.
   */
  async pickChain(kind: VoiceEngineKind, preferredIds: string[] = []): Promise<VoiceEngineDescriptor[]> {
    const probes = await this.probeAll(kind);
    const available = new Map(probes.filter((p) => p.available).map((p) => [p.id, p]));
    const byId = new Map(this.list(kind).map((d) => [d.id, d]));
    const ordered: VoiceEngineDescriptor[] = [];
    for (const id of preferredIds) {
      const d = byId.get(id);
      if (d && available.has(id) && !ordered.includes(d)) ordered.push(d);
    }
    for (const d of this.list(kind)) {
      if (available.has(d.id) && !ordered.includes(d)) ordered.push(d);
    }
    return ordered;
  }

  /** Build the fallback STT engine from the picked chain. */
  async createFallbackStt(preferredIds: string[] = []): Promise<FallbackSttEngine> {
    const chain = await this.pickChain('stt', preferredIds);
    return new FallbackSttEngine(chain.map((d) => d.createStt?.()).filter((e): e is LocalSttEngine => !!e));
  }

  /** Build the fallback TTS engine from the picked chain. */
  async createFallbackTts(preferredIds: string[] = []): Promise<FallbackTtsEngine> {
    const chain = await this.pickChain('tts', preferredIds);
    return new FallbackTtsEngine(chain.map((d) => d.createTts?.()).filter((e): e is TtsEngine => !!e));
  }
}

/** TTS binaries in the v0.83 family, in priority order. */
export const SYSTEM_TTS_ENGINE_IDS: readonly string[] = [
  'espeak-ng',
  'espeak',
  'spd-say',
  'say',
  'flite',
];

/**
 * Registry with the built-in engines: whisper-cli + vosk + mock
 * for STT; piper + the eSpeak family + mock for TTS. Probing reads
 * the real PATH, so on this machine the report is honest about
 * what is actually installed (whisper: binary + model in
 * ~/.cache/whisper; piper/vosk: almost certainly missing).
 */
export function createDefaultLocalVoiceRegistry(pathEnv?: string): LocalVoiceEngineRegistry {
  const registry = new LocalVoiceEngineRegistry();
  registry.register({
    id: 'whisper-cli',
    kind: 'stt',
    label: 'Whisper (whisper.cpp)',
    priority: 10,
    probe: () => {
      const status = detectLocalStt().status();
      return {
        id: 'whisper-cli',
        kind: 'stt' as const,
        label: 'Whisper (whisper.cpp)',
        available: status.available,
        reason: status.reason ?? null,
        binaryPath: status.binaryPath,
        modelPath: status.modelPath,
      };
    },
    createStt: () => detectLocalStt(),
  });
  registry.register({
    id: 'vosk',
    kind: 'stt',
    label: 'Vosk',
    priority: 20,
    probe: () => {
      const engine = new VoskSttEngine({ pathEnv });
      const s = engine.status();
      return {
        id: 'vosk',
        kind: 'stt' as const,
        label: 'Vosk',
        available: s.available,
        reason: s.reason ?? null,
        binaryPath: s.binaryPath,
        modelPath: s.modelPath,
      };
    },
    createStt: () => new VoskSttEngine({ pathEnv }),
  });
  registry.register({
    id: 'mock-stt',
    kind: 'stt',
    label: 'Mock STT',
    priority: 100,
    probe: () => ({
      id: 'mock-stt',
      kind: 'stt' as const,
      label: 'Mock STT',
      available: true,
      reason: null,
      binaryPath: null,
      modelPath: null,
    }),
    createStt: () => new MockLocalSttEngine(),
  });
  registry.register({
    id: 'piper',
    kind: 'tts',
    label: 'Piper',
    priority: 10,
    probe: async () => {
      const engine = new PiperTtsEngine({ pathEnv });
      const available = await engine.isAvailable();
      return {
        id: 'piper',
        kind: 'tts' as const,
        label: 'Piper',
        available,
        reason: available
          ? null
          : 'Piper needs its binary, a voice model (.onnx, PIPER_MODEL_PATH) and an audio player.',
        binaryPath: findBinaryOnPath('piper', pathEnv),
        modelPath: process.env.PIPER_MODEL_PATH ?? null,
      };
    },
    createTts: () => new PiperTtsEngine({ pathEnv }),
  });
  // The eSpeak family is one engine: `SystemTtsEngine` picks the
  // first binary on PATH itself, so the registry holds a single
  // 'system-tts' entry (probe reports which binary it found) —
  // five entries would try the same engine five times.
  registry.register({
    id: 'system-tts',
    kind: 'tts',
    label: 'System speech (eSpeak / spd-say / say / flite)',
    priority: 20,
    probe: () => {
      for (const binary of SYSTEM_TTS_ENGINE_IDS) {
        const found = findBinaryOnPath(binary, pathEnv);
        if (found) {
          return {
            id: 'system-tts',
            kind: 'tts' as const,
            label: 'System speech (eSpeak / spd-say / say / flite)',
            available: true,
            reason: null,
            binaryPath: found,
            modelPath: null,
          };
        }
      }
      return {
        id: 'system-tts',
        kind: 'tts' as const,
        label: 'System speech (eSpeak / spd-say / say / flite)',
        available: false,
        reason: `No system speech binary found (${SYSTEM_TTS_ENGINE_IDS.join(', ')}).`,
        binaryPath: null,
        modelPath: null,
      };
    },
    createTts: () => new SystemTtsEngine(),
  });
  registry.register({
    id: 'mock-tts',
    kind: 'tts',
    label: 'Mock TTS',
    priority: 100,
    probe: () => ({
      id: 'mock-tts',
      kind: 'tts' as const,
      label: 'Mock TTS',
      available: true,
      reason: null,
      binaryPath: null,
      modelPath: null,
    }),
    createTts: () => new MockTtsEngine(),
  });
  return registry;
}

/**
 * Probe the machine once and report the chains: which engines are
 * available, in which order the fallback would try them. No audio
 * runs, no network.
 */
export async function detectLocalVoiceEngines(
  registry: LocalVoiceEngineRegistry = createDefaultLocalVoiceRegistry(),
): Promise<LocalVoiceEnginesReport> {
  const sttChain = await registry.pickChain('stt');
  const ttsChain = await registry.pickChain('tts');
  const stt = new FallbackSttEngine(sttChain.map((d) => d.createStt?.()).filter((e): e is LocalSttEngine => !!e));
  const tts = new FallbackTtsEngine(ttsChain.map((d) => d.createTts?.()).filter((e): e is TtsEngine => !!e));
  return {
    stt: {
      chain: stt.chainIds(),
      active: null,
      fallbacksUsed: 0,
      available: stt.isAvailable(),
    },
    tts: {
      chain: tts.chainIds(),
      active: null,
      fallbacksUsed: 0,
      available: await tts.isAvailable(),
    },
    probedAt: Date.now(),
  };
}
