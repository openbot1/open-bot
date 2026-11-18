/**
 * Sandbox v3 — PreToolUse / PostToolUse hooks (v1.35, Team T2).
 *
 * Before and after every tool call that runs inside a sandbox v3
 * session, the runner asks the hook registry:
 *
 *  - PreToolUse: "may this call run, and with which arguments?"
 *    A hook may allow it, deny it (the step is recorded as
 *    `denied` and never executes), or modify it (rewrite the
 *    arguments — for example, force a read-only path, or strip a
 *    dangerous flag). Deny wins over modify: when any matching
 *    pre-hook denies, the call does not run, no matter what the
 *    other hooks said.
 *  - PostToolUse: "may the agent see this result?" A hook may
 *    allow the result through, deny it (the result is withheld and
 *    replaced by the hook's message — used to keep secrets or
 *    huge outputs out of the transcript), or modify it (replace
 *    the result text with a redacted summary).
 *
 * Matching: a hook matches a tool call when its `toolPattern`
 * matches the tool name AND, when `argKey` is set, the call has
 * that argument key. Patterns are small globs: `*` matches
 * anything, `sandbox_v3_*` matches a prefix, `*_run` matches a
 * suffix, `a*b` matches a prefix + suffix. No regexes: hook
 * authors should not be able to smuggle a catastrophic pattern
 * into the registry.
 *
 * Evaluation order: hooks run by ascending priority, then by
 * registration order. Every evaluation is recorded (which hooks
 * matched, what they decided) so the session report can explain
 * exactly why a step was blocked or rewritten. Disabled hooks are
 * skipped silently — they stay in the registry for re-enabling.
 *
 * Hooks are data, not code: a hook is a record with a decision,
 * not a callback. Nothing in this module executes user code, and
 * a hook can never allow something the syscall allowlist, the
 * egress gate or the lifecycle already denied — hooks only add
 * restrictions (or rewrite arguments within what is allowed).
 */

import { randomUUID } from 'node:crypto';
import type {
  SandboxV3Hook,
  SandboxV3HookDecision,
  SandboxV3HookEvaluation,
  SandboxV3HookMatcher,
  SandboxV3HookTiming,
} from './types';

/** A tool call as the hooks see it. */
export interface SandboxV3ToolCall {
  /** Tool name, e.g. `sandbox_v3_run`. */
  tool: string;
  /** Arguments the agent passed. */
  args: Record<string, unknown>;
  /** Tool call id (agent-side), when known. */
  toolCallId?: string;
}

/** What a post-hook evaluation returns for one tool result. */
export interface SandboxV3PostHookEvaluation {
  /** Final decision after all matching post-hooks ran. */
  decision: SandboxV3HookDecision;
  /** Result text the agent should see (rewritten when modified / denied). */
  result: string;
  /** Ids of the hooks that matched, in evaluation order. */
  matchedHookIds: string[];
  /** Human-readable explanation of the final decision. */
  reason: string;
  /** True when at least one hook denied the result. */
  denied: boolean;
  /** True when at least one hook rewrote the result. */
  modified: boolean;
}

/** One recorded hook evaluation (pre or post). */
export interface SandboxV3HookAuditEntry {
  /** When it happened (ms since epoch). */
  atMs: number;
  /** Which phase ran. */
  timing: SandboxV3HookTiming;
  /** Tool the call targeted. */
  tool: string;
  /** Decision the registry returned. */
  decision: SandboxV3HookDecision;
  /** Hook ids that matched, in evaluation order. */
  matchedHookIds: string[];
  /** Explanation of the final decision. */
  reason: string;
}

/**
 * Match a tool name against a glob pattern. Supported shapes:
 * `*` (all), `prefix*`, `*suffix`, `pre*post`, exact. Matching is
 * case-sensitive: tool names are lower-case by convention and a
 * pattern that differs only by case does not match.
 */
