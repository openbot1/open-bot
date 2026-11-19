/**
 * MCP Apps v2 tools — agent tools for the v1.44 T3 surface (v1.44, Team T3).
 *
 * The v1.09 host (`mcpAppsTasksTools.ts`) exposed `mcp_apps_*` /
 * `mcp_tasks_*` for the v1 surface (validate + open HTML apps,
 * negotiate capabilities, run one long task). This module is the
 * v2 companion — same host pattern, new tool family:
 *
 *   Apps render v2 (`appsRenderV2.ts`):
 *   - `mcp_apps_render_v2` — validate a UI descriptor against a
 *     declared template and mount a render session (returns the
 *     session snapshot + validation warnings).
 *   - `mcp_apps_render_v2_action` — dispatch a UI action from a
 *     mounted session (button / form submit / link / resource).
 *   - `mcp_apps_render_v2_list` — list live render sessions.
 *   - `mcp_apps_render_v2_close` — unmount a session.
 *
 * Discover extended (`metaDiscoverV2.ts`):
 *   - `mcp_apps_discover_v2` — build the full capability
 *     inventory of a server from its discover document, check it
 *     against host capabilities, return verdict + score.
 *
 * Tasks v2 (`tasksV2.ts`):
 *   - `mcp_tasks_v2_submit` — submit a DAG job (nodes with
 *     dependsOn / priority / retries) and run it to completion.
 *   - `mcp_tasks_v2_status` — job progress + per-node states.
 *   - `mcp_tasks_v2_cancel` — cancel a running job.
 *   - `mcp_tasks_v2_retry` — retry one failed node (unblocks
 *     its dependents).
 *
 * Memory KG JSONL (`memoryKgJsonl.ts`):
 *   - `mcp_memory_kg_remember` — store text + entities +
 *     relations into the JSONL knowledge graph.
 *   - `mcp_memory_kg_recall` — recall ranked live facts.
 *
 * The host holds the registries (render sessions, jobs, one KG
 * adapter per file path); the coordinator wires real transports
 * and templates in. Tools run fully local, no network, no key.
 *
 * Ideas only — no code copied from any MCP implementation, SDK,
 * or the Grok Bot / Cursor installers.
 */

import type { ToolDefinition } from '../types';
import type { McpAuditLog } from './auditLog';
import {
  AppRenderRegistry,
  validateAppUiDescriptor,
} from './appsRenderV2';
import type { AppUiDescriptor } from './appsRenderV2';
import { declareAppTemplate } from './appsV2';
import type { AppUiActionKind, DeclaredAppTemplate } from './appsV2';
import {
  buildCapabilityInventory,
  checkHostCompatibility,
} from './metaDiscoverV2';
import type { HostCapabilitySet } from './metaDiscoverV2';
import type { ServerDiscoverResult } from './stateless';
import { MemoryKgJsonl } from './memoryKgJsonl';
import {
  TaskV2Orchestrator,
  transportExecutor,
} from './tasksV2';
import type { TaskV2Definition, TaskV2Executor } from './tasksV2';
import { TaskV2JobStore } from './tasksV2Store';
import type { McpTaskTransport } from './tasks';

export const MCP_APPS_V2_TOOL_NAMES = [
  'mcp_apps_render_v2',
  'mcp_apps_render_v2_action',
  'mcp_apps_render_v2_list',
  'mcp_apps_render_v2_close',
  'mcp_apps_discover_v2',
  'mcp_tasks_v2_submit',
  'mcp_tasks_v2_status',
  'mcp_tasks_v2_cancel',
  'mcp_tasks_v2_retry',
  'mcp_tasks_v2_save',
  'mcp_tasks_v2_list',
  'mcp_memory_kg_remember',
  'mcp_memory_kg_recall',
] as const;
export type McpAppsV2ToolName = (typeof MCP_APPS_V2_TOOL_NAMES)[number];

