import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Fleet v26 dashboard (v1.39, Team T6) — the single entry screen for
 * the v26 panel group. Progressive disclosure: the top shows one
 * summary line per area (resources, bots, health, shared blocks,
 * skills, hooks, plugins, MCP Apps, memory, settings); each tab
 * expands its own detail on demand. Nothing here is dense by
 * default — advanced detail lives one click away, behind its tab.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV26Dashboard` via IPC); when there is no host wiring yet
 * it uses an internal demo store — the component never guesses real
 * numbers; the demo is clearly labelled in code.
 */

export type FleetV26DashboardTab =
  | 'overview'
  | 'resources'
  | 'bots'
  | 'health'
  | 'blocks'
  | 'skills'
  | 'hooks'
  | 'plugins'
  | 'apps'
  | 'memory'
  | 'settings';

export interface FleetV26DashboardView {
  summary: string;
  resources: { summary: string; remainingCpuCores: number; remainingRamMB: number; remainingDiskMB: number | null; grantedBots: number };
  bots: { summary: string; counts: { total: number; running: number; paused: number; failed: number } };
  health: { summary: string; band: string; averageScore: number | null };
  sharedBlocks: { summary: string; counts: { blocks: number; attachedBots: number; leased: number } };
  skills: { summary: string; counts: { skills: number; metadataTokens: number; bodiesLoaded: number } };
  hooks: { summary: string; counts: { hooks: number; enabled: number } };
  plugins: { summary: string; counts: { plugins: number; enabled: number; unsigned: number } };
  mcpApps: { summary: string; counts: { resources: number; servers: number } };
  memory: { summary: string; nodes: number; pending: number; orphans: number };
  settings: { summary: string };
}

export function demoFleetV26Dashboard(): FleetV26DashboardView {
  return {
    summary: 'Demo fleet v26 dashboard (no host wiring yet).',
    resources: { summary: '8 cores / 16384 MiB RAM host; reserve 2 cores + 4096 MiB; 1 bot(s) hold 1 cores + 1024 MiB; 5 cores + 11264 MiB + disk unknown left', remainingCpuCores: 5, remainingRamMB: 11264, remainingDiskMB: null, grantedBots: 1 },
    bots: { summary: '2 bot(s): 1 running, 0 paused, 0 starting, 0 stopped, 0 failed, 1 registered (0 removed)', counts: { total: 2, running: 1, paused: 0, failed: 0 } },
    health: { summary: 'Fleet healthy (avg score 95): 1 healthy, 0 degraded, 0 unhealthy, 1 unknown of 2 bot(s)', band: 'healthy', averageScore: 95 },
    sharedBlocks: { summary: '1 shared block(s), 2 attachment(s), 0 leased, 2 version(s) in history (search via local-fallback)', counts: { blocks: 1, attachedBots: 2, leased: 0 } },
    skills: { summary: '2 skill(s) in the pack, ~24 metadata tokens at startup, 0 bod(ies) loaded on demand, 1 lazy file(s)', counts: { skills: 2, metadataTokens: 24, bodiesLoaded: 0 } },
    hooks: { summary: '1 hook(s) (1 enabled: 1 PreToolUse, 0 PostToolUse, 0 Stop); 0 evaluation(s): 0 denied, 0 asked, 0 allowed', counts: { hooks: 1, enabled: 1 } },
    plugins: { summary: '0 plugin(s) (0 enabled): 0 skill(s), 0 hook(s), 0 MCP server(s) bundled; 0 unsigned', counts: { plugins: 0, enabled: 0, unsigned: 0 } },
    mcpApps: { summary: 'MCP Apps enabled: 1 resource(s) from 1 server(s), 0 declared domain(s); default policy ask, 0 trusted / 0 blocked server(s)', counts: { resources: 1, servers: 1 } },
    memory: { summary: 'MemFS: 3 node(s) (1 folders, 2 facts, 0 blocks), 1 with evidence, 2 without; admission 1 admitted / 1 pending / 0 denied; max depth 1', nodes: 3, pending: 1, orphans: 1 },
    settings: { summary: 'Admission (default ask; memory-v24:ask, mcp-app:ask, skill-pack:ask, plugin:ask, operator:auto; evidence for memory required)' },
  };
}

const TABS: FleetV26DashboardTab[] = [
  'overview', 'resources', 'bots', 'health', 'blocks',
  'skills', 'hooks', 'plugins', 'apps', 'memory', 'settings',
];


export default function FleetV26Dashboard({ dashboard }: { dashboard?: FleetV26DashboardView }) {
  const t = useT();
  const view = useMemo(() => dashboard ?? demoFleetV26Dashboard(), [dashboard]);
  const [tab, setTab] = useState<FleetV26DashboardTab>('overview');
  const [expanded, setExpanded] = useState(false);

  const rows: Array<{ key: FleetV26DashboardTab; label: string; summary: string }> = [
    { key: 'resources', label: t('fleet.v26.resources'), summary: view.resources.summary },
    { key: 'bots', label: t('fleet.v26.bots'), summary: view.bots.summary },
    { key: 'health', label: t('fleet.v26.health'), summary: view.health.summary },
    { key: 'blocks', label: t('fleet.v26.sharedBlocks'), summary: view.sharedBlocks.summary },
    { key: 'skills', label: t('fleet.v26.skillPack'), summary: view.skills.summary },
    { key: 'hooks', label: t('fleet.v26.hooks'), summary: view.hooks.summary },
    { key: 'plugins', label: t('fleet.v26.plugins'), summary: view.plugins.summary },
    { key: 'apps', label: t('fleet.v26.mcpApps'), summary: view.mcpApps.summary },
    { key: 'memory', label: t('fleet.v26.memory'), summary: view.memory.summary },
    { key: 'settings', label: t('fleet.v26.settings'), summary: view.settings.summary },
  ];

  return (
    <section aria-label={t('fleet.v26.title')} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('fleet.v26.title')}</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{view.summary}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>
          {t('fleet.v26.healthBand', { band: view.health.band })} · {t('fleet.v26.botsRunning', { count: view.bots.counts.running })}
        </span>
      </header>

      <nav aria-label={t('fleet.v26.sections')} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => { setTab(key); setExpanded(false); }}
            style={{
              padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border, #ccc)',
              background: tab === key ? 'var(--hatch-widget-accent, #2f6feb)' : 'transparent',
              color: tab === key ? 'var(--hatch-widget-on-accent, #fff)' : 'inherit',
              cursor: 'pointer',
            }}
          >
            {t(`fleet.v26.tab.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row) => (
            <li key={row.key} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '8px 10px' }}>
              <button type="button" onClick={() => setTab(row.key)} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
                <strong>{row.label}</strong>
                <span style={{ display: 'block', fontSize: 13, opacity: 0.85 }}>{row.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <article style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '10px 12px' }}>
          <h3 style={{ margin: '0 0 6px' }}>{t(`fleet.v26.tab.${tab}`)}</h3>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>
            {rows.find((r) => r.key === tab)?.summary ?? view.summary}
          </p>
          {tab === 'resources' ? (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 13 }}>
              <dt>{t('fleet.v26.remainingCpu')}</dt><dd style={{ margin: 0 }}>{view.resources.remainingCpuCores}</dd>
              <dt>{t('fleet.v26.remainingRam')}</dt><dd style={{ margin: 0 }}>{view.resources.remainingRamMB} MiB</dd>
              <dt>{t('fleet.v26.remainingDisk')}</dt><dd style={{ margin: 0 }}>{view.resources.remainingDiskMB === null ? t('fleet.v26.diskUnknown') : `${view.resources.remainingDiskMB} MiB`}</dd>
              <dt>{t('fleet.v26.grantedBots')}</dt><dd style={{ margin: 0 }}>{view.resources.grantedBots}</dd>
            </dl>
          ) : null}
          {tab === 'health' ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              {t('fleet.v26.averageScore', { score: view.health.averageScore === null ? 'n/a' : String(view.health.averageScore) })}
            </p>
          ) : null}
          {tab === 'memory' ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              {t('fleet.v26.memoryPendingSummary', { pending: view.memory.pending, orphans: view.memory.orphans })}
            </p>
          ) : null}
          <button type="button" onClick={() => setExpanded((v) => !v)} style={{ marginTop: 8 }}>
            {expanded ? t('fleet.v26.hideDetails') : t('fleet.v26.showDetails')}
          </button>
          {expanded ? (
            <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 13 }}>
              {tab === 'bots' ? (<><dt>{t('fleet.v26.botsTotal')}</dt><dd style={{ margin: 0 }}>{view.bots.counts.total}</dd><dt>{t('fleet.v26.botsFailed')}</dt><dd style={{ margin: 0 }}>{view.bots.counts.failed}</dd></>) : null}
              {tab === 'blocks' ? (<><dt>{t('fleet.v26.blocksTotal')}</dt><dd style={{ margin: 0 }}>{view.sharedBlocks.counts.blocks}</dd><dt>{t('fleet.v26.blocksLeased')}</dt><dd style={{ margin: 0 }}>{view.sharedBlocks.counts.leased}</dd></>) : null}
              {tab === 'skills' ? (<><dt>{t('fleet.v26.skillsTotal')}</dt><dd style={{ margin: 0 }}>{view.skills.counts.skills}</dd><dt>{t('fleet.v26.skillsMetadataTokens')}</dt><dd style={{ margin: 0 }}>~{view.skills.counts.metadataTokens}</dd></>) : null}
              {tab === 'hooks' ? (<><dt>{t('fleet.v26.hooksTotal')}</dt><dd style={{ margin: 0 }}>{view.hooks.counts.hooks}</dd><dt>{t('fleet.v26.hooksEnabled')}</dt><dd style={{ margin: 0 }}>{view.hooks.counts.enabled}</dd></>) : null}
              {tab === 'plugins' ? (<><dt>{t('fleet.v26.pluginsTotal')}</dt><dd style={{ margin: 0 }}>{view.plugins.counts.plugins}</dd><dt>{t('fleet.v26.pluginsUnsigned')}</dt><dd style={{ margin: 0 }}>{view.plugins.counts.unsigned}</dd></>) : null}
              {tab === 'apps' ? (<><dt>{t('fleet.v26.appsTotal')}</dt><dd style={{ margin: 0 }}>{view.mcpApps.counts.resources}</dd><dt>{t('fleet.v26.appsServers')}</dt><dd style={{ margin: 0 }}>{view.mcpApps.counts.servers}</dd></>) : null}
              {tab === 'memory' ? (<><dt>{t('fleet.v26.memoryNodes')}</dt><dd style={{ margin: 0 }}>{view.memory.nodes}</dd></>) : null}
              {tab === 'settings' ? (<><dt>{t('fleet.v26.settingsHint')}</dt><dd style={{ margin: 0 }}>{view.settings.summary}</dd></>) : null}
            </dl>
          ) : null}
        </article>
      )}
    </section>
  );
}
