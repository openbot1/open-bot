/**
 * Coding agent v12 — ACP model switching GIỮA CHỪNG trong session.
 *
 * Nối modelSwitch v4 (đổi model GIỮA CÁC RUN, transcript giữ nguyên,
 * ghi log switch + rollback): v12 cho phép đổi model GIỮA CHỪNG một
 * ACP session đang chạy — khác biệt cốt lõi là session không bị
 * đóng/mở lại, và client phải được báo capabilities mới:
 *
 *   1. Giữ nguyên context: toàn bộ transcript (mọi message, kể cả
 *      message assistant của model cũ — ghi rõ modelId từng message)
 *      được giữ nguyên; chỉ model hiện tại đổi. Không message nào
 *      bị xóa hay viết lại.
 *   2. Re-announce capabilities: khi switch, tính diff capability
 *      (thêm/mất) giữa model cũ và model mới, trả về để host gửi
 *      lại cho ACP client (`capabilitiesAdded` / `capabilitiesRemoved`);
 *      model mới thiếu capability mà task đang cần thì switch bị
 *      chặn (host truyền `requiredCapabilities`).
 *   3. Switch an toàn giữa chừng: cờ `switchInFlight` — không cho
 *      switch chồng khi một switch chưa xong; switch đang chạy thì
 *      `recordAssistantMessage` vẫn ghi đúng model cũ cho tới khi
 *      switch hoàn tất (không ghi nhầm model).
 *   4. Rollback: quay về model trước đó (ghi bản ghi rollback, giữ
 *      nguyên transcript), không cho rollback khi chưa từng switch.
 *
 * Module thuần (không gọi LLM, không gọi mạng): host dùng session
 * này để nhớ model hiện tại + transcript + lịch sử switch, rồi gọi
 * provider thật bằng modelId hiện tại ở mỗi run. Khác v4 ở chỗ v4
 * cấm đổi giữa run; v12 cho đổi giữa chừng nhưng vẫn giữ quy tắc
 * \"không viết lại transcript\" của v4.
 */

import { CodingV12Error } from './types';
import type {
  V12AcpMessage,
  V12AcpModel,
  V12AcpSessionSummary,
  V12AcpSwitchRecord,
  V12ModelCapability,
} from './types';

/** Định dạng id model hợp lệ (như v4: `provider/name…` hoặc tên đơn). */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/;

/** Id switch record. */
export function v12NewAcpSwitchId(): string {
  return `v12sw-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Id session ACP. */
export function v12NewAcpSessionId(): string {
  return `v12acp-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Kiểm tra id model (định dạng + có trong catalog nếu có). */
export function validateV12AcpModelId(
  modelId: string,
  catalog?: readonly V12AcpModel[],
): { ok: true } | { ok: false; error: string } {
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    return { ok: false, error: 'ACP v12: modelId không được rỗng.' };
  }
  if (!MODEL_ID_RE.test(modelId)) {
    return { ok: false, error: `ACP v12: modelId "${modelId}" sai định dạng (chỉ chữ, số, ., _, -, /, :).` };
  }
  if (catalog && !catalog.some((m) => m.id === modelId)) {
    return { ok: false, error: `ACP v12: model "${modelId}" không có trong catalog.` };
  }
  return { ok: true };
}

/** Capability đang bật của một model (theo tên). */
export function v12EnabledCapabilities(model: V12AcpModel): string[] {
  return model.capabilities.filter((c) => c.enabled).map((c) => c.name).sort();
}

/** Diff capability giữa 2 model: thêm / mất / giữ nguyên. */
export function v12CapabilityDiff(
  fromModel: V12AcpModel,
  toModel: V12AcpModel,
): { added: string[]; removed: string[]; kept: string[] } {
  const from = new Set(v12EnabledCapabilities(fromModel));
  const to = new Set(v12EnabledCapabilities(toModel));
  return {
    added: [...to].filter((c) => !from.has(c)).sort(),
    removed: [...from].filter((c) => !to.has(c)).sort(),
    kept: [...to].filter((c) => from.has(c)).sort(),
  };
}

/** Kiểm tra model mới có đủ capability bắt buộc không. */
export function v12MissingCapabilities(model: V12AcpModel, required: readonly string[]): string[] {
  const enabled = new Set(v12EnabledCapabilities(model));
  return required.filter((r) => !enabled.has(r));
}

export interface V12AcpSwitchOptions {
  /** Capability task đang cần — model mới thiếu thì chặn switch. */
  requiredCapabilities?: readonly string[];
  /** Cho phép switch sang model thiếu capability (mặc định: chặn). */
  allowCapabilityLoss?: boolean;
}

/** Kết quả một lần switch model giữa chừng. */
export interface V12AcpSwitchResult {
  record: V12AcpSwitchRecord;
  /** Capabilities client cần announce lại sau switch. */
  announce: V12ModelCapability[];
  /** Cảnh báo (capability mất nhưng được phép, model lạ…). */
  warnings: string[];
}

