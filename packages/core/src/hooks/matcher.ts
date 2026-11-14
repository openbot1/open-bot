/**
 * Hook matcher + priority (v1.04, T3a — Harness Engineering).
 *
 * Two gaps vs Claude Code's hook surface that v1.03 did not have:
 *
 * 1. MATCHER — a hook should be able to say "only run me for these
 *    tools". Claude Code's `hooks.json` has a `matcher` field on
 *    PreToolUse / PostToolUse entries (a tool-name glob such as
 *    `"Bash"` or `"Write|Edit"`). Before this, every PreToolUse hook
 *    ran for every tool call and had to filter inside its handler.
 *    A matcher is a glob (`*` = any run of characters, `?` = one
 *    character, everything else literal) or a list of globs; an
 *    undefined matcher means "all tools" (back-compat: existing hooks
 *    behave exactly as before).
 * 2. PRIORITY — hooks ran strictly in registration order. A `priority`
 *    number (default 100, lower runs first) lets a safety hook declare
 *    "run me before the logging hook" without depending on who
 *    registered first. Ties keep registration order (stable sort).
 *
 * Both live on `HookDefinition` and on the settings entries
 * (`HookSettingsEntry`, `HookCommandSettingsEntry`), so a user can
 * narrow/override them from settings without touching code.
 *
 * Pure functions, no I/O — safe to unit-test without a registry.
 */

import { DEFAULT_HOOK_PRIORITY, HookRegistrationError } from './types';
import type { HookMatcher } from './types';

export { DEFAULT_HOOK_PRIORITY };

/** Events a matcher applies to (only tool events carry a tool name). */
export function isToolHookEvent(event: string): boolean {
  return event === 'PreToolUse' || event === 'PostToolUse';
}

/**
 * Match one glob against a tool name. `*` matches any run of
 * characters (including empty), `?` matches exactly one character.
 * Matching is case-sensitive: tool names are identifiers, and a
 * case-insensitive match would silently catch tools the author did
 * not intend (`bash` vs `Bash` are different tools).
 */
export function matchesToolName(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRegExpChar(ch);
  }
  re += '$';
  return new RegExp(re).test(toolName);
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
}

/**
 * Normalise a matcher value to a list of globs, or `undefined` when
 * the hook runs for every tool. Throws `HookRegistrationError` on a
 * bad shape (empty string, empty list, non-string item) so a typo is
 * caught at registration time, never silently ignored at run time.
 */
export function normalizeHookMatcher(matcher: unknown): string[] | undefined {
  if (matcher === undefined || matcher === null) return undefined;
  const list = Array.isArray(matcher) ? matcher : [matcher];
  if (list.length === 0) {
    throw new HookRegistrationError('Hook matcher must not be an empty list.');
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HookRegistrationError(
        `Hook matcher must be a non-empty string (got ${JSON.stringify(item)}).`,
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * Does this hook's matcher admit `toolName`? An undefined matcher
 * admits everything. Used by the registry when listing hooks for a
 * PreToolUse / PostToolUse event.
 */
export function matchesHookMatcher(
  matcher: string | string[] | undefined,
  toolName: string | undefined,
): boolean {
  if (matcher === undefined) return true;
  if (toolName === undefined) return true;
  const patterns = Array.isArray(matcher) ? matcher : [matcher];
  return patterns.some((p) => matchesToolName(p, toolName));
}

/**
 * Validate a priority value. Must be a finite integer (any magnitude:
 * the author decides the band). Returns the validated value so
 * callers can store it normalised.
 */
export function validateHookPriority(priority: unknown, hookName: string): number {
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    throw new HookRegistrationError(
      `Hook "${hookName}" priority must be an integer (got ${JSON.stringify(priority)}).`,
    );
  }
  return priority;
}

/**
 * Validate a per-hook timeout (ms). Must be an integer inside the
 * same bounds as shell-command hooks: 100ms … 300_000ms. A timeout
 * outside that range is almost certainly a units mistake (seconds
 * passed as ms, or 0 meaning "no timeout" — which this layer does not
 * offer: a hanging hook must always be killed).
 */
export function validateHookTimeoutMs(timeoutMs: unknown, hookName: string): number {
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) {
    throw new HookRegistrationError(
      `Hook "${hookName}" timeoutMs must be an integer number of milliseconds.`,
    );
  }
  if (timeoutMs < 100 || timeoutMs > 300_000) {
    throw new HookRegistrationError(
      `Hook "${hookName}" timeoutMs must be between 100 and 300000 ms (got ${timeoutMs}).`,
    );
  }
  return timeoutMs;
}
