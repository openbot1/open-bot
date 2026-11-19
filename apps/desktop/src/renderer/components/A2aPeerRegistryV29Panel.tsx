import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * A2A peer registry panel — fleet v29 (v1.42, Team T6).
 *
 * Every A2A peer the fleet knows: its Agent Card (name, URL, skills),
 * card verification status, reachability, and health (score, p50/p95
 * latency, error rate, cost). A peer whose card is `invalid`,
 * `stale`, or `unverified` cannot be delegated to — the panel shows
 * that block plainly instead of hiding it behind a green dot.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV29PeerPanel` via IPC); with no host wiring yet it uses
 * an internal demo store — the component never guesses real numbers,
 * and the demo is clearly labelled in code.
 */

export type A2aPeerV29CardStatus = 'verified' | 'unsigned' | 'invalid' | 'unverified' | 'stale';

export interface A2aPeerRegistryV29PeerView {
  peerId: string;
  name: string;
  description: string;
  url: string;
  version?: string;
  protocolVersion?: string;
  skills: string[];
  tags: string[];
  cardStatus: A2aPeerV29CardStatus;
  verifyProblems: string[];
  verifiedAt: string | null;
  lastSeenAt: string | null;
  reachable: boolean;
  consecutiveFailures: number;
}

export interface A2aPeerRegistryV29HealthView {
  peerId: string;
  score: number;
  level: 'healthy' | 'degraded' | 'down' | 'unknown';
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number;
  totalCostUsd: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
}

export interface A2aPeerRegistryV29PanelView {
  summary: string;
  peers: A2aPeerRegistryV29PeerView[];
  health: A2aPeerRegistryV29HealthView[];
  verifiedCount: number;
  unverifiedCount: number;
}

export function demoA2aPeerRegistryV29Panel(): A2aPeerRegistryV29PanelView {
  return {
    summary: 'Demo peer registry (no host wiring yet).',
    peers: [
      {
        peerId: 'peer-research',
        name: 'Research Agent',
        description: 'Web research and summarisation.',
        url: 'http://127.0.0.1:4101/',
        version: '1.2.0',
        protocolVersion: '1.0.1',
        skills: ['research', 'summarise'],
        tags: ['research'],
        cardStatus: 'verified',
        verifyProblems: [],
        verifiedAt: '2026-11-19T00:00:00.000Z',
        lastSeenAt: '2026-11-19T00:05:00.000Z',
        reachable: true,
        consecutiveFailures: 0,
      },
      {
        peerId: 'peer-writer',
        name: 'Writer Agent',
        description: 'Drafts and editing.',
        url: 'http://127.0.0.1:4102/',
        version: '0.9.0',
        protocolVersion: '1.0',
        skills: ['draft', 'edit'],
        tags: ['writing'],
        cardStatus: 'unsigned',
        verifyProblems: [],
        verifiedAt: '2026-11-19T00:00:00.000Z',
        lastSeenAt: null,
        reachable: false,
        consecutiveFailures: 1,
      },
    ],
    health: [
      { peerId: 'peer-research', score: 96, level: 'healthy', p50Ms: 812, p95Ms: 1400, errorRate: 0, totalCostUsd: 0.0546, activeTasks: 1, completedTasks: 12, failedTasks: 0 },
      { peerId: 'peer-writer', score: 65, level: 'unknown', p50Ms: null, p95Ms: null, errorRate: 0, totalCostUsd: 0.011, activeTasks: 1, completedTasks: 3, failedTasks: 1 },
    ],
    verifiedCount: 1,
    unverifiedCount: 1,
  };
}

function healthColor(level: A2aPeerRegistryV29HealthView['level']): string {
  if (level === 'healthy') return '#16a34a';
  if (level === 'degraded') return '#d97706';
  if (level === 'down') return '#c0392b';
  return '#6b7280';
}

export interface A2aPeerRegistryV29PanelProps {
  panel?: A2aPeerRegistryV29PanelView;
  onVerifyPeer?: (peerId: string) => void;
  onRemovePeer?: (peerId: string) => void;
}

export default function A2aPeerRegistryV29Panel({ panel, onVerifyPeer, onRemovePeer }: A2aPeerRegistryV29PanelProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);
  const view = panel ?? demoA2aPeerRegistryV29Panel();
  const healthByPeer = new Map(view.health.map((h) => [h.peerId, h]));
  return (
    <section aria-label={t('fleet.v29.peerTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0 }}>{t('fleet.v29.peerTitle')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{view.summary}</p>
      <p style={{ margin: 0, fontSize: 13 }}>
        {t('fleet.v29.verified')}: {view.verifiedCount} · {t('fleet.v29.unverified')}: {view.unverifiedCount}
      </p>
      {view.peers.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('fleet.v29.noPeers')}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.peers.map((peer) => {
            const health = healthByPeer.get(peer.peerId);
            const isOpen = expanded === peer.peerId;
            const blocked = peer.cardStatus === 'invalid' || peer.cardStatus === 'stale' || peer.cardStatus === 'unverified';
            return (
              <li key={peer.peerId}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : peer.peerId)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
                >
                  <strong>{peer.name}</strong> ({peer.peerId}) — {t(`fleet.v29.card.${peer.cardStatus}`)}
                  {health ? (
                    <>
                      {' · '}
                      <span style={{ color: healthColor(health.level) }}>
                        {t(`fleet.v29.health.${health.level}`)} {health.score}/100
                      </span>
                    </>
                  ) : null}
                  {blocked ? ` — ${t('fleet.v29.delegationBlocked')}` : ''}
                </button>
                {isOpen && (
                  <dl style={{ margin: '4px 0 0', fontSize: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
                    <dt>{t('fleet.v29.peerUrl')}</dt><dd style={{ margin: 0 }}>{peer.url}</dd>
                    <dt>{t('fleet.v29.peerVersion')}</dt><dd style={{ margin: 0 }}>{peer.version ?? '—'} (A2A {peer.protocolVersion ?? '1.0'})</dd>
                    <dt>{t('fleet.v29.peerSkills')}</dt><dd style={{ margin: 0 }}>{peer.skills.length > 0 ? peer.skills.join(', ') : '—'}</dd>
                    <dt>{t('fleet.v29.peerTags')}</dt><dd style={{ margin: 0 }}>{peer.tags.length > 0 ? peer.tags.join(', ') : '—'}</dd>
                    <dt>{t('fleet.v29.reachable')}</dt><dd style={{ margin: 0 }}>{peer.reachable ? t('fleet.v29.yes') : t('fleet.v29.no')}</dd>
                    <dt>{t('fleet.v29.lastSeen')}</dt><dd style={{ margin: 0 }}>{peer.lastSeenAt ?? '—'}</dd>
                    {health && (
                      <>
                        <dt>{t('fleet.v29.latency')}</dt>
                        <dd style={{ margin: 0 }}>p50 {health.p50Ms === null ? '—' : `${health.p50Ms} ms`} · p95 {health.p95Ms === null ? '—' : `${health.p95Ms} ms`}</dd>
                        <dt>{t('fleet.v29.errorRate')}</dt><dd style={{ margin: 0 }}>{(health.errorRate * 100).toFixed(1)}%</dd>
                        <dt>{t('fleet.v29.totalCost')}</dt><dd style={{ margin: 0 }}>${health.totalCostUsd.toFixed(4)}</dd>
                        <dt>{t('fleet.v29.tasks')}</dt>
                        <dd style={{ margin: 0 }}>
                          {t('fleet.v29.activeTasks')}: {health.activeTasks} · {t('fleet.v29.completed')}: {health.completedTasks} · {t('fleet.v29.failed')}: {health.failedTasks}
                        </dd>
                      </>
                    )}
                    {peer.verifyProblems.length > 0 && (
                      <>
                        <dt>{t('fleet.v29.verifyProblems')}</dt>
                        <dd style={{ margin: 0 }}>{peer.verifyProblems.join('; ')}</dd>
                      </>
                    )}
                  </dl>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {onVerifyPeer && (
                    <button type="button" onClick={() => onVerifyPeer(peer.peerId)} style={{ fontSize: 13, cursor: 'pointer' }}>
                      {t('fleet.v29.verifyCard')}
                    </button>
                  )}
                  {onRemovePeer && (
                    <button type="button" onClick={() => onRemovePeer(peer.peerId)} style={{ fontSize: 13, cursor: 'pointer' }}>
                      {t('fleet.v29.removePeer')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
