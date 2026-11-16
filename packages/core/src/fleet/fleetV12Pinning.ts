/**
 * Fleet local-model pinning v12 — mỗi fleet node pin model GGUF cụ thể
 * của mình (v1.15, Đội T6).
 *
 * Bối cảnh (docs/repo-survey-v115.md mục 4 + 6, chỉ học ý tưởng): một
 * fleet chạy model local không được build trên model do OS cung cấp —
 * Apple đổi model theo OS release, Microsoft gỡ Phi Silica khỏi retail
 * Windows 01/2027. Mỗi node phải pin model của mình: file GGUF lấy từ
 * publisher (tổ chức phát hành model), kèm hash SHA-256 để verify khi
 * load. Module này là tầng pinning/verify trên registry model local
 * của T3 (router v115) và health v11 (`fleetV11Health.ts` — health
 * theo node/bot, không biết model nào đang chạy).
 *
 * - Catalog: danh sách model GGUF đã biết, mỗi model có publisher,
 *   license, quant, kích thước, context. Catalog chỉ là dữ liệu tham
 *   khảo — pin thật luôn đi kèm hash do người vận hành nhập.
 * - Pin manifest: `<fleetRoot>/fleet-model-pins-v115.json` (atomic tmp
 *   + rename, mode 0600): model đã pin + node nào pin model nào +
 *   hash đã verify lần cuối.
 * - Verify khi load: `verifyFleetV12ModelFile` đọc file GGUF, hash
 *   SHA-256 (stream, không load cả file vào RAM), so với hash đã pin:
 *   khớp → `verified`; khác → `tampered` (file bị thay đổi/thay thế);
 *   thiếu file → `missing`; kích thước lệch → `size-mismatch`.
 * - Cảnh báo drift: `detectFleetV12PinDrift` so hash hiện tại với hash
 *   đã pin lần trước — model bị thay đổi ngoài ý muốn thì node đó bị
 *   đánh dấu `drift`, không được dùng cho tới khi re-pin/re-verify.
 * - Chặn model OS cung cấp: `isFleetV12OsProvidedModel` — id khớp
 *   blocklist (Apple Foundation Models, Phi Silica / Foundry Local,
 *   `os-provided`, `system-...`) thì `pinFleetV12Model` từ chối kèm
 *   lý do rõ ràng; fleet chỉ chạy model do publisher phát hành.
 *
 * Module này KHÔNG tải model từ mạng, KHÔNG chạy inference, KHÔNG
 * spawn process: nó quyết định "node này được phép chạy model nào,
 * file đó có đúng hash không" — việc tải/load thật do router (T3) /
 * FleetServiceManager làm.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** File lưu pin manifest v12 trong fleet root. */
export const FLEET_V12_PINS_FILE = 'fleet-model-pins-v115.json';
/** Số model tối đa trong catalog/manifest. */
export const FLEET_V12_MAX_MODELS = 100;
/** Số node tối đa được pin trong một manifest. */
export const FLEET_V12_MAX_PINS = 500;
/** Độ dài tối thiểu của một hash SHA-256 hex hợp lệ. */
export const FLEET_V12_SHA256_HEX_LENGTH = 64;

/**
 * Mẫu id của model do OS cung cấp — fleet v12 từ chối pin những model
 * này vì OS có thể đổi/gỡ chúng theo release mà không báo trước
 * (Apple Foundation Models đổi theo OS release; Phi Silica bị gỡ khỏi
 * retail Windows 01/2027). Fleet chỉ chạy model GGUF từ publisher.
 */
export const FLEET_V12_OS_PROVIDED_MODEL_PATTERNS: readonly string[] = [
  'apple-foundation',
  'apple-intelligence',
  'foundation-models',
  'phi-silica',
  'foundry-local',
  'os-provided',
  'system-model',
  'windows-ai',
  'on-device-os',
];

/** Trạng thái verify của một file model đã pin. */
export type FleetV12ModelVerifyStatus =
  | 'verified'
  | 'tampered'
  | 'missing'
  | 'size-mismatch'
  | 'unverified';

