/**
 * Panels v14 — view-model cho 6 panel riêng của platform/fleet v14
 * (v1.17, Đội T6): Memory v16, Protocol v2, Router v2 (v1.17),
 * Coding agent v9, Voice v16, Fleet v14.
 *
 * Theo pattern panels v13 (`fleetV13/panelsV13.ts`): panel RIÊNG,
 * không nhồi vào màn chat chính (progressive disclosure). Module này
 * chỉ xây VIEW-MODEL thuần (dữ liệu đã lọc/sắp xếp + tóm tắt) từ dữ
 * liệu thật của các tầng dưới; component React ở
 * `apps/desktop/src/renderer/components/*V16Panel.tsx` /
 * `*V2Panel.tsx` / `*V9Panel.tsx` / `*V14Panel.tsx` render từ đó.
 *
 * LƯU Ý: các hệ thống v1.17 (memory v16, protocol v2, router v2,
 * coding v9, voice v16) do các đội T1–T5 xây song song — module này
 * KHÔNG import code của họ (tránh phụ thuộc chéo giữa các worktree).
 * Nó định nghĩa input interface tối thiểu (dạng dữ liệu mà các đội
 * đó sẽ cung cấp qua IPC) và xây view-model từ đó; khi các đội gộp,
 * host chỉ cần map dữ liệu thật vào đúng interface này.
 *
 * - Memory v16 panel: sleep-time consolidation runs (Mem0-style 4
 *   thao tác add/update/delete/drop + entity linking), fact có
 *   validity window (còn hiệu lực / hết hạn / bị supersede),
 *   poisoning guard (quarantine + provenance + nguồn cho phép).
 * - Protocol v2 panel: A2A Agent Card + task delegate, MCP stateless
 *   sessions (spec 2026-07-28), AG-UI/A2UI/MCP Apps UI (3 lớp UI
 *   hợp nhất), UHP harness manifest.
 * - Router v2 panel (v1.17): Architect–Editor routing (planner mạnh
 *   / editor local rẻ), repo map v4 (tree-sitter + PageRank, nén
 *   token), Ollama/LM Studio auto-detect.
 * - Coding v9 panel: AST-aware edit, sandbox execution loop
 *   (edit → test → lặp), git-first atomic commit, eval harness
 *   kiểu SWE-bench nội bộ.
 * - Voice v16 panel: realtime v4 sessions (speech-to-speech,
 *   barge-in, semantic turn-taking), wake-word v4, TTS streaming v2.
 * - Fleet v14 panel: bảng node (đăng ký, health, tải, drain),
 *   capacity, quota user, rollout, polling trigger — gom từ
 *   `fleetV14.ts` + `multiUserV14.ts` / `rolloutV14.ts` /
 *   `composioPollingV14.ts` thành một view-model duy nhất.
 *
 * Tất cả hàm đều thuần, không đọc file, không chạm mạng. Dữ liệu
 * mock chỉ xuất hiện ở component demo — module này không chứa mock.
 */

import type { ComposioV14TriggerCheckpoint } from './composioPollingV14';
import { summarizeComposioV14Trigger } from './composioPollingV14';
import type { FleetV14Snapshot } from './fleetV14';
import { buildFleetV14CapacityReport, fleetV14NodeLoad } from './fleetV14';
import type { TeamV14QuotaState } from './multiUserV14';
import { summarizeTeamV14User } from './multiUserV14';
import type { TeamV14Rollout } from './rolloutV14';
import { summarizeTeamV14Rollout } from './rolloutV14';

// ---------------------------------------------------------------------------
// Memory v16 panel
// ---------------------------------------------------------------------------

/** Một fact memory v16 (có validity window + provenance + quarantine). */
export interface FleetV14MemoryFact {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  /** Epoch ms fact hết hiệu lực (0 = không hết hạn). */
  validUntil: number;
  /** Id fact mới hơn đã thay thế fact này ('' = còn hiệu lực). */
  supersededBy: string;
  quarantined: boolean;
  quarantineReason: string;
  /** Entity đã link (vd `person:Huy`, `tool:slack`). */
  entities: string[];
}

