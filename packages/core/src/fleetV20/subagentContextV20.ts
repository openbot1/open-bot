/**
 * Context cô lập cho subagent chuyên biệt v20 (v1.33, Đội T6).
 *
 * Tầng dưới của `specializedSubagentsV20.ts`: spec trả lời "spawn loại
 * nào, với tool gì", module này trả lời "con chạy trong context nào và
 * cha nhận lại được gì" — hai câu mà spec một mình không trả lời được.
 *
 * Nguyên tắc cô lập (isolation), học ý tưởng từ survey v133 — subagent
 * chuyên biệt chạy trong context riêng, không thấy transcript của cha:
 *
 * 1. CON CHỈ THẤY NHỮNG GÌ CHA GIAO: system prompt của loại + task +
 *    shared facts mà cha liệt kê tường minh. Transcript cha, tool
 *    result của cha, context của anh em cùng sóng — con không thấy.
 *    `buildChildPrompt` là cửa duy nhất đưa thông tin vào context con;
 *    mọi thứ khác phải đi qua `sharedFacts` có ghi rõ nguồn.
 * 2. CHA CHỈ NHẬN LẠI HANDOFF ĐÃ VALIDATE: con trả output thô → cha
 *    validate bằng `validateExploreV20Output` / `validatePlanV20Output`
 *    / `validateVerifyV20Verdict` rồi mới nhận handoff envelope
 *    (findings/plan/verdict + token usage). Transcript thô của con
 *    KHÔNG bao giờ đổ ngược vào context cha — cha chỉ nhận kết quả
 *    có cấu trúc, tránh context cha phình vì lời model con.
 * 3. NGÂN SÁCH RÕ RÀNG, FAIL-CLOSED: mỗi context có budget tin nhắn /
 *    ký tự / thời gian theo loại (explore rẻ nên budget nhỏ nhất).
 *    Vượt budget → context bị seal (không nhận thêm message), con phải
 *    kết thúc bằng output đã có; `appendMessage` trả về số message đã
 *    drop để cha biết con đã mất thông tin gì.
 * 4. SONG SONG AN TOÀN: mỗi con có context id riêng; `SubagentV20ContextPool`
 *    cấp phát tối đa `maxParallel` context cùng lúc (mặc định 4, khớp
 *    `SPECIALIZED_V20_MAX_PARALLEL_DEFAULT`) và từ chối cấp thêm khi
 *    đầy — thay vì để 12 con cùng chạy rồi hết RAM.
 *
 * Module này là tầng pure: không gọi provider, không đọc file, không
 * spawn thật — chỉ xây/quản lý cấu trúc context để runner thực thi.
 */

import {
  SPECIALIZED_V20_DEFAULT_TIER,
  SPECIALIZED_V20_MAX_PARALLEL_DEFAULT,
  getSpecializedV20Spec,
  type SpecializedV20Kind,
  type SpecializedV20ModelTier,
} from './specializedSubagentsV20';

// ---------------------------------------------------------------------------
// Budget theo loại
// ---------------------------------------------------------------------------

/** Ngân sách context của một subagent chuyên biệt v20. */
export interface SubagentV20ContextBudget {
  /** Số message tối đa giữ trong context (vượt thì drop message cũ nhất, trừ system). */
  maxMessages: number;
  /** Tổng ký tự tối đa của toàn bộ message trong context. */
  maxChars: number;
  /** Ký tự tối đa của một message (message dài hơn bị cắt, có đánh dấu). */
  maxCharsPerMessage: number;
  /** Số shared fact tối đa cha được đưa vào. */
  maxSharedFacts: number;
  /** Thời gian sống tối đa của context (ms) — quá hạn thì seal. */
  ttlMs: number;
}

/** Budget mặc định từng loại (explore rẻ → budget nhỏ nhất). */
export const SUBAGENT_V20_CONTEXT_BUDGETS: Record<SpecializedV20Kind, SubagentV20ContextBudget> = {
  explore: { maxMessages: 24, maxChars: 48_000, maxCharsPerMessage: 8_000, maxSharedFacts: 10, ttlMs: 120_000 },
  plan: { maxMessages: 32, maxChars: 80_000, maxCharsPerMessage: 12_000, maxSharedFacts: 16, ttlMs: 180_000 },
  verify: { maxMessages: 40, maxChars: 96_000, maxCharsPerMessage: 16_000, maxSharedFacts: 12, ttlMs: 240_000 },
};