export const FLEET_V12_MODEL_VERIFY_STATUSES: readonly FleetV12ModelVerifyStatus[] = [
  'verified',
  'tampered',
  'missing',
  'size-mismatch',
  'unverified',
];

/** Trạng thái pin của một node. */
export type FleetV12PinStatus = 'pinned' | 'drift' | 'unpinned';

export const FLEET_V12_PIN_STATUSES: readonly FleetV12PinStatus[] = [
  'pinned',
  'drift',
  'unpinned',
];

/** Một model GGUF trong catalog (dữ liệu tham khảo, có license rõ). */
export interface FleetV12ModelCatalogEntry {
  /** Id ổn định, vd `qwen3-4b-q4_k_m`. */
  modelId: string;
  /** Tên hiển thị, vd `Qwen3 4B Q4_K_M`. */
  displayName: string;
  /** Publisher phát hành model (tổ chức/cá nhân), vd `Qwen`. */
  publisher: string;
  /** License, vd `Apache-2.0`. */
  license: string;
  /** Quant GGUF, vd `Q4_K_M`. */
  quant: string;
  /** Kích thước file bytes (ước lượng, 0 = chưa biết). */
  sizeBytes: number;
  /** Context window (token). */
  contextTokens: number;
  /** URL nguồn publisher (không tự tải — chỉ để tham khảo). */
  sourceUrl: string;
}

/** Catalog mặc định: model local phổ biến, license rõ (mục 4 khảo sát). */
export const FLEET_V12_MODEL_CATALOG: readonly FleetV12ModelCatalogEntry[] = [
  {
    modelId: 'qwen3-4b-q4_k_m',
    displayName: 'Qwen3 4B Q4_K_M',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    quant: 'Q4_K_M',
    sizeBytes: 2_500_000_000,
    contextTokens: 32_768,
    sourceUrl: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF',
  },
  {
    modelId: 'llama-3.2-3b-q4_k_m',
    displayName: 'Llama 3.2 3B Q4_K_M',
    publisher: 'Meta',
    license: 'Llama-3.2-Community',
    quant: 'Q4_K_M',
    sizeBytes: 1_900_000_000,
    contextTokens: 131_072,
    sourceUrl: 'https://huggingface.co/meta-llama/Llama-3.2-3B-GGUF',
  },
  {
    modelId: 'gemma-3-4b-q4_k_m',
    displayName: 'Gemma 3 4B Q4_K_M',
    publisher: 'Google',
    license: 'Gemma',
    quant: 'Q4_K_M',
    sizeBytes: 2_600_000_000,
    contextTokens: 131_072,
    sourceUrl: 'https://huggingface.co/google/gemma-3-4b-it-GGUF',
  },
  {
    modelId: 'qwen3-8b-q4_k_m',
    displayName: 'Qwen3 8B Q4_K_M',
    publisher: 'Qwen',
    license: 'Apache-2.0',
    quant: 'Q4_K_M',
    sizeBytes: 4_900_000_000,
    contextTokens: 32_768,
    sourceUrl: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF',
  },
  {
    modelId: 'llama-3.1-8b-q4_k_m',
    displayName: 'Llama 3.1 8B Q4_K_M',
    publisher: 'Meta',
    license: 'Llama-3.1-Community',
    quant: 'Q4_K_M',
    sizeBytes: 4_700_000_000,
    contextTokens: 131_072,
    sourceUrl: 'https://huggingface.co/meta-llama/Llama-3.1-8B-GGUF',
  },
];

/** Một model đã pin (hash là nguồn tin cậy duy nhất về nội dung file). */
export interface FleetV12PinnedModel {
  modelId: string;
  publisher: string;
  license: string;
  quant: string;
  /** SHA-256 hex (chữ thường) của file GGUF đã pin. */
  sha256: string;
  /** Kích thước file bytes lúc pin (0 = chưa biết). */
  sizeBytes: number;
  /** Đường dẫn file GGUF trên máy (tuyệt đối hoặc tương đối fleet root). */
  ggufPath: string;
  contextTokens: number;
  pinnedBy: string;
  pinnedAt: number;
  /** Epoch ms verify thành công lần cuối (null = chưa verify lần nào). */
  lastVerifiedAt: number | null;
}

