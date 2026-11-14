/**
 * Retriever benchmark (v1.05, Team T6) — chạy cùng một dataset qua
 * NHIỀU retriever (vd mock-embedding-v1 vs keyword-v1, hoặc hai
 * phiên bản của cùng một retriever thật) rồi xếp hạng theo từng
 * metric, để trả lời câu hỏi "phiên bản memory nào tốt hơn" bằng
 * số đo chứ không bằng cảm giác.
 *
 * Chạy offline hoàn toàn: mọi retriever đều chạy local (mock hoặc
 * retriever thật gắn qua interface `MemoryRetriever`), không gọi
 * API ngoài. Kết quả là một bảng so sánh + retriever thắng từng
 * metric — dùng cho runner so sánh baseline vs hiện tại ở tầm
 * chiến lược (đổi hẳn retriever), khác với `compareMemoryEvalReports`
 * (so hai lần chạy của cùng một retriever).
 */

import type { MemoryEvalDataset } from './memoryDataset';
import type { MemoryEvalReport, MemoryRetriever } from './memoryEval';
import { runMemoryEval } from './memoryEval';

/** Một retriever trong bảng benchmark + nhãn phiên bản của nó. */
export interface BenchmarkRetrieverEntry {
  retriever: MemoryRetriever;
  /** Nhãn phiên bản (vd 'mock-embedding-v1', 'keyword-v1'). */
  version: string;
}

/** Kết quả của một retriever trong benchmark. */
export interface BenchmarkRow {
  retrieverName: string;
  version: string;
  report: MemoryEvalReport;
}

/** Bảng benchmark đầy đủ: các hàng + người thắng từng metric. */
export interface RetrieverBenchmark {
  datasetId: string;
  datasetVersion: number;
  topK: number;
  at: number;
  rows: BenchmarkRow[];
  /** Retriever thắng từng metric (tên + version + giá trị). */
  winners: {
    f1: { retrieverName: string; version: string; value: number };
    recall: { retrieverName: string; version: string; value: number };
    temporalAccuracy: { retrieverName: string; version: string; value: number } | null;
    multiHopScore: { retrieverName: string; version: string; value: number } | null;
    judgeScore: { retrieverName: string; version: string; value: number };
  };
}

export interface RunRetrieverBenchmarkOptions {
  topK?: number;
  at?: number;
}

/**
 * Chạy benchmark: mỗi retriever chạy toàn bộ dataset một lần (cùng
 * topK), rồi chọn người thắng từng metric (hòa nhau thì retriever
 * nộp trước thắng — thứ tự ổn định).
 */
export async function runRetrieverBenchmark(
  dataset: MemoryEvalDataset,
  entries: readonly BenchmarkRetrieverEntry[],
  opts: RunRetrieverBenchmarkOptions = {},
): Promise<RetrieverBenchmark> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('runRetrieverBenchmark needs at least one retriever.');
  }
  const topK = opts.topK ?? 5;
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error('runRetrieverBenchmark needs topK as an integer > 0.');
  }
  const at = opts.at ?? Date.now();
  const rows: BenchmarkRow[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.retriever !== 'object' || typeof entry.retriever.retrieve !== 'function') {
      throw new Error('benchmark entry needs a retriever with a retrieve() method.');
    }
    if (typeof entry.version !== 'string' || entry.version.trim() === '') {
      throw new Error('benchmark entry needs a non-empty version label.');
    }
    const report = await runMemoryEval(dataset, entry.retriever, {
      topK,
      retrieverVersion: entry.version.trim(),
      at,
    });
    rows.push({ retrieverName: entry.retriever.name, version: entry.version.trim(), report });
  }
  const pickWinner = (
    pick: (row: BenchmarkRow) => number | null,
  ): { retrieverName: string; version: string; value: number } | null => {
    let best: BenchmarkRow | null = null;
    let bestValue = -Infinity;
    for (const row of rows) {
      const value = pick(row);
      if (value === null) continue;
      if (value > bestValue) {
        bestValue = value;
        best = row;
      }
    }
    return best === null ? null : { retrieverName: best.retrieverName, version: best.version, value: bestValue };
  };
  const f1Winner = pickWinner((r) => r.report.overall.f1);
  const recallWinner = pickWinner((r) => r.report.overall.recall);
  const judgeWinner = pickWinner((r) => r.report.overall.judgeScore);
  if (!f1Winner || !recallWinner || !judgeWinner) {
    throw new Error('benchmark produced no rows to rank.');
  }
  return {
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    topK,
    at,
    rows,
    winners: {
      f1: f1Winner,
      recall: recallWinner,
      temporalAccuracy: pickWinner((r) => r.report.overall.temporalAccuracy),
      multiHopScore: pickWinner((r) => r.report.overall.multiHopScore),
      judgeScore: judgeWinner,
    },
  };
}

/** Render bảng benchmark thành Markdown (để dán vào chat / ghi file). */
export function renderBenchmarkMarkdown(benchmark: RetrieverBenchmark): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [
    `# Retriever benchmark — ${benchmark.datasetId} (v${benchmark.datasetVersion}, topK ${benchmark.topK})`,
    '',
    '| Retriever | Version | F1 | Recall | Precision | Temporal | Multi-hop | Judge |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of benchmark.rows) {
    const o = row.report.overall;
    lines.push(
      `| ${row.retrieverName} | ${row.version} | ${pct(o.f1)} | ${pct(o.recall)} | ${pct(o.precision)} | ${o.temporalAccuracy === null ? '—' : pct(o.temporalAccuracy)} | ${o.multiHopScore === null ? '—' : pct(o.multiHopScore)} | ${pct(o.judgeScore)} |`,
    );
  }
  lines.push('', '## Winners', '');
  const w = benchmark.winners;
  lines.push(`- F1: ${w.f1.retrieverName} (${w.f1.version}) — ${pct(w.f1.value)}`);
  lines.push(`- Recall: ${w.recall.retrieverName} (${w.recall.version}) — ${pct(w.recall.value)}`);
  if (w.temporalAccuracy) {
    lines.push(`- Temporal accuracy: ${w.temporalAccuracy.retrieverName} (${w.temporalAccuracy.version}) — ${pct(w.temporalAccuracy.value)}`);
  }
  if (w.multiHopScore) {
    lines.push(`- Multi-hop: ${w.multiHopScore.retrieverName} (${w.multiHopScore.version}) — ${pct(w.multiHopScore.value)}`);
  }
  lines.push(`- Judge: ${w.judgeScore.retrieverName} (${w.judgeScore.version}) — ${pct(w.judgeScore.value)}`);
  return `${lines.join('\n')}\n`;
}