/** Lấy budget theo loại; cho phép override từng trường (override chỉ thu hẹp được nêu rõ ở dưới). */
export function getSubagentV20ContextBudget(
  kind: SpecializedV20Kind,
  overrides: Partial<SubagentV20ContextBudget> = {},
): SubagentV20ContextBudget {
  return { ...SUBAGENT_V20_CONTEXT_BUDGETS[kind], ...overrides };
}

// ---------------------------------------------------------------------------
// Message + shared fact
// ---------------------------------------------------------------------------

export type SubagentV20MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Một message trong context con (đã cắt ngắn nếu vượt giới hạn). */
export interface SubagentV20Message {
  role: SubagentV20MessageRole;
  content: string;
  /** true = content đã bị cắt vì vượt maxCharsPerMessage. */
  truncated: boolean;
  /** Thời điểm đưa vào context (ms epoch). */
  at: number;
}

/** Một sự thật cha chia sẻ tường minh cho con — có nguồn, không có nguồn thì không đưa vào. */
export interface SubagentV20SharedFact {
  /** Nội dung sự thật, vd `Repo dùng pnpm, entry là apps/desktop`. */
  fact: string;
  /** Nguồn, vd `packages/core/src/fleetV20/index.ts:1` hoặc URL. */
  source: string;
}

// ---------------------------------------------------------------------------
// Context con
// ---------------------------------------------------------------------------

/** Context cô lập của một subagent chuyên biệt v20 đang chạy. */
export interface SubagentV20Context {
  /** Id ổn định của context (duy nhất trong pool). */
  id: string;
  kind: SpecializedV20Kind;
  /** Id task/bot cha giao — để truy vết, không phải để con đọc transcript cha. */
  parentTaskId: string;
  /** Tier model con chạy (từ spec, có thể override khi tạo). */
  modelTier: SpecializedV20ModelTier;
  budget: SubagentV20ContextBudget;
  /** Message trong context con — message [0] luôn là system prompt của loại. */
  messages: SubagentV20Message[];
  /** Shared facts cha đưa vào lúc tạo (bản sao — sửa sau không ảnh hưởng context đã tạo). */
  sharedFacts: SubagentV20SharedFact[];
  /** Số message đã bị drop vì vượt budget (cha dùng để biết con mất thông tin). */
  droppedMessages: number;
  /** Số ký tự đã bị cắt khỏi message vì vượt maxCharsPerMessage. */
  truncatedChars: number;
  createdAt: number;
  /** true = context đã seal (hết hạn / vượt budget / con đã trả output) — không nhận thêm message. */
  sealed: boolean;
  /** Lý do seal (nếu có). */
  sealReason?: string;
}

export interface CreateSubagentV20ContextOptions {
  /** Id context — mặc định sinh từ kind + timestamp + random. */
  id?: string;
  modelTier?: SpecializedV20ModelTier;
  budgetOverrides?: Partial<SubagentV20ContextBudget>;
  /** Sự thật cha chia sẻ tường minh (tối đa budget.maxSharedFacts). */
  sharedFacts?: SubagentV20SharedFact[];
  /** Thời điểm tạo (ms epoch) — test truyền vào để kiểm tra TTL. */
  now?: number;
}

const CONTEXT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

function randomContextSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Tạo context con mới: message đầu tiên luôn là system prompt của loại
 * (lấy từ spec — một nguồn sự thật duy nhất, không viết prompt riêng
 * ở đây để khỏi lệch với spec). Task của cha là message `user` thứ hai.
 * Shared fact không nguồn / vượt số lượng → lỗi rõ, không lặng lẽ bỏ.
 */
