/**
 * Coding agent v19 — agent scripted end-to-end (v1.41, Đội T4).
 *
 * Chạy một phiên agent scripted trên conversation event-backed: tạo
 * conversation mới (áp preset theo profile) hoặc tiếp tục conversation
 * có sẵn, append event cho từng bước (user message, tool call +
 * result, file edit trong workspace tách bạch, checkpoint cuối phiên),
 * chặn tool ngoài allowlist của preset và chặn path traversal ra khỏi
 * workspace. Không gọi model thật, không gọi mạng; bước là dữ liệu
 * đầu vào (host thay bằng model thật sau này qua cùng interface).
 *
 * Nối v18 (không viết lại): runV18Agent vẫn là agent v18 với
 * verification stack (critic/review/depmap/eval); agent v19 chạy trên
 * event log + workspace + plugin/preset thay vì trajectory + patch.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { CodingV19Error } from './types';
import type {
  V19AgentReport,
  V19AgentStep,
  V19ConversationMeta,
  V19Event,
  V19RunAgentInput,
} from './types';
import { v19AppendEvent, v19ReplayEvents } from './events';
import {
  v19CreateConversationMeta,
  v19OpenConversationEvents,
} from './conversation';
import { v19ApplyPreset, v19BuiltinPresetById, v19IsToolAllowed } from './presets';
import {
  v19CreateSnapshot,
  v19EnsureWorkspace,
  v19WorkspaceDelete,
  v19WorkspaceEdit,
  v19WorkspaceWrite,
} from './workspace';

/** Input mở rộng của agent: tiếp tục conversation đã có (kèm log + meta). */
export interface V19RunAgentOptions extends V19RunAgentInput {
  existingEvents?: V19Event[];
  existingMeta?: V19ConversationMeta;
  /** Tên plugin đã cài (để preset báo missingPlugins). */
  installedPluginNames?: string[];
}

/** Validate một bước agent (text bắt buộc; fileWrite/fileDelete/toolCall đúng dạng). */
export function v19ValidateAgentStep(step: V19AgentStep): void {
  if (!step || typeof step !== 'object') throw new CodingV19Error('Agent step phải là object.');
  if (typeof step.text !== 'string' || step.text.trim() === '') {
    throw new CodingV19Error('Agent step.text không được rỗng.');
  }
  if (step.fileWrite) {
    if (typeof step.fileWrite.path !== 'string' || step.fileWrite.path.trim() === '') {
      throw new CodingV19Error('Agent step fileWrite.path không được rỗng.');
    }
    if (typeof step.fileWrite.content !== 'string') {
      throw new CodingV19Error('Agent step fileWrite.content phải là string.');
    }
    if (step.fileWrite.kind === 'edit' && typeof step.fileWrite.oldText !== 'string') {
      throw new CodingV19Error('Agent step fileWrite edit cần oldText.');
    }
    if (step.fileWrite.kind !== undefined && step.fileWrite.kind !== 'create' && step.fileWrite.kind !== 'edit') {
      throw new CodingV19Error('Agent step fileWrite.kind phải là create | edit.');
    }
  }
  if (step.fileDelete !== undefined && (typeof step.fileDelete !== 'string' || step.fileDelete.trim() === '')) {
    throw new CodingV19Error('Agent step fileDelete phải là string không rỗng.');
  }
  if (step.toolCall) {
    if (typeof step.toolCall.toolName !== 'string' || step.toolCall.toolName.trim() === '') {
      throw new CodingV19Error('Agent step toolCall.toolName không được rỗng.');
    }
    if (step.toolCall.ok !== undefined && typeof step.toolCall.ok !== 'boolean') {
      throw new CodingV19Error('Agent step toolCall.ok phải là boolean.');
    }
  }
}

/**
 * Chạy agent v19 scripted end-to-end. Trả báo cáo + log event đầy đủ
 * (caller tự lưu JSONL/meta/snapshot — agent không ghi file ngoài
 * workspace của conversation).
 */
