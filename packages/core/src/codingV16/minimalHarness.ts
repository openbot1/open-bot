/**
 * Coding agent v16 — MinimalHarness: vòng lặp bash-only, preamble gọn.
 *
 * Ý tưởng từ nghiên cứu (survey v138 §3): preamble call đầu của
 * Claude Code ~16.600 token, OpenCode ~7.000, mini-SWE-agent 829 —
 * preamble gọn là đòn bẩy chi phí lớn nhất. Minimal harness chỉ có
 * 3 "tool" khái niệm: bash, đọc file theo cửa sổ, ghi file qua
 * linter gate. Preamble là template ngắn (< 1.000 token mục tiêu):
 * vai trò + 3 quy tắc + định dạng output, không liệt kê tool dài,
 * không ví dụ thừa. Harness chạy theo script step (do caller cung
 * cấp — không gọi model thật ở core, không chạy shell thật ở core;
 * bashOutput do script cung cấp, tool layer mới chạy shell thật).
 * Mỗi step: ghi token vào meter, trim history khi vượt ngưỡng, chặn
 * ghi file lỗi cú pháp, dừng khi done / hết step / hết budget.
 */

import { CodingV16Error, V16_DEFAULTS } from './types';
import type {
  V16FileWrite,
  V16MinimalConfig,
  V16MinimalRunReport,
  V16MinimalStep,
} from './types';
import { v16LintContent } from './editLinter';
import { v16TrimHistory } from './historyTrimmer';
import type { V16HistoryEntry } from './types';
import { TokenBudgetMeter, v16EstimateTokens } from './tokenBudget';

/** Preamble gọn của minimal harness (mục tiêu < 1.000 token). */
export const V16_MINIMAL_PREAMBLE = [
  'You are a coding agent. Work in bash + files only.',
  'Rules:',
  '1. Read files in 100-line windows; never dump a whole large file.',
  '2. Edit with exact old-text match; never rewrite a file to fix one line.',
  '3. After each bash command, state the result in one line, then the next action.',
  '4. Stop and say DONE when the task is complete or blocked.',
  'Output per step: one bash command (or NONE), then DONE when finished.',
].join('\n');

/** Token ước tính của preamble gọn. */
export function v16MinimalPreambleTokens(): number {
  return v16EstimateTokens(V16_MINIMAL_PREAMBLE);
}

/** Tiết kiệm preamble ước tính so với preamble đầy đủ 16.600 token. */
export function v16PreambleSavedVsFull(preambleTokens: number): number {
  return Math.max(0, V16_DEFAULTS.fullPreambleTokens - preambleTokens);
}

/** Một mục trong preamble tuỳ biến (bật/tắt theo task). */
export interface V16PreambleSection {
  /** Id mục: 'role' | 'rules' | 'tools' | 'format' | 'repo' | tên tự đặt. */
  id: string;
  /** Nội dung mục. */
  text: string;
  /** true = bắt buộc (luôn có); false = có thể lược khi thiếu token. */
  required: boolean;
}

/** Các mục preamble mặc định của minimal harness (đủ để chạy bash-only). */
export const V16_MINIMAL_PREAMBLE_SECTIONS: V16PreambleSection[] = [
  { id: 'role', text: 'You are a coding agent. Work in bash + files only.', required: true },
  {
    id: 'rules',
    text: [
      'Rules:',
      '1. Read files in 100-line windows; never dump a whole large file.',
      '2. Edit with exact old-text match; never rewrite a file to fix one line.',
      '3. After each bash command, state the result in one line, then the next action.',
      '4. Stop and say DONE when the task is complete or blocked.',
    ].join('\n'),
    required: true,
  },
  {
    id: 'format',
    text: 'Output per step: one bash command (or NONE), then DONE when finished.',
    required: true,
  },
  {
    id: 'tools',
    text: 'Tools: bash (run a command), read window (100 lines), write file (lint-gated).',
    required: false,
  },
  {
    id: 'repo',
    text: 'Repo notes: check the repo map / README first; keep diffs small and focused.',
    required: false,
  },
];

/** Kết quả dựng preamble tuỳ biến (text + token từng mục + mục đã lược). */
export interface V16BuiltPreamble {
  text: string;
  tokens: number;
  included: string[];
  dropped: string[];
}

/**
 * Dựng preamble từ các mục: luôn giữ mục required, thêm mục optional
 * theo thứ tự cho tới khi chạm `maxTokens` (mặc định 1000). Trả cả
 * danh sách mục đã lược để caller biết preamble thiếu gì.
 */
