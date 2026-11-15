/**
 * ACP-style model switching giua cac run (v1.11, Doi T4) — coding agent v4.
 *
 * Y tuong hoc tu OpenHands 1.39 ACP model switching (chi hoc y tuong,
 * tu thiet ke va viet lai hoan toan tu dau — KHONG doc, KHONG copy
 * code/text/tai san cua bat ky repo nao, cua xAI/Cursor).
 *
 * Quy tac: doi model GIUA CAC RUN, khong giua chung mot run — run
 * dang chay giu nguyen model de khong vo transcript; lan switch chi
 * co hieu luc tu run ke tiep. Toan bo lich su hoi thoai (transcript)
 * duoc GIU NGUYEN khi doi model: message cu van con, chi ghi them
 * model nao da tra loi message do. Moi lan switch deu ghi log (tu
 * model nao, sang model nao, luc nao, ly do gi, giu bao nhieu
 * message) va co the rollback ve model truoc.
 *
 * Module nay thuan tuy (khong goi LLM, khong goi API): host dung
 * session nay de nho model hien tai + transcript + lich su switch,
 * roi goi provider that bang modelId hien tai o moi run.
 *
 * Gioi han trung thuc:
 *   - day la quan ly phien + log, KHONG phai goi model that: chat
 *     that van do host/provider dam nhan.
 *   - catalog (danh sach model cho phep) la cau hinh tinh do host
 *     cap; khong co catalog thi chi kiem tra dinh dang id.
 *   - transcript luu trong bo nho; muon ben vung phai serialize.
 */

export type CodingV4MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface CodingV4Message {
  role: CodingV4MessageRole;
  content: string;
  /** Model da tra loi message nay (chi message assistant). */
  modelId?: string;
  at: string;
}

export interface CodingV4SwitchRecord {
  id: string;
  at: string;
  fromModelId: string;
  toModelId: string;
  reason: string;
  /** So message trong transcript luc switch (tat ca duoc giu). */
  preservedMessages: number;
  /** So ky tu transcript luc switch. */
  transcriptChars: number;
  /** true khi ban ghi nay la rollback cua lan switch truoc. */
  rolledBack?: boolean;
}

export interface CodingV4SessionSummary {
  sessionId: string;
  modelId: string;
  messages: number;
  transcriptChars: number;
  switches: number;
  modelsUsed: string[];
  lastSwitchAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Dinh dang id model hop le: `provider/name...` hoac ten don. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/;

/**
 * Kiem tra id model: khong rong, dung dinh dang, va (neu co catalog)
 * phai nam trong catalog. Tra `{ ok: true }` hoac `{ ok: false, error }`.
 */
export function validateCodingV4ModelId(
  modelId: string,
  catalog?: readonly string[],
): { ok: true } | { ok: false; error: string } {
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    return { ok: false, error: 'modelId khong duoc rong.' };
  }
  if (!MODEL_ID_RE.test(modelId)) {
    return { ok: false, error: `modelId "${modelId}" sai dinh dang (chi chu, so, ., _, -, /, :).` };
  }
  if (catalog && catalog.length > 0 && !catalog.includes(modelId)) {
    return { ok: false, error: `modelId "${modelId}" khong co trong catalog cho phep (${catalog.length} model).` };
  }
  return { ok: true };
}

export interface CodingV4SessionOptions {
  sessionId?: string;
  /** Model bat dau phien. Mac dinh "ollama/qwen2.5-coder:7b". */
  modelId?: string;
  /** Danh sach model cho phep doi sang (rong = cho phep moi id hop le). */
  catalog?: string[];
  title?: string;
}

export const CODING_V4_DEFAULT_MODEL_ID = 'ollama/qwen2.5-coder:7b';

/**
 * Phien coding co the doi model giua cac run: transcript duoc giu
 * nguyen, moi lan switch ghi log day du, co the rollback.
 */
