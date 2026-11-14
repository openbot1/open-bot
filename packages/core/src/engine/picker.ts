/**
 * Engine picker — liệt kê engine + chọn/lưu engine cho bot (v1.06, Đội T3).
 *
 * Catalog engine gộp từ 3 nguồn (theo thứ tự ưu tiên hiển thị):
 *  1. CLI đã detect (`detected/` snapshot — chỉ engine đã cài mới
 *     hiện; chưa đăng nhập thì hiện kèm lý do, không cho chọn).
 *  2. Driver CLI tuỳ chỉnh đã đăng ký (`drivers/` — chỉ driver đang
 *     bật mới hiện).
 *  3. Provider API-key (danh sách tĩnh — luôn hiện vì key do user
 *     nhập trong Settings; `signedIn: null` = chưa kiểm chứng key).
 *
 * `EnginePicker` giữ pick theo bot trong `<dataDir>/engine-picks.json`
 * (ghi atomic). `pick()` validate engine tồn tại + khả dụng + model
 * không rỗng trước khi ghi. `currentEngine()` trả engine bot đang
 * dùng: pick đã lưu nếu còn hợp lệ, ngược lại mặc định của bot
 * (providerId/model trong bots.json) kèm `fromPick: false`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeDurableFileSync } from '../vault/durableFile';
import type { DetectedEnginesSnapshot } from '../detected/types';
import type { CliDriverConfig } from '../drivers/types';
import type { CurrentEngine, EngineOption, EnginePick, EnginePicksStateFile, EngineSource } from './types';
import { ENGINE_PICKS_FILE } from './types';

/** Provider API-key + model gợi ý (model chỉ là gợi ý — user gõ model khác được). */
export interface ApiProviderCatalogEntry {
  id: string;
  label: string;
  models: string[];
}

