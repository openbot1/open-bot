/**
 * MCP 2026-07-28 tools (v1.10, Team T2).
 *
 * Exposes the new MCP 2026-07-28 surface to the agent as ordinary
 * tools, so the model can use it without the coordinator writing new
 * glue for each operation:
 *
 * MRTR 2026 (`resultType: "input_required"` bắt buộc):
 *   - `mcp_mrtr_input_required` — call a tool through the
 *     InputRequired loop; answers for each round come from the tool
 *     arguments (`answers`), the original request is retried with the
 *     answer + server state each round.
 *   - `mcp_mrtr_validate_result` — pure check: does a result object
 *     carry the mandatory `resultType` (complete / input_required)?
 *
 * Tasks extension `io.modelcontextprotocol/tasks`:
 *   - `mcp_tasks_wait` — create a task and wait for completion,
 *     auto-answering `input_required` rounds from `inputs`
 *     (`tasks/update` under the hood).
 *   - `mcp_tasks_send_input` — `tasks/update` for a known taskId.
 *   - `mcp_tasks_auto_background` — run a remote tool call with
 *     auto-background: slow calls go to background at once, stream
 *     progress events, poll to completion, and return the result as
 *     if the call had been synchronous.
 *
 * Files extension draft `io.modelcontextprotocol/files`:
 *   - `mcp_files_upload` / `mcp_files_download` / `mcp_files_info` /
 *     `mcp_files_list` / `mcp_files_delete` — byte files in and out
 *     of the model, chunked, in the workspace-confined store
 *     (`.open-bot/mcp-files/`).
 *
 * Safety: remote servers come only from the workspace
 * `.open-bot/mcp.json` (same rule as `mcpTools.ts` — the agent never
 * invents a command). Every server call opens a short-lived stateless
 * client and closes it afterwards; no credential ever appears in a
 * result. Tools that call an external tool or continue an external
 * task need approval; pure local reads do not.
 */
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { connectMcp } from '@open-bot/core/dist/mcp/client';
import { loadMcpConfig } from '@open-bot/core/dist/mcp/config';
import type { McpServerConfig } from '@open-bot/core/dist/mcp/types';
import {
  parseSpecResult2026,
  runToolCallInputRequired,
  InputRequiredError,
  type InputRequest,
} from '@open-bot/core/dist/mcp/inputRequired';
import {
  createTask,
  TaskError,
  type TaskHandleData,
} from '@open-bot/core/dist/mcp/tasks';
import {
  LocalBackgroundTaskRegistry,
} from '@open-bot/core/dist/mcp/autoBackgroundTasks';
import {
  McpFilesStore,
  MCP_FILES_DEFAULT_MAX_FILE_BYTES,
} from '@open-bot/core/dist/mcp/files';
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

function getNumberArg(args: Record<string, unknown>, name: string, defaultValue: number): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Tool argument "${name}" must be a non-negative number.`);
  }
  return value;
}

function getAnswersArg(args: Record<string, unknown>, name: string): Array<{ answer: unknown; state?: unknown }> {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Tool argument "${name}" must be an array of { answer, state? }.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Tool argument "${name}[${index}]" must be an object with an "answer".`);
    }
    const record = entry as Record<string, unknown>;
    if (!('answer' in record)) {
      throw new Error(`Tool argument "${name}[${index}]" is missing "answer".`);
    }
    return {
      answer: record['answer'],
      ...(record['state'] !== undefined ? { state: record['state'] } : {}),
    };
  });
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
  return connectMcp({ ...server, name: serverName, stateless: 'auto' });
}

/** Files store root for a workspace (workspace-confined, no traversal). */
function filesRoot(workspaceDir: string): string {
  return path.join(workspaceDir, '.open-bot', 'mcp-files');
}

function formatResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
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

