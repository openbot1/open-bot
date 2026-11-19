import { useState, type ReactElement } from 'react';
import { useT } from '../i18n/useT';

/**
 * A2A v1.0 panel (v1.42, Team T1) — peer registry + task board +
 * audit chain status for the new A2A v1.0 generation.
 *
 * The panel is a PROJECTION: the core owns peers, tasks, and the
 * audit log (`V11PeerRegistry`, `V11TaskStore`, `V11AuditLog`); this
 * component only renders the snapshot the host hands it. It never
 * fetches, never signs, never allowlists by itself — allowlist /
 * blocklist are user decisions the host wires to callbacks.
 * Progressive disclosure: counts + peers first, tasks behind a tab,
 * audit behind a second tab. All strings come from the `a2aV11.*`
 * i18n keys (6 locales).
 *
 * NOTE: `useT()` returns the translate function directly — do NOT
 * destructure it (`const { t } = useT()` is a type error).
 */

export interface A2aV11PeerRowView {
  id: string;
  name: string;
  url: string;
  status: 'registered' | 'allowlisted' | 'blocklisted' | 'suspended';
  signatureVerified: boolean;
  signed: boolean;
  trustScore: number;
  guardBlocks: number;
  successfulDelegations: number;
}

export interface A2aV11TaskRowView {
  id: string;
  contextId: string;
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'cancelled' | 'rejected';
  peerId?: string;
  updatedAt: string;
  summary: string;
}

export interface A2aV11PanelView {
  peers: A2aV11PeerRowView[];
  tasks: A2aV11TaskRowView[];
  auditEntries: number;
  auditChainOk: boolean | null;
  usablePeers: number;
  awaitingInput: number;
}

export interface A2aV11PanelProps {
  view: A2aV11PanelView;
  /** User decision: allowlist a peer (host confirms + audits). */
  onAllowlist?: (peerId: string) => void;
  /** User decision: blocklist a peer (host confirms + audits). */
  onBlocklist?: (peerId: string) => void;
  /** Cancel a task (host drives the server). */
  onCancelTask?: (taskId: string) => void;
  /** Resume an input-required task (host asks the user for input). */
  onResumeTask?: (taskId: string) => void;
  /** Delegate a message (host drives the delegation gate). */
  onDelegate?: (peerId: string, text: string) => void;
}

export function demoA2aV11Panel(): A2aV11PanelView {
  return {
    peers: [
      {
        id: 'helper-bot@127.0.0.1-9001',
        name: 'helper-bot',
        url: 'http://127.0.0.1:9001/',
        status: 'allowlisted',
        signatureVerified: true,
        signed: true,
        trustScore: 77,
        guardBlocks: 0,
        successfulDelegations: 3,
      },
      {
        id: 'sneaky-bot@127.0.0.1-9003',
        name: 'sneaky-bot',
        url: 'http://127.0.0.1:9003/',
        status: 'suspended',
        signatureVerified: false,
        signed: false,
        trustScore: 5,
        guardBlocks: 3,
        successfulDelegations: 0,
      },
    ],
    tasks: [
      {
        id: 'task-v11-demo-1',
        contextId: 'ctx-demo',
        state: 'completed',
        peerId: 'helper-bot@127.0.0.1-9001',
        updatedAt: '2026-11-19T01:00:00.000Z',
        summary: 'echo: please help',
      },
      {
        id: 'task-v11-demo-2',
        contextId: 'ctx-demo',
        state: 'input-required',
        peerId: 'helper-bot@127.0.0.1-9001',
        updatedAt: '2026-11-19T01:05:00.000Z',
        summary: 'Which date?',
      },
    ],
    auditEntries: 12,
    auditChainOk: true,
    usablePeers: 1,
    awaitingInput: 1,
  };
}

function stateKey(state: A2aV11TaskRowView['state']): string {
  switch (state) {
    case 'submitted':
      return 'a2aV11.stateSubmitted';
    case 'working':
      return 'a2aV11.stateWorking';
    case 'input-required':
      return 'a2aV11.stateInputRequired';
    case 'completed':
      return 'a2aV11.stateCompleted';
    case 'failed':
      return 'a2aV11.stateFailed';
    case 'cancelled':
      return 'a2aV11.stateCancelled';
    case 'rejected':
      return 'a2aV11.stateRejected';
    default:
      return 'a2aV11.stateSubmitted';
  }
}

function statusKey(status: A2aV11PeerRowView['status']): string {
  switch (status) {
    case 'allowlisted':
      return 'a2aV11.allowlisted';
    case 'registered':
      return 'a2aV11.registered';
    case 'blocklisted':
      return 'a2aV11.blocklisted';
    case 'suspended':
      return 'a2aV11.suspended';
    default:
      return 'a2aV11.registered';
  }
}

