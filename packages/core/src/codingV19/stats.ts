/**
 * Coding agent v19 — thống kê + digest conversation (v1.41, Đội T4).
 *
 * Mở rộng thật cho subsystem conversation: thống kê từ event log đã
 * replay (tin nhắn, tool call + tỉ lệ thành công, file đổi, checkpoint,
 * thời lượng, ước lượng token theo heuristic ký tự/4 — ghi rõ là ước
 * lượng, không phải đếm token thật của model), thống kê workspace
 * (số file, dung lượng, dòng, theo đuôi file, file lớn nhất), timeline
 * event theo bucket thời gian, và digest markdown tóm tắt một
 * conversation để xem nhanh hoặc đính kèm báo cáo. Tất cả đều là hàm
 * thuần trên dữ liệu đã có, không gọi model/mạng.
 */

import { CodingV19Error } from './types';
import type {
  V19ConversationState,
  V19Event,
  V19SnapshotFileEntry,
  V19WorkspaceFile,
} from './types';

/** Ước lượng token: 1 token ≈ 4 ký tự (heuristic, ghi rõ khi render). */
export const V19_TOKEN_CHARS_PER_TOKEN = 4;

/** Ước lượng token từ text (ký tự / 4, làm tròn lên). */
export function v19EstimateTokens(text: string): number {
  if (typeof text !== 'string') throw new CodingV19Error('Text ước lượng token phải là string.');
  if (text.length === 0) return 0;
  return Math.ceil(text.length / V19_TOKEN_CHARS_PER_TOKEN);
}

/** Thống kê tool call của một conversation (từ state replay). */
export interface V19ToolCallStats {
  toolName: string;
  calls: number;
  ok: number;
  failed: number;
  successRate: number;
}

/** Thống kê conversation (từ state replay + event log gốc). */
export interface V19ConversationStats {
  conversationId: string;
  events: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolCallsOk: number;
  toolCallsFailed: number;
  toolSuccessRate: number;
  filesChanged: number;
  checkpoints: number;
  pluginsActive: number;
  /** Thời lượng từ event đầu tới event cuối (ms, 0 khi log rỗng). */
  durationMs: number;
  /** Ước lượng token toàn bộ tin nhắn + kết quả tool (heuristic). */
  estimatedTokens: number;
  /** Số event theo kind. */
  eventsByKind: Record<string, number>;
  /** Thống kê từng tool (sort theo số lần gọi giảm dần). */
  perTool: V19ToolCallStats[];
  firstAt: number;
  lastAt: number;
}

/** Tính thống kê conversation từ state replay + event log. */
export function v19ConversationStats(
  state: V19ConversationState,
  events: readonly V19Event[],
): V19ConversationStats {
  const userMessages = state.messages.filter((m) => m.role === 'user').length;
  const assistantMessages = state.messages.filter((m) => m.role === 'assistant').length;
  const toolCallsOk = state.toolCalls.filter((c) => c.ok === true).length;
  const toolCallsFailed = state.toolCalls.filter((c) => c.ok === false).length;
  const toolCalls = state.toolCalls.length;
  let estimatedTokens = 0;
  for (const message of state.messages) estimatedTokens += v19EstimateTokens(message.text);
  for (const call of state.toolCalls) {
    estimatedTokens += v19EstimateTokens(call.argsJson ?? '');
    estimatedTokens += v19EstimateTokens(call.result ?? '');
  }
  const eventsByKind: Record<string, number> = {};
  for (const event of events) eventsByKind[event.kind] = (eventsByKind[event.kind] ?? 0) + 1;
  const perToolMap = new Map<string, { calls: number; ok: number; failed: number }>();
  for (const call of state.toolCalls) {
    const entry = perToolMap.get(call.toolName) ?? { calls: 0, ok: 0, failed: 0 };
    entry.calls += 1;
    if (call.ok === true) entry.ok += 1;
    else if (call.ok === false) entry.failed += 1;
    perToolMap.set(call.toolName, entry);
  }
  const perTool: V19ToolCallStats[] = [...perToolMap.entries()]
    .map(([toolName, entry]) => ({
      toolName,
      calls: entry.calls,
      ok: entry.ok,
      failed: entry.failed,
      successRate: entry.calls === 0 ? 0 : Math.round((entry.ok / entry.calls) * 100),
    }))
    .sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));
  return {
    conversationId: state.conversationId,
    events: state.eventsReplayed,
    messages: state.messages.length,
    userMessages,
    assistantMessages,
    toolCalls,
    toolCallsOk,
    toolCallsFailed,
    toolSuccessRate: toolCalls === 0 ? 0 : Math.round((toolCallsOk / toolCalls) * 100),
    filesChanged: state.filesChanged.length,
    checkpoints: state.checkpoints.length,
    pluginsActive: state.plugins.filter((p) => p.loaded && p.enabled).length,
    durationMs: state.startedAt === 0 ? 0 : state.lastAt - state.startedAt,
    estimatedTokens,
    eventsByKind,
    perTool,
    firstAt: state.startedAt,
    lastAt: state.lastAt,
  };
}

