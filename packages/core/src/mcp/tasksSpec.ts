/**
 * Tasks extension — spec-version gating (v1.04, Team T2).
 *
 * The Tasks extension changed shape between the two spec versions
 * the codebase already knows (`tasks.ts`):
 *
 *   - 2025-11-25 (experimental, SEP-1686): `tasks/get` returns a
 *     handle only; the final result comes from blocking
 *     `tasks/result`; `tasks/list` lists tasks; there is no way to
 *     send input to an `input_required` task.
 *   - 2026-07-28 (official extension
 *     `io.modelcontextprotocol/tasks`): `tasks/get` returns the
 *     final result directly when `completed`; `tasks/update` sends
 *     input to an `input_required` task; **`tasks/list` and
 *     `tasks/result` no longer exist**.
 *
 * v0.97 built the client adapter for both versions, but the
 * built-in server still served `tasks/list` and `tasks/result`
 * unconditionally — a 2026 client talking to it could not tell
 * which shape it was speaking. This module is the gate the server
 * (and any client-side guard) uses: one place that knows, per spec
 * version, which tasks methods exist and what to tell a caller
 * that uses a removed one.
 *
 * Ideas only — no code copied from any MCP implementation or SDK.
 */

import type { McpTaskSpecVersion } from './tasks';

/** Official extension name for the 2026-07-28 tasks shape. */
export const MCP_TASKS_EXTENSION_2026 = 'io.modelcontextprotocol/tasks';

/** The current (2026-07-28) tasks spec version — the default. */
export const MCP_TASKS_SPEC_VERSION_2026: McpTaskSpecVersion = '2026-07-28';

/** The legacy (2025-11-25) tasks spec version — compat only. */
export const MCP_TASKS_SPEC_VERSION_2025: McpTaskSpecVersion = '2025-11-25';

/** Tasks methods that exist in the 2025-11-25 shape. */
export const MCP_TASKS_METHODS_2025: readonly string[] = [
  'tasks/get',
  'tasks/result',
  'tasks/cancel',
  'tasks/list',
];

/** Tasks methods that exist in the 2026-07-28 shape. */
export const MCP_TASKS_METHODS_2026: readonly string[] = [
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
];

/**
 * Methods removed by the 2026-07-28 extension, with the method
 * that replaces each one.
 */
export const MCP_TASKS_REMOVED_IN_2026: readonly {
  method: string;
  replacement: string;
}[] = [
  {
    method: 'tasks/list',
    replacement: 'tasks/get (theo dõi từng taskId đã biết; server không còn liệt kê task)',
  },
  {
    method: 'tasks/result',
    replacement: 'tasks/get (trả luôn kết quả cuối khi status = completed)',
  },
];

/** Error thrown / returned when a tasks method is not available. */
export class McpTasksSpecError extends Error {
  readonly method: string;
  readonly specVersion: McpTaskSpecVersion;
  readonly replacement?: string;
  constructor(message: string, method: string, specVersion: McpTaskSpecVersion, replacement?: string) {
    super(message);
    this.name = 'McpTasksSpecError';
    this.method = method;
    this.specVersion = specVersion;
    if (replacement) this.replacement = replacement;
  }
}

/** Resolve a tasks spec version, defaulting to the 2026 extension. */
export function resolveTasksSpecVersion(input: unknown): McpTaskSpecVersion {
  if (input === '2025-11-25' || input === '2026-07-28') return input;
  return MCP_TASKS_SPEC_VERSION_2026;
}

/** True when the method was removed in the 2026-07-28 extension. */
export function isTasksMethodRemovedIn2026(method: string): boolean {
  return MCP_TASKS_REMOVED_IN_2026.some((entry) => entry.method === method);
}

/** Replacement method / flow for a removed tasks method. */
export function tasksMethodReplacement(method: string): string | undefined {
  return MCP_TASKS_REMOVED_IN_2026.find((entry) => entry.method === method)?.replacement;
}

/** All tasks methods available under a spec version. */
export function tasksMethodsFor(specVersion: McpTaskSpecVersion): readonly string[] {
  return specVersion === '2026-07-28' ? MCP_TASKS_METHODS_2026 : MCP_TASKS_METHODS_2025;
}

/** True when `tasks/get` returns the final result on completion. */
export function tasksGetReturnsResult(specVersion: McpTaskSpecVersion): boolean {
  return specVersion === '2026-07-28';
}

/** True when `tasks/update` can send input to an `input_required` task. */
export function tasksUpdateSupported(specVersion: McpTaskSpecVersion): boolean {
  return specVersion === '2026-07-28';
}

/**
 * Check whether a tasks method may be served under a spec version.
 * Returns `{ allowed: true }` or `{ allowed: false, error }` with a
 * migration message the server can send back verbatim (JSON-RPC
 * `-32601`, method not found — the method genuinely does not exist
 * under this spec version).
 */
export function checkTasksMethodAllowed(
  method: string,
  specVersion: McpTaskSpecVersion,
): { allowed: true } | { allowed: false; error: McpTasksSpecError } {
  if (specVersion === '2026-07-28' && isTasksMethodRemovedIn2026(method)) {
    const replacement = tasksMethodReplacement(method);
    return {
      allowed: false,
      error: new McpTasksSpecError(
        `Method "${method}" đã bị bỏ ở Tasks extension 2026-07-28 — dùng ${replacement ?? 'tasks/get'}.`,
        method,
        specVersion,
        replacement,
      ),
    };
  }
  if (!tasksMethodsFor(specVersion).includes(method)) {
    return {
      allowed: false,
      error: new McpTasksSpecError(
        `Method "${method}" không thuộc Tasks extension ${specVersion}.`,
        method,
        specVersion,
      ),
    };
  }
  return { allowed: true };
}

/**
 * One-line migration note for a removed tasks method, for logs and
 * for the `docs/mcp-2.0-migration.md` guide.
 */
export function tasksRemovedMethodNote(method: string): string {
  const replacement = tasksMethodReplacement(method);
  if (!replacement) return `Method "${method}" vẫn dùng được ở cả hai phiên bản Tasks.`;
  return `"${method}" đã bỏ ở Tasks 2026-07-28 → dùng ${replacement}. ` +
    `Client cũ (2025-11-25) vẫn gọi được khi server chạy tasksSpecVersion "2025-11-25".`;
}

/**
 * Describe the tasks shape a server speaks, for `server/discover`
 * notes and for the settings UI (one line per version).
 */
export function describeTasksSpecVersion(specVersion: McpTaskSpecVersion): string {
  if (specVersion === '2026-07-28') {
    return 'Tasks 2026-07-28 (io.modelcontextprotocol/tasks): tasks/get trả kết quả cuối, tasks/update gửi input, không có tasks/list/tasks/result.';
  }
  return 'Tasks 2025-11-25 (experimental): tasks/result (blocking) lấy kết quả cuối, tasks/list liệt kê task, chưa có tasks/update.';
}