/**
 * ACP session v12: transcript + model hiện tại + lịch sử switch.
 * Switch giữa chừng: giữ transcript, re-announce capabilities.
 */
export class V12AcpSession {
  readonly sessionId: string;
  private modelId: string;
  private readonly catalog: Map<string, V12AcpModel>;
  private readonly transcript: V12AcpMessage[] = [];
  private readonly switches: V12AcpSwitchRecord[] = [];
  private switchInFlight = false;
  private readonly createdAt: string;
  private updatedAt: string;

  constructor(initialModelId: string, catalog: readonly V12AcpModel[] = [], sessionId?: string) {
    const check = validateV12AcpModelId(initialModelId, catalog.length > 0 ? catalog : undefined);
    if (!check.ok) throw new CodingV12Error('acp-model-invalid', check.error);
    this.sessionId = sessionId ?? v12NewAcpSessionId();
    this.modelId = initialModelId;
    this.catalog = new Map(catalog.map((m) => [m.id, m]));
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
  }

  /** Model hiện tại. */
  currentModelId(): string {
    return this.modelId;
  }

  /** Model trong catalog (undefined khi session không có catalog). */
  modelInfo(modelId: string): V12AcpModel | undefined {
    return this.catalog.get(modelId);
  }

  /** Capabilities đang announce cho client (của model hiện tại). */
  currentCapabilities(): V12ModelCapability[] {
    return this.catalog.get(this.modelId)?.capabilities.map((c) => ({ ...c })) ?? [];
  }

  /** Transcript hiện tại (bản sao — caller không sửa được nội bộ). */
  getTranscript(): V12AcpMessage[] {
    return this.transcript.map((m) => ({ ...m }));
  }

  /** Lịch sử switch (bản sao). */
  getSwitchHistory(): V12AcpSwitchRecord[] {
    return this.switches.map((s) => ({ ...s }));
  }

