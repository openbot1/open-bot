/**
 * ACP hosting (v1.03, Team T3) — run an external harness as a
 * replaceable backend.
 *
 * `AcpHost` is the third ACP role from the Harness Engineering
 * survey: open-bot is the *client* and the outside harness (Gemini
 * CLI, OpenCode, Grok CLI, Cursor, Copilot, Devin, Claude Code,
 * Codex, …) is the *agent*. It builds only on existing pieces:
 * `backends.ts` (which binary + argv), `detect.ts` (probe = a real
 * `initialize` handshake, never a `--version` string match),
 * `ExternalAgentManager` (spawn/track/kill) and `AcpClient`
 * (sessions, prompts, permissions).
 *
 * Safety rules (same as the existing client side):
 * - Nothing is auto-executed: a backend only spawns when the host
 *   explicitly calls `start()` / `promptWithFallback()` with its id.
 * - Permission requests from the backend are denied by default
 *   (`AcpClient` default) unless the host passes an explicit
 *   `onPermissionRequest` callback.
 * - File access the backend asks for is answered only through the
 *   host-provided `onReadTextFile` / `onWriteTextFile` callbacks.
 * - Restart is lazy, not a background watcher: `prompt()` notices a
 *   dead backend (its process exited) and restarts it — bounded by
 *   `maxRestarts` — instead of a timer running on the turn path.
 */

import * as path from 'node:path';

import { acpBackendArgVariants, getAcpBackend, listAcpBackends, type AcpBackendDefinition } from './backends';
import { findOnPath, probeAcpAgent, type AcpAgentProbe } from './detect';
import { ExternalAgentManager, type ManagedAcpAgent } from './externalAgent';
import type { AcpClientOptions } from './client';
import type { AcpPromptResult, AcpSessionInfo, AcpSessionUpdate } from './types';

export interface AcpHostOptions {
  /** Passed through to every spawned backend's client. */
  clientOptions?: AcpClientOptions;
  /** Timeout for one probe handshake (default 10s, see detect.ts). */
  probeTimeoutMs?: number;
  /** Max lazy restarts per backend after an unexpected exit (default 2). */
  maxRestarts?: number;
  /** Backoff before a lazy restart (default 500ms). */
  restartBackoffMs?: number;
  /** Logger (default: silent). */
  logger?: (message: string) => void;
}

/** Probe result for one backend (extends the raw agent probe). */
export interface AcpBackendProbe extends Omit<AcpAgentProbe, 'id' | 'name'> {
  /** Backend id from `backends.ts` (not the binary name). */
  id: string;
  name: string;
  /** argv variant that answered, when one did. */
  args?: string[];
  /** True when open-bot already ships a driver for this backend. */
  verifiedInRepo: boolean;
}

/** A backend currently hosted by this `AcpHost`. */
export interface AcpHostedBackend {
  backendId: string;
  name: string;
  /** Managed-agent id inside `ExternalAgentManager`. */
  agentId: string;
  agentName?: string;
  agentVersion?: string;
  startedAt: string;
  /** Lazy restarts so far (unexpected exits only). */
  restarts: number;
  /** Session ids created on this backend, by cwd. */
  sessions: Record<string, string>;
}

/** Result of one hosted prompt turn. */
export interface AcpHostPromptResult {
  backendId: string;
  sessionId: string;
  /** Concatenated `agent_message_chunk` text of the turn. */
  text: string;
  stopReason: AcpPromptResult['stopReason'];
  /** Tool calls the backend reported during the turn (titles only). */
  toolCalls: string[];
  /** Last `usage_update` payload, when the backend sent one. */
  usage?: Record<string, unknown>;
}

/** One failed fallback attempt (reported, not thrown away). */
export interface AcpFallbackAttempt {
  backendId: string;
  error: string;
}

/** Status snapshot for diagnostics / the UI. */
export interface AcpHostStatus {
  hosted: AcpHostedBackend[];
  /** Backends known but not currently running. */
  available: string[];
}

