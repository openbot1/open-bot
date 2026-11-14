/**
 * Policy parsing + validation (v1.04, T3b).
 *
 * Two entry points, both pure and never throwing for bad input:
 * - `parsePolicyDocument(text, format)` — JSON or the YAML subset
 *   (`yaml.ts`); returns the policy or a list of issues.
 * - `validatePolicy(value)` — structural validation of an already
 *   parsed value (used by the loader, the Settings UI and tests).
 *
 * Validation is strict about unknown keys: a policy file must mean
 * exactly what it says. A typo like `toolz:` must be reported, not
 * silently ignored — silently ignoring a rule the user thought they
 * set is how a "blocked" tool stays runnable.
 */

import { POLICY_FILE_VERSION } from './types';
import type { BehavioralPolicy, PolicyIssue, PolicyParseResult } from './types';
import { emitYamlSubset, parseYamlSubset, PolicyYamlError } from './yaml';

/** Document format of a policy file. */
export type PolicyDocumentFormat = 'json' | 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(field: string, message: string): PolicyIssue {
  return { field, message };
}

function checkGlobList(
  value: unknown,
  field: string,
  issues: PolicyIssue[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(issue(field, 'phải là một mảng các glob (vd ["shell-*"]).'));
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push(issue(`${field}[${i}]`, 'mỗi glob phải là một chuỗi không rỗng.'));
    } else {
      out.push(item);
    }
  });
  return out;
}

function checkStringList(
  value: unknown,
  field: string,
  issues: PolicyIssue[],
): string[] | undefined {
  return checkGlobList(value, field, issues);
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  base: string,
  issues: PolicyIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push(issue(base === '' ? key : `${base}.${key}`, `khóa không xác định (cho phép: ${allowed.join(', ')}).`));
    }
  }
}

const TOP_KEYS = ['version', 'name', 'description', 'rules', 'defaults'] as const;
const RULE_KEYS = ['tools', 'paths', 'network', 'model'] as const;
const TOOL_KEYS = ['allow', 'deny', 'requireApproval'] as const;
const PATH_KEYS = ['readAllow', 'readDeny', 'writeAllow', 'writeDeny', 'requireInsideWorkspace'] as const;
const NETWORK_KEYS = ['allowHosts', 'denyHosts'] as const;
const MODEL_KEYS = ['maxSteps', 'allowedModels'] as const;
const DEFAULT_KEYS = ['toolDecision', 'pathDecision', 'networkDecision'] as const;

/**
 * Validate an already-parsed value as a policy. Returns the policy
 * when there are no issues, otherwise `policy: null` + the issues.
 * Never throws.
 */