export function matchToolPattern(tool: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return tool === pattern;
  const parts = pattern.split('*');
  if (parts.length === 2) {
    const [prefix, suffix] = parts;
    return tool.startsWith(prefix) && tool.endsWith(suffix) &&
      tool.length >= prefix.length + suffix.length;
  }
  // Multiple `*`: walk the literal segments in order.
  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '') continue;
    const index = tool.indexOf(part, cursor);
    if (index === -1) return false;
    if (i === 0 && index !== 0) return false;
    cursor = index + part.length;
  }
  if (!pattern.endsWith('*') && !tool.endsWith(parts[parts.length - 1])) return false;
  return true;
}

/** True when a tool call matches a hook's matcher (absent = all). */
export function hookMatches(
  call: SandboxV3ToolCall,
  matcher?: SandboxV3HookMatcher,
): boolean {
  if (!matcher) return true;
  if (matcher.toolPattern !== undefined) {
    if (!matchToolPattern(call.tool, matcher.toolPattern)) return false;
  }
  if (matcher.argKey !== undefined) {
    if (!(matcher.argKey in call.args)) return false;
  }
  return true;
}

/** Validate a hook matcher (pattern must be a non-empty string). */
export function validateHookMatcher(matcher: unknown): string[] {
  const problems: string[] = [];
  if (matcher === undefined || matcher === null) return problems;
  if (typeof matcher !== 'object' || Array.isArray(matcher)) {
    return ['matcher must be an object'];
  }
  const doc = matcher as Record<string, unknown>;
  if (doc.toolPattern !== undefined) {
    if (typeof doc.toolPattern !== 'string' || doc.toolPattern === '') {
      problems.push('matcher.toolPattern must be a non-empty string');
    } else if (doc.toolPattern.includes('**')) {
      problems.push('matcher.toolPattern must not contain "**"');
    }
  }
  if (doc.argKey !== undefined && (typeof doc.argKey !== 'string' || doc.argKey === '')) {
    problems.push('matcher.argKey must be a non-empty string');
  }
  return problems;
}

export interface RegisterHookSpec {
  name: string;
  timing: SandboxV3HookTiming;
  matcher?: SandboxV3HookMatcher;
  decision: SandboxV3HookDecision;
  modifyArgs?: Record<string, unknown>;
  message?: string;
  enabled?: boolean;
  priority?: number;
}

/**
 * Registry of PreToolUse / PostToolUse hooks for one session (or
 * one host, shared across sessions — the runner creates one per
 * session by default). Hooks are evaluated in priority order.
 */
export class SandboxV3HookRegistry {
  private readonly hooks: SandboxV3Hook[] = [];
  private readonly audit: SandboxV3HookAuditEntry[] = [];
  private sequence = 0;

  /** Register a hook. Returns the stored hook (with its id). */
  register(spec: RegisterHookSpec): SandboxV3Hook {
    if (typeof spec.name !== 'string' || spec.name.trim() === '') {
      throw new Error('Hook name must be a non-empty string');
    }
    if (spec.timing !== 'pre' && spec.timing !== 'post') {
      throw new Error(`Hook timing must be "pre" or "post", got "${String(spec.timing)}"`);
    }
    if (spec.decision !== 'allow' && spec.decision !== 'deny' && spec.decision !== 'modify') {
      throw new Error(`Hook decision must be allow | deny | modify, got "${String(spec.decision)}"`);
    }
    const matcherProblems = validateHookMatcher(spec.matcher);
    if (matcherProblems.length > 0) {
      throw new Error(`Invalid hook matcher: ${matcherProblems.join('; ')}`);
    }
    if (spec.decision === 'modify' && spec.modifyArgs === undefined) {
      throw new Error('A modify hook must provide modifyArgs');
    }
    const hook: SandboxV3Hook = {
      id: randomUUID(),
      name: spec.name.trim(),
      timing: spec.timing,
      ...(spec.matcher !== undefined ? { matcher: { ...spec.matcher } } : {}),
      decision: spec.decision,
      ...(spec.modifyArgs !== undefined ? { modifyArgs: { ...spec.modifyArgs } } : {}),
      ...(spec.message !== undefined ? { message: spec.message } : {}),
      enabled: spec.enabled ?? true,
      priority: spec.priority ?? 100,
    };
    this.hooks.push(hook);
    this.sortHooks();
    return { ...hook };
  }