export function v16BuildPreamble(
  sections: readonly V16PreambleSection[],
  maxTokens: number = V16_DEFAULTS.maxPreambleTokens,
): V16BuiltPreamble {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new CodingV16Error('harness-invalid', 'Preamble maxTokens must be a positive integer.');
  }
  const included: string[] = [];
  const dropped: string[] = [];
  const parts: string[] = [];
  let tokens = 0;
  for (const section of sections) {
    const cost = v16EstimateTokens(section.text);
    if (section.required) {
      parts.push(section.text);
      included.push(section.id);
      tokens += cost;
    } else if (tokens + cost <= maxTokens) {
      parts.push(section.text);
      included.push(section.id);
      tokens += cost;
    } else {
      dropped.push(section.id);
    }
  }
  return { text: parts.join('\n'), tokens, included, dropped };
}

/** Dựng preamble mặc định (các mục V16_MINIMAL_PREAMBLE_SECTIONS). */
export function v16BuildDefaultPreamble(
  maxTokens: number = V16_DEFAULTS.maxPreambleTokens,
  extraSections: readonly V16PreambleSection[] = [],
): V16BuiltPreamble {
  return v16BuildPreamble([...V16_MINIMAL_PREAMBLE_SECTIONS, ...extraSections], maxTokens);
}

/** Validate một step script (không bịa field, kiểu chặt). */
export function v16ValidateMinimalStep(step: unknown, index: number): V16MinimalStep {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}] must be an object.`);
  }
  const s = step as Record<string, unknown>;
  if (typeof s['text'] !== 'string') {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}].text must be a string.`);
  }
  if (typeof s['done'] !== 'boolean') {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}].done must be a boolean.`);
  }
  if (s['bashCommand'] !== undefined && typeof s['bashCommand'] !== 'string') {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}].bashCommand must be a string.`);
  }
  if (s['bashOutput'] !== undefined && typeof s['bashOutput'] !== 'string') {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}].bashOutput must be a string.`);
  }
  if (s['promptTokens'] !== undefined && (!Number.isInteger(s['promptTokens']) || (s['promptTokens'] as number) < 0)) {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}].promptTokens must be a non-negative integer.`);
  }
  if (s['completionTokens'] !== undefined && (!Number.isInteger(s['completionTokens']) || (s['completionTokens'] as number) < 0)) {
    throw new CodingV16Error('harness-step-invalid', `steps[${index}].completionTokens must be a non-negative integer.`);
  }
  let fileWrite: V16FileWrite | undefined;
  const fwRaw = s['fileWrite'];
  if (fwRaw !== undefined && fwRaw !== null) {
    if (typeof fwRaw !== 'object' || Array.isArray(fwRaw)) {
      throw new CodingV16Error('harness-step-invalid', `steps[${index}].fileWrite must be an object.`);
    }
    const fw = fwRaw as Record<string, unknown>;
    if (typeof fw['path'] !== 'string' || (fw['path'] as string).trim() === '') {
      throw new CodingV16Error('harness-step-invalid', `steps[${index}].fileWrite.path must be a non-empty string.`);
    }
    if (fw['kind'] !== 'create' && fw['kind'] !== 'write' && fw['kind'] !== 'edit') {
      throw new CodingV16Error('harness-step-invalid', `steps[${index}].fileWrite.kind must be "create" | "write" | "edit".`);
    }
    if (typeof fw['content'] !== 'string') {
      throw new CodingV16Error('harness-step-invalid', `steps[${index}].fileWrite.content must be a string.`);
    }
    if (fw['kind'] === 'edit' && typeof fw['oldText'] !== 'string') {
      throw new CodingV16Error('harness-step-invalid', `steps[${index}].fileWrite.oldText is required for kind "edit".`);
    }
    fileWrite = {
      path: fw['path'] as string,
      kind: fw['kind'] as V16FileWrite['kind'],
      content: fw['content'] as string,
      ...(typeof fw['oldText'] === 'string' ? { oldText: fw['oldText'] as string } : {}),
    };
  }
  return {
    text: s['text'] as string,
    ...(typeof s['bashCommand'] === 'string' ? { bashCommand: s['bashCommand'] as string } : {}),
    ...(typeof s['bashOutput'] === 'string' ? { bashOutput: s['bashOutput'] as string } : {}),
    ...(fileWrite ? { fileWrite } : {}),
    done: s['done'] as boolean,
    ...(typeof s['promptTokens'] === 'number' ? { promptTokens: s['promptTokens'] as number } : {}),
    ...(typeof s['completionTokens'] === 'number' ? { completionTokens: s['completionTokens'] as number } : {}),
    ...(typeof s['note'] === 'string' ? { note: s['note'] as string } : {}),
  };
}

