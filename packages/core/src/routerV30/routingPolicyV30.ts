/**
 * Routing policy v30 (v1.44, Doi T5) — cau hinh uu tien cua user cho router.
 *
 * User chon: uu tien do tre hay chi phi hay chat luong (trong so 0..1),
 * profile co san (fastest / cheapest / balanced / quality), provider /
 * model nao duoc phep, tran gia / do tre, co uu tien model local khong,
 * co cho phep model deprecated khong, fallback co bat khong.
 *
 * Policy la du lieu thuan — UI luu / nap, router chi doc. Validate tra
 * loi cu the de UI hien thi, khong throw.
 */
import type { CatalogAutoRefreshPolicyV30 } from './modelCatalogV30';
import { defaultCatalogAutoRefreshPolicyV30 } from './modelCatalogV30';

/** Profile cham diem co san (user chon nhanh thay vi tu set trong so). */
export type RoutingProfileV30 = 'fastest' | 'cheapest' | 'balanced' | 'quality';

/** Trong so cham diem — tong khong nhat thiet = 1 (se chuan hoa khi dung). */
export interface RoutingWeightsV30 {
  /** Trong so do tre (0..1). */
  latency: number;
  /** Trong so chi phi (0..1). */
  cost: number;
  /** Trong so chat luong (0..1). */
  quality: number;
}

/** Trong so mac dinh cua tung profile. */
export const ROUTING_PROFILE_WEIGHTS_V30: Record<
  RoutingProfileV30,
  RoutingWeightsV30
> = {
  fastest: { latency: 0.7, cost: 0.1, quality: 0.2 },
  cheapest: { latency: 0.1, cost: 0.7, quality: 0.2 },
  balanced: { latency: 0.35, cost: 0.35, quality: 0.3 },
  quality: { latency: 0.2, cost: 0.1, quality: 0.7 },
};

/** Chinh sach routing cua user. */
export interface RoutingPolicyV30 {
  /** Profile dang chon (trong so suy ra tu profile tru khi user tu set). */
  profile: RoutingProfileV30;
  /** Trong so tu set — neu co thi uu tien hon profile. */
  customWeights?: RoutingWeightsV30;
  /** Provider duoc phep (rong = tat ca). */
  allowedProviders: string[];
  /** Model duoc phep (dang provider::modelId; rong = tat ca). */
  allowedModels: string[];
  /** Model cam (dang provider::modelId) — luon loai du co trong allowed. */
  blockedModels: string[];
  /** Tran chi phi uoc tinh cho 1 lan goi (USD). 0 = khong tran. */
  maxCostPerRequestUsd: number;
  /** Tran do tre chap nhan (ms). 0 = khong tran. */
  maxLatencyMs: number;
  /** Uu tien model local / mien phi khi diem gan bang nhau. */
  preferLocal: boolean;
  /** Cho phep chon model deprecated (mac dinh false). */
  allowDeprecated: boolean;
  /** Bat fallback chain khi provider chinh loi (mac dinh true). */
  fallbackEnabled: boolean;
  /** So lan fallback toi da trong 1 lan goi (mac dinh 3). */
  maxFallbackAttempts: number;
  /** Chinh sach auto-refresh catalog (mac dinh tat). */
  autoRefreshCatalog: CatalogAutoRefreshPolicyV30;
}

/** Policy mac dinh: balanced, khong tran chat, fallback bat, auto-refresh tat. */
export function defaultRoutingPolicyV30(): RoutingPolicyV30 {
  return {
    profile: 'balanced',
    allowedProviders: [],
    allowedModels: [],
    blockedModels: [],
    maxCostPerRequestUsd: 0,
    maxLatencyMs: 0,
    preferLocal: false,
    allowDeprecated: false,
    fallbackEnabled: true,
    maxFallbackAttempts: 3,
    autoRefreshCatalog: defaultCatalogAutoRefreshPolicyV30(),
  };
}

/** Trong so hieu dung: custom neu co, khong thi theo profile. */
export function effectiveWeightsV30(
  policy: RoutingPolicyV30,
): RoutingWeightsV30 {
  if (policy.customWeights) return { ...policy.customWeights };
  return { ...ROUTING_PROFILE_WEIGHTS_V30[policy.profile] };
}

