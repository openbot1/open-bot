/**
 * MCP conformance eval suite (v1.06, Đội T6).
 *
 * Kiểm tra client MCP của open-bot có nói đúng protocol không — bằng
 * các hàm pure của `mcp/*` + một fake transport trong bộ nhớ. Không
 * cần server MCP thật, không gọi mạng, không cần key.
 *
 * Nhóm case:
 * 1. Stateless request đúng format — `buildStatelessMeta` mặc định
 *    khai đúng protocol 2026-07-28 + capabilities (multiRoundTrip /
 *    tasks / apps); `withStatelessMeta` gắn `_meta` vào params mà
 *    không mất field cũ; `parseStatelessMeta` round-trip được meta
 *    đã build, và trả null cho meta hỏng (caller khi đó fallback
 *    sang legacy `initialize` gate — không crash).
 * 2. Discover — `buildServerDiscoverResult` + `parseServerDiscoverResult`
 *    round-trip (protocol, serverInfo, capabilities, extensions);
 *    discover thiếu protocolVersion / serverInfo thì throw rõ.
 * 3. Elicitation form — parse schema ra field đúng kiểu + required;
 *    `validateElicitedContent` chấp nhận dữ liệu hợp lệ, từ chối
 *    thiếu required / sai kiểu / ngoài enum; `coerceElicitedValue`
 *    ép "42" (string) thành number 42.
 * 4. Elicitation URL — parse request url-mode với URL http(s) hợp lệ;
 *    URL không phải http(s) thì throw; `ElicitationUrlTracker` chờ
 *    completion: `complete()` resolve lượt chờ, id lạ trả false,
 *    `cancelAll()` reject lượt chờ đang mở.
 * 5. Tasks poll/cancel — fake transport script sẵn: `createTask`
 *    gửi `tools/call` kèm `_meta.task`, trả handle working; poll
 *    `tasks/get` chuyển working → completed (kèm result ở extension
 *    2026-07-28); `cancel()` chuyển sang cancelled (terminal);
 *    server trả handle sai / taskId khác khi poll thì `TaskError`.
 * 6. Fallback handshake server cũ — server chỉ biết 2025-11-25:
 *    `negotiateStatelessVersion` chọn 2025-11-25 (không ép 2026);
 *    server không trả version gì: negotiate trả về client preferred
 *    và `parseStatelessMeta(null)` = null (legacy initialize gate);
 *    `discoverServer` với client trả -32601 thì trả null (server
 *    pre-2.0, không phải lỗi).
 */

import {
  buildServerDiscoverResult,
  buildStatelessMeta,
  discoverServer,
  isKnownProtocolVersion,
  negotiateStatelessVersion,
  parseServerDiscoverResult,
  parseStatelessMeta,
  withStatelessMeta,
  type StatelessCapableClient,
} from '../mcp/stateless';
import {
  ElicitationUrlTracker,
  coerceElicitedValue,
  parseElicitationRequest,
  parseElicitationSchema,
  parseElicitationCompleteNotification,
  validateElicitedContent,
} from '../mcp/elicitation';
import {
  createTask,
  isTaskTerminal,
  parseTaskHandle,
  type McpTaskTransport,
  type TaskHandleData,
} from '../mcp/tasks';
import { buildEvalSuiteResult, runEvalCase, type EvalCaseResult, type EvalSuiteResult } from './types';

