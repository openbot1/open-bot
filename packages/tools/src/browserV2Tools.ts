/**
 * Agent tools cho browser driver v2 (v1.33, Đội T4).
 *
 * 7 tool mới (nối tiếp 8 tool của browser v1, KHÔNG thay thế chúng —
 * v1 dùng CSS selector, v2 dùng ref trong a11y-tree):
 *
 *  - `browser_snapshot` — snapshot a11y-tree (full lần đầu, diff sau).
 *  - `browser_click_ref` — click theo ref (vd `e3`).
 *  - `browser_type_ref` — gõ text theo ref (từ chối secret/token).
 *  - `browser_click_at` — click theo tọa độ (vision fallback).
 *  - `browser_v2_status` — trạng thái session (cache/gate/vision).
 *  - `browser_egress_check` — hỏi gate có cho submit form tới URL
 *    đó không (không submit thật).
 *  - `browser_v2_eval` — chạy bộ WebVoyager-local (fixture, không
 *    mạng) và trả báo cáo % success + cost/task + steps/task.
 *
 * Một session v2 dùng chung cho mỗi factory call (giống v1): browser
 * mở lazy, đóng sau idle timeout. `browser_navigate` của v1 vẫn là
 * cách đổi trang (session v2 dùng chung gate nên navigate qua v1 cũng
 * nên đi qua session v2 — tool `browser_snapshot` tự navigate? Không:
 * tool snapshot yêu cầu đã navigate trước bằng `browser_navigate` v1
 * hoặc dùng MCP server mode; để tự đủ, session v2 expose thêm
 * `browser_v2_navigate`? Quyết định: KHÔNG thêm tool navigate trùng
 * — `browser_snapshot` khi chưa có trang sẽ báo lỗi hướng dẫn dùng
 * `browser_navigate` trước. Nhưng session v2 và session v1 là 2
 * browser khác nhau... Để tránh nhầm lẫn đó, tools v2 tự quản lý
 * navigation bằng cách expose `browser_v2_navigate` (1 tool nữa, tổng
 * 8 tool v2) — cùng session, cùng gate, cùng cache.
 *
 * Tổng cộng 8 tool v2: v2_navigate, snapshot, click_ref, type_ref,
 * click_at, v2_status, egress_check, v2_eval.
 *
 * An toàn: mọi navigation qua gate + SSRF guard của v1; click_ref /
 * type_ref kiểm tra ref có trong snapshot mới nhất (không click mù);
 * click_at validate tọa độ trong viewport; type_ref từ chối secret.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';
import { looksLikeSecretToken } from './computerUse';
import { BrowserV2Session, type BrowserV2Options } from './browserV2/driverV2';
import {
  runWebVoyagerEval,
  renderWebVoyagerReport,
  WEBVOYAGER_TASKS,
} from './browserV2/webVoyagerEval';

export { MAX_TOOL_RESULT_CHARS };

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

function getNumberArg(args: Record<string, unknown>, name: string, required = true): number {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return 0;
  }
  if (typeof value !== 'number') {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

/** Options của factory (mở rộng BrowserV2Options, mặc định dùng session v2). */
export type BrowserV2ToolsOptions = BrowserV2Options;

export interface BrowserV2ToolsSession {
  tools: Tool[];
  session: BrowserV2Session;
  /** Đóng browser ngay (no-op khi đã đóng). */
  close(): Promise<void>;
}