function jsonSchemaProps(
  props: Record<string, Record<string, unknown>>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

/** Toàn bộ ToolDefinition của nhóm v2. */
export const MCP_APPS_V2_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'mcp_apps_render_v2',
    description:
      'Render một MCP App dạng UI tương tác (v2): validate UI descriptor JSON của app theo template đã khai báo rồi mount render session. Trả sessionId + snapshot + cảnh báo review. Không render HTML thô.',
    parameters: jsonSchemaProps(
      {
        template: { type: 'object', description: 'Template declaration: { id, serverName, title, allowedActions?, prefetch?, cache? }.' },
        descriptor: { type: 'object', description: 'UI descriptor JSON: { version: 1, templateId, root: { id, kind, ... } }.' },
      },
      ['template', 'descriptor'],
    ),
  },
  {
    name: 'mcp_apps_render_v2_action',
    description:
      'Gửi một UI action từ app đang render (v2): bấm nút, submit form, mở link, đọc resource. Action phải nằm trong allowedActions của template và session phải mounted, nếu không sẽ bị từ chối với lý do rõ ràng.',
    parameters: jsonSchemaProps(
      {
        sessionId: { type: 'string', description: 'SessionId từ mcp_apps_render_v2.' },
        nodeId: { type: 'string', description: 'Id của node UI đã kích hoạt action.' },
      },
      ['sessionId', 'nodeId'],
    ),
  },
  {
    name: 'mcp_apps_render_v2_list',
    description: 'Liệt kê các MCP App đang render (v2): sessionId, template, trạng thái lifecycle, số node, số action / từ chối.',
    parameters: jsonSchemaProps({}),
  },
  {
    name: 'mcp_apps_render_v2_close',
    description: 'Unmount một MCP App đang render (v2) theo sessionId.',
    parameters: jsonSchemaProps(
      { sessionId: { type: 'string', description: 'SessionId cần đóng.' } },
      ['sessionId'],
    ),
  },
  {
    name: 'mcp_apps_discover_v2',
    description:
      'Khám phá sâu một MCP server (v2): từ discover document, lập inventory đầy đủ (tool/resource/prompt, phiên bản, mô tả, schema), phát hiện trùng tên / thiếu mô tả, rồi chấm tương thích với host (ready/degraded/incompatible + điểm 0-100).',
    parameters: jsonSchemaProps(
      {
        discover: { type: 'object', description: 'Discover document của server (server/discover): { protocolVersion, capabilities, serverInfo, extensions?, tools?, resources?, prompts? }.' },
        host: { type: 'object', description: 'Host capabilities: { protocolVersions: string[], supportsTasks, supportsApps, maxTools? }.' },
      },
      ['discover'],
    ),
  },
  {
    name: 'mcp_tasks_v2_submit',
    description:
      'Chạy một job Tasks v2: nhiều task dài có phụ thuộc (DAG), ưu tiên, retry với backoff, giới hạn song song, kết quả lưu thành artifact. Trả trạng thái job + tiến độ + artifact từng task khi xong.',
    parameters: jsonSchemaProps(
      {
        jobId: { type: 'string', description: 'Id của job (slug).' },
        tasks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Danh sách task: [{ id, serverName, method, params?, dependsOn?, priority?, maxAttempts?, timeoutMs?, label? }].',
        },
        concurrency: { type: 'number', description: 'Số task chạy song song tối đa (mặc định 3).' },
      },
      ['jobId', 'tasks'],
    ),
  },
  {
    name: 'mcp_tasks_v2_status',
    description: 'Xem tiến độ một job Tasks v2: trạng thái job, done/total, từng node (trạng thái, tiến độ, lỗi, số lần thử).',
    parameters: jsonSchemaProps(
      { jobId: { type: 'string', description: 'Id của job.' } },
      ['jobId'],
    ),
  },
  {
    name: 'mcp_tasks_v2_cancel',
    description: 'Huỷ một job Tasks v2 đang chạy: task đang chạy bị abort, task chờ bị huỷ, task phụ thuộc bị skip.',
    parameters: jsonSchemaProps(
      { jobId: { type: 'string', description: 'Id của job.' } },
      ['jobId'],
    ),
  },
  {
    name: 'mcp_tasks_v2_retry',
    description: 'Retry một task failed trong job Tasks v2 (mở lại các task phụ thuộc đã bị skip để chạy tiếp khi task này xong).',
    parameters: jsonSchemaProps(
      {
        jobId: { type: 'string', description: 'Id của job.' },
        taskId: { type: 'string', description: 'Id của task failed cần retry.' },
      },
      ['jobId', 'taskId'],
    ),
  },
  {
    name: 'mcp_tasks_v2_save',
    description:
      'Lưu một job Tasks v2 đã chạy (hoặc đang dở) xuống đĩa dưới dạng snapshot JSON — để resume sau khi app restart. Trả entry đã lưu (trạng thái, done/total, bytes).',
    parameters: jsonSchemaProps(
      { jobId: { type: 'string', description: 'Id của job cần lưu.' } },
      ['jobId'],
    ),
  },
  {
    name: 'mcp_tasks_v2_list',
    description: 'Liệt kê các job Tasks v2 đã lưu trên đĩa (mới nhất trước): jobId, trạng thái, done/total, số lỗi, thời gian cập nhật.',
    parameters: jsonSchemaProps({}),
  },
  {
    name: 'mcp_memory_kg_remember',
    description:
      'Lưu vào memory knowledge graph (JSONL append-only): một ghi chú text kèm entity + relation. Fact cũ không bị xoá — muốn sửa thì invalidate rồi thêm mới. Trả ids đã tạo.',
    parameters: jsonSchemaProps(
      {
        text: { type: 'string', description: 'Nội dung ghi chú cần nhớ.' },
        entities: { type: 'array', items: { type: 'object' }, description: 'Entity: [{ id, label, kind?, attributes? }].' },
        relations: { type: 'array', items: { type: 'object' }, description: 'Relation: [{ id, from, to, label, attributes? }].' },
      },
      ['text'],
    ),
  },
  {
    name: 'mcp_memory_kg_recall',
    description:
      'Nhớ lại từ memory knowledge graph: tìm fact (entity / relation / note) khớp query, xếp hạng theo độ khớp + độ mới. Mặc định chỉ trả fact còn hiệu lực (fact đã invalidate bị ẩn).',
    parameters: jsonSchemaProps(
      {
        query: { type: 'string', description: 'Câu truy vấn (vd tên người, dự án).' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 10).' },
        includeInvalidated: { type: 'boolean', description: 'Có trả cả fact đã invalidate không (mặc định false).' },
      },
      ['query'],
    ),
  },
];