export function createSubagentV20Context(
  kind: SpecializedV20Kind,
  parentTaskId: string,
  task: string,
  options: CreateSubagentV20ContextOptions = {},
): SubagentV20Context {
  const spec = getSpecializedV20Spec(kind);
  const now = options.now ?? Date.now();
  const budget = getSubagentV20ContextBudget(kind, options.budgetOverrides ?? {});
  if (typeof parentTaskId !== 'string' || parentTaskId.trim().length === 0) {
    throw new Error('Tạo context subagent v20 cần parentTaskId không rỗng.');
  }
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new Error(`Tạo context subagent ${kind} cần task không rỗng — con không thể chạy khi không biết phải làm gì.`);
  }
  const id = options.id ?? `${kind}-${now.toString(36)}-${randomContextSuffix()}`;
  if (!CONTEXT_ID_RE.test(id)) {
    throw new Error(`Id context subagent v20 không hợp lệ: ${JSON.stringify(id)} — dùng chữ thường, số, gạch ngang, bắt đầu bằng chữ cái.`);
  }
  const sharedFacts = [...(options.sharedFacts ?? [])];
  const factErrors: string[] = [];
  if (sharedFacts.length > budget.maxSharedFacts) {
    factErrors.push(`Shared facts có ${sharedFacts.length}, vượt tối đa ${budget.maxSharedFacts} của loại ${kind} — rút gọn trước khi spawn.`);
  }
  sharedFacts.forEach((f, i) => {
    if (typeof f.fact !== 'string' || f.fact.trim().length === 0) factErrors.push(`Shared fact #${i + 1}: "fact" không được rỗng.`);
    if (typeof f.source !== 'string' || f.source.trim().length === 0) {
      factErrors.push(`Shared fact #${i + 1}: cần "source" — fact không nguồn thì con không kiểm chứng được, không đưa vào context.`);
    }
  });
  if (factErrors.length > 0) {
    throw new Error(`Shared facts cho context subagent ${kind} không hợp lệ:\n- ${factErrors.join('\n- ')}`);
  }
  const systemContent =
    spec.systemPrompt +
    `\n\nNgân sách của bạn: tối đa ${budget.maxMessages} message, ${budget.maxChars} ký tự. ` +
    `Trả về đúng schema JSON đã giao — cha chỉ nhận output đúng schema, output sai schema sẽ bị loại.`;
  const messages: SubagentV20Message[] = [
    { role: 'system', content: systemContent, truncated: false, at: now },
    { role: 'user', content: task.trim(), truncated: false, at: now },
  ];
  if (sharedFacts.length > 0) {
    const factsText = sharedFacts.map((f) => `- ${f.fact} (nguồn: ${f.source})`).join('\n');
    messages.push({
      role: 'user',
      content: `Sự thật cha đã xác minh, dùng làm điểm xuất phát (vẫn phải tự kiểm chứng khi cần):\n${factsText}`,
      truncated: false,
      at: now,
    });
  }
  return {
    id,
    kind,
    parentTaskId,
    modelTier: options.modelTier ?? spec.modelTier,
    budget,
    messages,
    sharedFacts,
    droppedMessages: 0,
    truncatedChars: 0,
    createdAt: now,
    sealed: false,
  };
}

/** Tổng ký tự hiện tại trong context. */
export function subagentV20ContextChars(ctx: SubagentV20Context): number {
  return ctx.messages.reduce((sum, m) => sum + m.content.length, 0);
}

/** true khi context đã quá TTL (tính theo `now`, mặc định Date.now()). */
export function subagentV20ContextExpired(ctx: SubagentV20Context, now: number = Date.now()): boolean {
  return now - ctx.createdAt > ctx.budget.ttlMs;
}

export interface AppendSubagentV20MessageResult {
  /** Context sau khi append (bản sao mới — context gốc không bị sửa). */
  context: SubagentV20Context;
  /** true = message đã được thêm (có thể đã bị cắt ngắn). */
  appended: boolean;
  /** Lý do từ chối (context sealed / đã hết hạn) — rỗng khi appended. */
  reason?: string;
  /** Số message cũ đã drop trong lần append này (do vượt budget). */
  droppedThisAppend: number;
}

/**
 * Thêm message vào context con (fail-closed): context sealed hoặc hết
 * TTL → từ chối, trả reason, không sửa gì. Message vượt
 * maxCharsPerMessage → cắt + đánh dấu `truncated` (con vẫn thấy phần
 * đầu, cha biết qua `truncatedChars`). Vượt maxMessages/maxChars →
 * drop message cũ nhất KHÔNG PHẢI system (system prompt của loại
 * không bao giờ bị drop — drop nó là mất luật chơi của con).
 */