export function validatePolicy(value: unknown): PolicyParseResult {
  const issues: PolicyIssue[] = [];
  if (!isRecord(value)) {
    return { policy: null, issues: [issue('', 'policy phải là một object.')] };
  }
  unknownKeys(value, TOP_KEYS, '', issues);

  const version = value['version'];
  if (version !== POLICY_FILE_VERSION) {
    issues.push(
      issue(
        'version',
        `version phải là ${POLICY_FILE_VERSION} (nhận được ${JSON.stringify(version)}).`,
      ),
    );
  }
  const name = value['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    issues.push(issue('name', 'name phải là một chuỗi không rỗng.'));
  }
  if (value['description'] !== undefined && typeof value['description'] !== 'string') {
    issues.push(issue('description', 'description phải là một chuỗi.'));
  }

  const rulesRaw = value['rules'];
  if (!isRecord(rulesRaw)) {
    issues.push(issue('rules', 'rules phải là một object với ít nhất một nhóm (tools/paths/network/model).'));
    return { policy: null, issues };
  }
  unknownKeys(rulesRaw, RULE_KEYS, 'rules', issues);
  const ruleGroupNames = RULE_KEYS.filter((k) => rulesRaw[k] !== undefined);
  if (ruleGroupNames.length === 0) {
    issues.push(issue('rules', 'rules cần ít nhất một nhóm (tools/paths/network/model).'));
  }

  // -- tools --
  const tools = rulesRaw['tools'];
  if (tools !== undefined) {
    if (!isRecord(tools)) {
      issues.push(issue('rules.tools', 'rules.tools phải là một object.'));
    } else {
      unknownKeys(tools, TOOL_KEYS, 'rules.tools', issues);
      checkGlobList(tools['allow'], 'rules.tools.allow', issues);
      checkGlobList(tools['deny'], 'rules.tools.deny', issues);
      checkGlobList(tools['requireApproval'], 'rules.tools.requireApproval', issues);
    }
  }

  // -- paths --
  const paths = rulesRaw['paths'];
  if (paths !== undefined) {
    if (!isRecord(paths)) {
      issues.push(issue('rules.paths', 'rules.paths phải là một object.'));
    } else {
      unknownKeys(paths, PATH_KEYS, 'rules.paths', issues);
      checkGlobList(paths['readAllow'], 'rules.paths.readAllow', issues);
      checkGlobList(paths['readDeny'], 'rules.paths.readDeny', issues);
      checkGlobList(paths['writeAllow'], 'rules.paths.writeAllow', issues);
      checkGlobList(paths['writeDeny'], 'rules.paths.writeDeny', issues);
      if (
        paths['requireInsideWorkspace'] !== undefined &&
        typeof paths['requireInsideWorkspace'] !== 'boolean'
      ) {
        issues.push(issue('rules.paths.requireInsideWorkspace', 'phải là true/false.'));
      }
    }
  }

  // -- network --
  const network = rulesRaw['network'];
  if (network !== undefined) {
    if (!isRecord(network)) {
      issues.push(issue('rules.network', 'rules.network phải là một object.'));
    } else {
      unknownKeys(network, NETWORK_KEYS, 'rules.network', issues);
      checkGlobList(network['allowHosts'], 'rules.network.allowHosts', issues);
      checkGlobList(network['denyHosts'], 'rules.network.denyHosts', issues);
    }
  }

  // -- model --
  const model = rulesRaw['model'];
  if (model !== undefined) {
    if (!isRecord(model)) {
      issues.push(issue('rules.model', 'rules.model phải là một object.'));
    } else {
      unknownKeys(model, MODEL_KEYS, 'rules.model', issues);
      if (model['maxSteps'] !== undefined) {
        const ms = model['maxSteps'];
        if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1) {
          issues.push(issue('rules.model.maxSteps', 'maxSteps phải là số nguyên >= 1.'));
        }
      }
      checkStringList(model['allowedModels'], 'rules.model.allowedModels', issues);
    }
  }

  // -- defaults --
  const defaults = value['defaults'];
  if (defaults !== undefined) {
    if (!isRecord(defaults)) {
      issues.push(issue('defaults', 'defaults phải là một object.'));
    } else {
      unknownKeys(defaults, DEFAULT_KEYS, 'defaults', issues);
      for (const key of DEFAULT_KEYS) {
        const v = defaults[key];
        if (v !== undefined && v !== 'allow' && v !== 'deny') {
          issues.push(issue(`defaults.${key}`, 'phải là "allow" hoặc "deny".'));
        }
      }
    }
  }

  if (issues.length > 0) return { policy: null, issues };
  return { policy: value as unknown as BehavioralPolicy, issues: [] };
}

/**
 * Parse one policy document (JSON or the YAML subset) and validate it.
 * Returns the policy or the issues. Never throws.
 */
export function parsePolicyDocument(
  text: string,
  format: PolicyDocumentFormat,
): PolicyParseResult {
  let parsed: unknown;
  try {
    parsed = format === 'json' ? JSON.parse(text) : parseYamlSubset(text);
  } catch (err) {
    const message =
      err instanceof PolicyYamlError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      policy: null,
      issues: [issue('', format === 'json' ? `JSON không hợp lệ: ${message}` : message)],
    };
  }
  return validatePolicy(parsed);
}

/** Serialise a policy to a document (JSON pretty-printed, or the YAML subset). */
export function stringifyPolicy(policy: BehavioralPolicy, format: PolicyDocumentFormat): string {
  if (format === 'json') return `${JSON.stringify(policy, null, 2)}\n`;
  return emitYamlSubset(policy as unknown as Record<string, unknown>);
}

/** A minimal starter policy: deny the destructive tools, nothing else. */
export function defaultPolicy(name = 'default'): BehavioralPolicy {
  return {
    version: POLICY_FILE_VERSION,
    name,
    description: 'Policy mặc định của open-bot: chặn các tool phá hoại, còn lại cho phép.',
    rules: {
      tools: {
        deny: ['delete_file', 'shell-*'],
      },
      paths: {
        writeDeny: ['**/.env*', '**/*.pem', '**/*.key'],
      },
    },
  };
}
