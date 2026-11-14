/**
 * Engine picker — chọn engine cho từng bot (v1.06, Đội T3).
 *
 * Học ý tưởng model/engine picker của OpenMausBot (mỗi bot chọn
 * một CLI/model khác nhau, hiển thị rõ bot đang chạy qua engine nào):
 * một "engine" là một cách chạy model — CLI đã đăng nhập trên máy
 * (claude-code, codex…), driver CLI tuỳ chỉnh đã đăng ký, hoặc
 * provider API-key (grok/openai/anthropic/gemini/ollama…). Picker
 * liệt kê các engine KHẢ DỤNG (đã cài + đã đăng nhập + đang bật),
 * user chọn engine + model cho từng bot, lựa chọn lưu bền trong
 * `<dataDir>/engine-picks.json` để UI/desktop đọc lại.
 *
 * Fail-closed: không chọn được engine chưa cài, chưa đăng nhập, đang
 * tắt, hoặc model rỗng. Model là chuỗi tự do (user gõ model mới của
 * provider) — picker chỉ gợi ý model mặc định, không chặn model lạ.
 */

/** Engine tới từ đâu. */
export type EngineSource = 'cli' | 'api' | 'driver';

/** Một engine mà picker có thể hiện cho user chọn. */
export interface EngineOption {
  /** Id ổn định, vd "cli:claude-code", "api:gemini", "driver:my-cli". */
  id: string;
  source: EngineSource;
  /** Nhãn hiển thị, vd "Claude Code", "Gemini (API key)", "My CLI (driver)". */
  label: string;
  /** Provider id mà engine này phục vụ (để tạo provider khi chạy bot). */
  providerId: string;
  /** Model gợi ý (user vẫn gõ model khác được). */
  models: string[];
  /** Binary đã cài (CLI/driver) — API luôn true. */
  installed: boolean;
  /** Đã đăng nhập / có key (API: null = chưa kiểm chứng, CLI: theo detector). */
  signedIn: boolean | null;
  /** Nguồn đang bật (opt-in CLI / driver enabled). */
  enabled: boolean;
  /** Nhãn tài khoản (chỉ nhãn, không secret). */
  accountLabel?: string;
  /** Id driver (khi source = 'driver'). */
  driverId?: string;
  /** Lý do engine không dùng được (khi installed/signedIn/enabled thiếu). */
  unavailableReason?: string;
}

/** Lựa chọn engine của một bot (lưu bền). */
export interface EnginePick {
  botId: string;
  /** Id engine trong EngineOption (vd "cli:claude-code"). */
  engineId: string;
  source: EngineSource;
  providerId: string;
  model: string;
  /** Epoch ms lần chọn/cập nhật cuối. */
  updatedAt: number;
}

export const ENGINE_PICKS_FILE = 'engine-picks.json';

export interface EnginePicksStateFile {
  version: 1;
  picks: EnginePick[];
}

/** Engine mà bot đang dùng (pick đã lưu, hoặc mặc định của bot). */
export interface CurrentEngine {
  botId: string;
  /** `true` khi bot đang dùng pick đã lưu; false = mặc định của bot. */
  fromPick: boolean;
  engineId: string;
  source: EngineSource;
  providerId: string;
  model: string;
  /** Nhãn hiển thị của engine (null khi engine không còn tồn tại). */
  label: string | null;
}