export const API_PROVIDER_CATALOG: readonly ApiProviderCatalogEntry[] = [
  { id: 'mock', label: 'Mock (thử nghiệm, không cần key)', models: ['mock'] },
  { id: 'grok', label: 'Grok (xAI, API key)', models: ['grok-4', 'grok-4-fast'] },
  { id: 'openai', label: 'OpenAI (API key)', models: ['gpt-5', 'gpt-4o'] },
  { id: 'anthropic', label: 'Anthropic (API key)', models: ['claude-sonnet-4-5', 'claude-opus-4-1'] },
  { id: 'gemini', label: 'Gemini (API key)', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  { id: 'ollama', label: 'Ollama (local, không cần key)', models: ['llama3.1', 'qwen2.5'] },
  { id: 'openai-compatible', label: 'OpenAI-compatible (API key + base URL)', models: ['default'] },
];

export interface EngineCatalogDeps {
  /** Snapshot detected engines (null = không có CLI nào). */
  detected?: DetectedEnginesSnapshot | null;
  /** Driver đã đăng ký (mặc định: []). */
  drivers?: CliDriverConfig[];
  /** Catalog API provider (mặc định: API_PROVIDER_CATALOG). */
  apiProviders?: readonly ApiProviderCatalogEntry[];
}

/** Gộp 3 nguồn thành danh sách engine cho picker (đã sắp xếp: CLI → driver → API). */
export function listEngines(deps: EngineCatalogDeps = {}): EngineOption[] {
  const out: EngineOption[] = [];
  const detected = deps.detected;
  if (detected) {
    for (const engine of Object.values(detected.engines)) {
      const installed = engine.binaryPath !== null;
      const signedIn = engine.status === 'available' ? true : engine.status === 'unavailable' ? false : null;
      let reason: string | undefined;
      if (!installed) reason = 'not-installed';
      else if (signedIn === false) reason = 'not-signed-in';
      else if (!engine.enabled) reason = 'disabled';
      out.push({
        id: `cli:${engine.kind}`,
        source: 'cli',
        label: engine.label,
        providerId: engine.kind === 'claude' ? 'claude-code' : engine.kind,
        models: [],
        installed,
        signedIn,
        enabled: engine.enabled,
        ...(engine.account?.label ? { accountLabel: engine.account.label } : {}),
        ...(reason ? { unavailableReason: reason } : {}),
      });
    }
  }
  for (const driver of deps.drivers ?? []) {
    out.push({
      id: `driver:${driver.id}`,
      source: 'driver',
      label: `${driver.name} (driver)`,
      providerId: driver.providerId,
      models: [],
      installed: true,
      signedIn: null,
      enabled: driver.enabled,
      driverId: driver.id,
      ...(!driver.enabled ? { unavailableReason: 'disabled' } : {}),
    });
  }
  for (const api of deps.apiProviders ?? API_PROVIDER_CATALOG) {
    out.push({
      id: `api:${api.id}`,
      source: 'api',
      label: api.label,
      providerId: api.id,
      models: [...api.models],
      installed: true,
      signedIn: null,
      enabled: true,
    });
  }
  return out;
}

/** Engine có chọn được không (đã cài + đã đăng nhập khi kiểm chứng được + đang bật). */
export function isEnginePickable(option: EngineOption): boolean {
  if (!option.installed) return false;
  if (!option.enabled) return false;
  if (option.signedIn === false) return false;
  return true;
}

export function engineIdFor(providerId: string, source: EngineSource): string {
  return `${source}:${providerId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EnginePickerOptions {
  /** File state (mặc định: <dataDir>/engine-picks.json). */
  stateFilePath?: string;
  /** Thư mục dữ liệu (dùng khi không truyền stateFilePath). */
  dataDir?: string;
  /** Đồng hồ (test). */
  now?: () => number;
  /** Nhận cảnh báo không chặn (vd file state hỏng). */
  onWarn?: (message: string) => void;
}

export function getEnginePicksFilePath(dataDir: string): string {
  return path.join(dataDir, ENGINE_PICKS_FILE);
}

export interface BotEngineDefault {
  botId: string;
  providerId: string;
  model: string;
}

/**
 * Lưu lựa chọn engine theo bot. `catalog` là hàm trả danh sách engine
 * hiện tại (để validate pick) — host truyền `() => listEngines(...)`
 * với snapshot/driver thật; mặc định (không truyền) chỉ validate theo
 * catalog API + id có dạng hợp lệ.
 */
export class EnginePicker {
  private readonly stateFilePath: string;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;
  private picks = new Map<string, EnginePick>();

  constructor(options: EnginePickerOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? getEnginePicksFilePath(options.dataDir ?? path.join(process.env['HOME'] ?? '', '.open-bot'));
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? (() => undefined);
    this.load();
  }

  get filePath(): string {
    return this.stateFilePath;
  }

  private load(): void {
    if (!fs.existsSync(this.stateFilePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
    } catch {
      this.onWarn(`${ENGINE_PICKS_FILE} hỏng (không phải JSON hợp lệ); coi như chưa có lựa chọn engine nào.`);
      return;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed['picks'])) {
      this.onWarn(`${ENGINE_PICKS_FILE} sai định dạng (cần {version: 1, picks: [...]}); coi như chưa có lựa chọn nào.`);
      return;
    }
    for (const entry of parsed['picks'] as unknown[]) {
      if (!isRecord(entry)) continue;
      const botId = entry['botId'];
      const engineId = entry['engineId'];
      const source = entry['source'];
      const providerId = entry['providerId'];
      const model = entry['model'];
      const updatedAt = entry['updatedAt'];
      if (
        typeof botId !== 'string' || botId === '' ||
        typeof engineId !== 'string' || engineId === '' ||
        (source !== 'cli' && source !== 'api' && source !== 'driver') ||
        typeof providerId !== 'string' || providerId === '' ||
        typeof model !== 'string' || model.trim() === '' ||
        typeof updatedAt !== 'number'
      ) {
        this.onWarn(`${ENGINE_PICKS_FILE}: bỏ qua lựa chọn engine không hợp lệ cho bot ${typeof botId === 'string' ? botId : '(không rõ)'}.`);
        continue;
      }
      this.picks.set(botId, { botId, engineId, source: source as EngineSource, providerId, model: model.trim(), updatedAt });
    }
  }

  private save(): void {
    const state: EnginePicksStateFile = {
      version: 1,
      picks: [...this.picks.values()].sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0)),
    };
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    writeDurableFileSync(this.stateFilePath, JSON.stringify(state, null, 2) + '\n');
  }

  /** Tất cả pick đã lưu (theo botId). */
  listPicks(): EnginePick[] {
    return [...this.picks.values()].sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0));
  }

  getPick(botId: string): EnginePick | null {
    return this.picks.get(botId) ?? null;
  }

  /**
   * Chọn engine cho bot. Validate: botId không rỗng, model không rỗng,
   * engine có trong catalog và chọn được (đã cài + đã đăng nhập + đang
   * bật). `catalog` không truyền thì chỉ kiểm tra dạng engineId hợp lệ
   * (dùng cho test/CLI nhẹ — host desktop nên truyền catalog đầy đủ).
   */
  pick(botId: string, engineId: string, model: string, catalog?: EngineOption[]): EnginePick {
    if (typeof botId !== 'string' || botId.trim() === '') throw new Error('Engine picker: botId không được rỗng.');
    if (typeof engineId !== 'string' || engineId.trim() === '') throw new Error('Engine picker: engineId không được rỗng.');
    if (typeof model !== 'string' || model.trim() === '') throw new Error('Engine picker: model không được rỗng.');
    const cleanModel = model.trim();
    let source: EngineSource;
    let providerId: string;
    if (catalog) {
      const option = catalog.find((o) => o.id === engineId.trim());
      if (!option) throw new Error(`Engine picker: không tìm thấy engine "${engineId.trim()}" trong catalog khả dụng.`);
      if (!isEnginePickable(option)) {
        const reason =
          option.unavailableReason === 'not-installed'
            ? 'chưa cài'
            : option.unavailableReason === 'not-signed-in'
              ? 'chưa đăng nhập — đăng nhập bằng chính CLI đó trước'
              : option.unavailableReason === 'disabled'
                ? 'đang tắt — bật trong Settings → Engines trước'
                : 'không khả dụng';
        throw new Error(`Engine picker: engine "${option.label}" ${reason}, không chọn được.`);
      }
      source = option.source;
      providerId = option.providerId;
    } else {
      const m = /^(cli|api|driver):(.+)$/.exec(engineId.trim());
      if (!m) throw new Error('Engine picker: engineId phải có dạng "<cli|api|driver>:<id>" (vd "cli:claude-code", "api:gemini").');
      source = m[1] as EngineSource;
      providerId = m[2] as string;
    }
    const pick: EnginePick = { botId: botId.trim(), engineId: engineId.trim(), source, providerId, model: cleanModel, updatedAt: this.now() };
    this.picks.set(pick.botId, pick);
    this.save();
    return pick;
  }

  /** Xoá lựa chọn của bot (bot về dùng mặc định của nó). */
  unpick(botId: string): EnginePick | null {
    const prev = this.picks.get(botId) ?? null;
    if (!prev) return null;
    this.picks.delete(botId);
    this.save();
    return prev;
  }

  /**
   * Engine bot đang dùng: pick đã lưu (nếu engine còn trong catalog
   * và vẫn chọn được) — ngược lại mặc định của bot. `catalog` không
   * truyền thì tin pick đã lưu (không kiểm chứng lại).
   */
  currentEngine(botDefault: BotEngineDefault, catalog?: EngineOption[]): CurrentEngine {
    const pick = this.picks.get(botDefault.botId);
    if (pick) {
      let label: string | null = null;
      let stillPickable = true;
      if (catalog) {
        const option = catalog.find((o) => o.id === pick.engineId);
        if (!option) stillPickable = false;
        else {
          label = option.label;
          stillPickable = isEnginePickable(option);
        }
      }
      if (stillPickable) {
        return {
          botId: botDefault.botId,
          fromPick: true,
          engineId: pick.engineId,
          source: pick.source,
          providerId: pick.providerId,
          model: pick.model,
          label,
        };
      }
      // Pick cũ trỏ tới engine không còn dùng được → rơi về mặc định,
      // KHÔNG tự xoá pick (user có thể bật lại engine rồi dùng tiếp).
    }
    const source: EngineSource = botDefault.providerId.startsWith('custom-acp') || botDefault.providerId.endsWith('-cli') || ['claude-code', 'codex', 'grok-cli', 'opencode', 'gemini-cli', 'cursor-cli', 'aider', 'continue-cli', 'copilot-cli', 'amazon-q', 'windsurf', 'kiro-cli'].includes(botDefault.providerId)
      ? 'cli'
      : 'api';
    let label: string | null = null;
    if (catalog) {
      const option = catalog.find((o) => o.providerId === botDefault.providerId);
      label = option?.label ?? null;
    }
    return {
      botId: botDefault.botId,
      fromPick: false,
      engineId: engineIdFor(botDefault.providerId, source),
      source,
      providerId: botDefault.providerId,
      model: botDefault.model,
      label,
    };
  }
}