/** Áp một fileWrite đã qua linter lên nội dung cũ (pure — không ghi đĩa). */
export function v16ApplyFileWrite(
  before: string | null,
  write: V16FileWrite,
): string {
  if (write.kind === 'edit') {
    if (before === null) {
      throw new CodingV16Error('harness-invalid', `Cannot edit missing file ${write.path}.`);
    }
    const oldText = write.oldText ?? '';
    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new CodingV16Error('harness-invalid', `oldText not found in ${write.path} — edit refused.`);
    }
    if (occurrences > 1) {
      throw new CodingV16Error(
        'harness-invalid',
        `oldText matches ${occurrences} times in ${write.path} — edit must match exactly once.`,
      );
    }
    return before.replace(oldText, write.content);
  }
  // create/write: ghi đè toàn bộ (create trên file đã có = lỗi do caller).
  if (write.kind === 'create' && before !== null) {
    throw new CodingV16Error('harness-invalid', `Cannot create ${write.path} — file already exists.`);
  }
  return write.content;
}

/** Input chạy minimal harness. */
export interface V16RunMinimalInput {
  runId: string;
  prompt: string;
  /** Script step (model giả lập) — bắt buộc, không tự bịa. */
  steps: V16MinimalStep[];
  config?: V16MinimalConfig;
  /** Nội dung file hiện có (path -> content | null khi chưa có) để áp edit. */
  files?: Map<string, string | null>;
  /** Áp fileWrite ra ngoài (mặc định: chỉ cập nhật map files). */
  fileApplier?: (write: V16FileWrite, before: string | null) => string;
  /** Meter token ngoài (mặc định: tạo mới trong run). */
  meter?: TokenBudgetMeter;
  /** Ngân sách token cho run (mặc định: không chặn, chỉ đo). */
  budgetTokens?: number;
}

