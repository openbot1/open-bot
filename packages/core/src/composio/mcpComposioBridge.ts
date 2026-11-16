/**
 * Composio → MCP Apps/Tasks bridge v1.14 (Doi T4).
 *
 * Noi MCP Apps/Tasks v1.13 (MCP Apps: app chay trong sandboxed
 * iframe qua `ui://` URI; Tasks: method chay dai co taskId +
 * status `working`/`completed`/`failed`/`cancelled`) voi Composio
 * mock v114: moi tool mock v114 co mot MCP App (URI
 * `ui://composio/<toolkit>/<TOOL_SLUG>`) mo bang `mcp_apps_open`,
 * va moi lan chay tool la mot MCP Task co taskId xac dinh.
 *
 * Chi phia CLIENT goi Composio MOCK:
 * - App HTML la HTML tinh (khong script, khong link ngoai, khong
 *   goi mang) — chi hien ten tool + mo ta + huong dan; viec chay
 *   tool that do Task runner lam qua `MockComposioV114Executor`.
 * - Task chay hoan toan local bang du lieu mau; response luon mang
 *   `mock: true, live: false`. Khong co key, khong co goi mang.
 * - App/Task KHONG tao trigger instance, KHONG ket noi OAuth —
 *   chuyen doi do user lam trong Composio dashboard nhu truoc.
 *
 * Module nay khong import MCP host (AppManager/AppBridgeHost) de
 * tranh vong tron phu thuoc: no chi sinh dinh danh + HTML + task
 * record; host that (`mcp_apps_open` / `mcp_tasks_create`) nhan
 * cac gia tri nay nhu input binh thuong.
 */

import type { TaskStatus } from '../mcp/tasks';
import {
  COMPOSIO_V114_MOCK_TOOLKITS,
  MockComposioV114Executor,
  findMockComposioV114Toolkit,
  isMockComposioV114Slug,
  mockComposioV114DeterministicId,
  mockComposioV114ToolNeedsApproval,
  type MockComposioV114Result,
} from './toolkitsV114';
import type { McpAppV112Category } from '../mcp/appsCatalogV112';

/** Server id ma bridge nay dang ky app duoi (de host phan biet nguon). */
export const COMPOSIO_V114_MCP_APP_SERVER_ID = 'composio-mock-v114';
/** Tien to URI cua app Composio mock. */
export const COMPOSIO_V114_MCP_APP_URI_PREFIX = 'ui://composio/';
/** Tong so MCP App Composio mock v114 (6 toolkit x 10 tool). */
export const COMPOSIO_V114_MCP_APP_COUNT = 60;

/** Nhom MCP App theo toolkit (dung category cua catalogue v112). */
export const COMPOSIO_V114_MCP_APP_CATEGORIES: Readonly<Record<string, McpAppV112Category>> = {
  webflow: 'productivity',
  pipedrive: 'productivity',
  chargebee: 'data',
  xero: 'data',
  eventbrite: 'productivity',
  surveymonkey: 'data',
};

/** URI cua mot MCP App Composio mock. */
export function composioV114McpAppUri(toolkit: string, toolSlug: string): string {
  return `${COMPOSIO_V114_MCP_APP_URI_PREFIX}${toolkit}/${toolSlug}`;
}

/** App id on dinh cua mot MCP App Composio mock. */
export function composioV114McpAppId(toolkit: string, toolSlug: string): string {
  return `composio-${toolkit}-${toolSlug.toLowerCase().replace(/_/g, '-')}`;
}

/** Dinh nghia mot MCP App cho mot tool Composio mock v114. */
export interface ComposioV114McpAppDef {
  /** Id on dinh, vd 'composio-webflow-webflow-list-sites'. */
  appId: string;
  /** URI mo app: 'ui://composio/<toolkit>/<TOOL_SLUG>'. */
  uri: string;
  /** Tieu de hien thi trong App list. */
  title: string;
  /** Slug toolkit Composio. */
  toolkit: string;
  /** Slug tool Composio ung vien. */
  toolSlug: string;
  /** Mo ta ngan (luon noi ro la mock). */
  description: string;
  /** Tool co can approval truoc khi chay khong. */
  needsApproval: boolean;
  /** Tool ma app duoc phep goi qua bridge (chi 1 tool cua chinh no). */
  allowedTools: string[];
  /** Nhom app (catalogue v112). */
  category: McpAppV112Category;
  /** Server cung cap app nay. */
  serverId: string;
}

