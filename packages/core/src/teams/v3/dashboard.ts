/**
 * Agent Teams v3 — dashboard snapshot (v1.11, Đội T3).
 *
 * Snapshot v3 gộp: team v1 + chi phí tuyến tính v3 + waves +
 * lead mode + lead status board + panes tmux + challenge +
 * log hội thoại team + background sessions (agent view). UI Team v3
 * và tool teams_v3_dashboard đọc snapshot này — không gọi lẻ từng
 * module.
 */

import type { AgentTeamV109 } from '../types';
import type { TeamV3State } from './types';
import type { TeamV3CostEstimate } from './types';
import type {
  LeadTeammateBoardEntry,
  TeamBackgroundSession,
  TeamChallenge,
  TeamConversationEntry,
  TeamWave,
  TeammatePane,
} from './types';

/** Snapshot dashboard v3 của một team (để UI Team v3 hiển thị + tool teams_v3_dashboard). */
export interface TeamV3Dashboard {
  teamId: string;
  teamName: string;
  goal: string;
  status: AgentTeamV109['status'];
  leadName: string;
  leadMode: TeamV3State['leadMode'];
  /** Id worker seat của lead (khi lead ở implement mode). */
  leadWorkerId?: string;
  /** 7 primitives v3 (để UI liệt kê tính năng khả dụng). */
  primitives: string[];
  /** Lead status board: trạng thái từng teammate. */
  leadBoard: LeadTeammateBoardEntry[];
  /** Waves theo dependency chain + wave hiện tại. */
  waves: TeamWave[];
  currentWaveIndex: number;
  /** Panes tmux: mỗi teammate một pane. */
  panes: TeammatePane[];
  paneGrid: { rows: number; cols: number };
  /** Challenge trong team. */
  challenges: TeamChallenge[];
  challengeSummary: string;
  /** Log hội thoại team (mới nhất cuối, tối đa 50 mục). */
  conversation: TeamConversationEntry[];
  /** Chi phí token tuyến tính v3. */
  cost: TeamV3CostEstimate;
  /** Cảnh báo cỡ team 3–5 (kế thừa v2 checkTeamSize). */
  sizeWarnings: string[];
  /** Background sessions (agent view) — mọi session đang có team. */
  backgroundSessions: TeamBackgroundSession[];
  /** File đang bị giữ bởi task khác (file guard). */
  fileHolds: { file: string; taskId: string; taskTitle: string; teammateId: string; teammateName: string }[];
  /** Task theo vòng đời v3 (open/in-progress/closed). */
  lifecycleCounts: { open: number; inProgress: number; closed: number };
  updatedAt: number;
}

/** Tóm tắt dashboard v3 thành markdown (để tool trả về text đọc được). */
export function teamV3DashboardMarkdown(d: TeamV3Dashboard): string {
  const lines: string[] = [
    `Team v3 "${d.teamName}" (${d.teamId}) — ${d.status}, lead ${d.leadName}, mode ${d.leadMode}.`,
    `Lead board: ${d.leadBoard.map((b) => `${b.name} (${b.status}${b.currentTaskTitle ? `: ${b.currentTaskTitle}` : ''})`).join('; ') || 'chưa có teammate'}.`,
    `Waves: ${d.waves.length === 0 ? 'chưa có task' : `wave hiện tại ${d.currentWaveIndex + 1}/${d.waves.length}`}.`,
    `Lifecycle: ${d.lifecycleCounts.open} open, ${d.lifecycleCounts.inProgress} in-progress, ${d.lifecycleCounts.closed} closed.`,
    `Panes: ${d.panes.length} pane (${d.paneGrid.rows}x${d.paneGrid.cols}).`,
    d.challengeSummary,
    `Chi phí: ≈ ${d.cost.estimatedTokens.toLocaleString('en-US')} token (x${d.cost.multiplier} so với session đơn), mức ${d.cost.level}.`,
  ];
  for (const w of d.cost.warnings) lines.push(`Cảnh báo chi phí: ${w}`);
  for (const w of d.sizeWarnings) lines.push(`Cảnh báo cỡ team: ${w}`);
  if (d.fileHolds.length > 0) {
    lines.push(
      `File đang giữ: ${d.fileHolds.map((h) => `"${h.file}" (${h.teammateName})`).join('; ')}.`,
    );
  }
  if (d.backgroundSessions.length > 0) {
    lines.push(
      `Background sessions: ${d.backgroundSessions.map((s) => `${s.sessionId} → ${s.teamName}`).join('; ')}.`,
    );
  }
  return lines.join('\n');
}
