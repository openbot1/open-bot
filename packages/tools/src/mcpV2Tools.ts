/**
 * MCP 2.0 v1.05 agent tools (v1.05, sóng T2).
 *
 * Nối tiếp `mcp2_*` (v0.97): các tool `mcp_v2_*` phơi bày bề mặt
 * MCP 2.0 hoàn chỉnh cho agent — stateless client đầy đủ, MRTR
 * elicitation có state machine, lifecycle Tasks đầy đủ, và Apps v2
 * (prefetch + security review + sandbox v2).
 *
 * Tools:
 *   - `mcp_v2_discover_server` — `server/discover` + migration
 *     alerts (server còn dùng gì cũ, cần migrate gì).
 *   - `mcp_v2_stateless_call` — một request stateless bất kỳ
 *     (method + params); mọi request tự mang `_meta`, không
 *     handshake, không header Mcp-Session-Id.
 *   - `mcp_v2_elicitation_respond` — gọi tool qua MRTR elicitation
 *     session: server hỏi `needs_elicitation` thì trả lời bằng
 *     `values` (đã validate theo schema server gửi); session có
 *     timeout + retry.
 *   - `mcp_v2_task_create` — tạo task dài (`tools/call` dưới dạng
 *     task, Tasks extension 2026-07-28) và trả handle.
 *   - `mcp_v2_task_get` — `tasks/get` kèm progress (status,
 *     progress 0..1, message, kết quả khi completed).
 *   - `mcp_v2_task_cancel` — `tasks/cancel`.
 *   - `mcp_v2_app_prefetch` — declare app template, prefetch
 *     resource (cache manifest theo version), trả security review
 *     + sandbox policy v2.
 *
 * Safety: server chỉ lấy từ `.open-bot/mcp.json` (như mcpTools.ts
 * — agent không tự bịa command). Mọi server call mở client
 * stateless ngắn hạn rồi đóng. Tool gọi tool / tạo task cần
 * approval như `mcp_call_tool`. Prefetch chỉ fetch URI https/ui://
 * đã khai trong declaration, có timeout; không credential nào xuất
 * hiện trong kết quả.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import { connectMcp } from '@open-bot/core/dist/mcp/client';
import { loadMcpConfig } from '@open-bot/core/dist/mcp/config';
import type { McpServerConfig } from '@open-bot/core/dist/mcp/types';
import { StatelessMcpClient } from '@open-bot/core/dist/mcp/statelessClientFull';
import {
  MrtrElicitationSession,
  describeMrtrElicitationState,
} from '@open-bot/core/dist/mcp/mrtrElicitation';
import type { ElicitResult } from '@open-bot/core/dist/mcp/elicitation';
import {
  createTask,
  parseTaskHandle,
  parseTaskStatus,
} from '@open-bot/core/dist/mcp/tasks';
import { parseTaskHandleWithProgress } from '@open-bot/core/dist/mcp/taskProgress';
import {
  AppPrefetchCache,
  declareAppTemplate,
} from '@open-bot/core/dist/mcp/appsV2';
import {
  AppCacheManifest,
  buildSecurityReview,
  checkAppRunPolicy,
  validateAppTemplateDeclaration,
} from '@open-bot/core/dist/mcp/appsV2Manifest';
import { buildSandboxPolicyV2 } from '@open-bot/core/dist/mcp/appsSandboxV2';
import {
  formatMigrationAlerts,
  migrationAlertsForDiscovery,
  migrationAlertsForNegotiation,
} from '@open-bot/core/dist/mcp/mcpMigrationAlerts';
import { truncateText as truncate } from './truncate';

function getStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${name}" is required and must be a non-empty string.`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Tool argument "${name}" must be an object.`);
}

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

function getServerConfig(workspaceDir: string, serverName: string): McpServerConfig {
  const config = loadMcpConfig(workspaceDir);
  const server = config.servers[serverName];
  if (!server) {
    const known = Object.keys(config.servers);
    throw new Error(
      `MCP server "${serverName}" is not configured` +
        (known.length > 0
          ? `. Configured servers: ${known.join(', ')}.`
          : '. No MCP servers are configured yet — add one to .open-bot/mcp.json in the workspace.'),
    );
  }
  return server;
}

/** Open a short-lived stateless client for one server; caller closes it. */
async function openStatelessClient(workspaceDir: string, serverName: string) {
  const server = getServerConfig(workspaceDir, serverName);
  return connectMcp({ ...server, name: serverName, stateless: true });
}

