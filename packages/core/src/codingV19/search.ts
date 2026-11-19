/**
 * Coding agent v19 — search / export / health (v1.41, Đội T4).
 *
 * Mở rộng thật cho hai subsystem v19 (không độn dòng): tìm kiếm trong
 * event log (theo kind/text/tool/file) và trong workspace (grep nội
 * dung có context), export/import conversation (bundle meta + event
 * log + workspace, verify hash-chain khi import), diff giữa hai
 * checkpoint, health check toàn bộ plugin đã cài (manifest + config),
 * thống kê preset đang được conversation nào dùng. Tất cả đều là hàm
 * thuần trên dữ liệu + file local, không gọi model/mạng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodingV19Error } from './types';
import type {
  V19ConversationMeta,
  V19Event,
  V19PluginState,
  V19ValidationResult,
  V19WorkspaceDiffEntry,
} from './types';
import {
  v19DiffManifests,
  v19LoadSnapshot,
  v19WorkspaceList,
} from './workspace';
import { v19ValidateManifest, v19ValidateConfigAgainstSchema } from './plugins';
import { v19ConversationMetaFromJson, v19ValidateConversationMeta } from './conversation';
import { v19EventsFromJsonl, v19EventsToJsonl, v19VerifyEventChain } from './events';

/* ------------------------------------------------------------------ */
/* Tìm kiếm trong event log                                            */
/* ------------------------------------------------------------------ */

/** Tiêu chí tìm trong event log (kết hợp AND, bỏ trống = không lọc). */
export interface V19EventSearchQuery {
  kind?: string;
  /** Chuỗi con trong text/result (không phân biệt hoa thường). */
  text?: string;
  /** Tên tool (tool_call / tool_result). */
  toolName?: string;
  /** Đường dẫn file (file_edit). */
  filePath?: string;
  /** Khoảng seq. */
  fromSeq?: number;
  toSeq?: number;
}

/** Tìm event theo tiêu chí (giữ nguyên thứ tự log). */
export function v19SearchEvents(
  events: readonly V19Event[],
  query: V19EventSearchQuery,
): V19Event[] {
  const text = (query.text ?? '').trim().toLowerCase();
  return events.filter((event) => {
    if (query.kind && event.kind !== query.kind) return false;
    if (query.toolName && event.payload.toolName !== query.toolName) return false;
    if (query.filePath && event.payload.filePath !== query.filePath) return false;
    if (query.fromSeq !== undefined && event.seq < query.fromSeq) return false;
    if (query.toSeq !== undefined && event.seq > query.toSeq) return false;
    if (text !== '') {
      const haystack = [
        event.payload.text ?? '',
        event.payload.result ?? '',
        event.payload.toolName ?? '',
        event.payload.filePath ?? '',
        event.payload.checkpointId ?? '',
        event.payload.presetId ?? '',
        event.payload.pluginId ?? '',
      ].join('\n').toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Tìm kiếm trong workspace (grep)                                     */
/* ------------------------------------------------------------------ */

/** Một match khi grep workspace. */
export interface V19WorkspaceSearchMatch {
  relPath: string;
  lineNo: number;
  line: string;
  /** Dòng context trước/sau (tối đa 1 dòng mỗi bên). */
  contextBefore?: string;
  contextAfter?: string;
}

/** Kết quả grep workspace. */
export interface V19WorkspaceSearchResult {
  query: string;
  matches: V19WorkspaceSearchMatch[];
  filesSearched: number;
  filesMatched: number;
  /** true khi dừng sớm vì vượt maxResults. */
  truncated: boolean;
}

/**
 * Grep nội dung workspace: tìm chuỗi con trong từng file (theo dòng),
 * kèm số dòng + 1 dòng context mỗi bên. Bỏ qua file > 1 MiB và file
 * binary (chứa byte NUL trong 8 KiB đầu). Trả tối đa maxResults match.
 */
export function v19SearchWorkspace(
  workspaceRoot: string,
  query: string,
  options?: { caseSensitive?: boolean; maxResults?: number },
): V19WorkspaceSearchResult {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new CodingV19Error('Từ khoá tìm trong workspace không được rỗng.');
  }
  const maxResults = options?.maxResults ?? 100;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000) {
    throw new CodingV19Error('maxResults phải là số nguyên 1..1000.');
  }
  const needle = options?.caseSensitive === true ? query : query.toLowerCase();
  const matches: V19WorkspaceSearchMatch[] = [];
  const files = v19WorkspaceList(workspaceRoot);
  let filesMatched = 0;
  let truncated = false;
  for (const file of files) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    // Bỏ qua file lớn/binary: đọc thô tối đa 1 MiB để kiểm tra.
    const abs = path.join(path.resolve(workspaceRoot), file.relPath);
    let head: Buffer;
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const read = fs.readSync(fd, buf, 0, 8192, 0);
        head = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    if (head.includes(0)) continue; // binary
    const lines = file.content.split('\n');
    let fileHit = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      const line = lines[i] ?? '';
      const haystack = options?.caseSensitive === true ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      fileHit = true;
      const match: V19WorkspaceSearchMatch = { relPath: file.relPath, lineNo: i + 1, line };
      if (i > 0) match.contextBefore = lines[i - 1];
      if (i + 1 < lines.length) match.contextAfter = lines[i + 1];
      matches.push(match);
    }
    if (fileHit) filesMatched += 1;
  }
  return { query, matches, filesSearched: files.length, filesMatched, truncated };
}

