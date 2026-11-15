import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Coding agent v4 sub-agent task visualizer (v1.11, Team T4).
 *
 * Renders the live sub-agent task tree inside chat: one row per task
 * with depth indent, status badge, progress bar, model and tokens.
 * Click a row to open its detail (log tail, children, error) below
 * the tree. A model-switch banner shows the current model and the
 * switch history of the session.
 *
 * The host maps the core snapshot (CodingV4TaskTreeSnapshot) into
 * the plain view shape below; the component itself never imports
 * @open-bot/core. All display strings go through t() (no hard-coded
 * locale strings, comments included).
 */

export type CodingV4TreeNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface CodingV4TreeNodeView {
  id: string;
  title: string;
  detail?: string;
  status: CodingV4TreeNodeStatus;
  progress: number;
  log: string[];
  logTruncated: number;
  model?: string;
  tokensUsed?: number;
  error?: string;
  children: CodingV4TreeNodeView[];
}

export interface CodingV4TreeSnapshotView {
  version: number;
  root: CodingV4TreeNodeView;
  counts: Record<CodingV4TreeNodeStatus, number>;
  totalNodes: number;
  overallProgress: number;
}

export interface CodingV4ModelSwitchView {
  currentModel: string;
  previousModel?: string;
  switchCount: number;
  lastSwitchAt?: string;
  lastReason?: string;
}

interface Props {
  /** Nested sub-agent snapshot (host maps the core snapshot into this shape). */
  snapshot: CodingV4TreeSnapshotView | null;
  /** Model-switch banner of the same session (optional). */
  modelSwitch?: CodingV4ModelSwitchView | null;
  /** Called when the user picks a task (host may open a detail view). */
  onSelectTask?: (taskId: string) => void;
}

const STATUS_COLORS: Record<CodingV4TreeNodeStatus, string> = {
  pending: '#8b949e',
  running: '#2f81f7',
  done: '#3fb950',
  failed: '#f85149',
  cancelled: '#d29922',
};

interface FlatRow {
  node: CodingV4TreeNodeView;
  depth: number;
}

function flatten(node: CodingV4TreeNodeView, depth: number, out: FlatRow[]): void {
  out.push({ node, depth });
  for (const child of node.children) flatten(child, depth + 1, out);
}

function findNode(node: CodingV4TreeNodeView, id: string): CodingV4TreeNodeView | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function CodingV4ModelSwitchBanner({ modelSwitch }: { modelSwitch: CodingV4ModelSwitchView }) {
  const t = useT();
  return (
    <div className="coding-v4-model-switch">
      <p>
        {t('codingV4.modelSwitch')}: {t('codingV4.currentModel', { model: modelSwitch.currentModel })}
        {modelSwitch.previousModel
          ? ` · ${t('codingV4.previousModel', { model: modelSwitch.previousModel })}`
          : ''}
        {` · ${t('codingV4.switchCount', { count: modelSwitch.switchCount })}`}
      </p>
      {modelSwitch.lastSwitchAt && (
        <p>
          {t('codingV4.lastSwitch', { at: modelSwitch.lastSwitchAt })}
          {modelSwitch.lastReason ? ` · ${t('codingV4.switchReason', { reason: modelSwitch.lastReason })}` : ''}
        </p>
      )}
    </div>
  );
}

export default function CodingV4SubagentTree({ snapshot, modelSwitch = null, onSelectTask }: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const all: FlatRow[] = [];
    flatten(snapshot.root, 0, all);
    const hidden = new Set<string>();
    const visible: FlatRow[] = [];
    for (const row of all) {
      if (hidden.has(row.node.id)) continue;
      visible.push(row);
      if (collapsed.has(row.node.id)) {
        const markHidden = (n: CodingV4TreeNodeView): void => {
          for (const child of n.children) {
            hidden.add(child.id);
            markHidden(child);
          }
        };
        markHidden(row.node);
      }
    }
    return visible;
  }, [snapshot, collapsed]);

  const selected = useMemo(
    () => (snapshot && selectedId ? findNode(snapshot.root, selectedId) : null),
    [snapshot, selectedId],
  );

  if (!snapshot) {
    return (
      <div className="coding-v4-subagent-tree">
        <h3>{t('codingV4.subagentTree')}</h3>
        <p>{t('codingV4.emptyTree')}</p>
      </div>
    );
  }

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const select = (id: string): void => {
    setSelectedId((prev) => (prev === id ? null : id));
    if (onSelectTask) onSelectTask(id);
  };

  return (
    <div className="coding-v4-subagent-tree">
      <h3>{t('codingV4.subagentTree')}</h3>
      {modelSwitch && <CodingV4ModelSwitchBanner modelSwitch={modelSwitch} />}
      <p>
        {t('codingV4.nodes', { count: snapshot.totalNodes })}
        {' · '}
        {t('codingV4.overallProgress', { percent: snapshot.overallProgress })}
      </p>
      <p>
        {t('codingV4.pending')}: {snapshot.counts.pending}
        {' · '}
        {t('codingV4.running')}: {snapshot.counts.running}
        {' · '}
        {t('codingV4.done')}: {snapshot.counts.done}
        {' · '}
        {t('codingV4.failed')}: {snapshot.counts.failed}
        {' · '}
        {t('codingV4.cancelled')}: {snapshot.counts.cancelled}
      </p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {rows.map(({ node, depth }) => (
          <li key={node.id} style={{ marginLeft: depth * 16 }}>
            <button
              type="button"
              onClick={() => select(node.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
              aria-expanded={node.children.length > 0 ? !collapsed.has(node.id) : undefined}
            >
              <span style={{ color: STATUS_COLORS[node.status] }}>
                {t(`codingV4.${node.status}`)}
              </span>
              {' '}
              {node.children.length > 0 && (
                <span onClick={(e) => { e.stopPropagation(); toggle(node.id); }}>
                  {collapsed.has(node.id) ? '[+]' : '[-]'}
                </span>
              )}
              {' '}
              <strong>{node.title}</strong>
              {` — ${node.progress}%`}
              {node.model ? ` (${node.model})` : ''}
              {node.tokensUsed !== undefined ? ` · ${t('codingV4.tokens', { used: node.tokensUsed })}` : ''}
            </button>
            <span
              style={{
                display: 'inline-block',
                width: 80,
                height: 6,
                background: '#30363d',
                marginLeft: 8,
                verticalAlign: 'middle',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: `${Math.min(100, Math.max(0, node.progress))}%`,
                  height: '100%',
                  background: STATUS_COLORS[node.status],
                }}
              />
            </span>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="coding-v4-task-detail">
          <h4>{t('codingV4.detail')}</h4>
          <p>
            <strong>{selected.title}</strong>
            {` — ${t(`codingV4.${selected.status}`)} · ${selected.progress}%`}
          </p>
          {selected.detail && <p>{selected.detail}</p>}
          {selected.model && <p>{t('codingV4.model')}: {selected.model}</p>}
          {selected.tokensUsed !== undefined && <p>{t('codingV4.tokens', { used: selected.tokensUsed })}</p>}
          {selected.error && <p>{selected.error}</p>}
          <p>{t('codingV4.log')}:</p>
          {selected.log.length === 0 ? (
            <p>{t('codingV4.noLog')}</p>
          ) : (
            <ul>
              {selected.log.slice(-10).map((line, i) => (
                <li key={`${selected.id}-log-${i}`}>{line}</li>
              ))}
            </ul>
          )}
          {selected.logTruncated > 0 && <p>… ({selected.logTruncated})</p>}
        </div>
      )}
    </div>
  );
}