/** Run an external ACP harness as a replaceable backend. */
export class AcpHost {
  private readonly manager: ExternalAgentManager;
  private readonly options: Required<Omit<AcpHostOptions, 'clientOptions' | 'logger'>> & {
    clientOptions: AcpClientOptions;
    logger?: (message: string) => void;
  };
  private readonly hosted = new Map<string, AcpHostedBackend>();
  /** argv variant that worked last time, per backend (retry it first). */
  private readonly lastGoodArgs = new Map<string, string[]>();

  constructor(options: AcpHostOptions = {}) {
    this.options = {
      clientOptions: options.clientOptions ?? {},
      probeTimeoutMs: options.probeTimeoutMs ?? 10_000,
      maxRestarts: options.maxRestarts ?? 2,
      restartBackoffMs: options.restartBackoffMs ?? 500,
      logger: options.logger,
    };
    this.manager = new ExternalAgentManager({ clientOptions: this.options.clientOptions });
  }

  private log(message: string): void {
    this.options.logger?.(`[AcpHost] ${message}`);
  }

  // ------------------------------------------------------------------
  // Detection / probing
  // ------------------------------------------------------------------

  /**
   * Probe every known backend found on PATH. A backend is reported
   * available only when a real `initialize` handshake answers with
   * protocol version 1 — a binary merely existing on PATH is not
   * enough. Tries each argv variant in order (e.g. Gemini `--acp`
   * then `--experimental-acp`).
   */
  async probeAll(backends: AcpBackendDefinition[] = listAcpBackends()): Promise<AcpBackendProbe[]> {
    const results: AcpBackendProbe[] = [];
    for (const backend of backends) {
      results.push(await this.probeOne(backend));
    }
    return results;
  }

