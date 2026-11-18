/**
 * Inference broker v2 — validate moi tool call truoc khi thuc thi
 * (v1.33, Doi T5).
 *
 * Nguyen tac (tu survey v133 muc 4): KHONG tin parser cua engine.
 * vLLM doc thua nhan forced call chi dam bao parse duoc, khong dam
 * bao dung; Ollama khong co strict mode; llama.cpp co the gay schema
 * khi KV cache quant manh. Nen moi tool call — du tu engine nao —
 * deu phai qua gate nay truoc khi thuc thi:
 *   1. Ten tool co trong allowlist khong (tool la / khong biet bi chan).
 *   2. Arguments co parse duoc JSON khong.
 *   3. Arguments co khop JSON Schema cua tool khong (required, kieu,
 *      enum, additionalProperties, nested object/array, min/max...).
 * Tool call sai schema bi CHAN + log + retry co gioi han (khong retry
 * vo han, khong tu sua arguments doan mo).
 *
 * Thuan, khong I/O, khong goi API that. Executor thuc thi tool do
 * broker.ts truyen vao — module nay chi quyet dinh cho / chan.
 */

/** Dinh nghia 1 tool (subset JSON Schema, du cho tool calling). */
export interface InferenceBrokerV2ToolDefinition {
  /** Ten tool (khop chinh xac, phan biet hoa/thuong). */
  name: string;
  /** Mo ta ngan (de log / UI). */
  description?: string;
  /** JSON Schema cua arguments (thuong { type: 'object', properties, required }). */
  parameters?: Record<string, unknown>;
}

/** 1 tool call tho (tu response cua engine, chua validate). */
export interface InferenceBrokerV2RawToolCallInput {
  /** Id call (neu co). */
  id?: string;
  /** Ten tool engine yeu cau. */
  name: string;
  /** Arguments: chuoi JSON (OpenAI) hoac object san (Ollama /api/chat). */
  arguments: string | Record<string, unknown> | unknown;
}

/** 1 tool call da chuan hoa (sau khi parse arguments). */
export interface InferenceBrokerV2ToolCall {
  /** Id call (neu co). */
  id?: string;
  /** Ten tool. */
  name: string;
  /** Arguments da parse (object). */
  args: Record<string, unknown>;
}

/** Ket qua validate 1 tool call. */
export interface InferenceBrokerV2ValidationResult {
  /** true = duoc phep thuc thi. */
  ok: boolean;
  /** Tool call da chuan hoa (chi co khi ok). */
  call?: InferenceBrokerV2ToolCall;
  /** Ly do bi chan (rong khi ok). */
  blockedReasons: string[];
  /** Canh bao (khong chan, vd arg thua bi bo qua neu schema mo). */
  warnings: string[];
  /** Ten tool (de log). */
  toolName: string;
}

/** 1 muc log tool call bi chan (ghi de audit, khong luu arguments nhay cam nguyen ven). */
export interface InferenceBrokerV2BlockedLogEntry {
  /** Thu tu. */
  seq: number;
  /** Ten tool bi chan ('' neu khong co ten). */
  toolName: string;
  /** Ly do chan. */
  reasons: readonly string[];
  /** Engine goi ra call nay (neu biet). */
  engine?: string;
  /** Thoi diem (ms epoch). */
  at: number;
  /** Do dai arguments tho (de do muc do lech, khong luu noi dung). */
  argsLength: number;
}

/** So muc log toi da giu trong bo nho. */
export const BROKER_V2_VALIDATION_LOG_MAX = 200;
/** So lan retry toi da cho 1 tool call bi chan (mac dinh). */
export const BROKER_V2_DEFAULT_MAX_VALIDATION_RETRIES = 2;

// ---------------------------------------------------------------------------
// JSON Schema subset validator (thuan)
// ---------------------------------------------------------------------------

/** Kiem tra 1 gia tri co dung kieu JSON Schema khong. */
export function brokerV2ValueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/**
 * Validate 1 gia tri theo 1 schema node. Tra danh sach loi (rong = hop
 * le). Ho tro: type (string hoac string[]), enum, const, required,
 * properties, additionalProperties, items, minLength/maxLength,
 * minimum/maximum, minItems/maxItems, pattern, anyOf/oneOf (chi can
 * 1 nhanh hop le).
 */