export function createBrowserV2ToolsSession(
  opts: BrowserV2ToolsOptions = {},
): BrowserV2ToolsSession {
  const session = new BrowserV2Session(opts);

  const navigateTool: Tool = {
    definition: {
      name: 'browser_v2_navigate',
      description:
        'Navigate the v2 browser session to a URL (same session as browser_snapshot / browser_click_ref). ' +
        'The URL must pass the egress allowlist gate and the SSRF guard; navigation outside the allowlist is blocked and logged. ' +
        'Use data:text/html pages for local test pages.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open (http(s) to an allowlisted host, or a data:text/html page). Max 8000 chars.',
          },
        },
        required: ['url'],
      },
    },
    needsApproval: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        const url = getStringArg(args, 'url');
        const finalUrl = await session.navigate(url, ctx);
        return `Navigated to ${finalUrl}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const snapshotTool: Tool = {
    definition: {
      name: 'browser_snapshot',
      description:
        'Capture the accessibility-tree snapshot of the current page in the v2 browser session. ' +
        'First call (or after navigation) returns the full snapshot; later calls return only the DIFF vs the previous step, to save tokens. ' +
        'Every interactive element has a [ref=eN] — use it with browser_click_ref / browser_type_ref. ' +
        'Elements with no ARIA role do not appear here — use browser_screenshot (v1) + browser_click_at for those. ' +
        'Navigate first with browser_v2_navigate.',
      parameters: {
        type: 'object',
        properties: {
          forceFull: {
            type: 'boolean',
            description: 'Return the full snapshot instead of the diff (default: false).',
          },
        },
        required: [],
      },
    },
    needsApproval: false,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        if (!session.isOpen()) {
          return errorResult(
            'No page open in the v2 browser session yet. Navigate first with browser_v2_navigate.',
          );
        }
        const snap = await session.snapshot({ forceFull: getBooleanArg(args, 'forceFull') }, ctx);
        const header =
          `Snapshot (${snap.payload.kind}) — ${snap.url} — ${snap.nodeCount} nodes, ` +
          `~${snap.payload.tokens} tokens.`;
        return truncate(`${header}\n${snap.payload.text}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const clickRefTool: Tool = {
    definition: {
      name: 'browser_click_ref',
      description:
        'Click an element in the current page by its snapshot ref (e.g. "e3" from browser_snapshot). ' +
        'Fails when the ref is not in the accessibility tree — use browser_click_at with coordinates from a screenshot instead. ' +
        'A click that navigates outside the egress allowlist is blocked by the gate.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3").' },
        },
        required: ['ref'],
      },
    },
    needsApproval: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        return await session.clickRef(getStringArg(args, 'ref'), ctx);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const typeRefTool: Tool = {
    definition: {
      name: 'browser_type_ref',
      description:
        'Type text into an element by its snapshot ref (textbox, searchbox, combobox — e.g. "e3" from browser_snapshot). ' +
        'Must NEVER be used to type passwords, secrets or API keys (refused when the text looks like a long random token).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3").' },
          text: { type: 'string', description: 'Text to type (max 1000 characters). Must not be a password, secret or token.' },
        },
        required: ['ref', 'text'],
      },
    },
    needsApproval: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        const text = getStringArg(args, 'text');
        if (looksLikeSecretToken(text)) {
          return errorResult(
            'Refusing to type text that looks like a secret/token. Never type passwords, secrets or API keys with browser_type_ref.',
          );
        }
        return await session.typeRef(getStringArg(args, 'ref'), text, ctx);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const clickAtTool: Tool = {
    definition: {
      name: 'browser_click_at',
      description:
        'Vision fallback: click at viewport coordinates (x, y) in CSS pixels. ' +
        'Use ONLY when the element has no ARIA role and therefore no ref in browser_snapshot ' +
        '(canvas, pure SVG, CSS-drawn widgets) — take a browser_screenshot first to find the coordinates. ' +
        'Coordinates outside the viewport are refused. A click that navigates outside the egress allowlist is blocked.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate in CSS pixels (viewport, 0-based).' },
          y: { type: 'number', description: 'Y coordinate in CSS pixels (viewport, 0-based).' },
        },
        required: ['x', 'y'],
      },
    },
    needsApproval: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      try {
        return await session.clickAt(getNumberArg(args, 'x'), getNumberArg(args, 'y'), ctx);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const statusTool: Tool = {
    definition: {
      name: 'browser_v2_status',
      description:
        'Status of the v2 browser session: open/closed, current URL, step count, snapshot-cache savings (tokens saved by diffs), egress-gate checks/blocks, vision-fallback clicks. Read-only, never launches a browser.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    needsApproval: false,
    async execute(): Promise<string> {
      return session.statusSummary();
    },
  };

  const egressCheckTool: Tool = {
    definition: {
      name: 'browser_egress_check',
      description:
        'Ask the egress gate whether submitting a form to the given action URL is allowed. ' +
        'Does NOT submit anything — it only answers allowed/blocked (use before driving a form submit, ' +
        'so a malicious page cannot trick the agent into sending data to a foreign host).',
      parameters: {
        type: 'object',
        properties: {
          formAction: {
            type: 'string',
            description: 'Form action URL (absolute, or relative to the current page URL).',
          },
        },
        required: ['formAction'],
      },
    },
    needsApproval: false,
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const decision = session.checkFormSubmit(getStringArg(args, 'formAction'));
        return decision.allowed
          ? `ALLOWED: form submit to ${decision.url} (${decision.reason}).`
          : `BLOCKED: form submit to ${decision.url} — ${decision.reason}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evalTool: Tool = {
    definition: {
      name: 'browser_v2_eval',
      description:
        'Run the WebVoyager-local self-eval for the v2 browser driver (8 fixture tasks, local sandbox, no external network). ' +
        'Returns % success, avg steps/task, avg tokens/task and per-task results. ' +
        'The eval runs on a separate fixture browser session — it does not touch the agent\'s current browser page.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    needsApproval: false,
    async execute(): Promise<string> {
      try {
        const report = await runWebVoyagerEval(WEBVOYAGER_TASKS, {});
        return truncate(renderWebVoyagerReport(report));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const tools: Tool[] = [
    navigateTool,
    snapshotTool,
    clickRefTool,
    typeRefTool,
    clickAtTool,
    statusTool,
    egressCheckTool,
    evalTool,
  ];

  return {
    tools,
    session,
    close: () => session.close(),
  };
}

/** Tạo 8 tool v2 (factory — giống `createBrowserTools` của v1). */
export function createBrowserV2Tools(opts: BrowserV2ToolsOptions = {}): Tool[] {
  return createBrowserV2ToolsSession(opts).tools;
}

/** 8 tool v2 với cấu hình mặc định (đăng ký bởi coordinator). */
export const BROWSER_V2_TOOLS: Tool[] = createBrowserV2Tools();
