import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Protocol v2 panel (v1.17, Team T6) — A2A Agent Cards + delegated
 * tasks, stateless MCP sessions, AG-UI/A2UI/MCP Apps UI layers,
 * UHP harness manifests.
 *
 * Data comes via props (host builds the view-model from core
 * `buildFleetV14ProtocolPanel` via IPC); when there is no host
 * wiring yet it uses an internal demo store — the component never
 * guesses real numbers; the demo is clearly labelled in code.
 */

export interface ProtocolV2AgentView {
  agentId: string;
  name: string;
  description: string;
  endpoint: string;
  skills: string[];
  status: string;
  lastSeenAt: number;
}

export interface ProtocolV2TaskView {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  status: string;
  artifactCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProtocolV2SessionView {
  sessionId: string;
  serverName: string;
  transport: string;
  requestCount: number;
  errorCount: number;
  lastRequestAt: number;
}

export interface ProtocolV2UiLayerView {
  kind: 'ag-ui' | 'a2ui' | 'mcp-apps';
  name: string;
  enabled: boolean;
  eventCount: number;
  lastEventAt: number;
}

export interface ProtocolV2ManifestView {
  manifestId: string;
  name: string;
  model: string;
  skillCount: number;
  mcpServerCount: number;
  restrictionCount: number;
  updatedAt: number;
}

export interface ProtocolV2PanelView {
  agents: ProtocolV2AgentView[];
  onlineAgents: number;
  tasks: ProtocolV2TaskView[];
  activeTasks: number;
  sessions: ProtocolV2SessionView[];
  totalRequests: number;
  totalSessionErrors: number;
  uiLayers: ProtocolV2UiLayerView[];
  manifests: ProtocolV2ManifestView[];
  summary: string;
}

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

export function demoProtocolV2Panel(): ProtocolV2PanelView {
  return {
    agents: [
      {
        agentId: 'a1', name: 'planner', description: 'Demo: plans tasks.', endpoint: 'http://127.0.0.1:9001',
        skills: ['plan'], status: 'online', lastSeenAt: T0,
      },
    ],
    onlineAgents: 1,
    tasks: [
      { taskId: 't1', fromAgentId: 'a1', toAgentId: 'a2', status: 'running', artifactCount: 2, createdAt: T0, updatedAt: T0 },
    ],
    activeTasks: 1,
    sessions: [
      { sessionId: 's1', serverName: 'fs', transport: 'stdio', requestCount: 10, errorCount: 1, lastRequestAt: T0 },
    ],
    totalRequests: 10,
    totalSessionErrors: 1,
    uiLayers: [
      { kind: 'ag-ui', name: 'AG-UI stream', enabled: true, eventCount: 40, lastEventAt: T0 },
      { kind: 'a2ui', name: 'A2UI renderer', enabled: true, eventCount: 12, lastEventAt: T0 },
      { kind: 'mcp-apps', name: 'MCP Apps', enabled: false, eventCount: 0, lastEventAt: 0 },
    ],
    manifests: [
      { manifestId: 'm1', name: 'Demo: default harness', model: 'qwen3-8b', skillCount: 3, mcpServerCount: 2, restrictionCount: 1, updatedAt: T0 },
    ],
    summary: 'Demo: protocol v2: 1 A2A agent (1 online), 1 delegated task, 1 stateless MCP session (10 requests), 2/3 UI layers enabled, 1 harness manifest.',
  };
}

export default function ProtocolV2Panel({
  panel: panelProp,
}: {
  panel?: ProtocolV2PanelView | null;
}) {
  const t = useT();
  const [panel] = useState<ProtocolV2PanelView>(() => panelProp ?? demoProtocolV2Panel());

  return (
    <div>
      <h3>{t('fleetV14.protocolTitle')}</h3>
      <p>{panel.summary}</p>
      <p>{t('fleetV14.demo')}</p>
      <h4>{t('fleetV14.protocolAgents')} ({panel.agents.length})</h4>
      {panel.agents.length === 0 ? (
        <p>{t('fleetV14.protocolNoAgents')}</p>
      ) : (
        <ul>
          {panel.agents.map((a) => (
            <li key={a.agentId}>
              {a.name} — {a.status} ({t('fleetV14.protocolOnline')}: {panel.onlineAgents}) — {t('fleetV14.protocolEndpoint')}: {a.endpoint} — {t('fleetV14.protocolSkills')}: {a.skills.join(', ') || '—'}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.protocolTasks')} ({panel.tasks.length})</h4>
      {panel.tasks.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.tasks.map((task) => (
            <li key={task.taskId}>
              {task.taskId}: {task.fromAgentId} → {task.toAgentId} — {task.status} — {task.artifactCount} artifacts
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.protocolSessions')} ({panel.sessions.length})</h4>
      {panel.sessions.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.sessions.map((s) => (
            <li key={s.sessionId}>
              {s.serverName} ({s.transport}) — {t('fleetV14.protocolRequests')}: {s.requestCount} — {t('fleetV14.protocolErrors')}: {s.errorCount}
            </li>
          ))}
        </ul>
      )}

      <h4>{t('fleetV14.protocolUiLayers')} ({panel.uiLayers.length})</h4>
      <ul>
        {panel.uiLayers.map((l) => (
          <li key={l.kind}>
            {l.name} ({l.kind}) — {l.enabled ? 'enabled' : 'disabled'} — {l.eventCount} events
          </li>
        ))}
      </ul>

      <h4>{t('fleetV14.protocolManifests')} ({panel.manifests.length})</h4>
      {panel.manifests.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {panel.manifests.map((m) => (
            <li key={m.manifestId}>
              {m.name} — {m.model} — {m.skillCount} skills, {m.mcpServerCount} MCP servers, {m.restrictionCount} restrictions
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
