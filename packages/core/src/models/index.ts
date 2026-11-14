/**
 * Model registry (v0.5) — public surface of packages/core/src/models/.
 *
 * Registry là nguồn duy nhất cho tên model — client không hard-code
 * tên model nữa (xem models/types.ts).
 */
export { ModelRegistry } from './registry';
export type { ModelRegistryOptions } from './registry';
export { buildProviderRail, cleanDisabledProviders, filterRailForBot, sourceLabelText, RAIL_GROUP_ORDER } from './rail';
export type {
  BuildProviderRailInput,
  ProviderRail,
  RailEntry,
  RailGroup,
  RailProviderMeta,
  RailReason,
  RailSourceKind,
  RailStatus,
} from './rail';
export { listCompatiblePresets, resolvePreset, COMPATIBLE_PRESETS } from './presets';
// v1.05 (Đội T3): model list tự refresh (cache + TTL + refresh nền).
export {
  DEFAULT_MODEL_AUTO_REFRESH_MS,
  DEFAULT_MODEL_REFRESH_TTL_MS,
  ModelRefreshService,
  cleanModelIds,
  createAnthropicModelFetcher,
  createGeminiModelFetcher,
  createOllamaModelFetcher,
  createOllamaRefreshService,
  createOpenAiCompatibleModelFetcher,
} from './refresh';
export type {
  ModelCacheEntry,
  ModelListFetcher,
  ModelRefreshServiceOptions,
  ModelRefreshSource,
  ModelRefreshStatus,
} from './refresh';
export type { CompatiblePreset } from './presets';
export {
  DEFAULT_FEATURE_FLAGS,
  MODELS_FILE,
} from './types';
export type {
  FeatureModel,
  FeatureModelMap,
  ModelInfo,
  ModelRegistrySnapshot,
  ProviderModels,
  UserModelOverrides,
  UserProviderOverrides,
} from './types';