/** Tao dinh nghia MCP App cho mot tool mock (throw neu toolkit/slug la). */
export function createComposioV114McpApp(toolkit: string, toolSlug: string): ComposioV114McpAppDef {
  const def = findMockComposioV114Toolkit(toolkit);
  if (!def) throw new Error(`Unknown mock Composio v114 toolkit: ${toolkit}`);
  if (!def.candidateToolSlugs.includes(toolSlug)) {
    throw new Error(`Unknown mock Composio v114 tool slug for ${toolkit}: ${toolSlug}`);
  }
  return {
    appId: composioV114McpAppId(toolkit, toolSlug),
    uri: composioV114McpAppUri(toolkit, toolSlug),
    title: `${def.label} — ${toolSlug}`,
    toolkit,
    toolSlug,
    description: `[MOCK] MCP App chay tool Composio ${toolSlug} bang du lieu mau local. Chua goi API that — can key that + xac nhan slug de bat live.`,
    needsApproval: mockComposioV114ToolNeedsApproval(toolSlug),
    allowedTools: [toolSlug],
    category: COMPOSIO_V114_MCP_APP_CATEGORIES[toolkit] ?? 'utility',
    serverId: COMPOSIO_V114_MCP_APP_SERVER_ID,
  };
}

/** Tat ca 60 MCP App Composio mock v114. */
export function listComposioV114McpApps(): ComposioV114McpAppDef[] {
  return COMPOSIO_V114_MOCK_TOOLKITS.flatMap((t) =>
    t.candidateToolSlugs.map((slug) => createComposioV114McpApp(t.slug, slug)),
  );
}

/** Tim MCP App theo URI (undefined neu khong phai URI Composio mock). */
export function findComposioV114McpApp(uri: string): ComposioV114McpAppDef | undefined {
  const parsed = parseComposioV114McpAppUri(uri);
  if (!parsed) return undefined;
  try {
    return createComposioV114McpApp(parsed.toolkit, parsed.toolSlug);
  } catch {
    return undefined;
  }
}

/** Tach URI thanh toolkit + tool slug (null neu khong dung dinh dang). */
export function parseComposioV114McpAppUri(uri: string): { toolkit: string; toolSlug: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith(COMPOSIO_V114_MCP_APP_URI_PREFIX)) return null;
  const rest = uri.slice(COMPOSIO_V114_MCP_APP_URI_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const [toolkit, toolSlug] = parts as [string, string];
  if (!toolkit || !/^[a-z][a-z0-9-]*$/.test(toolkit)) return null;
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(toolSlug)) return null;
  return { toolkit, toolSlug };
}

/** true khi URI la URI MCP App Composio mock hop le + ton tai trong catalog. */
export function isComposioV114McpAppUri(uri: string): boolean {
  const parsed = parseComposioV114McpAppUri(uri);
  if (!parsed) return false;
  const def = findMockComposioV114Toolkit(parsed.toolkit);
  return def !== undefined && def.candidateToolSlugs.includes(parsed.toolSlug);
}

// ---------------------------------------------------------------------------
// HTML tinh cua app — khong script, khong link ngoai, khong goi mang
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render HTML tinh cho mot MCP App Composio mock. HTML nay chi hien
 * thong tin (ten tool, toolkit, ghi chu mock, args se dung) — khong
 * co <script>, khong co link/style ngoai, khong doc parent, nen
 * host `mcp_apps_open` co the validate + render an toan trong
 * sandboxed iframe. Viec chay tool do Task runner lam (xem ben duoi).
 */
