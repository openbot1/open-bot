import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Harbor eval + training-data UI (v1.11, Team T2).
 *
 * Shows the built-in Harbor sample tasks and the Agent Profiles
 * that ship with open-bot, plus how to run them. The panel itself
 * runs nothing: bots run evals with the `eval_v111_run_task` /
 * `eval_v111_run_suite` tools (sandboxed, rollouts written to
 * `eval-harbor/rollouts.jsonl`), and results are read back with
 * the `eval_v111_report` tool.
 *
 * Data source: the panel first tries the `evalV111:*` IPC channels
 * (when the main process wires them); until then it falls back to
 * the static catalog below, which mirrors the built-in tasks in
 * `packages/core/src/eval/harborLibrary.ts` and the built-in
 * profiles in `packages/core/src/eval/profiles.ts`. The fallback
 * is labelled honestly (see `evalV111.noIpc`) — the panel never
 * pretends a run happened when none did.
 */

interface CatalogTask {
  id: string;
  name: string;
  kind: string;
  description: string;
  tests: { name: string; weight: number }[];
  timeoutMs: number;
}

interface CatalogProfile {
  id: string;
  label: string;
  kind: string;
  description: string;
  provider: string;
  model: string;
  tools: string[];
  turnBudget: number;
  enabled: boolean;
}

/** Static catalog mirroring the core built-ins (fallback when no IPC). */
const FALLBACK_TASKS: CatalogTask[] = [
  {
    id: 'hello-file',
    name: 'Hello file',
    kind: 'general',
    description: 'Create greeting.txt with the exact greeting.',
    tests: [
      { name: 'file-exists', weight: 1 },
      { name: 'exact-content', weight: 2 },
    ],
    timeoutMs: 60_000,
  },
  {
    id: 'sum-csv',
    name: 'Sum CSV',
    kind: 'coding',
    description: 'Sum the numbers in data/numbers.csv into result.txt.',
    tests: [
      { name: 'result-exists', weight: 1 },
      { name: 'correct-sum', weight: 2 },
      { name: 'plain-number', weight: 1 },
    ],
    timeoutMs: 120_000,
  },
  {
    id: 'fix-add',
    name: 'Fix add()',
    kind: 'coding',
    description: 'Fix add() in calc.py so it returns a + b.',
    tests: [
      { name: 'add-positive', weight: 2 },
      { name: 'add-negative', weight: 1 },
      { name: 'add-zero', weight: 1 },
    ],
    timeoutMs: 120_000,
  },
  {
    id: 'markdown-table',
    name: 'Markdown table',
    kind: 'writing',
    description: 'Create report.md with a table of 3 items and the total.',
    tests: [
      { name: 'report-exists', weight: 1 },
      { name: 'has-table', weight: 2 },
      { name: 'correct-total', weight: 1 },
    ],
    timeoutMs: 60_000,
  },
];

