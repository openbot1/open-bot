/**
 * Agent Teams v3 — teammate pane view kiểu tmux + agent-view dashboard
 * (v1.11, Đội T3).
 *
 * Mỗi teammate một pane trong lưới tmux: xem log/output trực tiếp
 * của teammate đó, vị trí (hàng/cột) tính từ thứ tự teammate và số
 * cột cấu hình. Pane log là append-only, cắt ở 200 dòng mới nhất.
 * Agent-view dashboard liệt kê các background session (mỗi session
 * tối đa 1 team) để user chuyển qua lại giữa các team đang chạy —
 * học ý tưởng Agent View của Claude Code (survey v1.11 §3).
 *
 * Thuần: thao tác trên mảng panes của v3 state — service v3 giữ
 * state và lưu. Không spawn process, không gọi model.
 */

import type { AgentTeamV109, TeamTask, Teammate } from '../types';
import {
  autoPaneColumns,
  MAX_PANE_LOG_LINES,
  panePosition,
  type LeadMode,
  type TeamBackgroundSession,
  type TeammatePane,
  type TeamV3Result,
} from './types';

/** Tạo pane trống cho một teammate (vị trí theo thứ tự trong team). */
export function createPane(
  mate: Teammate,
  index: number,
  columns: number,
  now = Date.now(),
): TeammatePane {
  const pos = panePosition(index, columns);
  return {
    teammateId: mate.id,
    name: mate.name,
    role: mate.role,
    status: mate.status,
    row: pos.row,
    col: pos.col,
    logLines: [],
    focused: false,
    updatedAt: now,
  };
}

/** Đồng bộ panes với danh sách teammate hiện tại: thêm pane mới, xóa pane của người đã rời, cập nhật trạng thái + task. */
export function syncPanes(
  panes: TeammatePane[],
  team: AgentTeamV109,
  columns: number,
  now = Date.now(),
): TeammatePane[] {
  const cols = columns > 0 ? columns : autoPaneColumns(team.teammates.length);
  const next: TeammatePane[] = team.teammates.map((mate: Teammate, index: number) => {
    const pos = panePosition(index, cols);
    const existing = panes.find((p) => p.teammateId === mate.id);
    const task = mate.currentTaskId ? team.tasks.find((t: TeamTask) => t.id === mate.currentTaskId) : undefined;
    return {
      teammateId: mate.id,
      name: mate.name,
      role: mate.role,
      status: mate.status,
      currentTaskTitle: task?.title,
      row: pos.row,
      col: pos.col,
      logLines: existing?.logLines ?? [],
      focused: existing?.focused ?? false,
      updatedAt: now,
    };
  });
  return next;
}

/** Thêm dòng log vào pane của một teammate (cắt ở 200 dòng mới nhất). */
export function appendPaneLog(
  panes: TeammatePane[],
  teammateId: string,
  line: string,
  now = Date.now(),
): TeamV3Result<TeammatePane> {
  const pane = panes.find((p) => p.teammateId === teammateId);
  if (!pane) return { ok: false, error: `Không tìm thấy pane của teammate ${teammateId}.` };
  const text = line.trim();
  if (!text) return { ok: false, error: 'Dòng log không được rỗng.' };
  if (text.length > 2000) return { ok: false, error: 'Dòng log tối đa 2000 ký tự.' };
  const logLines = [...pane.logLines, { at: now, line: text }].slice(-MAX_PANE_LOG_LINES);
  return { ok: true, value: { ...pane, logLines, updatedAt: now } };
}

/** Focus một pane (agent view chuyển qua pane đó); các pane khác unfocus. */
export function focusPane(
  panes: TeammatePane[],
  teammateId: string,
  now = Date.now(),
): TeamV3Result<TeammatePane[]> {
  if (!panes.some((p) => p.teammateId === teammateId)) {
    return { ok: false, error: `Không tìm thấy pane của teammate ${teammateId}.` };
  }
  return {
    ok: true,
    value: panes.map((p) => ({ ...p, focused: p.teammateId === teammateId, updatedAt: now })),
  };
}

/** Pane đang được focus (undefined khi chưa focus pane nào). */
export function focusedPane(panes: TeammatePane[]): TeammatePane | undefined {
  return panes.find((p) => p.focused);
}

/** Số hàng/cột của lưới pane (để UI vẽ khung tmux). */
export function paneGridSize(panes: TeammatePane[]): { rows: number; cols: number } {
  if (panes.length === 0) return { rows: 0, cols: 0 };
  return {
    rows: Math.max(...panes.map((p) => p.row)) + 1,
    cols: Math.max(...panes.map((p) => p.col)) + 1,
  };
}

/** Render lưới pane dạng text (để tool trả về nhanh, UI vẫn có bản structured). */
export function renderPaneGrid(panes: TeammatePane[]): string {
  if (panes.length === 0) return 'Chưa có pane nào.';
  const { rows, cols } = paneGridSize(panes);
  const lines: string[] = [`Lưới pane ${rows} hàng x ${cols} cột:`];
  for (const pane of [...panes].sort((a, b) => a.row - b.row || a.col - b.col)) {
    const last = pane.logLines[pane.logLines.length - 1];
    lines.push(
      `[${pane.row},${pane.col}] ${pane.name} (${pane.role === 'lead' ? 'lead' : pane.status})` +
        (pane.currentTaskTitle ? ` — đang làm: ${pane.currentTaskTitle}` : ' — rảnh') +
        (last ? ` — log mới nhất: ${last.line.slice(0, 120)}` : ''),
    );
  }
  return lines.join('\n');
}

/** Tóm tắt một background session (agent view) từ team + v3 state. */
export function summarizeBackgroundSession(
  team: AgentTeamV109,
  opts: {
    sessionId: string;
    leadMode: LeadMode;
    currentWave: number;
    totalWaves: number;
  },
): TeamBackgroundSession {
  return {
    sessionId: opts.sessionId,
    teamId: team.id,
    teamName: team.name,
    leadName: team.teammates.find((m) => m.id === team.leadId)?.name ?? team.leadId,
    status: team.status,
    leadMode: opts.leadMode,
    teammateCount: team.teammates.length,
    workingCount: team.teammates.filter((m) => m.status === 'working').length,
    currentWave: opts.currentWave,
    totalWaves: opts.totalWaves,
    tasksDone: team.tasks.filter((t) => t.status === 'done').length,
    tasksTotal: team.tasks.length,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}