/** Một node pin một model cụ thể. */
export interface FleetV12NodePin {
  nodeId: string;
  modelId: string;
  /** Hash đã verify lần cuối trên node này (null = chưa verify). */
  verifiedSha256: string | null;
  pinnedBy: string;
  pinnedAt: number;
  lastVerifiedAt: number | null;
  status: FleetV12PinStatus;
  /** Lý do drift ('' khi không drift). */
  driftReason: string;
}

/** Toàn bộ pin manifest v12. */
export interface FleetV12PinManifest {
  version: 1;
  models: FleetV12PinnedModel[];
  pins: FleetV12NodePin[];
  updatedAt: number;
  updatedBy: string;
}

/** Input pin một model mới (chưa có pinnedAt/lastVerifiedAt). */
export interface PinFleetV12ModelInput {
  modelId: string;
  publisher: string;
  license: string;
  quant?: string;
  sha256: string;
  sizeBytes?: number;
  ggufPath: string;
  contextTokens?: number;
  pinnedBy: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/** True khi chuỗi là SHA-256 hex hợp lệ (64 ký tự hex). */
export function isFleetV12Sha256(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === FLEET_V12_SHA256_HEX_LENGTH &&
    /^[0-9a-f]{64}$/.test(value)
  );
}

/**
 * True khi model id khớp blocklist model do OS cung cấp. So khớp
 * không phân biệt hoa thường, khớp chuỗi con — vd
 * `apple-foundation-models` hay `phi-silica-q4` đều bị chặn.
 */
export function isFleetV12OsProvidedModel(modelId: string): boolean {
  if (!isNonEmptyString(modelId)) return false;
  const id = normalizeId(modelId);
  return FLEET_V12_OS_PROVIDED_MODEL_PATTERNS.some((p) => id.includes(p));
}

/** Lý do một model id bị coi là do OS cung cấp ('' khi không phải). */
export function fleetV12OsProvidedReason(modelId: string): string {
  if (!isNonEmptyString(modelId)) return '';
  const id = normalizeId(modelId);
  const hit = FLEET_V12_OS_PROVIDED_MODEL_PATTERNS.find((p) => id.includes(p));
  if (!hit) return '';
  return (
    `model "${modelId}" khớp mẫu OS cung cấp "${hit}" — OS có thể đổi/gỡ model ` +
    `theo release mà không báo trước; fleet chỉ chạy model GGUF pin từ publisher`
  );
}

/** Tìm entry catalog theo modelId (không phân biệt hoa thường). */
export function findFleetV12CatalogEntry(
  modelId: string,
): FleetV12ModelCatalogEntry | null {
  if (!isNonEmptyString(modelId)) return null;
  const id = normalizeId(modelId);
  return (
    FLEET_V12_MODEL_CATALOG.find((e) => normalizeId(e.modelId) === id) ?? null
  );
}

/** Validate input pin model. Trả về danh sách lỗi (rỗng = hợp lệ). */
export function validateFleetV12PinInput(input: PinFleetV12ModelInput): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(input?.modelId)) errors.push('modelId không được trống');
  else if (isFleetV12OsProvidedModel(input.modelId)) {
    errors.push(fleetV12OsProvidedReason(input.modelId));
  }
  if (!isNonEmptyString(input?.publisher)) errors.push('publisher không được trống');
  if (!isNonEmptyString(input?.license)) errors.push('license không được trống');
  if (!isFleetV12Sha256(input?.sha256)) {
    errors.push('sha256 phải là SHA-256 hex 64 ký tự (chữ thường)');
  }
  if (!isNonEmptyString(input?.ggufPath)) errors.push('ggufPath không được trống');
  else if (!input.ggufPath.toLowerCase().endsWith('.gguf')) {
    errors.push('ggufPath phải là file .gguf');
  }
  if (!isNonEmptyString(input?.pinnedBy)) errors.push('pinnedBy không được trống');
  if (input?.sizeBytes !== undefined && (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0)) {
    errors.push('sizeBytes phải >= 0');
  }
  if (
    input?.contextTokens !== undefined &&
    (!Number.isFinite(input.contextTokens) || input.contextTokens <= 0)
  ) {
    errors.push('contextTokens phải > 0');
  }
  return errors;
}