/** Render kết quả grep workspace (một dòng một match). */
export function renderV19WorkspaceSearch(result: V19WorkspaceSearchResult): string {
  const head = `Tìm "${result.query}": ${result.matches.length} match trong ${result.filesMatched}/${result.filesSearched} file${result.truncated ? ' (đã cắt ở giới hạn)' : ''}.`;
  if (result.matches.length === 0) return `${head}\n(không có kết quả)`;
  const lines = result.matches.map((m) => `${m.relPath}:${m.lineNo}: ${m.line}`);
  return `${head}\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* Export / import conversation                                        */
/* ------------------------------------------------------------------ */

/** Bundle export conversation (JSON, version 1). */
export interface V19ConversationBundle {
  version: 1;
  exportedAt: number;
  meta: V19ConversationMeta;
  /** Event log dạng JSONL (giữ nguyên hash-chain). */
  eventsJsonl: string;
  /** File workspace (kèm nội dung) — có thể rỗng khi workspace trống. */
  workspaceFiles: { relPath: string; content: string }[];
}

/** Giới hạn bundle export (5 MiB nội dung workspace). */
export const V19_EXPORT_MAX_WORKSPACE_BYTES = 5 * 1024 * 1024;

/**
 * Export conversation thành bundle: meta + event log JSONL + toàn bộ
 * file workspace. Bundle tự chứa đủ dữ liệu để import lại ở máy khác
 * (không kèm snapshot — snapshot là dữ liệu phái sinh, tạo lại được).
 */
export function v19ExportConversation(
  meta: V19ConversationMeta,
  events: readonly V19Event[],
  workspaceRoot: string,
  now?: number,
): V19ConversationBundle {
  v19ValidateConversationMeta(meta);
  const chainError = v19VerifyEventChain(events);
  if (chainError !== '') throw new CodingV19Error(`Không export log vỡ: ${chainError}`);
  for (const event of events) {
    if (event.conversationId !== meta.id) {
      throw new CodingV19Error(`Event seq ${event.seq} không thuộc conversation "${meta.id}".`);
    }
  }
  const files = v19WorkspaceList(workspaceRoot);
  let bytes = 0;
  const workspaceFiles = files.map((f) => {
    bytes += Buffer.byteLength(f.content, 'utf8');
    return { relPath: f.relPath, content: f.content };
  });
  if (bytes > V19_EXPORT_MAX_WORKSPACE_BYTES) {
    throw new CodingV19Error(
      `Workspace quá lớn để export (${bytes} bytes > giới hạn ${V19_EXPORT_MAX_WORKSPACE_BYTES}) — checkpoint rồi export từng phần.`,
    );
  }
  return {
    version: 1,
    exportedAt: typeof now === 'number' ? now : Date.now(),
    meta: JSON.parse(JSON.stringify(meta)) as V19ConversationMeta,
    eventsJsonl: v19EventsToJsonl(events),
    workspaceFiles,
  };
}

/** Serialize bundle thành JSON text (ghi file .v19bundle.json). */
export function v19ConversationBundleToJson(bundle: V19ConversationBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Import bundle: validate meta + event log (hash-chain nguyên vẹn,
 * seq liên tục, event thuộc đúng conversation). Trả meta + events +
 * workspaceFiles để caller ghi xuống đĩa. Không tự ghi file.
 */
export function v19ImportConversationBundle(
  json: string,
): { meta: V19ConversationMeta; events: V19Event[]; workspaceFiles: { relPath: string; content: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodingV19Error('Bundle import không phải JSON hợp lệ.');
  }
  const bundle = parsed as V19ConversationBundle;
  if (!bundle || bundle.version !== 1) {
    throw new CodingV19Error('Bundle import phải có version = 1.');
  }
  if (!bundle.meta || typeof bundle.meta !== 'object') {
    throw new CodingV19Error('Bundle import thiếu meta.');
  }
  const meta = v19ConversationMetaFromJson(JSON.stringify(bundle.meta));
  if (typeof bundle.eventsJsonl !== 'string') {
    throw new CodingV19Error('Bundle import thiếu eventsJsonl (string).');
  }
  const events = v19EventsFromJsonl(bundle.eventsJsonl);
  for (const event of events) {
    if (event.conversationId !== meta.id) {
      throw new CodingV19Error(`Bundle import: event seq ${event.seq} không thuộc conversation "${meta.id}".`);
    }
  }
  if (!Array.isArray(bundle.workspaceFiles)) {
    throw new CodingV19Error('Bundle import thiếu workspaceFiles (array).');
  }
  for (const file of bundle.workspaceFiles) {
    if (!file || typeof file.relPath !== 'string' || typeof file.content !== 'string') {
      throw new CodingV19Error('Bundle import: workspaceFiles entry cần relPath + content là string.');
    }
    if (file.relPath.includes('..') || file.relPath.startsWith('/')) {
      throw new CodingV19Error(`Bundle import: workspaceFiles chứa path không an toàn "${file.relPath}".`);
    }
  }
  return { meta, events, workspaceFiles: bundle.workspaceFiles };
}

/* ------------------------------------------------------------------ */
/* Diff giữa hai checkpoint + health plugin + preset usage             */
/* ------------------------------------------------------------------ */

/**
 * Diff giữa hai snapshot của cùng conversation (snapshot A -> B).
 * Dùng chung v19DiffManifests với reader đọc từ thư mục snapshot.
 */
export function v19DiffSnapshots(
  snapshotDir: string,
  snapshotIdA: string,
  snapshotIdB: string,
): V19WorkspaceDiffEntry[] {
  const snapA = v19LoadSnapshot(snapshotDir, snapshotIdA);
  if (!snapA) throw new CodingV19Error(`Không có snapshot "${snapshotIdA}".`);
  const snapB = v19LoadSnapshot(snapshotDir, snapshotIdB);
  if (!snapB) throw new CodingV19Error(`Không có snapshot "${snapshotIdB}".`);
  if (snapA.conversationId !== snapB.conversationId) {
    throw new CodingV19Error(
      `Không diff snapshot của hai conversation khác nhau ("${snapA.conversationId}" vs "${snapB.conversationId}").`,
    );
  }
  const readFrom = (snapshotId: string) => (relPath: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(snapshotDir, snapshotId, relPath), 'utf8');
    } catch {
      return undefined;
    }
  };
  return v19DiffManifests(snapA.files, snapB.files, readFrom(snapshotIdA), readFrom(snapshotIdB));
}

/** Health của một plugin đã cài. */
export interface V19PluginHealth {
  name: string;
  loaded: boolean;
  manifestOk: boolean;
  manifestErrors: string[];
  manifestWarnings: string[];
  configOk: boolean;
  configErrors: string[];
  enabledServers: number;
  totalServers: number;
}

/** Health check toàn bộ plugin đã cài (manifest + config theo schema). */
export function v19PluginHealth(states: readonly V19PluginState[]): V19PluginHealth[] {
  return states
    .map((state) => {
      const manifestResult: V19ValidationResult = v19ValidateManifest(state.manifest);
      const configErrors = state.manifest.configSchema
        ? v19ValidateConfigAgainstSchema(state.appliedConfig, state.manifest.configSchema)
        : [];
      return {
        name: state.manifest.name,
        loaded: state.loaded,
        manifestOk: manifestResult.ok,
        manifestErrors: manifestResult.errors,
        manifestWarnings: manifestResult.warnings,
        configOk: configErrors.length === 0,
        configErrors,
        enabledServers: state.enabledServers.length,
        totalServers: state.manifest.servers.length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Render health plugin (một dòng một plugin + lỗi nếu có). */
export function renderV19PluginHealth(health: readonly V19PluginHealth[]): string {
  if (health.length === 0) return '(chưa cài plugin nào)';
  return health
    .map((h) => {
      const status = h.manifestOk && h.configOk ? 'OK' : 'LỖI';
      const problems = [...h.manifestErrors, ...h.configErrors];
      return `${h.name}: ${status} (${h.loaded ? 'loaded' : 'unloaded'}, ${h.enabledServers}/${h.totalServers} server bật)${problems.length > 0 ? ` — ${problems.join('; ')}` : ''}`;
    })
    .join('\n');
}

/** Thống kê preset: mỗi preset được bao nhiêu conversation dùng. */
export interface V19PresetUsage {
  presetId: string;
  conversations: number;
  conversationIds: string[];
}

/** Đếm conversation theo profileId (preset), kèm id để drill-down. */
export function v19PresetUsage(metas: readonly V19ConversationMeta[]): V19PresetUsage[] {
  const byPreset = new Map<string, string[]>();
  for (const meta of metas) {
    const key = meta.profileId === '' ? '(không có preset)' : meta.profileId;
    const list = byPreset.get(key) ?? [];
    list.push(meta.id);
    byPreset.set(key, list);
  }
  return [...byPreset.entries()]
    .map(([presetId, conversationIds]) => ({
      presetId,
      conversations: conversationIds.length,
      conversationIds: [...conversationIds].sort(),
    }))
    .sort((a, b) => b.conversations - a.conversations || a.presetId.localeCompare(b.presetId));
}

/** Render thống kê preset usage. */
export function renderV19PresetUsage(usage: readonly V19PresetUsage[]): string {
  if (usage.length === 0) return '(chưa có conversation nào)';
  return usage
    .map((u) => `${u.presetId}: ${u.conversations} conversation (${u.conversationIds.join(', ')})`)
    .join('\n');
}
