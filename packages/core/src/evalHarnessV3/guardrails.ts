/**
 * Eval Harness v3 — guardrails kiểu OpenAI Agents SDK (v1.35, Đội T4).
 *
 * Ý tưởng học từ Agents SDK: guardrail là một hàm kiểm tra chạy cùng
 * với agent run, ở 3 giai đoạn — input (trước khi agent chạy), output
 * (sau khi agent trả kết quả), tool (mỗi tool call agent muốn gọi).
 * KHÔNG copy code/text/tài sản của bất kỳ repo nào.
 *
 * - Mỗi guardrail trả về trip (vi phạm) hay qua. Trip có severity:
 *   `block` (tripwire — dừng trial ngay, status `guardrail-trip`)
 *   hay `warn` (ghi log/trace, trial vẫn chạy tiếp).
 * - Chế độ chạy: `parallel` (chạy hết guardrail của một giai đoạn,
 *   gom toàn bộ trip) hay `sequential` (dừng ở trip block đầu tiên —
 *   rẻ hơn, ít noise hơn).
 * - Guardrail là pure function trên string/object — không gọi model,
 *   không gọi mạng, chạy nhanh và xác định (deterministic): cùng một
 *   input luôn cho cùng một kết quả, để eval không flaky vì guardrail.
 * - Nội dung nhạy cảm KHÔNG được đưa vào `reason`/`detail` — chỉ ghi
 *   mẫu nào khớp / tool nào / giới hạn nào, để trace và report an toàn.
 *
 * Guardrail mặc định (luôn có, task có thể thêm mẫu riêng qua
 * `guardrails.extraInputPatterns` / `extraOutputPatterns`):
 * - input-prompt-injection: đề bài/instruction chứa câu lệnh ép agent
 *   bỏ qua chỉ dẫn, tiết lộ system prompt, hoặc chạy lệnh ngoài task.
 * - input-pii: instruction chứa email/số điện thoại/API key thật.
 * - input-forbidden-command: instruction chứa lệnh phá hoại (rm -rf /...).
 * - output-secret-leak: output agent chứa secret (sk-..., ghp_...,
 *   AKIA..., private key) — rò rỉ credential.
 * - output-forbidden-command: output agent chứa lệnh phá hoại.
 * - output-pii: output agent chứa email/số điện thoại.
 * - tool-denied: agent gọi tool bị cấm (theo task.guardrails).
 * - tool-not-allowed: agent gọi tool ngoài danh sách cho phép.
 * - tool-arg-forbidden-command: tham số tool call chứa lệnh phá hoại.
 * - tool-call-limit: agent vượt số tool call tối đa của trial.
 */

import {
  EVAL_HARNESS_V3_FORBIDDEN_COMMAND_PATTERNS,
  type EvalHarnessV3GuardrailCheck,
  type EvalHarnessV3GuardrailResult,
  type EvalHarnessV3GuardrailStage,
  type EvalHarnessV3GuardrailTrip,
  type EvalHarnessV3Task,
  type EvalHarnessV3TaskGuardrails,
} from './types.js';

/** Một guardrail đơn: hàm kiểm tra thuần, xác định. */
export interface EvalHarnessV3Guardrail {
  /** Id ổn định, vd `input-prompt-injection`. */
  id: string;
  stage: EvalHarnessV3GuardrailStage;
  /** Mô tả ngắn guardrail làm gì (hiện trong UI/list). */
  description: string;
  severity: 'block' | 'warn';
  /**
   * Kiểm tra một giá trị ở giai đoạn này. `context` mang thêm dữ liệu
   * của trial (task, số tool call đã dùng, tên tool...). Trả về
   * `{ tripped, reason, detail? }` — không throw.
   */
  check: (
    value: unknown,
    context: EvalHarnessV3GuardrailContext,
  ) => EvalHarnessV3GuardrailCheckOutcome;
}

/** Kết quả thô của một hàm check guardrail. */
export interface EvalHarnessV3GuardrailCheckOutcome {
  tripped: boolean;
  reason: string;
  detail?: string;
}

