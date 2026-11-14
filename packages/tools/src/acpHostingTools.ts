/**
 * ACP hosting tools for @open-bot/tools (v1.03, Team T3).
 *
 * Tools so an agent can use the ACP hosting layer without touching
 * a process directly (same factory pattern as createHarnessV2Tools):
 *  - `acp_host_list` — list known ACP backends and whether each
 *    binary is on PATH. Read-only, no spawn, `needsApproval: false`.
 *  - `acp_host_prompt` — send one prompt turn to a hosted backend
 *    (one-shot: the backend is stopped afterwards, so no process
 *    is left running). Spawns a real process and runs the outside
 *    harness with its own login: `needsApproval: true`. Permission
 *    requests from the backend are denied (fail-closed); the
 *    backend never gets file access beyond its own session cwd.
 *  - `acp_host_audit` — run the 29-pattern harness audit and report
 *    the score per subsystem. Read-only, `needsApproval: false`.
 *  - `acp_plugin_import` — scan a directory for a Claude Code
 *    plugin (`.claude-plugin/plugin.json`) and report the mapped
 *    open-bot record + warnings. Read-only (never executes plugin
 *    code), `needsApproval: false`; the path must stay inside the
 *    workspace.
 *
 * Factory (same pattern as createHarnessV2Tools):
 *   createAcpHostingTools(opts?) -> Tool[]   (bound, usable)
 *   ACP_HOSTING_TOOLS                       (unbound placeholders)
 */

import type { Tool } from '@open-bot/core';
import {
  AcpHost,
  auditHarnessPatterns,
  auditSummaryLine,
  claudePluginToOpenBot,
  findOnPath,
  listAcpBackends,
  scanClaudePluginDir,
} from '@open-bot/core';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