/** Chạy minimal harness từ script step, trả report + file sau khi áp. */
export function runV16Minimal(input: V16RunMinimalInput): {
  report: V16MinimalRunReport;
  files: Map<string, string | null>;
} {
  if (typeof input.runId !== 'string' || input.runId.trim() === '') {
    throw new CodingV16Error('harness-invalid', 'Minimal run runId must be a non-empty string.');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new CodingV16Error('harness-invalid', 'Minimal run prompt must be a non-empty string.');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new CodingV16Error('harness-step-invalid', 'Minimal run needs at least one scripted step.');
  }
  const config: Required<V16MinimalConfig> = {
    maxPreambleTokens: input.config?.maxPreambleTokens ?? V16_DEFAULTS.maxPreambleTokens,
    maxSteps: input.config?.maxSteps ?? 20,
    fileWindowLines: input.config?.fileWindowLines ?? V16_DEFAULTS.fileWindowLines,
    keepRecentToolOutputs: input.config?.keepRecentToolOutputs ?? V16_DEFAULTS.keepRecentToolOutputs,
    lintBeforeWrite: input.config?.lintBeforeWrite ?? true,
    trimThresholdTokens: input.config?.trimThresholdTokens ?? V16_DEFAULTS.trimThresholdTokens,
  };
  if (!Number.isInteger(config.maxSteps) || config.maxSteps <= 0) {
    throw new CodingV16Error('harness-invalid', 'maxSteps must be a positive integer.');
  }
  const steps = input.steps.map((s, i) => v16ValidateMinimalStep(s, i));
  const meter = input.meter ?? new TokenBudgetMeter();
  const files = new Map<string, string | null>(input.files ?? []);
  const applier =
    input.fileApplier ??
    ((write: V16FileWrite, before: string | null): string => v16ApplyFileWrite(before, write));

  const preambleTokens = v16MinimalPreambleTokens();
  if (preambleTokens > config.maxPreambleTokens) {
    throw new CodingV16Error(
      'harness-invalid',
      `Minimal preamble is ${preambleTokens} tokens, over maxPreambleTokens ${config.maxPreambleTokens}.`,
    );
  }
  meter.record({
    taskId: input.runId,
    step: 0,
    kind: 'preamble',
    promptTokens: preambleTokens,
    completionTokens: 0,
    harness: 'minimal',
    at: Date.now(),
  });

  const history: V16HistoryEntry[] = [
    {
      id: 'v16-history-system',
      role: 'system',
      text: V16_MINIMAL_PREAMBLE,
      tokens: preambleTokens,
      seq: 0,
      at: Date.now(),
      pinned: true,
    },
    {
      id: 'v16-history-user',
      role: 'user',
      text: input.prompt,
      tokens: v16EstimateTokens(input.prompt),
      seq: 1,
      at: Date.now(),
    },
  ];
  let seq = 2;
  const transcript: string[] = [];
  const filesWritten: string[] = [];
  let lintBlocks = 0;
  let trims = 0;
  let done = false;
  let stepsRun = 0;
  let promptTokens = preambleTokens;
  let completionTokens = 0;

  for (const step of steps.slice(0, config.maxSteps)) {
    stepsRun += 1;
    const stepPrompt = step.promptTokens ?? v16EstimateTokens(step.text);
    const stepCompletion = step.completionTokens ?? v16EstimateTokens(step.bashCommand ?? '');
    promptTokens += stepPrompt;
    completionTokens += stepCompletion;
    meter.record({
      taskId: input.runId,
      step: stepsRun,
      kind: 'model',
      promptTokens: stepPrompt,
      completionTokens: stepCompletion,
      harness: 'minimal',
      at: Date.now(),
    });
    // Ghi history + trim khi vượt ngưỡng (giữ 5 tool-output gần nhất).
    history.push({
      id: `v16-history-model-${stepsRun}`,
      role: 'model',
      text: step.text,
      tokens: stepPrompt + stepCompletion,
      seq: seq++,
      at: Date.now(),
    });
    if (step.bashCommand !== undefined) {
      history.push({
        id: `v16-history-tool-${stepsRun}`,
        role: 'tool',
        text: step.bashOutput ?? '',
        tokens: v16EstimateTokens(step.bashOutput ?? ''),
        seq: seq++,
        at: Date.now(),
        toolName: 'bash',
      });
      transcript.push(`$ ${step.bashCommand}\n${step.bashOutput ?? ''}`);
    } else {
      transcript.push(step.text);
    }
    // Trim history khi vượt ngưỡng.
    const historyTokens = history.reduce((s, e) => s + e.tokens, 0);
    if (historyTokens > config.trimThresholdTokens) {
      const { kept, result } = v16TrimHistory(history, {
        maxTokens: config.trimThresholdTokens,
        keepRecentToolOutputs: config.keepRecentToolOutputs,
      });
      history.length = 0;
      history.push(...kept);
      if (result.trimmedEntries > 0) trims += 1;
    }
    // Ghi file (qua linter gate khi bật).
    if (step.fileWrite) {
      const write = step.fileWrite;
      if (config.lintBeforeWrite) {
        const lint = v16LintContent(write.path, write.content);
        if (lint.blocked) {
          lintBlocks += 1;
          transcript.push(`LINT BLOCKED ${write.path}: ${lint.summary}`);
          history.push({
            id: `v16-history-lint-${stepsRun}`,
            role: 'tool',
            text: `lint blocked ${write.path}: ${lint.summary}`,
            tokens: v16EstimateTokens(lint.summary),
            seq: seq++,
            at: Date.now(),
            toolName: 'lint',
          });
          if (step.done) done = true;
          continue;
        }
      }
      const before = files.has(write.path) ? files.get(write.path)! : null;
      const after = applier(write, before);
      files.set(write.path, after);
      filesWritten.push(write.path);
    }
    if (step.done) {
      done = true;
      break;
    }
    // Dừng khi vượt ngân sách (khi caller đặt budgetTokens).
    if (input.budgetTokens !== undefined && promptTokens + completionTokens >= input.budgetTokens) {
      break;
    }
  }

  const totalTokens = promptTokens + completionTokens;
  const report: V16MinimalRunReport = {
    runId: input.runId,
    prompt: input.prompt,
    stepsRun,
    done,
    preambleTokens,
    promptTokens,
    completionTokens,
    totalTokens,
    lintBlocks,
    trims,
    filesWritten,
    transcript,
    preambleSavedVsFull: v16PreambleSavedVsFull(preambleTokens),
  };
  return { report, files };
}

/** Render report minimal harness thành text. */
export function renderV16MinimalReport(report: V16MinimalRunReport): string {
  return (
    `Minimal harness run ${report.runId}: ${report.done ? 'DONE' : 'NOT DONE'} ` +
    `in ${report.stepsRun} step(s), ${report.totalTokens} tokens ` +
    `(preamble ${report.preambleTokens}, saved ~${report.preambleSavedVsFull} vs full preamble), ` +
    `${report.filesWritten.length} file(s) written, ${report.lintBlocks} lint block(s), ${report.trims} trim(s).`
  );
}
