/**
 * Engine picker (v1.06, Đội T3) — public surface of packages/core/src/engine/.
 *
 * Chọn engine (CLI đã đăng nhập / driver tuỳ chỉnh / provider API)
 * cho từng bot, lưu lựa chọn, hiển thị engine đang dùng. Xem
 * types.ts / picker.ts.
 */
export { EnginePicker, getEnginePicksFilePath, isEnginePickable, listEngines, engineIdFor, API_PROVIDER_CATALOG } from './picker';
export type { ApiProviderCatalogEntry, BotEngineDefault, EngineCatalogDeps, EnginePickerOptions } from './picker';
export { ENGINE_PICKS_FILE } from './types';
export type { CurrentEngine, EngineOption, EnginePick, EnginePicksStateFile, EngineSource } from './types';