/** Một fact trong panel memory v16 (đã tính trạng thái hiệu lực). */
export interface FleetV14MemoryFactRow {
  id: string;
  text: string;
  confidence: number;
  source: string;
  createdBy: string;
  createdAt: number;
  validUntil: number;
  /** 'active' | 'expired' | 'superseded' | 'quarantined'. */
  status: string;
  supersededBy: string;
  quarantined: boolean;
  quarantineReason: string;
  entities: string[];
}

/** Một lần chạy sleep-time consolidation (Mem0-style 4 thao tác). */
export interface FleetV14ConsolidationRun {
  runId: string;
  at: number;
  /** Số fact add / update / delete / drop trong lần chạy. */
  added: number;
  updated: number;
  deleted: number;
  dropped: number;
  /** Số entity đã link. */
  entitiesLinked: number;
  /** Số fact bị quarantine vì nghi poisoning. */
  quarantined: number;
  durationMs: number;
}

/** View-model panel Memory v16. */
export interface FleetV14MemoryPanel {
  facts: FleetV14MemoryFactRow[];
  totalFacts: number;
  activeCount: number;
  expiredCount: number;
  supersededCount: number;
  quarantinedCount: number;
  runs: FleetV14ConsolidationRun[];
  totalAdded: number;
  totalUpdated: number;
  totalDeleted: number;
  totalDropped: number;
  totalQuarantined: number;
  summary: string;
}

export function fleetV14MemoryFactStatus(fact: FleetV14MemoryFact, now = Date.now()): string {
  if (fact.quarantined) return 'quarantined';
  if (fact.supersededBy !== '') return 'superseded';
  if (fact.validUntil > 0 && fact.validUntil <= now) return 'expired';
  return 'active';
}