  /** Remove a hook by id. Returns true when one existed. */
  unregister(hookId: string): boolean {
    const index = this.hooks.findIndex((hook) => hook.id === hookId);
    if (index === -1) return false;
    this.hooks.splice(index, 1);
    return true;
  }

  /** Enable or disable a hook by id. Returns the hook, or undefined. */
  setEnabled(hookId: string, enabled: boolean): SandboxV3Hook | undefined {
    const hook = this.hooks.find((item) => item.id === hookId);
    if (!hook) return undefined;
    hook.enabled = enabled;
    return { ...hook };
  }

  /** All hooks, in evaluation order. */
  list(): SandboxV3Hook[] {
    return this.hooks.map((hook) => ({ ...hook, matcher: hook.matcher ? { ...hook.matcher } : undefined }));
  }

  /** Hooks for one timing, in evaluation order. */
  listFor(timing: SandboxV3HookTiming): SandboxV3Hook[] {
    return this.list().filter((hook) => hook.timing === timing);
  }

  /** Number of registered hooks (enabled + disabled). */
  size(): number {
    return this.hooks.length;
  }

  /** Number of enabled hooks. */
  enabledCount(): number {
    return this.hooks.filter((hook) => hook.enabled).length;
  }

  /**
   * Evaluate the pre-hooks for one tool call. Deny wins: the first
   * denying hook stops the evaluation (later hooks still count as
   * matched when they also match — they are listed, but their
   * modify does not apply). Modify hooks merge their `modifyArgs`
   * into the call arguments, in priority order; later hooks win
   * on conflicting keys.
   */
  evaluatePre(call: SandboxV3ToolCall): SandboxV3HookEvaluation {
    const matched = this.matching('pre', call);
    let args: Record<string, unknown> = { ...call.args };
    let modified = false;
    let denyingHook: SandboxV3Hook | undefined;
    const reasons: string[] = [];
    for (const hook of matched) {
      if (hook.decision === 'deny') {
        denyingHook = hook;
        reasons.push(`denied by "${hook.name}"${hook.message ? `: ${hook.message}` : ''}`);
        break;
      }
      if (hook.decision === 'modify' && hook.modifyArgs) {
        args = { ...args, ...hook.modifyArgs };
        modified = true;
        reasons.push(`rewritten by "${hook.name}"`);
      }
    }
    const decision: SandboxV3HookDecision = denyingHook ? 'deny' : modified ? 'modify' : 'allow';
    const reason =
      denyingHook !== undefined
        ? reasons[reasons.length - 1]
        : reasons.length > 0
          ? reasons.join('; ')
          : 'No pre-hook objected';
    const evaluation: SandboxV3HookEvaluation = {
      decision,
      args,
      matchedHookIds: matched.map((hook) => hook.id),
      reason,
      denied: denyingHook !== undefined,
      modified: denyingHook !== undefined ? false : modified,
    };
    this.audit.push({
      atMs: Date.now(),
      timing: 'pre',
      tool: call.tool,
      decision,
      matchedHookIds: evaluation.matchedHookIds,
      reason,
    });
    return evaluation;
  }

  /**
   * Evaluate the post-hooks for one tool result. Same rules as
   * pre: deny wins and withholds the result (replaced by the
   * hook's message, or a generic withholding note); modify
   * replaces the result text with `modifyArgs.result` when the
   * hook provides one.
   */
  evaluatePost(call: SandboxV3ToolCall, result: string): SandboxV3PostHookEvaluation {
    const matched = this.matching('post', call);
    let text = result;
    let modified = false;
    let denyingHook: SandboxV3Hook | undefined;
    const reasons: string[] = [];
    for (const hook of matched) {
      if (hook.decision === 'deny') {
        denyingHook = hook;
        reasons.push(`result withheld by "${hook.name}"${hook.message ? `: ${hook.message}` : ''}`);
        break;
      }
      if (hook.decision === 'modify' && hook.modifyArgs) {
        const replacement = hook.modifyArgs.result;
        if (typeof replacement === 'string') {
          text = replacement;
          modified = true;
          reasons.push(`result rewritten by "${hook.name}"`);
        }
      }
    }
    const decision: SandboxV3HookDecision = denyingHook ? 'deny' : modified ? 'modify' : 'allow';
    if (denyingHook) {
      text = denyingHook.message ?? `Result withheld by hook "${denyingHook.name}".`;
    }
    const reason =
      reasons.length > 0 ? reasons[reasons.length - 1] : 'No post-hook objected';
    const evaluation: SandboxV3PostHookEvaluation = {
      decision,
      result: text,
      matchedHookIds: matched.map((hook) => hook.id),
      reason,
      denied: denyingHook !== undefined,
      modified: denyingHook !== undefined ? false : modified,
    };
    this.audit.push({
      atMs: Date.now(),
      timing: 'post',
      tool: call.tool,
      decision,
      matchedHookIds: evaluation.matchedHookIds,
      reason,
    });
    return evaluation;
  }

