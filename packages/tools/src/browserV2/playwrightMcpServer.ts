/**
 * Playwright MCP server mode — expose browser control thành MCP tool cho
 * mọi MCP client (v1.33, Đội T4).
 *
 * Tương thích chuẩn Playwright MCP (Microsoft): cùng tên tool
 * (`browser_navigate`, `browser_snapshot`, `browser_click`,
 * `browser_type`, `browser_screenshot`, ...) và cùng quy ước snapshot
 * a11y-tree có ref. Khác biệt có chủ đích so với Playwright MCP gốc:
 * mọi tool call đều đi qua `BrowserV2Session` nên được hưởng egress
 * gate + snapshot-diff cache của driver v2 (Playwright MCP gốc không
 * có egress allowlist).
 *
 * Protocol: MCP 2025-11-25, transport stdio (NDJSON, một JSON object
 * mỗi dòng; log ra stderr, KHÔNG bao giờ ra stdout — giống
 * `packages/core/src/mcp/server.ts`). Hỗ trợ:
 *  - `initialize` → capabilities `{ tools: {} }` + protocolVersion echo
 *    (chấp nhận mọi version client gửi, trả lại đúng version đó).
 *  - `notifications/initialized` → no-op.
 *  - `ping` → `{}`.
 *  - `tools/list` → danh sách tool (inputSchema JSON Schema).
 *  - `tools/call` → dispatch vào session; lỗi validate/input trả
 *    `isError: true` (SEP-1303) để model tự sửa và gọi lại, không phải
 *    lỗi protocol.
 *
 * Không dùng MCP SDK chính thức (cùng quyết định với core MCP server:
 * viết tay theo spec, chỉ Node stdlib) nên module chạy được cả khi
 * caller chỉ có stdio.
 *
 * Screenshot trả về dạng `embedded resource`? Không — trả base64 PNG
 * trong `content` dạng `{ type: 'image', data, mimeType: 'image/png' }`
 * theo đúng MCP content block.
 */
import * as readline from 'node:readline';
import { BrowserV2Session, type BrowserV2Options } from './driverV2';