/** Validate policy — tra danh sach loi (rong = hop le). */
export function validateRoutingPolicyV30(
  policy: unknown,
): string[] {
  const errors: string[] = [];
  if (!policy || typeof policy !== 'object') {
    return ['policy must be an object'];
  }
  const p = policy as Partial<RoutingPolicyV30>;
  const profiles: RoutingProfileV30[] = [
    'fastest',
    'cheapest',
    'balanced',
    'quality',
  ];
  if (!profiles.includes(p.profile as RoutingProfileV30)) {
    errors.push('profile must be fastest | cheapest | balanced | quality');
  }
  const checkWeights = (w: RoutingWeightsV30 | undefined, label: string) => {
    if (w === undefined) return;
    for (const k of ['latency', 'cost', 'quality'] as const) {
      const v = w[k];
      if (typeof v !== 'number' || v < 0 || v > 1) {
        errors.push(`${label}.${k} must be between 0 and 1`);
      }
    }
    if (w.latency + w.cost + w.quality <= 0) {
      errors.push(`${label} total weight must be > 0`);
    }
  };
  checkWeights(p.customWeights, 'customWeights');
  if (!Array.isArray(p.allowedProviders)) {
    errors.push('allowedProviders must be an array');
  }
  if (!Array.isArray(p.allowedModels)) {
    errors.push('allowedModels must be an array');
  }
  if (!Array.isArray(p.blockedModels)) {
    errors.push('blockedModels must be an array');
  }
  if (
    typeof p.maxCostPerRequestUsd !== 'number' ||
    p.maxCostPerRequestUsd < 0
  ) {
    errors.push('maxCostPerRequestUsd must be >= 0');
  }
  if (typeof p.maxLatencyMs !== 'number' || p.maxLatencyMs < 0) {
    errors.push('maxLatencyMs must be >= 0');
  }
  if (
    typeof p.maxFallbackAttempts !== 'number' ||
    !Number.isInteger(p.maxFallbackAttempts) ||
    p.maxFallbackAttempts < 0 ||
    p.maxFallbackAttempts > 10
  ) {
    errors.push('maxFallbackAttempts must be an integer between 0 and 10');
  }
  if (p.autoRefreshCatalog) {
    const ar = p.autoRefreshCatalog;
    if (
      typeof ar.minIntervalMs !== 'number' ||
      ar.minIntervalMs < 60_000
    ) {
      errors.push('autoRefreshCatalog.minIntervalMs must be >= 60000');
    }
    if (typeof ar.staleAfterMs !== 'number' || ar.staleAfterMs < 60_000) {
      errors.push('autoRefreshCatalog.staleAfterMs must be >= 60000');
    }
  }
  return errors;
}

/**
 * Gop policy moi len policy cu (partial merge — chi truong co trong
 * patch moi bi ghi de). Tra policy moi, khong doi policy cu.
 * Neu patch khong hop le thi tra policy cu + danh sach loi.
 */
export function mergeRoutingPolicyV30(
  current: RoutingPolicyV30,
  patch: Partial<RoutingPolicyV30>,
): { policy: RoutingPolicyV30; errors: string[] } {
  const merged: RoutingPolicyV30 = {
    ...current,
    ...patch,
    allowedProviders: patch.allowedProviders ?? current.allowedProviders,
    allowedModels: patch.allowedModels ?? current.allowedModels,
    blockedModels: patch.blockedModels ?? current.blockedModels,
    autoRefreshCatalog: patch.autoRefreshCatalog
      ? { ...current.autoRefreshCatalog, ...patch.autoRefreshCatalog }
      : current.autoRefreshCatalog,
    customWeights: patch.customWeights
      ? { ...patch.customWeights }
      : current.customWeights,
  };
  const errors = validateRoutingPolicyV30(merged);
  if (errors.length > 0) return { policy: current, errors };
  return { policy: merged, errors: [] };
}

/** Mo ta ngan policy de hien thi trong UI / log. */
export function describeRoutingPolicyV30(policy: RoutingPolicyV30): string {
  const w = effectiveWeightsV30(policy);
  const parts = [
    `profile=${policy.profile}`,
    `weights lat=${w.latency} cost=${w.cost} q=${w.quality}`,
  ];
  if (policy.allowedProviders.length > 0) {
    parts.push(`providers=${policy.allowedProviders.join(',')}`);
  }
  if (policy.maxCostPerRequestUsd > 0) {
    parts.push(`maxCost=$${policy.maxCostPerRequestUsd}`);
  }
  if (policy.maxLatencyMs > 0) {
    parts.push(`maxLatency=${policy.maxLatencyMs}ms`);
  }
  if (policy.preferLocal) parts.push('preferLocal');
  if (!policy.fallbackEnabled) parts.push('fallback=off');
  parts.push(`autoRefresh=${policy.autoRefreshCatalog.enabled ? 'on' : 'off'}`);
  return parts.join(' · ');
}