export function A2aV11Panel(props: A2aV11PanelProps): ReactElement {
  const t = useT();
  const { view } = props;
  const [tab, setTab] = useState<'peers' | 'tasks' | 'audit'>('peers');
  const [delegateText, setDelegateText] = useState('');
  const [delegatePeerId, setDelegatePeerId] = useState<string | null>(null);

  return (
    <section aria-label={t('a2aV11.title')}>
      <header>
        <h2>{t('a2aV11.title')}</h2>
        <p>{t('a2aV11.subtitle')}</p>
      </header>

      <nav aria-label={t('a2aV11.title')}>
        <button type="button" onClick={() => setTab('peers')} aria-pressed={tab === 'peers'}>
          {t('a2aV11.peers')} ({view.peers.length})
        </button>
        <button type="button" onClick={() => setTab('tasks')} aria-pressed={tab === 'tasks'}>
          {t('a2aV11.taskBoard')} ({view.tasks.length})
        </button>
        <button type="button" onClick={() => setTab('audit')} aria-pressed={tab === 'audit'}>
          {t('a2aV11.auditLog')} ({view.auditEntries})
        </button>
      </nav>

      {tab === 'peers' && (
        <div>
          {view.peers.length === 0 ? (
            <p>{t('a2aV11.peerEmpty')}</p>
          ) : (
            <ul>
              {view.peers.map((peer) => (
                <li key={peer.id}>
                  <strong>{peer.name}</strong> <span>{peer.url}</span>
                  <span> — {t(statusKey(peer.status))}</span>
                  <span>
                    {' '}
                    —{' '}
                    {peer.signatureVerified
                      ? t('a2aV11.signatureVerified')
                      : peer.signed
                        ? t('a2aV11.signatureUnverified')
                        : t('a2aV11.unsigned')}
                  </span>
                  <span>
                    {' '}
                    — {t('a2aV11.trustScore')}: {peer.trustScore}
                  </span>
                  <span>
                    {' '}
                    — {t('a2aV11.guardBlocks')}: {peer.guardBlocks}
                  </span>
                  <span>
                    {peer.status === 'registered' && props.onAllowlist && (
                      <button type="button" onClick={() => props.onAllowlist?.(peer.id)}>
                        {t('a2aV11.allowlist')}
                      </button>
                    )}
                    {peer.status !== 'blocklisted' && props.onBlocklist && (
                      <button type="button" onClick={() => props.onBlocklist?.(peer.id)}>
                        {t('a2aV11.blocklist')}
                      </button>
                    )}
                    {peer.status === 'allowlisted' && props.onDelegate && (
                      <button type="button" onClick={() => setDelegatePeerId(peer.id)}>
                        {t('a2aV11.delegate')}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {delegatePeerId && props.onDelegate && (
            <div>
              <label>
                {t('a2aV11.delegate')}
                <input
                  type="text"
                  value={delegateText}
                  placeholder={t('a2aV11.delegatePlaceholder')}
                  onChange={(event) => setDelegateText(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={delegateText.trim().length === 0}
                onClick={() => {
                  props.onDelegate?.(delegatePeerId, delegateText);
                  setDelegateText('');
                  setDelegatePeerId(null);
                }}
              >
                {t('a2aV11.sendMessage')}
              </button>
              <button type="button" onClick={() => setDelegatePeerId(null)}>
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'tasks' && (
        <div>
          {view.tasks.length === 0 ? (
            <p>{t('a2aV11.taskEmpty')}</p>
          ) : (
            <ul>
              {view.tasks.map((task) => (
                <li key={task.id}>
                  <strong>{task.id}</strong>
                  <span> — {t(stateKey(task.state))}</span>
                  {task.peerId && <span> — {task.peerId}</span>}
                  <span> — {task.summary}</span>
                  <span>
                    {task.state === 'input-required' && props.onResumeTask && (
                      <button type="button" onClick={() => props.onResumeTask?.(task.id)}>
                        {t('a2aV11.resumeTask')}
                      </button>
                    )}
                    {(task.state === 'submitted' || task.state === 'working' || task.state === 'input-required') &&
                      props.onCancelTask && (
                        <button type="button" onClick={() => props.onCancelTask?.(task.id)}>
                          {t('a2aV11.cancelTask')}
                        </button>
                      )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <div>
          <p>
            {t('a2aV11.stats')}: {view.auditEntries} ·{' '}
            {view.auditChainOk === null
              ? '—'
              : view.auditChainOk
                ? t('a2aV11.chainOk')
                : t('a2aV11.chainBroken')}
          </p>
          {view.auditEntries === 0 && <p>{t('a2aV11.auditEmpty')}</p>}
          <p>
            {t('a2aV11.peers')}: {view.usablePeers} {t('a2aV11.allowlisted')} · {t('a2aV11.stateInputRequired')}:{' '}
            {view.awaitingInput}
          </p>
        </div>
      )}
    </section>
  );
}