/** Định nghĩa một MCP tool (tên + mô tả + JSON Schema). */
export interface PlaywrightMcpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Một content block trong kết quả tools/call. */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/** Các tool MCP browser (tương thích tên Playwright MCP). */
export const PLAYWRIGHT_MCP_TOOLS: PlaywrightMcpToolDef[] = [
  {
    name: 'browser_navigate',
    description:
      'Navigate to a URL. The URL must be in the egress allowlist (or a data:text/html test page); navigation to other hosts is blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (http(s) or data:text/html).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture the accessibility-tree snapshot of the current page. Returns the full snapshot on the first call (or after navigation) and only the diff afterwards, to save tokens. Each interactive element has a [ref=eN] used by browser_click / browser_type.',
    inputSchema: {
      type: 'object',
      properties: {
        forceFull: { type: 'boolean', description: 'Return the full snapshot instead of the diff.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by its snapshot ref (e.g. "e3"). Fails when the ref is not in the accessibility tree — use browser_click_at with coordinates from a screenshot instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3").' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an element by its snapshot ref (textbox, searchbox, combobox). Never use for passwords, secrets or API keys.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3").' },
        text: { type: 'string', description: 'Text to type (max 1000 chars).' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_click_at',
    description:
      'Vision fallback: click at viewport coordinates (x, y). Use only when the element has no ARIA role and therefore no ref in the snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in CSS pixels (viewport).' },
        y: { type: 'number', description: 'Y coordinate in CSS pixels (viewport).' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current viewport (PNG, base64). Use when an element has no ARIA role and coordinates are needed for browser_click_at.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_go_back',
    description: 'Go back to the previous page in history. The back target is checked against the egress allowlist.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_evaluate_form',
    description:
      'Check whether submitting a form to the given action URL is allowed by the egress gate. Does NOT submit the form — it only answers allowed/blocked (use before driving a form submit).',
    inputSchema: {
      type: 'object',
      properties: {
        formAction: { type: 'string', description: 'Form action URL (absolute or relative to the current page).' },
      },
      required: ['formAction'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_close',
    description: 'Close the browser session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const TOOL_NAMES = new Set(PLAYWRIGHT_MCP_TOOLS.map((t) => t.name));

export interface PlaywrightMcpServerOptions {
  /** Cấu hình session v2 (egress allowlist, launcher fake/thật...). */
  session?: BrowserV2Options;
  /** Session có sẵn (test inject; ưu tiên hơn `session` options). */
  sessionInstance?: BrowserV2Session;
  /** Tên server trong initialize (mặc định 'open-bot-browser'). */
  serverName?: string;
  /** Version server (mặc định '1.33.0'). */
  serverVersion?: string;
}

/** Lỗi JSON-RPC. */
export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function getStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid required argument: "${name}" (expected a non-empty string)`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing or invalid required argument: "${name}" (expected a finite number)`);
  }
  return value;
}

/**
 * MCP server cho browser driver v2 (stdio). `handleRequest` là lõi
 * thuần (test được mà không cần stdio thật); `serveStdio` nối nó vào
 * stdin/stdout.
 */
export class PlaywrightMcpServer {
  readonly session: BrowserV2Session;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private initialized = false;

  constructor(opts: PlaywrightMcpServerOptions = {}) {
    this.session =
      opts.sessionInstance ?? new BrowserV2Session(opts.session ?? {});
    this.serverName = opts.serverName ?? 'open-bot-browser';
    this.serverVersion = opts.serverVersion ?? '1.33.0';
  }

  /** Danh sách tool (bản sao — client gọi tools/list nhận cái này). */
  listTools(): PlaywrightMcpToolDef[] {
    return PLAYWRIGHT_MCP_TOOLS.map((t) => ({
      ...t,
      inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties } },
    }));
  }

  /** Dispatch một tools/call (validate tên + args, lỗi → isError). */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!TOOL_NAMES.has(name)) {
      return errorResult(`Unknown tool "${name}". Available: ${[...TOOL_NAMES].join(', ')}`);
    }
    try {
      switch (name) {
        case 'browser_navigate': {
          const url = getStringArg(args, 'url');
          const finalUrl = await this.session.navigate(url);
          return textResult(`Navigated to ${finalUrl}`);
        }
        case 'browser_snapshot': {
          const forceFull = args['forceFull'] === true;
          const snap = await this.session.snapshot({ forceFull });
          const header =
            `Snapshot (${snap.payload.kind}) — ${snap.url} — ` +
            `${snap.nodeCount} nodes, ~${snap.payload.tokens} tokens.`;
          return textResult(`${header}\n${snap.payload.text}`);
        }
        case 'browser_click': {
          const ref = getStringArg(args, 'ref');
          return textResult(await this.session.clickRef(ref));
        }
        case 'browser_type': {
          const ref = getStringArg(args, 'ref');
          const text = getStringArg(args, 'text');
          return textResult(await this.session.typeRef(ref, text));
        }
        case 'browser_click_at': {
          const x = getNumberArg(args, 'x');
          const y = getNumberArg(args, 'y');
          return textResult(await this.session.clickAt(x, y));
        }
        case 'browser_screenshot': {
          const fullPage = args['fullPage'] === true;
          const buf = await this.session.screenshot(fullPage);
          return {
            content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }],
          };
        }
        case 'browser_go_back': {
          const url = await this.session.goBack();
          return textResult(`Went back to ${url}`);
        }
        case 'browser_evaluate_form': {
          const formAction = getStringArg(args, 'formAction');
          const decision = this.session.checkFormSubmit(formAction);
          return textResult(
            decision.allowed
              ? `Form submit to ${decision.url} is ALLOWED (${decision.reason}).`
              : `Form submit to ${decision.url} is BLOCKED: ${decision.reason}`,
          );
        }
        case 'browser_close': {
          await this.session.close();
          return textResult('Browser closed.');
        }
        default:
          return errorResult(`Tool "${name}" is listed but has no handler.`);
      }
    } catch (err) {
      return errorResult((err as Error).message);
    }
  }

  /**
   * Xử lý một JSON-RPC request (object đã parse). Trả về response
   * object, hoặc null cho notification (không có `id`).
   */
  async handleRequest(request: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = request['id'];
    const method = request['method'];
    const hasId = id !== undefined && id !== null;
    const respond = (result: unknown): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id,
      result,
    });
    const respondError = (code: number, message: string): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    if (typeof method !== 'string') {
      return hasId ? respondError(-32600, 'Invalid Request: missing method') : null;
    }
    try {
      switch (method) {
        case 'initialize': {
          const params = (request['params'] ?? {}) as Record<string, unknown>;
          const protocolVersion =
            typeof params['protocolVersion'] === 'string'
              ? (params['protocolVersion'] as string)
              : '2025-11-25';
          this.initialized = true;
          return respond({
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: this.serverName, version: this.serverVersion },
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return respond({});
        case 'tools/list':
          return respond({ tools: this.listTools() });
        case 'tools/call': {
          if (!this.initialized) {
            return hasId ? respondError(-32002, 'Server not initialized (call initialize first)') : null;
          }
          const params = (request['params'] ?? {}) as Record<string, unknown>;
          const name = params['name'];
          if (typeof name !== 'string') {
            return hasId ? respondError(-32602, 'Invalid params: tools/call requires a string "name"') : null;
          }
          const args = (params['arguments'] ?? {}) as Record<string, unknown>;
          if (typeof args !== 'object' || args === null || Array.isArray(args)) {
            return hasId ? respondError(-32602, 'Invalid params: "arguments" must be an object') : null;
          }
          const result = await this.callTool(name, args);
          return hasId ? respond(result) : null;
        }
        default: {
          if (!hasId) return null;
          return respondError(-32601, `Method not found: ${method}`);
        }
      }
    } catch (err) {
      if (!hasId) return null;
      return respondError(-32603, (err as Error).message);
    }
  }

  /** Chạy server trên stdio (NDJSON). Log ra stderr, không ra stdout. */
  async serveStdio(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        const errResp = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
        output.write(`${JSON.stringify(errResp)}\n`);
        continue;
      }
      try {
        const response = await this.handleRequest(request);
        if (response) output.write(`${JSON.stringify(response)}\n`);
      } catch (err) {
        process.stderr.write(`[open-bot-browser] request failed: ${(err as Error).message}\n`);
      }
    }
    await this.session.close().catch(() => undefined);
  }
}

/** Tạo MCP server (factory). */
export function createPlaywrightMcpServer(opts: PlaywrightMcpServerOptions = {}): PlaywrightMcpServer {
  return new PlaywrightMcpServer(opts);
}