/** Thống kê workspace (từ danh sách file đã list). */
export interface V19WorkspaceStats {
  files: number;
  totalBytes: number;
  totalLines: number;
  /** Số file theo đuôi (vd {'.ts': 12, '.md': 3, '(không đuôi)': 1}). */
  byExtension: Record<string, number>;
  /** 5 file lớn nhất (theo bytes). */
  largestFiles: { relPath: string; size: number; lines: number }[];
  /** 5 file nhiều dòng nhất. */
  longestFiles: { relPath: string; size: number; lines: number }[];
}

/** Tính thống kê workspace từ danh sách file (đã có nội dung). */
export function v19WorkspaceStats(files: readonly V19WorkspaceFile[]): V19WorkspaceStats {
  let totalBytes = 0;
  let totalLines = 0;
  const byExtension: Record<string, number> = {};
  const withLines = files.map((file) => {
    // Đếm dòng theo nghĩa wc -l: số ký tự '\n' (file kết thúc bằng '\n'
    // không tính thêm một dòng rỗng cuối).
    const lines = file.content === '' ? 0 : file.content.split('\n').length - (file.content.endsWith('\n') ? 1 : 0);
    totalBytes += file.size;
    totalLines += lines;
    const dot = file.relPath.lastIndexOf('.');
    const slash = file.relPath.lastIndexOf('/');
    const ext = dot > slash ? file.relPath.slice(dot).toLowerCase() : '(không đuôi)';
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    return { relPath: file.relPath, size: file.size, lines };
  });
  const largestFiles = [...withLines].sort((a, b) => b.size - a.size).slice(0, 5);
  const longestFiles = [...withLines].sort((a, b) => b.lines - a.lines).slice(0, 5);
  return { files: files.length, totalBytes, totalLines, byExtension, largestFiles, longestFiles };
}

/** Thống kê snapshot (từ manifest): số file + tổng bytes. */
export function v19SnapshotStats(files: Record<string, V19SnapshotFileEntry>): { files: number; totalBytes: number } {
  let totalBytes = 0;
  for (const entry of Object.values(files)) totalBytes += entry.size;
  return { files: Object.keys(files).length, totalBytes };
}

/** Một bucket trong timeline event. */
export interface V19EventTimelineBucket {
  bucketStart: number;
  bucketEnd: number;
  count: number;
  kinds: Record<string, number>;
}

/**
 * Timeline event: gom event vào bucket thời gian (mặc định 1 giờ).
 * Dùng để xem conversation sôi động lúc nào, không cần vẽ đồ thị.
 */
export function v19EventTimeline(
  events: readonly V19Event[],
  bucketMs = 60 * 60 * 1000,
): V19EventTimelineBucket[] {
  if (!Number.isInteger(bucketMs) || bucketMs < 1000) {
    throw new CodingV19Error('bucketMs phải là số nguyên >= 1000.');
  }
  if (events.length === 0) return [];
  const start = Math.floor(events[0]!.at / bucketMs) * bucketMs;
  const buckets = new Map<number, V19EventTimelineBucket>();
  for (const event of events) {
    const bucketStart = Math.floor(event.at / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart) ?? {
      bucketStart,
      bucketEnd: bucketStart + bucketMs,
      count: 0,
      kinds: {},
    };
    bucket.count += 1;
    bucket.kinds[event.kind] = (bucket.kinds[event.kind] ?? 0) + 1;
    buckets.set(bucketStart, bucket);
  }
  void start;
  return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);
}