export function createFleetV12PinManifest(updatedBy: string, now = Date.now()): FleetV12PinManifest {
  return {
    version: 1,
    models: [],
    pins: [],
    updatedAt: now,
    updatedBy: updatedBy.trim(),
  };
}

function isValidPinnedModel(v: unknown): v is FleetV12PinnedModel {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<FleetV12PinnedModel>;
  return (
    typeof m.modelId === 'string' &&
    typeof m.publisher === 'string' &&
    typeof m.sha256 === 'string' &&
    typeof m.ggufPath === 'string' &&
    typeof m.pinnedAt === 'number'
  );
}

function isValidNodePin(v: unknown): v is FleetV12NodePin {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<FleetV12NodePin>;
  return (
    typeof p.nodeId === 'string' &&
    typeof p.modelId === 'string' &&
    FLEET_V12_PIN_STATUSES.includes(p.status as FleetV12PinStatus)
  );
}

function isValidManifest(v: unknown): v is FleetV12PinManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<FleetV12PinManifest>;
  return m.version === 1 && Array.isArray(m.models) && Array.isArray(m.pins);
}

/**
 * Pin một model vào manifest (hàm thuần, không mutate): modelId trùng
 * thì thay bằng bản pin mới (re-pin sau khi đổi file/hash), kèm
 * lastVerifiedAt = null cho tới khi verify lần đầu. Model do OS cung
 * cấp bị từ chối kèm lý do.
 */
export type FleetV12PinModelResult =
  | { ok: true; manifest: FleetV12PinManifest; model: FleetV12PinnedModel }
  | { ok: false; manifest: FleetV12PinManifest; error: string };

export function pinFleetV12Model(
  manifest: FleetV12PinManifest,
  input: PinFleetV12ModelInput,
  now = Date.now(),
): FleetV12PinModelResult {
  const errors = validateFleetV12PinInput(input);
  if (errors.length > 0) {
    return { ok: false, manifest, error: `pin không hợp lệ: ${errors.join('; ')}` };
  }
  const catalog = findFleetV12CatalogEntry(input.modelId);
  const model: FleetV12PinnedModel = {
    modelId: input.modelId.trim(),
    publisher: input.publisher.trim(),
    license: input.license.trim(),
    quant: input.quant?.trim() || catalog?.quant || 'Q4_K_M',
    sha256: input.sha256.toLowerCase(),
    sizeBytes:
      typeof input.sizeBytes === 'number' ? Math.floor(input.sizeBytes) : catalog?.sizeBytes ?? 0,
    ggufPath: input.ggufPath.trim(),
    contextTokens:
      typeof input.contextTokens === 'number'
        ? Math.floor(input.contextTokens)
        : catalog?.contextTokens ?? 0,
    pinnedBy: input.pinnedBy.trim(),
    pinnedAt: now,
    lastVerifiedAt: null,
  };
  const models = manifest.models.filter(
    (m) => normalizeId(m.modelId) !== normalizeId(model.modelId),
  );
  models.push(model);
  // Re-pin model → các node đang pin model này phải verify lại: đánh
  // driftReason rỗng nhưng reset verifiedSha256 để buộc verify lại.
  const pins = manifest.pins.map((p) =>
    normalizeId(p.modelId) === normalizeId(model.modelId)
      ? { ...p, verifiedSha256: null, lastVerifiedAt: null, status: 'pinned' as FleetV12PinStatus, driftReason: '' }
      : p,
  );
  return {
    ok: true,
    manifest: { ...manifest, models, pins, updatedAt: now, updatedBy: input.pinnedBy.trim() },
    model,
  };
}