/**
 * Open a full StatelessMcpClient (v1.05) over a connected client:
 * negotiation đã chạy trong connectMcp (stateless: true), ở đây
 * chỉ bọc lại để dùng API call/callTool/discover đầy đủ.
 */
async function openFullStatelessClient(workspaceDir: string, serverName: string) {
  const raw = await openStatelessClient(workspaceDir, serverName);
  const transport = {
    requestJsonRpc: (method: string, params?: Record<string, unknown>) => {
      if (typeof raw.requestJsonRpc !== 'function') {
        throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
      }
      return raw.requestJsonRpc(method, params);
    },
    discover: async () => {
      if (typeof raw.discover !== 'function') return null;
      return raw.discover();
    },
    initialize: async () => {
      if (typeof raw.initialize !== 'function') {
        throw new Error(`MCP server "${serverName}" does not support initialize.`);
      }
      return raw.initialize();
    },
    close: async () => {
      await raw.close().catch(() => undefined);
    },
  };
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  return { client, raw };
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createMcpV2Tools(): Tool[] {
  const discoverTool: Tool = {
    definition: {
      name: 'mcp_v2_discover_server',
      description:
        'Describe an MCP server with server/discover (MCP 2.0, no handshake, no session) ' +
        'and report migration alerts: which deprecated capabilities the server still uses ' +
        '(sampling / roots / logging / elicitation) and what replaces them. ' +
        'The server comes only from .open-bot/mcp.json — the agent cannot choose an arbitrary command.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const { client, raw } = await openFullStatelessClient(ctx.workspaceDir, serverName);
      try {
        await client.connect();
        const discovered = client.discovery;
        if (!discovered) {
          return (
            `MCP server "${serverName}" does not support server/discover (pre-2.0 server). ` +
            `It still works with stateless requests — every request carries its own _meta. ` +
            `Negotiation: ${client.describe()}`
          );
        }
        const alerts = [
          ...migrationAlertsForDiscovery(discovered),
          ...migrationAlertsForNegotiation(client.lastNegotiation!, serverName),
        ];
        const lines = [
          `MCP server "${serverName}":`,
          `- protocolVersion: ${discovered.protocolVersion}`,
          `- server: ${discovered.serverInfo.name} ${discovered.serverInfo.version}`,
          `- capabilities: ${Object.keys(discovered.capabilities).join(', ') || '(none)'}`,
          `- mode: ${client.describe()}`,
        ];
        if (discovered.supportedVersions?.length) {
          lines.push(`- supportedVersions: ${discovered.supportedVersions.join(', ')}`);
        }
        if (discovered.extensions?.length) {
          lines.push(`- extensions: ${discovered.extensions.join(', ')}`);
        }
        if (discovered.note) lines.push(`- note: ${discovered.note}`);
        lines.push('', formatMigrationAlerts(alerts));
        return truncate(lines.join('\n'));
      } finally {
        await client.close().catch(() => undefined);
        await raw.close().catch(() => undefined);
      }
    },
  };

  const statelessCallTool: Tool = {
    definition: {
      name: 'mcp_v2_stateless_call',
      description:
        'Send one self-contained stateless MCP request (MCP 2.0): no initialize handshake, ' +
        'no Mcp-Session-Id header — the request carries its own protocol version and ' +
        'capabilities in _meta. Use for any method the server offers (tools/call, ' +
        'resources/list, prompts/list, ...). Needs approval when the method can act outside the machine.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          method: { type: 'string', description: 'MCP method to call, e.g. tools/list, resources/list, prompts/list.' },
          params: { type: 'object', description: 'Params object for the method (default: {}).', additionalProperties: true },
        },
        required: ['server', 'method'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const method = getStringArg(args, 'method');
      const params = getObjectArg(args, 'params');
      const { client, raw } = await openFullStatelessClient(ctx.workspaceDir, serverName);
      try {
        await client.connect();
        const result = await client.call(method, params);
        const lines = [
          `Stateless call "${method}" on "${serverName}" (${client.describe()}):`,
          toJson(result),
        ];
        return truncate(lines.join('\n'));
      } finally {
        await client.close().catch(() => undefined);
        await raw.close().catch(() => undefined);
      }
    },
  };

  const elicitationTool: Tool = {
    definition: {
      name: 'mcp_v2_elicitation_respond',
      description:
        'Call a tool on a configured MCP server through an MRTR elicitation session (MCP 2.0). ' +
        'When the server answers needs_elicitation, the session asks the user (via the values ' +
        'given here) and sends the answer back as a follow-up round. Values are validated ' +
        'against the schema the server sent; invalid values are re-asked up to 2 times. ' +
        'Needs approval because an external MCP tool can act outside the machine.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          tool: { type: 'string', description: 'Name of the tool on that server (see mcp_list_tools).' },
          arguments: { type: 'object', description: 'Arguments object for the tool (default: {}).', additionalProperties: true },
          values: { type: 'object', description: 'Field values to answer the elicitation form (validated against the server schema).', additionalProperties: true },
          action: { type: 'string', description: 'accept (default), decline, or cancel the elicitation when the server asks.' },
          promptTimeoutMs: { type: 'number', description: 'How long to wait for the user per round in ms (default 120000).' },
          maxRounds: { type: 'number', description: 'Maximum MRTR rounds before giving up (default 8).' },
        },
        required: ['server', 'tool'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const toolName = getStringArg(args, 'tool');
      const toolArgs = getObjectArg(args, 'arguments');
      const values = getObjectArg(args, 'values');
      const actionRaw = getOptionalStringArg(args, 'action') ?? 'accept';
      if (actionRaw !== 'accept' && actionRaw !== 'decline' && actionRaw !== 'cancel') {
        throw new Error(`Tool argument "action" must be accept, decline, or cancel.`);
      }
      const action = actionRaw as ElicitResult['action'];
      const promptTimeoutMs = getNumberArg(args, 'promptTimeoutMs', 120_000, 1000);
      const maxRounds = getNumberArg(args, 'maxRounds', 8, 1);
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const transport = {
          requestJsonRpc: (method: string, params?: Record<string, unknown>) =>
            client.requestJsonRpc!(method, params),
        };
        const prompt = async (): Promise<ElicitResult | null> => {
          if (action === 'cancel') return null;
          if (action === 'decline') return { action: 'decline' };
          return { action: 'accept', content: { ...values } };
        };
        const session = new MrtrElicitationSession(transport, {
          serverName,
          prompt,
          promptTimeoutMs,
          maxRounds,
          onStateChange: (state) => {
            // State được ghi vào log của session; outcome cuối tóm tắt lại.
            void describeMrtrElicitationState(state);
          },
        });
        const outcome = await session.run('tools/call', { name: toolName, arguments: toolArgs });
        const resultText =
          typeof outcome.result === 'string' ? outcome.result : toJson(outcome.result);
        return truncate(
          `MRTR elicitation call to "${toolName}" on "${serverName}": ` +
            `state=${outcome.state} (${describeMrtrElicitationState(outcome.state)}), ` +
            `rounds=${outcome.rounds}.\n${resultText ?? ''}`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const taskCreateTool: Tool = {
    definition: {
      name: 'mcp_v2_task_create',
      description:
        'Create a long-running MCP task: run a tool call as a task (Tasks extension 2026-07-28, ' +
        'tasks/get returns the final result, tasks/update sends input). Returns the task handle ' +
        '(taskId, status, pollInterval). Poll it with mcp_v2_task_get, cancel with mcp_v2_task_cancel. ' +
        'Needs approval because an external MCP tool can act outside the machine.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          tool: { type: 'string', description: 'Name of the tool to run as a task (see mcp_list_tools).' },
          arguments: { type: 'object', description: 'Arguments object for the tool (default: {}).', additionalProperties: true },
          ttlMs: { type: 'number', description: 'Desired task lifetime in ms (optional).' },
          pollIntervalMs: { type: 'number', description: 'Default poll interval in ms when the server gives no hint (default 1000).' },
        },
        required: ['server', 'tool'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const toolName = getStringArg(args, 'tool');
      const toolArgs = getObjectArg(args, 'arguments');
      const ttlMs = typeof args['ttlMs'] === 'number' ? args['ttlMs'] : undefined;
      const pollIntervalMs = getNumberArg(args, 'pollIntervalMs', 1000, 10);
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const transport = {
          request: (method: string, params?: Record<string, unknown>) =>
            client.requestJsonRpc!(method, params),
        };
        const handle = await createTask(
          transport,
          'tools/call',
          { name: toolName, arguments: toolArgs },
          {
            ...(ttlMs !== undefined ? { ttlMs } : {}),
            pollIntervalMs,
            specVersion: '2026-07-28',
          },
        );
        return truncate(
          `Task created on "${serverName}" for tool "${toolName}":\n` +
            `- taskId: ${handle.taskId}\n- status: ${handle.status}\n` +
            `- pollIntervalMs: ${handle.pollIntervalMs}\n- specVersion: 2026-07-28`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const taskGetTool: Tool = {
    definition: {
      name: 'mcp_v2_task_get',
      description:
        'Get a long-running MCP task (tasks/get, Tasks extension 2026-07-28): status, progress ' +
        '(0..1 when the server reports it), progress message, and the final result when completed.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          taskId: { type: 'string', description: 'Task id returned by mcp_v2_task_create.' },
        },
        required: ['server', 'taskId'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const taskId = getStringArg(args, 'taskId');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const raw = await client.requestJsonRpc('tasks/get', { taskId });
        const { handle, progress, progressMessage } = parseTaskHandleWithProgress(raw);
        const status = parseTaskStatus(handle.status);
        const lines = [
          `Task ${taskId} on "${serverName}":`,
          `- status: ${status}`,
          `- pollIntervalMs: ${handle.pollInterval ?? '—'}`,
        ];
        if (progress !== undefined) lines.push(`- progress: ${Math.round(progress * 100)}%`);
        if (progressMessage) lines.push(`- progressMessage: ${progressMessage}`);
        if (handle.status === 'completed' && handle.result !== undefined) {
          lines.push(`- result: ${typeof handle.result === 'string' ? handle.result : toJson(handle.result)}`);
        }
        return truncate(lines.join('\n'));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const taskCancelTool: Tool = {
    definition: {
      name: 'mcp_v2_task_cancel',
      description:
        'Cancel a long-running MCP task on a configured server (tasks/cancel, Tasks extension 2026-07-28).',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          taskId: { type: 'string', description: 'Task id to cancel.' },
        },
        required: ['server', 'taskId'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const taskId = getStringArg(args, 'taskId');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const raw = await client.requestJsonRpc('tasks/cancel', { taskId });
        let status = 'cancelled';
        try {
          const parsed = parseTaskHandle(raw);
          status = parsed.status;
        } catch {
          // Server trả body rỗng — huỷ là best-effort, coi như đã huỷ.
        }
        return `Task ${taskId} on "${serverName}": ${status}.`;
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const appPrefetchTool: Tool = {
    definition: {
      name: 'mcp_v2_app_prefetch',
      description:
        'Declare an MCP App template (Apps v2), prefetch its resources into the versioned cache ' +
        'manifest, and report the security review (permissions the app requests: tools, roots, ' +
        'network) plus the sandbox policy v2 (CSP + iframe flags). Prefetch only fetches ' +
        'https:// or ui:// URIs declared in the template, with a 10s timeout per resource. ' +
        'Does not render the app — use the result to decide whether to run it.',
      parameters: {
        type: 'object',
        properties: {
          template: {
            type: 'object',
            description: 'App template declaration: { id, serverName, title, prefetch?: [{uri, purpose?}], cache?: {maxAgeSec}, allowedActions?: [], allowedHosts?: [] }.',
            additionalProperties: true,
          },
          version: { type: 'string', description: 'App version for the cache manifest (e.g. 1.2.0). When it changes, the old prefetch cache is invalidated.' },
        },
        required: ['template', 'version'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      const version = getStringArg(args, 'version');
      const rawTemplate = args['template'];
      const declaration = validateAppTemplateDeclaration(rawTemplate);
      const template = declareAppTemplate(declaration);
      const cache = new AppPrefetchCache();
      const manifest = new AppCacheManifest();
      const invalidation = manifest.invalidateOnVersionChange(template, version, cache);
      const fetcher = async (uri: string): Promise<string> => {
        if (uri.startsWith('ui://')) {
          throw new Error(`ui:// resource "${uri}" is app-local — no network fetch.`);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        timer.unref?.();
        try {
          const res = await fetch(uri, { signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.text();
        } finally {
          clearTimeout(timer);
        }
      };
      const report = await cache.prefetch(template, fetcher);
      manifest.recordPrefetch(template, version, [...report.fetched, ...report.skipped]);
      const review = buildSecurityReview(template, { version });
      const policy = buildSandboxPolicyV2(template);
      const runPolicy = checkAppRunPolicy(template);
      const lines = [
        `MCP App "${template.title}" (${template.id}, v${version}, server "${template.serverName}"):`,
        `- fingerprint: ${template.fingerprint.slice(0, 12)}… (full: ${template.fingerprint})`,
        `- review: ${template.review}`,
        `- prefetch: ${report.fetched.length} fetched, ${report.skipped.length} cached, ${report.failed.length} failed`,
      ];
      for (const failed of report.failed) {
        lines.push(`  - failed: ${failed.uri} (${failed.error})`);
      }
      if (invalidation.invalidated) lines.push(`- cache: ${invalidation.reason}`);
      lines.push(`- cache manifest: ${manifest.size} entr${manifest.size === 1 ? 'y' : 'ies'}, ${cache.stats().bytes} bytes`);
      lines.push(`- security review: risk=${review.risk}, requiresWarning=${review.requiresWarning}`);
      for (const permission of review.permissions) {
        lines.push(`  - permission ${permission.kind}: ${permission.label}${permission.detail ? ` (${permission.detail})` : ''}`);
      }
      for (const warning of review.warnings) lines.push(`  - warning: ${warning}`);
      lines.push(`- run policy: ${runPolicy.allowed ? 'allowed' : 'DENIED'}${runPolicy.needsConfirmation ? ' (needs user confirmation)' : ''} — ${runPolicy.reason}`);
      lines.push(`- sandbox v2: ${policy.cspString}`);
      lines.push(`  flags: ${policy.sandboxFlags.join(' ')}`);
      for (const note of policy.notes) lines.push(`  - ${note}`);
      return truncate(lines.join('\n'));
    },
  };

  return [
    discoverTool,
    statelessCallTool,
    elicitationTool,
    taskCreateTool,
    taskGetTool,
    taskCancelTool,
    appPrefetchTool,
  ];
}

/** Unbound placeholders (same pattern as MCP_V097_TOOLS). */
export const MCP_V2_TOOLS: Tool[] = createMcpV2Tools();