/** Fake transport MCP trong bộ nhớ: script sẵn response theo method. */
class ScriptedTransport implements McpTaskTransport {
  private readonly script: Map<string, unknown[]>;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(script: Record<string, unknown[]>) {
    this.script = new Map(Object.entries(script));
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const queue = this.script.get(method);
    if (!queue || queue.length === 0) throw new Error(`scripted transport has no response for "${method}"`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

function taskHandle(taskId: string, status: TaskHandleData['status'], extra: Partial<TaskHandleData> = {}): TaskHandleData {
  return { taskId, status, pollInterval: 10, ...extra };
}

async function caseStatelessRequestFormat(): Promise<{ passed: boolean; detail: string }> {
  const meta = buildStatelessMeta();
  const caps = meta.clientCapabilities ?? {};
  const checks: Array<[string, boolean]> = [
    ['default protocol is 2026-07-28', meta.protocolVersion === '2026-07-28'],
    ['declares multiRoundTrip', caps.multiRoundTrip === true],
    ['declares tasks', caps.tasks === true],
    ['declares apps', caps.apps === true],
  ];
  const withParams = withStatelessMeta({ name: 'echo', arguments: { text: 'hi' } }, meta);
  const kept = (withParams['name'] as string) === 'echo';
  const metaBack = parseStatelessMeta(withParams['_meta']);
  checks.push(['withStatelessMeta keeps existing params', kept]);
  checks.push(['parseStatelessMeta round-trips the built meta', metaBack !== null && metaBack.protocolVersion === '2026-07-28']);
  checks.push(['parseStatelessMeta(null) is null (legacy gate)', parseStatelessMeta(null) === null]);
  checks.push(['parseStatelessMeta({}) is null', parseStatelessMeta({}) === null]);
  checks.push(['2026-07-28 is a known version', isKnownProtocolVersion('2026-07-28')]);
  checks.push(['bogus version is not known', !isKnownProtocolVersion('2099-01-01')]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'stateless _meta envelope is well-formed, round-trips, and malformed meta degrades to null'
      : `stateless checks failed: [${failed.join('; ')}]`,
  };
}

async function caseDiscover(): Promise<{ passed: boolean; detail: string }> {
  const built = buildServerDiscoverResult({
    name: 'eval-server', version: '1.0.0', hasTools: true, hasResources: false,
    hasPrompts: true, tasksSupported: true, appsSupported: false,
  });
  const parsed = parseServerDiscoverResult(built);
  const checks: Array<[string, boolean]> = [
    ['protocol version survives', parsed.protocolVersion === '2026-07-28'],
    ['serverInfo survives', parsed.serverInfo.name === 'eval-server' && parsed.serverInfo.version === '1.0.0'],
    ['tasks extension listed', (parsed.extensions ?? []).includes('io.modelcontextprotocol/tasks')],
    ['tools capability present', parsed.capabilities.tools !== undefined],
  ];
  let threwMissingVersion = false;
  try {
    parseServerDiscoverResult({ serverInfo: { name: 'x', version: '1' } });
  } catch {
    threwMissingVersion = true;
  }
  checks.push(['discover without protocolVersion throws', threwMissingVersion]);
  let threwMissingInfo = false;
  try {
    parseServerDiscoverResult({ protocolVersion: '2026-07-28' });
  } catch {
    threwMissingInfo = true;
  }
  checks.push(['discover without serverInfo throws', threwMissingInfo]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'server/discover round-trips and malformed discovery documents are rejected'
      : `discover checks failed: [${failed.join('; ')}]`,
  };
}

async function caseElicitationForm(): Promise<{ passed: boolean; detail: string }> {
  const schema = {
    type: 'object',
    properties: {
      nickname: { type: 'string', minLength: 2 },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      plan: { type: 'string', enum: ['free', 'pro'] },
    },
    required: ['nickname', 'plan'],
  };
  const fields = parseElicitationSchema(schema);
  const checks: Array<[string, boolean]> = [
    ['schema parses to 3 fields', fields.length === 3],
    ['nickname is required string', fields.find((f) => f.name === 'nickname')?.required === true],
    ['age is integer', fields.find((f) => f.name === 'age')?.type === 'integer'],
  ];
  const valid = validateElicitedContent(fields, { nickname: 'Huy', age: 30, plan: 'pro' });
  checks.push(['valid content accepted', valid['nickname'] === 'Huy' && valid['age'] === 30]);
  let rejectedMissing = false;
  try {
    validateElicitedContent(fields, { age: 30 });
  } catch {
    rejectedMissing = true;
  }
  checks.push(['missing required field rejected', rejectedMissing]);
  let rejectedEnum = false;
  try {
    validateElicitedContent(fields, { nickname: 'Huy', plan: 'enterprise' });
  } catch {
    rejectedEnum = true;
  }
  checks.push(['value outside enum rejected', rejectedEnum]);
  const ageField = fields.find((f) => f.name === 'age');
  const coerced = ageField !== undefined ? coerceElicitedValue(ageField, '42') : undefined;
  checks.push(['string "42" coerces to number 42', coerced === 42]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'elicitation form schema parses, valid content passes, bad content is rejected, values coerce'
      : `elicitation form checks failed: [${failed.join('; ')}]`,
  };
}

async function caseElicitationUrl(): Promise<{ passed: boolean; detail: string }> {
  const req = parseElicitationRequest(
    { message: 'Please authorize', mode: 'url', url: 'https://example.com/auth?x=1', elicitationId: 'elic-1' },
    'eval-server',
  );
  const checks: Array<[string, boolean]> = [
    ['url-mode request parses', req.mode === 'url' && req.url === 'https://example.com/auth?x=1'],
    ['elicitationId kept', req.elicitationId === 'elic-1'],
  ];
  let threwBadUrl = false;
  try {
    parseElicitationRequest({ message: 'x', mode: 'url', url: 'ftp://example.com/a' }, 'eval-server');
  } catch {
    threwBadUrl = true;
  }
  checks.push(['non-http(s) URL rejected', threwBadUrl]);
  let threwNoUrl = false;
  try {
    parseElicitationRequest({ message: 'x', mode: 'url' }, 'eval-server');
  } catch {
    threwNoUrl = true;
  }
  checks.push(['url-mode without url rejected', threwNoUrl]);
  const tracker = new ElicitationUrlTracker();
  const waiting = tracker.waitForCompletion('elic-1', { timeoutMs: 5000 });
  checks.push(['unknown completion id returns false', tracker.complete('elic-unknown') === false]);
  checks.push(['pending count is 1 while waiting', tracker.pendingCount === 1]);
  const completed = tracker.complete('elic-1');
  await waiting;
  checks.push(['complete() resolves the waiter', completed === true]);
  const notified = parseElicitationCompleteNotification('notifications/elicitation/complete', { elicitationId: 'elic-9' });
  checks.push(['completion notification parses', notified === 'elic-9']);
  checks.push(['other method notification is null', parseElicitationCompleteNotification('notifications/message', {}) === null]);
  const tracker2 = new ElicitationUrlTracker();
  const waiting2 = tracker2.waitForCompletion('elic-2', { timeoutMs: 5000 });
  tracker2.cancelAll('test cancel');
  let cancelRejected = false;
  try {
    await waiting2;
  } catch {
    cancelRejected = true;
  }
  checks.push(['cancelAll rejects pending waiters', cancelRejected]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'elicitation URL mode parses, validates URLs, and the completion tracker resolves/cancels correctly'
      : `elicitation URL checks failed: [${failed.join('; ')}]`,
  };
}

async function caseTasksPoll(): Promise<{ passed: boolean; detail: string }> {
  const transport = new ScriptedTransport({
    'tools/call': [taskHandle('task-1', 'working', { pollInterval: 5 })],
    'tasks/get': [
      taskHandle('task-1', 'working', { pollInterval: 5 }),
      taskHandle('task-1', 'completed', { result: { text: 'done!' } }),
    ],
  });
  const handle = await createTask(transport, 'tools/call', { name: 'echo', arguments: {} }, { specVersion: '2026-07-28' });
  const checks: Array<[string, boolean]> = [
    ['createTask returns a working handle', handle.status === 'working' && handle.taskId === 'task-1'],
    ['createTask sent _meta.task', (() => {
      const call = transport.calls[0];
      const meta = call.params['_meta'];
      return typeof meta === 'object' && meta !== null && 'task' in (meta as Record<string, unknown>);
    })()],
  ];
  const first = await handle.poll();
  checks.push(['first poll stays working', first.status === 'working' && handle.status === 'working']);
  const second = await handle.poll();
  checks.push(['second poll reaches completed', second.status === 'completed' && handle.status === 'completed']);
  checks.push(['completed handle is terminal', handle.isTerminal === true]);
  checks.push(['result rides on tasks/get (2026 extension)', second.result !== undefined && (second.result as { text: string }).text === 'done!']);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'tasks poll: working -> working -> completed with result on tasks/get'
      : `tasks poll checks failed: [${failed.join('; ')}]`,
  };
}

async function caseTasksCancel(): Promise<{ passed: boolean; detail: string }> {
  const transport = new ScriptedTransport({
    'tools/call': [taskHandle('task-2', 'working', { pollInterval: 5 })],
    'tasks/cancel': [{ status: 'cancelled' }],
  });
  const handle = await createTask(transport, 'tools/call', { name: 'slow', arguments: {} }, { specVersion: '2025-11-25' });
  await handle.cancel();
  const checks: Array<[string, boolean]> = [
    ['cancel sets status cancelled', handle.status === 'cancelled'],
    ['cancelled is terminal', isTaskTerminal(handle.status)],
    ['cancel called tasks/cancel with the taskId', transport.calls.some((c) => c.method === 'tasks/cancel' && (c.params['taskId'] as string) === 'task-2')],
  ];
  // Server trả handle sai khi tạo task -> TaskError.
  const badTransport = new ScriptedTransport({ 'tools/call': [{ nope: true }] });
  let threwBadHandle = false;
  try {
    await createTask(badTransport, 'tools/call', { name: 'x' });
  } catch {
    threwBadHandle = true;
  }
  checks.push(['malformed task handle throws TaskError', threwBadHandle]);
  // Server trả taskId khác khi poll -> TaskError.
  const wrongIdTransport = new ScriptedTransport({
    'tools/call': [taskHandle('task-3', 'working')],
    'tasks/get': [taskHandle('task-OTHER', 'working')],
  });
  const handle3 = await createTask(wrongIdTransport, 'tools/call', { name: 'x' });
  let threwWrongId = false;
  try {
    await handle3.poll();
  } catch {
    threwWrongId = true;
  }
  checks.push(['poll returning a different taskId throws', threwWrongId]);
  // parseTaskHandle từ chối status ngoài spec.
  let threwBadStatus = false;
  try {
    parseTaskHandle({ taskId: 't', status: 'teleporting' });
  } catch {
    threwBadStatus = true;
  }
  checks.push(['unknown task status throws', threwBadStatus]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'tasks cancel works and malformed handles / wrong taskIds are rejected'
      : `tasks cancel checks failed: [${failed.join('; ')}]`,
  };
}

async function caseFallbackHandshakeOldServer(): Promise<{ passed: boolean; detail: string }> {
  const checks: Array<[string, boolean]> = [];
  const oldServer = negotiateStatelessVersion('2025-11-25', ['2025-11-25']);
  checks.push(['old server (2025-11-25 only) negotiates 2025-11-25', oldServer === '2025-11-25']);
  const oldestServer = negotiateStatelessVersion('2024-11-05', ['2024-11-05']);
  checks.push(['2024-11-05 server negotiates 2024-11-05', oldestServer === '2024-11-05']);
  const silentServer = negotiateStatelessVersion(undefined, undefined);
  checks.push(['server offering nothing falls back to client preferred (2026-07-28)', silentServer === '2026-07-28']);
  checks.push(['no _meta from an old server parses to null (legacy initialize gate)', parseStatelessMeta(undefined) === null]);
  // discoverServer với client trả -32601 (pre-2.0 server) -> null, không throw.
  const legacyClient: StatelessCapableClient = {
    async requestJsonRpc() {
      throw new Error('JSON-RPC -32601: Method not found');
    },
  };
  const discovered = await discoverServer(legacyClient);
  checks.push(['discover on a pre-2.0 server (-32601) returns null instead of throwing', discovered === null]);
  const modernClient: StatelessCapableClient = {
    async requestJsonRpc() {
      return buildServerDiscoverResult({
        name: 'modern', version: '2.0.0', hasTools: true, hasResources: true,
        hasPrompts: false, tasksSupported: true, appsSupported: true,
      });
    },
  };
  const modern = await discoverServer(modernClient);
  checks.push(['discover on a modern server returns its document', modern !== null && modern.serverInfo.name === 'modern']);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    passed: failed.length === 0,
    detail: failed.length === 0
      ? 'old servers negotiate down correctly and missing discovery degrades gracefully'
      : `fallback handshake checks failed: [${failed.join('; ')}]`,
  };
}

/** Chạy toàn bộ suite MCP conformance eval. */
export async function runMcpConformanceEval(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];
  cases.push(await runEvalCase('mcp.stateless-request-format', 'Stateless request format', caseStatelessRequestFormat));
  cases.push(await runEvalCase('mcp.discover', 'server/discover round-trip', caseDiscover));
  cases.push(await runEvalCase('mcp.elicitation-form', 'Elicitation form validation', caseElicitationForm));
  cases.push(await runEvalCase('mcp.elicitation-url', 'Elicitation URL mode + tracker', caseElicitationUrl));
  cases.push(await runEvalCase('mcp.tasks-poll', 'Tasks poll to completion', caseTasksPoll));
  cases.push(await runEvalCase('mcp.tasks-cancel', 'Tasks cancel + malformed handles', caseTasksCancel));
  cases.push(await runEvalCase('mcp.fallback-handshake-old-server', 'Fallback handshake with old servers', caseFallbackHandshakeOldServer));
  return buildEvalSuiteResult('mcp-conformance', startedAt, cases);
}