/** Kết quả chạy một tool v2 (JSON-safe, trả về cho agent). */
export interface McpAppsV2ToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Dependency cho McpAppsV2ToolHost. */
export interface McpAppsV2ToolHostOptions {
  /** Audit log để ghi action của app (tuỳ chọn). */
  auditLog?: McpAuditLog;
  /** Actor ghi vào audit (mặc định 'agent'). */
  actor?: string;
  /** Transport theo serverName (để chạy Tasks v2 thật qua MCP). */
  transports?: Map<string, McpTaskTransport> | Record<string, McpTaskTransport>;
  /** Executor tuỳ biến cho Tasks v2 (test / chạy offline — thắng transports). */
  executor?: TaskV2Executor;
  /** Đường dẫn file JSONL của memory KG (mặc định: không bật KG tools). */
  memoryKgPath?: string;
  /** Thư mục lưu snapshot job Tasks v2 (mặc định: không bật save/list tools). */
  tasksV2StoreDir?: string;
  /** Host capabilities mặc định cho discover v2. */
  hostCapabilities?: HostCapabilitySet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((v): v is string => typeof v === 'string');
}

/** Host thực thi các tool v2. */
export class McpAppsV2ToolHost {
  private readonly renderRegistry = new AppRenderRegistry();
  private readonly jobs = new Map<string, TaskV2Orchestrator>();
  private readonly transports = new Map<string, McpTaskTransport>();
  private readonly executorOverride?: TaskV2Executor;
  private readonly auditLog?: McpAuditLog;
  private readonly actor: string;
  private readonly hostCapabilities: HostCapabilitySet;
  private kg: MemoryKgJsonl | undefined;
  private kgReady: Promise<void> | undefined;
  private jobStore: TaskV2JobStore | undefined;