const FALLBACK_PROFILES: CatalogProfile[] = [
  { id: 'coding', label: 'Coding', kind: 'coding', description: 'Write and fix code, verify with tests.', provider: 'ollama', model: '', tools: ['read_file', 'write_file', 'list_files', 'shell_exec', 'git_status', 'git_diff'], turnBudget: 30, enabled: true },
  { id: 'research', label: 'Research', kind: 'research', description: 'Research and synthesize sources with citations.', provider: 'ollama', model: '', tools: ['web_search', 'web_fetch', 'read_file', 'write_file', 'list_files'], turnBudget: 25, enabled: true },
  { id: 'writing', label: 'Writing', kind: 'writing', description: 'Write clear docs, reports and content.', provider: 'ollama', model: '', tools: ['read_file', 'write_file', 'list_files'], turnBudget: 20, enabled: true },
  { id: 'review', label: 'Review', kind: 'review', description: 'Review code and docs, point out issues and fixes.', provider: 'ollama', model: '', tools: ['read_file', 'list_files', 'git_status', 'git_diff', 'shell_exec'], turnBudget: 20, enabled: true },
  { id: 'general', label: 'General', kind: 'general', description: 'General-purpose tasks of no specific kind.', provider: 'ollama', model: '', tools: [], turnBudget: 20, enabled: true },
  { id: 'data', label: 'Data', kind: 'data', description: 'Compute and process data, write results to a new file.', provider: 'ollama', model: '', tools: ['read_file', 'write_file', 'list_files', 'shell_exec'], turnBudget: 25, enabled: true },
];

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function formatTimeout(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

interface Props {
  onBack: () => void;
}

export default function EvalV111View({ onBack }: Props) {
  const t = useT();
  const [tasks, setTasks] = useState<CatalogTask[]>(FALLBACK_TASKS);
  const [profiles, setProfiles] = useState<CatalogProfile[]>(FALLBACK_PROFILES);
  const [selectedTaskId, setSelectedTaskId] = useState(FALLBACK_TASKS[0].id);
  const [selectedProfileId, setSelectedProfileId] = useState(FALLBACK_PROFILES[0].id);
  const [ipcAvailable, setIpcAvailable] = useState(false);

  const load = useCallback(async () => {
    const [taskList, profileList] = await Promise.all([
      callOpenBot<CatalogTask[]>('evalV111:listTasks', 'listEvalV111Tasks'),
      callOpenBot<CatalogProfile[]>('evalV111:listProfiles', 'listEvalV111Profiles'),
    ]);
    if (taskList && taskList.length > 0) {
      setTasks(taskList);
      setSelectedTaskId((current) => (taskList.some((task) => task.id === current) ? current : taskList[0].id));
      setIpcAvailable(true);
    }
    if (profileList && profileList.length > 0) {
      setProfiles(profileList);
      setSelectedProfileId((current) => (profileList.some((p) => p.id === current) ? current : profileList[0].id));
      setIpcAvailable(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const selectedProfile = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0];

  return (
    <div className="view">
      <div className="view-header">
        <button type="button" className="btn-ghost" onClick={onBack}>
          {t('evalV111.back')}
        </button>
        <h2>{t('evalV111.title')}</h2>
      </div>
      <p className="muted">{t('evalV111.intro')}</p>
      {!ipcAvailable ? <p className="notice">{t('evalV111.noIpc')}</p> : null}
      <p className="muted">{t('evalV111.sandboxNote')}</p>

      <h3>
        {t('evalV111.tasks')} ({t('evalV111.taskCount', { count: tasks.length })})
      </h3>
      {tasks.length === 0 ? (
        <p className="muted">{t('evalV111.noTasks')}</p>
      ) : (
        <div className="eval-v111-list">
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={task.id === selectedTaskId ? 'eval-v111-item selected' : 'eval-v111-item'}
              onClick={() => setSelectedTaskId(task.id)}
            >
              <strong>{task.name}</strong>
              <span className="muted">
                {t('evalV111.taskKind')}: {task.kind}
              </span>
            </button>
          ))}
        </div>
      )}
      {selectedTask ? (
        <div className="eval-v111-detail">
          <p>
            <strong>{selectedTask.name}</strong> — {selectedTask.description}
          </p>
          <p className="muted">
            {t('evalV111.taskTests')}:{' '}
            {selectedTask.tests.map((test) => `${test.name} (${test.weight})`).join(', ')} — {t('evalV111.taskTimeout')}{' '}
            {formatTimeout(selectedTask.timeoutMs)}
          </p>
        </div>
      ) : null}

      <h3>
        {t('evalV111.profiles')} ({t('evalV111.profileCount', { count: profiles.length })})
      </h3>
      {profiles.length === 0 ? (
        <p className="muted">{t('evalV111.noProfiles')}</p>
      ) : (
        <div className="eval-v111-list">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className={profile.id === selectedProfileId ? 'eval-v111-item selected' : 'eval-v111-item'}
              onClick={() => setSelectedProfileId(profile.id)}
            >
              <strong>{profile.label}</strong>
              <span className="muted">
                {t('evalV111.profileKind')}: {profile.kind} ·{' '}
                {profile.enabled ? t('evalV111.profileEnabled') : t('evalV111.profileDisabled')}
              </span>
            </button>
          ))}
        </div>
      )}
      {selectedProfile ? (
        <div className="eval-v111-detail">
          <p>
            <strong>{selectedProfile.label}</strong> — {selectedProfile.description}
          </p>
          <p className="muted">
            {t('evalV111.profileModel')}: {selectedProfile.provider}/
            {selectedProfile.model === '' ? t('evalV111.profileRegistryDefault') : selectedProfile.model}
          </p>
          <p className="muted">
            {t('evalV111.profileTools')}:{' '}
            {selectedProfile.tools.length === 0 ? '—' : selectedProfile.tools.join(', ')}
          </p>
        </div>
      ) : null}

      <h3>{t('evalV111.howToRun')}</h3>
      <p className="muted">{t('evalV111.howToRunBody')}</p>
      <p className="muted">{t('evalV111.rolloutNote')}</p>
    </div>
  );
}
