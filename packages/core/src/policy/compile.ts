/**
 * Policy enforcement — compile + evaluate (v1.04, T3b).
 *
 * A policy is only real if the runtime enforces it. This module is
 * the enforcement point:
 *
 * - `evaluateToolCall(policy, toolName, args)` — pure: decide one
 *   tool call (allow / block / needs-approval) with a reason and the
 *   rule that fired. The order is fixed and documented: deny beats
 *   allow, block beats needs-approval, tool rules run before path
 *   rules, path rules before network rules.
 * - `createPolicyHook(policy)` — the same evaluation as a PreToolUse
 *   hook (priority 10, so it runs before ordinary hooks) that blocks
 *   denied calls before they execute. `needs-approval` is mapped to
 *   `block` with a reason naming the approval — fail-closed until a
 *   real approval flow consumes it (coordinator-owned, later wave).
 * - `compilePolicyToPrompt(policy)` — the policy rendered as a
 *   system-prompt section, so the model knows the rules and can
 *   explain a refusal instead of silently retrying.
 *
 * Honest limits (do not over-claim):
 * - Path rules only see the path-like ARGUMENTS of a tool call
 *   (`path`, `file`, `dir`, `target`, …). A tool that hides its path
 *   in an opaque argument (or a shell command that builds a path at
 *   run time) is not covered by path rules — that is what the tool
 *   deny-list (`shell-*`) is for.
 * - Read vs write is a heuristic: a call counts as a write when the
 *   tool name looks mutating (`*write*`, `*edit*`, `*delete*`, …) or
 *   the arguments carry new content (`content`, `newContent`). A
 *   read-only tool that takes a `content` argument for another reason
 *   would be judged as a write — the policy author can see this in
 *   the reason string, which names the rule that fired.
 * - This is not a sandbox: it cannot confine a process that escapes
 *   the tool layer. It is the deterministic layer on top of the model,
 *   not a replacement for OS isolation.
 */

import * as path from 'node:path';

import { matchesToolName } from '../hooks/matcher';
import type { HookDefinition } from '../hooks/types';
import { blockDecision } from '../hooks/types';
import type { BehavioralPolicy, PolicyEvaluation } from './types';

/** Tool-name globs treated as mutating (write) calls. */
export const WRITE_TOOL_PATTERNS = [
  '*write*',
  '*edit*',
  '*delete*',
  '*remove*',
  '*mkdir*',
  '*move*',
  '*create*',
  '*apply*',
  '*save*',
  '*rename*',
] as const;

/** Argument keys that carry a filesystem path. */
export const PATH_ARG_KEYS = [
  'path',
  'file',
  'filePath',
  'filepath',
  'dir',
  'directory',
  'target',
  'source',
  'dest',
  'destination',
] as const;

/** Argument keys that carry new content (marks the call as a write). */
export const CONTENT_ARG_KEYS = ['content', 'newContent', 'new_text', 'text'] as const;

/** Argument keys that carry a URL / host. */
export const URL_ARG_KEYS = ['url', 'endpoint', 'host', 'uri'] as const;

/**
 * Path glob: `*` matches any run of characters INCLUDING `/`
 * (`*.env` matches `.env` at any depth), `?` matches one character
 * except `/`. A leading double-star-slash also matches at the root
 * (the pattern "star star slash .env star" matches both `.env` and
 * `a/b/.env`). Unlike the hook matcher, this one is path-aware.
 */
export function matchPathGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  let re = '^';
  let i = 0;
  // A leading `**/` also matches the root (no directory at all).
  if (pattern.startsWith('**/')) {
    re += '(?:.*/)?';
    i = 3;
  }
  for (; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
  }
  re += '$';
  return new RegExp(re).test(value);
}

/** Host glob: exact host, or `*.example.com` (any subdomain, not the bare domain). */
export function matchHostGlob(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h !== p.slice(2);
  return p === h;
}

function anyGlob(patterns: readonly string[] | undefined, value: string, match: (p: string, v: string) => boolean): string | undefined {
  if (!patterns) return undefined;
  for (const p of patterns) {
    if (match(p, value)) return p;
  }
  return undefined;
}

function isWriteCall(toolName: string, args: Record<string, unknown>): boolean {
  if (WRITE_TOOL_PATTERNS.some((p) => matchesToolName(p, toolName))) return true;
  return CONTENT_ARG_KEYS.some(
    (k) => typeof args[k] === 'string' && (args[k] as string).length > 0,
  );
}

/** Collect the path-like string arguments of a tool call. */
export function extractPathArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') out.push(v);
  }
  return out;
}