/** Context đưa vào hàm check guardrail. */
export interface EvalHarnessV3GuardrailContext {
  task: EvalHarnessV3Task;
  /** Số tool call agent đã dùng tới thời điểm check. */
  toolCallCount: number;
  /** Tên tool đang được check (chỉ giai đoạn tool). */
  toolName?: string;
  /** Tham số tool call (chỉ giai đoạn tool). */
  toolArgs?: Record<string, unknown>;
}

/** Lỗi tripwire: guardrail block đã dừng run. Mang theo các trip. */
export class EvalHarnessV3TripwireError extends Error {
  readonly trips: EvalHarnessV3GuardrailTrip[];
  constructor(trips: EvalHarnessV3GuardrailTrip[]) {
    super(`Guardrail tripwire: ${trips.map((t) => `${t.guardrailId} (${t.reason})`).join('; ')}`);
    this.name = 'EvalHarnessV3TripwireError';
    this.trips = trips;
  }
}

// ---------------------------------------------------------------------------
// Mẫu mặc định
// ---------------------------------------------------------------------------

/** Mẫu prompt injection trong input (regex, case-insensitive). */
export const EVAL_HARNESS_V3_INPUT_INJECTION_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, label: 'ignore previous instructions' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i, label: 'disregard previous instructions' },
  { pattern: /you\s+are\s+now\s+(a|an|in)\s+/i, label: 'you are now ... (role override)' },
  { pattern: /reveal\s+(your\s+)?(system\s+prompt|instructions|secret)/i, label: 'reveal system prompt/secret' },
  { pattern: /bypass\s+(the\s+)?(guardrail|filter|safety|restriction)/i, label: 'bypass guardrail/filter' },
  { pattern: /jailbreak/i, label: 'jailbreak' },
  { pattern: /do\s+not\s+follow\s+(the\s+)?(task|instructions)/i, label: 'do not follow instructions' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\s+/i, label: 'pretend you are ...' },
];

/** Mẫu PII trong text (email / số điện thoại / số thẻ). */
export const EVAL_HARNESS_V3_PII_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, label: 'email address' },
  { pattern: /\+?\d[\d\s().-]{8,}\d/, label: 'phone number' },
  { pattern: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, label: 'card-like number' },
];

/** Mẫu secret rò rỉ trong output (chỉ nhận dạng, không ghi giá trị). */
export const EVAL_HARNESS_V3_SECRET_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /sk-[A-Za-z0-9_-]{16,}/, label: 'sk- API key' },
  { pattern: /ghp_[A-Za-z0-9]{20,}/, label: 'GitHub personal token' },
  { pattern: /gho_[A-Za-z0-9]{20,}/, label: 'GitHub OAuth token' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: 'private key block' },
  { pattern: /AIza[0-9A-Za-z_-]{20,}/, label: 'Google API key' },
  { pattern: /hf_[A-Za-z0-9]{20,}/, label: 'Hugging Face token' },
];