/** Xây view-model panel Memory v16 từ fact + consolidation runs. */
export function buildFleetV14MemoryPanel(
  facts: readonly FleetV14MemoryFact[],
  runs: readonly FleetV14ConsolidationRun[],
  now = Date.now(),
): FleetV14MemoryPanel {
  const rows: FleetV14MemoryFactRow[] = facts
    .map((f) => ({
      id: f.id,
      text: f.text,
      confidence: f.confidence,
      source: f.source,
      createdBy: f.createdBy,
      createdAt: f.createdAt,
      validUntil: f.validUntil,
      status: fleetV14MemoryFactStatus(f, now),
      supersededBy: f.supersededBy,
      quarantined: f.quarantined,
      quarantineReason: f.quarantineReason,
      entities: [...f.entities],
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const count = (status: string): number => rows.filter((r) => r.status === status).length;
  const total = (pick: (r: FleetV14ConsolidationRun) => number): number => runs.reduce((s, r) => s + pick(r), 0);
  const totalQuarantined = total((r) => r.quarantined);
  return {
    facts: rows,
    totalFacts: rows.length,
    activeCount: count('active'),
    expiredCount: count('expired'),
    supersededCount: count('superseded'),
    quarantinedCount: count('quarantined'),
    runs: [...runs].sort((a, b) => b.at - a.at),
    totalAdded: total((r) => r.added),
    totalUpdated: total((r) => r.updated),
    totalDeleted: total((r) => r.deleted),
    totalDropped: total((r) => r.dropped),
    totalQuarantined,
    summary: `Memory v16: ${rows.length} facts (${count('active')} active, ${count('expired')} expired, ${count('superseded')} superseded, ${count('quarantined')} quarantined); ${runs.length} consolidation runs, ${totalQuarantined} facts quarantined as suspected poisoning.`,
  };
}

// ---------------------------------------------------------------------------
// Protocol v2 panel
// ---------------------------------------------------------------------------

/** Một A2A Agent Card (discovery). */
export interface FleetV14AgentCard {
  agentId: string;
  name: string;
  description: string;
  /** URL endpoint của agent (local-first: 127.0.0.1...). */
  endpoint: string;
  /** Các skill/capability agent công bố. */
  skills: string[];
  /** 'online' | 'offline' | 'degraded'. */
  status: string;
  lastSeenAt: number;
}

/** Một A2A task delegate (agent → agent). */
export interface FleetV14A2aTask {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  status: string;
  artifactCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Một MCP session stateless (spec 2026-07-28: request/response, không giữ session). */
export interface FleetV14McpSession {
  sessionId: string;
  serverName: string;
  transport: string;
  requestCount: number;
  errorCount: number;
  lastRequestAt: number;
}

/** Một lớp UI của agent (AG-UI event stream / A2UI declarative / MCP Apps resource). */
export interface FleetV14UiLayer {
  kind: 'ag-ui' | 'a2ui' | 'mcp-apps';
  name: string;
  enabled: boolean;
  eventCount: number;
  lastEventAt: number;
}

/** Một UHP harness manifest (model/skills/MCP/restriction trong một manifest). */
export interface FleetV14HarnessManifest {
  manifestId: string;
  name: string;
  model: string;
  skillCount: number;
  mcpServerCount: number;
  restrictionCount: number;
  updatedAt: number;
}

/** View-model panel Protocol v2. */
export interface FleetV14ProtocolPanel {
  agents: FleetV14AgentCard[];
  onlineAgents: number;
  tasks: FleetV14A2aTask[];
  activeTasks: number;
  sessions: FleetV14McpSession[];
  totalRequests: number;
  totalSessionErrors: number;
  uiLayers: FleetV14UiLayer[];
  manifests: FleetV14HarnessManifest[];
  summary: string;
}

export function buildFleetV14ProtocolPanel(
  agents: readonly FleetV14AgentCard[],
  tasks: readonly FleetV14A2aTask[],
  sessions: readonly FleetV14McpSession[],
  uiLayers: readonly FleetV14UiLayer[],
  manifests: readonly FleetV14HarnessManifest[],
): FleetV14ProtocolPanel {
  const sortedAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const sortedTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    agents: sortedAgents,
    onlineAgents: sortedAgents.filter((a) => a.status === 'online').length,
    tasks: sortedTasks,
    activeTasks: sortedTasks.filter((t) => t.status === 'running' || t.status === 'submitted').length,
    sessions: [...sessions].sort((a, b) => b.lastRequestAt - a.lastRequestAt),
    totalRequests: sessions.reduce((s, x) => s + x.requestCount, 0),
    totalSessionErrors: sessions.reduce((s, x) => s + x.errorCount, 0),
    uiLayers: [...uiLayers],
    manifests: [...manifests].sort((a, b) => b.updatedAt - a.updatedAt),
    summary: `Protocol v2: ${sortedAgents.length} A2A agents (${sortedAgents.filter((a) => a.status === 'online').length} online), ${sortedTasks.length} delegated tasks, ${sessions.length} stateless MCP sessions (${sessions.reduce((s, x) => s + x.requestCount, 0)} requests), ${uiLayers.filter((l) => l.enabled).length}/${uiLayers.length} UI layers enabled, ${manifests.length} harness manifests.`,
  };
}

// ---------------------------------------------------------------------------
// Router v2 panel (v1.17)
// ---------------------------------------------------------------------------

/** Một cặp Architect–Editor routing (planner mạnh / editor local rẻ). */
export interface FleetV14ArchitectEditorPair {
  pairId: string;
  taskKind: string;
  plannerModel: string;
  editorModel: string;
  editorLocal: boolean;
  tasksRouted: number;
  avgPlanMs: number;
  avgEditMs: number;
}

/** Thống kê repo map v4 (tree-sitter + PageRank, nén token). */
export interface FleetV14RepoMapStats {
  filesIndexed: number;
  symbolsIndexed: number;
  /** Token ước tính của repo map (đã nén) so với full text. */
  mapTokens: number;
  fullTextTokens: number;
  /** Tỉ lệ nén: 1 - mapTokens/fullTextTokens. */
  compressionRatio: number;
  updatedAt: number;
}

/** Một nguồn model local auto-detect (Ollama / LM Studio / ...). */
export interface FleetV14LocalModelSource {
  sourceId: string;
  kind: string;
  endpoint: string;
  detected: boolean;
  modelCount: number;
  lastScanAt: number;
  error: string;
}

/** View-model panel Router v2 (v1.17). */
export interface FleetV14RouterPanel {
  pairs: FleetV14ArchitectEditorPair[];
  totalRouted: number;
  repoMap: FleetV14RepoMapStats | null;
  sources: FleetV14LocalModelSource[];
  detectedSources: number;
  totalLocalModels: number;
  summary: string;
}

export function buildFleetV14RouterPanel(
  pairs: readonly FleetV14ArchitectEditorPair[],
  repoMap: FleetV14RepoMapStats | null,
  sources: readonly FleetV14LocalModelSource[],
): FleetV14RouterPanel {
  const sortedPairs = [...pairs].sort((a, b) => b.tasksRouted - a.tasksRouted);
  const detected = sources.filter((s) => s.detected);
  return {
    pairs: sortedPairs,
    totalRouted: sortedPairs.reduce((s, p) => s + p.tasksRouted, 0),
    repoMap,
    sources: [...sources].sort((a, b) => a.kind.localeCompare(b.kind)),
    detectedSources: detected.length,
    totalLocalModels: detected.reduce((s, x) => s + x.modelCount, 0),
    summary: `Router v2 (v1.17): ${sortedPairs.length} Architect–Editor pairs (${sortedPairs.reduce((s, p) => s + p.tasksRouted, 0)} tasks routed), repo map ${repoMap ? `${repoMap.filesIndexed} files, ${repoMap.symbolsIndexed} symbols, ${Math.round(repoMap.compressionRatio * 100)}% token compression` : 'not indexed yet'}, ${detected.length}/${sources.length} local sources detected (${detected.reduce((s, x) => s + x.modelCount, 0)} local models).`,
  };
}

// ---------------------------------------------------------------------------
// Coding agent v9 panel
// ---------------------------------------------------------------------------

/** Một edit AST-aware (thay vì whole-file). */
export interface FleetV14AstEdit {
  editId: string;
  file: string;
  /** 'insert' | 'replace' | 'delete' — thao tác trên node AST. */
  operation: string;
  nodeKind: string;
  linesChanged: number;
  appliedAt: number;
  reverted: boolean;
}

/** Một vòng sandbox execution loop (edit → test → lặp). */
export interface FleetV14SandboxRun {
  runId: string;
  taskId: string;
  /** Số vòng edit → test đã chạy (tối đa N vòng). */
  iterations: number;
  maxIterations: number;
  /** 'passed' | 'failed' | 'running' | 'gave-up'. */
  outcome: string;
  testsPassed: number;
  testsFailed: number;
  startedAt: number;
  finishedAt: number;
}

/** Một commit git-first atomic (Aider-style). */
export interface FleetV14GitCommit {
  commitId: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdBy: string;
  createdAt: number;
}

/** Kết quả eval harness kiểu SWE-bench nội bộ. */
export interface FleetV14EvalResult {
  evalId: string;
  taskCount: number;
  passed: number;
  /** pass@k (vd k=1). */
  passAtK: number;
  k: number;
  avgIterations: number;
  ranAt: number;
}

/** View-model panel Coding agent v9. */
export interface FleetV14CodingPanel {
  edits: FleetV14AstEdit[];
  totalLinesChanged: number;
  revertedEdits: number;
  sandboxRuns: FleetV14SandboxRun[];
  sandboxPassed: number;
  commits: FleetV14GitCommit[];
  evals: FleetV14EvalResult[];
  latestEval: FleetV14EvalResult | null;
  summary: string;
}

export function buildFleetV14CodingPanel(
  edits: readonly FleetV14AstEdit[],
  sandboxRuns: readonly FleetV14SandboxRun[],
  commits: readonly FleetV14GitCommit[],
  evals: readonly FleetV14EvalResult[],
): FleetV14CodingPanel {
  const sortedEdits = [...edits].sort((a, b) => b.appliedAt - a.appliedAt);
  const sortedRuns = [...sandboxRuns].sort((a, b) => b.startedAt - a.startedAt);
  const sortedCommits = [...commits].sort((a, b) => b.createdAt - a.createdAt);
  const sortedEvals = [...evals].sort((a, b) => b.ranAt - a.ranAt);
  return {
    edits: sortedEdits,
    totalLinesChanged: sortedEdits.reduce((s, e) => s + e.linesChanged, 0),
    revertedEdits: sortedEdits.filter((e) => e.reverted).length,
    sandboxRuns: sortedRuns,
    sandboxPassed: sortedRuns.filter((r) => r.outcome === 'passed').length,
    commits: sortedCommits,
    evals: sortedEvals,
    latestEval: sortedEvals[0] ?? null,
    summary: `Coding agent v9: ${sortedEdits.length} AST-aware edits (${sortedEdits.reduce((s, e) => s + e.linesChanged, 0)} lines changed, ${sortedEdits.filter((e) => e.reverted).length} reverted), ${sortedRuns.filter((r) => r.outcome === 'passed').length}/${sortedRuns.length} sandbox runs passed, ${sortedCommits.length} atomic git commits, latest eval ${sortedEvals[0] ? `${sortedEvals[0].passed}/${sortedEvals[0].taskCount} passed (pass@${sortedEvals[0].k} ${Math.round(sortedEvals[0].passAtK * 100)}%)` : 'no eval yet'}.`,
  };
}

// ---------------------------------------------------------------------------
// Voice v16 panel
// ---------------------------------------------------------------------------

/** Một phiên realtime v4 (speech-to-speech). */
export interface FleetV14VoiceSession {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  /** Số lượt barge-in (người nói chen). */
  bargeIns: number;
  /** Số lần semantic turn-taking quyết định nhường lượt. */
  turnTakes: number;
  /** Số lần wake-word kích hoạt phiên. */
  wakeWordHits: number;
  /** % thời gian TTS streaming kịp (không giật). */
  ttsOnTimeFraction: number;
  /** 'active' | 'ended' | 'error'. */
  status: string;
}

/** View-model panel Voice v16. */
export interface FleetV14VoicePanel {
  sessions: FleetV14VoiceSession[];
  activeSessions: number;
  totalBargeIns: number;
  totalTurnTakes: number;
  totalWakeWordHits: number;
  avgTtsOnTime: number;
  summary: string;
}

export function buildFleetV14VoicePanel(sessions: readonly FleetV14VoiceSession[]): FleetV14VoicePanel {
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  const ended = sorted.filter((s) => s.status === 'ended');
  return {
    sessions: sorted,
    activeSessions: sorted.filter((s) => s.status === 'active').length,
    totalBargeIns: sorted.reduce((s, x) => s + x.bargeIns, 0),
    totalTurnTakes: sorted.reduce((s, x) => s + x.turnTakes, 0),
    totalWakeWordHits: sorted.reduce((s, x) => s + x.wakeWordHits, 0),
    avgTtsOnTime: ended.length > 0 ? ended.reduce((s, x) => s + x.ttsOnTimeFraction, 0) / ended.length : 0,
    summary: `Voice v16: ${sorted.length} realtime sessions (${sorted.filter((s) => s.status === 'active').length} active), ${sorted.reduce((s, x) => s + x.bargeIns, 0)} barge-ins, ${sorted.reduce((s, x) => s + x.turnTakes, 0)} semantic turn-takes, ${sorted.reduce((s, x) => s + x.wakeWordHits, 0)} wake-word hits.`,
  };
}

// ---------------------------------------------------------------------------
// Fleet v14 panel (gom multi-user + rollout + polling + fleet)
// ---------------------------------------------------------------------------

/** Một node trong panel Fleet v14. */
export interface FleetV14PanelNodeRow {
  nodeId: string;
  hostname: string;
  status: string;
  health: string;
  load: number;
  runningTasks: number;
  maxTasks: number;
  ramUsedFraction: number;
  vramUsedFraction: number;
  labels: string[];
}

/** Một rollout trong panel Fleet v14. */
export interface FleetV14PanelRolloutRow {
  id: string;
  feature: string;
  version: string;
  stage: string;
  stageLabel: string;
  percent: number;
  gatePass: boolean;
  autoAction: string;
}

/** Một trigger polling trong panel Fleet v14. */
export interface FleetV14PanelPollRow {
  triggerId: string;
  toolkit: string;
  triggerSlug: string;
  status: string;
  currentIntervalMs: number;
  totalNewEvents: number;
  totalDuplicates: number;
  consecutiveErrors: number;
}

/** Một user trong panel Fleet v14 (quota + quyền). */
export interface FleetV14PanelUserRow {
  userId: string;
  role: string;
  tightestQuota: string;
  tightestFraction: number;
  activeGrants: number;
  deniedTargets: number;
  auditEventCount: number;
}

/** View-model panel Fleet v14. */
export interface FleetV14Panel {
  nodes: FleetV14PanelNodeRow[];
  nodeCount: number;
  activeNodeCount: number;
  overloadedNodeIds: string[];
  capacitySummary: string;
  users: FleetV14PanelUserRow[];
  rollouts: FleetV14PanelRolloutRow[];
  polls: FleetV14PanelPollRow[];
  summary: string;
}

/** Xây view-model panel Fleet v14 từ snapshot + quota state + rollout + polling. */
export function buildFleetV14Panel(
  snapshot: FleetV14Snapshot,
  quotaState: TeamV14QuotaState,
  users: readonly { id: string; role: string }[],
  rollouts: readonly TeamV14Rollout[],
  polls: readonly ComposioV14TriggerCheckpoint[],
  now = Date.now(),
): FleetV14Panel {
  const report = buildFleetV14CapacityReport(snapshot);
  const nodes: FleetV14PanelNodeRow[] = snapshot.nodes
    .filter((n) => n.status !== 'removed')
    .map((n) => ({
      nodeId: n.nodeId,
      hostname: n.hostname,
      status: n.status,
      health: n.health,
      load: fleetV14NodeLoad(n),
      runningTasks: n.runningTaskIds.length,
      maxTasks: n.capacity.maxTasks,
      ramUsedFraction: n.capacity.ramTotalMb > 0 ? n.usedRamMb / n.capacity.ramTotalMb : 0,
      vramUsedFraction: n.capacity.vramTotalMb > 0 ? n.usedVramMb / n.capacity.vramTotalMb : 0,
      labels: Object.entries(n.labels).map(([k, v]) => `${k}=${v}`),
    }))
    .sort((a, b) => b.load - a.load);
  const userRows: FleetV14PanelUserRow[] = users.map((u) => {
    const s = summarizeTeamV14User(quotaState, u.id, u.role, now);
    return {
      userId: u.id,
      role: u.role,
      tightestQuota: s.tightestQuota,
      tightestFraction: s.tightestFraction,
      activeGrants: s.activeGrants,
      deniedTargets: s.deniedTargets,
      auditEventCount: s.auditEventCount,
    };
  });
  const rolloutRows: FleetV14PanelRolloutRow[] = rollouts.map((r) => {
    const s = summarizeTeamV14Rollout(r);
    return {
      id: r.id,
      feature: r.feature,
      version: r.version,
      stage: r.stage,
      stageLabel: s.stageLabel,
      percent: s.percent,
      gatePass: s.gate.pass,
      autoAction: s.autoDecision.action,
    };
  });
  const pollRows: FleetV14PanelPollRow[] = polls.map((p) => {
    const s = summarizeComposioV14Trigger(p, now);
    return {
      triggerId: s.triggerId,
      toolkit: s.toolkit,
      triggerSlug: s.triggerSlug,
      status: s.status,
      currentIntervalMs: s.currentIntervalMs,
      totalNewEvents: s.totalNewEvents,
      totalDuplicates: s.totalDuplicates,
      consecutiveErrors: s.consecutiveErrors,
    };
  });
  return {
    nodes,
    nodeCount: report.nodeCount,
    activeNodeCount: report.activeNodeCount,
    overloadedNodeIds: report.overloadedNodeIds,
    capacitySummary: `Fleet v14: ${report.nodeCount} nodes (${report.activeNodeCount} active), ${report.runningTaskCount} running tasks, CPU ${report.usedCpuCores}/${report.totalCpuCores} cores, RAM ${report.usedRamMb}/${report.totalRamMb} MB, VRAM ${report.usedVramMb}/${report.totalVramMb} MB; ${report.overloadedNodeIds.length} overloaded nodes.`,
    users: userRows,
    rollouts: rolloutRows,
    polls: pollRows,
    summary: `Fleet v14: ${report.nodeCount} nodes (${report.activeNodeCount} active, ${report.overloadedNodeIds.length} overloaded), ${userRows.length} users tracked, ${rolloutRows.length} rollouts, ${pollRows.length} polling triggers.`,
  };
}

// ---------------------------------------------------------------------------
// Settings view-model (một chỗ cho mọi hệ thống mới của sóng v1.17)
// ---------------------------------------------------------------------------

/** Một dòng cài đặt (toggle / số / chuỗi) cho panel Settings. */
export interface FleetV14SettingRow {
  key: string;
  /** Nhóm hệ thống: 'memory' | 'protocol' | 'router' | 'coding' | 'voice' | 'fleet'. */
  group: string;
  /** Kiểu giá trị. */
  kind: 'toggle' | 'number' | 'text';
  labelKey: string;
  boolValue: boolean;
  numberValue: number;
  textValue: string;
  hintKey: string;
}

/** Cài đặt mặc định cho các hệ thống mới của sóng v1.17. */
export function defaultFleetV14Settings(): FleetV14SettingRow[] {
  return [
    { key: 'memory.sleepConsolidation', group: 'memory', kind: 'toggle', labelKey: 'fleetV14.memorySleep', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.memorySleepHint' },
    { key: 'memory.poisoningGuard', group: 'memory', kind: 'toggle', labelKey: 'fleetV14.memoryPoisoning', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.memoryPoisoningHint' },
    { key: 'memory.validityWindowDays', group: 'memory', kind: 'number', labelKey: 'fleetV14.memoryValidity', boolValue: false, numberValue: 90, textValue: '', hintKey: 'fleetV14.memoryValidityHint' },
    { key: 'protocol.a2aEnabled', group: 'protocol', kind: 'toggle', labelKey: 'fleetV14.protocolA2a', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.protocolA2aHint' },
    { key: 'protocol.mcpStateless', group: 'protocol', kind: 'toggle', labelKey: 'fleetV14.protocolMcp', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.protocolMcpHint' },
    { key: 'protocol.uiLayers', group: 'protocol', kind: 'text', labelKey: 'fleetV14.protocolUi', boolValue: false, numberValue: 0, textValue: 'ag-ui,a2ui,mcp-apps', hintKey: 'fleetV14.protocolUiHint' },
    { key: 'router.architectEditor', group: 'router', kind: 'toggle', labelKey: 'fleetV14.routerArchitect', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.routerArchitectHint' },
    { key: 'router.repoMap', group: 'router', kind: 'toggle', labelKey: 'fleetV14.routerRepoMap', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.routerRepoMapHint' },
    { key: 'coding.sandboxLoop', group: 'coding', kind: 'toggle', labelKey: 'fleetV14.codingSandbox', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.codingSandboxHint' },
    { key: 'coding.maxIterations', group: 'coding', kind: 'number', labelKey: 'fleetV14.codingIterations', boolValue: false, numberValue: 5, textValue: '', hintKey: 'fleetV14.codingIterationsHint' },
    { key: 'coding.atomicCommit', group: 'coding', kind: 'toggle', labelKey: 'fleetV14.codingCommit', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.codingCommitHint' },
    { key: 'voice.realtime', group: 'voice', kind: 'toggle', labelKey: 'fleetV14.voiceRealtime', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.voiceRealtimeHint' },
    { key: 'voice.wakeWord', group: 'voice', kind: 'toggle', labelKey: 'fleetV14.voiceWakeWord', boolValue: false, numberValue: 0, textValue: '', hintKey: 'fleetV14.voiceWakeWordHint' },
    { key: 'fleet.autoRollback', group: 'fleet', kind: 'toggle', labelKey: 'fleetV14.fleetAutoRollback', boolValue: true, numberValue: 0, textValue: '', hintKey: 'fleetV14.fleetAutoRollbackHint' },
    { key: 'fleet.pollBaseIntervalMs', group: 'fleet', kind: 'number', labelKey: 'fleetV14.fleetPollInterval', boolValue: false, numberValue: 60000, textValue: '', hintKey: 'fleetV14.fleetPollIntervalHint' },
  ];
}

/** Lọc cài đặt theo nhóm hệ thống. */
export function fleetV14SettingsByGroup(settings: readonly FleetV14SettingRow[], group: string): FleetV14SettingRow[] {
  return settings.filter((s) => s.group === group);
}
