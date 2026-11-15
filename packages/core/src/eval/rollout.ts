/**
 * Rollout → training data (v1.11, Đội T2).
 *
 * Mỗi lần chạy eval (harborRunner.ts) sinh ra một "rollout": toàn
 * bộ phiên làm việc của agent trên một task — prompt đầu vào, từng
 * turn (tool call + kết quả), token dùng, reward cuối cùng. Module
 * này ghi rollout ra JSONL để user tự fine-tune model local
 * (SFT/DPO/RL): một dòng JSON = một rollout, schema có version rõ
 * ràng, validator kiểm tra lại trước khi user đem đi train.
 *
 * Định dạng JSONL (một rollout một dòng):
 *   {
 *     "schema": "open-bot.rollout/v1",
 *     "rolloutId": "roll-...",
 *     "taskId": "sum-csv", "taskVersion": 1,
 *     "profileId": "coding", "model": {"provider": "ollama", "model": "qwen3:8b"},
 *     "startedAt": 1763..., "finishedAt": 1763..., "durationMs": 1234,
 *     "instruction": "...", "systemPrompt": "...",
 *     "turns": [ { "index": 0, "role": "assistant"|"tool"|"user",
 *                  "content": "...", "toolCalls": [...], "toolResults": [...],
 *                  "promptTokens": 100, "completionTokens": 50 } ],
 *     "reward": 0.75, "passed": true,
 *     "testResults": [ {"name": "correct-sum", "weight": 2, "passed": true} ],
 *     "usage": {"promptTokens": 1200, "completionTokens": 600, "totalTokens": 1800},
 *     "isolation": "bwrap",
 *     "error": null | "..."
 *   }
 *
 * Quyền riêng tư: rollout CHỈ ghi những gì runner nhận được (prompt
 * task + tool call + kết quả trong sandbox). Không bao giờ ghi secret
 * — `sanitizeRolloutForExport` lược bỏ các giá trị trông giống key/
 * token trong content trước khi export (giữ lại cấu trúc để train).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Version schema hiện tại của rollout JSONL. */
export const ROLLOUT_SCHEMA = 'open-bot.rollout/v1';
export const ROLLOUT_JSONL_FILE = 'rollouts.jsonl';

/** Một tool call trong một turn (ghi lại để train hành vi gọi tool). */
export interface RolloutToolCall {
  /** Tên tool, vd `write_file`. */
  name: string;
  /** Đối số (đã sanitize — xem sanitizeRolloutForExport). */
  arguments: Record<string, unknown>;
}

/** Kết quả trả về của một tool call. */
export interface RolloutToolResult {
  /** Tên tool tương ứng. */
  name: string;
  /** Nội dung trả về (đã cắt ngắn + sanitize). */
  content: string;
  /** true khi tool báo lỗi. */
  isError: boolean;
}

/** Một turn trong rollout. */
export interface RolloutTurn {
  index: number;
  role: 'user' | 'assistant' | 'tool';
  /** Nội dung text của turn (đã cắt ngắn ở mức ghi). */
  content: string;
  /** Tool call của turn (chỉ role assistant). */
  toolCalls: RolloutToolCall[];
  /** Kết quả tool của turn (chỉ role tool). */
  toolResults: RolloutToolResult[];
  /** Token ước tính/đo được của turn (0 khi executor không báo). */
  promptTokens: number;
  completionTokens: number;
}

/** Kết quả từng test trong rollout (để train theo reward từng phần). */
export interface RolloutTestResult {
  name: string;
  weight: number;
  passed: boolean;
}

