/**
 * Composio v129 tools (v1.29, Doi T4 — Composio v6) — registered in
 * ALL_TOOLS (see tools.ts).
 *
 * Background long jobs (5):
 * - `composio_long_job_submit_v129` — submit mot job dai (mock
 *   toolkit v129 + slug + args + totalSteps) -> job id + lich poll
 *   dau tien. Tra ve ngay, KHONG block agent turn. Chi chay
 *   toolkit mock v129 (chua co key that — job cho toolkit live se
 *   duoc mo khi Vault co key that).
 * - `composio_long_job_poll_v129` — poll mot job mot tick: chay
 *   toi da mot step mock, cap nhat lich poll (backoff + jitter),
 *   tra status + nextPollAtMs. Khong doi, khong sleep.
 * - `composio_long_job_get_v129` — status + tien trinh + ket qua
 *   (khi done) cua mot job.
 * - `composio_long_job_list_v129` — liet ke job (loc theo status /
 *   conversation / toolkit) + tong hop.
 * - `composio_long_job_cancel_v129` — yeu cau cancel (hop tac:
 *   job dung o step ke tiep, khong cat ngang giua step).
 *
 * Mock toolkits v129 (2):
 * - `composio_mock_toolkit_list_v129` — liet ke 4 toolkit Composio
 *   MOCK v129 (smartsheet/servicenow/klaviyo/onedrive) + slug ung
 *   vien + cach xac thuc tung toolkit. Chay duoc ngay, khong can key.
 * - `composio_mock_toolkit_execute_v129` — chay mot tool mock bang
 *   du lieu mau local (khong goi mang, khong can key). Response
 *   luon mang `mock: true, live: false`. Kiem tra param la truoc
 *   khi chay (bao loi ngay thay vi chay roi moi biet).
 *
 * Per-conversation sandbox (2):
 * - `composio_sandbox_create_v129` — tao ranh gioi sandbox cho mot
 *   conversation (toolkit duoc phep/cam, gioi han call/job/byte/
 *   poll/wall-clock, cho phep ghi hay khong).
 * - `composio_sandbox_status_v129` — usage vs limit + headroom +
 *   audit cuoi cua sandbox mot conversation.
 *
 * App bindings (1):
 * - `composio_app_bind_v129` — gan/bo gan/bat/tat/liet ke/kiem tra
 *   app (toolkit) theo conversation, kem scope read/write +
 *   defaultParams (param la bi tu choi luc luu).
 *
 * Kiem tra phong thu hai lop: khi tool nhan `conversationId`, no
 * kiem tra ca app binding (app co duoc dung trong conversation
 * khong, du scope khong) lan sandbox admit (con quota khong,
 * toolkit co duoc phep khong, tool ghi co duoc phep khong) — ca
 * hai deu phai cho phep thi call moi chay. Khong co conversationId
 * thi khong ap dung hai lop nay (job/call global, mock-only).
 *
 * Tat ca 10 tool chay duoc ngay ca khi chua bind, khong doc/ghi
 * file, khong can Composio API key. Host co the bind store dung
 * chung qua ComposioV129ToolOptions de nhieu tool chia se mot
 * session state (job/sandbox/binding giong nhau giua cac turn).
 */

import type { Tool } from '@open-bot/core';
import {
  COMPOSIO_V129_MOCK_TOOLKITS,
  MemoryComposioV129BindingStore,
  MemoryComposioV129JobStore,
  MemoryComposioV129SandboxStore,
  admitComposioV129SandboxCall,
  checkComposioV129AppBinding,
  composioV129PollDelayTable,
  createComposioV129PollSchedule,
  defaultComposioV129MachineBindings,
  executeMockComposioV129Tool,
  isComposioV129TerminalJobStatus,
  listComposioV129Jobs,
  mockComposioV129ToolNeedsApproval,
  parseComposioV129Job,
  pollComposioV129JobOnce,
  recordComposioV129SandboxCall,
  recordComposioV129SandboxDenial,
  recordComposioV129SandboxJobFinished,
  requestComposioV129JobCancel,
  resolveMockComposioV129Slug,
  summarizeComposioV129Job,
  summarizeComposioV129Jobs,
  summarizeComposioV129Sandbox,
  summarizeMockComposioV129Catalogue,
  validateMockComposioV129Params,
  type ComposioV129AppBinding,
  type ComposioV129JobConfig,
  type ComposioV129LongJob,
  type ComposioV129PollPolicy,
  type ComposioV129PollSchedule,
  type ComposioV129SandboxCall,
} from '@open-bot/core';

