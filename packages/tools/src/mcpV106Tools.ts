/**
 * MCP 2.0 agent tools, wave 2 (v1.06, Đội T2).
 *
 * Exposes the v1.06 stateless surface to the agent as ordinary tools:
 *
 *   - `mcp2_version_features` — ma trận tính năng của một protocol
 *     version (pure: không cần server, không chạm network).
 *   - `mcp2_server_age` — detect tuổi server + chiến lược kết nối
 *     (stateless hay handshake fallback) qua `server/discover` /
 *     `initialize` với mode `'auto'`.
 *   - `mcp2_check_elicitation_schema` — kiểm tra schema elicitation
 *     có xin secret qua form-mode không (dry-run, không hỏi user,
 *     không gửi gì đi) — server nào xin secret qua form là vi phạm
 *     spec, phải đi URL-mode.
 *   - `mcp2_task_update` — gửi input cho task đang `input_required`
 *     (`tasks/update`, Tasks extension 2026-07-28).
 *   - `mcp2_list_deprecated` — liệt kê method MCP đã deprecated
 *     phía client (Roots/Sampling/Logging) + thay thế + ngày gỡ.
 *   - `mcp2_probe_stateless` — chẩn đoán một server HTTP ở mode
 *     stateless (discover + tools/list, đếm session header bị bỏ).
 *
 * Safety: live tools (`mcp2_server_age`, `mcp2_task_update`, `mcp2_probe_stateless`) chỉ nói
 * với server trong workspace `.open-bot/mcp.json` (cùng quy tắc như
 * `mcpV097Tools.ts` — agent không tự bịa command/URL). Mỗi lần gọi
 * mở một client ngắn hạn rồi đóng ngay; không cache connection, không
 * credential nào xuất hiện trong kết quả. `mcp2_task_update` cần
 * approval như `mcp_call_tool` vì nó tiếp tục một tác vụ bên ngoài.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import { connectMcp } from '@open-bot/core/dist/mcp/client';
import { loadMcpConfig } from '@open-bot/core/dist/mcp/config';
import type { McpServerConfig } from '@open-bot/core/dist/mcp/types';
import {
  chooseConnectionStrategy,
  describeVersionSupport,
  detectServerAge,
  featuresForVersion,
  MCP_VERSION_FEATURES,
  MCP_VERSION_FEATURE_LABELS,
} from '@open-bot/core/dist/mcp/legacyVersions';
import { findSensitiveElicitationFields } from '@open-bot/core/dist/mcp/mrtrElicitation';
import {
  CLIENT_DEPRECATED_METHODS,
} from '@open-bot/core/dist/mcp/clientDeprecation';
import { MCP_DEPRECATION_REMOVE_AFTER } from '@open-bot/core/dist/mcp/deprecation';
import {
  describeStatelessProbe,
  probeStatelessServer,
} from '@open-bot/core/dist/mcp/statelessProbe';
import { truncateText as truncate } from './truncate';

function getStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Tool argument "${name}" is required and must be a non-empty string.`);
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Tool argument "${name}" must be an object.`);
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

export function createMcpV106Tools(): Tool[] {
  const versionFeaturesTool: Tool = {
    definition: {
      name: 'mcp2_version_features',
      description:
        'List which MCP features a protocol version supports (2024-11-05, 2025-06-18, ' +
        '2025-11-25, 2026-07-28): stateless, server/discover, MRTR, Tasks extension, ' +
        'elicitation form/url, Apps, roots, sampling, logging, structured output, pagination. ' +
        'Use before calling a feature to check the server version supports it.',
      parameters: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            description: 'Protocol version, e.g. "2026-07-28" or "2025-11-25".',
          },
        },
        required: ['version'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      const version = getStringArg(args, 'version');
      const features = featuresForVersion(version);
      const supported = MCP_VERSION_FEATURES.filter((f) => features[f]);
      const missing = MCP_VERSION_FEATURES.filter((f) => !features[f]);
      const lines = [
        `MCP protocol version ${version}:`,
        `- supported: ${supported.map((f) => MCP_VERSION_FEATURE_LABELS[f]).join(', ') || '(none)'}`,
        `- missing: ${missing.map((f) => MCP_VERSION_FEATURE_LABELS[f]).join(', ') || '(none)'}`,
        describeVersionSupport(version),
      ];
      return truncate(lines.join('\n'));
    },
  };

  const serverAgeTool: Tool = {
    definition: {
      name: 'mcp2_server_age',
      description:
        'Detect how old a configured MCP server is and which connection strategy to use: ' +
        'modern (2026-07-28) servers speak stateless via server/discover; legacy servers ' +
        '(2025-11-25 and older) fall back to the initialize handshake. Reports the negotiated ' +
        'mode, protocol version, and any features that will be missing. ' +
        'The server comes only from .open-bot/mcp.json.',
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
      const server = getServerConfig(ctx.workspaceDir, serverName);
      const client = await connectMcp({ ...server, name: serverName, stateless: 'auto' });
      try {
        const negotiation = client.statelessNegotiation;
        const protocolVersion =
          client.negotiatedProtocolVersion ?? negotiation?.protocolVersion ?? '(unknown)';
        const discovered = negotiation?.discovered ?? null;
        const detection = detectServerAge(
          protocolVersion === '(unknown)' ? undefined : protocolVersion,
          discovered?.capabilities as Record<string, unknown> | undefined,
        );
        const strategy = chooseConnectionStrategy(detection, 'auto');
        const lines = [
          `MCP server "${serverName}":`,
          `- age: ${detection.age} (${detection.note})`,
          `- negotiated: ${negotiation ? `${negotiation.mode} (protocol ${negotiation.protocolVersion})` : 'handshake (no negotiation record)'}`,
          `- strategy: ${strategy.path} — ${strategy.reason}`,
        ];
        if (strategy.fellBack) lines.push('- fell back from stateless to handshake (pre-2.0 server).');
        for (const warning of strategy.warnings) lines.push(`- warning: ${warning}`);
        lines.push(describeVersionSupport(protocolVersion === '(unknown)' ? undefined : protocolVersion));
        return truncate(lines.join('\n'));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const checkElicitationSchemaTool: Tool = {
    definition: {
      name: 'mcp2_check_elicitation_schema',
      description:
        'Check an elicitation requestedSchema for sensitive fields (password, API key, token, ' +
        'credit card) that must NEVER be asked through form-mode. Returns the sensitive field ' +
        'names when found (the request must be refused and routed to URL-mode instead), or ' +
        'confirms the schema is safe for form-mode. Dry-run only — asks nobody, sends nothing.',
      parameters: {
        type: 'object',
        properties: {
          schema: {
            type: 'object',
            description: 'The requestedSchema object sent by the server (JSON Schema with properties).',
          },
        },
        required: ['schema'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      const schema = getObjectArg(args, 'schema');
      const sensitive = findSensitiveElicitationFields(schema);
      if (sensitive.length === 0) {
        return 'Elicitation schema is safe for form-mode: no sensitive field (password / API key / token / payment) found.';
      }
      return (
        `REFUSE: elicitation schema asks for sensitive data through form-mode: ${sensitive.join(', ')}. ` +
        `Form-mode must never be used for secrets — route this request to URL-mode (OAuth / provider page) instead.`
      );
    },
  };

  const taskUpdateTool: Tool = {
    definition: {
      name: 'mcp2_task_update',
      description:
        'Send input to a long-running MCP task waiting for input (status input_required) via ' +
        'tasks/update (MCP Tasks extension 2026-07-28). The server comes only from ' +
        '.open-bot/mcp.json. Needs approval: it continues an external task.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          taskId: { type: 'string', description: 'Task id in input_required status.' },
          input: { type: 'object', description: 'Input object to send to the task.' },
        },
        required: ['server', 'taskId', 'input'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const taskId = getStringArg(args, 'taskId');
      const input = getObjectArg(args, 'input');
      const server = getServerConfig(ctx.workspaceDir, serverName);
      const client = await connectMcp({ ...server, name: serverName, stateless: 'auto' });
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const raw = await client.requestJsonRpc('tasks/update', { taskId, input });
        return truncate(`Task ${taskId} on "${serverName}" updated:\n${JSON.stringify(raw, null, 2)}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const listDeprecatedTool: Tool = {
    definition: {
      name: 'mcp2_list_deprecated',
      description:
        'List MCP methods deprecated in MCP 2.0 on the client side (Roots / Sampling / Logging) ' +
        'with their replacements and removal date. New code must use MRTR follow-ups instead. ' +
        'Pure lookup — no server needed.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute() {
      const lines = [
        `Deprecated MCP client methods (removal not before ${MCP_DEPRECATION_REMOVE_AFTER}):`,
      ];
      for (const meta of CLIENT_DEPRECATED_METHODS) {
        lines.push(
          `- ${meta.method} [${meta.capability}] (since ${meta.deprecatedIn}): ${meta.reason} Use instead: ${meta.replacement}`,
        );
      }
      return truncate(lines.join('\n'));
    },
  };

  const probeTool: Tool = {
    definition: {
      name: 'mcp2_probe_stateless',
      description:
        'Probe a configured HTTP MCP server in stateless mode (server/discover + tools/list). ' +
        'Reports the protocol version, capabilities, extensions, tool count, and how many ' +
        'Mcp-Session-Id headers the server sent (dropped — a non-stateless server). ' +
        'Read-only: sends no credentials and keeps no connection. Only works for servers ' +
        'with a URL in .open-bot/mcp.json (stdio servers are rejected with a clear error).',
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
      const server = getServerConfig(ctx.workspaceDir, serverName);
      if (!server.url) {
        throw new Error(
          `MCP server "${serverName}" has no URL (stdio server) — mcp2_probe_stateless only probes HTTP servers.`,
        );
      }
      const result = await probeStatelessServer(server.url);
      return truncate(describeStatelessProbe(result));
    },
  };

  return [
    versionFeaturesTool,
    serverAgeTool,
    checkElicitationSchemaTool,
    taskUpdateTool,
    listDeprecatedTool,
    probeTool,
  ];
}

/** Unbound placeholders (same pattern as MCP_TOOLS / MCP_V097_TOOLS). */
export const MCP_V106_TOOLS: Tool[] = createMcpV106Tools();