/** Collect the hosts of the URL-like arguments of a tool call. */
export function extractUrlHosts(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of URL_ARG_KEYS) {
    const v = args[key];
    if (typeof v !== 'string' || v.trim() === '') continue;
    if (key === 'host') {
      out.push(v.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]);
      continue;
    }
    try {
      const host = new URL(v).hostname;
      if (host) out.push(host);
    } catch {
      // Not a parseable URL — not a network call this module can judge.
    }
  }
  return out;
}

function isInsideDir(dir: string, file: string): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(dir, file);
  return resolvedFile === resolvedDir || resolvedFile.startsWith(resolvedDir + path.sep);
}

export interface EvaluateToolCallOptions {
  /** Workspace dir: paths are resolved against it for the inside-workspace check. */
  workspaceDir?: string;
}

/**
 * Decide one tool call against a policy. Pure — no I/O, no side
 * effects — so it is trivially unit-testable and reusable by the
 * hook, the CLI validator and the Settings preview alike.
 */
export function evaluateToolCall(
  policy: BehavioralPolicy,
  toolName: string,
  args: Record<string, unknown>,
  opts: EvaluateToolCallOptions = {},
): PolicyEvaluation {
  const tools = policy.rules.tools;
  const defaults = policy.defaults ?? {};

  // 1. Tool rules (deny > requireApproval > allow-list default).
  if (tools) {
    const denied = anyGlob(tools.deny, toolName, matchesToolName);
    if (denied !== undefined) {
      return {
        decision: 'block',
        reason: `Tool "${toolName}" bị policy "${policy.name}" chặn (tools.deny: "${denied}").`,
        rule: 'tools.deny',
      };
    }
    const needsApproval = anyGlob(tools.requireApproval, toolName, matchesToolName);
    if (needsApproval !== undefined) {
      return {
        decision: 'needs-approval',
        reason: `Tool "${toolName}" cần người dùng duyệt trước (tools.requireApproval: "${needsApproval}").`,
        rule: 'tools.requireApproval',
      };
    }
    if (
      tools.allow !== undefined &&
      tools.allow.length > 0 &&
      (defaults.toolDecision ?? 'allow') === 'deny' &&
      anyGlob(tools.allow, toolName, matchesToolName) === undefined
    ) {
      return {
        decision: 'block',
        reason: `Tool "${toolName}" không có trong tools.allow của policy "${policy.name}" (deny-by-default).`,
        rule: 'tools.allow',
      };
    }
  }

  // 2. Path rules (only when the call carries a path argument).
  const pathRules = policy.rules.paths;
  const paths = extractPathArgs(args);
  if (pathRules && paths.length > 0) {
    const isWrite = isWriteCall(toolName, args);
    const denyList = isWrite ? pathRules.writeDeny : pathRules.readDeny;
    const allowList = isWrite ? pathRules.writeAllow : pathRules.readAllow;
    const kind = isWrite ? 'write' : 'read';
    for (const p of paths) {
      const denied = anyGlob(denyList, p, matchPathGlob);
      if (denied !== undefined) {
        return {
          decision: 'block',
          reason: `Policy "${policy.name}" chặn ${kind} đường dẫn "${p}" (paths.${isWrite ? 'writeDeny' : 'readDeny'}: "${denied}").`,
          rule: `paths.${isWrite ? 'writeDeny' : 'readDeny'}`,
        };
      }
      if (
        allowList !== undefined &&
        allowList.length > 0 &&
        (defaults.pathDecision ?? 'allow') === 'deny' &&
        anyGlob(allowList, p, matchPathGlob) === undefined
      ) {
        return {
          decision: 'block',
          reason: `Đường dẫn "${p}" không có trong paths.${isWrite ? 'writeAllow' : 'readAllow'} của policy "${policy.name}" (deny-by-default).`,
          rule: `paths.${isWrite ? 'writeAllow' : 'readAllow'}`,
        };
      }
      // Writes outside the workspace are blocked by default.
      if (isWrite && (pathRules.requireInsideWorkspace ?? true) && opts.workspaceDir) {
        if (!isInsideDir(opts.workspaceDir, p)) {
          return {
            decision: 'block',
            reason: `Policy "${policy.name}" chặn ghi ngoài workspace: "${p}".`,
            rule: 'paths.requireInsideWorkspace',
          };
        }
      }
    }
  }

  // 3. Network rules (only when the call carries a URL argument).
  const netRules = policy.rules.network;
  const hosts = extractUrlHosts(args);
  if (netRules && hosts.length > 0) {
    for (const host of hosts) {
      const denied = anyGlob(netRules.denyHosts, host, matchHostGlob);
      if (denied !== undefined) {
        return {
          decision: 'block',
          reason: `Policy "${policy.name}" chặn truy cập host "${host}" (network.denyHosts: "${denied}").`,
          rule: 'network.denyHosts',
        };
      }
      if (
        netRules.allowHosts !== undefined &&
        netRules.allowHosts.length > 0 &&
        (defaults.networkDecision ?? 'allow') === 'deny' &&
        anyGlob(netRules.allowHosts, host, matchHostGlob) === undefined
      ) {
        return {
          decision: 'block',
          reason: `Host "${host}" không có trong network.allowHosts của policy "${policy.name}" (deny-by-default).`,
          rule: 'network.allowHosts',
        };
      }
    }
  }

  return { decision: 'allow', reason: `Cho phép theo policy "${policy.name}".` };
}

