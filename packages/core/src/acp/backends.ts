/**
 * ACP hosting backends (v1.03, Team T3).
 *
 * One backend = one external harness that speaks ACP v1 over stdio
 * and can be hosted by open-bot as a replaceable backend (the third
 * ACP role the Harness Engineering survey calls "harness hosting":
 * OpenHands runs Claude Code / Codex / Gemini CLI as backends, and
 * reads Claude Code's plugin format).
 *
 * The spawn argv for each backend is taken from open-bot's own
 * already-verified CLI drivers (`packages/core/src/providers/cli/`)
 * where one exists — this module only collects them in one place so
 * the host, the detector and the UI agree on a single source of
 * truth. No new argv is invented here except where marked
 * `verified: false`: those two entries (Claude Code, Codex) follow
 * the survey's claim that the harness hosts them, but no driver in
 * this repo spawns them over ACP yet, so the probe (a real
 * `initialize` handshake) is the only gate — a backend that does not
 * answer is reported unavailable, never claimed.
 *
 * Nothing here spawns anything: see `hosting.ts` (`AcpHost`) and
 * `detect.ts` (`probeAcpAgent`).
 */

export interface AcpBackendDefinition {
  /** Stable id (also the id used by `AcpHost` and the tools). */
  id: string;
  /** Display name. */
  name: string;
  /** Binary name(s) to look for on PATH, in priority order. */
  commands: string[];
  /** Default argv that puts the binary into ACP stdio mode. */
  args: string[];
  /** Fallback argv tried in order when `args` fails to initialize. */
  argsAlternatives?: string[][];
  /** Short description shown in the UI. */
  description?: string;
  /**
   * True when open-bot already ships a driver that spawns this
   * backend over ACP (the argv is copied from that driver, see the
   * comment on each entry). False = survey-only, probe-gated.
   */
  verifiedInRepo: boolean;
}

/**
 * Built-in ACP hosting backends. Order = default preference order
 * for `AcpHost` fallback (most broadly installed / best-tested first
 * is NOT assumed — the host tries them in the order the caller
 * passes, this list is only the default).
 */
export const ACP_HOST_BACKENDS: AcpBackendDefinition[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    commands: ['gemini'],
    args: ['--acp'],
    argsAlternatives: [['--experimental-acp']],
    description: 'Gemini CLI in ACP mode (uses its own login).',
    // providers/cli/geminiCli.ts: GEMINI_ACP_ARGS = ['--acp'],
    // GEMINI_ACP_LEGACY_ARGS = ['--experimental-acp'].
    verifiedInRepo: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    commands: ['opencode'],
    args: ['acp'],
    description: 'OpenCode in ACP mode (uses its own login).',
    // providers/cli/opencode.ts: OPENCODE_ACP_ARGS = ['acp'].
    verifiedInRepo: true,
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    commands: ['grok'],
    args: ['--permission-mode', 'default', 'agent', 'stdio'],
    description: 'Grok CLI in ACP mode (uses its own login).',
    // providers/cli/grok.ts: GROK_ACP_ARGS.
    verifiedInRepo: true,
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    commands: ['cursor-agent', 'agent'],
    args: ['acp'],
    description: 'Cursor CLI agent in ACP mode.',
    // providers/cli/cursorCli.ts: CURSOR_ACP_ARGS = ['acp'].
    verifiedInRepo: true,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    commands: ['copilot'],
    args: ['--acp', '--stdio'],
    description: 'GitHub Copilot CLI in ACP mode.',
    // providers/cli/copilotCli.ts: COPILOT_ACP_ARGS.
    verifiedInRepo: true,
  },
  {
    id: 'devin',
    name: 'Devin CLI',
    commands: ['devin'],
    args: ['acp'],
    description: 'Devin CLI (Windsurf) in ACP mode.',
    // providers/cli/windsurf.ts: WINDSURF_ACP_ARGS = ['acp'].
    verifiedInRepo: true,
  },
  {
    id: 'claude',
    name: 'Claude Code',
    commands: ['claude'],
    args: ['--acp'],
    argsAlternatives: [['--experimental-acp']],
    description: 'Claude Code as an ACP backend (uses its own login).',
    // SURVEY-ONLY: the Harness Engineering survey reports harness
    // hosting of Claude Code over ACP, but no driver in this repo
    // spawns `claude` over ACP yet (claude.ts speaks stream-JSON).
    // Probe-gated: `AcpHost` only lists it as available after a
    // real `initialize` handshake answers.
    verifiedInRepo: false,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    commands: ['codex'],
    args: ['acp'],
    description: 'Codex CLI as an ACP backend (uses its own login).',
    // SURVEY-ONLY, same caveat as Claude Code above: codex.ts in
    // this repo drives the AppServer protocol, not ACP.
    verifiedInRepo: false,
  },
  {
    id: 'zed',
    name: 'Zed',
    commands: ['zed'],
    args: [],
    description: 'Zed editor agent (ACP over stdio).',
    // detect.ts KNOWN_ACP_AGENTS (pre-existing entry, kept here so
    // the host and the detector share one list).
    verifiedInRepo: true,
  },
];

const extraBackends: AcpBackendDefinition[] = [];

/** Register an additional hosting backend (user configuration). */
export function registerAcpBackend(backend: AcpBackendDefinition): void {
  if (!extraBackends.some((b) => b.id === backend.id)) extraBackends.push(backend);
}

/** All hosting backends (built-in + registered). */
export function listAcpBackends(): AcpBackendDefinition[] {
  return [...ACP_HOST_BACKENDS, ...extraBackends];
}

/** Find a backend by id, or undefined. */
export function getAcpBackend(id: string): AcpBackendDefinition | undefined {
  return listAcpBackends().find((b) => b.id === id);
}

/**
 * All argv variants to try for a backend, primary first.
 * A backend that only has one argv returns a single-element list.
 */
export function acpBackendArgVariants(backend: AcpBackendDefinition): string[][] {
  return [backend.args, ...(backend.argsAlternatives ?? [])];
}