  /** Audit entries, in order. */
  auditLog(): SandboxV3HookAuditEntry[] {
    return [...this.audit];
  }

  /** How many evaluations denied something. */
  deniedCount(): number {
    return this.audit.filter((entry) => entry.decision === 'deny').length;
  }

  /** How many evaluations modified something. */
  modifiedCount(): number {
    return this.audit.filter((entry) => entry.decision === 'modify').length;
  }

  /** Remove all hooks and clear the audit log. */
  clear(): void {
    this.hooks.length = 0;
    this.audit.length = 0;
  }

  private matching(timing: SandboxV3HookTiming, call: SandboxV3ToolCall): SandboxV3Hook[] {
    return this.hooks.filter(
      (hook) => hook.enabled && hook.timing === timing && hookMatches(call, hook.matcher),
    );
  }

  private sortHooks(): void {
    // Stable sort by priority; registration order breaks ties
    // (Array.sort is stable in modern JS engines).
    this.hooks.sort((a, b) => a.priority - b.priority);
    this.sequence += 1;
    void this.sequence;
  }
}

/**
 * Built-in hook: deny every tool whose name matches `pattern`
 * before it runs. Example: block `shell_*` inside untrusted
 * sessions.
 */
export function createBlockToolHook(
  name: string,
  toolPattern: string,
  message?: string,
  priority = 10,
): RegisterHookSpec {
  return {
    name,
    timing: 'pre',
    matcher: { toolPattern },
    decision: 'deny',
    ...(message !== undefined ? { message } : {}),
    priority,
  };
}

/**
 * Built-in hook: deny any tool call that passes the argument key
 * `argKey` — for example, deny calls that carry a `command`
 * argument (shell execution) in a session that must stay
 * read-only.
 */
export function createBlockArgHook(
  name: string,
  argKey: string,
  message?: string,
  priority = 20,
): RegisterHookSpec {
  return {
    name,
    timing: 'pre',
    matcher: { argKey },
    decision: 'deny',
    ...(message !== undefined ? { message } : {}),
    priority,
  };
}

/**
 * Built-in hook: force every matching call to run with the given
 * arguments merged in (later keys win). Example: force
 * `{ dryRun: true }` on a mutation tool.
 */
export function createForceArgsHook(
  name: string,
  toolPattern: string,
  modifyArgs: Record<string, unknown>,
  priority = 50,
): RegisterHookSpec {
  return {
    name,
    timing: 'pre',
    matcher: { toolPattern },
    decision: 'modify',
    modifyArgs,
    priority,
  };
}

/**
 * Built-in hook: withhold results from matching tools after they
 * run (secrets, huge outputs). The agent sees `message` instead.
 */
export function createWithholdResultHook(
  name: string,
  toolPattern: string,
  message: string,
  priority = 10,
): RegisterHookSpec {
  return {
    name,
    timing: 'post',
    matcher: { toolPattern },
    decision: 'deny',
    message,
    priority,
  };
}

/**
 * Built-in hook: redact a result by replacing it with a fixed
 * summary after the tool runs.
 */
export function createRedactResultHook(
  name: string,
  toolPattern: string,
  replacement: string,
  priority = 50,
): RegisterHookSpec {
  return {
    name,
    timing: 'post',
    matcher: { toolPattern },
    decision: 'modify',
    modifyArgs: { result: replacement },
    priority,
  };
}