/**
 * Render a policy as a system-prompt section, so the model knows the
 * rules and can explain a refusal instead of silently retrying the
 * same blocked call. Deterministic output (fixed order) for tests.
 */
export function compilePolicyToPrompt(policy: BehavioralPolicy): string {
  const lines: string[] = [
    `## Behavioral policy: ${policy.name} (version ${policy.version})`,
  ];
  if (policy.description) lines.push(policy.description);
  lines.push('These rules are enforced by the runtime, not just requested: a denied tool call is blocked before it runs.');
  const tools = policy.rules.tools;
  if (tools) {
    if (tools.deny?.length) lines.push(`- Never call these tools: ${tools.deny.join(', ')}.`);
    if (tools.allow?.length) lines.push(`- Allowed tools: ${tools.allow.join(', ')}.`);
    if (tools.requireApproval?.length) {
      lines.push(`- These tools need human approval first: ${tools.requireApproval.join(', ')}.`);
    }
  }
  const paths = policy.rules.paths;
  if (paths) {
    if (paths.readDeny?.length) lines.push(`- Never read: ${paths.readDeny.join(', ')}.`);
    if (paths.writeDeny?.length) lines.push(`- Never write: ${paths.writeDeny.join(', ')}.`);
    if (paths.readAllow?.length) lines.push(`- Readable paths: ${paths.readAllow.join(', ')}.`);
    if (paths.writeAllow?.length) lines.push(`- Writable paths: ${paths.writeAllow.join(', ')}.`);
    if (paths.requireInsideWorkspace ?? true) lines.push('- Only write inside the workspace directory.');
  }
  const net = policy.rules.network;
  if (net) {
    if (net.denyHosts?.length) lines.push(`- Never fetch: ${net.denyHosts.join(', ')}.`);
    if (net.allowHosts?.length) lines.push(`- Fetchable hosts: ${net.allowHosts.join(', ')}.`);
  }
  const model = policy.rules.model;
  if (model) {
    if (model.maxSteps !== undefined) lines.push(`- Maximum ${model.maxSteps} steps per run.`);
    if (model.allowedModels?.length) lines.push(`- Allowed models: ${model.allowedModels.join(', ')}.`);
  }
  const defaults = policy.defaults;
  if (defaults) {
    const parts: string[] = [];
    if (defaults.toolDecision === 'deny') parts.push('tools default-deny');
    if (defaults.pathDecision === 'deny') parts.push('paths default-deny');
    if (defaults.networkDecision === 'deny') parts.push('network default-deny');
    if (parts.length > 0) lines.push(`- Defaults: ${parts.join(', ')} (anything not listed is blocked).`);
  }
  return lines.join('\n');
}

export interface CreatePolicyHookOptions {
  /** Hook name. Default `policy-enforcer`. */
  name?: string;
  /** Workspace dir for the inside-workspace check. */
  workspaceDir?: string;
}

/**
 * The policy as a PreToolUse hook. Priority 10 (runs before ordinary
 * hooks), source `'builtin'`. `needs-approval` maps to `block` with a
 * reason that names the approval — fail-closed until an approval flow
 * exists to consume it. The hook never throws: evaluation is pure.
 */
export function createPolicyHook(
  policy: BehavioralPolicy,
  opts: CreatePolicyHookOptions = {},
): HookDefinition {
  const workspaceDir = opts.workspaceDir;
  return {
    name: opts.name ?? 'policy-enforcer',
    description: `Enforces behavioral policy "${policy.name}" (v${policy.version}).`,
    events: ['PreToolUse'],
    handler: (event) => {
      if (event.event !== 'PreToolUse') return undefined;
      const result = evaluateToolCall(policy, event.toolName, event.args, { workspaceDir });
      if (result.decision === 'allow') return undefined;
      const reason =
        result.decision === 'needs-approval'
          ? `${result.reason} (chưa có luồng duyệt — tạm chặn, cần người dùng duyệt thủ công).`
          : result.reason;
      return blockDecision(reason);
    },
    source: 'builtin',
    enabled: true,
    priority: 10,
  };
}