export class CodingV4CodingSession {
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: string;
  private catalog: string[];
  private currentModelId: string;
  private transcript: CodingV4Message[] = [];
  private switchLog: CodingV4SwitchRecord[] = [];
  private switchCounter = 0;
  private updatedAtValue: string;

  constructor(options: CodingV4SessionOptions = {}) {
    const modelId = options.modelId ?? CODING_V4_DEFAULT_MODEL_ID;
    const checked = validateCodingV4ModelId(modelId, options.catalog);
    if (!checked.ok) throw new Error(checked.error);
    this.sessionId = options.sessionId ?? 'default';
    this.title = options.title ?? '';
    this.catalog = options.catalog ? [...options.catalog] : [];
    this.currentModelId = modelId;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAtValue = now;
  }

  get modelId(): string {
    return this.currentModelId;
  }

  get messages(): readonly CodingV4Message[] {
    return this.transcript;
  }

  get switches(): readonly CodingV4SwitchRecord[] {
    return this.switchLog;
  }

  get switchCount(): number {
    return this.switchLog.length;
  }

  get updatedAt(): string {
    return this.updatedAtValue;
  }

  get allowedModels(): readonly string[] {
    return this.catalog;
  }

  private touch(): void {
    this.updatedAtValue = new Date().toISOString();
  }

  transcriptChars(): number {
    return this.transcript.reduce((acc, m) => acc + m.content.length, 0);
  }