/**
 * Gán node pin một model đã có trong manifest (hàm thuần). Node chưa
 * pin model nào → thêm pin mới; node đã pin model khác → đổi sang
 * model mới (status pinned, chưa verify). Model chưa có trong manifest
 * thì từ chối — phải pin model trước.
 */
export type FleetV12AssignPinResult =
  | { ok: true; manifest: FleetV12PinManifest; pin: FleetV12NodePin }
  | { ok: false; manifest: FleetV12PinManifest; error: string };

export function assignFleetV12NodePin(
  manifest: FleetV12PinManifest,
  nodeId: string,
  modelId: string,
  pinnedBy: string,
  now = Date.now(),
): FleetV12AssignPinResult {
  if (!isNonEmptyString(nodeId)) return { ok: false, manifest, error: 'nodeId không được trống' };
  if (!isNonEmptyString(modelId)) return { ok: false, manifest, error: 'modelId không được trống' };
  if (!isNonEmptyString(pinnedBy)) return { ok: false, manifest, error: 'pinnedBy không được trống' };
  const model = manifest.models.find((m) => normalizeId(m.modelId) === normalizeId(modelId));
  if (!model) {
    return { ok: false, manifest, error: `model "${modelId}" chưa được pin — pin model trước khi gán node` };
  }
  const pin: FleetV12NodePin = {
    nodeId: nodeId.trim(),
    modelId: model.modelId,
    verifiedSha256: null,
    pinnedBy: pinnedBy.trim(),
    pinnedAt: now,
    lastVerifiedAt: null,
    status: 'pinned',
    driftReason: '',
  };
  const pins = manifest.pins.filter((p) => p.nodeId !== nodeId.trim());
  pins.push(pin);
  return {
    ok: true,
    manifest: { ...manifest, pins, updatedAt: now, updatedBy: pinnedBy.trim() },
    pin,
  };
}

/** Gỡ pin của một node (hàm thuần). Node chưa pin thì trả về manifest cũ. */
export function unpinFleetV12Node(
  manifest: FleetV12PinManifest,
  nodeId: string,
  updatedBy: string,
  now = Date.now(),
): FleetV12PinManifest {
  if (!isNonEmptyString(nodeId)) return manifest;
  const pins = manifest.pins.filter((p) => p.nodeId !== nodeId.trim());
  if (pins.length === manifest.pins.length) return manifest;
  return { ...manifest, pins, updatedAt: now, updatedBy: updatedBy.trim() };
}

/** Tìm model đã pin theo modelId. */
export function findFleetV12PinnedModel(
  manifest: FleetV12PinManifest,
  modelId: string,
): FleetV12PinnedModel | null {
  if (!isNonEmptyString(modelId)) return null;
  return manifest.models.find((m) => normalizeId(m.modelId) === normalizeId(modelId)) ?? null;
}

/** Tìm pin của một node. */
export function findFleetV12NodePin(
  manifest: FleetV12PinManifest,
  nodeId: string,
): FleetV12NodePin | null {
  if (!isNonEmptyString(nodeId)) return null;
  return manifest.pins.find((p) => p.nodeId === nodeId.trim()) ?? null;
}

// ---------------------------------------------------------------------------
// Verify hash khi load
// ---------------------------------------------------------------------------

/** Kết quả verify một file model. */
export interface FleetV12VerifyResult {
  status: FleetV12ModelVerifyStatus;
  /** SHA-256 thực tế của file (null khi thiếu file / đọc lỗi). */
  actualSha256: string | null;
  expectedSha256: string;
  /** Kích thước thực tế (null khi thiếu file). */
  actualSizeBytes: number | null;
  expectedSizeBytes: number;
  /** Câu giải thích ngắn cho UI/log. */
  detail: string;
}

/**
 * Tính SHA-256 của một file bằng stream (không load cả file vào RAM —
 * file GGUF vài GB). Đọc lỗi (thiếu file, không có quyền) → null.
 */
