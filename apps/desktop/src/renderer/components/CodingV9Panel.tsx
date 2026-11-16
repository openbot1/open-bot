import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Coding agent v9 panel (v1.17, Team T6) — AST-aware edits, sandbox
 * execution loop runs (edit → test → iterate), git-first atomic
 * commits, SWE-bench-style eval harness results.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV14CodingPanel` via IPC); when there is no host wiring
 * yet it uses an internal demo store — the component never guesses
 * real numbers; the demo is clearly labelled in code.
 */

export interface CodingV9EditView {
  editId: string;
  file: string;
  operation: string;
  nodeKind: string;
  linesChanged: number;
  appliedAt: number;
  reverted: boolean;
}

export interface CodingV9SandboxRunView {
  runId: string;
  taskId: string;
  iterations: number;
  maxIterations: number;
  outcome: string;
  testsPassed: number;
  testsFailed: number;
  startedAt: number;
  finishedAt: number;
}

export interface CodingV9CommitView {
  commitId: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdBy: string;
  createdAt: number;
}

export interface CodingV9EvalView {
  evalId: string;
  taskCount: number;
  passed: number;
  passAtK: number;
  k: number;
  avgIterations: number;
  ranAt: number;
}

export interface CodingV9PanelView {
  edits: CodingV9EditView[];
  totalLinesChanged: number;
  revertedEdits: number;
  sandboxRuns: CodingV9SandboxRunView[];
  sandboxPassed: number;
  commits: CodingV9CommitView[];
  evals: CodingV9EvalView[];
  latestEval: CodingV9EvalView | null;
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoCodingV9Panel(): CodingV9PanelView {
  return {
    edits: [
      { editId: 'e1', file: 'src/a.ts', operation: 'replace', nodeKind: 'FunctionDeclaration', linesChanged: 12, appliedAt: T0, reverted: false },
    ],
    totalLinesChanged: 12,
    revertedEdits: 0,
    sandboxRuns: [
      { runId: 's1', taskId: 'task-1', iterations: 2, maxIterations: 5, outcome: 'passed', testsPassed: 8, testsFailed: 0, startedAt: T0, finishedAt: T0 + 1000 },
    ],
    sandboxPassed: 1,
    commits: [
      { commitId: 'c1', message: 'Demo: fix empty list handling', filesChanged: 1, insertions: 12, deletions: 3, createdBy: 'u1', createdAt: T0 },
    ],
    evals: [
      { evalId: 'ev1', taskCount: 20, passed: 14, passAtK: 0.7, k: 1, avgIterations: 2.1, ranAt: T0 },
    ],
    latestEval: { evalId: 'ev1', taskCount: 20, passed: 14, passAtK: 0.7, k: 1, avgIterations: 2.1, ranAt: T0 },
    summary: 'Demo: coding agent v9: 1 AST-aware edit (12 lines changed), 1/1 sandbox runs passed, 1 atomic git commit, latest eval 14/20 passed (pass@1 70%).',
  };
}

export default function CodingV9Panel({
  panel: panelProp,
}: {
  panel?: CodingV9PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<CodingV9PanelView>(() => panelProp ?? demoCodingV9Panel());

  return (
    <div>
      <h3>{t('fleetV14.codingTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV14.demo')}</p>
      <h4>{t('fleetV14.codingEdits')} ({panel.edits.length})</h4>
      {panel.edits.length === 0 ? (
        <p>{t('fleetV14.codingNoEdits')}</p>
      ) : (
        <ul>
          {panel.edits.map((e) => (
            <li key={e.editId}>
              {e.file} — {e.operation} {e.nodeKind} — {t('fleetV14.codingLines')}: {e.linesChanged}
              {e.reverted ? ` (${t('fleetV14.codingReverted')})` : ''}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.codingSandbox')} ({panel.sandboxRuns.length})</h4>
      {panel.sandboxRuns.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.sandboxRuns.map((r) => (
            <li key={r.runId}>
              {r.taskId} — {r.outcome} — {t('fleetV14.codingIterations')}: {r.iterations}/{r.maxIterations} — {t('fleetV14.codingPassed')}: {r.testsPassed}, failed: {r.testsFailed}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.codingCommits')} ({panel.commits.length})</h4>
      {panel.commits.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.commits.map((c) => (
            <li key={c.commitId}>
              {c.message} — {c.filesChanged} files (+{c.insertions}/−{c.deletions})
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.codingEval')} ({panel.evals.length})</h4>
      {panel.latestEval ? (
        <p>
          {panel.latestEval.evalId}: {panel.latestEval.passed}/{panel.latestEval.taskCount} {t('fleetV14.codingPassed')} (pass@{panel.latestEval.k} {Math.round(panel.latestEval.passAtK * 100)}%)
        </p>
      ) : (
        <p>—</p>
      )}
    </div>
  );
}