  constructor(options: McpAppsV2ToolHostOptions = {}) {
    this.auditLog = options.auditLog;
    this.actor = options.actor ?? 'agent';
    this.executorOverride = options.executor;
    this.hostCapabilities = options.hostCapabilities ?? {
      protocolVersions: ['2026-07-28', '2025-11-25'],
      supportsTasks: true,
      supportsApps: true,
    };
    if (options.transports) {
      const entries =
        options.transports instanceof Map
          ? [...options.transports.entries()]
          : Object.entries(options.transports);
      for (const [name, transport] of entries) this.transports.set(name, transport);
    }
    if (options.memoryKgPath) {
      this.kg = new MemoryKgJsonl(options.memoryKgPath);
      this.kgReady = this.kg.load().then(() => undefined);
    }
    if (options.tasksV2StoreDir) {
      this.jobStore = new TaskV2JobStore(options.tasksV2StoreDir);
    }
  }

  get renders(): AppRenderRegistry {
    return this.renderRegistry;
  }

  /** Đăng ký transport cho một server (để Tasks v2 chạy thật). */
  registerTransport(serverName: string, transport: McpTaskTransport): void {
    this.transports.set(serverName, transport);
  }

  private executorForJob(): TaskV2Executor {
    if (this.executorOverride) return this.executorOverride;
    // Per-node transport lookup: a DAG job may span servers.
    return (node, signal, reportProgress) => {
      const transport = this.transports.get(node.serverName);
      if (!transport) {
        throw new Error(
          `Chưa có transport cho server "${node.serverName}" — đăng ký transport hoặc truyền executor trước khi submit job.`,
        );
      }
      return transportExecutor(transport, { specVersion: '2026-07-28' })(node, signal, reportProgress);
    };
  }

  private async ensureKg(): Promise<MemoryKgJsonl> {
    if (!this.kg) {
      throw new Error('Memory KG chưa cấu hình đường dẫn file JSONL — truyền memoryKgPath cho host.');
    }
    await this.kgReady;
    return this.kg;
  }

  private ensureJobStore(): TaskV2JobStore {
    if (!this.jobStore) {
      throw new Error('Tasks v2 store chưa cấu hình thư mục — truyền tasksV2StoreDir cho host.');
    }
    return this.jobStore;
  }