export function brokerV2ValidateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = '$',
): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== 'object') return errors;

  const type = schema.type;
  if (typeof type === 'string') {
    if (!brokerV2ValueMatchesType(value, type)) {
      errors.push(`${path}: kieu sai — mong doi ${type}, nhan duoc ${describeBrokerV2Value(value)}.`);
      return errors;
    }
  } else if (Array.isArray(type)) {
    if (!type.some((t) => typeof t === 'string' && brokerV2ValueMatchesType(value, t))) {
      errors.push(`${path}: kieu sai — mong doi mot trong [${type.join(', ')}], nhan duoc ${describeBrokerV2Value(value)}.`);
      return errors;
    }
  }

  if (schema.const !== undefined && !deepEqualBrokerV2(value, schema.const)) {
    errors.push(`${path}: phai bang hang so ${JSON.stringify(schema.const)}.`);
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqualBrokerV2(value, e))) {
      errors.push(`${path}: gia tri ${JSON.stringify(value)} khong nam trong enum ${JSON.stringify(schema.enum)}.`);
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: chuoi qua ngan (${value.length} < ${schema.minLength}).`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: chuoi qua dai (${value.length} > ${schema.maxLength}).`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path}: chuoi khong khop pattern ${schema.pattern}.`);
        }
      } catch {
        errors.push(`${path}: pattern khong hop le: ${schema.pattern}.`);
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}.`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}.`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: mang qua it phan tu (${value.length} < ${schema.minItems}).`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: mang qua nhieu phan tu (${value.length} > ${schema.maxItems}).`);
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => {
        errors.push(...brokerV2ValidateAgainstSchema(item, schema.items as Record<string, unknown>, `${path}[${i}]`));
      });
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && (obj[key] === undefined || obj[key] === null)) {
          // null chi chap nhan khi schema cua key cho phep null.
          errors.push(`${path}: thieu truong bat buoc "${key}".`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      const props = schema.properties as Record<string, unknown>;
      for (const [key, sub] of Object.entries(props)) {
        if (obj[key] !== undefined && sub && typeof sub === 'object') {
          errors.push(
            ...brokerV2ValidateAgainstSchema(obj[key], sub as Record<string, unknown>, `${path}.${key}`),
          );
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) errors.push(`${path}: truong thua "${key}" (additionalProperties: false).`);
        }
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            errors.push(
              ...brokerV2ValidateAgainstSchema(
                obj[key],
                schema.additionalProperties as Record<string, unknown>,
                `${path}.${key}`,
              ),
            );
          }
        }
      }
    }
  }

  // anyOf / oneOf: chi can 1 nhanh hop le la du.
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some(
      (sub) =>
        sub && typeof sub === 'object' &&
        brokerV2ValidateAgainstSchema(value, sub as Record<string, unknown>, path).length === 0,
    );
    if (!ok) errors.push(`${path}: khong khop bat ky nhanh anyOf nao.`);
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter(
      (sub) =>
        sub && typeof sub === 'object' &&
        brokerV2ValidateAgainstSchema(value, sub as Record<string, unknown>, path).length === 0,
    ).length;
    if (passing !== 1) errors.push(`${path}: phai khop dung 1 nhanh oneOf (khop ${passing}).`);
  }
  return errors;
}

/** Mo ta ngan kieu cua 1 gia tri (de bao loi). */
export function describeBrokerV2Value(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** So sanh sau 2 gia tri JSON (khong dung cho object lon — du cho enum/const). */
export function deepEqualBrokerV2(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => deepEqualBrokerV2(v, b[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = Object.keys(ao);
    return keys.length === Object.keys(bo).length && keys.every((k) => deepEqualBrokerV2(ao[k], bo[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Chuan hoa + validate 1 tool call
// ---------------------------------------------------------------------------

/**
 * Chuan hoa tool call tho ve dang { name, args }.
 * Chap nhan: OpenAI { function: { name, arguments } }, Ollama /api/chat
 * { function: { name, arguments } }, dang phang { name, arguments },
 * va arguments la chuoi JSON hoac object san.
 */
export function normalizeBrokerV2ToolCall(
  input: InferenceBrokerV2RawToolCallInput | Record<string, unknown>,
): { ok: boolean; call?: InferenceBrokerV2ToolCall; error?: string } {
  const raw = input as Record<string, unknown>;
  // Dang OpenAI / Ollama: { function: { name, arguments } }.
  const fn = raw.function && typeof raw.function === 'object'
    ? (raw.function as Record<string, unknown>)
    : raw;
  const name = fn.name ?? raw.name;
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'tool call khong co ten tool.' };
  }
  const argsRaw = fn.arguments ?? raw.arguments ?? raw.args;
  if (argsRaw === undefined || argsRaw === null) {
    return { ok: false, error: `tool "${name}" khong co arguments.` };
  }
  if (typeof argsRaw === 'object' && !Array.isArray(argsRaw)) {
    return {
      ok: true,
      call: { id: typeof raw.id === 'string' ? raw.id : undefined, name: name.trim(), args: argsRaw as Record<string, unknown> },
    };
  }
  if (typeof argsRaw === 'string') {
    const trimmed = argsRaw.trim();
    if (!trimmed) return { ok: false, error: `tool "${name}" co arguments rong.` };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: `tool "${name}" arguments khong phai object JSON.` };
      }
      return {
        ok: true,
        call: { id: typeof raw.id === 'string' ? raw.id : undefined, name: name.trim(), args: parsed as Record<string, unknown> },
      };
    } catch (err) {
      return { ok: false, error: `tool "${name}" arguments khong parse duoc JSON: ${(err as Error).message}` };
    }
  }
  return { ok: false, error: `tool "${name}" arguments co kieu khong ho tro (${describeBrokerV2Value(argsRaw)}).` };
}

/** Validate 1 tool call: allowlist + schema. */
export function validateBrokerV2ToolCall(
  input: InferenceBrokerV2RawToolCallInput | Record<string, unknown>,
  defs: readonly InferenceBrokerV2ToolDefinition[],
  opts?: { allowlist?: ReadonlySet<string> | readonly string[]; engine?: string },
): InferenceBrokerV2ValidationResult {
  const toolName =
    typeof (input as Record<string, unknown>).name === 'string'
      ? ((input as Record<string, unknown>).name as string)
      : typeof ((input as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name === 'string'
        ? (((input as Record<string, unknown>).function as Record<string, unknown>).name as string)
        : '';
  const normalized = normalizeBrokerV2ToolCall(input);
  if (!normalized.ok || !normalized.call) {
    return { ok: false, toolName, blockedReasons: [normalized.error ?? 'tool call khong hop le.'], warnings: [] };
  }
  const call = normalized.call;
  const allowlist = opts?.allowlist
    ? opts.allowlist instanceof Set
      ? opts.allowlist
      : new Set(opts.allowlist)
    : undefined;
  if (allowlist && !allowlist.has(call.name)) {
    return {
      ok: false,
      toolName: call.name,
      blockedReasons: [`tool "${call.name}" khong nam trong allowlist (chan truoc khi thuc thi).`],
      warnings: [],
    };
  }
  const def = defs.find((d) => d.name === call.name);
  if (!def) {
    return {
      ok: false,
      toolName: call.name,
      blockedReasons: [`tool "${call.name}" khong biet (khong co dinh nghia trong registry) — chan truoc khi thuc thi.`],
      warnings: [],
    };
  }
  if (def.parameters && typeof def.parameters === 'object') {
    const schemaErrors = brokerV2ValidateAgainstSchema(call.args, def.parameters);
    if (schemaErrors.length > 0) {
      return {
        ok: false,
        toolName: call.name,
        blockedReasons: [`tool "${call.name}" sai schema: ${schemaErrors.join(' ')}`],
        warnings: [],
      };
    }
  }
  return { ok: true, call, blockedReasons: [], warnings: [], toolName: call.name };
}

/** Validate 1 loat tool call (vd 1 turn co nhieu call song song). */
export function validateBrokerV2ToolCalls(
  inputs: readonly (InferenceBrokerV2RawToolCallInput | Record<string, unknown>)[],
  defs: readonly InferenceBrokerV2ToolDefinition[],
  opts?: { allowlist?: ReadonlySet<string> | readonly string[]; engine?: string },
): {
  ok: boolean;
  valid: InferenceBrokerV2ToolCall[];
  results: InferenceBrokerV2ValidationResult[];
} {
  const results = inputs.map((i) => validateBrokerV2ToolCall(i, defs, opts));
  const valid = results.filter((r) => r.ok && r.call).map((r) => r.call as InferenceBrokerV2ToolCall);
  return { ok: results.every((r) => r.ok), valid, results };
}

// ---------------------------------------------------------------------------
// Gate: allowlist + retry co gioi han + log cac call bi chan
// ---------------------------------------------------------------------------

/** Thong ke cua gate. */
export interface InferenceBrokerV2GateStats {
  /** Tong so call da qua gate. */
  total: number;
  /** So call duoc phep. */
  allowed: number;
  /** So call bi chan. */
  blocked: number;
  /** So lan retry da dung (do call bi chan). */
  retriesUsed: number;
  /** So tool khac nhau bi chan. */
  blockedTools: string[];
}

/**
 * Gate validate tool call: giu allowlist + dinh nghia tool + log chan
 * + ngan sach retry. Moi broker / voice session nen co 1 gate rieng
 * (de log + retry khong lan sang session khac).
 */
export class InferenceBrokerV2ValidationGate {
  private readonly defs = new Map<string, InferenceBrokerV2ToolDefinition>();
  private readonly allowlist = new Set<string>();
  private readonly blockedEntries: InferenceBrokerV2BlockedLogEntry[] = [];
  private readonly blockedToolCounts = new Map<string, number>();
  private readonly maxRetries: number;
  private readonly nowFn: () => number;
  private seq = 0;
  private total = 0;
  private allowed = 0;
  private blocked = 0;
  private retriesUsed = 0;

  constructor(opts?: {
    defs?: readonly InferenceBrokerV2ToolDefinition[];
    allowlist?: readonly string[];
    maxRetries?: number;
    now?: () => number;
  }) {
    this.maxRetries = opts?.maxRetries ?? BROKER_V2_DEFAULT_MAX_VALIDATION_RETRIES;
    this.nowFn = opts?.now ?? Date.now;
    for (const d of opts?.defs ?? []) this.registerTool(d);
    for (const name of opts?.allowlist ?? []) this.allowlist.add(name);
  }

  /** Dang ky (hoac ghi de) dinh nghia 1 tool — dong thoi them vao allowlist. */
  registerTool(def: InferenceBrokerV2ToolDefinition): void {
    this.defs.set(def.name, { ...def });
    this.allowlist.add(def.name);
  }

  /** Go 1 tool khoi registry + allowlist. */
  unregisterTool(name: string): boolean {
    this.allowlist.delete(name);
    return this.defs.delete(name);
  }

  /** Them 1 tool vao allowlist ma khong can dinh nghia (chi dung khi dinh nghia o noi khac). */
  allowTool(name: string): void {
    this.allowlist.add(name);
  }

  /** Bo 1 tool khoi allowlist (chan ngay ca khi da co dinh nghia). */
  disallowTool(name: string): void {
    this.allowlist.delete(name);
  }

  /** Danh sach tool da dang ky. */
  listTools(): InferenceBrokerV2ToolDefinition[] {
    return [...this.defs.values()].map((d) => ({ ...d }));
  }

  /** So lan retry toi da cho 1 call bi chan. */
  get maxValidationRetries(): number {
    return this.maxRetries;
  }

  /** Validate 1 call qua gate (ghi log neu bi chan). */
  validate(
    input: InferenceBrokerV2RawToolCallInput | Record<string, unknown>,
    engine?: string,
  ): InferenceBrokerV2ValidationResult {
    this.total += 1;
    const result = validateBrokerV2ToolCall(input, this.listTools(), {
      allowlist: this.allowlist,
      engine,
    });
    if (result.ok) {
      this.allowed += 1;
    } else {
      this.blocked += 1;
      this.recordBlocked(result.toolName, result.blockedReasons, engine, input);
    }
    return result;
  }

  /** Validate 1 loat call (dung chung 1 lan dem retry). */
  validateAll(
    inputs: readonly (InferenceBrokerV2RawToolCallInput | Record<string, unknown>)[],
    engine?: string,
  ): {
    ok: boolean;
    valid: InferenceBrokerV2ToolCall[];
    results: InferenceBrokerV2ValidationResult[];
  } {
    const results = inputs.map((i) => this.validate(i, engine));
    const valid = results.filter((r) => r.ok && r.call).map((r) => r.call as InferenceBrokerV2ToolCall);
    return { ok: results.every((r) => r.ok), valid, results };
  }

  /**
   * Con retry khong cho 1 call bi chan. `attempt` = so lan da thu
   * (0 = lan dau). Het ngan sach thi dung — bao loi ro cho agent
   * thay vi retry vo han.
   */
  canRetry(attempt: number): boolean {
    return attempt < this.maxRetries;
  }

  /** Ghi nhan 1 lan retry da dung (goi khi agent gui lai call sau khi sua). */
  noteRetry(): void {
    this.retriesUsed += 1;
  }

  /** Thong ke gate. */
  stats(): InferenceBrokerV2GateStats {
    return {
      total: this.total,
      allowed: this.allowed,
      blocked: this.blocked,
      retriesUsed: this.retriesUsed,
      blockedTools: [...this.blockedToolCounts.keys()].sort(),
    };
  }

  /** Log cac call bi chan (moi nhat cuoi). */
  blockedLog(): InferenceBrokerV2BlockedLogEntry[] {
    return this.blockedEntries.map((e) => ({ ...e, reasons: [...e.reasons] }));
  }

  /** Xoa log chan (giu thong ke tong). */
  clearBlockedLog(): void {
    this.blockedEntries.length = 0;
  }

  private recordBlocked(
    toolName: string,
    reasons: readonly string[],
    engine: string | undefined,
    input: InferenceBrokerV2RawToolCallInput | Record<string, unknown>,
  ): void {
    this.seq += 1;
    const rawArgs = (input as Record<string, unknown>).arguments ??
      ((input as Record<string, unknown>).function as Record<string, unknown> | undefined)?.arguments;
    const argsLength =
      typeof rawArgs === 'string' ? rawArgs.length : rawArgs ? JSON.stringify(rawArgs).length : 0;
    this.blockedEntries.push({
      seq: this.seq,
      toolName,
      reasons: [...reasons],
      engine,
      at: this.nowFn(),
      argsLength,
    });
    if (this.blockedEntries.length > BROKER_V2_VALIDATION_LOG_MAX) {
      this.blockedEntries.splice(0, this.blockedEntries.length - BROKER_V2_VALIDATION_LOG_MAX);
    }
    if (toolName) {
      this.blockedToolCounts.set(toolName, (this.blockedToolCounts.get(toolName) ?? 0) + 1);
    }
  }

  /** Tom tat dang markdown. */
  markdown(): string {
    const s = this.stats();
    const lines = [
      '# Inference broker v2 — validation gate',
      '',
      `- Tong call: ${s.total}; cho phep: ${s.allowed}; chan: ${s.blocked}; retry da dung: ${s.retriesUsed}/${this.maxRetries} moi call.`,
      `- Tool bi chan: ${s.blockedTools.length > 0 ? s.blockedTools.join(', ') : 'khong co'}.`,
    ];
    const recent = this.blockedEntries.slice(-5);
    if (recent.length > 0) {
      lines.push('', '## 5 call bi chan gan nhat');
      for (const e of recent) {
        lines.push(`- #${e.seq} ${e.toolName || '(khong ten)'}: ${e.reasons.join(' ')}`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * Xay thong diep sua loi de gui lai cho model khi tool call bi chan
 * (de model tu sua arguments trong lan retry — khong tu sua ho model).
 */
export function brokerV2RepairMessage(result: InferenceBrokerV2ValidationResult): string {
  if (result.ok) return '';
  return (
    `Tool call "${result.toolName}" bi chan truoc khi thuc thi: ${result.blockedReasons.join(' ')} ` +
    'Hay goi lai dung ten tool va dung schema (required, kieu, enum). Khong goi tool khac thay the.'
  );
}
