/**
 * Policy store — load / save a policy file (v1.04, T3b).
 *
 * On-disk layout (per workspace):
 *   `<workspaceDir>/.open-bot/policy.yaml`  (preferred)
 *   `<workspaceDir>/.open-bot/policy.json`  (fallback)
 *
 * Load order: YAML first when both exist (the YAML file is the one
 * the Settings UI writes). Loading never throws for a missing file
 * (returns `policy: null, exists: false` — a workspace without a
 * policy is normal); a present-but-unparseable file is reported as
 * issues, never thrown, so a broken policy can never crash startup.
 *
 * Every save records the sha256 of the document (canonical JSON, so
 * formatting churn does not change the hash) — the audit log
 * (`audit.ts`) uses it to say exactly what changed.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BehavioralPolicy, PolicyIssue } from './types';
import { POLICY_FILE_NAMES } from './types';
import { parsePolicyDocument, stringifyPolicy } from './validate';
import type { PolicyDocumentFormat } from './validate';
import { appendPolicyAudit } from './audit';

/** Canonical JSON: same policy, same bytes, whatever the key order. */
export function canonicalPolicyJson(policy: BehavioralPolicy): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sort((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sort(policy));
}

/** sha256 of the canonical JSON of a policy. */
export function hashPolicy(policy: BehavioralPolicy): string {
  return createHash('sha256').update(canonicalPolicyJson(policy), 'utf8').digest('hex');
}

export interface LoadedPolicy {
  policy: BehavioralPolicy | null;
  /** True when a policy file exists (even if it failed to parse). */
  exists: boolean;
  /** Which file was read, when one exists. */
  filePath?: string;
  /** 'yaml' | 'json' of the file that was read. */
  format?: PolicyDocumentFormat;
  /** Parse/validation issues (empty when the policy loaded cleanly). */
  issues: PolicyIssue[];
  /** sha256 of the loaded policy (undefined when nothing loaded). */
  sha256?: string;
}

/** Find the policy file for a workspace without reading it. */
export function findPolicyFile(
  workspaceDir: string,
): { path: string; format: PolicyDocumentFormat } | null {
  const dir = (workspaceDir ?? '').trim();
  if (!dir) return null;
  for (const name of POLICY_FILE_NAMES) {
    const abs = path.resolve(dir, name);
    try {
      if (fs.statSync(abs).isFile()) {
        return { path: abs, format: name.endsWith('.yaml') ? 'yaml' : 'json' };
      }
    } catch {
      // Missing / unreadable candidate — try the next one.
    }
  }
  return null;
}

/**
 * Load the policy for a workspace. Never throws for a missing or
 * unreadable file; a present-but-invalid file comes back as
 * `policy: null` + `issues` (the caller decides how to surface it).
 */
export function loadBehaviorPolicy(workspaceDir: string): LoadedPolicy {
  const found = findPolicyFile(workspaceDir);
  if (!found) return { policy: null, exists: false, issues: [] };
  let text: string;
  try {
    text = fs.readFileSync(found.path, 'utf-8');
  } catch (err) {
    return {
      policy: null,
      exists: true,
      filePath: found.path,
      format: found.format,
      issues: [
        {
          field: '',
          message: `Không đọc được policy: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const parsed = parsePolicyDocument(text, found.format);
  if (!parsed.policy) {
    return {
      policy: null,
      exists: true,
      filePath: found.path,
      format: found.format,
      issues: parsed.issues,
    };
  }
  return {
    policy: parsed.policy,
    exists: true,
    filePath: found.path,
    format: found.format,
    issues: [],
    sha256: hashPolicy(parsed.policy),
  };
}

export interface SavePolicyOptions {
  /** 'yaml' (default) or 'json'. */
  format?: PolicyDocumentFormat;
  /** State dir for the audit log (defaults to `<workspaceDir>/.open-bot`). */
  stateDir?: string;
  /** Who saved it (shown in the audit log). Default `'user'`. */
  actor?: string;
  /** Note for the audit log. */
  note?: string;
}

/**
 * Validate + save a policy to `<workspaceDir>/.open-bot/policy.<ext>`.
 * Returns the written path + hash, or the validation issues (nothing
 * is written when the policy is invalid). The previous policy's hash
 * is read first so the audit entry records before → after.
 */
export function saveBehaviorPolicy(
  workspaceDir: string,
  policy: BehavioralPolicy,
  opts: SavePolicyOptions = {},
): { ok: true; filePath: string; sha256: string } | { ok: false; issues: PolicyIssue[] } {
  const checked = parsePolicyDocument(
    stringifyPolicy(policy, opts.format ?? 'yaml'),
    opts.format ?? 'yaml',
  );
  if (!checked.policy) return { ok: false, issues: checked.issues };
  const format = opts.format ?? 'yaml';
  const fileName = format === 'yaml' ? '.open-bot/policy.yaml' : '.open-bot/policy.json';
  const filePath = path.resolve(workspaceDir, fileName);
  const previous = loadBehaviorPolicy(workspaceDir);
  const sha256 = hashPolicy(checked.policy);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyPolicy(checked.policy, format), 'utf-8');
  const stateDir = opts.stateDir ?? path.resolve(workspaceDir, '.open-bot');
  appendPolicyAudit(stateDir, {
    action: previous.exists && previous.policy ? 'updated' : 'created',
    name: checked.policy.name,
    version: checked.policy.version,
    sha256,
    prevSha256: previous.sha256,
    actor: opts.actor ?? 'user',
    note: opts.note,
  });
  return { ok: true, filePath, sha256 };
}