  /** Thêm message user/system/tool vào transcript. */
  addMessage(role: 'user' | 'system' | 'tool', content: string): V12AcpMessage {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new CodingV12Error('acp-model-invalid', 'ACP v12: nội dung message không được rỗng.');
    }
    const msg: V12AcpMessage = { role, content, at: new Date().toISOString() };
    this.transcript.push(msg);
    this.updatedAt = msg.at;
    return msg;
  }

  /** Ghi message assistant (gắn modelId hiện tại lúc ghi). */
  recordAssistantMessage(content: string): V12AcpMessage {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new CodingV12Error('acp-model-invalid', 'ACP v12: nội dung message assistant không được rỗng.');
    }
    const msg: V12AcpMessage = { role: 'assistant', content, modelId: this.modelId, at: new Date().toISOString() };
    this.transcript.push(msg);
    this.updatedAt = msg.at;
    return msg;
  }

  /** Số ký tự transcript (để báo cáo context đã giữ). */
  transcriptChars(): number {
    return this.transcript.reduce((n, m) => n + m.content.length, 0);
  }

  /**
   * Chuyển model GIỮA CHỪNG: giữ nguyên transcript, tính diff
   * capability, ghi bản ghi switch. Chặn khi: model không hợp lệ /
   * trùng model hiện tại / thiếu capability bắt buộc / đang có switch
   * khác chạy (switchInFlight).
   */
  switchModel(toModelId: string, reason: string, options: V12AcpSwitchOptions = {}): V12AcpSwitchResult {
    if (this.switchInFlight) {
      throw new CodingV12Error('acp-switch-in-flight', 'ACP v12: đang có một lần switch khác chưa xong.');
    }
    const check = validateV12AcpModelId(toModelId, this.catalog.size > 0 ? [...this.catalog.values()] : undefined);
    if (!check.ok) throw new CodingV12Error('acp-model-unknown', check.error);
    if (toModelId === this.modelId) {
      throw new CodingV12Error('acp-model-invalid', `ACP v12: model "${toModelId}" đã là model hiện tại, không cần switch.`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new CodingV12Error('acp-model-invalid', 'ACP v12: lý do switch không được rỗng.');
    }
    const fromModel = this.catalog.get(this.modelId);
    const toModel = this.catalog.get(toModelId);
    const warnings: string[] = [];
    let added: string[] = [];
    let removed: string[] = [];
    if (fromModel && toModel) {
      const diff = v12CapabilityDiff(fromModel, toModel);
      added = diff.added;
      removed = diff.removed;
      if (removed.length > 0 && !options.allowCapabilityLoss) {
        throw new CodingV12Error(
          'acp-model-invalid',
          `ACP v12: model "${toModelId}" thiếu capability đang dùng: ${removed.join(', ')} (truyền allowCapabilityLoss để ép switch).`,
        );
      }
      if (removed.length > 0) warnings.push(`Mất capability: ${removed.join(', ')}.`);
      if (added.length > 0) warnings.push(`Thêm capability: ${added.join(', ')}.`);
    }
    if (toModel && options.requiredCapabilities) {
      const missing = v12MissingCapabilities(toModel, options.requiredCapabilities);
      if (missing.length > 0) {
        throw new CodingV12Error(
          'acp-model-invalid',
          `ACP v12: model "${toModelId}" thiếu capability bắt buộc: ${missing.join(', ')}.`,
        );
      }
    }
    if (!toModel && this.catalog.size > 0) {
      warnings.push(`Model "${toModelId}" không có trong catalog — capabilities chưa biết, client tự kiểm tra.`);
    }
    this.switchInFlight = true;
    try {
      const record: V12AcpSwitchRecord = {
        id: v12NewAcpSwitchId(),
        at: new Date().toISOString(),
        fromModelId: this.modelId,
        toModelId,
        reason: reason.trim(),
        preservedMessages: this.transcript.length,
        capabilitiesAdded: added,
        capabilitiesRemoved: removed,
      };
      this.modelId = toModelId;
      this.switches.push(record);
      this.updatedAt = record.at;
      return {
        record,
        announce: this.currentCapabilities(),
        warnings,
      };
    } finally {
      this.switchInFlight = false;
    }
  }

  /** Rollback về model của lần switch gần nhất (giữ nguyên transcript). */
  rollback(reason: string): V12AcpSwitchResult {
    const last = this.switches[this.switches.length - 1];
    if (!last) {
      throw new CodingV12Error('acp-no-switch-to-rollback', 'ACP v12: chưa từng switch nên không có gì để rollback.');
    }
    if (last.toModelId === last.fromModelId) {
      throw new CodingV12Error('acp-no-switch-to-rollback', 'ACP v12: lần switch gần nhất không đổi model.');
    }
    // Rollback = switch ngược, nhưng ghi rõ rolledBack + không tính là switch mới vào lịch sử thường.
    const result = this.switchModel(last.fromModelId, reason || `Rollback switch ${last.id}`, { allowCapabilityLoss: true });
    result.record.rolledBack = true;
    return result;
  }

  /** Tóm tắt session (để UI hiện model hiện tại + lịch sử). */
  summary(): V12AcpSessionSummary {
    const modelsUsed: string[] = [];
    for (const m of this.transcript) {
      if (m.modelId && !modelsUsed.includes(m.modelId)) modelsUsed.push(m.modelId);
    }
    if (!modelsUsed.includes(this.modelId)) modelsUsed.push(this.modelId);
    return {
      sessionId: this.sessionId,
      modelId: this.modelId,
      messages: this.transcript.length,
      transcriptChars: this.transcriptChars(),
      switches: this.switches.length,
      modelsUsed,
      capabilities: this.currentCapabilities(),
      lastSwitchAt: this.switches[this.switches.length - 1]?.at,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** Serialize session (transcript + lịch sử switch) để host lưu đĩa. */
  serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      modelId: this.modelId,
      catalog: [...this.catalog.values()],
      transcript: this.transcript,
      switches: this.switches,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }
}

/** Khôi phục session ACP v12 từ JSON serialize. */
export function v12AcpSessionFromJson(json: string): V12AcpSession {
  let parsed: {
    sessionId: string;
    modelId: string;
    catalog?: V12AcpModel[];
    transcript?: V12AcpMessage[];
    switches?: V12AcpSwitchRecord[];
    createdAt?: string;
    updatedAt?: string;
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodingV12Error('acp-model-invalid', 'ACP v12: JSON session không hợp lệ.');
  }
  if (!parsed || typeof parsed.modelId !== 'string') {
    throw new CodingV12Error('acp-model-invalid', 'ACP v12: JSON session thiếu modelId.');
  }
  const session = new V12AcpSession(parsed.modelId, parsed.catalog ?? [], parsed.sessionId);
  const priv = session as unknown as {
    transcript: V12AcpMessage[];
    switches: V12AcpSwitchRecord[];
    createdAt: string;
    updatedAt: string;
  };
  priv.transcript.push(...(parsed.transcript ?? []));
  priv.switches.push(...(parsed.switches ?? []));
  if (parsed.createdAt) priv.createdAt = parsed.createdAt;
  if (parsed.updatedAt) priv.updatedAt = parsed.updatedAt;
  return session;
}

/** Render tóm tắt session ACP thành text ngắn. */
export function renderV12AcpSessionSummary(summary: V12AcpSessionSummary): string {
  const caps = summary.capabilities.filter((c) => c.enabled).map((c) => c.name).join(', ') || '(không rõ capability)';
  return [
    `ACP v12 session ${summary.sessionId}: model ${summary.modelId} (${summary.modelsUsed.join(' → ') || summary.modelId}), ${summary.messages} message, ${summary.transcriptChars} ký tự transcript, ${summary.switches} lần switch.`,
    `Capabilities đang announce: ${caps}.`,
  ].join('\n');
}