/** Token usage tổng của rollout. */
export interface RolloutUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Một rollout đầy đủ — một dòng trong file JSONL. */
export interface RolloutRecord {
  schema: typeof ROLLOUT_SCHEMA;
  rolloutId: string;
  taskId: string;
  taskVersion: number;
  profileId: string;
  model: { provider: string; model: string };
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  instruction: string;
  systemPrompt: string;
  turns: RolloutTurn[];
  reward: number;
  passed: boolean;
  testResults: RolloutTestResult[];
  usage: RolloutUsage;
  /** Mức cách ly sandbox khi chạy (`bwrap`, `unshare`, `none`, ...). */
  isolation: string;
  /** Lỗi chạy (nếu có) — null khi chạy bình thường. */
  error: string | null;
}

/** Thống kê nhanh trên một tập rollout (đọc từ JSONL). */
export interface RolloutStats {
  rollouts: number;
  passed: number;
  passRate: number;
  meanReward: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  byTask: Record<string, { rollouts: number; passed: number; meanReward: number }>;
}

/** Một lỗi validate rollout — kèm số dòng JSONL để user tìm nhanh. */
export interface RolloutValidationIssue {
  line: number;
  field: string;
  message: string;
}

export interface RolloutValidationResult {
  valid: boolean;
  issues: RolloutValidationIssue[];
  /** Số rollout hợp lệ đếm được (kể cả khi file có dòng lỗi). */
  validRollouts: number;
}

/** Giới hạn ghi: content turn dài hơn thì cắt (giữ đầu + báo đã cắt). */
export const ROLLOUT_MAX_CONTENT_CHARS = 20_000;
export const ROLLOUT_MAX_TURNS = 200;

/** Mẫu trông giống secret — lược bỏ giá trị khi export. */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /\b(api[_-]?key|api[_-]?token|access[_-]?token|secret|password|passwd|pwd|bearer|private[_-]?key)\b/i,
];
const LONG_TOKEN_RE = /[A-Za-z0-9_\-]{32,}/g;

/**
 * Lược bỏ secret khỏi một chuỗi: mọi giá trị sau `key = ...` /
 * `"key": "..."` (key trông giống secret) thành `[REDACTED]`, và
 * mọi token dài dạng ngẫu nhiên (>= 32 ký tự alnum) cũng vậy.
 * Không phá cấu trúc JSONL — chỉ thay giá trị.
 */
export function redactRolloutSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  // Dạng "key": "value" hoặc key=value / key: value trong text thường.
  out = out.replace(
    /((?:"|')?(?:api[_-]?key|api[_-]?token|access[_-]?token|secret|password|passwd|pwd|bearer|private[_-]?key)(?:"|')?\s*[:=]\s*("?|'))[^"'\s,}]+/gi,
    '$1[REDACTED]',
  );
  out = out.replace(LONG_TOKEN_RE, (m) => {
    // Giữ lại các từ tiếng Anh dài bình thường (vd tên file dài) —
    // chỉ lược khi chuỗi có cả chữ hoa + chữ thường + số (dạng token).
    if (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m)) return '[REDACTED]';
    return m;
  });
  return out;
}