export function hashFleetV12File(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Verify file model đã pin: so hash thực tế với hash đã pin, và kích
 * thước (khi manifest có sizeBytes > 0). Thứ tự kiểm tra: thiếu file
 * → kích thước lệch → hash khác → khớp.
 */
export async function verifyFleetV12ModelFile(
  model: FleetV12PinnedModel,
): Promise<FleetV12VerifyResult> {
  const expectedSha256 = model.sha256.toLowerCase();
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(model.ggufPath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    return {
      status: 'missing',
      actualSha256: null,
      expectedSha256,
      actualSizeBytes: null,
      expectedSizeBytes: model.sizeBytes,
      detail: `không tìm thấy file model "${model.ggufPath}" — node không được load model này`,
    };
  }
  if (model.sizeBytes > 0 && stat.size !== model.sizeBytes) {
    return {
      status: 'size-mismatch',
      actualSha256: null,
      expectedSha256,
      actualSizeBytes: stat.size,
      expectedSizeBytes: model.sizeBytes,
      detail:
        `kích thước file ${stat.size} byte khác với lúc pin ${model.sizeBytes} byte ` +
        `— file có thể đã bị thay thế, cần verify hash`,
    };
  }
  const actual = await hashFleetV12File(model.ggufPath);
  if (actual === null) {
    return {
      status: 'missing',
      actualSha256: null,
      expectedSha256,
      actualSizeBytes: stat.size,
      expectedSizeBytes: model.sizeBytes,
      detail: `không đọc được file model "${model.ggufPath}"`,
    };
  }
  if (actual !== expectedSha256) {
    return {
      status: 'tampered',
      actualSha256: actual,
      expectedSha256,
      actualSizeBytes: stat.size,
      expectedSizeBytes: model.sizeBytes,
      detail:
        `hash SHA-256 của file khác với hash đã pin — model đã bị thay đổi/thay thế, ` +
        `không được load cho tới khi re-pin`,
    };
  }
  return {
    status: 'verified',
    actualSha256: actual,
    expectedSha256,
    actualSizeBytes: stat.size,
    expectedSizeBytes: model.sizeBytes,
    detail: `model "${model.modelId}" đã verify: hash khớp với bản pin`,
  };
}

/** Kết quả phát hiện drift trên toàn manifest. */
export interface FleetV12DriftReport {
  /** Node bị drift (model thay đổi so với hash đã verify lần trước). */
  drifted: { nodeId: string; modelId: string; reason: string }[];
  /** Node chưa verify lần nào (cần verify trước khi dùng). */
  unverified: { nodeId: string; modelId: string }[];
  /** Node đang dùng đúng model đã verify. */
  ok: string[];
  summary: string;
}

/**
 * Phát hiện drift (hàm thuần, từ kết quả verify đã có — không đọc
 * file): mỗi node có `verifiedSha256` lần trước; nếu kết quả verify
 * mới nhất khác hash đã pin → drift; chưa verify → unverified.
 * Caller truyền map nodeId → FleetV12VerifyResult mới nhất.
 */
export function detectFleetV12PinDrift(
  manifest: FleetV12PinManifest,
  latestResults: Map<string, FleetV12VerifyResult> | Record<string, FleetV12VerifyResult>,
): FleetV12DriftReport {
  const get = (nodeId: string): FleetV12VerifyResult | undefined =>
    latestResults instanceof Map
      ? latestResults.get(nodeId)
      : (latestResults as Record<string, FleetV12VerifyResult>)[nodeId];
  const drifted: FleetV12DriftReport['drifted'] = [];
  const unverified: FleetV12DriftReport['unverified'] = [];
  const ok: string[] = [];
  for (const pin of manifest.pins) {
    const result = get(pin.nodeId);
    if (!result) {
      unverified.push({ nodeId: pin.nodeId, modelId: pin.modelId });
      continue;
    }
    if (result.status === 'verified') {
      ok.push(pin.nodeId);
    } else if (result.status === 'unverified') {
      unverified.push({ nodeId: pin.nodeId, modelId: pin.modelId });
    } else {
      drifted.push({ nodeId: pin.nodeId, modelId: pin.modelId, reason: result.detail });
    }
  }
  const summary =
    drifted.length === 0 && unverified.length === 0
      ? `Tất cả ${manifest.pins.length} node pin đều khớp hash đã pin.`
      : `${drifted.length} node bị drift (model thay đổi), ${unverified.length} node chưa verify, ${ok.length} node OK.`;
  return { drifted, unverified, ok, summary };
}

/**
 * Áp dụng kết quả verify vào manifest (hàm thuần): cập nhật
 * verifiedSha256/lastVerifiedAt cho model + pin của node; node có
 * kết quả tampered/missing/size-mismatch → status `drift` kèm lý do;
 * verified → status `pinned`, driftReason rỗng.
 */
export function applyFleetV12VerifyResult(
  manifest: FleetV12PinManifest,
  nodeId: string,
  result: FleetV12VerifyResult,
  now = Date.now(),
): FleetV12PinManifest {
  const pin = findFleetV12NodePin(manifest, nodeId);
  if (!pin) return manifest;
  const model = findFleetV12PinnedModel(manifest, pin.modelId);
  const drifted = result.status !== 'verified';
  const models = model
    ? manifest.models.map((m) =>
        normalizeId(m.modelId) === normalizeId(model.modelId)
          ? { ...m, lastVerifiedAt: result.status === 'verified' ? now : m.lastVerifiedAt }
          : m,
      )
    : manifest.models;
  const pins = manifest.pins.map((p) =>
    p.nodeId === nodeId.trim()
      ? {
          ...p,
          verifiedSha256: result.actualSha256,
          lastVerifiedAt: result.status === 'verified' ? now : p.lastVerifiedAt,
          status: (drifted ? 'drift' : 'pinned') as FleetV12PinStatus,
          driftReason: drifted ? result.detail : '',
        }
      : p,
  );
  return { ...manifest, models, pins, updatedAt: now };
}

/** Tóm tắt manifest cho UI: model nào, node nào, node nào drift. */
export interface FleetV12PinSummary {
  modelCount: number;
  pinCount: number;
  driftCount: number;
  unverifiedCount: number;
  osProvidedBlocked: number;
  summary: string;
}

export function summarizeFleetV12Pins(
  manifest: FleetV12PinManifest,
  osProvidedBlocked = 0,
): FleetV12PinSummary {
  const driftCount = manifest.pins.filter((p) => p.status === 'drift').length;
  const unverifiedCount = manifest.pins.filter((p) => p.verifiedSha256 === null).length;
  const summary =
    manifest.pins.length === 0
      ? 'Chưa có node nào pin model — fleet chưa chạy model local nào.'
      : `${manifest.models.length} model đã pin trên ${manifest.pins.length} node; ` +
        `${driftCount} node drift, ${unverifiedCount} node chưa verify.`;
  return {
    modelCount: manifest.models.length,
    pinCount: manifest.pins.length,
    driftCount,
    unverifiedCount,
    osProvidedBlocked,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getFleetV12PinsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V12_PINS_FILE);
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Nền tảng không hỗ trợ chmod (Windows) — file vẫn dùng được.
  }
}

export function loadFleetV12PinManifest(
  fleetRoot: string,
): FleetV12PinManifest | null {
  try {
    const raw = fs.readFileSync(getFleetV12PinsPath(fleetRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidManifest(parsed)) return null;
    return {
      version: 1,
      models: parsed.models.filter(isValidPinnedModel).slice(0, FLEET_V12_MAX_MODELS),
      pins: parsed.pins.filter(isValidNodePin).slice(0, FLEET_V12_MAX_PINS),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : '',
    };
  } catch {
    return null;
  }
}

export function saveFleetV12PinManifest(
  fleetRoot: string,
  manifest: FleetV12PinManifest,
): void {
  atomicWriteFile(
    getFleetV12PinsPath(fleetRoot),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