export function renderComposioV114McpAppHtml(app: ComposioV114McpAppDef, args: Record<string, unknown> = {}): string {
  const title = escapeHtml(app.title);
  const desc = escapeHtml(app.description);
  const uri = escapeHtml(app.uri);
  const argsJson = escapeHtml(JSON.stringify(args, null, 2));
  const approval = app.needsApproval ? 'Can duyet truoc khi chay (tool ghi).' : 'Tool chi doc — chay ngay khong can duyet.';
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>' + title + '</title>',
    '<style>body{font-family:system-ui,sans-serif;margin:16px;color:#222}code{background:#f0f0f0;padding:2px 4px}pre{background:#f6f6f6;padding:12px;overflow:auto}.mock{color:#8a6d00}</style>',
    '</head><body>',
    '<h1>' + title + '</h1>',
    '<p>' + desc + '</p>',
    '<p class="mock">[MOCK] App nay chay bang du lieu mau local — khong goi API Composio that.</p>',
    '<p>URI: <code>' + uri + '</code></p>',
    '<p>' + escapeHtml(approval) + '</p>',
    '<h2>Arguments</h2>',
    '<pre>' + argsJson + '</pre>',
    '<p>Chay tool nay qua MCP Task: <code>mcp_tasks_create</code> voi app URI tren.</p>',
    '</body></html>',
  ].join('\n');
}