/** Digest markdown tóm tắt một conversation (để xem nhanh / báo cáo). */
export function v19ConversationDigest(
  title: string,
  profileId: string,
  stats: V19ConversationStats,
  workspace: V19WorkspaceStats,
  state: V19ConversationState,
  recentMessages = 5,
): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `Conversation ${stats.conversationId} — profile: ${profileId || '(không có)'} — ${stats.events} event, thời lượng ${formatV19Duration(stats.durationMs)}.`,
    '',
    '## Thống kê',
    '',
    `- Tin nhắn: ${stats.messages} (user ${stats.userMessages}, assistant ${stats.assistantMessages}).`,
    `- Tool call: ${stats.toolCalls} (thành công ${stats.toolCallsOk}, thất bại ${stats.toolCallsFailed}, tỉ lệ ${stats.toolSuccessRate}%).`,
    `- File đã đổi: ${stats.filesChanged}, checkpoint: ${stats.checkpoints}, plugin đang chạy: ${stats.pluginsActive}.`,
    `- Token ước lượng (heuristic ký tự/4, không phải đếm thật của model): ~${stats.estimatedTokens}.`,
    `- Workspace: ${workspace.files} file, ${workspace.totalBytes} bytes, ${workspace.totalLines} dòng.`,
  ];
  if (stats.perTool.length > 0) {
    lines.push('', '## Tool đã dùng', '');
    for (const tool of stats.perTool) {
      lines.push(`- ${tool.toolName}: ${tool.calls} lần (ok ${tool.ok}, fail ${tool.failed}, ${tool.successRate}%).`);
    }
  }
  if (workspace.largestFiles.length > 0) {
    lines.push('', '## File lớn nhất', '');
    for (const file of workspace.largestFiles) {
      lines.push(`- ${file.relPath}: ${file.size} bytes, ${file.lines} dòng.`);
    }
  }
  if (state.filesChanged.length > 0) {
    lines.push('', '## File đã đổi', '');
    for (const file of state.filesChanged) {
      lines.push(`- ${file.filePath} (${file.action}, seq ${file.lastSeq}).`);
    }
  }
  const recent = state.messages.slice(-recentMessages);
  if (recent.length > 0) {
    lines.push('', `## ${recent.length} tin nhắn gần nhất`, '');
    for (const message of recent) {
      const firstLine = message.text.split('\n')[0] ?? '';
      lines.push(`- [${message.role}] ${firstLine.slice(0, 160)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Format thời lượng ms thành text đọc được (vd "2m 30s", "450ms"). */
export function formatV19Duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

/** Format bytes thành text đọc được (vd "1.5 KiB"). */
export function formatV19Bytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Render thống kê conversation (text ngắn cho tool output). */
export function renderV19ConversationStats(stats: V19ConversationStats): string {
  const lines = [
    `Conversation ${stats.conversationId}: ${stats.events} event trong ${formatV19Duration(stats.durationMs)}; ${stats.messages} tin nhắn (user ${stats.userMessages}, assistant ${stats.assistantMessages}); ${stats.toolCalls} tool call (ok ${stats.toolCallsOk}, fail ${stats.toolCallsFailed}, ${stats.toolSuccessRate}%); ${stats.filesChanged} file đổi; ${stats.checkpoints} checkpoint; ~${stats.estimatedTokens} token ước lượng.`,
  ];
  if (stats.perTool.length > 0) {
    lines.push(`Tool: ${stats.perTool.map((t) => `${t.toolName} ${t.calls} lần (${t.successRate}%)`).join(', ')}.`);
  }
  return lines.join('\n');
}

/** Render thống kê workspace (text ngắn cho tool output). */
export function renderV19WorkspaceStats(stats: V19WorkspaceStats): string {
  const lines = [
    `Workspace: ${stats.files} file, ${formatV19Bytes(stats.totalBytes)}, ${stats.totalLines} dòng.`,
  ];
  const exts = Object.entries(stats.byExtension).sort((a, b) => b[1] - a[1]);
  if (exts.length > 0) {
    lines.push(`Theo đuôi file: ${exts.map(([ext, count]) => `${ext} ${count}`).join(', ')}.`);
  }
  if (stats.largestFiles.length > 0) {
    lines.push(`File lớn nhất: ${stats.largestFiles.map((f) => `${f.relPath} (${formatV19Bytes(f.size)})`).join(', ')}.`);
  }
  return lines.join('\n');
}

/** Render timeline event (một dòng một bucket). */
export function renderV19EventTimeline(buckets: readonly V19EventTimelineBucket[]): string {
  if (buckets.length === 0) return '(chưa có event nào)';
  return buckets
    .map((b) => {
      const kinds = Object.entries(b.kinds).map(([kind, count]) => `${kind} ${count}`).join(', ');
      return `${new Date(b.bucketStart).toISOString()}: ${b.count} event (${kinds})`;
    })
    .join('\n');
}