  /** Chạy một tool theo tên + args (đã parse). Tool lạ -> lỗi rõ ràng. */
  async runTool(name: string, args: Record<string, unknown>): Promise<McpAppsV2ToolResult> {
    try {
      switch (name) {
        case 'mcp_apps_render_v2':
          return this.renderApp(args);
        case 'mcp_apps_render_v2_action':
          return this.renderAction(args);
        case 'mcp_apps_render_v2_list':
          return { ok: true, data: { sessions: this.renderRegistry.listSnapshots() } };
        case 'mcp_apps_render_v2_close':
          return this.closeRender(args);
        case 'mcp_apps_discover_v2':
          return this.discover(args);
        case 'mcp_tasks_v2_submit':
          return await this.submitJob(args);
        case 'mcp_tasks_v2_status':
          return this.jobStatus(args);
        case 'mcp_tasks_v2_cancel':
          return this.cancelJob(args);
        case 'mcp_tasks_v2_retry':
          return await this.retryJobTask(args);
        case 'mcp_tasks_v2_save':
          return await this.saveJob(args);
        case 'mcp_tasks_v2_list':
          return await this.listJobs();
        case 'mcp_memory_kg_remember':
          return await this.kgRemember(args);
        case 'mcp_memory_kg_recall':
          return await this.kgRecall(args);
        default:
          return { ok: false, error: `Tool không tồn tại trong nhóm v2: "${name}".` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private parseTemplate(args: Record<string, unknown>): DeclaredAppTemplate {
    const raw = args['template'];
    if (!isRecord(raw)) throw new Error('mcp_apps_render_v2 cần "template" là object.');
    const knownActions: AppUiActionKind[] = ['tool-call', 'link-open', 'form-submit', 'resource-read'];
    const allowedActions = Array.isArray(raw['allowedActions'])
      ? asStringArray(raw['allowedActions']).filter(
          (a): a is AppUiActionKind => (knownActions as string[]).includes(a),
        )
      : [];
    return declareAppTemplate({
      id: asNonEmptyString(raw['id']) ?? '',
      serverName: asNonEmptyString(raw['serverName']) ?? '',
      title: asNonEmptyString(raw['title']) ?? '',
      ...(allowedActions.length > 0 ? { allowedActions } : {}),
      ...(isRecord(raw['cache']) && typeof raw['cache']['maxAgeSec'] === 'number'
        ? { cache: { maxAgeSec: raw['cache']['maxAgeSec'] as number } }
        : {}),
    });
  }

  private renderApp(args: Record<string, unknown>): McpAppsV2ToolResult {
    let template: DeclaredAppTemplate;
    try {
      template = this.parseTemplate(args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const descriptorRaw = args['descriptor'];
    const validation = validateAppUiDescriptor(descriptorRaw, template);
    if (!validation.valid || !validation.descriptor) {
      return {
        ok: false,
        error: `Descriptor không hợp lệ: ${validation.errors.join('; ')}`,
        data: { errors: validation.errors, warnings: validation.warnings },
      };
    }
    const descriptor: AppUiDescriptor = validation.descriptor;
    const session = this.renderRegistry.create(template, descriptor, {
      actor: this.actor,
      ...(this.auditLog ? { auditLog: this.auditLog } : {}),
    });
    return {
      ok: true,
      data: {
        sessionId: session.sessionId,
        snapshot: session.snapshot(),
        warnings: validation.warnings,
        nodeCount: validation.nodeCount,
      },
    };
  }

  private renderAction(args: Record<string, unknown>): McpAppsV2ToolResult {
    const sessionId = asNonEmptyString(args['sessionId']);
    const nodeId = asNonEmptyString(args['nodeId']);
    if (!sessionId) return { ok: false, error: 'mcp_apps_render_v2_action cần "sessionId".' };
    if (!nodeId) return { ok: false, error: 'mcp_apps_render_v2_action cần "nodeId".' };
    const session = this.renderRegistry.get(sessionId);
    if (!session) return { ok: false, error: `Không có render session "${sessionId}".` };
    const dispatch = session.dispatchAction(nodeId);
    if (!dispatch.ok) return { ok: false, error: dispatch.reason };
    return { ok: true, data: { ...dispatch, sessionId, snapshot: session.snapshot() } };
  }

  private closeRender(args: Record<string, unknown>): McpAppsV2ToolResult {
    const sessionId = asNonEmptyString(args['sessionId']);
    if (!sessionId) return { ok: false, error: 'mcp_apps_render_v2_close cần "sessionId".' };
    const removed = this.renderRegistry.remove(sessionId);
    return {
      ok: removed,
      ...(removed ? { data: { sessionId, closed: true } } : { error: `Không có render session "${sessionId}".` }),
    };
  }

  private discover(args: Record<string, unknown>): McpAppsV2ToolResult {
    const doc = args['discover'];
    if (!isRecord(doc)) return { ok: false, error: 'mcp_apps_discover_v2 cần "discover" là object.' };
    const hostRaw = isRecord(args['host']) ? args['host'] : undefined;
    const host: HostCapabilitySet = hostRaw
      ? {
          protocolVersions: asStringArray(hostRaw['protocolVersions']),
          supportsTasks: hostRaw['supportsTasks'] !== false,
          supportsApps: hostRaw['supportsApps'] !== false,
          ...(typeof hostRaw['maxTools'] === 'number' ? { maxTools: hostRaw['maxTools'] as number } : {}),
        }
      : this.hostCapabilities;
    if (host.protocolVersions.length === 0) host.protocolVersions = this.hostCapabilities.protocolVersions;
    const inventory = buildCapabilityInventory(doc as unknown as ServerDiscoverResult);
    const report = checkHostCompatibility(inventory, host);
    return {
      ok: report.verdict !== 'incompatible',
      data: {
        serverName: inventory.serverName,
        serverVersion: inventory.serverVersion,
        protocolVersion: inventory.protocolVersion,
        tools: inventory.tools.map((t) => ({ name: t.name, version: t.version, hasDescription: t.hasDescription })),
        resources: inventory.resources.map((r) => r.name),
        prompts: inventory.prompts.map((p) => p.name),
        tasksSupported: inventory.tasksSupported,
        appsSupported: inventory.appsSupported,
        extensions: inventory.extensions,
        findings: inventory.findings,
        verdict: report.verdict,
        score: report.score,
        missing: report.missing,
        unsupported: report.unsupported,
        reasons: report.reasons,
      },
      ...(report.verdict === 'incompatible' ? { error: `Server không tương thích: ${report.reasons.join('; ')}` } : {}),
    };
  }

  private parseJobTasks(args: Record<string, unknown>): TaskV2Definition[] {
    if (!Array.isArray(args['tasks'])) {
      throw new Error('mcp_tasks_v2_submit cần "tasks" là danh sách.');
    }
    const defs: TaskV2Definition[] = [];
    for (const raw of args['tasks'] as unknown[]) {
      if (!isRecord(raw)) throw new Error('Mỗi task trong job phải là object.');
      const id = asNonEmptyString(raw['id']);
      const serverName = asNonEmptyString(raw['serverName']);
      const method = asNonEmptyString(raw['method']);
      if (!id || !serverName || !method) {
        throw new Error('Mỗi task cần id + serverName + method.');
      }
      defs.push({
        id,
        serverName,
        method,
        ...(isRecord(raw['params']) ? { params: raw['params'] } : {}),
        ...(Array.isArray(raw['dependsOn']) ? { dependsOn: asStringArray(raw['dependsOn']) } : {}),
        ...(typeof raw['priority'] === 'number' ? { priority: raw['priority'] as number } : {}),
        ...(typeof raw['maxAttempts'] === 'number' ? { maxAttempts: raw['maxAttempts'] as number } : {}),
        ...(typeof raw['timeoutMs'] === 'number' ? { timeoutMs: raw['timeoutMs'] as number } : {}),
        ...(typeof raw['label'] === 'string' ? { label: raw['label'] as string } : {}),
      });
    }
    return defs;
  }

  private async submitJob(args: Record<string, unknown>): Promise<McpAppsV2ToolResult> {
    const jobId = asNonEmptyString(args['jobId']);
    if (!jobId) return { ok: false, error: 'mcp_tasks_v2_submit cần "jobId".' };
    if (this.jobs.has(jobId)) {
      return { ok: false, error: `Job "${jobId}" đã tồn tại — dùng jobId khác hoặc xem status trước.` };
    }
    let defs: TaskV2Definition[];
    try {
      defs = this.parseJobTasks(args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (defs.length === 0) return { ok: false, error: 'Job cần ít nhất 1 task.' };
    if (!this.executorOverride) {
      const missing = defs.filter((d) => !this.transports.has(d.serverName)).map((d) => d.serverName);
      if (missing.length > 0) {
        return { ok: false, error: `Chưa có transport cho server ${[...new Set(missing)].map((s) => `"${s}"`).join(', ')} — đăng ký transport hoặc truyền executor trước khi submit job.` };
      }
    }
    const executor = this.executorForJob();
    const concurrency = typeof args['concurrency'] === 'number' ? (args['concurrency'] as number) : undefined;
    const job = new TaskV2Orchestrator(jobId, executor, {
      ...(concurrency !== undefined ? { concurrency } : {}),
    });
    try {
      for (const def of defs) job.addTask(def);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.jobs.set(jobId, job);
    const status = await job.runAll();
    return {
      ok: status === 'completed',
      data: {
        jobId,
        status,
        progress: job.progress(),
        nodes: job.listNodes().map((n) => ({
          id: n.id,
          status: n.status,
          attempts: n.attempts,
          ...(n.error ? { error: n.error } : {}),
          ...(n.artifactId ? { artifactId: n.artifactId } : {}),
        })),
        artifacts: job.listArtifacts().map((a) => ({ id: a.id, taskId: a.taskId, bytes: a.bytes, truncated: a.truncated })),
      },
      ...(status === 'completed' ? {} : { error: `Job kết thúc với trạng thái "${status}".` }),
    };
  }

  private jobStatus(args: Record<string, unknown>): McpAppsV2ToolResult {
    const jobId = asNonEmptyString(args['jobId']);
    if (!jobId) return { ok: false, error: 'mcp_tasks_v2_status cần "jobId".' };
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Không có job "${jobId}".` };
    return {
      ok: true,
      data: {
        jobId,
        status: job.jobStatus,
        progress: job.progress(),
        nodes: job.listNodes().map((n) => ({
          id: n.id,
          label: n.label,
          status: n.status,
          progress: n.progress,
          attempts: n.attempts,
          ...(n.error ? { error: n.error } : {}),
          ...(n.artifactId ? { artifactId: n.artifactId } : {}),
        })),
      },
    };
  }

  private cancelJob(args: Record<string, unknown>): McpAppsV2ToolResult {
    const jobId = asNonEmptyString(args['jobId']);
    if (!jobId) return { ok: false, error: 'mcp_tasks_v2_cancel cần "jobId".' };
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Không có job "${jobId}".` };
    job.cancel();
    return { ok: true, data: { jobId, status: job.jobStatus, progress: job.progress() } };
  }

  private async retryJobTask(args: Record<string, unknown>): Promise<McpAppsV2ToolResult> {
    const jobId = asNonEmptyString(args['jobId']);
    const taskId = asNonEmptyString(args['taskId']);
    if (!jobId) return { ok: false, error: 'mcp_tasks_v2_retry cần "jobId".' };
    if (!taskId) return { ok: false, error: 'mcp_tasks_v2_retry cần "taskId".' };
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Không có job "${jobId}".` };
    try {
      const node = await job.retryTask(taskId);
      return {
        ok: node.status === 'completed',
        data: { jobId, taskId, status: node.status, jobStatus: job.jobStatus, attempts: node.attempts },
        ...(node.status === 'completed' ? {} : { error: node.error ?? `Task "${taskId}" vẫn ${node.status}.` }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async saveJob(args: Record<string, unknown>): Promise<McpAppsV2ToolResult> {
    const jobId = asNonEmptyString(args['jobId']);
    if (!jobId) return { ok: false, error: 'mcp_tasks_v2_save cần "jobId".' };
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: `Không có job "${jobId}".` };
    let store: TaskV2JobStore;
    try {
      store = this.ensureJobStore();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const entry = await store.save(job);
      return { ok: true, data: { ...entry } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async listJobs(): Promise<McpAppsV2ToolResult> {
    let store: TaskV2JobStore;
    try {
      store = this.ensureJobStore();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const entries = await store.list();
      return { ok: true, data: { jobs: entries, count: entries.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async kgRemember(args: Record<string, unknown>): Promise<McpAppsV2ToolResult> {
    const text = asNonEmptyString(args['text']);
    if (!text) return { ok: false, error: 'mcp_memory_kg_remember cần "text".' };
    let kg: MemoryKgJsonl;
    try {
      kg = await this.ensureKg();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const entities = Array.isArray(args['entities'])
      ? (args['entities'] as unknown[]).filter(isRecord).map((e) => ({
          id: asNonEmptyString((e as Record<string, unknown>)['id']) ?? '',
          label: asNonEmptyString((e as Record<string, unknown>)['label']) ?? '',
          ...(typeof (e as Record<string, unknown>)['kind'] === 'string'
            ? { kind: (e as Record<string, unknown>)['kind'] as string }
            : {}),
        }))
      : [];
    const relations = Array.isArray(args['relations'])
      ? (args['relations'] as unknown[]).filter(isRecord).map((r) => ({
          id: asNonEmptyString((r as Record<string, unknown>)['id']) ?? '',
          from: asNonEmptyString((r as Record<string, unknown>)['from']) ?? '',
          to: asNonEmptyString((r as Record<string, unknown>)['to']) ?? '',
          label: asNonEmptyString((r as Record<string, unknown>)['label']) ?? '',
        }))
      : [];
    try {
      const result = await kg.remember({ text, entities, relations });
      return { ok: true, data: { ...result } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async kgRecall(args: Record<string, unknown>): Promise<McpAppsV2ToolResult> {
    const query = asNonEmptyString(args['query']);
    if (!query) return { ok: false, error: 'mcp_memory_kg_recall cần "query".' };
    let kg: MemoryKgJsonl;
    try {
      kg = await this.ensureKg();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const limit = typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined;
    const hits = await kg.recall(query, {
      ...(limit !== undefined ? { limit } : {}),
      includeInvalidated: args['includeInvalidated'] === true,
    });
    return { ok: true, data: { query, count: hits.length, hits } };
  }
}

/** Helper nhanh: lấy definitions để đăng ký vào registry của agent. */
export function getMcpAppsV2ToolDefinitions(): ToolDefinition[] {
  return [...MCP_APPS_V2_TOOL_DEFINITIONS];
}

/** Guard: một tool name có thuộc nhóm v2 không. */
export function isMcpAppsV2ToolName(name: string): name is McpAppsV2ToolName {
  return (MCP_APPS_V2_TOOL_NAMES as readonly string[]).includes(name);
}