export const COMPOSIO_V129_TOOL_NAMES = [
  'composio_long_job_submit_v129',
  'composio_long_job_poll_v129',
  'composio_long_job_get_v129',
  'composio_long_job_list_v129',
  'composio_long_job_cancel_v129',
  'composio_mock_toolkit_list_v129',
  'composio_mock_toolkit_execute_v129',
  'composio_sandbox_create_v129',
  'composio_sandbox_status_v129',
  'composio_app_bind_v129',
] as const;

export function isComposioV129ToolName(name: string): boolean {
  return (COMPOSIO_V129_TOOL_NAMES as readonly string[]).includes(name);
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

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function okResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Argument "${name}" must be a boolean.`);
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return [...(value as string[])];
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Host wiring cho tool Composio v129 (theo mau coding v14 /
 * protocol v5): host dua store dung chung trong session — neu
 * khong dua thi moi lan goi createComposioV129Tools() tao store
 * moi trong bo nho (tool van chay duoc ngay).
 */
export interface ComposioV129ToolOptions {
  jobStore?: MemoryComposioV129JobStore;
  sandboxStore?: MemoryComposioV129SandboxStore;
  bindingStore?: MemoryComposioV129BindingStore;
  /** Lich poll dung chung theo job id (neu khong dua thi tao Map moi). */
  pollSchedules?: Map<string, ComposioV129PollSchedule>;
  /** Default app cua may (neu khong dua thi dung default read-only v129). */
  machineDefaults?: ComposioV129AppBinding[];
  jobConfig?: ComposioV129JobConfig;
  pollPolicy?: ComposioV129PollPolicy;
  /** Clock de test (mac dinh Date.now). */
  nowMs?: () => number;
}

/** Step mock cho long job: chay tool mock v129, gan so step vao ket qua. */
function mockStepFn(job: ComposioV129LongJob, stepIndex: number): unknown {
  const result = executeMockComposioV129Tool(job.toolkit, job.slug, { ...job.args });
  return { step: stepIndex + 1, ...result.data };
}

export function createComposioV129Tools(options: ComposioV129ToolOptions = {}): Tool[] {
  const jobStore = options.jobStore ?? new MemoryComposioV129JobStore();
  const sandboxStore = options.sandboxStore ?? new MemoryComposioV129SandboxStore();
  const bindingStore = options.bindingStore ?? new MemoryComposioV129BindingStore();
  const pollSchedules = options.pollSchedules ?? new Map<string, ComposioV129PollSchedule>();
  const jobConfig = options.jobConfig ?? {};
  const pollPolicy = options.pollPolicy ?? {};
  const nowMs = options.nowMs ?? (() => Date.now());
  const machineDefaults = options.machineDefaults ?? defaultComposioV129MachineBindings(nowMs());

  /** Lay (hoac tao) lich poll cho mot job. */
  function scheduleFor(job: ComposioV129LongJob, now: number): ComposioV129PollSchedule {
    const existing = pollSchedules.get(job.id);
    if (existing) return existing;
    const created = createComposioV129PollSchedule(job.id, now, pollPolicy);
    pollSchedules.set(job.id, created);
    return created;
  }

  /**
   * Kiem tra hai lop (binding + sandbox) truoc mot call co
   * conversationId. Tra loi (string) khi bi chan, null khi duoc
   * phep. Khi bi chan boi sandbox thi ghi denial vao audit.
   */
  function guardConversationCall(
    conversationId: string | undefined,
    call: ComposioV129SandboxCall,
    now: number,
  ): string | null {
    if (!conversationId) return null;
    const bindingCheck = checkComposioV129AppBinding(
      bindingStore.listAll(),
      conversationId,
      call.toolkit,
      call.slug,
      machineDefaults,
    );
    if (!bindingCheck.allowed) return bindingCheck.reason ?? 'App binding denied.';
    const sandbox = sandboxStore.getByConversation(conversationId);
    if (!sandbox) return null;
    const admit = admitComposioV129SandboxCall(sandbox, call, now);
    if (!admit.allowed) {
      sandboxStore.save(recordComposioV129SandboxDenial(sandbox, call, admit.reason ?? 'denied', now));
      return admit.reason ?? 'Sandbox denied.';
    }
    return null;
  }

  /** Ghi nhan mot call da chay vao sandbox cua conversation (neu co). */
  function recordSandbox(
    conversationId: string | undefined,
    call: ComposioV129SandboxCall,
    resultBytes: number,
    now: number,
  ): void {
    if (!conversationId) return;
    const sandbox = sandboxStore.getByConversation(conversationId);
    if (!sandbox) return;
    sandboxStore.save(recordComposioV129SandboxCall(sandbox, call, resultBytes, now));
  }

  /** Ghi nhan mot job ket thuc vao sandbox (giai phong slot). */
  function recordSandboxJobFinished(job: ComposioV129LongJob, now: number): void {
    if (!job.conversationId) return;
    const sandbox = sandboxStore.getByConversation(job.conversationId);
    if (!sandbox) return;
    sandboxStore.save(recordComposioV129SandboxJobFinished(sandbox, job.id, job.status, now));
  }

  const longJobSubmitTool: Tool = {
    definition: toolDef(
      'composio_long_job_submit_v129',
      'Submit a Composio background long job (mock toolkit v129 only — smartsheet/servicenow/klaviyo/onedrive) and return its job id + first poll time immediately. Never blocks the agent turn; poll the job with composio_long_job_poll_v129. With conversationId, the app binding + sandbox are enforced first.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug v129: smartsheet, servicenow, klaviyo or onedrive.' },
        slug: { type: 'string', description: 'Candidate tool slug of that toolkit, e.g. SMARTSHEET_LIST_ROWS.' },
        args: { type: 'object', description: 'Tool arguments (stored on the job; echoed in mock step results).' },
        totalSteps: { type: 'number', description: 'Expected number of steps (default 1, max 1000).' },
        timeoutMs: { type: 'number', description: 'Absolute job timeout in ms (default 600000).' },
        conversationId: { type: 'string', description: 'Conversation owning the job — enables binding + sandbox checks.' },
        id: { type: 'string', description: 'Optional explicit job id (for dedupe/tests).' },
      },
      ['toolkit', 'slug'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = nowMs();
        const toolkit = getStringArg(args, 'toolkit');
        const slug = getStringArg(args, 'slug');
        const toolArgs = getObjectArg(args, 'args');
        const totalSteps = getNumberArg(args, 'totalSteps', 1);
        const timeoutMs = args['timeoutMs'] === undefined ? undefined : getNumberArg(args, 'timeoutMs', 0);
        const conversationId = args['conversationId'] === undefined ? undefined : getStringArg(args, 'conversationId');
        const id = args['id'] === undefined ? undefined : getStringArg(args, 'id');
        // Slug phai thuoc toolkit mock v129 (khong co key that thi
        // khong chay toolkit live — job that cho live se mo sau).
        resolveMockComposioV129Slug(toolkit, slug);
        const unknownParams = validateMockComposioV129Params(slug, toolArgs);
        if (unknownParams.length > 0) {
          throw new Error(`Unknown params for ${slug}: ${unknownParams.join(', ')}`);
        }
        const denied = guardConversationCall(
          conversationId,
          { toolkit, slug, kind: 'job-submit' },
          now,
        );
        if (denied) throw new Error(denied);
        const job = jobStore.submit(
          {
            toolkit,
            slug,
            args: toolArgs,
            ...(conversationId ? { conversationId } : {}),
            totalSteps,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(id ? { id } : {}),
          },
          now,
          jobConfig,
        );
        const schedule = scheduleFor(job, now);
        recordSandbox(conversationId, { toolkit, slug, kind: 'job-submit' }, JSON.stringify(job.args).length, now);
        return okResult({
          mock: true,
          live: false,
          jobId: job.id,
          status: job.status,
          needsApproval: job.needsApproval,
          totalSteps: job.totalSteps,
          timeoutAtMs: job.timeoutAtMs,
          nextPollAtMs: schedule.nextPollAtMs,
          pollDelayTable: composioV129PollDelayTable(pollPolicy, 4),
          note: 'Job submitted — poll with composio_long_job_poll_v129; the agent turn is not blocked.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const longJobPollTool: Tool = {
    definition: toolDef(
      'composio_long_job_poll_v129',
      'Poll one Composio long job once: run at most one mock step, update the poll schedule (exponential backoff + deterministic jitter), and return the status + nextPollAtMs immediately. Never waits or sleeps.',
      {
        jobId: { type: 'string', description: 'Job id returned by composio_long_job_submit_v129.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['jobId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const jobId = getStringArg(args, 'jobId');
        const job = jobStore.get(jobId);
        if (!job) throw new Error(`Unknown Composio v129 job: ${jobId}`);
        const wasTerminal = isComposioV129TerminalJobStatus(job.status);
        const schedule = scheduleFor(job, now);
        const result = pollComposioV129JobOnce(job, schedule, now, mockStepFn, pollPolicy, jobConfig);
        jobStore.save(result.job);
        pollSchedules.set(job.id, result.schedule);
        recordSandbox(
          result.job.conversationId,
          { toolkit: result.job.toolkit, slug: result.job.slug, kind: 'poll' },
          JSON.stringify(result.job.stepResults.slice(-1)).length,
          now,
        );
        if (!wasTerminal && isComposioV129TerminalJobStatus(result.job.status)) {
          recordSandboxJobFinished(result.job, now);
        }
        return okResult({
          mock: true,
          live: false,
          job: summarizeComposioV129Job(result.job, now),
          outcome: result.outcome,
          nextDelayMs: result.nextDelayMs,
          nextPollAtMs: result.schedule.nextPollAtMs,
          finished: result.finished,
          note: result.note,
          ...(result.job.result !== null ? { result: result.job.result } : {}),
          ...(result.job.error ? { error: result.job.error } : {}),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const longJobGetTool: Tool = {
    definition: toolDef(
      'composio_long_job_get_v129',
      'Get the status, progress and result (when done) of one Composio long job, with the latest step results.',
      {
        jobId: { type: 'string', description: 'Job id returned by composio_long_job_submit_v129.' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
        stepTail: { type: 'number', description: 'How many latest step results to include (default 5).' },
      },
      ['jobId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const jobId = getStringArg(args, 'jobId');
        const stepTail = getNumberArg(args, 'stepTail', 5);
        const job = jobStore.get(jobId);
        if (!job) throw new Error(`Unknown Composio v129 job: ${jobId}`);
        return okResult({
          mock: true,
          live: false,
          job: summarizeComposioV129Job(job, now),
          stepResultsTail: job.stepResults.slice(-Math.max(0, Math.floor(stepTail))),
          ...(job.result !== null ? { result: job.result } : {}),
          ...(job.error ? { error: job.error } : {}),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const longJobListTool: Tool = {
    definition: toolDef(
      'composio_long_job_list_v129',
      'List Composio long jobs with an optional filter (status / conversation / toolkit / active only) plus totals by status.',
      {
        status: { type: 'string', description: 'Filter by status: pending, running, done, failed, cancelled or timed-out.' },
        conversationId: { type: 'string', description: 'Filter by owning conversation.' },
        toolkit: { type: 'string', description: 'Filter by toolkit slug.' },
        activeOnly: { type: 'boolean', description: 'Only jobs that have not finished yet (default false).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const jobs = listComposioV129Jobs(jobStore.list(), {
          ...(args['status'] !== undefined ? { status: getStringArg(args, 'status', false) as ComposioV129LongJob['status'] } : {}),
          ...(args['conversationId'] !== undefined ? { conversationId: getStringArg(args, 'conversationId', false) } : {}),
          ...(args['toolkit'] !== undefined ? { toolkit: getStringArg(args, 'toolkit', false) } : {}),
          activeOnly: getBooleanArg(args, 'activeOnly', false),
        });
        return okResult({
          mock: true,
          live: false,
          jobs: jobs.map((job) => summarizeComposioV129Job(job, now)),
          summary: summarizeComposioV129Jobs(jobStore.list(), now),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const longJobCancelTool: Tool = {
    definition: toolDef(
      'composio_long_job_cancel_v129',
      'Request cancellation of a Composio long job (cooperative: the job stops at the next poll tick, it is not cut off mid-step). Returns whether the cancel was accepted.',
      {
        jobId: { type: 'string', description: 'Job id returned by composio_long_job_submit_v129.' },
        reason: { type: 'string', description: 'Cancel reason (default: cancelled by user).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['jobId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const jobId = getStringArg(args, 'jobId');
        const reason = args['reason'] === undefined ? 'cancelled by user' : getStringArg(args, 'reason');
        const job = jobStore.get(jobId);
        if (!job) throw new Error(`Unknown Composio v129 job: ${jobId}`);
        const { job: next, cancelled } = requestComposioV129JobCancel(job, now, reason);
        jobStore.save(next);
        return okResult({
          mock: true,
          live: false,
          jobId: next.id,
          cancelled,
          status: next.status,
          cancelRequested: next.cancelRequested,
          note: cancelled
            ? 'Cancel requested — the job stops at the next poll tick.'
            : `Job already ${next.status}; cancel not accepted.`,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mockToolkitListTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_list_v129',
      'List the 4 Composio MOCK toolkits v129 (smartsheet/servicenow/klaviyo/onedrive) with candidate tool slugs + auth kind/note per toolkit. Mock-only, no key, no network — slugs are candidates, NOT live-verified.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      try {
        const summary = summarizeMockComposioV129Catalogue();
        return okResult({
          mock: true,
          live: false,
          totalToolkits: COMPOSIO_V129_MOCK_TOOLKITS.length,
          totalSlugs: summary.totalSlugs,
          writeSlugs: summary.writeSlugs,
          readSlugs: summary.readSlugs,
          toolkits: COMPOSIO_V129_MOCK_TOOLKITS.map((t) => ({
            slug: t.slug,
            label: t.label,
            icon: t.icon,
            description: t.description,
            candidateToolSlugs: [...t.candidateToolSlugs],
            authKind: t.authKind,
            authNote: t.authNote,
            mockOnly: t.mockOnly,
            liveVerified: t.liveVerified,
          })),
          note: 'Mock-only: no live Composio call. To run for real, add a Composio API key to the Vault and verify each slug against the live Composio catalog first.',
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mockToolkitExecuteTool: Tool = {
    definition: toolDef(
      'composio_mock_toolkit_execute_v129',
      'Run one mock Composio v129 tool with deterministic local sample data (no network, no key). The response always carries mock: true, live: false. Unknown params are rejected before running. With conversationId, the app binding + sandbox are enforced first.',
      {
        toolkit: { type: 'string', description: 'Mock toolkit slug: smartsheet, servicenow, klaviyo or onedrive.' },
        slug: { type: 'string', description: 'Candidate tool slug of that toolkit, e.g. SMARTSHEET_LIST_SHEETS.' },
        args: { type: 'object', description: 'Tool arguments (echoed back in data.echo; the mock never executes anything).' },
        conversationId: { type: 'string', description: 'Conversation owning the call — enables binding + sandbox checks.' },
      },
      ['toolkit', 'slug'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = nowMs();
        const toolkit = getStringArg(args, 'toolkit');
        const slug = getStringArg(args, 'slug');
        const toolArgs = getObjectArg(args, 'args');
        const conversationId = args['conversationId'] === undefined ? undefined : getStringArg(args, 'conversationId');
        const unknownParams = validateMockComposioV129Params(slug, toolArgs);
        if (unknownParams.length > 0) {
          throw new Error(`Unknown params for ${slug}: ${unknownParams.join(', ')}`);
        }
        const denied = guardConversationCall(conversationId, { toolkit, slug, kind: 'call' }, now);
        if (denied) throw new Error(denied);
        const needsApproval = mockComposioV129ToolNeedsApproval(slug);
        const result = executeMockComposioV129Tool(toolkit, slug, toolArgs);
        recordSandbox(conversationId, { toolkit, slug, kind: 'call' }, JSON.stringify(result).length, now);
        return okResult({ ...result, needsApproval });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sandboxCreateTool: Tool = {
    definition: toolDef(
      'composio_sandbox_create_v129',
      'Create (or replace) the per-conversation Composio sandbox boundary: allowed/denied toolkits, call/job/byte/poll/wall-clock limits, and whether write tools are allowed. Returns the boundary summary.',
      {
        conversationId: { type: 'string', description: 'Conversation the sandbox belongs to.' },
        allowedToolkits: { type: 'array', items: { type: 'string' }, description: 'Toolkits allowed in this conversation (empty = all).' },
        deniedToolkits: { type: 'array', items: { type: 'string' }, description: 'Toolkits always denied (denied beats allowed).' },
        maxCalls: { type: 'number', description: 'Max Composio calls in this conversation (default 200).' },
        maxConcurrentJobs: { type: 'number', description: 'Max long jobs running at once (default 5).' },
        maxTotalResultBytes: { type: 'number', description: 'Max cumulative result bytes (default 1000000).' },
        maxPolls: { type: 'number', description: 'Max polls across all jobs (default 1000).' },
        maxWallMs: { type: 'number', description: 'Sandbox lifetime in ms from creation (default 1800000).' },
        allowWrite: { type: 'boolean', description: 'Whether write tools are allowed (default false).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const conversationId = getStringArg(args, 'conversationId');
        const limits: Record<string, number | boolean> = {};
        if (args['maxCalls'] !== undefined) limits['maxCalls'] = getNumberArg(args, 'maxCalls', 200);
        if (args['maxConcurrentJobs'] !== undefined) limits['maxConcurrentJobs'] = getNumberArg(args, 'maxConcurrentJobs', 5);
        if (args['maxTotalResultBytes'] !== undefined) limits['maxTotalResultBytes'] = getNumberArg(args, 'maxTotalResultBytes', 1000000);
        if (args['maxPolls'] !== undefined) limits['maxPolls'] = getNumberArg(args, 'maxPolls', 1000);
        if (args['maxWallMs'] !== undefined) limits['maxWallMs'] = getNumberArg(args, 'maxWallMs', 1800000);
        if (args['allowWrite'] !== undefined) limits['allowWrite'] = getBooleanArg(args, 'allowWrite', false);
        const boundary = sandboxStore.create(
          {
            conversationId,
            allowedToolkits: getStringArrayArg(args, 'allowedToolkits'),
            deniedToolkits: getStringArrayArg(args, 'deniedToolkits'),
            limits: limits as Parameters<typeof sandboxStore.create>[0]['limits'],
          },
          now,
        );
        return okResult({
          mock: true,
          live: false,
          sandbox: summarizeComposioV129Sandbox(boundary, now),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sandboxStatusTool: Tool = {
    definition: toolDef(
      'composio_sandbox_status_v129',
      'Show the usage vs limits, headroom and latest audit entries of the Composio sandbox for one conversation.',
      {
        conversationId: { type: 'string', description: 'Conversation the sandbox belongs to.' },
        auditTail: { type: 'number', description: 'How many latest audit entries to include (default 5).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['conversationId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const conversationId = getStringArg(args, 'conversationId');
        const auditTail = getNumberArg(args, 'auditTail', 5);
        const boundary = sandboxStore.getByConversation(conversationId);
        if (!boundary) throw new Error(`No Composio v129 sandbox for conversation: ${conversationId}`);
        return okResult({
          mock: true,
          live: false,
          sandbox: summarizeComposioV129Sandbox(boundary, now, Math.max(0, Math.floor(auditTail))),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const appBindTool: Tool = {
    definition: toolDef(
      'composio_app_bind_v129',
      'Manage per-conversation Composio app bindings: bind an app (toolkit) with read/write scopes + default params, unbind it, enable/disable it, list a conversation apps, or check whether a tool may run there. Unknown default params are rejected at bind time.',
      {
        action: { type: 'string', description: 'Action: bind, unbind, enable, disable, list or check.' },
        conversationId: { type: 'string', description: 'Conversation the binding belongs to.' },
        toolkit: { type: 'string', description: 'Toolkit slug, e.g. smartsheet (required for bind/unbind/enable/disable/check).' },
        slug: { type: 'string', description: 'Tool slug to check (for action=check), e.g. SMARTSHEET_CREATE_ROW.' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes for bind: read and/or write (default read).' },
        enabled: { type: 'boolean', description: 'Enabled flag for bind/enable/disable (default true for bind).' },
        sandboxBoundaryId: { type: 'string', description: 'Sandbox boundary id to link the binding to (bind only).' },
        defaultParams: { type: 'object', description: 'Default params for the app tools (bind only; unknown names rejected).' },
        nowMs: { type: 'number', description: 'Current epoch ms (default: Date.now()).' },
      },
      ['action', 'conversationId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const now = args['nowMs'] === undefined ? nowMs() : getNumberArg(args, 'nowMs', Date.now());
        const action = getStringArg(args, 'action');
        const conversationId = getStringArg(args, 'conversationId');
        if (action === 'list') {
          return okResult({
            mock: true,
            live: false,
            bindings: bindingStore.listForConversation(conversationId),
            summary: bindingStore.summary(conversationId),
          });
        }
        if (!['bind', 'unbind', 'enable', 'disable', 'check'].includes(action)) {
          throw new Error(`Unknown action: ${action}`);
        }
        const toolkit = getStringArg(args, 'toolkit');
        if (action === 'bind') {
          const scopes = getStringArrayArg(args, 'scopes');
          const enabled = getBooleanArg(args, 'enabled', true);
          const defaultParams = getObjectArg(args, 'defaultParams');
          const sandboxBoundaryId = args['sandboxBoundaryId'] === undefined ? undefined : getStringArg(args, 'sandboxBoundaryId');
          const binding = bindingStore.bind(
            {
              conversationId,
              toolkit,
              ...(scopes.length > 0 ? { scopes: scopes as ('read' | 'write')[] } : {}),
              enabled,
              ...(sandboxBoundaryId ? { sandboxBoundaryId } : {}),
              defaultParams,
            },
            now,
          );
          return okResult({ mock: true, live: false, action: 'bind', binding });
        }
        if (action === 'unbind') {
          const removed = bindingStore.unbind(conversationId, toolkit, now);
          if (!removed) throw new Error(`No Composio v129 binding for ${conversationId}/${toolkit}`);
          return okResult({ mock: true, live: false, action: 'unbind', conversationId, toolkit, removed: true });
        }
        if (action === 'enable' || action === 'disable') {
          const enabled = action === 'enable' ? getBooleanArg(args, 'enabled', true) : false;
          const binding = bindingStore.setEnabled(conversationId, toolkit, enabled, now);
          if (!binding) throw new Error(`No Composio v129 binding for ${conversationId}/${toolkit}`);
          return okResult({ mock: true, live: false, action, binding });
        }
        if (action === 'check') {
          const slug = getStringArg(args, 'slug');
          const check = checkComposioV129AppBinding(
            bindingStore.listAll(),
            conversationId,
            toolkit,
            slug,
            machineDefaults,
          );
          return okResult({
            mock: true,
            live: false,
            action: 'check',
            conversationId,
            toolkit,
            slug,
            neededScope: check.neededScope,
            allowed: check.allowed,
            ...(check.reason ? { reason: check.reason } : {}),
          });
        }
        // Unreachable (action was validated above) — keeps the
        // compiler happy that every path returns or throws.
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    longJobSubmitTool,
    longJobPollTool,
    longJobGetTool,
    longJobListTool,
    longJobCancelTool,
    mockToolkitListTool,
    mockToolkitExecuteTool,
    sandboxCreateTool,
    sandboxStatusTool,
    appBindTool,
  ];
}

export const COMPOSIO_V129_TOOLS: Tool[] = createComposioV129Tools();

// Kept for debugging: parse a checkpoint produced by longJobsV129.
export { parseComposioV129Job };