export function appendSubagentV20Message(
  ctx: SubagentV20Context,
  role: SubagentV20MessageRole,
  content: string,
  now: number = Date.now(),
): AppendSubagentV20MessageResult {
  if (ctx.sealed) {
    return { context: ctx, appended: false, reason: `Context ${ctx.id} đã seal (${ctx.sealReason ?? 'không rõ lý do'}) — không nhận thêm message.`, droppedThisAppend: 0 };
  }
  if (subagentV20ContextExpired(ctx, now)) {
    const sealed = sealSubagentV20Context(ctx, 'hết TTL', now);
    return { context: sealed, appended: false, reason: `Context ${ctx.id} đã hết TTL ${ctx.budget.ttlMs}ms — seal thay vì cho chạy tiếp.`, droppedThisAppend: 0 };
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { context: ctx, appended: false, reason: 'Message rỗng — không đưa vào context.', droppedThisAppend: 0 };
  }
  let truncated = false;
  let truncatedChars = 0;
  let text = content;
  if (text.length > ctx.budget.maxCharsPerMessage) {
    truncatedChars = text.length - ctx.budget.maxCharsPerMessage;
    text = text.slice(0, ctx.budget.maxCharsPerMessage) + '\n…[đã cắt vì vượt giới hạn message]';
    truncated = true;
  }
  const next: SubagentV20Context = {
    ...ctx,
    messages: [...ctx.messages, { role, content: text, truncated, at: now }],
    truncatedChars: ctx.truncatedChars + truncatedChars,
  };
  let droppedThisAppend = 0;
  // Drop message cũ nhất (bỏ qua message system ở [0]) cho tới khi vừa budget.
  while (
    (next.messages.length > next.budget.maxMessages ||
      subagentV20ContextChars(next) > next.budget.maxChars) &&
    next.messages.length > 1
  ) {
    const dropIdx = next.messages.findIndex((m, i) => i !== 0);
    if (dropIdx < 0) break;
    next.messages.splice(dropIdx, 1);
    next.droppedMessages += 1;
    droppedThisAppend += 1;
  }
  return { context: next, appended: true, droppedThisAppend };
}

/** Seal context (bản sao mới): sau seal không nhận thêm message. */
export function sealSubagentV20Context(
  ctx: SubagentV20Context,
  reason: string,
  now: number = Date.now(),
): SubagentV20Context {
  void now;
  if (ctx.sealed) return ctx;
  return { ...ctx, sealed: true, sealReason: reason };
}

// ---------------------------------------------------------------------------
// Prompt con + handoff về cha (cô lập 2 chiều)
// ---------------------------------------------------------------------------

/**
 * Prompt đầy đủ đưa cho model con: system prompt của loại + task +
 * shared facts — KHÔNG BAO GIỜ kèm transcript cha hay context anh em.
 * Hàm này là cửa duy nhất: nếu thông tin nào không đi qua đây thì con
 * không thấy, theo thiết kế.
 */
export function buildChildPrompt(ctx: SubagentV20Context): string {
  const spec = getSpecializedV20Spec(ctx.kind);
  const parts: string[] = [spec.systemPrompt, `\nNhiệm vụ:\n${ctx.messages[1]?.content ?? ''}`];
  if (ctx.sharedFacts.length > 0) {
    parts.push(
      '\nSự thật cha đã xác minh (điểm xuất phát, vẫn tự kiểm chứng khi cần):\n' +
        ctx.sharedFacts.map((f) => `- ${f.fact} (nguồn: ${f.source})`).join('\n'),
    );
  }
  parts.push(
    `\nOutput schema (bắt buộc, JSON):\n${spec.outputSchema}\n` +
      `Model tier của bạn: ${ctx.modelTier} (mặc định loại ${ctx.kind}: ${SPECIALIZED_V20_DEFAULT_TIER[ctx.kind]}). ` +
      `Bạn là lá của cây spawn (leafOnly) — không spawn subagent con.`,
  );
  return parts.join('\n');
}

/**
 * Kiểm tra cô lập của một context: trả về lỗi nếu context chứa thứ
 * không được phép — system prompt không phải của loại, message user
 * lạ ngoài task + shared facts, hoặc message tool không rõ nguồn.
 * Runner gọi trước khi spawn; lỗi = không spawn.
 */