/** Kiem tra HTML render ra co dung quy tac an toan khong (khong script/link ngoai). */
export function validateComposioV114McpAppHtml(html: string): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (/<script/i.test(html)) reasons.push('HTML must not contain <script>');
  if (/<iframe/i.test(html)) reasons.push('HTML must not contain <iframe>');
  if (/src\s*=\s*["']https?:/i.test(html)) reasons.push('HTML must not load external resources');
  if (/href\s*=\s*["']https?:/i.test(html)) reasons.push('HTML must not link to external hosts');
  if (/on\w+\s*=/i.test(html)) reasons.push('HTML must not contain inline event handlers');
  if (!html.includes('ui://composio/')) reasons.push('HTML must mention the composio app URI');
  return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// MCP Task — mot lan chay tool mock, co taskId + status nhu Tasks v1.09
// ---------------------------------------------------------------------------

/** Mot MCP Task chay mot tool Composio mock. */
export interface ComposioV114McpTask {
  /** Id task xac dinh (hash tu app URI + args + thoi gian tao). */
  taskId: string;
  /** URI MCP App da mo task nay. */
  appUri: string;
  /** Slug toolkit Composio. */
  toolkit: string;
  /** Slug tool Composio ung vien. */
  toolSlug: string;
  /** Arguments truyen cho tool. */
  args: Record<string, unknown>;
  /** Trang thai task (cung tap status voi Tasks v1.09). */
  status: TaskStatus;
  /** Ket qua mock khi status = 'completed'. */
  result?: MockComposioV114Result;
  /** Thong diep loi khi status = 'failed'. */
  error?: string;
  /** Thoi diem tao task (epoch ms). */
  createdAtMs: number;
  /** Thoi diem task ket thuc (epoch ms) — null khi chua xong. */
  finishedAtMs: number | null;
}

/** Tao task moi o trang thai 'working' (chua chay). */
export function createComposioV114McpTask(
  app: ComposioV114McpAppDef,
  args: Record<string, unknown>,
  nowMs: number,
): ComposioV114McpTask {
  if (!isMockComposioV114Slug(app.toolSlug)) {
    throw new Error(`Unknown mock Composio v114 tool slug: ${app.toolSlug}`);
  }
  return {
    taskId: `composio-task-${mockComposioV114DeterministicId(`${app.uri}:${JSON.stringify(args)}:${nowMs}`)}`,
    appUri: app.uri,
    toolkit: app.toolkit,
    toolSlug: app.toolSlug,
    args: { ...args },
    status: 'working',
    createdAtMs: nowMs,
    finishedAtMs: null,
  };
}

/**
 * Chay mot task: goi mock executor (local, dong bo) roi danh dau
 * 'completed' + ket qua, hoac 'failed' khi slug/args khong hop le.
 * Task khong bao gio o 'input_required' — mock khong hoi them input.
 */
export function runComposioV114McpTask(
  task: ComposioV114McpTask,
  nowMs: number,
  executor: MockComposioV114Executor = new MockComposioV114Executor(),
): ComposioV114McpTask {
  if (task.status === 'cancelled') return { ...task };
  try {
    const result = executor.execute(task.toolkit, task.toolSlug, task.args);
    return { ...task, status: 'completed', result, finishedAtMs: nowMs };
  } catch (err) {
    return {
      ...task,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      finishedAtMs: nowMs,
    };
  }
}

/** Huy mot task chua xong (chi doi trang thai, khong chay gi them). */
export function cancelComposioV114McpTask(task: ComposioV114McpTask, nowMs: number): ComposioV114McpTask {
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return { ...task };
  return { ...task, status: 'cancelled', finishedAtMs: nowMs };
}

/** Tom tat mot task de UI/log doc (khong lo result day du). */
export function summarizeComposioV114McpTask(task: ComposioV114McpTask): {
  taskId: string;
  appUri: string;
  toolSlug: string;
  status: TaskStatus;
  durationMs: number | null;
  mock: boolean;
} {
  return {
    taskId: task.taskId,
    appUri: task.appUri,
    toolSlug: task.toolSlug,
    status: task.status,
    durationMs: task.finishedAtMs !== null ? task.finishedAtMs - task.createdAtMs : null,
    mock: task.result?.mock === true,
  };
}

/**
 * Store task trong bo nho: giu task theo id, cho phep resume sau
 * khi app restart bang cach doc lai task 'working' (task mock chay
 * dong bo nen resume chi la chay lai neu chua co ket qua).
 */
export class ComposioV114McpTaskStore {
  private readonly tasks = new Map<string, ComposioV114McpTask>();

  /** Them task (throw neu trung id). */
  add(task: ComposioV114McpTask): void {
    if (this.tasks.has(task.taskId)) throw new Error(`duplicate composio MCP task id: ${task.taskId}`);
    this.tasks.set(task.taskId, { ...task, args: { ...task.args } });
  }

  /** Lay ban sao task (undefined neu khong co). */
  get(taskId: string): ComposioV114McpTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? { ...t, args: { ...t.args } } : undefined;
  }

  /** Tat ca task (ban sao). */
  list(): ComposioV114McpTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t, args: { ...t.args } }));
  }

  /** Chay + luu ket qua mot task dang 'working'. */
  run(taskId: string, nowMs: number, executor?: MockComposioV114Executor): ComposioV114McpTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown composio MCP task id: ${taskId}`);
    const next = runComposioV114McpTask(task, nowMs, executor);
    this.tasks.set(taskId, next);
    return { ...next, args: { ...next.args } };
  }

  /** Huy + luu mot task. */
  cancel(taskId: string, nowMs: number): ComposioV114McpTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown composio MCP task id: ${taskId}`);
    const next = cancelComposioV114McpTask(task, nowMs);
    this.tasks.set(taskId, next);
    return { ...next, args: { ...next.args } };
  }

  /** Task chua xong (de resume sau restart). */
  pending(): ComposioV114McpTask[] {
    return this.list().filter((t) => t.status === 'working' || t.status === 'input_required');
  }

  /** Serialize toan bo store ra JSON (de luu xuong dia). */
  serialize(): string {
    return JSON.stringify(this.list());
  }

  /** Khoi phuc store tu JSON (throw neu sai dinh dang). */
  static deserialize(json: string): ComposioV114McpTaskStore {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('composio MCP task store JSON is not valid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('composio MCP task store JSON must be an array');
    const store = new ComposioV114McpTaskStore();
    for (const entry of parsed as ComposioV114McpTask[]) {
      if (typeof entry.taskId !== 'string' || entry.taskId.trim() === '') {
        throw new Error('task entry must have a non-empty taskId');
      }
      if (!isMockComposioV114Slug(entry.toolSlug)) {
        throw new Error(`task entry has unknown tool slug: ${entry.toolSlug}`);
      }
      store.add(entry);
    }
    return store;
  }
}

/** Chay truc tiep mot tool mock qua app URI (tien ich cho tool registry). */
export function executeMockComposioV114ToolViaApp(
  uri: string,
  args: Record<string, unknown>,
  nowMs: number,
): { task: ComposioV114McpTask; html: string } {
  const app = findComposioV114McpApp(uri);
  if (!app) throw new Error(`Unknown Composio v114 MCP app URI: ${uri}`);
  const task = runComposioV114McpTask(createComposioV114McpTask(app, args, nowMs), nowMs);
  return { task, html: renderComposioV114McpAppHtml(app, args) };
}