/** Cắt content dài, giữ đầu và ghi rõ đã cắt bao nhiêu ký tự. */
export function truncateRolloutContent(content: string, maxChars: number = ROLLOUT_MAX_CONTENT_CHARS): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n...[truncated ${content.length - maxChars} chars]`;
}

/** Sanitize một rollout trước khi export: redact secret + cắt content. */
export function sanitizeRolloutForExport(record: RolloutRecord): RolloutRecord {
  const cleanTurn = (turn: RolloutTurn): RolloutTurn => ({
    ...turn,
    content: redactRolloutSecrets(truncateRolloutContent(turn.content)),
    toolCalls: turn.toolCalls.map((call) => ({
      name: call.name,
      arguments: JSON.parse(redactRolloutSecrets(JSON.stringify(call.arguments))) as Record<string, unknown>,
    })),
    toolResults: turn.toolResults.map((result) => ({
      ...result,
      content: redactRolloutSecrets(truncateRolloutContent(result.content)),
    })),
  });
  return {
    ...record,
    instruction: redactRolloutSecrets(truncateRolloutContent(record.instruction)),
    systemPrompt: redactRolloutSecrets(truncateRolloutContent(record.systemPrompt)),
    turns: record.turns.map(cleanTurn),
  };
}

/** Cộng token usage từ các turn. */
export function sumRolloutUsage(turns: readonly RolloutTurn[]): RolloutUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const turn of turns) {
    promptTokens += Math.max(0, turn.promptTokens);
    completionTokens += Math.max(0, turn.completionTokens);
  }
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** Validate một rollout record (đã parse từ JSON). Trả về lỗi, rỗng = hợp lệ. */
export function validateRolloutRecord(record: unknown, line = 0): RolloutValidationIssue[] {
  const issues: RolloutValidationIssue[] = [];
  const issue = (field: string, message: string): void => {
    issues.push({ line, field, message });
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    issue('(root)', 'mỗi dòng JSONL phải là một JSON object (một rollout).');
    return issues;
  }
  const r = record as Record<string, unknown>;
  if (r['schema'] !== ROLLOUT_SCHEMA) issue('schema', `schema phải là "${ROLLOUT_SCHEMA}".`);
  if (typeof r['rolloutId'] !== 'string' || (r['rolloutId'] as string).trim() === '') issue('rolloutId', 'rolloutId phải là chuỗi không rỗng.');
  if (typeof r['taskId'] !== 'string' || (r['taskId'] as string).trim() === '') issue('taskId', 'taskId phải là chuỗi không rỗng.');
  if (typeof r['taskVersion'] !== 'number' || !Number.isInteger(r['taskVersion']) || (r['taskVersion'] as number) < 1) {
    issue('taskVersion', 'taskVersion phải là số nguyên >= 1.');
  }
  if (typeof r['profileId'] !== 'string') issue('profileId', 'profileId phải là chuỗi (rỗng = chạy không dùng profile).');
  if (!r['model'] || typeof r['model'] !== 'object') issue('model', 'model phải là object { provider, model }.');
  else {
    const model = r['model'] as Record<string, unknown>;
    if (typeof model['provider'] !== 'string') issue('model.provider', 'model.provider phải là chuỗi (rỗng = executor tự chọn model).');
    if (typeof model['model'] !== 'string') issue('model.model', 'model.model phải là chuỗi.');
  }
  if (typeof r['startedAt'] !== 'number' || typeof r['finishedAt'] !== 'number' || (r['finishedAt'] as number) < (r['startedAt'] as number)) {
    issue('startedAt/finishedAt', 'finishedAt phải là số và >= startedAt.');
  }
  if (typeof r['durationMs'] !== 'number' || (r['durationMs'] as number) < 0) issue('durationMs', 'durationMs phải là số >= 0.');
  if (typeof r['instruction'] !== 'string' || (r['instruction'] as string).trim() === '') issue('instruction', 'instruction phải là chuỗi không rỗng.');
  if (typeof r['systemPrompt'] !== 'string') issue('systemPrompt', 'systemPrompt phải là chuỗi.');
  if (!Array.isArray(r['turns'])) issue('turns', 'turns phải là mảng.');
  else {
    const turns = r['turns'] as unknown[];
    if (turns.length > ROLLOUT_MAX_TURNS) issue('turns', `quá nhiều turn (>${ROLLOUT_MAX_TURNS}).`);
    turns.forEach((turn, i) => {
      if (!turn || typeof turn !== 'object') {
        issue(`turns[${i}]`, 'mỗi turn phải là object.');
        return;
      }
      const t = turn as Record<string, unknown>;
      if (t['index'] !== i) issue(`turns[${i}].index`, `index phải bằng vị trí trong mảng (${i}).`);
      if (!['user', 'assistant', 'tool'].includes(t['role'] as string)) issue(`turns[${i}].role`, 'role phải là user|assistant|tool.');
      if (typeof t['content'] !== 'string') issue(`turns[${i}].content`, 'content phải là chuỗi.');
      if (!Array.isArray(t['toolCalls']) || !Array.isArray(t['toolResults'])) {
        issue(`turns[${i}]`, 'toolCalls và toolResults phải là mảng.');
      }
      if (typeof t['promptTokens'] !== 'number' || (t['promptTokens'] as number) < 0) issue(`turns[${i}].promptTokens`, 'promptTokens phải là số >= 0.');
      if (typeof t['completionTokens'] !== 'number' || (t['completionTokens'] as number) < 0) issue(`turns[${i}].completionTokens`, 'completionTokens phải là số >= 0.');
    });
  }
  if (typeof r['reward'] !== 'number' || (r['reward'] as number) < 0 || (r['reward'] as number) > 1) {
    issue('reward', 'reward phải là số trong [0, 1].');
  }
  if (typeof r['passed'] !== 'boolean') issue('passed', 'passed phải là boolean.');
  if (typeof r['passed'] === 'boolean' && typeof r['reward'] === 'number') {
    const expectedPassed = (r['reward'] as number) >= 1;
    if ((r['passed'] as boolean) !== expectedPassed && (r['reward'] as number) !== 1 && (r['reward'] as number) !== 0) {
      // passed chỉ có nghĩa khi reward == 1 (mọi test pass); reward
      // lẻ (0 < r < 1) thì passed phải là false.
      issue('passed', 'passed phải là true khi và chỉ khi reward == 1.');
    }
    if ((r['reward'] as number) === 1 && (r['passed'] as boolean) !== true) issue('passed', 'reward == 1 thì passed phải là true.');
    if ((r['reward'] as number) === 0 && (r['passed'] as boolean) !== false) issue('passed', 'reward == 0 thì passed phải là false.');
  }
  if (!Array.isArray(r['testResults'])) issue('testResults', 'testResults phải là mảng.');
  if (!r['usage'] || typeof r['usage'] !== 'object') issue('usage', 'usage phải là object { promptTokens, completionTokens, totalTokens }.');
  else {
    const usage = r['usage'] as Record<string, unknown>;
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) {
      if (typeof usage[key] !== 'number' || (usage[key] as number) < 0) issue(`usage.${key}`, `${key} phải là số >= 0.`);
    }
    if (
      typeof usage['promptTokens'] === 'number' &&
      typeof usage['completionTokens'] === 'number' &&
      typeof usage['totalTokens'] === 'number' &&
      (usage['totalTokens'] as number) !== (usage['promptTokens'] as number) + (usage['completionTokens'] as number)
    ) {
      issue('usage.totalTokens', 'totalTokens phải bằng promptTokens + completionTokens.');
    }
  }
  if (typeof r['isolation'] !== 'string' || (r['isolation'] as string).trim() === '') issue('isolation', 'isolation phải là chuỗi không rỗng.');
  if (r['error'] !== null && typeof r['error'] !== 'string') issue('error', 'error phải là null hoặc chuỗi.');
  return issues;
}

/**
 * Validate toàn bộ nội dung JSONL (chuỗi). Dòng trống được bỏ qua.
 * Dòng không parse được JSON cũng là một issue (không làm hỏng các
 * dòng còn lại).
 */
export function validateRolloutJsonl(content: string): RolloutValidationResult {
  const issues: RolloutValidationIssue[] = [];
  let validRollouts = 0;
  const lines = content.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    if (rawLine.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (err) {
      issues.push({ line: lineNo, field: '(parse)', message: `dòng không phải JSON hợp lệ: ${(err as Error).message}` });
      return;
    }
    const lineIssues = validateRolloutRecord(parsed, lineNo);
    if (lineIssues.length === 0) validRollouts += 1;
    issues.push(...lineIssues);
  });
  return { valid: issues.length === 0, issues, validRollouts };
}

/** Đọc một file JSONL thành mảng rollout (bỏ dòng trống; ném lỗi khi dòng hỏng). */
export function readRolloutJsonl(filePath: string): RolloutRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const records: RolloutRecord[] = [];
  content.split(/\r?\n/).forEach((rawLine, idx) => {
    if (rawLine.trim() === '') return;
    try {
      records.push(JSON.parse(rawLine) as RolloutRecord);
    } catch (err) {
      throw new Error(`Dòng ${idx + 1} trong "${filePath}" không phải JSON hợp lệ: ${(err as Error).message}`);
    }
  });
  return records;
}

/**
 * Ghi các rollout ra file JSONL (một dòng một rollout, đã sanitize).
 * `mode: 'append'` (mặc định) nối thêm vào file cũ; `'overwrite'`
 * ghi đè. Trả về số dòng đã ghi + đường dẫn file.
 */
export function writeRolloutJsonl(
  filePath: string,
  records: readonly RolloutRecord[],
  mode: 'append' | 'overwrite' = 'append',
): { filePath: string; linesWritten: number } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = records.map((record) => JSON.stringify(sanitizeRolloutForExport(record))).join('\n');
  const chunk = lines === '' ? '' : `${lines}\n`;
  if (mode === 'overwrite') fs.writeFileSync(filePath, chunk, 'utf-8');
  else fs.appendFileSync(filePath, chunk, 'utf-8');
  return { filePath, linesWritten: records.length };
}

/** Thống kê nhanh trên một mảng rollout đã load. */
export function summarizeRollouts(records: readonly RolloutRecord[]): RolloutStats {
  const byTask: RolloutStats['byTask'] = {};
  let passed = 0;
  let rewardSum = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalDurationMs = 0;
  for (const record of records) {
    if (record.passed) passed += 1;
    rewardSum += record.reward;
    totalPromptTokens += record.usage.promptTokens;
    totalCompletionTokens += record.usage.completionTokens;
    totalDurationMs += record.durationMs;
    const entry = byTask[record.taskId] ?? { rollouts: 0, passed: 0, meanReward: 0 };
    entry.rollouts += 1;
    if (record.passed) entry.passed += 1;
    entry.meanReward += record.reward;
    byTask[record.taskId] = entry;
  }
  for (const entry of Object.values(byTask)) {
    entry.meanReward = entry.rollouts > 0 ? entry.meanReward / entry.rollouts : 0;
  }
  const n = records.length;
  return {
    rollouts: n,
    passed,
    passRate: n > 0 ? passed / n : 0,
    meanReward: n > 0 ? rewardSum / n : 0,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalDurationMs,
    byTask,
  };
}

/**
 * Chuyển một rollout thành các dòng JSONL huấn luyện SFT (một dòng
 * một turn assistant): mỗi dòng là
 * `{ "messages": [ {role, content}... ], "reward": <reward> }`.
 * Chỉ lấy turn assistant có nội dung — turn tool chỉ giữ lại dưới
 * dạng context user khi cần. Dùng khi user muốn fine-tune từ
 * rollout thay vì dùng nguyên rollout thô.
 */
export function rolloutToSftJsonl(record: RolloutRecord): string[] {
  const lines: string[] = [];
  const history: { role: string; content: string }[] = [
    { role: 'system', content: record.systemPrompt },
    { role: 'user', content: record.instruction },
  ];
  for (const turn of record.turns) {
    if (turn.role === 'assistant' && turn.content.trim() !== '') {
      lines.push(
        JSON.stringify({
          messages: [...history, { role: 'assistant', content: turn.content }],
          reward: record.reward,
          taskId: record.taskId,
          rolloutId: record.rolloutId,
        }),
      );
      history.push({ role: 'assistant', content: turn.content });
    } else if (turn.role === 'tool') {
      const toolText = turn.toolResults.map((r) => `${r.name}: ${r.content}`).join('\n');
      if (toolText.trim() !== '') history.push({ role: 'user', content: toolText });
    } else if (turn.role === 'user' && turn.content.trim() !== '') {
      history.push({ role: 'user', content: turn.content });
    }
  }
  return lines;
}