export function runV19Agent(input: V19RunAgentOptions): {
  report: V19AgentReport;
  meta: V19ConversationMeta;
  events: V19Event[];
} {
  if (!input || typeof input !== 'object') throw new CodingV19Error('Run agent input phải là object.');
  if (typeof input.task !== 'string' || input.task.trim() === '') {
    throw new CodingV19Error('task không được rỗng.');
  }
  if (!Array.isArray(input.steps)) throw new CodingV19Error('steps phải là array.');
  for (const step of input.steps) v19ValidateAgentStep(step);
  const now = typeof input.now === 'number' ? input.now : Date.now();

  // --- Conversation: tạo mới (áp preset) hoặc tiếp tục cái đã có. ---
  let meta: V19ConversationMeta;
  let events: V19Event[];
  if (input.existingMeta && input.existingEvents) {
    meta = input.existingMeta;
    events = [...input.existingEvents];
    if (meta.status !== 'active') {
      throw new CodingV19Error(`Conversation "${meta.id}" đang ở trạng thái "${meta.status}" — chỉ chạy agent trên conversation active.`);
    }
  } else {
    let resolvedPreset;
    if (input.profileId) {
      const preset = v19BuiltinPresetById(input.profileId, now);
      if (!preset) throw new CodingV19Error(`Không có preset/profile "${input.profileId}" (builtin: general | reviewer | refactorer | test-writer | docs).`);
      resolvedPreset = v19ApplyPreset(preset, input.installedPluginNames ?? []);
    }
    meta = v19CreateConversationMeta(
      {
        title: input.title,
        profileId: input.profileId,
        now,
      },
      resolvedPreset,
    );
    events = v19OpenConversationEvents(meta, now);
  }
  if (input.conversationId && input.conversationId !== meta.id) {
    throw new CodingV19Error(`conversationId "${input.conversationId}" không khớp conversation đang chạy "${meta.id}".`);
  }

  // --- Workspace tách bạch + snapshot dir. ---
  const dataDir = typeof input.dataDir === 'string' && input.dataDir.trim() !== '' ? input.dataDir : undefined;
  const workspaceRoot =
    input.workspaceRoot ??
    (dataDir ? path.join(dataDir, 'workspaces', meta.id) : path.join(os.tmpdir(), 'open-bot-coding-v19', meta.id));
  const snapshotDir = dataDir ? path.join(dataDir, 'snapshots') : path.join(os.tmpdir(), 'open-bot-coding-v19-snapshots');
  v19EnsureWorkspace(workspaceRoot);

  const maxSteps = meta.profileId !== '' ? (v19BuiltinPresetById(meta.profileId, now)?.maxSteps ?? 50) : 50;
  const allowlist = meta.toolAllowlist;

  // --- Chạy từng bước (scripted). ---
  events = v19AppendEvent(events, meta.id, {
    kind: 'user_message',
    actor: 'user',
    at: now,
    payload: { text: input.task },
  });
  let stepsRun = 0;
  let stepsSkipped = 0;
  let toolCalls = 0;
  for (const step of input.steps) {
    if (step.done === false) {
      stepsSkipped += 1;
      continue;
    }
    if (stepsRun >= maxSteps) {
      // Vượt maxSteps của preset: bỏ qua bước còn lại (đếm vào skipped).
      stepsSkipped += 1;
      continue;
    }
    // Tool call: chặn tool ngoài allowlist của preset trước khi ghi log.
    if (step.toolCall && !v19IsToolAllowed(allowlist, step.toolCall.toolName)) {
      events = v19AppendEvent(events, meta.id, {
        kind: 'tool_result',
        actor: `tool:${step.toolCall.toolName}`,
        at: now,
        payload: {
          toolName: step.toolCall.toolName,
          result: `Tool "${step.toolCall.toolName}" không nằm trong allowlist của preset "${meta.profileId || '(không có preset)'}".`,
          ok: false,
        },
      });
      stepsRun += 1;
      continue;
    }
    if (step.toolCall) {
      events = v19AppendEvent(events, meta.id, {
        kind: 'tool_call',
        actor: 'agent',
        at: now,
        payload: { toolName: step.toolCall.toolName, toolArgsJson: step.toolCall.argsJson ?? '{}' },
      });
      events = v19AppendEvent(events, meta.id, {
        kind: 'tool_result',
        actor: `tool:${step.toolCall.toolName}`,
        at: now,
        payload: {
          toolName: step.toolCall.toolName,
          result: step.toolCall.result ?? '(không có kết quả)',
          ok: step.toolCall.ok ?? true,
        },
      });
      toolCalls += 1;
    }
    // File write/edit/delete trong workspace (containment chặn traversal).
    if (step.fileWrite) {
      const { path: filePath, content, kind, oldText } = step.fileWrite;
      if (kind === 'edit') {
        v19WorkspaceEdit(workspaceRoot, filePath, oldText ?? '', content);
      } else {
        v19WorkspaceWrite(workspaceRoot, filePath, content);
      }
      events = v19AppendEvent(events, meta.id, {
        kind: 'file_edit',
        actor: 'agent',
        at: now,
        payload: {
          filePath,
          fileAction: kind === 'edit' ? 'edit' : 'create',
          fileContent: content,
        },
      });
    }
    if (step.fileDelete) {
      v19WorkspaceDelete(workspaceRoot, step.fileDelete);
      events = v19AppendEvent(events, meta.id, {
        kind: 'file_edit',
        actor: 'agent',
        at: now,
        payload: { filePath: step.fileDelete, fileAction: 'delete' },
      });
    }
    // Bước thuần text (không file/tool): ghi assistant_message.
    if (!step.toolCall && !step.fileWrite && !step.fileDelete) {
      events = v19AppendEvent(events, meta.id, {
        kind: 'assistant_message',
        actor: 'agent',
        at: now,
        payload: { text: step.text },
      });
    }
    stepsRun += 1;
  }

  // --- Checkpoint cuối phiên (mặc định bật). ---
  let checkpointId: string | undefined;
  const state = v19ReplayEvents(meta.id, events);
  if (input.checkpointAtEnd !== false) {
    const snapshot = v19CreateSnapshot(workspaceRoot, snapshotDir, meta.id, 'agent-run-end', state.lastSeq, now);
    checkpointId = snapshot.id;
    events = v19AppendEvent(events, meta.id, {
      kind: 'checkpoint',
      actor: 'system',
      at: now,
      payload: { checkpointId: snapshot.id, checkpointLabel: 'agent-run-end' },
    });
  }

  const finalState = v19ReplayEvents(meta.id, events);
  const report: V19AgentReport = {
    conversationId: meta.id,
    profileId: meta.profileId,
    task: input.task,
    stepsRun,
    stepsSkipped,
    eventsAppended: events.length,
    lastSeq: finalState.lastSeq,
    filesChanged: finalState.filesChanged,
    toolCalls,
    ...(checkpointId ? { checkpointId } : {}),
    ended: finalState.ended,
    at: now,
  };
  return { report, meta, events };
}

/** Render báo cáo chạy agent v19 (tóm tắt cho tool output). */
export function renderV19AgentReport(report: V19AgentReport): string {
  const lines = [
    `Agent v19 chạy xong task "${report.task}" trên conversation ${report.conversationId} (profile: ${report.profileId || '(không có preset)'}).`,
    `Bước: ${report.stepsRun} chạy, ${report.stepsSkipped} bỏ qua; tool call: ${report.toolCalls}; event: ${report.eventsAppended} (seq ${report.lastSeq}).`,
  ];
  if (report.filesChanged.length > 0) {
    lines.push(`File đã đổi: ${report.filesChanged.map((f) => `${f.filePath} (${f.action})`).join(', ')}.`);
  }
  if (report.checkpointId) lines.push(`Checkpoint cuối phiên: ${report.checkpointId}.`);
  return lines.join('\n');
}
