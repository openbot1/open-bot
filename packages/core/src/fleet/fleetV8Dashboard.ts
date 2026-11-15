/**
 * Fleet dashboard v8 — snapshot tổng hợp cho UI (v1.11, Đội T6).
 *
 * Gom 3 thế hệ trạng thái fleet đã có trong repo thành MỘT snapshot
 * duy nhất để FleetV8View vẽ, thay vì UI phải đọc 3 file rời:
 *
 * - Node v8 (`fleet-health-v111.json` + `fleet-incidents-v111.jsonl`):
 *   trạng thái từng node, rollup, incident mới nhất.
 * - Bot v6 (`fleet-health-v109.json`): bot unhealthy / số crash gần
 *   đây — tái dùng `loadFleetV6HealthStates`, không đọc lại file thô.
 * - Campaign v7 (`fleet-campaigns-v110.json`): campaign đang active
 *   + báo cáo tóm tắt — tái dùng `loadFleetV7Campaigns` +
 *   `summarizeFleetV7Campaign`.
 * - Probe local: `probeFleetV8LocalNode` cho máy đang chạy app (node
 *   "this machine"), để dashboard luôn có ít nhất một node thật ngay
 *   cả khi fleet chưa đăng ký node LAN nào.
 *
 * Chỉ đọc file, không ghi, không gọi mạng. File hỏng/thiếu được coi
 * là rỗng (dashboard vẫn vẽ được phần còn lại) — nhưng file JSON sai
 * định dạng thì `buildFleetV8Dashboard` vẫn throw như các loader gốc,
 * để caller phân biệt "chưa có dữ liệu" với "dữ liệu hỏng".
 */

import { loadFleetV6HealthStates, type FleetV6BotHealthState } from './fleetV6Health';
import {
  listFleetV8Incidents,
  loadFleetV8NodeStates,
  probeFleetV8LocalNode,
  rollupFleetV8NodeHealth,
  type FleetV8HealthRollup,
  type FleetV8Incident,
  type FleetV8LocalProbe,
  type FleetV8NodeHealthStatus,
  type FleetV8NodeTrackState,
} from './fleetV8Health';
import { loadFleetV7Campaigns, summarizeFleetV7Campaign, type FleetV7CampaignReport } from './fleetV7Campaign';

/** Một dòng node trong dashboard. */
export interface FleetV8DashboardNodeRow {
  nodeId: string;
  status: FleetV8NodeHealthStatus;
  /** ms epoch lần check cuối — null = chưa từng check. */
  lastCheckedAtMs: number | null;
  consecutiveDowns: number;
  restartAttempts: number;
  totalDowns: number;
  totalEvacuations: number;
  /** true khi dòng này là máy local đang chạy app. */
  isLocal: boolean;
}

/** Một dòng bot đáng chú ý trong dashboard (chỉ bot có vấn đề). */
export interface FleetV8DashboardBotRow {
  botId: string;
  status: string;
  consecutiveFailures: number;
  recentCrashes: number;
  unhealthy: boolean;
  lastError: string | null;
}

/** Một dòng campaign đang chạy trong dashboard. */
export interface FleetV8DashboardCampaignRow {
  id: string;
  goal: string;
  status: string;
  totalBots: number;
  done: number;
  failed: number;
  running: number;
  progressPercent: number;
  /** null khi chưa bot nào kết thúc campaign. */
  successRate: number | null;
}

/** Snapshot dashboard v8 — thứ UI vẽ, thứ IPC `fleet:v8-dashboard` trả. */
export interface FleetV8DashboardSnapshot {
  /** ms epoch lúc build snapshot. */
  builtAtMs: number;
  /** Thư mục fleet root đã đọc (để UI/debug biết dữ liệu từ đâu). */
  fleetRoot: string;
  /** Rollup node v8. */
  nodes: FleetV8HealthRollup;
  /** Từng node (theo dõi v8 + node local). */
  nodeRows: FleetV8DashboardNodeRow[];
  /** Probe tài nguyên thật của máy local (null chỉ khi probe lỗi). */
  localProbe: FleetV8LocalProbe | null;
  /** Bot v6 đang unhealthy hoặc crash gần đây (tối đa 20, nhiều crash trước). */
  problemBots: FleetV8DashboardBotRow[];
  /** Tổng số bot v6 đang theo dõi. */
  totalTrackedBots: number;
  /** Campaign v7 đang active/paused (tối đa 10, mới nhất trước). */
  activeCampaigns: FleetV8DashboardCampaignRow[];
  /** Tổng số campaign v7. */
  totalCampaigns: number;
  /** Incident v8 mới nhất (tối đa 20). */
  recentIncidents: FleetV8Incident[];
  /** Cảnh báo ngắn cho UI (rỗng = fleet ổn). */
  alerts: string[];
}

const MAX_PROBLEM_BOTS = 20;
const MAX_ACTIVE_CAMPAIGNS = 10;
const MAX_RECENT_INCIDENTS = 20;

/** Chuyển một state v6 thành dòng bot dashboard. */
export function fleetV8DashboardBotRow(state: FleetV6BotHealthState): FleetV8DashboardBotRow {
  return {
    botId: state.botId,
    status: state.lastStatus ?? 'unknown',
    consecutiveFailures: state.consecutiveFailures,
    recentCrashes: state.crashHistory.length,
    unhealthy: state.unhealthy,
    lastError: state.lastError,
  };
}

/** Bot v6 có đáng đưa lên dashboard không (unhealthy / lỗi liên tiếp / crash gần đây). */
export function isFleetV8ProblemBot(state: FleetV6BotHealthState): boolean {
  return state.unhealthy || state.consecutiveFailures > 0 || state.crashHistory.length > 0;
}