export function checkSubagentV20ContextIsolation(ctx: SubagentV20Context, task: string): string[] {
  const errors: string[] = [];
  const spec = getSpecializedV20Spec(ctx.kind);
  const system = ctx.messages[0];
  if (!system || system.role !== 'system' || !system.content.startsWith(spec.systemPrompt)) {
    errors.push(`Context ${ctx.id}: message system đầu tiên phải là system prompt của loại ${ctx.kind} — có thể context đã bị sửa tay.`);
  }
  const userMessages = ctx.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0 || userMessages[0]?.content !== task.trim()) {
    errors.push(`Context ${ctx.id}: message user đầu tiên phải đúng task cha giao — task đã bị thay đổi sau khi tạo.`);
  }
  if (userMessages.length > 2) {
    errors.push(`Context ${ctx.id}: có ${userMessages.length} message user, vượt tối đa 2 (task + shared facts) — có thông tin lạ lọt vào context con.`);
  }
  if (ctx.messages.some((m) => m.role === 'tool' && m.content.includes('parent-transcript'))) {
    errors.push(`Context ${ctx.id}: chứa tool message gắn transcript cha — rò rỉ context cha sang con.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Handoff: con trả về cha (chỉ kết quả đã validate)
// ---------------------------------------------------------------------------

/** Envelope handoff từ con về cha — cha chỉ nhận cái này, không nhận transcript thô. */
export interface SubagentV20Handoff {
  contextId: string;
  kind: SpecializedV20Kind;
  parentTaskId: string;
  /** Output đã validate (findings / plan / verdict) — dạng JSON thô. */
  output: unknown;
  /** true = output đã qua validator của loại và hợp lệ. */
  outputValid: boolean;
  /** Lỗi validator (nếu outputValid = false) — cha quyết định retry hay bỏ. */
  validationErrors: string[];
  /** Thống kê usage để cha tính cost + biết con đã mất bao nhiêu thông tin. */
  usage: {
    messages: number;
    chars: number;
    droppedMessages: number;
    truncatedChars: number;
    durationMs: number;
  };
  /** true = con tự kết thúc đúng hạn (không phải bị seal vì hết TTL/budget). */
  finishedCleanly: boolean;
}

/** Build handoff từ context đã seal + output thô + kết quả validator của loại. */
export function buildSubagentV20Handoff(
  ctx: SubagentV20Context,
  output: unknown,
  validationErrors: readonly string[],
  durationMs: number,
): SubagentV20Handoff {
  return {
    contextId: ctx.id,
    kind: ctx.kind,
    parentTaskId: ctx.parentTaskId,
    output,
    outputValid: validationErrors.length === 0,
    validationErrors: [...validationErrors],
    usage: {
      messages: ctx.messages.length,
      chars: subagentV20ContextChars(ctx),
      droppedMessages: ctx.droppedMessages,
      truncatedChars: ctx.truncatedChars,
      durationMs,
    },
    finishedCleanly: ctx.sealed && ctx.sealReason === 'con đã trả output',
  };
}

/** Validate handoff envelope (cha kiểm tra trước khi dùng output con). */
export function validateSubagentV20Handoff(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Handoff subagent v20 phải là một object.'];
  }
  const h = raw as Record<string, unknown>;
  if (typeof h['contextId'] !== 'string' || (h['contextId'] as string).trim().length === 0) {
    errors.push('Handoff cần "contextId" không rỗng.');
  }
  if (!['explore', 'plan', 'verify'].includes(String(h['kind']))) {
    errors.push('Handoff: "kind" phải là explore/plan/verify.');
  }
  if (typeof h['parentTaskId'] !== 'string' || (h['parentTaskId'] as string).trim().length === 0) {
    errors.push('Handoff cần "parentTaskId" không rỗng — không biết trả kết quả cho task nào.');
  }
  if (h['output'] === undefined) errors.push('Handoff cần "output" (có thể là null khi con không trả được gì, nhưng phải có trường).');
  if (typeof h['outputValid'] !== 'boolean') errors.push('Handoff: "outputValid" phải là boolean.');
  if (!Array.isArray(h['validationErrors'])) errors.push('Handoff: "validationErrors" phải là mảng.');
  if (h['outputValid'] === false && Array.isArray(h['validationErrors']) && h['validationErrors'].length === 0) {
    errors.push('Handoff mâu thuẫn: outputValid=false nhưng không có validationErrors nào — cha không biết vì sao output bị loại.');
  }
  const usage = h['usage'] as Record<string, unknown> | undefined;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    errors.push('Handoff cần "usage" là object { messages, chars, droppedMessages, truncatedChars, durationMs }.');
  } else {
    for (const field of ['messages', 'chars', 'droppedMessages', 'truncatedChars', 'durationMs'] as const) {
      if (typeof usage[field] !== 'number' || (usage[field] as number) < 0) {
        errors.push(`Handoff usage: "${field}" phải là số >= 0.`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Pool: cấp phát context song song có giới hạn
// ---------------------------------------------------------------------------

/** Pool context subagent v20 — giới hạn số con chạy song song. */
export interface SubagentV20ContextPool {
  maxParallel: number;
  /** Context đang chạy (chưa release). */
  active: SubagentV20Context[];
  /** Tổng số context đã cấp từ đầu (kể cả đã release). */
  totalAllocated: number;
  /** Số lần bị từ chối vì pool đầy (để cha biết sóng bị nghẽn). */
  rejectedFull: number;
}

export function createSubagentV20ContextPool(
  maxParallel: number = SPECIALIZED_V20_MAX_PARALLEL_DEFAULT,
): SubagentV20ContextPool {
  if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
    throw new Error(`Pool context subagent v20 cần maxParallel là số nguyên > 0 (nhận ${String(maxParallel)}).`);
  }
  return { maxParallel, active: [], totalAllocated: 0, rejectedFull: 0 };
}

export interface AllocateSubagentV20ContextResult {
  pool: SubagentV20ContextPool;
  context: SubagentV20Context | null;
  /** Lý do từ chối khi context = null (pool đầy). */
  reason?: string;
}

/**
 * Cấp context vào pool: pool đầy → trả context null + reason, KHÔNG
 * tạo context thừa (fail-closed thay vì cho chạy quá giới hạn rồi hết
 * tài nguyên). Id trùng với context đang chạy → từ chối (tránh 2 con
 * dùng chung một context).
 */
export function allocateSubagentV20Context(
  pool: SubagentV20ContextPool,
  kind: SpecializedV20Kind,
  parentTaskId: string,
  task: string,
  options: CreateSubagentV20ContextOptions = {},
): AllocateSubagentV20ContextResult {
  if (pool.active.length >= pool.maxParallel) {
    const next: SubagentV20ContextPool = { ...pool, rejectedFull: pool.rejectedFull + 1 };
    return {
      pool: next,
      context: null,
      reason: `Pool context subagent v20 đã đầy (${pool.active.length}/${pool.maxParallel} đang chạy) — chờ một con xong rồi spawn tiếp.`,
    };
  }
  const context = createSubagentV20Context(kind, parentTaskId, task, options);
  if (pool.active.some((c) => c.id === context.id)) {
    const next: SubagentV20ContextPool = { ...pool, rejectedFull: pool.rejectedFull + 1 };
    return { pool: next, context: null, reason: `Context id "${context.id}" đã có trong pool — id trùng, không cấp trùng.`, };
  }
  const next: SubagentV20ContextPool = {
    ...pool,
    active: [...pool.active, context],
    totalAllocated: pool.totalAllocated + 1,
  };
  return { pool: next, context };
}

/** Release context khỏi pool sau khi con xong (seal trước khi release). */
export function releaseSubagentV20Context(
  pool: SubagentV20ContextPool,
  contextId: string,
  sealReason = 'con đã trả output',
): SubagentV20ContextPool {
  const target = pool.active.find((c) => c.id === contextId);
  if (!target) return pool;
  const sealed = sealSubagentV20Context(target, sealReason);
  void sealed;
  return { ...pool, active: pool.active.filter((c) => c.id !== contextId) };
}

/** Tóm tắt pool để UI/panel hiện trạng thái sóng subagent. */
export function summarizeSubagentV20Pool(pool: SubagentV20ContextPool): {
  active: number;
  maxParallel: number;
  totalAllocated: number;
  rejectedFull: number;
  byKind: Record<string, number>;
  summary: string;
} {
  const byKind: Record<string, number> = {};
  for (const ctx of pool.active) byKind[ctx.kind] = (byKind[ctx.kind] ?? 0) + 1;
  return {
    active: pool.active.length,
    maxParallel: pool.maxParallel,
    totalAllocated: pool.totalAllocated,
    rejectedFull: pool.rejectedFull,
    byKind,
    summary:
      `Subagent v20: ${pool.active.length}/${pool.maxParallel} đang chạy` +
      (pool.rejectedFull > 0 ? `, ${pool.rejectedFull} lần bị từ chối vì pool đầy` : '') +
      (pool.active.length > 0
        ? ` (${Object.entries(byKind).map(([k, n]) => `${k}×${n}`).join(', ')})`
        : ''),
  };
}
