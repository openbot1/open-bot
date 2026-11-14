/**
 * Dataset coverage analysis (v1.05, Team T6) — kiểm tra chất lượng
 * của một memory eval dataset: fact nào chưa từng được câu hỏi nào
 * nhắc tới (ký ức chưa được đo), tag nào mỏng, loại câu hỏi nào
 * thiếu, câu hỏi nào trỏ tới fact hiếm.
 *
 * Pure, không gọi gì ngoài dataset. Dùng khi soạn dataset mới
 * (để không bỏ sót fact) và trong tool `eval_v3_dataset` (báo cáo
 * coverage kèm theo dataset).
 */

import type { MemoryEvalDataset, MemoryEvalQuestionCategory } from './memoryDataset';

/** Một fact chưa được câu hỏi nào cover. */
export interface UncoveredFact {
  factId: string;
  text: string;
  tags: string[];
  /** Số câu hỏi trỏ tới fact này (0 = hoàn toàn chưa được đo). */
  questionCount: number;
}

/** Thống kê coverage của một dataset. */
export interface DatasetCoverage {
  datasetId: string;
  totalFacts: number;
  totalQuestions: number;
  /** Số fact được ít nhất một câu hỏi nhắc tới. */
  coveredFacts: number;
  /** coveredFacts / totalFacts. */
  coverageRatio: number;
  /** Fact chưa được đo (questionCount = 0), kèm text để dễ bổ sung câu hỏi. */
  uncoveredFacts: UncoveredFact[];
  /** Số câu hỏi theo từng loại. */
  questionsByCategory: Record<MemoryEvalQuestionCategory, number>;
  /** Số fact theo từng tag (một fact có nhiều tag thì đếm ở mỗi tag). */
  factsByTag: Record<string, number>;
  /** Số câu hỏi trỏ tới mỗi fact (để thấy fact nào bị hỏi quá nhiều / quá ít). */
  questionsPerFact: Record<string, number>;
  /** Fact được hỏi nhiều nhất (cùng số lần thì fact đầu tiên thắng). */
  mostAskedFact: { factId: string; count: number } | null;
  /** Cảnh báo chất lượng dataset (vd coverage < 80%, loại câu hỏi thiếu). */
  warnings: string[];
}

/** Phân tích coverage của một dataset. */
export function analyzeDatasetCoverage(dataset: MemoryEvalDataset): DatasetCoverage {
  const questionsPerFact: Record<string, number> = {};
  for (const fact of dataset.facts) questionsPerFact[fact.id] = 0;
  const questionsByCategory: Record<MemoryEvalQuestionCategory, number> = {
    recall: 0,
    temporal: 0,
    'multi-hop': 0,
  };
  for (const q of dataset.questions) {
    questionsByCategory[q.category] += 1;
    // Mỗi câu hỏi chỉ đếm một lần cho mỗi fact (expectedFactIds và
    // hops thường trỏ cùng fact — không đếm trùng).
    const referenced = new Set<string>(q.expectedFactIds);
    for (const hop of q.hops ?? []) {
      for (const fid of hop) referenced.add(fid);
    }
    for (const fid of referenced) {
      if (fid in questionsPerFact) questionsPerFact[fid] += 1;
    }
  }
  const factsByTag: Record<string, number> = {};
  for (const fact of dataset.facts) {
    for (const tag of new Set(fact.tags)) {
      factsByTag[tag] = (factsByTag[tag] ?? 0) + 1;
    }
  }
  const factsById = new Map(dataset.facts.map((f) => [f.id, f]));
  const uncoveredFacts: UncoveredFact[] = dataset.facts
    .filter((f) => questionsPerFact[f.id] === 0)
    .map((f) => ({ factId: f.id, text: f.text, tags: [...f.tags], questionCount: 0 }));
  const coveredFacts = dataset.facts.length - uncoveredFacts.length;
  const coverageRatio = dataset.facts.length === 0 ? 0 : coveredFacts / dataset.facts.length;
  let mostAskedFact: { factId: string; count: number } | null = null;
  for (const [factId, count] of Object.entries(questionsPerFact)) {
    if (mostAskedFact === null || count > mostAskedFact.count) {
      mostAskedFact = { factId, count };
    }
  }
  const warnings: string[] = [];
  if (coverageRatio < 0.8) {
    warnings.push(
      `coverage is ${(coverageRatio * 100).toFixed(1)}% (${uncoveredFacts.length} of ${dataset.facts.length} facts are never asked about) — add questions for the uncovered facts.`,
    );
  }
  for (const category of ['recall', 'temporal', 'multi-hop'] as const) {
    if (questionsByCategory[category] === 0) {
      warnings.push(`no ${category} questions — the dataset does not measure ${category}.`);
    }
  }
  const datedFacts = dataset.facts.filter((f) => f.date !== undefined).length;
  if (dataset.questions.some((q) => q.category === 'temporal') && datedFacts === 0) {
    warnings.push('temporal questions exist but no fact carries a date — temporal accuracy cannot be measured.');
  }
  return {
    datasetId: dataset.id,
    totalFacts: dataset.facts.length,
    totalQuestions: dataset.questions.length,
    coveredFacts,
    coverageRatio,
    uncoveredFacts,
    questionsByCategory,
    factsByTag,
    questionsPerFact,
    mostAskedFact,
    warnings,
  };
}

/** Render coverage thành Markdown (để dán vào chat / ghi file). */
export function renderCoverageMarkdown(coverage: DatasetCoverage): string {
  const lines: string[] = [
    `# Dataset coverage — ${coverage.datasetId}`,
    '',
    `- Facts: ${coverage.totalFacts}, questions: ${coverage.totalQuestions}`,
    `- Covered facts: ${coverage.coveredFacts} (${(coverage.coverageRatio * 100).toFixed(1)}%)`,
    `- Questions by category: recall ${coverage.questionsByCategory.recall}, temporal ${coverage.questionsByCategory.temporal}, multi-hop ${coverage.questionsByCategory['multi-hop']}`,
    '',
  ];
  if (coverage.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of coverage.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  if (coverage.uncoveredFacts.length > 0) {
    lines.push('## Uncovered facts', '');
    for (const fact of coverage.uncoveredFacts) {
      lines.push(`- ${fact.factId}: ${fact.text}`);
    }
    lines.push('');
  }
  if (coverage.mostAskedFact) {
    lines.push(`Most asked fact: ${coverage.mostAskedFact.factId} (${coverage.mostAskedFact.count} questions).`, '');
  }
  return `${lines.join('\n')}\n`;
}
