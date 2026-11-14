/**
 * MCP Tasks monitor (v1.06, Team T5 — UI v3).
 *
 * Pure helpers, no React, no IPC: progress, active/history split and
 * filtering for the tasks `mcp-tasks:list` returns (see
 * McpTaskViewLike in types.ts). The panel polls the same IPC the
 * existing McpTasksView uses and adds: a progress bar (elapsed vs
 * timeout), an Active / History split, status chips and search.
 */
import type { McpTaskStatusView, McpTaskViewLike } from '../types';
import { normalizeBotQuery } from './botList';

/** A task that still needs attention (running or waiting for input). */
export function isMcpTaskActive(task: McpTaskViewLike): boolean {
  return task.status === 'working' || task.status === 'input_required';
}

/**
 * Progress of a task, 0..100, or null when the task has no timeout to
 * measure against. A task past its timeout reports 100 (and
 * `isMcpTaskOverdue` flags it).
 */
export function mcpTaskProgress(task: McpTaskViewLike, now: number): number | null {
  if (task.timeoutMs === undefined || task.timeoutMs <= 0) return null;
  const elapsed = Math.max(0, now - task.createdAt);
  return Math.min(100, Math.round((elapsed / task.timeoutMs) * 100));
}

/** True when the task ran past its timeout without finishing. */
export function isMcpTaskOverdue(task: McpTaskViewLike, now: number): boolean {
  if (task.timeoutMs === undefined || task.timeoutMs <= 0) return false;
  return isMcpTaskActive(task) && now - task.createdAt > task.timeoutMs;
}

/** Elapsed time as a short `1h 2m` / `3m 4s` / `12s` string. */
export function formatMcpElapsed(task: McpTaskViewLike, now: number): string {
  const ms = Math.max(0, now - task.createdAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Split a task list into running tasks and finished history, both newest first. */
export function splitMcpTasks(tasks: McpTaskViewLike[]): {
  active: McpTaskViewLike[];
  history: McpTaskViewLike[];
} {
  const byUpdatedDesc = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    active: byUpdatedDesc.filter(isMcpTaskActive),
    history: byUpdatedDesc.filter((t) => !isMcpTaskActive(t)),
  };
}

export interface McpTaskFilter {
  /** Status to keep; 'all' keeps everything. */
  status: McpTaskStatusView | 'all';
  /** Free-text query (diacritic-insensitive, every token must match). */
  query: string;
}

/** Status filter + search over label / server / method / error. */
export function filterMcpTasks(tasks: McpTaskViewLike[], filter: McpTaskFilter): McpTaskViewLike[] {
  const tokens = normalizeBotQuery(filter.query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return tasks.filter((task) => {
    if (filter.status !== 'all' && task.status !== filter.status) return false;
    if (tokens.length === 0) return true;
    const haystack = normalizeBotQuery(
      [task.label, task.serverName, task.method, task.error ?? ''].join(' '),
    );
    return tokens.every((token) => haystack.includes(token));
  });
}