/** Tìm mẫu đầu tiên khớp trong text (trả về label, không trả về nội dung khớp). */
function firstMatchLabel(
  text: string,
  patterns: readonly { pattern: RegExp; label: string }[],
): string | null {
  for (const { pattern, label } of patterns) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/** Tìm mẫu phá hoại trong text (dùng chung FORBIDDEN_COMMAND_PATTERNS). */
function forbiddenCommandLabel(text: string): string | null {
  for (const { pattern, reason } of EVAL_HARNESS_V3_FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/** Compile danh sách regex string của task thành pattern (bỏ qua cái lỗi — loader đã chặn). */
function compileExtraPatterns(patterns: string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      // Loader đã validate — tới đây thì bỏ qua pattern lỗi.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guardrail mặc định
// ---------------------------------------------------------------------------

function makeGuardrail(
  id: string,
  stage: EvalHarnessV3GuardrailStage,
  description: string,
  severity: 'block' | 'warn',
  check: EvalHarnessV3Guardrail['check'],
): EvalHarnessV3Guardrail {
  return { id, stage, description, severity, check };
}

/**
 * Bộ guardrail mặc định cho một task (cộng thêm mẫu riêng của task).
 * Trả về guardrail theo đúng thứ tự chạy: input → output → tool.
 */
export function defaultEvalHarnessV3Guardrails(task: EvalHarnessV3Task): EvalHarnessV3Guardrail[] {
  const config: EvalHarnessV3TaskGuardrails = task.guardrails ?? {};
  const extraInput = compileExtraPatterns(config.extraInputPatterns);
  const extraOutput = compileExtraPatterns(config.extraOutputPatterns);
  const maxToolCalls = config.maxToolCalls ?? 100;
  const deniedTools = new Set((config.deniedTools ?? []).map((t) => t.toLowerCase()));
  const allowedTools =
    config.allowedTools !== undefined
      ? new Set(config.allowedTools.map((t) => t.toLowerCase()))
      : undefined;

  return [
    makeGuardrail(
      'input-prompt-injection',
      'input',
      'Chặn instruction chứa câu lệnh ép agent bỏ qua chỉ dẫn / tiết lộ system prompt.',
      'block',
      (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        const label = firstMatchLabel(text, EVAL_HARNESS_V3_INPUT_INJECTION_PATTERNS);
        if (label !== null) return { tripped: true, reason: 'Instruction chứa mẫu prompt injection.', detail: `mẫu khớp: ${label}` };
        for (const re of extraInput) {
          if (re.test(text)) return { tripped: true, reason: 'Instruction khớp mẫu cấm riêng của task.', detail: `mẫu: ${re.source.slice(0, 80)}` };
        }
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'input-pii',
      'input',
      'Cảnh báo khi instruction chứa PII (email/số điện thoại/số thẻ).',
      'warn',
      (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        const label = firstMatchLabel(text, EVAL_HARNESS_V3_PII_PATTERNS);
        if (label !== null) return { tripped: true, reason: 'Instruction chứa PII.', detail: `loại: ${label}` };
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'input-forbidden-command',
      'input',
      'Chặn instruction chứa lệnh phá hoại (rm -rf /, format ổ, chạy code từ mạng...).',
      'block',
      (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        const label = forbiddenCommandLabel(text);
        if (label !== null) return { tripped: true, reason: 'Instruction chứa lệnh phá hoại.', detail: label };
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'output-secret-leak',
      'output',
      'Chặn output agent chứa secret (API key, token, private key).',
      'block',
      (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        const label = firstMatchLabel(text, EVAL_HARNESS_V3_SECRET_PATTERNS);
        if (label !== null) return { tripped: true, reason: 'Output agent chứa secret.', detail: `loại: ${label}` };
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'output-forbidden-command',
      'output',
      'Chặn output agent chứa lệnh phá hoại.',
      'block',
      (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        const label = forbiddenCommandLabel(text);
        if (label !== null) return { tripped: true, reason: 'Output agent chứa lệnh phá hoại.', detail: label };
        for (const re of extraOutput) {
          if (re.test(text)) return { tripped: true, reason: 'Output khớp mẫu cấm riêng của task.', detail: `mẫu: ${re.source.slice(0, 80)}` };
        }
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'output-pii',
      'output',
      'Cảnh báo khi output agent chứa PII.',
      'warn',
      (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        const label = firstMatchLabel(text, EVAL_HARNESS_V3_PII_PATTERNS);
        if (label !== null) return { tripped: true, reason: 'Output agent chứa PII.', detail: `loại: ${label}` };
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'tool-denied',
      'tool',
      'Chặn agent gọi tool nằm trong danh sách cấm của task.',
      'block',
      (_value, context) => {
        const name = (context.toolName ?? '').toLowerCase();
        if (name !== '' && deniedTools.has(name)) {
          return { tripped: true, reason: `Tool "${context.toolName}" bị cấm với task này.`, detail: name };
        }
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'tool-not-allowed',
      'tool',
      'Chặn agent gọi tool ngoài danh sách cho phép của task.',
      'block',
      (_value, context) => {
        const name = (context.toolName ?? '').toLowerCase();
        if (allowedTools !== undefined && name !== '' && !allowedTools.has(name)) {
          return { tripped: true, reason: `Tool "${context.toolName}" không nằm trong danh sách cho phép.`, detail: name };
        }
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'tool-arg-forbidden-command',
      'tool',
      'Chặn tham số tool call chứa lệnh phá hoại.',
      'block',
      (_value, context) => {
        const text = JSON.stringify(context.toolArgs ?? {});
        const label = forbiddenCommandLabel(text);
        if (label !== null) return { tripped: true, reason: 'Tham số tool call chứa lệnh phá hoại.', detail: label };
        return { tripped: false, reason: 'OK' };
      },
    ),
    makeGuardrail(
      'tool-call-limit',
      'tool',
      'Chặn khi agent vượt số tool call tối đa của trial.',
      'block',
      (_value, context) => {
        if (context.toolCallCount > maxToolCalls) {
          return { tripped: true, reason: `Vượt giới hạn tool call (${context.toolCallCount} > ${maxToolCalls}).`, detail: `${context.toolCallCount}/${maxToolCalls}` };
        }
        return { tripped: false, reason: 'OK' };
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Chạy guardrail
// ---------------------------------------------------------------------------

/** Chạy một guardrail đơn, bắt lỗi check (check lỗi → không trip, ghi warn). */
export function runSingleGuardrail(
  guardrail: EvalHarnessV3Guardrail,
  value: unknown,
  context: EvalHarnessV3GuardrailContext,
): EvalHarnessV3GuardrailResult {
  try {
    const outcome = guardrail.check(value, context);
    return {
      guardrailId: guardrail.id,
      stage: guardrail.stage,
      tripped: outcome.tripped,
      severity: guardrail.severity,
      reason: outcome.reason,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    };
  } catch (err) {
    // Guardrail lỗi thì không chặn trial — ghi lại để debug.
    return {
      guardrailId: guardrail.id,
      stage: guardrail.stage,
      tripped: false,
      severity: 'warn',
      reason: `Guardrail lỗi khi check: ${(err as Error).message.slice(0, 120)}`,
    };
  }
}

function toTrip(result: EvalHarnessV3GuardrailResult): EvalHarnessV3GuardrailTrip {
  return {
    guardrailId: result.guardrailId,
    stage: result.stage,
    reason: result.reason,
    severity: result.severity,
    trippedAt: Date.now(),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  };
}

/**
 * Chạy guardrail của một giai đoạn.
 *
 * - `mode: 'parallel'` — chạy hết guardrail, gom toàn bộ trip.
 * - `mode: 'sequential'` — dừng ở trip block đầu tiên (trip warn vẫn
 *   gom tiếp cho tới khi gặp block hoặc hết).
 * - Trả về `blocked=true` khi có ít nhất một trip severity block.
 */
export function runGuardrailStage(
  guardrails: EvalHarnessV3Guardrail[],
  stage: EvalHarnessV3GuardrailStage,
  value: unknown,
  context: EvalHarnessV3GuardrailContext,
  mode: 'parallel' | 'sequential' = 'parallel',
): EvalHarnessV3GuardrailCheck {
  const startedAt = Date.now();
  const trips: EvalHarnessV3GuardrailTrip[] = [];
  let checked = 0;
  for (const guardrail of guardrails) {
    if (guardrail.stage !== stage) continue;
    checked += 1;
    const result = runSingleGuardrail(guardrail, value, context);
    if (result.tripped) {
      trips.push(toTrip(result));
      if (mode === 'sequential' && result.severity === 'block') break;
    }
  }
  return {
    stage,
    blocked: trips.some((t) => t.severity === 'block'),
    trips,
    checked,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Chạy toàn bộ guardrail cho một giá trị ở cả 3 giai đoạn (input, output,
 * tool) — dùng khi cần một lần check tổng. Thường runner gọi từng giai
 * đoạn riêng (input trước executor, tool trong executor, output sau).
 */
export function runAllGuardrails(
  guardrails: EvalHarnessV3Guardrail[],
  value: unknown,
  context: EvalHarnessV3GuardrailContext,
  mode: 'parallel' | 'sequential' = 'parallel',
): EvalHarnessV3GuardrailCheck {
  const startedAt = Date.now();
  const trips: EvalHarnessV3GuardrailTrip[] = [];
  let checked = 0;
  for (const stage of ['input', 'output', 'tool'] as const) {
    const check = runGuardrailStage(guardrails, stage, value, context, mode);
    trips.push(...check.trips);
    checked += check.checked;
    if (mode === 'sequential' && check.blocked) break;
  }
  return {
    stage: 'all',
    blocked: trips.some((t) => t.severity === 'block'),
    trips,
    checked,
    durationMs: Date.now() - startedAt,
  };
}

/** Kiểm tra input của task (instruction + issue) trước khi chạy agent. */
export function checkEvalInput(
  task: EvalHarnessV3Task,
  mode: 'parallel' | 'sequential' = 'parallel',
): EvalHarnessV3GuardrailCheck {
  if (task.guardrails?.enabled === false) {
    return { stage: 'input', blocked: false, trips: [], checked: 0, durationMs: 0 };
  }
  const guardrails = defaultEvalHarnessV3Guardrails(task);
  const context: EvalHarnessV3GuardrailContext = { task, toolCallCount: 0 };
  const text = `${task.input.instruction}\n${task.input.issue ?? ''}`;
  return runGuardrailStage(guardrails, 'input', text, context, mode);
}

/** Kiểm tra output của agent (files + commands nối lại) sau khi agent chạy. */
export function checkEvalOutput(
  task: EvalHarnessV3Task,
  agentFiles: Record<string, string>,
  agentCommands: string[],
  mode: 'parallel' | 'sequential' = 'parallel',
): EvalHarnessV3GuardrailCheck {
  if (task.guardrails?.enabled === false) {
    return { stage: 'output', blocked: false, trips: [], checked: 0, durationMs: 0 };
  }
  const guardrails = defaultEvalHarnessV3Guardrails(task);
  const context: EvalHarnessV3GuardrailContext = { task, toolCallCount: 0 };
  const text = [
    ...Object.entries(agentFiles).map(([p, c]) => `--- ${p} ---\n${c}`),
    ...agentCommands.map((c) => `$ ${c}`),
  ].join('\n');
  return runGuardrailStage(guardrails, 'output', text, context, mode);
}

/** Kiểm tra một tool call của agent (tên + tham số + số lượng đã dùng). */
export function checkEvalToolCall(
  task: EvalHarnessV3Task,
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolCallCount: number,
  mode: 'parallel' | 'sequential' = 'parallel',
): EvalHarnessV3GuardrailCheck {
  if (task.guardrails?.enabled === false) {
    return { stage: 'tool', blocked: false, trips: [], checked: 0, durationMs: 0 };
  }
  const guardrails = defaultEvalHarnessV3Guardrails(task);
  const context: EvalHarnessV3GuardrailContext = { task, toolCallCount, toolName, toolArgs };
  return runGuardrailStage(guardrails, 'tool', toolArgs, context, mode);
}

/** Ném TripwireError khi check bị block — runner bắt để dừng trial. */
export function assertGuardrailNotBlocked(check: EvalHarnessV3GuardrailCheck): void {
  if (check.blocked) {
    throw new EvalHarnessV3TripwireError(check.trips.filter((t) => t.severity === 'block'));
  }
}

/** Render các trip thành text đọc được (CLI/tool/trace). */
export function renderGuardrailTripsText(trips: EvalHarnessV3GuardrailTrip[]): string {
  if (trips.length === 0) return 'Không có guardrail trip.\n';
  const lines = trips.map(
    (t) =>
      `  [${t.severity.toUpperCase()}] ${t.guardrailId} (${t.stage}): ${t.reason}${t.detail !== undefined ? ` — ${t.detail}` : ''}`,
  );
  return `Guardrail trips (${trips.length}):\n${lines.join('\n')}\n`;
}