/** Chuyển một báo cáo campaign v7 thành dòng dashboard. */
export function fleetV8DashboardCampaignRow(report: FleetV7CampaignReport): FleetV8DashboardCampaignRow {
  return {
    id: report.id,
    goal: report.goal,
    status: report.status,
    totalBots: report.totalBots,
    done: report.done,
    failed: report.failed,
    running: report.running,
    progressPercent: report.progressPercent,
    successRate: report.successRate,
  };
}

/** Chuyển một state node v8 thành dòng dashboard. */
export function fleetV8DashboardNodeRow(state: FleetV8NodeTrackState, isLocal: boolean): FleetV8DashboardNodeRow {
  return {
    nodeId: state.nodeId,
    status: state.lastStatus,
    lastCheckedAtMs: state.lastCheckedAtMs,
    consecutiveDowns: state.consecutiveDowns,
    restartAttempts: state.restartAttempts,
    totalDowns: state.totalDowns,
    totalEvacuations: state.totalEvacuations,
    isLocal,
  };
}

/**
 * Build snapshot dashboard v8 từ fleet root. Đọc 3 file trạng thái
 * (v6/v7/v8) + probe máy local. Thiếu file = phần đó rỗng, không throw.
 */
export function buildFleetV8Dashboard(fleetRoot: string, nowMs: number = Date.now()): FleetV8DashboardSnapshot {
  const alerts: string[] = [];

  // Node v8 (theo dõi bền) + probe local.
  const nodeStates = loadFleetV8NodeStates(fleetRoot);
  let localProbe: FleetV8LocalProbe | null = null;
  try {
    localProbe = probeFleetV8LocalNode(fleetRoot, nowMs);
  } catch {
    localProbe = null;
    alerts.push('Không probe được tài nguyên máy local.');
  }
  const nodeRows = nodeStates.map((s) => fleetV8DashboardNodeRow(s, false));
  // Node local chưa có trong file theo dõi thì thêm một dòng "chưa check"
  // để dashboard luôn thấy máy mình (trạng thái healthy chỉ khi probe ok).
  const localNodeId = 'local';
  if (!nodeRows.some((r) => r.nodeId === localNodeId)) {
    nodeRows.unshift({
      nodeId: localNodeId,
      status: localProbe ? 'healthy' : 'down',
      lastCheckedAtMs: localProbe ? localProbe.probedAtMs : null,
      consecutiveDowns: 0,
      restartAttempts: 0,
      totalDowns: 0,
      totalEvacuations: 0,
      isLocal: true,
    });
  } else {
    const localRow = nodeRows.find((r) => r.nodeId === localNodeId);
    if (localRow) localRow.isLocal = true;
  }
  const rollup = rollupFleetV8NodeHealth(
    nodeRows.map((r) => ({
      nodeId: r.nodeId,
      status: r.status,
      checks: [],
      reasons: [],
      checkedAtMs: r.lastCheckedAtMs ?? nowMs,
    })),
  );
  if (rollup.down > 0) alerts.push(`${rollup.down} node đang down — kiểm tra incident log v8.`);
  if (rollup.unhealthy > 0) alerts.push(`${rollup.unhealthy} node không khoẻ — cân nhắc evacuate bot.`);
  if (rollup.degraded > 0) alerts.push(`${rollup.degraded} node đang yếu (degraded) — đã drain, không nhận bot mới.`);

  // Bot v6 có vấn đề.
  const botStates = loadFleetV6HealthStates(fleetRoot);
  const problemBots = botStates
    .filter((s) => isFleetV8ProblemBot(s))
    .map((s) => fleetV8DashboardBotRow(s))
    .sort((a, b) => b.recentCrashes - a.recentCrashes || b.consecutiveFailures - a.consecutiveFailures)
    .slice(0, MAX_PROBLEM_BOTS);
  if (problemBots.some((b) => b.unhealthy)) {
    alerts.push(`${problemBots.filter((b) => b.unhealthy).length} bot đang unhealthy (v6).`);
  }

  // Campaign v7 đang chạy.
  const campaigns = loadFleetV7Campaigns(fleetRoot);
  const activeCampaigns = campaigns
    .filter((c) => c.status === 'active' || c.status === 'paused')
    .map((c) => fleetV8DashboardCampaignRow(summarizeFleetV7Campaign(c, nowMs)))
    .slice(0, MAX_ACTIVE_CAMPAIGNS);

  // Incident v8 mới nhất.
  const recentIncidents = listFleetV8Incidents(fleetRoot, { limit: MAX_RECENT_INCIDENTS });
  const downIncidents = recentIncidents.filter((i) => i.kind === 'node-down').length;
  if (downIncidents > 0) alerts.push(`${downIncidents} incident node-down gần đây.`);

  return {
    builtAtMs: nowMs,
    fleetRoot,
    nodes: rollup,
    nodeRows,
    localProbe,
    problemBots,
    totalTrackedBots: botStates.length,
    activeCampaigns,
    totalCampaigns: campaigns.length,
    recentIncidents,
    alerts,
  };
}

/** Tóm tắt một dòng cho log/telemetry: "3 node (2 healthy, 1 down), 2 bot lỗi, 1 campaign active". */
export function summarizeFleetV8Dashboard(snapshot: FleetV8DashboardSnapshot): string {
  const n = snapshot.nodes;
  return (
    `${n.totalNodes} node (${n.healthy} healthy, ${n.degraded} degraded, ${n.unhealthy} unhealthy, ${n.down} down), ` +
    `${snapshot.problemBots.length} bot có vấn đề / ${snapshot.totalTrackedBots} bot theo dõi, ` +
    `${snapshot.activeCampaigns.length} campaign đang chạy / ${snapshot.totalCampaigns} campaign, ` +
    `${snapshot.recentIncidents.length} incident gần đây.`
  );
}