export function createMcpV110Tools(): Tool[] {
  const backgroundRegistry = new LocalBackgroundTaskRegistry();

  const mrtrInputRequiredTool: Tool = {
    definition: toolDef(
      'mcp_mrtr_input_required',
      'Call a tool on an MCP server (2026-07-28) through the InputRequired loop: when the server ' +
        'answers resultType "input_required", the call is retried with the next answer from "answers" ' +
        'plus the server state, for as many rounds as needed. The server comes only from ' +
        '.open-bot/mcp.json. Needs approval: it calls an external tool.',
      {
        server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        name: { type: 'string', description: 'Tool name on the server.' },
        arguments: { type: 'object', description: 'Arguments for the tool call.' },
        answers: {
          type: 'array',
          description:
            'Answers for input_required rounds, in order: [{ answer, state? }]. ' +
            'Round 1 uses answers[0], round 2 uses answers[1], and so on. ' +
            'The server must not ask for more rounds than answers given.',
          items: { type: 'object' },
        },
        maxRounds: { type: 'number', description: 'Maximum input rounds (default 8).' },
      },
      ['server', 'name'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const toolName = getStringArg(args, 'name');
      const toolArgs = getObjectArg(args, 'arguments');
      const answers = getAnswersArg(args, 'answers');
      const maxRounds = getNumberArg(args, 'maxRounds', 8);
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const outcome = await runToolCallInputRequired(
          {
            requestJsonRpc: (method, params) => client.requestJsonRpc!(method, params),
          },
          toolName,
          toolArgs,
          async (request: InputRequest, round: number) => {
            const entry = answers[round - 1];
            if (!entry) {
              throw new InputRequiredError(
                `Server "${serverName}" asked for input at round ${round}` +
                  (request.prompt ? ` ("${request.prompt}")` : '') +
                  ' but no answer was supplied in "answers" — add one more { answer } and retry.',
                'input_required',
                round,
              );
            }
            return { answer: entry.answer, ...(entry.state !== undefined ? { state: entry.state } : {}) };
          },
          { maxRounds: Math.max(1, Math.floor(maxRounds)) },
        );
        return truncate(
          `Tool "${toolName}" on "${serverName}" finished after ${outcome.rounds} round(s):\n` +
            formatResult(outcome.result),
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const mrtrValidateTool: Tool = {
    definition: toolDef(
      'mcp_mrtr_validate_result',
      'Check whether a result object follows the MCP 2026-07-28 contract: every result must carry ' +
        'a mandatory "resultType" ("complete" or "input_required"). Pure local check, no server call.',
      {
        result: { type: 'object', description: 'The result object to validate.' },
      },
      ['result'],
    ),
    needsApproval: false,
    async execute(args) {
      const raw = args['result'];
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return 'Invalid: a 2026-07-28 result must be an object with a mandatory "resultType".';
      }
      try {
        const parsed = parseSpecResult2026(raw);
        if (parsed.resultType === 'complete') {
          return (
            'Valid: resultType "complete".' +
            (parsed.roundTripId ? ` roundTripId: ${parsed.roundTripId}.` : '') +
            (parsed.note ? ` note: ${parsed.note}` : '')
          );
        }
        return (
          'Valid: resultType "input_required".' +
            (parsed.input.prompt ? ` Server asks: "${parsed.input.prompt}".` : ' Server asks for input.') +
            (parsed.input.schema ? ' An answer schema is attached (answer will be validated).' : '') +
            (parsed.roundTripId ? ` roundTripId: ${parsed.roundTripId}.` : '')
        );
      } catch (err) {
        return `Invalid: ${(err as Error).message}`;
      }
    },
  };

  const tasksWaitTool: Tool = {
    definition: toolDef(
      'mcp_tasks_wait',
      'Create a long-running task on an MCP server (tools/call as a task) and wait for it to finish, ' +
        'auto-answering input_required rounds from "inputs" via tasks/update (Tasks extension 2026-07-28). ' +
        'The server comes only from .open-bot/mcp.json. Needs approval: it calls an external tool.',
      {
        server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        name: { type: 'string', description: 'Tool name on the server.' },
        arguments: { type: 'object', description: 'Arguments for the tool call.' },
        inputs: {
          type: 'array',
          description:
            'Answers for input_required rounds, in order. Round 1 uses inputs[0], round 2 uses inputs[1]. ' +
            'Each entry is the input object sent via tasks/update.',
          items: { type: 'object' },
        },
        timeoutMs: { type: 'number', description: 'Total wait timeout in ms (default 120000).' },
      },
      ['server', 'name'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const toolName = getStringArg(args, 'name');
      const toolArgs = getObjectArg(args, 'arguments');
      const inputs = getAnswersArg(args, 'inputs').map((entry) => entry.answer);
      const timeoutMs = getNumberArg(args, 'timeoutMs', 120_000);
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const transport = {
          request: (method: string, params?: Record<string, unknown>) =>
            client.requestJsonRpc!(method, params),
        };
        let inputRound = 0;
        const handle = await createTask(
          transport,
          'tools/call',
          { name: toolName, arguments: toolArgs },
          { specVersion: '2026-07-28' },
        );
        const { result } = await handle.waitForCompletion({
          timeoutMs,
          onInputRequired: async (task: TaskHandleData) => {
            const answer = inputs[inputRound];
            inputRound += 1;
            if (answer === undefined) {
              throw new TaskError(
                `Task ${task.taskId} on "${serverName}" asked for input at round ${inputRound} ` +
                  'but no input was supplied in "inputs" — add one more input object and retry.',
                task.taskId,
                'input_required',
              );
            }
            return answer;
          },
        });
        return truncate(
          `Task ${handle.taskId} on "${serverName}" completed` +
            (inputRound > 0 ? ` (answered ${inputRound} input round(s))` : '') +
            `:\n${formatResult(result)}`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const tasksSendInputTool: Tool = {
    definition: toolDef(
      'mcp_tasks_send_input',
      'Send input to a long-running MCP task waiting for input (status input_required) via ' +
        'tasks/update (MCP Tasks extension 2026-07-28). The server comes only from ' +
        '.open-bot/mcp.json. Needs approval: it continues an external task.',
      {
        server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        taskId: { type: 'string', description: 'Task id in input_required status.' },
        input: { type: 'object', description: 'Input object to send to the task.' },
      },
      ['server', 'taskId', 'input'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const taskId = getStringArg(args, 'taskId');
      const input = getObjectArg(args, 'input');
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
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

  const tasksAutoBackgroundTool: Tool = {
    definition: toolDef(
      'mcp_tasks_auto_background',
      'Call a tool on an MCP server with auto-background: if the call is slower than "thresholdMs" it ' +
        'keeps running in the background (progress is streamed as poll events) and this tool waits ' +
        'until it finishes, returning the result exactly as a synchronous call would. ' +
        'The server comes only from .open-bot/mcp.json. Needs approval: it calls an external tool.',
      {
        server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        name: { type: 'string', description: 'Tool name on the server.' },
        arguments: { type: 'object', description: 'Arguments for the tool call.' },
        thresholdMs: { type: 'number', description: 'Slow-call threshold in ms (default 1500).' },
        timeoutMs: { type: 'number', description: 'Total timeout in ms (default 120000).' },
      },
      ['server', 'name'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const serverName = getStringArg(args, 'server');
      const toolName = getStringArg(args, 'name');
      const toolArgs = getObjectArg(args, 'arguments');
      const thresholdMs = getNumberArg(args, 'thresholdMs', 1500);
      const timeoutMs = getNumberArg(args, 'timeoutMs', 120_000);
      const client = await openStatelessClient(ctx.workspaceDir, serverName);
      try {
        if (typeof client.requestJsonRpc !== 'function') {
          throw new Error(`MCP server "${serverName}" does not expose a raw JSON-RPC call.`);
        }
        const outcome = await backgroundRegistry.run(
          async (taskCtx) => {
            taskCtx.reportProgress(10, `Calling "${toolName}" on "${serverName}"...`);
            const raw = await client.requestJsonRpc!('tools/call', {
              name: toolName,
              arguments: toolArgs,
            });
            taskCtx.reportProgress(100, 'Done.');
            return raw;
          },
          {
            label: `mcp:${serverName}:${toolName}`,
            thresholdMs,
            timeoutMs,
          },
        );
        return truncate(
          `Tool "${toolName}" on "${serverName}" finished` +
            (outcome.backgrounded
              ? ` in the background (${outcome.polls} poll(s), ${outcome.durationMs}ms)`
              : ` synchronously (${outcome.durationMs}ms)`) +
            `:\n${formatResult(outcome.result)}`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };

  const filesUploadTool: Tool = {
    definition: toolDef(
      'mcp_files_upload',
      'Upload bytes to the workspace Files store (MCP Files extension draft io.modelcontextprotocol/files): ' +
        'the content travels as base64 and is stored chunked, outside the model context. ' +
        'Returns the file metadata (fileId, size, sha256). Needs approval: it writes a file into the workspace.',
      {
        name: { type: 'string', description: 'File name, e.g. "report.md". No path separators, no "..".' },
        contentBase64: { type: 'string', description: 'File content as base64.' },
        mimeType: { type: 'string', description: 'Optional MIME type (guessed from the name when omitted).' },
      },
      ['name', 'contentBase64'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const name = getStringArg(args, 'name');
      const contentBase64 = getStringArg(args, 'contentBase64');
      const mimeType = getOptionalStringArg(args, 'mimeType');
      if (contentBase64.length > Math.ceil((MCP_FILES_DEFAULT_MAX_FILE_BYTES * 4) / 3) + 1024) {
        return `Error: content exceeds the ${MCP_FILES_DEFAULT_MAX_FILE_BYTES} byte file limit.`;
      }
      const store = new McpFilesStore(filesRoot(ctx.workspaceDir));
      try {
        const meta = store.uploadBytes(name, contentBase64, mimeType);
        return (
          `Uploaded "${meta.name}" to the Files store:\n` +
          `- fileId: ${meta.fileId}\n` +
          `- size: ${meta.sizeBytes} bytes (${meta.chunks} chunk(s))\n` +
          `- sha256: ${meta.sha256Hex}\n` +
          `- mimeType: ${meta.mimeType}`
        );
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  };

  const filesDownloadTool: Tool = {
    definition: toolDef(
      'mcp_files_download',
      'Download a chunk of a file from the workspace Files store (MCP Files extension draft) as base64. ' +
        'Use offset/length to page through large files without loading them into the model context.',
      {
        fileId: { type: 'string', description: 'File id from mcp_files_upload (file-<16 hex>).' },
        offset: { type: 'number', description: 'Start byte offset (default 0).' },
        length: { type: 'number', description: 'Max bytes to read (default 1 MiB, the chunk limit).' },
      },
      ['fileId'],
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const fileId = getStringArg(args, 'fileId');
      const offset = getNumberArg(args, 'offset', 0);
      const length = getNumberArg(args, 'length', 1024 * 1024);
      const store = new McpFilesStore(filesRoot(ctx.workspaceDir));
      try {
        const chunk = store.downloadChunk(fileId, Math.floor(offset), Math.floor(length));
        return truncate(
          `File ${fileId}: bytes ${chunk.offset}..${chunk.offset + chunk.length - 1} of ${chunk.totalBytes}` +
            (chunk.eof ? ' (end of file)' : ' (more bytes follow)') +
            `:\n${chunk.dataBase64}`,
        );
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  };

  const filesInfoTool: Tool = {
    definition: toolDef(
      'mcp_files_info',
      'Show metadata for a file in the workspace Files store (name, size, sha256, MIME type, chunk count).',
      {
        fileId: { type: 'string', description: 'File id from mcp_files_upload (file-<16 hex>).' },
      },
      ['fileId'],
    ),
    needsApproval: false,
    async execute(args, ctx: ToolContext) {
      const fileId = getStringArg(args, 'fileId');
      const store = new McpFilesStore(filesRoot(ctx.workspaceDir));
      try {
        const meta = store.getFile(fileId);
        return (
          `File ${meta.fileId}:\n` +
          `- name: ${meta.name}\n` +
          `- size: ${meta.sizeBytes} bytes (${meta.chunks} chunk(s))\n` +
          `- sha256: ${meta.sha256Hex}\n` +
          `- mimeType: ${meta.mimeType}`
        );
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  };

  const filesListTool: Tool = {
    definition: toolDef(
      'mcp_files_list',
      'List files in the workspace Files store (newest first), with size and sha256 for each file.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx: ToolContext) {
      const store = new McpFilesStore(filesRoot(ctx.workspaceDir));
      const files = store.listFiles();
      if (files.length === 0) return 'The Files store is empty.';
      return (
        `${files.length} file(s) in the Files store:\n` +
        files
          .map((f) => `- ${f.fileId} — ${f.name} (${f.sizeBytes} bytes, sha256 ${f.sha256Hex.slice(0, 12)}…)`)
          .join('\n')
      );
    },
  };

  const filesDeleteTool: Tool = {
    definition: toolDef(
      'mcp_files_delete',
      'Delete a file from the workspace Files store (file + metadata). Needs approval: it deletes a workspace file.',
      {
        fileId: { type: 'string', description: 'File id from mcp_files_upload (file-<16 hex>).' },
      },
      ['fileId'],
    ),
    needsApproval: true,
    async execute(args, ctx: ToolContext) {
      const fileId = getStringArg(args, 'fileId');
      const store = new McpFilesStore(filesRoot(ctx.workspaceDir));
      const deleted = store.deleteFile(fileId);
      return deleted ? `Deleted file ${fileId} from the Files store.` : `No file ${fileId} in the Files store.`;
    },
  };

  return [
    mrtrInputRequiredTool,
    mrtrValidateTool,
    tasksWaitTool,
    tasksSendInputTool,
    tasksAutoBackgroundTool,
    filesUploadTool,
    filesDownloadTool,
    filesInfoTool,
    filesListTool,
    filesDeleteTool,
  ];
}

/** Unbound placeholders (same pattern as MCP_TOOLS / MCP_V097_TOOLS). */
export const MCP_V110_TOOLS: Tool[] = createMcpV110Tools();