  /** Probe a single backend (all argv variants, first success wins). */
  async probeOne(backend: AcpBackendDefinition): Promise<AcpBackendProbe> {
    const base: AcpBackendProbe = {
      id: backend.id,
      name: backend.name,
      command: backend.commands[0] ?? '',
      resolvedPath: '',
      speaksAcp: false,
      verifiedInRepo: backend.verifiedInRepo,
    };
    for (const command of backend.commands) {
      const resolved = findOnPath(command);
      if (!resolved) continue;
      for (const args of acpBackendArgVariants(backend)) {
        const probe = await probeAcpAgent(command, args, this.options.probeTimeoutMs);
        if (probe.speaksAcp) {
          this.lastGoodArgs.set(backend.id, args);
          return {
            ...base,
            command,
            resolvedPath: probe.resolvedPath,
            speaksAcp: true,
            agentName: probe.agentName,
            agentVersion: probe.agentVersion,
            args,
          };
        }
        // Keep the first resolved path + the most informative error.
        if (!base.resolvedPath) base.resolvedPath = probe.resolvedPath;
        if (!base.error) base.error = probe.error;
      }
      // A command was found but no argv variant answered: do not try
      // the next command with a stale error — report this one.
      return { ...base, command, resolvedPath: resolved, error: base.error ?? 'agent did not answer ACP initialize' };
    }
    return { ...base, error: 'not found on PATH' };
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Is this backend currently hosted (process alive)? */
  isHosted(backendId: string): boolean {
    const hosted = this.hosted.get(backendId);
    return hosted !== undefined && this.manager.get(hosted.agentId) !== undefined;
  }

  /**
   * Start (spawn + initialize) a backend. Tries argv variants in
   * order; the last working variant is tried first next time.
   * Throws when no variant initializes.
   */
  async start(backendId: string): Promise<AcpHostedBackend> {
    const backend = getAcpBackend(backendId);
    if (!backend) throw new Error(`unknown ACP backend: ${backendId}`);
    const existing = this.hosted.get(backendId);
    if (existing && this.manager.get(existing.agentId)) return existing;
    if (existing) this.hosted.delete(backendId);

    const variants = acpBackendArgVariants(backend);
    const lastGood = this.lastGoodArgs.get(backendId);
    const ordered = lastGood ? [lastGood, ...variants.filter((v) => v !== lastGood)] : variants;
    const errors: string[] = [];
    for (const command of backend.commands) {
      if (!findOnPath(command)) continue;
      for (const args of ordered) {
        try {
          const agent = await this.manager.spawn(backend.name, command, args);
          const info = agent.client.agentInfo;
          const hosted: AcpHostedBackend = {
            backendId,
            name: backend.name,
            agentId: agent.id,
            agentName: info?.agentInfo?.name,
            agentVersion: info?.agentInfo?.version,
            startedAt: new Date().toISOString(),
            restarts: existing?.restarts ?? 0,
            sessions: {},
          };
          this.hosted.set(backendId, hosted);
          this.lastGoodArgs.set(backendId, args);
          this.log(`started ${backendId} (${command} ${args.join(' ')})`);
          return hosted;
        } catch (error) {
          errors.push(`${command} ${args.join(' ')}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // A found binary that never initializes is reported, not hidden
      // behind the next binary name.
      break;
    }
    throw new Error(
      `could not start ACP backend ${backendId}: ${errors.length > 0 ? errors.join('; ') : 'not found on PATH'}`,
    );
  }

  /** Stop a hosted backend (kill its process). Returns false when not hosted. */
  stop(backendId: string): boolean {
    const hosted = this.hosted.get(backendId);
    if (!hosted) return false;
    this.hosted.delete(backendId);
    return this.manager.kill(hosted.agentId);
  }

  /** Stop every hosted backend. */
  dispose(): void {
    this.hosted.clear();
    this.manager.dispose();
  }

  /** Snapshot of hosted backends + known-but-idle backend ids. */
  status(): AcpHostStatus {
    const hosted: AcpHostedBackend[] = [];
    for (const entry of this.hosted.values()) {
      if (this.manager.get(entry.agentId)) hosted.push({ ...entry, sessions: { ...entry.sessions } });
    }
    const hostedIds = new Set(hosted.map((h) => h.backendId));
    return {
      hosted,
      available: listAcpBackends()
        .map((b) => b.id)
        .filter((id) => !hostedIds.has(id)),
    };
  }

  // ------------------------------------------------------------------
  // Sessions + prompts
  // ------------------------------------------------------------------

  /** Create (or reuse, per cwd) a session on a hosted backend. */
  async ensureSession(backendId: string, cwd: string): Promise<AcpSessionInfo> {
    const hosted = this.hosted.get(backendId);
    if (!hosted) throw new Error(`ACP backend ${backendId} is not started`);
    const agent = this.manager.get(hosted.agentId);
    if (!agent) throw new Error(`ACP backend ${backendId} exited (process gone)`);
    const existingId = hosted.sessions[cwd];
    if (existingId) {
      try {
        return await agent.client.resumeSession(existingId);
      } catch {
        // The backend forgot the session (restarted, pruned, …):
        // fall through and create a fresh one.
        delete hosted.sessions[cwd];
      }
    }
    const session = await this.manager.newSession(hosted.agentId, cwd);
    hosted.sessions[cwd] = session.sessionId;
    return session;
  }

  /**
   * Send one prompt turn to a backend (starts it first when needed,
   * restarts it lazily when its process died — bounded by
   * `maxRestarts`). Returns the turn's text + stop reason.
   */
  async prompt(
    backendId: string,
    cwd: string,
    text: string,
    opts: { onUpdate?: (update: AcpSessionUpdate) => void; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpHostPromptResult> {
    if (!path.isAbsolute(cwd)) throw new Error('AcpHost.prompt requires an absolute cwd');
    if (!this.isHosted(backendId)) {
      await this.start(backendId);
    }
    try {
      return await this.promptOnce(backendId, cwd, text, opts);
    } catch (error) {
      // A dead backend is restartable even when the manager's map has
      // not caught up yet: the process-'exit' event (which removes
      // the agent) races the transport-'end' event (which rejects the
      // pending turn), so `isHosted` alone is not reliable here. A
      // transport-closed / process-gone error means the same thing.
      const message = error instanceof Error ? error.message : String(error);
      const looksDead =
        !this.isHosted(backendId) || /transport closed|process gone|exited/i.test(message);
      if (looksDead) {
        const hosted = this.hosted.get(backendId);
        const restarts = hosted?.restarts ?? 0;
        if (restarts < this.options.maxRestarts) {
          this.hosted.delete(backendId);
          await new Promise((resolve) => setTimeout(resolve, this.options.restartBackoffMs));
          const restarted = await this.start(backendId);
          restarted.restarts = restarts + 1;
          this.log(`restarted ${backendId} after unexpected exit (${restarts + 1}/${this.options.maxRestarts})`);
          return await this.promptOnce(backendId, cwd, text, opts);
        }
      }
      throw error;
    }
  }

  private async promptOnce(
    backendId: string,
    cwd: string,
    text: string,
    opts: { onUpdate?: (update: AcpSessionUpdate) => void; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AcpHostPromptResult> {
    const hosted = this.hosted.get(backendId);
    if (!hosted) throw new Error(`ACP backend ${backendId} is not started`);
    const agent = this.manager.get(hosted.agentId);
    if (!agent) throw new Error(`ACP backend ${backendId} exited (process gone)`);
    const session = await this.ensureSession(backendId, cwd);
    const chunks: string[] = [];
    const toolCalls: string[] = [];
    let usage: Record<string, unknown> | undefined;
    const onUpdate = (update: AcpSessionUpdate) => {
      opts.onUpdate?.(update);
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        chunks.push(update.content.text);
      }
      if (update.sessionUpdate === 'tool_call' && update.title) toolCalls.push(update.title);
      if (update.sessionUpdate === 'usage_update' && update.usage) usage = update.usage;
    };
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    }
    try {
      const result = await agent.client.prompt(
        session.sessionId,
        [{ type: 'text', text }],
        onUpdate,
        controller.signal,
      );
      return { backendId, sessionId: session.sessionId, text: chunks.join(''), stopReason: result.stopReason, toolCalls, usage };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * Try backends in preference order until one completes a turn.
   * Every failure is reported in the thrown error (nothing is
   * silently swallowed): the caller sees which backends were tried
   * and why each failed.
   */
  async promptWithFallback(
    backendIds: string[],
    cwd: string,
    text: string,
    opts: { onUpdate?: (update: AcpSessionUpdate) => void; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpHostPromptResult> {
    const attempts: AcpFallbackAttempt[] = [];
    for (const backendId of backendIds) {
      try {
        return await this.prompt(backendId, cwd, text, opts);
      } catch (error) {
        attempts.push({ backendId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    throw new Error(
      `all ACP backends failed: ${attempts.map((a) => `${a.backendId} (${a.error})`).join('; ') || 'no backends given'}`,
    );
  }

  /**
   * Liveness check for one hosted backend: the process is alive and
   * answers `session/list`. Returns latency so the caller can tell a
   * slow backend from a dead one.
   */
  async health(backendId: string): Promise<{ alive: boolean; latencyMs: number; sessions: number; error?: string }> {
    const started = Date.now();
    const hosted = this.hosted.get(backendId);
    const agent = hosted ? this.manager.get(hosted.agentId) : undefined;
    if (!hosted || !agent) {
      return { alive: false, latencyMs: Date.now() - started, sessions: 0, error: 'not running' };
    }
    try {
      const sessions = await agent.client.listSessions();
      return { alive: true, latencyMs: Date.now() - started, sessions: sessions.length };
    } catch (error) {
      return {
        alive: false,
        latencyMs: Date.now() - started,
        sessions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Switch a hosted backend's session mode (see AcpClient.setMode). */
  async setMode(backendId: string, cwd: string, modeId: string): Promise<string | undefined> {
    const hosted = this.hosted.get(backendId);
    if (!hosted) throw new Error(`ACP backend ${backendId} is not started`);
    const agent = this.manager.get(hosted.agentId);
    if (!agent) throw new Error(`ACP backend ${backendId} exited (process gone)`);
    const session = await this.ensureSession(backendId, cwd);
    return agent.client.setMode(session.sessionId, modeId);
  }
}