export interface AcpHostingToolOptions {
  /** Default backend order for `acp_host_prompt` fallback (default: all known backends, in list order). */
  defaultBackendIds?: string[];
  /** Per-turn timeout for `acp_host_prompt` (default 120_000ms). */
  promptTimeoutMs?: number;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

const HOST_LIST_DEF = () =>
  toolDef(
    'acp_host_list',
    'List ACP hosting backends (external harnesses open-bot can run as replaceable backends: Gemini CLI, OpenCode, Grok CLI, Cursor, Copilot, Devin, Claude Code, Codex, Zed) and whether each binary is on PATH. Read-only.',
    {},
    [],
  );

const HOST_PROMPT_DEF = () =>
  toolDef(
    'acp_host_prompt',
    'Send one prompt turn to a hosted ACP backend (an external harness running with its own login) and return its reply. One-shot: the backend process is stopped afterwards. Needs approval: it spawns a real process.',
    {
      backendId: { type: 'string', description: 'Backend id (optional; omit to try backends in default order until one answers).' },
      text: { type: 'string', description: 'The prompt text to send.' },
      cwd: { type: 'string', description: 'Working directory for the session (optional; defaults to the workspace).' },
    },
    ['text'],
  );

const HOST_AUDIT_DEF = () =>
  toolDef(
    'acp_host_audit',
    'Run the 29-pattern harness audit (Harness Engineering survey) against open-bot and report the score per subsystem plus every partial/missing pattern. Read-only.',
    {},
    [],
  );

const PLUGIN_IMPORT_DEF = () =>
  toolDef(
    'acp_plugin_import',
    'Scan a directory inside the workspace for a Claude Code plugin (.claude-plugin/plugin.json) and report the mapped open-bot plugin record, its commands/agents/skills/hooks and any warnings. Read-only: plugin code is never executed.',
    {
      dir: { type: 'string', description: 'Plugin directory, relative to the workspace (or absolute inside it).' },
    },
    ['dir'],
  );

export const ACP_HOSTING_TOOLS: Tool[] = [
  {
    definition: HOST_LIST_DEF(),
    needsApproval: false,
    async execute() {
      return errorResult('acp_host_list is not bound — use createAcpHostingTools().');
    },
  },
  {
    definition: HOST_PROMPT_DEF(),
    needsApproval: true,
    async execute() {
      return errorResult('acp_host_prompt is not bound — use createAcpHostingTools().');
    },
  },
  {
    definition: HOST_AUDIT_DEF(),
    needsApproval: false,
    async execute() {
      return errorResult('acp_host_audit is not bound — use createAcpHostingTools().');
    },
  },
  {
    definition: PLUGIN_IMPORT_DEF(),
    needsApproval: false,
    async execute() {
      return errorResult('acp_plugin_import is not bound — use createAcpHostingTools().');
    },
  },
];

export function createAcpHostingTools(opts: AcpHostingToolOptions = {}): Tool[] {
  const defaultBackendIds = opts.defaultBackendIds ?? listAcpBackends().map((b) => b.id);
  const promptTimeoutMs = opts.promptTimeoutMs ?? 120_000;

  const hostList: Tool = {
    definition: HOST_LIST_DEF(),
    needsApproval: false,
    async execute() {
      try {
        const lines: string[] = ['ACP hosting backends:'];
        for (const backend of listAcpBackends()) {
          const found = backend.commands.map((c) => findOnPath(c)).find((p) => p !== undefined);
          lines.push(
            `- ${backend.id} (${backend.name}): ${found ? `on PATH at ${found}` : 'not installed'}` +
              ` — ${backend.description ?? ''}` +
              (backend.verifiedInRepo ? '' : ' [argv unverified in this repo — probe-gated]'),
          );
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const hostPrompt: Tool = {
    definition: HOST_PROMPT_DEF(),
    needsApproval: true,
    async execute(args, ctx) {
      const host = new AcpHost();
      try {
        const text = getStringArg(args, 'text');
        const backendId = getOptionalStringArg(args, 'backendId');
        const cwd = getOptionalStringArg(args, 'cwd') ?? ctx.workspaceDir;
        const ids = backendId ? [backendId] : defaultBackendIds;
        const result = await host.promptWithFallback(ids, cwd, text, { timeoutMs: promptTimeoutMs });
        const lines = [
          `Backend: ${result.backendId} (session ${result.sessionId}, stop: ${result.stopReason})`,
          result.toolCalls.length > 0 ? `Tool calls: ${result.toolCalls.join(', ')}` : 'Tool calls: none',
          '',
          result.text || '(no text reply)',
        ];
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      } finally {
        host.dispose();
      }
    },
  };

  const hostAudit: Tool = {
    definition: HOST_AUDIT_DEF(),
    needsApproval: false,
    async execute() {
      try {
        const report = auditHarnessPatterns();
        const lines: string[] = [`Harness audit (29 patterns): ${auditSummaryLine(report)}`, ''];
        for (const row of report.bySubsystem) {
          lines.push(`- ${row.subsystem}: ${row.present} present / ${row.partial} partial / ${row.missing} missing (${row.total})`);
        }
        const gaps = report.patterns.filter((p) => p.status !== 'present');
        if (gaps.length > 0) {
          lines.push('', 'Partial / missing:');
          for (const p of gaps) lines.push(`- ${p.id} ${p.name} [${p.status}]: ${p.note}`);
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const pluginImport: Tool = {
    definition: PLUGIN_IMPORT_DEF(),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const dirArg = getStringArg(args, 'dir');
        const dir = resolveWithin(ctx.workspaceDir, dirArg);
        const scanned = scanClaudePluginDir(dir);
        if (!scanned.value) {
          return errorResult(`not a Claude Code plugin directory: ${scanned.errors.join('; ')}`);
        }
        const record = claudePluginToOpenBot(scanned.value);
        const lines = [
          `Plugin: ${record.id} v${record.version}`,
          `Description: ${record.description}`,
          record.author ? `Author: ${record.author}` : 'Author: —',
          `Commands: ${record.commands.map((c) => c.name).join(', ') || 'none'}`,
          `Agents: ${record.agents.map((a) => a.name).join(', ') || 'none'}`,
          `Skills: ${record.skills.map((s) => s.name).join(', ') || 'none'}`,
          `Hook events: ${record.hookEvents.join(', ') || 'none'}`,
          `MCP servers: ${Object.keys(record.mcpServers).join(', ') || 'none'}`,
        ];
        if (record.missingFiles.length > 0) {
          lines.push(`Missing files (declared but not on disk): ${record.missingFiles.join(', ')}`);
        }
        if (record.warnings.length > 0) {
          lines.push('Warnings:');
          for (const warning of record.warnings) lines.push(`- ${warning}`);
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [hostList, hostPrompt, hostAudit, pluginImport];
}