  /** Them message vao transcript (assistant duoc gan model hien tai). */
  addMessage(role: CodingV4MessageRole, content: string): CodingV4Message {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('CodingV4CodingSession.addMessage can content khong rong.');
    }
    const msg: CodingV4Message = { role, content, at: new Date().toISOString() };
    if (role === 'assistant') msg.modelId = this.currentModelId;
    this.transcript.push(msg);
    this.touch();
    return msg;
  }

  /**
   * Doi model giua cac run. Transcript duoc GIU NGUYEN (khong xoa,
   * khong cat); ban ghi switch luu so message/ky tu da giu. Loi khi:
   * id sai dinh dang, khong co trong catalog, trung model hien tai,
   * hoac thieu ly do.
   */
  switchModel(toModelId: string, reason: string): CodingV4SwitchRecord {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error('Doi model can ly do (reason khong duoc rong).');
    }
    const checked = validateCodingV4ModelId(toModelId, this.catalog);
    if (!checked.ok) throw new Error(checked.error);
    if (toModelId === this.currentModelId) {
      throw new Error(`Model "${toModelId}" dang la model hien tai — khong can switch.`);
    }
    this.switchCounter += 1;
    const record: CodingV4SwitchRecord = {
      id: `switch-${this.switchCounter}`,
      at: new Date().toISOString(),
      fromModelId: this.currentModelId,
      toModelId,
      reason: reason.trim(),
      preservedMessages: this.transcript.length,
      transcriptChars: this.transcriptChars(),
    };
    this.currentModelId = toModelId;
    this.switchLog.push(record);
    this.touch();
    return record;
  }

  /**
   * Rollback ve model truoc lan switch gan nhat: doi model nguoc lai
   * va ghi them 1 ban ghi rollback (khong xoa lich su cu). Tra false
   * khi chua tung switch.
   */
  rollbackLastSwitch(reason = 'rollback ve model truoc'): boolean {
    const last = this.switchLog[this.switchLog.length - 1];
    if (!last) return false;
    if (last.toModelId === this.currentModelId) {
      this.switchCounter += 1;
      const record: CodingV4SwitchRecord = {
        id: `switch-${this.switchCounter}`,
        at: new Date().toISOString(),
        fromModelId: this.currentModelId,
        toModelId: last.fromModelId,
        reason,
        preservedMessages: this.transcript.length,
        transcriptChars: this.transcriptChars(),
        rolledBack: true,
      };
      this.currentModelId = last.fromModelId;
      this.switchLog.push(record);
      this.touch();
      return true;
    }
    return false;
  }

  /** Cac model da tung dung trong phien (hien tai + lich su), theo thu tu. */
  modelsUsed(): string[] {
    const seen: string[] = [];
    const push = (id: string): void => {
      if (!seen.includes(id)) seen.push(id);
    };
    for (const rec of this.switchLog) {
      push(rec.fromModelId);
      push(rec.toModelId);
    }
    push(this.currentModelId);
    return seen;
  }

  summary(): CodingV4SessionSummary {
    const last = this.switchLog[this.switchLog.length - 1];
    const out: CodingV4SessionSummary = {
      sessionId: this.sessionId,
      modelId: this.currentModelId,
      messages: this.transcript.length,
      transcriptChars: this.transcriptChars(),
      switches: this.switchLog.length,
      modelsUsed: this.modelsUsed(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAtValue,
    };
    if (last) out.lastSwitchAt = last.at;
    return out;
  }

  /** Lich su switch dang text (hien trong UI / log). */
  renderSwitchHistory(): string {
    if (this.switchLog.length === 0) {
      return `Session ${this.sessionId}: model ${this.currentModelId}, chua doi model lan nao.`;
    }
    const lines = [
      `Session ${this.sessionId}: model hien tai ${this.currentModelId} (${this.switchLog.length} lan doi, ${this.transcript.length} message duoc giu).`,
    ];
    for (const rec of this.switchLog) {
      lines.push(
        `  ${rec.at} ${rec.fromModelId} -> ${rec.toModelId} — ${rec.reason} ` +
          `(giu ${rec.preservedMessages} message, ${rec.transcriptChars} ky tu)${rec.rolledBack ? ' [rollback]' : ''}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Xuat transcript de luu/xem lai: `markdown` (tieu de + tung message
   * kem model da tra loi) hoac `jsonl` (1 JSON object moi dong).
   * Transcript xuat ra van day du sau moi lan doi model.
   */
  exportTranscript(format: 'markdown' | 'jsonl' = 'markdown'): string {
    if (format === 'jsonl') {
      return this.transcript
        .map((m) => JSON.stringify({ sessionId: this.sessionId, ...m }))
        .join('\n');
    }
    const lines = [
      `# Transcript — session ${this.sessionId}`,
      `Model hien tai: ${this.currentModelId} (${this.switchLog.length} lan doi model).`,
      '',
    ];
    for (const m of this.transcript) {
      const tag = m.role === 'assistant' && m.modelId ? ` (model ${m.modelId})` : '';
      lines.push(`## ${m.role}${tag} — ${m.at}`);
      lines.push(m.content);
      lines.push('');
    }
    return lines.join('\n');
  }

  serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAtValue,
      catalog: this.catalog,
      modelId: this.currentModelId,
      transcript: this.transcript,
      switchLog: this.switchLog,
      switchCounter: this.switchCounter,
    });
  }

  static parse(text: string): CodingV4CodingSession {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`Session coding v4 JSON hong: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Session coding v4 khong phai object JSON.');
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sessionId !== 'string' || typeof obj.modelId !== 'string') {
      throw new Error('Session coding v4 thieu sessionId/modelId.');
    }
    const session = new CodingV4CodingSession({
      sessionId: obj.sessionId as string,
      modelId: obj.modelId as string,
      catalog: Array.isArray(obj.catalog) ? (obj.catalog as string[]) : [],
      title: typeof obj.title === 'string' ? obj.title : undefined,
    });
    if (Array.isArray(obj.transcript)) {
      session.transcript = (obj.transcript as CodingV4Message[]).filter(
        (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
      );
    }
    if (Array.isArray(obj.switchLog)) {
      session.switchLog = (obj.switchLog as CodingV4SwitchRecord[]).filter(
        (r) => r && typeof r.fromModelId === 'string' && typeof r.toModelId === 'string',
      );
    }
    if (typeof obj.switchCounter === 'number') session.switchCounter = obj.switchCounter;
    return session;
  }
}
