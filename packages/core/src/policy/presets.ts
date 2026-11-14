/**
 * Built-in policy presets (v1.04, T3b).
 *
 * Three starting points a user can copy into `.open-bot/policy.yaml`
 * and edit, instead of writing a policy from scratch. Every preset
 * is a plain `BehavioralPolicy` (validated by `validatePolicy` in the
 * tests) — presets are data, not a separate enforcement path: the
 * same `evaluateToolCall` / `createPolicyHook` enforces them.
 *
 * - `strict` — the default working policy: read + search tools only,
 *   no shell, no deletes; diffs need approval; secrets never written.
 * - `read-only` — research / review mode: nothing may write at all.
 * - `permissive` — the loosest useful policy: only the destructive
 *   tools are denied, everything else is allowed.
 */

import { POLICY_FILE_VERSION } from './types';
import type { BehavioralPolicy } from './types';

/** Ids of the built-in presets. */
export type PolicyPresetId = 'strict' | 'read-only' | 'permissive';

export interface PolicyPresetInfo {
  id: PolicyPresetId;
  name: string;
  description: string;
}

export const POLICY_PRESETS: Record<PolicyPresetId, BehavioralPolicy> = {
  strict: {
    version: POLICY_FILE_VERSION,
    name: 'strict',
    description: 'Chỉ đọc + tìm kiếm; không shell, không xóa; sửa file cần duyệt; không ghi secret.',
    rules: {
      tools: {
        allow: ['read', 'glob_*', 'grep_*'],
        deny: ['delete_file', 'shell-*'],
        requireApproval: ['apply_diff'],
      },
      paths: {
        writeDeny: ['**/.env*', '**/*.pem', '**/*.key'],
      },
    },
    defaults: { toolDecision: 'deny' },
  },
  'read-only': {
    version: POLICY_FILE_VERSION,
    name: 'read-only',
    description: 'Chế độ đọc/review: không tool nào được ghi file hay chạy shell.',
    rules: {
      tools: {
        allow: ['read', 'glob_*', 'grep_*'],
        deny: ['*write*', '*edit*', '*delete*', '*create*', '*move*', 'apply_diff', 'shell-*'],
      },
    },
    defaults: { toolDecision: 'deny' },
  },
  permissive: {
    version: POLICY_FILE_VERSION,
    name: 'permissive',
    description: 'Chỉ chặn tool phá hoại, còn lại cho phép.',
    rules: {
      tools: {
        deny: ['delete_file'],
      },
      paths: {
        writeDeny: ['**/.env*', '**/*.pem', '**/*.key'],
      },
    },
  },
};

/** List the built-in presets (id + name + description). */
export function listPolicyPresets(): PolicyPresetInfo[] {
  return (Object.keys(POLICY_PRESETS) as PolicyPresetId[]).map((id) => ({
    id,
    name: POLICY_PRESETS[id].name,
    description: POLICY_PRESETS[id].description ?? '',
  }));
}

/**
 * Get a preset by id (a fresh copy — mutating the return value never
 * changes the preset table). Returns null for an unknown id.
 */
export function getPolicyPreset(id: string): BehavioralPolicy | null {
  const preset = (POLICY_PRESETS as Record<string, BehavioralPolicy | undefined>)[id];
  if (!preset) return null;
  return JSON.parse(JSON.stringify(preset)) as BehavioralPolicy;
}
